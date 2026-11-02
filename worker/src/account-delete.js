/* Self-service account deletion.
   One job row tracks the wipe until every step has finished. The cron
   resumes anything left behind. After the job is done, the only lasting
   public record is a salted hash of the account id.

   Tables audited against migrations 0001–0021 and the runtime schema:
   accounts, sessions, sync_state (feed settings, groups, drafts, likes,
   bookmarks, resume and history), rate_limits, account_reposts,
   account_follows (both directions), drive_vault, drive_items, drive_chunks,
   community_posts, community_likes, community_members, community_notes,
   account_friend_requests, account_friends, account_federation,
   account_identities, identity_challenges, vault_configs, vault_items,
   vault_shares, owner_keys, owner_key_items, owner_key_pace, account_reauths,
   account_presence, account_status, channel_tickets, notifications,
   notification_state, notification_bells, push_subscriptions, push_log,
   webauthn_credentials, webauthn_challenges, account_blocks,
   account_mutes, account_follow_requests, account_content,
   account_messages, mentions, notification_prefs, notification_events,
   notification_outbox, notification_tab_reads, discord_alert_prefs,
   discord_alert_hits, and the native server tables (srv_*). notification_dead stores a salted hash only.
   push_vapid is the one global key and has no account column. The account
   channel object is wiped in the same database step. telegram_files is a
   shared media index with no account column, so the generic sweep skips it;
   forgetTelegram drops the rows for this account's own files instead, and
   queues their message ids so the next Telegram backup run deletes them from
   the channel. There is no invites table. */

import { inspectHandle, ownerHandle, ownerSkeleton } from "../../shared/handle-skeleton.js";
import { wipeAccountChannel } from "./channel.js";

const encoder = new TextEncoder();
const DAY_MS = 24 * 60 * 60 * 1000;
const REAUTH_MS = 5 * 60 * 1000;
const JOB_KEEP_MS = DAY_MS;
const USER_COLUMNS = ["public_id", "follower_id", "target_id", "sender_id", "receiver_id", "user_id", "friend_id", "author_id", "owner_id", "recipient_id", "requester_id", "blocker_id", "blocked_id", "muter_id", "muted_id"];
const SKIP_TABLES = new Set(["account_deletion_jobs", "account_deletions", "handle_holds", "rate_limits", "telegram_files", "sqlite_sequence"]);
const ID_FIELDS = ["publicId", "public_id", "userId", "user_id", "authorId", "author_id", "followerId", "follower_id", "accountId", "account_id", "senderId", "sender_id", "recipientId", "recipient_id", "ownerId", "owner_id"];
const PUBLISH_KEYS = ["people.json", "feeds.json", "feeds.config.json", "suggestions.json", "follows.json", "data/follows.json"];
const OBJECT_PREFIXES = ["media/avatars/", "media/banners/", "uploads/", "exports/", "users/", "accounts/", "highlights/", "stories/library/", "stories/app/"];

export const DELETION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account_deletion_jobs (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL DEFAULT '',
    user_hash TEXT NOT NULL,
    handle TEXT NOT NULL DEFAULT '',
    skeleton TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    steps TEXT NOT NULL,
    resume_hash TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS account_deletion_jobs_user ON account_deletion_jobs(public_id) WHERE public_id != ''",
  "CREATE INDEX IF NOT EXISTS account_deletion_jobs_status ON account_deletion_jobs(status, updated_at)",
  "CREATE TABLE IF NOT EXISTS account_deletions (user_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS handle_holds (skeleton TEXT PRIMARY KEY, held_until INTEGER NOT NULL, user_hash TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS account_reauths (token_hash TEXT PRIMARY KEY, public_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS account_reauths_account ON account_reauths(public_id, expires_at)",
  "CREATE TABLE IF NOT EXISTS account_inactivity (public_id TEXT PRIMARY KEY, months INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS inactivity_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)"
];

/* Inactivity auto-delete. Each account picks 1, 3, 6 or 12 months (default 1).
   The sweep only runs when the INACTIVITY_DELETE var is "on", and the clock
   never starts before the first armed sweep, so turning it on does not delete
   anyone retroactively. The owner account is never touched. */
export const INACTIVITY_MONTHS = [1, 3, 6, 12];
const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;
const INACTIVITY_BATCH = 5;

export function cleanMonths(value) {
  const n = Number(value);
  return INACTIVITY_MONTHS.indexOf(n) >= 0 ? n : 0;
}

export function inactivityArmed(env) {
  return String((env && env.INACTIVITY_DELETE) || "").trim().toLowerCase() === "on";
}

export function inactiveDue(lastActive, armedAt, months, now) {
  const from = Math.max(Number(lastActive) || 0, Number(armedAt) || 0);
  if (!from || !cleanMonths(months)) return false;
  return now - from > cleanMonths(months) * MONTH_MS;
}

async function lastActiveOf(env, publicId) {
  const row = await env.DB.prepare(
    `SELECT MAX(
       COALESCE((SELECT MAX(last_beat, last_seen) FROM account_presence WHERE public_id = ?1), 0),
       COALESCE((SELECT MAX(created_at) FROM sessions WHERE public_id = ?1), 0),
       COALESCE((SELECT updated_at FROM sync_state WHERE public_id = ?1), 0),
       COALESCE((SELECT updated_at FROM account_inactivity WHERE public_id = ?1), 0),
       COALESCE((SELECT created_at FROM accounts WHERE public_id = ?1), 0)
     ) AS at`
  ).bind(publicId).first().catch(() => null);
  return Number(row && row.at) || 0;
}

export async function handleInactivity(request, env, deps) {
  const session = await deps.sessionAccount(env, request);
  if (!session) return jsonBody(deps, 401, { error: "unauthorized" });
  const owner = await ownerProtected(env, session);
  if (request.method === "PUT" || request.method === "POST") {
    const paced = await deps.rateHit(env, "inactivity:" + session.public_id, 30, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 1000);
    if (body.error) return jsonBody(deps, 400, { error: body.error });
    const months = cleanMonths(body.months);
    if (!months) return jsonBody(deps, 400, { error: "months" });
    await env.DB.prepare("INSERT INTO account_inactivity (public_id, months, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET months = excluded.months, updated_at = excluded.updated_at").bind(session.public_id, months, Date.now()).run();
  } else if (request.method !== "GET") {
    return jsonBody(deps, 405, { error: "method" });
  }
  const row = await env.DB.prepare("SELECT months FROM account_inactivity WHERE public_id = ?").bind(session.public_id).first();
  return jsonBody(deps, 200, { months: cleanMonths(row && row.months) || 1, options: INACTIVITY_MONTHS, owner: !!owner });
}

export async function sweepInactive(env, now) {
  if (!inactivityArmed(env)) return { armed: false, started: 0 };
  const at = Number(now) || Date.now();
  let start = await env.DB.prepare("SELECT v FROM inactivity_meta WHERE k = 'armed_at'").first();
  if (!start) {
    await env.DB.prepare("INSERT OR IGNORE INTO inactivity_meta (k, v) VALUES ('armed_at', ?)").bind(at).run();
    return { armed: true, started: 0 };
  }
  const armedAt = Number(start.v) || at;
  if (at - armedAt <= MONTH_MS) return { armed: true, started: 0 };
  // One page of accounts per hour, walking created_at so every account gets
  // checked over time without a heavy query on each cron tick.
  const meta = rowsOf(await env.DB.prepare("SELECT k, v FROM inactivity_meta WHERE k IN ('last_sweep', 'cursor')").all());
  const metaOf = (key) => Number((meta.find((row) => row.k === key) || {}).v) || 0;
  if (at - metaOf("last_sweep") < 60 * 60 * 1000) return { armed: true, started: 0 };
  const cursor = metaOf("cursor");
  const listed = await env.DB.prepare(
    `SELECT a.public_id, a.handle, a.skeleton, a.owner, a.created_at, COALESCE(i.months, 1) AS months
       FROM accounts a LEFT JOIN account_inactivity i ON i.public_id = a.public_id
      WHERE a.owner = 0 AND a.created_at > ?
        AND NOT EXISTS (SELECT 1 FROM account_deletion_jobs j WHERE j.public_id = a.public_id)
      ORDER BY a.created_at ASC LIMIT 100`
  ).bind(cursor).all();
  const page = rowsOf(listed);
  const next = page.length < 100 ? 0 : Number(page[page.length - 1].created_at) || 0;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO inactivity_meta (k, v) VALUES ('last_sweep', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(at),
    env.DB.prepare("INSERT INTO inactivity_meta (k, v) VALUES ('cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(next)
  ]);
  let started = 0;
  for (const row of page) {
    if (started >= INACTIVITY_BATCH) break;
    if (await ownerProtected(env, row)) continue;
    const last = await lastActiveOf(env, row.public_id);
    if (!inactiveDue(last, armedAt, row.months, at)) continue;
    const hash = await userHash(env, row.public_id);
    if (!hash) break;
    const job = await startJob(env, row, hash);
    if (!job) continue;
    started += 1;
    try { await runJob(env, job, {}); }
    catch (err) { await saveJob(env, job, parseSteps(job.steps), "pending", "retry"); }
  }
  return { armed: true, started };
}

function bytesToB64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}

function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return hex(new Uint8Array(sig));
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
}

function rowsOf(result) {
  return (result && result.results) || [];
}

function safeName(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ""));
}

function blankSteps() {
  return { sessions: false, database: false, objects: false, publish: false };
}

function parseSteps(value) {
  const steps = blankSteps();
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object") return steps;
    steps.sessions = !!parsed.sessions;
    steps.database = !!parsed.database;
    steps.objects = !!parsed.objects;
    steps.publish = !!parsed.publish;
  } catch (err) { /* a broken row starts again */ }
  return steps;
}

function saltOf(env) {
  return String((env && (env.DELETION_SALT || env.ACCOUNT_PEPPER)) || "");
}

export function holdDays(env) {
  const raw = env && env.HANDLE_HOLD_DAYS;
  if (raw == null || raw === "") return 30;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3650, Math.floor(n));
}

export async function userHash(env, publicId) {
  const salt = saltOf(env);
  const id = String(publicId || "");
  if (!salt || !/^\d{12}$/.test(id)) return "";
  return hmacHex(salt, "account-delete:" + id);
}

function timingEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ownerIdHashes(env) {
  const parts = [];
  if (env && env.OWNER_ID_SHA256) parts.push(String(env.OWNER_ID_SHA256));
  if (env && env.OWNER_GITHUB_SHA256) parts.push(String(env.OWNER_GITHUB_SHA256));
  return parts.join(",").split(/[\s,]+/).map((item) => item.trim().toLowerCase()).filter((item) => /^[a-f0-9]{64}$/.test(item));
}

async function matchesOwnerId(env, value) {
  const hashes = ownerIdHashes(env);
  const text = String(value || "");
  if (!hashes.length || !text) return false;
  const digest = await sha256Hex(text);
  return hashes.some((expected) => timingEqual(digest, expected));
}

export async function ownerProtected(env, row) {
  if (!row) return true;
  if (Number(row.owner) === 1) return true;
  const id = String(row.public_id || row.publicId || "");
  const handle = String(row.handle || "");
  if (id === "emergency_owner") return true;
  const configuredHandle = ownerHandle();
  if (configuredHandle && timingEqual(handle, configuredHandle)) return true;
  const checked = inspectHandle(handle);
  if (checked && checked.owner) return true;
  const skel = String(row.skeleton || "");
  if (skel && ownerSkeleton() && skel === ownerSkeleton()) return true;
  if (await matchesOwnerId(env, handle) || await matchesOwnerId(env, id)) return true;
  const configured = String((env && env.OWNER_PUBLIC_ID) || "").trim();
  if (configured && (timingEqual(id, configured) || timingEqual(handle, configured))) return true;
  return false;
}

function originOk(request, env, deps) {
  const origin = request.headers.get("Origin") || "";
  if (!origin) return false;
  const allowed = deps && deps.allowedOrigins ? deps.allowedOrigins(env) : [];
  return allowed.indexOf(origin) >= 0;
}

function intentOk(request, expected) {
  return (request.headers.get("X-Viktorych-Intent") || "") === expected;
}

function jsonBody(deps, status, body, extra) {
  return deps.json(status, body, extra);
}

export async function handleHeld(env, skeleton) {
  const key = String(skeleton || "");
  if (!key) return false;
  const row = await env.DB.prepare("SELECT held_until FROM handle_holds WHERE skeleton = ?").bind(key).first();
  if (!row) return false;
  if (Number(row.held_until) <= Date.now()) {
    await env.DB.prepare("DELETE FROM handle_holds WHERE skeleton = ?").bind(key).run();
    return false;
  }
  return true;
}

function isPublicId(value) {
  return /^\d{12}$/.test(String(value || ""));
}

function appId(value) {
  const match = /^app:(\d{12})$/.exec(String(value || ""));
  return match ? match[1] : "";
}

function collectIds(value, into) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === "string") {
        const id = appId(item);
        if (id) into.add(id);
      } else collectIds(item, into);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const direct = [value.id, value.followId, value.targetId, value.target_id];
  for (let i = 0; i < direct.length; i++) {
    const id = appId(direct[i]);
    if (id) into.add(id);
  }
  for (let i = 0; i < ID_FIELDS.length; i++) {
    const key = ID_FIELDS[i];
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const raw = value[key];
    const id = appId(raw) || (isPublicId(raw) ? String(raw) : "");
    if (id) into.add(id);
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) collectIds(value[keys[i]], into);
}

export function referencesDeleted(value, hashes, hashOf) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.userHash === "string" && hashes.has(value.userHash)) return true;
  const direct = [value.id, value.followId, value.targetId, value.target_id];
  for (let i = 0; i < direct.length; i++) {
    const id = appId(direct[i]);
    if (id && hashes.has(hashOf(id))) return true;
  }
  for (let i = 0; i < ID_FIELDS.length; i++) {
    const key = ID_FIELDS[i];
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const raw = value[key];
    const id = appId(raw) || (isPublicId(raw) ? String(raw) : "");
    if (id && hashes.has(hashOf(id))) return true;
  }
  return false;
}

export function scrubValue(value, hashes, hashOf) {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === "string") {
        const id = appId(item);
        if (id && hashes.has(hashOf(id))) continue;
        out.push(item);
        continue;
      }
      const next = scrubValue(item, hashes, hashOf);
      if (next == null) continue;
      out.push(next);
    }
    return out;
  }
  if (!value || typeof value !== "object") return value;
  if (referencesDeleted(value, hashes, hashOf)) return null;
  const out = {};
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const next = scrubValue(value[key], hashes, hashOf);
    if (next == null && value[key] && typeof value[key] === "object") continue;
    out[key] = next;
  }
  return out;
}

async function hashMap(env, ids) {
  const map = new Map();
  for (const id of ids) map.set(id, await userHash(env, id));
  return map;
}

async function deletionHashes(env) {
  const listed = await env.DB.prepare("SELECT user_hash FROM account_deletions ORDER BY user_hash").all();
  const hashes = [];
  for (const row of rowsOf(listed)) {
    const hash = String(row.user_hash || "");
    if (/^[0-9a-f]{64}$/.test(hash)) hashes.push(hash);
  }
  return hashes;
}

async function scrubDocument(env, value) {
  const ids = new Set();
  collectIds(value, ids);
  const known = new Set(await deletionHashes(env));
  const mapped = await hashMap(env, ids);
  return scrubValue(value, known, (id) => mapped.get(id) || "");
}

function columnsFromSql(sql) {
  const text = String(sql || "");
  const open = text.indexOf("(");
  if (open < 0) return [];
  const cols = [];
  let depth = 0;
  let current = "";
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) {
      cols.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) cols.push(current.trim());
  const names = [];
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    if (/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(col)) continue;
    const match = /^["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/.exec(col);
    if (match) names.push(match[1]);
  }
  return names;
}

function bucketHasId(bucket, publicId) {
  const parts = String(bucket || "").split(":");
  return parts.indexOf(publicId) >= 0 || parts.indexOf("app:" + publicId) >= 0;
}

async function saveJob(env, job, steps, status, error) {
  job.steps = JSON.stringify(steps);
  job.status = status;
  job.error = error || "";
  job.updated_at = Date.now();
  await env.DB.prepare("UPDATE account_deletion_jobs SET status = ?, steps = ?, error = ?, updated_at = ? WHERE id = ?").bind(status, job.steps, job.error, job.updated_at, job.id).run();
}

async function ensureResume(env, job) {
  const token = "dr1." + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await sha256Hex(token);
  job.resume_hash = hash;
  await env.DB.prepare("UPDATE account_deletion_jobs SET resume_hash = ? WHERE id = ?").bind(hash, job.id).run();
  return token;
}

async function deletePrefix(bucket, prefix) {
  if (!bucket || !bucket.list) return;
  let cursor = undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 200 });
    const objects = (listed && listed.objects) || [];
    for (let i = 0; i < objects.length; i++) {
      if (objects[i] && objects[i].key) await bucket.delete(objects[i].key);
    }
    cursor = listed && listed.truncated ? listed.cursor : "";
  } while (cursor);
}

/* Post photos and videos live under post-media/ with no account in the key.
   Their keys are read from D1 before the rows go, and the objects are
   removed first, so a resumed job never leaves media behind. */
async function wipePostMedia(env, publicId) {
  if (!env.DATA || !/^\d{12}$/.test(publicId)) return;
  const still = await env.DB.prepare("SELECT public_id, handle, skeleton, owner FROM accounts WHERE public_id = ?").bind(publicId).first();
  if (still && await ownerProtected(env, still)) return;
  let listed = null;
  try {
    listed = await env.DB.prepare("SELECT m.object_key FROM public_post_media m JOIN public_posts p ON p.id = m.post_id WHERE p.author_id = ?").bind(publicId).all();
  } catch (err) { return; }
  const keys = rowsOf(listed).map((row) => String(row.object_key || "")).filter((key) => /^post-media\/[A-Za-z0-9._-]+$/.test(key));
  try { await forgetTelegram(env, publicId, keys); }
  catch (err) { /* R2 and D1 are still wiped; a resumed job tries again */ }
  for (let i = 0; i < keys.length; i++) await env.DATA.delete(keys[i]);
}

/* The Telegram backup copies uploads, avatars, banners, and stories. When an
   account goes, its rows leave telegram_files (so no route can serve them),
   and the message ids are written to backup/tg-forget/ for the backup job,
   which holds the channel id, to delete from the channel. */
export const TG_FORGET_PREFIX = "backup/tg-forget/";
export function telegramPrefixes(publicId) {
  if (!/^\d{12}$/.test(String(publicId || ""))) return [];
  return OBJECT_PREFIXES.map((prefix) => prefix + publicId + "/");
}

/* The first key after every key that starts with prefix (binary order). */
export function prefixEnd(prefix) {
  const text = String(prefix || "");
  if (!text) return "";
  return text.slice(0, -1) + String.fromCharCode(text.charCodeAt(text.length - 1) + 1);
}

export async function forgetTelegram(env, publicId, postKeys) {
  if (!env.DB || !env.DATA) return 0;
  const prefixes = telegramPrefixes(publicId);
  if (!prefixes.length) return 0;
  const found = [];
  const select = "SELECT object_key, message_id FROM telegram_files WHERE ";
  for (let i = 0; i < prefixes.length; i++) {
    let listed = null;
    // A key range walks the primary key; substr() read every row of the table.
    try { listed = await env.DB.prepare(select + "object_key >= ? AND object_key < ?").bind(prefixes[i], prefixEnd(prefixes[i])).all(); }
    catch (err) { return 0; }
    rowsOf(listed).forEach((row) => found.push(row));
  }
  const exact = (postKeys || []).filter((key) => /^post-media\/[A-Za-z0-9._-]+$/.test(String(key || "")));
  for (let i = 0; i < exact.length; i += 50) {
    const chunk = exact.slice(i, i + 50);
    let listed = null;
    try { listed = await env.DB.prepare(select + "object_key IN (" + chunk.map(() => "?").join(",") + ")").bind(...chunk).all(); }
    catch (err) { listed = null; }
    rowsOf(listed).forEach((row) => found.push(row));
  }
  if (!found.length) return 0;
  const keys = Array.from(new Set(found.map((row) => String(row.object_key || "")).filter(Boolean)));
  const messages = Array.from(new Set(found.map((row) => Number(row.message_id) || 0).filter((id) => id > 0)));
  await env.DATA.put(TG_FORGET_PREFIX + publicId + "-" + Date.now() + ".json", JSON.stringify({ v: 1, keys: keys, messages: messages, at: Date.now() }), {
    httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" }
  });
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    await env.DB.prepare("DELETE FROM telegram_files WHERE object_key IN (" + chunk.map(() => "?").join(",") + ")").bind(...chunk).run();
  }
  return keys.length;
}

async function wipeObjects(env, publicId) {
  if (!env.DATA || !/^\d{12}$/.test(publicId)) return;
  for (let i = 0; i < OBJECT_PREFIXES.length; i++) {
    await deletePrefix(env.DATA, OBJECT_PREFIXES[i] + publicId + "/");
  }
}

async function wipeDatabase(env, job) {
  const publicId = String(job.public_id || "");
  const handle = String(job.handle || "");
  if (!/^\d{12}$/.test(publicId)) return;
  const still = await env.DB.prepare("SELECT public_id, handle, skeleton, owner FROM accounts WHERE public_id = ?").bind(publicId).first();
  if (still && await ownerProtected(env, still)) {
    const err = new Error("owner_protected");
    err.code = "owner_protected";
    throw err;
  }
  const statements = [];
  const push = (sql, ...args) => {
    statements.push(env.DB.prepare(sql).bind(...args));
  };
  push("DELETE FROM drive_chunks WHERE item_id IN (SELECT id FROM drive_items WHERE public_id = ?)", publicId);
  push("DELETE FROM vault_shares WHERE item_id IN (SELECT id FROM vault_items WHERE owner_id = ?)", publicId);
  push("DELETE FROM community_likes WHERE item_id IN (SELECT id FROM community_posts WHERE author_id = ?)", publicId);
  const tables = rowsOf(await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all());
  // Post media rows carry only the post id. They go with the author's posts.
  if (tables.some((t) => t.name === "public_post_media") && tables.some((t) => t.name === "public_posts")) {
    push("DELETE FROM public_post_media WHERE post_id IN (SELECT id FROM public_posts WHERE author_id = ?)", publicId);
  }
  if (tables.some((t) => t.name === "srv_members")) {
    // Native servers key memberships by account_id; reactions use the member id.
    push("DELETE FROM srv_reactions WHERE mid IN (SELECT mid FROM srv_members WHERE account_id = ?)", publicId);
    push("DELETE FROM srv_member_roles WHERE account_id = ?", publicId);
    push("DELETE FROM srv_reads WHERE account_id = ?", publicId);
    push("DELETE FROM srv_notify WHERE account_id = ?", publicId);
    push("DELETE FROM srv_bans WHERE account_id = ?", publicId);
    if (tables.some((t) => t.name === "srv_threads")) {
      // Threads and events outlive their starter, like other people's replies.
      push("UPDATE srv_threads SET owner_id = '', owner_mid = '' WHERE owner_id = ?", publicId);
      push("UPDATE srv_events SET creator_id = '', creator_mid = '' WHERE creator_id = ?", publicId);
      push("DELETE FROM srv_poll_votes WHERE account_id = ?", publicId);
      push("DELETE FROM srv_event_rsvps WHERE account_id = ?", publicId);
      push("UPDATE srv_events SET going = (SELECT COUNT(*) FROM srv_event_rsvps r WHERE r.event_id = srv_events.id AND r.status = 'going'), interested = (SELECT COUNT(*) FROM srv_event_rsvps r WHERE r.event_id = srv_events.id AND r.status = 'interested') WHERE server_id IN (SELECT server_id FROM srv_members WHERE account_id = ?)", publicId);
    }
    push("UPDATE srv_servers SET member_count = member_count - 1 WHERE id IN (SELECT server_id FROM srv_members WHERE account_id = ?)", publicId);
    push("DELETE FROM srv_members WHERE account_id = ?", publicId);
  }
  for (let i = 0; i < tables.length; i++) {
    const name = String(tables[i].name || "");
    if (!safeName(name) || SKIP_TABLES.has(name)) continue;
    const cols = columnsFromSql(tables[i].sql);
    if (name === "accounts") {
      push("DELETE FROM accounts WHERE public_id = ? AND owner != 1", publicId);
      continue;
    }
    for (let c = 0; c < USER_COLUMNS.length; c++) {
      const col = USER_COLUMNS[c];
      if (!safeName(col) || cols.indexOf(col) < 0) continue;
      if (col === "target_id") push("DELETE FROM " + name + " WHERE target_id = ? OR target_id = ?", publicId, "app:" + publicId);
      else push("DELETE FROM " + name + " WHERE " + col + " = ?", publicId);
    }
  }
  const limits = rowsOf(await env.DB.prepare("SELECT bucket FROM rate_limits WHERE instr(bucket, ?) > 0").bind(publicId).all());
  for (let i = 0; i < limits.length; i++) {
    if (bucketHasId(limits[i].bucket, publicId)) push("DELETE FROM rate_limits WHERE bucket = ?", limits[i].bucket);
  }
  const days = holdDays(env);
  if (days > 0 && job.skeleton && job.user_hash) {
    push(
      "INSERT INTO handle_holds (skeleton, held_until, user_hash) VALUES (?, ?, ?) ON CONFLICT(skeleton) DO UPDATE SET held_until = excluded.held_until, user_hash = excluded.user_hash",
      job.skeleton,
      Date.now() + days * DAY_MS,
      job.user_hash
    );
  }
  if (job.user_hash) {
    push(
      "INSERT INTO account_deletions (user_hash, created_at) VALUES (?, ?) ON CONFLICT(user_hash) DO NOTHING",
      job.user_hash,
      Date.now()
    );
  }
  if (statements.length) await env.DB.batch(statements);
  const left = await env.DB.prepare("SELECT owner FROM accounts WHERE public_id = ?").bind(publicId).first();
  if (left && Number(left.owner) === 1) {
    const err = new Error("owner_protected");
    err.code = "owner_protected";
    throw err;
  }
}

async function writeDeletionList(env) {
  if (!env.DATA) return;
  const hashes = await deletionHashes(env);
  await env.DATA.put("deletions.json", JSON.stringify({ hashes }));
}

async function scrubKey(env, key) {
  if (!env.DATA || key === "deletions.json") return;
  const object = await env.DATA.get(key);
  if (!object) return;
  let parsed = null;
  try { parsed = JSON.parse(await object.text()); }
  catch (err) { return; }
  const next = await scrubDocument(env, parsed);
  await env.DATA.put(key, JSON.stringify(next));
}

async function publishDeletion(env) {
  await writeDeletionList(env);
  if (!env.DATA) return;
  const seen = new Set();
  for (let i = 0; i < PUBLISH_KEYS.length; i++) seen.add(PUBLISH_KEYS[i]);
  let cursor = undefined;
  do {
    const listed = await env.DATA.list({ prefix: "follows/", cursor, limit: 100 });
    const objects = (listed && listed.objects) || [];
    for (let i = 0; i < objects.length; i++) {
      if (objects[i] && /\.json$/.test(objects[i].key || "")) seen.add(objects[i].key);
    }
    cursor = listed && listed.truncated ? listed.cursor : "";
  } while (cursor);
  for (const key of seen) await scrubKey(env, key);
  await writeDeletionList(env);
}

async function runJob(env, job, opts) {
  const steps = parseSteps(job.steps);
  const publicId = String(job.public_id || "");
  // Sessions and rows are swept again on every resume. A step that already
  // finished can still have picked up a write that landed before the token died.
  if (publicId) {
    await env.DB.prepare("DELETE FROM sessions WHERE public_id = ?").bind(publicId).run();
    try { await env.DB.prepare("DELETE FROM device_keys WHERE public_id = ?").bind(publicId).run(); } catch (err) { /* no device asked for a key yet */ }
    steps.sessions = true;
    await wipePostMedia(env, publicId);
    await wipeDatabase(env, job);
    try { await wipeAccountChannel(env, publicId); }
    catch (err) { /* the rows are already gone; the next run closes the object */ }
    steps.database = true;
    await saveJob(env, job, steps, "running", "");
  }
  const failStep = opts && opts.failStep;
  if (failStep === "objects" && !steps.objects) {
    await saveJob(env, job, steps, "pending", "retry");
    const resumeToken = await ensureResume(env, job);
    return { status: "pending", steps, resumeToken };
  }
  if (!steps.objects) {
    if (publicId) await wipeObjects(env, publicId);
    steps.objects = true;
    await saveJob(env, job, steps, "running", "");
  }
  if (!steps.publish) {
    await publishDeletion(env);
    steps.publish = true;
    await saveJob(env, job, steps, "running", "");
  }
  const now = Date.now();
  await env.DB.prepare("UPDATE account_deletion_jobs SET public_id = '', handle = '', skeleton = '', status = 'done', steps = ?, error = '', updated_at = ? WHERE id = ?").bind(JSON.stringify(steps), now, job.id).run();
  job.public_id = "";
  job.handle = "";
  job.skeleton = "";
  job.status = "done";
  return { status: "complete", steps };
}

function publicResult(result) {
  const body = {
    ok: true,
    status: result.status,
    deletion: result.status,
    steps: result.steps
  };
  if (result.already) body.already = true;
  if (result.status === "pending" && result.resumeToken) body.resumeToken = result.resumeToken;
  return body;
}

async function loadJob(env, id) {
  return env.DB.prepare("SELECT id, public_id, user_hash, handle, skeleton, status, steps, resume_hash, error, created_at, updated_at FROM account_deletion_jobs WHERE id = ?").bind(id).first();
}

async function startJob(env, row, hash) {
  const existing = await env.DB.prepare("SELECT id FROM account_deletion_jobs WHERE public_id = ? AND status != 'done'").bind(row.public_id).first();
  if (existing) return loadJob(env, existing.id);
  const id = "del_" + hex(crypto.getRandomValues(new Uint8Array(16)));
  const now = Date.now();
  const steps = JSON.stringify(blankSteps());
  try {
    await env.DB.prepare("INSERT INTO account_deletion_jobs (id, public_id, user_hash, handle, skeleton, status, steps, resume_hash, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'running', ?, '', '', ?, ?)").bind(
      id,
      row.public_id,
      hash,
      row.handle || "",
      row.skeleton || "",
      steps,
      now,
      now
    ).run();
  } catch (err) {
    const message = String(err && err.message || err);
    if (!/UNIQUE/i.test(message)) throw err;
    const raced = await env.DB.prepare("SELECT id FROM account_deletion_jobs WHERE public_id = ? AND status != 'done'").bind(row.public_id).first();
    if (raced) return loadJob(env, raced.id);
    throw err;
  }
  return loadJob(env, id);
}

function failStepOf(request, env) {
  if (String(env && env.DELETION_TEST_HOOK || "") !== "1") return "";
  const step = request.headers.get("x-deletion-fail") || "";
  return step === "objects" ? step : "";
}

async function resumeWithToken(request, env, deps, token) {
  const hash = await sha256Hex(String(token || ""));
  const job = await env.DB.prepare("SELECT id, public_id, user_hash, handle, skeleton, status, steps, resume_hash, error, created_at, updated_at FROM account_deletion_jobs WHERE resume_hash = ?").bind(hash).first();
  if (!job) return jsonBody(deps, 404, { error: "not_found" });
  if (job.status === "done") {
    return jsonBody(deps, 200, { ok: true, status: "complete", deletion: "complete", already: true, steps: parseSteps(job.steps) });
  }
  try {
    const result = await runJob(env, job, { failStep: failStepOf(request, env) });
    return jsonBody(deps, 200, publicResult(result));
  } catch (err) {
    if (err && err.code === "owner_protected") return jsonBody(deps, 403, { error: "owner_protected" });
    return jsonBody(deps, 503, { error: "unavailable" });
  }
}

export async function handleAccountReauth(request, env, deps) {
  if (request.method !== "POST") return jsonBody(deps, 405, { error: "method" });
  if (!originOk(request, env, deps) || !intentOk(request, "account-reauth")) return jsonBody(deps, 403, { error: "origin" });
  const type = String(request.headers.get("content-type") || "");
  if (type.indexOf("application/json") !== 0) return jsonBody(deps, 415, { error: "content_type" });
  const ip = clientIp(request);
  const gate = await deps.rateHit(env, "reauth-ip:" + ip, 12, 60 * 60 * 1000);
  if (!gate.ok) return deps.limited(gate);
  const session = await deps.sessionAccount(env, request);
  if (!session) return jsonBody(deps, 401, { error: "unauthorized" });
  if (await ownerProtected(env, session)) return jsonBody(deps, 403, { error: "owner_protected" });
  const paced = await deps.rateHit(env, "reauth:" + session.public_id, 8, 60 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const body = await deps.readJson(request, 2000);
  if (body.error) return jsonBody(deps, 400, { error: body.error });
  const row = await env.DB.prepare("SELECT public_id, handle, skeleton, owner, number_hash, salt FROM accounts WHERE public_id = ?").bind(session.public_id).first();
  if (!row) return jsonBody(deps, 401, { error: "unauthorized" });
  if (await ownerProtected(env, row)) return jsonBody(deps, 403, { error: "owner_protected" });
  const ok = await deps.verifyAccountNumber(env, row, body.accountNumber);
  if (!ok) return jsonBody(deps, 401, { error: "invalid_credentials" });
  const token = "ra1." + b64url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256Hex(token);
  const expires = Date.now() + REAUTH_MS;
  await env.DB.prepare("INSERT INTO account_reauths (token_hash, public_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, row.public_id, expires).run();
  return jsonBody(deps, 200, { ok: true, reauthToken: token, expiresAt: expires });
}

async function consumeReauth(env, publicId, token) {
  const text = String(token || "");
  if (!text || text.length > 200) return false;
  const hash = await sha256Hex(text);
  const row = await env.DB.prepare("SELECT public_id, expires_at FROM account_reauths WHERE token_hash = ?").bind(hash).first();
  await env.DB.prepare("DELETE FROM account_reauths WHERE token_hash = ?").bind(hash).run();
  if (!row) return false;
  if (String(row.public_id) !== String(publicId)) return false;
  return Number(row.expires_at) > Date.now();
}

export async function handleAccountDelete(request, env, deps) {
  if (request.method !== "POST") return jsonBody(deps, 405, { error: "method" });
  if (!originOk(request, env, deps) || !intentOk(request, "account-delete")) return jsonBody(deps, 403, { error: "origin" });
  const type = String(request.headers.get("content-type") || "");
  if (type.indexOf("application/json") !== 0) return jsonBody(deps, 415, { error: "content_type" });
  if (!saltOf(env)) return jsonBody(deps, 503, { error: "not_configured" });
  const ip = clientIp(request);
  const ipGate = await deps.rateHit(env, "acct-del-ip:" + ip, 20, 60 * 60 * 1000);
  if (!ipGate.ok) return deps.limited(ipGate);
  const body = await deps.readJson(request, 4000);
  if (body.error) return jsonBody(deps, 400, { error: body.error });
  if (body.resumeToken && !body.handle && !body.accountNumber) {
    return resumeWithToken(request, env, deps, body.resumeToken);
  }
  const session = await deps.sessionAccount(env, request);
  if (!session) return jsonBody(deps, 401, { error: "unauthorized" });
  if (await ownerProtected(env, session)) return jsonBody(deps, 403, { error: "owner_protected" });
  const paced = await deps.rateHit(env, "acct-del:" + session.public_id, 8, 60 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const row = await env.DB.prepare("SELECT public_id, handle, skeleton, owner, number_hash, salt FROM accounts WHERE public_id = ?").bind(session.public_id).first();
  if (!row) return jsonBody(deps, 401, { error: "unauthorized" });
  if (await ownerProtected(env, row)) return jsonBody(deps, 403, { error: "owner_protected" });
  const typed = String(body.handle || "").trim().replace(/^@/, "");
  if (!typed || typed !== row.handle) return jsonBody(deps, 400, { error: "handle_mismatch" });
  let proven = false;
  if (body.accountNumber) proven = await deps.verifyAccountNumber(env, row, body.accountNumber);
  else if (body.reauthToken) proven = await consumeReauth(env, row.public_id, body.reauthToken);
  if (!proven) return jsonBody(deps, 401, { error: "invalid_credentials" });
  const hash = await userHash(env, row.public_id);
  if (!hash) return jsonBody(deps, 503, { error: "not_configured" });
  const job = await startJob(env, row, hash);
  if (!job) return jsonBody(deps, 503, { error: "unavailable" });
  try {
    const result = await runJob(env, job, { failStep: failStepOf(request, env) });
    return jsonBody(deps, 200, publicResult(result));
  } catch (err) {
    if (err && err.code === "owner_protected") return jsonBody(deps, 403, { error: "owner_protected" });
    await saveJob(env, job, parseSteps(job.steps), "pending", "retry");
    const resumeToken = await ensureResume(env, job);
    return jsonBody(deps, 200, publicResult({ status: "pending", steps: parseSteps(job.steps), resumeToken }));
  }
}

export async function handleDeletionList(request, env, deps) {
  if (request.method !== "GET") return jsonBody(deps, 405, { error: "method" });
  const gate = await deps.rateHit(env, "acct-del-list:" + clientIp(request), 120, 10 * 60 * 1000);
  if (!gate.ok) return deps.limited(gate);
  const hashes = await deletionHashes(env);
  return jsonBody(deps, 200, { hashes });
}

/* Delete one account by id with no sign-in proof. Only the temporary
   account sweep and its "delete now" route call this. The owner is refused
   here and again inside the database step. */
export async function deleteAccountById(env, publicId) {
  const id = String(publicId || "");
  if (!/^\d{12}$/.test(id)) return { status: "invalid" };
  const row = await env.DB.prepare("SELECT public_id, handle, skeleton, owner FROM accounts WHERE public_id = ?").bind(id).first();
  if (!row) return { status: "gone" };
  if (await ownerProtected(env, row)) return { status: "owner_protected" };
  let hash = await userHash(env, id);
  if (!hash) hash = hex(crypto.getRandomValues(new Uint8Array(32)));
  const job = await startJob(env, row, hash);
  if (!job) return { status: "pending" };
  try {
    return await runJob(env, job, {});
  } catch (err) {
    if (err && err.code === "owner_protected") return { status: "owner_protected" };
    await saveJob(env, job, parseSteps(job.steps), "pending", "retry");
    return { status: "pending", steps: parseSteps(job.steps) };
  }
}

export async function blockDeletedLogin(env, publicId) {
  const existing = await env.DB.prepare("SELECT id FROM account_deletion_jobs WHERE public_id = ? AND status != 'done'").bind(publicId).first();
  if (!existing) return false;
  const job = await loadJob(env, existing.id);
  if (!job) return false;
  try { await runJob(env, job, {}); }
  catch (err) { /* the cron finishes a leftover */ }
  return true;
}

export async function resumeAccountDeletions(env) {
  const now = Date.now();
  await env.DB.prepare("DELETE FROM handle_holds WHERE held_until <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM account_reauths WHERE expires_at <= ?").bind(now).run();
  await env.DB.prepare("DELETE FROM account_deletion_jobs WHERE status = 'done' AND updated_at <= ?").bind(now - JOB_KEEP_MS).run();
  const listed = await env.DB.prepare("SELECT id FROM account_deletion_jobs WHERE status != 'done' ORDER BY updated_at ASC LIMIT 20").all();
  for (const row of rowsOf(listed)) {
    const job = await loadJob(env, row.id);
    if (!job) continue;
    try { await runJob(env, job, {}); }
    catch (err) {
      await saveJob(env, job, parseSteps(job.steps), "pending", "retry");
    }
  }
}
