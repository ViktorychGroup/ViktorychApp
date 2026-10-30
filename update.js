/* Full-screen update for the installed app. A new worker downloads its
   files quietly in the background first; What's new shows only once they
   are all in, so Update now just switches over. A failed background
   download is never shown, it is tried again later. Drafts, the route, and
   the scroll position are written down before the reload. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychUpdate = api;
  if (typeof document !== "undefined") api.start();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var PREFIX = "viktorych-a260-";
  var SNOOZE_MS = 30 * 60 * 1000;
  var CHECK_MS = 3 * 60 * 1000;
  var RESTORE_MS = 2 * 60 * 1000;
  var SNOOZE_KEY = "viktorychapp-update-snooze";
  var RESTORE_KEY = "viktorychapp-update-restore";
  var RELOAD_KEY = "viktorychapp-sw-reload";
  var FAIL_KEY = "viktorychapp-update-fails";
  var LOG_KEY = "viktorychapp-update-log";
  var FALLBACK_KEY = "viktorychapp-update-fallback";
  var APPLIED_KEY = "viktorychapp-update-applied";
  var RING = 2 * Math.PI * 44;

  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : null;
    return fn ? fn(key, vars) : key;
  }

  function shaFromVersion(version) {
    var text = String(version || "");
    if (text.indexOf(PREFIX) !== 0) return "";
    var sha = text.slice(PREFIX.length).trim().toLowerCase();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : "";
  }

  function notesOf(doc) {
    var list = doc && Array.isArray(doc.changelog) ? doc.changelog : [];
    var out = [];
    var seen = {};
    var i;
    for (i = 0; i < list.length && out.length < 8; i++) {
      var text = String(list[i] || "").replace(/\s+/g, " ").trim();
      if (text.length > 180) text = text.slice(0, 177).trim() + "…";
      var key = text.toLowerCase();
      if (!text || seen[key]) continue;
      seen[key] = 1;
      out.push(text);
    }
    return out;
  }

  function decide(s, now) {
    if (!s || !s.pending) return "idle";
    if (s.phase === "working" || s.phase === "done" || s.phase === "error") return "overlay";
    // The new version is still downloading in the background.
    if (s.ready === false) return "idle";
    if (s.snoozeUntil && now < s.snoozeUntil) return "idle";
    if (s.forced) return "overlay";
    if (s.busy) return "pill";
    return "overlay";
  }

  function progressRatio(p) {
    var files = Number(p && p.files) || 0;
    var totalFiles = Number(p && p.totalFiles) || 0;
    var bytes = Number(p && p.bytes) || 0;
    var totalBytes = Number(p && p.totalBytes) || 0;
    var filePart = totalFiles > 0 ? files / totalFiles : 0;
    var bytePart = totalBytes > 0 ? Math.min(1, bytes / totalBytes) : filePart;
    var ratio;
    if (totalBytes > 0 && totalFiles > 0) ratio = bytePart * 0.85 + filePart * 0.15;
    else if (totalBytes > 0) ratio = bytePart;
    else ratio = filePart;
    if (ratio < 0) return 0;
    if (ratio > 1) return 1;
    return ratio;
  }

  function formatBytes(n) {
    var value = Math.max(0, Number(n) || 0);
    if (value < 1024) return String(Math.round(value)) + " B";
    if (value < 1024 * 1024) {
      var kb = value / 1024;
      return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + " KB";
    }
    var mb = value / (1024 * 1024);
    return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + " MB";
  }

  function fieldSnapshot(elements) {
    var out = [];
    var nodes = elements || [];
    var i;
    for (i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el) continue;
      var type = String(el.type || "").toLowerCase();
      if (type === "password" || type === "hidden") continue;
      var value = String(el.value || "");
      if (!value) continue;
      if (value.length > 20000) value = value.slice(0, 20000);
      out.push({
        id: el.id || "",
        name: el.name || "",
        field: el.field || "",
        ce: !!el.ce,
        value: value
      });
    }
    return out;
  }

  function restoreFresh(payload, now) {
    if (!payload || typeof payload !== "object") return false;
    var at = Number(payload.at) || 0;
    if (!at || now - at > RESTORE_MS || at - now > 5000) return false;
    return true;
  }

  function isoBuilt(value) {
    var text = String(value || "");
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text) ? text : "";
  }

  /* version.json only counts as an update when it is strictly newer than the
     running build. Equal, older, or unknown build times stay idle, and a sha
     this device already applied is never offered again. A real deploy still
     shows up through the waiting service worker. */
  function manifestPending(remoteSha, currentSha, remoteBuilt, currentBuilt, appliedSha) {
    if (!remoteSha || !currentSha || remoteSha === currentSha) return false;
    if (appliedSha && remoteSha === appliedSha) return false;
    var remote = isoBuilt(remoteBuilt);
    var local = isoBuilt(currentBuilt);
    if (!remote || !local) return false;
    return remote > local;
  }

  function appliedSha() {
    try { return String(localStorage.getItem(APPLIED_KEY) || "").toLowerCase(); } catch (err) { return ""; }
  }

  function remotePending() {
    return manifestPending(state.remoteSha, state.currentSha, state.remoteBuilt, state.currentBuilt, appliedSha());
  }

  /* Background download wait: 15s, 30s, 1m, 2m, then every 5 minutes. */
  function predownloadDelay(tries) {
    var n = Math.max(0, Number(tries) || 0);
    return Math.min(5 * 60 * 1000, 15000 * Math.pow(2, Math.min(n, 5)));
  }

  /* A waiting worker with the same sha as the running one only differs in
     its build stamp: nothing to offer. Ask it over a private port; an older
     worker that cannot answer falls back to the version.json check. */
  function considerWaiting(worker) {
    if (!worker) return;
    state.waiting = worker;
    var done = false;
    function settle(sha) {
      if (done) return;
      done = true;
      sha = String(sha || "").toLowerCase();
      var fresh = sha ? (sha !== state.currentSha && sha !== appliedSha()) : remotePending();
      if (fresh) { state.pending = true; predownload(worker); paint(); }
      else if (!applying) { state.waiting = null; }
    }
    try {
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) { settle(event.data && event.data.sha); };
      worker.postMessage({ type: "sw-version" }, [channel.port2]);
      setTimeout(function () { settle(""); }, 1500);
    } catch (err) { settle(""); }
  }

  function shouldOfferReset(failures) {
    return Number(failures) >= 2;
  }

  function shouldFallback(failures) {
    return Number(failures) >= 3;
  }

  function safeFailure(input) {
    var reason = String(input && input.reason || "").toLowerCase();
    if (reason !== "network" && reason !== "timeout" && reason !== "quota" && reason !== "newer" && reason !== "mismatch" && !/^http-\d{3}$/.test(reason)) reason = "network";
    var raw = String(input && input.url || "");
    raw = raw.split("#")[0].split("?")[0].trim();
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = new URL(raw).pathname;
    } catch (err) { raw = ""; }
    raw = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
    if (!raw || raw.indexOf("..") >= 0 || !/^[a-z0-9._/-]{1,160}$/i.test(raw)) raw = "";
    if (raw && !/\.(?:js|css|html|svg|png|ico|webmanifest|json)$/i.test(raw)) raw = "";
    return { url: raw, reason: reason };
  }

  function stepRank(step) {
    if (step === "download") return 0;
    if (step === "install") return 1;
    if (step === "activate") return 2;
    if (step === "clean") return 3;
    if (step === "ready") return 4;
    return -1;
  }

  var state = {
    pending: false,
    phase: "offer",
    step: "download",
    files: 0,
    totalFiles: 0,
    bytes: 0,
    totalBytes: 0,
    short: "",
    notes: [],
    snoozeUntil: 0,
    forced: false,
    busy: false,
    currentSha: "",
    remoteSha: "",
    currentBuilt: "",
    remoteBuilt: "",
    failPath: "",
    failReason: "",
    failures: 0,
    failureNoted: false,
    newerHops: 0,
    ready: false,
    preTries: 0,
    preBusy: false,
    preWorker: null,
    applyRetries: 0,
    expectingController: false,
    reloaded: false,
    suppressAutoFallback: false,
    reg: null,
    waiting: null
  };
  var applying = null;
  var updateFlight = null;
  var started = false;
  var checking = false;
  var reloadTimer = 0;
  var stallTimer = 0;
  var preTimer = 0;
  var userScrolled = false;
  var pendingRestore = null;
  var dom = null;

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch (err) { return false; }
  }

  function readStore(store, key) {
    try { return store.getItem(key); } catch (err) { return null; }
  }

  function writeStore(store, key, value) {
    try { store.setItem(key, value); } catch (err) { /* private mode keeps the memory copy */ }
  }

  function loadSnooze() {
    var raw = readStore(localStorage, SNOOZE_KEY);
    var until = Number(raw) || 0;
    state.snoozeUntil = until > Date.now() ? until : 0;
  }

  function mode() {
    return decide(state, Date.now());
  }

  function mediaBusy() {
    var viewer = document.getElementById("viewer");
    var videos = document.querySelectorAll("video");
    var hash = String(location.hash || "");
    var focused = /^#\/(watch|shorts|tv)(\/|$)/.test(hash);
    var i;
    for (i = 0; i < videos.length; i++) {
      var video = videos[i];
      if (!video || video.paused || video.ended) continue;
      if (viewer && !viewer.hidden && viewer.contains(video)) return true;
      if (focused) return true;
      if (!video.muted && video.volume > 0) return true;
      if (document.fullscreenElement && document.fullscreenElement.contains && document.fullscreenElement.contains(video)) return true;
    }
    try { if (window.Spaces && window.Spaces.playing && window.Spaces.playing()) return true; } catch (err) { /* the player is optional */ }
    try { if (window.SIntelMusic && window.SIntelMusic.playing && window.SIntelMusic.playing()) return true; } catch (err) { /* music is optional */ }
    return false;
  }

  function typingBusy() {
    var el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.closest && el.closest("#upd-root")) return false;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || el.isContentEditable) return true;
    if (tag === "INPUT") {
      var type = String(el.getAttribute("type") || "text").toLowerCase();
      return type === "text" || type === "search" || type === "email" || type === "url" || type === "password" || type === "tel";
    }
    return false;
  }

  function refreshBusy() {
    var next = mediaBusy() || typingBusy();
    if (next === state.busy) return;
    state.busy = next;
    paint();
  }

  function ensure() {
    if (dom) return dom;
    var rootEl = document.createElement("div");
    rootEl.id = "upd-root";
    rootEl.className = "upd-root";
    rootEl.hidden = true;
    rootEl.innerHTML = ''
      + '<button type="button" id="upd-pill" class="upd-pill" hidden></button>'
      + '<div id="upd-overlay" class="upd-overlay" hidden role="dialog" aria-modal="true" aria-labelledby="upd-title">'
      + '<div class="upd-card">'
      + '<div class="upd-logo-wrap"><svg class="upd-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="upd-track" cx="50" cy="50" r="44"></circle><circle class="upd-arc" cx="50" cy="50" r="44"></circle></svg><img class="upd-logo" alt="" src="icons/icon-192.png" width="72" height="72"></div>'
      + '<p class="upd-brand" id="upd-brand"></p>'
      + '<h1 id="upd-title"></h1>'
      + '<p class="upd-version" id="upd-version" hidden></p>'
      + '<div class="upd-progress" id="upd-progress" hidden><div class="upd-bar" aria-hidden="true"><i id="upd-bar"></i></div><p class="upd-count" id="upd-count"></p><ol class="upd-steps" id="upd-steps"></ol></div>'
      + '<section class="upd-notes" id="upd-notes" hidden><h2 id="upd-notes-title"></h2><ul id="upd-notes-list"></ul></section>'
      + '<p class="upd-error" id="upd-error" hidden></p>'
      + '<p class="upd-detail" id="upd-detail" hidden></p>'
      + '<div class="upd-actions"><button type="button" class="upd-go" id="upd-go"></button><button type="button" class="upd-later" id="upd-later"></button><button type="button" class="upd-later" id="upd-hard" hidden></button><button type="button" class="upd-later" id="upd-reset" hidden></button></div>'
      + '</div></div>';
    document.body.appendChild(rootEl);
    var steps = rootEl.querySelector("#upd-steps");
    ["download", "install", "activate", "clean"].forEach(function (name) {
      var li = document.createElement("li");
      li.className = "upd-step";
      li.setAttribute("data-step", name);
      var mark = document.createElement("span");
      mark.className = "upd-mark";
      mark.setAttribute("aria-hidden", "true");
      var label = document.createElement("span");
      label.className = "upd-label";
      li.appendChild(mark);
      li.appendChild(label);
      steps.appendChild(li);
    });
    rootEl.querySelector("#upd-pill").addEventListener("click", function () {
      state.forced = true;
      state.phase = state.phase === "error" ? "error" : "offer";
      paint();
    });
    rootEl.querySelector("#upd-go").addEventListener("click", function () {
      if (state.phase === "error") applyNow(false);
      else if (state.phase !== "working" && state.phase !== "done") applyNow(false);
    });
    rootEl.querySelector("#upd-later").addEventListener("click", snooze);
    rootEl.querySelector("#upd-hard").addEventListener("click", hardReload);
    rootEl.querySelector("#upd-reset").addEventListener("click", resetAppData);
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || mode() !== "overlay" || state.phase !== "offer") return;
      event.preventDefault();
      event.stopPropagation();
      snooze();
    }, true);
    dom = {
      root: rootEl,
      pill: rootEl.querySelector("#upd-pill"),
      overlay: rootEl.querySelector("#upd-overlay"),
      brand: rootEl.querySelector("#upd-brand"),
      title: rootEl.querySelector("#upd-title"),
      version: rootEl.querySelector("#upd-version"),
      progress: rootEl.querySelector("#upd-progress"),
      bar: rootEl.querySelector("#upd-bar"),
      count: rootEl.querySelector("#upd-count"),
      notes: rootEl.querySelector("#upd-notes"),
      notesTitle: rootEl.querySelector("#upd-notes-title"),
      notesList: rootEl.querySelector("#upd-notes-list"),
      error: rootEl.querySelector("#upd-error"),
      detail: rootEl.querySelector("#upd-detail"),
      go: rootEl.querySelector("#upd-go"),
      later: rootEl.querySelector("#upd-later"),
      hard: rootEl.querySelector("#upd-hard"),
      reset: rootEl.querySelector("#upd-reset"),
      arc: rootEl.querySelector(".upd-arc"),
      logo: rootEl.querySelector(".upd-logo")
    };
    dom.arc.style.strokeDasharray = String(RING);
    return dom;
  }

  function stepLabel(name) {
    if (name === "download") return tr("Downloading");
    if (name === "install") return tr("Installing");
    if (name === "activate") return tr("Activating");
    return tr("Cleaning up");
  }

  function paint() {
    if (!document.body) return;
    var box = ensure();
    var shown = mode();
    var reduce = reducedMotion();
    box.root.hidden = shown === "idle";
    box.root.classList.toggle("upd-reduce", reduce);
    box.root.setAttribute("data-phase", state.phase);
    document.body.classList.toggle("upd-open", shown === "overlay");
    box.pill.hidden = shown !== "pill";
    box.overlay.hidden = shown !== "overlay";
    box.pill.textContent = tr("App update");
    box.brand.textContent = tr("ViktorychApp");
    box.logo.alt = tr("ViktorychApp");
    var title = tr("Update available");
    if (state.phase === "done") title = tr("You're up to date");
    else if (state.phase === "error") title = tr("The update didn't finish.");
    box.title.textContent = title;
    if (state.short) {
      box.version.hidden = false;
      box.version.textContent = tr("Version {version}", { version: state.short });
    } else box.version.hidden = true;
    var working = state.phase === "working" || state.phase === "done";
    box.progress.hidden = !working && state.phase !== "error";
    var ratio = state.phase === "done" ? 1 : progressRatio(state);
    if (state.phase === "offer") ratio = 0.18;
    box.bar.style.width = Math.round(ratio * 100) + "%";
    box.arc.style.strokeDashoffset = String(RING * (1 - ratio));
    var files = state.files || 0;
    var total = state.totalFiles || 0;
    box.count.textContent = total
      ? formatBytes(state.bytes) + " · " + tr("{done} of {total} files", { done: String(files), total: String(total) })
      : formatBytes(state.bytes);
    var rank = state.phase === "done" ? 4 : stepRank(state.step);
    var items = box.root.querySelectorAll(".upd-step");
    var n;
    for (n = 0; n < items.length; n++) {
      var item = items[n];
      var name = item.getAttribute("data-step");
      item.querySelector(".upd-label").textContent = stepLabel(name);
      var here = stepRank(name);
      item.classList.toggle("is-done", rank > here || state.phase === "done");
      item.classList.toggle("is-now", state.phase === "working" && rank === here);
    }
    var showNotes = state.phase === "offer" && state.notes.length > 0;
    // One time only: removing the icon keeps data on Android and computers.
    if (showNotes && state.tipLine == null) {
      var dd = window.ViktorychDeviceData;
      state.tipLine = dd && dd.tipOnce ? dd.tipOnce() : "";
    }
    var notes = showNotes && state.tipLine ? state.notes.concat([state.tipLine]) : state.notes;
    box.notes.hidden = !showNotes;
    box.notesTitle.textContent = tr("What's new");
    if (showNotes) {
      var list = box.notesList;
      var same = list.childNodes.length === notes.length;
      var k;
      if (same) {
        for (k = 0; k < notes.length; k++) {
          if (list.childNodes[k].textContent !== notes[k]) { same = false; break; }
        }
      }
      if (!same) {
        list.textContent = "";
        for (k = 0; k < notes.length; k++) {
          var li = document.createElement("li");
          li.textContent = notes[k];
          list.appendChild(li);
        }
      }
    }
    box.error.hidden = state.phase !== "error";
    box.error.textContent = state.failReason === "quota"
      ? tr("This device is out of space for the update.")
      : tr("The update didn't finish. You can keep this version and try again.");
    box.detail.hidden = state.phase !== "error" || !state.failPath;
    box.detail.textContent = state.failPath || "";
    var primary = state.phase === "error" ? tr("Retry") : tr("Update now");
    box.go.hidden = state.phase === "working" || state.phase === "done";
    box.go.textContent = primary;
    box.later.hidden = state.phase !== "offer";
    box.later.textContent = tr("Later");
    box.hard.hidden = state.phase !== "error";
    box.hard.textContent = tr("Reload anyway");
    box.reset.hidden = state.phase !== "error" || !shouldOfferReset(state.failures);
    box.reset.textContent = tr("Reset app data");
    box.overlay.setAttribute("aria-busy", state.phase === "working" ? "true" : "false");
    if (shown === "overlay" && !box.go.hidden) {
      var active = document.activeElement;
      if (!active || active === box.pill || !box.root.contains(active)) {
        try { box.go.focus(); } catch (err) { /* the button is still clickable */ }
      }
    }
  }

  function snooze() {
    state.snoozeUntil = Date.now() + SNOOZE_MS;
    state.forced = false;
    if (state.phase !== "error") state.phase = "offer";
    writeStore(localStorage, SNOOZE_KEY, String(state.snoozeUntil));
    paint();
  }

  function offer() {
    state.pending = true;
    if (state.phase !== "working" && state.phase !== "done" && state.phase !== "error") state.phase = "offer";
    paint();
  }

  /* Ask the waiting worker to fetch its files now, quietly. */
  function predownload(worker) {
    worker = worker || state.waiting;
    if (!worker || state.ready && state.preWorker === worker) return;
    if (worker.state === "redundant") return;
    if (state.preBusy && state.preWorker === worker) return;
    if (state.preWorker !== worker) { state.ready = false; state.preTries = 0; }
    state.preWorker = worker;
    state.preBusy = true;
    clearTimeout(preTimer);
    // A worker the browser stops mid-download never answers; ask again.
    preTimer = setTimeout(function () { state.preBusy = false; retryPredownload(); }, 5 * 60 * 1000);
    try { worker.postMessage({ type: "predownload" }); } catch (err) { state.preBusy = false; retryPredownload(); }
  }

  function retryPredownload() {
    clearTimeout(preTimer);
    var wait = predownloadDelay(state.preTries);
    state.preTries += 1;
    preTimer = setTimeout(function () {
      if (state.ready || applying) return;
      predownload(state.waiting);
    }, wait);
  }

  function onPredownload(data) {
    if (data.type === "shell-ready") {
      clearTimeout(preTimer);
      state.preBusy = false;
      state.ready = true;
      state.preTries = 0;
      paint();
      return;
    }
    // shell-pending: the files are not all in yet. Nothing is shown.
    state.preBusy = false;
    if (data.reason === "newer") {
      // A newer deploy landed: fetch its worker and download that instead.
      state.ready = false;
      var reg = state.reg;
      if (reg && reg.update) reg.update().catch(function () {});
    }
    retryPredownload();
  }

  /* The worker sends a heartbeat every few seconds while it works. After 45
     seconds of silence the page asks it directly once and gives it a short
     grace before showing Retry, so a busy but healthy update is not cut off. */
  function armStall() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      if (state.phase !== "working") return;
      var worker = state.waiting || (navigator.serviceWorker && navigator.serviceWorker.controller);
      try { if (worker) worker.postMessage({ type: "update-ping" }); } catch (err) { /* it is gone; the grace ends in Retry */ }
      stallTimer = setTimeout(function () {
        if (state.phase !== "working") return;
        noteFailure(state.failPath || "", "timeout");
        state.phase = "error";
        paint();
      }, 10000);
    }, 45000);
  }

  function requestUpdate(reg) {
    if (!reg || !reg.update) return Promise.resolve(reg || null);
    if (reg.installing || reg.waiting) return Promise.resolve(reg);
    // One check at a time. A second update() while the first script is still
    // downloading drops that worker, and the page stays on the old build.
    if (updateFlight) return updateFlight.then(function () { return reg; });
    var flight = reg.update().catch(function () { return null; }).then(function () {
      if (updateFlight === flight) updateFlight = null;
      return reg;
    });
    updateFlight = flight;
    return flight;
  }

  function waitForWorker(reg) {
    return new Promise(function (resolve) {
      var startedAt = Date.now();
      var timer = setInterval(function () {
        if (!reg) { clearInterval(timer); resolve(null); return; }
        if (reg.waiting) { clearInterval(timer); resolve(reg.waiting); return; }
        var worker = reg.installing;
        if (worker && worker.state === "redundant") { clearInterval(timer); resolve(null); return; }
        var idleFor = Date.now() - startedAt;
        var stillChecking = !!updateFlight;
        var idle = !worker && !stillChecking && idleFor > 5000;
        var cap = idleFor > 90000;
        if (idle || cap) { clearInterval(timer); resolve(reg.waiting || null); }
      }, 200);
    });
  }

  function rememberLog(clean) {
    var list = [];
    try { list = JSON.parse(readStore(localStorage, LOG_KEY) || "[]"); } catch (err) { list = []; }
    if (!Array.isArray(list)) list = [];
    var row = { t: Date.now(), url: clean.url || "", reason: clean.reason || "network" };
    var last = list.length ? list[list.length - 1] : null;
    if (last && last.url === row.url && last.reason === row.reason && Date.now() - last.t < 60000) return;
    list.push(row);
    if (list.length > 8) list = list.slice(-8);
    writeStore(localStorage, LOG_KEY, JSON.stringify(list));
  }

  function noteFailure(url, reason) {
    var clean = safeFailure({ url: url, reason: reason });
    if (!state.failureNoted) {
      state.failureNoted = true;
      state.failures += 1;
      writeStore(sessionStorage, FAIL_KEY, String(state.failures));
    }
    if (clean.url) state.failPath = clean.url;
    if (clean.reason) state.failReason = clean.reason;
    rememberLog(clean);
    if (!state.suppressAutoFallback && shouldFallback(state.failures)) fallbackReload();
  }

  function finishUpdate() {
    if (state.reloaded) return;
    state.reloaded = true;
    state.expectingController = false;
    var appliedNow = state.remoteSha || state.currentSha;
    if (appliedNow) writeStore(localStorage, APPLIED_KEY, appliedNow);
    state.failures = 0;
    state.failureNoted = false;
    state.failPath = "";
    state.failReason = "";
    try { sessionStorage.removeItem(FAIL_KEY); } catch (err) { /* the next page starts clean */ }
    clearTimeout(stallTimer);
    state.phase = "done";
    state.step = "ready";
    state.files = state.totalFiles || state.files;
    paint();
    scheduleReload();
  }

  function readControllerSha() {
    return new Promise(function (resolve) {
      var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!worker) { resolve(""); return; }
      var timer = setTimeout(function () { resolve(state.currentSha || ""); }, 800);
      function onMsg(event) {
        var data = event.data || {};
        if (data.type !== "sw-version" || !data.sha) return;
        navigator.serviceWorker.removeEventListener("message", onMsg);
        clearTimeout(timer);
        state.currentSha = String(data.sha).toLowerCase();
        state.currentBuilt = isoBuilt(data.built);
        resolve(state.currentSha);
      }
      navigator.serviceWorker.addEventListener("message", onMsg);
      try { worker.postMessage({ type: "sw-version" }); } catch (err) { resolve(""); }
    });
  }

  function applyNow(auto) {
    if (auto !== true) state.applyRetries = 0;
    var attempt = {};
    applying = attempt;
    state.pending = true;
    state.phase = "working";
    state.step = "download";
    state.forced = true;
    state.files = 0;
    state.bytes = 0;
    state.failureNoted = false;
    state.expectingController = true;
    state.reloaded = false;
    paint();
    var ready = state.reg ? Promise.resolve(state.reg) : navigator.serviceWorker.getRegistration();
    ready.then(function (reg) {
      state.reg = reg || null;
      return requestUpdate(reg);
    }).then(function (reg) {
      return waitForWorker(reg);
    }).then(function (worker) {
      if (applying !== attempt) return;
      if (worker) {
        state.waiting = worker;
        armStall();
        // Files nearby devices already hold for this version go into a cache
        // the worker reuses by hash. Bounded and skipped without peers.
        var pool = window.ViktorychPool;
        var prefill = pool && pool.prefillShell ? Promise.resolve().then(function () { return pool.prefillShell(); }).catch(function () { return 0; }) : Promise.resolve(0);
        prefill.then(function () {
          if (applying !== attempt) return;
          worker.postMessage({ type: "apply-update" });
        });
        return;
      }
      return readControllerSha().then(function (sha) {
        if (applying !== attempt) return;
        if (sha && state.remoteSha && sha === state.remoteSha) {
          finishUpdate();
          return;
        }
        throw new Error("waiting");
      });
    }).catch(function () {
      if (applying !== attempt) return;
      clearTimeout(stallTimer);
      noteFailure("", "network");
      state.phase = "error";
      paint();
    });
  }

  function scheduleReload() {
    if (reloadTimer) return;
    var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (worker) {
      try { worker.postMessage({ type: "update-reloading" }); } catch (err) { /* the worker reloads the page if this one does not */ }
    }
    reloadTimer = setTimeout(function () {
      captureState();
      location.reload();
    }, reducedMotion() ? 350 : 900);
  }

  function fallbackReload() {
    if (state.suppressAutoFallback) return;
    if (readStore(sessionStorage, FALLBACK_KEY) === "1") return;
    writeStore(sessionStorage, FALLBACK_KEY, "1");
    state.expectingController = false;
    applying = null;
    var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (worker) {
      try { worker.postMessage({ type: "serve-network-once" }); } catch (err) { /* the reload query asks for the network too */ }
    }
    hardReload();
  }

  function resetAppData() {
    try { localStorage.clear(); } catch (err) { /* private mode */ }
    try { sessionStorage.clear(); } catch (err) { /* private mode */ }
    var jobs = [];
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all((regs || []).map(function (reg) { return reg.unregister(); }));
      }));
    }
    if (window.caches && caches.keys) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) { return caches.delete(key); }));
      }));
    }
    if (window.indexedDB && indexedDB.databases) {
      jobs.push(indexedDB.databases().then(function (dbs) {
        return Promise.all((dbs || []).map(function (db) {
          return new Promise(function (resolve) {
            if (!db || !db.name) { resolve(); return; }
            var req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
          });
        }));
      }).catch(function () {}));
    }
    Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }

  function onWorkerMessage(data) {
    data = data || {};
    if (data.type === "sw-version" && data.sha) {
      state.currentSha = String(data.sha).toLowerCase();
      state.currentBuilt = isoBuilt(data.built);
      if (!(state.waiting && state.pending)) {
        if (remotePending()) state.pending = true;
        else if (state.phase === "offer") state.pending = false;
      }
      paint();
      return;
    }
    if (data.type === "reload-when-idle") {
      offer();
      return;
    }
    if (data.type === "update-ready") {
      if (data.sha) state.currentSha = String(data.sha).toLowerCase();
      if (data.built) state.currentBuilt = isoBuilt(data.built);
      if (state.expectingController || state.phase === "working" || state.phase === "done") finishUpdate();
      return;
    }
    if (data.type === "shell-ready" || data.type === "shell-pending") {
      var from = String(data.sha || "").toLowerCase();
      if (!from || from === state.currentSha) return;
      onPredownload(data);
      return;
    }
    if (data.type !== "update-progress") return;
    if (state.phase !== "working" && state.phase !== "error") return;
    if (typeof data.files === "number") state.files = data.files;
    if (typeof data.totalFiles === "number") state.totalFiles = data.totalFiles;
    if (typeof data.bytes === "number") state.bytes = data.bytes;
    if (typeof data.totalBytes === "number") state.totalBytes = data.totalBytes;
    if (data.step === "error" && data.reason === "newer" && state.newerHops < 2) {
      // A deploy landed while this one downloaded. Fetch the newest worker
      // and continue with it instead of mixing builds or showing an error.
      state.newerHops += 1;
      clearTimeout(stallTimer);
      state.waiting = null;
      var reg = state.reg;
      (reg && reg.update ? reg.update().catch(function () {}) : Promise.resolve()).then(function () {
        return new Promise(function (resolve) {
          var since = Date.now();
          var poll = setInterval(function () {
            if (!reg || !reg.installing || Date.now() - since > 60000) { clearInterval(poll); resolve(); }
          }, 300);
        });
      }).then(function () { applyNow(true); });
      return;
    }
    if (data.step === "error" && state.phase === "working" && data.reason !== "quota" && state.applyRetries < 2) {
      // Try again on its own before showing anything; files already saved
      // are kept, so this usually finishes at once.
      state.applyRetries += 1;
      clearTimeout(stallTimer);
      setTimeout(function () { if (state.phase === "working") applyNow(true); }, 1500 * state.applyRetries);
      return;
    }
    if (data.step === "error") {
      clearTimeout(stallTimer);
      noteFailure(data.url, data.reason);
      state.phase = "error";
    } else {
      state.phase = "working";
      state.step = data.step || state.step;
      armStall();
    }
    paint();
  }

  function askVersion() {
    var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!worker) return;
    try { worker.postMessage({ type: "sw-version" }); } catch (err) { /* the worker is waking up */ }
  }

  function maybePrime(reg) {
    if (!reg || (navigator.serviceWorker && navigator.serviceWorker.controller)) return;
    var worker = reg.waiting || reg.installing;
    if (!worker) return;
    try { worker.postMessage({ type: "prime" }); } catch (err) { /* the first visit still loads from the network */ }
  }

  function track(worker) {
    if (!worker || worker._updTracked) return;
    worker._updTracked = true;
    worker.addEventListener("statechange", function () {
      if (worker.state !== "installed") return;
      var controller = navigator.serviceWorker.controller;
      if (controller && controller !== worker) {
        considerWaiting(worker);
      } else if (!controller) maybePrime(state.reg);
    });
  }

  function watch(reg) {
    if (!reg) return;
    state.reg = reg;
    if (!reg._updWatch) {
      reg._updWatch = true;
      reg.addEventListener("updatefound", function () { track(reg.installing); });
    }
    if (reg.installing) track(reg.installing);
    if (reg.waiting && navigator.serviceWorker.controller) {
      considerWaiting(reg.waiting);
    }
    maybePrime(reg);
    askVersion();
    paint();
  }

  /* Several open tabs share one version check per round. */
  function claimCheck(now) {
    try {
      var last = Number(localStorage.getItem("viktorych-poll-version")) || 0;
      if (now >= last && now - last < CHECK_MS * 0.8) return false;
      localStorage.setItem("viktorych-poll-version", String(now));
    } catch (err) { /* no storage: check anyway */ }
    return true;
  }

  function checkRemote() {
    if (checking || typeof fetch !== "function") return;
    checking = true;
    fetch("version.json?t=" + Date.now(), { cache: "no-store", credentials: "same-origin" }).then(function (res) {
      if (!res || !res.ok) throw new Error("version");
      return res.json();
    }).then(function (doc) {
      var sha = String(doc && doc.sha || "").toLowerCase();
      if (!/^[0-9a-f]{7,64}$/.test(sha)) return;
      state.remoteSha = sha;
      state.remoteBuilt = isoBuilt(doc && doc.built);
      state.notes = notesOf(doc);
      state.short = String((doc && doc.short) || sha.slice(0, 7));
      if (remotePending()) state.pending = true;
      paint();
    }).catch(function () { /* offline keeps the copy that is already open */ }).then(function () {
      checking = false;
      if (applying) return;
      requestUpdate(state.reg).then(function (reg) {
        // version.json can be newer than the sw.js the CDN still hands out
        // for a few minutes. Offering then ended in an error, so the offer
        // waits for the new worker and its files; each check asks again.
        return reg;
      });
    });
  }

  function controlOf(el) {
    if (!el || (el.closest && el.closest("#upd-root"))) return null;
    var tag = el.tagName;
    var type = String((el.getAttribute && el.getAttribute("type")) || "").toLowerCase();
    var ce = !!el.isContentEditable;
    if (tag !== "TEXTAREA" && tag !== "INPUT" && !ce) return null;
    if (tag === "INPUT" && type && ["text", "search", "url", "email", "tel"].indexOf(type) < 0) return null;
    return {
      id: el.id || "",
      name: (el.getAttribute && el.getAttribute("name")) || "",
      field: (el.getAttribute && el.getAttribute("data-field")) || "",
      ce: ce,
      type: type,
      value: ce ? String(el.innerText || "") : String(el.value || "")
    };
  }

  function captureState() {
    var nodes = document.querySelectorAll("textarea, input, [contenteditable='true']");
    var plain = [];
    var i;
    for (i = 0; i < nodes.length; i++) {
      var row = controlOf(nodes[i]);
      if (row) plain.push(row);
    }
    var payload = {
      hash: location.hash || "",
      y: window.scrollY || document.documentElement.scrollTop || 0,
      fields: fieldSnapshot(plain),
      at: Date.now()
    };
    var raw = JSON.stringify(payload);
    writeStore(sessionStorage, RESTORE_KEY, raw);
    writeStore(localStorage, RESTORE_KEY, raw);
    writeStore(sessionStorage, RELOAD_KEY, "1");
    return payload;
  }

  function readRestore() {
    var raw = readStore(sessionStorage, RESTORE_KEY) || readStore(localStorage, RESTORE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (err) { return null; }
  }

  function clearRestore() {
    try { sessionStorage.removeItem(RESTORE_KEY); } catch (err) { /* already gone */ }
    try { localStorage.removeItem(RESTORE_KEY); } catch (err) { /* already gone */ }
  }

  function stripReloadParam() {
    try {
      var url = new URL(location.href);
      if (!url.searchParams.has("vapp")) return;
      url.searchParams.delete("vapp");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    } catch (err) { /* the extra query expires with the next navigation */ }
  }

  function restoreRouteEarly() {
    stripReloadParam();
    var data = readRestore();
    if (!restoreFresh(data, Date.now())) {
      if (data) clearRestore();
      return;
    }
    pendingRestore = data;
    if (data.hash && data.hash !== location.hash) {
      try { location.hash = data.hash; } catch (err) { /* the next paint still scrolls */ }
    }
  }

  function findField(spec) {
    if (spec.id) {
      var byId = document.getElementById(spec.id);
      if (byId) return byId;
    }
    if (spec.field) {
      var marked = document.querySelectorAll("[data-field]");
      var i;
      for (i = 0; i < marked.length; i++) {
        if (marked[i].getAttribute("data-field") === spec.field) return marked[i];
      }
    }
    if (spec.name && document.getElementsByName) {
      var named = document.getElementsByName(spec.name);
      if (named && named[0]) return named[0];
    }
    return null;
  }

  function applyRestore(data) {
    if (!data) return;
    if (!userScrolled && typeof data.y === "number") window.scrollTo(0, data.y);
    var fields = data.fields || [];
    var i;
    for (i = 0; i < fields.length; i++) {
      var spec = fields[i];
      var el = findField(spec);
      if (!el) continue;
      var current = spec.ce ? String(el.innerText || "") : String(el.value || "");
      if (current) continue;
      if (spec.ce) el.textContent = spec.value;
      else el.value = spec.value;
      try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (err) { /* the text is still in the field */ }
    }
  }

  function hardReload() {
    captureState();
    state.expectingController = false;
    var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (worker) {
      try { worker.postMessage({ type: "serve-network-once" }); } catch (err) { /* the query string asks for the network copy */ }
    }
    try {
      var url = new URL(location.href);
      url.searchParams.set("vapp", String(Date.now()));
      location.replace(url.toString());
    } catch (err) {
      location.reload();
    }
  }

  function holdsReload() {
    return state.phase === "working" || state.phase === "done" || !!reloadTimer;
  }

  function poke() {
    if (document.visibilityState === "hidden") return;
    if (state.waiting && state.pending && !state.ready && !state.preBusy && !applying) predownload(state.waiting);
    checkRemote();
    refreshBusy();
  }

  function start() {
    if (started || typeof document === "undefined") return;
    started = true;
    restoreRouteEarly();
    loadSnooze();
    state.failures = Number(readStore(sessionStorage, FAIL_KEY)) || 0;
    if (readStore(sessionStorage, FALLBACK_KEY) === "1") {
      state.suppressAutoFallback = true;
      try { sessionStorage.removeItem(FALLBACK_KEY); } catch (err) { /* one fallback reload already happened */ }
    }
    var saved = pendingRestore;
    if (saved) {
      var stops = ["wheel", "touchmove", "keydown"];
      var stop = function () { userScrolled = true; };
      stops.forEach(function (name) { window.addEventListener(name, stop, { passive: true, once: true }); });
      [80, 300, 800, 1500, 2500].forEach(function (delay) {
        setTimeout(function () { applyRestore(saved); }, delay);
      });
      setTimeout(clearRestore, 8000);
    }
    document.addEventListener("visibilitychange", poke);
    document.addEventListener("focusin", refreshBusy);
    document.addEventListener("focusout", function () { setTimeout(refreshBusy, 180); });
    document.addEventListener("play", refreshBusy, true);
    document.addEventListener("pause", refreshBusy, true);
    document.addEventListener("ended", refreshBusy, true);
    setInterval(refreshBusy, 1500);
    setInterval(function () {
      if (document.visibilityState !== "hidden" && claimCheck(Date.now())) checkRemote();
    }, CHECK_MS);
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", function (event) { onWorkerMessage(event.data || {}); });
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      askVersion();
      if (state.expectingController) finishUpdate();
    });
    var attach = function (reg) { if (reg) watch(reg); };
    navigator.serviceWorker.getRegistration().then(attach).catch(function () {});
    navigator.serviceWorker.ready.then(attach).catch(function () {});
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { paint(); poke(); });
    } else {
      paint();
      poke();
    }
  }

  return {
    SNOOZE_MS: SNOOZE_MS,
    CHECK_MS: CHECK_MS,
    shaFromVersion: shaFromVersion,
    notesOf: notesOf,
    decide: decide,
    predownloadDelay: predownloadDelay,
    progressRatio: progressRatio,
    formatBytes: formatBytes,
    fieldSnapshot: fieldSnapshot,
    restoreFresh: restoreFresh,
    start: start,
    offer: offer,
    watch: watch,
    poke: poke,
    holdsReload: holdsReload,
    onWorkerMessage: onWorkerMessage,
    manifestPending: manifestPending,
    shouldOfferReset: shouldOfferReset,
    shouldFallback: shouldFallback,
    safeFailure: safeFailure
  };
});
