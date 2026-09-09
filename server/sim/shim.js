'use strict';

/* ============================================================
   Headless browser shim

   The game's simulation files (core/ai/gameplay/powerups/update) are classic
   global scripts written for a browser. They are loaded verbatim on the server
   inside a `vm` context so there is exactly ONE source of truth for physics —
   no port, no drift, no build step.

   This module fabricates the small surface of browser globals those files
   touch at load time or during a tick. Everything here is inert: audio nodes
   do nothing, canvas measurements return fixed numbers, and DOM lookups return
   a permissive stub. Nothing in the simulation path depends on their effects.

   Deliberately NOT stubbed: anything that would let render/ui code run. Those
   files are never loaded server-side.
   ============================================================ */

// A stub that tolerates any property access, call, or assignment. DOM code in
// core.js (endMatch writing result text, style objects) runs against this
// without special-casing every element it happens to touch.
function makePermissiveStub() {
  const target = function () { return makePermissiveStub(); };
  target.textContent = '';
  target.style = {};
  return new Proxy(target, {
    get(obj, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'style') return obj.style;
      if (prop === 'textContent') return obj.textContent;
      if (prop in obj) return obj[prop];
      return makePermissiveStub();
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
    apply() { return makePermissiveStub(); },
  });
}

// WebAudio stub. Every method returns a node that can be connected onward, so
// the audio graph in core.js builds without error and produces no sound.
function makeAudioNode() {
  const node = {
    connect: () => makeAudioNode(),
    disconnect: () => {},
    start: () => {}, stop: () => {},
    gain: { value: 1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, linearRampToValueAtTime: () => {} },
    frequency: { value: 440, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
    type: 'sine',
    buffer: null,
    playbackRate: { value: 1 },
  };
  return node;
}

class HeadlessAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = makeAudioNode();
  }
  createBuffer(channels, length) {
    return { getChannelData: () => new Float32Array(length), duration: length / this.sampleRate };
  }
  createGain() { return makeAudioNode(); }
  createOscillator() { return makeAudioNode(); }
  createConvolver() { return makeAudioNode(); }
  createBiquadFilter() { return makeAudioNode(); }
  createBufferSource() { return makeAudioNode(); }
  decodeAudioData() { return Promise.resolve(this.createBuffer(2, 1)); }
  resume() { this.state = 'running'; return Promise.resolve(); }
}

/**
 * Build a fresh set of browser globals for one vm context.
 * Each match gets its own context, so nothing is shared between rooms.
 */
export function createBrowserShim() {
  const shim = {};

  shim.window = shim;
  shim.globalThis = shim;
  shim.self = shim;

  shim.document = {
    getElementById: () => makePermissiveStub(),
    querySelector: () => makePermissiveStub(),
    querySelectorAll: () => [],
    createElement: () => makePermissiveStub(),
    addEventListener: () => {},
    body: makePermissiveStub(),
  };

  shim.AudioContext = HeadlessAudioContext;
  shim.webkitAudioContext = HeadlessAudioContext;

  shim.devicePixelRatio = 1;
  // Samples are never fetched server-side; a rejected promise marks them
  // 'failed' in core.js, which is harmless because sfx is neutralised anyway.
  shim.fetch = () => Promise.reject(new Error('headless'));

  shim.console = console;

  // Math, Date and JSON are deliberately NOT injected. A vm context already
  // supplies its own intrinsics, and passing the host's objects in would share
  // one Math across every match: patching Math.random for a seeded/replayable
  // match would then corrupt other rooms AND the server process itself.
  // Leaving them out gives each match genuinely isolated intrinsics.

  // Timers: core.js schedules layered beeps with setTimeout. Keep them as
  // no-ops so a match never holds the event loop open with audio callbacks.
  shim.setTimeout = () => 0;
  shim.clearTimeout = () => {};
  shim.setInterval = () => 0;
  shim.clearInterval = () => {};
  shim.requestAnimationFrame = () => 0;

  // The simulation must be driven by the server's fixed timestep, never by a
  // wall clock. performance.now() is only used for cosmetic `born` timestamps,
  // but routing it through the shim keeps the sim fully deterministic per tick.
  shim.__now = 0;
  shim.performance = { now: () => shim.__now };

  // Debug channels off: per-match console spam would flood server logs.
  shim.PONG_DEBUG = { ai: false, game: false, events: false, powerups: false };

  return shim;
}
