from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:8090"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        logs = []
        page.on("console", lambda msg: logs.append(f"[console.{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: logs.append(f"[pageerror] {err.message}"))
        page.on("dialog", lambda dialog: dialog.accept())

        page.goto(BASE_URL)
        page.wait_for_timeout(2000)

        page.screenshot(path="/Users/dindi/Documents/Code/web3_games/demo_test_1_modal.png")

        page.click("#demoWalletBtn")
        page.wait_for_timeout(5000)

        page.screenshot(path="/Users/dindi/Documents/Code/web3_games/demo_test_2_connected.png")

        wallet_text = page.locator("#walletAddress").text_content()
        balance_text = page.locator("#walletBalance").text_content()
        print("Wallet:", wallet_text)
        print("Balance:", balance_text)
        assert "DEMO" in wallet_text, f"Demo wallet not connected: {wallet_text}"

        page.click('.bet-type-btn[data-type="1"]')
        page.fill("#betAmount", "0.01")
        page.wait_for_timeout(500)

        print("Before bet - disabled:", page.locator("#placeBetBtn").is_disabled())
        page.click("#placeBetBtn")

        # Wait for live bet to appear via WebSocket
        page.wait_for_selector("#recentBetsList .bet-item", timeout=30000)
        page.wait_for_timeout(2000)

        page.screenshot(path="/Users/dindi/Documents/Code/web3_games/demo_test_3_bet_placed.png")

        live_bets = page.locator("#recentBetsList .bet-item").count()
        print("Live bets count:", live_bets)
        assert live_bets > 0, "No live bets appeared after placing bet"

        # My Bets may take a poll cycle to refresh; wait up to 8 seconds
        try:
            page.wait_for_selector("#myBetsList .my-bet:not(:has-text('No bets yet.')):not(:has-text('Loading your bets')):not(:has-text('Connect wallet'))", timeout=8000)
            my_bets_count = page.locator("#myBetsList .my-bet").count()
            print("My bets count:", my_bets_count)
        except Exception:
            print("My bets not populated yet (can be ignored if live bet succeeded)")

        # Wait for the round to close and auto-settle (5 blocks * 2s + settler interval)
        print("Waiting for round settlement...")
        settled = page.wait_for_function(
            """
            () => {
                const num = document.getElementById('diceResult')?.textContent?.trim();
                const txt = document.getElementById('outcomeText')?.textContent?.trim();
                const isNumber = /^\\d+$/.test(num) && num !== '••';
                const hasOutcome = txt && (txt.includes('WINS') || txt.includes('DEAD ZONE'));
                if (isNumber && hasOutcome) {
                    return {num, txt};
                }
                return null;
            }
            """,
            timeout=35000,
        )

        import re
        result = settled.json_value()
        dice_number = result.get("num", "")
        outcome = result.get("txt", "")
        print("Outcome:", outcome)
        print("Dice number:", dice_number)
        assert outcome, "No outcome text shown after settlement"
        assert re.match(r"^\d+$", dice_number), f"Dice result not a number: {dice_number}"

        # My Bets should now show Won or Lost
        try:
            bet_status = page.wait_for_function(
                """
                () => {
                    const el = document.querySelector('#myBetsList .my-bet-status');
                    if (!el) return null;
                    const txt = el.textContent?.trim() || '';
                    if (/\\b(Won|Lost|Dead zone)\\b/i.test(txt)) return txt;
                    return null;
                }
                """,
                timeout=15000,
            ).json_value()
        except Exception:
            actual = page.locator("#myBetsList").first.inner_html()
            print("Timed out waiting for status. myBetsList HTML:", actual[:1000])
            raise
        print("My bet status:", bet_status)
        assert any(s in bet_status for s in ["Won", "Lost", "Dead zone"]), f"Unexpected bet status: {bet_status}"

        page.wait_for_timeout(1500)
        page.screenshot(path="/Users/dindi/Documents/Code/web3_games/demo_test_4_settled.png")

        print("Demo wallet test passed")

        if logs:
            print("--- Browser logs ---")
            for log in logs:
                print(log)

        browser.close()


if __name__ == "__main__":
    main()
