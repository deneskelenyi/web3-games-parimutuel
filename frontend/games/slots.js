import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, claimWinnings, claimRefund, getMyBets, appConfig } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const display = document.getElementById('slotsDisplay');
const outcomeText = document.getElementById('outcomeText');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const symbolInput = document.getElementById('symbolValue');
const placeBetBtn = document.getElementById('placeBetBtn');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'cyan', 'pink', 'gold'];

let selectedBetType = null;
let currentRoundId = null;
let spinInterval = null;

async function init() {
    await loadConfig();
    setTargetChain(appConfig.chain_id);
    await initContracts();
    setActiveTab('slots');
    setGame('slots');

    renderChips();
    setupListeners();
    refreshState();
    setInterval(refreshState, 3000);
    setInterval(refreshMyBets, 5000);

    if (!getAddress() && document.getElementById('walletModal')) {
        document.getElementById('walletModal').style.display = 'flex';
    }

    window.addEventListener('wallet:connected', () => {
        refreshBalance();
        refreshMyBets();
        updatePlaceBetButton();
    });
    window.addEventListener('wallet:disconnected', () => {
        updatePlaceBetButton();
        if (document.getElementById('walletModal')) document.getElementById('walletModal').style.display = 'flex';
    });

    window.addEventListener('game:state', (e) => {
        currentRoundId = Number(e.detail.roundId);
        updateRoundVisuals(e.detail);
        updatePlaceBetButton();
    });
    window.addEventListener('game:event', (e) => {
        const d = e.detail;
        if (d.type === 'RoundSettled') revealOutcome(d.args);
        if (['RoundSettled','RoundCarriedOver','RoundVoided','BetPlaced'].includes(d.type)) refreshMyBets();
    });

    startSpinning();
}

function renderChips() {
    chipRow.innerHTML = '';
    CHIPS.forEach((val, idx) => {
        const chip = document.createElement('button');
        chip.className = `chip ${CHIP_COLORS[idx]}`;
        chip.textContent = val < 1 ? val * 1000 + 'k' : val + '';
        chip.title = val + ' ETH';
        chip.addEventListener('click', () => { betAmountInput.value = val; updatePlaceBetButton(); });
        chipRow.appendChild(chip);
    });
}

function setupListeners() {
    betTypeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            betTypeBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedBetType = Number(btn.dataset.type);
            updatePlaceBetButton();
        });
    });
    symbolInput.addEventListener('input', () => {
        let v = parseInt(symbolInput.value, 10);
        if (isNaN(v)) v = 0;
        if (v < 0) v = 0;
        if (v > 7) v = 7;
        symbolInput.value = v;
    });
    betAmountInput.addEventListener('input', updatePlaceBetButton);

    placeBetBtn.addEventListener('click', async () => {
        if (selectedBetType === null) return;
        const amount = parseFloat(betAmountInput.value);
        if (!amount || amount <= 0) return;
        const betValue = parseInt(symbolInput.value, 10) || 0;

        placeBetBtn.disabled = true;
        placeBetBtn.textContent = 'Placing...';
        try {
            await placeBet('slots', selectedBetType, betValue, amount);
            betAmountInput.value = '';
            selectedBetType = null;
            betTypeBtns.forEach(b => b.classList.remove('selected'));
            clearOutcome();
            await refreshMyBets();
        } catch (e) {
            console.error(e);
            alert(e?.reason || e?.message || 'Bet failed');
        } finally {
            updatePlaceBetButton();
            placeBetBtn.textContent = 'Place Bet';
        }
    });
}

function updatePlaceBetButton() {
    const amount = parseFloat(betAmountInput.value);
    const addr = getAddress();
    const state = latestState;
    const now = state ? Number(state.blockNumber) : 0;
    const resolution = state ? Number(state.resolutionBlock) : 0;
    const bettingOpen = !resolution || now < resolution;

    let reason = '';
    if (!addr) reason = 'Connect wallet to bet';
    else if (selectedBetType === null) reason = 'Pick a bet type';
    else if (!amount || amount <= 0) reason = 'Enter bet amount';
    else if (!bettingOpen) reason = 'Round closing — wait for next round';

    const canBet = selectedBetType !== null && amount > 0 && addr && bettingOpen;
    placeBetBtn.disabled = !canBet;
    placeBetBtn.title = reason;

    const existing = document.getElementById('betStatusHint');
    if (existing) existing.remove();
    if (reason) {
        const hint = document.createElement('div');
        hint.id = 'betStatusHint';
        hint.style.cssText = 'font-size:12px;color:var(--text-secondary);text-align:center;margin-top:8px;';
        hint.textContent = reason;
        placeBetBtn.parentElement.appendChild(hint);
    }
}

function updateRoundVisuals(state) {
    if (!state) return;
    const now = Number(state.blockNumber);
    const resolution = Number(state.resolutionBlock);
    const blocksLeft = resolution ? Math.max(0, resolution - now) : 0;
    if (state.settled && !state.voided) {
        showOutcome(Number(state.winningOutcome));
        showBanner('Round settled', 'settled');
        stopSpinning();
    } else if (blocksLeft === 0) {
        showBanner('Round closing — awaiting settlement', 'closing');
        stopSpinning();
    } else {
        showBanner(`Live — ${blocksLeft} block${blocksLeft === 1 ? '' : 's'} left`, 'live');
        startSpinning();
    }
}

function startSpinning() {
    if (spinInterval) return;
    display.textContent = '🎰';
    const symbols = ['🍒','🍋','🍇','🔔','💎','7️⃣','⭐','🃏'];
    spinInterval = setInterval(() => {
        display.textContent = symbols[Math.floor(Math.random()*symbols.length)] + ' ' +
                              symbols[Math.floor(Math.random()*symbols.length)] + ' ' +
                              symbols[Math.floor(Math.random()*symbols.length)];
    }, 120);
}
function stopSpinning() { if (spinInterval) { clearInterval(spinInterval); spinInterval = null; } }
function clearOutcome() { display.textContent = '🎰'; outcomeText.textContent = ''; }

function revealOutcome(args) {
    stopSpinning();
    const o = BigInt(args.winningOutcome);
    const s1 = Number((o >> 8n) & 0xFn);
    const s2 = Number((o >> 4n) & 0xFn);
    const s3 = Number(o & 0xFn);
    display.textContent = `${s1} ${s2} ${s3}`;
    outcomeText.textContent = `REELS: ${s1} • ${s2} • ${s3}`;
    showBanner(`Round #${args.roundId} settled`, 'settled');

    const addr = getAddress();
    if (addr) getMyBets('slots', Number(args.roundId), addr).then(bets => {
        if (!bets.length) return;
        if (bets.some(b => !b.claimed && isWinningBet(b, Number(o)))) refreshMyBets();
    }).catch(console.error);
}

function isWinningBet(bet, outcome) {
    const t = Number(bet.betType);
    const v = Number(bet.betValue);
    const s1 = Number((outcome >> 8) & 0xF);
    const s2 = Number((outcome >> 4) & 0xF);
    const s3 = Number(outcome & 0xF);
    if (t === 0) return s1 === v && s2 === v && s3 === v;
    if (t === 1) return s1 === s2 && s2 === s3;
    if (t === 2) return [s1,s2,s3].filter(x => x === v).length >= 2;
    if (t === 3) return s1 === v;
    return false;
}

function showBanner(text, mood) {
    if (!roundStatusBanner) return;
    roundStatusBanner.textContent = text;
    roundStatusBanner.className = 'round-status-banner show ' + mood;
}

async function refreshState() {
    if (!appConfig) return null;
    try {
        const state = await getRoundState('slots');
        if (state) { currentRoundId = state.roundId; return state; }
    } catch (e) { console.error('refreshState error', e); }
    return null;
}

async function refreshMyBets() {
    await renderHistory('myBetsList', getAddress(), 'slots');
}

init();
