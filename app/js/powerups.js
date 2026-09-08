'use strict';

/* ============================================================
   Power-ups
   ============================================================ */
function spawnPowerup() {
  // Difficulty controls the normal pool. Ball Storm is a mode mechanic,
  // reserved for Chaos and Royale rather than unlocked by difficulty.
  let pool = Object.keys(POWERUP_TYPES).filter(t =>
    // Custom's toggles always win. Ball Storm remains exclusive to Chaos/Royale.
    (t !== 'mega' && cfg().powerups?.[t]) ||
    (t === 'mega' && mode().mega && (!isCustom() || cfg().powerups?.mega)));
  if (state.flipTimer > 0) pool = pool.filter(t => t !== 'flip');
  // hearts ride their own dedicated timer (see updatePowerups), never this pool
  pool = pool.filter(t => t !== 'heart');
  // don't spawn ball adders if already at cap
  if (balls.length >= mode().maxBalls) pool = pool.filter(t => t !== 'multi' && t !== 'mega');
  if (pool.length === 0) return; // everything disabled
  const type = pool[Math.floor(Math.random() * pool.length)];
  const x = W * 0.32 + Math.random() * W * 0.36;
  const y = topWall() + 60 + Math.random() * (botWall() - topWall() - 120);
  powerups.push({ type, x, y, life: 10, born: performance.now(), spawnT: state.fieldTime });
  debugLog('powerups', `SPAWN ${POWERUP_TYPES[type].name}`, { type, x: Math.round(x), y: Math.round(y) });
}

function applyPowerup(pu, b) {
  // effect belongs to whoever last touched the ball
  const owner = b.lastHit || (b.vx > 0 ? 'ai' : 'player');
  debugLog('powerups', `${debugParticipant(owner)} CLAIMS ${POWERUP_TYPES[pu.type].name}`, {
    type: pu.type, balls: balls.length,
  });
  const self = owner === 'player' ? player : ai;
  const foe  = owner === 'player' ? ai : player;
  const t = POWERUP_TYPES[pu.type];

  switch (pu.type) {
    case 'flip':
      if (state.flipTimer <= 0) {
        state.flipPending = true;
        state.flipTimer = 3;
        popup(W / 2, H / 2, 'SWAP IN 3', '#ff9ee8', 18);
        sfx.count();
      }
      break;
    case 'heart':
      // any ball touching a heart heals YOU — no stealing, no denial
      if (state.lives < SURVIVAL_LIVES) {
        state.lives++;
        popup(pu.x, pu.y - 24, '+1 LIFE!', '#ff4f9a', 16);
        sfx.life();
      }
      break;
    case 'grow':   self.growT = EFFECT_DURATION; break;
    case 'shrink': foe.shrinkT = EFFECT_DURATION; break;
    case 'slow':   state.slowTimer = SLOW_DURATION; break;
    case 'charge':
      state.chargeWindow = CHARGE_WINDOW;
      player.smashT = ai.smashT = 0;
      popup(pu.x, pu.y - 24, 'CATCH ZONE!', '#ffe14d', 14);
      beep(392, 0.08, 'sine', 0.12);
      setTimeout(() => beep(523, 0.08, 'sine', 0.12), 90);
      setTimeout(() => beep(659, 0.12, 'sine', 0.12), 180);
      break;
    case 'ghost': {
      // whoever claimed it gets an AI helper paddle on their side
      const gh = owner === 'player' ? ghostR : ghostL;
      gh.timer = GHOST_DURATION;
      gh.y = clamp(pu.y - gh.h / 2, topWall(), botWall() - gh.h);
      gh.vy = 0;
      gh.watching = null;
      popup(pu.x, pu.y - 24, 'GHOST!', '#9aecff', 14);
      break;
    }
    case 'multi':
      if (balls.length < mode().maxBalls) {
        const nb = makeBall(pu.x, pu.y, owner === 'player' ? -1 : 1, Math.max(baseBallSpeed(), b.speed * 0.85));
        nb.lastHit = owner;
        balls.push(nb);
      }
      break;
    case 'mega': {
      // BALL STORM: +7 balls radiating out from the pickup
      const spd = Math.max(baseBallSpeed(), b.speed * 0.8);
      for (let i = 0; i < 7 && balls.length < HARD_BALL_CAP; i++) {
        const a = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
        const nb = makeBall(pu.x, pu.y, 1, spd);
        nb.vx = Math.cos(a) * spd;
        nb.vy = Math.sin(a) * spd;
        if (Math.abs(nb.vx) < spd * 0.35) nb.vx = Math.sign(nb.vx || 1) * spd * 0.35; // no near-vertical dud balls
        nb.lastHit = owner;
        balls.push(nb);
      }
      state.shake = 14;
      state.flash = 0.12;
      beep(220, 0.2, 'sawtooth', 0.14);
      setTimeout(() => beep(440, 0.15, 'sawtooth', 0.12), 120);
      break;
    }
  }
  sfx.power();
  // One restrained ring makes a claim legible without another screen flash.
  ripple(pu.x, pu.y, t.color, 44, 2);
  spawnParticles(pu.x, pu.y, t.color, 22, 300);
}

function updatePowerups(dt) {
  state.spawnTimer -= dt;
  if (state.spawnTimer <= 0 && powerups.length < mode().puCap) {
    spawnPowerup();
    state.spawnTimer = mode().spawnMin + Math.random() * mode().spawnVar;
  }
  for (let i = powerups.length - 1; i >= 0; i--) {
    powerups[i].life -= dt;
    if (powerups[i].life <= 0) powerups.splice(i, 1);
  }
  // survival mercy: while hurt, a heart is guaranteed every ~6-9s.
  // Hearts bypass the regular spawn cap — they're a lifeline, not a treat.
  if (state.gameMode === 'survival' && state.lives < SURVIVAL_LIVES &&
      !powerups.some(p => p.type === 'heart')) {
    state.heartTimer -= dt;
    if (state.heartTimer <= 0) {
      state.heartTimer = 6 + Math.random() * 3;
      powerups.push({
        type: 'heart',
        x: W * 0.32 + Math.random() * W * 0.36,
        y: topWall() + 60 + Math.random() * (botWall() - topWall() - 120),
        life: 12,
        born: performance.now(),
        spawnT: state.fieldTime,
      });
      beep(660, 0.08, 'sine', 0.1);
      setTimeout(() => beep(880, 0.1, 'sine', 0.1), 100);
    }
  }
  if (state.slowTimer > 0) state.slowTimer -= dt;
  if (state.chargeWindow > 0) {
    state.chargeWindow -= dt;
    // window closes: any held ball is released as-is
    if (state.chargeWindow <= 0) for (const b of balls) if (b.heldBy) releaseBall(b);
  }
  for (const p of [player, ai]) {
    if (p.growT > 0) p.growT -= dt;
    if (p.shrinkT > 0) p.shrinkT -= dt;
  }
}

