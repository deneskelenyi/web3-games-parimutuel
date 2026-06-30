import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, getMyBets, appConfig } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const display = document.getElementById('raceDisplay');
const outcomeText = document.getElementById('outcomeText');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const horseInput = document.getElementById('horseValue');
const exactaRow = document.getElementById('exactaRow');
const horseRow = document.getElementById('horseRow');
const exactaFirst = document.getElementById('exactaFirst');
const exactaSecond = document.getElementById('exactaSecond');
const placeBetBtn = document.getElementById('placeBetBtn');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'cyan', 'pink', 'gold'];
const HORSE_EMOJI = ['🐴','🐎','🦄','🦓','🐂','🐆'];

let selectedBetType = null;
let currentRoundId = null;
let raceInterval = null;

async function init() {
    await loadConfig();
    setTargetChain(appConfig.chain_id);
    await initContracts();
    setActiveTab('horse-race');
    setGame('horse-race');

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

    startRacing();
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
            if (selectedBetType === 3) {
                horseRow.style.display = 'none';
                exactaRow.style.display = 'flex';
            } else {
                horseRow.style.display = 'flex';
                exactaRow.style.display = 'none';
            }
            updatePlaceBetButton();
        });
    });
    [horseInput, exactaFirst, exactaSecond].forEach(inp => {
        inp.addEventListener('input', () => {
            let v = parseInt(inp.value, 10);
            if (isNaN(v)) v = 0;
            if (v < 0) v = 0;
            if (v > 5) v = 5;
            inp.value = v;
        });
    });
    betAmountInput.addEventListener('input', updatePlaceBetButton);

    placeBetBtn.addEventListener('click', async () => {
        if (selectedBetType === null) return;
        const amount = parseFloat(betAmountInput.value);
        if (!amount || amount <= 0) return;
        let betValue;
        if (selectedBetType === 3) {
            const first = parseInt(exactaFirst.value, 10) || 0;
            const second = parseInt(exactaSecond.value, 10) || 0;
            betValue = (first << 4) | second;
        } else {
            betValue = parseInt(horseInput.value, 10) || 0;
        }

        placeBetBtn.disabled = true;
        placeBetBtn.textContent = 'Placing...';
        try {
            await placeBet('horse-race', selectedBetType, betValue, amount);
            betAmountInput.value = '';
            selectedBetType = null;
            betTypeBtns.forEach(b => b.classList.remove('selected'));
            horseRow.style.display = 'flex';
            exactaRow.style.display = 'none';
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
        stopRacing();
    } else if (blocksLeft === 0) {
        showBanner('Round closing — awaiting settlement', 'closing');
        stopRacing();
    } else {
        showBanner(`Live — ${blocksLeft} block${blocksLeft === 1 ? '' : 's'} left`, 'live');
        startRacing();
    }
}

function startRacing() {
    if (raceInterval) return;
    display.textContent = '🏇';
    raceInterval = setInterval(() => {
        display.textContent = HORSE_EMOJI[Math.floor(Math.random()*HORSE_EMOJI.length)];
    }, 150);
}
function stopRacing() { if (raceInterval) { clearInterval(raceInterval); raceInterval = null; } }
function clearOutcome() { display.textContent = '🏇'; outcomeText.textContent = ''; }

function revealOutcome(args) {
    stopRacing();
    const o = BigInt(args.winningOutcome);
    const order = [];
    for (let i = 0; i < 6; i++) order.push(Number((o >> BigInt(i*4)) & 0xFn));
    display.textContent = HORSE_EMOJI[order[0]];
    outcomeText.textContent = `1st:${order[0]}  2nd:${order[1]}  3rd:${order[2]}`;
    showBanner(`Round #${args.roundId} settled`, 'settled');
    const addr = getAddress();
    if (addr) getMyBets('horse-race', Number(args.roundId), addr).then(bets => {
        if (bets.some(b => !b.claimed && isWinningBet(b, Number(o)))) refreshMyBets();
    }).catch(console.error);
}

function isWinningBet(bet, outcome) {
    const t = Number(bet.betType);
    const v = Number(bet.betValue);
    const order = [];
    for (let i = 0; i < 6; i++) order.push(Number((BigInt(outcome) >> BigInt(i*4)) & 0xFn));
    const [first, second, third] = order;
    if (t === 0) return v === first;
    if (t === 1) return v === first || v === second;
    if (t === 2) return v === first || v === second || v === third;
    if (t === 3) {
        const expFirst = (v >> 4) & 0xF;
        const expSecond = v & 0xF;
        return first === expFirst && second === expSecond;
    }
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
        const state = await getRoundState('horse-race');
        if (state) { currentRoundId = state.roundId; return state; }
    } catch (e) { console.error('refreshState error', e); }
    return null;
}

async function refreshMyBets() {
    await renderHistory('myBetsList', getAddress(), 'horse-race');
}

init();
