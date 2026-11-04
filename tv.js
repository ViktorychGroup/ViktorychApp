/* Thin 10-foot layer over the desktop layout.
   Remote: arrows, Enter/OK, Back (Escape, Backspace, 10009, 461),
   media play/seek, and the colour keys. */
(function () {

  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : ((typeof self !== "undefined" && self.t) ? self.t : null);
    return fn ? fn(key, vars) : key;
  }
  function trn(key, n, vars) {
    var fn = (typeof window !== "undefined" && window.tn) ? window.tn : ((typeof self !== "undefined" && self.tn) ? self.tn : null);
    return fn ? fn(key, n, vars) : String(n);
  }
  function productName(kind) {
    var api = (typeof SI18n !== "undefined") ? SI18n : ((typeof window !== "undefined" && window.SI18n) ? window.SI18n : ((typeof self !== "undefined" && self.SI18n) ? self.SI18n : null));
    return (api && api.productName) ? api.productName(kind) : "";
  }

  var KEY = "viktorychapp-settings-v1";
  var LEGACY = "superintelapp-settings-v1";
  var TV = {
    on: false,
    forced: "",
    settings: null,
    key: "",
    hash: "",
    zoom: 1.5,
    hideSide: false,
    attached: false,
    wantSearch: false,
    mediaTime: 0,
    playing: true,
    restoreTimer: 0
  };

  function loadSettings() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) raw = localStorage.getItem(LEGACY);
      if (!raw) raw = localStorage.getItem("rss-" + "feeds-settings-v1");
      if (raw) {
        try { localStorage.setItem(KEY, raw); } catch (err) {}
      }
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function patchSettings(mutator) {
    var current = loadSettings();
    mutator(current);
    TV.settings = current;
    try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (err) { /* private mode */ }
  }

  function queryFlag() {
    var blob = String(location.search || "") + "&" + String(location.hash || "");
    if (/[?&]tv=0(?:&|#|$)/.test(blob)) return "off";
    if (/[?&]tv=1(?:&|#|$)/.test(blob)) return "on";
    return "";
  }

  function stripQueryKey(qs, key) {
    var parts = String(qs || "").split("&");
    var keep = [];
    var i;
    for (i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i].split("=")[0] === key) continue;
      keep.push(parts[i]);
    }
    return keep.join("&");
  }

  function stripTvParam() {
    var search = String(location.search || "");
    var hash = String(location.hash || "");
    var nextSearch = search;
    var nextHash = hash;
    if (search.indexOf("tv=") >= 0) {
      var bare = stripQueryKey(search.charAt(0) === "?" ? search.slice(1) : search, "tv");
      nextSearch = bare ? "?" + bare : "";
    }
    var qAt = hash.indexOf("?");
    if (qAt >= 0 && hash.indexOf("tv=") >= 0) {
      var rest = stripQueryKey(hash.slice(qAt + 1), "tv");
      nextHash = hash.slice(0, qAt) + (rest ? "?" + rest : "");
    }
    if (nextSearch === search && nextHash === hash) return;
    try { history.replaceState(null, "", location.pathname + nextSearch + nextHash); } catch (err) { /* older webview */ }
  }

  function boot() { return window.ViktorychTVMode || null; }

  function isTvUa() {
    var b = boot();
    if (b) return b.isTvUa();
    var ua = String(navigator.userAgent || "");
    return /Tizen|Web0S|webOS|SMART-TV|SmartTV|Smart-TV|BRAVIA|Bravia|CrKey|Chromecast|AFT[A-Z0-9]|Android ?TV|GoogleTV|HbbTV|Viera|NetCast|TV Bro|Fire TV|FireTV|AppleTV|Apple TV|Roku|VIDAA|Hisense|SmartHub|LivingRoom|Maple/i.test(ua);
  }

  function coarseLarge() {
    var w = window.innerWidth || 0;
    var h = window.innerHeight || 0;
    if (w < 960 || h < 520) return false;
    var touch = (navigator.maxTouchPoints || 0) > 0;
    var fine = false;
    try { fine = window.matchMedia("(pointer: fine)").matches; } catch (err) { fine = false; }
    return !touch && !fine;
  }

  function shouldEnable() {
    var flag = queryFlag();
    if (flag === "on" || flag === "off") TV.forced = flag;
    stripTvParam();
    if (TV.forced === "on") return true;
    if (TV.forced === "off") return false;
    var b = boot();
    var mode = b ? b.mode() : ((TV.settings && TV.settings.tvMode) || "auto");
    if (mode === "on") return true;
    if (mode === "off") return false;
    return isTvUa() || coarseLarge();
  }

  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var APK = "tv/ViktorychTV.apk";
  var TV_PAGE = "tv/";
  var SHORT_URL = "viktorychapp.pages.dev/tv";
  // Inside the app the download leaves the WebView for the system browser,
  // so the update link points at the release asset on github.com.
  var RELEASE_APK = "https://github.com/ViktorychGroup/ViktorychApp/releases/latest/download/ViktorychTV.apk";

  function checkUpdate() {
    var b = boot();
    if (TV.updateChecked || !b || !b.inApp()) return;
    TV.updateChecked = true;
    try {
      fetch("tv/version.json", { cache: "no-store" }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
        var have = b.appVersion();
        if (!v || !v.versionCode || !have || have >= Number(v.versionCode)) return;
        TV.update = { code: Number(v.versionCode), name: String(v.versionName || ""), apk: String(v.release || RELEASE_APK) };
        scheduleRestore();
      }, function () {});
    } catch (err) { /* offline */ }
  }

  function updateCardHtml(where) {
    var u = TV.update;
    if (!u) return "";
    var b = boot();
    var mine = b && b.custom ? b.custom() : null;
    if (mine) {
      // A custom-name install: rebuild with the same name so the label survives.
      return '<div class="tv-app-card tv-update-card" data-tv-update-card="' + esc(where) + '">' +
        '<div class="tv-app-copy"><strong>' + esc(tr("Update available")) + '</strong>' +
        '<span>' + esc(tr("A newer TV app is ready. It is rebuilt with your home-screen name, then press Update. Your sign-in stays.")) + '</span>' +
        '<span class="tv-build-state" data-tv-build-state="1" aria-live="polite">' + esc(TV.buildText || "") + '</span></div>' +
        (TV.buildUrl
          ? '<a class="tv-app-get" href="' + esc(TV.buildUrl) + '" data-tv-get="update">' + esc(tr("Update TV app")) + '</a>'
          : '<button class="tv-app-get" type="button" data-tv-rebuild="1"' + (TV.building ? " disabled" : "") + '>' + esc(tr("Update TV app")) + '</button>') +
        '</div>';
    }
    return '<div class="tv-app-card tv-update-card" data-tv-update-card="' + esc(where) + '">' +
      '<div class="tv-app-copy"><strong>' + esc(tr("Update available")) + '</strong>' +
      '<span>' + esc(tr("A newer TV app is ready. Download it and press Update. Your sign-in stays.")) + '</span></div>' +
      '<a class="tv-app-get" href="' + esc(u.apk) + '" target="_blank" rel="noopener" data-tv-get="update">' + esc(tr("Update TV app")) + '</a>' +
      '</div>';
  }

  function withBuilder(done) {
    if (window.ViktorychTVBuilder) { done(window.ViktorychTVBuilder); return; }
    var el = document.createElement("script");
    el.src = "shared/tv-builder.js";
    el.onload = function () { if (window.ViktorychTVBuilder) done(window.ViktorychTVBuilder); };
    document.head.appendChild(el);
  }

  function buildWords(state) {
    if (state === "building") return tr("Building your app… usually 3 to 5 minutes.");
    if (state === "ready") return tr("Ready. Press Update TV app, then Update.");
    if (state === "signin") return tr("Sign in first, then press Update TV app again.");
    if (state === "limit") return tr("No builds left today. Try again tomorrow.");
    if (state === "not_ready") return tr("The custom-name builder is not switched on yet.");
    return tr("The build did not finish. Try again.");
  }

  function paintBuild() {
    var cards = document.querySelectorAll("[data-tv-update-card]");
    for (var i = 0; i < cards.length; i++) {
      var wrap = document.createElement("div");
      wrap.innerHTML = updateCardHtml(cards[i].getAttribute("data-tv-update-card"));
      if (wrap.firstChild) cards[i].parentNode.replaceChild(wrap.firstChild, cards[i]);
    }
    var get = document.querySelector('[data-tv-update-card] [data-tv-get="update"], [data-tv-update-card] [data-tv-rebuild]');
    if (get && TV.on) setFocus(get, false);
  }

  function rebuild() {
    var b = boot();
    var mine = b && b.custom ? b.custom() : null;
    if (!mine || TV.building) return;
    TV.building = true;
    TV.buildUrl = "";
    withBuilder(function (B) {
      var job = B.pending();
      var onState = function (state, extra) {
        TV.buildText = buildWords(state);
        if (state !== "building") TV.building = false;
        if (state === "ready" && extra && extra.download) {
          TV.buildUrl = extra.download;
          // The app hands the download straight to the Android installer.
          try { location.href = extra.download; } catch (err) { /* the link stays */ }
        }
        paintBuild();
      };
      if (job && job.label === mine.label) B.poll(job, onState);
      else B.start(mine.label, mine.icon, onState);
    });
  }

  var NAME_PRESETS = ["default", "media", "browser", "player", "notes"];

  function presetLabel(id) {
    if (id === "media") return tr("Media");
    if (id === "browser") return tr("Browser");
    if (id === "player") return tr("Player");
    if (id === "notes") return tr("Notes");
    return tr("App name");
  }

  /* Tells the wrapper which home-screen entry to show and the in-app title.
     The no-Chrome app has a JS bridge; in Chrome the intent link opens the
     app's small name screen, which saves it and closes. */
  function sendName(preset, title) {
    var bridge = window.ViktorychTVApp;
    if (bridge && bridge.setName) { try { bridge.setName(preset, title); return; } catch (err) { /* fall back to the link */ } }
    var b = boot();
    var pkg = b ? b.APP_PACKAGE : "app.viktorych.tv";
    location.href = "intent://name?preset=" + encodeURIComponent(preset) + "&title=" + encodeURIComponent(title || "") +
      "#Intent;scheme=viktorychtv;package=" + pkg + ";end";
  }

  function logoText() {
    try {
      var s = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
      var logo = s && s.brandLogo;
      return logo && logo.mode === "text" && logo.text ? String(logo.text) : "";
    } catch (err) { return ""; }
  }

  function appTitle() {
    var b = boot();
    if (!b || !b.inApp()) return "";
    return b.title() || logoText();
  }

  function applyTitle() {
    var want = appTitle();
    if (!want) return;
    if (document.title !== want) document.title = want;
    if (TV.titleWatch || !window.MutationObserver) return;
    var el = document.querySelector("title");
    if (!el) return;
    TV.titleWatch = new MutationObserver(function () {
      var w = appTitle();
      if (w && document.title !== w) document.title = w;
    });
    TV.titleWatch.observe(el, { childList: true, characterData: true, subtree: true });
  }

  function nameHtml() {
    var b = boot();
    if (!b || !b.inApp()) return "";
    var pick = b.preset();
    var mine = b.custom ? b.custom() : null;
    var btn = function (id) {
      var on = pick === id;
      var label = id === "default" && mine ? mine.label : presetLabel(id);
      return '<button class="outline' + (on ? " on" : "") + '" type="button" data-tv-preset="' + id + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(label) + '</button>';
    };
    return "<h2>" + esc(tr("TV app name")) + "</h2>" +
      '<p class="tv-set-note">' + esc(tr("The name and icon on the TV home screen. Android only lets an app switch between these; for any other name, build your own copy.")) + "</p>" +
      '<div class="theme-row tv-prefs">' + NAME_PRESETS.map(btn).join("") + "</div>" +
      '<div class="theme-row"><a class="outline" href="' + TV_PAGE + '#custom">' + esc(tr("Any home-screen name")) + "</a></div>" +
      "<h2>" + esc(tr("Name inside the app")) + "</h2>" +
      '<p class="tv-set-note">' + esc(tr("Shown as the page title and in recent apps. Any text.")) + "</p>" +
      '<div class="theme-row"><input class="tv-title-input" type="text" maxlength="40" data-tv-title="1" value="' + esc(b.title() || logoText()) + '" aria-label="' + esc(tr("Name inside the app")) + '">' +
      '<button class="outline" type="button" data-tv-title-save="1">' + esc(tr("Save")) + "</button></div>";
  }

  function canInstallApp() {
    var b = boot();
    if (!b) return false;
    if (b.inApp() || TV.installed) return false;
    return b.isAndroidTv();
  }

  // TVs that can't take the Android TV app: show how to keep the site one button away.
  function pinCardHtml(where) {
    if (where !== "home") return "";
    var ua = String(navigator.userAgent || "");
    var tip;
    if (/Tizen/i.test(ua)) tip = tr("Samsung: in Internet, open the menu and add a bookmark. Some models can also add it to the Home screen.");
    else if (/Web0S|webOS/i.test(ua)) tip = tr("LG: in Web Browser, open the menu and add a bookmark. Some models can also pin it to Home.");
    else if (/\bAFT|Silk/i.test(ua)) tip = tr("Fire TV: in Silk, open the menu and add a bookmark.");
    else tip = tr("Add this page to your TV browser's bookmarks, or its home screen if it offers that.");
    return '<div class="tv-app-card" data-tv-app-card="' + esc(where) + '">' +
      '<div class="tv-app-copy"><strong>' + esc(tr("Keep it one button away")) + '</strong>' +
      '<span>' + esc(tip) + '</span></div>' +
      '<button class="tv-app-x" type="button" data-tv-hint-close="1" aria-label="' + esc(tr("Not now")) + '">&times;</button>' +
      '</div>';
  }

  function appCardHtml(where) {
    if (TV.update) return updateCardHtml(where);
    if (!canInstallApp()) return TV.installed || standalone() ? "" : pinCardHtml(where);
    return installCardHtml(where);
  }

  function standalone() {
    var b = boot();
    if (b && b.inApp()) return true;
    try { return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches); } catch (err) { return false; }
  }

  function installCardHtml(where) {
    return '<div class="tv-app-card" data-tv-app-card="' + esc(where) + '">' +
      '<div class="tv-app-copy"><strong>' + esc(tr("Get the TV app")) + '</strong>' +
      '<span>' + esc(tr("Put ViktorychApp on your TV home screen. One download, then press Install.")) + '</span></div>' +
      '<a class="tv-app-get" href="' + APK + '" download="ViktorychTV.apk" type="application/vnd.android.package-archive" data-tv-get="1">' + esc(tr("Install TV app")) + '</a>' +
      '<a class="tv-app-how" href="' + TV_PAGE + '">' + esc(tr("How to install")) + '</a>' +
      (where === "home" ? '<button class="tv-app-x" type="button" data-tv-hint-close="1" aria-label="' + esc(tr("Not now")) + '">&times;</button>' : "") +
      '</div>';
  }

  function prefRow(name, label) {
    var b = boot();
    var p = b ? b.prefs() : {};
    var on = !!p[name];
    return '<button class="outline' + (on ? " on" : "") + '" type="button" data-tv-pref="' + name + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(label) + '</button>';
  }

  function settingsHtml() {
    return '<div class="tv-settings">' + settingsInner() + "</div>";
  }

  function settingsInner() {
    var b = boot();
    var mode = b ? b.mode() : "auto";
    var btn = function (id, label) {
      var on = mode === id;
      return '<button class="outline' + (on ? " on" : "") + '" type="button" data-tv-mode="' + id + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(label) + '</button>';
    };
    var html = "<h2>" + esc(tr("TV mode")) + "</h2>" +
      '<p class="tv-set-note">' + esc(TV.on ? tr("On. Big text, remote control, and light defaults for TVs.") : tr("Big text and remote control for TV browsers. Auto turns it on when a TV is detected.")) + "</p>" +
      '<div class="theme-row">' + btn("auto", tr("Auto")) + btn("on", tr("On")) + btn("off", tr("Off")) + "</div>";
    if (TV.on && b) {
      var p = b.prefs();
      var auto = function (id, label) {
        var on = p.autoplay === id;
        return '<button class="outline' + (on ? " on" : "") + '" type="button" data-tv-autoplay="' + id + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(label) + '</button>';
      };
      html += "<h2>" + esc(tr("TV performance")) + "</h2>" +
        '<p class="tv-set-note">' + esc(tr("Light defaults for low-power TVs. Turn any of them off.")) + "</p>" +
        '<div class="theme-row tv-prefs">' +
        prefRow("calm", tr("Reduce motion")) + prefRow("flat", tr("No blur effects")) + prefRow("lightImages", tr("Lighter images")) +
        prefRow("fewerPosts", tr("Fewer posts in memory")) + prefRow("lazyStart", tr("Lighter start-up")) + "</div>" +
        "<h2>" + esc(tr("TV video autoplay")) + "</h2>" +
        '<div class="theme-row">' + auto("off", tr("Off")) + auto("muted", tr("Muted")) + auto("on", tr("On")) + "</div>" +
        '<div class="theme-row"><button class="outline" type="button" data-tv-reset="1">' + esc(tr("Reset TV defaults")) + "</button></div>";
    }
    if (TV.on && window.ViktorychTVTune) html += window.ViktorychTVTune.settingsHtml();
    if (!TV.on) html += '<div class="theme-row"><a class="outline" href="#/send-to-tv">' + esc(tr("Send to my TV")) + "</a></div>";
    html += nameHtml();
    if (b && b.appVersion() >= 5) {
      // TV app 1.4.0+: opens its own defaults screen (optional home screen).
      html += "<h2>" + esc(tr("TV home screen")) + "</h2>" +
        '<p class="tv-set-note">' + esc(tr("Optional. Use this app as your TV's home: big app tiles, folders, search, inputs and settings. The app itself stays exactly as it is.")) + "</p>" +
        '<div class="theme-row"><a class="outline" data-tv-defaults="1" href="intent://defaults#Intent;scheme=viktorychtv;package=' + esc(b.APP_PACKAGE || "app.viktorych.tv") + ';end">' + esc(tr("Home screen and defaults")) + "</a></div>";
    }
    if (b && b.appVersion() >= 6) {
      // TV app 1.5.0+: photos from posts seen on this TV go to its screensaver.
      var dream = dreamLink(b);
      html += "<h2>" + esc(tr("TV screensaver")) + "</h2>" +
        '<p class="tv-set-note">' + esc(tr("Photos and short clips from posts you have seen on this TV, with their text. They stay on the TV.")) + "</p>" +
        (dream ? '<div class="theme-row"><a class="outline" data-tv-dream="1" href="' + esc(dream) + '">' + esc(tr("Use my feed for the screensaver")) + "</a></div>"
          : '<p class="tv-set-note">' + esc(tr("Scroll your feed on this TV first, then come back here.")) + "</p>");
    }
    html += appCardHtml("settings");
    return html;
  }

  // Screensaver photos: kept from posts already on screen (nothing extra is
  // loaded), newest first, only https files, only on this TV.
  var DREAM_KEY = "viktorych-tv-dream";
  var DREAM_MAX = 30;
  function scheduleDream() {
    if (TV.dreamTimer) return;
    TV.dreamTimer = setTimeout(function () { TV.dreamTimer = 0; collectDream(); }, 4000);
  }
  function readDream() {
    try { var v = JSON.parse(localStorage.getItem(DREAM_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function collectDream() {
    var b = boot();
    if (!b || b.appVersion() < 6) return;
    var posts = document.querySelectorAll("article.post[data-post]");
    if (!posts.length) return;
    var list = readDream();
    var seen = {};
    list.forEach(function (it) { seen[it.u] = 1; });
    var fresh = [];
    Array.prototype.forEach.call(posts, function (post) {
      var text = post.querySelector(".post-text");
      var who = post.querySelector(".name");
      var t = text ? String(text.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140) : "";
      var a = who ? String(who.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50) : "";
      var vid = post.querySelector(".media video[src^='https://']");
      if (vid && /\.mp4(\?|$)/i.test(vid.src) && !seen[vid.src]) { seen[vid.src] = 1; fresh.push({ k: "v", u: vid.src, a: a, t: t }); return; }
      var img = post.querySelector(".media img");
      var src = img ? String(img.currentSrc || img.src || "") : "";
      if (!/^https:\/\//.test(src) || seen[src] || (img.naturalWidth && img.naturalWidth < 400)) return;
      seen[src] = 1;
      fresh.push({ k: "i", u: src, a: a, t: t });
    });
    if (!fresh.length) return;
    try { localStorage.setItem(DREAM_KEY, JSON.stringify(fresh.concat(list).slice(0, DREAM_MAX))); } catch (e) { /* storage full */ }
  }
  function dreamLink(b) {
    var list = readDream();
    if (!list.length) return "";
    var clean = function (v) { return String(v || "").replace(/[\t\r\n]+/g, " "); };
    var lines = list.map(function (it) { return [it.k === "v" ? "v" : "i", clean(it.u), clean(it.a), clean(it.t)].join("\t"); }).join("\n");
    return "intent://dream?d=" + encodeURIComponent(lines) + "#Intent;scheme=viktorychtv;package=" + (b.APP_PACKAGE || "app.viktorych.tv") + ";end";
  }

  function checkInstalled() {
    if (TV.checkedInstall) return;
    TV.checkedInstall = true;
    try {
      if (!navigator.getInstalledRelatedApps) return;
      navigator.getInstalledRelatedApps().then(function (apps) {
        var b = boot();
        var pkg = b ? b.APP_PACKAGE : "";
        var hit = (apps || []).some(function (a) { return a && (a.id === pkg || a.platform === "play" || a.platform === "webapp"); });
        if (!hit) return;
        TV.installed = true;
        var cards = document.querySelectorAll("[data-tv-app-card]");
        for (var i = 0; i < cards.length; i++) cards[i].remove();
      }, function () {});
    } catch (err) { /* not supported on this browser */ }
  }

  function hintDismissed() {
    var b = boot();
    var at = b ? Number(b.read().hintAt || 0) : 0;
    return at && Date.now() - at < 30 * 86400000;
  }

  function placeHint() {
    if (!TV.on || !atHome()) return;
    if (!TV.update && hintDismissed()) return;
    if (document.querySelector('[data-tv-app-card="home"], [data-tv-update-card="home"]')) return;
    var html = appCardHtml("home");
    if (!html) return;
    if (landRoot()) return;
    var main = document.querySelector("#app main") || document.querySelector("main");
    var anchor = main && (main.querySelector(".tabs") || main.firstElementChild);
    if (!anchor) return;
    var wrap = document.createElement("div");
    wrap.innerHTML = html;
    var card = wrap.firstChild;
    if (anchor.parentNode) anchor.parentNode.insertBefore(card, anchor.nextSibling);
  }

  function fit() {
    var w = window.innerWidth || 1280;
    var h = window.innerHeight || 720;
    var nav = w <= 1279 ? 88 : 275;
    var side = w <= 999 ? 0 : (w <= 1279 ? 320 : 350);
    var full = nav + 600 + side;
    var slim = nav + 600;
    var safe = w * 0.9;
    var hide = side > 0 && full * 1.5 > safe;
    var base = hide || !side ? slim : full;
    var zoom = safe / base;
    if (zoom > 2) zoom = 2;
    if (zoom < 1.15) zoom = 1.15;
    zoom = Math.round(zoom * 100) / 100;
    var pad = Math.round((h * 0.05) / zoom);
    return { zoom: zoom, hide: hide || !side, pad: pad };
  }

  function applyScale() {
    var box = fit();
    TV.zoom = box.zoom;
    TV.hideSide = box.hide;
    document.documentElement.style.setProperty("--tv-zoom", String(box.zoom));
    document.documentElement.style.setProperty("--tv-pad", box.pad + "px");
    document.documentElement.classList.toggle("tv-noside", box.hide);
  }

  function clearScale() {
    document.documentElement.style.removeProperty("--tv-zoom");
    document.documentElement.style.removeProperty("--tv-pad");
    document.documentElement.classList.remove("tv-noside");
    var added = document.querySelectorAll("[data-tv-tab]");
    var i;
    for (i = 0; i < added.length; i++) {
      added[i].removeAttribute("tabindex");
      added[i].removeAttribute("data-tv-tab");
    }
    var rings = document.querySelectorAll(".tv-focus");
    for (i = 0; i < rings.length; i++) rings[i].classList.remove("tv-focus");
  }

  function visible(el) {
    if (!el || el.disabled) return false;
    if (el.hidden || el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return false;
    if (el.closest && el.closest("[hidden], .vh, .skip")) return false;
    if (el.classList && (el.classList.contains("vh") || el.classList.contains("skip"))) return false;
    var st;
    try { st = window.getComputedStyle(el); } catch (err) { return false; }
    if (!st || st.display === "none" || st.visibility === "hidden") return false;
    var r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }

  function list(nodes) {
    var out = [];
    var i;
    for (i = 0; i < nodes.length; i++) if (visible(nodes[i])) out.push(nodes[i]);
    return out;
  }

  function byX(a, b) {
    return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
  }

  function byY(a, b) {
    return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
  }

  function cardOf(el) {
    return el && el.closest ? el.closest("article.post, article.status, article.ancestor") : null;
  }

  function cardItems(card) {
    var nodes = card.querySelectorAll(".name, .play, .action, .more-btn, .follow, .show-more, .show-thread, .show-replies, .tab");
    var items = [card];
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (!visible(nodes[i])) continue;
      if (nodes[i] === card) continue;
      items.push(nodes[i]);
    }
    var head = items.slice(0, 1);
    var rest = items.slice(1);
    rest.sort(byX);
    return head.concat(rest);
  }

  function groupLoose(els) {
    var rows = [];
    var i;
    var sorted = els.slice().sort(byY);
    for (i = 0; i < sorted.length; i++) {
      var el = sorted[i];
      var top = el.getBoundingClientRect().top;
      var row = rows.length ? rows[rows.length - 1] : null;
      if (!row || Math.abs(top - row.top) > 36) rows.push({ top: top, items: [el] });
      else row.items.push(el);
    }
    for (i = 0; i < rows.length; i++) rows[i].items.sort(byX);
    return rows;
  }

  function mainStops() {
    var main = document.querySelector("main");
    if (!main) return [];
    var all = main.querySelectorAll("article.post, article.status, article.ancestor, a, button, input, textarea, select");
    var stops = [];
    var loose = [];
    var i;
    function flush() {
      var rows = groupLoose(loose);
      var r;
      for (r = 0; r < rows.length; r++) stops.push({ kind: "row", items: rows[r].items });
      loose = [];
    }
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (!visible(el)) continue;
      var card = cardOf(el);
      if (card && el !== card) continue;
      if (el.matches && el.matches("article.post, article.status, article.ancestor")) {
        flush();
        stops.push({ kind: "card", items: cardItems(el) });
      } else if (!card) loose.push(el);
    }
    flush();
    return stops;
  }

  function columnItems(selector) {
    var root = document.querySelector(selector);
    if (!root || !visible(root) && selector === ".side") return [];
    if (!root) return [];
    var nodes = root.querySelectorAll("a, button, input, textarea, select");
    return list(nodes).sort(byY);
  }

  function navItems() {
    return columnItems(".nav");
  }

  function sideItems() {
    if (TV.hideSide) return [];
    return columnItems(".side");
  }

  // The signed-out TV landing sits outside #app; arrows move inside it.
  function landRoot() {
    return document.querySelector("#account-layer .tv-land");
  }

  function overlayRoot() {
    var tune = document.querySelector("#tv-tune-layer .tvt-card");
    if (tune) return tune;
    var acct = document.querySelector("#account-layer .acct-modal");
    if (acct) return acct;
    var viewer = document.getElementById("viewer");
    if (viewer && !viewer.hidden) return viewer;
    var sheet = document.querySelector(".modal-back, .drawer-back, .share-back, .tab-sheet, .bell-sheet");
    if (sheet) return sheet.querySelector(".modal, .drawer, .share-pop, .tab-menu") || sheet;
    var menu = document.querySelector(".post .menu, article .menu");
    if (menu && visible(menu)) return menu;
    return null;
  }

  function current() {
    var el = document.activeElement;
    if (el && el !== document.body && el !== document.documentElement) return el;
    return document.querySelector(".tv-focus");
  }

  function remember(el) {
    if (!el) return;
    var label = (el.getAttribute && (el.getAttribute("aria-label") || "")) || "";
    var act = (el.getAttribute && el.getAttribute("data-act")) || "";
    var tab = (el.getAttribute && el.getAttribute("data-tab")) || "";
    var text = "";
    try { text = String(el.innerText || "").replace(/\s+/g, " ").slice(0, 40); } catch (err) { text = ""; }
    if (el.classList && el.classList.contains("nav-item")) {
      TV.key = "nav:" + (el.getAttribute("href") || "");
      return;
    }
    var card = cardOf(el);
    var id = card ? (card.getAttribute("data-post") || (card.classList.contains("status") ? "status" : "")) : "";
    var dataId = (el.getAttribute && el.getAttribute("data-id")) || "";
    if (card && el === card) TV.key = "card:" + id;
    else if (card) TV.key = "in:" + (dataId || id) + ":" + act + ":" + label;
    else if (el.id) TV.key = "id:" + el.id;
    else TV.key = "act:" + act + ":" + label + ":" + tab + ":" + ((el.getAttribute && (el.getAttribute("data-theme") || el.getAttribute("data-mode"))) || text);
  }

  function sameKey(el, key) {
    var prev = TV.key;
    remember(el);
    var now = TV.key;
    TV.key = prev;
    return now === key;
  }

  function findKey(key) {
    if (!key) return null;
    var nodes = document.querySelectorAll("#app a, #app button, #app input, #app textarea, #app select, #app article, #viewer button, #viewer video");
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (!visible(nodes[i]) && nodes[i].tagName !== "ARTICLE") continue;
      if (sameKey(nodes[i], key)) return nodes[i];
    }
    return null;
  }

  function paint(el) {
    var prev = document.querySelectorAll(".tv-focus");
    var i;
    for (i = 0; i < prev.length; i++) if (prev[i] !== el) prev[i].classList.remove("tv-focus");
    if (el && el.classList) el.classList.add("tv-focus");
  }

  function ensureFocusable(el) {
    var tag = el.tagName;
    if (tag === "A" || tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (el.getAttribute("tabindex") == null) {
      el.setAttribute("tabindex", "-1");
      el.setAttribute("data-tv-tab", "1");
    }
  }

  function centerEl(el) {
    var card = cardOf(el);
    var target = card || el;
    if (!target || !target.getBoundingClientRect) return;
    var rect = target.getBoundingClientRect();
    if (rect.height > window.innerHeight * 0.82) rect = el.getBoundingClientRect();
    var delta = rect.top + rect.height / 2 - window.innerHeight / 2;
    if (Math.abs(delta) < 12) return;
    var zoom = TV.zoom || 1;
    var top = delta / zoom;
    try { window.scrollBy({ top: top, left: 0, behavior: "smooth" }); }
    catch (err) { window.scrollBy(0, top); }
  }

  // Keep the focused item on screen: scroll only when it is outside the
  // middle 80% of the viewport.
  function keepInView(el) {
    if (!el || !el.getBoundingClientRect) return;
    var rect = el.getBoundingClientRect();
    var h = window.innerHeight || 720;
    var top = h * 0.1;
    var bottom = h * 0.9;
    if (rect.top >= top && rect.bottom <= bottom) return;
    var delta = rect.top < top ? rect.top - top : Math.min(rect.bottom - bottom, rect.top - top);
    var zoom = TV.zoom || 1;
    var scroller = el.closest ? el.closest(".modal, .drawer, .tab-menu, .share-pop") : null;
    if (scroller && scroller.scrollHeight > scroller.clientHeight) {
      scroller.scrollTop += delta / zoom;
      return;
    }
    try { window.scrollBy({ top: delta / zoom, left: 0, behavior: calm() ? "auto" : "smooth" }); }
    catch (err) { window.scrollBy(0, delta / zoom); }
  }

  function calm() {
    var b = boot();
    return !!(b && b.on && b.prefs().calm);
  }

  function setFocus(el, center) {
    if (!el) return;
    ensureFocusable(el);
    remember(el);
    try { el.focus({ preventScroll: true }); }
    catch (err) {
      try { el.focus(); } catch (err2) { /* not focusable */ }
    }
    paint(el);
    if (center) centerEl(el);
    else keepInView(el);
  }

  // Geometric fallback: the nearest visible control in the pressed direction.
  // Used when the column model has nowhere to go, so focus never gets stuck.
  var FOCUSABLE = "a[href], button, input, textarea, select, [tabindex]:not([tabindex='-1']), article.post, article.status";
  function spatial(dir, from, scope) {
    var root = scope || document.getElementById("app") || document.body;
    if (!from || !from.getBoundingClientRect) return null;
    var a = from.getBoundingClientRect();
    var ax = a.left + a.width / 2;
    var ay = a.top + a.height / 2;
    var nodes = root.querySelectorAll(FOCUSABLE);
    var best = null;
    var bestScore = Infinity;
    var i;
    for (i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el === from || (from.contains && from.contains(el)) || (el.contains && el.contains(from))) continue;
      if (!visible(el)) continue;
      var r = el.getBoundingClientRect();
      var bx = r.left + r.width / 2;
      var by = r.top + r.height / 2;
      var main;
      var cross;
      if (dir === "ArrowDown") { main = r.top - a.bottom + a.height / 2; cross = Math.abs(bx - ax); if (by <= ay + 2) continue; }
      else if (dir === "ArrowUp") { main = a.top - r.bottom + a.height / 2; cross = Math.abs(bx - ax); if (by >= ay - 2) continue; }
      else if (dir === "ArrowRight") { main = r.left - a.right + a.width / 2; cross = Math.abs(by - ay); if (bx <= ax + 2) continue; }
      else { main = a.left - r.right + a.width / 2; cross = Math.abs(by - ay); if (bx >= ax - 2) continue; }
      var score = Math.max(0, main) + cross * 2;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function entryFocus() {
    var search = document.getElementById("explore-q") || document.getElementById("add-account");
    if (search && visible(search)) return search;
    var tab = document.querySelector(".tabs .tab.on") || document.querySelector(".tabs .tab");
    if (tab && visible(tab)) return tab;
    var card = document.querySelector("main article.status, main article.post");
    if (card && visible(card)) return card;
    var stops = mainStops();
    if (stops.length && stops[0].items.length) return stops[0].items[0];
    var nav = navItems();
    return nav.length ? nav[0] : null;
  }

  function locate(el) {
    var nav = navItems();
    var side = sideItems();
    var stops = mainStops();
    var s;
    var i;
    for (i = 0; i < nav.length; i++) if (nav[i] === el) return { where: "nav", items: nav, index: i };
    for (i = 0; i < side.length; i++) if (side[i] === el) return { where: "side", items: side, index: i };
    for (s = 0; s < stops.length; s++) {
      for (i = 0; i < stops[s].items.length; i++) {
        if (stops[s].items[i] === el) return { where: "main", stops: stops, stop: s, index: i };
      }
    }
    var card = cardOf(el);
    if (card) {
      for (s = 0; s < stops.length; s++) {
        if (stops[s].kind === "card" && stops[s].items[0] === card) {
          for (i = 0; i < stops[s].items.length; i++) if (stops[s].items[i] === el || stops[s].items[i] === card) {
            return { where: "main", stops: stops, stop: s, index: el === card ? 0 : i };
          }
        }
      }
    }
    return { where: "main", stops: stops, stop: 0, index: 0 };
  }

  function moveMain(dir, place) {
    var stops = place.stops || mainStops();
    if (!stops.length) {
      if (dir === "ArrowLeft") focusNav();
      return;
    }
    var stopAt = place.stop || 0;
    var index = place.index || 0;
    if (stopAt < 0) stopAt = 0;
    if (stopAt >= stops.length) stopAt = stops.length - 1;
    var items = stops[stopAt].items;
    if (dir === "ArrowLeft") {
      if (index > 0) setFocus(items[index - 1], false);
      else focusNav();
      return;
    }
    if (dir === "ArrowRight") {
      if (index < items.length - 1) setFocus(items[index + 1], false);
      else {
        var side = sideItems();
        if (side.length) setFocus(side[0], false);
      }
      return;
    }
    var next = stopAt + (dir === "ArrowDown" ? 1 : -1);
    if (next < 0) return;
    if (next >= stops.length) return;
    var target = stops[next].items[Math.min(index, stops[next].items.length - 1)];
    setFocus(target, stops[next].kind === "card" || stops[stopAt].kind === "card");
  }

  function focusNav() {
    var on = document.querySelector(".nav .nav-item.on") || document.querySelector(".nav .nav-item");
    if (on) setFocus(on, false);
  }

  function move(dir) {
    var before = current();
    moveModel(dir);
    var after = current();
    if (after !== before || !before) return;
    var over = overlayRoot() || landRoot();
    var next = spatial(dir, before, over || null);
    if (next) setFocus(next, false);
    else if (dir === "ArrowDown" || dir === "ArrowUp") {
      // At the end of a list: scroll so more posts can load or show.
      try { window.scrollBy(0, (dir === "ArrowDown" ? 1 : -1) * (window.innerHeight || 720) * 0.4 / (TV.zoom || 1)); } catch (err) { /* older webview */ }
    }
  }

  function moveModel(dir) {
    var over = overlayRoot();
    var land = over ? null : landRoot();
    if (land) {
      var from = current();
      if (!from || !land.contains(from)) {
        var start = land.querySelector("[data-tv-first]") || land.querySelector("button, a[href]");
        if (start) setFocus(start, false);
        return;
      }
      var to = spatial(dir, from, land);
      if (to) setFocus(to, false);
      return;
    }
    if (over) {
      var inside = list(over.querySelectorAll("a, button, input, textarea, select"));
      if (!inside.length) return;
      var el = current();
      var at = inside.indexOf ? inside.indexOf(el) : -1;
      var n;
      if (at < 0) {
        for (n = 0; n < inside.length; n++) if (inside[n] === el) at = n;
      }
      if (dir === "ArrowDown" || dir === "ArrowRight") setFocus(inside[Math.min(inside.length - 1, (at < 0 ? 0 : at + 1))], false);
      else setFocus(inside[Math.max(0, (at < 0 ? 0 : at - 1))], false);
      return;
    }
    var el = current();
    var place = locate(el);
    if (place.where === "nav") {
      var nav = place.items;
      if (dir === "ArrowUp" && place.index > 0) setFocus(nav[place.index - 1], false);
      else if (dir === "ArrowDown" && place.index < nav.length - 1) setFocus(nav[place.index + 1], false);
      else if (dir === "ArrowRight") {
        var entry = entryFocus();
        if (entry) setFocus(entry, !!(cardOf(entry) && entry.tagName === "ARTICLE"));
      }
      return;
    }
    if (place.where === "side") {
      var side = place.items;
      if (dir === "ArrowUp" && place.index > 0) setFocus(side[place.index - 1], false);
      else if (dir === "ArrowDown" && place.index < side.length - 1) setFocus(side[place.index + 1], false);
      else if (dir === "ArrowLeft") {
        var back = findKey(TV.key) || entryFocus();
        if (back && back.closest && back.closest(".side")) back = entryFocus();
        if (back) setFocus(back, false);
        else focusNav();
      }
      return;
    }
    moveMain(dir, place);
  }

  function clickEl(el) {
    if (!el) return;
    try { el.click(); } catch (err) { /* synthetic click can fail on text nodes */ }
  }

  function focusedCard() {
    var el = current();
    return cardOf(el) || document.querySelector("main article.post, main article.status");
  }

  function clickAction(selector) {
    var card = focusedCard();
    var btn = card ? card.querySelector(selector) : null;
    if (!btn) btn = document.querySelector(selector);
    if (btn) clickEl(btn);
  }

  function mediaNode() {
    var viewer = document.querySelector("#viewer:not([hidden]) video, #viewer:not([hidden]) iframe");
    if (viewer) return viewer;
    var el = current();
    var host = el && el.closest ? el.closest(".vplay, .player, article") : null;
    if (host) {
      var local = host.querySelector("video, iframe");
      if (local) return local;
    }
    return document.querySelector(".player video, .player iframe, .vplay video, .vplay iframe");
  }

  function ytFrame(node) {
    return node && node.tagName === "IFRAME" && String(node.src || "").indexOf("youtube-nocookie.com/embed/") >= 0;
  }

  function ytCmd(frame, func, args) {
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(JSON.stringify({
        event: "command",
        func: func,
        args: args || [],
        id: 1,
        channel: "widget"
      }), "*");
    } catch (err) { /* the embed can ignore the command */ }
  }

  function toggleMedia() {
    var node = mediaNode();
    if (!node) return;
    if (node.tagName === "VIDEO") {
      if (node.paused) {
        var play = node.play();
        if (play && play.catch) play.catch(function () {});
      } else node.pause();
      return;
    }
    if (ytFrame(node)) {
      TV.playing = !TV.playing;
      ytCmd(node, TV.playing ? "playVideo" : "pauseVideo", []);
    }
  }

  function seekMedia(delta) {
    var node = mediaNode();
    if (!node) return;
    if (node.tagName === "VIDEO") {
      var next = (node.currentTime || 0) + delta;
      if (next < 0) next = 0;
      if (node.duration && isFinite(node.duration) && next > node.duration) next = node.duration;
      try { node.currentTime = next; } catch (err) { /* not seekable yet */ }
      TV.mediaTime = next;
      return;
    }
    if (ytFrame(node)) {
      TV.mediaTime = Math.max(0, (TV.mediaTime || 0) + delta);
      ytCmd(node, "seekTo", [TV.mediaTime, true]);
    }
  }

  function toggleMute() {
    var node = mediaNode();
    if (node && node.tagName === "VIDEO") {
      node.muted = !node.muted;
      return;
    }
    var btn = document.querySelector(".vmute");
    if (btn) clickEl(btn);
    else if (ytFrame(node)) ytCmd(node, "mute", []);
  }

  function atHome() {
    var hash = (location.hash || "#/").split("?")[0];
    return hash === "#/" || hash === "#/home" || hash === "";
  }

  function closeOverlay() {
    var closer = document.querySelector(".tab-sheet [data-act='close-tab-menu'], .modal [data-act='close-modal'], .drawer [data-act='close-drawer'], .share-back [data-act='close-share'], #viewer [data-act='close-viewer']");
    if (closer && overlayRoot()) {
      clickEl(closer);
      return;
    }
    TV.ignore = true;
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } catch (err) { /* older webview */ }
    TV.ignore = false;
  }

  function goBack() {
    if (overlayRoot()) {
      closeOverlay();
      return;
    }
    if (atHome()) return;
    if (history.length > 1) history.back();
    else location.hash = "#/";
  }

  function typing(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA";
  }

  function caretAt(el, dir) {
    if (!el || el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
    var start = el.selectionStart;
    var end = el.selectionEnd;
    if (start == null) return false;
    if (dir === "ArrowLeft") return start === 0 && end === 0;
    if (dir === "ArrowRight") return start === el.value.length && end === el.value.length;
    return false;
  }

  function isBack(event) {
    var key = event.key || "";
    var code = event.keyCode || event.which || 0;
    if (key === "Escape" || key === "BrowserBack" || key === "XF86Back" || key === "GoBack" || key === "Back") return true;
    if (code === 10009 || code === 461 || code === 4 || code === 166) return true;
    if (key === "Backspace" && !typing(current())) return true;
    return false;
  }

  function isPlay(event) {
    var key = event.key || "";
    var code = event.keyCode || event.which || 0;
    return key === "MediaPlayPause" || key === "MediaPlay" || key === "MediaPause" || key === "MediaStop" || code === 179 || code === 415 || code === 19 || code === 413 || code === 85 || code === 126 || code === 127;
  }

  function onKeyDown(event) {
    if (!TV.on || TV.ignore) return;
    if (event.target && event.target.closest && event.target.closest(".nav-split")) return;
    var key = event.key || "";
    var code = event.keyCode || event.which || 0;
    if (isBack(event)) {
      if (atHome() && !overlayRoot()) return;
      event.preventDefault();
      event.stopPropagation();
      goBack();
      return;
    }
    if (isPlay(event)) {
      event.preventDefault();
      event.stopPropagation();
      toggleMedia();
      return;
    }
    if (key === "MediaFastForward" || key === "MediaTrackNext" || code === 417 || code === 90 || code === 228) {
      event.preventDefault();
      event.stopPropagation();
      seekMedia(10);
      return;
    }
    if (key === "MediaRewind" || key === "MediaTrackPrevious" || code === 412 || code === 89 || code === 227) {
      event.preventDefault();
      event.stopPropagation();
      seekMedia(-10);
      return;
    }
    if (code === 403 || key === "ColorF0Red") {
      event.preventDefault();
      event.stopPropagation();
      clickAction(".action.like");
      return;
    }
    if (code === 404 || key === "ColorF1Green") {
      event.preventDefault();
      event.stopPropagation();
      clickAction(".action.bookmark");
      return;
    }
    if (code === 405 || key === "ColorF2Yellow") {
      event.preventDefault();
      event.stopPropagation();
      TV.wantSearch = true;
      location.hash = "#/explore";
      return;
    }
    if (code === 406 || key === "ColorF3Blue") {
      event.preventDefault();
      event.stopPropagation();
      toggleMute();
      return;
    }
    if (typing(current())) {
      if ((key === "ArrowLeft" || key === "ArrowRight") && !caretAt(current(), key)) return;
      if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        move(key);
      }
      return;
    }
    if (key === " " ) {
      event.preventDefault();
      event.stopPropagation();
      toggleMedia();
      return;
    }
    if (key === "Enter" || key === "NumpadEnter" || key === "Accept" || code === 13) {
      if (event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clickEl(current());
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      move(key);
    }
  }

  function rerenderSettings(anchor) {
    var host = anchor && anchor.closest ? anchor.closest(".tv-settings") : null;
    if (!host) host = document.querySelector(".tv-settings");
    if (!host) return;
    var key = TV.key;
    host.innerHTML = settingsInner();
    var again = findKey(key);
    if (again) setFocus(again, false);
  }

  function onClick(event) {
    var t = event.target && event.target.closest ? event.target : null;
    if (!t) return;
    var b = boot();
    var hit = t.closest("[data-tv-toggle], [data-tv-mode], [data-tv-pref], [data-tv-autoplay], [data-tv-reset], [data-tv-hint-close], [data-tv-rebuild], [data-tv-preset], [data-tv-title-save]");
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    if (hit.hasAttribute("data-tv-toggle")) setTvMode(TV.on ? "off" : "on");
    else if (hit.hasAttribute("data-tv-mode")) setTvMode(hit.getAttribute("data-tv-mode"));
    else if (b && hit.hasAttribute("data-tv-pref")) {
      var name = hit.getAttribute("data-tv-pref");
      b.setPref(name, !b.prefs()[name]);
    } else if (b && hit.hasAttribute("data-tv-autoplay")) b.setPref("autoplay", hit.getAttribute("data-tv-autoplay"));
    else if (b && hit.hasAttribute("data-tv-reset")) b.resetPrefs();
    else if (hit.hasAttribute("data-tv-rebuild")) { rebuild(); return; }
    else if (b && hit.hasAttribute("data-tv-preset")) {
      b.setPreset(hit.getAttribute("data-tv-preset"));
      sendName(b.preset(), b.title());
    } else if (b && hit.hasAttribute("data-tv-title-save")) {
      var host = hit.closest(".tv-settings") || document;
      var box = host.querySelector("[data-tv-title]");
      b.setTitle(box ? box.value : "");
      applyTitle();
      sendName(b.preset(), b.title());
    } else if (hit.hasAttribute("data-tv-hint-close")) {
      if (b) { var st = b.read(); st.hintAt = Date.now(); b.write(st); }
      var card = hit.closest("[data-tv-app-card]");
      if (card) card.remove();
      var entry = entryFocus();
      if (entry) setFocus(entry, false);
      return;
    }
    rerenderSettings(hit);
  }

  function setTvMode(mode) {
    var m = mode === "on" || mode === "off" ? mode : "auto";
    var b = boot();
    if (b) b.setMode(m);
    TV.forced = m === "auto" ? "" : m;
    patchSettings(function (s) { if (m === "auto") delete s.tvMode; else s.tvMode = m; });
    applyMode();
  }

  function scheduleRestore() {
    clearTimeout(TV.restoreTimer);
    TV.restoreTimer = setTimeout(restore, 60);
  }

  function restore() {
    if (!TV.on) return;
    placeHint();
    var hash = location.hash || "#/";
    if (hash !== TV.hash) {
      TV.hash = hash;
      if (!TV.wantSearch) TV.key = "";
    }
    var over = overlayRoot();
    if (over) {
      var inside = current();
      if (!inside || !over.contains(inside)) {
        var first = list(over.querySelectorAll("a, button, input, textarea, select"))[0];
        if (first) setFocus(first, false);
      }
      document.documentElement.setAttribute("data-tv-ready", "1");
      return;
    }
    var land = landRoot();
    if (land) {
      var at = current();
      if (!at || !land.contains(at)) {
        var first = land.querySelector("[data-tv-first]") || land.querySelector("button, a[href]");
        if (first) setFocus(first, false);
      }
      document.documentElement.setAttribute("data-tv-ready", "1");
      return;
    }
    if (TV.wantSearch) {
      TV.wantSearch = false;
      var box = document.getElementById("explore-q");
      if (box) {
        setFocus(box, false);
        document.documentElement.setAttribute("data-tv-ready", "1");
        return;
      }
    }
    var again = findKey(TV.key);
    if (again) {
      setFocus(again, false);
      document.documentElement.setAttribute("data-tv-ready", "1");
      return;
    }
    var entry = entryFocus();
    if (entry) setFocus(entry, false);
    if (document.querySelector("main article.post, main .tab, main .empty, main h1")) {
      document.documentElement.setAttribute("data-tv-ready", "1");
    }
  }

  function enter() {
    if (TV.on) {
      applyScale();
      return;
    }
    TV.on = true;
    document.documentElement.classList.add("tv-on");
    checkInstalled();
    checkUpdate();
    loadTune();
    applyTitle();
    applyScale();
    TV.hash = location.hash || "#/";
    scheduleRestore();
  }

  /* TV tuning (tv-tune.js): the first-open spec check and its settings.
     Loaded only in TV mode. */
  function loadTune() {
    if (window.ViktorychTVTune || TV.tuneLoading) return;
    TV.tuneLoading = true;
    var s = document.createElement("script");
    s.src = "tv-tune.js";
    s.async = true;
    s.onload = function () { if (document.querySelector(".tv-settings")) rerenderSettings(null); };
    document.head.appendChild(s);
  }

  function exit() {
    if (!TV.on && !document.documentElement.classList.contains("tv-on")) return;
    TV.on = false;
    document.documentElement.classList.remove("tv-on");
    document.documentElement.removeAttribute("data-tv-ready");
    clearScale();
  }

  function applyMode() {
    TV.settings = loadSettings();
    var on = shouldEnable();
    var b = boot();
    if (b) { b.on = on; b.paint(); }
    if (on) enter();
    else exit();
  }

  function onFocusIn(event) {
    if (!TV.on || !event.target || !event.target.classList) return;
    if (event.target.closest && !event.target.closest("#app, #viewer, #account-layer, #tv-tune-layer")) return;
    remember(event.target);
    paint(event.target);
  }

  function attach() {
    if (TV.attached) {
      applyMode();
      return;
    }
    TV.attached = true;
    TV.settings = loadSettings();
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("resize", function () { if (TV.on) applyScale(); });
    window.addEventListener("hashchange", function () {
      var flag = queryFlag();
      if (flag === "on" || flag === "off") TV.forced = flag;
      stripTvParam();
      if (TV.on) document.documentElement.setAttribute("data-tv-ready", "0");
      if (flag === "on" && !TV.on) enter();
      else if (flag === "off" && TV.on) exit();
      else if (TV.on) scheduleRestore();
    });
    var root = document.getElementById("app");
    if (root && window.MutationObserver) {
      var obs = new MutationObserver(function () { if (TV.on) { scheduleRestore(); scheduleDream(); } });
      obs.observe(root, { childList: true, subtree: true });
    }
    var layer = document.getElementById("account-layer");
    if (layer && window.MutationObserver) {
      var watch = new MutationObserver(function () { if (TV.on) scheduleRestore(); });
      watch.observe(layer, { childList: true });
    }
    applyMode();
  }

  window.FeedsTV = {
    settingsHtml: settingsHtml,
    appTitle: appTitle,
    attach: attach,
    focus: function (el) { if (TV.on && el) setFocus(el, false); },
    enabled: function () { return TV.on; }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attach);
  else attach();
})();
