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
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_number  INTEGER NOT NULL,
    current_day INTEGER DEFAULT 1,
    run_length  INTEGER DEFAULT 8,
    prize_pool  BIGINT DEFAULT 0,
    next_day_at TIMESTAMPTZ NOT NULL,
    status      TEXT DEFAULT 'active',   -- 'active' | 'ended'
    ended_at    TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

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
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES runs(id),
    player_id       UUID NOT NULL REFERENCES players(id),
    type            TEXT NOT NULL,          -- mine | processor | storage | plant | silo
    cell_id         INTEGER NOT NULL,       -- 0-399 (20x20 grid)
    is_active       BOOLEAN DEFAULT TRUE,
    disabled_until  TIMESTAMPTZ,            -- set by 'disable' sabotage
    placed_at       TIMESTAMPTZ DEFAULT NOW(),
    destroyed_at    TIMESTAMPTZ,
    UNIQUE(run_id, cell_id)                 -- one building per cell per run
);
CREATE INDEX IF NOT EXISTS idx_buildings_run_cell   ON buildings(run_id, cell_id);
CREATE INDEX IF NOT EXISTS idx_buildings_run_player ON buildings(run_id, player_id, is_active);

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
