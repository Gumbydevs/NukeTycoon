-- Nuclear Tycoon database schema
-- Run this once against your Railway Postgres DB:
--   psql $DATABASE_URL -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Players ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT UNIQUE NOT NULL,
    username        TEXT UNIQUE NOT NULL,
    avatar          TEXT DEFAULT '☢️',
    token_balance   BIGINT DEFAULT 50000,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar TEXT DEFAULT '☢️';
-- Password fields for password-based login (optional)
ALTER TABLE players ADD COLUMN IF NOT EXISTS password_salt TEXT;
ALTER TABLE players ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- ── Email login codes (one-time, 10-min expiry) ───────────────────────────────
CREATE TABLE IF NOT EXISTS auth_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN DEFAULT FALSE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes(email, used);

-- ── Runs (a run = 8 real-time days, cycles automatically) ────────────────────
CREATE TABLE IF NOT EXISTS runs (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_number                INTEGER NOT NULL,
    current_day               INTEGER DEFAULT 1,
    run_length                INTEGER DEFAULT 8,
    prize_pool                BIGINT DEFAULT 0,
    market_price              DOUBLE PRECISION DEFAULT 1,
    market_prev_price         DOUBLE PRECISION DEFAULT 1,
    market_token_pool         DOUBLE PRECISION DEFAULT 1000,
    market_token_pool_initial DOUBLE PRECISION DEFAULT 1000,
    tokens_issued             BIGINT DEFAULT 0,
    tokens_burned             BIGINT DEFAULT 0,
    total_token_supply        BIGINT DEFAULT 1000000000,
    day_duration_ms           BIGINT DEFAULT 86400000,
    next_day_at               TIMESTAMPTZ NOT NULL,
    status                    TEXT DEFAULT 'active',   -- 'active' | 'ended'
    ended_at                  TIMESTAMPTZ,
    created_at                TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS market_price DOUBLE PRECISION DEFAULT 1;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS market_prev_price DOUBLE PRECISION DEFAULT 1;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS market_token_pool DOUBLE PRECISION DEFAULT 1000;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS market_token_pool_initial DOUBLE PRECISION DEFAULT 1000;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS tokens_issued BIGINT DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS tokens_burned BIGINT DEFAULT 0;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS total_token_supply BIGINT DEFAULT 1000000000;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS day_duration_ms BIGINT DEFAULT 86400000;

-- ── Players enrolled in a run ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS run_players (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id      UUID NOT NULL REFERENCES runs(id),
    player_id   UUID NOT NULL REFERENCES players(id),
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    final_rank  INTEGER,
    payout      BIGINT DEFAULT 0,
    UNIQUE(run_id, player_id)
);

-- ── Buildings placed on the grid ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS buildings (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                UUID NOT NULL REFERENCES runs(id),
    player_id             UUID NOT NULL REFERENCES players(id),
    type                  TEXT NOT NULL,          -- mine | processor | storage | plant | silo
    cell_id               INTEGER NOT NULL,       -- 0-399 (20x20 grid)
    construction_ends_at  TIMESTAMPTZ,
    is_active             BOOLEAN DEFAULT TRUE,
    disabled_until        TIMESTAMPTZ,            -- set by 'disable' sabotage
    placed_at             TIMESTAMPTZ DEFAULT NOW(),
    destroyed_at          TIMESTAMPTZ,
    UNIQUE(run_id, cell_id)                       -- one building per cell per run
);
ALTER TABLE buildings ADD COLUMN IF NOT EXISTS construction_ends_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_buildings_run_cell   ON buildings(run_id, cell_id);
CREATE INDEX IF NOT EXISTS idx_buildings_run_player ON buildings(run_id, player_id, is_active);

-- ── Per-player state that used to live only on the client ────────────────────
CREATE TABLE IF NOT EXISTS run_player_state (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id              UUID NOT NULL REFERENCES runs(id),
    player_id           UUID NOT NULL REFERENCES players(id),
    uranium_raw         DOUBLE PRECISION DEFAULT 0,
    uranium_refined     DOUBLE PRECISION DEFAULT 0,
    max_storage         DOUBLE PRECISION DEFAULT 5000,
    daily_produced      DOUBLE PRECISION DEFAULT 0,
    daily_income        BIGINT DEFAULT 0,
    last_income         BIGINT DEFAULT 0,
    score               DOUBLE PRECISION DEFAULT 0,
    strikes_used_today  INTEGER DEFAULT 0,
    used_nuke           BOOLEAN DEFAULT FALSE,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(run_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_run_player_state_run_player ON run_player_state(run_id, player_id);

-- ── Persistent fallout / radiation zones ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS fallout_zones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES runs(id),
    created_by      UUID REFERENCES players(id),
    center_cell_id  INTEGER NOT NULL,
    radius          INTEGER NOT NULL DEFAULT 5,
    multiplier      DOUBLE PRECISION DEFAULT 0.5,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fallout_zones_run_expires ON fallout_zones(run_id, expires_at);

-- ── Sabotage event log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sabotage_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES runs(id),
    attacker_id     UUID NOT NULL REFERENCES players(id),
    target_cell_id  INTEGER,
    attack_type     TEXT NOT NULL,   -- disable | steal | nuke
    cost            BIGINT NOT NULL,
    executed_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Global server config (key/value, persists across restarts) ───────────────
CREATE TABLE IF NOT EXISTS server_config (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── Economy snapshots (one per game-day, used for historical charts) ──────────
CREATE TABLE IF NOT EXISTS economy_snapshots (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id            UUID NOT NULL REFERENCES runs(id),
    run_day           INTEGER NOT NULL,
    snapshot_at       TIMESTAMPTZ DEFAULT NOW(),
    market_price      DOUBLE PRECISION,
    market_prev_price DOUBLE PRECISION,
    prize_pool        BIGINT,
    total_players     INTEGER,
    total_buildings   INTEGER,
    tokens_issued     BIGINT,
    market_token_pool DOUBLE PRECISION,
    building_counts   JSONB DEFAULT '{}',
    player_snapshots  JSONB DEFAULT '[]',
    UNIQUE(run_id, run_day)
);
CREATE INDEX IF NOT EXISTS idx_economy_snapshots_run ON economy_snapshots(run_id, run_day);

-- ── All-time market records (persist across runs) ─────────────────────────────
CREATE TABLE IF NOT EXISTS alltime_market_records (
    stat_key    TEXT PRIMARY KEY,
    value       DOUBLE PRECISION NOT NULL DEFAULT 0,
    run_number  INTEGER,
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── All-time player bests (persist across runs) ───────────────────────────────
CREATE TABLE IF NOT EXISTS alltime_player_bests (
    player_id           UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    best_balance        BIGINT DEFAULT 0,
    best_daily_income   BIGINT DEFAULT 0,
    best_rank           INTEGER DEFAULT 99999,
    total_runs          INTEGER DEFAULT 0,
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);
