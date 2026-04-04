require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const db         = require('./db');
const { setupGameLoop, getActiveRun, createNewRun, endRun, setNextRunLength, getNextRunLength, BUILDING_RULES, setBuildingRules, saveBuildingRulesToDB, loadBuildingRulesFromDB, calculateScores, updateAlltimeMarketRecords, loadRuntimeConfigFromDB, getBalanceConfig } = require('./gameLoop');
const { verifyJWT, verifyAdminKey, createAdminKey } = require('./auth');
const { registerHandlers } = require('./socket/handlers');

let dbReady = false;
let gameLoopStarted = false;

function stripSqlComments(sql) {
    return sql
        .split(/\r?\n/)
        .map((line) => line.replace(/--.*$/, '').trimEnd())
        .join('\n');
}

// Auto-run schema migration on every boot (all statements are IF NOT EXISTS — safe to re-run)
async function runMigration() {
    let client;
    try {
        if (!process.env.DATABASE_URL) {
            console.error('⚠️  Database init failed: DATABASE_URL is missing. Link the Postgres service to this Railway service or add a DATABASE_URL reference in Variables.');
            return false;
        }

        client = await db.connect();
        const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        // Execute entire schema in one query to preserve dollar-quoted function bodies
        await client.query(sql);

        dbReady = true;
        console.log('✅ Schema migration OK');
        return true;
    } catch (err) {
        console.error('⚠️  Database init failed:', err && (err.stack || err.message || String(err)));
        return false;
    } finally {
        if (client) client.release();
    }
}

async function initializeDatabase(io) {
    const ok = await runMigration();
    if (!ok) {
        setTimeout(() => initializeDatabase(io), 5000);
        return;
    }

    if (!gameLoopStarted) {
        await loadBuildingRulesFromDB();
        await loadRuntimeConfigFromDB();
        setupGameLoop(io);
        gameLoopStarted = true;
    }
}

function getAdminKeyFromRequest(req) {
    const headerKey = req.headers['x-admin-key'];
    const queryKey = req.query?.key;
    const bodyKey = req.body?.key;
    return [headerKey, queryKey, bodyKey].find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

async function requireAdmin(req, res, next) {
    const provided = getAdminKeyFromRequest(req);

    // Determine whether any admin keys are configured (env or DB)
    let configured = false;
    const envKeysRaw = (process.env.ADMIN_KEYS || process.env.ADMIN_KEY || '').trim();
    if (envKeysRaw) configured = true;
    try {
        const r = await db.query('SELECT 1 FROM admin_keys WHERE active = TRUE LIMIT 1');
        if (r && r.rowCount > 0) configured = true;
    } catch (e) {
        // ignore errors (table may not exist yet during migrations)
    }

    if (!configured) {
        res.status(503).json({ error: 'ADMIN_KEY is not configured on the Railway server.' });
        return;
    }

    // Verify provided key against env and DB keys
    const verification = await verifyAdminKey(provided);
    if (!verification) {
        res.status(401).json({ error: 'Invalid admin key.' });
        return;
    }

    // Attach admin info to request for handlers to use
    req.admin = verification;

    // Audit the admin request (don't store the raw key)
    try {
        const bodyCopy = (typeof req.body === 'object' && req.body !== null) ? { ...req.body } : null;
        if (bodyCopy && Object.prototype.hasOwnProperty.call(bodyCopy, 'key')) delete bodyCopy.key;
        await db.query(
            `INSERT INTO admin_audit (admin_key_id, admin_name, path, method, action, details)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [verification.id, verification.name || verification.created_by || verification.source || null, req.path, req.method, `${req.method} ${req.path}`, JSON.stringify({ body: bodyCopy, query: req.query })]
        );
    } catch (e) {
        console.warn('admin audit log failed:', e && e.message);
    }

    next();
}

async function getAdminSnapshot() {
    const run = await getActiveRun();
    if (!run) {
        return {
            dbReady,
            run: null,
            counts: { players: 0, buildings: 0 },
            recentBuildings: [],
        };
    }

    const [playersResult, buildingCountResult, recentBuildingsResult] = await Promise.all([
        db.query('SELECT COUNT(*)::int AS count FROM run_players WHERE run_id = $1', [run.id]),
        db.query('SELECT COUNT(*)::int AS count FROM buildings WHERE run_id = $1 AND is_active = TRUE', [run.id]),
        db.query(
            `SELECT b.cell_id, b.type, b.player_id, b.placed_at, p.username AS owner_name
             FROM buildings b
             LEFT JOIN players p ON p.id = b.player_id
             WHERE b.run_id = $1 AND b.is_active = TRUE
             ORDER BY b.placed_at DESC
             LIMIT 50`,
            [run.id]
        ),
    ]);

    return {
        dbReady,
        run,
        counts: {
            players: parseInt(playersResult.rows[0]?.count || 0, 10),
            buildings: parseInt(buildingCountResult.rows[0]?.count || 0, 10),
        },
        recentBuildings: recentBuildingsResult.rows,
    };
}

const app    = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CLIENT_ORIGIN || '*').split(',').map(o => o.trim());

const io = new Server(server, {
    cors: {
        origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
        methods: ['GET', 'POST'],
    },
    // Allow both websocket and polling for Railway proxy compatibility
    transports: ['websocket', 'polling'],
    // Heartbeat to prevent Railway/proxy idle-timeout disconnects
    pingInterval: 25000,
    pingTimeout: 20000,
    // Keep socket payloads small — disable per-message compression overhead
    perMessageDeflate: false,
});

app.use(cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
}));
app.use(express.json());

function getJwtFromReq(req) {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    if (req.query && req.query.jwt) return req.query.jwt;
    return null;
}

async function requireJwtPlayer(req, res, next) {
    const token = getJwtFromReq(req);
    if (!token) return res.status(401).json({ error: 'Missing JWT.' });
    const decoded = verifyJWT(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid or expired token.' });
    try {
        const result = await db.query('SELECT * FROM players WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Player not found.' });
        req.player = result.rows[0];
        next();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

// Health check — Railway uses this to verify the service is alive
app.get('/health', (_req, res) => res.json({ ok: true, dbReady, ts: new Date().toISOString() }));

// Minimal REST: current run status (useful for debugging)
app.get('/status', async (_req, res) => {
    try {
        const result = await db.query(
            "SELECT id, run_number, current_day, run_length, prize_pool, next_day_at, status FROM runs WHERE status = 'active' LIMIT 1"
        );
        res.json({ run: result.rows[0] || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin', (_req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Economy dashboard (public) ────────────────────────────────────────────────
app.get('/economy', (_req, res) => {
    res.sendFile(path.join(__dirname, 'economy.html'));
});

// Separate Balance UI — limited scope admin page for tuning economy
app.get('/balance', (_req, res) => {
    res.sendFile(path.join(__dirname, 'balance.html'));
});

// Return consolidated balance config for the UI
app.get('/admin/api/balance', requireAdmin, async (_req, res) => {
    try {
        const cfg = getBalanceConfig();
        res.json({ ok: true, config: cfg });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Apply multiple balance config changes. Body: { changes: { 'key': value, ... } }
app.post('/admin/api/balance', requireAdmin, async (req, res) => {
    const changes = req.body?.changes && typeof req.body.changes === 'object' ? req.body.changes : (typeof req.body === 'object' ? req.body : null);
    if (!changes || Object.keys(changes).length === 0) return res.status(400).json({ error: 'Provide changes object with keys.' });
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        // Insert an admin_actions row to group this save
        const actionRes = await client.query(
            `INSERT INTO admin_actions (admin_key_id, admin_name, action_type, meta) VALUES ($1,$2,$3,$4) RETURNING id`,
            [req.admin?.id || null, req.admin?.name || req.admin?.created_by || null, 'save', JSON.stringify({ count: Object.keys(changes).length })]
        );
        const adminActionId = actionRes.rows[0].id;
        const applied = {};
        for (const [key, rawVal] of Object.entries(changes)) {
            const val = rawVal === null || rawVal === undefined ? null : String(rawVal);
            const prev = await client.query('SELECT value FROM server_config WHERE key = $1', [key]);
            const oldVal = prev.rows[0]?.value || null;
            await client.query(
                `INSERT INTO server_config (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key, val]
            );
            await client.query(
                `INSERT INTO server_config_audit (key, old_value, new_value, admin_key_id, admin_action_id, admin_name)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [key, oldVal, val, req.admin?.id || null, adminActionId, req.admin?.name || req.admin?.created_by || req.admin?.source || null]
            );
            applied[key] = { old: oldVal, new: val };
        }
        await client.query('COMMIT');
        // Reload runtime config into game loop and broadcast to clients
        try { await loadBuildingRulesFromDB(); await loadRuntimeConfigFromDB(); } catch (e) { console.warn('Failed to reload runtime config:', e && e.message); }
        io.emit('run:balance_update', { applied });
        res.json({ ok: true, applied });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Economy data API — public, read-only, used by the web dashboard and in-game portal
app.get('/economy/api/data', async (_req, res) => {
    try {
        const run = await getActiveRun();

        // Always fetch alltime data (even when no run is active)
        const [alltimeMarketResult, alltimePlayersResult] = await Promise.all([
            db.query('SELECT * FROM alltime_market_records'),
            db.query(
                `SELECT apb.player_id, apb.best_balance, apb.best_daily_income, apb.best_rank,
                        apb.total_runs, apb.updated_at, p.username, p.avatar, p.avatar_photo
                 FROM alltime_player_bests apb
                 JOIN players p ON p.id = apb.player_id
                 ORDER BY apb.best_balance DESC LIMIT 25`
            ),
        ]);
        const alltimeMarket  = alltimeMarketResult.rows.reduce((acc, r) => { acc[r.stat_key] = { value: Number(r.value), run_number: r.run_number, recorded_at: r.recorded_at }; return acc; }, {});
        const alltimePlayers = alltimePlayersResult.rows.map((p) => ({
            player_id:        p.player_id,
            username:         p.username,
            avatar:           p.avatar,
            avatar_photo:     p.avatar_photo || null,
            best_balance:     parseInt(p.best_balance, 10) || 0,
            best_daily_income:parseInt(p.best_daily_income, 10) || 0,
            best_rank:        p.best_rank === 99999 ? null : p.best_rank,
            total_runs:       p.total_runs || 0,
            updated_at:       p.updated_at,
        }));

        if (!run) {
            res.json({ run: null, scores: [], history: [], buildingCounts: {}, players: [], buildingRules: BUILDING_RULES, tokensPerUSD: 2000, alltimeMarket, alltimePlayers, serverTime: new Date().toISOString() });
            return;
        }

        const [scores, historyResult, buildingsResult, playersResult] = await Promise.all([
            calculateScores(run.id),
            db.query(
                'SELECT * FROM economy_snapshots WHERE run_id = $1 ORDER BY run_day ASC',
                [run.id]
            ),
            db.query(
                'SELECT type, COUNT(*)::int AS count FROM buildings WHERE run_id = $1 AND is_active = TRUE GROUP BY type',
                [run.id]
            ),
            db.query(
                `SELECT p.id, p.username, p.avatar, p.avatar_photo, p.token_balance,
                        COALESCE(rps.score, 0) AS score,
                        COALESCE(rps.uranium_raw, 0) AS uranium_raw,
                        COALESCE(rps.uranium_refined, 0) AS uranium_refined,
                        COALESCE(rps.last_income, 0) AS last_income,
                        COALESCE(rps.daily_income, 0) AS daily_income,
                        COALESCE(rps.daily_produced, 0) AS daily_produced
                 FROM run_players rp
                 JOIN players p ON p.id = rp.player_id
                 LEFT JOIN run_player_state rps
                        ON rps.run_id = rp.run_id AND rps.player_id = rp.player_id
                 WHERE rp.run_id = $1
                 ORDER BY COALESCE(rps.score, 0) DESC`,
                [run.id]
            ),
            db.query('SELECT * FROM alltime_market_records'),
            db.query(
                `SELECT apb.player_id, apb.best_balance, apb.best_daily_income, apb.best_rank,
                        apb.total_runs, apb.updated_at, p.username, p.avatar, p.avatar_photo
                 FROM alltime_player_bests apb
                 JOIN players p ON p.id = apb.player_id
                 ORDER BY apb.best_balance DESC
                 LIMIT 25`
            ),
        ]);

        const buildingCounts = {};
        buildingsResult.rows.forEach((r) => { buildingCounts[r.type] = r.count; });

        res.json({
            run: {
                id: run.id,
                run_number: run.run_number,
                current_day: run.current_day,
                run_length: run.run_length,
                market_price: run.market_price,
                market_prev_price: run.market_prev_price,
                prize_pool: run.prize_pool,
                platform_fee_collected: run.platform_fee_collected,
                next_day_at: run.next_day_at,
                status: run.status,
                tokens_issued: run.tokens_issued,
                market_token_pool: run.market_token_pool,
                market_token_pool_initial: run.market_token_pool_initial,
                total_token_supply: run.total_token_supply,
            },
            scores,
            history: historyResult.rows,
            buildingCounts,
            players: playersResult.rows.map((p) => ({
                ...p,
                token_balance: parseInt(p.token_balance, 10) || 0,
                score: Number(p.score || 0),
                last_income: parseInt(p.last_income, 10) || 0,
                daily_income: parseInt(p.daily_income, 10) || 0,
                uranium_raw: Number(p.uranium_raw || 0),
                uranium_refined: Number(p.uranium_refined || 0),
            })),
            buildingRules: BUILDING_RULES,
            tokensPerUSD: 2000,
            alltimeMarket,
            alltimePlayers,
            serverTime: new Date().toISOString(),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/reset-alltime-stats', requireAdmin, async (_req, res) => {
    try {
        await Promise.all([
            db.query('DELETE FROM alltime_market_records'),
            db.query('DELETE FROM alltime_player_bests'),
        ]);
        res.json({ ok: true, message: 'All-time economy stats cleared.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/api/status', requireAdmin, async (_req, res) => {
    try {
        res.json(await getAdminSnapshot());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/clear-cell', requireAdmin, async (req, res) => {
    try {
        const cellId = Number(req.body?.cellId);
        if (!Number.isInteger(cellId) || cellId < 0 || cellId > 399) {
            res.status(400).json({ error: 'cellId must be an integer from 0 to 399.' });
            return;
        }

        const run = await getActiveRun();
        if (!run) {
            res.status(404).json({ error: 'No active run found.' });
            return;
        }

        const result = await db.query(
            `UPDATE buildings
             SET is_active = FALSE, destroyed_at = NOW()
             WHERE run_id = $1 AND cell_id = $2 AND is_active = TRUE
             RETURNING cell_id`,
            [run.id, cellId]
        );

        io.to(`run:${run.id}`).emit('admin:cell_cleared', {
            runId: run.id,
            cellId,
            cleared: result.rowCount,
        });

        res.json({ ok: true, cleared: result.rowCount, status: await getAdminSnapshot() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/reset-buildings', requireAdmin, async (_req, res) => {
    try {
        const run = await getActiveRun();
        if (!run) {
            res.status(404).json({ error: 'No active run found.' });
            return;
        }

        const result = await db.query(
            `UPDATE buildings
             SET is_active = FALSE, destroyed_at = NOW()
             WHERE run_id = $1 AND is_active = TRUE
             RETURNING cell_id`,
            [run.id]
        );

        // Also clear any queued builds for this run so ghosts don't persist
        try {
            await db.query('DELETE FROM build_queue WHERE run_id = $1', [run.id]);
        } catch (e) {
            console.warn('admin:reset-buildings failed to clear build_queue:', e && e.message);
        }

        io.to(`run:${run.id}`).emit('admin:buildings_reset', {
            runId: run.id,
            cellIds: result.rows.map((row) => row.cell_id),
            cleared: result.rowCount,
        });

        res.json({ ok: true, cleared: result.rowCount, status: await getAdminSnapshot() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/reset-run', requireAdmin, async (_req, res) => {
    try {
        const activeRun = await getActiveRun();
        if (activeRun) {
            await db.query(
                `UPDATE buildings
                 SET is_active = FALSE, destroyed_at = COALESCE(destroyed_at, NOW())
                 WHERE run_id = $1 AND is_active = TRUE`,
                [activeRun.id]
            );
            await db.query(
                "UPDATE runs SET status = 'ended', ended_at = NOW() WHERE id = $1",
                [activeRun.id]
            );
            io.to(`run:${activeRun.id}`).emit('admin:run_reset', { runId: activeRun.id });
        }

        const newRun = await createNewRun();
        io.emit('run:new', {
            runId: newRun.id,
            runNumber: newRun.run_number,
            forced: true,
        });

        res.json({ ok: true, newRun, status: await getAdminSnapshot() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Force end the current run and distribute payouts (atomic)
app.post('/admin/api/force-end-run', requireAdmin, async (_req, res) => {
    try {
        const run = await getActiveRun();
        if (!run) { res.status(404).json({ error: 'No active run.' }); return; }
        await endRun(io, run);
        res.json({ ok: true, message: 'Run ended; payouts distributed.', status: await getAdminSnapshot() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Notifications API ─────────────────────────────────────────────────────
// Fetch player's notifications (requires JWT in Authorization: Bearer <token>)
app.get('/api/notifications', requireJwtPlayer, async (req, res) => {
    try {
        const player = req.player;
        try {
            console.log(`[api] /api/notifications requested by player=${player.id} email=${player.email}`);
        } catch (e) {}
        const rows = await db.query(
            'SELECT id, run_id, type, payload, read, created_at FROM notifications WHERE (LOWER(email) = LOWER($1) OR player_id = $2) ORDER BY created_at DESC LIMIT 200',
            [player.email, player.id]
        );
        try {
            console.log(`[api] /api/notifications returning ${rows.rows.length} rows for player=${player.id}`);
        } catch (e) {}
        res.json({ notifications: rows.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mark notifications read. Body: { ids: [id,...] } or { all: true }
app.post('/api/notifications/mark_read', requireJwtPlayer, async (req, res) => {
    try {
        const player = req.player;
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
        const all = !!req.body?.all;
        if (!all && (!ids || ids.length === 0)) return res.status(400).json({ error: 'Provide ids or set all=true.' });
        if (all) {
            await db.query('UPDATE notifications SET read = TRUE WHERE (LOWER(email) = LOWER($1) OR player_id = $2)', [player.email, player.id]);
        } else {
            await db.query('UPDATE notifications SET read = TRUE WHERE (LOWER(email) = LOWER($1) OR player_id = $2) AND id = ANY($3::uuid[])', [player.email, player.id, ids]);
        }
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Danger zone endpoints ──────────────────────────────────────────────────

// Wipe run_players for the current run — forces everyone back to the buy-in lobby
app.post('/admin/api/wipe-run-players', requireAdmin, async (_req, res) => {
    try {
        const run = await getActiveRun();
        if (!run) { res.status(404).json({ error: 'No active run.' }); return; }
        const result = await db.query('DELETE FROM run_players WHERE run_id = $1', [run.id]);
        res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reset all player token balances to 50,000
app.post('/admin/api/reset-balances', requireAdmin, async (_req, res) => {
    try {
        const result = await db.query('UPDATE players SET token_balance = 50000');
        res.json({ ok: true, updated: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Wipe all run_player_state rows for current run
app.post('/admin/api/wipe-player-state', requireAdmin, async (_req, res) => {
    try {
        const run = await getActiveRun();
        if (!run) { res.status(404).json({ error: 'No active run.' }); return; }
        const result = await db.query('DELETE FROM run_player_state WHERE run_id = $1', [run.id]);
        res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Nuclear option: end current run, wipe all per-run data, reset balances, start fresh
app.post('/admin/api/full-db-reset', requireAdmin, async (_req, res) => {
    try {
        const activeRun = await getActiveRun();
        if (activeRun) {
            io.to(`run:${activeRun.id}`).emit('admin:run_reset', { runId: activeRun.id });
        }
        // End all active runs
        await db.query("UPDATE runs SET status = 'ended', ended_at = NOW() WHERE status = 'active'");
        // Wipe ALL per-run data (every historical run).
        // Delete from child tables first to avoid FK constraint errors (e.g., build_queue -> runs).
        await db.query('DELETE FROM sabotage_events');
        await db.query('DELETE FROM fallout_zones');
        await db.query('DELETE FROM build_queue');
        await db.query('DELETE FROM chat_messages');
        await db.query('DELETE FROM notifications');
        await db.query('DELETE FROM run_player_state');
        await db.query('DELETE FROM run_players');
        await db.query('DELETE FROM economy_snapshots');
        await db.query('DELETE FROM buildings');
        await db.query('DELETE FROM runs');
        // Reset player balances
        await db.query('UPDATE players SET token_balance = 50000');
        // Start fresh run
        const newRun = await createNewRun();
        io.emit('run:new', { runId: newRun.id, runNumber: newRun.run_number, forced: true });
        res.json({ ok: true, message: 'Full DB reset complete.', newRun });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set run length for next (and optionally current) run
app.post('/admin/api/set-run-length', requireAdmin, async (req, res) => {
    try {
        const len = parseInt(req.body.runLength, 10);
        if (!Number.isFinite(len) || len < 1 || len > 365) {
            res.status(400).json({ error: 'runLength must be 1–365.' }); return;
        }
        setNextRunLength(len);
        const run = await getActiveRun();
        let appliedToCurrentRun = false;
        if (run) {
            appliedToCurrentRun = true;
            // Update current run length in DB
            await db.query('UPDATE runs SET run_length = $1 WHERE id = $2', [len, run.id]);

            // If next_day_at was missing for some reason, seed it so the day clock can progress
            try {
                if (!run.next_day_at) {
                    const dur = Number(run.day_duration_ms) || Number(process.env.DAY_DURATION_MS) || 86400000;
                    const newNext = new Date(Date.now() + dur);
                    await db.query('UPDATE runs SET next_day_at = $1 WHERE id = $2', [newNext, run.id]);
                }
            } catch (e) {
                console.warn('admin:set-run-length failed to ensure next_day_at:', e && e.message);
            }

            // Broadcast config update to all connected clients so HUDs refresh
            io.emit('run:config_update', { run_length: len });
            // Also emit into run room for backwards compat with room-scoped listeners
            io.to(`run:${run.id}`).emit('run:config_update', { run_length: len });
        }

        res.json({ ok: true, runLength: len, appliedToCurrentRun });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get current building costs and construction times
app.get('/admin/api/building-config', requireAdmin, (_req, res) => {
    res.json({ ok: true, buildingRules: BUILDING_RULES });
});

// Update a building type's cost and/or constructionMs; save to DB and broadcast to all clients
app.post('/admin/api/set-building-config', requireAdmin, async (req, res) => {
    try {
        const { type, cost, constructionMs, maintenanceCost } = req.body;
        if (!type || !BUILDING_RULES[type]) {
            res.status(400).json({ error: `Unknown building type '${type}'. Valid: ${Object.keys(BUILDING_RULES).join(', ')}` }); return;
        }
        setBuildingRules(type, cost, constructionMs, maintenanceCost);
        await saveBuildingRulesToDB(type);
        io.emit('run:building_config', { buildingRules: BUILDING_RULES });
        res.json({ ok: true, buildingRules: BUILDING_RULES });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// Admin keys management: list, create, deactivate
app.get('/admin/api/admin-keys', requireAdmin, async (_req, res) => {
    try {
        const result = await db.query('SELECT id, name, created_by, created_at, last_used_at, active FROM admin_keys ORDER BY created_at DESC');
        res.json({ ok: true, keys: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/admin-keys', requireAdmin, async (req, res) => {
    try {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : null;
        const createdBy = req.admin?.name || req.admin?.created_by || 'web';
        const newKey = await createAdminKey(name, createdBy);
        // Return the plain key once so the operator can copy it.
        res.json({ ok: true, id: newKey.id, key: newKey.key, message: 'Copy this key now — it will not be shown again.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/admin/api/admin-keys/:id/deactivate', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const r = await db.query('UPDATE admin_keys SET active = FALSE WHERE id = $1 RETURNING id, name, active', [id]);
        if (r.rowCount === 0) { res.status(404).json({ error: 'Key not found.' }); return; }
        res.json({ ok: true, key: r.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin audit viewer
app.get('/admin/api/admin-audit', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
        const rows = await db.query('SELECT id, admin_key_id, admin_name, path, method, action, details, created_at FROM admin_audit ORDER BY created_at DESC LIMIT $1', [limit]);
        res.json({ ok: true, audit: rows.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Config audit history (per-key changes)
app.get('/admin/api/config-audit', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
        const rows = await db.query('SELECT id, key, old_value, new_value, admin_key_id, admin_name, created_at FROM server_config_audit ORDER BY created_at DESC LIMIT $1', [limit]);
        res.json({ ok: true, audit: rows.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Snapshot endpoints: create, list, get, restore, delete
app.post('/admin/api/config-snapshots', requireAdmin, async (req, res) => {
    try {
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : (`snapshot-${new Date().toISOString()}`);
        // Read current server_config into an object
        const rows = await db.query('SELECT key, value FROM server_config');
        const obj = {};
        rows.rows.forEach(r => { obj[r.key] = r.value; });
        const result = await db.query(
            `INSERT INTO server_config_snapshots (name, snapshot, created_by, admin_key_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
            [name, obj, req.admin?.name || req.admin?.created_by || null, req.admin?.id || null]
        );
        res.json({ ok: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/api/config-snapshots', requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
        const rows = await db.query('SELECT id, name, created_by, admin_key_id, created_at FROM server_config_snapshots ORDER BY created_at DESC LIMIT $1', [limit]);
        res.json({ ok: true, snapshots: rows.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/admin/api/config-snapshots/:id', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const r = await db.query('SELECT id, name, snapshot, created_by, admin_key_id, created_at FROM server_config_snapshots WHERE id = $1', [id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Snapshot not found.' });
        res.json({ ok: true, snapshot: r.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restore snapshot: applies all keys and writes config audit rows
app.post('/admin/api/config-snapshots/:id/restore', requireAdmin, async (req, res) => {
    const id = req.params.id;
    const client = await db.connect();
    try {
        await client.query('BEGIN');
        // Create admin action for snapshot restore
        const actionRes = await client.query(
            `INSERT INTO admin_actions (admin_key_id, admin_name, action_type, meta) VALUES ($1,$2,$3,$4) RETURNING id`,
            [req.admin?.id || null, req.admin?.name || req.admin?.created_by || null, 'snapshot_restore', JSON.stringify({ snapshot_id: id })]
        );
        const adminActionId = actionRes.rows[0].id;
        const r = await client.query('SELECT snapshot FROM server_config_snapshots WHERE id = $1 FOR UPDATE', [id]);
        if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Snapshot not found.' }); }
        const snapshot = r.rows[0].snapshot || {};
        const applied = {};
        for (const [key, val] of Object.entries(snapshot)) {
            const prev = await client.query('SELECT value FROM server_config WHERE key = $1', [key]);
            const oldVal = prev.rows[0]?.value || null;
            const newVal = val === null || val === undefined ? null : String(val);
            await client.query(
                `INSERT INTO server_config (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key, newVal]
            );
            await client.query(
                `INSERT INTO server_config_audit (key, old_value, new_value, admin_key_id, admin_action_id, admin_name)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [key, oldVal, newVal, req.admin?.id || null, adminActionId, req.admin?.name || req.admin?.created_by || req.admin?.source || null]
            );
            applied[key] = { old: oldVal, new: newVal };
        }
        await client.query('COMMIT');
        try { await loadBuildingRulesFromDB(); await loadRuntimeConfigFromDB(); } catch (e) { console.warn('Failed to reload runtime config after restore:', e && e.message); }
        io.emit('run:balance_update', { applied, restoredFrom: id });
        res.json({ ok: true, applied });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.delete('/admin/api/config-snapshots/:id', requireAdmin, async (req, res) => {
    try {
        const id = req.params.id;
        const r = await db.query('DELETE FROM server_config_snapshots WHERE id = $1 RETURNING id', [id]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Snapshot not found.' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Purge used/expired auth codes
app.post('/admin/api/purge-auth-codes', requireAdmin, async (_req, res) => {
    try {
        const result = await db.query("DELETE FROM auth_codes WHERE used = TRUE OR expires_at < NOW()");
        res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete all ended runs and their orphaned per-run data; active run is untouched
app.post('/admin/api/wipe-old-runs', requireAdmin, async (_req, res) => {
    try {
        const ended = await db.query("SELECT id FROM runs WHERE status = 'ended'");
        if (!ended.rowCount) { res.json({ ok: true, deleted: 0 }); return; }
        const ids = ended.rows.map(r => r.id);
        await db.query('DELETE FROM sabotage_events WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM fallout_zones WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM build_queue WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM chat_messages WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM notifications WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM economy_snapshots WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM buildings WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM run_player_state WHERE run_id = ANY($1)', [ids]);
        await db.query('DELETE FROM run_players WHERE run_id = ANY($1)', [ids]);
        const r = await db.query('DELETE FROM runs WHERE id = ANY($1)', [ids]);
        res.json({ ok: true, deleted: r.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Hard-delete all buildings for the current run and broadcast grid reset
app.post('/admin/api/wipe-buildings', requireAdmin, async (_req, res) => {
    try {
        const run = await getActiveRun();
        if (!run) { res.status(404).json({ error: 'No active run.' }); return; }
        const result = await db.query('DELETE FROM buildings WHERE run_id = $1', [run.id]);
        io.to(`run:${run.id}`).emit('buildings:reset', {});
        res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Wipe fallout zones for current run
app.post('/admin/api/wipe-fallout-zones', requireAdmin, async (_req, res) => {
    try {
        const run = await getActiveRun();
        if (!run) { res.status(404).json({ error: 'No active run.' }); return; }
        const result = await db.query('DELETE FROM fallout_zones WHERE run_id = $1', [run.id]);
        res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Wipe sabotage event log for current run
app.post('/admin/api/wipe-sabotage-log', requireAdmin, async (_req, res) => {
    try {
        const run = await getActiveRun();
        if (!run) { res.status(404).json({ error: 'No active run.' }); return; }
        const result = await db.query('DELETE FROM sabotage_events WHERE run_id = $1', [run.id]);
        res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Set a specific player's token balance by email or username
app.post('/admin/api/set-player-balance', requireAdmin, async (req, res) => {
    try {
        const { identifier, amount } = req.body;
        const parsed = Number(amount);
        if (!identifier || !Number.isFinite(parsed) || parsed < 0) {
            res.status(400).json({ error: 'Provide identifier (email or username) and a non-negative amount.' }); return;
        }
        const result = await db.query(
            'UPDATE players SET token_balance = $1 WHERE email = $2 OR username = $2 RETURNING username, token_balance',
            [Math.floor(parsed), identifier]
        );
        if (!result.rowCount) { res.status(404).json({ error: `Player '${identifier}' not found.` }); return; }
        res.json({ ok: true, player: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Scorched-earth: delete every player account and all related data
app.post('/admin/api/wipe-all-players', requireAdmin, async (_req, res) => {
    try {
        await db.query("UPDATE runs SET status = 'ended', ended_at = COALESCE(ended_at, NOW()) WHERE status = 'active'");
        // Delete child per-run data first to avoid FK constraint errors
        await db.query('DELETE FROM sabotage_events');
        await db.query('DELETE FROM fallout_zones');
        await db.query('DELETE FROM build_queue');
        await db.query('DELETE FROM chat_messages');
        await db.query('DELETE FROM notifications');
        await db.query('DELETE FROM run_player_state');
        await db.query('DELETE FROM run_players');
        await db.query('DELETE FROM economy_snapshots');
        await db.query('DELETE FROM buildings');
        await db.query('DELETE FROM runs');
        await db.query('DELETE FROM auth_codes');
        const result = await db.query('DELETE FROM players');
        res.json({ ok: true, deleted: result.rowCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GIF search proxy — forwards query to Tenor v2 via server-side fetch so no API key is exposed
// Uses Node 20 built-in fetch; TENOR_API_KEY env var (falls back to Tenor demo key for testing)
app.get('/api/gifs', async (req, res) => {
    try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : 'reaction';
        const key = process.env.TENOR_API_KEY || 'LIVDSAK';
        const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}&limit=12&media_filter=gif,tinygif&contentfilter=high&client_key=nuketycoon`;
        const upstream = await fetch(url);
        if (!upstream.ok) {
            res.status(502).json({ error: 'GIF search unavailable.', results: [] });
            return;
        }
        const data = await upstream.json();
        // Normalise to a simple shape so client code stays simple
        const results = (data.results || []).map(item => {
            const media = item.media_formats || {};
            const preview = (media.tinygif || media.gif || {}).url || '';
            const full    = (media.gif     || media.tinygif || {}).url || preview;
            return { url: full, preview };
        }).filter(r => r.preview);
        res.json({ results });
    } catch (err) {
        console.error('GIF proxy error:', err.message);
        res.status(500).json({ error: 'GIF search failed.', results: [] });
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 connected  ${socket.id}`);
    registerHandlers(io, socket);
    socket.on('disconnect', (reason) => {
        console.log(`🔌 disconnected ${socket.id} (${reason})`);
    });
});

const PORT = parseInt(process.env.PORT || '3001', 10);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`☢️  NukeTycoon server listening on 0.0.0.0:${PORT}`);
    initializeDatabase(io);
});
