// Game state
const game = {
    playerWallet: 50000,
    uranium: 0,
    maxStorage: 100,
    buildings: [],
    enemyBuildings: [],
    selectedMode: null,
    selectedCell: null,
    proximityRange: 2,
    round: 1
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
    // hourly volatility (higher makes price swing more). 0.03 = ~3% hourly
    volatility: 0.03 // hourly volatility
};
// per-second volatility is smaller (for stock-like per-second ticks)
game.market.perSecondVol = game.market.volatility / 60;
// demand model parameters
game.market.baseDemand = 1000; // baseline demand units (tunable)
game.market.driftFactor = 0.0008; // per-second drift scaling (tunable)

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

// Enemy list
const enemies = [
    { name: 'PHANTOM_IX' },
    { name: 'NEUTRON_' }
];

/**
 * Initialize the game grid
 */
function initGrid() {
    const grid = document.getElementById('gameGrid');
    grid.innerHTML = '';
    
    for (let i = 0; i < 400; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
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
    game.buildings.push({ id, type, owner: 'YOU' });

    if (type === 'storage') {
        game.maxStorage += 100;
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
    // `game.uranium` here — production/consumption is handled in productionTick.
    return totalPower;
}

/**
 * Update UI with current game state
 */
function updateUI() {
    document.getElementById('wallet').textContent = game.playerWallet.toLocaleString();
    document.getElementById('uranium').textContent = game.uranium;
    document.getElementById('stored').textContent = game.uranium + '/' + game.maxStorage;
    
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
        const value = game.playerWallet + (game.uranium * game.market.price);
        portfolioEl.textContent = '$' + value.toFixed(2).toLocaleString();
    }
}

/**
 * Initialize game on page load
 */
function startGame() {
    initGrid();
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
        const portfolio = (game.playerWallet + (game.uranium * game.market.price)) || 0;
        statsEl.textContent = `Tokens: ${game.playerWallet.toLocaleString()} — Uranium: ${game.uranium} — Portfolio: $${portfolio.toFixed(2)}`;
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
    // if session token present, bypass login
    if (sessionStorage.getItem('nuke_auth') === '1') {
        document.body.classList.add('authenticated');
        // hide modal if present
        const modal = document.getElementById('loginModal');
        if (modal) modal.style.display = 'none';
        startGame();
    }

    // show login modal and wire events
    const loginBtn = document.getElementById('loginBtn');
    const pwd = document.getElementById('passwordInput');
    const profileBtn = document.getElementById('profileBtn');
    if (loginBtn) loginBtn.addEventListener('click', checkPassword);
    if (pwd) pwd.addEventListener('keyup', (e) => { if (e.key === 'Enter') checkPassword(); });
    if (profileBtn) profileBtn.addEventListener('click', toggleProfile);
});

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

    // Mines produce uranium per production tick
    const mineProductionPerTick = 5; // prototype value per second
    const produced = totalMines * mineProductionPerTick;
    const newU = Math.min(game.maxStorage, game.uranium + produced);
    game.dailyProduced += Math.max(0, newU - game.uranium);
    game.uranium = newU;

    // Plants consume fuel to generate income
    const fuelPerPlantPerTick = 10; // prototype
    const requiredFuel = totalPlants * fuelPerPlantPerTick;
    let fuelConsumed = 0;
    let income = 0;

    if (requiredFuel > 0 && game.uranium > 0) {
        fuelConsumed = Math.min(requiredFuel, game.uranium);
        const power = calculatePower();
        const powerFraction = fuelConsumed / requiredFuel;
        income = Math.floor(power * powerFraction * 2); // tokens per production tick
        game.uranium -= fuelConsumed;
    }

    game.playerWallet += income;
    game.lastIncome = income;
    game.dailyIncome += income;

    // market ticks every production tick so it behaves like a stock price
    game.market.prevPrice = game.market.price;
    tickMarket();

    updateUI();
}

/**
 * Small per-second market tick to simulate stock-like movement.
 */
function tickMarket() {
    const vol = game.market.perSecondVol;
    const u = Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const noiseChange = z * vol * game.market.price;

    // Demand-driven drift: price moves up when demand > supply, down when supply > demand
    // supply: approximate by total power output (higher supply -> downward pressure)
    const supply = calculatePower();
    // allow demand to vary with hour (diurnal pattern)
    const diurnal = Math.sin((game.time.hour / 24) * Math.PI * 2) * 0.2; // -0.2..0.2
    const demand = Math.max(10, game.market.baseDemand * (1 + diurnal));
    const supplyDemandDelta = (demand - supply) / demand; // positive -> upward pressure
    const drift = supplyDemandDelta * game.market.driftFactor * game.market.price;

    const change = noiseChange + drift;
    game.market.price = Math.max(0.01, +(game.market.price + change).toFixed(4));
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
    // end of day logic: increment round when day passes 8
    if (game.time.day > 8) {
        game.time.day = 1;
        game.round = (game.round % 8) + 1;
    }
    document.getElementById('day').textContent = game.time.day;
    // show end-of-day summary modal
    showEndOfDaySummary();
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

    content.innerHTML = `
        <div>Day: ${game.time.day}</div>
        <div>Power (current): ${power.toFixed(1)} MW</div>
        <div>Uranium produced today: ${dayProduced}</div>
        <div>Income today: ${dayIncome.toLocaleString()} tokens</div>
    `;

    // build simple leaderboard (You + enemies)
    const entries = [];
    // player score: weighted by power + portfolio
    const playerPortfolio = game.playerWallet + (game.uranium * game.market.price);
    const playerScore = power + (playerPortfolio / 1000);
    entries.push({ name: 'You', score: playerScore, wallet: game.playerWallet, portfolio: playerPortfolio });

    // approximate enemy stats
    const enemyMap = {};
    game.enemyBuildings.forEach(b => {
        if (!enemyMap[b.owner]) enemyMap[b.owner] = { mines: 0, plants: 0, storage:0, processors:0 };
        if (b.type === 'mine') enemyMap[b.owner].mines++;
        if (b.type === 'plant') enemyMap[b.owner].plants++;
        if (b.type === 'storage') enemyMap[b.owner].storage++;
        if (b.type === 'processor') enemyMap[b.owner].processors++;
    });
    for (const owner in enemyMap) {
        const e = enemyMap[owner];
        const estPower = e.plants * 100; // rough
        const estUranium = e.mines * 50;
        const estPortfolio = estPower + (estUranium * game.market.price);
        const score = estPower + (estPortfolio / 1000);
        entries.push({ name: owner, score, wallet: 0, portfolio: estPortfolio });
    }

    // sort and render leaderboard
    entries.sort((a,b) => b.score - a.score);
    lb.innerHTML = entries.map((r, i) => `<div style="margin-bottom:6px;"><strong>#${i+1}</strong> ${r.name} — Score: ${r.score.toFixed(2)} — Portfolio: $${r.portfolio.toFixed(2)}</div>`).join('');

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
