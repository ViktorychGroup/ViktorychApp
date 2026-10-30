/* Owner source lists. The owner keeps named lists of extra sources and
   assigns each list to chosen accounts. Only those accounts see the posts.
   Everything here lives in private R2: list names, sources, handles and
   assignments never reach the public repo, the Pages site or a log.

   owner/source-lists.json  lists, sources, members, pending requests (Worker only)
   owner/lists/wanted.json  sources of lists with an active member, no account ids (read by the sync)
   owner/lists/index.json   per-list shard hash, written by scripts/source_lists.py
   lists/shards/<sha256>.json  one content-addressed shard per list version

   A member reads /v1/me/source-lists for the hashes, then the shard by hash
   from here, or from any peer (the hash verifies the bytes). */

import { ERROR_TEXT, accountId, cleanLabel, detectInput } from "../../shared/feed-sources.js";
import { probeAccount, probeWithin, unverifiedProbe } from "./owner-feeds.js";
import { bannedSpec, keyVariants } from "./feed-requests.js";

const DOC_KEY = "owner/source-lists.json";
const WANTED_KEY = "owner/lists/wanted.json";
const INDEX_KEY = "owner/lists/index.json";
const SHARD_PREFIX = "lists/shards/";
const LIST_CAP = 40;
const SOURCE_CAP = 60;
const SOURCES_PER_LIST = 40;
const MEMBERS_PER_LIST = 500;
const REQUEST_CAP = 200;
const REQUESTS_PER_USER = 5;
const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
const JSON_TYPE = { httpMetadata: { contentType: "application/json; charset=utf-8" } };

function emptyDoc() {
  return { v: 1, lists: [], sources: {}, requests: [] };
}

function hex(bytes) {
  return Array.from(bytes).map((n) => n.toString(16).padStart(2, "0")).join("");
}

function newId(prefix) {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return prefix + hex(bytes);
}

function listIdOk(value) {
  return /^s[a-f0-9]{8}$/.test(String(value || ""));
}

function requestIdOk(value) {
  return /^r[a-f0-9]{8}$/.test(String(value || ""));
}

function sourceIdOk(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,90}$/.test(id) && id.indexOf("..") < 0;
}

function hashOk(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function cleanName(value) {
  return Array.from(String(value || "").replace(/[\u0000-\u001F\u007F<>]/g, "").replace(/\s+/g, " ").trim()).slice(0, 60).join("");
}

async function readJson(env, key) {
  if (!env.DATA) return null;
  try {
    const object = await env.DATA.get(key);
    if (!object) return null;
    const parsed = JSON.parse(await object.text());
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
}

async function readDoc(env) {
  const doc = Object.assign(emptyDoc(), (await readJson(env, DOC_KEY)) || {});
  doc.lists = Array.isArray(doc.lists) ? doc.lists.filter((row) => row && listIdOk(row.id)) : [];
  doc.sources = doc.sources && typeof doc.sources === "object" ? doc.sources : {};
  doc.requests = Array.isArray(doc.requests) ? doc.requests.filter((row) => row && requestIdOk(row.id)) : [];
  doc.lists.forEach((row) => {
    row.sources = Array.isArray(row.sources) ? row.sources.filter((id) => doc.sources[id]) : [];
    row.members = Array.isArray(row.members) ? row.members.map(String) : [];
  });
  return doc;
}

async function writeDoc(env, doc) {
  // Sources no list uses are dropped, so nothing is fetched for them.
  const used = new Set();
  doc.lists.forEach((row) => row.sources.forEach((id) => used.add(id)));
  Object.keys(doc.sources).forEach((id) => { if (!used.has(id)) delete doc.sources[id]; });
  await env.DATA.put(DOC_KEY, JSON.stringify(doc), JSON_TYPE);
}

/* Members with an account that signed in within 30 days (or joined within 30 days). */
async function activeMembers(env, ids, now) {
  const out = new Set();
  const list = Array.from(new Set(ids)).filter(Boolean);
  if (!list.length || !env.DB) return out;
  const since = now - ACTIVE_MS;
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    const marks = part.map(() => "?").join(",");
    let rows = [];
    try {
      const res = await env.DB.prepare(
        `SELECT a.public_id AS id, a.created_at AS created, (SELECT MAX(last_seen) FROM session_devices s WHERE s.public_id = a.public_id) AS seen FROM accounts a WHERE a.public_id IN (${marks})`
      ).bind(...part).all();
      rows = res.results || [];
    } catch (err) {
      const res = await env.DB.prepare(`SELECT public_id AS id, created_at AS created FROM accounts WHERE public_id IN (${marks})`).bind(...part).all();
      rows = (res.results || []).map((row) => Object.assign({ seen: now }, row));
    }
    rows.forEach((row) => {
      const seen = Math.max(Number(row.seen) || 0, Number(row.created) || 0);
      if (seen >= since) out.add(String(row.id));
    });
  }
  return out;
}

function sourceSpec(row) {
  return {
    id: row.id,
    platform: row.platform,
    handle: row.handle,
    url: row.url || "",
    channelId: row.channelId || "",
    host: row.host || "",
    redditKind: row.redditKind || "",
    permanentId: row.permanentId || "",
    name: row.name || "",
    avatar: row.avatar || ""
  };
}

/* What the sync fetches: each source once, only for lists someone active reads. */
async function writeWanted(env, doc, now) {
  const all = [];
  doc.lists.forEach((row) => all.push(...row.members));
  const active = await activeMembers(env, all, now || Date.now());
  const lists = [];
  const sources = new Map();
  doc.lists.forEach((row) => {
    if (!row.sources.length || !row.members.some((id) => active.has(id))) return;
    lists.push({ id: row.id, sources: row.sources.slice() });
    row.sources.forEach((id) => { if (doc.sources[id] && !sources.has(id)) sources.set(id, sourceSpec(doc.sources[id])); });
  });
  const body = { v: 1, at: now || Date.now(), lists, sources: Array.from(sources.values()).slice(0, SOURCE_CAP) };
  const before = await readJson(env, WANTED_KEY);
  const sig = (doc) => JSON.stringify({ l: (doc && doc.lists) || [], s: ((doc && doc.sources) || []).map((row) => row.id) });
  await env.DATA.put(WANTED_KEY, JSON.stringify(body), JSON_TYPE);
  return sig(before) !== sig(body);
}

function memberRow(row) {
  return { id: String(row.public_id), handle: row.handle || "", name: row.display_name || row.handle || "", avatar: row.avatar || "" };
}

async function accountsById(env, ids) {
  const map = {};
  const list = Array.from(new Set(ids)).filter(Boolean);
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    const res = await env.DB.prepare(`SELECT public_id, handle, display_name, avatar FROM accounts WHERE public_id IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    (res.results || []).forEach((row) => { map[String(row.public_id)] = memberRow(row); });
  }
  return map;
}

function publicSource(row, index) {
  const health = (index && index.sources && index.sources[row.id]) || null;
  return {
    id: row.id,
    platform: row.platform,
    handle: row.handle,
    name: row.name || row.handle,
    avatar: row.avatar || "",
    url: row.url || "",
    preview: Array.isArray(row.preview) ? row.preview.slice(0, 3) : [],
    health: health ? { ok: health.ok === true, count: Number(health.count) || 0, at: Number(health.at) || 0 } : null
  };
}

async function ownerBody(env, doc) {
  const index = (await readJson(env, INDEX_KEY)) || {};
  const ids = [];
  doc.lists.forEach((row) => ids.push(...row.members));
  doc.requests.forEach((row) => ids.push(row.by));
  const people = await accountsById(env, ids);
  const active = await activeMembers(env, ids, Date.now());
  const shards = index.lists || {};
  return {
    lists: doc.lists.map((row) => ({
      id: row.id,
      name: row.name,
      at: row.at || 0,
      sources: row.sources.map((id) => publicSource(doc.sources[id], index)),
      members: row.members.filter((id) => people[id]).map((id) => Object.assign({ active: active.has(id) }, people[id])),
      shard: shards[row.id] ? { size: Number(shards[row.id].size) || 0, count: Number(shards[row.id].count) || 0, at: Number(shards[row.id].at) || 0 } : null
    })),
    requests: doc.requests.map((row) => ({
      id: row.id,
      input: row.input,
      platform: row.platform,
      note: row.note || "",
      at: row.at,
      by: people[row.by] || { id: row.by, handle: "", name: "" }
    }))
  };
}

async function addSource(env, doc, list, input, opts) {
  const options = opts || {};
  const spec = detectInput(input || "");
  if (!spec.ok) return { error: spec.error || "bad_input", status: 400 };
  if (spec.platform === "tiktok") return { error: "unsupported_tiktok", status: 400 };
  if (await bannedSpec(env, spec)) return { error: "banned", status: 403 };
  if (list.sources.length >= SOURCES_PER_LIST) return { error: "full", status: 400 };
  let probed = options.unverified ? await probeWithin(spec, options.probeMs || 6000) : await probeAccount(spec);
  if (probed.error && options.unverified && probed.error !== "private_host" && probed.error !== "bad_feed") probed = unverifiedProbe(spec, probed);
  if (probed.error) return { error: probed.error, status: probed.error === "not_found" ? 404 : probed.error === "rate" ? 429 : 400 };
  const handle = probed.profile.handle || spec.handle;
  const id = accountId(Object.assign({}, spec, { channelId: probed.channelId || spec.channelId || "", handle }));
  if (!sourceIdOk(id)) return { error: "bad_input", status: 400 };
  if (!doc.sources[id]) {
    if (Object.keys(doc.sources).length >= SOURCE_CAP) return { error: "full", status: 400 };
    doc.sources[id] = {
      id,
      platform: spec.platform,
      handle,
      host: spec.host || "",
      redditKind: spec.redditKind || "",
      url: probed.profile.url || spec.url || "",
      channelId: probed.channelId || "",
      permanentId: probed.profile.permanentId || "",
      name: cleanLabel(probed.profile.name || handle) || handle,
      avatar: probed.profile.avatar || "",
      preview: (probed.posts || []).slice(0, 3).map((post) => ({ id: String(post.id || ""), text: String(post.text || "").slice(0, 180), date: String(post.date || ""), url: String(post.url || "") })),
      addedAt: Date.now()
    };
  }
  if (list.sources.indexOf(id) < 0) list.sources.push(id);
  return { id };
}

async function afterChange(env, doc, deps) {
  await writeDoc(env, doc);
  const changed = await writeWanted(env, doc, Date.now());
  if (changed && deps.dispatchWorkflows) {
    try { await deps.dispatchWorkflows(env, ["sync.yml"]); } catch (err) { /* the next scheduled sync fetches it */ }
  }
}

async function handleOwnerSourceLists(request, env, path, deps) {
  const gate = await deps.requireOwnerHidden(request, env);
  if (gate.error) return gate.error;
  if (!env.DATA || !env.DB) return deps.json(503, { error: "not_configured" });
  const method = request.method;
  const bucket = "source-lists:" + gate.row.public_id;
  const hit = await deps.rateHit(env, bucket + ":" + (method === "GET" ? "read" : "write"), method === "GET" ? 120 : 80, 60 * 60 * 1000);
  if (!hit.ok) return deps.limited(hit);
  const doc = await readDoc(env);

  if (path === "/v1/owner/source-lists" && method === "GET") return deps.json(200, await ownerBody(env, doc));

  if (path === "/v1/owner/source-lists" && method === "POST") {
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    const name = cleanName(body.name);
    if (!name) return deps.json(400, { error: "bad_name" });
    if (doc.lists.length >= LIST_CAP) return deps.json(400, { error: "full" });
    const list = { id: newId("s"), name, sources: [], members: [], at: Date.now() };
    doc.lists.push(list);
    await writeDoc(env, doc);
    return deps.json(200, Object.assign({ created: list.id }, await ownerBody(env, doc)));
  }

  const reqPath = path.match(/^\/v1\/owner\/source-lists\/requests\/([^/]+)(\/approve)?$/);
  if (reqPath) {
    const rid = reqPath[1];
    if (!requestIdOk(rid)) return deps.json(400, { error: "bad_id" });
    const row = doc.requests.find((item) => item.id === rid);
    if (!row) return deps.json(404, { error: "not_found" });
    if (method === "DELETE" && !reqPath[2]) {
      doc.requests = doc.requests.filter((item) => item.id !== rid);
      await writeDoc(env, doc);
      return deps.json(200, await ownerBody(env, doc));
    }
    if (method === "POST" && reqPath[2]) {
      const body = await deps.readJson(request, 1000);
      if (body.error) return deps.json(400, { error: body.error });
      let list = doc.lists.find((item) => item.id === body.listId);
      if (!list && body.newList) {
        const name = cleanName(body.newList);
        if (!name || doc.lists.length >= LIST_CAP) return deps.json(400, { error: "bad_name" });
        list = { id: newId("s"), name, sources: [], members: [], at: Date.now() };
        doc.lists.push(list);
      }
      if (!list) return deps.json(400, { error: "bad_list" });
      const added = await addSource(env, doc, list, row.input);
      if (added.error) return deps.json(added.status, { error: added.error, message: ERROR_TEXT[added.error] || "" });
      if (body.assign !== false && row.by && list.members.indexOf(row.by) < 0 && list.members.length < MEMBERS_PER_LIST) list.members.push(row.by);
      doc.requests = doc.requests.filter((item) => item.id !== rid);
      await afterChange(env, doc, deps);
      return deps.json(200, await ownerBody(env, doc));
    }
    return deps.json(404, { error: "not_found" });
  }

  const listPath = path.match(/^\/v1\/owner\/source-lists\/([^/]+)(?:\/(sources|members)(?:\/([^/]+))?)?$/);
  if (!listPath || !listIdOk(listPath[1])) return deps.json(404, { error: "not_found" });
  const list = doc.lists.find((item) => item.id === listPath[1]);
  if (!list) return deps.json(404, { error: "not_found" });
  const part = listPath[2] || "";
  let target = listPath[3] || "";
  try { target = decodeURIComponent(target); } catch (err) { /* keep the raw segment */ }

  if (!part && method === "PATCH") {
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    const name = cleanName(body.name);
    if (!name) return deps.json(400, { error: "bad_name" });
    list.name = name;
    await writeDoc(env, doc);
    return deps.json(200, await ownerBody(env, doc));
  }
  if (!part && method === "DELETE") {
    doc.lists = doc.lists.filter((item) => item.id !== list.id);
    await afterChange(env, doc, deps);
    return deps.json(200, await ownerBody(env, doc));
  }
  if (part === "sources" && !target && method === "POST") {
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const added = await addSource(env, doc, list, body.input);
    if (added.error) return deps.json(added.status, { error: added.error, message: ERROR_TEXT[added.error] || "" });
    await afterChange(env, doc, deps);
    return deps.json(200, Object.assign({ added: added.id }, await ownerBody(env, doc)));
  }
  if (part === "sources" && target && method === "DELETE") {
    list.sources = list.sources.filter((id) => id !== target);
    await afterChange(env, doc, deps);
    return deps.json(200, await ownerBody(env, doc));
  }
  if (part === "members" && !target && method === "POST") {
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    const handle = String(body.handle || "").trim().replace(/^@/, "");
    if (!handle || handle.length > 60) return deps.json(400, { error: "bad_handle" });
    const row = await env.DB.prepare("SELECT public_id, handle, display_name, avatar FROM accounts WHERE lower(handle) = lower(?)").bind(handle).first();
    if (!row) return deps.json(404, { error: "no_account" });
    if (list.members.length >= MEMBERS_PER_LIST) return deps.json(400, { error: "full" });
    if (list.members.indexOf(String(row.public_id)) < 0) list.members.push(String(row.public_id));
    await afterChange(env, doc, deps);
    return deps.json(200, await ownerBody(env, doc));
  }
  if (part === "members" && target && method === "DELETE") {
    list.members = list.members.filter((id) => id !== target);
    await afterChange(env, doc, deps);
    return deps.json(200, await ownerBody(env, doc));
  }
  return deps.json(404, { error: "not_found" });
}

async function handleMySourceLists(request, env, path, deps) {
  const me = await deps.sessionAccount(env, request);
  if (!me) return deps.json(401, { error: "auth" });
  if (!env.DATA) return deps.json(503, { error: "not_configured" });
  const id = String(me.public_id);
  const method = request.method;
  const doc = await readDoc(env);
  const mine = doc.lists.filter((row) => row.members.indexOf(id) >= 0);

  if (path === "/v1/me/source-lists" && method === "GET") {
    // Read only: no rate row is written, so the check costs no D1 write.
    const index = (await readJson(env, INDEX_KEY)) || {};
    const shards = index.lists || {};
    if (mine.length) {
      // A member who came back after a quiet month switches the fetch back on.
      const wanted = (await readJson(env, WANTED_KEY)) || {};
      const live = new Set(((wanted.lists) || []).map((row) => row.id));
      if (mine.some((row) => row.sources.length && !live.has(row.id))) await writeWanted(env, doc, Date.now());
    }
    return deps.json(200, {
      lists: mine.map((row) => {
        const shard = shards[row.id] || {};
        return { id: row.id, name: row.name, hash: hashOk(shard.hash) ? shard.hash : "", size: Number(shard.size) || 0, at: Number(shard.at) || 0 };
      })
    }, { "cache-control": "private, no-store" });
  }

  const shardPath = path.match(/^\/v1\/me\/source-lists\/shard\/([a-f0-9]{64})$/);
  if (shardPath && method === "GET") {
    const hit = await deps.rateHit(env, "my-lists-shard:" + id, 240, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const index = (await readJson(env, INDEX_KEY)) || {};
    const shards = index.lists || {};
    if (!mine.some((row) => shards[row.id] && shards[row.id].hash === shardPath[1])) return deps.json(404, { error: "not_found" });
    const object = await env.DATA.get(SHARD_PREFIX + shardPath[1] + ".json");
    if (!object) return deps.json(404, { error: "not_found" });
    return new Response(object.body, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=31536000, immutable" }
    });
  }

  if (path === "/v1/me/source-lists/requests" && method === "GET") {
    return deps.json(200, { requests: doc.requests.filter((row) => row.by === id).map((row) => ({ id: row.id, input: row.input, platform: row.platform, at: row.at })) });
  }

  if (path === "/v1/me/source-lists/requests" && method === "POST") {
    const hit = await deps.rateHit(env, "my-lists-request:" + id, 10, 24 * 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 1500);
    if (body.error) return deps.json(400, { error: body.error });
    const input = String(body.input || "").trim();
    const spec = detectInput(input);
    if (!spec.ok) return deps.json(400, { error: spec.error || "bad_input", message: spec.message || "" });
    if (doc.requests.filter((row) => row.by === id).length >= REQUESTS_PER_USER) return deps.json(400, { error: "too_many" });
    if (doc.requests.length >= REQUEST_CAP) return deps.json(400, { error: "full" });
    const same = doc.requests.find((row) => row.by === id && row.input.toLowerCase() === input.toLowerCase());
    if (!same) {
      doc.requests.push({ id: newId("r"), by: id, input: input.slice(0, 300), platform: spec.platform, note: cleanName(body.note), at: Date.now() });
      await writeDoc(env, doc);
    }
    return deps.json(200, { ok: true });
  }

  return deps.json(404, { error: "not_found" });
}

/* Hourly: members who went quiet stop costing fetches. */
async function refreshWanted(env, now) {
  if (!env || !env.DATA || !env.DB) return false;
  const doc = await readJson(env, DOC_KEY);
  if (!doc || !Array.isArray(doc.lists) || !doc.lists.length) return false;
  return writeWanted(env, await readDoc(env), now || Date.now());
}

/* An allowed source request lands in a list: an existing one, or a new one
   named after the source. memberIds are assigned to it. */
async function allowIntoList(env, deps, opts) {
  if (!env.DATA) return { error: "not_configured", status: 503 };
  const doc = await readDoc(env);
  let list = doc.lists.find((item) => item.id === opts.listId);
  if (!list) {
    const name = cleanName(opts.newList);
    if (!name || doc.lists.length >= LIST_CAP) return { error: "bad_list", status: 400 };
    list = { id: newId("s"), name, sources: [], members: [], at: Date.now() };
    doc.lists.push(list);
  }
  const added = await addSource(env, doc, list, opts.input, { unverified: !!opts.unverified });
  if (added.error) return added;
  (opts.memberIds || []).forEach((id) => {
    const text = String(id || "");
    if (/^\d{12}$/.test(text) && list.members.indexOf(text) < 0 && list.members.length < MEMBERS_PER_LIST) list.members.push(text);
  });
  await afterChange(env, doc, deps || {});
  return { listId: list.id, sourceId: added.id };
}

async function listsSummary(env) {
  if (!env.DATA) return [];
  const doc = await readDoc(env);
  return doc.lists.map((row) => ({ id: row.id, name: row.name, members: row.members.length, sources: row.sources.length }));
}

/* A banned source leaves every list, so the list sync stops fetching it. */
async function dropSourceKeys(env, keys, deps) {
  if (!env.DATA) return 0;
  const want = new Set(keyVariants(keys));
  const doc = await readDoc(env);
  const gone = Object.keys(doc.sources).filter((id) => {
    const row = doc.sources[id] || {};
    const alias = (String(row.platform || "") + ":" + String(row.handle || "")).toLowerCase();
    return want.has(id.toLowerCase()) || want.has(alias);
  });
  if (!gone.length) return 0;
  doc.lists.forEach((row) => { row.sources = row.sources.filter((id) => gone.indexOf(id) < 0); });
  await afterChange(env, doc, deps || {});
  return gone.length;
}

export { allowIntoList, listsSummary, dropSourceKeys };
export { handleOwnerSourceLists, handleMySourceLists, refreshWanted, DOC_KEY, WANTED_KEY, INDEX_KEY, SHARD_PREFIX };
