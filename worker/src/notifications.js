import { eachLimit } from "./limit.js";
/* Account notifications.
   D1 is the source of truth: items, the read cursor, tab settings, bells,
   and one push subscription per device. Open pages hear changes on the
   existing AccountChannel topic "notifications". There is no second
   Durable Object and no replay log. A hidden page is not connected and
   is not polled. A page that reconnects reads D1.

   Read state only moves forward. An item id is stable. A second write with
   the same idempotency key does not change the time, does not clear read,
   and does not send a second push. */

import { inspectHandle } from "../../shared/handle-skeleton.js";
import { tiktokNoteHidden, visibleNotes } from "../../shared/tiktok-lock.js";
import { publishToAccount } from "./channel.js";
import { visibleAvatarUrl } from "./profile-media.js";
import { tiktokAudienceAll, unlockedHandles } from "./tiktok-unlock.js";
import { actorHidden, canMention } from "./social.js";
import { viewerDisplay } from "./name-rules.js";
import { lockedAccountSet, notLocked } from "./locked-sql.js";

const encoder = new TextEncoder();
const KINDS = { post: 1, mention: 1, reply: 1, quote: 1, like: 1, repost: 1, follow: 1, follow_request: 1, follow_accept: 1, friend_request: 1, friend_accept: 1, dm: 1, discord: 1, live: 1, birthday: 1, birthday_self: 1, gift: 1, package: 1, game_invite: 1, tv_signin: 1, community_note: 1, feed_request: 1, feed_approved: 1, feed_rejected: 1 };
const PREF_KINDS = ["mentions", "replies", "quotes", "likes", "reposts", "follows", "dms", "games"];
const DEFAULT_PREFS = { mentions: "push", replies: "push", quotes: "push", likes: "inapp", reposts: "inapp", follows: "push", dms: "push", games: "push", mentionsFrom: "all" };
const BACKOFF_MS = [2000, 10000, 60000, 300000, 1800000];
const DEAD_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE_WINDOW_MS = 6 * 60 * 60 * 1000;
const NOTE_CAP = 200;

export const NOTIFICATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notifications (
    public_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    read_at INTEGER NOT NULL DEFAULT 0,
    actor_id TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    pushed_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, note_id)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS notifications_idem ON notifications(public_id, idempotency_key)",
  "CREATE INDEX IF NOT EXISTS notifications_time ON notifications(public_id, at DESC)",
  "CREATE INDEX IF NOT EXISTS notifications_recent ON notifications(public_id, at DESC, note_id)",
  "CREATE INDEX IF NOT EXISTS notifications_updated ON notifications(public_id, updated_at)",
  `CREATE TABLE IF NOT EXISTS notification_state (
    public_id TEXT PRIMARY KEY,
    read_until INTEGER NOT NULL DEFAULT 0,
    tabs TEXT NOT NULL DEFAULT '',
    bells_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notification_bells (
    public_id TEXT NOT NULL,
    feed_key TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT '',
    since INTEGER NOT NULL DEFAULT 0,
    handle TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    ids TEXT NOT NULL DEFAULT '',
    handles TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, feed_key)
  )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    public_id TEXT NOT NULL,
    endpoint_hash TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    ua TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (public_id, endpoint_hash)
  )`,
  "CREATE TABLE IF NOT EXISTS push_vapid (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_jwk TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS push_log (id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT NOT NULL, note_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS notification_prefs (
    public_id TEXT PRIMARY KEY,
    prefs TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notification_events (
    public_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    note_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (public_id, event_key)
  )`,
  `CREATE TABLE IF NOT EXISTS notification_outbox (
    delivery_id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(next_at)",
  `CREATE TABLE IF NOT EXISTS notification_dead (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_hash TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS notification_dead_time ON notification_dead(created_at)",
  `CREATE TABLE IF NOT EXISTS notification_tab_reads (
    public_id TEXT NOT NULL,
    tab_id TEXT NOT NULL,
    read_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (public_id, tab_id)
  )`
];

let schemaReady = null;

function bytesToB64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}

function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlToBytes(text) {
  const pad = "=".repeat((4 - (text.length % 4)) % 4);
  const b64 = (String(text || "") + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
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

function clip(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, max);
}

function httpsUrl(value) {
  const text = clip(value, 400);
  return /^https:\/\//.test(text) ? text : "";
}

async function addLockColumns(env) {
  const alters = [
    "ALTER TABLE push_subscriptions ADD COLUMN shorts_locked INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE push_subscriptions ADD COLUMN push_fmt INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE notification_state ADD COLUMN shorts_locked INTEGER NOT NULL DEFAULT 1"
  ];
  for (let i = 0; i < alters.length; i++) {
    try { await env.DB.prepare(alters[i]).run(); }
    catch (err) {
      const msg = String(err && err.message || err);
      if (!/duplicate column|already exists/i.test(msg)) throw err;
    }
  }
}

export function ensureNotificationSchema(env) {
  if (!env || !env.DB) return Promise.resolve();
  if (!schemaReady) {
    schemaReady = env.DB.batch(NOTIFICATION_SCHEMA.map((sql) => env.DB.prepare(sql))).then(() => addLockColumns(env)).catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export function mergeNotificationItems(local, remote, readUntil) {
  const map = new Map();
  const until = Number(readUntil) || 0;
  function take(item, fromServer) {
    if (!item || !item.id) return;
    const id = clip(item.id, 160);
    if (!id) return;
    const at = Number(item.at) || 0;
    const read = item.read === true || !!(until && at > 0 && at <= until);
    const prev = map.get(id);
    if (!prev) {
      map.set(id, Object.assign({}, item, { id, at, read, lockAt: !!fromServer }));
      return;
    }
    const atKept = prev.lockAt ? prev.at : (fromServer ? at : (prev.at || at));
    map.set(id, Object.assign({}, prev, item, {
      id,
      at: atKept,
      read: !!(prev.read || read),
      lockAt: !!(prev.lockAt || fromServer)
    }));
  }
  (Array.isArray(remote) ? remote : []).forEach((item) => take(item, true));
  (Array.isArray(local) ? local : []).forEach((item) => take(item, false));
  return Array.from(map.values()).sort((a, b) => (b.at - a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function mergeNoteTabs(local, remote) {
  const map = new Map();
  function take(tab) {
    if (!tab || !tab.id) return;
    const id = String(tab.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!id) return;
    const updatedAt = Number(tab.updatedAt) || 0;
    const deletedAt = Number(tab.deletedAt) || 0;
    const readAt = Number(tab.readAt) || 0;
    const prev = map.get(id);
    if (!prev) {
      map.set(id, Object.assign({}, tab, { id, updatedAt, deletedAt, readAt }));
      return;
    }
    const newer = updatedAt >= prev.updatedAt ? tab : prev;
    map.set(id, Object.assign({}, prev, newer, {
      id,
      updatedAt: Math.max(updatedAt, prev.updatedAt),
      deletedAt: Math.max(deletedAt, prev.deletedAt),
      readAt: Math.max(readAt, prev.readAt)
    }));
  }
  (Array.isArray(remote) ? remote : []).forEach(take);
  (Array.isArray(local) ? local : []).forEach(take);
  return Array.from(map.values());
}

function cleanKind(value) {
  const kind = String(value || "");
  return KINDS[kind] ? kind : "";
}

function cleanTabs(list) {
  return mergeNoteTabs(Array.isArray(list) ? list : [], []).slice(0, 500);
}

function stateTabs(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      tabs: cleanTabs(parsed.tabs),
      noteTabsSame: parsed.noteTabsSame === false ? false : true,
      lastNoteTab: clip(parsed.lastNoteTab || "all", 40) || "all"
    };
  } catch (err) {
    return null;
  }
}

async function readState(env, publicId) {
  const row = await env.DB.prepare("SELECT read_until, tabs, bells_at, updated_at FROM notification_state WHERE public_id = ?").bind(publicId).first();
  return {
    readUntil: Number(row && row.read_until) || 0,
    tabs: stateTabs(row && row.tabs),
    bellsAt: Number(row && row.bells_at) || 0,
    updatedAt: Number(row && row.updated_at) || 0
  };
}

async function writeReadUntil(env, publicId, until) {
  const now = Date.now();
  const next = Math.max(0, Number(until) || 0);
  await env.DB.prepare(
    "INSERT INTO notification_state (public_id, read_until, tabs, bells_at, updated_at) VALUES (?, ?, '', 0, ?) ON CONFLICT(public_id) DO UPDATE SET read_until = MAX(notification_state.read_until, excluded.read_until), updated_at = excluded.updated_at"
  ).bind(publicId, next, now).run();
}

function legacyMedia(value) {
  return /\/v1\/media\/(?:avatars|banners)\/\d{12}\//.test(String(value || "")) || /^media\/(?:avatars|banners)\/\d{12}\//.test(String(value || ""));
}

/* Notification links must not carry 12-digit account IDs, so a trailing
   12-digit run is cut from the link. Live links and the values of internal
   invite and pairing parameters (?invite=, ?code=) are random tokens, not
   account IDs: cutting them broke the link, so they are left alone. */
const NOTE_HASH_KEEP = /^(invite|code)$/;
export function scrubNoteHash(hash) {
  const text = String(hash || "");
  if (text.startsWith("#/live/")) return text;
  const cut = (part) => part.replace(/([A-Za-z0-9_\u0400-\u04FF]{1,32})\d{12}\b/g, "$1");
  const q = text.indexOf("?");
  if (q < 0) return cut(text);
  const query = text.slice(q + 1).split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq > 0 && NOTE_HASH_KEEP.test(pair.slice(0, eq))) return pair;
    return cut(pair);
  }).join("&");
  return cut(text.slice(0, q)) + "?" + query;
}

async function presentNote(env, request, viewer, item) {
  const next = Object.assign({}, item);
  next.actorId = "";
  if (legacyMedia(next.avatar)) next.avatar = "";
  if (legacyMedia(next.image)) next.image = "";
  const feed = String(next.feedId || "");
  const match = /^app:(\d{12})$/.exec(feed);
  if (match) {
    const row = await env.DB.prepare("SELECT handle FROM accounts WHERE public_id = ?").bind(match[1]).first();
    next.feedId = row && row.handle ? "app:@" + row.handle : "";
  }
  if (legacyMedia(next.hash) || /\d{12}/.test(String(next.hash || ""))) next.hash = scrubNoteHash(next.hash);
  if (next.handle && request && viewer) {
    const shown = await visibleAvatarUrl(env, request, viewer, next.handle);
    if (shown === null) {
      if (legacyMedia(next.avatar)) next.avatar = "";
    } else next.avatar = shown || "";
  }
  if (legacyMedia(next.avatar)) next.avatar = "";
  return next;
}

function itemFromRow(row, readUntil) {
  let extra = {};
  try { extra = JSON.parse(row.payload || "{}"); }
  catch (err) { extra = {}; }
  if (!extra || typeof extra !== "object") extra = {};
  const at = Number(row.at) || 0;
  const read = Number(row.read_at) > 0 || !!(readUntil && at > 0 && at <= readUntil);
  return {
    id: row.note_id,
    kind: cleanKind(row.kind) || "post",
    at,
    read,
    handle: clip(extra.handle, 80).replace(/^@/, ""),
    name: clip(extra.name, 80),
    text: clip(extra.text, 280),
    avatar: httpsUrl(extra.avatar),
    image: httpsUrl(extra.image),
    hash: String(extra.hash || "#/").charAt(0) === "#" ? clip(extra.hash, 300) : "#/",
    feedId: clip(extra.feedId, 120),
    platform: clip(extra.platform, 24),
    verified: extra.verified === true,
    mention: extra.mention === true || row.kind === "mention",
    others: Math.max(0, Number(extra.others) || 0),
    ids: Array.isArray(extra.ids) ? extra.ids.map((id) => clip(id, 120)).filter(Boolean).slice(0, 12) : [],
    handles: Array.isArray(extra.handles) ? extra.handles.map((id) => clip(id, 120).toLowerCase()).filter(Boolean).slice(0, 24) : [],
    expiresAt: Math.max(0, Number(extra.expiresAt) || 0),
    actorId: clip(row.actor_id, 16)
  };
}

function lockFlag(value) {
  if (value === 0 || value === false || value === "0") return false;
  if (value === 1 || value === true || value === "1") return true;
  return null;
}

async function writeShortsLocked(env, publicId, locked) {
  const flag = locked ? 1 : 0;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO notification_state (public_id, read_until, tabs, bells_at, updated_at, shorts_locked) VALUES (?, 0, '', 0, ?, ?) ON CONFLICT(public_id) DO UPDATE SET shorts_locked = excluded.shorts_locked, updated_at = excluded.updated_at"
  ).bind(publicId, now, flag).run();
}

/* The Shorts lock is per device. The account row remembers the last
   report so a channel update can leave a locked item out. A missing
   report stays locked, matching the Shorts default. */
async function lockViewer(env, publicId, lockedOverride) {
  const account = await accountRow(env, publicId);
  const owner = !!(account && (account.owner === 1 || account.owner === true));
  let locked = true;
  const chosen = lockFlag(lockedOverride);
  if (chosen === false) locked = false;
  else if (chosen === true) locked = true;
  else {
    try {
      const row = await env.DB.prepare("SELECT shorts_locked FROM notification_state WHERE public_id = ?").bind(publicId).first();
      if (row && (row.shorts_locked === 0 || row.shorts_locked === false)) locked = false;
      else if (row && (row.shorts_locked === 1 || row.shorts_locked === true)) locked = true;
    } catch (err) { locked = true; }
  }
  let list = [];
  try { list = await unlockedHandles(env); }
  catch (err) { list = []; }
  const unlocked = new Set((list || []).map((name) => String(name || "").toLowerCase()));
  return { owner: owner, audienceAll: tiktokAudienceAll(env), locked: locked, unlocked: unlocked };
}

async function unreadCount(env, publicId, readUntil, viewer) {
  const view = viewer || await lockViewer(env, publicId);
  const listed = await env.DB.prepare(
    "SELECT note_id, kind, at, read_at, actor_id, payload FROM notifications WHERE public_id = ? AND read_at = 0 AND at > ? ORDER BY at DESC LIMIT 200"
  ).bind(publicId, readUntil).all();
  const prefs = await readPrefs(env, publicId);
  const follows = await followedActorSet(env, publicId);
  const items = ((listed && listed.results) || []).map((row) => itemFromRow(row, readUntil));
  const held = await lockedAccountSet(env, publicId);
  const visible = items.filter((item) => !item.read && !held.has(item.actorId) && prefVisible(prefs, item, !!follows[item.actorId]) && !tiktokNoteHidden(item, view));
  const kept = await dropHiddenNotes(env, publicId, visible);
  return kept.length;
}

async function listBells(env, publicId) {
  const listed = await env.DB.prepare(
    "SELECT feed_key, mode, since, handle, name, ids, handles, updated_at FROM notification_bells WHERE public_id = ? AND deleted_at = 0"
  ).bind(publicId).all();
  const bells = {};
  ((listed && listed.results) || []).forEach((row) => {
    if (!row || (row.mode !== "all" && row.mode !== "live")) return;
    let ids = [];
    let handles = [];
    try { ids = JSON.parse(row.ids || "[]"); } catch (err) { ids = []; }
    try { handles = JSON.parse(row.handles || "[]"); } catch (err) { handles = []; }
    bells[row.feed_key] = {
      mode: row.mode,
      since: Number(row.since) || 0,
      updatedAt: Number(row.updated_at) || 0,
      handle: row.handle || "",
      name: row.name || "",
      ids: Array.isArray(ids) ? ids : [],
      handles: Array.isArray(handles) ? handles : []
    };
  });
  return bells;
}

async function followedActorSet(env, publicId) {
  const listed = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ?" + notLocked("account_follows") + " LIMIT 500"
  ).bind(publicId).all();
  const set = {};
  ((listed && listed.results) || []).forEach((row) => {
    const id = String(row && row.target_id || "");
    if (id.indexOf("app:") === 0) set[id.slice(4)] = true;
  });
  return set;
}

async function viewFor(env, publicId, since, lockedOverride, request) {
  const state = await readState(env, publicId);
  const prefs = await readPrefs(env, publicId);
  const follows = await followedActorSet(env, publicId);
  const viewer = await lockViewer(env, publicId, lockedOverride);
  const mediaViewer = { public_id: publicId };
  const sinceN = Number(since) || 0;
  const listed = sinceN
    ? await env.DB.prepare(
      "SELECT note_id, kind, at, read_at, actor_id, payload, updated_at FROM notifications WHERE public_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT 80"
    ).bind(publicId, sinceN).all()
    : await env.DB.prepare(
      "SELECT note_id, kind, at, read_at, actor_id, payload, updated_at FROM notifications WHERE public_id = ? ORDER BY at DESC, note_id ASC LIMIT 200"
    ).bind(publicId).all();
  const raw = (listed && listed.results) || [];
  const items = [];
  const held = await lockedAccountSet(env, publicId);
  let cursor = sinceN;
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    const at = Number(row.updated_at) || Number(row.at) || 0;
    if (at > cursor) cursor = at;
    const item = itemFromRow(row, state.readUntil);
    // Notes from a locked follow are held for the Locked area.
    if (item.actorId && held.has(item.actorId)) continue;
    if (!prefVisible(prefs, item, !!follows[item.actorId])) continue;
    if (tiktokNoteHidden(item, viewer)) continue;
    if (await actorHidden(env, publicId, item.actorId)) continue;
    items.push(await presentNote(env, request, mediaViewer, item));
  }
  if (!sinceN) {
    const maxRow = await env.DB.prepare(
      "SELECT MAX(updated_at) AS n FROM notifications WHERE public_id = ?"
    ).bind(publicId).first();
    cursor = Math.max(cursor, Number(maxRow && maxRow.n) || 0);
  }
  const unread = await unreadCount(env, publicId, state.readUntil, viewer);
  const bells = await listBells(env, publicId);
  const push = await vapidPublic(env);
  return {
    items: sinceN ? items : items.slice(0, 80),
    unread,
    readUntil: state.readUntil,
    cursor,
    more: !!(sinceN && raw.length === 80),
    prefs,
    tabs: state.tabs ? state.tabs.tabs : null,
    noteTabsSame: state.tabs ? state.tabs.noteTabsSame : null,
    lastNoteTab: state.tabs ? state.tabs.lastNoteTab : null,
    bells,
    bellsAt: state.bellsAt,
    updatedAt: state.updatedAt,
    push: { configured: !!push.publicKey, publicKey: push.publicKey || "" }
  };
}

async function trimNotes(env, publicId) {
  const extra = await env.DB.prepare(
    "SELECT note_id FROM notifications WHERE public_id = ? ORDER BY at DESC LIMIT 40 OFFSET ?"
  ).bind(publicId, NOTE_CAP).all();
  const rows = (extra && extra.results) || [];
  for (let i = 0; i < rows.length; i++) {
    await env.DB.prepare("DELETE FROM notifications WHERE public_id = ? AND note_id = ? AND read_at > 0").bind(publicId, rows[i].note_id).run();
  }
}

function payloadOf(input) {
  return JSON.stringify({
    handle: clip(input.handle, 80).replace(/^@/, ""),
    name: clip(input.name, 80),
    text: clip(input.text, 280),
    avatar: httpsUrl(input.avatar),
    image: httpsUrl(input.image),
    hash: String(input.hash || "#/").charAt(0) === "#" ? clip(input.hash, 300) : "#/",
    feedId: clip(input.feedId, 120),
    platform: clip(input.platform, 24),
    verified: input.verified === true,
    mention: input.mention === true,
    others: Math.max(0, Number(input.others) || 0),
    actors: Array.isArray(input.actors) ? input.actors.slice(0, 12).map((actor) => ({
      name: clip(actor && actor.name, 80),
      handle: clip(actor && actor.handle, 80).replace(/^@/, "")
    })) : [],
    ids: Array.isArray(input.ids) ? input.ids.map((id) => clip(id, 120)).filter(Boolean).slice(0, 12) : [],
    handles: Array.isArray(input.handles) ? input.handles.map((id) => clip(id, 120).toLowerCase()).filter(Boolean).slice(0, 24) : [],
    expiresAt: Math.max(0, Number(input.expiresAt) || 0)
  });
}

/* Do not disturb. A parallel change may set presence on the account row
   or a dndUntil on the notification state. Either one skips the buzz.
   The in-app list and the other devices still update. */
export function pushSuppressed(row, now) {
  if (!row) return false;
  const at = Number(now) || Date.now();
  if (row.presence === "dnd" || row.dnd === 1 || row.do_not_disturb === 1) return true;
  const until = Number(row.dnd_until || row.dndUntil || 0);
  return !!(until && until > at);
}

async function accountRow(env, publicId) {
  try {
    return await env.DB.prepare("SELECT * FROM accounts WHERE public_id = ?").bind(publicId).first();
  } catch (err) {
    return null;
  }
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export async function encryptPush(payload, clientKeyB64, authB64) {
  const clientPublic = b64urlToBytes(clientKeyB64);
  const auth = b64urlToBytes(authB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const remote = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, local.privateKey, 256));
  const info = new Uint8Array(encoder.encode("WebPush: info\0").length + clientPublic.length + localPublic.length);
  info.set(encoder.encode("WebPush: info\0"), 0);
  info.set(clientPublic, encoder.encode("WebPush: info\0").length);
  info.set(localPublic, encoder.encode("WebPush: info\0").length + clientPublic.length);
  const ikm = await hkdf(auth, shared, info, 32);
  const cekBytes = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const padded = new Uint8Array(payload.length + 1);
  padded.set(payload, 0);
  padded[payload.length] = 2;
  const cek = await crypto.subtle.importKey("raw", cekBytes, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cek, padded));
  const header = new Uint8Array(21 + localPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = localPublic.length;
  header.set(localPublic, 21);
  const body = new Uint8Array(header.length + cipher.length);
  body.set(header, 0);
  body.set(cipher, header.length);
  return body;
}

export async function decryptPush(body, clientPrivate, authB64) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const idlen = bytes[20];
  const localPublic = bytes.slice(21, 21 + idlen);
  const cipher = bytes.slice(21 + idlen);
  const auth = b64urlToBytes(authB64);
  const remote = await crypto.subtle.importKey("raw", localPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, clientPrivate, 256));
  const clientPublic = new Uint8Array(await crypto.subtle.exportKey("raw", clientPrivate instanceof CryptoKey ? (await crypto.subtle.exportKey("raw", (await clientPublicOf(clientPrivate)))) : clientPrivate));
  return decryptWithKeys(salt, localPublic, cipher, auth, shared, clientPublic);
}

async function clientPublicOf(privateKey) {
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  delete jwk.d;
  jwk.key_ops = [];
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []);
}

async function decryptWithKeys(salt, localPublic, cipher, auth, shared, clientPublic) {
  const info = new Uint8Array(encoder.encode("WebPush: info\0").length + clientPublic.length + localPublic.length);
  info.set(encoder.encode("WebPush: info\0"), 0);
  info.set(clientPublic, encoder.encode("WebPush: info\0").length);
  info.set(localPublic, encoder.encode("WebPush: info\0").length + clientPublic.length);
  const ikm = await hkdf(auth, shared, info, 32);
  const cekBytes = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const cek = await crypto.subtle.importKey("raw", cekBytes, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cek, cipher));
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end -= 1;
  if (!end || plain[end - 1] !== 2) throw new Error("bad_padding");
  return plain.slice(0, end - 1);
}

export async function pushRoundTrip(text) {
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPush(encoder.encode(text), b64url(raw), b64url(auth));
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const serverPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const remote = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: remote }, local.privateKey, 256));
  const plain = await decryptWithKeys(salt, serverPublic, cipher, auth, shared, raw);
  return new TextDecoder().decode(plain);
}

async function vapidPublic(env) {
  if (env && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK) {
    return { publicKey: String(env.VAPID_PUBLIC_KEY), privateJwk: String(env.VAPID_PRIVATE_JWK) };
  }
  const row = await env.DB.prepare("SELECT public_key, private_jwk FROM push_vapid WHERE id = 1").first();
  if (row && row.public_key && row.private_jwk) return { publicKey: row.public_key, privateJwk: row.private_jwk };
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", key.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey));
  const publicKey = b64url(raw);
  await env.DB.prepare(
    "INSERT INTO push_vapid (id, public_key, private_jwk, created_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
  ).bind(publicKey, privateJwk, Date.now()).run();
  const saved = await env.DB.prepare("SELECT public_key, private_jwk FROM push_vapid WHERE id = 1").first();
  return { publicKey: saved.public_key, privateJwk: saved.private_jwk };
}

async function vapidJwt(endpoint, publicKey, privateJwk) {
  let jwk = null;
  try { jwk = JSON.parse(privateJwk); }
  catch (err) { return ""; }
  const header = b64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: "mailto:notifications@viktorych.app"
  })));
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(header + "." + payload)));
  return header + "." + payload + "." + b64url(sig);
}

async function publishNotes(env, publicId, data) {
  try { await publishToAccount(env, publicId, "notifications", data, publicId); }
  catch (err) { /* D1 stays the source of truth if the channel is down */ }
}

async function sendPush(env, publicId, item, viewer) {
  const account = await accountRow(env, publicId) || {};
  try {
    const presence = await env.DB.prepare("SELECT preference FROM account_presence WHERE public_id = ?").bind(publicId).first();
    if (presence && presence.preference) account.presence = presence.preference;
  } catch (err) { /* presence is optional; the in-app list still updates */ }
  if (pushSuppressed(account, Date.now())) return { ok: true, skipped: true };
  // No push for a locked follow: the note waits in the Locked area.
  if (item && item.actorId && (await lockedAccountSet(env, publicId)).has(String(item.actorId))) return { ok: true, skipped: true };
  const keys = await vapidPublic(env);
  if (!keys.publicKey || !keys.privateJwk) return { ok: true, skipped: true };
  const subs = await env.DB.prepare(
    "SELECT endpoint_hash, endpoint, p256dh, auth, shorts_locked, push_fmt FROM push_subscriptions WHERE public_id = ? LIMIT 10"
  ).bind(publicId).all();
  const rows = (subs && subs.results) || [];
  const base = viewer || await lockViewer(env, publicId);
  const titleKey = titleKeyFor(item);
  if (!titleKey) return { ok: true, skipped: true };
  // Devices on the new service worker get the compact payload: kind, a
  // content-addressed short id and a count. No names, text, links or icons.
  const compact = encoder.encode(JSON.stringify(await compactPush(item)));
  const payload = encoder.encode(JSON.stringify({
    titleKey,
    titleVars: {
      name: item.name || (item.handle ? "@" + item.handle : "Someone"),
      handle: item.handle || "",
      n: String(item.others || 0)
    },
    body: item.text || "",
    hash: item.hash || "#/",
    id: item.id,
    icon: legacyMedia(item.avatar) ? "" : (item.avatar || ""),
    tag: "note-" + item.id,
    platform: item.platform || "",
    handle: item.handle || "",
    feedId: /^app:\d{12}$/.test(String(item.feedId || "")) ? "" : (item.feedId || "")
  }));
  let failed = false;
  for (let i = 0; i < rows.length; i++) {
    const sub = rows[i];
    const deviceLocked = sub.shorts_locked == null || sub.shorts_locked === "" ? true : Number(sub.shorts_locked) !== 0;
    if (tiktokNoteHidden(item, Object.assign({}, base, { locked: deviceLocked }))) continue;
    try {
      const jwt = await vapidJwt(sub.endpoint, keys.publicKey, keys.privateJwk);
      const body = await encryptPush(Number(sub.push_fmt) === 2 ? compact : payload, sub.p256dh, sub.auth);
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-encoding": "aes128gcm",
          authorization: "vapid t=" + jwt + ", k=" + keys.publicKey,
          ttl: "86400",
          urgency: "normal"
        },
        body
      });
      if (res && (res.status === 404 || res.status === 410)) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE public_id = ? AND endpoint_hash = ?").bind(publicId, sub.endpoint_hash).run();
      } else if (res && res.status >= 500) failed = true;
      if (env.PUSH_SINK === "d1") {
        await env.DB.prepare("INSERT INTO push_log (public_id, note_id, created_at) VALUES (?, ?, ?)").bind(publicId, item.id, Date.now()).run();
      }
    } catch (err) {
      failed = true;
      if (env.PUSH_SINK === "d1") {
        await env.DB.prepare("INSERT INTO push_log (public_id, note_id, created_at) VALUES (?, ?, ?)").bind(publicId, item.id, Date.now()).run();
      }
    }
  }
  return { ok: !failed || !rows.length, skipped: !rows.length };
}

// The compact push: {v:2,k:kind,i:shortId,n:count}. The short id is the
// first 9 bytes of SHA-256 over the note id (12 base64url characters), so a
// device can match it against its own cache without the id itself travelling.
export async function compactPush(item) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String((item && item.id) || ""))));
  const out = { v: 2, k: clip(item && item.kind, 24), i: b64url(digest.slice(0, 9)) };
  const others = Number(item && item.others) || 0;
  if (others > 0) out.n = others;
  return out;
}
const CN_TITLES = ["Your Community Note is now showing", "Readers added context to your post", "Readers added context to a post you interacted with"];

function titleKeyFor(item) {
  const kind = item && item.kind;
  const others = Number(item && item.others) || 0;
  if (kind === "like" && others > 0) return "{name} and {n} others liked your post";
  if (kind === "like") return "{name} liked your post";
  if (kind === "repost" && others > 0) return "{name} and {n} others reposted your post";
  if (kind === "repost") return "{name} reposted your post";
  if (kind === "quote") return "{name} quoted your post";
  if (kind === "reply") return "{name} replied to you";
  if (kind === "mention") return "{name} mentioned you";
  if (kind === "dm") return "{name} sent you a message";
  if (kind === "discord") return "Discord alert";
  if (kind === "follow") return "{name} followed you";
  if (kind === "follow_request") return "{name} requested to follow you";
  if (kind === "follow_accept") return "{name} accepted your follow request";
  if (kind === "friend_request") return "{name} sent you a friend request";
  if (kind === "friend_accept") return "{name} accepted your friend request";
  if (kind === "live") return "{name} is live";
  if (kind === "birthday") return "It's {name}'s birthday today";
  if (kind === "birthday_self") return "Happy birthday";
  if (kind === "package") return "Package update: {name}";
  if (kind === "gift" && !(item && item.actorId)) return "You received a gift";
  if (kind === "gift") return "{name} sent you a gift";
  if (kind === "game_invite") return "{name} invited you to play";
  if (kind === "community_note") return CN_TITLES.indexOf(item && item.text) >= 0 ? item.text : CN_TITLES[2];
  if (kind === "tv_signin") return "Approve sign-in on TV?";
  if (kind === "feed_request") return "Source request: {name}";
  if (kind === "feed_approved") return "Source request approved: {name}";
  if (kind === "feed_rejected") return "Source request not approved: {name}";
  return "New post notifications for @{handle}";
}

export function nextBackoff(attempts) {
  const n = Math.max(0, Number(attempts) || 0);
  return BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)];
}

function prefKind(kind) {
  if (kind === "mention") return "mentions";
  if (kind === "reply") return "replies";
  if (kind === "quote") return "quotes";
  if (kind === "like") return "likes";
  if (kind === "repost") return "reposts";
  if (kind === "follow" || kind === "follow_request" || kind === "follow_accept" || kind === "friend_request" || kind === "friend_accept") return "follows";
  if (kind === "dm") return "dms";
  if (kind === "game_invite") return "games";
  return "";
}

export async function readPrefs(env, publicId) {
  const row = await env.DB.prepare("SELECT prefs FROM notification_prefs WHERE public_id = ?").bind(publicId).first();
  let parsed = {};
  try { parsed = JSON.parse((row && row.prefs) || "{}"); }
  catch (err) { parsed = {}; }
  if (!parsed || typeof parsed !== "object") parsed = {};
  const out = Object.assign({}, DEFAULT_PREFS);
  PREF_KINDS.forEach((key) => {
    if (parsed[key] === "off" || parsed[key] === "inapp" || parsed[key] === "push") out[key] = parsed[key];
  });
  if (parsed.mentionsFrom === "following" || parsed.mentionsFrom === "all") out.mentionsFrom = parsed.mentionsFrom;
  return out;
}

async function savePrefs(env, publicId, raw) {
  const next = await readPrefs(env, publicId);
  PREF_KINDS.forEach((key) => {
    if (raw[key] === "off" || raw[key] === "inapp" || raw[key] === "push") next[key] = raw[key];
  });
  if (raw.mentionsFrom === "following" || raw.mentionsFrom === "all") next.mentionsFrom = raw.mentionsFrom;
  await env.DB.prepare(
    "INSERT INTO notification_prefs (public_id, prefs, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at"
  ).bind(publicId, JSON.stringify(next), Date.now()).run();
  return next;
}

async function followsActor(env, publicId, actorId) {
  if (!/^\d{12}$/.test(String(actorId || ""))) return false;
  const row = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(publicId, "app:" + actorId).first();
  return !!row;
}

function modeFor(prefs, kind, followOk) {
  const key = prefKind(kind);
  if (!key) return kind === "discord" ? "push" : "push";
  const mode = prefs[key] || "push";
  if (mode === "off") return "store";
  if (kind === "mention" && prefs.mentionsFrom === "following" && !followOk) return "store";
  return mode;
}

function prefVisible(prefs, item, followOk) {
  const key = prefKind(item && item.kind);
  if (!key) return true;
  if ((prefs[key] || "push") === "off") return false;
  if (item.kind === "mention" && prefs.mentionsFrom === "following" && !followOk) return false;
  return true;
}

async function maskPublic(env, publicId) {
  return (await sha256Hex(String((env && env.ACCOUNT_PEPPER) || "notes") + ":" + String(publicId || ""))).slice(0, 16);
}

async function deadLetter(env, publicId, kind, reason) {
  const code = clip(reason, 40).replace(/[^a-z0-9_:-]/gi, "") || "push_failed";
  await env.DB.prepare(
    "INSERT INTO notification_dead (public_hash, kind, reason, created_at) VALUES (?, ?, ?, ?)"
  ).bind(await maskPublic(env, publicId), clip(kind, 24) || "note", code, Date.now()).run();
  logSafe(code);
}

function logSafe(code) {
  try {
    console.error(JSON.stringify({ at: "worker", area: "notes", code: String(code || "push_failed").slice(0, 40) }));
  } catch (err) { /* logging must not throw */ }
}

function outboxStatement(env, publicId, noteId, deliveryId, nextAt) {
  const now = Date.now();
  return env.DB.prepare(
    "INSERT INTO notification_outbox (delivery_id, public_id, note_id, attempts, next_at, created_at) VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(delivery_id) DO NOTHING"
  ).bind(deliveryId, publicId, noteId, nextAt || now, now);
}

async function planPlain(env, input) {
  const publicId = String(input && input.publicId || "");
  const kind = cleanKind(input && input.kind);
  const key = clip(input && input.idempotencyKey, 160);
  if (!/^\d{12}$/.test(publicId) || !kind || !key) return null;
  const actorId = String(input.actorId || "");
  if (/^\d{12}$/.test(actorId)) {
    try {
      if (await actorHidden(env, publicId, actorId)) return null;
    } catch (err) { /* a schema miss must not drop the note */ }
  }
  const now = Date.now();
  const at = Number(input.at) > 0 ? Number(input.at) : now;
  const subject = clip(input.subject || input.handle || "", 80).replace(/^@/, "").toLowerCase();
  if (kind === "live" && subject) {
    const recent = await env.DB.prepare(
      "SELECT note_id FROM notifications WHERE public_id = ? AND kind = 'live' AND subject = ? AND at > ?"
    ).bind(publicId, subject, at - LIVE_WINDOW_MS).first();
    if (recent) return { created: false, id: recent.note_id, statements: [], deliveries: [] };
  }
  const existing = await env.DB.prepare(
    "SELECT note_id FROM notifications WHERE public_id = ? AND idempotency_key = ?"
  ).bind(publicId, key).first();
  if (existing) return { created: false, id: existing.note_id, statements: [], deliveries: [] };
  const prefs = await readPrefs(env, publicId);
  const followOk = kind === "mention" ? await followsActor(env, publicId, input.actorId) : true;
  const mode = modeFor(prefs, kind, followOk);
  const state = await readState(env, publicId);
  const readAt = state.readUntil && at <= state.readUntil ? at : 0;
  const quietUntil = Number(input.quietUntil) || 0;
  const payload = payloadOf(input);
  const statements = [
    env.DB.prepare(
      "INSERT INTO notifications (public_id, note_id, kind, at, read_at, actor_id, subject, idempotency_key, payload, updated_at, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(public_id, note_id) DO NOTHING"
    ).bind(publicId, key, kind, at, readAt, clip(input.actorId, 16), subject, key, payload, now, 0)
  ];
  const item = itemFromRow({
    note_id: key, kind, at, read_at: readAt, actor_id: clip(input.actorId, 16), payload
  }, state.readUntil);
  const deliveryId = "d:" + key;
  const deliveries = [];
  // An invite that expires in minutes is worth nothing after quiet hours,
  // so the caller can keep it in the app only.
  if (!readAt && mode === "push" && input.noPush === true) {
    deliveries.push({ mode: "inapp", publicId, item, deliveryId: "", readUntil: state.readUntil });
  } else if (!readAt && mode === "push" && quietUntil > now) {
    statements.push(outboxStatement(env, publicId, key, deliveryId, quietUntil));
    deliveries.push({ mode: "inapp", publicId, item, deliveryId: "", readUntil: state.readUntil });
  } else if (!readAt && mode === "push") {
    statements.push(outboxStatement(env, publicId, key, deliveryId, now));
    deliveries.push({ mode: "push", publicId, item, deliveryId, readUntil: state.readUntil });
  } else if (!readAt && mode === "inapp") {
    deliveries.push({ mode: "inapp", publicId, item, deliveryId: "", readUntil: state.readUntil });
  }
  return { created: true, id: key, statements, deliveries };
}

async function planGrouped(env, input) {
  const publicId = String(input && input.publicId || "");
  const kind = cleanKind(input && input.kind);
  const groupKey = clip(input && input.groupKey, 160);
  const eventKey = clip(input && input.idempotencyKey, 160);
  if (!/^\d{12}$/.test(publicId) || !kind || !groupKey || !eventKey) return null;
  const actorId = String(input.actorId || "");
  if (/^\d{12}$/.test(actorId)) {
    try {
      if (await actorHidden(env, publicId, actorId)) return null;
    } catch (err) { /* a schema miss must not drop the note */ }
  }
  const have = await env.DB.prepare(
    "SELECT note_id FROM notification_events WHERE public_id = ? AND event_key = ?"
  ).bind(publicId, eventKey).first();
  if (have) return { created: false, id: have.note_id, statements: [], deliveries: [] };
  const existing = await env.DB.prepare(
    "SELECT payload, read_at FROM notifications WHERE public_id = ? AND note_id = ?"
  ).bind(publicId, groupKey).first();
  let actors = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing.payload || "{}");
      actors = Array.isArray(parsed.actors) ? parsed.actors : [];
    } catch (err) { actors = []; }
  }
  const actor = { name: clip(input.name, 80), handle: clip(input.handle, 80).replace(/^@/, "") };
  actors = [actor].concat(actors.filter((row) => row && row.handle !== actor.handle)).slice(0, 12);
  const others = Math.max(0, actors.length - 1);
  const now = Date.now();
  const prefs = await readPrefs(env, publicId);
  const mode = modeFor(prefs, kind, true);
  const payload = payloadOf(Object.assign({}, input, { others, actors, name: actors[0].name, handle: actors[0].handle }));
  const subject = clip(input.subject || input.handle || "", 80).replace(/^@/, "").toLowerCase();
  const statements = [];
  if (!existing) {
    statements.push(env.DB.prepare(
      "INSERT INTO notifications (public_id, note_id, kind, at, read_at, actor_id, subject, idempotency_key, payload, updated_at, pushed_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0) ON CONFLICT(public_id, note_id) DO NOTHING"
    ).bind(publicId, groupKey, kind, now, clip(input.actorId, 16), subject, groupKey, payload, now));
  } else {
    statements.push(env.DB.prepare(
      "UPDATE notifications SET payload = ?, at = ?, read_at = 0, actor_id = ?, updated_at = ?, pushed_at = 0 WHERE public_id = ? AND note_id = ?"
    ).bind(payload, now, clip(input.actorId, 16), now, publicId, groupKey));
  }
  statements.push(env.DB.prepare(
    "INSERT INTO notification_events (public_id, event_key, note_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(public_id, event_key) DO NOTHING"
  ).bind(publicId, eventKey, groupKey, now));
  const item = itemFromRow({
    note_id: groupKey, kind, at: now, read_at: 0, actor_id: clip(input.actorId, 16), payload
  }, 0);
  const deliveryId = "d:" + groupKey + ":" + eventKey;
  const deliveries = [];
  if (mode === "push") {
    statements.push(outboxStatement(env, publicId, groupKey, deliveryId, now));
    deliveries.push({ mode: "push", publicId, item, deliveryId, readUntil: 0 });
  } else if (mode === "inapp") {
    deliveries.push({ mode: "inapp", publicId, item, deliveryId: "", readUntil: 0 });
  }
  return { created: true, id: groupKey, statements, deliveries };
}

export async function planNotification(env, input) {
  await ensureNotificationSchema(env);
  if (input && input.groupKey) return planGrouped(env, input);
  return planPlain(env, input);
}

async function completeOutbox(env, deliveryId) {
  if (!deliveryId) return;
  await env.DB.prepare("DELETE FROM notification_outbox WHERE delivery_id = ?").bind(deliveryId).run();
}

async function failOutbox(env, delivery, kind) {
  if (!delivery || !delivery.deliveryId) return;
  const row = await env.DB.prepare(
    "SELECT attempts FROM notification_outbox WHERE delivery_id = ?"
  ).bind(delivery.deliveryId).first();
  const attempts = (Number(row && row.attempts) || 0) + 1;
  if (attempts > BACKOFF_MS.length) {
    await deadLetter(env, delivery.publicId, kind, "push_failed");
    await completeOutbox(env, delivery.deliveryId);
    return;
  }
  const nextAt = Date.now() + nextBackoff(attempts - 1);
  await env.DB.prepare(
    "UPDATE notification_outbox SET attempts = ?, next_at = ? WHERE delivery_id = ?"
  ).bind(attempts, nextAt, delivery.deliveryId).run();
}

export async function finishDeliveries(env, deliveries, request) {
  const list = Array.isArray(deliveries) ? deliveries : [];
  for (let i = 0; i < list.length; i++) {
    const delivery = list[i];
    if (!delivery || !delivery.publicId || !delivery.item) continue;
    await trimNotes(env, delivery.publicId);
    const state = await readState(env, delivery.publicId);
    const viewer = await lockViewer(env, delivery.publicId);
    const item = await presentNote(env, request, { public_id: delivery.publicId }, delivery.item);
    const hidden = tiktokNoteHidden(item, viewer);
    const unread = await unreadCount(env, delivery.publicId, state.readUntil, viewer);
    try {
      await publishNotes(env, delivery.publicId, {
        type: "upsert",
        items: hidden ? [] : [item],
        unread,
        readUntil: state.readUntil
      });
    } catch (err) { logSafe("channel_failed"); }
    if (delivery.mode !== "push") continue;
    const result = await sendPush(env, delivery.publicId, item, viewer);
    if (result && result.ok) {
      await env.DB.prepare(
        "UPDATE notifications SET pushed_at = ? WHERE public_id = ? AND note_id = ?"
      ).bind(Date.now(), delivery.publicId, delivery.item.id).run();
      await completeOutbox(env, delivery.deliveryId);
    } else await failOutbox(env, delivery, delivery.item.kind);
  }
}

export async function emitNotification(env, input) {
  input = await shownActorName(env, input);
  const planned = await planNotification(env, input);
  if (!planned || !planned.statements || !planned.statements.length) {
    return { created: false, id: planned && planned.id };
  }
  try {
    await env.DB.batch(planned.statements);
  } catch (err) {
    if (/UNIQUE/i.test(String(err && err.message || err))) return { created: false, id: planned.id };
    throw err;
  }
  await finishDeliveries(env, planned.deliveries, input && input.request);
  const unread = await unreadCount(env, String(input.publicId || ""), (await readState(env, String(input.publicId || ""))).readUntil);
  return { created: !!planned.created, id: planned.id, unread };
}

/* The stored and pushed name is the one display name this recipient may
   see for the actor (their own nickname for the actor wins). */
async function shownActorName(env, input) {
  if (!input || !input.actorId || !input.publicId || typeof input.name !== "string") return input;
  const actorId = String(input.actorId).replace(/^app:/, "");
  try {
    const shown = await viewerDisplay(env, input.request || null, actorId, String(input.publicId), input.name);
    const name = shown.hidden ? String(input.handle || "") : shown.name;
    return name === input.name ? input : Object.assign({}, input, { name });
  } catch (err) { return input; }
}

export async function drainOutbox(env) {
  await ensureNotificationSchema(env);
  const now = Date.now();
  await env.DB.prepare("DELETE FROM notification_dead WHERE created_at < ?").bind(now - DEAD_KEEP_MS).run();
  const listed = await env.DB.prepare(
    "SELECT delivery_id, public_id, note_id, attempts FROM notification_outbox WHERE next_at <= ? ORDER BY next_at ASC LIMIT 20"
  ).bind(now).all();
  const rows = (listed && listed.results) || [];
  // Pushes go out four at a time instead of one after another.
  await eachLimit(rows, 4, async (row) => {
    const note = await env.DB.prepare(
      "SELECT note_id, kind, at, read_at, actor_id, payload FROM notifications WHERE public_id = ? AND note_id = ?"
    ).bind(row.public_id, row.note_id).first();
    if (!note) {
      await completeOutbox(env, row.delivery_id);
      return;
    }
    const item = itemFromRow(note, 0);
    await finishDeliveries(env, [{
      mode: "push",
      publicId: row.public_id,
      item,
      deliveryId: row.delivery_id,
      readUntil: 0
    }]);
  });
}

export async function notifyLiveStarted(env, info) {
  await ensureNotificationSchema(env);
  const handle = clip(info && info.handle, 80).replace(/^@/, "");
  const platform = clip((info && info.platform) || "tiktok", 24) || "tiktok";
  const room = clip((info && (info.roomId || info.id)) || "", 80);
  if (!handle || !room) return { created: 0 };
  const at = Number(info && info.at) || Date.now();
  const targets = new Set();
  if (platform === "tiktok") {
    const owner = await env.DB.prepare("SELECT public_id FROM accounts WHERE owner = 1").first();
    if (owner && owner.public_id) targets.add(owner.public_id);
  } else {
    const follows = await env.DB.prepare(
      "SELECT follower_id FROM account_follows WHERE target_id = ? OR target_id = ? LIMIT 200"
    ).bind(platform + ":" + handle, platform + ":" + handle.toLowerCase()).all();
    ((follows && follows.results) || []).forEach((row) => { if (row && row.follower_id) targets.add(row.follower_id); });
  }
  const bells = await env.DB.prepare(
    "SELECT public_id FROM notification_bells WHERE deleted_at = 0 AND (feed_key = ? OR feed_key = ?) AND (mode = 'all' OR mode = 'live') LIMIT 200"
  ).bind(platform + ":" + handle, platform + ":" + handle.toLowerCase()).all();
  ((bells && bells.results) || []).forEach((row) => { if (row && row.public_id) targets.add(row.public_id); });
  let created = 0;
  for (const publicId of targets) {
    const result = await emitNotification(env, {
      publicId,
      kind: "live",
      at,
      subject: handle.toLowerCase(),
      idempotencyKey: "live:" + platform + ":" + handle.toLowerCase() + ":" + room,
      handle,
      name: clip(info.name || handle, 80),
      text: clip(info.title || "", 180),
      hash: "#/" + encodeURIComponent(platform) + "/" + encodeURIComponent(handle),
      platform,
      feedId: platform + ":" + handle
    });
    if (result.created) created += 1;
  }
  return { created, targets: targets.size };
}

async function saveBells(env, publicId, bells, bellsAt) {
  const at = Number(bellsAt) || 0;
  if (!at || !bells || typeof bells !== "object" || Array.isArray(bells)) return;
  const state = await readState(env, publicId);
  const keys = Object.keys(bells).slice(0, 200);
  for (let i = 0; i < keys.length; i++) {
    const key = clip(keys[i], 120);
    const row = bells[keys[i]];
    if (!key || !row) continue;
    const updatedAt = Number(row.updatedAt || row.since) || at;
    const stored = await env.DB.prepare(
      "SELECT updated_at, deleted_at FROM notification_bells WHERE public_id = ? AND feed_key = ?"
    ).bind(publicId, key).first();
    if (stored && updatedAt <= Number(stored.deleted_at || 0)) continue;
    if (stored && updatedAt < Number(stored.updated_at || 0)) continue;
    if (row.deleted === true || (row.mode !== "all" && row.mode !== "live")) {
      await env.DB.prepare(
        "INSERT INTO notification_bells (public_id, feed_key, mode, since, handle, name, ids, handles, updated_at, deleted_at) VALUES (?, ?, '', ?, '', '', '[]', '[]', ?, ?) ON CONFLICT(public_id, feed_key) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at"
      ).bind(publicId, key, updatedAt, updatedAt, updatedAt).run();
      continue;
    }
    await env.DB.prepare(
      "INSERT INTO notification_bells (public_id, feed_key, mode, since, handle, name, ids, handles, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0) ON CONFLICT(public_id, feed_key) DO UPDATE SET mode = excluded.mode, since = excluded.since, handle = excluded.handle, name = excluded.name, ids = excluded.ids, handles = excluded.handles, updated_at = excluded.updated_at, deleted_at = 0"
    ).bind(
      publicId,
      key,
      row.mode,
      Number(row.since) || updatedAt,
      clip(row.handle, 80).replace(/^@/, ""),
      clip(row.name, 80),
      JSON.stringify(Array.isArray(row.ids) ? row.ids.slice(0, 12) : []),
      JSON.stringify(Array.isArray(row.handles) ? row.handles.slice(0, 24) : []),
      updatedAt
    ).run();
  }
  if (at >= state.bellsAt) {
    const have = await env.DB.prepare("SELECT feed_key, updated_at FROM notification_bells WHERE public_id = ? AND deleted_at = 0").bind(publicId).all();
    const rows = (have && have.results) || [];
    for (let i = 0; i < rows.length; i++) {
      if (keys.indexOf(rows[i].feed_key) >= 0) continue;
      if (at <= Number(rows[i].updated_at || 0)) continue;
      await env.DB.prepare(
        "UPDATE notification_bells SET deleted_at = ?, updated_at = ? WHERE public_id = ? AND feed_key = ?"
      ).bind(at, at, publicId, rows[i].feed_key).run();
    }
    await env.DB.prepare(
      "INSERT INTO notification_state (public_id, read_until, tabs, bells_at, updated_at) VALUES (?, 0, '', ?, ?) ON CONFLICT(public_id) DO UPDATE SET bells_at = MAX(notification_state.bells_at, excluded.bells_at), updated_at = excluded.updated_at"
    ).bind(publicId, at, Date.now()).run();
  }
}

async function saveTabs(env, publicId, body) {
  if (!body || (!Array.isArray(body.tabs) && body.noteTabsSame == null && body.lastNoteTab == null)) return;
  const state = await readState(env, publicId);
  const prev = state.tabs || { tabs: [], noteTabsSame: true, lastNoteTab: "all" };
  const merged = mergeNoteTabs(body.tabs || [], prev.tabs);
  const noteTabsSame = body.noteTabsSame === false ? false : (body.noteTabsSame === true ? true : prev.noteTabsSame);
  const lastNoteTab = body.lastNoteTab ? clip(body.lastNoteTab, 40) : prev.lastNoteTab;
  const text = JSON.stringify({ tabs: merged, noteTabsSame, lastNoteTab });
  if (text.length > 100000) return;
  await env.DB.prepare(
    "INSERT INTO notification_state (public_id, read_until, tabs, bells_at, updated_at) VALUES (?, 0, ?, 0, ?) ON CONFLICT(public_id) DO UPDATE SET tabs = excluded.tabs, updated_at = excluded.updated_at"
  ).bind(publicId, text, Date.now()).run();
  const unread = await unreadCount(env, publicId, (await readState(env, publicId)).readUntil);
  await publishNotes(env, publicId, {
    type: "tabs",
    tabs: merged,
    noteTabsSame,
    lastNoteTab,
    unread
  });
}

async function markRead(env, publicId, until, ids, tab) {
  const state = await readState(env, publicId);
  const tabId = clip(tab || "", 40);
  const markAll = tabId === "all" || tab === true;
  const nextUntil = markAll || !tabId ? Math.max(state.readUntil, Number(until) || 0) : state.readUntil;
  if (nextUntil > state.readUntil) await writeReadUntil(env, publicId, nextUntil);
  const cleanIds = [];
  (Array.isArray(ids) ? ids : []).slice(0, 80).forEach((id) => {
    const text = clip(id, 160);
    if (text) cleanIds.push(text);
  });
  const now = Date.now();
  for (let i = 0; i < cleanIds.length; i++) {
    await env.DB.prepare(
      "UPDATE notifications SET read_at = ?, updated_at = ? WHERE public_id = ? AND note_id = ? AND read_at = 0"
    ).bind(now, now, publicId, cleanIds[i]).run();
  }
  if (tabId === "mentions") {
    await env.DB.prepare(
      "UPDATE notifications SET read_at = ?, updated_at = ? WHERE public_id = ? AND kind IN ('mention', 'discord') AND read_at = 0"
    ).bind(now, now, publicId).run();
    await env.DB.prepare(
      "INSERT INTO notification_tab_reads (public_id, tab_id, read_until, updated_at) VALUES (?, 'mentions', ?, ?) ON CONFLICT(public_id, tab_id) DO UPDATE SET read_until = excluded.read_until, updated_at = excluded.updated_at"
    ).bind(publicId, now, now).run();
  }
  if (nextUntil > state.readUntil) {
    await env.DB.prepare(
      "UPDATE notifications SET read_at = ?, updated_at = ? WHERE public_id = ? AND read_at = 0 AND at <= ?"
    ).bind(now, now, publicId, nextUntil).run();
  }
  const saved = await readState(env, publicId);
  const unread = await unreadCount(env, publicId, saved.readUntil);
  await publishNotes(env, publicId, {
    type: "read",
    until: saved.readUntil,
    ids: cleanIds,
    unread,
    readUntil: saved.readUntil
  });
  return unread;
}

function cleanClientItem(raw, actor) {
  const kind = cleanKind(raw && raw.kind) || "post";
  const key = clip((raw && (raw.idempotencyKey || raw.id)) || "", 160);
  if (!key) return null;
  let recipient = actor.public_id;
  if (kind === "like" || kind === "repost") {
    recipient = String(raw.recipientId || "");
    if (!/^\d{12}$/.test(recipient) || recipient === actor.public_id) return null;
  } else if (kind === "follow" || kind === "reply") {
    return null;
  }
  return {
    publicId: recipient,
    kind,
    at: Number(raw.at) || Date.now(),
    actorId: kind === "like" || kind === "repost" ? actor.public_id : "",
    idempotencyKey: key,
    subject: clip(raw.handle || raw.subject || "", 80),
    handle: raw.handle,
    name: raw.name,
    text: raw.text,
    avatar: raw.avatar,
    image: raw.image,
    hash: raw.hash,
    feedId: raw.feedId,
    platform: raw.platform,
    verified: raw.verified === true,
    mention: raw.mention === true || kind === "mention",
    ids: raw.ids,
    handles: raw.handles
  };
}

export async function handleNotificationRoutes(request, env, path, deps) {
  await ensureNotificationSchema(env);
  const { json, sessionAccount, readJson, rateHit, limited } = deps;
  const row = await sessionAccount(env, request);
  if (!row) return json(401, { error: "unauthorized" });
  if (path === "/v1/notifications" && request.method === "GET") {
    const hit = await rateHit(env, "notes-read:" + row.public_id, 120, 10 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    try { await drainOutbox(env); }
    catch (err) { logSafe("drain_failed"); }
    const url = new URL(request.url);
    const since = Number(url.searchParams.get("since")) || 0;
    const flag = url.searchParams.get("locked");
    if (flag === "0" || flag === "1") await writeShortsLocked(env, row.public_id, flag === "1");
    return json(200, await viewFor(env, row.public_id, since, flag, request));
  }
  if (path === "/v1/notifications" && request.method === "POST") {
    const hit = await rateHit(env, "notes-write:" + row.public_id, 60, 10 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    const body = await readJson(request, 80000);
    if (body.error) return json(body.error === "too_large" ? 413 : 400, { error: body.error });
    if (lockFlag(body.shortsLocked) !== null) await writeShortsLocked(env, row.public_id, lockFlag(body.shortsLocked) === true);
    const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    for (let i = 0; i < items.length; i++) {
      const cleaned = cleanClientItem(items[i], row);
      if (!cleaned) continue;
      if (cleaned.publicId !== row.public_id) {
        const target = await env.DB.prepare("SELECT public_id FROM accounts WHERE public_id = ?").bind(cleaned.publicId).first();
        if (!target) continue;
      }
      await emitNotification(env, cleaned);
    }
    if (body.prefs && typeof body.prefs === "object") await savePrefs(env, row.public_id, body.prefs);
    if (body.all === true || body.tab || body.until || (Array.isArray(body.ids) && body.ids.length)) {
      await markRead(env, row.public_id, body.all === true ? Date.now() : body.until, body.ids, body.all === true ? "all" : body.tab);
    }
    if (Array.isArray(body.tabs) || body.noteTabsSame != null || body.lastNoteTab) await saveTabs(env, row.public_id, body);
    if (body.bells && typeof body.bells === "object") await saveBells(env, row.public_id, body.bells, body.bellsAt);
    return json(200, await viewFor(env, row.public_id, 0, body.shortsLocked, request));
  }
  if (path === "/v1/notifications/read" && request.method === "POST") {
    const hit = await rateHit(env, "notes-write:" + row.public_id, 60, 10 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    const body = await readJson(request, 40000);
    if (body.error) return json(400, { error: body.error });
    await markRead(env, row.public_id, body.all === true ? Date.now() : body.until, body.ids, body.all === true ? "all" : body.tab);
    if (Array.isArray(body.tabs) || body.noteTabsSame != null || body.lastNoteTab) await saveTabs(env, row.public_id, body);
    return json(200, await viewFor(env, row.public_id, 0, null, request));
  }
  if (path === "/v1/push/vapid" && request.method === "GET") {
    const keys = await vapidPublic(env);
    return json(200, { publicKey: keys.publicKey || "" });
  }
  if (path === "/v1/push/subscribe" && request.method === "PUT") {
    const hit = await rateHit(env, "push-sub:" + row.public_id, 30, 10 * 60 * 1000);
    if (!hit.ok) return limited(hit);
    const body = await readJson(request, 8000);
    if (body.error) return json(400, { error: body.error });
    const endpoint = String(body.endpoint || "");
    const keys = body.keys || {};
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 500 || !keys.p256dh || !keys.auth) return json(400, { error: "bad_subscription" });
    const hash = await sha256Hex(endpoint);
    const exp = Number(body.expirationTime) > 0 ? Number(body.expirationTime) : 0;
    const now = Date.now();
    const deviceLocked = lockFlag(body.locked != null ? body.locked : body.shortsLocked);
    const shortsLocked = deviceLocked === false ? 0 : 1;
    const pushFmt = Number(body.fmt) === 2 ? 2 : 1;
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (public_id, endpoint_hash, endpoint, p256dh, auth, ua, created_at, updated_at, expires_at, shorts_locked, push_fmt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(public_id, endpoint_hash) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua, updated_at = excluded.updated_at, expires_at = excluded.expires_at, shorts_locked = excluded.shorts_locked, push_fmt = excluded.push_fmt"
    ).bind(row.public_id, hash, endpoint, clip(keys.p256dh, 200), clip(keys.auth, 200), clip(request.headers.get("user-agent"), 160), now, now, exp, shortsLocked, pushFmt).run();
    return json(200, { ok: true });
  }
  if (path === "/v1/push/subscribe" && request.method === "DELETE") {
    const body = await readJson(request, 4000);
    if (body.error) return json(400, { error: body.error });
    if (body.all === true) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE public_id = ?").bind(row.public_id).run();
    } else if (body.endpoint) {
      const hash = await sha256Hex(String(body.endpoint));
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE public_id = ? AND endpoint_hash = ?").bind(row.public_id, hash).run();
    }
    return json(200, { ok: true });
  }
  return null;
}

async function dropHiddenNotes(env, publicId, items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const actorId = String(item && item.actorId || "");
    if (/^\d{12}$/.test(actorId)) {
      try {
        if (await actorHidden(env, publicId, actorId)) continue;
      } catch (err) { /* keep the note */ }
    }
    out.push(item);
  }
  return out;
}

export async function notifyFollow(env, actor, targetId, request) {
  if (!targetId || String(targetId).indexOf("app:") !== 0) return;
  const publicId = String(targetId).slice(4);
  if (!/^\d{12}$/.test(publicId) || publicId === actor.public_id) return;
  const now = Date.now();
  let avatar = "";
  if (request) avatar = await visibleAvatarUrl(env, request, { public_id: publicId }, actor.handle) || "";
  await emitNotification(env, {
    publicId,
    kind: "follow",
    at: now,
    actorId: actor.public_id,
    idempotencyKey: "follow:" + actor.public_id + ":" + now,
    handle: actor.handle,
    name: actor.display_name,
    text: "",
    avatar,
    hash: "#/" + encodeURIComponent(actor.handle || ""),
    platform: "app",
    feedId: actor.handle ? "app:@" + actor.handle : "",
    request
  });
}

export async function notifyFollowRequest(env, actor, targetPublicId) {
  if (!/^\d{12}$/.test(String(targetPublicId || "")) || targetPublicId === actor.public_id) return;
  const now = Date.now();
  await emitNotification(env, {
    publicId: targetPublicId,
    kind: "follow_request",
    at: now,
    actorId: actor.public_id,
    idempotencyKey: "followreq:" + actor.public_id + ":" + now,
    handle: actor.handle,
    name: actor.display_name,
    text: "",
    hash: "#/" + encodeURIComponent(actor.handle || ""),
    platform: "app",
    feedId: "app:" + actor.public_id
  });
}

export async function notifyFollowAccept(env, actor, requesterPublicId) {
  if (!/^\d{12}$/.test(String(requesterPublicId || "")) || requesterPublicId === actor.public_id) return;
  const now = Date.now();
  await emitNotification(env, {
    publicId: requesterPublicId,
    kind: "follow_accept",
    at: now,
    actorId: actor.public_id,
    idempotencyKey: "followok:" + actor.public_id + ":" + now,
    handle: actor.handle,
    name: actor.display_name,
    text: "",
    hash: "#/" + encodeURIComponent(actor.handle || ""),
    platform: "app",
    feedId: "app:" + actor.public_id
  });
}

/* Friend requests and accepts land in the bell, the badge and push like
   follow requests do. Every friend change also sends a quiet "friends"
   signal on the notifications channel so open tabs on both sides refresh
   their requests, friends list and presence without a reload. */
export async function notifyFriend(env, actor, targetPublicId, kind, receiverHandle) {
  if (!/^\d{12}$/.test(String(targetPublicId || "")) || targetPublicId === actor.public_id) return;
  if (kind !== "friend_request" && kind !== "friend_accept") return;
  const now = Date.now();
  const mine = String(receiverHandle || "");
  await emitNotification(env, {
    publicId: targetPublicId,
    kind: kind,
    at: now,
    actorId: actor.public_id,
    idempotencyKey: (kind === "friend_request" ? "friendreq:" : "friendok:") + actor.public_id + ":" + now,
    handle: actor.handle,
    name: actor.display_name,
    text: "",
    hash: kind === "friend_request" && mine ? "#/@" + encodeURIComponent(mine) + "/requests?kind=friends" : "#/" + encodeURIComponent(actor.handle || ""),
    platform: "app",
    feedId: "app:" + actor.public_id
  });
}

export async function signalFriends(env, publicIds) {
  const list = Array.isArray(publicIds) ? publicIds : [];
  for (let i = 0; i < list.length; i++) {
    if (/^\d{12}$/.test(String(list[i] || ""))) await publishNotes(env, list[i], { type: "friends" });
  }
}

export async function notifyRepost(env, actor, cleaned) {
  const post = cleaned && cleaned.post;
  const handle = clip(post && post.handle, 80).replace(/^@/, "");
  if (!handle) return;
  const checked = inspectHandle(handle);
  if (!checked.ok || !checked.skeleton) return;
  const author = await env.DB.prepare("SELECT public_id FROM accounts WHERE skeleton = ?").bind(checked.skeleton).first();
  if (!author || author.public_id === actor.public_id) return;
  const kind = cleaned.kind === "quote" ? "quote" : "repost";
  const subjectId = clip((post && (post.id || post.statusId)) || cleaned.postKey, 80);
  await emitNotification(env, {
    publicId: author.public_id,
    kind,
    at: Date.now(),
    actorId: actor.public_id,
    groupKey: kind + ":" + subjectId,
    idempotencyKey: kind + ":" + actor.public_id + ":" + cleaned.postKey,
    handle: actor.handle,
    name: actor.display_name,
    text: clip(cleaned.comment || post.text || "", 180),
    hash: "#/" + encodeURIComponent(actor.handle || ""),
    platform: "app",
    feedId: actor.handle ? "app:@" + actor.handle : ""
  });
}

export async function planRepostNotification(env, actor, cleaned) {
  const post = cleaned && cleaned.post;
  // Only app posts belong to app accounts; an X or Bluesky handle can match an app handle by chance.
  if (post && post.platform && post.platform !== "app") return null;
  const handle = clip(post && post.handle, 80).replace(/^@/, "");
  if (!handle) return null;
  const checked = inspectHandle(handle);
  if (!checked.ok || !checked.skeleton) return null;
  const author = await env.DB.prepare("SELECT public_id FROM accounts WHERE skeleton = ?").bind(checked.skeleton).first();
  if (!author || author.public_id === actor.public_id) return null;
  const kind = cleaned.kind === "quote" ? "quote" : "repost";
  const subjectId = clip((post && (post.id || post.statusId)) || cleaned.postKey, 80);
  return planNotification(env, {
    publicId: author.public_id,
    kind,
    at: Date.now(),
    actorId: actor.public_id,
    groupKey: kind + ":" + subjectId,
    idempotencyKey: kind + ":" + actor.public_id + ":" + cleaned.postKey,
    handle: actor.handle,
    name: actor.display_name,
    text: clip(cleaned.comment || post.text || "", 180),
    hash: "#/" + encodeURIComponent(actor.handle || ""),
    platform: "app",
    feedId: actor.handle ? "app:@" + actor.handle : ""
  });
}

export async function notifyCommunity(env, input) {
  await emitNotification(env, input);
}

const MENTION_RE = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_\u0400-\u04FF]{2,32})/g;

export async function notifyMentions(env, actor, text, except, idempotencyPrefix, hash) {
  const seen = {};
  (except || []).forEach((id) => { if (id) seen[id] = true; });
  seen[actor.public_id] = true;
  const found = String(text || "").match(MENTION_RE) || [];
  for (let i = 0; i < found.length && i < 8; i++) {
    const handle = String(found[i] || "").replace(/^.*@/, "");
    const checked = inspectHandle(handle);
    if (!checked.ok || !checked.skeleton) continue;
    const author = await env.DB.prepare("SELECT public_id, handle FROM accounts WHERE skeleton = ?").bind(checked.skeleton).first();
    if (!author || seen[author.public_id]) continue;
    seen[author.public_id] = true;
    try {
      if (!(await canMention(env, actor.public_id, author.public_id))) continue;
    } catch (err) { /* mention checks must not drop every note */ }
    await emitNotification(env, {
      publicId: author.public_id,
      kind: "mention",
      at: Date.now(),
      actorId: actor.public_id,
      idempotencyKey: idempotencyPrefix + ":" + author.public_id,
      handle: actor.handle,
      name: actor.display_name,
      text: clip(text, 180),
      hash: hash || "#/",
      platform: "app",
      feedId: actor.handle ? "app:@" + actor.handle : "",
      mention: true
    });
  }
}

export async function notificationSelfTest() {
  const read = mergeNotificationItems(
    [{ id: "a", at: 20, read: true, text: "local" }, { id: "c", at: 5, read: false }],
    [{ id: "a", at: 10, read: false, text: "server" }, { id: "b", at: 30, read: false }],
    0
  );
  if (read.map((item) => item.id).join(",") !== "b,a,c") throw new Error("order");
  if (!read.find((item) => item.id === "a").read) throw new Error("resurrect");
  if (read.find((item) => item.id === "a").at !== 10) throw new Error("server time");
  if (read.find((item) => item.id === "a").text !== "local") throw new Error("local fields");
  const caught = mergeNotificationItems(
    [{ id: "old", at: 40, read: false }],
    [],
    50
  );
  if (!caught[0].read) throw new Error("cursor");
  const offline = mergeNotificationItems(
    [{ id: "only-local", at: 2, read: true }],
    [{ id: "only-server", at: 3, read: false }],
    0
  );
  if (offline.length !== 2 || !offline.find((item) => item.id === "only-local").read) throw new Error("offline union");
  const tabs = mergeNoteTabs(
    [{ id: "t", name: "old", updatedAt: 5, readAt: 9, deletedAt: 0 }],
    [{ id: "t", name: "new", updatedAt: 8, readAt: 4, deletedAt: 12 }]
  );
  if (tabs[0].name !== "new" || tabs[0].readAt !== 9 || tabs[0].deletedAt !== 12) throw new Error("tabs");
  const round = await pushRoundTrip("hello");
  if (round !== "hello") throw new Error("push");
  if (pushSuppressed({ presence: "dnd" }, 10)) {
    if (!pushSuppressed({ dnd_until: 50 }, 10)) throw new Error("dnd until");
    if (pushSuppressed({ dnd_until: 5 }, 10)) throw new Error("dnd expired");
  } else throw new Error("dnd");
  const ownerLocked = { owner: true, locked: true, unlocked: [] };
  if (!tiktokNoteHidden({ platform: "tiktok", handle: "lockedacct", feedId: "tiktok:lockedacct" }, ownerLocked)) throw new Error("locked note");
  if (tiktokNoteHidden({ platform: "tiktok", handle: "openacct", feedId: "tiktok:openacct" }, { owner: true, locked: true, unlocked: function (name) { return name === "openacct"; } })) throw new Error("unlocked note");
  if (tiktokNoteHidden({ platform: "tiktok", handle: "lockedacct" }, { owner: true, locked: false, unlocked: [] })) throw new Error("lock off");
  if (!tiktokNoteHidden({ platform: "tiktok", handle: "openacct" }, { owner: false, audienceAll: false, locked: false, unlocked: ["openacct"] })) throw new Error("audience");
  if (tiktokNoteHidden({ platform: "app", handle: "readerlock" }, ownerLocked)) throw new Error("other platform");
  const rows = visibleNotes([
    { id: "a", platform: "tiktok", handle: "lockedacct", read: false },
    { id: "b", platform: "app", handle: "readerlock", read: false }
  ], ownerLocked);
  if (rows.length !== 1 || rows[0].id !== "b") throw new Error("badge");
}

if (typeof process !== "undefined" && process.argv && process.argv.indexOf("--selftest") >= 0) {
  notificationSelfTest().then(() => {
    console.log("ok notifications");
  }).catch((err) => {
    console.error(err && err.message ? err.message : "notifications selftest failed");
    process.exit(1);
  });
}

/* Notes from locked follows, for the Locked area only (the route checks the
   unlock grant). Same shape as the main list, without the actor id. */
export async function heldNotes(env, request, publicId, actorIds) {
  const ids = Array.from(actorIds || []).filter((id) => /^\d{12}$/.test(String(id))).slice(0, 200);
  if (!ids.length) return [];
  const state = await readState(env, publicId);
  const marks = ids.map(() => "?").join(",");
  const listed = await env.DB.prepare(
    "SELECT note_id, kind, at, read_at, actor_id, payload, updated_at FROM notifications WHERE public_id = ? AND actor_id IN (" + marks + ") ORDER BY at DESC, note_id ASC LIMIT 80"
  ).bind(publicId, ...ids).all();
  const out = [];
  const mediaViewer = { public_id: publicId };
  for (const row of (listed && listed.results) || []) {
    const item = await presentNote(env, request, mediaViewer, itemFromRow(row, state.readUntil));
    delete item.actorId;
    out.push(item);
  }
  return out;
}
