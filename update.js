/* Update for the installed app. A new worker downloads its files in the
   background. The running service worker build is the truth: a mismatch
   with version.json is not an update, and each build is applied and
   reloaded at most once on a device. Later means not right now. A
   downloaded update stays as a small pill until it is applied, on the next
   hide, reopen, or navigation when nothing is being composed. What's new
   is one sheet after that apply. A full-screen step is only for a critical
   update or a failed one. Drafts, the route, and the scroll position are
   written down before the reload. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychUpdate = api;
  if (typeof document !== "undefined") api.start();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var PREFIX = "viktorych-a281-";

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
  var OFFERED_KEY = "viktorychapp-update-offered";
  var RELOAD_SHA_KEY = "viktorychapp-update-reload-sha";
  var TOAST_KEY = "viktorychapp-update-toast";
  var NOTES_SEEN_KEY = "viktorychapp-notes-seen";
  var LAST_BUILD_KEY = "viktorychapp-wn-last";
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
    if (s.silent && (s.phase === "working" || s.phase === "done")) return "idle";
    if (s.phase === "working" || s.phase === "done" || s.phase === "error") return "overlay";
    // The new version is still downloading in the background.
    if (s.ready === false) return "idle";
    // Downloaded and waiting. Later does not skip it, so the pill stays.
    if (s.ready === true && s.phase === "offer" && !s.critical && !s.forced) return "pill";
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

  /* version.json only counts as a newer published build when its time is
     strictly newer. Equal, older, or unknown times stay idle. A file that
     lags the running service worker is not an update. */
  function manifestPending(remoteSha, currentSha, remoteBuilt, currentBuilt, appliedSha) {
    if (!remoteSha || !currentSha || remoteSha === currentSha) return false;
    if (appliedSha && remoteSha === appliedSha) return false;
    var remote = isoBuilt(remoteBuilt);
    var local = isoBuilt(currentBuilt);
    if (!remote || !local) return false;
    return remote > local;
  }

  function normSha(value) {
    var sha = String(value || "").trim().toLowerCase();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : "";
  }

  /* The running service worker is the only build that can open an update.
     version.json lagging or merely differing from that worker never does.
     A waiting worker is a real update once, unless it is only the stale
     version.json sha (that would reload back and forth). */
  function offerMismatch(controllerSha, remoteSha, waitingSha, appliedSha, remoteBuilt, currentBuilt) {
    var controller = normSha(controllerSha);
    var remote = normSha(remoteSha);
    var waiting = normSha(waitingSha);
    var applied = normSha(appliedSha);
    if (applied && waiting && waiting === applied) return false;
    if (!controller || !waiting || waiting === controller) return false;
    if (remote && waiting === remote) {
      var remoteTime = isoBuilt(remoteBuilt);
      var localTime = isoBuilt(currentBuilt);
      if (!remoteTime || !localTime || remoteTime <= localTime) return false;
    }
    return true;
  }

  /* One reload per build. Either store remembering the sha blocks another. */
  function reloadAllowed(sha, sessionSha, localSha) {
    var target = normSha(sha);
    if (!target) return false;
    if (normSha(sessionSha) === target || normSha(localSha) === target) return false;
    return true;
  }

  /* version.json names a different build than the service worker that is
     running. That difference is not an update and must not reload the page. */
  function versionMismatch(remoteSha, controllerSha) {
    var remote = normSha(remoteSha);
    var controller = normSha(controllerSha);
    return !!(remote && controller && remote !== controller);
  }

  /* A version.json older than the running worker, or one with no build time,
     must not reload that worker. A newer manifest can still ship a new build. */
  function staleManifest(remoteSha, controllerSha, remoteBuilt, currentBuilt) {
    if (!versionMismatch(remoteSha, controllerSha)) return false;
    var remoteTime = isoBuilt(remoteBuilt);
    var localTime = isoBuilt(currentBuilt);
    if (!remoteTime || !localTime) return true;
    return remoteTime <= localTime;
  }

  /* True when a reload would repeat this service-worker build, or would
     reload it only because version.json is older. */
  function blocksReload(remoteSha, controllerSha, buildId, sessionBuild, localBuild, remoteBuilt, currentBuilt) {
    var build = normSha(buildId);
    var controller = normSha(controllerSha);
    if (!build) return true;
    if (build === controller && staleManifest(remoteSha, controller, remoteBuilt, currentBuilt)) return true;
    return !reloadAllowed(build, sessionBuild, localBuild);
  }

  /* A What's new sheet is shown once per build. seen is the list already shown. */
  function shouldShowNotes(sha, seen) {
    var target = normSha(sha);
    if (!target) return false;
    var list = seen || [];
    var i;
    for (i = 0; i < list.length; i++) if (normSha(list[i]) === target) return false;
    return true;
  }

  function seenNotes() {
    var list = [];
    try { list = JSON.parse(readStore(localStorage, NOTES_SEEN_KEY) || "[]"); } catch (err) { list = []; }
    if (!Array.isArray(list)) return [];
    var out = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var sha = normSha(list[i]);
      if (sha && out.indexOf(sha) < 0) out.push(sha);
    }
    return out;
  }

  function markNotesSeen(sha) {
    sha = normSha(sha);
    if (!sha || !shouldShowNotes(sha, seenNotes())) return;
    var list = seenNotes();
    list.push(sha);
    if (list.length > 12) list = list.slice(-12);
    writeStore(localStorage, NOTES_SEEN_KEY, JSON.stringify(list));
  }

  /* Full screen only for a critical offer, a forced one, or a failure.
     A downloaded update stays a pill until that build is applied. */
  function presentation(s, now) {
    var mode = decide(s, now);
    if (mode !== "overlay") return mode;
    if (s && s.phase === "offer" && !s.critical && !s.forced) return "toast";
    return "blocking";
  }

  /* Visible updates (switch update_notice). The small status toast: "updating"
     while the new build downloads or applies, "" otherwise. The ready state
     is the pill, which then reads "Update ready, tap to restart". The full
     screen look (a critical or failed update) has its own screen. */
  /* The background download is quiet (the pill says when it is ready), and
     the toast never stays longer than TOAST_MAX_MS: past that the update goes
     on unseen and the page reloads itself when the new build is in charge. */
  var TOAST_MAX_MS = 4000;
  function statusKind(s, look, now) {
    if (!s || look === "blocking" || s.phase === "error" || s.critical) return "";
    if (s.phase !== "working" && s.phase !== "done") return "";
    if (s.workingSince && (now || Date.now()) - s.workingSince > TOAST_MAX_MS) return "";
    return "updating";
  }

  /* One simple icon per changelog line, picked from its words. */
  function noteIcon(text) {
    var t = String(text || "").toLowerCase();
    if (/\b(fix|fixed|fixes|bug|repair|no longer|stays?|stable|crash|broken)\b/.test(t)) return "fix";
    if (/\b(fast|faster|speed|smooth|smoother|quick|lighter|load|loads|loading|seamless)\b/.test(t)) return "fast";
    if (/\b(look|looks|icon|icons|tab|tabs|header|theme|design|style|layout|screen)\b/.test(t)) return "look";
    return "new";
  }

  function appliedSha() {
    try { return normSha(localStorage.getItem(APPLIED_KEY)); } catch (err) { return ""; }
  }

  function offeredList() {
    var list = [];
    try { list = JSON.parse(readStore(localStorage, OFFERED_KEY) || "[]"); } catch (err) { list = []; }
    if (!Array.isArray(list)) return [];
    var out = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var sha = normSha(list[i]);
      if (sha && out.indexOf(sha) < 0) out.push(sha);
    }
    return out;
  }

  function hasOffered(sha) {
    sha = normSha(sha);
    return !!sha && offeredList().indexOf(sha) >= 0;
  }

  function rememberOffer(sha) {
    sha = normSha(sha);
    if (!sha || hasOffered(sha)) return;
    var list = offeredList();
    list.push(sha);
    if (list.length > 12) list = list.slice(-12);
    writeStore(localStorage, OFFERED_KEY, JSON.stringify(list));
  }

  function storedReloadSha(store) {
    return normSha(readStore(store, RELOAD_SHA_KEY));
  }

  function reloadSpent(sha) {
    return !reloadAllowed(sha, storedReloadSha(sessionStorage), storedReloadSha(localStorage));
  }

  function markReload(sha) {
    sha = normSha(sha);
    if (!reloadAllowed(sha, storedReloadSha(sessionStorage), storedReloadSha(localStorage))) return false;
    writeStore(sessionStorage, RELOAD_SHA_KEY, sha);
    writeStore(localStorage, RELOAD_SHA_KEY, sha);
    return true;
  }

  /* Background download wait: 15s, 30s, 1m, 2m, then every 5 minutes. */
  function predownloadDelay(tries) {
    var n = Math.max(0, Number(tries) || 0);
    return Math.min(5 * 60 * 1000, 15000 * Math.pow(2, Math.min(n, 5)));
  }

  /* A waiting worker is an update only when its build differs from the one
     already running, and this device has not applied or reloaded it. Silence,
     and a version.json sha that does not match that worker, stay idle. */
  function reviewWaiting(sha) {
    sha = normSha(sha || state.heardSha);
    if (sha) state.heardSha = sha;
    sha = normSha(state.heardSha);
    var controller = normSha(state.currentSha);
    if (!sha || !controller || !state.waiting) return;
    if (staleManifest(state.remoteSha, controller, state.remoteBuilt, state.currentBuilt)) {
      state.pending = false;
      paint();
      return;
    }
    var fresh = offerMismatch(controller, state.remoteSha, sha, appliedSha(), state.remoteBuilt, state.currentBuilt) && !reloadSpent(sha);
    if (!fresh) {
      if (!applying && state.phase === "offer") {
        state.pending = false;
        paint();
      }
      return;
    }
    var again = state.pending && state.pendingSha === sha;
    state.pendingSha = sha;
    state.pending = true;
    if (!again) state.quiet = hasOffered(sha);
    if (state.remoteSha && state.remoteSha !== sha) state.critical = false;
    predownload(state.waiting);
    paint();
    // A build already seen still waits for hide, reopen, or navigation.
    if (state.quiet && state.ready && document.visibilityState === "hidden") maybeSilentApply();
  }

  function considerWaiting(worker) {
    if (!worker) return;
    state.waiting = worker;
    try {
      var channel = new MessageChannel();
      channel.port1.onmessage = function (event) { reviewWaiting(event.data && event.data.sha); };
      worker.postMessage({ type: "sw-version" }, [channel.port2]);
    } catch (err) { /* no answer: leave the open copy alone */ }
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
    pendingSha: "",
    heardSha: "",
    quiet: false,
    critical: false,
    silent: false,
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

  /* An open composer or modal, or text the person has typed, must keep the
     update from applying or putting its sheet on screen. The apply waits
     until that closes. */
  function shouldDeferApply(flags) {
    return !!(flags && (flags.modal || flags.typed));
  }

  function composerOpen() {
    if (typeof document === "undefined" || !document.querySelector) return false;
    var nodes = document.querySelectorAll(".xc-modal, .modal-back, .modal, [role='dialog'], [role='alertdialog']");
    var i;
    for (i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || el.hidden) continue;
      if (el.id === "upd-notes-sheet" || el.id === "upd-overlay" || el.id === "upd-root") continue;
      if (el.closest && (el.closest("#upd-root") || el.closest("#upd-notes-sheet"))) continue;
      return true;
    }
    return false;
  }

  function typedText() {
    if (typeof document === "undefined" || !document.querySelectorAll) return false;
    var nodes = document.querySelectorAll("textarea, input, [contenteditable='true']");
    var i;
    for (i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el || (el.closest && (el.closest("#upd-root") || el.closest("#upd-notes-sheet")))) continue;
      var type = String((el.getAttribute && el.getAttribute("type")) || el.type || "").toLowerCase();
      if (el.tagName === "INPUT" && type && ["text", "search", "url", "email", "tel", "password"].indexOf(type) < 0) continue;
      var value = el.isContentEditable ? String(el.innerText || "") : String(el.value || "");
      if (value.trim()) return true;
    }
    return false;
  }

  function updateBlocked() {
    // A tap on "tap to restart" is the person's go-ahead; drafts are saved
    // by captureState and put back after the reload.
    if (state.userGo) return false;
    return shouldDeferApply({ modal: composerOpen(), typed: typedText() });
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
    var statusEl = document.createElement("div");
    statusEl.id = "upd-status";
    statusEl.className = "upd-status";
    statusEl.hidden = true;
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    statusEl.innerHTML = '<span class="upd-spin" aria-hidden="true"></span><span id="upd-status-text"></span>';
    document.body.appendChild(statusEl);
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
      if (state.ready && state.pending && state.phase === "offer") {
        if (visibleOn()) tapRestart();
        else applyNow(false);
        return;
      }
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
      if (event.key !== "Escape" || mode() !== "overlay" || state.phase !== "offer" || updateBlocked()) return;
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
      status: statusEl,
      statusText: statusEl.querySelector("#upd-status-text"),
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
    var look = presentation(state, Date.now());
    if (state.quiet && look === "toast") look = "idle";
    if (staleManifest(state.remoteSha, state.currentSha, state.remoteBuilt, state.currentBuilt)) look = "idle";
    if (updateBlocked() && look !== "idle" && look !== "pill") {
      if (state.ready && state.pending) state.deferApply = true;
      look = "idle";
    }
    var reduce = reducedMotion();
    box.root.hidden = look === "idle";
    box.root.classList.toggle("upd-reduce", reduce);
    box.root.setAttribute("data-phase", state.phase);
    document.body.classList.toggle("upd-open", look === "blocking");
    box.pill.hidden = look !== "pill";
    box.overlay.hidden = look !== "toast" && look !== "blocking";
    box.overlay.classList.toggle("upd-toast", look === "toast");
    box.overlay.setAttribute("aria-modal", look === "blocking" ? "true" : "false");
    var visible = visibleOn();
    box.pill.textContent = (state.ready && state.phase === "offer")
      ? (visible ? tr("Update ready, tap to restart") : tr("Update ready · Tap to refresh"))
      : tr("App update");
    var now = Date.now();
    if (state.phase === "working" || state.phase === "done") {
      if (!state.workingSince) {
        state.workingSince = now;
        setTimeout(paint, TOAST_MAX_MS + 50);
      }
    } else state.workingSince = 0;
    var kind = visible ? statusKind(state, look, now) : "";
    box.status.hidden = !kind;
    box.statusText.textContent = kind ? tr("Updating ViktorychApp…") : "";
    box.status.classList.toggle("upd-reduce", reduce);
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
    var showNotes = look !== "pill" && state.phase === "offer" && state.notes.length > 0;
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
    if (look === "blocking" && !box.go.hidden) {
      var active = document.activeElement;
      if (!active || active === box.pill || !box.root.contains(active)) {
        try { box.go.focus(); } catch (err) { /* the button is still clickable */ }
      }
    }
  }

  /* Later is "not right now". The build stays pending and the pill stays. */
  function snooze() {
    state.snoozeUntil = Date.now() + SNOOZE_MS;
    state.forced = false;
    state.quiet = false;
    if (state.phase !== "error") state.phase = "offer";
    writeStore(localStorage, SNOOZE_KEY, String(state.snoozeUntil));
    paint();
  }

  function offer() {
    if (staleManifest(state.remoteSha, state.currentSha, state.remoteBuilt, state.currentBuilt)) return;
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
    if (visibleOn()) paint();
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
      if (state.quiet && document.visibilityState === "hidden") maybeSilentApply();
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

  /* The worker can be waiting before this page listens for
     controllerchange, and one skipWaiting can be lost while the old worker
     is busy. Keep asking the waiting worker to take over, and finish if the
     controller is already the new build. */
  function watchActivation(attempt) {
    var ticks = 0;
    var timer = setInterval(function () {
      if (applying !== attempt || state.reloaded || (state.phase !== "working" && state.phase !== "error")) {
        clearInterval(timer);
        return;
      }
      ticks += 1;
      if (ticks > 40) { clearInterval(timer); return; }
      var lookup = navigator.serviceWorker && navigator.serviceWorker.getRegistration ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
      lookup.then(function (reg) {
        if (applying !== attempt || !reg) return null;
        state.reg = reg;
        if (reg.waiting) {
          state.waiting = reg.waiting;
          try { reg.waiting.postMessage({ type: "skip-waiting" }); } catch (err) { /* the next tick asks again */ }
        }
        return readControllerSha();
      }).then(function (sha) {
        if (applying !== attempt || !sha || !state.remoteSha) return;
        if (sha === state.remoteSha) {
          clearInterval(timer);
          finishUpdate();
        }
      }).catch(function () {});
    }, 3000);
  }

  function finishUpdate(sha) {
    if (state.reloaded) return;
    sha = normSha(sha) || normSha(state.pendingSha) || normSha(state.currentSha);
    if (sha) state.pendingSha = sha;
    state.reloaded = true;
    state.expectingController = false;
    var appliedNow = sha || normSha(state.currentSha);
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

  function maybeSilentApply() {
    if (applying || state.reloaded || state.critical) return;
    if (!state.ready || !state.pending || state.phase === "error" || state.phase === "working") return;
    if (updateBlocked()) { state.deferApply = true; return; }
    if (staleManifest(state.remoteSha, state.currentSha, state.remoteBuilt, state.currentBuilt)) return;
    var sha = normSha(state.pendingSha);
    if (!sha || sha === normSha(state.currentSha) || reloadSpent(sha)) return;
    state.deferApply = false;
    state.silent = true;
    applyNow(true);
  }

  /* Quiet updates (switch auto_update): a downloaded update also applies
     once it has been ready for 20 seconds without a touch, key or scroll, with the same one-reload
     guard and the same blocks (typing, a playing video, an open composer). */
  var IDLE_APPLY_MS = 20000;
  var lastInput = Date.now();
  function autoUpdateOn() {
    try {
      var off = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
      return !(Array.isArray(off) && off.indexOf("auto_update") >= 0);
    } catch (err) { return true; }
  }
  function visibleOn() {
    try {
      var off = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
      return !(Array.isArray(off) && off.indexOf("update_notice") >= 0);
    } catch (err) { return true; }
  }
  var readySince = 0;
  function idleApply(now) {
    // The 20 seconds start when the update is ready, so the pill is seen first.
    if (!state.ready || !state.pending) { readySince = 0; return; }
    if (!readySince) readySince = now;
    if (!autoUpdateOn() || document.visibilityState === "hidden") return;
    if (now - Math.max(lastInput, readySince) < IDLE_APPLY_MS) return;
    maybeSilentApply();
  }

  /* "Update ready, tap to restart": one quick apply and reload with the small
     Updating toast instead of the full progress screen. */
  function tapRestart() {
    state.userGo = true;
    state.applyRetries = 0;
    state.forced = false;
    state.deferApply = false;
    state.silent = true;
    applyNow(true);
  }

  function applyNow(auto) {
    if (updateBlocked()) { state.deferApply = true; return; }
    if (auto !== true) {
      state.applyRetries = 0;
      state.silent = false;
    }
    if (state.pendingSha) rememberOffer(state.pendingSha);
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
        watchActivation(attempt);
        // Files nearby devices already hold for this version go into a cache
        // the worker reuses by hash. Bounded and skipped without peers.
        var pool = window.ViktorychPool;
        var prefill = pool && pool.prefillShell ? Promise.resolve().then(function () { return pool.prefillShell(); }).catch(function () { return 0; }) : Promise.resolve(0);
        prefill.then(function () {
          if (applying !== attempt) return;
          try { worker.postMessage({ type: "apply-update" }); } catch (err) { /* watchActivation asks again */ }
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

  function queueUpdatedToast(sha) {
    var notes = state.notes || [];
    writeStore(sessionStorage, TOAST_KEY, JSON.stringify({ sha: normSha(sha), notes: notes.slice(0, 8) }));
  }

  function releaseLines(notes) {
    var lines = [];
    var i;
    for (i = 0; i < (notes || []).length && lines.length < 8; i++) {
      var text = String(notes[i] || "").replace(/\s+/g, " ").trim();
      if (text) lines.push(text);
    }
    return lines;
  }

  /* After the new build is applied. One sheet per sha: a bottom sheet on a
     phone and a centered card on a desktop. Got it dismisses it. The page
     underneath stays usable. */
  function showReleaseNotes(sha, notes) {
    sha = normSha(sha);
    if (!shouldShowNotes(sha, seenNotes())) return false;
    if (typeof document === "undefined" || !document.body) return false;
    if (updateBlocked()) {
      state.deferNotes = { sha: sha, notes: notes || [] };
      return false;
    }
    state.deferNotes = null;
    markNotesSeen(sha);
    var previous = document.getElementById("upd-notes-sheet");
    if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
    var lines = releaseLines(notes);
    if (visibleOn()) return showWhatsNewPage(sha, lines);
    var root = document.createElement("div");
    root.id = "upd-notes-sheet";
    root.className = "upd-notes-sheet";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "false");
    root.setAttribute("aria-labelledby", "upd-notes-sheet-title");
    var card = document.createElement("div");
    card.className = "upd-sheet-card";
    var title = document.createElement("h2");
    title.id = "upd-notes-sheet-title";
    title.className = "upd-sheet-title";
    title.textContent = tr("What's new");
    card.appendChild(title);
    if (lines.length) {
      var list = document.createElement("ul");
      list.className = "upd-sheet-list";
      var n;
      for (n = 0; n < lines.length; n++) {
        var item = document.createElement("li");
        item.textContent = lines[n];
        list.appendChild(item);
      }
      card.appendChild(list);
    }
    var go = document.createElement("button");
    go.type = "button";
    go.id = "upd-gotit";
    go.className = "upd-sheet-go";
    go.textContent = tr("Got it");
    card.appendChild(go);
    root.appendChild(card);
    function closeSheet() {
      document.removeEventListener("keydown", onKey, true);
      if (root.parentNode) root.parentNode.removeChild(root);
    }
    function onKey(event) {
      if (event.key !== "Escape" || !root.parentNode) return;
      if (document.body.classList.contains("upd-open")) return;
      event.preventDefault();
      closeSheet();
    }
    go.addEventListener("click", closeSheet);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(root);
    return true;
  }

  var NOTE_ICONS = {
    fix: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-5 5a1.4 1.4 0 0 0 2 2l5-5a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2z"/>',
    fast: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
    look: '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 9.5h17"/>',
    new: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5"/>'
  };

  /* What's new as a full screen, edge to edge, dark page: our logo, one card
     per changelog line, one Continue button. Swipe or close dismisses it.
     The animations are CSS only and off with reduced motion. */
  function showWhatsNewPage(sha, lines) {
    if (!lines.length) lines = [tr("Fixes and improvements")];
    var root = document.createElement("div");
    root.id = "upd-notes-sheet";
    root.className = "upd-wn";
    if (reducedMotion()) root.classList.add("upd-reduce");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "upd-notes-sheet-title");
    var close = document.createElement("button");
    close.type = "button";
    close.className = "upd-wn-x";
    close.setAttribute("aria-label", tr("Close"));
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    root.appendChild(close);
    var body = document.createElement("div");
    body.className = "upd-wn-body";
    var logo = document.createElement("img");
    logo.className = "upd-wn-logo";
    logo.src = "icons/icon-192.png";
    logo.alt = tr("ViktorychApp");
    logo.width = 64;
    logo.height = 64;
    body.appendChild(logo);
    var title = document.createElement("h2");
    title.id = "upd-notes-sheet-title";
    title.className = "upd-wn-title";
    title.textContent = tr("What's new");
    body.appendChild(title);
    if (sha) {
      var ver = document.createElement("p");
      ver.className = "upd-wn-ver";
      ver.textContent = tr("Version {version}", { version: sha.slice(0, 7) });
      body.appendChild(ver);
    }
    var list = document.createElement("ul");
    list.className = "upd-wn-cards";
    var n;
    for (n = 0; n < lines.length; n++) {
      var item = document.createElement("li");
      item.className = "upd-wn-card";
      item.style.setProperty("--i", String(n));
      var kind = noteIcon(lines[n]);
      item.setAttribute("data-icon", kind);
      var ic = document.createElement("span");
      ic.className = "upd-wn-ic";
      ic.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + NOTE_ICONS[kind] + '</svg>';
      var text = document.createElement("span");
      text.className = "upd-wn-text";
      text.textContent = lines[n];
      item.appendChild(ic);
      item.appendChild(text);
      list.appendChild(item);
    }
    body.appendChild(list);
    root.appendChild(body);
    var foot = document.createElement("div");
    foot.className = "upd-wn-foot";
    var go = document.createElement("button");
    go.type = "button";
    go.id = "upd-gotit";
    go.className = "upd-wn-go";
    go.textContent = tr("Continue");
    foot.appendChild(go);
    root.appendChild(foot);
    var sx = 0;
    var sy = 0;
    var tracking = false;
    function closePage() {
      document.removeEventListener("keydown", onKey, true);
      document.documentElement.classList.remove("upd-wn-open");
      if (root.parentNode) root.parentNode.removeChild(root);
    }
    function onKey(event) {
      if (event.key !== "Escape" || !root.parentNode) return;
      event.preventDefault();
      closePage();
    }
    root.addEventListener("touchstart", function (event) {
      var t = event.touches && event.touches[0];
      if (!t) return;
      tracking = true;
      sx = t.clientX;
      sy = t.clientY;
    }, { passive: true });
    root.addEventListener("touchend", function (event) {
      if (!tracking) return;
      tracking = false;
      var t = event.changedTouches && event.changedTouches[0];
      if (!t) return;
      var dx = t.clientX - sx;
      var dy = t.clientY - sy;
      var atTop = body.scrollTop <= 0;
      if ((dy > 90 && atTop && Math.abs(dy) > Math.abs(dx)) || (Math.abs(dx) > 110 && Math.abs(dx) > Math.abs(dy) * 1.5)) closePage();
    }, { passive: true });
    go.addEventListener("click", closePage);
    close.addEventListener("click", closePage);
    document.addEventListener("keydown", onKey, true);
    document.documentElement.classList.add("upd-wn-open");
    document.body.appendChild(root);
    try { go.focus({ preventScroll: true }); } catch (err) { /* the button is still clickable */ }
    return true;
  }

  /* An app the system closed takes its new build on the next cold start,
     with no reload this page could note. The first time a device runs a
     build it has not seen before, What's new opens for it (never on the
     very first run). */
  var buildNoted = false;
  function noteRunningBuild(sha) {
    sha = normSha(sha);
    // Only the build this page started on; an update applied in this page
    // gets its own What's new after its reload.
    if (!sha || buildNoted || typeof document === "undefined") return;
    buildNoted = true;
    if (!visibleOn() || state.expectingController || state.phase === "working" || state.phase === "done") return;
    var last = normSha(readStore(localStorage, LAST_BUILD_KEY));
    if (last === sha) return;
    writeStore(localStorage, LAST_BUILD_KEY, sha);
    if (!last || !shouldShowNotes(sha, seenNotes())) return;
    if (typeof fetch !== "function") return;
    fetch("version.json?t=" + Date.now(), { cache: "no-store", credentials: "same-origin" }).then(function (res) {
      return res && res.ok ? res.json() : null;
    }).catch(function () { return null; }).then(function (doc) {
      var notes = doc && normSha(doc.sha) === sha ? notesOf(doc) : [];
      if (document.getElementById("upd-notes-sheet")) return;
      showReleaseNotes(sha, notes);
    });
  }

  function consumeUpdatedToast() {
    var raw = readStore(sessionStorage, TOAST_KEY);
    if (!raw) return;
    try { sessionStorage.removeItem(TOAST_KEY); } catch (err) { /* shown once */ }
    var payload = {};
    try { payload = JSON.parse(raw) || {}; } catch (err) { payload = {}; }
    var sha = normSha(payload.sha);
    var notes = payload.notes || [];
    var run = function () { showReleaseNotes(sha, notes); };
    if (document.body) run();
    else document.addEventListener("DOMContentLoaded", run);
  }

  function flushDeferredApply() {
    if (updateBlocked()) return;
    if (state.deferNotes && state.deferNotes.sha) {
      var waiting = state.deferNotes;
      state.deferNotes = null;
      showReleaseNotes(waiting.sha, waiting.notes);
    }
    if (!state.deferApply) return;
    state.deferApply = false;
    if (state.phase === "done") scheduleReload();
    else maybeSilentApply();
  }

  function scheduleReload() {
    if (reloadTimer || state.reloaded === "reloading") return;
    if (updateBlocked()) {
      state.deferApply = true;
      state.reloaded = false;
      return;
    }
    var sha = normSha(state.pendingSha) || normSha(state.currentSha);
    if (blocksReload(state.remoteSha, state.currentSha, sha, storedReloadSha(sessionStorage), storedReloadSha(localStorage), state.remoteBuilt, state.currentBuilt)) return;
    reloadTimer = setTimeout(function () {
      reloadTimer = 0;
      if (updateBlocked() || blocksReload(state.remoteSha, state.currentSha, sha, storedReloadSha(sessionStorage), storedReloadSha(localStorage), state.remoteBuilt, state.currentBuilt)) {
        state.deferApply = true;
        state.reloaded = false;
        return;
      }
      if (!markReload(sha)) return;
      queueUpdatedToast(sha);
      var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (worker) {
        try { worker.postMessage({ type: "update-reloading" }); } catch (err) { /* the worker reloads the page if this one does not */ }
      }
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
      state.currentSha = normSha(data.sha);
      state.currentBuilt = isoBuilt(data.built);
      noteRunningBuild(state.currentSha);
      if (state.waiting) reviewWaiting(state.heardSha);
      else if (state.phase === "offer" && (!state.pendingSha || state.pendingSha === state.currentSha)) state.pending = false;
      paint();
      return;
    }
    if (data.type === "reload-when-idle") {
      offer();
      return;
    }
    if (data.type === "update-ready") {
      if (data.sha) state.currentSha = normSha(data.sha);
      if (data.built) state.currentBuilt = isoBuilt(data.built);
      if (state.expectingController || state.phase === "working" || state.phase === "done") finishUpdate(data.sha);
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
      if (!doc || typeof doc !== "object") {
        if (!state.waiting && state.phase === "offer") state.pending = false;
        paint();
        return;
      }
      var sha = normSha(doc.sha);
      if (!sha) {
        if (!state.waiting && state.phase === "offer") state.pending = false;
        paint();
        return;
      }
      state.remoteSha = sha;
      state.remoteBuilt = isoBuilt(doc.built);
      state.notes = notesOf(doc);
      state.short = String(doc.short || sha.slice(0, 7));
      var waiting = normSha(state.pendingSha);
      state.critical = doc.critical === true && !!waiting && waiting === sha && offerMismatch(state.currentSha, sha, waiting, appliedSha(), state.remoteBuilt, state.currentBuilt);
      // version.json lagging or differing from the running worker is not an offer.
      if (!offerMismatch(state.currentSha, sha, waiting, appliedSha(), state.remoteBuilt, state.currentBuilt)) {
        if (state.phase === "offer") state.pending = false;
      }
      paint();
    }).catch(function () {
      if (!state.waiting && state.phase === "offer") state.pending = false;
      paint();
    }).then(function () {
      checking = false;
      if (applying) return;
      requestUpdate(state.reg).then(function (reg) {
        // version.json can lead or lag the worker that is actually running.
        // The offer waits for a waiting worker with a new build; the file
        // alone never opens one. A miss leaves the open copy alone.
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
    if (updateBlocked()) { state.deferApply = true; return; }
    var sha = normSha(state.pendingSha) || normSha(state.currentSha);
    if (blocksReload(state.remoteSha, state.currentSha, sha, storedReloadSha(sessionStorage), storedReloadSha(localStorage), state.remoteBuilt, state.currentBuilt)) return;
    if (!markReload(sha)) return;
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

  function onControllerChange() {
    askVersion();
    if (state.reloaded) return;
    if (staleManifest(state.remoteSha, state.currentSha, state.remoteBuilt, state.currentBuilt)) return;
    if (!(state.expectingController || state.phase === "working" || state.phase === "done")) return;
    if (blocksReload(state.remoteSha, state.currentSha, state.pendingSha || state.currentSha, storedReloadSha(sessionStorage), storedReloadSha(localStorage), state.remoteBuilt, state.currentBuilt)) return;
    finishUpdate();
  }

  function blocksReloadNow() {
    return blocksReload(state.remoteSha, state.currentSha, state.pendingSha || state.currentSha, storedReloadSha(sessionStorage), storedReloadSha(localStorage), state.remoteBuilt, state.currentBuilt);
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
    consumeUpdatedToast();
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
    var sawHidden = false;
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden") { sawHidden = true; maybeSilentApply(); }
      else if (sawHidden) maybeSilentApply();
      poke();
    });
    window.addEventListener("hashchange", function () { maybeSilentApply(); });
    window.addEventListener("pagehide", function () { maybeSilentApply(); });
    document.addEventListener("focusin", refreshBusy);
    document.addEventListener("focusout", function () { setTimeout(function () { refreshBusy(); flushDeferredApply(); }, 180); });
    document.addEventListener("click", function () { setTimeout(flushDeferredApply, 0); });
    document.addEventListener("play", refreshBusy, true);
    document.addEventListener("pause", refreshBusy, true);
    document.addEventListener("ended", refreshBusy, true);
    ["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach(function (name) {
      window.addEventListener(name, function () { lastInput = Date.now(); }, { passive: true, capture: true });
    });
    setInterval(function () { refreshBusy(); flushDeferredApply(); idleApply(Date.now()); }, 1500);
    setInterval(function () {
      if (document.visibilityState !== "hidden" && claimCheck(Date.now())) checkRemote();
    }, CHECK_MS);
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.addEventListener("message", function (event) { onWorkerMessage(event.data || {}); });
    navigator.serviceWorker.addEventListener("controllerchange", function () { onControllerChange(); });
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
    offerMismatch: offerMismatch,
    reloadAllowed: reloadAllowed,
    presentation: presentation,
    shouldShowNotes: shouldShowNotes,
    shouldDeferApply: shouldDeferApply,
    versionMismatch: versionMismatch,
    staleManifest: staleManifest,
    blocksReloadFor: blocksReload,
    blocksReload: blocksReloadNow,
    showReleaseNotes: showReleaseNotes,
    statusKind: statusKind,
    noteIcon: noteIcon,
    onControllerChange: onControllerChange,
    shouldOfferReset: shouldOfferReset,
    shouldFallback: shouldFallback,
    safeFailure: safeFailure
  };
});
