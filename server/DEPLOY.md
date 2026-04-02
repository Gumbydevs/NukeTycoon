

## 3. Add a PostgreSQL database

1. In the Railway dashboard, open your new project
2. **+ New** → **Database** → **PostgreSQL**
3. Railway links it automatically and exposes `$DATABASE_URL`

---

## 4. Run the schema migration

```bash
# Get your DATABASE_URL from Railway → postgres service → Variables tab
# Then run once locally (or from Railway shell):
psql "$DATABASE_URL" -f schema.sql
```

---

## 5. Set environment variables

In Railway → your service → **Variables**, add:

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | (auto-set by Railway when you link Postgres) |
| `JWT_SECRET` | any random 64-char string — `openssl rand -hex 32` |
| `RESEND_API_KEY` | your Resend API key |
| `EMAIL_FROM` | `Nuclear Tycoon <noreply@yourdomain.com>` |
| `CLIENT_ORIGIN` | URL where your frontend is hosted (e.g. `https://nuketycoon.up.railway.app`) |
| `DAY_DURATION_MS` | `86400000` for 24hr days; use `60000` (1 min) for testing |

> Do not create a `PORT` variable in Railway. Railway injects its own internal port automatically, and overriding it can stop the app from responding.

---

## 6. Trigger a deploy

1. Push any commit to your GitHub repo's default branch:
   ```bash
   git add .
   git commit -m "add server"
   git push
   ```
2. Railway detects the push and redeploys automatically
3. Watch the build log in the Railway dashboard — it should end with `Server listening on port 3001`
4. Note your public URL from **Settings → Domains** (looks like `https://nuketycoon-server-production-xxxx.railway.app`)

---

## 7. Update the frontend SERVER_URL

Open `game.js` and update line 5:

```js
const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001'
    : 'https://YOUR-NUKETYCOON-SERVER.railway.app'; // ← paste your Railway URL here
```

---

## 8. Host the frontend

The frontend is plain HTML/JS — deploy it anywhere static:

**Option A — Railway static service**
```bash
# From repo root
railway up        # after linking frontend folder as a separate service
```

**Option B — GitHub Pages**
```bash
git push origin main
# Enable Pages in repo Settings → Pages → branch: main / root
```

**Option C — serve locally for testing**
```bash
cd d:\Code_Playground\NukeTycoon
npx serve .       # or python -m http.server 8080
```

---

## 9. Local development

```bash
# Terminal 1 — server
cd server
cp .env.example .env      # fill in your values
npm install
npm run dev               # starts with --watch (auto-reload)

# Terminal 2 — frontend
cd ..
npx serve .               # serve static files on http://localhost:3000
```

Visit http://localhost:3000 — the game will connect to the server on port 3001.

> **Tip:** Set `DAY_DURATION_MS=60000` in your local `.env` so days advance every 60 seconds while testing.

---

## Run lifecycle

- The server auto-creates **Run #1** on first boot if no active run exists.
- Days advance every `DAY_DURATION_MS` milliseconds (default 24 hours).
- When a run's `current_day` exceeds `run_length` (default 8), the run ends:
  - Top 3 players by score receive **50% / 30% / 20%** of the prize pool.
  - A new run starts **8 seconds later** automatically.
- Players can join mid-run at any time; buy-in is 5 000 tokens.

---

## Scoring formula

```
score = (reactor_count × 100) + (mine_count × 50) + floor(wallet / 1000)
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Login code never arrives | Check `RESEND_API_KEY` and `EMAIL_FROM` in Railway vars |
| `ECONNREFUSED` on client | `SERVER_URL` points to wrong host/port |
| `JWT malformed` errors | `JWT_SECRET` env var missing or different between deploys |
| `duplicate key` on building place | Cell already occupied — harmless, server returns `building:place_error` |
| Schema migration errors | Run `psql $DATABASE_URL -f schema.sql` again; `IF NOT EXISTS` makes it safe to re-run |
