/* Private audience lists. A member is never told which lists include them.
   One check is used for stories, notes, highlights, and later posts and gifts. */

import { friendshipLive, liveFriendIds } from "./friends-pref.js";
import { inspectHandle } from "../../shared/handle-skeleton.js";
import { blocksEither, pairState } from "./social.js";

export const AUDIENCE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS audience_lists (
    id TEXT PRIMARY KEY,
    public_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS audience_lists_owner ON audience_lists(public_id, created_at)",
  `CREATE TABLE IF NOT EXISTS audience_members (
    list_id TEXT NOT NULL,
    public_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, member_id)
  )`,
  "CREATE INDEX IF NOT EXISTS audience_members_owner ON audience_members(public_id, list_id)",
  `CREATE TABLE IF NOT EXISTS audience_grants (
    subject TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    list_id TEXT NOT NULL,
    PRIMARY KEY (subject, subject_id, list_id)
  )`
];

const PUBLIC_ID = /^\d{12}$/;
const LIST_CAP = 200;

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

function text(value) {
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

export function normalizeAudience(value) {
  const raw = String(value || "");
  if (raw === "everyone" || raw === "public") return "public";
  if (raw === "followers") return "followers";
  if (raw === "friends") return "friends";
  if (raw === "following") return "following";
  if (raw === "only") return "only";
  if (raw === "list" || raw === "lists") return "list";
  return "";
}

export async function canSeeAudience(env, input) {
  const ownerId = String(input && input.ownerId || "");
  const viewerId = String(input && input.viewerId || "");
  const audience = normalizeAudience(input && input.audience) || "public";
  if (!PUBLIC_ID.test(ownerId)) return false;
  if (input && input.profileLess && viewerId !== ownerId) return false;
  if (viewerId && viewerId === ownerId) return true;
  if (viewerId && await blocksEither(env, viewerId, ownerId)) return false;
  if (audience === "public") return true;
  if (!viewerId || audience === "only") return false;
  if (audience === "list") {
    const hit = await env.DB.prepare(
      "SELECT g.list_id FROM audience_grants g JOIN audience_members m ON m.list_id = g.list_id AND m.member_id = ? JOIN audience_lists l ON l.id = g.list_id AND l.public_id = ? WHERE g.subject = ? AND g.subject_id = ? LIMIT 1"
    ).bind(viewerId, ownerId, String(input.subject || ""), String(input.subjectId || "")).first();
    return !!hit;
  }
  const state = await pairState(env, viewerId, ownerId);
  if (state.viewerBlocks || state.blockedBy) return false;
  if (audience === "followers") return !!state.following;
  if (audience === "following") return !!state.followsYou;
  if (audience === "friends") return !!(state.friends || (state.following && state.followsYou));
  return false;
}

export async function setListGrants(env, ownerId, subject, subjectId, listIds) {
  await env.DB.prepare("DELETE FROM audience_grants WHERE subject = ? AND subject_id = ?").bind(subject, subjectId).run();
  const unique = [];
  (Array.isArray(listIds) ? listIds : []).forEach((id) => {
    const textId = String(id || "");
    if (textId && unique.indexOf(textId) < 0) unique.push(textId);
  });
  const kept = [];
  for (let i = 0; i < unique.length; i++) {
    const row = await env.DB.prepare("SELECT id FROM audience_lists WHERE id = ? AND public_id = ?").bind(unique[i], ownerId).first();
    if (row) kept.push(row.id);
  }
  if (!kept.length) return [];
  await env.DB.batch(kept.map((id) => env.DB.prepare(
    "INSERT INTO audience_grants (subject, subject_id, list_id) VALUES (?, ?, ?) ON CONFLICT(subject, subject_id, list_id) DO NOTHING"
  ).bind(subject, subjectId, id)));
  return kept;
}

export async function grantsFor(env, ownerId, subject, subjectId) {
  const listed = await env.DB.prepare(
    "SELECT g.list_id FROM audience_grants g JOIN audience_lists l ON l.id = g.list_id WHERE g.subject = ? AND g.subject_id = ? AND l.public_id = ?"
  ).bind(subject, subjectId, ownerId).all();
  return rowsOf(listed).map((row) => row.list_id);
}

async function accountByHandle(env, handle) {
  const checked = inspectHandle(String(handle || "").replace(/^@/, ""));
  if (!checked.ok) return null;
  return env.DB.prepare("SELECT public_id, handle, display_name FROM accounts WHERE skeleton = ?").bind(checked.skeleton).first();
}

async function canAdd(env, ownerId, memberId) {
  if (!PUBLIC_ID.test(memberId) || memberId === ownerId) return false;
  if (await blocksEither(env, ownerId, memberId)) return false;
  const follow = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(memberId, "app:" + ownerId).first();
  if (follow) return true;
  const friend = await env.DB.prepare(
    "SELECT user_id FROM account_friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)"
  ).bind(ownerId, memberId, memberId, ownerId).first();
  if (friend && await friendshipLive(env, ownerId, memberId)) return true;
  const back = await env.DB.prepare(
    "SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?"
  ).bind(ownerId, "app:" + memberId).first();
  return !!back;
}

async function presentList(env, row) {
  const members = await env.DB.prepare(
    "SELECT m.member_id, a.handle, a.display_name FROM audience_members m LEFT JOIN accounts a ON a.public_id = m.member_id WHERE m.list_id = ? AND m.public_id = ? ORDER BY m.created_at ASC"
  ).bind(row.id, row.public_id).all();
  return {
    id: row.id,
    name: row.name || "",
    icon: row.icon || "",
    members: rowsOf(members).map((item) => ({ handle: item.handle || "", name: item.display_name || item.handle || "" }))
  };
}

export async function handleAudienceLists(request, env, path, deps) {
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer || !PUBLIC_ID.test(String(viewer.public_id || ""))) return deps.json(401, { error: "unauthorized" });
  if (path === "/v1/audience-lists" && request.method === "GET") {
    const listed = await env.DB.prepare(
      "SELECT id, public_id, name, icon, created_at FROM audience_lists WHERE public_id = ? ORDER BY created_at ASC"
    ).bind(viewer.public_id).all();
    const lists = [];
    for (const row of rowsOf(listed)) lists.push(await presentList(env, row));
    return deps.json(200, { lists: lists });
  }
  if (path === "/v1/audience-lists/people" && request.method === "GET") {
    const follows = await env.DB.prepare(
      "SELECT follower_id AS id FROM account_follows WHERE target_id = ? LIMIT 200"
    ).bind("app:" + viewer.public_id).all();
    const friends = await env.DB.prepare(
      "SELECT friend_id AS id FROM account_friends WHERE user_id = ? LIMIT 200"
    ).bind(viewer.public_id).all();
    const liveFriends = await liveFriendIds(env, viewer.public_id, rowsOf(friends).map((row) => row.id));
    const ids = [];
    rowsOf(follows).concat(liveFriends.map((id) => ({ id: id }))).forEach((row) => {
      if (PUBLIC_ID.test(String(row.id || "")) && ids.indexOf(row.id) < 0) ids.push(row.id);
    });
    const people = [];
    for (let i = 0; i < ids.length; i++) {
      const account = await env.DB.prepare("SELECT handle, display_name FROM accounts WHERE public_id = ?").bind(ids[i]).first();
      if (account) people.push({ handle: account.handle || "", name: account.display_name || account.handle || "" });
    }
    return deps.json(200, { people: people });
  }
  if (path === "/v1/audience-lists" && request.method === "POST") {
    const paced = await deps.rateHit(env, "aud:" + viewer.public_id, 30, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM audience_lists WHERE public_id = ?").bind(viewer.public_id).first();
    if (Number(count && count.n) >= LIST_CAP) return deps.json(429, { error: "too_many" });
    const body = await deps.readJson(request, 2000000);
    if (body.error) return deps.json(body.error === "too_large" ? 413 : 400, { error: body.error });
    const id = newId();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO audience_lists (id, public_id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(id, viewer.public_id, text(body.name), text(body.icon), now, now).run();
    return deps.json(201, { id: id, name: text(body.name), icon: text(body.icon), members: [] });
  }
  const one = path.match(/^\/v1\/audience-lists\/([a-f0-9]{32})(\/members)?$/);
  if (!one) return null;
  const row = await env.DB.prepare(
    "SELECT id, public_id, name, icon FROM audience_lists WHERE id = ?"
  ).bind(one[1]).first();
  if (!row || row.public_id !== viewer.public_id) return deps.json(404, { error: "not_found" });
  if (!one[2] && request.method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM audience_grants WHERE list_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM audience_members WHERE list_id = ?").bind(row.id),
      env.DB.prepare("DELETE FROM audience_lists WHERE id = ? AND public_id = ?").bind(row.id, viewer.public_id)
    ]);
    return deps.json(200, { ok: true });
  }
  if (!one[2] && request.method === "PATCH") {
    const body = await deps.readJson(request, 2000000);
    if (body.error) return deps.json(body.error === "too_large" ? 413 : 400, { error: body.error });
    const name = body.name != null ? text(body.name) : row.name;
    const icon = body.icon != null ? text(body.icon) : row.icon;
    await env.DB.prepare(
      "UPDATE audience_lists SET name = ?, icon = ?, updated_at = ? WHERE id = ? AND public_id = ?"
    ).bind(name, icon, Date.now(), row.id, viewer.public_id).run();
    return deps.json(200, { id: row.id, name: name, icon: icon });
  }
  if (one[2] && request.method === "POST") {
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    const account = await accountByHandle(env, body.handle);
    if (!account || !(await canAdd(env, viewer.public_id, account.public_id))) return deps.json(400, { error: "member" });
    await env.DB.prepare(
      "INSERT INTO audience_members (list_id, public_id, member_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(list_id, member_id) DO NOTHING"
    ).bind(row.id, viewer.public_id, account.public_id, Date.now()).run();
    return deps.json(200, await presentList(env, row));
  }
  if (one[2] && request.method === "DELETE") {
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    const account = await accountByHandle(env, body.handle);
    if (!account) return deps.json(404, { error: "not_found" });
    await env.DB.prepare(
      "DELETE FROM audience_members WHERE list_id = ? AND public_id = ? AND member_id = ?"
    ).bind(row.id, viewer.public_id, account.public_id).run();
    return deps.json(200, await presentList(env, row));
  }
  return null;
}
