// ── Server connection ─────────────────────────────────────────────────────────
// Set SERVER_URL to your Railway service URL when deploying.
// During local development the server runs on port 3001.
const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? 'http://localhost:3001'
    : 'https://nuketycoon-production.up.railway.app'; // Railway server

let socket = null;
let _authJWT = null;     // stored JWT for all socket events
let _localPlayerId = null;
const DEFAULT_PLAYER_AVATAR = '☢️';
const AVATAR_OPTIONS = ['☢️', '🧑‍🚀', '👩‍🔬', '👨‍🔬', '🤖', '🦊', '🐺', '🐉'];
const ADMIN_KEY_STORAGE = 'nukwar_admin_key';

function getLocalPlayerId() {
    if (_localPlayerId) return _localPlayerId;
    if (!_authJWT) return null;
    try {
        _localPlayerId = JSON.parse(atob(_authJWT.split('.')[1])).id;
        return _localPlayerId;
    } catch { return null; }
}

function connectSocket() {
    socket = io(SERVER_URL, {
        transports: ['websocket', 'polling'],
        autoConnect: true,
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        pingInterval: 25000,
        pingTimeout: 20000,
    });

    socket.on('connect', () => {
        console.log('☢️ Connected to server');
        // Restore session on page reload
        const saved = localStorage.getItem('nuke_jwt');
        if (saved) socket.emit('auth:reconnect', { jwt: saved });
    });

    socket.on('disconnect', (reason) => {
        console.warn('Server disconnected:', reason);
        addNotification('warning', '⚠️ Lost connection to server. Reconnecting…');
    });

    socket.on('connect_error', (err) => {
        console.error('Socket connect error:', err.message);
        document.getElementById('loginError') &&
            (document.getElementById('loginError').textContent = 'Cannot reach server. Check your connection.');
    });

    // ── Auth events ─────────────────────────────────────────────────────
    socket.on('auth:code_sent', ({ email }) => {
        document.getElementById('loginStep1').style.display = 'none';
        document.getElementById('loginStep2').style.display = 'block';
        document.getElementById('loginEmailDisplay').textContent = email;
        document.getElementById('loginCode').focus();
    });

    socket.on('auth:success', ({ player, jwt, isNewPlayer }) => {
        _authJWT = jwt;
        _localPlayerId = player.id;
        localStorage.setItem('nuke_jwt', jwt);
        game.playerWallet = player.token_balance;
        game.playerName   = player.username;
        game.playerEmail  = player.email;
        game.playerAvatar = player.avatar || DEFAULT_PLAYER_AVATAR;

        if (isNewPlayer) {
            game.pendingInitialProfileSetup = true;
            showAccountSetupStep();
            return;
        }

        game.pendingInitialProfileSetup = false;
        authenticate();
    });

    socket.on('auth:session_expired', () => {
        localStorage.removeItem('nuke_jwt');
        _authJWT = null;
        _localPlayerId = null;
        // Show login modal again
        const modal = document.getElementById('loginModal');
        if (modal) modal.style.display = 'flex';
        document.body.classList.remove('authenticated');
    });

    socket.on('auth:error', ({ message }) => {
        const el1 = document.getElementById('loginError');
        const el2 = document.getElementById('loginError2');
        if (el2 && el2.parentElement.style.display !== 'none') el2.textContent = message;
        else if (el1) el1.textContent = message;
    });

    // ── Run events ──────────────────────────────────────────────────────
    socket.on('run:state', ({ run, buildings, players, yourWallet, isNewJoiner }) => {
        // Set authoritative run state from server
        game.playerWallet = yourWallet;
        game.time.day     = run.current_day;
        game.round        = run.current_day;
        game.runLength    = run.run_length;
        game.prizePool    = run.prize_pool;
        game._serverRunId = run.id;

        // Replace local bot registry with real player list from server
        game.players = players.map(p => ({
            id:      p.id,
            name:    p.username,
            avatar:  p.avatar || DEFAULT_PLAYER_AVATAR,
            isLocal: p.id === getLocalPlayerId(),
            isBot:   false,
            wallet:  parseInt(p.token_balance, 10),
            score:   0,
        }));

        // Render all existing buildings on the grid
        game.buildings      = [];
        game.enemyBuildings = [];
        buildings.forEach(b => {
            if (b.player_id === getLocalPlayerId()) {
                const bObj = {
                    id: b.cell_id,
                    type: b.type,
                    owner: game.playerName,
                    ownerId: b.player_id,
                    ownerAvatar: game.playerAvatar,
                };
                game.buildings.push(bObj);
                renderBuilding(b.cell_id, b.type, true, bObj);
            } else {
                const bObj = {
                    id: b.cell_id,
                    type: b.type,
                    owner: b.owner_name,
                    ownerId: b.player_id,
                };
                game.enemyBuildings.push(bObj);
                renderBuilding(b.cell_id, b.type, false, bObj);
            }
        });

        updateUI();

        if (isNewJoiner) {
            // Fresh joiner: show the lobby modal with server-populated data
            _updateLobbyFromServerState(run, players, yourWallet);
            const modal = document.getElementById('lobbyModal');
            if (modal) modal.style.display = 'flex';
        } else {
            // Returning player: skip lobby, go straight into the game
            const modal = document.getElementById('lobbyModal');
            if (modal) modal.style.display = 'none';
            startGame(true); // true = server-mode, skip initRun/initGrid
        }
    });

    socket.on('run:player_joined', ({ player }) => {
        if (!game.players.find(p => p.id === player.id)) {
            game.players.push({
                id: player.id,
                name: player.username,
                avatar: player.avatar || DEFAULT_PLAYER_AVATAR,
                isLocal: false,
                isBot: false,
                wallet: 45000,
                score: 0
            });
        }
        addNotification('info', `👤 ${player.username} joined the run.`);
    });

    socket.on('run:join_error', ({ message }) => {
        const errEl = document.getElementById('lobbyError');
        if (errEl) errEl.textContent = message;
    });

    socket.on('run:day_advanced', ({ day, runLength, scores }) => {
        if (day > game.time.day) {
            game.time.day   = day;
            game.time.hour  = 0;
            game.time.minute = 0;
            onDayAdvance();
        }
        scores.forEach(s => {
            const p = game.players.find(pl => pl.name === s.username);
            if (p) p.score = s.score;
        });
    });

    socket.on('run:ended', ({ runNumber, scores, payouts }) => {
        // Apply server-authoritative payout to local wallet
        const me = payouts.find(p => p.player_id === getLocalPlayerId());
        if (me) game.playerWallet = me.token_balance;
        onRunEnd();
    });

    socket.on('run:new', ({ runId, runNumber }) => {
        addNotification('info', `🔄 Run #${runNumber} has started! Rejoin via the lobby.`);
    });

    // ── Building events ─────────────────────────────────────────────────
    socket.on('building:placed', ({ building, ownerName, placedBy }) => {
        const isMyBuilding = placedBy === getLocalPlayerId();
        if (isMyBuilding) {
            // Server confirmed our placement — render it locally now
            if (!game.buildings.find(b => b.id === building.cell_id)) {
                const bObj = {
                    id: building.cell_id,
                    type: building.type,
                    owner: game.playerName,
                    ownerId: building.player_id || getLocalPlayerId(),
                    ownerAvatar: game.playerAvatar,
                    constructionTimeRemaining: buildingTypes[building.type]?.constructionTime || 0,
                    isUnderConstruction: (buildingTypes[building.type]?.constructionTime || 0) > 0
                };
                game.buildings.push(bObj);
                renderBuilding(building.cell_id, building.type, true, bObj);
                calculateProximity();
                if (building.type === 'storage') game.maxStorage += 1000;
                addNotification('success', `🛠️ ${displayNames[building.type] || building.type} construction started.`);
                updateUI();
            }
            game.selectedMode = null;
            return;
        }
        // Another player placed a building — render it as an enemy building
        if (!game.enemyBuildings.find(b => b.id === building.cell_id)) {
            const bObj = {
                id: building.cell_id,
                type: building.type,
                owner: ownerName,
                ownerId: building.player_id || placedBy,
            };
            game.enemyBuildings.push(bObj);
            renderBuilding(building.cell_id, building.type, false, bObj);
        }
    });

    socket.on('building:place_error', ({ message }) => {
        addNotification('danger', `❌ ${message}`);
        if (/occupied/i.test(message) && socket?.connected && _authJWT) {
            socket.emit('run:join', { jwt: _authJWT });
        }
    });

    socket.on('admin:cell_cleared', ({ cellId, cleared }) => {
        game.buildings = (game.buildings || []).filter((b) => b.id !== cellId);
        game.enemyBuildings = (game.enemyBuildings || []).filter((b) => b.id !== cellId);
        restoreEmptyCell(cellId);
        calculateProximity();
        updateUI();
        addNotification('info', `🧹 Server cleared cell ${cellId}${cleared ? ` (${cleared} row${cleared === 1 ? '' : 's'})` : ''}.`);
    });

    socket.on('admin:buildings_reset', ({ cellIds, cleared }) => {
        (cellIds || []).forEach((cellId) => restoreEmptyCell(cellId));
        game.buildings = [];
        game.enemyBuildings = [];
        calculateProximity();
        updateUI();
        addNotification('warning', `🧪 Server reset ${cleared || 0} active building${cleared === 1 ? '' : 's'} for testing.`);
    });

    socket.on('admin:run_reset', () => {
        game.buildings = [];
        game.enemyBuildings = [];
        initGrid();
        calculateProximity();
        updateUI();
        addNotification('warning', '🔄 The live Railway run was reset. Rejoin the new round if needed.');
    });

    // ── Sabotage events ─────────────────────────────────────────────────
    socket.on('sabotage:applied', ({ attackType, cellId, attackerName, attackerId,
                                      disableUntil, stolenAmount, destroyedCells, falloutDuration }) => {
        const isMe = attackerId === getLocalPlayerId();

        if (attackType === 'disable' && disableUntil) {
            const b = game.enemyBuildings.find(e => e.id === cellId);
            if (b) b.disabled = { endTime: new Date(disableUntil).getTime(), multiplier: 0.5 };
        }
        if (attackType === 'steal' && isMe && stolenAmount) {
            game.uraniumRaw += stolenAmount;
        }
        if (attackType === 'nuke' && destroyedCells) {
            destroyedCells.forEach(cId => {
                const idx = game.enemyBuildings.findIndex(e => e.id === cId);
                if (idx !== -1) game.enemyBuildings.splice(idx, 1);
                const cell = document.querySelector(`[data-id="${cId}"]`);
                if (cell) { cell.innerHTML = ''; cell.className = cell.className.replace(/building.*/, '').trim(); }
            });
        }
        if (!isMe) {
            addNotification('warning', `⚔️ ${attackerName} executed a ${attackType} attack!`);
        }
        updateUI();
    });

    // ── Wallet sync ─────────────────────────────────────────────────────
    socket.on('player:wallet_update', ({ token_balance }) => {
        game.playerWallet = token_balance;
        updateUI();
    });

    // ── Username rename ──────────────────────────────────────────────────
    socket.on('player:rename_success', ({ username, avatar, jwt }) => {
        if (jwt) {
            _authJWT = jwt;
            localStorage.setItem('nuke_jwt', jwt);
        }
        applyPlayerProfileUpdate({
            playerId: getLocalPlayerId(),
            oldUsername: game.playerName,
            username,
            avatar: avatar || game.playerAvatar || DEFAULT_PLAYER_AVATAR,
        });

        const msgEl = document.getElementById('profileUsernameMsg');
        if (msgEl) { msgEl.style.color = '#4CAF50'; msgEl.textContent = 'Profile updated!'; }

        const setupMsg = document.getElementById('loginError3');
        if (setupMsg) {
            setupMsg.style.color = '#4CAF50';
            setupMsg.textContent = 'Profile saved. Entering the game…';
        }

        if (game.pendingInitialProfileSetup) {
            game.pendingInitialProfileSetup = false;
            authenticate();
        }
    });

    socket.on('player:rename_error', ({ message }) => {
        const msgEl = document.getElementById('profileUsernameMsg');
        if (msgEl) { msgEl.style.color = '#ff6b6b'; msgEl.textContent = message; }
        const setupMsg = document.getElementById('loginError3');
        if (setupMsg) { setupMsg.style.color = '#ff6b6b'; setupMsg.textContent = message; }
    });

    socket.on('run:player_updated', ({ playerId, oldUsername, username, avatar }) => {
        applyPlayerProfileUpdate({ playerId, oldUsername, username, avatar });
    });

    socket.on('error', ({ message }) => {
        addNotification('warning', `⚠️ ${message}`);
    });
}

// Sync locally-earned income to the server every 60 seconds
// so the server wallet stays close to the client wallet.
let _incomeSinceLastSync = 0;
function _trackLocalIncome(amount) {
    _incomeSinceLastSync += amount;
}
setInterval(() => {
    if (socket?.connected && _authJWT && _incomeSinceLastSync > 0) {
        socket.emit('player:income_sync', { jwt: _authJWT, income: Math.floor(_incomeSinceLastSync) });
        _incomeSinceLastSync = 0;
    }
}, 60000);

function _updateLobbyFromServerState(run, players, yourWallet) {
    const preview = run.prize_pool + Math.floor(players.length * 5000 * 0.8);
    const el = (id) => document.getElementById(id);
    if (el('lobbyBuyIn'))      el('lobbyBuyIn').textContent      = game.buyIn.toLocaleString();
    if (el('lobbyBuyInBtn'))   el('lobbyBuyInBtn').textContent   = game.buyIn.toLocaleString();
    if (el('lobbyWalletAfter'))el('lobbyWalletAfter').textContent= (yourWallet).toLocaleString();
    if (el('lobbyPrizePreview'))el('lobbyPrizePreview').textContent = formatPrizePool(preview);
    const list = el('lobbyPlayerList');
    if (list) {
        list.innerHTML = players.map(p =>
            `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #1e1e1e;gap:8px;">
                <span style="display:inline-flex;align-items:center;gap:6px;color:${p.id === getLocalPlayerId() ? '#ffb84d' : '#888'};">${avatarBadge(p.avatar || DEFAULT_PLAYER_AVATAR)} ${escapeHtml(p.username)}</span>
                <span style="color:#4CAF50;">${parseInt(p.token_balance,10).toLocaleString()} tokens</span>
            </div>`
        ).join('');
    }
}

// ── Game state ────────────────────────────────────────────────────────────────
const game = {
    playerWallet: 50000,
    playerName: 'You',
    playerEmail: '',
    playerAvatar: DEFAULT_PLAYER_AVATAR,
    pendingInitialProfileSetup: false,
    botsEnabled: true,
    uraniumRaw: 0,      // mined by Mine buildings
    uraniumRefined: 0,  // converted by Processor buildings; consumed by Plants
    maxStorage: 5000,   // total cap shared across raw + refined
    buildings: [],
    enemyBuildings: [],
    selectedMode: null,
    selectedCell: null,
    proximityRange: 2,
    round: 1,
    runLength: 8,                 // configurable: 8 days for standard run, adjust for events or shorter runs
    // Token economy
    totalTokenSupply: 1000000000, // 1 billion — the hard cap; tokens are MINTED from this reserve
    tokensIssued: 0,              // total ever drawn from the 1B reserve (wallets + income rewards)
    tokensBurned: 0,              // permanently destroyed by in-game spending
    // circulating = tokensIssued - tokensBurned
    // available   = totalTokenSupply - tokensIssued
    prizePool: 0,                 // funded by buy-ins + 10% of in-game spends
    // Conversion: how many in-game tokens equal $1 USDC. Configure for tests.
    tokensPerUSD: 2000,
    runEnded: false,              // flag to prevent multiple onRunEnd() calls
    siloStrikes: 0,               // number of strikes used this round
    maxSilosPerRound: 1,          // max number of strikes allowed per round
    lastStrikeTime: -999,         // track cooldown (ticks between strikes)
    strikesCooldown: 20,          // minimum ticks between strikes
    falloutZones: [],             // { id, endTime } array for radiation zones
    nuclearThreats: [],           // track players who used nukes for prestige

    // ── Buy-in / run entry ───────────────────────────────────────────────────
    // Every player (human or bot) pays this once to enter a run.
    // A run = runLength rounds (default 8), each lasting one real 24-hour day.
    // Their buy-in seeds the prize pool and the bonding curve pool directly.
    buyIn: 5000, // tunable — cost per player per run (in tokens)
    
    // ── Strike tracking ───────────────────────────────────────────────────────
    // Track nuke strikes per day for reset logic
    dayStrikes: 0,                // strikes used today (resets each day)

    // ── Player registry ───────────────────────────────────────────────────────
    // Single source of truth for all players in the current round.
    // BACKEND_STUB: On a real multiplayer backend this list is populated server-
    //   side (e.g. via WebSocket 'round:players' event) before the round starts.
    //   For now we build it locally in initPlayerRegistry().
    players: []
    // Each entry shape (see initPlayerRegistry for full object):
    // {
    //   id        : string  — unique ID ('local' for the human, UUID for remote)
    //   name      : string  — display name
    //   isLocal   : bool    — true only for the player on this client
    //   isBot     : bool    — true for AI-controlled players
    //   wallet    : number  — token balance
    //   paidBuyIn : bool    — has this player confirmed their entry fee?
    //   score     : number  — updated each tick for leaderboard
    // }
};

// Client-side password protection (hash only). Embeds SHA-256(hex) of the password
// so the plaintext is not present in source. This is still client-side only.
const EXPECTED_PASSWORD_HASH = 'b7e39e55e0913eff6b9aee210d3cb909df8da6b22ee6a8da8550bb35d4391ac4';

// Helper: compute SHA-256 hex using browser WebCrypto
async function sha256Hex(str) {
    const enc = new TextEncoder();
    const data = enc.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// daily accumulators for summary
game.dailyProduced = 0;
game.dailyIncome = 0;

// Simulation time and market
game.time = {
    day: 1,
    hour: 0,
    minute: 0,
    // minutes per real-second (simulation speed). Default 60 => 1 sec = 1 simulated hour
    // Default set to real-time: 1 simulated day (1440 minutes) = 86400 real seconds
    // => minutesPerSecond = 1440 / 86400 = 1/60 = 0.0166667
    minutesPerSecond: 0.0166667
};

game.market = {
    price: 1.00,
    baseTokenPrice: 1.00,    // price when pool is 100% full (bonding curve anchor)
    volatility: 0.03,        // hourly volatility (~3% per hour)
    // ----- Bonding curve / AMM pool -----
    // tokenPool represents available liquidity. As tokens are burned, the pool
    // shrinks and price rises inversely: price = baseTokenPrice * (poolInitial / pool).
    // When pool is 100% full  → price = baseTokenPrice ($1.00)
    // When pool is 50% full   → price = $2.00
    // When pool is 10% full   → price = $10.00  (scarcity premium)
    tokenPool: 1000,         // current available liquidity (tunable start)
    tokenPoolInitial: 1000,  // reference size — never changes
    // Each token spent drains the pool: drain = cost / POOL_BURN_RATE
    // Lower = more aggressive price impact. 50 → 1 Mine (800t) drains 16 units.
    poolBurnRate: 50         // tunable
};
// per-second volatility is smaller (for stock-like per-second ticks)
game.market.perSecondVol = game.market.volatility / 60;
// demand model parameters (legacy diurnal drift, kept for flavour)
game.market.baseDemand = 1000;
game.market.driftFactor = 0.0002; // reduced — bonding curve is now the main price driver

// Building type definitions
// Use emoji icons as a visual; we'll render monochrome SVG versions so they
// can be tinted to the player's theme color. `svg` gives consistent coloring.
const USE_SVG_ICONS = false; // use emoji characters instead of SVG shapes
const PLAYER_COLOR = '#ffb84d';
const ENEMY_COLOR = '#888888';

const buildingTypes = {
    mine: { cost: 800, emoji: '⛏️', color: '#4CAF50', power: 0, constructionTime: 1 },
    processor: { cost: 1200, emoji: '🏭', color: '#d98a3a', power: 0, constructionTime: 1.5 },
    storage: { cost: 1000, emoji: '🗄️', color: '#b08b4f', power: 0, constructionTime: 2 },
    plant: { cost: 1000, emoji: '☢️', color: '#ffb84d', power: 100, constructionTime: 2.2 },
    silo: { cost: 6000, emoji: '💥', color: '#ff0000', power: 0, constructionTime: 3.5, isWeapon: true }
};

// Display names used in UI (keep keys stable in logic)
const displayNames = {
    mine: 'Mine',
    processor: 'Plant',
    storage: 'Storage',
    plant: 'Reactor',
    silo: 'Silo'
};

// Enemy list (legacy — kept for spawnEnemyBuildings; names are drawn from game.players bots)
const enemies = [
    { name: 'PHANTOM_IX' },
    { name: 'NEUTRON_' }
];

// ─────────────────────────────────────────────────────────────────────────────
// Player Registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the player list for the current run.
 *
 * BACKEND_STUB: In production this function is replaced by a server-sent
 *   payload (e.g. WebSocket 'run:join' -> 'run:players' handshake).
 *   The shape of each player object here intentionally matches what the backend
 *   would send, so swapping is straightforward:
 *
 *   socket.on('run:players', (players) => {
 *     game.players = players;
 *     renderLobbyPlayers();
 *   });
 */
function initPlayerRegistry() {
    game.players = [
        // ── Human player (this client) ───────────────────────────────────────
        {
            id: 'local',
            name: game.playerName || 'You',
            avatar: game.playerAvatar || DEFAULT_PLAYER_AVATAR,
            isLocal: true,
            isBot: false,
            wallet: game.playerWallet, // synced from game.playerWallet
            paidBuyIn: false,
            score: 0
        }
    ];

    if (!game.botsEnabled) return;

    game.players.push(
        {
            id: 'bot-phantom',
            name: 'PHANTOM_IX',
            avatar: '🤖',
            isLocal: false,
            isBot: true,
            wallet: 50000,
            paidBuyIn: false,
            score: 0
        },
        {
            id: 'bot-neutron',
            name: 'NEUTRON_',
            avatar: '🐺',
            isLocal: false,
            isBot: true,
            wallet: 50000,
            paidBuyIn: false,
            score: 0
        }
    );
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function avatarBadge(avatar, size = 18) {
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:#1a1a1a;border:1px solid #333;font-size:${Math.max(12, size - 4)}px;line-height:1;vertical-align:middle;">${escapeHtml(avatar || DEFAULT_PLAYER_AVATAR)}</span>`;
}

function applyPlayerProfileUpdate({ playerId, oldUsername, username, avatar }) {
    const nextName = username || game.playerName || 'You';
    const nextAvatar = avatar || DEFAULT_PLAYER_AVATAR;

    if (playerId === getLocalPlayerId() || oldUsername === game.playerName) {
        game.playerName = nextName;
        game.playerAvatar = nextAvatar;
    }

    (game.players || []).forEach((p) => {
        if ((playerId && p.id === playerId) || (oldUsername && p.name === oldUsername)) {
            p.name = nextName;
            p.avatar = nextAvatar;
        }
    });

    [...(game.buildings || []), ...(game.enemyBuildings || [])].forEach((b) => {
        if ((playerId && b.ownerId === playerId) || (oldUsername && b.owner === oldUsername)) {
            b.owner = nextName;
            b.ownerAvatar = nextAvatar;
            if (playerId) b.ownerId = playerId;
        }
    });

    const nameEl = document.getElementById('profileName');
    if (nameEl) nameEl.textContent = game.playerName || 'You';
    const input = document.getElementById('profileUsernameInput');
    if (input) input.value = game.playerName || '';
    const signupInput = document.getElementById('signupUsername');
    if (signupInput && game.pendingInitialProfileSetup) signupInput.value = game.playerName || '';
    const avatarDisplay = document.getElementById('profileAvatarDisplay');
    if (avatarDisplay) avatarDisplay.textContent = game.playerAvatar || DEFAULT_PLAYER_AVATAR;

    const profilePicker = document.getElementById('profileAvatarPicker');
    if (profilePicker) profilePicker.dataset.selectedAvatar = game.playerAvatar || DEFAULT_PLAYER_AVATAR;
    const signupPicker = document.getElementById('signupAvatarPicker');
    if (signupPicker) signupPicker.dataset.selectedAvatar = game.playerAvatar || DEFAULT_PLAYER_AVATAR;

    document.querySelectorAll('.avatar-option').forEach((btn) => {
        const picker = btn.closest('.avatar-picker');
        if (!picker) return;
        btn.classList.toggle('selected', btn.dataset.avatar === picker.dataset.selectedAvatar);
    });
}

/**
 * Resolve an owner id/name to a full player record from game.players.
 * Returns a plain object so callers get a consistent shape even when the
 * record is missing (e.g. during a reconnect before the server has re-sent
 * the player list).
 *
 * @param {string} ownerRef  The owner id or owner string stored on a building
 * @returns {{ name:string, avatar:string, isBot:boolean, isLocal:boolean, id:string|null }}
 */
function resolveOwner(ownerRef) {
    const p = (game.players || []).find(pl => pl.id === ownerRef || pl.name === ownerRef);
    if (p) return { ...p, avatar: p.avatar || DEFAULT_PLAYER_AVATAR };
    return { name: ownerRef || 'Unknown', avatar: DEFAULT_PLAYER_AVATAR, isBot: true, isLocal: false, id: null };
}

/**
 * Called once per run (a run = 8 rounds, each round lasting one real 24-hour day).
 *
 * Each player pays game.buyIn tokens:
 *  - 80% goes directly to the prize pool (what players compete for)
 *  - 20% drains the bonding curve pool (immediate price impact at run start)
 *
 * BACKEND_STUB: In production, buy-in deduction and prize pool seeding are
 *   authorised server-side. This client call would be:
 *   socket.emit('run:buyin', { playerId: 'local', amount: game.buyIn });
 *   …and server broadcasts the updated prizePool back to all clients.
 */
function initRun() {
    initPlayerRegistry();

    // ── Issue starting wallets from the 1B reserve ──────────────────────────────
    // Every player’s starting wallet balance is minted from the 1B supply pool.
    // This is the “purchase” event — tokens flow from reserve into circulation.
    // BACKEND_STUB: in production this issuance is authorised server-side and
    //   signed on-chain before wallets are credited.
    const startingWalletPerPlayer = 50000; // must match initPlayerRegistry wallet init
    game.tokensIssued += game.players.length * startingWalletPerPlayer;

    let totalBuyIn = 0;
    game.players.forEach(p => {
        if (p.isLocal) {
            // deduct from the human player's wallet
            game.playerWallet -= game.buyIn;
            p.wallet = game.playerWallet;
        } else {
            // bots auto-pay (wallet is local simulation only)
            p.wallet -= game.buyIn;
        }
        p.paidBuyIn = true;
        totalBuyIn += game.buyIn;
    });

    // 80% of all buy-ins seeds the prize pool
    const prizeContrib = Math.floor(totalBuyIn * 0.80);
    game.prizePool += prizeContrib;

    // 20% drains the bonding curve → price starts slightly above floor
    const poolDrain = Math.floor(totalBuyIn * 0.20) / game.market.poolBurnRate;
    game.market.tokenPool = Math.max(1, game.market.tokenPool - poolDrain);

    console.info(
        `Run started (Round ${game.round}/${game.runLength}) | Players: ${game.players.length} | ` +
        `Buy-in: ${game.buyIn.toLocaleString()} each | ` +
        `Prize pool seeded: ${prizeContrib.toLocaleString()} tokens`
    );
}

/**
 * Initialize the game grid
 */
function initGrid() {
    // Reset building state so this can safely be called multiple times
    // (e.g. pre-render for lobby preview, then again on actual run start)
    game.buildings = [];
    game.enemyBuildings = [];
    const grid = document.getElementById('gameGrid');
    grid.innerHTML = '';
    // generate a simple terrain map (grass / dirt / road)
    const terrain = generateTerrain(20, 20);
    game.terrain = terrain; // store so road-bonus checks work at runtime
    game.deposits = generateDeposits(20, 20); // Generate uranium deposits
    
    for (let i = 0; i < 400; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        // add terrain class for visuals (terrain-grass/terrain-dirt/terrain-road)
        const t = terrain[i] || 'grass';
        cell.classList.add('terrain-' + t);
        
        // Check if this cell has a deposit and add visual indicator
        const hasDeposit = game.deposits.find(d => d.cellId === i);
        if (hasDeposit) {
            cell.classList.add('has-deposit');
        }
        
        cell.tabIndex = -1;
        cell.dataset.id = i;
        cell.onclick = () => placeOrSelect(i);
        cell.addEventListener('mouseenter', (e) => onCellHover(i, e));
        cell.addEventListener('mousemove', (e) => onCellMove(i, e));
        cell.addEventListener('mouseleave', (e) => hideTooltip());
        grid.appendChild(cell);
    }

    // Spawn enemy buildings
    spawnEnemyBuildings();
}

/**
 * Spawn random enemy buildings on the grid
 */
function spawnEnemyBuildings() {
    if (!game.botsEnabled) return;

    const botPlayers = (game.players || []).filter(p => p.isBot);
    if (botPlayers.length === 0) return;

    const types = Object.keys(buildingTypes);
    const maxAttempts = 200;
    for (let i = 0; i < 5; i++) {
        let attempts = 0;
        let randomId = null;
        let type = null;
        const enemy = botPlayers[Math.floor(Math.random() * botPlayers.length)] || enemies[Math.floor(Math.random() * enemies.length)];

        while (attempts < maxAttempts) {
            attempts++;
            randomId = Math.floor(Math.random() * 400);
            type = types[Math.floor(Math.random() * types.length)];
            const terrainBlocked = game.terrain && (game.terrain[randomId] === 'road' || game.terrain[randomId] === 'road-h' || game.terrain[randomId] === 'road-x');
            const occupiedByEnemy = game.enemyBuildings.find(b => b.id === randomId);
            const occupiedByPlayer = game.buildings.find(b => b.id === randomId);
            if (!terrainBlocked && !occupiedByEnemy && !occupiedByPlayer) break;
        }

        if (attempts >= maxAttempts) {
            console.warn('spawnEnemyBuildings: could not find a valid non-road tile for spawn, skipping');
            continue;
        }

        const building = {
            id: randomId,
            type,
            owner: enemy.name,
            ownerId: enemy.id,
            ownerAvatar: enemy.avatar || DEFAULT_PLAYER_AVATAR,
        };
        game.enemyBuildings.push(building);
        renderBuilding(randomId, type, false, building);
    }
}

/**
 * Generate a simple terrain map for the grid.
 * Returns an array of length width*height with values 'grass'|'dirt'|'road'.
 */
function generateTerrain(width, height) {
    const out = new Array(width * height).fill('grass');
    // 1-tile-wide vertical road down the center column
    const centerX = Math.floor(width / 2);
    for (let y = 0; y < height; y++) {
        out[y * width + centerX] = 'road';
    }

    // 2 horizontal branches off the spine at random rows, random length (3–7 tiles each direction)
    const branchRows = [];
    while (branchRows.length < 2) {
        const row = 2 + Math.floor(Math.random() * (height - 4)); // avoid very top/bottom
        if (!branchRows.includes(row)) branchRows.push(row);
    }
    branchRows.forEach(row => {
        const len = 3 + Math.floor(Math.random() * 5); // 3–7 tiles each side
        // mark the junction cell as a crossroads
        out[row * width + centerX] = 'road-x';
        for (let dx = 1; dx <= len; dx++) {
            if (centerX - dx >= 0)     out[row * width + (centerX - dx)] = 'road-h'; // left
            if (centerX + dx < width)  out[row * width + (centerX + dx)] = 'road-h'; // right
        }
    });

    // scatter dirt patches (clusters)
    for (let i = 0; i < width * height * 0.08; i++) {
        const cx = Math.floor(Math.random() * width);
        const cy = Math.floor(Math.random() * height);
        const radius = 1 + Math.floor(Math.random() * 2);
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const x = cx + dx; const y = cy + dy;
                if (x >= 0 && x < width && y >= 0 && y < height) {
                    const idx = y * width + x;
                    if (out[idx] !== 'road' && out[idx] !== 'road-h' && out[idx] !== 'road-x' && Math.random() > 0.25) out[idx] = 'dirt';
                }
            }
        }
    }

    return out;
}

/**
 * Generate uranium ore deposits scattered across the map
 */
function generateDeposits(width, height) {
    const deposits = [];
    const numDeposits = 5 + Math.floor(Math.random() * 4); // 5-8 deposit clusters
    
    for (let d = 0; d < numDeposits; d++) {
        // Random deposit center
        const cx = 2 + Math.floor(Math.random() * (width - 4));
        const cy = 2 + Math.floor(Math.random() * (height - 4));
        const depositRadius = 1 + Math.floor(Math.random() * 2); // 1-2 cell radius
        
        // Generate deposit ore at this location
        for (let dy = -depositRadius; dy <= depositRadius; dy++) {
            for (let dx = -depositRadius; dx <= depositRadius; dx++) {
                if (Math.random() > 0.25) { // sparse within radius
                    const x = cx + dx;
                    const y = cy + dy;
                    if (x >= 0 && x < width && y >= 0 && y < height) {
                        const cellId = y * width + x;
                        // Skip roads
                        if (!['road', 'road-h', 'road-x'].includes(game.terrain[cellId])) {
                            deposits.push({ cellId, quality: 0.5 + Math.random() * 0.5 }); // 0.5-1.0 quality
                        }
                    }
                }
            }
        }
    }
    
    return deposits;
}

/**
 * Render uranium deposits visually on the grid
 */
function renderDeposits() {
    const grid = document.getElementById('gameGrid');
    game.deposits.forEach(deposit => {
        const cell = grid.querySelector(`[data-id="${deposit.cellId}"]`);
        if (cell) cell.classList.add('has-deposit');
    });
}

/**
 * Get mine deposit bonus based on proximity to nearest deposit
 * On deposit: 1.5x, 1 away: 1.25x, 2 away: 0.7x, 3+ away: 0.1x (extremely low)
 */
function getDepositBonus(mineId) {
    if (!game.deposits || game.deposits.length === 0) return 0.1; // no deposits = extremely low yield
    
    const mineCoords = getCoords(mineId);
    let minDist = Infinity;
    
    game.deposits.forEach(deposit => {
        const depCoords = getCoords(deposit.cellId);
        const dist = Math.max(Math.abs(mineCoords.x - depCoords.x), Math.abs(mineCoords.y - depCoords.y));
        if (dist < minDist) minDist = dist;
    });
    
    if (minDist === 0) return 1.5; // On deposit: excellent yield
    if (minDist === 1) return 1.25; // Adjacent: good yield
    if (minDist === 2) return 0.7; // 2 tiles away: reduced yield
    return 0.1; // 3+ tiles away: extremely poor yield
}

/**
 * Returns true if any orthogonal or diagonal neighbour of cellId is a road tile.
 * Used to grant reactors the road-proximity income bonus.
 */
function cellHasRoadNeighbor(cellId) {
    if (!game.terrain) return false;
    const COLS = 20;
    const x = cellId % COLS;
    const y = Math.floor(cellId / COLS);
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx; const ny = y + dy;
            if (nx < 0 || nx >= COLS || ny < 0 || ny >= COLS) continue;
            const t = game.terrain[ny * COLS + nx];
            if (t === 'road' || t === 'road-h' || t === 'road-x') return true;
        }
    }
    return false;
}

/**
 * Select a building type to place
 */
function selectBuilding(type) {
    game.selectedMode = type;
    updateButtonStates();
}

/**
 * Update button visual states
 */
function updateButtonStates() {
    // Reset active states for toolbar buttons and menu items
    document.querySelectorAll('.btn, .menu-item').forEach(el => {
        el.classList.remove('active');
        if (el.classList.contains('btn')) el.style.opacity = '';
    });

    // Highlight any element with a matching data-type
    if (game.selectedMode) {
        document.querySelectorAll('[data-type]').forEach(el => {
            if (el.dataset.type === game.selectedMode) {
                el.classList.add('active');
                if (el.classList.contains('btn')) el.style.opacity = '1';
            }
        });
    }
}

/**
 * Initialize actions popup menu behaviour (toggle, item clicks, accessibility)
 */
function initMenu() {
    if (initMenu._done) return; // prevent double-init (called by DOMContentLoaded + startGame)
    initMenu._done = true;
    console.log('initMenu(): initializing actions menu');
    const actionsBtn = document.getElementById('actionsMenuBtn');
    const actionsMenu = document.getElementById('actionsMenu');

    function setMenuOpen(open) {
        if (!actionsBtn || !actionsMenu) return;
        actionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (!open) {
            // If a child inside the menu currently has focus, move it back to the toggle
            const active = document.activeElement;
            if (actionsMenu.contains(active)) {
                try { actionsBtn.focus(); } catch (e) { /* ignore */ }
            }
            // Mark hidden for AT and hide visually
            actionsMenu.setAttribute('aria-hidden', 'true');
            actionsMenu.style.display = 'none';
            actionsMenu.style.position = '';
            return;
        }
        // If mobile menu overlay class is present, remove it so dropdown can show
        try { document.body.classList.remove('mobile-menu-open'); } catch (e) { }
        // Opening: mark visible for AT then show and position
        actionsMenu.setAttribute('aria-hidden', 'false');
        // Show first so we can measure, then position fixed to avoid parent clipping
        actionsMenu.style.display = 'block';
        actionsMenu.style.position = 'fixed';
        actionsMenu.style.right = 'auto';
        actionsMenu.style.left = 'auto';
        // Compute placement to align right edge of menu with button
        const btnRect = actionsBtn.getBoundingClientRect();
        const menuWidth = actionsMenu.getBoundingClientRect().width || actionsMenu.offsetWidth || 220;
        // try to right-align with button, but keep on-screen
        let left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, btnRect.right - menuWidth));
        let top = btnRect.bottom + 8;
        // If there's not enough space below, try above
        if (top + actionsMenu.getBoundingClientRect().height > window.innerHeight - 8) {
            top = Math.max(8, btnRect.top - actionsMenu.getBoundingClientRect().height - 8);
        }
        actionsMenu.style.left = left + 'px';
        actionsMenu.style.top = top + 'px';
    }

    // expose setMenuOpen globally so inline fallbacks can delegate to the same logic
    try { window.setMenuOpen = setMenuOpen; } catch (e) { /* ignore */ }

    if (actionsBtn) {
        const toggleHandler = (e) => {
            if (e && e.preventDefault) e.preventDefault();
            const expanded = actionsBtn.getAttribute('aria-expanded') === 'true';
            setMenuOpen(!expanded);
            console.log('initMenu: actionsBtn toggle -> setMenuOpen', !expanded);
            if (e && e.stopPropagation) e.stopPropagation();
        };
        // click handles desktop; touchend handles mobile (iOS eats click when
        // parent has overflow-x:auto + -webkit-overflow-scrolling:touch)
        let _lastToggleTs = 0;
        const debouncedToggle = (e) => {
            const now = Date.now();
            if (now - _lastToggleTs < 600) return; // dedupe touchend → synthesized click
            _lastToggleTs = now;
            toggleHandler(e);
        };
        actionsBtn.addEventListener('touchend', debouncedToggle, { passive: false });
        actionsBtn.addEventListener('click', debouncedToggle);
        // ensure button is on top and tappable on small screens
        try {
            actionsBtn.style.zIndex = '1000';
            actionsBtn.style.touchAction = 'manipulation';
        } catch (e) { }
    }

    // Menu is a persistent toggle — only close via hamburger click, M key, or Escape.
    // Do NOT add an outside-click handler; grid clicks must not dismiss the menu.

    // Menu item actions — menu stays open after selection; click hamburger again to close
    document.querySelectorAll('.menu-item').forEach(mi => {
        mi.addEventListener('click', (e) => {
            const type = mi.dataset.type;
            if (type) {
                selectBuilding(type);
            } else {
                if (mi.id === 'profileMenuItem') showProfile();
                if (mi.id === 'devMenuItem') toggleDevPanel();
            }
            // intentionally NOT closing the menu here
        });
    });

    // Keyboard: Escape closes menu, M toggles it
    document.addEventListener('keydown', (e) => {
        // Ignore key shortcuts when typing in an input/textarea
        const tag = document.activeElement && document.activeElement.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (e.key === 'Escape') { setMenuOpen(false); return; }
        if (e.key === 'm' || e.key === 'M') {
            const expanded = actionsBtn && actionsBtn.getAttribute('aria-expanded') === 'true';
            setMenuOpen(!expanded);
        }
    });
}

// Ensure initMenu is called when DOM is ready so the hamburger is wired early
window.addEventListener('DOMContentLoaded', () => {
    try {
        if (typeof initMenu === 'function') {
            initMenu();
            console.log('DOMContentLoaded: initMenu executed');
        }
    } catch (err) {
        console.warn('DOMContentLoaded: initMenu error', err);
    }

    syncAdminKeyUI();

    // Shift+D+V secret shortcut to reveal/hide the Dev button
    const _devHeldKeys = new Set();
    document.addEventListener('keydown', (ev) => {
        const k = ev && typeof ev.key === 'string' ? ev.key.toLowerCase() : null;
        if (!k) return;
        _devHeldKeys.add(k);
        if (ev.shiftKey && _devHeldKeys.has('d') && _devHeldKeys.has('v')) {
            const devBtn = document.getElementById('devToggle');
            if (devBtn) {
                const hidden = devBtn.style.display === 'none' || devBtn.style.display === '';
                devBtn.style.display = hidden ? 'inline-flex' : 'none';
            }
        }
    });
    document.addEventListener('keyup', (ev) => {
        const k = ev && typeof ev.key === 'string' ? ev.key.toLowerCase() : null;
        if (!k) return;
        _devHeldKeys.delete(k);
    });
});

/**
 * Fallback toggle that can be called from inline onclick. Safe if initMenu already manages state.
 */
function toggleActionsMenu(e) {
    console.log('toggleActionsMenu called');
    const actionsBtn = document.getElementById('actionsMenuBtn');
    const actionsMenu = document.getElementById('actionsMenu');
    if (!actionsBtn || !actionsMenu) { console.warn('toggleActionsMenu: elements missing'); return; }
    const expanded = actionsBtn.getAttribute('aria-expanded') === 'true';
    const open = !expanded;
    // Delegate to the same placement logic used by initMenu
    if (typeof setMenuOpen === 'function') {
        try { setMenuOpen(open); } catch (err) {
            actionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            actionsMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
            actionsMenu.style.display = open ? 'block' : 'none';
        }
    } else {
        actionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        actionsMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
        actionsMenu.style.display = open ? 'block' : 'none';
        if (open) {
            actionsMenu.style.position = 'fixed';
            actionsMenu.style.left = '8px';
            actionsMenu.style.right = '8px';
            actionsMenu.style.top = '60px';
        }
    }
    if (e && e.stopPropagation) e.stopPropagation();
}

/**
 * Place a building or select a cell
 */
function placeOrSelect(id) {
    // Direct click on an enemy building always opens the sabotage menu,
    // regardless of which mode (or no mode) is currently selected.
    const enemy = game.enemyBuildings.find(b => b.id === id);
    if (enemy) {
        showSabotageMenu(id);
        return;
    }

    if (!game.selectedMode) return;

    const cell = document.querySelector('[data-id="' + id + '"]');

    if (game.selectedMode === 'sabotage') {
        // No enemy on this cell — nothing to target
        return;
    } else if (game.selectedMode === 'strike') {
        // Strike mode: target enemy buildings in AoE
        executeNuclearStrike(id);
    } else {
        // For building placement, check that cell is empty
        if (cell.innerHTML && cell.innerHTML !== '') return; // Already occupied
        if (socket?.connected && _authJWT) {
            // Server validates, deducts wallet, and broadcasts building:placed back to all players
            socket.emit('building:place', { jwt: _authJWT, cellId: id, type: game.selectedMode });
        } else {
            buildBuilding(id, game.selectedMode);
        }
    }
}

/**
 * Build a building at the specified cell
 */
function buildBuilding(id, type) {
    // Special handling for silos (nuclear weapons)
    if (type === 'silo') {
        // Check if player has at least 1 completed reactor
        const completedReactors = game.buildings.filter(b => b.type === 'plant' && !b.isUnderConstruction).length;
        if (completedReactors === 0) {
            const cell = document.querySelector('[data-id="' + id + '"]');
            if (cell) {
                const rect = cell.getBoundingClientRect();
                const msg = `<div style="font-weight:700; color:#ff6b6b;">🔴 Weapons Grade Requirement</div>` +
                    `<div>You must have at least 1 completed Reactor to build a Silo.</div>`;
                showTooltipAt(rect.right + 8, rect.top, msg);
            }
            console.warn('Cannot build silo without completed reactor');
            addNotification('warning', '🔴 Silo blocked. You need at least 1 completed Reactor first.');
            return;
        }
        
        // Check if player hasn't exceeded max silos this round
        const existingSilos = game.buildings.filter(b => b.type === 'silo').length;
        if (existingSilos >= game.maxSilosPerRound) {
            const cell = document.querySelector('[data-id="' + id + '"]');
            if (cell) {
                const rect = cell.getBoundingClientRect();
                const msg = `<div style="font-weight:700; color:#ff6b6b;">🔴 Arsenal Limit Reached</div>` +
                    `<div>Maximum ${game.maxSilosPerRound} silo(s) per round.</div>`;
                showTooltipAt(rect.right + 8, rect.top, msg);
            }
            console.warn('Exceeded max silos per round');
            addNotification('warning', `🔴 Silo limit reached. Max ${game.maxSilosPerRound} per round.`);
            return;
        }
    }
    
    // disallow building directly on road tiles
    if (game.terrain && (game.terrain[id] === 'road' || game.terrain[id] === 'road-h' || game.terrain[id] === 'road-x')) {
        const cell = document.querySelector('[data-id="' + id + '"]');
        if (cell) {
            const rect = cell.getBoundingClientRect();
            const msg = `<div style="font-weight:700; color:#ff6b6b;">Cannot build on road</div>` +
                `<div>Building close to road access increases productivity.</div>`;
            showTooltipAt(rect.right + 8, rect.top, msg);
        }
        console.warn('Cannot build on road tile');
        return;
    }

    const cost = buildingTypes[type].cost;
    if (game.playerWallet < cost) {
        console.warn('Insufficient funds');
        addNotification('danger', `💸 Not enough tokens to build ${displayNames[type] || type} (need ${cost.toLocaleString()}, have ${game.playerWallet.toLocaleString()}).`);
        return;
    }

    game.playerWallet -= cost;
    game.tokensBurned += cost;
    game.prizePool += Math.floor(cost * 0.10);
    // show floating cost indicator — sync display to true wallet at this moment
    game._walletShown = game.playerWallet;
    game._walletMarketBaseline = game.market.price;
    const _walletEl = document.getElementById('wallet');
    if (_walletEl) showFloatingText('-' + cost.toLocaleString(), '#ff6b6b', _walletEl);
    // drain liquidity pool → pushes price up via bonding curve
    game.market.tokenPool = Math.max(1, game.market.tokenPool - cost / game.market.poolBurnRate);
    game.buildings.push({ 
        id, 
        type, 
        owner: game.playerName || 'You',
        ownerId: getLocalPlayerId() || 'local',
        ownerAvatar: game.playerAvatar || DEFAULT_PLAYER_AVATAR,
        constructionTimeRemaining: buildingTypes[type].constructionTime,
        isUnderConstruction: true
    });

    const _depositBonus = (type === 'mine') ? getDepositBonus(id) : null;
    const _roadBonus    = (type === 'plant') ? cellHasRoadNeighbor(id) : false;
    let _buildMsg = `🛠️ ${displayNames[type] || type} construction started. Cost: -${cost.toLocaleString()} tokens.`;
    if (_depositBonus !== null) {
        const _qi = _depositBonus === 1.5 ? '💰 On deposit (1.5× yield!)' :
                    _depositBonus === 1.25 ? '💰 Near deposit (1.25× yield)' :
                    _depositBonus === 0.7  ? '⚠️ Far from deposit (0.7× yield)' :
                    '❌ Off-deposit (0.1× yield — consider moving!)';
        _buildMsg += ` ${_qi}`;
    }
    if (_roadBonus) _buildMsg += ' 🛣️ Road bonus active (+40% income).';
    addNotification('success', _buildMsg);

    if (type === 'storage') {
        game.maxStorage += 1000;
    }

    const building = game.buildings.find(b => b.id === id && b.type === type);
    renderBuilding(id, type, true, building);
    calculateProximity();
    updateUI();
    game.selectedMode = null;
}

/**
 * Show sabotage attack menu for enemy building
 */
function showSabotageMenu(cellId) {
    const enemy = game.enemyBuildings.find(b => b.id === cellId);
    if (!enemy) return;

    const cell = document.querySelector('[data-id="' + cellId + '"]');
    if (!cell) return;

    const rect = cell.getBoundingClientRect();

    // Compute viewport-safe position — prefer right of cell, fall back to left
    const menuW = 248; // slightly over min-width for safety margin
    const menuH = 220; // estimated max height
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let menuLeft = rect.right + 8;
    if (menuLeft + menuW > vw - 8) {
        menuLeft = rect.left - menuW - 8; // try left side
    }
    menuLeft = Math.max(8, Math.min(vw - menuW - 8, menuLeft)); // hard clamp
    const menuTop = Math.max(8, Math.min(vh - menuH - 8, rect.top));

    // Create menu
    const menu = document.createElement('div');
    menu.className = 'sabotage-menu';
    menu.style.cssText = `
        position: fixed;
        left: ${menuLeft}px;
        top: ${menuTop}px;
        background: rgba(0, 0, 0, 0.95);
        border: 1px solid #f57c00;
        border-radius: 4px;
        padding: 8px 0;
        z-index: 100;
        min-width: 240px;
        max-width: calc(100vw - 16px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.8);
    `;

    const completedSilo = game.buildings.find(b => b.type === 'silo' && !b.isUnderConstruction);
    const tempDisableCost = 300;
    const stealCost = 500;
    const nukeCost = Math.floor(game.playerWallet * 0.5);

    // Option 1: Temporary Disable
    const tempOption = document.createElement('div');
    tempOption.style.cssText = `
        padding: 10px 14px;
        cursor: pointer;
        color: #fff;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        transition: background 0.1s;
    `;
    tempOption.innerHTML = `<div style="font-weight:600; color:#ffa500;">⏸️ Disable</div><div style="font-size:12px; color:#aaa; margin-top:2px;">Production -50% for 45s (costs $${tempDisableCost})</div>`;
    tempOption.onmouseover = () => tempOption.style.background = 'rgba(255, 124, 0, 0.1)';
    tempOption.onmouseout = () => tempOption.style.background = '';
    tempOption.onclick = () => {
        executeTemporaryDisable(cellId, tempDisableCost);
        menu.remove();
    };
    menu.appendChild(tempOption);

    // Option 2: Steal Resources
    const stealOption = document.createElement('div');
    stealOption.style.cssText = `
        padding: 10px 14px;
        cursor: pointer;
        color: #fff;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        transition: background 0.1s;
    `;
    stealOption.innerHTML = `<div style="font-weight:600; color:#4db8ff;">💰 Steal</div><div style="font-size:12px; color:#aaa; margin-top:2px;">Steal ~50 U from enemy (costs $${stealCost})</div>`;
    stealOption.onmouseover = () => stealOption.style.background = 'rgba(77, 184, 255, 0.1)';
    stealOption.onmouseout = () => stealOption.style.background = '';
    stealOption.onclick = () => {
        executeStealResources(cellId, stealCost);
        menu.remove();
    };
    menu.appendChild(stealOption);

    // Option 3: Nuclear Strike (only if silo exists)
    if (completedSilo) {
        const nukeOption = document.createElement('div');
        nukeOption.style.cssText = `
            padding: 10px 14px;
            cursor: pointer;
            color: #fff;
            transition: background 0.1s;
        `;
        nukeOption.innerHTML = `<div style="font-weight:600; color:#ff4444;">💥 NUKE</div><div style="font-size:12px; color:#aaa; margin-top:2px;">Destroy in AoE + fallout (costs $${nukeCost})</div>`;
        nukeOption.onmouseover = () => nukeOption.style.background = 'rgba(255, 0, 0, 0.2)';
        nukeOption.onmouseout = () => nukeOption.style.background = '';
        nukeOption.onclick = () => {
            executeNuclearStrike(cellId);
            menu.remove();
        };
        menu.appendChild(nukeOption);
    } else {
        const nukeOption = document.createElement('div');
        nukeOption.style.cssText = `
            padding: 10px 14px;
            color: #666;
            border-bottom: none;
        `;
        nukeOption.innerHTML = `<div style="font-weight:600; color:#666;">💥 NUKE (Locked)</div><div style="font-size:12px; color:#555; margin-top:2px;">Requires completed Silo</div>`;
        menu.appendChild(nukeOption);
    }

    document.body.appendChild(menu);

    // Close menu when clicking elsewhere
    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
            game.selectedMode = null;
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

/**
 * Temporary disable: reduce enemy production by 50% for 45 seconds
 */
function executeTemporaryDisable(cellId, cost) {
    const enemy = game.enemyBuildings.find(b => b.id === cellId);
    if (!enemy) return;

    if (socket?.connected && _authJWT) {
        socket.emit('sabotage:execute', { jwt: _authJWT, cellId, attackType: 'disable' });
        game.selectedMode = null;
        return;
    }

    if (game.playerWallet < cost) {
        console.warn('Insufficient funds');
        return;
    }

    game.playerWallet -= cost;
    game.tokensBurned += cost;
    game.prizePool += Math.floor(cost * 0.10);
    game.market.tokenPool = Math.max(1, game.market.tokenPool - cost / game.market.poolBurnRate);
    game._walletShown = game.playerWallet;
    game._walletMarketBaseline = game.market.price;
    const _wEl1 = document.getElementById('wallet');
    if (_wEl1) showFloatingText('-' + cost.toLocaleString(), '#ff6b6b', _wEl1);

    // Mark enemy as disabled
    if (!enemy.disabled) {
        enemy.disabled = { endTime: Date.now() + 45000, multiplier: 0.5 };
    }

    console.info(`⏸️ Temporary disable on ${enemy.type} for 45s`);
    addNotification('warning', `⏸️ Disabled enemy ${displayNames[enemy.type] || enemy.type}. Production cut to 50% for 45s.`);
    updateUI();
    game.selectedMode = null;
}

/**
 * Steal resources: take uranium from enemy
 */
function executeStealResources(cellId, cost) {
    const enemy = game.enemyBuildings.find(b => b.id === cellId);
    if (!enemy) return;

    if (socket?.connected && _authJWT) {
        socket.emit('sabotage:execute', { jwt: _authJWT, cellId, attackType: 'steal' });
        game.selectedMode = null;
        return;
    }

    if (game.playerWallet < cost) {
        console.warn('Insufficient funds');
        return;
    }

    game.playerWallet -= cost;
    game.tokensBurned += cost;
    game.prizePool += Math.floor(cost * 0.10);
    game.market.tokenPool = Math.max(1, game.market.tokenPool - cost / game.market.poolBurnRate);
    game._walletShown = game.playerWallet;
    game._walletMarketBaseline = game.market.price;
    const _wEl2 = document.getElementById('wallet');
    if (_wEl2) showFloatingText('-' + cost.toLocaleString(), '#ff6b6b', _wEl2);

    // Steal uranium
    const stolen = 25 + Math.random() * 50; // 25-75 uranium
    game.uraniumRaw += stolen;

    console.info(`💰 Stole ${stolen.toFixed(1)} uranium from enemy`);
    addNotification('success', `💰 Stole ${stolen.toFixed(1)} U from enemy ${displayNames[enemy.type] || enemy.type}.`);
    updateUI();
    game.selectedMode = null;
}

/**
 * Execute a nuclear strike on target cell
 * Destroys all enemy buildings within AoE radius + applies radiation fallout
 */
function executeNuclearStrike(targetId) {
    // Check cooldown
    if (game.dayStrikes >= game.maxSilosPerRound) {
        console.warn('Strike cooldown active');
        addNotification('warning', '⚠️ Nuclear strike on cooldown. Only 1 strike allowed per day.');
        return;
    }
    
    // Check for completed silo available
    const completedSilo = game.buildings.find(b => b.type === 'silo' && !b.isUnderConstruction);
    if (!completedSilo) {
        console.warn('No completed silo available');
        return;
    }

    if (socket?.connected && _authJWT) {
        socket.emit('sabotage:execute', { jwt: _authJWT, cellId: targetId, attackType: 'nuke' });
        game.dayStrikes++;
        game.selectedMode = null;
        return;
    }

    // Strike cost: 40-60% of current wallet
    const costPercent = 0.5; // 50% for balanced gameplay
    const strikeCost = Math.floor(game.playerWallet * costPercent);
    
    if (game.playerWallet < strikeCost) {
        console.warn('Insufficient funds for nuclear strike');
        return;
    }
    
    // Deduct cost
    game.playerWallet -= strikeCost;
    game.tokensBurned += strikeCost;
    game.prizePool += Math.floor(strikeCost * 0.10);
    game.market.tokenPool = Math.max(1, game.market.tokenPool - strikeCost / game.market.poolBurnRate);
    game._walletShown = game.playerWallet;
    game._walletMarketBaseline = game.market.price;
    const _wEl3 = document.getElementById('wallet');
    if (_wEl3) showFloatingText('-' + strikeCost.toLocaleString(), '#ff6b6b', _wEl3);
    
    // Execute strike
    triggerNuclearExplosion(targetId);
    
    // Update tracking
    game.dayStrikes++;
    const playerName = game.players.find(p => p.isLocal)?.name || 'YOU';
    if (!game.nuclearThreats.includes(playerName)) {
        game.nuclearThreats.push(playerName);
    }
    
    game.selectedMode = null;
    updateUI();
}

/**
 * Trigger explosion and AoE destruction
 */
function triggerNuclearExplosion(centerId) {
    const strikeRadius = 4; // cells
    const coords = getCoords(centerId);
    
    // Calculate target buildings in radius
    const destroyed = [];
    game.enemyBuildings = game.enemyBuildings.filter(b => {
        const bCoords = getCoords(b.id);
        const dist = Math.max(Math.abs(bCoords.x - coords.x), Math.abs(bCoords.y - coords.y));
        if (dist <= strikeRadius) {
            destroyed.push(b);
            return false; // Remove from array
        }
        return true;
    });
    
    // Visual effects: red flash and screen shake
    playNuclearEffects();
    
    // Clear destroyed buildings from display
    destroyed.forEach(b => {
        const cell = document.querySelector('[data-id="' + b.id + '"]');
        if (cell) {
            cell.innerHTML = '';
            cell.className = 'cell';
        }
    });
    
    // Apply radiation fallout: −50% production for 120 seconds
    const falloutTime = 120; // seconds
    const falloutRadius = strikeRadius + 1; // slightly larger radius
    game.buildings.forEach(b => {
        if (!b.isUnderConstruction && (b.type === 'mine' || b.type === 'processor')) {
            const bCoords = getCoords(b.id);
            const dist = Math.max(Math.abs(bCoords.x - coords.x), Math.abs(bCoords.y - coords.y));
            if (dist <= falloutRadius) {
                if (!b.fallout) {
                    b.fallout = { endTime: Date.now() + (falloutTime * 1000), multiplier: 0.5 };
                }
            }
        }
    });
    
    console.info(`💥 Nuclear strike at cell ${centerId}! ${destroyed.length} enemy buildings destroyed.`);
    addNotification('danger', `💥 Nuclear strike! ${destroyed.length} enemy building${destroyed.length !== 1 ? 's' : ''} destroyed. Watch for fallout.`);
}

/**
 * Play nuclear effect visuals/audio
 */
function playNuclearEffects() {
    // Full-screen red flash
    const flash = document.createElement('div');
    flash.style.cssText = `
        position: fixed; left: 0; top: 0; right: 0; bottom: 0;
        background: rgba(255, 0, 0, 0.8);
        z-index: 8000;
        animation: fadeOut 0.6s ease-out;
        pointer-events: none;
    `;
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 600);
    
    // Screen shake
    const originalTransform = document.body.style.transform;
    for (let i = 0; i < 10; i++) {
        setTimeout(() => {
            const x = (Math.random() - 0.5) * 20;
            const y = (Math.random() - 0.5) * 20;
            document.body.style.transform = `translate(${x}px, ${y}px)`;
        }, i * 30);
    }
    setTimeout(() => {
        document.body.style.transform = originalTransform;
    }, 300);
}

/**
 * Render a building on the grid
 */
function renderBuilding(id, type, isPlayer, building) {
    const cell = document.querySelector('[data-id="' + id + '"]');
    cell.className = 'cell owned ' + type + (isPlayer ? ' owned-player' : ' owned-enemy');

    // Check if building is under construction
    const isUnderConstruction = building && building.isUnderConstruction;
    
    if (isUnderConstruction && building) {
        // Render progress circle
        const progress = 1 - (building.constructionTimeRemaining / buildingTypes[type].constructionTime);
        const circumference = 2 * Math.PI * 45; // 45 = radius
        const strokeDashoffset = circumference * (1 - progress);
        
        const tint = isPlayer ? PLAYER_COLOR : ENEMY_COLOR;
        const emoji = buildingTypes[type].emoji || '';
        
        cell.innerHTML = `
            <div style="position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;">
                <svg style="position: absolute; width: 100%; height: 100%; top: 0; left: 0;" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3"/>
                    <circle cx="50" cy="50" r="45" fill="none" stroke="${tint}" stroke-width="3" 
                            stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}"
                            stroke-linecap="round" style="transition: stroke-dashoffset 0.1s linear; transform: rotate(-90deg); transform-origin: 50px 50px;"/>
                </svg>
                <span class="icon-emoji" style="font-size: 20px; z-index: 1; opacity: 0.6;">${emoji}</span>
            </div>
        `;
    } else {
        // Render normal building
        const tint = isPlayer ? PLAYER_COLOR : ENEMY_COLOR;
        if (USE_SVG_ICONS || type === 'storage') {
            const svg = getIconSVG(type, tint);
            cell.innerHTML = svg;
        } else {
            const emoji = buildingTypes[type].emoji || '';
            cell.innerHTML = `<span class="icon-emoji" style="color:${tint};">${emoji}</span>`;
        }
    }
}

// Return a small inline SVG string for the given building type, monochrome so
// it can be tinted via `fill`.
function getIconSVG(type, fill) {
    // Keep SVGs simple and small for grid clarity.
    if (type === 'mine') {
        return `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><path fill="${fill}" d="M2 20h20L12 6 2 20z"/></svg>`;
    }
    if (type === 'processor') {
        return `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="6" fill="${fill}"/></svg>`;
    }
    if (type === 'storage') {
        // Silo / vault style storage icon (tintable)
        return `<svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg"><ellipse cx="12" cy="4.5" rx="6" ry="2" fill="${fill}"/><rect x="6" y="4.5" width="12" height="13" rx="2" ry="2" fill="${fill}"/><path d="M9 9h6v6H9z" fill="#ffffff" opacity="0.12"/></svg>`;
    }
    // plant / reactor
    return `<svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg"><path fill="${fill}" d="M12 2c-1.1 0-2 .9-2 2v3H8c-1.1 0-2 .9-2 2v3h12V9c0-1.1-.9-2-2-2h-2V4c0-1.1-.9-2-2-2z"/></svg>`;
}

/**
 * Get grid coordinates from cell ID
 */
function getCoords(id) {
    return { x: id % 20, y: Math.floor(id / 20) };
}

/**
 * Calculate distance between two cells (Chebyshev distance)
 */
function distance(id1, id2) {
    const c1 = getCoords(id1);
    const c2 = getCoords(id2);
    return Math.max(Math.abs(c1.x - c2.x), Math.abs(c1.y - c2.y));
}

/**
 * Calculate proximity bonuses and penalties
 */
function calculateProximity() {
    document.querySelectorAll('.cell').forEach(c => {
        c.classList.remove('bonus', 'penalty');
    });

    game.buildings.forEach(building => {
        let bonus = 0;
        let penalty = 0;

        // Count nearby same-type buildings
        game.buildings.forEach(other => {
            if (building.id !== other.id && building.type === other.type) {
                if (distance(building.id, other.id) <= game.proximityRange) {
                    bonus++;
                }
            }
        });

        // Count nearby enemy buildings
        game.enemyBuildings.forEach(enemy => {
            if (distance(building.id, enemy.id) <= game.proximityRange) {
                penalty++;
            }
        });

        const cell = document.querySelector('[data-id="' + building.id + '"]');
        if (bonus > 0) cell.classList.add('bonus');
        if (penalty > 0) cell.classList.add('penalty');
    });
}

/**
 * Calculate total power output
 */
function calculatePower() {
    let totalPower = 0;
    let totalMines = 0;
    let totalProcessors = 0;

    game.buildings.forEach(building => {
        // Only count completed buildings for power calculation
        if (building.isUnderConstruction) return;
        
        if (building.type === 'plant') {
            let penalty = 0;
            game.enemyBuildings.forEach(enemy => {
                if (distance(building.id, enemy.id) <= game.proximityRange) {
                    penalty++;
                }
            });
            // base power reduced by nearby enemy penalty
            const base = 100 - (penalty * 20);
            // slight jitter so power fluctuates a bit (not game-breaking)
            const jitter = Math.sin((Date.now() / 1000) + building.id) * 2; // -2..2
            // road-proximity bonus: reactor next to a road tile sells power to more customers (+40%)
            const roadMult = cellHasRoadNeighbor(building.id) ? 1.4 : 1.0;
            // same-type proximity bonus: nearby reactors share grid load (+25% per neighbor, cap 3)
            let samePlants = 0;
            game.buildings.forEach(other => {
                if (other.id !== building.id && other.type === 'plant' && !other.isUnderConstruction
                    && distance(building.id, other.id) <= game.proximityRange) samePlants++;
            });
            const plantProxMult = 1 + (Math.min(samePlants, 3) * 0.25);
            const power = Math.max(0, base + jitter) * roadMult * plantProxMult;
            totalPower += power;
        } else if (building.type === 'mine') {
            totalMines++;
        } else if (building.type === 'processor') {
            totalProcessors++;
        }
    });

    // Simplified: power is computed from plants and proximity; do NOT modify
    // uraniumRaw/uraniumRefined here — production/consumption is handled in productionTick.
    return totalPower;
}

/**
 * Update UI with current game state
 */
function updateUI() {
    // Only display the wallet value that corresponds to a visible float event.
    // _walletShown is set when income/spend floats fire; stays frozen between events.
    if (game._walletShown === undefined) game._walletShown = game.playerWallet;
    setWalletDisplay(game._walletShown);
    document.getElementById('uranium').textContent = formatUranium(game.uraniumRaw) + ' / ' + formatUranium(game.uraniumRefined);
    const totalStored = game.uraniumRaw + game.uraniumRefined;
    document.getElementById('stored').textContent = formatUranium(totalStored) + '/' + formatUranium(game.maxStorage);
    
    const power = calculatePower();
    // show power with one decimal place to avoid long floats
    document.getElementById('power').textContent = power.toFixed(1) + ' MW';
    // time and market
    const hh = String(Math.floor(game.time.hour)).padStart(2, '0');
    const mm = String(Math.floor(game.time.minute)).padStart(2, '0');
    // derive seconds from fractional minute
    const fractionalMinute = game.time.minute - Math.floor(game.time.minute);
    const ss = String(Math.floor(fractionalMinute * 60)).padStart(2, '0');
    const timeEl = document.getElementById('time');
    if (timeEl) timeEl.textContent = hh + ':' + mm + ':' + ss;
    const dayEl = document.getElementById('day');
    if (dayEl) dayEl.textContent = game.time.day;
    const marketEl = document.getElementById('marketPrice');
    if (marketEl) {
        marketEl.textContent = '$' + game.market.price.toFixed(2);
        // color up/down compared to previous price (if available)
        if (game.market.prevPrice === undefined) {
            marketEl.style.color = '';
        } else if (game.market.price > game.market.prevPrice) {
            marketEl.style.color = '#4CAF50';
        } else if (game.market.price < game.market.prevPrice) {
            marketEl.style.color = '#ff6b6b';
        } else {
            marketEl.style.color = '';
        }
    }
    // income display (last production tick)
    const incomeEl = document.getElementById('income');
    if (incomeEl) incomeEl.textContent = (game.lastIncome || 0).toLocaleString();

    // portfolio value = wallet + uranium * market.price — updates every tick so it breathes with market
    const portfolioEl = document.getElementById('portfolio');
    if (portfolioEl) {
        const value = game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price);
        setPortfolioDisplay(value);
    }

    // live rank — recalculated every UI update
    const rankEl = document.getElementById('rank');
    if (rankEl && game.players && game.players.length) {
        const localScore = calculatePower() + (game.playerWallet / 1000);
        const botScores = game.players.filter(p => p.isBot).map(p => {
            const botB = game.enemyBuildings.filter(b => b.owner === p.name);
            const plants = botB.filter(b => b.type === 'plant').length;
            const mines  = botB.filter(b => b.type === 'mine').length;
            return (plants * 100) + (mines * 50 * game.market.price / 1000);
        });
        const rank = 1 + botScores.filter(s => s > localScore).length;
        rankEl.textContent = '#' + rank;
    }

    // Token economy stats
    const circulatingEl = document.getElementById('circulating');
    if (circulatingEl) {
        // circulating = tokens that have left the 1B reserve minus what's been burned
        const circ = Math.max(0, game.tokensIssued - game.tokensBurned);
        circulatingEl.textContent = formatSupply(circ);
    }
    const prizePoolEl = document.getElementById('prizePool');
    if (prizePoolEl) {
        prizePoolEl.textContent = formatPrizePool(game.prizePool);
        prizePoolEl.title = `Approximate fiat equivalent at ${game.tokensPerUSD.toLocaleString()} tokens = $1 USDC`;
    }
    // Update compact mobile stats bar (mobile portrait only)
    const mobileStats = document.getElementById('mobileStatsCompact');
    if (mobileStats) {
        if (window.innerWidth <= 620) {
            const portfolio = (game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price)) || 0;
            const timeStr = `${String(Math.floor(game.time.hour)).padStart(2,'0')}:${String(Math.floor(game.time.minute)).padStart(2,'0')}:${String(Math.floor((game.time.minute % 1) * 60)).padStart(2,'0')}`;  // HH:MM:SS
            const totalPower = game.buildings.filter(b => b.type === 'plant' && !b.isUnderConstruction)
                .reduce((s) => s + (buildingTypes.plant.power || 0), 0);
            const prizeStr = typeof formatPrizePool === 'function' ? formatPrizePool(game.prizePool) : game.prizePool.toLocaleString();
            mobileStats.innerHTML = [
                `<span class="ms-stat"><span class="ms-label">Round</span><span class="ms-val">${game.round}/${game.runLength}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Day</span><span class="ms-val">${game.time.day}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Time</span><span class="ms-val">${timeStr}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Tokens</span><span class="ms-val">${game.playerWallet.toLocaleString()}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Power</span><span class="ms-val">${totalPower}MW</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Market</span><span class="ms-val">$${game.market.price.toFixed(2)}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Prize</span><span class="ms-val ms-val--amber">${prizeStr}</span></span>`,
                `<span class="ms-stat"><span class="ms-label">Portfolio</span><span class="ms-val">$${portfolio.toFixed(2)}</span></span>`,
            ].join('');
            mobileStats.style.display = 'flex';
        } else {
            mobileStats.style.display = 'none';
        }
    }
}

/**
 * Format a large token number as a compact string: 1B, 999.9M, 1.5M, 659K, 500
 * Used anywhere the 1-billion supply is displayed.
 */
function formatSupply(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) {
        const decimals = n >= 1e8 ? 1 : 2;
        const mStr = (n / 1e6).toFixed(decimals);
        // if toFixed rounds up to 1000.x, promote to B to avoid "1000.0M"
        if (parseFloat(mStr) >= 1000) return (n / 1e9).toFixed(2) + 'B';
        return mStr + 'M';
    }
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 1 : 2) + 'K';
    return Math.floor(n).toLocaleString();
}

/**
 * Format a prize-pool / token amount as USD + tokens.
 * Returns string like: "$6.00 USDC (12,000 tokens)"
 */
function formatCompactNumber(n) {
    const num = Number(n) || 0;
    if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return num.toFixed(0);
}

/**
 * Format a prize-pool / token amount as compact USD + compact tokens.
 * Default compact output: "$6.0K USDC (12K tokens)"
 */
function formatPrizePool(tokens, compact = true) {
    const t = Number(tokens) || 0;
    const rate = (game && game.tokensPerUSD) ? Number(game.tokensPerUSD) : 2000;
    const usd = t / Math.max(1, rate);
    if (compact) {
        const usdCompact = formatCompactNumber(usd);
        const tokenCompact = formatCompactNumber(t);
        return `$${usdCompact} USDC (${tokenCompact} tokens)`;
    }
    // verbose fallback
    const usdStr = usd >= 1000 ? usd.toLocaleString(undefined, {maximumFractionDigits:0}) : usd.toFixed(2);
    return `$${usdStr} USDC (${t.toLocaleString()} tokens)`;
}

/**
 * Format a uranium quantity:
 *  - Under 1000 → always show 2 decimal places (e.g. "0.00", "45.72")
 *  - 1 000+ → compact suffix with 2dp    (e.g. "1.50K", "2.30M")
 */
function formatUranium(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K';
    return (+n).toFixed(2);
}

/**
 * Initialize game on page load
 */
function startGame(serverMode) {
    // Reveal game-only menu items now that the run has started
    // Use explicit display values to override the .game-only { display:none } CSS rule
    document.querySelectorAll('.game-only').forEach(el => {
        el.style.display = el.tagName === 'BUTTON' ? 'flex' : 'block';
    });

    if (!serverMode) {
        // Offline / single-player: build grid and run from scratch
        initGrid();
        initRun();
    }
    // In server-mode, run:state already set game.players, buildings, wallet, etc.
    updateUI();
    // initialize toolbar/menu interactions
    initMenu();
    console.log('Game started');
    // start simulation loops
    startSimLoops();
    // attach button tooltips
    addButtonTooltips();
}

function authenticate() {
    document.body.classList.add('authenticated');
    const modal = document.getElementById('loginModal');
    if (modal) modal.style.display = 'none';
    sessionStorage.setItem('nuke_auth', '1');
    // Pre-render the game map so it's visible behind the lobby
    initGrid();
    // Ask the server for the active run state (will show lobby or drop into game)
    if (socket?.connected && _authJWT) {
        socket.emit('run:join', { jwt: _authJWT });
    } else {
        // Server unavailable — fall back to single-player mode
        showLobby();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Lobby
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show the pre-run lobby modal.
 * When server-connected, called only for offline/fallback. The live path goes:
 *   authenticate() → socket.emit('run:join') → run:state event →
 *     _updateLobbyFromServerState() → lobbyModal shown.
 * The offline path calls showLobby() directly with bot players.
 */
function showLobby() {
    initPlayerRegistry(); // populate game.players (no buy-in yet)

    // Hide game-only menu items while in lobby
    document.querySelectorAll('.game-only').forEach(el => el.style.display = 'none');

    const modal = document.getElementById('lobbyModal');
    if (!modal) { startGame(); return; } // fallback if modal missing

    // prize pool preview = 80% of all buy-ins
    const preview = Math.floor(game.players.length * game.buyIn * 0.80);

    const lobbyBuyInEl = document.getElementById('lobbyBuyIn');
    const lobbyPrizeEl = document.getElementById('lobbyPrizePreview');
    const lobbyWalletAfterEl = document.getElementById('lobbyWalletAfter');
    if (lobbyBuyInEl) lobbyBuyInEl.textContent = game.buyIn.toLocaleString();
    const lobbyBuyInBtnEl = document.getElementById('lobbyBuyInBtn');
    if (lobbyBuyInBtnEl) lobbyBuyInBtnEl.textContent = game.buyIn.toLocaleString();
    if (lobbyPrizeEl) lobbyPrizeEl.textContent = formatPrizePool(preview);
    if (lobbyWalletAfterEl) lobbyWalletAfterEl.textContent = (game.playerWallet - game.buyIn).toLocaleString();

    // render player rows
    const list = document.getElementById('lobbyPlayerList');
    if (list) {
        list.innerHTML = game.players.map(p =>
            `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #1e1e1e; gap:8px;">
                <span style="display:inline-flex;align-items:center;gap:6px;color:${p.isLocal ? '#ffb84d' : '#888'};">${avatarBadge(p.avatar || DEFAULT_PLAYER_AVATAR)} ${escapeHtml(p.name)}${p.isBot ? ' <span style="font-size:10px; color:#555;">[BOT]</span>' : ''}</span>
                <span style="color:#4CAF50;">${p.wallet.toLocaleString()} tokens</span>
            </div>`
        ).join('');
    }

    modal.style.display = 'flex';
}

/**
 * Player confirmed buy-in — deduct tokens, seed pools, launch run.
 */
function confirmBuyIn() {
    if (socket?.connected && _authJWT) {
        // Server-mode: deduction + validation happens server-side.
        // The run:state event already joined us; just close the lobby and start.
        const modal = document.getElementById('lobbyModal');
        if (modal) modal.style.display = 'none';
        startGame(true); // server-mode
    } else {
        // Offline fallback
        if (game.playerWallet < game.buyIn) {
            const errEl = document.getElementById('lobbyError');
            if (errEl) errEl.textContent = 'Insufficient tokens for buy-in.';
            return;
        }
        const modal = document.getElementById('lobbyModal');
        if (modal) modal.style.display = 'none';
        startGame();
    }
}

/* Profile modal handlers */
function renderAvatarPicker(pickerId, selectedAvatar = DEFAULT_PLAYER_AVATAR) {
    const picker = document.getElementById(pickerId);
    if (!picker) return;

    const activeAvatar = selectedAvatar || picker.dataset.selectedAvatar || DEFAULT_PLAYER_AVATAR;
    picker.dataset.selectedAvatar = activeAvatar;
    picker.innerHTML = AVATAR_OPTIONS.map((avatar) => `
        <button type="button" class="avatar-option ${avatar === activeAvatar ? 'selected' : ''}" data-avatar="${avatar}" aria-label="Select ${avatar} avatar">${avatar}</button>
    `).join('');

    picker.querySelectorAll('.avatar-option').forEach((btn) => {
        btn.addEventListener('click', () => {
            picker.dataset.selectedAvatar = btn.dataset.avatar;
            if (pickerId === 'profileAvatarPicker') {
                const avatarDisplay = document.getElementById('profileAvatarDisplay');
                if (avatarDisplay) avatarDisplay.textContent = btn.dataset.avatar;
            }
            renderAvatarPicker(pickerId, btn.dataset.avatar);
        });
    });
}

function getSelectedAvatar(pickerId) {
    const picker = document.getElementById(pickerId);
    return picker?.dataset.selectedAvatar || game.playerAvatar || DEFAULT_PLAYER_AVATAR;
}

function showAccountSetupStep() {
    const modal = document.getElementById('loginModal');
    if (modal) modal.style.display = 'flex';
    const step1 = document.getElementById('loginStep1');
    const step2 = document.getElementById('loginStep2');
    const step3 = document.getElementById('loginStep3');
    if (step1) step1.style.display = 'none';
    if (step2) step2.style.display = 'none';
    if (step3) step3.style.display = 'block';

    const input = document.getElementById('signupUsername');
    if (input) {
        input.value = game.playerName || '';
        input.focus();
        input.select();
    }

    const msgEl = document.getElementById('loginError3');
    if (msgEl) {
        msgEl.style.color = '#888';
        msgEl.textContent = 'Pick your commander name and profile icon.';
    }

    renderAvatarPicker('signupAvatarPicker', game.playerAvatar || DEFAULT_PLAYER_AVATAR);
}

function showProfile() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    const walletEl = document.getElementById('profileWallet');
    if (walletEl) walletEl.textContent = (game.playerWallet || 0).toLocaleString() + ' tokens';
    const nameEl = document.getElementById('profileName');
    if (nameEl) nameEl.textContent = game.playerName || 'You';
    const emailEl = document.getElementById('profileEmail');
    if (emailEl) emailEl.textContent = game.playerEmail || '';
    const usernameInput = document.getElementById('profileUsernameInput');
    if (usernameInput) usernameInput.value = game.playerName || '';
    const avatarDisplay = document.getElementById('profileAvatarDisplay');
    if (avatarDisplay) avatarDisplay.textContent = game.playerAvatar || DEFAULT_PLAYER_AVATAR;
    renderAvatarPicker('profileAvatarPicker', game.playerAvatar || DEFAULT_PLAYER_AVATAR);
    const msgEl = document.getElementById('profileUsernameMsg');
    if (msgEl) msgEl.textContent = '';
    const statsEl = document.getElementById('profileStats');
    if (statsEl) {
        const portfolio = (game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price)) || 0;
        statsEl.textContent = `Tokens: ${game.playerWallet.toLocaleString()} — Raw: ${formatUranium(game.uraniumRaw)} / Ref: ${formatUranium(game.uraniumRefined)} — Portfolio: ${Math.round(portfolio).toLocaleString()} tokens`;
    }
    modal.style.display = 'flex';
}

function changeUsername() {
    const input = document.getElementById('profileUsernameInput');
    const msgEl = document.getElementById('profileUsernameMsg');
    if (!input || !msgEl) return;
    const newName = input.value.trim();
    const avatar = getSelectedAvatar('profileAvatarPicker');
    if (!newName || newName.length < 3) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = 'Username must be at least 3 characters.';
        return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = 'Only letters, numbers, and underscores allowed.';
        return;
    }
    if (!socket?.connected || !_authJWT) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = 'Not connected to server.';
        return;
    }
    msgEl.style.color = '#888';
    msgEl.textContent = 'Saving...';
    socket.emit('player:rename', { jwt: _authJWT, username: newName, avatar });
}

function submitAccountSetup() {
    const input = document.getElementById('signupUsername');
    const msgEl = document.getElementById('loginError3');
    if (!input || !msgEl) return;

    const newName = input.value.trim();
    const avatar = getSelectedAvatar('signupAvatarPicker');

    if (!newName || newName.length < 3) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = 'Username must be at least 3 characters.';
        return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(newName)) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = 'Only letters, numbers, and underscores allowed.';
        return;
    }
    if (!socket?.connected || !_authJWT) {
        msgEl.style.color = '#ff6b6b';
        msgEl.textContent = 'Not connected to server.';
        return;
    }

    msgEl.style.color = '#888';
    msgEl.textContent = 'Creating profile...';
    socket.emit('player:rename', { jwt: _authJWT, username: newName, avatar });
}

function closeProfile() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    modal.style.display = 'none';
}

function toggleProfile() {
    const modal = document.getElementById('profileModal');
    if (!modal) return showProfile();
    if (modal.style.display === 'none' || modal.style.display === '') showProfile(); else closeProfile();
}

/* Prize Pool / Conversion modal */
function showConversionModal() {
    const modal = document.getElementById('conversionModal');
    if (!modal) return;

    // Populate dynamic conversion rate text
    const rateEl = document.getElementById('conversionRateText');
    if (rateEl) {
        const rate   = game.tokensPerUSD || 2000;
        const pool   = formatPrizePool(game.prizePool, false);
        const circ   = Math.max(0, game.tokensIssued - game.tokensBurned);
        rateEl.innerHTML =
            `<strong>${rate.toLocaleString()} tokens = $1 USDC</strong>. ` +
            `Current prize pool: ${pool}. ` +
            `Circulating supply: ${formatSupply(circ)} tokens.`;
    }

    modal.style.display = 'flex';
}

function closeConversionModal() {
    const modal = document.getElementById('conversionModal');
    if (!modal) return;
    modal.style.display = 'none';
}

function requestLoginCode() {
    const emailEl = document.getElementById('loginEmail');
    const errEl   = document.getElementById('loginError');
    const email   = (emailEl?.value || '').trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (errEl) errEl.textContent = 'Please enter a valid email address.';
        return;
    }
    if (errEl) errEl.textContent = '';
    if (!socket?.connected) {
        if (errEl) errEl.textContent = 'Not connected to server. Please wait and try again.';
        return;
    }
    const btn = document.getElementById('loginSendBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    socket.emit('auth:request', { email });
    // Re-enable after a delay in case of error
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Send Code'; } }, 8000);
}

function verifyLoginCode() {
    const code  = (document.getElementById('loginCode')?.value || '').trim();
    const email = document.getElementById('loginEmailDisplay')?.textContent || '';
    const errEl = document.getElementById('loginError2');
    if (!code || code.length < 6) {
        if (errEl) errEl.textContent = 'Enter the 6-digit code from your email.';
        return;
    }
    if (errEl) errEl.textContent = '';
    const btn = document.getElementById('loginVerifyBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
    socket.emit('auth:verify', { email, code });
    setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Verify'; } }, 8000);
}

document.addEventListener('DOMContentLoaded', function() {
    // Connect to the server immediately on page load
    connectSocket();

    // Wire login step 1
    const sendBtn  = document.getElementById('loginSendBtn');
    const emailIn  = document.getElementById('loginEmail');
    if (sendBtn) sendBtn.addEventListener('click', requestLoginCode);
    if (emailIn)  emailIn.addEventListener('keyup', (e) => { if (e.key === 'Enter') requestLoginCode(); });

    // Wire login step 2
    const verifyBtn = document.getElementById('loginVerifyBtn');
    const codeIn    = document.getElementById('loginCode');
    const backBtn   = document.getElementById('loginBackBtn');
    const accountBtn = document.getElementById('accountCreateBtn');
    const signupInput = document.getElementById('signupUsername');
    const profileNameInput = document.getElementById('profileUsernameInput');
    if (verifyBtn) verifyBtn.addEventListener('click', verifyLoginCode);
    if (codeIn)    codeIn.addEventListener('keyup', (e) => { if (e.key === 'Enter') verifyLoginCode(); });
    if (accountBtn) accountBtn.addEventListener('click', submitAccountSetup);
    if (signupInput) signupInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') submitAccountSetup(); });
    if (profileNameInput) profileNameInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') changeUsername(); });
    renderAvatarPicker('signupAvatarPicker', game.playerAvatar || DEFAULT_PLAYER_AVATAR);
    renderAvatarPicker('profileAvatarPicker', game.playerAvatar || DEFAULT_PLAYER_AVATAR);
    syncBotToggleUI();
    if (backBtn)   backBtn.addEventListener('click', () => {
        document.getElementById('loginStep1').style.display = 'block';
        document.getElementById('loginStep2').style.display = 'none';
        const step3 = document.getElementById('loginStep3');
        if (step3) step3.style.display = 'none';
        document.getElementById('loginError').textContent = '';
        const setupMsg = document.getElementById('loginError3');
        if (setupMsg) setupMsg.textContent = '';
        document.getElementById('loginEmail').value = '';
    });

    // If a valid JWT is stored, try to reconnect silently
    const saved = localStorage.getItem('nuke_jwt');
    if (saved) {
        // connectSocket() already emits auth:reconnect on 'connect'
        // so nothing extra needed here
    }

    const profileBtn = document.getElementById('profileBtn');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    if (profileBtn) profileBtn.addEventListener('click', toggleProfile);
    if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', toggleMobileMenu);

    const prizeInfoBtn = document.getElementById('prizeInfoBtn');
    if (prizeInfoBtn) prizeInfoBtn.addEventListener('click', showConversionModal);

    // Notification bell
    const bellBtn    = document.getElementById('notifBellBtn');
    const closeBtn   = document.getElementById('notifCloseBtn');
    const clearBtn   = document.getElementById('notifClearBtn');
    if (bellBtn)  bellBtn.addEventListener('click', () => {
        const drawer = document.getElementById('notifDrawer');
        const isOpen = drawer && drawer.classList.contains('notif-drawer--open');
        isOpen ? closeNotifications() : openNotifications();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeNotifications);
    if (clearBtn) clearBtn.addEventListener('click', clearAllNotifications);

    // Close drawer when clicking outside of it
    document.addEventListener('click', (e) => {
        const drawer = document.getElementById('notifDrawer');
        const bell   = document.getElementById('notifBellBtn');
        if (!drawer || !drawer.classList.contains('notif-drawer--open')) return;
        if (!drawer.contains(e.target) && !bell.contains(e.target)) closeNotifications();
    });
});

/* Mobile menu open/close */
function showMobileMenu() {
    const modal = document.getElementById('mobileMenu');
    if (!modal) return;
    const s = document.getElementById('mobileMenuStats');
    if (s) {
        const portfolio = (game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price)) || 0;
        s.innerHTML = `Round: ${game.round} — Tokens: ${game.playerWallet.toLocaleString()} — Raw: ${formatUranium(game.uraniumRaw)} / Ref: ${formatUranium(game.uraniumRefined)} — Portfolio: ${Math.round(portfolio).toLocaleString()} tokens`;
    }
    modal.style.display = 'block';
    document.body.classList.add('mobile-menu-open');
}

function closeMobileMenu() {
    const modal = document.getElementById('mobileMenu');
    if (!modal) return;
    modal.style.display = 'none';
    document.body.classList.remove('mobile-menu-open');
}

function toggleMobileMenu() {
    const modal = document.getElementById('mobileMenu');
    if (!modal) return showMobileMenu();
    if (modal.style.display === 'none' || modal.style.display === '') showMobileMenu(); else closeMobileMenu();
}

/**
 * Start simulation intervals for production and clock.
 */
function startSimLoops() {
    // production tick (gives realtime feel)
    if (!game._productionInterval) {
        game._productionInterval = setInterval(productionTick, 1000);
    }

    // clock tick advances simulated minutes based on minutesPerSecond
    if (!game._clockInterval) {
        // keep a regular interval but advance using real elapsed time
        game._clockInterval = setInterval(clockTick, 500);
        game._lastClockTS = Date.now();
    }

    // bot AI loop — bots build and sabotage dynamically
    startBotAI();
}

/**
 * Update grid visuals for active fallout zones
 */
function updateFalloutVisualization() {
    const grid = document.getElementById('gameGrid');
    const now = Date.now();
    
    // Remove all existing fallout indicators
    grid.querySelectorAll('.cell').forEach(cell => cell.classList.remove('in-fallout'));
    
    // Add fallout class to cells in active fallout zones
    game.falloutZones.forEach(zone => {
        if (zone.endTime > now) {
            const zoneCoords = getCoords(zone.id);
            // Mark all cells within fallout radius
            for (let x = Math.max(0, zoneCoords.x - zone.radius); x <= Math.min(19, zoneCoords.x + zone.radius); x++) {
                for (let y = Math.max(0, zoneCoords.y - zone.radius); y <= Math.min(19, zoneCoords.y + zone.radius); y++) {
                    const cellId = y * 20 + x;
                    const cell = grid.querySelector(`[data-id="${cellId}"]`);
                    if (cell) cell.classList.add('in-fallout');
                }
            }
        }
    });
}

/**
 * Production tick: called every real-second to produce continuous feel.
 */
function productionTick() {
    // ── Handle construction timers ────────────────────────────────────────────
    game.buildings.forEach(b => {
        if (b.isUnderConstruction && b.constructionTimeRemaining > 0) {
            b.constructionTimeRemaining -= 0.1; // 0.1 per tick (each tick is 1 second)
            
            // Construction complete
            if (b.constructionTimeRemaining <= 0) {
                b.constructionTimeRemaining = 0;
                b.isUnderConstruction = false;
                // Re-render to show completed building
                renderBuilding(b.id, b.type, true, b);
                // Brief pulse to signal completion
                const _c = document.querySelector('[data-id="' + b.id + '"]');
                if (_c) {
                    _c.classList.add('build-complete');
                    setTimeout(() => _c.classList.remove('build-complete'), 900);
                }
                addNotification('success', `✅ ${displayNames[b.type] || b.type} construction complete!`);
            } else {
                // Update progress display
                renderBuilding(b.id, b.type, true, b);
            }
        }
    });
    
    // Count buildings (only completed ones produce resources)
    let totalMines = 0;
    let totalPlants = 0;
    game.buildings.forEach(b => {
        if (!b.isUnderConstruction) { // Only count completed buildings
            if (b.type === 'mine') totalMines++;
            if (b.type === 'plant') totalPlants++;
        }
    });

    // ── Mines → uraniumRaw ────────────────────────────────────────────────────
    // Each mine independently yields a small random amount per tick (organic feel).
    // Range 0.10–0.35 U/sec per mine, average ~0.22.
    // Fallout zones reduce production by 50% if affected.
    // Deposit bonus: on deposit 1.5x, adjacent 1.25x, far 0.3x
    let produced = 0;
    const activeMines = game.buildings.filter(b => b.type === 'mine' && !b.isUnderConstruction);
    activeMines.forEach(mine => {
        let amount = 0.10 + Math.random() * 0.25;
        
        // Apply deposit proximity bonus
        const depositBonus = getDepositBonus(mine.id);
        amount *= depositBonus;

        // Apply same-type proximity bonus: nearby mines share resources (+25% per neighbor, cap 3)
        let sameMines = 0;
        game.buildings.forEach(other => {
            if (other.id !== mine.id && other.type === 'mine' && !other.isUnderConstruction
                && distance(mine.id, other.id) <= game.proximityRange) sameMines++;
        });
        amount *= (1 + (Math.min(sameMines, 3) * 0.25));

        // Apply fallout penalty if affected
        if (mine.fallout && mine.fallout.endTime > Date.now()) {
            amount *= mine.fallout.multiplier; // Apply 50% reduction
        }
        produced += amount;
    });
    const totalStored = game.uraniumRaw + game.uraniumRefined;
    const rawHeadroom = Math.max(0, game.maxStorage - totalStored);
    const actualProduced = Math.min(rawHeadroom, produced);
    game.dailyProduced += actualProduced;
    game.uraniumRaw += actualProduced;

    // ── Processors → convert raw into refined ─────────────────────────────────
    // Each processor converts a small random trickle per tick (avg ~0.15 U/sec).
    // No processor = no refined uranium = no plant income.
    // Fallout zones reduce production by 50% if affected.
    const activeProcessors = game.buildings.filter(b => b.type === 'processor' && !b.isUnderConstruction);
    let converted = 0;
    activeProcessors.forEach(processor => {
        let amount = 0.08 + Math.random() * 0.14; // avg ~0.15 U/sec per processor
        // Apply fallout penalty if affected
        if (processor.fallout && processor.fallout.endTime > Date.now()) {
            amount *= processor.fallout.multiplier; // Apply 50% reduction
        }
        converted += amount;
    });
    const actualConverted = Math.min(game.uraniumRaw, converted);
    game.uraniumRaw     -= actualConverted;
    game.uraniumRefined += actualConverted;

    // ── Plants → consume refined uranium, generate income ─────────────────────
    const fuelPerPlantPerTick = 0.03 + Math.random() * 0.06; // avg ~0.06 U/sec per plant
    const requiredFuel = totalPlants * fuelPerPlantPerTick;
    let fuelConsumed = 0;
    let income = 0;

    if (requiredFuel > 0 && game.uraniumRefined > 0) {
        fuelConsumed = Math.min(requiredFuel, game.uraniumRefined);
        const power = calculatePower();
        const powerFraction = fuelConsumed / requiredFuel;
        income = Math.floor(power * powerFraction * 2); // tokens per production tick
        game.uraniumRefined -= fuelConsumed;
    }

    game.playerWallet += income;
    // Accumulate income across ticks; show one floating label every 5 ticks
    // so the wallet area isn't spammed every second.
    game._pendingIncomeDisplay = (game._pendingIncomeDisplay || 0) + income;
    game._incomeTickCount = (game._incomeTickCount || 0) + 1;
    if (game._incomeTickCount >= 5) {
        if (game._pendingIncomeDisplay >= 40) {
            const _incomeEl = document.getElementById('wallet');
            // Sync displayed value and reset market baseline at the moment the float fires
            game._walletShown = game.playerWallet;
            game._walletMarketBaseline = game.market.price;
            if (_incomeEl) showFloatingText('+' + Math.round(game._pendingIncomeDisplay).toLocaleString(), '#4CAF50', _incomeEl);
        }
        game._pendingIncomeDisplay = 0;
        game._incomeTickCount = 0;
    }
    if (income > 0) {
        // Income rewards are new tokens minted from the 1B reserve — real issuance event.
        game.tokensIssued += income;
        // Minting also drains the bonding curve pool (new supply = scarcity pressure).
        game.market.tokenPool = Math.max(1, game.market.tokenPool - income / game.market.poolBurnRate);
    }
    game.lastIncome = income;
    game.dailyIncome += income;

    // market ticks every production tick so it behaves like a stock price
    game.market.prevPrice = game.market.price;
    tickMarket();

    updateUI();
    updateFalloutVisualization();
}

/**
 * Small per-second market tick to simulate stock-like movement.
 *
 * Price model (two components):
 *  1. Bonding curve anchor — the "fair value" based on pool depletion + real issuance.
 *     poolFactor  = tokenPoolInitial / pool         — run-level scarcity (fast-moving)
 *     issueFactor = 1 + (tokensIssued / 1B) × 1000 — macro supply pressure (slow-moving)
 *     bondingPrice = baseTokenPrice × poolFactor × issueFactor
 *  2. Random walk noise — price oscillates around bondingPrice via mean-reversion.
 *     Prevents the chart from being a boring straight line.
 */
function tickMarket() {
    // 1. Bonding curve fair value
    //    Two factors drive scarcity:
    //    a) tokenPool depletion (run-level, fast-moving)
    //    b) real issuance ratio vs 1B reserve (macro, slow-moving)
    const poolFactor = game.market.tokenPoolInitial / Math.max(1, game.market.tokenPool);
    const issueFactor = 1 + (game.tokensIssued / game.totalTokenSupply) * 1000;
    const bondingPrice = game.market.baseTokenPrice * poolFactor * issueFactor;

    // 2. Gaussian noise (Box-Muller)
    const vol = game.market.perSecondVol;
    const u = Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const noise = z * vol * game.market.price;

    // 3. Diurnal demand drift (legacy flavour — small contribution)
    const supply = calculatePower();
    const diurnal = Math.sin((game.time.hour / 24) * Math.PI * 2) * 0.2;
    const demand = Math.max(10, game.market.baseDemand * (1 + diurnal));
    const supplyDemandDelta = (demand - supply) / demand;
    const drift = supplyDemandDelta * game.market.driftFactor * game.market.price;

    // 4. Mean-revert toward bondingPrice (strength 0.04 per tick)
    const reversion = (bondingPrice - game.market.price) * 0.04;

    game.market.price = Math.max(0.01,
        +(game.market.price + reversion + noise + drift).toFixed(6));
}

/**
 * Clock tick: advances simulated clock and triggers hourly/daily events.
 */
function clockTick() {
    // use elapsed real time to advance simulated minutes so real-time mapping is accurate
    const now = Date.now();
    if (!game._lastClockTS) game._lastClockTS = now;
    const deltaSec = (now - game._lastClockTS) / 1000;
    game._lastClockTS = now;

    const advanceMinutes = deltaSec * game.time.minutesPerSecond;
    game.time.minute += advanceMinutes;

    // handle hour/day rollovers (use floor to avoid floating loop problems)
    while (game.time.minute >= 60) {
        game.time.minute -= 60;
        game.time.hour += 1;
        onHourAdvance();
    }

    while (game.time.hour >= 24) {
        game.time.hour -= 24;
        game.time.day += 1;
        onDayAdvance();
    }

    updateUI();
}

function onHourAdvance() {
    // market fluctuates each hour
    fluctuateMarket();
}

function onDayAdvance() {
    // Show dramatic day transition overlay
    showDayTransition(game.time.day);

    // Reset daily strike counter
    game.dayStrikes = 0;
    
    // Clean up expired fallout zones and remove fallout status from affected buildings
    const now = Date.now();
    game.falloutZones = game.falloutZones.filter(z => z.endTime > now);
    game.buildings.forEach(b => {
        if (b.fallout && b.fallout.endTime <= now) {
            delete b.fallout;
        }
    });
    
    // Clean up expired disabled status on enemy buildings
    game.enemyBuildings.forEach(b => {
        if (b.disabled && b.disabled.endTime <= now) {
            delete b.disabled;
        }
    });
    
    // Hook round advancement to day: each day = one round (1-8)
    game.round = Math.min(game.time.day, game.runLength);
    
    document.getElementById('day').textContent = game.time.day;
    document.getElementById('round').textContent = `${game.round}/${game.runLength}`;
    
    // Close any open day modal first
    const dayModal = document.getElementById('endOfDayModal');
    if (dayModal) dayModal.style.display = 'none';
    
    // Check if run just ended (day exceeds runLength)
    if (!game.runEnded && game.time.day > game.runLength) {
        game.runEnded = true;
        game.dailyProduced = 0;
        game.dailyIncome = 0;
        onRunEnd();
        return;
    }
    
    // If this is the final day (day === runLength), don't show summary yet - wait for day+1 to show combined modal
    if (game.time.day === game.runLength) {
        game.dailyProduced = 0;
        game.dailyIncome = 0;
        return;
    }
    
    // Show end-of-day summary for days 1-7
    showEndOfDaySummary();

    // Push a persistent notification so players can review the day even after closing the modal
    const _power = calculatePower();
    addNotification(
        'info',
        `📅 Day ${game.time.day - 1} recap: ` +
        `Income +${game.dailyIncome.toLocaleString()} tokens · ` +
        `Mined ${formatUranium(game.dailyProduced)} U · ` +
        `Power ${_power.toFixed(1)} MW · ` +
        `Prize pool ${formatPrizePool(game.prizePool)}`
    );

    // Reset daily accumulators for next day
    game.dailyProduced = 0;
    game.dailyIncome = 0;
}

/**
 * Called when a round ends (day transitions; stub for future use)
 */
function onRoundEnd(roundNumber) {
    // Currently just a placeholder for future round-end logic
    // Prize distribution happens at the very end of the full 8-round run (onRunEnd)
    console.info(`Round ${roundNumber} complete. Next round begins.`);
}

/**
 * Called when the entire run ends
 * Shows comprehensive final leaderboard with player stats, game economy, and run statistics
 */
function onRunEnd() {
    console.info('🔥 RUN COMPLETE! All rounds finished.');

    // Distribute prize pool FIRST so wallet values in the leaderboard are accurate
    const prizeAwards = distributePrizePool();
    
    // Freeze the grid
    const grid = document.getElementById('gameGrid');
    if (grid) {
        document.querySelectorAll('.cell').forEach(cell => {
            cell.style.pointerEvents = 'none';
            cell.style.opacity = '0.7';
        });
    }
    
    // Build final leaderboard with all scores and stats
    const finalScores = game.players.map(p => {
        let buildingStats = { mines: 0, processors: 0, storage: 0, plants: 0 };
        let totalBuildings = 0;
        
        if (p.isLocal) {
            game.buildings.forEach(b => {
                buildingStats[b.type]++;
                totalBuildings++;
            });
            const portfolio = game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price);
            return { 
                name: p.name, 
                isLocal: true, 
                score: calculatePower() + (portfolio / 1000), 
                portfolio,
                wallet: game.playerWallet,
                buildingStats,
                totalBuildings,
                power: calculatePower(),
                uranium: game.uraniumRaw + game.uraniumRefined
            };
        }
        
        const botBuildings = game.enemyBuildings.filter(b => b.owner === p.name);
        botBuildings.forEach(b => {
            buildingStats[b.type]++;
            totalBuildings++;
        });
        const plants = buildingStats.plants;
        const mines = buildingStats.mines;
        const estPortfolio = (plants * 100) + (mines * 50 * game.market.price);
        return { 
            name: p.name, 
            isLocal: false, 
            score: (plants * 100) + (estPortfolio / 1000), 
            portfolio: estPortfolio,
            wallet: p.wallet,
            buildingStats,
            totalBuildings,
            power: plants * 100,
            uranium: 0
        };
    });
    finalScores.sort((a, b) => b.score - a.score);
    
    // Determine winner
    const winner = finalScores[0];
    const isPlayerWinner = winner.isLocal;
    
    // Calculate global stats
    const circ = Math.max(0, game.tokensIssued - game.tokensBurned);
    const available = game.totalTokenSupply - game.tokensIssued;
    
    // Create run-end modal
    const modal = document.createElement('div');
    modal.id = 'runEndModal';
    modal.style.cssText = `
        position: fixed;
        left: 0;
        top: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.95);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn 0.5s ease-in;
        overflow: auto;
    `;
    
    const content = document.createElement('div');
    content.style.cssText = `
        background: linear-gradient(135deg, #1a1a1a 0%, #0d0d0d 100%);
        border: 2px solid ${isPlayerWinner ? '#ffb84d' : '#ff6b6b'};
        border-radius: 8px;
        padding: 24px;
        width: 90%;
        max-width: 1200px;
        max-height: 85vh;
        overflow-y: auto;
        color: #fff;
        font-family: monospace;
        box-shadow: 0 0 20px ${isPlayerWinner ? 'rgba(255,184,77,0.3)' : 'rgba(255,107,107,0.3)'};
    `;
    
    // Build leaderboard with detailed player stats
    let leaderboardHTML = finalScores.map((p, i) => {
        const medal = ['🥇 1ST', '🥈 2ND', '🥉 3RD'][i] || `#${i+1}`;
        const color = p.isLocal ? '#ffb84d' : '#ccc';
        const you = p.isLocal ? ' (YOU)' : '';
        const award = prizeAwards[p.name];
        const prizeHTML = award
            ? `<div style="color:#4CAF50; font-weight:bold;">🏆 Prize: +${award.toLocaleString()} tokens</div>`
            : '';
        return `
            <div style="margin-bottom: 12px; padding: 12px; background: rgba(255,255,255,0.05); border-left: 3px solid ${color}; border-radius: 4px;">
                <div style="color: ${color}; font-weight: bold; margin-bottom: 6px;">
                    ${medal} ${p.name}${you}
                </div>
                ${prizeHTML}
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 11px; color: #aaa;">
                    <div><strong>Score:</strong> ${p.score.toFixed(1)}</div>
                    <div><strong>Portfolio:</strong> $${p.portfolio.toFixed(2)}</div>
                    <div><strong>Wallet:</strong> ${p.wallet.toLocaleString()} tokens</div>
                    <div><strong>Power:</strong> ${p.power.toFixed(1)} MW</div>
                    <div><strong>Buildings:</strong> ${p.totalBuildings} (${p.buildingStats.mines}⛏️ ${p.buildingStats.processors}🏭 ${p.buildingStats.storage}🗄️ ${p.buildingStats.plants}☢️)</div>
                    <div><strong>Uranium:</strong> ${formatUranium(p.uranium)}</div>
                </div>
            </div>
        `;
    }).join('');
    
    content.innerHTML = `
        <div style="text-align: center; margin-bottom: 20px;">
            <div style="font-size: 22px; font-weight: bold; color: #ffb84d; margin-bottom: 6px;">
                ${isPlayerWinner ? '🎉 YOU WIN THE RUN! 🎉' : '💥 RUN OVER 💥'}
            </div>
                <div style="font-size: 12px; color: #888;">
                Completed ${game.runLength} rounds | Market Price: $${game.market.price.toFixed(2)} | Prize Pool: ${formatPrizePool(game.prizePool)}
            </div>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px;">
            <!-- Winner Highlight -->
            <div style="padding: 12px; background: rgba(255,184,77,0.1); border: 1px solid #ffb84d; border-radius: 4px;">
                <div style="font-weight: bold; color: #ffb84d; margin-bottom: 6px;">🏆 Champion</div>
                <div style="font-size: 12px; color: #ccc; margin-bottom: 4px;"><strong>${winner.name}</strong></div>
                <div style="font-size: 11px; color: #888;">Score: ${winner.score.toFixed(1)}</div>
                <div style="font-size: 11px; color: #888;">Portfolio: $${winner.portfolio.toFixed(2)}</div>
            </div>
            
            <!-- Global Economy Stats -->
            <div style="padding: 12px; background: rgba(255,255,255,0.05); border: 1px solid #333; border-radius: 4px;">
                <div style="font-weight: bold; color: #ffb84d; margin-bottom: 6px;">📊 Global Economy</div>
                <div style="font-size: 11px; color: #aaa; line-height: 1.6;">
                    Circulating: ${formatSupply(circ)}<br/>
                    Burned: ${formatSupply(game.tokensBurned)}<br/>
                    Available: ${formatSupply(available)}<br/>
                    Market Price: $${game.market.price.toFixed(2)}
                </div>
            </div>
        </div>
        
        <div style="margin-bottom: 20px; padding: 12px; background: rgba(255,255,255,0.03); border-top: 1px solid #333; border-bottom: 1px solid #333;">
            <div style="font-weight: bold; color: #ffb84d; margin-bottom: 12px;">🏅 Final Leaderboard</div>
            ${leaderboardHTML}
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 20px; font-size: 11px;">
            <div style="padding: 10px; background: rgba(76,175,80,0.1); border-left: 2px solid #4CAF50; border-radius: 4px;">
                <div style="color: #4CAF50; font-weight: bold; margin-bottom: 4px;">⛏️ Production</div>
                <div style="color: #888;">Mines: ${game.buildings.filter(b => b.type === 'mine').length}</div>
                <div style="color: #888;">Processors: ${game.buildings.filter(b => b.type === 'processor').length}</div>
                <div style="color: #888;">Uranium: ${formatUranium(game.uraniumRaw + game.uraniumRefined)}</div>
            </div>
            
            <div style="padding: 10px; background: rgba(255,184,77,0.1); border-left: 2px solid #ffb84d; border-radius: 4px;">
                <div style="color: #ffb84d; font-weight: bold; margin-bottom: 4px;">☢️ Power</div>
                <div style="color: #888;">Reactors: ${game.buildings.filter(b => b.type === 'plant').length}</div>
                <div style="color: #888;">Total Power: ${calculatePower().toFixed(1)} MW</div>
                <div style="color: #888;">Storage: ${game.buildings.filter(b => b.type === 'storage').length}</div>
            </div>
            
            <div style="padding: 10px; background: rgba(255,107,107,0.1); border-left: 2px solid #ff6b6b; border-radius: 4px;">
                <div style="color: #ff6b6b; font-weight: bold; margin-bottom: 4px;">💣 Sabotage</div>
                <div style="color: #888;">Enemy Buildings: ${game.enemyBuildings.length}</div>
                <div style="color: #888;">Tokens Burned: ${formatSupply(game.tokensBurned)}</div>
                <div style="color: #888;">Prize Pool: ${formatPrizePool(game.prizePool)}</div>
            </div>
        </div>
        
        <div style="margin-top: 24px; padding-top: 12px; border-top: 1px solid #333; text-align: center;">
            <button onclick="returnToMenu()" style="
                padding: 12px 32px;
                background: #ffb84d;
                color: #000;
                border: none;
                border-radius: 4px;
                font-weight: bold;
                cursor: pointer;
                font-family: monospace;
                font-size: 14px;
            ">↻ Return to Menu</button>
        </div>
    `;
    
    modal.appendChild(content);
    document.body.appendChild(modal);
}

/**
 * Return to menu / reset for new run
 */
function returnToMenu() {
    const modal = document.getElementById('runEndModal');
    if (modal) modal.remove();
    
    // Stop the simulation loops
    if (game._productionInterval) clearInterval(game._productionInterval);
    if (game._clockInterval) clearInterval(game._clockInterval);
    if (game._botInterval) { clearInterval(game._botInterval); game._botInterval = null; }
    
    // Reset game state
    game.runEnded = false;
    game.round = 1;
    game.time.day = 1;
    game.time.hour = 0;
    game.time.minute = 0;
    game.playerWallet = 50000;
    game.uraniumRaw = 0;
    game.uraniumRefined = 0;
    game.buildings = [];
    game.enemyBuildings = [];
    game.prizePool = 0;
    game.dailyProduced = 0;
    game.dailyIncome = 0;
    
    // Re-enable grid
    document.querySelectorAll('.cell').forEach(cell => {
        cell.style.pointerEvents = 'auto';
        cell.style.opacity = '1';
    });
    
    // Clear grid
    const grid = document.getElementById('gameGrid');
    if (grid) grid.innerHTML = '';
    
    // Show lobby for next run
    showLobby();
}

/**
 * Distribute the prize pool to the top 3 players at round end.
 * Shares: 1st 50% / 2nd 30% / 3rd 20%.
 *
 * BACKEND_STUB: In production the server calculates and sends final scores
 *   via 'run:end' event, and transfers tokens on-chain / in the DB.
 *   client only needs to display the result, not compute it.
 */
function distributePrizePool() {
    if (game.prizePool <= 0) return {};
    const pool = game.prizePool;
    const shares = [0.50, 0.30, 0.20];

    // Score every player
    const scored = game.players.map(p => {
        if (p.isLocal) {
            const portfolio = game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price);
            return { ...p, calcScore: calculatePower() + (portfolio / 1000) };
        }
        // Estimate bot score from their buildings on the grid
        const botBuildings = game.enemyBuildings.filter(b => b.owner === p.name);
        const plants = botBuildings.filter(b => b.type === 'plant').length;
        const mines  = botBuildings.filter(b => b.type === 'mine').length;
        const estPortfolio = (plants * 100) + (mines * 50 * game.market.price);
        return { ...p, calcScore: (plants * 100) + (estPortfolio / 1000) };
    });

    scored.sort((a, b) => b.calcScore - a.calcScore);

    // Award all top-3 players; bots get simulated wallet credit, local player gets real tokens
    const awards = {}; // name -> award amount
    scored.slice(0, 3).forEach((p, rank) => {
        const award = Math.floor(pool * shares[rank]);
        awards[p.name] = award;
        if (p.isLocal) {
            game.playerWallet += award;
            const localEntry = game.players.find(pl => pl.isLocal);
            if (localEntry) localEntry.wallet = game.playerWallet;
        } else {
            const botEntry = game.players.find(pl => pl.name === p.name);
            if (botEntry) botEntry.wallet += award;
        }
        console.info(
            `Run end payout | Rank: #${rank + 1} ${p.name} | Award: +${award.toLocaleString()} tokens`
        );
    });
    game.prizePool = 0;
    return awards;
}

/**
 * Market random walk / volatility
 */
function fluctuateMarket() {
    const vol = game.market.volatility;
    // simple gaussian-like noise via two uniforms (Box-Muller-ish approximation)
    const u = Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const change = z * vol * game.market.price;
    game.market.price = Math.max(0.01, +(game.market.price + change).toFixed(4));
}

/**
 * Tooltip helpers
 */
function onCellHover(id, e) {
    const cell = document.querySelector('[data-id="' + id + '"]');
    if (!cell) return;
    const rect = cell.getBoundingClientRect();
    // build tooltip content
    let content = '';
    const player = game.buildings.find(b => b.id === id);
    const enemy = game.enemyBuildings.find(b => b.id === id);
    const deposit = game.deposits.find(d => d.cellId === id);

    // If hovering over a deposit cell (no buildings), show deposit info
    if (!player && !enemy && deposit && !game.selectedMode) {
        content = `<div style="font-weight:700; color:#FFD700;">🚩 Uranium Deposit</div>` +
            `<div style="color:#FFA500; margin-top:4px;">Build mines here for 1.5x yield!</div>` +
            `<div style="color:#AAA; font-size:12px; margin-top:4px;">1 tile: 1.25x | 2 tiles: 0.7x | 3+: 0.1x</div>`;
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // If hovering while planning to build, preview proximity bonuses
    if (!player && !enemy && game.selectedMode && game.selectedMode !== 'sabotage') {
        const type = game.selectedMode;
        // count neighbor same-type if placed here
        let same = 0;
        let pen = 0;
        for (const other of game.buildings) {
            if (other.type === type && distance(id, other.id) <= game.proximityRange) same++;
        }
        for (const en of game.enemyBuildings) {
            if (distance(id, en.id) <= game.proximityRange) pen++;
        }
        const label = displayNames[type] || type;
        const icon = (buildingTypes[type] && buildingTypes[type].emoji) ? buildingTypes[type].emoji + ' ' : '';
        content = `<div style="font-weight:700;">${icon}Place: ${label}</div>` +
            `<div>📐 Same-type neighbors: ${same} (${same>0? '+'+ (same*25) +'% efficiency': 'no bonus'})</div>` +
            `<div>⚠️ Nearby enemies: ${pen}</div>`;
        
        // Add deposit bonus info for mines
        if (type === 'mine') {
            const depositBonus = getDepositBonus(id);
            const depositInfo = depositBonus === 1.5 ? '💰 On deposit: 1.5x yield!' : 
                               depositBonus === 1.25 ? '💰 1 tile away: 1.25x yield' : 
                               depositBonus === 0.7 ? '💰 2 tiles away: 0.7x yield' :
                               '⛰️ 3+ tiles away: 0.1x yield (terrible!)';
            content += `<div style="color:${depositBonus > 0.5 ? '#FFD700' : '#FF6B6B'}; font-weight:600;">${depositInfo}</div>`;
        }
        
        if (type === 'plant') {
            const hasRoad = cellHasRoadNeighbor(id);
            content += `<div style="color:${hasRoad ? '#4CAF50' : '#888'};">` +
                `🛣️ Road access: ${hasRoad ? '+40% income if built here ✓' : 'no road bonus here'}</div>`;
        }
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // If hovering a player building (only show details when NOT in build mode)
    if (player && !game.selectedMode) {
        const type = player.type;
        let same = 0; let pen = 0;
        for (const other of game.buildings) {
            if (other.id !== player.id && other.type === type && distance(id, other.id) <= game.proximityRange) same++;
        }
        for (const en of game.enemyBuildings) if (distance(id, en.id) <= game.proximityRange) pen++;
        const label = displayNames[type] || type;
        const icon = (buildingTypes[type] && buildingTypes[type].emoji) ? buildingTypes[type].emoji + ' ' : '';
        const ownerLabel = `<span style="display:inline-flex;align-items:center;gap:6px;color:#4CAF50;">${avatarBadge(game.playerAvatar)} ${escapeHtml(game.playerName || 'You')} <span style="font-size:10px;color:#aaa;">(You)</span></span>`;
        content = `<div style="font-weight:700;">${icon}${label} — ${ownerLabel}</div>` +
            `<div>📐 Same-type neighbors: ${same} (${same>0? '+'+ (same*25) +'%': 'none'})</div>` +
            `<div>⚠️ Nearby enemies: ${pen}</div>`;
        
        // Show mining rate for mines
        if (type === 'mine') {
            const depositBonus = getDepositBonus(id);
            const miningRatePercent = (depositBonus * 100).toFixed(0);
            const depositDistInfo = depositBonus === 1.5 ? 'On deposit' : 
                                   depositBonus === 1.25 ? '1 tile from deposit' : 
                                   depositBonus === 0.7 ? '2 tiles from deposit' : 
                                   '3+ tiles from deposit';
            content += `<div style="color:${depositBonus > 0.5 ? '#FFD700' : '#FF6B6B'}; font-weight:600; margin-top:4px;">⛏️ Mining: ${miningRatePercent}% efficiency</div>` +
                      `<div style="color:#AAA; font-size:12px;">${depositDistInfo}</div>`;
        }
        
        if (type === 'plant') {
            const hasRoad = cellHasRoadNeighbor(id);
            content += `<div style="color:${hasRoad ? '#4CAF50' : '#888'};">` +
                `🛣️ Road access: ${hasRoad ? '+40% income ✓' : 'none'}</div>`;
        }
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // If hovering an enemy building (only show details when NOT in build mode)
    if (enemy && !game.selectedMode) {
        const type = enemy.type;
        const owner = resolveOwner(enemy.ownerId || enemy.owner);
        const sabotageCost = Math.max(0, buildingTypes[type] ? buildingTypes[type].cost - 200 : 300);
        const label = displayNames[type] || type;
        const icon = (buildingTypes[type] && buildingTypes[type].emoji) ? buildingTypes[type].emoji + ' ' : '';
        const ownerName = escapeHtml(owner.name || 'Unknown');
        const ownerTag = owner.isLocal
            ? `<span style="display:inline-flex;align-items:center;gap:6px;color:#4CAF50;">${avatarBadge(owner.avatar)} ${ownerName} <span style="font-size:10px;color:#aaa;">(You)</span></span>`
            : owner.isBot
                ? `<span style="display:inline-flex;align-items:center;gap:6px;color:#ff9944;">${avatarBadge(owner.avatar)} ${ownerName} <span style="font-size:10px;color:#666;">[BOT]</span></span>`
                : `<span style="display:inline-flex;align-items:center;gap:6px;color:#e05ce0;">${avatarBadge(owner.avatar)} ${ownerName} <span style="font-size:10px;color:#aaa;">[PLAYER]</span></span>`;
        const ownerBuildings = game.enemyBuildings.filter(b => b.owner === enemy.owner).length;
        // Active debuffs on this building
        const now = Date.now();
        let statusLine = '';
        if (enemy.disabled && enemy.disabled.endTime > now) {
            const secsLeft = Math.ceil((enemy.disabled.endTime - now) / 1000);
            statusLine += `<div style="color:#ffb84d; margin-top:4px;">⏸️ Disabled — ${secsLeft}s remaining (${Math.round((1 - enemy.disabled.multiplier) * 100)}% penalty)</div>`;
        }
        content = `<div style="font-weight:700;">${icon}${label}</div>` +
            `<div style="margin-top:2px;">Owner: ${ownerTag}</div>` +
            `<div style="color:#888; font-size:11px;">${ownerBuildings} building${ownerBuildings !== 1 ? 's' : ''} total</div>` +
            statusLine +
            `<div style="margin-top:6px; color:#ff6b6b;">💥 Sabotage cost: ${sabotageCost.toLocaleString()} tokens</div>` +
            `<div style="color:#aaa; font-size:11px;">Click to open sabotage menu</div>`;
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // Road cell — show bonus hint even on empty road tiles
    if (game.terrain && (game.terrain[id] === 'road' || game.terrain[id] === 'road-h' || game.terrain[id] === 'road-x')) {
        content = `<div style="font-weight:700; color:#aaa;">🛣️ Road Tile</div>` +
            `<div>Building close to road access increases productivity.</div>` +
            `<div style="color:#4CAF50;">Adjacent Reactors gain +40% income</div>`;
        showTooltipAt(rect.right + 8, rect.top, content);
        return;
    }

    // empty cell default
    hideTooltip();
}

function onCellMove(id, e) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip || tooltip.style.display === 'none') return;
    const x = e.clientX + 12; const y = e.clientY + 12;
    repositionTooltip(x, y);
}

function showTooltipAt(x, y, html) {
    const t = document.getElementById('tooltip');
    if (!t) return;
    t.innerHTML = html;
    t.style.display = 'block';
    // start at requested position
    t.style.left = x + 'px';
    t.style.top = y + 'px';
    // reposition if off-screen
    repositionTooltip(x, y);
}

/**
 * Show a tooltip anchored to the left of the actions menu and vertically
 * aligned to the menu item. This measures the tooltip size then places it
 * so the right edge sits a few pixels left of the menu's left edge.
 */
function showTooltipAnchoredLeft(menuRect, itemRect, html) {
    const t = document.getElementById('tooltip');
    if (!t) return;
    t.innerHTML = html;
    t.style.display = 'block';
    t.style.maxWidth = '320px';
    t.classList.add('anchored-to-menu');

    // measure after render
    const rect = t.getBoundingClientRect();
    const padding = 8;
    // compute left so tooltip's right edge sits padding px left of menu left
    let left = Math.max(padding, Math.min(window.innerWidth - rect.width - padding, (menuRect.left - rect.width - 12)));
    // vertical center relative to menu item
    let top = itemRect.top + (itemRect.height - rect.height) / 2;
    // clamp to viewport
    top = Math.max(padding, Math.min(window.innerHeight - rect.height - padding, top));

    t.style.left = left + 'px';
    t.style.top = top + 'px';
}

/**
 * Reposition an already-visible tooltip so it stays inside the viewport.
 * If called with `html` provided, it will set content first.
 */
function repositionTooltip(x, y) {
    const t = document.getElementById('tooltip');
    if (!t || t.style.display === 'none') return;
    // measure
    const rect = t.getBoundingClientRect();
    const padding = 8;
    let left = x;
    let top = y;

    // if tooltip goes off right edge, try to place to left of x
    if (rect.right > window.innerWidth - padding) {
        left = Math.max(padding, x - rect.width - 16);
    }
    // if tooltip goes off bottom, move it up
    if (rect.bottom > window.innerHeight - padding) {
        top = Math.max(padding, y - rect.height - 16);
    }
    // ensure not off left/top
    left = Math.max(padding, left);
    top = Math.max(padding, top);

    t.style.left = left + 'px';
    t.style.top = top + 'px';
}

function hideTooltip() {
    const t = document.getElementById('tooltip');
    if (!t) return;
    t.style.display = 'none';
    // reset any anchored state
    t.style.maxWidth = '';
    t.classList.remove('anchored-to-menu');
}

/**
 * End-of-day summary and leaderboard
 */
function showEndOfDaySummary() {
    const modal = document.getElementById('endOfDayModal');
    const content = document.getElementById('endOfDayContent');
    const lb = document.getElementById('leaderboard');
    if (!modal || !content || !lb) return;

    // player stats
    const dayProduced = game.dailyProduced;
    const dayIncome = game.dailyIncome;
    const power = calculatePower();

    const circ = Math.max(0, game.tokensIssued - game.tokensBurned);
    const available = game.totalTokenSupply - game.tokensIssued;
    content.innerHTML = `
        <div>Day: ${game.time.day}</div>
        <div>Power (current): ${power.toFixed(1)} MW</div>
        <div>Raw uranium mined today: ${formatUranium(dayProduced)}</div>
        <div>Refined (current): ${formatUranium(game.uraniumRefined)}</div>
        <div>Income today: ${dayIncome.toLocaleString()} tokens</div>
        <div style="margin-top:8px; border-top:1px solid #333; padding-top:8px;">
            <strong>Token Economy</strong>
        </div>
        <div>Circulating supply: ${formatSupply(circ)} <span style="color:#555; font-size:10px;">(issued − burned)</span></div>
        <div>Available in reserve: ${formatSupply(available)} <span style="color:#555; font-size:10px;">of 1B</span></div>
        <div>Tokens issued (total): ${formatSupply(game.tokensIssued)}</div>
        <div>Tokens burned (total): ${formatSupply(game.tokensBurned)}</div>
        <div style="margin-top:6px;">
            <strong style="color:#ffb84d;">Prize Pool: ${formatPrizePool(game.prizePool)}</strong>
        </div>
        <div style="font-size:11px; color:#888;">Prize pool split — 1st: 50% · 2nd: 30% · 3rd: 20% &nbsp;|&nbsp; 20% of buy-ins retained as platform fee</div>
    `;

    // build leaderboard from game.players
    // BACKEND_STUB: replace with server-sent scores from 'round:scores' event
    const entries = game.players.map(p => {
        if (p.isLocal) {
            const portfolio = game.playerWallet + ((game.uraniumRaw + game.uraniumRefined) * game.market.price);
            return { name: p.name, isLocal: true, score: power + (portfolio / 1000), portfolio };
        }
        const botBuildings = game.enemyBuildings.filter(b => b.owner === p.name);
        const plants = botBuildings.filter(b => b.type === 'plant').length;
        const mines  = botBuildings.filter(b => b.type === 'mine').length;
        const estPortfolio = (plants * 100) + (mines * 50 * game.market.price);
        return { name: p.name, isLocal: false, score: (plants * 100) + (estPortfolio / 1000), portfolio: estPortfolio };
    });
    entries.sort((a, b) => b.score - a.score);
    lb.innerHTML = entries.map((r, i) => {
        const medal = ['🥇','🥈','🥉'][i] || `#${i+1}`;
        const color = r.isLocal ? '#ffb84d' : '#ccc';
        return `<div style="margin-bottom:6px; color:${color};">` +
            `<strong>${medal} ${r.name}</strong> — ` +
            `Score: ${r.score.toFixed(1)} — ` +
            `Portfolio: $${r.portfolio.toFixed(2)}` +
            `</div>`;
    }).join('');

    modal.style.display = 'flex';
}

function closeEndOfDay() {
    const modal = document.getElementById('endOfDayModal');
    if (!modal) return;
    modal.style.display = 'none';
}

/**
 * Add hover tooltips to top-bar buttons.
 */
function addButtonTooltips() {
    const buttons = document.querySelectorAll('.btn');
    buttons.forEach(btn => {
        btn.addEventListener('mouseenter', (e) => {
            const typeKey = btn.dataset.type || btn.textContent.trim();
            const label = displayNames[typeKey] || btn.textContent.trim();
            let content = '<div style="font-weight:700;">' + label + '</div>';
            if (btn.id === 'actionsMenuBtn') {
                content = '<div style="font-weight:700;">☰ Action Menu</div>';
                content += '<div>Click to build structures or perform actions.</div>';
                content += '<div style="margin-top:4px; color:#888; font-size:11px;">⛏️ Build · 💥 Sabotage</div>';
                content += '<div style="margin-top:4px; color:#ffb84d; font-size:11px;">Press <b>M</b> to toggle</div>';
            } else if (typeKey === 'mine' || /mine/i.test(typeKey)) {
                content = '<div style="font-weight:700;">⛏️ ' + label + '</div>';
                content += '<div>Place a Mine to extract raw uranium from the ground.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.mine.cost + ' tokens</div>';
            } else if (typeKey === 'processor' || /process/i.test(typeKey)) {
                content = '<div style="font-weight:700;">🏭 ' + label + '</div>';
                content += '<div>Refines raw uranium into fuel for Reactors.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.processor.cost + ' tokens</div>';
            } else if (typeKey === 'storage' || /store/i.test(typeKey)) {
                content = '<div style="font-weight:700;">🗄️ ' + label + '</div>';
                content += '<div>Increases your uranium storage capacity.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.storage.cost + ' tokens</div>';
            } else if (typeKey === 'plant' || /plant/i.test(typeKey)) {
                content = '<div style="font-weight:700;">☢️ ' + label + '</div>';
                content += '<div>Consumes refined uranium to generate power &amp; income.</div>';
                content += '<div>🛣️ Place near a road for +40% income bonus.</div>';
                content += '<div>💰 Cost: ' + buildingTypes.plant.cost + ' tokens</div>';
            } else if (typeKey === 'sabotage' || /sabotage/i.test(typeKey)) {
                content = '<div style="font-weight:700;">💥 Sabotage</div>';
                content += '<div>Sabotage an enemy building.</div>';
                content += '<div>Click Sabotage then click an enemy cell.</div>';
                content += '<div>⚠️ Cost varies by target type.</div>';
            } else if (typeKey === 'silo' || /silo/i.test(typeKey)) {
                content = '<div style="font-weight:700;">💥 Silo</div>';
                content += '<div>Missile Silo — the ultimate weapon. Requires at least 1 completed Reactor to build.</div>';
                content += `<div>💰Build cost: ${buildingTypes.silo.cost} tokens — Construction: ${buildingTypes.silo.constructionTime}s</div>`;
                content += `<div>⚠️ Limit: ${game.maxSilosPerRound} per round. Using a nuke costs a large portion of your wallet.</div>`;
            } else if (typeKey === 'dev' || /dev/i.test(typeKey)) {
                content = '<div style="font-weight:700;">🔧 Dev Tools</div>';
                content += '<div>Advance time, change simulation speed for testing.</div>';
            } else if (btn.id === 'notifBellBtn') {
                const unread = (game.notifications || []).filter(n => !n.read).length;
                content = '<div style="font-weight:700;">🔔 Notifications</div>';
                content += `<div>${unread > 0 ? unread + ' unread' : 'No new notifications'}. Click to open.</div>`;
            }
            const rect = btn.getBoundingClientRect();
            // Bell and hamburger: anchor tooltip to the left, never follow mouse
            if (btn.id === 'notifBellBtn' || btn.id === 'actionsMenuBtn') {
                const t = document.getElementById('tooltip');
                if (t) {
                    t.innerHTML = content;
                    t.style.display = 'block';
                    t.style.position = 'fixed';
                    const tw = t.offsetWidth || 180;
                    const th = t.offsetHeight || 40;
                    t.style.left = (rect.left - tw - 10) + 'px';
                    t.style.top  = (rect.top + (rect.height - th) / 2) + 'px';
                }
                return;
            }
            showTooltipAt(rect.right + 8, rect.top, content);
        });
        btn.addEventListener('mousemove', (e) => {
            // Bell and hamburger tooltips are anchored — don't reposition on mouse move
            if (btn.id === 'notifBellBtn' || btn.id === 'actionsMenuBtn') return;
            const x = e.clientX + 12; const y = e.clientY + 12;
            repositionTooltip(x, y);
        });
        btn.addEventListener('mouseleave', hideTooltip);
    });
}

    // Also add tooltips for popup menu items, anchored to the actions menu
    const menu = document.getElementById('actionsMenu');
    const menuItems = document.querySelectorAll('.menu-item');
    if (menuItems && menuItems.length) {
        menuItems.forEach(mi => {
            mi.addEventListener('mouseenter', (e) => {
                const typeKey = mi.dataset.type || mi.textContent.trim();
                const label = displayNames[typeKey] || mi.textContent.trim();
                let content = '<div style="font-weight:700;">' + label + '</div>';
                if (typeKey === 'mine' || /mine/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">⛏️ ' + label + '</div>';
                    content += '<div>Place a Mine to extract raw uranium from the ground.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.mine.cost + ' tokens</div>';
                } else if (typeKey === 'processor' || /process/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">🏭 ' + label + '</div>';
                    content += '<div>Refines raw uranium into fuel for Reactors.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.processor.cost + ' tokens</div>';
                } else if (typeKey === 'storage' || /store/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">🗄️ ' + label + '</div>';
                    content += '<div>Increases your uranium storage capacity.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.storage.cost + ' tokens</div>';
                } else if (typeKey === 'plant' || /plant/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">☢️ ' + label + '</div>';
                    content += '<div>Consumes refined uranium to generate power &amp; income.</div>';
                    content += '<div>🛣️ Place near a road for +40% income bonus.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.plant.cost + ' tokens</div>';
                } else if (typeKey === 'sabotage' || /sabotage/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">💥 Sabotage</div>';
                    content += '<div>Sabotage an enemy building.</div>';
                    content += '<div>Click Sabotage then click an enemy cell.</div>';
                    content += '<div>⚠️ Cost varies by target type.</div>';
                } else if (typeKey === 'silo' || /silo/i.test(typeKey)) {
                    content = '<div style="font-weight:700;">💥 Silo</div>';
                    content += '<div>Nukes. The ultimate weapon.</div>';
                    content += '<div>Requires 1 completed Reactor to build.</div>';
                    content += '<div>💰 Cost: ' + buildingTypes.silo.cost + ' tokens</div>';
                    content += '<div>⚠️ Limit: ' + game.maxSilosPerRound + ' per round</div>';
                }
                // Anchor tooltip to the LEFT of the actions menu, vertically centered to the item
                const menuRect = menu ? menu.getBoundingClientRect() : null;
                const itemRect = mi.getBoundingClientRect();
                // store the generated HTML on the element so mousemove can reuse it
                mi._tooltipContent = content;
                if (menuRect) {
                    showTooltipAnchoredLeft(menuRect, itemRect, content);
                } else {
                    // fallback: place to the left of item
                    const x = itemRect.left - 260;
                    const y = itemRect.top;
                    showTooltipAt(x, y, content);
                }
            });
            mi.addEventListener('mousemove', (e) => {
                // Keep tooltip vertically aligned with the item in case of scrolling/resize
                const menuRect = menu ? menu.getBoundingClientRect() : null;
                const itemRect = mi.getBoundingClientRect();
                const content = mi._tooltipContent || mi.textContent.trim();
                if (menuRect) showTooltipAnchoredLeft(menuRect, itemRect, content);
            });
            mi.addEventListener('mouseleave', (e) => {
                // clear anchored styles before hiding
                const t = document.getElementById('tooltip');
                if (t) {
                    t.style.maxWidth = '';
                    t.classList.remove('anchored-to-menu');
                }
                // clear stored tooltip content
                delete mi._tooltipContent;
                hideTooltip();
            });
        });
    }

/**
 * Dev controls
 */
function getAdminKey() {
    return (localStorage.getItem(ADMIN_KEY_STORAGE) || '').trim();
}

function setAdminKey(value) {
    const trimmed = (value || '').trim();
    if (trimmed) localStorage.setItem(ADMIN_KEY_STORAGE, trimmed);
    else localStorage.removeItem(ADMIN_KEY_STORAGE);
}

function syncAdminKeyUI() {
    const input = document.getElementById('adminKeyInput');
    if (!input) return;
    const saved = getAdminKey();
    if (saved && input.value !== saved) input.value = saved;
}

async function serverAdminRequest(path, options = {}) {
    const input = document.getElementById('adminKeyInput');
    if (input) setAdminKey(input.value);
    const key = getAdminKey();
    if (!key) {
        addNotification('warning', '🔐 Enter the Railway ADMIN_KEY in the Dev panel first.');
        return null;
    }

    const headers = Object.assign({ 'Content-Type': 'application/json', 'x-admin-key': key }, options.headers || {});
    const response = await fetch(`${SERVER_URL}${path}`, Object.assign({}, options, { headers }));
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = data.error || `Server admin request failed (${response.status}).`;
        addNotification('danger', `❌ ${message}`);
        throw new Error(message);
    }
    return data;
}

function openServerAdmin() {
    const key = getAdminKey();
    const isGitHubPages = /github\.io$/i.test(window.location.hostname);
    const adminUrl = isGitHubPages
        ? new URL('admin.html', window.location.href)
        : new URL('/admin', SERVER_URL);

    if (key) adminUrl.searchParams.set('key', key);
    window.open(adminUrl.toString(), '_blank', 'noopener');
}

async function adminClearCellPrompt() {
    const value = window.prompt('Clear which Railway cell ID? (0-399)');
    if (value === null) return;
    const cellId = Number(value);
    if (!Number.isInteger(cellId) || cellId < 0 || cellId > 399) {
        addNotification('warning', '⚠️ Enter a valid cell ID from 0 to 399.');
        return;
    }

    const data = await serverAdminRequest('/admin/api/clear-cell', {
        method: 'POST',
        body: JSON.stringify({ cellId }),
    });
    if (data) addNotification('success', `🧹 Cleared Railway cell ${cellId}.`);
}

async function adminResetActiveBuildings() {
    if (!window.confirm('Clear all active buildings in the live Railway run?')) return;
    const data = await serverAdminRequest('/admin/api/reset-buildings', {
        method: 'POST',
        body: JSON.stringify({}),
    });
    if (data) addNotification('success', `🧪 Reset ${data.cleared || 0} active building(s) on Railway.`);
}

function syncBotToggleUI() {
    const btn = document.getElementById('botToggleBtn');
    if (!btn) return;
    btn.textContent = `AI Bots: ${game.botsEnabled ? 'ON' : 'OFF'}`;
    btn.style.borderColor = game.botsEnabled ? '#4CAF50' : '#ff6b6b';
    btn.style.color = game.botsEnabled ? '#4CAF50' : '#ff6b6b';
}

function restoreEmptyCell(cellId) {
    const cell = document.querySelector(`[data-id="${cellId}"]`);
    if (!cell) return;
    cell.innerHTML = '';
    cell.className = 'cell';
    const terrain = game.terrain?.[cellId] || 'grass';
    cell.classList.add('terrain-' + terrain);
    if ((game.deposits || []).some(d => d.cellId === cellId)) {
        cell.classList.add('has-deposit');
    }
}

function setAIBotsEnabled(enabled) {
    const nextEnabled = !!enabled;
    if (game.botsEnabled === nextEnabled) {
        syncBotToggleUI();
        return;
    }

    game.botsEnabled = nextEnabled;

    if (!nextEnabled) {
        if (game._botInterval) {
            clearInterval(game._botInterval);
            game._botInterval = null;
        }

        const botIds = new Set((game.players || []).filter(p => p.isBot).map(p => p.id));
        const botNames = new Set((game.players || []).filter(p => p.isBot).map(p => p.name));

        game.players = (game.players || []).filter(p => !p.isBot);

        const removedBuildings = (game.enemyBuildings || []).filter(b => botIds.has(b.ownerId) || botNames.has(b.owner));
        removedBuildings.forEach((b) => restoreEmptyCell(b.id));
        game.enemyBuildings = (game.enemyBuildings || []).filter(b => !botIds.has(b.ownerId) && !botNames.has(b.owner));

        addNotification('info', '🧪 AI bots disabled for testing. Bot buildings were removed.');
    } else {
        if (!socket?.connected || !_authJWT) {
            initPlayerRegistry();
            spawnEnemyBuildings();
        }
        startBotAI();
        addNotification('info', '🤖 AI bots enabled.');
    }

    syncBotToggleUI();
    calculateProximity();
    updateUI();
}

function toggleAIBots() {
    setAIBotsEnabled(!game.botsEnabled);
}

function toggleDevPanel() {
    const panel = document.getElementById('devPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    syncBotToggleUI();
    syncAdminKeyUI();
}

function advanceHours(n) {
    if (!n || isNaN(n)) return;
    for (let i = 0; i < n; i++) {
        game.time.minute += 60; // advance 1 hour
        while (game.time.minute >= 60) {
            game.time.minute -= 60;
            game.time.hour += 1;
            onHourAdvance();
        }
        while (game.time.hour >= 24) {
            game.time.hour -= 24;
            game.time.day += 1;
            onDayAdvance();
        }
    }
    // run one production tick per advanced hour to give realtime feel
    productionTick();
    updateUI();
}

function setSimSpeed(minutesPerSecond) {
    game.time.minutesPerSecond = minutesPerSecond;
    // reset clock timestamp to avoid a large delta
    game._lastClockTS = Date.now();
}

// ─────────────────────────────────────────────────────────────────────────────
// Game Juice: floating text, toasts, day transition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Show a small "+120" / "-800" floating label that drifts upward from anchorEl
 * then fades out. Used for income/spend feedback.
 */
/**
 * Smoothly animate the wallet display from its current shown value to `target`.
 * Uses requestAnimationFrame so the number counts up/down fluidly instead of
 * jumping on every production tick. A new call mid-animation just updates the
 * target — the animation re-aims without restarting.
 */
/**
 * Smoothly animate the portfolio display toward `target`, and pulse green/red
 * when the value moves up or down. Portfolio is driven by market price every
 * UI tick so it naturally breathes — this just makes the movement silky.
 */
function setPortfolioDisplay(target) {
    const el = document.getElementById('portfolio');
    if (!el) return;
    if (game._portfolioDisplayed === undefined) game._portfolioDisplayed = target;
    const prev = game._portfolioDisplayed;
    game._portfolioTarget = target;
    // Color pulse on direction change
    if (Math.abs(target - prev) > 1) {
        const up = target > prev;
        el.style.transition = 'color 0.3s';
        el.style.color = up ? '#4CAF50' : '#ff6b6b';
        clearTimeout(game._portfolioColorReset);
        game._portfolioColorReset = setTimeout(() => {
            el.style.color = '';
        }, 800);
    }
    if (game._portfolioAnimFrame) return;
    const startVal  = game._portfolioDisplayed;
    const startTime = performance.now();
    const duration  = 800;
    function step(now) {
        const t    = Math.min(1, (now - startTime) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        const cur  = startVal + (game._portfolioTarget - startVal) * ease;
        game._portfolioDisplayed = cur;
        el.textContent = Math.round(cur).toLocaleString();
        if (t < 1) {
            game._portfolioAnimFrame = requestAnimationFrame(step);
        } else {
            game._portfolioDisplayed = game._portfolioTarget;
            el.textContent = Math.round(game._portfolioTarget).toLocaleString();
            game._portfolioAnimFrame = null;
        }
    }
    game._portfolioAnimFrame = requestAnimationFrame(step);
}

function setWalletDisplay(target) {
    const el = document.getElementById('wallet');
    if (!el) return;
    // Initialise tracked display value on first call
    if (game._walletDisplayed === undefined) game._walletDisplayed = target;
    game._walletTarget = target;
    // If already animating, just let the running frame pick up the new target
    if (game._walletAnimFrame) return;
    const startVal = game._walletDisplayed;
    const startTime = performance.now();
    const duration = 600; // ms — long enough to feel smooth, short enough to stay accurate
    function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
        const current = Math.round(startVal + (game._walletTarget - startVal) * ease);
        game._walletDisplayed = current;
        el.textContent = current.toLocaleString();
        if (t < 1) {
            game._walletAnimFrame = requestAnimationFrame(step);
        } else {
            game._walletDisplayed = game._walletTarget;
            el.textContent = game._walletTarget.toLocaleString();
            game._walletAnimFrame = null;
        }
    }
    game._walletAnimFrame = requestAnimationFrame(step);
}

function showFloatingText(text, color, anchorEl) {
    const el = document.createElement('div');
    const duration = 2200;
    el.style.cssText = [
        'position:fixed',
        `color:${color}`,
        'font-size:15px',
        'font-weight:800',
        'pointer-events:none',
        'z-index:9999',
        `animation:floatPop ${duration}ms cubic-bezier(0.22,1,0.36,1) forwards`,
        'font-family:monospace',
        'letter-spacing:0.5px',
        `text-shadow:0 0 8px ${color}88, 0 1px 3px #000a`,
        'white-space:nowrap'
    ].join(';');
    el.textContent = text;
    let rect = (anchorEl || document.body).getBoundingClientRect();
    // If the anchor is hidden (e.g. desktop stat-items hidden on mobile), fall
    // back to the mobile compact stats bar so the float appears on-screen.
    if (!rect.width && !rect.height) {
        const fallback = document.getElementById('mobileStatsCompact');
        rect = fallback ? fallback.getBoundingClientRect()
                        : { left: window.innerWidth / 2, top: 48, width: 0, height: 0 };
    }
    // Center horizontally over the anchor, sit just above it — then clamp to viewport
    const cx = Math.max(30, Math.min(window.innerWidth - 30, rect.left + rect.width / 2));
    el.style.left = cx + 'px';
    el.style.top  = (rect.top + rect.height / 2) + 'px';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
}

/**
 * showToast — thin alias kept for backwards compat. Prefer addNotification().
 */
function showToast(text, color) {
    const typeMap = { '#4CAF50': 'success', '#ff6b6b': 'danger', '#ffb84d': 'warning' };
    addNotification(typeMap[color] || 'info', text);
}

/**
 * _flashToast — internal ephemeral bottom-center flash.
 * Only creates the DOM element; persistence is handled by addNotification / the drawer.
 */
function _flashToast(message, type) {
    // Strip emoji/markdown noise for the brief flash — keep it short
    const typeColors = { success: '#4CAF50', danger: '#ff6b6b', warning: '#ffb84d', info: '#7ec8e3' };
    const color = typeColors[type] || '#fff';
    // If a toast is already showing, remove it so the new one starts fresh
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className = 'toast-notification';
    el.style.color = color;
    el.textContent = message;
    document.body.appendChild(el);
    // Remove from DOM after animation completes (3s)
    setTimeout(() => el.remove(), 3050);
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification System
// Single entry point: addNotification(type, message, data)
// Backend-ready: a WebSocket handler just calls addNotification() directly.
//   e.g.  socket.on('notification', ({ type, message, data }) =>
//               addNotification(type, message, data));
// ─────────────────────────────────────────────────────────────────────────────

// Initialise notifications array on game object so it persists across ticks
if (!game.notifications) game.notifications = [];

/**
 * Add a persistent notification.
 * @param {string} type    - 'success' | 'warning' | 'danger' | 'info'
 * @param {string} message - Display text
 * @param {object} [data]  - Optional payload (reserved for backend use)
 */
function addNotification(type, message, data) {
    const notif = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        type: type || 'info',
        message,
        timestamp: Date.now(),
        read: false,
        data: data || null
    };
    game.notifications.unshift(notif); // newest first
    // Cap stored notifications at 50 to prevent unbounded growth
    if (game.notifications.length > 50) game.notifications.length = 50;
    renderNotifications();
    // Also flash the ephemeral bottom-centre toast
    _flashToast(message, type);
}

/** Render the notification list and update the badge. */
function renderNotifications() {
    const list    = document.getElementById('notifList');
    const empty   = document.getElementById('notifEmpty');
    const badge   = document.getElementById('notifBadge');
    if (!list) return;

    const unread = game.notifications.filter(n => !n.read).length;
    if (badge) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.style.display = unread > 0 ? 'inline-flex' : 'none';
    }

    if (game.notifications.length === 0) {
        if (empty) empty.style.display = 'block';
        // Remove all rendered items
        list.querySelectorAll('.notif-item').forEach(el => el.remove());
        return;
    }
    if (empty) empty.style.display = 'none';

    // Diff-render: only add/remove items that changed
    const existing = new Set([...list.querySelectorAll('.notif-item')].map(el => el.dataset.id));
    const current  = new Set(game.notifications.map(n => n.id));

    // Remove stale
    list.querySelectorAll('.notif-item').forEach(el => {
        if (!current.has(el.dataset.id)) el.remove();
    });

    // Add new (prepend)
    for (const notif of game.notifications) {
        if (existing.has(notif.id)) continue;
        const typeColors = {
            success: '#4CAF50',
            danger:  '#ff6b6b',
            warning: '#ffb84d',
            info:    '#7ec8e3'
        };
        const color = typeColors[notif.type] || '#ccc';
        const timeStr = new Date(notif.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = new Date(notif.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });

        const el = document.createElement('div');
        el.className = 'notif-item' + (notif.read ? '' : ' notif-unread');
        el.dataset.id = notif.id;
        el.style.borderLeftColor = color;
        el.innerHTML = `
            <div class="notif-item-body">
                <span class="notif-msg" style="color:${color};">${notif.message}</span>
                <span class="notif-time">${dateStr} ${timeStr}</span>
            </div>
            <button class="notif-dismiss" data-id="${notif.id}" title="Dismiss">✕</button>
        `;
        el.querySelector('.notif-dismiss').addEventListener('click', (e) => {
            e.stopPropagation();
            dismissNotification(notif.id);
        });
        // insert at correct position (top of list, after empty el)
        const firstItem = list.querySelector('.notif-item');
        if (firstItem) list.insertBefore(el, firstItem); else list.appendChild(el);
    }
}

/** Mark all as read (called when drawer opens) */
function markAllRead() {
    game.notifications.forEach(n => { n.read = true; });
    document.querySelectorAll('.notif-item.notif-unread').forEach(el => el.classList.remove('notif-unread'));
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'none';
}

function dismissNotification(id) {
    game.notifications = game.notifications.filter(n => n.id !== id);
    const el = document.querySelector(`.notif-item[data-id="${id}"]`);
    if (el) {
        el.style.transition = 'opacity 0.2s, max-height 0.25s';
        el.style.opacity = '0';
        el.style.maxHeight = '0';
        el.style.overflow = 'hidden';
        el.style.padding = '0';
        setTimeout(() => el.remove(), 260);
    }
    const badge = document.getElementById('notifBadge');
    const unread = game.notifications.filter(n => !n.read).length;
    if (badge) {
        badge.textContent = unread > 9 ? '9+' : unread;
        badge.style.display = unread > 0 ? 'inline-flex' : 'none';
    }
    const list = document.getElementById('notifList');
    if (list && game.notifications.length === 0) {
        const empty = document.getElementById('notifEmpty');
        if (empty) empty.style.display = 'block';
    }
}

function openNotifications() {
    const drawer = document.getElementById('notifDrawer');
    if (!drawer) return;
    drawer.style.display = 'flex';
    drawer.setAttribute('aria-hidden', 'false');
    setTimeout(() => drawer.classList.add('notif-drawer--open'), 10);
    markAllRead();
}

function closeNotifications() {
    const drawer = document.getElementById('notifDrawer');
    if (!drawer) return;
    drawer.classList.remove('notif-drawer--open');
    setTimeout(() => {
        drawer.style.display = 'none';
        drawer.setAttribute('aria-hidden', 'true');
    }, 260);
}

function clearAllNotifications() {
    game.notifications = [];
    const list = document.getElementById('notifList');
    if (list) list.querySelectorAll('.notif-item').forEach(el => el.remove());
    const empty = document.getElementById('notifEmpty');
    if (empty) empty.style.display = 'block';
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'none';
}

/**
 * Flash a large "DAY N" overlay when a new day begins.
 */
function showDayTransition(day) {
    // Don't show on day 1 (it's the game start)
    if (day <= 1) return;
    const el = document.createElement('div');
    el.style.cssText = [
        'position:fixed',
        'left:0','top:0','right:0','bottom:0',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(0,0,0,0.55)',
        'z-index:7000',
        'pointer-events:none',
        'animation:fadeInOut 2.2s ease-in-out forwards'
    ].join(';');
    const isLastDay = day > game.runLength;
    const label = isLastDay ? 'RUN OVER' : `DAY ${day}`;
    const color = isLastDay ? '#ff6b6b' : '#ffb84d';
    el.innerHTML = `<div style="font-size:52px;font-weight:700;color:${color};font-family:monospace;` +
        `text-shadow:0 0 40px ${color}80;letter-spacing:8px;">${label}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot AI — bots dynamically build and occasionally sabotage the player
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Start the bot AI interval. Called once per run from startSimLoops().
 */
function startBotAI() {
    if (!game.botsEnabled) return;
    if (!(game.players || []).some(p => p.isBot)) return;
    if (game._botInterval) return;
    game._botInterval = setInterval(tickBotAI, 30000);
    setTimeout(() => {
        if (game.botsEnabled) tickBotAI();
    }, 8000);
}

/**
 * One AI tick: each bot either builds a new building or sabotages the player.
 */
function tickBotAI() {
    if (game.runEnded || !game.botsEnabled) return;
    game.players.filter(p => p.isBot).forEach(bot => {
        // 70% build, 30% sabotage (only if player has completed buildings)
        const completedPlayerBuildings = game.buildings.filter(b => !b.isUnderConstruction);
        if (Math.random() < 0.70 || completedPlayerBuildings.length === 0) {
            botBuildRandom(bot);
        } else {
            botSabotagePlayer(bot, completedPlayerBuildings);
        }
    });
    calculateProximity();
}

/**
 * Bot picks a weighted-random building type and places it on a random empty cell.
 */
function botBuildRandom(bot) {
    // Weighted building preference: mines favoured early, plants later
    const pool = ['mine', 'mine', 'mine', 'processor', 'processor', 'plant', 'storage'];
    const type = pool[Math.floor(Math.random() * pool.length)];
    const cost = buildingTypes[type].cost;
    if (bot.wallet < cost) return;

    for (let attempt = 0; attempt < 80; attempt++) {
        const cellId = Math.floor(Math.random() * 400);
        const blocked  = game.terrain && ['road','road-h','road-x'].includes(game.terrain[cellId]);
        const occupied = game.enemyBuildings.find(b => b.id === cellId) ||
                         game.buildings.find(b => b.id === cellId);
        if (!blocked && !occupied) {
            bot.wallet -= cost;
            const building = { id: cellId, type, owner: bot.name, ownerId: bot.id, ownerAvatar: bot.avatar || DEFAULT_PLAYER_AVATAR };
            game.enemyBuildings.push(building);
            renderBuilding(cellId, type, false, building);
            return;
        }
    }
}

/**
 * Bot applies a short production debuff to one of the player's completed buildings.
 */
function botSabotagePlayer(bot, targets) {
    const cost = 280;
    if (bot.wallet < cost) return;
    const target = targets[Math.floor(Math.random() * targets.length)];
    // Skip if already debuffed
    if (target.fallout && target.fallout.endTime > Date.now()) return;

    bot.wallet -= cost;
    // 25-second production penalty (softer than player nuke fallout)
    target.fallout = { endTime: Date.now() + 25000, multiplier: 0.55 };

    // flash the targeted cell red briefly
    const cell = document.querySelector(`[data-id="${target.id}"]`);
    if (cell) {
        cell.style.outline = '2px solid #ff4444';
        cell.style.outlineOffset = '-2px';
        setTimeout(() => { cell.style.outline = ''; cell.style.outlineOffset = ''; }, 800);
    }

    addNotification('danger', `⚠️ ${bot.name} sabotaged your ${displayNames[target.type] || target.type}!`);
}
