'use strict';

/* ============================================================
   Server-authoritative netcode

   The SERVER simulates the match and is the single source of truth. Neither
   player simulates it, so neither gains an advantage from being the host: both
   sides send input, both sides receive the same snapshots under the same
   latency.

   Each client:
     - predicts its own paddle locally, so aiming feels instant;
     - replays unacknowledged input onto the server's position to reconcile;
     - dead-reckons balls from the server's velocities between packets;
     - extrapolates the opponent's paddle through the gaps between snapshots.

   Sides. In the server's simulation the RIGHT paddle (`player`) belongs to the
   room host and the LEFT paddle (`ai`) to the guest. Each client renders itself
   on the right, so the guest mirrors its whole view horizontally and the host
   does not. The vertical axis is never mirrored, so paddle Y maps straight
   across.

   Host vs guest is now purely a LOBBY distinction: the host owns match settings
   and starts the game. It has no simulation privileges of any kind.

   Sound is NOT sent over the wire. The server records the effects it produces
   while simulating and ships them with the snapshot; each client plays them
   locally.
   ============================================================ */

const INPUT_HZ = 60;
const INTERP_RATE = 18;   // exponential convergence toward the newest snapshot
const RECONCILE_RATE = 6; // how firmly dead-reckoned balls are pulled to truth

/* Own-paddle reconciliation.

   The naive approach — easing the paddle toward the position in the newest
   snapshot — is wrong, and it is what made paddles jitter. That position
   describes where the paddle was roughly one round trip ago, so while the
   player is moving it is permanently behind. Easing toward it drags the paddle
   backwards every frame while prediction pushes it forwards, and the two fight.

   The correct approach is standard client-side prediction with server
   reconciliation: keep every input that has not yet been acknowledged, and when
   a snapshot arrives, take the server's position and REPLAY those pending
   inputs on top of it. The result accounts for the server's authority *and*
   everything the player has done since, so there is nothing to fight over. Any
   residual difference is genuine disagreement and is eased away gently. */
// Ease rate for leftover error after replay. Small, because replay should
// already have removed nearly all of it.
const OWN_PADDLE_RECONCILE = 6;
// Beyond this the prediction is genuinely wrong (server refused a move, a flip
// swapped sides, the paddle was resized) and a hard snap is correct.
const OWN_PADDLE_SNAP = 90;
// Deadzone. Rounding in the snapshot means tiny errors are noise, not truth;
// chasing them would reintroduce the jitter this replaces.
const OWN_PADDLE_DEADZONE = 1.5;
// Safety cap on the replay buffer, in case acks stop arriving entirely.
const MAX_PENDING_INPUTS = 120;
/* Must equal MAX_PADDLE_SPEED in server/sim/match.js. Replay reproduces the
   server's movement rule, so a mismatch would make the two disagree on every
   frame and the paddle would feel spongy. test/jitter.test.js asserts they
   remain in step. */
const NET_MAX_PADDLE_SPEED = 1800;

const net = {
  active: false,
  role: null,           // 'host' | 'guest' — lobby role only
  mirror: false,        // guest mirrors its view so it sees itself on the right
  seq: 0,               // outgoing input sequence number
  pending: [],          // inputs sent but not yet acknowledged (for replay)
  inputT: 0,
  action: false,        // local click latch
  targets: null,        // opponent position/velocity used for extrapolation
  ownY: null,           // authoritative own position, brought up to date
  ended: false,         // game-over overlay already shown
  audio: {},            // previous snapshot values used to trigger sound
  ping: null,           // smoothed round-trip time in ms, null until measured
  pingSamples: [],      // recent raw RTT samples, for a stable median
  settling: false,      // true while a screen transition is rebuilding state
};

/* Ping is derived from data already on the wire. Every input carries a sequence
   number and every snapshot echoes the highest one the server has consumed, so
   the round trip is simply now - (time that input was sent).

   No extra packets, no separate heartbeat: the measurement costs nothing.

   Every raw sample is inflated by a variable amount of purely local delay: the
   server only acknowledges up to its last consumed tick and holds that ack
   until its next snapshot, and more packets sit in flight as latency rises. So
   the overhead grows with latency and cannot be removed with a fixed constant.

   Taking the MINIMUM over a short window sidesteps that. The fastest round trip
   in the window is the one that happened to queue least, which is the closest
   estimate of true network latency available — the same reason ping utilities
   report a minimum alongside the average. */
/* Samples considered when picking the minimum. A couple of seconds' worth: long
   enough to contain a low-overhead sample, short enough to follow real changes
   in connection quality. */
const PING_WINDOW = 24;

function netRecordPing(sentAt) {
  const rtt = performance.now() - sentAt;
  if (!(rtt >= 0) || rtt > 5000) return;   // ignore nonsense (clock jumps, stalls)
  net.pingSamples.push(rtt);
  if (net.pingSamples.length > PING_WINDOW) net.pingSamples.shift();
  /* No constant is subtracted here. An ack is sometimes held until the next
     snapshot and sometimes ships immediately, so the overhead is variable, not
     fixed — measured against the real server the best sample on localhost is
     ~1ms, meaning the hold frequently does not apply at all. Taking the minimum
     already selects those samples; subtracting an interval on top would
     under-report every real connection by up to 33ms. */
  const best = Math.min(...net.pingSamples);
  // Ease toward the new figure so the display does not flicker between values.
  net.ping = net.ping === null ? best : net.ping + (best - net.ping) * 0.25;
}

const isPvp = () => state.opponent === 'pvp' && net.active;

/* Nobody simulates locally in PvP any more, so isNetHost() is permanently
   false. It is kept because core.js, gameplay.js and update.js branch on it to
   mean "I am running the simulation myself", which is still a meaningful
   question in single-player and AI-vs-AI. */
const isNetHost = () => false;
// "I render an authoritative feed", which is true for BOTH players in a PvP match.
const isNetGuest = () => isPvp();

// True when this client mirrors the arena horizontally (the guest).
const netMirrored = () => net.mirror;

/* Server-recorded effects carry a side tag ('@side:left' / '@side:right')
   instead of a literal color, because side colors are a local preference and
   each player must keep their own.

   The tag names the side in the SERVER's frame, where the host is always
   `right`. A mirrored client (the guest) sees itself on the right, so the tag
   is flipped before it is resolved. Otherwise a guest would paint its own
   goal sparks in its opponent's color.

   Anything that is not a tag (pickup and ball colors, which are identity, not
   ownership) passes through untouched. */
function netEventColor(color, mirror) {
  if (typeof color !== 'string' || !color.startsWith('@side:')) return color;
  let side = color.slice(6) === 'right' ? 'right' : 'left';
  if (mirror) side = side === 'right' ? 'left' : 'right';
  return theme[side].base;
}

/* Snapshots that arrive while the client is still setting up are dropped.

   Starting a PvP match runs transitionTo('match'), a ~650ms fade whose middle
   step calls resetToMenu() — which nulls mouseY and rebuilds both paddles from
   their initial state. The server, meanwhile, begins simulating the instant it
   sends match-start.

   Without this gate the first snapshots land during that window and set
   state.mode to 'countdown'/'play', so the update loop starts predicting from a
   paddle that resetToMenu is about to wipe. The result was a host paddle that
   jittered and ignored the mouse until it was moved again — most visible on a
   quick requeue, where the fade runs while a match is already live. */
function netSuspend() {
  net.settling = true;
}

function netResume() {
  net.settling = false;
  // Adopt the authoritative paddle position immediately rather than easing from
  // wherever the reset left it.
  net.ownY = null;
  /* resetToMenu() can clear mouseY, and netPredictLocalPaddle only follows the
     cursor when it holds a value. Without a mousemove the paddle would sit
     still even though the player's pointer has not moved — they would have to
     jiggle the mouse to "wake it up". Fall back to the in-arena cursor if one
     is known, so tracking is live the moment play resumes. */
  if (mouseY === null && mouseCY >= 0) mouseY = mouseCY;
}

function netStart(role) {
  net.active = true;
  net.role = role;
  // The host owns the RIGHT paddle and needs no mirroring; the guest owns the
  // LEFT paddle and mirrors so it also sees itself on the right.
  net.mirror = role === 'guest';
  /* Sequence numbers are deliberately NOT reset. The server rejects any input
     whose sequence is not greater than the last it accepted, and a requeue is
     racy: inputs sent moments before the rematch are still in flight and land
     in the new match's buffer carrying old, high numbers. Restarting the count
     at zero would make every subsequent input look stale, so the server would
     ignore the player's aim entirely — the paddle stops tracking and only jerks
     when a discrete action arrives.

     Keeping the counter monotonic for the lifetime of the page sidesteps the
     race completely: a new match's inputs always outrank anything left over. */
  net.pending = [];
  net.ping = null;
  net.pingSamples = [];
  net.inputT = 0;
  net.action = false;
  net.targets = null;
  net.ownY = null;
  net.ended = false;
  net.audio = {};
  // The caller runs a screen transition after this, which rebuilds paddle and
  // input state. Ignore the server until that has finished.
  net.settling = true;
  // Start from a sane local paddle so movement works before snapshot #1.
  player.h = BASE_PADDLE_H;
  player.y = H / 2 - player.h / 2;
  player.vy = player.smoothVy = 0;
  debugLog('game', `NET: match started as ${role.toUpperCase()}`);
}

function netStop() {
  if (net.active) debugLog('game', 'NET: session ended');
  net.active = false;
  net.role = null;
  net.targets = null;
  net.ownY = null;
  net.mirror = false;
  net.pending = [];
  net.ping = null;
  net.pingSamples = [];
}

/* ---------- settings sync (host -> guest, lobby only) ---------- */
function netSettings() {
  return {
    gameMode: state.gameMode,
    difficulty: state.difficulty,
    matchTime: state.matchTime,
    custom: JSON.parse(JSON.stringify(customSettings)),
  };
}

function netApplySettings(settings) {
  state.gameMode = settings.gameMode;
  state.difficulty = settings.difficulty;
  state.matchTime = settings.matchTime;
  state.timeLeft = settings.matchTime;
  Object.assign(customSettings, settings.custom);
  Object.assign(customSettings.balls, settings.custom.balls);
  Object.assign(customSettings.powerups, settings.custom.powerups);
  buildCustomCfg();

  // Reflect the host's choices in the guest's menu so the locked panel shows
  // the settings actually being played.
  const select = (groupId, value) => document.getElementById(groupId)
    ?.querySelectorAll('.opt').forEach(b => b.classList.toggle('selected', b.dataset.value === String(value)));
  select('mode-options', settings.gameMode);
  select('difficulty-options', settings.difficulty);
  select('time-options', settings.matchTime);
  // refreshMenu also updates the mode blurb and match-time visibility, which a
  // settings-only sync would otherwise leave showing the guest's old choices.
  if (typeof refreshMenu === 'function') refreshMenu();
  else if (typeof syncCustomControls === 'function') syncCustomControls();
  debugLog('game', 'NET: applied host settings', settings);
}

/* ---------- outgoing input ---------- */
/* Send the local player's input.

   A queued click is always sent immediately — a smash window is far shorter
   than a frame, so it must never wait. Aim updates are rate limited instead.

   That distinction matters. mousemove fires at the mouse's poll rate, which on
   a gaming mouse is 500-1000Hz, i.e. up to ~16 events per rendered frame. If
   each one queued a pending input, the replay buffer would fill with entries
   the server will never process as separate ticks, and replaying them would
   fabricate thousands of pixels of movement in a 560px arena. */
function netSendInput(dt) {
  net.inputT -= dt;
  // A pending click always goes out at once. Aim updates wait for their slot,
  // no matter how often the mouse reports, so the pending buffer stays in step
  // with the server's tick rate.
  if (net.inputT > 0 && !net.action) return;
  net.inputT = 1 / INPUT_HZ;

  // Report the predicted paddle center in SERVER coordinates. Only the
  // horizontal axis is mirrored, so the vertical value maps across directly.
  const aimY = player.y + player.h / 2;
  const seq = ++net.seq;
  roomSend({ t: 'i', seq, y: aimY, action: net.action });
  // Remember it until the server confirms it, so the authoritative position can
  // be brought back up to date by replaying whatever is still in flight.
  net.pending.push({ seq, y: aimY, at: performance.now() });
  if (net.pending.length > MAX_PENDING_INPUTS) {
    net.pending.splice(0, net.pending.length - MAX_PENDING_INPUTS);
  }
  net.action = false;
}

/* Each client owns its own audio. The server records every cue it produces
   while simulating and ships them in the snapshot, so playback is driven by
   those events rather than by streaming tones.

   Scoring is the exception: "scored for" vs "conceded" is relative to the
   listener, and the server has no notion of which client is which, so that cue
   is derived from the score change here. */
function netLocalAudio(s, own, foe) {
  const prev = net.audio;
  const scored = prev.scores && (own.score !== prev.scores[0] || foe.score !== prev.scores[1]);
  if (scored) (own.score > prev.scores[0] ? sfx.scoreFor : sfx.scoreAgainst)();
  net.audio = { rally: s.ra, scores: [own.score, foe.score], lives: s.lv, powerups: s.pu.length };
}

// Which acknowledgement field belongs to this client.
function netOwnAck(s) {
  const ack = net.role === 'host' ? s.ah : s.ag;
  return typeof ack === 'number' ? ack : 0;
}

/* Bring the server's (necessarily stale) paddle position up to the present by
   replaying every input it had not yet seen.

   This mirrors AuthoritativeMatch.movePaddle: same speed cap, same clamping.
   If the two ever drift apart the paddle will feel spongy, so they are kept
   deliberately identical and covered by test/jitter.test.js. */
function netReconcileOwnPaddle(serverY, ackSeq) {
  // Drop inputs the server has already accounted for, timing the newest one to
  // measure the round trip.
  let acked = null;
  while (net.pending.length && net.pending[0].seq <= ackSeq) acked = net.pending.shift();
  if (acked) netRecordPing(acked.at);

  /* Replay what is still in flight. Each pending input corresponds to one
     server tick, because netSendInput is rate limited to the server's tick
     rate. The buffer is additionally bounded here: however many entries are
     queued, replay may never move the paddle further than the speed limit
     allows over the time those inputs actually span. Without that bound a burst
     of queued inputs — from a stall, a backgrounded tab, or a mouse reporting
     faster than expected — would fabricate movement and yank the paddle. */
  const step = NET_MAX_PADDLE_SPEED * (1 / 60);
  let y = serverY;
  let saturated = false;
  for (const input of net.pending) {
    const target = clamp(input.y - player.h / 2, topWall(), botWall() - player.h);
    const delta = target - y;
    if (Math.abs(delta) <= step) y = target;
    else { y += Math.sign(delta) * step; saturated = true; }
    y = clamp(y, topWall(), botWall() - player.h);
  }

  /* If replay ran out of speed before reaching the requested aim, the result
     depends on exactly how many inputs happened to be in flight — and that
     count alternates every frame as acks arrive. Reporting it would make the
     reference oscillate (measured: a 37px swing at 8Hz, large enough to trip
     the snap threshold and yank the paddle).

     A saturated replay means the server is simply behind and has not yet caught
     up with where the player is pointing. The prediction is the better estimate
     in that case, so no correction is claimed. */
  if (saturated) return null;
  return clamp(y, topWall(), botWall() - player.h);
}

function netApplySnapshot(s) {
  /* Resolve which side of the snapshot is "me".

     The server always simulates the host as `player` (right) and the guest as
     `ai` (left). A client renders itself on the right, so the guest swaps the
     two slots and mirrors X; the host takes them as-is. */
  const mirror = netMirrored();
  const mx = mirror ? (x) => W - x : (x) => x;
  const swapHeld = mirror
    ? (held) => held === 'player' ? 'ai' : held === 'ai' ? 'player' : null
    : (held) => held || null;

  const own = mirror
    ? { pad: s.a, score: s.sc[1] }
    : { pad: s.p, score: s.sc[0] };
  const foe = mirror
    ? { pad: s.p, score: s.sc[0] }
    : { pad: s.a, score: s.sc[1] };

  // Follow the server's countdown so "3-2-1-GO" is in lockstep on both screens.
  // A snapshot arrives *after* a number has begun, so seed its elapsed time
  // instead of resetting it to zero each time; otherwise the number stays fully
  // opaque and the countdown animation appears frozen. The audio cue itself
  // arrives as an event from the server.
  if (state.countdown !== s.c && s.m === 'countdown' && s.c > 0) countdownTimer = 0;
  state.mode = s.m;
  state.countdown = s.c;
  state.timeLeft = s.tl;
  state.scores.player = own.score;
  state.scores.ai = foe.score;
  state.lives = s.lv;
  state.rally = s.ra;
  state.zoneTop = s.zt;
  state.zoneBottom = s.zb;

  // Own paddle stays locally predicted; only its size and effects are applied.
  player.h = own.pad[1];
  player.growT = own.pad[2]; player.shrinkT = own.pad[3]; player.hitFlash = own.pad[4];
  /* Ability windows. These drive the armed-paddle glow and the cooldown badge,
     so without them pressing smash produces no visible feedback whatsoever and
     the ability feels like it simply does not work. Older snapshots omit them,
     hence the length guard. */
  if (own.pad.length > 5) {
    player.smashT = own.pad[5]; player.smashCD = own.pad[6]; player.catchT = own.pad[7];
  }
  net.ownY = netReconcileOwnPaddle(own.pad[0], netOwnAck(s));

  ai.h = foe.pad[1];
  ai.growT = foe.pad[2]; ai.shrinkT = foe.pad[3]; ai.hitFlash = foe.pad[4];
  if (foe.pad.length > 5) {
    ai.smashT = foe.pad[5]; ai.smashCD = foe.pad[6]; ai.catchT = foe.pad[7];
  }

  /* Track how fast the opponent is moving between snapshots so the gap can be
     extrapolated rather than merely chased. Snapshots arrive at 30Hz but the
     screen redraws at 60+; easing toward a target that only changes every other
     frame makes the paddle decelerate, jump, decelerate, jump. Estimating its
     velocity lets it travel smoothly through the gap. */
  const nowMs = performance.now();
  const prevTarget = net.targets;
  let foeVy = 0;
  if (prevTarget) {
    const gap = (nowMs - prevTarget.at) / 1000;
    // Ignore absurd gaps (tab was backgrounded) and division blow-ups.
    if (gap > 0.004 && gap < 0.5) {
      const raw = (foe.pad[0] - prevTarget.aiY) / gap;
      // Smooth the estimate: snapshot Y is rounded to whole pixels, so a raw
      // difference is noisy enough to reintroduce the stutter it removes.
      foeVy = prevTarget.vy + (raw - prevTarget.vy) * 0.5;
    }
  }
  net.targets = { aiY: foe.pad[0], vy: foeVy, at: nowMs };

  // Ghost helpers follow the same side mapping as the paddles.
  if (mirror) {
    ghostL.y = s.g[3]; ghostL.h = s.g[4]; ghostL.timer = s.g[5];
    ghostR.y = s.g[0]; ghostR.h = s.g[1]; ghostR.timer = s.g[2];
    ghostL.x = W - (W - PADDLE_MARGIN - PADDLE_W - GHOST_OFFSET) - PADDLE_W;
    ghostR.x = W - (PADDLE_MARGIN + GHOST_OFFSET) - PADDLE_W;
  } else {
    ghostL.y = s.g[0]; ghostL.h = s.g[1]; ghostL.timer = s.g[2];
    ghostR.y = s.g[3]; ghostR.h = s.g[4]; ghostR.timer = s.g[5];
    ghostL.x = PADDLE_MARGIN + GHOST_OFFSET;
    ghostR.x = W - PADDLE_MARGIN - PADDLE_W - GHOST_OFFSET;
  }

  const previous = new Map(balls.map(b => [b.id, b]));
  balls = s.b.map(([x, y, r, type, heldBy, speed, holdT, aimAngle, phase, vx, vy], i) => {
    const prior = previous.get(i);
    return {
      id: i, x: mx(x), y, r, type, heldBy: swapHeld(heldBy || null),
      speed, holdT, phase,
      // When mirrored, vx flips and the aim angle reflects across the vertical.
      vx: mirror ? -vx : vx, vy,
      aimAngle: aimAngle ? (mirror ? Math.PI - aimAngle : aimAngle) : 0,
      split: false, portalCD: 0, catchCD: 0, chargeBeepT: 0, lastHit: null,
      // Carry the dead-reckoned render position across snapshots.
      rx: prior ? prior.rx : mx(x), ry: prior ? prior.ry : y,
      wallCD: prior ? prior.wallCD : 0,
    };
  });

  // Reuse existing pickups: rebuilding them every snapshot resets their birth
  // time, which freezes the idle pulse and restarts the spawn bloom endlessly.
  const stale = new Set(powerups);
  for (const [x, y, type, life] of s.pu) {
    const px = mx(x);
    let pu = powerups.find(p => stale.has(p) && p.type === type &&
      Math.abs(p.x - px) < 2 && Math.abs(p.y - y) < 2);
    if (pu) { stale.delete(pu); pu.life = life; }
    else powerups.push({ type, x: px, y, life, born: performance.now(), spawnT: state.fieldTime });
  }
  for (const gone of stale) powerups.splice(powerups.indexOf(gone), 1);

  state.bumpers = s.bp.map(([x, y, r]) => ({ x: mx(x), y, r, vx: 0, vy: 0, pulse: 0 }));
  // Preserve the portal pair's spawn time so its opening animation plays once.
  const priorPortals = state.portals;
  state.portals = s.po ? {
    a: { x: mx(s.po[0]), y: s.po[1] }, b: { x: mx(s.po[2]), y: s.po[3] }, life: s.po[4],
    spawnT: priorPortals ? priorPortals.spawnT : state.fieldTime,
  } : null;
  state.well = s.we ? { x: mx(s.we[0]), y: s.we[1], life: s.we[2] } : null;
  state.wind = s.wi[0];
  state.windLife = s.wi[1];
  state.chargeWindow = s.ch;
  state.slowTimer = s.sl;
  state.suddenDeath = !!s.sd;
  state.wave = s.wv;
  state.survivalTime = s.st;
  /* Screen shake and the goal flash decay in render.js, i.e. per drawn frame,
     not per simulation tick. The server decays them too, so the snapshot value
     is a genuine current level and is taken as-is. Merging with Math.max would
     mean the value could only ever rise: between two packets the renderer
     removes a little and the next packet puts it straight back, which produced
     a permanent strobe after the first goal. */
  state.shake = s.sh;
  state.flash = s.fl;
  /* Side swap. This is a render transform, not a change of ownership, so it
     composes with the guest's own mirroring: a flipped arena looks swapped to
     both players while each still controls the same paddle. */
  state.flipped = !!s.fd;
  state.flipPending = !!s.fp;
  state.flipTimer = s.ft || 0;
  state.invertT = s.iv || 0;

  netLocalAudio(s, own, foe);

  // Replay the effects the server recorded while simulating, mapped into this
  // client's view. Sounds are played locally rather than streamed.
  for (const e of s.ev || []) {
    const c = netEventColor(e.c, mirror);
    if (e.k === 'particles') spawnParticles(mx(e.x), e.y, c, e.n, e.p);
    else if (e.k === 'ripple') ripple(mx(e.x), e.y, c, e.r, e.w);
    else if (e.k === 'popup') popup(mx(e.x), e.y, e.s, c, e.z);
    else if (e.k === 'burst') {
      /* Directional, so the angle must be reflected for a mirrored view as well
         as the position. Reflecting across the vertical axis maps a heading of
         a to (PI - a), which keeps the burst flying away from the paddle that
         produced it instead of back into it. */
      const opts = { ...e.o };
      if (mirror && typeof opts.angle === 'number') opts.angle = Math.PI - opts.angle;
      spawnBurst(mx(e.x), e.y, c, opts);
    }
    else if (e.k === 'sfx' && typeof sfx[e.n] === 'function') {
      // Scoring cues are directional, and the server does not know which side
      // is "you": netLocalAudio already derives those from the score change.
      if (e.n !== 'scoreFor' && e.n !== 'scoreAgainst') sfx[e.n](...(e.a || []));
    }
  }

  // The server owns the result, so both clients show it from the snapshot.
  if (s.m === 'over' && !net.ended) {
    net.ended = true;
    endMatch({ fromNetwork: true });
  } else if (s.m !== 'over') {
    net.ended = false;
  }
}

// Client-side smoothing. Interpolating alone always renders the past, so balls
// visibly trail. Instead each client keeps simulating every ball from the
// server's last known velocity and continuously reconciles that dead-reckoned
// position toward the newest authoritative one.
function netInterpolate(dt) {
  if (!net.targets) return;
  const slow = state.slowTimer > 0 ? SLOW_FACTOR : 1;

  // Nothing moves before the serve, so predicting during the countdown makes a
  // stationary ball jitter between extrapolation and correction.
  const frozen = state.mode !== 'play';

  for (const b of balls) {
    if (b.heldBy || frozen || (b.vx === 0 && b.vy === 0)) {
      // Held/stationary balls track the authoritative position exactly.
      b.rx = b.x; b.ry = b.y;
      continue;
    }
    /* Predict forward, but never across a paddle plane the ball is heading
       into. The outcome of that contact is unknowable until the server says so:
       it may bounce, be caught, or be missed entirely. Extrapolating through it
       commits to "missed", and if the server actually returned the ball the
       client is then wrong by twice the extrapolated distance — measured at
       over 500px, well past the 140px hard-snap threshold, which is exactly the
       teleporting that reads as the ball phasing through the paddle.

       Holding at the plane instead keeps the error to a few pixels in the worst
       case, and the next snapshot resolves it either way. */
    const nextX = b.rx + b.vx * slow * dt;
    const nextY = b.ry + b.vy * slow * dt;
    let blocked = false;
    for (const pad of [player, ai]) {
      const towards = pad === ai ? b.vx < 0 : b.vx > 0;
      if (!towards) continue;
      const face = pad === ai ? pad.x + PADDLE_W + b.r : pad.x - b.r;
      const crossing = pad === ai ? (b.rx >= face && nextX < face)
                                  : (b.rx <= face && nextX > face);
      if (!crossing) continue;
      // Only a contact the paddle could actually make counts.
      if (nextY + b.r < pad.y || nextY - b.r > pad.y + pad.h) continue;
      b.rx = face;
      blocked = true;
      break;
    }
    if (!blocked) b.rx = nextX;
    b.ry = nextY;

    b.wallCD = Math.max(0, (b.wallCD || 0) - dt);
    if (b.ry - b.r < topWall()) { b.ry = topWall() + b.r; b.vy = Math.abs(b.vy); }
    if (b.ry + b.r > botWall()) { b.ry = botWall() - b.r; b.vy = -Math.abs(b.vy); }

    // Gently pull the prediction back to the server position. A hard snap is
    // reserved for large errors (teleports, portals, scoring resets).
    const errX = b.x - b.rx, errY = b.y - b.ry;
    const error = Math.hypot(errX, errY);
    if (error > 140) { b.rx = b.x; b.ry = b.y; }
    else if (error > 1.5) {
      // Deadzone: sub-pixel corrections from rounded velocities would otherwise
      // fight the prediction every frame and read as jitter.
      const k = Math.min(1, RECONCILE_RATE * dt);
      b.rx += errX * k;
      b.ry += errY * k;
    }
    b.x = b.rx; b.y = b.ry;
  }

  /* Opponent paddle: extrapolate, then converge.

     The authoritative position is advanced by the opponent's estimated velocity
     so it keeps moving between packets, and the rendered paddle eases toward
     that moving target. Without the extrapolation the target is stationary for
     half the frames and the paddle visibly stutters. */
  const foe = net.targets;
  foe.aiY += foe.vy * dt;
  // Never let extrapolation push the paddle outside the arena.
  foe.aiY = clamp(foe.aiY, topWall(), botWall() - ai.h);
  ai.y += (foe.aiY - ai.y) * Math.min(1, INTERP_RATE * dt);

  /* Reconcile our own paddle against the replayed authoritative position.

     net.ownY is not the raw snapshot value: pending inputs have already been
     replayed onto it, so it represents where the server WILL have the paddle
     once everything in flight is processed. Comparing against that is an
     apples-to-apples check, and while the player moves steadily the error stays
     near zero instead of trailing by a round trip. */
  if (net.ownY !== null && !paddleHolds('player')) {
    const err = net.ownY - player.y;
    if (Math.abs(err) > OWN_PADDLE_SNAP) player.y = net.ownY;
    else if (Math.abs(err) > OWN_PADDLE_DEADZONE) {
      player.y += err * Math.min(1, OWN_PADDLE_RECONCILE * dt);
    }
  }
}

/* Each client predicts its own paddle locally so its input feels instant.

   The prediction MUST obey the same speed limit the server enforces. Mouse
   aiming uses an exponential follow, which is not speed-limited at all: a flick
   across the arena moves the paddle at ~7000px/s, while the server refuses
   anything above NET_MAX_PADDLE_SPEED. The client then runs far ahead of the
   authoritative position, the error grows past OWN_PADDLE_SNAP, and the paddle
   is repeatedly snapped backwards — which is exactly what fast movement felt
   like. Clamping here keeps prediction and authority in agreement, so there is
   nothing to correct. */
function netPredictLocalPaddle(dt) {
  if (paddleHolds('player')) { player.vy = player.smoothVy = 0; return; }
  // Guard against a stale/absent height from early snapshots: a bad height
  // makes the clamp below collapse and pins the paddle in place.
  if (!(player.h > 0)) player.h = BASE_PADDLE_H;
  const prevY = player.y;
  let dir = 0;
  if (keys['w'] || keys['arrowup']) dir -= 1;
  if (keys['s'] || keys['arrowdown']) dir += 1;
  if (dir !== 0) {
    mouseY = null;
    player.vy += (dir * PLAYER_SPEED - player.vy) * Math.min(1, 16 * dt);
    player.y += player.vy * dt;
  } else if (mouseY !== null) {
    const target = clamp(mouseY - player.h / 2, topWall(), botWall() - player.h);
    player.y += (target - player.y) * Math.min(1, 20 * dt);
  } else {
    player.vy *= Math.max(0, 1 - 10 * dt);
  }
  // Same rule as the server's movePaddle, applied to whatever the controls
  // produced above.
  const step = player.y - prevY;
  const maxStep = NET_MAX_PADDLE_SPEED * dt;
  if (Math.abs(step) > maxStep) player.y = prevY + Math.sign(step) * maxStep;
  player.y = clamp(player.y, topWall(), botWall() - player.h);

  /* Carry the authoritative reference forward by the same amount.

     net.ownY is recomputed only when a snapshot arrives (30Hz), but prediction
     advances every frame (60Hz+). Left alone, the reference goes stale between
     packets and the measured error alternates every frame — large, small,
     large — so the correction applied in netInterpolate pulses and the paddle
     visibly buzzes. Advancing it in lockstep keeps the comparison like-for-like
     between snapshots, leaving only genuine disagreement to correct. */
  if (net.ownY !== null) {
    net.ownY = clamp(net.ownY + (player.y - prevY), topWall(), botWall() - player.h);
  }

  player.smoothVy += ((player.y - prevY) / Math.max(dt, 1e-4) - player.smoothVy) * Math.min(1, 14 * dt);
}

function netHandleMessage(message) {
  // Settings sync happens in the lobby, before net.active is set, so this case
  // is keyed off the room role rather than an in-progress match.
  if (message.t === 'cfg' && roomClient.role === 'guest') {
    netApplySettings(message.s);
    return;
  }
  // Snapshots are ignored while a transition is rebuilding local state; the
  // next one arrives within ~33ms of it finishing.
  if (message.t === 's' && isNetGuest() && !net.settling) netApplySnapshot(message);
}

// Host: push the current lobby configuration to the guest on every change.
function netBroadcastSettings() {
  if (roomClient.role !== 'host') return;
  roomSend({ t: 'cfg', s: netSettings() });
}
