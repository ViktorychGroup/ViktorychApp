/* Privacy for each friendship.

   Every account can say, per friend, who may see that the two of them are
   friends. The rule uses the same audience model as usernames and display
   names (usernames.js): include public, followers, friends, lists, people;
   exclude followers, friends, lists, people. Exclusions always win, then the
   most specific include matches (person, list, friends, followers, public).

   Modes:
     inherit  "Same as my friend list" (default, no row): the whole-list
              choice in account_friend_prefs.list_audience (everyone ->
              public, friends -> friends, me -> nobody)
     custom   the audience above
     hidden   "Only me": nobody but the two friends

   Both sides: a third person sees the friendship A-F only if A's rule about
   F AND F's rule about A both let them. A always sees it on their own list; on A's list F is judged by A's rule. Blocks on
   either side hide it. Friends off is already applied in SQL
   (friends-pref.js). Nobody bypasses these rules by default. The owner
   inspector registers a bypass with setFriendshipBypass(); see the hook
   below.

   Enforced in the Worker for: friend lists, friend counts (computed per
   viewer), mutual friend counts and lists, request cards, profile counts.
   Nothing reports how many were hidden. */

import { blocksEither } from "./social.js";
import { audienceIn, audienceOut, canSeeName, cleanRel, idForHandle, normalizeNameAudience, ownerLists, previewRel, relationTo } from "./usernames.js";
import { friendFilterReady, friendOnSql, friendPrefs } from "./friends-pref.js";
import { notLockedFriend } from "./locked-sql.js";

export const FRIEND_PRIVACY_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS friendship_privacy (public_id TEXT NOT NULL, friend_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'inherit', audience TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (public_id, friend_id))",
  "CREATE INDEX IF NOT EXISTS friendship_privacy_friend ON friendship_privacy(friend_id)"
];

export const MODES = ["inherit", "custom", "hidden"];
const PUBLIC_ID = /^\d{12}$/;
const NOBODY = normalizeNameAudience({});
const EVERYONE = normalizeNameAudience({ include: { public: true } });
const FRIENDS = normalizeNameAudience({ include: { friends: true } });
const BULK_CAP = 300;
const NO_STORE = { "cache-control": "private, no-store" };

function rowsOf(result) {
  return (result && result.results) || [];
}

let schema = null;
export function ensureFriendPrivacy(env) {
  if (!schema) {
    schema = env.DB.batch(FRIEND_PRIVACY_SCHEMA.map((sql) => env.DB.prepare(sql)))
      .catch((err) => { schema = null; throw err; });
  }
  return schema;
}

function parseRule(row) {
  if (!row) return { mode: "inherit", audience: null };
  const mode = MODES.indexOf(row.mode) >= 0 ? row.mode : "inherit";
  let audience = null;
  if (mode === "custom") {
    try { audience = normalizeNameAudience(JSON.parse(row.audience || "{}")); } catch (err) { audience = NOBODY; }
  }
  return { mode, audience };
}

function listAudienceOf(listAudience) {
  if (listAudience === "me") return NOBODY;
  if (listAudience === "friends") return FRIENDS;
  return EVERYONE;
}

/* The audience that applies to the friendship ownerId -> friendId. */
export function effectiveAudience(rule, listAudience) {
  const r = rule || { mode: "inherit" };
  if (r.mode === "hidden") return NOBODY;
  if (r.mode === "custom" && r.audience) return r.audience;
  return listAudienceOf(listAudience);
}

function isEveryone(aud) {
  return aud.include.public && !aud.exclude.followers && !aud.exclude.friends && !aud.exclude.lists.length && !aud.exclude.people.length;
}

/* Is there any rule at all that could hide a friendship? Per-isolate cache. */
const gate = { at: 0, any: false };
const GATE_MS = 20000;
export function markFriendPrivacyUsed() { gate.any = true; gate.at = Date.now(); }
export function resetFriendPrivacyGate() { gate.at = 0; gate.any = false; }
async function anyRules(env) {
  const now = Date.now();
  if (now - gate.at < GATE_MS) return gate.any;
  let any = false;
  try {
    await ensureFriendPrivacy(env);
    const a = await env.DB.prepare("SELECT 1 AS one FROM friendship_privacy WHERE mode != 'inherit' LIMIT 1").first();
    any = !!a;
    if (!any) {
      const b = await env.DB.prepare("SELECT 1 AS one FROM account_friend_prefs WHERE list_audience != 'everyone' LIMIT 1").first();
      any = !!b;
    }
  } catch (err) { any = true; }
  gate.any = any;
  gate.at = now;
  return any;
}

/* ---------- bypass hook (owner inspector) ----------
   Off unless something registers it. The hook is
     { allows(env, viewer) -> boolean,
       record(env, viewerId, targetIds, action) -> Promise (optional) }
   When allows() is true the viewer sees every friendship, true counts and
   true mutuals; responses then carry ownerView / ownerOnly so the client can
   show the owner view. record() gets the ids of the accounts whose hidden
   friendships were revealed (at most 50 per request) so the inspector can
   write its own audit log. Only friendship edges are revealed here: no
   passwords, codes or messages pass through this module. */
let bypassHook = null;
export function setFriendshipBypass(hook) {
  bypassHook = hook && typeof hook.allows === "function" ? hook : null;
}

/* ---------- per-request viewer context ---------- */

/* viewer: the session account row (or null). opts.noBypass: rules only. */
export function viewerContext(env, viewer, opts) {
  let bypass = false;
  if (viewer && bypassHook && !(opts && opts.noBypass)) {
    try { bypass = bypassHook.allows(env, viewer) === true; } catch (err) { bypass = false; }
  }
  return {
    env,
    viewerId: viewer ? String(viewer.public_id || "") : "",
    bypass,
    rules: new Map(),     // ownerId -> { listAudience, rows: Map friendId -> rule, full }
    rels: new Map(),      // ownerId -> rel of viewer
    blocks: new Map(),    // id -> blocked either way with viewer
    bypassed: new Set(),  // target ids the bypass revealed past the rules
    gate: null
  };
}

async function gateOpen(ctx) {
  if (ctx.gate == null) ctx.gate = await anyRules(ctx.env);
  return ctx.gate;
}

async function rulesOf(ctx, ownerId) {
  let entry = ctx.rules.get(ownerId);
  if (entry && entry.full) return entry;
  const prefs = await friendPrefs(ctx.env, ownerId);
  const rows = new Map();
  try {
    await ensureFriendPrivacy(ctx.env);
    rowsOf(await ctx.env.DB.prepare("SELECT friend_id, mode, audience FROM friendship_privacy WHERE public_id = ?").bind(ownerId).all())
      .forEach((row) => rows.set(String(row.friend_id), parseRule(row)));
  } catch (err) { /* no table: every friendship inherits */ }
  entry = { listAudience: prefs.listAudience, rows, full: true };
  ctx.rules.set(ownerId, entry);
  return entry;
}

/* Load, in a few queries, what each of `ids` says about their friendship
   with `aboutId` (the "other side" of a list). */
async function primeOtherSides(ctx, aboutId, ids) {
  const want = ids.filter((id) => !ctx.rules.has(id));
  for (let i = 0; i < want.length; i += 80) {
    const part = want.slice(i, i + 80);
    const marks = part.map(() => "?").join(",");
    const lists = new Map();
    const rules = new Map();
    try {
      rowsOf(await ctx.env.DB.prepare("SELECT public_id, list_audience FROM account_friend_prefs WHERE public_id IN (" + marks + ")").bind(...part).all())
        .forEach((row) => lists.set(String(row.public_id), row.list_audience));
    } catch (err) { /* defaults */ }
    try {
      rowsOf(await ctx.env.DB.prepare("SELECT public_id, friend_id, mode, audience FROM friendship_privacy WHERE friend_id = ? AND public_id IN (" + marks + ")").bind(aboutId, ...part).all())
        .forEach((row) => rules.set(String(row.public_id), parseRule(row)));
    } catch (err) { /* no table */ }
    part.forEach((id) => {
      const rows = new Map();
      if (rules.has(id)) rows.set(aboutId, rules.get(id));
      ctx.rules.set(id, { listAudience: lists.get(id) || "everyone", rows, full: false, about: aboutId });
    });
  }
}

async function ruleFor(ctx, ownerId, friendId) {
  let entry = ctx.rules.get(ownerId);
  if (!entry || (!entry.full && entry.about !== friendId)) entry = await rulesOf(ctx, ownerId);
  return effectiveAudience(entry.rows.get(friendId), entry.listAudience);
}

async function relOf(ctx, ownerId) {
  if (!ctx.rels.has(ownerId)) ctx.rels.set(ownerId, ctx.viewerId ? relationTo(ctx.env, ownerId, ctx.viewerId) : Promise.resolve(cleanRel({})));
  return ctx.rels.get(ownerId);
}

async function blockedWith(ctx, id) {
  if (!ctx.viewerId || id === ctx.viewerId) return false;
  if (!ctx.blocks.has(id)) ctx.blocks.set(id, blocksEither(ctx.env, ctx.viewerId, id));
  return ctx.blocks.get(id);
}

/* One side: does ownerId's rule about friendId let the viewer see it? */
async function sideAllows(ctx, ownerId, friendId) {
  const aud = await ruleFor(ctx, ownerId, friendId);
  if (isEveryone(aud)) return true;
  return canSeeName({ audience: aud }, await relOf(ctx, ownerId));
}

/* What the rules alone say (no owner bypass). */
async function rulesAllow(ctx, a, f) {
  const v = ctx.viewerId;
  // Your own list always shows all of your friends.
  if (v && v === a) return true;
  if (await blockedWith(ctx, a) || await blockedWith(ctx, f)) return false;
  if (!(await gateOpen(ctx))) return true;
  // On someone else's list you are judged by their rule even about you
  // ("Only me" means only them), the same way any other viewer is.
  if (v && v === f) return sideAllows(ctx, a, f);
  return (await sideAllows(ctx, a, f)) && (await sideAllows(ctx, f, a));
}

/* May the viewer see that a and f are friends? `target` is whose page the
   viewer is reading (handed to the bypass hook's record()). */
export async function friendshipVisible(ctx, a, f, target) {
  if (await rulesAllow(ctx, a, f)) return true;
  if (ctx.bypass) {
    ctx.bypassed.add(String(target || a));
    return true;
  }
  return false;
}

/* Keep only the friends of ownerId the viewer may see. Order kept. */
export async function filterFriends(ctx, ownerId, ids) {
  const list = (ids || []).map(String);
  if (!list.length) return [];
  if (ctx.viewerId === ownerId) return list;
  if (await gateOpen(ctx)) {
    await rulesOf(ctx, ownerId);
    await primeOtherSides(ctx, ownerId, list);
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (await friendshipVisible(ctx, ownerId, list[i], ownerId)) out.push(list[i]);
  }
  return out;
}

/* Rule-only view for the owner's "only you see this" badge: which of these
   the rules alone would hide (pass a viewerContext(..., { noBypass: true })). */
export async function hiddenWithoutBypass(ctx, ownerId, ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i++) {
    if (!(await rulesAllow(ctx, ownerId, String(ids[i])))) out.add(String(ids[i]));
  }
  return out;
}

async function friendIdsOf(env, id, limit) {
  const on = await friendFilterReady(env);
  const got = await env.DB.prepare("SELECT f.friend_id FROM account_friends f WHERE f.user_id = ?" + (on ? friendOnSql("f.friend_id") : "") + notLockedFriend("f.user_id", "f.friend_id") + " ORDER BY f.created_at DESC LIMIT " + Number(limit || 5000)).bind(id).all();
  return rowsOf(got).map((row) => String(row.friend_id));
}

/* Friend count of ownerId as this viewer may see it. */
export async function visibleFriendCount(ctx, ownerId) {
  try {
    const ids = await friendIdsOf(ctx.env, ownerId, 5000);
    if (ctx.viewerId === ownerId) return ids.length;
    return (await filterFriends(ctx, ownerId, ids)).length;
  } catch (err) { return 0; }
}

/* Friends shared by the viewer and targetId that the viewer may see on
   targetId's side (the viewer's own side is always theirs to see). */
export async function visibleMutualIds(ctx, targetId) {
  const v = ctx.viewerId;
  if (!v || !targetId || v === targetId) return [];
  try {
    const on = await friendFilterReady(ctx.env);
    const got = await ctx.env.DB.prepare("SELECT f1.friend_id FROM account_friends f1 JOIN account_friends f2 ON f1.friend_id = f2.friend_id WHERE f1.user_id = ? AND f2.user_id = ?" + (on ? friendOnSql("f1.friend_id") : "") + notLockedFriend("f2.user_id", "f1.friend_id") + " LIMIT 2000").bind(v, targetId).all();
    const ids = rowsOf(got).map((row) => String(row.friend_id));
    return filterFriends(ctx, targetId, ids);
  } catch (err) { return []; }
}

export async function visibleMutualCount(ctx, targetId) {
  return (await visibleMutualIds(ctx, targetId)).length;
}

/* Hand what the bypass revealed to the hook's record(), once per request. */
export async function flushBypass(ctx, action) {
  if (!ctx.bypass || !ctx.bypassed.size) return;
  const ids = Array.from(ctx.bypassed).slice(0, 50);
  ctx.bypassed.clear();
  if (!bypassHook || typeof bypassHook.record !== "function") return;
  try { await bypassHook.record(ctx.env, ctx.viewerId, ids, action || "friendship_bypass"); } catch (err) { /* the view still answers */ }
}

/* ---------- client form ---------- */

async function ruleOut(env, request, ownerId, rule) {
  if (rule.mode !== "custom" || !rule.audience) return { mode: rule.mode };
  return { mode: "custom", audience: await audienceOut(env, request, ownerId, rule.audience) };
}

async function ruleIn(env, ownerId, raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const mode = MODES.indexOf(src.mode) >= 0 ? src.mode : "";
  if (!mode) return null;
  if (mode !== "custom") return { mode, audience: null };
  const audience = await audienceIn(env, ownerId, src.audience, {});
  return { mode, audience };
}

async function friendRows(env, ownerId) {
  const on = await friendFilterReady(env);
  return rowsOf(await env.DB.prepare(
    "SELECT f.friend_id, a.handle, a.display_name, a.avatar, a.hide_avatar, a.avatar_empty FROM account_friends f JOIN accounts a ON a.public_id = f.friend_id WHERE f.user_id = ?" + (on ? friendOnSql("f.friend_id") : "") + " ORDER BY f.created_at DESC LIMIT 1000"
  ).bind(ownerId).all());
}

function avatarUrl(request, row) {
  const text = String(row.avatar || "");
  if (row.hide_avatar === "none" || row.hide_avatar === "default") return "";
  if (/^media\/avatars\/\d{12}\/[a-f0-9]{64}\.(webp|jpg|png)$/.test(text) && request) return new URL("/v1/" + text, request.url).toString();
  if (text.indexOf("data:image/") === 0) return text;
  return "";
}

async function present(env, request, ownerId) {
  const prefs = await friendPrefs(env, ownerId);
  const entry = await rulesOf(viewerContext(env, null), ownerId);
  const rows = await friendRows(env, ownerId);
  const friends = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rule = entry.rows.get(String(row.friend_id)) || { mode: "inherit" };
    friends.push({ handle: row.handle || "", name: row.display_name || row.handle || "", avatar: avatarUrl(request, row), rule: await ruleOut(env, request, ownerId, rule) });
  }
  let lists = [];
  try {
    lists = rowsOf(await env.DB.prepare("SELECT id, name, icon FROM audience_lists WHERE public_id = ? ORDER BY created_at ASC").bind(ownerId).all())
      .map((row) => ({ id: row.id, name: row.name || "", icon: row.icon || "" }));
  } catch (err) { lists = []; }
  return { v: 1, listAudience: prefs.listAudience, friendsOn: prefs.enabled, friends, lists };
}

async function friendIdByHandle(env, ownerId, handle) {
  const id = await idForHandle(env, String(handle || "").replace(/^@/, ""), ownerId);
  if (!id) return "";
  const row = await env.DB.prepare("SELECT friend_id FROM account_friends WHERE user_id = ? AND friend_id = ?").bind(ownerId, id).first();
  return row ? id : "";
}

/* Preview: what one kind of viewer sees of the signed-in person's friend
   list, judged by THEIR OWN rules only. The friend's own rules can hide a
   friendship further; the preview never reveals what those rules say. */
async function preview(env, request, ownerId, as) {
  const lists = await ownerLists(env, ownerId);
  let rel = previewRel(as, lists);
  let viewerId = "";
  if (!rel) {
    viewerId = await idForHandle(env, String(as || "").replace(/^@/, ""), ownerId);
    if (!viewerId) return null;
    rel = await relationTo(env, ownerId, viewerId);
  }
  const prefs = await friendPrefs(env, ownerId);
  const entry = await rulesOf(viewerContext(env, null), ownerId);
  const rows = await friendRows(env, ownerId);
  const visible = [];
  for (let i = 0; i < rows.length; i++) {
    const fid = String(rows[i].friend_id);
    if (viewerId && fid === viewerId) { visible.push(rows[i].handle || ""); continue; }
    if (viewerId && await blocksEither(env, viewerId, fid)) continue;
    const aud = effectiveAudience(entry.rows.get(fid), prefs.listAudience);
    if (isEveryone(aud) || canSeeName({ audience: aud }, rel)) visible.push(rows[i].handle || "");
  }
  return { as, visible, count: visible.length, total: rows.length, ownSideOnly: true };
}

/* GET  /v1/friends/privacy                 own rules for every friend
   PUT  /v1/friends/privacy                 { handles: [..], rule: { mode, audience } }
   GET  /v1/friends/privacy/preview?as=     public | followers | friends | list:ID | handle */
export async function handleFriendPrivacy(request, env, path, deps) {
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return deps.json(401, { error: "unauthorized" });
  const ownerId = String(viewer.public_id);
  await ensureFriendPrivacy(env);
  if (path === "/v1/friends/privacy/preview" && request.method === "GET") {
    const as = new URL(request.url).searchParams.get("as") || "public";
    const out = await preview(env, request, ownerId, as);
    if (!out) return deps.json(404, { error: "not_found" }, NO_STORE);
    return deps.json(200, out, NO_STORE);
  }
  if (path !== "/v1/friends/privacy") return deps.json(404, { error: "not_found" });
  if (request.method === "GET") return deps.json(200, await present(env, request, ownerId), NO_STORE);
  if (request.method !== "PUT" && request.method !== "POST") return deps.json(405, { error: "method" });
  const paced = await deps.rateHit(env, "fpriv:" + ownerId, 120, 10 * 60 * 1000);
  if (!paced.ok) return deps.limited(paced);
  const body = await deps.readJson(request, 60000);
  if (!body || body.error) return deps.json(400, { error: "bad_json" });
  const rule = await ruleIn(env, ownerId, body.rule);
  if (!rule) return deps.json(400, { error: "bad_rule" });
  const handles = Array.isArray(body.handles) ? body.handles.slice(0, BULK_CAP) : (body.handle ? [body.handle] : []);
  if (!handles.length) return deps.json(400, { error: "no_friends" });
  const ids = [];
  for (let i = 0; i < handles.length; i++) {
    const id = await friendIdByHandle(env, ownerId, handles[i]);
    if (id && ids.indexOf(id) < 0) ids.push(id);
  }
  if (!ids.length) return deps.json(404, { error: "not_found" });
  const now = Date.now();
  const stmts = ids.map((id) => rule.mode === "inherit"
    ? env.DB.prepare("DELETE FROM friendship_privacy WHERE public_id = ? AND friend_id = ?").bind(ownerId, id)
    : env.DB.prepare("INSERT INTO friendship_privacy (public_id, friend_id, mode, audience, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(public_id, friend_id) DO UPDATE SET mode = excluded.mode, audience = excluded.audience, updated_at = excluded.updated_at")
      .bind(ownerId, id, rule.mode, rule.audience ? JSON.stringify(rule.audience) : "{}", now));
  await env.DB.batch(stmts);
  if (rule.mode !== "inherit") markFriendPrivacyUsed();
  else resetFriendPrivacyGate();
  if (deps.signal) { try { await deps.signal(env, [ownerId]); } catch (err) { /* saved */ } }
  return deps.json(200, Object.assign({ ok: true, saved: ids.length }, await present(env, request, ownerId)), NO_STORE);
}

/* A removed friendship takes its rules with it. */
export async function dropFriendshipRules(env, a, b) {
  try {
    await ensureFriendPrivacy(env);
    await env.DB.prepare("DELETE FROM friendship_privacy WHERE (public_id = ? AND friend_id = ?) OR (public_id = ? AND friend_id = ?)").bind(a, b, b, a).run();
  } catch (err) { /* nothing stored */ }
}
