/* Save data. One switch that moves every setting with a network cost to its
   lowest-data value, and back. KEYS is the single list of those settings:
   a new setting that downloads, uploads or polls belongs here, and
   scripts/data_saver_test.js fails when a known setting is in neither KEYS
   nor FREE. Turning it on keeps a copy of the values it replaced, so turning
   it off puts the user's own choices back. Media is never re-encoded: smaller
   previews come only from sizes the source already serves. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychDataSaver = api;
  if (typeof document !== "undefined") api.start();
})(typeof self !== "undefined" ? self : this, function () {
  var GB = 1024 * 1024 * 1024;
  var STATE_KEY = "viktorychapp-data-saver-v1";
  var SETTINGS_KEY = "viktorychapp-settings-v1";
  var DEVICE_KEY = "viktorychapp-device-performance-v1";
  var STORAGE_KEY = "viktorychapp-storage";
  var P2P_KEY = "viktorychapp-friend-p2p";
  var LT_KEY = "viktorychapp-live-translate-v1";
  var POOL_KEY = "viktorychapp-peer-pool-v1";

  /* [store, key, data-saving value, normal default, what it costs]. */
  var KEYS = [
    ["settings", "saveData", true, false, "the switch itself"],
    ["settings", "autoplay", "never", "all", "video autoplay in the timeline"],
    ["settings", "livePreview", "off", "auto", "live stream previews"],
    ["settings", "reactionsData", "lite", "auto", "reaction counts only, no pictures in the who-reacted list"],
    ["settings", "communityNotesData", "lite", "auto", "Community Notes only for posts on screen, refreshed less often"],
    ["settings", "videoHd", false, true, "HD video variants"],
    ["settings", "imageLoad", "wifi", "always", "photos download on Wi-Fi or on tap"],
    ["settings", "imageSize", "small", "auto", "smaller previews the source already serves"],
    ["settings", "linkPreviews", "text", "full", "link card images"],
    ["settings", "showPictures", "show", "show", "profile pictures"],
    ["settings", "showBanners", "default", "show", "profile banners"],
    ["settings", "homePills", false, true, "weather, scores and live pills polling"],
    ["settings", "stories", false, true, "stories tray and media"],
    ["settings", "storyNotes", false, true, "notes in the stories tray"],
    ["settings", "friendsRail", false, true, "active friends panel and avatars"],
    ["settings", "translateAuto", false, true, "automatic translation requests"],
    ["settings", "notify", false, false, "new post notifications"],
    ["settings", "preload", "defer", "idle", "home tabs and app modules downloaded ahead"],
    ["settings", "syncEvery", "slow", "normal", "new posts and notification checks"],
    ["settings", "backgroundLive", false, true, "live, polling and players in the background"],
    ["settings", "updateDownload", "wifi", "always", "app update downloads"],
    ["settings", "playbackSource", "embed", "embed", "adaptive embed player instead of full files"],
    ["device", "level", "light", "balanced", "on-device fetching, search, translation, sync"],
    ["device", "autoLight", true, true, "drops to light on a weak connection"],
    ["device", "wifiOnly", true, false, "heavy device work on Wi-Fi only"],
    ["device", "pauseBattery", true, true, "heavy work paused on low battery"],
    ["device", "webllm", false, false, "1.1 GB on-device model"],
    ["device", "toggles", { direct: false, search: false, translate: false, ai: false, media: false, record: false, storage: true, sync: false },
      { direct: true, search: true, translate: true, ai: true, media: true, record: true, storage: true, sync: true }, "on-device fetch, search, translation, media and sync"],
    ["device", "aiFeatures.detect", false, true, "language and content detection"],
    ["device", "aiFeatures.spam", false, true, "spam checks"],
    ["device", "aiFeatures.summarize", false, true, "summaries"],
    ["device", "aiFeatures.compose", false, true, "writing help"],
    ["device", "aiFeatures.semantic", false, false, "semantic search"],
    ["device", "aiFeatures.translateLocal", false, false, "113 MB translation model"],
    ["device", "aiFeatures.semanticLocal", false, false, "23 MB search model"],
    ["device", "aiFeatures.dmServer", false, false, "messages sent for server AI"],
    ["device", "aiFeatures.dmAuto", false, false, "automatic message AI"],
    ["device", "peerMedia", "off", "auto", "peer-assisted media sharing"],
    ["device", "peerUploadCap", 32768, 65536, "peer upload speed"],
    ["device", "peerShareWhileWatching", true, true, "peer sharing only while watching"],
    ["storage", "prefetch", false, true, "media and feed prefetch"],
    ["storage", "maxBytes", 1 * GB, 0, "cache size limit"],
    ["storage", "unlimited", false, false, "unlimited cache"],
    ["storage", "picked", false, false, "cache size set by hand on the slider"],
    ["storage", "keep", "3d", "week", "how long media stays cached"],
    ["friendP2P", "on", false, true, "direct connections and media from friends"],
    ["pool", "mode", "off", "auto", "sharing pool: feed files and app updates with nearby devices"],
    ["liveTranslate", "on", false, false, "live translation audio"],
    ["liveTranslate", "mode", "subtitles", "both", "translated voice audio"],
    ["liveTranslate", "sessionMin", 5, 10, "minutes per translation session"],
    ["liveTranslate", "dailyMin", 10, 30, "translation minutes per day"]
  ];

  /* Settings that never touch the network, or only change where the same
     bytes come from. Listed so the test can tell them from forgotten ones. */
  var FREE = {
    settings: ["version", "initialized", "follows", "seenFeeds", "seenDefaults", "lists", "likes", "bookmarks", "reposts", "savedPosts",
      "privacyEmbedShield", "privacyWebRTC", "privacyNoReferrer", "privacyStripTrackers", "privacyZeroTrace", "privacyAntiFingerprint",
      "appearance", "mutedWords", "mutedAccounts", "repostOff", "groups", "groupsOwn", "subsGroup", "followingSort", "forYouReposts",
      "forYouReplies", "tabViews", "translateTo", "translateNever", "bells", "bellNotes", "bellSeen", "bellRead", "notifPrivacy", "historyPause",
      "feedTabs", "lastNoteTab", "networkMode", "navCustom", "bottomNav", "bottomNavCustom", "navLayout", "navLayoutLand", "navLayoutSync",
      "noteTabs", "noteTabsSame", "noteClearedAt", "noteDismissed", "drawerMenu", "devicePerf", "communitiesHome", "notePrefs", "profileTabs",
      "prefsAt", "syncUi", "syncUiAt", "historyCut", "accountFollows", "bellsAt", "builtinNoteRead", "redditVotes", "navCustomAt",
      "brandLogo", "avatarShape", "haptics", "communityTabs", "peopleLinks", "blocks"],
    device: ["profile", "webllmAccepted"],
    storage: [],
    friendP2P: [],
    pool: ["smart"],
    liveTranslate: ["model", "engine", "target", "source", "voice", "duck", "chrome"]
  };

  var hooks = {};
  var heldBound = false;

  function ls() {
    try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (err) { return null; }
  }
  function readJson(key) {
    var store = ls();
    if (!store) return null;
    try {
      var raw = JSON.parse(store.getItem(key) || "null");
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    } catch (err) { return null; }
  }
  function writeJson(key, value) {
    var store = ls();
    if (!store) return;
    try { store.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode keeps the live copy */ }
  }
  function getPath(obj, path) {
    var parts = path.split(".");
    var at = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!at || typeof at !== "object") return undefined;
      at = at[parts[i]];
    }
    return at;
  }
  function setPath(obj, path, value) {
    var parts = path.split(".");
    var at = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!at[parts[i]] || typeof at[parts[i]] !== "object") at[parts[i]] = {};
      at = at[parts[i]];
    }
    if (value === undefined) delete at[parts[parts.length - 1]];
    else at[parts[parts.length - 1]] = value;
  }
  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function connection() {
    if (typeof navigator === "undefined") return {};
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  }

  /* Signals that this person is already saving data: the browser's data
     saver (the same switch that sends the Save-Data request header), a slow
     connection type, or the reduced-data media query. The service worker also
     notes a Save-Data header it saw on a page load. */
  function detect() {
    var reasons = [];
    var conn = connection();
    if (conn.saveData) reasons.push("save-data");
    var type = String(conn.effectiveType || "");
    if (type === "slow-2g" || type === "2g" || type === "3g") reasons.push("slow-" + type.replace("slow-", ""));
    try {
      if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-data: reduce)").matches) reasons.push("reduced-data");
    } catch (err) { /* older browsers */ }
    if (headerHint) reasons.push("save-data-header");
    return { on: reasons.length > 0, reasons: reasons };
  }
  var headerHint = false;
  function readHeaderHint() {
    if (typeof caches === "undefined" || !caches.open) return Promise.resolve(false);
    return caches.open("viktorych-prefs").then(function (cache) {
      return cache.match("./__prefs/save-data.json");
    }).then(function (res) { return res ? res.text() : ""; }).then(function (text) {
      headerHint = text === "1";
      return headerHint;
    }).catch(function () { return false; });
  }

  function onWifi() {
    var conn = connection();
    var type = String(conn.type || "");
    if (type === "wifi" || type === "ethernet") return true;
    if (type === "cellular" || type === "bluetooth" || type === "wimax") return false;
    if (conn.saveData) return false;
    var eff = String(conn.effectiveType || "");
    if (eff === "slow-2g" || eff === "2g" || eff === "3g") return false;
    /* No connection API (iOS Safari) or an unknown type: with Save data on,
       treat it as metered so nothing heavy starts by surprise. */
    return !isOn();
  }

  function settingsObj() {
    if (hooks.settings) {
      var live = hooks.settings();
      if (live) return live;
    }
    return readJson(SETTINGS_KEY);
  }
  function setting(key) {
    var obj = settingsObj();
    var value = obj ? obj[key] : undefined;
    return value === undefined ? normalOf("settings", key) : value;
  }
  function normalOf(store, key) {
    for (var i = 0; i < KEYS.length; i++) if (KEYS[i][0] === store && KEYS[i][1] === key) return KEYS[i][3];
    return undefined;
  }
  function isOn() {
    var obj = settingsObj();
    if (obj && typeof obj.saveData === "boolean") return obj.saveData;
    var saved = readJson(STATE_KEY);
    return !!(saved && saved.on);
  }

  /* What a feature should do right now. */
  function allow(what) {
    if (what === "autoplay") return setting("autoplay") !== "never" && (setting("autoplay") !== "wifi" || onWifi());
    if (what === "images") return setting("imageLoad") !== "wifi" || onWifi();
    if (what === "smallImages") return setting("imageSize") === "small";
    if (what === "hd") return setting("videoHd") !== false;
    if (what === "linkImages") return setting("linkPreviews") !== "text";
    if (what === "prefetch") return setting("preload") !== "defer" || onWifi() || scrolled;
    if (what === "background") return setting("backgroundLive") !== false || typeof document === "undefined" || !document.hidden;
    if (what === "update") return setting("updateDownload") !== "wifi" || onWifi();
    return true;
  }
  /* Poll interval for new posts and notifications. */
  function every(ms) {
    return setting("syncEvery") === "slow" ? ms * 3 : ms;
  }

  /* Heavy first-run work (module preloads, other home tabs) waits for Wi-Fi
     or the first scroll when Save data is on. */
  var scrolled = false;
  var waiting = [];
  function whenRoomy(fn) {
    if (allow("prefetch")) { try { fn(); } catch (err) { /* the caller's own fallback */ } return; }
    waiting.push(fn);
  }
  function flushWaiting() {
    if (!waiting.length || !allow("prefetch")) return;
    var list = waiting.splice(0);
    list.forEach(function (fn) { try { fn(); } catch (err) { /* keep going */ } });
  }

  /* Read and write each store. */
  function readStore(store) {
    if (store === "settings") return settingsObj() || {};
    if (store === "device") {
      var fromSettings = (settingsObj() || {}).devicePerf;
      return Object.assign({}, fromSettings && typeof fromSettings === "object" ? fromSettings : {}, readJson(DEVICE_KEY) || {});
    }
    if (store === "storage") return readJson(STORAGE_KEY) || {};
    if (store === "friendP2P") return readJson(P2P_KEY) || {};
    if (store === "liveTranslate") return readJson(LT_KEY) || {};
    if (store === "pool") return readJson(POOL_KEY) || {};
    return {};
  }

  function snapshot() {
    var out = {};
    KEYS.forEach(function (row) {
      var current = getPath(readStore(row[0]), row[1]);
      out[row[0] + ":" + row[1]] = current === undefined ? null : clone(current);
    });
    return out;
  }

  function valuesFor(on, prev) {
    var plan = {};
    KEYS.forEach(function (row) {
      var id = row[0] + ":" + row[1];
      if (!plan[row[0]]) plan[row[0]] = {};
      var value;
      if (on) value = clone(row[2]);
      else if (prev && Object.prototype.hasOwnProperty.call(prev, id)) value = prev[id] === null ? undefined : prev[id];
      else value = row[3];
      if (row[0] === "settings" && row[1] === "saveData") value = !!on;
      plan[row[0]][row[1]] = value;
    });
    return plan;
  }

  function writeAll(plan) {
    /* Settings first: one object, one save. */
    var settings = settingsObj() || { version: 1 };
    Object.keys(plan.settings).forEach(function (key) { setPath(settings, key, plan.settings[key]); });

    var device = readStore("device");
    var dev = typeof self !== "undefined" ? self.ViktorychDevice : null;
    if (plan.device.level && plan.device.level !== device.level) {
      device = dev && dev.applyLevel ? dev.applyLevel(plan.device.level, device) : Object.assign({}, device, { level: plan.device.level, toggles: undefined });
    }
    Object.keys(plan.device).forEach(function (key) { if (key !== "level") setPath(device, key, plan.device[key]); });
    if (dev && dev.normalize) device = dev.normalize(device);
    if (device.toggles === undefined) delete device.toggles;
    settings.devicePerf = device;
    writeJson(DEVICE_KEY, device);

    var policy = Object.assign({}, readStore("storage"));
    Object.keys(plan.storage).forEach(function (key) { setPath(policy, key, plan.storage[key]); });
    var storageApi = typeof self !== "undefined" ? self.ViktorychStorage : null;
    if (!policy.maxBytes && !policy.unlimited) delete policy.maxBytes;
    if (storageApi && storageApi.savePolicy) storageApi.savePolicy(policy);
    else {
      if (storageApi && storageApi.normalizePolicy) policy = storageApi.normalizePolicy(policy);
      writeJson(STORAGE_KEY, policy);
      postWorker({ type: "storage-policy", policy: policy });
    }

    var p2p = Object.assign({}, readStore("friendP2P"), plan.friendP2P);
    if (p2p.on === undefined) delete p2p.on;
    writeJson(P2P_KEY, p2p);
    var friends = typeof self !== "undefined" ? self.ViktorychFriendP2P : null;
    if (friends && friends.setEnabled && p2p.on === false) friends.setEnabled(false);

    var poolMode = plan.pool && plan.pool.mode;
    var sharing = typeof self !== "undefined" ? self.ViktorychPool : null;
    if (sharing && sharing.setMode) sharing.setMode(poolMode || "auto");
    else if (poolMode === undefined) { var poolPrefs = readStore("pool"); delete poolPrefs.mode; writeJson(POOL_KEY, poolPrefs); }
    else writeJson(POOL_KEY, Object.assign({}, readStore("pool"), { mode: poolMode }));

    var lt = Object.assign({}, readStore("liveTranslate"));
    Object.keys(plan.liveTranslate).forEach(function (key) { if (plan.liveTranslate[key] === undefined) delete lt[key]; else lt[key] = plan.liveTranslate[key]; });
    var liveTr = typeof self !== "undefined" ? self.ViktorychLiveTranslate : null;
    if (liveTr && liveTr.setPrefs) liveTr.setPrefs(lt);
    else writeJson(LT_KEY, lt);

    if (hooks.save) hooks.save(settings);
    else writeJson(SETTINGS_KEY, settings);
  }

  function postWorker(msg) {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    try {
      if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage(msg);
    } catch (err) { /* the worker may be restarting */ }
  }

  /* Turn Save data on or off in one step. On remembers what it replaced. */
  function apply(on) {
    var saved = readJson(STATE_KEY) || {};
    if (on) {
      var prev = saved.on && saved.prev ? saved.prev : snapshot();
      writeJson(STATE_KEY, { on: true, prev: prev, at: Date.now() });
      writeAll(valuesFor(true));
    } else {
      writeJson(STATE_KEY, { on: false, at: Date.now() });
      writeAll(valuesFor(false, saved.prev || null));
    }
    if (on) syncHeld();
    else revealAll();
    return on;
  }

  /* Photos held back until Wi-Fi or a tap. */
  function holdAttrs(html) {
    return String(html || "")
      .replace(/ src="/g, ' data-ds-src="')
      .replace(/ srcset="/g, ' data-ds-srcset="')
      .replace(/ data-tg-first="1"/g, ' data-ds-tgfirst="1"');
  }
  /* Photos tapped open this session stay open through re-renders. */
  var shownUrls = {};
  var shownCount = 0;
  function remember(url) {
    if (!url || shownUrls[url]) return;
    if (shownCount > 2000) { shownUrls = {}; shownCount = 0; }
    shownUrls[url] = true;
    shownCount++;
  }
  function shown(url) {
    return !!(url && shownUrls[url]);
  }
  function reveal(tile) {
    if (!tile || !tile.removeAttribute) return;
    tile.removeAttribute("data-ds-hold");
    tile.removeAttribute("data-ds-poster");
    var imgs = tile.tagName === "IMG" || tile.tagName === "IFRAME" ? [tile] : tile.querySelectorAll("img, iframe");
    Array.prototype.forEach.call(imgs, function (img) {
      var srcset = img.getAttribute("data-ds-srcset");
      if (srcset) { img.setAttribute("srcset", srcset); img.removeAttribute("data-ds-srcset"); }
      var src = img.getAttribute("data-ds-src");
      if (src) { remember(src); img.setAttribute("src", src); img.removeAttribute("data-ds-src"); }
      remember(img.getAttribute("data-tg"));
      if (img.getAttribute("data-ds-tgfirst") === "1") { img.setAttribute("data-tg-first", "1"); img.removeAttribute("data-ds-tgfirst"); }
    });
    if (hooks.reveal) { try { hooks.reveal(tile); } catch (err) { /* the image still has its source */ } }
  }
  function revealAll() {
    if (typeof document === "undefined") return;
    Array.prototype.forEach.call(document.querySelectorAll("[data-ds-hold], [data-ds-poster]"), reveal);
  }
  function syncHeld() {
    if (allow("images")) revealAll();
  }

  function bind(next) {
    Object.keys(next || {}).forEach(function (key) { hooks[key] = next[key]; });
  }

  function onConnection() {
    syncHeld();
    flushWaiting();
  }

  function start() {
    if (typeof document === "undefined" || heldBound) return;
    heldBound = true;
    readHeaderHint();
    /* The first tap on a held photo loads it; the next tap opens it. A video
       poster is not held this way: tapping play plays, and shows the frame. */
    document.addEventListener("click", function (event) {
      var tile = event.target && event.target.closest ? event.target.closest("[data-ds-hold]") : null;
      var poster = !tile && event.target && event.target.closest ? event.target.closest("[data-ds-poster]") : null;
      if (poster) { reveal(poster); return; }
      if (!tile) return;
      event.preventDefault();
      event.stopPropagation();
      reveal(tile);
    }, true);
    var conn = connection();
    if (conn && conn.addEventListener) conn.addEventListener("change", onConnection);
    if (typeof window !== "undefined") {
      window.addEventListener("online", onConnection);
      var onScroll = function () {
        scrolled = true;
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("touchmove", onScroll, true);
        flushWaiting();
      };
      window.addEventListener("scroll", onScroll, { capture: true, passive: true });
      window.addEventListener("touchmove", onScroll, { capture: true, passive: true });
    }
    /* Players keep running in the background only when allowed. */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden || allow("background")) return;
      Array.prototype.forEach.call(document.querySelectorAll("video"), function (video) {
        if (video.paused || document.pictureInPictureElement === video) return;
        try { video.pause(); } catch (err) { /* already stopped */ }
      });
    });
  }

  return {
    KEYS: KEYS,
    FREE: FREE,
    detect: detect,
    readHeaderHint: readHeaderHint,
    onWifi: onWifi,
    isOn: isOn,
    allow: allow,
    every: every,
    whenRoomy: whenRoomy,
    snapshot: snapshot,
    valuesFor: valuesFor,
    apply: apply,
    holdAttrs: holdAttrs,
    shown: shown,
    reveal: reveal,
    bind: bind,
    start: start
  };
});
