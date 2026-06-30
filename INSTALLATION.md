# Parimutuel On-Chain Casino — Installation & Operations Guide

A parimutuel gambling platform on Ethereum L2 (Base). Smart contracts hold all logic and funds. A FastAPI backend serves a single-page vanilla-JS frontend and forwards blockchain events via WebSocket.

**Core principle:** the house never risks money. All bets go into a shared pool; the house takes a configured percentage; winners split the remainder proportionally. No-winner rounds carry their prize pool into a jackpot that rolls to the next winning round.

## Table of Contents

1. [What it does](#what-it-does)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Quick start (local Anvil)](#quick-start-local-anvil)
5. [Manual install & local run](#manual-install--local-run)
6. [Deploy to Base Sepolia / Mainnet](#deploy-to-base-sepolia--mainnet)
7. [Backend configuration](#backend-configuration)
8. [Production deployment notes](#production-deployment-notes)
9. [Security & operations](#security--operations)
10. [Troubleshooting](#troubleshooting)

## What it does

- **11 provably fair parimutuel games** on an EVM chain:
  - Dice Over/Under, Color Duel, Crash, Plinko, Roulette, Coin Flip Streak, Slots, Horse Race, Keno, Block Bingo, Minefield.
- **No approve transactions.** The platform uses native ETH only.
- **Shared pool betting.** Players bet into the current round pool. When the round closes, the contract draws an on-chain random outcome from the settlement block hash, determines winners, and locks the prize allocation.
- **Pull payments.** Winners claim their own winnings; the settlement transaction never iterates over all bettors.
- **No-winner jackpot.** Rounds with zero winners carry their prize pool into a global jackpot, which is added to the next round that does have winners.
- **Floor guarantee.** If a round's proportional payout would be less than the winners' total bets, the house gives back part of its cut (up to the full house cut) so winners never lose principal on an all-win round.
- **Demo wallet mode.** Visitors without MetaMask can create a browser-generated demo wallet. The backend funds it from a configured faucet key.
- **WebSocket live updates.** The backend polls RPC logs and pushes events (`BetPlaced`, `RoundSettled`, `WinningsClaimed`, etc.) to connected browsers in near real time.

## Architecture

```
/Users/dindi/Documents/Code/web3_games/
├── contract/               # Foundry Solidity project
│   ├── src/
│   │   ├── ParimutuelGame.sol   # Abstract base: rounds, bets, settlement, claims, jackpot
│   │   └── {DiceGame,ColorDuelGame,...}.sol  # Game-specific outcome + win hooks
│   ├── script/Deploy.s.sol      # Deploys all 11 games
│   ├── test/                    # Forge unit tests (DiceGame.t.sol as reference)
│   └── foundry.toml             # solc 0.8.24, via_ir, optimizer 200 runs
├── backend/                # FastAPI app
│   ├── main.py             # Static file server + /ws/pool WebSocket + API
│   ├── contract_listener.py# RPC log poller
│   ├── auto_settler.py     # Calls settleRound() for closed rounds
│   ├── game_configs.py     # Per-game metadata for the frontend
│   └── requirements.txt    # Python deps
├── frontend/               # Vanilla JS single-page app
│   ├── index.html          # Dice entry point + shared CSS
│   ├── {color-duel,crash,...}.html  # Other game pages
│   ├── games/*.js          # Game-specific UI logic
│   └── shared/             # wallet.js, contract.js, ui.js, history.js, how-it-works.js
├── config.yaml             # RPC, addresses, defaults
├── start.sh                # Launch Anvil + deploy + backend
└── .env                    # Secrets (not committed)
```

## Prerequisites

- macOS or Linux development machine
- [Foundry](https://getfoundry.sh/) installed (`forge`, `cast`, `anvil` available at `$HOME/.foundry/bin`)
- [uv](https://docs.astral.sh/uv/) for Python environment management
- Node.js (optional; only needed for E2E tests with Playwright)
- A modern browser with MetaMask for real-wallet testing

## Quick start (local Anvil)

```bash
cd /Users/dindi/Documents/Code/web3_games
./start.sh
```

What the script does:
1. Starts Anvil on port 8545 with 2-second block time.
2. Builds all contracts with `forge build`.
3. Deploys all 11 games via `Deploy.s.sol`.
4. Parses deployment output and writes addresses into `config.yaml`.
5. Configures each game for easy local testing (`minPool=0`, `minBettors=1`, `minBet=0.0001 ETH`).
6. Creates a `uv` virtualenv if needed and installs Python deps.
7. Starts the FastAPI backend on `http://0.0.0.0:8090`.

Then open **http://localhost:8090**. Choose the Dice tab, connect wallet, and place a bet.

## Manual install & local run

### 1. Clone / enter the repo

```bash
cd /Users/dindi/Documents/Code/web3_games
```

### 2. Install Python dependencies

```bash
uv venv .venv
source .venv/bin/activate
uv pip install -r backend/requirements.txt
```

### 3. Start Anvil

```bash
anvil --port 8545 --block-time 2
```

### 4. Deploy contracts

```bash
cd contract
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
forge build
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --private-key $PRIVATE_KEY --broadcast
```

Copy each printed address into `config.yaml` under `contracts:`.

### 5. Configure contracts for local play

```bash
cd /Users/dindi/Documents/Code/web3_games
export DICE=0x...   # replace with deployed address
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
cast send $DICE "setMinPool(uint256)" 0 --rpc-url http://127.0.0.1:8545 --private-key $PRIVATE_KEY
cast send $DICE "setMinBettors(uint256)" 1 --rpc-url http://127.0.0.1:8545 --private-key $PRIVATE_KEY
# repeat for each game contract
```

### 6. Start the backend

```bash
cd /Users/dindi/Documents/Code/web3_games
source .venv/bin/activate
uvicorn backend.main:app --host 0.0.0.0 --port 8090
```

### 7. Run the E2E test (optional)

```bash
playwright install chromium  # one-time
python test_demo_wallet.py
```

## Deploy to Base Sepolia / Mainnet

### 1. Create a deployer wallet

Generate or use an existing wallet. Fund it with enough native ETH for deployment gas plus a small amount for test interactions.

### 2. Set environment variables

Create a `.env` file at the project root (never commit it):

```bash
BASE_SEPOLIA_RPC=https://sepolia.base.org
PRIVATE_KEY=0x...
```

### 3. Build and deploy

```bash
cd /Users/dindi/Documents/Code/web3_games/contract
forge build
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --private-key $PRIVATE_KEY --broadcast
```

### 4. Update `config.yaml`

Set `network: base-sepolia`, `chain_id: 84532`, the RPC URLs, and all 11 deployed addresses.

### 5. Tune contract parameters

```bash
export ADDR=0x...
cast send $ADDR "setMinPool(uint256)" 1000000000000000 --rpc-url $BASE_SEPOLIA_RPC --private-key $PRIVATE_KEY
cast send $ADDR "setMinBettors(uint256)" 2 --rpc-url $BASE_SEPOLIA_RPC --private-key $PRIVATE_KEY
```

For mainnet, change `chain_id` to `8453` and use a mainnet RPC.

## Backend configuration

`config.yaml` is the single source of truth for the backend:

| Key | Purpose |
|---|---|
| `network` / `chain_id` | Which chain the backend talks to. |
| `rpc_http_url` / `rpc_ws_url` | RPC endpoints. Use Anvil localhost for local, Base Sepolia RPC for testnet. |
| `port` / `host` | Backend bind address. Defaults to `0.0.0.0:8090`. |
| `contracts` | 11 deployed contract addresses. |
| `faucet.private_key` | Key that funds demo wallets. Must hold ETH on the target chain. |
| `faucet.amount_wei` | How much ETH each `/api/faucet` call sends. |
| `auto_settle` | If `true`, the backend calls `settleRound()` automatically. Great for Anvil demos; usually disable on public testnets. |
| `auto_settle_interval` | Seconds between settlement attempts. |
| `defaults.*` | Default values used by `Deploy.s.sol`. |

### Important flags

- **Local Anvil:** keep `auto_settle: true` so rounds close automatically.
- **Public testnet / mainnet:** set `auto_settle: false` so users, bots, or keepers pay settlement gas and earn the bounty. Run `python bot/test_bot.py --config config.yaml --key $BOT_PRIVATE_KEY` if you want an automated bot.

## Production deployment notes

- **Frontend:** the FastAPI app already serves `frontend/` as static files. No separate frontend build is needed.
- **Backend:** run behind a reverse proxy (nginx, Caddy, or a cloud load balancer) with HTTPS termination. WebSocket must be proxied (`/ws/pool`).
- **RPC:** use a reliable provider (e.g., Alchemy, Infura, QuickNode). Anvil is not suitable for production.
- **Auto-settle:** disable in production. Settlement bounties should incentivize external callers.
- **Private keys:** keep deployer/owner and faucet keys in environment variables or a secrets manager. Never commit them.
- **Owner operations:** the deployer wallet is the contract owner. Use it to pause games (`pause()`), collect house cut (`collectHouseCut`), or update parameters (`setHouseEdgeBps`, `setMinPool`, etc.).
- **Monitoring:** watch backend logs, RPC health, and contract balances. Set up alerts when a contract balance becomes unexpectedly low.

## Security & operations

- **Native ETH only.** The platform intentionally avoids ERC-20 tokens to eliminate `approve` flow risks and token-standard edge cases.
- **ReentrancyGuard.** All ETH-sending functions use OpenZeppelin v5 `ReentrancyGuard`.
- **Pull payments only.** Settlement never iterates over bettors; winners claim individually.
- **RNG source.** Settlement uses `blockhash(resolutionBlock)` once `block.number > resolutionBlock`. If the blockhash expires, a deterministic fallback is used; for production you may prefer a void-round fallback or an oracle/VRF.
- **Demo wallet mode.** A browser-generated private key is stored in `localStorage`. This is fine for faucets and demos, but warn users not to deposit real funds into demo wallets.
- **Faucet draining.** The `/api/faucet` endpoint sends ETH from `faucet.private_key`. On public networks, rate-limit or protect this endpoint, or disable it entirely.
- **Claims expiry.** `claimExpiryBlocks` can be set > 0 so unclaimed winnings eventually expire. Set to `0` to disable.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `forge build` fails with solc not found | `$HOME/.foundry/bin` is not on `PATH`. | `export PATH="$HOME/.foundry/bin:$PATH"` or use absolute paths. |
| Backend cannot connect to RPC | Anvil not running, or wrong `rpc_http_url`. | Start Anvil and check `config.yaml`. |
| Frontend shows blank / 404 | Backend not serving `frontend/`. | Start backend from project root (`/Users/dindi/Documents/Code/web3_games`), not from `backend/`. |
| MetaMask wrong chain | Chain ID mismatch. | Add/switch to chain 31337 for Anvil or 84532 for Base Sepolia. |
| Bets revert `BettingClosed` | Round is about to close / has closed. | Wait for the next round or increase `blocksPerRound`. |
| `settleRound` reverts `NoWinners` or similar | You are calling the wrong game contract, or the round has no bets / no outcome yet. | Verify the round state and that the bet is on the correct contract. |
| `claimWinnings` reverts | Round not yet settled, bet already claimed, or caller did not win. | Wait for settlement confirmation in the UI. |
| BigInt / "cannot mix bigint" errors in frontend | UI branch mixing BigInt and Number. | Already fixed in shared history/ui modules; open an issue if a specific game still shows it. |
| E2E test fails at wallet step | Demo wallet not persisted, or backend faucet has no funds. | Check `backend.log` for faucet errors and ensure the backend is on Anvil with the default faucet key. |

## Support files

- `HANDOVER.md` — full design specification, game rules, wireframes, testing checklist.
- `CLAUDE.md` — contributor / AI assistant notes and common commands.
- `frontend/shared/how-it-works.js` — per-game help content used by the in-app modal.
