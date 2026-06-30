import json
import time
from pathlib import Path

import requests
import yaml
from playwright.sync_api import sync_playwright
from web3 import Web3
from eth_account import Account

BASE_URL = "http://127.0.0.1:8090/color-duel"
ROOT = Path(__file__).resolve().parent

# Anvil default accounts (used only for local deterministic settlement)
BACKER_KEYS = [
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a0bf5b8211f4cd921b0f7e3e78a3b9c1f2518f7e5f0e3b6e3b5b5",
]
BACKER_BET_TYPES = [0, 2]  # RED and BLUE so at least one winner exists
BACKER_BET_ETH = 0.001


def load_config():
    with open(ROOT / "config.yaml") as f:
        return yaml.safe_load(f)


def place_backer_bets(config, demo_address):
    """Place bets on the other two colors from funded backer accounts.

    This guarantees at least one winner, so the round settles immediately
    instead of carrying over repeatedly.
    """
    rpc = config["rpc_http_url"]
    address = Web3.to_checksum_address(config["contracts"]["color-duel"])
    faucet_key = config["faucet"]["private_key"]
    abi = requests.get(f"http://127.0.0.1:{config['port']}/api/abi/color-duel").json()

    w3 = Web3(Web3.HTTPProvider(rpc))
    contract = w3.eth.contract(address=address, abi=abi)
    faucet = Account.from_key(faucet_key)

    # Fund the backer accounts from the faucet account
    for key in BACKER_KEYS:
        acct = Account.from_key(key)
        bal = w3.eth.get_balance(acct.address)
        if bal < w3.to_wei(0.005, "ether"):
            tx = {
                "to": acct.address,
                "value": w3.to_wei(0.01, "ether"),
                "gas": 21000,
                "gasPrice": w3.to_wei("1", "gwei"),
                "nonce": w3.eth.get_transaction_count(faucet.address, "pending"),
                "chainId": config["chain_id"],
            }
            signed = w3.eth.account.sign_transaction(tx, faucet_key)
            raw = getattr(signed, "raw_transaction", getattr(signed, "rawTransaction", None))
            tx_hash = w3.eth.send_raw_transaction(raw)
            w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)

    # Place a small bet on RED and BLUE so the round always has a winner
    current_round = contract.functions.currentRoundId().call()
    for key, bet_type in zip(BACKER_KEYS, BACKER_BET_TYPES):
        acct = Account.from_key(key)
        tx = contract.functions.placeBet(bet_type, 0).build_transaction({
            "from": acct.address,
            "value": w3.to_wei(BACKER_BET_ETH, "ether"),
            "gas": 300000,
            "gasPrice": w3.to_wei("1", "gwei"),
            "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
            "chainId": config["chain_id"],
        })
        signed = w3.eth.account.sign_transaction(tx, key)
        raw = getattr(signed, "raw_transaction", getattr(signed, "rawTransaction", None))
        tx_hash = w3.eth.send_raw_transaction(raw)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=30)
        if receipt.status != 1:
            raise RuntimeError(f"Backer bet failed for {acct.address}")
        print(f"Backer bet placed: round={current_round} type={bet_type} from {acct.address}")


def main():
    config = load_config()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        logs = []
        page.on("console", lambda msg: logs.append(f"[console.{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: logs.append(f"[pageerror] {err.message}"))
        page.on("dialog", lambda dialog: dialog.accept())

        page.goto(BASE_URL)
        page.wait_for_timeout(2000)

        page.screenshot(path=str(ROOT / "color_duel_test_1_loaded.png"))
        page.click("#demoWalletBtn")
        page.wait_for_timeout(3000)

        page.screenshot(path=str(ROOT / "color_duel_test_2_connected.png"))

        wallet_text = page.locator("#walletAddress").text_content()
        balance_text = page.locator("#walletBalance").text_content()
        print("Wallet:", wallet_text)
        print("Balance:", balance_text)
        assert "DEMO" in wallet_text, f"Demo wallet not connected: {wallet_text}"

        # Pick GREEN (bet type 1)
        page.click('.bet-type-btn[data-type="1"]')
        page.fill("#betAmount", "0.01")
        page.wait_for_timeout(500)

        print("Before bet - disabled:", page.locator("#placeBetBtn").is_disabled())
        page.click("#placeBetBtn")

        page.wait_for_selector("#recentBetsList .bet-item", timeout=30000)
        page.wait_for_timeout(2000)
        page.screenshot(path=str(ROOT / "color_duel_test_3_bet_placed.png"))

        live_bets = page.locator("#recentBetsList .bet-item").count()
        print("Live bets count:", live_bets)
        assert live_bets > 0, "No live bets appeared after placing bet"

        try:
            page.wait_for_selector("#myBetsList .my-bet:not(:has-text('No active bets.'))", timeout=8000)
            my_bets_count = page.locator("#myBetsList .my-bet").count()
            print("My bets count:", my_bets_count)
        except Exception:
            print("My bets not populated yet (can be ignored if live bet succeeded)")

        # Add backer bets on the other colors to force a winner
        demo_address = page.locator("#walletAddress").text_content().split()[1].rstrip("Demo")
        place_backer_bets(config, demo_address)

        print("Waiting for round settlement...")
        settled = page.wait_for_function(
            """
            () => {
                const txt = document.getElementById('outcomeText')?.textContent?.trim();
                const hasOutcome = txt && txt.includes('WINS');
                if (hasOutcome) return {txt};
                return null;
            }
            """,
            timeout=35000,
        )

        result = settled.json_value()
        outcome = result.get("txt", "")
        print("Outcome:", outcome)
        assert outcome, "No outcome text shown after settlement"
        assert any(c in outcome for c in ["RED", "GREEN", "BLUE"]), f"Unexpected outcome: {outcome}"

        page.screenshot(path=str(ROOT / "color_duel_test_4_settled.png"))

        # My Bets should now show Won or Lost
        page.wait_for_function(
            """
            () => {
                const txt = document.querySelector('#myBetsList .my-bet-status')?.textContent?.trim();
                if (txt && (txt.includes('Won') || txt.includes('Lost'))) return {txt};
                return null;
            }
            """,
            timeout=10000,
        )
        bet_status = page.locator("#myBetsList .my-bet-status").first.text_content().strip()
        print("My bet status:", bet_status)
        assert any(s in bet_status for s in ["Won", "Lost"]), f"Unexpected bet status: {bet_status}"

        page.wait_for_timeout(1500)
        page.screenshot(path=str(ROOT / "color_duel_test_5_final.png"))

        print("Color Duel test passed")

        if logs:
            print("--- Browser logs ---")
            for log in logs:
                print(log)

        browser.close()


if __name__ == "__main__":
    main()
