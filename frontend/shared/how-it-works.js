/**
 * Shared "How It Works" modal. Each game page must include:
 *   <script type="module" src="/static/shared/how-it-works.js"></script>
 * and a button with id="howItWorksBtn".
 *
 * The modal is injected lazily on first open. Content is defined per game via
 * the data-game attribute on the <body> or on a container element.
 */

const GAME_CONTENT = {
  'dice': {
    title: 'How Dice O/U works',
    short: 'Predict whether the roll will be OVER or UNDER 50.',
    body: `
      <p><strong>Goal:</strong> bet whether the next dice roll lands OVER 50 (51–99) or UNDER 50 (0–49).</p>
      <p><strong>Dead zone:</strong> exactly 50 is a dead zone — the house keeps the pool and it rolls into the jackpot.</p>
      <p><strong>Parimutuel:</strong> every bet goes into one shared pool. Winners split the pool in proportion to how much they bet.</p>
      <p><strong>Settlement:</strong> the round closes after the configured number of blocks. The contract uses the settlement block hash as the random seed, so the outcome cannot be predicted when you bet.</p>
      <p><strong>Claims:</strong> after the round settles, winning bets show a <em>Claim</em> button. Click it to receive your share of the prize pool.</p>
    `,
  },
  'color-duel': {
    title: 'How Color Duel works',
    short: 'Pick RED, GREEN or BLUE. The dominant color wins.',
    body: `
      <p><strong>Goal:</strong> choose one of three colors: RED, GREEN or BLUE.</p>
      <p><strong>Outcome:</strong> the contract rolls one of the three colors. Players who picked the winning color split the pool.</p>
      <p><strong>Parimutuel:</strong> if nobody picks the winning color, the pool carries over into the jackpot. If everyone wins, everyone gets back at least their stake (minus house edge/bounty).</p>
      <p><strong>Settlement:</strong> each round resolves on its own resolution block using <code>blockhash(resolutionBlock)</code>.</p>
      <p><strong>Claims:</strong> winning bets can be claimed after settlement. Unclaimed bets stay on-chain until claimed or expired.</p>
    `,
  },
  'crash': {
    title: 'How Crash works',
    short: 'Pick a multiplier tier. Win if the rocket reaches it.',
    body: `
      <p><strong>Goal:</strong> choose a multiplier tier (1.5x, 2x, 3x, 5x or 10x). You win if the rocket crashes <em>at or above</em> your tier.</p>
      <p><strong>Outcome:</strong> the contract draws a crash multiplier. Lower tiers win more often but pay a smaller share; higher tiers win rarely but claim a larger share when they do.</p>
      <p><strong>Parimutuel:</strong> all wagers are in one pool. The winning tier(s) split the pool proportionally.</p>
      <p><strong>Instant crash:</strong> a crash value below 1.5x means no winners and the pool rolls into the jackpot.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> on a winning row after settlement.</p>
    `,
  },
  'plinko': {
    title: 'How Plinko works',
    short: 'Pick the landing zone (0–12).',
    body: `
      <p><strong>Goal:</strong> pick one of 13 landing zones (0–12).</p>
      <p><strong>Outcome:</strong> the contract drops a Plinko puck and reveals the zone it lands in. Only players who picked exactly that zone win.</p>
      <p><strong>Parimutuel:</strong> the winners split the pool proportionally. If nobody picked the winning zone, the pool carries over to the jackpot.</p>
      <p><strong>Rounds:</strong> each round is tied to a block window; betting closes at the resolution block.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> on a winning row after settlement.</p>
    `,
  },
  'roulette': {
    title: 'How Roulette works',
    short: 'Place multiple wagers: color, even/odd, high/low, or exact number.',
    body: `
      <p><strong>Goal:</strong> bet on the next roulette wheel spin. You can place several wagers at once: RED, BLACK, EVEN, ODD, HIGH (19–36), LOW (1–18), or an exact number (0–36).</p>
      <p><strong>Outcome:</strong> the wheel lands on a number 0–36. Outside bets (color/even/odd/high/low) win on their groups; exact-number bets only win if the number matches.</p>
      <p><strong>Zero rule:</strong> 0 is green. Outside bets lose on 0; only an exact 0 bet wins.</p>
      <p><strong>Parimutuel:</strong> all wagers share one pool. Every winning wager is paid proportionally from that pool.</p>
      <p><strong>Claims:</strong> after settlement, click <em>Claim</em> on any winning wager.</p>
    `,
  },
  'coin-flip': {
    title: 'How Coin Flip Streak works',
    short: 'Bet on how many heads appear in a streak of flips.',
    body: `
      <p><strong>Goal:</strong> predict the number of heads in a multi-flip streak. Choose 0, 1, 2, 3, 4, 5 or 6+ heads.</p>
      <p><strong>Outcome:</strong> the contract flips a virtual coin repeatedly and counts consecutive heads. Your bucket wins if the streak length matches.</p>
      <p><strong>Parimutuel:</strong> all stakes go into the same pool; winners in the correct bucket split the pool proportionally.</p>
      <p><strong>Jackpot:</strong> if nobody picked the winning bucket, the pool carries over.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> after settlement.</p>
    `,
  },
  'slots': {
    title: 'How Slots works',
    short: 'Bet on exact triples, any triple, pairs, or first symbol.',
    body: `
      <p><strong>Goal:</strong> predict the result of a three-reel slot spin.</p>
      <p><strong>Bet types:</strong></p>
      <ul>
        <li><strong>Exact triple</strong> — all three reels show your chosen symbol.</li>
        <li><strong>Any triple</strong> — any three matching symbols.</li>
        <li><strong>Any pair</strong> — at least two reels show your chosen symbol.</li>
        <li><strong>First symbol</strong> — the first reel shows your chosen symbol.</li>
      </ul>
      <p><strong>Parimutuel:</strong> the winning bet type(s) split the pool proportionally. Stronger bets (exact triple) win less often but get a larger share.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> on winning rows after settlement.</p>
    `,
  },
  'horse-race': {
    title: 'How Horse Race works',
    short: 'Bet WIN, PLACE, SHOW or EXACTA on six horses.',
    body: `
      <p><strong>Goal:</strong> predict the finishing order of a six-horse race.</p>
      <p><strong>Bet types:</strong></p>
      <ul>
        <li><strong>WIN</strong> — your horse finishes 1st.</li>
        <li><strong>PLACE</strong> — your horse finishes 1st or 2nd.</li>
        <li><strong>SHOW</strong> — your horse finishes 1st, 2nd or 3rd.</li>
        <li><strong>EXACTA</strong> — you pick the 1st and 2nd horses in exact order.</li>
      </ul>
      <p><strong>Parimutuel:</strong> the pool is shared; winners split it proportionally. Lower-risk bets (SHOW) win more often; EXACTA wins rarely.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> on winning rows after settlement.</p>
    `,
  },
  'keno': {
    title: 'How Keno works',
    short: 'Pick 5 numbers. Match as many as possible.',
    body: `
      <p><strong>Goal:</strong> the contract randomly draws 10 numbers from 1–40. You win if your 5 chosen numbers match a target count.</p>
      <p><strong>Bet types:</strong></p>
      <ul>
        <li><strong>Match 5</strong> — all 5 of your numbers are drawn.</li>
        <li><strong>Match 4</strong> — exactly 4 are drawn.</li>
        <li><strong>Match 3</strong> — exactly 3 are drawn.</li>
        <li><strong>Match 0</strong> — none of your numbers are drawn.</li>
      </ul>
      <p><strong>Parimutuel:</strong> all stakes are pooled; the winning match tier splits the pool proportionally.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> after settlement.</p>
    `,
  },
  'block-bingo': {
    title: 'How Block Bingo works',
    short: 'A 5×5 card and 25 drawn numbers. Get a line to win.',
    body: `
      <p><strong>Card:</strong> your card is deterministically generated from your address and the round ID. It contains 24 unique numbers plus a free center square.</p>
      <p><strong>Draw:</strong> the contract draws 25 unique numbers. If any row, column or diagonal on your card is fully marked (the free center counts), you have bingo and win.</p>
      <p><strong>Parimutuel:</strong> all bingo cards in the winning round share the pool proportionally.</p>
      <p><strong>Same card per round:</strong> reconnecting with the same wallet always gives the same card for a given round, but each round has different numbers.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> after settlement if you have bingo.</p>
    `,
  },
  'minefield': {
    title: 'How Minefield works',
    short: 'Pick a safe cell or a mined cell.',
    body: `
      <p><strong>Goal:</strong> the contract hides 5 mines on a 25-cell grid. Bet on a cell being SAFE or a cell being a MINE.</p>
      <p><strong>Outcome:</strong> when the round settles the 5 mine locations are revealed. SAFE bets win if their cell is not a mine; MINE bets win if their cell is a mine.</p>
      <p><strong>Parimutuel:</strong> the winning side splits the pool proportionally. If every cell is a mine or every cell is safe, the corresponding side wins the whole pool.</p>
      <p><strong>Claims:</strong> click <em>Claim</em> after settlement.</p>
    `,
  },
};

const COMMON_CONTENT = {
  title: 'How Parimutuel works',
  short: 'No house risk. Shared pool. Winners split proportionally.',
  body: `
    <p><strong>House never risks money.</strong> Players bet into a shared pool. After the round closes, the house takes a small cut, a settlement bounty is paid to whoever triggered settlement, and the remaining prize pool is split between winning bets in proportion to each bet size.</p>
    <p><strong>Jackpot carry-over.</strong> If a round has no winners, its prize pool rolls into a global jackpot. When a later round has winners, that jackpot is added to their prize pool and reset.</p>
    <p><strong>Fair RNG.</strong> Outcomes are derived from <code>blockhash(resolutionBlock)</code>. The resolution block is strictly in the future when betting, so the outcome cannot be predicted while bets are open.</p>
    <p><strong>Pull payments.</strong> The contract never iterates over all bettors during settlement. Each winner claims their own share individually, so gas stays low.</p>
    <p><strong>Demo wallet.</strong> You can try the app without MetaMask. The browser creates a random wallet, stores it locally, and the site tops it up with test ETH.</p>
  `,
};

function detectGame() {
  // Use the body data-game if present, otherwise fall back to the active tab.
  const bodyGame = document.body.dataset.game;
  if (bodyGame && GAME_CONTENT[bodyGame]) return bodyGame;
  const activeTab = document.querySelector('.game-tab.active');
  return activeTab?.dataset.game || 'dice';
}

function createModal() {
  if (document.getElementById('howItWorksModal')) return;

  const modal = document.createElement('div');
  modal.id = 'howItWorksModal';
  modal.className = 'how-it-works-modal';
  modal.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.75); backdrop-filter:blur(6px);
    display:none; align-items:center; justify-content:center; z-index:220; padding:16px;
  `;

  const content = document.createElement('div');
  content.className = 'how-it-works-content';
  content.style.cssText = `
    background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius);
    max-width:720px; width:100%; max-height:90vh; overflow-y:auto; padding:0;
    box-shadow:var(--shadow), 0 0 60px var(--accent-glow);
  `;

  modal.appendChild(content);
  document.body.appendChild(modal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      modal.style.display = 'none';
    }
  });
}

function openModal() {
  createModal();
  const modal = document.getElementById('howItWorksModal');
  const content = modal.querySelector('.how-it-works-content');
  const game = detectGame();
  const specific = GAME_CONTENT[game] || GAME_CONTENT['dice'];

  content.innerHTML = `
    <div style="padding:28px 32px 0;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:16px;">
        <div>
          <div style="font-family:'Orbitron',sans-serif; font-size:22px; font-weight:800; margin-bottom:6px;">${specific.title}</div>
          <div style="color:var(--text-secondary); font-size:14px;">${specific.short}</div>
        </div>
        <button id="closeHowItWorks" style="background:transparent; border:1px solid var(--border); border-radius:10px; width:36px; height:36px; color:var(--text-primary); font-size:20px; cursor:pointer;">×</button>
      </div>
    </div>
    <div style="padding:20px 32px 28px; color:var(--text-primary); font-size:14px; line-height:1.65;">
      ${specific.body}
      <hr style="border:none; border-top:1px solid var(--border); margin:24px 0;">
      ${COMMON_CONTENT.body}
    </div>
  `;

  content.querySelector('#closeHowItWorks').addEventListener('click', () => {
    modal.style.display = 'none';
  });

  modal.style.display = 'flex';
}

function initHowItWorks() {
  const btn = document.getElementById('howItWorksBtn');
  if (btn) {
    btn.addEventListener('click', openModal);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHowItWorks);
} else {
  initHowItWorks();
}

export { openModal, initHowItWorks };
