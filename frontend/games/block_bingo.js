import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, getMyBets, appConfig, getContract } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const display = document.getElementById('bingoDisplay');
const cardGrid = document.getElementById('bingoCard');
const outcomeText = document.getElementById('outcomeText');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const placeBetBtn = document.getElementById('placeBetBtn');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'cyan', 'pink', 'gold'];

let selectedBetType = 0;
let currentRoundId = null;
let drawInterval = null;

async function init() {
    await loadConfig();
    setTargetChain(appConfig.chain_id);
    await initContracts();
    setActiveTab('block-bingo');
    setGame('block-bingo');

    renderChips();
    betTypeBtns.forEach(b => { if (Number(b.dataset.type) === 0) b.classList.add('selected'); });
    setupListeners();
    refreshState();
    setInterval(refreshState, 3000);
    setInterval(refreshMyBets, 5000);

    if (!getAddress() && document.getElementById('walletModal')) {
        document.getElementById('walletModal').style.display = 'flex';
    }

    window.addEventListener('wallet:connected', () => {
        refreshBalance();
        refreshCard();
        refreshMyBets();
        updatePlaceBetButton();
    });
    window.addEventListener('wallet:disconnected', () => {
        cardGrid.innerHTML = '';
        updatePlaceBetButton();
        if (document.getElementById('walletModal')) document.getElementById('walletModal').style.display = 'flex';
    });

    window.addEventListener('game:state', (e) => {
        currentRoundId = Number(e.detail.roundId);
        updateRoundVisuals(e.detail);
        refreshCard();
        updatePlaceBetButton();
    });
    window.addEventListener('game:event', (e) => {
        const d = e.detail;
        if (d.type === 'RoundSettled') revealOutcome(d.args);
        if (['RoundSettled','RoundCarriedOver','RoundVoided','BetPlaced'].includes(d.type)) refreshMyBets();
    });

    startRolling();
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
    betAmountInput.addEventListener('input', updatePlaceBetButton);

    placeBetBtn.addEventListener('click', async () => {
        const amount = parseFloat(betAmountInput.value);
        if (!amount || amount <= 0) return;
        placeBetBtn.disabled = true;
        placeBetBtn.textContent = 'Placing...';
        try {
            await placeBet('block-bingo', selectedBetType, 0, amount);
            betAmountInput.value = '';
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

function generateCard(player, roundId) {
    const seed = BigInt(ethers.keccak256(ethers.solidityPacked(['address', 'uint256'], [player, roundId])));
    const card = new Array(25).fill(0);
    const used = new Set();
    let nonce = 0;
    while (used.size < 24) {
        const num = Number(BigInt(ethers.keccak256(ethers.solidityPacked(['uint256', 'uint256'], [seed, nonce]))) % 75n + 1n);
        nonce++;
        if (used.has(num)) continue;
        used.add(num);
        card[used.size - 1] = num;
    }
    card[12] = 0;
    return card;
}

function refreshCard() {
    const addr = getAddress();
    if (!addr || currentRoundId == null) { cardGrid.innerHTML = ''; return; }
    const card = generateCard(addr, currentRoundId);
    cardGrid.innerHTML = '';
    card.forEach((n, i) => {
        const cell = document.createElement('div');
        cell.textContent = n === 0 ? 'FREE' : n;
        cell.style.cssText = 'width:40px;height:40px;display:grid;place-items:center;border-radius:6px;background:rgba(0,0,0,0.25);border:1px solid var(--border);font-size:11px;font-weight:700;';
        if (i === 12) cell.style.background = 'rgba(167,139,250,0.25)';
        cardGrid.appendChild(cell);
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
    else if (!amount || amount <= 0) reason = 'Enter bet amount';
    else if (!bettingOpen) reason = 'Round closing — wait for next round';

    const canBet = amount > 0 && addr && bettingOpen;
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
        stopRolling();
    } else if (blocksLeft === 0) {
        showBanner('Round closing — awaiting settlement', 'closing');
        stopRolling();
    } else {
        showBanner(`Live — ${blocksLeft} block${blocksLeft === 1 ? '' : 's'} left`, 'live');
        startRolling();
    }
}

function startRolling() { if (drawInterval) return; display.textContent = '🟥'; drawInterval = setInterval(() => { display.textContent = '⬛'; setTimeout(() => display.textContent = '🟥', 120); }, 250); }
function stopRolling() { if (drawInterval) { clearInterval(drawInterval); drawInterval = null; } }
function clearOutcome() { display.textContent = '🟥'; outcomeText.textContent = ''; }

function revealOutcome(args) {
    stopRolling();
    const o = BigInt(args.winningOutcome);
    const drawn = [];
    for (let i = 0; i < 25; i++) drawn.push(Number((o >> BigInt(i * 7)) & 0x7Fn));
    display.textContent = '🟥';
    outcomeText.textContent = 'Drawn: ' + drawn.slice(0, 5).join(', ') + ' ...';
    showBanner(`Round #${args.roundId} settled`, 'settled');
    const addr = getAddress();
    if (addr && currentRoundId != null) {
        const drawnSet = new Set(drawn);
        const card = generateCard(addr, Number(args.roundId));
        if (hasBingo(card, drawnSet)) refreshMyBets();
    }
}

function hasBingo(card, drawn) {
    const lineComplete = (indices) => indices.every(i => { const n = card[i]; return n === 0 || drawn.has(n); });
    const size = 5;
    for (let r = 0; r < size; r++) if (lineComplete(Array.from({ length: size }, (_, c) => r * size + c))) return true;
    for (let c = 0; c < size; c++) if (lineComplete(Array.from({ length: size }, (_, r) => r * size + c))) return true;
    if (lineComplete(Array.from({ length: size }, (_, i) => i * size + i))) return true;
    if (lineComplete(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)))) return true;
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
        const state = await getRoundState('block-bingo');
        if (state) { currentRoundId = state.roundId; return state; }
    } catch (e) { console.error('refreshState error', e); }
    return null;
}

async function refreshMyBets() {
    await renderHistory('myBetsList', getAddress(), 'block-bingo');
}

init();
