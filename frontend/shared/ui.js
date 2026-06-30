import { formatEth, getAddress } from './wallet.js';

const ethers = window.ethers;
const WS_PATH = '/ws/pool';

let ws = null;
let reconnectTimer = null;
let currentGame = 'dice';
let latestState = null;

const wsStatusDot = document.getElementById('wsStatus');
const wsStatusText = document.getElementById('wsStatusText');
const poolValue = document.getElementById('poolValue');
const poolBar = document.getElementById('poolBar');
const jackpotValue = document.getElementById('jackpotValue');
const bettorCount = document.getElementById('bettorCount');
const blocksLeft = document.getElementById('blocksLeft');
const roundLabel = document.getElementById('roundLabel');
const recentBetsList = document.getElementById('recentBetsList');

const SIDE_LABELS = {
    dice: { 0: 'over', 1: 'under' },
    'color-duel': { 0: 'red', 1: 'green', 2: 'blue' },
    crash: { 0: '1.5x', 1: '2x', 2: '3x', 3: '5x', 4: '10x' },
    plinko: { 0: 'zone' },
    roulette: { 0: 'red', 1: 'black', 2: 'even', 3: 'odd', 4: 'high', 5: 'low', 6: 'number' },
    'coin-flip': { 0: '0h', 1: '1h', 2: '2h', 3: '3h', 4: '4h', 5: '5h', 6: '6h+' },
    slots: { 0: 'exact', 1: 'triple', 2: 'pair', 3: 'first' },
    'horse-race': { 0: 'win', 1: 'place', 2: 'show', 3: 'exacta' },
    keno: { 0: 'm5', 1: 'm4', 2: 'm3', 3: 'm0' },
    'block-bingo': { 0: 'bingo' },
    minefield: { 0: 'safe', 1: 'mine' },
};

function setGame(gameKey) {
    currentGame = gameKey;
    connect();
}

function setConnected(connected) {
    if (connected) {
        wsStatusDot.classList.remove('disconnected');
        wsStatusText.textContent = 'Live events connected';
    } else {
        wsStatusDot.classList.add('disconnected');
        wsStatusText.textContent = 'Disconnected — reconnecting...';
    }
}

function connect() {
    if (ws) {
        try { ws.close(); } catch (e) {}
    }
    const url = `ws://${location.host}${WS_PATH}?game=${currentGame}`;
    ws = new WebSocket(url);

    ws.onopen = () => {
        setConnected(true);
        window.dispatchEvent(new CustomEvent('ws:open'));
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (e) {
            console.error('WS parse error', e);
        }
    };

    ws.onclose = () => {
        setConnected(false);
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error('WS error', err);
        setConnected(false);
    };
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 2000);
}

function handleMessage(data) {
    if (data.type === 'State') {
        latestState = data;
        updateStats(data);
        window.dispatchEvent(new CustomEvent('game:state', { detail: data }));
        return;
    }

    window.dispatchEvent(new CustomEvent('game:event', { detail: data }));

    if (data.type === 'BetPlaced') {
        addRecentBet(data.args);
    }
}

function updateStats(state) {
    roundLabel.textContent = `Round #${state.roundId}`;
    poolValue.textContent = formatEth(state.totalPool);
    jackpotValue.textContent = formatEth(state.jackpot);
    bettorCount.textContent = '—';

    const maxPool = ethers.parseEther('1');
    const pct = state.totalPool > maxPool ? 100 : Math.round((Number(state.totalPool) * 100) / Number(maxPool));
    poolBar.style.width = `${pct}%`;

    if (state.resolutionBlock && state.blockNumber !== undefined) {
        const left = Math.max(0, Number(state.resolutionBlock) - Number(state.blockNumber));
        blocksLeft.textContent = left.toString();
    } else {
        blocksLeft.textContent = '—';
    }
}

function addRecentBet(args) {
    const labels = SIDE_LABELS[currentGame] || {};
    const side = labels[args.betType] || `type${args.betType}`;
    const item = document.createElement('div');
    item.className = 'bet-item';
    item.innerHTML = `
        <span class="bet-player">${formatAddress(args.player)}</span>
        <span class="bet-amount">+${formatEth(args.amount)}</span>
        <span class="bet-side ${side}">${side}</span>
    `;
    recentBetsList.prepend(item);
    if (recentBetsList.children.length > 50) {
        recentBetsList.lastElementChild.remove();
    }
}

function formatAddress(addr) {
    if (!addr) return '0x...';
    const s = typeof addr === 'string' ? addr : addr.toString();
    return s.slice(0, 6) + '...' + s.slice(-4);
}

function sendPing() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send('ping');
    }
}

setInterval(sendPing, 30000);

export { setGame, connect, latestState, formatAddress };
