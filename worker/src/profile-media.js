/* Profile photos and banners.
   Each item has its own audience. Bytes stay in R2 under the account prefix.
   Viewers receive an opaque /v1/media/view/<id> URL only when this request
   is allowed to see that item. The read checks the relationship again. */

import { inspectHandle } from "../../shared/handle-skeleton.js";
import { cleanVisibility, defaultVisibility, pickVisible, viewerCanSee } from "../../shared/profile-privacy.js";
import { isOwnerViewer } from "./owner-view.js";

export const PROFILE_MEDIA_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profile_media (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    object_key TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'everyone',
    is_main INTEGER NOT NULL DEFAULT 0,
    is_fallback INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS profile_media_owner ON profile_media(public_id, kind, sort_order, created_at)",
  `CREATE TABLE IF NOT EXISTS profile_media_exceptions (
    media_id TEXT NOT NULL,
    public_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    PRIMARY KEY (media_id, user_id)
  )`,
  "CREATE INDEX IF NOT EXISTS profile_media_exceptions_owner ON profile_media_exceptions(public_id)",
  "CREATE INDEX IF NOT EXISTS profile_media_exceptions_user ON profile_media_exceptions(user_id)"
];

const PHOTO_CAP = 8;
const BANNER_CAP = 4;
const EXCEPTION_CAP = 40;
const MEDIA_ID = /^[a-f0-9]{32}$/;
const OBJECT_KEY = /^media\/(avatars|banners)\/(\d{12})\/([a-f0-9]{64})\.(webp|jpg|png)$/;

function hex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newId() {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function kindOf(value) {
  const text = String(value || "");
  if (text === "banner" || text === "banners") return "banner";
  if (text === "photo" || text === "photos" || text === "avatar" || text === "avatars") return "photo";
  return "";
}

function slotKind(kind) {
  return kind === "banner" ? "banners" : "avatars";
}

export function viewPath(id) {
  return MEDIA_ID.test(String(id || "")) ? "/v1/media/view/" + id : "";
}

export function viewUrl(request, id) {
  const path = viewPath(id);
  if (!path || !request) return "";
  try { return new URL(path, request.url).toString(); }
  catch (err) { return ""; }
}

function rowsOf(result) {
  return (result && result.results) || [];
}

async function loadExceptions(env, ids) {
  const map = {};
  if (!ids.length) return map;
  const marks = ids.map(() => "?").join(",");
  const listed = await env.DB.prepare(
    "SELECT media_id, user_id, mode FROM profile_media_exceptions WHERE media_id IN (" + marks + ")"
  ).bind(...ids).all();
  rowsOf(listed).forEach((row) => {
    if (!row || !row.media_id) return;
    const bag = map[row.media_id] || (map[row.media_id] = { allow: [], deny: [] });
    if (row.mode === "allow") bag.allow.push(row.user_id);
    else if (row.mode === "deny") bag.deny.push(row.user_id);
  });
  return map;
}

function itemFromRow(row, exceptions) {
  const bag = exceptions[row.id] || { allow: [], deny: [] };
  return {
    id: row.id,
    kind: row.kind === "banner" ? "banner" : "photo",
    objectKey: row.object_key,
    visibility: cleanVisibility(row.visibility, "everyone"),
    main: row.is_main === 1,
    fallback: row.is_fallback === 1,
    order: Number(row.sort_order) || 0,
    createdAt: Number(row.created_at) || 0,
    allow: bag.allow,
    deny: bag.deny
  };
}

async function listItems(env, publicId) {
  const listed = await env.DB.prepare(
    "SELECT id, kind, object_key, visibility, is_main, is_fallback, sort_order, created_at FROM profile_media WHERE public_id = ? ORDER BY sort_order ASC, created_at ASC"
  ).bind(publicId).all();
  const rows = rowsOf(listed);
  const exceptions = await loadExceptions(env, rows.map((row) => row.id));
  return rows.map((row) => itemFromRow(row, exceptions));
}

async function handlesFor(env, ids) {
  const out = {};
  const unique = [];
  ids.forEach((id) => {
    if (/^\d{12}$/.test(String(id || "")) && unique.indexOf(id) < 0) unique.push(id);
  });
  for (let i = 0; i < unique.length; i++) {
    const row = await env.DB.prepare("SELECT handle FROM accounts WHERE public_id = ?").bind(unique[i]).first();
    if (row && row.handle) out[unique[i]] = row.handle;
  }
  return out;
}

export async function relationFor(env, ownerId, viewer) {
  const viewerId = viewer && viewer.public_id ? String(viewer.public_id) : "";
  if (!viewerId) return { owner: false, viewerId: "", follows: false, followedBy: false };
  if (viewerId === ownerId) return { owner: true, viewerId, follows: true, followedBy: true };
  const follows = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(viewerId, "app:" + ownerId).first();
  const followedBy = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(ownerId, "app:" + viewerId).first();
  return { owner: false, viewerId, follows: !!follows, followedBy: !!followedBy };
}

async function ensureLegacy(env, row) {
  if (!row || !env.DB) return;
  const slots = [
    ["photo", row.avatar || ""],
    ["banner", row.banner || ""]
  ];
  const visibility = defaultVisibility(row.private_follows === 1);
  for (let i = 0; i < slots.length; i++) {
    const kind = slots[i][0];
    const key = String(slots[i][1] || "");
    if (!OBJECT_KEY.test(key) || !key.startsWith("media/" + slotKind(kind) + "/" + row.public_id + "/")) continue;
    const found = await env.DB.prepare(
      "SELECT id FROM profile_media WHERE public_id = ? AND kind = ? AND object_key = ?"
    ).bind(row.public_id, kind, key).first();
    if (found) continue;
    const any = await env.DB.prepare(
      "SELECT id FROM profile_media WHERE public_id = ? AND kind = ? LIMIT 1"
    ).bind(row.public_id, kind).first();
    if (any) continue;
    await env.DB.prepare(
      "INSERT INTO profile_media (id, public_id, kind, object_key, visibility, is_main, is_fallback, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)"
    ).bind(newId(), row.public_id, kind, key, visibility, Date.now()).run();
  }
}

function publicItem(item, request, handles, manage) {
  const url = viewUrl(request, item.id);
  const base = {
    id: item.id,
    kind: item.kind,
    url,
    main: !!item.main,
    fallback: !!item.fallback,
    order: item.order
  };
  if (!manage) return base;
  const allow = (item.allow || []).map((id) => handles[id]).filter(Boolean);
  const deny = (item.deny || []).map((id) => handles[id]).filter(Boolean);
  return Object.assign(base, { visibility: item.visibility, allow, deny });
}

export async function applyViewer(env, request, row, account, viewer, own) {
  if (!row || !account || !env.DB) return account;
  await ensureLegacy(env, row);
  const items = await listItems(env, row.public_id);
  // The site owner sees every profile picture and banner, whatever its audience.
  const seeAll = !own && !!(viewer && viewer.public_id) && await isOwnerViewer(env, viewer.public_id, request);
  const rel = own ? { owner: true, viewerId: row.public_id, follows: true, followedBy: true }
    : seeAll ? { owner: true, viewerId: String(viewer.public_id), follows: true, followedBy: true }
    : await relationFor(env, row.public_id, viewer);
  const hiddenFace = !own && !seeAll && (row.hide_avatar === "none" || row.hide_avatar === "default");
  const handles = own ? await handlesFor(env, items.reduce((all, item) => all.concat(item.allow || [], item.deny || []), [])) : {};
  const photos = items.filter((item) => item.kind === "photo");
  const banners = items.filter((item) => item.kind === "banner");
  const shownPhotos = hiddenFace ? { primary: null, gallery: [] } : pickVisible(photos, rel);
  const shownBanners = pickVisible(banners, rel);
  if (!own) {
    account.avatar = shownPhotos.primary ? viewUrl(request, shownPhotos.primary.id) : "";
    account.avatarFace = shownPhotos.primary ? "photo" : (row.hide_avatar === "none" || row.avatar_empty === "none" ? "none" : "default");
    account.banner = shownBanners.primary ? viewUrl(request, shownBanners.primary.id) : "";
    account.bannerFace = shownBanners.primary ? "photo" : (row.banner_empty === "none" ? "none" : "default");
    delete account.publicId;
  }
  account.photos = shownPhotos.gallery.map((item) => publicItem(item, request, handles, !!own));
  account.banners = shownBanners.gallery.map((item) => publicItem(item, request, handles, !!own));
  return account;
}

async function resolveHandle(env, raw) {
  const handle = String(raw || "").trim().replace(/^@/, "");
  if (!handle) return "";
  const checked = inspectHandle(handle);
  const skel = checked && checked.skeleton;
  if (!skel) return "";
  const row = await env.DB.prepare("SELECT public_id FROM accounts WHERE skeleton = ?").bind(skel).first();
  return row && row.public_id ? row.public_id : "";
}

function cleanHandles(list) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    const handle = String(item || "").trim().replace(/^@/, "");
    if (!handle || handle.length > 32 || out.indexOf(handle) >= 0 || out.length >= EXCEPTION_CAP) return;
    out.push(handle);
  });
  return out;
}

async function idsForHandles(env, handles, ownerId) {
  const ids = [];
  for (let i = 0; i < handles.length; i++) {
    const id = await resolveHandle(env, handles[i]);
    if (!id || id === ownerId || ids.indexOf(id) >= 0) continue;
    ids.push(id);
  }
  return ids;
}

async function writeExceptions(env, mediaId, ownerId, allow, deny) {
  await env.DB.prepare("DELETE FROM profile_media_exceptions WHERE media_id = ?").bind(mediaId).run();
  const rows = [];
  allow.forEach((id) => rows.push(["allow", id]));
  deny.forEach((id) => {
    if (allow.indexOf(id) < 0) rows.push(["deny", id]);
  });
  for (let i = 0; i < rows.length; i++) {
    await env.DB.prepare(
      "INSERT INTO profile_media_exceptions (media_id, public_id, user_id, mode) VALUES (?, ?, ?, ?) ON CONFLICT(media_id, user_id) DO UPDATE SET mode = excluded.mode"
    ).bind(mediaId, ownerId, rows[i][1], rows[i][0]).run();
  }
}

async function resequence(env, publicId, kind) {
  const listed = await env.DB.prepare(
    "SELECT id FROM profile_media WHERE public_id = ? AND kind = ? ORDER BY is_main DESC, sort_order ASC, created_at ASC"
  ).bind(publicId, kind).all();
  const rows = rowsOf(listed);
  for (let i = 0; i < rows.length; i++) {
    await env.DB.prepare(
      "UPDATE profile_media SET sort_order = ?, is_main = ? WHERE id = ?"
    ).bind(i, i === 0 ? 1 : 0, rows[i].id).run();
  }
  return rows[0] ? rows[0].id : "";
}

async function syncAccountColumn(env, publicId, kind) {
  const main = await env.DB.prepare(
    "SELECT object_key FROM profile_media WHERE public_id = ? AND kind = ? AND is_main = 1 ORDER BY sort_order ASC LIMIT 1"
  ).bind(publicId, kind).first();
  const key = main && main.object_key ? main.object_key : "";
  if (kind === "banner") {
    await env.DB.prepare("UPDATE accounts SET banner = ? WHERE public_id = ?").bind(key, publicId).run();
  } else {
    await env.DB.prepare("UPDATE accounts SET avatar = ? WHERE public_id = ?").bind(key, publicId).run();
  }
}

function unusedKey(env, publicId, key) {
  return env.DB.prepare(
    "SELECT id FROM profile_media WHERE public_id = ? AND object_key = ? LIMIT 1"
  ).bind(publicId, key).first();
}

export async function rememberSlot(env, row, kindName, objectKey) {
  const kind = kindOf(kindName);
  if (!row || !kind) return;
  const key = String(objectKey || "");
  if (!key) {
    const main = await env.DB.prepare(
      "SELECT id, object_key FROM profile_media WHERE public_id = ? AND kind = ? AND is_main = 1"
    ).bind(row.public_id, kind).first();
    if (main) {
      await env.DB.prepare("DELETE FROM profile_media_exceptions WHERE media_id = ?").bind(main.id).run();
      await env.DB.prepare("DELETE FROM profile_media WHERE id = ?").bind(main.id).run();
      await resequence(env, row.public_id, kind);
      await syncAccountColumn(env, row.public_id, kind);
    }
    return;
  }
  if (!OBJECT_KEY.test(key)) return;
  const existing = await env.DB.prepare(
    "SELECT id FROM profile_media WHERE public_id = ? AND kind = ? AND is_main = 1"
  ).bind(row.public_id, kind).first();
  if (existing) {
    await env.DB.prepare("UPDATE profile_media SET object_key = ? WHERE id = ?").bind(key, existing.id).run();
    return;
  }
  const visibility = defaultVisibility(row.private_follows === 1);
  await env.DB.prepare(
    "INSERT INTO profile_media (id, public_id, kind, object_key, visibility, is_main, is_fallback, sort_order, created_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0, ?)"
  ).bind(newId(), row.public_id, kind, key, visibility, Date.now()).run();
}

export async function addMedia(env, row, kindName, objectKey, visibilityRaw) {
  const kind = kindOf(kindName);
  const key = String(objectKey || "");
  if (!row || !kind || !OBJECT_KEY.test(key)) return { error: "bad_media" };
  const cap = kind === "banner" ? BANNER_CAP : PHOTO_CAP;
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM profile_media WHERE public_id = ? AND kind = ?"
  ).bind(row.public_id, kind).first();
  if (Number(count && count.n) >= cap) return { error: "too_many" };
  const levels = { everyone: 1, followers: 1, friends: 1, nobody: 1 };
  let visibility = defaultVisibility(row.private_follows === 1);
  if (visibilityRaw != null && String(visibilityRaw) !== "") {
    if (!levels[String(visibilityRaw)]) return { error: "bad_visibility" };
    visibility = String(visibilityRaw);
  }
  const first = Number(count && count.n) === 0;
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO profile_media (id, public_id, kind, object_key, visibility, is_main, is_fallback, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)"
  ).bind(id, row.public_id, kind, key, visibility, first ? 1 : 0, first ? 0 : Date.now(), Date.now()).run();
  if (first) await syncAccountColumn(env, row.public_id, kind);
  return { id };
}

export async function updateMedia(env, row, body) {
  if (!row || !body) return { error: "bad_media" };
  const kind = kindOf(body.kind);
  if (Array.isArray(body.order) && kind) {
    const wanted = body.order.map((id) => String(id || "")).filter((id) => MEDIA_ID.test(id));
    const listed = await env.DB.prepare(
      "SELECT id FROM profile_media WHERE public_id = ? AND kind = ?"
    ).bind(row.public_id, kind).all();
    const have = rowsOf(listed).map((item) => item.id);
    const next = wanted.filter((id) => have.indexOf(id) >= 0);
    have.forEach((id) => { if (next.indexOf(id) < 0) next.push(id); });
    for (let i = 0; i < next.length; i++) {
      await env.DB.prepare("UPDATE profile_media SET sort_order = ?, is_main = ? WHERE id = ? AND public_id = ?").bind(i, i === 0 ? 1 : 0, next[i], row.public_id).run();
    }
    await syncAccountColumn(env, row.public_id, kind);
  }
  const id = String(body.id || "");
  if (!MEDIA_ID.test(id)) return Array.isArray(body.order) ? { ok: true } : { error: "bad_media" };
  const current = await env.DB.prepare(
    "SELECT id, kind, object_key FROM profile_media WHERE id = ? AND public_id = ?"
  ).bind(id, row.public_id).first();
  if (!current) return { error: "not_found" };
  if (body.visibility != null) {
    const levels = { everyone: 1, followers: 1, friends: 1, nobody: 1 };
    if (!levels[String(body.visibility)]) return { error: "bad_visibility" };
    await env.DB.prepare("UPDATE profile_media SET visibility = ? WHERE id = ?").bind(String(body.visibility), id).run();
  }
  if (body.main === true) {
    await env.DB.prepare(
      "UPDATE profile_media SET is_main = 0, sort_order = sort_order + 1 WHERE public_id = ? AND kind = ?"
    ).bind(row.public_id, current.kind).run();
    await env.DB.prepare("UPDATE profile_media SET is_main = 1, sort_order = 0 WHERE id = ?").bind(id).run();
    await syncAccountColumn(env, row.public_id, current.kind);
  }
  if (body.fallback === true || body.fallback === false) {
    if (body.fallback === true) {
      await env.DB.prepare(
        "UPDATE profile_media SET is_fallback = 0 WHERE public_id = ? AND kind = ?"
      ).bind(row.public_id, current.kind).run();
    }
    await env.DB.prepare("UPDATE profile_media SET is_fallback = ? WHERE id = ?").bind(body.fallback ? 1 : 0, id).run();
  }
  if (body.allow != null || body.deny != null) {
    const allow = await idsForHandles(env, cleanHandles(body.allow), row.public_id);
    const deny = await idsForHandles(env, cleanHandles(body.deny), row.public_id);
    const denyOnly = deny.filter((userId) => allow.indexOf(userId) < 0);
    await writeExceptions(env, id, row.public_id, allow, denyOnly);
  }
  return { ok: true };
}

export async function removeMedia(env, row, rawId) {
  const id = String(rawId || "");
  if (!row || !MEDIA_ID.test(id)) return { error: "bad_media" };
  const current = await env.DB.prepare(
    "SELECT id, kind, object_key, is_main FROM profile_media WHERE id = ? AND public_id = ?"
  ).bind(id, row.public_id).first();
  if (!current) return { error: "not_found" };
  await env.DB.prepare("DELETE FROM profile_media_exceptions WHERE media_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM profile_media WHERE id = ?").bind(id).run();
  await resequence(env, row.public_id, current.kind);
  await syncAccountColumn(env, row.public_id, current.kind);
  const still = await unusedKey(env, row.public_id, current.object_key);
  if (!still && env.DATA && OBJECT_KEY.test(current.object_key)) {
    try { await env.DATA.delete(current.object_key); }
    catch (err) { /* the row is already gone */ }
  }
  return { ok: true, kind: current.kind };
}

async function itemVisible(env, viewer, row) {
  if (!row) return false;
  const rel = await relationFor(env, row.public_id, viewer);
  if (rel.owner) return true;
  if (viewer && viewer.public_id && await isOwnerViewer(env, viewer.public_id)) return true;
  if (row.kind === "photo") {
    const owner = await env.DB.prepare("SELECT hide_avatar FROM accounts WHERE public_id = ?").bind(row.public_id).first();
    if (owner && (owner.hide_avatar === "none" || owner.hide_avatar === "default")) return false;
  }
  const exceptions = await loadExceptions(env, [row.id]);
  const item = itemFromRow(row, exceptions);
  const items = await listItems(env, row.public_id);
  const same = items.filter((entry) => entry.kind === item.kind);
  const picked = pickVisible(same, rel);
  return picked.gallery.some((entry) => entry.id === row.id);
}

export async function readView(env, request, viewer, mediaId) {
  if (!MEDIA_ID.test(String(mediaId || ""))) return { status: 404 };
  if (!viewer) return { status: 401 };
  const row = await env.DB.prepare(
    "SELECT id, public_id, kind, object_key, visibility, is_main, is_fallback, sort_order, created_at FROM profile_media WHERE id = ?"
  ).bind(mediaId).first();
  if (!row || !OBJECT_KEY.test(row.object_key)) return { status: 404 };
  if (!(await itemVisible(env, viewer, row))) return { status: 404 };
  if (!env.DATA) return { status: 503 };
  const object = await env.DATA.get(row.object_key);
  if (!object) return { status: 404 };
  return { status: 200, row, object };
}

export async function objectAllowed(env, viewer, ownerId, objectKey) {
  if (!viewer || viewer.public_id === ownerId) return true;
  if (!OBJECT_KEY.test(String(objectKey || ""))) return false;
  const owner = await env.DB.prepare("SELECT public_id, avatar, banner, hide_avatar, private_follows FROM accounts WHERE public_id = ?").bind(ownerId).first();
  if (!owner) return false;
  await ensureLegacy(env, owner);
  const match = await env.DB.prepare(
    "SELECT id, public_id, kind, object_key, visibility, is_main, is_fallback, sort_order, created_at FROM profile_media WHERE public_id = ? AND object_key = ?"
  ).bind(ownerId, objectKey).first();
  if (!match) return false;
  return itemVisible(env, viewer, match);
}

export function mediaHeaders(row, type, size, hasExceptions) {
  const open = !!(row && row.visibility === "everyone" && !hasExceptions);
  const headers = {
    "content-type": type || "application/octet-stream",
    "cache-control": "private, no-store",
    "cdn-cache-control": "no-store",
    "x-media-access": open ? "public" : "restricted",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex"
  };
  if (size) headers["content-length"] = String(size);
  return headers;
}

/* The author face a post shows this viewer: the photo they may see (a
   /v1/media/view URL, never the storage key), the protected lock and the
   official badge, the same as that profile's name row. One lookup per author
   per request. */
const faceMemo = new WeakMap();
export async function postAuthorFace(env, request, viewerId, authorId) {
  const id = String(authorId || "");
  const empty = { avatar: "", locked: false, official: false };
  if (!id || !env.DB) return empty;
  let memo = request && typeof request === "object" ? faceMemo.get(request) : null;
  if (!memo && request && typeof request === "object") { memo = new Map(); faceMemo.set(request, memo); }
  const key = String(viewerId || "") + ">" + id;
  if (memo && memo.has(key)) return memo.get(key);
  const work = (async () => {
    const row = await env.DB.prepare(
      "SELECT public_id, handle, avatar, banner, hide_avatar, avatar_empty, banner_empty, private_follows, protected_account, owner FROM accounts WHERE public_id = ?"
    ).bind(id).first();
    if (!row) return empty;
    const account = { avatar: "", banner: "", photos: [], banners: [] };
    const own = !!viewerId && String(viewerId) === row.public_id;
    try { await applyViewer(env, request, row, account, viewerId ? { public_id: String(viewerId) } : null, own); }
    catch (err) { account.avatar = ""; }
    const face = {
      avatar: own ? (((account.photos.find((item) => item.main) || account.photos[0]) || {}).url || "") : (account.avatar || ""),
      locked: Number(row.private_follows) === 1 || Number(row.protected_account) === 1,
      official: Number(row.owner) === 1
    };
    if (face.avatar && !/\/v1\/media\/view\//.test(face.avatar)) face.avatar = "";
    return face;
  })().catch(() => empty);
  if (memo) memo.set(key, work);
  return work;
}

export async function visibleAvatarUrl(env, request, viewer, handle) {
  const checked = inspectHandle(String(handle || "").replace(/^@/, ""));
  if (!checked || !checked.skeleton || !env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT public_id, handle, avatar, banner, hide_avatar, avatar_empty, banner_empty, private_follows FROM accounts WHERE skeleton = ?"
  ).bind(checked.skeleton).first();
  if (!row) return null;
  const account = { avatar: "", banner: "", photos: [], banners: [] };
  await applyViewer(env, request, row, account, viewer, !!(viewer && viewer.public_id === row.public_id));
  return account.avatar || "";
}
