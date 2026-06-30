import { chromium } from 'playwright';

const BASE_URL = 'http://127.0.0.1:8090';

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // Capture console messages and errors
    const logs = [];
    page.on('console', msg => logs.push(`[console.${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));

    await page.goto(BASE_URL);
    await page.waitForTimeout(2000);

    // Screenshot 1: wallet modal should appear
    await page.screenshot({ path: '/Users/dindi/Documents/Code/web3_games/demo_test_1_modal.png' });

    // Click demo wallet button
    await page.click('#demoWalletBtn');
    await page.waitForTimeout(3000);

    // Screenshot 2: wallet connected with DEMO badge
    await page.screenshot({ path: '/Users/dindi/Documents/Code/web3_games/demo_test_2_connected.png' });

    const walletText = await page.locator('#walletAddress').textContent();
    const balanceText = await page.locator('#walletBalance').textContent();
    console.log('Wallet:', walletText);
    console.log('Balance:', balanceText);

    if (!walletText.includes('DEMO')) {
        throw new Error('Demo wallet not connected: ' + walletText);
    }

    // Place a bet: select UNDER (betType 1) and amount 0.01
    await page.click('.bet-type-btn[data-type="1"]');
    await page.fill('#betAmount', '0.01');
    await page.click('#placeBetBtn');

    // Wait for transaction confirmation (button text returns to Place Bet)
    await page.waitForFunction(() => {
        const btn = document.getElementById('placeBetBtn');
        return btn && !btn.disabled && btn.textContent === 'Place Bet';
    }, { timeout: 30000 });

    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/Users/dindi/Documents/Code/web3_games/demo_test_3_bet_placed.png' });

    // Verify a bet appears in Live Bets
    const liveBets = await page.locator('#recentBetsList .bet-item').count();
    console.log('Live bets count:', liveBets);

    if (liveBets === 0) {
        throw new Error('No live bets appeared after placing bet');
    }

    console.log('Demo wallet test passed');

    if (logs.length > 0) {
        console.log('--- Browser logs ---');
        logs.forEach(l => console.log(l));
    }

    await browser.close();
}

main().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
