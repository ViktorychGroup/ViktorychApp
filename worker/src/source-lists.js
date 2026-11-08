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
import { isExactPublication, notifyIds, putJsonIfMatch, readBounded, sameIds } from "./list-commit.js";

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
  const entry = await readEntry(env, key);
  return entry.value;
}

async function readEntry(env, key) {
  if (!env.DATA) return { value: null, etag: "" };
  try {
    const object = await env.DATA.get(key);
    if (!object) return { value: null, etag: "" };
    const parsed = JSON.parse(await object.text());
    return { value: parsed && typeof parsed === "object" ? parsed : null, etag: String(object.etag || "") };
  } catch (err) {
    return { value: null, etag: "" };
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

async function putIndex(env, index, etag) {
  return putJsonIfMatch(env.DATA, INDEX_KEY, index, etag);
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
  const live = await readDoc(env);
  const lists = [];
  const sources = new Map();
  live.lists.forEach((row) => {
    if (!row.sources.length || !row.members.some((id) => active.has(id))) return;
    lists.push({ id: row.id, sources: row.sources.slice() });
    row.sources.forEach((id) => { if (live.sources[id] && !sources.has(id)) sources.set(id, sourceSpec(live.sources[id])); });
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
      cachedPosts: (probed.posts || []).slice(0, 8),
      addedAt: Date.now()
    };
  } else if (probed.posts && probed.posts.length && !(doc.sources[id].cachedPosts || []).length) {
    doc.sources[id].cachedPosts = probed.posts.slice(0, 8);
  }
  if (list.sources.indexOf(id) < 0) list.sources.push(id);
  list.changedAt = Date.now();
  return { id };
}

/* This budget only decides whether another network fetch may start, and it
   aborts that fetch. Hashing and the index write are outside it. */
const PUBLISH_BUDGET_MS = 4000;
const POSTS_PER_SOURCE = 8;

/* Keep the post the source returned. Missing identity fields are filled in.
   Text, media, quotes and every other field stay as they are. */
function feedPost(source, post) {
  if (!post || typeof post !== "object") return null;
  const id = String(post.id || post.statusId || "");
  if (!id) return null;
  const copy = Object.assign({}, post);
  copy.id = id;
  if (!copy.statusId) copy.statusId = id;
  if (!copy.feedId) copy.feedId = source.id;
  if (!copy.platform) copy.platform = source.platform || "";
  if (!copy.handle) copy.handle = source.handle || "";
  if (!copy.author) copy.author = source.name || source.handle || "";
  if (!copy.kind) copy.kind = post.kind || "post";
  copy.sourceList = true;
  return copy;
}

function boundedFetch(deadline) {
  return (url, init) => {
    const left = deadline - Date.now();
    if (left <= 50) {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    return fetch(url, Object.assign({}, init || {}, { signal: AbortSignal.timeout(left) }));
  };
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(digest));
}

/* A published row is readable only when it names this list's current
   members and sources. A scheduled-sync row with neither is not readable. */
function publicationMatches(row, list) {
  if (!row || !list || row.membersKey == null || !Array.isArray(row.sources)) return false;
  return String(row.membersKey) === (list.members || []).map(String).join("\n") && sameIds(row.sources, list.sources || []);
}

/* A list the sync already published is kept once its sources are known.
   A list whose sources changed, or whose copy does not say which sources
   it holds, is built again from the current list. */
function shardStale(index, list, force) {
  const row = (index.lists || {})[list.id] || {};
  if (!list.sources.length) return hashOk(row.hash) || !row.empty;
  if (!publicationMatches(row, list)) return true;
  if (!hashOk(row.hash)) {
    if (!force && row.error && !row.partial && Date.now() - Number(row.at || 0) < 10000) return false;
    return true;
  }
  if (force && (row.partial || row.error)) return true;
  return Number(list.changedAt) > Number(row.at || 0);
}

function unwrap(value) {
  return String(value || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function innerTag(xml, name) {
  const re = new RegExp("<" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b[^>]*>([\\s\\S]*?)</" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ">", "i");
  const found = String(xml || "").match(re);
  return found ? unwrap(found[1]) : "";
}

function decodeEntities(value) {
  return unwrap(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'");
}

function plainText(value) {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, 100000);
}

function mediaFrom(xml, html) {
  const out = [];
  const seen = new Set();
  const add = (url, type) => {
    const raw = String(url || "").trim();
    if (!/^https:\/\//i.test(raw) || seen.has(raw) || raw.length > 2000) return;
    seen.add(raw);
    const kind = type && type.indexOf("video") >= 0 ? "video" : "photo";
    out.push({ type: kind, url: raw });
  };
  const tags = String(xml || "").match(/<(?:enclosure|media:content|content)\b[^>]*>/gi) || [];
  tags.forEach((tag) => {
    const url = (tag.match(/\burl=["']([^"']+)["']/i) || [])[1] || "";
    const type = (tag.match(/\b(?:type|medium)=["']([^"']+)["']/i) || [])[1] || "";
    add(url, type);
  });
  const images = String(html || "").match(/<img\b[^>]*>/gi) || [];
  images.forEach((tag) => add((tag.match(/\bsrc=["']([^"']+)["']/i) || [])[1] || "", "image"));
  return out;
}

/* A new feed is read from the public document itself. The owner-catalog
   preview parser keeps only a short line and no media; this one does not. */
function parseFeedDocument(xml, source) {
  const text = String(xml || "");
  if (!/<(?:rss|feed|rdf)\b/i.test(text)) return null;
  const chunks = text.split(/<(?:item|entry)\b/i).slice(1);
  const posts = [];
  chunks.forEach((chunk) => {
    if (posts.length >= POSTS_PER_SOURCE) return;
    const body = chunk.split(/<\/(?:item|entry)>/i)[0];
    const encoded = innerTag(body, "content:encoded") || innerTag(body, "encoded");
    const atom = innerTag(body, "content");
    const description = innerTag(body, "description") || innerTag(body, "summary");
    const html = decodeEntities(encoded || atom || description || "");
    const title = plainText(innerTag(body, "title"));
    let readable = plainText(html);
    if (title && readable.indexOf(title) < 0) readable = title + (readable ? "\n\n" + readable : "");
    const quoteHtml = (html.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i) || [])[1] || "";
    const quoteText = plainText(quoteHtml);
    const link = innerTag(body, "link") || ((body.match(/<link\b[^>]*href=["']([^"']+)["']/i) || [])[1] || "");
    const guid = plainText(innerTag(body, "guid") || innerTag(body, "id")) || String(link || "").trim();
    const date = plainText(innerTag(body, "pubDate") || innerTag(body, "published") || innerTag(body, "updated"));
    const media = mediaFrom(body, html);
    if (!guid || (!readable && !media.length)) return;
    const post = { id: guid.slice(0, 400), text: readable, date, url: String(link || "").trim(), media };
    if (quoteText) {
      post.kind = "quote";
      post.quoted = { id: guid.slice(0, 360) + "#q", platform: source.platform || "rss", kind: "post", text: quoteText };
    }
    posts.push(post);
  });
  return posts.length ? posts : null;
}

async function fetchSourcePosts(row, deadline) {
  const url = String(row.url || "");
  if (!/^https:\/\//i.test(url)) return null;
  let res = null;
  try {
    res = await boundedFetch(deadline)(url, { redirect: "follow", headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
  } catch (err) {
    return null;
  }
  if (!res || !res.ok) return null;
  let text = "";
  try { text = await readBounded(res, 500000); } catch (err) { return null; }
  return parseFeedDocument(text, row);
}

async function postsForSource(row, index, deadline) {
  const saved = index.sourcePosts && index.sourcePosts[row.id];
  if (saved && saved.full && Array.isArray(saved.posts) && saved.posts.length) return { ok: true, posts: saved.posts.slice(0, POSTS_PER_SOURCE), cached: true };
  if (Date.now() >= deadline) return { ok: false, posts: [], cached: false };
  const fresh = await fetchSourcePosts(row, deadline);
  if (fresh && fresh.length) return { ok: true, posts: fresh.slice(0, POSTS_PER_SOURCE), cached: false, full: true };
  if (Date.now() >= deadline) return { ok: false, posts: [], cached: false, full: false };
  const spec = {
    ok: true,
    platform: row.platform,
    handle: row.handle,
    url: row.url || "",
    host: row.host || "",
    channelId: row.channelId || "",
    redditKind: row.redditKind || ""
  };
  const probed = await probeWithin(spec, Math.max(1, deadline - Date.now()), boundedFetch(deadline));
  if (!probed || probed.error || probed.late) return { ok: false, posts: [], cached: false, full: false };
  // The preview probe drops media and shortens text. It can be shown now,
  // but it must not be stored as a complete copy.
  return { ok: true, posts: (probed.posts || []).slice(0, POSTS_PER_SOURCE), cached: false, full: false };
}

/* Build shard bytes first. The owner document is read again before anything
   is published, so a removal that landed during the fetch is not written back. */
async function publishReady(env, hintDoc, onlyIds, force) {
  if (!env.DATA) return false;
  const deadline = Date.now() + PUBLISH_BUDGET_MS;
  const doc = hintDoc || await readDoc(env);
  const wanted = new Set(onlyIds || []);
  const due = doc.lists.filter((row) => row.members.length && (!wanted.size || wanted.has(row.id)));
  if (!due.length) return false;
  const seen = await readJson(env, INDEX_KEY) || {};
  const pending = [];
  for (const list of due) {
    if (Date.now() >= deadline && pending.length) break;
    if (!shardStale(seen, list, force)) continue;
    const expectMembers = list.members.slice();
    const expectSources = list.sources.slice();
    const now = Date.now();
    if (!list.sources.length) {
      pending.push({ id: list.id, expectMembers, expectSources, entry: { hash: "", count: 0, at: now, empty: true, sources: [] }, health: {}, posts: {} });
      continue;
    }
    const feeds = [];
    const posts = [];
    const health = {};
    const kept = {};
    let failed = false;
    for (const id of list.sources) {
      const source = doc.sources[id];
      if (!source) continue;
      const got = await postsForSource(source, seen, deadline);
      if (!got.ok) failed = true;
      const feed = {
        id: source.id,
        platform: source.platform,
        handle: source.handle,
        name: source.name || source.handle,
        avatar: source.avatar || "",
        url: source.url || "",
        configured: true,
        sourceList: true
      };
      feeds.push(feed);
      got.posts.forEach((post) => {
        const row = feedPost(source, post);
        if (row) posts.push(row);
      });
      health[id] = { ok: got.ok === true, count: got.posts.length, at: now };
      if (got.posts.length) kept[id] = { profile: feed, posts: got.posts, full: got.full === true };
      if (Date.now() >= deadline) break;
    }
    if (failed && !posts.length) {
      pending.push({ id: list.id, expectMembers, expectSources, entry: { hash: "", count: 0, at: now, error: "down", sources: expectSources, membersKey: expectMembers.join("\n") }, health, posts: kept });
      continue;
    }
    const body = stableJson({ v: 1, feeds, posts }) + "\n";
    const hash = await sha256Hex(body);
    await env.DATA.put(SHARD_PREFIX + hash + ".json", body, JSON_TYPE);
    pending.push({
      id: list.id,
      expectMembers,
      expectSources,
      entry: { hash, size: new TextEncoder().encode(body).byteLength, count: posts.length, at: now, sources: expectSources, membersKey: expectMembers.join("\n"), partial: failed },
      health,
      posts: kept
    });
  }
  if (!pending.length) return false;
  return commitUpdates(env, pending);
}

function listStill(doc, update) {
  const list = (doc.lists || []).find((row) => row && row.id === update.id);
  if (!list) return false;
  return sameIds(list.members, update.expectMembers) && sameIds(list.sources, update.expectSources);
}

/* Overlay only this publish's lists onto the index that exists now.
   If the membership changed after that read, the new entry is removed
   again. Another list's entry is left in place. */
async function commitUpdates(env, updates) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await readDoc(env);
    const allowed = updates.filter((update) => listStill(before, update));
    if (!allowed.length) return false;
    const current = await readEntry(env, INDEX_KEY);
    const index = Object.assign({ v: 1, lists: {}, sources: {}, sourcePosts: {} }, current.value || {});
    index.lists = index.lists || {};
    index.sources = index.sources || {};
    index.sourcePosts = index.sourcePosts || {};
    allowed.forEach((update) => {
      index.lists[update.id] = update.entry;
      Object.keys(update.health || {}).forEach((id) => { index.sources[id] = update.health[id]; });
      Object.keys(update.posts || {}).forEach((id) => { index.sourcePosts[id] = update.posts[id]; });
    });
    index.v = 1;
    index.at = Date.now();
    const wrote = await putIndex(env, index, current.etag);
    if (!wrote) continue;
    const after = await readDoc(env);
    const dropped = allowed.filter((update) => !listStill(after, update));
    if (!dropped.length) return true;
    await restoreLists(env, dropped);
    return false;
  }
  return false;
}

async function shardFeedIds(env, row) {
  if (!row || !hashOk(row.hash) || !env.DATA) return null;
  const object = await env.DATA.get(SHARD_PREFIX + row.hash + ".json");
  if (!object) return null;
  try {
    const parsed = JSON.parse(await object.text());
    if (!parsed || !Array.isArray(parsed.feeds)) return null;
    return parsed.feeds.map((feed) => String((feed && feed.id) || ""));
  } catch (err) {
    return null;
  }
}

function samePublication(left, right) {
  if (!left || !right) return false;
  return left.hash === right.hash
    && String(left.membersKey || "") === String(right.membersKey || "")
    && sameIds(left.sources, right.sources);
}

function listById(doc, id) {
  return ((doc && doc.lists) || []).find((item) => item && item.id === id) || null;
}

/* Drop a row whose sources are not the live list. The owner document is
   read again on every attempt and after every shard read, so a newer
   publication is not deleted against sources that have already changed. */
async function sweepIndex(env) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = await readDoc(env);
    const current = await readEntry(env, INDEX_KEY);
    const index = Object.assign({ v: 1, lists: {}, sources: {}, sourcePosts: {} }, current.value || {});
    index.lists = index.lists || {};
    let changed = false;
    let superseded = false;
    for (const id of Object.keys(index.lists)) {
      const row = index.lists[id];
      if (!row) continue;
      let list = listById(doc, id);
      if (list && publicationMatches(row, list)) continue;
      if (list && Array.isArray(row.sources) && sameIds(row.sources, list.sources || [])) {
        index.lists[id] = Object.assign({}, row, { membersKey: (list.members || []).map(String).join("\n") });
        changed = true;
        continue;
      }
      let feeds = null;
      if (list && !Array.isArray(row.sources)) {
        feeds = await shardFeedIds(env, row);
        const freshDoc = await readDoc(env);
        const freshEntry = await readEntry(env, INDEX_KEY);
        const freshRow = freshEntry.value && freshEntry.value.lists && freshEntry.value.lists[id];
        if (freshEntry.etag !== current.etag || !samePublication(row, freshRow)) {
          superseded = true;
          break;
        }
        list = listById(freshDoc, id);
      }
      if (list && feeds && sameIds(feeds, list.sources || [])) {
        index.lists[id] = Object.assign({}, row, {
          sources: list.sources.slice(),
          membersKey: (list.members || []).map(String).join("\n")
        });
        changed = true;
        continue;
      }
      if (list && publicationMatches(row, list)) continue;
      const update = {
        expectMembers: String(row.membersKey || "").split("\n").filter((part) => part),
        expectSources: Array.isArray(row.sources) ? row.sources : [],
        entry: row
      };
      if (!isExactPublication(row, update)) continue;
      delete index.lists[id];
      changed = true;
    }
    if (superseded) continue;
    if (!changed) return;
    index.v = 1;
    index.at = Date.now();
    if (await putIndex(env, index, current.etag)) return;
  }
}

async function restoreLists(env, dropped) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = await readDoc(env);
    const current = await readEntry(env, INDEX_KEY);
    const index = Object.assign({ v: 1, lists: {}, sources: {}, sourcePosts: {} }, current.value || {});
    index.lists = index.lists || {};
    let changed = false;
    dropped.forEach((update) => {
      if (listStill(doc, update)) return;
      const row = index.lists[update.id];
      // Only the publication this cleanup wrote may be removed. A newer
      // hash, even with the same members, stays.
      if (!isExactPublication(row, update)) return;
      delete index.lists[update.id];
      changed = true;
    });
    if (!changed) return;
    index.v = 1;
    index.at = Date.now();
    if (await putIndex(env, index, current.etag)) return;
  }
}

async function notifyMembers(env, ids, publish) {
  const told = notifyIds(ids);
  if (env && env.DATA) {
    try { await env.DATA.put("owner/lists/last-notify.json", JSON.stringify({ ids: told }), JSON_TYPE); } catch (err) { /* the signal is still sent */ }
  }
  if (!publish) return told;
  for (const id of told) {
    try { await publish(env, id, "sync", { lists: true }, id); } catch (err) { /* the next open still reads the shard */ }
  }
  return told;
}

async function afterChange(env, doc, deps, notifyList) {
  // Membership is committed before the fetch, so a later removal is the
  // newer document and is not replaced by this copy.
  await writeDoc(env, doc);
  try { await publishReady(env, null); } catch (err) { /* the member read tries once more */ }
  try { await sweepIndex(env); } catch (err) { /* a stale index entry is ignored on read */ }
  const live = await readDoc(env);
  const changed = await writeWanted(env, live, Date.now());
  if (changed && deps.dispatchWorkflows) {
    try { await deps.dispatchWorkflows(env, ["sync.yml"]); } catch (err) { /* the next scheduled sync fetches it */ }
  }
  await notifyMembers(env, notifyList, deps && deps.publish);
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
      await afterChange(env, doc, deps, list.members);
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
    const told = list.members.slice();
    doc.lists = doc.lists.filter((item) => item.id !== list.id);
    await afterChange(env, doc, deps, told);
    return deps.json(200, await ownerBody(env, doc));
  }
  if (part === "sources" && !target && method === "POST") {
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const added = await addSource(env, doc, list, body.input);
    if (added.error) return deps.json(added.status, { error: added.error, message: ERROR_TEXT[added.error] || "" });
    await afterChange(env, doc, deps, list.members);
    return deps.json(200, Object.assign({ added: added.id }, await ownerBody(env, doc)));
  }
  if (part === "sources" && target && method === "DELETE") {
    list.sources = list.sources.filter((id) => id !== target);
    list.changedAt = Date.now();
    await afterChange(env, doc, deps, list.members);
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
    await afterChange(env, doc, deps, [String(row.public_id)]);
    return deps.json(200, await ownerBody(env, doc));
  }
  if (part === "members" && target && method === "DELETE") {
    list.members = list.members.filter((id) => id !== target);
    await afterChange(env, doc, deps, [target]);
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
    const retry = new URL(request.url).searchParams.get("retry") === "1";
    // Identify a scheduled-sync copy before publishing, so a shard whose
    // feeds are still this list's sources is stamped instead of replaced.
    try { await sweepIndex(env); } catch (err) { /* an unproven hash is still hidden below */ }
    if (mine.some((row) => row.sources.length)) {
      try { await publishReady(env, null, mine.map((row) => row.id), retry); } catch (err) { /* answer with whatever is already published */ }
    }
    try { await sweepIndex(env); } catch (err) { /* the read still hides a stale entry */ }
    const prepared = await readDoc(env);
    const preparedMine = prepared.lists.filter((row) => row.members.indexOf(id) >= 0);
    if (preparedMine.length) {
      // A member who came back after a quiet month switches the fetch back on.
      const wanted = (await readJson(env, WANTED_KEY)) || {};
      const liveWanted = new Set(((wanted.lists) || []).map((row) => row.id));
      if (preparedMine.some((row) => row.sources.length && !liveWanted.has(row.id))) await writeWanted(env, prepared, Date.now());
    }
    const index = (await readJson(env, INDEX_KEY)) || {};
    const freshShards = index.lists || {};
    const answered = await readDoc(env);
    const mineNow = answered.lists.filter((row) => row.members.indexOf(id) >= 0);
    return deps.json(200, {
      lists: mineNow.map((row) => {
        const shard = freshShards[row.id] || {};
        const hash = publicationMatches(shard, row) && hashOk(shard.hash) ? shard.hash : "";
        const count = Number(shard.count) || 0;
        let status = "loading";
        if (!row.sources.length || shard.empty) status = "empty";
        else if (shard.partial || shard.error) status = "error";
        else if (hash && count) status = "ready";
        else if (hash) status = "empty";
        return { id: row.id, name: row.name, hash, size: Number(shard.size) || 0, at: Number(shard.at) || 0, count, status };
      })
    }, { "cache-control": "private, no-store" });
  }

  const shardPath = path.match(/^\/v1\/me\/source-lists\/shard\/([a-f0-9]{64})$/);
  if (shardPath && method === "GET") {
    const hit = await deps.rateHit(env, "my-lists-shard:" + id, 240, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    try { await sweepIndex(env); } catch (err) { /* an unproven hash is still refused below */ }
    const index = (await readJson(env, INDEX_KEY)) || {};
    const object = await env.DATA.get(SHARD_PREFIX + shardPath[1] + ".json");
    const answered = await readDoc(env);
    const shards = index.lists || {};
    const allowed = object && answered.lists.some((row) => {
      if (!row || row.members.indexOf(id) < 0) return false;
      const shard = shards[row.id];
      if (!shard || shard.hash !== shardPath[1]) return false;
      return publicationMatches(shard, row);
    });
    if (!allowed) return deps.json(404, { error: "not_found" });
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
  await afterChange(env, doc, deps || {}, list.members);
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
  const told = [];
  doc.lists.forEach((row) => {
    const next = row.sources.filter((id) => gone.indexOf(id) < 0);
    if (next.length !== row.sources.length) told.push(...row.members);
    row.sources = next;
  });
  await afterChange(env, doc, deps || {}, told);
  return gone.length;
}

export { allowIntoList, listsSummary, dropSourceKeys };
export { handleOwnerSourceLists, handleMySourceLists, refreshWanted, commitUpdates, sweepIndex, DOC_KEY, WANTED_KEY, INDEX_KEY, SHARD_PREFIX };
