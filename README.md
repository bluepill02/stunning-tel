# ⚔️ Subrwar — Daily Territory-Control Game for Reddit

**Subrwar** is a [Devvit](https://developers.reddit.com/) app built with [Phaser 3](https://phaser.io/) that lets Reddit users compete to conquer tiles on a shared grid — directly inside any subreddit post.

---

## 🎮 Game Concept

A **30 × 20 shared grid** is tied to each Reddit post.  Every logged-in user gets **5 actions per day** (resets at UTC midnight) they can spend on:

| Action | Cost | Description |
|--------|------|-------------|
| 🚩 Claim | 1 | Capture an empty cell |
| ⚔️ Attack | 1 | Attack an enemy cell (remove fort first, then capture) |
| 🛡 Fortify | 1 | Shield one of your cells — it takes 2 hits to capture |

### Why it drives retention
- **Daily action cap** — users come back every day to spend their 5 moves.
- **Asynchronous PvP** — every move you make is a permanent threat to others.
- **Live leaderboard** — top 10 tile-holders shown in real time.
- **Social stakes** — subreddit communities can coordinate to protect territory.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js ≥ 18](https://nodejs.org/)
- [Devvit CLI](https://developers.reddit.com/docs/cli): `npm i -g devvit`
- A Reddit account with developer access

### Install & run locally
```bash
npm install
npm run dev        # starts a Devvit playtest session
```

### Upload to Reddit
```bash
npm run upload
```

Then go to any subreddit you moderate, click **"Start a Subrwar Game"** from the subreddit menu to post a new game instance.

---

## 🏗️ Architecture

```
subrwar/
├── devvit.yaml          # Devvit app manifest
├── package.json
├── tsconfig.json
├── src/
│   └── main.tsx         # Devvit server — Redis state, game logic, custom post
└── webroot/
    └── index.html       # Phaser 3 game client (single-file)
```

### Data model (Redis)
| Key pattern | Value | Notes |
|-------------|-------|-------|
| `subrwar:board:{postId}` | JSON `Cell[][]` | 30-day TTL |
| `subrwar:actions:{postId}:{user}:{YYYY-MM-DD}` | integer used | 48-hour TTL |
| `subrwar:leader:{postId}` | JSON top-10 array | 30-day TTL |

`Cell = { owner: string | null, fort: boolean }`

### Communication
The Phaser client sends `{ type: 'CLAIM'|'ATTACK'|'FORTIFY'|'INIT', col, row }` messages to the Devvit server via `window.parent.postMessage`. The server validates, mutates Redis state, then replies with the updated board + leaderboard.

---

## 🎨 Visual Design
- Dark space theme (`#1a1a2e`) with vibrant accent colours.
- **Cyan** cells = your territory; **purple** = your fortified cells.
- **Red** cells = enemies; **hot-pink** = enemy fortified.
- **Gold** dot inside a cell = fortified marker.
- Hover highlight + right-click context menu for full action control.
- Fully responsive — scales to any viewport via Phaser's `RESIZE` mode.