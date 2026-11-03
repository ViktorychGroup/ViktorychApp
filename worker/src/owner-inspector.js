/* Owner account inspector ("Cuentas").
   Only the owner (accounts.owner = 1, checked here on the server) can read
   these routes; everyone else signed in gets 403, anonymous callers 401.
   The owner sees every internal account the way moderation needs it: all
   usernames including hidden ones and their audience, counts, sign-in method
   TYPES, linked service status, reports, sessions count and storage.

   Never returned: passwords, number hashes, salts, session or device tokens,
   passkey keys, recovery codes, 2FA secrets, message bodies, and the private
   nicknames other people gave this account.

   Each time the owner opens one account's details a row is written to
   owner_access_log (migration 0115) so the access itself is auditable.

   GET /v1/owner/inspector/accounts?q=&sort=&filter=&offset=
   GET /v1/owner/inspector/accounts/:id     (writes an audit row)
   GET /v1/owner/inspector/audit            (latest audit rows) */

import { loadNames } from "./usernames.js";
import { loadDisplayNames } from "./display-names.js";
import { logOwnerView, ownerViewExtras, scrubSecrets } from "./owner-view.js";

export const INSPECTOR_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS owner_access_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, owner_id TEXT NOT NULL, target_id TEXT NOT NULL, action TEXT NOT NULL DEFAULT 'view')",
  "CREATE INDEX IF NOT EXISTS owner_access_log_at ON owner_access_log (at)",
  "CREATE INDEX IF NOT EXISTS owner_access_log_target ON owner_access_log (target_id, at)"
];

const PAGE = 50;
const ONLINE_MS = 5 * 60 * 1000;
const SORTS = ["created", "active", "handle", "followers", "posts", "reports"];
const FILTERS = ["all", "online", "extra_names", "hidden_names", "protected", "reported", "temporary", "owner", "friends_off", "locked_follows", "extra_display"];
const NO_STORE = { "cache-control": "private, no-store" };

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(INSPECTOR_SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

/* Which optional tables exist on this database (features create theirs on demand). */
async function tableSet(env) {
  const out = new Set();
  try {
    const res = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    ((res && res.results) || []).forEach((row) => out.add(String(row.name)));
  } catch (err) { /* empty set: only core columns */ }
  return out;
}

async function first(env, sql, binds) {
  try { return await env.DB.prepare(sql).bind(...(binds || [])).first(); }
  catch (err) { return null; }
}
async function all(env, sql, binds) {
  try { const res = await env.DB.prepare(sql).bind(...(binds || [])).all(); return (res && res.results) || []; }
  catch (err) { return []; }
}
async function count(env, tables, table, sql, binds) {
  if (table && !tables.has(table)) return null;
  const row = await first(env, sql, binds);
  return row ? Number(row.n) || 0 : 0;
}

/* Audience in plain words for one username. */
export function audienceSummary(aud) {
  const a = aud && aud.include ? aud : { include: {}, exclude: {} };
  const inc = a.include || {};
  const exc = a.exclude || {};
  let level = "only_me";
  if (inc.public) level = "public";
  else if (inc.followers) level = "followers";
  else if (inc.friends) level = "friends";
  else if ((inc.lists || []).length || (inc.people || []).length) level = "custom";
  return {
    level,
    hidden: level !== "public",
    lists: (inc.lists || []).length,
    people: (inc.people || []).length,
    excludes: (exc.followers ? 1 : 0) + (exc.friends ? 1 : 0) + (exc.lists || []).length + (exc.people || []).length
  };
}

function listSql(tables, q, sort, filter) {
  const cols = ["a.public_id", "a.handle", "a.display_name", "a.avatar", "a.owner", "a.created_at", "COALESCE(a.protected_account, 0) AS protected_account"];
  const has = (t) => tables.has(t);
  cols.push(has("account_handles") ? "(SELECT COUNT(*) FROM account_handles h WHERE h.public_id = a.public_id) AS extra_names" : "0 AS extra_names");
  cols.push(has("account_handles") ? "(SELECT COUNT(*) FROM account_handles h WHERE h.public_id = a.public_id AND h.audience NOT LIKE '%\"public\":true%') AS hidden_names" : "0 AS hidden_names");
  cols.push(has("account_follows") ? "(SELECT COUNT(*) FROM account_follows f WHERE f.target_id = 'app:' || a.public_id) AS followers" : "0 AS followers");
  cols.push(has("public_posts") ? "(SELECT COUNT(*) FROM public_posts p WHERE p.author_id = a.public_id) AS posts" : "0 AS posts");
  cols.push(has("post_reports") && has("public_posts") ? "(SELECT COUNT(*) FROM post_reports r JOIN public_posts p ON p.id = r.post_id WHERE p.author_id = a.public_id) AS reports" : "0 AS reports");
  const actParts = ["0"];
  if (has("account_presence")) actParts.push("COALESCE((SELECT MAX(last_beat, last_seen) FROM account_presence pr WHERE pr.public_id = a.public_id), 0)");
  if (has("session_devices")) actParts.push("COALESCE((SELECT MAX(last_seen) FROM session_devices d WHERE d.public_id = a.public_id), 0)");
  cols.push((actParts.length > 1 ? "MAX(" + actParts.join(", ") + ")" : "0") + " AS seen_at");
  if (has("sessions")) actParts.push("COALESCE((SELECT MAX(created_at) FROM sessions s WHERE s.public_id = a.public_id), 0)");
  cols.push((actParts.length > 1 ? "MAX(" + actParts.join(", ") + ")" : "0") + " AS active_at");
  cols.push(has("account_friend_prefs") ? "COALESCE((SELECT enabled FROM account_friend_prefs fp WHERE fp.public_id = a.public_id), 1) AS friends_on" : "1 AS friends_on");
  cols.push(has("locked_follows") ? "(SELECT COUNT(*) FROM locked_follows lf WHERE lf.owner_id = a.public_id) AS locked_follows" : "0 AS locked_follows");
  cols.push(has("display_names") ? "(SELECT COUNT(*) FROM display_names dn WHERE dn.public_id = a.public_id) AS extra_display" : "0 AS extra_display");
  cols.push(has("account_temp") ? "(SELECT expires_at FROM account_temp t WHERE t.public_id = a.public_id) AS temp_until" : "NULL AS temp_until");
  const where = [];
  const binds = [];
  if (q) {
    const like = "%" + q.toLowerCase().replace(/[%_\\]/g, (m) => "\\" + m) + "%";
    const parts = ["LOWER(a.handle) LIKE ? ESCAPE '\\'", "LOWER(a.display_name) LIKE ? ESCAPE '\\'", "a.public_id LIKE ? ESCAPE '\\'"];
    binds.push(like, like, like);
    if (has("account_handles")) { parts.push("EXISTS (SELECT 1 FROM account_handles h WHERE h.public_id = a.public_id AND LOWER(h.handle) LIKE ? ESCAPE '\\')"); binds.push(like); }
    if (has("display_names")) { parts.push("EXISTS (SELECT 1 FROM display_names dn WHERE dn.public_id = a.public_id AND LOWER(dn.name) LIKE ? ESCAPE '\\')"); binds.push(like); }
    where.push("(" + parts.join(" OR ") + ")");
  }
  const inner = "SELECT " + cols.join(", ") + " FROM accounts a" + (where.length ? " WHERE " + where.join(" AND ") : "");
  const outerWhere = [];
  if (filter === "online") outerWhere.push("seen_at > " + Number(Date.now() - ONLINE_MS));
  if (filter === "extra_names") outerWhere.push("extra_names > 0");
  if (filter === "hidden_names") outerWhere.push("hidden_names > 0");
  if (filter === "protected") outerWhere.push("protected_account = 1");
  if (filter === "reported") outerWhere.push("reports > 0");
  if (filter === "temporary") outerWhere.push("temp_until IS NOT NULL");
  if (filter === "owner") outerWhere.push("owner = 1");
  if (filter === "friends_off") outerWhere.push("friends_on = 0");
  if (filter === "locked_follows") outerWhere.push("locked_follows > 0");
  if (filter === "extra_display") outerWhere.push("extra_display > 0");
  const order = {
    created: "created_at DESC",
    active: "active_at DESC",
    handle: "LOWER(handle) ASC",
    followers: "followers DESC, created_at DESC",
    posts: "posts DESC, created_at DESC",
    reports: "reports DESC, created_at DESC"
  }[sort] || "created_at DESC";
  return { sql: "SELECT * FROM (" + inner + ")" + (outerWhere.length ? " WHERE " + outerWhere.join(" AND ") : "") + " ORDER BY " + order, binds };
}

function rowOut(row, now) {
  const active = Number(row.active_at) || 0;
  return {
    id: String(row.public_id),
    handle: row.handle,
    name: row.display_name,
    avatar: row.avatar || "",
    owner: Number(row.owner) === 1,
    createdAt: Number(row.created_at) || 0,
    activeAt: active,
    online: (Number(row.seen_at) || 0) > now - ONLINE_MS,
    protected: Number(row.protected_account) === 1,
    extraNames: Number(row.extra_names) || 0,
    hiddenNames: Number(row.hidden_names) || 0,
    friendsOff: Number(row.friends_on) === 0,
    lockedFollows: Number(row.locked_follows) || 0,
    extraDisplayNames: Number(row.extra_display) || 0,
    followers: Number(row.followers) || 0,
    posts: Number(row.posts) || 0,
    reports: Number(row.reports) || 0,
    temporary: row.temp_until != null,
    tempUntil: row.temp_until != null ? Number(row.temp_until) || 0 : 0
  };
}

async function listAccounts(env, url) {
  const tables = await tableSet(env);
  const q = String(url.searchParams.get("q") || "").trim().replace(/^@/, "").slice(0, 80);
  const sort = SORTS.indexOf(url.searchParams.get("sort")) >= 0 ? url.searchParams.get("sort") : "created";
  const filter = FILTERS.indexOf(url.searchParams.get("filter")) >= 0 ? url.searchParams.get("filter") : "all";
  const offset = Math.max(0, Math.min(100000, parseInt(url.searchParams.get("offset") || "0", 10) || 0));
  const built = listSql(tables, q, sort, filter);
  const now = Date.now();
  const rows = await all(env, built.sql + " LIMIT ? OFFSET ?", built.binds.concat([PAGE + 1, offset]));
  const total = await first(env, "SELECT COUNT(*) AS n FROM accounts", []);
  const online = tables.has("account_presence") ? await first(env, "SELECT COUNT(*) AS n FROM account_presence WHERE MAX(last_beat, last_seen) > ?", [now - ONLINE_MS]) : null;
  return {
    accounts: rows.slice(0, PAGE).map((row) => rowOut(row, now)),
    more: rows.length > PAGE,
    offset,
    sort,
    filter,
    totals: { accounts: total ? Number(total.n) || 0 : 0, online: online ? Number(online.n) || 0 : 0 }
  };
}

function safeSettings(payload) {
  const p = payload && typeof payload === "object" ? payload : null;
  if (!p) return null;
  const len = (v) => (Array.isArray(v) ? v.length : v && typeof v === "object" ? Object.keys(v).length : 0);
  const pick = (v) => (typeof v === "string" || typeof v === "boolean" || typeof v === "number" ? v : null);
  return {
    language: ["en", "es", "ru", "hi"].indexOf(p.lang) >= 0 ? p.lang : "",
    appearance: pick(p.appearance),
    autoplay: pick(p.autoplay),
    notifications: p.notify === true,
    networkMode: pick(p.networkMode),
    zeroTrace: p.privacyZeroTrace === true,
    haptics: p.haptics !== false,
    follows: len(p.follows),
    lists: len(p.lists),
    groups: len(p.groups),
    feedTabs: len(p.feedTabs),
    mutedWords: len(p.mutedWords),
    mutedAccounts: len(p.mutedAccounts),
    blocks: len(p.blocks),
    bookmarks: len(p.bookmarks) + len(p.savedPosts),
    setupDone: !!(len(p.follows) || p.appearance || p.setupDone === true)
  };
}

async function accountDetail(env, id, deps) {
  const tables = await tableSet(env);
  const has = (t) => tables.has(t);
  const now = Date.now();
  const acct = await first(env, "SELECT public_id, handle, display_name, avatar, banner, bio, location, website, owner, created_at, COALESCE(protected_account, 0) AS protected_account, COALESCE(private_follows, 0) AS private_follows, COALESCE(profile_less, 0) AS profile_less, hide_avatar FROM accounts WHERE public_id = ?", [id]);
  if (!acct) return null;

  // Usernames: every one, with its audience, ignoring privacy (owner view).
  let names = [];
  try {
    const set = await loadNames(env, id);
    names = ((set && set.names) || []).map((n) => ({ handle: n.handle, primary: !!n.primary, audience: audienceSummary(n.audience) }));
  } catch (err) {
    names = [{ handle: acct.handle, primary: true, audience: audienceSummary({ include: { public: true } }) }];
  }

  // Display names: every one, with its audience, ignoring privacy (owner view).
  let displayNames = [];
  try {
    const dset = await loadDisplayNames(env, id);
    displayNames = ((dset && dset.names) || []).map((n) => ({ name: String(n.name || ""), primary: !!n.primary, audience: audienceSummary(n.audience) }));
  } catch (err) {
    displayNames = [];
  }
  if (!displayNames.length) displayNames = [{ name: String(acct.display_name || ""), primary: true, audience: audienceSummary({ include: { public: true } }) }];

  const presence = has("account_presence") ? await first(env, "SELECT preference, activity, seen_privacy, last_seen, last_beat FROM account_presence WHERE public_id = ?", [id]) : null;
  const devices = has("session_devices") ? await all(env, "SELECT type, created_at, last_seen FROM session_devices WHERE public_id = ? ORDER BY last_seen DESC LIMIT 20", [id]) : [];
  const sessions = await count(env, tables, "sessions", "SELECT COUNT(*) AS n FROM sessions WHERE public_id = ? AND expires_at > ?", [id, now]);
  const lastSession = has("sessions") ? await first(env, "SELECT MAX(created_at) AS at FROM sessions WHERE public_id = ?", [id]) : null;
  const seenAt = Math.max(
    presence ? Math.max(Number(presence.last_beat) || 0, Number(presence.last_seen) || 0) : 0,
    devices.reduce((m, d) => Math.max(m, Number(d.last_seen) || 0), 0)
  );
  const lastActive = Math.max(seenAt, lastSession ? Number(lastSession.at) || 0 : 0);

  const passkeys = await count(env, tables, "webauthn_credentials", "SELECT COUNT(*) AS n FROM webauthn_credentials WHERE public_id = ?", [id]);
  const recovery = await count(env, tables, "recovery_codes", "SELECT COUNT(*) AS n FROM recovery_codes WHERE public_id = ? AND used_at = 0", [id]);
  const signIn = ["account_number"];
  if (passkeys) signIn.push("passkey");
  if (recovery) signIn.push("recovery_codes");
  if (has("tv_pairs") && await count(env, tables, "tv_pairs", "SELECT COUNT(*) AS n FROM tv_pairs WHERE public_id = ?", [id])) signIn.push("tv_code");

  const identities = has("account_identities") ? await all(env, "SELECT platform, verified FROM account_identities WHERE public_id = ?", [id]) : [];
  const linked = {};
  identities.forEach((row) => {
    const key = String(row.platform || "other").toLowerCase().slice(0, 30);
    linked[key] = linked[key] === "verified" || Number(row.verified) === 1 ? "verified" : "linked";
  });
  const games = has("game_stats") ? await all(env, "SELECT game_id, total_ms, beat_at FROM game_stats WHERE public_id = ?", [id]) : [];
  games.forEach((g) => { const key = String(g.game_id || "").toLowerCase().slice(0, 30); if (key && !linked[key]) linked[key] = "played"; });
  if (has("discord_alert_prefs") && await count(env, tables, "discord_alert_prefs", "SELECT COUNT(*) AS n FROM discord_alert_prefs WHERE public_id = ?", [id])) linked.discord = linked.discord || "alerts";
  if (has("account_federation")) {
    const fed = await first(env, "SELECT enabled_ap, enabled_nostr FROM account_federation WHERE public_id = ?", [id]);
    if (fed && Number(fed.enabled_ap) === 1) linked.activitypub = "on";
    if (fed && Number(fed.enabled_nostr) === 1) linked.nostr = "on";
  }
  const push = await count(env, tables, "push_subscriptions", "SELECT COUNT(*) AS n FROM push_subscriptions WHERE public_id = ?", [id]);
  if (push) linked.push = "on";

  const counts = {
    followers: await count(env, tables, "account_follows", "SELECT COUNT(*) AS n FROM account_follows WHERE target_id = ?", ["app:" + id]),
    following: await count(env, tables, "account_follows", "SELECT COUNT(*) AS n FROM account_follows WHERE follower_id = ?", [id]),
    friends: await count(env, tables, "account_friends", "SELECT COUNT(*) AS n FROM account_friends WHERE user_id = ?", [id]),
    lockedFollowing: await count(env, tables, "locked_follows", "SELECT COUNT(*) AS n FROM locked_follows WHERE owner_id = ?", [id]),
    posts: await count(env, tables, "public_posts", "SELECT COUNT(*) AS n FROM public_posts WHERE author_id = ? AND parent_id = ''", [id]),
    replies: await count(env, tables, "public_posts", "SELECT COUNT(*) AS n FROM public_posts WHERE author_id = ? AND parent_id <> ''", [id]),
    hiddenPosts: await count(env, tables, "public_posts", "SELECT COUNT(*) AS n FROM public_posts WHERE author_id = ? AND hidden = 1", [id]),
    communityPosts: await count(env, tables, "community_posts", "SELECT COUNT(*) AS n FROM community_posts WHERE author_id = ? AND deleted_at = 0", [id]),
    reposts: await count(env, tables, "account_reposts", "SELECT COUNT(*) AS n FROM account_reposts WHERE public_id = ?", [id]),
    messagesSent: await count(env, tables, "account_messages", "SELECT COUNT(*) AS n FROM account_messages WHERE sender_id = ? AND deleted_at = 0", [id]),
    audienceLists: await count(env, tables, "audience_lists", "SELECT COUNT(*) AS n FROM audience_lists WHERE public_id = ?", [id])
  };

  // People: full lists straight from the tables, so audience rules, per-friendship
  // privacy, locked follows and Friends off never hide anything here (owner view).
  const PEOPLE_MAX = 500;
  const person = (r, extra) => Object.assign({ id: String(r.pid || ""), handle: r.handle || "", name: r.display_name || "", at: Number(r.at) || 0 }, extra || {});
  const friends = has("account_friends")
    ? (await all(env, "SELECT f.friend_id AS pid, a.handle, a.display_name, f.created_at AS at FROM account_friends f LEFT JOIN accounts a ON a.public_id = f.friend_id WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT " + PEOPLE_MAX, [id])).map((r) => person(r))
    : [];
  // Per-friendship privacy (friendship_privacy, #491): the owner still sees each
  // such friendship, marked with the rule the person set.
  if (has("friendship_privacy") && friends.length) {
    const rules = new Map((await all(env, "SELECT friend_id, mode FROM friendship_privacy WHERE public_id = ? AND mode <> 'inherit'", [id])).map((r) => [String(r.friend_id), String(r.mode || "")]));
    for (const f of friends) if (rules.has(f.id)) f.privacy = rules.get(f.id);
  }
  const followers = has("account_follows")
    ? (await all(env, "SELECT f.follower_id AS pid, a.handle, a.display_name, f.created_at AS at FROM account_follows f LEFT JOIN accounts a ON a.public_id = f.follower_id WHERE f.target_id = ? ORDER BY f.created_at DESC LIMIT " + PEOPLE_MAX, ["app:" + id])).map((r) => person(r))
    : [];
  const following = has("account_follows")
    ? (await all(env, "SELECT f.target_id AS target, a.public_id AS pid, a.handle, a.display_name, f.created_at AS at FROM account_follows f LEFT JOIN accounts a ON ('app:' || a.public_id) = f.target_id WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT " + PEOPLE_MAX, [id]))
        .map((r) => person(r, { target: String(r.target || ""), app: String(r.target || "").indexOf("app:") === 0 }))
    : [];
  const locked = has("locked_follows")
    ? (await all(env, "SELECT l.target_id AS target, a.public_id AS pid, a.handle, a.display_name, l.created_at AS at FROM locked_follows l LEFT JOIN accounts a ON ('app:' || a.public_id) = l.target_id OR a.public_id = l.target_id WHERE l.owner_id = ? ORDER BY l.created_at DESC LIMIT " + PEOPLE_MAX, [id]))
        .map((r) => person(r, { target: String(r.target || ""), locked: true }))
    : [];
  // Locked follows stay in account_follows; mark them so the owner sees which.
  if (locked.length) { const lk = new Set(locked.map((l) => l.target)); for (const f of following) if (lk.has(f.target)) f.locked = true; }
  const lockPrefs = has("locked_follow_prefs") ? await first(env, "SELECT CASE WHEN code_hash <> '' THEN 1 ELSE 0 END AS has_lock, hide_entry, relock_secs FROM locked_follow_prefs WHERE public_id = ?", [id]) : null;
  const friendPrefs = has("account_friend_prefs") ? await first(env, "SELECT enabled, who_can_request, list_audience, share_online FROM account_friend_prefs WHERE public_id = ?", [id]) : null;
  const people = {
    friends,
    followers,
    following,
    lockedFollowing: locked,
    requestsIn: await count(env, tables, "account_friend_requests", "SELECT COUNT(*) AS n FROM account_friend_requests WHERE receiver_id = ?", [id]),
    requestsOut: await count(env, tables, "account_friend_requests", "SELECT COUNT(*) AS n FROM account_friend_requests WHERE sender_id = ?", [id]),
    friendsSetting: {
      on: !friendPrefs || Number(friendPrefs.enabled) !== 0,
      whoCanRequest: friendPrefs ? String(friendPrefs.who_can_request || "everyone") : "everyone",
      listAudience: friendPrefs ? String(friendPrefs.list_audience || "everyone") : "everyone",
      shareOnline: !friendPrefs || Number(friendPrefs.share_online) !== 0
    },
    lockedFollows: { count: await count(env, tables, "locked_follows", "SELECT COUNT(*) AS n FROM locked_follows WHERE owner_id = ?", [id]), lockSet: !!(lockPrefs && Number(lockPrefs.has_lock) === 1), hideEntry: !!(lockPrefs && Number(lockPrefs.hide_entry) === 1) },
    max: PEOPLE_MAX
  };

  const communities = has("community_members") ? (await all(env, "SELECT community_id, created_at FROM community_members WHERE public_id = ? ORDER BY created_at DESC LIMIT 100", [id])).map((r) => ({ id: String(r.community_id), joinedAt: Number(r.created_at) || 0 })) : [];

  const requests = has("feed_request_voters") && has("feed_requests")
    ? (await all(env, "SELECT r.kind, r.platform, r.name, r.input, v.state, v.created_at FROM feed_request_voters v JOIN feed_requests r ON r.id = v.request_id WHERE v.public_id = ? ORDER BY v.created_at DESC LIMIT 50", [id]))
        .map((r) => ({ kind: r.kind, platform: r.platform, name: r.name || r.input, state: r.state, at: Number(r.created_at) || 0 }))
    : [];

  const reportRows = has("post_reports") && has("public_posts")
    ? await all(env, "SELECT r.status, COUNT(*) AS n FROM post_reports r JOIN public_posts p ON p.id = r.post_id WHERE p.author_id = ? GROUP BY r.status", [id])
    : [];
  const reports = { total: 0, byStatus: {} };
  reportRows.forEach((r) => { reports.byStatus[String(r.status)] = Number(r.n) || 0; reports.total += Number(r.n) || 0; });
  const reportsFiled = await count(env, tables, "post_reports", "SELECT COUNT(*) AS n FROM post_reports WHERE reporter_id = ?", [id]);

  const temp = has("account_temp") ? await first(env, "SELECT expires_at FROM account_temp WHERE public_id = ?", [id]) : null;
  const cn = has("cn_contributors") ? await first(env, "SELECT banned FROM cn_contributors WHERE public_id = ?", [id]) : null;
  const moderation = {
    blockedBy: await count(env, tables, "account_blocks", "SELECT COUNT(*) AS n FROM account_blocks WHERE blocked_id = ?", [id]),
    blocking: await count(env, tables, "account_blocks", "SELECT COUNT(*) AS n FROM account_blocks WHERE blocker_id = ?", [id]),
    mutedBy: await count(env, tables, "account_mutes", "SELECT COUNT(*) AS n FROM account_mutes WHERE muted_id = ?", [id]),
    serverBans: await count(env, tables, "srv_bans", "SELECT COUNT(*) AS n FROM srv_bans WHERE account_id = ?", [id]),
    notesBanned: !!(cn && Number(cn.banned) === 1),
    temporary: !!temp,
    tempUntil: temp ? Number(temp.expires_at) || 0 : 0
  };

  let mediaBytes = 0;
  if (has("public_post_media") && has("public_posts")) {
    const row = await first(env, "SELECT COALESCE(SUM(m.size), 0) AS n FROM public_post_media m JOIN public_posts p ON p.id = m.post_id WHERE p.author_id = ?", [id]);
    mediaBytes = row ? Number(row.n) || 0 : 0;
  }
  let driveBytes = 0;
  if (has("drive_items") && has("drive_chunks")) {
    const row = await first(env, "SELECT COALESCE(SUM(c.size), 0) AS n FROM drive_chunks c JOIN drive_items i ON i.id = c.item_id WHERE i.public_id = ?", [id]);
    driveBytes = row ? Number(row.n) || 0 : 0;
  }
  const syncRow = has("sync_state") ? await first(env, "SELECT payload, updated_at FROM sync_state WHERE public_id = ?", [id]) : null;
  let settings = null;
  if (syncRow) {
    let payload = null;
    try { payload = JSON.parse(syncRow.payload); } catch (err) { payload = null; }
    try { if (deps && deps.openPayload) payload = await deps.openPayload(env, payload); } catch (err) { payload = null; }
    settings = safeSettings(payload);
    if (settings) settings.syncedAt = Number(syncRow.updated_at) || 0;
  }
  const storage = { mediaBytes, driveBytes, settingsBytes: syncRow ? String(syncRow.payload || "").length : 0 };

  const kind = has("account_kind") ? await first(env, "SELECT kind, owner_kind FROM account_kind WHERE public_id = ?", [id]) : null;

  return {
    id: String(acct.public_id),
    handle: acct.handle,
    name: acct.display_name,
    avatar: acct.avatar || "",
    banner: acct.banner || "",
    bio: acct.bio || "",
    owner: Number(acct.owner) === 1,
    createdAt: Number(acct.created_at) || 0,
    lastActive,
    online: seenAt > now - ONLINE_MS,
    profile: {
      protected: Number(acct.protected_account) === 1,
      privateFollows: Number(acct.private_follows) === 1,
      profileLess: Number(acct.profile_less) === 1,
      hideAvatar: acct.hide_avatar || ""
    },
    presence: presence ? { preference: presence.preference, activity: presence.activity, lastSeenPrivacy: presence.seen_privacy } : null,
    names,
    displayNames,
    people,
    signIn,
    passkeys: passkeys || 0,
    recoveryCodesLeft: recovery || 0,
    // Accounts have no email; nothing to show or reveal.
    email: { stored: false, verified: false },
    linked,
    counts,
    communities,
    requests,
    reports,
    reportsFiled: reportsFiled || 0,
    moderation,
    sessions: { active: sessions || 0, devices: devices.length, types: devices.map((d) => String(d.type || "").slice(0, 20)).filter(Boolean) },
    storage,
    settings,
    language: settings ? settings.language : "",
    setupDone: settings ? settings.setupDone : false,
    kind: kind ? { own: kind.kind || "", owner: kind.owner_kind || "" } : { own: "", owner: "" }
  };
}

export async function handleOwnerInspector(request, env, path, url, deps) {
  const gate = await deps.requireOwner(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  if (request.method !== "GET") return deps.json(405, { error: "method_not_allowed" });
  const hit = await deps.rateHit(env, "owner-inspector:" + gate.row.public_id, 600, 10 * 60 * 1000);
  if (!hit.ok) return deps.limited(hit);
  try { await ensureSchema(env); } catch (err) { /* reads still work; audit retried next time */ }

  if (path === "/v1/owner/inspector/accounts") return deps.json(200, await listAccounts(env, url), NO_STORE);

  if (path === "/v1/owner/inspector/audit") {
    // One log for every owner bypass: the inspector and friendship privacy write
    // owner_access_log; display names (#488) write display_name_audit; locked
    // follows write locked_follow_audit. Missing tables are skipped.
    const me = String(gate.row.public_id);
    const sources = [
      ["owner_access_log", "SELECT l.at, l.target_id AS tid, l.action, a.handle FROM owner_access_log l LEFT JOIN accounts a ON a.public_id = l.target_id ORDER BY l.at DESC LIMIT 100", [], ""],
      ["display_name_audit", "SELECT l.at, l.target_id AS tid, l.action, a.handle FROM display_name_audit l LEFT JOIN accounts a ON a.public_id = l.target_id WHERE l.viewer_id = ? ORDER BY l.at DESC LIMIT 100", [me], "names:"],
      ["locked_follow_audit", "SELECT l.at, l.subject_id AS tid, l.action, a.handle FROM locked_follow_audit l LEFT JOIN accounts a ON a.public_id = l.subject_id WHERE l.owner_id = ? ORDER BY l.at DESC LIMIT 100", [me], "locked:"]
    ];
    const tables = await tableSet(env);
    let rows = [];
    for (const [table, sql, args, tag] of sources) {
      if (!tables.has(table)) continue;
      try { rows = rows.concat((await all(env, sql, args)).map((r) => ({ at: Number(r.at) || 0, id: String(r.tid || ""), handle: r.handle || "", action: tag + String(r.action || "view") }))); } catch (err) { /* skip */ }
    }
    rows.sort((a, b) => b.at - a.at);
    return deps.json(200, { rows: rows.slice(0, 100) }, NO_STORE);
  }

  const one = path.match(/^\/v1\/owner\/inspector\/accounts\/([A-Za-z0-9_-]{1,64})$/);
  if (one) {
    const detail = await accountDetail(env, one[1], deps);
    if (!detail) return deps.json(404, { error: "not_found" });
    const extras = await ownerViewExtras(env, detail.id);
    if (Object.keys(extras).length) detail.extras = extras;
    detail.audited = await logOwnerView(env, String(gate.row.public_id), detail.id, "view");
    return deps.json(200, scrubSecrets(detail), NO_STORE);
  }
  return deps.json(404, { error: "not_found" });
}
