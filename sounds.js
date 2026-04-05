/**
 * sounds.js — NukeWar Web Audio sound engine
 *
 * All sounds synthesised entirely via the Web Audio API.
 * No external files, no libraries, no network requests.
 *
 */
const NukeSounds = (() => {
    'use strict';

    let _ctx    = null;
    let _master = null;
    let _enabled = true;
    let _volume  = 0.55;

    // ── Audio context (lazy-init, respects autoplay policy) ─────────────
    function _init() {
        if (_ctx) return _ctx;
        try {
            _ctx    = new (window.AudioContext || window.webkitAudioContext)();
            _master = _ctx.createGain();
            _master.gain.value = _volume;
            _master.connect(_ctx.destination);
        } catch (e) {
            console.warn('[NukeSounds] AudioContext unavailable:', e);
            _enabled = false;
            return null;
        }
        return _ctx;
    }

    function _resume() {
        if (_ctx && _ctx.state === 'suspended') _ctx.resume().catch(() => {});
    }

    /**
     * Build and fire a single oscillator tone with an ADSR-ish envelope.
     * @param {number}  freq    - Hz
     * @param {string}  type    - OscillatorType ('sine'|'triangle'|'sawtooth'|'square')
     * @param {number}  t       - AudioContext start time (ctx.currentTime + offset)
     * @param {number}  dur     - Total duration (seconds)
     * @param {number}  peak    - Peak gain 0–1
     * @param {object}  opts    - { attack, detune, freqRamp }
     */
    function _tone(freq, type, t, dur, peak, opts = {}) {
        const ctx = _init();
        if (!ctx || !_enabled) return;
        _resume();

        const osc = ctx.createOscillator();
        const env = ctx.createGain();

        osc.type = type || 'sine';
        osc.frequency.setValueAtTime(Math.max(1, freq), t);
        if (opts.detune) osc.detune.setValueAtTime(opts.detune, t);
        if (opts.freqRamp) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.freqRamp), t + dur);
        }

        const atk = opts.attack ?? 0.004;
        env.gain.setValueAtTime(0.0001, t);
        env.gain.linearRampToValueAtTime(peak, t + atk);
        env.gain.exponentialRampToValueAtTime(peak * 0.65, t + atk + dur * 0.25);
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        osc.connect(env);
        env.connect(_master);
        osc.start(t);
        osc.stop(t + dur + 0.025);
    }

    /**
     * Short white-noise burst (impact / danger textures).
     */
    function _noise(t, dur, peak, opts = {}) {
        const ctx = _init();
        if (!ctx || !_enabled) return;
        _resume();

        const bufLen = Math.ceil(ctx.sampleRate * dur);
        const buf    = ctx.createBuffer(1, bufLen, ctx.sampleRate);
        const data   = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

        const src    = ctx.createBufferSource();
        src.buffer   = buf;

        const filt   = ctx.createBiquadFilter();
        filt.type    = opts.filterType  || 'bandpass';
        filt.frequency.value = opts.filterFreq || 800;
        filt.Q.value = opts.Q           || 0.5;

        const env = ctx.createGain();
        env.gain.setValueAtTime(peak, t);
        env.gain.exponentialRampToValueAtTime(0.0001, t + dur);

        src.connect(filt);
        filt.connect(env);
        env.connect(_master);
        src.start(t);
        src.stop(t + dur + 0.01);
    }

    // ════════════════════════════════════════════════════════════════════
    //  PUBLIC SOUNDS
    // ════════════════════════════════════════════════════════════════════

    /**
     * Tiny mechanical click — generic button / toggle press.
     */
    function uiTick() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(1400, 'sine',     t,        0.045, 0.10, { attack: 0.001 });
        _tone(900,  'sine',     t + 0.014, 0.040, 0.05, { attack: 0.001 });
    }

    /**
     * Menu open bloom — hamburger toggle expanding.
     */
    function menuOpen() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(380,  'sine', t,        0.18, 0.07, { attack: 0.014, freqRamp: 660 });
        _tone(660,  'sine', t + 0.08, 0.14, 0.05, { attack: 0.010 });
    }

    /**
     * Menu close — subtle downward breath.
     */
    function menuClose() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(600, 'sine', t, 0.12, 0.05, { attack: 0.005, freqRamp: 320 });
    }

    /**
     * Building type selected from the build menu.
     * Two-note rising confirm: D5 → A5.
     */
    function buildSelect() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(587.33, 'triangle', t,        0.13, 0.14, { attack: 0.003 });
        _tone(880,    'sine',     t + 0.075, 0.12, 0.09, { attack: 0.002 });
    }

    /**
     * Building placed on grid — solid thunk + rising chime.
     * Triggers anticipation (construction incoming).
     */
    function buildPlace() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        // Low placement thunk
        _tone(110,  'sine',     t,        0.16, 0.28, { attack: 0.002, freqRamp: 58 });
        // Mid-body confirmation
        _tone(440,  'triangle', t + 0.06, 0.22, 0.16, { attack: 0.006 });
        // Rising chime (anticipation hook)
        _tone(550,  'sine',     t + 0.17, 0.25, 0.10, { attack: 0.006 });
        _tone(660,  'sine',     t + 0.27, 0.20, 0.07, { attack: 0.005 });
    }

    /**
     * Building construction complete — THE main dopamine hit.
     * C5→E5→G5→C6 major arpeggio with shimmer overtones.
     */
    function buildComplete() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;

        // Root note sustain underneath
        _tone(261.63, 'sine', t, 1.0, 0.12, { attack: 0.02  });

        // Ascending arpeggio: C5 E5 G5 C6
        const notes   = [523.25, 659.25, 783.99, 1046.50];
        const delays  = [0,      0.110,  0.230,  0.370 ];
        const durs    = [0.70,   0.60,   0.55,   0.80  ];
        const vols    = [0.22,   0.19,   0.17,   0.24  ];

        notes.forEach((freq, i) => {
            // Pure fundamental
            _tone(freq,     'sine',     t + delays[i], durs[i],       vols[i],       { attack: 0.004 });
            // Octave shimmer (very soft)
            _tone(freq * 2, 'sine',     t + delays[i], durs[i] * 0.6, vols[i] * 0.16, { attack: 0.005, detune: 4 });
            // Warm triangle body
            _tone(freq,     'triangle', t + delays[i], durs[i] * 0.5, vols[i] * 0.10, { attack: 0.006, detune: -2 });
        });
    }

    /**
     * Day advance — majestic 4-step ascending fanfare.
     */
    function dayAdvance() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;

        // A3 → E4 → A4 → E5
        const steps   = [220, 329.63, 440, 659.25];
        const offsets = [0,   0.19,   0.38, 0.57  ];

        steps.forEach((freq, i) => {
            _tone(freq,       'sine',     t + offsets[i], 0.55, 0.13, { attack: 0.020 });
            _tone(freq * 1.5, 'triangle', t + offsets[i] + 0.04, 0.40, 0.055, { attack: 0.012 });
        });
        // Final high shimmer
        _tone(1318.51, 'sine', t + 0.76, 0.55, 0.10, { attack: 0.010 });
    }

    /**
     * Success notification — bright rising ding-ding.
     * E5 → C#6 perfect major 6th = universally happy.
     */
    function notifSuccess() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(659.25,  'sine', t,        0.20, 0.13, { attack: 0.003 });
        _tone(1046.50, 'sine', t + 0.09, 0.22, 0.10, { attack: 0.003 });
    }

    /**
     * Warning notification — cautionary double pulse, slightly dissonant.
     */
    function notifWarning() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(493.88, 'triangle', t,        0.14, 0.11, { attack: 0.005 });
        _tone(369.99, 'triangle', t + 0.12, 0.20, 0.09, { attack: 0.005 });
    }

    /**
     * Danger / error notification — descending alarm stabs.
     */
    function notifDanger() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(320, 'sawtooth', t,        0.10, 0.09, { attack: 0.002, freqRamp: 210 });
        _tone(210, 'sawtooth', t + 0.09, 0.17, 0.07, { attack: 0.002, freqRamp: 140 });
        _noise(t, 0.08, 0.04, { filterType: 'lowpass', filterFreq: 420 });
    }

    /**
     * Nuclear strike launched — sub-bass boom + shriek.
     */
    function nuclear() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        // Sub boom
        _tone(55,  'sine',     t, 1.1,  0.45, { attack: 0.010, freqRamp: 22 });
        // Impact body
        _tone(110, 'sawtooth', t, 0.20, 0.22, { attack: 0.001, freqRamp: 38 });
        // High scream decay
        _tone(880, 'sawtooth', t, 0.65, 0.14, { attack: 0.001, freqRamp: 55 });
        // Noise burst impact
        _noise(t, 0.55, 0.16, { filterType: 'bandpass', filterFreq: 350, Q: 0.3 });
    }

    /**
     * Nuke armed — "YES, locked in!" power-up moment.
     * Rising 4-step brass fanfare (like a cinematic "BWAAAH" ascending stab),
     * topped with a bright shimmering overtone ring-out. Pure dopamine hit.
     * G3 → B3 → D4 → G4 (G major arpeggio, universally triumphant).
     */
    function nukeArmed() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;

        // Each step: thick detuned sawtooth (brass body) + pure sine fundamental + octave shimmer
        function brassHit(t0, fund, vol, dur) {
            // Sawtooth body — bright attack, decays to body
            _tone(fund,       'sawtooth', t0,          dur,          vol,          { attack: 0.006, freqRamp: fund * 0.96, detune:  8 });
            _tone(fund,       'sawtooth', t0,          dur,          vol * 0.55,   { attack: 0.006, freqRamp: fund * 0.96, detune: -8 });
            // Sine fundamental for warmth and punch
            _tone(fund,       'sine',     t0,          dur * 1.15,   vol * 0.70,   { attack: 0.008 });
            // Octave shimmer — the "sparkle" on top
            _tone(fund * 2,   'sine',     t0 + 0.02,   dur * 0.65,   vol * 0.30,   { attack: 0.012 });
            // Fifth harmony underneath
            _tone(fund * 1.5, 'triangle', t0 + 0.01,   dur * 0.80,   vol * 0.20,   { attack: 0.010 });
        }

        // Rising arpeggio: G3 → B3 → D4 → G4
        //                  196   247   294   392
        brassHit(t,          196,  0.14, 0.18);
        brassHit(t + 0.175,  247,  0.17, 0.18);
        brassHit(t + 0.350,  294,  0.20, 0.20);
        brassHit(t + 0.545,  392,  0.28, 0.75);  // G4 — final big chord, long ring-out

        // Final chord bloom: wide high shimmer that swells overtop
        _tone(784,  'sine',     t + 0.55,  0.70, 0.12,  { attack: 0.045 });          // G5
        _tone(1175, 'sine',     t + 0.60,  0.60, 0.07,  { attack: 0.065 });          // D6
        _tone(1568, 'sine',     t + 0.65,  0.50, 0.038, { attack: 0.080 });          // G6
        // Rising noise "whoosh" into the final hit
        _noise(t + 0.48, 0.12, 0.08, { filterType: 'bandpass', filterFreq: 1200, Q: 0.8 });

        // Gun cock — sharp click → metallic slide → satisfying lock clack
        // timed to complete just as the big G4 lands
        _noise(t + 0.38,  0.018, 0.30, { filterType: 'bandpass', filterFreq: 4200, Q: 12 }); // pull-back click
        _noise(t + 0.392, 0.13,  0.11, { filterType: 'highpass',  filterFreq: 2400, Q: 1.0 }); // chamber slide
        _noise(t + 0.525, 0.022, 0.36, { filterType: 'bandpass', filterFreq: 2800, Q: 9  }); // lock clack
    }

    /**
     * Sabotage / steal executed — sneaky downward glide.
     */
    function sabotage() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(660, 'sine',     t,        0.24, 0.11, { attack: 0.008, freqRamp: 290 });
        _tone(220, 'triangle', t + 0.13, 0.18, 0.07, { attack: 0.010 });
    }

    /**
     * Income / wallet gain — bright ascending coin jingle.
     * C6 → E6 → G6 (major triad, feels rewarding).
     */
    function walletGain() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        [1046.50, 1318.51, 1567.98].forEach((freq, i) => {
            _tone(freq, 'sine', t + i * 0.075, 0.15, 0.10 - i * 0.01, { attack: 0.002 });
        });
    }

    /**
     * Tab / navigation switch — subtle high tick.
     */
    function tabSwitch() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(1047, 'sine', t, 0.07, 0.07, { attack: 0.002 });
    }

    /**
     * Authentication / login success — warm rising triad.
     */
    function authSuccess() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(523.25, 'sine', t,        0.24, 0.13, { attack: 0.008 });
        _tone(659.25, 'sine', t + 0.13, 0.22, 0.11, { attack: 0.005 });
        _tone(783.99, 'sine', t + 0.26, 0.32, 0.13, { attack: 0.005 });
    }

    /**
     * OTP / login code sent confirmation.
     */
    function codeSent() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(660, 'triangle', t,        0.11, 0.09, { attack: 0.003 });
        _tone(880, 'sine',     t + 0.09, 0.13, 0.07, { attack: 0.003 });
    }

    /**
     * Lobby join / run start.
     */
    function lobbyJoin() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(440, 'sine',     t,        0.18, 0.12, { attack: 0.010 });
        _tone(550, 'triangle', t + 0.10, 0.18, 0.09, { attack: 0.008 });
        _tone(660, 'sine',     t + 0.20, 0.24, 0.11, { attack: 0.006 });
    }

    /**
     * Incoming chat message from another player — warm bubbly pop.
     * Two soft rounded notes: C6 then G5, like a gentle messenger ping.
     */
    function chatReceive() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(1046.50, 'sine',     t,        0.13, 0.09, { attack: 0.005 });
        _tone(783.99,  'triangle', t + 0.07, 0.12, 0.07, { attack: 0.005 });
    }

    /**
     * Chat message sent by the local player — smooth outgoing swoosh.
     * G5 rising to A5 with a tiny C6 sparkle at the end.
     * Similar vibe to chatReceive but outward-feeling — shorter, breezier.
     */
    function chatSend() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _tone(783.99,  'sine', t,        0.17, 0.07, { attack: 0.008, freqRamp: 880 });
        _tone(1046.50, 'sine', t + 0.11, 0.09, 0.05, { attack: 0.004 });
    }

    /**
     * Nuke manufacture initiated — deep industrial reactor startup.
     * Industrial steam-release + mechanical engagement sequence.
     * Layer 1: Steam hiss — bandpass noise burst, sharp attack, slow bleed-off
     * Layer 2: Pressure thud — low sine valve-slam on the release
     * Layer 3: Mechanical ratchet — 4 rapid clicks like a mechanism locking
     * Layer 4: Rising whirr — sawtooth sweep building to engagement
     * Layer 5: Confirmation ping — clean triangle "ready" chime
     */
    function nukeManufactureStart() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        _resume();
        const t = ctx.currentTime;

        // ── Steam burst — initial pressure release hiss ──────────────────
        _noise(t,        0.50, 0.22, { filterType: 'bandpass', filterFreq: 1800, Q: 0.6 });
        // Secondary steam tail — softer, slightly lower frequency, longer bleed
        _noise(t + 0.06, 0.70, 0.10, { filterType: 'bandpass', filterFreq: 900,  Q: 0.4 });

        // ── Pressure valve thud — low sine slam on steam release ─────────
        _tone(120, 'sine', t, 0.18, 0.28, { attack: 0.004, freqRamp: 60 });

        // ── Mechanical ratchet — 4 rapid-fire clicks like cogs engaging ──
        [0.08, 0.145, 0.205, 0.26].forEach(off => {
            _noise(t + off, 0.025, 0.28, { filterType: 'bandpass', filterFreq: 3200, Q: 14 });
        });

        // ── Rising machine whirr — sawtooth sweeping up as reactor spins ─
        _tone(140, 'sawtooth', t + 0.18, 0.55, 0.09, { attack: 0.020, freqRamp: 440 });
        // Harmonic layer on top of whirr — triangle octave
        _tone(280, 'triangle', t + 0.22, 0.45, 0.06, { attack: 0.018, freqRamp: 660 });

        // ── Confirmation ping — "locked and loaded" ──────────────────────
        _tone(880,  'triangle', t + 0.62, 0.22, 0.11, { attack: 0.010 });
        _tone(1320, 'sine',     t + 0.70, 0.18, 0.07, { attack: 0.008 });
    }

    /**
     * Nuke countdown tick — precision clock click for final seconds.
     * Crisp bandpass noise burst + brief high sine. Short, punchy, not harsh.
     * Designed to play each second when ≤ 5s remain.
     */
    function nukeCountdownTick() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        _noise(t, 0.028, 0.20, { filterType: 'bandpass', filterFreq: 2400, Q: 9 });
        _tone(1600, 'sine', t, 0.022, 0.08, { attack: 0.001 });
    }

    /**
     * Nuke launch warning siren — deep warm foghorn double-pulse.
     * Low sine sweep + triangle harmonic. Two gentle bellows.
     * NOT harsh or grating — warm, low-pitched, satisfying.
     */
    function nukeLaunchWarning() {
        const ctx = _init(); if (!ctx || !_enabled) return;
        const t = ctx.currentTime;
        // Pulse 1
        _tone(90,  'sine',     t,        0.85, 0.18, { attack: 0.080, freqRamp: 145 });
        _tone(180, 'triangle', t,        0.85, 0.09, { attack: 0.080, freqRamp: 290 });
        // Pulse 2 — slightly louder
        _tone(85,  'sine',     t + 1.15, 0.85, 0.22, { attack: 0.075, freqRamp: 140 });
        _tone(170, 'triangle', t + 1.15, 0.85, 0.11, { attack: 0.075, freqRamp: 280 });
        // Pulse 3
        _tone(90,  'sine',     t + 2.30, 0.85, 0.18, { attack: 0.080, freqRamp: 145 });
        _tone(180, 'triangle', t + 2.30, 0.85, 0.09, { attack: 0.080, freqRamp: 290 });
        // Pulse 4 — final, loudest
        _tone(85,  'sine',     t + 3.45, 0.85, 0.26, { attack: 0.075, freqRamp: 140 });
        _tone(170, 'triangle', t + 3.45, 0.85, 0.13, { attack: 0.075, freqRamp: 280 });
    }

    // ── Volume / mute control ────────────────────────────────────────────
    function setVolume(v) {
        _volume = Math.min(1, Math.max(0, Number(v) || 0));
        if (_master) _master.gain.value = _enabled ? _volume : 0;
    }

    function setEnabled(val) {
        _enabled = !!val;
        if (_master) _master.gain.value = _enabled ? _volume : 0;
    }

    function isEnabled() { return _enabled; }

    /** Call on the first user gesture to warm up the AudioContext. */
    function prime() { _init(); _resume(); }

    // ── Public API ───────────────────────────────────────────────────────
    return {
        uiTick,
        menuOpen,
        menuClose,
        buildSelect,
        buildPlace,
        buildComplete,
        dayAdvance,
        notifSuccess,
        notifWarning,
        notifDanger,
        nuclear,
        nukeArmed,
        sabotage,
        walletGain,
        tabSwitch,
        authSuccess,
        codeSent,
        lobbyJoin,
        chatReceive,
        chatSend,
        nukeManufactureStart,
        nukeCountdownTick,
        nukeLaunchWarning,
        setVolume,
        setEnabled,
        isEnabled,
        prime,
    };
})();
