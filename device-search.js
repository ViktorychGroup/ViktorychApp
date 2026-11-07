/* Local search over posts already on this device. The index is built in
   memory and stored in IndexedDB when that is available. A miss, a quota
   error, or an empty index falls back to the caller. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychDeviceSearch = api;
})(typeof self !== "undefined" ? self : this, function () {
  var state = { key: "", rows: [], hay: [], feeds: [] };
  var DB = "viktorychapp-device-search";

  function deviceApi() {
    if (typeof self !== "undefined" && self.ViktorychDevice) return self.ViktorychDevice;
    if (typeof window !== "undefined" && window.ViktorychDevice) return window.ViktorychDevice;
    if (typeof require === "function") {
      try { return require("./device.js"); } catch (err) { return null; }
    }
    return null;
  }

  function hay(post) {
    var article = post && post.article;
    var quoted = post && post.quoted;
    var quotedArticle = quoted && quoted.article;
    return ((post && post.text) || "") + " " + ((post && post.title) || "") + " " + ((post && post.author) || "") + " " + ((post && post.handle) || "") + " " + ((article && article.title) || "") + " " + ((article && article.preview) || "") + " " + ((quoted && quoted.text) || "") + " " + ((quotedArticle && quotedArticle.title) || "");
  }

  function keyOf(posts) {
    var list = posts || [];
    var first = list[0] && (list[0].id || list[0].statusId) || "";
    var last = list.length ? (list[list.length - 1].id || "") : "";
    return list.length + ":" + first + ":" + last;
  }

  function indexPosts(posts, feeds) {
    var list = posts || [];
    var key = keyOf(list);
    if (state.key === key && state.rows.length === list.length) return state;
    var rows = [];
    var folded = [];
    for (var i = 0; i < list.length; i++) {
      rows.push(list[i]);
      folded.push(hay(list[i]).toLowerCase());
    }
    state = { key: key, rows: rows, hay: folded, feeds: feeds || [] };
    persist(rows);
    return state;
  }

  function persist(rows) {
    if (typeof indexedDB === "undefined") return;
    var dev = deviceApi();
    var cap = dev && dev.capBytes ? Math.min(dev.capBytes("balanced"), 32 * 1024 * 1024) : 8 * 1024 * 1024;
    var packed = [];
    var total = 0;
    for (var i = rows.length - 1; i >= 0; i--) {
      var text = "";
      try { text = JSON.stringify(rows[i]); } catch (err) { text = ""; }
      if (!text) continue;
      if (total + text.length > cap) break;
      total += text.length;
      packed.push({ id: String(rows[i] && rows[i].id || i), body: text, at: Date.now(), bytes: text.length });
    }
    try {
      var open = indexedDB.open(DB, 1);
      open.onupgradeneeded = function () {
        var db = open.result;
        if (!db.objectStoreNames.contains("posts")) db.createObjectStore("posts", { keyPath: "id" });
      };
      open.onsuccess = function () {
        var db = open.result;
        var tx = db.transaction("posts", "readwrite");
        var store = tx.objectStore("posts");
        store.clear();
        packed.forEach(function (row) { store.put(row); });
      };
    } catch (err) {
      if (dev && dev.rememberFail) dev.rememberFail("search", "idb", Date.now(), "feature");
    }
  }

  function query(q, opts) {
    opts = opts || {};
    var started = Date.now();
    var posts = opts.posts || [];
    if (posts.length) indexPosts(posts, opts.feeds || []);
    if (!state.rows.length) return { complete: false, hits: null, ms: 0 };
    if (posts.length && keyOf(posts) !== state.key) return { complete: false, hits: null, ms: 0 };
    var lq = String(q || "").trim().replace(/^@+/, "").toLowerCase();
    var accounts = [];
    var feeds = opts.feeds || state.feeds || [];
    if (lq) {
      accounts = feeds.filter(function (feed) {
        if (opts.mute && opts.mute(feed)) return false;
        var blob = ((feed.name || "") + " " + (feed.handle || "") + " " + (feed.aliases || "") + " " + (feed.bio || "")).toLowerCase();
        return blob.indexOf(lq) >= 0;
      });
    }
    var found = [];
    if (lq) {
      for (var i = 0; i < state.rows.length; i++) {
        var post = state.rows[i];
        if (opts.hidden && opts.hidden(post)) continue;
        if (state.hay[i].indexOf(lq) >= 0) found.push(post);
      }
    }
    if (opts.byStamp) found.sort(opts.byStamp);
    var top = found.slice();
    if (opts.heat && opts.byStamp) {
      top.sort(function (a, b) { return opts.heat(b) - opts.heat(a) || opts.byStamp(a, b); });
    }
    return {
      complete: true,
      hits: { accounts: accounts, posts: found, top: top },
      ms: Math.max(0, Date.now() - started)
    };
  }

  function answer(q, opts) {
    opts = opts || {};
    var dev = opts.device || deviceApi();
    function local() {
      var found = query(q, opts.local || {});
      if (!found.complete) throw new Error("invalid");
      found.ms = found.ms || 0;
      return found;
    }
    function server() {
      return opts.server ? opts.server(q) : Promise.reject(new Error("both"));
    }
    if (!dev || !dev.runLocal) return Promise.resolve().then(server);
    return dev.runLocal("search", "index", local, server, {
      settings: opts.settings || (dev.read ? dev.read() : {}),
      signals: opts.signals || {},
      timeout: opts.timeout,
      now: opts.now,
      valid: function (value) { return value && value.hits && Array.isArray(value.hits.posts) && Array.isArray(value.hits.accounts); }
    });
  }

  function reset() {
    state = { key: "", rows: [], hay: [], feeds: [] };
  }

  return { indexPosts: indexPosts, query: query, answer: answer, hay: hay, reset: reset };
});
