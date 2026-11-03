/* Notification privacy, like Telegram's "Show sender name" and "Message
   preview". One module for the page and the service worker.

   Pushes from the Worker are tiny and opaque: {v:2,k:kind,i:shortId,n:count}.
   No names, handles, avatars, text or links travel in a push. The service
   worker fills in the text from this device's own cache, and only when the
   person's choices allow names for that kind; otherwise it shows generic copy
   ("New message") with the app icon and never asks a server for details.
   Choices live in STATE.settings.notifPrivacy (synced like other settings)
   and in IndexedDB meta "notif-privacy" so the service worker can read them. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychNotifPrivacy = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  var META_KEY = "notif-privacy";
  var CACHE_KEY = "note-cache";
  var TYPES = ["messages", "mentions", "replies", "quotes", "likes", "reposts", "follows", "notes", "posts"];

  function t(key, vars) {
    var lang = root && root.SI18n;
    if (lang && typeof lang.t === "function") return lang.t(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, name) { return vars && vars[name] != null ? String(vars[name]) : ""; });
  }

  function defaults() {
    var types = {};
    TYPES.forEach(function (id) { types[id] = true; });
    return { names: true, preview: true, banner: true, badge: true, count: true, types: types };
  }

  function normalize(raw) {
    var out = defaults();
    if (!raw || typeof raw !== "object") return out;
    ["names", "preview", "banner", "badge", "count"].forEach(function (key) {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
    });
    if (raw.types && typeof raw.types === "object") {
      TYPES.forEach(function (id) { if (typeof raw.types[id] === "boolean") out.types[id] = raw.types[id]; });
    }
    return out;
  }

  function typeOf(kind) {
    var k = String(kind || "");
    if (k === "dm" || k === "message") return "messages";
    if (k === "mention") return "mentions";
    if (k === "reply") return "replies";
    if (k === "quote") return "quotes";
    if (k === "like") return "likes";
    if (k === "repost") return "reposts";
    if (/^(follow|follow_request|follow_accept|friend_request|friend_accept)$/.test(k)) return "follows";
    if (k === "note" || k === "community_note" || k === "notes") return "notes";
    return "posts";
  }

  function showNames(prefs, kind) {
    var p = normalize(prefs);
    return p.names && p.types[typeOf(kind)] !== false;
  }

  // Telegram only offers a preview while names are on; the same here.
  function showPreview(prefs, kind) {
    return showNames(prefs, kind) && normalize(prefs).preview;
  }

  function genericText(kind) {
    // No sender name or preview: it only asks to open the app and answer.
    if (kind === "tv_signin") return t("Approve sign-in on TV?");
    var type = typeOf(kind);
    if (type === "messages") return t("New message");
    if (type === "mentions") return t("New mention");
    if (type === "replies") return t("New reply");
    if (type === "quotes") return t("New quote");
    if (type === "likes") return t("New like");
    if (type === "reposts") return t("New repost");
    if (type === "follows") return t("New follower");
    if (type === "notes") return t("New Community Note");
    if (kind === "post" || kind === "bell" || kind === "live") return t("New post");
    if (kind === "game_invite") return t("New game invite");
    if (kind === "game_join" || kind === "game_achievement" || kind === "game_board") return t("New game alert");
    if (kind === "feed_request") return t("New source request");
    if (kind === "feed_approved" || kind === "feed_rejected") return t("Your source request was answered");
    return t("New notification");
  }

  // Title with the sender, built on the device from cached data.
  function actionTitle(kind, name, others) {
    var n = Math.max(0, Number(others) || 0);
    var v = { name: name, n: String(n) };
    if (kind === "like") return n > 0 ? t("{name} and {n} others liked your post", v) : t("{name} liked your post", v);
    if (kind === "repost") return n > 0 ? t("{name} and {n} others reposted your post", v) : t("{name} reposted your post", v);
    if (kind === "quote") return t("{name} quoted your post", v);
    if (kind === "reply") return t("{name} replied to you", v);
    if (kind === "mention") return t("{name} mentioned you", v);
    if (kind === "dm") return t("{name} sent you a message", v);
    if (kind === "follow") return t("{name} followed you", v);
    if (kind === "game_invite") return t("{name} invited you to play", v);
    if (kind === "game_join") return t("{name} joined your game", v);
    if (kind === "game_achievement") return t("Game achievement unlocked");
    if (kind === "game_board") return t("Game leaderboard update");
    if (kind === "feed_request") return t("Source request: {name}", v);
    if (kind === "feed_approved") return t("Source request approved: {name}", v);
    if (kind === "feed_rejected") return t("Source request not approved: {name}", v);
    return name;
  }

  // Older full pushes carry an English title key instead of a kind.
  function kindFromTitleKey(key) {
    var k = String(key || "");
    if (/^Source request approved/.test(k)) return "feed_approved";
    if (/^Source request not approved/.test(k)) return "feed_rejected";
    if (/^Source request/.test(k)) return "feed_request";
    if (/liked/.test(k)) return "like";
    if (/reposted/.test(k)) return "repost";
    if (/quoted/.test(k)) return "quote";
    if (/replied/.test(k)) return "reply";
    if (/mentioned/.test(k)) return "mention";
    if (/sent you a message/.test(k)) return "dm";
    if (/follow/.test(k)) return "follow";
    if (/friend request/.test(k)) return "friend_request";
    return "post";
  }

  function appName() {
    var lang = root && root.SI18n;
    if (lang && typeof lang.productName === "function") {
      try { return lang.productName("pwa"); } catch (err) { /* falls through */ }
    }
    return t("Notifications");
  }

  // note: a cached or in-page note ({kind,name,handle,text,avatar,image,hash})
  // or null when the push could not be matched on this device.
  // opts.title: a ready title (for example a translated "{name} liked your post").
  function present(note, prefs, opts) {
    var o = opts || {};
    var n = note || {};
    var kind = n.kind || o.kind || "";
    var named = !!note && showNames(prefs, kind) && !!(n.name || n.handle || o.title);
    var preview = named && showPreview(prefs, kind);
    if (!named) {
      return { title: appName(), body: genericText(kind), icon: "icons/icon-192.png", image: undefined, hash: "#/notifications", generic: true };
    }
    return {
      title: o.title || actionTitle(kind, n.name || ("@" + n.handle), n.others),
      body: preview ? (n.text || o.body || genericText(kind)) : genericText(kind),
      icon: n.avatar || n.icon || "icons/icon-192.png",
      image: preview ? (n.image || undefined) : undefined,
      hash: n.hash || "#/notifications",
      generic: false
    };
  }

  // In-app toast text while the app is open.
  function bannerText(note, prefs) {
    var p = normalize(prefs);
    var kind = (note && note.kind) || "";
    if (p.banner && note && showPreview(p, kind) && note.text) return note.text;
    return genericText(kind);
  }

  function badgeCount(count, prefs) { return normalize(prefs).badge ? Math.max(0, Number(count) || 0) : 0; }
  function titleCount(count, prefs) { return normalize(prefs).count ? Math.max(0, Number(count) || 0) : 0; }

  function b64url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    var b = typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64");
    return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // Content-addressed short id of a note id: the first 9 bytes of SHA-256,
  // 12 characters. The Worker computes the same value for the push.
  function shortId(id) {
    var c = (root && root.crypto) || (typeof crypto !== "undefined" ? crypto : null);
    if (!c || !c.subtle) return Promise.resolve("");
    return c.subtle.digest("SHA-256", new TextEncoder().encode(String(id || ""))).then(function (buf) {
      return b64url(new Uint8Array(buf).slice(0, 9));
    });
  }

  function parsePush(data) {
    var d = data && typeof data === "object" ? data : {};
    if (d.v !== 2) return null;
    return { kind: String(d.k || ""), sid: String(d.i || "").slice(0, 24), count: Math.max(0, Number(d.n) || 0), quiet: d.q === 1 };
  }

  function openDb() {
    var store = root && root.ViktorychStorage;
    return store && store.openDb ? store.openDb() : Promise.reject(new Error("no-db"));
  }
  function metaGet(db, key) {
    return new Promise(function (resolve) {
      try {
        var req = db.transaction("meta", "readonly").objectStore("meta").get(key);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(undefined); };
      } catch (err) { resolve(undefined); }
    });
  }
  function metaSet(db, key, value) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put(value, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (err) { resolve(); }
    });
  }

  function load() {
    return openDb().then(function (db) { return metaGet(db, META_KEY); }).then(normalize, function () { return defaults(); });
  }
  function persist(prefs) {
    var clean = normalize(prefs);
    return openDb().then(function (db) { return metaSet(db, META_KEY, clean); }).then(function () { return clean; }, function () { return clean; });
  }

  // The page keeps a small cache of recent notes, keyed by short id, so a push
  // can be named without a network request. It is private (names and text),
  // so it lives in its own database, "viktorych-notes", which sign-out, the
  // panic wipe and device expiry delete whole. Names are only kept while the
  // person allows them; turning names off empties it. Entries expire after 7 days.
  var NOTES_DB = "viktorych-notes";
  var KEEP_MS = 7 * 24 * 60 * 60 * 1000;
  function notesDb() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === "undefined") { reject(new Error("no-idb")); return; }
      var req = indexedDB.open(NOTES_DB, 1);
      req.onupgradeneeded = function () { if (!req.result.objectStoreNames.contains("c")) req.result.createObjectStore("c"); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function cacheGet(db) {
    return new Promise(function (resolve) {
      try {
        var req = db.transaction("c", "readonly").objectStore("c").get(CACHE_KEY);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(undefined); };
      } catch (err) { resolve(undefined); }
    });
  }
  function cacheSet(db, value) {
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction("c", "readwrite");
        tx.objectStore("c").put(value, CACHE_KEY);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { resolve(); };
      } catch (err) { resolve(); }
    });
  }
  function slim(item) {
    return {
      kind: String(item.kind || ""), name: String(item.name || "").slice(0, 80), handle: String(item.handle || "").slice(0, 80),
      text: String(item.text || "").slice(0, 200), avatar: String(item.avatar || "").slice(0, 400), hash: String(item.hash || "").slice(0, 300),
      others: Number(item.others) || 0, platform: String(item.platform || ""), feedId: String(item.feedId || ""), id: String(item.id || ""),
      kept: Date.now()
    };
  }
  function remember(items, prefs) {
    var p = normalize(prefs);
    return notesDb().then(function (db) {
      if (!p.names) return cacheSet(db, {}).then(function () { db.close(); });
      var list = (items || []).filter(function (item) { return item && item.id; }).slice(0, 120);
      return Promise.all(list.map(function (item) { return shortId(item.id); })).then(function (ids) {
        return cacheGet(db).then(function (prev) {
          var map = prev && typeof prev === "object" ? prev : {};
          var cutoff = Date.now() - KEEP_MS;
          Object.keys(map).forEach(function (k) { if (!map[k] || Number(map[k].kept || 0) < cutoff) delete map[k]; });
          ids.forEach(function (sid, i) { if (sid) map[sid] = slim(list[i]); });
          var keys = Object.keys(map);
          if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(function (k) { delete map[k]; });
          return cacheSet(db, map).then(function () { db.close(); });
        });
      });
    }).catch(function () {});
  }
  function lookup(sid) {
    if (!sid) return Promise.resolve(null);
    return notesDb().then(function (db) {
      return cacheGet(db).then(function (map) {
        db.close();
        var row = map && map[sid];
        return row && Number(row.kept || 0) >= Date.now() - KEEP_MS ? row : null;
      });
    }, function () { return null; });
  }
  function wipe() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.deleteDatabase(NOTES_DB);
        req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
      } catch (err) { resolve(); }
    });
  }

  function settingsHtml(prefs, esc) {
    var p = normalize(prefs);
    var e = typeof esc === "function" ? esc : function (s) { return String(s); };
    function sw(key, label, on, disabled) {
      return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '"' +
        (disabled ? ' aria-disabled="true" disabled' : "") + ' data-act="notif-privacy" data-key="' + key + '"><span>' + e(label) + "</span><i></i></button>";
    }
    var labels = {
      messages: t("Direct messages"), mentions: t("Mentions"), replies: t("Replies"), quotes: t("Quotes"), likes: t("Likes"),
      reposts: t("Reposts"), follows: t("Follows"), notes: t("Community Notes"), posts: t("Posts")
    };
    return '<div class="notif-privacy" data-notif-privacy>' +
      "<h2>" + e(t("Notification privacy")) + "</h2>" +
      sw("names", t("Show sender name"), p.names) +
      sw("preview", t("Show message preview"), p.names && p.preview, !p.names) +
      '<p class="phandle">' + e(t("When names are off, notifications only say what happened, like New message. No names, pictures or text.")) + "</p>" +
      sw("banner", t("Show content in in-app banners"), p.banner) +
      sw("badge", t("Show unread count on the app icon"), p.badge) +
      sw("count", t("Show unread count in the tab title"), p.count) +
      "<h2>" + e(t("Show names and previews for")) + "</h2>" +
      TYPES.map(function (id) { return sw("type:" + id, labels[id], p.names && p.types[id], !p.names); }).join("") +
      '<p class="phandle">' + e(t("Pushes carry no names or text. This device fills them in from what it already has, which also saves data.")) + "</p>" +
      "</div>";
  }

  function toggle(prefs, key) {
    var p = normalize(prefs);
    var k = String(key || "");
    if (k.indexOf("type:") === 0) {
      var id = k.slice(5);
      if (TYPES.indexOf(id) >= 0) p.types[id] = !p.types[id];
    } else if (Object.prototype.hasOwnProperty.call(p, k) && typeof p[k] === "boolean") p[k] = !p[k];
    return p;
  }

  return {
    META_KEY: META_KEY, CACHE_KEY: CACHE_KEY, TYPES: TYPES,
    defaults: defaults, normalize: normalize, typeOf: typeOf, showNames: showNames, showPreview: showPreview,
    genericText: genericText, actionTitle: actionTitle, kindFromTitleKey: kindFromTitleKey, present: present, bannerText: bannerText, badgeCount: badgeCount, titleCount: titleCount,
    shortId: shortId, parsePush: parsePush, load: load, persist: persist, remember: remember, lookup: lookup, wipe: wipe, NOTES_DB: NOTES_DB,
    settingsHtml: settingsHtml, toggle: toggle
  };
});
