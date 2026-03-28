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
  SettingScope,
  useChannel,
  useState,
  useWebView,
} from "@devvit/public-api";

// ─── Constants ───────────────────────────────────────────────────────────────
const COLS = 30;
const ROWS = 20;
const DAILY_ACTIONS = 5;
const BOARD_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const THREADFRONT_DAILY_TICK_JOB = 'threadfront_daily_tick';

// Power-up constants
const POWERUP_NUKE_COST = 3; // Destroys 3x3 area
const POWERUP_SHIELD_COST = 2; // Protects 3x3 area for 24h
const POWERUP_VISION_COST = 1; // Reveals enemy fort status in radius
const POWERUP_RAPID_COST = 2; // +3 actions for 1 hour

// ─── Type helpers ────────────────────────────────────────────────────────────
type Cell = { owner: string | null; fort: boolean; shield?: boolean; shieldExpiry?: number };
type Board = Cell[][];

type PowerUp = 'NUKE' | 'SHIELD' | 'VISION' | 'RAPID';
type Achievement = {
  id: string;
  name: string;
  description: string;
  icon: string;
  unlockedAt?: number;
};

type PlayerStats = {
  totalTilesClaimed: number;
  totalAttacks: number;
  totalFortifications: number;
  longestStreak: number;
  currentStreak: number;
  lastLoginDate: string;
  achievements: Achievement[];
  allianceId?: string;
  powerUpsUsed: number;
  karmaEarned: number;
};

type Alliance = {
  id: string;
  name: string;
  members: string[];
  color: string;
  createdAt: number;
};

type DevvitMsg =
  | { type: "INIT_RESPONSE"; board: Board; username: string; actionsLeft: number; leaderboard: LeaderEntry[]; stats: PlayerStats; achievements: Achievement[]; alliance?: Alliance }
  | { type: "UPDATE"; board: Board; actionsLeft: number; leaderboard: LeaderEntry[]; stats: PlayerStats; achievements: Achievement[] }
  | { type: "BOARD_UPDATE"; board: Board; leaderboard: LeaderEntry[] }
  | { type: "ERROR"; message: string }
  | { type: "ACHIEVEMENT_UNLOCKED"; achievement: Achievement };

type WebMsg =
  | { type: "INIT" }
  | { type: "CLAIM"; col: number; row: number }
  | { type: "ATTACK"; col: number; row: number }
  | { type: "FORTIFY"; col: number; row: number }
  | { type: "USE_POWERUP"; powerup: PowerUp; col: number; row: number }
  | { type: "JOIN_ALLIANCE"; allianceId: string }
  | { type: "CREATE_ALLIANCE"; name: string };

type LeaderEntry = { username: string; tiles: number; alliance?: string };

type SectorRealtimeMsg = { type: 'BOARD_UPDATE'; board: Board; leaderboard: LeaderEntry[] };

// ─── Threadfront (campaign season) helpers ───────────────────────────────────
type PostKind = 'SECTOR' | 'HQ';

type SectorInfo = {
  postId: string;
  title: string;
  createdAt: number; // epoch millis
};

type ActiveSeason = {
  seasonId: string;
  startedAt: number; // epoch millis
  hqPostId: string;
  sectors: SectorInfo[];
  tickJobId?: string;
  lastTickAt?: number;
};

// ─── Redis helpers ────────────────────────────────────────────────────────────
function boardKey(postId: string) { return `subrwar:board:${postId}`; }
function actionsKey(postId: string, username: string, day: string) {
  return `subrwar:actions:${postId}:${username}:${day}`;
}
function leaderKey(postId: string) { return `subrwar:leader:${postId}`; }
function postKindKey(postId: string) { return `subrwar:postkind:${postId}`; }
function activeSeasonKey(subredditId: string) { return `subrwar:season:active:${subredditId}`; }
function sectorSeasonKey(postId: string) { return `subrwar:sector:season:${postId}`; }
function seasonLeaderKey(subredditId: string) { return `subrwar:season:leader:${subredditId}`; }
function seasonTickJobKey(subredditId: string) { return `subrwar:season:tickJob:${subredditId}`; }

// New Redis keys for engagement features
function playerStatsKey(username: string) { return `subrwar:stats:${username}`; }
function allianceKey(allianceId: string) { return `subrwar:alliance:${allianceId}`; }
function alliancesListKey() { return `subrwar:alliances:list`; }
function playerAllianceKey(username: string) { return `subrwar:player:alliance:${username}`; }
function streakKey(username: string) { return `subrwar:streak:${username}`; }
function achievementsKey(username: string) { return `subrwar:achievements:${username}`; }

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${t}_${r}`;
}

async function loadActiveSeason(
  redis: Devvit.Context['redis'],
  subredditId: string
): Promise<ActiveSeason | null> {
  const raw = await redis.get(activeSeasonKey(subredditId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ActiveSeason;
  } catch {
    return null;
  }
}

async function saveActiveSeason(
  redis: Devvit.Context['redis'],
  subredditId: string,
  season: ActiveSeason
): Promise<void> {
  await redis.set(activeSeasonKey(subredditId), JSON.stringify(season));
}

async function loadSeasonLeaderboard(
  redis: Devvit.Context['redis'],
  subredditId: string
): Promise<LeaderEntry[]> {
  const raw = await redis.get(seasonLeaderKey(subredditId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as LeaderEntry[];
  } catch {
    return [];
  }
}

async function runSeasonTick(
  redis: Devvit.Context['redis'],
  subredditId: string
): Promise<{ season: ActiveSeason; leaderboard: LeaderEntry[] } | null> {
  const season = await loadActiveSeason(redis, subredditId);
  if (!season) return null;

  // Aggregate tiles across all active sectors for a season-level leaderboard.
  const totals: Record<string, number> = {};
  for (const sector of season.sectors) {
    const board = await loadBoard(redis, sector.postId);
    for (const row of board) {
      for (const cell of row) {
        if (cell.owner) totals[cell.owner] = (totals[cell.owner] ?? 0) + 1;
      }
    }
  }

  const seasonLeaderboard: LeaderEntry[] = Object.entries(totals)
    .map(([username, tiles]) => ({ username, tiles }))
    .sort((a, b) => b.tiles - a.tiles)
    .slice(0, 10);

  await redis.set(seasonLeaderKey(subredditId), JSON.stringify(seasonLeaderboard));
  const updated: ActiveSeason = { ...season, lastTickAt: Date.now() };
  await saveActiveSeason(redis, subredditId, updated);

  return { season: updated, leaderboard: seasonLeaderboard };
}

async function getPostKind(
  redis: Devvit.Context['redis'],
  subredditId: string,
  postId: string
): Promise<PostKind> {
  const raw = await redis.get(postKindKey(postId));
  if (raw === 'HQ' || raw === 'SECTOR') return raw;

  // Fallback: if this post is the HQ for the active season, treat it as HQ.
  const season = await loadActiveSeason(redis, subredditId);
  if (season?.hqPostId === postId) return 'HQ';

  return 'SECTOR';
}

async function setPostKind(
  redis: Devvit.Context['redis'],
  postId: string,
  kind: PostKind
): Promise<void> {
  await redis.set(postKindKey(postId), kind);
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function emptyBoard(): Board {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({ owner: null, fort: false }))
  );
}

function isValidCell(col: unknown, row: unknown): col is number {
  return (
    typeof col === 'number' && typeof row === 'number' &&
    col >= 0 && col < COLS && row >= 0 && row < ROWS
  );
}

// ─── Achievement definitions ──────────────────────────────────────────────────
const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_claim', name: 'First Blood', description: 'Claim your first territory', icon: '🚩' },
  { id: 'conqueror_10', name: 'Conqueror', description: 'Control 10 tiles simultaneously', icon: '👑' },
  { id: 'conqueror_25', name: 'Warlord', description: 'Control 25 tiles simultaneously', icon: '⚔️' },
  { id: 'streak_3', name: 'Dedicated', description: 'Login 3 days in a row', icon: '🔥' },
  { id: 'streak_7', name: 'Committed', description: 'Login 7 days in a row', icon: '💪' },
  { id: 'streak_30', name: 'Legendary', description: 'Login 30 days in a row', icon: '🏆' },
  { id: 'attacker_100', name: 'Aggressor', description: 'Launch 100 attacks', icon: '⚡' },
  { id: 'defender_50', name: 'Defender', description: 'Fortify 50 tiles', icon: '🛡️' },
  { id: 'alliance_member', name: 'Team Player', description: 'Join an alliance', icon: '🤝' },
  { id: 'alliance_leader', name: 'Leader', description: 'Create an alliance', icon: '👥' },
  { id: 'powerup_master', name: 'Power User', description: 'Use 10 power-ups', icon: '⚡' },
];

// ─── Player stats helpers ─────────────────────────────────────────────────────
function defaultPlayerStats(): PlayerStats {
  return {
    totalTilesClaimed: 0,
    totalAttacks: 0,
    totalFortifications: 0,
    longestStreak: 0,
    currentStreak: 0,
    lastLoginDate: '',
    achievements: [],
    powerUpsUsed: 0,
    karmaEarned: 0,
  };
}

async function loadPlayerStats(redis: Devvit.Context['redis'], username: string): Promise<PlayerStats> {
  const raw = await redis.get(playerStatsKey(username));
  if (!raw) return defaultPlayerStats();
  try {
    const stats = JSON.parse(raw) as PlayerStats;
    // Backward-compatibility: older data may not have these fields.
    if (!Array.isArray(stats.achievements)) stats.achievements = [];
    if (typeof stats.powerUpsUsed !== 'number') stats.powerUpsUsed = 0;
    if (typeof stats.karmaEarned !== 'number') stats.karmaEarned = 0;
    return stats;
  } catch {
    return defaultPlayerStats();
  }
}

async function savePlayerStats(redis: Devvit.Context['redis'], username: string, stats: PlayerStats): Promise<void> {
  await redis.set(playerStatsKey(username), JSON.stringify(stats));
}

async function updateStreak(redis: Devvit.Context['redis'], username: string, stats: PlayerStats): Promise<PlayerStats> {
  const today = utcDay();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (stats.lastLoginDate === today) {
    return stats; // Already logged in today
  }

  if (stats.lastLoginDate === yesterday) {
    stats.currentStreak += 1;
  } else if (stats.lastLoginDate !== today) {
    stats.currentStreak = 1; // Reset streak
  }

  stats.longestStreak = Math.max(stats.longestStreak, stats.currentStreak);
  stats.lastLoginDate = today;

  return stats;
}

async function checkAchievements(
  redis: Devvit.Context['redis'],
  username: string,
  stats: PlayerStats,
  board: Board
): Promise<Achievement[]> {
  const newAchievements: Achievement[] = [];
  const unlockedIds = new Set(stats.achievements.map(a => a.id));

  // Count current tiles
  let tileCount = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell.owner === username) tileCount++;
    }
  }

  // Check each achievement
  for (const achievement of ACHIEVEMENTS) {
    if (unlockedIds.has(achievement.id)) continue;

    let unlock = false;
    switch (achievement.id) {
      case 'first_claim':
        unlock = stats.totalTilesClaimed > 0;
        break;
      case 'conqueror_10':
        unlock = tileCount >= 10;
        break;
      case 'conqueror_25':
        unlock = tileCount >= 25;
        break;
      case 'streak_3':
        unlock = stats.currentStreak >= 3;
        break;
      case 'streak_7':
        unlock = stats.currentStreak >= 7;
        break;
      case 'streak_30':
        unlock = stats.currentStreak >= 30;
        break;
      case 'attacker_100':
        unlock = stats.totalAttacks >= 100;
        break;
      case 'defender_50':
        unlock = stats.totalFortifications >= 50;
        break;
      case 'powerup_master':
        unlock = stats.powerUpsUsed >= 10;
        break;
      case 'alliance_member':
        unlock = !!stats.allianceId;
        break;
      case 'alliance_leader':
        // Unlocked explicitly when the player creates an alliance;
        // not derivable from stats alone, so always false here.
        unlock = false;
        break;
    }

    if (unlock) {
      const unlockedAchievement = { ...achievement, unlockedAt: Date.now() };
      stats.achievements.push(unlockedAchievement);
      newAchievements.push(unlockedAchievement);
      stats.karmaEarned += 10; // Award karma for achievements
    }
  }

  if (newAchievements.length > 0) {
    await savePlayerStats(redis, username, stats);
  }

  return newAchievements;
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
type DevvitConfig = Parameters<typeof Devvit.configure>[0];
type DevvitConfigWithScheduler = DevvitConfig & { scheduler?: boolean };

const devvitConfig: DevvitConfigWithScheduler = {
  redditAPI: true,
  redis: true,
  realtime: true,
  // `scheduler` is supported at runtime but missing from this public-api version's typings.
  scheduler: true,
};

Devvit.configure(devvitConfig);
Devvit.addSettings([
  {
    type: 'string',
    name: 'subrwar_subreddit_name_override',
    label: 'Subreddit name override (optional)',
    helpText: 'If set, menu actions will post to this subreddit name instead of using the current context.',
    scope: SettingScope.Installation,
  },
]);

Devvit.addSchedulerJob<{ subredditId: string }>({
  name: THREADFRONT_DAILY_TICK_JOB,
  onRun: async (event, context) => {
    const subredditId = event.data?.subredditId ?? context.subredditId;
    const result = await runSeasonTick(context.redis, subredditId);
    if (!result) return;
    console.log(
      `[Threadfront] Daily tick complete for ${subredditId} (season ${result.season.seasonId})`
    );
  },
});

// ─── Custom post type ─────────────────────────────────────────────────────────
Devvit.addCustomPostType({
  name: "Subrwar",
  description: "Daily territory-control game",
  height: "tall",

  render: (context) => {
    const { redis, postId, userId, subredditId } = context;

    const [activeSeason, setActiveSeason] = useState<ActiveSeason | null>(async () => {
      return await loadActiveSeason(redis, subredditId);
    });

    const [seasonLeaderboard, setSeasonLeaderboard] = useState<LeaderEntry[]>(async () => {
      return await loadSeasonLeaderboard(redis, subredditId);
    });

    const [postKind] = useState<PostKind>(async () => {
      if (!postId) return 'SECTOR';
      return await getPostKind(redis, subredditId, postId);
    });

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

        try {
          if (msg.type === "INIT") {
            let stats = await loadPlayerStats(redis, username);
            stats = await updateStreak(redis, username, stats);
            await savePlayerStats(redis, username, stats);

            const [board, actionsLeft, leaderboard] = await Promise.all([
              loadBoard(redis, postId),
              getActionsLeft(redis, postId, username),
              getLeaderboard(redis, postId),
            ]);

            const newAchievements = await checkAchievements(redis, username, stats, board);

            webView.postMessage({
              type: "INIT_RESPONSE",
              board,
              username,
              actionsLeft,
              leaderboard,
              stats,
              achievements: newAchievements,
            });
            return;
          }

          // Power-up handler (stub – sends error for now)
          if (msg.type === "USE_POWERUP") {
            webView.postMessage({ type: "ERROR", message: "Power-ups coming soon!" });
            return;
          }

          // Alliance handlers (stub – sends error for now)
          if (msg.type === "JOIN_ALLIANCE" || msg.type === "CREATE_ALLIANCE") {
            webView.postMessage({ type: "ERROR", message: "Alliances coming soon!" });
            return;
          }

          // All mutating cell actions share the same flow
          const { col, row } = msg as { type: string; col: number; row: number };
          if (!isValidCell(col, row)) {
            webView.postMessage({ type: "ERROR", message: "Out of bounds." });
            return;
          }

          const board = await loadBoard(redis, postId);
          const cell = board[row][col];
          let stats = await loadPlayerStats(redis, username);

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
            stats.totalTilesClaimed += 1;
            stats.karmaEarned += 1;
          } else if (msg.type === "ATTACK") {
            if (!cell.owner || cell.owner === username) {
              webView.postMessage({ type: "ERROR", message: "Nothing to attack." });
              return;
            }
            if (cell.shield && cell.shieldExpiry && cell.shieldExpiry > Date.now()) {
              webView.postMessage({ type: "ERROR", message: "Cell is shielded!" });
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
              stats.totalTilesClaimed += 1;
            }
            stats.totalAttacks += 1;
            stats.karmaEarned += 2;
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
            stats.totalFortifications += 1;
            stats.karmaEarned += 1;
          }

          await saveBoard(redis, postId, board);
          await updateLeaderboard(redis, postId, board);
          await savePlayerStats(redis, username, stats);

          const newAchievements = await checkAchievements(redis, username, stats, board);

          const [actionsLeft, leaderboard] = await Promise.all([
            getActionsLeft(redis, postId, username),
            getLeaderboard(redis, postId),
          ]);

          webView.postMessage({ type: "UPDATE", board, actionsLeft, leaderboard, stats, achievements: newAchievements });

          // Send achievement notifications immediately (server-side setTimeout is unreliable).
          for (const achievement of newAchievements) {
            webView.postMessage({ type: "ACHIEVEMENT_UNLOCKED", achievement });
          }

          // Broadcast board updates to other viewers of this sector.
          try {
            await channel.send({ type: 'BOARD_UPDATE', board, leaderboard });
          } catch (e) {
            // Realtime might not be connected yet; the initiating user still received UPDATE.
            console.warn('Realtime broadcast skipped:', e);
          }
        } catch (e) {
          console.error('Error in onMessage handler:', e);
          try {
            webView.postMessage({ type: "ERROR", message: "Server error. Please try again." });
          } catch {
            // best-effort
          }
        }
      },

      onUnmount() {},
    });

    const channel = useChannel<SectorRealtimeMsg>({
      name: postId ? `sector_${postId}` : 'sector_unknown',
      onMessage: (msg) => {
        if (!msg || msg.type !== 'BOARD_UPDATE') return;
        webView.postMessage({
          type: 'BOARD_UPDATE',
          board: msg.board,
          leaderboard: msg.leaderboard,
        });
      },
    });
    channel.subscribe();

    if (postKind === 'HQ') {
      return (
        <vstack height="100%" width="100%" padding="medium" gap="medium">
          {/* Header */}
          <vstack gap="small">
            <text size="xxlarge" weight="bold">🧭 Threadfront HQ</text>
            <text size="small" color="#999">Subreddit: r/{context.subredditName ?? '(unknown)'}</text>
          </vstack>

          {activeSeason ? (
            <vstack gap="medium">
              {/* Season Info Panel */}
              <vstack gap="small" backgroundColor="#1a1a2e" padding="small" cornerRadius="medium">
                <text weight="bold" color="#e94560">Season Info</text>
                <text size="small">
                  ID: <text color="#888">{activeSeason.seasonId.substring(0, 12)}...</text>
                </text>
                <text size="small">
                  Started: <text color="#888">{new Date(activeSeason.startedAt).toLocaleString()}</text>
                </text>
                <text size="small">
                  Last Aggregation: <text color="#888">{activeSeason.lastTickAt ? new Date(activeSeason.lastTickAt).toLocaleString() : 'pending'}</text>
                </text>
              </vstack>

              {/* Action Buttons */}
              <vstack gap="small">
                <button
                  appearance="primary"
                  size="large"
                  onPress={async () => {
                    try {
                      const season = await loadActiveSeason(redis, subredditId);
                      if (!season) {
                        context.ui.showToast('No active season found. Start a season from the subreddit menu.');
                        return;
                      }

                      const subredditName =
                        context.subredditName ??
                        (await context.settings.get<string>('subrwar_subreddit_name_override'));
                      if (!subredditName) {
                        context.ui.showToast('Missing subreddit name. Configure the subreddit override setting.');
                        return;
                      }

                      const sectorNumber = season.sectors.length + 1;
                      const title = `⚔️ Sector ${sectorNumber} – Subrwar Battle`;
                      const sectorPost = await context.reddit.submitPost({
                        title,
                        subredditName,
                        preview: (
                          <vstack height="100%" width="100%" alignment="center middle" backgroundColor="#1a1a2e">
                            <text color="white" size="xlarge" weight="bold">⚔️ SUBRWAR</text>
                            <text color="#e0e0e0" size="medium">Loading battle map…</text>
                          </vstack>
                        ),
                        textFallback: {
                          text: 'Subrwar battle sector (open in the app to play).',
                        },
                      });

                      await setPostKind(redis, sectorPost.id, 'SECTOR');
                      await redis.set(sectorSeasonKey(sectorPost.id), season.seasonId);

                      const updated: ActiveSeason = {
                        ...season,
                        sectors: [
                          ...season.sectors,
                          { postId: sectorPost.id, title, createdAt: Date.now() },
                        ],
                      };
                      await saveActiveSeason(redis, subredditId, updated);
                      setActiveSeason(updated);

                      context.ui.showToast('Sector created!');
                    } catch (e) {
                      console.error('Failed to create sector', e);
                      context.ui.showToast('Failed to create sector.');
                    }
                  }}
                >
                  ⚔️ Create Sector Battle
                </button>

                <hstack gap="small">
                  <button
                    onPress={async () => {
                      try {
                        const result = await runSeasonTick(redis, subredditId);
                        if (!result) {
                          context.ui.showToast('No active season found.');
                          return;
                        }
                        setActiveSeason(result.season);
                        setSeasonLeaderboard(result.leaderboard);
                        context.ui.showToast('Season leaderboard aggregated.');
                      } catch (e) {
                        console.error('Failed to run season tick', e);
                        context.ui.showToast('Aggregation failed.');
                      }
                    }}
                  >
                    📊 Aggregate
                  </button>

                  <button
                    onPress={async () => {
                      const [season, leaders] = await Promise.all([
                        loadActiveSeason(redis, subredditId),
                        loadSeasonLeaderboard(redis, subredditId),
                      ]);
                      setActiveSeason(season);
                      setSeasonLeaderboard(leaders);
                      context.ui.showToast('Refreshed');
                    }}
                  >
                    🔄 Refresh
                  </button>
                </hstack>
              </vstack>

              {/* Season Leaderboard */}
              <vstack gap="small">
                <text weight="bold">🏆 Season Leaders</text>
                {seasonLeaderboard.length === 0 ? (
                  <text size="small" color="#999">No data. Create sectors and run aggregation.</text>
                ) : (
                  <vstack gap="none">
                    {seasonLeaderboard.map((e, idx) => (
                      <hstack key={e.username} gap="small">
                        <text size="small" weight="bold" color={idx === 0 ? '#FFD700' : idx === 1 ? '#C0C0C0' : '#CD7F32'}>
                          #{idx + 1}
                        </text>
                        <spacer />
                        <text size="small">{e.username}</text>
                        <text size="small" weight="bold" color="#4cc9f0">{e.tiles} tiles</text>
                      </hstack>
                    ))}
                  </vstack>
                )}
              </vstack>

              {/* Active Sectors */}
              <vstack gap="small">
                <text weight="bold">⚔️ Active Sectors ({activeSeason.sectors.length})</text>
                {activeSeason.sectors.length === 0 ? (
                  <text size="small" color="#999">None yet. Create your first battle sector above.</text>
                ) : (
                  <vstack gap="small">
                    {activeSeason.sectors.map((s, idx) => (
                      <vstack key={s.postId} gap="small" backgroundColor="#0a0a14" padding="small" cornerRadius="small">
                        <text size="small" weight="bold">{idx + 1}. {s.title}</text>
                        <text size="small" color="#888">{s.postId}</text>
                      </vstack>
                    ))}
                  </vstack>
                )}
              </vstack>
            </vstack>
          ) : (
            <vstack gap="small" alignment="center middle">
              <text color="#e94560">⚠️ No Active Season</text>
              <text size="small" color="#999">Use "Start Threadfront HQ (Season)" from the subreddit menu to begin.</text>
              <button
                onPress={async () => {
                  const season = await loadActiveSeason(redis, subredditId);
                  setActiveSeason(season);
                }}
              >
                Check Again
              </button>
            </vstack>
          )}
        </vstack>
      );
    }

    return (
      <vstack height="100%" width="100%" alignment="center middle" backgroundColor="#1a1a2e" gap="medium">
        <text color="#e94560" size="xxlarge" weight="bold">⚔️ SUBRWAR</text>
        <text color="#cccccc" size="medium">Daily Territory-Control Battle</text>
        <text color="#aaaaaa" size="small">Playing as: {username}</text>
        <button appearance="primary" size="large" onPress={() => webView.mount()}>
          ⚔️ Enter Battle
        </button>
      </vstack>
    );
  },
});

// ─── Menu item to create a new Subrwar post ───────────────────────────────────
Devvit.addMenuItem({
  label: "Start a Subrwar Game",
  location: "subreddit",
  async onPress(event, context) {
    const subredditName =
      context.subredditName ??
      (await context.settings.get<string>('subrwar_subreddit_name_override'));
    if (!subredditName) {
      console.warn('Could not determine subredditName for menu action', {
        event,
        context: {
          subredditName: context.subredditName,
          subredditId: context.subredditId,
        },
      });
      context.ui.showToast('Could not determine subreddit. Please configure the subreddit override setting.');
      return;
    }

    try {
      const post = await context.reddit.submitPost({
        title: `⚔️ Subrwar – Conquer the Grid! [${new Date().toLocaleDateString()}]`,
        subredditName,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle" backgroundColor="#1a1a2e">
            <text color="white" size="xlarge" weight="bold">⚔️ SUBRWAR</text>
            <text color="#e0e0e0" size="medium">Loading battle map…</text>
          </vstack>
        ),
        textFallback: {
          text: 'Subrwar battle sector (open in the app to play).',
        },
      });

      await setPostKind(context.redis, post.id, 'SECTOR');

      const season = await loadActiveSeason(context.redis, context.subredditId);
      if (season) {
        await context.redis.set(sectorSeasonKey(post.id), season.seasonId);
        const updated: ActiveSeason = {
          ...season,
          sectors: [
            ...season.sectors,
            { postId: post.id, title: post.title, createdAt: Date.now() },
          ],
        };
        await saveActiveSeason(context.redis, context.subredditId, updated);
        context.ui.showToast('Sector created and added to Threadfront.');
      } else {
        context.ui.showToast("Subrwar game created! 🎮");
      }
    } catch (e) {
      console.error("Error creating post:", e);
      context.ui.showToast("Error: Could not create post. Try again!");
    }
  },
});

Devvit.addMenuItem({
  label: 'Start Threadfront HQ (Season)',
  location: 'subreddit',
  async onPress(event, context) {
    const subredditName =
      context.subredditName ??
      (await context.settings.get<string>('subrwar_subreddit_name_override'));
    if (!subredditName) {
      console.warn('Could not determine subredditName for menu action', {
        event,
        context: context.toJSON(),
      });
      context.ui.showToast('Could not determine subreddit. Please configure the subreddit override setting.');
      return;
    }

    try {
      const existing = await loadActiveSeason(context.redis, context.subredditId);
      if (existing) {
        context.ui.showToast(`Season already active. HQ: ${existing.hqPostId}`);
        return;
      }

      const seasonId = newId('season');
      const hqPost = await context.reddit.submitPost({
        title: `🧭 Threadfront HQ – Season ${seasonId}`,
        subredditName,
        preview: (
          <vstack height="100%" width="100%" alignment="center middle" backgroundColor="#0b1320">
            <text color="white" size="xlarge" weight="bold">🧭 THREADFRONT HQ</text>
            <text color="#b8c0cc" size="medium">Open to create sectors and coordinate the war.</text>
          </vstack>
        ),
        textFallback: {
          text: 'Threadfront HQ (open the post in the app to create new sectors and manage the campaign).',
        },
      });

      await setPostKind(context.redis, hqPost.id, 'HQ');

      let season: ActiveSeason = {
        seasonId,
        startedAt: Date.now(),
        hqPostId: hqPost.id,
        sectors: [],
      };
      await saveActiveSeason(context.redis, context.subredditId, season);

      try {
        const tickJobId = await context.scheduler.runJob({
          name: THREADFRONT_DAILY_TICK_JOB,
          // Run daily at 00:05 UTC.
          cron: '5 0 * * *',
          data: { subredditId: context.subredditId },
        });
        await context.redis.set(seasonTickJobKey(context.subredditId), tickJobId);
        season = { ...season, tickJobId };
        await saveActiveSeason(context.redis, context.subredditId, season);
      } catch (e) {
        console.warn('Failed to schedule daily Threadfront tick job.', e);
      }

      try {
        await hqPost.sticky(1);
      } catch (e) {
        console.warn('Failed to sticky Threadfront HQ post (missing modposts permission or mod status).', e);
      }

      context.ui.showToast('Threadfront HQ created!');
    } catch (e) {
      console.error('Error creating Threadfront HQ:', e);
      context.ui.showToast('Error: Could not create Threadfront HQ.');
    }
  },
});

export default Devvit;
