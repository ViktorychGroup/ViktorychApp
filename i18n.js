/* Interface language. English, Russian, Spanish, and Hindi packs register with addPack. */
(function (root) {
  var KEY = "superintelapp-lang";
  var PACKS = {};
  var lang = "en";
  var listeners = [];
  var manifestBase = null;
  var manifestUrl = "";

  function valid(code) {
    code = String(code || "").toLowerCase().split("-")[0];
    return code === "en" || code === "ru" || code === "es" || code === "hi" ? code : "";
  }

  function isRuRegion() {
    try {
      if (typeof window !== "undefined" && window.__VIKTORYCH_IS_RU) return true;
      if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("viktorychapp-is-ru") === "1") return true;
      var tz = (typeof Intl !== "undefined" && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : "";
      return /^(Europe\/(Moscow|Samara|Kaliningrad|Volgograd|Kirov|Astrakhan|Ulyanovsk|Saratov)|Asia\/(Yekaterinburg|Omsk|Novosibirsk|Barnaul|Tomsk|Novokuznetsk|Krasnoyarsk|Irkutsk|Chita|Yakutsk|Vladivostok|Magadan|Sakhalin|Srednekolymsk|Kamchatka|Anadyr))$/i.test(tz);
    } catch (err) {
      return false;
    }
  }

  function readSaved() {
    try {
      if (typeof localStorage === "undefined") return isRuRegion() ? "ru" : "en";
      var userPicked = localStorage.getItem("viktorychapp-lang-user-picked") === "1";
      var hasSession = !!localStorage.getItem("viktorychapp-account-v1") || !!localStorage.getItem("viktorychapp-accounts-session-v1");
      var saved = localStorage.getItem(KEY);
      if ((userPicked || hasSession) && valid(saved)) return valid(saved);
      if (isRuRegion()) {
        try { localStorage.setItem(KEY, "ru"); } catch (err) {}
        return "ru";
      }
      if (valid(saved)) return valid(saved);
      if (saved != null) return "en";
      var list = (typeof navigator !== "undefined" && (navigator.languages || [navigator.language])) || [];
      var picked = "en";
      var i;
      for (i = 0; i < list.length; i++) {
        var code = valid(list[i]);
        if (code === "ru" || code === "es" || code === "hi") { picked = code; break; }
      }
      try { localStorage.setItem(KEY, picked); } catch (err) { /* private mode */ }
      return picked;
    } catch (err) {
      return "en";
    }
  }

  lang = readSaved();

  /* Building an Intl formatter costs far more than using one, and a feed
     render formats hundreds of times and counts. Reuse one per locale and
     options. */
  var INTL_CACHE = {};
  function intl(kind, loc, opts) {
    var key = kind + "|" + String(loc) + "|" + (opts ? JSON.stringify(opts) : "");
    var hit = INTL_CACHE[key];
    if (hit) return hit;
    hit = new Intl[kind](loc, opts);
    INTL_CACHE[key] = hit;
    return hit;
  }

  function locale() {
    if (lang === "hi") return "hi-IN";
    return lang === "ru" || lang === "es" ? lang : "en";
  }

  function addPack(code, pack) {
    var key = valid(code);
    if (!key || !pack) return;
    PACKS[key] = pack;
    /* Code that drew before this pack arrived gets one more paint. */
    if (key === lang && listeners.length && !packNotice) {
      packNotice = setTimeout(function () {
        packNotice = 0;
        var i;
        for (i = 0; i < listeners.length; i++) {
          try { listeners[i](lang); } catch (err) { /* keep going */ }
        }
      }, 0);
    }
  }
  var packNotice = 0;

  /* The saved language's pack may have been skipped at boot when the choice
     was not yet certain; fetch it once the page is up. */
  function ensureCurrentPack() {
    if (lang !== "en" && !PACKS[lang] && !packLoads[lang]) {
      var want = lang;
      loadPack(want, function () { if (lang === want && PACKS[want]) setLang(want); });
    }
  }

  function lookup(key) {
    var pack = PACKS[lang] || {};
    var en = PACKS.en || {};
    if (Object.prototype.hasOwnProperty.call(pack, key)) return pack[key];
    if (Object.prototype.hasOwnProperty.call(en, key)) return en[key];
    return key;
  }

  function fill(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, function (_, name) {
      return vars[name] == null ? "" : String(vars[name]);
    });
  }

  function t(key, vars) {
    return fill(lookup(key), vars);
  }

  // Full product: brand.name plus brand.app (ViktorychApp), brand.music
  // (ViktorychMusic), or brand.search (ViktorychSearch). Tight labels use
  // brand.short: pwa (ViktorychApp), musicShort (ViktorychMusic), and
  // searchShort (ViktorychSearch). A rebrand edits those pack values.
  // No separator, so a space or a translated suffix belongs in the pack value.
  function productName(kind) {
    var tight = kind === "pwa" || kind === "musicShort" || kind === "searchShort";
    var stem = tight ? t("brand.short") : t("brand.name");
    var suffix = t("brand.app");
    if (kind === "music" || kind === "musicShort") suffix = t("brand.music");
    else if (kind === "search" || kind === "searchShort") suffix = t("brand.search");
    return stem + suffix;
  }

  function formatInt(n) {
    var value = Math.trunc(Number(n) || 0);
    try { return intl("NumberFormat", locale()).format(value); }
    catch (err) { return String(value); }
  }

  function tn(key, n, vars) {
    var value = Number(n);
    if (!isFinite(value)) value = 0;
    var cat = "other";
    try { cat = intl("PluralRules", locale()).select(value); } catch (err) { /* one form */ }
    var chosen = key + "." + cat;
    if (lookup(chosen) === chosen && cat !== "other") chosen = key + ".other";
    var data = { n: formatInt(value) };
    if (vars) {
      for (var name in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, name)) data[name] = vars[name];
      }
    }
    return t(chosen, data);
  }

  function formatCount(n, compactFrom) {
    n = Number(n);
    if (!isFinite(n)) return "";
    var abs = Math.abs(n);
    var loc = locale();
    var floor = Number(compactFrom) > 0 ? Number(compactFrom) : 10000;
    if (abs < floor) {
      try { return intl("NumberFormat", loc, { maximumFractionDigits: 0 }).format(Math.trunc(n)); }
      catch (err) { return String(Math.trunc(n)); }
    }
    if (lang === "hi") {
      // Indian grouping: हज़ार, लाख, करोड़, अरब.
      try {
        return new Intl.NumberFormat("hi-IN", { notation: "compact", maximumFractionDigits: 1 }).format(n)
          .replace("क॰", "करोड़").replace("अ॰", "अरब").replace("ख॰", "खरब");
      } catch (err) { /* the generic suffixes below */ }
    }
    var div = abs < 1e6 ? 1e3 : abs < 1e9 ? 1e6 : 1e9;
    var suffix = abs < 1e6 ? t("num.k") : abs < 1e9 ? t("num.m") : t("num.b");
    // Like X: cut, never round up (1,999 -> 1.9K), one decimal under 100
    // units (5.2K, 1.4M) and none from 100 up (356K), so a count always fits.
    var units = Math.abs(n) / div;
    var scaled = units >= 100 ? Math.trunc(units) : Math.trunc(units * 10) / 10;
    if (n < 0) scaled = -scaled;
    var digits = Math.abs(scaled) % 1 ? 1 : 0;
    var formatted;
    try {
      formatted = intl("NumberFormat", loc, { minimumFractionDigits: digits, maximumFractionDigits: 1 }).format(scaled);
    } catch (err) {
      formatted = digits ? scaled.toFixed(1) : String(Math.round(scaled));
    }
    return formatted + suffix;
  }

  function relTime(iso) {
    var then = new Date(iso).getTime();
    if (!then) return "";
    var sec = Math.max(0, (Date.now() - then) / 1000);
    var loc = locale();
    var num = function (value) {
      try { return intl("NumberFormat", loc).format(value); }
      catch (err) { return String(value); }
    };
    if (sec < 60) return num(Math.max(1, Math.floor(sec))) + t("time.s");
    if (sec < 3600) return num(Math.floor(sec / 60)) + t("time.m");
    if (sec < 86400) return num(Math.floor(sec / 3600)) + t("time.h");
    var d = new Date(iso);
    var opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    try { return intl("DateTimeFormat", loc, opts).format(d); }
    catch (err) { return ""; }
  }

  function fullTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var loc = locale();
    try {
      var clock = intl("DateTimeFormat", loc, { hour: "numeric", minute: "2-digit" }).format(d);
      var date = intl("DateTimeFormat", loc, { month: "short", day: "numeric", year: "numeric" }).format(d);
      return clock + " · " + date;
    } catch (err) {
      return "";
    }
  }

  function joined(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var formatted;
    try { formatted = intl("DateTimeFormat", locale(), { month: "long", year: "numeric" }).format(d); }
    catch (err) { return ""; }
    return t("Joined {date}", { date: formatted });
  }

  function storyAge(iso) {
    var then = new Date(iso).getTime();
    if (!then) return "";
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    var loc = locale();
    var num = function (value) {
      try { return intl("NumberFormat", loc).format(value); }
      catch (err) { return String(value); }
    };
    if (seconds < 45) return t("now");
    if (seconds < 3600) return num(Math.max(1, Math.round(seconds / 60))) + t("time.m");
    if (seconds < 86400) return num(Math.max(1, Math.round(seconds / 3600))) + t("time.h");
    return t("24h");
  }

  function endonym(code) {
    if (code === "ru") return "Русский";
    if (code === "es") return "Español";
    if (code === "hi") return "हिन्दी";
    return "English";
  }

  function applyChrome() {
    if (typeof document === "undefined") return;
    document.documentElement.lang = locale();
    var nodes = document.querySelectorAll("[data-i18n]");
    var i;
    for (i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n");
      if (key) nodes[i].textContent = t(key);
    }
    var aria = document.querySelectorAll("[data-i18n-aria]");
    for (i = 0; i < aria.length; i++) {
      var label = aria[i].getAttribute("data-i18n-aria");
      if (label) aria[i].setAttribute("aria-label", t(label));
    }
    var title = document.querySelector("title");
    if (title && title.getAttribute("data-i18n")) title.textContent = t(title.getAttribute("data-i18n"));
  }

  function brandManifest(data) {
    var next = JSON.parse(JSON.stringify(data || {}));
    next.lang = locale();
    next.name = productName("app");
    next.short_name = productName("pwa");
    if (next.description) next.description = t("manifest.description");
    var shortcuts = next.shortcuts || [];
    var s;
    for (s = 0; s < shortcuts.length; s++) {
      var url = String(shortcuts[s].url || "");
      if (url.indexOf("#/music") >= 0) {
        shortcuts[s].name = productName("music");
        shortcuts[s].short_name = productName("musicShort");
        continue;
      }
      var translated = t("manifest." + shortcuts[s].name);
      if (translated && translated !== "manifest." + shortcuts[s].name) {
        shortcuts[s].name = translated;
        shortcuts[s].short_name = translated;
      }
    }
    var shots = next.screenshots || [];
    for (s = 0; s < shots.length; s++) {
      if (shots[s].label) shots[s].label = t("Home timeline");
    }
    return next;
  }

  function paintBrand() {
    if (typeof document === "undefined") return;
    var app = productName("app");
    var pwa = productName("pwa");
    document.documentElement.lang = locale();
    var metas = [
      ["meta[name='application-name']", pwa],
      ["meta[name='apple-mobile-web-app-title']", pwa],
      ["meta[property='og:site_name']", app],
      ["meta[property='og:title']", app],
      ["meta[property='og:image:alt']", app],
      ["meta[name='twitter:title']", app]
    ];
    var i;
    for (i = 0; i < metas.length; i++) {
      var node = document.querySelector(metas[i][0]);
      if (node) node.setAttribute("content", metas[i][1]);
    }
  }

  var MANIFEST_URL_KEYS = { id: 1, start_url: 1, scope: 1, src: 1, url: 1, action: 1 };
  function absoluteManifest(data, href) {
    var base;
    try { base = new URL(href, typeof location !== "undefined" ? location.href : undefined).href; } catch (err) { return data; }
    var walk = function (node) {
      if (!node || typeof node !== "object") return;
      var key;
      for (key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var value = node[key];
        if (typeof value === "string" && MANIFEST_URL_KEYS[key] && !/^[a-z][a-z0-9+.-]*:/i.test(value)) {
          try { node[key] = new URL(value, base).href.replace(/%25s/g, "%s"); } catch (err) { /* keep the original */ }
        } else if (value && typeof value === "object") {
          walk(value);
        }
      }
    };
    walk(data);
    return data;
  }

  function updateManifest() {
    if (typeof document === "undefined" || typeof fetch === "undefined") return;
    var link = document.querySelector('link[rel="manifest"]');
    if (!link) return;
    var apply = function (data) {
      // A blob: manifest has no folder of its own, so every relative URL in it
      // (start_url, scope, icons) would be invalid and Chrome and Edge would
      // refuse to install the app. Resolve them against the real manifest URL.
      var next = absoluteManifest(brandManifest(data), manifestUrl || "manifest.webmanifest");
      paintBrand();
      var blob = new Blob([JSON.stringify(next)], { type: "application/manifest+json" });
      var url = URL.createObjectURL(blob);
      var prev = link.getAttribute("href") || "";
      link.setAttribute("href", url);
      if (prev.indexOf("blob:") === 0) URL.revokeObjectURL(prev);
    };
    if (manifestBase) { apply(manifestBase); return; }
    var href = manifestUrl || link.getAttribute("href") || "manifest.webmanifest";
    if (href.indexOf("blob:") === 0) return;
    manifestUrl = href;
    fetch(href).then(function (res) { return res.json(); }).then(function (data) {
      manifestBase = data;
      apply(data);
    }).catch(function () { /* the static manifest stays in English until the next try */ });
  }

  var packLoads = {};
  function loadPack(code, then) {
    if (typeof document === "undefined" || PACKS[code] || code === "en") { then(); return; }
    if (packLoads[code]) { packLoads[code].push(then); return; }
    packLoads[code] = [then];
    var el = document.createElement("script");
    el.src = "i18n/" + code + ".js";
    el.onload = el.onerror = function () {
      var list = packLoads[code] || [];
      delete packLoads[code];
      list.forEach(function (fn) { try { fn(); } catch (err) { /* keep going */ } });
    };
    (document.head || document.documentElement).appendChild(el);
  }

  function setLang(code) {
    var next = valid(code) || "en";
    if (!PACKS[next] && next !== "en" && typeof document !== "undefined") {
      lang = next;
      try { localStorage.setItem(KEY, next); } catch (err) { /* private mode */ }
      loadPack(next, function () { if (lang === next) setLang(next); });
      return;
    }
    lang = next;
    try { localStorage.setItem(KEY, next); } catch (err) { /* private mode */ }
    applyChrome();
    paintBrand();
    updateManifest();
    var i;
    for (i = 0; i < listeners.length; i++) {
      try { listeners[i](next); } catch (err) { /* a listener must not block the switch */ }
    }
  }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
  }

  function getLang() { return lang; }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("viktorych-late", ensureCurrentPack);
  }

  root.SI18n = {
    addPack: addPack,
    t: t,
    tn: tn,
    setLang: setLang,
    getLang: getLang,
    locale: locale,
    endonym: endonym,
    formatCount: formatCount,
    formatInt: formatInt,
    relTime: relTime,
    fullTime: fullTime,
    joined: joined,
    storyAge: storyAge,
    productName: productName,
    brandManifest: brandManifest,
    onChange: onChange,
    applyChrome: applyChrome,
    updateManifest: updateManifest,
    absoluteManifest: absoluteManifest
  };
  root.t = t;
  root.tn = tn;

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        applyChrome();
        paintBrand();
        updateManifest();
      });
    } else {
      applyChrome();
      paintBrand();
      updateManifest();
    }
  }
})(typeof self !== "undefined" ? self : this);
