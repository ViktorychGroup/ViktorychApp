/* Public X broadcast / Periscope cards.
   A player is used only when a public https HLS or mp4 URL is already in
   supported data (the post, X's public syndication JSON, fxtwitter,
   vxtwitter, or the official oEmbed document). There is no guest token,
   no private API, and no media proxy. Anything else is a Watch on X link. */

const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const STATUS_RE = /^\d{6,25}$/;
const PAGE_HOST = /^(?:(?:www|mobile|m)\.)?(?:x\.com|twitter\.com|periscope\.tv|pscp\.tv)$/i;
const STATE_KEYS = new Set(["state", "broadcast_state", "lifecycle_state"]);
const TITLE_KEYS = new Set(["title", "broadcast_title"]);
const POSTER_KEYS = new Set(["poster", "thumbnail", "thumbnail_url", "image_url", "media_url_https", "preview_image_url", "image"]);

export const SOURCE_HOSTS = ["cdn.syndication.twimg.com", "api.fxtwitter.com", "api.vxtwitter.com", "publish.twitter.com"];
export const BLOCKED_HOSTS = ["api.x.com", "api.twitter.com", "upload.twitter.com", "api.periscope.tv", "api.pscp.tv", "proxsee.pscp.tv"];

function cleanTitle(value) {
  const text = String(value || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 180 || /^https?:/i.test(text)) return "";
  return text;
}

export function cleanId(value) {
  const fromUrl = broadcastId(value);
  if (fromUrl) return fromUrl;
  const raw = String(value || "").trim();
  return ID_RE.test(raw) ? raw : "";
}

export function statusId(value) {
  const raw = String(value || "").trim();
  return STATUS_RE.test(raw) ? raw : "";
}

/* The broadcast id from a public page URL. A Periscope profile segment is
   not returned. Spaces and other X pages are not broadcasts. */
export function broadcastId(value) {
  const raw = String(value || "");
  const found = raw.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  const list = found.length ? found : [raw];
  for (let i = 0; i < list.length; i++) {
    let url;
    try { url = new URL(list[i]); } catch (err) { continue; }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (!PAGE_HOST.test(url.hostname)) continue;
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch (err) { return part; }
    });
    let id = "";
    if ((host.endsWith("x.com") || host.endsWith("twitter.com")) && parts.length >= 3 && parts[0] === "i" && parts[1] === "broadcasts") id = parts[2];
    else if (host.endsWith("periscope.tv") || host.endsWith("pscp.tv")) {
      if (parts[0] === "w" && parts[1]) id = parts[1];
      else if (parts.length >= 2) id = parts[parts.length - 1];
    }
    id = String(id || "").split("?")[0].split("#")[0];
    if (ID_RE.test(id)) return id;
  }
  return "";
}

export function openUrl(id) {
  const clean = cleanId(id);
  return clean ? "https://x.com/i/broadcasts/" + clean : "";
}

export function playbackAllowed(url) {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch (err) { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const hls = path.endsWith(".m3u8");
  const mp4 = path.endsWith(".mp4");
  if (!hls && !mp4) return false;
  if (host === "video.twimg.com" || host.endsWith(".video.twimg.com")) return true;
  if ((host === "video.pscp.tv" || host.endsWith(".video.pscp.tv")) && hls) return true;
  return false;
}

export function kindOf(url) {
  return /\.m3u8(\?|$)/i.test(String(url || "")) ? "hls" : "mp4";
}

export function posterAllowed(url) {
  let parsed;
  try { parsed = new URL(String(url || "")); } catch (err) { return false; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (host !== "pbs.twimg.com" && !host.endsWith(".pbs.twimg.com")) return false;
  return /\.(?:jpe?g|png|webp)(\?|$)/i.test(parsed.pathname);
}

export function normalizeState(value, playbackUrl) {
  const text = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const replay = /(?:^|[?&])type=replay(?:&|$)/i.test(String(playbackUrl || ""));
  if (text === "running" || text === "live" || text === "started" || text === "in_progress") return "live";
  if (text === "replay" || replay) return "replay";
  if (text === "ended" || text === "timed_out" || text === "timedout" || text === "complete") return playbackUrl ? "replay" : "ended";
  return "unknown";
}

function eachUrl(text, fn) {
  const re = /https:\/\/[^\s"'<>\\]+/g;
  let match;
  while ((match = re.exec(String(text || "")))) fn(match[0].replace(/[),.;]+$/, ""));
}

/* Pull a public stream, poster, title and state out of one JSON or HTML
   document. `trusted` is set only for the official oEmbed of this broadcast.
   Other documents must mention the broadcast id or their stream is ignored,
   so a normal video on the same post is not played as the broadcast. */
export function extractFor(data, id, trusted) {
  const bag = { hls: "", kind: "", poster: "", title: "", state: "", width: 0, height: 0 };
  const seen = new Set();
  function considerUrl(value) {
    if (!bag.hls && playbackAllowed(value)) {
      bag.hls = value;
      bag.kind = kindOf(value);
    }
  }
  function walk(node, key, depth) {
    if (node == null || depth > 8) return;
    if (typeof node === "string") {
      if (node.length > 4000) {
        eachUrl(node, considerUrl);
        return;
      }
      considerUrl(node);
      eachUrl(node, considerUrl);
      const name = String(key || "").toLowerCase();
      if (!bag.poster && POSTER_KEYS.has(name) && posterAllowed(node)) bag.poster = node;
      if (!bag.title && TITLE_KEYS.has(name)) bag.title = cleanTitle(node);
      if (!bag.state && STATE_KEYS.has(name)) bag.state = node;
      return;
    }
    if (typeof node === "number" && isFinite(node)) {
      const name = String(key || "").toLowerCase();
      if ((name === "width" || name === "height") && node > 0 && node < 10000 && !bag[name]) bag[name] = Math.round(node);
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      const count = Math.min(node.length, 40);
      for (let i = 0; i < count; i++) walk(node[i], key, depth + 1);
      return;
    }
    const keys = Object.keys(node);
    const count = Math.min(keys.length, 80);
    for (let i = 0; i < count; i++) walk(node[keys[i]], keys[i], depth + 1);
  }
  walk(data, "", 0);
  if (!trusted) {
    let text = "";
    try { text = JSON.stringify(data); } catch (err) { text = ""; }
    if (text.length > 500000) text = text.slice(0, 500000);
    if (!id || text.indexOf(id) < 0) bag.hls = "";
  }
  if (!playbackAllowed(bag.hls)) bag.hls = "";
  bag.kind = bag.hls ? kindOf(bag.hls) : "";
  bag.state = normalizeState(bag.state, bag.hls);
  bag.title = cleanTitle(bag.title);
  if (!posterAllowed(bag.poster)) bag.poster = "";
  return bag;
}

/* A stream already stored on this post, only when that media item is the
   broadcast. A different video on the same post is left alone. */
export function playbackForBroadcast(media, id) {
  const clean = cleanId(id);
  const list = Array.isArray(media) ? media : [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== "object") continue;
    const page = broadcastId([item.url, item.open, item.fallback, item.href].filter(Boolean).join(" "));
    if (item.type !== "broadcast" && page !== clean) continue;
    const found = extractFor(item, clean, true);
    if (found.hls) return found;
  }
  return { hls: "", kind: "", poster: "", title: "", state: "unknown", width: 0, height: 0 };
}

export function present(input) {
  input = input || {};
  const id = cleanId(input.id);
  const hls = playbackAllowed(input.hls) ? String(input.hls) : "";
  const poster = posterAllowed(input.poster) ? String(input.poster) : "";
  const state = normalizeState(input.state, hls);
  const checked = input.checked === true || !!hls;
  let mode = "pending";
  if (hls) mode = "play";
  else if (checked) mode = "fallback";
  const width = Number(input.width) > 0 && Number(input.width) < 10000 ? Math.round(Number(input.width)) : 0;
  const height = Number(input.height) > 0 && Number(input.height) < 10000 ? Math.round(Number(input.height)) : 0;
  return {
    id: id,
    statusId: statusId(input.statusId),
    openUrl: openUrl(id),
    state: state,
    title: cleanTitle(input.title),
    poster: poster,
    hls: hls,
    kind: hls ? (input.kind === "mp4" ? "mp4" : kindOf(hls)) : "",
    width: width,
    height: height,
    mode: mode
  };
}

/* No autoplay on cellular, on a tight connection, or before the card is on
   screen. A tap is a separate path and does not call this. */
export function shouldAutoplay(env) {
  env = env || {};
  if (!env.inView || !env.hasPlayback) return false;
  if (env.setting === "never") return false;
  if (env.saveData || env.reducedMotion || env.reducedData) return false;
  if (env.type === "cellular") return false;
  const eff = String(env.effectiveType || "");
  if (eff === "slow-2g" || eff === "2g" || eff === "3g") return false;
  return true;
}

function badgeLabel(state, tr) {
  if (state === "live") return tr("Live");
  if (state === "replay") return tr("Replay");
  if (state === "ended") return tr("Ended");
  return "";
}

/* The first paint. No iframe, no video element, no autoplay attribute.
   The stream is attached later, after a tap or an allowed in-view start. */
export function cardHtml(model, opts) {
  opts = opts || {};
  const tr = opts.tr || function (key) { return key; };
  const esc = opts.esc || function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  };
  const row = present(model);
  if (!row.id || !row.openUrl) return "";
  const title = row.title || tr("X broadcast");
  const badge = badgeLabel(row.state, tr);
  const badgeHtml = badge ? `<span class="xcast-badge${row.state === "live" ? " is-live" : ""}">${esc(badge)}</span>` : "";
  const poster = row.poster
    ? `<img class="xcast-poster" alt="" width="${row.width || 1280}" height="${row.height || 720}" src="${esc(row.poster)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : "";
  const play = row.mode === "fallback"
    ? ""
    : `<button type="button" class="xcast-go" data-act="xcast-play" aria-label="${esc(tr("Play broadcast"))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg></button>`;
  const watchHidden = row.mode === "fallback" ? "" : " hidden";
  const note = row.mode === "fallback" ? `<span class="xcast-note">${esc(tr("This broadcast plays on X."))}</span>` : "";
  const ratio = row.width && row.height ? ` style="aspect-ratio:${row.width} / ${row.height}"` : "";
  return `<div class="xcast" data-xcast="${esc(row.id)}" data-xcast-status="${esc(row.statusId)}" data-xcast-open="${esc(row.openUrl)}" data-xcast-state="${esc(row.state)}" data-xcast-mode="${esc(row.mode)}" data-xcast-hls="${esc(row.hls)}" data-xcast-kind="${esc(row.kind)}"><div class="xcast-stage"${ratio}>${poster}${badgeHtml}${play}<a class="xcast-watch" data-act="stop" target="_blank" rel="noopener noreferrer" href="${esc(row.openUrl)}"${watchHidden}>${esc(tr("Watch on X"))}</a><p class="xcast-error" hidden><span>${esc(tr("Could not load this broadcast."))}</span> <button type="button" data-act="xcast-retry">${esc(tr("Retry"))}</button></p></div><div class="xcast-copy"><span class="xcast-site">X</span><span class="xcast-title">${esc(title)}</span>${note}</div></div>`;
}

export function stopCard(card) {
  if (!card) return;
  if (card._xcastTimer) { clearTimeout(card._xcastTimer); card._xcastTimer = 0; }
  const hls = card._hls;
  card._hls = null;
  if (hls && hls.destroy) { try { hls.destroy(); } catch (err) { /* already gone */ } }
  const video = card.querySelector ? card.querySelector("video") : null;
  if (video) {
    try { video.pause(); } catch (err) { /* already stopped */ }
    video.removeAttribute("src");
    try { video.load(); } catch (err) { /* not loaded */ }
    video.remove();
  }
  if (card.classList) card.classList.remove("is-playing");
}

/* Attach a public file. Returns "hold" when autoplay is not allowed, so the
   poster stays. A user gesture skips that check. Failure leaves the card
   ready for the Watch on X link. */
export function playCard(card, env) {
  env = env || {};
  if (!card || !card.getAttribute) return "gone";
  const url = String(card.getAttribute("data-xcast-hls") || "");
  if (!playbackAllowed(url)) return "fallback";
  if (!env.userGesture && !shouldAutoplay(env.auto)) return "hold";
  stopCard(card);
  const doc = card.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc || !doc.createElement) return "gone";
  const video = doc.createElement("video");
  video.className = "xcast-video";
  video.playsInline = true;
  video.controls = true;
  video.preload = "none";
  video.muted = true;
  video.defaultMuted = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.setAttribute("referrerpolicy", "no-referrer");
  const stage = card.querySelector(".xcast-stage") || card;
  stage.appendChild(video);
  if (card.classList) card.classList.add("is-playing");
  const kind = card.getAttribute("data-xcast-kind") || kindOf(url);
  function fail() {
    stopCard(card);
    if (env.onFail) env.onFail();
  }
  if (kind === "hls" && !(video.canPlayType && video.canPlayType("application/vnd.apple.mpegurl"))) {
    if (!env.loadHls) { fail(); return "fail"; }
    try { env.loadHls(video, url, fail, function () {
      const pending = video.play && video.play();
      if (pending && pending.catch) pending.catch(function () { fail(); });
    }); } catch (err) { fail(); return "fail"; }
    return "play";
  }
  video.src = url;
  const pending = video.play && video.play();
  if (pending && pending.catch) pending.catch(function () { fail(); });
  return "play";
}

const api = {
  SOURCE_HOSTS: SOURCE_HOSTS,
  BLOCKED_HOSTS: BLOCKED_HOSTS,
  cleanId: cleanId,
  statusId: statusId,
  broadcastId: broadcastId,
  openUrl: openUrl,
  playbackAllowed: playbackAllowed,
  kindOf: kindOf,
  posterAllowed: posterAllowed,
  normalizeState: normalizeState,
  extractFor: extractFor,
  playbackForBroadcast: playbackForBroadcast,
  present: present,
  shouldAutoplay: shouldAutoplay,
  cardHtml: cardHtml,
  stopCard: stopCard,
  playCard: playCard
};

globalThis.ViktorychXBroadcast = api;
