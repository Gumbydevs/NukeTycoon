const { sendOTP, verifyOTP, verifyJWT, generateJWT, signupWithPassword, loginWithPassword } = require('../auth');
const db = require('../db');
const { getActiveRun, getRunSnapshot, ensureRunPlayerState, BUILDING_RULES, getBuyIn, getBuildSlots, getMarketPoolBurnRate, getGridSize, getSabotageConfig, getNukeConfig, detonateNukeLaunch, getProductionConfig, emitRunSnapshot, getSurveyorConfig, getDepositsForRun, getBalanceConfig } = require('../gameLoop');

const DEFAULT_AVATAR = '☢️';
const VALID_AVATARS = new Set(['☢️', '🧑‍🚀', '👩‍🔬', '👨‍🔬', '🤖', '🦊', '🐺', '🐉']);
const normalizeAvatar = (avatar) => VALID_AVATARS.has(avatar) ? avatar : DEFAULT_AVATAR;
// VALID_TYPES is static (the set of building type keys never changes at runtime)
const VALID_TYPES = Object.keys(BUILDING_RULES);
// Do NOT snapshot costs here — always read BUILDING_RULES[type].cost live so
// admin changes via /admin/api/set-building-config are reflected immediately.

// Manhattan distance using current grid columns (runtime-configurable)
function gridDist(a, b) {
    const cols = (typeof getGridSize === 'function' && getGridSize().cols) ? getGridSize().cols : 20;
    return Math.abs((a % cols) - (b % cols)) + Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
}

// Strip tilde (~), hyphen-minus (-), en-dash (–) and em-dash (—) from notification text
function sanitizeNotificationText(text) {
    if (!text || typeof text !== 'string') return text;
    // remove the characters, collapse whitespace, and trim
    return text.replace(/[~\-\u2013\u2014]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Insert a warning notification into the DB for every player currently
 * enrolled in a run, excluding the attacker. Used for run-wide alerts
 * (e.g. nuke incoming) so offline players see it on relog.
 */
async function notifyAllRunPlayers(runId, attackerId, type, msg, extraPayload = {}) {
    try {
        const playersRes = await db.query(
            `SELECT rp.player_id, p.email
             FROM run_players rp
             JOIN players p ON p.id = rp.player_id
             WHERE rp.run_id = $1`,
            [runId]
        );
        for (const row of playersRes.rows) {
            if (row.player_id === attackerId) continue; // attacker doesn't need an alert about their own nuke
            try {
                const email = (row.email || '').toLowerCase();
                await db.query(
                    `INSERT INTO notifications (run_id, player_id, email, type, payload)
                     VALUES ($1,$2,$3,$4,$5)`,
                    [runId, row.player_id, email, type,
                     JSON.stringify({ msg, ...extraPayload, ts: Date.now() })]
                );
            } catch (_) { /* non-critical per-player */ }
        }
    } catch (e) {
        console.warn('[notifyAllRunPlayers] failed:', e.message);
    }
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

async function emitRunEconomy(io, runId) {
    if (!runId) return;

    const snapshot = await getRunSnapshot(runId);
    if (!snapshot?.run) return;

    io.to(`run:${runId}`).emit('run:economy_update', {
        runId: snapshot.run.id,
        day: snapshot.run.current_day,
        runLength: snapshot.run.run_length,
        prizePool: parseInt(snapshot.run.prize_pool, 10) || 0,
        scores: snapshot.scores,
        nuclearThreats: snapshot.nuclearThreats,
    });

    const stateByPlayer = new Map(snapshot.playerStates.map((state) => [state.player_id, state]));
    const playerById = new Map(snapshot.players.map((player) => [player.id, player]));
    const sockets = await io.in(`run:${runId}`).fetchSockets();
    sockets.forEach((roomSocket) => {
        roomSocket.emit('run:tick', {
            run: snapshot.run,
            scores: snapshot.scores,
            playerState: stateByPlayer.get(roomSocket.playerId) || null,
            yourWallet: parseInt(playerById.get(roomSocket.playerId)?.token_balance, 10) || 0,
            falloutZones: snapshot.falloutZones,
            nuclearThreats: snapshot.nuclearThreats,
        });
    });
}

function registerHandlers(io, socket) {
    // ── BUILDING DEMOLISH ─────────────────────────────────────────────
    socket.on('building:demolish', async ({ jwt, cellId }, ack) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            // Validate input
            if (typeof cellId !== 'number' || cellId < 0 || cellId > 399) {
                socket.emit('building:demolish_error', { message: 'Invalid cell.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Invalid cell.' });
                return;
            }
            const run = await getActiveRun();
            if (!run) {
                socket.emit('building:demolish_error', { message: 'No active run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No active run.' });
                return;
            }
            // Must be enrolled in the run
            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('building:demolish_error', { message: 'You are not in this run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not in run.' });
                return;
            }
            // Find the building
            const buildingRes = await db.query(
                'SELECT * FROM buildings WHERE run_id = $1 AND cell_id = $2 AND player_id = $3 AND is_active = TRUE',
                [run.id, cellId, player.id]
            );
            if (buildingRes.rows.length === 0) {
                socket.emit('building:demolish_error', { message: 'No owned building at that cell.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No owned building at cell.' });
                return;
            }
            const building = buildingRes.rows[0];
            // Only allow demolish if not under construction (or allow refund if under construction)
            const now = Date.now();
            const isUnderConstruction = building.construction_ends_at && new Date(building.construction_ends_at).getTime() > now;
            let refund = 0;
            if (isUnderConstruction) {
                // Partial refund for canceling construction — configurable
                const pct = (getSabotageConfig && getSabotageConfig().maintenanceRefundPct) || 0.75;
                refund = Math.floor((BUILDING_RULES[building.type]?.cost || 0) * pct);
            }
            // Deactivate building
            await db.query(
                'UPDATE buildings SET is_active = FALSE, destroyed_at = NOW() WHERE id = $1',
                [building.id]
            );
            // Refund if applicable
            if (refund > 0) {
                await db.query(
                    'UPDATE players SET token_balance = token_balance + $1 WHERE id = $2',
                    [refund, player.id]
                );
            }
            // Broadcast update
            io.to(`run:${run.id}`).emit('building:demolished', {
                cellId,
                playerId: player.id,
                refund,
            });
            // Send wallet update
            if (refund > 0) {
                const walletRes = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
                socket.emit('player:wallet_update', { token_balance: parseInt(walletRes.rows[0]?.token_balance, 10) || 0 });
            }
            await emitRunEconomy(io, run.id);
            if (typeof ack === 'function') ack({ ok: true, refund });
        });
    });

    // ── BUILDING CANCEL QUEUE ─────────────────────────────────────────
    socket.on('building:cancel_queue', async ({ jwt, cellId }, ack) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            // Validate input
            if (typeof cellId !== 'number' || cellId < 0 || cellId > 399) {
                socket.emit('building:cancel_queue_error', { message: 'Invalid cell.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Invalid cell.' });
                return;
            }
            const run = await getActiveRun();
            if (!run) {
                socket.emit('building:cancel_queue_error', { message: 'No active run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No active run.' });
                return;
            }
            // Must be enrolled in the run
            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('building:cancel_queue_error', { message: 'You are not in this run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not in run.' });
                return;
            }
            // First, check server-side queue entries for this cell
            const qRes = await db.query('SELECT * FROM build_queue WHERE run_id = $1 AND cell_id = $2 AND player_id = $3', [run.id, cellId, player.id]);
            if (qRes.rows.length > 0) {
                // Remove queue entry and refund full cost
                const q = qRes.rows[0];
                await db.query('DELETE FROM build_queue WHERE id = $1', [q.id]);
                const refund = Math.floor((BUILDING_RULES[q.type]?.cost || 0));
                await db.query('UPDATE players SET token_balance = token_balance + $1 WHERE id = $2', [refund, player.id]);
                io.to(`run:${run.id}`).emit('building:queue_cancelled', {
                    cellId,
                    playerId: player.id,
                    refund,
                });
                const walletRes = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
                socket.emit('player:wallet_update', { token_balance: parseInt(walletRes.rows[0]?.token_balance, 10) || 0 });
                await emitRunEconomy(io, run.id);
                if (typeof ack === 'function') ack({ ok: true, refund });
                return;
            }
            // Find the building (must be under construction)
            const buildingRes = await db.query(
                'SELECT * FROM buildings WHERE run_id = $1 AND cell_id = $2 AND player_id = $3 AND is_active = TRUE',
                [run.id, cellId, player.id]
            );
            if (buildingRes.rows.length === 0) {
                socket.emit('building:cancel_queue_error', { message: 'No owned building at that cell.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No owned building at cell.' });
                return;
            }
            const building = buildingRes.rows[0];
            const now = Date.now();
            const isUnderConstruction = building.construction_ends_at && new Date(building.construction_ends_at).getTime() > now;
            if (!isUnderConstruction) {
                socket.emit('building:cancel_queue_error', { message: 'Building is not under construction.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not under construction.' });
                return;
            }
            // Refund most of the cost
            const pct = (getSabotageConfig && getSabotageConfig().maintenanceRefundPct) || 0.75;
            const refund = Math.floor((BUILDING_RULES[building.type]?.cost || 0) * pct);
            // Deactivate building
            await db.query(
                'UPDATE buildings SET is_active = FALSE, destroyed_at = NOW() WHERE id = $1',
                [building.id]
            );
            // Refund
            await db.query(
                'UPDATE players SET token_balance = token_balance + $1 WHERE id = $2',
                [refund, player.id]
            );
            // Broadcast update
            io.to(`run:${run.id}`).emit('building:queue_cancelled', {
                cellId,
                playerId: player.id,
                refund,
            });
            // Send wallet update
            const walletRes = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
            socket.emit('player:wallet_update', { token_balance: parseInt(walletRes.rows[0]?.token_balance, 10) || 0 });
            await emitRunEconomy(io, run.id);
            if (typeof ack === 'function') ack({ ok: true, refund });
        });
    });

    // ── AUTH ─────────────────────────────────────────────────────────────────

    socket.on('auth:request', async ({ email }, ack) => {
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            const msg = 'Enter a valid email address.';
            socket.emit('auth:error', { message: msg });
            if (typeof ack === 'function') ack({ ok: false, error: msg });
            return;
        }
        try {
            const result = await sendOTP(email.toLowerCase().trim());
            if (!result.ok) {
                socket.emit('auth:error', { message: result.error });
                if (typeof ack === 'function') ack({ ok: false, error: result.error });
                return;
            }
            // Include dev OTP when provided by sendOTP (fallback case)
            const payload = { email: email.toLowerCase().trim() };
            if (result && result.code) payload.devCode = result.code;
            socket.emit('auth:code_sent', payload);
            if (typeof ack === 'function') ack({ ok: true, code: result?.code });
        } catch (err) {
            console.error('auth:request error:', err);
            const msg = 'Could not send code. Try again.';
            socket.emit('auth:error', { message: msg });
            if (typeof ack === 'function') ack({ ok: false, error: msg });
        }
    });

    socket.on('auth:verify', async ({ email, code }, ack) => {
        if (!email || !code) {
            const msg = 'Email and code are required.';
            socket.emit('auth:error', { message: msg });
            if (typeof ack === 'function') ack({ ok: false, error: msg });
            return;
        }
        try {
            const result = await verifyOTP(email.toLowerCase().trim(), code.toString().trim());
            if (!result.ok) {
                socket.emit('auth:error', { message: result.error });
                if (typeof ack === 'function') ack({ ok: false, error: result.error });
                return;
            }
            socket.playerId = result.player.id;
            socket.emit('auth:success', {
                player: {
                    id:            result.player.id,
                    username:      result.player.username,
                    email:         result.player.email,
                    avatar:        result.player.avatar || DEFAULT_AVATAR,
                    avatar_photo:  result.player.avatar_photo || null,
                    token_balance: parseInt(result.player.token_balance, 10),
                },
                jwt: result.token,
                isNewPlayer: !!result.isNewPlayer,
            });
            if (typeof ack === 'function') ack({ ok: true, isNewPlayer: !!result.isNewPlayer });
        } catch (err) {
            console.error('auth:verify error:', err);
            const msg = 'Verification failed. Try again.';
            socket.emit('auth:error', { message: msg });
            if (typeof ack === 'function') ack({ ok: false, error: msg });
        }
    });

    // Password signup/login (alternative to email OTP)
    socket.on('auth:signup_password', async ({ email, password, username }, ack) => {
        try {
            const res = await signupWithPassword(email, password, username);
            if (!res.ok) {
                socket.emit('auth:error', { message: res.error });
                if (typeof ack === 'function') ack({ ok: false, error: res.error });
                return;
            }
            socket.playerId = res.player.id;
            socket.emit('auth:success', {
                player: {
                    id: res.player.id,
                    username: res.player.username,
                    email: res.player.email,
                    avatar: res.player.avatar || DEFAULT_AVATAR,
                    avatar_photo:  res.player.avatar_photo || null,
                    token_balance: parseInt(res.player.token_balance, 10),
                },
                jwt: res.token,
                isNewPlayer: true,
            });
            if (typeof ack === 'function') ack({ ok: true });
        } catch (err) {
            console.error('auth:signup_password error:', err);
            const msg = 'Signup failed. Try again.';
            socket.emit('auth:error', { message: msg });
            if (typeof ack === 'function') ack({ ok: false, error: msg });
        }
    });

    socket.on('auth:login_password', async ({ email, password }, ack) => {
        try {
            const res = await loginWithPassword(email, password);
            if (!res.ok) {
                socket.emit('auth:error', { message: res.error });
                if (typeof ack === 'function') ack({ ok: false, error: res.error });
                return;
            }
            socket.playerId = res.player.id;
            socket.emit('auth:success', {
                player: {
                    id: res.player.id,
                    username: res.player.username,
                    email: res.player.email,
                    avatar: res.player.avatar || DEFAULT_AVATAR,
                    avatar_photo:  res.player.avatar_photo || null,
                    token_balance: parseInt(res.player.token_balance, 10),
                },
                jwt: res.token,
                isNewPlayer: !!res.isNewPlayer,
            });
            if (typeof ack === 'function') ack({ ok: true });
        } catch (err) {
            console.error('auth:login_password error:', err);
            const msg = 'Login failed. Try again.';
            socket.emit('auth:error', { message: msg });
            if (typeof ack === 'function') ack({ ok: false, error: msg });
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
                avatar_photo:  player.avatar_photo || null,
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

            // Check existing membership — do NOT auto-deduct; buy-in confirmation is a
            // separate event (run:confirm_buyin) so the lobby can be shown first.
            const existing = await db.query(
                'SELECT * FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            const isNewJoiner = existing.rows.length === 0;

            socket.join(`run:${run.id}`);
            socket.runId = run.id;
            socket.playerId = player.id;

            // Only create/ensure player state row for players who have paid
            if (!isNewJoiner) {
                await ensureRunPlayerState(run.id, player.id);
            }

            const snapshot = await getRunSnapshot(run.id);
            const meState = isNewJoiner ? null : ((snapshot?.playerStates || []).find((row) => row.player_id === player.id) || null);
            const mePlayer = (snapshot?.players || []).find((row) => row.id === player.id);
            const normalizedEmail = String(player.email || '').trim().toLowerCase();

            // Backfill missed chat notifications for anything that happened while this player was offline.
            try {
                const backfillRes = await db.query(
                    `INSERT INTO notifications (run_id, player_id, email, type, payload, read, created_at)
                     SELECT $1, $2, $3, 'chat',
                            jsonb_build_object(
                                'id', cm.id,
                                'from', COALESCE(cm.username, 'Unknown'),
                                'text', COALESCE(cm.text, ''),
                                'gifUrl', cm.gif_url,
                                'ts', cm.ts
                            ),
                            FALSE,
                            TO_TIMESTAMP(cm.ts / 1000.0)
                     FROM chat_messages cm
                     WHERE cm.run_id = $1
                       AND cm.player_id <> $2
                       AND TO_TIMESTAMP(cm.ts / 1000.0) > COALESCE($4::timestamptz, to_timestamp(0))
                       AND NOT EXISTS (
                           SELECT 1
                           FROM notifications n
                           WHERE n.player_id = $2
                             AND n.type = 'chat'
                             AND n.payload->>'id' = cm.id
                       )`,
                    [run.id, player.id, normalizedEmail, player.last_seen_at || null]
                );
                console.log(`[run:join] backfilled ${backfillRes.rowCount || 0} chat notifications for player=${player.id}`);
            } catch (err) {
                console.warn('notification backfill failed:', err.message);
            }

            // Fetch recent chat and notifications for this player.
            const chatRes = await db.query('SELECT * FROM chat_messages WHERE run_id = $1 ORDER BY ts ASC LIMIT 200', [run.id]);
            const notesRes = await db.query(
                'SELECT id, type, payload, created_at, read FROM notifications WHERE (LOWER(email) = LOWER($1) OR player_id = $2) ORDER BY created_at ASC',
                [normalizedEmail, player.id]
            );
            try {
                const sample = (notesRes.rows || []).slice(0, 8).map(r => ({ id: r.id, created_at: r.created_at, read: r.read, payloadType: typeof r.payload }));
                console.log(`[run:join] notifications for player=${player.id} email=${normalizedEmail} count=${notesRes.rows.length} sample=`, sample);
            } catch (e) {
                console.warn('run:join notification log failed:', e && e.message);
            }
            // Only return queued entries that do NOT have an active building at the same cell.
            const queueRes = await db.query(
                `SELECT q.cell_id, q.type, q.queued_at, q.player_id
                 FROM build_queue q
                 LEFT JOIN buildings b ON b.run_id = q.run_id AND b.cell_id = q.cell_id AND b.is_active = TRUE
                 WHERE q.run_id = $1 AND b.id IS NULL
                 ORDER BY q.queued_at ASC`,
                [run.id]
            );

            // Normalize DB rows to client-friendly keys (camelCase) so historical
            // chat messages match the live `chat:message` payload shape.
            const chatRows = (chatRes.rows || []).map((r) => ({
                id: r.id,
                run_id: r.run_id,
                runId: r.run_id,
                player_id: r.player_id,
                playerId: r.player_id,
                username: r.username,
                avatar: r.avatar,
                avatar_photo: r.avatar_photo,
                avatarPhoto: r.avatar_photo || null,
                text: r.text,
                gif_url: r.gif_url,
                gifUrl: r.gif_url,
                ts: r.ts,
            }));

            socket.emit('run:state', {
                run: snapshot?.run,
                buildings: snapshot?.buildings || [],
                players: snapshot?.players || [],
                scores: snapshot?.scores || [],
                playerState: meState,
                falloutZones: snapshot?.falloutZones || [],
                nuclearThreats: snapshot?.nuclearThreats || [],
                yourWallet: parseInt(mePlayer?.token_balance ?? player.token_balance, 10) || 0,
                isNewJoiner,
                serverTime: Date.now(),
                terrain: snapshot?.terrain || null,
                deposits: (() => {
                    const allDeps = snapshot?.deposits || [];
                    const discovered = new Set(meState?.discovered_deposits || []);
                    return allDeps.filter(d => discovered.has(d.cellId));
                })(),
                surveyors: (snapshot?.surveyors || []).map(sv => ({
                    id: sv.id,
                    playerId: sv.player_id,
                    cellId: sv.cell_id,
                    expiresAt: sv.expires_at,
                })),
                chatMessages: chatRows,
                notifications: (notesRes.rows || []).map((n) => {
                    const out = Object.assign({}, n);
                    try {
                        const payload = (typeof n.payload === 'string') ? JSON.parse(n.payload) : n.payload;
                        if (payload && typeof payload.msg === 'string') {
                            payload.msg = sanitizeNotificationText(payload.msg);
                        }
                        out.payload = payload;
                    } catch (e) { /* leave as-is if parsing fails */ }
                    return out;
                }),
                buildQueue: queueRes.rows || [],
                surveyorConfig: getSurveyorConfig(),
            });
            await db.query('UPDATE players SET last_seen_at = NOW() WHERE id = $1', [player.id]);
            // Always send current building rules so tooltips/costs are accurate
            socket.emit('run:building_config', { buildingRules: BUILDING_RULES, surveyorConfig: getSurveyorConfig() });
        });
    });

    // Player confirmed buy-in from the lobby — deduct tokens and enter the run.
    socket.on('run:confirm_buyin', async ({ jwt }) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            const run = await getActiveRun();
            if (!run) {
                socket.emit('run:join_error', { message: 'No active run right now.' });
                return;
            }

            // Idempotent: if they somehow already paid, just start them
            const existing = await db.query(
                'SELECT * FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (existing.rows.length > 0) {
                socket.emit('run:buyin_ok', {
                    yourWallet: parseInt(player.token_balance, 10) || 0,
                });
                return;
            }

            // Deduct buy-in
            if (parseInt(player.token_balance, 10) < getBuyIn()) {
                socket.emit('run:join_error', { message: 'Not enough tokens for the buy-in.' });
                return;
            }
            await db.query(
                'UPDATE players SET token_balance = token_balance - $1 WHERE id = $2',
                [getBuyIn(), player.id]
            );
            await db.query(
                'INSERT INTO run_players (run_id, player_id) VALUES ($1, $2)',
                [run.id, player.id]
            );
            // 80% of buy-in seeds prize pool
            const prizeAdd = Math.floor(getBuyIn() * 0.8);
            const retained = Math.floor(getBuyIn() * 0.2);
            await db.query(
                `UPDATE runs
                 SET prize_pool = prize_pool + $1,
                     platform_fee_collected = COALESCE(platform_fee_collected,0) + $2,
                     market_token_pool = GREATEST(1, market_token_pool - $3)
                 WHERE id = $4`,
                [prizeAdd, retained, Math.floor(getBuyIn() * 0.2) / getMarketPoolBurnRate(), run.id]
            );

            socket.runId = run.id;
            socket.playerId = player.id;
            await ensureRunPlayerState(run.id, player.id);

            // Re-fetch fresh wallet balance after deduction
            const playerRow = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
            const freshWallet = parseInt(playerRow.rows[0]?.token_balance, 10) || 0;

            socket.emit('run:buyin_ok', { yourWallet: freshWallet });

            // Broadcast this new player to everyone else in the room
            const snapshot = await getRunSnapshot(run.id);
            const mePlayer = (snapshot?.players || []).find((row) => row.id === player.id);
            socket.to(`run:${run.id}`).emit('run:player_joined', {
                player: {
                    id: player.id,
                    username: player.username,
                    avatar: player.avatar || DEFAULT_AVATAR,
                    avatar_photo: player.avatar_photo || null,
                    token_balance: freshWallet,
                    total_buildings: 0,
                    plant_count: 0,
                    mine_count: 0,
                    processor_count: 0,
                    joined_at: new Date().toISOString(),
                },
            });
            await emitRunEconomy(io, run.id);
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

            const cost = BUILDING_RULES[type].cost;
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
                     WHERE run_id = $1
                       AND player_id = $2
                       AND type = 'plant'
                       AND is_active = TRUE
                       AND (construction_ends_at IS NULL OR construction_ends_at <= NOW())`,
                    [run.id, player.id]
                );
                if (reactors.rows.length === 0) {
                    socket.emit('building:place_error', { message: 'Build a completed Reactor first before placing a Silo.' });
                    return;
                }
            }

            // Construction limit: 1 building under construction at a time
            const activeConstruction = await db.query(
                `SELECT id FROM buildings
                 WHERE run_id = $1
                   AND player_id = $2
                   AND is_active = TRUE
                   AND construction_ends_at > NOW()`,
                [run.id, player.id]
            );
            if (activeConstruction.rows.length >= getBuildSlots()) {
                socket.emit('building:place_error', {
                    message: 'Construction slot busy — wait for the current build to finish.',
                    code: 'CONSTRUCTION_LIMIT',
                });
                return;
            }

            // All clear — deduct and place (use UPSERT to avoid unique constraint
            // failures when an older destroyed row exists for the same run+cell).
            await ensureRunPlayerState(run.id, player.id);
            try {
                await db.query('UPDATE players SET token_balance = token_balance - $1 WHERE id = $2', [cost, player.id]);
                const constructionEndsAt = new Date(Date.now() + (BUILDING_RULES[type]?.constructionMs || 0));
                const buildResult = await db.query(
                    `INSERT INTO buildings (run_id, player_id, type, cell_id, construction_ends_at, placed_at, is_active, destroyed_at)
                     VALUES ($1, $2, $3, $4, $5, NOW(), TRUE, NULL)
                     ON CONFLICT (run_id, cell_id) DO UPDATE SET
                         player_id = EXCLUDED.player_id,
                         type = EXCLUDED.type,
                         construction_ends_at = EXCLUDED.construction_ends_at,
                         is_active = TRUE,
                         destroyed_at = NULL,
                         placed_at = NOW()
                     RETURNING *`,
                    [run.id, player.id, type, cellId, constructionEndsAt]
                );

                const prizeContribution = Math.floor(cost * 0.10);
                await db.query(
                    `UPDATE runs
                     SET prize_pool = prize_pool + $1,
                         tokens_burned = tokens_burned + $2,
                         market_token_pool = GREATEST(1, market_token_pool - $3)
                     WHERE id = $4`,
                    [prizeContribution, cost, cost / getMarketPoolBurnRate(), run.id]
                );

                // Fetch authoritative wallet balance after deduction
                const walletRes = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
                const newWallet = parseInt(walletRes.rows[0]?.token_balance, 10) || 0;

                // Broadcast the new building to everyone in the run
                io.to(`run:${run.id}`).emit('building:placed', {
                    building: buildResult.rows[0],
                    ownerName: player.username,
                    placedBy: player.id,
                });

                // If there was a queued entry for this cell, remove it now so clients
                // don't render a ghost for a cell that the server considers built.
                try {
                    await db.query('DELETE FROM build_queue WHERE run_id = $1 AND cell_id = $2', [run.id, cellId]);
                } catch (e) {
                    console.warn('Failed to cleanup build_queue after placement:', e && e.message);
                }

                // Send authoritative wallet balance back to the placing player only
                socket.emit('player:wallet_update', { token_balance: newWallet });
                await emitRunEconomy(io, run.id);
            } catch (err) {
                console.error('building:place failed:', err && (err.stack || err.message || err));
                socket.emit('building:place_error', { message: 'Server error placing building.' });
                return;
            }
        });
    });

    // ── BUILDING QUEUE ADD (server-side queuing) ──────────────────────────
    socket.on('building:queue', async ({ jwt, cellId, type }, ack) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            if (typeof cellId !== 'number' || cellId < 0 || cellId > 399) {
                socket.emit('building:queue_error', { message: 'Invalid cell.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Invalid cell.' });
                return;
            }
            if (!VALID_TYPES.includes(type)) {
                socket.emit('building:queue_error', { message: 'Invalid building type.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Invalid type.' });
                return;
            }
            const run = await getActiveRun();
            if (!run) {
                socket.emit('building:queue_error', { message: 'No active run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No active run.' });
                return;
            }

            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('building:queue_error', { message: 'You are not in this run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not in run.' });
                return;
            }

            // Cell must not be occupied
            const occupied = await db.query(
                'SELECT id FROM buildings WHERE run_id = $1 AND cell_id = $2 AND is_active = TRUE',
                [run.id, cellId]
            );
            if (occupied.rows.length > 0) {
                socket.emit('building:queue_error', { message: 'That cell is already occupied.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Cell occupied.' });
                return;
            }

            // Ensure not already queued for this cell
            const alreadyQ = await db.query('SELECT id FROM build_queue WHERE run_id = $1 AND cell_id = $2', [run.id, cellId]);
            if (alreadyQ.rows.length > 0) {
                socket.emit('building:queue_error', { message: 'Cell already queued.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Already queued.' });
                return;
            }

            // Wallet check and deduct immediately (server-side authoritative)
            const cost = BUILDING_RULES[type].cost;
            const playerRow = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
            const balance = parseInt(playerRow.rows[0]?.token_balance, 10) || 0;
            if (balance < cost) {
                socket.emit('building:queue_error', { message: 'Not enough tokens.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not enough tokens.' });
                return;
            }

            // Deduct cost and contribute to prize pool / burn tokens (same as place)
            await db.query('UPDATE players SET token_balance = token_balance - $1 WHERE id = $2', [cost, player.id]);
            const prizeContribution = Math.floor(cost * 0.10);
            await db.query(
                `UPDATE runs
                 SET prize_pool = prize_pool + $1,
                     tokens_burned = tokens_burned + $2,
                     market_token_pool = GREATEST(1, market_token_pool - $3)
                 WHERE id = $4`,
                [prizeContribution, cost, cost / getMarketPoolBurnRate(), run.id]
            );

            // Insert queue row
            await db.query(
                'INSERT INTO build_queue (run_id, player_id, cell_id, type) VALUES ($1,$2,$3,$4)',
                [run.id, player.id, cellId, type]
            );

            // Broadcast queued ghost to room (clients will render ghost for queue)
            io.to(`run:${run.id}`).emit('building:queued', {
                cellId,
                playerId: player.id,
                type,
            });

            // Send authoritative wallet back to player
            const walletRes = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
            socket.emit('player:wallet_update', { token_balance: parseInt(walletRes.rows[0]?.token_balance, 10) || 0 });
            await emitRunEconomy(io, run.id);
            if (typeof ack === 'function') ack({ ok: true });
        });
    });

    // ── SURVEYOR HIRE ─────────────────────────────────────────────────────────

    socket.on('surveyor:hire', async ({ jwt, cellId }, ack) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            if (typeof cellId !== 'number' || cellId < 0 || cellId > 399) {
                socket.emit('surveyor:error', { message: 'Invalid cell.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Invalid cell.' });
                return;
            }
            const run = await getActiveRun();
            if (!run) {
                socket.emit('surveyor:error', { message: 'No active run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No active run.' });
                return;
            }
            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('surveyor:error', { message: 'You are not in this run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not in run.' });
                return;
            }
            const { cost, durationMs, discoverRadius } = getSurveyorConfig();
            const bal = parseInt(player.token_balance, 10) || 0;
            if (bal < cost) {
                socket.emit('surveyor:error', { message: `Not enough tokens (need ${cost}, have ${bal}).` });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not enough tokens.' });
                return;
            }

            // Deduct cost and insert surveyor row
            await db.query('UPDATE players SET token_balance = token_balance - $1 WHERE id = $2', [cost, player.id]);
            const expiresAt = new Date(Date.now() + durationMs);
            const svRes = await db.query(
                'INSERT INTO surveyors (run_id, player_id, cell_id, expires_at) VALUES ($1,$2,$3,$4) RETURNING id, cell_id, expires_at',
                [run.id, player.id, cellId, expiresAt]
            );
            const sv = svRes.rows[0];

            // Immediate discovery around the starting cell
            try {
                const allDeposits = getDepositsForRun(run.id) || [];
                const cols = getGridSize().cols || 20;
                const ax = cellId % cols, ay = Math.floor(cellId / cols);
                const nearbyIds = allDeposits
                    .filter(d => {
                        const bx = d.cellId % cols, by = Math.floor(d.cellId / cols);
                        return Math.max(Math.abs(ax - bx), Math.abs(ay - by)) <= discoverRadius;
                    })
                    .map(d => d.cellId);
                if (nearbyIds.length > 0) {
                    await db.query(
                        `UPDATE run_player_state
                         SET discovered_deposits = (
                             SELECT jsonb_agg(DISTINCT elem::int)
                             FROM jsonb_array_elements(
                                 COALESCE(discovered_deposits, '[]'::jsonb) || $1::jsonb
                             ) AS elem
                         )
                         WHERE run_id = $2 AND player_id = $3`,
                        [JSON.stringify(nearbyIds), run.id, player.id]
                    );
                }
            } catch (e) {
                console.warn('[surveyor:hire] initial discovery failed:', e && e.message);
            }

            // Confirm to the hiring player
            socket.emit('surveyor:placed', { surveyorId: sv.id, cellId: sv.cell_id, expiresAt: sv.expires_at });
            const walletRes = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
            socket.emit('player:wallet_update', { token_balance: parseInt(walletRes.rows[0]?.token_balance, 10) || 0 });

            // Broadcast updated snapshot so all players see the surveyor and the hiring
            // player's visible deposits update
            await emitRunSnapshot(io, run.id, 'run:tick');
            if (typeof ack === 'function') ack({ ok: true });
        });
    });

    // ── SABOTAGE ──────────────────────────────────────────────────────────────

    // ── NUKE MANUFACTURE ─────────────────────────────────────────────────────
    // Player initiates manufacture of one nuke in their silo. Free to start
    // (silo maintenance already represents the running cost). One manufacture
    // at a time per player. Completion is handled by processNukeManufactures
    // in the game tick so it survives server restarts.
    socket.on('nuke:manufacture', async ({ jwt }, ack) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            const run = await getActiveRun();
            if (!run) {
                socket.emit('error', { message: 'No active run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No active run.' });
                return;
            }
            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('error', { message: 'You are not in this run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not in run.' });
                return;
            }
            // Must have a completed silo; fetch all to count total capacity
            const siloRes = await db.query(
                `SELECT id FROM buildings
                 WHERE run_id = $1 AND player_id = $2 AND type = 'silo' AND is_active = TRUE
                   AND (construction_ends_at IS NULL OR construction_ends_at <= NOW())`,
                [run.id, player.id]
            );
            if (siloRes.rows.length === 0) {
                socket.emit('error', { message: 'A completed Silo is required to manufacture nukes.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No completed silo.' });
                return;
            }
            const siloId = siloRes.rows[0].id;
            const siloCount = siloRes.rows.length;
            // Check inventory not already at total cap (per-silo capacity × number of silos)
            const nukeCfg = getNukeConfig();
            const maxPerSilo = nukeCfg.maxInventory || 3;
            const totalCap = siloCount * maxPerSilo;
            const invRes = await db.query(
                'SELECT nuke_inventory FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            const currentInventory = parseInt(invRes.rows[0]?.nuke_inventory, 10) || 0;
            if (currentInventory >= totalCap) {
                const siloLabel = siloCount > 1 ? `${siloCount} silos hold` : 'Silo holds';
                socket.emit('error', { message: `Silo full. ${siloLabel} max ${totalCap} nuke(s) (${maxPerSilo} per silo).` });
                if (typeof ack === 'function') ack({ ok: false, error: 'Silo full.' });
                return;
            }
            // Check not already manufacturing
            const inProgressRes = await db.query(
                'SELECT id FROM nuke_manufacture WHERE run_id = $1 AND player_id = $2 AND completes_at > NOW()',
                [run.id, player.id]
            );
            if (inProgressRes.rows.length > 0) {
                socket.emit('error', { message: 'Already manufacturing a nuke. Wait for it to complete.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Already manufacturing.' });
                return;
            }
            const manufactureMs = nukeCfg.manufactureMs || 120000;
            const manufactureCost = nukeCfg.manufactureCost || 0;
            // Deduct manufacture cost from player's wallet
            if (manufactureCost > 0) {
                const walletCheck = await db.query('SELECT token_balance FROM players WHERE id = $1', [player.id]);
                const balance = parseInt(walletCheck.rows[0]?.token_balance, 10) || 0;
                if (balance < manufactureCost) {
                    socket.emit('error', { message: `Insufficient tokens. Manufacture costs ${manufactureCost} tokens.` });
                    if (typeof ack === 'function') ack({ ok: false, error: 'Insufficient tokens.' });
                    return;
                }
                await db.query('UPDATE players SET token_balance = token_balance - $1 WHERE id = $2', [manufactureCost, player.id]);
                socket.emit('player:wallet_update', { token_balance: balance - manufactureCost });
            }
            const completesAt = new Date(Date.now() + manufactureMs);
            await db.query(
                `INSERT INTO nuke_manufacture (run_id, player_id, silo_id, completes_at)
                 VALUES ($1, $2, $3, $4)`,
                [run.id, player.id, siloId, completesAt]
            );
            socket.emit('nuke:manufacture_started', { completesAt: completesAt.toISOString(), manufactureMs, manufactureCost });
            if (typeof ack === 'function') ack({ ok: true, completesAt: completesAt.toISOString() });
            console.log(`[nuke] manufacture started player=${player.username} completesAt=${completesAt.toISOString()}`);
        });
    });

    // ── NUKE LAUNCH (direct cell drop — any cell) ─────────────────────────────
    // Player fires a nuke from their inventory at any grid cell.
    socket.on('nuke:launch', async ({ jwt, targetCellId }, ack) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            if (typeof targetCellId !== 'number' || targetCellId < 0 || targetCellId > 399) {
                socket.emit('error', { message: 'Invalid target cell.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Invalid cell.' });
                return;
            }
            const run = await getActiveRun();
            if (!run) {
                socket.emit('error', { message: 'No active run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No active run.' });
                return;
            }
            const membership = await db.query(
                'SELECT id FROM run_players WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            if (membership.rows.length === 0) {
                socket.emit('error', { message: 'You are not in this run.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'Not in run.' });
                return;
            }
            await ensureRunPlayerState(run.id, player.id);
            const stateRes = await db.query(
                'SELECT nuke_inventory, last_nuke_fired_at FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            const inventory = parseInt(stateRes.rows[0]?.nuke_inventory, 10) || 0;
            if (inventory <= 0) {
                socket.emit('error', { message: 'No nukes in inventory. Manufacture one first.' });
                if (typeof ack === 'function') ack({ ok: false, error: 'No inventory.' });
                return;
            }
            // Cooldown check
            const nukeCfg = getNukeConfig();
            const cooldownMs = nukeCfg.launchCooldownMs || 0;
            if (cooldownMs > 0 && stateRes.rows[0]?.last_nuke_fired_at) {
                const lastFired = new Date(stateRes.rows[0].last_nuke_fired_at).getTime();
                const elapsed = Date.now() - lastFired;
                if (elapsed < cooldownMs) {
                    const secsRemaining = Math.ceil((cooldownMs - elapsed) / 1000);
                    socket.emit('error', { message: `Launch on cooldown. Try again in ${secsRemaining}s.` });
                    if (typeof ack === 'function') ack({ ok: false, error: 'Cooldown active.' });
                    return;
                }
            }
            // Decrement inventory and record fire time — launch is free; cost was already paid at manufacture time
            await db.query(
                'UPDATE run_player_state SET nuke_inventory = nuke_inventory - 1, last_nuke_fired_at = NOW(), updated_at = NOW() WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            const countdownMs = nukeCfg.countdownMs || 15000;
            const detonatesAt = new Date(Date.now() + countdownMs);
            const launchRes = await db.query(
                `INSERT INTO nuke_launches (run_id, attacker_id, attacker_name, attacker_avatar, attacker_photo, target_cell_id, detonates_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                [run.id, player.id, player.username, player.avatar || '\u2622\ufe0f', player.avatar_photo || null, targetCellId, detonatesAt]
            );
            const launchId = launchRes.rows[0].id;
            const incomingPayload = {
                id: launchId,
                attackerName:  player.username,
                attackerAvatar: player.avatar || '\u2622\ufe0f',
                attackerPhoto: player.avatar_photo || null,
                targetCellId,
                detonatesAt: detonatesAt.toISOString(),
                countdownMs,
            };
            io.to(`run:${run.id}`).emit('nuke:incoming', incomingPayload);
            // Persist nuke-incoming alert for every run player so offline players see it on relog
            notifyAllRunPlayers(
                run.id, player.id, 'danger',
                `☢️ ${player.username} launched a NUKE! Impact in ~${Math.round((nukeCfg.countdownMs || 15000) / 1000)}s.`,
                { attackerName: player.username, targetCellId, launchId, attackType: 'nuke' }
            );
            if (typeof ack === 'function') ack({ ok: true, launchId, detonatesAt: detonatesAt.toISOString() });
            // Schedule detonation
            setTimeout(async () => {
                try {
                    await detonateNukeLaunch(io, run, { id: launchId, attacker_id: player.id, attacker_name: player.username, target_cell_id: targetCellId });
                    await emitRunEconomy(io, run.id);
                } catch (e) { console.warn('[nuke] detonation timer error:', e.message); }
            }, countdownMs);
            console.log(`[nuke] launch queued player=${player.username} cell=${targetCellId} detonatesAt=${detonatesAt.toISOString()}`);
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

            // Calculate cost (runtime-configurable via server_config)
            const bal = parseInt(player.token_balance, 10);
            const sabotageCfg = (typeof getSabotageConfig === 'function') ? getSabotageConfig() : {};
            let cost;
            if (attackType === 'disable') cost = Math.floor(sabotageCfg.disableCost || 300);
            else if (attackType === 'steal') cost = Math.floor(sabotageCfg.stealCost || 500);
            else cost = Math.floor(bal * (sabotageCfg.nukeCostPct || 0.5)); // nuke = pct of wallet

            if (bal < cost) {
                socket.emit('error', { message: 'Not enough tokens for this attack.' });
                return;
            }

            await ensureRunPlayerState(run.id, player.id);
            const stateResult = await db.query(
                'SELECT strikes_used_today FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                [run.id, player.id]
            );
            const strikesUsedToday = parseInt(stateResult.rows[0]?.strikes_used_today, 10) || 0;

            if (attackType === 'nuke') {
                // Nuke requires inventory item
                await ensureRunPlayerState(run.id, player.id);
                const nukeInvRes = await db.query(
                    'SELECT nuke_inventory FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                    [run.id, player.id]
                );
                const nukeInv = parseInt(nukeInvRes.rows[0]?.nuke_inventory, 10) || 0;
                if (nukeInv <= 0) {
                    socket.emit('error', { message: 'No nukes in inventory. Manufacture one in your Silo first.' });
                    return;
                }
            }

            // Deduct cost
            await db.query(
                'UPDATE players SET token_balance = token_balance - $1 WHERE id = $2',
                [cost, player.id]
            );

            const prizeContribution = Math.floor(cost * 0.10);
            await db.query(
                `UPDATE runs
                 SET prize_pool = prize_pool + $1,
                     tokens_burned = tokens_burned + $2,
                     market_token_pool = GREATEST(1, market_token_pool - $3)
                 WHERE id = $4`,
                [prizeContribution, cost, cost / getMarketPoolBurnRate(), run.id]
            );

            // Log event
            await db.query(
                'INSERT INTO sabotage_events (run_id, attacker_id, target_cell_id, attack_type, cost) VALUES ($1,$2,$3,$4,$5)',
                [run.id, player.id, cellId, attackType, cost]
            );

            // Failure chance (configurable)
            const attackFailed = Math.random() < (sabotageCfg.failureChance || 0.15);

            const payload = {
                attackType,
                cellId,
                attackerId:        player.id,
                attackerName:      player.username,
                targetPlayerId:    target.player_id,
                targetPlayerName:  target.owner_name,
                targetBuildingType: target.type,
                cost,
                failed: attackFailed,
            };

            if (attackFailed) {
                // No real effect — just broadcast the failure and bail
                io.to(`run:${run.id}`).emit('sabotage:applied', payload);
                socket.emit('player:wallet_update', { token_balance: bal - cost });
                await emitRunEconomy(io, run.id);
                return;
            }

            if (attackType === 'disable') {
                const disableUntil = new Date(Date.now() + (sabotageCfg.disableDurationMs || 45000));
                await db.query(
                    'UPDATE buildings SET disabled_until = $1 WHERE id = $2',
                    [disableUntil, target.id]
                );
                payload.disableUntil = disableUntil.toISOString();

            } else if (attackType === 'steal') {
                await ensureRunPlayerState(run.id, target.player_id);
                const [attackerStateResult, targetStateResult] = await Promise.all([
                    db.query(
                        'SELECT uranium_raw, uranium_refined, max_storage FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                        [run.id, player.id]
                    ),
                    db.query(
                        'SELECT uranium_raw, uranium_refined, max_storage FROM run_player_state WHERE run_id = $1 AND player_id = $2',
                        [run.id, target.player_id]
                    ),
                ]);

                const attackerState = attackerStateResult.rows[0] || { uranium_raw: 0, uranium_refined: 0, max_storage: 5000 };
                const targetState = targetStateResult.rows[0] || { uranium_raw: 0, uranium_refined: 0, max_storage: 5000 };
                const requested = Math.floor(25 + Math.random() * 50);
                const attackerStored = Number(attackerState.uranium_raw || 0) + Number(attackerState.uranium_refined || 0);
                const attackerHeadroom = Math.max(0, Number(attackerState.max_storage || 5000) - attackerStored);
                const targetAvailable = Number(targetState.uranium_raw || 0) + Number(targetState.uranium_refined || 0);
                const stolenAmount = Math.max(0, Math.min(requested, attackerHeadroom, targetAvailable));

                let remaining = stolenAmount;
                const targetRaw = Number(targetState.uranium_raw || 0);
                const targetRefined = Number(targetState.uranium_refined || 0);
                const rawTaken = Math.min(targetRaw, remaining);
                remaining -= rawTaken;
                const refinedTaken = Math.min(targetRefined, remaining);

                await db.query(
                    `UPDATE run_player_state
                     SET uranium_raw = $1,
                         uranium_refined = $2,
                         updated_at = NOW()
                     WHERE run_id = $3 AND player_id = $4`,
                    [targetRaw - rawTaken, targetRefined - refinedTaken, run.id, target.player_id]
                );
                await db.query(
                    `UPDATE run_player_state
                     SET uranium_raw = uranium_raw + $1,
                         updated_at = NOW()
                     WHERE run_id = $2 AND player_id = $3`,
                    [stolenAmount, run.id, player.id]
                );

                payload.stolenAmount = stolenAmount;

            } else if (attackType === 'nuke') {
                // Decrement inventory and start countdown — actual blast fires after countdown
                await db.query(
                    'UPDATE run_player_state SET nuke_inventory = nuke_inventory - 1, updated_at = NOW() WHERE run_id = $1 AND player_id = $2',
                    [run.id, player.id]
                );
                const nukeCfg = getNukeConfig();
                const countdownMs = nukeCfg.countdownMs || 15000;
                const detonatesAt = new Date(Date.now() + countdownMs);
                const launchRes = await db.query(
                    `INSERT INTO nuke_launches (run_id, attacker_id, attacker_name, attacker_avatar, attacker_photo, target_cell_id, detonates_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                    [run.id, player.id, player.username, player.avatar || '\u2622\ufe0f', player.avatar_photo || null, cellId, detonatesAt]
                );
                const launchId = launchRes.rows[0].id;
                payload.launchId = launchId;
                payload.detonatesAt = detonatesAt.toISOString();
                payload.countdownMs = countdownMs;
                // Broadcast incoming alert to everyone NOW (before blast)
                io.to(`run:${run.id}`).emit('nuke:incoming', {
                    id: launchId,
                    attackerName:  player.username,
                    attackerAvatar: player.avatar || '\u2622\ufe0f',
                    attackerPhoto: player.avatar_photo || null,
                    targetCellId: cellId,
                    detonatesAt: detonatesAt.toISOString(),
                    countdownMs,
                });
                // Persist nuke-incoming alert for every run player so offline players see it on relog
                notifyAllRunPlayers(
                    run.id, player.id, 'danger',
                    `☢️ ${player.username} launched a NUKE! Impact in ~${Math.round((countdownMs || 15000) / 1000)}s.`,
                    { attackerName: player.username, targetCellId: cellId, launchId, attackType: 'nuke' }
                );
                socket.emit('player:wallet_update', { token_balance: bal - cost });
                await emitRunEconomy(io, run.id);
                // Schedule blast
                const capturedRun = run;
                setTimeout(async () => {
                    try {
                        await detonateNukeLaunch(io, capturedRun, { id: launchId, attacker_id: player.id, attacker_name: player.username, target_cell_id: cellId });
                        await emitRunEconomy(io, capturedRun.id);
                    } catch (e) { console.warn('[nuke] sabotage detonation timer error:', e.message); }
                }, countdownMs);
                return; // Skip the normal sabotage:applied broadcast for nukes
            }

            // Broadcast to entire run room (everyone sees the attack)
            io.to(`run:${run.id}`).emit('sabotage:applied', payload);
            socket.emit('player:wallet_update', { token_balance: bal - cost });

            // Persist a notification for the target player so they see it on relog
            try {
                const targetEmailRes = await db.query('SELECT email FROM players WHERE id = $1', [target.player_id]);
                const targetEmail = (targetEmailRes.rows[0]?.email || '').toLowerCase();
                const notifType = attackType === 'nuke' ? 'danger' : attackType === 'steal' ? 'warning' : 'warning';
                const notifMsg = attackType === 'nuke'
                    ? `☢️ You were NUKED by ${player.username}! Buildings near cell ${cellId} destroyed.`
                    : attackType === 'steal'
                    ? `🕵️ ${player.username} stole ${payload.stolenAmount || 0} uranium from you!`
                    : `⚡ ${player.username} disabled your building at cell ${cellId}.`;
                try {
                    const res = await db.query(
                        `INSERT INTO notifications (run_id, player_id, email, type, payload)
                         VALUES ($1,$2,$3,$4,$5)`,
                        [run.id, target.player_id, targetEmail, notifType, JSON.stringify({ msg: notifMsg, attackType, attackerName: player.username, cellId, ts: Date.now() })]
                    );
                    console.log(`[sabotage notify] inserted=${res.rowCount || 0} run=${run.id} to=${target.player_id} type=${notifType}`);
                } catch (err) {
                    console.warn('sabotage notification failed:', err.message);
                }
            } catch (err) {
                console.warn('sabotage notification failed:', err.message);
            }

            await emitRunEconomy(io, run.id);
        });
    });

    // ── INCOME SYNC ───────────────────────────────────────────────────────────
    // Legacy client packets are intentionally ignored now that run economy,
    // uranium, storage, and income all tick on the server.
    socket.on('player:income_sync', async () => {
        return;
    });

    // ── CHAT ─────────────────────────────────────────────────────────────────
    socket.on('chat:message', async ({ jwt, text, gifUrl }) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            // Must be in a run to chat
            if (!socket.runId) {
                socket.emit('chat:error', { message: 'Join a run to chat.' });
                return;
            }

            // Rate-limit: max 1 message per second per socket
            const now = Date.now();
            const last = socket._chatLastTs || 0;
            if (now - last < 1000) {
                socket.emit('chat:error', { message: 'Slow down.' });
                return;
            }
            socket._chatLastTs = now;

            // Sanitise text
            const cleanText = (typeof text === 'string') ? text.trim().slice(0, 200) : '';

            // Sanitise GIF URL — only allow known GIF CDN hostnames (giphy or tenor)
            let cleanGifUrl = null;
            if (typeof gifUrl === 'string' && gifUrl.length < 500) {
                if (/^https:\/\/(media\.giphy\.com|media\.tenor\.com)\/[A-Za-z0-9_\-/.%?=&]+\.gif$/i.test(gifUrl)) {
                    cleanGifUrl = gifUrl;
                }
            }

            if (!cleanText && !cleanGifUrl) return;

            const id = now.toString(36) + Math.random().toString(36).slice(2, 5);
            const payload = {
                id,
                playerId: player.id,
                username: player.username,
                avatar: player.avatar || DEFAULT_AVATAR,
                avatarPhoto: player.avatar_photo || null,
                text: cleanText,
                gifUrl: cleanGifUrl,
                ts: now,
            };

            // Persist chat message
            try {
                await db.query(
                    `INSERT INTO chat_messages (id, run_id, player_id, username, avatar, avatar_photo, text, gif_url, ts)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                    [id, socket.runId, player.id, player.username, player.avatar || DEFAULT_AVATAR, player.avatar_photo || null, cleanText, cleanGifUrl, now]
                );
            } catch (err) {
                console.warn('chat persist failed:', err.message);
            }

            io.to(`run:${socket.runId}`).emit('chat:message', payload);

            // Persist chat notifications for every other run member so they still exist after relog.
            try {
                const runPlayersRes = await db.query('SELECT player_id FROM run_players WHERE run_id = $1', [socket.runId]);
                const toNotify = runPlayersRes.rows.map(r => r.player_id).filter(pid => pid !== player.id);
                for (const pid of toNotify) {
                    const emailRes = await db.query('SELECT email FROM players WHERE id = $1', [pid]);
                    const email = (emailRes.rows[0]?.email || '').toLowerCase();
                    try {
                        const notifRes = await db.query(
                            `INSERT INTO notifications (run_id, player_id, email, type, payload)
                             VALUES ($1,$2,$3,$4,$5)`,
                            [socket.runId, pid, email, 'chat', JSON.stringify({ id, from: player.username, text: cleanText, gifUrl: cleanGifUrl, ts: now })]
                        );
                        console.log(`[chat notify] inserted=${notifRes.rowCount || 0} run=${socket.runId} to=${pid}`);
                    } catch (e) {
                        console.warn('chat notify failed:', e && e.message);
                    }
                }
            } catch (err) {
                console.warn('chat notify failed:', err.message);
            }
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

            socket.emit('player:rename_success', { username: clean, avatar: cleanAvatar, avatarPhoto: player.avatar_photo || null, jwt: refreshedJwt });

            const run = await getActiveRun();
            if (run) {
                io.to(`run:${run.id}`).emit('run:player_updated', {
                    playerId: player.id,
                    oldUsername,
                    username: clean,
                    avatar: cleanAvatar,
                    avatarPhoto: player.avatar_photo || null,
                });
            }
        });
    });

    // ── PHOTO UPLOAD ──────────────────────────────────────────────────────────
    socket.on('player:update_photo', async ({ jwt, photo }) => {
        await requireAuth(socket, jwt, async (decoded, player) => {
            // Validate: must be a data URL for a supported image type
            if (photo !== null) {
                if (typeof photo !== 'string') {
                    socket.emit('player:photo_error', { message: 'Invalid photo data.' });
                    return;
                }
                if (!photo.startsWith('data:image/jpeg;base64,') &&
                    !photo.startsWith('data:image/png;base64,') &&
                    !photo.startsWith('data:image/webp;base64,') &&
                    !photo.startsWith('data:image/gif;base64,')) {
                    socket.emit('player:photo_error', { message: 'Only JPEG, PNG, WebP, or GIF images are allowed.' });
                    return;
                }
                // Limit to ~700KB base64 (~500KB raw)
                if (photo.length > 700000) {
                    socket.emit('player:photo_error', { message: 'Photo must be under 500KB.' });
                    return;
                }
            }

            await db.query('UPDATE players SET avatar_photo = $1 WHERE id = $2', [photo || null, player.id]);

            socket.emit('player:photo_updated', { avatarPhoto: photo || null });

            const run = await getActiveRun();
            if (run) {
                io.to(`run:${run.id}`).emit('run:player_updated', {
                    playerId: player.id,
                    oldUsername: player.username,
                    username: player.username,
                    avatar: player.avatar || DEFAULT_AVATAR,
                    avatarPhoto: photo || null,
                });
            }
        });
    });

    socket.on('disconnect', async () => {
        if (!socket.playerId) return;
        try {
            await db.query('UPDATE players SET last_seen_at = NOW() WHERE id = $1', [socket.playerId]);
        } catch (err) {
            console.warn('last_seen update failed:', err.message);
        }
    });

    // ── Debug: return ALL deposits for the active run (bypasses fog-of-war filter)
    // Used by the client D+P debug overlay. Deposits are deterministically seeded from
    // run.id so this data is not truly secret, but it's kept behind a socket event
    // (requires an active socket connection = authenticated player in the run).
    socket.on('debug:all-deposits', async () => {
        try {
            const run = await getActiveRun();
            if (!run) { socket.emit('debug:all-deposits-response', { deposits: [], runId: null }); return; }
            const deposits = getDepositsForRun(run.id);
            const cfg = getBalanceConfig();
            const uniqueCells = new Set(deposits.map(d => d.cellId)).size;
            console.log(`[debug:all-deposits] run=${run.id} total=${deposits.length} unique=${uniqueCells} minClusters=${cfg.deposit.minClusters} maxExtra=${cfg.deposit.maxExtraClusters}`);
            socket.emit('debug:all-deposits-response', { deposits, runId: run.id, count: deposits.length, uniqueCells, minClusters: cfg.deposit.minClusters, maxExtraClusters: cfg.deposit.maxExtraClusters });
        } catch (e) {
            socket.emit('debug:all-deposits-response', { deposits: [], error: e.message });
        }
    });
}

module.exports = { registerHandlers };
