require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const fs         = require('fs');
const path       = require('path');
const db         = require('./db');
const { setupGameLoop } = require('./gameLoop');
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
