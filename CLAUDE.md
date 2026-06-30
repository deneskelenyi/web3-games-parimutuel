# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a parimutuel blockchain gambling platform on Ethereum L2 (Base). Smart contracts hold all logic and funds. A FastAPI backend serves a single-page vanilla-JS frontend and proxies blockchain events via WebSocket. The target workflow is: implement one game end-to-end (Dice Over/Under first), then expand to the other nine games.

Core principle: the house never risks money. All bets go into a shared pool; the house takes a configured percentage; winners split the remainder proportionally. No-winner rounds carry their prize pool into a jackpot.

## Repository Layout

The project is intended to be organized as follows (most directories do not exist yet; scaffold them as needed):

```
/Users/dindi/Documents/Code/web3_games/
├── contract/              # Foundry Solidity project
│   ├── src/               # ParimutuelGame.sol base + game contracts
│   │   ├── ParimutuelGame.sol
│   │   └── DiceGame.sol
│   ├── script/            # Deploy.s.sol
│   ├── test/              # Forge unit tests
│   │   └── DiceGame.t.sol
│   ├── lib/               # OpenZeppelin + forge-std
│   ├── out/               # Compiled ABI artifacts
│   └── foundry.toml
├── backend/               # FastAPI app
│   ├── __init__.py
│   ├── main.py            # FastAPI entry point
│   ├── config.py          # config.yaml loader
│   ├── contract_listener.py # RPC log poller + WS broadcaster
│   ├── game_configs.py    # Per-game metadata for frontend
│   └── requirements.txt
├── frontend/              # Vanilla JS single-page app
│   ├── index.html         # Casino-themed UI shell + CSS
│   ├── games/
│   │   └── dice.js        # Dice-specific betting logic
│   └── shared/
│       ├── wallet.js      # MetaMask / ethers.js connection
│       ├── contract.js    # Contract reads/writes
│       └── ui.js          # WebSocket client + shared UI updates
├── config.yaml            # RPC, contract addresses, defaults
├── start.sh               # Launch Anvil + deploy + backend
├── .gitignore
├── .env                   # Secrets (not committed)
└── HANDOVER.md            # Full design specification
```

## Common Development Commands

### Solidity / Foundry

Foundry is installed in `$HOME/.foundry/bin`. Make sure it is on `PATH` (the installer adds it to `~/.zshenv` on macOS) or prefix commands with `export PATH="$HOME/.foundry/bin:$PATH"`.

```bash
# Compile all contracts
cd contract && forge build

# Run unit tests
cd contract && forge test

# Run a single test
cd contract && forge test --match-test <TestName>

# Run tests for the first game only
cd contract && forge test --match-contract DiceGameTest

# Deploy all contracts to Base Sepolia (once Deploy.s.sol exists)
cd contract && forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast
```

### Python / FastAPI

```bash
# Create venv and install dependencies (use uv, not conda)
cd /Users/dindi/Documents/Code/web3_games
uv venv .venv
source .venv/bin/activate
uv pip install -r backend/requirements.txt

# Start the backend on port 8090
# Must run from project root so the `backend` package is importable.
cd /Users/dindi/Documents/Code/web3_games
uvicorn backend.main:app --host 0.0.0.0 --port 8090

# Or use the provided launch script (starts Anvil, deploys, configures, starts backend)
./start.sh
```

### Frontend

The frontend is a single-page vanilla-JS app served by FastAPI at `/`. Open `http://localhost:8090` after starting the backend. MetaMask must be on the same chain as `config.yaml` (Anvil `31337` for local, Base Sepolia `84532` for testnet).

### Local Anvil development

```bash
# 1. Start Anvil
anvil --port 8545 --block-time 2

# 2. In another shell, deploy DiceGame
cd /Users/dindi/Documents/Code/web3_games/contract
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key $PRIVATE_KEY --broadcast

# 3. Update config.yaml with the deployed address and set easy local limits
cast send $DICE_ADDRESS "setMinPool(uint256)" 0 --rpc-url http://127.0.0.1:8545 --private-key $PRIVATE_KEY
cast send $DICE_ADDRESS "setMinBettors(uint256)" 1 --rpc-url http://127.0.0.1:8545 --private-key $PRIVATE_KEY

# 4. Start backend and open http://localhost:8090
```

### Test Bot

```bash
python bot/test_bot.py --config config.yaml --key $BOT_PRIVATE_KEY
```

### E2E UI Tests

`test_demo_wallet.py` is a Playwright test that exercises the full demo-wallet flow end-to-end. It assumes the local stack is already running on port 8090.

```bash
cd /Users/dindi/Documents/Code/web3_games
source .venv/bin/activate
playwright install chromium  # one-time
python test_demo_wallet.py
```

The test: opens the wallet-selection modal, creates a demo wallet, calls the faucet, places a 0.01 ETH UNDER bet, and verifies the live bet appears in the UI via WebSocket. It then waits for the backend auto-settler to close the round and checks that the dice display reveals a numeric outcome, shows OVER/UNDER/DEAD ZONE text, and updates My Bets to Won/Lost. My Bets are read from the contract via `getPlayerBets`.

## High-Level Architecture

### Smart Contracts

- `ParimutuelGame.sol` is an abstract base contract (Solidity 0.8.24, OpenZeppelin v5 `Ownable`, `Pausable`, `ReentrancyGuard`, `Math`) containing shared logic: round derivation, betting, settlement, claims, refunds, jackpot, and house-cut collection.
- Each game contract inherits from `ParimutuelGame` and implements only two hooks:
  - `_determineOutcome(uint256 roundId)` — maps the RNG to a game-specific result.
  - `_isWinningBet(Bet memory bet, uint256 winningOutcome)` — per-bet win check.
- The base contract computes winners via `_calculateWinners`, which iterates the `roundBettors[roundId]` array and uses `_isWinningBet`. An `isRoundBettor` mapping prevents duplicate bettor-count increments and tracks active bettors for withdrawals.
- All ETH stays in the contract. Settlement uses pull-payments: winners call `claimWinnings` individually after the round is settled.
- Rounds are derived from `block.number / blocksPerRound`; they are not explicitly started.
- Settlement requires `block.number > rounds[roundId].resolutionBlock` (strict), because `blockhash(resolutionBlock)` is not available in the same block that produces it.
- RNG uses `blockhash(resolutionBlock)`. If that hash is unavailable (e.g., >256 blocks later or in tests without a mocked hash), a deterministic fallback derived from `roundId`, `block.number`, and `block.timestamp` is used.
- Each round stores its final `prizePool`. The house cut for the round is stored in `roundHouseCut[roundId]` and only withdrawable by the owner via `collectHouseCut`.

### Backend

- FastAPI is a thin relay with no business logic and no database.
- Responsibilities:
  1. Serve `index.html` and static frontend files.
  2. Maintain a WebSocket endpoint at `/ws/pool?game=<name>` and broadcast contract events to connected browsers grouped by game.
  3. Optional convenience endpoints for reading current round state and recent history from the contract.
- The backend watches contract events via the RPC provider's HTTP polling and forwards them as JSON.
- An optional `AutoSettler` task (enabled by default on `anvil`) calls `settleRound()` for closed rounds so local demos show outcomes without a manual settler or bot. Toggle with `auto_settle` in `config.yaml`.

### Frontend

- Single-page vanilla JS app. No build step, no React/Vue.
- `ethers.js` v6 loaded from CDN; MetaMask handles wallet connection and signing.
- Shared modules:
  - `wallet.js` — MetaMask or browser-generated demo wallet; provider, signer, balance refresh.
  - `contract.js` — contract ABIs, addresses, read/write helpers.
  - `ui.js` — WebSocket connection, pool/timer/jackpot UI, generic event handling.
- Each game has its own visual module under `frontend/games/`.
- Game tabs at the top switch between active and coming-soon games; only the deployed games are enabled.
- The Dice UI rolls while a round is live, then plays a landing animation to reveal the winning number, flashes green/red for OVER/UNDER, and bursts confetti when the player wins.
- A demo wallet mode lets visitors try the dApp without MetaMask. The browser creates a random ethers wallet and the backend `/api/faucet` funds it with 0.1 ETH from a configured faucet key.
- UI theme is dark glassmorphism; colors are defined in the CSS `:root` variables in `frontend/index.html`.

### Test Bot

- Automated wallet-driven bot that runs against Base Sepolia.
- Places random bets, calls `settleRound`, and claims winnings for each game.
- Logs to stdout and a log file. Multiple bot wallets can be derived from a single key.

## Environment Constraints

- Use `uv` for Python virtual environments. Do not use the system conda base environment; it has ABI conflicts.
- The machine is macOS; user home is `/Users/dindi`.
- Port 8080 and 3000 are already taken. Use port 8090 for the backend.
- Ollama runs on port 11434 — avoid it.
- Cloudflare blocks default Python `urllib` User-Agent. If the backend calls external HTTP APIs (e.g., a BTC oracle), set a custom `User-Agent` header.
- Hermes terminal `$HOME` resolves to a sandbox, not the real home. Use absolute paths in scripts and commands.

## Critical Implementation Details

- **RNG source**: use `blockhash(rounds[roundId].resolutionBlock)`, not `blockhash(block.number)`. Settlement is only allowed on a later block (`block.number > resolutionBlock`), so the hash of the resolution block is always available (within 256 blocks).
- **Betting window**: `placeBet` closes once `block.number >= round.resolutionBlock`. Because round IDs advance at the resolution block, this mostly matters for carried-over rounds and prevents front-running.
- **Pull-payments only**: never iterate over all bettors in `settleRound`. Gas limits will be exceeded.
- **Reentrancy**: all functions that send ETH (`claimWinnings`, `claimRefund`, `withdrawPendingBet`, bounty payout, `collectHouseCut`) use OpenZeppelin `ReentrancyGuard` from `@openzeppelin/contracts/utils/ReentrancyGuard.sol` (v5).
- **Jackpot accounting**: when a round has no winners, its prize pool rolls into the global jackpot. When a later round has winners, that jackpot is added to the prize pool and reset to zero for that round.
- **Floor guarantee**: if winners' proportional share would be less than their total bets, the house gives back part of its cut, up to the full house cut. The bounty is not returned, so break-even is `totalPool - bounty` when all bets win.
- **blockhash expiry fallback**: if the resolution block hash is unavailable, `_getRNG` falls back to a deterministic value derived from `roundId`, `block.number`, and `block.timestamp`. For deterministic tests, mock the hash with `vm.setBlockhash(resBlock, ...)`. Voiding is also an acceptable fallback for production.
- **Bettor tracking**: the base contract maintains `roundBettors[roundId]` (list of unique addresses) and `isRoundBettor`. `_calculateWinners` iterates this list, skipping already-claimed bets.
- **Claims expiry**: `claimWinnings` respects `claimExpiryBlocks` (0 = disabled). Refunds for voided rounds never expire.
- **USDT is intentionally not used**. The platform uses native ETH to avoid approve transactions and non-standard ERC-20 behavior.

## Build Order

The handover recommends implementing games in this order:

1. Dice Over/Under — simplest, proves the full lifecycle.
2. Color Duel — slightly more complex, good visuals.
3. Crash / Rocket — most exciting demo.
4. Remaining games: Slots, Horse Race, Keno, Plinko, Coin Flip Streak, Block Bingo, Minefield.

## Deployment Workflow

1. `forge build` and `forge test` in `contract/`.
2. Generate/fund a Base Sepolia wallet and store the private key in `.env`.
3. Run `Deploy.s.sol` against Base Sepolia.
4. Copy deployed addresses into `config.yaml`.
5. Start the backend (`python backend/main.py`).
6. Start the test bot (`python bot/test_bot.py --config config.yaml --key $BOT_PRIVATE_KEY`).
7. Open `http://localhost:8090` and connect MetaMask to Base Sepolia.

## Files to Read When Starting

- `HANDOVER.md` — full specification, game rules, wireframes, testing checklist.
- `foundry.toml` — once it exists; compiler version and remappings.
- `config.yaml` — network and contract configuration.
- `backend/requirements.txt` — Python dependencies.
- `frontend/index.html` and `frontend/shared/*.js` — frontend entry points.
- `contract/src/ParimutuelGame.sol` — base contract logic.
- `contract/src/DiceGame.sol` — reference implementation for new games.
- `contract/test/DiceGame.t.sol` — unit tests showing how to mock blockhashes and verify the full lifecycle.
- `contract/script/Deploy.s.sol` — deployment script.
- `contract/foundry.toml` — compiler version and optimizer settings.
- `backend/main.py` — FastAPI app and WebSocket endpoint.
- `backend/contract_listener.py` — RPC polling / event broadcasting.
- `frontend/index.html` and `frontend/shared/*.js` — frontend entry points.
- `frontend/games/dice.js` — first game UI and betting flow.
- `config.yaml` — network and contract configuration.
