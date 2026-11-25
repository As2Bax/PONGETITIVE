# PONGETITIVE

**Pong, taken *way* too far.**

Two paddles and a ball; then *special balls, power-ups, gravity wells, closing walls, five game modes, an AI that plays to win, and **online head-to-head matches.***

Browser game on HTML5 Canvas. **No frameworks, no build step, no browser dependencies.** Clone it, open it, play.

> [!WARNING]
> This project is super duper obviously vibe-coded;
> I made this project for fun and it is highly unrecommended to use this commercially.

https://github.com/user-attachments/assets/cdc7c442-bcb8-4540-a804-d327936eb622

https://github.com/user-attachments/assets/fae828d8-1a88-47c9-a72a-f8f82776aee9

https://github.com/user-attachments/assets/9d41041e-46bf-41fe-9025-24ed5c31b168

## ⚡ Quick start

### ▶ **[Play PONGETITIVE at pongetitive.as2bax.dev](https://pongetitive.as2bax.dev)**

Nothing to install; solo, AI-vs-AI, and online rooms all run in the browser.

---

Or run it yourself. Nothing to compile either way:

**Single-player** - static files, needs [Node.js](https://nodejs.org) 18+:

```bash
npm run dev        # http://localhost:8280
```

**Player-vs-Player** - also runs the room server, needs [Docker](https://docs.docker.com/get-docker/):

```bash
docker compose up -d      # http://localhost:8280
```

## 🎮 Controls

| Action | Input |
|---|---|
| Move | Mouse, `W`/`S`, or `↑`/`↓` |
| Smash | Left-click just before contact |
| Pause | `P` or `Esc` |
| Mute | `M` |


## 🖥️ The game

### 🎭 Modes

| Mode | What it is |
|---|---|
| **Classic** | Timed match; most points when the clock runs out |
| **Survival** | 3 lives, escalating waves every 20s, hearts to heal |
| **Endless** | No clock, no winner; play until you quit |
| **Chaos** | 3+ balls, bumpers, ball rain, power-ups everywhere |
| **Royale** | Closing walls, moving bumpers, ball storms, non-stop |

### ❓ What's on the field

**Special balls**: gold (3 pts), phantom (2 pts, blinks out of sight), comet (2 pts, small and fast), heavy (slow tank), splitter (splits on its first paddle hit). Any ball at top speed ignites and is worth at least 2.

**Power-ups**: big paddle, shrink opponent, multiball, ball storm, slow-mo, ghost paddle (an AI helper on your side), catch zone (grab the ball, aim it, fire it back), and flip (swaps the whole arena mid-match).

**Arena events**: gravity wells that bend ball paths, teleport portals, and wind gusts. Which ones appear scales with difficulty.

**Rally combo**: the longer a rally survives, the higher the speed cap climbs.

### 🎯 Difficulty

Difficulty handicaps **you**, not just the AI: paddle size, ball speed, fog that hides the ball, paddle wear, and control inversion.

Seven tiers from **Relaxed** to **Impossible**, plus **Custom**: where every ball type, power-up, arena event, curse, and AI skill level is individually toggleable.

### 🎨 Colors

Each side's color is yours to pick from an eight-color palette (bone, ember, amber, moss, teal, slate, violet, rose). Your choice is saved locally and drives the whole UI: paddles, goal zones, scores, menu accents, and the title.

Colors are a local preference: in an online match each player keeps their own, and both still see themselves on the right.

## 🖥️ Running it

The stack is two containers:

- **web**: Nginx serves the game and proxies same-origin `/ws`.
- **server**: Node/WebSocket service owning Player-vs-Player rooms.

```bash
docker compose up -d     # http://localhost:8280
docker compose down
```

Only the web container is published; the room service stays on Docker's internal network.

### 🐬⛔ Without Docker

Single-player needs nothing but a static server:

```bash
npm run dev        # serves app/ at http://localhost:8280
```

Edit anything in `app/` and refresh. There's nothing to compile.

To run just the room server (port 8280):

```bash
npm install
npm start
```

Player-vs-Player is the one thing that *needs* Compose, because it requires the room server behind a same-origin `/ws` proxy, which is exactly what the nginx container provides.

### 🪂 Deploying

Deploy the Compose stack to any Docker-capable host that supports persistent WebSockets. For public HTTPS, terminate TLS at a reverse proxy in front of the `web` container; the browser then upgrades `/ws` to secure `wss://` automatically.

Set the origin allowlist in production by editing `PONG_ALLOWED_ORIGINS` on the `server` service in `docker-compose.yml`:

```yaml
    environment:
      PONG_ALLOWED_ORIGINS: "https://example.com"
```

Leaving it empty allows any origin, which is convenient locally but not what you want on a public host.

## License

[MIT](LICENSE)
