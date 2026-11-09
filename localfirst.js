/* Local-first snapshots. Structured screens live in IndexedDB, the last
   painted shell lives in localStorage, and offline likes, reposts, bookmarks,
   follows, drafts, and replies wait in one idempotent queue. Notification
   read state always follows the server cursor. Auth responses are never stored. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychLocal = api;
  if (typeof document !== "undefined") api.start();
})(typeof self !== "undefined" ? self : this, function () {
  var SCREEN_KEY = "viktorych-screen-v1";
  var SCROLL_KEY = "viktorych-scrolls-v1";
  var PILL_KEY = "viktorych-pill-v1";
  var QUEUE_KEY = "viktorych-actions-v1";
  var OPENS_KEY = "viktorych-opens-v1";
  /* The last painted screen is restored on the first frame from
     localStorage, so only its top part is kept: enough to fill a tall
     screen, never the whole scrolled timeline. */
  var SCREEN_LIMIT = 60000;
  var state = { queue: [], scrolls: {}, opens: {}, restored: false, screen: null };
  var scrollTimer = 0;

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

  function storageApi() {
    if (typeof self !== "undefined" && self.ViktorychStorage) return self.ViktorychStorage;
    if (typeof require === "function") {
      try { return require("./storage.js"); } catch (err) { return null; }
    }
    return null;
  }

  var LOCAL_SCHEMA = 1;

  function readJson(storage, key) {
    try {
      if (!storage) return null;
      var raw = storage.getItem(key);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.schema != null && Number(parsed.schema) !== LOCAL_SCHEMA) {
        storage.removeItem(key);
        return null;
      }
      return parsed;
    } catch (err) {
      try { if (storage) storage.removeItem(key); } catch (ignore) { /* the next read starts empty */ }
      return null;
    }
  }

  function writeJson(storage, key, value) {
    try {
      if (!storage) return;
      if (value == null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
    } catch (err) { /* private mode keeps the in-memory copy */ }
  }

  function local() {
    try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (err) { return null; }
  }

  function canCache(url) {
    var api = storageApi();
    if (!api) return false;
    if (api.categoryOf(url) === "") return false;
    return !!(api.shouldCacheFeed(url) || api.shouldCacheMedia(url));
  }

  function createStore() {
    var docs = {};
    return {
      put: function (category, id, body) { docs[category + ":" + id] = body; },
      get: function (category, id) { return Object.prototype.hasOwnProperty.call(docs, category + ":" + id) ? docs[category + ":" + id] : null; }
    };
  }

  function mergeNotes(cached, server) {
    var hasServer = !!(server && typeof server === "object");
    var readThrough = hasServer && server.readThrough != null
      ? Number(server.readThrough) || 0
      : Number(cached && cached.readThrough) || 0;
    var seen = {};
    var seenList = hasServer && Array.isArray(server.seen) ? server.seen : (!hasServer && cached && Array.isArray(cached.seen) ? cached.seen : []);
    seenList.forEach(function (id) { if (id != null) seen[String(id)] = true; });
    var fill = {};
    ((cached && cached.notes) || []).forEach(function (note) {
      if (note && note.id != null) fill[String(note.id)] = note;
    });
    var source = hasServer && Array.isArray(server.notes) ? server.notes : ((cached && cached.notes) || []);
    var notes = source.map(function (note) {
      var id = note && note.id != null ? String(note.id) : "";
      var extra = fill[id] || {};
      var at = Number(note && note.at != null ? note.at : extra.at) || 0;
      return {
        id: id,
        text: (note && note.text) || extra.text || "",
        at: at,
        platform: (note && note.platform) || extra.platform || "",
        unread: at > readThrough && !seen[id]
      };
    }).filter(function (note) {
      if (!note || note.platform !== "tiktok") return true;
      try { return localStorage.getItem("viktorych_shorts_locked") === "0"; }
      catch (err) { return false; }
    });
    return { notes: notes, readThrough: readThrough, seen: Object.keys(seen) };
  }

  function renderScreen(route, body, server) {
    var doc = body || {};
    if (route === "home") {
      var posts = Array.isArray(doc.posts) ? doc.posts : [];
      return '<h1>' + esc(tr("Home")) + '</h1><div data-screen="home">' + posts.map(function (post) {
        return '<article class="card">' + esc(post && post.text || "") + "</article>";
      }).join("") + "</div>";
    }
    if (route === "profile") {
      return '<h1>' + esc(doc.name || tr("Profiles")) + '</h1><div data-screen="profile"><p class="bio">' + esc(doc.bio || "") + "</p>" + (doc.pinned ? '<article class="pinned">' + esc(doc.pinned.text || "") + "</article>" : "") + "</div>";
    }
    if (route === "post") {
      var post = doc.post || {};
      var parent = doc.parent && doc.parent.text ? '<article class="parent">' + esc(doc.parent.text) + "</article>" : "";
      var quote = doc.quote && doc.quote.text ? '<article class="quote">' + esc(doc.quote.text) + "</article>" : "";
      var replies = (doc.replies || []).map(function (reply) {
        return '<article class="reply">' + esc(reply && reply.text || "") + "</article>";
      }).join("");
      return '<h1>' + esc(tr("Post threads")) + '</h1><div data-screen="post">' + parent + '<article class="card">' + esc(post.text || "") + "</article>" + quote + replies + "</div>";
    }
    if (route === "notifications") {
      var merged = mergeNotes(doc, server || null);
      return '<h1>' + esc(tr("Notifications")) + '</h1><div class="notes" data-screen="notifications">' + merged.notes.map(function (note) {
        return '<article class="note-row' + (note.unread ? "" : " is-read") + '" data-unread="' + (note.unread ? "1" : "0") + '">' + esc(note.text || "") + "</article>";
      }).join("") + "</div>";
    }
    return '<div data-screen="empty"></div>';
  }

  function bootOffline(opts) {
    var options = opts || {};
    var network = false;
    if (typeof options.fetch === "function") {
      try {
        options.fetch("https://app.local/feeds.json");
        network = true;
      } catch (err) { network = false; }
    }
    if (network) return { html: "", spinner: true, offline: false };
    var route = options.route || "home";
    var kind = route === "post" ? "threads" : route === "profile" ? "profiles" : route === "notifications" ? "notifications" : "feeds";
    var id = options.id || (route === "profile" ? "profile" : route === "post" ? "post" : route === "notifications" ? "all" : "home");
    var body = options.docs && options.docs.get ? options.docs.get(kind, id) : null;
    var html = renderScreen(route, body, options.server || null);
    return { html: html, spinner: html.indexOf("skel") >= 0, offline: true };
  }

  function actionKey(action) {
    return String(action && action.type || "") + ":" + String(action && action.id || "");
  }

  function enqueueList(queue, action) {
    if (!action || !action.type || action.id == null) return (queue || []).slice();
    var key = actionKey(action);
    var next = (queue || []).filter(function (item) { return item && actionKey(item) !== key; });
    next.push({
      type: action.type,
      id: String(action.id),
      on: !!action.on,
      body: action.body || "",
      postKey: action.postKey || "",
      snapshot: action.snapshot || null,
      at: action.at || Date.now(),
      pending: true
    });
    return next.slice(-200);
  }

  function flushList(queue, send) {
    var seen = {};
    (queue || []).forEach(function (action) {
      if (!action || action.pending === false) return;
      seen[actionKey(action)] = action;
    });
    var left = [];
    Object.keys(seen).forEach(function (key) {
      var action = seen[key];
      var ok = true;
      try { ok = send ? send(action) !== false : true; }
      catch (err) { ok = false; }
      if (!ok) left.push(action);
    });
    return left;
  }

  function connectionInfo(conn) {
    var raw = conn;
    if (!raw && typeof navigator !== "undefined") raw = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    raw = raw || {};
    return {
      saveData: !!raw.saveData,
      effectiveType: raw.effectiveType || "4g",
      type: raw.type || "",
      metered: !!raw.metered || raw.type === "cellular"
    };
  }

  function prefetchEnabled(policy) {
    if (policy && policy.prefetch === false) return false;
    if (policy && policy.prefetch === true) return true;
    var saved = readJson(local(), "viktorychapp-storage");
    return !(saved && saved.prefetch === false);
  }

  function prefetchLimit(conn, enabled) {
    if (!enabled) return 0;
    var info = connectionInfo(conn);
    if (info.saveData) return 0;
    if (info.effectiveType === "slow-2g" || info.effectiveType === "2g") return 0;
    if (info.metered && info.effectiveType !== "4g") return 0;
    if (info.metered) return 3;
    if (info.effectiveType === "3g") return 2;
    return 8;
  }

  function displayImage(url, cssPx) {
    var value = String(url || "");
    if (!value) return "";
    var width = Math.max(64, Math.round(Number(cssPx) || 480));
    var name = width < 400 ? "small" : width < 900 ? "medium" : "large";
    if (/pbs\.twimg\.com/i.test(value) && /[?&]name=/.test(value)) return value.replace(/name=(?:small|medium|large|orig)/i, "name=" + name);
    if (/pbs\.twimg\.com/i.test(value)) return value + (value.indexOf("?") >= 0 ? "&" : "?") + "name=" + name;
    return value;
  }

  function isFirstSegment(url) {
    return /\.(?:m4s|ts|cmfv|cmfa)(?:\?|$)/i.test(String(url || ""));
  }

  function orderPosts(list, compare, keyOf) {
    var seen = {};
    var unique = [];
    (list || []).forEach(function (post) {
      if (!post) return;
      var id = "";
      try { id = keyOf ? String(keyOf(post) || "") : String(post.id || ""); }
      catch (err) { id = String(post.id || ""); }
      if (!id || seen[id]) return;
      seen[id] = true;
      unique.push(post);
    });
    if (compare) unique.sort(compare);
    return unique;
  }

  function resolveUrl(base, ref) {
    var value = String(ref || "").trim();
    if (!value || value.charAt(0) === "#") return "";
    try { return new URL(value, base).href; }
    catch (err) { return ""; }
  }

  function playlistFirst(text, baseUrl) {
    var lines = String(text || "").split(/\r?\n/);
    var map = "";
    var variant = "";
    var segment = "";
    var expectVariant = false;
    var expectSegment = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      if (line.indexOf("#EXT-X-MAP:") === 0 && !map) {
        var found = line.match(/URI="([^"]+)"/i);
        if (found) map = resolveUrl(baseUrl, found[1]);
        continue;
      }
      if (line.indexOf("#EXT-X-STREAM-INF") === 0) { expectVariant = true; continue; }
      if (line.indexOf("#EXTINF") === 0) { expectSegment = true; continue; }
      if (line.charAt(0) === "#") continue;
      var abs = resolveUrl(baseUrl, line);
      if (expectVariant && !variant) variant = abs;
      else if ((expectSegment || isFirstSegment(abs)) && !segment) segment = abs;
      expectVariant = false;
      expectSegment = false;
      if (segment) break;
    }
    return { map: map, variant: variant, segment: segment };
  }

  function cacheableInit(mapUrl, segmentUrl) {
    if (!mapUrl || mapUrl === segmentUrl) return false;
    if (!/^https:/.test(mapUrl) || /\.m3u8(?:\?|$)/i.test(mapUrl)) return false;
    if (isFirstSegment(mapUrl)) return true;
    return /init|map/i.test(String(mapUrl).split("?")[0]);
  }

  function cacheFirstSegment(url, fetcher, conn) {
    var target = String(url || "");
    if (!prefetchLimit(conn || null, prefetchEnabled())) return Promise.resolve([]);
    if (isFirstSegment(target)) {
      postCache([target]);
      return Promise.resolve([target]);
    }
    if (!/\.m3u8(?:\?|$)/i.test(target)) return Promise.resolve([]);
    var load = fetcher || (typeof fetch === "function" ? fetch : null);
    if (!load) return Promise.resolve([]);
    function readPlaylist(playlistUrl, depth) {
      return Promise.resolve(load(playlistUrl, { credentials: "omit", cache: "force-cache" })).then(function (res) {
        if (!res || !res.ok || typeof res.text !== "function") return [];
        return res.text().then(function (body) {
          var parsed = playlistFirst(body, playlistUrl);
          if (parsed.segment && isFirstSegment(parsed.segment)) {
            var urls = [];
            if (cacheableInit(parsed.map, parsed.segment)) urls.push(parsed.map);
            urls.push(parsed.segment);
            postCache(urls);
            return urls;
          }
          if (parsed.variant && depth < 1 && /\.m3u8(?:\?|$)/i.test(parsed.variant)) return readPlaylist(parsed.variant, depth + 1);
          return [];
        });
      }).catch(function () { return []; });
    }
    return readPlaylist(target, 0);
  }

  function mediaPlan(items, conn, enabled) {
    var limit = prefetchLimit(conn, enabled);
    var posters = [];
    var first = [];
    var ahead = [];
    (items || []).forEach(function (item, index) {
      if (!item) return;
      if (item.poster) posters.push(item.poster);
      if (item.first && isFirstSegment(item.first)) first.push(item.first);
      var image = item.image ? displayImage(item.image, item.width || 480) : "";
      if (image && index < limit) ahead.push(image);
    });
    return { posters: posters, first: first, ahead: ahead, limit: limit };
  }

  function rankOpens(counts, limit) {
    return Object.keys(counts || {}).sort(function (a, b) {
      return (counts[b] || 0) - (counts[a] || 0) || (a < b ? -1 : 1);
    }).slice(0, limit || 3);
  }

  function defaultRoute(hash) {
    var value = hash || "";
    return value === "" || value === "#" || value === "#/" || value === "#/home";
  }

  /* Cut long HTML after the last whole post (or tag) that fits. */
  function trimHtml(html, limit) {
    html = String(html || "");
    if (html.length <= limit) return html;
    var cut = html.lastIndexOf("</article>", limit - 10);
    if (cut > limit / 4) return html.slice(0, cut + 10);
    cut = html.lastIndexOf(">", limit - 1);
    return cut > 0 ? html.slice(0, cut + 1) : "";
  }

  function accountScope() {
    try {
      var store = typeof localStorage !== "undefined" ? localStorage : null;
      if (!store || !store.getItem) return "0";
      var doc = JSON.parse(store.getItem("viktorychapp-account-v1") || "null");
      var id = doc && doc.account && (doc.account.publicId || doc.account.id);
      if (!id) return "0";
      return String(id).replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "0";
    } catch (err) { return "0"; }
  }

  function capture(info) {
    var html = trimHtml(info && info.html, SCREEN_LIMIT);
    var screen = {
      schema: LOCAL_SCHEMA,
      hash: info && info.hash || "#/",
      html: html,
      scrollKey: info && info.scrollKey || "",
      y: Number(info && info.y) || 0,
      at: Date.now(),
      acct: accountScope()
    };
    state.screen = screen;
    writeJson(local(), SCREEN_KEY, screen);
    if (info && info.scrolls) {
      state.scrolls = info.scrolls;
      writeJson(local(), SCROLL_KEY, info.scrolls);
    }
    return screen;
  }

  function noteOpen(hash) {
    var key = String(hash || "#/");
    state.opens[key] = (state.opens[key] || 0) + 1;
    writeJson(local(), OPENS_KEY, state.opens);
    return rankOpens(state.opens, 3);
  }

  function noteScroll(key, y, map) {
    if (!key) return;
    state.scrolls[key] = y;
    if (map) state.scrolls = map;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function () { writeJson(local(), SCROLL_KEY, state.scrolls); }, 300);
  }

  function readScrolls() {
    return state.scrolls && Object.keys(state.scrolls).length ? state.scrolls : (readJson(local(), SCROLL_KEY) || {});
  }

  function savePill(posts) {
    var list = (posts || []).filter(Boolean).slice(0, 40);
    writeJson(local(), PILL_KEY, list.length ? list : null);
    return list;
  }

  function readPill() {
    var saved = readJson(local(), PILL_KEY);
    return Array.isArray(saved) ? saved : [];
  }

  function enqueue(action) {
    state.queue = enqueueList(state.queue, action);
    writeJson(local(), QUEUE_KEY, state.queue);
    paintPending();
    return state.queue;
  }

  function flush(send) {
    state.queue = flushList(state.queue, send);
    writeJson(local(), QUEUE_KEY, state.queue.length ? state.queue : null);
    paintPending();
    return state.queue;
  }

  function pending() {
    return (state.queue || []).filter(function (action) { return action && action.pending !== false; });
  }

  function paintPending(root) {
    if (typeof document === "undefined") return;
    var scope = root || document;
    var ids = {};
    pending().forEach(function (action) { ids[action.type + ":" + action.id] = true; });
    var buttons = scope.querySelectorAll ? scope.querySelectorAll("[data-act='like'],[data-act='bookmark'],[data-act='follow'],[data-act='repost-do']") : [];
    Array.prototype.forEach.call(buttons, function (btn) {
      var on = !!ids[(btn.getAttribute("data-act") || "") + ":" + (btn.getAttribute("data-id") || btn.getAttribute("data-ids") || "")];
      btn.classList.toggle("is-pending", on);
      if (on) btn.setAttribute("title", tr("Pending"));
    });
  }

  function readDoc(category, id) {
    var api = storageApi();
    if (!api || typeof indexedDB === "undefined" || !api.openDb || !api.listDocs) return Promise.resolve(null);
    return api.openDb().then(function (db) {
      return api.listDocs(db);
    }).then(function (rows) {
      var want = String(id);
      var found = (rows || []).find(function (row) {
        return row && row.category === category && String(row.id) === want;
      });
      return found ? found.body : null;
    }).catch(function () { return null; });
  }

  function saveDoc(category, id, body, etag) {
    var api = storageApi();
    if (!api || typeof indexedDB === "undefined") return Promise.resolve(null);
    var text = "";
    try { text = JSON.stringify(body == null ? null : body); } catch (err) { text = ""; }
    return api.openDb().then(function (db) {
      return api.putDoc(db, { category: category, id: id, body: body, etag: etag || "", bytes: text.length });
    }).catch(function () { return null; });
  }

  function postCache(urls) {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    var list = (urls || []).filter(function (url) { return /^https:/.test(url || "") && canCache(url); });
    if (!list.length) return;
    var worker = navigator.serviceWorker.controller;
    if (!worker) return;
    var friends = typeof window !== "undefined" && window.ViktorychFriendP2P;
    if (friends && friends.peers && friends.peers().length) {
      // Friends online first; whatever they don't have, or send too slowly, comes from the source.
      Promise.all(list.slice(0, 24).map(function (url) {
        return friends.fetchMedia(url, { peerOnly: true }).then(function (got) {
          if (!got || !got.blob) return url;
          try { worker.postMessage({ type: "cache-media-bytes", url: url, blob: got.blob }); } catch (err) { return url; }
          return "";
        }, function () { return url; });
      })).then(function (rest) {
        rest = rest.filter(Boolean);
        if (!rest.length) return;
        try { worker.postMessage({ type: "cache-media", urls: rest }); } catch (err) { /* the worker may be restarting */ }
      });
      return;
    }
    try { worker.postMessage({ type: "cache-media", urls: list.slice(0, 24) }); } catch (err) { /* the worker may be restarting */ }
  }

  function videoSources(video) {
    var found = [];
    if (!video) return found;
    var direct = (video.getAttribute && (video.getAttribute("data-hls") || video.getAttribute("src"))) || video.currentSrc || "";
    if (direct) found.push(direct);
    var sources = video.querySelectorAll ? video.querySelectorAll("source") : [];
    Array.prototype.forEach.call(sources, function (source) {
      var from = source.getAttribute("src") || "";
      if (from) found.push(from);
    });
    return found;
  }

  function warmMedia(root) {
    if (typeof document === "undefined" || !root || !root.querySelectorAll) return [];
    var limit = prefetchLimit(null, prefetchEnabled());
    if (!limit) return [];
    var nodes = root.querySelectorAll("article");
    var urls = [];
    var playlists = [];
    for (var i = 1; i < nodes.length && urls.length < limit; i++) {
      var img = nodes[i].querySelector("img");
      if (img) {
        var src = img.currentSrc || img.src || "";
        if (src) urls.push(displayImage(src, img.clientWidth || 480));
      }
      var video = nodes[i].querySelector("video");
      if (video && video.poster) urls.push(video.poster);
      videoSources(video).forEach(function (url) {
        if (isFirstSegment(url)) urls.push(url);
        else if (/\.m3u8(?:\?|$)/i.test(url)) playlists.push(url);
      });
    }
    postCache(urls);
    playlists.slice(0, limit).forEach(function (playlist) { cacheFirstSegment(playlist); });
    return urls.concat(playlists);
  }

  function warmOpens() {
    var top = rankOpens(state.opens, 3);
    if (!prefetchLimit(null, prefetchEnabled())) return top;
    /* The page shell already reads feeds.json fresh at boot; a second copy only costs bandwidth. */
    var booted = typeof window !== "undefined" && window.__homeFreshBoot;
    if (typeof fetch === "function" && !booted) {
      fetch("feeds.json", { cache: "force-cache" }).catch(function () {});
    }
    if (typeof window !== "undefined" && window.dispatchEvent) {
      try { window.dispatchEvent(new CustomEvent("viktorych-warm", { detail: top })); } catch (err) { /* older webviews still warmed the feed */ }
    }
    return top;
  }

  function wasRestored() {
    return !!state.restored;
  }

  function restoreEarly() {
    var saved = readJson(local(), SCREEN_KEY);
    state.scrolls = readJson(local(), SCROLL_KEY) || {};
    state.queue = readJson(local(), QUEUE_KEY) || [];
    state.opens = readJson(local(), OPENS_KEY) || {};
    if (!Array.isArray(state.queue)) state.queue = [];
    var app = typeof document !== "undefined" ? document.getElementById("app") : null;
    var live = typeof location !== "undefined" ? (location.hash || "#/") : "#/";
    var savedHash = saved && saved.hash ? String(saved.hash) : "";
    /* A deep link such as #/settings must not be covered by the Home
       screen saved last time. Home still restores, and then may adopt
       the saved address below. */
    var mine = accountScope();
    var foreign = !!(saved && saved.acct && mine !== "0" && saved.acct !== mine);
    var canPaint = !!(saved && saved.html && !foreign && (defaultRoute(live) || !savedHash || savedHash === live));
    if (canPaint && app && !app.childElementCount) {
      app.innerHTML = saved.html;
      document.documentElement.classList.add("is-restored");
      state.restored = true;
      state.screen = saved;
    } else if (canPaint && app && app.childElementCount && document.documentElement.classList.contains("is-restored")) {
      state.restored = true;
      state.screen = saved;
    }
    if (saved && saved.hash && typeof location !== "undefined" && defaultRoute(location.hash)) {
      if (saved.hash !== location.hash) {
        try { location.replace(location.pathname + location.search + saved.hash); } catch (err) { /* the hash can stay */ }
      }
    }
    return state.restored;
  }


  /* Stale-while-revalidate cache shared by every page. Reads are synchronous,
     so a page with cached data paints it on the first frame and never shows a
     spinner; the caller refreshes in the background and calls put() with the
     new copy.

     Two tiers. localStorage holds only small entries (it shares about 5 Mi
     characters with every setting on this address, 2.5 Mi on iOS). Bigger
     entries, and small ones pushed out of localStorage, live in IndexedDB and
     are read into memory at start, newest first, so they still paint at once.
     Private pages (messages, bookmarks, lists, drafts, notifications) stay in
     the small tier only, where the device seal and the private wipe reach
     them; a private page too big for it is simply not saved. */
  var SWR_PREFIX = "viktorych-swr-v1:";
  var SWR_INDEX = "viktorych-swr-v1-index";
  var SWR_MAX_BYTES = 240000;
  var SWR_MAX_ENTRY = 48000;
  var SWR_MAX_ENTRIES = 40;
  var SWR_DB = "viktorych-swr";
  var SWR_DB_MAX_BYTES = 12000000;
  var SWR_DB_MAX_ENTRY = 600000;
  var SWR_DB_MAX_ENTRIES = 300;
  var SWR_WARM_BYTES = 2000000;
  var swrMemo = {};
  var swrIndex = null;
  var swrDbAdapter = null;
  var swrDbTried = false;
  var swrDbMeta = {};
  var swrDbLoading = null;
  var swrDbTouched = {};
  var swrTouchTimer = 0;

  function swrStore(store) { return store || local(); }
  function swrPrivate(key) { return String(key).indexOf("private-list") >= 0; }

  function idbAdapter() {
    if (typeof indexedDB === "undefined" || !indexedDB) return null;
    var opening = null;
    function open() {
      if (!opening) {
        opening = new Promise(function (resolve) {
          try {
            var req = indexedDB.open(SWR_DB, 1);
            req.onupgradeneeded = function () {
              var db = req.result;
              if (!db.objectStoreNames.contains("v")) db.createObjectStore("v");
              if (!db.objectStoreNames.contains("m")) db.createObjectStore("m");
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { resolve(null); };
            req.onblocked = function () { resolve(null); };
          } catch (err) { resolve(null); }
        });
      }
      return opening;
    }
    function run(names, mode, fn) {
      return open().then(function (db) {
        if (!db) return null;
        return new Promise(function (resolve) {
          try {
            var tx = db.transaction(names, mode);
            var out = { value: null };
            fn(tx, out);
            tx.oncomplete = function () { resolve(out.value); };
            tx.onerror = function () { resolve(null); };
            tx.onabort = function () { resolve(null); };
          } catch (err) { resolve(null); }
        });
      });
    }
    return {
      get: function (key) {
        return run(["v"], "readonly", function (tx, out) {
          var req = tx.objectStore("v").get(key);
          req.onsuccess = function () { out.value = req.result || null; };
        });
      },
      put: function (key, row, meta) {
        return run(["v", "m"], "readwrite", function (tx, out) {
          tx.objectStore("v").put(row, key);
          tx.objectStore("m").put(meta, key);
          out.value = true;
        });
      },
      touch: function (metas) {
        return run(["m"], "readwrite", function (tx) {
          Object.keys(metas).forEach(function (key) { tx.objectStore("m").put(metas[key], key); });
        });
      },
      del: function (key) {
        return run(["v", "m"], "readwrite", function (tx) {
          tx.objectStore("v").delete(key);
          tx.objectStore("m").delete(key);
        });
      },
      list: function () {
        return run(["m"], "readonly", function (tx, out) {
          var store = tx.objectStore("m");
          var keys = store.getAllKeys();
          var vals = store.getAll();
          vals.onsuccess = function () {
            var ks = keys.result || [];
            out.value = (vals.result || []).map(function (meta, i) {
              return { k: String(ks[i]), b: Number(meta && meta.b) || 0, u: Number(meta && meta.u) || 0 };
            });
          };
        });
      },
      clear: function () {
        return run(["v", "m"], "readwrite", function (tx) {
          tx.objectStore("v").clear();
          tx.objectStore("m").clear();
        });
      }
    };
  }
  function swrDb() {
    if (!swrDbTried) { swrDbTried = true; swrDbAdapter = idbAdapter(); }
    return swrDbAdapter;
  }
  /* Tests (and the TV shell) can hand in their own async store. */
  function swrUseDb(adapter) {
    swrDbAdapter = adapter || null;
    swrDbTried = true;
    swrDbMeta = {};
    swrDbLoading = null;
  }
  function swrDbReady() {
    var db = swrDb();
    if (!db) return Promise.resolve(swrDbMeta);
    if (!swrDbLoading) {
      swrDbLoading = Promise.resolve(db.list()).then(function (rows) {
        (rows || []).forEach(function (row) {
          if (!row || !row.k) return;
          if (!swrDbMeta[row.k]) swrDbMeta[row.k] = { b: row.b, u: row.u };
        });
        return swrDbMeta;
      }).catch(function () { return swrDbMeta; });
    }
    return swrDbLoading;
  }
  function swrDbTotal() {
    return Object.keys(swrDbMeta).reduce(function (sum, key) { return sum + (Number(swrDbMeta[key].b) || 0); }, 0);
  }
  function swrDbForget(key) {
    var db = swrDb();
    delete swrDbMeta[key];
    if (swrMemo[key] && swrMemo[key].db) delete swrMemo[key];
    if (db) Promise.resolve(db.del(key)).catch(function () {});
  }
  function swrDbPut(key, value, at, bytes) {
    var db = swrDb();
    if (!db) return Promise.resolve(false);
    return swrDbReady().then(function () {
      swrDbMeta[key] = { b: bytes, u: at };
      var keys = Object.keys(swrDbMeta).filter(function (k) { return k !== key; })
        .sort(function (a, b) { return (swrDbMeta[a].u || 0) - (swrDbMeta[b].u || 0); });
      while (keys.length && (swrDbTotal() > SWR_DB_MAX_BYTES || Object.keys(swrDbMeta).length > SWR_DB_MAX_ENTRIES)) swrDbForget(keys.shift());
      return Promise.resolve(db.put(key, { v: value, at: at }, { b: bytes, u: at })).then(function (ok) { return !!ok; });
    }).catch(function () { return false; });
  }
  /* Memory for IndexedDB entries is bounded too: least recently used out. */
  function swrMemoDb(key, hit) {
    swrMemo[key] = hit;
    var keys = Object.keys(swrMemo).filter(function (k) { return swrMemo[k] && swrMemo[k].db; });
    var total = keys.reduce(function (sum, k) { return sum + (swrMemo[k].b || 0); }, 0);
    if (total <= SWR_WARM_BYTES) return;
    keys.sort(function (a, b) { return (swrMemo[a].u || 0) - (swrMemo[b].u || 0); });
    while (keys.length > 1 && total > SWR_WARM_BYTES) {
      var drop = keys.shift();
      if (drop === key) continue;
      total -= swrMemo[drop].b || 0;
      delete swrMemo[drop];
    }
  }
  function swrDbLoad(key) {
    var db = swrDb();
    if (!db) return Promise.resolve(null);
    return Promise.resolve(db.get(key)).then(function (row) {
      if (!row || !("v" in row)) return null;
      if (swrMemo[key] && !swrMemo[key].db) return swrMemo[key];
      var meta = swrDbMeta[key] || {};
      var hit = { value: row.v, at: Number(row.at) || 0, db: true, b: Number(meta.b) || 0, u: Number(meta.u) || Date.now() };
      swrMemoDb(key, hit);
      if (String(key).indexOf("route:") >= 0) notifyRoute(key);
      return hit;
    }).catch(function () { return null; });
  }
  /* Read the newest IndexedDB entries into memory so they paint at once. */
  function swrWarm() {
    if (!swrDb()) return Promise.resolve(0);
    return swrDbReady().then(function () {
      var keys = Object.keys(swrDbMeta).sort(function (a, b) { return (swrDbMeta[b].u || 0) - (swrDbMeta[a].u || 0); });
      var budget = SWR_WARM_BYTES;
      var picked = [];
      keys.forEach(function (key) {
        var b = Number(swrDbMeta[key].b) || 0;
        if (swrMemo[key] || b > budget) return;
        budget -= b;
        picked.push(key);
      });
      return Promise.all(picked.map(swrDbLoad)).then(function (rows) {
        var n = rows.filter(Boolean).length;
        if (n) notifyRoute("");
        return n;
      });
    });
  }
  function swrDbTouch(key) {
    var meta = swrDbMeta[key];
    if (!meta) return;
    meta.u = Date.now();
    swrDbTouched[key] = { b: meta.b, u: meta.u };
    clearTimeout(swrTouchTimer);
    swrTouchTimer = setTimeout(function () {
      var db = swrDb();
      var batch = swrDbTouched;
      swrDbTouched = {};
      if (db && db.touch) Promise.resolve(db.touch(batch)).catch(function () {});
    }, 1500);
    if (swrTouchTimer && swrTouchTimer.unref) swrTouchTimer.unref();
  }

  function swrReadIndex(store) {
    if (swrIndex) return swrIndex;
    var raw = readJson(swrStore(store), SWR_INDEX);
    swrIndex = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return swrIndex;
  }
  function swrWriteIndex(store) { writeJson(swrStore(store), SWR_INDEX, swrIndex || {}); }
  function swrTotal(index) {
    return Object.keys(index).reduce(function (sum, key) { return sum + (Number(index[key].b) || 0); }, 0);
  }
  /* Remove from the small tier only. */
  function swrDropLocal(key, store) {
    var index = swrReadIndex(store);
    delete index[key];
    if (swrMemo[key] && !swrMemo[key].db) delete swrMemo[key];
    try { swrStore(store).removeItem(SWR_PREFIX + key); } catch (err) { /* already gone */ }
  }
  /* Move one small-tier entry to IndexedDB (public pages) or drop it. */
  function swrDemote(key, store, raw) {
    var target = swrStore(store);
    if (raw == null) { try { raw = target ? target.getItem(SWR_PREFIX + key) : null; } catch (err) { raw = null; } }
    var memo = swrMemo[key];
    swrDropLocal(key, store);
    if (swrPrivate(key) || !swrDb() || !raw || raw.length > SWR_DB_MAX_ENTRY) return false;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (err) { parsed = null; }
    if (!parsed || !("v" in parsed)) return false;
    var at = Number(parsed.at) || Date.now();
    var hit = { value: parsed.v, at: at, db: true, b: raw.length, u: memo && memo.u || at };
    if (memo) swrMemoDb(key, hit);
    swrDbPut(key, parsed.v, at, raw.length);
    return true;
  }
  function swrDrop(key, store) {
    swrDropLocal(key, store);
    if (swrMemo[key]) delete swrMemo[key];
    if (swrDbMeta[key] || swrDb()) swrDbForget(key);
  }
  /* Push least recently used small-tier entries down until `need` more fit. */
  function swrEvict(need, store, keep) {
    var index = swrReadIndex(store);
    var keys = Object.keys(index).filter(function (key) { return key !== keep; })
      .sort(function (a, b) { return (index[a].u || 0) - (index[b].u || 0); });
    while (keys.length && (swrTotal(index) + need > SWR_MAX_BYTES || Object.keys(index).length >= SWR_MAX_ENTRIES)) {
      swrDemote(keys.shift(), store);
    }
  }
  function swrGet(key, store) {
    key = String(key || "");
    if (!key) return null;
    var index = swrReadIndex(store);
    var meta = index[key];
    var hit = swrMemo[key];
    if (hit && hit.db) {
      hit.u = Date.now();
      swrDbTouch(key);
      return hit;
    }
    if (!meta) {
      if (swrDb() && !swrPrivate(key)) swrDbReady().then(function () { if (swrDbMeta[key] && !swrMemo[key]) swrDbLoad(key); });
      return null;
    }
    if (!hit) {
      var raw = readJson(swrStore(store), SWR_PREFIX + key);
      if (!raw || !("v" in raw)) { swrDropLocal(key, store); swrWriteIndex(store); return null; }
      hit = swrMemo[key] = { value: raw.v, at: Number(raw.at) || 0 };
    }
    meta.u = Date.now();
    clearTimeout(swrGet.timer);
    swrGet.timer = setTimeout(function () { swrWriteIndex(store); }, 500);
    if (swrGet.timer && swrGet.timer.unref) swrGet.timer.unref();
    return hit;
  }
  function swrPutDb(key, value, at, bytes, store) {
    swrDropLocal(key, store);
    swrWriteIndex(store);
    if (swrPrivate(key) || bytes > SWR_DB_MAX_ENTRY || !swrDb()) {
      if (swrMemo[key]) delete swrMemo[key];
      if (swrDbMeta[key]) swrDbForget(key);
      return false;
    }
    swrMemoDb(key, { value: value, at: at, db: true, b: bytes, u: at });
    swrDbPut(key, value, at, bytes);
    return true;
  }
  function swrPut(key, value, store) {
    key = String(key || "");
    if (!key) return false;
    var at = Date.now();
    var text = "";
    try { text = JSON.stringify({ v: value, at: at }); } catch (err) { return false; }
    if (text.length > SWR_MAX_ENTRY) return swrPutDb(key, value, at, text.length, store);
    var index = swrReadIndex(store);
    delete index[key];
    swrEvict(text.length, store, key);
    var target = swrStore(store);
    for (var attempt = 0; attempt < 4; attempt++) {
      try {
        if (!target) break;
        target.setItem(SWR_PREFIX + key, text);
        index[key] = { b: text.length, u: at };
        swrMemo[key] = { value: value, at: at };
        swrWriteIndex(store);
        if (swrDbMeta[key]) swrDbForget(key);
        return true;
      } catch (err) {
        /* Quota: the device is fuller than our budget assumed. Move the
           oldest half of this tier down (at least one entry) and try again. */
        var older = Object.keys(index).filter(function (k) { return k !== key; })
          .sort(function (a, b) { return (index[a].u || 0) - (index[b].u || 0); });
        if (!older.length) break;
        older.slice(0, Math.max(1, Math.ceil(older.length / 2))).forEach(function (k) { swrDemote(k, store); });
      }
    }
    return swrPutDb(key, value, at, text.length, store);
  }
  function swrFresh(key, ttl, store) {
    var hit = swrGet(key, store);
    return !!(hit && Date.now() - hit.at < (ttl || 0));
  }
  function swrClear(store) {
    var index = swrReadIndex(store);
    Object.keys(index).forEach(function (key) { swrDropLocal(key, store); });
    swrIndex = {};
    swrMemo = {};
    writeJson(swrStore(store), SWR_INDEX, null);
    var target = swrStore(store);
    swrLocalKeys(target).forEach(function (key) { try { target.removeItem(SWR_PREFIX + key); } catch (err) { /* already gone */ } });
    swrDbMeta = {};
    swrDbTouched = {};
    var db = swrDb();
    if (db) Promise.resolve(db.clear()).catch(function () {});
  }
  function swrReset() { swrIndex = null; swrMemo = {}; swrDbMeta = {}; swrDbLoading = null; }
  function swrLocalKeys(store) {
    var out = [];
    try {
      if (!store) return out;
      if (typeof store.length === "number" && typeof store.key === "function") {
        for (var i = 0; i < store.length; i++) {
          var name = store.key(i);
          if (name && name.indexOf(SWR_PREFIX) === 0) out.push(name.slice(SWR_PREFIX.length));
        }
      } else if (typeof store.keys === "function") {
        store.keys().forEach(function (name) { if (String(name).indexOf(SWR_PREFIX) === 0) out.push(String(name).slice(SWR_PREFIX.length)); });
      }
    } catch (err) { /* nothing to list */ }
    return out;
  }
  /* Older builds kept up to 1.5 M characters of page snapshots here, which
     filled localStorage. On start, entries too big for the small tier and
     entries the index lost track of move to IndexedDB (private ones are
     dropped), and the small tier is trimmed to its new budget. */
  function swrMigrate(store) {
    var target = swrStore(store);
    var report = { moved: 0, dropped: 0, freed: 0 };
    if (!target) return report;
    var index = swrReadIndex(store);
    swrLocalKeys(target).forEach(function (key) {
      var raw = null;
      try { raw = target.getItem(SWR_PREFIX + key); } catch (err) { raw = null; }
      var size = raw ? raw.length : 0;
      var meta = index[key];
      if (meta && size <= SWR_MAX_ENTRY) { meta.b = size; return; }
      report.freed += size + SWR_PREFIX.length + key.length;
      if (swrDemote(key, store, raw)) report.moved += 1; else report.dropped += 1;
    });
    Object.keys(index).forEach(function (key) {
      var present = null;
      try { present = target.getItem(SWR_PREFIX + key); } catch (err) { present = null; }
      if (present == null) delete index[key];
    });
    var before = swrTotal(index);
    var count = Object.keys(index).length;
    swrEvict(0, store, "");
    var after = swrTotal(index);
    report.freed += before - after;
    report.moved += count - Object.keys(index).length;
    swrWriteIndex(store);
    return report;
  }
  /* Route snapshots: the last painted HTML of a page, shown at once while its
     module or data loads. Pages that hold private data opt out by not saving. */
  /* Pages with private data (messages, bookmarks, lists, drafts, notifications)
     keep their snapshot under a "private-list" key, so the device seal encrypts
     it and the private wipe removes it with the rest of the private lists. */
  var PRIVATE_ROUTE = /^#\/(?:messages|chat|bookmarks|lists?|drafts|notifications)(?:[/?]|$)/;
  function notifyRoute(key) {
    if (typeof window === "undefined" || !window.dispatchEvent) return;
    try { window.dispatchEvent(new CustomEvent("viktorych-route", { detail: { key: key || "" } })); } catch (err) { /* the next open still reads the copy */ }
  }

  function routeKey(hash) {
    return (PRIVATE_ROUTE.test(String(hash)) ? "private-list:route:" : "route:") + accountScope() + ":" + hash;
  }
  function wipePrivateRoutes(store) {
    var index = swrReadIndex(store);
    Object.keys(index).forEach(function (key) { if (swrPrivate(key)) swrDropLocal(key, store); });
    swrLocalKeys(swrStore(store)).forEach(function (key) { if (swrPrivate(key)) swrDropLocal(key, store); });
    Object.keys(swrMemo).forEach(function (key) { if (swrPrivate(key)) delete swrMemo[key]; });
    swrWriteIndex(store);
  }
  function saveRoute(hash, html) {
    if (!hash || !html || html.length > 150000 || /<script/i.test(html)) return false;
    /* The write waits so a burst of paints stores one copy. The account is
       the one on screen now. Reading it again when the timer fires would
       file this account's page under whoever signs in during the wait. */
    var key = routeKey(hash);
    var scope = accountScope();
    clearTimeout(saveRoute.timers && saveRoute.timers[hash]);
    saveRoute.timers = saveRoute.timers || {};
    saveRoute.timers[hash] = setTimeout(function () {
      if (accountScope() !== scope) return;
      var memo = swrMemo[key];
      if (memo && memo.value === html) return;
      swrPut(key, html);
    }, 400);
    return true;
  }
  function readRoute(hash) {
    var hit = hash ? swrGet(routeKey(hash)) : null;
    return hit && typeof hit.value === "string" ? hit.value : "";
  }

  function wipe() {
    state.queue = [];
    state.scrolls = {};
    state.opens = {};
    state.screen = null;
    state.restored = false;
    var store = local();
    [SCREEN_KEY, SCROLL_KEY, PILL_KEY, QUEUE_KEY, OPENS_KEY].forEach(function (key) { writeJson(store, key, null); });
    swrClear(store);
    var api = storageApi();
    if (api && typeof indexedDB !== "undefined") {
      api.openDb().then(function (db) { return api.clearDocs(db, "all"); }).catch(function () {});
    }
  }

  /* Keep localStorage for small settings: move or trim what older builds
     left there (see swrMigrate and local-budget.js). */
  function migrateLocal(store) {
    store = store || local();
    var report = { swr: swrMigrate(store), screen: 0, budget: null };
    var saved = readJson(store, SCREEN_KEY);
    if (saved && typeof saved.html === "string" && saved.html.length > SCREEN_LIMIT) {
      var before = saved.html.length;
      saved.html = trimHtml(saved.html, SCREEN_LIMIT);
      report.screen = before - saved.html.length;
      writeJson(store, SCREEN_KEY, saved);
    }
    var scope = typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : null;
    var budget = scope ? scope.ViktorychLocalBudget : null;
    if (budget && budget.migrate) report.budget = budget.migrate(store);
    return report;
  }

  function syncSender(action) {
    var app = typeof window !== "undefined" ? window.ViktorychAppSync : null;
    if (!app) return true;
    try { return app(action) !== false; }
    catch (err) { return false; }
  }

  function start() {
    restoreEarly();
    document.addEventListener("play", function (event) {
      var el = event.target;
      if (!el || (el.tagName !== "VIDEO" && el.tagName !== "AUDIO")) return;
      var listed = el.getAttribute ? (el.getAttribute("data-hls") || "") : "";
      var url = listed || el.currentSrc || el.src || "";
      if (/\.m3u8(?:\?|$)/i.test(url)) {
        cacheFirstSegment(url);
        return;
      }
      if (/^https:/.test(url)) postCache([url]);
    }, true);
    window.addEventListener("online", function () { flush(syncSender); });
    window.addEventListener("viktorych-account-deleted", wipe);
    swrWarm().catch(function () {});
    var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 800); };
    idle(function () {
      migrateLocal();
      warmOpens();
    });
  }

  return {
    canCache: canCache,
    createStore: createStore,
    mergeNotes: mergeNotes,
    renderScreen: renderScreen,
    bootOffline: bootOffline,
    enqueueList: enqueueList,
    flushList: flushList,
    connectionInfo: connectionInfo,
    prefetchEnabled: prefetchEnabled,
    prefetchLimit: prefetchLimit,
    displayImage: displayImage,
    isFirstSegment: isFirstSegment,
    orderPosts: orderPosts,
    playlistFirst: playlistFirst,
    cacheFirstSegment: cacheFirstSegment,
    mediaPlan: mediaPlan,
    rankOpens: rankOpens,
    capture: capture,
    noteOpen: noteOpen,
    noteScroll: noteScroll,
    readScrolls: readScrolls,
    savePill: savePill,
    readPill: readPill,
    enqueue: enqueue,
    flush: flush,
    pending: pending,
    paintPending: paintPending,
    readDoc: readDoc,
    saveDoc: saveDoc,
    warmMedia: warmMedia,
    warmOpens: warmOpens,
    wasRestored: wasRestored,
    screenHash: function () {
      var screen = state.screen || readJson(local(), SCREEN_KEY);
      return screen && screen.hash ? String(screen.hash) : "";
    },
    restoreEarly: restoreEarly,
    wipe: wipe,
    swr: {
      get: swrGet, put: swrPut, fresh: swrFresh, drop: swrDrop, clear: swrClear, reset: swrReset,
      load: swrDbLoad, warm: swrWarm, ready: swrDbReady, useDb: swrUseDb, migrate: swrMigrate,
      limits: { bytes: SWR_MAX_BYTES, entry: SWR_MAX_ENTRY, entries: SWR_MAX_ENTRIES, dbBytes: SWR_DB_MAX_BYTES, dbEntry: SWR_DB_MAX_ENTRY, dbEntries: SWR_DB_MAX_ENTRIES, warm: SWR_WARM_BYTES }
    },
    screenLimit: SCREEN_LIMIT,
    trimHtml: trimHtml,
    migrateLocal: migrateLocal,
    saveRoute: saveRoute,
    readRoute: readRoute,
    /* Forget one page's saved copy (For You off drops the Home copy). */
    dropRoute: function (hash) {
      if (hash == null) return;
      var store = local();
      swrDrop(routeKey(String(hash)), store);
      swrWriteIndex(store);
    },
    routeKey: routeKey,
    wipePrivate: function (store) { wipePrivateRoutes(store || local()); },
    start: start
  };
});
