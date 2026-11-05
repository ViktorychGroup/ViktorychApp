/* GET /v1/x-broadcast?id=<broadcast id>&status=<optional post id>
   Public playback for one X broadcast. Sources, in order: X's public
   syndication document for the post (only when it names this broadcast),
   the same post on the public fxtwitter and vxtwitter APIs, then the
   official publish.twitter.com oEmbed document. No guest token, no
   api.x.com / api.twitter.com, no Periscope private API, and no bytes
   proxied. The answer is a small JSON card. Live answers are cached for
   a minute; replays and misses for five. */

import { assertNotPaidX } from "./x-guard.js";
import { syndicationToken } from "./xvideo.js";
import { SOURCE_HOSTS, cleanId, statusId, openUrl, extractFor, present } from "../../shared/x-broadcast.js";

const LIVE_TTL_S = 60;
const QUIET_TTL_S = 5 * 60;
const TIMEOUT_MS = 6000;
const UA = "Mozilla/5.0 (compatible; ViktorychApp/1.0; +https://viktorychgroup.github.io/ViktorychApp)";
const HOSTS = new Set(SOURCE_HOSTS);

function reply(status, body, maxAge) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge ? "public, max-age=" + maxAge : "no-store",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex"
    }
  });
}

function sourceUrls(id, status) {
  const page = openUrl(id);
  const out = [];
  if (status) {
    out.push(["syndication", "https://cdn.syndication.twimg.com/tweet-result?id=" + status + "&lang=en&token=" + syndicationToken(status), false]);
    out.push(["fxtwitter", "https://api.fxtwitter.com/2/status/" + status, false]);
    out.push(["vxtwitter", "https://api.vxtwitter.com/Twitter/status/" + status, false]);
  }
  out.push(["oembed", "https://publish.twitter.com/oembed?omit_script=true&dnt=true&maxwidth=550&url=" + encodeURIComponent(page), true]);
  return out;
}

function hostOk(url) {
  try { return HOSTS.has(new URL(url).hostname); } catch (err) { return false; }
}

async function getJson(fetcher, url) {
  assertNotPaidX(url);
  if (!hostOk(url)) return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetcher(url, { headers: { accept: "application/json", "user-agent": UA }, signal: controller ? controller.signal : undefined });
    if (!res || !res.ok) return null;
    const text = await res.text();
    if (!text || text.length > 2_000_000) return null;
    return JSON.parse(text);
  } catch (err) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emptyBag() {
  return { hls: "", kind: "", poster: "", title: "", state: "unknown", width: 0, height: 0 };
}

function merge(base, extra) {
  if (!extra) return base;
  if (!base.hls && extra.hls) {
    base.hls = extra.hls;
    base.kind = extra.kind;
  }
  if (!base.poster && extra.poster) base.poster = extra.poster;
  if (!base.title && extra.title) base.title = extra.title;
  if (base.state === "unknown" && extra.state && extra.state !== "unknown") base.state = extra.state;
  if (!base.width && extra.width) base.width = extra.width;
  if (!base.height && extra.height) base.height = extra.height;
  return base;
}

export async function resolveXBroadcast(id, status, fetcher) {
  const bag = emptyBag();
  let source = "";
  for (const [name, url, trusted] of sourceUrls(id, status)) {
    const data = await getJson(fetcher, url);
    if (!data) continue;
    const found = extractFor(data, id, trusted);
    const had = bag.hls;
    merge(bag, found);
    if (!had && bag.hls) source = name;
    // One public playlist is enough. Do not keep calling the other sources.
    if (bag.hls) break;
  }
  const model = present({
    id: id,
    statusId: status,
    title: bag.title,
    poster: bag.poster,
    hls: bag.hls,
    kind: bag.kind,
    state: bag.state,
    width: bag.width,
    height: bag.height,
    checked: true
  });
  return {
    id: model.id,
    openUrl: model.openUrl,
    state: model.state,
    title: model.title,
    poster: model.poster,
    width: model.width,
    height: model.height,
    hls: model.hls,
    kind: model.kind,
    source: source,
    none: model.mode !== "play"
  };
}

export async function handleXBroadcast(request, deps) {
  const url = new URL(request.url);
  const id = cleanId(url.searchParams.get("id") || "");
  if (!id) return reply(400, { error: "id" });
  const status = statusId(url.searchParams.get("status") || "");
  const cache = deps && deps.cache;
  const key = new Request("https://xcast.cache/v1/" + id + "/" + (status || "-"));
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit;
    } catch (err) { /* a cache miss is fine */ }
  }
  const found = await resolveXBroadcast(id, status, (deps && deps.fetch) || fetch);
  const maxAge = found.state === "live" ? LIVE_TTL_S : QUIET_TTL_S;
  const res = reply(200, found, maxAge);
  if (cache) {
    const put = cache.put(key, res.clone()).catch(() => null);
    if (deps.waitUntil) deps.waitUntil(put);
  }
  return res;
}
