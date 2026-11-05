/* GET /v1/reader?url=  A reading view of one public https page.
   The Worker fetches the page itself, with no cookies and no caller headers,
   then returns sanitized article HTML or a preview when the page cannot be
   read. Images are not proxied. Successful public responses are cached at
   the edge for a few minutes and are not written to R2. */

import { extractArticle } from "../../shared/reader-extract.js";
import { addressesArePublic, readerTarget, robotsAllows } from "../../shared/reader-safe.js";

export const READER_TTL_S = 10 * 60;
const MAX_BYTES = 1500000;
const MAX_ROBOTS = 256 * 1024;
const UA = "ViktorychAppReader/1.0 (+https://viktorychgroup.github.io/ViktorychApp; public reading view)";
const UA_TOKEN = "ViktorychAppReader";
const DOH = "https://cloudflare-dns.com/dns-query";

function reply(status, body, maxAge) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? "public, max-age=" + maxAge : "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex",
      "referrer-policy": "no-referrer"
    }
  });
}

function deadline(ms) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

async function sha(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

function emptyDoc(url, reason) {
  const host = url.hostname.replace(/^www\./, "");
  return {
    url: url.href,
    requested: url.href,
    mode: "preview",
    reason: reason,
    title: "",
    byline: "",
    date: "",
    site: "",
    domain: host,
    description: "",
    image: "",
    caption: "",
    html: "",
    wordCount: 0,
    lang: ""
  };
}

async function readCapped(response, max) {
  if (!response.body || !response.body.getReader) {
    const text = await response.text();
    return { text: text.slice(0, max), truncated: text.length > max };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    const room = max - size;
    if (part.value.byteLength > room) {
      chunks.push(part.value.slice(0, room));
      size += room;
      truncated = true;
      break;
    }
    chunks.push(part.value);
    size += part.value.byteLength;
  }
  try { reader.cancel(); } catch (_) { /* already finished */ }
  const all = new Uint8Array(size);
  let at = 0;
  chunks.forEach((chunk) => { all.set(chunk, at); at += chunk.byteLength; });
  const type = String(response.headers.get("content-type") || "");
  const charset = /charset\s*=\s*"?([A-Za-z0-9._-]+)/i.exec(type);
  let encoding = "utf-8";
  if (charset) {
    const name = charset[1].toLowerCase().replace(/^utf8$/, "utf-8");
    if (name === "iso-8859-1" || name === "latin1" || name === "windows-1252" || name === "us-ascii") encoding = "windows-1252";
  }
  let text = "";
  try { text = new TextDecoder(encoding).decode(all); } catch (_) { text = new TextDecoder("utf-8").decode(all); }
  return { text, truncated };
}

async function resolveHost(host, deps, signal, depth) {
  if (deps.resolve) {
    const list = await deps.resolve(host);
    return Array.isArray(list) ? list : [];
  }
  if (depth > 4) return [];
  const ips = [];
  const names = [];
  for (const type of ["A", "AAAA"]) {
    const response = await deps.fetch(DOH + "?name=" + encodeURIComponent(host) + "&type=" + type, {
      method: "GET",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: signal,
      headers: { accept: "application/dns-json", "user-agent": UA }
    });
    if (!response || !response.ok) return [];
    const data = await response.json();
    if (!data || data.Status !== 0) return [];
    (data.Answer || []).forEach((row) => {
      if (!row) return;
      if (row.type === 1 || row.type === 28) ips.push(String(row.data || ""));
      else if (row.type === 5 && row.data) names.push(String(row.data).replace(/\.$/, ""));
    });
  }
  if (ips.length) return ips;
  if (names.length) return resolveHost(names[0], deps, signal, (depth || 0) + 1);
  return [];
}

async function guarded(url, deps, signal, seen) {
  const target = readerTarget(url.href || url);
  if (!target) return null;
  const host = target.hostname;
  if (!seen.has(host)) {
    let ips = [];
    try { ips = await resolveHost(host, deps, signal, 0); } catch (_) { return null; }
    if (!addressesArePublic(ips)) return null;
    seen.set(host, true);
  }
  return target;
}

function htmlType(header) {
  const type = String(header || "").toLowerCase();
  return type.includes("text/html") || type.includes("application/xhtml+xml");
}

function sharedCache(header) {
  const text = String(header || "").toLowerCase();
  if (!text) return true;
  if (/\b(?:no-store|private)\b/.test(text)) return false;
  return true;
}

function headerRobotsBlock(header) {
  const text = String(header || "").toLowerCase();
  return /(^|[,;\s])(none|noarchive)([,;\s]|$)/.test(text);
}

async function fetchRobots(url, deps, signal, seen) {
  const robotsUrl = new URL("/robots.txt", url.origin);
  const safe = await guarded(robotsUrl, deps, signal, seen);
  if (!safe) return "";
  let current = safe;
  for (let hop = 0; hop < 2; hop += 1) {
    const response = await deps.fetch(current.href, {
      method: "GET",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: signal,
      headers: { "user-agent": UA, accept: "text/plain,*/*;q=0.1" }
    });
    if (!response) return "";
    if (response.status >= 300 && response.status < 400) {
      const next = readerTarget(new URL(response.headers.get("location") || "", current).href);
      if (!next || next.origin !== url.origin) return "";
      const checked = await guarded(next, deps, signal, seen);
      if (!checked) return "";
      current = checked;
      continue;
    }
    if (response.status === 404 || response.status === 410) return "";
    if (!response.ok) return "";
    const body = await readCapped(response, MAX_ROBOTS);
    return body.text || "";
  }
  return "";
}

function docFromExtract(finalUrl, requested, extracted, reason) {
  const host = finalUrl.hostname.replace(/^www\./, "");
  const article = !reason && extracted && extracted.html;
  return {
    url: finalUrl.href,
    requested: requested,
    mode: article ? "article" : "preview",
    reason: article ? "" : (reason || "extract"),
    title: extracted.title || "",
    byline: article ? extracted.byline || "" : "",
    date: article ? extracted.date || "" : "",
    site: extracted.site || "",
    domain: host,
    description: extracted.description || "",
    image: /^https:\/\//i.test(extracted.image || "") ? extracted.image : "",
    caption: article ? extracted.caption || "" : "",
    html: article ? extracted.html : "",
    wordCount: article ? extracted.wordCount || 0 : 0,
    lang: extracted.lang || ""
  };
}

async function loadPage(start, deps, signal) {
  const seen = new Map();
  const requested = start.href;
  let url = await guarded(start, deps, signal, seen);
  if (!url) return { doc: emptyDoc(start, "blocked"), store: true };
  let robots = "";
  try { robots = await fetchRobots(url, deps, signal, seen); } catch (_) { robots = ""; }
  if (robots && !robotsAllows(robots, url.pathname + url.search, UA_TOKEN)) {
    return { doc: emptyDoc(url, "robots"), store: true };
  }
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await deps.fetch(url.href, {
      method: "GET",
      redirect: "manual",
      referrerPolicy: "no-referrer",
      signal: signal,
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "accept-language": "en"
      }
    });
    if (!response) return { doc: emptyDoc(url, "blocked"), store: false };
    if (response.status >= 300 && response.status < 400) {
      let next;
      try { next = new URL(response.headers.get("location") || "", url); } catch (_) { return { doc: emptyDoc(url, "blocked"), store: false }; }
      const safe = await guarded(next, deps, signal, seen);
      if (!safe) return { doc: emptyDoc(url, "blocked"), store: true };
      if (robots && safe.origin === url.origin && !robotsAllows(robots, safe.pathname + safe.search, UA_TOKEN)) {
        return { doc: emptyDoc(safe, "robots"), store: true };
      }
      if (safe.origin !== url.origin) {
        try {
          const moved = await fetchRobots(safe, deps, signal, seen);
          if (moved && !robotsAllows(moved, safe.pathname + safe.search, UA_TOKEN)) return { doc: emptyDoc(safe, "robots"), store: true };
          robots = moved;
        } catch (_) { robots = ""; }
      }
      url = safe;
      continue;
    }
    if (response.status === 401 || response.status === 407) return { doc: emptyDoc(url, "login"), store: true };
    if (response.status === 402) return { doc: emptyDoc(url, "paywall"), store: true };
    if (response.status === 403 || response.status === 451) return { doc: emptyDoc(url, "blocked"), store: true };
    if (!response.ok) return { doc: emptyDoc(url, "blocked"), store: false };
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES + 200000) return { doc: emptyDoc(url, "size"), store: true };
    const share = sharedCache(response.headers.get("cache-control"));
    if (!htmlType(response.headers.get("content-type"))) {
      const doc = emptyDoc(url, "type");
      doc.requested = requested;
      return { doc: doc, store: share };
    }
    if (headerRobotsBlock(response.headers.get("x-robots-tag"))) {
      const doc = emptyDoc(url, "robots");
      doc.requested = requested;
      return { doc: doc, store: share };
    }
    const body = await readCapped(response, MAX_BYTES);
    const extracted = extractArticle(body.text, url.href);
    let reason = "";
    if (extracted.paywall) reason = "paywall";
    else if (extracted.robots) reason = "robots";
    else if (extracted.login) reason = "login";
    else if (!extracted.html) reason = body.truncated ? "size" : "extract";
    const doc = docFromExtract(url, requested, extracted, reason);
    return { doc: doc, store: share && !body.truncated };
  }
  return { doc: emptyDoc(start, "blocked"), store: false };
}

export async function handleReader(request, deps) {
  const incoming = new URL(request.url);
  const target = readerTarget(incoming.searchParams.get("url"));
  if (!target) return reply(400, { error: "bad_url" });
  const key = await sha(target.href);
  const cacheReq = new Request("https://reader.cache/v1/" + key);
  const cache = deps && deps.cache;
  if (cache) {
    const hit = await cache.match(cacheReq);
    if (hit) return hit;
  }
  if (deps && deps.limit) {
    const paced = await deps.limit();
    if (paced && paced.ok === false && paced.response) return paced.response;
  }
  const signal = deadline(8000);
  let loaded;
  try {
    loaded = await loadPage(target, deps, signal);
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || err.name === "TimeoutError" || /abort|timeout/i.test(String(err && err.message || "")));
    loaded = { doc: emptyDoc(target, aborted ? "timeout" : "blocked"), store: false };
  }
  const doc = loaded.doc;
  const age = doc.mode === "article" ? READER_TTL_S : 120;
  const res = reply(200, doc, loaded.store ? age : 0);
  if (cache && loaded.store) {
    const put = cache.put(cacheReq, res.clone());
    if (deps.waitUntil) deps.waitUntil(Promise.resolve(put)); else await put;
  }
  return res;
}
