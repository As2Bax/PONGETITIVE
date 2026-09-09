'use strict';

/* ============================================================
   Player (right side)
   ============================================================ */
function updatePlayer(dt) {
  // While holding a ball, movement controls aim instead of moving the paddle.
  if (paddleHolds('player')) { player.vy = player.smoothVy = 0; return; }
  player.h = paddleHeight(player);
  const prevY = player.y;

  let dir = 0;
  if (keys['w'] || keys['arrowup']) dir -= 1;
  if (keys['s'] || keys['arrowdown']) dir += 1;
  // IMPOSSIBLE: the inversion curse flips your inputs
  if (state.invertT > 0) dir = -dir;

  if (dir !== 0) {
    mouseY = null; // keyboard overrides mouse until it moves again
    player.vy += (dir * PLAYER_SPEED - player.vy) * Math.min(1, 16 * dt);
    player.y += player.vy * dt;
  } else {
    const inputY = mouseY;
    if (inputY === null) {
      player.vy *= Math.max(0, 1 - 10 * dt);
      player.y = clamp(player.y, topWall(), botWall() - player.h);
      return;
    }
    // smooth exponential follow - no jitter, no teleporting
    // (inversion curse mirrors the mouse target around center)
    const my = state.invertT > 0 ? (topWall() + botWall()) - inputY : inputY;
    const target = clamp(my - player.h / 2, topWall(), botWall() - player.h);
    player.y += (target - player.y) * Math.min(1, 20 * dt);
  }
  player.y = clamp(player.y, topWall(), botWall() - player.h);
  // Smoothed paddle velocity, tracked for both mouse & keys. Kept for feel
  // tuning and debugging; no mechanic reads it since curve was removed.
  const instVy = (player.y - prevY) / Math.max(dt, 1e-4);
  player.smoothVy += (instVy - player.smoothVy) * Math.min(1, 14 * dt);
}

/* ============================================================
   Physics
   ============================================================ */
function paddleBounce(b, paddle, isPlayer) {
  const center = paddle.y + paddle.h / 2;
  const rel = clamp((b.y - center) / (paddle.h / 2), -1, 1);
  const angle = rel * MAX_BOUNCE_ANGLE;
  // normal speedup below the base cap; once the combo is carrying the ball
  // beyond it, growth slows to a crawl - climbing, but never exploding.
  // heavy balls barely accelerate at all.
  const spd = b.type === 'heavy' ? 1 + (cfg().speedup - 1) * 0.3 : cfg().speedup;
  if (b.speed < cfg().maxSpeed) {
    b.speed = Math.min(b.speed * spd, speedCap());
  } else {
    b.speed = Math.min(b.speed * 1.012, speedCap());
  }

  // SMASH: armed paddle rockets the return
  const paddleColor = isPlayer ? theme.right.base : theme.left.base;
  const smashed = paddle.smashT > 0;
  if (smashed) {
    b.speed = Math.min(b.speed * SMASH_MULT, speedCap() * 1.15);
    paddle.smashT = 0;
    paddle.smashCD = SMASH_CD;
    state.shake = 12;
    popup(b.x, b.y - 20, 'SMASH!', paddleColor, 16);
    beep(180, 0.12, 'sawtooth', 0.16);
  }

  const dir = isPlayer ? -1 : 1;                 // player sends ball LEFT, AI sends RIGHT
  b.vx = Math.cos(angle) * b.speed * dir;
  b.vy = Math.sin(angle) * b.speed;
  if (smashed) {
    // A fast, wide shockwave and a short directional trail sell the launch
    // without lingering on-screen or obscuring the next exchange.
    ripple(b.x, b.y, paddleColor, 62, 3);
    const launchAngle = Math.atan2(b.vy, b.vx);
    spawnBurst(b.x, b.y, paddleColor, {
      n: 14, angle: launchAngle, spread: 0.65,
      power: 220, powerVar: 180,
      life: 0.18, lifeVar: 0.14, maxLife: 0.32,
      size: 1.5, sizeVar: 2,
      // Every third particle is white, giving the trail a hot core.
      altColor: '#ffffff', altEvery: 3,
    });
    debugLog('game', `${debugParticipant(isPlayer ? 'player' : 'ai')} SMASHES`, {
      speed: Math.round(b.speed), direction: Math.round(launchAngle * 180 / Math.PI),
    });
  }
  b.lastHit = isPlayer ? 'player' : 'ai';
  const priorComboLevel = comboLevel();
  state.rally++;
  const newComboLevel = comboLevel();
  // Every combo level gets a visible HUD punch, including the first one.
  if (newComboLevel > priorComboLevel) state.comboPunch = 1;
  // rising combo arpeggio - every hit past the threshold climbs a pentatonic
  // ladder; a bright octave chime punctuates each 5th level
  if (state.rally > COMBO_START) {
    const lvl = comboLevel();
    const scaleSteps = [0, 2, 4, 7, 9]; // major pentatonic
    const stepIdx = lvl % 5, octave = Math.floor(lvl / 5);
    const freq = 523 * Math.pow(2, (scaleSteps[stepIdx] + octave * 12) / 12);
    beep(Math.min(freq, 4200), 0.09, 'triangle', 0.14);
    if (stepIdx === 0 && octave > 0) {
      setTimeout(() => beep(Math.min(freq * 2, 5000), 0.12, 'sine', 0.12), 60);
      popup(W / 2, H / 2 - 40, `COMBO ×${lvl}`, '#d9a441', 16);
    }
  }
  // hard/insane: your paddle wears down over a rally (not in spectator mode, not ghosts)
  if (paddle === player && cfg().rallyShrink && !isAivai()) {
    player.rallyScale = Math.max(RALLY_SHRINK_MIN, player.rallyScale - RALLY_SHRINK_STEP);
  }
  sfx.paddle(b.y);   // contact height picks the high/low hit sample
  state.shake = b.type === 'heavy' ? 10 : 4;
  if (b.type === 'heavy') beep(110, 0.1, 'sawtooth', 0.14); // thud
  paddle.hitFlash = 1;

  // splitter: first paddle contact splits it into two normal balls
  if (b.type === 'splitter' && !b.split) {
    b.split = true;
    b.type = 'normal';
    b.r = BALL_R;
    const twin = makeBall(b.x, b.y, isPlayer ? -1 : 1, b.speed);
    twin.type = 'normal'; twin.r = BALL_R; twin.split = true;
    twin.vx = b.vx;
    twin.vy = -b.vy * 0.8 + (Math.random() - 0.5) * 120;
    twin.lastHit = b.lastHit;
    balls.push(twin);
    popup(b.x, b.y - 22, 'SPLIT!', '#7cc98a', 13);
    beep(700, 0.06, 'square', 0.12);
    setTimeout(() => beep(940, 0.08, 'square', 0.12), 60);
    spawnParticles(b.x, b.y, '#7cc98a', 16, 260);
  }
  spawnParticles(b.x, b.y, isPlayer ? theme.right.base : theme.left.base, 10, 200);
  // directional impact sparks flying off the contact edge
  spawnBurst(b.x, b.y, '#ffffff', {
    n: 6, angle: isPlayer ? Math.PI : 0, spread: 1.2,
    power: 180, powerVar: 240,
    life: 0.25, lifeVar: 0.15, maxLife: 0.4,
    size: 1, sizeVar: 1.5,
  });
  pickAiAim(); // both sides re-roll where they'll aim next
}

const paddleHolds = (who) => balls.some(b => b.heldBy === who);

function releaseBall(b) {
  const who = b.heldBy;
  const pad = who === 'player' ? player : ai;
  const chargeFrac = clamp(b.holdT / CHARGE_MAX, 0, 1);
  const angle = b.aimAngle || 0;
  const dir = who === 'player' ? -1 : 1;
  b.speed = Math.min(b.speed * (1 + (CHARGE_BOOST - 1) * chargeFrac), speedCap() * 1.2);
  b.vx = Math.cos(angle) * b.speed * dir;
  b.vy = Math.sin(angle) * b.speed;
  b.heldBy = null;
  b.holdT = 0;
  b.catchCD = CATCH_CD;
  b.lastHit = who;
  pad.hitFlash = 1;
  state.shake = 6 + chargeFrac * 8;
  popup(b.x, b.y - 22, chargeFrac >= 0.99 ? 'FULL CHARGE!' : 'RELEASE!', '#e3c15a', chargeFrac >= 0.99 ? 16 : 12);
  beep(180 + chargeFrac * 120, 0.14, 'sawtooth', 0.12 + chargeFrac * 0.06);
  spawnParticles(b.x, b.y, '#e3c15a', 10 + Math.round(chargeFrac * 14), 220 + chargeFrac * 180);
}

// Lightweight tactical shot search, not a perfect physics solver. Sample
// bank shots against the current walls; avoid uncertain field interactions.
function chooseBotShot(b, who) {
  const self = who === 'ai' ? ai : player;
  const foe = who === 'ai' ? player : ai;
  const direction = who === 'ai' ? 1 : -1;
  const endX = who === 'ai' ? player.x - b.r : ai.x + PADDLE_W + b.r;
  const utility = {
    grow: self.growT > 2 ? 25 : 160,
    shrink: foe.shrinkT > 2 ? 25 : 140,
    ghost: (who === 'ai' ? ghostL : ghostR).timer > 2 ? 25 : 150,
    slow: self.h < foe.h ? 90 : 30,
    multi: balls.length < mode().maxBalls ? 70 : 0,
    mega: balls.length < HARD_BALL_CAP ? 55 : 0,
    charge: state.chargeWindow < 8 ? 90 : 15,
    flip: state.flipTimer <= 0 ? 40 : 0,
  };
  // Arena-trick shots target a field feature directly. IMPOSSIBLE attempts
  // them on every caught-ball shot; INSANE only dabbles (b.fieldPlay), with
  // enough aim error that its trick lands roughly rather than perfectly.
  if (b.fieldPlay) {
    // impossible aims true; insane's hand shakes a little on the fancy stuff
    const smear = cfg().aiPerfect ? 0 : 40;
    const wobbleY = () => (Math.random() * 2 - 1) * smear;
    const aimAt = (tx, ty) =>
      clamp(Math.atan2((ty + wobbleY()) - b.y, Math.max(40, direction * (tx - b.x))), -MAX_BOUNCE_ANGLE, MAX_BOUNCE_ANGLE);
    // gravity well: skim JUST past the core - never through it. A full-speed
    // ball grazing the core keeps its pace but picks up a vicious late bend.
    // The pull is toward the core, so passing BELOW bends the ball UP and
    // passing ABOVE bends it DOWN - pick the side with room for the curve:
    //   well sits low  -> skim below, the bend lifts the ball clear
    //   well sits high -> skim above, the bend dives it down
    //   well centered   -> free choice; bend away from the foe's paddle
    if (state.well && state.well.life > 1 && direction * (state.well.x - b.x) > 60) {
      const skim = 26; // px off-core: close enough to whip, too fast to capture
      const span = botWall() - topWall();
      const wellFrac = (state.well.y - topWall()) / span; // 0 top .. 1 bottom
      let side;
      if (wellFrac > 0.65) side = 1;        // low well: pass below, curve up
      else if (wellFrac < 0.35) side = -1;  // high well: pass above, curve down
      else side = (foe.y + foe.h / 2 > (topWall() + botWall()) / 2) ? -1 : 1;
      debugLog('ai', `${debugParticipant(who)} targets GRAVITY WELL`, {
        side: side < 0 ? 'above' : 'below', well: { x: Math.round(state.well.x), y: Math.round(state.well.y) },
      });
      return aimAt(state.well.x, state.well.y + side * skim);
    }
    // portals: fire into an entry whose EXIT is far from the foe's paddle -
    // the ball teleports across the arena away from their reach
    if (state.portals && state.portals.life > 1) {
      let bestPortal = null, bestGap = 150; // only bother if the exit is genuinely open
      for (const [entry, exit] of [[state.portals.a, state.portals.b], [state.portals.b, state.portals.a]]) {
        if (direction * (entry.x - b.x) < 60) continue; // entry must be ahead
        const gap = Math.abs(exit.y - (foe.y + foe.h / 2)) + Math.abs(exit.x - foe.x) * 0.3;
        if (gap > bestGap) { bestGap = gap; bestPortal = entry; }
      }
      if (bestPortal) {
        debugLog('ai', `${debugParticipant(who)} targets PORTAL`, {
          entry: { x: Math.round(bestPortal.x), y: Math.round(bestPortal.y) }, gap: Math.round(bestGap),
        });
        return aimAt(bestPortal.x, bestPortal.y);
      }
    }
  }

  let bestAngle = b.aimAngle || 0, bestScore = -Infinity;
  for (let i = 0; i <= 24; i++) {
    const angle = -MAX_BOUNCE_ANGLE + i * MAX_BOUNCE_ANGLE / 12;
    let x = b.x, y = b.y, vy = Math.sin(angle);
    const vx = Math.cos(angle) * direction;
    const picked = new Set();
    let reward = 0, risk = 0, distance = 0;
    let wellClosest = Infinity;
    let wellExitSide = false;
    // 12px steps catch small pickups and allow wall-bank opportunities.
    for (let step = 0; step < 140; step++) {
      x += vx * 12; y += vy * 12; distance += 12;
      if (y < topWall() + b.r) { y = 2 * (topWall() + b.r) - y; vy = Math.abs(vy); }
      if (y > botWall() - b.r) { y = 2 * (botWall() - b.r) - y; vy = -Math.abs(vy); }
      const eta = distance / Math.max(b.speed, 1);
      if (state.well && state.well.life > eta) {
        const wellDistance = Math.hypot(x - state.well.x, y - state.well.y);
        wellClosest = Math.min(wellClosest, wellDistance);
        if (wellDistance < WELL_R) {
          const depth = 1 - wellDistance / WELL_R;
          // Core passes are liable to stall or reverse. Edge passes are
          // candidates for a deliberate late curve, not automatically bad.
          risk += depth * depth * 32;
          if (direction * (x - state.well.x) > 0) wellExitSide = true;
        }
      }
      for (const bp of state.bumpers) {
        if (Math.hypot(x - bp.x, y - bp.y) < bp.r + b.r + 12) risk += 80;
      }
      if (state.portals && state.portals.life > eta) {
        for (const portal of [state.portals.a, state.portals.b]) {
          if (Math.hypot(x - portal.x, y - portal.y) < PORTAL_R + b.r) risk += 60;
        }
      }
      for (const pu of powerups) {
        if (!picked.has(pu) && pu.life > eta && Math.hypot(x - pu.x, y - pu.y) < POWERUP_R + b.r) {
          picked.add(pu);
          reward += utility[pu.type] || 0;
        }
      }
      if (direction * (x - endX) >= 0) break;
    }
    if (state.well && wellExitSide) {
      const opponentSide = direction * (state.well.x - W / 2) > 0;
      const grazing = wellClosest / WELL_R;
      // Prefer a grazing approach on the far half: enough influence for a
      // late bend, but avoid claiming a safe slingshot through the core.
      if (opponentSide && grazing > 0.65 && grazing < 0.95) {
        const sweetSpot = 1 - Math.abs(grazing - 0.8) / 0.15;
        reward += 140 * Math.max(0, sweetSpot);
      }
    }
    const opening = Math.min(220, Math.max(0, Math.abs(y - foe.y - foe.h / 2) - foe.h / 2));
    const score = opening + reward - risk - Math.abs(angle - b.aimAngle) * 18;
    if (score > bestScore) { bestScore = score; bestAngle = angle; }
  }
  return bestAngle;
}

function catchBall(b, pad, who) {
  b.heldBy = who;
  b.holdT = b.chargeBeepT = 0;
  b.aimAngle = 0;
  // ruthless bots always cook the catch to FULL charge; others improvise
  b.holdPlan = cfg().aiPerfect ? CHARGE_MAX : 0.7 + Math.random() * 1.5;
  // will this bot try to weaponise a well/portal on THIS shot? impossible
  // always does; insane only dabbles - a nasty surprise, not a routine.
  b.fieldPlay = cfg().aiPerfect || (cfg().aiFieldPlay && Math.random() < 0.35);
  if (b.fieldPlay) debugLog('ai', `${debugParticipant(who)} is looking for an arena trick on this release`);
  pad.catchT = pad.smashT = 0;
  b.aimThinkT = 0;
  b.targetAngle = 0;
  popup(b.x, b.y - 24, 'CAUGHT!', '#e3c15a', 10);
}

function updateBalls(dt) {
  const slow = state.slowTimer > 0 ? SLOW_FACTOR : 1;

  for (let bi = balls.length - 1; bi >= 0; bi--) {
    const b = balls[bi];

    // held balls charge on the paddle face instead of flying
    if (b.heldBy) {
      const pad = b.heldBy === 'player' ? player : ai;
      b.x = b.heldBy === 'player' ? pad.x - BALL_R : pad.x + PADDLE_W + BALL_R;
      b.y = clamp(b.y + (pad.y + pad.h / 2 - b.y) * Math.min(1, 18 * dt), topWall() + BALL_R, botWall() - BALL_R);
      const previousCharge = b.holdT;
      b.holdT += dt;
      if (previousCharge < CHARGE_MAX && b.holdT >= CHARGE_MAX) {
        // One distinct completion chime per catch, not every fully charged frame.
        beep(880, 0.12, 'triangle', 0.12);
        setTimeout(() => beep(1320, 0.18, 'sine', 0.1), 90);
      }
      // rising charge whine
      b.chargeBeepT -= dt;
      if (b.chargeBeepT <= 0 && b.holdT < CHARGE_MAX) {
        b.chargeBeepT = 0.12;
        beep(300 + clamp(b.holdT / CHARGE_MAX, 0, 1) * 700, 0.06, 'sine', 0.08);
      }
      /* Who aims a held ball. The LEFT paddle is a bot in single-player, but a
         remote human in PvP, and auto-aiming their catch would take the shot
         out of their hands. In AI-vs-AI both sides are bots. */
      const isBot = isAivai() || (b.heldBy === 'ai' && !isPvp());
      if (isBot) {
        b.aimThinkT -= dt;
        if (b.aimThinkT <= 0) {
          b.targetAngle = chooseBotShot(b, b.heldBy);
          b.aimThinkT = 0.2 + Math.random() * 0.15;
        }
        // ruthless bots snap their aim twice as fast - still visible, but decisive
        const aimStep = (cfg().aiPerfect ? 1.6 : 0.8) * dt;
        b.aimAngle += clamp(b.targetAngle - b.aimAngle, -aimStep, aimStep);
      } else {
        const dir = (keys['s'] || keys['arrowdown'] ? 1 : 0) - (keys['w'] || keys['arrowup'] ? 1 : 0);
        if (dir) {
          mouseY = null;
          b.aimAngle = clamp(b.aimAngle + dir * dt * 1.8, -MAX_BOUNCE_ANGLE, MAX_BOUNCE_ANGLE);
        } else if (mouseY !== null) {
          /* Horizontal reach for the aim triangle. mouseCX is -1 whenever the
             cursor is outside the arena, which would read as a very distant
             pointer and flatten the shot; fall back to a fixed lead so aiming
             stays as responsive off-canvas as the paddle itself. */
          const reach = mouseCX >= 0 ? Math.abs(mouseCX - b.x) : 200;
          b.aimAngle = clamp(Math.atan2(mouseY - b.y, Math.max(60, reach)), -MAX_BOUNCE_ANGLE, MAX_BOUNCE_ANGLE);
        }
      }
      if (b.holdT >= CHARGE_HOLD_LIMIT || (isBot && b.holdT >= b.holdPlan)) releaseBall(b);
      continue;
    }
    if (b.catchCD > 0) b.catchCD -= dt;

    // gravity well STEERS the ball toward its core. The turn rate scales
    // with ball speed, making the *curvature per pixel traveled* constant:
    // a fast ball bends (and flips!) along the same geometric arc a slow
    // one does - speed buys you nothing, the well doesn't care how fast
    // you're going when it decides to turn you around.
    if (state.well && !b.heldBy) {
      const dx = state.well.x - b.x, dy = state.well.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < WELL_R && d > 6) {
        const strength = (1 - d / WELL_R) * (b.type === 'heavy' ? 0.45 : 1);
        const cur = Math.atan2(b.vy, b.vx);
        const toCore = Math.atan2(dy, dx);
        // shortest angular difference, then rotate toward the core
        let diff = toCore - cur;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const sp0 = Math.hypot(b.vx, b.vy);
        const spdF = Math.max(sp0 / 500, 1); // equalise transit-time advantage
        const turn = clamp(diff, -1, 1) * WELL_TURN * strength * spdF * dt;
        // fighting the well's pull costs momentum: moving away from the core
        // bleeds speed, curving in toward it wins a little back - so a ball
        // can stall deep in the well, get whipped around, and slingshot out
        // the way it came. Bleed also scales with speed so fast balls pay
        // full toll during their brief visit.
        const align = Math.cos(diff); // 1 = flying at the core, -1 = fleeing it
        const sp = sp0 * (1 + align * 0.35 * strength * spdF * dt);
        b.vx = Math.cos(cur + turn) * sp;
        b.vy = Math.sin(cur + turn) * sp;
      }
    }

    // wind pushes every ball vertically (heavy balls resist)
    if (state.wind !== 0) {
      b.vy += state.wind * (b.type === 'heavy' ? 0.35 : 1) * dt;
    }

    b.x += b.vx * slow * dt;
    b.y += b.vy * slow * dt;

    // walls (closing zone walls in ROYALE)
    if (b.y - b.r < topWall()) {
      b.y = topWall() + b.r;
      b.vy = Math.abs(b.vy);
      sfx.wall();
      spawnParticles(b.x, topWall() + 2, '#8899bb', 6, 120);
      ripple(b.x, topWall(), '#8899bb', 34, 2);
    } else if (b.y + b.r > botWall()) {
      b.y = botWall() - b.r;
      b.vy = -Math.abs(b.vy);
      sfx.wall();
      spawnParticles(b.x, botWall() - 2, '#8899bb', 6, 120);
      ripple(b.x, botWall(), '#8899bb', 34, 2);
    }

    // bumpers (ROYALE)
    for (const bp of state.bumpers) {
      const dx = b.x - bp.x, dy = b.y - bp.y;
      const rr = bp.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 < rr * rr && d2 > 0.0001) {
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d;
        b.x = bp.x + nx * rr;
        b.y = bp.y + ny * rr;
        const dot = b.vx * nx + b.vy * ny;
        if (dot < 0) { b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny; }
        // bumper kick, capped at max speed
        b.vx *= 1.06; b.vy *= 1.06;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > speedCap()) { b.vx *= speedCap() / sp; b.vy *= speedCap() / sp; }
        bp.pulse = 1;
        beep(620 + Math.random() * 120, 0.05, 'triangle', 0.12);
        spawnParticles(b.x, b.y, '#d9a441', 8, 180);
      }
    }

    // Swept collision. A fast ball can cross the paddle plane entirely within
    // one frame, so test the whole path it traveled this frame, and evaluate
    // the vertical overlap at the moment it crossed the plane rather than at
    // its post-move position (a fast diagonal otherwise slips past).
    const stepX = b.vx * slow * dt, stepY = b.vy * slow * dt;
    const prevX = b.x - stepX, prevY = b.y - stepY;
    const crossY = (plane) => {
      if (stepX === 0) return b.y;
      const t = clamp((plane - prevX) / stepX, 0, 1);
      return prevY + stepY * t;
    };

    const aiPlane = ai.x + PADDLE_W + b.r;
    const aiY = crossY(aiPlane);
    if (b.vx < 0 &&
        b.x - b.r <= ai.x + PADDLE_W &&
        prevX - b.r >= ai.x - 18 &&
        ((aiY >= ai.y - b.r && aiY <= ai.y + ai.h + b.r) ||
         (b.y >= ai.y - b.r && b.y <= ai.y + ai.h + b.r))) {
      b.x = ai.x + PADDLE_W + b.r;
      if (state.chargeWindow > 0 && ai.catchT > 0 && b.catchCD <= 0 && !paddleHolds('ai')) {
        catchBall(b, ai, 'ai');
        popup(b.x + 24, b.y, 'CAUGHT!', '#e3c15a', 11);
      } else {
        paddleBounce(b, ai, false);
      }
    }

    // player paddle (right) - same swept test
    const pPlane = player.x - b.r;
    const pY = crossY(pPlane);
    if (b.vx > 0 &&
        b.x + b.r >= player.x &&
        prevX + b.r <= player.x + PADDLE_W + 18 &&
        ((pY >= player.y - b.r && pY <= player.y + player.h + b.r) ||
         (b.y >= player.y - b.r && b.y <= player.y + player.h + b.r))) {
      b.x = player.x - b.r;
      if (state.chargeWindow > 0 && player.catchT > 0 && b.catchCD <= 0 && !paddleHolds('player')) {
        catchBall(b, player, 'player');
        popup(b.x - 24, b.y, 'CAUGHT!', '#e3c15a', 11);
      } else {
        paddleBounce(b, player, true);
      }
    }

    // ghost paddles (power-up) - same physics, in-field of the mains
    if (ghostL.timer > 0 &&
        b.vx < 0 &&
        b.x - b.r <= ghostL.x + PADDLE_W &&
        b.x - b.r >= ghostL.x - 14 &&
        b.y >= ghostL.y - b.r &&
        b.y <= ghostL.y + ghostL.h + b.r) {
      b.x = ghostL.x + PADDLE_W + b.r;
      paddleBounce(b, ghostL, false);
    }
    if (ghostR.timer > 0 &&
        b.vx > 0 &&
        b.x + b.r >= ghostR.x &&
        b.x + b.r <= ghostR.x + PADDLE_W + 14 &&
        b.y >= ghostR.y - b.r &&
        b.y <= ghostR.y + ghostR.h + b.r) {
      b.x = ghostR.x - b.r;
      paddleBounce(b, ghostR, true);
    }

    // power-up pickup
    for (let pi = powerups.length - 1; pi >= 0; pi--) {
      const pu = powerups[pi];
      const dx = b.x - pu.x, dy = b.y - pu.y;
      if (dx * dx + dy * dy < (POWERUP_R + b.r) ** 2) {
        powerups.splice(pi, 1);
        applyPowerup(pu, b);
      }
    }

    // portals teleport the ball (keeps velocity, brief re-entry cooldown)
    if (state.portals && b.portalCD <= 0) {
      for (const [from, to] of [[state.portals.a, state.portals.b], [state.portals.b, state.portals.a]]) {
        const dx = b.x - from.x, dy = b.y - from.y;
        if (dx * dx + dy * dy < PORTAL_R * PORTAL_R) {
          spawnParticles(b.x, b.y, '#4fb59b', 12, 220);
          ripple(from.x, from.y, '#4fb59b', 46, 3);
          ripple(to.x, to.y, '#4fb59b', 46, 3);
          b.x = to.x; b.y = to.y;
          b.portalCD = 0.5;
          beep(1040, 0.08, 'sine', 0.14);
          spawnParticles(b.x, b.y, '#4fb59b', 12, 220);
          break;
        }
      }
    }
    if (b.portalCD > 0) b.portalCD -= dt;

    // scoring - off LEFT edge: player scores; off RIGHT edge: AI scores
    let scored = null;
    if (b.x < -BALL_R * 3) scored = 'player';
    else if (b.x > W + BALL_R * 3) scored = 'ai';
    if (scored) {
      // goal shockwave at the point of exit
      ripple(scored === 'player' ? 4 : W - 4, b.y,
             scored === 'player' ? theme.right.base : theme.left.base, 110, 5);
      const over = score(scored, b.y, ballValue(b));
      if (over) return;
      balls.splice(bi, 1);
      if (balls.length === 0) {
        if (state.gameMode === 'ffa') {
          replenishBalls(scored === 'player' ? -1 : 1); // loser gets first touch
        } else {
          // PONG rules: the side that got scored on receives the serve
          // and makes the first hit. Player scored -> serve left to the AI;
          // AI scored -> serve right to the player.
          serve(scored === 'player' ? -1 : 1);
          return;
        }
      }
    }
  }
}

