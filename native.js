/* Installed-app behavior that the page can feature-detect.
   Each path keeps working when the browser does not offer the API. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychNative = api;
  if (typeof document !== "undefined") api.start();
})(typeof self !== "undefined" ? self : this, function () {
  var INSTALL_KEY = "viktorychapp-install-dismissed";
  var OUTBOX = { post: true, reply: true, like: true, dm: true, repost: true, bookmark: true, follow: true };
  var pendingLaunch = null;
  var wakeSentinel = null;
  var orientationHeld = false;
  var engaged = false;
  var started = false;

  function t(key) {
    var fn = typeof self !== "undefined" && self.t ? self.t : null;
    return fn ? fn(key) : key;
  }

  function shouldOfferInstall(opts) {
    opts = opts || {};
    if (opts.standalone || opts.installed) return false;
    if (opts.manual) return true;
    var mode = opts.dismissed === true || opts.dismissed === "never" ? "never" : (opts.dismissed === "later" ? "later" : "");
    if (mode === "never") return false;
    if (mode === "later") {
      var wait = typeof opts.laterMs === "number" ? opts.laterMs : 7 * 24 * 60 * 60 * 1000;
      var at = Number(opts.dismissedAt) || 0;
      var now = Number(opts.now) || Date.now();
      if (now - at < wait) return false;
      return true;
    }
    if (opts.prompt) return true;
    if (opts.ios && opts.engaged) return true;
    if (opts.afterSignup) return true;
    return false;
  }

  function installKind(ua, extra) {
    var text = String(ua || "");
    var touchMac = !!(extra && extra.touchMac);
    var ios = /iphone|ipad|ipod/i.test(text) || touchMac;
    var other = /crios|fxios|edgios|instagram|fbav|fban|line\/|micromessenger|musical_ly|tiktok/i.test(text);
    if (ios && other) return "ios-browser";
    if (ios) return "ios-safari";
    if (/edg\//i.test(text) || /edga\//i.test(text) || /chrome|chromium/i.test(text)) return "native";
    return "hint";
  }

  function installArrow(kind, ua, extra) {
    if (kind !== "ios-safari") return "";
    var text = String(ua || "");
    if (/ipad/i.test(text) || (extra && extra.touchMac)) return "up";
    return "down";
  }

  function readInstallChoice() {
    try {
      var raw = localStorage.getItem(INSTALL_KEY);
      if (!raw) return { mode: "", at: 0 };
      if (raw === "1" || raw === "never") return { mode: "never", at: 0 };
      var parsed = JSON.parse(raw);
      if (parsed && parsed.mode === "later") return { mode: "later", at: Number(parsed.at) || 0 };
      if (parsed && parsed.mode === "never") return { mode: "never", at: 0 };
    } catch (err) { /* a broken value shows the offer again */ }
    return { mode: "", at: 0 };
  }

  function writeInstallChoice(mode) {
    try {
      if (mode === "never") localStorage.setItem(INSTALL_KEY, "never");
      else localStorage.setItem(INSTALL_KEY, JSON.stringify({ mode: "later", at: Date.now() }));
    } catch (err) { /* private mode still closes the sheet */ }
  }

  function shouldAskPersist(opts) {
    opts = opts || {};
    if (!opts.api) return false;
    return !!(opts.standalone || opts.installed || opts.engaged);
  }

  function protocolHash(value) {
    var text = String(value || "").trim();
    var cut = text.indexOf(":");
    var rest = cut >= 0 ? text.slice(cut + 1) : text;
    rest = rest.replace(/^\/+/, "");
    if (!rest) return "#/home";
    if (rest.charAt(0) === "#") return rest;
    if (rest.charAt(0) === "?") return "#/home" + rest;
    return "#/" + rest;
  }

  function outboxAction(action) {
    return !!(action && OUTBOX[action.type]);
  }

  function yieldThread() {
    var scheduler = typeof navigator !== "undefined" ? navigator.scheduler : null;
    if (scheduler && typeof scheduler.yield === "function") {
      try { return scheduler.yield(); }
      catch (err) { /* fall through to idle time */ }
    }
    return new Promise(function (resolve) {
      if (typeof requestIdleCallback === "function") requestIdleCallback(function () { resolve(); }, { timeout: 50 });
      else setTimeout(resolve, 0);
    });
  }

  function iosDevice() {
    if (typeof navigator === "undefined") return false;
    return /iphone|ipad|ipod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function standalone() {
    if (typeof matchMedia !== "function" && typeof navigator === "undefined") return false;
    try {
      if (typeof matchMedia === "function" && (matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches || (matchMedia("(display-mode: fullscreen)").matches && !document.fullscreenElement))) return true;
    } catch (err) { /* matchMedia can throw in a locked document */ }
    return typeof navigator !== "undefined" && navigator.standalone === true;
  }

  function dismissed() {
    return readInstallChoice().mode === "never";
  }

  function dismissInstall() {
    try { localStorage.setItem(INSTALL_KEY, "1"); } catch (err) { /* private mode still hides the banner */ }
    var banner = document.getElementById("install-banner");
    if (banner) banner.remove();
  }

  function rememberLaunch(detail) {
    pendingLaunch = detail || null;
    if (typeof document === "undefined" || !detail) return;
    try { document.dispatchEvent(new CustomEvent("viktorych-launch", { detail: detail })); }
    catch (err) { /* the boot path reads takeLaunch */ }
  }

  function takeLaunch() {
    var detail = pendingLaunch;
    pendingLaunch = null;
    return detail;
  }

  function askPersist(reason) {
    var storage = typeof window !== "undefined" ? window.ViktorychStorage : null;
    var apiOk = !!(storage && storage.askPersist);
    if (!shouldAskPersist({ api: apiOk, standalone: standalone(), installed: reason === "install", engaged: reason === "use" || engaged })) return Promise.resolve(false);
    return storage.askPersist();
  }

  function markEngaged() {
    if (engaged) return;
    engaged = true;
    askPersist("use");
    paintInstall();
  }

  function paintInstall() {
    if (typeof document === "undefined") return;
    if (document.getElementById("app")) return;
    var choice = readInstallChoice();
    var offer = shouldOfferInstall({
      standalone: standalone(),
      dismissed: choice.mode === "later" ? "later" : choice.mode === "never",
      dismissedAt: choice.at,
      prompt: !!(typeof window !== "undefined" && window.__VIKTORYCH_INSTALL),
      ios: iosDevice(),
      engaged: engaged
    });
    var banner = document.getElementById("install-banner");
    if (!offer) {
      if (banner) banner.remove();
      return;
    }
    if (banner) return;
    banner = document.createElement("div");
    banner.id = "install-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-label", t("Install ViktorychApp"));
    var ios = iosDevice() && !(typeof window !== "undefined" && window.__VIKTORYCH_INSTALL);
    var steps = ios
      ? "<ol><li>" + t("Tap Share in Safari") + "</li><li>" + t("Choose Add to Home Screen") + "</li><li>" + t("Tap Add") + "</li></ol>"
      : "";
    banner.innerHTML = "<div class=\"install-card\"><b>" + t("Install ViktorychApp") + "</b>" + steps +
      "<div class=\"install-actions\"><button type=\"button\" data-native=\"install-go\">" + t("Install app") + "</button>" +
      "<button type=\"button\" data-native=\"install-dismiss\">" + t("Not now") + "</button></div></div>";
    banner.querySelector("[data-native='install-dismiss']").addEventListener("click", dismissInstall);
    banner.querySelector("[data-native='install-go']").addEventListener("click", function () {
      var prompt = window.__VIKTORYCH_INSTALL;
      if (prompt && prompt.prompt) {
        Promise.resolve(prompt.prompt()).then(function () { return prompt.userChoice; }).catch(function () {}).then(dismissInstall);
        window.__VIKTORYCH_INSTALL = null;
        return;
      }
      dismissInstall();
    });
    document.body.appendChild(banner);
  }

  function paintTitlebar() {
    var bar = document.querySelector(".wco");
    if (!bar) return;
    var label = bar.querySelector(".wco-title");
    if (!label) {
      label = document.createElement("div");
      label.className = "wco-title";
      bar.appendChild(label);
    }
    var text = String(document.title || "ViktorychApp").replace(/\s+\/\s+ViktorychApp$/, "");
    label.textContent = text || "ViktorychApp";
  }

  function installSpeculation() {
    var urls = ["feeds.json", "people.json", "suggestions.json", "stories.json", "offline.html"];
    try {
      if (window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports("speculationrules")) {
        var spec = document.createElement("script");
        spec.type = "speculationrules";
        spec.textContent = JSON.stringify({ prefetch: [{ urls: urls, eagerness: "conservative" }] });
        document.head.appendChild(spec);
        return "speculationrules";
      }
    } catch (err) { /* a link prefetch is the fallback */ }
    urls.forEach(function (href) {
      if (document.querySelector("link[rel='prefetch'][href='" + href + "']")) return;
      var link = document.createElement("link");
      link.rel = "prefetch";
      link.href = href;
      document.head.appendChild(link);
    });
    return "prefetch";
  }

  function artworkFor(el) {
    var icon = new URL("icons/icon-512.png", location.href).href;
    var art = [{ src: icon, sizes: "512x512", type: "image/png" }];
    var poster = el && (el.poster || "");
    if (poster) art.unshift({ src: poster, sizes: "512x512", type: "image/jpeg" });
    return art;
  }

  function fillSession(el) {
    if (!navigator.mediaSession || typeof MediaMetadata === "undefined") return false;
    if (navigator.mediaSession.metadata) return false;
    var raw = (el && el.getAttribute && el.getAttribute("aria-label")) || document.title || "ViktorychApp";
    var title = String(raw).replace(/\s+\/\s+ViktorychApp$/, "") || "ViktorychApp";
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title,
        artist: "ViktorychApp",
        artwork: artworkFor(el)
      });
      navigator.mediaSession.playbackState = "playing";
      var set = function (name, fn) {
        try { navigator.mediaSession.setActionHandler(name, fn); }
        catch (err) { /* this action is not on this platform */ }
      };
      if (el && el.play) {
        set("play", function () { el.play(); });
        set("pause", function () { el.pause(); });
      }
      return true;
    } catch (err) {
      return false;
    }
  }

  function playingNow() {
    var nodes = document.querySelectorAll("video, audio");
    var i;
    for (i = 0; i < nodes.length; i++) {
      if (!nodes[i].paused && !nodes[i].ended) return nodes[i];
    }
    var frame = document.getElementById("tv-player-frame");
    if (frame && frame.src && frame.src !== "about:blank") return frame;
    return null;
  }

  function syncWake(active) {
    if (!navigator.wakeLock || !navigator.wakeLock.request) return Promise.resolve(false);
    if (!active) {
      var held = wakeSentinel;
      wakeSentinel = null;
      if (held && held.release) return held.release().catch(function () { return false; });
      return Promise.resolve(false);
    }
    if (wakeSentinel && wakeSentinel.released === false) return Promise.resolve(true);
    return navigator.wakeLock.request("screen").then(function (sentinel) {
      wakeSentinel = sentinel;
      return true;
    }).catch(function () {
      wakeSentinel = null;
      return false;
    });
  }

  function syncPlayback() {
    var media = playingNow();
    syncWake(!!media);
    var pip = document.getElementById("native-pip");
    if (pip) {
      var canDoc = !!(window.documentPictureInPicture && documentPictureInPicture.requestWindow);
      var canEl = !!(document.pictureInPictureEnabled && media && media.requestPictureInPicture);
      /* Server voice calls play hidden audio and tiles; they aren't for a pop-out. */
      var voice = !!(media && media.hasAttribute && media.hasAttribute("data-voice"));
      pip.hidden = !(media && !voice && (canDoc || canEl));
    }
    if (media && media.tagName === "IFRAME") setTimeout(function () { fillSession(media); }, 0);
  }

  function openDocumentPip() {
    var node = document.getElementById("tv-player-frame") || document.querySelector(".player.vplay.is-playing video, video");
    var docPip = window.documentPictureInPicture;
    if (docPip && docPip.requestWindow && node) {
      var parent = node.parentNode;
      var next = node.nextSibling;
      return docPip.requestWindow({ width: 480, height: 270 }).then(function (pip) {
        pip.document.body.style.margin = "0";
        pip.document.body.style.background = "#000";
        pip.document.body.appendChild(node);
        node.style.width = "100%";
        node.style.height = "100%";
        pip.addEventListener("pagehide", function () {
          if (parent) parent.insertBefore(node, next);
        });
        return true;
      }).catch(function () {
        if (node.requestPictureInPicture) return node.requestPictureInPicture().then(function () { return true; }).catch(function () { return false; });
        return false;
      });
    }
    if (node && node.requestPictureInPicture) {
      return node.requestPictureInPicture().then(function () { return true; }).catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  function lockLandscape() {
    if (!screen.orientation || !screen.orientation.lock) return;
    screen.orientation.lock("landscape").then(function () { orientationHeld = true; }).catch(function () {});
  }

  function unlockOrientation() {
    if (!orientationHeld || !screen.orientation || !screen.orientation.unlock) return;
    orientationHeld = false;
    try { screen.orientation.unlock(); } catch (err) { /* the browser keeps the current orientation */ }
  }

  function onFullscreen() {
    var el = document.fullscreenElement || document.webkitFullscreenElement;
    if (!el) { unlockOrientation(); return; }
    var video = el.tagName === "VIDEO" || (el.querySelector && el.querySelector("video")) || el.id === "tv-player-frame" || (el.classList && el.classList.contains("player"));
    if (video) lockLandscape();
  }

  function pickContact() {
    if (!navigator.contacts || !navigator.contacts.select) return Promise.resolve(null);
    return navigator.contacts.select(["name", "email", "tel"], { multiple: false }).then(function (list) {
      var row = list && list[0];
      if (!row) return null;
      var email = row.email && row.email[0];
      var tel = row.tel && row.tel[0];
      var url = location.href;
      if (email) location.href = "mailto:" + email + "?body=" + encodeURIComponent(url);
      else if (tel) location.href = "sms:" + tel + "?&body=" + encodeURIComponent(url);
      return row;
    }).catch(function () { return null; });
  }

  function mountContact(pop) {
    if (!navigator.contacts || !navigator.contacts.select || !pop || pop.querySelector("[data-native='contact']")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("data-native", "contact");
    btn.textContent = t("Choose a contact");
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      pickContact();
    });
    pop.appendChild(btn);
  }

  function showPressure(level) {
    if (level !== "critical" && level !== "warning") return;
    var el = document.getElementById("native-pressure");
    if (!el) {
      el = document.createElement("div");
      el.id = "native-pressure";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.hidden = false;
    el.textContent = t("Storage is nearly full on this device.");
  }

  function postWorker(msg) {
    var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!worker) return;
    try { worker.postMessage(msg); } catch (err) { /* the worker is restarting */ }
  }

  function mirrorOutbox(queue) {
    var list = [];
    (queue || []).forEach(function (action) { if (outboxAction(action)) list.push(action); });
    postWorker({ type: "outbox", queue: list.slice(-200) });
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (!reg.sync || !reg.sync.register) return null;
      return reg.sync.register("outbox");
    }).catch(function () {});
  }

  function wrapQueue() {
    var local = window.ViktorychLocal;
    if (!local || typeof local.enqueue !== "function" || local.enqueue._nativeOutbox) return;
    var inner = local.enqueue;
    function wrapped(action) {
      var queue = inner.apply(local, arguments);
      mirrorOutbox(queue);
      return queue;
    }
    wrapped._nativeOutbox = true;
    local.enqueue = wrapped;
  }

  function publishApi() {
    var cfg = window.VIKTORYCH_ACCOUNTS || {};
    if (cfg.api) postWorker({ type: "api-base", api: String(cfg.api) });
  }

  function readProto() {
    var params = new URLSearchParams(location.search);
    var proto = params.get("proto");
    if (!proto) return;
    rememberLaunch({ hash: protocolHash(proto) });
    params.delete("proto");
    var query = params.toString();
    try { history.replaceState(null, "", location.pathname + (query ? "?" + query : "") + (location.hash || "")); }
    catch (err) { /* the hash is still applied by takeLaunch */ }
  }

  function shareOut(data) {
    data = data || {};
    if (typeof navigator.share !== "function") return Promise.resolve(false);
    return navigator.share({ title: data.title || "", text: data.text || "", url: data.url || location.href }).then(function () { return true; }).catch(function (err) {
      if (err && err.name === "AbortError") return true;
      return false;
    });
  }

  function consumeFiles(handles) {
    var files = handles || [];
    var chain = Promise.resolve([]);
    files.forEach(function (handle) {
      chain = chain.then(function (names) {
        var ready = handle && handle.getFile ? handle.getFile() : Promise.resolve(handle);
        return ready.then(function (file) {
          if (file && file.name) names.push(file.name);
          return names;
        }).catch(function () { return names; });
      });
    });
    return chain.then(function (names) {
      if (!names.length) return;
      rememberLaunch({ compose: true, text: names.join("\n") });
    });
  }

  function armLaunchQueue() {
    if (!window.launchQueue || !launchQueue.setConsumer) return;
    try {
      launchQueue.setConsumer(function (params) {
        consumeFiles(params && params.files);
      });
    } catch (err) { /* file handling is desktop Chromium only */ }
  }

  function start() {
    if (started || typeof document === "undefined") return;
    started = true;
    readProto();
    installSpeculation();
    paintTitlebar();
    wrapQueue();
    publishApi();
    armLaunchQueue();
    if (standalone()) askPersist("install");
    var title = document.querySelector("title");
    if (title && window.MutationObserver) {
      new MutationObserver(paintTitlebar).observe(title, { childList: true, characterData: true, subtree: true });
    }
    window.addEventListener("hashchange", function () { paintTitlebar(); syncPlayback(); });
    document.addEventListener("viktorych-install-ready", paintInstall);
    document.addEventListener("viktorych-pressure", function (event) { showPressure(event.detail); });
    document.addEventListener("click", function (event) {
      var post = event.target && event.target.closest && event.target.closest("article, .post");
      if (post) markEngaged();
    }, true);
    window.addEventListener("scroll", function () {
      if (window.scrollY > 480) markEngaged();
    }, { passive: true });
    document.addEventListener("play", function (event) {
      markEngaged();
      syncPlayback();
      var el = event.target;
      setTimeout(function () { fillSession(el); }, 0);
    }, true);
    document.addEventListener("pause", syncPlayback, true);
    document.addEventListener("ended", syncPlayback, true);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") syncWake(!!playingNow());
      else syncWake(false);
    });
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);
    window.addEventListener("appinstalled", function () {
      try { localStorage.setItem(INSTALL_KEY, "1"); } catch (err) { /* the banner is removed either way */ }
      var banner = document.getElementById("install-banner");
      if (banner) banner.remove();
      askPersist("install");
    });
    if (window.MutationObserver) {
      new MutationObserver(function () {
        document.querySelectorAll(".share-pop").forEach(mountContact);
        if (document.getElementById("tv-player-frame")) syncPlayback();
      }).observe(document.body, { childList: true, subtree: true });
    }
    var pip = document.createElement("button");
    pip.id = "native-pip";
    pip.type = "button";
    pip.hidden = true;
    pip.textContent = t("Play in a window");
    pip.addEventListener("click", function () { openDocumentPip(); });
    document.body.appendChild(pip);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", function (event) {
        var data = event.data || {};
        if (data.type === "flush-outbox" && window.ViktorychLocal && window.ViktorychAppSync) {
          window.ViktorychLocal.flush(window.ViktorychAppSync);
        }
        if (data.type === "storage-pressure") showPressure("critical");
      });
    }
    paintInstall();
    setTimeout(wrapQueue, 0);
    setTimeout(publishApi, 0);
  }

  return {
    shouldOfferInstall: shouldOfferInstall,
    installKind: installKind,
    installArrow: installArrow,
    readInstallChoice: readInstallChoice,
    writeInstallChoice: writeInstallChoice,
    shouldAskPersist: shouldAskPersist,
    protocolHash: protocolHash,
    outboxAction: outboxAction,
    yieldThread: yieldThread,
    takeLaunch: takeLaunch,
    shareOut: shareOut,
    pickContact: pickContact,
    openDocumentPip: openDocumentPip,
    start: start
  };
});
