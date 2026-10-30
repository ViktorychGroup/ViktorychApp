/* "People you may know" and its typed siblings (companies, news & media,
   organizations, creators, communities). Suggestions are only real
   Viktorych accounts, computed from D1 with a handful of grouped queries
   and cached per viewer for 30 minutes so the feed card costs almost
   nothing.

   Signals: friends of friends (only through people whose follow lists are
   public), shared public communities, people who follow you that you don't
   follow back, and new accounts that recently interacted with you.
   Contacts are not used: there is no contact upload.

   Never suggested: yourself, accounts you follow or asked to follow,
   blocks either way, mutes, people you dismissed, protected accounts,
   profile-less accounts, accounts that turned off "Let others see me in
   People you may know", and temporary accounts unless they opted in.

   Reasons never name anyone whose follows are private, and the payload
   carries handles (as the viewer may see them), never account numbers. */
import { notLocked } from "./locked-sql.js";

import { resolveName, viewerHandle } from "./usernames.js";

export const ACCOUNT_KINDS = ["person", "business", "organization", "media", "government", "creator", "bot", "community", "other"];
/* Which card a kind lands in. */
export const KIND_GROUP = {
  person: "people",
  business: "companies",
  organization: "organizations",
  government: "organizations",
  media: "media",
  creator: "creators",
  bot: "accounts",
  community: "accounts",
  other: "accounts"
};
export const GROUPS = ["people", "companies", "media", "organizations", "creators", "accounts", "communities"];

const CACHE_MS = 30 * 60 * 1000;
const NEW_MS = 30 * 24 * 60 * 60 * 1000;
const PER_GROUP = 12;
const POOL = 80;

export const SUGGEST_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS account_kind (public_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'person', owner_kind TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS suggest_prefs (public_id TEXT PRIMARY KEY, discoverable INTEGER NOT NULL DEFAULT 1, temp_opt_in INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS suggest_dismiss (public_id TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (public_id, target_id))",
  "CREATE TABLE IF NOT EXISTS search_prefs (public_id TEXT PRIMARY KEY, searchable INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS suggest_cache (public_id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL)"
];

export function cleanKind(raw) {
  const text = String(raw || "").trim().toLowerCase();
  return ACCOUNT_KINDS.indexOf(text) >= 0 ? text : "";
}

/* The owner's choice wins over the account's own. */
export function effectiveKind(row) {
  if (!row) return "person";
  return cleanKind(row.owner_kind) || cleanKind(row.kind) || "person";
}

async function all(env, sql, ...args) {
  try {
    const res = await env.DB.prepare(sql).bind(...args).all();
    return (res && res.results) || [];
  } catch (err) {
    return [];
  }
}

async function first(env, sql, ...args) {
  try { return await env.DB.prepare(sql).bind(...args).first(); }
  catch (err) { return null; }
}

function idSet(rows, key) {
  const out = new Set();
  rows.forEach((row) => { if (row && row[key]) out.add(String(row[key])); });
  return out;
}

export async function dropSuggestCache(env, publicId) {
  try { await env.DB.prepare("DELETE FROM suggest_cache WHERE public_id = ?").bind(publicId).run(); }
  catch (err) { /* cache only */ }
}

/* Score every candidate. Pure: takes the raw signal rows, returns ranked
   { id, score, reason } in order. Exported for the unit test. */
export function rankCandidates(signals, excluded) {
  const map = new Map();
  function bump(id, score, reason, weight) {
    id = String(id || "");
    if (!/^\d{12}$/.test(id) || excluded.has(id)) return;
    let row = map.get(id);
    if (!row) { row = { id, score: 0, reason: null, rw: -1 }; map.set(id, row); }
    row.score += score;
    if (weight > row.rw) { row.reason = reason; row.rw = weight; }
  }
  (signals.fof || []).forEach((r) => bump(r.cid, 3 * Math.min(10, Number(r.n) || 1), { k: "fof", via: r.via, n: Number(r.n) || 1 }, 40 + Math.min(10, Number(r.n) || 1)));
  (signals.follower || []).forEach((r) => bump(r.cid, 5, { k: "fy" }, 45));
  (signals.community || []).forEach((r) => bump(r.cid, 2 * Math.min(5, Number(r.n) || 1), { k: "cm", c: r.com, n: Number(r.n) || 1 }, 30));
  (signals.interact || []).forEach((r) => bump(r.cid, 4, { k: "new" }, 20));
  return Array.from(map.values()).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

async function excludedFor(env, viewerId) {
  const rows = await Promise.all([
    all(env, "SELECT substr(target_id, 5) AS id FROM account_follows WHERE follower_id = ? AND target_id LIKE 'app:%'", viewerId),
    all(env, "SELECT target_id AS id FROM account_follow_requests WHERE requester_id = ?", viewerId),
    all(env, "SELECT blocked_id AS id FROM account_blocks WHERE blocker_id = ?", viewerId),
    all(env, "SELECT blocker_id AS id FROM account_blocks WHERE blocked_id = ?", viewerId),
    all(env, "SELECT muted_id AS id FROM account_mutes WHERE muter_id = ?", viewerId),
    all(env, "SELECT target_id AS id FROM suggest_dismiss WHERE public_id = ?", viewerId)
  ]);
  const out = new Set([viewerId]);
  rows.forEach((list) => list.forEach((row) => { if (row.id) out.add(String(row.id)); }));
  return out;
}

async function signalsFor(env, viewerId, now) {
  const [fof, follower, community, interact, communities] = await Promise.all([
    /* Friends of friends, only through people whose follow lists are public. */
    all(env,
      "SELECT substr(f2.target_id, 5) AS cid, COUNT(*) AS n, MIN(f2.follower_id) AS via FROM account_follows f1 " +
      "JOIN account_follows f2 ON f2.follower_id = substr(f1.target_id, 5) " +
      "JOIN accounts va ON va.public_id = f2.follower_id AND va.private_follows = 0 AND va.protected_account = 0 " +
      "WHERE f1.follower_id = ? AND f1.target_id LIKE 'app:%' AND f2.target_id LIKE 'app:%'" + notLocked("f1") + " " +
      "GROUP BY f2.target_id ORDER BY n DESC LIMIT " + POOL, viewerId),
    all(env, "SELECT follower_id AS cid FROM account_follows WHERE target_id = ? ORDER BY created_at DESC LIMIT " + POOL, "app:" + viewerId),
    all(env,
      "SELECT m2.public_id AS cid, COUNT(*) AS n, MIN(m2.community_id) AS com FROM community_members m1 " +
      "JOIN community_members m2 ON m2.community_id = m1.community_id AND m2.public_id != m1.public_id " +
      "LEFT JOIN community_meta meta ON meta.community_id = m1.community_id " +
      "WHERE m1.public_id = ? AND COALESCE(meta.visibility, 'public') = 'public' GROUP BY m2.public_id ORDER BY n DESC LIMIT " + POOL, viewerId),
    all(env,
      "SELECT DISTINCT n.actor_id AS cid FROM notifications n JOIN accounts a ON a.public_id = n.actor_id " +
      "WHERE n.public_id = ? AND n.at > ? AND n.actor_id != '' AND a.created_at > ? LIMIT 40", viewerId, now - NEW_MS, now - NEW_MS),
    /* Public communities that people you follow are in and you are not. */
    all(env,
      "SELECT m.community_id AS id, COUNT(*) AS n FROM account_follows f " +
      "JOIN community_members m ON m.public_id = substr(f.target_id, 5) " +
      "LEFT JOIN community_meta meta ON meta.community_id = m.community_id " +
      "LEFT JOIN community_members mine ON mine.community_id = m.community_id AND mine.public_id = ? " +
      "WHERE f.follower_id = ? AND f.target_id LIKE 'app:%' AND mine.public_id IS NULL AND COALESCE(meta.visibility, 'public') = 'public'" + notLocked("f") + " " +
      "GROUP BY m.community_id ORDER BY n DESC LIMIT 20", viewerId, viewerId)
  ]);
  return { fof, follower, community, interact, communities };
}

/* Accounts that may appear: listed, not protected, discoverable, and not
   temporary unless they opted in. Returns a map id -> account row. */
async function eligibleRows(env, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const marks = part.map(() => "?").join(",");
    const rows = await all(env,
      "SELECT a.public_id, a.handle, a.display_name, a.bio, a.avatar, a.hide_avatar, a.avatar_empty, a.owner, " +
      "k.kind AS kind, k.owner_kind AS owner_kind, COALESCE(p.discoverable, 1) AS discoverable, COALESCE(p.temp_opt_in, 0) AS temp_opt_in, " +
      "CASE WHEN t.public_id IS NULL THEN 0 ELSE 1 END AS temp " +
      "FROM accounts a LEFT JOIN account_kind k ON k.public_id = a.public_id LEFT JOIN suggest_prefs p ON p.public_id = a.public_id " +
      "LEFT JOIN account_temp t ON t.public_id = a.public_id " +
      "WHERE a.public_id IN (" + marks + ") AND a.profile_less = 0 AND a.protected_account = 0", ...part);
    rows.forEach((row) => {
      if (Number(row.discoverable) !== 1) return;
      if (Number(row.temp) === 1 && Number(row.temp_opt_in) !== 1) return;
      out.set(String(row.public_id), row);
    });
  }
  return out;
}

/* Turn a reason into something safe to show: names only of people the
   viewer follows and whose follows are public (already filtered in SQL). */
async function shownReason(env, request, viewerId, reason, nameCache) {
  if (!reason) return null;
  if (reason.k === "fof") {
    const via = String(reason.via || "");
    let name = nameCache.get(via);
    if (name === undefined) {
      const row = await first(env, "SELECT display_name FROM accounts WHERE public_id = ?", via);
      const seen = row ? await viewerHandle(env, request, via, viewerId) : { hidden: true };
      name = row && !seen.hidden ? String(row.display_name || seen.handle || "") : "";
      nameCache.set(via, name);
    }
    return name ? { k: "fof", name, n: Math.max(0, reason.n - 1) } : { k: "fofn", n: reason.n };
  }
  if (reason.k === "cm") return { k: "cm", c: String(reason.c || ""), n: reason.n };
  return { k: reason.k };
}

export async function computeSuggestions(env, request, viewerId, deps, now) {
  now = Number(now) || Date.now();
  const excluded = await excludedFor(env, viewerId);
  const signals = await signalsFor(env, viewerId, now);
  const ranked = rankCandidates(signals, excluded);
  const rows = await eligibleRows(env, ranked.map((r) => r.id).slice(0, POOL * 2));
  const groups = {};
  const nameCache = new Map();
  for (let i = 0; i < ranked.length; i++) {
    const cand = ranked[i];
    const row = rows.get(cand.id);
    if (!row) continue;
    const kind = effectiveKind(row);
    const group = KIND_GROUP[kind] || "accounts";
    groups[group] = groups[group] || [];
    if (groups[group].length >= PER_GROUP) continue;
    const seen = await viewerHandle(env, request, cand.id, viewerId);
    const handle = seen && !seen.hidden ? seen.handle : "";
    if (!handle) continue;
    const hidden = String(row.hide_avatar || "");
    const item = {
      id: "app:@" + handle,
      h: handle,
      n: String(row.display_name || handle),
      a: hidden ? "" : (deps.mediaUrl ? deps.mediaUrl(request, row.avatar) : ""),
      k: kind,
      r: await shownReason(env, request, viewerId, cand.reason, nameCache)
    };
    const bio = String(row.bio || "").replace(/\s+/g, " ").trim();
    if (bio) item.b = bio.slice(0, 160);
    if (Number(row.owner) === 1) item.v = "blue";
    groups[group].push(item);
  }
  const communities = signals.communities.filter((row) => row && row.id && !excluded.has("c:" + row.id)).slice(0, PER_GROUP).map((row) => ({ id: String(row.id), n: Number(row.n) || 1 }));
  if (communities.length) groups.communities = communities;
  return { at: now, groups };
}

function cleanId(raw) {
  const text = String(raw || "").trim();
  if (/^app:\d{12}$/.test(text)) return text.slice(4);
  return /^\d{12}$/.test(text) ? text : "";
}

async function targetFrom(env, raw, viewerId) {
  const text = String(raw || "").trim();
  const direct = cleanId(text);
  if (direct) return direct;
  const name = text.replace(/^app:/, "").replace(/^@/, "");
  if (!name) return "";
  const found = await resolveName(env, name, viewerId);
  return found && found.publicId ? String(found.publicId) : "";
}

async function readPrefs(env, publicId) {
  const row = await first(env, "SELECT discoverable, temp_opt_in FROM suggest_prefs WHERE public_id = ?", publicId);
  const kind = await first(env, "SELECT kind, owner_kind FROM account_kind WHERE public_id = ?", publicId);
  let search = null;
  try { search = await first(env, "SELECT searchable FROM search_prefs WHERE public_id = ?", publicId); }
  catch (err) { /* no table yet: visible */ }
  return {
    discoverable: row ? Number(row.discoverable) === 1 : true,
    searchable: search ? Number(search.searchable) === 1 : true,
    tempOptIn: row ? Number(row.temp_opt_in) === 1 : false,
    kind: kind ? (cleanKind(kind.kind) || "person") : "person",
    ownerKind: kind ? cleanKind(kind.owner_kind) : ""
  };
}

/* Routes:
   GET    /v1/suggestions               the viewer's typed suggestions
   POST   /v1/suggestions/dismiss       { id } "Not interested in this person" ({ community } for a community)
   GET    /v1/suggestions/prefs         { discoverable, searchable, tempOptIn, kind, ownerKind }
   PUT    /v1/suggestions/prefs         { discoverable?, searchable?, tempOptIn?, kind? }
   PUT    /v1/owner/account-kind        { id, kind } owner override ("" clears) */
export async function handleSuggestRoutes(request, env, path, url, deps) {
  if (path !== "/v1/suggestions" && path.indexOf("/v1/suggestions/") !== 0 && path !== "/v1/owner/account-kind") return null;
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  const me = String(viewer.public_id || "");
  if (!/^\d{12}$/.test(me)) return deps.json(200, { at: Date.now(), groups: {} });
  const method = request.method;
  const nocache = { "cache-control": "private, no-store" };

  if (path === "/v1/suggestions" && method === "GET") {
    const fresh = url.searchParams.get("fresh") === "1";
    const now = Date.now();
    if (!fresh) {
      const cached = await first(env, "SELECT body, created_at FROM suggest_cache WHERE public_id = ?", me);
      if (cached && now - Number(cached.created_at) < CACHE_MS) {
        try { return deps.json(200, JSON.parse(cached.body), nocache); } catch (err) { /* recompute */ }
      }
    }
    const paced = await deps.rateHit(env, "suggest:" + me, 30, 10 * 60 * 1000);
    if (!paced.ok) return deps.json(429, { error: "rate_limited" }, { "retry-after": String(paced.retry || 60) });
    const body = await computeSuggestions(env, request, me, deps, now);
    try {
      await env.DB.prepare("INSERT INTO suggest_cache (public_id, body, created_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at").bind(me, JSON.stringify(body), now).run();
    } catch (err) { /* cache only */ }
    return deps.json(200, body, nocache);
  }

  if (path === "/v1/suggestions/dismiss" && (method === "POST" || method === "DELETE")) {
    const paced = await deps.rateHit(env, "suggest-dismiss:" + me, 120, 10 * 60 * 1000);
    if (!paced.ok) return deps.json(429, { error: "rate_limited" }, { "retry-after": String(paced.retry || 60) });
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    let target = "";
    if (body.community) {
      const name = String(body.community || "").toLowerCase();
      target = /^[a-z0-9_]{2,21}$/.test(name) ? "c:" + name : "";
    } else target = await targetFrom(env, body.id, me);
    if (!target || target === me) return deps.json(400, { error: "bad_target" });
    if (method === "DELETE") await env.DB.prepare("DELETE FROM suggest_dismiss WHERE public_id = ? AND target_id = ?").bind(me, target).run();
    else await env.DB.prepare("INSERT INTO suggest_dismiss (public_id, target_id, created_at) VALUES (?, ?, ?) ON CONFLICT(public_id, target_id) DO NOTHING").bind(me, target, Date.now()).run();
    await dropSuggestCache(env, me);
    return deps.json(200, { ok: true });
  }

  if (path === "/v1/suggestions/prefs" && method === "GET") return deps.json(200, await readPrefs(env, me), nocache);

  if (path === "/v1/suggestions/prefs" && (method === "PUT" || method === "PATCH")) {
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const now = Date.now();
    const prev = await readPrefs(env, me);
    const discoverable = typeof body.discoverable === "boolean" ? body.discoverable : prev.discoverable;
    const tempOptIn = typeof body.tempOptIn === "boolean" ? body.tempOptIn : prev.tempOptIn;
    await env.DB.prepare("INSERT INTO suggest_prefs (public_id, discoverable, temp_opt_in, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET discoverable = excluded.discoverable, temp_opt_in = excluded.temp_opt_in, updated_at = excluded.updated_at")
      .bind(me, discoverable ? 1 : 0, tempOptIn ? 1 : 0, now).run();
    if (typeof body.searchable === "boolean") {
      // "Let others find me in search": off keeps the account out of People search
      // for everyone except the site owner (audit-logged there).
      await env.DB.prepare("INSERT INTO search_prefs (public_id, searchable, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET searchable = excluded.searchable, updated_at = excluded.updated_at")
        .bind(me, body.searchable ? 1 : 0, now).run();
    }
    if (body.kind !== undefined) {
      const kind = cleanKind(body.kind);
      if (!kind) return deps.json(400, { error: "bad_kind" });
      await env.DB.prepare("INSERT INTO account_kind (public_id, kind, owner_kind, updated_at) VALUES (?, ?, '', ?) ON CONFLICT(public_id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at").bind(me, kind, now).run();
    }
    return deps.json(200, await readPrefs(env, me), nocache);
  }

  if (path === "/v1/owner/account-kind" && method === "PUT") {
    if (Number(viewer.owner) !== 1) return deps.json(403, { error: "forbidden" });
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const target = await targetFrom(env, body.id, me);
    if (!target) return deps.json(404, { error: "not_found" });
    const kind = body.kind === "" ? "" : cleanKind(body.kind);
    if (body.kind !== "" && !kind) return deps.json(400, { error: "bad_kind" });
    await env.DB.prepare("INSERT INTO account_kind (public_id, kind, owner_kind, updated_at) VALUES (?, 'person', ?, ?) ON CONFLICT(public_id) DO UPDATE SET owner_kind = excluded.owner_kind, updated_at = excluded.updated_at").bind(target, kind, Date.now()).run();
    return deps.json(200, { ok: true, kind: kind });
  }
  return deps.json(405, { error: "method_not_allowed" });
}
