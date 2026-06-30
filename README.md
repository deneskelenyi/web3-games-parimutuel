# Parimutuel On-Chain Casino

A **minimum viable product (MVP)** for blockchain / Web3 gambling games. This repo was built to explore how a fully on-chain parimutuel betting platform could work, which game mechanics fit the model, and what a real-time frontend experience feels like when the smart contract is the single source of truth.

It is **not** a production casino. It is a working end-to-end prototype on Ethereum L2 (Base / Anvil) that demonstrates the full lifecycle: deposit → bet → on-chain RNG → settlement → claim winnings.

## What this MVP proves

- **Parimutuel betting on-chain:** all bets for a round go into one shared pool, the house takes a configured cut, and winners split the rest proportionally.
- **No house risk:** the contract never pays out more than the pool it holds.
- **Jackpot carry-over:** rounds with no winners roll their prize pool into a global jackpot for the next winning round.
- **Provably fair RNG:** outcomes are derived from the settlement block hash.
- **Pull payments:** winners claim individually; settlement never iterates over all bettors.
- **Real-time UX:** a vanilla-JS frontend receives live events over WebSocket from a thin FastAPI relay.
- **Demo wallet mode:** visitors without MetaMask can try the dApp using a browser-generated wallet funded by a backend faucet.

## Games implemented

1. **Dice Over/Under** — bet on 1–98 over or under a target, avoid the dead zone.
2. **Color Duel** — pick Red vs Blue in a weighted duel.
3. **Crash** — cash-out multiplier betting.
4. **Plinko** — bin-based ball drop.
5. **Roulette** — single-number and color bets.
6. **Coin Flip Streak** — bet on consecutive heads/tails outcomes.
7. **Slots** — three-reel symbol matching.
8. **Horse Race** — pick the winning horse.
9. **Keno** — choose numbers and match the draw.
10. **Block Bingo** — bingo card matched against drawn numbers.
11. **Minefield** — pick safe tiles on a grid.

Only the first game (Dice) was used as the reference implementation; the same base contract and UI patterns were extended to the others.

## Tech stack

| Layer | Technology |
|---|---|
| Smart contracts | Solidity ^0.8.24, OpenZeppelin v5, Foundry |
| Backend | Python, FastAPI, Web3.py, WebSocket |
| Frontend | Vanilla JavaScript, ethers.js v6, MetaMask |
| Chain | Base L2 / local Anvil |

## Repository layout

```
contract/           # Foundry project: base + 11 game contracts, tests, deploy script
backend/            # FastAPI app: static server, WebSocket relay, auto-settler
frontend/           # Vanilla JS single-page app: shared modules + per-game pages
config.yaml         # Runtime configuration (RPC, addresses, faucet)
config.example.yaml # Sanitized template for config.yaml
INSTALLATION.md     # Full install, deploy, and operations guide
HANDOVER.md         # Design specification and game rules
start.sh            # One-command local launch: Anvil + deploy + backend
```

## Quick start

The fastest way to run locally is the provided launch script:

```bash
cd /Users/dindi/Documents/Code/web3_games
./start.sh
```

Then open **http://localhost:8090**, connect a wallet, and place a bet.

For manual setup, testnet deployment, and production notes, see **[INSTALLATION.md](INSTALLATION.md)**.

## Important notes

- **Native ETH only.** The platform intentionally avoids ERC-20 tokens to keep the UX simple.
- **Local defaults are permissive.** `start.sh` sets `minPool=0`, `minBettors=1`, and a 1 ETH demo faucet for easy testing.
- **Do not use the Anvil default key on mainnet.** The example faucet key is the well-known Anvil test key; replace it before deploying anywhere real.
- **RNG is blockhash-based.** Suitable for a local/testnet demo; a production version should integrate a VRF or oracle.

## Status

This is an **MVP / research prototype**. It proves the architecture and game catalog but is not audited, not licensed for real-money gambling, and not intended for production deployment without significant hardening.
