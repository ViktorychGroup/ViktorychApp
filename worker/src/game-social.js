/* ReGone social: live invites, party lobbies, self-reported rooms,
   game achievements, play-together history, game privacy and the NZlay
   Top 100 board.

   ReGone runs in a cross-origin frame. Nothing here reads or drives the
   game: rooms are what people pick themselves, achievements come from play
   time, streaks and invites we already record, and the Top 100 is NZlay's
   own public page, read at most once every ten minutes.

   Privacy. Three audiences per person (Privacy > Games):
     together  who can see who I play with      (default only me)
     room      who can see my room / Playing now (default friends)
     stats     who can see my achievements, play time and claimed rank
   Each one is public / followers / friends / only / list (custom lists
   from the audience system) plus an optional exclude list. Blocked or
   muted people never see any of it, and a pair is shown only when both
   people allow the viewer. */

import { friendshipLive, liveFriendIds } from "./friends-pref.js";
import { emitNotification, readPrefs as readNotePrefs } from "./notifications.js";
import { publishToAccount } from "./channel.js";
import { readFlags } from "./feature-flags.js";
import { actorHidden, blocksEither } from "./social.js";
import { canSeeAudience, setListGrants, grantsFor, normalizeAudience } from "./audience.js";
import {
  cleanRoom, checkMessage, roomsFromList, CURATED_ROOMS, ROOM_SOURCE, CLAN_ROOM_SOURCE, ONLINE_SOURCE, PROFILE_SOURCE, TOP_SOURCE, parseProfileStats,
  ACHIEVEMENT_IDS, unlocked, localParts, isNightOwl, inQuiet, parseTop, foldName
} from "../../shared/regone.js";

export const INVITE_MS = 10 * 60 * 1000;
export const ROOM_TTL_MS = 30 * 60 * 1000;
const LOBBY_MS = 2 * 60 * 60 * 1000;
const LOBBY_MAX = 12;
const ROOMS_CACHE_S = 300;
const TOP_CACHE_S = 600;
const ONLINE_CACHE_S = 60;
const PROFILE_CACHE_S = 3600;
const KINDS = ["together", "room", "stats"];
const DEFAULT_AUD = { together: "only", room: "friends", stats: "public" };
const AUDS = ["public", "followers", "friends", "only", "list"];
const POLITE_UA = "ViktorychApp/1.0 (+https://viktorychgroup.github.io/ViktorychApp/; cached Top 100 view, one request per 10 minutes)";

export const GAME_SOCIAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS game_invites (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, room TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', lobby_id TEXT NOT NULL DEFAULT '', private INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, answered_at INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS game_invites_to ON game_invites(to_id, expires_at)",
  "CREATE INDEX IF NOT EXISTS game_invites_from ON game_invites(from_id, created_at)",
  `CREATE TABLE IF NOT EXISTS game_lobbies (id TEXT PRIMARY KEY, game_id TEXT NOT NULL, host_id TEXT NOT NULL, room TEXT NOT NULL DEFAULT '', private INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, launched_at INTEGER NOT NULL DEFAULT 0)`,
  "CREATE INDEX IF NOT EXISTS game_lobbies_host ON game_lobbies(host_id)",
  "CREATE INDEX IF NOT EXISTS game_lobbies_expires ON game_lobbies(expires_at)",
  `CREATE TABLE IF NOT EXISTS game_lobby_members (lobby_id TEXT NOT NULL, public_id TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, PRIMARY KEY (lobby_id, public_id))`,
  `CREATE TABLE IF NOT EXISTS game_rooms (public_id TEXT PRIMARY KEY, game_id TEXT NOT NULL, room TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS game_achievements (public_id TEXT NOT NULL, game_id TEXT NOT NULL, ach_id TEXT NOT NULL, earned_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (public_id, game_id, ach_id))`,
  `CREATE TABLE IF NOT EXISTS game_prefs (public_id TEXT PRIMARY KEY, aud_together TEXT NOT NULL DEFAULT 'only', aud_room TEXT NOT NULL DEFAULT 'friends', aud_stats TEXT NOT NULL DEFAULT 'public', streak_reminder INTEGER NOT NULL DEFAULT 0, tz_min INTEGER NOT NULL DEFAULT 0, quiet_on INTEGER NOT NULL DEFAULT 0, quiet_from INTEGER NOT NULL DEFAULT 22, quiet_to INTEGER NOT NULL DEFAULT 7, linked_name TEXT NOT NULL DEFAULT '', weekend_sat TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS game_together (a_id TEXT NOT NULL, b_id TEXT NOT NULL, game_id TEXT NOT NULL, times INTEGER NOT NULL DEFAULT 0, last_at INTEGER NOT NULL, PRIMARY KEY (a_id, b_id, game_id))`,
  "CREATE INDEX IF NOT EXISTS game_together_b ON game_together(b_id)",
  `CREATE TABLE IF NOT EXISTS game_board_snap (public_id TEXT NOT NULL, game_id TEXT NOT NULL, rank INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0, best_rank INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (public_id, game_id))`
];

const ID = /^\d{12}$/;
function rows(result) { return (result && result.results) || []; }
function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function personOf(row) {
  if (!row) return null;
  return {
    publicId: String(row.public_id),
    handle: row.handle || "",
    name: row.display_name || row.handle || "",
    avatar: row.hide_avatar === 1 ? "" : String(row.avatar || "")
  };
}
async function people(env, ids) {
  const list = Array.from(new Set((ids || []).map(String).filter((id) => ID.test(id)))).slice(0, 100);
  const out = new Map();
  if (!list.length) return out;
  const got = await env.DB.prepare(
    "SELECT public_id, handle, display_name, avatar, hide_avatar, profile_less FROM accounts WHERE public_id IN (" + list.map(() => "?").join(",") + ")"
  ).bind(...list).all();
  rows(got).forEach((row) => out.set(String(row.public_id), row));
  return out;
}
async function areFriends(env, a, b) {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM account_friends WHERE user_id = ? AND friend_id = ?").bind(a, b).first();
  return !!row && await friendshipLive(env, a, b);
}
async function friendIds(env, id) {
  try {
    const got = await env.DB.prepare("SELECT friend_id FROM account_friends WHERE user_id = ? ORDER BY created_at DESC LIMIT 200").bind(id).all();
    return await liveFriendIds(env, id, rows(got).map((row) => String(row.friend_id)).filter((x) => ID.test(x)));
  } catch (err) { return []; }
}
/* Either side blocked or muted the other. */
async function hiddenPair(env, a, b) {
  if (!a || !b || a === b) return false;
  return (await actorHidden(env, a, b)) || (await actorHidden(env, b, a));
}
async function publish(env, id, data) {
  try { await publishToAccount(env, id, "games", data); }
  catch (err) { /* the poll picks it up */ }
}

/* ---------- prefs and audiences ---------- */

export async function gamePrefs(env, id) {
  const row = await env.DB.prepare("SELECT * FROM game_prefs WHERE public_id = ?").bind(id).first();
  const r = row || {};
  return {
    aud: {
      together: AUDS.indexOf(r.aud_together) >= 0 ? r.aud_together : DEFAULT_AUD.together,
      room: AUDS.indexOf(r.aud_room) >= 0 ? r.aud_room : DEFAULT_AUD.room,
      stats: AUDS.indexOf(r.aud_stats) >= 0 ? r.aud_stats : DEFAULT_AUD.stats
    },
    streakReminder: Number(r.streak_reminder) === 1,
    tz: Number(r.tz_min) || 0,
    quiet: { on: Number(r.quiet_on) === 1, from: r.quiet_from == null ? 22 : Number(r.quiet_from), to: r.quiet_to == null ? 7 : Number(r.quiet_to) },
    linkedName: String(r.linked_name || ""),
    weekendSat: String(r.weekend_sat || "")
  };
}
async function ensurePrefsRow(env, id) {
  await env.DB.prepare("INSERT INTO game_prefs (public_id, updated_at) VALUES (?, ?) ON CONFLICT(public_id) DO NOTHING").bind(id, Date.now()).run();
}
async function excluded(env, ownerId, viewerId, kind) {
  const hit = await env.DB.prepare(
    "SELECT g.list_id FROM audience_grants g JOIN audience_members m ON m.list_id = g.list_id AND m.member_id = ? JOIN audience_lists l ON l.id = g.list_id AND l.public_id = ? WHERE g.subject = ? AND g.subject_id = ? LIMIT 1"
  ).bind(viewerId, ownerId, "game-" + kind + "-x", ownerId).first();
  return !!hit;
}

/* Can viewer see owner's games data of this kind? Server side only. */
export async function canSeeGame(env, ownerId, viewerId, kind, prefs) {
  if (!ID.test(String(ownerId || ""))) return false;
  if (viewerId && viewerId === ownerId) return true;
  if (viewerId && await hiddenPair(env, ownerId, viewerId)) return false;
  const p = prefs || await gamePrefs(env, ownerId);
  const audience = p.aud[kind] || DEFAULT_AUD[kind];
  if (audience === "only") return false;
  if (viewerId) {
    try { if (await excluded(env, ownerId, viewerId, kind)) return false; }
    catch (err) { /* no lists yet */ }
  }
  try {
    return await canSeeAudience(env, { ownerId, viewerId: viewerId || "", audience, subject: "game-" + kind, subjectId: ownerId });
  } catch (err) { return false; }
}

/* A play-together pair is visible only when BOTH people allow the viewer. */
export async function canSeePair(env, aId, bId, viewerId) {
  if (viewerId && (await hiddenPair(env, aId, viewerId) || await hiddenPair(env, bId, viewerId))) return false;
  return (await canSeeGame(env, aId, viewerId, "together")) && (await canSeeGame(env, bId, viewerId, "together"));
}

async function prefsGet(env, viewer, deps) {
  const id = viewer.public_id;
  const p = await gamePrefs(env, id);
  const lists = {};
  for (const kind of KINDS) {
    let include = [];
    let exclude = [];
    try {
      include = await grantsFor(env, id, "game-" + kind, id);
      exclude = await grantsFor(env, id, "game-" + kind + "-x", id);
    } catch (err) { /* no lists yet */ }
    lists[kind] = { include, exclude };
  }
  return deps.json(200, { audiences: p.aud, lists, streakReminder: p.streakReminder, quiet: p.quiet, tz: p.tz, linkedName: p.linkedName }, { "cache-control": "private, no-store" });
}

async function prefsSet(request, env, viewer, deps) {
  const body = await deps.readJson(request, 4000) || {};
  const id = viewer.public_id;
  const paced = await deps.rateHit(env, "game-prefs:" + id, 60, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  await ensurePrefsRow(env, id);
  const sets = [];
  const args = [];
  if (body.audiences && typeof body.audiences === "object") {
    KINDS.forEach((kind) => {
      const value = normalizeAudience(body.audiences[kind]);
      if (value && AUDS.indexOf(value) >= 0) { sets.push("aud_" + kind + " = ?"); args.push(value); }
    });
  }
  if (typeof body.streakReminder === "boolean") { sets.push("streak_reminder = ?"); args.push(body.streakReminder ? 1 : 0); }
  if (body.tz != null && isFinite(Number(body.tz))) { sets.push("tz_min = ?"); args.push(Math.max(-840, Math.min(840, Math.round(Number(body.tz))))); }
  if (body.quiet && typeof body.quiet === "object") {
    sets.push("quiet_on = ?", "quiet_from = ?", "quiet_to = ?");
    args.push(body.quiet.on ? 1 : 0, Math.max(0, Math.min(23, Number(body.quiet.from) || 0)), Math.max(0, Math.min(23, Number(body.quiet.to) || 0)));
  }
  if (sets.length) {
    sets.push("updated_at = ?");
    args.push(Date.now());
    await env.DB.prepare("UPDATE game_prefs SET " + sets.join(", ") + " WHERE public_id = ?").bind(...args, id).run();
  }
  if (body.lists && typeof body.lists === "object") {
    for (const kind of KINDS) {
      const one = body.lists[kind];
      if (!one || typeof one !== "object") continue;
      try {
        if (Array.isArray(one.include)) await setListGrants(env, id, "game-" + kind, id, one.include.slice(0, 20));
        if (Array.isArray(one.exclude)) await setListGrants(env, id, "game-" + kind + "-x", id, one.exclude.slice(0, 20));
      } catch (err) { /* audience tables missing */ }
    }
  }
  // Hiding your room also clears the room you set.
  const now = await gamePrefs(env, id);
  if (now.aud.room === "only") await env.DB.prepare("DELETE FROM game_rooms WHERE public_id = ?").bind(id).run();
  return prefsGet(env, viewer, deps);
}

/* ---------- achievements ---------- */

async function facts(env, id, game) {
  const stat = await env.DB.prepare("SELECT total_ms, streak, best_streak FROM game_stats WHERE public_id = ? AND game_id = ?").bind(id, game).first();
  const invited = await env.DB.prepare("SELECT 1 AS ok FROM game_invites WHERE from_id = ? AND game_id = ? LIMIT 1").bind(id, game).first();
  const joined = await env.DB.prepare("SELECT 1 AS ok FROM game_invites WHERE from_id = ? AND game_id = ? AND status = 'joined' LIMIT 1").bind(id, game).first();
  const mates = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_together WHERE game_id = ? AND (a_id = ? OR b_id = ?)").bind(game, id, id).first();
  return {
    played: !!stat && Number(stat.total_ms) > 0,
    totalMs: Number(stat && stat.total_ms) || 0,
    streak: Math.max(Number(stat && stat.streak) || 0, Number(stat && stat.best_streak) || 0),
    invited: !!invited,
    joined: !!joined,
    friends: Number(mates && mates.n) || 0
  };
}

/* Adds any newly earned achievements and returns their ids. */
export async function awardGame(env, id, game, extra) {
  try {
    const f = Object.assign(await facts(env, id, game), extra || {});
    const want = unlocked(f);
    if (!want.length) return [];
    const have = rows(await env.DB.prepare("SELECT ach_id FROM game_achievements WHERE public_id = ? AND game_id = ?").bind(id, game).all()).map((r) => r.ach_id);
    const fresh = want.filter((a) => have.indexOf(a) < 0);
    if (!fresh.length) return [];
    const now = Date.now();
    await env.DB.batch(fresh.map((a) => env.DB.prepare(
      "INSERT INTO game_achievements (public_id, game_id, ach_id, earned_at, seen) VALUES (?, ?, ?, ?, 0) ON CONFLICT(public_id, game_id, ach_id) DO NOTHING"
    ).bind(id, game, a, now)));
    await publish(env, id, { type: "achievements", gameId: game, ids: fresh });
    return fresh;
  } catch (err) {
    return [];
  }
}

/* Called from each play beat: night owl, weekend warrior, hours, streaks,
   and keeps a set room alive. tz is minutes east of UTC from the page. */
export async function afterBeat(env, id, game, tzValue, now) {
  const at = Number(now) || Date.now();
  let tz = Number(tzValue);
  const p = await gamePrefs(env, id);
  if (!isFinite(tz)) tz = p.tz;
  tz = Math.max(-840, Math.min(840, Math.round(tz || 0)));
  const local = localParts(at, tz);
  let weekend = false;
  let sat = p.weekendSat;
  if (local.weekday === 6) sat = local.day;
  if (local.weekday === 0 && p.weekendSat) {
    const d = new Date(local.day + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - 1);
    weekend = d.toISOString().slice(0, 10) === p.weekendSat;
  }
  try {
    await ensurePrefsRow(env, id);
    await env.DB.prepare("UPDATE game_prefs SET tz_min = ?, weekend_sat = ? WHERE public_id = ?").bind(tz, sat, id).run();
    await env.DB.prepare("UPDATE game_rooms SET updated_at = ? WHERE public_id = ? AND game_id = ?").bind(at, id, game).run();
  } catch (err) { /* schema miss */ }
  return awardGame(env, id, game, { night: isNightOwl(at, tz), weekend });
}

async function achievementsGet(env, viewer, deps, url) {
  const game = "regone";
  const who = String(url.searchParams.get("id") || viewer.public_id);
  if (!ID.test(who)) return deps.json(400, { error: "bad_id" });
  const mine = who === viewer.public_id;
  if (!mine && !await canSeeGame(env, who, viewer.public_id, "stats")) return deps.json(200, { hidden: true, achievements: [] }, { "cache-control": "private, no-store" });
  if (mine) await rankCheck(env, who, game).catch(() => null);
  const list = rows(await env.DB.prepare("SELECT ach_id, earned_at, seen FROM game_achievements WHERE public_id = ? AND game_id = ? ORDER BY earned_at ASC").bind(who, game).all())
    .filter((r) => ACHIEVEMENT_IDS.indexOf(r.ach_id) >= 0)
    .map((r) => ({ id: r.ach_id, earnedAt: Number(r.earned_at) || 0, seen: mine ? Number(r.seen) === 1 : true }));
  const stat = await env.DB.prepare("SELECT total_ms, streak, best_streak FROM game_stats WHERE public_id = ? AND game_id = ?").bind(who, game).first();
  const p = await gamePrefs(env, who);
  let rank = null;
  if (p.linkedName) {
    const top = await topList(env).catch(() => null);
    const hit = top && top.ok ? top.players.find((x) => foldName(x.name) === foldName(p.linkedName)) : null;
    if (hit) rank = { rank: hit.rank, kills: hit.kills, kdr: hit.kdr, deaths: hit.deaths, total: hit.total };
  }
  return deps.json(200, {
    gameId: game,
    achievements: list,
    totalMs: Number(stat && stat.total_ms) || 0,
    bestStreak: Number(stat && stat.best_streak) || 0,
    linkedName: p.linkedName,
    claimed: !!p.linkedName,
    rank
  }, { "cache-control": "private, no-store" });
}

async function achievementsSeen(request, env, viewer, deps) {
  const body = await deps.readJson(request, 2000) || {};
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((a) => ACHIEVEMENT_IDS.indexOf(a) >= 0).slice(0, 30);
  if (ids.length) {
    await env.DB.prepare("UPDATE game_achievements SET seen = 1 WHERE public_id = ? AND game_id = 'regone' AND ach_id IN (" + ids.map(() => "?").join(",") + ")").bind(viewer.public_id, ...ids).run();
  }
  return deps.json(200, { ok: true });
}

/* ---------- invites ---------- */

function presentInvite(row, person) {
  return {
    id: row.id,
    gameId: row.game_id,
    from: person || null,
    room: row.room || "",
    message: row.message || "",
    lobbyId: row.lobby_id || "",
    private: Number(row.private) === 1,
    status: row.status === "pending" && Number(row.expires_at) <= Date.now() ? "expired" : row.status,
    createdAt: Number(row.created_at) || 0,
    expiresAt: Number(row.expires_at) || 0
  };
}

export async function sendInvite(env, viewer, input, deps) {
  const game = String(input.gameId || "");
  const to = String(input.to || "");
  if (game !== "regone" || !ID.test(to) || to === viewer.public_id) return { status: 400, body: { error: "bad_invite" } };
  const paced = await deps.rateHit(env, "game-invite:" + viewer.public_id, 10, 10 * 60 * 1000);
  if (!paced.ok) return { limited: paced };
  if (await blocksEither(env, viewer.public_id, to) || await actorHidden(env, to, viewer.public_id)) return { status: 403, body: { error: "unavailable" } };
  if (!await areFriends(env, viewer.public_id, to)) return { status: 403, body: { error: "friends_only" } };
  const room = cleanRoom(input.room);
  const msg = checkMessage(input.message);
  if (!msg.ok) return { status: 400, body: { error: "message_" + msg.error } };
  const lobbyId = /^[a-f0-9]{24}$/.test(String(input.lobbyId || "")) ? String(input.lobbyId) : "";
  if (lobbyId) {
    const lobby = await env.DB.prepare("SELECT host_id, expires_at FROM game_lobbies WHERE id = ?").bind(lobbyId).first();
    const member = await env.DB.prepare("SELECT 1 AS ok FROM game_lobby_members WHERE lobby_id = ? AND public_id = ?").bind(lobbyId, viewer.public_id).first();
    if (!lobby || !member || Number(lobby.expires_at) <= Date.now()) return { status: 404, body: { error: "no_lobby" } };
  }
  const now = Date.now();
  const pending = await env.DB.prepare(
    "SELECT id, expires_at FROM game_invites WHERE from_id = ? AND to_id = ? AND game_id = ? AND status = 'pending' AND expires_at > ? AND lobby_id = ? LIMIT 1"
  ).bind(viewer.public_id, to, game, now, lobbyId).first();
  if (pending) return { status: 200, body: { ok: true, sent: false, id: pending.id, expiresAt: Number(pending.expires_at) } };
  const id = randomId();
  const priv = input.private === true ? 1 : 0;
  await env.DB.prepare(
    "INSERT INTO game_invites (id, game_id, from_id, to_id, room, message, lobby_id, private, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)"
  ).bind(id, game, viewer.public_id, to, room, msg.text, lobbyId, priv, now, now + INVITE_MS).run();
  const row = { id, game_id: game, room, message: msg.text, lobby_id: lobbyId, private: priv, status: "pending", created_at: now, expires_at: now + INVITE_MS };
  const notePrefs = await readNotePrefs(env, to).catch(() => ({}));
  if (notePrefs.games !== "off") {
    const p = await gamePrefs(env, to);
    const quiet = p.quiet.on && inQuiet(now, p.tz, p.quiet.from, p.quiet.to);
    const parts = ["ReGone"];
    if (room) parts.push(room);
    if (msg.text) parts.push("\u201C" + msg.text + "\u201D");
    await emitNotification(env, {
      publicId: to,
      kind: "game_invite",
      at: now,
      actorId: viewer.public_id,
      idempotencyKey: "gameinv:" + id,
      handle: viewer.handle,
      name: viewer.display_name,
      avatar: viewer.hide_avatar === 1 ? "" : viewer.avatar,
      text: parts.join(" \u00B7 "),
      hash: "#/games/regone?invite=" + id,
      platform: "app",
      feedId: "app:" + viewer.public_id,
      noPush: quiet
    });
    await publish(env, to, { type: "invite", invite: presentInvite(row, personOf(viewer)), quiet });
  }
  const fresh = await awardGame(env, viewer.public_id, game, {});
  return { status: 200, body: { ok: true, sent: true, id, expiresAt: now + INVITE_MS, room, message: msg.text, achievements: fresh } };
}

async function inviteRoute(request, env, viewer, deps) {
  const body = await deps.readJson(request, 2000) || {};
  const out = await sendInvite(env, viewer, body, deps);
  if (out.limited) return deps.limited(out.limited);
  return deps.json(out.status, out.body);
}

async function invitesList(env, viewer, deps) {
  const now = Date.now();
  const incoming = rows(await env.DB.prepare(
    "SELECT * FROM game_invites WHERE to_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 20"
  ).bind(viewer.public_id, now).all());
  const sent = rows(await env.DB.prepare(
    "SELECT * FROM game_invites WHERE from_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20"
  ).bind(viewer.public_id, now - 60 * 60 * 1000).all());
  const who = await people(env, incoming.map((r) => r.from_id).concat(sent.map((r) => r.to_id)));
  const inList = [];
  for (const row of incoming) {
    if (await hiddenPair(env, viewer.public_id, row.from_id)) continue;
    inList.push(presentInvite(row, personOf(who.get(String(row.from_id)))));
  }
  const outList = sent.map((row) => Object.assign(presentInvite(row, null), { to: personOf(who.get(String(row.to_id))) }));
  return deps.json(200, { incoming: inList, sent: outList, now }, { "cache-control": "private, no-store" });
}

async function recordTogether(env, ids, game) {
  const list = Array.from(new Set(ids.filter((x) => ID.test(x))));
  const now = Date.now();
  const stmts = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] < list[j] ? list[i] : list[j];
      const b = list[i] < list[j] ? list[j] : list[i];
      stmts.push(env.DB.prepare(
        "INSERT INTO game_together (a_id, b_id, game_id, times, last_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(a_id, b_id, game_id) DO UPDATE SET times = game_together.times + 1, last_at = excluded.last_at"
      ).bind(a, b, game, now));
    }
  }
  if (stmts.length) await env.DB.batch(stmts.slice(0, 60));
}

async function inviteAnswer(request, env, viewer, deps) {
  const body = await deps.readJson(request, 1000) || {};
  const id = String(body.id || "");
  const answer = body.answer === "join" ? "joined" : body.answer === "decline" ? "declined" : "";
  if (!/^[a-f0-9]{24}$/.test(id) || !answer) return deps.json(400, { error: "bad_answer" });
  const row = await env.DB.prepare("SELECT * FROM game_invites WHERE id = ? AND to_id = ?").bind(id, viewer.public_id).first();
  if (!row) return deps.json(404, { error: "not_found" });
  const now = Date.now();
  if (row.status !== "pending") return deps.json(409, { error: "answered", status: row.status });
  if (Number(row.expires_at) <= now) {
    await env.DB.prepare("UPDATE game_invites SET status = 'expired' WHERE id = ?").bind(id).run();
    return deps.json(410, { error: "expired" });
  }
  if (await hiddenPair(env, viewer.public_id, row.from_id)) return deps.json(403, { error: "unavailable" });
  await env.DB.prepare("UPDATE game_invites SET status = ?, answered_at = ? WHERE id = ?").bind(answer, now, id).run();
  let lobby = null;
  if (answer === "joined" && row.lobby_id) {
    const l = await env.DB.prepare("SELECT * FROM game_lobbies WHERE id = ? AND expires_at > ?").bind(row.lobby_id, now).first();
    if (l) {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_lobby_members WHERE lobby_id = ?").bind(l.id).first();
      if ((Number(count && count.n) || 0) < LOBBY_MAX) {
        await env.DB.prepare("INSERT INTO game_lobby_members (lobby_id, public_id, ready, joined_at) VALUES (?, ?, 0, ?) ON CONFLICT(lobby_id, public_id) DO NOTHING").bind(l.id, viewer.public_id, now).run();
        lobby = l.id;
        await tellLobby(env, l.id, { type: "lobby", id: l.id });
      }
    }
  }
  let mine = [];
  if (answer === "joined") {
    // A private session records nothing shared.
    if (Number(row.private) !== 1) await recordTogether(env, [row.from_id, viewer.public_id], row.game_id);
    await awardGame(env, row.from_id, row.game_id, {});
    mine = await awardGame(env, viewer.public_id, row.game_id, {});
    if (row.room && Number(row.private) !== 1) await setRoom(env, viewer.public_id, row.game_id, row.room);
  }
  await publish(env, row.from_id, { type: "invite-status", id, status: answer, by: personOf(viewer) });
  return deps.json(200, { ok: true, status: answer, gameId: row.game_id, room: row.room || "", lobbyId: lobby || "", achievements: mine });
}

/* ---------- rooms ---------- */

async function cached(key, ttl, make) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const req = new Request("https://games-cache.internal/" + key);
  if (cache) {
    try {
      const hit = await cache.match(req);
      if (hit) return await hit.json();
    } catch (err) { /* no cache */ }
  }
  const value = await make();
  if (cache && value && value.ok) {
    try {
      await cache.put(req, new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + ttl } }));
    } catch (err) { /* no cache */ }
  }
  return value;
}

let roomsMemo = null;
async function readList(url, clan) {
  try {
    const res = await fetch(url, { headers: { "user-agent": POLITE_UA, accept: "application/json" } });
    if (!res.ok) return [];
    return roomsFromList(await res.json(), { clan });
  } catch (err) { return []; }
}
/* NZlay's public room lists (official and clan), at most once every five
   minutes. Names, map, mode, size and region only; no player counts exist
   there and the game's own sockets are never touched. */
async function roomList() {
  if (roomsMemo && Date.now() - roomsMemo.at < ROOMS_CACHE_S * 1000) return roomsMemo.value;
  const value = await cached("regone-rooms-v2", ROOMS_CACHE_S, async () => {
    const list = await readList(ROOM_SOURCE, false);
    if (!list.length) return { ok: false };
    const official = new Set(list.map((r) => r.name));
    const clans = (await readList(CLAN_ROOM_SOURCE, true)).filter((r) => !official.has(r.name)).slice(0, 200);
    return { ok: true, source: "live", rooms: list, clans };
  });
  const out = value && value.ok ? value : { ok: true, source: "curated", rooms: CURATED_ROOMS, clans: [] };
  roomsMemo = { at: Date.now(), value: out };
  return out;
}

export async function setRoom(env, id, game, room) {
  const clean = cleanRoom(room);
  if (!clean) {
    await env.DB.prepare("DELETE FROM game_rooms WHERE public_id = ?").bind(id).run();
    return "";
  }
  await env.DB.prepare(
    "INSERT INTO game_rooms (public_id, game_id, room, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET game_id = excluded.game_id, room = excluded.room, updated_at = excluded.updated_at"
  ).bind(id, game, clean, Date.now()).run();
  return clean;
}

async function roomRoute(request, env, viewer, deps) {
  const body = await deps.readJson(request, 1000) || {};
  const paced = await deps.rateHit(env, "game-room:" + viewer.public_id, 30, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const p = await gamePrefs(env, viewer.public_id);
  if (body.room && p.aud.room === "only") return deps.json(200, { ok: true, room: "", hidden: true });
  const room = await setRoom(env, viewer.public_id, "regone", body.room || "");
  return deps.json(200, { ok: true, room });
}

/* Rooms and playing state of these people as the viewer may see them. */
export async function roomsFor(env, viewerId, ids) {
  const out = new Map();
  const list = (ids || []).map(String).filter((x) => ID.test(x)).slice(0, 100);
  if (!list.length) return out;
  try {
    const got = rows(await env.DB.prepare(
      "SELECT public_id, game_id, room, updated_at FROM game_rooms WHERE updated_at > ? AND public_id IN (" + list.map(() => "?").join(",") + ")"
    ).bind(Date.now() - ROOM_TTL_MS, ...list).all());
    for (const row of got) {
      if (await canSeeGame(env, String(row.public_id), viewerId, "room")) out.set(String(row.public_id), { gameId: row.game_id, room: row.room });
    }
  } catch (err) { /* no table yet */ }
  return out;
}

async function friendsRooms(env, viewer, deps) {
  const ids = await friendIds(env, viewer.public_id);
  const rooms = await roomsFor(env, viewer.public_id, ids);
  const who = await people(env, Array.from(rooms.keys()));
  const list = [];
  rooms.forEach((value, id) => {
    const row = who.get(id);
    if (!row || row.profile_less === 1) return;
    list.push(Object.assign(personOf(row), { room: value.room, gameId: value.gameId }));
  });
  return deps.json(200, { friends: list }, { "cache-control": "private, no-store" });
}

/* Profile and Messages badge: playing now and room for one person. */
async function presenceOne(env, viewer, deps, url, playingIds) {
  const id = String(url.searchParams.get("id") || "");
  if (!ID.test(id)) return deps.json(400, { error: "bad_id" });
  if (!await canSeeGame(env, id, viewer.public_id, "room")) return deps.json(200, { playing: false, room: "" }, { "cache-control": "private, no-store" });
  const playing = await playingIds(env, [id]);
  const rooms = await roomsFor(env, viewer.public_id, [id]);
  const room = rooms.get(id);
  return deps.json(200, {
    playing: playing.has(id) || !!room,
    gameId: "regone",
    room: room ? room.room : "",
    canInvite: id !== viewer.public_id && await areFriends(env, viewer.public_id, id)
  }, { "cache-control": "private, no-store" });
}

/* ---------- lobbies ---------- */

async function lobbyView(env, id, viewerId) {
  const now = Date.now();
  const l = await env.DB.prepare("SELECT * FROM game_lobbies WHERE id = ?").bind(id).first();
  if (!l || Number(l.expires_at) <= now) return null;
  const members = rows(await env.DB.prepare("SELECT public_id, ready, joined_at FROM game_lobby_members WHERE lobby_id = ? ORDER BY joined_at ASC").bind(id).all());
  const isMember = members.some((m) => String(m.public_id) === viewerId);
  const invited = isMember ? null : await env.DB.prepare("SELECT id FROM game_invites WHERE lobby_id = ? AND to_id = ? AND status = 'pending' AND expires_at > ?").bind(id, viewerId, now).first();
  if (!isMember && !invited) return null;
  const who = await people(env, members.map((m) => m.public_id));
  const list = [];
  for (const m of members) {
    const pid = String(m.public_id);
    if (pid !== viewerId && await hiddenPair(env, pid, viewerId)) continue;
    const person = personOf(who.get(pid));
    if (!person) continue;
    list.push(Object.assign(person, { ready: Number(m.ready) === 1, host: pid === String(l.host_id), me: pid === viewerId }));
  }
  return {
    id: l.id,
    gameId: l.game_id,
    hostId: String(l.host_id),
    room: l.room || "",
    private: Number(l.private) === 1,
    member: isMember,
    members: list,
    launchedAt: Number(l.launched_at) || 0,
    expiresAt: Number(l.expires_at) || 0
  };
}

async function tellLobby(env, id, data) {
  const members = rows(await env.DB.prepare("SELECT public_id FROM game_lobby_members WHERE lobby_id = ?").bind(id).all());
  for (const m of members) await publish(env, String(m.public_id), data);
}

async function lobbyRoute(request, env, viewer, deps, path, url) {
  const me = viewer.public_id;
  const now = Date.now();
  await env.DB.prepare("DELETE FROM game_lobby_members WHERE lobby_id IN (SELECT id FROM game_lobbies WHERE expires_at <= ?)").bind(now).run();
  await env.DB.prepare("DELETE FROM game_lobbies WHERE expires_at <= ?").bind(now).run();
  if (path === "/v1/games/lobby" && request.method === "GET") {
    const id = String(url.searchParams.get("id") || "");
    let lobbyId = id;
    if (!lobbyId) {
      const mine = await env.DB.prepare("SELECT m.lobby_id FROM game_lobby_members m JOIN game_lobbies l ON l.id = m.lobby_id WHERE m.public_id = ? AND l.launched_at = 0 ORDER BY m.joined_at DESC LIMIT 1").bind(me).first();
      lobbyId = mine ? mine.lobby_id : "";
    }
    const view = lobbyId ? await lobbyView(env, lobbyId, me) : null;
    return deps.json(view || !id ? 200 : 404, view ? { lobby: view } : { lobby: null }, { "cache-control": "private, no-store" });
  }
  if (request.method !== "POST") return deps.json(405, { error: "method" });
  const body = await deps.readJson(request, 2000) || {};
  const paced = await deps.rateHit(env, "game-lobby:" + me, 60, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  if (path === "/v1/games/lobby") {
    const room = cleanRoom(body.room);
    const priv = body.private === true ? 1 : 0;
    const old = rows(await env.DB.prepare("SELECT id FROM game_lobbies WHERE host_id = ?").bind(me).all());
    for (const o of old) {
      await tellLobby(env, o.id, { type: "lobby-closed", id: o.id });
      await env.DB.batch([env.DB.prepare("DELETE FROM game_lobby_members WHERE lobby_id = ?").bind(o.id), env.DB.prepare("DELETE FROM game_lobbies WHERE id = ?").bind(o.id)]);
    }
    const id = randomId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO game_lobbies (id, game_id, host_id, room, private, created_at, expires_at) VALUES (?, 'regone', ?, ?, ?, ?, ?)").bind(id, me, room, priv, now, now + LOBBY_MS),
      env.DB.prepare("INSERT INTO game_lobby_members (lobby_id, public_id, ready, joined_at) VALUES (?, ?, 1, ?)").bind(id, me, now)
    ]);
    if (room && !priv) await setRoom(env, me, "regone", room);
    return deps.json(200, { lobby: await lobbyView(env, id, me) });
  }
  const id = String(body.id || "");
  if (!/^[a-f0-9]{24}$/.test(id)) return deps.json(400, { error: "bad_lobby" });
  const l = await env.DB.prepare("SELECT * FROM game_lobbies WHERE id = ? AND expires_at > ?").bind(id, now).first();
  if (!l) return deps.json(404, { error: "no_lobby" });
  const member = await env.DB.prepare("SELECT ready FROM game_lobby_members WHERE lobby_id = ? AND public_id = ?").bind(id, me).first();
  const host = String(l.host_id) === me;
  if (path === "/v1/games/lobby/join") {
    if (!member) {
      const invited = await env.DB.prepare("SELECT id FROM game_invites WHERE lobby_id = ? AND to_id = ? AND status = 'pending' AND expires_at > ?").bind(id, me, now).first();
      if (!invited || await hiddenPair(env, me, String(l.host_id))) return deps.json(403, { error: "not_invited" });
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM game_lobby_members WHERE lobby_id = ?").bind(id).first();
      if ((Number(count && count.n) || 0) >= LOBBY_MAX) return deps.json(409, { error: "full" });
      await env.DB.prepare("INSERT INTO game_lobby_members (lobby_id, public_id, ready, joined_at) VALUES (?, ?, 0, ?)").bind(id, me, now).run();
      await env.DB.prepare("UPDATE game_invites SET status = 'joined', answered_at = ? WHERE id = ?").bind(now, invited.id).run();
      await publish(env, String(l.host_id), { type: "invite-status", id: invited.id, status: "joined", by: personOf(viewer) });
    }
    await tellLobby(env, id, { type: "lobby", id });
    return deps.json(200, { lobby: await lobbyView(env, id, me) });
  }
  if (!member) return deps.json(403, { error: "not_member" });
  if (path === "/v1/games/lobby/ready") {
    await env.DB.prepare("UPDATE game_lobby_members SET ready = ? WHERE lobby_id = ? AND public_id = ?").bind(body.ready === false ? 0 : 1, id, me).run();
    await tellLobby(env, id, { type: "lobby", id });
    return deps.json(200, { lobby: await lobbyView(env, id, me) });
  }
  if (path === "/v1/games/lobby/room") {
    if (!host) return deps.json(403, { error: "host_only" });
    const room = cleanRoom(body.room);
    await env.DB.prepare("UPDATE game_lobbies SET room = ? WHERE id = ?").bind(room, id).run();
    if (room && Number(l.private) !== 1) await setRoom(env, me, "regone", room);
    await tellLobby(env, id, { type: "lobby", id });
    return deps.json(200, { lobby: await lobbyView(env, id, me) });
  }
  if (path === "/v1/games/lobby/leave") {
    if (host) {
      await tellLobby(env, id, { type: "lobby-closed", id });
      await env.DB.batch([env.DB.prepare("DELETE FROM game_lobby_members WHERE lobby_id = ?").bind(id), env.DB.prepare("DELETE FROM game_lobbies WHERE id = ?").bind(id)]);
    } else {
      await env.DB.prepare("DELETE FROM game_lobby_members WHERE lobby_id = ? AND public_id = ?").bind(id, me).run();
      await tellLobby(env, id, { type: "lobby", id });
    }
    return deps.json(200, { ok: true });
  }
  if (path === "/v1/games/lobby/launch") {
    if (!host) return deps.json(403, { error: "host_only" });
    await env.DB.prepare("UPDATE game_lobbies SET launched_at = ? WHERE id = ?").bind(now, id).run();
    const members = rows(await env.DB.prepare("SELECT public_id, ready FROM game_lobby_members WHERE lobby_id = ?").bind(id).all()).map((m) => String(m.public_id));
    if (Number(l.private) !== 1) await recordTogether(env, members, l.game_id);
    for (const m of members) {
      await publish(env, m, { type: "lobby-launch", id, gameId: l.game_id, room: l.room || "" });
      await awardGame(env, m, l.game_id, {});
    }
    return deps.json(200, { ok: true, launchedAt: now, room: l.room || "", members: members.length });
  }
  return deps.json(404, { error: "not_found" });
}

/* ---------- played together ---------- */

async function togetherGet(env, viewer, deps, url) {
  const owner = String(url.searchParams.get("id") || viewer.public_id);
  if (!ID.test(owner)) return deps.json(400, { error: "bad_id" });
  const me = viewer.public_id;
  if (owner !== me && !await canSeeGame(env, owner, me, "together")) return deps.json(200, { hidden: true, people: [] }, { "cache-control": "private, no-store" });
  const got = rows(await env.DB.prepare(
    "SELECT a_id, b_id, times, last_at FROM game_together WHERE a_id = ? OR b_id = ? ORDER BY last_at DESC LIMIT 50"
  ).bind(owner, owner).all());
  const mates = got.map((r) => ({ id: String(r.a_id) === owner ? String(r.b_id) : String(r.a_id), times: Number(r.times) || 0, lastAt: Number(r.last_at) || 0 }));
  const who = await people(env, mates.map((m) => m.id));
  const out = [];
  for (const m of mates) {
    // Your own history is yours to see; anyone else needs both players' yes.
    if (owner === me) { if (await hiddenPair(env, me, m.id)) continue; }
    else if (m.id !== me && !await canSeePair(env, owner, m.id, me)) continue;
    else if (m.id === me && await hiddenPair(env, owner, me)) continue;
    const row = who.get(m.id);
    if (!row || row.profile_less === 1) continue;
    out.push(Object.assign(personOf(row), { times: m.times, lastAt: m.lastAt }));
  }
  return deps.json(200, { people: out }, { "cache-control": "private, no-store" });
}

async function togetherClear(env, viewer, deps) {
  await env.DB.prepare("DELETE FROM game_together WHERE a_id = ? OR b_id = ?").bind(viewer.public_id, viewer.public_id).run();
  return deps.json(200, { ok: true });
}

/* ---------- NZlay Top 100 ---------- */

let topMemo = null;
let onlineMemo = null;
const profileMemo = new Map();
export function forgetTop() { topMemo = null; roomsMemo = null; onlineMemo = null; profileMemo.clear(); }

/* Players online across ReGone, the same number NZlay's own page shows. */
async function onlineCount() {
  if (onlineMemo && Date.now() - onlineMemo.at < ONLINE_CACHE_S * 1000) return onlineMemo.value;
  const value = await cached("regone-online-v1", ONLINE_CACHE_S, async () => {
    try {
      const res = await fetch(ONLINE_SOURCE, { headers: { "user-agent": POLITE_UA, accept: "application/json" } });
      if (!res.ok) return { ok: false };
      const body = await res.json();
      const n = Number(body && body.online);
      return isFinite(n) && n >= 0 ? { ok: true, online: Math.round(n), at: Date.now() } : { ok: false };
    } catch (err) { return { ok: false }; }
  });
  const out = value && value.ok ? value : { ok: false, online: 0 };
  onlineMemo = { at: Date.now(), value: out };
  return out;
}

/* Stats for the name someone linked to their own account, read on demand
   from that one public NZlay profile page, at most once an hour per name. */
async function profileStats(name) {
  const key = foldName(name);
  const memo = profileMemo.get(key);
  if (memo && Date.now() - memo.at < (memo.value.ok ? PROFILE_CACHE_S : 300) * 1000) return memo.value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  const tag = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  const value = await cached("regone-profile-v1-" + tag, PROFILE_CACHE_S, async () => {
    try {
      const res = await fetch(PROFILE_SOURCE + encodeURIComponent(name), { headers: { "user-agent": POLITE_UA, accept: "text/html" } });
      if (!res.ok) return { ok: false };
      const stats = parseProfileStats(await res.text());
      return stats ? { ok: true, stats, at: Date.now() } : { ok: false };
    } catch (err) { return { ok: false }; }
  });
  const out = value && value.ok ? value : { ok: false };
  if (profileMemo.size > 500) profileMemo.clear();
  profileMemo.set(key, { at: Date.now(), value: out });
  return out;
}

async function profileStatsRoute(env, viewer, deps, url) {
  const me = viewer.public_id;
  const who = String(url.searchParams.get("id") || me);
  if (!ID.test(who)) return deps.json(400, { error: "bad_id" });
  if (who !== me && !await canSeeGame(env, who, me, "stats")) return deps.json(200, { ok: false, hidden: true }, { "cache-control": "private, no-store" });
  const p = await gamePrefs(env, who);
  if (!p.linkedName) return deps.json(200, { ok: false, linked: false }, { "cache-control": "private, no-store" });
  // Only the owner's own visits fetch from NZlay; others read what is cached.
  if (who !== me && !profileMemo.has(foldName(p.linkedName))) return deps.json(200, { ok: false, linked: true, pending: true }, { "cache-control": "private, no-store" });
  if (who === me) {
    const paced = await deps.rateHit(env, "game-pstats:" + me, 12, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
  }
  const got = await profileStats(p.linkedName);
  if (!got.ok) return deps.json(200, { ok: false, linked: true }, { "cache-control": "private, no-store" });
  const s = got.stats;
  const fresh = who === me ? await awardGame(env, me, "regone", { weaponBest: s.weaponBest, hits: s.hits, headshotRate: s.headshotRate, multiKills: s.multiKills, matchesWon: s.matchesWon }) : [];
  return deps.json(200, { ok: true, linked: true, claimed: true, name: p.linkedName, stats: s, fetchedAt: got.at || 0, source: PROFILE_SOURCE, achievements: fresh }, { "cache-control": "private, no-store" });
}
export async function topList(env) {
  if (topMemo && Date.now() - topMemo.at < (topMemo.value.ok ? TOP_CACHE_S : 120) * 1000) return topMemo.value;
  const value = await cached("regone-top-v1", TOP_CACHE_S, async () => {
    try {
      const res = await fetch(TOP_SOURCE, { headers: { "user-agent": POLITE_UA, accept: "text/html" } });
      if (!res.ok) return { ok: false };
      const players = parseTop(await res.text());
      return players.length >= 3 ? { ok: true, fetchedAt: Date.now(), players } : { ok: false };
    } catch (err) { return { ok: false }; }
  });
  const out = value && value.ok ? value : { ok: false, players: [] };
  topMemo = { at: Date.now(), value: out };
  return out;
}

/* Rank and kill achievements for a claimed name on the board, once each,
   with a snapshot to see how far someone climbed. */
export async function rankCheck(env, id, game) {
  const p = await gamePrefs(env, id);
  if (!p.linkedName) return [];
  const top = await topList(env);
  if (!top.ok) return [];
  const hit = top.players.find((x) => foldName(x.name) === foldName(p.linkedName));
  if (!hit) return [];
  const snap = await env.DB.prepare("SELECT rank, kills, best_rank FROM game_board_snap WHERE public_id = ? AND game_id = ?").bind(id, game).first();
  const climbed = snap && Number(snap.rank) > 0 ? Number(snap.rank) - hit.rank : 0;
  const best = snap && Number(snap.best_rank) > 0 ? Math.min(Number(snap.best_rank), hit.rank) : hit.rank;
  await env.DB.prepare(
    "INSERT INTO game_board_snap (public_id, game_id, rank, kills, best_rank, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(public_id, game_id) DO UPDATE SET rank = excluded.rank, kills = excluded.kills, best_rank = excluded.best_rank, updated_at = excluded.updated_at"
  ).bind(id, game, hit.rank, Math.round(hit.kills), best, Date.now()).run();
  return awardGame(env, id, game, { rank: hit.rank, kills: hit.kills, climbed });
}

async function topRoute(env, viewer, deps) {
  const top = await topList(env);
  if (!top.ok) return deps.json(200, { ok: false, players: [], source: TOP_SOURCE }, { "cache-control": "private, max-age=60" });
  // Friends who claimed a name on the board, when they let you see stats.
  const friends = [];
  let mine = null;
  if (viewer) {
    const ids = await friendIds(env, viewer.public_id);
    const names = new Map(top.players.map((x) => [foldName(x.name), x.rank]));
    if (ids.length) {
      const got = rows(await env.DB.prepare("SELECT public_id, linked_name FROM game_prefs WHERE linked_name != '' AND public_id IN (" + ids.slice(0, 100).map(() => "?").join(",") + ")").bind(...ids.slice(0, 100)).all());
      const who = await people(env, got.map((r) => r.public_id));
      for (const r of got) {
        const rank = names.get(foldName(r.linked_name));
        if (!rank || !await canSeeGame(env, String(r.public_id), viewer.public_id, "stats")) continue;
        const person = personOf(who.get(String(r.public_id)));
        if (person) friends.push(Object.assign(person, { rank }));
      }
    }
    const p = await gamePrefs(env, viewer.public_id);
    if (p.linkedName) mine = { name: p.linkedName, rank: names.get(foldName(p.linkedName)) || 0 };
  }
  return deps.json(200, { ok: true, source: TOP_SOURCE, fetchedAt: top.fetchedAt || 0, players: top.players, friends, mine }, { "cache-control": "private, max-age=60" });
}

/* ReGone badges for the author names on one NZlay forum page: the public
   Top 100 rank, and the app account of someone who linked that name to
   themselves, only when their stats audience lets this viewer see it. */
async function forumBadges(env, viewer, deps, url) {
  const names = Array.from(new Set(String(url.searchParams.get("names") || "").split(",").map((n) => cleanRoom(n).slice(0, 40)).filter(Boolean))).slice(0, 40);
  const badges = {};
  if (!names.length) return deps.json(200, { ok: true, badges }, { "cache-control": "private, max-age=60" });
  const off = await readFlags(env).catch(() => ({}));
  const ranks = new Map();
  if (!off.regone_leaderboard) {
    const top = await topList(env);
    if (top.ok) top.players.forEach((p) => ranks.set(foldName(p.name), p));
  }
  const folded = new Map(names.map((n) => [foldName(n), n]));
  folded.forEach((name, key) => {
    const hit = ranks.get(key);
    if (hit) badges[name] = { rank: hit.rank, kills: Math.round(Number(hit.kills) || 0) };
  });
  if (!off.regone_profile_stats) {
    const lowered = Array.from(folded.keys());
    const got = rows(await env.DB.prepare("SELECT public_id, linked_name FROM game_prefs WHERE linked_name != '' AND lower(linked_name) IN (" + lowered.map(() => "?").join(",") + ") LIMIT 60").bind(...lowered).all());
    const claimed = got.filter((r) => folded.has(foldName(r.linked_name)));
    const who = await people(env, claimed.map((r) => r.public_id));
    const taken = new Set();
    for (const r of claimed) {
      const key = foldName(r.linked_name);
      if (taken.has(key)) continue;
      const id = String(r.public_id);
      if (!await canSeeGame(env, id, viewer.public_id, "stats")) continue;
      const person = personOf(who.get(id));
      if (!person) continue;
      taken.add(key);
      const name = folded.get(key);
      badges[name] = Object.assign(badges[name] || {}, { person });
    }
  }
  return deps.json(200, { ok: true, badges }, { "cache-control": "private, max-age=60" });
}

async function linkName(request, env, viewer, deps) {
  const body = await deps.readJson(request, 1000) || {};
  const paced = await deps.rateHit(env, "game-link:" + viewer.public_id, 10, 60 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const name = cleanRoom(body.name).slice(0, 40);
  await ensurePrefsRow(env, viewer.public_id);
  await env.DB.prepare("UPDATE game_prefs SET linked_name = ?, updated_at = ? WHERE public_id = ?").bind(name, Date.now(), viewer.public_id).run();
  if (!name) await env.DB.prepare("DELETE FROM game_board_snap WHERE public_id = ?").bind(viewer.public_id).run();
  const fresh = name ? await rankCheck(env, viewer.public_id, "regone").catch(() => []) : [];
  return deps.json(200, { ok: true, linkedName: name, achievements: fresh });
}

/* ---------- router ---------- */

export async function handleGameSocial(request, env, path, url, viewer, deps, extra) {
  const m = request.method;
  if (path === "/v1/games/invite" && m === "POST") return inviteRoute(request, env, viewer, deps);
  if (path === "/v1/games/invites" && m === "GET") return invitesList(env, viewer, deps);
  if (path === "/v1/games/invite/answer" && m === "POST") return inviteAnswer(request, env, viewer, deps);
  if ((path === "/v1/games/rooms" || path === "/v1/games/regone/rooms") && m === "GET") return deps.json(200, await roomList(), { "cache-control": "private, max-age=120" });
  if (path === "/v1/games/regone/online" && m === "GET") return deps.json(200, await onlineCount(), { "cache-control": "private, max-age=60" });
  if (path === "/v1/games/regone/profile-stats" && m === "GET") return profileStatsRoute(env, viewer, deps, url);
  if (path === "/v1/games/room" && m === "POST") return roomRoute(request, env, viewer, deps);
  if (path === "/v1/games/friends-rooms" && m === "GET") return friendsRooms(env, viewer, deps);
  if (path === "/v1/games/presence" && m === "GET") return presenceOne(env, viewer, deps, url, extra.playingIds);
  if (path === "/v1/games/lobby" || path.startsWith("/v1/games/lobby/")) return lobbyRoute(request, env, viewer, deps, path, url);
  if (path === "/v1/games/achievements" && m === "GET") return achievementsGet(env, viewer, deps, url);
  if (path === "/v1/games/achievements/seen" && m === "POST") return achievementsSeen(request, env, viewer, deps);
  if (path === "/v1/games/prefs" && m === "GET") return prefsGet(env, viewer, deps);
  if (path === "/v1/games/prefs" && m === "POST") return prefsSet(request, env, viewer, deps);
  if (path === "/v1/games/together" && m === "GET") return togetherGet(env, viewer, deps, url);
  if (path === "/v1/games/together" && m === "DELETE") return togetherClear(env, viewer, deps);
  if (path === "/v1/games/regone/top" && m === "GET") return topRoute(env, viewer, deps);
  if (path === "/v1/games/regone/forum-badges" && m === "GET") return forumBadges(env, viewer, deps, url);
  if (path === "/v1/games/link-name" && m === "POST") return linkName(request, env, viewer, deps);
  return null;
}
