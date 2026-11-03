/* Presence and custom status.
   The heartbeat is the source of truth. A coalesced beat does not write
   D1 and does not wake watcher objects. Live updates go through the
   generic account channel only when the visible state, privacy, or
   custom status changes. */

import { playingNow } from "./games.js";
import { friendsOffAmong } from "./friends-pref.js";
import {
  PRESENCE_CACHE_MS,
  WRITE_WINDOW_MS,
  activeStatus,
  applyBeat,
  canSeeExact,
  cleanEmoji,
  cleanStatusText,
  clearAtFrom,
  effectiveState,
  isAccountId,
  listIds,
  normalizeActivity,
  normalizeClear,
  normalizePreference,
  normalizePrivacy,
  publicPresence,
  relationAllows,
  shouldWriteBeat
} from "../../shared/presence.js";
import { statusEmojiAllowed } from "./store.js";
import { deliverToAccount, listWatchers, publishToAccount } from "./channel.js";

const READ_LIMIT = 40;
const CACHE_PREFIX = "https://presence.internal/v1/";
const PREFERENCES = ["online", "idle", "dnd", "invisible"];
const ACTIVITIES = ["active", "idle", "hidden"];
const PRIVACY = ["everyone", "follows", "followers", "mutuals", "lists", "nobody"];
const PRESENCE_COLS = "public_id, preference, activity, seen_privacy, seen_lists, last_seen, last_beat, reciprocal, updated_at";
const CLEARS = ["30m", "1h", "4h", "today", "week", "never"];
// Who sees the custom status (emoji and text): the same choices as last seen.
const STATUS_COLS = "public_id, emoji, text, clear_at, updated_at, audience, audience_lists";

export const PRESENCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account_presence (
    public_id TEXT PRIMARY KEY,
    preference TEXT NOT NULL DEFAULT 'online',
    activity TEXT NOT NULL DEFAULT 'hidden',
    seen_privacy TEXT NOT NULL DEFAULT 'everyone',
    seen_lists TEXT NOT NULL DEFAULT '',
    last_seen INTEGER NOT NULL DEFAULT 0,
    last_beat INTEGER NOT NULL DEFAULT 0,
    reciprocal INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS account_status (
    public_id TEXT PRIMARY KEY,
    emoji TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    clear_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    audience TEXT NOT NULL DEFAULT 'everyone',
    audience_lists TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS account_status_clear ON account_status(clear_at)"
];

function rows(result) {
  return (result && result.results) || [];
}

function idList(raw, limit) {
  const out = [];
  const parts = String(raw || "").split(",");
  const cap = limit || READ_LIMIT;
  for (let i = 0; i < parts.length && out.length < cap; i++) {
    const id = parts[i].trim();
    if (isAccountId(id) && out.indexOf(id) < 0) out.push(id);
  }
  return out;
}

function known(list, value) {
  return list.indexOf(String(value || "")) >= 0;
}

function privateJson(deps, body) {
  return deps.json(200, body, {
    "cache-control": "private, max-age=15",
    "cdn-cache-control": "no-store"
  });
}

async function accountOf(env, request, deps) {
  const account = await deps.sessionAccount(env, request);
  if (!account) return { error: deps.json(401, { error: "unauthorized" }) };
  if (!isAccountId(account.public_id)) return { error: deps.json(403, { error: "account" }) };
  return { account: account };
}

async function readRaw(env, id) {
  const url = CACHE_PREFIX + id;
  try {
    const hit = await caches.default.match(new Request(url));
    if (hit) {
      const at = Number(hit.headers.get("x-fetched-at") || 0);
      if (at && Date.now() - at < PRESENCE_CACHE_MS) return await hit.json();
    }
  } catch (err) { /* a cache miss reads D1 */ }
  const presence = await env.DB.prepare("SELECT " + PRESENCE_COLS + " FROM account_presence WHERE public_id = ?").bind(id).first();
  const status = await env.DB.prepare("SELECT " + STATUS_COLS + " FROM account_status WHERE public_id = ?").bind(id).first();
  const bundle = { presence: presence || null, status: status || null };
  try {
    await caches.default.put(new Request(url), new Response(JSON.stringify(bundle), {
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=20",
        "x-fetched-at": String(Date.now())
      }
    }));
  } catch (err) { /* the response is still fresh from D1 */ }
  return bundle;
}

async function dropRaw(id) {
  try { await caches.default.delete(new Request(CACHE_PREFIX + id)); }
  catch (err) { /* the next read expires on its own */ }
}

async function followTargets(env, followerId, ids) {
  const set = new Set();
  if (!ids.length) return set;
  const marks = ids.map(() => "?").join(",");
  const result = await env.DB.prepare("SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id IN (" + marks + ")").bind(followerId, ...ids.map((id) => "app:" + id)).all();
  rows(result).forEach((row) => {
    const id = String(row.target_id || "");
    if (id.startsWith("app:")) set.add(id.slice(4));
  });
  return set;
}

async function followersAmong(env, targetId, ids) {
  const set = new Set();
  if (!ids.length) return set;
  const marks = ids.map(() => "?").join(",");
  const result = await env.DB.prepare("SELECT follower_id FROM account_follows WHERE target_id = ? AND follower_id IN (" + marks + ")").bind("app:" + targetId, ...ids).all();
  rows(result).forEach((row) => set.add(String(row.follower_id || "")));
  return set;
}

function viewOf(presence, status, exact, now, self, id, statusOk) {
  const view = publicPresence(presence, status, exact, now, self);
  view.id = id;
  if (self) {
    view.statusAudience = normalizePrivacy(status && status.audience);
    view.statusLists = listIds(status && status.audience_lists);
  } else if (statusOk === false) {
    view.emoji = "";
    view.text = "";
  }
  return view;
}

/* The custom status follows its own audience, separate from last seen. */
function statusAllowed(status, rel) {
  if (!status) return true;
  return relationAllows(status.audience || "everyone", rel);
}

function overlaps(set, ids) {
  if (!set || !ids || !ids.length) return false;
  for (let i = 0; i < ids.length; i++) {
    if (set.has(ids[i])) return true;
  }
  return false;
}

async function friendSet(env, userId, ids, userIsSubject) {
  const set = new Set();
  if (!ids.length) return set;
  const marks = ids.map(() => "?").join(",");
  try {
    const result = await env.DB.prepare("SELECT friend_id FROM account_friends WHERE user_id = ? AND friend_id IN (" + marks + ")").bind(userId, ...ids).all();
    rows(result).forEach((row) => set.add(String(row.friend_id || "")));
    // Friends off on either side, or "share online status with friends" off,
    // means the friendship grants no presence.
    if (set.size) {
      // userIsSubject: userId is the person whose presence is shared, so
      // their own "share online status" choice decides; otherwise each
      // friend's choice does.
      if ((await friendsOffAmong(env, [userId], !!userIsSubject)).size) return new Set();
      const quiet = await friendsOffAmong(env, Array.from(set), !userIsSubject);
      quiet.forEach((id) => set.delete(id));
    }
  } catch (err) { /* friends are optional for a presence read */ }
  return set;
}

async function listsContaining(env, ownerIds, memberId) {
  const map = new Map();
  if (!ownerIds.length || !memberId) return map;
  const marks = ownerIds.map(() => "?").join(",");
  try {
    const listed = await env.DB.prepare("SELECT public_id, list_id FROM audience_members WHERE member_id = ? AND public_id IN (" + marks + ")").bind(memberId, ...ownerIds).all();
    rows(listed).forEach((row) => {
      const owner = String(row.public_id || "");
      if (!map.has(owner)) map.set(owner, new Set());
      map.get(owner).add(String(row.list_id || ""));
    });
  } catch (err) { /* a missing list table hides list-only presence */ }
  return map;
}

async function membersOnLists(env, ownerId, memberIds) {
  const map = new Map();
  if (!ownerId || !memberIds.length) return map;
  const marks = memberIds.map(() => "?").join(",");
  try {
    const listed = await env.DB.prepare("SELECT member_id, list_id FROM audience_members WHERE public_id = ? AND member_id IN (" + marks + ")").bind(ownerId, ...memberIds).all();
    rows(listed).forEach((row) => {
      const member = String(row.member_id || "");
      if (!map.has(member)) map.set(member, new Set());
      map.get(member).add(String(row.list_id || ""));
    });
  } catch (err) { /* a missing list table hides list-only presence */ }
  return map;
}

function accessOf(viewerRow, targetRow, followsTarget, targetFollows, friends, targetList, viewerList, same) {
  const reciprocal = viewerRow && viewerRow.reciprocal != null ? Number(viewerRow.reciprocal) !== 0 : true;
  return canSeeExact(
    viewerRow ? viewerRow.seen_privacy : "everyone",
    targetRow ? targetRow.seen_privacy : "everyone",
    followsTarget,
    targetFollows,
    same,
    {
      reciprocal: reciprocal,
      friends: friends,
      targetList: targetList,
      viewerList: viewerList
    }
  );
}

async function decorate(env, viewerId, ids, now) {
  const viewerBundle = await readRaw(env, viewerId);
  const viewerRow = viewerBundle.presence;
  const viewerLists = listIds(viewerRow && viewerRow.seen_lists);
  const others = ids.filter((id) => id !== viewerId);
  const iFollow = await followTargets(env, viewerId, others);
  const followsMe = await followersAmong(env, viewerId, others);
  const friends = await friendSet(env, viewerId, others);
  const theirLists = await listsContaining(env, others, viewerId);
  const myLists = await membersOnLists(env, viewerId, others);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const bundle = id === viewerId ? viewerBundle : await readRaw(env, id);
    const same = id === viewerId;
    const targetLists = listIds(bundle.presence && bundle.presence.seen_lists);
    const exact = accessOf(
      viewerRow,
      bundle.presence,
      iFollow.has(id),
      followsMe.has(id),
      friends.has(id),
      overlaps(theirLists.get(id), targetLists),
      overlaps(myLists.get(id), viewerLists),
      same
    );
    const statusOk = same || statusAllowed(bundle.status, {
      followsSubject: iFollow.has(id),
      subjectFollows: followsMe.has(id),
      friends: friends.has(id),
      onList: overlaps(theirLists.get(id), listIds(bundle.status && bundle.status.audience_lists))
    });
    out.push(viewOf(bundle.presence, bundle.status, exact, now, same, id, statusOk));
  }
  return out;
}

async function loadFresh(env, id) {
  const presence = await env.DB.prepare("SELECT " + PRESENCE_COLS + " FROM account_presence WHERE public_id = ?").bind(id).first();
  const status = await env.DB.prepare("SELECT " + STATUS_COLS + " FROM account_status WHERE public_id = ?").bind(id).first();
  return { presence: presence || null, status: status || null };
}

function classify(prev, next, prevStatus, nextStatus, now) {
  const before = effectiveState(prev || { preference: "online", activity: "hidden", last_beat: 0, last_seen: 0 }, now);
  const after = effectiveState(next, now);
  const preference = normalizePreference(prev && prev.preference) !== normalizePreference(next && (next.preference));
  const privacy = normalizePrivacy(prev && (prev.seen_privacy || prev.seenPrivacy)) !== normalizePrivacy(next && (next.seen_privacy || next.seenPrivacy))
    || listIds(prev && (prev.seen_lists != null ? prev.seen_lists : prev.seenLists)).join(",") !== listIds(next && (next.seen_lists != null ? next.seen_lists : next.seenLists)).join(",")
    || (prev && prev.reciprocal != null ? Number(prev.reciprocal) !== 0 : true) !== (next && next.reciprocal != null ? Number(next.reciprocal) !== 0 : true);
  const prevCustom = activeStatus(prevStatus, now);
  const nextCustom = activeStatus(nextStatus, now);
  const status = prevCustom.emoji !== nextCustom.emoji || prevCustom.text !== nextCustom.text || prevCustom.clearAt !== nextCustom.clearAt
    || normalizePrivacy(prevStatus && prevStatus.audience) !== normalizePrivacy(nextStatus && nextStatus.audience)
    || listIds(prevStatus && prevStatus.audience_lists).join(",") !== listIds(nextStatus && nextStatus.audience_lists).join(",");
  const state = before.state !== after.state;
  if (!preference && !privacy && !status && !state) return null;
  return { preference: preference, privacy: privacy, status: status, activity: state && !preference && !privacy && !status };
}

async function fanout(env, publicId, prev, next, prevStatus, nextStatus, now) {
  if (!env.ACCOUNT_CHANNEL) return;
  const change = classify(prev, next, prevStatus, nextStatus, now);
  if (!change) return;
  const selfView = viewOf(next, nextStatus, true, now, true, publicId);
  await publishToAccount(env, publicId, "presence", selfView, publicId);
  const watchers = (await listWatchers(env, publicId, "presence")).filter((id) => id !== publicId);
  if (!watchers.length) return;
  const followsSubject = await followersAmong(env, publicId, watchers);
  const subjectFollows = await followTargets(env, publicId, watchers);
  const marks = watchers.map(() => "?").join(",");
  const privRows = await env.DB.prepare("SELECT public_id, seen_privacy, seen_lists, reciprocal FROM account_presence WHERE public_id IN (" + marks + ")").bind(...watchers).all();
  const priv = new Map();
  rows(privRows).forEach((row) => priv.set(String(row.public_id), row));
  const subjectLists = listIds(next && (next.seen_lists || next.seenLists));
  const onSubjectLists = await membersOnLists(env, publicId, watchers);
  const watcherLists = await listsContaining(env, watchers, publicId);
  const friendRows = await friendSet(env, publicId, watchers, true);
  for (let i = 0; i < watchers.length; i++) {
    const viewerId = watchers[i];
    const viewerRow = priv.get(viewerId) || null;
    const exact = accessOf(
      viewerRow,
      next,
      followsSubject.has(viewerId),
      subjectFollows.has(viewerId),
      friendRows.has(viewerId),
      overlaps(onSubjectLists.get(viewerId), subjectLists),
      overlaps(watcherLists.get(viewerId), listIds(viewerRow && viewerRow.seen_lists)),
      false
    );
    if (!exact && change.activity) continue;
    if (!exact && !change.preference && !change.privacy && !change.status) continue;
    const statusOk = statusAllowed(nextStatus, {
      followsSubject: followsSubject.has(viewerId),
      subjectFollows: subjectFollows.has(viewerId),
      friends: friendRows.has(viewerId),
      onList: overlaps(onSubjectLists.get(viewerId), listIds(nextStatus && nextStatus.audience_lists))
    });
    const view = viewOf(next, nextStatus, exact, now, false, publicId, statusOk);
    await deliverToAccount(env, viewerId, "presence", view, publicId);
  }
}

function presenceRow(id, source, now) {
  const rawReciprocal = source && (source.reciprocal != null ? source.reciprocal : source.reciprocalFlag);
  return {
    public_id: id,
    preference: normalizePreference(source && (source.preference)),
    activity: normalizeActivity(source && (source.activity)),
    seen_privacy: normalizePrivacy(source && (source.seen_privacy || source.seenPrivacy)),
    seen_lists: listIds(source && (source.seen_lists != null ? source.seen_lists : source.seenLists)).join(","),
    last_seen: Number(source && (source.last_seen != null ? source.last_seen : source.lastSeen)) || 0,
    last_beat: Number(source && (source.last_beat != null ? source.last_beat : source.lastBeat)) || 0,
    reciprocal: rawReciprocal == null ? 1 : (Number(rawReciprocal) !== 0 ? 1 : 0),
    updated_at: now
  };
}

async function savePresence(env, row) {
  await env.DB.prepare(
    `INSERT INTO account_presence (public_id, preference, activity, seen_privacy, seen_lists, last_seen, last_beat, reciprocal, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(public_id) DO UPDATE SET
       preference = excluded.preference,
       activity = excluded.activity,
       seen_privacy = excluded.seen_privacy,
       seen_lists = excluded.seen_lists,
       last_seen = excluded.last_seen,
       last_beat = excluded.last_beat,
       reciprocal = excluded.reciprocal,
       updated_at = excluded.updated_at`
  ).bind(row.public_id, row.preference, row.activity, row.seen_privacy, row.seen_lists || "", row.last_seen, row.last_beat, row.reciprocal == null ? 1 : row.reciprocal, row.updated_at).run();
}

async function saveStatus(env, row) {
  await env.DB.prepare(
    `INSERT INTO account_status (public_id, emoji, text, clear_at, updated_at, audience, audience_lists)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(public_id) DO UPDATE SET
       emoji = excluded.emoji,
       text = excluded.text,
       clear_at = excluded.clear_at,
       updated_at = excluded.updated_at,
       audience = excluded.audience,
       audience_lists = excluded.audience_lists`
  ).bind(row.public_id, row.emoji, row.text, row.clear_at, row.updated_at, normalizePrivacy(row.audience), listIds(row.audience_lists).join(",")).run();
}

export async function handlePresence(request, env, url, deps) {
  const found = await accountOf(env, request, deps);
  if (found.error) return found.error;
  const account = found.account;
  const now = Date.now();
  if (request.method === "GET") {
    const paced = await deps.rateHit(env, "pres-read:" + account.public_id, 120, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const ids = idList(url.searchParams.get("ids"), READ_LIMIT);
    if (!ids.length) {
      const view = (await decorate(env, account.public_id, [account.public_id], now))[0];
      return privateJson(deps, view);
    }
    return privateJson(deps, { presence: await decorate(env, account.public_id, ids, now) });
  }
  if (request.method === "POST") {
    const paced = await deps.rateHit(env, "pres:" + account.public_id, 40, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    if (!known(ACTIVITIES, body.activity)) return deps.json(400, { error: "activity" });
    const fresh = await loadFresh(env, account.public_id);
    const prev = fresh.presence;
    const beat = applyBeat(prev, body.activity, now);
    const next = presenceRow(account.public_id, {
      preference: beat.preference,
      activity: beat.activity,
      seen_privacy: beat.seenPrivacy,
      seen_lists: prev && prev.seen_lists,
      last_seen: beat.lastSeen,
      last_beat: beat.lastBeat,
      reciprocal: prev && prev.reciprocal
    }, now);
    if (!shouldWriteBeat(prev, beat, now, WRITE_WINDOW_MS)) {
      const view = viewOf(prev, fresh.status, true, now, true, account.public_id);
      return deps.json(200, { ok: true, coalesced: true, state: view.state, activity: beat.activity });
    }
    const status = fresh.status;
    await savePresence(env, next);
    await dropRaw(account.public_id);
    try { await fanout(env, account.public_id, prev, next, status, status, now); }
    catch (err) { /* the row is saved; the next change pushes again */ }
    const view = viewOf(next, status, true, now, true, account.public_id);
    return deps.json(200, { ok: true, coalesced: false, state: view.state, activity: next.activity });
  }
  if (request.method === "PATCH") {
    const paced = await deps.rateHit(env, "pres-set:" + account.public_id, 30, 10 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    if (body.preference != null && !known(PREFERENCES, body.preference)) return deps.json(400, { error: "preference" });
    if (body.seenPrivacy != null && !known(PRIVACY, body.seenPrivacy)) return deps.json(400, { error: "privacy" });
    if (body.reciprocal != null && body.reciprocal !== true && body.reciprocal !== false && body.reciprocal !== 0 && body.reciprocal !== 1) {
      return deps.json(400, { error: "reciprocal" });
    }
    const current = await env.DB.prepare("SELECT " + PRESENCE_COLS + " FROM account_presence WHERE public_id = ?").bind(account.public_id).first();
    const prevStatus = await env.DB.prepare("SELECT emoji, text, clear_at, audience, audience_lists FROM account_status WHERE public_id = ?").bind(account.public_id).first();
    let seenLists = listIds(current && current.seen_lists);
    if (body.seenLists != null) {
      if (!Array.isArray(body.seenLists)) return deps.json(400, { error: "lists" });
      seenLists = await ownedListIds(env, account.public_id, body.seenLists);
    }
    const next = presenceRow(account.public_id, {
      preference: body.preference != null ? body.preference : (current && current.preference),
      activity: current && current.activity,
      seen_privacy: body.seenPrivacy != null ? body.seenPrivacy : (current && current.seen_privacy),
      seen_lists: seenLists,
      last_seen: Number(current && current.last_seen) || 0,
      last_beat: Number(current && current.last_beat) || 0,
      reciprocal: body.reciprocal != null ? body.reciprocal : (current && current.reciprocal)
    }, now);
    if (next.preference === "invisible" && current && normalizePreference(current.preference) !== "invisible") {
      /* last_seen stays where the last visible beat left it */
    }
    const keepAudience = normalizePrivacy(prevStatus && prevStatus.audience);
    const keepLists = listIds(prevStatus && prevStatus.audience_lists).join(",");
    let nextStatus = prevStatus || { emoji: "", text: "", clear_at: 0, audience: "everyone", audience_lists: "" };
    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      if (body.status == null) nextStatus = { emoji: "", text: "", clear_at: 0, audience: keepAudience, audience_lists: keepLists };
      else if (typeof body.status !== "object") return deps.json(400, { error: "status" });
      else {
        const clear = body.status.clear != null ? body.status.clear : "never";
        if (clear && !known(CLEARS, clear) && clear !== "") return deps.json(400, { error: "clear" });
        const mode = normalizeClear(clear) || "never";
        const emoji = cleanEmoji(body.status.emoji);
        // Store status emojis need to be owned; every other emoji stays free.
        if (emoji && !(await statusEmojiAllowed(env, account.public_id, emoji))) return deps.json(403, { error: "owned" });
        nextStatus = {
          emoji: emoji,
          text: cleanStatusText(body.status.text),
          clear_at: clearAtFrom(mode, now, body.status.clearAt),
          audience: keepAudience,
          audience_lists: keepLists
        };
      }
    }
    // Who sees the status can change on its own, without retyping it.
    const audienceIn = body.statusAudience != null ? body.statusAudience : (body.status && typeof body.status === "object" ? body.status.audience : null);
    const listsIn = body.statusLists != null ? body.statusLists : (body.status && typeof body.status === "object" ? body.status.lists : null);
    if (audienceIn != null && !known(PRIVACY, audienceIn)) return deps.json(400, { error: "audience" });
    if (listsIn != null && !Array.isArray(listsIn)) return deps.json(400, { error: "lists" });
    if (audienceIn != null || listsIn != null) {
      nextStatus = Object.assign({}, nextStatus, {
        audience: audienceIn != null ? normalizePrivacy(audienceIn) : normalizePrivacy(nextStatus.audience),
        audience_lists: listsIn != null ? (await ownedListIds(env, account.public_id, listsIn)).join(",") : listIds(nextStatus.audience_lists).join(",")
      });
    }
    if (Object.prototype.hasOwnProperty.call(body, "status") || audienceIn != null || listsIn != null) {
      await saveStatus(env, {
        public_id: account.public_id,
        emoji: nextStatus.emoji,
        text: nextStatus.text,
        clear_at: Number(nextStatus.clear_at) || 0,
        updated_at: now,
        audience: nextStatus.audience,
        audience_lists: nextStatus.audience_lists
      });
    }
    await savePresence(env, next);
    await dropRaw(account.public_id);
    try { await fanout(env, account.public_id, current, next, prevStatus, nextStatus, now); }
    catch (err) { /* the row is saved; the next change pushes again */ }
    return deps.json(200, Object.assign({ ok: true }, viewOf(next, nextStatus, true, now, true, account.public_id)));
  }
  return deps.json(405, { error: "method" });
}

export async function sweepExpiredStatuses(env, now) {
  const at = Number(now) || Date.now();
  let listed = null;
  try {
    listed = await env.DB.prepare("SELECT public_id, emoji, text, clear_at FROM account_status WHERE clear_at > 0 AND clear_at <= ? LIMIT 20").bind(at).all();
  } catch (err) {
    return 0;
  }
  const found = rows(listed);
  if (!found.length) return 0;
  await env.DB.prepare("UPDATE account_status SET emoji = '', text = '', clear_at = 0, updated_at = ? WHERE clear_at > 0 AND clear_at <= ?").bind(at, at).run();
  for (let i = 0; i < found.length; i++) {
    const row = found[i];
    await dropRaw(row.public_id);
    const presence = await env.DB.prepare("SELECT " + PRESENCE_COLS + " FROM account_presence WHERE public_id = ?").bind(row.public_id).first();
    const nextPresence = presence || { preference: "online", activity: "hidden", seen_privacy: "everyone", seen_lists: "", reciprocal: 1, last_seen: 0, last_beat: 0 };
    try { await fanout(env, row.public_id, nextPresence, nextPresence, row, { emoji: "", text: "", clear_at: 0 }, at); }
    catch (err) { /* the row is already cleared */ }
  }
  return found.length;
}

export async function ensurePresenceColumns(env) {
  const statements = [
    "ALTER TABLE account_presence ADD COLUMN seen_lists TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE account_presence ADD COLUMN reciprocal INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE account_status ADD COLUMN audience TEXT NOT NULL DEFAULT 'everyone'",
    "ALTER TABLE account_status ADD COLUMN audience_lists TEXT NOT NULL DEFAULT ''"
  ];
  for (let i = 0; i < statements.length; i++) {
    try { await env.DB.prepare(statements[i]).run(); }
    catch (err) { /* the column is already there */ }
  }
}

async function ownedListIds(env, ownerId, ids) {
  const clean = listIds(ids);
  if (!clean.length) return [];
  const marks = clean.map(() => "?").join(",");
  try {
    const result = await env.DB.prepare("SELECT id FROM audience_lists WHERE public_id = ? AND id IN (" + marks + ")").bind(ownerId, ...clean).all();
    const ok = new Set(rows(result).map((row) => String(row.id || "")));
    return clean.filter((id) => ok.has(id));
  } catch (err) {
    return [];
  }
}

async function blockedIds(env, userId, ids) {
  const set = new Set();
  if (!ids.length) return set;
  const marks = ids.map(() => "?").join(",");
  try {
    const result = await env.DB.prepare(
      "SELECT blocked_id AS id FROM account_blocks WHERE blocker_id = ? AND blocked_id IN (" + marks + ") UNION SELECT blocker_id AS id FROM account_blocks WHERE blocked_id = ? AND blocker_id IN (" + marks + ")"
    ).bind(userId, ...ids, userId, ...ids).all();
    rows(result).forEach((row) => set.add(String(row.id || "")));
  } catch (err) { /* a missing block table does not invent a block */ }
  return set;
}

function avatarOf(request, row) {
  const hidden = row.hide_avatar === "none" || row.hide_avatar === "default" ? row.hide_avatar : "";
  const text = String(row.avatar || "");
  let url = "";
  if (/^media\/avatars\/\d{12}\/[a-f0-9]{64}\.(webp|jpg|png)$/.test(text) && request) url = new URL("/v1/" + text, request.url).toString();
  else if (text.indexOf("data:image/") === 0) url = text;
  if (hidden) return { avatar: "", avatarFace: hidden };
  if (url) return { avatar: url, avatarFace: "photo" };
  return { avatar: "", avatarFace: row.avatar_empty === "none" ? "none" : "default" };
}

function presenceRank(state) {
  if (state === "online") return 0;
  if (state === "idle") return 1;
  if (state === "dnd") return 2;
  return 3;
}

export async function handleFriendPresence(request, env, deps) {
  const found = await accountOf(env, request, deps);
  if (found.error) return found.error;
  const account = found.account;
  const paced = await deps.rateHit(env, "pres-fr:" + account.public_id, 60, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  let listed = null;
  try {
    listed = await env.DB.prepare(
      "SELECT a.public_id, a.handle, a.display_name, a.avatar, a.hide_avatar, a.avatar_empty, a.profile_less FROM account_friends f JOIN accounts a ON a.public_id = f.friend_id WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT 80"
    ).bind(account.public_id).all();
  } catch (err) {
    return privateJson(deps, { friends: [] });
  }
  const listedPeople = rows(listed).filter((row) => row.profile_less !== 1 && isAccountId(row.public_id));
  const off = await friendsOffAmong(env, [account.public_id].concat(listedPeople.map((row) => row.public_id)));
  if (off.has(String(account.public_id))) return privateJson(deps, { friends: [], friendsOff: true });
  const people = listedPeople.filter((row) => !off.has(String(row.public_id)));
  const blocked = await blockedIds(env, account.public_id, people.map((row) => row.public_id));
  const visible = people.filter((row) => !blocked.has(row.public_id));
  const now = Date.now();
  const views = await decorate(env, account.public_id, visible.map((row) => row.public_id), now);
  const byId = new Map();
  views.forEach((view) => byId.set(view.id, view));
  const games = await playingNow(env, visible.map((row) => row.public_id), account.public_id);
  const rooms = games.rooms || new Map();
  const friends = visible.map((row) => {
    const view = byId.get(row.public_id) || { state: "offline", exact: false, lastSeen: 0, emoji: "", text: "" };
    const photo = avatarOf(request, row);
    return {
      publicId: row.public_id,
      handle: row.handle || "",
      name: row.display_name || row.handle || "",
      avatar: photo.avatar,
      avatarFace: photo.avatarFace,
      state: view.state || "offline",
      exact: !!view.exact,
      lastSeen: Number(view.lastSeen) || 0,
      emoji: view.emoji || "",
      text: view.text || "",
      // Only for friends whose presence you can already see.
      playing: view.state && view.state !== "offline" ? games.get(String(row.public_id)) || "" : "",
      // A room they picked themselves, when their games privacy lets you see it.
      room: view.state && view.state !== "offline" && rooms.get(String(row.public_id)) ? rooms.get(String(row.public_id)).room : ""
    };
  });
  friends.sort((a, b) => {
    const diff = presenceRank(a.state) - presenceRank(b.state);
    if (diff) return diff;
    return String(a.name).localeCompare(String(b.name));
  });
  return privateJson(deps, { friends: friends });
}
