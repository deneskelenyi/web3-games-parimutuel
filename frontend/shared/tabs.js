const tabs = document.querySelectorAll('.game-tab');
const toast = document.getElementById('toast');

function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
}

function setActiveTab(gameKey) {
    tabs.forEach(tab => {
        if (tab.dataset.game === gameKey) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
}

function closeWalletModal() {
    const modal = document.getElementById('walletModal');
    if (modal) modal.style.display = 'none';
}

function isComingSoon(tab) {
    return tab.classList.contains('coming-soon') || tab.disabled;
}

tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
        const gameKey = tab.dataset.game;
        if (isComingSoon(tab)) {
            e.preventDefault();
            showToast(`${tab.textContent.replace('Soon', '').trim()} — coming next`);
            return;
        }
        // Close the wallet modal so navigation isn't visually blocked.
        closeWalletModal();
        setActiveTab(gameKey);
        // Anchor tags navigate by default; do not intercept normal clicks.
    });
});

export { setActiveTab, showToast };
