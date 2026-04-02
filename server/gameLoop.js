const db = require('./db');

const DAY_DURATION_MS = parseInt(process.env.DAY_DURATION_MS || '86400000', 10);
const RUN_LENGTH = 8;
const BUY_IN = 5000;

async function getActiveRun() {
    const result = await db.query(
        "SELECT * FROM runs WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
    );
    return result.rows[0] || null;
}

async function createNewRun() {
    const countResult = await db.query('SELECT COUNT(*) FROM runs');
    const runNumber = parseInt(countResult.rows[0].count, 10) + 1;
    const nextDayAt = new Date(Date.now() + DAY_DURATION_MS);

    const result = await db.query(
        `INSERT INTO runs (run_number, current_day, run_length, prize_pool, next_day_at, status)
         VALUES ($1, 1, $2, 0, $3, 'active') RETURNING *`,
        [runNumber, RUN_LENGTH, nextDayAt]
    );
    console.log(`🔥 New run #${runNumber} started (day duration: ${DAY_DURATION_MS}ms)`);
    return result.rows[0];
}

async function calculateScores(runId) {
    const result = await db.query(`
        SELECT
            rp.player_id,
            p.username,
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
        WHERE rp.run_id = $1
        GROUP BY rp.player_id, p.username, p.token_balance
        ORDER BY (
            COUNT(CASE WHEN b.type = 'plant' THEN 1 END) * 100 +
            COUNT(CASE WHEN b.type = 'mine'  THEN 1 END) * 50  +
            p.token_balance / 1000
        ) DESC
    `, [runId]);

    return result.rows.map(r => ({
        player_id:       r.player_id,
        username:        r.username,
        token_balance:   parseInt(r.token_balance, 10),
        plant_count:     r.plant_count,
        mine_count:      r.mine_count,
        processor_count: r.processor_count,
        total_buildings: r.total_buildings,
        score: r.plant_count * 100 + r.mine_count * 50 + Math.floor(parseInt(r.token_balance, 10) / 1000),
    }));
}

async function endRun(io, run) {
    const scores = await calculateScores(run.id);
    const shares = [0.50, 0.30, 0.20];
    const payouts = [];

    // Mark run ended first so no more day advances fire
    await db.query(
        "UPDATE runs SET status = 'ended', ended_at = NOW() WHERE id = $1",
        [run.id]
    );

    // Award top 3 players
    for (let i = 0; i < Math.min(3, scores.length); i++) {
        const p = scores[i];
        const award = Math.floor(run.prize_pool * shares[i]);
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
        payouts.push({ ...p, rank: i + 1, award });
    }

    console.log(`🏁 Run #${run.run_number} ended. Awarded ${payouts.length} players.`);

    io.to(`run:${run.id}`).emit('run:ended', {
        runNumber: run.run_number,
        scores,
        payouts,
    });

    // Start next run after a short pause
    setTimeout(async () => {
        try {
            const newRun = await createNewRun();
            // Broadcast to everyone (including those not in a room yet)
            io.emit('run:new', {
                runId:     newRun.id,
                runNumber: newRun.run_number,
            });
        } catch (err) {
            console.error('Failed to start new run:', err);
        }
    }, 8000);
}

async function advanceDay(io, run) {
    const newDay = run.current_day + 1;

    if (newDay > run.run_length) {
        await endRun(io, run);
        return;
    }

    const nextDayAt = new Date(Date.now() + DAY_DURATION_MS);
    await db.query(
        'UPDATE runs SET current_day = $1, next_day_at = $2 WHERE id = $3',
        [newDay, nextDayAt, run.id]
    );

    const scores = await calculateScores(run.id);
    io.to(`run:${run.id}`).emit('run:day_advanced', {
        day:       newDay,
        runLength: run.run_length,
        nextDayAt: nextDayAt.toISOString(),
        scores,
    });

    console.log(`📅 Run #${run.run_number} → day ${newDay} (next: ${nextDayAt.toISOString()})`);
}

function setupGameLoop(io) {
    // Check every 30 seconds whether a day needs to be advanced
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

    // Boot: ensure an active run exists
    setTimeout(async () => {
        try {
            const run = await getActiveRun();
            if (!run) {
                await createNewRun();
                console.log('Boot: no active run found, created one.');
            } else {
                console.log(`Boot: active run #${run.run_number}, day ${run.current_day}/${run.run_length}`);
            }
        } catch (err) {
            console.error('Boot run check error:', err);
        }
    }, 2000);
}

module.exports = { setupGameLoop, getActiveRun, calculateScores };
