# Nuclear Tycoon — What's Next Checklist

## What's Already Built (repo scan highlights)
- 20×20 grid with terrain (grass / dirt / road)
- 4 building types: Mine, Processor, Storage, Reactor
- Token wallet + building costs
- Resource loop implemented: `uraniumRaw` (mines) → `uraniumRefined` (processors) → plants consume refined fuel
- Proximity visual indicators (`bonus` / `penalty` CSS classes)
- Sabotage (destroy enemy building) — cost currently calculated as `buildingTypes[type].cost - 200`
- Simulated clock (round/day/hour/minute) and `productionTick()` running
- Market model and prize pool / bonding-curve logic
- End-of-day summary + leaderboard modal
- Dev panel (advance time) and password-gated dev login
- Tooltips show neighbor counts and bonus text
- Profile modal, mobile menu and responsive CSS

---

## Phase 1 — Core Gameplay (Make It Actually Work)

### Round & Day Management
- [x] **Rounds hooked to days** — Each day (1-N) now directly maps to a round (1-N). `game.runLength` (default 3) controls total run duration. When `game.time.day > game.runLength`, run ends.
- [x] **End-of-round (day) transition** — `onRoundEnd()` triggers between days. Distributes prizes and resets accumulators. Shows end-of-day summary modal for days 1 through runLength-1.
- [x] **Run end-of-run logic** — `onRunEnd()` triggers when `game.time.day > game.runLength`. Freezes grid, displays final leaderboard modal with champion and final scores. "Return to Menu" resets for next run.
- [x] **Event-driven run lengths** — `game.runLength` is adjustable (e.g., 3-day tournament, 16-day endurance mode). Should expose UI or config option for setup.

### Resource Chain
- [x] **Processor flow implemented** — `uraniumRaw` and `uraniumRefined` exist; `productionTick()` converts raw → refined per processor.
- [x] **Processing rate present** — processors convert a small amount per tick (configurable in code).
- [x] **Building construction times** — Each building type has a configurable `constructionTime` (mine: 8s, processor: 12s, storage: 10s, plant: 15s). Displays circular progress indicator while building; only completed buildings produce resources/power.
- [x] **Deposit-based mining** — Uranium deposits are randomly generated and visible on map with ⛰️ indicator. Mines on deposits: 1.5x yield, adjacent: 1.25x yield, distant: 0.3x yield. Hover shows deposit bonus info.
- [ ] **Storage overflow UX** — production caps correctly (`rawHeadroom` prevents overproduce) but no visual warning, animation, or "waste" counter UI. Hard cap silently discards overflow.

### Proximity Bonus
- [ ] **Apply numeric bonuses to production** — `calculateProximity()` adds CSS visual classes (`bonus`/`penalty`) but the actual multipliers are NOT wired into `calculatePower()`. Only enemy penalty (−20 per enemy) and road bonus (+40%) are active. Same-type buildings show +25% estimated in tooltips but do NOT boost production income. (TODO)
- [~] **Tooltip live numbers** — Tooltips calculate neighbor counts and display +25% per neighbor blurb, but the math is cosmetic—not used in `calculatePower()` or income calculation (partial).

### Sabotage Expansion
- [x] **Distinct sabotage options** — Sabotage menu with 3 attack types: ⏸️ Disable (−50% production 45s, $300), 💰 Steal (~50 uranium, $500), 💥 NUKE (AoE + fallout, requires silo, 50% wallet).
- [ ] **Distinct sabotage costs** — Current code uses specific costs per attack; differentiation complete.
- [ ] **Confirmation prompt** — Menu acts as confirmation UI; selection required before attack executes.
- [x] **Temporary disable** — Reduces enemy production by 50% for 45 seconds; tracked in `enemy.disabled` and cleaned up on day advance.

### Nuclear Arsenal (Endgame Sabotage)
> *Missile Silos are the ultimate power play, tied to the World War 3 theme. Building and launching them represents an existential threat.*

- [x] **Missile Silo building type** — 💥 icon, cost 6000 tokens, 3.5s construction. Red color, marked as weapon.
- [x] **Silo build mechanics** — Requires ≥1 completed reactor. Max 1 per round limit. Placement mechanics complete.
- [x] **Nuclear strike (ultimate sabotage)** — Accessed via Sabotage menu when silo completed. 4-cell AoE radius destroys enemy buildings. Applies −50% production fallout for 120s to nearby player buildings.
- [x] **Strike cost & cooldown** — Costs 50% of current wallet. 1 strike per round (dayStrikes <= maxSilosPerRound).
- [x] **Visual spectacle** — Red flash (600ms fadeOut animation), screen shake (10 frames). Fallout zones render with ⛰️ visual indicator and golden glow.
- [ ] **Audio spectacle** — No sound effects yet. (TODO: explosion/alarm sounds)
- [ ] **Leaderboard prestige** — Strikes tracked in `nuclearThreats` array but NOT displayed on final leaderboard. Badge or prestige display pending. (TODO: add "🔴 Nuclear Threat" badge to winning player if in threats list)

### AI Enemies
- [ ] **AI build loop** — Bots exist in `game.players` with `isBot: true`, but no autonomous build/sabotage loop runs. Only initial spawn via `spawnEnemyBuildings()` (5 random buildings per round).
- [ ] **AI sabotage / targeting** — Not implemented. Bots do not attack or build dynamically.
- [ ] **Enemy resource simulation** — Leaderboard computes estimated bot scores, but bots do not track or spend wallet tokens.

### Leaderboard & Rank
- [ ] **Live rank** — `#rank` element exists in HTML but is **never updated during play** (hardcoded to `#1`); only computed at round end in `distributePrizePool()`. Should update per production tick. (TODO)
- [~] **End-of-round distribution** — `distributePrizePool()` computes final scores and awards prizes, but round advancement logic is incomplete. (See Phase 1 Core Gameplay below.)

---

## Phase 2 — Polish & Balance

### Balance Pass
- [ ] **Tune the resource chain ratios** — How many mines does it take to feed one reactor continuously? Test and document the target (e.g., 2 mines → 1 processor → 1 reactor = sustainable loop).
- [ ] **Proximity bonus cap** — Decide the max stack (GDD mentions 25% per neighbor but doesn't cap it). Prevent infinite clustering exploit.
- [ ] **Enemy leech intensity** — 20% drain per nearby enemy building might be too brutal or not enough. Play-test and adjust.
- [ ] **Sabotage cost vs build cost balance** — Should attacking always feel expensive? Run scenarios to ensure no dominant "all-attack" or "all-turtle" strategy.

### UI / UX
- [ ] **Building placement preview** — Highlight (ghost) the cell you're about to place on before clicking. Reduce misclicks.
- [ ] **Visual range indicator** — When hovering a building cell, show which cells fall within proximity range (shaded overlay on the 2-cell radius).
- [ ] **Income/loss animations** — Flash "+120" in green or "−800" in red near the top bar when tokens are gained/spent.
- [ ] **Sound design** — Simple audio: build placement click, sabotage boom, market price up/down chime. muted by default.
- [ ] **Responsive layout on mobile** — Top bar wraps badly on small screens. Properly collapse stats into the mobile menu drawer.
- [ ] **Colour-code enemy buildings by owner** — Right now all enemies are grey. Give PHANTOM_IX and NEUTRON_ distinct accent colors so you know who is who at a glance.

### Game Feel
- [ ] **Building destruction animation** — When sabotage lands, animate the cell (flash red, brief shake) instead of just blanking it.
- [ ] **Day transition overlay** — Brief full-screen "Day 3" overlay when the day rolls over. Makes the 8-day timeline feel real.
- [ ] **Market chart** — Small sparkline in the top bar or a modal showing market price history over the current round.

---

## Phase 3 — Real Money (Blockchain Integration)

> *These tasks belong to Keegan + Matt. Do not start until Phase 1 is fully play-tested.*

-- [ ] **Phantom wallet connect** — UI placeholder exists (`walletConnections`) but no `window.solana` integration found.
-- [ ] **Token contract on Solana** — Not started.
-- [ ] **Entry fee flow / payout / anti-cheat** — Backend & on-chain flows are design-only; client contains `buyIn` and prize logic but server-side/stateful enforcement is not implemented.

---

## Phase 4 — Expansion (Post-Launch)

-- [ ] **Player trading** — Let players sell refined fuel or processor capacity to each other mid-round.
- [ ] **Cosmetics** — Grid skins, building skins, profile badges. Zero pay-to-win.
- [ ] **Seasons / season pass** — Rotating round themes, map hazards (e.g., radiation zones that damage nearby buildings).
- [ ] **Advanced destruction fallout system** — Expand Phase 1 nuke strikes with persistent radiation damage zones, multi-stage explosions, and fallout clouds that spread over time. Adds strategic depth to strike placement and cleanup tactics.
- [ ] **Guilds / alliances** — Players team up to share resources or coordinate attacks (e.g., coordinated strike damage multiplier).
- [ ] **Spectator mode** — Watch a live round in progress (great for social/streaming).

---

## Immediate Next Action (Priority Order)

### Critical Path (Blocks playable round progression) — ✅ DONE
1. ✅ **Rounds hooked to days (round 1-8 = day 1-8):** Implemented. `game.round` now syncs to `game.time.day`.
2. ✅ **Round 8 end-of-run logic:** Implemented. `onRunEnd()` shows final leaderboard and allows return to menu.
3. ✅ **End-of-round (day) transition UI:** Implemented. `onRoundEnd()` handles prize distribution; end-of-day modal shows each transition.

### Phase 1 Core (Make the game feel alive) — NEXT UP
4. **Nuclear Arsenal (Missile Silos):** Build Phase 1 nuke strike mechanics to tie WW3 theme into gameplay and give players a "show of power" moment. This is the ultimate sabotage tool.
5. **Apply proximity % to production:** Wire same-type +25% per neighbor into `calculatePower()` so production multiplier actually works.
6. **Enemy AI build loop:** Add periodic function to spawn/sabotage bot buildings (e.g., every 10 ticks pick a random bot, roll for action).

### Polish (Enhances feel)
7. **Live rank per tick:** Update `#rank` element each `productionTick()` from sorted `game.players`.
8. **Storage overflow UX:** Flash or animate when uranium hits capacity; show lost uranium counter.

Once the critical path is confirmed working via play-test, move to Phase 1 Core items.
