'use strict';

/* ============================================================
   Headless simulation host

   Loads the *actual* client simulation files into a sandboxed vm context and
   exposes a small control surface (start / tick / input / snapshot).

   Only simulation files are loaded. render.js, ui.js, net.js and rooms.js are
   browser-only and are never evaluated here.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createBrowserShim } from './shim.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = path.resolve(HERE, '../../app/js');

// Dependency order matters: these are classic scripts sharing one global scope,
// mirroring the <script> order in app/index.html.
const SIM_FILES = ['core.js', 'ai.js', 'gameplay.js', 'powerups.js', 'update.js'];

/* The simulation files reference a handful of symbols that live in the
   browser-only modules (net.js supplies the isNet* helpers; ui.js supplies
   playerAction). Those files are never loaded here, so the sandbox defines the
   missing names BEFORE the sim is evaluated.

   Every net helper reports false: server-side there is no host and no guest,
   just one neutral simulation. That makes the sim take its plain local path -
   which is exactly the authoritative behavior we want - and it means all the
   host/guest branching in update.js is simply never entered. */
/* theme.js is a browser-only presentation module (it touches localStorage and
   documentElement), so it is never loaded here. The simulation still reads
   theme.left/right for the color of the effects it emits.

   Rather than bake one player's palette into authoritative events, the server
   emits a SIDE TAG. Each client swaps the tag for its own locally chosen
   color when it replays the event, so both players keep their own palette and
   still see themselves on the right. */
const THEME_STUB = `
var theme = {
  left:  { key: 'left',  name: 'LEFT',  base: '@side:left',  bright: '@side:left',  ghost: '@side:left',  rgba: () => '@side:left' },
  right: { key: 'right', name: 'RIGHT', base: '@side:right', bright: '@side:right', ghost: '@side:right', rgba: () => '@side:right' },
};
`;

const NET_STUBS = `
/* isPvp() must report the truth, unlike the other net stubs below.

   The simulation uses it to decide whether the LEFT paddle belongs to a bot or
   to a remote human: update.js gates the AI's smash and catch on !isPvp(). If
   this always returned false, the AI would fire those abilities on a paddle a
   real player is holding.

   It reads state.opponent, which the match sets to 'pvp', so a headless match
   of any other kind still gets correct AI behavior. */
var isPvp = () => state.opponent === 'pvp';
/* These two describe the CLIENT's relationship to a match it is not
   simulating. The server simulates, so both are false: it is neither watching
   a remote host nor deferring to one. */
var isNetHost = () => false;
var isNetGuest = () => false;
var netSendInput = () => {};
var netInterpolate = () => {};
var netPredictLocalPaddle = () => {};
var net = { active: false, role: null, action: false, targets: null, audio: {} };
var transitioning = false;
// countdownTimer and lastTime are declared by update.js itself; redeclaring
// them here would be a lexical collision in the shared scope.
var mouseCX = -1, mouseCY = -1;
var show = () => {};
var refreshMenu = () => {};
var syncCustomControls = () => {};
${THEME_STUB}
`;

/* When the real net.js is loaded on top, it supplies the net helpers itself.
   Only the ui.js symbols the simulation reaches for are still needed. */
const MINIMAL_STUBS = `
${THEME_STUB}
var transitioning = false;
var mouseCX = -1, mouseCY = -1;
var show = () => {};
var refreshMenu = () => {};
var syncCustomControls = () => {};
`;

/* playerAction lives in ui.js. It is pure state manipulation apart from one
   beep, so it is reproduced here rather than dragging in the whole UI file.
   This is the ONE piece of duplicated logic; it is nine lines and is covered
   by the harness. */
const ACTION_IMPL = `
function applyAction(side) {
  const pad = side === 'player' ? player : ai;
  const held = balls.find(b => b.heldBy === side);
  if (held) { releaseBall(held); return true; }
  if (state.chargeWindow > 0) {
    pad.catchT = CATCH_WINDOW;
    pad.smashT = 0;
    return false;
  }
  if (pad.smashCD <= 0 && pad.smashT <= 0) pad.smashT = SMASH_WINDOW;
  return false;
}
var playerAction = () => applyAction('player');
`;

// Read once at boot; every match reuses the same source text.
const SOURCES = SIM_FILES.map(name => ({
  name,
  code: fs.readFileSync(path.join(APP_JS, name), 'utf8'),
}));

/* Top-level `const`/`let` in a classic script create LEXICAL bindings, which
   are not properties of the vm context's global object. Two consequences:

     1. Each vm.runInContext() call is its own script, so a `const` declared in
        core.js would be invisible to gameplay.js. All sources must therefore be
        concatenated and evaluated as ONE script.
     2. Even then, those bindings are unreachable from host JS (shim.state would
        be undefined), so an explicit bridge exports the ones the server drives.

   The bridge uses accessor properties rather than copying values, because
   `balls` is reassigned wholesale by the simulation (balls = ...). A snapshot
   copy would go stale after the first serve. */
const SIM_EXPORTS = [
  'state', 'balls', 'player', 'ai', 'ghostL', 'ghostR',
  'powerups', 'particles', 'popups', 'ripples',
  'customSettings', 'keys', 'sfx',
  'W', 'H', 'PADDLE_W', 'PADDLE_MARGIN', 'BASE_PADDLE_H', 'PLAYER_SPEED',
  'CATCH_WINDOW', 'SMASH_WINDOW', 'SLOW_FACTOR',
];

// Functions the server calls to drive the match.
const SIM_FUNCTIONS = [
  'update', 'startMatch', 'placeBumpers', 'buildCustomCfg', 'serve',
  'paddleHeight', 'paddleHolds', 'releaseBall', 'clamp', 'topWall', 'botWall',
  'applyAction',
];

const BRIDGE = `
(() => {
  const bridge = globalThis.__sim;
  // Live accessors: reads always see the current binding, and writes reach the
  // simulation (needed for mouseY / balls, which the server assigns).
${SIM_EXPORTS.map(n => `  try { Object.defineProperty(bridge, '${n}', {
    get: () => ${n},
    set: (v) => { try { ${n} = v; } catch (_) {} },
    configurable: true, enumerable: true,
  }); } catch (_) {}`).join('\n')}
${SIM_FUNCTIONS.map(n => `  try { bridge.${n} = (...a) => ${n}(...a); } catch (_) {}`).join('\n')}
  // mouseY is a mutable let the server writes every tick to steer a paddle.
  Object.defineProperty(bridge, 'mouseY', {
    get: () => mouseY, set: (v) => { mouseY = v; },
    configurable: true, enumerable: true,
  });
})();
`;

/* The simulation files call presentation helpers (sfx.*, popup, ripple,
   spawnParticles) directly from physics code. Server-side we do not draw or
   play anything, but those calls still carry information the clients need:
   they mark exactly when and where an effect happened.

   So instead of stubbing them to nothing, we capture them into an event queue
   that ships with the next snapshot. The clients replay the queue locally. */
const EFFECT_CAPTURE = `
(() => {
  const q = globalThis.__events;

  // Presentation effects: recorded with coordinates so clients can mirror them.
  ripple = function (x, y, color, maxR = 60, width = 3) {
    q.push({ k: 'ripple', x, y, c: color, r: maxR, w: width });
  };
  popup = function (x, y, str, color, size = 14) {
    q.push({ k: 'popup', x, y, s: str, c: color, z: size });
  };
  spawnParticles = function (x, y, color, n = 14, power = 260) {
    q.push({ k: 'particles', x, y, c: color, n, p: power });
  };
  // Directional bursts (smash launch trail, paddle impact sparks). The whole
  // options object travels so the client reproduces the exact same shape.
  spawnBurst = function (x, y, color, opts = {}) {
    q.push({ k: 'burst', x, y, c: color, o: opts });
  };

  // Audio: replaced with recorders. Clients own their own playback.
  for (const key of Object.keys(sfx)) {
    const name = key;
    if (typeof sfx[name] !== 'function') continue;
    sfx[name] = (...args) => q.push({ k: 'sfx', n: name, a: args.filter(v => typeof v === 'number') });
  }

  /* beep() is a synthesized tone, not a sample, and a great deal of the game's
     audio is ONLY beeps: the whole catch-zone vocabulary (charge whine, full-
     charge chime, release thump), the combo ladder, bumpers, portals, power-up
     stings and the wave horn all call it directly rather than going through
     sfx.*. Stubbing it to nothing therefore left PvP silent for every one of
     those cues, even though the sample-backed ones came through fine.

     Recording it like any other effect puts them back. The arguments are the
     complete description of the tone, so a client can reproduce it exactly. */
  beep = function (freq, dur = 0.06, type = 'square', vol = 0.12) {
    q.push({ k: 'beep', f: freq, d: dur, ty: type, v: vol });
  };

  /* Layered cues schedule their follow-up tones with setTimeout, which the shim
     neutralises so a match never holds the event loop open. That silently threw
     away the second half of every two-tone cue - the octave chime that marks a
     full charge, the rising pair on a split, the power-up sting.

     Running the callback immediately would collapse the layers into one instant
     of noise, so the delay is recorded instead and the client re-schedules it
     locally. The tone still lands late, on the client, exactly as designed. */
  setTimeout = function (fn, delay = 0) {
    if (typeof fn !== 'function') return 0;
    const mark = q.length;
    fn();
    // Tag whatever the callback queued as delayed, so the client waits before
    // playing it rather than firing it with the rest of this tick's audio.
    for (let i = mark; i < q.length; i++) {
      if (q[i].k === 'beep') q[i].dl = delay;
    }
    return 0;
  };

  // endMatch touches the DOM for the result screen. Server-side we only need
  // the state transition; clients render their own result text.
  endMatch = function () {
    if (state.mode === 'over') return;
    state.mode = 'over';
  };
})();
`;

export class HeadlessMatch {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.netStubs=true] Define the placeholder net helpers.
   *   Set false when the real app/js/net.js will be layered on top (the client
   *   netcode tests do this), since it declares the same names.
   * @param {boolean} [opts.captureEffects=true] Replace the presentation
   *   helpers with recorders. Set false to build a context that behaves like a
   *   browser client, actually spawning particles instead of queueing events -
   *   used by tests that check what a client renders on receiving a snapshot.
   */
  constructor({ netStubs = true, captureEffects = true } = {}) {
    this.shim = createBrowserShim();
    this.shim.__events = [];
    this.shim.__sim = {};
    this.ctx = vm.createContext(this.shim);

    // One script: lexical bindings must share a single top-level scope.
    // 'use strict' directives inside the individual files are stripped of their
    // directive position by concatenation, which is fine - the code does not
    // rely on sloppy-mode semantics, and each file is already strict-safe.
    const combined = [
      netStubs ? NET_STUBS : MINIMAL_STUBS,
      ...SOURCES.map(({ name, code }) => `/* ===== ${name} ===== */\n${code}`),
      ACTION_IMPL,
    ].join('\n;\n');

    try {
      vm.runInContext(combined, this.ctx, { filename: 'pongetitive-sim.js' });
    } catch (err) {
      throw new Error(`Failed to load simulation into headless context: ${err.message}`);
    }

    vm.runInContext(BRIDGE, this.ctx, { filename: 'bridge' });
    if (captureEffects) {
      vm.runInContext(EFFECT_CAPTURE, this.ctx, { filename: 'effect-capture' });
    }

    this.sim = this.shim.__sim;
    this.elapsed = 0;
  }

  /** Evaluate an expression inside the sandbox (used by tests/inspection). */
  eval(expr) {
    return vm.runInContext(expr, this.ctx);
  }

  get state() { return this.sim.state; }
  get balls() { return this.sim.balls; }
  get player() { return this.sim.player; }
  get ai() { return this.sim.ai; }

  /**
   * Configure and begin a match.
   * `settings` uses the same shape the lobby already sends.
   */
  start(settings = {}) {
    const sim = this.sim;
    sim.state.opponent = 'pvp';
    if (settings.gameMode) sim.state.gameMode = settings.gameMode;
    if (settings.difficulty) sim.state.difficulty = settings.difficulty;
    if (settings.matchTime) sim.state.matchTime = settings.matchTime;
    if (settings.custom) {
      Object.assign(sim.customSettings, settings.custom);
      if (settings.custom.balls) Object.assign(sim.customSettings.balls, settings.custom.balls);
      if (settings.custom.powerups) Object.assign(sim.customSettings.powerups, settings.custom.powerups);
      sim.buildCustomCfg();
    }
    sim.placeBumpers();
    sim.startMatch();
    sim.state.mode = 'play';
    this.drainEvents();
  }

  /**
   * Advance the simulation by a fixed timestep.
   * dt is supplied by the caller so the server owns the clock entirely.
   */
  tick(dt) {
    this.elapsed += dt;
    this.shim.__now = this.elapsed * 1000;
    // update(dt) in update.js is the single entry point for one sim step.
    this.sim.update(dt);
  }

  /** Take and clear the queued presentation events. */
  drainEvents() {
    const out = this.shim.__events.slice();
    this.shim.__events.length = 0;
    return out;
  }
}
