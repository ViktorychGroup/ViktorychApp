/* Source requests. Only the owner adds a source (an account, community,
   newsletter or feed) that makes the app fetch something new. Everyone else
   presses the same buttons, which file a request here. The owner allows it
   (for everyone, only the people who asked, or a source list), blocks it
   (it can be asked again later) or bans it (nobody can ask for or add it,
   and any copy stops being fetched).

   Everything lives in private D1 and R2. Handles and URLs never reach the
   public repo, the Pages site or a log. The sync reads only sha256
   prefixes of banned keys from owner/feed-bans.json, and the public
   hash list carries the same prefixes so devices drop banned sources. */

import { accountId, detectInput } from "../../shared/feed-sources.js";
import { readFlags } from "./feature-flags.js";

export const BANS_KEY = "owner/feed-bans.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUESTS_PER_DAY = 10;
const PENDING_PER_USER = 20;
const NOTE_MAX = 280;
const DEVICE_PREFIXES = ["news:", "nostr:", "mastodon:", "bsky:", "rss:"];
const SERVER_PLATFORMS = ["x", "threads", "instagram", "youtube", "tiktok", "vk", "telegram", "reddit", "bluesky", "mastodon", "rss"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS feed_requests (
    id TEXT PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'feed',
    platform TEXT NOT NULL DEFAULT '',
    handle TEXT NOT NULL DEFAULT '',
    input TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending',
    dest TEXT NOT NULL DEFAULT '',
    dest_detail TEXT NOT NULL DEFAULT '',
    decided_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    seen_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS feed_requests_state ON feed_requests (state, updated_at)",
  `CREATE TABLE IF NOT EXISTS feed_request_voters (
    request_id TEXT NOT NULL,
    public_id TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT 0,
    decided_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (request_id, public_id)
  )`,
  "CREATE INDEX IF NOT EXISTS feed_request_voters_by ON feed_request_voters (public_id, created_at)",
  `CREATE TABLE IF NOT EXISTS feed_bans (
    source_key TEXT PRIMARY KEY,
    alias TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    input TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS feed_bans_alias ON feed_bans (alias)",
  `CREATE TABLE IF NOT EXISTS feed_allows (
    source_key TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source_key, scope)
  )`
];

let schemaReady = null;
export function ensureFeedRequestSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)))
      .catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

export async function feedRequestsOn(env) {
  try {
    const off = await readFlags(env);
    return !off.feed_requests;
  } catch (err) {
    return true;
  }
}

function clip(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "fr_";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function swapBsky(key) {
  if (key.indexOf("bluesky:") === 0) return "bsky:" + key.slice(8);
  if (key.indexOf("bsky:") === 0) return "bluesky:" + key.slice(5);
  return "";
}

/* Every lowercase spelling a source can carry: its catalog id, platform:handle
   and the Bluesky short prefix used by device follows. */
export function keyVariants(keys) {
  const out = new Set();
  (keys || []).forEach((raw) => {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) return;
    out.add(key);
    const swapped = swapBsky(key);
    if (swapped) out.add(swapped);
  });
  return Array.from(out);
}

function specKeys(spec) {
  if (!spec || !spec.ok) return [];
  const keys = [accountId(spec)];
  if (spec.platform && spec.handle) keys.push(spec.platform + ":" + spec.handle);
  if (spec.platform === "reddit" && spec.handle) keys.push("reddit:" + (spec.redditKind || "u") + ":" + spec.handle);
  return keyVariants(keys);
}

/* What a request or a follow id points at. kind "community" is a subreddit
   from the Communities page; "news" a newsletter the device already read. */
export function resolveSource(raw, opts) {
  const options = opts || {};
  const text = clip(raw, 300);
  if (!text) return { ok: false, error: "bad_input" };
  const lower = text.toLowerCase();
  if (options.kind === "community") {
    const name = lower.replace(/^https?:\/\/(?:www\.|old\.)?reddit\.com\/r\//, "").replace(/^\/?r\//, "").split(/[/?#]/)[0];
    if (!/^[a-z0-9_]{2,21}$/.test(name)) return { ok: false, error: "bad_input" };
    const key = "reddit:r:" + name;
    return { ok: true, key, keys: keyVariants([key, "reddit:" + name]), platform: "reddit", kind: "community", handle: name, input: "r/" + name, url: "https://www.reddit.com/r/" + name };
  }
  const prefixed = lower.match(/^(news|nostr|rss):([a-z0-9._:@+-]{3,80})$/);
  if (prefixed) {
    const key = prefixed[1] + ":" + prefixed[2];
    return { ok: true, key, keys: [key], platform: prefixed[1], kind: prefixed[1], handle: prefixed[2], input: text, url: "" };
  }
  if (options.newsKey) {
    const nk = String(options.newsKey).toLowerCase().replace(/^news:/, "");
    if (!/^[a-z0-9-]{3,60}$/.test(nk)) return { ok: false, error: "bad_input" };
    return { ok: true, key: "news:" + nk, keys: ["news:" + nk], platform: "news", kind: "news", handle: nk, input: text, url: /^https?:\/\//i.test(text) ? text : "" };
  }
  const bskyId = lower.match(/^bsky:([a-z0-9._:-]{3,80})$/);
  const spec = detectInput(bskyId ? "bluesky:" + bskyId[1] : text);
  if (!spec.ok) return { ok: false, error: spec.error || "bad_input", message: spec.message || "" };
  const keys = specKeys(spec);
  return { ok: true, key: keys[0], keys, platform: spec.platform, kind: "feed", handle: spec.handle, input: canonicalInput(spec, text), url: spec.url || "", spec };
}

/* One spelling per source, whatever was pasted: a full profile URL (with or
   without www, a trailing slash or a query string), an @handle or a
   platform:handle id all become platform:handle. Feeds keep their https URL.
   resolveSource(canonicalInput(spec)) gives the same key again. */
export function canonicalInput(spec, fallback) {
  if (!spec || !spec.ok || !spec.platform) return clip(fallback, 300);
  if (spec.platform === "rss") return clip(spec.url || fallback, 300);
  if (spec.platform === "mastodon") return "mastodon:" + spec.handle + "@" + spec.host;
  if (spec.platform === "reddit") return "reddit:" + (spec.redditKind === "r" ? "r/" : "u/") + spec.handle;
  if (spec.platform === "youtube" && spec.channelId) return "youtube:" + spec.channelId;
  return spec.platform + ":" + spec.handle;
}

/* A stored request row as a clean input. Rows filed before inputs were
   normalized carry the pasted URL; this re-reads it and checks the key. */
export function rowInput(row) {
  if (!row) return "";
  if (row.kind === "community" || row.kind === "news" || row.kind === "nostr") return row.input;
  const source = resolveSource(row.input, {});
  if (source.ok && keyVariants(source.keys).indexOf(String(row.source_key || "").toLowerCase()) >= 0) return source.input;
  if (row.platform && row.handle && ["x", "threads", "instagram", "tiktok", "vk", "telegram", "bluesky"].indexOf(row.platform) >= 0) {
    const again = resolveSource(row.platform + ":" + row.handle, {});
    if (again.ok && again.key === String(row.source_key || "").toLowerCase()) return again.input;
  }
  return row.input;
}

/* A follow id as the app stores it (x:handle, news:key, mastodon:u@host). */
export function followKeys(id) {
  const text = String(id || "").trim().toLowerCase();
  if (!text || text.indexOf("app:") === 0) return [];
  const keys = [text];
  const reddit = text.match(/^reddit:([a-z0-9_]{2,21})$/);
  if (reddit) keys.push("reddit:r:" + reddit[1]);
  return keyVariants(keys);
}

export function isDeviceFollow(id) {
  const text = String(id || "").toLowerCase();
  return DEVICE_PREFIXES.some((prefix) => text.indexOf(prefix) === 0);
}

async function sha(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  let out = "";
  const bytes = new Uint8Array(digest);
  for (let i = 0; i < 10; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export async function banHash(key) {
  return sha("feed-ban:" + String(key || "").toLowerCase());
}

/* True when any spelling of the source is banned. */
export async function bannedKeys(env, keys) {
  const list = keyVariants(keys);
  if (!list.length || !env || !env.DB) return false;
  try {
    await ensureFeedRequestSchema(env);
    const marks = list.map(() => "?").join(",");
    const row = await env.DB.prepare(`SELECT source_key FROM feed_bans WHERE source_key IN (${marks}) OR alias IN (${marks}) LIMIT 1`).bind(...list, ...list).first();
    return !!row;
  } catch (err) {
    return false;
  }
}

export async function bannedSpec(env, spec) {
  return bannedKeys(env, specKeys(spec));
}

export async function bannedInput(env, raw, opts) {
  const source = resolveSource(raw, opts);
  return source.ok ? bannedKeys(env, source.keys) : false;
}

async function allowedFor(env, keys, publicId) {
  const list = keyVariants(keys);
  if (!list.length) return false;
  const marks = list.map(() => "?").join(",");
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM feed_allows WHERE source_key IN (${marks}) AND (scope = 'all' OR scope = ?) LIMIT 1`).bind(...list, String(publicId || "")).first();
  return !!row;
}

/* A device follow (newsletter, Mastodon, Bluesky, Nostr, RSS) is in the app
   when the owner allowed it or somebody already follows it. Existing feeds
   stay exactly as they are. */
async function inApp(env, id, publicId) {
  const keys = followKeys(id);
  if (await allowedFor(env, keys, publicId)) return true;
  // A source that went through a request follows the owner's decision.
  const marks = keys.map(() => "?").join(",");
  const asked = keys.length ? await env.DB.prepare(`SELECT 1 AS ok FROM feed_requests WHERE source_key IN (${marks}) LIMIT 1`).bind(...keys).first() : null;
  if (asked) return false;
  const row = await env.DB.prepare("SELECT 1 AS ok FROM account_follows WHERE target_id = ? LIMIT 1").bind(String(id)).first();
  return !!row;
}

/* PUT /v1/follows. Returns a Response to send instead, or null to go on. */
export async function followGate(env, viewer, id, deps) {
  if (!viewer || String(id || "").indexOf("app:") === 0) return null;
  if (!(await feedRequestsOn(env))) return null;
  await ensureFeedRequestSchema(env);
  if (await bannedKeys(env, followKeys(id))) return deps.json(403, { error: "banned", message: "This source isn't available." });
  if (Number(viewer.owner) === 1 || !isDeviceFollow(id)) return null;
  if (await inApp(env, id, viewer.public_id)) return null;
  const made = await fileRequest(env, viewer, { input: String(id), kind: "", note: "" }, deps, { quiet: true });
  if (made.status !== 200) return deps.json(made.status, made.body);
  return deps.json(403, { error: "owner_only", requested: true, request: made.body.request, message: "Only the owner adds new sources. Your request was sent." });
}

/* POST /v1/follows/import keeps ids the account may follow. */
export async function importFilter(env, viewer, ids) {
  if (!viewer || !(await feedRequestsOn(env))) return ids;
  await ensureFeedRequestSchema(env);
  const out = [];
  for (const id of ids) {
    if (id.indexOf("app:") === 0) { out.push(id); continue; }
    if (await bannedKeys(env, followKeys(id))) continue;
    if (Number(viewer.owner) !== 1 && isDeviceFollow(id) && !(await inApp(env, id, viewer.public_id))) {
      const mine = await env.DB.prepare("SELECT 1 AS ok FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(viewer.public_id, id).first();
      if (!mine) continue;
    }
    out.push(id);
  }
  return out;
}

async function ownerRow(env) {
  return env.DB.prepare("SELECT public_id, handle, display_name FROM accounts WHERE owner = 1 ORDER BY created_at LIMIT 1").first();
}

async function notify(env, input) {
  try {
    const notes = await import("./notifications.js");
    await notes.emitNotification(env, input);
  } catch (err) { /* the request itself is stored */ }
}

function publicRequest(row, voter) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.source_key,
    kind: row.kind,
    platform: row.platform,
    handle: row.handle || "",
    input: row.input,
    name: row.name || "",
    avatar: row.avatar || "",
    url: row.url || "",
    state: voter ? voter.state : row.state,
    at: Number(voter ? voter.created_at : row.created_at) || 0,
    decidedAt: Number(voter ? voter.decided_at : row.decided_at) || 0,
    note: voter ? voter.note || "" : undefined
  };
}

/* Files (or joins) a request. Returns { status, body }. */
export async function fileRequest(env, viewer, body, deps, opts) {
  const options = opts || {};
  await ensureFeedRequestSchema(env);
  const publicId = String(viewer.public_id);
  if (Number(viewer.owner) === 1 && !options.quiet) return { status: 400, body: { error: "owner_adds", message: "The owner adds sources directly." } };
  const source = resolveSource(body.input, { kind: body.kind === "community" ? "community" : "", newsKey: body.key });
  if (!source.ok) return { status: 400, body: { error: source.error || "bad_input", message: source.message || "" } };
  if (await bannedKeys(env, source.keys)) return { status: 403, body: { error: "banned", message: "This source isn't available." } };
  // A device source the owner allowed, or somebody already followed before
  // requests existed, opens at once.
  if (isDeviceFollow(source.key) && await inApp(env, source.key, publicId)) {
    return { status: 200, body: { state: "allowed", key: source.key } };
  }
  const hit = await deps.rateHit(env, "feed-req:" + publicId, REQUESTS_PER_DAY, DAY_MS);
  if (!hit.ok) return { status: 429, body: { error: "rate_limited", message: "Too many requests today. Try again tomorrow." } };
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM feed_request_voters WHERE public_id = ? AND state = 'pending'").bind(publicId).first();
  if (Number(pending && pending.n) >= PENDING_PER_USER) return { status: 400, body: { error: "too_many", message: "You have too many open requests." } };
  const now = Date.now();
  let row = await env.DB.prepare("SELECT * FROM feed_requests WHERE source_key = ?").bind(source.key).first();
  let fresh = false;
  if (!row) {
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO feed_requests (id, source_key, kind, platform, handle, input, name, avatar, url, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT(source_key) DO NOTHING"
    ).bind(id, source.key, source.kind, source.platform, clip(source.handle, 120), source.input, clip(body.name, 80), /^https:\/\//.test(String(body.avatar || "")) ? clip(body.avatar, 400) : "", source.url, now, now).run();
    row = await env.DB.prepare("SELECT * FROM feed_requests WHERE source_key = ?").bind(source.key).first();
    fresh = true;
  } else if (row.state !== "pending" && row.state !== "banned") {
    await env.DB.prepare("UPDATE feed_requests SET state = 'pending', updated_at = ?, seen_at = 0 WHERE id = ?").bind(now, row.id).run();
    row.state = "pending";
    fresh = true;
  }
  if (row.state === "banned") return { status: 403, body: { error: "banned", message: "This source isn't available." } };
  const note = clip(body.note, NOTE_MAX);
  await env.DB.prepare(
    "INSERT INTO feed_request_voters (request_id, public_id, note, state, created_at, decided_at) VALUES (?, ?, ?, 'pending', ?, 0) ON CONFLICT(request_id, public_id) DO UPDATE SET state = 'pending', note = CASE WHEN excluded.note != '' THEN excluded.note ELSE feed_request_voters.note END, created_at = excluded.created_at, decided_at = 0"
  ).bind(row.id, publicId, note, now).run();
  if (fresh) {
    const owner = await ownerRow(env);
    if (owner && String(owner.public_id) !== publicId) {
      await notify(env, {
        publicId: String(owner.public_id), kind: "feed_request", at: now, actorId: publicId,
        idempotencyKey: "feedreq:" + row.id + ":" + now, name: row.name || source.handle || "", text: "",
        hash: "#/settings/feed-requests", platform: source.platform
      });
    }
  }
  const voter = await env.DB.prepare("SELECT * FROM feed_request_voters WHERE request_id = ? AND public_id = ?").bind(row.id, publicId).first();
  return { status: 200, body: { state: "pending", request: publicRequest(row, voter) } };
}

async function myRequests(env, publicId) {
  const rows = await env.DB.prepare(
    "SELECT r.*, v.note AS v_note, v.state AS v_state, v.created_at AS v_created, v.decided_at AS v_decided FROM feed_request_voters v JOIN feed_requests r ON r.id = v.request_id WHERE v.public_id = ? ORDER BY v.created_at DESC LIMIT 200"
  ).bind(publicId).all();
  return (rows.results || []).map((row) => publicRequest(row, { state: row.v_state, created_at: row.v_created, decided_at: row.v_decided, note: row.v_note }));
}

async function bansHashList(env) {
  await ensureFeedRequestSchema(env);
  const rows = await env.DB.prepare("SELECT source_key, alias FROM feed_bans").all();
  const hashes = new Set();
  for (const row of rows.results || []) {
    for (const key of keyVariants([row.source_key, row.alias])) hashes.add(await banHash(key));
  }
  return Array.from(hashes).sort();
}

async function writeBansDoc(env) {
  const hashes = await bansHashList(env);
  if (env.DATA) {
    await env.DATA.put(BANS_KEY, JSON.stringify({ v: 1, at: Date.now(), hashes }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  }
  return hashes;
}

/* /v1/feed-requests: the signed-in member's side. */
export async function handleFeedRequests(request, env, path, deps) {
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  await ensureFeedRequestSchema(env);
  const method = request.method;
  if (path === "/v1/feed-requests/banned" && method === "GET") {
    const hashes = await bansHashList(env);
    return deps.json(200, { v: 1, hashes }, { "cache-control": "public, max-age=300" });
  }
  const me = await deps.sessionAccount(env, request);
  if (!me) return deps.json(401, { error: "auth" });
  const publicId = String(me.public_id);
  if (path === "/v1/feed-requests" && method === "GET") {
    return deps.json(200, { owner: Number(me.owner) === 1, requests: await myRequests(env, publicId) }, { "cache-control": "private, no-store" });
  }
  if (path === "/v1/feed-requests" && method === "POST") {
    const body = await deps.readJson(request, 3000);
    if (body.error) return deps.json(400, { error: body.error });
    const made = await fileRequest(env, me, body, deps);
    return deps.json(made.status, made.body);
  }
  const one = path.match(/^\/v1\/feed-requests\/(fr_[a-f0-9]{16})$/);
  if (one && method === "DELETE") {
    const row = await env.DB.prepare("SELECT state FROM feed_request_voters WHERE request_id = ? AND public_id = ?").bind(one[1], publicId).first();
    if (!row) return deps.json(404, { error: "not_found" });
    await env.DB.prepare("DELETE FROM feed_request_voters WHERE request_id = ? AND public_id = ?").bind(one[1], publicId).run();
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM feed_request_voters WHERE request_id = ? AND state = 'pending'").bind(one[1]).first();
    if (!Number(left && left.n)) {
      await env.DB.prepare("UPDATE feed_requests SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'pending'").bind(Date.now(), one[1]).run();
    }
    return deps.json(200, { cancelled: true, requests: await myRequests(env, publicId) });
  }
  return deps.json(404, { error: "not_found" });
}

async function voterPeople(env, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    if (!part.length) continue;
    const rows = await env.DB.prepare(`SELECT public_id, handle, display_name, avatar FROM accounts WHERE public_id IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    (rows.results || []).forEach((row) => {
      out[String(row.public_id)] = { id: String(row.public_id), handle: row.handle || "", name: row.display_name || row.handle || "", avatar: row.avatar || "" };
    });
  }
  return out;
}

async function ownerQueue(env, state) {
  const where = state === "decided" ? "state IN ('approved','rejected')" : "state = 'pending'";
  const rows = await env.DB.prepare(`SELECT * FROM feed_requests WHERE ${where} ORDER BY updated_at DESC LIMIT 200`).all();
  const list = rows.results || [];
  for (const row of list) {
    if (row.state !== "pending" || !/^https?:\/\//i.test(String(row.input || ""))) continue;
    const clean = rowInput(row);
    if (clean && clean !== row.input) {
      await env.DB.prepare("UPDATE feed_requests SET input = ? WHERE id = ?").bind(clean, row.id).run();
      row.input = clean;
    }
  }
  const voters = {};
  const ids = new Set();
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50).map((row) => row.id);
    if (!part.length) continue;
    const got = await env.DB.prepare(`SELECT * FROM feed_request_voters WHERE request_id IN (${part.map(() => "?").join(",")}) ORDER BY created_at`).bind(...part).all();
    (got.results || []).forEach((row) => {
      (voters[row.request_id] = voters[row.request_id] || []).push(row);
      ids.add(String(row.public_id));
    });
  }
  const people = await voterPeople(env, Array.from(ids));
  return list.map((row) => {
    const out = publicRequest(row, null);
    let preview = [];
    try { preview = JSON.parse(row.preview || "[]"); } catch (err) { preview = []; }
    out.preview = Array.isArray(preview) ? preview.slice(0, 3) : [];
    out.dest = row.dest || "";
    out.unseen = !(Number(row.seen_at) >= Number(row.updated_at));
    out.requesters = (voters[row.id] || []).map((v) => Object.assign({ note: v.note || "", state: v.state, at: Number(v.created_at) || 0 }, people[String(v.public_id)] || { id: String(v.public_id), handle: "", name: "" }));
    out.count = out.requesters.filter((v) => v.state === "pending").length;
    return out;
  });
}

async function pendingCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN seen_at < updated_at THEN 1 ELSE 0 END) AS fresh FROM feed_requests WHERE state = 'pending'").first();
  return { pending: Number(row && row.n) || 0, unseen: Number(row && row.fresh) || 0 };
}

async function decideVoters(env, row, state, now) {
  const got = await env.DB.prepare("SELECT public_id FROM feed_request_voters WHERE request_id = ? AND state = 'pending'").bind(row.id).all();
  const ids = (got.results || []).map((v) => String(v.public_id));
  await env.DB.prepare("UPDATE feed_request_voters SET state = ?, decided_at = ? WHERE request_id = ? AND state = 'pending'").bind(state, now, row.id).run();
  for (const id of ids) {
    await notify(env, {
      publicId: id, kind: state === "approved" ? "feed_approved" : "feed_rejected", at: now, idempotencyKey: "feeddec:" + row.id + ":" + id + ":" + now,
      name: row.name || row.handle || "", text: "",
      hash: "#/feeds/requests", platform: row.platform
    });
  }
  return ids;
}

async function memberIdsByHandle(env, handles) {
  const out = [];
  for (const raw of (handles || []).slice(0, 50)) {
    const handle = String(raw || "").trim().replace(/^@/, "");
    if (!handle || handle.length > 60) continue;
    const row = await env.DB.prepare("SELECT public_id FROM accounts WHERE lower(handle) = lower(?)").bind(handle).first();
    if (row) out.push(String(row.public_id));
  }
  return out;
}

async function allowRequest(env, row, body, deps, gateRow) {
  const now = Date.now();
  const dest = body.dest === "requester" || body.dest === "list" ? body.dest : "everyone";
  const pending = await env.DB.prepare("SELECT public_id FROM feed_request_voters WHERE request_id = ? AND state = 'pending'").bind(row.id).all();
  const askers = (pending.results || []).map((v) => String(v.public_id));
  const server = row.kind === "community" || SERVER_PLATFORMS.indexOf(row.platform) >= 0;
  const input = rowInput(row);
  if (input !== row.input) {
    await env.DB.prepare("UPDATE feed_requests SET input = ? WHERE id = ?").bind(input, row.id).run();
    row.input = input;
  }
  let detail = "";
  let unverified = false;
  if (dest === "everyone") {
    if (row.kind === "community") {
      const communities = await import("./communities.js");
      const added = await communities.addOwnerCommunity(env, row.handle || row.input, deps);
      if (added.error) return { status: added.status || 400, body: { error: added.error } };
    } else if (server) {
      const feeds = await import("./owner-feeds.js");
      const added = await feeds.addToCatalog(env, input, deps, { unverified: true });
      if (added.status !== 200) return added;
      unverified = !!(added.body && added.body.unverified);
    }
    await env.DB.prepare("INSERT INTO feed_allows (source_key, scope, created_at) VALUES (?, 'all', ?) ON CONFLICT DO NOTHING").bind(row.source_key, now).run();
  } else {
    let members = dest === "requester" ? askers.slice() : askers.concat(await memberIdsByHandle(env, body.members));
    members = Array.from(new Set(members));
    if (server && row.kind !== "community" && row.platform !== "tiktok") {
      const lists = await import("./source-lists.js");
      const placed = await lists.allowIntoList(env, deps, {
        unverified: true,
        input,
        listId: dest === "list" ? body.listId : "",
        newList: dest === "list" ? body.newList : (body.newList || row.name || row.input),
        memberIds: members
      });
      if (placed.error) return { status: placed.status || 400, body: { error: placed.error, message: placed.message || "" } };
      detail = placed.listId || "";
    }
    for (const id of members) {
      await env.DB.prepare("INSERT INTO feed_allows (source_key, scope, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(row.source_key, id, now).run();
    }
  }
  await env.DB.prepare("UPDATE feed_requests SET state = 'approved', dest = ?, dest_detail = ?, decided_at = ?, updated_at = ?, seen_at = ? WHERE id = ?").bind(dest, detail, now, now, now, row.id).run();
  await decideVoters(env, Object.assign({}, row), "approved", now);
  return { status: 200, body: { ok: true, id: row.id, dest, unverified } };
}

async function blockRequest(env, row) {
  const now = Date.now();
  await env.DB.prepare("UPDATE feed_requests SET state = 'rejected', decided_at = ?, updated_at = ?, seen_at = ? WHERE id = ?").bind(now, now, now, row.id).run();
  await decideVoters(env, row, "rejected", now);
  return { status: 200, body: { ok: true, id: row.id } };
}

/* Bans one source: stored, every copy stops being fetched, and the public
   hash list is rewritten so devices drop it too. */
async function banSource(env, source, meta, deps) {
  const now = Date.now();
  const keys = keyVariants(source.keys && source.keys.length ? source.keys : [source.key]);
  await env.DB.prepare(
    "INSERT INTO feed_bans (source_key, alias, platform, input, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_key) DO UPDATE SET alias = excluded.alias"
  ).bind(source.key, keys.find((key) => key !== source.key) || "", source.platform || "", clip(source.input, 300), clip(meta.name, 80), clip(meta.avatar, 400), now).run();
  const marks = keys.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM feed_allows WHERE source_key IN (${marks})`).bind(...keys).run();
  const reqs = await env.DB.prepare(`SELECT * FROM feed_requests WHERE source_key IN (${marks})`).bind(...keys).all();
  for (const row of reqs.results || []) {
    await env.DB.prepare("UPDATE feed_requests SET state = 'banned', decided_at = ?, updated_at = ?, seen_at = ? WHERE id = ?").bind(now, now, now, row.id).run();
    await decideVoters(env, row, "rejected", now);
  }
  try {
    const feeds = await import("./owner-feeds.js");
    await feeds.pauseCatalogKeys(env, keys);
  } catch (err) { /* the ban hash list below still drops it in the sync */ }
  try {
    const lists = await import("./source-lists.js");
    await lists.dropSourceKeys(env, keys, deps);
  } catch (err) { /* same */ }
  if (source.platform === "reddit") {
    try {
      const communities = await import("./communities.js");
      await communities.dropOwnerCommunities(env, keys.filter((key) => key.indexOf("reddit:r:") === 0).map((key) => key.slice(9)));
    } catch (err) { /* same */ }
  }
  await writeBansDoc(env);
  if (deps.dispatchWorkflows) {
    try { await deps.dispatchWorkflows(env, ["sync.yml"]); } catch (err) { /* the next scheduled sync drops it */ }
  }
}

async function banRequest(env, row, deps) {
  const source = resolveSource(row.kind === "community" ? row.handle || row.input : rowInput(row), { kind: row.kind === "community" ? "community" : "", newsKey: row.kind === "news" ? row.source_key : "" });
  const target = source.ok && source.key === row.source_key ? source : { key: row.source_key, keys: [row.source_key], platform: row.platform, input: row.input };
  await banSource(env, target, row, deps);
  return { status: 200, body: { ok: true, id: row.id } };
}

async function listBans(env) {
  const rows = await env.DB.prepare("SELECT source_key, platform, input, name, avatar, created_at FROM feed_bans ORDER BY created_at DESC LIMIT 500").all();
  return (rows.results || []).map((row) => ({ key: row.source_key, platform: row.platform, input: row.input, name: row.name || "", avatar: row.avatar || "", at: Number(row.created_at) || 0 }));
}

/* /v1/owner/feed-requests and /v1/owner/feed-bans. */
export async function handleOwnerFeedRequests(request, env, path, deps) {
  const gate = await deps.requireOwnerHidden(request, env);
  if (gate.error) return gate.error;
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  await ensureFeedRequestSchema(env);
  const method = request.method;
  const hit = await deps.rateHit(env, "owner-feedreq:" + gate.row.public_id + ":" + (method === "GET" ? "r" : "w"), method === "GET" ? 240 : 200, 60 * 60 * 1000);
  if (!hit.ok) return deps.limited(hit);

  if (path === "/v1/owner/feed-requests/count" && method === "GET") {
    return deps.json(200, await pendingCount(env), { "cache-control": "private, no-store" });
  }
  if (path === "/v1/owner/feed-requests" && method === "GET") {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") === "decided" ? "decided" : "pending";
    const requests = await ownerQueue(env, state);
    let lists = [];
    try {
      const mod = await import("./source-lists.js");
      lists = await mod.listsSummary(env);
    } catch (err) { lists = []; }
    return deps.json(200, Object.assign({ requests, lists }, await pendingCount(env)), { "cache-control": "private, no-store" });
  }
  if (path === "/v1/owner/feed-requests/seen" && method === "POST") {
    await env.DB.prepare("UPDATE feed_requests SET seen_at = ? WHERE state = 'pending'").bind(Date.now()).run();
    return deps.json(200, await pendingCount(env));
  }
  if (path === "/v1/owner/feed-requests/bulk" && method === "POST") {
    const body = await deps.readJson(request, 8000);
    if (body.error) return deps.json(400, { error: body.error });
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((id) => /^fr_[a-f0-9]{16}$/.test(id)).slice(0, 50);
    const action = String(body.action || "");
    if (!ids.length || ["allow", "block", "ban"].indexOf(action) < 0) return deps.json(400, { error: "bad_bulk" });
    const results = [];
    for (const id of ids) {
      const row = await env.DB.prepare("SELECT * FROM feed_requests WHERE id = ?").bind(id).first();
      if (!row) { results.push({ id, error: "not_found" }); continue; }
      const done = action === "allow" ? await allowRequest(env, row, body, deps, gate.row) : action === "block" ? await blockRequest(env, row) : await banRequest(env, row, deps);
      results.push(done.status === 200 ? { id, ok: true } : { id, error: done.body.error || "failed" });
    }
    return deps.json(200, Object.assign({ results }, await pendingCount(env)));
  }
  const one = path.match(/^\/v1\/owner\/feed-requests\/(fr_[a-f0-9]{16})\/(allow|block|ban|preview)$/);
  if (one && method === "POST") {
    const row = await env.DB.prepare("SELECT * FROM feed_requests WHERE id = ?").bind(one[1]).first();
    if (!row) return deps.json(404, { error: "not_found" });
    if (one[2] === "preview") {
      const source = resolveSource(rowInput(row), {});
      if (!source.ok || !source.spec) return deps.json(200, { request: publicRequest(row, null), preview: [] });
      const feeds = await import("./owner-feeds.js");
      const probed = await feeds.probeWithin(source.spec, 9000);
      if (probed.error) return deps.json(200, { request: publicRequest(row, null), preview: [], error: probed.error });
      const posts = (probed.posts || []).slice(0, 3).map((post) => ({ text: clip(post.text, 200), date: clip(post.date, 40), url: /^https:\/\//.test(String(post.url || "")) ? clip(post.url, 400) : "" }));
      const name = clip(probed.profile && probed.profile.name, 80) || row.name;
      const avatar = probed.profile && /^https:\/\//.test(String(probed.profile.avatar || "")) ? clip(probed.profile.avatar, 400) : row.avatar;
      await env.DB.prepare("UPDATE feed_requests SET name = ?, avatar = ?, preview = ? WHERE id = ?").bind(name || "", avatar || "", JSON.stringify(posts), row.id).run();
      return deps.json(200, { request: Object.assign(publicRequest(Object.assign({}, row, { name, avatar }), null), { preview: posts }) });
    }
    const body = one[2] === "allow" ? await deps.readJson(request, 4000) : {};
    if (body.error) return deps.json(400, { error: body.error });
    const done = one[2] === "allow" ? await allowRequest(env, row, body, deps, gate.row) : one[2] === "block" ? await blockRequest(env, row) : await banRequest(env, row, deps);
    if (done.status !== 200) return deps.json(done.status, done.body, done.extra || null);
    return deps.json(200, Object.assign(done.body, await pendingCount(env)));
  }

  if (path === "/v1/owner/feed-bans" && method === "GET") {
    return deps.json(200, { bans: await listBans(env) }, { "cache-control": "private, no-store" });
  }
  if (path === "/v1/owner/feed-bans" && method === "POST") {
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const source = resolveSource(body.input, { kind: body.kind === "community" ? "community" : "" });
    if (!source.ok) return deps.json(400, { error: source.error || "bad_input", message: source.message || "" });
    await banSource(env, source, { name: body.name || "", avatar: "" }, deps);
    return deps.json(200, { bans: await listBans(env) });
  }
  const unban = path.match(/^\/v1\/owner\/feed-bans\/([^/]+)$/);
  if (unban && method === "DELETE") {
    let key = unban[1];
    try { key = decodeURIComponent(key); } catch (err) { /* keep the raw segment */ }
    key = String(key).toLowerCase().slice(0, 200);
    await env.DB.prepare("DELETE FROM feed_bans WHERE source_key = ?").bind(key).run();
    await env.DB.prepare("UPDATE feed_requests SET state = 'rejected', updated_at = ? WHERE source_key = ? AND state = 'banned'").bind(Date.now(), key).run();
    await writeBansDoc(env);
    return deps.json(200, { bans: await listBans(env) });
  }
  return deps.json(404, { error: "not_found" });
}

/* A signed-in member who is not the owner pressed an owner add button (or
   called the add route directly). The add never happens: it becomes a
   request, and the answer says so with 403. Returns null to go on. */
const ADD_ROUTES = [
  { re: /^\/v1\/owner\/feeds$/, field: ["input"], kind: "" },
  { re: /^\/v1\/owner\/accounts$/, field: ["handle", "input", "url"], kind: "", prefix: "x:" },
  { re: /^\/v1\/owner\/tiktok\/accounts$/, field: ["handle", "input", "url"], kind: "", prefix: "tiktok:" },
  { re: /^\/v1\/owner\/communities$/, field: ["name", "url", "input"], kind: "community" },
  { re: /^\/v1\/owner\/source-lists\/[^/]+\/sources$/, field: ["input"], kind: "" }
];

export async function requestInsteadOfAdd(request, env, path, deps) {
  if (request.method !== "POST" || !env.DB) return null;
  const route = ADD_ROUTES.find((row) => row.re.test(path));
  if (!route) return null;
  if (!(await feedRequestsOn(env))) return null;
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer || Number(viewer.owner) === 1) return null;
  const body = await deps.readJson(request.clone(), 4000);
  if (body.error) return deps.json(403, { error: "owner_only" });
  let input = "";
  for (const name of route.field) {
    if (body[name]) { input = String(body[name]); break; }
  }
  if (route.prefix && input && !/^https?:\/\//i.test(input) && input.indexOf(":") < 0) input = route.prefix + input.replace(/^@/, "");
  const made = await fileRequest(env, viewer, { input, kind: route.kind, note: body.note || "" }, deps);
  if (made.status !== 200) return deps.json(made.status === 400 ? 403 : made.status, Object.assign({ owner_only: true }, made.body));
  return deps.json(403, { error: "owner_only", requested: true, request: made.body.request || null, message: "Only the owner adds new sources. Your request was sent." });
}

/* Anonymous newsletter reads of a banned newsletter stop at the Worker. */
export async function newsletterBanned(env, key) {
  const text = String(key || "").toLowerCase();
  if (!/^[a-z0-9-]{3,60}$/.test(text)) return false;
  return bannedKeys(env, ["news:" + text]);
}
