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
        _depositsCache.set(runId, generateDepositsForRun(runId, terrain));
    }
    return _depositsCache.get(runId);
}
const BUY_IN = 20000;
const BUILD_SLOTS = 1; // concurrent buildings under construction per player; raise via future mechanics
const GRID_COLS = 20;
const GRID_ROWS = 20;
const PROXIMITY_RANGE = 2;
const TOTAL_TOKEN_SUPPLY = 1000000000;
const MARKET_BASE_PRICE = 1;
const MARKET_TOKEN_POOL_INITIAL = 1000;
const MARKET_POOL_BURN_RATE = 50;
const MARKET_VOLATILITY = 0.03;
const MARKET_PER_SECOND_VOL = MARKET_VOLATILITY / 60;
const MARKET_BASE_DEMAND = 1000;
const MARKET_DRIFT_FACTOR = 0.0002;
const BUILDING_RULES = {
    mine:      { cost: 800,  constructionMs: 10000, maintenanceCost: 2 },
    processor: { cost: 1200, constructionMs: 15000, maintenanceCost: 3 },
    storage:   { cost: 1000, constructionMs: 20000, maintenanceCost: 2,  storageBonus: 1000 },
    plant:     { cost: 1000, constructionMs: 22000, maintenanceCost: 10, basePower: 100 },
    silo:      { cost: 6000, constructionMs: 35000, maintenanceCost: 25, isWeapon: true },
};

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
            if (!Number.isFinite(num)) return;
            if (field === 'cost') BUILDING_RULES[type].cost = Math.floor(num);
            if (field === 'constructionMs') BUILDING_RULES[type].constructionMs = Math.floor(num);
            if (field === 'maintenanceCost') BUILDING_RULES[type].maintenanceCost = Math.floor(num);
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
    const numDeposits = 5 + Math.floor(rand() * 4);

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

    return deposits;
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
    const base = 100 - (nearbyEnemies * 20);
    const jitter = Math.sin((now / 1000) + Number(plant.cell_id || 0)) * 2;
    const roadMult = cellHasRoadNeighbor(plant.cell_id, terrain) ? 1.4 : 1;
    const plantProxMult = 1 + (Math.min(samePlants, 3) * 0.25);
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

async function calculateScores(runId) {
    const result = await db.query(
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

    const [runResult, playersResult, buildingsResult, playerStatesResult, falloutResult, scores] = await Promise.all([
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
    };
}

async function emitRunSnapshot(io, runId, eventName = 'run:tick') {
    const snapshot = await getRunSnapshot(runId);
    if (!snapshot?.run) return null;

    const sockets = await io.in(`run:${runId}`).fetchSockets();
    const stateByPlayer = new Map(snapshot.playerStates.map((state) => [state.player_id, state]));
    const playerById = new Map(snapshot.players.map((player) => [player.id, player]));

    // Detect buildings that just completed construction (within last 2 seconds)
    const serverNow = Date.now();
    const justCompleted = (snapshot.buildings || []).filter(b => {
        if (!b.construction_ends_at) return false;
        const endsAt = new Date(b.construction_ends_at).getTime();
        return endsAt <= serverNow && endsAt > serverNow - 2000;
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

    sockets.forEach((roomSocket) => {
        roomSocket.emit(eventName, {
            run: snapshot.run,
            scores: snapshot.scores,
            playerState: stateByPlayer.get(roomSocket.playerId) || null,
            yourWallet: parseInt(playerById.get(roomSocket.playerId)?.token_balance, 10) || 0,
            falloutZones: snapshot.falloutZones,
            nuclearThreats: snapshot.nuclearThreats,
            serverTime: serverNow,
        });

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

    const [runResult, playersResult, statesResult, buildingsResult, falloutResult] = await Promise.all([
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
                let amount = 0.225;
                amount *= getDepositBonus(mine.cell_id, deposits);
                const sameMines = activeMines.filter((other) => other.id !== mine.id && cellDistance(mine.cell_id, other.cell_id) <= PROXIMITY_RANGE).length;
                amount *= (1 + (Math.min(sameMines, 3) * 0.25));
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
                converted += 0.15 * getBuildingOutputMultiplier(processor, activeFallout, now);
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
                income = Math.floor(totalPower * powerFraction * 0.1); // was * 0.3
            }

            // Deduct maintenance cost for every completed building
            const totalMaintenance = completedBuildings.reduce((sum, b) => sum + (BUILDING_RULES[b.type]?.maintenanceCost || 0), 0);
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

    await emitRunSnapshot(io, run.id, 'run:tick');

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
    const scores = await calculateScores(run.id);
    const shares = [0.50, 0.30, 0.20];
    const payouts = [];

    await db.query(
        "UPDATE runs SET status = 'ended', ended_at = NOW() WHERE id = $1",
        [run.id]
    );

    for (let i = 0; i < Math.min(3, scores.length); i++) {
        const p = scores[i];
        const award = Math.floor((parseInt(run.prize_pool, 10) || 0) * shares[i]);
        if (award > 0) {
            await db.query(
                'UPDATE players SET token_balance = token_balance + $1 WHERE id = $2',
                [award, p.player_id]
            );
        }
        await db.query(
            `UPDATE run_players SET final_rank = $1, payout = $2
             WHERE run_id = $3 AND player_id = $4`,
            [i + 1, award, run.id, p.player_id]
        );
        payouts.push({ ...p, rank: i + 1, award, token_balance: p.token_balance + award });
    }

    console.log(`🏁 Run #${run.run_number} ended. Awarded ${payouts.length} players.`);

    // Update all-time player records (uses post-payout balances)
    await updateAlltimePlayerBests(run, scores);

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

    await emitRunSnapshot(io, run.id, 'run:tick');
    console.log(`📅 Run #${run.run_number} → day ${newDay} (next: ${nextDayAt.toISOString()})`);
}

function setupGameLoop(io) {
    setInterval(async () => {
        try {
            const run = await getActiveRun();
            if (run) {
                await processRunEconomy(io, run);
            }
        } catch (err) {
            console.error('Economy tick error:', err);
        }
    }, 1000);

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
    calculateScores,
    ensureRunPlayerState,
    getRunSnapshot,
    emitRunSnapshot,
    saveEconomySnapshot,
    updateAlltimeMarketRecords,
    updateAlltimePlayerBests,
    BUILDING_RULES,
    BUILD_SLOTS,
    setBuildingRules,
    saveBuildingRulesToDB,
    loadBuildingRulesFromDB,
    DAY_DURATION_MS,
    BUY_IN,
    setNextRunLength,
    getNextRunLength: () => _nextRunLength,
    getTerrainForRun: getOrGenerateTerrain,
    getDepositsForRun: getOrGenerateDeposits,
};
