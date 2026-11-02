/* Games: play time, streaks, friend boards and invites.
   The page sends a beat about once a minute while a game is open and
   visible. Credit is capped by the time since the last beat, so a page
   cannot claim more time than really passed. */

import { liveFriendIds } from "./friends-pref.js";
import { awardActivity } from "./points.js";
import { handleGameSocial, afterBeat, roomsFor, canSeeGame, GAME_SOCIAL_SCHEMA } from "./game-social.js";

export const GAMES = { regone: "ReGone" };
const BEAT_MAX_MS = 60 * 1000;
const PLAYING_MS = 2 * 60 * 1000;
const STREAK_MIN_MS = 5 * 60 * 1000;
const POINT_BLOCK_MS = 10 * 60 * 1000;

export const GAMES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS game_stats (
    public_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    total_ms INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    streak_day TEXT NOT NULL DEFAULT '',
    beat_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, game_id)
  )`,
  `CREATE TABLE IF NOT EXISTS game_days (
    public_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    day TEXT NOT NULL,
    ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, game_id, day)
  )`,
  "CREATE INDEX IF NOT EXISTS game_days_day ON game_days(day)"
].concat(GAME_SOCIAL_SCHEMA);

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function dayBefore(day) {
  const date = new Date(day + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
function rows(result) {
  return (result && result.results) || [];
}
function gameOf(value) {
  const id = String(value || "");
  return Object.prototype.hasOwnProperty.call(GAMES, id) ? id : "";
}

/* Streak after a day reaches STREAK_MIN_MS. Pure, for tests. */
export function nextStreak(row, day) {
  const streak = Number(row && row.streak) || 0;
  const last = String((row && row.streak_day) || "");
  if (last === day) return { streak: streak, changed: false };
  const next = last === dayBefore(day) ? streak + 1 : 1;
  return { streak: next, changed: true };
}

/* Credit for one beat: what the page says, never more than a minute and
   never more than the time since the last beat. */
export function beatCredit(claimed, beatAt, now) {
  const ms = Math.max(0, Math.min(BEAT_MAX_MS, Math.floor(Number(claimed) || 0)));
  if (!beatAt) return Math.min(ms, BEAT_MAX_MS);
  return Math.max(0, Math.min(ms, now - Number(beatAt) + 2000));
}

async function friendIds(env, publicId) {
  try {
    const got = await env.DB.prepare("SELECT friend_id FROM account_friends WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").bind(publicId).all();
    return await liveFriendIds(env, publicId, rows(got).map((row) => String(row.friend_id)).filter((id) => /^\d{12}$/.test(id)));
  } catch (err) {
    return [];
  }
}

async function play(request, env, viewer, deps) {
  const body = await deps.readJson(request, 1000);
  const game = gameOf(body && body.gameId);
  if (!game) return deps.json(400, { error: "unknown_game" });
  const paced = await deps.rateHit(env, "game-beat:" + viewer.public_id, 30, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const now = Date.now();
  const day = utcDay(now);
  const prev = await env.DB.prepare("SELECT total_ms, streak, best_streak, streak_day, beat_at FROM game_stats WHERE public_id = ? AND game_id = ?").bind(viewer.public_id, game).first();
  const credit = beatCredit(body && body.ms, prev && prev.beat_at, now);
  const dayRow = await env.DB.prepare("SELECT ms FROM game_days WHERE public_id = ? AND game_id = ? AND day = ?").bind(viewer.public_id, game, day).first();
  const before = Number(dayRow && dayRow.ms) || 0;
  const today = before + credit;
  let streak = Number(prev && prev.streak) || 0;
  let best = Number(prev && prev.best_streak) || 0;
  let streakDay = String((prev && prev.streak_day) || "");
  let streakUp = false;
  if (today >= STREAK_MIN_MS && streakDay !== day) {
    const next = nextStreak(prev, day);
    streak = next.streak;
    streakDay = day;
    best = Math.max(best, streak);
    streakUp = true;
  } else if (streakDay && streakDay !== day && streakDay !== dayBefore(day)) {
    streak = 0;
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO game_stats (public_id, game_id, total_ms, streak, best_streak, streak_day, beat_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(public_id, game_id) DO UPDATE SET total_ms = game_stats.total_ms + ?, streak = excluded.streak, best_streak = excluded.best_streak, streak_day = excluded.streak_day, beat_at = excluded.beat_at"
    ).bind(viewer.public_id, game, credit, streak, best, streakDay, now, credit),
    env.DB.prepare(
      "INSERT INTO game_days (public_id, game_id, day, ms) VALUES (?, ?, ?, ?) ON CONFLICT(public_id, game_id, day) DO UPDATE SET ms = game_days.ms + ?"
    ).bind(viewer.public_id, game, day, credit, credit)
  ]);
  let awarded = 0;
  for (let block = Math.floor(before / POINT_BLOCK_MS) + 1; block <= Math.floor(today / POINT_BLOCK_MS); block++) {
    const got = await awardActivity(env, viewer.public_id, "game_time", day + ":" + game + ":" + block);
    awarded += Number(got && got.awarded) || 0;
  }
  if (streakUp && streak >= 2) {
    const got = await awardActivity(env, viewer.public_id, "game_streak", day + ":" + game);
    awarded += Number(got && got.awarded) || 0;
  }
  const achievements = await afterBeat(env, viewer.public_id, game, body && body.tz, now);
  return deps.json(200, {
    gameId: game,
    achievements: achievements,
    credited: credit,
    todayMs: today,
    totalMs: (Number(prev && prev.total_ms) || 0) + credit,
    streak: streak,
    bestStreak: best,
    awarded: awarded
  });
}

/* Play time and streaks for you and your friends. */
async function board(request, env, viewer, deps, url) {
  const game = gameOf(url.searchParams.get("game"));
  if (!game) return deps.json(400, { error: "unknown_game" });
  const paced = await deps.rateHit(env, "game-board:" + viewer.public_id, 60, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const ids = [viewer.public_id].concat(await friendIds(env, viewer.public_id));
  const marks = ids.map(() => "?").join(",");
  const now = Date.now();
  const today = utcDay(now);
  let weekFrom = today;
  for (let i = 0; i < 6; i++) weekFrom = dayBefore(weekFrom);
  const people = rows(await env.DB.prepare(
    "SELECT public_id, handle, display_name, avatar, hide_avatar, profile_less FROM accounts WHERE public_id IN (" + marks + ")"
  ).bind(...ids).all());
  const stats = rows(await env.DB.prepare(
    "SELECT public_id, total_ms, streak, best_streak, streak_day, beat_at FROM game_stats WHERE game_id = ? AND public_id IN (" + marks + ")"
  ).bind(game, ...ids).all());
  const weeks = rows(await env.DB.prepare(
    "SELECT public_id, SUM(ms) AS ms FROM game_days WHERE game_id = ? AND day >= ? AND public_id IN (" + marks + ") GROUP BY public_id"
  ).bind(game, weekFrom, ...ids).all());
  const statBy = new Map(stats.map((row) => [String(row.public_id), row]));
  const weekBy = new Map(weeks.map((row) => [String(row.public_id), Number(row.ms) || 0]));
  const list = people.filter((row) => row.profile_less !== 1 || row.public_id === viewer.public_id).map((row) => {
    const stat = statBy.get(String(row.public_id)) || {};
    const live = String(stat.streak_day || "") === today || String(stat.streak_day || "") === dayBefore(today);
    return {
      publicId: String(row.public_id),
      handle: row.handle || "",
      name: row.display_name || row.handle || "",
      avatar: row.hide_avatar === 1 ? "" : String(row.avatar || ""),
      me: row.public_id === viewer.public_id,
      totalMs: Number(stat.total_ms) || 0,
      weekMs: weekBy.get(String(row.public_id)) || 0,
      streak: live ? Number(stat.streak) || 0 : 0,
      bestStreak: Number(stat.best_streak) || 0,
      playing: now - (Number(stat.beat_at) || 0) < PLAYING_MS
    };
  });
  list.sort((a, b) => b.weekMs - a.weekMs || b.totalMs - a.totalMs);
  return deps.json(200, { gameId: game, name: GAMES[game], people: list }, { "cache-control": "private, no-store" });
}

/* Friends playing a game right now, for the presence line. With a viewer,
   people who hide their room / Playing now from that viewer are left out
   and a room they set themselves comes along. */
export async function playingNow(env, ids, viewerId) {
  const out = new Map();
  const list = (ids || []).filter((id) => /^\d{12}$/.test(String(id))).slice(0, 100);
  if (!list.length) return out;
  try {
    const got = await env.DB.prepare(
      "SELECT public_id, game_id, beat_at FROM game_stats WHERE beat_at > ? AND public_id IN (" + list.map(() => "?").join(",") + ")"
    ).bind(Date.now() - PLAYING_MS, ...list).all();
    rows(got).forEach((row) => { if (GAMES[row.game_id]) out.set(String(row.public_id), GAMES[row.game_id]); });
  } catch (err) { /* no table yet */ }
  if (viewerId === undefined) return out;
  const rooms = await roomsFor(env, viewerId, list);
  const shown = new Map();
  for (const [id, name] of out) {
    if (rooms.has(id) || await visibleRoom(env, id, viewerId)) shown.set(id, name);
  }
  rooms.forEach((value, id) => shown.set(id, GAMES[value.gameId] || "ReGone"));
  shown.rooms = rooms;
  return shown;
}

async function visibleRoom(env, id, viewerId) {
  return canSeeGame(env, id, viewerId, "room");
}

async function playingIds(env, ids) {
  return playingNow(env, ids);
}

export async function handleGames(request, env, path, url, deps) {
  if (!path.startsWith("/v1/games/")) return null;
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "auth_required" });
  if (path === "/v1/games/play" && request.method === "POST") return play(request, env, viewer, deps);
  if (path === "/v1/games/board" && request.method === "GET") return board(request, env, viewer, deps, url);
  const social = await handleGameSocial(request, env, path, url, viewer, deps, { playingIds });
  if (social) return social;
  return deps.json(404, { error: "not_found" });
}
