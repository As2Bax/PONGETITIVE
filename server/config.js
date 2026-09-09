export const PORT = Number(process.env.PORT || 8280);
export const ROOM_CODE_LENGTH = 6;

// A match with nobody connected should not keep simulating forever.
export const MATCH_IDLE_TIMEOUT_MS = 60_000;

/* ---------- security limits ---------- */
// Largest accepted frame. Snapshots are a few KB at most; anything larger is
// either a bug or an attempt to exhaust memory.
export const MAX_PAYLOAD_BYTES = 64 * 1024;

// Gameplay runs at 60 Hz in each direction; allow headroom, then throttle.
export const RELAY_RATE = 150;        // sustained relay messages per second
export const RELAY_BURST = 300;
// Lobby actions (create/join/start) should be rare and deliberate.
export const CONTROL_RATE = 5;        // sustained control messages per second
export const CONTROL_BURST = 15;

export const MAX_ROOMS = 500;             // global cap on live rooms
export const MAX_SOCKETS_PER_IP = 12;     // blunt anti-abuse guard
export const HEARTBEAT_MS = 30_000;       // reap dead connections

// Empty list = allow any origin (useful for local development). Set
// PONG_ALLOWED_ORIGINS="https://example.com,https://www.example.com" in prod.
export const ALLOWED_ORIGINS = (process.env.PONG_ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);
