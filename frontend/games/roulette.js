import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, getMyBets, appConfig } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab, showToast } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const wheelResult = document.getElementById('wheelResult');
const outcomeText = document.getElementById('outcomeText');
const rouletteVisualCard = document.getElementById('rouletteVisualCard');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const numberGrid = document.getElementById('numberGrid');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const placeBetBtn = document.getElementById('placeBetBtn');
const myBetsList = document.getElementById('myBetsList');
const betControls = document.querySelector('.bet-controls');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'cyan', 'pink', 'gold'];

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const BET_LABELS = { 0: 'RED', 1: 'BLACK', 2: 'EVEN', 3: 'ODD', 4: 'HIGH', 5: 'LOW', 6: 'NUMBER' };
const NUMBER_BET_TYPE = 6;

// Pending wagers in the bet slip.
let pendingWagers = [];
let currentRoundId = null;
let lastSettledRoundId = null;
let lastSettledOutcome = null;
let rollInterval = null;
let isSettling = false;

async function init() {
    await loadConfig();
    setTargetChain(appConfig.chain_id);
    await initContracts();
    setActiveTab('roulette');
    setGame('roulette');

    renderChips();
    renderNumberGrid();
    addBetSlipUI();
    setupListeners();
    refreshState();
    setInterval(refreshState, 3000);
    setInterval(() => renderHistory('myBetsList', getAddress(), 'roulette'), 5000);

    if (!getAddress() && document.getElementById('walletModal')) {
        document.getElementById('walletModal').style.display = 'flex';
    }

    window.addEventListener('wallet:connected', () => {
        refreshBalance();
        renderHistory('myBetsList', getAddress(), 'roulette');
        updatePlaceButton();
    });

    window.addEventListener('wallet:funded', () => {
        renderHistory('myBetsList', getAddress(), 'roulette');
    });

    window.addEventListener('wallet:disconnected', () => {
        updatePlaceButton();
        renderHistory('myBetsList', getAddress(), 'roulette');
        if (document.getElementById('walletModal')) {
            document.getElementById('walletModal').style.display = 'flex';
        }
    });

    window.addEventListener('game:state', (e) => {
        currentRoundId = Number(e.detail.roundId);
        updateRoundVisuals(e.detail);
        updatePlaceButton();
    });

    window.addEventListener('game:event', (e) => {
        const d = e.detail;
        if (d.type === 'RoundSettled') {
            revealOutcome(d.args);
        }
        if (d.type === 'RoundCarriedOver') {
            showBanner('Round extended — jackpot rolls', 'closing');
            startRolling();
        }
        if (['BetPlaced', 'RoundSettled', 'RoundCarriedOver', 'RoundVoided'].includes(d.type)) {
            renderHistory('myBetsList', getAddress(), 'roulette');
        }
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
        chip.addEventListener('click', () => {
            betAmountInput.value = val;
            updatePlaceButton();
        });
        chipRow.appendChild(chip);
    });
}

function numberColorClass(n) {
    if (n === 0) return 'green';
    return RED_NUMBERS.has(n) ? 'red' : 'black';
}

function renderNumberGrid() {
    numberGrid.innerHTML = '';
    for (let n = 0; n <= 36; n++) {
        const btn = document.createElement('button');
        btn.className = `number-btn ${numberColorClass(n)}`;
        btn.textContent = n;
        btn.dataset.number = n;
        btn.addEventListener('click', () => toggleNumberWager(n, btn));
        numberGrid.appendChild(btn);
    }
}

function addBetSlipUI() {
    const slip = document.createElement('div');
    slip.className = 'bet-slip';
    slip.id = 'betSlip';
    slip.innerHTML = `
        <div class="bet-slip-title">📝 Bet Slip</div>
        <div class="bet-slip-list" id="betSlipList">
            <div class="bet-slip-empty">Click a colour, range, or number to add a wager.</div>
        </div>
        <div class="bet-slip-total" id="betSlipTotal"></div>
    `;
    betControls.insertBefore(slip, placeBetBtn);
}

function wagerKey(betType, betValue) {
    return `${betType}:${betValue}`;
}

function isWagerInSlip(betType, betValue) {
    return pendingWagers.some(w => w.betType === betType && w.betValue === betValue);
}

function toggleOutsideWager(betType) {
    const amount = parseFloat(betAmountInput.value);
    if (!amount || amount <= 0) {
        showToast('Set an ETH amount first');
        return;
    }
    const existing = pendingWagers.findIndex(w => w.betType === betType && w.betValue === 0);
    if (existing >= 0) {
        pendingWagers.splice(existing, 1);
    } else {
        pendingWagers.push({ betType, betValue: 0, amount, label: BET_LABELS[betType] });
    }
    renderBetSlip();
    updateSelectionHighlights();
    updatePlaceButton();
}

function toggleNumberWager(n, btn) {
    const amount = parseFloat(betAmountInput.value);
    if (!amount || amount <= 0) {
        showToast('Set an ETH amount first');
        return;
    }
    const existing = pendingWagers.findIndex(w => w.betType === NUMBER_BET_TYPE && w.betValue === n);
    if (existing >= 0) {
        pendingWagers.splice(existing, 1);
    } else {
        pendingWagers.push({ betType: NUMBER_BET_TYPE, betValue: n, amount, label: `${BET_LABELS[NUMBER_BET_TYPE]} ${n}` });
    }
    renderBetSlip();
    updateSelectionHighlights();
    updatePlaceButton();
}

function removeWager(idx) {
    pendingWagers.splice(idx, 1);
    renderBetSlip();
    updateSelectionHighlights();
    updatePlaceButton();
}

function renderBetSlip() {
    const list = document.getElementById('betSlipList');
    const totalEl = document.getElementById('betSlipTotal');
    if (!list) return;
    if (pendingWagers.length === 0) {
        list.innerHTML = '<div class="bet-slip-empty">Click a colour, range, or number to add a wager.</div>';
        totalEl.textContent = '';
        return;
    }
    let total = 0n;
    list.innerHTML = '';
    pendingWagers.forEach((w, idx) => {
        const wei = ethers.parseEther(w.amount.toString());
        total += wei;
        const item = document.createElement('div');
        item.className = 'bet-slip-item';
        item.innerHTML = `
            <span><strong>${w.label}</strong> — ${w.amount} ETH</span>
            <button class="bet-slip-remove" data-idx="${idx}" title="Remove">×</button>
        `;
        list.appendChild(item);
    });
    totalEl.textContent = `Total wagered: ${ethers.formatEther(total)} ETH`;

    list.querySelectorAll('.bet-slip-remove').forEach(btn => {
        btn.addEventListener('click', () => removeWager(Number(btn.dataset.idx)));
    });
}

function updateSelectionHighlights() {
    betTypeBtns.forEach(btn => {
        const t = Number(btn.dataset.type);
        btn.classList.toggle('selected', isWagerInSlip(t, 0));
    });
    document.querySelectorAll('.number-btn').forEach(btn => {
        const n = Number(btn.dataset.number);
        btn.classList.toggle('selected', isWagerInSlip(NUMBER_BET_TYPE, n));
    });
}

function setupListeners() {
    betTypeBtns.forEach(btn => {
        btn.addEventListener('click', () => toggleOutsideWager(Number(btn.dataset.type)));
    });

    betAmountInput.addEventListener('input', () => {
        // Update amounts in the slip to match the new amount input.
        const amount = parseFloat(betAmountInput.value);
        if (amount > 0) {
            pendingWagers.forEach(w => w.amount = amount);
            renderBetSlip();
        }
        updatePlaceButton();
    });

    placeBetBtn.addEventListener('click', placeAllBets);
}

function updatePlaceButton() {
    const amount = parseFloat(betAmountInput.value);
    const addr = getAddress();
    const state = latestState;
    const now = state ? Number(state.blockNumber) : 0;
    const resolution = state ? Number(state.resolutionBlock) : 0;
    const bettingOpen = !resolution || now < resolution;

    let reason = '';
    if (!addr) {
        reason = 'Connect wallet to bet';
    } else if (pendingWagers.length === 0) {
        reason = 'Add at least one wager';
    } else if (!amount || amount <= 0) {
        reason = 'Enter bet amount';
    } else if (!bettingOpen) {
        reason = 'Round closing — wait for next round';
    }

    const canBet = pendingWagers.length > 0 && amount > 0 && addr && bettingOpen;
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

async function placeAllBets() {
    if (pendingWagers.length === 0) return;
    const addr = getAddress();
    if (!addr) return;

    placeBetBtn.disabled = true;
    placeBetBtn.textContent = 'Placing...';

    const toPlace = [...pendingWagers];
    let placed = 0;
    try {
        for (const w of toPlace) {
            await placeBet('roulette', w.betType, w.betValue, w.amount);
            // Remove from slip once successfully placed.
            const idx = pendingWagers.findIndex(x => x.betType === w.betType && x.betValue === w.betValue);
            if (idx >= 0) pendingWagers.splice(idx, 1);
            placed++;
            renderBetSlip();
            updateSelectionHighlights();
        }
        // Clear the old outcome display when the user places new bets.
        clearOutcome();
        const state = await getRoundState('roulette');
        if (state) currentRoundId = state.roundId;
        await renderHistory('myBetsList', getAddress(), 'roulette');
        showToast(`${placed} wager${placed === 1 ? '' : 's'} placed`);
    } catch (e) {
        console.error(e);
        let msg = e?.reason || e?.message || 'Bet failed';
        if (msg.includes(' BettingClosed')) msg = 'Betting is closed for this round.';
        if (msg.includes(' BelowMinBet')) msg = 'Bet amount is below the minimum.';
        if (msg.includes(' user rejected')) msg = 'Transaction rejected in wallet.';
        alert(msg);
    } finally {
        placeBetBtn.textContent = 'Place All Bets';
        updatePlaceButton();
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
        if (!isSettling) {
            wheelResult.textContent = '??';
            wheelResult.className = 'wheel-result pending';
        }
    } else {
        showBanner(`Live — ${blocksLeft} block${blocksLeft === 1 ? '' : 's'} left`, 'live');
        if (!isSettling && pendingWagers.length === 0 && !lastSettledOutcome) startRolling();
    }
}

function startRolling() {
    if (rollInterval || isSettling || lastSettledOutcome) return;
    wheelResult.className = 'wheel-result pending';
    wheelResult.textContent = '??';
    wheelResult.style.color = 'var(--text-secondary)';
    rouletteVisualCard.classList.remove('settled-red', 'settled-black', 'settled-green');
    outcomeText.textContent = '';
    outcomeText.className = 'wheel-outcome-text';
    rollInterval = setInterval(() => {
        const n = Math.floor(Math.random() * 37);
        wheelResult.className = 'wheel-result';
        wheelResult.textContent = n;
        wheelResult.style.color = `var(--${numberColorClass(n) === 'red' ? 'red' : numberColorClass(n) === 'green' ? 'green' : 'text-secondary'})`;
    }, 120);
}

function stopRolling() {
    if (rollInterval) {
        clearInterval(rollInterval);
        rollInterval = null;
    }
}

function clearOutcome() {
    wheelResult.textContent = '??';
    wheelResult.className = 'wheel-result pending';
    wheelResult.style.color = '';
    rouletteVisualCard.classList.remove('settled-red', 'settled-black', 'settled-green');
    outcomeText.textContent = '';
    outcomeText.className = 'wheel-outcome-text';
    lastSettledRoundId = null;
    lastSettledOutcome = null;
    if (!isSettling) startRolling();
}

async function revealOutcome(args) {
    isSettling = true;
    stopRolling();
    const outcome = Number(args.winningOutcome);
    const settledRoundId = Number(args.roundId);

    wheelResult.classList.remove('pending');
    let steps = 16;
    let delay = 45;
    const roll = () => {
        if (steps > 0) {
            const n = Math.floor(Math.random() * 37);
            wheelResult.textContent = n;
            wheelResult.style.color = n === 0 ? 'var(--green)' : (RED_NUMBERS.has(n) ? 'var(--red)' : '#7a7a7a');
            steps--;
            delay = Math.min(260, delay + 15);
            setTimeout(roll, delay);
        } else {
            showOutcome(outcome);
            flashRoundResult(settledRoundId, outcome);
            showBanner(`Round #${settledRoundId} settled`, 'settled');
            lastSettledRoundId = settledRoundId;
            lastSettledOutcome = outcome;
            isSettling = false;
        }
    };
    roll();
}

function showOutcome(outcome) {
    stopRolling();
    const colorClass = numberColorClass(outcome);
    wheelResult.textContent = outcome;
    wheelResult.classList.remove('pending');
    wheelResult.style.color = colorClass === 'red' ? 'var(--red)' : colorClass === 'green' ? 'var(--green)' : '#7a7a7a';

    rouletteVisualCard.classList.remove('settled-red', 'settled-black', 'settled-green');
    rouletteVisualCard.classList.add(`settled-${colorClass}`);

    if (outcome === 0) {
        outcomeText.textContent = '0 — GREEN (only exact 0 wins)';
    } else {
        const parts = [];
        if (RED_NUMBERS.has(outcome)) parts.push('RED');
        else parts.push('BLACK');
        if (outcome % 2 === 0) parts.push('EVEN');
        else parts.push('ODD');
        if (outcome >= 19) parts.push('HIGH');
        else parts.push('LOW');
        outcomeText.textContent = `${outcome} — ${parts.join(' • ')}`;
    }
    outcomeText.className = `wheel-outcome-text ${colorClass}`;
}

function flashRoundResult(roundId, outcome) {
    const addr = getAddress();
    if (!addr || roundId == null) return;

    getMyBets('roulette', roundId, addr).then(bets => {
        if (!bets.length) return;
        const won = bets.some(b => !b.claimed && isWinningBet(b.betType, b.betValue, outcome));
        if (won) burstConfetti();
    }).catch(console.error);
}

function isWinningBet(betType, betValue, outcome) {
    if (outcome === 0) return betType === NUMBER_BET_TYPE && betValue === 0;
    if (betType === 0) return RED_NUMBERS.has(outcome);
    if (betType === 1) return !RED_NUMBERS.has(outcome);
    if (betType === 2) return outcome % 2 === 0;
    if (betType === 3) return outcome % 2 === 1;
    if (betType === 4) return outcome >= 19;
    if (betType === 5) return outcome <= 18;
    if (betType === NUMBER_BET_TYPE) return betValue === outcome;
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
        const state = await getRoundState('roulette');
        if (state) {
            currentRoundId = state.roundId;
            return state;
        }
    } catch (e) {
        console.error('refreshState error', e);
    }
    return null;
}

function outcomeDescription(outcome) {
    if (outcome === 0) return '(GREEN)';
    const parts = [];
    if (RED_NUMBERS.has(outcome)) parts.push('RED');
    else parts.push('BLACK');
    if (outcome % 2 === 0) parts.push('EVEN');
    else parts.push('ODD');
    if (outcome >= 19) parts.push('HIGH');
    else parts.push('LOW');
    return '(' + parts.join(' • ') + ')';
}

// ─── Confetti ───
function burstConfetti() {
    const canvas = document.getElementById('confettiCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#00e0a0', '#ffd166', '#ff5e78', '#a78bfa', '#00d2ff'];
    const pieces = [];
    const count = 100;

    for (let i = 0; i < count; i++) {
        pieces.push({
            x: canvas.width / 2,
            y: canvas.height / 2,
            vx: (Math.random() - 0.5) * 18,
            vy: (Math.random() - 1) * 18 - 4,
            size: Math.random() * 6 + 3,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * Math.PI * 2,
            rotationSpeed: (Math.random() - 0.5) * 0.3,
            drag: 0.96,
            gravity: 0.35,
            life: 1.0,
        });
    }

    let frame = 0;
    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = 0;
        for (const p of pieces) {
            if (p.life <= 0) continue;
            alive++;
            p.x += p.vx; p.y += p.vy;
            p.vy += p.gravity;
            p.vx *= p.drag; p.vy *= p.drag;
            p.rotation += p.rotationSpeed;
            p.life -= 0.015;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
            ctx.restore();
        }
        if (alive > 0 && frame < 180) {
            frame++;
            requestAnimationFrame(draw);
        } else {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }
    draw();
}

window.addEventListener('resize', () => {
    const canvas = document.getElementById('confettiCanvas');
    if (canvas) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
});

init();
