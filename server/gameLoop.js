const db = require('./db');

const DAY_DURATION_MS = parseInt(process.env.DAY_DURATION_MS || '86400000', 10);
const RUN_LENGTH = parseInt(process.env.RUN_LENGTH || '3', 10);
let _nextRunLength = RUN_LENGTH;  // can be overridden at runtime by admin
function setNextRunLength(n) { _nextRunLength = n; }

// ── Per-run terrain + deposit cache ──────────────────────────────────────────
// Keyed by runId. Populated once on run creation and lazily on server restart.
const _terrainCache = new Map();
const _depositsCache = new Map();

function getOrGenerateTerrain(runId) {
    if (!_terrainCache.has(runId)) {
        _terrainCache.set(runId, generateTerrainForRun(runId));
    }
    return _terrainCache.get(runId);
}

function getOrGenerateDeposits(runId) {
    const terrain = getOrGenerateTerrain(runId);
    if (!_depositsCache.has(runId)) {
        const ROAD_TYPES = new Set(['road', 'road-h', 'road-x']);
        const raw = generateDepositsForRun(runId, terrain);
        // Safety-net: strip any deposit that landed on a road cell (guards against
        // stale cached data or edge cases in generation).
        const deps = raw.filter(d => !ROAD_TYPES.has(terrain[d.cellId]));
        console.log(`[deposits] generated ${deps.length} cells in ${new Set(deps.map(d => d.cellId)).size} unique positions for run ${runId} (minClusters=${DEPOSIT_MIN_CLUSTERS} maxExtra=${DEPOSIT_MAX_EXTRA_CLUSTERS})`);
        _depositsCache.set(runId, deps);
    }
    return _depositsCache.get(runId);
}
// Runtime-configurable globals (can be updated from DB)
let BUY_IN = Number(process.env.BUY_IN || 20000);
let BUILD_SLOTS = Number(process.env.BUILD_SLOTS || 1); // concurrent buildings under construction per player
let GRID_COLS = Number(process.env.GRID_COLS || 20);
let GRID_ROWS = Number(process.env.GRID_ROWS || 20);
let PROXIMITY_RANGE = Number(process.env.PROXIMITY_RANGE || 2);
let TOTAL_TOKEN_SUPPLY = Number(process.env.TOTAL_TOKEN_SUPPLY || 1000000000);
let MARKET_BASE_PRICE = Number(process.env.MARKET_BASE_PRICE || 1);
let MARKET_TOKEN_POOL_INITIAL = Number(process.env.MARKET_TOKEN_POOL_INITIAL || 1000);
let MARKET_POOL_BURN_RATE = Number(process.env.MARKET_POOL_BURN_RATE || 50);
let MARKET_VOLATILITY = Number(process.env.MARKET_VOLATILITY || 0.03);
let MARKET_PER_SECOND_VOL = MARKET_VOLATILITY / 60;
let MARKET_BASE_DEMAND = Number(process.env.MARKET_BASE_DEMAND || 1000);
let MARKET_DRIFT_FACTOR = Number(process.env.MARKET_DRIFT_FACTOR || 0.0002);
const BUILDING_RULES = {
    mine:      { cost: 800,  constructionMs: 10000, maintenanceCost: 2 },
    processor: { cost: 1200, constructionMs: 15000, maintenanceCost: 3 },
    storage:   { cost: 1000, constructionMs: 20000, maintenanceCost: 2,  storageBonus: 1000 },
    plant:     { cost: 1000, constructionMs: 22000, maintenanceCost: 10, basePower: 100 },
    silo:      { cost: 6000, constructionMs: 35000, maintenanceCost: 25, isWeapon: true },
};

// Additional runtime-configurable economy/sabotage/production params
let MINE_BASE_PRODUCTION = Number(process.env.MINE_BASE_PRODUCTION || 0.225);
let PROCESSOR_CONVERT_RATE = Number(process.env.PROCESSOR_CONVERT_RATE || 0.15);
let PLANT_BASE_POWER = Number(process.env.PLANT_BASE_POWER || 100);
let INCOME_POWER_MULT = Number(process.env.INCOME_POWER_MULT || 0.1);
let PROXIMITY_BONUS_PER_BUILDING = Number(process.env.PROXIMITY_BONUS_PER_BUILDING || 0.25);
let PROXIMITY_BONUS_CAP = Number(process.env.PROXIMITY_BONUS_CAP || 3);

let SABOTAGE_DISABLE_COST = Number(process.env.SABOTAGE_DISABLE_COST || 300);
let SABOTAGE_STEAL_COST = Number(process.env.SABOTAGE_STEAL_COST || 500);
let SABOTAGE_NUKE_COST_PCT = Number(process.env.SABOTAGE_NUKE_COST_PCT || 0.5);
let SABOTAGE_FAILURE_CHANCE = Number(process.env.SABOTAGE_FAILURE_CHANCE || 0.15);
let SABOTAGE_DISABLE_DURATION_MS = Number(process.env.SABOTAGE_DISABLE_DURATION_MS || 45000);
let SABOTAGE_NUKE_FALLOUT_RADIUS = Number(process.env.SABOTAGE_NUKE_FALLOUT_RADIUS || 3);
let SABOTAGE_NUKE_FALLOUT_DURATION_MS = Number(process.env.SABOTAGE_NUKE_FALLOUT_DURATION_MS || 120000);
let STRIKE_LIMIT_PER_DAY = Number(process.env.STRIKE_LIMIT_PER_DAY || 1);
let MAINTENANCE_REFUND_PCT = Number(process.env.MAINTENANCE_REFUND_PCT || 0.75);
let NUKE_COUNTDOWN_MS = Number(process.env.NUKE_COUNTDOWN_MS || 15000);
let NUKE_MANUFACTURE_MS = Number(process.env.NUKE_MANUFACTURE_MS || 120000);
let NUKE_MANUFACTURE_COST = Number(process.env.NUKE_MANUFACTURE_COST || 1000);
let NUKE_MAX_INVENTORY = Number(process.env.NUKE_MAX_INVENTORY || 3);       // max nukes a player can hold in their silo
let NUKE_LAUNCH_COOLDOWN_MS = Number(process.env.NUKE_LAUNCH_COOLDOWN_MS || 0); // ms player must wait between launches (0 = no cooldown)
let NUKE_MAX_SILOS = Number(process.env.NUKE_MAX_SILOS || 3);                   // max silos a player can build per round

// ── Uranium deposit generation config ───────────────────────────────────────
let DEPOSIT_MIN_CLUSTERS         = Number(process.env.DEPOSIT_MIN_CLUSTERS || 8);   // minimum deposit cluster centres per run
let DEPOSIT_MAX_EXTRA_CLUSTERS   = Number(process.env.DEPOSIT_MAX_EXTRA_CLUSTERS || 6); // rand(0..N) extra clusters added on top

// ── Surveyor config ──────────────────────────────────────────────────────────
let SURVEYOR_COST                = Number(process.env.SURVEYOR_COST || 500);
let SURVEYOR_MAINT_PER_TICK      = Number(process.env.SURVEYOR_MAINT_PER_TICK || 1);
let SURVEYOR_DURATION_MS         = Number(process.env.SURVEYOR_DURATION_MS || 300000); // 5 min
let SURVEYOR_DISCOVER_RADIUS     = Number(process.env.SURVEYOR_DISCOVER_RADIUS || 2);
let SURVEYOR_MOVE_EVERY_N_TICKS  = Number(process.env.SURVEYOR_MOVE_EVERY_N_TICKS || 3); // base move speed (1 = every tick = 1 s)
let SURVEYOR_MAGNETISM           = Number(process.env.SURVEYOR_MAGNETISM || 6);  // extra weight per nearby undiscovered deposit cell

function chebyshevDist(a, b) {
    const ax = a % GRID_COLS, ay = Math.floor(a / GRID_COLS);
    const bx = b % GRID_COLS, by = Math.floor(b / GRID_COLS);
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

// Single-ring cluster expansion: from seed deposit cells, reveal any deposits
// within clusterRadius of those seeds — but does NOT recurse from newly-found
// cells, so only the immediately adjacent ring is added, not the whole cluster at once.
function expandDepositCluster(seedCellIds, allDeposits, clusterRadius = 2) {
    const found = new Set(seedCellIds);
    for (const seed of seedCellIds) {
        for (const d of allDeposits) {
            if (!found.has(d.cellId) && chebyshevDist(seed, d.cellId) <= clusterRadius) {
                found.add(d.cellId);
            }
        }
    }
    return [...found];
}

function surveyorRandomWalk(cellId, terrain, deposits, discoveredSet) {
    const x = cellId % GRID_COLS;
    const y = Math.floor(cellId / GRID_COLS);
    const ROAD_TYPES = new Set(['road', 'road-h', 'road-x']);

    // Build candidate moves: all 8 neighbours + stay
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const nx = Math.max(0, Math.min(GRID_COLS - 1, x + dx));
            const ny = Math.max(0, Math.min(GRID_ROWS - 1, y + dy));
            const ncell = ny * GRID_COLS + nx;
            // Skip road cells — surveyors explore terrain, not roads
            if (terrain && ROAD_TYPES.has(terrain[ncell])) continue;
            candidates.push(ncell);
        }
    }
    if (candidates.length === 0) return cellId; // fully surrounded by roads, stay put

    // Bias towards undiscovered deposit cells: weight a candidate higher if
    // there is an undiscovered deposit within SURVEYOR_DISCOVER_RADIUS of it.
    const weights = candidates.map(c => {
        let w = 1;
        if (deposits && discoveredSet) {
            for (const d of deposits) {
                if (!discoveredSet.has(d.cellId) && chebyshevDist(c, d.cellId) <= SURVEYOR_DISCOVER_RADIUS + 1) {
                    w += SURVEYOR_MAGNETISM; // configurable pull towards undiscovered deposit clusters
                }
            }
        }
        return w;
    });

    // Weighted random selection
    const total = weights.reduce((s, w) => s + w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < candidates.length; i++) {
        r -= weights[i];
        if (r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
}

function setBuildingRules(type, cost, constructionMs, maintenanceCost) {
    if (!BUILDING_RULES[type]) return false;
    if (Number.isFinite(Number(cost)) && Number(cost) >= 0) BUILDING_RULES[type].cost = Math.floor(Number(cost));
    if (Number.isFinite(Number(constructionMs)) && Number(constructionMs) >= 0) BUILDING_RULES[type].constructionMs = Math.floor(Number(constructionMs));
    if (Number.isFinite(Number(maintenanceCost)) && Number(maintenanceCost) >= 0) BUILDING_RULES[type].maintenanceCost = Math.floor(Number(maintenanceCost));
    return true;
}

async function loadBuildingRulesFromDB() {
    try {
        const result = await db.query("SELECT key, value FROM server_config WHERE key LIKE 'building.%'");
        result.rows.forEach(({ key, value }) => {
            // key format: building.<type>.<field>  e.g. building.mine.cost
            const parts = key.split('.');
            if (parts.length !== 3) return;
            const [, type, field] = parts;
            if (!BUILDING_RULES[type]) return;
            const num = Number(value);
            // Support numeric building fields generically (cost, constructionMs, maintenanceCost, basePower, storageBonus, etc.)
            if (!Number.isFinite(num)) return;
            BUILDING_RULES[type][field] = Math.floor(num);
        });

        // Always re-seed maintenanceCost from hardcoded defaults so stale DB values
        // from earlier deployments never override the current intended values.
        const seedParams = [];
        const seedValues = [];
        let p = 1;
        for (const [type, rule] of Object.entries(BUILDING_RULES)) {
            seedParams.push(`($${p++}, $${p++}, NOW())`);
            seedValues.push(`building.${type}.maintenanceCost`, String(rule.maintenanceCost ?? 0));
        }
        await db.query(
            `INSERT INTO server_config (key, value, updated_at) VALUES ${seedParams.join(', ')}
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            seedValues
        );

        console.log('[config] Building rules loaded from DB:', JSON.stringify(BUILDING_RULES));
    } catch (err) {
        console.warn('[config] Could not load building rules from DB (table may not exist yet):', err.message);
    }
}

// Load generic runtime server_config values into in-memory variables.
async function loadRuntimeConfigFromDB() {
    try {
        const result = await db.query('SELECT key, value FROM server_config');
        result.rows.forEach(({ key, value }) => {
            if (typeof value !== 'string') return;
            // Map known keys to variables
            switch (key) {
                case 'game.buy_in': BUY_IN = Number(value); break;
                case 'game.build_slots': BUILD_SLOTS = Number(value); break;
                case 'grid.cols': GRID_COLS = Number(value); break;
                case 'grid.rows': GRID_ROWS = Number(value); break;
                case 'game.proximity_range': PROXIMITY_RANGE = Number(value); break;
                case 'economy.total_token_supply': TOTAL_TOKEN_SUPPLY = Number(value); break;
                case 'market.base_price': MARKET_BASE_PRICE = Number(value); break;
                case 'market.token_pool_initial': MARKET_TOKEN_POOL_INITIAL = Number(value); break;
                case 'market.pool_burn_rate': MARKET_POOL_BURN_RATE = Number(value); break;
                case 'market.volatility': MARKET_VOLATILITY = Number(value); break;
                case 'market.base_demand': MARKET_BASE_DEMAND = Number(value); break;
                case 'market.drift_factor': MARKET_DRIFT_FACTOR = Number(value); break;
                // Production tuning
                case 'production.mine.base': MINE_BASE_PRODUCTION = Number(value); break;
                case 'production.processor.convert_rate': PROCESSOR_CONVERT_RATE = Number(value); break;
                case 'production.plant.base_power': PLANT_BASE_POWER = Number(value); break;
                case 'production.plant.income_mult': INCOME_POWER_MULT = Number(value); break;
                case 'game.proximity_bonus_per_building': PROXIMITY_BONUS_PER_BUILDING = Number(value); break;
                case 'game.proximity_bonus_cap': PROXIMITY_BONUS_CAP = Number(value); break;
                // Sabotage / nuke tuning
                case 'sabotage.disable_cost': SABOTAGE_DISABLE_COST = Number(value); break;
                case 'sabotage.steal_cost': SABOTAGE_STEAL_COST = Number(value); break;
                case 'sabotage.nuke_cost_pct': SABOTAGE_NUKE_COST_PCT = Number(value); break;
                case 'sabotage.failure_chance': SABOTAGE_FAILURE_CHANCE = Number(value); break;
                case 'sabotage.disable_duration_ms': SABOTAGE_DISABLE_DURATION_MS = Number(value); break;
                case 'sabotage.nuke_fallout_radius': SABOTAGE_NUKE_FALLOUT_RADIUS = Number(value); break;
                case 'sabotage.nuke_fallout_duration_ms': SABOTAGE_NUKE_FALLOUT_DURATION_MS = Number(value); break;
                case 'sabotage.strike_limit_per_day': STRIKE_LIMIT_PER_DAY = Number(value); break;
                case 'game.maintenance_refund_pct': MAINTENANCE_REFUND_PCT = Number(value); break;
                case 'nuke.countdown_ms': NUKE_COUNTDOWN_MS = Math.max(3000, Number(value)); break;
                case 'nuke.manufacture_ms': NUKE_MANUFACTURE_MS = Math.max(5000, Number(value)); break;
                case 'nuke.manufacture_cost': NUKE_MANUFACTURE_COST = Math.max(0, Number(value)); break;
                case 'nuke.max_inventory': NUKE_MAX_INVENTORY = Math.max(1, Number(value)); break;
                case 'nuke.launch_cooldown_ms': NUKE_LAUNCH_COOLDOWN_MS = Math.max(0, Number(value)); break;
                case 'nuke.max_silos': NUKE_MAX_SILOS = Math.max(1, Number(value)); break;
                // Surveyor tuning
                case 'surveyor.cost': SURVEYOR_COST = Number(value); break;
                case 'surveyor.maint_per_tick': SURVEYOR_MAINT_PER_TICK = Number(value); break;
                case 'surveyor.duration_ms': { const n = Number(value); SURVEYOR_DURATION_MS = (Number.isFinite(n) && n > 0) ? n : SURVEYOR_DURATION_MS; break; }
                case 'surveyor.discover_radius': SURVEYOR_DISCOVER_RADIUS = Number(value); break;
                case 'surveyor.move_every_n_ticks': SURVEYOR_MOVE_EVERY_N_TICKS = Math.max(0.1, Number(value)); break;
                case 'surveyor.magnetism': SURVEYOR_MAGNETISM = Math.max(0, Number(value)); break;
                case 'deposit.min_clusters': DEPOSIT_MIN_CLUSTERS = Math.max(1, Math.floor(Number(value))); break;
                case 'deposit.max_extra_clusters': DEPOSIT_MAX_EXTRA_CLUSTERS = Math.max(0, Math.floor(Number(value))); break;
                default: {
                    // building.* keys are handled by loadBuildingRulesFromDB earlier
                    break;
                }
            }
        });
        // Recompute derived values
        MARKET_PER_SECOND_VOL = MARKET_VOLATILITY / 60;

        // Seed surveyor defaults into server_config so they are persisted and
        // admin-editable via balance.html. Uses DO NOTHING so existing DB values
        // (set via the admin panel) are never overwritten on restart.
        const surveyorDefaults = [
            ['surveyor.cost',                 String(SURVEYOR_COST)],
            ['surveyor.duration_ms',          String(SURVEYOR_DURATION_MS)],
            ['surveyor.maint_per_tick',       String(SURVEYOR_MAINT_PER_TICK)],
            ['surveyor.discover_radius',      String(SURVEYOR_DISCOVER_RADIUS)],
            ['surveyor.move_every_n_ticks',   String(SURVEYOR_MOVE_EVERY_N_TICKS)],
            ['surveyor.magnetism',            String(SURVEYOR_MAGNETISM)],
            ['deposit.min_clusters',          String(DEPOSIT_MIN_CLUSTERS)],
            ['deposit.max_extra_clusters',    String(DEPOSIT_MAX_EXTRA_CLUSTERS)],
        ];
        for (const [k, v] of surveyorDefaults) {
            await db.query(
                `INSERT INTO server_config (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO NOTHING`,
                [k, v]
            );
        }
        // Re-read surveyor keys from DB so in-memory vars reflect any admin-saved values
        const svRes = await db.query("SELECT key, value FROM server_config WHERE key LIKE 'surveyor.%'");
        svRes.rows.forEach(({ key, value }) => {
            switch (key) {
                case 'surveyor.cost':                 SURVEYOR_COST                = Number(value); break;
                case 'surveyor.duration_ms':           { const n = Number(value); SURVEYOR_DURATION_MS = (Number.isFinite(n) && n > 0) ? n : SURVEYOR_DURATION_MS; break; }
                case 'surveyor.maint_per_tick':        SURVEYOR_MAINT_PER_TICK      = Number(value); break;
                case 'surveyor.discover_radius':       SURVEYOR_DISCOVER_RADIUS     = Number(value); break;
                case 'surveyor.move_every_n_ticks':    SURVEYOR_MOVE_EVERY_N_TICKS  = Math.max(0.1, Number(value)); break;
                case 'surveyor.magnetism':             SURVEYOR_MAGNETISM           = Math.max(0, Number(value)); break;
            }
        });
        // Re-read deposit keys separately (different prefix)
        const depRes = await db.query("SELECT key, value FROM server_config WHERE key LIKE 'deposit.%'");
        depRes.rows.forEach(({ key, value }) => {
            switch (key) {
                case 'deposit.min_clusters':       DEPOSIT_MIN_CLUSTERS       = Math.max(1, Math.floor(Number(value))); break;
                case 'deposit.max_extra_clusters': DEPOSIT_MAX_EXTRA_CLUSTERS = Math.max(0, Math.floor(Number(value))); break;
            }
        });

        console.log('[config] Runtime config loaded from DB');
    } catch (err) {
        console.warn('[config] Could not load runtime config from DB:', err.message);
    }
}

async function saveBuildingRulesToDB(type) {
    const r = BUILDING_RULES[type];
    if (!r) return;
    await db.query(
        `INSERT INTO server_config (key, value, updated_at)
         VALUES ($1, $2, NOW()), ($3, $4, NOW()), ($5, $6, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [
            `building.${type}.cost`,            String(r.cost),
            `building.${type}.constructionMs`,  String(r.constructionMs),
            `building.${type}.maintenanceCost`, String(r.maintenanceCost ?? 0),
        ]
    );
}

function parseRunRow(row) {
    if (!row) return null;
    return {
        ...row,
        prize_pool: parseInt(row.prize_pool, 10) || 0,
        current_day: parseInt(row.current_day, 10) || 1,
        run_length: parseInt(row.run_length, 10) || RUN_LENGTH,
        market_price: Number(row.market_price ?? MARKET_BASE_PRICE),
        market_prev_price: Number(row.market_prev_price ?? row.market_price ?? MARKET_BASE_PRICE),
        market_token_pool: Number(row.market_token_pool ?? MARKET_TOKEN_POOL_INITIAL),
        market_token_pool_initial: Number(row.market_token_pool_initial ?? MARKET_TOKEN_POOL_INITIAL),
        tokens_issued: parseInt(row.tokens_issued, 10) || 0,
        tokens_burned: parseInt(row.tokens_burned, 10) || 0,
        platform_fee_collected: parseInt(row.platform_fee_collected, 10) || 0,
        total_token_supply: parseInt(row.total_token_supply, 10) || TOTAL_TOKEN_SUPPLY,
        day_duration_ms: parseInt(row.day_duration_ms, 10) || DAY_DURATION_MS,
    };
}

async function getActiveRun() {
    const result = await db.query(
        "SELECT * FROM runs WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    );
    return parseRunRow(result.rows[0]);
}

async function createNewRun() {
    const countResult = await db.query('SELECT COUNT(*) FROM runs');
    const runNumber = parseInt(countResult.rows[0].count, 10) + 1;
    const nextDayAt = new Date(Date.now() + DAY_DURATION_MS);

    const result = await db.query(
        `INSERT INTO runs (
            run_number,
            current_day,
            run_length,
            prize_pool,
            market_price,
            market_prev_price,
            market_token_pool,
            market_token_pool_initial,
            tokens_issued,
            tokens_burned,
            total_token_supply,
            day_duration_ms,
            next_day_at,
            status
        )
         VALUES ($1, 1, $2, 0, $3, $3, $4, $4, 0, 0, $5, $6, $7, 'active')
         RETURNING *`,
        [runNumber, _nextRunLength, MARKET_BASE_PRICE, MARKET_TOKEN_POOL_INITIAL, TOTAL_TOKEN_SUPPLY, DAY_DURATION_MS, nextDayAt]
    );
    console.log(`🔥 New run #${runNumber} started (day duration: ${DAY_DURATION_MS}ms)`);
    // Pre-warm terrain + deposit cache so first player join is instant
    getOrGenerateTerrain(result.rows[0].id);
    getOrGenerateDeposits(result.rows[0].id);
    return parseRunRow(result.rows[0]);
}

function hashSeed(input) {
    const text = String(input || 'seed');
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function createSeededRandom(label, runId) {
    let seed = hashSeed(`${label}:${runId || 'offline'}:${RUN_LENGTH}`);
    return function seededRandom() {
        seed += 0x6D2B79F5;
        let t = seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function generateTerrainForRun(runId, width = GRID_COLS, height = GRID_ROWS) {
    const rand = createSeededRandom(`terrain:${width}x${height}`, runId);
    const out = new Array(width * height).fill('grass');
    const centerX = Math.floor(width / 2);

    for (let y = 0; y < height; y++) {
        out[y * width + centerX] = 'road';
    }

    const branchRows = [];
    while (branchRows.length < 2) {
        const row = 2 + Math.floor(rand() * (height - 4));
        if (!branchRows.includes(row)) branchRows.push(row);
    }

    branchRows.forEach((row) => {
        const len = 3 + Math.floor(rand() * 5);
        out[row * width + centerX] = 'road-x';
        for (let dx = 1; dx <= len; dx++) {
            if (centerX - dx >= 0) out[row * width + (centerX - dx)] = 'road-h';
            if (centerX + dx < width) out[row * width + (centerX + dx)] = 'road-h';
        }
    });

    for (let i = 0; i < width * height * 0.08; i++) {
        const cx = Math.floor(rand() * width);
        const cy = Math.floor(rand() * height);
        const radius = 1 + Math.floor(rand() * 2);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    const idx = y * width + x;
                    if (!['road', 'road-h', 'road-x'].includes(out[idx]) && rand() > 0.25) {
                        out[idx] = 'dirt';
                    }
                }
            }
        }
    }

    return out;
}

function generateDepositsForRun(runId, terrain, width = GRID_COLS, height = GRID_ROWS) {
    const rand = createSeededRandom(`deposits:${width}x${height}`, runId);
    const deposits = [];
    const numDeposits = DEPOSIT_MIN_CLUSTERS + Math.floor(rand() * (DEPOSIT_MAX_EXTRA_CLUSTERS + 1));
    console.log(`[generateDepositsForRun] run=${runId} DEPOSIT_MIN_CLUSTERS=${DEPOSIT_MIN_CLUSTERS} DEPOSIT_MAX_EXTRA_CLUSTERS=${DEPOSIT_MAX_EXTRA_CLUSTERS} numDeposits=${numDeposits}`);

    for (let d = 0; d < numDeposits; d++) {
        const cx = 2 + Math.floor(rand() * (width - 4));
        const cy = 2 + Math.floor(rand() * (height - 4));
        const depositRadius = 1 + Math.floor(rand() * 2);

        for (let dy = -depositRadius; dy <= depositRadius; dy++) {
            for (let dx = -depositRadius; dx <= depositRadius; dx++) {
                if (rand() > 0.25) {
                    const x = cx + dx;
                    const y = cy + dy;
                    if (x >= 0 && x < width && y >= 0 && y < height) {
                        const cellId = y * width + x;
                        if (!['road', 'road-h', 'road-x'].includes(terrain[cellId])) {
                            deposits.push({ cellId, quality: 0.5 + rand() * 0.5 });
                        }
                    }
                }
            }
        }
    }

    // Deduplicate: keep the highest-quality entry per cell
    const best = new Map();
    for (const d of deposits) {
        if (!best.has(d.cellId) || d.quality > best.get(d.cellId).quality) {
            best.set(d.cellId, d);
        }
    }
    return [...best.values()];
}

function getCoords(id) {
    return { x: id % GRID_COLS, y: Math.floor(id / GRID_COLS) };
}

function cellDistance(a, b) {
    const c1 = getCoords(a);
    const c2 = getCoords(b);
    return Math.max(Math.abs(c1.x - c2.x), Math.abs(c1.y - c2.y));
}

function getDepositBonus(cellId, deposits) {
    if (!Array.isArray(deposits) || deposits.length === 0) return 0.1;
    const coords = getCoords(cellId);
    let minDist = Infinity;

    deposits.forEach((deposit) => {
        const depCoords = getCoords(deposit.cellId);
        const dist = Math.max(Math.abs(coords.x - depCoords.x), Math.abs(coords.y - depCoords.y));
        if (dist < minDist) minDist = dist;
    });

    if (minDist === 0) return 1.5;
    if (minDist === 1) return 1.25;
    if (minDist === 2) return 0.7;
    return 0.1;
}

function cellHasRoadNeighbor(cellId, terrain) {
    if (!Array.isArray(terrain)) return false;
    const { x, y } = getCoords(cellId);

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= GRID_COLS || ny < 0 || ny >= GRID_ROWS) continue;
            const tile = terrain[ny * GRID_COLS + nx];
            if (tile === 'road' || tile === 'road-h' || tile === 'road-x') return true;
        }
    }

    return false;
}

function isBuildingComplete(building, now = Date.now()) {
    if (!building?.construction_ends_at) return true;
    return new Date(building.construction_ends_at).getTime() <= now;
}

function getFalloutMultiplier(cellId, zones, now = Date.now()) {
    let multiplier = 1;
    (zones || []).forEach((zone) => {
        const expires = new Date(zone.expires_at).getTime();
        if (expires > now && cellDistance(cellId, zone.center_cell_id) <= Number(zone.radius || 0)) {
            multiplier *= Number(zone.multiplier ?? 0.5);
        }
    });
    return multiplier;
}

function getBuildingOutputMultiplier(building, zones, now = Date.now()) {
    let multiplier = getFalloutMultiplier(building.cell_id, zones, now);
    if (building?.disabled_until && new Date(building.disabled_until).getTime() > now) {
        multiplier *= 0.5;
    }
    return multiplier;
}

function calculatePlantPower(plant, playerBuildings, enemyBuildings, terrain, now = Date.now()) {
    const nearbyEnemies = (enemyBuildings || []).filter((enemy) => isBuildingComplete(enemy, now) && cellDistance(plant.cell_id, enemy.cell_id) <= PROXIMITY_RANGE).length;
    const samePlants = (playerBuildings || []).filter((other) => other.id !== plant.id && other.type === 'plant' && isBuildingComplete(other, now) && cellDistance(plant.cell_id, other.cell_id) <= PROXIMITY_RANGE).length;
    const base = PLANT_BASE_POWER - (nearbyEnemies * 20);
    const jitter = Math.sin((now / 1000) + Number(plant.cell_id || 0)) * 2;
    const roadMult = cellHasRoadNeighbor(plant.cell_id, terrain) ? 1.4 : 1;
    const plantProxMult = 1 + (Math.min(samePlants, PROXIMITY_BONUS_CAP) * PROXIMITY_BONUS_PER_BUILDING);
    return Math.max(0, base + jitter) * roadMult * plantProxMult;
}

async function ensureRunPlayerState(runId, playerId) {
    if (!runId || !playerId) return;
    await db.query(
        `INSERT INTO run_player_state (run_id, player_id)
         VALUES ($1, $2)
         ON CONFLICT (run_id, player_id) DO NOTHING`,
        [runId, playerId]
    );
}

async function ensureRunPlayerStates(runId) {
    if (!runId) return;
    const result = await db.query('SELECT player_id FROM run_players WHERE run_id = $1', [runId]);
    await Promise.all(result.rows.map((row) => ensureRunPlayerState(runId, row.player_id)));
}

async function calculateScores(runId, client) {
    const executor = client || db;
    const result = await executor.query(
        `SELECT
            rp.player_id,
            p.username,
            p.avatar,
            p.avatar_photo,
            p.token_balance,
            COUNT(CASE WHEN b.type = 'plant'     THEN 1 END)::int AS plant_count,
            COUNT(CASE WHEN b.type = 'mine'      THEN 1 END)::int AS mine_count,
            COUNT(CASE WHEN b.type = 'processor' THEN 1 END)::int AS processor_count,
            COUNT(b.id)::int AS total_buildings
        FROM run_players rp
        JOIN players p ON p.id = rp.player_id
        LEFT JOIN buildings b
            ON b.run_id = rp.run_id
            AND b.player_id = rp.player_id
            AND b.is_active = TRUE
            AND (b.construction_ends_at IS NULL OR b.construction_ends_at <= NOW())
        WHERE rp.run_id = $1
        GROUP BY rp.player_id, p.username, p.avatar, p.avatar_photo, p.token_balance
        ORDER BY (
            COUNT(CASE WHEN b.type = 'plant' THEN 1 END) * 100 +
            COUNT(CASE WHEN b.type = 'mine'  THEN 1 END) * 50  +
            FLOOR(p.token_balance / 1000.0)
        ) DESC,
        p.username ASC`,
        [runId]
    );

    return result.rows.map((r) => ({
        player_id: r.player_id,
        username: r.username,
        avatar: r.avatar || '☢️',
        avatar_photo: r.avatar_photo || null,
        token_balance: parseInt(r.token_balance, 10) || 0,
        plant_count: parseInt(r.plant_count, 10) || 0,
        mine_count: parseInt(r.mine_count, 10) || 0,
        processor_count: parseInt(r.processor_count, 10) || 0,
        total_buildings: parseInt(r.total_buildings, 10) || 0,
        score: ((parseInt(r.plant_count, 10) || 0) * 100) + ((parseInt(r.mine_count, 10) || 0) * 50) + Math.floor((parseInt(r.token_balance, 10) || 0) / 1000),
    }));
}

async function getRunSnapshot(runId) {
    if (!runId) return null;
    await ensureRunPlayerStates(runId);

    const [runResult, playersResult, buildingsResult, playerStatesResult, falloutResult, scores, surveyorsResult, nukeManufactureResult, nukeLaunchesResult] = await Promise.all([
        db.query('SELECT * FROM runs WHERE id = $1 LIMIT 1', [runId]),
        db.query(
            `SELECT
                p.id,
                p.username,
                p.avatar,
                p.avatar_photo,
                p.token_balance,
                rp.joined_at,
                COALESCE(rps.score, 0) AS score,
                COALESCE(rps.used_nuke, FALSE) AS used_nuke
             FROM run_players rp
             JOIN players p ON p.id = rp.player_id
             LEFT JOIN run_player_state rps ON rps.run_id = rp.run_id AND rps.player_id = rp.player_id
             WHERE rp.run_id = $1
             ORDER BY rp.joined_at ASC`,
            [runId]
        ),
        db.query(
            `SELECT b.*, p.username AS owner_name
             FROM buildings b
             JOIN players p ON p.id = b.player_id
             WHERE b.run_id = $1 AND b.is_active = TRUE
             ORDER BY b.placed_at ASC`,
            [runId]
        ),
        db.query('SELECT * FROM run_player_state WHERE run_id = $1 ORDER BY updated_at ASC', [runId]),
        db.query(
            `SELECT id, center_cell_id, radius, multiplier, expires_at, created_by
             FROM fallout_zones
             WHERE run_id = $1 AND expires_at > NOW()
             ORDER BY expires_at ASC`,
            [runId]
        ),
        calculateScores(runId),
        db.query('SELECT id, player_id, cell_id, expires_at FROM surveyors WHERE run_id = $1 AND expires_at > NOW()', [runId]),
        db.query('SELECT id, player_id, silo_id, completes_at FROM nuke_manufacture WHERE run_id = $1 AND completes_at > NOW()', [runId]),
        db.query('SELECT id, attacker_id, attacker_name, attacker_avatar, attacker_photo, target_cell_id, detonates_at FROM nuke_launches WHERE run_id = $1 AND status = $2', [runId, 'pending']),
    ]);

    const run = parseRunRow(runResult.rows[0]);
    if (!run) return null;

    const terrain = getOrGenerateTerrain(run.id);
    const deposits = getOrGenerateDeposits(run.id);

    const playerStates = playerStatesResult.rows.map((row) => ({
        ...row,
        uranium_raw: Number(row.uranium_raw || 0),
        uranium_refined: Number(row.uranium_refined || 0),
        max_storage: Number(row.max_storage || 5000),
        daily_produced: Number(row.daily_produced || 0),
        daily_income: parseInt(row.daily_income, 10) || 0,
        last_income: parseInt(row.last_income, 10) || 0,
        score: Number(row.score || 0),
        strikes_used_today: parseInt(row.strikes_used_today, 10) || 0,
        used_nuke: !!row.used_nuke,
        discovered_deposits: Array.isArray(row.discovered_deposits) ? row.discovered_deposits : [],
        nuke_inventory: parseInt(row.nuke_inventory, 10) || 0,
    }));

    const playerNameById = new Map(playersResult.rows.map((player) => [player.id, player.username]));
    const nuclearThreats = playerStates.filter((state) => state.used_nuke).map((state) => playerNameById.get(state.player_id)).filter(Boolean);

    // Merge authoritative counts from `scores` into the players array so
    // clients receive building counts and score for each player in the
    // `players` payload (reduces race conditions where clients see a
    // lightweight player object before the separate `scores` packet).
    const scoresById = new Map((scores || []).map(s => [String(s.player_id), s]));
    return {
        run,
        players: playersResult.rows.map((row) => {
            const scoreEntry = scoresById.get(String(row.id));
            return {
                ...row,
                token_balance: parseInt(row.token_balance, 10) || 0,
                score: Number(row.score || (scoreEntry && scoreEntry.score) || 0),
                used_nuke: !!row.used_nuke,
                total_buildings: scoreEntry ? (scoreEntry.total_buildings || 0) : 0,
                plant_count: scoreEntry ? (scoreEntry.plant_count || 0) : 0,
                mine_count: scoreEntry ? (scoreEntry.mine_count || 0) : 0,
                processor_count: scoreEntry ? (scoreEntry.processor_count || 0) : 0,
            };
        }),
        buildings: buildingsResult.rows,
        playerStates,
        falloutZones: falloutResult.rows,
        scores,
        nuclearThreats,
        terrain,
        deposits,
        surveyors: surveyorsResult.rows,
        nukeManufactures: nukeManufactureResult.rows,
        nukeLaunches: nukeLaunchesResult.rows,
    };
}

async function emitRunSnapshot(io, runId, eventName = 'run:tick', opts = {}) {
    const snapshot = await getRunSnapshot(runId);
    if (!snapshot?.run) return null;

    const sockets = await io.in(`run:${runId}`).fetchSockets();
    const stateByPlayer = new Map(snapshot.playerStates.map((state) => [state.player_id, state]));
    const playerById = new Map(snapshot.players.map((player) => [player.id, player]));

    const serverNow = Date.now();

    // Detect buildings that just completed construction.
    // Window = 2× ECONOMY_TICK_MS so we never miss a completion at the boundary.
    const completionWindow = ECONOMY_TICK_MS * 2;
    const justCompleted = (snapshot.buildings || []).filter(b => {
        if (!b.construction_ends_at) return false;
        const endsAt = new Date(b.construction_ends_at).getTime();
        return endsAt <= serverNow && endsAt > serverNow - completionWindow;
    });

    // Persist notifications for building completions for owners who are offline
    if (justCompleted.length > 0) {
        try {
            const connectedIds = new Set(sockets.map(s => s.playerId).filter(Boolean));
            for (const b of justCompleted) {
                const ownerId = b.player_id;
                if (!ownerId) continue;
                // Skip if owner is currently connected to the room
                if (connectedIds.has(ownerId)) continue;
                try {
                    const emailRes = await db.query('SELECT email FROM players WHERE id = $1', [ownerId]);
                    const email = (emailRes.rows[0]?.email || '').toLowerCase();
                    const notifMsg = `✅ Your ${b.type} finished construction at cell ${b.cell_id}.`;
                    const payload = JSON.stringify({ msg: notifMsg, cellId: b.cell_id, type: b.type, ts: Date.now() });
                    const res = await db.query(
                        `INSERT INTO notifications (run_id, player_id, email, type, payload)
                         VALUES ($1,$2,$3,$4,$5)`,
                        [runId, ownerId, email, 'info', payload]
                    );
                    console.log(`[build-complete notify] inserted=${res.rowCount || 0} run=${runId} owner=${ownerId} cell=${b.cell_id}`);
                } catch (e) {
                    console.warn('build completion notify failed for owner:', ownerId, e && e.message);
                }
            }
        } catch (e) {
            console.warn('build completion notify loop failed:', e && e.message);
        }
    }

    // ── Delta-compression helpers ─────────────────────────────────────────────
    // Build the current nuke-config string once (it never changes mid-run unless
    // an admin edits it, so the per-socket hash comparison catches that case).
    const nukeCfgPublic = {
        manufactureCost: NUKE_MANUFACTURE_COST,
        manufactureMs:   NUKE_MANUFACTURE_MS,
        falloutRadius:   SABOTAGE_NUKE_FALLOUT_RADIUS,
        maxInventory:    NUKE_MAX_INVENTORY,
        launchCooldownMs: NUKE_LAUNCH_COOLDOWN_MS,
        maxSilos:        NUKE_MAX_SILOS,
    };
    const nukeCfgStr = JSON.stringify(nukeCfgPublic);

    // Precompute the slim run object (only the fields that change every tick).
    // The full run object is sent on full-refresh ticks and includes static
    // metadata like run_length, total_token_supply, day_duration_ms, etc.
    const runLive = {
        market_price:      snapshot.run.market_price,
        market_prev_price: snapshot.run.market_prev_price,
        market_token_pool: snapshot.run.market_token_pool,
        tokens_issued:     snapshot.run.tokens_issued,
    };

    // When called from event handlers (building placed, nuke detonated, etc.)
    // always send the full payload so the client is immediately consistent.
    const forceFullPayload = opts.force === true || eventName !== 'run:tick';

    sockets.forEach((roomSocket) => {
        // ── Per-socket tick counter ───────────────────────────────────────────
        // Increment on every periodic run:tick. Event-driven calls (force=true)
        // don't count against the slow-refresh budget.
        if (!forceFullPayload) {
            roomSocket._snapCount = (roomSocket._snapCount || 0) + 1;
        }
        // Full refresh every 5 periodic ticks ≈ every 10 s at 2 s/tick.
        // Also forced on the very first tick for a new socket (_snapCount===1).
        const isFullTick = forceFullPayload || (roomSocket._snapCount || 0) <= 1 || (roomSocket._snapCount % 5) === 0;

        const pState = stateByPlayer.get(roomSocket.playerId) || null;
        const discoveredSet = new Set(pState?.discovered_deposits || []);
        const visibleDeposits = (snapshot.deposits || []).filter(d => discoveredSet.has(d.cellId));

        // ── Delta: deposits (only send when the player's visible set changed) ──
        const depositFp = visibleDeposits.map(d => d.cellId).join(',');
        let depositsPayload;
        if (isFullTick || roomSocket._depositFp !== depositFp) {
            depositsPayload = visibleDeposits;
            roomSocket._depositFp = depositFp;
        }
        // undefined means omit from payload — client keeps its last known value

        // ── Delta: nukeCfgPublic (only send when admin has changed it) ────────
        let nukeCfgPayload;
        if (isFullTick || roomSocket._nukeCfgStr !== nukeCfgStr) {
            nukeCfgPayload = nukeCfgPublic;
            roomSocket._nukeCfgStr = nukeCfgStr;
        }

        const surveyorList = (snapshot.surveyors || []).map(sv => ({
            id: sv.id,
            playerId: sv.player_id,
            cellId: sv.cell_id,
            expiresAt: sv.expires_at,
        }));

        // Nuke manufacture state for this player
        const myManufacture = (snapshot.nukeManufactures || []).find(m => m.player_id === roomSocket.playerId) || null;
        const nukeManufacture = myManufacture
            ? { id: myManufacture.id, completesAt: myManufacture.completes_at, manufactureMs: NUKE_MANUFACTURE_MS }
            : null;

        // ── Build payload: slim on periodic ticks, full on refresh/events ─────
        const payload = {
            // Fast-path fields — always present
            run:         isFullTick ? snapshot.run : runLive,
            playerState: pState,
            yourWallet:  parseInt(playerById.get(roomSocket.playerId)?.token_balance, 10) || 0,
            serverTime:  serverNow,
            // Fallout + threats are small and can change any tick (nuke detonation)
            falloutZones:   snapshot.falloutZones,
            nuclearThreats: snapshot.nuclearThreats,
            // Surveyor positions update every SURVEYOR_MOVE_EVERY_N_TICKS seconds
            surveyors: surveyorList,
            // Active nuke launches are always small (empty most of the time)
            nukeLaunches: (snapshot.nukeLaunches || []).map(l => ({
                id:           l.id,
                attackerName: l.attacker_name,
                attackerAvatar: l.attacker_avatar,
                attackerPhoto:  l.attacker_photo,
                targetCellId: l.target_cell_id,
                detonatesAt:  l.detonates_at,
            })),
        };

        // Slow-path fields — only on full ticks (saves ~40% per periodic tick)
        if (isFullTick) {
            payload.scores         = snapshot.scores;
            payload.nukeManufacture = nukeManufacture;
        }

        // Delta fields — only when changed
        if (depositsPayload !== undefined) payload.deposits = depositsPayload;
        if (nukeCfgPayload  !== undefined) payload.nukeCfgPublic = nukeCfgPayload;

        roomSocket.emit(eventName, payload);

        // Notify about just-completed buildings
        if (justCompleted.length > 0) {
            roomSocket.emit('building:construction_complete', {
                buildings: justCompleted.map(b => ({ cellId: b.cell_id, type: b.type, playerId: b.player_id })),
                serverTime: serverNow,
            });
        }
    });

    return snapshot;
}

async function processRunEconomy(io, run) {
    if (!run?.id || run.status !== 'active') return;
    await ensureRunPlayerStates(run.id);

    const [runResult, playersResult, statesResult, buildingsResult, falloutResult, surveyorsResult] = await Promise.all([
        db.query('SELECT * FROM runs WHERE id = $1 LIMIT 1', [run.id]),
        db.query(
            `SELECT p.id, p.username, p.token_balance
             FROM run_players rp
             JOIN players p ON p.id = rp.player_id
             WHERE rp.run_id = $1`,
            [run.id]
        ),
        db.query('SELECT * FROM run_player_state WHERE run_id = $1', [run.id]),
        db.query('SELECT * FROM buildings WHERE run_id = $1 AND is_active = TRUE', [run.id]),
        db.query('SELECT * FROM fallout_zones WHERE run_id = $1 AND expires_at > NOW()', [run.id]),
        db.query('SELECT id, player_id, cell_id, expires_at FROM surveyors WHERE run_id = $1 AND expires_at > NOW()', [run.id]),
    ]);

    const liveRun = parseRunRow(runResult.rows[0]);
    if (!liveRun) return;

    const now = Date.now();
    const terrain = generateTerrainForRun(run.id);
    const deposits = generateDepositsForRun(run.id, terrain);
    const playersById = new Map(playersResult.rows.map((player) => [player.id, player]));
    const buildings = buildingsResult.rows;
    const activeFallout = falloutResult.rows;

    let totalIncome = 0;
    let aggregatePower = 0;

    const client = await db.connect();
    let newlyPlaced = [];
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM fallout_zones WHERE run_id = $1 AND expires_at <= NOW()', [run.id]);

        for (const state of statesResult.rows) {
            const player = playersById.get(state.player_id);
            if (!player) continue;

            const allPlayerBuildings = buildings.filter((building) => building.player_id === state.player_id && building.is_active);
            const completedBuildings = allPlayerBuildings.filter((building) => isBuildingComplete(building, now));
            const enemyBuildings = buildings.filter((building) => building.player_id !== state.player_id && building.is_active && isBuildingComplete(building, now));

            const storageCount = completedBuildings.filter((building) => building.type === 'storage').length;
            const maxStorage = 5000 + (storageCount * (BUILDING_RULES.storage.storageBonus || 1000));

            let uraniumRaw = Number(state.uranium_raw || 0);
            let uraniumRefined = Number(state.uranium_refined || 0);
            let dailyProduced = Number(state.daily_produced || 0);
            let dailyIncome = parseInt(state.daily_income, 10) || 0;

            const activeMines = completedBuildings.filter((building) => building.type === 'mine');
            let produced = 0;
            activeMines.forEach((mine) => {
                let amount = MINE_BASE_PRODUCTION;
                amount *= getDepositBonus(mine.cell_id, deposits);
                const sameMines = activeMines.filter((other) => other.id !== mine.id && cellDistance(mine.cell_id, other.cell_id) <= PROXIMITY_RANGE).length;
                amount *= 1 + (Math.min(sameMines, PROXIMITY_BONUS_CAP) * PROXIMITY_BONUS_PER_BUILDING);
                amount *= getBuildingOutputMultiplier(mine, activeFallout, now);
                produced += amount;
            });

            const totalStored = uraniumRaw + uraniumRefined;
            const rawHeadroom = Math.max(0, maxStorage - totalStored);
            const actualProduced = Math.min(rawHeadroom, produced);
            uraniumRaw += actualProduced;
            dailyProduced += actualProduced;

            const processors = completedBuildings.filter((building) => building.type === 'processor');
            let converted = 0;
            processors.forEach((processor) => {
                converted += PROCESSOR_CONVERT_RATE * getBuildingOutputMultiplier(processor, activeFallout, now);
            });
            const actualConverted = Math.min(uraniumRaw, converted);
            uraniumRaw -= actualConverted;
            uraniumRefined += actualConverted;

            const plants = completedBuildings.filter((building) => building.type === 'plant');
            let totalPower = 0;
            plants.forEach((plant) => {
                totalPower += calculatePlantPower(plant, completedBuildings, enemyBuildings, terrain, now) * getBuildingOutputMultiplier(plant, activeFallout, now);
            });
            aggregatePower += totalPower;

            const requiredFuel = plants.length * 0.06;
            let fuelConsumed = 0;
            let income = 0;
            if (requiredFuel > 0 && uraniumRefined > 0) {
                fuelConsumed = Math.min(requiredFuel, uraniumRefined);
                uraniumRefined -= fuelConsumed;
                const powerFraction = requiredFuel > 0 ? (fuelConsumed / requiredFuel) : 0;
                income = Math.floor(totalPower * powerFraction * INCOME_POWER_MULT);
            }

            // Deduct maintenance cost for every completed building and active surveyor
            const surveyorMaint = surveyorsResult.rows.filter(sv => sv.player_id === state.player_id).length * SURVEYOR_MAINT_PER_TICK;
            const totalMaintenance = completedBuildings.reduce((sum, b) => sum + (BUILDING_RULES[b.type]?.maintenanceCost || 0), 0) + surveyorMaint;
            const netIncome = income - totalMaintenance;
            const nextBalance = Math.max(0, (parseInt(player.token_balance, 10) || 0) + netIncome);
            dailyIncome += income;
            totalIncome += netIncome;
            const score = (plants.length * 100) + (activeMines.length * 50) + Math.floor(nextBalance / 1000);
            // Economy diagnostic (logs every 30 ticks to avoid spam)
            if (!processRunEconomy._logTick) processRunEconomy._logTick = 0;
            if (++processRunEconomy._logTick % 30 === 0) {
                console.log(`[economy] ${player.username} | buildings:${completedBuildings.length} income:${income} maintenance:${totalMaintenance} net:${netIncome} balance:${nextBalance}`);
            }

            await client.query(
                'UPDATE players SET token_balance = $1 WHERE id = $2',
                [nextBalance, state.player_id]
            );

            await client.query(
                `UPDATE run_player_state
                 SET uranium_raw = $1,
                     uranium_refined = $2,
                     max_storage = $3,
                     daily_produced = $4,
                     daily_income = $5,
                     last_income = $6,
                     score = $7,
                     updated_at = NOW()
                 WHERE run_id = $8 AND player_id = $9`,
                [uraniumRaw, uraniumRefined, maxStorage, dailyProduced, dailyIncome, income, score, run.id, state.player_id]
            );
        }

        const previousPrice = Number(liveRun.market_price || MARKET_BASE_PRICE);
        const nextTokenPool = Math.max(1, Number(liveRun.market_token_pool || MARKET_TOKEN_POOL_INITIAL) - (totalIncome / MARKET_POOL_BURN_RATE));
        const nextTokensIssued = (parseInt(liveRun.tokens_issued, 10) || 0) + totalIncome;
        const poolFactor = Number(liveRun.market_token_pool_initial || MARKET_TOKEN_POOL_INITIAL) / nextTokenPool;
        const issueFactor = 1 + (nextTokensIssued / Number(liveRun.total_token_supply || TOTAL_TOKEN_SUPPLY)) * 1000;
        const bondingPrice = MARKET_BASE_PRICE * poolFactor * issueFactor;
        const diurnal = Math.sin(((Date.now() % DAY_DURATION_MS) / DAY_DURATION_MS) * Math.PI * 2) * 0.2;
        const demand = Math.max(10, MARKET_BASE_DEMAND * (1 + diurnal));
        const supplyDemandDelta = (demand - aggregatePower) / demand;
        const drift = supplyDemandDelta * MARKET_DRIFT_FACTOR * previousPrice;
        const u = Math.random() || 0.5;
        const v = Math.random() || 0.5;
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        const noise = z * MARKET_PER_SECOND_VOL * previousPrice;
        const reversion = (bondingPrice - previousPrice) * 0.04;
        const nextPrice = Math.max(0.01, +(previousPrice + reversion + noise + drift).toFixed(6));

        await client.query(
            `UPDATE runs
             SET market_prev_price = $1,
                 market_price = $2,
                 market_token_pool = $3,
                 tokens_issued = $4
             WHERE id = $5`,
            [previousPrice, nextPrice, nextTokenPool, nextTokensIssued, run.id]
        );

        // Process server-side build queue: promote queued entries into real
        // building rows when players have free construction slots. This makes
        // queue progression authoritative and resilient across reconnects.
        try {
            for (const pRow of playersResult.rows) {
                const playerId = pRow.id;
                // Count active constructions for this player inside the TX
                const activeRes = await client.query(
                    `SELECT COUNT(*)::int AS cnt
                     FROM buildings
                     WHERE run_id = $1
                       AND player_id = $2
                       AND is_active = TRUE
                       AND construction_ends_at > NOW()`,
                    [run.id, playerId]
                );
                const activeCount = parseInt(activeRes.rows[0]?.cnt || 0, 10) || 0;
                const freeSlots = Math.max(0, BUILD_SLOTS - activeCount);
                if (freeSlots <= 0) continue;

                // Lock and fetch queued entries for this player (oldest first)
                const qRes = await client.query(
                    `SELECT id, cell_id, type
                     FROM build_queue
                     WHERE run_id = $1 AND player_id = $2
                     ORDER BY queued_at ASC
                     LIMIT $3
                     FOR UPDATE SKIP LOCKED`,
                    [run.id, playerId, freeSlots]
                );
                for (const q of qRes.rows) {
                    try {
                        // Skip if cell already occupied
                        const occ = await client.query(
                            `SELECT id FROM buildings WHERE run_id = $1 AND cell_id = $2 AND is_active = TRUE`,
                            [run.id, q.cell_id]
                        );
                        if (occ.rows.length > 0) {
                            await client.query('DELETE FROM build_queue WHERE id = $1', [q.id]);
                            continue;
                        }

                        const constructionMs = Number(BUILDING_RULES[q.type]?.constructionMs || 0);
                        const endsAt = new Date(Date.now() + constructionMs);

                        const ins = await client.query(
                            `INSERT INTO buildings (run_id, player_id, type, cell_id, construction_ends_at, placed_at, is_active, destroyed_at)
                             VALUES ($1,$2,$3,$4,$5,NOW(),TRUE,NULL)
                             ON CONFLICT (run_id, cell_id) DO UPDATE SET
                                 player_id = EXCLUDED.player_id,
                                 type = EXCLUDED.type,
                                 construction_ends_at = EXCLUDED.construction_ends_at,
                                 is_active = TRUE,
                                 destroyed_at = NULL,
                                 placed_at = NOW()
                             RETURNING *`,
                            [run.id, playerId, q.type, q.cell_id, endsAt]
                        );

                        // Remove queue entry now that we've promoted it
                        await client.query('DELETE FROM build_queue WHERE id = $1', [q.id]);

                        newlyPlaced.push({ building: ins.rows[0], ownerId: playerId });
                    } catch (err) {
                        console.warn('queued-promotion failed for queue id=', q.id, err && err.message);
                    }
                }
            }
        } catch (err) {
            console.warn('build-queue processing failed:', err && err.message);
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    // ── Surveyor movement + deposit discovery ────────────────────────────────
    // Rate-limit movement: only move on ticks that are a multiple of SURVEYOR_MOVE_EVERY_N_TICKS.
    // Tick counter is tracked per run so restarts don't desync.
    if (!processRunEconomy._surveyorTick) processRunEconomy._surveyorTick = {};
    processRunEconomy._surveyorTick[run.id] = (processRunEconomy._surveyorTick[run.id] || 0) + 1;
    const shouldMoveSurveyors = processRunEconomy._surveyorTick[run.id] >= SURVEYOR_MOVE_EVERY_N_TICKS;
    if (shouldMoveSurveyors) processRunEconomy._surveyorTick[run.id] = 0;

    const surveyorDiscoveries = []; // { playerId, newCellIds[] } for post-tick notifications
    const expiredSurveyorOwners = []; // player_ids whose surveyor just expired
    try {
        // Capture expiring surveyors BEFORE deleting so we can notify their owners
        const expiredRes = await db.query(
            'SELECT player_id FROM surveyors WHERE run_id = $1 AND expires_at <= NOW()',
            [run.id]
        );
        expiredSurveyorOwners.push(...expiredRes.rows.map(r => r.player_id));
        await db.query('DELETE FROM surveyors WHERE run_id = $1 AND expires_at <= NOW()', [run.id]);
        if (shouldMoveSurveyors) {
        console.log(`[surveyor] tick run=${run.id} surveyors=${surveyorsResult.rows.length} totalDeposits=${deposits.length} radius=${SURVEYOR_DISCOVER_RADIUS}`);
        for (const sv of surveyorsResult.rows) {
            // Load this player's discovered deposits for biased walk
            const discRes = await db.query(
                'SELECT discovered_deposits FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                [run.id, sv.player_id]
            );
            const discoveredSet = new Set(Array.isArray(discRes.rows[0]?.discovered_deposits) ? discRes.rows[0].discovered_deposits : []);
            const newCell = surveyorRandomWalk(sv.cell_id, terrain, deposits, discoveredSet);
            const seedIds = (deposits || [])
                .filter(d => chebyshevDist(d.cellId, newCell) <= SURVEYOR_DISCOVER_RADIUS)
                .map(d => d.cellId);
            // Cluster expand: also reveal any deposits clumped adjacent to the seed finds
            const nearbyIds = seedIds.length > 0 ? expandDepositCluster(seedIds, deposits || []) : [];
            console.log(`[surveyor] sv=${sv.id} player=${sv.player_id} ${sv.cell_id}->${newCell} seedDeposits=${seedIds.length} clusterTotal=${nearbyIds.length}`);
            await db.query('UPDATE surveyors SET cell_id = $1 WHERE id = $2', [newCell, sv.id]);
            if (nearbyIds.length > 0) {
                const before = discoveredSet;
                const newlyFound = nearbyIds.filter(id => !before.has(id));

                await db.query(
                    `UPDATE run_player_state
                     SET discovered_deposits = (
                         SELECT jsonb_agg(DISTINCT elem::int)
                         FROM jsonb_array_elements(
                             COALESCE(discovered_deposits, '[]'::jsonb) || $1::jsonb
                         ) AS elem
                     )
                     WHERE run_id = $2 AND player_id = $3`,
                    [JSON.stringify(nearbyIds), run.id, sv.player_id]
                );

                if (newlyFound.length > 0) {
                    surveyorDiscoveries.push({ playerId: sv.player_id, cellIds: newlyFound });
                }
            }
        }
        } // end shouldMoveSurveyors
    } catch (e) {
        console.warn('[surveyor] tick failed:', e && e.message);
    }

    await emitRunSnapshot(io, run.id, 'run:tick');

    // Notify players about newly discovered deposits (live + persisted)
    if (surveyorDiscoveries.length > 0) {
        try {
            const sockets = await io.in(`run:${run.id}`).fetchSockets();
            for (const { playerId, cellIds } of surveyorDiscoveries) {
                const count = cellIds.length;
                const msg = `🚶 Your surveyor discovered ${count} uranium deposit${count === 1 ? '' : 's'}! 🚩 Flagged on your map.`;
                const payload = JSON.stringify({ msg, cellIds, ts: Date.now() });
                // Persist to notifications table so it appears on relog
                try {
                    const emailRes = await db.query('SELECT email FROM players WHERE id = $1', [playerId]);
                    const email = (emailRes.rows[0]?.email || '').toLowerCase();
                    await db.query(
                        `INSERT INTO notifications (run_id, player_id, email, type, payload)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [run.id, playerId, email, 'info', payload]
                    );
                } catch (e) {
                    console.warn('[surveyor] notification persist failed:', e && e.message);
                }
                // Also push live to connected socket
                const playerSocket = sockets.find(s => s.playerId === playerId);
                if (playerSocket) {
                    playerSocket.emit('surveyor:discovery', { cellIds, count });
                }
            }
        } catch (e) {
            console.warn('[surveyor] discovery notify failed:', e && e.message);
        }
    }

    // Notify players whose surveyor contract just expired
    if (expiredSurveyorOwners.length > 0) {
        try {
            const sockets = await io.in(`run:${run.id}`).fetchSockets();
            // Count per player in case they had multiple surveyors expire simultaneously
            const byPlayer = {};
            for (const pid of expiredSurveyorOwners) byPlayer[pid] = (byPlayer[pid] || 0) + 1;
            for (const [pid, count] of Object.entries(byPlayer)) {
                const playerId = parseInt(pid, 10);
                const msg = `\u23f0 Your surveyor${count > 1 ? `s (${count})` : ''} finished their contract. Hire another to keep exploring for uranium!`;
                const payload = JSON.stringify({ msg, ts: Date.now() });
                try {
                    const emailRes = await db.query('SELECT email FROM players WHERE id = $1', [playerId]);
                    const email = (emailRes.rows[0]?.email || '').toLowerCase();
                    await db.query(
                        `INSERT INTO notifications (run_id, player_id, email, type, payload) VALUES ($1, $2, $3, $4, $5)`,
                        [run.id, playerId, email, 'warning', payload]
                    );
                } catch (e) {
                    console.warn('[surveyor] expiry notification persist failed:', e && e.message);
                }
                const playerSocket = sockets.find(s => s.playerId === playerId);
                if (playerSocket) playerSocket.emit('surveyor:expired', { count });
            }
        } catch (e) {
            console.warn('[surveyor] expiry notify failed:', e && e.message);
        }
    }

    // Emit any newly-placed buildings so clients receive placement events.
    if (newlyPlaced && Array.isArray(newlyPlaced) && newlyPlaced.length > 0) {
        try {
            for (const p of newlyPlaced) {
                try {
                    const ownerRes = await db.query('SELECT username FROM players WHERE id = $1', [p.ownerId]);
                    const ownerName = ownerRes.rows[0]?.username || null;
                    io.to(`run:${run.id}`).emit('building:placed', {
                        building: p.building,
                        ownerName,
                        placedBy: p.ownerId,
                    });
                } catch (e) {
                    console.warn('emit placed failed for owner=', p.ownerId, e && e.message);
                }
            }
        } catch (e) {
            console.warn('emitting newlyPlaced buildings failed:', e && e.message);
        }
    }
}

// ── All-time record helpers ───────────────────────────────────────────────────
async function _upsertAlltimeRecord(key, value, runNumber, higher = true) {
    const cmp  = higher ? 'GREATEST' : 'LEAST';
    const cond = higher ? '>' : '<';
    await db.query(
        `INSERT INTO alltime_market_records (stat_key, value, run_number, recorded_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (stat_key) DO UPDATE
         SET value      = ${cmp}(alltime_market_records.value, EXCLUDED.value),
             run_number = CASE WHEN EXCLUDED.value ${cond} alltime_market_records.value
                               THEN EXCLUDED.run_number ELSE alltime_market_records.run_number END,
             recorded_at = CASE WHEN EXCLUDED.value ${cond} alltime_market_records.value
                                THEN NOW() ELSE alltime_market_records.recorded_at END`,
        [key, value, runNumber]
    );
}

async function updateAlltimeMarketRecords(run, totalBuildings) {
    try {
        await Promise.all([
            _upsertAlltimeRecord('price_high',        Number(run.market_price),           run.run_number, true),
            _upsertAlltimeRecord('price_low',         Number(run.market_price),           run.run_number, false),
            _upsertAlltimeRecord('prize_pool_high',   parseInt(run.prize_pool, 10) || 0,  run.run_number, true),
            _upsertAlltimeRecord('tokens_issued_max', parseInt(run.tokens_issued, 10) || 0, run.run_number, true),
            _upsertAlltimeRecord('peak_buildings',    totalBuildings || 0,                run.run_number, true),
        ]);
    } catch (err) {
        console.warn('[alltime] market record update failed:', err.message);
    }
}

async function updateAlltimePlayerBests(run, scores) {
    try {
        // Grab post-payout balances
        const balResult = await db.query(
            'SELECT id, token_balance FROM players WHERE id = ANY($1)',
            [scores.map((s) => s.player_id)]
        );
        const balances = {};
        balResult.rows.forEach((r) => { balances[r.id] = parseInt(r.token_balance, 10) || 0; });

        await _upsertAlltimeRecord('peak_players', scores.length, run.run_number, true);

        for (let i = 0; i < scores.length; i++) {
            const s = scores[i];
            const balance = balances[s.player_id] || 0;
            const income  = parseInt(s.daily_income, 10) || 0;
            const rank    = i + 1;
            await db.query(
                `INSERT INTO alltime_player_bests
                    (player_id, best_balance, best_daily_income, best_rank, total_runs, updated_at)
                 VALUES ($1, $2, $3, $4, 1, NOW())
                 ON CONFLICT (player_id) DO UPDATE
                 SET best_balance      = GREATEST(alltime_player_bests.best_balance, EXCLUDED.best_balance),
                     best_daily_income = GREATEST(alltime_player_bests.best_daily_income, EXCLUDED.best_daily_income),
                     best_rank         = LEAST(alltime_player_bests.best_rank, EXCLUDED.best_rank),
                     total_runs        = alltime_player_bests.total_runs + 1,
                     updated_at        = NOW()`,
                [s.player_id, balance, income, rank]
            );
        }
        console.log(`[alltime] Player bests updated for run #${run.run_number}`);
    } catch (err) {
        console.warn('[alltime] player bests update failed:', err.message);
    }
}

async function endRun(io, run) {
    // Perform payout atomically using a DB transaction and a FOR UPDATE lock
    const client = await db.connect();
    let scores = [];
    const payouts = [];
    try {
        await client.query('BEGIN');

        // Lock the run row and read the authoritative prize_pool
        const rres = await client.query('SELECT prize_pool FROM runs WHERE id = $1 FOR UPDATE', [run.id]);
        const prizePool = parseInt(rres.rows[0]?.prize_pool, 10) || 0;

        // Calculate scores using the same client for a consistent snapshot
        scores = await calculateScores(run.id, client);

        const shares = [0.50, 0.30, 0.20];
        for (let i = 0; i < Math.min(3, scores.length); i++) {
            const p = scores[i];
            const award = Math.floor(prizePool * shares[i]);
            if (award > 0) {
                await client.query('UPDATE players SET token_balance = token_balance + $1 WHERE id = $2', [award, p.player_id]);
            }
            await client.query(
                `UPDATE run_players SET final_rank = $1, payout = $2
                 WHERE run_id = $3 AND player_id = $4`,
                [i + 1, award, run.id, p.player_id]
            );
            payouts.push({ ...p, rank: i + 1, award, token_balance: (parseInt(p.token_balance, 10) || 0) + award });
        }

        await client.query("UPDATE runs SET status = 'ended', ended_at = NOW() WHERE id = $1", [run.id]);

        await client.query('COMMIT');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
        client.release();
        throw err;
    } finally {
        try { client.release(); } catch (e) { /* ignore */ }
    }

    console.log(`🏁 Run #${run.run_number} ended. Awarded ${payouts.length} players.`);
    // Clear per-run caches so memory doesn't grow across many runs
    _terrainCache.delete(run.id);
    _depositsCache.delete(run.id);

    // Update all-time player records (uses post-payout balances)
    try {
        await updateAlltimePlayerBests(run, scores);
    } catch (e) {
        console.warn('[endRun] updateAlltimePlayerBests failed:', e && e.message);
    }

    io.to(`run:${run.id}`).emit('run:ended', {
        runNumber: run.run_number,
        scores,
        payouts,
    });

    setTimeout(async () => {
        try {
            const newRun = await createNewRun();
            io.emit('run:new', {
                runId: newRun.id,
                runNumber: newRun.run_number,
            });
        } catch (err) {
            console.error('Failed to start new run:', err);
        }
    }, 8000);
}

async function saveEconomySnapshot(runId, runDay) {
    try {
        const [runResult, playersResult, buildingsResult] = await Promise.all([
            db.query('SELECT * FROM runs WHERE id = $1 LIMIT 1', [runId]),
            db.query(
                `SELECT p.id, p.username, p.token_balance,
                        COALESCE(rps.score, 0) AS score,
                        COALESCE(rps.daily_income, 0) AS daily_income,
                        COALESCE(rps.daily_produced, 0) AS daily_produced
                 FROM run_players rp
                 JOIN players p ON p.id = rp.player_id
                 LEFT JOIN run_player_state rps
                        ON rps.run_id = rp.run_id AND rps.player_id = rp.player_id
                 WHERE rp.run_id = $1`,
                [runId]
            ),
            db.query(
                `SELECT type, COUNT(*) AS count
                 FROM buildings WHERE run_id = $1 AND is_active = TRUE
                 GROUP BY type`,
                [runId]
            ),
        ]);

        const run = parseRunRow(runResult.rows[0]);
        if (!run) return;

        const playerSnapshots = playersResult.rows.map((p) => ({
            player_id: p.id,
            username: p.username,
            token_balance: parseInt(p.token_balance, 10) || 0,
            score: Number(p.score || 0),
            daily_income: parseInt(p.daily_income, 10) || 0,
            daily_produced: Number(p.daily_produced || 0),
        }));

        const buildingCounts = {};
        let totalBuildings = 0;
        buildingsResult.rows.forEach((row) => {
            buildingCounts[row.type] = parseInt(row.count, 10);
            totalBuildings += parseInt(row.count, 10);
        });

        await db.query(
            `INSERT INTO economy_snapshots
                (run_id, run_day, market_price, market_prev_price, prize_pool,
                 total_players, total_buildings, tokens_issued, market_token_pool,
                 building_counts, player_snapshots)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (run_id, run_day) DO UPDATE
             SET market_price      = EXCLUDED.market_price,
                 market_prev_price = EXCLUDED.market_prev_price,
                 prize_pool        = EXCLUDED.prize_pool,
                 total_players     = EXCLUDED.total_players,
                 total_buildings   = EXCLUDED.total_buildings,
                 tokens_issued     = EXCLUDED.tokens_issued,
                 market_token_pool = EXCLUDED.market_token_pool,
                 building_counts   = EXCLUDED.building_counts,
                 player_snapshots  = EXCLUDED.player_snapshots,
                 snapshot_at       = NOW()`,
            [
                runId, runDay,
                run.market_price, run.market_prev_price,
                run.prize_pool,
                playersResult.rows.length,
                totalBuildings,
                run.tokens_issued,
                run.market_token_pool,
                JSON.stringify(buildingCounts),
                JSON.stringify(playerSnapshots),
            ]
        );
        console.log(`[economy] Snapshot saved for run day ${runDay}`);
        // Keep all-time market records up to date on every snapshot
        await updateAlltimeMarketRecords(run, totalBuildings);
    } catch (err) {
        console.warn('[economy] Failed to save snapshot:', err.message);
    }
}

async function advanceDay(io, run) {
    const newDay = run.current_day + 1;

    // Save snapshot before daily stats reset
    await saveEconomySnapshot(run.id, run.current_day);

    if (newDay > run.run_length) {
        await endRun(io, run);
        return;
    }

    // Prefer per-run configured day duration when available, fall back to global DAY_DURATION_MS
    const durationMs = Number(run.day_duration_ms) || DAY_DURATION_MS;
    const nextDayAt = new Date(Date.now() + durationMs);
    await db.query(
        `UPDATE runs
         SET current_day = $1,
             next_day_at = $2
         WHERE id = $3`,
        [newDay, nextDayAt, run.id]
    );

    await db.query(
        `UPDATE run_player_state
         SET daily_produced = 0,
             daily_income = 0,
             last_income = 0,
             strikes_used_today = 0,
             updated_at = NOW()
         WHERE run_id = $1`,
        [run.id]
    );

    const scores = await calculateScores(run.id);
    io.to(`run:${run.id}`).emit('run:day_advanced', {
        day: newDay,
        runLength: run.run_length,
        nextDayAt: nextDayAt.toISOString(),
        prizePool: parseInt(run.prize_pool, 10) || 0,
        scores,
    });

    await emitRunSnapshot(io, run.id, 'run:tick', { force: true });
    console.log(`📅 Run #${run.run_number} → day ${newDay} (next: ${nextDayAt.toISOString()})`);
}

// Process pending nuke launches — called from economy tick.
// Handles both normal detonation (after setTimeout) AND server-restart recovery
// where the setTimeout never fired.
async function processNukeLaunches(io, run) {
    if (!run?.id) return;
    try {
        const overdueRes = await db.query(
            `SELECT * FROM nuke_launches WHERE run_id = $1 AND status = 'pending' AND detonates_at <= NOW()`,
            [run.id]
        );
        for (const launch of overdueRes.rows) {
            await detonateNukeLaunch(io, run, launch);
        }
    } catch (err) {
        console.warn('[nuke] processNukeLaunches error:', err.message);
    }
}

// Check for completed nuke manufactures and credit the player's inventory.
async function processNukeManufactures(io, run) {
    if (!run?.id) return;
    try {
        const doneRes = await db.query(
            `SELECT nm.*, p.username, p.avatar, p.avatar_photo
             FROM nuke_manufacture nm
             JOIN players p ON p.id = nm.player_id
             WHERE nm.run_id = $1 AND nm.completes_at <= NOW()`,
            [run.id]
        );
        for (const mfg of doneRes.rows) {
            // Credit inventory
            await db.query(
                `UPDATE run_player_state SET nuke_inventory = nuke_inventory + 1, updated_at = NOW()
                 WHERE run_id = $1 AND player_id = $2`,
                [run.id, mfg.player_id]
            );
            // Remove the manufacture entry
            await db.query('DELETE FROM nuke_manufacture WHERE id = $1', [mfg.id]);

            // Notify the player
            const stateRes = await db.query(
                'SELECT nuke_inventory FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                [run.id, mfg.player_id]
            );
            const inv = parseInt(stateRes.rows[0]?.nuke_inventory, 10) || 1;

            const sockets = await io.in(`run:${run.id}`).fetchSockets();
            const playerSocket = sockets.find(s => s.playerId === mfg.player_id);
            if (playerSocket) {
                playerSocket.emit('nuke:manufacture_complete', { inventory: inv });
            }

            // Persist notification for offline player
            try {
                const emailRes = await db.query('SELECT email FROM players WHERE id = $1', [mfg.player_id]);
                const email = (emailRes.rows[0]?.email || '').toLowerCase();
                await db.query(
                    `INSERT INTO notifications (run_id, player_id, email, type, payload) VALUES ($1,$2,$3,$4,$5)`,
                    [run.id, mfg.player_id, email, 'success', JSON.stringify({ msg: '☢️ Nuke manufactured and ready for launch!', ts: Date.now() })]
                );
            } catch (e) { /* non-critical */ }

            console.log(`[nuke] manufacture complete for player ${mfg.username}, inventory=${inv}`);
        }
    } catch (err) {
        console.warn('[nuke] processNukeManufactures error:', err.message);
    }
}

// Internal: execute the blast for a nuke launch
async function detonateNukeLaunch(io, run, launch) {
    // Idempotency guard — mark detonated first to prevent double-fire
    const claimRes = await db.query(
        `UPDATE nuke_launches SET status = 'detonated' WHERE id = $1 AND status = 'pending' RETURNING id`,
        [launch.id]
    );
    if (claimRes.rowCount === 0) return; // already detonated by another process

    const sabotageCfg = getSabotageConfig();
    const falloutRadius = sabotageCfg.nukeFalloutRadius || 4;
    const falloutDurationMs = sabotageCfg.nukeFalloutDurationMs || 120000;
    const cellId = launch.target_cell_id;

    // Destroy all buildings within fallout radius
    const allBuildings = await db.query(
        'SELECT * FROM buildings WHERE run_id = $1 AND is_active = TRUE AND player_id != $2',
        [run.id, launch.attacker_id]
    );
    const destroyed = [];
    const cols = typeof getGridSize === 'function' ? (getGridSize().cols || 20) : 20;
    function manhattanDist(a, b) {
        return Math.abs((a % cols) - (b % cols)) + Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
    }
    for (const b of allBuildings.rows) {
        if (manhattanDist(b.cell_id, cellId) <= falloutRadius) {
            await db.query(
                'UPDATE buildings SET is_active = FALSE, destroyed_at = NOW() WHERE id = $1',
                [b.id]
            );
            destroyed.push(b.cell_id);
        }
    }

    // Create fallout zone
    await db.query(
        `INSERT INTO fallout_zones (run_id, created_by, center_cell_id, radius, multiplier, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [run.id, launch.attacker_id, cellId, falloutRadius, 0.5, new Date(Date.now() + falloutDurationMs)]
    );

    // Record strike in player state
    await db.query(
        `UPDATE run_player_state
         SET strikes_used_today = strikes_used_today + 1, used_nuke = TRUE, updated_at = NOW()
         WHERE run_id = $1 AND player_id = $2`,
        [run.id, launch.attacker_id]
    );

    // Log in sabotage_events
    await db.query(
        'INSERT INTO sabotage_events (run_id, attacker_id, target_cell_id, attack_type, cost) VALUES ($1,$2,$3,$4,$5)',
        [run.id, launch.attacker_id, cellId, 'nuke', 0]
    );

    // Broadcast detonation to all players
    const payload = {
        launchId:       launch.id,
        attackType:     'nuke',
        cellId,
        attackerId:     launch.attacker_id,
        attackerName:   launch.attacker_name,
        destroyedCells: destroyed,
        falloutRadius,
        falloutDuration: falloutDurationMs,
        failed:         false,
    };
    io.to(`run:${run.id}`).emit('nuke:detonated', payload);

    // Persist notification for each destroyed building's owner
    const ownersSeen = new Set();
    for (const b of allBuildings.rows) {
        if (!destroyed.includes(b.cell_id)) continue;
        if (ownersSeen.has(b.player_id)) continue;
        ownersSeen.add(b.player_id);
        try {
            const emailRes = await db.query('SELECT email FROM players WHERE id = $1', [b.player_id]);
            const email = (emailRes.rows[0]?.email || '').toLowerCase();
            await db.query(
                `INSERT INTO notifications (run_id, player_id, email, type, payload) VALUES ($1,$2,$3,$4,$5)`,
                [run.id, b.player_id, email, 'danger',
                 JSON.stringify({ msg: `☢️ You were NUKED by ${launch.attacker_name}! Buildings near cell ${cellId} destroyed.`, ts: Date.now() })]
            );
        } catch (e) { /* non-critical */ }
    }

    console.log(`[nuke] DETONATED launch=${launch.id} attacker=${launch.attacker_name} cell=${cellId} destroyed=${destroyed.length}`);
}

// Export for use in handlers.js
module.exports._detonateNukeLaunch = detonateNukeLaunch;

function getSabotageConfig() {
    return {
        disableCost: SABOTAGE_DISABLE_COST,
        stealCost: SABOTAGE_STEAL_COST,
        nukeCostPct: SABOTAGE_NUKE_COST_PCT,
        failureChance: SABOTAGE_FAILURE_CHANCE,
        disableDurationMs: SABOTAGE_DISABLE_DURATION_MS,
        nukeFalloutRadius: SABOTAGE_NUKE_FALLOUT_RADIUS,
        nukeFalloutDurationMs: SABOTAGE_NUKE_FALLOUT_DURATION_MS,
        strikeLimitPerDay: STRIKE_LIMIT_PER_DAY,
        maintenanceRefundPct: MAINTENANCE_REFUND_PCT,
        nukeCountdownMs: NUKE_COUNTDOWN_MS,
        nukeManufactureMs: NUKE_MANUFACTURE_MS,
        nukeManufactureCost: NUKE_MANUFACTURE_COST,
        nukeMaxInventory: NUKE_MAX_INVENTORY,
        nukeLaunchCooldownMs: NUKE_LAUNCH_COOLDOWN_MS,
        nukeMaxSilos: NUKE_MAX_SILOS,
    };
}

// Economy tick interval in ms. 2 000 ms halves bandwidth vs 1 000 ms while
// keeping production/income visually smooth (change is imperceptible at ≥2 s).
const ECONOMY_TICK_MS = 2000;

function setupGameLoop(io) {
    setInterval(async () => {
        try {
            const run = await getActiveRun();
            if (run) {
                await processRunEconomy(io, run);
                await processNukeManufactures(io, run);
                await processNukeLaunches(io, run);
            }
        } catch (err) {
            console.error('Economy tick error:', err);
        }
    }, ECONOMY_TICK_MS);

    setInterval(async () => {
        try {
            const run = await getActiveRun();
            if (!run) {
                const newRun = await createNewRun();
                io.emit('run:new', { runId: newRun.id, runNumber: newRun.run_number });
                return;
            }
            if (new Date() >= new Date(run.next_day_at)) {
                await advanceDay(io, run);
            }
        } catch (err) {
            console.error('Game loop error:', err);
        }
    }, 30 * 1000);

    setTimeout(async () => {
        try {
            const run = await getActiveRun();
            if (!run) {
                await createNewRun();
                console.log('Boot: no active run found, created one.');
            } else {
                console.log(`Boot: active run #${run.run_number}, day ${run.current_day}/${run.run_length}`);
                // Prime terrain cache for existing run on server restart
                getOrGenerateTerrain(run.id);
                getOrGenerateDeposits(run.id);
            }
        } catch (err) {
            console.error('Boot run check error:', err);
        }
    }, 2000);
}

module.exports = {
    setupGameLoop,
    getActiveRun,
    createNewRun,
    endRun,
    calculateScores,
    ensureRunPlayerState,
    getRunSnapshot,
    emitRunSnapshot,
    saveEconomySnapshot,
    updateAlltimeMarketRecords,
    updateAlltimePlayerBests,
    BUILDING_RULES,
    setBuildingRules,
    saveBuildingRulesToDB,
    loadBuildingRulesFromDB,
    DAY_DURATION_MS,
    // Runtime-config getters
    getBuyIn: () => BUY_IN,
    getBuildSlots: () => BUILD_SLOTS,
    getMarketPoolBurnRate: () => MARKET_POOL_BURN_RATE,
    getProximityRange: () => PROXIMITY_RANGE,
    getGridSize: () => ({ cols: GRID_COLS, rows: GRID_ROWS }),
    loadRuntimeConfigFromDB,
    getBalanceConfig: () => ({
        buyIn: BUY_IN,
        buildSlots: BUILD_SLOTS,
        gridCols: GRID_COLS,
        gridRows: GRID_ROWS,
        proximityRange: PROXIMITY_RANGE,
        totalTokenSupply: TOTAL_TOKEN_SUPPLY,
        market: {
            basePrice: MARKET_BASE_PRICE,
            tokenPoolInitial: MARKET_TOKEN_POOL_INITIAL,
            poolBurnRate: MARKET_POOL_BURN_RATE,
            volatility: MARKET_VOLATILITY,
            perSecondVol: MARKET_PER_SECOND_VOL,
            baseDemand: MARKET_BASE_DEMAND,
            driftFactor: MARKET_DRIFT_FACTOR,
        },
        buildingRules: BUILDING_RULES,
        production: {
            mineBaseProduction: MINE_BASE_PRODUCTION,
            processorConvertRate: PROCESSOR_CONVERT_RATE,
            plantBasePower: PLANT_BASE_POWER,
            incomePowerMult: INCOME_POWER_MULT,
            proximityBonusPerBuilding: PROXIMITY_BONUS_PER_BUILDING,
            proximityBonusCap: PROXIMITY_BONUS_CAP,
        },
        sabotage: {
            disableCost: SABOTAGE_DISABLE_COST,
            stealCost: SABOTAGE_STEAL_COST,
            nukeCostPct: SABOTAGE_NUKE_COST_PCT,
            failureChance: SABOTAGE_FAILURE_CHANCE,
            disableDurationMs: SABOTAGE_DISABLE_DURATION_MS,
            nukeFalloutRadius: SABOTAGE_NUKE_FALLOUT_RADIUS,
            nukeFalloutDurationMs: SABOTAGE_NUKE_FALLOUT_DURATION_MS,
            strikeLimitPerDay: STRIKE_LIMIT_PER_DAY,
            maintenanceRefundPct: MAINTENANCE_REFUND_PCT,
            nukeCountdownMs: NUKE_COUNTDOWN_MS,
            nukeManufactureMs: NUKE_MANUFACTURE_MS,
        },
        surveyor: {
            cost: SURVEYOR_COST,
            durationMs: SURVEYOR_DURATION_MS,
            maintPerTick: SURVEYOR_MAINT_PER_TICK,
            discoverRadius: SURVEYOR_DISCOVER_RADIUS,
            moveEveryNTicks: SURVEYOR_MOVE_EVERY_N_TICKS,
            magnetism: SURVEYOR_MAGNETISM,
        },
        deposit: {
            minClusters: DEPOSIT_MIN_CLUSTERS,
            maxExtraClusters: DEPOSIT_MAX_EXTRA_CLUSTERS,
        },
    }),
    getProductionConfig: () => ({
        mineBaseProduction: MINE_BASE_PRODUCTION,
        processorConvertRate: PROCESSOR_CONVERT_RATE,
        plantBasePower: PLANT_BASE_POWER,
        incomePowerMult: INCOME_POWER_MULT,
        proximityBonusPerBuilding: PROXIMITY_BONUS_PER_BUILDING,
        proximityBonusCap: PROXIMITY_BONUS_CAP,
    }),
    getSabotageConfig,
    getSurveyorConfig: () => ({
        cost: SURVEYOR_COST,
        durationMs: SURVEYOR_DURATION_MS,
        maintPerTick: SURVEYOR_MAINT_PER_TICK,
        discoverRadius: SURVEYOR_DISCOVER_RADIUS,
    }),
    getSurveyorConfigKeys: () => ({
        'surveyor.cost':           SURVEYOR_COST,
        'surveyor.duration_ms':    SURVEYOR_DURATION_MS,
        'surveyor.maint_per_tick': SURVEYOR_MAINT_PER_TICK,
        'surveyor.discover_radius': SURVEYOR_DISCOVER_RADIUS,
    }),
    setNextRunLength,
    getNextRunLength: () => _nextRunLength,
    getTerrainForRun: getOrGenerateTerrain,
    getDepositsForRun: getOrGenerateDeposits,
    clearDepositCache: (runId) => { _depositsCache.delete(runId); },
    getNukeConfig: () => ({ countdownMs: NUKE_COUNTDOWN_MS, manufactureMs: NUKE_MANUFACTURE_MS, manufactureCost: NUKE_MANUFACTURE_COST, falloutRadius: SABOTAGE_NUKE_FALLOUT_RADIUS, maxInventory: NUKE_MAX_INVENTORY, launchCooldownMs: NUKE_LAUNCH_COOLDOWN_MS, maxSilos: NUKE_MAX_SILOS }),
    processNukeLaunches,
    processNukeManufactures,
    detonateNukeLaunch,
};
