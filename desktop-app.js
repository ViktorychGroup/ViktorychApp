/* Installed desktop app chrome: the title bar we draw with Window Controls
   Overlay, the hidden page scrollbar, a Close button and an opt-in full screen.
   App size is a separate scale of this page only. It is not the browser's zoom.

   What a web app can and cannot do here:
   - The OS minimize, maximize and close buttons always stay. Window Controls
     Overlay (Chromium on Windows, macOS, Linux) only lets the page draw in the
     rest of the title bar; the browser tells us where with
     env(titlebar-area-*) and navigator.windowControlsOverlay.
   - window.close() only works in an installed app window. Chromium may still
     refuse it after in-app navigation, so we check and show the OS shortcut.
   - Full screen is only entered from a user's click or shortcut, never on load.
   - Firefox has no desktop install, so none of the installed-only parts show. */
// A maximized window with the toolbar fills the work area. Full screen (F11
// or the Fullscreen API) is not that. Anything in between is not a guess.
function windowGuess(m) {
  m = m || {};
  if (m.fullscreen || m.fullDisplay) return "fullscreen";
  var ow = Number(m.outerW) || 0;
  var oh = Number(m.outerH) || 0;
  var aw = Number(m.availW) || 0;
  var ah = Number(m.availH) || 0;
  if (ow < 200 || oh < 200 || aw < 200 || ah < 200) return "unknown";
  if (ow >= aw - 16 && oh >= ah - 16) return "maximized";
  if (ow <= aw - 80 || oh <= ah - 80) return "window";
  return "unknown";
}
function desktopGate(innerWidth) {
  return (Number(innerWidth) || 0) >= 1000;
}
function clampScale(n) {
  var x = Math.round(Number(n) / 5) * 5;
  if (!isFinite(x)) return 100;
  if (x < 100) return 100;
  if (x > 200) return 200;
  return x;
}
// null means the window guess is unsure, so the current size must stay.
function scaleChoice(pref, guess, desktop) {
  if (!desktop) return 100;
  pref = pref || {};
  var mode = pref.mode || "off";
  if (mode === "off") return 100;
  if (mode === "manual") return clampScale(pref.manual == null ? 100 : pref.manual);
  if (mode === "window") {
    if (guess === "maximized") return clampScale(pref.maximized == null ? 150 : pref.maximized);
    if (guess === "window") return clampScale(pref.windowed == null ? 120 : pref.windowed);
    return null;
  }
  return 100;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { windowGuess: windowGuess, clampScale: clampScale, scaleChoice: scaleChoice, desktopGate: desktopGate };
}

(function () {
  "use strict";
  var root = typeof window !== "undefined" ? window : globalThis;
  var doc = root.document;
  if (!doc) return;
  var html = doc.documentElement;
  var KEY = "viktorych-desktop-v1";
  var bootInstalled = false;
  var exitTimer = 0;

  function tr(key, vars) {
    var fn = root.t || (root.SI18n && root.SI18n.t);
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function mq(query) {
    try { return !!(root.matchMedia && root.matchMedia(query).matches); } catch (err) { return false; }
  }
  function read() {
    try {
      var raw = root.localStorage.getItem(KEY);
      var doc2 = raw ? JSON.parse(raw) : null;
      return doc2 && typeof doc2 === "object" ? doc2 : {};
    } catch (err) { return {}; }
  }
  function write(prefs) {
    try { root.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (err) { /* storage is full */ }
  }

  // X-style outline glyphs on the same 24px grid and weight as the nav icons.
  var PATH = {
    close: "M10.59 12 4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z",
    expand: "M3 3h7v2H6.41l4.3 4.29-1.42 1.42L5 6.41V10H3V3zm11 0h7v7h-2V6.41l-4.29 4.3-1.42-1.42L17.59 5H14V3zM5 17.59l4.29-4.3 1.42 1.42L6.41 19H10v2H3v-7h2v3.59zm13.59-4.3L19 13.7V14h2v7h-7v-2h3.59l-4.3-4.29 1.42-1.42 3.88 3.88z",
    // Four arrows pointing in, drawn on the same grid as expand.
    collapse: "M8.59 10H3V8h3.59L2.29 3.71l1.42-1.42L8 6.59V3h2v7H8.59zM14 3h2v3.59l4.29-4.3 1.42 1.42L17.41 8H21v2h-7V3zM3 14h7v7H8v-3.59l-4.29 4.3-1.42-1.42L6.59 16H3v-2zm11 0h7v2h-3.59l4.3 4.29-1.42 1.42L16 17.41V21h-2v-7z"
  };
  function glyph(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="' + PATH[name] + '"/></svg>';
  }

  // ---- where are we running ----
  function installedNow() {
    return mq("(display-mode: standalone)") || mq("(display-mode: window-controls-overlay)") || mq("(display-mode: minimal-ui)") || root.navigator.standalone === true;
  }
  function installed() {
    // Entering full screen switches display-mode to fullscreen; we still are the app window.
    return bootInstalled || installedNow();
  }
  function wcoApi() {
    return root.navigator && root.navigator.windowControlsOverlay ? root.navigator.windowControlsOverlay : null;
  }
  function wcoVisible() {
    var api = wcoApi();
    if (api && typeof api.visible === "boolean" && api.visible) return true;
    return mq("(display-mode: window-controls-overlay)");
  }
  function fsSupported() {
    if (/iPhone|iPod/.test((root.navigator && root.navigator.userAgent) || "")) return false;
    var enabled = doc.fullscreenEnabled || doc.webkitFullscreenEnabled;
    return !!(enabled && (html.requestFullscreen || html.webkitRequestFullscreen));
  }
  function fsElement() {
    return doc.fullscreenElement || doc.webkitFullscreenElement || null;
  }
  function fsActive() {
    return fsElement() === html;
  }
  function closeSupported() {
    return installed() && typeof root.close === "function";
  }

  // ---- full screen ----
  function enterFullscreen() {
    if (!fsSupported() || fsElement()) return Promise.resolve(false);
    var run;
    try {
      if (html.requestFullscreen) run = html.requestFullscreen({ navigationUI: "hide" });
      else if (html.webkitRequestFullscreen) run = html.webkitRequestFullscreen();
    } catch (err) {
      toast(tr("Full screen isn’t available here."));
      return Promise.resolve(false);
    }
    return Promise.resolve(run).then(function () { return true; }, function () {
      toast(tr("Full screen isn’t available here."));
      return false;
    });
  }
  function exitFullscreen() {
    if (!fsElement()) return Promise.resolve(false);
    try {
      var run = doc.exitFullscreen ? doc.exitFullscreen() : (doc.webkitExitFullscreen ? doc.webkitExitFullscreen() : null);
      return Promise.resolve(run).then(function () { return true; }, function () { return false; });
    } catch (err) { return Promise.resolve(false); }
  }
  function toggleFullscreen() {
    return fsActive() ? exitFullscreen() : enterFullscreen();
  }
  function fsLabel() {
    return fsActive() ? tr("Exit full screen") : tr("Full screen");
  }

  // ---- drafts before closing ----
  // Text drafts are written to this device. Attached photos, video and
  // anything typed outside the composer cannot be kept, so we ask about those.
  function protectDrafts() {
    var unsaved = 0;
    var compose = root.ViktorychXCompose;
    if (compose && typeof compose.flushDrafts === "function") {
      try {
        var res = compose.flushDrafts() || {};
        unsaved += Number(res.unsaved) || 0;
        if (res.failed) unsaved += 1;
      } catch (err) { unsaved += 1; }
    }
    var fields = doc.querySelectorAll("#app textarea, #app [contenteditable='true']");
    for (var i = 0; i < fields.length; i++) {
      var el = fields[i];
      if (el.matches && el.matches("[data-xc=\"text\"]")) continue;
      if (el.id === "compose-text") continue;
      var value = el.tagName === "TEXTAREA" ? el.value : el.textContent;
      if (String(value || "").trim()) unsaved += 1;
    }
    return { unsaved: unsaved };
  }
  function closeApp() {
    if (!closeSupported()) return false;
    var state = protectDrafts();
    if (state.unsaved > 0) {
      var ok = root.confirm(tr("Some of what you were writing can’t be saved on this device, like attached photos or video. Close anyway?"));
      if (!ok) return false;
    }
    try { root.close(); } catch (err) { /* refused below */ }
    setTimeout(function () {
      if (doc.visibilityState === "hidden") return;
      var mac = /Mac/.test((root.navigator && root.navigator.platform) || "") || /Mac OS X/.test((root.navigator && root.navigator.userAgent) || "");
      toast(mac
        ? tr("Your browser kept this window open. Press {keys} to close it.", { keys: "⌘W" })
        : tr("Your browser kept this window open. Press {keys} to close it.", { keys: "Alt+F4" }));
    }, 450);
    return true;
  }

  function toast(message) {
    var el = doc.getElementById("toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 4000);
  }

  // ---- title bar ----
  function barHtml() {
    var fs = fsSupported();
    return '<div class="wco-drag"><span class="wco-title">' + esc(doc.title || "ViktorychApp") + '</span></div>'
      + '<div class="wco-tools">'
      + (fs ? '<button class="wco-btn" type="button" data-desk="fullscreen" aria-label="' + esc(fsLabel()) + '" title="' + esc(fsLabel()) + '">' + glyph(fsActive() ? "collapse" : "expand") + "</button>" : "")
      + (closeSupported() ? '<button class="wco-btn wco-close" type="button" data-desk="close" aria-label="' + esc(tr("Close app")) + '" title="' + esc(tr("Close app")) + '">' + glyph("close") + "</button>" : "")
      + "</div>";
  }
  function paintBar() {
    var bar = doc.querySelector(".wco");
    if (!bar) return;
    var on = wcoVisible() && !fsActive();
    html.classList.toggle("vk-wco", on);
    if (!on) {
      if (bar.innerHTML) bar.innerHTML = "";
      bar.setAttribute("aria-hidden", "true");
      return;
    }
    bar.removeAttribute("aria-hidden");
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", tr("Title bar"));
    bar.innerHTML = barHtml();
  }
  function applyGeometry(rect) {
    var api = wcoApi();
    var box = rect || (api && api.getTitlebarAreaRect ? api.getTitlebarAreaRect() : null);
    if (!box || !box.width) {
      ["--tb-x", "--tb-y", "--tb-w", "--tb-h"].forEach(function (name) { html.style.removeProperty(name); });
    } else {
      html.style.setProperty("--tb-x", box.x + "px");
      html.style.setProperty("--tb-y", box.y + "px");
      html.style.setProperty("--tb-w", box.width + "px");
      html.style.setProperty("--tb-h", box.height + "px");
      html.classList.toggle("vk-wco-narrow", box.width < 320);
    }
    paintBar();
  }

  // ---- full screen exit control ----
  function exitControl() {
    var el = doc.getElementById("vk-fs-exit");
    if (el) return el;
    el = doc.createElement("button");
    el.id = "vk-fs-exit";
    el.type = "button";
    el.className = "vk-fs-exit";
    el.setAttribute("data-desk", "fullscreen");
    doc.body.appendChild(el);
    return el;
  }
  function showExit(ms) {
    if (!fsActive()) return;
    var el = exitControl();
    el.innerHTML = glyph("collapse") + "<span>" + esc(tr("Exit full screen")) + "</span>";
    el.setAttribute("aria-label", tr("Exit full screen"));
    el.classList.add("on");
    clearTimeout(exitTimer);
    exitTimer = setTimeout(function () { el.classList.remove("on"); }, ms || 2200);
  }
  function syncFullscreen() {
    var on = fsActive();
    html.classList.toggle("vk-fs", on);
    var el = doc.getElementById("vk-fs-exit");
    if (on) showExit(2600);
    else if (el) el.classList.remove("on");
    paintBar();
    doc.querySelectorAll("[data-desk-fs-label]").forEach(function (node) { node.textContent = fsLabel(); });
    doc.querySelectorAll("[data-desk-fs-icon]").forEach(function (node) { node.innerHTML = glyph(on ? "collapse" : "expand"); });
    if (typeof root.dispatchEvent === "function") {
      try { root.dispatchEvent(new CustomEvent("viktorych-fullscreen", { detail: { on: on } })); } catch (err) { /* old browser */ }
    }
  }

  // ---- settings and menus ----
  function featureOn() {
    try {
      var off = JSON.parse(root.localStorage.getItem("viktorychapp-server-off") || "[]");
      if (off && off.indexOf && off.indexOf("app_scale") >= 0) return false;
    } catch (err) { /* a bad list means the feature stays available */ }
    return true;
  }
  function scalePref() {
    var raw = read().scale;
    raw = raw && typeof raw === "object" ? raw : {};
    return {
      mode: raw.mode === "manual" || raw.mode === "window" ? raw.mode : "off",
      manual: clampScale(raw.manual == null ? 100 : raw.manual),
      maximized: clampScale(raw.maximized == null ? 150 : raw.maximized),
      windowed: clampScale(raw.windowed == null ? 120 : raw.windowed)
    };
  }
  function metrics() {
    var screen = root.screen || {};
    return {
      fullscreen: !!fsElement(),
      fullDisplay: mq("(display-mode: fullscreen)") && !fsElement(),
      outerW: root.outerWidth || 0,
      outerH: root.outerHeight || 0,
      availW: screen.availWidth || 0,
      availH: screen.availHeight || 0
    };
  }
  function desktopEnough() {
    // innerWidth is the window's CSS width. Our page scale does not change it,
    // so multiplying by the scale would keep a narrow window looking wide.
    return desktopGate(root.innerWidth);
  }
  function applyScale() {
    if (!featureOn() || !desktopEnough()) {
      if (html.style.zoom) html.style.zoom = "";
      return;
    }
    var choice = scaleChoice(scalePref(), windowGuess(metrics()), true);
    if (choice == null) return;
    html.style.zoom = choice === 100 ? "" : String(choice / 100);
  }
  function applyPrefs() {
    var prefs = read();
    html.classList.toggle("vk-show-scrollbar", prefs.showScrollbar === true);
    html.classList.toggle("vk-installed", installed());
    applyScale();
  }
  function setPref(key, value) {
    var prefs = read();
    if (key === "showScrollbar" || key === "fsShortcut") prefs[key] = value === true || value === "1";
    write(prefs);
    applyPrefs();
  }
  function settingsHtml() {
    var prefs = read();
    function toggle(key, on, label, desc) {
      return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-act="desk-pref" data-key="' + key + '" data-value="' + (on ? "0" : "1") + '"><span>' + esc(label) + "</span><i></i></button>"
        + (desc ? '<p class="phandle set-desc">' + esc(desc) + "</p>" : "");
    }
    var out = '<h2>' + esc(tr("Desktop app")) + '</h2><div class="desk-settings" data-desk-settings>';
    out += toggle("showScrollbar", prefs.showScrollbar === true, tr("Show scrollbar"), tr("The installed app hides the page scrollbar. You can still scroll with the wheel, trackpad, keyboard or touch. Browser tabs always show it."));
    if (fsSupported()) {
      out += '<div class="theme-row"><button class="outline' + (fsActive() ? " on" : "") + '" type="button" data-act="desk-fullscreen" aria-pressed="' + (fsActive() ? "true" : "false") + '"><span data-desk-fs-label>' + esc(fsLabel()) + "</span></button></div>";
      out += toggle("fsShortcut", prefs.fsShortcut !== false, tr("Full screen shortcut"), tr("Ctrl+Shift+F (⌘+Shift+F on Mac) turns full screen on and off. Esc or F11 also leaves it."));
    }
    if (installed()) {
      out += '<p class="phandle set-desc">' + esc(tr("Your computer’s own minimize, maximize and close buttons always stay in the corner. The app draws its title bar next to them.")) + "</p>";
    }
    if (featureOn() && desktopEnough()) out += scaleHtml(prefs);
    return out + "</div>";
  }
  function scaleHtml() {
    var pref = scalePref();
    var guess = windowGuess(metrics());
    var guessText = guess === "maximized" ? tr("Maximized with the toolbar") : guess === "window" ? tr("In a window") : guess === "fullscreen" ? tr("Full screen") : tr("Not sure");
    function modeBtn(id, label) {
      var on = pref.mode === id;
      return '<button class="outline' + (on ? " on" : "") + '" type="button" data-act="desk-scale-mode" data-value="' + id + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(label) + "</button>";
    }
    function slider(key, label, value) {
      return '<label class="desk-scale"><span>' + esc(label) + '</span><input type="range" min="100" max="200" step="5" data-desk-scale data-key="' + key + '" value="' + value + '" aria-label="' + esc(label) + '"><b data-desk-scale-out>' + value + "%</b></label>";
    }
    var out = '<h2>' + esc(tr("App size")) + "</h2>";
    out += '<p class="phandle set-desc">' + esc(tr("This scales the app in this browser on this computer. Everyone who uses this browser here shares it. It is not saved to an account and it is not sent anywhere. It does not change the browser’s zoom, and the two add together if both are on. It starts off.")) + "</p>";
    out += '<div class="theme-row">' + modeBtn("off", tr("Off")) + modeBtn("manual", tr("One size")) + modeBtn("window", tr("Match the window")) + "</div>";
    if (pref.mode === "manual") out += slider("manual", tr("One size"), pref.manual);
    if (pref.mode === "window") {
      out += slider("maximized", tr("Maximized with the toolbar"), pref.maximized);
      out += slider("windowed", tr("In a window"), pref.windowed);
      out += '<p class="phandle set-desc">' + esc(tr("The app guesses a maximized window when it fills the work area, with the toolbar still showing. Full screen is left alone. If the guess is unsure, the size stays as it is.")) + " " + esc(guessText) + ".</p>";
    }
    return out;
  }
  // Rows for the side menu (drawer) and the profile popup.
  function menuRowsHtml(kind) {
    var rows = "";
    if (fsSupported()) {
      rows += kind === "drawer"
        ? '<button class="drawer-row" type="button" data-act="desk-fullscreen"><span class="drawer-ico" data-desk-fs-icon>' + glyph(fsActive() ? "collapse" : "expand") + '</span><span class="drawer-label" data-desk-fs-label>' + esc(fsLabel()) + "</span></button>"
        : '<button type="button" role="menuitem" data-act="desk-fullscreen"><span data-desk-fs-label>' + esc(fsLabel()) + "</span></button>";
    }
    if (closeSupported()) {
      rows += kind === "drawer"
        ? '<button class="drawer-row" type="button" data-act="desk-close"><span class="drawer-ico">' + glyph("close") + '</span><span class="drawer-label">' + esc(tr("Close app")) + "</span></button>"
        : '<button type="button" role="menuitem" data-act="desk-close">' + esc(tr("Close app")) + "</button>";
    }
    return rows;
  }
  // Called from the app's click handler, inside the user's gesture.
  function onAct(act, el) {
    if (act === "desk-fullscreen") { toggleFullscreen(); return true; }
    if (act === "desk-close") { closeApp(); return true; }
    if (act === "desk-pref") { setPref(el && el.dataset.key, el && el.dataset.value); return true; }
    if (act === "desk-scale-mode") {
      var prefs = read();
      var scale = scalePref();
      var next = el && el.dataset.value;
      scale.mode = next === "manual" || next === "window" ? next : "off";
      prefs.scale = scale;
      write(prefs);
      applyScale();
      return true;
    }
    return false;
  }

  function onKey(event) {
    if (!event || event.defaultPrevented || event.repeat) return;
    var key = String(event.key || "").toLowerCase();
    if (key !== "f" || !event.shiftKey || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    if (read().fsShortcut === false || !fsSupported()) return;
    event.preventDefault();
    toggleFullscreen();
  }

  function boot() {
    bootInstalled = installedNow();
    applyPrefs();
    var api = wcoApi();
    if (api && api.addEventListener) {
      api.addEventListener("geometrychange", function (event) {
        applyGeometry(event && event.titlebarAreaRect);
      });
    }
    ["(display-mode: window-controls-overlay)", "(display-mode: standalone)", "(display-mode: fullscreen)"].forEach(function (query) {
      try {
        var list = root.matchMedia(query);
        var fn = function () { applyPrefs(); applyGeometry(); };
        if (list.addEventListener) list.addEventListener("change", fn);
        else if (list.addListener) list.addListener(fn);
      } catch (err) { /* no matchMedia */ }
    });
    doc.addEventListener("input", function (event) {
      var el = event.target;
      if (!el || !el.getAttribute || el.getAttribute("data-desk-scale") == null) return;
      var key = el.getAttribute("data-key");
      if (key !== "manual" && key !== "maximized" && key !== "windowed") return;
      var prefs = read();
      var scale = scalePref();
      scale[key] = clampScale(el.value);
      prefs.scale = scale;
      write(prefs);
      var out = el.parentNode && el.parentNode.querySelector("[data-desk-scale-out]");
      if (out) out.textContent = scale[key] + "%";
      applyScale();
    });
    var scaleTimer = 0;
    root.addEventListener("resize", function () {
      clearTimeout(scaleTimer);
      scaleTimer = setTimeout(applyScale, 120);
    });
    doc.addEventListener("fullscreenchange", function () { syncFullscreen(); applyScale(); });
    doc.addEventListener("webkitfullscreenchange", function () { syncFullscreen(); applyScale(); });
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("click", function (event) {
      var hit = event.target && event.target.closest ? event.target.closest("[data-desk]") : null;
      if (!hit) return;
      event.preventDefault();
      if (hit.getAttribute("data-desk") === "fullscreen") toggleFullscreen();
      else if (hit.getAttribute("data-desk") === "close") closeApp();
    });
    doc.addEventListener("pointermove", function (event) {
      if (!fsActive() || event.pointerType === "touch") return;
      if (event.clientY <= 48) showExit(2200);
    }, { passive: true });
    // Closing with the OS button: keep text drafts. A page can't block the
    // close; the browser shows its own prompt only if something is unsaved.
    root.addEventListener("beforeunload", function (event) {
      if (!installed()) return;
      var state = protectDrafts();
      if (state.unsaved > 0) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    root.addEventListener("viktorych-late", function () { paintBar(); });
    // Keep the title in the bar in step with the page title.
    var titleEl = doc.querySelector("title");
    if (titleEl && typeof MutationObserver === "function") {
      new MutationObserver(function () {
        var span = doc.querySelector(".wco .wco-title");
        if (span) span.textContent = doc.title || "ViktorychApp";
      }).observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
    applyGeometry();
  }

  root.ViktorychDesktop = {
    installed: installed,
    wcoVisible: wcoVisible,
    fsSupported: fsSupported,
    fsActive: fsActive,
    enterFullscreen: enterFullscreen,
    exitFullscreen: exitFullscreen,
    toggleFullscreen: toggleFullscreen,
    closeSupported: closeSupported,
    closeApp: closeApp,
    protectDrafts: protectDrafts,
    settingsHtml: settingsHtml,
    windowGuess: function () { return windowGuess(metrics()); },
    scaleNow: function () { return html.style.zoom || ""; },
    applyScale: applyScale,
    menuRowsHtml: menuRowsHtml,
    onAct: onAct,
    setPref: setPref
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
