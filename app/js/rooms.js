'use strict';

/* Same-origin room lobby. The host site serves /ws; players never enter a URL. */
const roomClient = { socket: null, code: '', role: null, ready: false };

function roomStatus(message, level = 'info') {
  debugLog('game', `ROOM: ${message}`, { level, code: roomClient.code || null });
  window.dispatchEvent(new CustomEvent('pong-room-status', { detail: { message, level } }));
}

function roomSocketUrl() {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

function roomSend(payload) {
  if (roomClient.socket?.readyState === WebSocket.OPEN) {
    roomClient.socket.send(JSON.stringify({ type: 'relay', payload }));
  }
}

function roomDisconnect() {
  const socket = roomClient.socket;
  // Detach first: a deliberate exit shouldn't raise "disconnected" warnings.
  if (socket) { socket.onclose = socket.onerror = socket.onmessage = null; socket.close(); }
  Object.assign(roomClient, { socket: null, code: '', role: null, ready: false });
  netStop();
}

function roomStart() {
  if (roomClient.role !== 'host' || !roomClient.ready) return false;
  roomClient.socket.send(JSON.stringify({ type: 'start', settings: netSettings() }));
  return true;
}

function roomConnect(action, code = '') {
  roomDisconnect();
  roomStatus('CONNECTING…');
  const socket = roomClient.socket = new WebSocket(roomSocketUrl());
  socket.onopen = () => socket.send(JSON.stringify({ type: action, code }));
  socket.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }

    if (message.type === 'room-created' || message.type === 'room-joined') {
      roomClient.code = message.code;
      roomClient.role = message.role;
      roomClient.ready = message.type === 'room-joined';
      roomStatus(roomClient.role === 'host' ? 'WAITING FOR A PLAYER TO JOIN' : 'CONNECTED — WAITING FOR HOST');
    } else if (message.type === 'peer-ready') {
      roomClient.ready = true;
      // Send the current lobby configuration to the newly joined guest.
      if (roomClient.role === 'host') netBroadcastSettings();
      roomStatus(roomClient.role === 'host' ? 'PLAYER CONNECTED — READY TO START' : 'CONNECTED — WAITING FOR HOST');
    } else if (message.type === 'match-start') {
      if (roomClient.role === 'guest') netApplySettings(message.settings);
      netStart(roomClient.role);
      window.dispatchEvent(new CustomEvent('pong-room-start'));
    } else if (message.type === 'relay') {
      netHandleMessage(message.payload);
    } else if (message.type === 'peer-left') {
      // The server deletes the room when either side drops, so this client is
      // no longer in a room: clear the role to restore full menu control.
      const wasHost = roomClient.role === 'host';
      roomClient.socket.onclose = null;
      roomClient.socket.close();
      Object.assign(roomClient, { socket: null, code: '', role: null, ready: false });
      netStop();
      roomStatus(wasHost ? 'PLAYER LEFT — ROOM CLOSED' : 'HOST LEFT — ROOM CLOSED', 'warn');
      window.dispatchEvent(new CustomEvent('pong-room-ended'));
    } else if (message.type === 'error') {
      roomStatus(message.message || 'ROOM ERROR', 'error');
    }
  };
  socket.onerror = () => roomStatus('CANNOT REACH SERVER', 'error');
  socket.onclose = () => {
    if (roomClient.socket !== socket) return;
    Object.assign(roomClient, { socket: null, code: '', role: null, ready: false });
    netStop();
    roomStatus('DISCONNECTED', 'warn');
    window.dispatchEvent(new CustomEvent('pong-room-ended'));
  };
}
