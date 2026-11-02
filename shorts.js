/* Owner Shorts. Live and For you, drawn with the Home tab chrome. */
(function () {
  var hooks = {
    icon: function () { return ""; },
    esc: function (value) { return String(value == null ? "" : value); },
    avatar: function () { return ""; },
    formatCount: function (n) { return String(n || 0); },
    fullTime: function (iso) { return iso || ""; },
    posts: function () { return []; },
    data: function () { return null; },
    settings: function () { return { follows: [], likes: {}, bookmarks: {} }; },
    save: function () {},
    toggle: function () { return false; },
    token: function () { return ""; },
    productName: function () { return ""; },
    logo: function () { return ""; }
  };
  var cached = null;
  var hls = null;
  var peerRelease = null;
  var previewPeerRelease = null;
  var poll = 0;
  var sound = false;
  var lastTap = 0;
  var tapTimer = 0;
  var addedAccounts = [];
  var addingAccount = false;
  var accountsLoaded = false;
  var livePaintKey = "";
  var recordingsState = "idle";
  var mediaRootOverride = "";
  var healthCache = {};
  var previewObs = null;
  var previewRatios = {};
  var previewToken = 0;
  var previewHls = null;
  var previewHandle = "";
  var resumeMap = {};
  var resumeTimer = 0;
  var pastPaintKey = "";
  var paintTimer = 0;
  var liveInflight = {};
  var liveToken = 0;
  var statsTimer = 0;
  var statsHandle = "";
  var statsRoom = "";
  var liveFatal = null;
  var onLiveLevel = null;
  var climbTimer = 0;
  var recordings = { cap: 12, active: 0, items: {}, past: [] };
  var hlsDead = false;
  var qualityLock = false;
  var stitchedPlay = false;
  var PANE_KEY = "viktorych_shorts_live_pane";
  function paneNow() { return "n" + "ow"; }
  var livePane = paneNow();
  var lastLiveOrder = [];
  var swipeQueue = [];
  var boardEtag = "";
  var boardTimer = 0;
  var wheelLock = 0;
  var manifestWarm = {};
  var mpeg = null;
  var liveZoom = null;
  var liveYt = null;
  var prefetchCtrl = null;
  var PEPSI_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='50' fill='%23004b93'/%3E%3Cpath d='M50 2A48 48 0 0 1 98 50C98 50 80 58 50 42C20 26 2 50 2 50A48 48 0 0 1 50 2Z' fill='%23c8102e'/%3E%3Cpath d='M2 50C2 50 20 26 50 42C80 58 98 50 98 50A48 48 0 0 1 50 98A48 48 0 0 1 2 50Z' fill='%23004b93'/%3E%3Cpath d='M2 50C2 50 20 34 50 50C80 66 98 50 98 50C98 50 80 58 50 42C20 26 2 50 2 50Z' fill='%23ffffff'/%3E%3C/svg%3E";
  var PEPSI_POSTER = PEPSI_AVATAR;
  var LOCKED_KEY = "viktorych_shorts_locked";
  var lockedMode = true;
  try {
    var storedLock = localStorage.getItem(LOCKED_KEY);
    if (storedLock !== null) {
      lockedMode = storedLock === "1";
    }
  } catch (err) { /* private browsing */ }
  var unlockedAccounts = [];

  function isLocked() {
    return !!lockedMode;
  }

  function setLocked(on) {
    lockedMode = !!on;
    try {
      localStorage.setItem(LOCKED_KEY, lockedMode ? "1" : "0");
    } catch (err) { /* private mode */ }
    tellShortsLock();
    livePaintKey = "";
    pastPaintKey = "";
    if (onLiveRoute()) {
      paintLive();
      liveRows().forEach(function (row) { if (row && row.handle) refreshLive(row.handle); });
    } else {
      paintForYou();
    }
    renderLockButtons();
    renderAdded();
    if (hooks.requestRender) {
      try { hooks.requestRender(); } catch (err) {}
    } else if (window.ViktorychAccounts && window.ViktorychAccounts.requestRender) {
      try { window.ViktorychAccounts.requestRender(); } catch (err) {}
    }
    if (window.ViktorychNotes && window.ViktorychNotes.lockChanged) {
      try { window.ViktorychNotes.lockChanged(); } catch (err) {}
    }
  }
  function foldList(list) {
    var next = [];
    (list || []).forEach(function (item) {
      var name = foldHandle(typeof item === "string" ? item : (item && item.handle));
      if (name && next.indexOf(name) < 0) next.push(name);
    });
    return next;
  }
  function tellShortsLock() {
    try {
      var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!worker) return;
      worker.postMessage({ type: "shorts-lock", locked: !!lockedMode, unlocked: unlockedAccounts.slice() });
    } catch (err) { /* the page still filters its own list */ }
  }
  function setUnlocked(list) {
    var next = foldList(list);
    var same = next.length === unlockedAccounts.length && next.every(function (name, i) { return name === unlockedAccounts[i]; });
    unlockedAccounts = next;
    tellShortsLock();
    if (same) return;
    if (window.ViktorychNotes && window.ViktorychNotes.lockChanged) {
      try { window.ViktorychNotes.lockChanged(); } catch (err) {}
    }
  }
  function unlockedList() {
    return unlockedAccounts.slice();
  }
  function setAdded(list) {
    addedAccounts = (list || []).filter(function (row) { return row && row.handle; });
  }
  function isUnlocked(handle) {
    return unlockedAccounts.indexOf(foldHandle(handle)) >= 0;
  }

  function tn(key, n, vars) { var f = (typeof window !== "undefined" && window.tn) || (typeof self !== "undefined" && self.tn); return f ? f(key, n, vars) : String(n); }
  function tr(key, vars) {
    return window.t ? window.t(key, vars) : key;
  }
  function cfg() {
    return window.VIKTORYCH_ACCOUNTS || { api: "", gate: false, tiktokAudience: "owner" };
  }
  function audience() {
    return cfg().tiktokAudience === "all" ? "all" : "owner";
  }
  function gateOn() {
    var row = cfg();
    return row.gate === true && !!row.api;
  }
  function account() {
    return window.ViktorychAccounts && window.ViktorychAccounts.account ? window.ViktorychAccounts.account() : null;
  }
  function visible() {
    if (audience() === "all") {
      if (!gateOn()) return true;
      return !!account();
    }
    if (!gateOn()) return false;
    var row = account();
    return !!(row && row.owner);
  }
  function apiBase() {
    if (window.ViktorychAccounts && window.ViktorychAccounts.currentApi) {
      var cur = window.ViktorychAccounts.currentApi();
      if (cur) return cur;
    }
    return String(cfg().api || cfg().backupApi || "").replace(/\/$/, "");
  }
  function authHeaders() {
    var token = hooks.token();
    return token ? { Authorization: "Bearer " + token } : {};
  }
  function playBase() {
    return mediaRootOverride || apiBase();
  }
  function ownerBases() {
    var row = cfg();
    var primary = String((row && row.api) || "").replace(/\/$/, "");
    var extra = String((row && row.backupApi) || "").replace(/\/$/, "");
    if (!primary && window.ViktorychAccounts && window.ViktorychAccounts.currentApi) primary = String(window.ViktorychAccounts.currentApi() || "").replace(/\/$/, "");
    var list = [];
    if (primary) list.push(primary);
    if (extra && list.indexOf(extra) < 0) list.push(extra);
    return list;
  }
  function baseHealthy(base) {
    var hit = healthCache[base];
    if (hit && Date.now() - hit.at < 60000) return Promise.resolve(!!hit.ok);
    return fetch(base + "/v1/health", { cache: "no-store" }).then(function (res) {
      healthCache[base] = { at: Date.now(), ok: !!(res && res.ok) };
      return !!(res && res.ok);
    }).catch(function () {
      healthCache[base] = { at: Date.now(), ok: false };
      return false;
    });
  }
  function ownerFetch(path, opts) {
    var bases = ownerBases();
    if (!bases.length) return Promise.reject(new Error("api"));
    function once(base) { return fetch(base + path, opts || {}); }
    function failover(res, err) {
      if (bases.length < 2) return err ? Promise.reject(err) : Promise.resolve(res);
      var failed = res && (res.status === 429 || res.status === 502 || res.status === 503);
      if (res && !failed) return Promise.resolve(res);
      return baseHealthy(bases[1]).then(function (ok) {
        if (!ok) return err ? Promise.reject(err) : Promise.resolve(res);
        mediaRootOverride = bases[1];
        return once(bases[1]);
      });
    }
    return once(bases[0]).then(function (res) { return failover(res); }).catch(function (err) { return failover(null, err); });
  }
  function formatBytes(value) {
    var n = Number(value) || 0;
    if (n < 1) return "";
    if (n < 1024) return n + " B";
    var units = ["KB", "MB", "GB"];
    var size = n / 1024;
    var unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    var text = size >= 10 ? String(Math.round(size)) : String(Math.round(size * 10) / 10);
    return text + " " + units[unit];
  }
  function previewsAllowed(mode, saveData, autoplay, network) {
    var choice = mode === "on" || mode === "off" ? mode : "auto";
    if (choice === "off") return false;
    if (choice === "on") return true;
    if (saveData) return false;
    if (autoplay === "never") return false;
    if (autoplay === "wifi" && network && network !== "wifi") return false;
    return true;
  }
  function videoQuality(name) {
    var key = String(name || "").toLowerCase();
    return key !== "ao" && key !== "audio" && key !== "audio_only";
  }
  function lowestPreview(info) {
    var rows = info && info.variants && info.variants.length ? info.variants : [];
    var i;
    for (i = rows.length - 1; i >= 0; i--) {
      if (!rows[i] || !videoQuality(rows[i].quality)) continue;
      if (rows[i].hls) return { kind: "hls", url: String(rows[i].hls), quality: String(rows[i].quality || "") };
      if (rows[i].flv) return { kind: "flv", url: String(rows[i].flv), quality: String(rows[i].quality || "") };
    }
    if (info && videoQuality(info.quality) && info.hls) return { kind: "hls", url: String(info.hls), quality: String(info.quality || "") };
    if (info && videoQuality(info.quality) && info.flv) return { kind: "flv", url: String(info.flv), quality: String(info.quality || "") };
    return null;
  }
  function previewsOn() {
    var settings = hooks.settings() || {};
    var mode = settings.livePreview || "auto";
    var conn = typeof navigator !== "undefined" && (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
    return previewsAllowed(mode, !!(conn && conn.saveData), settings.autoplay || "all", conn && (conn.type || conn.effectiveType) || "");
  }
  function resumeKey(row) {
    var handle = foldHandle(row && row.handle);
    var room = String((row && row.roomId) || "");
    if (!handle || !/^[1-9][0-9]{5,24}$/.test(room)) return "";
    var key = handle + "-" + room;
    return /^[A-Za-z0-9._-]{4,80}$/.test(key) ? key : "";
  }

  function hide() {
    var data = hooks.data();
    if (!data) return;
    data.posts = (data.posts || []).filter(function (post) { return !post || post.platform !== "tiktok"; });
    data.feeds = (data.feeds || []).filter(function (feed) { return !feed || feed.platform !== "tiktok"; });
  }

  function lockedFollowHides(id, handle) {
    var lf = typeof window !== "undefined" && window.ViktorychLocked;
    if (!lf || !lf.hidesId) return false;
    if (id && lf.hidesId(id)) return true;
    var h = String(handle || "").replace(/^@/, "");
    return !!(h && lf.hidesId("tiktok:" + h));
  }

  function absorb(doc) {
    if (!visible() || !doc) return;
    cached = doc;
    var data = hooks.data();
    if (!data) return;
    var feeds = data.feeds || [];
    var posts = data.posts || [];
    (doc.feeds || []).forEach(function (feed) {
      if (!feed || !feed.id) return;
      if (isLocked() && !isUnlocked(feed.handle)) return;
      if (lockedFollowHides(feed.id, feed.handle)) return;
      if (!feeds.some(function (row) { return row && row.id === feed.id; })) feeds.push(feed);
    });
    (doc.posts || []).forEach(function (post) {
      if (!post || !post.id) return;
      if (isLocked() && !isUnlocked(post.handle)) return;
      if (lockedFollowHides(post.feedId, post.handle)) return;
      if (!posts.some(function (row) { return row && row.id === post.id; })) posts.push(post);
    });
    data.feeds = feeds;
    data.posts = posts;
    rememberShorts();
    var settings = hooks.settings() || {};
    if (!Array.isArray(settings.follows)) settings.follows = [];
    var changed = false;
    (doc.feeds || []).forEach(function (feed) {
      if (!feed || !feed.id) return;
      if (isLocked() && !isUnlocked(feed.handle)) return;
      if (lockedFollowHides(feed.id, feed.handle)) return;
      if (settings.follows.indexOf(feed.id) < 0) {
        settings.follows.push(feed.id);
        changed = true;
      }
    });
    if (changed) hooks.save();
  }

  function pull() {
    if (!visible()) return Promise.resolve(null);
    var base = apiBase();
    if (!base || !hooks.token()) return Promise.resolve(cached);
    return fetch(base + "/v1/owner/tiktok", { headers: authHeaders(), cache: "no-store" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (doc) {
      if (doc) absorb(doc);
      return doc;
    }).catch(function () { return null; });
  }

  function forYou() {
    var list = (hooks.posts() || []).slice();
    ((cached && cached.posts) || []).forEach(function (post) {
      if (post && post.id && !list.some(function (row) { return row && row.id === post.id; })) list.push(post);
    });
    return list.filter(function (post) {
      if (!post) return false;
      var url = String(post.url || "");
      var short = post.platform === "tiktok" || post.short === true || url.indexOf("/shorts/") >= 0;
      if (!short) return false;
      var hasMedia = (post.media || []).some(function (item) { return item && (item.type === "video" || item.poster || item.url); });
      if (!hasMedia) return false;
      if (lockedFollowHides(post.feedId, post.handle)) return false;
      if (isLocked()) {
        return isUnlocked(post.handle);
      }
      return true;
    }).slice().sort(function (a, b) {
      var left = String(a.date || "");
      var right = String(b.date || "");
      return left < right ? 1 : left > right ? -1 : 0;
    });
  }

  function foldHandle(value) {
    return String(value || "").toLowerCase();
  }

  function liveMap() {
    var live = cached && cached.live;
    return live && typeof live === "object" ? live : {};
  }

  function liveStatus(handle) {
    var want = foldHandle(handle);
    var live = liveMap();
    var names = Object.keys(live);
    for (var i = 0; i < names.length; i++) {
      var row = live[names[i]];
      if (!row) continue;
      if (foldHandle(row.handle || names[i]) === want) return row;
    }
    return null;
  }

  function rememberedPane() {
    try {
      var stored = localStorage.getItem(PANE_KEY);
      if (stored === "past" || stored === paneNow()) return stored;
    } catch (err) { /* private browsing */ }
    return paneNow();
  }

  function rememberPane(pane) {
    livePane = pane === "past" ? "past" : paneNow();
    try { localStorage.setItem(PANE_KEY, livePane); } catch (err) { /* private browsing */ }
  }

  function paneOf(route) {
    if (route && route.livePane === "past") return "past";
    if (route && route.livePane === paneNow()) return paneNow();
    return "";
  }

  function currentPane(route) {
    var explicit = paneOf(route);
    if (explicit) return explicit;
    if (route && route.live) return rememberedPane();
    return livePane === "past" ? "past" : paneNow();
  }

  function orderLiveNow(rows, previous) {
    var prior = Array.isArray(previous) ? previous.map(foldHandle) : [];
    return (rows || []).slice().sort(function (a, b) {
      var aLive = !!(a && a.live);
      var bLive = !!(b && b.live);
      if (aLive !== bLive) return aLive ? -1 : 1;
      var dv = (Number(a && a.viewers) || 0) - (Number(b && b.viewers) || 0);
      if (dv) return dv;
      var ia = prior.indexOf(foldHandle(a && a.handle));
      var ib = prior.indexOf(foldHandle(b && b.handle));
      if (ia >= 0 && ib >= 0 && ia !== ib) return ia - ib;
      var left = foldHandle(a && a.handle);
      var right = foldHandle(b && b.handle);
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  }

  function neighborHandle(rows, handle, delta) {
    var key = foldHandle(handle);
    var index = -1;
    for (var i = 0; i < rows.length; i++) {
      if (foldHandle(rows[i] && rows[i].handle) === key) { index = i; break; }
    }
    if (index < 0) return "";
    var next = rows[index + (Number(delta) || 0)];
    return next && next.handle ? String(next.handle) : "";
  }

  function streamExpiresAt(url) {
    try {
      var parsed = new URL(String(url || ""));
      var raw = parsed.searchParams.get("expire") || parsed.searchParams.get("expires") || "";
      var n = Number(raw);
      if (!isFinite(n) || n <= 0) return 0;
      return n > 1000000000000 ? n : n * 1000;
    } catch (err) { return 0; }
  }

  function streamFresh(url, now) {
    var text = String(url || "");
    if (!text) return false;
    var exp = streamExpiresAt(text);
    if (!exp) return true;
    return exp > (Number(now) || Date.now()) + 20000;
  }

  function flvAsHls(url) {
    try {
      var parsed = new URL(String(url || ""));
      if (!/\.flv$/i.test(parsed.pathname)) return "";
      parsed.pathname = parsed.pathname.replace(/\.flv$/i, ".m3u8");
      return parsed.toString();
    } catch (err) { return ""; }
  }

  function playbackSteps(info, now) {
    var rows = info && info.variants && info.variants.length ? info.variants : [];
    if (!rows.length && info && (info.hls || info.flv)) rows = [{ quality: info.quality || "", hls: info.hls || "", flv: info.flv || "" }];
    var steps = [];
    var seen = {};
    function push(kind, url, quality) {
      var value = String(url || "");
      if (!value || seen[kind + "\n" + value]) return;
      seen[kind + "\n" + value] = true;
      steps.push({ kind: kind, url: value, quality: String(quality || "") });
    }
    function collect(requireFresh) {
      rows.forEach(function (row) {
        if (!row || !videoQuality(row.quality)) return;
        var hlsUrl = String(row.hls || "");
        var flvUrl = String(row.flv || "");
        if (hlsUrl && (!requireFresh || streamFresh(hlsUrl, now))) push("hls", hlsUrl, row.quality);
        if (flvUrl && (!requireFresh || streamFresh(flvUrl, now))) push("flv", flvUrl, row.quality);
        if (flvUrl && !hlsUrl) {
          var alt = flvAsHls(flvUrl);
          if (alt && (!requireFresh || streamFresh(alt, now))) push("hls", alt, row.quality);
        }
      });
    }
    collect(true);
    if (!steps.length) collect(false);
    return steps;
  }

  function hlsFatalPlan(type, attempt, live) {
    var kind = String(type || "");
    var n = Number(attempt) || 0;
    if (n >= 2) return "next";
    if (kind === "mediaError") return n === 0 ? "recover-media" : (live ? "live-edge" : "next");
    if (kind === "networkError") return n === 0 ? (live ? "live-edge" : "retry") : "next";
    return "next";
  }

  function liveRows() {
    var rows = [];
    var seen = {};
    function push(handle, extra) {
      var key = foldHandle(handle);
      if (!key || seen[key]) return;
      seen[key] = true;
      var status = liveStatus(handle) || {};
      rows.push({
        handle: status.handle || (extra && extra.handle) || handle,
        live: !!status.live,
        viewers: status.viewers || 0,
        title: status.title || (extra && extra.title) || "",
        roomId: status.roomId || "",
        lastLiveAt: status.lastLiveAt || "",
        detail: status.detail || "",
        avatar: (extra && extra.avatar) || status.avatar || avatarFor(handle, extra),
        name: (extra && extra.name) || "",
        record: recordOf(handle)
      });
    }
    if (isLocked()) {
      unlockedAccounts.forEach(function (h) { push(h, {}); });
    } else {
      if (addedAccounts.length) {
        addedAccounts.forEach(function (item) { if (item && item.handle) push(item.handle, item); });
      }
      Object.keys(liveMap()).forEach(function (name) { push(name, liveMap()[name]); });
      unlockedAccounts.forEach(function (h) { push(h, {}); });
    }
    rows.sort(function (a, b) {
      if (!!a.live !== !!b.live) return a.live ? -1 : 1;
      var left = foldHandle(a.handle);
      var right = foldHandle(b.handle);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return rows;
  }

  function videoOf(post) {
    return ((post && post.media) || []).filter(function (item) { return item && item.type === "video"; })[0] || ((post && post.media) || [])[0] || {};
  }

  function qualityLabel(name) {
    var key = String(name || "").toLowerCase();
    if (key === "origin" || key === "origion") return tr("Origin");
    if (key === "uhd") return tr("UHD");
    if (key === "full_hd1") return tr("Full HD");
    if (key === "hd" || key === "hd1") return tr("HD");
    if (key === "sd" || key === "sd1" || key === "sd2") return tr("SD");
    if (key === "ld") return tr("LD");
    return "";
  }

  function qualityText(media) {
    if (!media) return "";
    var height = Number(media.height || 0);
    var codec = String(media.codec || "");
    if (!height && !codec) return "";
    var bits = [];
    if (height) bits.push(height + "p");
    if (codec) bits.push(codec);
    return tr("Original quality") + " · " + bits.join(" ");
  }

  function ownerHere() {
    var row = account();
    return !!(row && row.owner);
  }

  function openText(post) {
    if (post && post.platform === "tiktok") return tr("Open on TikTok");
    if (post && post.platform === "youtube") return tr("View on YouTube");
    return tr("Open original");
  }

  function liked(id) {
    var settings = hooks.settings() || {};
    return !!(settings.likes && settings.likes[id]);
  }
  function saved(id) {
    var settings = hooks.settings() || {};
    return !!(settings.bookmarks && settings.bookmarks[id]);
  }

  function rail(post) {
    var id = post.id || "";
    var media = videoOf(post);
    var replies = (post.stats && post.stats.replies) || 0;
    var profile = "#/" + encodeURIComponent(post.platform || "tiktok") + "/" + encodeURIComponent(post.handle || "");
    return '<div class="shorts-rail">' +
      '<a class="shorts-ava" href="' + hooks.esc(profile) + '" data-shorts="link">' + hooks.avatar(post.avatar, post.author || post.handle) + "</a>" +
      '<button type="button" data-shorts="like" data-id="' + hooks.esc(id) + '" aria-label="' + hooks.esc(tr("Like")) + '">' + hooks.icon(liked(id) ? "heartOn" : "heart") + "<span>" + hooks.esc(hooks.formatCount((post.stats && post.stats.likes) || 0)) + "</span></button>" +
      '<a data-shorts="link" href="' + hooks.esc(post.url || "#") + '" target="_blank" rel="noopener noreferrer" aria-label="' + hooks.esc(tr("Replies")) + '">' + hooks.icon("reply") + "<span>" + hooks.esc(replies ? hooks.formatCount(replies) : "") + "</span></a>" +
      '<button type="button" data-shorts="bookmark" data-id="' + hooks.esc(id) + '" aria-label="' + hooks.esc(tr("Bookmark")) + '">' + hooks.icon(saved(id) ? "bookmarkOn" : "bookmark") + "</button>" +
      '<button type="button" data-shorts="share" data-id="' + hooks.esc(id) + '" aria-label="' + hooks.esc(tr("Share")) + '">' + hooks.icon("share") + "</button>" +
      '<button type="button" data-shorts="mute" aria-label="' + hooks.esc(sound ? tr("Mute") : tr("Unmute")) + '">' + hooks.icon(sound ? "vol" : "volOff") + "</button>" +
      "</div>";
  }

  function postById(id) {
    var list = forYou();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  function slide(post) {
    var media = videoOf(post);
    var profile = "#/" + encodeURIComponent(post.platform || "tiktok") + "/" + encodeURIComponent(post.handle || "");
    var caption = String(post.text || "");
    var still = socialApi().stillKey ? socialApi().stillKey(post, media) : "";
    var posterAttr = still && hooks.token()
      ? ' data-tg="' + hooks.esc(still) + '" data-tg-first="1" data-fallback-src="' + hooks.esc(media.poster || "") + '"'
      : (media.poster ? ' src="' + hooks.esc(media.poster) + '"' : "");
    return '<article class="shorts-slide" data-id="' + hooks.esc(post.id || "") + '" data-kind="video">' +
      '<div class="shorts-stage">' +
      '<video playsinline loop preload="none"' + (media.poster ? ' poster="' + hooks.esc(media.poster) + '"' : "") + ' muted></video>' +
      (media.poster || still ? '<img class="shorts-poster" alt=""' + posterAttr + ' referrerpolicy="no-referrer">' : "") +
      '<button class="shorts-hit" type="button" data-shorts="stage" aria-label="' + hooks.esc(tr("Pause")) + '"></button>' +
      rail(post) +
      '<div class="shorts-meta"><a class="shorts-author" href="' + hooks.esc(profile) + '">@' + hooks.esc(post.handle || "") + "</a>" +
      (caption ? '<p class="shorts-caption">' + hooks.esc(caption) + "</p>" : "") +
      (qualityText(media) ? '<p class="shorts-quality" hidden>' + hooks.esc(qualityText(media)) + "</p>" : "") +
      '<a class="shorts-open" target="_blank" rel="noopener noreferrer" href="' + hooks.esc(post.url || "#") + '">' + hooks.esc(openText(post)) + "</a></div>" +
      "</div></article>";
  }

  function avatarFor(handle, row) {
    if (row && row.avatar) return row.avatar;
    var want = foldHandle(handle);
    var feeds = (cached && cached.feeds) || [];
    for (var i = 0; i < feeds.length; i++) {
      if (feeds[i] && foldHandle(feeds[i].handle) === want && feeds[i].avatar) return feeds[i].avatar;
    }
    for (var j = 0; j < addedAccounts.length; j++) {
      if (addedAccounts[j] && foldHandle(addedAccounts[j].handle) === want && addedAccounts[j].avatar) return addedAccounts[j].avatar;
    }
    return "";
  }

  function recordOf(handle) {
    var items = recordings && recordings.items;
    if (!items) return null;
    return items[foldHandle(handle)] || null;
  }

  function recordLabel(row) {
    var rec = row && row.record;
    if (!rec || !rec.state || rec.state === "blocked") return "";
    if (rec.state === "recording") return tr("Recording ({n} of {cap})", { n: recordings.active || 1, cap: recordings.cap || 12 });
    if (rec.state === "queued") return tr("Queued");
    if (rec.state === "saved") return tr("Saved");
    return "";
  }

  function refreshRecordings() {
    if (!ownerBases().length || !hooks.token() || !ownerHere()) return Promise.resolve(null);
    if (recordingsState !== "ready") recordingsState = "loading";
    return ownerFetch("/v1/owner/tiktok/recordings", { headers: authHeaders(), cache: "no-store" }).then(function (res) {
      if (!res || !res.ok) throw new Error("recordings");
      return res.json();
    }).then(function (body) {
      recordingsState = "ready";
      if (!body || !body.items) return body;
      recordings = { cap: body.cap || 12, active: body.active || 0, items: body.items, past: body.past || [] };
      rememberShorts();
      schedulePaint();
      return body;
    }).catch(function () {
      recordingsState = "error";
      schedulePaint();
      return null;
    });
  }

  function pastSource() {
    var list = recordings && Array.isArray(recordings.past) ? recordings.past : [];
    if (list.length) return list;
    var items = recordings && recordings.items || {};
    return Object.keys(items).map(function (name) {
      var row = items[name];
      if (!row || typeof row !== "object") return null;
      return Object.assign({ handle: row.handle || name }, row);
    }).filter(Boolean);
  }

  function pastRows() {
    if (!ownerHere()) return [];
    return pastSource().filter(function (row) {
      if (!row || !row.handle) return false;
      if (isLocked() && !isUnlocked(row.handle)) return false;
      return row.state === "saved" || row.state === "recording" || row.state === "queued";
    }).slice().sort(function (a, b) {
      var left = String(a.endedAt || a.startedAt || "");
      var right = String(b.endedAt || b.startedAt || "");
      if (left !== right) return left < right ? 1 : -1;
      var lh = foldHandle(a.handle);
      var rh = foldHandle(b.handle);
      return lh < rh ? -1 : lh > rh ? 1 : 0;
    });
  }

  function pastCount() {
    return pastRows().length;
  }

  function pastListHtml() {
    var rows = pastRows();
    if (recordingsState === "loading" && !rows.length) return pastSkeletons();
    if (recordingsState === "error" && !rows.length) return '<div class="shorts-past-empty"><h2>' + hooks.esc(tr("Couldn't load recordings.")) + "</h2></div>";
    if (!rows.length) return '<div class="shorts-past-empty"><h2>' + hooks.esc(tr("No recordings yet.")) + "</h2></div>";
    return '<ol class="shorts-past-grid">' + rows.map(pastCard).join("") + "</ol>";
  }

  function subtabs(pane) {
    if (!ownerHere()) return "";
    var count = pastCount();
    var badge = '<b class="shorts-past-badge" data-shorts="past-count"' + (count ? "" : " hidden") + ">" + (count > 99 ? "99+" : String(count || "")) + "</b>";
    return '<div class="shorts-subtabs"><div class="tabs" role="tablist">' +
      '<a class="tab' + (pane === "past" ? "" : " on") + '" href="#/shorts/live/now" role="tab" aria-selected="' + (pane === "past" ? "false" : "true") + '"><span>' + hooks.esc(tr("Live now")) + "</span></a>" +
      '<a class="tab' + (pane === "past" ? " on" : "") + '" href="#/shorts/live/past" role="tab" aria-selected="' + (pane === "past" ? "true" : "false") + '"><span>' + hooks.esc(tr("Past lives")) + "</span>" + badge + "</a>" +
      "</div></div>";
  }

  function orderedNow() {
    var ordered = orderLiveNow(liveRows(), lastLiveOrder);
    lastLiveOrder = ordered.map(function (row) { return foldHandle(row.handle); });
    swipeQueue = ordered;
    return ordered;
  }

  function liveSlide(row) {
    var handle = String((row && row.handle) || "");
    var profile = "https://www.tiktok.com/@" + encodeURIComponent(handle) + "/live";
    var appProfile = "#/tiktok/" + encodeURIComponent(handle);
    var on = !!(row && row.live);
    var avatar = avatarFor(handle, row);
    var cover = avatar ? '<img class="shorts-poster" alt="" src="' + hooks.esc(avatar) + '" referrerpolicy="no-referrer">' : "";
    var preview = on ? '<video class="shorts-preview" muted playsinline webkit-playsinline preload="none"' + (avatar ? ' poster="' + hooks.esc(avatar) + '"' : "") + "></video>" : "";
    var body = on
      ? cover + preview + '<button class="shorts-hit" type="button" data-shorts="watch" aria-label="' + hooks.esc(tr("LIVE")) + '"></button>'
      : cover + '<div class="shorts-offline"><h2>' + hooks.esc(tr("Not live right now")) + "</h2>" +
        (row && row.lastLiveAt ? "<p>" + hooks.esc(tr("Last live {time}", { time: hooks.fullTime(row.lastLiveAt) })) + "</p>" : "") +
        '<a class="shorts-open" target="_blank" rel="noopener noreferrer" href="' + hooks.esc(profile) + '">' + hooks.esc(tr("Open on TikTok")) + "</a></div>";
    var viewers = on && row.viewers ? '<span class="shorts-viewers">' + hooks.esc(tn("watching", row.viewers || 0, { count: hooks.formatCount(row.viewers || 0, 1000) })) + "</span>" : "";
    var badge = on ? '<span class="shorts-live-tag">' + hooks.esc(tr("LIVE")) + "</span>" : "";
    var recText = recordLabel(row);
    var recBadge = recText ? '<span class="shorts-rec-tag">' + hooks.esc(recText) + "</span>" : "";
    return '<article class="shorts-slide" data-kind="live" data-live="' + (on ? "1" : "0") + '" data-handle="' + hooks.esc(handle) + '">' +
      '<div class="shorts-stage">' + body +
      '<div class="shorts-meta">' + badge + recBadge + viewers +
      '<div><a class="shorts-author" href="' + hooks.esc(appProfile) + '">@' + hooks.esc(handle) + "</a></div>" +
      (row && row.title ? '<p class="shorts-caption">' + hooks.esc(row.title) + "</p>" : "") +
      (on ? '<a class="shorts-open" target="_blank" rel="noopener noreferrer" href="' + hooks.esc(profile) + '">' + hooks.esc(tr("Open on TikTok")) + "</a>" : "") +
      "</div>" +
      (avatar ? '<a class="shorts-ava" style="position:absolute;right:12px;bottom:96px;z-index:2" href="' + hooks.esc(appProfile) + '">' + hooks.avatar(avatar, handle) + "</a>" : "") +
      '<div class="shorts-rail"><button type="button" data-shorts="mute" aria-label="' + hooks.esc(sound ? tr("Mute") : tr("Unmute")) + '">' + hooks.icon(sound ? "vol" : "volOff") + "</button></div>" +
      "</div></article>";
  }

  function lockSvg(locked) {
    if (locked) {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9V7A5 5 0 0 0 7 7v2H5v12h14V9h-2zm-8-2a3 3 0 0 1 6 0v2H9V7zm8 12H7v-8h10v8z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9V7A5 5 0 0 0 7 7h2a3 3 0 0 1 6 0v2H5v12h14V9h-2zm-8 2h8v8H7v-8h2z"/></svg>';
  }

  function tabs(live) {
    var add = ownerHere()
      ? '<button type="button" class="shorts-add" data-shorts="accounts">' + hooks.esc(tr("Add account")) + "</button>"
      : "";
    var locked = isLocked();
    var lockBtn = '<button type="button" class="shorts-lock' + (locked ? " is-locked" : "") + '" data-shorts="toggle-lock" aria-label="' + hooks.esc(locked ? tr("Unlock Shorts") : tr("Lock Shorts")) + '" title="' + hooks.esc(locked ? tr("Unlock Shorts") : tr("Lock Shorts")) + '">' +
      lockSvg(locked) + "<span>" + hooks.esc(locked ? tr("Locked") : tr("Unlocked")) + "</span></button>";
    return '<div class="shorts-tabs"><div class="tabs-bar"><div class="tabs" role="tablist">' +
      '<a class="tab' + (live ? " on" : "") + '" href="#/shorts/live/' + rememberedPane() + '" role="tab" aria-selected="' + (live ? "true" : "false") + '"><span>' + hooks.esc(tr("Live")) + "</span></a>" +
      '<a class="tab' + (live ? "" : " on") + '" href="#/shorts" role="tab" aria-selected="' + (live ? "false" : "true") + '"><span>' + hooks.esc(tr("For you")) + "</span></a>" +
      "</div></div>" + lockBtn + add + "</div>";
  }

  function renderUnlocked() {
    return unlockedAccounts.map(function (handle) {
      return '<li class="shorts-account">' +
        '<span class="shorts-account-face">' + hooks.avatar("", handle) + "</span>" +
        '<span><b>' + hooks.esc(handle) + '</b><small>@' + hooks.esc(handle) + '</small><span class="shorts-pill unlocked">' + hooks.esc(tr("Unlocked")) + "</span></span>" +
        "</li>";
    }).join("");
  }

  function renderAddedHtml() {
    if (isLocked()) return "";
    var allLocked = [];
    addedAccounts.forEach(function (row) {
      if (row && row.handle && !isUnlocked(row.handle)) {
        allLocked.push(row);
      }
    });
    return allLocked.map(function (row) {
      var handle = String((row && row.handle) || "");
      var name = String((row && row.name) || handle);
      var face = row && row.avatar
        ? '<img alt="" src="' + hooks.esc(row.avatar) + '" referrerpolicy="no-referrer">'
        : hooks.avatar("", name);
      var lockedBadge = '<span class="shorts-pill locked">' + hooks.esc(tr("Locked behind")) + "</span>";
      var actionBtn = row.builtIn
        ? '<span class="shorts-fixed-badge">' + hooks.esc(tr("Default")) + "</span>"
        : '<button type="button" data-shorts="remove-account" data-handle="' + hooks.esc(handle) + '">' + hooks.esc(tr("Remove")) + "</button>";
      return '<li class="shorts-account"><span class="shorts-account-face">' + face + "</span><span><b>" + hooks.esc(name) + "</b><small>@" + hooks.esc(handle) + "</small>" + lockedBadge + "</span>" +
        '<div class="shorts-account-actions">' + actionBtn + "</div></li>";
    }).join("");
  }

  function accountSheet() {
    if (!ownerHere()) return "";
    var locked = isLocked();
    return '<div class="shorts-sheet" id="shorts-accounts" hidden>' +
      '<div class="shorts-sheet-card" role="dialog" aria-labelledby="shorts-accounts-title">' +
      '<div class="shorts-sheet-head"><h2 id="shorts-accounts-title">' + hooks.esc(tr("Add account")) + "</h2>" +
      '<button type="button" class="shorts-sheet-x" data-shorts="close-accounts" aria-label="' + hooks.esc(tr("Close")) + '">×</button></div>' +
      '<form class="shorts-add-form">' +
      '<input name="handle" autocomplete="off" spellcheck="false" placeholder="' + hooks.esc(tr("Add account URL or @handle")) + '" aria-label="' + hooks.esc(tr("Add account URL or @handle")) + '">' +
      '<button type="submit">' + hooks.esc(tr("Add account")) + "</button></form>" +
      '<p class="shorts-accounts-note" id="shorts-accounts-note"></p>' +
      '<div class="shorts-lock-panel">' +
      '<div class="shorts-lock-info"><b>' + hooks.esc(tr("Locked mode")) + "</b><small>" + hooks.esc(tr("When locked, only unlocked accounts are visible.")) + "</small></div>" +
      '<button type="button" class="shorts-lock-toggle' + (locked ? " on" : "") + '" data-shorts="toggle-lock">' + lockSvg(locked) + "<span>" + hooks.esc(locked ? tr("Locked") : tr("Unlocked")) + "</span></button>" +
      "</div>" +
      "<h3>" + hooks.esc(tr("Unlocked accounts")) + "</h3>" +
      '<ul class="shorts-account-list shorts-unlocked-list" id="shorts-unlocked">' + renderUnlocked() + "</ul>" +
      "<h3>" + hooks.esc(tr("added accounts")) + "</h3>" +
      '<ul class="shorts-account-list" id="shorts-added">' + renderAddedHtml() + "</ul></div></div>";
  }

  var captchaActive = null;

  function openCaptchaModal(opts) {
    opts = opts || {};
    captchaActive = opts;
    var modal = document.getElementById("tiktok-captcha-modal");
    if (!modal && typeof document !== "undefined" && document.body) {
      var wrap = document.createElement("div");
      wrap.innerHTML = captchaModalHtml();
      if (wrap.firstElementChild) {
        document.body.appendChild(wrap.firstElementChild);
        modal = document.getElementById("tiktok-captcha-modal");
      }
    }
    if (!modal) return;
    modal.onclick = function (e) {
      if (e.target && e.target.id === "tiktok-captcha-modal") {
        closeCaptchaModal();
        return;
      }
      var captchaBtn = e.target.closest ? e.target.closest("[data-captcha]") : null;
      if (captchaBtn) {
        e.preventDefault();
        var ckind = captchaBtn.getAttribute("data-captcha");
        if (ckind === "close") closeCaptchaModal();
        else if (ckind === "retry") retryCaptchaAction();
      }
    };
    var handle = String(opts.handle || "tiktok").replace(/^@/, "");
    var url = opts.url || ("https://www.tiktok.com/@" + encodeURIComponent(handle));
    var handleEl = document.getElementById("tt-captcha-handle");
    if (handleEl) handleEl.textContent = "@" + handle;
    var linkEl = document.getElementById("tt-captcha-link");
    if (linkEl) {
      linkEl.href = url;
      linkEl.onclick = function (e) {
        try {
          var pop = window.open(url, "tt_verify", "width=580,height=720,menubar=no,toolbar=no,location=yes,status=no");
          if (pop) {
            e.preventDefault();
            pop.focus();
          }
        } catch (err) {}
      };
    }
    modal.hidden = false;
  }

  function closeCaptchaModal() {
    var modal = document.getElementById("tiktok-captcha-modal");
    if (modal) modal.hidden = true;
    captchaActive = null;
  }

  function retryCaptchaAction() {
    var active = captchaActive;
    closeCaptchaModal();
    if (active && typeof active.onRetry === "function") {
      active.onRetry();
    }
  }

  if (typeof window !== "undefined") {
    window.showTikTokCaptcha = openCaptchaModal;
  }

  function captchaModalHtml() {
    return '<div class="tiktok-captcha-modal" id="tiktok-captcha-modal" hidden role="dialog" aria-modal="true" aria-labelledby="tt-captcha-title">' +
      '<div class="tiktok-captcha-card">' +
      '<div class="tiktok-captcha-head">' +
      '<div class="tiktok-captcha-badge">' +
      '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/></svg>' +
      '<span id="tt-captcha-title">' + hooks.esc(tr("TikTok Verification")) + '</span>' +
      '</div>' +
      '<button type="button" class="tiktok-captcha-x" data-captcha="close" aria-label="' + hooks.esc(tr("Close")) + '">×</button>' +
      '</div>' +
      '<div class="tiktok-captcha-body">' +
      '<p class="tiktok-captcha-desc" id="tt-captcha-desc">' + hooks.esc(tr("TikTok requires a quick verification or reached a temporary limit. Complete the challenge to continue.")) + '</p>' +
      '<div class="tiktok-captcha-target">' +
      '<span class="tiktok-captcha-handle" id="tt-captcha-handle">@tiktok</span>' +
      '</div>' +
      '<div class="tiktok-captcha-actions">' +
      '<a class="tiktok-captcha-btn solve" id="tt-captcha-link" href="#" target="_blank" rel="noopener noreferrer">' +
      '<span>' + hooks.esc(tr("Open TikTok to Solve")) + '</span>' +
      '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42L17.58 5H14V3zM5 5h6V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6h-2v6H5V5z"/></svg>' +
      '</a>' +
      '<button type="button" class="tiktok-captcha-btn retry" data-captcha="retry">' + hooks.esc(tr("I’ve completed it — Continue")) + '</button>' +
      '</div></div></div></div>';
  }

  function mhead() {
    return '<div class="mhead"><button class="m-ava" data-act="drawer" type="button" aria-label="' + hooks.esc(tr("Menu")) + '"><span class="ava initials">Y</span></button>' +
      '<a class="m-logo" href="#/" aria-label="' + hooks.esc(hooks.productName()) + '">' + hooks.logo() + "</a>" +
      '<a class="m-icon" href="#/settings" aria-label="' + hooks.esc(tr("Settings")) + '">' + hooks.icon("spark") + "</a></div>";
  }

  function clock(seconds) {
    var n = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!n) return "";
    var h = Math.floor(n / 3600);
    var m = Math.floor((n % 3600) / 60);
    var s = n % 60;
    function pad(v) { return v < 10 ? "0" + v : String(v); }
    if (h) return h + ":" + pad(m) + ":" + pad(s);
    return m + ":" + pad(s);
  }

  function pastSkeletons() {
    var cards = "";
    for (var i = 0; i < 6; i++) cards += '<li class="shorts-past-tile is-skeleton" aria-hidden="true"><span></span><span></span></li>';
    return '<ol class="shorts-past-grid" aria-busy="true" aria-label="' + hooks.esc(tr("Loading past lives")) + '">' + cards + "</ol>";
  }

  function hydrateThumbs() {
    var nodes = document.querySelectorAll("video.shorts-past-frame[data-thumb]");
    for (var i = 0; i < nodes.length; i++) {
      (function (node) {
        var url = node.getAttribute("data-thumb");
        if (!url || node.getAttribute("src")) return;
        fetch(url, { headers: authHeaders() }).then(function (res) {
          if (!res.ok) return null;
          return res.blob();
        }).then(function (blob) {
          if (!blob || !node.isConnected) return;
          node.src = URL.createObjectURL(blob);
        }).catch(function () {});
      })(nodes[i]);
    }
  }

  function pastFace(row) {
    var handle = String(row.handle || "");
    var room = String(row.roomId || "");
    var base = playBase();
    if (row.thumb && base && room) {
      var frame = base + "/v1/owner/tiktok/thumb/" + encodeURIComponent(handle) + "/" + encodeURIComponent(room);
      var fallback = row.cover || avatarFor(handle, row);
      return '<video class="shorts-past-frame" muted playsinline preload="metadata" data-thumb="' + hooks.esc(frame) + '"' +
        (fallback ? ' poster="' + hooks.esc(fallback) + '"' : "") + "></video>";
    }
    var cover = row.cover || avatarFor(handle, row);
    return cover ? '<img alt="" src="' + hooks.esc(cover) + '" referrerpolicy="no-referrer">' : "";
  }

  function pastCard(row, index) {
    var handle = String(row.handle || "");
    var recording = row.state === "recording" || row.state === "queued";
    var tag = recording ? tr("Recording ({n} of {cap})", { n: recordings.active || 1, cap: recordings.cap || 12 }) : "";
    var when = row.startedAt && hooks.fullTime ? hooks.fullTime(row.startedAt) : "";
    var dur = clock(row.duration);
    var size = formatBytes(row.bytes);
    var bits = [];
    var label = qualityLabel(row.quality);
    if (label) bits.push(label);
    if (row.qualityNote) bits.push(tr("Best available"));
    if (row.viewers) bits.push(tr("Peak {count}", { count: hooks.formatCount(row.viewers, 1000) }));
    if (size) bits.push(tr("Size {size}", { size: size }));
    var playable = !!row.key;
    var tagHtml = tag ? '<b class="shorts-rec-badge">' + hooks.esc(tag) + "</b>" : "";
    var body = pastFace(row) + tagHtml +
      (dur ? '<span class="shorts-past-dur">' + hooks.esc(dur) + "</span>" : "") +
      '<span class="shorts-past-copy"><b>@' + hooks.esc(handle) + "</b>" +
      (row.title ? "<small>" + hooks.esc(row.title) + "</small>" : "") +
      (when ? "<small>" + hooks.esc(when) + "</small>" : "") +
      (bits.length ? "<small>" + hooks.esc(bits.join(" · ")) + "</small>" : "") +
      "</span>";
    if (!playable) return '<li class="shorts-past-tile">' + body + "</li>";
    return '<li class="shorts-past-tile"><button type="button" class="shorts-past-play" data-shorts="past" data-past="' + index + '">' + body + "</button></li>";
  }

  function page(route) {
    if (!visible()) return '<div class="shorts-page"></div>';
    var live = !!(route && route.live);
    var pane = paneNow();
    if (live) {
      var explicit = paneOf(route);
      if (explicit) rememberPane(explicit);
      pane = explicit || rememberedPane();
    }
    var slides = "";
    if (!live) slides = forYou().map(slide).join("");
    else if (pane === "past") slides = pastListHtml();
    else slides = orderedNow().map(liveSlide).join("");
    if (!slides) {
      slides = live
        ? (pane === "past" ? pastListHtml() : '<article class="shorts-slide" data-kind="live"><div class="shorts-stage"></div></article>')
        : '<article class="shorts-slide"><div class="shorts-stage"><div class="shorts-offline"><h2>' + hooks.esc(tr("No posts yet")) + "</h2></div></div></article>";
    }
    return '<div class="shorts-page"><div class="shorts-top">' + mhead() + tabs(live) + (live ? subtabs(pane) : "") + "</div>" +
      '<div class="shorts-feed' + (live && pane === "past" ? " is-past" : "") + '" id="shorts-feed">' + slides + "</div>" + accountSheet() + captchaModalHtml() + "</div>";
  }

  function releaseNamed(slot) {
    var fn = slot === "preview" ? previewPeerRelease : peerRelease;
    if (!fn) return;
    try { fn(); } catch (err) { /* the mesh can already be gone */ }
    if (slot === "preview") previewPeerRelease = null;
    else peerRelease = null;
  }

  function hookPeer(player, Hls, url, slot) {
    var api = window.ViktorychPeer;
    if (!api || !player) return;
    if (window.ViktorychPeerMedia && window.ViktorychPeerMedia.applyHls) window.ViktorychPeerMedia.applyHls(player, Hls);
    if (!api.ready) return;
    api.ready().then(function (mod) {
      if (!mod) return;
      var current = slot === "preview" ? previewHls : hls;
      if (current !== player) return;
      if (mod.applyHls) mod.applyHls(player, Hls);
      releaseNamed(slot);
      if (mod.watch) {
        var stop = mod.watch(url);
        if (slot === "preview") previewPeerRelease = stop;
        else peerRelease = stop;
      }
    });
  }

  function destroyHls() {
    releaseNamed("main");
    if (hls) {
      try { hls.destroy(); } catch (err) { /* already gone */ }
      hls = null;
    }
  }

  function loadHls() {
    if (window.Hls) return Promise.resolve(window.Hls);
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "hls-1.7.3.min.js";
      script.onload = function () { resolve(window.Hls); };
      script.onerror = function () { reject(new Error("hls")); };
      document.head.appendChild(script);
    });
  }

  function sameApi(url) {
    var base = apiBase();
    if (!base) return false;
    try { return new URL(url, location.href).origin === new URL(base).origin; }
    catch (err) { return false; }
  }

  function levelCodec(level) {
    if (!level) return "";
    if (level.videoCodec) return String(level.videoCodec);
    if (level.attrs && level.attrs.CODECS) return String(level.attrs.CODECS).split(",")[0].trim();
    return "";
  }

  function videoCodecOk(codecs) {
    var video = String(codecs || "").split(",")[0].trim();
    if (!video) return true;
    if (/^(mp4a|aac|opus|mp3)/i.test(video)) return false;
    var ask = typeof MediaSource !== "undefined" && MediaSource.isTypeSupported;
    if (ask) {
      try {
        if (!MediaSource.isTypeSupported('video/mp4; codecs="' + video + '"')) return false;
      } catch (err) { /* the frame watchdog still moves on */ }
    } else if (/hvc1|hev1|hevc|bytevc1|h265/i.test(video)) return false;
    return true;
  }

  function levelScore(level) {
    return (Number(level && level.bitrate) || 0) * 100000 + (Number(level && level.height) || 0);
  }

  function topLevel(player) {
    var levels = player.levels || [];
    var top = -1;
    var best = -1;
    var fallback = 0;
    var fallbackScore = -1;
    for (var i = 0; i < levels.length; i++) {
      var score = levelScore(levels[i]);
      if (score >= fallbackScore) {
        fallbackScore = score;
        fallback = i;
      }
      if (!videoCodecOk(levelCodec(levels[i]))) continue;
      if (score >= best) {
        best = score;
        top = i;
      }
    }
    if (!levels.length) return -1;
    return top >= 0 ? top : fallback;
  }

  function lowerPlayable(player, current) {
    var levels = player.levels || [];
    var ceiling = current >= 0 && levels[current] ? levelScore(levels[current]) : Infinity;
    var best = -1;
    var pick = -1;
    for (var i = 0; i < levels.length; i++) {
      if (i === current || !videoCodecOk(levelCodec(levels[i]))) continue;
      var score = levelScore(levels[i]);
      if (score < ceiling && score >= best) {
        best = score;
        pick = i;
      }
    }
    return pick;
  }

  function waitForFrames(video, ms) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(ok) {
        if (done) return;
        done = true;
        video.removeEventListener("resize", onSize);
        resolve(!!ok);
      }
      function onSize() {
        if (video.videoWidth > 0) finish(true);
      }
      video.addEventListener("resize", onSize);
      if (video.videoWidth > 0) { finish(true); return; }
      setTimeout(function () { finish(video.videoWidth > 0); }, ms);
    });
  }

  function playOrTap(video) {
    var started = video.play();
    if (!started || !started.catch) return Promise.resolve();
    return started.catch(function (err) {
      if (!err || err.name !== "NotAllowedError") throw err;
      return new Promise(function (resolve, reject) {
        var stage = video.parentNode;
        if (!stage) { reject(err); return; }
        function go() {
          stage.removeEventListener("pointerdown", go);
          video.muted = true;
          var again = video.play();
          if (!again || !again.then) { resolve(); return; }
          again.then(resolve).catch(reject);
        }
        stage.addEventListener("pointerdown", go);
      });
    });
  }

  function revealWhenFrames(video, token) {
    function hide() {
      if (token !== liveToken || !(video.videoWidth > 0)) return;
      var root = video.closest ? video.closest("#shorts-live-player") : null;
      var cover = root && root.querySelector(".shorts-live-cover");
      if (cover) cover.hidden = true;
    }
    video.addEventListener("playing", hide);
    video.addEventListener("resize", hide);
  }

  function showLiveLevel(player, level, pinned) {
    if (!onLiveLevel) return;
    var row = (player.levels || [])[level] || {};
    onLiveLevel(level === pinned, Number(row.height) || 0);
  }

  function climbLive(player, pinRef) {
    clearTimeout(climbTimer);
    climbTimer = setTimeout(function () {
      if (qualityLock || hls !== player) return;
      var current = player.currentLevel;
      var pinned = pinRef.level;
      if (current >= 0 && current < pinned) {
        player.currentLevel = current + 1;
        showLiveLevel(player, player.currentLevel, pinned);
        if (player.currentLevel < pinned) climbLive(player, pinRef);
      }
    }, 20000);
  }

  function watchStalls(player, Hls, pinRef) {
    var stalls = 0;
    player.on(Hls.Events.ERROR, function (event, data) {
      if (qualityLock || !data || data.fatal) return;
      var stall = data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR;
      if (!stall) return;
      stalls += 1;
      if (stalls < 3) return;
      stalls = 0;
      var current = player.currentLevel;
      if (current > 0) {
        player.currentLevel = current - 1;
        showLiveLevel(player, player.currentLevel, pinRef.level);
        climbLive(player, pinRef);
      }
    });
    player.on(Hls.Events.FRAG_BUFFERED, function () { stalls = 0; });
  }

  function playHls(video, url, authed, autoplay, forceMuted, pin, mode) {
    var live = mode !== "vod";
    var start = autoplay !== false;
    var muted = forceMuted ? true : !sound;
    hlsDead = false;
    return loadHls().then(function (Hls) {
      destroyHls();
      if (!Hls || !Hls.isSupported()) {
        if (authed) throw new Error("hls");
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.crossOrigin = "anonymous";
          video.src = url;
          video.muted = muted;
          return start ? video.play() : Promise.resolve();
        }
        throw new Error("hls");
      }
      var attempt = 0;
      var playerOpts = {
        enableWorker: false,
        capLevelToPlayerSize: false,
        startLevel: -1,
        startFragPrefetch: true,
        maxBufferHole: 0.5,
        xhrSetup: function (xhr, target) {
          xhr.withCredentials = false;
          if (authed && sameApi(target)) {
            var headers = authHeaders();
            if (headers.Authorization) xhr.setRequestHeader("Authorization", headers.Authorization);
          }
        }
      };
      if (live) playerOpts.liveSyncDurationCount = 3;
      else {
        playerOpts.maxSeekHole = 2;
        playerOpts.backBufferLength = 90;
        playerOpts.nudgeMaxRetry = 6;
        playerOpts.maxBufferLength = 30;
        playerOpts.maxMaxBufferLength = 120;
        if (Number(video._startAt) > 3) playerOpts.startPosition = Number(video._startAt);
      }
      var player = new Hls(playerOpts);
      hls = player;
      hookPeer(player, Hls, url, "main");
      player.loadSource(url);
      player.attachMedia(video);
      video.muted = muted;
      return new Promise(function (resolve, reject) {
        var settled = false;
        player.on(Hls.Events.ERROR, function (event, data) {
          if (!data || !data.fatal || hls !== player) return;
          console.error("live playback", data.type, data.details, data);
          var plan = hlsFatalPlan(data.type, attempt, live);
          attempt += 1;
          if (plan === "recover-media") {
            try { player.recoverMediaError(); return; } catch (err) { plan = "next"; }
          } else if (plan === "live-edge") {
            try { player.startLoad(-1); return; } catch (err) { plan = "next"; }
          } else if (plan === "retry") {
            try { player.startLoad(); return; } catch (err) { plan = "next"; }
          }
          hlsDead = true;
          var err = new Error(String(data.type || "hls") + " " + String(data.details || ""));
          if (!settled) { settled = true; reject(err); return; }
          if (liveFatal) liveFatal(err);
        });
        player.on(Hls.Events.MANIFEST_PARSED, function () {
          if (hls !== player) return;
          var top = topLevel(player);
          var pinRef = { level: top };
          player.capLevelToPlayerSize = false;
          /* Save data with HD off: stay below 720p and let the player adapt. */
          var saver = typeof window !== "undefined" ? window.ViktorychDataSaver : null;
          if (saver && saver.allow && !saver.allow("hd")) {
            var sd = 0;
            (player.levels || []).forEach(function (level, index) { if ((Number(level && level.height) || 0) < 720 && (Number(level && level.height) || 0) > 0) sd = index; });
            player.autoLevelCapping = sd;
            player.capLevelToPlayerSize = true;
            pin = false;
          }
          if (pin && !qualityLock && top >= 0) {
            player.startLevel = top;
            player.currentLevel = top;
            showLiveLevel(player, top, top);
            watchStalls(player, Hls, pinRef);
          }
          if (!start) { settled = true; resolve(); return; }
          function acceptOrStep(level) {
            if (hls !== player) return;
            return playOrTap(video).then(function () {
              return waitForFrames(video, live ? 6000 : 20000);
            }).then(function (ok) {
              if (hls !== player || settled) return;
              if (ok) {
                pinRef.level = level;
                settled = true;
                resolve();
                return;
              }
              var lower = lowerPlayable(player, level);
              if (lower >= 0) {
                pinRef.level = lower;
                player.currentLevel = lower;
                showLiveLevel(player, lower, top);
                return acceptOrStep(lower);
              }
              hlsDead = true;
              try { player.stopLoad(); } catch (err) { /* the next ladder step starts clean */ }
              settled = true;
              reject(new Error("no-frames"));
            }).catch(function (err) {
              if (!settled) { settled = true; reject(err); }
            });
          }
          acceptOrStep(player.currentLevel);
        });
      });
    });
  }

  function tgUrl(key) {
    var api = apiBase();
    if (!api || !key) return "";
    return playBase() + "/tg/" + String(key).split("/").map(function (part) { return encodeURIComponent(part); }).join("/");
  }

  function socialApi() {
    return window.ViktorychSocial || {};
  }

  function dropBody(res) {
    if (!res || !res.body || !res.body.cancel) return;
    var dropped = res.body.cancel();
    if (dropped && dropped.catch) dropped.catch(function () {});
  }

  function playbackError(status) {
    var err = new Error(String(status || "tg"));
    if (status === 404) err.code = "backing";
    else if (status === 429) err.code = "limited";
    else if (status === 401 || status === "signedout") err.code = "signedout";
    else err.code = "play";
    return err;
  }

  function playbackNote(err) {
    if (err && err.code === "backing") return tr("Backing up…");
    if (err && err.code === "limited") return tr("Too many plays. Try again in a minute.");
    if (err && err.code === "signedout") return tr("Signed out");
    return tr("Couldn't play this video");
  }

  function refreshToken() {
    var accounts = window.ViktorychAccounts;
    if (!accounts || !accounts.refreshToken) return Promise.resolve(hooks.token() || "");
    return accounts.refreshToken().then(function (token) {
      return token || hooks.token() || "";
    }).catch(function () { return hooks.token() || ""; });
  }

  function whenPlaybackAuth() {
    var accounts = window.ViktorychAccounts;
    if (!accounts || !accounts.syncPlaybackAuth) return Promise.resolve();
    return accounts.syncPlaybackAuth().catch(function () {});
  }

  function slowLink() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return false;
    if (conn.saveData) return true;
    var kind = String(conn.effectiveType || "").toLowerCase();
    return kind === "2g" || kind === "slow-2g";
  }

  function prefetchUrls(text, playlistUrl) {
    var init = "";
    var segs = [];
    String(text || "").split(/\r?\n/).forEach(function (line) {
      var row = line.trim();
      if (!row) return;
      if (row.indexOf("#EXT-X-MAP:") === 0) {
        var found = row.match(/URI="([^"]+)"/);
        if (found) init = found[1];
        return;
      }
      if (row.charAt(0) !== "#") segs.push(row);
    });
    var urls = [];
    function abs(ref) {
      try { return new URL(ref, playlistUrl).href; }
      catch (err) { return ""; }
    }
    if (init) {
      var initUrl = abs(init);
      if (initUrl) urls.push(initUrl);
    }
    for (var i = 0; i < segs.length && urls.length < (init ? 3 : 2); i++) {
      var segUrl = abs(segs[i]);
      if (segUrl) urls.push(segUrl);
    }
    return urls;
  }

  function prefetchParts(urls) {
    if (prefetchCtrl) prefetchCtrl.abort();
    var ctrl = new AbortController();
    prefetchCtrl = ctrl;
    var chain = Promise.resolve();
    urls.forEach(function (url) {
      chain = chain.then(function () {
        if (ctrl.signal.aborted) return;
        return fetch(url, { headers: authHeaders(), signal: ctrl.signal }).then(function (part) {
          if (!part || !part.ok) { dropBody(part); return; }
          return part.arrayBuffer();
        }).catch(function () {});
      });
    });
    return chain;
  }

  function playTelegramVideo(video, key, preload, retried) {
    var fileUrl = tgUrl(key);
    if (!fileUrl) return Promise.reject(playbackError("play"));
    if (!hooks.token()) {
      if (retried) return Promise.reject(playbackError("signedout"));
      return refreshToken().then(function (token) {
        if (!token) return Promise.reject(playbackError("signedout"));
        return playTelegramVideo(video, key, preload, true);
      });
    }
    var autoplay = preload === "auto";
    var playlist = fileUrl + "/index.m3u8";
    return fetch(playlist, { headers: authHeaders() }).then(function (res) {
      var type = String(res.headers.get("content-type") || "").toLowerCase();
      if (res.status === 401 && !retried) {
        dropBody(res);
        return refreshToken().then(function (token) {
          if (!token) return Promise.reject(playbackError("signedout"));
          return playTelegramVideo(video, key, preload, true);
        });
      }
      if (res.status === 429 || res.status === 401) {
        dropBody(res);
        return Promise.reject(playbackError(res.status));
      }
      if (res.ok && (type.indexOf("mpegurl") >= 0 || type.indexOf("m3u8") >= 0)) {
        if (!autoplay) {
          if (slowLink()) { dropBody(res); return Promise.resolve(); }
          return res.text().then(function (text) { return prefetchParts(prefetchUrls(text, playlist)); });
        }
        dropBody(res);
        return playHls(video, playlist, true, true, false);
      }
      dropBody(res);
      if (!autoplay) return Promise.resolve();
      return fetch(fileUrl, {
        headers: Object.assign({ Range: "bytes=0-1" }, authHeaders()),
        cache: "no-store"
      }).then(function (file) {
        dropBody(file);
        if (file.status === 401 && !retried) {
          return refreshToken().then(function (token) {
            if (!token) return Promise.reject(playbackError("signedout"));
            return playTelegramVideo(video, key, preload, true);
          });
        }
        if (file.status === 404 || file.status === 429 || file.status === 401) return Promise.reject(playbackError(file.status));
        if (file.status !== 200 && file.status !== 206) return Promise.reject(playbackError(file.status));
        return whenPlaybackAuth().then(function () {
          destroyHls();
          video.crossOrigin = "anonymous";
          video.loop = true;
          video.muted = !sound;
          video.preload = "auto";
          if (video.getAttribute("src") !== fileUrl) video.src = fileUrl;
          return video.play();
        });
      });
    });
  }

  function proxyUrl(direct) {
    return playBase() + "/v1/owner/media?url=" + encodeURIComponent(direct);
  }

  function destroyMpeg() {
    if (!mpeg) return;
    try { mpeg.pause(); } catch (err) { /* already stopped */ }
    try { mpeg.unload(); } catch (err) { /* already unloaded */ }
    try { mpeg.detachMediaElement(); } catch (err) { /* already detached */ }
    try { mpeg.destroy(); } catch (err) { /* already gone */ }
    mpeg = null;
  }

  function loadMpeg() {
    if (window.mpegts) return Promise.resolve(window.mpegts);
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "mpegts-1.8.0.min.js";
      script.onload = function () { resolve(window.mpegts); };
      script.onerror = function () { reject(new Error("mpegts")); };
      document.head.appendChild(script);
    });
  }

  function playFlv(video, url, authed, soft) {
    return loadMpeg().then(function (mpegts) {
      destroyHls();
      destroyMpeg();
      if (!mpegts || !mpegts.isSupported || !mpegts.isSupported()) throw new Error("mpegts");
      var player = mpegts.createPlayer({
        type: "flv",
        isLive: true,
        url: url,
        hasAudio: true,
        hasVideo: true,
        cors: true,
        withCredentials: false
      }, {
        enableWorker: false,
        headers: authed ? authHeaders() : {},
        liveBufferLatencyChasing: true
      });
      mpeg = player;
      player.attachMediaElement(video);
      video.muted = true;
      player.load();
      return new Promise(function (resolve, reject) {
        var done = false;
        function fail(err) {
          console.error("live playback", err || "flv");
          if (done) {
            if (liveFatal) liveFatal(err || new Error("flv"));
            return;
          }
          done = true;
          reject(err || new Error("flv"));
        }
        if (mpegts.Events && mpegts.Events.ERROR) player.on(mpegts.Events.ERROR, function (err) {
          var detail = String((err && (err.details || err.msg || err.message || err.type)) || err || "");
          if (!soft && /EarlyEof|NETWORK_EXCEPTION|NETWORK_TIMEOUT/i.test(detail)) {
            destroyMpeg();
            playFlv(video, url, authed, true).then(function () {
              if (!done) { done = true; resolve(player); }
            }).catch(fail);
            return;
          }
          fail(err);
        });
        var started = video.play();
        if (started && started.then) started.then(function () { if (!done) { done = true; resolve(player); } }).catch(fail);
        else if (!done) { done = true; resolve(player); }
      });
    });
  }

  function rememberLive(handle, info, quiet) {
    if (!cached) cached = { live: {} };
    if (!cached.live) cached.live = {};
    var slot = handle;
    var prev = {};
    Object.keys(cached.live).forEach(function (name) {
      var row = cached.live[name];
      if (row && foldHandle(row.handle || name) === foldHandle(handle)) {
        slot = name;
        prev = row;
      }
    });
    var next = {
      handle: (info && info.handle) || handle,
      live: !!(info && info.live),
      viewers: info && info.viewers || 0,
      title: info && info.title || prev.title || "",
      roomId: (info && info.roomId) || prev.roomId || "",
      lastLiveAt: (info && info.lastLiveAt) || prev.lastLiveAt || "",
      checkedAt: (info && info.checkedAt) || prev.checkedAt || "",
      detail: (info && info.detail) || ""
    };
    cached.live[slot] = next;
    if (quiet && next.live) {
      patchViewers(next.handle, next);
      return;
    }
    schedulePaint();
  }

  function patchViewers(handle, row) {
    var feed = document.getElementById("shorts-feed");
    if (!feed || !onLiveRoute()) return;
    var want = foldHandle(handle);
    var slides = feed.querySelectorAll(".shorts-slide");
    for (var i = 0; i < slides.length; i++) {
      if (slides[i].getAttribute("data-kind") !== "live") continue;
      if (foldHandle(slides[i].getAttribute("data-handle")) !== want) continue;
      var slot = slides[i].querySelector(".shorts-viewers");
      var text = row.live && row.viewers ? tn("watching", row.viewers, { count: hooks.formatCount(row.viewers, 1000) }) : "";
      if (!slot && text) {
        schedulePaint();
        return;
      }
      if (slot) slot.textContent = text;
    }
  }

  function refreshLive(handle, fresh) {
    var key = (fresh ? "fresh:" : "") + foldHandle(handle);
    if (!key || key === "fresh:") return Promise.resolve(null);
    if (liveInflight[key]) return liveInflight[key];
    if (!ownerBases().length || !hooks.token()) return Promise.resolve(null);
    var job = ownerFetch("/v1/owner/live/" + encodeURIComponent(handle) + (fresh ? "?fresh=1" : ""), { headers: authHeaders(), cache: "no-store" }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (info) {
      if (info) rememberLive(handle, info);
      return info;
    }).catch(function () { return null; }).then(function (info) {
      delete liveInflight[key];
      return info;
    });
    liveInflight[key] = job;
    return job;
  }

  function refreshStats(handle, roomId) {
    var key = foldHandle(handle);
    if (!key) return Promise.resolve(null);
    var inflightKey = "stats:" + key;
    if (liveInflight[inflightKey]) return liveInflight[inflightKey];
    if (!ownerBases().length || !hooks.token()) return Promise.resolve(null);
    var url = "/v1/owner/live/" + encodeURIComponent(handle) + "?stats=1";
    if (roomId && /^[1-9][0-9]{5,24}$/.test(String(roomId))) url += "&room=" + encodeURIComponent(roomId);
    var job = ownerFetch(url, { headers: authHeaders(), cache: "no-store" }).then(function (res) {
      if (res.status === 429 || !res.ok) return null;
      return res.json();
    }).then(function (info) {
      if (info && !info.blocked) rememberLive(handle, Object.assign({ roomId: roomId || "" }, info), true);
      return info;
    }).catch(function () { return null; }).then(function (info) {
      delete liveInflight[inflightKey];
      return info;
    });
    liveInflight[inflightKey] = job;
    return job;
  }

  function onLiveRoute() {
    return /#\/shorts\/live(?:$|[/?#])/.test(location.hash);
  }

  function schedulePaint() {
    clearTimeout(paintTimer);
    paintTimer = setTimeout(paintLive, 40);
  }

  function paintForYou() {
    var feed = document.getElementById("shorts-feed");
    if (!feed || onLiveRoute()) return;
    var posts = forYou();
    var slides = posts.map(slide).join("");
    if (!slides) {
      slides = '<article class="shorts-slide"><div class="shorts-stage"><div class="shorts-offline"><h2>' + hooks.esc(tr("No posts yet")) + "</h2></div></div></article>";
    }
    feed.innerHTML = slides;
    initZoomOnFeed();
    playActive();
  }

  function initZoomOnFeed() {
    var feed = document.getElementById("shorts-feed");
    if (!feed) return;
    var zoomSlides = feed.querySelectorAll('.shorts-slide[data-kind="video"]');
    for (var z = 0; z < zoomSlides.length; z++) {
      if (zoomSlides[z]._zoom) continue;
      var zoomStage = zoomSlides[z].querySelector(".shorts-stage");
      if (zoomStage) zoomSlides[z]._zoom = bindVideoZoom(zoomStage);
    }
  }

  function renderLockButtons() {
    var locked = isLocked();
    var btns = document.querySelectorAll('[data-shorts="toggle-lock"]');
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      if (btn.classList.contains("shorts-lock")) {
        btn.className = "shorts-lock" + (locked ? " is-locked" : "");
        btn.setAttribute("aria-label", locked ? tr("Unlock Shorts") : tr("Lock Shorts"));
        btn.setAttribute("title", locked ? tr("Unlock Shorts") : tr("Lock Shorts"));
        btn.innerHTML = lockSvg(locked) + "<span>" + hooks.esc(locked ? tr("Locked") : tr("Unlocked")) + "</span>";
      } else if (btn.classList.contains("shorts-lock-toggle")) {
        btn.className = "shorts-lock-toggle" + (locked ? " on" : "");
        btn.innerHTML = lockSvg(locked) + "<span>" + hooks.esc(locked ? tr("Locked") : tr("Unlocked")) + "</span>";
      }
    }
  }

  function toggleLock() {
    setLocked(!isLocked());
    if (onLiveRoute()) {
      paintLive();
      liveRows().forEach(function (row) { if (row && row.handle) refreshLive(row.handle); });
    } else {
      paintForYou();
    }
    renderAdded();
  }

  function routePane() {
    if (/#\/shorts\/live\/past(?:$|[?#])/.test(location.hash)) return "past";
    if (new RegExp("#/shorts/live/" + paneNow() + "(?:$|[?#])").test(location.hash)) return paneNow();
    return livePane === "past" ? "past" : paneNow();
  }

  function playingLive() {
    var root = liveRoot();
    return !!(root && root.getAttribute("data-mode") !== "saved");
  }

  function syncPastBadge() {
    var badge = document.querySelector("[data-shorts='past-count']");
    if (!badge) return;
    var count = pastCount();
    badge.hidden = !count;
    badge.textContent = count > 99 ? "99+" : (count ? String(count) : "");
  }

  function patchViewerLabels(rows) {
    var feed = document.getElementById("shorts-feed");
    if (!feed) return;
    rows.forEach(function (row) {
      var slides = feed.querySelectorAll(".shorts-slide");
      for (var i = 0; i < slides.length; i++) {
        if (foldHandle(slides[i].getAttribute("data-handle")) !== foldHandle(row.handle)) continue;
        var slot = slides[i].querySelector(".shorts-viewers");
        var text = row.live && row.viewers ? tn("watching", row.viewers, { count: hooks.formatCount(row.viewers, 1000) }) : "";
        if (slot) slot.textContent = text;
      }
    });
  }

  function flipFeed(feed, html) {
    var before = {};
    var nodes = feed.querySelectorAll("[data-handle]");
    for (var i = 0; i < nodes.length; i++) before[nodes[i].getAttribute("data-handle")] = nodes[i].getBoundingClientRect().top;
    feed.innerHTML = html;
    var after = feed.querySelectorAll("[data-handle]");
    for (var j = 0; j < after.length; j++) {
      var name = after[j].getAttribute("data-handle");
      if (!Object.prototype.hasOwnProperty.call(before, name)) continue;
      var dy = before[name] - after[j].getBoundingClientRect().top;
      if (!dy) continue;
      after[j].style.transform = "translateY(" + dy + "px)";
      after[j].style.transition = "none";
      (function (el) {
        var frame = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
        frame(function () {
          frame(function () {
            el.style.transition = "transform 280ms ease";
            el.style.transform = "";
          });
        });
      })(after[j]);
    }
  }

  function paintLive() {
    var feed = document.getElementById("shorts-feed");
    if (!feed || !onLiveRoute()) return;
    var pane = routePane();
    syncPastBadge();
    feed.classList.toggle("is-past", pane === "past");
    if (pane === "past") {
      var past = pastRows();
      var pastKey = recordingsState + "\npast\n" + past.map(function (row) {
        return [row.handle, row.state || "", row.roomId || "", row.key || "", row.endedAt || row.startedAt || "", row.viewers || 0, row.title || "", row.bytes || 0, row.thumb || "", row.duration || 0].join("\n");
      }).join("\n");
      if (pastKey === livePaintKey && feed.querySelector(".shorts-past-tile, .shorts-past-empty, .is-skeleton")) return;
      livePaintKey = pastKey;
      feed.innerHTML = pastListHtml();
      hydrateThumbs();
      return;
    }
    var rows = orderedNow();
    if (playingLive()) {
      patchViewerLabels(rows);
      return;
    }
    var key = "now\n" + rows.map(function (row) {
      var rec = row.record || {};
      return [row.handle, row.live ? 1 : 0, row.viewers || 0, row.lastLiveAt || "", row.title || "", rec.state || "", rec.key || ""].join("\n");
    }).join("\n");
    if (key === livePaintKey && feed.querySelector(".shorts-slide")) return;
    livePaintKey = key;
    var slides = rows.map(liveSlide).join("");
    flipFeed(feed, slides || '<article class="shorts-slide" data-kind="live"><div class="shorts-stage"></div></article>');
    armPreview();
  }

  function liveRoot() {
    return document.getElementById("shorts-live-player");
  }

  function bindVideoZoom(stage) {
    if (!stage) return null;
    var zoom = { scale: 1, x: 0, y: 0 };
    var zoomTap = 0;
    var gesture = "";
    var pts = {};
    var pinch = null;
    var drag = null;
    function list() {
      return Object.keys(pts).map(function (id) { return pts[id]; });
    }
    function mediaNodes() {
      return stage.querySelectorAll("video, .shorts-poster");
    }
    function lockFeed() {
      var feed = stage.closest && stage.closest(".shorts-feed");
      if (!feed) return;
      feed.classList.toggle("shorts-zoomed", !!feed.querySelector(".shorts-stage.shorts-zoomed"));
    }
    function apply() {
      if (zoom.scale <= 1) {
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
      }
      var maxX = Math.max(0, (stage.clientWidth * (zoom.scale - 1)) / 2);
      var maxY = Math.max(0, (stage.clientHeight * (zoom.scale - 1)) / 2);
      if (zoom.x > maxX) zoom.x = maxX;
      if (zoom.x < -maxX) zoom.x = -maxX;
      if (zoom.y > maxY) zoom.y = maxY;
      if (zoom.y < -maxY) zoom.y = -maxY;
      var transform = zoom.scale === 1 ? "" : "translate3d(" + zoom.x + "px," + zoom.y + "px,0) scale(" + zoom.scale + ")";
      var nodes = mediaNodes();
      for (var i = 0; i < nodes.length; i++) nodes[i].style.transform = transform;
      stage.classList.toggle("shorts-zoomed", zoom.scale > 1);
      lockFeed();
    }
    function setScale(scale) {
      zoom.scale = Math.max(1, Math.min(5, scale));
      if (zoom.scale === 1) { zoom.x = 0; zoom.y = 0; }
      apply();
    }
    function toggleAt(clientX, clientY) {
      if (zoom.scale > 1.05) {
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
        apply();
        return;
      }
      var rect = stage.getBoundingClientRect();
      var lx = clientX - rect.left - rect.width / 2;
      var ly = clientY - rect.top - rect.height / 2;
      zoom.scale = 2.5;
      zoom.x = lx * (1 - 2.5);
      zoom.y = ly * (1 - 2.5);
      apply();
    }
    function onDown(event) {
      gesture = "";
      var control = event.target.closest && event.target.closest("button, a, input, label");
      if (control && control.getAttribute("data-shorts") !== "stage") return;
      pts[event.pointerId] = { x: event.clientX, y: event.clientY };
      var points = list();
      if (points.length >= 2 || zoom.scale > 1) {
        try { stage.setPointerCapture(event.pointerId); } catch (err) { /* the pointer still moves */ }
      }
      if (points.length >= 2) {
        drag = null;
        pinch = {
          dist: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1,
          scale: zoom.scale,
          x: zoom.x,
          y: zoom.y,
          mx: (points[0].x + points[1].x) / 2,
          my: (points[0].y + points[1].y) / 2
        };
      } else if (zoom.scale > 1) {
        drag = { x: event.clientX, y: event.clientY, ox: zoom.x, oy: zoom.y, moved: false };
      }
    }
    function onMove(event) {
      if (!pts[event.pointerId]) return;
      pts[event.pointerId] = { x: event.clientX, y: event.clientY };
      var points = list();
      if (points.length >= 2 && pinch) {
        event.preventDefault();
        event.stopPropagation();
        var dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1;
        var mx = (points[0].x + points[1].x) / 2;
        var my = (points[0].y + points[1].y) / 2;
        zoom.scale = Math.max(1, Math.min(5, pinch.scale * dist / pinch.dist));
        zoom.x = pinch.x + (mx - pinch.mx);
        zoom.y = pinch.y + (my - pinch.my);
        apply();
        return;
      }
      if (drag && zoom.scale > 1) {
        event.preventDefault();
        event.stopPropagation();
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) drag.moved = true;
        zoom.x = drag.ox + (event.clientX - drag.x);
        zoom.y = drag.oy + (event.clientY - drag.y);
        apply();
      }
    }
    function onUp(event) {
      var wasPinch = !!pinch && list().length >= 2;
      var moved = !!(drag && drag.moved);
      var control = event.target.closest && event.target.closest("button, a, input, label");
      var onControl = control && control.getAttribute("data-shorts") !== "stage";
      delete pts[event.pointerId];
      if (list().length < 2) pinch = null;
      if (!list().length) drag = null;
      if (wasPinch || moved || onControl) {
        zoomTap = 0;
        gesture = wasPinch ? "pinch" : (moved ? "drag" : "");
        return;
      }
      if (list().length) return;
      var now = Date.now();
      if (now - zoomTap < 300) {
        zoomTap = 0;
        gesture = "double";
        toggleAt(event.clientX, event.clientY);
      } else zoomTap = now;
    }
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    stage.addEventListener("touchmove", function (event) {
      event.stopPropagation();
      if (event.touches.length > 1 || zoom.scale > 1) event.preventDefault();
    }, { passive: false });
    stage.addEventListener("wheel", function (event) {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      setScale(zoom.scale * Math.exp(-event.deltaY * 0.002));
    }, { passive: false });
    var gestureBase = 1;
    stage.addEventListener("gesturestart", function (event) {
      event.preventDefault();
      gestureBase = zoom.scale;
    }, { passive: false });
    stage.addEventListener("gesturechange", function (event) {
      event.preventDefault();
      setScale(gestureBase * (event.scale || 1));
    }, { passive: false });
    return {
      reset: function () {
        zoom.scale = 1;
        zoom.x = 0;
        zoom.y = 0;
        zoomTap = 0;
        gesture = "";
        apply();
      },
      scale: function () { return zoom.scale; },
      takeGesture: function () {
        var kind = gesture;
        gesture = "";
        return kind;
      }
    };
  }

  function syncMute(button) {
    var label = sound ? tr("Mute") : tr("Unmute");
    if (button) {
      button.setAttribute("aria-label", label);
      button.innerHTML = hooks.icon(sound ? "vol" : "volOff");
    }
    var video = liveRoot() && liveRoot().querySelector("video");
    if (video) video.muted = !sound;
  }

  function showLiveMessage(handle, text, retry, verify) {
    var root = liveRoot();
    if (!root || root.getAttribute("data-handle") !== handle) return;
    var cover = root.querySelector(".shorts-live-cover");
    var note = root.querySelector(".shorts-live-note");
    if (note) note.textContent = text || "";
    var link = root.querySelector(".shorts-live-cover a");
    if (link) link.hidden = false;
    if (retry) ensureRetry(root);
    else {
      var old = root.querySelector("[data-shorts='retry-live']");
      if (old) old.remove();
    }
    var oldVerify = root.querySelector("[data-shorts='open-captcha']");
    if (verify) {
      if (!oldVerify && cover) {
        var vbtn = document.createElement("button");
        vbtn.type = "button";
        vbtn.className = "shorts-live-verify";
        vbtn.setAttribute("data-shorts", "open-captcha");
        vbtn.setAttribute("data-handle", handle);
        vbtn.textContent = tr("Solve verification");
        cover.appendChild(vbtn);
      }
    } else if (oldVerify) oldVerify.remove();
    if (cover) cover.hidden = false;
    var video = root.querySelector("video");
    if (video) {
      try { video.pause(); } catch (err) { /* already paused */ }
    }
  }

  function ensureRetry(root) {
    var cover = root.querySelector(".shorts-live-cover");
    if (!cover || cover.querySelector("[data-shorts='retry-live']")) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "shorts-live-retry";
    button.setAttribute("data-shorts", "retry-live");
    button.textContent = tr("Retry");
    var link = cover.querySelector("a");
    if (link) cover.insertBefore(button, link);
    else cover.appendChild(button);
  }

  function stopStats() {
    clearInterval(statsTimer);
    statsTimer = 0;
    statsHandle = "";
    statsRoom = "";
  }

  function pauseStats() {
    clearInterval(statsTimer);
    statsTimer = 0;
  }

  function statsTick() {
    var root = liveRoot();
    if (!root || !statsHandle || document.visibilityState === "hidden") return;
    var handle = statsHandle;
    refreshStats(handle, statsRoom).then(function (info) {
      applyPlayerStats(handle, info);
    });
  }

  function startStats(handle, roomId) {
    pauseStats();
    statsHandle = handle;
    statsRoom = roomId || "";
    statsTimer = setInterval(statsTick, 15000);
  }

  function applyPlayerStats(handle, info) {
    var root = liveRoot();
    if (!root || root.getAttribute("data-handle") !== handle || !info || info.blocked) return;
    if (info.live === false) {
      endLive(handle);
      return;
    }
    var viewers = root.querySelector(".shorts-live-viewers");
    if (viewers) viewers.textContent = info.viewers ? tn("watching", info.viewers, { count: hooks.formatCount(info.viewers, 1000) }) : "";
  }

  function endLive(handle) {
    var root = liveRoot();
    if (!root || root.getAttribute("data-handle") !== handle) return;
    stopStats();
    destroyHls();
    destroyMpeg();
    var badge = root.querySelector(".shorts-live-tag");
    if (badge) badge.hidden = true;
    var video = root.querySelector("video");
    if (video) {
      try { video.pause(); } catch (err) { /* already paused */ }
      video.removeAttribute("src");
      try { video.load(); } catch (err) { /* the cover stays */ }
    }
    showLiveMessage(handle, tr("Live ended"));
    showWatchLink(handle);
  }

  function savedRecording(handle) {
    var want = foldHandle(handle);
    var rows = pastRows();
    for (var i = 0; i < rows.length; i++) {
      if (foldHandle(rows[i].handle) === want && rows[i].state === "saved" && rows[i].key) return rows[i];
    }
    var rec = recordOf(handle);
    return rec && rec.state === "saved" && rec.key ? rec : null;
  }

  function showWatchLink(handle) {
    var root = liveRoot();
    if (!root || !savedRecording(handle)) return;
    var cover = root.querySelector(".shorts-live-cover");
    if (!cover || cover.querySelector("[data-shorts='watch-recording']")) {
      var have = cover && cover.querySelector("[data-shorts='watch-recording']");
      if (have) have.hidden = false;
      return;
    }
    var link = document.createElement("a");
    link.href = "#/shorts/live/past?watch=" + encodeURIComponent(handle);
    link.setAttribute("data-shorts", "watch-recording");
    link.textContent = tr("Watch recording");
    cover.appendChild(link);
  }

  function attemptSources(video, info, mode) {
    var steps = playbackSteps(info);
    var index = 0;
    function one(step) {
      var jobs = [function () {
        return step.kind === "flv"
          ? playFlv(video, step.url, false)
          : playHls(video, step.url, false, true, mode !== "vod", mode !== "vod", mode);
      }];
      if (!sameApi(step.url)) {
        var proxied = proxyUrl(step.url);
        jobs.push(function () {
          return step.kind === "flv"
            ? playFlv(video, proxied, true)
            : playHls(video, proxied, true, true, mode !== "vod", mode !== "vod", mode);
        });
      }
      var job = 0;
      function nextJob(err) {
        if (err) console.error("live playback", err && err.message ? err.message : err);
        if (job >= jobs.length) return Promise.reject(err || new Error("step"));
        var fn = jobs[job];
        job += 1;
        return fn().catch(nextJob);
      }
      return nextJob();
    }
    function chain(err) {
      if (index >= steps.length) return Promise.reject(err || new Error("none"));
      var step = steps[index];
      index += 1;
      return one(step).catch(chain);
    }
    if (!steps.length) return Promise.reject(new Error("none"));
    return chain();
  }

  function attemptLive(video, info) {
    return attemptSources(video, info, "live");
  }

  function openSaved(handle, row) {
    if (!row) {
      var want = foldHandle(handle);
      var found = pastRows().filter(function (item) {
        return item && foldHandle(item.handle) === want && item.key;
      })[0];
      row = found || recordOf(handle);
    }
    var rec = row;
    handle = String(handle || (rec && rec.handle) || "");
    if (!handle || !rec || !rec.key) return;
    if (rec.state !== "saved" && rec.state !== "recording" && rec.state !== "queued") return;
    if (!window.YtPlayer) return;
    closeLive();
    var token = liveToken;
    var parts = Math.max(1, Number(rec.parts) || 1);
    var part = 1;
    var recording = rec.state === "recording" || rec.state === "queued";
    var profile = "https://www.tiktok.com/@" + encodeURIComponent(handle) + "/live";
    var avatar = rec.cover || avatarFor(handle, liveStatus(handle) || {});
    var root = document.createElement("div");
    root.id = "shorts-live-player";
    root.className = "shorts-live-player is-saved";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("data-handle", handle);
    root.setAttribute("data-room", rec.roomId || "");
    root.setAttribute("data-mode", recording ? "recording" : "saved");
    root.innerHTML = '<div class="shorts-live-stage"></div>' +
      '<div class="shorts-live-cover" hidden>' +
      (avatar ? '<img alt="" src="' + hooks.esc(avatar) + '" referrerpolicy="no-referrer">' : "") +
      '<p class="shorts-live-note"></p>' +
      '<a hidden target="_blank" rel="noopener noreferrer" href="' + hooks.esc(profile) + '">' + hooks.esc(tr("Open on TikTok")) + "</a>" +
      "</div>" +
      '<div class="shorts-live-hud"><button type="button" data-shorts="close-live" aria-label="' + hooks.esc(tr("Close")) + '">×</button>' +
      '<span class="shorts-live-tag">' + hooks.esc(recording ? tr("Recording") : tr("Saved")) + "</span></div>";
    document.body.appendChild(root);
    document.documentElement.classList.add("shorts-live-open");
    var stage = root.querySelector(".shorts-live-stage");
    liveZoom = bindVideoZoom(stage);
    var resumeAt = savedResume(rec, 0);
    liveYt = new window.YtPlayer(stage, {
      poster: rec.cover || "",
      scrubImage: rec.cover || "",
      resume: resumeAt,
      post: { title: rec.title || "" },
      onPrevious: function () {
        var neighbor = pastNeighbor(rec, -1);
        if (neighbor) openSaved(neighbor.handle, neighbor);
      },
      onNext: function () {
        var neighbor = pastNeighbor(rec, 1);
        if (neighbor) openSaved(neighbor.handle, neighbor);
      },
      onDownload: function (button) { downloadOriginal(rec, button); },
      onTime: function (time, duration) {
        var video = liveYt && liveYt.video;
        if (!video) return;
        var now = Date.now();
        if (video._resumeAt && now - video._resumeAt < 5000) return;
        video._resumeAt = now;
        rememberResume(rec, time, duration, true);
      }
    });
    var video = liveYt.video;
    video.muted = !sound;
    video.autoplay = true;
    video._startAt = resumeAt;
    revealWhenFrames(video, token);
    video.addEventListener("ended", function () {
      if (token !== liveToken || stitchedPlay) return;
      if (part < parts) playPart(part + 1);
    });
    root.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("[data-shorts]") : null;
      if (!button) return;
      var kind = button.getAttribute("data-shorts");
      if (kind === "close-live") {
        event.preventDefault();
        closeLive();
      } else if (kind === "retry-live") {
        event.preventDefault();
        var againHandle = root.getAttribute("data-handle") || handle;
        var againRoom = root.getAttribute("data-room") || "";
        var again = pastRows().filter(function (item) {
          return item && foldHandle(item.handle) === foldHandle(againHandle) && String(item.roomId || "") === againRoom && item.key;
        })[0];
        openSaved(againHandle, again);
      }
    });
    function failSaved(err) {
      if (token !== liveToken) return;
      if (err) console.error("live playback", err && err.message ? err.message : err);
      showLiveMessage(handle, tr("Couldn't play this live"), true);
    }
    function playPart(next) {
      part = next;
      stitchedPlay = false;
      var key = String(rec.key || "").replace(/\/\d+$/, "") + "/" + part;
      playHls(video, tgUrl(key) + "/index.m3u8", true, true, false, false, "vod").catch(failSaved);
    }
    stitchedPlay = true;
    playHls(video, tgUrl(String(rec.key || "").replace(/\/\d+$/, "")) + "/index.m3u8", true, true, false, false, "vod").catch(function () {
      if (token !== liveToken) return;
      playPart(1);
    });
  }

  function closeLive() {
    liveToken += 1;
    liveFatal = null;
    onLiveLevel = null;
    qualityLock = false;
    hlsDead = false;
    stitchedPlay = false;
    clearTimeout(climbTimer);
    climbTimer = 0;
    stopStats();
    if (liveZoom) liveZoom.reset();
    liveZoom = null;
    if (liveYt) {
      try { liveYt.destroy(); } catch (err) { /* already gone */ }
      liveYt = null;
    }
    destroyHls();
    destroyMpeg();
    var root = liveRoot();
    if (root) {
      var video = root.querySelector("video");
      if (video) {
        try { video.pause(); } catch (err) { /* already paused */ }
        video.removeAttribute("src");
        try { video.load(); } catch (err) { /* the element is going away */ }
      }
      root.remove();
    }
    document.documentElement.classList.remove("shorts-live-open");
  }

  function pastNeighbor(row, delta) {
    var rows = pastRows().filter(function (item) { return item && item.key; });
    var index = -1;
    for (var i = 0; i < rows.length; i++) {
      if (foldHandle(rows[i].handle) === foldHandle(row && row.handle) && String(rows[i].roomId || "") === String(row && row.roomId || "")) {
        index = i;
        break;
      }
    }
    if (index < 0) return null;
    return rows[index + (Number(delta) || 0)] || null;
  }

  function savedResume(row, duration) {
    var key = resumeKey(row);
    var slot = key && resumeMap[key];
    var at = slot ? Number(slot.t) || 0 : 0;
    if (!(at > 3)) return 0;
    if (duration && isFinite(duration) && at > duration - 8) return 0;
    return at;
  }

  function rememberResume(row, time, duration, now) {
    var key = resumeKey(row);
    var at = Number(time) || 0;
    if (!key || !(at > 3)) return;
    if (duration && isFinite(duration) && at > duration - 8) return;
    resumeMap[key] = { t: Math.round(at * 10) / 10, at: Date.now() };
    try { localStorage.setItem("viktorych_shorts_resume", JSON.stringify(resumeMap)); } catch (err) { /* private mode */ }
    if (!now) return;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(pushResume, 400);
  }

  function pullResume() {
    if (!ownerBases().length || !hooks.token()) return Promise.resolve(null);
    return ownerFetch("/v1/owner/live-resume", { headers: authHeaders(), cache: "no-store" }).then(function (res) {
      if (!res || !res.ok) return null;
      return res.json();
    }).then(function (body) {
      var items = body && body.items || {};
      Object.keys(items).forEach(function (key) {
        var row = items[key];
        if (!row) return;
        var prev = resumeMap[key];
        if (!prev || Number(row.at) >= Number(prev.at)) resumeMap[key] = { t: Number(row.t) || 0, at: Number(row.at) || 0 };
      });
      try { localStorage.setItem("viktorych_shorts_resume", JSON.stringify(resumeMap)); } catch (err) { /* private mode */ }
      return resumeMap;
    }).catch(function () { return null; });
  }

  function pushResume() {
    if (!ownerBases().length || !hooks.token()) return Promise.resolve(null);
    return ownerFetch("/v1/owner/live-resume", {
      method: "PUT",
      headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
      body: JSON.stringify({ items: resumeMap })
    }).catch(function () { return null; });
  }

  function loadResume() {
    try {
      var saved = JSON.parse(localStorage.getItem("viktorych_shorts_resume") || "{}");
      if (saved && typeof saved === "object") resumeMap = saved;
    } catch (err) { resumeMap = {}; }
    return pullResume();
  }

  function crc32(bytes) {
    if (!crc32.table) {
      var table = new Uint32Array(256);
      for (var i = 0; i < 256; i++) {
        var c = i;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
      }
      crc32.table = table;
    }
    var crc = 0xffffffff;
    for (var n = 0; n < bytes.length; n++) crc = crc32.table[(crc ^ bytes[n]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zipStore(files) {
    var locals = [];
    var central = [];
    var offset = 0;
    files.forEach(function (file) {
      var name = new TextEncoder().encode(file.name);
      var data = file.data;
      var crc = crc32(data);
      var local = new Uint8Array(30 + name.length);
      var view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      locals.push(local, data);
      var row = new Uint8Array(46 + name.length);
      var head = new DataView(row.buffer);
      head.setUint32(0, 0x02014b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 20, true);
      head.setUint32(16, crc, true);
      head.setUint32(20, data.length, true);
      head.setUint32(24, data.length, true);
      head.setUint16(28, name.length, true);
      head.setUint32(42, offset, true);
      row.set(name, 46);
      central.push(row);
      offset += local.length + data.length;
    });
    var centralSize = central.reduce(function (sum, row) { return sum + row.length; }, 0);
    var end = new Uint8Array(22);
    var tail = new DataView(end.buffer);
    tail.setUint32(0, 0x06054b50, true);
    tail.setUint16(8, files.length, true);
    tail.setUint16(10, files.length, true);
    tail.setUint32(12, centralSize, true);
    tail.setUint32(16, offset, true);
    return new Blob(locals.concat(central, [end]), { type: "application/zip" });
  }

  function saveBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadOriginal(row, button) {
    var playlist = tgUrl(row && row.key) + "/index.m3u8";
    if (!playlist || playlist.indexOf("/index.m3u8") !== playlist.length - "/index.m3u8".length) return;
    var label = button ? button.textContent : "";
    if (button) button.disabled = true;
    var headers = authHeaders();
    fetch(playlist, { headers: headers, cache: "no-store" }).then(function (res) {
      if (!res.ok) return Promise.reject(new Error("playlist"));
      return res.text();
    }).then(function (text) {
      var urls = [];
      String(text || "").split(/\r?\n/).forEach(function (line) {
        var map = line.match(/URI="([^"]+)"/);
        if (map) urls.push(map[1]);
        else if (line && line.charAt(0) !== "#") urls.push(line.trim());
      });
      var files = [];
      var total = 0;
      var chain = Promise.resolve();
      urls.forEach(function (url, index) {
        chain = chain.then(function () {
          if (total > 80 * 1024 * 1024) return null;
          return fetch(url, { headers: headers }).then(function (res) {
            if (!res.ok) return null;
            return res.arrayBuffer();
          }).then(function (buf) {
            if (!buf) return null;
            total += buf.byteLength;
            if (total > 80 * 1024 * 1024) return null;
            var name = "part-" + String(index + 1).padStart(3, "0") + (/\.mp4(\?|$)/.test(url) ? ".mp4" : ".m4s");
            files.push({ name: name, data: new Uint8Array(buf) });
            return null;
          });
        });
      });
      return chain.then(function () {
        if (!files.length || total > 80 * 1024 * 1024) return Promise.reject(new Error("size"));
        var handle = foldHandle(row.handle) || "live";
        saveBlob(zipStore(files), handle + "-" + String(row.roomId || "live") + ".zip");
        return null;
      });
    }).catch(function () {
      if (button) button.textContent = label;
    }).then(function () {
      if (button) {
        button.disabled = false;
        if (!button.textContent) button.textContent = label;
      }
    });
  }

  function stopPreview() {
    previewToken += 1;
    previewHandle = "";
    releaseNamed("preview");
    if (previewHls) {
      try { previewHls.destroy(); } catch (err) { /* already gone */ }
      previewHls = null;
    }
    var nodes = document.querySelectorAll("video.shorts-preview");
    for (var i = 0; i < nodes.length; i++) {
      try { nodes[i].pause(); } catch (err) { /* already quiet */ }
      nodes[i].removeAttribute("src");
      nodes[i].hidden = false;
    }
  }

  function playPreview(video, step, token) {
    if (step.kind === "flv") {
      return loadMpeg().then(function (mpegts) {
        if (token !== previewToken || !mpegts || !mpegts.isSupported()) return Promise.reject(new Error("mpegts"));
        return new Promise(function (resolve, reject) {
          var player = mpegts.createPlayer({ type: "flv", isLive: true, url: proxyUrl(step.url) }, { headers: authHeaders() });
          player.attachMediaElement(video);
          player.on(mpegts.Events.ERROR, function () { reject(new Error("flv")); });
          player.load();
          playOrTap(video).then(function () { return waitForFrames(video, 6000); }).then(function (ok) {
            if (!ok) { reject(new Error("no-frames")); return; }
            resolve();
          }).catch(reject);
        });
      });
    }
    var direct = proxyUrl(step.url);
    return loadHls().then(function (Hls) {
      if (token !== previewToken) return null;
      if (!Hls || !Hls.isSupported()) return Promise.reject(new Error("hls"));
      var player = new Hls({ autoStartLoad: true, startLevel: -1, capLevelToPlayerSize: true, xhrSetup: function (xhr) { var tokenValue = hooks.token(); if (tokenValue) xhr.setRequestHeader("Authorization", "Bearer " + tokenValue); } });
      previewHls = player;
      hookPeer(player, Hls, direct, "preview");
      player.loadSource(direct);
      player.attachMedia(video);
      return new Promise(function (resolve, reject) {
        player.on(Hls.Events.ERROR, function (event, data) {
          if (!data || !data.fatal || previewHls !== player) return;
          reject(new Error("hls"));
        });
        player.on(Hls.Events.MANIFEST_PARSED, function () {
          if (previewHls !== player) return;
          function acceptPreview(level) {
            if (previewHls !== player) return;
            if (level >= 0) player.currentLevel = level;
            playOrTap(video).then(function () { return waitForFrames(video, 6000); }).then(function (ok) {
              if (previewHls !== player) return;
              if (ok) { resolve(); return; }
              var higher = -1;
              var floor = level >= 0 && player.levels[level] ? levelScore(player.levels[level]) : -1;
              var best = Infinity;
              var rows = player.levels || [];
              for (var i = 0; i < rows.length; i++) {
                if (i === level || !videoCodecOk(levelCodec(rows[i]))) continue;
                var score = levelScore(rows[i]);
                if (score > floor && score <= best) { best = score; higher = i; }
              }
              if (higher >= 0) { acceptPreview(higher); return; }
              reject(new Error("no-frames"));
            }).catch(reject);
          }
          var start = -1;
          var cheapest = Infinity;
          var rows = player.levels || [];
          for (var n = 0; n < rows.length; n++) {
            if (!videoCodecOk(levelCodec(rows[n]))) continue;
            var score = levelScore(rows[n]);
            if (score <= cheapest) { cheapest = score; start = n; }
          }
          if (start < 0) start = topLevel(player);
          acceptPreview(start);
        });
      });
    });
  }

  function startPreview(slide) {
    if (!slide || !previewsOn() || liveRoot()) return;
    var handle = slide.getAttribute("data-handle") || "";
    if (!handle || foldHandle(handle) === foldHandle(previewHandle)) return;
    stopPreview();
    var token = previewToken;
    previewHandle = handle;
    var video = slide.querySelector("video.shorts-preview");
    if (!video) return;
    refreshLive(handle).then(function (info) {
      if (token !== previewToken) return;
      var step = lowestPreview(info);
      if (!step) { video.hidden = true; return; }
      return playPreview(video, step, token).then(function () {
        var poster = slide.querySelector(".shorts-poster");
        if (poster) poster.hidden = true;
      });
    }).catch(function () {
      if (token !== previewToken) return;
      video.hidden = true;
      var poster = slide.querySelector(".shorts-poster");
      if (poster) poster.hidden = false;
    });
  }

  function armPreview() {
    if (typeof IntersectionObserver === "undefined") return;
    if (!previewObs) {
      previewObs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          var name = entry.target.getAttribute("data-handle") || "";
          previewRatios[name] = entry.isIntersecting ? entry.intersectionRatio : 0;
        });
        var best = null;
        var bestRatio = 0.6;
        var slides = document.querySelectorAll('.shorts-slide[data-live="1"]');
        for (var i = 0; i < slides.length; i++) {
          var name = slides[i].getAttribute("data-handle") || "";
          var ratio = previewRatios[name] || 0;
          if (ratio < 0.6 || ratio < bestRatio) continue;
          bestRatio = ratio;
          best = slides[i];
        }
        if (!best) { stopPreview(); return; }
        startPreview(best);
      }, { threshold: [0.6, 0.8] });
    }
    previewRatios = {};
    previewObs.disconnect();
    if (!previewsOn() || routePane() === "past") { stopPreview(); return; }
    var slides = document.querySelectorAll('.shorts-slide[data-live="1"]');
    for (var i = 0; i < slides.length; i++) previewObs.observe(slides[i]);
  }

  function takePreview(handle) {
    if (!previewHls || foldHandle(previewHandle) !== foldHandle(handle)) return null;
    var video = document.querySelector("video.shorts-preview");
    if (!video || !video.parentNode) return null;
    var at = video.currentTime || 0;
    var player = previewHls;
    previewHls = null;
    previewHandle = "";
    video.classList.remove("shorts-preview");
    video.hidden = false;
    return { video: video, hls: player, at: at };
  }

  function openLive(handle) {
    handle = String(handle || "");
    if (!handle) return;
    var handed = takePreview(handle);
    if (!handed) stopPreview();
    closeLive();
    if (handed) hls = handed.hls;
    var token = liveToken;
    var profile = "https://www.tiktok.com/@" + encodeURIComponent(handle) + "/live";
    var avatar = avatarFor(handle, liveStatus(handle) || {});
    var root = document.createElement("div");
    root.id = "shorts-live-player";
    root.className = "shorts-live-player";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("data-handle", handle);
    root.innerHTML = '<div class="shorts-live-stage">' +
      '<video playsinline webkit-playsinline autoplay muted></video>' +
      '<div class="shorts-live-cover">' +
      (avatar ? '<img alt="" src="' + hooks.esc(avatar) + '" referrerpolicy="no-referrer">' : "") +
      '<p class="shorts-live-note"></p>' +
      '<a hidden target="_blank" rel="noopener noreferrer" href="' + hooks.esc(profile) + '">' + hooks.esc(tr("Open on TikTok")) + "</a>" +
      "</div></div>" +
      '<div class="shorts-live-hud"><button type="button" data-shorts="close-live" aria-label="' + hooks.esc(tr("Close")) + '">×</button>' +
      '<span class="shorts-live-tag">' + hooks.esc(tr("LIVE")) + "</span>" +
      '<span class="shorts-live-q"></span>' +
      '<button type="button" data-shorts="mute" aria-label="' + hooks.esc(sound ? tr("Mute") : tr("Unmute")) + '">' + hooks.icon(sound ? "vol" : "volOff") + "</button></div>" +
      '<div class="shorts-live-foot"><b>@' + hooks.esc(handle) + "</b>" +
      '<span class="shorts-live-viewers"></span></div>';
    document.body.appendChild(root);
    document.documentElement.classList.add("shorts-live-open");
    var stage = root.querySelector(".shorts-live-stage");
    liveZoom = bindVideoZoom(stage);
    bindLiveSwipe(stage);
    root.addEventListener("wheel", onLiveWheel, { passive: false });
    var video = root.querySelector("video");
    if (handed && handed.video) {
      stage.replaceChild(handed.video, video);
      video = handed.video;
      try { video.currentTime = handed.at || video.currentTime; } catch (err) { /* the same frame stays */ }
    }
    revealWhenFrames(video, token);
    root.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("[data-shorts]") : null;
      if (!button) return;
      var kind = button.getAttribute("data-shorts");
      if (kind === "close-live") {
        event.preventDefault();
        closeLive();
      } else if (kind === "mute") {
        event.preventDefault();
        sound = !sound;
        syncMute(button);
      } else if (kind === "retry-live") {
        event.preventDefault();
        var againHandle = root.getAttribute("data-handle") || handle;
        closeLive();
        openLive(againHandle);
      }
    });
    var refreshed = false;
    function finishFail() {
      if (token !== liveToken) return;
      destroyHls();
      destroyMpeg();
      showLiveMessage(handle, tr("Couldn't play this live"), true);
    }
    function giveUp(err) {
      if (token !== liveToken) return;
      if (err) console.error("live playback", err && err.message ? err.message : err);
      if (!refreshed) {
        refreshed = true;
        refreshLive(handle, true).then(function (info) {
          if (token !== liveToken) return;
          if (info && info.live === false) { endLive(handle); return; }
          if (info && info.blocked) {
            showLiveMessage(handle, tr("TikTok blocked this live."), false, true);
            return;
          }
          if (info && (info.hls || info.flv || (info.variants && info.variants.length))) {
            attemptLive(video, info).then(started).catch(finishFail);
            return;
          }
          finishFail();
        }).catch(finishFail);
        return;
      }
      finishFail();
    }
    function started() {
      if (token !== liveToken) return;
      if (sound) {
        video.muted = false;
        var again = video.play();
        if (again && again.catch) again.catch(function () { video.muted = true; });
      }
    }
    function begin(nextHandle) {
      handle = String(nextHandle || handle);
      refreshed = false;
      liveFatal = function (err) { giveUp(err); };
      refreshLive(handle).then(function (info) {
        if (token !== liveToken) return;
        if (!info) { finishFail(); return; }
        var viewers = root.querySelector(".shorts-live-viewers");
        if (viewers) viewers.textContent = info.viewers ? tn("watching", info.viewers, { count: hooks.formatCount(info.viewers, 1000) }) : "";
        var quality = root.querySelector(".shorts-live-q");
        if (quality) quality.textContent = qualityLabel(info.quality);
        var badge = root.querySelector(".shorts-live-tag");
        if (badge) badge.hidden = !info.live;
        if (info.blocked) {
          showLiveMessage(handle, tr("TikTok blocked this live."), false, true);
          openCaptchaModal({
            handle: handle,
            url: "https://www.tiktok.com/@" + encodeURIComponent(handle) + "/live",
            onRetry: function () {
              var base = apiBase();
              if (base && hooks.token()) {
                fetch(base + "/v1/owner/live/" + encodeURIComponent(handle) + "?clear=1", { headers: authHeaders() }).catch(function () {});
              }
              refreshLive(handle).then(function () { begin(handle); });
            }
          });
          return;
        }
        if (!info.live) {
          showLiveMessage(handle, tr("Not live right now"));
          showWatchLink(handle);
          return;
        }
        onLiveLevel = function (atTop, height) {
          if (token !== liveToken || qualityLock) return;
          var slot = root.querySelector(".shorts-live-q");
          if (!slot) return;
          slot.textContent = atTop || !height ? qualityLabel(info.quality) : (height + "p");
        };
        if (handed && handed.hls && video.videoWidth > 0) {
          started();
          preloadNeighbors(handle);
          return;
        }
        if (handed && handed.hls) destroyHls();
        if (!info.hls && !info.flv && !(info.variants && info.variants.length)) { finishFail(); return; }
        attemptLive(video, info).then(started).catch(giveUp);
        preloadNeighbors(handle);
      });
    }
    swapLive = function (delta) {
      if (!root.parentNode) return;
      var rows = swipeQueue.length ? swipeQueue : orderedNow();
      var next = neighborHandle(rows, root.getAttribute("data-handle") || handle, delta);
      if (!next) return;
      liveToken += 1;
      token = liveToken;
      handle = next;
      root.setAttribute("data-handle", handle);
      destroyHls();
      destroyMpeg();
      try { video.pause(); } catch (err) { /* switching */ }
      video.removeAttribute("src");
      try { video.load(); } catch (err) { /* the next stream replaces it */ }
      var cover = root.querySelector(".shorts-live-cover");
      if (cover) cover.hidden = false;
      var note = root.querySelector(".shorts-live-note");
      if (note) note.textContent = "";
      var foot = root.querySelector(".shorts-live-foot b");
      if (foot) foot.textContent = "@" + handle;
      var face = avatarFor(handle, liveStatus(handle) || {});
      var img = cover && cover.querySelector("img");
      if (img && face) img.src = face;
      if (liveZoom && liveZoom.scale() > 1) liveZoom.reset();
      begin(handle);
    };
    begin(handle);
  }

  var swapLive = function () {};

  function preloadNeighbors(handle) {
    var rows = swipeQueue.length ? swipeQueue : orderedNow();
    var index = -1;
    for (var i = 0; i < rows.length; i++) {
      if (foldHandle(rows[i].handle) === foldHandle(handle)) { index = i; break; }
    }
    [-1, 1].forEach(function (delta) {
      var row = rows[index + delta];
      if (!row || !row.live) return;
      var key = foldHandle(row.handle);
      if (!key || manifestWarm[key]) return;
      manifestWarm[key] = true;
      refreshLive(row.handle).then(function (info) {
        var url = info && (info.hls || (info.variants && info.variants[0] && info.variants[0].hls));
        if (!url) { manifestWarm[key] = false; return; }
        var target = sameApi(url) ? url : proxyUrl(url);
        var headers = sameApi(url) ? {} : authHeaders();
        return fetch(target, { headers: headers }).then(function (res) { return res.text(); });
      }).catch(function () { manifestWarm[key] = false; });
    });
  }

  function stepLive(delta) {
    swapLive(delta);
  }

  function bindLiveSwipe(stage) {
    if (!stage) return;
    var start = null;
    var pointers = 0;
    var pinched = false;
    stage.addEventListener("pointerdown", function (event) {
      var control = event.target.closest && event.target.closest("button, a, input, label");
      if (control) return;
      pointers += 1;
      if (pointers >= 2) { pinched = true; start = null; return; }
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    });
    function end(event) {
      pointers = Math.max(0, pointers - 1);
      if (pinched) {
        if (!pointers) pinched = false;
        start = null;
        return;
      }
      if (!start || start.id !== event.pointerId) return;
      var dx = event.clientX - start.x;
      var dy = event.clientY - start.y;
      start = null;
      if (liveZoom && liveZoom.scale() > 1) return;
      if (Math.abs(dy) < 56 || Math.abs(dy) < Math.abs(dx) * 1.2) return;
      stepLive(dy > 0 ? 1 : -1);
    }
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
  }

  function onLiveWheel(event) {
    if (event.ctrlKey || (liveZoom && liveZoom.scale() > 1)) return;
    if (Math.abs(event.deltaY) < 24) return;
    var now = Date.now();
    if (now - wheelLock < 450) { event.preventDefault(); return; }
    wheelLock = now;
    event.preventDefault();
    stepLive(event.deltaY > 0 ? 1 : -1);
  }

  function activeVideo() {
    var feed = document.getElementById("shorts-feed");
    if (!feed) return null;
    var slides = feed.querySelectorAll(".shorts-slide");
    var best = null;
    var top = feed.getBoundingClientRect().top;
    for (var i = 0; i < slides.length; i++) {
      var box = slides[i].getBoundingClientRect();
      if (box.top <= top + 8 && box.bottom > top + 8) best = slides[i];
    }
    return best;
  }

  function backingNote(slideEl, text) {
    if (!slideEl) return;
    var note = slideEl.querySelector(".shorts-note");
    if (!text) {
      if (note) note.textContent = "";
      return;
    }
    if (!note) {
      note = document.createElement("p");
      note.className = "shorts-note";
      var meta = slideEl.querySelector(".shorts-meta");
      if (meta) meta.appendChild(note);
    }
    note.textContent = text;
  }

  function armStored(video, post, preload) {
    var level = preload === "auto" ? "auto" : "meta";
    var armed = video.dataset.tgArm || "";
    if (armed === "auto" || armed === "auto-pending") return;
    if ((armed === "meta" || armed === "meta-pending") && level !== "auto") return;
    var media = videoOf(post);
    var key = socialApi().fileKey ? socialApi().fileKey(post, media) : "";
    var slideEl = video.closest(".shorts-slide");
    if (post.platform === "tiktok") {
      if (!key) {
        backingNote(slideEl, tr("Backing up…"));
        return;
      }
      if (!hooks.token()) {
        backingNote(slideEl, tr("Signed out"));
        if (video.dataset.tgRefresh === "1") return;
        video.dataset.tgRefresh = "1";
        refreshToken().then(function (token) {
          video.dataset.tgRefresh = "";
          if (token) armStored(video, post, preload);
        });
        return;
      }
      video.dataset.tgArm = level + "-pending";
      playTelegramVideo(video, key, preload).then(function () {
        if (level === "auto" || video.dataset.tgArm !== "auto") video.dataset.tgArm = level;
        video.dataset.tgFail = "";
        var badge = slideEl && slideEl.querySelector(".shorts-quality");
        if (badge && level === "auto") badge.hidden = false;
      }).catch(function (err) {
        if (err && (err.name === "AbortError" || /interrupted by a call to pause/i.test(String(err.message || "")))) {
          if (video.dataset.tgArm === level + "-pending") video.dataset.tgArm = "";
          return;
        }
        if (video.dataset.tgArm === level + "-pending") video.dataset.tgArm = "";
        video.dataset.tgFail = err && err.code ? err.code : "play";
        destroyHls();
        if (video.getAttribute("src")) {
          video.removeAttribute("src");
          try { video.load(); } catch (loadErr) { /* the poster stays */ }
        }
        console.error("shorts playback", err && err.message ? err.message : err);
        var poster = slideEl && slideEl.querySelector(".shorts-poster");
        if (poster) poster.style.display = "block";
        backingNote(slideEl, playbackNote(err));
        if (post && post.platform === "tiktok" && err && (err.code === "limited" || err.code === "play")) {
          var postHandle = post.handle || "tiktok";
          openCaptchaModal({
            handle: postHandle,
            url: post.url || ("https://www.tiktok.com/@" + encodeURIComponent(postHandle)),
            onRetry: function () {
              video.dataset.tgArm = "";
              armStored(video, post, "auto");
              var playPromise = video.play();
              if (playPromise && playPromise.catch) playPromise.catch(function () {});
            }
          });
        }
      });
      return;
    }
    var direct = (media && media.url) || "";
    var r2 = direct && /r2\.dev|workers\.dev/.test(direct) ? direct : "";
    if (!key || !hooks.token()) {
      if (!direct) return;
      video.preload = preload;
      if (video.getAttribute("src") !== direct) video.src = direct;
      return;
    }
    video.dataset.tgArm = level + "-pending";
    playTelegramVideo(video, key, preload).then(function () {
      if (level === "auto" || video.dataset.tgArm !== "auto") video.dataset.tgArm = level;
      var badge = slideEl && slideEl.querySelector(".shorts-quality");
      if (badge) badge.hidden = false;
    }).catch(function () {
      if (r2 || direct) {
        destroyHls();
        video.src = r2 || direct;
        return preload === "auto" ? video.play() : Promise.resolve();
      }
      video.dataset.tgArm = "";
    });
  }

  function armSlide(slideEl, preload) {
    var video = slideEl.querySelector("video");
    if (!video || slideEl.getAttribute("data-kind") === "live") return;
    var post = postById(slideEl.getAttribute("data-id") || "");
    if (!post) return;
    if (post.platform === "tiktok" || (socialApi().fileKey && socialApi().fileKey(post, videoOf(post)))) {
      armStored(video, post, preload);
      return;
    }
    var src = (videoOf(post).url) || "";
    if (!src) return;
    video.preload = preload;
    if (video.getAttribute("src") !== src) video.src = src;
  }

  function stopSlide(slideEl) {
    var video = slideEl.querySelector("video");
    if (!video || slideEl.getAttribute("data-kind") === "live") return;
    video.pause();
    video.dataset.tgArm = "";
    video.dataset.tgFail = "";
    video.dataset.tgRefresh = "";
    if (hls && hls.media === video) destroyHls();
    if (video.getAttribute("src")) {
      video.removeAttribute("src");
      try { video.load(); } catch (err) { /* the element is going away */ }
    }
  }

  function playActive() {
    var feed = document.getElementById("shorts-feed");
    if (!feed) return;
    var slides = feed.querySelectorAll(".shorts-slide");
    var current = activeVideo();
    var next = null;
    for (var n = 0; n < slides.length; n++) {
      if (slides[n] === current && slides[n + 1] && slides[n + 1].getAttribute("data-kind") !== "live") next = slides[n + 1];
    }
    for (var i = 0; i < slides.length; i++) {
      if (slides[i] !== current && slides[i]._zoom) slides[i]._zoom.reset();
      var video = slides[i].querySelector("video");
      if (!video || slides[i].getAttribute("data-kind") === "live") continue;
      video.muted = !sound;
      if (slides[i] === current) {
        armSlide(slides[i], "auto");
        var play = video.play();
        if (play && play.catch) play.catch(function () {});
      } else if (slides[i] === next) {
        armSlide(slides[i], "metadata");
        video.pause();
      } else stopSlide(slides[i]);
    }
  }

  function popHeart(stage) {
    var old = stage.querySelector(".shorts-heart");
    if (old) old.remove();
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "shorts-heart");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    var sample = hooks.icon("heartOn");
    var found = String(sample).match(/d="([^"]+)"/);
    path.setAttribute("d", found ? found[1] : "");
    svg.appendChild(path);
    stage.appendChild(svg);
    setTimeout(function () { if (svg.parentNode) svg.remove(); }, 650);
  }

  function onClick(event) {
    var button = event.target.closest("[data-shorts]");
    if (!button) return;
    var kind = button.getAttribute("data-shorts");
    if (kind === "link") return;
    var slideEl = button.closest(".shorts-slide");
    var video = slideEl ? slideEl.querySelector("video") : null;
    if (kind === "watch") {
      event.preventDefault();
      openLive((slideEl && slideEl.getAttribute("data-handle")) || "");
      return;
    }
    if (kind === "saved") {
      event.preventDefault();
      openSaved(button.getAttribute("data-handle") || (slideEl && slideEl.getAttribute("data-handle")) || "");
      return;
    }
    if (kind === "past") {
      event.preventDefault();
      var picked = pastRows()[Number(button.getAttribute("data-past"))];
      if (picked && picked.key) openSaved(picked.handle, picked);
      return;
    }
    if (kind === "mute") {
      sound = !sound;
      if (video) video.muted = !sound;
      var label = sound ? tr("Mute") : tr("Unmute");
      button.setAttribute("aria-label", label);
      button.innerHTML = hooks.icon(sound ? "vol" : "volOff");
      return;
    }
    if (kind === "like" || kind === "bookmark") {
      var id = button.getAttribute("data-id");
      var on = hooks.toggle(kind === "like" ? "like" : "bookmark", id);
      if (kind === "like") button.classList.toggle("on", !!on);
      return;
    }
    if (kind === "share") {
      var post = (hooks.posts() || []).filter(function (row) { return row && row.id === button.getAttribute("data-id"); })[0];
      var url = (post && post.url) || location.href;
      if (navigator.share) navigator.share({ url: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
      return;
    }
    if (kind !== "stage" || !video) return;
    var zoomCtrl = slideEl._zoom;
    var gesture = zoomCtrl ? zoomCtrl.takeGesture() : "";
    clearTimeout(tapTimer);
    if (gesture === "drag" || gesture === "pinch") return;
    if (gesture === "double") {
      lastTap = 0;
      if (zoomCtrl.scale() <= 1) return;
      var postId = slideEl.getAttribute("data-id");
      if (postId) {
        var settings = hooks.settings() || {};
        if (!(settings.likes && settings.likes[postId])) hooks.toggle("like", postId);
        var heart = slideEl.querySelector('[data-shorts="like"]');
        if (heart) heart.classList.add("on");
      }
      var stage = slideEl.querySelector(".shorts-stage");
      if (stage) popHeart(stage);
      return;
    }
    if (zoomCtrl && zoomCtrl.scale() > 1) return;
    var now = Date.now();
    lastTap = now;
    tapTimer = setTimeout(function () {
      lastTap = 0;
      if (video.muted || !sound) {
        sound = true;
        video.muted = false;
        var mute = slideEl.querySelector('[data-shorts="mute"]');
        if (mute) {
          mute.setAttribute("aria-label", tr("Mute"));
          mute.innerHTML = hooks.icon("vol");
        }
        var unmuted = video.play();
        if (unmuted && unmuted.catch) unmuted.catch(function () {});
        button.setAttribute("aria-label", tr("Pause"));
        return;
      }
      if (video.paused) {
        var started = video.play();
        if (started && started.catch) started.catch(function () {});
        button.setAttribute("aria-label", tr("Pause"));
      } else {
        video.pause();
        button.setAttribute("aria-label", tr("Play"));
      }
    }, 320);
  }

  function onKey(event) {
    if (!document.documentElement.classList.contains("shorts-on")) return;
    if (event.key === "Escape" && liveRoot()) {
      event.preventDefault();
      closeLive();
      return;
    }
    if (liveRoot()) {
      var saved = liveRoot().getAttribute("data-mode") === "saved";
      if (!saved && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        stepLive(event.key === "ArrowDown" ? 1 : -1);
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    var feed = document.getElementById("shorts-feed");
    if (!feed) return;
    event.preventDefault();
    var current = activeVideo();
    if (current && current._zoom && current._zoom.scale() > 1) current._zoom.reset();
    feed.scrollBy({ top: (event.key === "ArrowDown" ? 1 : -1) * feed.clientHeight, behavior: "smooth" });
  }

  function onError(event) {
    var video = event.target;
    if (!video || video.tagName !== "VIDEO") return;
    var slideEl = video.closest(".shorts-slide");
    if (!slideEl || slideEl.getAttribute("data-kind") === "live") return;
    var post = postById(slideEl.getAttribute("data-id") || "");
    var err = video.error;
    console.error("shorts playback", err && err.code, err && err.message);
    var poster = slideEl.querySelector(".shorts-poster");
    if (poster) poster.style.display = "block";
    if (post && post.platform === "tiktok") {
      var note = slideEl.querySelector(".shorts-note");
      if (!note || !note.textContent) backingNote(slideEl, playbackNote({ code: video.dataset.tgFail || "play" }));
    }
  }

  function renderAdded() {
    var unlockedEl = document.getElementById("shorts-unlocked");
    if (unlockedEl) unlockedEl.innerHTML = renderUnlocked();
    var list = document.getElementById("shorts-added");
    if (!list) return;
    list.innerHTML = renderAddedHtml();
  }

  function accountsNote(text) {
    var note = document.getElementById("shorts-accounts-note");
    if (note) note.textContent = text || "";
  }

  function loadAccounts() {
    var base = apiBase();
    if (!base || !hooks.token() || !ownerHere()) {
      renderAdded();
      return Promise.resolve();
    }
    return fetch(base + "/v1/owner/tiktok/accounts", { headers: authHeaders(), cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(function (body) {
      addedAccounts = (body && body.added) || [];
      accountsLoaded = true;
      return fetch(base + "/v1/owner/tiktok/unlocked", { headers: authHeaders(), cache: "no-store" }).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (unlocked) {
        if (unlocked && Array.isArray(unlocked.handles)) setUnlocked(unlocked.handles);
      }).catch(function () {});
    }).then(function () {
      renderAdded();
      if (onLiveRoute()) schedulePaint();
    }).catch(function () {
      accountsLoaded = true;
      accountsNote(tr("Try again"));
      renderAdded();
      if (onLiveRoute()) schedulePaint();
    });
  }

  function openAccounts() {
    var sheet = document.getElementById("shorts-accounts");
    if (!sheet) return;
    sheet.hidden = false;
    accountsNote("");
    renderAdded();
    var input = sheet.querySelector("input");
    if (input) input.focus();
    loadAccounts();
  }

  function closeAccounts() {
    var sheet = document.getElementById("shorts-accounts");
    if (sheet) sheet.hidden = true;
  }

  function saveAccount(raw) {
    if (addingAccount) return;
    var base = apiBase();
    if (!base || !hooks.token()) return;
    addingAccount = true;
    accountsNote("");
    fetch(base + "/v1/owner/tiktok/accounts", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, authHeaders()),
      body: JSON.stringify({ handle: raw })
    }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
    }).then(function (result) {
      addingAccount = false;
      if (!result.ok) {
        accountsNote(result.status === 400 ? tr("That doesn’t look like a TikTok account.") : tr("Couldn’t save this account."));
        return;
      }
      var accountRow = result.body && result.body.account;
      if (accountRow && accountRow.handle) {
        addedAccounts = addedAccounts.filter(function (row) { return !row || row.handle !== accountRow.handle; });
        addedAccounts.unshift(accountRow);
      }
      renderAdded();
      var form = document.querySelector(".shorts-add-form");
      if (form) form.reset();
      var lines = [];
      if (result.body && result.body.preview === false) lines.push(tr("Couldn’t preview this profile. It will still be saved."));
      lines.push(tr("New videos show up after the next sync."));
      accountsNote(lines.join(" "));
      if (onLiveRoute()) schedulePaint();
      if (accountRow && accountRow.handle) refreshLive(accountRow.handle);
      pull();
    }).catch(function () {
      addingAccount = false;
      accountsNote(tr("Couldn’t save this account."));
    });
  }

  function removeAccount(handle) {
    var base = apiBase();
    if (!base || !hooks.token() || !handle) return;
    fetch(base + "/v1/owner/tiktok/accounts/" + encodeURIComponent(handle), {
      method: "DELETE",
      headers: authHeaders()
    }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(function (body) {
      addedAccounts = (body && body.added) || [];
      accountsLoaded = true;
      renderAdded();
      if (onLiveRoute()) schedulePaint();
    }).catch(function () {
      accountsNote(tr("Try again"));
    });
  }

  function onPageClick(event) {
    if (event.target && event.target.id === "tiktok-captcha-modal") {
      closeCaptchaModal();
      return;
    }
    var captchaBtn = event.target.closest ? event.target.closest("[data-captcha]") : null;
    if (captchaBtn) {
      event.preventDefault();
      var ckind = captchaBtn.getAttribute("data-captcha");
      if (ckind === "close") closeCaptchaModal();
      else if (ckind === "retry") retryCaptchaAction();
      return;
    }
    if (event.target && event.target.id === "shorts-accounts") {
      closeAccounts();
      return;
    }
    var button = event.target.closest ? event.target.closest("[data-shorts]") : null;
    if (!button) return;
    var kind = button.getAttribute("data-shorts");
    if (kind === "accounts") {
      event.preventDefault();
      openAccounts();
    } else if (kind === "close-accounts") {
      event.preventDefault();
      closeAccounts();
    } else if (kind === "open-captcha") {
      event.preventDefault();
      var cHandle = button.getAttribute("data-handle") || "tiktok";
      openCaptchaModal({
        handle: cHandle,
        url: "https://www.tiktok.com/@" + encodeURIComponent(cHandle) + (onLiveRoute() ? "/live" : ""),
        onRetry: function () {
          if (onLiveRoute()) {
            var base = apiBase();
            if (base && hooks.token()) {
              fetch(base + "/v1/owner/live/" + encodeURIComponent(cHandle) + "?clear=1", { headers: authHeaders() }).catch(function () {});
            }
            refreshLive(cHandle).then(function () { openLive(cHandle); });
          } else {
            playActive();
          }
        }
      });
    } else if (kind === "toggle-lock") {
      event.preventDefault();
      toggleLock();
    } else if (kind === "remove-account") {
      event.preventDefault();
      removeAccount(button.getAttribute("data-handle") || "");
    }
  }

  function onAddSubmit(event) {
    event.preventDefault();
    var input = event.target.querySelector("input");
    saveAccount(input ? input.value : "");
  }

  function applyBoard(body) {
    var items = body && body.items;
    if (!items) return;
    if (!cached) cached = { live: {} };
    if (!cached.live) cached.live = {};
    items.forEach(function (row) {
      if (!row || !row.handle) return;
      rememberLive(row.handle, {
        handle: row.handle,
        live: !!row.live,
        viewers: row.viewers || 0,
        title: row.title || "",
        roomId: row.roomId || "",
        lastLiveAt: row.lastLiveAt || "",
        checkedAt: row.checkedAt || ""
      }, true);
    });
    var root = liveRoot();
    if (root && root.getAttribute("data-mode") !== "saved") {
      var handle = root.getAttribute("data-handle") || "";
      var match = null;
      items.forEach(function (row) {
        if (row && foldHandle(row.handle) === foldHandle(handle)) match = row;
      });
      if (match) applyPlayerStats(handle, match);
    }
    if (routePane() !== "past") schedulePaint();
  }

  function pullBoard() {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return Promise.resolve(null);
    if (!onLiveRoute() || routePane() === "past") return Promise.resolve(null);
    if (!ownerBases().length || !hooks.token() || !ownerHere()) return Promise.resolve(null);
    var headers = authHeaders();
    if (boardEtag) headers["If-None-Match"] = boardEtag;
    return ownerFetch("/v1/owner/tiktok/board", { headers: headers, cache: "no-cache" }).then(function (res) {
      var next = res.headers.get("etag") || res.headers.get("ETag") || "";
      if (next) boardEtag = next;
      if (res.status === 304) { dropBody(res); return null; }
      if (!res.ok) return null;
      return res.json();
    }).then(function (body) {
      if (body) applyBoard(body);
      return body;
    }).catch(function () { return null; });
  }

  function armBoard() {
    clearInterval(boardTimer);
    boardTimer = 0;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    if (!onLiveRoute() || routePane() === "past") return;
    boardTimer = setInterval(pullBoard, 60000);
  }

  function alignLiveHash(route) {
    if (!route || !route.live || route.livePane) return;
    var pane = rememberedPane();
    var hash = location.hash || "";
    var query = "";
    var q = hash.indexOf("?");
    if (q >= 0) query = hash.slice(q);
    var next = "#/shorts/live/" + pane + query;
    if (location.hash === next) return;
    try { history.replaceState(history.state, "", next); }
    catch (err) { /* the remembered tab still renders */ }
  }

  function mount(route) {
    if (route && route.live) {
      var explicit = paneOf(route);
      if (explicit) rememberPane(explicit);
      alignLiveHash(route);
    }
    document.documentElement.classList.add("shorts-on");
    var root = document.querySelector(".shorts-page");
    if (root && !root.dataset.accountsBound) {
      root.dataset.accountsBound = "1";
      root.addEventListener("click", onPageClick);
      var form = root.querySelector(".shorts-add-form");
      if (form) form.addEventListener("submit", onAddSubmit);
    }
    var feed = document.getElementById("shorts-feed");
    if (!feed) return;
    var zoomSlides = feed.querySelectorAll('.shorts-slide[data-kind="video"]');
    for (var z = 0; z < zoomSlides.length; z++) {
      if (zoomSlides[z]._zoom) continue;
      var zoomStage = zoomSlides[z].querySelector(".shorts-stage");
      if (zoomStage) zoomSlides[z]._zoom = bindVideoZoom(zoomStage);
    }
    if (!feed.dataset.zoomBound) {
      feed.dataset.zoomBound = "1";
      feed.addEventListener("touchmove", function (event) {
        if (event.touches.length > 1 || feed.classList.contains("shorts-zoomed")) event.preventDefault();
      }, { passive: false });
      feed.addEventListener("wheel", function (event) {
        if (!feed.classList.contains("shorts-zoomed") || event.ctrlKey) return;
        event.preventDefault();
      }, { passive: false });
    }
    feed.addEventListener("click", onClick);
    feed.addEventListener("error", onError, true);
    feed.addEventListener("playing", function (event) {
      var video = event.target;
      if (!video || video.tagName !== "VIDEO") return;
      var poster = video.parentNode && video.parentNode.querySelector(".shorts-poster");
      if (poster) poster.style.display = "none";
    }, true);
    feed.addEventListener("scroll", function () {
      clearTimeout(feed._play);
      feed._play = setTimeout(playActive, 80);
    }, { passive: true });
    document.removeEventListener("keydown", onKey);
    document.addEventListener("keydown", onKey);
    clearInterval(poll);
    poll = 0;
    var query = (route && route.query) || new URLSearchParams(location.hash.split("?")[1] || "");
    var focus = query.get ? query.get("v") : "";
    if (focus) {
      var target = feed.querySelector('.shorts-slide[data-id="tiktok:' + focus + '"], .shorts-slide[data-id="' + focus + '"]');
      if (target) target.scrollIntoView();
    }
    playActive();
    loadResume();
    Promise.all([pull(), loadAccounts()]).then(function () {
      accountsLoaded = true;
      if (onLiveRoute()) {
        paintLive();
        refreshRecordings();
      } else {
        paintForYou();
      }
      renderAdded();
    });
    if (route && route.live) {
      poll = setInterval(function () {
        if (document.visibilityState !== "visible") return;
        refreshRecordings();
      }, 60 * 1000);
      if (routePane() !== "past") {
        pullBoard();
        armBoard();
      }
      var watchQuery = (route && route.query) || new URLSearchParams((location.hash.split("?")[1]) || "");
      var watch = watchQuery.get ? watchQuery.get("watch") : "";
      if (watch && (route.livePane === "past" || routePane() === "past")) {
        refreshRecordings().then(function () {
          var open = liveRoot();
          if (open && open.getAttribute("data-mode") === "saved" && foldHandle(open.getAttribute("data-handle")) === foldHandle(watch)) return;
          openSaved(watch);
        });
      }
    }
  }

  function unmount() {
    document.documentElement.classList.remove("shorts-on");
    document.removeEventListener("keydown", onKey);
    clearInterval(poll);
    poll = 0;
    clearInterval(boardTimer);
    boardTimer = 0;
    clearTimeout(paintTimer);
    stopPreview();
    closeLive();
    destroyHls();
    var feed = document.getElementById("shorts-feed");
    if (feed) {
      var videos = feed.querySelectorAll("video");
      for (var i = 0; i < videos.length; i++) videos[i].pause();
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      stopPreview();
      pauseStats();
      clearInterval(boardTimer);
      boardTimer = 0;
      return;
    }
    armPreview();
    if (onLiveRoute() && routePane() !== "past") {
      pullBoard();
      armBoard();
    }
    if (!statsHandle || !liveRoot()) return;
    statsTick();
    if (!statsTimer) statsTimer = setInterval(statsTick, 15000);
  });

  function rememberShorts() {
    var local = window.ViktorychLocal;
    if (!local || !local.saveDoc) return;
    var clips = [];
    try {
      var rows = forYou();
      if (local.orderPosts && window.FeedOrder) rows = local.orderPosts(rows, window.FeedOrder.compare, window.FeedOrder.key);
      clips = rows.slice(0, 24).map(function (post) {
        var media = (post.media || [])[0] || {};
        return {
          id: post.id || "",
          platform: post.platform || "",
          text: post.text || post.title || "",
          handle: post.handle || "",
          date: post.date || "",
          sortDate: post.sortDate || "",
          poster: media.poster || "",
          hls: media.hls || ""
        };
      });
    } catch (err) { clips = []; }
    local.saveDoc("shorts", "foryou", { order: "utc", posts: clips });
    var past = pastSource().slice(0, 24).map(function (row) {
      var thumb = typeof row.thumb === "string" && row.thumb.indexOf("https://") === 0 ? row.thumb : "";
      var cover = typeof row.cover === "string" ? row.cover : "";
      return {
        id: String(row.roomId || row.handle || ""),
        platform: "tiktok",
        handle: row.handle || "",
        title: row.title || "",
        roomId: row.roomId || "",
        date: row.endedAt || row.startedAt || "",
        endedAt: row.endedAt || "",
        startedAt: row.startedAt || "",
        duration: row.duration || 0,
        cover: cover,
        keyframe: thumb || cover
      };
    });
    if (local.orderPosts && window.FeedOrder) {
      past = local.orderPosts(past, window.FeedOrder.compare, function (row) {
        return "live:" + (row.roomId || row.handle || row.date || "");
      });
    }
    local.saveDoc("lives", "past", { order: "utc", items: past });
  }

  window.ViktorychShorts = {
    bind: function (next) { if (next) Object.keys(hooks).forEach(function (key) { if (next[key]) hooks[key] = next[key]; }); },
    visible: visible,
    page: page,
    mount: mount,
    unmount: unmount,
    pull: pull,
    hide: hide,
    absorb: absorb,
    isLocked: isLocked,
    isUnlocked: isUnlocked,
    unlockedList: unlockedList,
    unlockedHandles: unlockedList,
    setUnlocked: setUnlocked,
    setAdded: setAdded,
    setLocked: setLocked,
    toggleLock: toggleLock,
    showCaptcha: openCaptchaModal,
    closeCaptcha: closeCaptchaModal,
    orderLiveNow: orderLiveNow,
    neighborHandle: neighborHandle,
    playbackSteps: playbackSteps,
    hlsFatalPlan: hlsFatalPlan,
    lowestPreview: lowestPreview,
    previewsAllowed: previewsAllowed,
    formatBytes: formatBytes,
    setRecordings: function (next) {
      recordingsState = "ready";
      recordings = {
        cap: (next && next.cap) || 12,
        active: (next && next.active) || 0,
        items: (next && next.items) || {},
        past: (next && next.past) || []
      };
      rememberShorts();
    },
    snapshot: rememberShorts,
    setLiveState: function (items) {
      if (!cached) cached = { live: {} };
      cached.live = {};
      (items || []).forEach(function (row) {
        if (!row || !row.handle) return;
        cached.live[row.handle] = row;
      });
      lastLiveOrder = [];
    }
  };
})();
