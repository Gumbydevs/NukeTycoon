const { sendOTP, verifyOTP, verifyJWT, generateJWT } = require('../auth');
const db = require('../db');
const { getActiveRun, calculateScores } = require('../gameLoop');

const BUY_IN = 5000;
const DEFAULT_AVATAR = '☢️';
const VALID_AVATARS = new Set(['☢️', '🧑‍🚀', '👩‍🔬', '👨‍🔬', '🤖', '🦊', '🐺', '🐉']);
const normalizeAvatar = (avatar) => VALID_AVATARS.has(avatar) ? avatar : DEFAULT_AVATAR;
const BUILDING_COSTS = { mine: 800, processor: 1200, storage: 1000, plant: 1000, silo: 6000 };
const VALID_TYPES = Object.keys(BUILDING_COSTS);

// Manhattan distance on a 20-column grid
function gridDist(a, b) {
    return Math.abs((a % 20) - (b % 20)) + Math.abs(Math.floor(a / 20) - Math.floor(b / 20));
}

// Authenticate every sensitive event with the JWT sent in the payload
async function requireAuth(socket, jwt, cb) {
    const decoded = verifyJWT(jwt);
    if (!decoded) {
        socket.emit('error', { message: 'Session expired. Please log in again.' });
        return;
    }
    const result = await db.query('SELECT * FROM players WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0) {
        socket.emit('error', { message: 'Player not found.' });
        return;
    }
    await cb(decoded, result.rows[0]);
}

function registerHandlers(io, socket) {

    // ── AUTH ─────────────────────────────────────────────────────────────────

    socket.on('auth:request', async ({ email }) => {
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            socket.emit('auth:error', { message: 'Enter a valid email address.' });
            return;
        }
        try {
            const result = await sendOTP(email.toLowerCase().trim());
            if (!result.ok) {
                socket.emit('auth:error', { message: result.error });
                return;
            }
            socket.emit('auth:code_sent', { email: email.toLowerCase().trim() });
        } catch (err) {
            console.error('auth:request error:', err);
            socket.emit('auth:error', { message: 'Could not send code. Try again.' });
        }
    });

    socket.on('auth:verify', async ({ email, code }) => {
        if (!email || !code) {
            socket.emit('auth:error', { message: 'Email and code are required.' });
            return;
        }
        try {
            const result = await verifyOTP(email.toLowerCase().trim(), code.toString().trim());
            if (!result.ok) {
                socket.emit('auth:error', { message: result.error });
                return;
            }
            socket.playerId = result.player.id;
            socket.emit('auth:success', {
                player: {
                    id:            result.player.id,
                    username:      result.player.username,
                    email:         result.player.email,
                    avatar:        result.player.avatar || DEFAULT_AVATAR,
                    token_balance: parseInt(result.player.token_balance, 10),
                },
                jwt: result.token,
                isNewPlayer: !!result.isNewPlayer,
            });
        } catch (err) {
            console.error('auth:verify error:', err);
            socket.emit('auth:error', { message: 'Verification failed. Try again.' });
        }
    });

    // Reconnect using a stored JWT (e.g. on page reload)
    socket.on('auth:reconnect', async ({ jwt }) => {
        const decoded = verifyJWT(jwt);
        if (!decoded) {
            socket.emit('auth:session_expired');
            return;
        }
        const result = await db.query('SELECT * FROM players WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) {
            socket.emit('auth:session_expired');
            return;
        }
        const player = result.rows[0];
        socket.playerId = player.id;
        socket.emit('auth:success', {
            player: {
                id:            player.id,
                username:      player.username,
                email:         player.email,
                avatar:        player.avatar || DEFAULT_AVATAR,
                token_balance: parseInt(player.token_balance, 10),
            },
            jwt, // return the same token
            isNewPlayer: false,
        });
    });

    // ── RUN ───────────────────────────────────────────────────────────────────

    socket.on('run:join', async ({ jwt }) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            const run = await getActiveRun();
            if (!run) {
                socket.emit('run:join_error', { message: 'No active run right now.' });
                return;
            }

            // Check existing membership
            const existing = await db.query(
                'SELECT * FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );

            let isNewJoiner = false;
            if (existing.rows.length === 0) {
                // Deduct buy-in
                if (parseInt(player.token_balance, 10) < BUY_IN) {
                    socket.emit('run:join_error', { message: 'Not enough tokens for the buy-in.' });
                    return;
                }
                await db.query(
                    'UPDATE players SET token_balance = token_balance - $1 WHERE id = $2',
                    [BUY_IN, player.id]
                );
                await db.query(
                    'INSERT INTO run_players (run_id, player_id) VALUES ($1, $2)',
                    [run.id, player.id]
                );
                // 80% of buy-in seeds prize pool
                await db.query(
                    'UPDATE runs SET prize_pool = prize_pool + $1 WHERE id = $2',
                    [Math.floor(BUY_IN * 0.8), run.id]
                );
                isNewJoiner = true;
            }

            socket.join(`run:${run.id}`);
            socket.runId   = run.id;
            socket.playerId = player.id;

            // Fetch everything the client needs to rebuild its state
            const [buildingsResult, playersResult, updatedPlayer, freshRun] = await Promise.all([
                db.query(
                    `SELECT b.*, p.username AS owner_name
                     FROM buildings b
                     JOIN players p ON p.id = b.player_id
                     WHERE b.run_id = $1 AND b.is_active = TRUE`,
                    [run.id]
                ),
                db.query(
                    `SELECT p.id, p.username, p.avatar, p.token_balance, rp.joined_at
                     FROM run_players rp
                     JOIN players p ON p.id = rp.player_id
                     WHERE rp.run_id = $1`,
                    [run.id]
                ),
                db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]),
                db.query('SELECT * FROM runs WHERE id = $1', [run.id]),
            ]);

            socket.emit('run:state', {
                run:         freshRun.rows[0],
                buildings:   buildingsResult.rows,
                players:     playersResult.rows,
                yourWallet:  parseInt(updatedPlayer.rows[0].token_balance, 10),
                isNewJoiner,
            });

            if (isNewJoiner) {
                socket.to(`run:${run.id}`).emit('run:player_joined', {
                    player: { id: player.id, username: player.username, avatar: player.avatar || DEFAULT_AVATAR },
                });
            }
        });
    });

    // ── BUILDINGS ─────────────────────────────────────────────────────────────

    socket.on('building:place', async ({ jwt, cellId, type }) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            // Validate inputs
            if (typeof cellId !== 'number' || cellId < 0 || cellId > 399) {
                socket.emit('building:place_error', { message: 'Invalid cell.' });
                return;
            }
            if (!VALID_TYPES.includes(type)) {
                socket.emit('building:place_error', { message: 'Invalid building type.' });
                return;
            }

            const cost = BUILDING_COSTS[type];
            const run  = await getActiveRun();
            if (!run) {
                socket.emit('building:place_error', { message: 'No active run.' });
                return;
            }

            // Must be enrolled in the run
            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('building:place_error', { message: 'You are not in this run.' });
                return;
            }

            // Cell must be empty
            const occupied = await db.query(
                'SELECT id FROM buildings WHERE run_id = $1 AND cell_id = $2 AND is_active = TRUE',
                [run.id, cellId]
            );
            if (occupied.rows.length > 0) {
                socket.emit('building:place_error', { message: 'That cell is already occupied.' });
                return;
            }

            // Wallet check
            if (parseInt(player.token_balance, 10) < cost) {
                socket.emit('building:place_error', { message: 'Not enough tokens.' });
                return;
            }

            // Silo: requires at least one completed reactor
            if (type === 'silo') {
                const reactors = await db.query(
                    `SELECT id FROM buildings
                     WHERE run_id = $1 AND player_id = $2 AND type = 'plant' AND is_active = TRUE`,
                    [run.id, player.id]
                );
                if (reactors.rows.length === 0) {
                    socket.emit('building:place_error', { message: 'Build a Reactor first before placing a Silo.' });
                    return;
                }
            }

            // All clear — deduct and place
            await db.query(
                'UPDATE players SET token_balance = token_balance - $1 WHERE id = $2',
                [cost, player.id]
            );
            const buildResult = await db.query(
                'INSERT INTO buildings (run_id, player_id, type, cell_id) VALUES ($1, $2, $3, $4) RETURNING *',
                [run.id, player.id, type, cellId]
            );
            const newWallet = parseInt(player.token_balance, 10) - cost;

            // Broadcast the new building to everyone in the run
            io.to(`run:${run.id}`).emit('building:placed', {
                building:  buildResult.rows[0],
                ownerName: player.username,
                placedBy:  player.id,
            });

            // Send authoritative wallet balance back to the placing player only
            socket.emit('player:wallet_update', { token_balance: newWallet });
        });
    });

    // ── SABOTAGE ──────────────────────────────────────────────────────────────

    socket.on('sabotage:execute', async ({ jwt, cellId, attackType }) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            const VALID_ATTACKS = ['disable', 'steal', 'nuke'];
            if (!VALID_ATTACKS.includes(attackType)) {
                socket.emit('error', { message: 'Invalid attack type.' });
                return;
            }
            if (typeof cellId !== 'number' || cellId < 0 || cellId > 399) {
                socket.emit('error', { message: 'Invalid cell.' });
                return;
            }

            const run = await getActiveRun();
            if (!run) {
                socket.emit('error', { message: 'No active run.' });
                return;
            }

            // Must be enrolled
            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('error', { message: 'You are not in this run.' });
                return;
            }

            // Target must be an enemy building at that cell
            const targetResult = await db.query(
                `SELECT b.*, p.username AS owner_name
                 FROM buildings b
                 JOIN players p ON p.id = b.player_id
                 WHERE b.run_id = $1 AND b.cell_id = $2 AND b.is_active = TRUE AND b.player_id != $3`,
                [run.id, cellId, player.id]
            );
            if (targetResult.rows.length === 0) {
                socket.emit('error', { message: 'No enemy building at that cell.' });
                return;
            }
            const target = targetResult.rows[0];

            // Calculate cost
            const bal = parseInt(player.token_balance, 10);
            let cost;
            if (attackType === 'disable') cost = 300;
            else if (attackType === 'steal') cost = 500;
            else cost = Math.floor(bal * 0.5); // nuke = 50% of wallet

            if (bal < cost) {
                socket.emit('error', { message: 'Not enough tokens for this attack.' });
                return;
            }

            // Deduct cost
            await db.query(
                'UPDATE players SET token_balance = token_balance - $1 WHERE id = $2',
                [cost, player.id]
            );

            // Log event
            await db.query(
                'INSERT INTO sabotage_events (run_id, attacker_id, target_cell_id, attack_type, cost) VALUES ($1,$2,$3,$4,$5)',
                [run.id, player.id, cellId, attackType, cost]
            );

            const payload = {
                attackType,
                cellId,
                attackerId:   player.id,
                attackerName: player.username,
            };

            if (attackType === 'disable') {
                const disableUntil = new Date(Date.now() + 45000);
                await db.query(
                    'UPDATE buildings SET disabled_until = $1 WHERE id = $2',
                    [disableUntil, target.id]
                );
                payload.disableUntil = disableUntil.toISOString();

            } else if (attackType === 'steal') {
                // Uranium steal is a client-side resource: just report the amount
                payload.stolenAmount = Math.floor(25 + Math.random() * 50);

            } else if (attackType === 'nuke') {
                // Destroy all enemy buildings within Manhattan distance 4
                const allEnemyBuildings = await db.query(
                    'SELECT * FROM buildings WHERE run_id = $1 AND is_active = TRUE AND player_id != $2',
                    [run.id, player.id]
                );
                const destroyed = [];
                for (const b of allEnemyBuildings.rows) {
                    if (gridDist(b.cell_id, cellId) <= 4) {
                        await db.query(
                            'UPDATE buildings SET is_active = FALSE, destroyed_at = NOW() WHERE id = $1',
                            [b.id]
                        );
                        destroyed.push(b.cell_id);
                    }
                }
                payload.destroyedCells  = destroyed;
                payload.falloutRadius   = 4;
                payload.falloutDuration = 120000; // ms — clients animate fallout locally
            }

            // Broadcast to entire run room (everyone sees the attack)
            io.to(`run:${run.id}`).emit('sabotage:applied', payload);
            socket.emit('player:wallet_update', { token_balance: bal - cost });
        });
    });

    // ── INCOME SYNC ───────────────────────────────────────────────────────────
    // Clients periodically report their locally-simulated income so the server
    // wallet stays roughly up to date between building purchases.
    socket.on('player:income_sync', async ({ jwt, income }) => {
        if (typeof income !== 'number' || income < 0 || income > 100000) return; // ignore nonsense
        await requireAuth(socket, jwt, async (decoded, player) => {
            await db.query(
                'UPDATE players SET token_balance = token_balance + $1 WHERE id = $2',
                [Math.floor(income), player.id]
            );
        });
    });

    // ── USERNAME RENAME ───────────────────────────────────────────────────────
    socket.on('player:rename', async ({ jwt, username, avatar }) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            if (!username || typeof username !== 'string') {
                socket.emit('player:rename_error', { message: 'Invalid username.' });
                return;
            }
            const clean = username.trim();
            const cleanAvatar = normalizeAvatar(avatar);
            if (clean.length < 3 || clean.length > 20) {
                socket.emit('player:rename_error', { message: 'Username must be 3–20 characters.' });
                return;
            }
            if (!/^[a-zA-Z0-9_]+$/.test(clean)) {
                socket.emit('player:rename_error', { message: 'Only letters, numbers, and underscores allowed.' });
                return;
            }
            // Check uniqueness
            const taken = await db.query(
                'SELECT id FROM players WHERE username = $1 AND id != $2',
                [clean, player.id]
            );
            if (taken.rows.length > 0) {
                socket.emit('player:rename_error', { message: 'Username already taken.' });
                return;
            }

            const oldUsername = player.username;
            await db.query('UPDATE players SET username = $1, avatar = $2 WHERE id = $3', [clean, cleanAvatar, player.id]);
            const updatedPlayer = { ...player, username: clean, avatar: cleanAvatar };
            const refreshedJwt = generateJWT(updatedPlayer);

            socket.emit('player:rename_success', { username: clean, avatar: cleanAvatar, jwt: refreshedJwt });

            const run = await getActiveRun();
            if (run) {
                io.to(`run:${run.id}`).emit('run:player_updated', {
                    playerId: player.id,
                    oldUsername,
                    username: clean,
                    avatar: cleanAvatar,
                });
            }
        });
    });
}

module.exports = { registerHandlers };
