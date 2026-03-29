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
    // Token economy
    totalTokenSupply: 1000000000, // 1 billion — the hard cap; tokens are MINTED from this reserve
    tokensIssued: 0,              // total ever drawn from the 1B reserve (wallets + income rewards)
    tokensBurned: 0,              // permanently destroyed by in-game spending
    // circulating = tokensIssued - tokensBurned
    // available   = totalTokenSupply - tokensIssued
    prizePool: 0,                 // funded by buy-ins + 10% of in-game spends

    // ── Buy-in / run entry ───────────────────────────────────────────────────
    // Every player (human or bot) pays this once to enter a run.
    // A run = 8 rounds, each lasting one real 24-hour day.
    // Their buy-in seeds the prize pool and the bonding curve pool directly.
    buyIn: 5000, // tunable — cost per player per run (in tokens)

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
    mine: { cost: 800, emoji: '⛏️', color: '#4CAF50', power: 0 },
    // Use factory emoji for processor (renders as 'Plant' in UI)
    processor: { cost: 1200, emoji: '🏭', color: '#d98a3a', power: 0 },
    // Use a filing-cabinet / vault emoji for storage and a warmer metal tone
    storage: { cost: 1000, emoji: '🗄️', color: '#b08b4f', power: 0 },
    // reactor (consumes fuel)
    plant: { cost: 1000, emoji: '☢️', color: '#ffb84d', power: 100 }
};

// Display names used in UI (keep keys stable in logic)
const displayNames = {
    mine: 'Mine',
    processor: 'Plant',
    storage: 'Storage',
    plant: 'Reactor'
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
        `Run started (Round ${game.round}/8) | Players: ${game.players.length} | ` +
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
    for (let i = 0; i < 400; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        // add terrain class for visuals (terrain-grass/terrain-dirt/terrain-road)
        const t = terrain[i] || 'grass';
        cell.classList.add('terrain-' + t);
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
    for (let i = 0; i < 5; i++) {
        const randomId = Math.floor(Math.random() * 400);
        const type = Object.keys(buildingTypes)[Math.floor(Math.random() * 4)];
        const enemy = enemies[Math.floor(Math.random() * enemies.length)];
        
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
    // center vertical road
    const centerX = Math.floor(width / 2);
    for (let y = 0; y < height; y++) {
        out[y * width + centerX] = 'road';
        // occasional adjacent shoulder
        if (Math.random() < 0.25) {
            if (centerX - 1 >= 0) out[y * width + (centerX - 1)] = 'road';
        }
    }

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
                    if (out[idx] !== 'road' && Math.random() > 0.25) out[idx] = 'dirt';
                }
            }
        }
    }

    return out;
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
    document.querySelectorAll('.btn').forEach(b => b.style.opacity = '0.6');
    if (game.selectedMode) {
        const buttons = document.querySelectorAll('.btn');
        buttons.forEach(b => {
            if (b.textContent.toLowerCase().includes(game.selectedMode)) {
                b.style.opacity = '1';
            }
        });
    }
}

/**
 * Place a building or select a cell
 */
function placeOrSelect(id) {
    if (!game.selectedMode) return;

    const cell = document.querySelector('[data-id="' + id + '"]');
    if (cell.innerHTML && cell.innerHTML !== '') return; // Already occupied

    if (game.selectedMode === 'sabotage') {
        sabotage(id);
    } else {
        buildBuilding(id, game.selectedMode);
    }
}

/**
 * Build a building at the specified cell
 */
function buildBuilding(id, type) {
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
    game.buildings.push({ id, type, owner: 'YOU' });

    if (type === 'storage') {
        game.maxStorage += 1000;
    }

    renderBuilding(id, type, true);
    calculateProximity();
    updateUI();
    game.selectedMode = null;
}

/**
 * Sabotage an enemy building
 */
function sabotage(id) {
    const enemy = game.enemyBuildings.find(b => b.id === id);
    if (!enemy) {
        console.warn('No enemy building at this location');
        return;
    }

    const cost = buildingTypes[enemy.type].cost - 200;
    if (game.playerWallet < cost) {
        console.warn('Insufficient funds for sabotage');
        return;
    }

    game.playerWallet -= cost;
    game.tokensBurned += cost;
    game.prizePool += Math.floor(cost * 0.10);
    // drain liquidity pool → pushes price up via bonding curve
    game.market.tokenPool = Math.max(1, game.market.tokenPool - cost / game.market.poolBurnRate);
    const idx = game.enemyBuildings.findIndex(b => b.id === id);
    game.enemyBuildings.splice(idx, 1);

    const cell = document.querySelector('[data-id="' + id + '"]');
    cell.innerHTML = '';
    cell.className = 'cell';

    calculateProximity();
    updateUI();
    game.selectedMode = null;
}

/**
 * Render a building on the grid
 */
function renderBuilding(id, type, isPlayer) {
    const cell = document.querySelector('[data-id="' + id + '"]');
    cell.className = 'cell owned ' + type + (isPlayer ? ' owned-player' : ' owned-enemy');

    // Render either an SVG monochrome icon (tintable) or fallback to emoji text.
    const tint = isPlayer ? PLAYER_COLOR : ENEMY_COLOR;
    // Always render a proper SVG for `storage` so the vault/silo looks consistent.
    if (USE_SVG_ICONS || type === 'storage') {
        const svg = getIconSVG(type, tint);
        cell.innerHTML = svg;
    } else {
        const emoji = buildingTypes[type].emoji || '';
        cell.innerHTML = `<span class="icon-emoji" style="color:${tint};">${emoji}</span>`;
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
            const power = Math.max(0, base + jitter);
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
    if (prizePoolEl) prizePoolEl.textContent = formatSupply(game.prizePool);
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
    initGrid();
    initRun();   // collect buy-ins, seed prize pool & bonding curve pool (once per run)
    updateUI();
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

    const modal = document.getElementById('lobbyModal');
    if (!modal) { startGame(); return; } // fallback if modal missing

    // prize pool preview = 80% of all buy-ins
    const preview = Math.floor(game.players.length * game.buyIn * 0.80);

    document.getElementById('lobbyBuyIn').textContent = game.buyIn.toLocaleString();
    document.getElementById('lobbyPrizePreview').textContent = preview.toLocaleString();
    document.getElementById('lobbyWalletAfter').textContent =
        (game.playerWallet - game.buyIn).toLocaleString();

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
 * Production tick: called every real-second to produce continuous feel.
 */
function productionTick() {
    // Count buildings
    let totalMines = 0;
    let totalPlants = 0;
    game.buildings.forEach(b => {
        if (b.type === 'mine') totalMines++;
        if (b.type === 'plant') totalPlants++;
    });

    // ── Mines → uraniumRaw ────────────────────────────────────────────────────
    // Each mine independently yields a small random amount per tick (organic feel).
    // Range 0.10–0.35 U/sec per mine, average ~0.22.
    let produced = 0;
    for (let i = 0; i < totalMines; i++) {
        produced += 0.10 + Math.random() * 0.25;
    }
    const totalStored = game.uraniumRaw + game.uraniumRefined;
    const rawHeadroom = Math.max(0, game.maxStorage - totalStored);
    const actualProduced = Math.min(rawHeadroom, produced);
    game.dailyProduced += actualProduced;
    game.uraniumRaw += actualProduced;

    // ── Processors → convert raw into refined ─────────────────────────────────
    // Each processor converts a small random trickle per tick (avg ~0.15 U/sec).
    // No processor = no refined uranium = no plant income.
    let totalProcessors = 0;
    game.buildings.forEach(b => { if (b.type === 'processor') totalProcessors++; });
    let converted = 0;
    for (let i = 0; i < totalProcessors; i++) {
        converted += 0.08 + Math.random() * 0.14; // avg ~0.15 U/sec per processor
    }
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
    // end of run: all 8 rounds (days) completed — distribute prizes and cycle
    if (game.time.day > 8) {
        game.time.day = 1;
        game.round = (game.round % 8) + 1;
        distributePrizePool();
    }
    document.getElementById('day').textContent = game.time.day;
    // show end-of-day summary modal
    showEndOfDaySummary();
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
        content = `<div style="font-weight:700;">Place: ${label}</div>` +
            `<div>Same-type neighbors: ${same} (${same>0? '+'+ (same*25) +'% efficiency': 'no bonus'})</div>` +
            `<div>Nearby enemies: ${pen}</div>`;
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
        content = `<div style="font-weight:700;">${label} (You)</div>` +
            `<div>Same-type neighbors: ${same} (${same>0? '+'+ (same*25) +'%': 'none'})</div>` +
            `<div>Nearby enemies: ${pen}</div>`;
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // If hovering an enemy building (only show details when NOT in build mode)
    if (enemy && !game.selectedMode) {
        const type = enemy.type;
        const sabotageCost = Math.max(0, buildingTypes[type].cost - 200);
        const label = displayNames[type] || type;
        content = `<div style="font-weight:700;">${label} (Enemy)</div>` +
            `<div>Sabotage cost: ${sabotageCost.toLocaleString()} tokens</div>` +
            `<div>Effect: destroys building, removes its production</div>`;
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
            <strong style="color:#ffb84d;">Prize Pool: ${game.prizePool.toLocaleString()} tokens</strong>
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

    // reset daily accumulators
    game.dailyProduced = 0;
    game.dailyIncome = 0;
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
        btn.addEventListener('mouseenter', (e) => {
            const typeKey = btn.dataset.type || btn.textContent.trim();
            const label = displayNames[typeKey] || btn.textContent.trim();
            let content = '<div style="font-weight:700;">' + label + '</div>';
            if (typeKey === 'mine' || /mine/i.test(typeKey)) {
                content += '<div>Place a Mine to extract raw uranium from the ground. Cost: ' + buildingTypes.mine.cost + ' tokens.</div>';
            } else if (typeKey === 'processor' || /process/i.test(typeKey)) {
                content += '<div>Place a Plant to refine/transform raw material. Cost: ' + buildingTypes.processor.cost + ' tokens.</div>';
            } else if (typeKey === 'storage' || /store/i.test(typeKey)) {
                content += '<div>Place Storage (vault) to increase fuel capacity. Cost: ' + buildingTypes.storage.cost + ' tokens.</div>';
            } else if (typeKey === 'plant' || /plant/i.test(typeKey)) {
                content += '<div>Place a Reactor to consume fuel and generate power/income. Cost: ' + buildingTypes.plant.cost + ' tokens.</div>';
            } else if (typeKey === 'sabotage' || /sabotage/i.test(typeKey)) {
                content += '<div>Sabotage an enemy building. Click the Sabotage button then click an enemy cell. Cost varies by target.</div>';
            } else if (typeKey === 'dev' || /dev/i.test(typeKey)) {
                content += '<div>Toggle developer tools: advance time, change simulation speed for testing.</div>';
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
