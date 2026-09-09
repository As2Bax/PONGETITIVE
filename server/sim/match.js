'use strict';

/* ============================================================
   Authoritative match

   Owns one headless simulation plus the two players' input buffers, and steps
   the world on a fixed timestep. This is the SOURCE OF TRUTH: neither client
   simulates the match, so neither can gain an advantage from being the host.

   Fixed timestep matters. Physics that advances by a variable wall-clock delta
   produces different results on a loaded server than an idle one, and the
   swept-collision code is tuned around a steady 60Hz step. The loop therefore
   accumulates real elapsed time and consumes it in exact TICK_DT slices.

   Coordinate convention (unchanged from the client):
     - The simulation's RIGHT paddle is `player`, the LEFT paddle is `ai`.
     - Room host drives the RIGHT paddle, guest drives the LEFT.
     - Each client mirrors its own view so both players see themselves right.
   ============================================================ */

import { HeadlessMatch } from './headless.js';
import { InputBuffer } from './input.js';

export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;
// Snapshots go out at half the simulation rate. Clients dead-reckon between
// them, which the existing netcode already does well, and it halves bandwidth.
export const SNAPSHOT_HZ = 30;

// If the loop falls badly behind (GC pause, host suspend) do not try to catch
// up on every missed tick at once: that would produce a burst of simulation and
// a visible teleport. Drop the backlog instead.
const MAX_CATCHUP_TICKS = 5;

// Paddle speed ceiling enforced server-side. The client requests an aim
// position; the server refuses to move faster than a human physically could,
// so a modified client cannot teleport its paddle onto every ball.
// Chosen above the keyboard constant (620) to leave mouse aiming responsive,
// while still bounding a teleport to a plausible flick.
const MAX_PADDLE_SPEED = 1800;

export class AuthoritativeMatch {
  /**
   * @param {object} opts
   * @param {(snapshot: object) => void} opts.onSnapshot broadcast callback
   * @param {() => void} [opts.onEnd] invoked once when the match finishes
   */
  constructor({ onSnapshot, onEnd } = {}) {
    this.sim = new HeadlessMatch();
    this.inputs = { host: new InputBuffer(), guest: new InputBuffer() };
    this.onSnapshot = onSnapshot || (() => {});
    this.onEnd = onEnd || (() => {});

    this.running = false;
    this.timer = null;
    this.accumulator = 0;
    this.lastStepAt = 0;
    this.snapshotAccum = 0;
    this.tickCount = 0;
    this.finished = false;
    // Paddle positions as decided by player input, preserved across update().
    this.authoritative = { playerY: 0, aiY: 0 };
  }

  start(settings) {
    if (this.running) return;
    this.sim.start(settings);

    // Begin with the same 3-2-1 countdown the local game uses, so players get
    // their bearings and late-joining latency has time to settle.
    const s = this.sim.sim.state;
    s.countdown = 3;
    s.mode = 'countdown';

    this.running = true;
    this.finished = false;
    this.lastStepAt = Date.now();
    this.accumulator = 0;
    this.snapshotAccum = 0;

    // setInterval at the tick rate; the accumulator corrects for jitter, so
    // timer drift never changes how far the physics actually advances.
    this.timer = setInterval(() => this.step(), 1000 / TICK_HZ);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Feed a validated input message from one side. */
  applyInput(role, message) {
    const buffer = this.inputs[role];
    if (buffer) buffer.accept(message, Date.now());
  }

  /**
   * Translate a requested aim into an actual paddle position, rate-limited.
   * This is the server-side anti-cheat: the client asks, the server decides.
   */
  movePaddle(pad, aimY, dt) {
    const sim = this.sim.sim;
    if (aimY === null) return;
    const half = pad.h / 2;
    const target = sim.clamp(aimY - half, sim.topWall(), sim.botWall() - pad.h);
    const delta = target - pad.y;
    const maxStep = MAX_PADDLE_SPEED * dt;
    pad.y += Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;
    pad.y = sim.clamp(pad.y, sim.topWall(), sim.botWall() - pad.h);
  }

  /**
   * Point a held ball where its owner is aiming.
   *
   * The simulation's own human-aim branch in updateBalls reads mouseY/mouseCX/
   * keys, none of which exist server-side (the sandbox stubs them), so left to
   * itself a caught ball in PvP never changes angle. The client sends the angle
   * explicitly and it is written straight onto the ball.
   *
   * No mirroring: the angle is a side-relative bounce angle, and releaseBall
   * applies the left/right direction itself.
   */
  aimHeldBall(side, aimAngle) {
    if (aimAngle === null || !Number.isFinite(aimAngle)) return;
    const sim = this.sim.sim;
    const held = sim.balls.find(b => b.heldBy === side);
    if (held) held.aimAngle = aimAngle;
  }

  /* Screen shake and the goal flash are the only two effects whose decay lives
     in render.js rather than in update(). On a client that is fine - every
     frame draws and therefore decays them. The server has no renderer, so left
     alone they stay pinned at their peak value for the rest of the match.

     The clients then re-apply that peak on every snapshot (with Math.max, so it
     can never fall), and the result is a permanent strobe: shake bottoms out
     around 8.6 and flash around 0.145, forever, after the first goal.

     Decaying them here keeps the authoritative state honest. The rates mirror
     render.js at 60fps, converted to be timestep-independent. */
  decayScreenEffects(dt) {
    const s = this.sim.sim.state;
    if (s.shake > 0) {
      s.shake *= Math.pow(0.86, dt * 60);
      if (s.shake < 0.4) s.shake = 0;
    }
    if (s.flash > 0) {
      s.flash -= 0.035 * dt * 60;
      if (s.flash < 0) s.flash = 0;
    }
  }

  /** Advance one fixed simulation step, applying both players' inputs. */
  tick(dt) {
    const sim = this.sim.sim;
    const state = sim.state;
    const simulating = state.mode === 'play' || state.mode === 'countdown';

    if (simulating) {
      // Host drives the RIGHT paddle (player), guest the LEFT (ai).
      const hostIn = this.inputs.host;
      const guestIn = this.inputs.guest;

      sim.player.h = sim.paddleHeight(sim.player);
      sim.ai.h = sim.paddleHeight(sim.ai);

      const prevPlayerY = sim.player.y;
      const prevAiY = sim.ai.y;

      /* A paddle holding a ball does not move: its controls are aiming the
         shot instead (updatePlayer returns early for exactly this reason).
         The aim angle therefore has to be applied in its place, or the held
         ball keeps whatever angle it was caught with and fires flat. */
      if (sim.paddleHolds('player')) this.aimHeldBall('player', hostIn.aimAngle);
      else this.movePaddle(sim.player, hostIn.aimY, dt);

      if (sim.paddleHolds('ai')) this.aimHeldBall('ai', guestIn.aimAngle);
      else this.movePaddle(sim.ai, guestIn.aimY, dt);

      // smoothVy feeds the paddle-english in paddleBounce, so it must be
      // derived from the movement the server actually performed.
      const track = (pad, prevY) => {
        pad.smoothVy += ((pad.y - prevY) / Math.max(dt, 1e-4) - pad.smoothVy) * Math.min(1, 14 * dt);
      };
      track(sim.player, prevPlayerY);
      track(sim.ai, prevAiY);

      // Remember where the players put their paddles, so the AI/local-player
      // controllers inside update() cannot override it.
      this.authoritative.playerY = sim.player.y;
      this.authoritative.aiY = sim.ai.y;

      // Discrete actions: every queued click is applied, never coalesced away.
      if (state.mode === 'play') {
        for (let i = hostIn.takeActions(); i > 0; i--) sim.applyAction('player');
        for (let i = guestIn.takeActions(); i > 0; i--) sim.applyAction('ai');
      } else {
        // Clicks during the countdown are discarded rather than banked.
        hostIn.takeActions();
        guestIn.takeActions();
      }
    }

    // The simulation's own update() drives balls, powerups, events and the
    // countdown. Its paddle-control branches are inert here: the net stubs
    // report neither host nor guest, and both paddles were positioned above.
    this.sim.tick(dt);

    /* update() runs the local-player and AI controllers over both paddles: the
       simulation believes it is a single-player match, because the net stubs
       report neither host nor guest. updatePlayer() follows `mouseY` (null
       here, so it only decays velocity) but updateAI() actively steers the LEFT
       paddle toward the ball, adding a couple of pixels on top of the movement
       the guest actually asked for. That both fights the player for control and
       pushes the paddle past the server's own speed limit.

       Restoring the positions computed above discards the controllers' work
       while keeping everything else update() did (physics, powerups, events). */
    if (simulating) {
      sim.player.y = this.authoritative.playerY;
      sim.ai.y = this.authoritative.aiY;
    }
    sim.player.y = sim.clamp(sim.player.y, sim.topWall(), sim.botWall() - sim.player.h);
    sim.ai.y = sim.clamp(sim.ai.y, sim.topWall(), sim.botWall() - sim.ai.h);

    this.decayScreenEffects(dt);

    this.tickCount++;
  }

  step() {
    if (!this.running) return;

    const now = Date.now();
    let elapsed = (now - this.lastStepAt) / 1000;
    this.lastStepAt = now;
    // Guard against a suspended process reporting an enormous delta.
    if (elapsed > 1) elapsed = 1;
    this.accumulator += elapsed;

    let ticks = 0;
    while (this.accumulator >= TICK_DT && ticks < MAX_CATCHUP_TICKS) {
      this.tick(TICK_DT);
      this.accumulator -= TICK_DT;
      ticks++;
    }
    // Discard any backlog we refused to simulate.
    if (this.accumulator > TICK_DT) this.accumulator = 0;

    if (ticks === 0) return;

    this.snapshotAccum += ticks * TICK_DT;
    const interval = 1 / SNAPSHOT_HZ;
    if (this.snapshotAccum >= interval) {
      this.snapshotAccum = 0;
      this.onSnapshot(this.buildSnapshot());
    }

    if (this.sim.sim.state.mode === 'over' && !this.finished) {
      this.finished = true;
      // Force a final snapshot so neither client is stranded on the last frame.
      this.onSnapshot(this.buildSnapshot());
      this.stop();
      this.onEnd();
    }
  }

  /**
   * Serialise world state. Field names match the existing client snapshot
   * format so the guest's decoder keeps working; `ah`/`ag` carry the per-side
   * input acknowledgements the new reconciliation needs.
   */
  buildSnapshot() {
    const sim = this.sim.sim;
    const s = sim.state;
    const r = Math.round;
    const r1 = (v) => Math.round(v * 10) / 10;
    const r2 = (v) => Math.round(v * 100) / 100;

    return {
      t: 's',
      seq: this.tickCount,
      ah: this.inputs.host.ackSeq,
      ag: this.inputs.guest.ackSeq,
      m: s.mode,
      c: s.countdown,
      tl: r1(s.timeLeft),
      sc: [s.scores.player, s.scores.ai],
      lv: s.lives,
      ra: s.rally,
      zt: r(s.zoneTop), zb: r(s.zoneBottom),
      /* Paddle state. smashT/smashCD/catchT are the ability windows: without
         them a client shows no armed glow and no cooldown badge, so pressing
         smash gives no feedback at all and the ability feels broken even though
         the server applied it. */
      p: [r(sim.player.y), r(sim.player.h), r1(sim.player.growT), r1(sim.player.shrinkT), r2(sim.player.hitFlash),
          r2(sim.player.smashT), r2(sim.player.smashCD), r2(sim.player.catchT || 0)],
      a: [r(sim.ai.y), r(sim.ai.h), r1(sim.ai.growT), r1(sim.ai.shrinkT), r2(sim.ai.hitFlash),
          r2(sim.ai.smashT), r2(sim.ai.smashCD), r2(sim.ai.catchT || 0)],
      g: [r(sim.ghostL.y), r(sim.ghostL.h), r1(sim.ghostL.timer),
          r(sim.ghostR.y), r(sim.ghostR.h), r1(sim.ghostR.timer)],
      b: sim.balls.map(b => [r(b.x), r(b.y), r(b.r), b.type, b.heldBy || 0,
                             r(b.speed), r2(b.holdT), r2(b.aimAngle || 0), r2(b.phase),
                             r(b.vx), r(b.vy)]),
      pu: sim.powerups.map(p => [r(p.x), r(p.y), p.type, r1(p.life)]),
      bp: s.bumpers.map(p => [r(p.x), r(p.y), r(p.r)]),
      po: s.portals ? [r(s.portals.a.x), r(s.portals.a.y),
                       r(s.portals.b.x), r(s.portals.b.y), r1(s.portals.life)] : 0,
      we: s.well ? [r(s.well.x), r(s.well.y), r1(s.well.life)] : 0,
      wi: [r(s.wind), r1(s.windLife)],
      ch: r1(s.chargeWindow),
      sl: r1(s.slowTimer),
      sd: s.suddenDeath ? 1 : 0,
      wv: s.wave,
      st: r1(s.survivalTime),
      sh: r1(s.shake),
      fl: r2(s.flash),
      /* Side-swap state. `flipped` is a render-time transform rather than a
         change of ownership, so without it the arena simply never swaps on
         either client even though the server applied the power-up. fp/ft carry
         the pending flag and countdown so the "SWAP IN 3" warning lands too. */
      fd: s.flipped ? 1 : 0,
      fp: s.flipPending ? 1 : 0,
      ft: r1(s.flipTimer),
      // Control inversion is likewise simulated server-side but felt locally.
      iv: r1(s.invertT || 0),
      ev: this.sim.drainEvents(),
    };
  }
}
