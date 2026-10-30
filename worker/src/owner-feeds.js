import { eachLimit } from "./limit.js";
import { bannedSpec } from "./feed-requests.js";
import { isRunner } from "./job-runner.js";
/* Owner-only feed catalog. Anonymous callers get 404. Other accounts get 403.
   The catalog stays in private R2. A sync dispatch does not include the handle. */

import {
  ERROR_TEXT,
  accountId,
  backoffMs,
  cleanGroupName,
  cleanLabel,
  detectInput,
  publicHostname,
  sourcePlan
} from "../../shared/feed-sources.js";

const CATALOG_KEY = "owner/feeds-catalog.json";
const X_KEY = "owner/added-accounts.json";
const TIKTOK_KEY = "owner/tiktok-accounts.json";
const ACCOUNT_CAP = 80;
const GROUP_CAP = 40;
const UA = "ViktorychApp/1.0";

function emptyCatalog() {
  return { accounts: [], groups: [], places: [], removed: [] };
}

function clip(value, max) {
  const text = String(value || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(text).slice(0, max).join("");
}

function httpsOnly(value) {
  let text = String(value || "").trim();
  if (text.indexOf("http://") === 0) text = "https://" + text.slice(7);
  if (!/^https:\/\//i.test(text) || text.length > 400 || /[\s<>]/.test(text)) return "";
  try {
    const url = new URL(text);
    if (!publicHostname(url.hostname)) return "";
  } catch (err) {
    return "";
  }
  return text;
}

function stripTags(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function og(html, prop) {
  const text = String(html || "");
  const named = new RegExp("property=[\"']" + prop + "[\"'][^>]*content=[\"']([^\"']+)[\"']", "i");
  const first = text.match(named);
  if (first) return first[1];
  const swapped = new RegExp("content=[\"']([^\"']+)[\"'][^>]*property=[\"']" + prop + "[\"']", "i");
  const second = text.match(swapped);
  return second ? second[1] : "";
}

function retryAfterSeconds(res) {
  const raw = res && res.headers ? res.headers.get("retry-after") : "";
  const num = Number(raw);
  if (Number.isFinite(num) && num >= 0 && num < 86400) return num;
  return 0;
}

function blockedApi(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "api.x.com" || host === "api.twitter.com";
}

async function pull(url, fetchImpl) {
  let current = String(url || "");
  for (let hop = 0; hop < 4; hop++) {
    let parsed;
    try { parsed = new URL(current); }
    catch (err) { return { status: 0, text: "", retryAfter: 0, ms: 0 }; }
    if (parsed.username || parsed.protocol !== "https:" || !publicHostname(parsed.hostname) || blockedApi(parsed.hostname)) {
      return { status: 0, text: "", retryAfter: 0, ms: 0, code: "private_host" };
    }
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        headers: {
          "user-agent": UA,
          accept: "application/json, application/atom+xml, application/rss+xml, text/html;q=0.9, */*;q=0.8",
          "accept-language": "en"
        },
        signal: AbortSignal.timeout(8000)
      });
    } catch (err) {
      return { status: 0, text: "", retryAfter: 0, ms: Date.now() - started };
    }
    const ms = Date.now() - started;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") || "";
      if (!loc) return { status: res.status, text: "", retryAfter: 0, ms };
      try { current = new URL(loc, current).toString(); }
      catch (err) { return { status: 0, text: "", retryAfter: 0, ms }; }
      continue;
    }
    let text = "";
    try { text = await res.text(); }
    catch (err) { text = ""; }
    if (text.length > 400000) text = text.slice(0, 400000);
    return { status: res.status, text, retryAfter: retryAfterSeconds(res), ms };
  }
  return { status: 0, text: "", retryAfter: 0, ms: 0 };
}

function mergeProfile(have, next) {
  const row = Object.assign({}, have || {});
  if (!next) return row;
  ["name", "avatar", "handle", "url", "permanentId", "channelId"].forEach((key) => {
    if (next[key]) row[key] = next[key];
  });
  return row;
}

function metaCode(platform, guid, link) {
  const blob = String(link || "") + " " + String(guid || "");
  let match = null;
  if (platform === "instagram") match = blob.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  if (platform === "threads") match = blob.match(/threads\.(?:com|net)\/(?:@[^/\s]+\/)?(?:post|t)\/([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  return "";
}

function parseRss(xml, spec) {
  const text = String(xml || "");
  if (!/<(rss|feed|rdf)\b/i.test(text)) return null;
  if (/bridge returned error|looks like something went wrong/i.test(text) && !/<(item|entry)\b/i.test(text)) return null;
  const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const image = (text.match(/<(?:url|logo|icon)>(https?:\/\/[^<]+)<\/(?:url|logo|icon)>/i) || [])[1] || "";
  const posts = [];
  text.split(/<(?:item|entry)\b/i).slice(1).forEach((chunk) => {
    if (posts.length >= 3) return;
    const itemTitle = (chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
    const link = (chunk.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] || (chunk.match(/<link[^>]*>(https?:\/\/[^<]+)<\/link>/i) || [])[1] || "";
    const desc = (chunk.match(/<(?:description|summary|content(?::encoded)?)[^>]*>([\s\S]*?)<\/(?:description|summary|content(?::encoded)?)/i) || [])[1] || "";
    const date = (chunk.match(/<(?:pubDate|published|updated)[^>]*>([^<]+)</i) || [])[1] || "";
    const id = (chunk.match(/<(?:guid|id)[^>]*>([^<]+)</i) || [])[1] || link || itemTitle;
    const body = clip(stripTags(desc || itemTitle), 180);
    const page = httpsOnly(link);
    const ident = metaCode(spec.platform, stripTags(id), page) || clip(stripTags(id), 120) || page;
    if (!body && !page) return;
    posts.push({ id: clip(ident, 120) || String(posts.length + 1), text: body, date: clip(date, 40), url: page });
  });
  return {
    profile: {
      name: clip(stripTags(title), 80) || spec.handle,
      avatar: httpsOnly(image),
      handle: spec.handle,
      url: spec.url
    },
    posts
  };
}

function parseFxUser(text, spec) {
  let data = null;
  try { data = JSON.parse(text); }
  catch (err) { return null; }
  const user = data && data.user;
  if (!user || typeof user !== "object" || user.protected === true) return null;
  const handle = /^[A-Za-z0-9_]{1,15}$/.test(String(user.screen_name || "")) ? String(user.screen_name) : spec.handle;
  const id = String(user.id || "");
  return {
    profile: {
      name: clip(user.name, 80) || handle,
      avatar: httpsOnly(String(user.avatar_url || "").replace("_normal.", "_400x400.").replace("_bigger.", "_400x400.")),
      handle,
      url: "https://x.com/" + handle,
      permanentId: /^\d{2,25}$/.test(id) ? id : ""
    },
    posts: []
  };
}

function parseFxPosts(text) {
  let data = null;
  try { data = JSON.parse(text); }
  catch (err) { return null; }
  const list = Array.isArray(data) ? data : (data && (data.statuses || data.results || data.tweets || data.timeline)) || [];
  if (!Array.isArray(list)) return null;
  const posts = [];
  list.forEach((row) => {
    if (!row || posts.length >= 3) return;
    const id = clip(row.id, 40);
    const body = clip(row.text || row.full_text, 180);
    if (!id && !body) return;
    posts.push({ id: id || String(posts.length + 1), text: body, date: clip(row.created_at, 40), url: httpsOnly(row.url) });
  });
  return { profile: null, posts };
}

function parseYoutubePage(html, spec) {
  const channel = (String(html || "").match(/youtube\.com\/channel\/(UC[\w-]{22})/) || [])[1];
  if (!channel) return null;
  return {
    profile: {
      name: clip(stripTags(og(html, "og:title")) || spec.handle, 80),
      avatar: httpsOnly(og(html, "og:image")),
      handle: spec.handle,
      channelId: channel,
      url: "https://www.youtube.com/channel/" + channel
    },
    posts: [],
    channelId: channel
  };
}

function parseTelegram(html, spec) {
  const text = String(html || "");
  if (text.toLowerCase().indexOf(String(spec.handle || "").toLowerCase()) < 0) return null;
  const name = clip(stripTags(og(text, "og:title")) || spec.handle, 80);
  const posts = [];
  text.split("tgme_widget_message_wrap").slice(1).forEach((part) => {
    if (posts.length >= 3) return;
    const id = (part.match(/data-post="[^"/]+\/(\d+)"/) || [])[1] || "";
    const body = (part.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
    const when = (part.match(/<time[^>]*datetime="([^"]+)"/i) || [])[1] || "";
    const line = clip(stripTags(body), 180);
    if (!line && !id) return;
    posts.push({
      id: id || String(posts.length + 1),
      text: line || "Post",
      date: clip(when, 40),
      url: "https://t.me/" + spec.handle + (id ? "/" + id : "")
    });
  });
  if (!posts.length && /if you have telegram, you can view/i.test(text) && text.indexOf("tgme_channel_info") < 0) return null;
  return { profile: { name, avatar: httpsOnly(og(text, "og:image")), handle: spec.handle, url: "https://t.me/" + spec.handle }, posts };
}

function parseTikTok(html, spec) {
  const text = String(html || "");
  if (/captcha-verify|captcha/i.test(text)) return null;
  const unique = (text.match(/"uniqueId"\s*:\s*"([A-Za-z0-9._]{2,24})"/) || [])[1] || "";
  if (unique && unique.toLowerCase() !== String(spec.handle || "").toLowerCase()) return null;
  let name = "";
  const nick = text.match(/"nickname"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (nick) {
    try { name = JSON.parse("\"" + nick[1] + "\""); }
    catch (err) { name = nick[1]; }
  }
  if (!name) name = stripTags(og(text, "og:title")).replace(/\s*\(@[^)]*\)\s*$/, "").replace(/\s*\|\s*TikTok\s*$/i, "");
  const avatar = httpsOnly(og(text, "og:image"));
  if (!name && !avatar) return null;
  const handle = unique || spec.handle;
  return { profile: { name: clip(name, 80) || handle, avatar, handle, url: "https://www.tiktok.com/@" + handle }, posts: [] };
}

function parseVk(html, spec) {
  const text = String(html || "");
  if (text.toLowerCase().indexOf(String(spec.handle || "").toLowerCase()) < 0) return null;
  const name = clip(stripTags(og(text, "og:title")) || spec.handle, 80);
  if (!name) return null;
  return { profile: { name, avatar: httpsOnly(og(text, "og:image")), handle: spec.handle, url: "https://vk.com/" + spec.handle }, posts: [] };
}

function parseBskyProfile(text, spec) {
  let data = null;
  try { data = JSON.parse(text); }
  catch (err) { return null; }
  if (!data || !data.handle) return null;
  return {
    profile: {
      name: clip(data.displayName || data.handle, 80),
      avatar: httpsOnly(data.avatar),
      handle: String(data.handle),
      url: "https://bsky.app/profile/" + data.handle
    },
    posts: []
  };
}

function parseBskyFeed(text) {
  let data = null;
  try { data = JSON.parse(text); }
  catch (err) { return null; }
  const feed = data && data.feed;
  if (!Array.isArray(feed)) return null;
  const posts = [];
  feed.forEach((row) => {
    if (posts.length >= 3) return;
    const post = row && row.post;
    const record = post && post.record;
    if (!post || !record) return;
    const uri = String(post.uri || "");
    const actor = post.author && post.author.handle ? String(post.author.handle) : "";
    const rkey = uri.split("/").pop();
    posts.push({
      id: clip(uri, 120) || String(posts.length + 1),
      text: clip(record.text, 180),
      date: clip(record.createdAt, 40),
      url: actor && rkey ? "https://bsky.app/profile/" + actor + "/post/" + rkey : ""
    });
  });
  return { profile: null, posts };
}

function parseMastodon(text, spec) {
  let data = null;
  try { data = JSON.parse(text); }
  catch (err) { return null; }
  if (!data || !data.username) return null;
  return {
    profile: {
      name: clip(data.display_name || data.username, 80),
      avatar: httpsOnly(data.avatar),
      handle: String(data.username),
      url: httpsOnly(data.url) || spec.url
    },
    posts: []
  };
}

function parseStep(step, text, spec) {
  if (step.kind === "fxtwitter-user") return parseFxUser(text, spec);
  if (step.kind === "fxtwitter-posts") return parseFxPosts(text);
  if (step.kind === "youtube-page") return parseYoutubePage(text, spec);
  if (step.kind === "youtube-rss" || step.kind === "rss") return parseRss(text, spec);
  if (step.kind === "telegram-html") return parseTelegram(text, spec);
  if (step.kind === "tiktok-html") return parseTikTok(text, spec);
  if (step.kind === "vk-html") return parseVk(text, spec);
  if (step.kind === "bsky-profile") return parseBskyProfile(text, spec);
  if (step.kind === "bsky-feed") return parseBskyFeed(text);
  if (step.kind === "mastodon-lookup") return parseMastodon(text, spec);
  return null;
}

async function probeAccount(spec, fetchImpl) {
  const local = Object.assign({}, spec);
  const steps = sourcePlan(local);
  let profile = null;
  let posts = [];
  let slow = false;
  let saw429 = false;
  let retryAfter = 0;
  let saw404 = false;
  let code = "down";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (profile && posts.length >= 3) continue;
    const pulled = await pull(step.url, fetchImpl || fetch);
    if (pulled.code === "private_host") return { error: "private_host" };
    if (pulled.ms > 4000) slow = true;
    if (pulled.status === 429) {
      saw429 = true;
      retryAfter = Math.max(retryAfter, pulled.retryAfter || 0);
      code = "rate";
      continue;
    }
    if (pulled.status === 404) {
      saw404 = true;
      code = "not_found";
      continue;
    }
    if (pulled.status < 200 || pulled.status >= 300) {
      code = "down";
      continue;
    }
    const parsed = parseStep(step, pulled.text, local);
    if (!parsed) {
      if (local.platform === "rss") code = "bad_feed";
      continue;
    }
    if (parsed.profile) profile = mergeProfile(profile, parsed.profile);
    if (parsed.channelId && !local.channelId) {
      local.channelId = parsed.channelId;
      steps.push({ kind: "youtube-rss", url: "https://www.youtube.com/feeds/videos.xml?channel_id=" + encodeURIComponent(parsed.channelId) });
    }
    if (parsed.posts && parsed.posts.length) posts = parsed.posts.slice(0, 3);
  }
  if (!profile) {
    if (saw429 && !saw404) return { error: "rate", retryAfter };
    if (local.platform === "rss" && code === "bad_feed") return { error: "bad_feed" };
    return { error: saw404 ? "not_found" : (saw429 ? "rate" : code), retryAfter };
  }
  let status = "ok";
  let healthCode = "";
  if (!posts.length && saw429) {
    status = "slow";
    healthCode = "rate";
  } else if (slow) status = "slow";
  return {
    profile: mergeProfile({ handle: local.handle, url: local.url }, profile),
    posts,
    status,
    code: healthCode,
    retryAfter,
    channelId: local.channelId || (profile && profile.channelId) || ""
  };
}

function safeId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,90}$/.test(id) || id.indexOf("..") >= 0) return "";
  return id;
}

function groupIdOk(value) {
  return /^g[a-f0-9]{8}$/.test(String(value || ""));
}

function newGroupId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return "g" + Array.from(bytes).map((n) => n.toString(16).padStart(2, "0")).join("");
}

function cleanTabs(value) {
  const out = [];
  const list = Array.isArray(value) ? value : [];
  list.forEach((item) => {
    const id = String(item || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    if (!id || out.indexOf(id) >= 0 || out.length >= 12) return;
    out.push(id);
  });
  return out;
}

function cleanPosts(value) {
  const out = [];
  (Array.isArray(value) ? value : []).forEach((post) => {
    if (!post || out.length >= 3) return;
    const text = clip(post.text, 180);
    const id = clip(post.id, 120);
    const url = httpsOnly(post.url);
    if (!id || (!text && !url)) return;
    out.push({ id, text, date: clip(post.date, 40), url });
  });
  return out;
}

function healthOf(status, code, prev, now, retryAfter) {
  const failing = status === "failing" || code === "rate";
  const attempt = failing ? (Number(prev && prev.attempt) || 0) + 1 : 0;
  const http = code === "rate" ? 429 : status === "failing" ? 503 : 200;
  const nextAt = failing ? now + backoffMs(Math.max(0, attempt - 1), http, retryAfter || 0) : now + 30 * 60 * 1000;
  return {
    status: status === "paused" ? "paused" : status,
    code: code || "",
    text: ERROR_TEXT[code] || "",
    lastOk: status === "ok" || status === "slow" ? new Date(now).toISOString() : (prev && prev.lastOk) || "",
    updatedAt: new Date(now).toISOString(),
    nextAt,
    attempt
  };
}

function publicAccount(row) {
  const health = row.health || {};
  return {
    id: row.id,
    platform: row.platform,
    handle: row.handle,
    name: row.name || row.handle,
    label: row.label || "",
    avatar: row.avatar || "",
    url: row.url || "",
    channelId: row.channelId || "",
    groupId: row.groupId || "",
    order: Number(row.order) || 0,
    pinned: row.pinned === true,
    muted: row.muted === true,
    paused: row.paused === true,
    tabs: Array.isArray(row.tabs) ? row.tabs.slice(0, 12) : [],
    addedAt: row.addedAt || "",
    posts: cleanPosts(row.posts),
    health: {
      status: row.paused ? "paused" : (health.status || "ok"),
      code: row.paused ? "paused" : (health.code || ""),
      text: row.paused ? ERROR_TEXT.paused : (health.text || ERROR_TEXT[health.code] || ""),
      lastOk: health.lastOk || "",
      updatedAt: health.updatedAt || health.lastOk || "",
      nextAt: Number(health.nextAt) || 0
    }
  };
}

function publicGroup(row) {
  return { id: row.id, name: row.name, order: Number(row.order) || 0 };
}

function publicPlace(row) {
  return {
    id: row.id,
    groupId: row.groupId || "",
    order: Number(row.order) || 0,
    pinned: row.pinned === true,
    muted: row.muted === true,
    paused: row.paused === true,
    label: row.label || "",
    tabs: Array.isArray(row.tabs) ? row.tabs.slice(0, 12) : []
  };
}

async function readRaw(env, key) {
  if (!env.DATA) return "";
  try {
    const object = await env.DATA.get(key);
    return object ? await object.text() : "";
  } catch (err) {
    return "";
  }
}

function parseCatalog(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

async function readCatalog(env) {
  const primary = parseCatalog(await readRaw(env, CATALOG_KEY));
  const source = primary || parseCatalog(await readRaw(env, "lastgood/" + CATALOG_KEY)) || emptyCatalog();
  const accounts = [];
  (Array.isArray(source.accounts) ? source.accounts : []).forEach((row) => {
    if (!row || !safeId(row.id) || !row.platform || !row.handle) return;
    accounts.push(row);
  });
  const groups = [];
  (Array.isArray(source.groups) ? source.groups : []).forEach((row) => {
    if (!row || !groupIdOk(row.id) || !cleanGroupName(row.name)) return;
    groups.push({ id: row.id, name: cleanGroupName(row.name), order: Number(row.order) || 0 });
  });
  const places = [];
  (Array.isArray(source.places) ? source.places : []).forEach((row) => {
    if (!row || !safeId(row.id)) return;
    places.push(row);
  });
  const removed = [];
  (Array.isArray(source.removed) ? source.removed : []).forEach((item) => {
    const id = safeId(item);
    if (id && removed.indexOf(id) < 0 && removed.length < 200) removed.push(id);
  });
  return { accounts, groups, places, removed };
}

async function writeCatalog(env, doc) {
  const body = JSON.stringify({
    accounts: (doc.accounts || []).slice(0, ACCOUNT_CAP),
    groups: (doc.groups || []).slice(0, GROUP_CAP),
    places: (doc.places || []).slice(0, 400),
    removed: (doc.removed || []).slice(-200)
  });
  await env.DATA.put(CATALOG_KEY, body, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  try {
    await env.DATA.put("lastgood/" + CATALOG_KEY, body, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  } catch (err) { /* the primary copy is already stored */ }
}

function catalogBody(doc) {
  return {
    accounts: (doc.accounts || []).map(publicAccount),
    groups: (doc.groups || []).map(publicGroup).sort((a, b) => a.order - b.order),
    places: (doc.places || []).map(publicPlace)
  };
}

async function readJsonDoc(env, key) {
  const parsed = parseCatalog(await readRaw(env, key));
  return parsed || {};
}

async function mirrorX(env, account, removing) {
  const doc = await readJsonDoc(env, X_KEY);
  const added = Array.isArray(doc.added) ? doc.added.slice() : [];
  const removed = Array.isArray(doc.removed) ? doc.removed.slice() : [];
  const removedIds = Array.isArray(doc.removedIds) ? doc.removedIds.slice() : [];
  const handle = String(account.handle || "");
  const same = (item) => String(item || "").replace(/^@/, "").toLowerCase() === handle.toLowerCase();
  if (removing) {
    const next = added.filter((row) => row && !same(row.handle));
    if (!removed.some(same)) removed.push(handle);
    if (account.permanentId && removedIds.indexOf(account.permanentId) < 0) removedIds.push(account.permanentId);
    await env.DATA.put(X_KEY, JSON.stringify({ added: next, removed: removed.slice(-200), removedIds: removedIds.slice(-200) }), {
      httpMetadata: { contentType: "application/json; charset=utf-8" }
    });
    return;
  }
  const kept = added.filter((row) => row && !same(row.handle));
  kept.push({
    id: "x:" + handle,
    handle,
    permanentId: account.permanentId || "",
    name: account.name || handle,
    avatar: account.avatar || "",
    url: account.url || ("https://x.com/" + handle),
    addedAt: account.addedAt || new Date().toISOString()
  });
  await env.DATA.put(X_KEY, JSON.stringify({
    added: kept.slice(0, 50),
    removed: removed.filter((item) => !same(item)).slice(-200),
    removedIds: account.permanentId ? removedIds.filter((item) => item !== account.permanentId).slice(-200) : removedIds.slice(-200)
  }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
}

async function mirrorTikTok(env, account, removing) {
  const doc = await readJsonDoc(env, TIKTOK_KEY);
  const added = Array.isArray(doc.added) ? doc.added.slice() : [];
  const removed = Array.isArray(doc.removed) ? doc.removed.slice() : [];
  const handle = String(account.handle || "");
  const same = (item) => String(item || "").replace(/^@/, "").toLowerCase() === handle.toLowerCase();
  if (removing) {
    if (!removed.some(same)) removed.push(handle);
    await env.DATA.put(TIKTOK_KEY, JSON.stringify({
      added: added.filter((row) => row && !same(row.handle)),
      removed: removed.slice(-200)
    }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
    return;
  }
  const kept = added.filter((row) => row && !same(row.handle));
  kept.push({
    handle,
    name: account.name || "",
    avatar: account.avatar || "",
    addedAt: account.addedAt || new Date().toISOString(),
    permanentId: "",
    secUid: "",
    previousHandles: []
  });
  await env.DATA.put(TIKTOK_KEY, JSON.stringify({
    added: kept.slice(0, 50),
    removed: removed.filter((item) => !same(item)).slice(-200)
  }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
}

function applyFlags(row, body) {
  if (body.paused === true || body.paused === false) row.paused = body.paused === true;
  if (body.pinned === true || body.pinned === false) row.pinned = body.pinned === true;
  if (body.muted === true || body.muted === false) row.muted = body.muted === true;
  if (body.label != null) row.label = cleanLabel(body.label);
  if (body.groupId != null) row.groupId = body.groupId === "" || groupIdOk(body.groupId) ? String(body.groupId || "") : row.groupId;
  if (body.tabs != null) row.tabs = cleanTabs(body.tabs);
  if (body.order != null && Number.isFinite(Number(body.order))) row.order = Math.max(0, Math.min(500, Math.round(Number(body.order))));
  if (row.paused) {
    row.health = Object.assign({}, row.health || {}, { status: "paused", code: "paused", text: ERROR_TEXT.paused });
  } else if (row.health && row.health.status === "paused") {
    row.health = Object.assign({}, row.health, { status: "ok", code: "", text: "" });
  }
}

function findAccount(doc, id) {
  return (doc.accounts || []).find((row) => row && row.id === id) || null;
}

async function handleOwnerFeeds(request, env, path, deps) {
  const gate = await deps.requireOwnerHidden(request, env);
  if (gate.error) return gate.error;
  if (!env.DATA) return deps.json(503, { error: "not_configured" });
  const bucket = "owner-feeds:" + gate.row.public_id;
  const method = request.method;

  if (path === "/v1/owner/feeds" && method === "GET") {
    const hit = await deps.rateHit(env, bucket + ":list", 60, 10 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    return deps.json(200, catalogBody(await readCatalog(env)));
  }

  if (path === "/v1/owner/feeds/preview" && method === "POST") {
    const hit = await deps.rateHit(env, bucket + ":preview", 30, 10 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 2000);
    if (body.error) return deps.json(400, { error: body.error });
    const spec = detectInput(body.input || body.handle || body.url || "");
    if (!spec.ok) return deps.json(spec.error === "private_host" ? 400 : 400, { error: spec.error, message: spec.message });
    const probed = await probeAccount(spec);
    if (probed.error) return probeError(deps, probed);
    const id = accountId(Object.assign({}, spec, { channelId: probed.channelId || spec.channelId || "" }));
    return deps.json(200, {
      preview: {
        id,
        platform: spec.platform,
        handle: probed.profile.handle || spec.handle,
        name: probed.profile.name || spec.handle,
        avatar: probed.profile.avatar || "",
        url: probed.profile.url || spec.url,
        channelId: probed.channelId || "",
        posts: cleanPosts(probed.posts),
        health: { status: probed.status, code: probed.code || "", text: ERROR_TEXT[probed.code] || "" }
      }
    });
  }

  if (path === "/v1/owner/feeds" && method === "POST") {
    const hit = await deps.rateHit(env, bucket + ":add", 20, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    if (body.confirm !== true) return deps.json(400, { error: "confirm" });
    const added = await addToCatalog(env, body.input || "", deps);
    return deps.json(added.status, added.body, added.extra || null);
  }

  if (path === "/v1/owner/feeds/groups" && method === "POST") {
    const hit = await deps.rateHit(env, bucket + ":group", 40, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    const name = cleanGroupName(body.name);
    if (!name) return deps.json(400, { error: "bad_group" });
    const doc = await readCatalog(env);
    if (doc.groups.length >= GROUP_CAP) return deps.json(400, { error: "full" });
    const group = { id: newGroupId(), name, order: doc.groups.length };
    doc.groups.push(group);
    await writeCatalog(env, doc);
    return deps.json(200, { group: publicGroup(group), groups: doc.groups.map(publicGroup) });
  }

  const groupPath = path.match(/^\/v1\/owner\/feeds\/groups\/([^/]+)$/);
  if (groupPath && (method === "PATCH" || method === "DELETE")) {
    const hit = await deps.rateHit(env, bucket + ":group", 40, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const gid = groupPath[1];
    if (!groupIdOk(gid)) return deps.json(400, { error: "bad_group" });
    const doc = await readCatalog(env);
    const group = doc.groups.find((item) => item.id === gid);
    if (!group) return deps.json(404, { error: "not_found" });
    if (method === "DELETE") {
      doc.groups = doc.groups.filter((item) => item.id !== gid);
      doc.accounts.forEach((row) => { if (row.groupId === gid) row.groupId = ""; });
      doc.places.forEach((row) => { if (row.groupId === gid) row.groupId = ""; });
      await writeCatalog(env, doc);
      return deps.json(200, catalogBody(doc));
    }
    const body = await deps.readJson(request, 1000);
    if (body.error) return deps.json(400, { error: body.error });
    const name = cleanGroupName(body.name);
    if (!name) return deps.json(400, { error: "bad_group" });
    group.name = name;
    await writeCatalog(env, doc);
    return deps.json(200, { group: publicGroup(group) });
  }

  if (path === "/v1/owner/feeds/reorder" && method === "POST") {
    const hit = await deps.rateHit(env, bucket + ":reorder", 60, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 8000);
    if (body.error) return deps.json(400, { error: body.error });
    const doc = await readCatalog(env);
    const ids = Array.isArray(body.ids) ? body.ids.map(safeId).filter(Boolean) : [];
    const groupId = body.groupId == null ? null : (body.groupId === "" || groupIdOk(body.groupId) ? String(body.groupId) : null);
    if (groupId == null && body.groupId != null) return deps.json(400, { error: "bad_group" });
    if (Array.isArray(body.groups)) {
      const order = body.groups.map((item) => String(item || "")).filter(groupIdOk);
      const map = {};
      doc.groups.forEach((group) => { map[group.id] = group; });
      const next = [];
      order.forEach((id, index) => {
        if (!map[id]) return;
        map[id].order = index;
        next.push(map[id]);
        delete map[id];
      });
      Object.keys(map).forEach((id) => next.push(map[id]));
      doc.groups = next;
    }
    if (ids.length) {
      ids.forEach((id, index) => {
        const account = findAccount(doc, id);
        const place = doc.places.find((row) => row.id === id);
        const target = account || place;
        if (!target) return;
        target.order = index;
        if (groupId != null) target.groupId = groupId;
      });
    }
    await writeCatalog(env, doc);
    return deps.json(200, catalogBody(doc));
  }

  if (path === "/v1/owner/feeds/bulk" && method === "POST") {
    const hit = await deps.rateHit(env, bucket + ":bulk", 30, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    const body = await deps.readJson(request, 8000);
    if (body.error) return deps.json(400, { error: body.error });
    const ids = Array.isArray(body.ids) ? body.ids.map(safeId).filter(Boolean).slice(0, 80) : [];
    if (!ids.length) return deps.json(400, { error: "bad_id" });
    const doc = await readCatalog(env);
    ids.forEach((id) => {
      let row = findAccount(doc, id);
      if (!row) {
        row = doc.places.find((item) => item.id === id);
        if (!row) {
          row = { id };
          doc.places.push(row);
        }
      }
      applyFlags(row, body);
    });
    await writeCatalog(env, doc);
    return deps.json(200, catalogBody(doc));
  }

  const retryPath = path.match(/^\/v1\/owner\/feeds\/([^/]+)\/retry$/);
  if (retryPath && method === "POST") {
    const hit = await deps.rateHit(env, bucket + ":retry", 20, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    let raw = retryPath[1];
    try { raw = decodeURIComponent(raw); } catch (err) { /* keep the raw segment */ }
    const id = safeId(raw);
    if (!id) return deps.json(400, { error: "bad_id" });
    const doc = await readCatalog(env);
    const row = findAccount(doc, id);
    if (!row) return deps.json(404, { error: "not_found" });
    if (row.paused) return deps.json(200, { account: publicAccount(row) });
    const probed = await refreshAccount(row);
    await writeCatalog(env, doc);
    return deps.json(probed && probed.error === "rate" ? 429 : 200, { account: publicAccount(row) });
  }

  const one = path.match(/^\/v1\/owner\/feeds\/([^/]+)$/);
  if (one && (method === "PATCH" || method === "DELETE")) {
    const hit = await deps.rateHit(env, bucket + ":edit", 60, 60 * 60 * 1000);
    if (!hit.ok) return deps.limited(hit);
    let raw = one[1];
    try { raw = decodeURIComponent(raw); } catch (err) { /* keep the raw segment */ }
    const id = safeId(raw);
    if (!id) return deps.json(400, { error: "bad_id" });
    const doc = await readCatalog(env);
    if (method === "DELETE") {
      const row = findAccount(doc, id);
      doc.accounts = doc.accounts.filter((item) => item.id !== id);
      doc.places = doc.places.filter((item) => item.id !== id);
      if (doc.removed.indexOf(id) < 0) doc.removed.push(id);
      await writeCatalog(env, doc);
      if (row) {
        try {
          if (row.platform === "x") await mirrorX(env, row, true);
          if (row.platform === "tiktok") await mirrorTikTok(env, row, true);
        } catch (err) { /* the catalog removal is already stored */ }
      }
      let dispatched = false;
      try { dispatched = await deps.dispatchWorkflows(env, ["sync.yml"]); }
      catch (err) { dispatched = false; }
      return deps.json(200, Object.assign({ removed: true, dispatched }, catalogBody(doc)));
    }
    const body = await deps.readJson(request, 4000);
    if (body.error) return deps.json(400, { error: body.error });
    let row = findAccount(doc, id);
    if (!row) {
      row = doc.places.find((item) => item.id === id);
      if (!row) {
        row = { id };
        doc.places.push(row);
      }
    }
    if (body.groupId && !groupIdOk(body.groupId)) return deps.json(400, { error: "bad_group" });
    if (body.groupId && !doc.groups.some((group) => group.id === body.groupId)) return deps.json(400, { error: "bad_group" });
    applyFlags(row, body);
    await writeCatalog(env, doc);
    return deps.json(200, row.platform ? { account: publicAccount(row) } : { place: publicPlace(row) });
  }

  return deps.json(404, { error: "not_found" });
}

function probeError(deps, probed) {
  const status = probed.error === "not_found" ? 404 : probed.error === "rate" ? 429 : probed.error === "bad_feed" || probed.error === "private_host" ? 400 : 503;
  const extra = probed.error === "rate" ? { "retry-after": String(Math.max(1, Number(probed.retryAfter) || 60)) } : null;
  return deps.json(status, { error: probed.error, message: ERROR_TEXT[probed.error] || ERROR_TEXT.down }, extra);
}

function specFromAccount(row) {
  const spec = detectInput(row.platform + ":" + (row.platform === "reddit" ? ((row.redditKind || "u") + "/" + row.handle) : row.platform === "mastodon" ? row.url : row.platform === "rss" ? row.url : row.handle));
  if (!spec.ok && row.url) return detectInput(row.url);
  if (spec.ok && row.channelId) spec.channelId = row.channelId;
  if (spec.ok && row.platform === "mastodon") {
    spec.host = row.host || spec.host;
    spec.handle = row.handle || spec.handle;
  }
  return spec;
}

async function refreshAccount(row) {
  const spec = specFromAccount(row);
  if (!spec.ok) {
    row.health = healthOf("failing", spec.error || "down", row.health, Date.now(), 0);
    return { error: spec.error };
  }
  const probed = await probeAccount(spec);
  const now = Date.now();
  if (probed.error) {
    row.health = healthOf("failing", probed.error, row.health, now, probed.retryAfter || 0);
    return probed;
  }
  if (probed.profile.name) row.name = probed.profile.name;
  if (probed.profile.avatar) row.avatar = probed.profile.avatar;
  if (probed.posts && probed.posts.length) row.posts = cleanPosts(probed.posts);
  if (probed.channelId) row.channelId = probed.channelId;
  row.health = healthOf(probed.status, probed.code, row.health, now, probed.retryAfter || 0);
  if (row.health.status === "ok" || row.health.status === "slow") row.health.attempt = 0;
  return probed;
}

async function sweepOwnerFeeds(env, now) {
  if (!env || !env.DATA) return false;
  const doc = await readCatalog(env);
  const due = (doc.accounts || []).filter((row) => {
    if (!row || row.paused) return false;
    const nextAt = Number(row.health && row.health.nextAt) || 0;
    return nextAt > 0 && nextAt <= (now || Date.now());
  });
  if (!due.length) return false;
  // The Worker refreshes one feed a minute. Render has no subrequest cap, so
  // it catches up on several due feeds per pass, three fetches at a time.
  const batch = isRunner(env) ? due.slice(0, 6) : due.slice(0, 1);
  await eachLimit(batch, 3, (row) => refreshAccount(row));
  await writeCatalog(env, doc);
  return true;
}

export { handleOwnerFeeds, sweepOwnerFeeds, CATALOG_KEY, probeAccount };

/* Adds one account to the owner catalog. The owner POST route and an
   allowed source request both land here, so a ban is checked once. */
/* A live probe with a time limit. A request the owner approves is saved
   even when the public bridges are slow, blocked or down right now: the sync
   fetches it later through the regular fetchers and backups. */
export async function probeWithin(spec, ms, fetchImpl) {
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ error: "down", late: true }), ms); });
  try {
    return await Promise.race([probeAccount(spec, fetchImpl).catch(() => ({ error: "down" })), late]);
  } finally {
    clearTimeout(timer);
  }
}

/* What the catalog stores when the probe could not reach the source. */
export function unverifiedProbe(spec, probed) {
  const code = probed && probed.error === "rate" ? "rate" : "";
  return {
    profile: { handle: spec.handle, name: spec.handle, avatar: "", url: spec.url || "" },
    posts: [],
    status: "slow",
    code,
    retryAfter: Number(probed && probed.retryAfter) || 0,
    channelId: spec.channelId || "",
    unverified: true
  };
}

export async function addToCatalog(env, input, deps, opts) {
  const options = opts || {};
  const spec = detectInput(input || "");
  if (!spec.ok) return { status: 400, body: { error: spec.error, message: spec.message } };
  if (await bannedSpec(env, spec)) return { status: 403, body: { error: "banned" } };
  let probed = options.unverified ? await probeWithin(spec, options.probeMs || 6000) : await probeAccount(spec);
  if (probed.error && options.unverified && probed.error !== "private_host" && probed.error !== "bad_feed") probed = unverifiedProbe(spec, probed);
  if (probed.error) return probeResult(probed);
  const doc = await readCatalog(env);
  const id = accountId(Object.assign({}, spec, { channelId: probed.channelId || spec.channelId || "", handle: probed.profile.handle || spec.handle }));
  doc.removed = doc.removed.filter((item) => item !== id);
  let row = findAccount(doc, id);
  const now = Date.now();
  if (!row) {
    if (doc.accounts.length >= ACCOUNT_CAP) return { status: 400, body: { error: "full", message: ERROR_TEXT.full } };
    row = {
      id,
      platform: spec.platform,
      handle: probed.profile.handle || spec.handle,
      host: spec.host || "",
      redditKind: spec.redditKind || "",
      name: probed.profile.name || spec.handle,
      label: "",
      avatar: probed.profile.avatar || "",
      url: probed.profile.url || spec.url,
      channelId: probed.channelId || "",
      permanentId: probed.profile.permanentId || "",
      groupId: "",
      order: doc.accounts.length,
      pinned: false,
      muted: false,
      paused: false,
      tabs: [],
      addedAt: new Date(now).toISOString(),
      posts: cleanPosts(probed.posts),
      health: healthOf(probed.status, probed.code, null, now, probed.retryAfter)
    };
    doc.accounts.push(row);
  } else {
    row.name = probed.profile.name || row.name;
    row.avatar = probed.profile.avatar || row.avatar;
    row.url = probed.profile.url || row.url;
    row.handle = probed.profile.handle || row.handle;
    if (probed.channelId) row.channelId = probed.channelId;
    if (probed.profile.permanentId) row.permanentId = probed.profile.permanentId;
    row.paused = false;
    row.posts = cleanPosts(probed.posts).length ? cleanPosts(probed.posts) : cleanPosts(row.posts);
    row.health = healthOf(probed.status, probed.code, row.health, now, probed.retryAfter);
  }
  await writeCatalog(env, doc);
  try {
    if (row.platform === "x") await mirrorX(env, row, false);
    if (row.platform === "tiktok") await mirrorTikTok(env, row, false);
  } catch (err) { /* the catalog row is already stored */ }
  let dispatched = false;
  try { dispatched = await deps.dispatchWorkflows(env, ["sync.yml"]); }
  catch (err) { dispatched = false; }
  return { status: 200, body: { account: publicAccount(row), dispatched, unverified: !!probed.unverified } };
}

/* A banned source stops being fetched: its catalog row is paused and the
   X/TikTok mirrors drop it. keys are lowercased source keys. */
export async function pauseCatalogKeys(env, keys) {
  const want = new Set((keys || []).map((key) => String(key || "").toLowerCase()).filter(Boolean));
  if (!want.size) return 0;
  const doc = await readCatalog(env);
  let changed = 0;
  for (const row of doc.accounts) {
    const id = String(row.id || "").toLowerCase();
    const alias = (String(row.platform || "") + ":" + String(row.handle || "")).toLowerCase();
    if (!want.has(id) && !want.has(alias)) continue;
    if (!row.paused) changed += 1;
    row.paused = true;
    try {
      if (row.platform === "x") await mirrorX(env, row, true);
      if (row.platform === "tiktok") await mirrorTikTok(env, row, true);
    } catch (err) { /* the pause is stored below */ }
  }
  if (changed) await writeCatalog(env, doc);
  return changed;
}

function probeResult(probed) {
  const status = probed.error === "not_found" ? 404 : probed.error === "rate" ? 429 : probed.error === "bad_feed" || probed.error === "private_host" ? 400 : 503;
  const extra = probed.error === "rate" ? { "retry-after": String(Math.max(1, Number(probed.retryAfter) || 60)) } : null;
  return { status, body: { error: probed.error, message: ERROR_TEXT[probed.error] || ERROR_TEXT.down }, extra };
}
