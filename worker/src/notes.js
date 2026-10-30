/* Short notes above the story avatars. One note per account.
   The worker decides who may see it. A note is not a story. */

import { friendshipLive } from "./friends-pref.js";
import { inspectHandle } from "../../shared/handle-skeleton.js";
import { blocksEither, actorHidden } from "./social.js";
import { notLocked } from "./locked-sql.js";
import { canSeeAudience, normalizeAudience, setListGrants, grantsFor } from "./audience.js";
import { emitNotification } from "./notifications.js";

export const NOTES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profile_notes (
    public_id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'followers',
    expires_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profile_note_reactions (
    public_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (public_id, sender_id)
  )`
];

const DAY = 24 * 60 * 60 * 1000;
const NOTE_MAX = 60;
const REPLY_MAX = 280;
const AUDIENCES = { followers: 1, friends: 1, only: 1 };
const EMOJIS = { "❤": 1, "🔥": 1, "👏": 1, "😂": 1, "😮": 1, "😢": 1, "👍": 1 };
const PUBLIC_ID = /^\d{12}$/;

function rowsOf(result) {
  return (result && result.results) || [];
}

function chars(value) {
  return Array.from(String(value || ""));
}

function cleanNote(value) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text || chars(text).length > NOTE_MAX) return "";
  return text;
}

function cleanReply(value) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  return chars(text).slice(0, REPLY_MAX).join("");
}

function live(row, now) {
  const end = Number(row && row.expires_at) || 0;
  return !end || end > now;
}

function safeAvatar(value) {
  const text = String(value || "");
  if (/^https:\/\/[^\s"]+$/i.test(text)) return text;
  if (text.indexOf("/v1/media/") === 0 || text.indexOf("media/avatars/") === 0) return text;
  return "";
}

async function accountByHandle(env, handle) {
  const checked = inspectHandle(String(handle || "").replace(/^@/, ""));
  if (!checked.ok) return null;
  return env.DB.prepare(
    "SELECT public_id, handle, display_name, avatar, profile_less FROM accounts WHERE skeleton = ?"
  ).bind(checked.skeleton).first();
}

async function follows(env, followerId, targetId) {
  const row = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(followerId, "app:" + targetId).first();
  return !!row;
}

async function mutual(env, leftId, rightId) {
  const row = await env.DB.prepare(
    "SELECT user_id FROM account_friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)"
  ).bind(leftId, rightId, rightId, leftId).first();
  if (row && await friendshipLive(env, leftId, rightId)) return true;
  return (await follows(env, leftId, rightId)) && (await follows(env, rightId, leftId));
}

async function canSee(env, viewerId, row, now) {
  if (!row || !live(row, now)) return false;
  if (row.profile_less === 1 && viewerId !== row.public_id) return false;
  if (viewerId === row.public_id) return true;
  if (await blocksEither(env, viewerId, row.public_id)) return false;
  if (!(await follows(env, viewerId, row.public_id))) return false;
  return canSeeAudience(env, {
    viewerId: viewerId,
    ownerId: row.public_id,
    audience: row.audience || "followers",
    subject: "note",
    subjectId: row.public_id,
    profileLess: row.profile_less === 1
  });
}

async function present(env, row, mine) {
  const item = {
    handle: row.handle || "",
    name: row.display_name || row.handle || "",
    text: row.body || "",
    avatar: safeAvatar(row.avatar)
  };
  if (mine) {
    item.audience = row.audience || "followers";
    item.expiresAt = Number(row.expires_at) || 0;
    item.listIds = await grantsFor(env, row.public_id, "note", row.public_id);
  }
  return item;
}

async function loadNote(env, publicId) {
  return env.DB.prepare(
    "SELECT n.public_id, n.body, n.audience, n.expires_at, a.handle, a.display_name, a.avatar, a.profile_less FROM profile_notes n JOIN accounts a ON a.public_id = n.public_id WHERE n.public_id = ?"
  ).bind(publicId).first();
}

export async function sweepExpiredNotes(env, now) {
  const at = Number(now) || Date.now();
  const listed = await env.DB.prepare(
    "SELECT public_id FROM profile_notes WHERE expires_at > 0 AND expires_at <= ? LIMIT 200"
  ).bind(at).all();
  const ids = rowsOf(listed).map((row) => row.public_id).filter((id) => PUBLIC_ID.test(String(id || "")));
  if (!ids.length) return { removed: 0 };
  const marks = ids.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM profile_note_reactions WHERE public_id IN (" + marks + ")").bind(...ids),
    env.DB.prepare("DELETE FROM profile_notes WHERE public_id IN (" + marks + ")").bind(...ids)
  ]);
  return { removed: ids.length };
}

async function listNotes(env, viewer) {
  const now = Date.now();
  const mineRow = await loadNote(env, viewer.public_id);
  const mine = mineRow && live(mineRow, now) ? await present(env, mineRow, true) : null;
  const followed = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id LIKE 'app:%'" + notLocked("account_follows") + " LIMIT 200"
  ).bind(viewer.public_id).all();
  const ids = [];
  rowsOf(followed).forEach((row) => {
    const id = String(row.target_id || "").slice(4);
    if (PUBLIC_ID.test(id) && id !== viewer.public_id && ids.indexOf(id) < 0) ids.push(id);
  });
  const notes = [];
  for (let i = 0; i < ids.length; i++) {
    const row = await loadNote(env, ids[i]);
    if (await canSee(env, viewer.public_id, row, now)) notes.push(await present(env, row, false));
  }
  return { mine: mine, notes: notes };
}

export async function handleNotes(request, env, path, deps) {
  if (path !== "/v1/notes" && path !== "/v1/notes/react" && path !== "/v1/notes/reply") return null;
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  if (path === "/v1/notes" && request.method === "GET") {
    return deps.json(200, await listNotes(env, viewer));
  }
  if (path === "/v1/notes" && request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM profile_note_reactions WHERE public_id = ?").bind(viewer.public_id),
      env.DB.prepare("DELETE FROM profile_notes WHERE public_id = ?").bind(viewer.public_id)
    ]);
    return deps.json(200, { ok: true });
  }
  if (path === "/v1/notes" && request.method === "PUT") {
    const paced = await deps.rateHit(env, "note:" + viewer.public_id, 30, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const text = cleanNote(body.text);
    if (!text) return deps.json(400, { error: "text" });
    const audience = normalizeAudience(body.audience) || "followers";
    const now = Date.now();
    const expires = body.expire === false || body.expire === 0 ? 0 : now + DAY;
    await env.DB.prepare(
      "INSERT INTO profile_notes (public_id, body, audience, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET body = excluded.body, audience = excluded.audience, expires_at = excluded.expires_at, updated_at = excluded.updated_at"
    ).bind(viewer.public_id, text, audience, expires, now, now).run();
    if (audience === "list") await setListGrants(env, viewer.public_id, "note", viewer.public_id, body.listIds);
    else await setListGrants(env, viewer.public_id, "note", viewer.public_id, []);
    const stories = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_stories WHERE public_id = ?").bind(viewer.public_id).first();
    return deps.json(200, { ok: true, stories: Number(stories && stories.n) || 0 });
  }
  if (request.method !== "POST") return null;
  const paced = await deps.rateHit(env, "note-act:" + viewer.public_id, 40, 60 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const body = await deps.readJson(request, 4000);
  if (body.error) return deps.json(400, { error: body.error });
  const author = await accountByHandle(env, body.handle);
  if (!author || author.public_id === viewer.public_id) return deps.json(404, { error: "not_found" });
  const row = await loadNote(env, author.public_id);
  if (!(await canSee(env, viewer.public_id, row, Date.now()))) return deps.json(404, { error: "not_found" });
  if (path === "/v1/notes/react") {
    const emoji = String(body.emoji || "");
    if (!EMOJIS[emoji]) return deps.json(400, { error: "emoji" });
    await env.DB.prepare(
      "INSERT INTO profile_note_reactions (public_id, sender_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(public_id, sender_id) DO UPDATE SET emoji = excluded.emoji, created_at = excluded.created_at"
    ).bind(author.public_id, viewer.public_id, emoji, Date.now()).run();
    return deps.json(200, { ok: true });
  }
  const text = cleanReply(body.text);
  if (!text) return deps.json(400, { error: "text" });
  const id = "dm_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO account_messages (id, sender_id, recipient_id, body, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 0)"
  ).bind(id, viewer.public_id, author.public_id, text, now).run();
  if (!(await actorHidden(env, author.public_id, viewer.public_id))) {
    try {
      await emitNotification(env, {
        publicId: author.public_id,
        kind: "dm",
        at: now,
        actorId: viewer.public_id,
        idempotencyKey: "note-reply:" + id,
        handle: viewer.handle,
        name: viewer.display_name,
        text: text.slice(0, 180),
        hash: "#/messages",
        platform: "app"
      });
    } catch (err) { /* the message is saved */ }
  }
  return deps.json(201, { ok: true, id: id });
}
