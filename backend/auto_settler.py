"""
Optional background auto-settler.

Calls settleRound() on any round whose resolution block has passed but has not yet
been settled or voided. This is a convenience for local/demo environments so the
UI actually shows outcomes without a manual settler or test bot.
"""

import asyncio
import logging
from pathlib import Path
from typing import Any

from eth_account import Account
from web3 import Web3
from web3.contract import Contract

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
ABI_DIR = ROOT / "contract" / "out" / "DiceGame.sol"


def _load_abi() -> list[dict[str, Any]]:
    abi_path = ABI_DIR / "DiceGame.json"
    if not abi_path.exists():
        raise FileNotFoundError(f"ABI not found at {abi_path}. Run `forge build` first.")
    with abi_path.open("r") as f:
        data = __import__("json").load(f)
    return data["abi"]


class AutoSettler:
    def __init__(
        self,
        rpc_url: str,
        contracts: dict[str, str],
        private_key: str,
        poll_interval: float = 3.0,
        enabled: bool = True,
    ):
        self.enabled = enabled and bool(private_key)
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.private_key = private_key
        self.poll_interval = poll_interval
        self.abi = _load_abi()
        self.account = Account.from_key(private_key) if private_key else None
        self.contracts: dict[str, Contract] = {}
        self.last_checked: dict[str, int] = {}

        for game_key, address in contracts.items():
            if not address or not Web3.is_address(address):
                logger.warning("AutoSettler skipping invalid address for %s: %s", game_key, address)
                continue
            checksum = Web3.to_checksum_address(address)
            self.contracts[game_key] = self.w3.eth.contract(address=checksum, abi=self.abi)
            self.last_checked[game_key] = 0

    async def run(self) -> None:
        if not self.enabled or not self.contracts:
            logger.info("Auto-settler disabled (no private key or no contracts)")
            return

        logger.info(
            "Auto-settler started for %d games using %s",
            len(self.contracts),
            self.account.address if self.account else "no account",
        )
        while True:
            await asyncio.sleep(self.poll_interval)
            try:
                await self._settle_all()
            except Exception as e:
                logger.exception("Auto-settler error: %s", e)

    async def _settle_all(self) -> None:
        for game_key, contract in self.contracts.items():
            try:
                current_round = contract.functions.currentRoundId().call()
                block_number = self.w3.eth.block_number
                last = self.last_checked[game_key]

                # Advance last_checked through rounds that are already closed.
                # Stop at the first round that is not yet settled/voided and not ready.
                # The current round is still open for betting, so we never process it here.
                new_last = last
                for rid in range(last, current_round):
                    r = contract.functions.rounds(rid).call()
                    settled = r[6]
                    voided = r[7]
                    res_block = r[0]

                    if settled or voided:
                        new_last = rid + 1
                        continue

                    if block_number <= res_block:
                        # Not ready yet; do not advance past this round.
                        break

                    total_pool = r[1]
                    if total_pool == 0:
                        # Empty closed rounds don't need a transaction; just skip them.
                        new_last = rid + 1
                        continue

                    tx_hash = await self._send_settle(contract, rid)
                    if tx_hash:
                        logger.info("Auto-settled %s round %s: %s", game_key, rid, tx_hash)
                        new_last = rid + 1

                self.last_checked[game_key] = new_last
            except Exception as e:
                logger.debug("Auto-settler failed for %s: %s", game_key, e)

    async def _send_settle(self, contract: Contract, round_id: int) -> str | None:
        if not self.account:
            return None
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self._send_settle_sync, contract, round_id)

    def _send_settle_sync(self, contract: Contract, round_id: int) -> str | None:
        address = self.account.address
        nonce = self.w3.eth.get_transaction_count(address)
        chain_id = self.w3.eth.chain_id

        # Estimate gas; fall back to a safe default.
        try:
            gas = contract.functions.settleRound(round_id).estimate_gas({"from": address})
            gas = int(gas * 1.2)
        except Exception:
            gas = 250_000

        tx = {
            "to": contract.address,
            "data": contract.functions.settleRound(round_id)._encode_transaction_data(),
            "gas": gas,
            "maxFeePerGas": self.w3.to_wei("10", "gwei"),
            "maxPriorityFeePerGas": self.w3.to_wei("1", "gwei"),
            "nonce": nonce,
            "chainId": chain_id,
            "type": 2,
        }

        # Use eip-1559 dynamic fee if available; otherwise fall back to gasPrice.
        try:
            block = self.w3.eth.get_block("latest")
            base_fee = block.get("baseFeePerGas")
            if base_fee is None:
                raise ValueError("no base fee")
        except Exception:
            tx.pop("maxFeePerGas", None)
            tx.pop("maxPriorityFeePerGas", None)
            tx["gasPrice"] = self.w3.to_wei("1", "gwei")
            tx.pop("type", None)

        signed = self.w3.eth.account.sign_transaction(tx, self.private_key)
        raw_tx = getattr(signed, "raw_transaction", getattr(signed, "rawTransaction", None))
        tx_hash = self.w3.eth.send_raw_transaction(raw_tx)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
        if receipt.status != 1:
            raise RuntimeError(f"settleRound {round_id} failed")
        return tx_hash.hex()
