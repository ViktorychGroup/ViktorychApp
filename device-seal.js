/* Data on this device. Removing the home-screen icon does not delete browser
   storage on Android or computers, so this file keeps leftovers harmless:
   - Secrets kept in localStorage (session tokens, drafts, friend messages,
     private lists, keys, saved places) are encrypted at rest with a device
     key. The key is a non-extractable AES-GCM WebCrypto key in IndexedDB.
     Sign-out, expiry and "Delete all data on this device" destroy the key,
     so any copy left behind cannot be read.
   - When the app has not been opened for N days (default 30), the next open
     (or a periodic service worker check) deletes private data and sessions.
   - wipeAll() clears localStorage, sessionStorage, every IndexedDB database,
     Cache Storage, the origin private file system, service workers and
     cookies, then reloads to a clean start.
   Runs first in <head>. Reads stay synchronous: the decrypted copy lives in
   memory and in this tab's sessionStorage only. */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root && root.document && root.localStorage !== undefined && !root.__VSEAL_MANUAL) {
    var api = mod.create(root);
    root.ViktorychSeal = api;
    try { api.boot(); } catch (err) { /* storage stays as it was */ }
  }
})(typeof self !== "undefined" ? self : this, function () {
  var VAULT_KEY = "viktorychapp-vault-v1";
  var TAB_KEY = "viktorychapp-vault-tab";
  var RELOAD_KEY = "viktorychapp-vault-reloaded";
  var NOTICE_KEY = "viktorychapp-wipe-notice";
  var EXPIRY_KEY = "viktorychapp-expiry-v1";
  var LAST_KEY = "viktorychapp-last-open";
  var DBS_KEY = "viktorychapp-dbs-seen";
  var KEY_DB = "viktorych-device-key";
  var DAY = 24 * 60 * 60 * 1000;
  var DEFAULT_DAYS = 30;
  var DAY_CHOICES = [7, 14, 30, 60, 90, 0];
  // Databases the app opens. The live list from indexedDB.databases() and
  // every name opened on this device are added at wipe time.
  var KNOWN_DBS = ["superintel-history", "viktorych-drive", "viktorychapp-live", "superintelapp-live", "sintel-music", "superintelapp-sw", "viktorych-discord", "viktorych-lock", "viktorychapp-device-search", "viktorych-ai", "viktorych-servers", "viktorych-comments", KEY_DB];
  // Private databases removed on expiry. Public feed caches can stay.
  var PRIVATE_DBS = ["viktorych-lock", "viktorych-discord", "viktorych-servers", "viktorych-drive", "viktorychapp-device-search"];
  var PREFIX = "(?:viktorychapp|superintelapp|viktorych|rss-" + "feeds)-";
  var SENSITIVE = new RegExp(
    "^" + PREFIX + "(?:account-v1|accounts-session(?:-v1)?|pending-v1)$" +
    "|draft" +
    "|friend-(?:threads|outbox)" +
    "|nostr-key" +
    "|live-translate-key" +
    "|private-list" +
    "|-geo-v\\d" +
    "|weather-(?:home|places)", "i");

  function isSensitive(name) {
    var text = String(name == null ? "" : name);
    if (!text || text === VAULT_KEY || text === TAB_KEY) return false;
    if (text.indexOf("viktorychapp-lock") === 0) return false;
    return SENSITIVE.test(text);
  }

  function b64(bytes) {
    var raw = new Uint8Array(bytes);
    var text = "";
    for (var i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);
    return btoa(text);
  }
  function unb64(text) {
    var raw = atob(String(text || ""));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function parse(text, fallback) {
    if (text == null || text === "") return fallback;
    try { var v = JSON.parse(text); return v == null ? fallback : v; } catch (err) { return fallback; }
  }

  function create(env) {
    var ls = null;
    var ss = null;
    try { ls = env.localStorage || null; } catch (err) { ls = null; }
    try { ss = env.sessionStorage || null; } catch (err) { ss = null; }
    var subtle = env.crypto && env.crypto.subtle ? env.crypto.subtle : null;
    var idb = null;
    try { idb = env.indexedDB || null; } catch (err) { idb = null; }
    var orig = null;
    var active = false;
    var ready = true;
    var wiping = false;
    var map = {};
    var vaultNames = [];
    var misses = {};
    var touched = {};
    var legacy = {};
    var keyPromise = null;
    var flushTimer = null;
    var flushing = null;
    var dirty = false;
    var readyWaiters = [];
    var readyPromise = null;
    var expiredNow = false;
    var cleared = false;
    var clearGen = 0;

    function now() { return env.__now ? env.__now() : Date.now(); }
    // Raw access that skips the encryption layer.
    function rawGet(store, k) { try { return orig && store === ls ? orig.get.call(store, k) : store.getItem(k); } catch (err) { return null; } }
    function rawSet(store, k, v) { try { if (orig && store === ls) orig.set.call(store, k, v); else store.setItem(k, v); } catch (err) { /* quota */ } }
    function rawRemove(store, k) { try { if (orig && store === ls) orig.remove.call(store, k); else store.removeItem(k); } catch (err) { /* gone */ } }
    function rawKeys(store) {
      var out = [];
      try {
        var n = orig && store === ls ? orig.len.call(store) : store.length;
        for (var i = 0; i < n; i++) out.push(orig && store === ls ? orig.key.call(store, i) : store.key(i));
      } catch (err) { /* private mode */ }
      return out.filter(function (k) { return k != null; });
    }

    function markReady() {
      ready = true;
      var list = readyWaiters;
      readyWaiters = [];
      list.forEach(function (fn) { try { fn(); } catch (err) { /* keep going */ } });
    }
    function whenReady() {
      if (ready) return Promise.resolve();
      if (!readyPromise) readyPromise = new Promise(function (resolve) { readyWaiters.push(function () { readyPromise = null; resolve(); }); });
      return readyPromise;
    }

    function saveTab() {
      if (!ss || !ready || wiping) return;
      try { ss.setItem(TAB_KEY, JSON.stringify(map)); } catch (err) { /* the vault still has it */ }
    }

    /* ---------- device key ---------- */
    function openKeyDb() {
      return new Promise(function (resolve, reject) {
        if (!idb) { reject(new Error("idb")); return; }
        var req;
        try { req = idb.open(KEY_DB, 1); } catch (err) { reject(err); return; }
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains("k")) db.createObjectStore("k");
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error("idb")); };
      });
    }
    function kv(db, mode, fn) {
      return new Promise(function (resolve, reject) {
        var tx;
        try { tx = db.transaction("k", mode); } catch (err) { reject(err); return; }
        var out;
        var req = fn(tx.objectStore("k"));
        if (req) req.onsuccess = function () { out = req.result; };
        tx.oncomplete = function () { resolve(out); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error("tx")); };
      });
    }
    function loadKey(createIfMissing) {
      return openKeyDb().then(function (db) {
        return kv(db, "readonly", function (s) { return s.get("device"); }).then(function (key) {
          if (key || !createIfMissing) { db.close(); return { key: key || null, fresh: false }; }
          return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]).then(function (made) {
            return kv(db, "readwrite", function (s) { return s.put(made, "device"); }).then(function () {
              db.close();
              return { key: made, fresh: true };
            });
          });
        });
      });
    }
    function deviceKey() {
      if (!keyPromise) keyPromise = loadKey(true).catch(function (err) { keyPromise = null; throw err; });
      return keyPromise;
    }
    function writeMeta(extra) {
      if (!idb) return Promise.resolve();
      var policy = readPolicy();
      var meta = { lastOpen: Number(rawGet(ls, LAST_KEY)) || now(), days: policy.days, dropPublic: !!policy.dropPublic, expired: false };
      if (extra) Object.keys(extra).forEach(function (k) { meta[k] = extra[k]; });
      return openKeyDb().then(function (db) {
        return kv(db, "readwrite", function (s) { return s.put(meta, "meta"); }).then(function () { db.close(); }, function () { db.close(); });
      }).catch(function () {});
    }
    function readMeta() {
      if (!idb) return Promise.resolve(null);
      return openKeyDb().then(function (db) {
        return kv(db, "readonly", function (s) { return s.get("meta"); }).then(function (m) { db.close(); return m || null; }, function () { db.close(); return null; });
      }).catch(function () { return null; });
    }
    function deleteDb(name) {
      return new Promise(function (resolve) {
        if (!idb || !idb.deleteDatabase) { resolve(); return; }
        var done = false;
        var finish = function () { if (!done) { done = true; resolve(); } };
        try {
          var req = idb.deleteDatabase(name);
          req.onsuccess = req.onerror = finish;
          // An open connection elsewhere delays the delete; it still runs
          // once that page closes, so do not wait for it.
          req.onblocked = finish;
        } catch (err) { finish(); }
        setTimeout(finish, 3000);
      });
    }
    function destroyKey() {
      keyPromise = null;
      map = {};
      vaultNames = [];
      legacy = {};
      clearTimeout(flushTimer);
      flushTimer = null;
      dirty = false;
      if (ls) rawRemove(ls, VAULT_KEY);
      if (ss) rawRemove(ss, TAB_KEY);
      return deleteDb(KEY_DB);
    }

    /* ---------- encrypt / decrypt ---------- */
    function seal(obj) {
      return deviceKey().then(function (got) {
        var iv = env.crypto.getRandomValues(new Uint8Array(12));
        var data = new TextEncoder().encode(JSON.stringify(obj));
        return subtle.encrypt({ name: "AES-GCM", iv: iv }, got.key, data).then(function (ct) {
          return JSON.stringify({ v: 1, names: Object.keys(obj), iv: b64(iv), ct: b64(ct) });
        });
      });
    }
    function open(text) {
      var doc = parse(text, null);
      if (!doc || doc.v !== 1 || !doc.iv || !doc.ct) return Promise.reject(new Error("vault"));
      return loadKey(false).then(function (got) {
        if (!got.key) throw new Error("nokey");
        return subtle.decrypt({ name: "AES-GCM", iv: unb64(doc.iv) }, got.key, unb64(doc.ct)).then(function (plain) {
          var obj = parse(new TextDecoder().decode(plain), null);
          if (!obj || typeof obj !== "object") throw new Error("vault");
          return obj;
        });
      });
    }

    function schedule() {
      if (wiping) return;
      dirty = true;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 40);
    }
    function flush() {
      flushTimer = null;
      if (wiping || !active || cleared) return Promise.resolve();
      if (flushing) { dirty = true; return flushing.then(function () { return dirty && !cleared ? flush() : null; }); }
      dirty = false;
      var gen = clearGen;
      flushing = whenReady().then(function () {
        if (cleared || gen !== clearGen) return {};
        var snapshot = {};
        Object.keys(map).forEach(function (k) { snapshot[k] = map[k]; });
        if (!Object.keys(snapshot).length) {
          rawRemove(ls, VAULT_KEY);
          return snapshot;
        }
        return seal(snapshot).then(function (text) {
          /* clear() can land while the vault is still encrypting. Writing
             that copy afterwards signs the next page back into the account
             the test, or a switch, just removed. */
          if (wiping || cleared || gen !== clearGen) return snapshot;
          rawSet(ls, VAULT_KEY, text);
          return snapshot;
        });
      }).then(function (snapshot) {
        // The encrypted copy is saved: drop plaintext copies of these names.
        Object.keys(legacy).forEach(function (k) {
          if (!(k in map) || snapshot[k] === map[k]) { rawRemove(ls, k); delete legacy[k]; }
        });
        vaultNames = Object.keys(snapshot);
      }).catch(function () {
        // No usable key on this browser: keep plaintext like before.
        passThrough();
      }).then(function () {
        flushing = null;
        if (dirty && !cleared && gen === clearGen) return flush();
      });
      return flushing;
    }
    // Write unsaved values in plaintext so a closing page does not lose
    // them; the next open encrypts them and removes the plaintext copy.
    function emergency() {
      if (!active || wiping || (!flushTimer && !flushing)) return;
      Object.keys(map).forEach(function (k) { rawSet(ls, k, map[k]); legacy[k] = 1; });
    }
    function passThrough() {
      if (!active) return;
      Object.keys(map).forEach(function (k) { rawSet(ls, k, map[k]); });
      rawRemove(ls, VAULT_KEY);
      if (ss) rawRemove(ss, TAB_KEY);
      map = {};
      active = false;
    }

    /* ---------- Storage interception ---------- */
    function install() {
      var S = env.Storage;
      if (!S || !S.prototype || !ls || orig) return false;
      var P = S.prototype;
      var lenDesc = Object.getOwnPropertyDescriptor(P, "length");
      if (!lenDesc || !lenDesc.get) return false;
      orig = { get: P.getItem, set: P.setItem, remove: P.removeItem, clear: P.clear, key: P.key, len: lenDesc.get };
      P.getItem = function (k) {
        if (this === ls && active && isSensitive(k)) {
          var name = String(k);
          if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
          if (!ready && vaultNames.indexOf(name) >= 0) misses[name] = 1;
          return null;
        }
        return orig.get.call(this, k);
      };
      P.setItem = function (k, v) {
        if (this === ls && wiping) return;
        if (this === ls && active && isSensitive(k)) {
          cleared = false;
          var name = String(k);
          map[name] = String(v);
          touched[name] = 1;
          saveTab();
          schedule();
          return;
        }
        return orig.set.call(this, k, v);
      };
      P.removeItem = function (k) {
        if (this === ls && active && isSensitive(k)) {
          var name = String(k);
          delete map[name];
          touched[name] = 1;
          if (legacy[name]) { orig.remove.call(this, name); delete legacy[name]; }
          saveTab();
          schedule();
          return;
        }
        return orig.remove.call(this, k);
      };
      P.clear = function () {
        if (this === ls && active) {
          Object.keys(map).forEach(function (k) { touched[k] = 1; });
          map = {};
          legacy = {};
          vaultNames = [];
          cleared = true;
          clearGen += 1;
          clearTimeout(flushTimer);
          flushTimer = null;
          if (ss) rawRemove(ss, TAB_KEY);
        }
        return orig.clear.call(this);
      };
      P.key = function (i) {
        if (this === ls && active) {
          var n = orig.len.call(this);
          var idx = Number(i) || 0;
          if (idx < n) return orig.key.call(this, idx);
          var names = Object.keys(map).filter(function (k) { return !legacy[k]; });
          return names[idx - n] == null ? null : names[idx - n];
        }
        return orig.key.call(this, i);
      };
      Object.defineProperty(P, "length", {
        configurable: true,
        enumerable: lenDesc.enumerable,
        get: function () {
          var n = orig.len.call(this);
          if (this !== ls || !active) return n;
          return n + Object.keys(map).filter(function (k) { return !legacy[k]; }).length;
        }
      });
      return true;
    }

    function trackDbNames() {
      var F = env.IDBFactory;
      if (!F || !F.prototype || !F.prototype.open || F.prototype.__vsealTracked) return;
      var base = F.prototype.open;
      F.prototype.open = function (name) {
        try {
          var text = String(name || "");
          if (text && text !== KEY_DB && ls) {
            var seen = parse(rawGet(ls, DBS_KEY), []);
            if (Array.isArray(seen) && seen.indexOf(text) < 0 && seen.length < 100) {
              seen.push(text);
              rawSet(ls, DBS_KEY, JSON.stringify(seen));
            }
          }
        } catch (err) { /* the open still runs */ }
        return base.apply(this, arguments);
      };
      F.prototype.__vsealTracked = true;
    }

    /* ---------- expiry policy ---------- */
    function readPolicy() {
      var doc = parse(ls ? rawGet(ls, EXPIRY_KEY) : null, {});
      var days = Number(doc && doc.days);
      if (DAY_CHOICES.indexOf(days) < 0) days = DEFAULT_DAYS;
      return { days: days, dropPublic: !!(doc && doc.dropPublic) };
    }
    function setPolicy(next) {
      var cur = readPolicy();
      var days = next && next.days != null ? Number(next.days) : cur.days;
      if (DAY_CHOICES.indexOf(days) < 0) days = DEFAULT_DAYS;
      var doc = { days: days, dropPublic: next && next.dropPublic != null ? !!next.dropPublic : cur.dropPublic };
      rawSet(ls, EXPIRY_KEY, JSON.stringify(doc));
      writeMeta();
      return doc;
    }
    function isExpired(lastOpen, days, at) {
      if (!days || !lastOpen) return false;
      return (at - Number(lastOpen)) > days * DAY;
    }
    function touch() {
      if (!ls || wiping) return;
      rawSet(ls, LAST_KEY, String(now()));
    }

    /* Private data and sessions go; public feed caches stay unless the
       policy says to drop them. */
    function wipePrivate(reason) {
      var vaultText = ls ? rawGet(ls, VAULT_KEY) : null;
      var account = parse(map["viktorychapp-account-v1"] || (ls ? rawGet(ls, "viktorychapp-account-v1") : null), null);
      var tokenP = Promise.resolve(account && account.token ? String(account.token) : "");
      if (!(account && account.token) && vaultText) {
        tokenP = open(vaultText).then(function (obj) {
          var acc = parse(obj && obj["viktorychapp-account-v1"], null);
          return acc && acc.token ? String(acc.token) : "";
        }).catch(function () { return ""; });
      }
      rawKeys(ls).forEach(function (k) {
        if (isSensitive(k) || k === VAULT_KEY || k.indexOf("viktorychapp-lock") === 0) rawRemove(ls, k);
      });
      cleared = true;
      map = {};
      vaultNames = [];
      legacy = {};
      if (ss) { rawRemove(ss, TAB_KEY); rawSet(ss, NOTICE_KEY, reason || "expired"); }
      tellWorker({ type: "auth", on: false, token: "", wipe: "signout" });
      var jobs = PRIVATE_DBS.map(deleteDb).concat([dropPrivateDocs(), dropPrivateFiles()]);
      jobs.push(tokenP.then(function (token) {
        var out = token ? serverLogout(token) : null;
        // The key goes after the token was read for the server sign-out.
        return Promise.all([out, destroyKey()]);
      }));
      return Promise.all(jobs).then(function () { touch(); return writeMeta(); });
    }
    function serverLogout(token) {
      var cfg = env.VIKTORYCH_ACCOUNTS || {};
      var api = String(cfg.api || "").replace(/\/$/, "");
      if (!api || typeof env.fetch !== "function") return Promise.resolve();
      try {
        return env.fetch(api + "/v1/logout", { method: "POST", credentials: "omit", headers: { Authorization: "Bearer " + token } }).then(function () {}, function () {});
      } catch (err) { return Promise.resolve(); }
    }
    function dropPrivateDocs() {
      return new Promise(function (resolve) {
        if (!idb) { resolve(); return; }
        var req;
        try { req = idb.open("superintelapp-sw"); } catch (err) { resolve(); return; }
        req.onerror = function () { resolve(); };
        req.onupgradeneeded = function () { try { req.transaction.abort(); } catch (err) { /* nothing saved */ } };
        req.onsuccess = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains("docs")) { db.close(); resolve(); return; }
          var tx = db.transaction("docs", "readwrite");
          var cur = tx.objectStore("docs").openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c) return;
            var row = c.value || {};
            var cat = String(row.category || "");
            if (cat === "drafts" || cat === "messages" || cat === "notifications" || /draft|message|\bdm\b/i.test(String(c.key))) c.delete();
            c.continue();
          };
          tx.oncomplete = tx.onerror = tx.onabort = function () { db.close(); resolve(); };
        };
      });
    }
    function dropPrivateFiles() {
      var nav = env.navigator;
      if (!nav || !nav.storage || typeof nav.storage.getDirectory !== "function") return Promise.resolve();
      return nav.storage.getDirectory().then(function (dir) {
        return dir.removeEntry("vapp-private", { recursive: true });
      }).catch(function () {});
    }

    /* ---------- full wipe ---------- */
    function tellWorker(msg) {
      var nav = env.navigator;
      try {
        if (nav && nav.serviceWorker && nav.serviceWorker.controller) nav.serviceWorker.controller.postMessage(msg);
      } catch (err) { /* no worker */ }
    }
    function clearCookies() {
      var doc = env.document;
      if (!doc || typeof doc.cookie !== "string") return 0;
      var names = doc.cookie.split(";").map(function (part) { return part.split("=")[0].trim(); }).filter(Boolean);
      var host = env.location && env.location.hostname ? env.location.hostname : "";
      var path = env.location && env.location.pathname ? env.location.pathname : "/";
      var paths = ["/", path, path.replace(/[^/]*$/, "")];
      var domains = ["", host, "." + host];
      var parts = host.split(".");
      if (parts.length > 2) domains.push("." + parts.slice(-2).join("."));
      names.forEach(function (name) {
        paths.forEach(function (p) {
          domains.forEach(function (d) {
            try { doc.cookie = name + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=" + p + (d ? "; domain=" + d : ""); } catch (err) { /* read-only */ }
          });
        });
      });
      return names.length;
    }
    function allDbNames() {
      var names = KNOWN_DBS.slice();
      parse(ls ? rawGet(ls, DBS_KEY) : null, []).forEach(function (n) { if (names.indexOf(n) < 0) names.push(n); });
      if (!idb || typeof idb.databases !== "function") return Promise.resolve(names);
      return Promise.resolve().then(function () { return idb.databases(); }).then(function (list) {
        (list || []).forEach(function (d) { if (d && d.name && names.indexOf(d.name) < 0) names.push(d.name); });
        return names;
      }).catch(function () { return names; });
    }
    function clearCaches() {
      var c = env.caches;
      if (!c || typeof c.keys !== "function") return Promise.resolve([]);
      return c.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return c.delete(k).catch(function () {}); })).then(function () { return keys; });
      }).catch(function () { return []; });
    }
    function clearFiles() {
      var nav = env.navigator;
      if (!nav || !nav.storage || typeof nav.storage.getDirectory !== "function") return Promise.resolve();
      return nav.storage.getDirectory().then(function (dir) {
        var names = [];
        var it = dir.keys ? dir.keys() : null;
        if (!it) return null;
        function step() {
          return it.next().then(function (r) {
            if (r.done) return null;
            names.push(r.value);
            return step();
          });
        }
        return step().then(function () {
          return Promise.all(names.map(function (n) { return dir.removeEntry(n, { recursive: true }).catch(function () {}); }));
        });
      }).catch(function () {});
    }
    function unregisterWorkers() {
      var nav = env.navigator;
      if (!nav || !nav.serviceWorker || typeof nav.serviceWorker.getRegistrations !== "function") return Promise.resolve(0);
      return nav.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister().catch(function () {}); })).then(function () { return regs.length; });
      }).catch(function () { return 0; });
    }
    function wipeAll(opts) {
      opts = opts || {};
      wiping = true;
      env.__VIKTORYCH_WIPING = true;
      map = {};
      legacy = {};
      vaultNames = [];
      clearTimeout(flushTimer);
      flushTimer = null;
      try {
        if (typeof env.BroadcastChannel === "function") {
          var bc = new env.BroadcastChannel("viktorych-wipe");
          bc.postMessage({ type: "wipe" });
          bc.close();
        }
      } catch (err) { /* other tabs reload on their next open */ }
      tellWorker({ type: "auth", on: false, token: "", wipe: "signout" });
      tellWorker({ type: "account-deleted" });
      var report = { dbs: [], caches: [], workers: 0, cookies: 0 };
      return allDbNames().then(function (names) {
        report.dbs = names;
        keyPromise = null;
        return Promise.all(names.map(deleteDb));
      }).then(clearCaches).then(function (keys) {
        report.caches = keys;
        return clearFiles();
      }).then(unregisterWorkers).then(function (n) {
        report.workers = n;
        report.cookies = clearCookies();
        if (ls) { try { orig ? orig.clear.call(ls) : ls.clear(); } catch (err) { /* private mode */ } }
        if (ss) {
          try { ss.clear(); } catch (err) { /* private mode */ }
          rawSet(ss, NOTICE_KEY, opts.reason || "wiped");
        }
        if (opts.reload !== false && env.location) {
          try { env.location.replace(env.location.pathname || "./"); } catch (err) { /* the page is already clean */ }
        }
        return report;
      });
    }

    /* ---------- boot ---------- */
    function importLegacy() {
      rawKeys(ls).forEach(function (k) {
        if (!isSensitive(k)) return;
        var v = rawGet(ls, k);
        if (v == null) return;
        map[k] = v;
        legacy[k] = 1;
      });
    }
    function afterDecrypt(obj) {
      Object.keys(obj || {}).forEach(function (k) {
        if (cleared || touched[k] || legacy[k]) return;
        map[k] = String(obj[k]);
      });
      markReady();
      saveTab();
      if (Object.keys(legacy).length) schedule();
      var missed = Object.keys(misses).filter(function (k) { return k in map; });
      misses = {};
      // Something read a secret before it was ready; reload once so every
      // script starts with the same data.
      if (missed.length && ss && env.location && !rawGet(ss, RELOAD_KEY)) {
        rawSet(ss, RELOAD_KEY, "1");
        try { env.location.reload(); } catch (err) { /* the next open is fine */ }
      }
    }
    function fromOtherTab(event) {
      if (!event || event.storageArea !== ls || wiping || !active) return;
      if (event.key === null) { map = {}; saveTab(); return; }
      if (event.key !== VAULT_KEY) return;
      if (!event.newValue) { map = {}; saveTab(); return; }
      open(event.newValue).then(function (obj) {
        var before = map;
        map = {};
        Object.keys(obj).forEach(function (k) { map[k] = String(obj[k]); });
        saveTab();
        var names = {};
        Object.keys(before).concat(Object.keys(map)).forEach(function (k) { names[k] = 1; });
        Object.keys(names).forEach(function (k) {
          if (before[k] === map[k]) return;
          try {
            env.dispatchEvent(new env.StorageEvent("storage", { key: k, oldValue: before[k] == null ? null : before[k], newValue: map[k] == null ? null : map[k], storageArea: ls, url: env.location ? env.location.href : "" }));
          } catch (err) { /* old browsers skip the event */ }
        });
      }).catch(function () {});
    }

    function boot() {
      if (!ls) return;
      trackDbNames();
      var can = !!(subtle && idb && env.Storage && typeof env.TextEncoder === "function");
      if (can) active = install();
      var policy = readPolicy();
      var last = Number(rawGet(ls, LAST_KEY)) || 0;
      if (isExpired(last, policy.days, now())) {
        expiredNow = true;
        if (policy.dropPublic) { wipeAll({ reason: "expired" }); return; }
        wipePrivate("expired");
      } else if (active) {
        var tab = ss ? parse(rawGet(ss, TAB_KEY), null) : null;
        if (tab && typeof tab === "object") {
          Object.keys(tab).forEach(function (k) { map[k] = String(tab[k]); });
          importLegacy();
          markReady();
          if (Object.keys(legacy).length) schedule();
        } else {
          importLegacy();
          var vault = rawGet(ls, VAULT_KEY);
          var doc = parse(vault, null);
          if (doc && doc.v === 1) {
            vaultNames = Array.isArray(doc.names) ? doc.names.map(String) : [];
            ready = false;
            open(vault).then(afterDecrypt, function () {
              // The key is gone (expired, wiped or another browser profile):
              // leftovers cannot be read, so drop them.
              rawRemove(ls, VAULT_KEY);
              vaultNames = [];
              afterDecrypt({});
            });
          } else if (Object.keys(legacy).length) {
            schedule();
          }
        }
      }
      if (!expiredNow) {
        touch();
        // The service worker may have destroyed the key while the app was closed.
        readMeta().then(function (m) {
          if (m && m.expired) return wipePrivate("expired").then(function () { if (env.location) env.location.reload(); });
          return writeMeta();
        });
      }
      if (ss && rawGet(ss, RELOAD_KEY) && ready) rawRemove(ss, RELOAD_KEY);
      if (typeof env.addEventListener === "function") {
        env.addEventListener("pagehide", emergency);
        env.addEventListener("storage", fromOtherTab);
        if (env.document && env.document.addEventListener) {
          env.document.addEventListener("visibilitychange", function () {
            if (env.document.visibilityState === "hidden") emergency();
            else touch();
          });
        }
      }
      if (typeof env.BroadcastChannel === "function") {
        try {
          var bc = new env.BroadcastChannel("viktorych-wipe");
          bc.onmessage = function (e) {
            if (e && e.data && e.data.type === "wipe" && !wiping && env.location) {
              wiping = true;
              try { env.location.reload(); } catch (err) { /* closed */ }
            }
          };
        } catch (err) { /* single tab */ }
      }
      setInterval(touch, 6 * 60 * 60 * 1000);
    }

    /* ---------- storage size ---------- */
    function estimate() {
      var nav = env.navigator;
      if (!nav || !nav.storage || typeof nav.storage.estimate !== "function") return Promise.resolve(null);
      return nav.storage.estimate().then(function (e) {
        return { usage: Number(e && e.usage) || 0, quota: Number(e && e.quota) || 0 };
      }).catch(function () { return null; });
    }
    function registerPeriodic() {
      var nav = env.navigator;
      if (!nav || !nav.serviceWorker || !nav.serviceWorker.ready) return;
      nav.serviceWorker.ready.then(function (reg) {
        if (reg && reg.periodicSync && reg.periodicSync.register) {
          return reg.periodicSync.register("vapp-expiry", { minInterval: DAY }).catch(function () {});
        }
      }).catch(function () {});
    }

    return {
      boot: boot,
      isSensitive: isSensitive,
      ready: function () { return whenReady(); },
      has: function (name) {
        var k = String(name);
        return Object.prototype.hasOwnProperty.call(map, k) || vaultNames.indexOf(k) >= 0;
      },
      active: function () { return active; },
      flush: flush,
      destroyKey: destroyKey,
      wipeAll: wipeAll,
      wipePrivate: wipePrivate,
      readPolicy: readPolicy,
      setPolicy: setPolicy,
      isExpired: isExpired,
      expiredNow: function () { return expiredNow; },
      estimate: estimate,
      registerPeriodic: registerPeriodic,
      clearCookies: clearCookies,
      takeNotice: function () {
        if (!ss) return "";
        var v = rawGet(ss, NOTICE_KEY) || "";
        if (v) rawRemove(ss, NOTICE_KEY);
        return v;
      },
      dayChoices: DAY_CHOICES.slice(),
      _raw: function (k) { return ls ? rawGet(ls, k) : null; },
      _rawKeys: function () { return ls ? rawKeys(ls) : []; }
    };
  }

  return {
    create: create,
    isSensitive: isSensitive,
    isExpired: function (lastOpen, days, at) { return !!days && !!lastOpen && (at - Number(lastOpen)) > days * DAY; },
    VAULT_KEY: VAULT_KEY,
    KEY_DB: KEY_DB,
    DEFAULT_DAYS: DEFAULT_DAYS
  };
});
