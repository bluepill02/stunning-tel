/**
 * Subrwar – Daily Territory-Control Game for Reddit
 *
 * Game mechanics:
 *  - A shared COLS × ROWS grid lives in Redis, keyed by postId.
 *  - Each cell stores { owner: username | null, fort: boolean }.
 *  - Every user gets DAILY_ACTIONS actions per UTC-day (resets at midnight).
 *  - Claiming an empty cell costs 1 action.
 *  - Attacking an enemy cell costs 1 action; fortified cells need 2 attacks.
 *  - Fortifying your own cell costs 1 action (max 1 fort per cell).
 *  - A leaderboard (top 10 by tile count) is kept in a Redis sorted set.
 *  - The Phaser 3 web-client communicates via Devvit's realtime + message-passing API.
 */

import {
  Devvit,
  useState,
  useWebView,
} from "@devvit/public-api";

// ─── Constants ───────────────────────────────────────────────────────────────
const COLS = 30;
const ROWS = 20;
const DAILY_ACTIONS = 5;
const BOARD_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// ─── Type helpers ────────────────────────────────────────────────────────────
type Cell = { owner: string | null; fort: boolean };
type Board = Cell[][];

type DevvitMsg =
  | { type: "INIT_RESPONSE"; board: Board; username: string; actionsLeft: number; leaderboard: LeaderEntry[] }
  | { type: "UPDATE"; board: Board; actionsLeft: number; leaderboard: LeaderEntry[] }
  | { type: "ERROR"; message: string };

type WebMsg =
  | { type: "INIT" }
  | { type: "CLAIM"; col: number; row: number }
  | { type: "ATTACK"; col: number; row: number }
  | { type: "FORTIFY"; col: number; row: number };

type LeaderEntry = { username: string; tiles: number };

// ─── Redis helpers ────────────────────────────────────────────────────────────
function boardKey(postId: string) { return `subrwar:board:${postId}`; }
function actionsKey(postId: string, username: string, day: string) {
  return `subrwar:actions:${postId}:${username}:${day}`;
}
function leaderKey(postId: string) { return `subrwar:leader:${postId}`; }

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ owner: null, fort: false }))
  );
}

async function loadBoard(redis: Devvit.Context["redis"], postId: string): Promise<Board> {
  const raw = await redis.get(boardKey(postId));
  if (!raw) return emptyBoard();
  try {
    return JSON.parse(raw) as Board;
  } catch {
    return emptyBoard();
  }
}

async function saveBoard(redis: Devvit.Context["redis"], postId: string, board: Board): Promise<void> {
  await redis.set(boardKey(postId), JSON.stringify(board), { expiration: new Date(Date.now() + BOARD_TTL_SECONDS * 1000) });
}

async function getActionsLeft(redis: Devvit.Context["redis"], postId: string, username: string): Promise<number> {
  const key = actionsKey(postId, username, utcDay());
  const used = parseInt((await redis.get(key)) ?? "0", 10);
  return Math.max(0, DAILY_ACTIONS - used);
}

async function consumeAction(redis: Devvit.Context["redis"], postId: string, username: string): Promise<boolean> {
  const key = actionsKey(postId, username, utcDay());
  const used = parseInt((await redis.get(key)) ?? "0", 10);
  if (used >= DAILY_ACTIONS) return false;
  // Set with 48-hour TTL so old keys clean up automatically
  await redis.set(key, String(used + 1), { expiration: new Date(Date.now() + 48 * 60 * 60 * 1000) });
  return true;
}

async function getLeaderboard(redis: Devvit.Context["redis"], postId: string): Promise<LeaderEntry[]> {
  try {
    const raw = await redis.get(leaderKey(postId));
    if (!raw) return [];
    return JSON.parse(raw) as LeaderEntry[];
  } catch {
    return [];
  }
}

async function updateLeaderboard(redis: Devvit.Context["redis"], postId: string, board: Board): Promise<void> {
  const counts: Record<string, number> = {};
  for (const row of board) {
    for (const cell of row) {
      if (cell.owner) counts[cell.owner] = (counts[cell.owner] ?? 0) + 1;
    }
  }
  const entries: LeaderEntry[] = Object.entries(counts)
    .map(([username, tiles]) => ({ username, tiles }))
    .sort((a, b) => b.tiles - a.tiles)
    .slice(0, 10);
  await redis.set(leaderKey(postId), JSON.stringify(entries), { expiration: new Date(Date.now() + BOARD_TTL_SECONDS * 1000) });
}

// ─── Devvit configuration ─────────────────────────────────────────────────────
Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
});

// ─── Custom post type ─────────────────────────────────────────────────────────
Devvit.addCustomPostType({
  name: "Subrwar",
  description: "Daily territory-control game",
  height: "tall",

  render: (context) => {
    const { redis, postId, userId } = context;

    const [username] = useState<string>(async () => {
      if (!userId) return "anonymous";
      try {
        const user = await context.reddit.getUserById(userId);
        return user?.username ?? "anonymous";
      } catch {
        return "anonymous";
      }
    });

    const webView = useWebView<WebMsg, DevvitMsg>({
      url: "index.html",

      async onMessage(msg, webView) {
        if (!postId) return;

        if (msg.type === "INIT") {
          const [board, actionsLeft, leaderboard] = await Promise.all([
            loadBoard(redis, postId),
            getActionsLeft(redis, postId, username),
            getLeaderboard(redis, postId),
          ]);
          webView.postMessage({
            type: "INIT_RESPONSE",
            board,
            username,
            actionsLeft,
            leaderboard,
          });
          return;
        }

        // All mutating actions share the same flow
        const { col, row } = msg as { type: string; col: number; row: number };
        if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
          webView.postMessage({ type: "ERROR", message: "Out of bounds." });
          return;
        }

        const board = await loadBoard(redis, postId);
        const cell = board[row][col];

        if (msg.type === "CLAIM") {
          if (cell.owner !== null) {
            webView.postMessage({ type: "ERROR", message: "Cell already owned." });
            return;
          }
          if (!(await consumeAction(redis, postId, username))) {
            webView.postMessage({ type: "ERROR", message: "No actions left today." });
            return;
          }
          board[row][col] = { owner: username, fort: false };
        } else if (msg.type === "ATTACK") {
          if (!cell.owner || cell.owner === username) {
            webView.postMessage({ type: "ERROR", message: "Nothing to attack." });
            return;
          }
          if (!(await consumeAction(redis, postId, username))) {
            webView.postMessage({ type: "ERROR", message: "No actions left today." });
            return;
          }
          if (cell.fort) {
            // First hit removes fort
            board[row][col] = { owner: cell.owner, fort: false };
          } else {
            // Second hit (or unfortified) captures the cell
            board[row][col] = { owner: username, fort: false };
          }
        } else if (msg.type === "FORTIFY") {
          if (cell.owner !== username) {
            webView.postMessage({ type: "ERROR", message: "You don't own this cell." });
            return;
          }
          if (cell.fort) {
            webView.postMessage({ type: "ERROR", message: "Already fortified." });
            return;
          }
          if (!(await consumeAction(redis, postId, username))) {
            webView.postMessage({ type: "ERROR", message: "No actions left today." });
            return;
          }
          board[row][col] = { owner: username, fort: true };
        }

        await saveBoard(redis, postId, board);
        await updateLeaderboard(redis, postId, board);

        const [actionsLeft, leaderboard] = await Promise.all([
          getActionsLeft(redis, postId, username),
          getLeaderboard(redis, postId),
        ]);

        webView.postMessage({ type: "UPDATE", board, actionsLeft, leaderboard });
      },

      onUnmount() {},
    });

    return (
      <vstack height="100%" width="100%" alignment="center middle">
        <webview
          id="subrwar-game"
          url="index.html"
          width="100%"
          height="100%"
          grow
        />
      </vstack>
    );
  },
});

// ─── Menu item to create a new Subrwar post ───────────────────────────────────
Devvit.addMenuItem({
  label: "Start a Subrwar Game",
  location: "subreddit",
  async onPress(event, context) {
    const subreddit = await context.reddit.getCurrentSubreddit();
    await context.reddit.submitPost({
      title: `⚔️ Subrwar – Conquer the Grid! [${new Date().toLocaleDateString()}]`,
      subredditName: subreddit.name,
      preview: (
        <vstack height="100%" width="100%" alignment="center middle" backgroundColor="#1a1a2e">
          <text color="white" size="xlarge" weight="bold">⚔️ SUBRWAR</text>
          <text color="#e0e0e0" size="medium">Loading battle map…</text>
        </vstack>
      ),
    });
    context.ui.showToast("Subrwar game created! 🎮");
  },
});

export default Devvit;
