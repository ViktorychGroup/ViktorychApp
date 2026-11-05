/* Guided device and data-plan setup for Viktrych. Detection uses only what
   the browser actually reports. Carrier plans, APNs and OS switches are
   listed as guidance and are never written. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychDeviceSetup = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var REVERT_KEY = "viktorych-ai-device-revert-v1";
  var OUTSIDE = ["carrier", "os-data", "permissions", "os-autoplay"];

  function asked(text) {
    return /set up this device|set this device up|set up my device|setup this device|data plan|non-?wi-?fi|mobile data plan|cellular plan|configura (este |el )?dispositivo|plan de datos|sin wifi|настро(й|ить) (это )?устройство|тариф|мобильн\w* интернет|इस डिवाइस को सेट|डेटा प्लान/i.test(String(text || ""));
  }

  function readSignals(env) {
    env = env || {};
    var conn = env.connection || null;
    var type = conn && conn.type ? String(conn.type) : "";
    var effective = conn && conn.effectiveType ? String(conn.effectiveType) : "";
    var link = "unknown";
    var linkWhy = conn ? "untyped" : "none";
    if (env.onLine === false) { link = "offline"; linkWhy = "offline"; }
    else if (type === "wifi" || type === "ethernet" || type === "wimax") { link = "wifi"; linkWhy = "type"; }
    else if (type === "cellular") { link = "cellular"; linkWhy = "type"; }
    else if (effective === "slow-2g" || effective === "2g") { link = "slow"; linkWhy = "effectiveType"; }
    else if (conn && conn.saveData) { link = "constrained"; linkWhy = "saveData"; }
    var memory = Number(env.deviceMemory) || 0;
    var cores = Number(env.hardwareConcurrency) || 0;
    var battery = env.battery == null || env.battery === "" ? null : Number(env.battery);
    if (battery != null && !isFinite(battery)) battery = null;
    return {
      link: link,
      linkWhy: linkWhy,
      hasConnectionApi: !!conn,
      saveData: !!(conn && conn.saveData),
      effectiveType: effective,
      type: type,
      memory: memory,
      cores: cores,
      lowEnd: (memory > 0 && memory <= 2) || (cores > 0 && cores <= 2),
      reducedMotion: !!env.reducedMotion,
      phone: !!env.mobile,
      vibrate: !!env.vibrate,
      battery: battery,
      charging: env.charging == null ? null : !!env.charging,
      onLine: env.onLine !== false
    };
  }

  function dataPlan(signals, choice) {
    if (choice === "cellular") return true;
    if (choice === "wifi") return false;
    if (choice === "unknown") return null;
    if (signals.link === "cellular" || signals.link === "slow" || signals.link === "constrained") return true;
    if (signals.link === "wifi") return false;
    return null;
  }

  function dedupe(rows) {
    var seen = {};
    var out = [];
    rows.forEach(function (row) {
      if (seen[row.id]) return;
      seen[row.id] = 1;
      out.push(row);
    });
    return out;
  }

  function recommend(signals, current, choice) {
    signals = signals || readSignals({});
    current = current || {};
    var plan = dataPlan(signals, choice);
    var rows = [];
    function push(id, to, why) {
      var from = Object.prototype.hasOwnProperty.call(current, id) ? current[id] : null;
      if (from === to) return;
      rows.push({ id: id, from: from, to: to, why: why, on: true });
    }
    if (plan === true) {
      push("saveData", true, "data");
      push("autoplay", "wifi", "data");
      push("videoHd", false, "data");
      push("imageLoad", "wifi", "data");
      push("imageSize", "small", "data");
      push("linkPreviews", "text", "data");
      push("preload", "defer", "data");
      push("syncEvery", "slow", "data");
      push("backgroundLive", false, "data");
      push("updateDownload", "wifi", "data");
      push("livePreview", "off", "data");
      push("reactionsData", "lite", "data");
      push("communityNotesData", "lite", "data");
      push("homePills", false, "data");
    } else if (plan === false) {
      push("saveData", false, "wifi");
      push("autoplay", "all", "wifi");
      push("videoHd", true, "wifi");
      push("imageLoad", "always", "wifi");
      push("imageSize", "auto", "wifi");
      push("linkPreviews", "full", "wifi");
      push("preload", "idle", "wifi");
      push("syncEvery", "normal", "wifi");
      push("backgroundLive", true, "wifi");
      push("updateDownload", "always", "wifi");
      push("livePreview", "auto", "wifi");
      push("reactionsData", "auto", "wifi");
      push("communityNotesData", "auto", "wifi");
      push("homePills", true, "wifi");
    }
    if (signals.reducedMotion) push("reduceMotion", true, "motion");
    else if (signals.lowEnd) push("reduceMotion", true, "device");
    if (signals.lowEnd) {
      push("syncEvery", "slow", "device");
      push("livePreview", "off", "device");
      push("preload", "defer", "device");
      push("backgroundLive", false, "device");
      push("deviceLevel", "light", "device");
    }
    if (signals.phone) push("haptics", !!signals.vibrate, signals.vibrate ? "haptics" : "no-vibrate");
    else push("haptics", false, "desktop");
    if (signals.battery != null && signals.battery < 0.2 && signals.charging === false) {
      push("syncEvery", "slow", "battery");
      push("backgroundLive", false, "battery");
    }
    return {
      rows: dedupe(rows),
      plan: plan,
      needsChoice: plan === null,
      outside: OUTSIDE.slice(),
      signals: signals,
      choice: choice || ""
    };
  }

  function selected(plan) {
    return (plan.rows || []).filter(function (row) { return row.on !== false; });
  }

  function memoryStore() {
    return {
      get: function (key) { try { return localStorage.getItem(key); } catch (err) { return null; } },
      set: function (key, value) { try { localStorage.setItem(key, value); } catch (err) { /* private mode */ } },
      remove: function (key) { try { localStorage.removeItem(key); } catch (err) { /* private mode */ } }
    };
  }

  function saveRevert(rows, store) {
    store = store || memoryStore();
    var kept = (rows || []).map(function (row) { return { id: row.id, from: row.from, to: row.to }; });
    store.set(REVERT_KEY, JSON.stringify({ at: Date.now(), rows: kept }));
    return kept;
  }

  function loadRevert(store) {
    store = store || memoryStore();
    try {
      var parsed = JSON.parse(store.get(REVERT_KEY) || "null");
      return parsed && Array.isArray(parsed.rows) ? parsed : null;
    } catch (err) { return null; }
  }

  function clearRevert(store) {
    (store || memoryStore()).remove(REVERT_KEY);
  }

  function browserEnv() {
    var nav = typeof navigator !== "undefined" ? navigator : {};
    var conn = nav.connection || nav.mozConnection || nav.webkitConnection || null;
    var reduced = false;
    var narrow = false;
    try { reduced = !!(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (err) { reduced = false; }
    try { narrow = !!(typeof matchMedia === "function" && matchMedia("(max-width: 699px)").matches); } catch (err) { narrow = false; }
    var ua = String(nav.userAgent || "");
    return {
      connection: conn,
      onLine: nav.onLine !== false,
      deviceMemory: Number(nav.deviceMemory) || 0,
      hardwareConcurrency: Number(nav.hardwareConcurrency) || 0,
      mobile: !!(nav.userAgentData && nav.userAgentData.mobile) || /Android|iPhone|iPad|Mobile/i.test(ua) || narrow,
      reducedMotion: reduced,
      vibrate: typeof nav.vibrate === "function"
    };
  }

  return {
    asked: asked,
    readSignals: readSignals,
    recommend: recommend,
    selected: selected,
    saveRevert: saveRevert,
    loadRevert: loadRevert,
    clearRevert: clearRevert,
    browserEnv: browserEnv,
    outside: OUTSIDE
  };
});
