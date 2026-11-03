/* D1 saver: public reads keep answering when D1 rows read run out.

   D1's free plan allows 5M rows read a day; past that D1 refuses queries
   until 00:00 UTC. Signed-out GET reads (profiles, posts, lists anyone can
   see) carry no per-person data, so their last good answer is kept in this
   colo's Cache API (free, no D1). Normally that copy is only written. When
   today's D1 rows read reach SAVER_PCT, or a read fails, the saved copy is
   served instead (X-D1-Saver: stale) and D1 is not asked. Signed-in reads,
   writes, owner and session routes always go to D1. */

export const SAVER_PCT = 90;
export const KEEP_SECONDS = 24 * 60 * 60;
const MAX_BYTES = 256 * 1024;
const PUT_EVERY_MS = 60 * 1000;
const CACHE_HOST = "https://d1-saver.invalid";
const SKIP = /^\/v1\/(owner|me|auth|session|sessions|signup|login|logout|watchdog|health|geo|usage|seal|admin|tg|archive|media|data|yt|ytm|comments|unfurl|ext-graph|sync|vault|keys|devices|passkeys|webauthn|recovery)(\/|$)/;

const putAt = new Map();

export function saverEligible(request) {
  if (!request || request.method !== "GET") return false;
  if (request.headers.get("authorization") || request.headers.get("cookie")) return false;
  if (request.headers.get("upgrade")) return false;
  let path = "";
  try { path = new URL(request.url).pathname; } catch (err) { return false; }
  if (!path.startsWith("/v1/")) return false;
  return !SKIP.test(path);
}

export function saverKey(request) {
  const url = new URL(request.url);
  const params = Array.from(url.searchParams.entries()).filter(([k]) => k !== "_" && k !== "t").sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
  const query = params.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  const block = request.headers.get("x-block") || "";
  return CACHE_HOST + url.pathname + (query ? "?" + query : "") + (block ? (query ? "&" : "?") + "__b=" + encodeURIComponent(block.slice(0, 200)) : "");
}

function storable(response) {
  if (!response || response.status !== 200 || response.webSocket) return false;
  if ((response.headers.get("content-type") || "").indexOf("application/json") < 0) return false;
  if (/no-store|private/i.test(response.headers.get("cache-control") || "")) return false;
  if (response.headers.get("set-cookie")) return false;
  const length = Number(response.headers.get("content-length") || 0);
  return !(length > MAX_BYTES);
}

async function readSaved(cache, request) {
  try {
    const hit = await cache.match(saverKey(request));
    if (!hit) return null;
    const headers = new Headers(hit.headers);
    headers.set("x-d1-saver", "stale");
    headers.set("cache-control", "no-cache");
    return new Response(hit.body, { status: 200, headers });
  } catch (err) { return null; }
}

function save(cache, request, response, now, waitUntil) {
  const key = saverKey(request);
  const last = putAt.get(key) || 0;
  if (now - last < PUT_EVERY_MS) return;
  putAt.set(key, now);
  if (putAt.size > 2000) putAt.clear();
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=" + KEEP_SECONDS);
  headers.delete("set-cookie");
  const job = response.clone().arrayBuffer().then((body) => {
    if (body.byteLength > MAX_BYTES) return null;
    return cache.put(key, new Response(body, { status: 200, headers }));
  }).catch(() => null);
  if (waitUntil) waitUntil(job);
}

/* run(): the normal route. deps: { cache, pct: () => number, now, waitUntil }. */
export async function withD1Saver(request, run, deps) {
  const d = deps || {};
  const cache = d.cache;
  if (!cache || !saverEligible(request)) return run();
  const now = Number(d.now) || Date.now();
  const pct = typeof d.pct === "function" ? Number(d.pct()) : -1;
  if (pct >= SAVER_PCT) {
    const saved = await readSaved(cache, request);
    if (saved) return saved;
  }
  let response = null;
  try {
    response = await run();
  } catch (err) {
    const saved = await readSaved(cache, request);
    if (saved) return saved;
    throw err;
  }
  if (response && response.status >= 500) {
    const saved = await readSaved(cache, request);
    if (saved) return saved;
    return response;
  }
  if (storable(response)) save(cache, request, response, now, d.waitUntil);
  return response;
}

export function resetSaverForTest() { putAt.clear(); }
