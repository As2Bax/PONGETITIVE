'use strict';

/* ============================================================
   AI  (left side — difficulty selects a relaxed, standard, sharp, or perfect brain)
   ============================================================ */
function pickAiAim() {
  ai.aimOffset = (Math.random() * 2 - 1) * ai.h * 0.35;
  player.aimOffset = (Math.random() * 2 - 1) * player.h * 0.35;
}

// pick the ball that will reach the AI's plane soonest
function nearestThreat(pad, facing) {
  // facing: -1 = paddle on the left cares about balls moving left,
  //          1 = paddle on the right cares about balls moving right
  let best = null, bestT = Infinity;
  for (const b of balls) {
    if (facing < 0 ? b.vx >= 0 : b.vx <= 0) continue;
    const plane = facing < 0 ? pad.x + PADDLE_W + BALL_R : pad.x - BALL_R;
    const t = (plane - b.x) / b.vx;
    if (t >= 0 && t < bestT) { bestT = t; best = b; }
  }
  return best;
}

// generic human-like brain; drives any paddle from either side
function runBrain(pad, facing, brain, dt) {
  if ((pad === ai && paddleHolds('ai')) || (pad === player && paddleHolds('player'))) {
    pad.vy = pad.smoothVy = 0;
    return;
  }
  pad.h = paddleHeight(pad);
  if (pad.debugBrain !== brain) {
    pad.debugBrain = brain;
    const label = brain.ruthless ? 'PERFECT' : cfg().aiSharp ? 'SHARP' : cfg().aiChill ? 'CHILL' : 'STANDARD';
    const who = pad === ai ? debugParticipant('ai') : pad === player ? debugParticipant('player') : 'GHOST AI';
    debugLog('ai', `${who} brain: ${label}`, { speed: brain.speed, lookAhead: brain.lookAhead, wobble: brain.wobble });
  }
  const threat = nearestThreat(pad, facing);

  // hand wobble: slowly drifting aim noise, like an unsteady human hand
  pad.noiseT -= dt;
  if (pad.noiseT <= 0) {
    pad.noiseT = 0.2 + Math.random() * 0.35;
    pad.noiseTarget = (Math.random() * 2 - 1) * brain.wobble;
  }
  pad.noise += (pad.noiseTarget - pad.noise) * Math.min(1, 5 * dt);

  const mid = (topWall() + botWall()) / 2;
  let target, urgency;
  let adrenaline = 0; // fast incoming ball — instincts kick in

  if (threat) {
    const plane = facing < 0 ? pad.x + PADDLE_W + BALL_R : pad.x - BALL_R;
    const eta = (plane - threat.x) / threat.vx;

    // adrenaline: 0 at base ball speed, 1 near max — a screaming ball
    // sharpens reactions the way it would for a human
    adrenaline = clamp((threat.speed - cfg().ballSpeed) / (cfg().maxSpeed - cfg().ballSpeed), 0, 1);

    // new incoming ball? sometimes commit to a bad read, corrected late
    if (threat !== pad.watching) {
      pad.watching = threat;
      pad.lapse = Math.random() < brain.lapseChance
        ? (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * brain.lapseError)
        : 0;
    }

    let py;
    if (brain.ruthless) {
      // exact intercept: fold the full trajectory across the walls (any
      // number of bounces), no guessing
      const span = (botWall() - BALL_R) - (topWall() + BALL_R);
      let folded = (threat.y + threat.vy * eta) - (topWall() + BALL_R);
      folded = ((folded % (2 * span)) + 2 * span) % (2 * span);
      py = (topWall() + BALL_R) + (folded > span ? 2 * span - folded : folded);
    } else {
      // humans track the ball and extrapolate a little — they don't solve the
      // full bounce path. Only a rough single-bounce guess.
      const look = Math.min(eta, brain.lookAhead);
      py = threat.y + threat.vy * look;
      if (py < topWall() + BALL_R) py = 2 * (topWall() + BALL_R) - py;
      if (py > botWall() - BALL_R) py = 2 * (botWall() - BALL_R) - py;
    }

    if (brain.ruthless) {
      // KILL SHOT: position so the ball strikes the paddle EDGE, angling the
      // return into whichever corner is farther from the opponent's paddle
      const foe = pad === ai ? player : ai;
      const foeCenter = foe.y + foe.h / 2;
      const aimHigh = foeCenter > (topWall() + botWall()) / 2; // foe low -> go high
      // rel = contact offset (-1 top edge .. +1 bottom edge); 0.85 keeps a
      // sliver of margin so a late wobble doesn't whiff entirely
      const rel = aimHigh ? -0.85 : 0.85;
      target = py - rel * (pad.h / 2);
      urgency = 1.3;
    } else {
      // the bad read fades as the ball closes in (late correction — often too late)
      const lapseFade = clamp(eta / 0.9, 0, 1);
      // focus under pressure: adrenaline damps the hand wobble a touch
      target = py + pad.noise * (1 - adrenaline * 0.5) + pad.lapse * lapseFade + pad.aimOffset * clamp(1 - eta, 0, 1);
      urgency = clamp(1.15 - eta * 0.55, 0.4, 1) * (1 + adrenaline * 0.35);
    }

  } else {
    pad.watching = null;
    if (brain.ruthless) {
      // no idling: shadow the outbound ball's line tightly so the paddle is
      // already parked on the return path before the foe even touches it
      const out = balls.find(bl => (facing < 0 ? bl.vx > 0 : bl.vx < 0)) || balls[0];
      target = out ? out.y : mid;
      urgency = 0.9;
    } else {
      // loosely shadow the rally, drift back toward centre
      const b = balls[0];
      target = (b ? mid + (b.y - mid) * 0.4 : mid) + pad.noise;
      urgency = 0.35;
    }
  }

  pad.targetY = clamp(target - pad.h / 2, topWall(), botWall() - pad.h);

  // ease velocity toward target — accelerates, overshoots slightly, corrects.
  // adrenaline tightens the response: snappier acceleration, higher top speed.
  // Ruthless bots skip the human easing almost entirely: machine reflexes.
  const diff = pad.targetY - pad.y;
  const gain = brain.ruthless ? 30 : 8 + adrenaline * 5;
  const snap = brain.ruthless ? 40 : 9 + adrenaline * 7;
  const desired = clamp(diff * gain, -brain.speed * urgency, brain.speed * urgency);
  pad.vy += (desired - pad.vy) * Math.min(1, snap * dt);
  pad.y = clamp(pad.y + pad.vy * dt, topWall(), botWall() - pad.h);
  pad.smoothVy = pad.vy;
}

function updateAI(dt) {
  // IMPOSSIBLE keeps its promise in every arrangement: perfect brains all round
  const brain = brainFor(isAivai() ? aiBrains.left : AI_CFG);
  runBrain(ai, -1, brain, dt);
}

