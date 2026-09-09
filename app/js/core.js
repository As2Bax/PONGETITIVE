'use strict';

/* ============================================================
   PONGETITIVE - You vs AI, AI vs AI, or head-to-head online.
   You are always on the RIGHT. The LEFT paddle is the AI, or in Player-vs-
   Player the remote opponent (each client sees itself on the right).
   Modes: CLASSIC (timed) | CHAOS | SURVIVAL | ENDLESS | ROYALE
   ============================================================ */

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = 900;
const H = 560;

// Console diagnostics: useful game events only, never per-frame telemetry.
// All channels start enabled; toggle them in DevTools, e.g. PONG_DEBUG.ai = false.
const PONG_DEBUG = window.PONG_DEBUG ??= { ai: true, game: true, events: true, powerups: true };
function debugLog(channel, message, details) {
  if (!PONG_DEBUG[channel]) return;
  if (details === undefined) console.debug(`[PONG:${channel.toUpperCase()}] ${message}`);
  else console.debug(`[PONG:${channel.toUpperCase()}] ${message}`, details);
}

// crisp rendering on hi-dpi screens
const DPR = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = W * DPR;
canvas.height = H * DPR;

/* ---------- config ---------- */
const PADDLE_W = 14;
const BASE_PADDLE_H = 90;
const PADDLE_MARGIN = 26;
const BALL_R = 8;
const PLAYER_SPEED = 620;         // keyboard px/s
const MAX_BOUNCE_ANGLE = Math.PI / 3.4; // ~53deg
const SURVIVAL_LIVES = 3;
const WAVE_EVERY = 20;      // s per survival wave
const WAVE_MAX_BUMPERS = 4;

/* ghost paddle power-up */
const GHOST_SCALE = 0.55;       // ghost paddles are smaller
const GHOST_OFFSET = 74;        // how far in-field from the main paddles
const GHOST_DURATION = 10;      // seconds the ghost helper sticks around

/* rally combo: every hit past the threshold raises the effective speed cap -
   a long enough rally has effectively no limit */
const COMBO_START = 4;          // combo kicks in at this many consecutive hits
const COMBO_CAP_STEP = 22;      // extra px/s of speed cap per combo level
const comboLevel = () => Math.max(0, state.rally - COMBO_START);
const comboBonus = () => comboLevel() * COMBO_CAP_STEP;
const speedCap = () => cfg().maxSpeed + comboBonus();

/* active mechanics */
const SMASH_WINDOW = 0.25;   // s the smash stays armed after pressing
const SMASH_CD = 3;          // s cooldown
const SMASH_MULT = 1.45;     // speed multiplier on a smashed return
const AI_SMASH_CHANCE = 0.16;
/* ---------- ball types ---------- */
// rolled on spawn; each has its own look, behavior, and point value
const BALL_TYPES = {
  normal:  { weight: 62 },
  gold:    { weight: 8 },   // 3 pts, big & shiny
  phantom: { weight: 8 },   // 2 pts, blinks in and out of visibility
  heavy:   { weight: 8 },   // slow tank - hits harder (shake), hard to speed up
  splitter:{ weight: 7 },   // splits in two on its first paddle hit
  comet:   { weight: 7 },   // 2 pts, small and 25% faster
};
function rollBallType() {
  // custom difficulty can disable specific special types; normal is always in
  const allowed = (t) => t === 'normal' || !isCustom() || customSettings.balls[t];
  let total = 0;
  for (const t in BALL_TYPES) if (allowed(t)) total += BALL_TYPES[t].weight;
  let roll = Math.random() * total;
  for (const t in BALL_TYPES) {
    if (!allowed(t)) continue;
    roll -= BALL_TYPES[t].weight;
    if (roll <= 0) return t;
  }
  return 'normal';
}
const PHANTOM_CYCLE = 1.6;   // s per visible/invisible cycle
const FIRE_FRAC = 0.85;      // ball at >85% of max speed ignites (2 pts)
const PORTAL_EVERY = 22;     // portals appear roughly this often (s)

/* more field events - periodic, telegraphed, all optional in CUSTOM */
const WELL_EVERY = 30;       // gravity well cadence (s)
const WELL_LIFE = 8;
const WELL_R = 210;          // influence radius
const WELL_TURN = 4.2;       // rad/s of steering toward the core at full strength
const WIND_EVERY = 30;       // wind gust cadence (s)
const WIND_LIFE = 5;
const WIND_FORCE = 260;      // px/s² along gust direction (always vertical-ish)
const PORTAL_LIFE = 9;       // and stay for this long
const PORTAL_R = 22;

/* ----------------------------------------------------------------
   The AI uses a standard brain at most levels; RELAXED softens it,
   INSANE sharpens it and occasionally uses arena tricks, and IMPOSSIBLE
   uses a perfect brain.
   Difficulty changes YOUR handicaps, the game's physics, and how much of the
   arena's chaos is switched on:
     paddleScale - your paddle size
     ballSpeed / speedup / maxSpeed - how fast things get
     rallyShrink - your paddle shrinks a bit every time YOU hit
     fog - the ball fades out as it approaches your side
     flicker / inverted - IMPOSSIBLE-only curses on your paddle and controls
     events - which field events can spawn (portals / well / wind)
     powerups - which pickups are in the spawn pool for this tier
---------------------------------------------------------------- */
const AI_CFG = {
  speed: 390,          // max paddle px/s
  lookAhead: 0.28,     // seconds of naive extrapolation (no perfect bounce solving)
  wobble: 38,          // drifting hand-wobble (px)
  lapseChance: 0.3,    // chance to misjudge an incoming ball
  lapseError: 120,     // how bad a misjudgement is (px)
};

const DIFFICULTY = {
  // RELAXED: the anti-competitive tier - big paddle, lazy ball, and the AI
  // loosens up too (chill brain). For unwinding, not for winning arguments.
  relaxed: { paddleScale: 1.5, ballSpeed: 320, speedup: 1.02, maxSpeed: 700, rallyShrink: false, fog: null, aiChill: true, events: {},             powerups: { grow: true, shrink: true, slow: true } },
  easy:   { paddleScale: 1.25, ballSpeed: 380, speedup: 1.035, maxSpeed: 880,  rallyShrink: false, fog: null,              events: {},             powerups: { grow: true, shrink: true, slow: true } },
  normal: { paddleScale: 1.0,  ballSpeed: 450, speedup: 1.055, maxSpeed: 1080, rallyShrink: false, fog: null,              events: { wind: true }, powerups: { grow: true, shrink: true, slow: true, multi: true } },
  hard:   { paddleScale: 0.7,  ballSpeed: 520, speedup: 1.075, maxSpeed: 1250, rallyShrink: true,  fog: { start: 0.55, end: 0.85 }, events: { portals: true, wind: true }, powerups: { grow: true, shrink: true, slow: true, multi: true, ghost: true, charge: true } },
  insane: {
    paddleScale: 0.5, ballSpeed: 620, speedup: 1.10, maxSpeed: 1500,
    rallyShrink: true, fog: { start: 0.42, end: 0.68 },
    aiSharp: true,     // a hungry, in-form opponent - not a machine, but close
    aiFieldPlay: true, // it toys with wells/portals - but only now and then, and never with impossible's surgical precision
    events: { portals: true, well: true, wind: true },
    powerups: { grow: true, shrink: true, multi: true, slow: true, ghost: true, charge: true, flip: true },
  },
  impossible: {
    paddleScale: 0.4, ballSpeed: 650, speedup: 1.11, maxSpeed: 1600,
    rallyShrink: true, fog: { start: 0.30, end: 0.55 },
    // it's in the name:
    flicker: true,       // your own paddle phases in and out of visibility
    inverted: 12,        // controls randomly invert for a moment, every ~this many s
    aiPerfect: true,     // the AI drops its human act entirely
    events: { portals: true, well: true, wind: true },
    powerups: { grow: true, shrink: true, multi: true, slow: true, ghost: true, charge: true, flip: true },
  },
  custom: null, // built from the custom panel at start; see buildCustomCfg()
};

/* CUSTOM difficulty: player-tuned. Stored settings feed buildCustomCfg(). */
const customSettings = {
  paddle: 'normal',    // big | normal | small | tiny
  speed: 'normal',     // slow | normal | fast | ludicrous
  wear: false,
  fog: false,
  flicker: false,
  inverted: false,
  aiSkill: 'standard', // chill | standard | sharp | perfect
  barrier: false,      // closing + breathing zone walls (royale-style)
  // special ball types allowed to spawn (normal always spawns)
  balls: { gold: true, phantom: true, heavy: true, splitter: true, comet: true },
  // power-ups allowed in the spawn pool (empty set = no power-ups at all)
  powerups: { grow: true, shrink: true, multi: true, mega: true, slow: true, ghost: true, charge: true, flip: true },
  portals: true,       // field event: periodic teleport pair
  well: true,          // field event: gravity well vortex
  wind: true,          // field event: vertical wind gusts
};
const isCustom = () => state.difficulty === 'custom';
// Custom owns its barrier toggle; named presets inherit their mode's arena rules.
const zoneActive = () => isCustom() ? customSettings.barrier : mode().zone;
const CUSTOM_PADDLE = { big: 1.25, normal: 1.0, small: 0.7, tiny: 0.5 };
const CUSTOM_SPEED = {
  slow:      { ballSpeed: 380, speedup: 1.035, maxSpeed: 880  },
  normal:    { ballSpeed: 450, speedup: 1.055, maxSpeed: 1080 },
  fast:      { ballSpeed: 550, speedup: 1.08,  maxSpeed: 1350 },
  ludicrous: { ballSpeed: 680, speedup: 1.12,  maxSpeed: 1700 },
};
function buildCustomCfg() {
  const sp = CUSTOM_SPEED[customSettings.speed];
  DIFFICULTY.custom = {
    paddleScale: CUSTOM_PADDLE[customSettings.paddle],
    ballSpeed: sp.ballSpeed, speedup: sp.speedup, maxSpeed: sp.maxSpeed,
    rallyShrink: customSettings.wear,
    fog: customSettings.fog ? { start: 0.45, end: 0.72 } : null,
    flicker: customSettings.flicker,
    inverted: customSettings.inverted ? 12 : 0,
    aiSkill: customSettings.aiSkill,
    // The AI's harshest behaviors (kill-shot aim, guaranteed smashes,
    // full-charge catches) are keyed off these flags rather than off aiSkill
    // directly, so each tier switches on exactly one of them.
    aiPerfect: customSettings.aiSkill === 'perfect',
    aiSharp: customSettings.aiSkill === 'sharp',
    aiChill: customSettings.aiSkill === 'chill',
    aiFieldPlay: customSettings.aiSkill === 'sharp',
    events: {
      portals: customSettings.portals,
      well: customSettings.well,
      wind: customSettings.wind,
    },
    powerups: { ...customSettings.powerups },
  };
}
buildCustomCfg();
const RALLY_SHRINK_STEP = 0.07;   // per own hit
const RALLY_SHRINK_MIN = 0.4;
const INVERT_DURATION = 2;        // s the inverted-controls curse lasts
// IMPOSSIBLE: the AI stops pretending to be human - and plays ruthlessly:
// exact multi-bounce prediction, edge-of-paddle contact to fire returns into
// the corner you can't reach, guaranteed smashes, full-charge catches.
const PERFECT_BRAIN = {
  speed: 2000, lookAhead: 3, wobble: 0, lapseChance: 0, lapseError: 0,
  ruthless: true,
};
// RELAXED: the AI kicks back - slower hands, wobblier aim, more whiffs
const CHILL_BRAIN = {
  speed: 290, lookAhead: 0.2, wobble: 62, lapseChance: 0.45, lapseError: 160,
};
// INSANE: a hungry opponent at the top of its game - fast hands, long reads,
// steady aim, and it almost never misjudges. Human-shaped, machine-adjacent.
const SHARP_BRAIN = {
  speed: 640, lookAhead: 0.75, wobble: 10, lapseChance: 0.06, lapseError: 50,
};
// Named skill tiers, selectable directly on CUSTOM.
const AI_BRAINS = {
  chill: CHILL_BRAIN,
  standard: null,        // null = keep the caller's base brain
  sharp: SHARP_BRAIN,
  perfect: PERFECT_BRAIN,
};
// pick the brain a paddle should run. CUSTOM names its tier outright; the
// preset difficulties still express theirs as flags. IMPOSSIBLE overrides
// everything, RELAXED softens the solo opponent (spectator bots keep their
// own personalities).
const brainFor = (base) => {
  const skill = cfg().aiSkill;
  if (skill) return AI_BRAINS[skill] || base;
  return cfg().aiPerfect ? PERFECT_BRAIN :
    cfg().aiSharp ? SHARP_BRAIN :
    (cfg().aiChill && !isAivai()) ? CHILL_BRAIN : base;
};

/* ---------- game modes ---------- */
const MODES = {
  classic:  { timed: true,  balls: 1, maxBalls: 3, spawnMin: 5,   spawnVar: 4,   puCap: 2 },
  chaos:    { timed: true,  balls: 3, maxBalls: 8, spawnMin: 1.2, spawnVar: 1,   puCap: 6, bumpers: 2, rain: 8, mega: true },
  survival: { timed: false, balls: 2, maxBalls: 6, spawnMin: 4,   spawnVar: 3,   puCap: 3, waves: true },
  endless:  { timed: false, balls: 1, maxBalls: 4, spawnMin: 4,   spawnVar: 3,   puCap: 3 },
  ffa:      { timed: true,  balls: 4, maxBalls: 10, spawnMin: 1,  spawnVar: 1,   puCap: 7, zone: true, bumpers: 4, rain: 5, movingBumpers: true, mega: true },
};
/* Barriers should apply real pressure. The corridor closes quickly enough to
   change how a rally is played, settles narrow enough that position actually
   matters, and keeps moving once it is there - a static tunnel stops being a
   hazard and just becomes the new arena.

   The floor is deliberately a little under two paddle-heights: tight enough to
   punish poor positioning, wide enough that a ball can still be returned. */
const ZONE_RATE = 14;       // px/s each wall closes in (ROYALE)
const ZONE_MIN_H = 190;     // minimum playable corridor height (~2 paddles)
const ZONE_BREATHE = 34;    // corridor widens and narrows as it moves (px)
const ZONE_BREATHE_SPEED = 0.9;  // rad/s of the breathing cycle
const ZONE_DRIFT = 88;      // px the safe corridor wanders off-center
const ZONE_DRIFT_SPEED = 0.5;    // rad/s of the wander
/* How much of the barrier's progress survives a goal. Rallies are short next to
   the closing time, so a full reset made the closed corridor unreachable; this
   eases the walls back out without discarding the pressure entirely. */
const ZONE_GOAL_RELIEF = 0.55;
const HARD_BALL_CAP = 16;   // absolute max balls, mega included

/* ---------- power-ups ---------- */
const POWERUP_TYPES = {
  grow:   { color: '#6fbf73', label: '+',  name: 'BIG PADDLE' },
  shrink: { color: '#cf5a4e', label: '-',  name: 'SHRINK FOE' },
  multi:  { color: '#d9a441', label: '×2', name: 'MULTIBALL'  },
  mega:   { color: '#d2803a', label: '×8', name: 'BALL STORM' },
  slow:   { color: '#8f76c8', label: '~',  name: 'SLOW-MO'    },
  ghost:  { color: '#93b8cf', label: '‖',  name: 'GHOST PADDLE' },
  charge: { color: '#e3c15a', label: '◎',  name: 'CATCH ZONE'  },
  heart:  { color: '#d2647f', label: '♥',  name: 'EXTRA LIFE' },
  flip:   { color: '#c98bbf', label: '↔',  name: 'FLIP' }, 
};
/* catch zone: for a window, paddles CATCH the ball, charge it up, and
   release it at boosted speed. Everyone - humans, AI, bots - can use it. */
const CHARGE_WINDOW = 30;    // s the catch window stays open
const CATCH_WINDOW = 0.45;   // click shortly before contact to catch
const CHARGE_HOLD_LIMIT = 3; // full charge can be aimed briefly before auto-release
const CHARGE_MAX = 1.2;      // s of holding for a full charge
const CHARGE_BOOST = 1.9;    // speed multiplier at full charge
const CATCH_CD = 1.5;        // s before the same ball can be caught again
const POWERUP_R = 16;
const EFFECT_DURATION = 8;   // grow / shrink seconds
const SLOW_DURATION = 4;
const SLOW_FACTOR = 0.55;

/* ---------- state ---------- */
const state = {
  mode: 'menu',            // menu | countdown | play | pause | over
  gameMode: 'classic',
  opponent: 'ai',          // 'ai' | 'aivai' (spectate) | 'pvp' (room lobby)
  difficulty: 'normal',
  matchTime: 60,
  timeLeft: 60,
  suddenDeath: false,
  countdown: 0,
  scores: { player: 0, ai: 0 },
  lives: SURVIVAL_LIVES,
  survivalTime: 0,
  wave: 1,
  heartTimer: 0,   // survival: dedicated heart spawn clock while hurt
  muted: false,
  shake: 0,
  flash: 0,
  rally: 0,
  comboPunch: 0,      // brief HUD scale/flash when the combo increases
  slowTimer: 0,
  spawnTimer: 5,
  invertT: 0,        // >0: player controls are inverted (impossible)
  invertTimer: 12,
  chargeWindow: 0,   // >0: catch-and-charge window is open
  flipped: false,
  flipTimer: 0,
  flipPending: false,
  fieldTime: 0, // field-event animation clock; advances in play/countdown, freezes in menus/pause
  portals: null,           // { a:{x,y}, b:{x,y}, life, spawnT }
  portalTimer: PORTAL_EVERY,
  well: null,              // { x, y, life }
  wellTimer: WELL_EVERY,
  wind: 0,                 // active gust: signed force (+down / -up), 0 = calm
  windLife: 0,
  windSpawnT: 0,           // field animation time when the current gust began
  windTimer: WIND_EVERY,
  zoneTop: 0,
  zoneBottom: H,
  zoneT: 0,
  bumpers: [],
  rainTimer: 0,
};

const cfg = () => DIFFICULTY[state.difficulty];
const mode = () => MODES[state.gameMode];
const topWall = () => state.zoneTop;
const botWall = () => state.zoneBottom;

const keys = {};
let mouseY = null;

// player on the RIGHT
const player = {
  x: W - PADDLE_MARGIN - PADDLE_W,
  y: H / 2 - BASE_PADDLE_H / 2,
  vy: 0, smoothVy: 0,
  h: BASE_PADDLE_H,
  growT: 0, shrinkT: 0,
  smashT: 0, smashCD: 0,
  hitFlash: 0,
  rallyScale: 1,
  // AI-brain fields (used in AI vs AI mode)
  targetY: H / 2, aimOffset: 0,
  noise: 0, noiseT: 0, noiseTarget: 0,
  lapse: 0, watching: null,
};
// LEFT paddle: the AI, or the remote player in PvP
const ai = {
  x: PADDLE_MARGIN,
  y: H / 2 - BASE_PADDLE_H / 2,
  vy: 0, smoothVy: 0,
  h: BASE_PADDLE_H,
  growT: 0, shrinkT: 0,
  smashT: 0, smashCD: 0,
  hitFlash: 0,
  targetY: H / 2,
  aimOffset: 0,
  noise: 0, noiseT: 0, noiseTarget: 0,
  lapse: 0,
  watching: null,
};

// ghost paddles (power-up): AI-driven helpers, one per side, free to overlap the mains.
// Each has a timer - 0 means inactive.
function makeGhost(x) {
  return {
    x, y: H / 2 - BASE_PADDLE_H * GHOST_SCALE / 2,
    vy: 0, smoothVy: 0,
    h: BASE_PADDLE_H * GHOST_SCALE,
    growT: 0, shrinkT: 0,
    smashT: 0, smashCD: 0,
    hitFlash: 0,
    ghost: true, timer: 0,
    targetY: H / 2, aimOffset: 0,
    noise: 0, noiseT: 0, noiseTarget: 0,
    lapse: 0, watching: null,
  };
}
const ghostL = makeGhost(PADDLE_MARGIN + GHOST_OFFSET);
const ghostR = makeGhost(W - PADDLE_MARGIN - PADDLE_W - GHOST_OFFSET);
// ghosts are sloppier than the main AI - helpers, not walls
const ghostBrain = {
  speed: AI_CFG.speed * 0.8,
  lookAhead: AI_CFG.lookAhead * 0.7,
  wobble: AI_CFG.wobble * 1.6,
  lapseChance: 0.35,
  lapseError: 130,
};

// Pristine snapshots for returning to a clean menu without losing selections.
const initialState = { ...state, scores: { ...state.scores } };
const initialPaddles = [player, ai, ghostL, ghostR].map(p => ({ ...p }));

let balls = [];
const particles = [];
const powerups = [];
const popups = [];   // floating score/event text
const ripples = []; // expanding rings (wall taps, goals, portal use)

/* Presentation helpers.

   In PvP the SERVER runs these same functions while simulating and records what
   they produced, shipping the result in its snapshots; clients replay that
   list. So there is nothing to forward from here - a client only ever draws its
   own local effects. */
function ripple(x, y, color, maxR = 60, width = 3) {
  ripples.push({ x, y, color, r: 6, maxR, width, life: 1 });
}

function popup(x, y, str, color, size = 14) {
  popups.push({ x, y, str, color, size, life: 1.1 });
}

// decor: background starfield, generated once and then never moved.
// Each star needs only a position, because they all render as identical flat
// 2px squares (see the starfield loop in render.js).
const stars = [];
for (let i = 0; i < 70; i++) {
  stars.push({
    x: Math.random() * W,
    y: Math.random() * H,
  });
}

/* ============================================================
   Audio

   Sampled one-shots for the main beats; WebAudio tones still cover the
   incidental cues that have no sample. Samples are decoded once and played
   through the same AudioContext so muting and autoplay unlocking behave
   identically for both.
   ============================================================ */
let audioCtx = null;
// `wet` is how much of each sound is sent to the shared reverb: rally sounds
// stay fairly dry so fast exchanges don't smear, while goals and fanfares get
// a longer tail for weight.
const SAMPLES = {
  bounce:  { src: 'audio/bounce.mp3',  vol: 0.22, wet: 0.18 },  // ball meets a wall
  click:   { src: 'audio/click.mp3',   vol: 0.26, wet: 0.12 },  // major UI action
  hithigh: { src: 'audio/hithigh.mp3', vol: 0.26, wet: 0.22 },  // paddle contact, upper half
  hitlow:  { src: 'audio/hitlow.mp3',  vol: 0.26, wet: 0.22 },  // paddle contact, lower half
  scored:  { src: 'audio/scored.mp3',  vol: 0.34, wet: 0.40 },
  start:   { src: 'audio/start.mp3',   vol: 0.34, wet: 0.35 },  // countdown finishes
  win:     { src: 'audio/win.mp3',     vol: 0.38, wet: 0.45 },
  lose:    { src: 'audio/lose.mp3',    vol: 0.34, wet: 0.45 },
  // Power-up pickup. The source file is long and hot, so it is played quietly
  // and cut short: pickups can land back-to-back in Chaos/Royale and a full
  // 3.4s tail would stack into a wall of noise.
  // Plays in full: the sample decays naturally, so no trim or fade is needed.
  modifier: { src: 'audio/modifier.mp3', vol: 0.20, wet: 0.30 },
};
const sampleBuffers = {};
// 'pending' while a sample is still downloading/decoding, 'failed' if it never
// arrives. Only 'failed' falls back to a synthesized tone: a sample that is
// merely pending will arrive shortly, and falling back for it would make the
// first sound of a session a beep instead of the real audio.
const sampleState = {};
// Playback requested before the buffer finished decoding, replayed on arrival.
const pendingPlays = {};
// Long samples that should not overlap themselves (see playSample).
const activeLongSounds = new Map();

/* Reverb bus. Every sound plays dry into the destination and also feeds a
   shared convolver, so the arena has a consistent sense of space. The impulse
   response is generated (decaying filtered noise) rather than shipped as an
   asset - cheap, and it keeps the game dependency-free. */
const REVERB_SECONDS = 1.5;
const REVERB_DECAY = 3.2;      // higher = tighter tail
let reverbBus = null;

function buildImpulseResponse(ctx) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * REVERB_SECONDS);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      // Exponentially decaying noise: dense early reflections, smooth tail.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, REVERB_DECAY);
    }
  }
  return impulse;
}

function ensureReverb(ctx) {
  if (reverbBus) return reverbBus;
  const convolver = ctx.createConvolver();
  convolver.buffer = buildImpulseResponse(ctx);
  // Roll off the highs so the tail sits behind the dry hit instead of hissing.
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 3200;
  const wet = ctx.createGain();
  wet.gain.value = 1;
  convolver.connect(damp).connect(wet).connect(ctx.destination);
  reverbBus = { input: convolver, wet };
  return reverbBus;
}

function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    decodePendingSamples();
  }
  // Browsers start the context suspended until a user gesture. The guest may
  // not have clicked the canvas, so resume on the first sound it needs to play.
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/* Fetch every sample once, at startup. Decoding needs an AudioContext, which
   browsers only allow after a user gesture, so the encoded bytes are fetched
   immediately and decoded as soon as a context exists. Without this the very
   first sound of a session (usually START MATCH) fires before anything has
   decoded and falls back to the synthesized beep. */
let samplesRequested = false;
const encodedSamples = {};

function fetchSamples() {
  if (samplesRequested) return;
  samplesRequested = true;
  for (const [name, { src }] of Object.entries(SAMPLES)) {
    sampleState[name] = 'pending';
    fetch(src)
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(bytes => { encodedSamples[name] = bytes; decodeSample(name); })
      .catch(err => {
        sampleState[name] = 'failed';
        debugLog('game', `AUDIO: could not load ${src}`, { error: err.message });
      });
  }
}

function decodeSample(name) {
  const bytes = encodedSamples[name];
  if (!bytes || sampleBuffers[name]) return;
  // Decoding needs a context, but it does NOT need an unlocked one, so this can
  // run before any user gesture and be ready for the very first sound.
  const ctx = audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());
  delete encodedSamples[name];   // decodeAudioData detaches the buffer
  ctx.decodeAudioData(bytes)
    .then(decoded => {
      sampleBuffers[name] = decoded;
      sampleState[name] = 'ready';
      // Play a request that arrived while this was still decoding, unless it
      // waited so long the moment has passed.
      const queued = pendingPlays[name];
      delete pendingPlays[name];
      if (!queued || performance.now() - queued.at > 400) return;
      if (ctx.state === 'running') startSample(ctx, name, queued);
      else ctx.resume().then(() => startSample(ctx, name, queued)).catch(() => {});
    })
    .catch(err => {
      sampleState[name] = 'failed';
      debugLog('game', `AUDIO: could not decode ${name}`, { error: err.message });
    });
}

// Decode anything already downloaded as soon as a context is available.
function decodePendingSamples() {
  for (const name of Object.keys(encodedSamples)) decodeSample(name);
}

fetchSamples();

// Playback rate with a random spread, optionally biased upward. Used to keep
// repeated one-shots from sounding mechanically identical.
const randRate = (spread, bias = 0) => 1 + bias + (Math.random() * 2 - 1) * spread;

// Returns false when the sample is unavailable, so callers can fall back to a
// synthesized tone instead of playing nothing at all.
/* Public entry point. Returns false ONLY when the sample can never play, so a
   caller's synthesized fallback is used for genuine failures and never for a
   sound that is merely still loading or waiting on the audio hardware. */
function playSample(name, opts = {}) {
  if (state.muted) return true;   // muted is "handled", not a failure
  if (sampleState[name] === 'failed') return false;

  const ctx = ensureAudioCtx();
  decodeSample(name);

  if (!sampleBuffers[name]) {
    // Still downloading/decoding: play it the moment it is ready.
    pendingPlays[name] = { ...opts, at: performance.now() };
    return true;
  }

  if (ctx.state === 'running') {
    startSample(ctx, name, opts);
  } else {
    // First sound of the session: the context is suspended and resume() is
    // async, so a source started now is silent. Play once the resume lands.
    ctx.resume().then(() => startSample(ctx, name, opts))
      .catch(err => debugLog('game', `AUDIO: resume failed for ${name}`, { error: err.message }));
  }
  return true;
}

// Builds the graph and starts the sound. Assumes the context is running and
// the buffer is decoded; callers above guarantee both.
function startSample(ctx, name, { rate = 1, gain = 1 } = {}) {
  const buffer = sampleBuffers[name];
  if (!buffer) return;
  const cfgSample = SAMPLES[name] || {};
  const source = ctx.createBufferSource();
  const amp = ctx.createGain();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const level = (cfgSample.vol ?? 0.6) * gain;
  amp.gain.value = level;
  source.connect(amp).connect(ctx.destination);

  const wetAmount = cfgSample.wet ?? 0;
  if (wetAmount > 0) {
    const send = ctx.createGain();
    send.gain.value = level * wetAmount;
    amp.connect(send).connect(ensureReverb(ctx).input);
  }

  const now = ctx.currentTime;
  source.start(now);

  // Optionally shorten an over-long sample. Loudness is perceived roughly
  // logarithmically, so a linear ramp sounds like it drops out abruptly near
  // the end - an exponential decay reads as a natural tail instead.
  if (cfgSample.maxDur) {
    const fade = cfgSample.fade ?? 0.2;
    const stopAt = now + cfgSample.maxDur;
    const fadeFrom = Math.max(now, stopAt - fade);
    amp.gain.setValueAtTime(level, fadeFrom);
    amp.gain.exponentialRampToValueAtTime(level * 0.0001, stopAt);
    // Stop a touch late so the ramp completes before the source is cut.
    source.stop(stopAt + 0.02);
  }

  // Long one-shots retrigger constantly during power-up rushes; keep only the
  // newest so they replace rather than pile up.
  if (cfgSample.maxDur || buffer.duration > 1.5) {
    activeLongSounds.get(name)?.();
    activeLongSounds.set(name, () => {
      try { source.stop(); } catch { /* already stopped */ }
    });
    source.onended = () => {
      if (activeLongSounds.get(name)) activeLongSounds.delete(name);
    };
  }

  return true;
}

// Global trim on the synthesized cues so they sit at the same level as the
// samples instead of poking out above them.
const BEEP_TRIM = 0.45;
function beep(freq, dur = 0.06, type = 'square', vol = 0.12) {
  if (state.muted) return;
  vol *= BEEP_TRIM;
  ensureAudioCtx();
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(audioCtx.destination);
  // Light send so synthesized cues share the same room as the samples.
  const send = audioCtx.createGain();
  send.gain.setValueAtTime(vol * 0.22, t);
  send.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  gain.connect(send).connect(ensureReverb(audioCtx).input);
  osc.start(t);
  osc.stop(t + dur);
}
const sfx = {
  // Paddle contact: the sample is chosen by where the ball struck the arena, so
  // high and low returns sound different. If samples are unavailable, this
  // falls back to a synthesized tone that rises with the rally.
  paddle: (relY = null) => {
    const high = relY === null
      ? Math.random() < 0.5
      : relY < (topWall() + botWall()) / 2;
    // Small random detune plus a gentle rise over the rally: repeated hits stay
    // distinct instead of sounding like one looping sample.
    const rally = Math.min(state.rally, 20) / 20;
    if (playSample(high ? 'hithigh' : 'hitlow', { rate: randRate(0.06, rally * 0.10) })) return;
    beep(430 + Math.min(state.rally, 20) * 14 + Math.random() * 40, 0.05);
  },
  wall:   () => { if (!playSample('bounce', { rate: randRate(0.07) })) beep(260, 0.05); },
  // Major action: starting a match, returning to the menu, menu confirmations.
  click:  () => { if (!playSample('click')) beep(660, 0.05, 'square', 0.1); },
  // Ball collects a power-up / modifier.
  power:  () => {
    if (playSample('modifier', { rate: randRate(0.04) })) return;
    beep(660, 0.06); setTimeout(() => beep(990, 0.09), 60);
  },
  life:   () => { beep(311, 0.1, 'sawtooth', 0.1); setTimeout(() => beep(233, 0.18, 'sawtooth', 0.1), 100); },
  // proper goal horns - loud enough to land over the shake and particles.
  // In high-scoring chaos (royale etc.) rapid goals fall back to a short
  // single blip so the fanfare doesn't loop into an air-raid siren.
  _lastGoalAt: 0,
  _goalSound(isFor) {
    const now = performance.now();
    const rapid = now - sfx._lastGoalAt < 2500;
    sfx._lastGoalAt = now;
    // One goal sample for both sides; conceding is pitched down so the two are
    // still tellable apart at a glance. Rapid goals stay quiet and short.
    // Keep the scored/conceded pitch gap, but vary each one slightly.
    const goalRate = (isFor ? 1 : 0.82) * randRate(0.03);
    if (playSample('scored', { rate: goalRate, gain: rapid ? 0.55 : 1 })) return;
    if (rapid) {
      // compact version: one note, still directional (high = for, low = against)
      beep(isFor ? 784 : 220, 0.07, isFor ? 'triangle' : 'sine', 0.07);
      return;
    }
    // gentle two-note motifs - softer waveforms, modest volume
    if (isFor) {
      beep(523, 0.08, 'triangle', 0.09);
      setTimeout(() => beep(784, 0.14, 'triangle', 0.09), 90);
    } else {
      beep(294, 0.1, 'triangle', 0.08);
      setTimeout(() => beep(196, 0.16, 'triangle', 0.08), 110);
    }
  },
  scoreFor:     () => sfx._goalSound(true),
  scoreAgainst: () => sfx._goalSound(false),
  count:  () => beep(392, 0.07),
  // Countdown reaching zero, meaning the round actually starts.
  go:     () => { if (!playSample('start')) beep(784, 0.15); },
  win:    () => {
    if (playSample('win')) return;
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.14, 'square', 0.1), i * 130));
  },
  lose:   () => {
    if (playSample('lose')) return;
    [392, 330, 262, 196].forEach((f, i) => setTimeout(() => beep(f, 0.16, 'sawtooth', 0.08), i * 150));
  },
};

/* ============================================================
   Helpers
   ============================================================ */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function spawnParticles(x, y, color, n = 14, power = 260) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = (0.3 + Math.random() * 0.7) * power;
    particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: 0.35 + Math.random() * 0.3,
      maxLife: 0.65,
      color,
      size: 1.5 + Math.random() * 2.5,
    });
  }
}

/* Directional burst: particles fly along `angle` within a cone rather than
   radiating evenly. Smash launches and paddle impact sparks both need this.

   It exists as a named helper, rather than pushing into `particles` inline,
   because that array is client-only presentation. In PvP the server runs this
   same code and records the effects it produces, so anything written straight
   into `particles` is invisible to the other player - which is exactly why the
   smash trail never appeared online. */
function spawnBurst(x, y, color, {
  n = 12, angle = 0, spread = 0.65, power = 260, powerVar = 180,
  life = 0.18, lifeVar = 0.14, maxLife = 0.32, size = 1.5, sizeVar = 2,
  altColor = null, altEvery = 3,
} = {}) {
  for (let i = 0; i < n; i++) {
    const a = angle + (Math.random() - 0.5) * spread;
    const s = power + Math.random() * powerVar;
    particles.push({
      x, y,
      vx: Math.cos(a) * s,
      vy: Math.sin(a) * s,
      life: life + Math.random() * lifeVar,
      maxLife,
      color: (altColor && i % altEvery === 0) ? altColor : color,
      size: size + Math.random() * sizeVar,
    });
  }
}

function baseBallSpeed() {
  let s = cfg().ballSpeed;
  // Survival escalates over time; Endless is simply an untimed standard match.
  if (state.gameMode === 'survival') s += Math.min(state.survivalTime * 8, 450);
  return s;
}

const isAivai = () => state.opponent === 'aivai';
// Console labels must describe the actual competitor, not the internal score key.
const debugParticipant = (who) => isAivai()
  ? (who === 'ai' ? 'LEFT AI' : 'RIGHT AI')
  : (who === 'ai' ? 'AI' : 'PLAYER');
// In AI-vs-AI both sides are bots, so the left one is named by its color;
// that name follows the palette rather than a baked-in 'PINK'.
const foeName = () => isAivai() ? theme.left.name : (state.opponent === 'pvp' ? 'PLAYER' : 'AI');

// per-match bot personalities (AI vs AI) - jittered so the fight isn't a mirror
const aiBrains = { left: { ...AI_CFG }, right: { ...AI_CFG } };
function rollPersonalities() {
  for (const side of ['left', 'right']) {
    aiBrains[side] = {
      speed: AI_CFG.speed * (0.85 + Math.random() * 0.35),
      lookAhead: AI_CFG.lookAhead * (0.8 + Math.random() * 0.5),
      wobble: AI_CFG.wobble * (0.7 + Math.random() * 0.7),
      lapseChance: clamp(AI_CFG.lapseChance * (0.6 + Math.random() * 0.9), 0.05, 0.5),
      lapseError: AI_CFG.lapseError * (0.7 + Math.random() * 0.7),
    };
  }
}

function makeBall(x, y, direction, speed = baseBallSpeed()) {
  const angle = (Math.random() * 0.5 - 0.25) * Math.PI; // -45..45 deg
  const type = rollBallType();
  if (type === 'heavy') speed *= 0.72;
  if (type === 'comet') speed *= 1.25;
  return {
    x, y,
    vx: Math.cos(angle) * speed * direction,
    vy: Math.sin(angle) * speed,
    speed,
    type,
    r: type === 'heavy' ? BALL_R * 1.6 : type === 'comet' ? BALL_R * 0.65 : type === 'gold' ? BALL_R * 1.2 : BALL_R,
    split: false,           // splitter: has it split yet?
    phase: Math.random() * PHANTOM_CYCLE,
    portalCD: 0,
    heldBy: null, holdT: 0, holdPlan: 0, catchCD: 0, chargeBeepT: 0,
    lastHit: null,          // 'player' | 'ai'
  };
}

const isFireball = (b) => b.speed >= cfg().maxSpeed * FIRE_FRAC;
const ballValue = (b) =>
  b.type === 'gold' ? 3 :
  b.type === 'phantom' || b.type === 'comet' ? 2 :
  isFireball(b) ? 2 : 1;
// phantom balls fade in/out on a cycle (never fully at the paddle plane - min 6%)
function phantomAlpha(b) {
  if (b.type !== 'phantom') return 1;
  const t = ((performance.now() / 1000 + b.phase) % PHANTOM_CYCLE) / PHANTOM_CYCLE;
  return 0.06 + 0.94 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2));
}

function paddleHeight(p) {
  if (p.ghost) return BASE_PADDLE_H * GHOST_SCALE;
  let h = BASE_PADDLE_H;
  /* Difficulty handicaps shrink the HUMAN's paddle, so against the AI only the
     right-hand paddle is scaled. When both paddles are driven by people - PvP,
     or AI-vs-AI - the handicap has to apply to both or the match is not a fair
     fight: on hard the host would play with a 63px paddle against the guest's
     90px, and on impossible 36px against 90px.

     rallyScale (paddle wear over a long rally) is tracked per-paddle and only
     ever set on `player`, so it stays keyed to that side. */
  const bothSidesHandicapped = isAivai() || isPvp();
  if (p === player || bothSidesHandicapped) {
    h *= cfg().paddleScale * (p === player ? p.rallyScale : 1);
  }
  if (p.growT > 0) h *= 1.55;
  if (p.shrinkT > 0) h *= 0.6;
  return h;
}

/* ============================================================
   Match flow
   ============================================================ */
function startMatch() {
  if (isAivai()) rollPersonalities();
  debugLog('game', 'MATCH START', {
    mode: state.gameMode, difficulty: state.difficulty, opponent: state.opponent,
    matchTime: MODES[state.gameMode].timed ? state.matchTime : 'untimed',
  });
  state.scores.player = 0;
  state.scores.ai = 0;
  state.timeLeft = state.matchTime;
  state.suddenDeath = false;
  state.lives = SURVIVAL_LIVES;
  state.survivalTime = 0;
  state.wave = 1;
  state.heartTimer = 4;
  state.rally = 0;
  state.comboPunch = 0;
  state.slowTimer = 0;
  state.spawnTimer = mode().spawnMin + Math.random() * mode().spawnVar;
  player.y = H / 2 - BASE_PADDLE_H / 2;
  ai.y = H / 2 - BASE_PADDLE_H / 2;
  player.growT = player.shrinkT = ai.growT = ai.shrinkT = 0;
  player.smashT = player.smashCD = ai.smashT = ai.smashCD = 0;
  player.catchT = ai.catchT = 0;
  player.rallyScale = 1;
  ghostL.timer = ghostR.timer = 0;
  ghostL.y = H / 2 - ghostL.h / 2;
  ghostR.y = H / 2 - ghostR.h / 2;
  ghostL.vy = ghostR.vy = 0;
  ghostL.watching = ghostR.watching = null;
  powerups.length = 0;
  popups.length = 0;
  ripples.length = 0;
  state.chargeWindow = 0;
  state.flipped = state.flipPending = false;
  state.flipTimer = 0;
  state.fieldTime = 0;
  state.portals = null;
  state.portalTimer = PORTAL_EVERY * (0.5 + Math.random() * 0.5);
  state.well = null;
  state.wellTimer = WELL_EVERY * (0.5 + Math.random() * 0.6);
  state.wind = 0; state.windLife = 0; state.windSpawnT = 0;
  state.windTimer = WIND_EVERY * (0.5 + Math.random() * 0.6);
  serve(Math.random() < 0.5 ? 1 : -1);
}

function placeBumpers() {
  state.bumpers.length = 0;
  const n = mode().bumpers || 0;
  for (let i = 0; i < n; i++) {
    state.bumpers.push({
      x: W * (0.28 + 0.44 * Math.random()),
      y: H * (0.25 + 0.5 * Math.random()),
      r: 18 + Math.random() * 14,
      vx: mode().movingBumpers ? (Math.random() < 0.5 ? -1 : 1) * (30 + Math.random() * 50) : 0,
      vy: mode().movingBumpers ? (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 60) : 0,
      pulse: 0,
    });
  }
}

function serve(direction) {
  state.portals = null;
  player.catchT = ai.catchT = 0;
  player.catchThreat = ai.catchThreat = null;
  player.catchAttempted = ai.catchAttempted = false;
  /* The barrier does NOT fully reset on a goal.

     Rallies average a few seconds while the corridor takes considerably longer
     to close, so wiping its progress every point meant players effectively
     never saw it shut - the modifier looked slow and toothless because its
     interesting state was unreachable. Winding the clock back partway gives the
     arena breathing room after a goal while letting pressure build over the
     course of a match.

     ROYALE resets nothing: its whole identity is a relentlessly closing arena.
     replenishBalls() deliberately leaves the zone untouched mid-fight. */
  state.zoneT = mode().zone ? state.zoneT : state.zoneT * ZONE_GOAL_RELIEF;
  if (!zoneActive()) {
    state.zoneTop = 0;
    state.zoneBottom = H;
    state.zoneT = 0;
  }
  state.rainTimer = mode().rain || 0;
  state.invertT = 0;
  state.invertTimer = (cfg().inverted || 12) * (0.7 + Math.random() * 0.6);
  // survival wave bumpers persist between goals; other modes re-place theirs
  if (!mode().waves) placeBumpers();
  balls = [makeBall(W / 2, H / 2, direction)];
  // wave 2+ survival serves keep the multi-ball pressure up after a goal
  const serveBalls = mode().waves
    ? Math.min(mode().balls + state.wave - 1, mode().maxBalls)
    : mode().balls;
  for (let i = 1; i < serveBalls; i++) {
    balls.push(makeBall(W / 2, H * (0.3 + 0.4 * Math.random()), -direction));
  }
  state.rally = 0;
  state.comboPunch = 0;
  player.rallyScale = 1;
  pickAiAim();
  // every mode gets the 3-2-1; ROYALE's non-stop feel comes from
  // replenishBalls() keeping play alive BETWEEN goals, not from skipping this
  state.countdown = 3;
  state.mode = 'countdown';
  sfx.count();
}

// ROYALE: balls depleted mid-fight - respawn at center and keep rolling.
// Zone, bumpers, portals and arena state all stay exactly where they were.
function replenishBalls(direction) {
  const midY = (topWall() + botWall()) / 2;
  balls.push(makeBall(W / 2, midY, direction));
  for (let i = 1; i < mode().balls; i++) {
    balls.push(makeBall(W / 2, clamp(H * (0.3 + 0.4 * Math.random()), topWall() + BALL_R * 2, botWall() - BALL_R * 2), -direction));
  }
  beep(660, 0.07, 'triangle', 0.12);
  spawnParticles(W / 2, midY, '#ffffff', 20, 300);
}

// score number animation: 1 = just scored, eases to 0
const scorePop = { player: 0, ai: 0 };
let timerPop = 0; // final-countdown tick: timer scales up fast, snaps back

function score(who, y, pts = 1) {
  debugLog('game', `${debugParticipant(who)} SCORES +${pts}`, {
    before: isAivai()
      ? { 'LEFT AI': state.scores.ai, 'RIGHT AI': state.scores.player }
      : { AI: state.scores.ai, PLAYER: state.scores.player },
    rally: state.rally, ballY: Math.round(y),
  });
  scorePop[who] = 1;
  state.shake = 10;
  state.rally = 0;
  state.comboPunch = 0;
  player.rallyScale = 1;
  spawnParticles(who === 'player' ? 20 : W - 20, y, who === 'player' ? theme.right.base : theme.left.base, 26, 380);
  if (pts > 1) {
    popup(who === 'player' ? 70 : W - 70, y, `+${pts}!`, '#d9a441', 22);
    state.shake = 14;
  }

  if (state.gameMode === 'survival') {
    if (who === 'player') {
      state.scores.player += pts;
      state.flash = 0.18;
      sfx.scoreFor();
      // scoring on the AI wins a life back
      if (state.lives < SURVIVAL_LIVES) {
        state.lives++;
        popup(W / 2, y, '+1 LIFE!', '#d2647f', 16);
        sfx.life();
      }
    } else {
      state.lives--;
      state.flash = 0.15;
      sfx.life();
      if (state.lives <= 0) { endMatch(); return true; }
    }
    return false;
  }

  state.scores[who] += pts;
  state.flash = who === 'player' ? 0.18 : 0.12;
  if (who === 'player') sfx.scoreFor(); else sfx.scoreAgainst();

  if (state.suddenDeath) { endMatch(); return true; }
  return false;
}

function endMatch({ fromNetwork = false } = {}) {
  // Local simulation can reach multiple end conditions on the same frame. Do
  // not replay the result fanfare (especially the lose sample) after the game
  // is already over. A guest receives `over` in its authoritative snapshot,
  // so it explicitly opts into the one required presentation pass.
  if (state.mode === 'over' && !fromNetwork) return;
  state.mode = 'over';
  const p = state.scores.player, a = state.scores.ai;
  debugLog('game', 'MATCH OVER', {
    scores: isAivai() ? { 'LEFT AI': a, 'RIGHT AI': p } : { PLAYER: p, AI: a },
    mode: state.gameMode,
  });
  const title = document.getElementById('result-title');
  const scoreEl = document.getElementById('result-score');

  if (state.gameMode === 'survival') {
    const t = Math.floor(state.survivalTime);
    const m = Math.floor(t / 60), s = String(t % 60).padStart(2, '0');
    title.textContent = 'GAME OVER';
    title.style.color = '#e0a33e';
    scoreEl.textContent = `SURVIVED ${m}:${s}  -  ${p} POINT${p === 1 ? '' : 'S'}`;
    sfx.lose();
    show('gameover');
    return;
  }

  if (isAivai()) {
    const winnerIsRight = p > a;
    const winner = winnerIsRight ? theme.right : theme.left;
    title.textContent = `${winner.name} WINS!`;
    title.style.color = winner.base;
    sfx.win();
    scoreEl.textContent = `${a} - ${p}` + (state.suddenDeath ? '  (SUDDEN DEATH)' : '');
    show('gameover');
    return;
  }

  if (p > a) {
    title.textContent = 'YOU WIN!';
    title.style.color = theme.right.base;
    sfx.win();
  } else {
    title.textContent = state.opponent === 'pvp' ? 'PLAYER WINS' : 'AI WINS';
    title.style.color = theme.left.base;
    sfx.lose();
  }
  scoreEl.textContent = `${p} - ${a}` + (state.suddenDeath ? '  (SUDDEN DEATH)' : '');
  show('gameover');
}

