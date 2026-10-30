/* Several usernames per account. The primary one lives on accounts.handle;
   the others live in account_handles. Every name is unique app-wide (the
   same skeleton check signup uses) and each has an audience:

     include: public, followers, friends, lists [ids], people [ids]
     exclude: followers, friends, lists [ids], people [ids]

   A viewer sees exactly ONE name. The most specific match wins: a person
   rule, then a list (in the owner's list order), then friends, then
   followers, then public. Exclusions always win over inclusions; when no
   name is left the viewer gets a neutral placeholder. A name looked up by
   someone outside its audience is a 404. */

import { friendshipLive } from "./friends-pref.js";
import { inspectHandle } from "../../shared/handle-skeleton.js";
import { handleHeld } from "./account-delete.js";

export const USERNAME_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS account_handles (skeleton TEXT PRIMARY KEY, public_id TEXT NOT NULL, handle TEXT NOT NULL, audience TEXT NOT NULL DEFAULT '{}', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS account_handles_owner ON account_handles(public_id, position)",
  "CREATE INDEX IF NOT EXISTS account_handles_lower ON account_handles(lower(handle))",
  "CREATE TABLE IF NOT EXISTS username_prefs (public_id TEXT PRIMARY KEY, primary_audience TEXT NOT NULL DEFAULT '', list_order TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS username_releases (skeleton TEXT PRIMARY KEY, public_id TEXT NOT NULL, held_until INTEGER NOT NULL)"
];

export const NAME_CAP = 5;
export const RELEASE_DAYS = 30;
const SWITCHES_PER_WEEK = 2;
const DAY = 24 * 60 * 60 * 1000;
const PUBLIC_ID = /^\d{12}$/;
const LIST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PUBLIC_DEFAULT = { include: { public: true } };

function rowsOf(result) {
  return (result && result.results) || [];
}

function uniq(list, test, cap) {
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    const text = String(item == null ? "" : item);
    if (test.test(text) && out.indexOf(text) < 0 && out.length < cap) out.push(text);
  });
  return out;
}

/* Stored form: ids only, nothing else. */
export function normalizeNameAudience(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const inc = src.include && typeof src.include === "object" ? src.include : {};
  const exc = src.exclude && typeof src.exclude === "object" ? src.exclude : {};
  return {
    include: {
      public: inc.public === true,
      followers: inc.followers === true,
      friends: inc.friends === true,
      lists: uniq(inc.lists, LIST_ID, 50),
      people: uniq(inc.people, PUBLIC_ID, 200)
    },
    exclude: {
      followers: exc.followers === true,
      friends: exc.friends === true,
      lists: uniq(exc.lists, LIST_ID, 50),
      people: uniq(exc.people, PUBLIC_ID, 200)
    }
  };
}

export function parseAudience(text, fallback) {
  if (!text) return normalizeNameAudience(fallback);
  try { return normalizeNameAudience(JSON.parse(text)); }
  catch (err) { return normalizeNameAudience(fallback); }
}

function excluded(aud, rel) {
  const ex = aud.exclude;
  if (rel.id && ex.people.indexOf(rel.id) >= 0) return true;
  if (rel.lists.some((id) => ex.lists.indexOf(id) >= 0)) return true;
  if (ex.friends && rel.friends) return true;
  if (ex.followers && rel.follows) return true;
  return false;
}

export function cleanRel(rel) {
  const src = rel || {};
  return { self: !!src.self, id: String(src.id || ""), follows: !!src.follows, friends: !!src.friends, lists: Array.isArray(src.lists) ? src.lists.map(String) : [] };
}

function tiers(rel, listOrder) {
  const order = Array.isArray(listOrder) ? listOrder : [];
  const rank = (id) => { const at = order.indexOf(id); return at < 0 ? order.length : at; };
  const lists = rel.lists.slice().sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out = [];
  if (rel.id) out.push((aud) => aud.include.people.indexOf(rel.id) >= 0);
  lists.forEach((id) => out.push((aud) => aud.include.lists.indexOf(id) >= 0));
  if (rel.friends) out.push((aud) => aud.include.friends);
  if (rel.follows) out.push((aud) => aud.include.followers);
  out.push((aud) => aud.include.public);
  return out;
}

/* names: [{ handle, primary, position, audience }] (primary first).
   Returns the one name this viewer sees, or null for the placeholder. */
export function pickName(names, relInput, listOrder) {
  const rel = cleanRel(relInput);
  const list = (names || []).slice().sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || (a.position || 0) - (b.position || 0));
  if (rel.self) return list[0] || null;
  const levels = tiers(rel, listOrder);
  for (let i = 0; i < levels.length; i++) {
    for (let j = 0; j < list.length; j++) {
      const aud = list[j].audience;
      if (levels[i](aud) && !excluded(aud, rel)) return list[j];
    }
  }
  return null;
}

/* Can this viewer reach the account through this one name? */
export function canSeeName(name, relInput) {
  const rel = cleanRel(relInput);
  if (rel.self) return true;
  if (!name) return false;
  const aud = name.audience;
  if (excluded(aud, rel)) return false;
  return tiers(rel, []).some((level) => level(aud));
}

export async function loadNames(env, ownerId) {
  const account = await env.DB.prepare("SELECT handle, skeleton FROM accounts WHERE public_id = ?").bind(ownerId).first();
  if (!account) return null;
  let prefs = null;
  let extra = [];
  try {
    prefs = await env.DB.prepare("SELECT primary_audience, list_order FROM username_prefs WHERE public_id = ?").bind(ownerId).first();
    extra = rowsOf(await env.DB.prepare("SELECT skeleton, handle, audience, position FROM account_handles WHERE public_id = ? ORDER BY position ASC, created_at ASC").bind(ownerId).all());
  } catch (err) { /* tables not created yet: primary only */ }
  let listOrder = [];
  try { listOrder = uniq(JSON.parse((prefs && prefs.list_order) || "[]"), LIST_ID, 50); } catch (err) { listOrder = []; }
  const names = [{ handle: account.handle, skeleton: account.skeleton, primary: true, position: -1, audience: parseAudience(prefs && prefs.primary_audience, PUBLIC_DEFAULT) }];
  extra.forEach((row, at) => names.push({ handle: row.handle, skeleton: row.skeleton, primary: false, position: Number(row.position) || at, audience: parseAudience(row.audience, { include: { followers: true } }) }));
  return { names, listOrder };
}

function plain(set) {
  if (set.names.length > 1) return false;
  const aud = set.names[0].audience;
  return aud.include.public && !aud.exclude.followers && !aud.exclude.friends && !aud.exclude.lists.length && !aud.exclude.people.length;
}

export async function relationTo(env, ownerId, viewerId) {
  if (!viewerId) return cleanRel({});
  if (viewerId === ownerId) return cleanRel({ self: true, id: viewerId });
  const follow = await env.DB.prepare("SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(viewerId, "app:" + ownerId).first();
  const back = await env.DB.prepare("SELECT target_id FROM account_follows WHERE follower_id = ? AND target_id = ?").bind(ownerId, "app:" + viewerId).first();
  const friend = await env.DB.prepare("SELECT friend_id FROM account_friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)").bind(viewerId, ownerId, ownerId, viewerId).first();
  let lists = [];
  try {
    lists = rowsOf(await env.DB.prepare("SELECT m.list_id FROM audience_members m JOIN audience_lists l ON l.id = m.list_id AND l.public_id = ? WHERE m.member_id = ?").bind(ownerId, viewerId).all()).map((row) => row.list_id);
  } catch (err) { lists = []; }
  const friendCounts = !!friend && await friendshipLive(env, ownerId, viewerId);
  return cleanRel({ id: viewerId, follows: !!follow, friends: !!(friendCounts || (follow && back)), lists });
}

const memos = new WeakMap();

function memoFor(request) {
  if (!request || typeof request !== "object") return new Map();
  let memo = memos.get(request);
  if (!memo) { memo = new Map(); memos.set(request, memo); }
  return memo;
}

/* The one handle this viewer sees for ownerId: { handle, hidden }.
   Memoized per request so feeds pay once per author. */
export async function viewerHandle(env, request, ownerId, viewerId) {
  const memo = memoFor(request);
  const key = ownerId + ">" + (viewerId || "");
  if (memo.has(key)) return memo.get(key);
  const job = (async () => {
    const set = await loadNames(env, ownerId);
    if (!set) return { handle: "", hidden: true };
    if (plain(set) || viewerId === ownerId) return { handle: set.names[0].handle, hidden: false };
    const picked = pickName(set.names, await relationTo(env, ownerId, viewerId), set.listOrder);
    return picked ? { handle: picked.handle, hidden: false } : { handle: "", hidden: true };
  })();
  memo.set(key, job);
  return job;
}

/* Resolve a typed name to its account for a viewer. Returns
   { publicId, primary } or null when it is unknown or outside the
   name's audience (callers answer 404 / don't link). */
export async function resolveName(env, raw, viewerId) {
  const checked = inspectHandle(String(raw || "").replace(/^@/, ""));
  if (!checked.skeleton) return null;
  const account = await env.DB.prepare("SELECT public_id FROM accounts WHERE skeleton = ?").bind(checked.skeleton).first();
  let ownerId = account ? account.public_id : "";
  if (!ownerId) {
    try {
      const alias = await env.DB.prepare("SELECT public_id FROM account_handles WHERE skeleton = ?").bind(checked.skeleton).first();
      ownerId = alias ? alias.public_id : "";
    } catch (err) { ownerId = ""; }
  }
  if (!ownerId) return null;
  const set = await loadNames(env, ownerId);
  if (!set) return null;
  const name = set.names.find((item) => item.skeleton === checked.skeleton);
  if (!name) return null;
  if (!(name.primary && plain(set)) && !canSeeName(name, await relationTo(env, ownerId, viewerId))) return null;
  return { publicId: ownerId, primary: !!name.primary };
}

/* "" when free for publicId to take, else the error code. */
export async function nameTaken(env, skeleton, publicId) {
  const key = String(skeleton || "");
  if (!key) return "invalid_handle";
  const account = await env.DB.prepare("SELECT public_id FROM accounts WHERE skeleton = ?").bind(key).first();
  if (account) return "handle_taken";
  try {
    const alias = await env.DB.prepare("SELECT public_id FROM account_handles WHERE skeleton = ?").bind(key).first();
    if (alias) return "handle_taken";
    const held = await env.DB.prepare("SELECT public_id, held_until FROM username_releases WHERE skeleton = ?").bind(key).first();
    if (held && Number(held.held_until) > Date.now() && held.public_id !== publicId) return "handle_held";
  } catch (err) { /* tables not created yet */ }
  if (await handleHeld(env, key)) return "handle_held";
  return "";
}

export async function idForHandle(env, handle, ownerId) {
  const found = await resolveName(env, handle, ownerId);
  return found && found.publicId !== ownerId ? found.publicId : "";
}

export async function ownerLists(env, ownerId) {
  try {
    return rowsOf(await env.DB.prepare("SELECT id FROM audience_lists WHERE public_id = ?").bind(ownerId).all()).map((row) => row.id);
  } catch (err) { return []; }
}

/* Client form uses handles for people; stored form uses ids. */
export async function audienceIn(env, ownerId, raw, fallback) {
  const src = raw && typeof raw === "object" ? raw : fallback;
  const lists = await ownerLists(env, ownerId);
  async function people(list) {
    const out = [];
    const items = Array.isArray(list) ? list.slice(0, 200) : [];
    for (let i = 0; i < items.length; i++) {
      const id = await idForHandle(env, items[i], ownerId);
      if (id && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }
  const inc = (src && src.include) || {};
  const exc = (src && src.exclude) || {};
  return normalizeNameAudience({
    include: { public: inc.public === true, followers: inc.followers === true, friends: inc.friends === true, lists: uniq(inc.lists, LIST_ID, 50).filter((id) => lists.indexOf(id) >= 0), people: await people(inc.people) },
    exclude: { followers: exc.followers === true, friends: exc.friends === true, lists: uniq(exc.lists, LIST_ID, 50).filter((id) => lists.indexOf(id) >= 0), people: await people(exc.people) }
  });
}

export async function audienceOut(env, request, ownerId, aud) {
  async function people(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i++) {
      const seen = await viewerHandle(env, request, ids[i], ownerId);
      if (seen.handle) out.push(seen.handle);
    }
    return out;
  }
  return {
    include: { public: aud.include.public, followers: aud.include.followers, friends: aud.include.friends, lists: aud.include.lists.slice(), people: await people(aud.include.people) },
    exclude: { followers: aud.exclude.followers, friends: aud.exclude.friends, lists: aud.exclude.lists.slice(), people: await people(aud.exclude.people) }
  };
}

async function present(env, request, ownerId) {
  const set = await loadNames(env, ownerId);
  const names = [];
  for (let i = 0; i < set.names.length; i++) {
    const name = set.names[i];
    names.push({ handle: name.handle, primary: name.primary, audience: await audienceOut(env, request, ownerId, name.audience) });
  }
  return { names, listOrder: set.listOrder, cap: NAME_CAP, releaseDays: RELEASE_DAYS };
}

async function savePrefs(env, ownerId, fields) {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO username_prefs (public_id, primary_audience, list_order, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(public_id) DO UPDATE SET primary_audience = COALESCE(?, username_prefs.primary_audience), list_order = COALESCE(?, username_prefs.list_order), updated_at = ?")
    .bind(ownerId, fields.primaryAudience == null ? "" : fields.primaryAudience, fields.listOrder == null ? "[]" : fields.listOrder, now, fields.primaryAudience == null ? null : fields.primaryAudience, fields.listOrder == null ? null : fields.listOrder, now).run();
}

export function previewRel(as, lists) {
  const text = String(as || "");
  if (text === "public") return cleanRel({});
  if (text === "followers") return cleanRel({ follows: true });
  if (text === "friends") return cleanRel({ friends: true, follows: true });
  if (text.indexOf("list:") === 0 && lists.indexOf(text.slice(5)) >= 0) return cleanRel({ lists: [text.slice(5)] });
  return null;
}

export async function handleUsernames(request, env, path, deps) {
  const json = deps.json;
  const session = await deps.sessionAccount(env, request);
  if (!session) return json(401, { error: "unauthorized" });
  const ownerId = session.public_id;
  const method = request.method;
  const nocache = { "cache-control": "no-store" };

  if (path === "/v1/usernames" && method === "GET") return json(200, await present(env, request, ownerId), nocache);

  if (path === "/v1/usernames/preview" && method === "GET") {
    const url = new URL(request.url);
    const as = url.searchParams.get("as") || "public";
    const set = await loadNames(env, ownerId);
    let rel = previewRel(as, await ownerLists(env, ownerId));
    if (!rel) {
      const id = await idForHandle(env, as, ownerId);
      if (!id) return json(404, { error: "not_found" });
      rel = await relationTo(env, ownerId, id);
    }
    const picked = pickName(set.names, rel, set.listOrder);
    return json(200, { as, handle: picked ? picked.handle : "", hidden: !picked }, nocache);
  }

  const body = method === "GET" ? {} : await deps.readJson(request, 40000);
  if (body.error) return json(body.error === "too_large" ? 413 : 400, { error: body.error });

  if (path === "/v1/usernames" && method === "POST") {
    const paced = await deps.rateHit(env, "uname-add:" + ownerId, 10, DAY);
    if (!paced.ok) return deps.limited(paced);
    const checked = inspectHandle(String(body.handle || "").replace(/^@/, ""));
    if (!checked.ok || checked.owner) return json(checked.error === "reserved" || checked.owner ? 409 : 400, { error: checked.error === "reserved" || checked.owner ? "handle_reserved" : "invalid_handle" });
    const set = await loadNames(env, ownerId);
    if (set.names.length >= NAME_CAP) return json(409, { error: "name_cap" });
    const taken = await nameTaken(env, checked.skeleton, ownerId);
    if (taken) return json(409, { error: taken });
    const audience = await audienceIn(env, ownerId, body.audience, { include: { followers: true } });
    const position = set.names.length;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM username_releases WHERE skeleton = ?").bind(checked.skeleton),
      env.DB.prepare("INSERT INTO account_handles (skeleton, public_id, handle, audience, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(checked.skeleton, ownerId, checked.handle, JSON.stringify(audience), position, Date.now())
    ]);
    return json(201, await present(env, request, ownerId), nocache);
  }

  const set = await loadNames(env, ownerId);
  const target = () => {
    const checked = inspectHandle(String(body.handle || "").replace(/^@/, ""));
    return checked.skeleton ? set.names.find((item) => item.skeleton === checked.skeleton) : null;
  };

  if (path === "/v1/usernames" && method === "PATCH") {
    const name = target();
    if (!name) return json(404, { error: "not_found" });
    const audience = JSON.stringify(await audienceIn(env, ownerId, body.audience, PUBLIC_DEFAULT));
    if (name.primary) await savePrefs(env, ownerId, { primaryAudience: audience });
    else await env.DB.prepare("UPDATE account_handles SET audience = ? WHERE skeleton = ? AND public_id = ?").bind(audience, name.skeleton, ownerId).run();
    return json(200, await present(env, request, ownerId), nocache);
  }

  if (path === "/v1/usernames" && method === "DELETE") {
    const name = target();
    if (!name) return json(404, { error: "not_found" });
    if (name.primary) return json(409, { error: "primary_name" });
    await env.DB.batch([
      env.DB.prepare("DELETE FROM account_handles WHERE skeleton = ? AND public_id = ?").bind(name.skeleton, ownerId),
      env.DB.prepare("INSERT INTO username_releases (skeleton, public_id, held_until) VALUES (?, ?, ?) ON CONFLICT(skeleton) DO UPDATE SET public_id = excluded.public_id, held_until = excluded.held_until").bind(name.skeleton, ownerId, Date.now() + RELEASE_DAYS * DAY)
    ]);
    return json(200, await present(env, request, ownerId), nocache);
  }

  if (path === "/v1/usernames/primary" && method === "POST") {
    const name = target();
    if (!name) return json(404, { error: "not_found" });
    if (name.primary) return json(200, await present(env, request, ownerId), nocache);
    if (session.owner === 1) return json(403, { error: "handle_locked" });
    const paced = await deps.rateHit(env, "uname-switch:" + ownerId, SWITCHES_PER_WEEK, 7 * DAY);
    if (!paced.ok) return deps.limited(paced);
    const old = set.names[0];
    await env.DB.batch([
      env.DB.prepare("DELETE FROM account_handles WHERE skeleton = ? AND public_id = ?").bind(name.skeleton, ownerId),
      env.DB.prepare("UPDATE accounts SET handle = ?, skeleton = ? WHERE public_id = ?").bind(name.handle, name.skeleton, ownerId),
      env.DB.prepare("INSERT INTO account_handles (skeleton, public_id, handle, audience, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(old.skeleton, ownerId, old.handle, JSON.stringify(old.audience), name.position, Date.now()),
      env.DB.prepare("INSERT INTO username_prefs (public_id, primary_audience, list_order, updated_at) VALUES (?, ?, '[]', ?) ON CONFLICT(public_id) DO UPDATE SET primary_audience = excluded.primary_audience, updated_at = excluded.updated_at").bind(ownerId, JSON.stringify(name.audience), Date.now())
    ]);
    if (deps.invalidate) { try { await deps.invalidate(env, ownerId); } catch (err) { /* cache ages out */ } }
    return json(200, await present(env, request, ownerId), nocache);
  }

  if (path === "/v1/usernames/order" && method === "PUT") {
    const lists = await ownerLists(env, ownerId);
    const order = uniq(body.lists, LIST_ID, 50).filter((id) => lists.indexOf(id) >= 0);
    await savePrefs(env, ownerId, { listOrder: JSON.stringify(order) });
    return json(200, await present(env, request, ownerId), nocache);
  }

  return json(404, { error: "not_found" });
}
