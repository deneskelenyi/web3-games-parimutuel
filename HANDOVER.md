# Parimutuel Blockchain Gambling Platform — Handover Document

## For: Coding Agent
## From: Design/Architecture Session
## Date: June 2026

---

## 0. TL;DR

Build a parimutuel gambling platform on Ethereum L2 (Base). Smart contract holds all logic and funds. FastAPI serves a single-page frontend and proxies blockchain events via WebSocket. 10 games share the same architecture. Test on Base Sepolia testnet with an automated bot that places bets and verifies the full lifecycle.

The house NEVER risks money. All bets go into a shared pool. House takes a percentage. Winners split the rest proportionally. No-winner rounds carry over to a jackpot. The contract is deployed once and reused forever.

---

## 1. Core Architecture

```
┌─────────────────────────────────────────────────────┐
│                    USER BROWSER                       │
│  index.html (vanilla JS + ethers.js + MetaMask)      │
│  Connects to:                                         │
│    1. FastAPI WebSocket (pool updates, events)        │
│    2. Alchemy RPC (direct contract reads/writes)      │
└──────────────┬──────────────────────┬─────────────────┘
               │                      │
               ▼                      ▼
┌──────────────────────┐   ┌──────────────────────────┐
│   FastAPI Backend     │   │  Base L2 (Blockchain)    │
│                       │   │                          │
│  • Serves index.html  │   │  RouletteParimutuel.sol  │
│  • WS: /ws/pool        │   │  DiceParimutuel.sol      │
│  • Watches contract   │   │  CrashParimutuel.sol      │
│    events via RPC      │   │  ... (10 games)           │
│  • Pushes to clients   │   │                          │
│                       │   │  Holds all funds          │
│  No business logic     │   │  Holds all state         │
│  No database           │   │  All game logic          │
│  Pure relay layer      │   │                          │
└──────────────────────┘   └──────────────────────────┘
```

### Why FastAPI at all (if the contract does everything)?

The contract is the source of truth, but:
1. **WebSocket relay**: the frontend needs real-time pool updates. FastAPI watches contract events and pushes them to all connected browsers via a single WebSocket. Avoids every client needing their own Alchemy WebSocket (rate limits on free tier).
2. **Serves the frontend**: one HTML file, same port, simple deployment.
3. **Optional conveniences**: bet history aggregation, leaderboard, past round data (can read from contract but FastAPI can cache/index).
4. **Local dev**: during development, serving from FastAPI is easier than IPFS.

The FastAPI layer is THIN. It has zero business logic. It can be removed entirely for production (frontend goes to IPFS/Arweave, clients connect directly to Alchemy WebSocket). But for dev/testnet, it's the right choice.

### Production path (serverless)

```
index.html  →  Arweave (permanent, $0.10 one-time)
Contract     →  Base mainnet (one-time deploy gas)
RNG          →  Chainlink VRF (~$0.01-0.05/round in LINK)
Settlement   →  Chainlink Automation OR settlement bounty bots
RPC/WS       →  Alchemy free tier ($0/month)
Domain       →  ENS (.eth, ~$5/year)
Hosting      →  $0/month
```

---

## 2. Smart Contract Specification

### 2.1 Shared Architecture (all 10 games use this base)

**Language**: Solidity ^0.8.24
**Framework**: Foundry (forge for compile/test/deploy)
**Chain**: Base Sepolia (testnet), Base mainnet (production)
**Currency**: ETH (native, not USDT — avoids approve transaction and USDT's non-standard transfer)

### 2.2 Core Contract: ParimutuelGame.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

abstract contract ParimutuelGame {
    // ─── Config ───
    uint256 public blocksPerRound;      // e.g., 5 (~10s on Base)
    uint256 public houseEdgeBps;        // e.g., 500 = 5%
    uint256 public settlementBountyBps; // e.g., 10 = 0.1%
    uint256 public minPoolWei;           // minimum pool to settle (carry-over if not met)
    uint256 public minBettors;           // minimum distinct bettors to settle
    uint256 public carryOverLimit;       // max carry-overs before force void
    uint256 public claimExpiryBlocks;    // ~30 days in blocks

    address public house;                // owner, collects house cut
    bool public paused;                  // emergency stop

    // ─── Round State ───
    struct Round {
        uint256 resolutionBlock;
        uint256 totalPool;
        uint256 totalWinningBets;
        uint256 winningOutcome;       // game-specific (number, color, tier, etc.)
        uint256 carryOverCount;
        bool     settled;
        bool     voided;
        bool     hasWinners;
    }

    mapping(uint256 => Round) public rounds;

    // roundId => player => Bet[]
    struct Bet {
        uint8  betType;     // game-specific
        uint8  betValue;    // game-specific
        uint128 amount;     // in wei
        bool   claimed;
    }
    mapping(uint256 => mapping(address => Bet[])) public roundBets;

    // roundId => distinct bettor count
    mapping(uint256 => uint256) public roundBettorCount;

    // Jackpot (carried over from no-winner rounds)
    uint256 public jackpot;

    // ─── Events ───
    event BetPlaced(uint256 indexed roundId, address indexed player, uint8 betType, uint8 betValue, uint128 amount);
    event RoundSettled(uint256 indexed roundId, uint256 winningOutcome, uint256 totalPool, uint256 prizePool);
    event RoundVoided(uint256 indexed roundId);
    event RoundCarriedOver(uint256 indexed roundId, uint256 newResolutionBlock);
    event WinningsClaimed(uint256 indexed roundId, address indexed player, uint256 amount);
    event HouseCutCollected(uint256 indexed roundId, uint256 amount);
    event JackpotUpdated(uint256 newJackpot);

    // ─── Modifiers ───
    modifier onlyHouse() { require(msg.sender == house, "not house"); _; }
    modifier notPaused() { require(!paused, "paused"); _; }

    // ─── Round Derivation (no one starts rounds — they exist by block number) ───
    function currentRoundId() public view returns (uint256) {
        return block.number / blocksPerRound;
    }

    function resolutionBlockForRound(uint256 roundId) public view returns (uint256) {
        return (roundId + 1) * blocksPerRound;
    }

    // ─── Betting ───
    function placeBet(uint8 betType, uint8 betValue) external payable notPaused {
        uint256 roundId = currentRoundId();
        require(msg.value > 0, "no bet");
        require(msg.value >= minBetWei, "below min bet");

        // Check if this is a new bettor for this round
        if (roundBets[roundId][msg.sender].length == 0) {
            roundBettorCount[roundId]++;
        }

        roundBets[roundId][msg.sender].push(Bet({
            betType: betType,
            betValue: betValue,
            amount: uint128(msg.value),
            claimed: false
        }));

        rounds[roundId].totalPool += msg.value;

        emit BetPlaced(roundId, msg.sender, betType, betValue, uint128(msg.value));
    }

    // ─── Settlement ───
    function settleRound(uint256 roundId) external notPaused {
        Round storage r = rounds[roundId];
        require(!r.settled && !r.voided, "already settled");
        require(block.number >= r.resolutionBlock, "too early");

        // Check minimums — carry over if not met
        if (r.totalPool < minPoolWei || roundBettorCount[roundId] < minBettors) {
            r.carryOverCount++;
            if (r.carryOverCount >= carryOverLimit) {
                // Force void — players can refund via pull-payment
                r.voided = true;
                emit RoundVoided(roundId);
            } else {
                // Push resolution to next block window
                r.resolutionBlock += blocksPerRound;
                emit RoundCarriedOver(roundId, r.resolutionBlock);
            }
            return;
        }

        // Determine winning outcome (implemented by each game)
        uint256 winningOutcome = _determineOutcome(roundId);

        // Calculate winning bets (implemented by each game)
        (uint256 totalWinningBets, bool hasWinners) = _calculateWinners(roundId, winningOutcome);

        // Settlement bounty to whoever called settleRound
        uint256 bounty = r.totalPool * settlementBountyBps / 10000;

        // House cut
        uint256 houseCut = r.totalPool * houseEdgeBps / 10000;

        // Prize pool = totalPool - bounty - houseCut + jackpot
        uint256 prizePool = r.totalPool - bounty - houseCut + jackpot;

        // Break-even floor: if winners can't get at least their bet back,
        // house gives back part of its cut
        if (hasWinners && prizePool < totalWinningBets) {
            uint256 shortfall = totalWinningBets - prizePool;
            if (shortfall <= houseCut) {
                houseCut -= shortfall;
                prizePool += shortfall;
            }
            // shortfall can never exceed houseCut (proven in math:
            // totalWinningBets <= totalPool, so shortfall <= totalPool*0.05 = houseCut)
        }

        r.winningOutcome = winningOutcome;
        r.totalWinningBets = totalWinningBets;
        r.settled = true;
        r.hasWinners = hasWinners;

        if (!hasWinners) {
            // No winners — prize pool rolls into jackpot
            jackpot += prizePool;
            prizePool = 0;
            emit JackpotUpdated(jackpot);
        }

        // Pay settlement bounty
        if (bounty > 0) {
            (bool s, ) = payable(msg.sender).call{value: bounty}("");
            require(s, "bounty transfer failed");
        }

        // Store house cut for later collection
        // (house calls collectHouseCut to withdraw)

        emit RoundSettled(roundId, winningOutcome, r.totalPool, prizePool);
    }

    // ─── Claims (pull-payment) ───
    function claimWinnings(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.settled && r.hasWinners, "not settled or no winners");

        uint256 totalPayout = 0;
        Bet[] storage bets = roundBets[roundId][msg.sender];

        for (uint256 i = 0; i < bets.length; i++) {
            if (!bets[i].claimed && _isWinningBet(bets[i], r.winningOutcome)) {
                bets[i].claimed = true;
                uint256 payout = (uint256(bets[i].amount) * (r.totalPool - settlementBountyBps * r.totalPool / 10000 - /* remaining houseCut */ 0 + jackpot)) / r.totalWinningBets;
                // NOTE: the exact payout calc needs to account for bounty already paid
                // and house cut stored separately. Simplified here — see implementation notes.
                totalPayout += payout;
            }
        }

        require(totalPayout > 0, "nothing to claim");
        (bool s, ) = payable(msg.sender).call{value: totalPayout}("");
        require(s, "transfer failed");

        emit WinningsClaimed(roundId, msg.sender, totalPayout);
    }

    // ─── Refunds (for voided rounds) ───
    function claimRefund(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.voided, "not voided");

        uint256 refund = 0;
        Bet[] storage bets = roundBets[roundId][msg.sender];
        for (uint256 i = 0; i < bets.length; i++) {
            if (!bets[i].claimed) {
                bets[i].claimed = true;
                refund += bets[i].amount;
            }
        }

        require(refund > 0, "nothing to refund");
        (bool s, ) = payable(msg.sender).call{value: refund}("");
        require(s, "transfer failed");
    }

    // ─── Withdraw pending bet (before settlement) ───
    function withdrawPendingBet(uint256 roundId) external {
        require(!rounds[roundId].settled && !rounds[roundId].voided, "round closed");

        uint256 refund = 0;
        Bet[] storage bets = roundBets[roundId][msg.sender];
        for (uint256 i = 0; i < bets.length; i++) {
            if (!bets[i].claimed) {
                bets[i].claimed = true;
                refund += bets[i].amount;
            }
        }

        if (refund > 0) {
            rounds[roundId].totalPool -= refund;
            if (roundBets[roundId][msg.sender].length > 0 && /* was their first bet now removed */) {
                // decrement bettor count if they have no remaining bets
                // (simplified — see implementation notes)
            }
            (bool s, ) = payable(msg.sender).call{value: refund}("");
            require(s, "transfer failed");
        }
    }

    // ─── House functions ───
    function collectHouseCut(uint256 roundId) external onlyHouse {
        // Transfer accumulated house cut for this round
        // (stored separately — see implementation notes)
    }

    function setHouseEdge(uint256 bps) external onlyHouse { houseEdgeBps = bps; }
    function setMinPool(uint256 wei_) external onlyHouse { minPoolWei = wei_; }
    function setMinBettors(uint256 n) external onlyHouse { minBettors = n; }
    function pause() external onlyHouse { paused = true; }
    function unpause() external onlyHouse { paused = false; }

    // ─── Abstract functions (each game implements these) ───
    function _determineOutcome(uint256 roundId) internal view virtual returns (uint256);
    function _calculateWinners(uint256 roundId, uint256 winningOutcome) internal view virtual returns (uint256, bool);
    function _isWinningBet(Bet memory bet, uint256 winningOutcome) internal view virtual returns (bool);

    // ─── RNG ───
    // For testnet: use blockhash (free, simple)
    // For production: use Chainlink VRF (see section 2.4)
    function _getRNG() internal view returns (uint256) {
        return uint256(blockhash(block.number - 1));
    }
}
```

### 2.3 Implementation Notes for Agent

The pseudocode above is a TEMPLATE. The agent must:

1. **Fix payout calculation**: the claimWinnings function needs to correctly compute:
   ```
   prizePool = totalPool - bounty - houseCut + jackpot(from previous rounds)
   payout = (bet.amount / totalWinningBets) * prizePool
   ```
   House cut should be stored per-round (mapping roundId => uint256) and only withdrawn when house calls collectHouseCut.

2. **Handle bettor count on withdrawal**: when a player withdraws all their bets, decrement roundBettorCount. Track whether player has unclaimed bets remaining.

3. **House cut accumulation**: store `mapping(uint256 => uint256) public roundHouseCut;` — set during settleRound, withdrawn via collectHouseCut.

4. **Jackpot reset**: when jackpot is added to prizePool during settlement, reset jackpot to 0 for that round. Jackpot only carries over when there are NO winners.

5. **Batch claim**: add `claimAllWinnings(uint256[] roundIds)` for claiming multiple rounds in one transaction (gas optimization).

6. **Reentrancy guards**: use OpenZeppelin ReentrancyGuard on all functions that send ETH.

7. **Pausable**: use OpenZeppelin Pausable instead of manual paused flag.

8. **Event indexing**: all events should index roundId and player address for efficient frontend filtering.

### 2.4 RNG Options

#### Testnet (what to build first)

```solidity
function _getRNG() internal view returns (uint256) {
    // Use blockhash of the resolution block
    // This is the block that defines the round
    uint256 resBlock = rounds[roundId].resolutionBlock;
    return uint256(blockhash(resBlock));
}
```

Free, instant, sufficient for testnet. MEV risk is irrelevant on testnet.

#### Production (Chainlink VRF)

```solidity
// Import: @chainlink/contracts/src/v0.8/vrf/VRFConsumerBaseV2.sol

contract RouletteParimutuel is VRFConsumerBaseV2, ParimutuelGame {
    VRFCoordinatorV2Interface COORDINATOR;
    uint64 subscriptionId;
    bytes32 keyHash = 0x...; // depends on chain
    uint32 callbackGasLimit = 100000;
    uint16 requestConfirmations = 3;

    // When round is ready to settle, request randomness
    function requestSettlement(uint256 roundId) external {
        COORDINATOR.requestRandomWords(keyHash, subscriptionId, requestConfirmations, callbackGasLimit, 1);
        // Store roundId for callback
    }

    // Chainlink calls this with the random result
    function fulfillRandomWords(uint256 requestId, uint256[] memory randomWords) internal override {
        uint256 roundId = pendingRequests[requestId];
        // Set the outcome and settle
        _settleWithRNG(roundId, randomWords[0]);
    }
}
```

Cost: ~0.25 LINK per request. On Base, this is ~$0.01-0.05.

#### Production alternative (Bitcoin block hash via Chainlink Functions)

Keeps the "settled by Bitcoin" narrative. Chainlink Functions fetches the BTC block hash from mempool.space using decentralized oracle network. More complex setup. See Chainlink Functions documentation.

---

## 3. The 10 Games

Each game is a separate contract inheriting from ParimutuelGame. They differ only in:
- `_determineOutcome()` — how the RNG maps to a result
- `_calculateWinners()` — which bets win
- `_isWinningBet()` — per-bet check
- Bet types and values exposed to the frontend

### 3.1 Dice Over/Under

```
RNG:        uint256(blockhash(resBlock)) % 100  →  0-99
Outcome:    single number 0-99
Winning:    OVER (50-99) or UNDER (0-49). 50 = dead zone (nobody wins → jackpot)

Bet types:
  0 = OVER   (betValue unused)
  1 = UNDER  (betValue unused)

_isWinningBet:
  bet.betType == 0 && outcome >= 50  →  win
  bet.betType == 1 && outcome < 50   →  win
  outcome == 50                      →  nobody wins (jackpot)

Speed: 1 block (~12s)
Outcomes: effectively 2 (over/under)
Visual: a glowing 2-digit counter, scale tipping left/right
```

### 3.2 Color Duel

```
RNG:        uint256(blockhash(resBlock)) % 3  →  0, 1, 2
Outcome:    0=red, 1=green, 2=blue

Bet types:
  0 = RED
  1 = GREEN
  2 = BLUE

_isWinningBet:
  bet.betValue == outcome

Speed: 1 block (~12s)
Outcomes: 3
Visual: three colored zones, winner pulses
```

### 3.3 Parimutuel Slots

```
RNG:        extract 3 values from blockhash
  symbol1 = uint256(blockhash(resBlock)) % 8       →  0-7
  symbol2 = (uint256(blockhash(resBlock)) >> 3) % 8
  symbol3 = (uint256(blockhash(resBlock)) >> 6) % 8
  Symbols: 0=cherry, 1=lemon, 2=bell, 3=bar, 4=seven, 5=diamond, 6=star, 7=crown

Outcome:    packed as (symbol1 << 8) | (symbol2 << 4) | symbol3

Bet types (separate parimutuel pools per type):
  0 = EXACT_TRIPLE  betValue = symbol (0-7), wins if all 3 == betValue
  1 = ANY_TRIPLE    betValue unused, wins if symbol1==symbol2==symbol3
  2 = ANY_PAIR      betValue unused, wins if any 2 of 3 match
  3 = FIRST_SYMBOL  betValue = symbol (0-7), wins if symbol1 == betValue

Pools: each bet type has its own sub-pool tracked separately
  mapping(uint256 => mapping(uint8 => uint256)) public poolByBetType;
  mapping(uint256 => mapping(uint8 => uint256)) public winningBetsByBetType;

_isWinningBet:
  type 0: symbol1 == symbol2 == symbol3 == bet.betValue
  type 1: symbol1 == symbol2 == symbol3 (any symbol)
  type 2: at least 2 of {symbol1, symbol2, symbol3} are equal
  type 3: symbol1 == bet.betValue

No-winner per type: that type's pool rolls into jackpot

Speed: 1 block (~12s)
Outcomes: 8^3 = 512 possible combos
Visual: 3 spinning reels, classic slot machine aesthetic, dark/modern
```

### 3.4 Crash / Rocket

```
RNG:        uint256(blockhash(resBlock)) % 10000  →  0-9999
            crash_point = max(100, result) / 100.0  →  1.00x to 100.00x
            (result of 0 → 1.00x = instant crash)
            Outcome stored as: crash_point * 100 (integer, e.g., 237 = 2.37x)

Bet types (tiers):
  0 = TIER_1_5X   survives if crash_point >= 1.5x (outcome >= 150)
  1 = TIER_2X     survives if crash_point >= 2.0x (outcome >= 200)
  2 = TIER_3X     survives if crash_point >= 3.0x (outcome >= 300)
  3 = TIER_5X     survives if crash_point >= 5.0x (outcome >= 500)
  4 = TIER_10X    survives if crash_point >= 10.0x (outcome >= 1000)

_isWinningBet:
  crash_point >= tier_threshold(bet.betType)

All surviving tiers share ONE pool. Lower tiers almost always survive
(but split with many). Higher tiers rarely survive but get bigger share.

Speed: 1 block (~12s). Rocket animation plays for 12s, crashes at revealed point.
Visual: rocket/line chart climbing upward, then crashing/exploding
```

### 3.5 Virtual Horse Race

```
RNG:        extract 6 values from blockhash
  h0 = uint256(blockhash(resBlock)) % 1000
  h1 = (uint256(blockhash(resBlock)) >> 10) % 1000
  h2 = (uint256(blockhash(resBlock)) >> 20) % 1000
  h3 = (uint256(blockhash(resBlock)) >> 30) % 1000
  h4 = (uint256(blockhash(resBlock)) >> 40) % 1000
  h5 = (uint256(blockhash(resBlock)) >> 50) % 1000
  Sort descending → finishing order (horse index 0-5)

Outcome:    packed finishing order as uint256 (6 nibbles, each 0-5)

Bet types (separate pools):
  0 = WIN      betValue = horse (0-5), wins if horse finishes 1st
  1 = PLACE    betValue = horse (0-5), wins if horse finishes 1st or 2nd
  2 = SHOW     betValue = horse (0-5), wins if horse finishes 1st, 2nd, or 3rd
  3 = EXACTA   betValue = (first << 4 | second), wins if top 2 in exact order

_isWinningBet:
  type 0: finishing_order[0] == bet.betValue
  type 1: finishing_order[0] == bet.betValue || finishing_order[1] == bet.betValue
  type 2: finishing_order[0..2].contains(bet.betValue)
  type 3: finishing_order[0] == (bet.betValue >> 4) && finishing_order[1] == (bet.betValue & 0xF)

Speed: 1 block (~12s) or 3 blocks (~36s) for multi-leg drama
Visual: 6 horses running across screen, positions from hash-derived scores
```

### 3.6 Keno

```
RNG:        extract 10 values from blockhash
  draw[i] = (uint256(blockhash(resBlock)) >> (i * 12)) % 40 + 1  for i in 0..9
  Deduplicate: if collision, increment until unique (or accept duplicates)

Outcome:    packed 10 numbers (each 6 bits, 0-39 + 1 = 1-40)

Player action:
  Pick 5 numbers from 1-40 (betValue encodes up to 5 picks as packed uint)
  betValue = n1 | (n2 << 8) | (n3 << 16) | (n4 << 24) | (n5 << 32)

Bet types (match tiers, separate pools):
  0 = MATCH_5    wins if all 5 picks are in the 10 drawn numbers
  1 = MATCH_4    wins if exactly 4 of 5 picks are drawn
  2 = MATCH_3    wins if exactly 3 of 5 picks are drawn
  3 = MATCH_0    wins if none of 5 picks are drawn (anti-keno!)

_isWinningBet:
  count = number of player picks that appear in drawn numbers
  type 0: count == 5
  type 1: count == 4
  type 2: count == 3
  type 3: count == 0

Speed: 1 block (~12s)
Visual: 40-number grid, player taps 5, drawn numbers light up one by one
```

### 3.7 Plinko Zones

```
RNG:        12 binary decisions from blockhash
  path[i] = (uint256(blockhash(resBlock)) >> i) & 1  for i in 0..11
  landing_zone = sum(path)  →  0 to 12 (13 possible zones)

Outcome:    0-12

Bet types:
  0 = ZONE  betValue = zone (0-12), wins if landing_zone == betValue

_isWinningBet:
  bet.betValue == outcome

Distribution is bell-curve (zone 6 most likely, zones 0/12 least likely)
Edge zones = huge payouts (few bettors), center = small payouts (many bettors)

Speed: 1 block (~12s). Ball drop animation ~5s.
Visual: Plinko board, ball bouncing through pegs, lands in zone
```

### 3.8 Coin Flip Streak

```
RNG:        20 bits from blockhash
  flips[i] = (uint256(blockhash(resBlock)) >> i) & 1  for i in 0..19
  streak = count of leading 1s before first 0
  (if all 20 are 1: streak = 20, astronomically rare)

Outcome:    0-20 (streak length)

Bet types (7 buckets):
  0 = STREAK_0   betValue unused, wins if streak == 0 (immediate tails)
  1 = STREAK_1   wins if streak == 1
  2 = STREAK_2   wins if streak == 2
  3 = STREAK_3   wins if streak == 3
  4 = STREAK_4   wins if streak == 4
  5 = STREAK_5   wins if streak == 5
  6 = STREAK_6PLUS  wins if streak >= 6

_isWinningBet:
  bet.betType matches the actual streak bucket

Distribution: 50% = streak 0, 25% = streak 1, 12.5% = streak 2, ...

Speed: 1 block (~12s)
Visual: coins flipping in sequence, heads appears → flips again, tails → stop
```

### 3.9 Block Bingo

```
RNG:        MULTI-BLOCK (5 blocks, ~60s)
  Each block draws 5 numbers from 1-75
  draw[i] = (uint256(blockhash(resBlock + j)) >> (k * 13)) % 75 + 1
  for j in 0..4 (blocks), k in 0..4 (numbers per block)
  Total: 25 numbers drawn over 5 blocks

Outcome:    25 drawn numbers (packed)

Player action:
  Buy a bingo card (5x5 grid, center free)
  Card generated deterministically: hash(player_address, roundId) → 24 numbers from 1-75
  No duplicates per card. Center is "FREE".

Bet types:
  0 = BINGO  betValue unused, wins if card completes row/col/diagonal

_isWinningBet:
  Check player's card against all 25 drawn numbers
  Verify at least one complete line (row, column, or diagonal)

Multiple winners split the pool. If nobody completes in 5 blocks:
  extend to 10 blocks. If still nobody: jackpot carryover.

Speed: 5-10 blocks (~60-120s)
Visual: bingo card, numbers called light up as blocks are mined, dauber animation
```

### 3.10 Minefield

```
RNG:        5 mine positions on a 5x5 grid
  mine[i] = (uint256(blockhash(resBlock)) >> (i * 13)) % 25  for i in 0..4
  Deduplicate. 20 safe cells, 5 mines.

Outcome:    packed 5 mine positions (each 5 bits, 0-24)

Player action:
  Bet on individual cells. Multiple bets per round.
  betValue = cell number (0-24)
  Each placeBet call is one cell bet. Player can call multiple times.

Bet types:
  0 = SAFE   betValue = cell, wins if cell is NOT a mine
  1 = MINE   betValue = cell, wins if cell IS a mine

_isWinningBet:
  type 0: cell is not in mine positions → winner
  type 1: cell is in mine positions → winner

Parimutuel:
  All bets in one pool. All winners split proportionally.
  SAFE bettors are the majority, smaller individual payouts.
  MINE bettors are rare, bigger individual payouts when they hit.

Speed: 1 block (~12s)
Visual: 5x5 grid, click cells to place chips, mines explode (red), safe turns green
```

### Game Comparison Table

```
Game             Round   Outcomes  Bet Types  Pools      Complexity
───────────────  ──────  ────────  ─────────  ─────────  ──────────
Dice O/U         12s     2         1          1 global   Low
Color Duel       12s     3         1          1 global   Low
Slots            12s     512       4          4 tiered   Medium
Crash/Rocket     12s     5 tiers   1          1 global   Medium
Horse Race       12-36s  6 horses  4          4 tiered   Medium-High
Keno             12s     C(40,10)  4          4 tiered   Medium
Plinko           12s     13        1          1 global   Low
Coin Flip Streak 12s     7         1          1 global   Low
Block Bingo      60-120s 75 nums   1          1 global   High
Minefield        12s     25 cells  2          1 global   Medium
```

**Build order recommendation:**
1. Dice Over/Under (simplest, proves the full lifecycle)
2. Color Duel (slightly more complex, better visuals)
3. Crash/Rocket (most exciting, best demo)
4. Then the rest in any order

---

## 4. FastAPI Backend Specification

### 4.1 Purpose

Thin relay layer. No business logic. Three jobs:
1. Serve the frontend (index.html)
2. Watch contract events via WebSocket and relay to browsers
3. Provide cached/aggregated data for the frontend (optional)

### 4.2 Stack

```
Python 3.12+
FastAPI
uvicorn
web3.py (contract interaction, event listening)
eth-account (signing transactions for oracle/settlement if needed)
httpx (async HTTP for BTC API if using BTC block hash)
websockets (async WebSocket client to RPC provider)
```

### 4.3 File Structure

```
/Users/dindi/roulette/
├── contract/
│   ├── src/
│   │   ├── ParimutuelGame.sol        # Base contract
│   │   ├── DiceGame.sol              # Game 1
│   │   ├── ColorDuelGame.sol         # Game 2
│   │   ├── SlotsGame.sol             # Game 3
│   │   ├── CrashGame.sol              # Game 4
│   │   ├── HorseRaceGame.sol          # Game 5
│   │   ├── KenoGame.sol               # Game 6
│   │   ├── PlinkoGame.sol             # Game 7
│   │   ├── CoinFlipStreakGame.sol     # Game 8
│   │   ├── BlockBingoGame.sol          # Game 9
│   │   └── MinefieldGame.sol          # Game 10
│   ├── script/
│   │   └── Deploy.s.sol               # Deploy script
│   ├── test/
│   │   └── ParimutuelTest.sol         # Unit tests
│   ├── foundry.toml
│   └── .env                           # RPC URL, private key (testnet only)
├── backend/
│   ├── main.py                        # FastAPI app
│   ├── config.py                      # Config loader
│   ├── contract_listener.py           # Event listener → WebSocket relay
│   ├── game_configs.py                # Per-game metadata (names, bet types, etc.)
│   └── requirements.txt
├── frontend/
│   ├── index.html                     # Single file: HTML + CSS + JS
│   ├── games/                         # Per-game JS modules (optional split)
│   │   ├── dice.js
│   │   ├── color_duel.js
│   │   ├── slots.js
│   │   ├── crash.js
│   │   ├── horse_race.js
│   │   ├── keno.js
│   │   ├── plinko.js
│   │   ├── coin_flip.js
│   │   ├── bingo.js
│   │   └── minefield.js
│   └── shared/
│       ├── wallet.js                  # MetaMask connection, ethers.js setup
│       ├── contract.js                # Contract ABIs, address config
│       └── ui.js                      # Shared UI components (pool counter, timer, etc.)
├── bot/
│   ├── test_bot.py                    # Automated bettor for testnet
│   └── bot_config.json                # Bot settings
├── config.yaml                       # Global config (RPC, contract addresses, port)
├── start.sh                           # Launch script
├── .env                               # Secrets (NOT committed to git)
├── .gitignore
└── HANDOVER.md                        # This file
```

### 4.4 main.py Specification

```python
"""
FastAPI backend for parimutuel gambling platform.

Responsibilities:
1. Serve frontend (index.html + static files)
2. WebSocket endpoint /ws/pool — pushes real-time contract events to browsers
3. Optional: cached round data, bet history

NO business logic. NO database. The contract is the source of truth.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
import asyncio
import json
from web3 import Web3
from web3.providers.websocket import WebsocketProvider

app = FastAPI()

# Serve static frontend files
app.mount("/static", StaticFiles(directory="frontend"), name="static")

# ─── Config ───
# Load from config.yaml or .env:
#   RPC_WS_URL = "wss://base-sepolia.g.alchemy.com/v2/YOUR_KEY"
#   RPC_HTTP_URL = "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY"
#   CONTRACT_ADDRESSES = {"dice": "0x...", "crash": "0x...", ...}
#   PORT = 8090

# ─── WebSocket: /ws/pool ───
# Clients connect to ws://localhost:8090/ws/pool?game=dice
# Backend listens to contract events via RPC WebSocket
# Relays events to all connected browser clients

class ConnectionManager:
    """Manages WebSocket connections from browsers, grouped by game."""
    def __init__(self):
        # game_name → set of WebSocket connections
        self.connections: dict[str, set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, game: str):
        await websocket.accept()
        if game not in self.connections:
            self.connections[game] = set()
        self.connections[game].add(websocket)

    def disconnect(self, websocket: WebSocket, game: str):
        self.connections[game].discard(websocket)

    async def broadcast(self, game: str, message: dict):
        if game not in self.connections:
            return
        dead = []
        for ws in self.connections[game]:
            try:
                await ws.send_json(message)
            except:
                dead.append(ws)
        for ws in dead:
            self.connections[game].discard(ws)

manager = ConnectionManager()

@app.websocket("/ws/pool")
async def pool_ws(websocket: WebSocket, game: str = "dice"):
    await manager.connect(websocket, game)
    try:
        while True:
            # Keep connection alive; events are pushed by the listener task
            await websocket.receive_text()  # client can send pings
    except WebSocketDisconnect:
        manager.disconnect(websocket, game)

# ─── Contract Event Listener (background task) ───
# Runs on startup. Connects to RPC WebSocket, subscribes to contract events.
# When events arrive, broadcasts to connected browsers.

async def contract_event_listener():
    """
    For each deployed game contract:
    1. Connect to RPC WebSocket
    2. Subscribe to events: BetPlaced, RoundSettled, RoundVoided, RoundCarriedOver, WinningsClaimed, JackpotUpdated
    3. On event: format as JSON and broadcast to connected browsers for that game
    """
    # Implementation with web3.py event filters or subscription
    pass

@app.on_event("startup")
async def startup():
    asyncio.create_task(contract_event_listener())

# ─── Frontend ───
@app.get("/")
async def index():
    return FileResponse("frontend/index.html")

# ─── API endpoints (optional, for convenience reads) ───
@app.get("/api/{game}/round")
async def get_round(game: str):
    """Read current round state from contract."""
    # Call contract.currentRoundId(), contract.rounds(id), contract.totalPool(id)
    # Return JSON
    pass

@app.get("/api/{game}/history")
async def get_history(game: str, limit: int = 20):
    """Get past settled rounds. Read from contract events."""
    pass

@app.get("/api/health")
async def health():
    return {"status": "ok", "games": list(CONTRACT_ADDRESSES.keys())}
```

### 4.5 config.yaml

```yaml
# Network
network: "base-sepolia"
chain_id: 84532
rpc_ws_url: "wss://base-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY"
rpc_http_url: "https://base-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY"

# Backend
port: 8090
host: "0.0.0.0"

# Contract addresses (filled after deployment)
contracts:
  dice: ""
  color_duel: ""
  slots: ""
  crash: ""
  horse_race: ""
  keno: ""
  plinko: ""
  coin_flip: ""
  bingo: ""
  minefield: ""

# Contract config defaults (used in deploy script)
defaults:
  blocks_per_round: 5
  house_edge_bps: 500        # 5%
  settlement_bounty_bps: 10  # 0.1%
  min_pool_wei: 1000000000000000  # 0.001 ETH (~$3)
  min_bettors: 2
  carry_over_limit: 3
  claim_expiry_blocks: 216000  # ~30 days at 12s blocks

# BTC oracle (if using BTC block hash, optional)
btc_api: "https://mempool.space/api"
```

### 4.6 requirements.txt

```
fastapi>=0.110.0
uvicorn[standard]>=0.29.0
web3>=7.0.0
eth-account>=0.13.0
httpx>=0.27.0
websockets>=12.0
pyyaml>=6.0
python-dotenv>=1.0.0
```

---

## 5. Frontend Specification

### 5.1 Design Principles

- **Pure HTML + vanilla JS** (no React, no Vue, no build step)
- **Single page app** with game tabs (Dice, Color Duel, Slots, etc.)
- **Dark theme, glassmorphism** (per user preference)
- **Same port as backend** (FastAPI serves it)
- **ethers.js v6** for blockchain interaction (loaded from CDN)
- **MetaMask** for wallet connection and signing

### 5.2 Layout

```
┌─────────────────────────────────────────────────────────┐
│  🎰 PARIMUTUEL                    [0.142 ETH] [Connect]   │
│                                                          │
│  Dice | Color Duel | Slots | Crash | Horse | Keno | ... │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  ┌─────────────────────────┐  ┌──────────────────────┐  │
│  │                         │  │ ROUND #428            │  │
│  │   [GAME-SPECIFIC        │  │ Settles: block 850,005│  │
│  │    VISUAL AREA]         │  │ Est. 2 min remaining  │  │
│  │                         │  │                       │  │
│  │   Wheel / Reels /       │  │ POOL: $247.50         │  │
│  │   Rocket / Grid /       │  │ ████████████░░░░ 12   │  │
│  │   Horses / etc.         │  │ bettors               │  │
│  │                         │  │                       │  │
│  │                         │  │ JACKPOT: $1,205.00    │  │
│  │                         │  │ (carried from 3 rounds)│  │
│  └─────────────────────────┘  └──────────────────────┘  │
│                                                          │
│  ┌─────────────────────────┐  ┌──────────────────────┐  │
│  │  PLACE YOUR BET         │  │  RECENT BETS          │  │
│  │                         │  │                       │  │
│  │  [Bet interface         │  │  Alice: $10 on RED    │  │
│  │   varies by game]       │  │  Bob: $5 on 17         │  │
│  │                         │  │  Charlie: $20 on OVER │  │
│  │  Chip: [$1][$5][$10][$25]│  │  Dave: $50 on 7-7-7   │  │
│  │                         │  │  ...                  │  │
│  │  [    PLACE BET    ]    │  │                       │  │
│  └─────────────────────────┘  └──────────────────────┘  │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  YOUR BETS                                           │ │
│  │  Round 427: $10 on UNDER — WON $18.50 [CLAIM]       │ │
│  │  Round 428: $5 on 17 — PENDING                      │ │
│  │  Round 426: $25 on RED — LOST                       │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  Provably fair | Powered by Base L2 | View on Basescan   │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Shared JavaScript Modules

#### wallet.js — MetaMask connection

```javascript
// Connects to MetaMask, provides ethers.js provider and signer
// Exposes: window.wallet = { provider, signer, address, connect() }

let provider, signer, address;

async function connectWallet() {
    if (typeof window.ethereum === 'undefined') {
        alert('Please install MetaMask');
        return;
    }
    await window.ethereum.request({ method: 'eth_requestAccounts' });
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    address = await signer.getAddress();
    updateWalletUI(address, await provider.getBalance(address));
}

async function getBalance() {
    return await provider.getBalance(address);
}

window.wallet = { connectWallet, getProvider: () => provider, getSigner: () => signer, getAddress: () => address };
```

#### contract.js — Contract interaction

```javascript
// ABIs and contract addresses for all games
// Exposes helper functions: placeBet, claimWinnings, getRoundState, etc.

const CONTRACT_ADDRESSES = {
    dice: "0x...",
    crash: "0x...",
    // ... loaded from /api/config or embedded
};

const PARIMUTUEL_ABI = [
    "function currentRoundId() view returns (uint256)",
    "function rounds(uint256) view returns (uint256 resolutionBlock, uint256 totalPool, uint256 totalWinningBets, uint256 winningOutcome, uint256 carryOverCount, bool settled, bool voided, bool hasWinners)",
    "function placeBet(uint8 betType, uint8 betValue) payable",
    "function claimWinnings(uint256 roundId)",
    "function claimRefund(uint256 roundId)",
    "function withdrawPendingBet(uint256 roundId)",
    "function jackpot() view returns (uint256)",
    "function houseEdgeBps() view returns (uint256)",
    "function blocksPerRound() view returns (uint256)",
    "event BetPlaced(uint256 indexed roundId, address indexed player, uint8 betType, uint8 betValue, uint128 amount)",
    "event RoundSettled(uint256 indexed roundId, uint256 winningOutcome, uint256 totalPool, uint256 prizePool)",
    "event RoundCarriedOver(uint256 indexed roundId, uint256 newResolutionBlock)",
    "event WinningsClaimed(uint256 indexed roundId, address indexed player, uint256 amount)",
    "event JackpotUpdated(uint256 newJackpot)"
];

function getContract(gameName) {
    const provider = window.wallet.getProvider();
    return new ethers.Contract(CONTRACT_ADDRESSES[gameName], PARIMUTUEL_ABI, provider);
}

function getSignedContract(gameName) {
    const signer = window.wallet.getSigner();
    return new ethers.Contract(CONTRACT_ADDRESSES[gameName], PARIMUTUEL_ABI, signer);
}
```

#### ui.js — Shared UI elements

```javascript
// Pool counter, round timer, jackpot display, recent bets feed
// All driven by WebSocket events from FastAPI backend

class GameUI {
    constructor(gameName) {
        this.gameName = gameName;
        this.ws = null;
        this.contract = getContract(gameName);
    }

    async init() {
        await this.connectWS();
        await this.refreshRound();
        this.startPolling(); // fallback if WS drops
    }

    connectWS() {
        this.ws = new WebSocket(`ws://${location.host}/ws/pool?game=${this.gameName}`);
        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleEvent(data);
        };
    }

    handleEvent(event) {
        switch (event.type) {
            case 'BetPlaced':
                this.updatePool(event.totalPool);
                this.addRecentBet(event.player, event.amount, event.betType, event.betValue);
                break;
            case 'RoundSettled':
                this.showResult(event.winningOutcome);
                this.updatePool(0);
                this.refreshRound();
                break;
            case 'RoundCarriedOver':
                this.updateTimer(event.newResolutionBlock);
                break;
            case 'JackpotUpdated':
                this.updateJackpot(event.newJackpot);
                break;
        }
    }

    async placeBet(betType, betValue, amountEth) {
        const contract = getSignedContract(this.gameName);
        const tx = await contract.placeBet(betType, betValue, {
            value: ethers.parseEther(amountEth.toString())
        });
        await tx.wait();
        // UI will update via WebSocket event
    }

    async claimWinnings(roundId) {
        const contract = getSignedContract(this.gameName);
        const tx = await contract.claimWinnings(roundId);
        await tx.wait();
    }

    // ... refreshRound, updatePool, updateTimer, updateJackpot, showResult, addRecentBet
}
```

### 5.4 Per-Game Frontend Visuals

Each game needs a visual component rendered in the "GAME-SPECIFIC VISUAL AREA" of the layout. All use vanilla JS + CSS/Canvas.

#### Dice Over/Under
```
Visual: Large 2-digit number display (0-99). Glowing neon style.
  - Before settle: shows "—" or pulsing question mark
  - On settle: number appears with animation, scale tips left (under) or right (over)
  - 50 shows as "DEAD ZONE" in red
CSS: transform animation on a balance scale element
```

#### Color Duel
```
Visual: Three large colored circles (red, green, blue)
  - Before settle: all dimly lit, pulsing
  - On settle: winning color flares bright, losers fade to 20% opacity
  - Bet amounts shown as stacked bars under each circle
CSS: box-shadow glow animation, opacity transitions
```

#### Slots
```
Visual: 3 vertical reels (CSS transforms on a vertical strip of 8 symbols)
  - Before settle: reels spinning (CSS animation, infinite loop)
  - On settle: reels decelerate and stop at the 3 hash-derived symbols
  - Symbols: emoji or SVG (🍒🍋🔔bar7️⃣💎⭐👑)
Implementation: each reel is a div with overflow:hidden, inner strip translateY animated
Stop animation: ease-out cubic-bezier, final position = symbol index * reelHeight
```

#### Crash/Rocket
```
Visual: Line chart with a rocket icon climbing along it
  - Before settle: "preparing launch..." with countdown
  - On settle: line starts climbing from 1.0x, curve gets steeper
  - At crash_point: rocket explodes (particle animation), line stops
  - X-axis: time, Y-axis: multiplier (1.0x to 100x, log scale)
Implementation: Canvas 2D, requestAnimationFrame loop
  - Draw curved line from origin to current point
  - Rocket emoji/sprite at the tip
  - Explosion: 20-30 particle divs with CSS animations
  - Big text showing current multiplier: "2.37x"
```

#### Horse Race
```
Visual: 6 horizontal lanes, each with a horse icon
  - Before settle: all horses at start line, gently bobbing
  - On settle: horses animate to their finishing positions over ~10s
  - Winner lane highlights gold
Implementation:
  - 6 divs positioned absolutely, left property animated
  - Easing: ease-out (horses slow down near finish)
  - Horse sprites: emoji (🐎) or simple SVG
  - Lane labels: "Horse 1 (2:1)", showing current pool per horse
```

#### Keno
```
Visual: 40-number grid (8x5), player taps to select 5 numbers
  - Player's selected numbers: highlighted blue
  - On settle: drawn numbers light up one-by-one (staggered 200ms)
  - Matches between player and draw: glow gold
  - Non-matches in drawn set: light up green briefly
  - Final result text: "You matched 3 of 5!"
Implementation:
  - 40 button elements in a CSS grid
  - Stagger animation using setTimeout for each drawn number
  - CSS classes: .selected, .drawn, .matched
```

#### Plinko
```
Visual: Triangular peg grid (12 rows), 13 zones at bottom
  - Before settle: "drop pending..." overlay
  - On settle: ball drops from top, bounces through pegs (left/right per bit)
  - Lands in zone, zone highlights
  - Zone labels show current bet amounts
Implementation:
  - Canvas 2D for ball physics (simple: each row, ball goes left or right based on hash bit)
  - Pegs drawn as circles
  - Ball: small filled circle, animated with requestAnimationFrame
  - Path is deterministic from hash, animation is cosmetic
  - Zones at bottom: colored divs, winning zone pulses
```

#### Coin Flip Streak
```
Visual: Large coin, flipping animation
  - Before settle: coin spinning slowly (CSS 3D transform, infinite)
  - On settle: coin flips rapidly, then lands on result sequence
  - Each flip: heads → count++, flip again. Tails → stop.
  - Big counter: "STREAK: 3"
Implementation:
  - CSS 3D transform (rotateY) for coin flip
  - Sequence revealed with 500ms delay between each flip
  - Counter increments with a "pop" animation
  - Final result: "STREAK: 3 — You bet on 2 — LOST" or "WON $X"
```

#### Block Bingo
```
Visual: 5x5 bingo card (center = FREE)
  - Player's card shown on left, called numbers on right
  - As blocks are mined, 5 numbers "called" and highlighted on card
  - Completed lines: gold highlight + "BINGO!" flash
  - Called numbers list scrolls: "B-12, I-25, N-40, G-55, O-68..."
Implementation:
  - 25-cell grid (CSS grid), center cell has "FREE" label
  - Called numbers: animated text appearing with stagger
  - Line detection: check rows, cols, diagonals for all-matched
  - Gold flash animation on completed line
```

#### Minefield
```
Visual: 5x5 grid of cells
  - Player clicks cells to place chips (chip icon appears)
  - Multiple cells can be bet (each click = one bet)
  - On settle: mines explode (red burst animation), safe cells turn green
  - Winning cells show payout amounts
Implementation:
  - 25 button elements in CSS grid
  - Chip placement: small circle div appears on clicked cell
  - Explosion: CSS keyframe animation (scale + opacity + red glow)
  - Safe: green background transition
  - Interactive: click to bet, right-click to remove bet (before settle)
```

### 5.5 CSS Theme

```css
:root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #131320;
    --bg-card: rgba(20, 20, 35, 0.6);
    --border: rgba(255, 255, 255, 0.08);
    --text-primary: #e8e8f0;
    --text-secondary: #8888a0;
    --accent: #6c5ce7;
    --accent-glow: rgba(108, 92, 231, 0.4);
    --green: #00b894;
    --red: #e17055;
    --gold: #fdcb6e;
    --glass-blur: blur(12px);
}

body {
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: 'Inter', system-ui, sans-serif;
    margin: 0;
    min-height: 100vh;
}

.card {
    background: var(--bg-card);
    backdrop-filter: var(--glass-blur);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px;
}

/* Glassmorphism cards, neon accents, smooth transitions */
```

### 5.6 CDN Dependencies (in index.html)

```html
<script type="module" src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<!-- No other dependencies. Pure vanilla JS. -->
```

---

## 6. Test Bot Specification

### 6.1 Purpose

Automated bot that runs on Base Sepolia testnet. Places random bets on deployed game contracts. Verifies the full lifecycle: bet → block mined → settle → claim. Logs everything. Runs continuously until stopped.

### 6.2 test_bot.py

```python
"""
Test bot for parimutuel gambling platform on Base Sepolia.

Behavior:
1. Monitor all deployed game contracts
2. For each game, every round:
   a. Place 1-3 random bets (random bet type, random amount 0.001-0.01 ETH)
   b. Wait for round to become settle-able
   c. Call settleRound() (act as the settlement bot)
   d. If bot won: call claimWinnings()
   e. Log everything

3. Runs indefinitely. Logs to stdout and bot.log file.

Usage:
   python bot/test_bot.py --config config.yaml --key 0xYOUR_PRIVATE_KEY

The bot wallet needs Base Sepolia ETH (get from faucet).
"""

# Key parameters:
BOT_WALLETS = 3      # number of bot wallets to simulate (derived from base key + index)
MIN_BET = 0.001      # ETH
MAX_BET = 0.01       # ETH
BETS_PER_ROUND = 2   # random bets per bot per round
SETTLE_ROUNDS = True # bot calls settleRound() when possible
CLAIM_WINS = True    # bot claims winnings
LOG_FILE = "bot.log"

# Bot behavior per round:
# 1. Check if round is open for betting (block.number < resolutionBlock)
# 2. Place BETS_PER_ROUND random bets
# 3. Wait for block.number >= resolutionBlock
# 4. Call settleRound()
# 5. Check if any bot bets won
# 6. If won: claimWinnings()
# 7. Log: round result, pool size, bot P/L, gas spent
# 8. Move to next round

# Logging format:
# [2026-06-17 14:23:01] [DICE] Round 428 | Bot1 bet 0.005 ETH on OVER | Pool: 0.015 ETH
# [2026-06-17 14:23:13] [DICE] Round 428 settled | Result: 73 (OVER wins) | Bot1 WON 0.012 ETH
# [2026-06-17 14:23:15] [DICE] Round 428 | Bot1 claimed 0.012 ETH | Gas: 0.0001 ETH | Net: +0.007 ETH
# [2026-06-17 14:23:20] [DICE] Round 429 opened | Bot1 betting...
```

### 6.3 Bot Wallet Funding

1. Generate a wallet: `cast wallet new` (Foundry) or use an existing one
2. Get Base Sepolia ETH from faucet: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet
3. Each bot wallet needs ~0.1 ETH (enough for ~50 bets at 0.001-0.01 ETH + gas)
4. Bot private key stored in .env (NEVER committed to git)

---

## 7. Deployment & Testing Workflow

### 7.1 Prerequisites

```bash
# Install Foundry (Solidity compiler, test, deploy)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Install Python deps
cd /Users/dindi/roulette
uv venv .venv
source .venv/bin/activate
uv pip install -r backend/requirements.txt
```

### 7.2 Step-by-step

```
Step 1: Compile contracts
  cd contract && forge build
  → All 10 game contracts + base contract compile

Step 2: Run unit tests
  forge test
  → Test: betting, settlement, carry-over, floor, jackpot, claims, voids

Step 3: Get testnet ETH
  → Generate wallet: cast wallet new
  → Fund from Base Sepolia faucet
  → Save private key to .env

Step 4: Deploy to Base Sepolia
  forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --private-key $KEY --broadcast
  → Deploys all 10 contracts, logs addresses
  → Update config.yaml with deployed addresses

Step 5: Start FastAPI backend
  cd backend && python main.py
  → Serves frontend on http://localhost:8090
  → WebSocket listener connects to RPC, watches contract events

Step 6: Start test bot
  python bot/test_bot.py --config config.yaml --key $BOT_KEY
  → Bot starts placing bets on all 10 games
  → Logs show full lifecycle

Step 7: Open frontend
  → http://localhost:8090
  → Connect MetaMask (switch to Base Sepolia network)
  → See games, pools updating in real-time as bot bets
  → Place your own bets alongside the bot
  → Watch rounds settle, see results

Step 8: Verify lifecycle
  → Bot logs show: bet → settle → claim
  → Frontend shows: pool updates, wheel/reels/rocket animate
  → Basescan shows: all transactions on contract
  → Everything works
```

### 7.3 Deploy Script (Deploy.s.sol)

```solidity
// Deploys all 10 game contracts and logs addresses
// Also sets initial config parameters

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        address house = vm.addr(deployerPrivateKey);

        // Deploy each game with same config
        uint256 blocksPerRound = 5;
        uint256 houseEdgeBps = 500;
        uint256 settlementBountyBps = 10;

        DiceGame dice = new DiceGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        ColorDuelGame colorDuel = new ColorDuelGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        SlotsGame slots = new SlotsGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        CrashGame crash = new CrashGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        HorseRaceGame horseRace = new HorseRaceGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        KenoGame keno = new KenoGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        PlinkoGame plinko = new PlinkoGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        CoinFlipStreakGame coinFlip = new CoinFlipStreakGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        BlockBingoGame bingo = new BlockBingoGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);
        MinefieldGame minefield = new MinefieldGame(house, blocksPerRound, houseEdgeBps, settlementBountyBps);

        vm.stopBroadcast();

        // Log all addresses
        console.log("DiceGame:", address(dice));
        console.log("ColorDuelGame:", address(colorDuel));
        // ... etc
    }
}
```

---

## 8. start.sh

```bash
#!/bin/bash
# Launch script: starts backend + bot

set -e

cd /Users/dindi/roulette

# Activate venv
source .venv/bin/activate

# Load env
export $(cat .env | xargs)

# Start backend in background
echo "Starting FastAPI backend on port 8090..."
python backend/main.py &
BACKEND_PID=$!

# Start test bot in background
echo "Starting test bot..."
python bot/test_bot.py --config config.yaml --key $BOT_PRIVATE_KEY &
BOT_PID=$!

echo "Backend PID: $BACKEND_PID"
echo "Bot PID: $BOT_PID"
echo "Frontend: http://localhost:8090"
echo "Press Ctrl+C to stop all"

# Wait for Ctrl+C
trap "kill $BACKEND_PID $BOT_PID; exit" INT
wait
```

---

## 9. .gitignore

```
.env
*.log
__pycache__/
.venv/
node_modules/
cache/
out/  # Foundry build output
```

---

## 10. Key Implementation Notes for the Agent

### 10.1 Things to get right

1. **RNG is the resolution block's hash, NOT the current block's hash.** The resolution block is pre-determined when the round opens. At settlement time, `blockhash(resolutionBlock)` gives the hash of that specific past block. This prevents anyone from influencing the outcome during settlement.

2. **blockhash() only works for the last 256 blocks.** On Base (~2s blocks), that's ~8 minutes. If a round isn't settled within 256 blocks of its resolution block, the hash is no longer accessible. Solution: either settle promptly (settlement bounty ensures this) or store the hash when it's first available (a keeper writes the hash to the contract during the valid window).

3. **USDT is NOT used.** ETH is native, no approve transaction, no non-standard ERC-20 quirks. If USDT is needed later, it's a separate integration.

4. **Pull-payment is mandatory.** Never loop through all bettors in settleRound(). It will hit gas limits. Winners claim individually.

5. **The floor is self-funding.** The break-even floor (winners get at least their bet back) is funded entirely by the house giving back part of its cut. The house NEVER pays more than it collected. Math proof: shortfall = totalWinningBets - prizePool <= totalPool - totalPool*0.95 = houseCut. Always.

6. **Carry-over costs zero gas.** When minimums aren't met, the contract just pushes the resolutionBlock forward. No transaction needed by anyone. Bets stay in place.

7. **Settlement bounty is critical for automation.** Without it, nobody has incentive to call settleRound(). 0.1% of the pool is enough to attract bots. Self-funding.

### 10.2 Things to watch out for

1. **Reentrancy**: all ETH-sending functions (claim, refund, withdraw, bounty) must have ReentrancyGuard.

2. **blockhash edge case**: if settleRound() is called too late (>256 blocks after resolution), blockhash returns 0. Handle this: if hash is 0, use a fallback (e.g., use the hash of the block settleRound is called in, with a penalty, or just void the round).

3. **Front-running bets**: a player could wait until the last second, see the resolution block hash, and place a bet knowing the outcome. Solution: bets are only accepted during the betting window (blocks BEFORE resolutionBlock). Once the resolution block is mined, placeBet() reverts for that round.

4. **Gas estimation**: test bot should estimate gas before sending. If gas is too high (network congestion), skip the round and retry.

5. **Contract upgrade path**: if bugs are found, there's no upgrade mechanism in this design. For production, use a proxy pattern (UUPS or Transparent). For testnet, just redeploy.

6. **Frontend as the primary interface**: the contract can be interacted with directly via Etherscan/cast, but the frontend is what most users will use. Make sure the frontend handles all edge cases (round not yet settle-able, no winners, voided round, claim expired, insufficient balance, MetaMask rejection, network wrong).

### 10.3 Environment constraints (user's machine)

- macOS, user home: /Users/dindi
- Python: use `uv venv` (NOT conda base — conda has ABI conflicts)
- Port 8080 is taken, port 3000 taken by Hermes dashboard — use port 8090
- Ollama running on localhost:11434 (not relevant here but don't use that port)
- Hermes terminal $HOME resolves to profile sandbox, NOT real home — use absolute paths
- Cloudflare blocks default Python urllib User-Agent — if backend calls BTC API, set custom User-Agent header

### 10.4 Testing checklist

```
[ ] Contract compiles (forge build)
[ ] Unit tests pass (forge test)
[ ] Deploy to Base Sepolia succeeds
[ ] Backend starts and serves frontend on :8090
[ ] WebSocket connection works (browser receives BetPlaced events)
[ ] Bot places bets on all 10 games
[ ] Rounds settle correctly (winning number from blockhash)
[ ] Carry-over works when < 2 bettors
[ ] Floor works when everyone bets same and wins (break-even)
[ ] Jackpot carries over when no winners
[ ] Claims work (winners receive ETH)
[ ] Refunds work (voided rounds)
[ ] Withdraw pending bet works
[ ] House cut collection works
[ ] Settlement bounty paid to settler
[ ] Frontend shows correct pool, timer, results
[ ] Frontend animations trigger on settlement
[ ] MetaMask integration works (connect, bet, claim)
[ ] All 10 game visuals render correctly
```

---

## 11. Production Migration Checklist

When moving from testnet to mainnet:

```
[ ] Switch RPC to Base mainnet (not Sepolia)
[ ] Switch Chainlink VRF to mainnet addresses
[ ] Switch Chainlink Automation to mainnet
[ ] Deploy contracts to Base mainnet
[ ] Upload frontend to Arweave (arweave.net deploy)
[ ] Register ENS name, point to Arweave hash
[ ] Set up Alchemy mainnet app (for RPC/WebSocket)
[ ] Fund contracts with LINK for VRF/Automation
[ ] Test with small amounts first
[ ] Set up monitoring (optional: Tenderly)
[ ] Remove settlement bounty if using Chainlink Automation (or keep both)
[ ] Set min bet to appropriate mainnet value ($5+ equivalent)
[ ] Verify all contract addresses in config
[ ] Test the full flow on mainnet with minimal amounts
```

---

## END OF HANDOVER DOCUMENT

The agent receiving this should:
1. Read this entire document first
2. Start with Step 1 (compile contracts) and work through the workflow
3. Build Dice Over/Under first as proof of concept
4. Then add other games one at a time
5. Run the test bot to verify each game works end-to-end
6. Report back with: contract addresses, test results, any issues encountered