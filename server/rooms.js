import { ROOM_CODE_LENGTH } from './config.js';

const rooms = new Map();

function createCode() {
  return Math.random().toString(36).slice(2, 2 + ROOM_CODE_LENGTH).toUpperCase();
}

export function createRoom(host) {
  let code;
  do { code = createCode(); } while (rooms.has(code));
  // `match` holds the authoritative simulation once the host starts play.
  const room = { code, host, guest: null, match: null };
  rooms.set(code, room);
  return room;
}

export function findRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

export function joinRoom(room, guest) {
  if (room.guest) return false;
  room.guest = guest;
  return true;
}

export function roomForSocket(socket) {
  for (const room of rooms.values()) {
    if (room.host === socket || room.guest === socket) return room;
  }
  return null;
}

export function removeSocket(socket) {
  const room = roomForSocket(socket);
  if (!room) return null;
  const other = room.host === socket ? room.guest : room.host;
  const { match } = room;
  room.match = null;
  rooms.delete(room.code);
  // The caller stops the match: rooms.js stays free of simulation concerns.
  return { code: room.code, other, match };
}

export const roomCount = () => rooms.size;
