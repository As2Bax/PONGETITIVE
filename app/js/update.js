'use strict';

/* ============================================================
   Update loop
   ============================================================ */
let lastTime = 0;
let countdownTimer = 0;

// visual effects tick in every mode (countdown, pause, game over) so they never freeze
function updateVfx(dt) {
  scorePop.player = Math.max(0, scorePop.player - dt * 1.6);
  scorePop.ai = Math.max(0, scorePop.ai - dt * 1.6);
  timerPop = Math.max(0, timerPop - dt * 4); // fast snap-back
  state.comboPunch = Math.max(0, state.comboPunch - dt * 5.5);
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    r.life -= dt * 2.2;
    r.r += (r.maxR - r.r) * Math.min(1, 8 * dt);
    if (r.life <= 0) ripples.splice(i, 1);
  }
  for (const p of [player, ai, ghostL, ghostR]) {
    if (p.hitFlash > 0) p.hitFlash = Math.max(0, p.hitFlash - dt * 5);
  }
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    p.life -= dt;
    p.y -= 30 * dt;
    if (p.life <= 0) popups.splice(i, 1);
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.94;
    p.vy *= 0.94;
  }
}

function updateFlip(dt) {
  if (state.flipTimer <= 0) return;
  const before = Math.ceil(state.flipTimer);
  state.flipTimer = Math.max(0, state.flipTimer - dt);
  const remaining = Math.ceil(state.flipTimer);
  if (remaining > 0 && remaining <= 3 && remaining < before) {
    popup(W / 2, H / 2, `${state.flipPending ? 'SWAP' : 'SWAP BACK'} IN ${remaining}`, '#ff9ee8', 18);
    sfx.count();
  }
  if (state.flipTimer === 0) {
    state.flipped = state.flipPending;
    state.flipPending = false;
    state.flipTimer = state.flipped ? 10 : 0;
    // Re-map the stationary cursor when the arena changes sides.
    if (mouseCX >= 0) mouseCX = W - mouseCX;
    popup(W / 2, H / 2, state.flipped ? 'SIDES SWAPPED!' : 'SIDES RESTORED!', '#ff9ee8', 18);
    sfx.go();
  }
}

function update(dt) {
  updateVfx(dt);
  // Keep field effects alive through the pre-game countdown, but freeze their
  // animation clock everywhere else (including the pause/menu overlays).
  if (state.mode === 'play' || state.mode === 'countdown') state.fieldTime += dt;

  // Guests never simulate the match: they predict their own paddle, smooth the
  // host's snapshots, and forward input.
  if (isNetGuest()) {
    if (state.mode === 'play' || state.mode === 'countdown') {
      netPredictLocalPaddle(dt);
      netInterpolate(dt);
      // Run presentation timers locally so HUD badges, the countdown pop and
      // field-event visuals animate every frame instead of only on packets.
      countdownTimer += dt;
      if (state.timeLeft > 0 && mode().timed && state.mode === 'play') state.timeLeft -= dt;
      if (state.slowTimer > 0) state.slowTimer -= dt;
      if (state.chargeWindow > 0) state.chargeWindow -= dt;
      if (state.windLife > 0) state.windLife -= dt;
      if (state.well) state.well.life -= dt;
      if (state.portals) state.portals.life -= dt;
      for (const p of [player, ai]) {
        if (p.growT > 0) p.growT -= dt;
        if (p.shrinkT > 0) p.shrinkT -= dt;
      }
      for (const gh of [ghostL, ghostR]) if (gh.timer > 0) gh.timer -= dt;
      for (const pu of powerups) pu.life -= dt;
    }
    netSendInput(dt);
    return;
  }

  if (state.mode === 'play') {
    updateFlip(dt);
  }

  if (state.mode === 'countdown') {
    if (isAivai()) runBrain(player, 1, brainFor(aiBrains.right), dt); else updatePlayer(dt);
    if (isNetHost()) netDriveRemotePaddle(dt); else updateAI(dt);
    if (isNetHost()) netSendSnapshot(dt);
    countdownTimer += dt;
    if (countdownTimer >= 1) {
      countdownTimer = 0;
      state.countdown--;
      if (state.countdown <= 0) {
        state.mode = 'play';
        sfx.go();
      } else {
        sfx.count();
      }
    }
    return;
  }

  // The match is over: simulation stops, but the guest still needs to be told,
  // otherwise its screen freezes on the last play frame with no result.
  if (state.mode === 'over') {
    // Force the first frame through so the result isn't delayed by throttling,
    // then keep ticking normally so a dropped packet can't strand the guest.
    if (isNetHost()) {
      netSendSnapshot(dt, !net.sentGameOver);
      net.sentGameOver = true;
    }
    return;
  }

  if (state.mode !== 'play') return;

  // Both untimed modes track elapsed time; only Survival turns that time into waves.
  if (state.gameMode === 'survival' || state.gameMode === 'endless') {
    state.survivalTime += dt;
    // survival waves: every WAVE_EVERY seconds the arena turns up the heat
    if (mode().waves) {
      const wave = Math.floor(state.survivalTime / WAVE_EVERY) + 1;
      if (wave > state.wave) {
        state.wave = wave;
        popup(W / 2, H / 2 - 40, `WAVE ${wave}`, '#ffd950', 22);
        state.flash = 0.15;
        beep(392, 0.12, 'square', 0.12);
        setTimeout(() => beep(523, 0.15, 'square', 0.12), 130);
        // every wave throws another simultaneous ball into the assault
        if (balls.length < mode().maxBalls) {
          const nb = makeBall(W / 2, (topWall() + botWall()) / 2, -1);
          balls.push(nb);
          spawnParticles(nb.x, nb.y, '#ffd950', 16, 260);
        }
        // waves 3+: bumpers start appearing (drifting, up to a cap)
        if (wave >= 3 && state.bumpers.length < WAVE_MAX_BUMPERS) {
          state.bumpers.push({
            x: W * (0.3 + 0.4 * Math.random()),
            y: H * (0.3 + 0.4 * Math.random()),
            r: 16 + Math.random() * 12,
            vx: (Math.random() < 0.5 ? -1 : 1) * (25 + Math.random() * 40),
            vy: (Math.random() < 0.5 ? -1 : 1) * (35 + Math.random() * 50),
            pulse: 1,
          });
        }
      }
    }
  } else if (mode().timed && !state.suddenDeath) {
    const before = Math.ceil(state.timeLeft);
    state.timeLeft -= dt;
    const after = Math.ceil(state.timeLeft);
    // countdown beeps for the final 10 seconds: steady tick from 10→5,
    // then rising pitch each second below 5. Each beep also pops the timer.
    if (after < before && after <= 10 && after > 0 && state.mode === 'play') {
      timerPop = 1;
      if (after < 5) {
        const steps = 5 - after; // 1..4
        beep(660 * Math.pow(2, steps * 3 / 12), 0.09, 'square', 0.12);
      } else {
        beep(660, 0.06, 'square', 0.09);
      }
    }
    if (state.timeLeft <= 0) {
      state.timeLeft = 0;
      if (state.scores.player === state.scores.ai) {
        state.suddenDeath = true;
        state.flash = 0.25;
        serve(Math.random() < 0.5 ? 1 : -1);
        return;
      }
      endMatch();
      return;
    }
  }

  // ROYALE (or the BARRIER curse): the arena walls close in — and BREATHE.
  // Each wall moves on its own rhythm and the safe corridor WANDERS, so the
  // squeeze isn't a predictable pinch toward the centre line every time.
  if (zoneActive()) {
    state.zoneT += dt;
    const t = state.zoneT;
    const ramp = Math.min(t / 5, 1); // motion fades in over the first seconds
    const maxHalf = (H - ZONE_MIN_H) / 2;
    const closing = Math.min(ZONE_RATE * t, maxHalf);
    // layered sines at unrelated frequencies = non-repeating wall rhythms
    const topBreathe = (Math.sin(t * 1.2) * 0.7 + Math.sin(t * 0.53 + 1.7) * 0.3) * ZONE_BREATHE * ramp;
    const botBreathe = (Math.sin(t * 0.9 + 4.2) * 0.7 + Math.sin(t * 0.71 + 0.6) * 0.3) * ZONE_BREATHE * ramp;
    // the corridor itself slowly drifts up and down the arena
    const drift = Math.sin(t * 0.35 + 2.1) * ZONE_DRIFT * ramp;
    let top = clamp(closing + topBreathe + drift, 0, H - ZONE_MIN_H);
    let bottom = clamp(H - (closing + botBreathe - drift), ZONE_MIN_H, H);
    // never let the corridor collapse below the guaranteed safe height
    if (bottom - top < ZONE_MIN_H) {
      const mid = (top + bottom) / 2;
      top = clamp(mid - ZONE_MIN_H / 2, 0, H - ZONE_MIN_H);
      bottom = top + ZONE_MIN_H;
    }
    state.zoneTop = top;
    state.zoneBottom = bottom;
  }

  // ball rain: Chaos/Royale keep pumping extra balls into play
  if (mode().rain) {
    state.rainTimer -= dt;
    if (state.rainTimer <= 0) {
      state.rainTimer = mode().rain;
      if (balls.length < mode().maxBalls) {
        const nb = makeBall(W / 2, (topWall() + botWall()) / 2, Math.random() < 0.5 ? 1 : -1);
        balls.push(nb);
        beep(880, 0.08, 'triangle', 0.12);
        spawnParticles(nb.x, nb.y, '#ffffff', 16, 260);
      }
    }
  }

  // moving bumpers drift and bounce inside the zone
  for (const bp of state.bumpers) {
    if (!bp.vx && !bp.vy) continue;
    bp.x += bp.vx * dt;
    bp.y += bp.vy * dt;
    if (bp.x - bp.r < W * 0.22) { bp.x = W * 0.22 + bp.r; bp.vx = Math.abs(bp.vx); }
    if (bp.x + bp.r > W * 0.78) { bp.x = W * 0.78 - bp.r; bp.vx = -Math.abs(bp.vx); }
    if (bp.y - bp.r < topWall()) { bp.y = topWall() + bp.r; bp.vy = Math.abs(bp.vy); }
    if (bp.y + bp.r > botWall()) { bp.y = botWall() - bp.r; bp.vy = -Math.abs(bp.vy); }
  }

  // IMPOSSIBLE: periodic control-inversion curse (only when a human is on the right)
  if (cfg().inverted && !isAivai()) {
    if (state.invertT > 0) {
      state.invertT -= dt;
    } else {
      state.invertTimer -= dt;
      if (state.invertTimer <= 0) {
        state.invertTimer = cfg().inverted * (0.7 + Math.random() * 0.6);
        state.invertT = INVERT_DURATION;
        popup(player.x - 60, player.y + player.h / 2, 'INVERTED!', '#ff5a5a', 14);
        beep(196, 0.15, 'sawtooth', 0.14);
      }
    }
  }

  // timed action windows
  for (const p of [player, ai]) {
    if (p.smashT > 0) p.smashT -= dt;
    if (p.smashCD > 0) p.smashCD -= dt;
  }
  // AI instinctively smashes sometimes when a ball is close and incoming.
  // In PvP the left paddle is the remote human, so it must never be automated.
  for (const [pad, facing, isBot] of [[ai, -1, !isPvp()], [player, 1, isAivai()]]) {
    pad.catchT = Math.max(0, (pad.catchT || 0) - dt);
    if (!isBot) continue;
    const t = nearestThreat(pad, facing);
    if (state.chargeWindow > 0) {
      // One virtual click per incoming threat, not a permanently refreshed
      // catch window. Imperfect timing can expire before contact or arrive late.
      if (pad.catchThreat !== t) {
        pad.catchThreat = t;
        pad.catchAttempted = false;
        // ruthless bots click at the perfect moment, every time
        pad.catchLead = cfg().aiPerfect ? CATCH_WINDOW * 0.9 : 0.08 + Math.random() * 0.55;
      }
      if (t && !pad.catchAttempted && pad.catchT <= 0 && t.catchCD <= 0) {
        const plane = facing < 0 ? pad.x + PADDLE_W + t.r : pad.x - t.r;
        const eta = (plane - t.x) / t.vx;
        if (eta >= 0 && eta <= pad.catchLead) {
          pad.catchAttempted = true;
          if (cfg().aiPerfect || Math.random() < 0.85) pad.catchT = CATCH_WINDOW;
        }
      }
      continue;
    }
    if (pad.smashCD > 0 || pad.smashT > 0) continue;
    // ruthless bots smash every return the moment the cooldown allows;
    // human-ish bots only sometimes trust their instincts
    const smashChance = cfg().aiPerfect ? 1 : cfg().aiSharp ? 0.5 : AI_SMASH_CHANCE;
    if (t && Math.abs(t.x - pad.x) < 150 && Math.random() < smashChance) pad.smashT = SMASH_WINDOW;
  }

  const eventOn = (key) => Boolean(cfg().events?.[key]);

  // portals: appear periodically, live for a while, then vanish
  if (state.portals) {
    state.portals.life -= dt;
    if (state.portals.life <= 0) state.portals = null;
  } else if (eventOn('portals')) {
    state.portalTimer -= dt;
    if (state.portalTimer <= 0) {
      state.portalTimer = PORTAL_EVERY * (0.8 + Math.random() * 0.5);
      const py = () => topWall() + 60 + Math.random() * (botWall() - topWall() - 120);
      state.portals = {
        a: { x: W * (0.2 + Math.random() * 0.15), y: py() },
        b: { x: W * (0.65 + Math.random() * 0.15), y: py() },
        life: PORTAL_LIFE,
        spawnT: state.fieldTime,
      };
      debugLog('events', 'PORTALS OPEN', {
        a: { x: Math.round(state.portals.a.x), y: Math.round(state.portals.a.y) },
        b: { x: Math.round(state.portals.b.x), y: Math.round(state.portals.b.y) },
      });
      beep(880, 0.1, 'sine', 0.1);
      setTimeout(() => beep(1175, 0.1, 'sine', 0.1), 100);
    }
  }

  // gravity well: a vortex that bends every ball's path toward it
  if (state.well) {
    state.well.life -= dt;
    if (state.well.life <= 0) state.well = null;
  } else if (eventOn('well')) {
    state.wellTimer -= dt;
    if (state.wellTimer <= 0) {
      state.wellTimer = WELL_EVERY * (0.8 + Math.random() * 0.5);
      state.well = {
        x: W * (0.3 + Math.random() * 0.4),
        y: topWall() + 80 + Math.random() * (botWall() - topWall() - 160),
        life: WELL_LIFE,
      };
      debugLog('events', 'GRAVITY WELL FORMS', { x: Math.round(state.well.x), y: Math.round(state.well.y) });
      popup(state.well.x, state.well.y - WELL_R * 0.5, 'GRAVITY WELL', '#c46bff', 12);
      beep(140, 0.3, 'sine', 0.12);
    }
  }

  // wind gust: steady vertical push on all balls, telegraphed by streaks
  if (state.windLife > 0) {
    state.windLife -= dt;
    if (state.windLife <= 0) state.wind = 0;
  } else if (eventOn('wind')) {
    state.windTimer -= dt;
    if (state.windTimer <= 0) {
      state.windTimer = WIND_EVERY * (0.8 + Math.random() * 0.5);
      state.wind = (Math.random() < 0.5 ? -1 : 1) * WIND_FORCE * (0.7 + Math.random() * 0.6);
      state.windLife = WIND_LIFE;
      state.windSpawnT = state.fieldTime;
      debugLog('events', `WIND ${state.wind > 0 ? 'DOWN' : 'UP'}`, { force: Math.round(Math.abs(state.wind)), life: WIND_LIFE });
      popup(W / 2, H / 2 - 80, state.wind > 0 ? 'WIND ▼' : 'WIND ▲', '#9fd8ff', 13);
      beep(300, 0.4, 'sine', 0.07);
    }
  }

  if (isAivai()) runBrain(player, 1, brainFor(aiBrains.right), dt); else updatePlayer(dt);
  if (isNetHost()) netDriveRemotePaddle(dt); else updateAI(dt);
  for (const [gh, facing] of [[ghostL, -1], [ghostR, 1]]) {
    if (gh.timer > 0) {
      gh.timer -= dt;
      runBrain(gh, facing, ghostBrain, dt);
      if (gh.timer <= 0) spawnParticles(gh.x + PADDLE_W / 2, gh.y + gh.h / 2, '#9aecff', 14, 200);
    }
  }
  updatePowerups(dt);
  updateBalls(dt);
  if (isNetHost()) netSendSnapshot(dt);
}

