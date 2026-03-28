# Nuclear Tycoon

A competitive multiplayer tycoon game where players build nuclear infrastructure and sabotage competitors for real money.

## Project Structure

```
nuclear-tycoon/
├── index.html          # Main HTML file
├── styles/
│   └── main.css        # All styling
├── js/
│   └── game.js         # Game logic and mechanics
└── README.md           # This file
```

### Phase 1: Core Mechanics (In Progress)
- [x] Grid initialization
- [x] Building placement (Mine, Processor, Storage, Plant)
- [x] Proximity bonuses
- [x] Enemy leeching
- [x] Sabotage mechanics
- [ ] Resource flow (uranium production, consumption)
- [ ] 8-day round timer
- [ ] Leaderboard and scoring
- [ ] Enemy AI behavior

### Phase 2: Polish
- [ ] UI/UX refinement
- [ ] Sound design
- [ ] Visual feedback improvements
- [ ] Balance adjustments

### Phase 3: Blockchain Integration
- [ ] Wallet connection (Solana)
- [ ] Real token transfers
- [ ] Prize pool payouts
- [ ] Persistent game state

## How to Extend

### Add a New Building Type

1. Add to `buildingTypes` in `game.js`:
```javascript
const buildingTypes = {
    // ... existing types
    newtype: { cost: 1000, icon: 'N', color: '#fff', power: 0 }
};
```

2. Add CSS styling in `main.css`:
```css
.cell.newtype {
    background: linear-gradient(135deg, #1a1a2a 0%, #0f0f1f 100%);
}
```

3. Add button in `index.html`:
```html
<button class="btn" onclick="selectBuilding('newtype')">New Type (1000)</button>
```

### Change Game Balance

All costs and mechanics are defined in `buildingTypes` object. Adjust costs there:
- `cost`: Token cost to build
- `power`: Base power output (for plants only)

## Debugging

- Open browser DevTools (F12) to see console logs
- Game logs initialization and key events
- Check the console for warnings if something doesn't work

## Contact

Questions? Drop them in Slack #development channel.
