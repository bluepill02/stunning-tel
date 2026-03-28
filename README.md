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

### Engagement & Retention Features

**🏆 Achievement System**
- 11 unique achievements to unlock (First Blood, Conqueror, Warlord, etc.)
- Real-time achievement notifications with animated popups
- Achievement badges displayed in-game
- Earn karma rewards for unlocking achievements

**📊 Player Statistics**
- Track total tiles claimed, attacks, and fortifications
- Monitor your longest and current login streak
- Visual stats panel with real-time updates
- Comprehensive karma earning system

**🔥 Daily Streaks & Rewards**
- Login daily to maintain your streak
- Unlock streak-based achievements (3, 7, 30 days)
- Streak counter displayed prominently in HUD
- Daily action resets encourage regular engagement

**💰 Karma Integration**
- Earn karma for every action: +1 for claims, +2 for attacks, +1 for fortifications
- Bonus karma for unlocking achievements (+10 each)
- Karma displayed in HUD with eye-catching gradient badge
- Potential Reddit karma integration for rewards

**🎨 Visual Enhancements**
- Animated cell capture effects with flash and ripple animations
- Glowing fort indicators with pulsing effects
- Pulsing action counter badge
- Medals (🥇🥈🥉) for top 3 leaderboard positions
- Smooth animations and particle effects for actions

### Why it drives retention
- **Daily action cap** — users come back every day to spend their 5 moves
- **Asynchronous PvP** — every move you make is a permanent threat to others
- **Live leaderboard** — top 10 tile-holders shown in real time with medals
- **Social stakes** — subreddit communities can coordinate to protect territory
- **Achievement hunting** — 11 unique achievements encourage long-term play
- **Streak mechanics** — daily login rewards create habit formation
- **Visual feedback** — satisfying animations make every action feel impactful
- **Progress tracking** — comprehensive stats dashboard shows growth over time

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