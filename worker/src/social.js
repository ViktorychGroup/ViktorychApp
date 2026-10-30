/* Follow requests, blocks, mutes, and who can see an internal account.
   Blocks and mutes are enforced here. The page only reflects the result.
   A schema miss does not hide a note: actorHidden stays false when the
   tables are not ready, so a transient error cannot drop mail. */

import { tempDmGate } from "./temp-accounts.js";
import { viewerDisplay } from "./name-rules.js";

import { notLocked, isLockedFollow, lockedAccountSet } from "./locked-sql.js";
import { grantOk, ownerSees, auditOwnerView } from "./locked-follows.js";
import { resolveName } from "./usernames.js";

export const SOCIAL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS account_blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  )`,
  "CREATE INDEX IF NOT EXISTS account_blocks_blocked ON account_blocks(blocked_id)",
  `CREATE TABLE IF NOT EXISTS account_mutes (
    muter_id TEXT NOT NULL,
    muted_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (muter_id, muted_id)
  )`,
  `CREATE TABLE IF NOT EXISTS account_follow_requests (
    requester_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (requester_id, target_id)
  )`,
  "CREATE INDEX IF NOT EXISTS account_follow_requests_target ON account_follow_requests(target_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS account_content (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS account_content_author ON account_content(author_id, created_at DESC)",
  `CREATE TABLE IF NOT EXISTS account_messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS account_messages_pair ON account_messages(sender_id, recipient_id, created_at DESC)"
];

const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;

function cleanPublicId(raw) {
  const text = String(raw || "").trim();
  if (text.indexOf("app:") === 0) return /^\d{12}$/.test(text.slice(4)) ? text.slice(4) : "";
  return /^\d{12}$/.test(text) ? text : "";
}

function clip(value, max) {
  return Array.from(String(value || "")).slice(0, max).join("");
}

function cleanBody(value) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text || Array.from(text).length > 500) return "";
  return text;
}

function newKey(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return prefix + hex;
}

function pageLimit(url) {
  const n = Number(url && url.searchParams ? url.searchParams.get("limit") : PAGE_DEFAULT);
  if (!Number.isFinite(n) || n <= 0) return PAGE_DEFAULT;
  return Math.max(1, Math.min(PAGE_MAX, Math.floor(n)));
}

function likeTerm(raw) {
  const text = String(raw || "").replace(/[%_\\]/g, "").trim().slice(0, 40).toLowerCase();
  return text ? "%" + text + "%" : "";
}

// People search keeps "_" (handles use it) by escaping LIKE wildcards; "@" is dropped.
function peopleTerm(raw) {
  const text = String(raw || "").trim().replace(/^@+/, "").slice(0, 40).toLowerCase();
  return text ? { core: text, like: "%" + text.replace(/[%_\\]/g, (c) => "\\" + c) + "%" } : null;
}

function encodeCursor(at, id) {
  const text = String(Number(at) || 0) + "\n" + String(id || "");
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 200) return null;
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
    const decoded = atob(padded);
    const cut = decoded.indexOf("\n");
    if (cut < 1) return null;
    const at = Number(decoded.slice(0, cut));
    const id = decoded.slice(cut + 1);
    if (!Number.isFinite(at) || !id || id.length > 120) return null;
    return { at, id };
  } catch (err) {
    return null;
  }
}

async function one(env, sql, ...args) {
  return env.DB.prepare(sql).bind(...args).first();
}

export async function blocksEither(env, leftId, rightId) {
  if (!leftId || !rightId || leftId === rightId) return false;
  try {
    const row = await one(
      env,
      "SELECT blocker_id FROM account_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1",
      leftId, rightId, rightId, leftId
    );
    return !!row;
  } catch (err) {
    return false;
  }
}

export async function pairState(env, viewerId, targetId) {
  const empty = {
    following: false,
    followsYou: false,
    pending: false,
    incoming: false,
    friends: false,
    viewerBlocks: false,
    blockedBy: false,
    muted: false,
    protected: false
  };
  if (!viewerId || !targetId || viewerId === targetId) return empty;
  try {
    const appTarget = "app:" + targetId;
    const appViewer = "app:" + viewerId;
    const following = await one(env, "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?", viewerId, appTarget);
    const followsYou = await one(env, "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?", targetId, appViewer);
    const pending = await one(env, "SELECT requester_id FROM account_follow_requests WHERE requester_id = ? AND target_id = ?", viewerId, targetId);
    const incoming = await one(env, "SELECT requester_id FROM account_follow_requests WHERE requester_id = ? AND target_id = ?", targetId, viewerId);
    const friends = await one(env, "SELECT friend_id FROM account_friends WHERE user_id = ? AND friend_id = ?", viewerId, targetId);
    const viewerBlocks = await one(env, "SELECT blocked_id FROM account_blocks WHERE blocker_id = ? AND blocked_id = ?", viewerId, targetId);
    const blockedBy = await one(env, "SELECT blocker_id FROM account_blocks WHERE blocker_id = ? AND blocked_id = ?", targetId, viewerId);
    const muted = await one(env, "SELECT muted_id FROM account_mutes WHERE muter_id = ? AND muted_id = ?", viewerId, targetId);
    const account = await one(env, "SELECT protected_account FROM accounts WHERE public_id = ?", targetId);
    return {
      following: !!following,
      followsYou: !!followsYou,
      pending: !!pending,
      incoming: !!incoming,
      friends: !!friends,
      viewerBlocks: !!viewerBlocks,
      blockedBy: !!blockedBy,
      muted: !!muted,
      protected: !!(account && account.protected_account === 1)
    };
  } catch (err) {
    return empty;
  }
}

export async function actorHidden(env, recipientId, actorId) {
  if (!recipientId || !actorId || recipientId === actorId) return false;
  if (!/^\d{12}$/.test(recipientId) || !/^\d{12}$/.test(actorId)) return false;
  try {
    const blocked = await blocksEither(env, recipientId, actorId);
    if (blocked) return true;
    const muted = await one(env, "SELECT muted_id FROM account_mutes WHERE muter_id = ? AND muted_id = ?", recipientId, actorId);
    return !!muted;
  } catch (err) {
    return false;
  }
}

export async function canSeePosts(env, viewerId, authorId) {
  if (!viewerId || !authorId) return false;
  if (viewerId === authorId) return true;
  const state = await pairState(env, viewerId, authorId);
  if (state.viewerBlocks || state.blockedBy || state.muted) return false;
  if (state.protected && !state.following && !state.friends) return false;
  return true;
}

export async function canMention(env, actorId, targetId) {
  if (!actorId || !targetId || actorId === targetId) return false;
  if (await actorHidden(env, targetId, actorId)) return false;
  const state = await pairState(env, actorId, targetId);
  if (state.viewerBlocks || state.blockedBy) return false;
  if (!state.protected) return true;
  return !!(state.followsYou || state.following || state.friends);
}

export async function hiddenAuthorSet(env, viewerId, authorIds) {
  const hidden = new Set();
  const ids = Array.isArray(authorIds) ? authorIds : [];
  for (let i = 0; i < ids.length; i++) {
    const id = String(ids[i] || "");
    if (!/^\d{12}$/.test(id) || id === viewerId) continue;
    if (!(await canSeePosts(env, viewerId, id))) hidden.add(id);
  }
  return hidden;
}

async function severPair(env, leftId, rightId) {
  const appLeft = "app:" + leftId;
  const appRight = "app:" + rightId;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_follows WHERE (follower_id = ? AND target_id = ?) OR (follower_id = ? AND target_id = ?)").bind(leftId, appRight, rightId, appLeft),
    env.DB.prepare("DELETE FROM account_follow_requests WHERE (requester_id = ? AND target_id = ?) OR (requester_id = ? AND target_id = ?)").bind(leftId, rightId, rightId, leftId),
    env.DB.prepare("DELETE FROM account_friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)").bind(leftId, rightId, rightId, leftId),
    env.DB.prepare("DELETE FROM account_friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)").bind(leftId, rightId, rightId, leftId),
    env.DB.prepare("DELETE FROM notifications WHERE (public_id = ? AND actor_id = ?) OR (public_id = ? AND actor_id = ?)").bind(leftId, rightId, rightId, leftId)
  ]);
}

export async function prepareFollowPut(env, viewerId, targetFollowId) {
  if (String(targetFollowId || "").indexOf("app:") !== 0) return { mode: "follow" };
  const targetId = cleanPublicId(targetFollowId);
  if (!targetId) return { mode: "missing" };
  const state = await pairState(env, viewerId, targetId);
  if (state.viewerBlocks || state.blockedBy) return { mode: "blocked" };
  if (state.following) return { mode: "already" };
  if (state.protected) {
    if (state.pending) return { mode: "pending-exists" };
    return { mode: "request" };
  }
  return { mode: "follow" };
}

export async function insertFollowRequest(env, viewerId, targetId) {
  const now = Date.now();
  const existing = await one(env, "SELECT created_at FROM account_follow_requests WHERE requester_id = ? AND target_id = ?", viewerId, targetId);
  if (existing) return { created: false };
  await env.DB.prepare("INSERT INTO account_follow_requests (requester_id, target_id, created_at) VALUES (?, ?, ?)").bind(viewerId, targetId, now).run();
  return { created: true };
}

export async function deleteOutgoingRequest(env, viewerId, targetId) {
  await env.DB.prepare("DELETE FROM account_follow_requests WHERE requester_id = ? AND target_id = ?").bind(viewerId, targetId).run();
}

export async function acceptFollowRequest(env, viewerId, requesterId) {
  const existing = await one(env, "SELECT created_at FROM account_follow_requests WHERE requester_id = ? AND target_id = ?", requesterId, viewerId);
  if (!existing) return { ok: false };
  const now = Date.now();
  const target = "app:" + viewerId;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM account_follow_requests WHERE requester_id = ? AND target_id = ?").bind(requesterId, viewerId),
    env.DB.prepare("INSERT INTO account_follows (follower_id, target_id, snapshot, created_at) VALUES (?, ?, '', ?) ON CONFLICT(follower_id, target_id) DO NOTHING").bind(requesterId, target, now)
  ]);
  return { ok: true };
}

export async function declineFollowRequest(env, viewerId, requesterId) {
  await env.DB.prepare("DELETE FROM account_follow_requests WHERE requester_id = ? AND target_id = ?").bind(requesterId, viewerId).run();
}

export async function removeFollower(env, viewerId, followerId) {
  await env.DB.prepare("DELETE FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(followerId, "app:" + viewerId).run();
  await env.DB.prepare("DELETE FROM account_follow_requests WHERE requester_id = ? AND target_id = ?").bind(followerId, viewerId).run();
}

export async function applyBlock(env, viewerId, targetId) {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO account_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT(blocker_id, blocked_id) DO NOTHING").bind(viewerId, targetId, now).run();
  await severPair(env, viewerId, targetId);
}

export async function clearBlock(env, viewerId, targetId) {
  await env.DB.prepare("DELETE FROM account_blocks WHERE blocker_id = ? AND blocked_id = ?").bind(viewerId, targetId).run();
}

export async function applyMute(env, viewerId, targetId) {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO account_mutes (muter_id, muted_id, created_at) VALUES (?, ?, ?) ON CONFLICT(muter_id, muted_id) DO NOTHING").bind(viewerId, targetId, now).run();
}

export async function clearMute(env, viewerId, targetId) {
  await env.DB.prepare("DELETE FROM account_mutes WHERE muter_id = ? AND muted_id = ?").bind(viewerId, targetId).run();
}

export function blockedProfile(account) {
  return {
    publicId: account.publicId,
    handle: account.handle || "",
    displayName: account.displayName || "",
    blockedBy: true,
    owner: false,
    protected: account.protected === true,
    identities: []
  };
}

export function stripBlockedView(account) {
  account.viewerBlocks = true;
  account.bio = "";
  account.location = "";
  account.website = "";
  account.avatar = "";
  account.banner = "";
  account.identities = [];
  account.followersCount = 0;
  account.followingCount = 0;
  account.friendsCount = 0;
  return account;
}

export async function importAllowed(env, viewerId, followId) {
  if (String(followId || "").indexOf("app:") !== 0) return true;
  const targetId = cleanPublicId(followId);
  if (!targetId || targetId === viewerId) return false;
  try {
    const account = await one(env, "SELECT public_id, profile_less, protected_account FROM accounts WHERE public_id = ?", targetId);
    if (!account || account.profile_less === 1) return false;
    if (account.protected_account === 1) return false;
    if (await blocksEither(env, viewerId, targetId)) return false;
    return true;
  } catch (err) {
    return false;
  }
}

function cursorClause(cursor, atColumn, idColumn) {
  if (!cursor) return { sql: "", args: [] };
  return {
    sql: " AND (" + atColumn + " < ? OR (" + atColumn + " = ? AND " + idColumn + " > ?))",
    args: [cursor.at, cursor.at, cursor.id]
  };
}

export async function readFollowRows(env, viewer, account, subject, tab, url) {
  const limit = pageLimit(url);
  const q = likeTerm(url.searchParams.get("q") || "");
  const cursor = decodeCursor(url.searchParams.get("cursor") || "");
  const viewerId = viewer.public_id;
  const ownerId = account ? account.public_id : "";
  const isOwner = !!(account && ownerId === viewerId);
  // The app owner reads the real list, locked follows included (audited by
  // the caller). Everyone else, the account itself included, never sees them.
  const lockSql = (alias) => (ownerSees(viewer, ownerId) ? "" : notLocked(alias));
  if (tab === "requests") {
    if (!isOwner) return { rows: [], cursor: "", denied: "private" };
    const clause = cursorClause(cursor, "r.created_at", "r.requester_id");
    const term = q || "%";
    const listed = await env.DB.prepare(
      "SELECT r.requester_id AS id, r.created_at FROM account_follow_requests r JOIN accounts a ON a.public_id = r.requester_id WHERE r.target_id = ? AND (? = '' OR lower(a.handle) LIKE ? OR lower(a.display_name) LIKE ?)" + clause.sql + " ORDER BY r.created_at DESC, r.requester_id ASC LIMIT ?"
    ).bind(viewerId, q, term, term, ...clause.args, limit + 1).all();
    return pageRows((listed && listed.results) || [], limit, "account");
  }
  if (!account && tab !== "followers") return { rows: [], cursor: "", denied: "" };
  if (account) {
    const state = isOwner ? null : await pairState(env, viewerId, ownerId);
    if (state && (state.viewerBlocks || state.blockedBy)) return { rows: [], cursor: "", denied: "blocked" };
    if (!isOwner && account.private_follows === 1) return { rows: [], cursor: "", denied: "private" };
    if (state && state.protected && !state.following && !state.friends) return { rows: [], cursor: "", denied: "locked" };
  }
  if (tab === "mutuals") {
    if (!account) return { rows: [], cursor: "", denied: "" };
    const clause = cursorClause(cursor, "f1.created_at", "f1.target_id");
    const term = q || "%";
    const listed = await env.DB.prepare(
      "SELECT f1.target_id AS id, f1.created_at FROM account_follows f1 JOIN account_follows f2 ON f2.follower_id = substr(f1.target_id, 5) AND f2.target_id = ('app:' || f1.follower_id) LEFT JOIN accounts a ON f1.target_id = ('app:' || a.public_id) WHERE f1.follower_id = ? AND f1.target_id LIKE 'app:%'" + lockSql("f1") + " AND (? = '' OR lower(coalesce(a.handle, '')) LIKE ? OR lower(coalesce(a.display_name, '')) LIKE ?)" + clause.sql + " ORDER BY f1.created_at DESC, f1.target_id ASC LIMIT ?"
    ).bind(ownerId, q, term, term, ...clause.args, limit + 1).all();
    return pageRows((listed && listed.results) || [], limit, "account-target");
  }
  if (tab === "followers") {
    const clause = cursorClause(cursor, "f.created_at", "f.follower_id");
    const term = q || "%";
    const listed = await env.DB.prepare(
      "SELECT f.follower_id AS id, f.created_at FROM account_follows f JOIN accounts a ON a.public_id = f.follower_id WHERE f.target_id = ? AND (? = '' OR lower(a.handle) LIKE ? OR lower(a.display_name) LIKE ?)" + clause.sql + " ORDER BY f.created_at DESC, f.follower_id ASC LIMIT ?"
    ).bind(subject, q, term, term, ...clause.args, limit + 1).all();
    return pageRows((listed && listed.results) || [], limit, "account");
  }
  const clause = cursorClause(cursor, "f.created_at", "f.target_id");
  const term = q || "%";
  const listed = await env.DB.prepare(
    "SELECT f.target_id AS id, f.snapshot, f.created_at FROM account_follows f LEFT JOIN accounts a ON f.target_id = ('app:' || a.public_id) WHERE f.follower_id = ?" + lockSql("f") + " AND (? = '' OR lower(coalesce(a.handle, '')) LIKE ? OR lower(coalesce(a.display_name, '')) LIKE ? OR lower(coalesce(f.snapshot, '')) LIKE ? OR lower(f.target_id) LIKE ?)" + clause.sql + " ORDER BY f.created_at DESC, f.target_id ASC LIMIT ?"
  ).bind(ownerId, q, term, term, term, term, ...clause.args, limit + 1).all();
  return pageRows((listed && listed.results) || [], limit, "mixed");
}

function pageRows(rows, limit, kind) {
  const more = rows.length > limit;
  const slice = more ? rows.slice(0, limit) : rows;
  const last = slice[slice.length - 1];
  return {
    rows: slice.map((row) => ({ id: row.id, snapshot: row.snapshot || "", kind })),
    cursor: more && last ? encodeCursor(last.created_at, last.id) : "",
    denied: ""
  };
}

export async function outgoingRequestIds(env, viewerId) {
  try {
    const listed = await env.DB.prepare("SELECT target_id FROM account_follow_requests WHERE requester_id = ? ORDER BY created_at DESC LIMIT 100").bind(viewerId).all();
    return ((listed && listed.results) || []).map((row) => "app:" + row.target_id);
  } catch (err) {
    return [];
  }
}

export async function requestCount(env, viewerId) {
  try {
    const row = await one(env, "SELECT COUNT(*) AS n FROM account_follow_requests WHERE target_id = ?", viewerId);
    return Number(row && row.n) || 0;
  } catch (err) {
    return 0;
  }
}

export async function followsYouSet(env, viewerId, publicIds) {
  const set = new Set();
  const ids = (publicIds || []).filter((id) => /^\d{12}$/.test(id) && id !== viewerId);
  if (!ids.length) return set;
  const marks = ids.map(() => "?").join(",");
  try {
    const listed = await env.DB.prepare("SELECT follower_id FROM account_follows WHERE target_id = ? AND follower_id IN (" + marks + ")").bind("app:" + viewerId, ...ids).all();
    ((listed && listed.results) || []).forEach((row) => set.add(row.follower_id));
  } catch (err) { /* badge can be absent */ }
  return set;
}

export async function listRelationIds(env, viewerId, table, ownerCol, otherCol) {
  const listed = await env.DB.prepare("SELECT " + otherCol + " AS id, created_at FROM " + table + " WHERE " + ownerCol + " = ? ORDER BY created_at DESC LIMIT 200").bind(viewerId).all();
  return ((listed && listed.results) || []).map((row) => row.id);
}

export async function handleSocialRoutes(request, env, path, url, deps) {
  const method = request.method;
  const isBlock = path === "/v1/blocks";
  const isMute = path === "/v1/mutes";
  const isPeople = path === "/v1/people";
  const isPosts = path === "/v1/posts";
  const isMessages = path === "/v1/messages";
  const followAction = path === "/v1/follows/accept" || path === "/v1/follows/decline" || path === "/v1/follows/cancel" || path === "/v1/follows/remove";
  if (!isBlock && !isMute && !isPeople && !isPosts && !isMessages && !followAction) return null;
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  if (followAction && method === "POST") return followActionRoute(request, env, path, viewer, deps);
  if ((isBlock || isMute) && method === "GET") return relationList(env, request, viewer, isBlock ? "blocks" : "mutes", deps);
  if ((isBlock || isMute) && (method === "PUT" || method === "POST" || method === "DELETE")) return relationWrite(request, env, viewer, isBlock ? "block" : "mute", method === "DELETE", deps);
  if (isPeople && method === "GET") return peopleSearch(env, request, url, viewer, deps);
  if (isPosts && method === "GET") return readPosts(env, url, viewer, deps);
  if (isPosts && method === "POST") return writePost(request, env, viewer, deps);
  if (isMessages && method === "GET") return readMessages(env, url, viewer, Object.assign({}, deps, { request }));
  if (isMessages && method === "POST") return writeMessage(request, env, viewer, deps);
  return null;
}

async function followActionRoute(request, env, path, viewer, deps) {
  const paced = await deps.rateHit(env, "follow:" + viewer.public_id, 30, 10 * 60 * 1000);
  if (!paced.ok) return deps.json(429, { error: "rate_limited", message: "Too many follows. Wait a few minutes and try again." }, { "retry-after": String(paced.retry || 60) });
  const body = await deps.readJson(request, 2000);
  if (body.error) return deps.json(400, { error: body.error });
  const targetId = cleanPublicId(body.id || body.targetId);
  if (!targetId || targetId === viewer.public_id) return deps.json(400, { error: "bad_follow", message: "That account can’t be followed." });
  const account = await one(env, "SELECT public_id, profile_less FROM accounts WHERE public_id = ?", targetId);
  if (!account || account.profile_less === 1) return deps.json(404, { error: "not_found", message: "That account isn’t here." });
  if (await blocksEither(env, viewer.public_id, targetId)) {
    return deps.json(403, { error: "blocked", message: "You can’t do that with this account." });
  }
  if (path === "/v1/follows/cancel") {
    await deleteOutgoingRequest(env, viewer.public_id, targetId);
    return deps.followWriteResult(env, viewer.public_id, "app:" + targetId, false);
  }
  if (path === "/v1/follows/remove") {
    await removeFollower(env, viewer.public_id, targetId);
    const counts = await deps.followWriteResult(env, viewer.public_id, "app:" + viewer.public_id, false);
    return counts;
  }
  if (path === "/v1/follows/decline") {
    await declineFollowRequest(env, viewer.public_id, targetId);
    return deps.json(200, { ok: true, id: "app:" + targetId });
  }
  const accepted = await acceptFollowRequest(env, viewer.public_id, targetId);
  if (!accepted.ok) return deps.json(404, { error: "not_found", message: "That request isn’t here." });
  try {
    const notes = await import("./notifications.js");
    await notes.notifyFollowAccept(env, viewer, targetId);
  } catch (err) { /* the follow is saved */ }
  return deps.json(200, { ok: true, id: "app:" + targetId, accepted: true });
}

async function relationWrite(request, env, viewer, kind, remove, deps) {
  const bucket = kind + ":" + viewer.public_id;
  const paced = await deps.rateHit(env, bucket, 30, 10 * 60 * 1000);
  if (!paced.ok) return deps.json(429, { error: "rate_limited", message: "Too many requests. Wait a few minutes and try again." }, { "retry-after": String(paced.retry || 60) });
  const body = await deps.readJson(request, 2000);
  if (body.error) return deps.json(400, { error: body.error });
  const targetId = cleanPublicId(body.id || body.publicId || body.accountId);
  if (!targetId || targetId === viewer.public_id) return deps.json(400, { error: "bad_target", message: "That account isn’t here." });
  const account = await one(env, "SELECT public_id FROM accounts WHERE public_id = ?", targetId);
  if (!account) return deps.json(404, { error: "not_found", message: "That account isn’t here." });
  if (kind === "block") {
    if (remove) await clearBlock(env, viewer.public_id, targetId);
    else await applyBlock(env, viewer.public_id, targetId);
  } else if (remove) await clearMute(env, viewer.public_id, targetId);
  else await applyMute(env, viewer.public_id, targetId);
  return deps.json(200, { ok: true });
}

async function relationList(env, request, viewer, kind, deps) {
  const ids = kind === "blocks"
    ? await listRelationIds(env, viewer.public_id, "account_blocks", "blocker_id", "blocked_id")
    : await listRelationIds(env, viewer.public_id, "account_mutes", "muter_id", "muted_id");
  const accounts = await deps.cards(env, request, ids);
  return deps.json(200, { accounts });
}

async function peopleSearch(env, request, url, viewer, deps) {
  const paced = await deps.rateHit(env, "people:" + viewer.public_id, 60, 10 * 60 * 1000);
  if (!paced.ok) return deps.json(429, { error: "rate_limited", message: "Too many requests. Wait a few minutes and try again." }, { "retry-after": String(paced.retry || 60) });
  const term = peopleTerm(url.searchParams.get("q") || "");
  if (!term) return deps.json(200, { accounts: [] });
  const listed = await env.DB.prepare(
    "SELECT a.public_id AS public_id, a.handle AS handle, a.display_name AS display_name, COALESCE(sp.searchable, 1) AS searchable FROM accounts a LEFT JOIN search_prefs sp ON sp.public_id = a.public_id WHERE a.profile_less = 0 AND a.public_id != ?3 AND (lower(a.handle) LIKE ?1 ESCAPE '\\' OR lower(a.display_name) LIKE ?1 ESCAPE '\\' OR a.public_id IN (SELECT public_id FROM display_names WHERE lower(name) LIKE ?1 ESCAPE '\\')) ORDER BY (lower(a.handle) = ?2) DESC, a.handle ASC LIMIT 40"
  ).bind(term.like, term.core, String(viewer.public_id)).all();
  const core = term.core;
  // An exact username (any of the account's usernames, by its audience) comes first.
  const rows = ((listed && listed.results) || []).slice();
  let exactId = "";
  try {
    const exact = await resolveName(env, core, viewer.public_id);
    exactId = exact && exact.publicId && String(exact.publicId) !== String(viewer.public_id) ? String(exact.publicId) : "";
  } catch (err) { exactId = ""; }
  if (exactId) {
    const at = rows.findIndex((row) => String(row.public_id) === exactId);
    const hit = at >= 0 ? rows.splice(at, 1)[0] : await env.DB.prepare("SELECT a.public_id AS public_id, a.handle AS handle, a.display_name AS display_name, COALESCE(sp.searchable, 1) AS searchable FROM accounts a LEFT JOIN search_prefs sp ON sp.public_id = a.public_id WHERE a.public_id = ? AND a.profile_less = 0").bind(exactId).first();
    if (hit) rows.unshift(Object.assign({}, hit, { exact: true }));
  }
  // "Let others find me in search" (default on). Accounts that turned it off stay
  // out for everyone but the site owner, whose sight of them is audit-logged.
  const ids = [];
  const lockedIds = await lockedAccountSet(env, viewer.public_id);
  for (const row of rows) {
    if (lockedIds.has(String(row.public_id))) continue;
    // A name match counts only for the one display name this viewer sees.
    if (!row.exact && String(row.handle || "").toLowerCase().indexOf(core) < 0) {
      const shown = await viewerDisplay(env, request, row.public_id, viewer.public_id, row.display_name || "");
      if (shown.hidden || String(shown.name || "").toLowerCase().indexOf(core) < 0) continue;
    }
    if (await blocksEither(env, viewer.public_id, row.public_id)) continue;
    if (Number(row.searchable) === 0) {
      if (!ownerSees(viewer, row.public_id)) continue;
      await auditOwnerView(env, viewer.public_id, row.public_id, "search");
    }
    ids.push(row.public_id);
    if (ids.length >= 20) break;
  }
  return deps.json(200, { accounts: await deps.cards(env, request, ids) });
}

async function readPosts(env, url, viewer, deps) {
  const authorId = cleanPublicId(url.searchParams.get("id") || url.searchParams.get("author") || "");
  if (!authorId) return deps.json(400, { error: "bad_follow" });
  if (!(await canSeePosts(env, viewer.public_id, authorId))) {
    const state = await pairState(env, viewer.public_id, authorId);
    return deps.json(200, { posts: [], blocked: !!(state.viewerBlocks || state.blockedBy), locked: !!state.protected && !state.following && !state.friends });
  }
  const listed = await env.DB.prepare(
    "SELECT id, author_id, kind, parent_id, body, created_at FROM account_content WHERE author_id = ? AND deleted_at = 0 AND kind != 'dm' ORDER BY created_at DESC LIMIT 40"
  ).bind(authorId).all();
  const posts = [];
  for (const row of (listed && listed.results) || []) {
    if (row.parent_id && /^\d{12}$/.test(row.parent_id) && !(await canSeePosts(env, viewer.public_id, row.parent_id))) continue;
    posts.push({ id: row.id, authorId: row.author_id, kind: row.kind, parentId: row.parent_id || "", body: row.body, createdAt: row.created_at });
  }
  return deps.json(200, { posts });
}

async function writePost(request, env, viewer, deps) {
  const paced = await deps.rateHit(env, "post:" + viewer.public_id, 30, 10 * 60 * 1000);
  if (!paced.ok) return deps.json(429, { error: "rate_limited", message: "Too many requests. Wait a few minutes and try again." }, { "retry-after": String(paced.retry || 60) });
  const body = await deps.readJson(request, 8000);
  if (body.error) return deps.json(400, { error: body.error });
  const text = cleanBody(body.text || body.body || "");
  if (!text) return deps.json(400, { error: "bad_post", message: "Write something first." });
  const parent = cleanPublicId(body.parentId || "");
  if (body.parentId && !parent) return deps.json(400, { error: "bad_parent" });
  if (parent && await blocksEither(env, viewer.public_id, parent)) {
    return deps.json(403, { error: "blocked", message: "You can’t do that with this account." });
  }
  const id = newKey("ps_");
  const now = Date.now();
  const kind = parent ? "reply" : "post";
  await env.DB.prepare(
    "INSERT INTO account_content (id, author_id, kind, parent_id, body, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)"
  ).bind(id, viewer.public_id, kind, parent, text, now, now).run();
  if (parent && parent !== viewer.public_id) {
    try {
      const notes = await import("./notifications.js");
      if (!(await actorHidden(env, parent, viewer.public_id))) {
        await notes.emitNotification(env, {
          publicId: parent,
          kind: "reply",
          at: now,
          actorId: viewer.public_id,
          idempotencyKey: "postreply:" + id,
          handle: viewer.handle,
          name: viewer.display_name,
          text: clip(text, 180),
          hash: "#/",
          platform: "app",
          feedId: "app:" + viewer.public_id
        });
      }
    } catch (err) { /* the post is saved */ }
  }
  try {
    const notes = await import("./notifications.js");
    await notes.notifyMentions(env, viewer, text, [parent, viewer.public_id], "mention:" + id, "#/");
  } catch (err) { /* the post is saved */ }
  return deps.json(200, { post: { id, authorId: viewer.public_id, kind, parentId: parent, body: text, createdAt: now } });
}

async function readMessages(env, url, viewer, deps) {
  const otherId = cleanPublicId(url.searchParams.get("id") || "");
  if (!otherId) return deps.json(400, { error: "bad_target" });
  if (await blocksEither(env, viewer.public_id, otherId)) {
    return deps.json(403, { error: "blocked", message: "You can’t do that with this account.", messages: [] });
  }
  const listed = await env.DB.prepare(
    "SELECT id, sender_id, recipient_id, body, created_at FROM account_messages WHERE deleted_at = 0 AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) ORDER BY created_at DESC LIMIT 50"
  ).bind(viewer.public_id, otherId, otherId, viewer.public_id).all();
  // A chat with a locked follow opens only inside the Locked area, like
  // WhatsApp's locked chats.
  if (await isLockedFollow(env, viewer.public_id, "app:" + otherId) && !(await grantOk(env, deps.request || { headers: new Headers() }, viewer.public_id))) {
    return deps.json(200, { messages: [] });
  }
  const muted = await one(env, "SELECT muted_id FROM account_mutes WHERE muter_id = ? AND muted_id = ?", viewer.public_id, otherId);
  const messages = [];
  for (const row of (listed && listed.results) || []) {
    if (muted && row.sender_id === otherId) continue;
    messages.push({ id: row.id, senderId: row.sender_id, body: row.body, createdAt: row.created_at, mine: row.sender_id === viewer.public_id });
  }
  return deps.json(200, { messages });
}

async function writeMessage(request, env, viewer, deps) {
  const paced = await deps.rateHit(env, "dm:" + viewer.public_id, 40, 10 * 60 * 1000);
  if (!paced.ok) return deps.json(429, { error: "rate_limited", message: "Too many requests. Wait a few minutes and try again." }, { "retry-after": String(paced.retry || 60) });
  const body = await deps.readJson(request, 8000);
  if (body.error) return deps.json(400, { error: body.error });
  const otherId = cleanPublicId(body.id || body.to);
  const text = cleanBody(body.text || body.body || "");
  if (!otherId || otherId === viewer.public_id) return deps.json(400, { error: "bad_target", message: "That account isn’t here." });
  if (!text) return deps.json(400, { error: "bad_post", message: "Write something first." });
  const account = await one(env, "SELECT public_id, profile_less FROM accounts WHERE public_id = ?", otherId);
  if (!account || account.profile_less === 1) return deps.json(404, { error: "not_found", message: "That account isn’t here." });
  if (await blocksEither(env, viewer.public_id, otherId)) {
    return deps.json(403, { error: "blocked", message: "You can’t do that with this account." });
  }
  const tempGate = await tempDmGate(env, viewer, otherId, deps.rateHit);
  if (tempGate) return deps.json(tempGate.status, { error: tempGate.error, message: "Temporary accounts can message only a few new people a day. Save this account to lift the limit." }, { "retry-after": String(tempGate.retry || 3600) });
  const id = newKey("dm_");
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO account_messages (id, sender_id, recipient_id, body, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 0)"
  ).bind(id, viewer.public_id, otherId, text, now).run();
  if (!(await actorHidden(env, otherId, viewer.public_id))) {
    try {
      const notes = await import("./notifications.js");
      await notes.emitNotification(env, {
        publicId: otherId,
        kind: "mention",
        at: now,
        actorId: viewer.public_id,
        idempotencyKey: "dm:" + id,
        handle: viewer.handle,
        name: viewer.display_name,
        text: clip(text, 180),
        hash: "#/",
        platform: "app",
        feedId: "app:" + viewer.public_id
      });
    } catch (err) { /* the message is saved */ }
  }
  return deps.json(200, { ok: true, id });
}
