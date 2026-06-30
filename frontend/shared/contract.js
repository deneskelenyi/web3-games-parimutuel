import { getProvider, getSigner, refreshBalance } from './wallet.js';

const ethers = window.ethers;
let appConfig = null;
let abis = {};
let contracts = {};

async function loadConfig() {
    const res = await fetch('/api/config');
    appConfig = await res.json();
    return appConfig;
}

async function loadAbi(gameKey) {
    const res = await fetch(`/api/abi/${gameKey}`);
    if (!res.ok) throw new Error('Failed to load ABI');
    return await res.json();
}

async function _ensureAbi(gameKey) {
    if (!abis[gameKey]) {
        abis[gameKey] = await loadAbi(gameKey);
    }
    return abis[gameKey];
}

async function initContracts() {
    if (!appConfig) await loadConfig();

    const provider = getProvider();
    if (!provider) return contracts;

    for (const [key, address] of Object.entries(appConfig.contracts)) {
        if (!address) continue;
        const abi = await _ensureAbi(key);
        contracts[key] = {
            address,
            read: new ethers.Contract(address, abi, provider),
        };
    }
    return contracts;
}

function getContract(gameKey) {
    return contracts[gameKey]?.read;
}

async function getSignedContract(gameKey) {
    const signer = getSigner();
    if (!signer) throw new Error('Wallet not connected');
    const address = appConfig.contracts[gameKey];
    if (!address) throw new Error(`No contract address for ${gameKey}`);
    const abi = await _ensureAbi(gameKey);
    return new ethers.Contract(address, abi, signer);
}

async function getRoundState(gameKey, roundId) {
    const c = getContract(gameKey);
    if (!c) return null;
    const rid = roundId ?? await c.currentRoundId();
    const r = await c.rounds(rid);
    const jackpot = await c.jackpot();
    const bettorCount = await c.roundBettorCount(rid);
    return {
        roundId: Number(rid),
        resolutionBlock: Number(r[0]),
        totalPool: r[1],
        totalWinningBets: r[2],
        winningOutcome: Number(r[3]),
        prizePool: r[4],
        carryOverCount: Number(r[5]),
        settled: r[6],
        voided: r[7],
        hasWinners: r[8],
        jackpot,
        bettorCount: Number(bettorCount),
    };
}

async function placeBet(gameKey, betType, betValue, amountEth) {
    const c = await getSignedContract(gameKey);
    const value = ethers.parseEther(amountEth.toString());
    const tx = await c.placeBet(betType, betValue, { value });
    await tx.wait();
    await refreshBalance();
    return tx;
}

async function claimWinnings(gameKey, roundId) {
    const c = await getSignedContract(gameKey);
    const tx = await c.claimWinnings(roundId);
    await tx.wait();
    await refreshBalance();
    return tx;
}

async function claimRefund(gameKey, roundId) {
    const c = await getSignedContract(gameKey);
    const tx = await c.claimRefund(roundId);
    await tx.wait();
    await refreshBalance();
    return tx;
}

async function getMyBets(gameKey, roundId, player) {
    let c = getContract(gameKey);
    if (!c) {
        await initContracts();
        c = getContract(gameKey);
    }
    if (!c || !player) return [];
    const bets = await c.getPlayerBets(roundId, player);
    return bets.map((b, idx) => ({
        index: idx,
        betType: b.betType,
        betValue: b.betValue,
        amount: b.amount,
        claimed: b.claimed,
    }));
}

export {
    loadConfig,
    initContracts,
    getContract,
    getSignedContract,
    getRoundState,
    placeBet,
    claimWinnings,
    claimRefund,
    getMyBets,
    appConfig,
    abis,
};
