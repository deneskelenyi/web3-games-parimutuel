import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, getMyBets, appConfig } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const display = document.getElementById('mineDisplay');
const mineGrid = document.getElementById('mineGrid');
const outcomeText = document.getElementById('outcomeText');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const placeBetBtn = document.getElementById('placeBetBtn');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'cyan', 'pink', 'gold'];

let selectedBetType = null;
let selectedCell = null;
let currentRoundId = null;
let pulseInterval = null;

async function init() {
    await loadConfig();
    setTargetChain(appConfig.chain_id);
    await initContracts();
    setActiveTab('minefield');
    setGame('minefield');

    renderChips();
    renderGrid();
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

    startPulsing();
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

function renderGrid() {
    mineGrid.innerHTML = '';
    for (let c = 0; c < 25; c++) {
        const btn = document.createElement('button');
        btn.className = 'mine-cell';
        btn.textContent = c;
        btn.dataset.cell = c;
        btn.style.cssText = 'width:44px;height:44px;border-radius:8px;background:rgba(0,0,0,0.25);border:1px solid var(--border);color:var(--text-primary);font-weight:700;cursor:pointer;';
        btn.addEventListener('click', () => selectCell(c, btn));
        mineGrid.appendChild(btn);
    }
}

function selectCell(c, btn) {
    document.querySelectorAll('.mine-cell').forEach(b => { b.style.background = 'rgba(0,0,0,0.25)'; b.style.borderColor = 'var(--border)'; });
    selectedCell = c;
    btn.style.background = 'rgba(0,210,255,0.25)';
    btn.style.borderColor = '#00d2ff';
    updatePlaceBetButton();
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
    betAmountInput.addEventListener('input', updatePlaceBetButton);

    placeBetBtn.addEventListener('click', async () => {
        if (selectedBetType === null || selectedCell === null) return;
        const amount = parseFloat(betAmountInput.value);
        if (!amount || amount <= 0) return;
        placeBetBtn.disabled = true;
        placeBetBtn.textContent = 'Placing...';
        try {
            await placeBet('minefield', selectedBetType, selectedCell, amount);
            betAmountInput.value = '';
            selectedBetType = null;
            betTypeBtns.forEach(b => b.classList.remove('selected'));
            selectedCell = null;
            document.querySelectorAll('.mine-cell').forEach(b => { b.style.background = 'rgba(0,0,0,0.25)'; b.style.borderColor = 'var(--border)'; });
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
    else if (selectedBetType === null) reason = 'Pick SAFE or MINE';
    else if (selectedCell === null) reason = 'Pick a cell';
    else if (!amount || amount <= 0) reason = 'Enter bet amount';
    else if (!bettingOpen) reason = 'Round closing — wait for next round';

    const canBet = selectedBetType !== null && selectedCell !== null && amount > 0 && addr && bettingOpen;
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
        stopPulsing();
    } else if (blocksLeft === 0) {
        showBanner('Round closing — awaiting settlement', 'closing');
        stopPulsing();
    } else {
        showBanner(`Live — ${blocksLeft} block${blocksLeft === 1 ? '' : 's'} left`, 'live');
        startPulsing();
    }
}

function startPulsing() {
    if (pulseInterval) return;
    display.textContent = '💣';
    pulseInterval = setInterval(() => {
        display.style.opacity = display.style.opacity === '0.6' ? '1' : '0.6';
    }, 400);
}
function stopPulsing() { if (pulseInterval) { clearInterval(pulseInterval); pulseInterval = null; display.style.opacity = '1'; } }
function clearOutcome() { display.textContent = '💣'; outcomeText.textContent = ''; }

function revealOutcome(args) {
    stopPulsing();
    const o = BigInt(args.winningOutcome);
    const mines = [];
    for (let i = 0; i < 5; i++) mines.push(Number((o >> BigInt(i * 5)) & 0x1Fn));
    display.textContent = '💣';
    outcomeText.textContent = 'Mines: ' + mines.join(', ');
    showBanner(`Round #${args.roundId} settled`, 'settled');
    const addr = getAddress();
    if (addr) getMyBets('minefield', Number(args.roundId), addr).then(bets => {
        if (bets.some(b => !b.claimed && isWinningBet(b, Number(o)))) refreshMyBets();
    }).catch(console.error);
}

function isWinningBet(bet, outcome) {
    const t = Number(bet.betType);
    const v = Number(bet.betValue);
    const mines = new Set();
    for (let i = 0; i < 5; i++) mines.add(Number((BigInt(outcome) >> BigInt(i * 5)) & 0x1Fn));
    if (t === 0) return !mines.has(v);
    if (t === 1) return mines.has(v);
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
        const state = await getRoundState('minefield');
        if (state) { currentRoundId = state.roundId; return state; }
    } catch (e) { console.error('refreshState error', e); }
    return null;
}

async function refreshMyBets() {
    await renderHistory('myBetsList', getAddress(), 'minefield');
}

init();
