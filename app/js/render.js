'use strict';

/* ============================================================
   Rendering
   ============================================================ */
function ballAlpha(b) {
  const fog = cfg().fog;
  if (!fog || isAivai()) return 1; // spectators get to see everything
  const f = (b.x / W - fog.start) / (fog.end - fog.start);
  return clamp(1 - f, 0, 1);
}

// Keep all canvas labels readable when FLIP mirrors the arena. Geometry and
// text anchors swap sides; glyphs themselves must never be mirrored.
const nativeFillText = ctx.fillText.bind(ctx);
ctx.fillText = function (text, x, y, maxWidth) {
  const transform = ctx.getTransform();
  const mirrored = transform.a * transform.d - transform.b * transform.c < 0;
  if (mirrored) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(-1, 1);
    const align = ctx.textAlign;
    if (align === 'left' || align === 'start') ctx.textAlign = 'right';
    else if (align === 'right' || align === 'end') ctx.textAlign = 'left';
    if (maxWidth === undefined) nativeFillText(text, 0, 0);
    else nativeFillText(text, 0, 0, maxWidth);
    ctx.restore();
  } else if (maxWidth === undefined) nativeFillText(text, x, y);
  else nativeFillText(text, x, y, maxWidth);
};

function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.save();
  // Mirror the arena, not ownership: scores, bots, catches and controls stay
  // attached to their original side while the entire field swaps visually.
  if (state.flipped && state.mode !== 'menu') {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }

  // screen shake
  if (state.shake > 0) {
    ctx.translate((Math.random() - 0.5) * state.shake, (Math.random() - 0.5) * state.shake);
    state.shake *= 0.86;
    if (state.shake < 0.4) state.shake = 0;
  }

  // background
  ctx.fillStyle = '#0b0e18';
  ctx.fillRect(-W, -H, W * 3, H * 3);

  // subtle vignette grid
  ctx.strokeStyle = 'rgba(40, 55, 90, 0.12)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= W; gx += 45) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke();
  }
  for (let gy = 0; gy <= H; gy += 45) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
  }

  // twinkling starfield
  const now = performance.now() / 1000;
  for (const s of stars) {
    const tw = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(now * s.speed + s.phase));
    ctx.fillStyle = `rgba(160, 190, 240, ${tw * 0.35})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // goal glow zones — each side tinted in its owner's colour
  let g = ctx.createLinearGradient(0, 0, 70, 0);
  g.addColorStop(0, 'rgba(255, 79, 154, 0.10)');
  g.addColorStop(1, 'rgba(255, 79, 154, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 70, H);
  g = ctx.createLinearGradient(W - 70, 0, W, 0);
  g.addColorStop(0, 'rgba(53, 224, 255, 0)');
  g.addColorStop(1, 'rgba(53, 224, 255, 0.10)');
  ctx.fillStyle = g;
  ctx.fillRect(W - 70, 0, 70, H);

  // centre circle + face-off dot (hockey-rink style)
  ctx.strokeStyle = 'rgba(120, 150, 200, 0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 70, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(120, 150, 200, 0.25)';
  ctx.fill();

  // corner brackets — top corners only; the bottom corners belong to the
  // effect badges, which the frames were colliding with
  ctx.strokeStyle = 'rgba(120, 150, 200, 0.3)';
  ctx.lineWidth = 3;
  const cb = 26, ci = 12;
  for (const [cx, cy, sx, sy] of [[ci, ci, 1, 1], [W - ci, ci, -1, 1]]) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + cb * sy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + cb * sx, cy);
    ctx.stroke();
  }

  // fog zone (insane) — visual hint of where the ball disappears
  if (cfg().fog && !isAivai() && state.mode !== 'menu') {
    const fog = cfg().fog;
    const grad = ctx.createLinearGradient(W * fog.start, 0, W * fog.end, 0);
    grad.addColorStop(0, 'rgba(20, 24, 40, 0)');
    grad.addColorStop(1, 'rgba(20, 24, 40, 0.72)');
    ctx.fillStyle = grad;
    ctx.fillRect(W * fog.start, 0, W - W * fog.start, H);
  }

  // ROYALE / barrier-curse zone walls
  if (zoneActive() && state.mode !== 'menu') {
    ctx.fillStyle = 'rgba(255, 90, 90, 0.08)';
    ctx.fillRect(0, 0, W, topWall());
    ctx.fillRect(0, botWall(), W, H - botWall());
    ctx.strokeStyle = 'rgba(255, 90, 90, 0.7)';
    ctx.shadowColor = '#ff5a5a';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, topWall()); ctx.lineTo(W, topWall()); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, botWall()); ctx.lineTo(W, botWall()); ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // centre line
  ctx.strokeStyle = 'rgba(120, 150, 200, 0.25)';
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 16]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 10);
  ctx.lineTo(W / 2, H - 10);
  ctx.stroke();
  ctx.setLineDash([]);

  // ===== SCOREBOARD — drawn early, under the action, so play stays visible =====
  ctx.textAlign = 'center';
  {
    // scores pop when someone scores: scale up + brighten, ease back.
    // Big scores shrink and shift outward so they never crowd the timer.
    const drawScore = (value, side, popAmt, color, glow) => {
      const digits = String(value).length;
      const fontSize = digits <= 2 ? 64 : digits === 3 ? 46 : 36;
      const offset = 165 + Math.max(0, digits - 2) * 26; // clear of the centre timer
      const x = W / 2 + side * offset;
      const s = 1 + popAmt * popAmt * 0.55; // ease-in pop
      ctx.save();
      ctx.translate(x, 92);
      ctx.scale(s, s);
      ctx.font = `${fontSize}px "Press Start 2P", monospace`;
      ctx.fillStyle = popAmt > 0.4 ? '#ffffff' : color;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 18 + popAmt * 30;
      ctx.fillText(value, 0, 0);
      ctx.restore();
      ctx.shadowBlur = 0;
      return x; // so the label follows
    };

    if (state.gameMode === 'survival') {
      // hearts on the left
      ctx.font = '28px monospace';
      ctx.fillStyle = 'rgba(255, 79, 154, 0.9)';
      ctx.shadowColor = '#ff4f9a';
      ctx.shadowBlur = 12;
      let hearts = '';
      for (let i = 0; i < SURVIVAL_LIVES; i++) hearts += i < state.lives ? '\u2665 ' : '\u2661 ';
      ctx.fillText(hearts.trim(), W / 2 - 165, 84);
      ctx.shadowBlur = 0;
    }
    let leftX = W / 2 - 165;
    if (state.gameMode !== 'survival') {
      leftX = drawScore(state.scores.ai, -1, scorePop.ai, 'rgba(255, 79, 154, 0.85)', '#ff4f9a');
    }
    const rightX = drawScore(state.scores.player, 1, scorePop.player, 'rgba(53, 224, 255, 0.85)', '#35e0ff');

    // labels (track the score positions)
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.fillStyle = 'rgba(120, 140, 175, 0.5)';
    ctx.fillText(state.gameMode === 'survival' ? 'LIVES' : foeName(), leftX, 120);
    ctx.fillText(isAivai() ? 'CYAN' : 'YOU', rightX, 120);
  }

  // top-centre HUD: timer / target / survival clock
  ctx.font = '20px "Press Start 2P", monospace';
  if (state.suddenDeath) {
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 120);
    ctx.fillStyle = `rgba(255, 220, 80, ${pulse})`;
    ctx.shadowColor = '#ffdc50';
    ctx.shadowBlur = 14;
    ctx.fillText('SUDDEN DEATH', W / 2, 40);
  } else if (state.gameMode === 'survival' || state.gameMode === 'endless') {
    const t = Math.floor(state.survivalTime);
    const m = Math.floor(t / 60);
    const s = String(t % 60).padStart(2, '0');
    ctx.fillStyle = 'rgba(255, 217, 80, 0.9)';
    ctx.fillText(`${m}:${s}`, W / 2, 40);
    if (state.gameMode === 'survival') {
      ctx.font = '9px "Press Start 2P", monospace';
      const untilNext = WAVE_EVERY - (state.survivalTime % WAVE_EVERY);
      ctx.fillStyle = untilNext < 5
        ? `rgba(255, 143, 106, ${0.5 + 0.5 * Math.sin(performance.now() / 150)})`
        : 'rgba(255, 217, 80, 0.6)';
      ctx.fillText(`WAVE ${state.wave}`, W / 2, 58);
    }
  } else {
    const t = Math.ceil(state.timeLeft);
    const m = Math.floor(t / 60);
    const s = String(t % 60).padStart(2, '0');
    const low = state.timeLeft <= 10;
    ctx.fillStyle = low ? `rgba(255, 90, 90, ${0.6 + 0.4 * Math.sin(performance.now() / 150)})` : 'rgba(230, 240, 255, 0.9)';
    if (low) { ctx.shadowColor = '#ff5a5a'; ctx.shadowBlur = 12 + timerPop * 20; }
    if (timerPop > 0) {
      // punchy pop on every countdown tick — scales up hard, snaps back
      ctx.save();
      ctx.translate(W / 2, 33);
      ctx.scale(1 + timerPop * 0.6, 1 + timerPop * 0.6);
      ctx.fillText(`${m}:${s}`, 0, 7);
      ctx.restore();
    } else {
      ctx.fillText(`${m}:${s}`, W / 2, 40);
    }
  }
  ctx.shadowBlur = 0;


  // slow-mo tint
  if (state.slowTimer > 0 && state.mode === 'play') {
    ctx.fillStyle = `rgba(176, 107, 255, ${0.05 + 0.03 * Math.sin(performance.now() / 180)})`;
    ctx.fillRect(-20, -20, W + 40, H + 40);
  }

  // effect indicator badges — under the action so they never cover play
  // corners = personal effects; bottom-centre = GLOBAL effects (affect everyone)
  {
    hoveredBadge = null; // recomputed by drawBadge hover checks below
    // AI/left personal effects
    let lx = 22;
    for (const [icon, timer, maxT, color] of [
      ['grow',   ai.growT,     EFFECT_DURATION, '#4dff88'],
      ['shrink', ai.shrinkT,   EFFECT_DURATION, '#ff5a5a'],
      ['ghost',  ghostL.timer, GHOST_DURATION,  '#9aecff'],
    ]) {
      if (timer > 0) { drawBadge(lx, H - 40, color, icon, Math.ceil(timer), timer / maxT); lx += 66; }
    }

    // player/right personal effects
    let rx = W - 80;
    for (const [icon, timer, maxT, color] of [
      ['grow',   player.growT,   EFFECT_DURATION, '#4dff88'],
      ['shrink', player.shrinkT, EFFECT_DURATION, '#ff5a5a'],
      ['ghost',  ghostR.timer,   GHOST_DURATION,  '#9aecff'],
    ]) {
      if (timer > 0) { drawBadge(rx, H - 40, color, icon, Math.ceil(timer), timer / maxT); rx -= 66; }
    }
    if (!isAivai() && player.smashCD > 0 && state.mode === 'play') {
      drawBadge(rx, H - 40, '#ffffff', 'smash', Math.ceil(player.smashCD), 1 - player.smashCD / SMASH_CD);
      rx -= 66;
    }
    if (cfg().rallyShrink && player.rallyScale < 1 && state.mode === 'play') {
      rx -= 24; // wider badge
      drawBadge(rx, H - 40, '#ff9950', 'wear', `${Math.round(player.rallyScale * 100)}%`, (player.rallyScale - RALLY_SHRINK_MIN) / (1 - RALLY_SHRINK_MIN));
      rx -= 66;
    }
    if (state.muted) drawBadge(rx, H - 40, '#8899bb', 'mute', '', 1);

    // GLOBAL effects — centred row at the bottom
    const globals = [];
    if (state.flipTimer > 0 && state.mode !== 'menu') {
      globals.push(['flip', Math.ceil(state.flipTimer), state.flipTimer / (state.flipPending ? 3 : 10), '#ff9ee8']);
    }
    if (state.mode !== 'menu' && state.well) {
      globals.push(['well', Math.ceil(state.well.life), state.well.life / WELL_LIFE, '#c46bff']);
    }
    if (state.mode !== 'menu' && state.wind !== 0 && state.windLife > 0) {
      globals.push(['wind', Math.ceil(state.windLife), state.windLife / WIND_LIFE, '#9fd8ff']);
    }
    if (state.slowTimer > 0) globals.push(['slow', Math.ceil(state.slowTimer), state.slowTimer / SLOW_DURATION, '#b06bff']);
    if (state.chargeWindow > 0 && state.mode === 'play') globals.push(['charge', Math.ceil(state.chargeWindow), state.chargeWindow / CHARGE_WINDOW, '#ffe14d']);
    if (globals.length > 0) {
      const bw = 66;
      let gx = W / 2 - (globals.length * bw - 8) / 2;
      for (const [icon, label, frac, color] of globals) {
        drawBadge(gx, H - 40, color, icon, label, frac);
        gx += bw;
      }
    }

    // rally combo — above the global effects row (or at the bottom if none)
    if (state.rally >= COMBO_START && (state.mode === 'play' || state.mode === 'countdown')) {
      const baseY = globals.length > 0 ? H - 62 : H - 24;
      const lvl = comboLevel();
      const size = Math.min(12 + lvl * 0.8, 26);
      const heat = clamp(lvl / 15, 0, 1); // yellow -> orange -> red as it climbs
      const rC = 255, gC = Math.round(220 - heat * 140), bC = Math.round(80 - heat * 60);
      // A restrained level-up bump settles into the combo's new base size.
      const punch = state.comboPunch;
      const punchScale = 1 + Math.sin(punch * Math.PI) * 0.14;
      const comboY = baseY - (lvl > 0 ? 14 : 0);
      if (lvl > 0) {
        ctx.font = '8px "Press Start 2P", monospace';
        ctx.fillStyle = `rgba(255, 255, 255, ${0.45 + punch * 0.15})`;
        ctx.fillText(`SPEED CAP +${comboBonus()}`, W / 2, baseY);
      }
      ctx.save();
      ctx.translate(W / 2, comboY);
      ctx.scale(punchScale, punchScale);
      ctx.translate(-W / 2, -comboY);
      ctx.font = `${size}px "Press Start 2P", monospace`;
      ctx.fillStyle = `rgba(${rC}, ${gC}, ${bC}, ${0.5 + 0.3 * Math.sin(performance.now() / 200) + punch * 0.12})`;
      ctx.shadowColor = `rgb(${rC}, ${gC}, ${bC})`;
      ctx.shadowBlur = 6 + heat * 14 + punch * 5;
      ctx.fillText(`COMBO ×${state.rally}`, W / 2, comboY);
      ctx.restore();
      ctx.shadowBlur = 0;
    }
  }

  // power-ups — bloom in instead of snapping abruptly onto the field
  for (const pu of powerups) {
    const t = POWERUP_TYPES[pu.type];
    const age = (performance.now() - pu.born) / 1000;
    const spawnAge = Math.max(0, state.fieldTime - (pu.spawnT ?? state.fieldTime));
    const enter = clamp(spawnAge / 0.28, 0, 1);
    const easedEnter = 1 - Math.pow(1 - enter, 3);
    const pulse = 1 + 0.12 * Math.sin(age * 5);
    const fade = (pu.life < 2 ? (0.3 + 0.7 * Math.abs(Math.sin(pu.life * 6))) : 1) * easedEnter;
    ctx.save();
    ctx.translate(pu.x, pu.y);
    ctx.scale(0.35 + 0.65 * easedEnter, 0.35 + 0.65 * easedEnter);
    ctx.translate(-pu.x, -pu.y);
    ctx.globalAlpha = fade;
    ctx.strokeStyle = t.color;
    ctx.shadowColor = t.color;
    ctx.shadowBlur = 14;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, POWERUP_R * pulse, 0, Math.PI * 2);
    ctx.stroke();
    // Single-symbol pickups need more visual weight than the ×2/×8 labels.
    const compactLabel = pu.type === 'multi' || pu.type === 'mega';
    ctx.font = compactLabel ? '12px "Press Start 2P", monospace' : 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowBlur = 5;
    ctx.fillStyle = t.color;
    ctx.fillText(t.label, pu.x, pu.y + (compactLabel ? 1 : 0), POWERUP_R * 1.65);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // bumpers (ROYALE)
  if (state.mode !== 'menu') {
    for (const bp of state.bumpers) {
      bp.pulse = Math.max(0, bp.pulse - 0.04);
      const r = bp.r * (1 + bp.pulse * 0.2);
      ctx.fillStyle = '#141a2c';
      ctx.strokeStyle = `rgba(255, 217, 80, ${0.55 + bp.pulse * 0.45})`;
      ctx.shadowColor = '#ffd950';
      ctx.shadowBlur = 10 + bp.pulse * 18;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(bp.x, bp.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  // ripples (expanding rings)
  for (const r of ripples) {
    ctx.globalAlpha = clamp(r.life, 0, 1) * 0.7;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = r.width * clamp(r.life, 0.2, 1);
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // particles
  for (const p of particles) {
    ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  // ghost paddles (power-up) — translucent, drawn under the mains so overlap reads;
  // blink when about to expire
  if (state.mode !== 'menu') {
    for (const [gh, glow, fill] of [[ghostL, '#ff4f9a', '#ff9ac4'], [ghostR, '#35e0ff', '#9aecff']]) {
      if (gh.timer <= 0) continue;
      const blink = gh.timer < 2 ? 0.15 + 0.3 * Math.abs(Math.sin(gh.timer * 6)) : 0.45;
      ctx.globalAlpha = blink;
      ctx.shadowBlur = 14;
      ctx.shadowColor = glow;
      ctx.fillStyle = fill;
      roundRect(gh.x, gh.y, PADDLE_W, gh.h, 6);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  // paddles — AI (pink, left), player (cyan, right).
  // hitFlash makes them pop bright + slightly wider for a beat after contact
  ctx.shadowBlur = 20 + ai.hitFlash * 18;
  ctx.shadowColor = '#ff4f9a';
  ctx.fillStyle = ai.hitFlash > 0.5 ? '#ffd0e4' : '#ff4f9a';
  roundRect(ai.x - ai.hitFlash * 2, ai.y, PADDLE_W + ai.hitFlash * 4, ai.h, 6);
  // IMPOSSIBLE: your paddle flickers — phases toward invisibility in waves
  let playerAlpha = 1;
  if (cfg().flicker && !isAivai() && (state.mode === 'play' || state.mode === 'countdown')) {
    playerAlpha = 0.12 + 0.88 * Math.abs(Math.sin(performance.now() / 700));
  }
  ctx.globalAlpha = playerAlpha;
  ctx.shadowBlur = 20 + player.hitFlash * 18;
  ctx.shadowColor = state.invertT > 0 ? '#ff5a5a' : '#35e0ff';
  ctx.fillStyle = state.invertT > 0 ? '#ff5a5a' : (player.hitFlash > 0.5 ? '#d6f6ff' : '#35e0ff');
  roundRect(player.x - player.hitFlash * 2, player.y, PADDLE_W + player.hitFlash * 4, player.h, 6);
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // gravity well — swirling violet vortex
  if (state.well && state.mode !== 'menu') {
    const wl = state.well;
    const appear = clamp((WELL_LIFE - wl.life) / 0.8, 0, 1);
    const eased = appear * appear * (3 - 2 * appear);
    const fade = eased * clamp(wl.life / 1.5, 0, 1);
    const scale = 0.2 + 0.8 * eased;
    const t = state.fieldTime;
    ctx.save();
    ctx.translate(wl.x, wl.y);
    ctx.scale(scale, scale);
    ctx.translate(-wl.x, -wl.y);
    ctx.globalAlpha = fade;
    for (let ring = 0; ring < 3; ring++) {
      const rr = WELL_R * (0.25 + ring * 0.3) * (1 + 0.06 * Math.sin(t * 3 + ring));
      ctx.strokeStyle = `rgba(196, 107, 255, ${0.35 - ring * 0.09})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 14]);
      ctx.lineDashOffset = -t * 60 * (ring % 2 ? 1 : -1);
      ctx.beginPath();
      ctx.arc(wl.x, wl.y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#c46bff';
    ctx.shadowColor = '#c46bff';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.arc(wl.x, wl.y, 6 + Math.sin(t * 5) * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // wind gust — streaks ease in from still air and taper away before expiry.
  if (state.wind !== 0 && state.mode !== 'menu') {
    const t = state.fieldTime;
    const dirn = Math.sign(state.wind);
    const enter = clamp((t - state.windSpawnT) / 0.45, 0, 1);
    const exit = clamp(state.windLife / 0.55, 0, 1);
    const visibility = (1 - Math.pow(1 - enter, 3)) * (exit * exit * (3 - 2 * exit));
    ctx.strokeStyle = `rgba(159, 216, 255, ${0.22 * visibility})`;
    ctx.lineWidth = 1 + 0.5 * visibility;
    for (let i = 0; i < 14; i++) {
      const sx = ((i * 137.5) % W);
      const len = (26 + (i % 4) * 9) * (0.25 + 0.75 * visibility);
      const sy = ((t * Math.abs(state.wind) * 0.9 + i * 261) * dirn % (H + 80) + H + 80) % (H + 80) - 40;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx, sy + len * dirn);
      ctx.stroke();
    }
  }

  // portals — each pair opens with a quick, smooth bloom
  if (state.portals && state.mode !== 'menu') {
    const spawnAge = Math.max(0, state.fieldTime - (state.portals.spawnT ?? state.fieldTime));
    const enter = clamp(spawnAge / 0.35, 0, 1);
    const easedEnter = 1 - Math.pow(1 - enter, 3);
    const blink = (state.portals.life < 2 ? 0.3 + 0.7 * Math.abs(Math.sin(state.portals.life * 6)) : 1) * easedEnter;
    for (const p of [state.portals.a, state.portals.b]) {
      // Use the pausable field clock rather than wall-clock time so portals
      // animate during countdown but hold perfectly still while paused.
      const wob = Math.sin(state.fieldTime * 5 + p.x) * 2;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(0.15 + 0.85 * easedEnter, 0.15 + 0.85 * easedEnter);
      ctx.translate(-p.x, -p.y);
      ctx.globalAlpha = blink;
      ctx.strokeStyle = '#35ffc8';
      ctx.shadowColor = '#35ffc8';
      ctx.shadowBlur = 18;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, PORTAL_R * 0.55, PORTAL_R + wob, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, PORTAL_R * 0.3, (PORTAL_R + wob) * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // balls
  if (state.mode === 'play' || state.mode === 'countdown') {
    for (const b of balls) {
      const a = ballAlpha(b) * phantomAlpha(b);
      ctx.globalAlpha = a;
      ctx.shadowBlur = 16 * a;
      const fire = isFireball(b);
      if (b.type === 'gold') {
        ctx.shadowColor = '#ffd950';
        ctx.fillStyle = '#ffd950';
      } else if (b.type === 'phantom') {
        ctx.shadowColor = '#be9fff';
        ctx.fillStyle = '#d8c8ff';
      } else if (b.type === 'heavy') {
        ctx.shadowColor = '#8899bb';
        ctx.fillStyle = '#aebdd4';
      } else if (b.type === 'comet') {
        ctx.shadowColor = '#78dcff';
        ctx.fillStyle = '#c8f2ff';
      } else if (b.type === 'splitter') {
        ctx.shadowColor = '#66ff8c';
        ctx.fillStyle = '#a8ffc0';
      } else if (fire) {
        ctx.shadowColor = '#ff6a2a';
        ctx.fillStyle = '#ffb46a';
      } else {
        ctx.shadowColor = '#ffffff';
        ctx.fillStyle = '#ffffff';
      }
      // held & charging: pulsing gold ring that tightens as charge builds
      if (b.heldBy) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
        ctx.shadowBlur = 0;
        const cf = clamp(b.holdT / CHARGE_MAX, 0, 1);
        // Side-local charge meter and trajectory preview (same angle as release).
        const right = b.heldBy === 'player';
        const bx = right ? W - 12 : 6;
        ctx.fillStyle = '#263044';
        roundRect(bx, H / 2 - 60, 6, 120, 3);
        const chargeHeight = cf * 120;
        if (chargeHeight > 0) {
          ctx.fillStyle = '#ffe14d';
          ctx.shadowColor = '#ffe14d';
          ctx.shadowBlur = 4 + cf * 6;
          roundRect(bx, H / 2 + 60 - chargeHeight, 6, chargeHeight,
                    Math.min(3, chargeHeight / 2));
        }
        ctx.shadowBlur = 0;
        // Keep the aim guide subdued and clear of the paddle/charge ring.
        ctx.save();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(160, 170, 185, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 7]);
        const aimDX = (right ? -1 : 1) * Math.cos(b.aimAngle || 0);
        const aimDY = Math.sin(b.aimAngle || 0);
        const guideLength = 110 + cf * 150;
        const tipX = b.x + aimDX * guideLength;
        const tipY = b.y + aimDY * guideLength;
        ctx.beginPath();
        ctx.moveTo(b.x + aimDX * 40, b.y + aimDY * 40);
        ctx.lineTo(tipX - aimDX * 18, tipY - aimDY * 18);
        ctx.stroke();
        // Solid arrowhead keeps the direction clear without adding glow.
        ctx.setLineDash([]);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(tipX - aimDX * 9 - aimDY * 5, tipY - aimDY * 9 + aimDX * 5);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(tipX - aimDX * 9 + aimDY * 5, tipY - aimDY * 9 - aimDX * 5);
        ctx.stroke();
        ctx.restore();
        const ringR = BALL_R + 14 - cf * 8 + Math.sin(performance.now() / 60) * 2;
        ctx.strokeStyle = `rgba(255, 225, 77, ${0.4 + cf * 0.6})`;
        ctx.shadowColor = '#ffe14d';
        ctx.shadowBlur = 8 + cf * 20;
        ctx.lineWidth = 2 + cf * 2;
        ctx.beginPath();
        ctx.arc(b.x, b.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
        if (cf > 0.3 && Math.random() < cf * 0.6) {
          particles.push({
            x: b.x + (Math.random() - 0.5) * 30, y: b.y + (Math.random() - 0.5) * 30,
            vx: (b.x - (b.x + (Math.random() - 0.5) * 30)) * 8, vy: 0,
            life: 0.2, maxLife: 0.2, color: '#ffe14d', size: 1.5 + Math.random() * 1.5,
          });
        }
        ctx.restore();
      }

      // motion stretch: fast balls elongate along their velocity
      const sp = Math.hypot(b.vx, b.vy);
      // Stored velocity survives pauses/countdowns, but stationary balls
      // should not retain the motion-stretch effect.
      const moving = state.mode === 'play' && !b.heldBy;
      const visibleSpeed = sp * (state.slowTimer > 0 ? SLOW_FACTOR : 1);
      const stretch = moving ? clamp((visibleSpeed - 600) / 1400, 0, 0.45) : 0;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(Math.atan2(b.vy, b.vx));
      ctx.scale(1 + stretch, 1 - stretch * 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, b.r, 0, Math.PI * 2);
      ctx.fill();
      // splitter: dashed seam showing where it will split
      if (b.type === 'splitter') {
        ctx.strokeStyle = '#0b0e18';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2.5, 2.5]);
        ctx.beginPath();
        ctx.moveTo(0, -b.r);
        ctx.lineTo(0, b.r);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
      // fireballs shed embers
      if (fire && Math.random() < 0.5) {
        particles.push({
          x: b.x, y: b.y,
          vx: -b.vx * 0.06 + (Math.random() - 0.5) * 60,
          vy: -b.vy * 0.06 + (Math.random() - 0.5) * 60,
          life: 0.3, maxLife: 0.3,
          color: Math.random() < 0.5 ? '#ff6a2a' : '#ffd950',
          size: 2 + Math.random() * 2,
        });
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  // smash glow on armed paddles / cooldown arc
  for (const [pad, color] of [[ai, '#ff4f9a'], [player, '#35e0ff']]) {
    if (pad.smashT > 0) {
      ctx.strokeStyle = '#ffffff';
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 22;
      ctx.lineWidth = 3;
      ctx.strokeRect(pad.x - 4, pad.y - 4, PADDLE_W + 8, pad.h + 8);
      ctx.shadowBlur = 0;
    }
  }

  // floating popups
  for (const p of popups) {
    ctx.globalAlpha = clamp(p.life, 0, 1);
    ctx.font = `${p.size}px "Press Start 2P", monospace`;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Measure at render time: floating motion and late font loading must not
    // push a popup outside the arena. Leave room for glow and camera shake.
    const inset = 28;
    const width = Math.min(ctx.measureText(p.str).width, W - inset * 2);
    const x = clamp(p.x, inset + width / 2, W - inset - width / 2);
    const y = clamp(p.y, inset + p.size / 2, H - inset - p.size / 2);
    ctx.fillText(p.str, x, y, W - inset * 2);
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // badge tooltip — drawn last so it reads over everything
  if (hoveredBadge) {
    const tip = BADGE_TIPS[hoveredBadge.icon];
    if (tip) {
      ctx.font = '9px "Press Start 2P", monospace';
      const tw = ctx.measureText(tip).width + 20;
      const th = 26;
      let tx = clamp(hoveredBadge.x + hoveredBadge.w / 2 - tw / 2, 8, W - tw - 8);
      const ty = hoveredBadge.y - th - 8;
      ctx.fillStyle = 'rgba(8, 10, 20, 0.95)';
      ctx.strokeStyle = hoveredBadge.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(tx, ty, tw, th, 5) : ctx.rect(tx, ty, tw, th);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#e8f7ff';
      ctx.textAlign = 'center';
      ctx.fillText(tip, tx + tw / 2, ty + 17);
    }
  }

  // countdown number
  if (state.mode === 'countdown' && state.countdown > 0) {
    const scale = 1 + (1 - countdownTimer) * 0.4;
    ctx.save();
    ctx.translate(W / 2, H / 2 - 60);
    ctx.scale(scale, scale);
    ctx.font = '48px "Press Start 2P", monospace';
    ctx.fillStyle = `rgba(255, 255, 255, ${0.9 - countdownTimer * 0.5})`;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 24;
    ctx.fillText(state.countdown, 0, 0);
    ctx.restore();
    ctx.shadowBlur = 0;
  }

  // score flash — soft, warm-tinted, and quick to fade
  if (state.flash > 0) {
    ctx.fillStyle = `rgba(220, 230, 255, ${state.flash})`;
    ctx.fillRect(-20, -20, W + 40, H + 40);
    state.flash -= 0.035;
  }

  ctx.restore();
}

/* ---------- indicator badges with icons ---------- */
// what each badge means — shown as a hover tooltip
const BADGE_TIPS = {
  flip: 'FLIP: 3-second warning, then swapped sides for 10 seconds (global)',
  well:   'GRAVITY WELL: bends ball paths toward its core (global)',
  wind:   'WIND: pushes all balls vertically; heavy balls resist (global)',
  grow:   'BIG PADDLE: this side\'s paddle is enlarged',
  shrink: 'SHRUNK: this side\'s paddle is reduced',
  slow:   'SLOW-MO: all balls at 55% speed (global)',
  charge: 'CATCH ZONE: LEFT-CLICK to arm catch; mouse or W/S aims; left-click again fires (global)',
  smash:  'SMASH recharging — LEFT-CLICK arms a boosted return',
  wear:   'PADDLE WEAR: your paddle shrinks each hit, resets on score',
  mute:   'Sound muted — press M to unmute',
  ghost:  'GHOST PADDLE: an AI helper defends this side',
};
let hoveredBadge = null;   // set during draw if the mouse is over a badge
let mouseCX = -1, mouseCY = -1; // mouse in canvas coords

function drawBadge(x, y, color, icon, label, frac) {
  const str = String(label);
  const bw = Math.max(58, 34 + str.length * 12), bh = 30, r = 8;
  // hover detection for tooltips
  if (mouseCX >= x && mouseCX <= x + bw && mouseCY >= y && mouseCY <= y + bh) {
    hoveredBadge = { icon, x, y, w: bw, color };
  }
  ctx.save();
  // pill background
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = 'rgba(10, 14, 26, 0.85)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + bw, y, x + bw, y + bh, r);
  ctx.arcTo(x + bw, y + bh, x, y + bh, r);
  ctx.arcTo(x, y + bh, x, y, r);
  ctx.arcTo(x, y, x + bw, y, r);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // time-remaining bar along the bottom of the pill
  if (frac < 1) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x + 4, y + bh - 5, (bw - 8) * clamp(frac, 0, 1), 3);
  }

  // icon
  const cx = x + 16, cy = y + bh / 2 - 1;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  switch (icon) {
    case 'grow': // paddle with outward arrows
      ctx.fillRect(cx - 2, cy - 8, 4, 16);
      arrow(cx - 8, cy - 4, 0, -5); arrow(cx - 8, cy + 4, 0, 5);
      arrow(cx + 8, cy - 4, 0, -5); arrow(cx + 8, cy + 4, 0, 5);
      break;
    case 'shrink': // paddle with inward arrows
      ctx.fillRect(cx - 2, cy - 5, 4, 10);
      arrow(cx - 9, cy - 9, 0, 4); arrow(cx - 9, cy + 9, 0, -4);
      arrow(cx + 9, cy - 9, 0, 4); arrow(cx + 9, cy + 9, 0, -4);
      break;
    case 'flip':
      arrow(cx - 8, cy - 4, 16, 0);
      arrow(cx + 8, cy + 4, -16, 0);
      break;
    case 'well': // spiral into a central core
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const angle = i / 40 * Math.PI * 4;
        const radius = 8 * (1 - i / 40);
        const px = cx + Math.cos(angle) * radius;
        const py = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      break;
    case 'wind': // gust lines and current push direction
      ctx.beginPath();
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(cx - 8, cy + i * 5);
        ctx.lineTo(cx + 1 + (i === 0 ? 3 : 0), cy + i * 5);
      }
      ctx.stroke();
      arrow(cx + 7, cy - (state.wind > 0 ? 5 : -5), 0, state.wind > 0 ? 10 : -10);
      break;
    case 'slow': // clock
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 4, cy + 2); ctx.stroke();
      break;
    case 'wear': // cracked paddle
      ctx.fillRect(cx - 2, cy - 9, 4, 7);
      ctx.fillRect(cx - 2, cy + 2, 4, 7);
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy - 2); ctx.lineTo(cx, cy); ctx.lineTo(cx - 3, cy + 2); ctx.lineTo(cx + 5, cy + 1);
      ctx.stroke();
      break;
    case 'charge': // target rings
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 1, 0, Math.PI * 2); ctx.fill();
      break;
    case 'ghost': // two parallel paddles (main + translucent helper)
      ctx.fillRect(cx - 6, cy - 8, 4, 16);
      ctx.globalAlpha *= 0.5;
      ctx.fillRect(cx + 2, cy - 6, 4, 12);
      ctx.globalAlpha *= 2;
      break;
    case 'smash': // lightning bolt
      ctx.beginPath();
      ctx.moveTo(cx + 3, cy - 9);
      ctx.lineTo(cx - 4, cy + 1);
      ctx.lineTo(cx, cy + 1);
      ctx.lineTo(cx - 3, cy + 9);
      ctx.lineTo(cx + 4, cy - 1);
      ctx.lineTo(cx, cy - 1);
      ctx.closePath();
      ctx.fill();
      break;
    case 'mute': // speaker with slash
      ctx.beginPath();
      ctx.moveTo(cx - 7, cy - 3); ctx.lineTo(cx - 3, cy - 3); ctx.lineTo(cx + 2, cy - 7);
      ctx.lineTo(cx + 2, cy + 7); ctx.lineTo(cx - 3, cy + 3); ctx.lineTo(cx - 7, cy + 3);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(cx + 5, cy - 6); ctx.lineTo(cx + 10, cy + 6); ctx.stroke();
      break;
  }

  // label (seconds remaining / percentage)
  if (label !== '') {
    ctx.font = '11px "Press Start 2P", monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e8f7ff';
    ctx.fillText(label, x + 30, cy + 5);
    ctx.textAlign = 'center';
  }
  ctx.restore();
}

function arrow(x, y, dx, dy) {
  // tiny arrowhead pointing in (dx, dy) direction
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dx, y + dy);
  ctx.stroke();
  const ang = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(x + dx, y + dy);
  ctx.lineTo(x + dx - Math.cos(ang - 0.5) * 4, y + dy - Math.sin(ang - 0.5) * 4);
  ctx.moveTo(x + dx, y + dy);
  ctx.lineTo(x + dx - Math.cos(ang + 0.5) * 4, y + dy - Math.sin(ang + 0.5) * 4);
  ctx.stroke();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.fill();
}

