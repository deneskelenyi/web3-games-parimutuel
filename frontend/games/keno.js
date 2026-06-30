import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, getMyBets, appConfig } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const display = document.getElementById('kenoDisplay');
const outcomeText = document.getElementById('outcomeText');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const kenoGrid = document.getElementById('kenoGrid');
const placeBetBtn = document.getElementById('placeBetBtn');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'cyan', 'pink', 'gold'];

let selectedBetType = null;
let selectedNumbers = new Set();
let currentRoundId = null;
let drawInterval = null;

async function init() {
    await loadConfig();
    setTargetChain(appConfig.chain_id);
    await initContracts();
    setActiveTab('keno');
    setGame('keno');

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

function renderGrid() {
    kenoGrid.innerHTML = '';
    for (let n = 1; n <= 40; n++) {
        const btn = document.createElement('button');
        btn.className = 'keno-number';
        btn.textContent = n;
        btn.dataset.n = n;
        btn.style.cssText = 'padding:8px;border-radius:8px;background:rgba(0,0,0,0.25);border:1px solid var(--border);color:var(--text-primary);font-weight:700;cursor:pointer;';
        btn.addEventListener('click', () => toggleNumber(n, btn));
        kenoGrid.appendChild(btn);
    }
}

function toggleNumber(n, btn) {
    if (selectedNumbers.has(n)) {
        selectedNumbers.delete(n);
        btn.style.background = 'rgba(0,0,0,0.25)';
        btn.style.borderColor = 'var(--border)';
    } else {
        if (selectedNumbers.size >= 5) {
            alert('You can only pick 5 numbers');
            return;
        }
        selectedNumbers.add(n);
        btn.style.background = 'rgba(0,224,160,0.25)';
        btn.style.borderColor = 'var(--green)';
    }
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
        if (selectedBetType === null) return;
        if (selectedNumbers.size !== 5) {
            alert('Pick exactly 5 numbers');
            return;
        }
        const amount = parseFloat(betAmountInput.value);
        if (!amount || amount <= 0) return;
        const nums = Array.from(selectedNumbers).sort((a, b) => a - b);
        let betValue = 0;
        nums.forEach((n, i) => { betValue |= (n << (i * 8)); });

        placeBetBtn.disabled = true;
        placeBetBtn.textContent = 'Placing...';
        try {
            await placeBet('keno', selectedBetType, betValue, amount);
            betAmountInput.value = '';
            selectedBetType = null;
            betTypeBtns.forEach(b => b.classList.remove('selected'));
            selectedNumbers.clear();
            document.querySelectorAll('.keno-number').forEach(b => {
                b.style.background = 'rgba(0,0,0,0.25)'; b.style.borderColor = 'var(--border)';
            });
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
    else if (selectedNumbers.size !== 5) reason = `Pick ${5 - selectedNumbers.size} more number${selectedNumbers.size === 4 ? '' : 's'}`;
    else if (!amount || amount <= 0) reason = 'Enter bet amount';
    else if (!bettingOpen) reason = 'Round closing — wait for next round';

    const canBet = selectedBetType !== null && selectedNumbers.size === 5 && amount > 0 && addr && bettingOpen;
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

function startRolling() {
    if (drawInterval) return;
    display.textContent = '🎱';
    drawInterval = setInterval(() => {
        display.textContent = '🎱 ' + (Math.floor(Math.random() * 40) + 1);
    }, 200);
}
function stopRolling() { if (drawInterval) { clearInterval(drawInterval); drawInterval = null; } }
function clearOutcome() { display.textContent = '🎱'; outcomeText.textContent = ''; }

function revealOutcome(args) {
    stopRolling();
    const o = BigInt(args.winningOutcome);
    const drawn = [];
    for (let i = 0; i < 10; i++) drawn.push(Number((o >> BigInt(i * 6)) & 0x3Fn));
    display.textContent = '🎱';
    outcomeText.textContent = 'Drawn: ' + drawn.slice(0, 5).join(', ') + ' ...';
    showBanner(`Round #${args.roundId} settled`, 'settled');
    const addr = getAddress();
    if (addr) getMyBets('keno', Number(args.roundId), addr).then(bets => {
        if (bets.some(b => !b.claimed && isWinningBet(b, Number(o)))) refreshMyBets();
    }).catch(console.error);
}

function isWinningBet(bet, outcome) {
    const t = Number(bet.betType);
    const drawn = new Set();
    for (let i = 0; i < 10; i++) drawn.add(Number((BigInt(outcome) >> BigInt(i * 6)) & 0x3Fn));
    let matches = 0;
    for (let i = 0; i < 5; i++) {
        const pick = (Number(bet.betValue) >> (i * 8)) & 0xFF;
        if (pick > 0 && pick <= 40 && drawn.has(pick)) matches++;
    }
    if (t === 0) return matches === 5;
    if (t === 1) return matches === 4;
    if (t === 2) return matches === 3;
    if (t === 3) return matches === 0;
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
        const state = await getRoundState('keno');
        if (state) { currentRoundId = state.roundId; return state; }
    } catch (e) { console.error('refreshState error', e); }
    return null;
}

async function refreshMyBets() {
    await renderHistory('myBetsList', getAddress(), 'keno');
}

init();
