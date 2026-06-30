import { setTargetChain, getAddress, refreshBalance } from '../shared/wallet.js';
import { loadConfig, initContracts, getRoundState, placeBet, claimWinnings, claimRefund, getMyBets, appConfig } from '../shared/contract.js';
import { setGame, latestState } from '../shared/ui.js';
import { setActiveTab } from '../shared/tabs.js';
import { renderHistory } from '../shared/history.js';

const ethers = window.ethers;
const colorResult = document.getElementById('colorResult');
const outcomeText = document.getElementById('outcomeText');
const colorStage = document.getElementById('colorStage');
const colorDuelVisualCard = document.getElementById('colorDuelVisualCard');
const roundStatusBanner = document.getElementById('roundStatusBanner');
const betTypeBtns = document.querySelectorAll('.bet-type-btn');
const chipRow = document.getElementById('chipRow');
const betAmountInput = document.getElementById('betAmount');
const placeBetBtn = document.getElementById('placeBetBtn');
const myBetsList = document.getElementById('myBetsList');

const CHIPS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0];
const CHIP_COLORS = ['cyan', 'pink', 'gold', 'purple', 'green', 'pink', 'gold'];

const COLOR_NAMES = ['RED', 'GREEN', 'BLUE'];
const COLOR_CLASSES = ['red', 'green', 'blue'];

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
    setActiveTab('color-duel');
    setGame('color-duel');

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
            startRolling();
        }
        if (['BetPlaced', 'RoundSettled', 'RoundCarriedOver', 'RoundVoided'].includes(d.type)) {
            refreshMyBets();
        }
    });

    window.addEventListener('game:tab', (e) => {
        if (e.detail.game === 'color-duel') {
            setActiveTab('color-duel');
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
            const tx = await placeBet('color-duel', selectedBetType, 0, amount);
            betAmountInput.value = '';
            selectedBetType = null;
            betTypeBtns.forEach(b => b.classList.remove('selected'));
            clearOutcome();
            const state = await getRoundState('color-duel');
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
        reason = 'Pick a color';
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

function updateRoundVisuals(state) {
    if (!state) return;
    const roundId = Number(state.roundId);
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
            colorResult.textContent = '??';
            colorResult.className = 'color-center pending';
        }
    } else {
        showBanner(`Live — ${blocksLeft} block${blocksLeft === 1 ? '' : 's'} left`, 'live');
        if (!isSettling) startRolling();
    }
}

function startRolling() {
    if (rollInterval || isSettling) return;
    colorResult.className = 'color-center pending';
    colorResult.textContent = '??';
    colorResult.style.background = '';
    colorResult.style.boxShadow = '';
    colorResult.style.borderColor = '';
    colorStage.style.animation = 'pulse-ring 3s ease-in-out infinite';
    rollInterval = setInterval(() => {
        const c = COLOR_CLASSES[Math.floor(Math.random() * 3)];
        colorResult.className = 'color-center';
        colorResult.textContent = '';
        colorResult.style.background = `var(--${c})`;
        colorResult.style.boxShadow = `0 0 30px var(--${c}-glow)`;
    }, 150);
}

function stopRolling() {
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
    colorResult.textContent = '??';
    colorResult.className = 'color-center pending';
    colorResult.style.background = '';
    colorResult.style.boxShadow = '';
    colorResult.style.borderColor = '';
    colorStage.style.background = 'conic-gradient(var(--red) 0deg 120deg, var(--green) 120deg 240deg, var(--blue) 240deg 360deg)';
    colorStage.style.boxShadow = '0 0 60px rgba(0,0,0,0.5), inset 0 0 60px rgba(0,0,0,0.4)';
    outcomeText.textContent = '';
    outcomeText.className = 'color-outcome-text';
    displayedOutcomeRoundId = null;
}

async function revealOutcome(args) {
    isSettling = true;
    stopRolling();
    const outcome = Number(args.winningOutcome);
    const settledRoundId = Number(args.roundId);

    colorResult.classList.remove('pending');
    let steps = 14;
    let delay = 50;
    const roll = () => {
        if (steps > 0) {
            const c = COLOR_CLASSES[Math.floor(Math.random() * 3)];
            colorResult.textContent = '';
            colorResult.style.background = `var(--${c})`;
            colorResult.style.boxShadow = `0 0 30px var(--${c}-glow)`;
            steps--;
            delay = Math.min(260, delay + 16);
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
                    startRolling();
                }
            }, 10000);
            isSettling = false;
        }
    };
    roll();
}

function showOutcome(outcome) {
    const name = COLOR_NAMES[outcome];
    const colorClass = COLOR_CLASSES[outcome];
    colorResult.textContent = '';
    colorResult.className = 'color-center';
    colorResult.style.background = `var(--${colorClass})`;
    colorResult.style.boxShadow = `0 0 40px var(--${colorClass}-glow), inset 0 0 30px rgba(0,0,0,0.35)`;
    colorResult.style.borderColor = `var(--${colorClass})`;

    colorStage.style.background = `conic-gradient(var(--${colorClass}) 0deg 360deg)`;
    colorStage.style.boxShadow = `0 0 80px var(--${colorClass}-glow), inset 0 0 60px rgba(0,0,0,0.4)`;

    outcomeText.textContent = `${name} WINS`;
    outcomeText.className = `color-outcome-text ${colorClass}`;
}

function flashRoundResult(roundId, outcome) {
    const addr = getAddress();
    if (!addr || roundId == null) return;

    getMyBets('color-duel', roundId, addr).then(bets => {
        if (!bets.length) return;
        const won = bets.some(b => !b.claimed && isWinningBet(b.betType, outcome));
        if (won) burstConfetti();
        refreshMyBets();
    }).catch(console.error);
}

function isWinningBet(betType, outcome) {
    return betType === outcome;
}

function showBanner(text, mood) {
    if (!roundStatusBanner) return;
    roundStatusBanner.textContent = text;
    roundStatusBanner.className = 'round-status-banner show ' + mood;
}

async function refreshState() {
    if (!appConfig) return null;
    try {
        const state = await getRoundState('color-duel');
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
    await renderHistory('myBetsList', getAddress(), 'color-duel');
}

function renderMyBets(items) {
    if (items.length === 0) {
        myBetsList.innerHTML = `<div class="my-bet" style="color:var(--text-secondary);">No active bets.</div>`;
        return;
    }

    myBetsList.innerHTML = '';
    items.forEach(item => {
        const color = COLOR_NAMES[item.betType];
        const amount = ethers.formatEther(item.amount);
        const div = document.createElement('div');
        div.className = 'my-bet';
        div.innerHTML = `
            <div>
                <div style="font-weight:700;">Round #${item.rid} — ${amount} ETH on ${color}</div>
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
            const state = await getRoundState('color-duel', item.rid);
            if (!state) continue;
            const statusEl = document.getElementById(`status-${item.rid}`);
            if (!statusEl) continue;

            if (state.voided) {
                statusEl.textContent = 'Round voided — claim refund';
                const btn = createActionButton('Refund', () => runClaim(claimRefund, 'color-duel', item.rid));
                statusEl.parentElement.appendChild(btn);
            } else if (state.settled) {
                const winner = isWinningBet(item.betType, state.winningOutcome);
                const color = COLOR_NAMES[state.winningOutcome];
                if (winner) {
                    statusEl.textContent = `Won — ${color}`;
                    const btn = createActionButton('Claim', () => runClaim(claimWinnings, 'color-duel', item.rid));
                    statusEl.parentElement.appendChild(btn);
                } else {
                    statusEl.textContent = `Lost — ${color}`;
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
