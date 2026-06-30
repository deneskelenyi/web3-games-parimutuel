import { getMyBets, getRoundState, claimWinnings, claimRefund, appConfig } from './contract.js';
import { refreshBalance, getAddress } from './wallet.js';

const ethers = window.ethers;

const GAME_NAMES = {
    dice: 'Dice O/U',
    'color-duel': 'Color Duel',
    crash: 'Crash',
    plinko: 'Plinko',
    roulette: 'Roulette',
    'coin-flip': 'Coin Flip',
    slots: 'Slots',
    'horse-race': 'Horse Race',
    keno: 'Keno',
    'block-bingo': 'Block Bingo',
    minefield: 'Minefield',
};

const GAME_ICONS = {
    dice: '🎲',
    'color-duel': '🎨',
    crash: '🚀',
    plinko: '🟡',
    roulette: '🎡',
    'coin-flip': '🪙',
    slots: '🎰',
    'horse-race': '🏇',
    keno: '🎱',
    'block-bingo': '🟥',
    minefield: '💣',
};

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// Live settlement results observed before the polling refresh confirms on-chain state.
// key: `${gameKey}:${roundId}` -> { outcome, winner }
const LIVE_SETTLEMENTS_KEY = 'parimutuel_live_settlements';

function loadLiveSettlements() {
    try {
        const raw = sessionStorage.getItem(LIVE_SETTLEMENTS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
    }
}

function saveLiveSettlements(data) {
    try {
        sessionStorage.setItem(LIVE_SETTLEMENTS_KEY, JSON.stringify(data));
    } catch (e) {
        console.error('Failed to persist live settlements', e);
    }
}

let liveSettlements = loadLiveSettlements();

function formatBet(gameKey, betType, betValue) {
    const t = Number(betType);
    const v = Number(betValue);
    switch (gameKey) {
        case 'dice':
            return t === 0 ? 'OVER' : 'UNDER';
        case 'color-duel':
            return ['RED', 'GREEN', 'BLUE'][t] || `type${t}`;
        case 'crash':
            return ['≥1.5x', '≥2x', '≥3x', '≥5x', '≥10x'][t] || `tier${t}`;
        case 'plinko':
            return `ZONE ${v}`;
        case 'roulette':
            if (t === 0) return 'RED';
            if (t === 1) return 'BLACK';
            if (t === 2) return 'EVEN';
            if (t === 3) return 'ODD';
            if (t === 4) return 'HIGH';
            if (t === 5) return 'LOW';
            if (t === 6) return `NUMBER ${v}`;
            return `type${t}`;
        case 'coin-flip':
            if (t === 6) return '6+ HEADS';
            return `${t} HEAD${t === 1 ? '' : 'S'}`;
        case 'slots':
            if (t === 0) return `EXACT TRIPLE ${v}`;
            if (t === 1) return 'ANY TRIPLE';
            if (t === 2) return `ANY PAIR ${v}`;
            if (t === 3) return `FIRST SYMBOL ${v}`;
            return `type${t}`;
        case 'horse-race':
            if (t === 3) {
                const first = (v >> 4) & 0xF;
                const second = v & 0xF;
                return `EXACTA ${first}→${second}`;
            }
            return `${['WIN', 'PLACE', 'SHOW'][t] || 'type' + t} HORSE ${v}`;
        case 'keno':
            return ['MATCH 5', 'MATCH 4', 'MATCH 3', 'MATCH 0'][t] || `type${t}`;
        case 'block-bingo':
            return 'BINGO CARD';
        case 'minefield':
            return `${t === 0 ? 'SAFE' : 'MINE'} CELL ${v}`;
        default:
            return `type${t}${v !== 0 ? ` value ${v}` : ''}`;
    }
}

function isWinningBet(gameKey, betType, betValue, outcome, player, roundId) {
    const t = Number(betType);
    const v = Number(betValue);
    const o = BigInt(outcome ?? 0);
    switch (gameKey) {
        case 'dice':
            if (Number(o) === 50) return false;
            if (t === 0) return Number(o) > 50;
            if (t === 1) return Number(o) < 50;
            return false;
        case 'color-duel':
            return t === Number(o);
        case 'crash':
            const co = Number(o);
            if (t === 0) return co >= 150;
            if (t === 1) return co >= 200;
            if (t === 2) return co >= 300;
            if (t === 3) return co >= 500;
            if (t === 4) return co >= 1000;
            return false;
        case 'plinko':
            return v === Number(o);
        case 'roulette':
            const ro = Number(o);
            if (ro === 0) return t === 6 && v === 0;
            if (t === 0) return RED_NUMBERS.has(ro);
            if (t === 1) return !RED_NUMBERS.has(ro);
            if (t === 2) return ro % 2 === 0;
            if (t === 3) return ro % 2 === 1;
            if (t === 4) return ro >= 19;
            if (t === 5) return ro <= 18;
            if (t === 6) return v === ro;
            return false;
        case 'coin-flip':
            const ho = Number(o);
            if (t === 6) return ho >= 6;
            return ho === t;
        case 'slots': {
            const s1 = Number((o >> 8n) & 0xFn);
            const s2 = Number((o >> 4n) & 0xFn);
            const s3 = Number(o & 0xFn);
            if (t === 0) return s1 === v && s2 === v && s3 === v;
            if (t === 1) return s1 === s2 && s2 === s3;
            if (t === 2) return [s1, s2, s3].filter(x => x === v).length >= 2;
            if (t === 3) return s1 === v;
            return false;
        }
        case 'horse-race': {
            const order = [];
            for (let i = 0; i < 6; i++) order.push(Number((o >> BigInt(i * 4)) & 0xFn));
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
        case 'keno': {
            const drawn = new Set();
            for (let i = 0; i < 10; i++) {
                drawn.add(Number((o >> BigInt(i * 6)) & 0x3Fn));
            }
            let matches = 0;
            for (let i = 0; i < 5; i++) {
                const pick = (Number(betValue) >> (i * 8)) & 0xFF;
                if (pick > 0 && pick <= 40 && drawn.has(pick)) matches++;
            }
            if (t === 0) return matches === 5;
            if (t === 1) return matches === 4;
            if (t === 2) return matches === 3;
            if (t === 3) return matches === 0;
            return false;
        }
        case 'block-bingo': {
            if (t !== 0 || !player || roundId == null) return false;
            const card = generateBingoCard(player, roundId);
            const drawn = new Set();
            for (let i = 0; i < 25; i++) {
                drawn.add(Number((o >> BigInt(i * 7)) & 0x7Fn));
            }
            return hasBingo(card, drawn);
        }
        case 'minefield': {
            const mines = new Set();
            for (let i = 0; i < 5; i++) mines.add(Number((o >> BigInt(i * 5)) & 0x1Fn));
            if (t === 0) return !mines.has(v);
            if (t === 1) return mines.has(v);
            return false;
        }
        default:
            return false;
    }
}

function generateBingoCard(player, roundId) {
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

function hasBingo(card, drawn) {
    const size = 5;
    const lineComplete = (indices) => indices.every(i => {
        const n = card[i];
        return n === 0 || drawn.has(n);
    });
    // rows
    for (let r = 0; r < size; r++) {
        if (lineComplete(Array.from({ length: size }, (_, c) => r * size + c))) return true;
    }
    // columns
    for (let c = 0; c < size; c++) {
        if (lineComplete(Array.from({ length: size }, (_, r) => r * size + c))) return true;
    }
    // diagonals
    if (lineComplete(Array.from({ length: size }, (_, i) => i * size + i))) return true;
    if (lineComplete(Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)))) return true;
    return false;
}

function outcomeDescription(gameKey, outcome) {
    const o = BigInt(outcome ?? 0);
    switch (gameKey) {
        case 'dice': {
            const n = Number(o);
            if (n === 50) return 'DEAD ZONE';
            return n > 50 ? 'OVER' : 'UNDER';
        }
        case 'color-duel':
            return ['RED', 'GREEN', 'BLUE'][Number(o)] || String(o);
        case 'crash':
            return (Number(o) / 100).toFixed(2) + 'x';
        case 'plinko':
            return `Zone ${Number(o)}`;
        case 'roulette': {
            const n = Number(o);
            if (n === 0) return '0 GREEN';
            const parts = [];
            parts.push(RED_NUMBERS.has(n) ? 'RED' : 'BLACK');
            parts.push(n % 2 === 0 ? 'EVEN' : 'ODD');
            parts.push(n >= 19 ? 'HIGH' : 'LOW');
            return `${n} ${parts.join(' • ')}`;
        }
        case 'coin-flip': {
            const n = Number(o);
            return `${n} HEAD${n === 1 ? '' : 'S'}`;
        }
        case 'slots': {
            const s1 = Number((o >> 8n) & 0xFn);
            const s2 = Number((o >> 4n) & 0xFn);
            const s3 = Number(o & 0xFn);
            return `${s1} ${s2} ${s3}`;
        }
        case 'horse-race': {
            const order = [];
            for (let i = 0; i < 6; i++) order.push(Number((o >> BigInt(i * 4)) & 0xFn));
            return `1st:${order[0]} 2nd:${order[1]} 3rd:${order[2]}`;
        }
        case 'keno': {
            const drawn = [];
            for (let i = 0; i < 10; i++) drawn.push(Number((o >> BigInt(i * 6)) & 0x3Fn));
            return drawn.slice(0, 5).join(', ') + ' ...';
        }
        case 'block-bingo': {
            const drawn = [];
            for (let i = 0; i < 25; i++) drawn.push(Number((o >> BigInt(i * 7)) & 0x7Fn));
            return drawn.slice(0, 6).join(', ') + ' ...';
        }
        case 'minefield': {
            const mines = [];
            for (let i = 0; i < 5; i++) mines.push(Number((o >> BigInt(i * 5)) & 0x1Fn));
            return `Mines: ${mines.join(', ')}`;
        }
        default:
            return String(o);
    }
}

async function fetchAllBets(address, roundLookback = 50) {
    if (!appConfig || !address) return [];
    const games = Object.keys(appConfig.contracts || {});
    const results = [];

    for (const gameKey of games) {
        try {
            const c = appConfig.contracts[gameKey];
            if (!c) continue;
            let currentRound = 0;
            try {
                const state = await getRoundState(gameKey);
                currentRound = state ? state.roundId : 0;
            } catch (e) {
                console.warn('history currentRound', gameKey, e);
                continue;
            }
            const start = Math.max(0, currentRound - roundLookback);
            for (let rid = currentRound; rid >= start; rid--) {
                let bets = [];
                try {
                    bets = await getMyBets(gameKey, rid, address);
                } catch (e) {
                    continue;
                }
                if (!bets.length) continue;
                let state = null;
                try {
                    state = await getRoundState(gameKey, rid);
                } catch (e) {
                    // round may not exist
                }
                for (let i = 0; i < bets.length; i++) {
                    results.push({ gameKey, roundId: rid, index: i, bet: bets[i], state });
                }
            }
        } catch (e) {
            console.error('history fetch game', gameKey, e);
        }
    }

    // Sort by roundId descending, then gameKey for stability.
    results.sort((a, b) => b.roundId - a.roundId || a.gameKey.localeCompare(b.gameKey) || a.index - b.index);
    return results;
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
            btn.textContent = '✓';
            setTimeout(() => btn.remove(), 1200);
        } catch (e) {
            console.error(e);
            alert(e?.reason || e?.message || `${label} failed`);
            btn.disabled = false;
            btn.textContent = label;
        }
    });
    return btn;
}

function recordLiveSettlement(gameKey, roundId, outcome, winner) {
    liveSettlements[`${gameKey}:${roundId}`] = { outcome, winner };
    saveLiveSettlements(liveSettlements);
}

async function renderHistory(containerId, address, highlightGameKey = null) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!address) {
        container.innerHTML = `<div class="my-bet" style="color:var(--text-secondary);">Connect wallet to see your bets.</div>`;
        return;
    }

    const placeholder = container.querySelector('.history-loading');
    if (!placeholder && container.children.length === 0) {
        container.innerHTML = `<div class="my-bet history-loading" style="color:var(--text-secondary);">Loading your bets...</div>`;
    }

    const items = await fetchAllBets(address);
    if (items.length === 0) {
        container.innerHTML = `<div class="my-bet" style="color:var(--text-secondary);">No bets yet.</div>`;
        return;
    }

    container.innerHTML = '';
    items.forEach(item => {
        const { gameKey, roundId, bet, state } = item;
        const amount = ethers.formatEther(bet.amount);
        const betLabel = formatBet(gameKey, bet.betType, bet.betValue);
        const isHighlight = gameKey === highlightGameKey;
        const gameName = GAME_NAMES[gameKey] || gameKey;
        const icon = GAME_ICONS[gameKey] || '🎰';

        const row = document.createElement('div');
        row.className = 'my-bet' + (isHighlight ? ' my-bet-current' : '');

        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:700;display:flex;align-items:center;gap:6px;';
        title.innerHTML = `<span>${icon}</span><span>${gameName}</span><span style="color:var(--text-secondary);font-weight:500;">Round #${roundId}</span>`;

        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'font-size:12px;color:var(--text-secondary);margin-top:3px;';
        subtitle.innerHTML = `Bet: <strong>${betLabel}</strong> • ${amount} ETH`;

        const statusEl = document.createElement('div');
        statusEl.className = 'my-bet-status';
        statusEl.style.cssText = 'margin-top:6px;';
        statusEl.dataset.game = gameKey;
        statusEl.dataset.round = roundId;
        statusEl.dataset.betType = bet.betType;
        statusEl.dataset.betValue = String(bet.betValue);

        const actions = document.createElement('div');
        actions.style.cssText = 'margin-left:12px;flex-shrink:0;';

        info.appendChild(title);
        info.appendChild(subtitle);
        info.appendChild(statusEl);
        row.appendChild(info);
        row.appendChild(actions);
        container.appendChild(row);

        const liveKey = `${gameKey}:${roundId}`;
        const live = liveSettlements[liveKey];
        const settled = state?.settled || live;
        const voided = state?.voided;

        const confirmedSettled = state?.settled;
        const confirmedVoided = state?.voided;
        const liveSettled = live && !confirmedSettled;

        if (!state || (!confirmedSettled && !confirmedVoided && !live)) {
            statusEl.innerHTML = `<span style="color:var(--text-secondary);">Round #${roundId} — awaiting settlement</span>`;
        } else if (confirmedVoided) {
            statusEl.innerHTML = `<span style="color:var(--gold);font-weight:700;">VOIDED</span> — refund available`;
            if (!bet.claimed) {
                const btn = createActionButton('Refund', async () => {
                    await claimRefund(gameKey, roundId);
                    await refreshBalance();
                    await renderHistory(containerId, address, highlightGameKey);
                });
                actions.appendChild(btn);
            } else {
                statusEl.innerHTML += ' <span style="color:var(--text-secondary);">(refunded)</span>';
            }
        } else if (confirmedSettled || live) {
            const outcome = confirmedSettled ? state.winningOutcome : live.outcome;
            const winner = confirmedSettled
                ? isWinningBet(gameKey, bet.betType, bet.betValue, outcome, address, roundId)
                : live.winner;
            const outcomeDesc = outcomeDescription(gameKey, outcome);
            if (winner) {
                if (confirmedSettled) {
                    statusEl.innerHTML = `<span style="color:var(--green);font-weight:700;">Won</span> — Outcome ${outcome} ${outcomeDesc}`;
                    if (!bet.claimed) {
                        const btn = createActionButton('Claim', async () => {
                            await claimWinnings(gameKey, roundId);
                            await refreshBalance();
                            await renderHistory(containerId, address, highlightGameKey);
                        });
                        actions.appendChild(btn);
                    } else {
                        statusEl.innerHTML += ' <span style="color:var(--text-secondary);">(claimed)</span>';
                    }
                } else {
                    statusEl.innerHTML = `<span style="color:var(--green);font-weight:700;">Won</span> — Outcome ${outcome} ${outcomeDesc} <span style="color:var(--text-secondary);">(confirming...)</span>`;
                }
            } else {
                statusEl.innerHTML = `<span style="color:var(--red);font-weight:700;">Lost</span> — Outcome ${outcome} ${outcomeDesc}`;
            }
        }
    });
}


// React to live settlement events so the My Bets panel updates immediately,
// even before the next polling refresh fetches the on-chain state and claim button.
window.addEventListener('game:event', (e) => {
    const d = e.detail;
    if (!d || d.type !== 'RoundSettled' || !d.args) return;
    const roundId = Number(d.args.roundId);
    const outcome = d.args.winningOutcome;
    const container = document.getElementById('myBetsList');
    if (!container) return;
    const player = getAddress();
    if (!player) return;

    const statuses = container.querySelectorAll(`.my-bet-status[data-round="${roundId}"]`);
    statuses.forEach((el) => {
        const gameKey = el.dataset.game;
        const betType = el.dataset.betType;
        const betValue = el.dataset.betValue;
        if (!gameKey || betType == null) return;
        const winner = isWinningBet(
            gameKey,
            Number(betType),
            betValue ? Number(betValue) : 0,
            outcome,
            player,
            roundId
        );
        recordLiveSettlement(gameKey, roundId, outcome, winner);
        const outcomeDesc = outcomeDescription(gameKey, outcome);
        if (winner) {
            el.innerHTML = `<span style="color:var(--green);font-weight:700;">Won</span> — Outcome ${outcome} ${outcomeDesc} <span style="color:var(--text-secondary);">(confirming...)</span>`;
        } else {
            el.innerHTML = `<span style="color:var(--red);font-weight:700;">Lost</span> — Outcome ${outcome} ${outcomeDesc}`;
        }
    });
});

// Re-render the shared My Bets panel whenever the wallet becomes available.
// Game modules also call renderHistory, but this catches tab switches where
// the wallet auto-connects after the game's initial render has already run.
window.addEventListener('wallet:connected', () => {
    const player = getAddress();
    if (!player) return;
    renderHistory('myBetsList', player);
});

export { renderHistory, formatBet, isWinningBet, outcomeDescription, fetchAllBets };
