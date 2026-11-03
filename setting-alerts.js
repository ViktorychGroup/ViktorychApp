/* Settings alerts. A small watcher compares this device's own limits and
   settings with real usage and raises the achievement pop-out as an info,
   warning, critical or limit-reached card. Each threshold fires once per
   crossing per device and re-arms when usage drops. Every alert is also kept
   as a System item on the Notifications page. On a critical issue the app can
   open the right settings page by itself, after a 3 second countdown, never
   while someone is typing, composing, playing media, in a call or mid-gesture.
   Everything here is counted and stored on this device only. */
(function (root) {
  var PREFS_KEY = "viktorychapp-setting-alerts-v1";
  var STATE_KEY = "viktorychapp-setting-alerts-state-v1";
  var METER_KEY = "viktorychapp-data-meter-v1";
  var SCREEN_KEY = "viktorychapp-screen-time-v1";
  var SESSION_KEY = "viktorychapp-setting-alerts-session";
  var SETTINGS_KEY = "viktorychapp-settings-v1";
  var DEVICE_KEY = "viktorychapp-device-performance-v1";
  var STORAGE_POLICY_KEY = "viktorychapp-storage";
  var MB = 1024 * 1024;
  var GB = 1024 * MB;
  var LOCAL_LIMIT = 5 * MB;
  var TAB_LIMIT = 500;
  var RANK = { ok: 0, info: 1, warning: 2, critical: 3, limit: 4 };
  var DEFAULTS = { warn: 80, crit: 95, autoOpen: true, vibrate: true, sound: true, quiet: false, quietFrom: 22, quietTo: 7, screenMin: 0, off: {}, autoOff: {} };
  var CAP_STEPS = [500 * MB, 1 * GB, 2 * GB, 5 * GB, 10 * GB, 20 * GB, 50 * GB, 100 * GB];
  var WARN_STEPS = [50, 60, 70, 75, 80, 85, 90];
  var CRIT_STEPS = [85, 90, 95, 98, 99];
  var SCREEN_STEPS = [0, 30, 60, 90, 120, 180, 240];
  var COUNTDOWN_S = 3;

  function tr(key, vars) {
    var fn = root.t;
    if (typeof fn === "function") return fn(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? vars[k] : m; });
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }

  /* Icons come from the app's own set (window.ViktorychIcons): one colour,
     24px grid, X outline weight. Only names are stored, never emoji. */
  function glyph(name) {
    var I = root.ViktorychIcons;
    return I && I.svg && name ? I.svg(String(name)) : "";
  }

  function ls() { try { return root.localStorage || null; } catch (err) { return null; } }
  function ss() { try { return root.sessionStorage || null; } catch (err) { return null; } }
  function readJson(store, key, fallback) {
    try { var v = JSON.parse(store && store.getItem(key) || "null"); return v == null ? fallback : v; } catch (err) { return fallback; }
  }
  function writeJson(store, key, value) {
    try { if (store) store.setItem(key, JSON.stringify(value)); } catch (err) { /* a full store keeps the old copy */ }
  }
  function now() { return Date.now(); }

  function fmtBytes(n) {
    var st = root.ViktorychStorage;
    if (st && st.formatBytes) return st.formatBytes(n);
    n = Number(n) || 0;
    if (n >= GB) return (Math.round(n / GB * 10) / 10) + " GB";
    if (n >= MB) return Math.round(n / MB) + " MB";
    return Math.max(0, Math.round(n / 1024)) + " KB";
  }

  /* ---------- preferences ---------- */

  function prefs() {
    var saved = readJson(ls(), PREFS_KEY, {}) || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = saved[k] == null ? DEFAULTS[k] : saved[k]; });
    out.off = saved.off && typeof saved.off === "object" ? saved.off : {};
    out.autoOff = saved.autoOff && typeof saved.autoOff === "object" ? saved.autoOff : {};
    if (WARN_STEPS.indexOf(Number(out.warn)) < 0) out.warn = DEFAULTS.warn;
    if (CRIT_STEPS.indexOf(Number(out.crit)) < 0) out.crit = DEFAULTS.crit;
    if (out.crit <= out.warn) out.crit = Math.min(99, out.warn + 10);
    if (SCREEN_STEPS.indexOf(Number(out.screenMin)) < 0) out.screenMin = 0;
    out.autoOpen = out.autoOpen !== false;
    out.vibrate = out.vibrate !== false;
    out.sound = out.sound !== false;
    out.quiet = out.quiet === true;
    out.quietFrom = Math.max(0, Math.min(23, Number(out.quietFrom) || 0));
    out.quietTo = Math.max(0, Math.min(23, Number(out.quietTo) || 0));
    return out;
  }

  function setPrefs(patch) {
    var next = prefs();
    Object.keys(patch || {}).forEach(function (k) { next[k] = patch[k]; });
    writeJson(ls(), PREFS_KEY, next);
    return prefs();
  }

  function alertOn(id) { return !prefs().off[id]; }
  function autoOn(id) {
    var p = prefs();
    var def = byId(id);
    if (!p.autoOpen || !def || !def.canAuto) return false;
    if (p.autoOff[id] === true) return false;
    if (p.autoOff[id] === false) return true;
    return def.autoDefault !== false;
  }

  /* ---------- alert definitions ---------- */

  function kickerOf(level) {
    if (level === "limit") return tr("Limit reached");
    if (level === "critical") return tr("Critical");
    if (level === "warning") return tr("Warning");
    return tr("Heads up");
  }

  function fmtCount(n) {
    try { return Number(n || 0).toLocaleString(); } catch (err) { return String(n || 0); }
  }
  function pctCopy(level, v, w, c, l) {
    var row = level === "limit" ? l : level === "critical" ? c : w;
    return row;
  }

  var ALERTS = [
    { id: "storage-quota", icon: "database", kind: "percent", canAuto: true, href: "#/settings/storage/usage", target: ".stor-usage, .stor-ring, .set-block",
      label: function () { return tr("Device storage"); },
      page: function () { return tr("Storage settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("Device storage is {pct}% full", v), tr("{used} of {limit} used. Free up space before the browser starts removing saved posts.", v), tr("Free up space")],
          [tr("Device storage is almost full", v), tr("{used} of {limit} used ({pct}%). Clear old media now.", v), tr("Free up space")],
          [tr("Device storage is full", v), tr("{used} of {limit} used. New media won't be saved until you free up space.", v), tr("Free up space")]);
      } },
    { id: "cache-limit", icon: "layers", kind: "percent", canAuto: true, href: "#/settings/storage", target: "#stor-max-row, #stor-max",
      label: function () { return tr("Cache size limit"); },
      page: function () { return tr("Storage settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("Cache is {pct}% of your limit", v), tr("{used} of your {limit} limit. Older media will be removed soon.", v), tr("Raise limit")],
          [tr("Cache is almost at your limit", v), tr("{used} of {limit} ({pct}%). Raise the limit or clear the cache.", v), tr("Raise limit")],
          [tr("Cache limit reached", v), tr("{used} of {limit}. Older media is now removed to make room.", v), tr("Raise limit")]);
      } },
    { id: "local-store", icon: "sliders", kind: "percent", canAuto: true, href: "#/settings/storage/usage", target: "#stor-local",
      label: function () { return tr("Settings and sync storage"); },
      page: function () { return tr("Storage settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("Saved settings are {pct}% full", v), tr("{used} of about {limit}. Settings sync may stop saving changes.", v), tr("Free up space")],
          [tr("Saved settings are almost full", v), tr("{used} of about {limit} ({pct}%). Clear saved data to keep syncing.", v), tr("Free up space")],
          [tr("Saved settings are full", v), tr("{used} of {limit}. New settings can't be saved on this device.", v), tr("Free up space")]);
      } },
    { id: "data-cap", icon: "signal", kind: "percent", canAuto: true, href: "#/settings/data", target: "[data-sa-cap]",
      label: function () { return tr("Data cap"); },
      page: function () { return tr("Data usage settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("{pct}% of your data cap used", v), tr("{used} of {limit} {when}. Resets {reset}.", v), tr("Turn on Data saver")],
          [tr("You're almost at your data cap", v), tr("{used} of {limit} {when} ({pct}%). Resets {reset}.", v), tr("Turn on Data saver")],
          [tr("Data cap reached", v), tr("{used} of {limit} {when}. Turn on Max data saving or raise your cap. Resets {reset}.", v), tr("Raise limit")]);
      } },
    { id: "data-burn", icon: "flame", kind: "flag", canAuto: false, href: "#/settings/data", target: "[data-sa-cap]",
      label: function () { return tr("Data cap pace"); },
      page: function () { return tr("Data usage settings"); },
      copy: function (level, v) {
        return [tr("At this rate you'll hit your cap in {days} days", v), tr("{used} of {limit} used, about {rate} a day. Your cap resets in {left} days.", v), tr("Turn on Data saver")];
      } },
    { id: "mobile-data", icon: "phone", kind: "flag", canAuto: false, href: "#/settings/data", target: "[data-act=\"data-saver\"]",
      label: function () { return tr("Mobile data tips"); },
      page: function () { return tr("Data usage settings"); },
      copy: function (level, v) {
        if (v.slow) return [tr("Your connection is slow"), tr("Switch on Data saver to load lighter images and skip autoplay."), tr("Turn on Data saver")];
        if (v.saveData) return [tr("Your browser asks to save data"), tr("Switch on Data saver here too, so this app downloads less."), tr("Turn on Data saver")];
        return [tr("You're on mobile data"), tr("Switch on Data saver to load lighter images and skip autoplay."), tr("Turn on Data saver")];
      } },
    { id: "persist-denied", icon: "shield", kind: "flag", canAuto: false, href: "#/settings/storage", target: "#stor-persist",
      label: function () { return tr("Persistent storage"); },
      page: function () { return tr("Storage settings"); },
      copy: function () {
        return [tr("This browser may clear saved posts"), tr("Persistent storage was denied, so saved media can be removed when space is low. Installing the app usually keeps it."), tr("Open Storage")];
      } },
    { id: "translate-daily", icon: "globe", kind: "percent", canAuto: false, href: "#/settings/live-translate", target: "[data-lt-field=\"dailyMin\"]",
      label: function () { return tr("Live Translate daily limit"); },
      page: function () { return tr("Live Translate settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("{pct}% of today's Live Translate time used", v), tr("{used} of {limit} today.", v), tr("Raise limit")],
          [tr("Live Translate is almost out for today", v), tr("{used} of {limit} today ({pct}%).", v), tr("Raise limit")],
          [tr("Today's Live Translate time is used up", v), tr("{limit} used. It resets at midnight.", v), tr("Raise limit")]);
      } },
    { id: "pool-upload", icon: "share", kind: "percent", canAuto: true, autoDefault: false, href: "#/settings/data", target: "[data-act=\"peer-upload\"]",
      label: function () { return tr("Sharing pool upload"); },
      page: function () { return tr("Data usage settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("{pct}% of today's sharing upload used", v), tr("You shared {used} of {limit} with nearby devices today.", v), tr("Change sharing")],
          [tr("Sharing upload is almost used up", v), tr("You shared {used} of {limit} today ({pct}%).", v), tr("Change sharing")],
          [tr("Sharing paused until tomorrow", v), tr("You shared {used} today, the daily maximum. Viewing is not affected.", v), tr("Change sharing")]);
      } },
    { id: "screen-time", icon: "timer", kind: "percent", canAuto: true, autoDefault: false, href: "#/settings/notifications", target: "[data-sa-screen]",
      label: function () { return tr("Daily screen time"); },
      page: function () { return tr("Notification settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("{pct}% of your screen time today", v), tr("{used} of {limit} today.", v), tr("Change limit")],
          [tr("Your screen time is almost up", v), tr("{used} of {limit} today ({pct}%).", v), tr("Change limit")],
          [tr("Screen time limit reached", v), tr("You've used {limit} today. Take a break, or change your limit.", v), tr("Change limit")]);
      } },
    { id: "feed-tabs", icon: "lists", kind: "percent", canAuto: true, href: "#/settings/content", target: ".set-block, .tab-edit-row",
      label: function () { return tr("Custom tabs"); },
      page: function () { return tr("Custom tabs"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("{used} of {limit} custom tabs used", v), tr("This device can keep {limit} tabs.", v), tr("Manage tabs")],
          [tr("You're almost out of custom tabs", v), tr("{used} of {limit} tabs used ({pct}%).", v), tr("Manage tabs")],
          [tr("Tab limit reached", v), tr("This device can keep {limit} tabs. Remove some to add more.", v), tr("Manage tabs")]);
      } },
    /* Owner only: today's requests across every server that answers reads
       (the Worker plus the backups), not one server's own quota. */
    { id: "server-pool", icon: "gauge", kind: "percent", canAuto: false, href: "#/settings", target: "[data-pool-cap], .usage-panel",
      label: function () { return tr("Server pool capacity"); },
      page: function () { return tr("Account settings"); },
      copy: function (level, v) {
        var row = pctCopy(level, v,
          [tr("{pct}% of today's server pool used", v), tr("{used} of {limit} requests across {n} servers. Resets {reset}.", v), tr("See usage")],
          [tr("The server pool is almost used up", v), tr("{used} of {limit} requests across {n} servers ({pct}%). Resets {reset}.", v), tr("See usage")],
          [tr("Today's server pool is used up", v), tr("All {n} servers reached their free daily requests. Resets {reset}.", v), tr("See usage")]);
        if (v.bypass) row = [row[0], row[1] + " " + tr("{name} is used up, so reads skip it.", { name: v.bypass }), row[2]];
        return row;
      } },
    /* A short pause, not a fault: shown at most once per 10 minutes, no buzz
       or tone, and removed from System notices once the pause is over. */
    { id: "rate-limit", icon: "gauge", kind: "flag", canAuto: false, href: "#/settings/network", target: ".set-block",
      cooldown: 10 * 60 * 1000, transient: true, silent: true,
      label: function () { return tr("Server rate limits"); },
      page: function () { return tr("Network settings"); },
      copy: function (level, v) {
        return [tr("Taking a short pause"), tr("This device sent a lot at once, so the app waits {wait} before asking again. Nothing is lost.", v), tr("Network settings")];
      } },
    { id: "session-expired", icon: "key", kind: "flag", canAuto: true, href: "#/settings", target: "[data-acct=\"login\"], .set-block",
      label: function () { return tr("Sign-in session"); },
      page: function () { return tr("Account settings"); },
      copy: function () {
        return [tr("Your session expired"), tr("Sign in again to keep syncing and posting."), tr("Sign in again")];
      } },
    { id: "temp-expiry", icon: "hourglass", kind: "flag", canAuto: true, href: "#/settings", target: "[data-acct=\"temp-keep\"]",
      label: function () { return tr("Temporary account"); },
      page: function () { return tr("Account settings"); },
      copy: function (level, v) {
        if (level === "critical") return [tr("Your temporary account is deleted in {left}", v), tr("Everything on it will be gone. Save it now to keep it.", v), tr("Save this account")];
        return [tr("Your temporary account is deleted in {left}", v), tr("Save it to keep your posts, follows and settings.", v), tr("Save this account")];
      } },
    { id: "push-revoked", icon: "bellOff", kind: "flag", canAuto: true, href: "#/settings/notifications", target: "[data-act=\"notify\"]",
      label: function () { return tr("Push permission"); },
      page: function () { return tr("Notification settings"); },
      copy: function () {
        return [tr("Notifications are blocked"), tr("Notifications are on in settings, but this browser blocked them. Allow them in the site settings, or turn them off here."), tr("Fix notifications")];
      } },
    { id: "battery", icon: "battery", kind: "flag", canAuto: false, href: "#/settings/device", target: "[data-level=\"light\"]",
      label: function () { return tr("Low battery"); },
      page: function () { return tr("Device performance"); },
      copy: function (level, v) {
        return [tr("Battery at {pct}%", v), tr("Switch to Light mode to share less and save power."), tr("Use Light mode")];
      } },
    { id: "corrupt-store", icon: "fileAlert", kind: "flag", canAuto: true, href: "#/settings/storage", target: "[data-stor=\"clear-all\"]",
      label: function () { return tr("Damaged saved data"); },
      page: function () { return tr("Storage settings"); },
      copy: function (level, v) {
        return [tr("A saved setting is damaged"), tr("{name} couldn't be read on this device, so defaults are used. Clear saved data to start fresh.", v), tr("Open Storage")];
      } },
    { id: "sync-failed", icon: "sync", kind: "flag", canAuto: true, href: "#/settings/devices", target: ".set-block",
      label: function () { return tr("Settings sync"); },
      page: function () { return tr("My devices"); },
      copy: function () {
        return [tr("Settings sync failed"), tr("Your latest changes are only on this device. Check your connection and devices."), tr("Open devices")];
      } },
    { id: "inbox-mail", icon: "mail", kind: "percent", canAuto: true, href: "#/settings/storage/usage", target: ".set-block",
      label: function () { return tr("Inbox mail storage"); },
      page: function () { return tr("Storage settings"); },
      copy: function (level, v) {
        return pctCopy(level, v,
          [tr("Inbox mail storage is {pct}% full", v), tr("{used} of {limit} of saved mail on this device.", v), tr("Free up space")],
          [tr("Inbox mail storage is almost full", v), tr("{used} of {limit} ({pct}%). Older mail will stop saving offline.", v), tr("Free up space")],
          [tr("Inbox mail storage is full", v), tr("{used} of {limit}. New mail is not saved offline.", v), tr("Free up space")]);
      } },
    { id: "smspool-balance", icon: "card", kind: "flag", canAuto: false, href: "#/messages", target: ".set-block",
      label: function () { return tr("SMS code balance"); },
      page: function () { return tr("Inbox"); },
      copy: function (level, v) {
        return [tr("Your SMS code balance is low"), tr("{left} left. Top up on SMSPool before the next code.", v), tr("Open Inbox")];
      } }
  ];

  function byId(id) { for (var i = 0; i < ALERTS.length; i++) if (ALERTS[i].id === id) return ALERTS[i]; return null; }

  /* ---------- state and the System log ---------- */

  function state() {
    var s = readJson(ls(), STATE_KEY, {}) || {};
    if (!s.fired || typeof s.fired !== "object") s.fired = {};
    if (!Array.isArray(s.log)) s.log = [];
    return s;
  }
  function saveState(s) { s.log = s.log.slice(-40); writeJson(ls(), STATE_KEY, s); }

  function session() {
    var s = readJson(ss(), SESSION_KEY, {}) || {};
    if (!s.done || typeof s.done !== "object") s.done = {};
    return s;
  }
  function saveSession(s) { writeJson(ss(), SESSION_KEY, s); }

  function levelOf(def, r, p, slack) {
    if (!r) return "ok";
    if (def.kind === "flag") return RANK[r.level] ? r.level : "ok";
    var pct = Number(r.pct) + (slack || 0);
    if (!(pct >= 0)) return "ok";
    if (r.pct >= 100) return "limit";
    if (pct >= p.crit) return "critical";
    if (pct >= p.warn) return "warning";
    return "ok";
  }

  function varsOf(def, r) {
    var v = {};
    Object.keys(r && r.vars || {}).forEach(function (k) { v[k] = r.vars[k]; });
    if (r && r.pct != null) v.pct = Math.min(100, Math.floor(Number(r.pct)));
    if (r && r.used != null && v.used == null) v.used = r.fmt === "min" ? tr("{n} min", { n: Math.round(r.used) }) : r.fmt === "count" ? String(r.used) : fmtBytes(r.used);
    if (r && r.limit != null && v.limit == null) v.limit = r.fmt === "min" ? tr("{n} min", { n: Math.round(r.limit) }) : r.fmt === "count" ? String(r.limit) : fmtBytes(r.limit);
    return v;
  }

  function variantOf(level) { return level === "limit" ? "limit" : level === "critical" ? "critical" : level === "warning" ? "warning" : "info"; }

  /* ---------- quiet and busy ---------- */

  function quietNow(p) {
    var presence = root.ViktorychPresence;
    if (presence && presence.myState && presence.myState() === "dnd") return true;
    if (!p.quiet) return false;
    var h = new Date(now()).getHours();
    return p.quietFrom <= p.quietTo ? (h >= p.quietFrom && h < p.quietTo) : (h >= p.quietFrom || h < p.quietTo);
  }

  var gesture = { down: false, lastKey: 0, lastMove: 0 };

  function mediaPlaying() {
    var doc = root.document;
    try {
      var list = doc && doc.querySelectorAll ? doc.querySelectorAll("video, audio") : [];
      for (var i = 0; i < list.length; i++) if (!list[i].paused && !list[i].ended) return true;
    } catch (err) { /* nothing playing */ }
    var music = root.SIntelMusic;
    try { if (music && music.playing && music.playing()) return true; } catch (err) { /* no music */ }
    return false;
  }

  /* Why a redirect has to wait, or "" when the person is idle. */
  function busyReason() {
    var doc = root.document;
    if (!doc) return "";
    if (doc.visibilityState === "hidden") return "hidden";
    var el = doc.activeElement;
    var tag = el && el.tagName ? String(el.tagName).toUpperCase() : "";
    if (tag === "TEXTAREA" || (tag === "INPUT" && !/^(range|checkbox|radio|button|submit)$/i.test(String(el.type || ""))) || (el && el.isContentEditable)) return "typing";
    if (now() - gesture.lastKey < 4000) return "typing";
    var hash = String(root.location && root.location.hash || "");
    if (/^#\/(compose|post\/new|messages\/|dm\/|direct\/)/.test(hash)) return "composing";
    try {
      var drafts = doc.querySelectorAll ? doc.querySelectorAll("textarea, [contenteditable=\"true\"]") : [];
      for (var i = 0; i < drafts.length; i++) {
        var text = drafts[i].value != null ? drafts[i].value : drafts[i].textContent;
        if (String(text || "").trim()) return "draft";
      }
      if (doc.querySelector && doc.querySelector(".xc-open, .x-compose.open, [data-composing=\"1\"]")) return "composing";
      if (doc.querySelector && doc.querySelector("[data-call-active], .space-live.joined, .call-active")) return "call";
    } catch (err) { /* treat as idle */ }
    var html = doc.documentElement;
    var tv = !!(html && html.classList && html.classList.contains("tv-on"));
    if (mediaPlaying()) return tv ? "tv" : "media";
    if (gesture.down || now() - gesture.lastMove < 600) return "gesture";
    return "";
  }

  /* ---------- vibration and sound ---------- */

  /* Critical and limit alerts buzz short-long and play a short tone made right
     here with Web Audio: no sound files, nothing fetched. Warnings buzz once,
     info stays silent. Nothing fires while someone types, drafts, composes,
     watches, listens or is in a call, or in quiet hours. Vibration is skipped
     with reduced motion and where the browser has none (iOS). Sound only plays
     once a tap or key press has unlocked audio. With the tab hidden and
     notifications allowed, the system notification carries both instead. */
  var BUZZ = { warning: [60], critical: [80, 70, 260], limit: [80, 70, 260, 70, 260] };
  var TONES = { critical: [880, 660], limit: [880, 660, 880] };
  var audio = { ctx: null, unlocked: false };
  var lastFeedback = null;

  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (err) { return false; }
  }
  function canVibrate() { var nav = root.navigator; return !!(nav && typeof nav.vibrate === "function"); }
  function audioCtor() { return root.AudioContext || root.webkitAudioContext || null; }

  /* Called from a real tap or key press only. */
  function unlockAudio() {
    if (audio.unlocked || !prefs().sound) return audio.unlocked;
    var C = audioCtor();
    if (!C) return false;
    try {
      audio.ctx = audio.ctx || new C();
      if (audio.ctx.resume) { var r = audio.ctx.resume(); if (r && r.catch) r.catch(function () {}); }
      audio.unlocked = true;
    } catch (err) { audio.unlocked = false; }
    return audio.unlocked;
  }

  function playTone(level) {
    var notes = TONES[level];
    var ctx = audio.ctx;
    if (!notes || !audio.unlocked || !ctx || !ctx.createOscillator) return false;
    try {
      var t = Number(ctx.currentTime) || 0;
      notes.forEach(function (hz, i) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        var at = t + i * 0.16;
        osc.type = "sine";
        osc.frequency.value = hz;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.14);
      });
      return true;
    } catch (err) { return false; }
  }

  function buzz(level) {
    var pattern = BUZZ[level];
    if (!pattern || !canVibrate() || reducedMotion()) return false;
    try { return root.navigator.vibrate(pattern.slice()) !== false; } catch (err) { return false; }
  }

  function systemNote(def, level, entry, p) {
    var N = root.Notification;
    if (!N || N.permission !== "granted" || !def || !entry) return false;
    var opts = { body: entry.desc || "", tag: "sa-" + def.id, renotify: true, silent: !p.sound, data: { hash: def.href, id: "sa-" + def.id } };
    if (p.vibrate && !reducedMotion()) opts.vibrate = BUZZ[level].slice();
    var plain = function () {
      try { new N(entry.title, opts); }
      catch (err) { try { delete opts.vibrate; new N(entry.title, opts); } catch (err2) { /* no system notice */ } }
    };
    var swc = root.navigator && root.navigator.serviceWorker;
    if (swc && swc.getRegistration) {
      swc.getRegistration().then(function (reg) {
        if (reg && reg.showNotification) return reg.showNotification(entry.title, opts);
        plain();
      }).catch(plain);
    } else plain();
    return true;
  }

  function feedback(def, level, entry, opts) {
    opts = opts || {};
    var p = prefs();
    var out = { level: level, vibrate: false, sound: false, system: false, skipped: "" };
    lastFeedback = out;
    var wantBuzz = p.vibrate && !!BUZZ[level];
    var wantSound = p.sound && !!TONES[level];
    if (!wantBuzz && !wantSound) { out.skipped = "off"; return out; }
    if (!opts.test && quietNow(p)) { out.skipped = "quiet"; return out; }
    var doc = root.document;
    if (doc && doc.visibilityState === "hidden") {
      if (TONES[level]) out.system = systemNote(def, level, entry, p);
      out.skipped = "hidden";
      return out;
    }
    if (!opts.test) {
      var why = busyReason();
      if (why && why !== "gesture") { out.skipped = why; return out; }
    }
    if (wantBuzz) out.vibrate = buzz(level);
    if (wantSound) out.sound = playTone(level);
    return out;
  }

  /* ---------- firing ---------- */

  var externals = {};
  var pendingShow = [];
  var redirect = { pending: null, countdown: null, active: null, timer: null, loop: null };

  function popoutApi() { return root.ViktorychAchievements && root.ViktorychAchievements.popout ? root.ViktorychAchievements : null; }

  function showAlert(def, level, v) {
    var A = popoutApi();
    if (!A) return;
    var copy = def.copy(level, v);
    A.popout({
      id: "sa-" + def.id,
      variant: variantOf(level),
      icon: def.icon,
      kicker: kickerOf(level),
      title: copy[0],
      desc: copy[1],
      action: copy[2],
      mute: true,
      onAction: function (act) {
        if (act === "action") openSettings(def, { manual: true, title: copy[0], desc: copy[1], level: level });
        else if (act === "mute") { var p = prefs(); p.off[def.id] = true; setPrefs({ off: p.off }); }
      }
    });
  }

  /* A passing condition is over: drop its System notice and its pop-out. */
  function clearTransient(def, s) {
    s.log = s.log.filter(function (e) { return e.id !== def.id; });
    var A = popoutApi();
    var cur = A && A.popCurrent ? A.popCurrent() : null;
    if (cur && cur.id === "sa-" + def.id && A.popClose) A.popClose("done");
    var doc = root.document;
    var notes = doc && doc.querySelector ? doc.querySelector(".sa-notes") : null;
    if (notes) redraw(".sa-notes", function () { return notesHtml() || '<section class="sa-notes" hidden></section>'; });
  }

  function logAlert(def, level, v) {
    var s = state();
    var copy = def.copy(level, v);
    s.log.push({ id: def.id, level: level, at: now(), title: copy[0], desc: copy[1], action: copy[2], href: def.href });
    return s;
  }

  function fire(def, level, r, s, p) {
    var v = varsOf(def, r);
    var entry = logAlert(def, level, v).log.pop();
    s.log.push(entry);
    var rank = RANK[level];
    if (!def.silent && !(rank < RANK.critical && quietNow(p))) feedback(def, level, entry);
    var wantsRedirect = rank >= RANK.critical && autoOn(def.id) && !session().done[def.id];
    if (wantsRedirect) {
      redirect.pending = { id: def.id, level: level, title: entry.title, desc: entry.desc };
      if (busyReason()) showAlert(def, level, v);
      return;
    }
    if (rank < RANK.critical && quietNow(p)) return;
    var doc = root.document;
    if (doc && doc.visibilityState === "hidden") { pendingShow.push([def, level, v]); return; }
    showAlert(def, level, v);
  }

  /* Compare one round of readings with what already fired. A reading of
     null means fine; a missing id means it was not measured this round. */
  function evaluate(readings) {
    var p = prefs();
    var s = state();
    var fired = [];
    Object.keys(externals).forEach(function (id) { if (!(id in readings)) readings[id] = externals[id]; });
    ALERTS.forEach(function (def) {
      if (!(def.id in readings)) return;
      var r = readings[def.id];
      var level = levelOf(def, r, p, 0);
      var prev = s.fired[def.id] || "ok";
      if (RANK[level] > RANK[prev]) {
        s.fired[def.id] = level;
        if (!alertOn(def.id)) return;
        if (!s.last || typeof s.last !== "object") s.last = {};
        if (def.cooldown && s.last[def.id] && now() - s.last[def.id] < def.cooldown) return;
        s.last[def.id] = now();
        fire(def, level, r, s, p);
        fired.push({ id: def.id, level: level });
      } else if (RANK[level] < RANK[prev]) {
        if (def.transient && level === "ok") clearTransient(def, s);
        /* Re-arm only once usage is clearly lower, so a value that hovers on
           a threshold does not pop again and again. */
        var eased = def.kind === "percent" ? levelOf(def, r, p, 2) : level;
        if (RANK[eased] < RANK[prev]) s.fired[def.id] = eased;
      }
    });
    saveState(s);
    if (redirect.active && redirect.active.id in readings) {
      var adef = byId(redirect.active.id);
      if (adef && RANK[levelOf(adef, readings[adef.id], p, 0)] < RANK.critical) fixed();
    }
    if (redirect.pending) tryRedirect();
    return fired;
  }

  /* ---------- auto-open the settings page ---------- */

  function tryRedirect() {
    clearTimeout(redirect.timer);
    var job = redirect.pending;
    if (!job || redirect.countdown) return;
    if (!autoOn(job.id) || session().done[job.id]) { redirect.pending = null; return; }
    if (busyReason()) { redirect.timer = setTimeout(tryRedirect, 1000); return; }
    startCountdown(job);
  }

  function startCountdown(job) {
    var def = byId(job.id);
    var A = popoutApi();
    if (!def || !A) return;
    redirect.pending = null;
    var cd = { job: job, left: COUNTDOWN_S, cancelled: false, went: false, el: null };
    redirect.countdown = cd;
    var cur = A.popCurrent && A.popCurrent();
    if (cur && cur.id === "sa-" + job.id && A.popClose) A.popClose("preempt");
    var title = function () { return tr("Opening {page} in {n}…", { page: def.page(), n: cd.left }); };
    var tick = function () {
      if (cd.cancelled || cd.went || redirect.countdown !== cd) return;
      cd.left -= 1;
      if (cd.left > 0) {
        var t = cd.el && cd.el.querySelector ? cd.el.querySelector("[data-pop-title]") : null;
        if (t) t.textContent = title();
        setTimeout(tick, 1000);
      }
    };
    A.popout({
      id: "sa-countdown",
      variant: "countdown",
      front: true,
      icon: def.icon,
      kicker: kickerOf(job.level),
      title: title(),
      desc: job.title,
      action: tr("Open now"),
      cancel: tr("Cancel"),
      dismiss: false,
      hold: COUNTDOWN_S * 1000,
      onShow: function (el) { cd.el = el; setTimeout(tick, 1000); },
      onAction: function (act) {
        if (act === "cancel") { cd.cancelled = true; markDone(job.id); }
        else if (act === "action") { cd.went = true; go(def, job); }
      },
      onClose: function (reason) {
        if (redirect.countdown === cd) redirect.countdown = null;
        if (cd.cancelled || cd.went) return;
        if (reason !== "timeout") { markDone(job.id); return; }
        /* Someone started typing or playing during the countdown: wait. */
        if (busyReason()) { redirect.pending = job; redirect.timer = setTimeout(tryRedirect, 1000); return; }
        cd.went = true;
        go(def, job);
      }
    });
  }

  function markDone(id) { var s = session(); s.done[id] = 1; saveSession(s); }

  function go(def, job) {
    markDone(def.id);
    openSettings(def, { manual: false, title: job.title, desc: job.desc, level: job.level });
  }

  function openSettings(def, info) {
    var loc = root.location;
    if (!loc) return;
    var from = String(loc.hash || "#/");
    if (from === def.href || from.indexOf(def.href + "?") === 0) from = (redirect.active && redirect.active.from) || "#/";
    redirect.active = { id: def.id, from: from, to: def.href, title: info.title, desc: info.desc, level: info.level, auto: !info.manual, at: now() };
    writeJson(ss(), SESSION_KEY + "-return", redirect.active);
    loc.hash = def.href;
    startLoop();
  }

  function onTargetRoute() {
    var a = redirect.active;
    var hash = String(root.location && root.location.hash || "");
    return !!(a && (hash === a.to || hash.indexOf(a.to + "?") === 0));
  }

  function bannerHtml(a) {
    var def = byId(a.id);
    var why = a.auto ? tr("Opened automatically: {title}", { title: a.title }) : a.title;
    return '<div class="sa-banner v-' + variantOf(a.level) + '" data-sa-banner="' + esc(a.id) + '" role="status">' +
      '<span class="sa-banner-ico" aria-hidden="true">' + glyph(def ? def.icon : "warning") + "</span>" +
      '<div class="sa-banner-copy"><b>' + esc(why) + "</b><p>" + esc(a.desc || "") + "</p></div>" +
      '<button class="outline sa-back" type="button" data-sa="back">' + esc(tr("Back to where you were")) + "</button></div>";
  }

  /* Keep the banner and the pulse in place while the page re-renders. */
  function paintTarget() {
    var a = redirect.active;
    var doc = root.document;
    if (!a || !doc || !doc.querySelector) return;
    if (!onTargetRoute()) { stopLoop(); redirect.active = null; return; }
    var def = byId(a.id);
    var app = doc.querySelector("#app") || doc.body;
    if (app && !doc.querySelector("[data-sa-banner]")) {
      var holder = doc.createElement("div");
      holder.innerHTML = bannerHtml(a);
      var banner = holder.firstChild;
      var top = app.querySelector ? app.querySelector(".topbar") : null;
      if (top && top.parentNode) top.parentNode.insertBefore(banner, top.nextSibling);
      else if (app.firstChild) app.insertBefore(banner, app.firstChild);
      else app.appendChild(banner);
    }
    var target = def ? doc.querySelector(def.target) : null;
    if (target && !target.classList.contains("sa-pulse")) {
      target.classList.add("sa-pulse");
      if (!a.scrolled && target.scrollIntoView) {
        a.scrolled = true;
        try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (err) { target.scrollIntoView(); }
      }
    }
  }

  function startLoop() {
    stopLoop();
    redirect.loop = setInterval(paintTarget, 400);
    setTimeout(paintTarget, 60);
  }
  function stopLoop() { if (redirect.loop) clearInterval(redirect.loop); redirect.loop = null; }

  function goBack() {
    var a = redirect.active;
    if (!a) return false;
    redirect.active = null;
    stopLoop();
    try { if (ss()) ss().removeItem(SESSION_KEY + "-return"); } catch (err) { /* nothing to clear */ }
    var doc = root.document;
    var banner = doc && doc.querySelector ? doc.querySelector("[data-sa-banner]") : null;
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    if (root.location) root.location.hash = a.from || "#/";
    return true;
  }

  /* The problem cleared while its page was open: say so and go back. */
  function fixed() {
    var a = redirect.active;
    if (!a || !onTargetRoute()) return;
    var A = popoutApi();
    var def = byId(a.id);
    if (A) A.popout({ id: "sa-fixed", variant: "info", icon: "checkCircle", kicker: tr("Fixed"), title: tr("Fixed. Taking you back."), desc: def ? def.label() : "", dismiss: false, hold: 2200 });
    setTimeout(function () { if (redirect.active === a) goBack(); }, 1200);
  }

  /* ---------- measuring ---------- */

  function settingsBlob() { return readJson(ls(), SETTINGS_KEY, {}) || {}; }

  function dayKey(t) {
    var d = new Date(t);
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }

  function meter() {
    var m = readJson(ls(), METER_KEY, {}) || {};
    if (!m.days || typeof m.days !== "object") m.days = {};
    var cap = m.cap && typeof m.cap === "object" ? m.cap : {};
    m.cap = {
      on: cap.on === true,
      bytes: CAP_STEPS.indexOf(Number(cap.bytes)) >= 0 ? Number(cap.bytes) : 5 * GB,
      period: cap.period === "day" || cap.period === "week" ? cap.period : "month",
      resetDay: Math.max(cap.period === "week" ? 0 : 1, Math.min(cap.period === "week" ? 6 : 28, Number(cap.resetDay) || (cap.period === "week" ? 1 : 1)))
    };
    if (cap.period === "week" && Number(cap.resetDay) === 0) m.cap.resetDay = 0;
    m.sw = Number(m.sw) || 0;
    return m;
  }
  function saveMeter(m) {
    var keys = Object.keys(m.days).sort();
    while (keys.length > 70) delete m.days[keys.shift()];
    writeJson(ls(), METER_KEY, m);
  }

  function periodStart(cap, t) {
    var d = new Date(t);
    d.setHours(0, 0, 0, 0);
    if (cap.period === "day") return d.getTime();
    if (cap.period === "week") {
      var back = (d.getDay() - cap.resetDay + 7) % 7;
      d.setDate(d.getDate() - back);
      return d.getTime();
    }
    if (d.getDate() < cap.resetDay) d.setMonth(d.getMonth() - 1);
    d.setDate(cap.resetDay);
    return d.getTime();
  }
  function periodEnd(cap, t) {
    var d = new Date(periodStart(cap, t));
    if (cap.period === "day") d.setDate(d.getDate() + 1);
    else if (cap.period === "week") d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
    return d.getTime();
  }
  function usedSince(m, start) {
    var key = dayKey(start);
    var sum = 0;
    Object.keys(m.days).forEach(function (k) { if (k >= key) sum += Number(m.days[k]) || 0; });
    return sum;
  }
  function whenText(period) {
    if (period === "day") return tr("so far today");
    if (period === "week") return tr("this week");
    return tr("this month");
  }

  var rtBytes = 0;
  function addBytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return;
    var m = meter();
    var k = dayKey(now());
    m.days[k] = (Number(m.days[k]) || 0) + n;
    saveMeter(m);
  }

  /* Bytes the page fetched (Resource Timing, which includes media and API
     answers) and bytes the service worker fetched from the network for its
     caches. Both count the same downloads from two sides, so each round
     keeps the larger of the two. */
  function flushBytes() {
    var fromPage = rtBytes;
    rtBytes = 0;
    var st = root.ViktorychStorage;
    var swRead = st && st.openDb && st.readStats
      ? st.openDb().then(function (db) { return st.readStats(db); }).catch(function () { return null; })
      : Promise.resolve(null);
    return swRead.then(function (stats) {
      var m = meter();
      var fromSw = 0;
      if (stats) {
        var total = (Number(stats.originBytes) || 0);
        if (m.sw && total >= m.sw) fromSw = total - m.sw;
        m.sw = total;
        saveMeter(m);
      }
      addBytes(Math.max(fromPage, fromSw));
    });
  }

  function watchResources() {
    var PO = root.PerformanceObserver;
    if (!PO) return;
    try {
      var po = new PO(function (list) {
        list.getEntries().forEach(function (e) { rtBytes += Number(e.transferSize) || 0; });
      });
      po.observe({ type: "resource", buffered: true });
      var nav = new PO(function (list) {
        list.getEntries().forEach(function (e) { rtBytes += Number(e.transferSize) || 0; });
      });
      nav.observe({ type: "navigation", buffered: true });
    } catch (err) { /* no Resource Timing here */ }
  }

  function dataReadings(out) {
    var m = meter();
    var cap = m.cap;
    if (!cap.on) { out["data-cap"] = null; out["data-burn"] = null; return; }
    var t = now();
    var start = periodStart(cap, t);
    var end = periodEnd(cap, t);
    var used = usedSince(m, start);
    var reset = new Date(end);
    var resetText = reset.toLocaleDateString ? reset.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : dayKey(end);
    out["data-cap"] = { used: used, limit: cap.bytes, pct: used / cap.bytes * 100, vars: { when: whenText(cap.period), reset: resetText } };
    var elapsedDays = Math.max(0.5, (t - start) / 86400000);
    var leftDays = Math.max(0, (end - t) / 86400000);
    var rate = used / elapsedDays;
    var burn = null;
    if (rate > 0 && used < cap.bytes && used >= cap.bytes * 0.2) {
      var hitIn = (cap.bytes - used) / rate;
      if (hitIn < leftDays - 0.5) burn = { level: "warning", vars: { days: Math.max(1, Math.round(hitIn)), left: Math.max(1, Math.round(leftDays)), rate: fmtBytes(rate), used: fmtBytes(used), limit: fmtBytes(cap.bytes) } };
    }
    out["data-burn"] = burn;
  }

  function screenUsedMin() {
    var s = readJson(ls(), SCREEN_KEY, {}) || {};
    return s.day === dayKey(now()) ? (Number(s.ms) || 0) / 60000 : 0;
  }
  function addScreen(ms) {
    var s = readJson(ls(), SCREEN_KEY, {}) || {};
    var k = dayKey(now());
    if (s.day !== k) s = { day: k, ms: 0 };
    s.ms = (Number(s.ms) || 0) + ms;
    writeJson(ls(), SCREEN_KEY, s);
  }

  /* localStorage as the browser counts it: UTF-16 code units of key plus
     value (one per character, not two bytes) against this browser's real
     limit, about 5 Mi in Chromium and Firefox and 2.5 Mi in Safari and on
     iOS. Counting two bytes a character against 5 MB, as before, showed
     twice the real fill. */
  function localReading() {
    var store = ls();
    var budget = root.ViktorychLocalBudget;
    if (!store) return null;
    if (budget && budget.reading) {
      try { return budget.reading(store, root.navigator); } catch (err) { return null; }
    }
    var n = 0;
    try {
      for (var i = 0; i < store.length; i++) {
        var key = store.key(i) || "";
        n += key.length + String(store.getItem(key) || "").length;
      }
    } catch (err) { return null; }
    return { used: n, limit: LOCAL_LIMIT, pct: n / LOCAL_LIMIT * 100 };
  }

  var DAMAGE_CHECK = [[SETTINGS_KEY, function () { return tr("Your settings"); }], [STORAGE_POLICY_KEY, function () { return tr("Storage settings"); }], [DEVICE_KEY, function () { return tr("Device performance"); }], [PREFS_KEY, function () { return tr("Settings alerts"); }]];

  function damaged() {
    var store = ls();
    if (!store) return null;
    for (var i = 0; i < DAMAGE_CHECK.length; i++) {
      var raw = null;
      try { raw = store.getItem(DAMAGE_CHECK[i][0]); } catch (err) { raw = null; }
      if (raw == null || raw === "") continue;
      try { JSON.parse(raw); } catch (err) { return { level: "critical", vars: { name: DAMAGE_CHECK[i][1]() } }; }
    }
    return null;
  }

  var rate = { until: 0 };
  var sessionGone = false;
  var persistAsked = false;

  function tempLeftText(ms) {
    var mins = Math.max(1, Math.ceil(ms / 60000));
    if (mins < 60) return tr("{n} min", { n: mins });
    var hours = Math.round(mins / 60);
    if (hours < 48) return tr("{n} h", { n: hours });
    return tr("{n} days", { n: Math.round(hours / 24) });
  }

  /* One round of readings from real usage on this device. */
  function measure() {
    var out = {};
    var p = prefs();
    var nav = root.navigator || {};
    var settings = settingsBlob();
    var jobs = [];
    var policy = readJson(ls(), STORAGE_POLICY_KEY, null);

    if (nav.storage && nav.storage.estimate) {
      jobs.push(nav.storage.estimate().then(function (est) {
        var usage = Number(est && est.usage) || 0;
        var quota = Number(est && est.quota) || 0;
        out["storage-quota"] = quota > 0 ? { used: usage, limit: quota, pct: usage / quota * 100 } : null;
        if (policy && !policy.unlimited && Number(policy.maxBytes) > 0) {
          out["cache-limit"] = { used: usage, limit: Number(policy.maxBytes), pct: usage / Number(policy.maxBytes) * 100 };
        } else out["cache-limit"] = null;
      }).catch(function () {}));
    }
    if (nav.storage && nav.storage.persisted) {
      jobs.push(nav.storage.persisted().then(function (ok) {
        out["persist-denied"] = !ok && persistAsked ? { level: "info", vars: {} } : null;
      }).catch(function () {}));
    }
    var lr = localReading();
    out["local-store"] = lr ? { used: lr.used, limit: lr.limit, pct: lr.pct } : null;

    dataReadings(out);

    var conn = nav.connection || null;
    var saverOn = settings.saveData === true;
    if (conn && !saverOn) {
      var slow = /^(slow-2g|2g)$/.test(String(conn.effectiveType || ""));
      var cell = conn.type === "cellular";
      out["mobile-data"] = cell || slow || conn.saveData ? { level: "info", vars: { slow: slow && !cell, saveData: !!conn.saveData && !cell && !slow } } : null;
    } else out["mobile-data"] = null;

    var lt = root.ViktorychLiveTranslate;
    if (lt && lt.prefs && lt.state) {
      try {
        var ltp = lt.prefs();
        var usedMin = (Number(lt.state().usedMs) || 0) / 60000;
        out["translate-daily"] = usedMin > 0 && ltp.dailyMin > 0 ? { used: usedMin, limit: ltp.dailyMin, pct: usedMin / ltp.dailyMin * 100, fmt: "min" } : null;
      } catch (err) { /* not measured */ }
    }

    var pool = root.ViktorychPool;
    if (pool && pool.stats) {
      try {
        var ps = pool.stats();
        out["pool-upload"] = ps && ps.uploadCap > 0 ? { used: ps.uploadToday || 0, limit: ps.uploadCap, pct: (ps.uploadToday || 0) / ps.uploadCap * 100 } : null;
      } catch (err) { /* not measured */ }
    }

    var accounts = root.ViktorychAccounts;
    if (accounts && accounts.serverPool) {
      try {
        var sp = accounts.serverPool();
        var resetAt = sp && sp.origins.length ? Math.min.apply(null, sp.origins.map(function (o) { return o.reset; })) : 0;
        var resetTxt = "";
        try { resetTxt = resetAt ? new Date(resetAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""; } catch (err) { resetTxt = ""; }
        out["server-pool"] = sp && sp.cap > 0 ? { used: sp.used, limit: sp.cap, pct: sp.used / sp.cap * 100, fmt: "count",
          vars: { used: fmtCount(sp.used), limit: fmtCount(sp.cap), n: String(sp.origins.length), reset: resetTxt, bypass: sp.bypassed.join(", ") } } : null;
      } catch (err) { /* not measured */ }
    }

    out["screen-time"] = p.screenMin > 0 ? { used: screenUsedMin(), limit: p.screenMin, pct: screenUsedMin() / p.screenMin * 100, fmt: "min" } : null;

    var tabs = Array.isArray(settings.feedTabs) ? settings.feedTabs.length : 0;
    var ntabs = Array.isArray(settings.noteTabs) ? settings.noteTabs.length : 0;
    var tabCount = Math.max(tabs, ntabs);
    out["feed-tabs"] = tabCount ? { used: tabCount, limit: TAB_LIMIT, pct: tabCount / TAB_LIMIT * 100, fmt: "count" } : null;

    out["rate-limit"] = rate.until > now() ? { level: "info", vars: { wait: tempLeftText(rate.until - now()) } } : null;
    out["session-expired"] = sessionGone ? { level: "critical", vars: {} } : null;

    var accts = root.ViktorychAccounts;
    var acct = accts && accts.account ? accts.account() : null;
    var exp = acct && acct.temporary && typeof acct.temporary === "object" ? Number(acct.temporary.expiresAt) || 0 : 0;
    if (exp) {
      var left = exp - now();
      out["temp-expiry"] = left <= 3600000 ? { level: "critical", vars: { left: tempLeftText(Math.max(0, left)) } }
        : left <= 86400000 ? { level: "warning", vars: { left: tempLeftText(left) } } : null;
    } else out["temp-expiry"] = null;

    var N = root.Notification;
    out["push-revoked"] = settings.notify === true && N && N.permission === "denied" ? { level: "critical", vars: {} } : null;

    out["corrupt-store"] = damaged();

    if (nav.getBattery) {
      jobs.push(nav.getBattery().then(function (b) {
        var dev = readJson(ls(), DEVICE_KEY, {}) || {};
        var light = String(dev.level || "") === "light";
        out.battery = b && !b.charging && b.level <= 0.2 && !light ? { level: "info", vars: { pct: Math.round(b.level * 100) } } : null;
      }).catch(function () {}));
    }

    return Promise.all(jobs).then(function () { return out; });
  }

  function check() {
    return flushBytes().catch(function () {}).then(measure).then(evaluate);
  }

  /* Other parts of the app (Inbox mail, SMS codes, sync) report their own
     limits here: report(id, { used, limit }) or report(id, { level }). */
  function report(id, reading) {
    if (!byId(id)) return null;
    var r = reading || null;
    if (r && r.used != null && r.limit > 0 && r.pct == null) r.pct = r.used / r.limit * 100;
    externals[id] = r;
    var one = {};
    one[id] = r;
    return evaluate(one);
  }

  /* ---------- settings UI ---------- */

  function sw(on, label, attrs, disabled) {
    return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" ' + attrs + (disabled ? " disabled" : "") + "><span>" + esc(label) + "</span><i></i></button>";
  }
  function select(name, value, rows, label, extra) {
    return '<select class="sa-select" data-sa="' + name + '" aria-label="' + esc(label) + '"' + (extra || "") + ">" + rows.map(function (row) {
      return '<option value="' + esc(row[0]) + '"' + (String(row[0]) === String(value) ? " selected" : "") + ">" + esc(row[1]) + "</option>";
    }).join("") + "</select>";
  }
  function hourLabel(h) { return ("0" + h).slice(-2) + ":00"; }

  /* Settings > Notifications > Settings alerts. */
  function settingsHtml() {
    var p = prefs();
    var hours = []; for (var h = 0; h < 24; h++) hours.push([h, hourLabel(h)]);
    var rows = ALERTS.map(function (def) {
      var on = !p.off[def.id];
      var auto = def.canAuto ? '<span class="sa-auto">' + sw(autoOn(def.id), tr("Open settings"), 'data-sa="auto-one" data-id="' + def.id + '"', !on || !p.autoOpen) + "</span>" : "";
      return '<div class="sa-row"><span class="sa-row-ico" aria-hidden="true">' + glyph(def.icon) + "</span>" +
        sw(on, def.label(), 'data-sa="alert" data-id="' + def.id + '"') + auto + "</div>";
    }).join("");
    return '<section class="sa-settings" data-sa-settings="1"><h2>' + esc(tr("Settings alerts")) + "</h2>" +
      '<p class="phandle">' + esc(tr("A warning pops up when you get close to a limit you set, like storage, data or screen time. Everything is checked on this device.")) + "</p>" +
      '<div class="theme-row sa-preview" role="group" aria-label="' + esc(tr("Preview")) + '">' +
      '<button class="outline" type="button" data-sa="preview" data-value="info">' + esc(tr("Info")) + "</button>" +
      '<button class="outline" type="button" data-sa="preview" data-value="warning">' + esc(tr("Warning")) + "</button>" +
      '<button class="outline" type="button" data-sa="preview" data-value="critical">' + esc(tr("Critical")) + "</button>" +
      '<button class="outline" type="button" data-sa="preview" data-value="limit">' + esc(tr("Limit reached")) + "</button></div>" +
      sw(p.autoOpen, tr("Open settings automatically on critical issues"), 'data-sa="auto"') +
      '<p class="phandle">' + esc(tr("Waits until you stop typing, playing or calling, counts down 3 seconds, and brings you back after.")) + "</p>" +
      '<h3 class="ach-sub">' + esc(tr("Sound and vibration")) + "</h3>" +
      '<div class="sa-list sa-feel">' +
      '<div class="sa-row"><span class="sa-row-ico" aria-hidden="true">' + glyph("vibrate") + "</span>" + sw(p.vibrate, tr("Vibrate for alerts"), 'data-sa="vibrate"') + "</div>" +
      '<div class="sa-row"><span class="sa-row-ico" aria-hidden="true">' + glyph("sound") + "</span>" + sw(p.sound, tr("Sound for alerts"), 'data-sa="sound"') + "</div>" +
      '<div class="sa-row sa-test"><span class="sa-row-ico" aria-hidden="true">' + glyph("bell") + "</span>" +
      '<span class="sa-test-label">' + esc(tr("Test sound and vibration")) + "</span>" +
      '<button class="outline" type="button" data-sa="feedback-test">' + esc(tr("Test")) + "</button></div></div>" +
      '<p class="phandle">' + esc(tr("Critical and limit alerts vibrate and play a short tone. Warnings only vibrate. Never while you type, watch or call.")) +
      (canVibrate() ? "" : " " + esc(tr("This device can't vibrate."))) + "</p>" +
      '<h3 class="ach-sub">' + esc(tr("Thresholds")) + "</h3>" +
      '<label class="sa-field"><span>' + esc(tr("Warn at")) + "</span>" + select("warn", p.warn, WARN_STEPS.map(function (n) { return [n, n + "%"]; }), tr("Warn at")) + "</label>" +
      '<label class="sa-field"><span>' + esc(tr("Critical at")) + "</span>" + select("crit", p.crit, CRIT_STEPS.map(function (n) { return [n, n + "%"]; }), tr("Critical at")) + "</label>" +
      '<p class="phandle">' + esc(tr("At 100% you get a Limit reached alert.")) + "</p>" +
      '<h3 class="ach-sub">' + esc(tr("Daily screen time limit")) + "</h3>" +
      '<label class="sa-field" data-sa-screen="1"><span>' + esc(tr("Each day")) + "</span>" + select("screen", p.screenMin, SCREEN_STEPS.map(function (n) { return [n, n ? tr("{n} min", { n: n }) : tr("Off")]; }), tr("Daily screen time limit")) + "</label>" +
      (p.screenMin ? '<p class="phandle">' + esc(tr("Used today: {used} of {max} min", { used: Math.round(screenUsedMin()), max: p.screenMin })) + "</p>" : "") +
      '<h3 class="ach-sub">' + esc(tr("Quiet hours")) + "</h3>" +
      sw(p.quiet, tr("Only critical alerts during quiet hours"), 'data-sa="quiet"') +
      '<div class="sa-hours"><label class="sa-field"><span>' + esc(tr("From")) + "</span>" + select("quiet-from", p.quietFrom, hours, tr("From"), p.quiet ? "" : " disabled") + "</label>" +
      '<label class="sa-field"><span>' + esc(tr("To")) + "</span>" + select("quiet-to", p.quietTo, hours, tr("To"), p.quiet ? "" : " disabled") + "</label></div>" +
      '<h3 class="ach-sub">' + esc(tr("Alerts")) + "</h3>" +
      '<div class="sa-list">' + rows + "</div></section>";
  }

  /* Settings > Data usage > Data cap, with a meter of what this device downloaded. */
  function dataCapHtml() {
    var m = meter();
    var cap = m.cap;
    var t = now();
    var start = periodStart(cap, t);
    var used = usedSince(m, start);
    var pct = Math.min(100, Math.round(used / cap.bytes * 100));
    var reset = new Date(periodEnd(cap, t));
    var resetText = reset.toLocaleDateString ? reset.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : dayKey(reset.getTime());
    var level = cap.on ? (pct >= 100 ? "limit" : pct >= prefs().crit ? "critical" : pct >= prefs().warn ? "warning" : "ok") : "ok";
    var days = cap.period === "week"
      ? [[0, tr("Sunday")], [1, tr("Monday")], [2, tr("Tuesday")], [3, tr("Wednesday")], [4, tr("Thursday")], [5, tr("Friday")], [6, tr("Saturday")]]
      : (function () { var r = []; for (var d = 1; d <= 28; d++) r.push([d, String(d)]); return r; })();
    var periodBtn = function (id, label) {
      return '<button class="outline' + (cap.period === id ? " on" : "") + '" type="button" data-sa="cap-period" data-value="' + id + '">' + esc(label) + "</button>";
    };
    return '<section class="sa-cap" data-sa-cap="1"><h2>' + esc(tr("Data cap")) + "</h2>" +
      '<p class="phandle">' + esc(tr("Count what this app downloads on this device and warn you before you hit your cap.")) + "</p>" +
      sw(cap.on, tr("Warn me about my data cap"), 'data-sa="cap-on"') +
      '<div class="sa-meter v-' + variantOf(level) + '" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="' + esc(tr("Data used")) + '"><i style="width:' + pct + '%"></i></div>' +
      '<p class="phandle">' + esc(tr("{used} of {limit} {when}", { used: fmtBytes(used), limit: fmtBytes(cap.bytes), when: whenText(cap.period) })) + " · " + esc(tr("Resets {reset}", { reset: resetText })) + "</p>" +
      '<label class="sa-field"><span>' + esc(tr("Cap")) + "</span>" + select("cap-bytes", cap.bytes, CAP_STEPS.map(function (b) { return [b, fmtBytes(b)]; }), tr("Cap")) + "</label>" +
      '<h3 class="ach-sub">' + esc(tr("Period")) + '</h3><div class="theme-row" role="group" aria-label="' + esc(tr("Period")) + '">' +
      periodBtn("day", tr("Day")) + periodBtn("week", tr("Week")) + periodBtn("month", tr("Month")) + "</div>" +
      (cap.period === "day" ? "" : '<label class="sa-field"><span>' + esc(tr("Reset day")) + "</span>" + select("cap-reset", cap.resetDay, days, tr("Reset day")) + "</label>") +
      '<button class="outline" type="button" data-sa="meter-reset">' + esc(tr("Reset meter")) + "</button>" +
      '<p class="phandle">' + esc(tr("Counted on this device only. Nothing is sent anywhere.")) + "</p></section>";
  }

  /* System items on the Notifications page. */
  function notesHtml() {
    var s = state();
    var list = s.log.filter(function (e) { return !e.gone; }).slice(-20).reverse();
    if (!list.length) return "";
    return '<section class="sa-notes" aria-label="' + esc(tr("System")) + '">' + list.map(function (e) {
      var def = byId(e.id);
      var when = new Date(e.at);
      var time = when.toLocaleString ? when.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      return '<article class="sa-note v-' + variantOf(e.level) + '" data-sa-note="' + e.at + '">' +
        '<span class="sa-note-ico" aria-hidden="true">' + glyph(def ? def.icon : "warning") + "</span>" +
        '<div class="sa-note-copy"><span class="sa-note-kicker">' + esc(tr("System")) + " · " + esc(kickerOf(e.level)) + " · " + esc(time) + "</span>" +
        "<b>" + esc(e.title) + "</b><p>" + esc(e.desc) + "</p>" +
        '<a class="sa-note-link" href="' + esc(e.href) + '" data-sa="note-open" data-id="' + esc(e.id) + '">' + esc(e.action || tr("Open settings")) + "</a></div>" +
        '<button class="icon-btn sa-note-x" type="button" data-sa="note-dismiss" data-at="' + e.at + '" aria-label="' + esc(tr("Dismiss")) + '">' + glyph("close") + "</button></article>";
    }).join("") + "</section>";
  }

  function redraw(sel, html) {
    var doc = root.document;
    var box = doc && doc.querySelector ? doc.querySelector(sel) : null;
    if (!box || !box.parentNode) return;
    var holder = doc.createElement("div");
    holder.innerHTML = html();
    box.parentNode.replaceChild(holder.firstChild, box);
  }

  function preview(variant) {
    var sample = {
      info: ["mobile-data", "info", { level: "info", vars: {} }],
      warning: ["storage-quota", "warning", { used: 8.1 * GB, limit: 10 * GB, pct: 81 }],
      critical: ["data-cap", "critical", { used: 4.8 * GB, limit: 5 * GB, pct: 96, vars: { when: whenText("month"), reset: "Nov 1" } }],
      limit: ["cache-limit", "limit", { used: 5 * GB, limit: 5 * GB, pct: 100 }]
    }[variant];
    if (!sample) return;
    showAlert(byId(sample[0]), sample[1], varsOf(byId(sample[0]), sample[2]));
  }

  function onAct(el, event) {
    var act = el.getAttribute("data-sa");
    var p = prefs();
    if (act === "back") { goBack(); return true; }
    if (act === "note-dismiss") {
      var at = Number(el.getAttribute("data-at"));
      var s = state();
      s.log.forEach(function (e) { if (e.at === at) e.gone = true; });
      saveState(s);
      var row = el.closest ? el.closest("[data-sa-note]") : null;
      if (row && row.parentNode) row.parentNode.removeChild(row);
      return true;
    }
    if (act === "note-open") {
      var def = byId(el.getAttribute("data-id"));
      if (def) { if (event) event.preventDefault(); openSettings(def, { manual: true, title: def.label(), desc: "", level: "info" }); }
      return true;
    }
    if (act === "preview") { preview(el.getAttribute("data-value")); return true; }
    if (act === "alert") { var id = el.getAttribute("data-id"); p.off[id] = !p.off[id]; setPrefs({ off: p.off }); }
    else if (act === "auto-one") { var aid = el.getAttribute("data-id"); p.autoOff[aid] = autoOn(aid); setPrefs({ autoOff: p.autoOff }); }
    else if (act === "auto") setPrefs({ autoOpen: !p.autoOpen });
    else if (act === "quiet") setPrefs({ quiet: !p.quiet });
    else if (act === "vibrate") setPrefs({ vibrate: !p.vibrate });
    else if (act === "sound") { setPrefs({ sound: !p.sound }); if (!p.sound) unlockAudio(); }
    else if (act === "feedback-test") { unlockAudio(); feedback(null, "critical", null, { test: true }); return true; }
    else if (act === "cap-on" || act === "cap-period" || act === "meter-reset") {
      var m = meter();
      if (act === "cap-on") m.cap.on = !m.cap.on;
      else if (act === "cap-period") { m.cap.period = el.getAttribute("data-value"); m.cap.resetDay = 1; }
      else if (act === "meter-reset") { var k = dayKey(now()); Object.keys(m.days).forEach(function (d) { if (d >= dayKey(periodStart(m.cap, now()))) delete m.days[d]; }); m.days[k] = 0; }
      saveMeter(m);
      redraw("[data-sa-cap]", dataCapHtml);
      setTimeout(check, 50);
      return true;
    } else return false;
    redraw("[data-sa-settings]", settingsHtml);
    return true;
  }

  function onSelect(el) {
    var act = el.getAttribute("data-sa");
    var val = Number(el.value);
    if (act === "warn") setPrefs({ warn: val });
    else if (act === "crit") setPrefs({ crit: val });
    else if (act === "screen") setPrefs({ screenMin: val });
    else if (act === "quiet-from") setPrefs({ quietFrom: val });
    else if (act === "quiet-to") setPrefs({ quietTo: val });
    else if (act === "cap-bytes" || act === "cap-reset") {
      var m = meter();
      if (act === "cap-bytes") m.cap.bytes = val; else m.cap.resetDay = val;
      saveMeter(m);
      redraw("[data-sa-cap]", dataCapHtml);
      setTimeout(check, 50);
      return;
    } else return;
    redraw("[data-sa-settings]", settingsHtml);
    setTimeout(check, 50);
  }

  /* ---------- start ---------- */

  var started = false;
  function start(opts) {
    if (started) return;
    started = true;
    var doc = root.document;
    opts = opts || {};
    if (doc && doc.addEventListener) {
      doc.addEventListener("click", function (event) {
        var target = event.target;
        if (!target || !target.closest) return;
        var el = target.closest("[data-sa]");
        if (el && el.tagName !== "SELECT" && !el.disabled) {
          if (el.getAttribute("data-sa") !== "note-open") event.preventDefault();
          onAct(el, event);
        }
        /* Settings changed on the problem page: measure again soon. */
        if (redirect.active) setTimeout(check, 300);
      }, true);
      doc.addEventListener("change", function (event) {
        var el = event.target;
        if (el && el.getAttribute && el.getAttribute("data-sa")) onSelect(el);
        if (redirect.active) setTimeout(check, 300);
      });
      doc.addEventListener("keydown", function () { gesture.lastKey = now(); unlockAudio(); }, true);
      doc.addEventListener("pointerdown", function () { gesture.down = true; unlockAudio(); }, true);
      doc.addEventListener("pointerup", function () { gesture.down = false; }, true);
      doc.addEventListener("pointercancel", function () { gesture.down = false; }, true);
      doc.addEventListener("touchmove", function () { gesture.lastMove = now(); }, { capture: true, passive: true });
      doc.addEventListener("visibilitychange", function () {
        if (doc.visibilityState !== "visible") return;
        var later = pendingShow.splice(0);
        later.forEach(function (row) { showAlert(row[0], row[1], row[2]); });
        setTimeout(check, 500);
      });
      doc.addEventListener("viktorych-pressure", function () { setTimeout(check, 100); });
      doc.addEventListener("viktorych-limit", function (event) {
        var d = event && event.detail || {};
        if (d.id) report(d.id, d.reading || (d.level ? { level: d.level, vars: d.vars || {} } : d.used != null ? { used: d.used, limit: d.limit, fmt: d.fmt } : null));
      });
      doc.addEventListener("viktorych-api-status", function (event) {
        var d = event && event.detail || {};
        if (d.status === 429) {
          var wait = Math.min(10 * 60 * 1000, Math.max(5000, Number(d.retryAfter) || 30000));
          rate.until = Math.max(rate.until, now() + wait);
          setTimeout(check, 50);
          // Clear it on its own once the wait is over.
          clearTimeout(rate.timer);
          rate.timer = setTimeout(check, rate.until - now() + 500);
        }
        else if (d.status === 401 && d.authed) { sessionGone = true; setTimeout(check, 50); }
        else if (d.status >= 200 && d.status < 300 && d.authed && sessionGone) { sessionGone = false; setTimeout(check, 50); }
      });
    }
    if (root.addEventListener) {
      root.addEventListener("hashchange", function () {
        if (redirect.active && !onTargetRoute()) { redirect.active = null; stopLoop(); }
        if (redirect.pending) tryRedirect();
      });
    }
    var nav = root.navigator || {};
    if (nav.storage && nav.storage.persisted) nav.storage.persisted().then(function (ok) { persistAsked = !ok; }).catch(function () {});
    if (nav.connection && nav.connection.addEventListener) nav.connection.addEventListener("change", function () { setTimeout(check, 200); });
    watchResources();
    if (opts.timers === false) return;
    setTimeout(check, 8000);
    setInterval(function () {
      if (doc && doc.visibilityState === "visible") addScreen(15000);
    }, 15000);
    setInterval(function () { check(); }, 60000);
  }

  root.ViktorychSettingAlerts = {
    ALERTS: ALERTS,
    prefs: prefs,
    setPrefs: setPrefs,
    evaluate: evaluate,
    measure: measure,
    check: check,
    report: report,
    busyReason: busyReason,
    feedback: feedback,
    unlockAudio: unlockAudio,
    lastFeedback: function () { return lastFeedback; },
    settingsHtml: settingsHtml,
    dataCapHtml: dataCapHtml,
    notesHtml: notesHtml,
    meter: meter,
    addBytes: addBytes,
    periodStart: periodStart,
    periodEnd: periodEnd,
    goBack: goBack,
    preview: preview,
    state: state,
    redirectState: function () {
      return { pending: redirect.pending ? redirect.pending.id : "", counting: !!redirect.countdown, active: redirect.active ? { id: redirect.active.id, from: redirect.active.from, to: redirect.active.to } : null };
    },
    start: start
  };

  if (!root.__SA_NO_AUTOSTART && root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", function () { start(); });
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
