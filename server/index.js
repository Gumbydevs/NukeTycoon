require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const db         = require('./db');
const { setupGameLoop, getActiveRun, createNewRun } = require('./gameLoop');
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
        const sql = stripSqlComments(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
        const statements = sql
            .split(';')
            .map((statement) => statement.trim())
            .filter(Boolean);

        for (const statement of statements) {
            await client.query(statement);
        }

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

function requireAdmin(req, res, next) {
    const expected = (process.env.ADMIN_KEY || '').trim();
    if (!expected) {
        res.status(503).json({ error: 'ADMIN_KEY is not configured on the Railway server.' });
        return;
    }

    const provided = getAdminKeyFromRequest(req);
    if (provided !== expected) {
        res.status(401).json({ error: 'Invalid admin key.' });
        return;
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
