'use strict';

/* ============================================================
   Host-authoritative netcode

   The host simulates the entire match and broadcasts snapshots.
   The guest sends only its input and renders the authoritative state.
   Guest drives the LEFT paddle; host drives the RIGHT paddle.
   ============================================================ */
const SNAPSHOT_HZ = 60;   // higher tick = far less visible stepping
const INPUT_HZ = 60;
const INTERP_RATE = 18;   // exponential convergence toward the newest snapshot
const RECONCILE_RATE = 6; // how firmly dead-reckoned balls are pulled to truth

// Queued host-side presentation events (see netEmit in core.js).
const netEvents = [];

const net = {
  active: false,
  role: null,           // 'host' | 'guest'
  snapshotT: 0,
  inputT: 0,
  remote: { y: null, action: false },          // latest guest input (host side)
  action: false,                                // local click latch (guest side)
  targets: null,        // guest: latest authoritative positions to ease toward
  ended: false,         // guest: game-over overlay already shown
  sentGameOver: false,  // host: final snapshot has been pushed
  audio: {},            // guest: previous snapshot values used to trigger sound
};

const isPvp = () => state.opponent === 'pvp' && net.active;
const isNetHost = () => isPvp() && net.role === 'host';
const isNetGuest = () => isPvp() && net.role === 'guest';

function netStart(role) {
  net.active = true;
  net.role = role;
  net.snapshotT = net.inputT = 0;
  net.remote = { y: null, action: false };
  net.action = false;
  net.targets = null;
  netEvents.length = 0;
  net.ended = false;
  net.sentGameOver = false;
  net.audio = {};
  if (role === 'guest') {
    // Start from a sane local paddle so movement works before snapshot #1.
    player.h = BASE_PADDLE_H;
    player.y = H / 2 - player.h / 2;
    player.vy = player.smoothVy = 0;
  }
  debugLog('game', `NET: match started as ${role.toUpperCase()}`);
}

function netStop() {
  if (net.active) debugLog('game', 'NET: session ended');
  net.active = false;
  net.role = null;
  net.targets = null;
}

/* ---------- settings sync (host -> guest) ---------- */
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

/* ---------- guest input ---------- */
function netSendInput(dt) {
  net.inputT -= dt;
  // A click must never be swallowed by the send throttle: smash timing is only
  // a fraction of a second, so send immediately when an action is pending.
  if (net.inputT > 0 && !net.action) return;
  net.inputT = 1 / INPUT_HZ;
  // Send the predicted paddle centre: the host mirrors sides but not the
  // vertical axis, so the value maps directly onto its left paddle.
  roomSend({ t: 'i', y: player.y + player.h / 2, a: net.action });
  net.action = false;
}

// Host moves the guest's paddle from the last input it received.
function netDriveRemotePaddle(dt) {
  const pad = ai;
  if (paddleHolds('ai')) { pad.vy = pad.smoothVy = 0; return; }
  pad.h = paddleHeight(pad);
  const prevY = pad.y;
  // The guest predicts locally and reports an absolute paddle centre, so the
  // host follows that position directly rather than re-simulating its input.
  if (net.remote.y !== null) {
    const target = clamp(net.remote.y - pad.h / 2, topWall(), botWall() - pad.h);
    // Snap when a ball is about to arrive: easing toward a latency-delayed
    // position leaves the paddle behind, and the ball passes through where the
    // guest already sees it. The guest's own view stays authoritative here.
    const incoming = balls.some(b => !b.heldBy && b.vx < 0 && b.x - pad.x < 130);
    pad.y += (target - pad.y) * (incoming ? 1 : Math.min(1, 28 * dt));
  } else {
    pad.vy *= Math.max(0, 1 - 10 * dt);
  }
  pad.y = clamp(pad.y, topWall(), botWall() - pad.h);
  pad.smoothVy += ((pad.y - prevY) / Math.max(dt, 1e-4) - pad.smoothVy) * Math.min(1, 14 * dt);

  if (net.remote.action) {
    net.remote.action = false;
    const held = balls.find(b => b.heldBy === 'ai');
    if (held) releaseBall(held);
    else if (state.chargeWindow > 0) pad.catchT = CATCH_WINDOW;
    else if (pad.smashCD <= 0 && pad.smashT <= 0) pad.smashT = SMASH_WINDOW;
  }
}

/* ---------- snapshots ---------- */
function netSendSnapshot(dt, force = false) {
  net.snapshotT -= dt;
  if (net.snapshotT > 0 && !force) return;
  net.snapshotT = 1 / SNAPSHOT_HZ;
  roomSend({
    t: 's',
    m: state.mode,
    c: state.countdown,
    tl: Math.round(state.timeLeft * 10) / 10,
    sc: [state.scores.player, state.scores.ai],
    lv: state.lives,
    ra: state.rally,
    zt: Math.round(state.zoneTop), zb: Math.round(state.zoneBottom),
    p: [Math.round(player.y), Math.round(player.h), Math.round(player.growT * 10) / 10, Math.round(player.shrinkT * 10) / 10, Math.round(player.hitFlash * 100) / 100],
    a: [Math.round(ai.y), Math.round(ai.h), Math.round(ai.growT * 10) / 10, Math.round(ai.shrinkT * 10) / 10, Math.round(ai.hitFlash * 100) / 100],
    g: [Math.round(ghostL.y), Math.round(ghostL.h), Math.round(ghostL.timer * 10) / 10,
        Math.round(ghostR.y), Math.round(ghostR.h), Math.round(ghostR.timer * 10) / 10],
    b: balls.map(b => [Math.round(b.x), Math.round(b.y), Math.round(b.r), b.type, b.heldBy || 0,
                       Math.round(b.speed), Math.round(b.holdT * 100) / 100,
                       Math.round((b.aimAngle || 0) * 100) / 100, Math.round(b.phase * 100) / 100,
                       Math.round(b.vx), Math.round(b.vy)]),
    pu: powerups.map(p => [Math.round(p.x), Math.round(p.y), p.type, Math.round(p.life * 10) / 10]),
    bp: state.bumpers.map(p => [Math.round(p.x), Math.round(p.y), Math.round(p.r)]),
    po: state.portals ? [Math.round(state.portals.a.x), Math.round(state.portals.a.y),
                         Math.round(state.portals.b.x), Math.round(state.portals.b.y),
                         Math.round(state.portals.life * 10) / 10] : 0,
    we: state.well ? [Math.round(state.well.x), Math.round(state.well.y), Math.round(state.well.life * 10) / 10] : 0,
    wi: [Math.round(state.wind), Math.round(state.windLife * 10) / 10],
    ch: Math.round(state.chargeWindow * 10) / 10,
    sl: Math.round(state.slowTimer * 10) / 10,
    sd: state.suddenDeath ? 1 : 0,
    wv: state.wave,
    st: Math.round(state.survivalTime * 10) / 10,
    sh: Math.round(state.shake * 10) / 10,
    fl: Math.round(state.flash * 100) / 100,
    ev: netEvents.splice(0),
  });
}

/* The guest owns its own audio. Sound is presentation, not simulation, so it is
   derived from changes in the authoritative state rather than streamed as
   individual tones over the socket. */
function netLocalAudio(s) {
  const prev = net.audio;

  if (prev.rally !== undefined && s.ra > prev.rally) sfx.paddle();
  const scored = prev.scores && (s.sc[0] !== prev.scores[0] || s.sc[1] !== prev.scores[1]);
  // The guest's own side is the host's left paddle (index 0).
  if (scored) (s.sc[0] > prev.scores[0] ? sfx.scoreFor : sfx.scoreAgainst)();
  if (prev.lives !== undefined && s.lv < prev.lives) sfx.life();
  if (prev.powerups !== undefined && s.pu.length < prev.powerups && !scored) sfx.power();

  net.audio = { rally: s.ra, scores: [s.sc[0], s.sc[1]], lives: s.lv, powerups: s.pu.length };
}

function netApplySnapshot(s) {
  // The guest is the LEFT paddle in the host's simulation, so its whole view is
  // mirrored: both players then see themselves on the right of their own screen.
  const mx = (x) => W - x;
  const swapHeld = (held) => held === 'player' ? 'ai' : held === 'ai' ? 'player' : null;

  // Follow the host's countdown so "3-2-1-GO" is in lockstep on both screens.
  // Resetting the local tick timer restarts the per-number pop animation.
  if (state.countdown !== s.c && s.m === 'countdown' && s.c > 0) { sfx.count(); countdownTimer = 0; }
  if (state.mode === 'countdown' && s.m === 'play') sfx.go();
  state.mode = s.m;
  state.countdown = s.c;
  state.timeLeft = s.tl;
  state.scores.player = s.sc[1];
  state.scores.ai = s.sc[0];
  state.lives = s.lv;
  state.rally = s.ra;
  state.zoneTop = s.zt;
  state.zoneBottom = s.zb;
  // The guest IS the host's left paddle (s.a); the host's own paddle (s.p) is
  // the opponent. Own paddle stays locally predicted: only its size is applied.
  player.h = s.a[1];
  player.growT = s.a[2]; player.shrinkT = s.a[3]; player.hitFlash = s.a[4];
  ai.h = s.p[1];
  ai.growT = s.p[2]; ai.shrinkT = s.p[3]; ai.hitFlash = s.p[4];
  if (net.targets) net.targets.aiY = s.p[0];
  // Ghost helpers mirror sides along with everything else.
  ghostL.y = s.g[3]; ghostL.h = s.g[4]; ghostL.timer = s.g[5];
  ghostR.y = s.g[0]; ghostR.h = s.g[1]; ghostR.timer = s.g[2];
  ghostL.x = W - (W - PADDLE_MARGIN - PADDLE_W - GHOST_OFFSET) - PADDLE_W;
  ghostR.x = W - (PADDLE_MARGIN + GHOST_OFFSET) - PADDLE_W;

  const previous = new Map(balls.map(b => [b.id, b]));
  balls = s.b.map(([x, y, r, type, heldBy, speed, holdT, aimAngle, phase, vx, vy], i) => {
    const prior = previous.get(i);
    return {
      id: i, x: mx(x), y, r, type, heldBy: swapHeld(heldBy || null),
      speed, holdT, phase,
      // Mirrored horizontally: vx flips, aim angle reflects across vertical axis.
      vx: -vx, vy, aimAngle: aimAngle ? Math.PI - aimAngle : 0,
      split: false, portalCD: 0, catchCD: 0, chargeBeepT: 0, lastHit: null,
      // Render position eases in from the previous frame to hide 60 Hz steps.
      rx: prior ? prior.rx : mx(x), ry: prior ? prior.ry : y,
      wallCD: prior ? prior.wallCD : 0,
    };
  });
  net.targets = { aiY: s.p[0] };

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
  state.shake = Math.max(state.shake, s.sh);
  state.flash = Math.max(state.flash, s.fl);

  netLocalAudio(s);

  // Replay the host's presentation events locally (mirrored to this view).
  for (const e of s.ev || []) {
    if (e.k === 'particles') spawnParticles(mx(e.x), e.y, e.c, e.n, e.p);
    else if (e.k === 'ripple') ripple(mx(e.x), e.y, e.c, e.r, e.w);
    else if (e.k === 'popup') popup(mx(e.x), e.y, e.s, e.c, e.z);

  }

  // Only the host simulates, so the guest shows the result from the snapshot.
  if (s.m === 'over' && !net.ended) {
    net.ended = true;
    endMatch();
  } else if (s.m !== 'over') {
    net.ended = false;
  }
}

// Guest-side smoothing. Interpolating alone always renders the past, so balls
// visibly trail. Instead the guest keeps simulating each ball from the host's
// last known velocity and continuously reconciles that dead-reckoned position
// toward the newest authoritative one.
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
    // Predict forward, then bounce off the live walls so the motion stays
    // plausible between packets.
    b.rx += b.vx * slow * dt;
    b.ry += b.vy * slow * dt;
    // Wall taps aren't derivable from snapshot fields, so the guest raises them
    // from its own prediction bouncing off the live walls.
    b.wallCD = Math.max(0, (b.wallCD || 0) - dt);
    const tapped = (b.ry - b.r < topWall()) || (b.ry + b.r > botWall());
    if (b.ry - b.r < topWall()) { b.ry = topWall() + b.r; b.vy = Math.abs(b.vy); }
    if (b.ry + b.r > botWall()) { b.ry = botWall() - b.r; b.vy = -Math.abs(b.vy); }
    // Cooldown stops reconciliation nudges from retriggering the same tap.
    if (tapped && b.wallCD === 0) { sfx.wall(); b.wallCD = 0.08; }

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

  ai.y += (net.targets.aiY - ai.y) * Math.min(1, INTERP_RATE * dt);
}

// The guest predicts its own paddle locally so its input feels instant.
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
  player.y = clamp(player.y, topWall(), botWall() - player.h);
  player.smoothVy += ((player.y - prevY) / Math.max(dt, 1e-4) - player.smoothVy) * Math.min(1, 14 * dt);
}

function netHandleMessage(message) {
  // Settings sync happens in the lobby, before net.active is set, so this case
  // is keyed off the room role rather than an in-progress match.
  if (message.t === 'cfg' && roomClient.role === 'guest') {
    netApplySettings(message.s);
    return;
  }
  if (message.t === 'i' && isNetHost()) {
    net.remote.y = message.y;
    if (message.a) net.remote.action = true;
  } else if (message.t === 's' && isNetGuest()) {
    netApplySnapshot(message);
  }
}

// Host: push the current lobby configuration to the guest on every change.
function netBroadcastSettings() {
  if (roomClient.role !== 'host') return;
  roomSend({ t: 'cfg', s: netSettings() });
}
