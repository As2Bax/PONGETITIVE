'use strict';

/* ============================================================
   Per-player input buffer

   The old host-authoritative netcode coalesced input by keeping only the most
   recent matured packet, which silently destroyed discrete events: a smash
   click followed milliseconds later by a routine mouse-move packet was thrown
   away before the simulation ever saw it.

   The fix is to treat the two kinds of input differently, because they have
   different semantics:

     - AIM is a level. Only the newest value matters; older ones are obsolete
       and coalescing them is correct.
     - ACTIONS are edges. Every one must be delivered exactly once. They are
       queued, never overwritten.

   Sequence numbers let the server ignore reordered/duplicated UDP-ish traffic
   and let the client reconcile its prediction against acknowledged input.
   ============================================================ */

// A client cannot bank actions to fire a burst later; anything beyond this in
// one tick is dropped. Generous for human play, tight enough to stop macros.
const MAX_ACTIONS_PER_TICK = 4;
// Hard cap on buffered actions, so a flooding client cannot grow memory.
const MAX_PENDING_ACTIONS = 16;

export class InputBuffer {
  constructor() {
    this.aimY = null;         // latest requested paddle center (level)
    this.aimAngle = null;     // latest requested held-ball aim angle (level)
    this.actions = [];        // pending discrete events (edges)
    this.lastSeq = 0;         // highest sequence number accepted
    this.ackSeq = 0;          // echoed back so the client can reconcile
    this.lastAimAt = 0;       // ms timestamp of the newest aim, for staleness
  }

  /**
   * Accept a validated input message.
   * Returns false if the packet was stale/duplicate and got ignored.
   */
  accept({ seq, y, am, action }, nowMs) {
    // Out-of-order or replayed packet: the newer state already supersedes it.
    // Actions still count, because dropping one loses a click forever; only
    // the aim level is order-sensitive.
    const fresh = typeof seq === 'number' && seq > this.lastSeq;

    if (fresh) {
      this.lastSeq = seq;
      this.ackSeq = seq;
      if (typeof y === 'number' && Number.isFinite(y)) {
        this.aimY = y;
        this.lastAimAt = nowMs;
      }
      /* Aim angle is a level too, so coalescing to the newest is correct. It
         is kept separate from aimY because a held ball freezes the paddle:
         during a catch the client keeps sending its paddle position, but the
         angle is the only part the simulation still acts on. */
      if (typeof am === 'number' && Number.isFinite(am)) {
        this.aimAngle = am;
      }
    }

    // Edge inputs are preserved regardless of ordering.
    if (action && this.actions.length < MAX_PENDING_ACTIONS) {
      this.actions.push(seq ?? this.lastSeq);
    }

    return fresh;
  }

  /** Drain the actions this tick should apply. */
  takeActions() {
    if (this.actions.length === 0) return 0;
    const n = Math.min(this.actions.length, MAX_ACTIONS_PER_TICK);
    this.actions.splice(0, n);
    return n;
  }

  /** True when no aim has arrived recently (peer stalled or dropped). */
  isStale(nowMs, thresholdMs = 1000) {
    return this.aimY === null || nowMs - this.lastAimAt > thresholdMs;
  }

  reset() {
    this.aimY = null;
    this.aimAngle = null;
    this.actions.length = 0;
    this.lastSeq = 0;
    this.ackSeq = 0;
    this.lastAimAt = 0;
  }
}
