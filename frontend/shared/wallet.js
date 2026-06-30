const ethers = window.ethers;
const ANVIL_CHAIN_ID = 31337;
const BASE_SEPOLIA_CHAIN_ID = 84532;
const DEMO_WALLET_KEY = 'parimutuel_demo_wallet';

let provider = null;
let signer = null;
let address = null;
let chainId = null;
let targetChainId = ANVIL_CHAIN_ID;
let demoWallet = null;
let isDemo = false;

const connectBtn = document.getElementById('connectWalletBtn');
const disconnectBtn = document.getElementById('disconnectWalletBtn');
const walletInfo = document.getElementById('walletInfo');
const walletAddressEl = document.getElementById('walletAddress');
const walletBalanceEl = document.getElementById('walletBalance');
const walletModal = document.getElementById('walletModal');
const demoWalletBtn = document.getElementById('demoWalletBtn');
const metamaskWalletBtn = document.getElementById('metamaskWalletBtn');

function setTargetChain(id) {
    targetChainId = Number(id);
}

function formatAddress(addr) {
    if (!addr) return '0x...';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
}

function formatEth(wei) {
    if (wei === null || wei === undefined) return '0.000 ETH';
    const val = Number(ethers.formatEther(wei.toString()));
    return val.toFixed(4) + ' ETH';
}

async function refreshBalance() {
    if (!provider || !address) return;
    const bal = await provider.getBalance(address);
    walletBalanceEl.textContent = formatEth(bal);
}

async function ensureChain() {
    if (!window.ethereum) return;
    const chainHex = '0x' + targetChainId.toString(16);
    try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
    } catch (switchError) {
        if (switchError.code === 4902 && targetChainId === BASE_SEPOLIA_CHAIN_ID) {
            await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: chainHex,
                    chainName: 'Base Sepolia',
                    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
                    rpcUrls: ['https://sepolia.base.org'],
                    blockExplorerUrls: ['https://sepolia.basescan.org'],
                }],
            });
        } else {
            throw switchError;
        }
    }
}

async function connectWallet() {
    if (typeof window.ethereum === 'undefined') {
        alert('Please install MetaMask or another Web3 wallet.');
        return null;
    }

    await window.ethereum.request({ method: 'eth_requestAccounts' });
    await ensureChain();

    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    address = await signer.getAddress();
    const network = await provider.getNetwork();
    chainId = Number(network.chainId);
    isDemo = false;
    demoWallet = null;
    clearStoredDemoWallet();

    updateWalletUI();
    window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { address, provider, signer } }));

    window.ethereum.on('accountsChanged', async (accounts) => {
        if (accounts.length === 0) {
            address = null;
            signer = null;
            connectBtn.style.display = 'block';
            walletInfo.style.display = 'none';
        } else {
            signer = await provider.getSigner();
            address = await signer.getAddress();
            walletAddressEl.textContent = formatAddress(address);
            await refreshBalance();
            window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { address, provider, signer } }));
        }
    });

    window.ethereum.on('chainChanged', () => window.location.reload());

    return { address, provider, signer };
}

function getStoredDemoWallet() {
    try {
        const raw = localStorage.getItem(DEMO_WALLET_KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        console.error('Failed to read stored demo wallet', e);
        return null;
    }
}

function setStoredDemoWallet(privateKey, addr) {
    try {
        localStorage.setItem(DEMO_WALLET_KEY, JSON.stringify({ privateKey, address: addr }));
    } catch (e) {
        console.error('Failed to store demo wallet', e);
    }
}

function clearStoredDemoWallet() {
    try {
        localStorage.removeItem(DEMO_WALLET_KEY);
    } catch (e) {
        // localStorage may be unavailable in some contexts.
    }
}

async function connectDemoWallet(skipFunding = false) {
    // Try to restore an existing demo wallet so balance persists across tabs/refreshes.
    const stored = getStoredDemoWallet();
    let wallet;
    if (stored && stored.privateKey) {
        wallet = new ethers.Wallet(stored.privateKey);
    } else {
        wallet = ethers.Wallet.createRandom();
        setStoredDemoWallet(wallet.privateKey, wallet.address);
    }

    const config = await (await fetch('/api/config')).json();
    provider = new ethers.JsonRpcProvider(config.rpc_http_url);
    signer = wallet.connect(provider);
    address = await signer.getAddress();
    chainId = config.chain_id;
    isDemo = true;
    demoWallet = wallet;

    // Only drip on first creation or explicit request, not on every reconnect.
    if (!stored || !skipFunding) {
        const fundRes = await fetch('/api/faucet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address }),
        });
        if (!fundRes.ok) {
            const err = await fundRes.json();
            throw new Error(err.detail || 'Faucet failed');
        }
    }

    updateWalletUI(true);
    window.dispatchEvent(new CustomEvent('wallet:connected', { detail: { address, provider, signer, demo: true } }));
    return { address, provider, signer, demo: true };
}

async function fundDemoWallet() {
    if (!isDemo || !address) {
        throw new Error('Only demo wallets can be funded from the site');
    }

    const fundRes = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
    });
    if (!fundRes.ok) {
        const err = await fundRes.json();
        throw new Error(err.detail || 'Faucet failed');
    }
    const result = await fundRes.json();
    await refreshBalance();
    return result;
}

function updateWalletUI(demo = false) {
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'inline-block';
    walletInfo.style.display = 'flex';
    if (demo) {
        walletAddressEl.innerHTML = 'DEMO ' + formatAddress(address) + ' <span class="demo-badge">Demo</span>';
    } else {
        walletAddressEl.textContent = formatAddress(address);
    }
    if (walletModal) walletModal.style.display = 'none';
    refreshBalance();
    ensureFundButton(demo);
}

function ensureFundButton(demo) {
    let btn = document.getElementById('fundWalletBtn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'fundWalletBtn';
        btn.className = 'btn-primary';
        btn.style.cssText = 'margin-left:8px;background:linear-gradient(135deg,#00e0a0,#00b894);';
        btn.title = 'Top up demo wallet with test ETH';
        const walletBar = document.querySelector('.wallet-bar');
        if (walletBar) walletBar.appendChild(btn);
    }
    btn.textContent = '+ Fund Wallet';
    btn.style.display = demo ? 'inline-block' : 'none';
    btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = 'Funding...';
        try {
            await fundDemoWallet();
            btn.textContent = '+ Fund Wallet';
            window.dispatchEvent(new CustomEvent('wallet:funded'));
        } catch (e) {
            console.error(e);
            alert(e?.message || 'Funding failed');
            btn.textContent = '+ Fund Wallet';
        } finally {
            btn.disabled = false;
        }
    };
}

function disconnectWallet() {
    provider = null;
    signer = null;
    address = null;
    chainId = null;
    demoWallet = null;
    isDemo = false;
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
    walletInfo.style.display = 'none';
    const fundBtn = document.getElementById('fundWalletBtn');
    if (fundBtn) fundBtn.style.display = 'none';
    if (walletModal) walletModal.style.display = 'none';
    window.dispatchEvent(new CustomEvent('wallet:disconnected'));
}

function getProvider() { return provider; }
function getSigner() { return signer; }
function getAddress() { return address; }
function getChainId() { return chainId; }
function isDemoWallet() { return isDemo; }

async function tryAutoConnect() {
    // Prefer a stored demo wallet so users stay connected across game tabs/refreshes.
    const stored = getStoredDemoWallet();
    if (stored && stored.privateKey) {
        try {
            await connectDemoWallet(true);
            return;
        } catch (e) {
            console.error('Stored demo wallet reconnect failed', e);
            clearStoredDemoWallet();
        }
    }

    if (typeof window.ethereum === 'undefined') return;
    try {
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (accounts && accounts.length > 0) {
            await connectWallet();
        }
    } catch (e) {
        console.debug('Auto-connect failed', e);
    }
}

connectBtn.addEventListener('click', () => {
    if (walletModal) walletModal.style.display = 'flex';
});

if (metamaskWalletBtn) {
    metamaskWalletBtn.addEventListener('click', () => connectWallet().catch(e => {
        console.error(e);
        alert(e?.message || 'MetaMask connection failed');
    }));
}

if (demoWalletBtn) {
    demoWalletBtn.addEventListener('click', () => {
        demoWalletBtn.disabled = true;
        demoWalletBtn.innerHTML = '<span class="wallet-option-icon">⏳</span><span>Funding demo wallet...</span>';
        connectDemoWallet()
            .then(() => { demoWalletBtn.disabled = false; demoWalletBtn.innerHTML = '<span class="wallet-option-icon">🎲</span><span>Try Demo Wallet</span>'; })
            .catch(e => {
                console.error(e);
                alert(e?.message || 'Demo wallet failed');
                demoWalletBtn.disabled = false;
                demoWalletBtn.innerHTML = '<span class="wallet-option-icon">🎲</span><span>Try Demo Wallet</span>';
            });
    });
}

if (disconnectBtn) {
    disconnectBtn.addEventListener('click', disconnectWallet);
}

tryAutoConnect();

export { connectWallet, connectDemoWallet, disconnectWallet, tryAutoConnect, fundDemoWallet, getProvider, getSigner, getAddress, getChainId, isDemoWallet, setTargetChain, refreshBalance, formatEth, formatAddress };
