"""Capture screenshots of running game pages."""

from playwright.sync_api import sync_playwright

BASE_URL = "http://127.0.0.1:8090"
PAGES = [
    ("", "casino_dice.png"),
    ("/color-duel", "casino_color_duel.png"),
    ("/crash", "casino_crash.png"),
    ("/plinko", "casino_plinko.png"),
]


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("dialog", lambda dialog: dialog.accept())

        for path, filename in PAGES:
            url = f"{BASE_URL}{path}"
            print(f"Capturing {url} -> {filename}")
            page.goto(url)
            page.wait_for_timeout(2000)

            # Connect demo wallet if button exists
            demo_btn = page.locator("#demoWalletBtn")
            if demo_btn.count() > 0 and demo_btn.is_visible():
                demo_btn.click()
                # wait for wallet info to appear
                page.wait_for_selector("#walletBalance", timeout=15000)
                page.wait_for_timeout(3000)

            page.screenshot(path=f"/Users/dindi/Documents/Code/web3_games/{filename}", full_page=True)
            print(f"Saved {filename}")

        browser.close()
        print("Done.")


if __name__ == "__main__":
    main()
