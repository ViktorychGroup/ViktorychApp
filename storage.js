/* Data and storage. Media bytes live in Cache Storage. Size, category, and
   last access live in IndexedDB so the service worker can evict by LRU and
   by the Keep media window. Auth, session, and owner-key responses are never
   stored. Sign-out and account deletion clear the saved copies. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychStorage = api;
  if (typeof document !== "undefined") api.start();
})(typeof self !== "undefined" ? self : this, function () {
  var GB = 1024 * 1024 * 1024;
  var MB = 1024 * 1024;
  /* Cache size choices on the slider. The last slider stop is Unlimited.
     Defaults still pick from 1, 5, 10 or 20 GB. */
  var MAX_STEPS = [250 * MB, 500 * MB, 1 * GB, 2 * GB, 3 * GB, 5 * GB, 10 * GB, 20 * GB, 50 * GB];
  var DEFAULT_STEPS = [1 * GB, 5 * GB, 10 * GB, 20 * GB];
  var quotaHint = 0;
  var POLICY_KEY = "viktorychapp-storage";
  var DB_NAME = "superintelapp-sw";
  var DB_VERSION = 3;
  var PINNED_CACHE = "sintel-music-offline";
  var MEDIA_CATS = { videos: 1, photos: 1, live: 1, music: 1 };
  var COLORS = {
    videos: "#3390ec",
    photos: "#53b35b",
    live: "#e85d4c",
    music: "#a46cff",
    feeds: "#e8a33d",
    profiles: "#d48b5a",
    threads: "#c46b8a",
    search: "#7d8cff",
    explore: "#e0c45a",
    notifications: "#ef6d8a",
    shorts: "#ff8a3d",
    lives: "#d96b4c",
    messages: "#5ac8fa",
    drafts: "#9aa0a6",
    other: "#8e8e93"
  };
  var ORDER = ["videos", "photos", "live", "music", "feeds", "profiles", "threads", "search", "explore", "notifications", "shorts", "lives", "messages", "drafts", "other"];
  var RANGE_LIMIT = 48 * 1024 * 1024;
  var policy = null;
  var snap = null;
  var measuring = false;

  function tr(key, vars) {
    var fn = (typeof self !== "undefined" && self.t) ? self.t : null;
    if (!fn && typeof window !== "undefined" && window.t) fn = window.t;
    return fn ? fn(key, vars) : key;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  function toUrl(value) {
    if (!value) return null;
    if (typeof value !== "string") {
      try { return new URL(value.href || value.url); } catch (err) { return null; }
    }
    try { return new URL(value, "https://app.local"); } catch (err) { return null; }
  }

  function tiktokHost(host) {
    var name = String(host || "").toLowerCase();
    return /(^|\.)tiktokcdn(?:-us|-eu)?\.com$/.test(name) || /(^|\.)bytefcdn(?:-oversea)?\.com$/.test(name) || /(^|\.)tiktokv\.com$/.test(name);
  }

  function blockedPath(url) {
    var path = url.pathname || "";
    if (/\/version\.json$/i.test(path)) return true;
    if (/owner-keys/i.test(path)) return true;
    if (/\/v1\/owner\/play$/i.test(path)) return true;
    if (/\/v1\/(?:session|login|logout|logout-all|auth|account|me)(?:\/|$)/i.test(path)) return true;
    if (/\/v1\/(?:notifications|push|channel|presence)(?:\/|$)/i.test(path)) return true;
    if (/\/v1\/owner\/keys(?:\/|$)/i.test(path)) return true;
    if (/\/tg\/loop\//i.test(path)) return true;
    if (/\/loop\/current\.json$/i.test(path)) return true;
    if (/\/loop\/v[^/]+\//i.test(path)) return true;
    if (/\/v1\/pills\//i.test(path)) return true;
    var host = String(url.hostname || "").toLowerCase();
    if (/(^|\.)open-meteo\.com$/.test(host) || /(^|\.)espn\.com$/.test(host) || /(^|\.)thesportsdb\.com$/.test(host) || /(^|\.)met\.no$/.test(host)) return true;
    return false;
  }

  function categoryOf(value) {
    var url = toUrl(value);
    if (!url || blockedPath(url) || tiktokHost(url.hostname)) return "";
    var path = url.pathname || "";
    var host = String(url.hostname || "").toLowerCase();
    if (/discord/i.test(host) || /\/discord\//i.test(path) || /\/tg\/social\//i.test(path)) return "messages";
    if (/record|\/live\//i.test(path)) return "live";
    if (/\/(?:past-lives|lives)(?:\/|$)/i.test(path) && !/\.(mp4|webm|mov|m4s|ts|mp3|m4a)$/i.test(path)) return "lives";
    if (/\/music\//i.test(path) || /\.(mp3|m4a|aac|flac|ogg|opus)$/i.test(path)) return "music";
    if (/\.(mp4|webm|mov|m4s|ts|cmfv|cmfa)$/i.test(path) || host.indexOf("video.twimg.com") >= 0) return "videos";
    if (/\/v1\/media\/(?:view\/[a-f0-9]{32}|(?:avatars|banners)\/)/i.test(path)) return "other";
    if (/\.(png|jpe?g|gif|webp|avif)$/i.test(path) || /(^|\.)pbs\.twimg\.com$/.test(host) || host === "i.ytimg.com" || /(^|\.)ggpht\.com$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host) || /(^|\.)cdninstagram\.com$/.test(host) || /(^|\.)fbcdn\.net$/.test(host)) return "photos";
    if (/\/notifications(?:\/|$)/i.test(path)) return "notifications";
    if (/\/shorts(?:\/|$)/i.test(path) && !/\.(mp4|webm|mov|m4s|ts|png|jpe?g|gif|webp|avif)$/i.test(path)) return "shorts";
    if (/\/(?:search|recent-searches)(?:\/|$)/i.test(path)) return "search";
    if (/\/(?:explore|trends)(?:\/|$)/i.test(path)) return "explore";
    if (/\/(?:messages|dm)(?:\/|$)/i.test(path)) return "messages";
    if (/\/(?:profile|profiles|people|users)(?:\/|$|\.)/i.test(path)) return "profiles";
    if (/\/(?:status|statuses|thread|replies|posts)(?:\/|$)/i.test(path)) return "threads";
    if (/\/drafts(?:\/|$)/i.test(path)) return "drafts";
    if (/\.json$/i.test(path) || /\/(?:feeds|suggestions|stories)\.json$/i.test(path)) return "feeds";
    if (/\/tg\//i.test(path)) return "videos";
    return "other";
  }

  function shouldCacheMedia(value) {
    var url = toUrl(value);
    if (!url || tiktokHost(url.hostname) || blockedPath(url)) return false;
    var path = url.pathname || "";
    if (/\.(m3u8|json)$/i.test(path)) return false;
    if (/\/v1\/media\/(?:view\/[a-f0-9]{32}|(?:avatars|banners)\/\d{12}\/)/i.test(path)) return false;
    // Synced social and TikTok media on /tg has no file extension, but each key and
    // part number is written once, so a device can keep its copy.
    if (/\/tg\/(?:social|tiktok)\/.+\/(?:photo|image|video|gif|animated_gif|thumb|poster|cover|media)(?:\/\d+(?:\/(?:\d+|init))?)?$/i.test(path)) return true;
    var cat = categoryOf(url);
    if (cat === "videos" || cat === "photos" || cat === "live" || cat === "music") return true;
    return cat === "messages" && /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|m4s|ts|cmfv|cmfa)$/i.test(path);
  }

  function feedV1(path) {
    return /\/v1\/(?:notifications|feed|feeds|timeline|home|following|lists|communities|profile|profiles|users|status|statuses|posts|thread|replies|search|trends|explore|messages|dm|shorts|music|live|drafts)(?:\/|$)/i.test(path);
  }

  function shouldCacheFeed(value) {
    var url = toUrl(value);
    if (!url || blockedPath(url) || tiktokHost(url.hostname)) return false;
    if (shouldCacheMedia(url)) return false;
    var path = url.pathname || "";
    if (/\/v1\/presence(?:\/|$|\?)/i.test(path) || /\/v1\/channel(?:\/|$|\?)/i.test(path)) return false;
    if (/\/v1\//i.test(path) && !feedV1(path) && !/\/v1\/owner\/tiktok\/recordings$/i.test(path)) return false;
    var cat = categoryOf(url);
    if (cat === "feeds" || cat === "messages" || cat === "profiles" || cat === "threads" || cat === "search" || cat === "explore" || cat === "notifications" || cat === "shorts" || cat === "drafts" || cat === "lives") {
      return /\.json$/i.test(path) || /\/v1\//i.test(path);
    }
    return cat === "live" && /\.json$/i.test(path);
  }

  function revalidateAction(status) {
    if (status === 304) return "keep";
    if (status === 206) return "skip";
    if (status >= 200 && status < 300) return "store";
    return "skip";
  }

  function keepMs(keep) {
    if (keep === "3d") return 3 * 24 * 60 * 60 * 1000;
    if (keep === "month") return 30 * 24 * 60 * 60 * 1000;
    if (keep === "forever") return Infinity;
    return 7 * 24 * 60 * 60 * 1000;
  }

  function defaultMaxBytes(quota) {
    var budget = Number(quota) > 0 ? Math.floor(Number(quota) * 0.2) : 0;
    if (!budget) return 5 * GB;
    var pick = DEFAULT_STEPS[0];
    if (budget < pick) return pick;
    for (var i = 0; i < DEFAULT_STEPS.length; i++) {
      if (DEFAULT_STEPS[i] <= budget) pick = DEFAULT_STEPS[i];
    }
    return pick;
  }

  /* Largest slider step at or under a byte cap (256 MB -> 250 MB). */
  function floorStep(bytes) {
    var pick = MAX_STEPS[0];
    for (var i = 0; i < MAX_STEPS.length; i++) if (MAX_STEPS[i] <= bytes) pick = MAX_STEPS[i];
    return pick;
  }

  function normalizePolicy(raw, quota) {
    var fallback = defaultMaxBytes(quota);
    var keep = raw && (raw.keep === "3d" || raw.keep === "week" || raw.keep === "month" || raw.keep === "forever") ? raw.keep : "week";
    var prefetch = !(raw && raw.prefetch === false);
    if (raw && raw.unlimited) return { keep: keep, maxBytes: 0, unlimited: true, prefetch: prefetch, picked: !!raw.picked };
    var maxBytes = raw ? Number(raw.maxBytes) : 0;
    if (MAX_STEPS.indexOf(maxBytes) < 0) maxBytes = fallback;
    /* A size the person picked on the slider wins over the device
       preset's cap. The cap only lowers the automatic default. */
    var picked = !!(raw && raw.picked && MAX_STEPS.indexOf(Number(raw.maxBytes)) >= 0);
    if (picked) return { keep: keep, maxBytes: maxBytes, unlimited: false, prefetch: prefetch, picked: true };
    var dev = null;
    if (typeof self !== "undefined" && self.ViktorychDevice) dev = self.ViktorychDevice;
    else if (typeof window !== "undefined" && window.ViktorychDevice) dev = window.ViktorychDevice;
    var cap = dev && dev.capForPolicy ? Number(dev.capForPolicy()) : 0;
    if (cap > 0 && maxBytes > cap) maxBytes = floorStep(cap);
    return { keep: keep, maxBytes: maxBytes, unlimited: false, prefetch: prefetch, picked: false };
  }

  function planEviction(rows, maxBytes, now, keepFor) {
    var dropped = [];
    var pinned = [];
    var pool = [];
    var list = rows || [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!row || !row.url) continue;
      if (row.cacheName === PINNED_CACHE || row.category === "drafts") {
        pinned.push(row);
        continue;
      }
      var born = row.saved || row.at || now;
      if (MEDIA_CATS[row.category] && keepFor !== Infinity && now - born >= keepFor) dropped.push(row);
      else pool.push(row);
    }
    pool.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var total = 0;
    for (var j = 0; j < pool.length; j++) total += pool[j].bytes || 0;
    if (maxBytes && maxBytes < Infinity) {
      while (total > maxBytes && pool.length) {
        var old = pool.shift();
        total -= old.bytes || 0;
        dropped.push(old);
      }
    }
    var kept = pinned.concat(pool);
    var shown = 0;
    for (var n = 0; n < kept.length; n++) shown += kept[n].bytes || 0;
    return { keep: kept, drop: dropped, total: shown };
  }

  function mediaFresh(row, savedPolicy, now) {
    if (!row) return true;
    if (row.cacheName === PINNED_CACHE) return true;
    if (!MEDIA_CATS[row.category]) return true;
    var windowMs = keepMs(savedPolicy && savedPolicy.keep);
    if (windowMs === Infinity) return true;
    var born = row.saved || row.at || now;
    return now - born < windowMs;
  }

  function parseByteRange(header, size) {
    var match = /^bytes=(\d*)-(\d*)$/i.exec(String(header || "").trim());
    if (!match || size < 1) return null;
    var start = match[1] === "" ? null : Number(match[1]);
    var end = match[2] === "" ? null : Number(match[2]);
    if (start === null && end === null) return null;
    if (start !== null && (!isFinite(start) || start < 0)) return null;
    if (end !== null && (!isFinite(end) || end < 0)) return null;
    if (start === null) {
      var tail = end;
      if (!tail) return null;
      start = Math.max(0, size - tail);
      end = size - 1;
    } else if (end === null || end >= size) {
      end = size - 1;
    }
    if (start >= size || end < start) return null;
    return { start: start, end: end };
  }

  function rangeResponse(buffer, range, type) {
    var slice = buffer.slice(range.start, range.end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": type || "application/octet-stream",
        "Content-Length": String(slice.byteLength),
        "Content-Range": "bytes " + range.start + "-" + range.end + "/" + buffer.byteLength,
        "Accept-Ranges": "bytes"
      }
    });
  }

  function sliceCached(response, rangeHeader) {
    if (!response || !rangeHeader) return Promise.resolve(response || null);
    var declared = Number(response.headers.get("content-length")) || 0;
    if (declared > RANGE_LIMIT) return Promise.resolve(null);
    return response.clone().arrayBuffer().then(function (buffer) {
      if (!buffer || buffer.byteLength > RANGE_LIMIT) return null;
      var range = parseByteRange(rangeHeader, buffer.byteLength);
      if (!range) return new Response(buffer, { status: 200, headers: { "Content-Type": response.headers.get("content-type") || "application/octet-stream", "Content-Length": String(buffer.byteLength), "Accept-Ranges": "bytes" } });
      return rangeResponse(buffer, range, response.headers.get("content-type"));
    }).catch(function () { return null; });
  }

  function byteLengthOf(res) {
    if (!res) return 0;
    if (res.type === "opaque") return 200 * 1024;
    var n = Number(res.headers && res.headers.get && res.headers.get("content-length"));
    if (n > 0) return n;
    return 80 * 1024;
  }

  function formatBytes(n) {
    var value = Number(n) || 0;
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + " KB";
    if (value < GB) return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + " MB";
    var gb = value / GB;
    return (gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)) + " GB";
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
        if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs");
        if (!db.objectStoreNames.contains("actions")) db.createObjectStore("actions");
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function metaGet(db, key) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction("meta", "readonly");
        var req = tx.objectStore("meta").get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(undefined); };
      } catch (err) { resolve(undefined); }
    });
  }

  function metaSet(db, key, value) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (err) { resolve(); }
    });
  }

  function readPolicy(db) {
    return metaGet(db, "storage-policy").then(function (raw) { return normalizePolicy(raw); });
  }

  function writePolicy(db, next) {
    var clean = normalizePolicy(next);
    return metaSet(db, "storage-policy", clean).then(function () { return clean; });
  }

  function getFile(db, url) {
    return new Promise(function (resolve) {
      try {
        var req = db.transaction("files", "readonly").objectStore("files").get(url);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { resolve(null); };
      } catch (err) { resolve(null); }
    });
  }

  function putFile(db, row) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction("files", "readwrite");
        tx.objectStore("files").put(row, row.url);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (err) { resolve(); }
    });
  }

  function listFiles(db) {
    return new Promise(function (resolve) {
      try {
        var req = db.transaction("files", "readonly").objectStore("files").getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      } catch (err) { resolve([]); }
    });
  }

  function replaceFiles(db, rows) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction("files", "readwrite");
        var store = tx.objectStore("files");
        store.clear();
        (rows || []).forEach(function (row) { if (row && row.url) store.put(row, row.url); });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (err) { resolve(); }
    });
  }

  function touch(db, url) {
    return getFile(db, url).then(function (row) {
      if (!row) return null;
      row.at = Date.now();
      return putFile(db, row).then(function () { return row; });
    });
  }

  function emptyStats(stats) {
    var src = stats && typeof stats === "object" ? stats : {};
    return {
      hits: Number(src.hits) || 0,
      network: Number(src.network) || 0,
      savedBytes: Number(src.savedBytes) || 0,
      savedRequests: Number(src.savedRequests) || 0,
      direct: Number(src.direct) || 0,
      server: Number(src.server) || 0,
      peerBytes: Number(src.peerBytes) || 0,
      originBytes: Number(src.originBytes) || 0
    };
  }

  function byteStat(field) {
    return field === "savedBytes" || field === "peerBytes" || field === "originBytes";
  }

  function bump(db, field, amount) {
    return metaGet(db, "storage-stats").then(function (stats) {
      var next = emptyStats(stats);
      if (byteStat(field)) next[field] += Math.max(0, Number(amount) || 0);
      else if (field === "savedRequests") next.savedRequests += 1;
      else next[field] = (Number(next[field]) || 0) + 1;
      return metaSet(db, "storage-stats", next).then(function () { return next; });
    });
  }

  function noteTransfer(db, field, bytes) {
    if (!byteStat(field) || field === "savedBytes") return Promise.resolve(null);
    return bump(db, field, bytes);
  }

  function rangeCacheUrl(url, rangeHeader) {
    var match = /^bytes=(\d+)-(\d+)$/i.exec(String(rangeHeader || "").trim());
    if (!match) return "";
    var start = Number(match[1]);
    var end = Number(match[2]);
    if (!isFinite(start) || !isFinite(end) || end < start) return "";
    if ((end - start + 1) > RANGE_LIMIT) return "";
    try {
      var parsed = new URL(String(url || ""), "https://local.invalid");
      parsed.searchParams.set("vkrange", start + "-" + end);
      return parsed.href;
    } catch (err) {
      return "";
    }
  }

  function cacheableRange(rangeHeader, size) {
    var match = /^bytes=(\d+)-(\d+)$/i.exec(String(rangeHeader || "").trim());
    if (!match) return false;
    var start = Number(match[1]);
    var end = Number(match[2]);
    var len = end - start + 1;
    if (!isFinite(len) || len < 1 || len > RANGE_LIMIT) return false;
    if (size && Number(size) > 0 && len > RANGE_LIMIT) return false;
    return true;
  }

  function readStats(db) {
    return metaGet(db, "storage-stats").then(function (stats) { return emptyStats(stats); });
  }

  function hitRate(stats) {
    var hits = Number(stats && stats.hits) || 0;
    var network = Number(stats && stats.network) || 0;
    var total = hits + network;
    if (!total) return 0;
    return Math.round(hits / total * 100);
  }

  function docKey(category, id) {
    return "idb:" + category + ":" + id;
  }

  function putDoc(db, doc) {
    if (!doc || !doc.category || doc.id == null) return Promise.resolve();
    var key = docKey(doc.category, doc.id);
    var text = "";
    try { text = JSON.stringify(doc.body == null ? null : doc.body); } catch (err) { text = ""; }
    var now = Date.now();
    var row = {
      category: doc.category,
      id: String(doc.id),
      body: doc.body == null ? null : doc.body,
      etag: doc.etag || "",
      at: doc.at || now,
      saved: doc.saved || now,
      bytes: Number(doc.bytes) || text.length
    };
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(["docs", "files"], "readwrite");
        tx.objectStore("docs").put(row, key);
        tx.objectStore("files").put({
          url: key,
          bytes: row.bytes,
          category: row.category,
          at: row.at,
          saved: row.saved,
          cacheName: "idb-docs"
        }, key);
        tx.oncomplete = function () { resolve(row); };
        tx.onerror = function () { resolve(row); };
      } catch (err) { resolve(row); }
    });
  }

  function listDocs(db) {
    return new Promise(function (resolve) {
      try {
        if (!db.objectStoreNames.contains("docs")) { resolve([]); return; }
        var req = db.transaction("docs", "readonly").objectStore("docs").getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { resolve([]); };
      } catch (err) { resolve([]); }
    });
  }

  function deleteDoc(db, url) {
    return new Promise(function (resolve) {
      try {
        if (!db.objectStoreNames.contains("docs")) { resolve(); return; }
        var tx = db.transaction("docs", "readwrite");
        tx.objectStore("docs").delete(url);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (err) { resolve(); }
    });
  }

  function clearDocs(db, category) {
    return listDocs(db).then(function (docs) {
      return new Promise(function (resolve) {
        try {
          if (!db.objectStoreNames.contains("docs")) { resolve(); return; }
          var tx = db.transaction(["docs", "actions"], "readwrite");
          var store = tx.objectStore("docs");
          if (category === "all") {
            store.clear();
            try { tx.objectStore("actions").clear(); } catch (err) { /* the queue store may be missing */ }
          } else {
            (docs || []).forEach(function (doc) {
              if (doc && doc.category === category) store.delete(docKey(doc.category, doc.id));
            });
          }
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (err) { resolve(); }
      });
    });
  }

  function mergeDocRows(rows, docs) {
    var seen = {};
    (rows || []).forEach(function (row) { if (row && row.url) seen[row.url] = true; });
    (docs || []).forEach(function (doc) {
      if (!doc || !doc.category || doc.id == null) return;
      var url = docKey(doc.category, doc.id);
      if (seen[url]) return;
      rows.push({
        url: url,
        bytes: doc.bytes || 0,
        category: ORDER.indexOf(doc.category) >= 0 ? doc.category : "other",
        cacheName: "idb-docs",
        at: doc.at || Date.now(),
        saved: doc.saved || doc.at || Date.now()
      });
    });
    return rows;
  }

  function currentPolicy() {
    return policy || normalizePolicy(null);
  }

  function loadLocal() {
    try {
      var raw = localStorage.getItem(POLICY_KEY);
      if (!raw) return null;
      return normalizePolicy(JSON.parse(raw));
    } catch (err) {
      try { localStorage.removeItem(POLICY_KEY); } catch (ignore) { /* the next open uses the default policy */ }
      return null;
    }
  }

  function saveLocal(next) {
    policy = normalizePolicy(next);
    try { localStorage.setItem(POLICY_KEY, JSON.stringify(policy)); } catch (err) { /* private mode */ }
    openDb().then(function (db) { return writePolicy(db, policy); }).catch(function () {});
    post({ type: "storage-policy", policy: policy });
    return policy;
  }

  function post(msg) {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    var send = function (worker) { try { if (worker) worker.postMessage(msg); } catch (err) { /* the worker may be restarting */ } };
    try { if (navigator.serviceWorker.controller) send(navigator.serviceWorker.controller); } catch (err) { /* ignore */ }
    navigator.serviceWorker.ready.then(function (reg) { if (reg && reg.active) send(reg.active); }).catch(function () {});
  }

  var persistState = "unknown";
  var pressureState = "unknown";

  function pressureLevel(usage, quota) {
    usage = Number(usage) || 0;
    quota = Number(quota) || 0;
    if (quota <= 0) return "unknown";
    var ratio = usage / quota;
    if (ratio >= 0.9) return "critical";
    if (ratio >= 0.75) return "warning";
    return "ok";
  }

  function persistText(measured) {
    if (measured === true || persistState === "granted") return tr("Kept on this device");
    if (persistState === "unsupported") return tr("Persistent storage isn’t available in this browser.");
    return tr("This browser can clear saved media when space is low.");
  }

  function notePressure(level) {
    pressureState = level || "unknown";
    if (level !== "critical" && level !== "warning") return;
    try { document.dispatchEvent(new CustomEvent("viktorych-pressure", { detail: level })); } catch (err) { /* the storage screen still shows the level */ }
    if (level === "critical") post({ type: "storage-pressure" });
  }

  function askPersist() {
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.persist) {
      persistState = "unsupported";
      requestRender();
      return Promise.resolve(false);
    }
    /* persist() and the redraw it triggers were landing inside a scroll
       (about 80ms). Wait until scrolling has been quiet. */
    if (askPersist.pending) return askPersist.pending;
    askPersist.pending = new Promise(function (resolve) {
      var run = function () {
        navigator.storage.persist().then(function (ok) {
          persistState = ok ? "granted" : "denied";
          setTimeout(function () { requestRender(); }, 0);
          resolve(!!ok);
        }).catch(function () {
          persistState = "denied";
          resolve(false);
        });
      };
      if (typeof window === "undefined" || !window.addEventListener) { setTimeout(run, 0); return; }
      var timer = 0;
      var kick = function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          window.removeEventListener("scroll", kick);
          run();
        }, 700);
      };
      window.addEventListener("scroll", kick, { passive: true });
      kick();
    });
    return askPersist.pending;
  }

  /* Slider stops: every step that fits this device's quota, the saved
     size even if it does not, then Unlimited. */
  function sliderSteps(quota, saved) {
    quota = Number(quota) || 0;
    var list = MAX_STEPS.filter(function (b) { return !quota || b <= quota; });
    var cur = saved && !saved.unlimited ? Number(saved.maxBytes) : 0;
    if (cur > 0 && list.indexOf(cur) < 0) list.push(cur);
    if (!list.length) list.push(MAX_STEPS[0]);
    list.sort(function (a, b) { return a - b; });
    return list;
  }

  function stepIndex(saved, steps) {
    steps = steps || MAX_STEPS;
    if (saved && saved.unlimited) return steps.length;
    var found = steps.indexOf(saved && saved.maxBytes);
    if (found >= 0) return found;
    var near = 0;
    for (var i = 0; i < steps.length; i++) if (steps[i] <= Number(saved && saved.maxBytes)) near = i;
    return near;
  }

  function sizeLabel(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < GB) return tr(Math.round(bytes / MB) + " MB");
    return tr((Math.round(bytes / GB * 10) / 10) + " GB");
  }

  function stepLabel(index, steps) {
    steps = steps || MAX_STEPS;
    if (index >= steps.length) return tr("Unlimited");
    return sizeLabel(steps[index]);
  }

  function policyLabel(saved) {
    return saved && saved.unlimited ? tr("Unlimited") : sizeLabel(saved && saved.maxBytes);
  }

  function readSteps(el) {
    var raw = String(el && el.getAttribute("data-steps") || "");
    var list = raw.split(",").map(Number).filter(function (n) { return n > 0; });
    return list.length ? list : MAX_STEPS;
  }

  function keepLabel(keep) {
    if (keep === "3d") return tr("3 days");
    if (keep === "month") return tr("1 month");
    if (keep === "forever") return tr("Forever");
    return tr("1 week");
  }

  function catLabel(cat) {
    if (cat === "videos") return tr("Videos");
    if (cat === "photos") return tr("Photos");
    if (cat === "live") return tr("Live recordings");
    if (cat === "music") return tr("Music");
    if (cat === "feeds") return tr("Feeds and posts");
    if (cat === "profiles") return tr("Profiles");
    if (cat === "threads") return tr("Post threads");
    if (cat === "search") return tr("Recent searches");
    if (cat === "explore") return tr("Trends and explore");
    if (cat === "notifications") return tr("Notifications");
    if (cat === "shorts") return tr("Shorts");
    if (cat === "lives") return tr("Past lives");
    if (cat === "messages") return tr("Messages");
    if (cat === "drafts") return tr("Drafts");
    return tr("Other");
  }

  function requestRender() {
    var accounts = typeof window !== "undefined" && window.ViktorychAccounts;
    if (accounts && accounts.requestRender) accounts.requestRender("background");
  }

  function responseBytes(res) {
    if (!res) return Promise.resolve(0);
    var n = Number(res.headers.get("content-length"));
    if (n > 0) return Promise.resolve(n);
    if (res.type === "opaque") return Promise.resolve(200 * 1024);
    return res.clone().blob().then(function (blob) { return blob.size || 0; }).catch(function () { return byteLengthOf(res); });
  }

  function storeKind(name) {
    if (/^shell-/.test(name)) return "app";
    if (/^data-/.test(name)) return "data";
    if (/^media-/.test(name)) return "media";
    if (/^live-/.test(name)) return "liveparts";
    if (name === PINNED_CACHE) return "downloads";
    if (name === "viktorych-prefs") return "prefs";
    return "othercache";
  }

  function noDb() { return Promise.resolve(null); }

  function measureCaches(known) {
    var rows = [];
    var tally = {};
    if (typeof caches === "undefined") return Promise.resolve({ rows: rows, tally: tally });
    return caches.keys().then(function (names) {
      var chain = Promise.resolve();
      names.forEach(function (name) {
        var kind = storeKind(name);
        chain = chain.then(function () {
          return caches.open(name).then(function (cache) { return cache.keys().then(function (reqs) { return { cache: cache, reqs: reqs }; }); });
        }).then(function (opened) {
          var inner = Promise.resolve();
          opened.reqs.forEach(function (req) {
            inner = inner.then(function () {
              var app = kind === "app" || kind === "prefs";
              var cat = app ? "" : categoryOf(req.url);
              if (!app && !cat) return opened.cache.delete(req);
              return opened.cache.match(req).then(function (res) {
                var opaque = !!(res && res.type === "opaque");
                return responseBytes(res).then(function (bytes) {
                  var t = tally[kind] || (tally[kind] = { bytes: 0, count: 0, opaque: 0 });
                  t.bytes += bytes;
                  t.count += 1;
                  if (opaque) t.opaque += 1;
                  if (app) return;
                  var old = known[req.url];
                  var now = Date.now();
                  rows.push({ url: req.url, bytes: bytes, category: cat, cacheName: name, at: old && old.at ? old.at : now, saved: old && old.saved ? old.saved : now });
                });
              });
            });
          });
          return inner;
        }).catch(function () { /* one unreadable cache must not hide the rest */ });
      });
      return chain.then(function () { return { rows: rows, tally: tally }; });
    }).catch(function () { return { rows: rows, tally: tally }; });
  }

  function measureOpfs() {
    try {
      if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.getDirectory !== "function") return Promise.resolve(null);
      return navigator.storage.getDirectory().then(function (root) {
        return root.getDirectoryHandle("vapp-media");
      }).then(function (dir) {
        if (!dir || !dir.values) return null;
        var iter = dir.values();
        var out = { bytes: 0, count: 0 };
        var walk = function () {
          return iter.next().then(function (step) {
            if (step.done) return out;
            var handle = step.value;
            if (!handle || handle.kind !== "file") return walk();
            return handle.getFile().then(function (file) { out.bytes += file.size || 0; out.count += 1; }).catch(function () {}).then(walk);
          });
        };
        return walk();
      }).catch(function () { return null; });
    } catch (err) { return Promise.resolve(null); }
  }

  function listDatabases() {
    try {
      if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return Promise.resolve(null);
      return indexedDB.databases().then(function (list) { return (list || []).map(function (d) { return d && d.name; }).filter(Boolean); }).catch(function () { return null; });
    } catch (err) { return Promise.resolve(null); }
  }

  function localBudget() {
    return typeof self !== "undefined" && self.ViktorychLocalBudget ? self.ViktorychLocalBudget : null;
  }

  /* localStorage size in the units the browser counts against its limit:
     one per character of key plus value. */
  function localBytes() {
    try {
      if (typeof localStorage === "undefined") return 0;
      var budget = localBudget();
      if (budget) return budget.measure(localStorage).total;
      var n = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i) || "";
        n += key.length + String(localStorage.getItem(key) || "").length;
      }
      return n;
    } catch (err) { return 0; }
  }

  var LOCAL_COLORS = { settings: "#1d9bf0", snapshots: "#e8a33d", caches: "#53b35b", legacy: "#a46cff", other: "#8e8e93" };

  function localCatLabel(cat) {
    if (cat === "settings") return tr("Settings, drafts and sign-in");
    if (cat === "snapshots") return tr("Saved screens");
    if (cat === "caches") return tr("Small caches");
    if (cat === "legacy") return tr("Old copies");
    return tr("Other pages on this address");
  }

  function localCatNote(cat) {
    if (cat === "settings") return tr("Never cleared here");
    if (cat === "snapshots") return tr("Pages you opened, so they show at once. Rebuilt as you browse");
    if (cat === "caches") return tr("Link previews, translations and profile headers. Rebuilt when needed");
    if (cat === "legacy") return tr("Duplicates left by older versions of the app");
    return tr("Saved by other pages on the same address. Not cleared here");
  }

  /* Settings storage (localStorage): what fills it and a button that clears
     only what the app can rebuild. The "Saved settings are full" alert
     opens this section. */
  function localHtml() {
    var budget = localBudget();
    if (!budget || typeof localStorage === "undefined") return "";
    var read = null;
    try { read = budget.reading(localStorage, typeof navigator !== "undefined" ? navigator : null); } catch (err) { read = null; }
    if (!read) return "";
    var pct = Math.min(100, Math.round(read.pct));
    var rows = budget.ORDER.map(function (cat) {
      var row = read.by[cat] || { units: 0, count: 0 };
      if (!row.units && cat !== "settings") return "";
      var width = read.used && row.units ? Math.max(2, Math.round(row.units / read.used * 100)) : 0;
      var clear = budget.safeToClear(cat) && row.units ? '<button class="outline stor-clear" type="button" data-stor="local-clear" data-cat="' + cat + '">' + esc(tr("Clear")) + "</button>" : "";
      return '<div class="stor-row" data-local-cat="' + cat + '"><i class="stor-swatch" style="background:' + LOCAL_COLORS[cat] + '"></i><div class="stor-meta"><b>' + esc(localCatLabel(cat)) + '</b><span class="stor-sub">' + esc(localCatNote(cat)) + '</span><div class="stor-bar"><i style="width:' + width + "%;background:" + LOCAL_COLORS[cat] + '"></i></div></div><span class="stor-size">' + esc(formatBytes(row.units)) + "</span>" + clear + "</div>";
    }).join("");
    var free = read.safe > 0
      ? '<button class="outline" type="button" data-stor="local-clear" data-cat="all">' + esc(tr("Free up {size}", { size: formatBytes(read.safe) })) + "</button>"
      : '<p class="phandle">' + esc(tr("Nothing to clear. Only settings are saved here.")) + "</p>";
    return '<div class="set-block stor-section" id="stor-local"><h2>' + esc(tr("Settings storage")) + '</h2><p class="phandle">' +
      esc(tr("{used} of about {limit} ({pct}%)", { used: formatBytes(read.used), limit: formatBytes(read.limit), pct: String(pct) })) + "</p></div>" +
      '<div class="stor-list">' + rows + "</div>" + '<div class="set-block stor-local-actions">' + free + "</div>";
  }

  function clearLocal(cat) {
    var budget = localBudget();
    if (!budget || typeof localStorage === "undefined") return 0;
    var freed = budget.clearSafe(localStorage, cat === "all" ? "" : cat);
    var alerts = typeof self !== "undefined" ? self.ViktorychSettingAlerts : null;
    if (alerts && alerts.check) { try { alerts.check(); } catch (err) { /* the next check runs on its own */ } }
    return freed;
  }

  function measureNow() {
    var dbPromise = typeof indexedDB === "undefined" ? noDb() : openDb().catch(noDb);
    return dbPromise.then(function (db) {
      var prevP = db ? listFiles(db) : Promise.resolve([]);
      return prevP.then(function (prev) {
        var known = {};
        prev.forEach(function (row) { if (row && row.url) known[row.url] = row; });
        return Promise.all([measureCaches(known), db ? listDocs(db) : Promise.resolve([]), measureOpfs(), listDatabases()]).then(function (parts) {
          var rows = parts[0].rows;
          // Large videos live in the origin private file system; keep their rows
          // so they stay counted and can still be evicted or cleared.
          if (parts[2] && parts[2].count) prev.forEach(function (row) { if (row && row.cacheName === "opfs") rows.push(row); });
          rows = mergeDocRows(rows, parts[1]);
          return { db: db, rows: rows, tally: parts[0].tally, opfs: parts[2], dbs: parts[3] };
        });
      });
    }).then(function (measured) {
      var write = measured.db ? replaceFiles(measured.db, measured.rows) : Promise.resolve();
      return write.then(function () {
        return measured.db ? readStats(measured.db) : Promise.resolve(emptyStats(null));
      }).then(function (stats) {
        var estimate = Promise.resolve(null);
        if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) estimate = navigator.storage.estimate().catch(function () { return null; });
        var persisted = Promise.resolve(false);
        if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persisted) persisted = navigator.storage.persisted().catch(function () { return false; });
        return Promise.all([estimate, persisted]).then(function (pair) {
          var est = pair[0] || {};
          var docBytes = 0;
          measured.rows.forEach(function (row) { if (row.cacheName === "idb-docs") docBytes += row.bytes || 0; });
          return {
            at: Date.now(),
            rows: measured.rows,
            stats: stats,
            tally: measured.tally,
            opfs: measured.opfs,
            dbs: measured.dbs,
            docBytes: docBytes,
            local: localBytes(),
            details: est.usageDetails || null,
            quota: Number(est.quota) || 0,
            usage: Number(est.usage) || 0,
            persisted: !!pair[1],
            pressure: pressureLevel(Number(est.usage) || 0, Number(est.quota) || 0)
          };
        });
      });
    });
  }

  var STORE_COLORS = { app: "#1d9bf0", data: "#e8a33d", media: "#53b35b", liveparts: "#e85d4c", downloads: "#a46cff", opfs: "#3390ec", idb: "#5ac8fa", local: "#9aa0a6", other: "#8e8e93" };

  function storeLabel(id) {
    if (id === "app") return tr("App files");
    if (id === "data") return tr("Feeds and posts");
    if (id === "media") return tr("Photos and videos");
    if (id === "liveparts") return tr("Live recordings");
    if (id === "downloads") return tr("Downloaded music");
    if (id === "opfs") return tr("Large videos");
    if (id === "idb") return tr("Databases");
    if (id === "local") return tr("Settings");
    return tr("Other browser data");
  }

  function storeNote(id) {
    if (id === "app") return tr("The app itself, so it opens offline");
    if (id === "data") return tr("Timelines, profiles and threads for offline reading");
    if (id === "media") return tr("Pictures and clips you already watched, in original quality");
    if (id === "liveparts") return tr("Parts of live streams and recordings");
    if (id === "downloads") return tr("Songs you saved for offline listening");
    if (id === "opfs") return tr("Videos over 1 MB kept as files");
    if (id === "idb") return tr("Saved posts, messages, drafts and search");
    if (id === "local") return tr("Your preferences and sign-in on this device");
    return tr("Space the browser counts but the app can’t itemize, including padding for media from other sites");
  }

  // One row per place the bytes live. Byte counts come from the files; the
  // browser's own estimate is only used for the parts the app can't read.
  function storeList(s) {
    s = s || {};
    var tally = s.tally || {};
    var details = s.details || null;
    var list = [];
    var add = function (id, bytes, count, approx) { list.push({ id: id, bytes: Math.max(0, Number(bytes) || 0), count: count || 0, approx: !!approx }); };
    var cacheSum = 0;
    ["app", "data", "media", "liveparts", "downloads"].forEach(function (id) {
      var t = tally[id] || { bytes: 0, count: 0, opaque: 0 };
      cacheSum += t.bytes;
      add(id, t.bytes, t.count, t.opaque > 0);
    });
    ["prefs", "othercache"].forEach(function (id) { if (tally[id]) cacheSum += tally[id].bytes; });
    var opfs = s.opfs || { bytes: 0, count: 0 };
    add("opfs", opfs.bytes, opfs.count, false);
    var idbBytes = details && Number(details.indexedDB) > 0 ? Number(details.indexedDB) : (Number(s.docBytes) || 0);
    add("idb", idbBytes, s.dbs ? s.dbs.length : 0, !(details && Number(details.indexedDB) > 0));
    var prefs = (tally.prefs ? tally.prefs.bytes : 0) + (tally.othercache ? tally.othercache.bytes : 0);
    add("local", (Number(s.local) || 0) + prefs, 0, false);
    var known = 0;
    list.forEach(function (row) { known += row.bytes; });
    var usage = Number(s.usage) || 0;
    // Chrome counts cross-site media with extra padding, so its total can be far
    // above the real bytes. Show the gap as its own row instead of hiding it.
    var gap = usage > known ? usage - known : 0;
    add("other", gap, 0, true);
    return { list: list, known: known, total: known + gap, usage: usage };
  }

  function storeDonut(list, total) {
    if (!total) return "background:var(--line)";
    var acc = 0;
    var stops = [];
    list.forEach(function (row) {
      if (!row.bytes) return;
      var start = acc;
      acc += row.bytes / total * 100;
      stops.push(STORE_COLORS[row.id] + " " + start.toFixed(3) + "% " + Math.min(100, acc).toFixed(3) + "%");
    });
    return stops.length ? "background:conic-gradient(" + stops.join(",") + ")" : "background:var(--line)";
  }

  var stale = false;
  var failed = false;

  function kickMeasure() {
    if (measuring) return;
    measuring = true;
    stale = false;
    measureNow().then(function (next) {
      snap = next;
      failed = false;
      measuring = false;
      notePressure(next && next.pressure);
      requestRender();
    }).catch(function () {
      measuring = false;
      failed = true;
      requestRender();
    });
  }

  function totals(rows) {
    var by = {};
    ORDER.forEach(function (cat) { by[cat] = 0; });
    var total = 0;
    (rows || []).forEach(function (row) {
      var cat = by.hasOwnProperty(row.category) ? row.category : "other";
      var bytes = row.bytes || 0;
      by[cat] += bytes;
      total += bytes;
    });
    return { by: by, total: total };
  }

  function donutStyle(by, total) {
    if (!total) return "background:var(--line)";
    var acc = 0;
    var stops = [];
    ORDER.forEach(function (cat) {
      if (!by[cat]) return;
      var start = acc;
      acc += by[cat] / total * 100;
      stops.push(COLORS[cat] + " " + start.toFixed(3) + "% " + acc.toFixed(3) + "%");
    });
    return "background:conic-gradient(" + stops.join(",") + ")";
  }

  function controlsHtml() {
    var saved = currentPolicy();
    var keep = saved.keep || "week";
    var steps = sliderSteps(quotaHint, saved);
    var index = stepIndex(saved, steps);
    var max = steps.length;
    var fill = max ? Math.round(index / max * 1000) / 10 : 0;
    var ticks = "";
    for (var t = 0; t <= max; t++) ticks += '<i class="' + (t <= index ? "on" : "") + '" style="left:' + (Math.round(t / max * 1000) / 10) + '%"></i>';
    var button = function (id, label) {
      return '<button class="outline' + (keep === id ? " on" : "") + '" type="button" data-stor="keep" data-keep="' + id + '">' + esc(label) + "</button>";
    };
    return '<div class="set-block stor-controls"><h2>' + esc(tr("Keep media")) + "</h2>" +
      '<p class="phandle">' + esc(tr("Media you have not opened in this time is removed.")) + "</p>" +
      '<div class="theme-row" role="group" aria-label="' + esc(tr("Keep media")) + '">' +
      button("3d", tr("3 days")) + button("week", tr("1 week")) + button("month", tr("1 month")) + button("forever", tr("Forever")) +
      "</div>" +
      '<div class="x-range-row stor-max-row" id="stor-max-row">' +
      '<div class="x-range-head"><h2 id="stor-max-title">' + esc(tr("Maximum cache size")) + '</h2><output class="x-range-value" id="stor-max-label" for="stor-max">' + esc(stepLabel(index, steps)) + "</output></div>" +
      '<div class="x-range-wrap"><input class="x-range stor-slider" id="stor-max" type="range" min="0" max="' + max + '" step="1" value="' + index + '" data-steps="' + steps.join(",") + '" style="--x-fill:' + fill + '%" aria-labelledby="stor-max-title" aria-valuetext="' + esc(stepLabel(index, steps)) + '">' +
      '<span class="x-range-ticks" aria-hidden="true">' + ticks + "</span></div>" +
      '<div class="x-range-scale" aria-hidden="true"><span>' + esc(stepLabel(0, steps)) + "</span><span>" + esc(tr("Unlimited")) + "</span></div></div>" +
      '<button class="outline danger" type="button" data-stor="clear-all">' + esc(tr("Clear cache")) + "</button>" +
      "<h2>" + esc(tr("Prefetch media")) + "</h2>" +
      '<p class="phandle">' + esc(tr("Prefetch the next posts when the connection is fast.")) + "</p>" +
      '<button class="outline' + (saved.prefetch === false ? "" : " on") + '" type="button" data-stor="prefetch">' + esc(tr("Prefetch media")) + "</button></div>";
  }

  function dataHtml() {
    var saved = currentPolicy();
    var sub = keepLabel(saved.keep) + " · " + policyLabel(saved);
    var pressureLine = pressureState === "critical" || pressureState === "warning" ? '<p class="phandle">' + esc(tr("Storage is nearly full on this device.")) + "</p>" : "";
    return '<div class="set-list"><a class="set-row" href="#/settings/storage/usage"><span class="set-copy"><b>' + esc(tr("Storage usage")) + "</b><span class=\"set-sub\">" + esc(sub) + '</span></span><span class="set-chev" aria-hidden="true">›</span></a></div>' +
      '<p class="phandle" id="stor-persist">' + esc(persistText(snap && snap.persisted)) + "</p>" + pressureLine + controlsHtml();
  }

  function usageHtml() {
    if ((!snap || stale) && !failed) kickMeasure();
    var rows = snap && snap.rows || [];
    var summed = totals(rows);
    var stores = storeList(snap);
    var shown = snap ? stores.known : 0;
    var free = snap && snap.quota > snap.usage ? snap.quota - snap.usage : 0;
    var freeLine;
    if (snap && snap.quota) freeLine = tr("{size} free", { size: formatBytes(free) });
    else if (measuring || (!snap && !failed)) freeLine = tr("Measuring storage…");
    else if (failed) freeLine = tr("Couldn’t measure storage in this browser.");
    else freeLine = tr("This browser doesn’t report free space.");
    var browserLine = snap && stores.usage && Math.abs(stores.usage - shown) > Math.max(1024 * 1024, shown * 0.1)
      ? '<p class="phandle stor-note">' + esc(tr("The browser counts {size} against this site’s limit.", { size: formatBytes(stores.usage) })) + "</p>"
      : "";
    var persistLine = persistText(snap && snap.persisted);
    var stats = emptyStats(snap && snap.stats);
    if (typeof window !== "undefined" && window.ViktorychDirect && window.ViktorychDirect.counts) {
      var live = window.ViktorychDirect.counts();
      stats.direct = Math.max(stats.direct || 0, Number(live.direct) || 0);
      stats.server = Math.max(stats.server || 0, Number(live.server) || 0);
    }
    var where = stores.list.filter(function (row) { return row.bytes > 0 || row.id !== "other"; }).map(function (row) {
      var width = shown && row.bytes ? Math.max(2, Math.min(100, Math.round(row.bytes / Math.max(shown, stores.total) * 100))) : 0;
      var size = (row.approx && row.bytes ? "≈ " : "") + formatBytes(row.bytes);
      var count = row.count ? " · " + (row.id === "idb" ? tr("{count} databases", { count: String(row.count) }) : tr("{count} files", { count: String(row.count) })) : "";
      return '<div class="stor-row"><i class="stor-swatch" style="background:' + STORE_COLORS[row.id] + '"></i><div class="stor-meta"><b>' + esc(storeLabel(row.id)) + '</b><span class="stor-sub">' + esc(storeNote(row.id) + count) + '</span><div class="stor-bar"><i style="width:' + width + "%;background:" + STORE_COLORS[row.id] + '"></i></div></div><span class="stor-size">' + esc(size) + "</span></div>";
    }).join("");
    var list = ORDER.map(function (cat) {
      var bytes = summed.by[cat] || 0;
      var width = summed.total && bytes ? Math.max(2, Math.round(bytes / summed.total * 100)) : 0;
      var clear = bytes ? '<button class="outline stor-clear" type="button" data-stor="clear" data-cat="' + cat + '">' + esc(tr("Clear")) + "</button>" : "";
      return '<div class="stor-row' + (bytes ? "" : " is-empty") + '"><i class="stor-swatch" style="background:' + COLORS[cat] + '"></i><div class="stor-meta"><b>' + esc(catLabel(cat)) + '</b><div class="stor-bar"><i style="width:' + width + "%;background:" + COLORS[cat] + '"></i></div></div><span class="stor-size">' + esc(formatBytes(bytes)) + "</span>" + clear + "</div>";
    }).join("");
    var retry = failed ? '<button class="outline" type="button" data-stor="remeasure">' + esc(tr("Try again")) + "</button>" : "";
    var label = snap ? formatBytes(shown) : "…";
    return '<div class="stor-hero"><div class="stor-donut" style="' + storeDonut(stores.list, Math.max(shown, 1)) + '" role="img" aria-label="' + esc(tr("{size} used", { size: label })) + '"><div class="stor-hole"><b>' + esc(label) + "</b><span>" + esc(tr("Used on this device")) + "</span></div></div>" +
      '<p class="stor-free">' + esc(freeLine) + "</p>" + browserLine + '<p class="phandle">' + esc(persistLine) + "</p>" + retry + "</div>" +
      '<div class="set-block stor-section"><h2>' + esc(tr("Where it’s stored")) + '</h2></div><div class="stor-list">' + where + "</div>" +
      '<div class="set-block stor-section"><h2>' + esc(tr("What’s saved")) + '</h2></div><div class="stor-list">' + list + "</div>" + localHtml() + controlsHtml() +
      '<p class="stor-debug">' + esc(tr("Cache hits {count}", { count: String(stats.hits) })) + " · " + esc(tr("Network requests {count}", { count: String(stats.network) })) + " · " + esc(tr("Hit rate {percent}", { percent: hitRate(stats) + "%" })) + " · " + esc(tr("Saved {size}", { size: formatBytes(stats.savedBytes || 0) })) + " · " + esc(tr("Saved requests {count}", { count: String(stats.savedRequests || 0) })) + " · " + esc(tr("Direct {count}", { count: String(stats.direct || 0) })) + " · " + esc(tr("Server {count}", { count: String(stats.server || 0) })) + " · " + esc(tr("From peers {size}", { size: formatBytes(stats.peerBytes || 0) })) + " · " + esc(tr("From origin {size}", { size: formatBytes(stats.originBytes || 0) })) + "</p>";
  }

  // "all" is the Clear cache button: it keeps settings, drafts and downloaded
  // music. "wipe" (sign-out or account deletion) removes those too.
  function clearStored(category) {
    var wipe = category === "wipe";
    var all = wipe || category === "all";
    var keepCache = function (name) {
      if (/^shell-/.test(name) || name === "viktorych-prefs") return true;
      return name === PINNED_CACHE && !wipe && category !== "music";
    };
    var opfsUrls = [];
    var clearCaches = function () {
      if (typeof caches === "undefined") return Promise.resolve();
      return caches.keys().then(function (names) {
        var chain = Promise.resolve();
        names.forEach(function (name) {
          if (keepCache(name)) return;
          chain = chain.then(function () {
            return caches.open(name).then(function (cache) {
              return cache.keys().then(function (reqs) {
                var inner = Promise.resolve();
                reqs.forEach(function (req) {
                  var cat = categoryOf(req.url);
                  if (all || cat === category) inner = inner.then(function () { return cache.delete(req); });
                });
                return inner;
              });
            });
          }).catch(function () { /* keep clearing the other caches */ });
        });
        return chain;
      }).catch(function () {});
    };
    var clearDb = function () {
      if (typeof indexedDB === "undefined") return Promise.resolve();
      return openDb().then(function (db) {
        return listFiles(db).then(function (rows) {
          var kept = rows.filter(function (row) {
            var hit = wipe || (all ? (row.category !== "drafts" && !(row.cacheName === PINNED_CACHE)) : row.category === category);
            if (hit && row.cacheName === "opfs") opfsUrls.push(row.url);
            return !hit;
          });
          return replaceFiles(db, kept);
        }).then(function () {
          if (wipe) return clearDocs(db, "all");
          if (all) {
            return listDocs(db).then(function (docs) {
              var cats = {};
              docs.forEach(function (doc) { if (doc && doc.category && doc.category !== "drafts") cats[doc.category] = 1; });
              var chain = Promise.resolve();
              Object.keys(cats).forEach(function (cat) { chain = chain.then(function () { return clearDocs(db, cat); }); });
              return chain;
            });
          }
          return clearDocs(db, category);
        });
      }).catch(function () {});
    };
    return clearCaches().then(clearDb).then(function () {
      if (all) post({ type: "storage-clear-opfs", all: true });
      else if (opfsUrls.length) post({ type: "storage-clear-opfs", urls: opfsUrls });
    }).then(function () {
      snap = null;
      failed = false;
      kickMeasure();
    });
  }

  function onClick(event) {
    var link = event.target && event.target.closest && event.target.closest('a[href="#/settings/storage"], a[href="#/settings/storage/usage"]');
    if (link) {
      askPersist();
      stale = true;
      failed = false;
    }
    var el = event.target && event.target.closest && event.target.closest("[data-stor]");
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    var kind = el.getAttribute("data-stor");
    if (kind === "remeasure") {
      failed = false;
      kickMeasure();
      requestRender();
      return;
    }
    if (kind === "prefetch") {
      var toggled = currentPolicy();
      toggled.prefetch = toggled.prefetch === false;
      saveLocal(toggled);
      requestRender();
      return;
    }
    if (kind === "keep") {
      var next = currentPolicy();
      next.keep = el.getAttribute("data-keep") || "week";
      saveLocal(next);
      askPersist();
      requestRender();
      return;
    }
    if (kind === "local-clear") {
      var which = el.getAttribute("data-cat") || "all";
      var ask = which === "all"
        ? tr("Clear saved screens and caches from settings storage? Your settings, drafts and sign-in stay.")
        : tr("Clear {category} from this device?", { category: localCatLabel(which) });
      if (typeof confirm === "function" && !confirm(ask)) return;
      clearLocal(which);
      stale = true;
      requestRender();
      return;
    }
    if (kind === "clear" || kind === "clear-all") {
      var cat = kind === "clear-all" ? "all" : (el.getAttribute("data-cat") || "");
      var question = cat === "all"
        ? tr("Clear everything saved for offline use on this device? Your settings, drafts and downloaded music stay.")
        : tr("Clear {category} from this device?", { category: catLabel(cat) });
      if (typeof confirm === "function" && !confirm(question)) return;
      askPersist();
      clearStored(cat);
    }
  }

  function paintSlider(el) {
    var steps = readSteps(el);
    var index = Number(el.value);
    var text = stepLabel(index, steps);
    var label = document.getElementById("stor-max-label");
    if (label) label.textContent = text;
    el.setAttribute("aria-valuetext", text);
    var wrap = el.parentNode;
    var dots = wrap && wrap.querySelectorAll ? wrap.querySelectorAll(".x-range-ticks i") : [];
    for (var i = 0; i < dots.length; i++) dots[i].className = i <= index ? "on" : "";
    var max = Number(el.max) || 1;
    el.style.setProperty("--x-fill", (Math.round(index / max * 1000) / 10) + "%");
  }

  function onInput(event) {
    var el = event.target;
    if (!el || el.id !== "stor-max") return;
    paintSlider(el);
  }

  /* Saved on every step (drag release, tap or arrow key). The saved size is
     marked as picked so the device preset's cap cannot pull it back down,
     and the cache limit alert re-checks right away. */
  function onChange(event) {
    var el = event.target;
    if (!el || el.id !== "stor-max") return;
    var saved = currentPolicy();
    var steps = readSteps(el);
    var index = Number(el.value);
    var next = index >= steps.length
      ? { keep: saved.keep, maxBytes: 0, unlimited: true, prefetch: saved.prefetch, picked: true }
      : { keep: saved.keep, maxBytes: steps[index], unlimited: false, prefetch: saved.prefetch, picked: true };
    saveLocal(next);
    paintSlider(el);
    askPersist();
    var alerts = typeof window !== "undefined" ? window.ViktorychSettingAlerts : null;
    if (alerts && alerts.check) { try { alerts.check(); } catch (err) { /* alerts re-check on their own timer */ } }
  }

  function applyDeviceCap() {
    var saved = loadLocal();
    if (saved && saved.unlimited) return policy;
    var next = normalizePolicy(saved || policy);
    policy = next;
    if (!saved || saved.maxBytes !== next.maxBytes || saved.unlimited !== next.unlimited) saveLocal(policy);
    post({ type: "storage-policy", policy: policy });
    return policy;
  }

  function start() {
    policy = loadLocal() || normalizePolicy(null);
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) { quotaHint = Number(est && est.quota) || 0; }).catch(function () {});
    }
    if (!loadLocal() && typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        if (loadLocal()) return;
        policy = normalizePolicy(null, est && est.quota);
        saveLocal(policy);
      }).catch(function () { post({ type: "storage-policy", policy: policy }); });
    } else {
      post({ type: "storage-policy", policy: policy });
    }
    document.addEventListener("click", onClick, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("change", onChange, true);
    window.addEventListener("hashchange", function () {
      // Re-measure each time the usage screen opens so the numbers are current.
      if (/^#\/settings\/storage\/usage/.test(location.hash || "")) { stale = true; failed = false; }
    });
    askPersist();
    window.addEventListener("viktorych-account-deleted", function () {
      post({ type: "storage-wipe" });
      clearStored("wipe");
    });
  }

  return {
    GB: GB,
    MAX_STEPS: MAX_STEPS,
    sliderSteps: sliderSteps,
    sizeLabel: sizeLabel,
    categoryOf: categoryOf,
    shouldCacheMedia: shouldCacheMedia,
    shouldCacheFeed: shouldCacheFeed,
    revalidateAction: revalidateAction,
    keepMs: keepMs,
    defaultMaxBytes: defaultMaxBytes,
    normalizePolicy: normalizePolicy,
    savePolicy: saveLocal,
    applyDeviceCap: applyDeviceCap,
    planEviction: planEviction,
    mediaFresh: mediaFresh,
    parseByteRange: parseByteRange,
    rangeResponse: rangeResponse,
    sliceCached: sliceCached,
    byteLengthOf: byteLengthOf,
    formatBytes: formatBytes,
    storeList: storeList,
    localHtml: localHtml,
    clearLocal: clearLocal,
    clearStored: clearStored,
    pressureLevel: pressureLevel,
    persistText: persistText,
    askPersist: askPersist,
    openDb: openDb,
    readPolicy: readPolicy,
    writePolicy: writePolicy,
    getFile: getFile,
    putFile: putFile,
    listFiles: listFiles,
    replaceFiles: replaceFiles,
    touch: touch,
    bump: bump,
    noteTransfer: noteTransfer,
    rangeCacheUrl: rangeCacheUrl,
    cacheableRange: cacheableRange,
    readStats: readStats,
    hitRate: hitRate,
    docKey: docKey,
    putDoc: putDoc,
    listDocs: listDocs,
    deleteDoc: deleteDoc,
    clearDocs: clearDocs,
    dataHtml: dataHtml,
    usageHtml: usageHtml,
    start: start
  };
});
