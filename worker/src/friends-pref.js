/* Friends master switch, one row per account (account_friend_prefs).

   Off: nobody can send this account a friend request, its pending requests
   are paused (kept, not deleted), its friendships are kept but hidden from
   every list, count and presence read, and it is left out of other people's
   friends lists. Turning it back on restores all of it. The person may also
   choose to decline every pending request or remove every friendship.

   On, three optional choices: who can send requests (everyone, friends of
   friends, nobody), who sees the friends list (everyone, friends, only me),
   and whether friends see their online status.

   The "friends_off" feature switch turns enforcement off for everyone (every
   account then reads as on with default choices). */
import { readFlags } from "./feature-flags.js";

export const WHO_CAN_REQUEST = ["everyone", "fof", "nobody"];
export const LIST_AUDIENCE = ["everyone", "friends", "me"];

export const FRIEND_PREFS_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS account_friend_prefs (public_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, who_can_request TEXT NOT NULL DEFAULT 'everyone', list_audience TEXT NOT NULL DEFAULT 'everyone', share_online INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0)"
];

let schema = null;
export function ensureFriendPrefs(env) {
  if (!schema) {
    schema = env.DB.batch(FRIEND_PREFS_SCHEMA.map((sql) => env.DB.prepare(sql)))
      .catch((err) => { schema = null; throw err; });
  }
  return schema;
}

export function defaultPrefs() {
  return { enabled: true, whoCanRequest: "everyone", listAudience: "everyone", shareOnline: true };
}

function fromRow(row) {
  const out = defaultPrefs();
  if (!row) return out;
  out.enabled = Number(row.enabled) !== 0;
  if (WHO_CAN_REQUEST.includes(row.who_can_request)) out.whoCanRequest = row.who_can_request;
  if (LIST_AUDIENCE.includes(row.list_audience)) out.listAudience = row.list_audience;
  out.shareOnline = Number(row.share_online) !== 0;
  return out;
}

async function switchOn(env) {
  try {
    const off = await readFlags(env);
    return !off.friends_off;
  } catch (err) {
    return true;
  }
}

export async function friendPrefs(env, publicId) {
  if (!publicId || !(await switchOn(env))) return defaultPrefs();
  try {
    await ensureFriendPrefs(env);
    const row = await env.DB.prepare("SELECT enabled, who_can_request, list_audience, share_online FROM account_friend_prefs WHERE public_id = ?").bind(publicId).first();
    return fromRow(row);
  } catch (err) {
    return defaultPrefs();
  }
}

/* Ids among `ids` that have Friends off (or, with `noOnline`, that also hide
   their online status from friends). */
export async function friendsOffAmong(env, ids, noOnline) {
  const set = new Set();
  const list = (ids || []).map(String).filter(Boolean);
  if (!list.length || !(await switchOn(env))) return set;
  try {
    await ensureFriendPrefs(env);
    for (let i = 0; i < list.length; i += 80) {
      const part = list.slice(i, i + 80);
      const marks = part.map(() => "?").join(",");
      const where = noOnline ? "(enabled = 0 OR share_online = 0)" : "enabled = 0";
      const got = await env.DB.prepare("SELECT public_id FROM account_friend_prefs WHERE " + where + " AND public_id IN (" + marks + ")").bind(...part).all();
      ((got && got.results) || []).forEach((row) => set.add(String(row.public_id)));
    }
  } catch (err) { /* no table yet: everyone is on */ }
  return set;
}

/* A friendship only counts while both people have Friends on. Hidden
   friendships stay stored, so turning Friends back on restores them, but
   every audience, birthday, game and suggestion check reads them as absent. */
export async function friendshipLive(env, a, b) {
  if (!a || !b) return false;
  return (await friendsOffAmong(env, [a, b])).size === 0;
}

/* `ids` minus anyone whose friendship with `ownerId` is hidden. Empty when
   the owner of the list has Friends off. */
export async function liveFriendIds(env, ownerId, ids) {
  const list = (ids || []).map(String).filter(Boolean);
  if (!list.length) return [];
  const off = await friendsOffAmong(env, [String(ownerId)].concat(list));
  if (off.has(String(ownerId))) return [];
  return list.filter((id) => !off.has(id));
}

/* The site owner (accounts.owner = 1) keeps reading through hidden
   friendships, the same bypass the owner tools use. */
export async function siteOwnerId(env, publicId) {
  if (!publicId) return false;
  try {
    const row = await env.DB.prepare("SELECT owner FROM accounts WHERE public_id = ?").bind(publicId).first();
    return !!(row && Number(row.owner) === 1);
  } catch (err) { return false; }
}

/* SQL piece that keeps only friends whose Friends switch is on. `col` is the
   column holding the friend's id. Safe before the table exists only after
   ensureFriendPrefs ran, so callers await it first. */
export function friendOnSql(col) {
  return " AND NOT EXISTS (SELECT 1 FROM account_friend_prefs fp WHERE fp.public_id = " + col + " AND fp.enabled = 0)";
}

export async function friendFilterReady(env) {
  if (!(await switchOn(env))) return false;
  try { await ensureFriendPrefs(env); return true; } catch (err) { return false; }
}

async function counts(env, id) {
  const one = async (sql) => {
    try { const row = await env.DB.prepare(sql).bind(id).first(); return (row && Number(row.n)) || 0; } catch (err) { return 0; }
  };
  return {
    incoming: await one("SELECT COUNT(*) AS n FROM account_friend_requests WHERE receiver_id = ?"),
    outgoing: await one("SELECT COUNT(*) AS n FROM account_friend_requests WHERE sender_id = ?"),
    friends: await one("SELECT COUNT(*) AS n FROM account_friends WHERE user_id = ?")
  };
}

/* GET/PUT /v1/friends/settings for the signed-in account. */
export async function handleFriendPrefs(request, env, deps) {
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  const id = viewer.public_id;
  if (request.method === "GET") {
    const prefs = await friendPrefs(env, id);
    return deps.json(200, Object.assign({ v: 1 }, prefs, { held: await counts(env, id) }), { "cache-control": "private, no-store" });
  }
  if (request.method !== "PUT" && request.method !== "POST") return deps.json(405, { error: "method" });
  const paced = await deps.rateHit(env, "fpref:" + id, 30, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const body = await deps.readJson(request, 1024);
  if (!body || body.error) return deps.json(400, { error: "bad_json" });
  const next = await friendPrefs(env, id);
  const wasOn = next.enabled;
  if (typeof body.enabled === "boolean") next.enabled = body.enabled;
  if (body.whoCanRequest != null) {
    if (!WHO_CAN_REQUEST.includes(body.whoCanRequest)) return deps.json(400, { error: "bad_who" });
    next.whoCanRequest = body.whoCanRequest;
  }
  if (body.listAudience != null) {
    if (!LIST_AUDIENCE.includes(body.listAudience)) return deps.json(400, { error: "bad_list" });
    next.listAudience = body.listAudience;
  }
  if (typeof body.shareOnline === "boolean") next.shareOnline = body.shareOnline;
  await ensureFriendPrefs(env);
  await env.DB.prepare(
    "INSERT INTO account_friend_prefs (public_id, enabled, who_can_request, list_audience, share_online, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(public_id) DO UPDATE SET enabled = excluded.enabled, who_can_request = excluded.who_can_request, list_audience = excluded.list_audience, share_online = excluded.share_online, updated_at = excluded.updated_at"
  ).bind(id, next.enabled ? 1 : 0, next.whoCanRequest, next.listAudience, next.shareOnline ? 1 : 0, Date.now()).run();
  // Other people's cached People you may know can still list this account;
  // the cache is only a speed-up, so drop it everywhere on a switch flip.
  if (wasOn !== next.enabled) {
    try { await env.DB.prepare("DELETE FROM suggest_cache").run(); } catch (err) { /* cache only */ }
  }
  const touched = new Set();
  if (body.declineAll === true) {
    const reqs = await env.DB.prepare("SELECT sender_id AS a, receiver_id AS b FROM account_friend_requests WHERE receiver_id = ? OR sender_id = ? LIMIT 500").bind(id, id).all();
    ((reqs && reqs.results) || []).forEach((r) => touched.add(String(r.a === id ? r.b : r.a)));
    await env.DB.prepare("DELETE FROM account_friend_requests WHERE receiver_id = ? OR sender_id = ?").bind(id, id).run();
  }
  // Removing every friendship is destructive, so it needs an explicit word.
  if (body.removeAll === true) {
    if (body.confirm !== "remove") return deps.json(400, { error: "confirm" });
    const rows = await env.DB.prepare("SELECT friend_id FROM account_friends WHERE user_id = ? LIMIT 1000").bind(id).all();
    ((rows && rows.results) || []).forEach((r) => touched.add(String(r.friend_id)));
    await env.DB.prepare("DELETE FROM account_friends WHERE user_id = ? OR friend_id = ?").bind(id, id).run();
  }
  if (deps.signal) {
    try { await deps.signal(env, [id].concat(Array.from(touched).slice(0, 200))); } catch (err) { /* saved */ }
  }
  return deps.json(200, Object.assign({ ok: true, v: 1 }, next, { held: await counts(env, id) }));
}
