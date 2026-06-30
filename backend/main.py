"""
FastAPI backend for the parimutuel gambling platform.

Responsibilities:
1. Serve the frontend (index.html + static files)
2. WebSocket endpoint /ws/pool — pushes real-time contract events
3. Optional convenience endpoints for reading contract state

NO business logic. NO database. The contract is the source of truth.
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from eth_account import Account
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from web3 import Web3

from backend.auto_settler import AutoSettler
from backend.config import CONFIG
from backend.contract_listener import ContractListener
from backend.game_configs import GAME_CONFIGS

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
ABI_DIR = ROOT / "contract" / "out"

# Map game keys to the contract ABI file that exposes the shared ParimutuelGame interface.
ABI_FILE_MAP = {
    "dice": ABI_DIR / "DiceGame.sol" / "DiceGame.json",
    "color-duel": ABI_DIR / "ColorDuelGame.sol" / "ColorDuelGame.json",
    "crash": ABI_DIR / "CrashGame.sol" / "CrashGame.json",
    "plinko": ABI_DIR / "PlinkoGame.sol" / "PlinkoGame.json",
    "roulette": ABI_DIR / "RouletteGame.sol" / "RouletteGame.json",
    "coin-flip": ABI_DIR / "CoinFlipStreakGame.sol" / "CoinFlipStreakGame.json",
    "slots": ABI_DIR / "SlotsGame.sol" / "SlotsGame.json",
    "horse-race": ABI_DIR / "HorseRaceGame.sol" / "HorseRaceGame.json",
    "keno": ABI_DIR / "KenoGame.sol" / "KenoGame.json",
    "block-bingo": ABI_DIR / "BlockBingoGame.sol" / "BlockBingoGame.json",
    "minefield": ABI_DIR / "MinefieldGame.sol" / "MinefieldGame.json",
}


def _abi_path_for_game(game: str) -> Path:
    abi_path = ABI_FILE_MAP.get(game)
    if abi_path and abi_path.exists():
        return abi_path
    # Fallback to DiceGame ABI; all games share the same external interface.
    fallback = ABI_DIR / "DiceGame.sol" / "DiceGame.json"
    if fallback.exists():
        return fallback
    raise FileNotFoundError("ABI not found. Run `forge build` first.")


class ConnectionManager:
    """Manages WebSocket connections grouped by game key."""

    def __init__(self):
        # game_key -> set of WebSocket connections
        self.connections: dict[str, set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, game: str):
        await websocket.accept()
        self.connections.setdefault(game, set()).add(websocket)
        logger.info("Client connected to %s (total: %d)", game, len(self.connections[game]))

    def disconnect(self, websocket: WebSocket, game: str):
        self.connections.get(game, set()).discard(websocket)
        logger.info("Client disconnected from %s", game)

    async def broadcast(self, game: str, message: dict[str, Any]):
        clients = self.connections.get(game)
        if not clients:
            return
        dead = []
        for ws in clients:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            clients.discard(ws)


manager = ConnectionManager()
listener_task: asyncio.Task | None = None
settler_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global listener_task, settler_task
    listener = ContractListener(
        rpc_url=CONFIG["rpc_http_url"],
        contracts=CONFIG.get("contracts", {}),
        broadcast=manager.broadcast,
        poll_interval=1.0,
    )
    listener_task = asyncio.create_task(listener.listen())

    settler = AutoSettler(
        rpc_url=CONFIG["rpc_http_url"],
        contracts=CONFIG.get("contracts", {}),
        private_key=CONFIG.get("faucet", {}).get("private_key", ""),
        poll_interval=float(CONFIG.get("auto_settle_interval", 3.0)),
        enabled=bool(CONFIG.get("auto_settle", False)),
    )
    settler_task = asyncio.create_task(settler.run())

    yield
    for task in (listener_task, settler_task):
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# ─── API ───
@app.get("/", response_class=HTMLResponse)
async def index():
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/color-duel", response_class=HTMLResponse)
async def color_duel_page():
    return FileResponse(FRONTEND_DIR / "color-duel.html")


@app.get("/crash", response_class=HTMLResponse)
async def crash_page():
    return FileResponse(FRONTEND_DIR / "crash.html")


@app.get("/plinko", response_class=HTMLResponse)
async def plinko_page():
    return FileResponse(FRONTEND_DIR / "plinko.html")


@app.get("/roulette", response_class=HTMLResponse)
async def roulette_page():
    return FileResponse(FRONTEND_DIR / "roulette.html")


@app.get("/coin-flip", response_class=HTMLResponse)
async def coin_flip_page():
    return FileResponse(FRONTEND_DIR / "coin-flip.html")


@app.get("/slots", response_class=HTMLResponse)
async def slots_page():
    return FileResponse(FRONTEND_DIR / "slots.html")


@app.get("/horse-race", response_class=HTMLResponse)
async def horse_race_page():
    return FileResponse(FRONTEND_DIR / "horse-race.html")


@app.get("/keno", response_class=HTMLResponse)
async def keno_page():
    return FileResponse(FRONTEND_DIR / "keno.html")


@app.get("/block-bingo", response_class=HTMLResponse)
async def block_bingo_page():
    return FileResponse(FRONTEND_DIR / "block-bingo.html")


@app.get("/minefield", response_class=HTMLResponse)
async def minefield_page():
    return FileResponse(FRONTEND_DIR / "minefield.html")


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "network": CONFIG["network"],
        "chain_id": CONFIG["chain_id"],
        "games": list(CONFIG.get("contracts", {}).keys()),
    }


@app.get("/api/config")
async def get_config():
    return {
        "network": CONFIG["network"],
        "chain_id": CONFIG["chain_id"],
        "contracts": CONFIG.get("contracts", {}),
        "games": GAME_CONFIGS,
    }


@app.get("/api/abi/{game}")
async def get_abi(game: str):
    try:
        abi_path = _abi_path_for_game(game)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    with abi_path.open("r") as f:
        return JSONResponse(content=json.load(f)["abi"])


@app.get("/api/{game}/round")
async def get_round(game: str, round_id: int | None = None):
    address = CONFIG.get("contracts", {}).get(game)
    if not address:
        raise HTTPException(status_code=404, detail="game not configured")

    w3 = Web3(Web3.HTTPProvider(CONFIG["rpc_http_url"]))
    with _abi_path_for_game(game).open("r") as f:
        abi = json.load(f)["abi"]
    contract = w3.eth.contract(address=Web3.to_checksum_address(address), abi=abi)

    rid = round_id if round_id is not None else contract.functions.currentRoundId().call()
    round_data = contract.functions.rounds(rid).call()
    return {
        "roundId": rid,
        "resolutionBlock": round_data[0],
        "totalPool": round_data[1],
        "totalWinningBets": round_data[2],
        "winningOutcome": round_data[3],
        "prizePool": round_data[4],
        "carryOverCount": round_data[5],
        "settled": round_data[6],
        "voided": round_data[7],
        "hasWinners": round_data[8],
    }


class FaucetRequest(BaseModel):
    address: str


@app.get("/api/faucet/amount")
async def faucet_amount():
    """Return the configured faucet drip amount."""
    faucet_cfg = CONFIG.get("faucet", {})
    return {
        "amountWei": int(faucet_cfg.get("amount_wei", 10**17)),
        "maxDrip": int(faucet_cfg.get("max_drip_per_request", 10**17)),
    }


@app.post("/api/faucet")
async def faucet(req: FaucetRequest):
    """Send demo ETH to the provided address. Only enabled for test networks."""
    faucet_cfg = CONFIG.get("faucet", {})
    private_key = faucet_cfg.get("private_key")
    amount_wei = int(faucet_cfg.get("amount_wei", 10**17))
    max_drip = int(faucet_cfg.get("max_drip_per_request", 10**17))

    if not private_key:
        raise HTTPException(status_code=503, detail="Faucet not configured")
    if CONFIG.get("network") == "base-mainnet":
        raise HTTPException(status_code=403, detail="Faucet disabled on mainnet")
    if amount_wei > max_drip:
        raise HTTPException(status_code=400, detail="Requested amount exceeds max drip")

    try:
        target = Web3.to_checksum_address(req.address)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid address: {e}")

    w3 = Web3(Web3.HTTPProvider(CONFIG["rpc_http_url"]))
    account = Account.from_key(private_key)

    try:
        # Use pending nonce so parallel drips don't collide; bump fee to replace stuck txs.
        nonce = w3.eth.get_transaction_count(account.address, "pending")
        tx = {
            "to": target,
            "value": amount_wei,
            "gas": 21000,
            "maxFeePerGas": w3.to_wei("100", "gwei"),
            "maxPriorityFeePerGas": w3.to_wei("2", "gwei"),
            "nonce": nonce,
            "chainId": CONFIG["chain_id"],
            "type": 2,
        }
        signed = w3.eth.account.sign_transaction(tx, private_key)
        raw_tx = getattr(signed, "raw_transaction", getattr(signed, "rawTransaction", None))
        tx_hash = w3.eth.send_raw_transaction(raw_tx)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
        return {
            "status": "ok",
            "txHash": tx_hash.hex(),
            "amountWei": amount_wei,
            "blockNumber": receipt.blockNumber,
        }
    except Exception as e:
        logger.exception("Faucet failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Faucet failed: {e}")


@app.websocket("/ws/pool")
async def pool_ws(websocket: WebSocket, game: str = Query("dice")):
    await manager.connect(websocket, game)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, game)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "backend.main:app",
        host=CONFIG["host"],
        port=CONFIG["port"],
        reload=False,
        log_level="info",
    )
