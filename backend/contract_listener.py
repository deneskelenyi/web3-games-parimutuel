"""
Thin contract event listener. Polls the RPC for new logs and pushes them
to connected frontend clients via a broadcast callback.
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Callable

from web3 import Web3
from web3.contract import Contract

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
ABI_DIR = ROOT / "contract" / "out" / "DiceGame.sol"  # shared interface across all games

EVENTS = [
    "BetPlaced",
    "RoundSettled",
    "RoundVoided",
    "RoundCarriedOver",
    "WinningsClaimed",
    "RefundClaimed",
    "JackpotUpdated",
    "HouseCutCollected",
]


def _load_abi() -> list[dict[str, Any]]:
    abi_path = ABI_DIR / "DiceGame.json"
    if not abi_path.exists():
        raise FileNotFoundError(f"ABI not found at {abi_path}. Run `forge build` first.")
    with abi_path.open("r") as f:
        data = json.load(f)
    return data["abi"]


class ContractListener:
    def __init__(
        self,
        rpc_url: str,
        contracts: dict[str, str],
        broadcast: Callable[[str, dict[str, Any]], None],
        poll_interval: float = 1.0,
    ):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.broadcast = broadcast
        self.poll_interval = poll_interval
        self.abi = _load_abi()
        self.contracts: dict[str, Contract] = {}
        self.last_blocks: dict[str, int] = {}
        self.event_topics: dict[str, dict[str, str]] = {}

        # Build topic mapping from ABI once.
        abi_by_name = {entry["name"]: entry for entry in self.abi if entry.get("type") == "event"}

        for game_key, address in contracts.items():
            if not address or not Web3.is_address(address):
                logger.warning("Skipping invalid contract address for %s: %s", game_key, address)
                continue
            checksum = Web3.to_checksum_address(address)
            contract = self.w3.eth.contract(address=checksum, abi=self.abi)
            self.contracts[game_key] = contract
            self.last_blocks[game_key] = self.w3.eth.block_number

            topics: dict[str, str] = {}
            for event_name in EVENTS:
                entry = abi_by_name.get(event_name)
                if not entry:
                    logger.warning("ABI entry not found for %s", event_name)
                    continue
                try:
                    inputs = ",".join(i["type"] for i in entry.get("inputs", []))
                    sig = f"{event_name}({inputs})"
                    topic = Web3.keccak(text=sig).hex()
                    topics[topic] = event_name
                except Exception as e:
                    logger.warning("Could not compute topic for %s: %s", event_name, e)
            self.event_topics[game_key] = topics

    async def listen(self) -> None:
        logger.info("Starting contract listener with %d games", len(self.contracts))
        while True:
            await asyncio.sleep(self.poll_interval)
            try:
                await self._poll_all()
            except Exception as e:
                logger.exception("Listener poll error: %s", e)

    async def _poll_all(self) -> None:
        for game_key, contract in self.contracts.items():
            from_block = self.last_blocks[game_key] + 1
            to_block = self.w3.eth.block_number

            if to_block >= from_block:
                try:
                    logs = self.w3.eth.get_logs({
                        "fromBlock": from_block,
                        "toBlock": to_block,
                        "address": contract.address,
                    })
                    for log in logs:
                        topic0 = log["topics"][0].hex()
                        event_name = self.event_topics[game_key].get(topic0)
                        if not event_name:
                            continue
                        try:
                            event = getattr(contract.events, event_name)
                            decoded = event().process_log(log)
                            await self._broadcast_event(game_key, event_name, decoded)
                        except Exception as e:
                            logger.debug("Failed to decode %s log: %s", event_name, e)
                except Exception as e:
                    logger.debug("get_logs failed for %s: %s", game_key, e)

                self.last_blocks[game_key] = to_block

            # Broadcast current round state as a lightweight heartbeat
            await self._broadcast_state(game_key, contract)

    async def _broadcast_event(self, game_key: str, event_name: str, entry: Any) -> None:
        args = entry.args.__dict__ if hasattr(entry.args, "__dict__") else dict(entry.args)
        message = {
            "type": event_name,
            "blockNumber": entry.blockNumber,
            "transactionHash": entry.transactionHash.hex(),
            "args": args,
        }
        await self.broadcast(game_key, message)
        logger.debug("Broadcast %s: %s", event_name, message)

    async def _broadcast_state(self, game_key: str, contract: Contract) -> None:
        try:
            round_id = contract.functions.currentRoundId().call()
            round_data = contract.functions.rounds(round_id).call()
            jackpot = contract.functions.jackpot().call()
            message = {
                "type": "State",
                "roundId": str(round_id),
                "resolutionBlock": round_data[0],
                "totalPool": round_data[1],
                "totalWinningBets": round_data[2],
                "winningOutcome": round_data[3],
                "prizePool": round_data[4],
                "carryOverCount": round_data[5],
                "settled": round_data[6],
                "voided": round_data[7],
                "hasWinners": round_data[8],
                "jackpot": jackpot,
                "blockNumber": self.w3.eth.block_number,
            }
            await self.broadcast(game_key, message)
        except Exception as e:
            logger.debug("State broadcast failed for %s: %s", game_key, e)
