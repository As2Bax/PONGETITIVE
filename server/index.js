import http from 'node:http';
import { PORT } from './config.js';
import { roomCount } from './rooms.js';
import { attachRoomProtocol } from './protocol.js';

const server = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', rooms: roomCount() }));
});

attachRoomProtocol(server);
server.listen(PORT, () => console.info(`PONGETITIVE room server listening on :${PORT}`));
