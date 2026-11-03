/* Signed-in photo and video stories. Bytes stay in R2 as uploaded.
   Nothing here re-encodes. Video responses are marked no-store so the
   Cloudflare cache does not keep them. Rows expire after 24 hours. */

import { eachLimit } from "./limit.js";
import { poolWidth } from "./job-runner.js";
import { blocksEither } from "./social.js";
import { notLocked } from "./locked-sql.js";
import { canSeeAudience, normalizeAudience, setListGrants } from "./audience.js";

export const APP_STORIES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_stories (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    vine INTEGER NOT NULL DEFAULT 0,
    r2_key TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT 'public',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS app_stories_account ON app_stories(public_id, expires_at)",
  "CREATE INDEX IF NOT EXISTS app_stories_expiry ON app_stories(expires_at)",
  `CREATE TABLE IF NOT EXISTS app_story_views (
    story_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, viewer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS app_story_reactions (
    story_id TEXT NOT NULL,
    public_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, public_id)
  )`,
  `CREATE TABLE IF NOT EXISTS app_story_replies (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL,
    public_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS app_story_replies_story ON app_story_replies(story_id, created_at)"
];

const DAY = 24 * 60 * 60 * 1000;
const PHOTO_CAP = 15 * 1024 * 1024;
const VIDEO_CAP = 40 * 1024 * 1024;
const STORY_CAP = 20;
const CAPTION_MAX = 140;
const REPLY_MAX = 280;
const REACTIONS = { "❤": 1, "🔥": 1, "👏": 1, "😂": 1, "😮": 1, "😢": 1 };
const FILE_NAME = /^[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov)$/;
const STORY_ID = /^[a-f0-9]{32}$/;
const AVATAR_KEY = /^media\/avatars\/(\d{12})\/([a-f0-9]{64})\.(webp|jpg|png)$/;
const WINDOW_MS = 60 * 60 * 1000;

function hex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function newId() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function rowsOf(result) {
  return (result && result.results) || [];
}

function cleanText(value, max) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return Array.from(text).slice(0, max).join("");
}

function sniff(bytes) {
  if (!bytes || bytes.length < 12) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  return "";
}

function kindOf(mime) {
  if (mime.indexOf("image/") === 0) return "photo";
  if (mime.indexOf("video/") === 0) return "video";
  return "";
}

function fileMime(name) {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".mp4")) return "video/mp4";
  return "image/jpeg";
}

function absUrl(request, path) {
  try { return new URL(path, request.url).toString(); }
  catch (err) { return path; }
}

function avatarUrl(request, row, own) {
  const hidden = String(row.hide_avatar || "");
  if (hidden && !own) return "";
  const key = String(row.avatar || "");
  if (!AVATAR_KEY.test(key)) return "";
  return absUrl(request, "/v1/" + key);
}

async function readStory(env, id) {
  if (!STORY_ID.test(id)) return null;
  return env.DB.prepare(
    "SELECT id, public_id, kind, vine, r2_key, mime, bytes, caption, audience, created_at, expires_at FROM app_stories WHERE id = ?"
  ).bind(id).first();
}

async function followedIds(env, viewerId) {
  const listed = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id LIKE 'app:%'" + notLocked("account_follows") 
  ).bind(viewerId).all();
  const ids = [];
  rowsOf(listed).forEach((row) => {
    const id = String(row.target_id || "").slice(4);
    if (/^\d{12}$/.test(id)) ids.push(id);
  });
  return ids;
}

function iso(ms) {
  try { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"); }
  catch (err) { return ""; }
}

async function listVisible(env, request, viewer) {
  const now = Date.now();
  const followed = await followedIds(env, viewer.public_id);
  const ids = followed.filter((id) => id !== viewer.public_id);
  ids.unshift(viewer.public_id);
  const unique = [];
  ids.forEach((id) => { if (unique.indexOf(id) < 0) unique.push(id); });
  const allowed = [];
  for (let i = 0; i < unique.length && allowed.length < 40; i++) {
    if (unique[i] !== viewer.public_id && await blocksEither(env, viewer.public_id, unique[i])) continue;
    allowed.push(unique[i]);
  }
  if (!allowed.length) return [];
  const marks = allowed.map(() => "?").join(",");
  const listed = await env.DB.prepare(
    "SELECT s.id, s.public_id, s.kind, s.vine, s.mime, s.caption, s.audience, s.created_at, s.expires_at, a.handle, a.display_name, a.avatar, a.hide_avatar, a.profile_less FROM app_stories s JOIN accounts a ON a.public_id = s.public_id WHERE s.expires_at > ? AND s.public_id IN (" + marks + ") ORDER BY s.created_at ASC"
  ).bind(now, ...allowed).all();
  const grouped = {};
  const order = [];
  for (const row of rowsOf(listed)) {
    if (!grouped[row.public_id]) {
      grouped[row.public_id] = {
        id: "app:" + row.public_id,
        platform: "app",
        handle: row.handle || "",
        name: row.display_name || row.handle || "",
        avatar: avatarUrl(request, row, row.public_id === viewer.public_id),
        self: row.public_id === viewer.public_id,
        items: []
      };
      order.push(row.public_id);
    }
    if (!(await canSeeAudience(env, {
      viewerId: viewer.public_id,
      ownerId: row.public_id,
      audience: row.audience || "public",
      subject: "story",
      subjectId: row.id,
      profileLess: row.profile_less === 1
    }))) continue;
    grouped[row.public_id].items.push({
      id: row.id,
      type: row.kind === "video" ? "video" : "photo",
      url: absUrl(request, "/v1/stories/media/" + row.id),
      date: iso(Number(row.created_at) || now),
      expires: iso(Number(row.expires_at) || now),
      caption: row.caption || "",
      vine: row.vine === 1,
      mine: row.public_id === viewer.public_id
    });
  }
  const self = order.indexOf(viewer.public_id);
  if (self > 0) {
    order.splice(self, 1);
    order.unshift(viewer.public_id);
  }
  return order.map((id) => grouped[id]);
}

function mediaHeaders(mime, size) {
  const headers = new Headers();
  headers.set("content-type", mime || "application/octet-stream");
  headers.set("cache-control", "private, no-store");
  headers.set("cdn-cache-control", "no-store");
  headers.set("cloudflare-cdn-cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-disposition", "inline");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
  if (size >= 0) headers.set("content-length", String(size));
  if (String(mime || "").indexOf("video/") === 0) headers.set("accept-ranges", "bytes");
  return headers;
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!match || size < 1) return null;
  let start = match[1] === "" ? -1 : Number(match[1]);
  let end = match[2] === "" ? size - 1 : Number(match[2]);
  if (start < 0) {
    const tail = end;
    if (!tail) return null;
    start = Math.max(0, size - tail);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1, end: end };
}

async function sendObject(request, env, key, mime) {
  if (!env.DATA || !key) return new Response(null, { status: 404 });
  const head = await env.DATA.head(key);
  if (!head) return new Response(null, { status: 404 });
  const size = Number(head.size) || 0;
  const type = mime || (head.httpMetadata && head.httpMetadata.contentType) || "application/octet-stream";
  const headers = mediaHeaders(type, size);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const range = String(type).indexOf("video/") === 0 ? parseRange(request.headers.get("range"), size) : null;
  if (request.headers.get("range") && !range && String(type).indexOf("video/") === 0) {
    headers.set("content-range", "bytes */" + size);
    return new Response(null, { status: 416, headers });
  }
  const object = await env.DATA.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!object) return new Response(null, { status: 404 });
  if (range) {
    headers.set("content-length", String(range.length));
    headers.set("content-range", "bytes " + range.offset + "-" + range.end + "/" + size);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

async function handleCreate(request, env, viewer, deps) {
  const paced = await deps.rateHit(env, "story-post:" + viewer.public_id, 12, WINDOW_MS);
  if (!paced.ok) return deps.limited(paced);
  const len = Number(request.headers.get("content-length") || 0);
  if (len > VIDEO_CAP + 1024 * 1024) return deps.json(413, { error: "too_large" });
  let form = null;
  try { form = await request.formData(); }
  catch (err) { form = null; }
  if (!form) return deps.json(400, { error: "bad_form" });
  const file = form.get("file");
  if (!file || typeof file.arrayBuffer !== "function") return deps.json(400, { error: "file" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniff(bytes);
  const kind = kindOf(mime);
  if (!kind) return deps.json(415, { error: "type" });
  if (kind === "photo" && bytes.length > PHOTO_CAP) return deps.json(413, { error: "too_large" });
  if (kind === "video" && bytes.length > VIDEO_CAP) return deps.json(413, { error: "too_large" });
  if (!env.DATA) return deps.json(503, { error: "not_configured" });
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM app_stories WHERE public_id = ? AND expires_at > ?"
  ).bind(viewer.public_id, Date.now()).first();
  if (Number(countRow && countRow.n) >= STORY_CAP) return deps.json(429, { error: "too_many" });
  const id = newId();
  const key = "stories/app/" + viewer.public_id + "/" + id;
  const now = Date.now();
  const caption = cleanText(form.get("caption"), CAPTION_MAX);
  const vine = String(form.get("vine") || "") === "1" ? 1 : 0;
  await env.DATA.put(key, bytes, {
    httpMetadata: {
      contentType: mime,
      cacheControl: "private, no-store"
    }
  });
  const audience = normalizeAudience(form.get("audience")) || "public";
  let listIds = [];
  try { listIds = JSON.parse(String(form.get("listIds") || "[]")); } catch (err) { listIds = []; }
  await env.DB.prepare(
    "INSERT INTO app_stories (id, public_id, kind, vine, r2_key, mime, bytes, caption, audience, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, viewer.public_id, kind, vine, key, mime, bytes.length, caption, audience, now, now + DAY).run();
  if (audience === "list") await setListGrants(env, viewer.public_id, "story", id, listIds);
  try {
    const badges = await import("./badges.js");
    await badges.syncBadges(env, viewer.public_id);
  } catch (err) { /* the story is saved */ }
  return deps.json(201, {
    id: id,
    type: kind === "video" ? "video" : "photo",
    url: absUrl(request, "/v1/stories/media/" + id),
    vine: vine === 1,
    expires: iso(now + DAY)
  });
}

async function handleDelete(env, viewer, id, deps) {
  const row = await readStory(env, id);
  if (!row || Number(row.expires_at) <= Date.now()) return deps.json(404, { error: "not_found" });
  if (row.public_id !== viewer.public_id) return deps.json(403, { error: "forbidden" });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_story_views WHERE story_id = ?").bind(id),
    env.DB.prepare("DELETE FROM app_story_reactions WHERE story_id = ?").bind(id),
    env.DB.prepare("DELETE FROM app_story_replies WHERE story_id = ?").bind(id),
    env.DB.prepare("DELETE FROM app_stories WHERE id = ?").bind(id)
  ]);
  if (env.DATA && row.r2_key) {
    try { await env.DATA.delete(row.r2_key); }
    catch (err) { /* the row is already gone */ }
  }
  return deps.json(200, { ok: true });
}

async function handleSeen(env, viewer, id, deps) {
  const row = await readStory(env, id);
  if (!row || Number(row.expires_at) <= Date.now()) return deps.json(404, { error: "not_found" });
  if (row.public_id !== viewer.public_id && await blocksEither(env, viewer.public_id, row.public_id)) {
    return deps.json(404, { error: "not_found" });
  }
  if (row.public_id !== viewer.public_id) {
    await env.DB.prepare(
      "INSERT INTO app_story_views (story_id, viewer_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(story_id, viewer_id) DO UPDATE SET seen_at = excluded.seen_at"
    ).bind(id, viewer.public_id, Date.now()).run();
  }
  return deps.json(200, { ok: true });
}

async function handleReact(request, env, viewer, id, deps) {
  const paced = await deps.rateHit(env, "story-react:" + viewer.public_id, 60, WINDOW_MS);
  if (!paced.ok) return deps.limited(paced);
  const row = await readStory(env, id);
  if (!row || Number(row.expires_at) <= Date.now()) return deps.json(404, { error: "not_found" });
  const body = await deps.readJson(request, 1000);
  if (body.error) return deps.json(400, { error: body.error });
  const emoji = String(body.emoji || "");
  if (!REACTIONS[emoji]) return deps.json(400, { error: "emoji" });
  await env.DB.prepare(
    "INSERT INTO app_story_reactions (story_id, public_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(story_id, public_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at"
  ).bind(id, viewer.public_id, emoji, Date.now()).run();
  return deps.json(200, { ok: true, emoji: emoji });
}

async function handleReply(request, env, viewer, id, deps) {
  const paced = await deps.rateHit(env, "story-reply:" + viewer.public_id, 30, WINDOW_MS);
  if (!paced.ok) return deps.limited(paced);
  const row = await readStory(env, id);
  if (!row || Number(row.expires_at) <= Date.now()) return deps.json(404, { error: "not_found" });
  if (row.public_id !== viewer.public_id && await blocksEither(env, viewer.public_id, row.public_id)) {
    return deps.json(404, { error: "not_found" });
  }
  const body = await deps.readJson(request, 4000);
  if (body.error) return deps.json(400, { error: body.error });
  const text = cleanText(body.text, REPLY_MAX);
  if (!text) return deps.json(400, { error: "text" });
  const replyId = newId();
  await env.DB.prepare(
    "INSERT INTO app_story_replies (id, story_id, public_id, body, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(replyId, id, viewer.public_id, text, Date.now()).run();
  return deps.json(201, { id: replyId });
}

async function handleViews(env, viewer, id, deps) {
  const row = await readStory(env, id);
  if (!row || Number(row.expires_at) <= Date.now()) return deps.json(404, { error: "not_found" });
  if (row.public_id !== viewer.public_id) return deps.json(403, { error: "forbidden" });
  const views = await env.DB.prepare(
    "SELECT a.display_name, a.handle, v.seen_at FROM app_story_views v JOIN accounts a ON a.public_id = v.viewer_id WHERE v.story_id = ? ORDER BY v.seen_at DESC LIMIT 100"
  ).bind(id).all();
  const replies = await env.DB.prepare(
    "SELECT r.body, r.created_at, a.display_name, a.handle FROM app_story_replies r JOIN accounts a ON a.public_id = r.public_id WHERE r.story_id = ? ORDER BY r.created_at DESC LIMIT 50"
  ).bind(id).all();
  return deps.json(200, {
    views: rowsOf(views).map((item) => ({
      name: item.display_name || item.handle || "",
      handle: item.handle || "",
      seenAt: iso(Number(item.seen_at) || 0)
    })),
    replies: rowsOf(replies).map((item) => ({
      name: item.display_name || item.handle || "",
      handle: item.handle || "",
      text: item.body || "",
      date: iso(Number(item.created_at) || 0)
    }))
  });
}

export async function handleAppStories(request, env, path, deps) {
  const file = path.match(/^\/v1\/stories\/file\/([a-f0-9]{64}\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov))$/);
  if (file && (request.method === "GET" || request.method === "HEAD")) {
    const name = file[1];
    if (!FILE_NAME.test(name)) return deps.json(404, { error: "not_found" });
    return sendObject(request, env, "stories/telegram/" + name, fileMime(name));
  }
  const media = path.match(/^\/v1\/stories\/media\/([a-f0-9]{32})$/);
  if (media && (request.method === "GET" || request.method === "HEAD")) {
    const row = await readStory(env, media[1]);
    if (!row || Number(row.expires_at) <= Date.now()) return deps.json(404, { error: "not_found" });
    const viewer = await deps.sessionAccount(env, request);
    const allowed = await canSeeAudience(env, {
      viewerId: viewer ? viewer.public_id : "",
      ownerId: row.public_id,
      audience: row.audience || "public",
      subject: "story",
      subjectId: row.id
    });
    if (!allowed) return deps.json(404, { error: "not_found" });
    return sendObject(request, env, row.r2_key, row.mime);
  }
  const viewer = await deps.sessionAccount(env, request);
  if (path === "/v1/stories" && request.method === "GET") {
    if (!viewer) return deps.json(401, { error: "unauthorized" });
    const paced = await deps.rateHit(env, "story-list:" + viewer.public_id, 120, 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const accounts = await listVisible(env, request, viewer);
    return deps.json(200, { accounts: accounts });
  }
  if (path === "/v1/stories" && request.method === "POST") {
    if (!viewer) return deps.json(401, { error: "unauthorized" });
    return handleCreate(request, env, viewer, deps);
  }
  const one = path.match(/^\/v1\/stories\/([a-f0-9]{32})(?:\/(seen|react|reply|views))?$/);
  if (!one) return null;
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  const id = one[1];
  const action = one[2] || "";
  if (!action && request.method === "DELETE") return handleDelete(env, viewer, id, deps);
  if (action === "seen" && request.method === "POST") return handleSeen(env, viewer, id, deps);
  if (action === "react" && request.method === "POST") return handleReact(request, env, viewer, id, deps);
  if (action === "reply" && request.method === "POST") return handleReply(request, env, viewer, id, deps);
  if (action === "views" && request.method === "GET") return handleViews(env, viewer, id, deps);
  return null;
}

export async function sweepExpiredStories(env, now) {
  const at = Number(now) || Date.now();
  if (env && env.DB) {
    try {
      const expired = await env.DB.prepare(
        "SELECT id, public_id, kind, vine, r2_key, mime, bytes FROM app_stories WHERE expires_at <= ? LIMIT 40"
      ).bind(at).all();
      // Expired stories are archived four at a time.
      await eachLimit(rowsOf(expired), poolWidth(env, 4), async (row) => {
        const archived = "stories/library/" + row.public_id + "/" + row.id;
        if (env.DATA && row.r2_key) {
          try {
            const object = await env.DATA.get(row.r2_key);
            if (object) {
              const bytes = typeof object.arrayBuffer === "function" ? await object.arrayBuffer() : object.body;
              await env.DATA.put(archived, bytes, {
                httpMetadata: { contentType: row.mime || "application/octet-stream", cacheControl: "private, no-store" }
              });
              await env.DB.prepare(
                "INSERT INTO story_library (id, public_id, kind, vine, r2_key, mime, bytes, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'story', ?) ON CONFLICT(id) DO NOTHING"
              ).bind(row.id, row.public_id, row.kind || "photo", row.vine || 0, archived, row.mime || "", Number(row.bytes) || 0, at).run();
            }
          } catch (err) { /* the live row still leaves the bar */ }
        }
        await env.DB.batch([
          env.DB.prepare("DELETE FROM app_story_views WHERE story_id = ?").bind(row.id),
          env.DB.prepare("DELETE FROM app_story_reactions WHERE story_id = ?").bind(row.id),
          env.DB.prepare("DELETE FROM app_story_replies WHERE story_id = ?").bind(row.id),
          env.DB.prepare("DELETE FROM app_stories WHERE id = ?").bind(row.id)
        ]);
        if (env.DATA && row.r2_key && row.r2_key !== archived) {
          try { await env.DATA.delete(row.r2_key); }
          catch (err) { /* the next pass retries */ }
        }
      });
    } catch (err) { /* tables appear on the first request */ }
  }
  if (!env || !env.DATA) return;
  try {
    const object = await env.DATA.get("stories/telegram/manifest.json");
    if (!object) return;
    const doc = JSON.parse(await object.text());
    const items = Array.isArray(doc.items) ? doc.items : [];
    const keep = [];
    const gone = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const key = item && typeof item.key === "string" ? item.key : "";
      if (!/^stories\/telegram\/[a-f0-9]{64}\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov)$/.test(key)) continue;
      if (Number(item.expires) <= at) gone.push(item);
      else keep.push(item);
    }
    // Expired Telegram media is deleted six at a time; a failed delete stays listed.
    await eachLimit(gone, poolWidth(env, 6), async (item) => {
      try { await env.DATA.delete(item.key); }
      catch (err) { keep.push(item); }
    });
    if (keep.length !== items.length) {
      await env.DATA.put("stories/telegram/manifest.json", JSON.stringify({ items: keep }), {
        httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "private, no-store" }
      });
    }
  } catch (err) { /* a missing manifest is the unset-secret case */ }
}
