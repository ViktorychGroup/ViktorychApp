/* @mention autocomplete. Prefix, case-insensitive match on handles (every
   claimed username when account_handles exists) and display names, read
   through expression indexes (migration 0072). People the viewer follows
   or has mentioned rank first. The candidate list per prefix is public and
   cached at the edge for a minute; ranking is per viewer and never cached
   shared. */

import { blocksEither } from "./social.js";
import { lockedAccountSet } from "./locked-sql.js";
import { resolveName, viewerHandle } from "./usernames.js";
import { canMention } from "./name-rules.js";

const LIMIT = 8;
const EDGE_SECONDS = 60;

export function cleanPrefix(raw) {
  const text = String(raw || "").replace(/^@+/, "").trim().toLowerCase().slice(0, 30);
  return /^[\p{L}\p{N}_ .-]{1,30}$/u.test(text) ? text : "";
}

/* "abc" -> ["abc", "abd"): a range the lower() index can walk. */
function prefixRange(prefix) {
  const last = prefix.charCodeAt(prefix.length - 1);
  return [prefix, prefix.slice(0, -1) + String.fromCharCode(last + 1)];
}

async function rows(env, sql, args) {
  try {
    const out = await env.DB.prepare(sql).bind(...args).all();
    return (out && out.results) || [];
  } catch (err) {
    return [];
  }
}

async function candidates(env, prefix) {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  const key = new Request("https://viktorych-edge.internal/mention-suggest-v2/" + encodeURIComponent(prefix));
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return await hit.json();
    } catch (err) { /* read D1 */ }
  }
  const [lo, hi] = prefixRange(prefix);
  const found = {};
  const order = [];
  /* via: the handle that matched, or "" for a display-name match. Which
     names a viewer may see is decided per viewer, never here. */
  function add(list, via) {
    list.forEach((row) => {
      if (!row || !row.public_id) return;
      const tag = via == null ? row.handle : via;
      let hit = found[row.public_id];
      if (!hit) {
        hit = found[row.public_id] = { id: row.public_id, handle: row.handle, name: row.display_name, avatar: row.avatar, hide: row.hide_avatar, empty: row.avatar_empty, owner: row.owner === 1, via: [] };
        order.push(row.public_id);
      }
      if (hit.via.indexOf(tag) < 0) hit.via.push(tag);
    });
  }
  const cols = "a.public_id, a.handle, a.display_name, a.avatar, a.hide_avatar, a.avatar_empty, a.owner";
  add(await rows(env, "SELECT " + cols + " FROM accounts a WHERE lower(a.handle) >= ? AND lower(a.handle) < ? AND a.profile_less = 0 ORDER BY lower(a.handle) LIMIT 40", [lo, hi]));
  const aliases = await rows(env, "SELECT " + cols + ", h.handle AS alias FROM account_handles h JOIN accounts a ON a.public_id = h.public_id WHERE lower(h.handle) >= ? AND lower(h.handle) < ? AND a.profile_less = 0 ORDER BY lower(h.handle) LIMIT 40", [lo, hi]);
  aliases.forEach((row) => add([row], String(row.alias || "")));
  add(await rows(env, "SELECT " + cols + " FROM accounts a WHERE lower(a.display_name) >= ? AND lower(a.display_name) < ? AND a.profile_less = 0 ORDER BY lower(a.display_name) LIMIT 40", [lo, hi]), "");
  const list = order.slice(0, 60).map((id) => found[id]);
  if (cache) {
    try {
      await cache.put(key, new Response(JSON.stringify(list), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + EDGE_SECONDS } }));
    } catch (err) { /* the answer still goes out */ }
  }
  return list;
}

async function idSet(env, sql, viewerId, ids) {
  if (!ids.length) return new Set();
  const marks = ids.map(() => "?").join(",");
  const list = await rows(env, sql.replace("$IN", marks), [viewerId].concat(ids));
  return new Set(list.map((row) => String(row.id || "").replace(/^app:/, "")));
}

export async function mentionSuggest(env, request, url, viewer, deps) {
  const prefix = cleanPrefix(url.searchParams.get("q"));
  const headers = { "cache-control": "private, max-age=30" };
  if (!prefix) return deps.json(200, { accounts: [] }, headers);
  const paced = await deps.rateHit(env, "mention:" + viewer.public_id, 300, 10 * 60 * 1000);
  if (!paced.ok) return deps.json(429, { error: "rate_limited" }, { "retry-after": String(paced.retry || 60) });
  const lockedIds = await lockedAccountSet(env, viewer.public_id);
  const list = (await candidates(env, prefix)).filter((row) => row.id !== viewer.public_id && !lockedIds.has(String(row.id)));
  const ids = list.map((row) => row.id);
  const follows = await idSet(env, "SELECT target_id AS id FROM account_follows WHERE follower_id = ? AND target_id IN ($IN)", viewer.public_id, ids.map((id) => "app:" + id));
  const talked = await idSet(env, "SELECT target_id AS id FROM mentions WHERE author_id = ? AND target_id IN ($IN)", viewer.public_id, ids);
  function score(row) {
    let s = 0;
    if (follows.has(row.id)) s += 4;
    if (talked.has(row.id)) s += 2;
    if (String(row.handle || "").toLowerCase() === prefix) s += 8;
    else if (String(row.handle || "").toLowerCase().indexOf(prefix) === 0) s += 1;
    return s;
  }
  const ranked = list.map((row, at) => ({ row, at, s: score(row) })).sort((a, b) => b.s - a.s || a.at - b.at);
  const out = [];
  let hint = "";
  let replyTo = "";
  const reply = url.searchParams.get("reply");
  if (reply) {
    const up = await resolveName(env, reply, viewer.public_id);
    replyTo = up ? up.publicId : "";
  }
  for (let i = 0; i < ranked.length && out.length < LIMIT; i++) {
    const row = ranked[i].row;
    if (await blocksEither(env, viewer.public_id, row.id)) continue;
    const seen = await viewerHandle(env, request, row.id, viewer.public_id);
    if (seen.hidden) continue;
    const via = Array.isArray(row.via) ? row.via : [];
    let reachable = via.indexOf("") >= 0;
    for (let v = 0; !reachable && v < via.length; v++) reachable = !!(await resolveName(env, via[v], viewer.public_id));
    if (!reachable) continue;
    if (!(await canMention(env, row.id, viewer.public_id, { replyTo }))) {
      if (String(seen.handle || "").toLowerCase() === prefix) hint = "cant_mention";
      continue;
    }
    const avatar = row.hide ? "" : deps.mediaUrl(request, row.avatar);
    out.push({ kind: "account", handle: seen.handle, name: row.name || "", avatar: avatar || "", owner: row.owner, follows: follows.has(row.id) });
  }
  return deps.json(200, hint ? { accounts: out, hint } : { accounts: out }, headers);
}
