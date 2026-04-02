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

// Auto-run schema migration on every boot (all statements are IF NOT EXISTS — safe to re-run)
async function runMigration() {
    const client = await db.connect();
    try {
        const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        // Split on semicolons, run each statement individually so pg handles them correctly
        const statements = sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));
        for (const stmt of statements) {
            await client.query(stmt);
        }
        console.log('✅ Schema migration OK');
    } catch (err) {
        // Log but don't crash — tables may already exist from a previous deploy
        console.error('⚠️  Schema migration warning:', err.message);
    } finally {
        client.release();
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
    // Keep socket payloads small — disable per-message compression overhead
    perMessageDeflate: false,
});

app.use(cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
}));
app.use(express.json());

// Health check — Railway uses this to verify the service is alive
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

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

// Run the persistent game loop (day advancement, auto-start new runs)
setupGameLoop(io);

const PORT = parseInt(process.env.PORT || '3001', 10);

runMigration().then(() => {
    server.listen(PORT, () => {
        console.log(`☢️  NukeTycoon server listening on port ${PORT}`);
    });
});
