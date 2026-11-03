/* Display-name nicknames and per-audience mention controls.

   Nicknames: anyone can keep a private nickname for any account (only they
   ever see it). Order: private nickname, then the one display name the
   account picked for this viewer (display-names.js), then the main name.
   The old single "name for friends" is a friends-only display name now.

   Mentions: per audience "anyone", "replies" (only in a reply to them) or
   "nobody", plus allow and block lists. Most specific wins: person (block
   beats allow), then list (username list order), then friends, followers,
   public. A refused mention neither links nor notifies, the account is not
   suggested, and the composer gets a neutral "can't mention" hint. */

import { loadNames, relationTo, resolveName, viewerHandle } from "./usernames.js";
import { displayFor, friendNameGet, friendNamePut } from "./display-names.js";

export const NAME_RULES_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS display_nicknames (viewer_id TEXT NOT NULL, target_id TEXT NOT NULL, name TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (viewer_id, target_id))",
  "CREATE TABLE IF NOT EXISTS friend_names (public_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mention_prefs (public_id TEXT PRIMARY KEY, policy TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ext_nicknames (viewer_id TEXT NOT NULL, source_key TEXT NOT NULL, name TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (viewer_id, source_key))"
];

/* Private nicknames for accounts from other networks (X, Reddit, YouTube,
   forums, RSS...) and for people merged across networks. The key is the
   source identity the feed already uses: "<platform>:<handle or id>" or
   "person:<merged id>", folded to lower case. Only the viewer reads them. */
const EXT_MAX = 2000;
const PLATFORM_ALIAS = { bluesky: "bsky", twitter: "x", fediverse: "mastodon" };

// Names a viewer gives other accounts are private to that viewer. No owner,
// admin or inspector route may read these tables for anyone else; every read
// is keyed by the signed-in viewer's own id. Generic tooling that walks all
// tables (inspectors, exports for someone else) must skip them.
export const VIEWER_PRIVATE_TABLES = Object.freeze(["display_nicknames", "ext_nicknames"]);

export function normalizeSourceKey(raw) {
  const text = String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().toLowerCase();
  const cut = text.indexOf(":");
  if (cut < 1) return "";
  let platform = text.slice(0, cut);
  if (!/^[a-z][a-z0-9_-]{0,23}$/.test(platform)) return "";
  platform = PLATFORM_ALIAS[platform] || platform;
  if (platform === "app") return "";
  let id = text.slice(cut + 1).replace(/\s+/g, "").replace(/^@+/, "");
  if (platform === "reddit") id = id.replace(/^\/?u(ser)?\//, "").replace(/^\/r\//, "r/");
  if (!id || id.length > 200) return "";
  if (!/^[^<>"'`\\]+$/.test(id)) return "";
  return platform + ":" + id;
}

const POLICIES = ["anyone", "replies", "nobody"];
const PUBLIC_ID = /^\d{12}$/;
const LIST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NICK_MAX = 50;

export function cleanNickname(raw) {
  return String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, NICK_MAX);
}

function pol(value) {
  return POLICIES.indexOf(value) >= 0 ? value : "";
}

function ids(list, cap) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((id) => { const t = String(id || ""); if (PUBLIC_ID.test(t) && out.indexOf(t) < 0 && out.length < cap) out.push(t); });
  return out;
}

export function normalizeMentionPolicy(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const lists = {};
  const given = src.lists && typeof src.lists === "object" ? src.lists : {};
  Object.keys(given).slice(0, 50).forEach((id) => { if (LIST_ID.test(id) && pol(given[id])) lists[id] = given[id]; });
  return { public: pol(src.public) || "anyone", followers: pol(src.followers), friends: pol(src.friends), lists, allow: ids(src.allow, 500), block: ids(src.block, 500) };
}

/* Pure: the policy that applies to this mentioner. */
export function pickPolicy(policyInput, relInput, listOrder) {
  const policy = normalizeMentionPolicy(policyInput);
  const rel = relInput || {};
  if (rel.self) return "anyone";
  const id = String(rel.id || "");
  if (id && policy.block.indexOf(id) >= 0) return "nobody";
  if (id && policy.allow.indexOf(id) >= 0) return "anyone";
  const order = Array.isArray(listOrder) ? listOrder : [];
  const rank = (x) => { const at = order.indexOf(x); return at < 0 ? order.length : at; };
  const mine = (Array.isArray(rel.lists) ? rel.lists : []).filter((x) => policy.lists[x]).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  if (mine.length) return policy.lists[mine[0]];
  if (rel.friends && policy.friends) return policy.friends;
  if (rel.follows && policy.followers) return policy.followers;
  return policy.public;
}

export function allows(policy, ctx) {
  if (policy === "anyone") return true;
  if (policy === "replies") return !!(ctx && ctx.reply);
  return false;
}

async function loadPolicy(env, publicId) {
  try {
    const row = await env.DB.prepare("SELECT policy FROM mention_prefs WHERE public_id = ?").bind(publicId).first();
    return normalizeMentionPolicy(row ? JSON.parse(row.policy || "{}") : {});
  } catch (err) {
    return normalizeMentionPolicy({});
  }
}

/* May actorId mention targetId? ctx.replyTo = author id of the parent. */
export async function canMention(env, targetId, actorId, ctx) {
  if (!targetId || !actorId || targetId === actorId) return true;
  const policy = await loadPolicy(env, targetId);
  const plain = policy.public === "anyone" && !policy.followers && !policy.friends && !Object.keys(policy.lists).length && !policy.block.length;
  if (plain) return true;
  const set = await loadNames(env, targetId);
  const rel = await relationTo(env, targetId, actorId);
  return allows(pickPolicy(policy, rel, set ? set.listOrder : []), { reply: !!(ctx && ctx.replyTo && ctx.replyTo === targetId) });
}

const memos = new WeakMap();

/* The display name this viewer sees for ownerId. */
/* The name viewerId sees for ownerId: their own private nickname first,
   then the one display name the owner picked for them (display-names.js),
   then the fallback. hidden: no display name is visible to this viewer
   (callers show the handle). friendName: the shown name is not the main
   one (kept for older clients). */
export async function viewerDisplay(env, request, ownerId, viewerId, fallback) {
  if (!ownerId || ownerId === viewerId) return { name: fallback || "", nickname: "", friendName: "", hidden: false };
  let memo = request && typeof request === "object" ? memos.get(request) : null;
  if (!memo) { memo = new Map(); if (request && typeof request === "object") memos.set(request, memo); }
  const key = ownerId + ">" + (viewerId || "");
  if (!memo.has(key)) {
    memo.set(key, (async () => {
      let nickname = "";
      let shown = null;
      try {
        if (viewerId) {
          const nick = await env.DB.prepare("SELECT name FROM display_nicknames WHERE viewer_id = ? AND target_id = ?").bind(viewerId, ownerId).first();
          nickname = nick ? nick.name : "";
        }
        // With a nickname, still work out what this viewer would otherwise see, so the
        // reset target never reveals a display name hidden from them.
        shown = await displayFor(env, request, ownerId, viewerId || "");
      } catch (err) { /* tables not created yet */ }
      return { nickname, shown };
    })());
  }
  const got = await memo.get(key);
  if (got.nickname) return { name: got.nickname, nickname: got.nickname, friendName: "", hidden: false, original: got.shown ? (got.shown.hidden ? "" : got.shown.name) : (fallback || "") };
  if (!got.shown) return { name: fallback || "", nickname: "", friendName: "", hidden: false };
  return { name: got.shown.name, nickname: "", friendName: got.shown.alt ? got.shown.name : "", hidden: got.shown.hidden };
}

async function targetFor(env, raw, viewerId) {
  const found = await resolveName(env, raw, viewerId);
  return found && found.publicId !== viewerId ? found.publicId : "";
}

async function policyOut(env, request, ownerId, policy) {
  async function handles(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const seen = await viewerHandle(env, request, list[i], ownerId);
      if (seen.handle) out.push(seen.handle);
    }
    return out;
  }
  return { public: policy.public, followers: policy.followers, friends: policy.friends, lists: policy.lists, allow: await handles(policy.allow), block: await handles(policy.block) };
}

export async function handleNameRules(request, env, path, deps) {
  const json = deps.json;
  const session = await deps.sessionAccount(env, request);
  if (!session) return json(401, { error: "unauthorized" });
  const me = session.public_id;
  const method = request.method;
  const nocache = { "cache-control": "no-store" };
  const body = method === "GET" ? {} : await deps.readJson(request, 40000);
  if (body.error) return json(body.error === "too_large" ? 413 : 400, { error: body.error });

  if (path === "/v1/nicknames" && method === "GET") {
    const rows = await env.DB.prepare("SELECT target_id, name FROM display_nicknames WHERE viewer_id = ? ORDER BY updated_at DESC LIMIT 500").bind(me).all();
    const out = [];
    const list = (rows && rows.results) || [];
    for (let i = 0; i < list.length; i++) {
      const seen = await viewerHandle(env, request, list[i].target_id, me);
      out.push({ handle: seen.handle, name: list[i].name });
    }
    return json(200, { nicknames: out }, nocache);
  }

  if (path === "/v1/nicknames" && method === "PUT") {
    const paced = await deps.rateHit(env, "nick:" + me, 120, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const target = await targetFor(env, body.handle, me);
    if (!target) return json(404, { error: "not_found" });
    const name = cleanNickname(body.name);
    if (name) await env.DB.prepare("INSERT INTO display_nicknames (viewer_id, target_id, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(viewer_id, target_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at").bind(me, target, name, Date.now()).run();
    else await env.DB.prepare("DELETE FROM display_nicknames WHERE viewer_id = ? AND target_id = ?").bind(me, target).run();
    if (deps.invalidate) { try { await deps.invalidate(env, target); } catch (err) { /* ages out */ } }
    return json(200, { ok: true, name }, nocache);
  }

  if (path === "/v1/nicknames/external" && method === "GET") {
    let rows = [];
    try { rows = ((await env.DB.prepare("SELECT source_key, name, updated_at FROM ext_nicknames WHERE viewer_id = ? ORDER BY updated_at DESC LIMIT ?").bind(me, EXT_MAX).all()).results) || []; } catch (err) { rows = []; }
    return json(200, { nicknames: rows.map((r) => ({ key: r.source_key, name: r.name, at: r.updated_at })) }, nocache);
  }

  if (path === "/v1/nicknames/external" && (method === "PUT" || method === "DELETE")) {
    const paced = await deps.rateHit(env, "nick:" + me, 120, 60 * 60 * 1000);
    if (!paced.ok) return deps.limited(paced);
    const key = normalizeSourceKey(body.key);
    if (!key) return json(400, { error: "bad_key" });
    const name = method === "DELETE" ? "" : cleanNickname(body.name);
    if (name) {
      const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM ext_nicknames WHERE viewer_id = ? AND source_key <> ?").bind(me, key).first();
      if (have && Number(have.n) >= EXT_MAX) return json(409, { error: "too_many" });
      await env.DB.prepare("INSERT INTO ext_nicknames (viewer_id, source_key, name, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(viewer_id, source_key) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at").bind(me, key, name, Date.now()).run();
    } else {
      await env.DB.prepare("DELETE FROM ext_nicknames WHERE viewer_id = ? AND source_key = ?").bind(me, key).run();
    }
    return json(200, { ok: true, key, name }, nocache);
  }

  if (path === "/v1/usernames/friend-name" && method === "GET") {
    // Now one friends-only entry in Edit profile > Display names.
    return json(200, { name: await friendNameGet(env, me) }, nocache);
  }

  if (path === "/v1/usernames/friend-name" && method === "PUT") {
    const name = await friendNamePut(env, me, cleanNickname(body.name));
    if (deps.invalidate) { try { await deps.invalidate(env, me); } catch (err) { /* cache drops on its own */ } }
    return json(200, { name }, nocache);
  }

  if (path === "/v1/usernames/mentions" && method === "GET") {
    return json(200, await policyOut(env, request, me, await loadPolicy(env, me)), nocache);
  }

  if (path === "/v1/usernames/mentions" && method === "PUT") {
    async function people(list) {
      const out = [];
      const items = Array.isArray(list) ? list.slice(0, 500) : [];
      for (let i = 0; i < items.length; i++) {
        const id = await targetFor(env, items[i], me);
        if (id && out.indexOf(id) < 0) out.push(id);
      }
      return out;
    }
    let lists = [];
    try { lists = ((await env.DB.prepare("SELECT id FROM audience_lists WHERE public_id = ?").bind(me).all()).results || []).map((r) => r.id); } catch (err) { lists = []; }
    const given = body.lists && typeof body.lists === "object" ? body.lists : {};
    const kept = {};
    Object.keys(given).forEach((id) => { if (lists.indexOf(id) >= 0) kept[id] = given[id]; });
    const policy = normalizeMentionPolicy({ public: body.public, followers: body.followers, friends: body.friends, lists: kept, allow: await people(body.allow), block: await people(body.block) });
    await env.DB.prepare("INSERT INTO mention_prefs (public_id, policy, updated_at) VALUES (?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at").bind(me, JSON.stringify(policy), Date.now()).run();
    return json(200, await policyOut(env, request, me, policy), nocache);
  }

  return json(404, { error: "not_found" });
}
