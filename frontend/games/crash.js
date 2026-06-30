import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, claimWinnings, claimRefund, getMyBets, appConfig } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const crashStage = document.getElementById('crashStage');
const crashRocket = document.getElementById('crashRocket');
const crashLine = document.getElementById('crashLine');
const crashMultiplier = document.getElementById('crashMultiplier');
const outcomeText = document.getElementById('outcomeText');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const placeBetBtn = document.getElementById('placeBetBtn');
const myBetsList = document.getElementById('myBetsList');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'green', 'pink', 'gold'];

const TIER_NAMES = ['1.5X', '2X', '3X', '5X', '10X'];
const TIER_THRESHOLDS = [150, 200, 300, 500, 1000];

let selectedBetType = null;
let currentRoundId = null;
let rollInterval = null;
let isSettling = false;
let displayedOutcomeRoundId = null;
let outcomeClearTimeout = null;

async function init() {
    await loadConfig();
    setTargetChain(appConfig.chain_id);
    await initContracts();
    setActiveTab('crash');
    setGame('crash');

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
        if (document.getElementById('walletModal')) {
            document.getElementById('walletModal').style.display = 'flex';
        }
    });

    window.addEventListener('game:state', (e) => {
        currentRoundId = Number(e.detail.roundId);
        updateRoundVisuals(e.detail);
        updatePlaceBetButton();
    });

    window.addEventListener('game:event', (e) => {
        const d = e.detail;
        if (d.type === 'RoundSettled') {
            revealOutcome(d.args);
        }
        if (d.type === 'RoundCarriedOver') {
            showBanner('Round extended — jackpot rolls', 'closing');
            startFlying();
        }
        if (['BetPlaced', 'RoundSettled', 'RoundCarriedOver', 'RoundVoided'].includes(d.type)) {
            refreshMyBets();
        }
    });

    startFlying();
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
            updatePlaceBetButton();
        });
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
        if (selectedBetType === null) return;
        const amount = parseFloat(betAmountInput.value);
        if (!amount || amount <= 0) return;

        placeBetBtn.disabled = true;
        placeBetBtn.textContent = 'Placing...';
        try {
            const tx = await placeBet('crash', selectedBetType, 0, amount);
            betAmountInput.value = '';
            selectedBetType = null;
            betTypeBtns.forEach(b => b.classList.remove('selected'));
            clearOutcome();
            const state = await getRoundState('crash');
            if (state) currentRoundId = state.roundId;
            await refreshMyBets();
            console.log('Bet placed', tx.hash);
        } catch (e) {
            console.error(e);
            let msg = e?.reason || e?.message || 'Bet failed';
            if (msg.includes(' BettingClosed')) msg = 'Betting is closed for this round.';
            if (msg.includes(' BelowMinBet')) msg = 'Bet amount is below the minimum.';
            if (msg.includes(' user rejected')) msg = 'Transaction rejected in wallet.';
            alert(msg);
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
    if (!addr) {
        reason = 'Connect wallet to bet';
    } else if (selectedBetType === null) {
        reason = 'Pick a tier';
    } else if (!amount || amount <= 0) {
        reason = 'Enter bet amount';
    } else if (!bettingOpen) {
        reason = 'Round closing — wait for next round';
    }

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

function formatMultiplier(outcome) {
    return (outcome / 100).toFixed(2) + 'x';
}

function updateRoundVisuals(state) {
    if (!state) return;
    const roundId = Number(state.roundId);
    const now = Number(state.blockNumber);
    const resolution = Number(state.resolutionBlock);
    const blocksLeft = resolution ? Math.max(0, resolution - now) : 0;

    if (state.settled && !state.voided) {
        showOutcome(Number(state.winningOutcome));
        showBanner('Round settled', 'settled');
        stopFlying();
    } else if (blocksLeft === 0) {
        showBanner('Round closing — awaiting settlement', 'closing');
        stopFlying();
        if (!isSettling) {
            crashMultiplier.textContent = '1.00x';
            crashRocket.style.transform = 'translate(-50%, 50%) rotate(-45deg)';
        }
    } else {
        showBanner(`Live — ${blocksLeft} block${blocksLeft === 1 ? '' : 's'} left`, 'live');
        if (!isSettling) startFlying();
    }
}

function startFlying() {
    if (rollInterval || isSettling) return;
    crashMultiplier.textContent = '1.00x';
    crashRocket.style.transform = 'translate(-50%, 50%) rotate(-45deg)';
    crashStage.style.animation = 'pulse-ring 3s ease-in-out infinite';
    let t = 1.0;
    rollInterval = setInterval(() => {
        t += 0.03 + Math.random() * 0.05;
        if (t > 8) t = 1.0;
        crashMultiplier.textContent = t.toFixed(2) + 'x';
        const rot = -45 - (t - 1) * 8;
        crashRocket.style.transform = `translate(-50%, 50%) rotate(${rot}deg)`;
    }, 100);
}

function stopFlying() {
    if (rollInterval) {
        clearInterval(rollInterval);
        rollInterval = null;
    }
}

function clearOutcome() {
    if (outcomeClearTimeout) {
        clearTimeout(outcomeClearTimeout);
        outcomeClearTimeout = null;
    }
    crashMultiplier.textContent = '1.00x';
    crashRocket.style.transform = 'translate(-50%, 50%) rotate(-45deg)';
    crashStage.style.background = 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.08), transparent 70%), conic-gradient(from 180deg, var(--red), var(--gold), var(--green), var(--blue), var(--red))';
    outcomeText.textContent = '';
    outcomeText.className = 'crash-outcome-text';
    displayedOutcomeRoundId = null;
}

async function revealOutcome(args) {
    isSettling = true;
    stopFlying();
    const outcome = Number(args.winningOutcome);
    const settledRoundId = Number(args.roundId);

    let steps = 20;
    let delay = 50;
    let t = 1.0;
    const roll = () => {
        if (steps > 0) {
            t += 0.08 + Math.random() * 0.12;
            if (t > outcome / 100) t = 1.0;
            crashMultiplier.textContent = t.toFixed(2) + 'x';
            const rot = -45 - (t - 1) * 8;
            crashRocket.style.transform = `translate(-50%, 50%) rotate(${rot}deg)`;
            steps--;
            delay = Math.min(280, delay + 12);
            setTimeout(roll, delay);
        } else {
            showOutcome(outcome);
            flashRoundResult(settledRoundId, outcome);
            showBanner(`Round #${settledRoundId} settled`, 'settled');
            displayedOutcomeRoundId = settledRoundId;
            if (outcomeClearTimeout) clearTimeout(outcomeClearTimeout);
            outcomeClearTimeout = setTimeout(() => {
                if (displayedOutcomeRoundId === settledRoundId) {
                    clearOutcome();
                    startFlying();
                }
            }, 10000);
            isSettling = false;
        }
    };
    roll();
}

function showOutcome(outcome) {
    const mult = formatMultiplier(outcome);
    crashMultiplier.textContent = mult;

    const winner = outcome >= 100;
    const survivedClass = winner ? 'survived' : 'crash';
    crashStage.style.background = `radial-gradient(circle at 50% 50%, ${winner ? 'rgba(0,224,160,0.2)' : 'rgba(255,94,120,0.2)'}, transparent 70%), conic-gradient(from 180deg, ${winner ? 'var(--green)' : 'var(--red)'}, var(--gold), ${winner ? 'var(--green)' : 'var(--red)'})`;

    outcomeText.textContent = `Crashed at ${mult}`;
    outcomeText.className = `crash-outcome-text ${survivedClass}`;
}

function flashRoundResult(roundId, outcome) {
    const addr = getAddress();
    if (!addr || roundId == null) return;

    getMyBets('crash', roundId, addr).then(bets => {
        if (!bets.length) return;
        const won = bets.some(b => !b.claimed && isWinningBet(b.betType, outcome));
        if (won) burstConfetti();
        refreshMyBets();
    }).catch(console.error);
}

function isWinningBet(betType, outcome) {
    return outcome >= TIER_THRESHOLDS[betType];
}

function showBanner(text, mood) {
    if (!roundStatusBanner) return;
    roundStatusBanner.textContent = text;
    roundStatusBanner.className = 'round-status-banner show ' + mood;
}

async function refreshState() {
    if (!appConfig) return null;
    try {
        const state = await getRoundState('crash');
        if (state) {
            currentRoundId = state.roundId;
            return state;
        }
    } catch (e) {
        console.error('refreshState error', e);
    }
    return null;
}

async function refreshMyBets() {
    await renderHistory('myBetsList', getAddress(), 'crash');
}

function renderMyBets(items) {
    if (items.length === 0) {
        myBetsList.innerHTML = `<div class="my-bet" style="color:var(--text-secondary);">No active bets.</div>`;
        return;
    }

    myBetsList.innerHTML = '';
    items.forEach(item => {
        const tier = TIER_NAMES[item.betType];
        const amount = ethers.formatEther(item.amount);
        const div = document.createElement('div');
        div.className = 'my-bet';
        div.innerHTML = `
            <div>
                <div style="font-weight:700;">Round #${item.rid} — ${amount} ETH on ${tier}</div>
                <div class="my-bet-status" id="status-${item.rid}">Pending settlement</div>
            </div>
        `;
        myBetsList.appendChild(div);
    });

    checkAndRenderClaims(items);
}

async function checkAndRenderClaims(items) {
    for (const item of items) {
        try {
            const state = await getRoundState('crash', item.rid);
            if (!state) continue;
            const statusEl = document.getElementById(`status-${item.rid}`);
            if (!statusEl) continue;

            if (state.voided) {
                statusEl.textContent = 'Round voided — claim refund';
                const btn = createActionButton('Refund', () => runClaim(claimRefund, 'crash', item.rid));
                statusEl.parentElement.appendChild(btn);
            } else if (state.settled) {
                const winner = isWinningBet(item.betType, state.winningOutcome);
                const mult = formatMultiplier(state.winningOutcome);
                if (winner) {
                    statusEl.textContent = `Won — crashed at ${mult}`;
                    const btn = createActionButton('Claim', () => runClaim(claimWinnings, 'crash', item.rid));
                    statusEl.parentElement.appendChild(btn);
                } else {
                    statusEl.textContent = `Lost — crashed at ${mult}`;
                }
            }
        } catch (e) {
            console.error(e);
        }
    }
}

function createActionButton(label, onClick) {
    const btn = document.createElement('button');
    btn.className = 'claim-btn';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '...';
        try {
            await onClick();
            await refreshMyBets();
        } catch (e) {
            console.error(e);
            alert(e?.reason || e?.message || `${label} failed`);
            btn.disabled = false;
            btn.textContent = label;
        }
    });
    return btn;
}

async function runClaim(fn, gameKey, roundId) {
    await fn(gameKey, roundId);
    await refreshBalance();
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
