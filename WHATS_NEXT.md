# Nuclear Tycoon — What's Next Checklist

## What's Already Built
- 20×20 grid with terrain (grass / dirt / road)
- 4 building types: Mine, Processor, Storage, Reactor
- Token wallet + building costs
- Basic resource loop: mines produce uranium → reactors consume it → generate income
- Proximity bonus / enemy penalty **visual indicators** on cells
- Sabotage (destroy an enemy building for a token cost)
- Simulated clock (8-day round, day/hour/minute)
- Fluctuating market price with supply/demand + diurnal model
- End-of-day summary modal with basic leaderboard
- Dev panel (advance time, sim speed)
- Password-gated dev login
- Tooltips on buildings and buttons
- Profile modal, mobile menu

---

## Phase 1 — Core Gameplay (Make It Actually Work)

### Resource Chain Fixes
- [ ] **Processor bottleneck** — Processors don't do anything right now. Raw uranium from mines should pile up unrefined and be unusable until a processor converts it. Reactors should only consume *refined* fuel. Add a `refinedFuel` counter separate from raw `uranium`.
- [ ] **Processing rate** — Each processor should convert X raw uranium → refined fuel per tick. Balance so having no processor totally blocks reactor output.
- [ ] **Storage overflow consequence** — Uranium currently just caps silently. Show a visual warning and log a "waste" counter so players feel the cost of no storage.

### Proximity Bonus — Make It Real Numbers
- [ ] **Actually apply the % bonus to output** — Right now `bonus` and `penalty` CSS classes are set but the % modifier is never used in `calculatePower()` or `productionTick()`. Apply +25% power per same-type neighbor (capped at, say, +75%) and −20% per nearby enemy building.
- [ ] **Show live numbers in tooltip** — Already partially there; wire up the actual computed multiplier so "same-type neighbors: 2 (+50% efficiency)" reflects what's really happening in the math.

### Sabotage Expansion
- [ ] **Distinct sabotage costs by type** — Per GDD: Mine 600, Processor ~600, Reactor 800, Raid Storage 700. Currently all cost `buildingType.cost - 200` which doesn't match.
- [ ] **Raid Storage** — New sabotage action that steals a chunk of an enemy's refined fuel and adds it to your reserves instead of destroying a building.
- [ ] **Sabotage confirmation prompt** — Prevent fat-finger destroys (small modal: "Spend 800 tokens to destroy this Reactor?").

### AI Enemies
- [ ] **Enemy AI builds over time** — Right now enemies are 5 random buildings placed at spawn and never change. Add a simple loop that gives AI players a budget and has them place buildings on a schedule each simulated day.
- [ ] **Enemy AI sabotages the player** — Occasionally targets your highest-value building. Creates drama.
- [ ] **Enemy resource simulation** — Track enemy uranium and power output legitimately so the leaderboard isn't a fake estimate.

### Leaderboard & Rank
- [ ] **Live rank** — `#rank` in the top bar is hardcoded to `#1`. Calculate and update it every production tick based on real scores.
- [ ] **End-of-round winner screen** — After Day 8 ends, show a final results modal (not just end-of-day). Declare a winner. Show prize pool split (even if fake tokens for now).

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

- [ ] **Phantom wallet connect** — Add a "Connect Wallet" button. Use the Solana `window.solana` API (Phantom) to get the player's public key.
- [ ] **Token contract on Solana** — Deploy an SPL token that represents in-game tokens. Keegan owns this.
- [ ] **Entry fee flow** — Player pays X SOL/USDC → smart contract holds it → mints game tokens → credits their in-game wallet.
- [ ] **Prize pool payout** — At round end, smart contract distributes prize pool to top 3 wallet addresses.
- [ ] **Game state integrity** — Move critical game state (buildings, scores, balances) server-side. Client becomes a display layer only. Otherwise anyone can cheat via console.
- [ ] **Anti-cheat / audit** — All building placements and sabotage actions logged server-side with timestamps. No client-trusted win conditions.
- [ ] **Testnet dry run** — Run a full 8-day round with real wallets but on Solana devnet (fake SOL) before going live.

---

## Phase 4 — Expansion (Post-Launch)

- [ ] **Real multiplayer rooms** — Replace AI opponents with real players in the same session (WebSocket or Solana-anchored game state).
- [ ] **Player trading** — Let players sell refined fuel or processor capacity to each other mid-round.
- [ ] **Cosmetics** — Grid skins, building skins, profile badges. Zero pay-to-win.
- [ ] **Seasons / season pass** — Rotating round themes, map hazards (e.g., radiation zones that damage nearby buildings).
- [ ] **Nuke / Silo building** (per Gumbydev's idea) — High-cost weapon with a large AoE destruction radius. Add radiation fallout that temporarily debuffs cells in range. Gate behind a daily use limit or steep token cost.
- [ ] **Guilds / alliances** — Players team up to share resources or coordinate attacks.
- [ ] **Spectator mode** — Watch a live round in progress (great for social/streaming).

---

## Immediate Next Action (This Week)

1. **Fix the processor** so it's actually required in the resource chain.
2. **Apply proximity % to real output numbers** in `calculatePower()` and `productionTick()`.
3. **Give enemy AI a build loop** so they're growing during the round.
4. **Fix live rank** in the top bar.

Once those four are done, the game is a real playable loop worth play-testing for balance.
