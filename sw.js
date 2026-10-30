/* ViktorychApp service worker. Cache names are viktorych- plus the deploy SHA.
   Older superintel caches are dropped on activate. Offline music stays in sintel-music-offline. */
const VERSION = "viktorych-a267-__SW_VERSION__";
const BUILT = "__SW_BUILT__";
const MIRROR_GITHUB = "__MIRROR_GITHUB__";
const MIRROR_PAGES = "__MIRROR_PAGES__";
// cache-bust: 2026-10-30T17:46:32Z-fogaps3
const ACCOUNTS_WALL = false;
let accountsAuthed = false;
let playToken = "";
let isRuVisitor = false;
importScripts("./shared/mirror.js?" + VERSION, "./storage.js?" + VERSION, "./shared/home-fresh.js?" + VERSION, "./i18n.js?" + VERSION, "./i18n/en.js?" + VERSION, "./i18n/ru.js?" + VERSION, "./i18n/es.js?" + VERSION, "./i18n/hi.js?" + VERSION, "./codec.js?" + VERSION, "./media-opfs.js?" + VERSION, "./notif-privacy.js?" + VERSION);
function tr(key, vars) {
  var fn = (typeof self !== "undefined" && self.t) ? self.t : null;
  return fn ? fn(key, vars) : key;
}
function trn(key, n, vars) {
  var fn = (typeof self !== "undefined" && self.tn) ? self.tn : null;
  return fn ? fn(key, n, vars) : String(n);
}
async function ensureUiLang() {
  try {
    const db = await idb();
    const savedLang = await idbGet(db, "ui-lang");
    if ((savedLang === "en" || savedLang === "ru" || savedLang === "es" || savedLang === "hi") && self.SI18n) self.SI18n.setLang(savedLang);
  } catch (err) { /* English until the page sends a language */ }
}
async function brandManifestResponse(response) {
  await ensureUiLang();
  try {
    const data = await response.clone().json();
    const next = (self.SI18n && self.SI18n.brandManifest) ? self.SI18n.brandManifest(data) : data;
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/manifest+json" } });
  } catch (err) {
    return response;
  }
}
const SHELL = "shell-" + VERSION;
// Saved feeds, media and live parts outlive app updates. Only the shell is
// versioned; these names stay the same so a deploy does not wipe the cache.
const DATA = "data-v1";
const MEDIA = "media-v1";
const LIVE = "live-v1";
const OLD_USER_CACHE = /^(data|media|live)-viktorych-a\d+-/;
const OFFLINE_MUSIC = "sintel-music-offline";
const MEDIA_LIMIT_FULL = 150 * 1024 * 1024;
const MEDIA_LIMIT = /iPhone|iPad|iPod/i.test((typeof navigator !== "undefined" && navigator.userAgent) || "") ? 48 * 1024 * 1024 : MEDIA_LIMIT_FULL;
const MEDIA_TTL = 7 * 24 * 60 * 60 * 1000;
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./customize.css",
  "./dock.css",
  "./dock.js",
  "./desktop-app.js",
  "./keys.js",
  "./keys-ui.js",
  "./keys.css",
  "./i18n.js",
  "./shared/blocklist.js",
  "./i18n/en.js",
  "./i18n/ru.js",
  "./i18n/es.js",
  "./i18n/hi.js",
  "./app.js",
  "./update.js",
  "./storage.js",
  "./storage.css",
  "./localfirst.js",
  "./device-seal.js",
  "./device-data.js",
  "./direct.js",
  "./comments-client.js",
  "./device.js",
  "./device-search.js",
  "./device-ai.js",
  "./ondevice-ai.js",
  "./ondevice-ai-worker.js",
  "./device-media.js",
  "./device-record.js",
  "./logo/v.svg",
  "./logo/affiliation-viktorych.svg",
  "./affiliations.js",
  "./affiliations.css",
  "./logo/v-music.svg",
  "./logo/viktorychapp.svg",
  "./logo/viktorychapp-short.svg",
  "./logo/viktorychmusic.svg",
  "./logo/viktorychmusic-short.svg",
  "./translate.js",
  "./translate.css",
  "./live-translate.js",
  "./live-translate.css",
  "./friend-p2p.js",
  "./people.js",
  "./people.css",
  "./pymk.js",
  "./friends-pref.js",
  "./pymk.css",
  "./tv.js",
  "./tv.css",
  "./tv-tune.js",
  "./tv-tune.css",
  "./shared/tv-boot.js",
  "./shared/short-link.js",
  "./shared/x-range.js",
  "./shared/tv-builder.js",
  "./tv-page.js",
  "./tv-page.css",
  "./tv-pair.js",
  "./tv-pair.css",
  "./vendor/qrcode-1.4.4.js",
  "./send-tv.js",
  "./send-tv.css",
  "./split.js",
  "./discord-ui.js",
  "./discord-picks.js",
  "./discord-ui.css","./inbox.js","./inbox-sms.js","./inbox-sms.css","./inbox-mail.js","./inbox-mail.css",
  "./spaces.js",
  "./spaces.css",
  "./stories.js",
  "./stories.css",
  "./highlights.js",
  "./audience-ui.js",
  "./live.js",
  "./live.css",
  "./marks.js",
  "./logo-text.js",
  "./busy.js",
  "./ytm.js",
  "./music.js",
  "./music.css",
  "./presence.js",
  "./pulse.js",
  "./presence.css",
  "./shared/presence.js",
  "./about-ui.js",
  "./gifts-ui.js",
  "./nft-ui.js",
  "./reactions.js",
  "./community-notes.js",
  "./shared/gift-catalog.js",
  "./shared/store-catalog.js",
  "./badges.js",
  "./badges.css",
  "./shared/local-budget.js",
  "./setting-alerts.js",
  "./setting-alerts.css",
  "./audience-ui.js",
  "./gifts.css",
  "./reactions.css",
  "./community-notes.css",
  "./settings-sync.js",
  "./notif-privacy.js",
  "./shared/birth-date.js",
  "./accounts.js",
  "./locked-follows.js",
  "./passkeys.js",
  "./app-lock.js",
  "./privacy-screen.js",
  "./shared/webauthn.js",
  "./shared/app-lock-crypto.js",
  "./shared/ios.js",
  "./owner-keys.js",
  "./discord-local.js",
  "./discord-local.css",
  "./nzlay-keys.js",
  "./nzlay-forum.js",
  "./nzlay-forum.css",
  "./discord-key-helper.js",
  "./discord-key-helper.css",
  "./accounts.css",
  "./locked-follows.css",
  "./landing.css",
  "./landing/og.jpg",
  "./landing/timeline.webp",
  "./landing/stories.webp",
  "./landing/notes.webp",
  "./landing/highlights.webp",
  "./landing/lists.webp",
  "./landing/live.webp",
  "./landing/store.webp",
  "./landing/birthdays.webp",
  "./landing/details.webp",
  "./landing/sidebar.webp",
  "./landing/status.webp",
  "./landing/badges.webp",
  "./landing/pwa.webp",
  "./landing/safari.webp",
  "./accounts.config.js",
  "./shorts.js",
  "./shorts.css",
  "./drive.js",
  "./drive.css",
  "./settings-registry.js",
  "./local-ai.js",
  "./local-ai-ui.js",
  "./local-ai.css",
  "./local-ai-worker.js",
  "./games.js",
  "./game-social.js",
  "./game-social.css",
  "./games.css",
  "./communities.js",
  "./communities.css",
  "./servers-voice.js",
  "./servers-ui.js",
  "./servers.css",
  "./yt-player.js",
  "./yt-player.css",
  "./scores.js",
  "./scores.css",
  "./weather.js",
  "./weather.css",
  "./shared/drive-crypto.js",
  "./shared/drive-photos.js",
  "./shared/mirror.js",
  "./video-embed.js",
  "./video-providers.js",
  "./mention-suggest.js",
  "./settings-assistant.js",
  "./nostr.js",
  "./mesh-chat.js",
  "./follow-lists.js",
  "./shared/handle-skeleton.js",
  "./shared/reposts.js",
  "./shared/x-compose.js",
  "./x-compose.js",
  "./x-compose.css",
  "./shared/feed-order.js",
  "./shared/for-you.js",
  "./shared/for-you-weights.js",
  "./shared/feed-sources.js",
  "./feeds-page.js",
  "./source-lists.js",
  "./feed-requests.js",
  "./shared/home-fresh.js",
  "./shared/pill-data.js",
  "./shared/tiktok-lock.js",
  "./shared/lazy-modules.js",
  "./favicon.svg",
  "./favicon.ico",
  "./manifest.webmanifest",
  "./offline.html",
  "./native.js",
  "./codec.js",
  "./media-opfs.js",
  "./feed-worker.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon-monochrome-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/music-192.png",
  "./icons/music-512.png",
  "./icons/music-maskable-512.png",
  "./peer-media.js",
  "./shared/peer-media.js",
  "./peer-pool.js",
  "./shared/peer-pool.js",
  "./shared/pool-scheduler.js",
  "./shared/device-performance.js"
];

let updateReporting = false;
let shellTask = null;
let precacheAbort = null;
let precacheGeneration = 0;
let serveNetworkOnce = false;
let peerOn = false;
const armedClients = new Set();
const reloadingClients = new Set();
const PRECACHE_TRIES = 6;
const LAZY_FILES = ["./hls-1.7.3.min.js", "./mpegts-1.8.0.min.js", "./fonts/inter-400.woff2", "./fonts/inter-900.woff2", "./onboarding.js", "./onboarding.css"];

function versionSha(version) {
  const text = String(version || "");
  const prefix = "viktorych-a267-";
  if (text.indexOf(prefix) !== 0) return "";
  const sha = text.slice(prefix.length).trim().toLowerCase();
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : "";
}

function versionBuilt(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text) ? text : "";
}

function versionInfo() {
  return { version: VERSION, sha: versionSha(VERSION), built: versionBuilt(BUILT) };
}

function shellError(path, reason) {
  const err = new Error(reason || "network");
  err.reason = reason || "network";
  err.shellPath = path || "";
  return err;
}

function failureReason(err, status) {
  const name = err && err.name ? String(err.name) : "";
  if (name === "QuotaExceededError") return "quota";
  if (name === "AbortError") return "timeout";
  const code = Number(status) || 0;
  if (code) return "http-" + code;
  return "network";
}

function safeShellPath(value) {
  let text = String(value || "").split("#")[0].split("?")[0].trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) text = new URL(text).pathname;
  } catch (err) {
    return "";
  }
  text = text.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!text || text.indexOf("..") >= 0 || !/^[a-z0-9._/-]{1,160}$/i.test(text)) return "";
  return text;
}

function safeShellReason(value) {
  const text = String(value || "").toLowerCase();
  if (text === "network" || text === "timeout" || text === "quota" || text === "replaced" || text === "newer" || text === "mismatch") return text;
  if (/^http-\d{3}$/.test(text)) return text;
  return "network";
}

function broadcast(msg) {
  self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    clients.forEach((client) => {
      try { client.postMessage(msg); } catch (err) { /* the page may already be closing */ }
    });
  }).catch(() => {});
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // An open app already has a worker. Stay waiting so the page can show
    // the update and download the shell with a real progress count.
    // The first visit has no active worker, so the shell is cached quietly.
    if (self.registration.active) return;
    // The page may prime the same download. A newer attempt must not reject
    // this install; wait for the attempt that is still running.
    let task = precacheShell(false, false);
    for (;;) {
      try {
        await task;
        break;
      } catch (err) {
        if (!err || err.reason !== "replaced" || !shellTask || shellTask === task) throw err;
        task = shellTask;
      }
    }
    if (self.registration.active) return;
    await self.skipWaiting();
  })());
});

let activateBeat = null;
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const reloadClients = updateReporting;
    try {
      if (updateReporting) broadcastProgress({ step: "activate" }, true);
      // Removing old caches can take a while on a full phone; keep the page's
      // stall timer fed until the new shell is in charge.
      const beat = updateReporting ? setInterval(() => broadcastProgress({ step: "activate" }, true), 4000) : null;
      activateBeat = beat;
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== SHELL && key !== DATA && key !== MEDIA && key !== LIVE && key !== OFFLINE_MUSIC && key !== PREFS_CACHE && !OLD_USER_CACHE.test(key)).map((key) => caches.delete(key)));
      try { await forgetLoopCaches(); } catch (err) { /* a stuck loop playlist must not block the new shell */ }
      if (updateReporting) broadcastProgress({ step: "clean" }, true);
    } catch (err) { /* a full disk must not leave the worker stuck activating */ }
    if (activateBeat) { clearInterval(activateBeat); activateBeat = null; }
    // Move what older versions saved into the stable caches in the background.
    adoptOldCaches().catch(() => {});
    purgeOpaquePictures().catch(() => {});
    try { await self.clients.claim(); } catch (err) { /* the page reloads once the worker is active */ }
    try {
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    } catch (err) { /* navigation preload is optional */ }
    const info = versionInfo();
    if (reloadClients) broadcast({ type: "update-ready", version: info.version, sha: info.sha, built: info.built });
    else broadcast({ type: "sw-version", version: info.version, sha: info.sha, built: info.built });
    if (reloadClients) {
      const scope = self.registration.scope;
      setTimeout(() => {
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
          clients.forEach((client) => {
            if (!client || !client.navigate || reloadingClients.has(client.id)) return;
            if (!client.url || client.url.indexOf(scope) !== 0) return;
            client.navigate(client.url).catch(() => {});
          });
        }).catch(() => {});
      }, 2500);
    }
  })());
});

async function adoptOldCaches() {
  const keys = await caches.keys();
  for (const key of keys) {
    const match = OLD_USER_CACHE.exec(key);
    if (!match) continue;
    const target = match[1] === "data" ? DATA : (match[1] === "media" ? MEDIA : LIVE);
    try {
      const from = await caches.open(key);
      const to = await caches.open(target);
      const reqs = await from.keys();
      for (const req of reqs) {
        if (await to.match(req)) continue;
        const res = await from.match(req);
        if (res) await to.put(req, res);
      }
    } catch (err) { /* a full disk keeps what already moved */ }
    await caches.delete(key);
  }
  try {
    const db = await idb();
    const rows = await self.ViktorychStorage.listFiles(db);
    let changed = false;
    rows.forEach((row) => {
      const match = row && OLD_USER_CACHE.exec(row.cacheName || "");
      if (!match) return;
      row.cacheName = match[1] === "data" ? DATA : (match[1] === "media" ? MEDIA : LIVE);
      changed = true;
    });
    if (changed) await self.ViktorychStorage.replaceFiles(db, rows);
  } catch (err) { /* the storage screen re-measures */ }
}

function isArchiveStore(url) {
  return /\/v1\/archive\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/i.test(url.pathname);
}

function isData(url) {
  if (isArchiveStore(url)) return false;
  if (/\/archive\/[^/]+\.json$/.test(url.pathname)) return true;
  // data/music.json is the ViktorychMusic catalog
  if (url.origin === self.location.origin && /\/data\/music\.json$/.test(url.pathname)) return true;
  if (url.origin === self.location.origin && /\/data\/communities\/(?:index|[a-z0-9_]{2,21})\.json$/.test(url.pathname)) return true;
  // one comment page per topic, fetched when a thread opens
  if (url.origin === self.location.origin && /\/data\/communities\/[a-z0-9_]{2,21}\/\d{1,20}\.json$/.test(url.pathname)) return true;
  if (url.origin === self.location.origin && /\/discord\/(?:index|state|messages\/\d{1,22}(?:\/p\/\d{1,4})?|pins\/\d{1,22})\.json$/.test(url.pathname)) return true;
  return url.origin === self.location.origin && /\/(?:feeds|people|suggestions|stories)\.json$/.test(url.pathname);
}

function isMedia(url) {
  const host = url.hostname;
  return /(^|\.)pbs\.twimg\.com$/.test(host) || /(^|\.)video\.twimg\.com$/.test(host) || host === "i.ytimg.com" || /(^|\.)ggpht\.com$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host) || /(^|\.)cdninstagram\.com$/.test(host) || /(^|\.)fbcdn\.net$/.test(host);
}

const SPACE_HOSTS = ["pub-bf9b5e3ebb2b421aa49e7af484f3c22d.r2.dev", "r2.dev", "trycloudflare.com"];

function spaceHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  for (let i = 0; i < SPACE_HOSTS.length; i++) {
    const rule = SPACE_HOSTS[i];
    if (!rule) continue;
    if (host === rule || host.endsWith("." + rule)) return true;
  }
  return false;
}

function isSpaceStatus(url) {
  return url.origin === self.location.origin && /\/live\/[^/]+\.json$/.test(url.pathname);
}

function isSpaceAsset(url) {
  return spaceHost(url.hostname);
}

// loop/current.json is the version pointer. Never cache it: a stored copy keeps
// a deleted loop version after the publisher swaps the bed.
function isLoopPointer(url) {
  return spaceHost(url.hostname) && /\/loop\/current\.json$/i.test(url.pathname);
}

// Versioned playlists and segments are immutable on R2 (a year of cache).
// Do not keep them in Cache Storage, or a deleted version 404s forever.
function isLoopVersionMedia(url) {
  return spaceHost(url.hostname) && /\/loop\/v[^/]+\//i.test(url.pathname);
}

async function forgetLoopCaches() {
  const names = await caches.keys();
  await Promise.all(names.map(async (name) => {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    await Promise.all(keys.map((req) => {
      let parsed;
      try { parsed = new URL(req.url); } catch (err) { return null; }
      if (isLoopPointer(parsed) || isLoopVersionMedia(parsed)) return cache.delete(req);
      return null;
    }));
  }));
}

async function fetchLoopPointer(request) {
  const url = new URL(request.url);
  url.searchParams.set("_", String(Date.now()));
  const mode = request.mode === "navigate" ? "cors" : request.mode;
  try {
    return await fetch(new Request(url.href, {
      method: "GET",
      headers: request.headers,
      mode: mode,
      credentials: "omit",
      cache: "no-store",
      redirect: "follow"
    }));
  } catch (err) {
    return fetch(url.href, { cache: "no-store", redirect: "follow" });
  }
}

// ViktorychMusic catalog audio (HLS playlist, key, init, segments, cover) is not
// handled here. The page streams it directly and, only after Download, stores
// an offline copy in sintel-music-offline. That cache is not this worker's.
function isCatalogMedia(url) {
  return spaceHost(url.hostname) && url.pathname.toLowerCase().indexOf("/music/") !== -1;
}

function isAppJson(url) {
  if (url.origin !== self.location.origin) return false;
  return /\/(?:feeds\.config|status)\.json$/.test(url.pathname) || /\/fallback\/[^/]+\.json$/.test(url.pathname);
}

function isOwnerTiktok(url) {
  return url.origin === self.location.origin && /\/owner\/tiktok\.json$/.test(url.pathname);
}

function isOwnerPlay(url) {
  return /\/v1\/owner\/play$/.test(url.pathname) && url.searchParams.has("id");
}

function isTikTokCdn(url) {
  const host = String(url.hostname || "").toLowerCase();
  return /(^|\.)tiktokcdn(?:-us|-eu)?\.com$/.test(host) || /(^|\.)bytefcdn(?:-oversea)?\.com$/.test(host) || /(^|\.)tiktokv\.com$/.test(host);
}

function isOwnedTelegram(url) {
  return /\/tg\//.test(url.pathname) && !/\/tg\/loop\//.test(url.pathname);
}

function isAccountMedia(url) {
  return /\/v1\/media\/(?:avatars|banners)\/\d{12}\/[a-f0-9]{64}\.(?:webp|jpg|png)$/.test(url.pathname) || /\/v1\/media\/view\/[a-f0-9]{32}$/.test(url.pathname);
}

function privateData(url) {
  return isData(url) || isAppJson(url) || isMedia(url) || isLive(url) || isCommentApi(url) || isSpaceStatus(url) || isSpaceAsset(url) || isCatalogMedia(url) || isOwnerTiktok(url);
}

function isLive(url) {
  const host = url.hostname;
  return host === "api.fxtwitter.com" || host === "api.invidious.io" || /(^|\.)invidious\./.test(host) || /piped/i.test(host) || host === "inv.nadeko.net" || host === "yt.artemislena.eu" || host === "invidious.nerdvpn.de" || host === "invidious.f5.si";
}

function isCommentApi(url) {
  const path = url.pathname || "";
  if (url.hostname === "api.fxtwitter.com" && /\/(conversation|status)\//.test(path)) return true;
  if (/\/comments(?:\/|$)/.test(path) || /\/api\/v1\/post\/[^/]+\/comments/.test(path)) return true;
  return url.origin === self.location.origin && /\/comments\/[^/]+\.json$/.test(path);
}

function idb() {
  return self.ViktorychStorage.openDb();
}

function idbGet(db, key) {
  return new Promise((resolve) => {
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function rememberMedia(url, bytes, category, cacheName) {
  const db = await idb();
  const prev = await self.ViktorychStorage.getFile(db, url);
  const now = Date.now();
  const cat = category || (prev && prev.category) || self.ViktorychStorage.categoryOf(url) || "other";
  if (!cat) return;
  await self.ViktorychStorage.putFile(db, {
    url: url,
    bytes: bytes || (prev && prev.bytes) || 0,
    category: cat,
    at: now,
    saved: (prev && prev.saved) || now,
    cacheName: cacheName || (prev && prev.cacheName) || MEDIA
  });
}

async function trimMedia(unusedCache, capBytes) {
  const db = await idb();
  const saved = await self.ViktorychStorage.readPolicy(db);
  const policyMax = saved.unlimited ? Infinity : (saved.maxBytes || MEDIA_LIMIT);
  const cap = Number(capBytes);
  const max = cap > 0 ? Math.min(policyMax, cap) : policyMax;
  let rows = await self.ViktorychStorage.listFiles(db);
  if (!rows.length) {
    const old = (await idbGet(db, "media-index")) || [];
    rows = old.filter((row) => row && row.url).map((row) => ({
      url: row.url,
      bytes: row.bytes || 0,
      category: self.ViktorychStorage.categoryOf(row.url) || "other",
      at: row.at || Date.now(),
      saved: row.at || Date.now(),
      cacheName: MEDIA
    }));
  }
  const plan = self.ViktorychStorage.planEviction(rows, max, Date.now(), self.ViktorychStorage.keepMs(saved.keep));
  await Promise.all(plan.drop.map(async (row) => {
    try {
      if ((row.cacheName || "") === "idb-docs") {
        await self.ViktorychStorage.deleteDoc(db, row.url);
        return;
      }
      if (row.cacheName === "opfs" && self.ViktorychOpfs) {
        await self.ViktorychOpfs.remove(row.url);
        return;
      }
      const cache = await caches.open(row.cacheName || MEDIA);
      await cache.delete(row.url);
    } catch (err) { /* a missing cache is already gone */ }
  }));
  await self.ViktorychStorage.replaceFiles(db, plan.keep);
  await idbSet(db, "media-index", []);
}

function mirrorApi() {
  return (typeof self !== "undefined" && self.ViktorychMirror) ? self.ViktorychMirror : null;
}

function mirrorRelative(url) {
  const api = mirrorApi();
  if (!api || !api.mirrorHost(self.location.hostname)) return "";
  if (!url || url.origin !== self.location.origin) return "";
  const rel = api.relativeTo(self.registration.scope, url.href);
  if (!rel || /^(?:v1\/|tg\/|ap\/|\.well-known\/)/.test(rel)) return "";
  return rel;
}

function mirrorBases() {
  const api = mirrorApi();
  if (!api) return [];
  const here = api.normalizeBase(self.registration.scope);
  return api.bases(here, MIRROR_GITHUB, MIRROR_PAGES).filter((base) => base !== here);
}

async function mirrorAlternate(url, signal) {
  const api = mirrorApi();
  const rel = mirrorRelative(url);
  if (!api || !rel) return null;
  const bases = mirrorBases();
  for (let i = 0; i < bases.length; i++) {
    const next = api.rewrite(bases[i], rel);
    if (!next) continue;
    // A dead mirror must not pin the shell download. The caller's signal
    // (the per-file timer) aborts this too.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 5000);
    const onAbort = () => timeout.abort();
    if (signal) {
      if (signal.aborted) timeout.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      if (timeout.signal.aborted) continue;
      const res = await fetch(next, { method: "GET", mode: "cors", credentials: "omit", cache: "no-store", redirect: "follow", signal: timeout.signal });
      if (res && res.ok && res.type !== "opaque") return res;
    } catch (err) { /* the next origin can still have the file */ }
    finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  return null;
}

// When the first origin is silent for this long, the other copy of the
// same file starts too (DPI throttling stalls instead of failing).
const MIRROR_HEDGE_MS = 4000;

async function mirrorFetch(request, init) {
  const api0 = mirrorApi();
  let hedgeUrl = null;
  if (api0 && request && request.method === "GET" && !(request.headers && request.headers.get("range"))) {
    try { hedgeUrl = new URL(request.url); } catch (err) { hedgeUrl = null; }
    if (hedgeUrl && !mirrorRelative(hedgeUrl)) hedgeUrl = null;
  }
  if (hedgeUrl) return mirrorHedged(request, init, hedgeUrl);
  return mirrorFetchPlain(request, init);
}

function mirrorHedged(request, init, url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let primaryDone = false;
    let altStarted = false;
    let altDone = false;
    let primaryRes = null;
    let primaryErr = null;
    const finishFallback = () => {
      if (settled || !primaryDone || (altStarted && !altDone)) return;
      settled = true;
      if (primaryRes) resolve(primaryRes);
      else reject(primaryErr || new Error("mirror"));
    };
    const startAlt = () => {
      if (altStarted || settled) return;
      altStarted = true;
      mirrorAlternate(url, request && request.signal).then((alt) => {
        altDone = true;
        if (settled) return;
        if (alt) { settled = true; resolve(alt); return; }
        finishFallback();
      }, () => { altDone = true; finishFallback(); });
    };
    const timer = setTimeout(startAlt, MIRROR_HEDGE_MS);
    const api = mirrorApi();
    (init ? fetch(request, init) : fetch(request)).then((res) => {
      primaryDone = true;
      clearTimeout(timer);
      if (settled) return;
      if (res && !api.failoverStatus(res.status)) { settled = true; resolve(res); return; }
      primaryRes = res;
      startAlt();
      finishFallback();
    }, (err) => {
      primaryDone = true;
      clearTimeout(timer);
      if (settled) return;
      if (err && err.name === "AbortError" && !altStarted) { settled = true; reject(err); return; }
      primaryErr = new Error("mirror");
      startAlt();
      finishFallback();
    });
  });
}

async function mirrorFetchPlain(request, init) {
  let res = null;
  let failed = false;
  try {
    res = init ? await fetch(request, init) : await fetch(request);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    failed = true;
  }
  const api = mirrorApi();
  const status = failed || !res ? 0 : res.status;
  if (api && request && request.method === "GET" && api.failoverStatus(status)) {
    let url = null;
    try { url = new URL(request.url); } catch (err) { url = null; }
    const alt = url ? await mirrorAlternate(url, request && request.signal) : null;
    if (alt) return alt;
  }
  if (failed) throw new Error("mirror");
  return res;
}

async function wipeUserCaches(full) {
  await caches.delete(DATA);
  await caches.delete(MEDIA);
  await caches.delete(LIVE);
  try { if (self.ViktorychOpfs) await self.ViktorychOpfs.clear(); } catch (err) { /* Cache Storage was already cleared */ }
  if (full) {
    try { await caches.delete(OFFLINE_MUSIC); } catch (err) { /* music downloads are already gone */ }
  }
  try {
    const db = await idb();
    await self.ViktorychStorage.replaceFiles(db, []);
    await self.ViktorychStorage.clearDocs(db, "all");
    await idbSet(db, "media-index", []);
  } catch (err) { /* the page clears the same stores */ }
}

async function putPacked(cache, request, response) {
  const codec = self.ViktorychCodec;
  if (!codec || !codec.supported()) {
    await cache.put(request, response.clone());
    return;
  }
  const type = (response.headers.get("content-type") || "").toLowerCase();
  if (type.indexOf("json") < 0 && type.indexOf("text") < 0 && type.indexOf("javascript") < 0) {
    await cache.put(request, response.clone());
    return;
  }
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  if (bytes.byteLength < 4096) {
    await cache.put(request, new Response(bytes, { status: response.status, headers: response.headers }));
    return;
  }
  const packed = await codec.gzip(bytes);
  if (!packed || packed.byteLength >= bytes.byteLength) {
    await cache.put(request, new Response(bytes, { status: response.status, headers: response.headers }));
    return;
  }
  const headers = new Headers(response.headers);
  headers.set("x-vapp-gzip", "1");
  headers.delete("content-length");
  headers.delete("content-encoding");
  await cache.put(request, new Response(packed, { status: response.status, headers: headers }));
}

async function readPacked(response) {
  if (!response || response.headers.get("x-vapp-gzip") !== "1") return response;
  const codec = self.ViktorychCodec;
  if (!codec || !codec.supported()) return response;
  const packed = new Uint8Array(await response.arrayBuffer());
  const plain = await codec.gunzip(packed);
  if (!plain) return response;
  const headers = new Headers(response.headers);
  headers.delete("x-vapp-gzip");
  headers.delete("content-length");
  return new Response(plain, { status: response.status, statusText: response.statusText, headers: headers });
}

async function staleWhileRevalidate(request, extraHeaders) {
  if (self.ViktorychStorage.categoryOf(request.url) === "") return fetch(request);
  const cache = await caches.open(DATA);
  const cacheReq = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheReq);
  const headers = new Headers(extraHeaders || undefined);
  if (cached) {
    const etag = cached.headers.get("etag");
    const lastMod = cached.headers.get("last-modified");
    if (etag) headers.set("If-None-Match", etag);
    else if (lastMod) headers.set("If-Modified-Since", lastMod);
  }
  const update = (async () => {
    const db = await idb();
    try {
      const res = await mirrorFetch(new Request(request.url, { method: "GET", headers: headers, cache: "no-store", redirect: "follow" }));
      const action = self.ViktorychStorage.revalidateAction(res && res.status);
      if (action === "keep" && cached) {
        await self.ViktorychStorage.touch(db, request.url);
        broadcast({ type: "storage-online" });
        return readPacked(cached);
      }
      if (action === "store") await self.ViktorychStorage.bump(db, "network");
      if (action === "store" && self.ViktorychStorage.shouldCacheFeed(request.url)) {
        await putPacked(cache, cacheReq, res);
        await rememberMedia(request.url, self.ViktorychStorage.byteLengthOf(res), self.ViktorychStorage.categoryOf(request.url), DATA);
        await trimMedia();
        broadcast({ type: "storage-online" });
      }
      return res;
    } catch (err) {
      if (cached) broadcast({ type: "storage-offline" });
      return null;
    }
  })();
  if (cached) {
    const db = await idb();
    await self.ViktorychStorage.bump(db, "hits");
    await self.ViktorychStorage.bump(db, "savedRequests");
    await self.ViktorychStorage.bump(db, "savedBytes", self.ViktorychStorage.byteLengthOf(cached));
    await self.ViktorychStorage.touch(db, request.url);
    update.then((res) => {
      if (!res || res === cached) return;
      self.clients.matchAll({ type: "window" }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "data", url: request.url }));
      });
    });
    return readPacked(cached);
  }
  const res = await update;
  return res || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function peerMediaUrl(value) {
  let path = "";
  try { path = new URL(value).pathname; }
  catch (err) { return false; }
  if (/\/loop\//i.test(path)) return false;
  return /\.(m4s|ts|cmfv|cmfa|mp4|webm|m4v)$/i.test(path);
}

async function askPeer(request) {
  if (!peerOn || !peerMediaUrl(request.url)) return null;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = clients && clients[0];
  if (!client) return null;
  const channel = new MessageChannel();
  let settled = false;
  const answer = new Promise((resolve) => {
    channel.port1.onmessage = (event) => {
      if (settled) return;
      settled = true;
      resolve(event.data || null);
    };
  });
  const timer = new Promise((resolve) => setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve(null);
  }, 700));
  try {
    client.postMessage({ type: "peer-fetch", url: request.url, range: request.headers.get("Range") || "" }, [channel.port2]);
  } catch (err) {
    return null;
  }
  return Promise.race([answer, timer]);
}

function peerBody(asked) {
  const bytes = asked && asked.bytes;
  if (!bytes) return null;
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return null;
}

function peerResponseFrom(asked, request) {
  const body = peerBody(asked);
  if (!body) return null;
  const size = body.byteLength || 0;
  if (!size) return null;
  const range = request.headers.get("Range") || "";
  const headers = {
    "Content-Type": asked.type || contentTypeFor(request.url),
    "Content-Length": String(size),
    "Cache-Control": "private",
    "Accept-Ranges": "bytes",
    "X-Viktorych-Peer": "1"
  };
  if (range && asked.status === 206) {
    const match = /^bytes=(\d+)-(\d+)$/i.exec(range.trim());
    if (match) headers["Content-Range"] = "bytes " + match[1] + "-" + match[2] + "/" + String(asked.total || size);
    return new Response(body, { status: 206, headers: headers });
  }
  return new Response(body, { status: 200, headers: headers });
}

function contentTypeFor(url) {
  const path = String(url || "").split("?")[0].toLowerCase();
  if (path.endsWith(".m4s") || path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".ts")) return "video/mp2t";
  return "application/octet-stream";
}

async function rememberPeer(request, response) {
  try {
    const cache = await caches.open(MEDIA);
    const range = request.headers.get("Range") || "";
    if (!range) {
      await cache.put(new Request(request.url, { method: "GET" }), response.clone());
      await rememberMedia(request.url, self.ViktorychStorage.byteLengthOf(response), self.ViktorychStorage.categoryOf(request.url), MEDIA);
      return;
    }
    const key = self.ViktorychStorage.rangeCacheUrl(request.url, range);
    if (!key || !self.ViktorychStorage.cacheableRange(range, response.headers.get("content-length"))) return;
    await cache.put(new Request(key, { method: "GET" }), response.clone());
    await rememberMedia(key, self.ViktorychStorage.byteLengthOf(response), self.ViktorychStorage.categoryOf(request.url), MEDIA);
  } catch (err) { /* a peer hit still plays */ }
}

async function fetchMediaOrigin(request, headers, authed) {
  const mirror = self.ViktorychMirror;
  const once = async () => {
    if (isRuVisitor && !authed) {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 2000);
      try { return corsPictureHost(request) ? await fetchPicture(request, ctrl.signal) : await fetch(request, { signal: ctrl.signal }); }
      finally { clearTimeout(tid); }
    }
    if (authed) return fetch(request.url, { method: "GET", headers: headers, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" });
    if (corsPictureHost(request)) return fetchPicture(request);
    return fetch(request);
  };
  let attempt = 0;
  while (true) {
    try {
      const res = await once();
      if (isRuVisitor || !mirror || !mirror.retryableStatus || !mirror.retryableStatus(res && res.status)) return res;
      try { if (res.body && res.body.cancel) res.body.cancel(); } catch (err) { /* the next try replaces it */ }
      const delayMs = mirror.retryDelay(attempt, Math.random());
      if (delayMs < 0) return res;
      attempt += 1;
      await wait(delayMs);
    } catch (err) {
      if (isRuVisitor || !mirror || !mirror.retryDelay) throw err;
      const delayMs = mirror.retryDelay(attempt, Math.random());
      if (delayMs < 0) throw err;
      attempt += 1;
      await wait(delayMs);
    }
  }
}

function teachOrigin(request, response) {
  const len = Number(response.headers.get("content-length")) || 0;
  if (!len || len > 8 * 1024 * 1024) return;
  response.clone().arrayBuffer().then((buf) => {
    if (!buf || buf.byteLength > 8 * 1024 * 1024) return;
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      if (!clients || !clients.length) return;
      const payload = { type: "peer-learned", url: request.url, range: request.headers.get("Range") || "", bytes: buf };
      try { clients[0].postMessage(payload); }
      catch (err) { /* origin playback already has the bytes */ }
    });
  }).catch(() => {});
}

/* X's picture host answers 403 to any request that carries a referrer from
   another site, and an opaque (no-cors) answer hides that status, so a 403
   used to be stored as if it were the picture. Pictures from that host are
   asked for in CORS mode without a referrer: the status is visible and only
   real pictures are stored. Original bytes, never re-encoded. */
function corsPictureHost(request) {
  try {
    const url = new URL(request.url);
    return url.hostname === "pbs.twimg.com" && request.method === "GET" && !request.headers.get("Range");
  } catch (err) {
    return false;
  }
}

async function fetchPicture(request, signal) {
  const init = { method: "GET", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow" };
  if (signal) init.signal = signal;
  try {
    return await fetch(request.url, init);
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return fetch(request);
  }
}

async function dropMediaCopy(url) {
  const cache = await caches.open(MEDIA);
  await cache.delete(new Request(url, { method: "GET" }));
  const opfs = self.ViktorychOpfs;
  if (opfs && opfs.supported && opfs.supported() && opfs.remove) {
    try { await opfs.remove(url); } catch (err) { /* Cache Storage was the usual home */ }
  }
}

/* Opaque copies from X's picture host may be stored 403s from older
   versions. They are dropped once on activate; real pictures come back on
   the next view. */
async function purgeOpaquePictures() {
  const cache = await caches.open(MEDIA);
  const keys = await cache.keys();
  for (const req of keys) {
    let host = "";
    try { host = new URL(req.url).hostname; } catch (err) { continue; }
    if (host !== "pbs.twimg.com") continue;
    const res = await cache.match(req);
    if (!res || res.type === "opaque" || !res.ok) await cache.delete(req);
  }
}

async function serveMedia(request, extraHeaders) {
  const parsed = new URL(request.url);
  const headers = new Headers(extraHeaders || undefined);
  const rangeHeader = request.headers.get("Range");
  if (!self.ViktorychStorage.shouldCacheMedia(parsed)) {
    if (rangeHeader) headers.set("Range", rangeHeader);
    if ([...headers.keys()].length) return fetch(request.url, { method: "GET", headers: headers, cache: "no-store", redirect: "follow", referrerPolicy: "no-referrer" });
    return fetch(request);
  }
  const opfs = self.ViktorychOpfs;
  if (opfs && opfs.supported()) {
    try {
      const hit = await opfs.open(request.url, rangeHeader);
      if (hit) {
        const dbHit = await idb();
        await self.ViktorychStorage.bump(dbHit, "hits");
        await self.ViktorychStorage.bump(dbHit, "savedRequests");
        await self.ViktorychStorage.touch(dbHit, request.url);
        return hit;
      }
    } catch (err) { /* Cache Storage is the fallback */ }
  }
  const asked = await askPeer(request);
  if (asked && asked.bytes && !asked.skip) {
    const peerHit = peerResponseFrom(asked, request);
    if (peerHit) {
      const dbPeer = await idb();
      if (!asked.counted) await self.ViktorychStorage.bump(dbPeer, "peerBytes", peerHit.headers.get("content-length"));
      await rememberPeer(request, peerHit.clone());
      return peerHit;
    }
  }
  const countOrigin = !!(asked && asked.miss && !asked.skip);
  const cache = await caches.open(MEDIA);
  const fullReq = new Request(request.url, { method: "GET" });
  const db = await idb();
  if (rangeHeader && self.ViktorychStorage.rangeCacheUrl) {
    const rangeKey = self.ViktorychStorage.rangeCacheUrl(request.url, rangeHeader);
    if (rangeKey) {
      const ranged = await cache.match(new Request(rangeKey, { method: "GET" }));
      if (ranged) {
        await self.ViktorychStorage.bump(db, "hits");
        await self.ViktorychStorage.bump(db, "savedRequests");
        await self.ViktorychStorage.bump(db, "savedBytes", self.ViktorychStorage.byteLengthOf(ranged));
        return ranged;
      }
    }
  }
  let cached = await cache.match(fullReq);
  const saved = await self.ViktorychStorage.readPolicy(db);
  if (cached) {
    const row = await self.ViktorychStorage.getFile(db, request.url);
    if (row && !self.ViktorychStorage.mediaFresh(row, saved, Date.now())) {
      await cache.delete(fullReq);
      cached = null;
    }
  }
  if (cached && !rangeHeader) {
    await self.ViktorychStorage.bump(db, "hits");
    await self.ViktorychStorage.bump(db, "savedRequests");
    await self.ViktorychStorage.bump(db, "savedBytes", self.ViktorychStorage.byteLengthOf(cached));
    await self.ViktorychStorage.touch(db, request.url);
    return cached;
  }
  if (cached && rangeHeader) {
    const partial = await self.ViktorychStorage.sliceCached(cached, rangeHeader);
    if (partial) {
      await self.ViktorychStorage.bump(db, "hits");
      await self.ViktorychStorage.bump(db, "savedRequests");
      await self.ViktorychStorage.bump(db, "savedBytes", self.ViktorychStorage.byteLengthOf(cached));
      await self.ViktorychStorage.touch(db, request.url);
      return partial;
    }
  }
  await self.ViktorychStorage.bump(db, "network");
  try {
    const authed = headers.has("Authorization");
    if (authed && rangeHeader) headers.set("Range", rangeHeader);
    const res = await fetchMediaOrigin(request, headers, authed);
    const store = res && ((res.type === "opaque" && !corsPictureHost(request)) || self.ViktorychStorage.revalidateAction(res.status) === "store");
    if (store && !rangeHeader) {
      let inOpfs = false;
      const length = self.ViktorychStorage.byteLengthOf(res);
      if (opfs && opfs.supported() && res.type !== "opaque" && length >= opfs.LARGE) {
        try { inOpfs = await opfs.put(request.url, await res.clone().blob()); }
        catch (err) { inOpfs = false; }
      }
      if (!inOpfs) await cache.put(fullReq, res.clone());
      await rememberMedia(request.url, length, self.ViktorychStorage.categoryOf(request.url), inOpfs ? "opfs" : MEDIA);
      await trimMedia();
    }
    if (res && res.status === 206 && rangeHeader && self.ViktorychStorage.cacheableRange(rangeHeader, res.headers.get("content-length"))) {
      const rangeKey = self.ViktorychStorage.rangeCacheUrl(request.url, rangeHeader);
      if (rangeKey) {
        await cache.put(new Request(rangeKey, { method: "GET" }), res.clone());
        await rememberMedia(rangeKey, self.ViktorychStorage.byteLengthOf(res), self.ViktorychStorage.categoryOf(request.url), MEDIA);
      }
    }
    if (countOrigin && res && (res.ok || res.status === 206)) {
      await self.ViktorychStorage.bump(db, "originBytes", self.ViktorychStorage.byteLengthOf(res));
      if (peerOn) teachOrigin(request, res);
    }
    if (res) broadcast({ type: "storage-online" });
    return res;
  } catch (err) {
    if (cached) {
      broadcast({ type: "storage-offline" });
      if (rangeHeader) {
        const partial = await self.ViktorychStorage.sliceCached(cached, rangeHeader);
        if (partial) return partial;
      }
      return cached;
    }
    return isRuVisitor ? new Response("", { status: 504 }) : Response.error();
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await mirrorFetch(request);
    if (res && res.ok) {
      if (cacheName === DATA) await putPacked(cache, request, res);
      else cache.put(request, res.clone());
      if (cacheName === DATA) {
        try { await rememberMedia(request.url, self.ViktorychStorage.byteLengthOf(res), self.ViktorychStorage.categoryOf(request.url), DATA); } catch (err) { /* the response still returns */ }
      }
    }
    return res;
  } catch (err) {
    const cached = await readPacked(await cache.match(request));
    if (cached) return cached;
    throw err;
  }
}

async function networkFirstTimeout(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 6000);
  try {
    const res = await fetch(new Request(request, { cache: "no-store", signal: controller.signal }));
    clearTimeout(timer);
    if (res && res.ok) {
      await putPacked(cache, request, res);
      return res;
    }
    const alt = await mirrorAlternate(new URL(request.url), controller.signal);
    if (alt && alt.ok) {
      try { await putPacked(cache, request, alt); } catch (putErr) { /* the response is still usable */ }
      return alt;
    }
    const cached = await readPacked(await cache.match(request));
    return cached || res;
  } catch (err) {
    clearTimeout(timer);
    const alt = await mirrorAlternate(new URL(request.url));
    if (alt && alt.ok) {
      try { await putPacked(cache, request, alt); } catch (putErr) { /* the response is still usable */ }
      return alt;
    }
    const cached = await readPacked(await cache.match(request));
    if (cached) return cached;
    return new Response("", { status: 504 });
  }
}

async function cacheBookmark(urls) {
  const cache = await caches.open(MEDIA);
  for (const url of urls || []) {
    if (!url || !/^https:/.test(url)) continue;
    try {
      // A readable copy can also go to friends' devices; opaque is the fallback.
      const readable = url.startsWith(self.location.origin + "/") || /^https:\/\/(?:[a-z0-9-]+\.)*(?:twimg\.com|r2\.dev|workers\.dev)\//i.test(url);
      const res = readable ? await fetch(url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" }).catch(() => fetch(url, { mode: "no-cors", referrerPolicy: "no-referrer" })) : await fetch(url, { mode: "no-cors", referrerPolicy: "no-referrer" });
      if (res && (res.ok || res.type === "opaque")) {
        await cache.put(url, res.clone());
        await rememberMedia(url, Number(res.headers.get("content-length")) || 200 * 1024);
      }
    } catch (err) { /* a missed image still leaves the saved post text */ }
  }
  await trimMedia(cache);
}

/* Original bytes a friend's device sent for a URL this page asked about. */
async function cacheFriendCopy(url, blob) {
  try {
    const cache = await caches.open(MEDIA);
    if (await cache.match(url)) return;
    const headers = { "content-length": String(blob.size) };
    if (blob.type) headers["content-type"] = blob.type;
    await cache.put(url, new Response(blob, { status: 200, headers: headers }));
    await rememberMedia(url, blob.size);
    await trimMedia(cache);
  } catch (err) { /* the normal fetch still works */ }
}

let lastReportAt = 0;
let progressState = { files: 0, totalFiles: SHELL_FILES.length, bytes: 0, totalBytes: 0 };

function shellOptional(path) {
  return /\.(?:png|ico|svg)$/i.test(String(path || ""));
}

function broadcastProgress(extra, force) {
  const now = Date.now();
  if (!force && now - lastReportAt < 80) return;
  lastReportAt = now;
  const msg = {
    type: "update-progress",
    step: (extra && extra.step) || "download",
    files: extra && typeof extra.files === "number" ? extra.files : progressState.files,
    totalFiles: extra && typeof extra.totalFiles === "number" ? extra.totalFiles : progressState.totalFiles,
    bytes: extra && typeof extra.bytes === "number" ? extra.bytes : progressState.bytes,
    totalBytes: extra && typeof extra.totalBytes === "number" ? extra.totalBytes : progressState.totalBytes
  };
  progressState = { files: msg.files, totalFiles: msg.totalFiles, bytes: msg.bytes, totalBytes: msg.totalBytes };
  broadcast(msg);
}

async function readCounted(res, onChunk) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  const chunks = [];
  let size = 0;
  if (!reader) {
    const buf = await res.arrayBuffer();
    size = buf.byteLength;
    chunks.push(new Uint8Array(buf));
    if (onChunk) onChunk(size);
    return { chunks: chunks, size: size };
  }
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    if (!step.value) continue;
    chunks.push(step.value);
    size += step.value.byteLength;
    if (onChunk) onChunk(step.value.byteLength);
  }
  return { chunks: chunks, size: size };
}

function retryableStatus(status) {
  const code = Number(status) || 0;
  if (code === 404 || code === 408 || code === 429) return true;
  if (!code || code >= 500) return true;
  return false;
}

function precacheDelay(attempt) {
  // 0.5s, 1s, 2s, 4s, 8s: long enough for a CDN edge that still serves the
  // previous deploy (a 404 or an old copy) to catch up.
  if (attempt <= 0) return 0;
  return Math.min(8000, 500 * (2 ** (attempt - 1)));
}

function precacheShell(report, fresh) {
  // The first visit and a prime share one download. Retry starts a new one
  // and drops a download that already failed or is still hanging.
  if (!fresh && shellTask) return shellTask;
  if (precacheAbort) {
    try { precacheAbort.abort("replaced"); } catch (err) { /* the previous attempt already stopped */ }
  }
  const controller = new AbortController();
  precacheAbort = controller;
  const generation = ++precacheGeneration;
  const task = doPrecache(report, generation, controller.signal).finally(() => {
    if (shellTask === task) shellTask = null;
  });
  task.generation = generation;
  shellTask = task;
  return task;
}

/* A big file on a slow phone link can take minutes, so a download only
   fails when no bytes arrive for a while (or past a generous cap), never on
   a fixed clock. */
const SHELL_STALL_MS = 20000;
const SHELL_FILE_CAP_MS = 240000;
function stallWatch(signal) {
  const ctl = new AbortController();
  let timer = 0;
  let why = "";
  const stop = (reason) => {
    if (why) return;
    why = reason;
    try { ctl.abort(reason); } catch (err) { /* already stopped */ }
  };
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop("timeout"), SHELL_STALL_MS);
  };
  const cap = setTimeout(() => stop("timeout"), SHELL_FILE_CAP_MS);
  const onAbort = () => stop("replaced");
  if (signal) {
    if (signal.aborted) stop("replaced");
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  touch();
  return {
    signal: ctl.signal,
    touch: touch,
    reason: () => why,
    done: () => {
      clearTimeout(timer);
      clearTimeout(cap);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  };
}

function shellUrl(path) {
  const sha = versionSha(VERSION) || "0";
  const join = String(path).indexOf("?") >= 0 ? "&" : "?";
  return path + join + "sw=" + encodeURIComponent(sha);
}

async function fetchShellFile(path, watch) {
  try {
    const request = new Request(shellUrl(path), { cache: "no-store", signal: watch.signal });
    return await mirrorFetch(request);
  } catch (err) {
    if (watch.reason()) throw shellError(path, watch.reason());
    throw shellError(path, failureReason(err, 0));
  }
}

async function sha256Hex(chunks) {
  if (!crypto.subtle || !chunks || !chunks.length) return "";
  let size = 0;
  chunks.forEach((chunk) => { size += chunk.byteLength || 0; });
  const all = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    all.set(chunk, offset);
    offset += chunk.byteLength || 0;
  });
  const digest = await crypto.subtle.digest("SHA-256", all);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* The deploy writes shell-manifest.json last: the commit it belongs to, when
   it was built, and a SHA-256 and size per shell file. It pins a download to
   one deploy and lets unchanged files come from the cache already here. */
function isoTime(value) {
  const t = Date.parse(String(value || ""));
  return Number.isFinite(t) ? t : 0;
}

function readManifestDoc(doc) {
  if (!doc || typeof doc !== "object" || !doc.files || typeof doc.files !== "object") return null;
  const files = {};
  Object.keys(doc.files).forEach((path) => {
    const row = doc.files[path];
    const hash = Array.isArray(row) ? String(row[0] || "") : "";
    if (/^[a-f0-9]{64}$/.test(hash)) files[path] = { hash: hash, size: Math.max(0, Number(row[1]) || 0) };
  });
  return { sha: String(doc.sha || "").toLowerCase(), built: isoTime(doc.built), files: files };
}

async function loadShellManifest(signal) {
  const watch = stallWatch(signal);
  try {
    const res = await mirrorFetch(new Request(shellUrl("./shell-manifest.json"), { cache: "no-store", signal: watch.signal }));
    if (!res || !res.ok) return null;
    return readManifestDoc(await res.json());
  } catch (err) {
    if (signal && signal.aborted) throw shellError("", "replaced");
    return null;
  } finally {
    watch.done();
  }
}

/* Which deploy a manifest belongs to, seen from this worker: "same", "newer"
   (a deploy landed after this worker was built), or "unknown" (an older
   mirror copy, or a local build with no stamps). */
function manifestRelation(manifest) {
  const own = versionSha(VERSION);
  if (!manifest || !manifest.sha || !own) return "unknown";
  if (manifest.sha === own) return "same";
  const built = isoTime(BUILT);
  if (built && manifest.built && manifest.built > built) return "newer";
  return "unknown";
}

function cachePath(url) {
  try { return new URL(url, self.registration.scope).pathname; } catch (err) { return ""; }
}

/* Files already on this device, by path and content hash: a half-finished
   attempt of this version first, then the shell that is running now. */
async function reusableShell(stagingName) {
  const found = new Map();
  let names = [];
  try { names = await caches.keys(); } catch (err) { return found; }
  const order = [stagingName, SHELL].concat(names.filter((name) => name.indexOf("shell-") === 0 && name !== stagingName && name !== SHELL));
  for (const name of order) {
    if (names.indexOf(name) < 0) continue;
    try {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      for (const req of keys) {
        const res = await cache.match(req);
        const hash = res && res.headers.get("x-shell-sha256");
        const key = cachePath(req.url) + "|" + (hash || "");
        if (hash && !found.has(key)) found.set(key, { name: name, req: req });
      }
    } catch (err) { /* a cache that cannot be read is simply downloaded again */ }
  }
  return found;
}

async function pullOne(path, report, state, signal, cache, manifest) {
  const want = manifest && manifest.files[path] ? manifest.files[path] : null;
  const tick = () => { if (report) broadcastProgress({ step: "download", files: state.files, totalFiles: state.totalFiles, bytes: state.bytes, totalBytes: state.totalBytes }, false); };
  if (want && state.reuse) {
    const hit = state.reuse.get(cachePath(path) + "|" + want.hash);
    if (hit) {
      try {
        const res = await (await caches.open(hit.name)).match(hit.req);
        if (res) {
          if (hit.name !== cache.name) await cache.put(path, res);
          state.files += 1;
          state.reused += 1;
          state.bytes += want.size;
          tick();
          return;
        }
      } catch (err) { /* fall through to a download */ }
    }
  }
  let last = shellError(path, "network");
  for (let attempt = 0; attempt < PRECACHE_TRIES; attempt++) {
    if (signal && signal.aborted) throw shellError(path, "replaced");
    const delay = precacheDelay(attempt);
    if (delay) await wait(delay);
    if (signal && signal.aborted) throw shellError(path, "replaced");
    const watch = stallWatch(signal);
    let got = 0;
    try {
      const res = await fetchShellFile(path, watch);
      watch.touch();
      if (!res || !res.ok) {
        last = shellError(path, res && res.status ? "http-" + res.status : "network");
        if (!retryableStatus(res && res.status)) break;
        continue;
      }
      const declared = Number(res.headers.get("content-length")) || 0;
      if (declared && !want) state.totalBytes += declared;
      let counted;
      try {
        counted = await readCounted(res, (n) => {
          watch.touch();
          got += n;
          state.bytes += n;
          tick();
        });
      } catch (err) {
        throw shellError(path, watch.reason() || failureReason(err, 0));
      }
      if (!declared && !want) state.totalBytes += counted.size;
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      let hash = "";
      try { hash = await sha256Hex(counted.chunks); } catch (err) { hash = ""; }
      if (hash) headers.set("x-shell-sha256", hash);
      if (want && hash && hash !== want.hash) {
        // Another deploy may have landed while this one downloads. Never
        // mix two builds: a newer manifest stops this attempt; otherwise
        // (a lagging mirror copy) the file is fetched again.
        state.bytes -= got;
        got = 0;
        const now = await loadShellManifest(signal);
        if (now && manifestRelation(now) === "newer") throw shellError(path, "newer");
        last = shellError(path, "mismatch");
        continue;
      }
      try {
        await cache.put(path, new Response(new Blob(counted.chunks), { status: 200, headers: headers }));
      } catch (err) {
        const reason = failureReason(err, 0);
        throw shellError(path, reason === "timeout" ? "quota" : reason);
      }
      state.files += 1;
      state.fetched += 1;
      if (report) broadcastProgress({ step: "download", files: state.files, totalFiles: state.totalFiles, bytes: state.bytes, totalBytes: state.totalBytes }, true);
      return;
    } catch (err) {
      state.bytes -= got;
      if (err && (err.reason === "replaced" || err.reason === "newer")) throw err;
      if (signal && signal.aborted) throw shellError(path, "replaced");
      last = err && err.shellPath ? err : shellError(path, failureReason(err, 0));
      if (last.reason === "quota") break;
    } finally {
      watch.done();
    }
  }
  if (shellOptional(path)) {
    state.files += 1;
    if (report) broadcastProgress({ step: "download", files: state.files, totalFiles: state.totalFiles, bytes: state.bytes, totalBytes: state.totalBytes }, true);
    return;
  }
  throw last;
}

/* A short, private log of what went wrong with updates: file path in the
   app shell, a reason word, counts. No URLs with queries, no user data. */
const UPDATE_LOG = "./__prefs/update-log.json";
async function logUpdate(row) {
  try {
    const cache = await caches.open(PREFS_CACHE);
    const old = await cache.match(UPDATE_LOG);
    let list = old ? await old.json() : [];
    if (!Array.isArray(list)) list = [];
    list.push(Object.assign({ t: Date.now(), v: versionSha(VERSION).slice(0, 12) }, row));
    await cache.put(UPDATE_LOG, new Response(JSON.stringify(list.slice(-20)), { headers: { "Content-Type": "application/json" } }));
  } catch (err) { /* the log is best effort */ }
}

/* Home pills and Stories can be turned fully off in Settings. The page
   writes the off list here, and the shell download skips those files so an
   off feature costs no network at all. Turned back on, they load on demand. */
const PREFS_CACHE = "viktorych-prefs";
const FEATURE_FILES = {
  homePills: ["./scores.js", "./scores.css", "./weather.js", "./weather.css", "./shared/pill-data.js"],
  stories: ["./stories.js", "./stories.css"]
};
async function offFeatureFiles() {
  try {
    const cache = await caches.open(PREFS_CACHE);
    const res = await cache.match("./__prefs/off.json");
    const off = res ? await res.json() : [];
    const out = [];
    (Array.isArray(off) ? off : []).forEach((key) => { (FEATURE_FILES[key] || []).forEach((path) => out.push(path)); });
    return out;
  } catch (err) {
    return [];
  }
}

/* Written into this version's shell cache once every file is in. A worker
   that the browser stopped and started again (phones do this all the time)
   then knows the download already finished and never repeats it. */
const SHELL_READY = "./__shell-ready";
async function shellReadyState() {
  try {
    const res = await (await caches.open(SHELL)).match(SHELL_READY);
    if (!res) return null;
    const doc = await res.json();
    return doc && typeof doc === "object" ? doc : null;
  } catch (err) { return null; }
}

async function doPrecache(report, generation, signal) {
  const done = await shellReadyState();
  if (done) {
    progressState = { files: Number(done.files) || 0, totalFiles: Number(done.totalFiles) || 0, bytes: Number(done.bytes) || 0, totalBytes: Number(done.totalBytes) || 0 };
    return progressState;
  }
  // Download the whole shell into a staging cache. The live cache is
  // replaced only after every required file succeeds, so a client never
  // runs one version's HTML with another version's scripts. The staging
  // cache belongs to this version and survives a failed attempt, so Retry
  // carries on where it stopped instead of starting over.
  const stagingName = SHELL + "-staging";
  const cache = await caches.open(stagingName);
  cache.name = stagingName;
  const skip = await offFeatureFiles();
  const files = SHELL_FILES.filter((path) => skip.indexOf(path) < 0);
  const state = { files: 0, totalFiles: files.length, bytes: 0, totalBytes: 0, reused: 0, fetched: 0, reuse: null };
  let manifest = await loadShellManifest(signal);
  const relation = manifestRelation(manifest);
  if (relation === "newer") {
    await logUpdate({ reason: "newer", stage: "manifest" });
    throw shellError("", "newer");
  }
  if (relation !== "same") manifest = null;
  if (manifest) {
    state.reuse = await reusableShell(stagingName);
    files.forEach((path) => { if (manifest.files[path]) state.totalBytes += manifest.files[path].size; });
  }
  let failed = null;
  // A single large file can sit in cache storage longer than the page's
  // stall timer. Keep telling the page this attempt is alive.
  const beat = report ? setInterval(() => {
    broadcastProgress({ step: "download", files: state.files, totalFiles: state.totalFiles, bytes: state.bytes, totalBytes: state.totalBytes }, true);
  }, 4000) : null;
  const pull = async () => {
    while (files.length && !failed) {
      const path = files.shift();
      try {
        await pullOne(path, report, state, signal, cache, manifest);
      } catch (err) {
        failed = err && err.reason ? err : shellError(path, "network");
      }
    }
  };
  const workers = [];
  const width = Math.min(4, SHELL_FILES.length);
  for (let i = 0; i < width; i++) workers.push(pull());
  let ok = false;
  try {
    await Promise.all(workers);
    if (signal && signal.aborted) throw shellError("", "replaced");
    if (failed) throw failed;
    if (generation !== precacheGeneration) throw shellError("", "replaced");
    const live = await caches.open(SHELL);
    const ready = await cache.keys();
    await Promise.all(ready.map(async (req) => {
      const res = await cache.match(req);
      if (res) await live.put(req, res);
    }));
    ok = true;
    const summary = { files: state.files, totalFiles: state.totalFiles, bytes: state.bytes, totalBytes: state.totalBytes };
    try { await live.put(SHELL_READY, new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } })); } catch (err) { /* the next apply checks the files again */ }
    console.info("shell update ready", "reused " + state.reused, "downloaded " + state.fetched);
    progressState = { files: state.files, totalFiles: state.totalFiles, bytes: state.bytes, totalBytes: state.totalBytes };
    return progressState;
  } catch (err) {
    const reason = safeShellReason(err && err.reason);
    if (reason !== "replaced") await logUpdate({ reason: reason, path: safeShellPath(err && err.shellPath), files: state.files, of: state.totalFiles, reused: state.reused, pinned: !!manifest });
    throw err;
  } finally {
    if (beat) clearInterval(beat);
    // The staging cache is left for activate to remove: deleting a cache
    // this attempt still holds can stall the worker before skipWaiting.
  }
}

async function runApply(fresh) {
  updateReporting = true;
  // A nudge with fresh:false must not abort a download that is already
  // running. Retry omits the flag and replaces a download that is stuck.
  const task = precacheShell(true, fresh !== false);
  const generation = task.generation;
  try {
    if (fresh !== false) broadcastProgress({ step: "download", files: 0, totalFiles: SHELL_FILES.length, bytes: 0, totalBytes: 0 }, true);
    const state = await task;
    if (generation !== precacheGeneration) return;
    broadcastProgress({ step: "install", files: state.files, totalFiles: state.totalFiles, bytes: state.bytes, totalBytes: state.totalBytes }, true);
    await self.skipWaiting();
    // Activation can be held up by the old worker. If this worker is still
    // waiting after a while, say so, and Retry asks again.
    for (let waited = 0; waited < 20000; waited += 500) {
      if (generation !== precacheGeneration || self.registration.active === self.serviceWorker || self.registration.waiting !== self.serviceWorker) return;
      await wait(500);
    }
    if (generation !== precacheGeneration || self.registration.waiting !== self.serviceWorker) return;
    throw shellError("", "timeout");
  } catch (err) {
    if (generation !== precacheGeneration || (err && err.reason === "replaced")) return;
    updateReporting = false;
    const path = safeShellPath(err && err.shellPath);
    const reason = safeShellReason(err && err.reason);
    console.warn("shell update failed", path || reason);
    broadcast({ type: "update-progress", step: "error", url: path, reason: reason });
  }
}

idb().then((db) => idbGet(db, "auth-state")).then((saved) => { if (saved && typeof saved === "object") { if (!accountsAuthed && saved.on) accountsAuthed = true; if (!playToken && saved.token) playToken = String(saved.token); } }).catch(() => {});
// While a game is open the page tells us, and background feed work waits.
let gameBusyUntil = 0;
function gameBusy() {
  return gameBusyUntil > Date.now();
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "game-busy") {
    gameBusyUntil = data.on ? Date.now() + 3 * 60 * 1000 : 0;
    return;
  }
  if (data.type === "media-drop" && typeof data.url === "string" && /^https:\/\//i.test(data.url)) {
    // A picture that did not load on the page: forget any stored copy so a
    // cached failure (an opaque error is indistinguishable from a picture)
    // never sticks to this device.
    event.waitUntil(dropMediaCopy(data.url).catch(() => {}));
    return;
  }
  if (data.type === "drop-profile-media") {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(names.map(async (name) => {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        await Promise.all(keys.map((req) => {
          const path = new URL(req.url).pathname;
          if (/\/v1\/media\/(?:view\/[a-f0-9]{32}|(?:avatars|banners)\/\d{12}\/)/.test(path)) return cache.delete(req);
          return Promise.resolve(false);
        }));
      }));
    })());
    return;
  }
  if (data.type === "peer-flag") {
    peerOn = !!data.on;
    return;
  }
  if (data.type === "media-stats") {
    const field = data.field === "peerBytes" || data.field === "originBytes" ? data.field : "";
    const bytes = Number(data.bytes) || 0;
    if (!field || bytes <= 0) return;
    event.waitUntil(idb().then((db) => self.ViktorychStorage.bump(db, field, bytes)).catch(() => {}));
    return;
  }
  if (data.type === "sw-version") {
    const info = versionInfo();
    if (event.ports && event.ports[0]) {
      try { event.ports[0].postMessage({ type: "sw-version", version: info.version, sha: info.sha, built: info.built }); } catch (err) { /* the page already continued */ }
      return;
    }
    if (event.source) {
      try { event.source.postMessage({ type: "sw-version", version: info.version, sha: info.sha, built: info.built }); } catch (err) { /* the page already continued */ }
    }
    return;
  }
  if (data.type === "update-reloading" && event.source) {
    reloadingClients.add(event.source.id);
    return;
  }
  if (data.type === "serve-network-once") {
    serveNetworkOnce = true;
    return;
  }
  if (data.type === "prime") {
    event.waitUntil((async () => {
      if (self.registration.active) return;
      await precacheShell(false, false);
      await self.skipWaiting();
    })().catch(() => {}));
    return;
  }
  if (data.type === "update-log") {
    event.waitUntil((async () => {
      let list = [];
      try {
        const res = await (await caches.open(PREFS_CACHE)).match(UPDATE_LOG);
        list = res ? await res.json() : [];
      } catch (err) { list = []; }
      try { if (event.source) event.source.postMessage({ type: "update-log", log: Array.isArray(list) ? list : [] }); } catch (err) { /* the page closed */ }
    })());
    return;
  }
  if (data.type === "update-ping") {
    // The page heard nothing for a while. Answer with where this worker is.
    // A waiting worker with no download running is not making progress, so
    // the page shows Retry instead of waiting on it forever.
    // A phone stops an idle worker and starts it again with no download in
    // memory; that is not a failure. Pick the download up again (files
    // already saved are kept) instead of sending the page to Retry.
    if (shellTask) broadcastProgress({ step: "download" }, true);
    else if (self.registration.active === self.serviceWorker) broadcastProgress({ step: "activate" }, true);
    else if (self.registration.waiting === self.serviceWorker || self.registration.installing === self.serviceWorker) event.waitUntil(runApply(false));
    else broadcast({ type: "update-progress", step: "error", url: "", reason: "timeout" });
    return;
  }
  if (data.type === "predownload") {
    // A new version is waiting. Download its files quietly in the
    // background; the page shows What's new only once this is done, so
    // Update now just switches over. A failure here is never shown: the
    // page tries again later.
    event.waitUntil((async () => {
      if (self.registration.active === self.serviceWorker) return;
      const info = versionInfo();
      try {
        let task = precacheShell(false, false);
        for (;;) {
          try { await task; break; } catch (err) {
            if (!err || err.reason !== "replaced" || !shellTask || shellTask === task) throw err;
            task = shellTask;
          }
        }
        broadcast({ type: "shell-ready", sha: info.sha, version: info.version });
      } catch (err) {
        const reason = safeShellReason(err && err.reason);
        if (reason === "replaced") return;
        broadcast({ type: "shell-pending", sha: info.sha, reason: reason, url: safeShellPath(err && err.shellPath) });
      }
    })());
    return;
  }
  if (data.type === "apply-update" || data.type === "skip-waiting") {
    event.waitUntil(runApply(data.type === "skip-waiting" || data.fresh !== false));
    return;
  }
  if (data.type === "ru_mode") {
    isRuVisitor = !!data.on;
    return;
  }
  if (data.type === "account-deleted") {
    accountsAuthed = false;
    playToken = "";
    event.waitUntil((async () => {
      await wipeUserCaches(true);
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.indexOf("shell-") !== 0).map((name) => caches.delete(name)));
      try {
        const db = await idb();
        await idbSet(db, "auth-state", { on: false, token: "" });
        await idbSet(db, "follows", []);
        await idbSet(db, "seen-at", 0);
        await idbSet(db, "seen-ids", []);
        await idbSet(db, "bells", {});
        await idbSet(db, "bell-seen", []);
        await idbSet(db, "bell-queue", []);
        await idbSet(db, "muted-words", []);
        await idbSet(db, "muted-accounts", []);
        await idbSet(db, "repost-off", []);
        await idbSet(db, "notify-all", false);
        await idbSet(db, "media-index", []);
        if (self.ViktorychStorage) await self.ViktorychStorage.replaceFiles(db, []);
      } catch (err) { /* the page also deletes the database */ }
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
      } catch (err) { /* a deleted account has no server subscription left */ }
    })());
    return;
  }
  if (data.type === "auth") {
    accountsAuthed = !!data.on;
    playToken = data.on && typeof data.token === "string" ? data.token : "";
    event.waitUntil((async () => {
      try {
        const db = await idb();
        await idbSet(db, "auth-state", { on: accountsAuthed, token: playToken });
      } catch (err) { /* the page still signs out */ }
      if (!data.on) {
        await wipeUserCaches(data.wipe === "signout");
        try {
          const db = await idb();
          await idbSet(db, "bells", {});
          await idbSet(db, "bell-seen", []);
          await idbSet(db, "bell-queue", []);
          await idbSet(db, "notify-all", false);
        } catch (err) { /* the page cleared the same keys */ }
        try {
          const sub = await self.registration.pushManager.getSubscription();
          if (sub) await sub.unsubscribe();
        } catch (err) { /* push is already gone */ }
      }
    })());
    if (event.ports && event.ports[0]) {
      try { event.ports[0].postMessage({ ok: !!playToken }); } catch (err) { /* the page already continued */ }
    }
  }
  if (data.type === "storage-policy") {
    event.waitUntil(idb().then(async (db) => {
      await self.ViktorychStorage.writePolicy(db, data.policy || {});
      await trimMedia();
    }).catch(() => {}));
  }
  if (data.type === "storage-clear-opfs") {
    event.waitUntil((async () => {
      const opfs = self.ViktorychOpfs;
      if (!opfs || !opfs.supported()) return;
      if (data.all) { await opfs.clear(); return; }
      const urls = Array.isArray(data.urls) ? data.urls.slice(0, 5000) : [];
      for (const url of urls) { try { await opfs.remove(String(url)); } catch (err) { /* already gone */ } }
    })().catch(() => {}));
    return;
  }
  if (data.type === "storage-wipe") {
    event.waitUntil(wipeUserCaches(true));
  }
  if (data.type === "reload-armed" && event.source) armedClients.add(event.source.id);
  if (data.type === "cache-bookmark" || data.type === "cache-media") event.waitUntil(cacheBookmark(data.urls));
  if (data.type === "cache-media-bytes" && typeof data.url === "string" && /^https:/.test(data.url) && data.blob instanceof Blob) event.waitUntil(cacheFriendCopy(data.url, data.blob));
  if (data.type === "shorts-lock") {
    rememberShortsLock(data);
    return;
  }
  if (data.type === "seen" || data.type === "state") {
    rememberShortsLock(data);
    event.waitUntil(idb().then(async (db) => {
      await idbSet(db, "seen-at", data.type === "seen" ? Date.now() : Number(data.seen || 0));
      if (Array.isArray(data.follows)) await idbSet(db, "follows", data.follows);
      if (Array.isArray(data.ids)) await idbSet(db, "seen-ids", data.ids.slice(0, 400));
      if (data.bells && typeof data.bells === "object") await idbSet(db, "bells", data.bells);
      if (Array.isArray(data.bellSeen)) await idbSet(db, "bell-seen", data.bellSeen.slice(-500));
      if (Array.isArray(data.mutedWords)) await idbSet(db, "muted-words", data.mutedWords);
      if (Array.isArray(data.mutedAccounts)) await idbSet(db, "muted-accounts", data.mutedAccounts);
      if (Array.isArray(data.repostOff)) await idbSet(db, "repost-off", data.repostOff);
      if (typeof data.notifyAll === "boolean") await idbSet(db, "notify-all", data.notifyAll);
      if (data.uiLang === "en" || data.uiLang === "ru" || data.uiLang === "es" || data.uiLang === "hi") {
        await idbSet(db, "ui-lang", data.uiLang);
        if (self.SI18n) self.SI18n.setLang(data.uiLang);
      }
      if (data.tiktokLock && typeof data.tiktokLock === "object") {
        const lock = data.tiktokLock;
        await idbSet(db, "tiktok-lock", {
          owner: lock.owner === true,
          audienceAll: lock.audienceAll === true,
          locked: lock.locked !== false,
          unlocked: Array.isArray(lock.unlocked) ? lock.unlocked.slice(0, 200) : []
        });
      }
    }));
  }
  if (data.type === "bell-deliver") {
    event.waitUntil(deliverBellNotes(data.notes || [], !!data.dnd).then((delivered) => {
      if (event.source) event.source.postMessage({ type: "bell-delivered", notes: delivered });
    }));
  }
  if (data.type === "outbox" && Array.isArray(data.queue)) {
    event.waitUntil(idb().then((db) => idbSet(db, "outbox", data.queue.slice(-200))));
    return;
  }
  if (data.type === "api-base" && data.api) {
    event.waitUntil(idb().then((db) => idbSet(db, "api-base", String(data.api))));
    return;
  }
  if (data.type === "weather-url" && data.url) {
    event.waitUntil(idb().then((db) => idbSet(db, "weather-url", String(data.url))));
    return;
  }
  if (data.type === "storage-pressure") {
    event.waitUntil((async () => {
      let cap = 0;
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          if (est && est.quota) cap = Math.floor(est.quota * 0.5);
        }
      } catch (err) { cap = 0; }
      await trimMedia(null, cap || undefined);
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((client) => {
        try { client.postMessage({ type: "storage-pressure" }); } catch (err) { /* the storage screen still explains it */ }
      });
    })());
    return;
  }
  if (data.type === "bell-pull") {
    event.waitUntil(idb().then(async (db) => {
      const notes = (await idbGet(db, "bell-queue")) || [];
      const kept = [];
      for (let i = 0; i < notes.length; i++) {
        if (!(await swNoteHidden(notes[i]))) kept.push(notes[i]);
      }
      await idbSet(db, "bell-queue", []);
      if (event.source) event.source.postMessage({ type: "bell-queue", notes: kept });
    }));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if ((request.method === "DELETE" && /\/v1\/account\/?$/i.test(url.pathname)) || (request.method === "POST" && /\/v1\/account\/delete\/?$/i.test(url.pathname))) {
    event.respondWith((async () => {
      const res = await fetch(request);
      if (res && res.ok) await wipeUserCaches(true);
      return res;
    })());
    return;
  }
  if (request.method === "POST" && url.origin === self.location.origin && (url.searchParams.get("share") === "1" || (shellDocument(url) && /multipart\/form-data/i.test(request.headers.get("content-type") || "")))) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET") return;
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  // The TV install page, the APK, and assetlinks go straight to the network.
  if (url.origin === self.location.origin && (/\.apk$/i.test(url.pathname) || /\/tv\/(?:index\.html)?$/.test(url.pathname) || url.pathname.indexOf("/.well-known/") >= 0)) return;
  if (url.origin === self.location.origin && url.pathname.toLowerCase().endsWith("/version.json")) {
    event.respondWith((async () => {
      const res = await mirrorFetch(new Request(request.url, { method: "GET", cache: "no-store" }));
      const headers = new Headers(res.headers);
      headers.set("cache-control", "no-store");
      headers.set("pragma", "no-cache");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headers });
    })().catch(() => new Response("", { status: 504, headers: { "cache-control": "no-store" } })));
    return;
  }
  // Sealed catalogs are encrypted copies whose age the app checks itself:
  // network (or a mirror when Pages is blocked), never this worker's cache.
  if (url.origin === self.location.origin && /\/sealed\/[^/]+\.json$/.test(url.pathname)) {
    event.respondWith(mirrorFetch(request).catch(() => new Response("", { status: 504 })));
    return;
  }
  // A local Discord key: these requests go straight to Discord, never cached here.
  if (url.hostname === "discord.com" || /(^|\.)hcaptcha\.com$/.test(url.hostname)) return;
  if (isGameHost(url)) return;
  if (isTikTokCdn(url)) return;
  if (isArchiveStore(url)) return;
  const bearer = (request.headers.get("Authorization") || "").match(/^Bearer\s+(\S+)$/i);
  if (bearer && (/\/v1\//.test(url.pathname) || /\/tg\//.test(url.pathname))) { accountsAuthed = true; playToken = bearer[1]; }
  if (isOwnerPlay(url) || isAccountMedia(url) || isOwnedTelegram(url)) {
    event.respondWith((async () => {
      const headers = new Headers();
      const incoming = request.headers.get("Authorization") || "";
      const match = incoming.match(/^Bearer\s+(\S+)$/i);
      if (!match && !playToken) { try { const saved = await idbGet(await idb(), "auth-state"); if (saved && saved.token) { accountsAuthed = !!saved.on; playToken = String(saved.token); } } catch (err) { /* ignore */ } }
      if (match) { accountsAuthed = true; playToken = match[1]; headers.set("Authorization", "Bearer " + playToken); }
      else if (playToken) headers.set("Authorization", "Bearer " + playToken);
      else if (/^Bearer\s+\S+/i.test(incoming)) headers.set("Authorization", incoming);
      const origin = request.headers.get("origin");
      if (origin) headers.set("origin", origin);
      if (isAccountMedia(url) || isOwnerPlay(url) || self.ViktorychStorage.categoryOf(url.href) === "") {
        const range = request.headers.get("Range");
        if (range) headers.set("Range", range);
        return fetch(request.url, { method: "GET", headers, cache: "no-store", redirect: "follow" });
      }
      if (self.ViktorychStorage.shouldCacheMedia(url)) return serveMedia(request, headers);
      if (self.ViktorychStorage.shouldCacheFeed(url)) return staleWhileRevalidate(request, headers);
      const range = request.headers.get("Range");
      if (range) headers.set("Range", range);
      return fetch(request.url, { method: "GET", headers, cache: "no-store", redirect: "follow" });
    })());
    return;
  }
  if (ACCOUNTS_WALL && !accountsAuthed && privateData(url)) {
    event.respondWith(new Response("", { status: 401, headers: { "cache-control": "no-store" } }));
    return;
  }
  if (isCatalogMedia(url)) return;
  if (isLoopPointer(url)) {
    event.respondWith(fetchLoopPointer(request));
    return;
  }
  if (isSpaceStatus(url) || isSpaceAsset(url)) {
    event.respondWith(fetch(new Request(request, { cache: "no-store" })));
    return;
  }
  if (url.origin === self.location.origin && /\/accounts\.config\.js$/.test(url.pathname) && url.search) {
    // A cache-busted read asks for the latest gate. It must not be written
    // into the versioned shell, or one new file would sit next to old assets.
    event.respondWith(mirrorFetch(new Request(request, { cache: "no-store" })).catch(async () => {
      const cache = await caches.open(SHELL);
      return (await cache.match("./accounts.config.js")) || Response.error();
    }));
    return;
  }
  if (request.headers.has("range")) {
    if (self.ViktorychStorage.shouldCacheMedia(url)) {
      event.respondWith(serveMedia(request));
      return;
    }
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const home = shellDocument(url);
      const fresh = serveNetworkOnce || url.searchParams.has("vapp");
      if (fresh) serveNetworkOnce = false;
      if (home && fresh) {
        try {
          const res = await fetch(request, { cache: "no-store" });
          if (res && res.ok) return res;
        } catch (err) { /* the saved page is still shown */ }
      }
      if (home) {
        const cache = await caches.open(SHELL);
        const cached = (await cache.match("./index.html")) || (await cache.match("./"));
        if (cached) return cached;
      }
      try {
        // Navigation preload is only used when this version has no shell
        // document yet. A newer index.html is never written beside the
        // assets already in the versioned shell.
        let res = null;
        try { res = await event.preloadResponse; } catch (err) { res = null; }
        if (!res) res = await mirrorFetch(request);
        return res;
      } catch (err) {
        if (!home) return Response.error();
        const cache = await caches.open(SHELL);
        return (await cache.match("./index.html")) || (await cache.match("./")) || (await cache.match("./offline.html")) || Response.error();
      }
    })());
    return;
  }
  if (url.hostname === "api.open-meteo.com" && url.pathname.indexOf("/v1/forecast") === 0) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res && res.ok) {
          const cache = await caches.open(DATA);
          cache.put(request, res.clone());
          try { await idbSet(await idb(), "weather-url", request.url); } catch (err) { /* the forecast still returns */ }
        }
        return res;
      } catch (err) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return Response.error();
      }
    })());
    return;
  }
  if (request.headers.get("X-Feed-Refresh") === "1" && url.origin === self.location.origin && /\.json$/i.test(url.pathname)) {
    event.respondWith(refreshData(request));
    return;
  }
  if (isData(url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (isMedia(url) || self.ViktorychStorage.shouldCacheMedia(url)) {
    event.respondWith(serveMedia(request));
    return;
  }
  if (isCommentApi(url)) {
    event.respondWith(networkFirstTimeout(request, LIVE, 6000));
    return;
  }
  if (isLive(url)) {
    event.respondWith(networkFirst(request, LIVE).catch(() => new Response("", { status: 504 })));
    return;
  }
  if (request.cache === "reload") {
    event.respondWith(mirrorFetch(request));
    return;
  }
  if (isShell(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(request);
      if (cached) return url.pathname.endsWith("manifest.webmanifest") ? brandManifestResponse(cached) : cached;
      try {
        const res = await mirrorFetch(request);
        if (res && url.pathname.endsWith("manifest.webmanifest")) return brandManifestResponse(res);
        // Video players load on first use instead of with every update, then
        // stay for offline use until the next version.
        if (res && res.ok && LAZY_FILES.some((path) => url.pathname.endsWith(path.slice(1)))) {
          const copy = res.clone();
          event.waitUntil(cache.put(request, copy).catch(() => {}));
        }
        return res;
      } catch (err) {
        return Response.error();
      }
    })());
    return;
  }
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const cached = await cache.match(request);
      if (cached) return cached;
      return mirrorFetch(request);
    })());
  }
});

function shellDocument(url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  if (/\/(?:s|u)\//.test(path)) return false;
  if (/\/tv\/(?:index\.html)?$/.test(path)) return false;
  return /\/(?:index\.html)?$/.test(path);
}

function isShell(url) {
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  return /\/(?:index\.html|offline\.html|app\.js|update\.js|storage\.js|storage\.css|localfirst\.js|direct\.js|dock\.js|dock\.css|native\.js|codec\.js|media-opfs\.js|feed-worker\.js|peer-media\.js|video-embed\.js|styles\.css|translate\.js|translate\.css|people\.js|people\.css|tv\.js|tv\.css|tv-page\.js|tv-page\.css|tv-pair\.js|tv-pair\.css|qrcode-1\.4\.4\.js|send-tv\.js|send-tv\.css|split\.js|discord-ui\.js|discord-ui\.css|discord-key-helper\.js|discord-key-helper\.css|community-notes\.js|community-notes\.css|spaces\.js|spaces\.css|music\.js|music\.css|games\.js|games\.css|game-social\.js|game-social\.css|yt-player\.js|yt-player\.css|scores\.js|scores\.css|weather\.js|weather\.css|stories\.js|stories\.css|highlights\.js|audience-ui\.js|live\.js|live\.css|shorts\.js|shorts\.css|drive\.js|drive\.css|communities\.js|communities\.css|marks\.js|logo-text\.js|busy\.js|about-ui\.js|gifts-ui\.js|gifts\.css|reactions\.js|reactions\.css|accounts\.js|onboarding\.js|onboarding\.css|owner-keys\.js|nzlay-keys\.js|nzlay-forum\.js|nzlay-forum\.css|video-providers\.js|accounts\.css|accounts\.config\.js|presence\.js|presence\.css|hls-1\.7\.3\.min\.js|mpegts-1\.8\.0\.min\.js|favicon\.svg|favicon\.ico|manifest\.webmanifest|i18n\.js|servers-voice\.js|servers-ui\.js|servers\.css)$/.test(path) || /\/i18n\//.test(path) || /\/icons\//.test(path) || /\/logo\//.test(path) || /\/fonts\//.test(path) || /\/splash\//.test(path) || /\/shared\//.test(path);
}

function isGameHost(url) {
  return url.hostname === "nzlay.com";
}

function canonicalNotifyId(post) {
  if (!post) return "";
  const rawId = String(post.id || "");
  if (rawId.indexOf("repost:") === 0) return rawId;
  let raw = String(post.statusId || post.id || "");
  if ((post.platform || "") !== "youtube" && raw.indexOf("yt:video:") !== 0) return raw;
  if (raw.indexOf("yt:video:") === 0) raw = raw.split(":").pop();
  const match = (raw + " " + (post.url || "")).match(/(?:[?&]v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;
  return raw;
}

function postIsLiveVideo(post) {
  if (!post) return false;
  if (post.live || post.isLive || post.premiere) return true;
  if (post.kind === "live" || post.kind === "premiere") return true;
  const media = post.media || [];
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (item && (item.live || item.premiere)) return true;
  }
  const blob = [post.url, post.title, post.text].join("\n");
  if ((post.platform || "") !== "youtube") return false;
  if (/\/live(\/|$|\?)/i.test(blob)) return true;
  return /\bpremieres?\b|\blive stream\b|\blive now\b|\bis live\b/i.test(blob);
}

function accountMuted(post, list) {
  const handle = String((post && post.handle) || "").replace(/^@/, "").toLowerCase();
  const id = String((post && post.feedId) || "").toLowerCase();
  const prefixed = ((post && post.platform) || "x") + ":" + handle;
  return (list || []).some((item) => {
    const key = String(item || "").replace(/^@/, "").trim().toLowerCase();
    return !!key && (key === handle || key === id || key === prefixed);
  });
}

function textMuted(text, words) {
  const sample = String(text || "").toLowerCase();
  return (words || []).some((word) => {
    const raw = String(word || "").trim().toLowerCase();
    return !!raw && sample.indexOf(raw) >= 0;
  });
}

function postMuted(post, words, accounts, repostOff) {
  if (!post) return true;
  if (accountMuted(post, accounts) || textMuted(post.text, words)) return true;
  const by = post.repostedBy;
  if (by && accountMuted({ handle: by.handle, platform: by.platform || post.platform, feedId: by.feedId || post.feedId }, repostOff)) return true;
  return false;
}

function bellCovers(post, row) {
  if (!post || !row || (row.mode !== "all" && row.mode !== "live")) return false;
  const when = Date.parse(post.date || "") || 0;
  if (!when || when < Number(row.since || 0)) return false;
  if (row.mode === "live" && !postIsLiveVideo(post)) return false;
  const feedId = String(post.feedId || "");
  if (feedId && (row.ids || []).indexOf(feedId) >= 0) return true;
  const handle = ((post.platform || "x") + ":" + (post.handle || "")).toLowerCase();
  return (row.handles || []).indexOf(handle) >= 0;
}

function statusHash(post) {
  const platform = post.platform || "x";
  const handle = post.handle || "";
  const id = post.statusId || post.id || "";
  if (platform === "x") return "#/@" + encodeURIComponent(handle) + "/status/" + encodeURIComponent(id);
  return "#/" + encodeURIComponent(platform) + "/" + encodeURIComponent(handle) + "/status/" + encodeURIComponent(id);
}

function postImageUrl(post) {
  const media = (post && post.media) || [];
  let poster = "";
  for (let i = 0; i < media.length; i++) {
    const item = media[i];
    if (!item) continue;
    if (item.type === "photo" && /^https:\/\//.test(item.url || "")) return item.url;
    if (!poster && /^https:\/\//.test(item.poster || "")) poster = item.poster;
  }
  return poster;
}

function noteFromPost(post, row) {
  const text = String(post.text || post.title || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const platform = post.platform || "x";
  const handle = String((row && row.handle) || post.handle || "").replace(/^@/, "");
  const raw = canonicalNotifyId(post) || String(post.id || "");
  const live = !!(row && row.mode === "live");
  const id = !raw ? "" : (live ? ("live:" + platform + ":" + handle.toLowerCase() + ":" + raw) : ("post:" + raw));
  return {
    id: id,
    at: Date.parse(post.date || "") || 0,
    kind: live ? "live" : "post",
    read: false,
    handle: handle,
    name: post.author || (row && row.name) || post.handle || "",
    text: text,
    avatar: /^https:\/\//.test(post.avatar || "") ? post.avatar : "",
    image: postImageUrl(post),
    hash: statusHash(post),
    feedId: String(post.feedId || ""),
    platform: platform,
    ids: (row && row.ids) || [],
    handles: (row && row.handles) || []
  };
}

let tiktokLockLoad = null;

function loadTiktokLock() {
  if (!tiktokLockLoad) tiktokLockLoad = import("./shared/tiktok-lock.js").catch(() => null);
  return tiktokLockLoad;
}

function noteLooksTiktok(note) {
  if (!note || typeof note !== "object") return false;
  const platform = String(note.platform || "").toLowerCase();
  const feedId = String(note.feedId || "");
  const hash = String(note.hash || "");
  const id = String(note.id || "");
  return platform === "tiktok" || feedId.indexOf("tiktok:") === 0 || hash.indexOf("#/tiktok/") === 0 || id.indexOf("tiktok:") === 0 || id.indexOf("live:tiktok:") === 0;
}

async function swNoteHidden(note) {
  if (!note) return false;
  let viewer = { owner: false, audienceAll: false, locked: true, unlocked: [] };
  try {
    const db = await idb();
    const saved = await idbGet(db, "tiktok-lock");
    if (saved && typeof saved === "object") viewer = saved;
  } catch (err) { /* stay locked until the page reports */ }
  const api = await loadTiktokLock();
  if (!api || typeof api.tiktokNoteHidden !== "function") return noteLooksTiktok(note);
  try { return !!api.tiktokNoteHidden(note, viewer); }
  catch (err) { return noteLooksTiktok(note); }
}

let bellChain = Promise.resolve();
let shortsLocked = true;
const shortsUnlocked = new Set();

function shortsHidden(note) {
  if (!note || note.platform !== "tiktok") return false;
  if (!shortsLocked) return false;
  const handle = String(note.handle || (note.titleVars && note.titleVars.handle) || "").replace(/^@/, "").toLowerCase();
  return !shortsUnlocked.has(handle);
}

function rememberShortsLock(data) {
  if (!data || typeof data !== "object") return;
  if (typeof data.shortsLocked === "boolean") shortsLocked = data.shortsLocked;
  else if (data.type === "shorts-lock") shortsLocked = data.locked !== false;
  const list = Array.isArray(data.shortsUnlocked) ? data.shortsUnlocked : (data.type === "shorts-lock" && Array.isArray(data.unlocked) ? data.unlocked : null);
  if (!list) return;
  shortsUnlocked.clear();
  list.forEach((name) => {
    const handle = String(name || "").replace(/^@/, "").toLowerCase();
    if (handle) shortsUnlocked.add(handle);
  });
}

async function pushIsDnd(flag) {
  if (flag) return true;
  try {
    const db = await idb();
    const presence = await idbGet(db, "presence");
    if (!presence || typeof presence !== "object") return false;
    if (presence.state === "dnd" || presence.dnd === true || presence.presence === "dnd") return true;
    const until = Number(presence.until || presence.dndUntil || 0);
    if (until > Date.now()) return true;
  } catch (err) { /* a missing store still buzzes */ }
  return false;
}

function deliverBellNotes(notes, dnd) {
  const run = bellChain.then(() => deliverBellNotesNow(notes, dnd));
  bellChain = run.then(() => {}, () => {});
  return run;
}

async function deliverBellNotesNow(notes, dnd) {
  await ensureUiLang();
  const list = (notes || []).filter((note) => note && note.id);
  if (!list.length) return [];
  const db = await idb();
  const quiet = await pushIsDnd(dnd);
  const seen = new Set((await idbGet(db, "bell-seen")) || []);
  const delivered = [];
  for (const note of list) {
    const id = String(note.id);
    if (!id || !note.at || seen.has(id)) continue;
    if (await swNoteHidden(note)) {
      seen.add(id);
      continue;
    }
    seen.add(id);
    delivered.push(note);
    if (quiet || Notification.permission !== "granted") continue;
    try {
      const NPB = self.ViktorychNotifPrivacy;
      const shownB = NPB ? NPB.present(Object.assign({ kind: "post" }, note), await NPB.load(), { title: note.name || ("@" + (note.handle || "post")) }) : null;
      await self.registration.showNotification(shownB ? shownB.title : (note.name || ("@" + (note.handle || "post"))), {
        body: shownB ? shownB.body : (note.text || tr("New post")),
        icon: shownB ? shownB.icon : (note.avatar || "icons/icon-192.png"),
        image: shownB ? shownB.image : (note.image || undefined),
        tag: "note-" + id,
        data: { hash: shownB && shownB.generic ? "#/notifications" : (note.hash || "#/"), id: id }
      });
    } catch (err) { /* the page still keeps the in-app row */ }
  }
  await idbSet(db, "bell-seen", Array.from(seen).slice(-500));
  if (!delivered.length) return [];
  const clients = await self.clients.matchAll({ type: "window" });
  const visible = clients.some((client) => client.visibilityState === "visible");
  if (!visible) {
    const queued = ((await idbGet(db, "bell-queue")) || []).concat(delivered).slice(-80);
    await idbSet(db, "bell-queue", queued);
    if (navigator.setAppBadge && await swBadgeAllowed()) {
      try { await navigator.setAppBadge(queued.length); } catch (err) { /* badges are optional */ }
    }
  }
  return delivered;
}

async function bellNotesFor(doc) {
  const db = await idb();
  const bells = (await idbGet(db, "bells")) || {};
  const words = (await idbGet(db, "muted-words")) || [];
  const accounts = (await idbGet(db, "muted-accounts")) || [];
  const repostOff = (await idbGet(db, "repost-off")) || [];
  const follows = new Set((await idbGet(db, "follows")) || []);
  const keys = Object.keys(bells);
  const notes = [];
  (doc.posts || []).forEach((post) => {
    if (!post || postMuted(post, words, accounts, repostOff)) return;
    const followed = follows.has(post.feedId) || follows.has((post.platform || "x") + ":" + (post.handle || ""));
    for (let i = 0; i < keys.length; i++) {
      const row = bells[keys[i]];
      if (!bellCovers(post, row)) continue;
      const ids = row.ids || [];
      if (!followed && !ids.some((item) => follows.has(item))) continue;
      const note = noteFromPost(post, row);
      if (note.id) notes.push(note);
      break;
    }
  });
  const kept = [];
  for (let i = 0; i < notes.length; i++) {
    if (!(await swNoteHidden(notes[i]))) kept.push(notes[i]);
  }
  return kept;
}

async function refreshData(request) {
  const cache = await caches.open(DATA);
  const cacheReq = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheReq);
  const network = mirrorFetch(new Request(request.url, { method: "GET", cache: "no-store" })).then(async (res) => {
    if (res && res.ok && self.ViktorychStorage.shouldCacheFeed(request.url)) {
      try { await cache.put(cacheReq, res.clone()); } catch (err) { /* the fresh body still returns */ }
    }
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 800));
  let raced = null;
  try { raced = await Promise.race([network.catch(() => null), timeout]); }
  catch (err) { raced = null; }
  if (raced) return raced;
  if (cached) {
    network.then((res) => {
      if (!res || !res.ok) return;
      broadcast({ type: "data", url: request.url });
    }).catch(() => {});
    return cached;
  }
  const res = await network.catch(() => null);
  return res || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
}

async function saveFeedSnapshot(doc) {
  if (!doc || !self.HomeFresh || !self.ViktorychStorage || !self.ViktorychStorage.putDoc) return;
  const body = self.HomeFresh.slimDoc(doc, Date.now());
  const db = await idb();
  await self.ViktorychStorage.putDoc(db, {
    category: "feeds",
    id: "timeline",
    body: body,
    bytes: JSON.stringify(body).length
  });
}

async function catalogRequest(key) {
  let api = "";
  let gate = false;
  try {
    const res = await fetch(new URL("accounts.config.js", self.registration.scope).href, { cache: "no-store" });
    const text = res && res.ok ? await res.text() : "";
    gate = /gate:\s*true/.test(text);
    const found = text.match(/api:\s*"([^"]*)"/);
    api = found ? found[1].replace(/\/$/, "") : "";
  } catch (err) { api = ""; }
  const headers = { "X-Feed-Refresh": "1" };
  if (gate && api) {
    if (!playToken) {
      try {
        const saved = await idbGet(await idb(), "auth-state");
        if (saved && saved.token) playToken = String(saved.token);
      } catch (err) { /* a missing session settles empty */ }
    }
    if (playToken) headers.Authorization = "Bearer " + playToken;
    return { url: api + "/v1/data/" + String(key || "").split("/").map(encodeURIComponent).join("/"), headers: headers, remote: true };
  }
  return { url: new URL(key, self.registration.scope).href, headers: headers, remote: false };
}

async function refreshFeedDoc() {
  let target = null;
  try { target = await catalogRequest("feeds.json"); }
  catch (err) { return null; }
  if (!target || !target.url) return null;
  let res = null;
  try {
    res = target.remote
      ? await fetch(target.url, { method: "GET", cache: "no-store", headers: target.headers })
      : await mirrorFetch(new Request(target.url, { method: "GET", cache: "no-store", headers: target.headers }));
  } catch (err) { return null; }
  if (!res || !res.ok) return null;
  let doc = null;
  try { doc = await res.json(); }
  catch (err) { return null; }
  if (!doc || !Array.isArray(doc.posts)) return null;
  const cache = await caches.open(DATA);
  await cache.put(target.url, new Response(JSON.stringify(doc), { headers: { "Content-Type": "application/json", "X-Fetched-At": String(Date.now()) } }));
  try { await saveFeedSnapshot(doc); } catch (err) { /* the catalog response is still cached */ }
  return doc;
}

async function refreshAndNotify() {
  await ensureUiLang();
  const doc = await refreshFeedDoc();
  if (!doc) return;
  const db = await idb();
  const seen = Number(await idbGet(db, "seen-at") || 0);
  const follows = new Set(await idbGet(db, "follows") || []);
  const seenIds = new Set(await idbGet(db, "seen-ids") || []);
  const bells = (await idbGet(db, "bells")) || {};
  const bellKeys = Object.keys(bells);
  const covered = (post) => bellKeys.some((key) => bellCovers(post, bells[key]));
  const fresh = (doc.posts || []).filter((post) => {
    if (!seen || (Date.parse(post.date || "") || 0) <= seen) return false;
    const id = canonicalNotifyId(post);
    if ((id && seenIds.has(id)) || (post.id && seenIds.has(String(post.id)))) return false;
    if (covered(post)) return false;
    return follows.has(post.feedId) || follows.has((post.platform || "x") + ":" + (post.handle || ""));
  });
  const clients = await self.clients.matchAll({ type: "window" });
  const visible = clients.some((client) => client.visibilityState === "visible");
  clients.forEach((client) => client.postMessage({ type: "feeds-updated" }));
  if (!visible) {
    const notes = await bellNotesFor(doc);
    if (notes.length) await deliverBellNotes(notes);
  }
  const notifyAll = await idbGet(db, "notify-all");
  const visibleFresh = [];
  for (let i = 0; i < fresh.length; i++) {
    if (!(await swNoteHidden(fresh[i]))) visibleFresh.push(fresh[i]);
  }
  if (!visibleFresh.length || notifyAll !== true) return;
  if (navigator.setAppBadge && await swBadgeAllowed()) {
    try { await navigator.setAppBadge(visibleFresh.length); } catch (err) { /* badges are optional */ }
  }
  if (Notification.permission === "granted") {
    await self.registration.showNotification(tr("New posts"), {
      body: trn("newPosts", visibleFresh.length),
      icon: "icons/icon-192.png",
      tag: "feeds",
      data: { hash: "#/" }
    });
  }
}

async function refreshWeather() {
  const db = await idb();
  const saved = await idbGet(db, "weather-url");
  if (!saved || !/^https:\/\/api\.open-meteo\.com\/v1\/forecast/.test(String(saved))) return;
  const res = await fetch(saved, { cache: "no-store" });
  if (!res || !res.ok) return;
  const cache = await caches.open(DATA);
  await cache.put(saved, res.clone());
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => {
    try { client.postMessage({ type: "weather-updated", url: saved }); } catch (err) { /* the next open reads the cache */ }
  });
}

async function refreshAccountNotes() {
  const db = await idb();
  const auth = await idbGet(db, "auth-state");
  const api = await idbGet(db, "api-base");
  if (!auth || !auth.token || !api) return;
  const root = String(api).replace(/\/$/, "");
  const res = await fetch(root + "/v1/notifications", {
    headers: { Authorization: "Bearer " + auth.token },
    cache: "no-store"
  });
  if (!res || !res.ok) return;
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((client) => {
    try { client.postMessage({ type: "push-note", note: {} }); } catch (err) { /* a visible page polls */ }
  });
}

async function replayOutboxAction(api, token, action) {
  const root = String(api).replace(/\/$/, "");
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (action.type === "repost") {
    const res = action.on
      ? await fetch(root + "/v1/reposts", { method: "PUT", headers: headers, body: JSON.stringify({ kind: "repost", post: action.snapshot || {} }) })
      : await fetch(root + "/v1/reposts", { method: "POST", headers: headers, body: JSON.stringify({ postKey: action.postKey || "" }) });
    return !!(res && res.ok);
  }
  return false;
}

async function flushOutbox() {
  const db = await idb();
  const queue = (await idbGet(db, "outbox")) || [];
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (clients.length) {
    clients.forEach((client) => {
      try { client.postMessage({ type: "flush-outbox" }); } catch (err) { /* the page flushes on the next online event */ }
    });
    return;
  }
  const auth = await idbGet(db, "auth-state");
  const api = await idbGet(db, "api-base");
  const left = [];
  for (const action of queue) {
    if (!action) continue;
    const kind = action.type;
    if (kind === "repost" && auth && auth.token && api) {
      try {
        const ok = await replayOutboxAction(api, auth.token, action);
        if (!ok) left.push(action);
      } catch (err) { left.push(action); }
      continue;
    }
    left.push(action);
  }
  await idbSet(db, "outbox", left);
}

async function receiveShare(request) {
  let form = null;
  try { form = await request.formData(); }
  catch (err) { form = null; }
  const title = form ? String(form.get("title") || "") : "";
  const text = form ? String(form.get("text") || "") : "";
  const sharedUrl = form ? String(form.get("url") || "") : "";
  const files = form ? form.getAll("media") : [];
  const names = [];
  const cache = await caches.open(MEDIA);
  const stamp = String(Date.now());
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (!file || !file.name) continue;
    names.push(file.name);
    try {
      await cache.put("./share-inbox/" + stamp + "-" + i, new Response(file, { headers: { "content-type": file.type || "application/octet-stream", "x-name": file.name } }));
    } catch (err) { /* the name still lands in the composer */ }
  }
  const params = new URLSearchParams();
  if (title) params.set("title", title);
  if (text || names.length) params.set("text", [text].concat(names).filter(Boolean).join("\n"));
  if (sharedUrl) params.set("url", sharedUrl);
  if (names.length) params.set("media", "1");
  return Response.redirect(new URL("./?" + params.toString() + "#/home", self.registration.scope), 303);
}

/* Inactivity expiry while the app stays closed (device-seal.js). The page
   writes lastOpen and the policy into viktorych-device-key. When it is too
   old, the device key is destroyed so the encrypted leftovers cannot be read,
   private databases go, and the next open finishes the cleanup. */
function expiryDb() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open("viktorych-device-key", 1); } catch (err) { resolve(null); return; }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("k")) req.result.createObjectStore("k"); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
async function checkExpiry() {
  const db = await expiryDb();
  if (!db) return;
  const meta = await new Promise((resolve) => {
    try {
      const req = db.transaction("k", "readonly").objectStore("k").get("meta");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (err) { resolve(null); }
  });
  const days = meta ? Number(meta.days) || 0 : 0;
  if (!meta || meta.expired || !days || !meta.lastOpen || Date.now() - Number(meta.lastOpen) <= days * 86400000) { db.close(); return; }
  await new Promise((resolve) => {
    try {
      const tx = db.transaction("k", "readwrite");
      const store = tx.objectStore("k");
      store.delete("device");
      store.put(Object.assign({}, meta, { expired: true }), "meta");
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch (err) { resolve(); }
  });
  db.close();
  ["viktorych-lock", "viktorych-discord", "viktorych-servers", "viktorych-drive", "viktorychapp-device-search"].forEach((name) => {
    try { indexedDB.deleteDatabase(name); } catch (err) { /* already gone */ }
  });
  accountsAuthed = false;
  playToken = "";
  if (meta.dropPublic) {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== SHELL).map((name) => caches.delete(name)));
  }
}

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "vapp-expiry") event.waitUntil(checkExpiry());
  if (event.tag === "feeds" && !gameBusy()) event.waitUntil(refreshAndNotify());
  if (event.tag === "notifications") event.waitUntil(Promise.all([refreshAndNotify(), refreshAccountNotes()]));
  if (event.tag === "weather" && !gameBusy()) event.waitUntil(refreshWeather());
});

self.addEventListener("sync", (event) => {
  if (event.tag === "outbox") event.waitUntil(flushOutbox());
});

// Background Sync uses the same feed refresh as periodic sync.
self.addEventListener("sync", (event) => {
  if (event.tag === "feeds" && !gameBusy()) event.waitUntil(refreshAndNotify());
});

// Notification privacy (notif-privacy.js). The badge follows the person's choice.
async function swBadgeAllowed() {
  const NP = self.ViktorychNotifPrivacy;
  if (!NP) return true;
  try { return (await NP.load()).badge !== false; } catch (err) { return true; }
}

// One small server read when this device has no copy of a note and names
// are allowed. Hidden names never trigger a request.
async function fetchPushNote(sid) {
  const NP = self.ViktorychNotifPrivacy;
  const db = await idb();
  const auth = await idbGet(db, "auth-state");
  const api = await idbGet(db, "api-base");
  if (!auth || !auth.token || !api || !sid) return null;
  const since = Date.now() - 15 * 60 * 1000;
  const res = await fetch(String(api).replace(/\/$/, "") + "/v1/notifications?since=" + since, {
    headers: { Authorization: "Bearer " + auth.token },
    cache: "no-store"
  });
  if (!res || !res.ok) return null;
  const view = await res.json().catch(() => null);
  const items = (view && Array.isArray(view.items)) ? view.items : [];
  await NP.remember(items, await NP.load());
  return NP.lookup(sid);
}

// Compact pushes: {v:2,k,i,n}. Text comes from this device only.
async function showCompactPush(c) {
  const NP = self.ViktorychNotifPrivacy;
  const db = await idb();
  const mark = c.sid + ":" + c.count;
  if (c.sid) {
    const seen = (await idbGet(db, "push-seen")) || [];
    if (seen.indexOf(mark) >= 0) return;
    await idbSet(db, "push-seen", seen.concat([mark]).slice(-300));
  }
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (open.some((client) => client.visibilityState === "visible")) {
    open.forEach((client) => {
      try { client.postMessage({ type: "push-note", note: {} }); }
      catch (err) { /* the page polls when it is next visible */ }
    });
    return;
  }
  await ensureUiLang();
  const prefs = await NP.load();
  let note = null;
  if (NP.showNames(prefs, c.kind)) {
    note = await NP.lookup(c.sid);
    if (!note || (c.count && Number(note.others || 0) !== c.count)) {
      try { note = (await fetchPushNote(c.sid)) || note; } catch (err) { /* generic copy below */ }
    }
  }
  if (note && await swNoteHidden(note)) return;
  const shown = NP.present(note ? Object.assign({}, note, { kind: note.kind || c.kind, others: c.count || note.others }) : null, prefs, { kind: c.kind });
  await self.registration.showNotification(shown.title, {
    body: shown.body,
    icon: shown.icon,
    image: shown.image,
    tag: "n-" + (c.sid || c.kind),
    data: { hash: shown.hash, id: (note && note.id) || "", invite: gameInviteId(c.kind, shown.hash) },
    ...gameInviteActions(c.kind, shown.hash)
  });
}

// Game invites get Join and Not now buttons. Join opens the game; Not now
// answers from here without opening a window.
function gameInviteId(kind, hash) {
  if (kind !== "game_invite") return "";
  const m = /[?&]invite=([a-f0-9]{24})(?:&|$)/.exec(String(hash || ""));
  return m ? m[1] : "";
}
function gameInviteActions(kind, hash) {
  if (!gameInviteId(kind, hash)) return {};
  return {
    requireInteraction: true,
    actions: [{ action: "join", title: tr("Join") }, { action: "decline", title: tr("Not now") }]
  };
}
async function declineGameInvite(id) {
  const db = await idb();
  const auth = await idbGet(db, "auth-state");
  const api = await idbGet(db, "api-base");
  if (!auth || !auth.token || !api || !id) return;
  await fetch(String(api).replace(/\/$/, "") + "/v1/games/invite/answer", {
    method: "POST",
    headers: { Authorization: "Bearer " + auth.token, "Content-Type": "application/json" },
    body: JSON.stringify({ id: id, answer: "decline" }),
    cache: "no-store"
  }).catch(() => null);
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; }
    catch (err) { data = {}; }
    if (await pushIsDnd(!!(data && data.dnd))) return;
    if (data && data.silent) return;
    const compact = self.ViktorychNotifPrivacy ? self.ViktorychNotifPrivacy.parsePush(data) : null;
    if (compact) {
      await showCompactPush(compact);
      return;
    }
    const hasCopy = !!(data && (data.titleKey || data.body));
    if (!hasCopy) return;
    if (await swNoteHidden(data)) return;
    const noteId = String((data && data.id) || "");
    if (noteId) {
      try {
        const db = await idb();
        const seen = new Set((await idbGet(db, "bell-seen")) || []);
        if (seen.has(noteId)) return;
        seen.add(noteId);
        await idbSet(db, "bell-seen", Array.from(seen).slice(-500));
      } catch (err) { /* a repeated push still uses the same notification tag */ }
    }
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = open.some((client) => client.visibilityState === "visible");
    try { await refreshFeedDoc(); } catch (err) { /* the visible notice still shows */ }
    if (visible) {
      open.forEach((client) => {
        try { client.postMessage({ type: "push-note", note: data }); }
        catch (err) { /* the page polls when it is next visible */ }
      });
      return;
    }
    await ensureUiLang();
    const vars = data && data.titleVars && typeof data.titleVars === "object" ? data.titleVars : {};
    const title = data && data.titleKey ? tr(data.titleKey, vars) : tr("New post");
    const NPL = self.ViktorychNotifPrivacy;
    const shownL = NPL ? NPL.present({ kind: NPL.kindFromTitleKey(data && data.titleKey), name: vars.name || "", handle: vars.handle || "", text: (data && data.body) || "", avatar: (data && data.icon) || "", hash: (data && data.hash) || "#/" }, await NPL.load(), { title: title }) : null;
    await self.registration.showNotification(shownL ? shownL.title : title, {
      body: shownL ? shownL.body : ((data && data.body) || ""),
      icon: shownL ? shownL.icon : ((data && data.icon) || "icons/icon-192.png"),
      tag: (data && data.tag) || ("note-" + ((data && data.id) || "")),
      data: { hash: shownL ? shownL.hash : ((data && data.hash) || "#/"), id: (data && data.id) || "", invite: gameInviteId(data && data.kind, data && data.hash) },
      ...gameInviteActions(data && data.kind, data && data.hash)
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const payload = event.notification.data || {};
    if (payload.invite && event.action === "decline") {
      await declineGameInvite(payload.invite);
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      open.forEach((client) => {
        try { client.postMessage({ type: "game-invite-answer", id: payload.invite, act: "decline", done: true }); }
        catch (err) { /* the page refreshes invites on its own */ }
      });
      return;
    }
    const hash = payload.invite && event.action === "join" ? "#/games/regone?invite=" + payload.invite + "&act=join" : (payload.hash || "#/");
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (clients[0]) {
      try { clients[0].postMessage({ type: "note-open", id: payload.id || "", hash: hash }); }
      catch (err) { /* navigation still opens the post */ }
      await clients[0].focus();
      if (clients[0].navigate) await clients[0].navigate("./" + hash);
      return;
    }
    await self.clients.openWindow("./" + hash);
  })());
});
