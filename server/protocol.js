import { WebSocketServer } from 'ws';
import { createRoom, findRoom, joinRoom, removeSocket, roomForSocket, roomCount } from './rooms.js';
import { sanitizeRelay, sanitizeSettings, validRoomCode } from './validate.js';
import { createBucket, takeToken, addConnection, releaseConnection } from './limits.js';
import {
  ALLOWED_ORIGINS, CONTROL_BURST, CONTROL_RATE, HEARTBEAT_MS, MAX_PAYLOAD_BYTES,
  MAX_ROOMS, MAX_SOCKETS_PER_IP, RELAY_BURST, RELAY_RATE,
} from './config.js';

function send(socket, message) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function reject(socket, message) {
  send(socket, { type: 'error', message });
}

function clientIp(req) {
  // Trust the proxy hop only for the address; never for identity decisions.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function originAllowed(req) {
  if (ALLOWED_ORIGINS.length === 0) return true;   // unset = allow (dev default)
  return ALLOWED_ORIGINS.includes(req.headers.origin);
}

export function attachRoomProtocol(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_PAYLOAD_BYTES,
    verifyClient: ({ req }, done) => {
      if (!originAllowed(req)) return done(false, 403, 'Forbidden origin');
      done(true);
    },
  });

  wss.on('connection', (socket, req) => {
    const ip = clientIp(req);
    if (!addConnection(ip, MAX_SOCKETS_PER_IP)) {
      reject(socket, 'Too many connections');
      return socket.close(1008, 'Too many connections');
    }

    // Session state is held server-side only. The client never tells the server
    // who it is: identity is derived from the socket that owns the room slot.
    const session = {
      ip,
      control: createBucket(CONTROL_RATE, CONTROL_BURST),
      relay: createBucket(RELAY_RATE, RELAY_BURST),
    };

    socket.isDead = false;
    socket.on('pong', () => { socket.isDead = false; });

    socket.on('message', (raw) => {
      if (raw.length > MAX_PAYLOAD_BYTES) return socket.close(1009, 'Payload too large');

      let message;
      try { message = JSON.parse(raw); }
      catch { return reject(socket, 'Invalid message'); }
      if (typeof message !== 'object' || message === null) return reject(socket, 'Invalid message');

      const isRelay = message.type === 'relay';
      if (!takeToken(isRelay ? session.relay : session.control)) {
        return reject(socket, 'Rate limit exceeded');
      }

      // The room a socket belongs to is authoritative; a client cannot name a
      // room it has not joined, so cross-room injection is impossible.
      const room = roomForSocket(socket);

      if (message.type === 'create') {
        if (room) return reject(socket, 'Already in a room');
        if (roomCount() >= MAX_ROOMS) return reject(socket, 'Server is full');
        const created = createRoom(socket);
        send(socket, { type: 'room-created', code: created.code, role: 'host' });
        console.info(`[ROOM] Created ${created.code}`);
        return;
      }

      if (message.type === 'join') {
        if (room) return reject(socket, 'Already in a room');
        if (!validRoomCode(message.code)) return reject(socket, 'Invalid room code');
        const target = findRoom(message.code);
        if (!target) return reject(socket, 'Room not found');
        if (target.host === socket) return reject(socket, 'Cannot join your own room');
        if (!joinRoom(target, socket)) return reject(socket, 'Room is full');
        send(socket, { type: 'room-joined', code: target.code, role: 'guest' });
        send(target.host, { type: 'peer-ready' });
        send(socket, { type: 'peer-ready' });
        console.info(`[ROOM] ${target.code} ready`);
        return;
      }

      if (message.type === 'start') {
        // Only the socket that owns the host slot may start the match.
        if (!room || room.host !== socket) return reject(socket, 'Only the host can start');
        if (!room.guest) return reject(socket, 'Waiting for another player');
        const settings = sanitizeSettings(message.settings);
        if (!settings) return reject(socket, 'Invalid settings');
        const start = { type: 'match-start', settings };
        send(room.host, start);
        send(room.guest, start);
        console.info(`[ROOM] ${room.code} match started`);
        return;
      }

      if (isRelay) {
        if (!room) return;
        // Role decides which payloads are legal: a guest cannot forge snapshots
        // or settings, and a host cannot forge the guest's input.
        const role = room.host === socket ? 'host' : 'guest';
        const payload = sanitizeRelay(message.payload, role);
        if (!payload) return;
        const other = role === 'host' ? room.guest : room.host;
        if (other) send(other, { type: 'relay', payload });
        return;
      }

      reject(socket, 'Unknown message type');
    });

    socket.on('close', () => {
      releaseConnection(session.ip);
      const removed = removeSocket(socket);
      if (!removed) return;
      if (removed.other) send(removed.other, { type: 'peer-left' });
      console.info(`[ROOM] Removed ${removed.code}`);
    });

    socket.on('error', () => socket.terminate());
  });

  // Drop half-open connections so abandoned rooms are always released.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.isDead) { socket.terminate(); continue; }
      socket.isDead = true;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}
