// Game state
const game = {
    playerWallet: 50000,
    uraniumRaw: 0,      // mined by Mine buildings
    uraniumRefined: 0,  // converted by Processor buildings; consumed by Plants
    maxStorage: 5000,   // total cap shared across raw + refined
    buildings: [],
    enemyBuildings: [],
    selectedMode: null,
    selectedCell: null,
    proximityRange: 2,
    round: 1,
    runLength: 8,                 // configurable: 8 days for standard run, adjust for events or shorter runs
    // Token economy
    totalTokenSupply: 1000000000, // 1 billion — the hard cap; tokens are MINTED from this reserve
    tokensIssued: 0,              // total ever drawn from the 1B reserve (wallets + income rewards)
    tokensBurned: 0,              // permanently destroyed by in-game spending
    // circulating = tokensIssued - tokensBurned
    // available   = totalTokenSupply - tokensIssued
    prizePool: 0,                 // funded by buy-ins + 10% of in-game spends
    // Conversion: how many in-game tokens equal $1 USDC. Configure for tests.
    tokensPerUSD: 2000,
    runEnded: false,              // flag to prevent multiple onRunEnd() calls
    siloStrikes: 0,               // number of strikes used this round
    maxSilosPerRound: 1,          // max number of strikes allowed per round
    lastStrikeTime: -999,         // track cooldown (ticks between strikes)
    strikesCooldown: 20,          // minimum ticks between strikes
    falloutZones: [],             // { id, endTime } array for radiation zones
    nuclearThreats: [],           // track players who used nukes for prestige

    // ── Buy-in / run entry ───────────────────────────────────────────────────
    // Every player (human or bot) pays this once to enter a run.
    // A run = runLength rounds (default 8), each lasting one real 24-hour day.
    // Their buy-in seeds the prize pool and the bonding curve pool directly.
    buyIn: 5000, // tunable — cost per player per run (in tokens)
    
    // ── Strike tracking ───────────────────────────────────────────────────────
    // Track nuke strikes per day for reset logic
    dayStrikes: 0,                // strikes used today (resets each day)

    // ── Player registry ───────────────────────────────────────────────────────
    // Single source of truth for all players in the current round.
    // BACKEND_STUB: On a real multiplayer backend this list is populated server-
    //   side (e.g. via WebSocket 'round:players' event) before the round starts.
    //   For now we build it locally in initPlayerRegistry().
    players: []
    // Each entry shape (see initPlayerRegistry for full object):
    // {
    //   id        : string  — unique ID ('local' for the human, UUID for remote)
    //   name      : string  — display name
    //   isLocal   : bool    — true only for the player on this client
    //   isBot     : bool    — true for AI-controlled players
    //   wallet    : number  — token balance
    //   paidBuyIn : bool    — has this player confirmed their entry fee?
    //   score     : number  — updated each tick for leaderboard
    // }
};

// Client-side password protection (hash only). Embeds SHA-256(hex) of the password
// so the plaintext is not present in source. This is still client-side only.
const EXPECTED_PASSWORD_HASH = 'b7e39e55e0913eff6b9aee210d3cb909df8da6b22ee6a8da8550bb35d4391ac4';

// Helper: compute SHA-256 hex using browser WebCrypto
async function sha256Hex(str) {
    const enc = new TextEncoder();
    const data = enc.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// daily accumulators for summary
game.dailyProduced = 0;
game.dailyIncome = 0;

// Simulation time and market
game.time = {
    day: 1,
    hour: 0,
    minute: 0,
    // minutes per real-second (simulation speed). Default 60 => 1 sec = 1 simulated hour
    // Default set to real-time: 1 simulated day (1440 minutes) = 86400 real seconds
    // => minutesPerSecond = 1440 / 86400 = 1/60 = 0.0166667
    minutesPerSecond: 0.0166667
};

game.market = {
    price: 1.00,
    baseTokenPrice: 1.00,    // price when pool is 100% full (bonding curve anchor)
    volatility: 0.03,        // hourly volatility (~3% per hour)
    // ----- Bonding curve / AMM pool -----
    // tokenPool represents available liquidity. As tokens are burned, the pool
    // shrinks and price rises inversely: price = baseTokenPrice * (poolInitial / pool).
    // When pool is 100% full  → price = baseTokenPrice ($1.00)
    // When pool is 50% full   → price = $2.00
    // When pool is 10% full   → price = $10.00  (scarcity premium)
    tokenPool: 1000,         // current available liquidity (tunable start)
    tokenPoolInitial: 1000,  // reference size — never changes
    // Each token spent drains the pool: drain = cost / POOL_BURN_RATE
    // Lower = more aggressive price impact. 50 → 1 Mine (800t) drains 16 units.
    poolBurnRate: 50         // tunable
};
// per-second volatility is smaller (for stock-like per-second ticks)
game.market.perSecondVol = game.market.volatility / 60;
// demand model parameters (legacy diurnal drift, kept for flavour)
game.market.baseDemand = 1000;
game.market.driftFactor = 0.0002; // reduced — bonding curve is now the main price driver

// Building type definitions
// Use emoji icons as a visual; we'll render monochrome SVG versions so they
// can be tinted to the player's theme color. `svg` gives consistent coloring.
const USE_SVG_ICONS = false; // use emoji characters instead of SVG shapes
const PLAYER_COLOR = '#ffb84d';
const ENEMY_COLOR = '#888888';

const buildingTypes = {
    mine: { cost: 800, emoji: '⛏️', color: '#4CAF50', power: 0, constructionTime: 1 },
    processor: { cost: 1200, emoji: '🏭', color: '#d98a3a', power: 0, constructionTime: 1.5 },
    storage: { cost: 1000, emoji: '🗄️', color: '#b08b4f', power: 0, constructionTime: 2 },
    plant: { cost: 1000, emoji: '☢️', color: '#ffb84d', power: 100, constructionTime: 2.2 },
    silo: { cost: 6000, emoji: '💥', color: '#ff0000', power: 0, constructionTime: 3.5, isWeapon: true }
};

// Display names used in UI (keep keys stable in logic)
const displayNames = {
    mine: 'Mine',
    processor: 'Plant',
    storage: 'Storage',
    plant: 'Reactor',
    silo: 'Silo'
};

// Enemy list (legacy — kept for spawnEnemyBuildings; names are drawn from game.players bots)
const enemies = [
    { name: 'PHANTOM_IX' },
    { name: 'NEUTRON_' }
];

// ─────────────────────────────────────────────────────────────────────────────
// Player Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the player list for the current run.
 *
 * BACKEND_STUB: In production this function is replaced by a server-sent
 *   payload (e.g. WebSocket 'run:join' -> 'run:players' handshake).
 *   The shape of each player object here intentionally matches what the backend
 *   would send, so swapping is straightforward:
 *
 *   socket.on('run:players', (players) => {
 *     game.players = players;
 *     renderLobbyPlayers();
 *   });
 */
function initPlayerRegistry() {
    game.players = [
        // ── Human player (this client) ───────────────────────────────────────
        {
            id: 'local',
            name: 'YOU',
            isLocal: true,
            isBot: false,
            wallet: game.playerWallet, // synced from game.playerWallet
            paidBuyIn: false,
            score: 0
        },
        // ── AI bots ──────────────────────────────────────────────────────────
        // BACKEND_STUB: replace with real remote players when backend is live.
        {
            id: 'bot-phantom',
            name: 'PHANTOM_IX',
            isLocal: false,
            isBot: true,
            wallet: 50000,
            paidBuyIn: false,
            score: 0
        },
        {
            id: 'bot-neutron',
            name: 'NEUTRON_',
            isLocal: false,
            isBot: true,
            wallet: 50000,
            paidBuyIn: false,
            score: 0
        }
    ];
}

/**
 * Collect buy-ins from all players and seed the prize pool + bonding curve pool.
 * Called once per run (a run = 8 rounds, each round lasting one real 24-hour day).
 *
 * Each player pays game.buyIn tokens:
 *  - 80% goes directly to the prize pool (what players compete for)
 *  - 20% drains the bonding curve pool (immediate price impact at run start)
 *
 * BACKEND_STUB: In production, buy-in deduction and prize pool seeding are
 *   authorised server-side. This client call would be:
 *   socket.emit('run:buyin', { playerId: 'local', amount: game.buyIn });
 *   …and server broadcasts the updated prizePool back to all clients.
 */
function initRun() {
    initPlayerRegistry();

    // ── Issue starting wallets from the 1B reserve ──────────────────────────────
    // Every player’s starting wallet balance is minted from the 1B supply pool.
    // This is the “purchase” event — tokens flow from reserve into circulation.
    // BACKEND_STUB: in production this issuance is authorised server-side and
    //   signed on-chain before wallets are credited.
    const startingWalletPerPlayer = 50000; // must match initPlayerRegistry wallet init
    game.tokensIssued += game.players.length * startingWalletPerPlayer;

    let totalBuyIn = 0;
    game.players.forEach(p => {
        if (p.isLocal) {
            // deduct from the human player's wallet
            game.playerWallet -= game.buyIn;
            p.wallet = game.playerWallet;
        } else {
            // bots auto-pay (wallet is local simulation only)
            p.wallet -= game.buyIn;
        }
        p.paidBuyIn = true;
        totalBuyIn += game.buyIn;
    });

    // 80% of all buy-ins seeds the prize pool
    const prizeContrib = Math.floor(totalBuyIn * 0.80);
    game.prizePool += prizeContrib;

    // 20% drains the bonding curve → price starts slightly above floor
    const poolDrain = Math.floor(totalBuyIn * 0.20) / game.market.poolBurnRate;
    game.market.tokenPool = Math.max(1, game.market.tokenPool - poolDrain);

    console.info(
        `Run started (Round ${game.round}/${game.runLength}) | Players: ${game.players.length} | ` +
        `Buy-in: ${game.buyIn.toLocaleString()} each | ` +
        `Prize pool seeded: ${prizeContrib.toLocaleString()} tokens`
    );
}

/**
 * Initialize the game grid
 */
function initGrid() {
    const grid = document.getElementById('gameGrid');
    grid.innerHTML = '';
    // generate a simple terrain map (grass / dirt / road)
    const terrain = generateTerrain(20, 20);
    game.terrain = terrain; // store so road-bonus checks work at runtime
    game.deposits = generateDeposits(20, 20); // Generate uranium deposits
    
    for (let i = 0; i < 400; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        // add terrain class for visuals (terrain-grass/terrain-dirt/terrain-road)
        const t = terrain[i] || 'grass';
        cell.classList.add('terrain-' + t);
        
        // Check if this cell has a deposit and add visual indicator
        const hasDeposit = game.deposits.find(d => d.cellId === i);
        if (hasDeposit) {
            cell.classList.add('has-deposit');
        }
        
        cell.tabIndex = -1;
        cell.dataset.id = i;
        cell.onclick = () => placeOrSelect(i);
        cell.addEventListener('mouseenter', (e) => onCellHover(i, e));
        cell.addEventListener('mousemove', (e) => onCellMove(i, e));
        cell.addEventListener('mouseleave', (e) => hideTooltip());
        grid.appendChild(cell);
    }

    // Spawn enemy buildings
    spawnEnemyBuildings();
}

/**
 * Spawn random enemy buildings on the grid
 */
function spawnEnemyBuildings() {
    const types = Object.keys(buildingTypes);
    const maxAttempts = 200;
    for (let i = 0; i < 5; i++) {
        let attempts = 0;
        let randomId = null;
        let type = null;
        const enemy = enemies[Math.floor(Math.random() * enemies.length)];

        // Pick a random non-road, unoccupied tile (give up after many attempts)
        while (attempts < maxAttempts) {
            attempts++;
            randomId = Math.floor(Math.random() * 400);
            type = types[Math.floor(Math.random() * types.length)];
            const terrainBlocked = game.terrain && (game.terrain[randomId] === 'road' || game.terrain[randomId] === 'road-h' || game.terrain[randomId] === 'road-x');
            const occupiedByEnemy = game.enemyBuildings.find(b => b.id === randomId);
            const occupiedByPlayer = game.buildings.find(b => b.id === randomId);
            if (!terrainBlocked && !occupiedByEnemy && !occupiedByPlayer) break;
        }

        if (attempts >= maxAttempts) {
            console.warn('spawnEnemyBuildings: could not find a valid non-road tile for spawn, skipping');
            continue;
        }

        game.enemyBuildings.push({ id: randomId, type, owner: enemy.name });
        renderBuilding(randomId, type, false);
    }
}

/**
 * Generate a simple terrain map for the grid.
 * Returns an array of length width*height with values 'grass'|'dirt'|'road'.
 */
function generateTerrain(width, height) {
    const out = new Array(width * height).fill('grass');
    // 1-tile-wide vertical road down the center column
    const centerX = Math.floor(width / 2);
    for (let y = 0; y < height; y++) {
        out[y * width + centerX] = 'road';
    }

    // 2 horizontal branches off the spine at random rows, random length (3–7 tiles each direction)
    const branchRows = [];
    while (branchRows.length < 2) {
        const row = 2 + Math.floor(Math.random() * (height - 4)); // avoid very top/bottom
        if (!branchRows.includes(row)) branchRows.push(row);
    }
    branchRows.forEach(row => {
        const len = 3 + Math.floor(Math.random() * 5); // 3–7 tiles each side
        // mark the junction cell as a crossroads
        out[row * width + centerX] = 'road-x';
        for (let dx = 1; dx <= len; dx++) {
            if (centerX - dx >= 0)     out[row * width + (centerX - dx)] = 'road-h'; // left
            if (centerX + dx < width)  out[row * width + (centerX + dx)] = 'road-h'; // right
        }
    });

    // scatter dirt patches (clusters)
    for (let i = 0; i < width * height * 0.08; i++) {
        const cx = Math.floor(Math.random() * width);
        const cy = Math.floor(Math.random() * height);
        const radius = 1 + Math.floor(Math.random() * 2);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = cx + dx; const y = cy + dy;
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    const idx = y * width + x;
                    if (out[idx] !== 'road' && out[idx] !== 'road-h' && out[idx] !== 'road-x' && Math.random() > 0.25) out[idx] = 'dirt';
                }
            }
        }
    }

    return out;
}

/**
 * Generate uranium ore deposits scattered across the map
 */
function generateDeposits(width, height) {
    const deposits = [];
    const numDeposits = 5 + Math.floor(Math.random() * 4); // 5-8 deposit clusters
    
    for (let d = 0; d < numDeposits; d++) {
        // Random deposit center
        const cx = 2 + Math.floor(Math.random() * (width - 4));
        const cy = 2 + Math.floor(Math.random() * (height - 4));
        const depositRadius = 1 + Math.floor(Math.random() * 2); // 1-2 cell radius
        
        // Generate deposit ore at this location
        for (let dy = -depositRadius; dy <= depositRadius; dy++) {
            for (let dx = -depositRadius; dx <= depositRadius; dx++) {
                if (Math.random() > 0.25) { // sparse within radius
                    const x = cx + dx;
                    const y = cy + dy;
                    if (x >= 0 && x < width && y >= 0 && y < height) {
                        const cellId = y * width + x;
                        // Skip roads
                        if (!['road', 'road-h', 'road-x'].includes(game.terrain[cellId])) {
                            deposits.push({ cellId, quality: 0.5 + Math.random() * 0.5 }); // 0.5-1.0 quality
                        }
                    }
                }
            }
        }
    }
    
    return deposits;
}

/**
 * Render uranium deposits visually on the grid
 */
function renderDeposits() {
    const grid = document.getElementById('gameGrid');
    game.deposits.forEach(deposit => {
        const cell = grid.querySelector(`[data-id="${deposit.cellId}"]`);
        if (cell) cell.classList.add('has-deposit');
    });
}

/**
 * Get mine deposit bonus based on proximity to nearest deposit
 * On deposit: 1.5x, 1 away: 1.25x, 2 away: 0.7x, 3+ away: 0.1x (extremely low)
 */
function getDepositBonus(mineId) {
    if (!game.deposits || game.deposits.length === 0) return 0.1; // no deposits = extremely low yield
    
    const mineCoords = getCoords(mineId);
    let minDist = Infinity;
    
    game.deposits.forEach(deposit => {
        const depCoords = getCoords(deposit.cellId);
        const dist = Math.max(Math.abs(mineCoords.x - depCoords.x), Math.abs(mineCoords.y - depCoords.y));
        if (dist < minDist) minDist = dist;
    });
    
    if (minDist === 0) return 1.5; // On deposit: excellent yield
    if (minDist === 1) return 1.25; // Adjacent: good yield
    if (minDist === 2) return 0.7; // 2 tiles away: reduced yield
    return 0.1; // 3+ tiles away: extremely poor yield
}

/**
 * Returns true if any orthogonal or diagonal neighbour of cellId is a road tile.
 * Used to grant reactors the road-proximity income bonus.
 */
function cellHasRoadNeighbor(cellId) {
    if (!game.terrain) return false;
    const COLS = 20;
    const x = cellId % COLS;
    const y = Math.floor(cellId / COLS);
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx; const ny = y + dy;
            if (nx < 0 || nx >= COLS || ny < 0 || ny >= COLS) continue;
            const t = game.terrain[ny * COLS + nx];
            if (t === 'road' || t === 'road-h' || t === 'road-x') return true;
        }
    }
    return false;
}

/**
 * Select a building type to place
 */
function selectBuilding(type) {
    game.selectedMode = type;
    updateButtonStates();
}

/**
 * Update button visual states
 */
function updateButtonStates() {
    // Reset active states for toolbar buttons and menu items
    document.querySelectorAll('.btn, .menu-item').forEach(el => {
        el.classList.remove('active');
        if (el.classList.contains('btn')) el.style.opacity = '';
    });

    // Highlight any element with a matching data-type
    if (game.selectedMode) {
        document.querySelectorAll('[data-type]').forEach(el => {
            if (el.dataset.type === game.selectedMode) {
                el.classList.add('active');
                if (el.classList.contains('btn')) el.style.opacity = '1';
            }
        });
    }
}

/**
 * Initialize actions popup menu behaviour (toggle, item clicks, accessibility)
 */
function initMenu() {
    if (initMenu._done) return; // prevent double-init (called by DOMContentLoaded + startGame)
    initMenu._done = true;
    console.log('initMenu(): initializing actions menu');
    const actionsBtn = document.getElementById('actionsMenuBtn');
    const actionsMenu = document.getElementById('actionsMenu');

    function setMenuOpen(open) {
        if (!actionsBtn || !actionsMenu) return;
        actionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) {
            // If a child inside the menu currently has focus, move it back to the toggle
            const active = document.activeElement;
            if (actionsMenu.contains(active)) {
                try { actionsBtn.focus(); } catch (e) { /* ignore */ }
            }
            // Mark hidden for AT and hide visually
            actionsMenu.setAttribute('aria-hidden', 'true');
            actionsMenu.style.display = 'none';
            actionsMenu.style.position = '';
            return;
        }
        // If mobile menu overlay class is present, remove it so dropdown can show
        try { document.body.classList.remove('mobile-menu-open'); } catch (e) { }
        // Opening: mark visible for AT then show and position
        actionsMenu.setAttribute('aria-hidden', 'false');
        // Show first so we can measure, then position fixed to avoid parent clipping
        actionsMenu.style.display = 'block';
        actionsMenu.style.position = 'fixed';
        actionsMenu.style.right = 'auto';
        actionsMenu.style.left = 'auto';
        // Compute placement to align right edge of menu with button
        const btnRect = actionsBtn.getBoundingClientRect();
        const menuWidth = actionsMenu.getBoundingClientRect().width || actionsMenu.offsetWidth || 220;
        // try to right-align with button, but keep on-screen
        let left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, btnRect.right - menuWidth));
        let top = btnRect.bottom + 8;
        // If there's not enough space below, try above
        if (top + actionsMenu.getBoundingClientRect().height > window.innerHeight - 8) {
            top = Math.max(8, btnRect.top - actionsMenu.getBoundingClientRect().height - 8);
        }
        actionsMenu.style.left = left + 'px';
        actionsMenu.style.top = top + 'px';
    }

    // expose setMenuOpen globally so inline fallbacks can delegate to the same logic
    try { window.setMenuOpen = setMenuOpen; } catch (e) { /* ignore */ }

    if (actionsBtn) {
        const toggleHandler = (e) => {
            if (e && e.preventDefault) e.preventDefault();
            const expanded = actionsBtn.getAttribute('aria-expanded') === 'true';
            setMenuOpen(!expanded);
            console.log('initMenu: actionsBtn toggle -> setMenuOpen', !expanded);
            if (e && e.stopPropagation) e.stopPropagation();
        };
        // click handles desktop; touchend handles mobile (iOS eats click when
        // parent has overflow-x:auto + -webkit-overflow-scrolling:touch)
        let _lastToggleTs = 0;
        const debouncedToggle = (e) => {
            const now = Date.now();
            if (now - _lastToggleTs < 600) return; // dedupe touchend → synthesized click
            _lastToggleTs = now;
            toggleHandler(e);
        };
        actionsBtn.addEventListener('touchend', debouncedToggle, { passive: false });
        actionsBtn.addEventListener('click', debouncedToggle);
        // ensure button is on top and tappable on small screens
        try {
            actionsBtn.style.zIndex = '1000';
            actionsBtn.style.touchAction = 'manipulation';
        } catch (e) { }
    }

    // Close when clicking outside (use bubble phase, not capture, so button click fires first)
    document.addEventListener('click', (e) => {
        if (!actionsMenu || !actionsBtn) return;
        if (!actionsMenu.contains(e.target) && !actionsBtn.contains(e.target)) {
            setMenuOpen(false);
        }
    }, false);

    // Menu item actions
    document.querySelectorAll('.menu-item').forEach(mi => {
        mi.addEventListener('click', (e) => {
            const type = mi.dataset.type;
            if (type) {
                selectBuilding(type);
            } else {
                if (mi.id === 'profileMenuItem') showProfile();
                if (mi.id === 'devMenuItem') toggleDevPanel();
            }
            setMenuOpen(false);
        });
    });

    // Keyboard: Escape closes menu
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') setMenuOpen(false);
    });
}

// Ensure initMenu is called when DOM is ready so the hamburger is wired early
window.addEventListener('DOMContentLoaded', () => {
    try {
        if (typeof initMenu === 'function') {
            initMenu();
            console.log('DOMContentLoaded: initMenu executed');
        }
    } catch (err) {
        console.warn('DOMContentLoaded: initMenu error', err);
    }

    // Shift+D+V secret shortcut to reveal/hide the Dev button
    const _devHeldKeys = new Set();
    document.addEventListener('keydown', (ev) => {
        _devHeldKeys.add(ev.key.toLowerCase());
        if (ev.shiftKey && _devHeldKeys.has('d') && _devHeldKeys.has('v')) {
            const devBtn = document.getElementById('devToggle');
            if (devBtn) {
                const hidden = devBtn.style.display === 'none' || devBtn.style.display === '';
                devBtn.style.display = hidden ? 'inline-flex' : 'none';
            }
        }
    });
    document.addEventListener('keyup', (ev) => {
        _devHeldKeys.delete(ev.key.toLowerCase());
    });
});

/**
 * Fallback toggle that can be called from inline onclick. Safe if initMenu already manages state.
 */
function toggleActionsMenu(e) {
    console.log('toggleActionsMenu called');
    const actionsBtn = document.getElementById('actionsMenuBtn');
    const actionsMenu = document.getElementById('actionsMenu');
    if (!actionsBtn || !actionsMenu) { console.warn('toggleActionsMenu: elements missing'); return; }
    const expanded = actionsBtn.getAttribute('aria-expanded') === 'true';
    const open = !expanded;
    // Delegate to the same placement logic used by initMenu
    if (typeof setMenuOpen === 'function') {
        try { setMenuOpen(open); } catch (err) {
            actionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            actionsMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
            actionsMenu.style.display = open ? 'block' : 'none';
        }
    } else {
        actionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        actionsMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
        actionsMenu.style.display = open ? 'block' : 'none';
        if (open) {
            actionsMenu.style.position = 'fixed';
            actionsMenu.style.left = '8px';
            actionsMenu.style.right = '8px';
            actionsMenu.style.top = '60px';
        }
    }
    if (e && e.stopPropagation) e.stopPropagation();
}

/**
 * Place a building or select a cell
 */
function placeOrSelect(id) {
    if (!game.selectedMode) return;

    const cell = document.querySelector('[data-id="' + id + '"]');

        if (game.selectedMode === 'sabotage') {
            const enemy = game.enemyBuildings.find(b => b.id === id);
            if (enemy) showSabotageMenu(id);
    } else if (game.selectedMode === 'strike') {
        // Strike mode: target enemy buildings in AoE
        executeNuclearStrike(id);
    } else {
        // For building placement, check that cell is empty
        if (cell.innerHTML && cell.innerHTML !== '') return; // Already occupied
        buildBuilding(id, game.selectedMode);
    }
}

/**
 * Build a building at the specified cell
 */
function buildBuilding(id, type) {
    // Special handling for silos (nuclear weapons)
    if (type === 'silo') {
        // Check if player has at least 1 completed reactor
        const completedReactors = game.buildings.filter(b => b.type === 'plant' && !b.isUnderConstruction).length;
        if (completedReactors === 0) {
            const cell = document.querySelector('[data-id="' + id + '"]');
            if (cell) {
                const rect = cell.getBoundingClientRect();
                const msg = `<div style="font-weight:700; color:#ff6b6b;">🔴 Weapons Grade Requirement</div>` +
                    `<div>You must have at least 1 completed Reactor to build a Silo.</div>`;
                showTooltipAt(rect.right + 8, rect.top, msg);
            }
            console.warn('Cannot build silo without completed reactor');
            return;
        }
        
        // Check if player hasn't exceeded max silos this round
        const existingSilos = game.buildings.filter(b => b.type === 'silo').length;
        if (existingSilos >= game.maxSilosPerRound) {
            const cell = document.querySelector('[data-id="' + id + '"]');
            if (cell) {
                const rect = cell.getBoundingClientRect();
                const msg = `<div style="font-weight:700; color:#ff6b6b;">🔴 Arsenal Limit Reached</div>` +
                    `<div>Maximum ${game.maxSilosPerRound} silo(s) per round.</div>`;
                showTooltipAt(rect.right + 8, rect.top, msg);
            }
            console.warn('Exceeded max silos per round');
            return;
        }
    }
    
    // disallow building directly on road tiles
    if (game.terrain && (game.terrain[id] === 'road' || game.terrain[id] === 'road-h' || game.terrain[id] === 'road-x')) {
        const cell = document.querySelector('[data-id="' + id + '"]');
        if (cell) {
            const rect = cell.getBoundingClientRect();
            const msg = `<div style="font-weight:700; color:#ff6b6b;">Cannot build on road</div>` +
                `<div>Building close to road access increases productivity.</div>`;
            showTooltipAt(rect.right + 8, rect.top, msg);
        }
        console.warn('Cannot build on road tile');
        return;
    }

    const cost = buildingTypes[type].cost;
    if (game.playerWallet < cost) {
        console.warn('Insufficient funds');
        return;
    }

    game.playerWallet -= cost;
    game.tokensBurned += cost;
    game.prizePool += Math.floor(cost * 0.10);
    // drain liquidity pool → pushes price up via bonding curve
    game.market.tokenPool = Math.max(1, game.market.tokenPool - cost / game.market.poolBurnRate);
    game.buildings.push({ 
        id, 
        type, 
        owner: 'YOU',
        constructionTimeRemaining: buildingTypes[type].constructionTime,
        isUnderConstruction: true
    });

    if (type === 'storage') {
        game.maxStorage += 1000;
    }

    const building = game.buildings.find(b => b.id === id && b.type === type);
    renderBuilding(id, type, true, building);
    calculateProximity();
    updateUI();
    game.selectedMode = null;
}

/**
 * Show sabotage attack menu for enemy building
 */
function showSabotageMenu(cellId) {
    const enemy = game.enemyBuildings.find(b => b.id === cellId);
    if (!enemy) return;

    const cell = document.querySelector('[data-id="' + cellId + '"]');
    if (!cell) return;

    const rect = cell.getBoundingClientRect();
    
    // Create menu
    const menu = document.createElement('div');
    menu.className = 'sabotage-menu';
    menu.style.cssText = `
        position: fixed;
        left: ${rect.right + 8}px;
        top: ${rect.top}px;
        background: rgba(0, 0, 0, 0.95);
        border: 1px solid #f57c00;
        border-radius: 4px;
        padding: 8px 0;
        z-index: 100;
        min-width: 240px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.8);
    `;

    const completedSilo = game.buildings.find(b => b.type === 'silo' && !b.isUnderConstruction);
    const tempDisableCost = 300;
    const stealCost = 500;
    const nukeCost = Math.floor(game.playerWallet * 0.5);

    // Option 1: Temporary Disable
    const tempOption = document.createElement('div');
    tempOption.style.cssText = `
        padding: 10px 14px;
        cursor: pointer;
        color: #fff;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        transition: background 0.1s;
    `;
    tempOption.innerHTML = `<div style="font-weight:600; color:#ffa500;">⏸️ Disable</div><div style="font-size:12px; color:#aaa; margin-top:2px;">Production -50% for 45s (costs $${tempDisableCost})</div>`;
    tempOption.onmouseover = () => tempOption.style.background = 'rgba(255, 124, 0, 0.1)';
    tempOption.onmouseout = () => tempOption.style.background = '';
    tempOption.onclick = () => {
        executeTemporaryDisable(cellId, tempDisableCost);
        menu.remove();
    };
    menu.appendChild(tempOption);

    // Option 2: Steal Resources
    const stealOption = document.createElement('div');
    stealOption.style.cssText = `
        padding: 10px 14px;
        cursor: pointer;
        color: #fff;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        transition: background 0.1s;
    `;
    stealOption.innerHTML = `<div style="font-weight:600; color:#4db8ff;">💰 Steal</div><div style="font-size:12px; color:#aaa; margin-top:2px;">Steal ~50 U from enemy (costs $${stealCost})</div>`;
    stealOption.onmouseover = () => stealOption.style.background = 'rgba(77, 184, 255, 0.1)';
    stealOption.onmouseout = () => stealOption.style.background = '';
    stealOption.onclick = () => {
        executeStealResources(cellId, stealCost);
        menu.remove();
    };
    menu.appendChild(stealOption);

    // Option 3: Nuclear Strike (only if silo exists)
    if (completedSilo) {
        const nukeOption = document.createElement('div');
        nukeOption.style.cssText = `
            padding: 10px 14px;
            cursor: pointer;
            color: #fff;
            transition: background 0.1s;
        `;
        nukeOption.innerHTML = `<div style="font-weight:600; color:#ff4444;">💥 NUKE</div><div style="font-size:12px; color:#aaa; margin-top:2px;">Destroy in AoE + fallout (costs $${nukeCost})</div>`;
        nukeOption.onmouseover = () => nukeOption.style.background = 'rgba(255, 0, 0, 0.2)';
        nukeOption.onmouseout = () => nukeOption.style.background = '';
        nukeOption.onclick = () => {
            executeNuclearStrike(cellId);
            menu.remove();
        };
        menu.appendChild(nukeOption);
    } else {
        const nukeOption = document.createElement('div');
        nukeOption.style.cssText = `
            padding: 10px 14px;
            color: #666;
            border-bottom: none;
        `;
        nukeOption.innerHTML = `<div style="font-weight:600; color:#666;">💥 NUKE (Locked)</div><div style="font-size:12px; color:#555; margin-top:2px;">Requires completed Silo</div>`;
        menu.appendChild(nukeOption);
    }

    document.body.appendChild(menu);

    // Close menu when clicking elsewhere
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            game.selectedMode = null;
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

/**
 * Temporary disable: reduce enemy production by 50% for 45 seconds
 */
function executeTemporaryDisable(cellId, cost) {
    const enemy = game.enemyBuildings.find(b => b.id === cellId);
    if (!enemy) return;

    if (game.playerWallet < cost) {
        console.warn('Insufficient funds');
        return;
    }

    game.playerWallet -= cost;
    game.tokensBurned += cost;
    game.prizePool += Math.floor(cost * 0.10);
    game.market.tokenPool = Math.max(1, game.market.tokenPool - cost / game.market.poolBurnRate);

    // Mark enemy as disabled
    if (!enemy.disabled) {
        enemy.disabled = { endTime: Date.now() + 45000, multiplier: 0.5 };
    }

    console.info(`⏸️ Temporary disable on ${enemy.type} for 45s`);
    updateUI();
    game.selectedMode = null;
}

/**
 * Steal resources: take uranium from enemy
 */
function executeStealResources(cellId, cost) {
    const enemy = game.enemyBuildings.find(b => b.id === cellId);
    if (!enemy) return;

    if (game.playerWallet < cost) {
        console.warn('Insufficient funds');
        return;
    }

    game.playerWallet -= cost;
    game.tokensBurned += cost;
    game.prizePool += Math.floor(cost * 0.10);
    game.market.tokenPool = Math.max(1, game.market.tokenPool - cost / game.market.poolBurnRate);

    // Steal uranium
    const stolen = 25 + Math.random() * 50; // 25-75 uranium
    game.uraniumRaw += stolen;

    console.info(`💰 Stole ${stolen.toFixed(1)} uranium from enemy`);
    updateUI();
    game.selectedMode = null;
}

/**
 * Execute a nuclear strike on target cell
 * Destroys all enemy buildings within AoE radius + applies radiation fallout
 */
function executeNuclearStrike(targetId) {
    // Check cooldown
    if (game.dayStrikes >= game.maxSilosPerRound) {
        console.warn('Strike cooldown active');
        return;
    }
    
    // Check for completed silo available
    const completedSilo = game.buildings.find(b => b.type === 'silo' && !b.isUnderConstruction);
    if (!completedSilo) {
        console.warn('No completed silo available');
        return;
    }
    
    // Strike cost: 40-60% of current wallet
    const costPercent = 0.5; // 50% for balanced gameplay
    const strikeCost = Math.floor(game.playerWallet * costPercent);
    
    if (game.playerWallet < strikeCost) {
        console.warn('Insufficient funds for nuclear strike');
        return;
    }
    
    // Deduct cost
    game.playerWallet -= strikeCost;
    game.tokensBurned += strikeCost;
    game.prizePool += Math.floor(strikeCost * 0.10);
    game.market.tokenPool = Math.max(1, game.market.tokenPool - strikeCost / game.market.poolBurnRate);
    
    // Execute strike
    triggerNuclearExplosion(targetId);
    
    // Update tracking
    game.dayStrikes++;
    const playerName = game.players.find(p => p.isLocal)?.name || 'YOU';
    if (!game.nuclearThreats.includes(playerName)) {
        game.nuclearThreats.push(playerName);
    }
    
    game.selectedMode = null;
    updateUI();
}

/**
 * Trigger explosion and AoE destruction
 */
function triggerNuclearExplosion(centerId) {
    const strikeRadius = 4; // cells
    const coords = getCoords(centerId);
    
    // Calculate target buildings in radius
    const destroyed = [];
    game.enemyBuildings = game.enemyBuildings.filter(b => {
        const bCoords = getCoords(b.id);
        const dist = Math.max(Math.abs(bCoords.x - coords.x), Math.abs(bCoords.y - coords.y));
        if (dist <= strikeRadius) {
            destroyed.push(b);
            return false; // Remove from array
        }
        return true;
    });
    
    // Visual effects: red flash and screen shake
    playNuclearEffects();
    
    // Clear destroyed buildings from display
    destroyed.forEach(b => {
        const cell = document.querySelector('[data-id="' + b.id + '"]');
        if (cell) {
            cell.innerHTML = '';
            cell.className = 'cell';
        }
    });
    
    // Apply radiation fallout: −50% production for 120 seconds
    const falloutTime = 120; // seconds
    const falloutRadius = strikeRadius + 1; // slightly larger radius
    game.buildings.forEach(b => {
        if (!b.isUnderConstruction && (b.type === 'mine' || b.type === 'processor')) {
            const bCoords = getCoords(b.id);
            const dist = Math.max(Math.abs(bCoords.x - coords.x), Math.abs(bCoords.y - coords.y));
            if (dist <= falloutRadius) {
                if (!b.fallout) {
                    b.fallout = { endTime: Date.now() + (falloutTime * 1000), multiplier: 0.5 };
                }
            }
        }
    });
    
    console.info(`💥 Nuclear strike at cell ${centerId}! ${destroyed.length} enemy buildings destroyed.`);
}

/**
 * Play nuclear effect visuals/audio
 */
function playNuclearEffects() {
    // Full-screen red flash
    const flash = document.createElement('div');
    flash.style.cssText = `
        position: fixed; left: 0; top: 0; right: 0; bottom: 0;
        background: rgba(255, 0, 0, 0.8);
        z-index: 8000;
        animation: fadeOut 0.6s ease-out;
        pointer-events: none;
    `;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 600);
    
    // Screen shake
    const originalTransform = document.body.style.transform;
    for (let i = 0; i < 10; i++) {
        setTimeout(() => {
            const x = (Math.random() - 0.5) * 20;
            const y = (Math.random() - 0.5) * 20;
            document.body.style.transform = `translate(${x}px, ${y}px)`;
        }, i * 30);
    }
    setTimeout(() => {
        document.body.style.transform = originalTransform;
    }, 300);
}

/**
 * Render a building on the grid
 */
function renderBuilding(id, type, isPlayer, building) {
    const cell = document.querySelector('[data-id="' + id + '"]');
    cell.className = 'cell owned ' + type + (isPlayer ? ' owned-player' : ' owned-enemy');

    // Check if building is under construction
    const isUnderConstruction = building && building.isUnderConstruction;
    
    if (isUnderConstruction && building) {
        // Render progress circle
        const progress = 1 - (building.constructionTimeRemaining / buildingTypes[type].constructionTime);
        const circumference = 2 * Math.PI * 45; // 45 = radius
        const strokeDashoffset = circumference * (1 - progress);
        
        const tint = isPlayer ? PLAYER_COLOR : ENEMY_COLOR;
        const emoji = buildingTypes[type].emoji || '';
        
        cell.innerHTML = `
            <div style="position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                <svg style="position: absolute; width: 100%; height: 100%; top: 0; left: 0;" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3"/>
                    <circle cx="50" cy="50" r="45" fill="none" stroke="${tint}" stroke-width="3" 
                            stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}"
                            stroke-linecap="round" style="transition: stroke-dashoffset 0.1s linear; transform: rotate(-90deg); transform-origin: 50px 50px;"/>
                </svg>
                <span class="icon-emoji" style="font-size: 20px; z-index: 1; opacity: 0.6;">${emoji}</span>
            </div>
        `;
    } else {
        // Render normal building
        const tint = isPlayer ? PLAYER_COLOR : ENEMY_COLOR;
        if (USE_SVG_ICONS || type === 'storage') {
            const svg = getIconSVG(type, tint);
            cell.innerHTML = svg;
        } else {
            const emoji = buildingTypes[type].emoji || '';
            cell.innerHTML = `<span class="icon-emoji" style="color:${tint};">${emoji}</span>`;
        }
    }
}

// Return a small inline SVG string for the given building type, monochrome so
// it can be tinted via `fill`.
function getIconSVG(type, fill) {
    // Keep SVGs simple and small for grid clarity.
    if (type === 'mine') {
        return `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><path fill="${fill}" d="M2 20h20L12 6 2 20z"/></svg>`;
    }
    if (type === 'processor') {
        return `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="6" fill="${fill}"/></svg>`;
    }
    if (type === 'storage') {
        // Silo / vault style storage icon (tintable)
        return `<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg"><ellipse cx="12" cy="4.5" rx="6" ry="2" fill="${fill}"/><rect x="6" y="4.5" width="12" height="13" rx="2" ry="2" fill="${fill}"/><path d="M9 9h6v6H9z" fill="#ffffff" opacity="0.12"/></svg>`;
    }
    // plant / reactor
    return `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><path fill="${fill}" d="M12 2c-1.1 0-2 .9-2 2v3H8c-1.1 0-2 .9-2 2v3h12V9c0-1.1-.9-2-2-2h-2V4c0-1.1-.9-2-2-2z"/></svg>`;
}

/**
 * Get grid coordinates from cell ID
 */
function getCoords(id) {
    return { x: id % 20, y: Math.floor(id / 20) };
}

/**
 * Calculate distance between two cells (Chebyshev distance)
 */
function distance(id1, id2) {
    const c1 = getCoords(id1);
    const c2 = getCoords(id2);
    return Math.max(Math.abs(c1.x - c2.x), Math.abs(c1.y - c2.y));
}

/**
 * Calculate proximity bonuses and penalties
 */
function calculateProximity() {
    document.querySelectorAll('.cell').forEach(c => {
        c.classList.remove('bonus', 'penalty');
    });

    game.buildings.forEach(building => {
        let bonus = 0;
        let penalty = 0;

        // Count nearby same-type buildings
        game.buildings.forEach(other => {
            if (building.id !== other.id && building.type === other.type) {
                if (distance(building.id, other.id) <= game.proximityRange) {
                    bonus++;
                }
            }
        });

        // Count nearby enemy buildings
        game.enemyBuildings.forEach(enemy => {
            if (distance(building.id, enemy.id) <= game.proximityRange) {
                penalty++;
            }
        });

        const cell = document.querySelector('[data-id="' + building.id + '"]');
        if (bonus > 0) cell.classList.add('bonus');
        if (penalty > 0) cell.classList.add('penalty');
    });
}

/**
 * Calculate total power output
 */
function calculatePower() {
    let totalPower = 0;
    let totalMines = 0;
    let totalProcessors = 0;

    game.buildings.forEach(building => {
        // Only count completed buildings for power calculation
        if (building.isUnderConstruction) return;
        
        if (building.type === 'plant') {
            let penalty = 0;
            game.enemyBuildings.forEach(enemy => {
                if (distance(building.id, enemy.id) <= game.proximityRange) {
                    penalty++;
                }
            });
            // base power reduced by nearby enemy penalty
            const base = 100 - (penalty * 20);
            // slight jitter so power fluctuates a bit (not game-breaking)
            const jitter = Math.sin((Date.now() / 1000) + building.id) * 2; // -2..2
            // road-proximity bonus: reactor next to a road tile sells power to more customers (+40%)
            const roadMult = cellHasRoadNeighbor(building.id) ? 1.4 : 1.0;
            const power = Math.max(0, base + jitter) * roadMult;
            totalPower += power;
        } else if (building.type === 'mine') {
            totalMines++;
        } else if (building.type === 'processor') {
            totalProcessors++;
        }
    });

    // Simplified: power is computed from plants and proximity; do NOT modify
    // uraniumRaw/uraniumRefined here — production/consumption is handled in productionTick.
    return totalPower;
}

/**
 * Update UI with current game state
 */
function updateUI() {
    document.getElementById('wallet').textContent = game.playerWallet.toLocaleString();
    document.getElementById('uranium').textContent = formatUranium(game.uraniumRaw) + ' / ' + formatUranium(game.uraniumRefined);
    const totalStored = game.uraniumRaw + game.uraniumRefined;
    document.getElementById('stored').textContent = formatUranium(totalStored) + '/' + formatUranium(game.maxStorage);
    
    const power = calculatePower();
    // show power with one decimal place to avoid long floats
    document.getElementById('power').textContent = power.toFixed(1) + ' MW';
    // time and market
    const hh = String(Math.floor(game.time.hour)).padStart(2, '0');
    const mm = String(Math.floor(game.time.minute)).padStart(2, '0');
    // derive seconds from fractional minute
    const fractionalMinute = game.time.minute - Math.floor(game.time.minute);
    const ss = String(Math.floor(fractionalMinute * 60)).padStart(2, '0');
    const timeEl = document.getElementById('time');
    if (timeEl) timeEl.textContent = hh + ':' + mm + ':' + ss;
    const dayEl = document.getElementById('day');
    if (dayEl) dayEl.textContent = game.time.day;
    const marketEl = document.getElementById('marketPrice');
    if (marketEl) {
        marketEl.textContent = '$' + game.market.price.toFixed(2);
        // color up/down compared to previous price (if available)
        if (game.market.prevPrice === undefined) {
            marketEl.style.color = '';
        } else if (game.market.price > game.market.prevPrice) {
            marketEl.style.color = '#4CAF50';
        } else if (game.market.price < game.market.prevPrice) {
            marketEl.style.color = '#ff6b6b';
        } else {
            marketEl.style.color = '';
        }
    }
    // income display (last production tick)
    const incomeEl = document.getElementById('income');
    if (incomeEl) incomeEl.textContent = (game.lastIncome || 0).toLocaleString();

    // portfolio value = wallet + uranium * market.price
    const portfolioEl = document.getElementById('portfolio');
    if (portfolioEl) {
        const value = game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price);
        portfolioEl.textContent = '$' + value.toFixed(2).toLocaleString();
    }

    // Token economy stats
    const circulatingEl = document.getElementById('circulating');
    if (circulatingEl) {
        // circulating = tokens that have left the 1B reserve minus what's been burned
        const circ = Math.max(0, game.tokensIssued - game.tokensBurned);
        circulatingEl.textContent = formatSupply(circ);
    }
    const prizePoolEl = document.getElementById('prizePool');
    if (prizePoolEl) {
        prizePoolEl.textContent = formatPrizePool(game.prizePool);
        prizePoolEl.title = `Approximate fiat equivalent at ${game.tokensPerUSD.toLocaleString()} tokens = $1 USDC`;
    }
    // Update compact mobile stats bar (mobile portrait only)
    const mobileStats = document.getElementById('mobileStatsCompact');
    if (mobileStats) {
        if (window.innerWidth <= 700) {
            const portfolio = (game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price)) || 0;
            const timeStr = `${String(game.time.hour).padStart(2,'0')}:${String(game.time.minute).padStart(2,'0')}`;
            const totalPower = game.buildings.filter(b => b.type === 'plant' && !b.isUnderConstruction)
                .reduce((s) => s + (buildingTypes.plant.power || 0), 0);
            const prizeStr = typeof formatPrizePool === 'function' ? formatPrizePool(game.prizePool) : game.prizePool.toLocaleString();
            mobileStats.innerHTML = [
                `<span class="ms-stat"><span class="ms-label">Round</span><span class="ms-val">${game.round}/${game.runLength}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Day</span><span class="ms-val">${game.time.day}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Time</span><span class="ms-val">${timeStr}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Tokens</span><span class="ms-val">${game.playerWallet.toLocaleString()}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Power</span><span class="ms-val">${totalPower}MW</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Market</span><span class="ms-val">$${game.market.price.toFixed(2)}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Prize</span><span class="ms-val ms-val--amber">${prizeStr}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Portfolio</span><span class="ms-val">$${portfolio.toFixed(2)}</span></span>`,
            ].join('');
            mobileStats.style.display = 'flex';
        } else {
            mobileStats.style.display = 'none';
        }
    }
}

/**
 * Format a large token number as a compact string: 1B, 999.9M, 1.5M, 659K, 500
 * Used anywhere the 1-billion supply is displayed.
 */
function formatSupply(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) {
        const decimals = n >= 1e8 ? 1 : 2;
        const mStr = (n / 1e6).toFixed(decimals);
        // if toFixed rounds up to 1000.x, promote to B to avoid "1000.0M"
        if (parseFloat(mStr) >= 1000) return (n / 1e9).toFixed(2) + 'B';
        return mStr + 'M';
    }
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 1 : 2) + 'K';
    return Math.floor(n).toLocaleString();
}

/**
 * Format a prize-pool / token amount as USD + tokens.
 * Returns string like: "$6.00 USDC (12,000 tokens)"
 */
function formatCompactNumber(n) {
    const num = Number(n) || 0;
    if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return num.toFixed(0);
}

/**
 * Format a prize-pool / token amount as compact USD + compact tokens.
 * Default compact output: "$6.0K USDC (12K tokens)"
 */
function formatPrizePool(tokens, compact = true) {
    const t = Number(tokens) || 0;
    const rate = (game && game.tokensPerUSD) ? Number(game.tokensPerUSD) : 2000;
    const usd = t / Math.max(1, rate);
    if (compact) {
        const usdCompact = formatCompactNumber(usd);
        const tokenCompact = formatCompactNumber(t);
        return `$${usdCompact} USDC (${tokenCompact} tokens)`;
    }
    // verbose fallback
    const usdStr = usd >= 1000 ? usd.toLocaleString(undefined, {maximumFractionDigits:0}) : usd.toFixed(2);
    return `$${usdStr} USDC (${t.toLocaleString()} tokens)`;
}

/**
 * Format a uranium quantity:
 *  - Under 1000 → always show 2 decimal places (e.g. "0.00", "45.72")
 *  - 1 000+ → compact suffix with 2dp    (e.g. "1.50K", "2.30M")
 */
function formatUranium(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return (+n).toFixed(2);
}

/**
 * Initialize game on page load
 */
function startGame() {
    // Reveal game-only menu items now that the run has started
    // Use explicit display values to override the .game-only { display:none } CSS rule
    document.querySelectorAll('.game-only').forEach(el => {
        el.style.display = el.tagName === 'BUTTON' ? 'flex' : 'block';
    });

    initGrid();
    initRun();   // collect buy-ins, seed prize pool & bonding curve pool (once per run)
    updateUI();
    // initialize toolbar/menu interactions
    initMenu();
    console.log('Game started');
    // start simulation loops
    startSimLoops();
    // attach button tooltips
    addButtonTooltips();
}

function authenticate() {
    // mark body as authenticated to reveal UI
    document.body.classList.add('authenticated');
    const modal = document.getElementById('loginModal');
    if (modal) modal.style.display = 'none';
    // persist session for the tab
    sessionStorage.setItem('nuke_auth', '1');
    // Show lobby before launching
    showLobby();
}

// ─────────────────────────────────────────────────────────────────────────────
// Lobby
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show the pre-run lobby modal.
 * Builds the player list and displays buy-in details so the player can
 * confirm before tokens are deducted. A run consists of 8 rounds, each
 * lasting one real 24-hour day.
 *
 * BACKEND_STUB: In production, open a WebSocket connection here, register
 *   the player, and wait for 'run:ready' before enabling the confirm button.
 */
function showLobby() {
    initPlayerRegistry(); // populate game.players (no buy-in yet)

    // Hide game-only menu items while in lobby
    document.querySelectorAll('.game-only').forEach(el => el.style.display = 'none');

    const modal = document.getElementById('lobbyModal');
    if (!modal) { startGame(); return; } // fallback if modal missing

    // prize pool preview = 80% of all buy-ins
    const preview = Math.floor(game.players.length * game.buyIn * 0.80);

    const lobbyBuyInEl = document.getElementById('lobbyBuyIn');
    const lobbyPrizeEl = document.getElementById('lobbyPrizePreview');
    const lobbyWalletAfterEl = document.getElementById('lobbyWalletAfter');
    if (lobbyBuyInEl) lobbyBuyInEl.textContent = game.buyIn.toLocaleString();
    if (lobbyPrizeEl) lobbyPrizeEl.textContent = formatPrizePool(preview);
    if (lobbyWalletAfterEl) lobbyWalletAfterEl.textContent = (game.playerWallet - game.buyIn).toLocaleString();

    // render player rows
    const list = document.getElementById('lobbyPlayerList');
    if (list) {
        list.innerHTML = game.players.map(p =>
            `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #1e1e1e;">
                <span style="color:${p.isLocal ? '#ffb84d' : '#888'};">${p.name}${p.isBot ? ' <span style="font-size:10px; color:#555;">[BOT]</span>' : ''}</span>
                <span style="color:#4CAF50;">${p.wallet.toLocaleString()} tokens</span>
            </div>`
        ).join('');
    }

    modal.style.display = 'flex';
}

/**
 * Player confirmed buy-in — deduct tokens, seed pools, launch run.
 */
function confirmBuyIn() {
    if (game.playerWallet < game.buyIn) {
        document.getElementById('lobbyError').textContent =
            'Insufficient tokens for buy-in.';
        return;
    }
    const modal = document.getElementById('lobbyModal');
    if (modal) modal.style.display = 'none';
    startGame();
}

/* Profile modal handlers */
function showProfile() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    // populate some fields
    const walletEl = document.getElementById('profileWallet');
    if (walletEl) walletEl.textContent = '$' + (game.playerWallet || 0).toLocaleString();
    const nameEl = document.getElementById('profileName');
    if (nameEl) nameEl.textContent = displayNames.player || 'You';
    const statsEl = document.getElementById('profileStats');
    if (statsEl) {
        const portfolio = (game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price)) || 0;
        statsEl.textContent = `Tokens: ${game.playerWallet.toLocaleString()} — Raw: ${formatUranium(game.uraniumRaw)} / Ref: ${formatUranium(game.uraniumRefined)} — Portfolio: $${portfolio.toFixed(2)}`;
    }
    modal.style.display = 'flex';
}

function closeProfile() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    modal.style.display = 'none';
}

function toggleProfile() {
    const modal = document.getElementById('profileModal');
    if (!modal) return showProfile();
    if (modal.style.display === 'none' || modal.style.display === '') showProfile(); else closeProfile();
}

async function checkPassword() {
    const input = document.getElementById('passwordInput');
    if (!input) return;
    const v = input.value || '';
    try {
        const h = await sha256Hex(v);
        if (h === EXPECTED_PASSWORD_HASH) {
            authenticate();
        } else {
            alert('Incorrect password');
        }
    } catch (err) {
        console.error('Hash error', err);
        alert('Authentication error');
    }
}

document.addEventListener('DOMContentLoaded', function() {
    // if session token present, bypass login but still show lobby for buy-in
    if (sessionStorage.getItem('nuke_auth') === '1') {
        document.body.classList.add('authenticated');
        const modal = document.getElementById('loginModal');
        if (modal) modal.style.display = 'none';
        showLobby();
    }

    // show login modal and wire events
    const loginBtn = document.getElementById('loginBtn');
    const pwd = document.getElementById('passwordInput');
    const profileBtn = document.getElementById('profileBtn');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    if (loginBtn) loginBtn.addEventListener('click', checkPassword);
    if (pwd) pwd.addEventListener('keyup', (e) => { if (e.key === 'Enter') checkPassword(); });
    if (profileBtn) profileBtn.addEventListener('click', toggleProfile);
    if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleMobileMenu);
});

/* Mobile menu open/close */
function showMobileMenu() {
    const modal = document.getElementById('mobileMenu');
    if (!modal) return;
    const s = document.getElementById('mobileMenuStats');
    if (s) {
        const portfolio = (game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price)) || 0;
        s.innerHTML = `Round: ${game.round} — Tokens: ${game.playerWallet.toLocaleString()} — Raw: ${formatUranium(game.uraniumRaw)} / Ref: ${formatUranium(game.uraniumRefined)} — Portfolio: $${portfolio.toFixed(2)}`;
    }
    modal.style.display = 'block';
    document.body.classList.add('mobile-menu-open');
}

function closeMobileMenu() {
    const modal = document.getElementById('mobileMenu');
    if (!modal) return;
    modal.style.display = 'none';
    document.body.classList.remove('mobile-menu-open');
}

function toggleMobileMenu() {
    const modal = document.getElementById('mobileMenu');
    if (!modal) return showMobileMenu();
    if (modal.style.display === 'none' || modal.style.display === '') showMobileMenu(); else closeMobileMenu();
}

/**
 * Start simulation intervals for production and clock.
 */
function startSimLoops() {
    // production tick (gives realtime feel)
    if (!game._productionInterval) {
        game._productionInterval = setInterval(productionTick, 1000);
    }

    // clock tick advances simulated minutes based on minutesPerSecond
    if (!game._clockInterval) {
        // keep a regular interval but advance using real elapsed time
        game._clockInterval = setInterval(clockTick, 500);
        game._lastClockTS = Date.now();
    }
}

/**
 * Update grid visuals for active fallout zones
 */
function updateFalloutVisualization() {
    const grid = document.getElementById('gameGrid');
    const now = Date.now();
    
    // Remove all existing fallout indicators
    grid.querySelectorAll('.cell').forEach(cell => cell.classList.remove('in-fallout'));
    
    // Add fallout class to cells in active fallout zones
    game.falloutZones.forEach(zone => {
        if (zone.endTime > now) {
            const zoneCoords = getCoords(zone.id);
            // Mark all cells within fallout radius
            for (let x = Math.max(0, zoneCoords.x - zone.radius); x <= Math.min(19, zoneCoords.x + zone.radius); x++) {
                for (let y = Math.max(0, zoneCoords.y - zone.radius); y <= Math.min(19, zoneCoords.y + zone.radius); y++) {
                    const cellId = y * 20 + x;
                    const cell = grid.querySelector(`[data-id="${cellId}"]`);
                    if (cell) cell.classList.add('in-fallout');
                }
            }
        }
    });
}

/**
 * Production tick: called every real-second to produce continuous feel.
 */
function productionTick() {
    // ── Handle construction timers ────────────────────────────────────────────
    game.buildings.forEach(b => {
        if (b.isUnderConstruction && b.constructionTimeRemaining > 0) {
            b.constructionTimeRemaining -= 0.1; // 0.1 per tick (each tick is 1 second)
            
            // Construction complete
            if (b.constructionTimeRemaining <= 0) {
                b.constructionTimeRemaining = 0;
                b.isUnderConstruction = false;
                // Re-render to show completed building
                renderBuilding(b.id, b.type, true, b);
            } else {
                // Update progress display
                renderBuilding(b.id, b.type, true, b);
            }
        }
    });
    
    // Count buildings (only completed ones produce resources)
    let totalMines = 0;
    let totalPlants = 0;
    game.buildings.forEach(b => {
        if (!b.isUnderConstruction) { // Only count completed buildings
            if (b.type === 'mine') totalMines++;
            if (b.type === 'plant') totalPlants++;
        }
    });

    // ── Mines → uraniumRaw ────────────────────────────────────────────────────
    // Each mine independently yields a small random amount per tick (organic feel).
    // Range 0.10–0.35 U/sec per mine, average ~0.22.
    // Fallout zones reduce production by 50% if affected.
    // Deposit bonus: on deposit 1.5x, adjacent 1.25x, far 0.3x
    let produced = 0;
    const activeMines = game.buildings.filter(b => b.type === 'mine' && !b.isUnderConstruction);
    activeMines.forEach(mine => {
        let amount = 0.10 + Math.random() * 0.25;
        
        // Apply deposit proximity bonus
        const depositBonus = getDepositBonus(mine.id);
        amount *= depositBonus;
        
        // Apply fallout penalty if affected
        if (mine.fallout && mine.fallout.endTime > Date.now()) {
            amount *= mine.fallout.multiplier; // Apply 50% reduction
        }
        produced += amount;
    });
    const totalStored = game.uraniumRaw + game.uraniumRefined;
    const rawHeadroom = Math.max(0, game.maxStorage - totalStored);
    const actualProduced = Math.min(rawHeadroom, produced);
    game.dailyProduced += actualProduced;
    game.uraniumRaw += actualProduced;

    // ── Processors → convert raw into refined ─────────────────────────────────
    // Each processor converts a small random trickle per tick (avg ~0.15 U/sec).
    // No processor = no refined uranium = no plant income.
    // Fallout zones reduce production by 50% if affected.
    const activeProcessors = game.buildings.filter(b => b.type === 'processor' && !b.isUnderConstruction);
    let converted = 0;
    activeProcessors.forEach(processor => {
        let amount = 0.08 + Math.random() * 0.14; // avg ~0.15 U/sec per processor
        // Apply fallout penalty if affected
        if (processor.fallout && processor.fallout.endTime > Date.now()) {
            amount *= processor.fallout.multiplier; // Apply 50% reduction
        }
        converted += amount;
    });
    const actualConverted = Math.min(game.uraniumRaw, converted);
    game.uraniumRaw     -= actualConverted;
    game.uraniumRefined += actualConverted;

    // ── Plants → consume refined uranium, generate income ─────────────────────
    const fuelPerPlantPerTick = 0.03 + Math.random() * 0.06; // avg ~0.06 U/sec per plant
    const requiredFuel = totalPlants * fuelPerPlantPerTick;
    let fuelConsumed = 0;
    let income = 0;

    if (requiredFuel > 0 && game.uraniumRefined > 0) {
        fuelConsumed = Math.min(requiredFuel, game.uraniumRefined);
        const power = calculatePower();
        const powerFraction = fuelConsumed / requiredFuel;
        income = Math.floor(power * powerFraction * 2); // tokens per production tick
        game.uraniumRefined -= fuelConsumed;
    }

    game.playerWallet += income;
    if (income > 0) {
        // Income rewards are new tokens minted from the 1B reserve — real issuance event.
        game.tokensIssued += income;
        // Minting also drains the bonding curve pool (new supply = scarcity pressure).
        game.market.tokenPool = Math.max(1, game.market.tokenPool - income / game.market.poolBurnRate);
    }
    game.lastIncome = income;
    game.dailyIncome += income;

    // market ticks every production tick so it behaves like a stock price
    game.market.prevPrice = game.market.price;
    tickMarket();

    updateUI();
    updateFalloutVisualization();
}

/**
 * Small per-second market tick to simulate stock-like movement.
 *
 * Price model (two components):
 *  1. Bonding curve anchor — the "fair value" based on pool depletion + real issuance.
 *     poolFactor  = tokenPoolInitial / pool         — run-level scarcity (fast-moving)
 *     issueFactor = 1 + (tokensIssued / 1B) × 1000 — macro supply pressure (slow-moving)
 *     bondingPrice = baseTokenPrice × poolFactor × issueFactor
 *  2. Random walk noise — price oscillates around bondingPrice via mean-reversion.
 *     Prevents the chart from being a boring straight line.
 */
function tickMarket() {
    // 1. Bonding curve fair value
    //    Two factors drive scarcity:
    //    a) tokenPool depletion (run-level, fast-moving)
    //    b) real issuance ratio vs 1B reserve (macro, slow-moving)
    const poolFactor = game.market.tokenPoolInitial / Math.max(1, game.market.tokenPool);
    const issueFactor = 1 + (game.tokensIssued / game.totalTokenSupply) * 1000;
    const bondingPrice = game.market.baseTokenPrice * poolFactor * issueFactor;

    // 2. Gaussian noise (Box-Muller)
    const vol = game.market.perSecondVol;
    const u = Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const noise = z * vol * game.market.price;

    // 3. Diurnal demand drift (legacy flavour — small contribution)
    const supply = calculatePower();
    const diurnal = Math.sin((game.time.hour / 24) * Math.PI * 2) * 0.2;
    const demand = Math.max(10, game.market.baseDemand * (1 + diurnal));
    const supplyDemandDelta = (demand - supply) / demand;
    const drift = supplyDemandDelta * game.market.driftFactor * game.market.price;

    // 4. Mean-revert toward bondingPrice (strength 0.04 per tick)
    const reversion = (bondingPrice - game.market.price) * 0.04;

    game.market.price = Math.max(0.01,
        +(game.market.price + reversion + noise + drift).toFixed(6));
}

/**
 * Clock tick: advances simulated clock and triggers hourly/daily events.
 */
function clockTick() {
    // use elapsed real time to advance simulated minutes so real-time mapping is accurate
    const now = Date.now();
    if (!game._lastClockTS) game._lastClockTS = now;
    const deltaSec = (now - game._lastClockTS) / 1000;
    game._lastClockTS = now;

    const advanceMinutes = deltaSec * game.time.minutesPerSecond;
    game.time.minute += advanceMinutes;

    // handle hour/day rollovers (use floor to avoid floating loop problems)
    while (game.time.minute >= 60) {
        game.time.minute -= 60;
        game.time.hour += 1;
        onHourAdvance();
    }

    while (game.time.hour >= 24) {
        game.time.hour -= 24;
        game.time.day += 1;
        onDayAdvance();
    }

    updateUI();
}

function onHourAdvance() {
    // market fluctuates each hour
    fluctuateMarket();
}

function onDayAdvance() {
    // Reset daily strike counter
    game.dayStrikes = 0;
    
    // Clean up expired fallout zones and remove fallout status from affected buildings
    const now = Date.now();
    game.falloutZones = game.falloutZones.filter(z => z.endTime > now);
    game.buildings.forEach(b => {
        if (b.fallout && b.fallout.endTime <= now) {
            delete b.fallout;
        }
    });
    
    // Clean up expired disabled status on enemy buildings
    game.enemyBuildings.forEach(b => {
        if (b.disabled && b.disabled.endTime <= now) {
            delete b.disabled;
        }
    });
    
    // Hook round advancement to day: each day = one round (1-8)
    game.round = Math.min(game.time.day, game.runLength);
    
    document.getElementById('day').textContent = game.time.day;
    document.getElementById('round').textContent = `${game.round}/${game.runLength}`;
    
    // Close any open day modal first
    const dayModal = document.getElementById('endOfDayModal');
    if (dayModal) dayModal.style.display = 'none';
    
    // Check if run just ended (day exceeds runLength)
    if (!game.runEnded && game.time.day > game.runLength) {
        game.runEnded = true;
        game.dailyProduced = 0;
        game.dailyIncome = 0;
        onRunEnd();
        return;
    }
    
    // If this is the final day (day === runLength), don't show summary yet - wait for day+1 to show combined modal
    if (game.time.day === game.runLength) {
        game.dailyProduced = 0;
        game.dailyIncome = 0;
        return;
    }
    
    // Show end-of-day summary for days 1-7
    showEndOfDaySummary();
    
    // Reset daily accumulators for next day
    game.dailyProduced = 0;
    game.dailyIncome = 0;
}

/**
 * Called when a round ends (day transitions; stub for future use)
 */
function onRoundEnd(roundNumber) {
    // Currently just a placeholder for future round-end logic
    // Prize distribution happens at the very end of the full 8-round run (onRunEnd)
    console.info(`Round ${roundNumber} complete. Next round begins.`);
}

/**
 * Called when the entire run ends
 * Shows comprehensive final leaderboard with player stats, game economy, and run statistics
 */
function onRunEnd() {
    console.info('🔥 RUN COMPLETE! All rounds finished.');
    
    // Freeze the grid
    const grid = document.getElementById('gameGrid');
    if (grid) {
        document.querySelectorAll('.cell').forEach(cell => {
            cell.style.pointerEvents = 'none';
            cell.style.opacity = '0.7';
        });
    }
    
    // Build final leaderboard with all scores and stats
    const finalScores = game.players.map(p => {
        let buildingStats = { mines: 0, processors: 0, storage: 0, plants: 0 };
        let totalBuildings = 0;
        
        if (p.isLocal) {
            game.buildings.forEach(b => {
                buildingStats[b.type]++;
                totalBuildings++;
            });
            const portfolio = game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price);
            return { 
                name: p.name, 
                isLocal: true, 
                score: calculatePower() + (portfolio / 1000), 
                portfolio,
                wallet: game.playerWallet,
                buildingStats,
                totalBuildings,
                power: calculatePower(),
                uranium: game.uraniumRaw + game.uraniumRefined
            };
        }
        
        const botBuildings = game.enemyBuildings.filter(b => b.owner === p.name);
        botBuildings.forEach(b => {
            buildingStats[b.type]++;
            totalBuildings++;
        });
        const plants = buildingStats.plants;
        const mines = buildingStats.mines;
        const estPortfolio = (plants * 100) + (mines * 50 * game.market.price);
        return { 
            name: p.name, 
            isLocal: false, 
            score: (plants * 100) + (estPortfolio / 1000), 
            portfolio: estPortfolio,
            wallet: p.wallet,
            buildingStats,
            totalBuildings,
            power: plants * 100,
            uranium: 0
        };
    });
    finalScores.sort((a, b) => b.score - a.score);
    
    // Determine winner
    const winner = finalScores[0];
    const isPlayerWinner = winner.isLocal;
    
    // Calculate global stats
    const circ = Math.max(0, game.tokensIssued - game.tokensBurned);
    const available = game.totalTokenSupply - game.tokensIssued;
    
    // Create run-end modal
    const modal = document.createElement('div');
    modal.id = 'runEndModal';
    modal.style.cssText = `
        position: fixed;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.95);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.5s ease-in;
        overflow: auto;
    `;
    
    const content = document.createElement('div');
    content.style.cssText = `
        background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%);
        border: 2px solid ${isPlayerWinner ? '#ffb84d' : '#ff6b6b'};
        border-radius: 8px;
        padding: 24px;
        width: 90%;
        max-width: 1200px;
        max-height: 85vh;
        overflow-y: auto;
        color: #fff;
        font-family: monospace;
        box-shadow: 0 0 20px ${isPlayerWinner ? 'rgba(255,184,77,0.3)' : 'rgba(255,107,107,0.3)'};
    `;
    
    // Build leaderboard with detailed player stats
    let leaderboardHTML = finalScores.map((p, i) => {
        const medal = ['🥇 1ST', '🥈 2ND', '🥉 3RD'][i] || `#${i+1}`;
        const color = p.isLocal ? '#ffb84d' : '#ccc';
        const you = p.isLocal ? ' (YOU)' : '';
        return `
            <div style="margin-bottom: 12px; padding: 12px; background: rgba(255,255,255,0.05); border-left: 3px solid ${color}; border-radius: 4px;">
                <div style="color: ${color}; font-weight: bold; margin-bottom: 6px;">
                    ${medal} ${p.name}${you}
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 11px; color: #aaa;">
                    <div><strong>Score:</strong> ${p.score.toFixed(1)}</div>
                    <div><strong>Portfolio:</strong> $${p.portfolio.toFixed(2)}</div>
                    <div><strong>Wallet:</strong> ${p.wallet.toLocaleString()} tokens</div>
                    <div><strong>Power:</strong> ${p.power.toFixed(1)} MW</div>
                    <div><strong>Buildings:</strong> ${p.totalBuildings} (${p.buildingStats.mines}⛏️ ${p.buildingStats.processors}🏭 ${p.buildingStats.storage}🗄️ ${p.buildingStats.plants}☢️)</div>
                    <div><strong>Uranium:</strong> ${formatUranium(p.uranium)}</div>
                </div>
            </div>
        `;
    }).join('');
    
    content.innerHTML = `
        <div style="text-align: center; margin-bottom: 20px;">
            <div style="font-size: 22px; font-weight: bold; color: #ffb84d; margin-bottom: 6px;">
                ${isPlayerWinner ? '🎉 YOU WIN THE RUN! 🎉' : '💥 RUN OVER 💥'}
            </div>
                <div style="font-size: 12px; color: #888;">
                Completed ${game.runLength} rounds | Market Price: $${game.market.price.toFixed(2)} | Prize Pool: ${formatPrizePool(game.prizePool)}
            </div>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px;">
            <!-- Winner Highlight -->
            <div style="padding: 12px; background: rgba(255,184,77,0.1); border: 1px solid #ffb84d; border-radius: 4px;">
                <div style="font-weight: bold; color: #ffb84d; margin-bottom: 6px;">🏆 Champion</div>
                <div style="font-size: 12px; color: #ccc; margin-bottom: 4px;"><strong>${winner.name}</strong></div>
                <div style="font-size: 11px; color: #888;">Score: ${winner.score.toFixed(1)}</div>
                <div style="font-size: 11px; color: #888;">Portfolio: $${winner.portfolio.toFixed(2)}</div>
            </div>
            
            <!-- Global Economy Stats -->
            <div style="padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid #333; border-radius: 4px;">
                <div style="font-weight: bold; color: #ffb84d; margin-bottom: 6px;">📊 Global Economy</div>
                <div style="font-size: 11px; color: #aaa; line-height: 1.6;">
                    Circulating: ${formatSupply(circ)}<br/>
                    Burned: ${formatSupply(game.tokensBurned)}<br/>
                    Available: ${formatSupply(available)}<br/>
                    Market Price: $${game.market.price.toFixed(2)}
                </div>
            </div>
        </div>
        
        <div style="margin-bottom: 20px; padding: 12px; background: rgba(255,255,255,0.03); border-top: 1px solid #333; border-bottom: 1px solid #333;">
            <div style="font-weight: bold; color: #ffb84d; margin-bottom: 12px;">🏅 Final Leaderboard</div>
            ${leaderboardHTML}
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 20px; font-size: 11px;">
            <div style="padding: 10px; background: rgba(76,175,80,0.1); border-left: 2px solid #4CAF50; border-radius: 4px;">
                <div style="color: #4CAF50; font-weight: bold; margin-bottom: 4px;">⛏️ Production</div>
                <div style="color: #888;">Mines: ${game.buildings.filter(b => b.type === 'mine').length}</div>
                <div style="color: #888;">Processors: ${game.buildings.filter(b => b.type === 'processor').length}</div>
                <div style="color: #888;">Uranium: ${formatUranium(game.uraniumRaw + game.uraniumRefined)}</div>
            </div>
            
            <div style="padding: 10px; background: rgba(255,184,77,0.1); border-left: 2px solid #ffb84d; border-radius: 4px;">
                <div style="color: #ffb84d; font-weight: bold; margin-bottom: 4px;">☢️ Power</div>
                <div style="color: #888;">Reactors: ${game.buildings.filter(b => b.type === 'plant').length}</div>
                <div style="color: #888;">Total Power: ${calculatePower().toFixed(1)} MW</div>
                <div style="color: #888;">Storage: ${game.buildings.filter(b => b.type === 'storage').length}</div>
            </div>
            
            <div style="padding: 10px; background: rgba(255,107,107,0.1); border-left: 2px solid #ff6b6b; border-radius: 4px;">
                <div style="color: #ff6b6b; font-weight: bold; margin-bottom: 4px;">💣 Sabotage</div>
                <div style="color: #888;">Enemy Buildings: ${game.enemyBuildings.length}</div>
                <div style="color: #888;">Tokens Burned: ${formatSupply(game.tokensBurned)}</div>
                <div style="color: #888;">Prize Pool: ${formatPrizePool(game.prizePool)}</div>
            </div>
        </div>
        
        <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #333; text-align: center;">
            <button onclick="returnToMenu()" style="
                padding: 12px 32px;
                background: #ffb84d;
                color: #000;
                border: none;
                border-radius: 4px;
                font-weight: bold;
                cursor: pointer;
                font-family: monospace;
                font-size: 14px;
            ">↻ Return to Menu</button>
        </div>
    `;
    
    modal.appendChild(content);
    document.body.appendChild(modal);
}

/**
 * Return to menu / reset for new run
 */
function returnToMenu() {
    const modal = document.getElementById('runEndModal');
    if (modal) modal.remove();
    
    // Stop the simulation loops
    if (game._productionInterval) clearInterval(game._productionInterval);
    if (game._timeInterval) clearInterval(game._timeInterval);
    
    // Reset game state
    game.runEnded = false;
    game.round = 1;
    game.time.day = 1;
    game.time.hour = 0;
    game.time.minute = 0;
    game.playerWallet = 50000;
    game.uraniumRaw = 0;
    game.uraniumRefined = 0;
    game.buildings = [];
    game.enemyBuildings = [];
    game.prizePool = 0;
    game.dailyProduced = 0;
    game.dailyIncome = 0;
    
    // Re-enable grid
    document.querySelectorAll('.cell').forEach(cell => {
        cell.style.pointerEvents = 'auto';
        cell.style.opacity = '1';
    });
    
    // Clear grid
    const grid = document.getElementById('gameGrid');
    if (grid) grid.innerHTML = '';
    
    // Show lobby for next run
    showLobby();
}

/**
 * Distribute the prize pool to the top 3 players at round end.
 * Shares: 1st 50% / 2nd 30% / 3rd 20%.
 *
 * BACKEND_STUB: In production the server calculates and sends final scores
 *   via 'run:end' event, and transfers tokens on-chain / in the DB.
 *   client only needs to display the result, not compute it.
 */
function distributePrizePool() {
    if (game.prizePool <= 0) return;
    const pool = game.prizePool;
    const shares = [0.50, 0.30, 0.20];

    // Score every player
    const scored = game.players.map(p => {
        if (p.isLocal) {
            const portfolio = game.playerWallet + (game.uranium * game.market.price);
            return { ...p, calcScore: calculatePower() + (portfolio / 1000) };
        }
        // Estimate bot score from their buildings on the grid
        const botBuildings = game.enemyBuildings.filter(b => b.owner === p.name);
        const plants = botBuildings.filter(b => b.type === 'plant').length;
        const mines  = botBuildings.filter(b => b.type === 'mine').length;
        const estPortfolio = (plants * 100) + (mines * 50 * game.market.price);
        return { ...p, calcScore: (plants * 100) + (estPortfolio / 1000) };
    });

    scored.sort((a, b) => b.calcScore - a.calcScore);

    // Award local player if they placed top 3
    const localRank = scored.findIndex(p => p.isLocal);
    if (localRank < 3) {
        const award = Math.floor(pool * shares[localRank]);
        game.playerWallet += award;
        // also sync back to player registry
        const localEntry = game.players.find(p => p.isLocal);
        if (localEntry) localEntry.wallet = game.playerWallet;
        console.info(
            `Round ${game.round} over! Pool: ${pool.toLocaleString()} | ` +
            `Rank: #${localRank + 1} | Awarded: +${award.toLocaleString()} tokens`
        );
    }
    game.prizePool = 0;
}

/**
 * Market random walk / volatility
 */
function fluctuateMarket() {
    const vol = game.market.volatility;
    // simple gaussian-like noise via two uniforms (Box-Muller-ish approximation)
    const u = Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const change = z * vol * game.market.price;
    game.market.price = Math.max(0.01, +(game.market.price + change).toFixed(4));
}

/**
 * Tooltip helpers
 */
function onCellHover(id, e) {
    const cell = document.querySelector('[data-id="' + id + '"]');
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    // build tooltip content
    let content = '';
    const player = game.buildings.find(b => b.id === id);
    const enemy = game.enemyBuildings.find(b => b.id === id);
    const deposit = game.deposits.find(d => d.cellId === id);

    // If hovering over a deposit cell (no buildings), show deposit info
    if (!player && !enemy && deposit && !game.selectedMode) {
        content = `<div style="font-weight:700; color:#FFD700;">🚩 Uranium Deposit</div>` +
            `<div style="color:#FFA500; margin-top:4px;">Build mines here for 1.5x yield!</div>` +
            `<div style="color:#AAA; font-size:12px; margin-top:4px;">1 tile: 1.25x | 2 tiles: 0.7x | 3+: 0.1x</div>`;
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // If hovering while planning to build, preview proximity bonuses
    if (!player && !enemy && game.selectedMode && game.selectedMode !== 'sabotage') {
        const type = game.selectedMode;
        // count neighbor same-type if placed here
        let same = 0;
        let pen = 0;
        for (const other of game.buildings) {
            if (other.type === type && distance(id, other.id) <= game.proximityRange) same++;
        }
        for (const en of game.enemyBuildings) {
            if (distance(id, en.id) <= game.proximityRange) pen++;
        }
        const label = displayNames[type] || type;
        const icon = (buildingTypes[type] && buildingTypes[type].emoji) ? buildingTypes[type].emoji + ' ' : '';
        content = `<div style="font-weight:700;">${icon}Place: ${label}</div>` +
            `<div>📐 Same-type neighbors: ${same} (${same>0? '+'+ (same*25) +'% efficiency': 'no bonus'})</div>` +
            `<div>⚠️ Nearby enemies: ${pen}</div>`;
        
        // Add deposit bonus info for mines
        if (type === 'mine') {
            const depositBonus = getDepositBonus(id);
            const depositInfo = depositBonus === 1.5 ? '💰 On deposit: 1.5x yield!' : 
                               depositBonus === 1.25 ? '💰 1 tile away: 1.25x yield' : 
                               depositBonus === 0.7 ? '💰 2 tiles away: 0.7x yield' :
                               '⛰️ 3+ tiles away: 0.1x yield (terrible!)';
            content += `<div style="color:${depositBonus > 0.5 ? '#FFD700' : '#FF6B6B'}; font-weight:600;">${depositInfo}</div>`;
        }
        
        if (type === 'plant') {
            const hasRoad = cellHasRoadNeighbor(id);
            content += `<div style="color:${hasRoad ? '#4CAF50' : '#888'};">` +
                `🛣️ Road access: ${hasRoad ? '+40% income if built here ✓' : 'no road bonus here'}</div>`;
        }
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // If hovering a player building (only show details when NOT in build mode)
    if (player && !game.selectedMode) {
        const type = player.type;
        let same = 0; let pen = 0;
        for (const other of game.buildings) {
            if (other.id !== player.id && other.type === type && distance(id, other.id) <= game.proximityRange) same++;
        }
        for (const en of game.enemyBuildings) if (distance(id, en.id) <= game.proximityRange) pen++;
        const label = displayNames[type] || type;
        const icon = (buildingTypes[type] && buildingTypes[type].emoji) ? buildingTypes[type].emoji + ' ' : '';
        content = `<div style="font-weight:700;">${icon}${label} <span style="color:#4CAF50;">(You)</span></div>` +
            `<div>📐 Same-type neighbors: ${same} (${same>0? '+'+ (same*25) +'%': 'none'})</div>` +
            `<div>⚠️ Nearby enemies: ${pen}</div>`;
        
        // Show mining rate for mines
        if (type === 'mine') {
            const depositBonus = getDepositBonus(id);
            const miningRatePercent = (depositBonus * 100).toFixed(0);
            const depositDistInfo = depositBonus === 1.5 ? 'On deposit' : 
                                   depositBonus === 1.25 ? '1 tile from deposit' : 
                                   depositBonus === 0.7 ? '2 tiles from deposit' : 
                                   '3+ tiles from deposit';
            content += `<div style="color:${depositBonus > 0.5 ? '#FFD700' : '#FF6B6B'}; font-weight:600; margin-top:4px;">⛏️ Mining: ${miningRatePercent}% efficiency</div>` +
                      `<div style="color:#AAA; font-size:12px;">${depositDistInfo}</div>`;
        }
        
        if (type === 'plant') {
            const hasRoad = cellHasRoadNeighbor(id);
            content += `<div style="color:${hasRoad ? '#4CAF50' : '#888'};">` +
                `🛣️ Road access: ${hasRoad ? '+40% income ✓' : 'none'}</div>`;
        }
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // If hovering an enemy building (only show details when NOT in build mode)
    if (enemy && !game.selectedMode) {
        const type = enemy.type;
        const sabotageCost = Math.max(0, buildingTypes[type].cost - 200);
        const label = displayNames[type] || type;
        const icon = (buildingTypes[type] && buildingTypes[type].emoji) ? buildingTypes[type].emoji + ' ' : '';
        content = `<div style="font-weight:700;">${icon}${label} <span style="color:#ff6b6b;">(Enemy)</span></div>` +
            `<div>💥 Sabotage cost: ${sabotageCost.toLocaleString()} tokens</div>` +
            `<div>🗑️ Effect: destroys building, removes its production</div>`;
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // Road cell — show bonus hint even on empty road tiles
    if (game.terrain && (game.terrain[id] === 'road' || game.terrain[id] === 'road-h' || game.terrain[id] === 'road-x')) {
        content = `<div style="font-weight:700; color:#aaa;">🛣️ Road Tile</div>` +
            `<div>Building close to road access increases productivity.</div>` +
            `<div style="color:#4CAF50;">Adjacent Reactors gain +40% income</div>`;
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // empty cell default
    hideTooltip();
}

function onCellMove(id, e) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip || tooltip.style.display === 'none') return;
    const x = e.clientX + 12; const y = e.clientY + 12;
    repositionTooltip(x, y);
}

function showTooltipAt(x, y, html) {
    const t = document.getElementById('tooltip');
    if (!t) return;
    t.innerHTML = html;
    t.style.display = 'block';
    // start at requested position
    t.style.left = x + 'px';
    t.style.top = y + 'px';
    // reposition if off-screen
    repositionTooltip(x, y);
}

/**
 * Show a tooltip anchored to the left of the actions menu and vertically
 * aligned to the menu item. This measures the tooltip size then places it
 * so the right edge sits a few pixels left of the menu's left edge.
 */
function showTooltipAnchoredLeft(menuRect, itemRect, html) {
    const t = document.getElementById('tooltip');
    if (!t) return;
    t.innerHTML = html;
    t.style.display = 'block';
    t.style.maxWidth = '320px';
    t.classList.add('anchored-to-menu');

    // measure after render
    const rect = t.getBoundingClientRect();
    const padding = 8;
    // compute left so tooltip's right edge sits padding px left of menu left
    let left = Math.max(padding, Math.min(window.innerWidth - rect.width - padding, (menuRect.left - rect.width - 12)));
    // vertical center relative to menu item
    let top = itemRect.top + (itemRect.height - rect.height) / 2;
    // clamp to viewport
    top = Math.max(padding, Math.min(window.innerHeight - rect.height - padding, top));

    t.style.left = left + 'px';
    t.style.top = top + 'px';
}

/**
 * Reposition an already-visible tooltip so it stays inside the viewport.
 * If called with `html` provided, it will set content first.
 */
function repositionTooltip(x, y) {
    const t = document.getElementById('tooltip');
    if (!t || t.style.display === 'none') return;
    // measure
    const rect = t.getBoundingClientRect();
    const padding = 8;
    let left = x;
    let top = y;

    // if tooltip goes off right edge, try to place to left of x
    if (rect.right > window.innerWidth - padding) {
        left = Math.max(padding, x - rect.width - 16);
    }
    // if tooltip goes off bottom, move it up
    if (rect.bottom > window.innerHeight - padding) {
        top = Math.max(padding, y - rect.height - 16);
    }
    // ensure not off left/top
    left = Math.max(padding, left);
    top = Math.max(padding, top);

    t.style.left = left + 'px';
    t.style.top = top + 'px';
}

function hideTooltip() {
    const t = document.getElementById('tooltip');
    if (!t) return;
    t.style.display = 'none';
    // reset any anchored state
    t.style.maxWidth = '';
    t.classList.remove('anchored-to-menu');
}

/**
 * End-of-day summary and leaderboard
 */
function showEndOfDaySummary() {
    const modal = document.getElementById('endOfDayModal');
    const content = document.getElementById('endOfDayContent');
    const lb = document.getElementById('leaderboard');
    if (!modal || !content || !lb) return;

    // player stats
    const dayProduced = game.dailyProduced;
    const dayIncome = game.dailyIncome;
    const power = calculatePower();

    const circ = Math.max(0, game.tokensIssued - game.tokensBurned);
    const available = game.totalTokenSupply - game.tokensIssued;
    content.innerHTML = `
        <div>Day: ${game.time.day}</div>
        <div>Power (current): ${power.toFixed(1)} MW</div>
        <div>Raw uranium mined today: ${formatUranium(dayProduced)}</div>
        <div>Refined (current): ${formatUranium(game.uraniumRefined)}</div>
        <div>Income today: ${dayIncome.toLocaleString()} tokens</div>
        <div style="margin-top:8px; border-top:1px solid #333; padding-top:8px;">
            <strong>Token Economy</strong>
        </div>
        <div>Circulating supply: ${formatSupply(circ)} <span style="color:#555; font-size:10px;">(issued − burned)</span></div>
        <div>Available in reserve: ${formatSupply(available)} <span style="color:#555; font-size:10px;">of 1B</span></div>
        <div>Tokens issued (total): ${formatSupply(game.tokensIssued)}</div>
        <div>Tokens burned (total): ${formatSupply(game.tokensBurned)}</div>
        <div style="margin-top:6px;">
            <strong style="color:#ffb84d;">Prize Pool: ${formatPrizePool(game.prizePool)}</strong>
        </div>
        <div style="font-size:11px; color:#888;">Split at round end — 1st: 50% / 2nd: 30% / 3rd: 20%</div>
    `;

    // build leaderboard from game.players
    // BACKEND_STUB: replace with server-sent scores from 'round:scores' event
    const entries = game.players.map(p => {
        if (p.isLocal) {
            const portfolio = game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price);
            return { name: p.name, isLocal: true, score: power + (portfolio / 1000), portfolio };
        }
        const botBuildings = game.enemyBuildings.filter(b => b.owner === p.name);
        const plants = botBuildings.filter(b => b.type === 'plant').length;
        const mines  = botBuildings.filter(b => b.type === 'mine').length;
        const estPortfolio = (plants * 100) + (mines * 50 * game.market.price);
        return { name: p.name, isLocal: false, score: (plants * 100) + (estPortfolio / 1000), portfolio: estPortfolio };
    });
    entries.sort((a, b) => b.score - a.score);
    lb.innerHTML = entries.map((r, i) => {
        const medal = ['🥇','🥈','🥉'][i] || `#${i+1}`;
        const color = r.isLocal ? '#ffb84d' : '#ccc';
        return `<div style="margin-bottom:6px; color:${color};">` +
            `<strong>${medal} ${r.name}</strong> — ` +
            `Score: ${r.score.toFixed(1)} — ` +
            `Portfolio: $${r.portfolio.toFixed(2)}` +
            `</div>`;
    }).join('');

    modal.style.display = 'flex';
}

function closeEndOfDay() {
    const modal = document.getElementById('endOfDayModal');
    if (!modal) return;
    modal.style.display = 'none';
}

/**
 * Add hover tooltips to top-bar buttons.
 */
function addButtonTooltips() {
    const buttons = document.querySelectorAll('.btn');
    buttons.forEach(btn => {
        // Skip the hamburger toggle — it has its own title="Actions" tooltip
        if (btn.id === 'actionsMenuBtn') return;
        btn.addEventListener('mouseenter', (e) => {
            const typeKey = btn.dataset.type || btn.textContent.trim();
            const label = displayNames[typeKey] || btn.textContent.trim();
            let content = '<div style="font-weight:700;">' + label + '</div>';
            if (typeKey === 'mine' || /mine/i.test(typeKey)) {
                content = '<div style="font-weight:700;">⛏️ ' + label + '</div>';
                content += '<div>Place a Mine to extract raw uranium from the ground.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.mine.cost + ' tokens</div>';
            } else if (typeKey === 'processor' || /process/i.test(typeKey)) {
                content = '<div style="font-weight:700;">🏭 ' + label + '</div>';
                content += '<div>Refines raw uranium into fuel for Reactors.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.processor.cost + ' tokens</div>';
            } else if (typeKey === 'storage' || /store/i.test(typeKey)) {
                content = '<div style="font-weight:700;">🗄️ ' + label + '</div>';
                content += '<div>Increases your uranium storage capacity.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.storage.cost + ' tokens</div>';
            } else if (typeKey === 'plant' || /plant/i.test(typeKey)) {
                content = '<div style="font-weight:700;">☢️ ' + label + '</div>';
                content += '<div>Consumes refined uranium to generate power &amp; income.</div>';
                content += '<div>🛣️ Place near a road for +40% income bonus.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.plant.cost + ' tokens</div>';
            } else if (typeKey === 'sabotage' || /sabotage/i.test(typeKey)) {
                content = '<div style="font-weight:700;">💥 Sabotage</div>';
                content += '<div>Sabotage an enemy building.</div>';
                content += '<div>Click Sabotage then click an enemy cell.</div>';
                content += '<div>⚠️ Cost varies by target type.</div>';
            } else if (typeKey === 'silo' || /silo/i.test(typeKey)) {
                content = '<div style="font-weight:700;">💥 Silo</div>';
                content += '<div>Missile Silo — the ultimate weapon. Requires at least 1 completed Reactor to build.</div>';
                content += `<div>💰 Build cost: ${buildingTypes.silo.cost} tokens — Construction: ${buildingTypes.silo.constructionTime}s</div>`;
                content += `<div>⚠️ Limit: ${game.maxSilosPerRound} per round. Using a nuke costs a large portion of your wallet.</div>`;
            } else if (typeKey === 'dev' || /dev/i.test(typeKey)) {
                content = '<div style="font-weight:700;">🔧 Dev Tools</div>';
                content += '<div>Advance time, change simulation speed for testing.</div>';
            }
            const rect = btn.getBoundingClientRect();
            showTooltipAt(rect.right + 8, rect.top, content);
        });
        btn.addEventListener('mousemove', (e) => {
            // reposition tooltip near cursor while clamping to viewport
            const x = e.clientX + 12; const y = e.clientY + 12;
            repositionTooltip(x, y);
        });
        btn.addEventListener('mouseleave', hideTooltip);
    });
}

    // Also add tooltips for popup menu items, anchored to the actions menu
    const menu = document.getElementById('actionsMenu');
    const menuItems = document.querySelectorAll('.menu-item');
    if (menuItems && menuItems.length) {
        menuItems.forEach(mi => {
            mi.addEventListener('mouseenter', (e) => {
                const typeKey = mi.dataset.type || mi.textContent.trim();
                const label = displayNames[typeKey] || mi.textContent.trim();
                let content = '<div style="font-weight:700;">' + label + '</div>';
                if (typeKey === 'mine' || /mine/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">⛏️ ' + label + '</div>';
                    content += '<div>Place a Mine to extract raw uranium from the ground.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.mine.cost + ' tokens</div>';
                } else if (typeKey === 'processor' || /process/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">🏭 ' + label + '</div>';
                    content += '<div>Refines raw uranium into fuel for Reactors.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.processor.cost + ' tokens</div>';
                } else if (typeKey === 'storage' || /store/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">🗄️ ' + label + '</div>';
                    content += '<div>Increases your uranium storage capacity.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.storage.cost + ' tokens</div>';
                } else if (typeKey === 'plant' || /plant/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">☢️ ' + label + '</div>';
                    content += '<div>Consumes refined uranium to generate power &amp; income.</div>';
                    content += '<div>🛣️ Place near a road for +40% income bonus.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.plant.cost + ' tokens</div>';
                } else if (typeKey === 'sabotage' || /sabotage/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">💥 Sabotage</div>';
                    content += '<div>Sabotage an enemy building.</div>';
                    content += '<div>Click Sabotage then click an enemy cell.</div>';
                    content += '<div>⚠️ Cost varies by target type.</div>';
                } else if (typeKey === 'silo' || /silo/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">💥 Silo</div>';
                    content += '<div>Nukes. The ultimate weapon.</div>';
                    content += '<div>Requires 1 completed Reactor to build.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.silo.cost + ' tokens</div>';
                    content += '<div>⚠️ Limit: ' + game.maxSilosPerRound + ' per round</div>';
                }
                // Anchor tooltip to the LEFT of the actions menu, vertically centered to the item
                const menuRect = menu ? menu.getBoundingClientRect() : null;
                const itemRect = mi.getBoundingClientRect();
                // store the generated HTML on the element so mousemove can reuse it
                mi._tooltipContent = content;
                if (menuRect) {
                    showTooltipAnchoredLeft(menuRect, itemRect, content);
                } else {
                    // fallback: place to the left of item
                    const x = itemRect.left - 260;
                    const y = itemRect.top;
                    showTooltipAt(x, y, content);
                }
            });
            mi.addEventListener('mousemove', (e) => {
                // Keep tooltip vertically aligned with the item in case of scrolling/resize
                const menuRect = menu ? menu.getBoundingClientRect() : null;
                const itemRect = mi.getBoundingClientRect();
                const content = mi._tooltipContent || mi.textContent.trim();
                if (menuRect) showTooltipAnchoredLeft(menuRect, itemRect, content);
            });
            mi.addEventListener('mouseleave', (e) => {
                // clear anchored styles before hiding
                const t = document.getElementById('tooltip');
                if (t) {
                    t.style.maxWidth = '';
                    t.classList.remove('anchored-to-menu');
                }
                // clear stored tooltip content
                delete mi._tooltipContent;
                hideTooltip();
            });
        });
    }

/**
 * Dev controls
 */
function toggleDevPanel() {
    const panel = document.getElementById('devPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function advanceHours(n) {
    if (!n || isNaN(n)) return;
    for (let i = 0; i < n; i++) {
        game.time.minute += 60; // advance 1 hour
        while (game.time.minute >= 60) {
            game.time.minute -= 60;
            game.time.hour += 1;
            onHourAdvance();
        }
        while (game.time.hour >= 24) {
            game.time.hour -= 24;
            game.time.day += 1;
            onDayAdvance();
        }
    }
    // run one production tick per advanced hour to give realtime feel
    productionTick();
    updateUI();
}

function setSimSpeed(minutesPerSecond) {
    game.time.minutesPerSecond = minutesPerSecond;
    // reset clock timestamp to avoid a large delta
    game._lastClockTS = Date.now();
}
