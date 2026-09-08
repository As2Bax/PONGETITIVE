# PONG

## !!! This project is SEVERELY vibe-coded; please take this project for fun and DO NOT use this for professional purposes; I did not test or ensure this is prod ready. !!!

A browser-based Pong game.

## Run with Docker Compose

The application runs as two containers:

- **web** — Nginx serves the game and proxies same-origin `/ws` requests.
- **room-server** — Node/WebSocket service owns Player-vs-Player rooms.

```bash
docker compose up --build
```

Open [http://localhost:8080](http://localhost:8080). Only the web container is exposed publicly; the room service stays on Docker's internal network.

```bash
docker compose down
```

## Deploy

Deploy the Compose stack to any Docker-capable host with persistent WebSocket support. For public HTTPS deployments, terminate TLS at a reverse proxy/load balancer in front of the `web` container; the browser will then automatically use secure `wss://` connections for `/ws`.

```text
app/                       # browser game (static)
├── index.html
├── style.css
└── js/
    ├── core.js            # config, state, audio, match lifecycle
    ├── ai.js              # opponent brains
    ├── gameplay.js        # input, physics, collisions
    ├── powerups.js        # pickup spawning and effects
    ├── update.js          # update loop and field events
    ├── render.js          # canvas rendering and HUD
    ├── net.js             # host-authoritative netcode
    ├── rooms.js           # room lobby client
    └── ui.js              # menus, controls, bootstrap

server/                    # WebSocket room service
├── config.js              # environment/configuration
├── rooms.js               # in-memory room lifecycle
├── protocol.js            # WebSocket message protocol
├── validate.js            # payload/settings validation
├── limits.js              # rate limiting and connection caps
└── index.js               # HTTP/WebSocket entry point

docker/
├── Dockerfile.web         # Nginx web image
├── Dockerfile.server      # Node room-service image
└── nginx.conf             # same-origin /ws proxy
docker-compose.yml         # two-container stack
```

## Player vs Player rooms

Choose **PLAYER VS PLAYER** under Opponent, then create a room or enter a room code. The lobby is backed by the site’s own `/ws` endpoint, so players never enter a server URL.

Matches are **host-authoritative**:

- The host simulates the match and broadcasts state snapshots.
- The guest predicts its own paddle locally, sends input, and renders the host's state.
- Each player sees themselves on the right; the guest's view is mirrored.
- Only the host controls match settings and starts the game.

> Because the host runs the simulation, a modified host client could cheat its opponent. Moving simulation server-side would be required for competitive integrity.

## Server security

The room service treats every client as untrusted:

- **Identity comes from the socket.** A client never states who it is; its role is derived from the room slot its connection owns, so it cannot act on a room it has not joined.
- **Role-checked messages.** Only the host socket can start a match or send snapshots/settings; only the guest socket can send input.
- **Validated payloads.** Settings are rebuilt from whitelists, and unknown fields are dropped. Snapshot arrays are length-capped.
- **Rate limiting.** Separate token buckets for gameplay and lobby actions.
- **Connection limits.** Max payload size, per-IP connection cap, global room cap, and a heartbeat that reaps dead sockets.
- **Origin allowlist.** Set `PONG_ALLOWED_ORIGINS` in production:

```bash
PONG_ALLOWED_ORIGINS="https://example.com"
```

Leaving it unset allows any origin, which is convenient for local development. See `.env.example` for the supported variables.

## Local development without Docker

```bash
npm install
npm start
```

This runs only the room server on port 8080. Serve `app/` separately (any static server) and proxy `/ws` to the room server, or just use Docker Compose, which wires both together.

## License

[MIT](LICENSE)

## Debug logs

Browser console diagnostics are enabled by default. Toggle individual channels in DevTools:

```js
PONG_DEBUG.ai = false
PONG_DEBUG.events = false
PONG_DEBUG.powerups = false
PONG_DEBUG.game = false
```
