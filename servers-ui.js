/* Native servers on the Messages page (Discord-style, run by this app).
   Layout: server rail | channels | chat | members (desktop), one pane at a
   time on phones. Data comes from the Worker's /v1/servers API; realtime
   rides a hibernating Durable Object socket per open server, with the
   account channel "srv" topic as the fallback. Nothing polls on a timer:
   the page refetches on socket events, focus, visibility and reconnects.
   Lists, channel history and unsent messages stay in local storage so the
   last view opens offline. */
(function () {
  "use strict";
  var root = typeof window === "undefined" ? null : window;
  if (!root || root.ViktorychServers) return;

  var P = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 4, MANAGE_CHANNELS: 8, KICK: 16, BAN: 32, MENTION_EVERYONE: 64, MANAGE_ROLES: 128, MANAGE_SERVER: 256, CREATE_INVITE: 512, REACT: 1024, ATTACH: 2048, MODERATE: 4096, MANAGE_EVENTS: 8192, CREATE_THREADS: 16384, MANAGE_THREADS: 32768, CONNECT: 65536, SPEAK: 131072, VIDEO: 262144, MUTE_MEMBERS: 524288, ADMIN: 1 << 20 };
  function PERM_ROWS() {
    return [
    ["VIEW", tr("View channels")], ["SEND", tr("Send messages")], ["REACT", tr("Add reactions")], ["ATTACH", tr("Attach files")],
    ["MENTION_EVERYONE", tr("Mention @everyone and all roles")], ["CREATE_INVITE", tr("Create invites")], ["CREATE_THREADS", tr("Create threads and posts")],
    ["MANAGE_THREADS", tr("Manage threads and posts")], ["MANAGE_EVENTS", tr("Manage events")],
    ["CONNECT", tr("Connect to voice")], ["SPEAK", tr("Speak in voice")], ["VIDEO", tr("Camera and screen share")], ["MUTE_MEMBERS", tr("Mute and disconnect members in voice")],
    ["MANAGE_MESSAGES", tr("Manage messages")], ["MANAGE_CHANNELS", tr("Manage channels")], ["MANAGE_ROLES", tr("Manage roles")],
    ["KICK", tr("Kick members")], ["BAN", tr("Ban members")], ["MODERATE", tr("Time out members")], ["MANAGE_SERVER", tr("Manage server")], ["ADMIN", tr("Administrator")]
    ];
  }
  var CHANNEL_PERMS = ["VIEW", "SEND", "REACT", "ATTACH", "CREATE_THREADS", "MENTION_EVERYONE", "MANAGE_MESSAGES", "MANAGE_THREADS", "CONNECT", "SPEAK", "VIDEO", "MUTE_MEMBERS"];
  var QUICK = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\uD83D\uDD25"];
  var EMOJI = ("\uD83D\uDE00 \uD83D\uDE03 \uD83D\uDE04 \uD83D\uDE01 \uD83D\uDE06 \uD83D\uDE05 \uD83E\uDD23 \uD83D\uDE02 \uD83D\uDE42 \uD83D\uDE09 \uD83D\uDE0A \uD83D\uDE07 \uD83E\uDD70 \uD83D\uDE0D \uD83E\uDD29 \uD83D\uDE18 \uD83D\uDE0B \uD83D\uDE1B \uD83E\uDD14 \uD83E\uDD28 \uD83D\uDE10 \uD83D\uDE44 \uD83D\uDE0F \uD83D\uDE2C \uD83D\uDE34 \uD83D\uDE37 \uD83E\uDD12 \uD83E\uDD2F \uD83E\uDD73 \uD83D\uDE0E \uD83E\uDD13 \uD83D\uDE15 \uD83D\uDE1F \uD83D\uDE2E \uD83D\uDE33 \uD83E\uDD7A \uD83D\uDE22 \uD83D\uDE2D \uD83D\uDE31 \uD83D\uDE24 \uD83D\uDE21 \uD83D\uDC80 \uD83D\uDCA9 \uD83E\uDD21 \uD83D\uDC7B \uD83D\uDC7D \uD83E\uDD16 \uD83D\uDE48 " +
    "\uD83D\uDC4B \uD83D\uDC4C \u270C\uFE0F \uD83E\uDD1E \uD83E\uDD19 \uD83D\uDC4D \uD83D\uDC4E \uD83D\uDC4F \uD83D\uDE4C \uD83E\uDD1D \uD83D\uDE4F \uD83D\uDCAA \uD83D\uDC40 \uD83E\uDDE0 " +
    "\u2764\uFE0F \uD83E\uDDE1 \uD83D\uDC9B \uD83D\uDC9A \uD83D\uDC99 \uD83D\uDC9C \uD83D\uDDA4 \uD83E\uDD0D \uD83D\uDC94 \uD83D\uDCAF \uD83D\uDCA5 \uD83D\uDCAB \u2B50 \uD83C\uDF1F \u2728 \uD83D\uDD25 \u26A1 \uD83C\uDF89 \uD83C\uDF8A \uD83C\uDF81 \uD83C\uDFC6 \uD83C\uDFAE \uD83C\uDFB5 \uD83C\uDF55 \uD83C\uDF7A \u2615 \uD83D\uDE80 \u2705 \u274C \u2753 \u2757 \uD83D\uDCCC").split(" ");
  function EXPIRY() { return [[1800, tr("30 minutes")], [3600, tr("1 hour")], [21600, tr("6 hours")], [43200, tr("12 hours")], [86400, tr("1 day")], [604800, tr("7 days")], [0, tr("Never")]]; }
  var USES = [0, 1, 5, 10, 25, 50, 100];
  var SLOW = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
  function TIMEOUTS() { return [[60, tr("60 seconds")], [300, tr("5 minutes")], [600, tr("10 minutes")], [3600, tr("1 hour")], [86400, tr("1 day")], [604800, tr("1 week")]]; }
  var LS = "vsrv-v1:";
  var MAX_CACHE = 150;

  var S = {
    list: null, canCreate: false, listAt: 0, listLoading: null,
    servers: {}, msgs: {}, more: {}, cards: {}, members: {}, typing: {}, online: {},
    sid: "", cid: "", mode: "", invite: "", inviteInfo: null,
    drafts: {}, reply: null, edit: "", files: [], sheet: null, membersOpen: true,
    socket: null, socketSid: "", socketWant: false, retry: 0, retryTimer: 0,
    unread: {}, flash: "", lastTyping: 0, mentionMap: {}, previews: {}, expanded: {}, collapsed: {},
    threads: {}, active: {}, forum: {}, acts: {}, events: {}, forumTag: {}, voice: {}, vfocus: ""
  };

  function tr(key, vars) {
    var fn = root.t;
    var text = typeof fn === "function" ? fn(key, vars) : key;
    if (!vars || typeof fn === "function") return text;
    return String(text).replace(/\{(\w+)\}/g, function (_m, k) { return vars[k] == null ? "" : String(vars[k]); });
  }
  // Plural keys live in the packs as key.one/few/many/other.
  var PLURAL_EN = {
    members: ["members"],
    srvChannels: ["srvChannels"],
    srvUses: ["srvUses"],
    srvWorks: ["srvWorks"],
    srvResults: ["srvResults"],
    srvMessagesN: ["srvMessagesN"],
    srvVotes: ["srvVotes"],
    srvGoing: ["srvGoing"],
    srvInterested: ["srvInterested"],
    srvEventsN: ["srvEventsN"]
  };
  function trn(n, key, vars) {
    var fn = root.tn;
    var v = Object.assign({ n: n }, vars || {});
    if (typeof fn === "function") {
      var out = fn(key, n, vars);
      if (out && out.indexOf(key + ".") !== 0) return out;
    }
    var pair = PLURAL_EN[key] || [key, key];
    return String(n === 1 ? pair[0] : pair[1]).replace(/\{(\w+)\}/g, function (_m, k) { return v[k] == null ? "" : String(v[k]); });
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function has(perms, bit) { return (perms & P.ADMIN) === P.ADMIN || (perms & bit) === bit; }

  /* ---------- API ---------- */
  function api() {
    try {
      var acc = root.ViktorychAccounts;
      if (acc && acc.currentApi) { var cur = acc.currentApi(); if (cur) return String(cur).replace(/\/$/, ""); }
      var cfg = root.VIKTORYCH_ACCOUNTS;
      return String((cfg && (cfg.api || cfg.backupApi)) || "").replace(/\/$/, "");
    } catch (err) { return ""; }
  }
  function token() {
    try { var acc = root.ViktorychAccounts; return acc && acc.token ? String(acc.token() || "") : ""; } catch (err) { return ""; }
  }
  function signedIn() {
    if (!(api() && token())) return false;
    checkAccount();
    return true;
  }
  var whoSeen = null;
  function checkAccount() {
    var acc = null;
    try { acc = root.ViktorychAccounts && root.ViktorychAccounts.account ? root.ViktorychAccounts.account() : null; } catch (err) { acc = null; }
    var raw = acc ? String(acc.publicId || acc.id || acc.handle || "") : "";
    var h = 0;
    for (var i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) | 0;
    var who = raw ? String(h >>> 0) : "";
    if (who === whoSeen || !who) return;
    var stored = lsGet("who", "");
    whoSeen = who;
    if (stored && stored !== who) {
      // Another account signed in on this device: its servers are not ours.
      wipeCache();
      S.list = null; S.servers = {}; S.msgs = {}; S.cards = {}; S.members = {}; S.drafts = {};
    }
    lsSet("who", who);
  }
  var FRESH_MS = 1500;
  var fresh = {};
  var inflight = {};
  function call(path, opts) {
    opts = opts || {};
    var base = api();
    if (!base) return Promise.resolve({ status: 0, body: { error: "offline" } });
    var headers = {};
    var tok = token();
    if (tok) headers.Authorization = "Bearer " + tok;
    var body = opts.body;
    if (body != null && !(body instanceof Blob) && typeof body !== "string") { headers["Content-Type"] = "application/json"; body = JSON.stringify(body); }
    if (opts.type) headers["Content-Type"] = opts.type;
    var method = opts.method || "GET";
    var reading = method === "GET";
    var now = Date.now();
    // A failed read waits before it is sent again, so a screen that repaints
    // after every answer cannot turn one error into a request storm.
    if (reading && now < coolDevice) return Promise.resolve({ status: 429, held: true, body: { error: "rate_limited", retry: Math.ceil((coolDevice - now) / 1000) } });
    var held = reading ? cool[path] : null;
    if (held && now < held.until) return Promise.resolve({ status: held.status, held: true, body: { error: held.status === 0 ? "offline" : held.status === 429 ? "rate_limited" : "backoff" } });
    // The same read twice in a few seconds, or while the tab is hidden,
    // reuses the last answer; two callers at once share one request.
    if (reading) {
      var last = fresh[path];
      var hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      if (last && hidden) return Promise.resolve({ status: last.status, held: true, body: last.body });
      if (last && now - last.at < FRESH_MS) return Promise.resolve({ status: last.status, body: last.body });
      if (inflight[path]) return inflight[path];
    }
    var run = fetch(base + "/v1/servers" + path, { method: method, headers: headers, body: body, cache: "no-store" })
      .then(function (res) {
        if (reading) noteRead(path, res.status, res);
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (reading && res.status === 200) fresh[path] = { at: Date.now(), status: 200, body: data || {} };
          if (!reading) fresh = {};
          return { status: res.status, body: data || {} };
        });
      })
      .catch(function () {
        if (reading) noteRead(path, 0, null);
        return { status: 0, body: { error: "offline" } };
      });
    if (!reading) return run;
    inflight[path] = run;
    return run.then(function (out) { delete inflight[path]; return out; }, function (err) { delete inflight[path]; throw err; });
  }
  var cool = {};
  var coolDevice = 0;
  function retryAfter(res) {
    var raw = "";
    try { raw = res && res.headers && res.headers.get ? res.headers.get("Retry-After") || "" : ""; } catch (err) { raw = ""; }
    var secs = Number(raw);
    return raw && isFinite(secs) ? Math.min(600000, Math.max(0, secs * 1000)) : 0;
  }
  function noteRead(path, status, res) {
    if (status !== 0 && status !== 429 && status < 500) { delete cool[path]; return; }
    var prev = cool[path] || { n: 0 };
    var n = Math.min(prev.n + 1, 8);
    var wait = Math.min(300000, 1000 * Math.pow(2, n - 1)) * (0.7 + Math.random() * 0.6);
    if (status === 429) {
      var told = retryAfter(res);
      wait = Math.max(wait, told || 30000);
      var scope = "";
      try { scope = String(res.headers.get("X-Limit-Scope") || ""); } catch (err) { scope = ""; }
      if (scope !== "action") coolDevice = Date.now() + Math.max(1000, told || 30000);
    }
    cool[path] = { n: n, status: status, until: Date.now() + wait };
  }
  function errText(res) {
    var e = res && res.body && res.body.error;
    if (!res || res.status === 0) return tr("You're offline. Try again when you're connected.");
    if (e === "slowmode") return tr("Slow mode is on. Wait {n}s.", { n: res.body.retry || 1 });
    if (e === "rate_limited") return tr("You're doing that too fast. Try again in a moment.");
    if (e === "timed_out") return tr("You're timed out in this server.");
    if (e === "owner_only") return tr("Only the app owner can create servers for now.");
    if (e === "perm" || e === "perm_attach" || e === "hierarchy") return tr("You don't have permission to do that.");
    if (e === "too_long") return tr("That message is too long.");
    if (e === "too_large") return tr("That file is too large.");
    if (e === "banned") return tr("You're banned from this server.");
    if (e === "expired" || e === "invalid" || e === "used_up") return tr("This invite is invalid or has expired.");
    if (e === "too_many_pins") return tr("This channel has too many pins.");
    if (e === "owner_cannot_leave") return tr("The owner can't leave their own server.");
    if (e === "image_only") return tr("Pick an image file.");
    if (e === "too_many") return tr("You've reached the limit.");
    if (e === "emoji_name") return tr("Emoji names use 2 to 32 letters, numbers or underscores.");
    if (e === "not_member") return tr("You're not a member of this server.");
    if (res.status === 401) return tr("Sign in to continue.");
    return tr("Something went wrong. Try again.");
  }
  var toastTimer = 0;
  function toast(text) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* ---------- local cache ---------- */
  function lsGet(key, fallback) {
    try { var raw = localStorage.getItem(LS + key); return raw ? JSON.parse(raw) : fallback; } catch (err) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(LS + key, JSON.stringify(value)); } catch (err) { /* storage full: memory still works */ }
  }
  var dbOpen = null;
  function db() {
    if (dbOpen) return dbOpen;
    dbOpen = new Promise(function (resolve) {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      var req;
      try { req = indexedDB.open("viktorych-servers", 1); } catch (err) { resolve(null); return; }
      req.onupgradeneeded = function () { try { req.result.createObjectStore("ch"); } catch (err) { /* exists */ } };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
    return dbOpen;
  }
  function idbGet(key) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (resolve) {
        try {
          var r = d.transaction("ch", "readonly").objectStore("ch").get(key);
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror = function () { resolve(null); };
        } catch (err) { resolve(null); }
      });
    });
  }
  var idbTimers = {};
  function saveChannel(cid) {
    if (idbTimers[cid]) return;
    idbTimers[cid] = setTimeout(function () {
      delete idbTimers[cid];
      var list = (S.msgs[cid] || []).filter(function (m) { return !m.pending; }).slice(-MAX_CACHE);
      db().then(function (d) {
        if (!d) return;
        try { d.transaction("ch", "readwrite").objectStore("ch").put({ list: list, at: Date.now() }, cid); } catch (err) { /* quota */ }
      });
    }, 400);
  }
  function wipeCache() {
    try {
      // key()/length also list the encrypted copies (device-seal.js).
      var names = [];
      for (var i = 0; i < localStorage.length; i++) names.push(localStorage.key(i));
      names.forEach(function (k) { if (k && k.indexOf(LS) === 0) localStorage.removeItem(k); });
    } catch (err) { /* private mode */ }
    db().then(function (d) { if (d) { try { d.transaction("ch", "readwrite").objectStore("ch").clear(); } catch (err) { /* closed */ } } });
  }

  /* ---------- ids, time ---------- */
  function msgTime(id) {
    var n = parseInt(String(id || "").slice(0, 10), 36);
    return isFinite(n) ? n : 0;
  }
  function lang() { return (document.documentElement.lang || "en").slice(0, 5); }
  function clock(ts) {
    try { return new Intl.DateTimeFormat(lang(), { hour: "numeric", minute: "2-digit" }).format(new Date(ts)); } catch (err) { return ""; }
  }
  function dayLabel(ts) {
    var d = new Date(ts);
    var now = new Date();
    var y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return tr("Today");
    if (d.toDateString() === y.toDateString()) return tr("Yesterday");
    try { return new Intl.DateTimeFormat(lang(), { year: "numeric", month: "long", day: "numeric" }).format(d); } catch (err) { return d.toDateString(); }
  }
  function fullTime(ts) {
    try { return new Intl.DateTimeFormat(lang(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(ts)); } catch (err) { return new Date(ts).toLocaleString(); }
  }
  function shortAgo(ts) {
    if (!ts) return "";
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return tr("now");
    if (s < 3600) return tr("{n}m", { n: Math.floor(s / 60) });
    if (s < 86400) return tr("{n}h", { n: Math.floor(s / 3600) });
    if (s < 604800) return tr("{n}d", { n: Math.floor(s / 86400) });
    try { return new Intl.DateTimeFormat(lang(), { month: "short", day: "numeric" }).format(new Date(ts)); } catch (err) { return ""; }
  }
  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB";
  }
  function color(num) {
    num = Number(num) || 0;
    return num ? "#" + ("000000" + num.toString(16)).slice(-6) : "";
  }
  function rand() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  /* ---------- server data helpers ---------- */
  function srv(sid) { return S.servers[sid || S.sid] || null; }
  function listEntry(sid) { return (S.list || []).find(function (s) { return s.id === sid; }) || null; }
  function channelsOf(sid) {
    var st = srv(sid);
    if (st && st.channels) return st.channels;
    var entry = listEntry(sid);
    return entry ? entry.channels || [] : [];
  }
  function channel(cid, sid) { return channelsOf(sid).find(function (c) { return c.id === cid; }) || threadChannel(cid, sid); }
  function realChannel(cid, sid) { return channelsOf(sid).find(function (c) { return c.id === cid; }) || null; }
  function me(sid) { var st = srv(sid); return st && st.me ? st.me : { mid: "", perms: 0, roles: [], owner: false }; }
  function basePerms(sid) { return me(sid).perms || 0; }
  function chanPerms(cid, sid) { var c = channel(cid, sid); return c ? Number(c.perms) || 0 : 0; }
  function role(rid, sid) { var st = srv(sid); return st && st.roles ? st.roles.find(function (r) { return r.id === rid; }) || null : null; }
  function sortedRoles(sid) {
    var st = srv(sid);
    return (st && st.roles ? st.roles.slice() : []).sort(function (a, b) { return b.position - a.position; });
  }
  function memberColor(mid, sid) {
    var card = cardOf(mid, sid);
    var ids = card && card.roles ? card.roles : [];
    var best = null;
    ids.forEach(function (id) { var r = role(id, sid); if (r && r.color && (!best || r.position > best.position)) best = r; });
    return best ? color(best.color) : "";
  }
  function emojiById(id, sid) { var st = srv(sid); return st && st.emojis ? st.emojis.find(function (e) { return e.id === id; }) || null : null; }
  function emojiByName(name, sid) { var st = srv(sid); return st && st.emojis ? st.emojis.find(function (e) { return e.name === name; }) || null : null; }
  function isMod(sid) { var p = basePerms(sid); return has(p, P.MANAGE_MESSAGES) || has(p, P.KICK) || has(p, P.BAN) || has(p, P.MODERATE) || me(sid).owner; }
  function canManage(sid) { var p = basePerms(sid); return me(sid).owner || has(p, P.MANAGE_SERVER) || has(p, P.MANAGE_ROLES) || has(p, P.MANAGE_CHANNELS); }
  function notifyLevel(scope, sid) {
    var st = srv(sid) || listEntry(sid) || {};
    var map = st.notify || {};
    return map[scope] || "";
  }
  function effectiveLevel(cid, sid) { return notifyLevel(cid, sid) || notifyLevel(sid || S.sid, sid) || "mentions"; }

  function cardOf(mid, sid) {
    var bag = S.cards[sid || S.sid];
    return bag ? bag[mid] || null : null;
  }
  function nameOf(mid, sid) {
    var c = cardOf(mid, sid);
    if (!c) return tr("Member");
    return c.nick || c.name || c.handle || tr("Member");
  }
  var cardWant = {};
  var cardTimer = 0;
  function needCards(mids, sid) {
    sid = sid || S.sid;
    var bag = S.cards[sid] || (S.cards[sid] = lsGet("cards:" + sid, {}));
    (mids || []).forEach(function (m) {
      if (!m || !/^[a-f0-9]{16}$/.test(m)) return;
      var c = bag[m];
      if (c && c.at && Date.now() - c.at < 6 * 3600 * 1000) return;
      (cardWant[sid] || (cardWant[sid] = {}))[m] = 1;
    });
    if (cardTimer || !cardWant[sid] || !Object.keys(cardWant[sid]).length) return;
    cardTimer = setTimeout(function () {
      cardTimer = 0;
      Object.keys(cardWant).forEach(function (id) {
        var list = Object.keys(cardWant[id]);
        delete cardWant[id];
        for (var i = 0; i < list.length; i += 50) fetchCards(id, list.slice(i, i + 50));
      });
    }, 30);
  }
  function fetchCards(sid, mids) {
    return call("/" + sid + "/cards?m=" + mids.join(",")).then(function (res) {
      if (res.status !== 200 || !res.body.cards) return;
      var bag = S.cards[sid] || (S.cards[sid] = {});
      var now = Date.now();
      Object.keys(res.body.cards).forEach(function (m) { var c = res.body.cards[m]; if (c) { c.at = now; bag[m] = c; } });
      var keys = Object.keys(bag);
      if (keys.length > 600) keys.sort(function (a, b) { return (bag[a].at || 0) - (bag[b].at || 0); }).slice(0, keys.length - 600).forEach(function (k) { delete bag[k]; });
      lsSet("cards:" + sid, bag);
      if (sid === S.sid) { paintLog(true); paintMembers(); if (voiceAsked[sid]) paintVoice(); }
    });
  }

  /* ---------- loading ---------- */
  function loadList(force) {
    if (!signedIn()) { S.list = []; return Promise.resolve([]); }
    if (S.list === null) {
      var cached = lsGet("list", null);
      if (cached) { S.list = cached.servers || []; S.canCreate = !!cached.canCreate; }
    }
    if (S.listLoading) return S.listLoading;
    if (!force && S.listAt && Date.now() - S.listAt < 4000) return Promise.resolve(S.list);
    S.listLoading = call("").then(function (res) {
      S.listLoading = null;
      // Still waiting after a failed read: nothing changed, so no repaint
      // (a repaint would ask again).
      if (res.held) return S.list || [];
      if (res.status === 200) {
        S.list = res.body.servers || [];
        S.canCreate = !!res.body.canCreate;
        S.listAt = Date.now();
        lsSet("list", { servers: S.list, canCreate: S.canCreate });
        S.list.forEach(function (s) {
          var st = S.servers[s.id];
          if (st) { st.channels = mergeChannelState(st.channels, s.channels); st.notify = s.notify; }
        });
      } else if (res.status === 401) {
        S.list = [];
      }
      paintAll();
      return S.list || [];
    });
    return S.listLoading;
  }
  function mergeChannelState(full, light) {
    if (!full) return light;
    var byId = {};
    (light || []).forEach(function (c) { byId[c.id] = c; });
    return full.map(function (c) {
      var l = byId[c.id];
      if (!l) return c;
      return Object.assign({}, c, { lastId: l.lastId, lastRead: maxId(c.lastRead, l.lastRead), mentions: l.mentions, perms: l.perms });
    });
  }
  function maxId(a, b) { a = a || ""; b = b || ""; return a > b ? a : b; }

  var serverLoads = {};
  function loadServer(sid, force) {
    if (!S.servers[sid]) {
      var cached = lsGet("srv:" + sid, null);
      if (cached) S.servers[sid] = cached;
    }
    if (serverLoads[sid]) return serverLoads[sid];
    var st = S.servers[sid];
    if (!force && st && st.at && Date.now() - st.at < 3000) return Promise.resolve(st);
    serverLoads[sid] = call("/" + sid).then(function (res) {
      delete serverLoads[sid];
      if (res.held) return S.servers[sid] || null;
      if (res.status === 200) {
        var prev = S.servers[sid];
        var next = Object.assign({}, res.body, { at: Date.now() });
        if (prev && prev.channels) {
          next.channels = next.channels.map(function (c) {
            var old = prev.channels.find(function (o) { return o.id === c.id; });
            return old ? Object.assign({}, c, { lastRead: maxId(c.lastRead, old.lastRead) }) : c;
          });
        }
        S.servers[sid] = next;
        lsSet("srv:" + sid, next);
        if (next.me && next.me.mid) needCards([next.me.mid], sid);
      } else if (res.status === 403 || res.status === 404) {
        delete S.servers[sid];
        lsSet("srv:" + sid, null);
        if (S.list) S.list = S.list.filter(function (s) { return s.id !== sid; });
        if (S.sid === sid) { S.gone = res.body.error || "gone"; }
      }
      paintAll();
      return S.servers[sid] || null;
    });
    return serverLoads[sid];
  }

  function cmpId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
  function mergeMessages(cid, incoming, replace) {
    var cur = replace ? [] : (S.msgs[cid] || []).slice();
    var byId = {};
    var byNonce = {};
    cur.forEach(function (m, i) { byId[m.id] = i; if (m.n) byNonce[m.n] = i; });
    (incoming || []).forEach(function (m) {
      if (!m || !m.id) return;
      if (m.n && byNonce[m.n] != null) { cur[byNonce[m.n]] = m; byId[m.id] = byNonce[m.n]; return; }
      if (byId[m.id] != null) {
        var old = cur[byId[m.id]];
        /* Room events never carry removed text; keep what a moderator already has. */
        if (m.x && !m.x.text && old && old.x && old.x.text) m.x.text = old.x.text;
        cur[byId[m.id]] = m;
        return;
      }
      byId[m.id] = cur.length;
      cur.push(m);
    });
    if (replace) {
      /* A slow newest-page load must not wipe what was sent or delivered after it was asked for. */
      var top = "", recent = Date.now() - 60000;
      cur.forEach(function (m) { if (m.id > top) top = m.id; });
      (S.msgs[cid] || []).forEach(function (m) {
        if (m.pending) { cur.push(m); return; }
        if (replace !== "latest" || byId[m.id] != null) return;
        if (top ? m.id > top : (m.t || msgTime(m.id)) > recent) { byId[m.id] = cur.length; cur.push(m); }
      });
    }
    var sent = cur.filter(function (m) { return !m.pending; }).sort(cmpId);
    var pend = cur.filter(function (m) { return m.pending; });
    var seenNonce = {};
    sent.forEach(function (m) { if (m.n) seenNonce[m.n] = 1; });
    S.msgs[cid] = sent.concat(pend.filter(function (m) { return !seenNonce[m.n]; }));
    var mids = [];
    S.msgs[cid].forEach(function (m) { mids.push(m.a); if (m.r && m.r.a) mids.push(m.r.a); if (m.x && m.x.by) mids.push(m.x.by); if (m.mn && m.mn.u) mids.push.apply(mids, m.mn.u); });
    needCards(mids);
    saveChannel(cid);
  }

  var msgLoads = {};
  function loadMessages(sid, cid, opts) {
    opts = opts || {};
    var key = cid + ":" + (opts.before || "") + ":" + (opts.after || "") + ":" + (opts.around || "");
    if (msgLoads[key]) return msgLoads[key];
    var q = "?limit=50";
    if (opts.before) q += "&before=" + opts.before;
    if (opts.after) q += "&after=" + opts.after;
    if (opts.around) q += "&around=" + opts.around;
    msgLoads[key] = call("/" + sid + "/channels/" + cid + "/messages" + q).then(function (res) {
      delete msgLoads[key];
      if (res.status !== 200) { if (cid === S.cid) { S.loadErr = res.status === 403 ? "perm" : "net"; paintLog(); } return null; }
      S.loadErr = "";
      var list = res.body.messages || [];
      if (opts.before) S.more[cid] = !!res.body.more;
      else if (!opts.after) {
        var have = S.msgs[cid] || [];
        var overlap = list.length && have.some(function (m) { return m.id === list[0].id; });
        if (!overlap || opts.around) { S.more[cid] = !!res.body.more || opts.around; mergeMessages(cid, list, opts.around ? true : "latest"); list = null; }
        else S.more[cid] = S.more[cid] == null ? !!res.body.more : S.more[cid];
      } else if (res.body.more) {
        // A long gap since the last visit: drop the stale tail and keep the newest page.
        return loadMessages(sid, cid, {});
      }
      if (list) mergeMessages(cid, list, false);
      S.loaded = S.loaded || {};
      S.loaded[cid] = true;
      if (cid === S.cid) paintLog(!opts.before, opts.before ? "keep" : "");
      return res.body;
    });
    return msgLoads[key];
  }
  function openChannelData(sid, cid) {
    if (S.msgs[cid]) {
      var list = S.msgs[cid].filter(function (m) { return !m.pending; });
      var last = list.length ? list[list.length - 1].id : "";
      return loadMessages(sid, cid, last && S.loaded && S.loaded[cid] ? { after: last } : {});
    }
    return idbGet(cid).then(function (row) {
      if (row && row.list && !S.msgs[cid]) { S.msgs[cid] = row.list; if (cid === S.cid) paintLog(true); }
      return loadMessages(sid, cid, {});
    });
  }
  function catchUp() {
    if (!S.sid || !S.cid) return;
    var cc = channel(S.cid);
    if (cc && cc.kind === "forum") { loadForum(S.sid, S.cid); return; }
    if (!cc || cc.kind === "voice") return;
    openChannelData(S.sid, S.cid);
  }

  /* ---------- outbox ---------- */
  function outbox() { return lsGet("outbox", []); }
  function setOutbox(list) { lsSet("outbox", list.slice(-50)); }
  function sendMessage(sid, cid, body, replyTo, files, ping) {
    var nonce = "n" + rand();
    var m = me(sid);
    var local = { id: "~" + nonce, n: nonce, c: cid, a: m.mid, b: body, t: Date.now(), pending: 1, rx: [], at: (files || []).map(function (f) { return { url: f.local || "", name: f.n, type: f.t, size: f.s, w: f.w, h: f.h }; }), r: replyTo ? replyRef(cid, replyTo) : null };
    mergeMessages(cid, [local], false);
    var job = { sid: sid, cid: cid, nonce: nonce, body: body, replyTo: replyTo || "", files: (files || []).map(function (f) { return { k: f.k, w: f.w || 0, h: f.h || 0 }; }), ping: ping !== false, at: Date.now() };
    var box = outbox();
    box.push(job);
    setOutbox(box);
    paintLog(true);
    return flushOne(job);
  }
  function replyRef(cid, id) {
    var m = (S.msgs[cid] || []).find(function (x) { return x.id === id; });
    return m ? { id: m.id, a: m.a, b: m.b, x: m.x ? 1 : 0, f: m.at && m.at.length ? 1 : 0 } : { id: id, gone: 1 };
  }
  var flushing = {};
  function flushOne(job) {
    if (flushing[job.nonce]) return flushing[job.nonce];
    flushing[job.nonce] = call("/" + job.sid + "/channels/" + job.cid + "/messages", { method: "POST", body: { body: job.body, replyTo: job.replyTo || undefined, attachments: job.files, nonce: job.nonce, pingReply: job.ping } }).then(function (res) {
      delete flushing[job.nonce];
      if (res.status === 200 && res.body.message) {
        setOutbox(outbox().filter(function (j) { return j.nonce !== job.nonce; }));
        mergeMessages(job.cid, [res.body.message], false);
        markReadSoon(job.sid, job.cid, res.body.message.id, true);
        if (job.cid === S.cid) paintLog(true);
        return true;
      }
      var keep = res.status === 0 || res.status >= 500;
      var list = S.msgs[job.cid] || [];
      list.forEach(function (m) { if (m.n === job.nonce && m.pending) { m.failed = keep ? "offline" : errText(res); } });
      if (!keep) setOutbox(outbox().filter(function (j) { return j.nonce !== job.nonce; }));
      if (job.cid === S.cid) paintLog();
      if (!keep) toast(errText(res));
      return false;
    });
    return flushing[job.nonce];
  }
  function flushOutbox() {
    if (!signedIn() || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
    outbox().forEach(function (job) {
      if (Date.now() - job.at > 3 * 86400 * 1000) return;
      var list = S.msgs[job.cid] || (S.msgs[job.cid] = []);
      if (!list.some(function (m) { return m.n === job.nonce; })) {
        list.push({ id: "~" + job.nonce, n: job.nonce, c: job.cid, a: me(job.sid).mid, b: job.body, t: job.at, pending: 1, rx: [] });
      }
      list.forEach(function (m) { if (m.n === job.nonce) m.failed = ""; });
      flushOne(job);
    });
  }
  function dropPending(nonce) {
    setOutbox(outbox().filter(function (j) { return j.nonce !== nonce; }));
    Object.keys(S.msgs).forEach(function (cid) { S.msgs[cid] = S.msgs[cid].filter(function (m) { return m.n !== nonce || !m.pending; }); });
    paintLog();
  }

  /* ---------- reads ---------- */
  var readTimers = {};
  function markReadSoon(sid, cid, id, now) {
    var c = channel(cid, sid);
    if (!c || !id || id.charAt(0) === "~") return;
    if (c.lastRead >= id && !c.mentions) return;
    c.lastRead = maxId(c.lastRead, id);
    c.mentions = 0;
    var entry = listEntry(sid);
    if (entry) entry.channels.forEach(function (x) { if (x.id === cid) { x.lastRead = c.lastRead; x.mentions = 0; } });
    paintSide(); paintRail(); paintInbox();
    clearTimeout(readTimers[cid]);
    readTimers[cid] = setTimeout(function () {
      call("/" + sid + "/channels/" + cid + "/read", { method: "POST", body: { id: c.lastRead } });
      lsSet("srv:" + sid, srv(sid));
      if (S.list) lsSet("list", { servers: S.list, canCreate: S.canCreate });
    }, now ? 300 : 1200);
  }
  function channelUnread(c, sid) {
    if (!c || c.kind === "category") return false;
    if (effectiveLevel(c.id, sid) === "none") return false;
    return !!(c.lastId && c.lastId > (c.lastRead || ""));
  }
  function serverBadge(sid) {
    var chans = channelsOf(sid);
    var mentions = 0;
    var unread = false;
    var muted = notifyLevel(sid, sid) === "none";
    chans.forEach(function (c) {
      if (!has(Number(c.perms) || 0, P.VIEW)) return;
      mentions += Number(c.mentions) || 0;
      if (!muted && channelUnread(c, sid)) unread = true;
    });
    return { mentions: mentions, unread: unread };
  }

  /* ---------- text formatting ---------- */
  function httpUrl(raw) {
    try { var u = new URL(String(raw || "")); return u.protocol === "https:" || u.protocol === "http:" ? u.href : ""; } catch (err) { return ""; }
  }
  function linkify(html) {
    return html.split(/(<[^>]+>)/).map(function (part) {
      if (!part || part.charAt(0) === "<") return part;
      return part.replace(/https?:\/\/[^\s<]+/g, function (url) {
        var bare = url.replace(/&amp;/g, "&");
        var extra = "";
        while (bare && /[),.;!?'"]$/.test(bare)) { extra = bare.slice(-1) + extra; bare = bare.slice(0, -1); }
        var href = httpUrl(bare);
        if (!href) return url;
        return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(bare) + "</a>" + esc(extra);
      });
    }).join("");
  }
  function format(raw, sid) {
    var blocks = [];
    function hold(html) { blocks.push(html); return "\u0000" + (blocks.length - 1) + "\u0000"; }
    var text = String(raw || "").replace(/\u0000/g, "");
    text = text.replace(/```(?:[a-z0-9+-]{1,16}\n)?([\s\S]*?)```/g, function (_m, code) { return hold('<pre class="vsrv-code">' + esc(code.replace(/^\n|\n$/g, "")) + "</pre>"); });
    text = text.replace(/`([^`\n]+)`/g, function (_m, code) { return hold("<code>" + esc(code) + "</code>"); });
    text = text.replace(/<(a?):([A-Za-z0-9_]{2,32}):([a-f0-9]{16})>/g, function (whole, _a, name, id) {
      var e = emojiById(id, sid);
      if (!e) return hold('<span class="vsrv-emoji-gone">:' + esc(name) + ":</span>");
      return hold('<img class="vsrv-emoji" src="' + esc(e.url) + '" alt=":' + esc(name) + ':" title=":' + esc(name) + ':" loading="lazy" decoding="async">');
    });
    text = text.replace(/<@([a-f0-9]{16})>/g, function (_m, mid) {
      return hold('<button type="button" class="vsrv-mention" data-vs="member" data-m="' + mid + '">@' + esc(nameOf(mid, sid)) + "</button>");
    });
    text = text.replace(/<@&([a-f0-9]{16})>/g, function (_m, rid) {
      var r = role(rid, sid);
      var c = r ? color(r.color) : "";
      return hold('<span class="vsrv-mention role"' + (c ? ' style="--rc:' + c + '"' : "") + ">@" + esc(r ? r.name : tr("deleted-role")) + "</span>");
    });
    text = text.replace(/(^|[^\w])@(everyone|here)\b/g, function (_m, pre, word) { return pre + hold('<span class="vsrv-mention all">@' + word + "</span>"); });
    var lines = esc(text).split("\n");
    var out = [];
    var quote = [];
    lines.forEach(function (line) {
      var q = /^&gt; ?(.*)$/.exec(line);
      if (q) { quote.push(q[1]); return; }
      if (quote.length) { out.push('<blockquote class="vsrv-quote">' + quote.join("<br>") + "</blockquote>"); quote = []; }
      var h = /^(#{1,3}) (.+)$/.exec(line);
      if (h) { out.push('<span class="vsrv-h vsrv-h' + h[1].length + '">' + h[2] + "</span>"); return; }
      out.push(line + "\n");
    });
    if (quote.length) out.push('<blockquote class="vsrv-quote">' + quote.join("<br>") + "</blockquote>");
    var html = out.join("").replace(/\n$/, "").replace(/\n/g, "<br>");
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (whole, label, url) {
      var href = httpUrl(url.replace(/&amp;/g, "&"));
      return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>" : whole;
    });
    html = linkify(html);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/__([^_]+)__/g, "<u>$1</u>");
    html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    html = html.replace(/(^|[\s(>])\*([^*<]+)\*(?=[\s).,!?:<]|$)/g, "$1<em>$2</em>");
    html = html.replace(/(^|[\s(>])_([^_<]+)_(?=[\s).,!?:<]|$)/g, "$1<em>$2</em>");
    html = html.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="vsrv-spoiler" data-vs="spoiler" role="button" tabindex="0">$1</span>');
    html = html.replace(/\u0000(\d+)\u0000/g, function (_m, i) { return blocks[Number(i)] || ""; });
    return root && root.ViktorychEmoji ? root.ViktorychEmoji.mark(html) : html;
  }
  var EMOJI_ONLY = null;
  function emojiOnly(raw) {
    var s = String(raw || "").replace(/<a?:[A-Za-z0-9_]{2,32}:[a-f0-9]{16}>/g, "\uE000").replace(/\s+/g, "");
    if (!s || s.length > 60) return false;
    if (EMOJI_ONLY === null) {
      // Built at runtime: older Safari cannot parse \p{} in a regex literal.
      try { EMOJI_ONLY = new RegExp("^(?:\\uE000|\\p{Extended_Pictographic}|\\u200D|\\uFE0F|\\p{Emoji_Modifier}|[\\u{1F1E6}-\\u{1F1FF}])+$", "u"); } catch (err) { EMOJI_ONLY = false; }
    }
    return EMOJI_ONLY ? EMOJI_ONLY.test(s) : false;
  }
  function plain(raw, sid) {
    return String(raw || "")
      .replace(/<@([a-f0-9]{16})>/g, function (_m, mid) { return "@" + nameOf(mid, sid); })
      .replace(/<@&([a-f0-9]{16})>/g, function (_m, rid) { var r = role(rid, sid); return "@" + (r ? r.name : ""); })
      .replace(/<a?:([A-Za-z0-9_]{2,32}):[a-f0-9]{16}>/g, ":$1:")
      .replace(/[*_~`|>#]/g, "").replace(/\s+/g, " ").trim();
  }
  function firstLink(raw) {
    var text = String(raw || "").replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").replace(/<https?:[^>]+>/g, "");
    var m = /https?:\/\/[^\s<>]+/.exec(text);
    if (!m) return "";
    var u = m[0].replace(/[),.;!?'"]+$/, "");
    return httpUrl(u);
  }
  function preview(url) {
    if (!url) return null;
    var hit = S.previews[url];
    if (hit) return hit.meta || null;
    var cache = lsGet("lp", {});
    if (cache[url]) { S.previews[url] = cache[url]; return cache[url].meta || null; }
    S.previews[url] = { loading: 1 };
    var base = api();
    if (!base) return null;
    fetch(base + "/v1/unfurl?url=" + encodeURIComponent(url)).then(function (res) {
      if (!res.ok) return null;
      return res.json().catch(function () { return null; });
    }).catch(function () { return null; }).then(function (meta) {
      var good = meta && !meta.none && (meta.title || meta.image) ? meta : null;
      S.previews[url] = { meta: good, at: Date.now() };
      var bag = lsGet("lp", {});
      bag[url] = S.previews[url];
      var keys = Object.keys(bag);
      if (keys.length > 200) keys.slice(0, keys.length - 200).forEach(function (k) { delete bag[k]; });
      lsSet("lp", bag);
      if (good) paintLog();
    });
    return null;
  }

  /* ---------- icons ---------- */
  var I = {
    voice: "M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z",
    volOff: "M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.45 2.45c.03-.2.05-.42.05-.65zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06A7 7 0 0 1 19 12zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9zM12 4 9.91 6.09 12 8.18z",
    mic: "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9z",
    micOff: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23A6.9 6.9 0 0 0 19 11zm-4.02.17V5a3 3 0 0 0-5.9-.7zM4.27 3 3 4.27l6.01 6.01V11a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.66 1.66A5.5 5.5 0 0 1 6.7 11H5a7 7 0 0 0 6 6.72V21h2v-3.28a6.9 6.9 0 0 0 2.54-.9L19.73 21 21 19.73z",
    headphones: "M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z",
    headOff: "M12 3a9 9 0 0 0-6.36 2.64l1.42 1.42A7 7 0 0 1 19 12v1h-3v.17l5 5V12a9 9 0 0 0-9-9zM3.27 2 2 3.27l2.07 2.07A8.9 8.9 0 0 0 3 12v7a2 2 0 0 0 2 2h3v-8H5v-1c0-1.1.25-2.13.7-3.06L16 19.27V21h1.73l3 3L22 22.73z",
    video: "M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z",
    videoOff: "M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.82L21 17.18zM3.27 2 2 3.27 4.73 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73z",
    screen: "M20 18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2H0v2h24v-2zM4 6h16v10H4z",
    hangup: "M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85.99.99 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z",
    signal: "M2 22h3v-5H2zm5 0h3v-9H7zm5 0h3V8h-3zm5 0h3V2h-3z",
    hash: "M10.59 4l-.6 4H6v2h3.7l-.6 4H5v2h3.8l-.6 4h2l.6-4h3.9l-.6 4h2l.6-4H21v-2h-3.4l.6-4H22V8h-3.5l.6-4h-2l-.6 4h-3.9l.6-4h-2zm1.1 6h3.9l-.6 4h-3.9l.6-4z",
    news: "M3 10v4c0 .55.45 1 1 1h1l3 4h2v-4l8 4V5l-8 4H4c-.55 0-1 .45-1 1zm17-1v6c1.1-.4 2-1.6 2-3s-.9-2.6-2-3z",
    plus: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z",
    chev: "M7.4 8.6L12 13.2l4.6-4.6L18 10l-6 6-6-6z",
    gear: "M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z",
    bell: "M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7C7.6 5.4 6 7.9 6 11v5l-2 2v1h16v-1z",
    bellOff: "M20 18.7L5.3 4 4 5.3l2.5 2.5A6.9 6.9 0 0 0 6 11v5l-2 2v1h13.7l1 1 1.3-1.3zM12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6.8V11c0-3.1-1.6-5.6-4.5-6.3V4a1.5 1.5 0 0 0-3 0v.7c-.5.1-1 .3-1.4.5z",
    pin: "M16 3l5 5-2 1-3 3 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 3-3z",
    users: "M16 11a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3zm0 2c-2.3 0-7 1.2-7 3.5V19h14v-2.5C15 14.2 10.3 13 8 13zm8 0c-.3 0-.6 0-1 .1 1.2.8 2 2 2 3.4V19h6v-2.5c0-2.3-4.7-3.5-7-3.5z",
    search: "M10 2a8 8 0 0 1 6.3 12.9l5.4 5.4-1.4 1.4-5.4-5.4A8 8 0 1 1 10 2zm0 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12z",
    back: "M7.4 11H20v2H7.4l5.3 5.3-1.4 1.4L3.6 12l7.7-7.7 1.4 1.4z",
    reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
    smile: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-3.5-9A1.5 1.5 0 1 0 7 9.5 1.5 1.5 0 0 0 8.5 11zm7 0A1.5 1.5 0 1 0 14 9.5a1.5 1.5 0 0 0 1.5 1.5zM12 17.5c2.3 0 4.3-1.5 5.1-3.5H6.9c.8 2 2.8 3.5 5.1 3.5z",
    more: "M6 10a2 2 0 1 0 2 2 2 2 0 0 0-2-2zm6 0a2 2 0 1 0 2 2 2 2 0 0 0-2-2zm6 0a2 2 0 1 0 2 2 2 2 0 0 0-2-2z",
    edit: "M3 17.3V21h3.8L17.8 9.9l-3.7-3.7zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7z",
    trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z",
    link: "M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z",
    shield: "M12 2L4 5v6c0 5.5 3.4 10.7 8 12 4.6-1.3 8-6.5 8-12V5z",
    close: "M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z",
    clip: "M16.5 6v11.5a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10.5a1 1 0 0 1-2 0V6H10v9.5a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v12.5a5.5 5.5 0 0 0 11 0V6z",
    send: "M2 21l21-9L2 3v7l15 2-15 2z",
    lock: "M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 0 1 6 0v2H9zm3 11a2 2 0 1 1 2-2 2 2 0 0 1-2 2z",
    door: "M10 17l1.4-1.4L8.8 13H20v-2H8.8l2.6-2.6L10 7l-5 5zm9 4H5V3h14v4h2V3a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4h-2z",
    compass: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm2.2 12.2L7 17l2.8-7.2L17 7z",
    file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm0 2.5L17.5 8H14z",
    copy: "M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z",
    clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.2-4.5-2.7z",
    thread: "M5.4 3h11.1L15.9 6H21v2h-5.5l-.9 5H20v2h-5.8l-.6 3H11.6l.6-3H7.8l-.6 3H5.2l.6-3H3v-2h3.2l.9-5H4V6h3.5l.6-3h2l-.6 3h4.4l.6-3h-.4zM9.5 8l-.9 5h4.4l.9-5zM16 17h6v2h-6zm-2 3h8v2h-8z",
    forum: "M4 3h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm16 5h.5A1.5 1.5 0 0 1 22 9.5V16a2 2 0 0 1-2 2h-1v3l-3-3h-5a2 2 0 0 1-1.7-1H16a4 4 0 0 0 4-4z",
    calendar: "M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zM5 10v10h14V10zm2 2h4v4H7z",
    poll: "M4 4h2v16H4zm5 6h2v10H9zm5-4h2v14h-2zm5 8h2v6h-2z",
    sticker: "M5 3h10l6 6v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm9 1.5V8a2 2 0 0 0 2 2h3.5zM8.5 11A1.5 1.5 0 1 0 10 12.5 1.5 1.5 0 0 0 8.5 11zm7 0a1.5 1.5 0 1 0 1.5 1.5 1.5 1.5 0 0 0-1.5-1.5zM7 15.5c1.2 1.6 3 2.5 5 2.5s3.8-.9 5-2.5z",
    star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
    check: "M9 16.2l-3.5-3.5L4 14.1 9 19 20 8l-1.4-1.4z",
    archive: "M3 3h18v4H3zm1 5h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zm5 3v2h6v-2z",
    apps: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-4H7v-2h4V7h2v4h4v2h-4z",
    game: "M7 6h10a5 5 0 0 1 4.9 6l-.9 4.5a2.5 2.5 0 0 1-4.3 1.1L14.5 15h-5l-2.2 2.6A2.5 2.5 0 0 1 3 16.5L2.1 12A5 5 0 0 1 7 6zm0 3v2H5v2h2v2h2v-2h2v-2H9V9zm9 0a1.2 1.2 0 1 0 0 2.4A1.2 1.2 0 0 0 16 9zm2 2.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z",
    music: "M12 3v10.6A4 4 0 1 0 14 17V7h4V3z",
    tv: "M3 5h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-7v2h3v2H7v-2h3v-2H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v9h16V7z"
  };
  function icon(name, cls) {
    return '<svg class="vsrv-ic' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="' + I[name] + '"/></svg>';
  }
  function silhouette(cls) {
    return '<span class="' + cls + ' silhouette" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v1h16v-1c0-2.66-5.33-4-8-4z"/></svg></span>';
  }
  function avatar(mid, sid, cls) {
    var c = cardOf(mid, sid);
    cls = cls || "vsrv-ava";
    var faces = root.ViktorychFaces;
    var src = c && c.avatar ? c.avatar : "";
    var mode = faces && faces.picture ? faces.picture(src) : (src ? "photo" : "default");
    if (mode === "none") return '<span class="' + cls + ' ava-none"></span>';
    if (!src || mode === "default") return silhouette(cls + " ava");
    return '<img class="' + cls + '" src="' + esc(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
  }
  function serverIcon(s, cls) {
    cls = cls || "vsrv-sicon";
    if (s && s.icon) return '<img class="' + cls + '" src="' + esc(s.icon) + '" alt="" loading="lazy" decoding="async">';
    var words = String((s && s.name) || "?").trim().split(/\s+/).slice(0, 3);
    var initials = words.map(function (w) { return Array.from(w)[0] || ""; }).join("").toUpperCase();
    return '<span class="' + cls + ' vsrv-initials" aria-hidden="true">' + esc(initials || "?") + "</span>";
  }
  function serverInfo(sid) {
    var st = srv(sid);
    var e = listEntry(sid);
    return (st && st.server) || e || null;
  }

  /* ---------- inbox section (inside the Discord list) ---------- */
  function inboxHtml() {
    if (!signedIn()) return "";
    if (S.list === null) loadList();
    var list = S.list || [];
    if (!list.length && !S.canCreate) return '<div class="vsrv-inbox" id="vsrv-inbox"><div class="vsrv-inbox-join"><button type="button" class="vsrv-linkbtn" data-vs="join-sheet">' + icon("compass") + "<span>" + esc(tr("Join a server with an invite")) + "</span></button></div></div>";
    var rows = list.map(function (s) {
      var b = serverBadge(s.id);
      var muted = notifyLevel(s.id, s.id) === "none";
      var last = msgTime(s.lastId);
      var chans = (s.channels || []).filter(function (c) { return c.kind !== "category"; }).length;
      return '<a class="vsrv-irow' + (b.unread ? " unread" : "") + (muted ? " muted" : "") + '" href="#/messages/s/' + s.id + '">' +
        '<span class="vsrv-irow-ic">' + serverIcon(s) + "</span>" +
        '<span class="vsrv-irow-main"><span class="vsrv-irow-top"><span class="vsrv-irow-name">' + esc(s.name) + "</span>" +
        (last ? '<span class="vsrv-irow-time">' + esc(shortAgo(last)) + "</span>" : "") + "</span>" +
        '<span class="vsrv-irow-sub">' + esc(trn(s.memberCount || 0, "members")) + " · " + esc(trn(chans, "srvChannels")) + "</span></span>" +
        (b.mentions ? '<span class="vsrv-badge">' + (b.mentions > 99 ? "99+" : b.mentions) + "</span>" : b.unread ? '<span class="vsrv-dot" aria-label="' + esc(tr("Unread")) + '"></span>' : "") +
        "</a>";
    }).join("");
    return '<div class="vsrv-inbox" id="vsrv-inbox"><div class="vsrv-inbox-head"><span>' + esc(tr("Your servers")) + '</span><span class="vsrv-inbox-acts">' +
      '<button type="button" class="vsrv-iconbtn" data-vs="join-sheet" aria-label="' + esc(tr("Join a server")) + '" title="' + esc(tr("Join a server")) + '">' + icon("compass") + "</button>" +
      (S.canCreate ? '<button type="button" class="vsrv-iconbtn" data-vs="create-sheet" aria-label="' + esc(tr("Create a server")) + '" title="' + esc(tr("Create a server")) + '">' + icon("plus") + "</button>" : "") +
      "</span></div>" + rows +
      (!list.length ? '<button type="button" class="vsrv-irow vsrv-irow-new" data-vs="create-sheet"><span class="vsrv-irow-ic"><span class="vsrv-sicon vsrv-initials">' + icon("plus") + '</span></span><span class="vsrv-irow-main"><span class="vsrv-irow-name">' + esc(tr("Create a server")) + '</span><span class="vsrv-irow-sub">' + esc(tr("Channels, roles and invites, all inside the app")) + "</span></span></button>" : "") +
      "</div>";
  }

  /* ---------- page ---------- */
  function routeOf(route) {
    var hash = (location.hash || "").replace(/^#/, "").split("?")[0];
    var parts = hash.split("/").filter(Boolean);
    if (parts[0] !== "messages") return null;
    if (parts[1] === "s" && /^[a-f0-9]{16}$/.test(parts[2] || "")) return { mode: "server", sid: parts[2], cid: /^[a-f0-9]{16}$/.test(parts[3] || "") ? parts[3] : "", jump: /^[0-9a-z]{16}$/.test(parts[4] || "") ? parts[4] : "" };
    if (parts[1] === "join" && /^[A-Za-z0-9]{4,16}$/.test(parts[2] || "")) return { mode: "join", code: parts[2] };
    return null;
  }
  function owns(route) { return !!routeOf(route); }

  function page(route) {
    var r = routeOf(route);
    if (!r) return "";
    S.mode = r.mode;
    if (r.mode === "join") { S.invite = r.code; return joinPage(); }
    if (S.sid !== r.sid) { S.reply = null; S.edit = ""; S.files = []; S.gone = ""; }
    var oldLog = el("vsrv-log");
    S.keepScroll = oldLog && S.sid === r.sid && S.cid === r.cid && !atBottom(oldLog) ? oldLog.scrollHeight - oldLog.scrollTop : 0;
    S.sid = r.sid;
    S.cid = r.cid;
    S.jump = r.jump || "";
    if (!S.servers[S.sid]) { var cached = lsGet("srv:" + S.sid, null); if (cached) S.servers[S.sid] = cached; }
    if (S.list === null) { var cl = lsGet("list", null); if (cl) { S.list = cl.servers || []; S.canCreate = !!cl.canCreate; } }
    return '<div class="dmsgs vsrv' + (S.cid ? " has-channel" : "") + (S.membersOpen ? " members-open" : "") + '" id="vsrv-root" data-sid="' + S.sid + '">' +
      '<nav class="vsrv-rail" id="vsrv-rail" aria-label="' + esc(tr("Servers")) + '">' + railInner() + "</nav>" +
      '<aside class="vsrv-side" id="vsrv-side">' + sideInner() + "</aside>" +
      '<section class="vsrv-conv" id="vsrv-conv">' + convInner() + "</section>" +
      '<aside class="vsrv-members" id="vsrv-members" aria-label="' + esc(tr("Members")) + '">' + membersInner() + "</aside>" +
      "</div>";
  }

  function railInner() {
    var list = S.list || [];
    var items = list.map(function (s) {
      var b = serverBadge(s.id);
      var on = s.id === S.sid;
      return '<a class="vsrv-rail-item' + (on ? " on" : "") + (b.unread ? " unread" : "") + '" href="#/messages/s/' + s.id + '" title="' + esc(s.name) + '" aria-label="' + esc(s.name) + '"' + (on ? ' aria-current="page"' : "") + ">" +
        '<span class="vsrv-rail-pill"></span>' + serverIcon(s) +
        (b.mentions ? '<span class="vsrv-badge vsrv-rail-badge">' + (b.mentions > 99 ? "99+" : b.mentions) + "</span>" : "") + "</a>";
    }).join("");
    return '<a class="vsrv-rail-item vsrv-rail-home" href="#/messages" title="' + esc(tr("Inbox")) + '" aria-label="' + esc(tr("Back to Inbox")) + '"><span class="vsrv-sicon vsrv-initials">' + icon("back") + "</span></a>" +
      '<span class="vsrv-rail-sep"></span>' + items +
      (S.canCreate ? '<button type="button" class="vsrv-rail-item vsrv-rail-add" data-vs="create-sheet" title="' + esc(tr("Create a server")) + '" aria-label="' + esc(tr("Create a server")) + '"><span class="vsrv-sicon vsrv-initials">' + icon("plus") + "</span></button>" : "") +
      '<button type="button" class="vsrv-rail-item vsrv-rail-add" data-vs="join-sheet" title="' + esc(tr("Join a server")) + '" aria-label="' + esc(tr("Join a server")) + '"><span class="vsrv-sicon vsrv-initials">' + icon("compass") + "</span></button>";
  }

  function orderedChannels(sid) {
    var chans = channelsOf(sid).slice().sort(function (a, b) { return a.position - b.position || (a.id < b.id ? -1 : 1); });
    var cats = chans.filter(function (c) { return c.kind === "category"; });
    var loose = chans.filter(function (c) { return c.kind !== "category" && !c.parentId; });
    var groups = [{ cat: null, items: loose }];
    cats.forEach(function (cat) { groups.push({ cat: cat, items: chans.filter(function (c) { return c.parentId === cat.id && c.kind !== "category"; }) }); });
    return groups;
  }
  function firstChannel(sid) {
    /* Land on a chat channel first, like Discord; a forum only when nothing else is visible. */
    var out = "", any = "";
    orderedChannels(sid).some(function (g) {
      return g.items.some(function (c) {
        if (!has(Number(c.perms) || 0, P.VIEW) || c.kind === "category") return false;
        if (!any) any = c.id;
        if (c.kind === "forum" || c.kind === "voice") return false;
        out = c.id; return true;
      });
    });
    return out || any;
  }

  function sideInner() {
    var info = serverInfo(S.sid);
    if (!info) {
      if (S.gone) return '<div class="vsrv-empty"><h2>' + esc(tr("Server not available")) + "</h2><p>" + esc(S.gone === "not_member" ? tr("You're not a member of this server.") : tr("It may have been deleted, or you were removed.")) + '</p><a class="vsrv-btn" href="#/messages">' + esc(tr("Back to Inbox")) + "</a></div>";
      return '<div class="vsrv-side-skel" aria-busy="true"><span></span><span></span><span></span><span></span></div>';
    }
    var canChan = has(basePerms(), P.MANAGE_CHANNELS);
    var head = '<button type="button" class="vsrv-side-head' + (info.banner ? " has-banner" : "") + '" data-vs="server-menu" aria-haspopup="menu">' +
      (info.banner ? '<img class="vsrv-banner" src="' + esc(info.banner) + '" alt="" loading="lazy" decoding="async">' : "") +
      '<span class="vsrv-side-title"><span>' + esc(info.name) + "</span>" + icon("chev") + "</span></button>";
    var groups = orderedChannels(S.sid).map(function (g) {
      var visible = g.items.filter(function (c) { return has(Number(c.perms) || 0, P.VIEW); });
      if (g.cat && !visible.length && !canChan) return "";
      var collapsed = g.cat && S.collapsed[g.cat.id];
      var rows = visible.filter(function (c) { return !collapsed || c.id === S.cid || channelUnread(c, S.sid); }).map(channelRow).join("");
      if (!g.cat) return rows;
      return '<div class="vsrv-cat' + (collapsed ? " collapsed" : "") + '"><div class="vsrv-cat-head"><button type="button" class="vsrv-cat-name" data-vs="toggle-cat" data-id="' + g.cat.id + '" aria-expanded="' + (collapsed ? "false" : "true") + '">' + icon("chev") + "<span>" + esc(g.cat.name) + "</span></button>" +
        (canChan ? '<button type="button" class="vsrv-iconbtn sm" data-vs="new-channel" data-id="' + g.cat.id + '" aria-label="' + esc(tr("Create channel")) + '" title="' + esc(tr("Create channel")) + '">' + icon("plus") + "</button>" : "") +
        "</div>" + rows + "</div>";
    }).join("");
    var invite = has(basePerms(), P.CREATE_INVITE) && !me().timeoutUntil ? '<button type="button" class="vsrv-side-invite" data-vs="invite-sheet">' + icon("users") + "<span>" + esc(tr("Invite people")) + "</span></button>" : "";
    var evN = (srv() && srv().events) || 0;
    var events = '<button type="button" class="vsrv-side-invite" data-vs="events">' + icon("calendar") + "<span>" + esc(evN ? trn(evN, "srvEventsN") : tr("Events")) + "</span></button>";
    return head + '<div class="vsrv-chlist" role="list">' + invite + events + groups + (canChan ? '<button type="button" class="vsrv-side-add" data-vs="new-channel">' + icon("plus") + "<span>" + esc(tr("Create channel")) + "</span></button>" : "") + "</div>" + voicePanel() + meBar();
  }
  function channelRow(c) {
    var on = c.id === S.cid;
    var unread = channelUnread(c, S.sid);
    var level = effectiveLevel(c.id, S.sid);
    var priv = !has(everyonePermsFor(c), P.VIEW);
    return '<a role="listitem" class="vsrv-ch' + (on ? " on" : "") + (unread ? " unread" : "") + (level === "none" ? " muted" : "") + '" href="#/messages/s/' + S.sid + "/" + c.id + '"' + (on ? ' aria-current="page"' : "") + ">" +
      icon(chanIcon(c), "vsrv-ch-ic") + (priv ? icon("lock", "vsrv-ch-lock") : "") +
      '<span class="vsrv-ch-name">' + esc(c.name) + "</span>" +
      (c.kind === "voice" && voiceIn(S.sid, c.id).length ? '<span class="vsrv-vcount">' + voiceIn(S.sid, c.id).length + "/" + VOICE_CAP + "</span>" : "") +
      (c.mentions ? '<span class="vsrv-badge">' + (c.mentions > 99 ? "99+" : c.mentions) + "</span>" : "") +
      (has(basePerms(), P.MANAGE_CHANNELS) ? '<button type="button" class="vsrv-ch-gear" data-vs="channel-settings" data-id="' + c.id + '" aria-label="' + esc(tr("Edit channel")) + '">' + icon("gear") + "</button>" : "") +
      "</a>" + (c.kind === "voice" ? voiceRows(c) : threadRows(c));
  }
  function chanIcon(c) { return c.kind === "voice" ? "voice" : c.kind === "announcement" ? "news" : c.kind === "forum" ? "forum" : c.kind === "thread" ? "thread" : "hash"; }
  function threadRows(c) {
    if (c.kind !== "text" && c.kind !== "announcement") return "";
    var cur = S.threads[S.cid];
    var list = (S.active[S.sid] || []).filter(function (t) { return t.parentId === c.id && !t.archived; });
    if (cur && cur.parentId === c.id && !list.some(function (t) { return t.id === cur.id; })) list.push(cur);
    list.sort(function (a, b) { return (b.lastId || b.id) > (a.lastId || a.id) ? 1 : -1; });
    var shown = list.slice(0, 3);
    if (cur && cur.parentId === c.id && shown.indexOf(cur) < 0) shown.push(cur);
    return shown.map(function (t) {
      var on = t.id === S.cid;
      return '<a role="listitem" class="vsrv-ch vsrv-throw' + (on ? " on" : "") + '" href="#/messages/s/' + S.sid + "/" + t.id + '"' + (on ? ' aria-current="page"' : "") + '><span class="vsrv-thline"></span><span class="vsrv-ch-name">' + esc(t.name) + "</span></a>";
    }).join("") + (list.length > 3 ? '<button type="button" class="vsrv-ch vsrv-throw more" data-vs="threads" data-id="' + c.id + '"><span class="vsrv-thline"></span><span class="vsrv-ch-name">' + esc(tr("See all threads")) + "</span></button>" : "");
  }
  function everyonePermsFor(c) {
    var st = srv();
    if (!st || !st.roles) return P.VIEW;
    var ev = role(S.sid);
    var perms = ev ? ev.perms : P.VIEW;
    var layers = [];
    var parent = c.parentId ? channel(c.parentId) : null;
    if (parent && parent.overrides) layers.push(parent.overrides);
    if (c.overrides) layers.push(c.overrides);
    layers.forEach(function (list) { list.forEach(function (o) { if (o.type === "role" && o.id === S.sid) perms = (perms & ~o.deny) | o.allow; }); });
    return perms;
  }
  function meBar() {
    var m = me();
    if (!m.mid) return "";
    var c = cardOf(m.mid);
    var level = notifyLevel(S.sid, S.sid) || "mentions";
    return '<div class="vsrv-mebar"><button type="button" class="vsrv-mebar-who" data-vs="member" data-m="' + m.mid + '">' + avatar(m.mid, S.sid, "vsrv-ava sm") +
      '<span class="vsrv-mebar-txt"><span class="vsrv-mebar-name">' + esc(m.nick || (c && (c.name || c.handle)) || tr("You")) + "</span>" +
      (m.timeoutUntil && m.timeoutUntil > Date.now() ? '<span class="vsrv-mebar-sub warn">' + esc(tr("Timed out until {time}", { time: fullTime(m.timeoutUntil) })) + "</span>" : actOf(m.mid) ? '<span class="vsrv-mebar-sub">' + esc(actText(actOf(m.mid))) + "</span>" : c && c.handle ? '<span class="vsrv-mebar-sub">@' + esc(c.handle) + "</span>" : "") + "</span></button>" +
      voiceMeButtons() +
      '<button type="button" class="vsrv-iconbtn" data-vs="notify-sheet" data-scope="' + S.sid + '" aria-label="' + esc(tr("Notification settings")) + '" title="' + esc(tr("Notification settings")) + '">' + icon(level === "none" ? "bellOff" : "bell") + "</button>" +
      (canManage() ? '<button type="button" class="vsrv-iconbtn" data-vs="settings" aria-label="' + esc(tr("Server settings")) + '" title="' + esc(tr("Server settings")) + '">' + icon("gear") + "</button>" : "") +
      "</div>";
  }

  /* ---------- voice (calls run in servers-voice.js) ---------- */
  var VOICE_CAP = 8;
  var voiceReady = false;
  function vv() {
    var v = root.ViktorychVoice || null;
    if (v && !voiceReady) {
      voiceReady = true;
      v.init({ call: call, api: api, notice: voiceNotice });
      v.on(function (st, kind) { if (kind === "speaking") paintSpeaking(); else paintVoice(); });
    }
    return v;
  }
  function voiceNotice(why) {
    var text = {
      full: tr("This voice channel is full ({n} people).", { n: VOICE_CAP }),
      perm: tr("You can't join this voice channel."),
      moved: tr("You joined voice on another device or tab."),
      kicked: tr("A moderator disconnected you from voice."),
      nomic: tr("No microphone. You joined muted."),
      nocam: tr("Couldn't turn on the camera."),
      noscreen: tr("Screen sharing isn't available on this device."),
      unsupported: tr("Voice isn't supported in this browser.")
    }[why] || tr("Voice disconnected.");
    toast(text);
  }
  function vstate() { var v = vv(); return v ? v.state() : null; }
  function inVoice(sid, cid) { var V = vstate(); return !!(V && V.status !== "idle" && V.sid === sid && (!cid || V.cid === cid)); }
  function voiceBag(sid) {
    var V = vstate();
    var bag = S.voice[sid] || {};
    if (V && V.sid === sid && V.status === "connected") {
      var out = {};
      Object.keys(bag).forEach(function (k) { if (bag[k].c !== V.cid) out[k] = bag[k]; });
      Object.keys(V.roster).forEach(function (k) { out[k] = V.roster[k]; });
      return out;
    }
    return bag;
  }
  var voiceAsked = {};
  function voiceIn(sid, cid) {
    var bag = voiceBag(sid);
    var list = Object.keys(bag).filter(function (k) { return bag[k] && bag[k].c === cid; }).sort(function (a, b) { return (bag[a].j || 0) - (bag[b].j || 0); });
    /* People in voice may not be in the loaded member list; fetch their cards once. */
    var asked = voiceAsked[sid] || (voiceAsked[sid] = {});
    var fresh = list.filter(function (m) { return !asked[m]; });
    if (fresh.length) { fresh.forEach(function (m) { asked[m] = 1; }); needCards(fresh, sid); }
    return list;
  }
  function voiceSt(sid, mid) { var r = voiceBag(sid)[mid]; return (r && r.st) || {}; }
  function isSpeaking(mid) {
    var V = vstate();
    if (!V || V.status !== "connected") return false;
    return mid === V.mid ? !!V.speaking.me : !!V.speaking[mid];
  }
  function voiceFlags(st) {
    return (st.sm ? icon("micOff", "vsrv-vflag sm") : st.mu ? icon("micOff", "vsrv-vflag") : "") + (st.df ? icon("headOff", "vsrv-vflag") : "") +
      (st.cam ? icon("video", "vsrv-vflag") : "") + (st.scr ? '<span class="vsrv-live">' + esc(tr("LIVE")) + "</span>" : "");
  }
  function voiceRows(c) {
    var list = voiceIn(S.sid, c.id);
    if (!list.length) return "";
    return '<div class="vsrv-vrows">' + list.map(function (mid) {
      var st = voiceSt(S.sid, mid);
      return '<button type="button" class="vsrv-vrow" data-vs="member" data-m="' + mid + '">' +
        '<span class="vsrv-vring' + (isSpeaking(mid) ? " speaking" : "") + '" data-spk="' + mid + '">' + avatar(mid, S.sid, "vsrv-ava xs") + "</span>" +
        '<span class="vsrv-vrow-name">' + esc(nameOf(mid)) + "</span>" + voiceFlags(st) + "</button>";
    }).join("") + "</div>";
  }
  function voiceStatusText(V) {
    return V.status === "connected" ? tr("Voice connected") : V.status === "reconnecting" ? tr("Reconnecting…") : tr("Connecting…");
  }
  function voicePanel() {
    var V = vstate();
    if (!V || V.status === "idle") return "";
    var info = serverInfo(V.sid) || {};
    var c = channel(V.cid, V.sid);
    var v = vv();
    return '<div class="vsrv-vpanel ' + esc(V.status) + '"><div class="vsrv-vpanel-top">' +
      '<button type="button" class="vsrv-vpanel-info" data-vs="voice-open">' + icon("signal", "vsrv-vpanel-sig") + '<span><strong>' + esc(voiceStatusText(V)) + "</strong><small>" + esc((c ? c.name : "") + (info.name ? " / " + info.name : "")) + "</small></span></button>" +
      '<button type="button" class="vsrv-iconbtn danger" data-vs="voice-leave" aria-label="' + esc(tr("Disconnect")) + '" title="' + esc(tr("Disconnect")) + '">' + icon("hangup") + "</button></div>" +
      '<div class="vsrv-vpanel-acts">' +
      '<button type="button" class="vsrv-vbtn' + (V.cam ? " on" : "") + '" data-vs="voice-cam" aria-pressed="' + (V.cam ? "true" : "false") + '">' + icon(V.cam ? "video" : "videoOff") + "<span>" + esc(tr("Camera")) + "</span></button>" +
      (v.canScreen() ? '<button type="button" class="vsrv-vbtn' + (V.scr ? " on" : "") + '" data-vs="voice-screen" aria-pressed="' + (V.scr ? "true" : "false") + '">' + icon("screen") + "<span>" + esc(tr("Screen")) + "</span></button>" : "") +
      "</div></div>";
  }
  function voiceMeButtons() {
    var V = vstate();
    if (!V || V.status === "idle") return "";
    var mu = V.mu || V.sm;
    return '<button type="button" class="vsrv-iconbtn' + (mu ? " danger-on" : "") + '" data-vs="voice-mute" aria-pressed="' + (mu ? "true" : "false") + '" aria-label="' + esc(mu ? tr("Unmute") : tr("Mute")) + '" title="' + esc(V.sm ? tr("Server muted") : mu ? tr("Unmute") : tr("Mute")) + '">' + icon(mu ? "micOff" : "mic") + "</button>" +
      '<button type="button" class="vsrv-iconbtn' + (V.df ? " danger-on" : "") + '" data-vs="voice-deaf" aria-pressed="' + (V.df ? "true" : "false") + '" aria-label="' + esc(V.df ? tr("Undeafen") : tr("Deafen")) + '" title="' + esc(V.df ? tr("Undeafen") : tr("Deafen")) + '">' + icon(V.df ? "headOff" : "headphones") + "</button>";
  }
  function voiceHead(c) {
    var n = voiceIn(S.sid, c.id).length;
    return '<header class="vsrv-conv-head"><a class="vsrv-back" href="#/messages/s/' + S.sid + '" aria-label="' + esc(tr("Back")) + '">' + icon("back") + "</a>" +
      icon("voice", "vsrv-conv-ic") + '<h2 class="vsrv-conv-name">' + esc(c.name) + "</h2>" +
      '<span class="vsrv-conv-topic">' + (n ? esc(n + "/" + VOICE_CAP) : "") + "</span>" +
      '<span class="vsrv-conv-acts"><button type="button" class="vsrv-iconbtn vsrv-mem-toggle' + (S.membersOpen ? " on" : "") + '" data-vs="members-toggle" aria-label="' + esc(tr("Members")) + '" title="' + esc(tr("Members")) + '">' + icon("users") + "</button></span></header>";
  }
  function stageTile(mid, kind, V) {
    var self = mid === V.mid;
    var st = self ? { mu: V.mu || V.sm, df: V.df, cam: V.cam, scr: V.scr, sm: V.sm } : voiceSt(V.sid, mid);
    var key = mid + ":" + kind;
    var video = kind === "scr" || st.cam;
    var conn = self ? "connected" : vv().peerConn(mid);
    var p = V.peers[mid];
    var name = nameOf(mid, V.sid) + (kind === "scr" ? " · " + tr("Screen") : "");
    return '<div class="vsrv-vtile' + (video ? " video" : "") + (kind === "scr" ? " screen" : "") + (S.vfocus === key ? " focus" : "") + (kind === "cam" && isSpeaking(mid) ? " speaking" : "") + '"' + (kind === "cam" ? ' data-spk="' + mid + '"' : "") + ">" +
      '<button type="button" class="vsrv-vtile-hit" data-vs="voice-tile" data-key="' + esc(key) + '" aria-label="' + esc(name) + '"></button>' +
      (kind === "cam" ? '<span class="vsrv-vtile-ava">' + avatar(mid, V.sid, "vsrv-ava xl") + "</span>" : "") +
      (video ? '<div class="vsrv-vmedia" data-vmedia="' + (self ? "me" : mid) + ":" + kind + '"></div>' : "") +
      '<span class="vsrv-vname">' + (kind === "cam" && (st.mu || st.sm) ? icon("micOff", "vsrv-vflag") : "") + (kind === "cam" && st.df ? icon("headOff", "vsrv-vflag") : "") + "<span>" + esc(name) + "</span></span>" +
      (conn === "failed" ? '<span class="vsrv-vbad">' + esc(tr("Couldn't connect")) + "</span>" : conn !== "connected" ? '<span class="vsrv-vwait">' + esc(tr("Connecting…")) + "</span>" : "") +
      (!self && kind === "cam" ? '<button type="button" class="vsrv-vtile-more" data-vs="voice-peer" data-m="' + mid + '" aria-label="' + esc(tr("More")) + '">' + icon(p && p.localMute ? "volOff" : "more") + "</button>" : "") +
      "</div>";
  }
  function stageInner(c) {
    var V = vstate();
    var v = vv();
    var people = voiceIn(S.sid, c.id);
    if (!v || !inVoice(S.sid, c.id)) {
      var perms = Number(c.perms) || 0;
      var can = has(perms, P.CONNECT);
      var full = people.length >= VOICE_CAP;
      var ok = v && v.supported();
      return '<div class="vsrv-stage-pre">' + icon("voice", "vsrv-stage-ic") + "<h2>" + esc(c.name) + "</h2>" +
        (people.length ? '<div class="vsrv-stage-who">' + people.map(function (m) { return '<span class="vsrv-vring' + (isSpeaking(m) ? " speaking" : "") + '" title="' + esc(nameOf(m)) + '">' + avatar(m, S.sid, "vsrv-ava md") + "</span>"; }).join("") + "</div><p>" + esc(trn(people.length, "srvVoiceIn")) + "</p>" : "<p>" + esc(tr("No one is here yet.")) + "</p>") +
        '<button type="button" class="vsrv-btn big" data-vs="voice-join" data-id="' + c.id + '"' + (can && !full && ok ? "" : " disabled") + ">" + esc(full ? tr("Channel is full") : tr("Join voice")) + "</button>" +
        '<p class="vsrv-stage-note">' + esc(!ok ? tr("Voice isn't supported in this browser.") : !can ? tr("You can't join this voice channel.") : tr("Voice and video go straight between devices. Some strict networks block this.")) + "</p></div>";
    }
    var tiles = [];
    people.forEach(function (mid) {
      tiles.push(stageTile(mid, "cam", V));
      var st = mid === V.mid ? { scr: V.scr } : voiceSt(V.sid, mid);
      if (st.scr) tiles.push(stageTile(mid, "scr", V));
    });
    var mu = V.mu || V.sm;
    return '<div class="vsrv-tiles' + (S.vfocus ? " has-focus" : "") + " n" + Math.min(tiles.length, 9) + '">' + tiles.join("") + "</div>" +
      '<div class="vsrv-vbar">' +
      '<button type="button" class="vsrv-vround' + (mu ? " off" : "") + '" data-vs="voice-mute" aria-pressed="' + (mu ? "true" : "false") + '" aria-label="' + esc(mu ? tr("Unmute") : tr("Mute")) + '">' + icon(mu ? "micOff" : "mic") + "</button>" +
      '<button type="button" class="vsrv-vround' + (V.df ? " off" : "") + '" data-vs="voice-deaf" aria-pressed="' + (V.df ? "true" : "false") + '" aria-label="' + esc(V.df ? tr("Undeafen") : tr("Deafen")) + '">' + icon(V.df ? "headOff" : "headphones") + "</button>" +
      '<button type="button" class="vsrv-vround' + (V.cam ? " on" : "") + '" data-vs="voice-cam" aria-pressed="' + (V.cam ? "true" : "false") + '" aria-label="' + esc(tr("Camera")) + '">' + icon(V.cam ? "video" : "videoOff") + "</button>" +
      (v.canScreen() ? '<button type="button" class="vsrv-vround' + (V.scr ? " on" : "") + '" data-vs="voice-screen" aria-pressed="' + (V.scr ? "true" : "false") + '" aria-label="' + esc(tr("Share your screen")) + '">' + icon("screen") + "</button>" : "") +
      '<button type="button" class="vsrv-vround leave" data-vs="voice-leave" aria-label="' + esc(tr("Disconnect")) + '">' + icon("hangup") + "</button></div>";
  }
  function mountStage() { var box = el("vsrv-stage"); var v = vv(); if (box && v) v.mount(box); }
  function paintStage() {
    var box = el("vsrv-stage");
    var c = S.cid ? channel(S.cid) : null;
    if (!box || !c || c.kind !== "voice") return;
    box.innerHTML = stageInner(c);
    mountStage();
  }
  function paintVoice() {
    if (S.mode !== "server" || !rootEl()) return;
    paintSide();
    paintStage();
    var c = S.cid ? channel(S.cid) : null;
    var head = el("vsrv-conv") && el("vsrv-conv").querySelector(".vsrv-conv-head .vsrv-conv-topic");
    if (c && c.kind === "voice" && head) { var n = voiceIn(S.sid, c.id).length; head.textContent = n ? n + "/" + VOICE_CAP : ""; }
  }
  function paintSpeaking() {
    Array.prototype.forEach.call(document.querySelectorAll("#vsrv-root [data-spk]"), function (n) {
      n.classList.toggle("speaking", isSpeaking(n.getAttribute("data-spk")));
    });
  }
  function voiceJoin(cid) {
    var v = vv();
    if (!v) { toast(tr("Voice isn't supported in this browser.")); return; }
    if (!v.supported()) { voiceNotice("unsupported"); return; }
    S.vfocus = "";
    v.join(S.sid, cid || S.cid);
  }
  function voiceToggle(what) {
    var v = vv();
    var V = vstate();
    if (!v || !V || V.status === "idle") return;
    if (what === "mute") { if (V.sm) { toast(tr("A moderator muted you, or you can't speak here.")); return; } v.setMute(!V.mu); }
    else if (what === "deaf") v.setDeaf(!V.df);
    else if (what === "cam") { if (!V.cam && !has(chanPerms(V.cid, V.sid), P.VIDEO)) { toast(tr("You can't use the camera or share your screen here.")); return; } v.setCamera(!V.cam); }
    else if (what === "screen") { if (!V.scr && !has(chanPerms(V.cid, V.sid), P.VIDEO)) { toast(tr("You can't use the camera or share your screen here.")); return; } v.setScreen(!V.scr); }
  }
  function voiceFocus(key) {
    S.vfocus = S.vfocus === key ? "" : key;
    paintStage();
  }
  function voicePeerMenu(mid) {
    var V = vstate();
    if (!V || !mid) return;
    var p = V.peers[mid] || {};
    var st = voiceSt(V.sid, mid);
    var mod = has(chanPerms(V.cid, V.sid), P.MUTE_MEMBERS);
    var vol = Math.round((p.volume == null ? 1 : p.volume) * 100);
    var sheet = openSheet(sheetHead(nameOf(mid)) + '<div class="vsrv-menu">' +
      '<label class="vsrv-vvol"><span>' + esc(tr("User volume")) + '</span><input type="range" min="0" max="200" step="5" value="' + vol + '" data-k="vol"></label>' +
      '<button type="button" class="vsrv-menu-item" data-vs="voice-peer-mute" data-id="' + mid + '" data-close="1">' + icon(p.localMute ? "voice" : "volOff") + "<span>" + esc(p.localMute ? tr("Unmute for me") : tr("Mute for me")) + "</span></button>" +
      '<button type="button" class="vsrv-menu-item" data-vs="member" data-m="' + mid + '" data-close="1">' + icon("users") + "<span>" + esc(tr("Profile")) + "</span></button>" +
      (mod ? '<button type="button" class="vsrv-menu-item" data-vs="voice-mod-mute" data-id="' + mid + '" data-on="' + (st.sm ? "1" : "0") + '" data-close="1">' + icon("micOff") + "<span>" + esc(st.sm ? tr("Remove server mute") : tr("Server mute")) + "</span></button>" +
        '<button type="button" class="vsrv-menu-item danger" data-vs="voice-mod-kick" data-id="' + mid + '" data-close="1">' + icon("hangup") + "<span>" + esc(tr("Disconnect from voice")) + "</span></button>" : "") +
      "</div>", "is-menu");
    var range = sheet.querySelector('[data-k="vol"]');
    range.addEventListener("input", function () { var v = vv(); if (v) v.setPeerVolume(mid, Number(range.value) / 100); });
  }
  function voiceModerate(mid, act) {
    var v = vv();
    if (!v || !v.moderate(mid, act)) toast(tr("Couldn't do that. Try again."));
  }

  /* ---------- conversation ---------- */
  function convInner() {
    var c = S.cid ? channel(S.cid) : null;
    if (!S.cid) {
      return '<div class="vsrv-empty vsrv-conv-empty"><h2>' + esc(tr("Pick a channel")) + "</h2><p>" + esc(tr("Choose a channel on the left to read and chat.")) + "</p></div>";
    }
    if (!c) {
      if (!srv() && !S.gone || srv() && /^[a-f0-9]{16}$/.test(S.cid) && !threadMiss[S.cid]) return '<div class="dmsgs-skel" aria-busy="true"><span></span><span></span><span></span></div>';
      return '<div class="vsrv-empty vsrv-conv-empty"><h2>' + esc(tr("Channel not found")) + "</h2><p>" + esc(tr("It may have been deleted, or you can't see it.")) + "</p></div>";
    }
    if (c.kind === "voice") return voiceHead(c) + '<div class="vsrv-stage" id="vsrv-stage">' + stageInner(c) + "</div>";
    var level = effectiveLevel(c.kind === "thread" ? c.parentId : c.id);
    var th = c.kind === "thread" ? c.thread : null;
    var parent = th ? realChannel(th.parentId) : null;
    var head = '<header class="vsrv-conv-head"><a class="vsrv-back" href="#/messages/s/' + S.sid + (th ? "/" + th.parentId : "") + '" aria-label="' + esc(tr("Back")) + '">' + icon("back") + "</a>" +
      (th && parent ? '<a class="vsrv-crumb" href="#/messages/s/' + S.sid + "/" + parent.id + '">' + icon(chanIcon(parent), "vsrv-conv-ic") + "<span>" + esc(parent.name) + "</span></a>" + icon("chev", "vsrv-crumb-sep") : "") +
      icon(chanIcon(c), "vsrv-conv-ic") + '<h2 class="vsrv-conv-name">' + esc(c.name) + "</h2>" +
      (th ? '<span class="vsrv-conv-topic">' + (th.locked ? icon("lock", "vsrv-th-flag") : "") + (th.archived ? icon("archive", "vsrv-th-flag") : "") + "</span>" : c.topic ? '<button type="button" class="vsrv-conv-topic" data-vs="topic">' + esc(plain(c.topic)) + "</button>" : '<span class="vsrv-conv-topic"></span>') +
      '<span class="vsrv-conv-acts">' +
      (th ? '<button type="button" class="vsrv-iconbtn" data-vs="thread-menu" aria-label="' + esc(tr("Thread settings")) + '" title="' + esc(tr("Thread settings")) + '">' + icon("more") + "</button>" : "") +
      (c.kind === "text" || c.kind === "announcement" ? '<button type="button" class="vsrv-iconbtn" data-vs="threads" data-id="' + c.id + '" aria-label="' + esc(tr("Threads")) + '" title="' + esc(tr("Threads")) + '">' + icon("thread") + "</button>" : "") +
      '<button type="button" class="vsrv-iconbtn" data-vs="notify-sheet" data-scope="' + (th ? th.parentId : c.id) + '" aria-label="' + esc(tr("Notification settings")) + '" title="' + esc(tr("Notification settings")) + '">' + icon(level === "none" ? "bellOff" : "bell") + "</button>" +
      '<button type="button" class="vsrv-iconbtn" data-vs="pins" aria-label="' + esc(tr("Pinned messages")) + '" title="' + esc(tr("Pinned messages")) + '">' + icon("pin") + "</button>" +
      '<button type="button" class="vsrv-iconbtn" data-vs="search-sheet" aria-label="' + esc(tr("Search")) + '" title="' + esc(tr("Search")) + '">' + icon("search") + "</button>" +
      '<button type="button" class="vsrv-iconbtn vsrv-mem-toggle' + (S.membersOpen ? " on" : "") + '" data-vs="members-toggle" aria-label="' + esc(tr("Members")) + '" title="' + esc(tr("Members")) + '">' + icon("users") + "</button>" +
      "</span></header>";
    if (c.kind === "forum") return head + '<div class="vsrv-forum" id="vsrv-forum">' + forumInner(c) + "</div>";
    return head + '<div class="vsrv-log" id="vsrv-log" role="log" aria-live="polite">' + logInner() + "</div>" +
      '<div class="vsrv-typing" id="vsrv-typing" aria-live="polite">' + typingInner() + "</div>" +
      '<div class="vsrv-compose-wrap" id="vsrv-compose">' + composeInner() + "</div>";
  }

  function logInner() {
    var c = channel(S.cid);
    var list = S.msgs[S.cid];
    if (!list) {
      if (S.loadErr === "perm") return '<div class="vsrv-empty"><h2>' + esc(tr("No access")) + "</h2><p>" + esc(tr("You can't read this channel.")) + "</p></div>";
      return '<div class="dmsgs-skel" aria-busy="true" aria-label="' + esc(tr("Loading messages")) + '"><span></span><span></span><span></span><span></span></div>';
    }
    var intro = S.more[S.cid] ? '<div class="vsrv-older"><button type="button" class="vsrv-linkbtn" data-vs="older">' + esc(tr("Load older messages")) + "</button></div>"
      : c && c.kind === "thread" ? threadIntro(c)
      : '<div class="vsrv-intro">' + icon(c && c.kind === "announcement" ? "news" : "hash", "vsrv-intro-ic") + "<h2>" + esc(tr("Welcome to #{name}!", { name: c ? c.name : "" })) + "</h2><p>" + esc(tr("This is the start of the #{name} channel.", { name: c ? c.name : "" })) + "</p></div>";
    var readMark = S.readMark || "";
    var prev = null;
    var markDone = false;
    var html = list.map(function (m) {
      var t = m.t || msgTime(m.id);
      var out = "";
      if (!prev || new Date(prev.t || msgTime(prev.id)).toDateString() !== new Date(t).toDateString()) out += '<div class="vsrv-day"><span>' + esc(dayLabel(t)) + "</span></div>";
      if (readMark && !markDone && !m.pending && m.id > readMark && m.a !== me().mid) { markDone = true; out += '<div class="vsrv-new"><span>' + esc(tr("New")) + "</span></div>"; }
      var fresh = !prev || prev.a !== m.a || m.r || m.f || prev.f || m.st || prev.st || t - (prev.t || msgTime(prev.id)) > 7 * 60 * 1000 || out;
      out += messageHtml(m, fresh);
      prev = m;
      return out;
    }).join("");
    return intro + html;
  }

  function messageHtml(m, fresh) {
    var sid = S.sid;
    var t = m.t || msgTime(m.id);
    var mine = m.a === me().mid;
    if (m.f === 1) {
      return '<article class="vsrv-msg sys" data-id="' + esc(m.id) + '"><span class="vsrv-sys-ic">' + icon("door") + '</span><span class="vsrv-sys-text">' +
        tr("{name} joined the server.", { name: '<button type="button" class="vsrv-name" data-vs="member" data-m="' + esc(m.a) + '">' + esc(nameOf(m.a, sid)) + "</button>" }) +
        ' <time datetime="' + new Date(t).toISOString() + '">' + esc(clock(t)) + "</time></span></article>";
    }
    if (m.f === 2) {
      var tn = {};
      try { tn = JSON.parse(m.b || "{}") || {}; } catch (err) { tn = {}; }
      return '<article class="vsrv-msg sys" data-id="' + esc(m.id) + '"><span class="vsrv-sys-ic">' + icon("thread") + '</span><span class="vsrv-sys-text">' +
        tr("{name} started a thread: {thread}", { name: '<button type="button" class="vsrv-name" data-vs="member" data-m="' + esc(m.a) + '">' + esc(nameOf(m.a, sid)) + "</button>", thread: '<a class="vsrv-sys-link" href="#/messages/s/' + sid + "/" + esc(tn.t || "") + '">' + esc((S.threads[tn.t] && S.threads[tn.t].name) || tn.n || tr("Thread")) + "</a>" }) +
        ' <time datetime="' + new Date(t).toISOString() + '">' + esc(clock(t)) + "</time></span></article>";
    }
    var mentioned = m.mn && (m.mn.e || (m.mn.u || []).indexOf(me().mid) >= 0 || (m.mn.r || []).some(function (r) { return (me().roles || []).indexOf(r) >= 0; }));
    var col = memberColor(m.a, sid);
    var head = fresh ? '<div class="vsrv-head"><button type="button" class="vsrv-name" data-vs="member" data-m="' + esc(m.a) + '"' + (col ? ' style="color:' + col + '"' : "") + ">" + esc(nameOf(m.a, sid)) + "</button>" +
      (cardOf(m.a, sid) && cardOf(m.a, sid).owner ? '<span class="vsrv-crown" title="' + esc(tr("Server owner")) + '">' + icon("shield") + "</span>" : "") +
      '<time datetime="' + new Date(t).toISOString() + '" title="' + esc(fullTime(t)) + '">' + esc(clock(t)) + "</time></div>" : "";
    var reply = "";
    if (m.r) {
      if (m.r.gone) reply = '<div class="vsrv-reply gone">' + icon("reply") + "<span>" + esc(tr("Original message was deleted")) + "</span></div>";
      else reply = '<button type="button" class="vsrv-reply" data-vs="jump" data-id="' + esc(m.r.id) + '">' + avatar(m.r.a, sid, "vsrv-ava xs") + '<span class="vsrv-reply-name">' + esc(nameOf(m.r.a, sid)) + '</span><span class="vsrv-reply-text">' + esc(m.r.x ? tr("Removed by a moderator") : (plain(m.r.b, sid) || (m.r.f ? tr("Attachment") : ""))).slice(0, 160) + "</span></button>";
    }
    var body;
    if (m.x) {
      var show = S.expanded[m.id];
      body = '<div class="vsrv-removed">' + icon("shield") + "<span>" + esc(tr("Removed by a moderator")) + (m.x.reason ? " · " + esc(m.x.reason) : "") + "</span>" +
        (m.x.by ? '<button type="button" class="vsrv-linkbtn" data-vs="member" data-m="' + esc(m.x.by) + '">' + esc(nameOf(m.x.by, sid)) + "</button>" : "") +
        (m.x.text ? '<button type="button" class="vsrv-linkbtn" data-vs="expand" data-id="' + esc(m.id) + '">' + esc(show ? tr("Hide") : tr("Show original")) + "</button>" : "") + "</div>" +
        (show && m.x.text ? '<div class="vsrv-text vsrv-removed-text">' + format(m.x.text, sid) + "</div>" : "");
    } else if (S.edit === m.id) {
      body = '<div class="vsrv-editbox"><textarea class="vsrv-edit-input" id="vsrv-edit" rows="1" maxlength="4000">' + esc(m.b) + '</textarea><div class="vsrv-edit-hint">' + esc(tr("Escape to cancel · Enter to save")) + ' <button type="button" class="vsrv-linkbtn" data-vs="edit-cancel">' + esc(tr("Cancel")) + '</button> <button type="button" class="vsrv-linkbtn" data-vs="edit-save">' + esc(tr("Save")) + "</button></div></div>";
    } else {
      var big = emojiOnly(m.b);
      body = (m.b ? '<div class="vsrv-text' + (big ? " jumbo" : "") + '">' + format(m.b, sid) + (m.e ? ' <span class="vsrv-edited" title="' + esc(fullTime(m.e)) + '">' + esc(tr("(edited)")) + "</span>" : "") + "</div>" : "") +
        filesHtml(m) + linkCard(m) + stickerHtml(m) + pollHtml(m);
    }
    var state = m.pending ? (m.failed ? '<div class="vsrv-failed">' + esc(m.failed === "offline" ? tr("Waiting for connection…") : m.failed) + ' <button type="button" class="vsrv-linkbtn" data-vs="retry" data-n="' + esc(m.n) + '">' + esc(tr("Retry")) + '</button> <button type="button" class="vsrv-linkbtn" data-vs="discard" data-n="' + esc(m.n) + '">' + esc(tr("Delete")) + "</button></div>" : "") : "";
    var cls = "vsrv-msg" + (fresh ? " group" : " cont") + (m.pending ? " pending" : "") + (mentioned ? " mentioned" : "") + (m.p ? " pinned" : "") + (S.flash === m.id ? " flash" : "") + (mine ? " mine" : "") + (m.x ? " removed" : "");
    return '<article class="' + cls + '" data-id="' + esc(m.id) + '">' + reply +
      '<div class="vsrv-msg-row"><div class="vsrv-gutter">' + (fresh ? '<button type="button" class="vsrv-ava-btn" data-vs="member" data-m="' + esc(m.a) + '" tabindex="-1" aria-hidden="true">' + avatar(m.a, sid) + "</button>" : '<time class="vsrv-hover-time" datetime="' + new Date(t).toISOString() + '">' + esc(clock(t)) + "</time>") + "</div>" +
      '<div class="vsrv-body">' + head + body + reactionsHtml(m) + threadChip(m) + state + "</div>" +
      (m.pending || m.x ? "" : toolsHtml(m)) + "</div></article>";
  }
  function toolsHtml(m) {
    var perms = chanPerms(S.cid);
    var canReact = has(perms, P.REACT) && !timedOut();
    return '<div class="vsrv-tools" role="toolbar">' +
      (canReact ? '<button type="button" data-vs="react-pick" data-id="' + esc(m.id) + '" aria-label="' + esc(tr("Add reaction")) + '" title="' + esc(tr("Add reaction")) + '">' + icon("smile") + "</button>" : "") +
      (has(perms, P.SEND) && !timedOut() ? '<button type="button" data-vs="reply" data-id="' + esc(m.id) + '" aria-label="' + esc(tr("Reply")) + '" title="' + esc(tr("Reply")) + '">' + icon("reply") + "</button>" : "") +
      (m.a === me().mid && !m.st && !m.pl ? '<button type="button" data-vs="edit" data-id="' + esc(m.id) + '" aria-label="' + esc(tr("Edit")) + '" title="' + esc(tr("Edit")) + '">' + icon("edit") + "</button>" : "") +
      (canThreadFrom(m) ? '<button type="button" data-vs="thread-from" data-id="' + esc(m.id) + '" aria-label="' + esc(tr("Create thread")) + '" title="' + esc(tr("Create thread")) + '">' + icon("thread") + "</button>" : "") +
      '<button type="button" data-vs="msg-menu" data-id="' + esc(m.id) + '" aria-label="' + esc(tr("More")) + '" title="' + esc(tr("More")) + '">' + icon("more") + "</button></div>";
  }
  function timedOut() { var m = me(); return !!(m.timeoutUntil && m.timeoutUntil > Date.now()); }
  function reactionFace(key, sid) {
    if (key.indexOf("c:") === 0) {
      var e = emojiById(key.slice(2), sid);
      return e ? '<img class="vsrv-emoji" src="' + esc(e.url) + '" alt=":' + esc(e.name) + ':" loading="lazy" decoding="async">' : '<span class="vsrv-emoji-gone">?</span>';
    }
    return '<span class="vsrv-uni">' + esc(key) + "</span>";
  }
  function reactionsHtml(m) {
    if (!m.rx || !m.rx.length) return "";
    var can = has(chanPerms(S.cid), P.REACT) && !timedOut();
    return '<div class="vsrv-rxs">' + m.rx.map(function (r) {
      return '<button type="button" class="vsrv-rx' + (r.me ? " me" : "") + '" data-vs="react" data-id="' + esc(m.id) + '" data-e="' + esc(r.e) + '"' + (can ? "" : " disabled") + ' aria-pressed="' + (r.me ? "true" : "false") + '">' + reactionFace(r.e, S.sid) + "<span>" + r.n + "</span></button>";
    }).join("") + (can ? '<button type="button" class="vsrv-rx add" data-vs="react-pick" data-id="' + esc(m.id) + '" aria-label="' + esc(tr("Add reaction")) + '">' + icon("smile") + "</button>" : "") + "</div>";
  }
  function filesHtml(m) {
    if (!m.at || !m.at.length) return "";
    var media = [];
    var others = [];
    m.at.forEach(function (f) {
      var type = String(f.type || "");
      if (/^image\//.test(type) && f.url) {
        var ratio = f.w && f.h ? ' style="aspect-ratio:' + f.w + "/" + f.h + '"' : "";
        media.push('<a class="vsrv-shot" href="' + esc(f.url) + '" target="_blank" rel="noopener noreferrer"' + ratio + '><img src="' + esc(f.url) + '" alt="' + esc(f.name || "") + '"' + (f.w ? ' width="' + f.w + '" height="' + f.h + '"' : "") + ' loading="lazy" decoding="async"></a>');
      } else if (/^video\//.test(type) && f.url) {
        media.push('<video class="vsrv-video" controls playsinline preload="metadata" src="' + esc(f.url) + '"' + (f.w ? ' width="' + f.w + '" height="' + f.h + '"' : "") + "></video>");
      } else if (/^audio\//.test(type) && f.url) {
        others.push('<div class="vsrv-file audio"><span class="vsrv-file-name">' + esc(f.name || "") + '</span><audio controls preload="none" src="' + esc(f.url) + '"></audio></div>');
      } else {
        others.push('<a class="vsrv-file"' + (f.url ? ' href="' + esc(f.url) + '" download="' + esc(f.name || "file") + '" target="_blank" rel="noopener noreferrer"' : "") + ">" + icon("file", "vsrv-file-ic") + '<span class="vsrv-file-txt"><span class="vsrv-file-name">' + esc(f.name || tr("File")) + '</span><span class="vsrv-file-size">' + esc(bytes(f.size)) + "</span></span></a>");
      }
    });
    return (media.length ? '<div class="vsrv-media n' + Math.min(media.length, 4) + '">' + media.join("") + "</div>" : "") + others.join("");
  }
  function linkCard(m) {
    if (!m.b || m.pending) return "";
    var url = firstLink(m.b);
    if (!url) return "";
    var meta = preview(url);
    if (!meta) return "";
    var href = httpUrl(meta.url) || url;
    var img = meta.image && httpUrl(meta.image) ? '<img class="vsrv-card-img" src="' + esc(meta.image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : "";
    var site = meta.site || (function () { try { return new URL(href).hostname.replace(/^www\./, ""); } catch (err) { return ""; } })();
    return '<a class="vsrv-card" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + img + '<span class="vsrv-card-txt">' +
      (site ? '<span class="vsrv-card-site">' + esc(site) + "</span>" : "") +
      (meta.title ? '<span class="vsrv-card-title">' + esc(String(meta.title).slice(0, 200)) + "</span>" : "") +
      (meta.description ? '<span class="vsrv-card-desc">' + esc(String(meta.description).slice(0, 300)) + "</span>" : "") + "</span></a>";
  }

  function typingInner() {
    var bag = S.typing[S.cid] || {};
    var now = Date.now();
    var who = Object.keys(bag).filter(function (mid) { return bag[mid] > now && mid !== me().mid; });
    if (!who.length) return "";
    var names = who.slice(0, 3).map(function (mid) { return "<strong>" + esc(nameOf(mid)) + "</strong>"; });
    var text = who.length === 1 ? tr("{a} is typing…", { a: names[0] }) : who.length === 2 ? tr("{a} and {b} are typing…", { a: names[0], b: names[1] }) : who.length === 3 ? tr("{a}, {b} and {c} are typing…", { a: names[0], b: names[1], c: names[2] }) : tr("Several people are typing…");
    return '<span class="vsrv-dots"><i></i><i></i><i></i></span><span>' + text + "</span>";
  }

  function composeInner() {
    var c = channel(S.cid);
    if (!c) return "";
    var perms = Number(c.perms) || 0;
    if (timedOut()) return '<div class="vsrv-compose-off">' + icon("clock") + "<span>" + esc(tr("You're timed out until {time}.", { time: fullTime(me().timeoutUntil) })) + "</span></div>";
    if (c.kind === "forum") return "";
    if (c.kind === "thread" && c.thread.locked && !has(perms, P.SEND)) return '<div class="vsrv-compose-off">' + icon("lock") + "<span>" + esc(tr("This thread is locked. Only moderators can reply.")) + "</span></div>";
    if (!has(perms, P.SEND)) return '<div class="vsrv-compose-off">' + icon("lock") + "<span>" + esc(c.kind === "announcement" ? tr("Only some members can post in this announcement channel.") : tr("You don't have permission to send messages in this channel.")) + "</span></div>";
    var reply = "";
    if (S.reply && S.reply.c === S.cid) {
      reply = '<div class="vsrv-replybar"><span>' + tr("Replying to {name}", { name: "<strong>" + esc(nameOf(S.reply.a)) + "</strong>" }) + '</span><button type="button" class="vsrv-ping' + (S.reply.ping === false ? "" : " on") + '" data-vs="reply-ping" aria-pressed="' + (S.reply.ping === false ? "false" : "true") + '">@ ' + esc(S.reply.ping === false ? tr("Off") : tr("On")) + '</button><button type="button" class="vsrv-iconbtn sm" data-vs="reply-cancel" aria-label="' + esc(tr("Cancel reply")) + '">' + icon("close") + "</button></div>";
    }
    var files = S.files.filter(function (f) { return f.c === S.cid; });
    var tray = files.length ? '<div class="vsrv-tray">' + files.map(function (f) {
      var thumb = f.local && /^image\//.test(f.t) ? '<img src="' + esc(f.local) + '" alt="">' : icon("file");
      return '<div class="vsrv-tray-item' + (f.err ? " err" : f.k ? "" : " busy") + '">' + thumb + '<span class="vsrv-tray-name">' + esc(f.n) + "</span>" +
        (f.k || f.err ? "" : '<span class="vsrv-tray-bar"><i style="width:' + Math.round((f.p || 0) * 100) + '%"></i></span>') +
        '<button type="button" class="vsrv-tray-x" data-vs="file-x" data-id="' + esc(f.id) + '" aria-label="' + esc(tr("Remove")) + '">' + icon("close") + "</button></div>";
    }).join("") + "</div>" : "";
    var slow = c.slowmode && !has(perms, P.MANAGE_MESSAGES) && !has(perms, P.MANAGE_CHANNELS) ? '<span class="vsrv-slow" title="' + esc(tr("Slow mode is on")) + '">' + icon("clock") + esc(slowLabel(c.slowmode)) + "</span>" : "";
    var arch = c.kind === "thread" && c.thread.archived ? '<div class="vsrv-replybar">' + icon("archive") + "<span>" + esc(tr("This thread is archived. Sending a message reopens it.")) + "</span></div>" : "";
    return arch + reply + tray + '<div class="vsrv-compose">' +
      (has(perms, P.ATTACH) ? '<label class="vsrv-iconbtn vsrv-attach" aria-label="' + esc(tr("Attach files")) + '" title="' + esc(tr("Attach files")) + '">' + icon("clip") + '<input type="file" multiple data-vs="files" hidden></label>' : "") +
      '<button type="button" class="vsrv-iconbtn" data-vs="compose-apps" aria-label="' + esc(tr("More options")) + '" title="' + esc(tr("More options")) + '">' + icon("apps") + "</button>" +
      '<textarea id="vsrv-input" class="vsrv-input" rows="1" maxlength="4000" placeholder="' + esc(c.kind === "thread" ? tr("Message {name}", { name: c.name }) : tr("Message #{name}", { name: c.name })) + '" enterkeyhint="send" autocomplete="off">' + esc(S.drafts[S.cid] || "") + "</textarea>" +
      '<button type="button" class="vsrv-iconbtn" data-vs="emoji-pick" aria-label="' + esc(tr("Emoji")) + '" title="' + esc(tr("Emoji")) + '">' + icon("smile") + "</button>" + slow +
      '<button type="button" class="vsrv-send" data-vs="send" aria-label="' + esc(tr("Send")) + '">' + icon("send") + "</button>" +
      '</div><div class="vsrv-pop" id="vsrv-pop" hidden></div>';
  }
  function slowLabel(sec) {
    if (!sec) return tr("Off");
    if (sec < 60) return tr("{n}s", { n: sec });
    if (sec < 3600) return tr("{n}m", { n: Math.round(sec / 60) });
    return tr("{n}h", { n: Math.round(sec / 3600) });
  }

  /* ---------- members ---------- */
  function membersInner() {
    var list = S.members[S.sid];
    if (!list) return '<div class="vsrv-side-skel" aria-busy="true"><span></span><span></span><span></span></div>';
    var online = S.online[S.sid] || {};
    var groups = {};
    var order = [];
    var hoisted = sortedRoles().filter(function (r) { return r.hoist && r.id !== S.sid; });
    hoisted.forEach(function (r) { groups[r.id] = []; order.push({ id: r.id, name: r.name }); });
    groups.on = []; groups.off = [];
    list.forEach(function (m) {
      var on = !!online[m.m] || m.m === me().mid;
      if (!on) { groups.off.push(m); return; }
      var best = null;
      hoisted.forEach(function (r) { if (!best && (m.roles || []).indexOf(r.id) >= 0) best = r; });
      (best ? groups[best.id] : groups.on).push(m);
    });
    order.push({ id: "on", name: tr("Online") }, { id: "off", name: tr("Offline") });
    return order.map(function (g) {
      var items = groups[g.id] || [];
      if (!items.length) return "";
      items.sort(function (a, b) { return nameOf(a.m).localeCompare(nameOf(b.m)); });
      return '<div class="vsrv-mgroup"><h3>' + esc(g.name) + " — " + items.length + "</h3>" + items.map(function (m) {
        var col = memberColor(m.m);
        var c = cardOf(m.m);
        return '<button type="button" class="vsrv-mrow' + (g.id === "off" ? " off" : "") + '" data-vs="member" data-m="' + m.m + '"><span class="vsrv-mrow-ava">' + avatar(m.m, S.sid, "vsrv-ava sm") + (g.id !== "off" ? '<span class="vsrv-on"></span>' : "") + "</span>" +
          '<span class="vsrv-mrow-txt"><span class="vsrv-mrow-name"' + (col ? ' style="color:' + col + '"' : "") + ">" + esc(nameOf(m.m)) + "</span>" + (g.id !== "off" && actOf(m.m, m) ? '<span class="vsrv-mrow-act">' + esc(actText(actOf(m.m, m))) + "</span>" : "") + "</span>" +
          (m.owner ? '<span class="vsrv-crown" title="' + esc(tr("Server owner")) + '">' + icon("shield") + "</span>" : "") +
          (m.timeoutUntil && m.timeoutUntil > Date.now() ? '<span class="vsrv-crown warn" title="' + esc(tr("Timed out")) + '">' + icon("clock") + "</span>" : "") +
          "</button>";
      }).join("") + "</div>";
    }).join("") + (S.membersNext ? '<div class="vsrv-older"><button type="button" class="vsrv-linkbtn" data-vs="more-members">' + esc(tr("Show more")) + "</button></div>" : "");
  }
  var memberLoads = {};
  function loadMembers(sid, after) {
    var key = sid + ":" + (after || "");
    if (memberLoads[key]) return memberLoads[key];
    memberLoads[key] = call("/" + sid + "/members?limit=200" + (after ? "&after=" + encodeURIComponent(after) : "")).then(function (res) {
      delete memberLoads[key];
      if (res.status !== 200) return;
      var list = res.body.members || [];
      var bag = S.cards[sid] || (S.cards[sid] = lsGet("cards:" + sid, {}));
      var on = S.online[sid] || (S.online[sid] = {});
      list.forEach(function (m) {
        if (m.card) { bag[m.m] = Object.assign({}, m.card, { nick: m.nick, roles: m.roles, owner: m.owner, member: true, at: Date.now() }); }
        if (m.online) on[m.m] = 1;
      });
      S.members[sid] = (after ? (S.members[sid] || []) : []).concat(list);
      if (sid === S.sid) S.membersNext = res.body.next || "";
      lsSet("cards:" + sid, bag);
      if (sid === S.sid) { paintMembers(); paintLog(true); }
    });
    return memberLoads[key];
  }

  /* ---------- painting ---------- */
  function el(id) { return document.getElementById(id); }
  function rootEl() { return el("vsrv-root"); }
  function paintInbox() {
    var box = el("vsrv-inbox");
    if (!box) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = inboxHtml();
    var next = tmp.firstChild;
    if (next) box.replaceWith(next); else box.remove();
  }
  function paintRail() { var r = el("vsrv-rail"); if (r) r.innerHTML = railInner(); }
  function paintSide() {
    var s = el("vsrv-side");
    if (!s) return;
    var list = s.querySelector(".vsrv-chlist");
    var top = list ? list.scrollTop : 0;
    s.innerHTML = sideInner();
    list = s.querySelector(".vsrv-chlist");
    if (list) list.scrollTop = top;
  }
  function paintMembers() { var m = el("vsrv-members"); if (m && S.mode === "server") m.innerHTML = membersInner(); }
  function paintTyping() { var t = el("vsrv-typing"); if (t) t.innerHTML = typingInner(); }
  function atBottom(log) { return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 90; }
  var logScrolling = false;
  function paintLog(stick, mode) {
    if (el("vsrv-forum")) { paintForum(); return; }
    var log = el("vsrv-log");
    if (!log || S.edit) { if (log && S.edit) paintLater(); return; }
    var wasBottom = atBottom(log);
    var fromBottom = log.scrollHeight - log.scrollTop;
    log.innerHTML = logInner();
    if (mode === "keep") log.scrollTop = log.scrollHeight - fromBottom;
    else if (S.jumpTo) { scrollToMessage(S.jumpTo); }
    else if (stick === true ? wasBottom || S.forceBottom : wasBottom) { log.scrollTop = log.scrollHeight; }
    S.forceBottom = false;
    if (atBottom(log)) readLatest();
  }
  var laterTimer = 0;
  function paintLater() {
    clearTimeout(laterTimer);
    laterTimer = setTimeout(function () { if (!S.edit) paintLog(true); }, 600);
  }
  function paintCompose(focus) {
    var box = el("vsrv-compose");
    if (!box) return;
    var input = el("vsrv-input");
    var had = focus || (input && document.activeElement === input);
    var caret = input ? input.selectionStart : null;
    box.innerHTML = composeInner();
    input = el("vsrv-input");
    if (input) {
      autosize(input);
      if (had) { try { input.focus({ preventScroll: true }); if (caret != null) input.setSelectionRange(caret, caret); } catch (err) { /* old Safari */ } }
    }
  }
  function paintConv() {
    var conv = el("vsrv-conv");
    if (!conv) return;
    conv.innerHTML = convInner();
    var log = el("vsrv-log");
    if (log) { log.scrollTop = log.scrollHeight; bindLog(log); }
    var input = el("vsrv-input");
    if (input) autosize(input);
  }
  function paintAll() {
    paintInbox();
    if (S.mode !== "server" || !rootEl()) return;
    paintRail();
    paintSide();
    var conv = el("vsrv-conv");
    if (conv && S.cid && (!conv.querySelector(".vsrv-conv-head") || conv.getAttribute("data-c") !== S.cid)) { conv.setAttribute("data-c", S.cid); paintConv(); }
    else if (conv && !S.cid) paintConv();
    else {
      var head = conv && conv.querySelector(".vsrv-conv-head");
      if (head) { var tmp = document.createElement("div"); tmp.innerHTML = convInner(); var nh = tmp.querySelector(".vsrv-conv-head"); if (nh) head.replaceWith(nh); }
      paintLog();
      if (!el("vsrv-input") || !el("vsrv-input").value) paintCompose();
    }
    paintMembers();
  }
  function scrollToMessage(id) {
    var log = el("vsrv-log");
    var node = log && log.querySelector('[data-id="' + cssEsc(id) + '"]');
    if (!node) return false;
    S.jumpTo = "";
    S.flash = id;
    node.classList.add("flash");
    try { node.scrollIntoView({ block: "center" }); } catch (err) { node.scrollIntoView(); }
    setTimeout(function () { if (S.flash === id) S.flash = ""; var n = log.querySelector('[data-id="' + cssEsc(id) + '"]'); if (n) n.classList.remove("flash"); }, 2200);
    return true;
  }
  function cssEsc(v) { return String(v).replace(/["\\]/g, "\\$&"); }
  function readLatest() {
    if (document.visibilityState === "hidden" || !S.cid) return;
    var list = (S.msgs[S.cid] || []).filter(function (m) { return !m.pending; });
    if (list.length) markReadSoon(S.sid, S.cid, list[list.length - 1].id);
  }
  function bindLog(log) {
    if (log.__vs) return;
    log.__vs = 1;
    log.addEventListener("scroll", function () {
      if (logScrolling) return;
      if (log.scrollTop < 240 && S.more[S.cid]) {
        var list = (S.msgs[S.cid] || []).filter(function (m) { return !m.pending; });
        if (list.length) { logScrolling = true; loadMessages(S.sid, S.cid, { before: list[0].id }).then(function () { logScrolling = false; }); }
      }
      if (atBottom(log)) readLatest();
    }, { passive: true });
  }
  function autosize(input) {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }

  /* ---------- realtime ---------- */
  function wantSocket() { return S.mode === "server" && S.sid && signedIn() && document.visibilityState !== "hidden" && !!rootEl(); }
  function closeSocket() {
    S.socketWant = false;
    clearTimeout(S.retryTimer);
    if (S.socket) { try { S.socket.close(1000, "leave"); } catch (err) { /* already closed */ } }
    S.socket = null;
    S.socketSid = "";
  }
  function connect() {
    if (!wantSocket()) return;
    var sid = S.sid;
    if (S.socket && S.socketSid === sid && (S.socket.readyState === 0 || S.socket.readyState === 1)) return;
    if (S.socket) closeSocket();
    S.socketWant = true;
    S.socketSid = sid;
    call("/" + sid + "/ticket", { method: "POST", body: {} }).then(function (res) {
      if (!S.socketWant || S.socketSid !== sid || !wantSocket()) return;
      if (res.status !== 200 || !res.body.ticket) { if (res.status === 403) loadServer(sid, true); else retry(); return; }
      var url = api().replace(/^http/i, "ws") + "/v1/servers/ws?s=" + sid + "&ticket=" + encodeURIComponent(res.body.ticket);
      var ws;
      try { ws = new WebSocket(url); } catch (err) { retry(); return; }
      S.socket = ws;
      ws.onopen = function () { S.retry = 0; S.sentAct = "-"; if (S.cid) ws.send(JSON.stringify({ op: "view", c: viewId(S.cid) })); pushActivity(); };
      ws.onmessage = function (ev) { onSocket(sid, ev.data); };
      ws.onclose = function (ev) {
        if (S.socket !== ws) return;
        S.socket = null;
        if (ev.code === 4003) { loadServer(sid, true); return; }
        if (S.socketWant && S.socketSid === sid) retry();
      };
      ws.onerror = function () { /* onclose follows */ };
    });
  }
  function retry() {
    clearTimeout(S.retryTimer);
    if (!wantSocket()) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    S.retry = Math.min(S.retry + 1, 6);
    var wait = Math.min(30000, 800 * Math.pow(2, S.retry - 1)) * (0.7 + Math.random() * 0.6);
    S.retryTimer = setTimeout(connect, wait);
  }
  function onSocket(sid, raw) {
    if (raw === "pong") return;
    var msg;
    try { msg = JSON.parse(String(raw)); } catch (err) { return; }
    if (!msg || sid !== S.sid) return;
    if (msg.op === "ready") {
      var on = {};
      (msg.online || []).forEach(function (m) { on[m] = 1; });
      S.online[sid] = on;
      S.acts[sid] = msg.acts || {};
      S.voice[sid] = msg.voice || {};
      paintMembers();
      paintVoice();
      catchUp();
      flushOutbox();
      return;
    }
    if (msg.op === "voice") {
      var vb = S.voice[sid] || (S.voice[sid] = {});
      if (msg.c) vb[msg.a] = { c: msg.c, st: msg.st || {}, j: msg.j || 0 }; else delete vb[msg.a];
      paintVoice();
      return;
    }
    if (msg.op === "online") {
      var bag = S.online[sid] || (S.online[sid] = {});
      if (msg.on) bag[msg.a] = 1; else delete bag[msg.a];
      paintMembers();
      return;
    }
    if (msg.op === "activity") {
      var acts = S.acts[sid] || (S.acts[sid] = {});
      if (msg.act) acts[msg.a] = msg.act; else delete acts[msg.a];
      paintMembers();
      if (msg.a === me(sid).mid) paintSide();
      return;
    }
    if (msg.op === "typing") {
      var tb = S.typing[msg.c] || (S.typing[msg.c] = {});
      tb[msg.a] = Date.now() + 8000;
      needCards([msg.a]);
      if (msg.c === S.cid) { paintTyping(); setTimeout(paintTyping, 8100); }
      return;
    }
    if (msg.op === "resync") {
      Promise.all([loadServer(sid, true), loadList(true)]).then(function () {
        if (S.sid !== sid) return;
        if (S.socket) { var old = S.socket; S.socket = null; try { old.close(1000, "resync"); } catch (err) { /* closed */ } }
        connect();
        if (S.cid && !channel(S.cid)) paintAll();
      });
      return;
    }
    if (msg.op === "event" && msg.e) applyEvent(sid, msg.c, msg.e);
  }
  function applyEvent(sid, cid, e) {
    if (e.ch) cid = e.ch;
    if (applyP2(sid, cid, e)) return;
    var list = S.msgs[cid];
    var c = channel(cid, sid);
    if (e.t === "msg" && e.m) {
      var m = e.m;
      if (S.typing[cid]) delete S.typing[cid][m.a];
      var existed = list && list.some(function (x) { return x.id === m.id; });
      if (list || cid === S.cid) mergeMessages(cid, [m], false);
      if (c && !existed) {
        c.lastId = maxId(c.lastId, m.id);
        var entry = listEntry(sid);
        if (entry) { entry.lastId = maxId(entry.lastId, m.id); entry.channels.forEach(function (x) { if (x.id === cid) x.lastId = c.lastId; }); }
        var mine = m.a === me(sid).mid;
        if (mine) c.lastRead = maxId(c.lastRead, m.id);
        var mentioned = !mine && m.mn && (m.mn.e || (m.mn.u || []).indexOf(me(sid).mid) >= 0 || (m.mn.r || []).some(function (r) { return (me(sid).roles || []).indexOf(r) >= 0; }));
        var viewing = cid === S.cid && document.visibilityState !== "hidden" && atBottom(el("vsrv-log"));
        if (mentioned && !viewing && effectiveLevel(cid, sid) !== "none") c.mentions = (Number(c.mentions) || 0) + 1;
      }
      if (cid === S.cid) { paintLog(true); paintTyping(); }
      paintSide(); paintRail(); paintInbox();
      return;
    }
    if (!list) return;
    var target = e.id ? list.find(function (x) { return x.id === e.id; }) : null;
    if (e.t === "del") {
      S.msgs[cid] = list.filter(function (x) { return x.id !== e.id; });
      list.forEach(function (x) { if (x.r && x.r.id === e.id) x.r = { id: e.id, gone: 1 }; });
      saveChannel(cid);
    } else if (e.t === "rx" && target) {
      var rx = target.rx || (target.rx = []);
      var item = rx.find(function (r) { return r.e === e.e; });
      if (!item) { item = { e: e.e, n: 0, me: false }; rx.push(item); }
      item.n = Number(e.n) || 0;
      if (e.m === me(sid).mid) item.me = !!e.on;
      target.rx = rx.filter(function (r) { return r.n > 0; });
      saveChannel(cid);
    } else if (e.t === "pin" && target) {
      target.p = e.p ? 1 : 0;
      saveChannel(cid);
    } else if (e.t === "member") {
      var bag = S.cards[sid];
      if (bag && e.m) delete bag[e.m];
      if (e.m) needCards([e.m], sid);
      if (e.m === me(sid).mid) loadServer(sid, true);
      if (S.members[sid]) loadMembers(sid);
      return;
    } else return;
    if (cid === S.cid) paintLog();
  }
  function onAccountChannel(msg) {
    if (!msg || msg.topic !== "srv") return;
    var d = msg.data || {};
    if (!/^[a-f0-9]{16}$/.test(String(d.s || ""))) return;
    var live = S.socket && S.socket.readyState === 1 && S.socketSid === d.s;
    if (live) return;
    var entry = listEntry(d.s);
    if (entry) {
      entry.lastId = maxId(entry.lastId, d.id);
      entry.channels.forEach(function (c) { if (c.id === d.c) { c.lastId = maxId(c.lastId, d.id); if (d.mention) c.mentions = (Number(c.mentions) || 0) + 1; } });
    }
    var st = srv(d.s);
    if (st && st.channels) st.channels.forEach(function (c) { if (c.id === d.c) { c.lastId = maxId(c.lastId, d.id); if (d.mention) c.mentions = (Number(c.mentions) || 0) + 1; } });
    if (d.s === S.sid && d.c === S.cid) catchUp();
    paintInbox(); paintRail(); paintSide();
    if (!entry) loadList(true);
  }
  function sendTyping() {
    if (!S.socket || S.socket.readyState !== 1 || !S.cid) return;
    var now = Date.now();
    if (now - S.lastTyping < 3000) return;
    S.lastTyping = now;
    var th = S.threads[S.cid];
    try { S.socket.send(JSON.stringify(th ? { op: "typing", c: S.cid, p: th.parentId } : { op: "typing", c: S.cid })); } catch (err) { /* closed */ }
  }

  /* ---------- sheets ---------- */
  var sheetStack = [];
  function openSheet(html, cls, onMount) {
    var bg = document.createElement("div");
    bg.className = "vsrv-sheet-bg";
    bg.innerHTML = '<div class="vsrv-sheet ' + (cls || "") + '" role="dialog" aria-modal="true">' + html + "</div>";
    bg.addEventListener("click", function (ev) { if (ev.target === bg) closeSheet(); });
    document.body.appendChild(bg);
    sheetStack.push(bg);
    document.documentElement.classList.add("vsrv-locked");
    var sheet = bg.firstChild;
    if (onMount) onMount(sheet);
    var focus = sheet.querySelector("[autofocus]");
    if (focus && !coarse()) { try { focus.focus(); } catch (err) { /* hidden */ } }
    return sheet;
  }
  function closeSheet(all) {
    do {
      var bg = sheetStack.pop();
      if (bg) bg.remove();
    } while (all && sheetStack.length);
    if (!sheetStack.length) document.documentElement.classList.remove("vsrv-locked");
  }
  function topSheet() { var bg = sheetStack[sheetStack.length - 1]; return bg ? bg.firstChild : null; }
  function sheetHead(title, sub) {
    return '<header class="vsrv-sheet-head"><div><h2>' + esc(title) + "</h2>" + (sub ? "<p>" + esc(sub) + "</p>" : "") + '</div><button type="button" class="vsrv-iconbtn" data-vs="close-sheet" aria-label="' + esc(tr("Close")) + '">' + icon("close") + "</button></header>";
  }
  function coarse() { try { return root.matchMedia("(pointer: coarse)").matches; } catch (err) { return false; } }
  function narrow() { try { return root.matchMedia("(max-width: 699px)").matches; } catch (err) { return false; } }
  function confirmSheet(title, text, okLabel, danger, withReason) {
    return new Promise(function (resolve) {
      var done = false;
      var sheet = openSheet(sheetHead(title) + '<div class="vsrv-sheet-body">' + (text ? "<p>" + esc(text) + "</p>" : "") +
        (withReason ? '<label class="vsrv-field"><span>' + esc(tr("Reason (optional)")) + '</span><input type="text" maxlength="300" data-k="reason" autofocus></label>' : "") +
        '</div><footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-k="no">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn' + (danger ? " danger" : "") + '" data-k="yes">' + esc(okLabel) + "</button></footer>", "small");
      sheet.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-k]");
        if (!b || done) return;
        if (b.getAttribute("data-k") === "yes") { done = true; var r = sheet.querySelector('[data-k="reason"]'); closeSheet(); resolve({ reason: r ? r.value.trim() : "" }); }
        if (b.getAttribute("data-k") === "no") { done = true; closeSheet(); resolve(null); }
      });
      sheet.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target.tagName === "INPUT") { var y = sheet.querySelector('[data-k="yes"]'); if (y) y.click(); } });
    });
  }
  function promptSheet(title, label, value, okLabel, max) {
    return new Promise(function (resolve) {
      var sheet = openSheet(sheetHead(title) + '<div class="vsrv-sheet-body"><label class="vsrv-field"><span>' + esc(label) + '</span><input type="text" maxlength="' + (max || 100) + '" data-k="v" value="' + esc(value || "") + '" autofocus></label></div>' +
        '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-k="no">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="yes">' + esc(okLabel || tr("Save")) + "</button></footer>", "small");
      function finish(v) { closeSheet(); resolve(v); }
      sheet.addEventListener("click", function (ev) {
        var b = ev.target.closest("[data-k]");
        if (!b) return;
        if (b.getAttribute("data-k") === "yes") finish(sheet.querySelector('[data-k="v"]').value.trim());
        if (b.getAttribute("data-k") === "no") finish(null);
      });
      sheet.addEventListener("keydown", function (ev) { if (ev.key === "Enter") finish(sheet.querySelector('[data-k="v"]').value.trim()); });
    });
  }
  function busy(btn, on) { if (btn) { btn.disabled = !!on; btn.classList.toggle("busy", !!on); } }

  function createSheet() {
    if (!S.canCreate) { toast(tr("Only the app owner can create servers for now.")); return; }
    var sheet = openSheet(sheetHead(tr("Create a server"), tr("Your server is where you and your friends hang out. Make it yours.")) +
      '<div class="vsrv-sheet-body"><label class="vsrv-upload-pick"><input type="file" accept="image/*" data-k="icon" hidden><span class="vsrv-sicon vsrv-initials big" data-k="preview">' + icon("plus") + "</span><span>" + esc(tr("Upload an icon")) + "</span></label>" +
      '<label class="vsrv-field"><span>' + esc(tr("Server name")) + '</span><input type="text" maxlength="100" data-k="name" autofocus></label>' +
      '<p class="vsrv-note">' + esc(tr("Only people you invite can join. You can change everything later.")) + "</p></div>" +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="go">' + esc(tr("Create")) + "</button></footer>", "small");
    var iconFile = null;
    sheet.querySelector('[data-k="icon"]').addEventListener("change", function (ev) {
      iconFile = ev.target.files && ev.target.files[0];
      if (iconFile) sheet.querySelector('[data-k="preview"]').outerHTML = '<img class="vsrv-sicon big" data-k="preview" src="' + esc(URL.createObjectURL(iconFile)) + '" alt="">';
    });
    var go = sheet.querySelector('[data-k="go"]');
    function submit() {
      var name = sheet.querySelector('[data-k="name"]').value.trim();
      if (!name) { sheet.querySelector('[data-k="name"]').focus(); return; }
      busy(go, true);
      call("", { method: "POST", body: { name: name, categoryName: tr("Text channels"), voiceCategoryName: tr("Voice channels"), voiceName: tr("General") } }).then(function (res) {
        if (res.status !== 200) { busy(go, false); toast(errText(res)); return; }
        var sid = res.body.server ? res.body.server.id : res.body.serverId || res.body.id;
        var cid = res.body.channelId || "";
        var after = iconFile ? uploadRaw(sid, "icon", iconFile) : Promise.resolve();
        after.then(function () {
          closeSheet(true);
          return loadList(true);
        }).then(function () { location.hash = "#/messages/s/" + sid + (cid ? "/" + cid : ""); });
      });
    }
    go.addEventListener("click", submit);
    sheet.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target.tagName === "INPUT") submit(); });
  }
  function joinSheet() {
    var sheet = openSheet(sheetHead(tr("Join a server"), tr("Enter an invite below to join an existing server.")) +
      '<div class="vsrv-sheet-body"><label class="vsrv-field"><span>' + esc(tr("Invite link")) + '</span><input type="text" data-k="code" placeholder="' + esc(location.origin + location.pathname + "#/messages/join/hTKzmak") + '" autofocus></label></div>' +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="go">' + esc(tr("Join server")) + "</button></footer>", "small");
    function go() {
      var raw = sheet.querySelector('[data-k="code"]').value.trim();
      var m = /(?:join\/)?([A-Za-z0-9]{4,16})\/?$/.exec(raw);
      if (!m) { toast(tr("This invite is invalid or has expired.")); return; }
      closeSheet(true);
      location.hash = "#/messages/join/" + m[1];
    }
    sheet.querySelector('[data-k="go"]').addEventListener("click", go);
    sheet.addEventListener("keydown", function (ev) { if (ev.key === "Enter") go(); });
  }
  function inviteLink(code) { return location.origin + location.pathname + "#/messages/join/" + code; }
  function inviteSheet() {
    var info = serverInfo(S.sid) || {};
    var sheet = openSheet(sheetHead(tr("Invite friends to {name}", { name: info.name || "" })) +
      '<div class="vsrv-sheet-body"><div class="vsrv-row2"><label class="vsrv-field"><span>' + esc(tr("Expire after")) + '</span><select data-k="exp">' +
      EXPIRY().map(function (e) { return '<option value="' + e[0] + '"' + (e[0] === 604800 ? " selected" : "") + ">" + esc(e[1]) + "</option>"; }).join("") + "</select></label>" +
      '<label class="vsrv-field"><span>' + esc(tr("Max number of uses")) + '</span><select data-k="uses">' +
      USES.map(function (u) { return '<option value="' + u + '">' + esc(u ? trn(u, "srvUses") : tr("No limit")) + "</option>"; }).join("") + "</select></label></div>" +
      '<div class="vsrv-invite-out" data-k="out"></div></div>' +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn" data-k="make">' + esc(tr("Generate a new link")) + "</button></footer>", "small");
    var out = sheet.querySelector('[data-k="out"]');
    function make() {
      var btn = sheet.querySelector('[data-k="make"]');
      busy(btn, true);
      call("/" + S.sid + "/invites", { method: "POST", body: { expiresIn: Number(sheet.querySelector('[data-k="exp"]').value), maxUses: Number(sheet.querySelector('[data-k="uses"]').value) } }).then(function (res) {
        busy(btn, false);
        if (res.status !== 200 || !res.body.invite) { toast(errText(res)); return; }
        var inv = res.body.invite;
        var link = inviteLink(inv.code);
        out.innerHTML = '<div class="vsrv-copyrow"><input type="text" readonly value="' + esc(link) + '"><button type="button" class="vsrv-btn" data-k="copy">' + esc(tr("Copy")) + "</button>" +
          (navigator.share ? '<button type="button" class="vsrv-btn ghost" data-k="share">' + esc(tr("Share")) + "</button>" : "") + "</div>" +
          '<p class="vsrv-note">' + esc(inv.expiresAt ? tr("Your invite link expires {time}.", { time: fullTime(inv.expiresAt) }) : tr("Your invite link never expires.")) + (inv.maxUses ? " " + esc(trn(inv.maxUses, "srvWorks")) : "") + "</p>";
        out.querySelector('[data-k="copy"]').addEventListener("click", function () { copy(link); });
        var sh = out.querySelector('[data-k="share"]');
        if (sh) sh.addEventListener("click", function () { navigator.share({ title: info.name || "", url: link }).catch(function () { /* cancelled */ }); });
      });
    }
    sheet.querySelector('[data-k="make"]').addEventListener("click", make);
    make();
  }
  function copy(text) {
    var done = function () { toast(tr("Copied")); };
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); }); return; }
    fallbackCopy(text); done();
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (err) { /* nothing else to try */ }
    ta.remove();
  }

  function notifySheet(scope) {
    var isServer = scope === S.sid;
    var cur = notifyLevel(scope) || (isServer ? "mentions" : "");
    var c = isServer ? null : channel(scope);
    var opts = (isServer ? [] : [["", tr("Use server default")]]).concat([["all", tr("All messages")], ["mentions", tr("Only @mentions")], ["none", tr("Nothing")]]);
    var sheet = openSheet(sheetHead(tr("Notification settings"), isServer ? (serverInfo(S.sid) || {}).name : "#" + (c ? c.name : "")) +
      '<div class="vsrv-sheet-body vsrv-radios">' + opts.map(function (o) {
        return '<label class="vsrv-radio"><input type="radio" name="vsrv-lv" value="' + o[0] + '"' + (o[0] === cur ? " checked" : "") + "><span>" + esc(o[1]) + "</span></label>";
      }).join("") + '<p class="vsrv-note">' + esc(tr("Nothing also hides unread dots. Mentions still show a badge.")) + "</p></div>", "small");
    sheet.addEventListener("change", function (ev) {
      var level = ev.target.value;
      call("/" + S.sid + "/notify", { method: "PUT", body: { scope: scope, level: level } }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        var st = srv();
        if (st) { st.notify = st.notify || {}; if (level) st.notify[scope] = level; else delete st.notify[scope]; lsSet("srv:" + S.sid, st); }
        var e = listEntry(S.sid);
        if (e) { e.notify = e.notify || {}; if (level) e.notify[scope] = level; else delete e.notify[scope]; }
        paintAll();
      });
    });
  }

  function serverMenu() {
    var p = basePerms();
    var m = me();
    var items = [];
    if (has(p, P.CREATE_INVITE) && !timedOut()) items.push(["invite-sheet", "users", tr("Invite people")]);
    if (canManage()) items.push(["settings", "gear", tr("Server settings")]);
    if (has(p, P.MANAGE_CHANNELS)) items.push(["new-channel", "plus", tr("Create channel")]);
    items.push(["notify-sheet", "bell", tr("Notification settings"), S.sid]);
    items.push(["nick", "edit", tr("Edit server profile")]);
    items.push(["modlog", "shield", tr("Moderation log")]);
    if (!m.owner) items.push(["leave", "door", tr("Leave server"), "", "danger"]);
    openSheet(sheetHead((serverInfo(S.sid) || {}).name || "") + '<div class="vsrv-menu">' + items.map(function (it) {
      return '<button type="button" class="vsrv-menu-item' + (it[4] ? " " + it[4] : "") + '" data-vs="' + it[0] + '"' + (it[3] ? ' data-scope="' + it[3] + '"' : "") + ">" + icon(it[1]) + "<span>" + esc(it[2]) + "</span></button>";
    }).join("") + "</div>", "is-menu");
  }

  function msgById(id) { return (S.msgs[S.cid] || []).find(function (m) { return m.id === id; }) || null; }
  function messageMenu(id) {
    var m = msgById(id);
    if (!m) return;
    var perms = chanPerms(S.cid);
    var mine = m.a === me().mid;
    var mod = has(perms, P.MANAGE_MESSAGES);
    var items = [];
    var quick = has(perms, P.REACT) && !timedOut() ? '<div class="vsrv-quick">' + QUICK.map(function (q) { return '<button type="button" data-vs="react" data-id="' + esc(id) + '" data-e="' + esc(q) + '" data-close="1">' + esc(q) + "</button>"; }).join("") + '<button type="button" data-vs="react-pick" data-id="' + esc(id) + '" data-close="1" aria-label="' + esc(tr("Add reaction")) + '">' + icon("smile") + "</button></div>" : "";
    if (has(perms, P.SEND) && !timedOut()) items.push(["reply", "reply", tr("Reply")]);
    if (mine && !m.st && !m.pl) items.push(["edit", "edit", tr("Edit message")]);
    if (canThreadFrom(m)) items.push(["thread-from", "thread", tr("Create thread")]);
    if (m.th) items.push(["open-thread", "thread", tr("Open thread")]);
    if (m.pl && !m.pl.ended && (mine || mod)) items.push(["poll-end", "poll", tr("End poll now")]);
    if (mod) items.push(["pin", "pin", m.p ? tr("Unpin message") : tr("Pin message")]);
    if (m.b) items.push(["copy-text", "copy", tr("Copy text")]);
    items.push(["copy-link", "link", tr("Copy message link")]);
    if (mine) items.push(["delete", "trash", tr("Delete message"), "danger"]);
    else if (mod) items.push(["mod-delete", "trash", tr("Remove message"), "danger"]);
    openSheet('<div class="vsrv-menu">' + quick + items.map(function (it) {
      return '<button type="button" class="vsrv-menu-item' + (it[3] ? " " + it[3] : "") + '" data-vs="' + it[0] + '" data-id="' + esc(id) + '" data-close="1">' + icon(it[1]) + "<span>" + esc(it[2]) + "</span></button>";
    }).join("") + "</div>", "is-menu");
  }

  function emojiPicker(onPick, anchor) {
    var st = srv();
    var custom = st && st.emojis && st.emojis.length ? '<h3>' + esc((serverInfo(S.sid) || {}).name || tr("Server")) + '</h3><div class="vsrv-egrid">' + st.emojis.map(function (e) {
      return '<button type="button" data-pick="c:' + e.id + '" title=":' + esc(e.name) + ':"><img src="' + esc(e.url) + '" alt=":' + esc(e.name) + ':" loading="lazy"></button>';
    }).join("") + "</div>" : "";
    var sheet = openSheet(sheetHead(tr("Emoji")) + '<div class="vsrv-sheet-body vsrv-emojis">' + custom + "<h3>" + esc(tr("Emoji")) + '</h3><div class="vsrv-egrid">' + EMOJI.map(function (e) {
      return '<button type="button" data-pick="' + esc(e) + '">' + esc(e) + "</button>";
    }).join("") + "</div></div>", "emoji");
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-pick]");
      if (!b) return;
      closeSheet();
      onPick(b.getAttribute("data-pick"));
    });
  }

  function memberSheet(mid) {
    needCards([mid]);
    var c = cardOf(mid) || {};
    var meM = me();
    var p = basePerms();
    var self = mid === meM.mid;
    var myTop = topPos();
    var theirTop = (c.roles || []).reduce(function (best, id) { var r = role(id); return r && r.position > best ? r.position : best; }, 0);
    var above = meM.owner || (!c.owner && myTop > theirTop);
    var roles = sortedRoles().filter(function (r) { return r.id !== S.sid; });
    var mine = (c.roles || []);
    var roleChips = roles.filter(function (r) { return mine.indexOf(r.id) >= 0; }).map(function (r) {
      return '<span class="vsrv-chip" style="--rc:' + (color(r.color) || "var(--muted)") + '"><i></i>' + esc(r.name) + "</span>";
    }).join("");
    var canRoles = has(p, P.MANAGE_ROLES) && (above || self && meM.owner);
    var editRoles = canRoles ? '<details class="vsrv-details"><summary>' + esc(tr("Edit roles")) + '</summary><div class="vsrv-checks">' + roles.map(function (r) {
      var allowed = meM.owner || r.position < myTop;
      return '<label class="vsrv-check"><input type="checkbox" data-role="' + r.id + '"' + (mine.indexOf(r.id) >= 0 ? " checked" : "") + (allowed ? "" : " disabled") + '><span style="color:' + (color(r.color) || "inherit") + '">' + esc(r.name) + "</span></label>";
    }).join("") + "</div></details>" : "";
    var acts = [];
    if (S.cid && has(chanPerms(S.cid), P.SEND) && !self) acts.push(["mention", "users", tr("Mention")]);
    if (self && root.ViktorychPresence && root.ViktorychPresence.open) acts.push(["status", "smile", tr("Set a custom status")]);
    if (self || has(p, P.MANAGE_ROLES) && above) acts.push(["nick", "edit", self ? tr("Edit server profile") : tr("Change nickname")]);
    if (!self && above && has(p, P.MODERATE)) acts.push(["timeout", "clock", c.timeoutUntil && c.timeoutUntil > Date.now() ? tr("Remove timeout") : tr("Time out")]);
    if (!self && above && has(p, P.KICK)) acts.push(["kick", "door", tr("Kick"), "danger"]);
    if (!self && above && has(p, P.BAN)) acts.push(["ban", "shield", tr("Ban"), "danger"]);
    var profile = c.handle && !c.profileLess ? '<a class="vsrv-linkbtn" data-close="1" href="#/@' + encodeURIComponent(c.handle) + '">@' + esc(c.handle) + "</a>" : "";
    var sheet = openSheet('<div class="vsrv-profile">' + avatar(mid, S.sid, "vsrv-ava xl") + "<h2>" + esc(nameOf(mid)) + (c.owner ? '<span class="vsrv-crown" title="' + esc(tr("Server owner")) + '">' + icon("shield") + "</span>" : "") + "</h2>" +
      (c.nick && c.name ? '<div class="vsrv-sub">' + esc(c.name) + "</div>" : "") + profile +
      (c.member === false ? '<p class="vsrv-note">' + esc(tr("No longer in this server.")) + "</p>" : "") +
      (actOf(mid) ? '<div class="vsrv-act">' + icon(actIcon(actOf(mid))) + "<span>" + esc(actText(actOf(mid))) + "</span>" + (actOf(mid).d ? "<small>" + esc(actOf(mid).d) + "</small>" : "") + "</div>" : "") +
      (roleChips ? '<div class="vsrv-chips">' + roleChips + "</div>" : "") + editRoles +
      '</div><div class="vsrv-menu">' + acts.map(function (a) {
        return '<button type="button" class="vsrv-menu-item' + (a[3] ? " " + a[3] : "") + '" data-ma="' + a[0] + '">' + icon(a[1]) + "<span>" + esc(a[2]) + "</span></button>";
      }).join("") + "</div>", "is-menu");
    sheet.addEventListener("change", function (ev) {
      var box = ev.target.closest("[data-role]");
      if (!box) return;
      var ids = Array.prototype.map.call(sheet.querySelectorAll("[data-role]:checked"), function (x) { return x.getAttribute("data-role"); });
      call("/" + S.sid + "/members/" + mid, { method: "PATCH", body: { roles: ids } }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); box.checked = !box.checked; return; }
        var bag = S.cards[S.sid] || {};
        if (bag[mid]) bag[mid].roles = ids;
        if (mid === meM.mid) loadServer(S.sid, true);
        paintLog(); paintMembers();
      });
    });
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-ma]");
      if (!b) return;
      var a = b.getAttribute("data-ma");
      if (a === "mention") { closeSheet(true); insertMention(mid); return; }
      if (a === "nick") { closeSheet(true); nickSheet(mid); return; }
      if (a === "status") { closeSheet(true); root.ViktorychPresence.open(); return; }
      if (a === "timeout") { closeSheet(true); timeoutSheet(mid); return; }
      if (a === "kick") {
        confirmSheet(tr("Kick {name}", { name: nameOf(mid) }), tr("They can rejoin with a new invite."), tr("Kick"), true, true).then(function (ok) {
          if (!ok) return;
          call("/" + S.sid + "/members/" + mid + "?reason=" + encodeURIComponent(ok.reason), { method: "DELETE" }).then(function (res) {
            if (res.status !== 200) { toast(errText(res)); return; }
            closeSheet(true); toast(tr("Member kicked")); loadMembers(S.sid);
          });
        });
      }
      if (a === "ban") {
        confirmSheet(tr("Ban {name}", { name: nameOf(mid) }), tr("They're removed and can't rejoin until unbanned."), tr("Ban"), true, true).then(function (ok) {
          if (!ok) return;
          call("/" + S.sid + "/bans", { method: "POST", body: { m: mid, reason: ok.reason } }).then(function (res) {
            if (res.status !== 200) { toast(errText(res)); return; }
            closeSheet(true); toast(tr("Member banned")); loadMembers(S.sid);
          });
        });
      }
    });
  }
  function topPos() {
    var m = me();
    if (m.owner) return 1e9;
    return (m.roles || []).reduce(function (best, id) { var r = role(id); return r && r.position > best ? r.position : best; }, 0);
  }
  function nickSheet(mid) {
    var c = cardOf(mid) || {};
    promptSheet(mid === me().mid ? tr("Edit server profile") : tr("Change nickname"), tr("Nickname"), c.nick || (mid === me().mid ? me().nick : ""), tr("Save"), 32).then(function (v) {
      if (v == null) return;
      call("/" + S.sid + "/members/" + mid, { method: "PATCH", body: { nick: v } }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        var bag = S.cards[S.sid] || {};
        if (bag[mid]) bag[mid].nick = v;
        if (mid === me().mid) { me().nick = v; loadServer(S.sid, true); }
        paintLog(true); paintMembers(); paintSide();
      });
    });
  }
  function timeoutSheet(mid) {
    var c = cardOf(mid) || {};
    if (c.timeoutUntil && c.timeoutUntil > Date.now()) {
      call("/" + S.sid + "/members/" + mid + "/timeout", { method: "POST", body: { seconds: 0 } }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        c.timeoutUntil = 0; toast(tr("Timeout removed")); loadMembers(S.sid);
      });
      return;
    }
    var sheet = openSheet(sheetHead(tr("Time out {name}", { name: nameOf(mid) }), tr("They can read but can't send messages or react until it ends.")) +
      '<div class="vsrv-sheet-body"><div class="vsrv-pills">' + TIMEOUTS().map(function (t, i) { return '<label class="vsrv-pill"><input type="radio" name="vsrv-to" value="' + t[0] + '"' + (i === 0 ? " checked" : "") + "><span>" + esc(t[1]) + "</span></label>"; }).join("") + "</div>" +
      '<label class="vsrv-field"><span>' + esc(tr("Reason (optional)")) + '</span><input type="text" maxlength="300" data-k="reason"></label></div>' +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn danger" data-k="go">' + esc(tr("Time out")) + "</button></footer>", "small");
    sheet.querySelector('[data-k="go"]').addEventListener("click", function () {
      var secs = Number(sheet.querySelector('input[name="vsrv-to"]:checked').value);
      call("/" + S.sid + "/members/" + mid + "/timeout", { method: "POST", body: { seconds: secs, reason: sheet.querySelector('[data-k="reason"]').value.trim() } }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        closeSheet(true); toast(tr("Member timed out")); loadMembers(S.sid);
      });
    });
  }

  function pinsSheet() {
    var sheet = openSheet(sheetHead(tr("Pinned messages"), "#" + ((channel(S.cid) || {}).name || "")) + '<div class="vsrv-sheet-body vsrv-results" data-k="list"><div class="dmsgs-skel"><span></span><span></span></div></div>', "tall");
    call("/" + S.sid + "/channels/" + S.cid + "/pins").then(function (res) {
      var box = sheet.querySelector('[data-k="list"]');
      if (res.status !== 200) { box.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
      var list = res.body.messages || res.body.pins || [];
      needCards(list.map(function (m) { return m.a; }));
      box.innerHTML = list.length ? list.map(function (m) { return resultHtml(m, S.cid); }).join("") : '<div class="vsrv-empty"><h2>' + esc(tr("No pins yet")) + "</h2><p>" + esc(tr("Pinned messages show up here.")) + "</p></div>";
    });
  }
  function resultHtml(m, cid) {
    var c = channel(cid || m.c);
    var t = m.t || msgTime(m.id);
    return '<button type="button" class="vsrv-result" data-vs="jump" data-id="' + esc(m.id) + '" data-c="' + esc(m.c || cid) + '" data-close="1">' + avatar(m.a, S.sid, "vsrv-ava sm") +
      '<span class="vsrv-result-main"><span class="vsrv-head"><span class="vsrv-name">' + esc(nameOf(m.a)) + "</span>" + (c ? '<span class="vsrv-result-ch">' + (c.kind === "thread" ? "" : "#") + esc(c.name) + "</span>" : "") + "<time>" + esc(fullTime(t)) + "</time></span>" +
      '<span class="vsrv-result-text">' + esc(m.x ? tr("Removed by a moderator") : plain(m.b).slice(0, 300) || (m.at && m.at.length ? tr("Attachment") : "")) + "</span></span></button>";
  }
  function searchSheet() {
    var sheet = openSheet(sheetHead(tr("Search")) + '<div class="vsrv-sheet-body"><div class="vsrv-searchbar">' + icon("search") + '<input type="search" data-k="q" placeholder="' + esc(tr("Search messages")) + '" autofocus enterkeyhint="search"></div>' +
      '<div class="vsrv-pills"><label class="vsrv-pill"><input type="radio" name="vsrv-sc" value="c" checked><span>' + esc(tr("This channel")) + '</span></label><label class="vsrv-pill"><input type="radio" name="vsrv-sc" value="s"><span>' + esc(tr("Whole server")) + "</span></label></div>" +
      '<div class="vsrv-results" data-k="list"></div></div>', "tall");
    var q = sheet.querySelector('[data-k="q"]');
    var box = sheet.querySelector('[data-k="list"]');
    var seq = 0;
    var timer = 0;
    function run() {
      var text = q.value.trim();
      if (text.length < 2) { box.innerHTML = ""; return; }
      var scope = sheet.querySelector('input[name="vsrv-sc"]:checked').value;
      var mine = ++seq;
      box.innerHTML = '<div class="dmsgs-skel"><span></span><span></span></div>';
      call("/" + S.sid + "/search?q=" + encodeURIComponent(text) + (scope === "c" && S.cid ? "&c=" + viewId(S.cid) : "")).then(function (res) {
        if (mine !== seq) return;
        if (res.status !== 200) { box.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
        var list = res.body.messages || res.body.results || [];
        var hits = res.body.threads || {};
        Object.keys(hits).forEach(function (k) { storeThread(S.sid, hits[k]); });
        needCards(list.map(function (m) { return m.a; }));
        box.innerHTML = list.length ? '<p class="vsrv-note">' + esc(trn(list.length, "srvResults")) + "</p>" + list.map(function (m) { return resultHtml(m, m.c); }).join("") : '<div class="vsrv-empty"><p>' + esc(tr("No results")) + "</p></div>";
      });
    }
    q.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(run, 350); });
    q.addEventListener("keydown", function (ev) { if (ev.key === "Enter") { clearTimeout(timer); run(); } });
    sheet.addEventListener("change", function (ev) { if (ev.target.name === "vsrv-sc") run(); });
  }

  function MODLOG() {
    return {
    server_create: tr("created the server"), server_update: tr("updated the server"), server_icon: tr("changed the server icon"), server_banner: tr("changed the server banner"),
    emoji_add: tr("added an emoji"), emoji_remove: tr("removed an emoji"), invite_create: tr("created an invite"), invite_revoke: tr("revoked an invite"),
    member_join: tr("joined the server"), member_leave: tr("left the server"), member_kick: tr("kicked {target}"), member_ban: tr("banned {target}"), member_unban: tr("unbanned {target}"),
    member_timeout: tr("timed out {target}"), member_timeout_clear: tr("removed the timeout for {target}"), member_update: tr("updated {target}"),
    role_create: tr("created a role"), role_update: tr("updated a role"), role_delete: tr("deleted a role"), role_order: tr("reordered roles"),
    channel_create: tr("created a channel"), channel_update: tr("updated a channel"), channel_delete: tr("deleted a channel"), channel_order: tr("reordered channels"),
    override_set: tr("changed channel permissions"), override_remove: tr("reset channel permissions"),
    message_remove: tr("removed a message by {target}"), message_pin: tr("pinned a message"), message_unpin: tr("unpinned a message")
    };
  }
  function modlogSheet() {
    var sheet = openSheet(sheetHead(tr("Moderation log"), tr("Every moderator action in this server, visible to all members.")) + '<div class="vsrv-sheet-body vsrv-results" data-k="list"><div class="dmsgs-skel"><span></span><span></span></div></div>', "tall");
    var box = sheet.querySelector('[data-k="list"]');
    var rows = [];
    function load(before) {
      call("/" + S.sid + "/modlog" + (before ? "?before=" + before : "")).then(function (res) {
        if (res.status !== 200) { box.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
        var list = res.body.entries || [];
        var mids = [];
        list.forEach(function (e) { mids.push(e.by); if (/^[a-f0-9]{16}$/.test(e.target) && /^member_|^message_remove/.test(e.action)) mids.push(e.action === "message_remove" && e.detail && e.detail.author ? e.detail.author : e.target); });
        needCards(mids);
        rows = rows.concat(list);
        render(res.body.more);
      });
    }
    function render(more) {
      var log = MODLOG();
      box.innerHTML = rows.length ? rows.map(function (e) {
        var targetMid = e.action === "message_remove" ? (e.detail && e.detail.author) : /^member_/.test(e.action) ? e.target : "";
        var tpl = log[e.action] || e.action;
        var text = esc(tpl).replace("{target}", targetMid ? "<strong>" + esc(nameOf(targetMid)) + "</strong>" : "");
        var d = e.detail || {};
        var extra = [];
        if (d.reason) extra.push(tr("Reason: {reason}", { reason: d.reason }));
        if (d.name) extra.push(String(d.name));
        if (d.excerpt) extra.push("“" + String(d.excerpt).slice(0, 140) + "”");
        if (d.seconds) extra.push(slowLabel(d.seconds));
        if (d.channel && channel(d.channel)) extra.push("#" + channel(d.channel).name);
        return '<div class="vsrv-log-row">' + avatar(e.by, S.sid, "vsrv-ava sm") + '<div class="vsrv-log-main"><div><strong>' + esc(nameOf(e.by)) + "</strong> " + text + '</div><div class="vsrv-sub">' + esc(fullTime(e.at)) + (extra.length ? " · " + esc(extra.join(" · ")) : "") + "</div></div></div>";
      }).join("") + (more ? '<div class="vsrv-older"><button type="button" class="vsrv-linkbtn" data-k="more">' + esc(tr("Show more")) + "</button></div>" : "") : '<div class="vsrv-empty"><p>' + esc(tr("Nothing here yet.")) + "</p></div>";
      var mb = box.querySelector('[data-k="more"]');
      if (mb) mb.addEventListener("click", function () { load(rows[rows.length - 1].id); });
    }
    load(0);
  }

  /* ---------- settings ---------- */
  function uploadRaw(sid, kind, file, extra, onProgress) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      var q = "?kind=" + kind + "&name=" + encodeURIComponent(file.name || "file") + (extra || "");
      xhr.open("POST", api() + "/v1/servers/" + sid + "/upload" + q);
      xhr.setRequestHeader("Authorization", "Bearer " + token());
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      if (onProgress && xhr.upload) xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
      xhr.onload = function () { var body = {}; try { body = JSON.parse(xhr.responseText || "{}"); } catch (err) { /* not json */ } resolve({ status: xhr.status, body: body }); };
      xhr.onerror = function () { resolve({ status: 0, body: { error: "offline" } }); };
      xhr.send(file);
    });
  }
  function TABS() { return [["overview", tr("Overview")], ["roles", tr("Roles")], ["emoji", tr("Emoji")], ["stickers", tr("Stickers")], ["invites", tr("Invites")], ["bans", tr("Bans")]]; }
  function settingsSheet(tab) {
    var p = basePerms();
    var tabs = TABS().filter(function (t) {
      if (t[0] === "overview" || t[0] === "emoji" || t[0] === "stickers") return has(p, P.MANAGE_SERVER);
      if (t[0] === "roles") return has(p, P.MANAGE_ROLES);
      if (t[0] === "invites") return has(p, P.MANAGE_SERVER) || has(p, P.CREATE_INVITE);
      if (t[0] === "bans") return has(p, P.BAN);
      return false;
    });
    if (!tabs.length) { toast(tr("You don't have permission to do that.")); return; }
    tab = tabs.some(function (t) { return t[0] === tab; }) ? tab : tabs[0][0];
    var sheet = openSheet(sheetHead(tr("Server settings"), (serverInfo(S.sid) || {}).name) + '<nav class="vsrv-tabs" role="tablist">' + tabs.map(function (t) {
      return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (t[0] === tab ? "true" : "false") + '">' + esc(t[1]) + "</button>";
    }).join("") + '</nav><div class="vsrv-sheet-body" data-k="body"></div>', "tall settings");
    function show(name) {
      tab = name;
      Array.prototype.forEach.call(sheet.querySelectorAll("[data-tab]"), function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === name ? "true" : "false"); });
      var body = sheet.querySelector('[data-k="body"]');
      if (name === "overview") overviewTab(body);
      if (name === "roles") rolesTab(body);
      if (name === "emoji") emojiTab(body);
      if (name === "stickers") stickersTab(body);
      if (name === "invites") invitesTab(body);
      if (name === "bans") bansTab(body);
    }
    sheet.addEventListener("click", function (ev) { var b = ev.target.closest("[data-tab]"); if (b) show(b.getAttribute("data-tab")); });
    show(tab);
  }
  function overviewTab(body) {
    var info = serverInfo(S.sid) || {};
    body.innerHTML = '<div class="vsrv-ov"><label class="vsrv-upload-pick"><input type="file" accept="image/*" data-k="icon" hidden>' + serverIcon(info, "vsrv-sicon big") + "<span>" + esc(tr("Change icon")) + "</span></label>" +
      '<label class="vsrv-upload-pick banner"><input type="file" accept="image/*" data-k="banner" hidden>' + (info.banner ? '<img class="vsrv-banner-prev" src="' + esc(info.banner) + '" alt="">' : '<span class="vsrv-banner-prev empty"></span>') + "<span>" + esc(tr("Change banner")) + "</span></label></div>" +
      (info.icon || info.banner ? '<div class="vsrv-inline">' + (info.icon ? '<button type="button" class="vsrv-linkbtn" data-k="rm-icon">' + esc(tr("Remove icon")) + "</button>" : "") + (info.banner ? '<button type="button" class="vsrv-linkbtn" data-k="rm-banner">' + esc(tr("Remove banner")) + "</button>" : "") + "</div>" : "") +
      '<label class="vsrv-field"><span>' + esc(tr("Server name")) + '</span><input type="text" maxlength="100" data-k="name" value="' + esc(info.name || "") + '"></label>' +
      '<label class="vsrv-field"><span>' + esc(tr("Description")) + '</span><textarea maxlength="500" rows="3" data-k="desc">' + esc(info.description || "") + "</textarea></label>" +
      '<div class="vsrv-inline end"><button type="button" class="vsrv-btn" data-k="save">' + esc(tr("Save changes")) + "</button></div>" +
      (me().owner ? '<div class="vsrv-danger"><h3>' + esc(tr("Delete server")) + "</h3><p>" + esc(tr("This removes every channel, message and file. It can't be undone.")) + '</p><button type="button" class="vsrv-btn danger" data-k="delete">' + esc(tr("Delete server")) + "</button></div>" : "");
    function refresh() { return Promise.all([loadServer(S.sid, true), loadList(true)]).then(function () { overviewTab(body); }); }
    body.querySelector('[data-k="save"]').onclick = function () {
      var btn = this;
      busy(btn, true);
      call("/" + S.sid, { method: "PATCH", body: { name: body.querySelector('[data-k="name"]').value.trim(), description: body.querySelector('[data-k="desc"]').value.trim() } }).then(function (res) {
        busy(btn, false);
        if (res.status !== 200) { toast(errText(res)); return; }
        toast(tr("Saved")); refresh();
      });
    };
    ["icon", "banner"].forEach(function (kind) {
      body.querySelector('[data-k="' + kind + '"]').onchange = function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        uploadRaw(S.sid, kind, f).then(function (res) { if (res.status !== 200) toast(errText(res)); else refresh(); });
      };
      var rm = body.querySelector('[data-k="rm-' + kind + '"]');
      if (rm) rm.onclick = function () { var b = {}; b[kind] = ""; call("/" + S.sid, { method: "PATCH", body: b }).then(function (res) { if (res.status !== 200) toast(errText(res)); else refresh(); }); };
    });
    var del = body.querySelector('[data-k="delete"]');
    if (del) del.onclick = function () {
      promptSheet(tr("Delete server"), tr("Type the server name to confirm"), "", tr("Delete server"), 100).then(function (v) {
        if (v == null) return;
        if (v !== info.name) { toast(tr("The name doesn't match.")); return; }
        call("/" + S.sid, { method: "DELETE" }).then(function (res) {
          if (res.status !== 200) { toast(errText(res)); return; }
          closeSheet(true);
          lsSet("srv:" + S.sid, null);
          S.list = (S.list || []).filter(function (s) { return s.id !== S.sid; });
          lsSet("list", { servers: S.list, canCreate: S.canCreate });
          location.hash = "#/messages";
        });
      });
    };
  }
  function rolesTab(body, openId) {
    var roles = sortedRoles();
    var myTop = topPos();
    body.innerHTML = '<div class="vsrv-inline"><button type="button" class="vsrv-btn" data-k="new">' + esc(tr("Create role")) + '</button><span class="vsrv-note">' + esc(tr("Higher roles outrank lower ones. Members show the color of their highest role.")) + "</span></div>" +
      '<div class="vsrv-rolelist">' + roles.map(function (r, i) {
        var editable = me().owner || r.position < myTop;
        var isEveryone = r.id === S.sid;
        return '<div class="vsrv-role' + (openId === r.id ? " open" : "") + '" data-r="' + r.id + '"><div class="vsrv-role-row"><span class="vsrv-role-dot" style="background:' + (color(r.color) || "var(--muted)") + '"></span><button type="button" class="vsrv-role-name" data-k="open" data-r="' + r.id + '">' + esc(isEveryone ? "@everyone" : r.name) + "</button>" +
          (!isEveryone && editable ? '<button type="button" class="vsrv-iconbtn sm" data-k="up" data-r="' + r.id + '"' + (i === 0 ? " disabled" : "") + ' aria-label="' + esc(tr("Move up")) + '">▲</button><button type="button" class="vsrv-iconbtn sm" data-k="down" data-r="' + r.id + '"' + (i >= roles.length - 2 ? " disabled" : "") + ' aria-label="' + esc(tr("Move down")) + '">▼</button>' : "") +
          "</div>" + (openId === r.id ? roleEditor(r, editable) : "") + "</div>";
      }).join("") + "</div>";
    body.onclick = function (ev) {
      var b = ev.target.closest("[data-k]");
      if (!b) return;
      var k = b.getAttribute("data-k");
      var rid = b.getAttribute("data-r");
      if (k === "new") {
        call("/" + S.sid + "/roles", { method: "POST", body: { name: tr("new role"), perms: 0 } }).then(function (res) {
          if (res.status !== 200) { toast(errText(res)); return; }
          loadServer(S.sid, true).then(function () { rolesTab(body, res.body.role.id); });
        });
      }
      if (k === "open") rolesTab(body, openId === rid ? "" : rid);
      if (k === "up" || k === "down") {
        var ids = sortedRoles().filter(function (r) { return r.id !== S.sid; }).map(function (r) { return r.id; });
        var i = ids.indexOf(rid);
        var j = k === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= ids.length) return;
        ids[i] = ids[j]; ids[j] = rid;
        call("/" + S.sid + "/roles/order", { method: "PUT", body: { ids: ids } }).then(function (res) {
          if (res.status !== 200) { toast(errText(res)); return; }
          loadServer(S.sid, true).then(function () { rolesTab(body, openId); });
        });
      }
      if (k === "save-role") {
        var box = b.closest(".vsrv-role");
        var perms = 0;
        Array.prototype.forEach.call(box.querySelectorAll("[data-perm]:checked"), function (x) { perms |= P[x.getAttribute("data-perm")]; });
        var patch = { perms: perms };
        var name = box.querySelector('[data-f="name"]');
        if (name) {
          patch.name = name.value.trim();
          patch.color = parseInt(box.querySelector('[data-f="color"]').value.slice(1), 16) || 0;
          if (box.querySelector('[data-f="nocolor"]').checked) patch.color = 0;
          patch.hoist = box.querySelector('[data-f="hoist"]').checked;
          patch.mentionable = box.querySelector('[data-f="mentionable"]').checked;
        }
        busy(b, true);
        call("/" + S.sid + "/roles/" + rid, { method: "PATCH", body: patch }).then(function (res) {
          busy(b, false);
          if (res.status !== 200) { toast(errText(res)); return; }
          toast(tr("Saved"));
          loadServer(S.sid, true).then(function () { rolesTab(body, rid); paintLog(); paintMembers(); });
        });
      }
      if (k === "del-role") {
        var r = role(rid);
        confirmSheet(tr("Delete role"), tr("Delete the role {name}? Members lose it right away.", { name: r ? r.name : "" }), tr("Delete"), true).then(function (ok) {
          if (!ok) return;
          call("/" + S.sid + "/roles/" + rid, { method: "DELETE" }).then(function (res) {
            if (res.status !== 200) { toast(errText(res)); return; }
            loadServer(S.sid, true).then(function () { rolesTab(body); });
          });
        });
      }
    };
  }
  function roleEditor(r, editable) {
    var isEveryone = r.id === S.sid;
    var mine = basePerms();
    var dis = editable ? "" : " disabled";
    return '<div class="vsrv-role-edit">' + (isEveryone ? '<p class="vsrv-note">' + esc(tr("These apply to everyone in the server, unless a channel changes them.")) + "</p>" :
      '<label class="vsrv-field"><span>' + esc(tr("Role name")) + '</span><input type="text" maxlength="100" data-f="name" value="' + esc(r.name) + '"' + dis + "></label>" +
      '<div class="vsrv-inline"><label class="vsrv-field color"><span>' + esc(tr("Color")) + '</span><input type="color" data-f="color" value="' + (color(r.color) || "#99aab5") + '"' + dis + '></label><label class="vsrv-check"><input type="checkbox" data-f="nocolor"' + (r.color ? "" : " checked") + dis + "><span>" + esc(tr("No color")) + "</span></label></div>" +
      '<label class="vsrv-check"><input type="checkbox" data-f="hoist"' + (r.hoist ? " checked" : "") + dis + "><span>" + esc(tr("Show members with this role separately")) + "</span></label>" +
      '<label class="vsrv-check"><input type="checkbox" data-f="mentionable"' + (r.mentionable ? " checked" : "") + dis + "><span>" + esc(tr("Allow anyone to @mention this role")) + "</span></label>") +
      "<h3>" + esc(tr("Permissions")) + '</h3><div class="vsrv-checks">' + PERM_ROWS().map(function (row) {
        var bit = P[row[0]];
        var grantable = me().owner || has(mine, bit);
        return '<label class="vsrv-check switch"><input type="checkbox" data-perm="' + row[0] + '"' + (((r.perms & bit) === bit) ? " checked" : "") + (editable && grantable ? "" : " disabled") + "><span>" + esc(row[1]) + "</span></label>";
      }).join("") + "</div>" +
      (editable ? '<div class="vsrv-inline end">' + (isEveryone ? "" : '<button type="button" class="vsrv-btn danger ghost" data-k="del-role" data-r="' + r.id + '">' + esc(tr("Delete role")) + "</button>") + '<button type="button" class="vsrv-btn" data-k="save-role" data-r="' + r.id + '">' + esc(tr("Save changes")) + "</button></div>" : "") + "</div>";
  }
  function emojiTab(body) {
    var st = srv();
    var list = (st && st.emojis) || [];
    body.innerHTML = '<p class="vsrv-note">' + esc(tr("Add custom emoji anyone here can use. Images up to 512 KB; names use letters, numbers and underscores.")) + "</p>" +
      '<div class="vsrv-inline"><label class="vsrv-field"><span>' + esc(tr("Name")) + '</span><input type="text" maxlength="32" data-k="name" placeholder="party_parrot"></label><label class="vsrv-btn"><input type="file" accept="image/png,image/gif,image/webp,image/jpeg" data-k="file" hidden>' + esc(tr("Upload emoji")) + "</label></div>" +
      '<div class="vsrv-elist">' + (list.length ? list.map(function (e) {
        return '<div class="vsrv-erow"><img src="' + esc(e.url) + '" alt=""><span>:' + esc(e.name) + ':</span><button type="button" class="vsrv-iconbtn sm" data-k="del" data-e="' + e.id + '" aria-label="' + esc(tr("Delete")) + '">' + icon("trash") + "</button></div>";
      }).join("") : '<p class="vsrv-note">' + esc(tr("No custom emoji yet.")) + "</p>") + "</div>";
    body.querySelector('[data-k="file"]').onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var name = body.querySelector('[data-k="name"]').value.trim() || String(f.name || "").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 32);
      uploadRaw(S.sid, "emoji", f, "&emoji=" + encodeURIComponent(name)).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        loadServer(S.sid, true).then(function () { emojiTab(body); });
      });
    };
    body.onclick = function (ev) {
      var b = ev.target.closest('[data-k="del"]');
      if (!b) return;
      call("/" + S.sid + "/emojis/" + b.getAttribute("data-e"), { method: "DELETE" }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        loadServer(S.sid, true).then(function () { emojiTab(body); });
      });
    };
  }
  function invitesTab(body) {
    body.innerHTML = '<div class="dmsgs-skel"><span></span><span></span></div>';
    call("/" + S.sid + "/invites").then(function (res) {
      if (res.status !== 200) { body.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
      var list = res.body.invites || [];
      needCards(list.map(function (i) { return i.by; }));
      body.innerHTML = '<div class="vsrv-inline"><button type="button" class="vsrv-btn" data-k="new">' + esc(tr("Create invite")) + "</button></div>" + (list.length ? list.map(function (i) {
        return '<div class="vsrv-invrow"><div><code>' + esc(i.code) + '</code><div class="vsrv-sub">' + esc(nameOf(i.by)) + " · " + esc(i.maxUses ? tr("{uses} of {max} uses", { uses: i.uses, max: i.maxUses }) : trn(i.uses, "srvUses")) + " · " + esc(i.expiresAt ? tr("Expires {time}", { time: fullTime(i.expiresAt) }) : tr("Never expires")) + "</div></div>" +
          '<button type="button" class="vsrv-iconbtn sm" data-k="copy" data-c="' + esc(i.code) + '" aria-label="' + esc(tr("Copy")) + '">' + icon("copy") + '</button><button type="button" class="vsrv-iconbtn sm" data-k="revoke" data-c="' + esc(i.code) + '" aria-label="' + esc(tr("Revoke")) + '">' + icon("trash") + "</button></div>";
      }).join("") : '<p class="vsrv-note">' + esc(tr("No active invites.")) + "</p>");
    });
    body.onclick = function (ev) {
      var b = ev.target.closest("[data-k]");
      if (!b) return;
      var k = b.getAttribute("data-k");
      if (k === "new") inviteSheet();
      if (k === "copy") copy(inviteLink(b.getAttribute("data-c")));
      if (k === "revoke") call("/" + S.sid + "/invites/" + b.getAttribute("data-c"), { method: "DELETE" }).then(function (res) { if (res.status !== 200) toast(errText(res)); invitesTab(body); });
    };
  }
  function bansTab(body) {
    body.innerHTML = '<div class="dmsgs-skel"><span></span><span></span></div>';
    call("/" + S.sid + "/bans").then(function (res) {
      if (res.status !== 200) { body.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
      var list = res.body.bans || [];
      body.innerHTML = list.length ? list.map(function (b) {
        var c = b.card || {};
        return '<div class="vsrv-invrow"><div><strong>' + esc(c.name || c.handle || tr("Member")) + "</strong>" + (c.handle ? ' <span class="vsrv-sub">@' + esc(c.handle) + "</span>" : "") + '<div class="vsrv-sub">' + esc(fullTime(b.at)) + (b.reason ? " · " + esc(b.reason) : "") + "</div></div>" +
          '<button type="button" class="vsrv-btn ghost sm" data-k="unban" data-m="' + esc(b.m) + '">' + esc(tr("Unban")) + "</button></div>";
      }).join("") : '<p class="vsrv-note">' + esc(tr("No bans.")) + "</p>";
    });
    body.onclick = function (ev) {
      var b = ev.target.closest('[data-k="unban"]');
      if (b) call("/" + S.sid + "/bans/" + b.getAttribute("data-m"), { method: "DELETE" }).then(function (res) { if (res.status !== 200) toast(errText(res)); bansTab(body); });
    };
  }

  function newChannelSheet(parentId) {
    var cats = channelsOf().filter(function (c) { return c.kind === "category"; });
    var sheet = openSheet(sheetHead(tr("Create channel")) + '<div class="vsrv-sheet-body vsrv-radios">' +
      [["text", "hash", tr("Text"), tr("Send messages, images, files and links")], ["announcement", "news", tr("Announcement"), tr("Important updates. Only moderators post by default")], ["forum", "forum", tr("Forum"), tr("Organized posts, each with its own thread")], ["voice", "voice", tr("Voice"), tr("Talk, turn on your camera and share your screen")], ["category", "chev", tr("Category"), tr("Groups channels together")]].map(function (k, i) {
        return '<label class="vsrv-radio big"><input type="radio" name="vsrv-kind" value="' + k[0] + '"' + (i === 0 ? " checked" : "") + ">" + icon(k[1]) + "<span><strong>" + esc(k[2]) + "</strong><small>" + esc(k[3]) + "</small></span></label>";
      }).join("") +
      '<label class="vsrv-field"><span>' + esc(tr("Name")) + '</span><input type="text" maxlength="100" data-k="name" placeholder="new-channel" autofocus></label>' +
      (cats.length ? '<label class="vsrv-field" data-k="parent-wrap"><span>' + esc(tr("Category")) + '</span><select data-k="parent"><option value="">' + esc(tr("No category")) + "</option>" + cats.map(function (c) { return '<option value="' + c.id + '"' + (c.id === parentId ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</select></label>" : "") +
      '<label class="vsrv-check switch"><input type="checkbox" data-k="private"><span>' + esc(tr("Private channel")) + "<small>" + esc(tr("Only roles you allow later can see it")) + "</small></span></label></div>" +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="go">' + esc(tr("Create channel")) + "</button></footer>", "small");
    function go() {
      var kind = sheet.querySelector('input[name="vsrv-kind"]:checked').value;
      var name = sheet.querySelector('[data-k="name"]').value.trim();
      if (!name) { sheet.querySelector('[data-k="name"]').focus(); return; }
      var parent = sheet.querySelector('[data-k="parent"]');
      var btn = sheet.querySelector('[data-k="go"]');
      busy(btn, true);
      call("/" + S.sid + "/channels", { method: "POST", body: { kind: kind, name: name, parentId: kind === "category" || !parent ? "" : parent.value, private: sheet.querySelector('[data-k="private"]').checked } }).then(function (res) {
        busy(btn, false);
        if (res.status !== 200) { toast(errText(res)); return; }
        closeSheet(true);
        loadServer(S.sid, true).then(function () { if (kind !== "category") location.hash = "#/messages/s/" + S.sid + "/" + res.body.channel.id; });
      });
    }
    sheet.querySelector('[data-k="go"]').addEventListener("click", go);
    sheet.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && ev.target.tagName === "INPUT" && ev.target.type === "text") go(); });
  }
  function channelSettingsSheet(cid, tab) {
    var c = channel(cid);
    if (!c) return;
    tab = tab || "overview";
    var sheet = openSheet(sheetHead(tr("Edit channel"), (c.kind === "category" ? "" : "#") + c.name) + '<nav class="vsrv-tabs" role="tablist"><button type="button" data-tab="overview" aria-selected="' + (tab === "overview") + '">' + esc(tr("Overview")) + '</button><button type="button" data-tab="perms" aria-selected="' + (tab === "perms") + '">' + esc(tr("Permissions")) + "</button></nav>" + '<div class="vsrv-sheet-body" data-k="body"></div>', "tall settings");
    function show(name) {
      Array.prototype.forEach.call(sheet.querySelectorAll("[data-tab]"), function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === name ? "true" : "false"); });
      var body = sheet.querySelector('[data-k="body"]');
      c = channel(cid) || c;
      if (name === "overview") {
        body.innerHTML = '<label class="vsrv-field"><span>' + esc(tr("Name")) + '</span><input type="text" maxlength="100" data-k="name" value="' + esc(c.name) + '"></label>' +
          (c.kind !== "category" ? '<label class="vsrv-field"><span>' + esc(tr("Topic")) + '</span><textarea rows="3" maxlength="1024" data-k="topic">' + esc(c.topic || "") + "</textarea></label>" +
          '<label class="vsrv-field"><span>' + esc(tr("Slow mode")) + '</span><select data-k="slow">' + SLOW.map(function (s) { return '<option value="' + s + '"' + (s === (c.slowmode || 0) ? " selected" : "") + ">" + esc(slowLabel(s)) + "</option>"; }).join("") + '</select><small class="vsrv-note">' + esc(tr("Members wait this long between messages. Moderators are exempt.")) + "</small></label>" : "") +
          (c.kind === "forum" ? tagsEditor(c) : "") +
          '<div class="vsrv-inline end"><button type="button" class="vsrv-btn danger ghost" data-k="delete">' + esc(c.kind === "category" ? tr("Delete category") : tr("Delete channel")) + '</button><button type="button" class="vsrv-btn" data-k="save">' + esc(tr("Save changes")) + "</button></div>";
      } else {
        var roles = sortedRoles();
        var ov = c.overrides || [];
        body.innerHTML = '<p class="vsrv-note">' + esc(tr("Allow or deny per role. Unset follows the role and the category.")) + "</p>" + roles.map(function (r) {
          var o = ov.find(function (x) { return x.type === "role" && x.id === r.id; }) || { allow: 0, deny: 0 };
          return '<details class="vsrv-details"' + (r.id === S.sid ? " open" : "") + '><summary><span class="vsrv-role-dot" style="background:' + (color(r.color) || "var(--muted)") + '"></span>' + esc(r.id === S.sid ? "@everyone" : r.name) + (o.allow || o.deny ? ' <span class="vsrv-sub">' + esc(tr("custom permissions")) + "</span>" : "") + '</summary><div class="vsrv-ovr" data-r="' + r.id + '">' +
            CHANNEL_PERMS.map(function (k) {
              var bit = P[k];
              var v = (o.allow & bit) ? "a" : (o.deny & bit) ? "d" : "";
              var label = (PERM_ROWS().find(function (x) { return x[0] === k; }) || [k, k])[1];
              return '<div class="vsrv-tri"><span>' + esc(label) + '</span><span class="vsrv-tri-btns" data-p="' + k + '">' +
                '<button type="button" data-v="d" aria-pressed="' + (v === "d") + '" aria-label="' + esc(tr("Deny")) + '">✕</button><button type="button" data-v="" aria-pressed="' + (v === "") + '" aria-label="' + esc(tr("Inherit")) + '">/</button><button type="button" data-v="a" aria-pressed="' + (v === "a") + '" aria-label="' + esc(tr("Allow")) + '">✓</button></span></div>';
            }).join("") + '<div class="vsrv-inline end"><button type="button" class="vsrv-btn sm" data-k="save-ovr" data-r="' + r.id + '">' + esc(tr("Save")) + "</button></div></div></details>";
        }).join("");
      }
      body.onclick = function (ev) {
        if (tagsClick(ev, body)) return;
        var tri = ev.target.closest(".vsrv-tri-btns button");
        if (tri) { Array.prototype.forEach.call(tri.parentNode.children, function (x) { x.setAttribute("aria-pressed", x === tri ? "true" : "false"); }); return; }
        var b = ev.target.closest("[data-k]");
        if (!b) return;
        var k = b.getAttribute("data-k");
        if (k === "save") {
          var patch = { name: body.querySelector('[data-k="name"]').value.trim() };
          if (c.kind === "forum") saveTags(body, cid);
          var t = body.querySelector('[data-k="topic"]');
          if (t) { patch.topic = t.value.trim(); patch.slowmode = Number(body.querySelector('[data-k="slow"]').value); }
          busy(b, true);
          call("/" + S.sid + "/channels/" + cid, { method: "PATCH", body: patch }).then(function (res) {
            busy(b, false);
            if (res.status !== 200) { toast(errText(res)); return; }
            toast(tr("Saved")); loadServer(S.sid, true);
          });
        }
        if (k === "delete") {
          confirmSheet(tr("Delete channel"), tr("Delete #{name}? Its messages and files are removed for good.", { name: c.name }), tr("Delete"), true).then(function (ok) {
            if (!ok) return;
            call("/" + S.sid + "/channels/" + cid, { method: "DELETE" }).then(function (res) {
              if (res.status !== 200) { toast(errText(res)); return; }
              closeSheet(true);
              loadServer(S.sid, true).then(function () { if (S.cid === cid) location.hash = "#/messages/s/" + S.sid; });
            });
          });
        }
        if (k === "save-ovr") {
          var rid = b.getAttribute("data-r");
          var box = body.querySelector('.vsrv-ovr[data-r="' + rid + '"]');
          var allow = 0, deny = 0;
          Array.prototype.forEach.call(box.querySelectorAll("[data-p]"), function (g) {
            var on = g.querySelector('[aria-pressed="true"]');
            var v = on ? on.getAttribute("data-v") : "";
            if (v === "a") allow |= P[g.getAttribute("data-p")];
            if (v === "d") deny |= P[g.getAttribute("data-p")];
          });
          var url = "/" + S.sid + "/channels/" + cid + "/overrides/role/" + rid;
          busy(b, true);
          call(url, allow || deny ? { method: "PUT", body: { allow: allow, deny: deny } } : { method: "DELETE" }).then(function (res) {
            busy(b, false);
            if (res.status !== 200) { toast(errText(res)); return; }
            toast(tr("Saved")); loadServer(S.sid, true).then(function () { show("perms"); });
          });
        }
      };
    }
    sheet.addEventListener("click", function (ev) { var b = ev.target.closest("[data-tab]"); if (b) show(b.getAttribute("data-tab")); });
    show(tab);
  }

  /* ---------- composer ---------- */
  function composeText(raw) {
    var text = String(raw || "");
    var map = S.mentionMap[S.cid] || {};
    Object.keys(map).sort(function (a, b) { return b.length - a.length; }).forEach(function (label) {
      text = text.split(label).join(map[label]);
    });
    text = text.replace(/(^|[^<\w]):([A-Za-z0-9_]{2,32}):/g, function (whole, pre, name) {
      var e = emojiByName(name);
      return e ? pre + "<:" + name + ":" + e.id + ">" : whole;
    });
    return text;
  }
  function submit() {
    var input = el("vsrv-input");
    if (!input || !S.cid) return;
    var files = S.files.filter(function (f) { return f.c === S.cid; });
    if (files.some(function (f) { return !f.k && !f.err; })) { toast(tr("Wait for uploads to finish.")); return; }
    var ready = files.filter(function (f) { return f.k; });
    var raw = input.value.replace(/\s+$/, "");
    if (!raw.trim() && !ready.length) return;
    if (raw.length > 4000) { toast(tr("That message is too long.")); return; }
    var body = composeText(raw);
    var reply = S.reply && S.reply.c === S.cid ? S.reply : null;
    S.drafts[S.cid] = "";
    lsSet("drafts", S.drafts);
    S.mentionMap[S.cid] = {};
    S.reply = null;
    S.files = S.files.filter(function (f) { return f.c !== S.cid; });
    input.value = "";
    S.forceBottom = true;
    sendMessage(S.sid, S.cid, body, reply ? reply.id : "", ready, reply ? reply.ping !== false : true);
    paintCompose(true);
  }
  function startEditLast() {
    var list = S.msgs[S.cid] || [];
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].a === me().mid && !list[i].pending && !list[i].x && list[i].f !== 1) { startEdit(list[i].id); return true; }
    }
    return false;
  }
  function startEdit(id) {
    S.edit = id;
    var log = el("vsrv-log");
    if (log) log.innerHTML = logInner();
    var ta = el("vsrv-edit");
    if (ta) {
      var m = msgById(id);
      ta.value = editable(m ? m.b : "");
      autosize(ta);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      var node = ta.closest(".vsrv-msg");
      if (node) node.scrollIntoView({ block: "nearest" });
    }
  }
  function editable(body) {
    var map = S.mentionMap[S.cid] || (S.mentionMap[S.cid] = {});
    return String(body || "").replace(/<@([a-f0-9]{16})>/g, function (tok, mid) { var label = "@" + nameOf(mid); map[label] = tok; return label; })
      .replace(/<@&([a-f0-9]{16})>/g, function (tok, rid) { var r = role(rid); if (!r) return tok; var label = "@" + r.name; map[label] = tok; return label; })
      .replace(/<a?:([A-Za-z0-9_]{2,32}):[a-f0-9]{16}>/g, ":$1:");
  }
  function saveEdit() {
    var ta = el("vsrv-edit");
    var id = S.edit;
    if (!ta || !id) return;
    var m = msgById(id);
    var body = composeText(ta.value.replace(/\s+$/, ""));
    S.edit = "";
    if (!m || body === m.b) { paintLog(); return; }
    if (!body.trim() && !(m.at && m.at.length)) { paintLog(); deleteMessage(id); return; }
    var old = m.b;
    m.b = body; m.e = Date.now();
    paintLog();
    call("/" + S.sid + "/channels/" + S.cid + "/messages/" + id, { method: "PATCH", body: { body: body } }).then(function (res) {
      if (res.status === 200 && res.body.message) { mergeMessages(S.cid, [res.body.message]); paintLog(); return; }
      m.b = old; toast(errText(res)); paintLog();
    });
  }
  function cancelEdit() { S.edit = ""; paintLog(); var i = el("vsrv-input"); if (i && !coarse()) i.focus(); }
  function deleteMessage(id, asMod) {
    var m = msgById(id);
    if (!m) return;
    var cid = S.cid;
    var p = asMod ? confirmSheet(tr("Remove message"), tr("Everyone sees that a moderator removed it. The text stays in the moderation log."), tr("Remove"), true, true)
      : confirmSheet(tr("Delete message"), tr("Are you sure you want to delete this message?"), tr("Delete"), true);
    p.then(function (ok) {
      if (!ok) return;
      call("/" + S.sid + "/channels/" + cid + "/messages/" + id + (asMod && ok.reason ? "?reason=" + encodeURIComponent(ok.reason) : ""), { method: "DELETE" }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        if (res.body.message) mergeMessages(cid, [res.body.message]);
        else S.msgs[cid] = (S.msgs[cid] || []).filter(function (x) { return x.id !== id; });
        saveChannel(cid);
        if (cid === S.cid) paintLog();
      });
    });
  }
  function toggleReaction(id, key) {
    var m = msgById(id);
    if (!m) return;
    var rx = m.rx || (m.rx = []);
    var item = rx.find(function (r) { return r.e === key; });
    var on = !(item && item.me);
    if (!item) { item = { e: key, n: 0, me: false }; rx.push(item); }
    item.n += on ? 1 : -1; item.me = on;
    m.rx = rx.filter(function (r) { return r.n > 0; });
    paintLog();
    var cid = S.cid;
    call("/" + S.sid + "/channels/" + cid + "/messages/" + id + "/reactions/" + encodeURIComponent(key), { method: on ? "PUT" : "DELETE" }).then(function (res) {
      if (res.status === 200) return;
      toast(errText(res));
      loadMessages(S.sid, cid, { around: id });
    });
  }
  function insertText(text) {
    var input = el("vsrv-input");
    if (!input) return;
    var s = input.selectionStart == null ? input.value.length : input.selectionStart;
    var e = input.selectionEnd == null ? s : input.selectionEnd;
    input.value = input.value.slice(0, s) + text + input.value.slice(e);
    var at = s + text.length;
    try { input.focus(); input.setSelectionRange(at, at); } catch (err) { /* hidden */ }
    S.drafts[S.cid] = input.value;
    autosize(input);
  }
  function insertMention(mid) {
    var label = "@" + nameOf(mid);
    (S.mentionMap[S.cid] || (S.mentionMap[S.cid] = {}))[label] = "<@" + mid + ">";
    insertText(label + " ");
  }

  var pop = { items: [], at: 0, start: -1 };
  function mentionQuery(input) {
    var pos = input.selectionStart;
    var before = input.value.slice(0, pos);
    var m = /(^|\s)([@:])([^\s@:]{0,32})$/.exec(before);
    if (!m) return null;
    if (m[2] === ":" && m[3].length < 2) return null;
    return { kind: m[2], q: m[3].toLowerCase(), start: pos - m[3].length - 1 };
  }
  function updatePop() {
    var input = el("vsrv-input");
    var box = el("vsrv-pop");
    if (!input || !box) return;
    var q = mentionQuery(input);
    if (!q) { box.hidden = true; pop.items = []; return; }
    var items = [];
    if (q.kind === "@") {
      if (!S.members[S.sid]) loadMembers(S.sid);
      var bag = S.cards[S.sid] || {};
      var seen = {};
      (S.members[S.sid] || []).concat(Object.keys(bag).map(function (k) { return { m: k }; })).forEach(function (m) {
        if (seen[m.m] || items.length > 30) return;
        seen[m.m] = 1;
        var c = bag[m.m];
        if (!c || c.member === false) return;
        var hay = [c.nick, c.name, c.handle].join(" ").toLowerCase();
        if (!q.q || hay.indexOf(q.q) >= 0) items.push({ t: "u", id: m.m, label: nameOf(m.m), sub: c.handle ? "@" + c.handle : "" });
      });
      var canAll = has(chanPerms(S.cid), P.MENTION_EVERYONE);
      sortedRoles().forEach(function (r) {
        if (r.id === S.sid || !(r.mentionable || canAll)) return;
        if (!q.q || r.name.toLowerCase().indexOf(q.q) >= 0) items.push({ t: "r", id: r.id, label: r.name, sub: tr("Role"), color: color(r.color) });
      });
      if (canAll) ["everyone", "here"].forEach(function (w) { if (w.indexOf(q.q) === 0) items.push({ t: "all", id: w, label: w, sub: w === "here" ? tr("Notify everyone online") : tr("Notify everyone in this channel") }); });
    } else {
      var st = srv();
      (st && st.emojis || []).forEach(function (e) { if (e.name.toLowerCase().indexOf(q.q) >= 0) items.push({ t: "e", id: e.id, label: e.name, url: e.url }); });
    }
    items = items.slice(0, 8);
    pop.items = items; pop.at = 0; pop.start = q.start;
    if (!items.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = items.map(function (it, i) {
      var face = it.t === "u" ? avatar(it.id, S.sid, "vsrv-ava xs") : it.t === "e" ? '<img class="vsrv-emoji" src="' + esc(it.url) + '" alt="">' : '<span class="vsrv-pop-at"' + (it.color ? ' style="color:' + it.color + '"' : "") + ">@</span>";
      return '<button type="button" class="vsrv-pop-item' + (i === 0 ? " on" : "") + '" data-pop="' + i + '">' + face + "<span>" + esc(it.t === "e" ? ":" + it.label + ":" : it.label) + "</span>" + (it.sub ? "<small>" + esc(it.sub) + "</small>" : "") + "</button>";
    }).join("");
  }
  function choosePop(i) {
    var it = pop.items[i];
    var input = el("vsrv-input");
    if (!it || !input) return;
    var end = input.selectionStart;
    var label;
    if (it.t === "e") label = ":" + it.label + ":";
    else if (it.t === "all") label = "@" + it.id;
    else {
      label = "@" + it.label;
      (S.mentionMap[S.cid] || (S.mentionMap[S.cid] = {}))[label] = it.t === "u" ? "<@" + it.id + ">" : "<@&" + it.id + ">";
    }
    input.value = input.value.slice(0, pop.start) + label + " " + input.value.slice(end);
    var at = pop.start + label.length + 1;
    input.setSelectionRange(at, at);
    S.drafts[S.cid] = input.value;
    el("vsrv-pop").hidden = true;
    pop.items = [];
    input.focus();
  }

  function addFiles(list) {
    if (!S.cid || !list || !list.length) return;
    if (!has(chanPerms(S.cid), P.ATTACH)) { toast(tr("You don't have permission to do that.")); return; }
    var sid = S.sid;
    var cid = S.cid;
    Array.prototype.slice.call(list, 0, 10).forEach(function (file) {
      if (file.size > 50 * 1024 * 1024) { toast(tr("That file is too large.") + " (" + tr("Max {size}", { size: "50 MB" }) + ")"); return; }
      var f = { id: rand(), c: cid, n: file.name || "file", t: file.type || "application/octet-stream", s: file.size, p: 0, local: "" };
      if (/^(image|video)\//.test(f.t)) { try { f.local = URL.createObjectURL(file); } catch (err) { /* no blob urls */ } }
      S.files.push(f);
      measure(file, f).then(function () {
        return uploadRaw(sid, "a", file, "", function (p) { f.p = p; var bar = document.querySelector('.vsrv-tray-x[data-id="' + f.id + '"]'); var i = bar && bar.parentNode.querySelector(".vsrv-tray-bar i"); if (i) i.style.width = Math.round(p * 100) + "%"; });
      }).then(function (res) {
        if (res.status === 200 && res.body.file) { f.k = res.body.file.k; f.n = res.body.file.n || f.n; f.t = res.body.file.t || f.t; f.s = res.body.file.s || f.s; }
        else { f.err = errText(res); toast(f.err); }
        if (cid === S.cid) paintCompose();
      });
    });
    paintCompose(true);
  }
  function measure(file, f) {
    return new Promise(function (resolve) {
      if (!f.local) { resolve(); return; }
      if (/^image\//.test(f.t)) {
        var img = new Image();
        img.onload = function () { f.w = img.naturalWidth; f.h = img.naturalHeight; resolve(); };
        img.onerror = function () { resolve(); };
        img.src = f.local;
      } else {
        var v = document.createElement("video");
        v.preload = "metadata"; v.muted = true;
        v.onloadedmetadata = function () { f.w = v.videoWidth; f.h = v.videoHeight; resolve(); };
        v.onerror = function () { resolve(); };
        setTimeout(resolve, 3000);
        v.src = f.local;
      }
    });
  }

  /* ---------- threads, forums, polls, stickers, events, activity (phase 2) ---------- */
  var tchan = {};
  var threadLoads = {};
  var threadMiss = {};
  var activeAt = {};
  var forumLoads = {};
  function storeThread(sid, t) {
    if (!t || !t.id) return null;
    var o = S.threads[t.id] || (S.threads[t.id] = {});
    Object.keys(t).forEach(function (k) { if (k !== "starter" || t.starter) o[k] = t[k]; });
    o.sid = sid;
    return o;
  }
  function threadChannel(cid, sid) {
    sid = sid || S.sid;
    var t = S.threads[cid];
    if (!t || t.sid !== sid) return null;
    var p = realChannel(t.parentId, sid);
    if (!p) return null;
    var perms = Number(p.perms) || 0;
    if (t.locked && !has(perms, P.MANAGE_THREADS)) perms &= ~(P.SEND | P.REACT | P.ATTACH);
    var c = tchan[cid] || (tchan[cid] = { id: cid, kind: "thread", mentions: 0, lastRead: "", lastId: "" });
    c.name = t.name; c.parentId = t.parentId; c.perms = perms; c.slowmode = p.slowmode || 0; c.topic = ""; c.thread = t;
    c.lastId = maxId(c.lastId, t.lastId);
    c.lastRead = maxId(c.lastRead, t.lastRead || "");
    return c;
  }
  function viewId(cid) { var t = S.threads[cid]; return t && t.sid === S.sid ? t.parentId : cid; }
  function loadThread(sid, tid) {
    if (threadLoads[tid]) return threadLoads[tid];
    threadLoads[tid] = call("/" + sid + "/channels/" + tid).then(function (res) {
      delete threadLoads[tid];
      if (res.status === 200 && res.body.thread) {
        var t = storeThread(sid, res.body.thread);
        needCards([t.ownerMid], sid);
        return t;
      }
      threadMiss[tid] = 1;
      return null;
    });
    return threadLoads[tid];
  }
  function loadActive(sid, force) {
    if (!force && activeAt[sid] && Date.now() - activeAt[sid] < 60000) return;
    activeAt[sid] = Date.now();
    call("/" + sid + "/threads").then(function (res) {
      if (res.status !== 200) return;
      S.active[sid] = (res.body.threads || []).map(function (t) { return storeThread(sid, t); });
      if (sid === S.sid) paintSide();
    });
  }
  function shortAgo(ts) {
    var d = Math.max(0, Date.now() - ts) / 1000;
    if (d < 60) return tr("now");
    if (d < 3600) return tr("{n}m", { n: Math.floor(d / 60) });
    if (d < 86400) return tr("{n}h", { n: Math.floor(d / 3600) });
    return tr("{n}d", { n: Math.floor(d / 86400) });
  }
  function threadIntro(c) {
    var t = c.thread;
    var parent = realChannel(t.parentId);
    var rootMsg = t.rootId ? (S.msgs[t.parentId] || []).find(function (x) { return x.id === t.rootId; }) : null;
    var jumpRoot = rootMsg ? '<button type="button" class="vsrv-reply" data-vs="jump" data-c="' + esc(t.parentId) + '" data-id="' + esc(rootMsg.id) + '">' + avatar(rootMsg.a, S.sid, "vsrv-ava xs") + '<span class="vsrv-reply-name">' + esc(nameOf(rootMsg.a)) + '</span><span class="vsrv-reply-text">' + esc((plain(rootMsg.b) || (rootMsg.at && rootMsg.at.length ? tr("Attachment") : "")).slice(0, 160)) + "</span></button>"
      : t.rootId ? '<button type="button" class="vsrv-linkbtn" data-vs="jump" data-c="' + esc(t.parentId) + '" data-id="' + esc(t.rootId) + '">' + esc(tr("Jump to original message")) + "</button>" : "";
    return '<div class="vsrv-intro">' + icon("thread", "vsrv-intro-ic") + "<h2>" + esc(t.name) + "</h2><p>" +
      esc(tr("Started by {name}", { name: nameOf(t.ownerMid) })) + (parent ? " · " + esc(tr("in #{name}", { name: parent.name })) : "") + "</p>" + jumpRoot + "</div>";
  }
  function canThreadFrom(m) {
    if (!m || m.pending || m.x || m.f || m.th) return false;
    var c = channel(S.cid);
    if (!c || (c.kind !== "text" && c.kind !== "announcement")) return false;
    var perms = Number(c.perms) || 0;
    return has(perms, P.CREATE_THREADS) && !timedOut();
  }
  function threadChip(m) {
    if (!m.th || m.x) return "";
    var t = S.threads[m.th.id] || storeThread(S.sid, m.th);
    return '<a class="vsrv-thchip" href="#/messages/s/' + S.sid + "/" + esc(t.id) + '">' + icon("thread") + '<span class="vsrv-thchip-name">' + esc(t.name) + "</span>" +
      '<span class="vsrv-thchip-n">' + esc(trn(Math.max(0, Number(t.count) || 0), "srvMessagesN")) + "</span>" +
      (t.lastId ? "<time>" + esc(shortAgo(msgTime(t.lastId))) + "</time>" : "") + (t.archived ? icon("archive", "vsrv-th-flag") : "") + (t.locked ? icon("lock", "vsrv-th-flag") : "") + "</a>";
  }
  function stickerHtml(m) {
    if (!m.st) return "";
    if (m.st.gone || !m.st.url) return '<div class="vsrv-sticker gone">' + icon("sticker") + "<span>" + esc(tr("Sticker removed")) + "</span></div>";
    return '<img class="vsrv-sticker" src="' + esc(m.st.url) + '" alt="' + esc(m.st.name || "") + '" title="' + esc(m.st.name || "") + '" width="160" height="160" loading="lazy" decoding="async">';
  }
  function leftLabel(ms) {
    if (ms < 3600000) return tr("{n}m left", { n: Math.max(1, Math.ceil(ms / 60000)) });
    if (ms < 86400000) return tr("{n}h left", { n: Math.ceil(ms / 3600000) });
    return tr("{n}d left", { n: Math.ceil(ms / 86400000) });
  }
  function pollHtml(m) {
    var pl = m.pl;
    if (!pl || !pl.o) return "";
    var ended = !!pl.ended || (pl.end && pl.end <= Date.now());
    var mine = pl.mine || [];
    var show = ended || mine.length > 0;
    var total = pl.o.reduce(function (s, o) { return s + (Number(o.n) || 0); }, 0);
    var top = pl.o.reduce(function (s, o) { return Math.max(s, Number(o.n) || 0); }, 0);
    var can = !ended && !m.pending && !timedOut();
    var mod = m.a === me().mid || has(chanPerms(S.cid), P.MANAGE_MESSAGES);
    return '<div class="vsrv-poll"><div class="vsrv-poll-q">' + esc(pl.q) + '</div><div class="vsrv-poll-sub">' + esc(pl.multi ? tr("Select one or more answers") : tr("Select one answer")) + "</div>" +
      pl.o.map(function (o, i) {
        var n = Number(o.n) || 0;
        var pct = total ? Math.round(n * 100 / total) : 0;
        var on = mine.indexOf(i) >= 0;
        return '<button type="button" class="vsrv-popt' + (on ? " on" : "") + (show ? " res" : "") + (ended && top > 0 && n === top ? " win" : "") + '" data-vs="poll-vote" data-id="' + esc(m.id) + '" data-o="' + i + '"' + (can ? "" : " disabled") + ' aria-pressed="' + (on ? "true" : "false") + '">' +
          (show ? '<i style="width:' + pct + '%"></i>' : "") + '<span class="vsrv-popt-box' + (pl.multi ? " sq" : "") + '">' + (on ? icon("check") : "") + '</span><span class="vsrv-popt-t">' + esc(o.t) + "</span>" +
          (show ? '<span class="vsrv-popt-n">' + pct + "%</span>" : "") + "</button>";
      }).join("") +
      '<div class="vsrv-poll-foot"><button type="button" class="vsrv-linkbtn" data-vs="poll-voters" data-id="' + esc(m.id) + '">' + esc(trn(Number(pl.voters) || 0, "srvVotes")) + "</button><span>·</span><span>" + esc(ended ? tr("Poll closed") : leftLabel(pl.end - Date.now())) + "</span>" +
      (can && mine.length ? '<button type="button" class="vsrv-linkbtn" data-vs="poll-clear" data-id="' + esc(m.id) + '">' + esc(tr("Remove vote")) + "</button>" : "") +
      (!ended && mod && !m.pending ? '<button type="button" class="vsrv-linkbtn" data-vs="poll-end" data-id="' + esc(m.id) + '">' + esc(tr("End poll now")) + "</button>" : "") + "</div></div>";
  }
  function pollMsgPath(cid, id) { return "/" + S.sid + "/channels/" + cid + "/messages/" + id + "/poll"; }
  function votePoll(id, o) {
    var m = msgById(id);
    if (!m || !m.pl) return;
    var cid = S.cid;
    var pl = m.pl;
    var before = JSON.stringify(pl);
    var mine = (pl.mine || []).slice();
    var next;
    if (o < 0) next = [];
    else if (pl.multi) next = mine.indexOf(o) >= 0 ? mine.filter(function (x) { return x !== o; }) : mine.concat([o]);
    else next = mine.length === 1 && mine[0] === o ? [] : [o];
    mine.forEach(function (i) { if (pl.o[i]) pl.o[i].n = Math.max(0, (Number(pl.o[i].n) || 0) - 1); });
    next.forEach(function (i) { if (pl.o[i]) pl.o[i].n = (Number(pl.o[i].n) || 0) + 1; });
    if (!mine.length && next.length) pl.voters = (Number(pl.voters) || 0) + 1;
    if (mine.length && !next.length) pl.voters = Math.max(0, (Number(pl.voters) || 0) - 1);
    pl.mine = next;
    paintLog();
    call(pollMsgPath(cid, id), { method: "PUT", body: { o: next } }).then(function (res) {
      if (res.status === 200 && res.body.poll) m.pl = res.body.poll;
      else { m.pl = JSON.parse(before); toast(errText(res)); }
      saveChannel(cid);
      if (cid === S.cid) paintLog();
    });
  }
  function endPoll(id) {
    var m = msgById(id);
    if (!m || !m.pl) return;
    var cid = S.cid;
    confirmSheet(tr("End poll now"), tr("Voting closes for everyone and the results are final."), tr("End poll"), true).then(function (ok) {
      if (!ok) return;
      call(pollMsgPath(cid, id) + "/end", { method: "POST", body: {} }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        m.pl = Object.assign({}, res.body.poll, { mine: (m.pl && m.pl.mine) || [] });
        saveChannel(cid);
        if (cid === S.cid) paintLog();
      });
    });
  }
  function pollVoters(id) {
    var m = msgById(id);
    if (!m || !m.pl) return;
    var cid = S.cid;
    var sheet = openSheet(sheetHead(tr("Poll votes"), m.pl.q) + '<nav class="vsrv-tabs scroll" role="tablist">' + m.pl.o.map(function (o, i) {
      return '<button type="button" role="tab" data-tab="' + i + '" aria-selected="' + (i === 0 ? "true" : "false") + '">' + esc(o.t) + " · " + (Number(o.n) || 0) + "</button>";
    }).join("") + '</nav><div class="vsrv-sheet-body" data-k="body"></div>', "tall");
    function show(i) {
      Array.prototype.forEach.call(sheet.querySelectorAll("[data-tab]"), function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === String(i) ? "true" : "false"); });
      var body = sheet.querySelector('[data-k="body"]');
      body.innerHTML = '<div class="dmsgs-skel"><span></span><span></span></div>';
      call(pollMsgPath(cid, id) + "/voters?o=" + i).then(function (res) {
        if (res.status !== 200) { body.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
        var list = res.body.voters || [];
        needCards(list);
        body.innerHTML = list.length ? list.map(function (mid) { return '<button type="button" class="vsrv-mrow" data-vs="member" data-m="' + esc(mid) + '">' + avatar(mid, S.sid, "vsrv-ava sm") + '<span class="vsrv-mrow-name">' + esc(nameOf(mid)) + "</span></button>"; }).join("") : '<p class="vsrv-note">' + esc(tr("No votes yet.")) + "</p>";
      });
    }
    sheet.addEventListener("click", function (ev) { var b = ev.target.closest("[data-tab]"); if (b) show(Number(b.getAttribute("data-tab"))); });
    show(0);
  }
  function sendSpecial(extra) {
    var cid = S.cid;
    var sid = S.sid;
    return call("/" + sid + "/channels/" + cid + "/messages", { method: "POST", body: Object.assign({ body: "", nonce: "n" + rand() }, extra) }).then(function (res) {
      if (res.status !== 200 || !res.body.message) { toast(errText(res)); return false; }
      mergeMessages(cid, [res.body.message], false);
      markReadSoon(sid, cid, res.body.message.id, true);
      S.forceBottom = true;
      if (cid === S.cid) paintLog(true);
      return true;
    });
  }
  function appsMenu() {
    var c = channel(S.cid);
    if (!c) return;
    var st = srv();
    var n = st && st.stickers ? st.stickers.length : 0;
    var items = [["poll", "poll", tr("Create poll")], ["sticker", "sticker", n ? tr("Send a sticker") : tr("No stickers in this server yet")]];
    var sheet = openSheet('<div class="vsrv-menu">' + items.map(function (it) {
      return '<button type="button" class="vsrv-menu-item" data-k="' + it[0] + '"' + (it[0] === "sticker" && !n ? " disabled" : "") + ">" + icon(it[1]) + "<span>" + esc(it[2]) + "</span></button>";
    }).join("") + "</div>", "is-menu");
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-k]");
      if (!b || b.disabled) return;
      closeSheet(true);
      if (b.getAttribute("data-k") === "poll") pollSheet();
      else stickerPicker();
    });
  }
  function POLL_TIMES() { return [[1, tr("1 hour")], [4, tr("4 hours")], [8, tr("8 hours")], [24, tr("24 hours")], [72, tr("3 days")], [168, tr("1 week")]]; }
  function pollSheet() {
    function optRow(i) { return '<div class="vsrv-inline"><input type="text" class="vsrv-input-line" maxlength="55" data-k="opt" placeholder="' + esc(tr("Answer {n}", { n: i + 1 })) + '"></div>'; }
    var sheet = openSheet(sheetHead(tr("Create poll")) + '<div class="vsrv-sheet-body"><label class="vsrv-field"><span>' + esc(tr("Question")) + '</span><input type="text" maxlength="300" data-k="q" placeholder="' + esc(tr("What question do you want to ask?")) + '" autofocus></label>' +
      '<div class="vsrv-field"><span>' + esc(tr("Answers")) + '</span><div data-k="opts">' + optRow(0) + optRow(1) + '</div><button type="button" class="vsrv-linkbtn" data-k="add">' + icon("plus") + esc(tr("Add another answer")) + "</button></div>" +
      '<label class="vsrv-field"><span>' + esc(tr("Duration")) + '</span><select data-k="h">' + POLL_TIMES().map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === 24 ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join("") + "</select></label>" +
      '<label class="vsrv-check switch"><input type="checkbox" data-k="multi"><span>' + esc(tr("Allow multiple answers")) + "</span></label></div>" +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="go">' + esc(tr("Post")) + "</button></footer>", "small");
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-k]");
      if (!b) return;
      var k = b.getAttribute("data-k");
      if (k === "add") {
        var box = sheet.querySelector('[data-k="opts"]');
        var count = box.querySelectorAll('[data-k="opt"]').length;
        if (count >= 10) { toast(tr("Up to 10 answers.")); return; }
        box.insertAdjacentHTML("beforeend", optRow(count));
        var last = box.querySelectorAll('[data-k="opt"]')[count];
        if (last) last.focus();
      }
      if (k === "go") {
        var q = sheet.querySelector('[data-k="q"]').value.trim();
        var opts = Array.prototype.map.call(sheet.querySelectorAll('[data-k="opt"]'), function (x) { return x.value.trim(); }).filter(Boolean);
        if (!q) { sheet.querySelector('[data-k="q"]').focus(); return; }
        if (opts.length < 2) { toast(tr("Add at least two answers.")); return; }
        busy(b, true);
        sendSpecial({ poll: { q: q, o: opts, multi: sheet.querySelector('[data-k="multi"]').checked, hours: Number(sheet.querySelector('[data-k="h"]').value) } }).then(function (ok) {
          busy(b, false);
          if (ok) closeSheet(true);
        });
      }
    });
  }
  function stickerPicker() {
    var st = srv();
    var list = (st && st.stickers) || [];
    var sheet = openSheet(sheetHead(tr("Stickers")) + '<div class="vsrv-sheet-body"><div class="vsrv-sgrid">' + list.map(function (s) {
      return '<button type="button" data-pick="' + esc(s.id) + '" title="' + esc(s.name) + '"><img src="' + esc(s.url) + '" alt="' + esc(s.name) + '" loading="lazy" decoding="async"></button>';
    }).join("") + "</div></div>", "emoji");
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-pick]");
      if (!b) return;
      closeSheet(true);
      sendSpecial({ sticker: b.getAttribute("data-pick") });
    });
  }
  function stickersTab(body) {
    var st = srv();
    var list = (st && st.stickers) || [];
    body.innerHTML = '<p class="vsrv-note">' + esc(tr("Stickers are big images anyone here can send. PNG, APNG, GIF or WebP up to 512 KB.")) + "</p>" +
      '<div class="vsrv-inline"><label class="vsrv-field"><span>' + esc(tr("Name")) + '</span><input type="text" maxlength="30" data-k="name" placeholder="wave"></label><label class="vsrv-btn"><input type="file" accept="image/png,image/apng,image/gif,image/webp" data-k="file" hidden>' + esc(tr("Upload sticker")) + "</label></div>" +
      '<div class="vsrv-sgrid">' + (list.length ? list.map(function (s) {
        return '<div class="vsrv-scell"><img src="' + esc(s.url) + '" alt=""><span>' + esc(s.name) + '</span><button type="button" class="vsrv-iconbtn sm" data-k="del" data-e="' + esc(s.id) + '" aria-label="' + esc(tr("Delete")) + '">' + icon("trash") + "</button></div>";
      }).join("") : '<p class="vsrv-note">' + esc(tr("No stickers yet.")) + "</p>") + "</div>";
    body.querySelector('[data-k="file"]').onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      if (f.size > 512 * 1024) { toast(tr("That file is too large.") + " (" + tr("Max {size}", { size: "512 KB" }) + ")"); return; }
      var name = body.querySelector('[data-k="name"]').value.trim() || String(f.name || "").replace(/\.[^.]+$/, "").slice(0, 30);
      uploadRaw(S.sid, "sticker", f, "&sticker=" + encodeURIComponent(name)).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        loadServer(S.sid, true).then(function () { stickersTab(body); });
      });
    };
    body.onclick = function (ev) {
      var b = ev.target.closest('[data-k="del"]');
      if (!b) return;
      call("/" + S.sid + "/stickers/" + b.getAttribute("data-e"), { method: "DELETE" }).then(function (res) {
        if (res.status !== 200) { toast(errText(res)); return; }
        loadServer(S.sid, true).then(function () { stickersTab(body); });
      });
    };
  }

  /* threads: lists, creation, settings */
  function threadRowHtml(t) {
    return '<a class="vsrv-result" href="#/messages/s/' + S.sid + "/" + esc(t.id) + '" data-close="1">' + icon("thread", "vsrv-result-ic") +
      '<span class="vsrv-result-main"><span class="vsrv-head"><span class="vsrv-name">' + esc(t.name) + "</span>" + (t.locked ? icon("lock", "vsrv-th-flag") : "") + "<time>" + esc(t.lastId ? shortAgo(msgTime(t.lastId)) : "") + "</time></span>" +
      '<span class="vsrv-result-text">' + esc(tr("Started by {name}", { name: nameOf(t.ownerMid) })) + " · " + esc(trn(Number(t.count) || 0, "srvMessagesN")) + "</span></span></a>";
  }
  function threadsSheet(cid) {
    var c = realChannel(cid);
    if (!c) return;
    var canMake = has(Number(c.perms) || 0, P.CREATE_THREADS) && !timedOut();
    var sheet = openSheet(sheetHead(tr("Threads"), "#" + c.name) + '<nav class="vsrv-tabs" role="tablist"><button type="button" role="tab" data-tab="0" aria-selected="true">' + esc(tr("Active")) + '</button><button type="button" role="tab" data-tab="1" aria-selected="false">' + esc(tr("Archived")) + "</button></nav>" +
      '<div class="vsrv-sheet-body vsrv-results" data-k="list"></div>' + (canMake ? '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn" data-k="new">' + icon("plus") + "<span>" + esc(tr("Create thread")) + "</span></button></footer>" : ""), "tall");
    function show(arch) {
      Array.prototype.forEach.call(sheet.querySelectorAll("[data-tab]"), function (b) { b.setAttribute("aria-selected", b.getAttribute("data-tab") === (arch ? "1" : "0") ? "true" : "false"); });
      var box = sheet.querySelector('[data-k="list"]');
      box.innerHTML = '<div class="dmsgs-skel"><span></span><span></span></div>';
      call("/" + S.sid + "/channels/" + cid + "/threads" + (arch ? "?archived=1" : "")).then(function (res) {
        if (res.status !== 200) { box.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
        var list = (res.body.threads || []).map(function (t) { return storeThread(S.sid, t); });
        needCards(list.map(function (t) { return t.ownerMid; }));
        box.innerHTML = list.length ? list.map(threadRowHtml).join("") : '<div class="vsrv-empty"><h2>' + esc(arch ? tr("No archived threads") : tr("No active threads")) + "</h2><p>" + esc(tr("Threads keep side conversations out of the main channel.")) + "</p></div>";
      });
    }
    sheet.addEventListener("click", function (ev) {
      var tb = ev.target.closest("[data-tab]");
      if (tb) { show(tb.getAttribute("data-tab") === "1"); return; }
      var b = ev.target.closest('[data-k="new"]');
      if (!b) return;
      promptSheet(tr("Create thread"), tr("Thread name"), "", tr("Create"), 100).then(function (name) {
        if (name == null) return;
        startThread(cid, { name: name || tr("Thread") });
      });
    });
    show(false);
  }
  function startThread(cid, payload, rootMsg) {
    var sid = S.sid;
    return call("/" + sid + "/channels/" + cid + "/threads", { method: "POST", body: payload }).then(function (res) {
      if (res.status === 409 && res.body.id) { closeSheet(true); location.hash = "#/messages/s/" + sid + "/" + res.body.id; return null; }
      if (res.status !== 200 || !res.body.thread) { toast(errText(res)); return null; }
      var t = storeThread(sid, res.body.thread);
      if (rootMsg) { rootMsg.th = Object.assign({}, res.body.thread); saveChannel(cid); }
      var act = S.active[sid] || (S.active[sid] = []);
      if (act.indexOf(t) < 0) act.push(t);
      if (res.body.message) mergeMessages(t.id, [res.body.message], false);
      var f = S.forum[cid];
      if (f && f.list.indexOf(t) < 0) f.list.unshift(t);
      closeSheet(true);
      location.hash = "#/messages/s/" + sid + "/" + t.id;
      return t;
    });
  }
  function createThreadFrom(mid) {
    var m = msgById(mid);
    if (!m) return;
    if (m.th) { location.hash = "#/messages/s/" + S.sid + "/" + m.th.id; return; }
    var cid = S.cid;
    var guess = (plain(m.b) || "").replace(/\s+/g, " ").trim().slice(0, 40);
    promptSheet(tr("Create thread"), tr("Thread name"), guess, tr("Create"), 100).then(function (name) {
      if (name == null) return;
      startThread(cid, { messageId: mid, name: name || guess || tr("Thread") }, m);
    });
  }
  function patchThread(tid, patch) {
    var sid = S.sid;
    return call("/" + sid + "/channels/" + tid, { method: "PATCH", body: patch }).then(function (res) {
      if (res.status !== 200 || !res.body.thread) { toast(errText(res)); return false; }
      var t = storeThread(sid, res.body.thread);
      var act = S.active[sid] || (S.active[sid] = []);
      var i = act.indexOf(t);
      if (t.archived && i >= 0) act.splice(i, 1);
      if (!t.archived && i < 0) act.push(t);
      paintAll();
      return true;
    });
  }
  function threadMenu() {
    var t = S.threads[S.cid];
    var parent = t && realChannel(t.parentId);
    if (!t || !parent) return;
    var pp = Number(parent.perms) || 0;
    var mgr = has(pp, P.MANAGE_THREADS);
    var own = t.ownerMid === me().mid;
    var items = [];
    if (own || mgr) items.push(["rename", "edit", tr("Rename")]);
    if ((own || mgr) && parent.kind === "forum" && (parent.tags || []).length) items.push(["tags", "pin", tr("Edit tags")]);
    if (own || mgr) items.push(["archive", "archive", t.archived ? tr("Unarchive") : tr("Archive")]);
    if (mgr) items.push(["lock", "lock", t.locked ? tr("Unlock") : tr("Lock")]);
    items.push(["link", "link", tr("Copy link")]);
    if (mgr) items.push(["delete", "trash", parent.kind === "forum" ? tr("Delete post") : tr("Delete thread"), "danger"]);
    var sheet = openSheet(sheetHead(t.name) + '<div class="vsrv-menu">' + items.map(function (it) {
      return '<button type="button" class="vsrv-menu-item' + (it[3] ? " " + it[3] : "") + '" data-tm="' + it[0] + '">' + icon(it[1]) + "<span>" + esc(it[2]) + "</span></button>";
    }).join("") + "</div>", "is-menu");
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-tm]");
      if (!b) return;
      var a = b.getAttribute("data-tm");
      closeSheet(true);
      if (a === "rename") promptSheet(tr("Rename"), tr("Thread name"), t.name, tr("Save"), 100).then(function (v) { if (v) patchThread(t.id, { name: v }); });
      if (a === "archive") patchThread(t.id, { archived: !t.archived });
      if (a === "lock") patchThread(t.id, { locked: !t.locked });
      if (a === "tags") tagPickSheet(parent, t.tags || [], function (ids) { patchThread(t.id, { tags: ids }); });
      if (a === "link") copy(location.origin + location.pathname + "#/messages/s/" + S.sid + "/" + t.id);
      if (a === "delete") {
        confirmSheet(parent.kind === "forum" ? tr("Delete post") : tr("Delete thread"), tr("Its messages are removed for good."), tr("Delete"), true).then(function (ok) {
          if (!ok) return;
          call("/" + S.sid + "/channels/" + t.id, { method: "DELETE" }).then(function (res) {
            if (res.status !== 200) { toast(errText(res)); return; }
            dropThread(S.sid, t.id);
            location.hash = "#/messages/s/" + S.sid + "/" + t.parentId;
          });
        });
      }
    });
  }
  function tagChip(tag) { return '<span class="vsrv-tag">' + (tag.emoji ? esc(tag.emoji) + " " : "") + esc(tag.name) + "</span>"; }
  function tagPickSheet(forum, selected, done) {
    var tags = forum.tags || [];
    var sheet = openSheet(sheetHead(tr("Edit tags"), tr("Pick up to 5.")) + '<div class="vsrv-sheet-body"><div class="vsrv-pills wrap">' + tags.map(function (tag) {
      return '<label class="vsrv-pill"><input type="checkbox" data-tag="' + esc(tag.id) + '"' + (selected.indexOf(tag.id) >= 0 ? " checked" : "") + "><span>" + (tag.emoji ? esc(tag.emoji) + " " : "") + esc(tag.name) + "</span></label>";
    }).join("") + '</div></div><footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="go">' + esc(tr("Save")) + "</button></footer>", "small");
    sheet.addEventListener("change", function () { var on = sheet.querySelectorAll("[data-tag]:checked"); if (on.length > 5) { toast(tr("Pick up to 5.")); on[on.length - 1].checked = false; } });
    sheet.querySelector('[data-k="go"]').addEventListener("click", function () {
      var ids = Array.prototype.map.call(sheet.querySelectorAll("[data-tag]:checked"), function (x) { return x.getAttribute("data-tag"); });
      closeSheet();
      done(ids);
    });
  }
  function dropThread(sid, tid) {
    var t = S.threads[tid];
    delete S.threads[tid];
    delete tchan[tid];
    threadMiss[tid] = 1;
    S.active[sid] = (S.active[sid] || []).filter(function (x) { return x.id !== tid; });
    Object.keys(S.forum).forEach(function (k) { var f = S.forum[k]; f.list = f.list.filter(function (x) { return x.id !== tid; }); if (f.archived) f.archived = f.archived.filter(function (x) { return x.id !== tid; }); });
    if (t && S.msgs[t.parentId]) S.msgs[t.parentId].forEach(function (m) { if (m.th && m.th.id === tid) delete m.th; });
  }

  /* forum channels */
  function loadForum(sid, fid, archived, before) {
    var key = fid + (archived ? ":a" : "") + (before || "");
    if (forumLoads[key]) return;
    forumLoads[key] = 1;
    var q = [];
    if (archived) q.push("archived=1");
    if (before) q.push("before=" + encodeURIComponent(before));
    call("/" + sid + "/channels/" + fid + "/threads" + (q.length ? "?" + q.join("&") : "")).then(function (res) {
      delete forumLoads[key];
      if (res.status !== 200) { if (S.cid === fid) toast(errText(res)); return; }
      var list = (res.body.threads || []).map(function (t) { return storeThread(sid, t); });
      var f = S.forum[fid] || (S.forum[fid] = { list: [] });
      if (archived) { f.archived = before ? (f.archived || []).concat(list) : list; f.archNext = res.body.next || ""; }
      else { f.list = before ? f.list.concat(list) : list; f.next = res.body.next || ""; }
      needCards(list.map(function (t) { return t.ownerMid; }).concat(list.map(function (t) { return t.starter ? t.starter.a : ""; }).filter(Boolean)), sid);
      if (S.cid === fid) paintForum();
    });
  }
  function paintForum() { var box = el("vsrv-forum"); var c = channel(S.cid); if (box && c && c.kind === "forum") box.innerHTML = forumInner(c); }
  function postCard(t, forum) {
    var st = t.starter;
    var img = st && st.at ? st.at.find(function (f) { return /^image\//.test(f.type || "") && f.url; }) : null;
    var byId = {};
    (forum.tags || []).forEach(function (x) { byId[x.id] = x; });
    var chips = (t.tags || []).map(function (id) { return byId[id]; }).filter(Boolean).map(tagChip).join("");
    var seen = tchan[t.id] ? maxId(tchan[t.id].lastRead, t.lastRead) : t.lastRead;
    var unread = t.lastId && seen != null && t.lastId > (seen || "");
    var text = st ? (st.x ? tr("Removed by a moderator") : plain(st.b) || (st.pl ? st.pl.q : "") || (st.at && st.at.length ? tr("Attachment") : "")) : "";
    return '<a class="vsrv-post' + (unread ? " unread" : "") + '" href="#/messages/s/' + S.sid + "/" + esc(t.id) + '"><span class="vsrv-post-main">' + (chips ? '<span class="vsrv-tags">' + chips + "</span>" : "") +
      '<span class="vsrv-post-title">' + (t.locked ? icon("lock", "vsrv-th-flag") : "") + esc(t.name) + "</span>" +
      (st ? '<span class="vsrv-post-text"><strong>' + esc(nameOf(st.a)) + ":</strong> " + esc(String(text).slice(0, 200)) + "</span>" : "") +
      '<span class="vsrv-post-meta">' + icon("forum") + "<span>" + esc(String(Math.max(0, (Number(t.count) || 0) - (t.starterId ? 1 : 0)))) + "</span><span>·</span><span>" + esc(shortAgo(msgTime(t.lastId || t.id))) + "</span></span></span>" +
      (img ? '<img class="vsrv-post-img" src="' + esc(img.url) + '" alt="" loading="lazy" decoding="async">' : "") + "</a>";
  }
  function forumInner(c) {
    var f = S.forum[c.id];
    var perms = Number(c.perms) || 0;
    var canPost = has(perms, P.SEND) && has(perms, P.CREATE_THREADS) && !timedOut();
    var tags = c.tags || [];
    var sel = S.forumTag[c.id] || "";
    if (sel && !tags.some(function (x) { return x.id === sel; })) sel = "";
    var top = '<div class="vsrv-forum-top">' + (canPost ? '<button type="button" class="vsrv-btn" data-vs="forum-post">' + icon("plus") + "<span>" + esc(tr("New post")) + "</span></button>" : "") +
      (c.topic ? '<p class="vsrv-sub">' + esc(plain(c.topic)) + "</p>" : "") + "</div>" +
      (tags.length ? '<div class="vsrv-pills scroll">' + [{ id: "", name: tr("All") }].concat(tags).map(function (x) {
        return '<button type="button" class="vsrv-pill' + (sel === x.id ? " on" : "") + '" data-vs="forum-tag" data-id="' + esc(x.id) + '" aria-pressed="' + (sel === x.id ? "true" : "false") + '">' + (x.emoji ? esc(x.emoji) + " " : "") + esc(x.name) + "</button>";
      }).join("") + "</div>" : "");
    if (!f) return top + '<div class="dmsgs-skel" aria-busy="true"><span></span><span></span><span></span></div>';
    function pick(t) { return !sel || (t.tags || []).indexOf(sel) >= 0; }
    var list = f.list.filter(function (t) { return !t.archived && pick(t); });
    list.sort(function (a, b) { return (b.lastId || b.id) > (a.lastId || a.id) ? 1 : -1; });
    var arch = (f.archived || []).filter(pick);
    return top + '<div class="vsrv-posts">' + (list.length ? list.map(function (t) { return postCard(t, c); }).join("")
      : '<div class="vsrv-empty">' + icon("forum", "vsrv-intro-ic") + "<h2>" + esc(tr("No posts yet")) + "</h2><p>" + esc(canPost ? tr("Be the first to start a conversation.") : tr("Posts show up here.")) + "</p></div>") + "</div>" +
      (f.next ? '<div class="vsrv-older"><button type="button" class="vsrv-linkbtn" data-vs="forum-more">' + esc(tr("Show more")) + "</button></div>" : "") +
      (f.archived ? (arch.length ? '<h3 class="vsrv-forum-h">' + esc(tr("Archived posts")) + '</h3><div class="vsrv-posts">' + arch.map(function (t) { return postCard(t, c); }).join("") + "</div>" : '<p class="vsrv-note center">' + esc(tr("No archived posts.")) + "</p>")
        : '<div class="vsrv-older"><button type="button" class="vsrv-linkbtn" data-vs="forum-archived">' + esc(tr("Show archived posts")) + "</button></div>");
  }
  function forumPostSheet(fid) {
    var c = channel(fid);
    if (!c) return;
    var tags = c.tags || [];
    var sheet = openSheet(sheetHead(tr("New post"), "#" + c.name) + '<div class="vsrv-sheet-body"><label class="vsrv-field"><span>' + esc(tr("Title")) + '</span><input type="text" maxlength="100" data-k="name" autofocus></label>' +
      '<label class="vsrv-field"><span>' + esc(tr("Message")) + '</span><textarea rows="5" maxlength="4000" data-k="body"></textarea></label>' +
      (tags.length ? '<div class="vsrv-field"><span>' + esc(tr("Tags")) + '</span><div class="vsrv-pills wrap">' + tags.map(function (tag) {
        return '<label class="vsrv-pill"><input type="checkbox" data-tag="' + esc(tag.id) + '"><span>' + (tag.emoji ? esc(tag.emoji) + " " : "") + esc(tag.name) + "</span></label>";
      }).join("") + "</div></div>" : "") + "</div>" +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="go">' + esc(tr("Post")) + "</button></footer>", "tall");
    sheet.addEventListener("change", function () { var on = sheet.querySelectorAll("[data-tag]:checked"); if (on.length > 5) { toast(tr("Pick up to 5.")); on[on.length - 1].checked = false; } });
    sheet.querySelector('[data-k="go"]').addEventListener("click", function () {
      var btn = this;
      var name = sheet.querySelector('[data-k="name"]').value.trim();
      var text = sheet.querySelector('[data-k="body"]').value.trim();
      if (!name) { sheet.querySelector('[data-k="name"]').focus(); return; }
      if (!text) { sheet.querySelector('[data-k="body"]').focus(); return; }
      var ids = Array.prototype.map.call(sheet.querySelectorAll("[data-tag]:checked"), function (x) { return x.getAttribute("data-tag"); });
      busy(btn, true);
      startThread(fid, { name: name, body: composeText(text), tags: ids, nonce: "n" + rand() }).then(function () { busy(btn, false); });
    });
  }
  function tagRow(tag) {
    return '<div class="vsrv-tagrow" data-id="' + esc(tag.id || "") + '"><input type="text" class="emoji" maxlength="16" data-t="emoji" value="' + esc(tag.emoji || "") + '" placeholder="🏷️" aria-label="' + esc(tr("Emoji")) + '"><input type="text" maxlength="20" data-t="name" value="' + esc(tag.name || "") + '" placeholder="' + esc(tr("Tag name")) + '"><button type="button" class="vsrv-iconbtn sm" data-k="tag-x" aria-label="' + esc(tr("Remove")) + '">' + icon("trash") + "</button></div>";
  }
  function tagsEditor(c) {
    return '<div class="vsrv-field"><span>' + esc(tr("Tags")) + '</span><small class="vsrv-note">' + esc(tr("Posts can pick up to 5 tags. Members filter by them.")) + '</small><div data-k="tags">' + (c.tags || []).map(tagRow).join("") + '</div><button type="button" class="vsrv-linkbtn" data-k="tag-add">' + icon("plus") + esc(tr("Add tag")) + "</button></div>";
  }
  function tagsClick(ev, body) {
    var b = ev.target.closest('[data-k="tag-add"], [data-k="tag-x"]');
    if (!b) return false;
    if (b.getAttribute("data-k") === "tag-x") { var row = b.closest(".vsrv-tagrow"); if (row) row.remove(); return true; }
    var box = body.querySelector('[data-k="tags"]');
    if (box.children.length >= 20) { toast(tr("Up to 20 tags.")); return true; }
    box.insertAdjacentHTML("beforeend", tagRow({}));
    var inputs = box.querySelectorAll('[data-t="name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
    return true;
  }
  function saveTags(body, cid) {
    var rows = Array.prototype.map.call(body.querySelectorAll(".vsrv-tagrow"), function (r) {
      var out = { name: r.querySelector('[data-t="name"]').value.trim(), emoji: r.querySelector('[data-t="emoji"]').value.trim() };
      if (r.getAttribute("data-id")) out.id = r.getAttribute("data-id");
      return out;
    }).filter(function (x) { return x.name; });
    return call("/" + S.sid + "/channels/" + cid + "/tags", { method: "PUT", body: { tags: rows } }).then(function (res) { if (res.status !== 200) toast(errText(res)); });
  }

  /* scheduled events */
  function eventsList() { return S.events[S.sid] || null; }
  function eventWhen(ev) {
    var end = ev.endAt ? (new Date(ev.endAt).toDateString() === new Date(ev.startAt).toDateString() ? clock(ev.endAt) : fullTime(ev.endAt)) : "";
    return fullTime(ev.startAt) + (end ? " – " + end : "");
  }
  function eventLive(ev) { var now = Date.now(); return ev.status === "active" || (ev.status === "scheduled" && ev.startAt <= now && (!ev.endAt || ev.endAt > now)); }
  function eventCard(ev) {
    var open = ev.status === "scheduled" || ev.status === "active";
    var live = eventLive(ev);
    var ch = ev.channelId ? realChannel(ev.channelId) : null;
    var canEdit = S.eventsManage || ev.creatorMid === me().mid;
    var when = ev.status === "cancelled" ? tr("Cancelled") : ev.status === "ended" ? tr("Ended") : live ? tr("Happening now") : eventWhen(ev);
    return '<article class="vsrv-event' + (open ? "" : " over") + '">' + (ev.image ? '<img class="vsrv-event-img" src="' + esc(ev.image) + '" alt="" loading="lazy" decoding="async">' : "") +
      '<div class="vsrv-event-when' + (live ? " live" : "") + '">' + icon("calendar") + "<span>" + esc(when) + "</span></div>" +
      "<h3>" + esc(ev.name) + "</h3>" + (ev.description ? '<p class="vsrv-event-desc">' + esc(ev.description) + "</p>" : "") +
      (ch || ev.location ? '<div class="vsrv-event-where">' + (ch ? '<a href="#/messages/s/' + S.sid + "/" + esc(ch.id) + '" data-close="1">' + icon(chanIcon(ch)) + esc(ch.name) + "</a>" : "") + (ev.location ? "<span>" + esc(ev.location) + "</span>" : "") + "</div>" : "") +
      '<div class="vsrv-event-foot"><button type="button" class="vsrv-linkbtn" data-ev="who" data-id="' + esc(ev.id) + '">' + esc(trn(ev.going, "srvGoing")) + " · " + esc(trn(ev.interested, "srvInterested")) + "</button>" +
      '<span class="vsrv-event-btns">' + (open && !timedOut() ? '<button type="button" class="vsrv-btn sm' + (ev.mine === "interested" ? "" : " ghost") + '" data-ev="interested" data-id="' + esc(ev.id) + '" aria-pressed="' + (ev.mine === "interested") + '">' + icon("star") + "<span>" + esc(tr("Interested")) + "</span></button>" +
        '<button type="button" class="vsrv-btn sm' + (ev.mine === "going" ? "" : " ghost") + '" data-ev="going" data-id="' + esc(ev.id) + '" aria-pressed="' + (ev.mine === "going") + '">' + icon("check") + "<span>" + esc(tr("Going")) + "</span></button>" : "") +
      (canEdit ? '<button type="button" class="vsrv-iconbtn sm" data-ev="manage" data-id="' + esc(ev.id) + '" aria-label="' + esc(tr("More")) + '">' + icon("more") + "</button>" : "") + "</span></div></article>";
  }
  function eventsInner() {
    var list = eventsList();
    if (!list) return '<div class="dmsgs-skel"><span></span><span></span></div>';
    if (!list.length) return '<div class="vsrv-empty">' + icon("calendar", "vsrv-intro-ic") + "<h2>" + esc(tr("No upcoming events")) + "</h2><p>" + esc(tr("Schedule an event so members know when to show up.")) + "</p></div>";
    return list.slice().sort(function (a, b) { return a.startAt - b.startAt; }).map(eventCard).join("");
  }
  function paintEventsSheet() { var box = document.querySelector('.vsrv-sheet [data-k="events"]'); if (box) box.innerHTML = eventsInner(); }
  function loadEvents(sid) {
    return call("/" + sid + "/events").then(function (res) {
      if (res.status !== 200) { toast(errText(res)); return; }
      S.events[sid] = res.body.events || [];
      if (sid === S.sid) S.eventsManage = !!res.body.canManage;
      var st = srv(sid);
      if (st) st.events = S.events[sid].filter(function (e) { return e.status === "scheduled" || e.status === "active"; }).length;
      if (sid === S.sid) { paintEventsSheet(); paintSide(); }
    });
  }
  function eventById(id) { return (eventsList() || []).find(function (e) { return e.id === id; }) || null; }
  function eventsSheet() {
    var canMake = has(basePerms(), P.MANAGE_EVENTS);
    var sheet = openSheet(sheetHead(tr("Events"), (serverInfo(S.sid) || {}).name) + '<div class="vsrv-sheet-body vsrv-events" data-k="events">' + eventsInner() + "</div>" +
      (canMake ? '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn" data-ev="new">' + icon("plus") + "<span>" + esc(tr("Create event")) + "</span></button></footer>" : ""), "tall");
    loadEvents(S.sid);
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-ev]");
      if (!b) return;
      var a = b.getAttribute("data-ev");
      var e = eventById(b.getAttribute("data-id"));
      if (a === "new") { eventEditSheet(null); return; }
      if (!e) return;
      if (a === "going" || a === "interested") rsvp(e, e.mine === a ? "none" : a);
      if (a === "manage") eventManage(e);
      if (a === "who") eventWho(e);
    });
  }
  function rsvp(e, status) {
    var old = { mine: e.mine, going: e.going, interested: e.interested };
    if (e.mine === "going") e.going = Math.max(0, e.going - 1);
    if (e.mine === "interested") e.interested = Math.max(0, e.interested - 1);
    if (status === "going") e.going++;
    if (status === "interested") e.interested++;
    e.mine = status === "none" ? "" : status;
    paintEventsSheet();
    call("/" + S.sid + "/events/" + e.id + "/rsvp", { method: "PUT", body: { status: status } }).then(function (res) {
      if (res.status === 200) { e.going = res.body.going; e.interested = res.body.interested; e.mine = res.body.mine || ""; }
      else { Object.assign(e, old); toast(errText(res)); }
      paintEventsSheet();
    });
  }
  function eventPatch(e, patch) {
    return call("/" + S.sid + "/events/" + e.id, { method: "PATCH", body: patch }).then(function (res) {
      if (res.status !== 200 || !res.body.event) { toast(errText(res)); return false; }
      Object.assign(e, res.body.event, { mine: e.mine });
      loadEvents(S.sid);
      return true;
    });
  }
  function eventManage(e) {
    var items = [["edit", "edit", tr("Edit event")]];
    if (e.status === "scheduled") items.push(["start", "calendar", tr("Start event")]);
    if (e.status === "active") items.push(["end", "check", tr("End event")]);
    if (e.status === "scheduled") items.push(["cancel", "close", tr("Cancel event")]);
    items.push(["delete", "trash", tr("Delete event"), "danger"]);
    var sheet = openSheet(sheetHead(e.name) + '<div class="vsrv-menu">' + items.map(function (it) {
      return '<button type="button" class="vsrv-menu-item' + (it[3] ? " " + it[3] : "") + '" data-em="' + it[0] + '">' + icon(it[1]) + "<span>" + esc(it[2]) + "</span></button>";
    }).join("") + "</div>", "is-menu");
    sheet.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-em]");
      if (!b) return;
      var a = b.getAttribute("data-em");
      closeSheet();
      if (a === "edit") eventEditSheet(e);
      if (a === "start") eventPatch(e, { status: "active" });
      if (a === "end") eventPatch(e, { status: "ended" });
      if (a === "cancel") confirmSheet(tr("Cancel event"), tr("Everyone who RSVP'd sees it as cancelled."), tr("Cancel event"), true).then(function (ok) { if (ok) eventPatch(e, { status: "cancelled" }); });
      if (a === "delete") confirmSheet(tr("Delete event"), tr("This removes the event for everyone."), tr("Delete"), true).then(function (ok) {
        if (!ok) return;
        call("/" + S.sid + "/events/" + e.id, { method: "DELETE" }).then(function (res) {
          if (res.status !== 200) { toast(errText(res)); return; }
          S.events[S.sid] = (eventsList() || []).filter(function (x) { return x.id !== e.id; });
          loadEvents(S.sid);
        });
      });
    });
  }
  function eventWho(e) {
    var sheet = openSheet(sheetHead(e.name, tr("Who's coming")) + '<div class="vsrv-sheet-body" data-k="body"><div class="dmsgs-skel"><span></span><span></span></div></div>', "tall");
    call("/" + S.sid + "/events/" + e.id + "/rsvps").then(function (res) {
      var body = sheet.querySelector('[data-k="body"]');
      if (res.status !== 200) { body.innerHTML = '<p class="vsrv-note">' + esc(errText(res)) + "</p>"; return; }
      var list = res.body.rsvps || [];
      needCards(list.map(function (r) { return r.m; }));
      body.innerHTML = list.length ? list.map(function (r) {
        return '<button type="button" class="vsrv-mrow" data-vs="member" data-m="' + esc(r.m) + '">' + avatar(r.m, S.sid, "vsrv-ava sm") + '<span class="vsrv-mrow-txt"><span class="vsrv-mrow-name">' + esc(nameOf(r.m)) + '</span><span class="vsrv-mrow-act">' + esc(r.status === "going" ? tr("Going") : tr("Interested")) + "</span></span></button>";
      }).join("") : '<p class="vsrv-note">' + esc(tr("No one yet.")) + "</p>";
    });
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function toLocalInput(ts) { if (!ts) return ""; var d = new Date(ts); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function fromLocalInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v || ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime() : 0;
  }
  function eventEditSheet(e) {
    var chans = channelsOf().filter(function (c) { return c.kind !== "category" && has(Number(c.perms) || 0, P.VIEW); });
    var start = e ? e.startAt : Math.ceil((Date.now() + 3600000) / 1800000) * 1800000;
    var image = e && e.image ? "keep" : "";
    var sheet = openSheet(sheetHead(e ? tr("Edit event") : tr("Create event")) + '<div class="vsrv-sheet-body">' +
      '<label class="vsrv-field"><span>' + esc(tr("Event name")) + '</span><input type="text" maxlength="100" data-k="name" value="' + esc(e ? e.name : "") + '" autofocus></label>' +
      '<div class="vsrv-row2"><label class="vsrv-field"><span>' + esc(tr("Starts")) + '</span><input type="datetime-local" data-k="start" value="' + esc(toLocalInput(start)) + '"></label>' +
      '<label class="vsrv-field"><span>' + esc(tr("Ends (optional)")) + '</span><input type="datetime-local" data-k="end" value="' + esc(toLocalInput(e ? e.endAt : 0)) + '"></label></div>' +
      '<label class="vsrv-field"><span>' + esc(tr("Channel")) + '</span><select data-k="ch"><option value="">' + esc(tr("None")) + "</option>" + chans.map(function (c) { return '<option value="' + c.id + '"' + (e && e.channelId === c.id ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</select></label>" +
      '<label class="vsrv-field"><span>' + esc(tr("Location (optional)")) + '</span><input type="text" maxlength="100" data-k="loc" value="' + esc(e ? e.location : "") + '"></label>' +
      '<label class="vsrv-field"><span>' + esc(tr("Description")) + '</span><textarea rows="3" maxlength="1000" data-k="desc">' + esc(e ? e.description : "") + "</textarea></label>" +
      '<div class="vsrv-field"><span>' + esc(tr("Cover image")) + '</span><div class="vsrv-inline"><label class="vsrv-btn ghost sm"><input type="file" accept="image/*" data-k="img" hidden>' + esc(tr("Upload image")) + '</label><span class="vsrv-sub" data-k="imgname">' + esc(e && e.image ? tr("Image set") : "") + "</span>" +
      (e && e.image ? '<button type="button" class="vsrv-linkbtn" data-k="imgx">' + esc(tr("Remove")) + "</button>" : "") + "</div></div></div>" +
      '<footer class="vsrv-sheet-foot"><button type="button" class="vsrv-btn ghost" data-vs="close-sheet">' + esc(tr("Cancel")) + '</button><button type="button" class="vsrv-btn" data-k="go">' + esc(e ? tr("Save") : tr("Create event")) + "</button></footer>", "tall");
    var go = sheet.querySelector('[data-k="go"]');
    sheet.querySelector('[data-k="img"]').addEventListener("change", function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var label = sheet.querySelector('[data-k="imgname"]');
      label.textContent = tr("Uploading…");
      busy(go, true);
      uploadRaw(S.sid, "event", f).then(function (res) {
        busy(go, false);
        if (res.status !== 200 || !res.body.image) { label.textContent = ""; toast(errText(res)); return; }
        image = res.body.image.k;
        label.textContent = f.name || tr("Image set");
      });
    });
    sheet.addEventListener("click", function (ev) {
      if (ev.target.closest('[data-k="imgx"]')) { image = "none"; sheet.querySelector('[data-k="imgname"]').textContent = ""; }
    });
    go.addEventListener("click", function () {
      var name = sheet.querySelector('[data-k="name"]').value.trim();
      if (!name) { sheet.querySelector('[data-k="name"]').focus(); return; }
      var s = fromLocalInput(sheet.querySelector('[data-k="start"]').value);
      var en = fromLocalInput(sheet.querySelector('[data-k="end"]').value);
      if (!s) { toast(tr("Pick a start time.")); return; }
      if (en && en <= s) { toast(tr("The end has to be after the start.")); return; }
      var body = { name: name, startAt: s, endAt: en || 0, channelId: sheet.querySelector('[data-k="ch"]').value, location: sheet.querySelector('[data-k="loc"]').value.trim(), description: sheet.querySelector('[data-k="desc"]').value.trim() };
      if (image === "none") body.image = "";
      else if (image && image !== "keep") body.image = image;
      busy(go, true);
      call("/" + S.sid + "/events" + (e ? "/" + e.id : ""), { method: e ? "PATCH" : "POST", body: body }).then(function (res) {
        busy(go, false);
        if (res.status !== 200) { toast(errText(res)); return; }
        closeSheet();
        loadEvents(S.sid);
      });
    });
  }

  /* realtime for the phase 2 kinds; true when handled */
  function applyP2(sid, cid, e) {
    if (e.t === "thread" && e.th) {
      var th = storeThread(sid, e.th);
      delete threadMiss[th.id];
      var act = S.active[sid] || (S.active[sid] = []);
      var i = act.indexOf(th);
      if (!th.archived && i < 0) act.push(th);
      if (th.archived && i >= 0) act.splice(i, 1);
      if (th.rootId && S.msgs[th.parentId]) {
        var rm = S.msgs[th.parentId].find(function (x) { return x.id === th.rootId; });
        if (rm) { rm.th = Object.assign({}, e.th); saveChannel(th.parentId); }
      }
      var f = S.forum[th.parentId];
      if (f && f.list.indexOf(th) < 0 && !th.archived) { f.list.unshift(th); if (!th.starter && sid === S.sid && S.cid === th.parentId) loadForum(sid, th.parentId); }
      if (sid === S.sid) {
        if (S.cid === th.parentId) { if (f) paintForum(); else paintLog(); }
        if (S.cid === th.id) { var conv = el("vsrv-conv"); var head = conv && conv.querySelector(".vsrv-conv-head"); if (head) { var tmp = document.createElement("div"); tmp.innerHTML = convInner(); var nh = tmp.querySelector(".vsrv-conv-head"); if (nh) head.replaceWith(nh); } paintCompose(); }
        paintSide();
      }
      return true;
    }
    if (e.t === "thread_del") {
      var gone = S.threads[e.id];
      dropThread(sid, e.id);
      if (sid === S.sid) {
        if (S.cid === e.id) { toast(tr("This thread was deleted.")); location.hash = "#/messages/s/" + sid + (gone ? "/" + gone.parentId : ""); }
        else { paintForum(); paintLog(); paintSide(); }
      }
      return true;
    }
    if (e.t === "poll") {
      var list = S.msgs[cid];
      var tg = list && list.find(function (x) { return x.id === e.id; });
      if (tg && e.pl) { tg.pl = Object.assign({}, e.pl, { mine: (tg.pl && tg.pl.mine) || [] }); saveChannel(cid); if (cid === S.cid) paintLog(); }
      return true;
    }
    if (e.t === "event" || e.t === "event_del" || e.t === "rsvp") {
      var evs = S.events[sid];
      if (evs) {
        var at = -1;
        evs.forEach(function (x, j) { if (x.id === (e.ev ? e.ev.id : e.id)) at = j; });
        if (e.t === "event" && e.ev) { if (at >= 0) evs[at] = Object.assign({}, e.ev, { mine: evs[at].mine }); else evs.push(e.ev); }
        if (e.t === "event_del" && at >= 0) evs.splice(at, 1);
        if (e.t === "rsvp" && at >= 0) { evs[at].going = e.going; evs[at].interested = e.interested; }
        var st = srv(sid);
        if (st) st.events = evs.filter(function (x) { return x.status === "scheduled" || x.status === "active"; }).length;
      } else if (e.t !== "rsvp") loadServer(sid, true);
      if (sid === S.sid) { paintEventsSheet(); paintSide(); }
      return true;
    }
    return false;
  }

  /* rich presence */
  function myActivity() { return S.myAct || null; }
  function actOf(mid, row) {
    if (mid === me().mid) return myActivity();
    var a = (S.acts[S.sid] || {})[mid];
    if (a) return a;
    var m = row || (S.members[S.sid] || []).find(function (x) { return x.m === mid; });
    return m && m.playing && (S.online[S.sid] || {})[mid] ? { k: "playing", n: m.playing } : null;
  }
  function actText(a) {
    if (!a) return "";
    if (a.k === "playing") return tr("Playing {name}", { name: a.n });
    if (a.k === "listening") return tr("Listening to {name}", { name: a.n });
    if (a.k === "watching") return tr("Watching {name}", { name: a.n });
    return ((a.e ? a.e + " " : "") + (a.n || "")).trim();
  }
  function actIcon(a) { return a.k === "playing" ? "game" : a.k === "listening" ? "music" : a.k === "watching" ? "tv" : "smile"; }
  function computeActivity() {
    var g = root.ViktorychGames;
    try { if (g && g.busy && g.busy()) return { k: "playing", n: "ReGone" }; } catch (err) { /* games not loaded */ }
    var media = Array.prototype.slice.call(document.querySelectorAll("audio, video")).find(function (x) { return !x.paused && !x.ended && !x.muted && x.currentTime > 0; });
    if (media) {
      var md = null;
      try { md = navigator.mediaSession && navigator.mediaSession.metadata; } catch (err) { md = null; }
      var title = (md && md.title) || media.getAttribute("title") || media.getAttribute("aria-label") || "";
      if (title) return { k: media.tagName === "VIDEO" ? "watching" : "listening", n: String(title).slice(0, 64), d: String((md && md.artist) || "").slice(0, 96) };
    }
    var pres = root.ViktorychPresence;
    var mine = null;
    try { mine = pres && pres.myStatus ? pres.myStatus() : null; } catch (err) { mine = null; }
    if (mine && (mine.text || mine.emoji)) return { k: "custom", n: String(mine.text || "").slice(0, 64), e: String(mine.emoji || "").slice(0, 16) };
    return null;
  }
  function pushActivity() {
    if (S.mode !== "server") return;
    var a = computeActivity();
    var key = a ? [a.k, a.n, a.d || "", a.e || ""].join("|") : "";
    if (S.myActKey !== key) {
      S.myActKey = key;
      if (a) a.s = Date.now();
      S.myAct = a;
      paintSide();
      paintMembers();
    }
    if (S.sentAct === key || !S.socket || S.socket.readyState !== 1) return;
    S.sentAct = key;
    try { S.socket.send(JSON.stringify({ op: "activity", act: S.myAct })); } catch (err) { /* closed */ }
  }
  var actTimer = 0;
  function activitySoon() { clearTimeout(actTimer); actTimer = setTimeout(pushActivity, 400); }

  /* ---------- join page ---------- */
  function joinPage() {
    var info = S.inviteInfo && S.inviteInfo.code === S.invite ? S.inviteInfo : null;
    var body;
    if (!info) body = '<div class="dmsgs-skel" aria-busy="true"><span></span><span></span></div>';
    else if (info.error) body = '<div class="vsrv-join-card"><span class="vsrv-sicon vsrv-initials big">' + icon("compass") + "</span><h2>" + esc(tr("Invite invalid")) + "</h2><p>" + esc(errText({ status: 404, body: { error: info.error } })) + '</p><a class="vsrv-btn" href="#/messages">' + esc(tr("Back to Inbox")) + "</a></div>";
    else {
      var s = info.server || {};
      body = '<div class="vsrv-join-card">' + (s.banner ? '<img class="vsrv-join-banner" src="' + esc(s.banner) + '" alt="">' : "") + serverIcon(s, "vsrv-sicon big") +
        "<p>" + esc(tr("You've been invited to join")) + "</p><h2>" + esc(s.name || "") + "</h2>" +
        (s.description ? '<p class="vsrv-sub">' + esc(s.description) + "</p>" : "") +
        '<p class="vsrv-sub">' + esc(trn(s.memberCount || 0, "members")) + "</p>" +
        (info.member ? '<a class="vsrv-btn" href="#/messages/s/' + esc(s.id) + '">' + esc(tr("Open server")) + "</a>"
          : signedIn() ? '<button type="button" class="vsrv-btn" data-vs="accept-invite">' + esc(tr("Accept invite")) + "</button>"
          : '<button type="button" class="vsrv-btn" data-vs="sign-in">' + esc(tr("Sign in to join")) + "</button>") + "</div>";
    }
    return '<div class="dmsgs vsrv vsrv-join" id="vsrv-root">' + body + "</div>";
  }
  function loadInvite(code) {
    var base = api();
    if (!base) { S.inviteInfo = { code: code, error: "invalid" }; return Promise.resolve(); }
    var headers = token() ? { Authorization: "Bearer " + token() } : {};
    return fetch(base + "/v1/servers/invite/" + encodeURIComponent(code), { headers: headers, cache: "no-store" }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        S.inviteInfo = res.ok ? Object.assign({ code: code }, body) : { code: code, error: body.error || "invalid" };
      });
    }).catch(function () { S.inviteInfo = { code: code, error: "offline" }; }).then(function () {
      var r = rootEl();
      if (r && S.mode === "join") r.outerHTML = joinPage();
    });
  }
  function acceptInvite(btn) {
    busy(btn, true);
    call("/invite/" + encodeURIComponent(S.invite) + "/join", { method: "POST", body: {} }).then(function (res) {
      busy(btn, false);
      if (res.status !== 200) { toast(errText(res)); return; }
      loadList(true).then(function () { location.hash = "#/messages/s/" + res.body.serverId + (res.body.channelId ? "/" + res.body.channelId : ""); });
    });
  }

  /* ---------- events ---------- */
  function onClick(ev) {
    var t = ev.target;
    /* iOS only starts call audio inside a tap; any tap during a call retries it. */
    if (root.ViktorychVoice && root.ViktorychVoice.state().status !== "idle") root.ViktorychVoice.unlock();
    if (!t || !t.closest) return;
    var pick = t.closest("[data-pop]");
    if (pick) { ev.preventDefault(); choosePop(Number(pick.getAttribute("data-pop"))); return; }
    var b = t.closest("[data-vs]");
    if (!b) {
      var link = t.closest("a[data-close]");
      if (link) closeSheet(true);
      return;
    }
    if (!b.closest("#vsrv-root, #vsrv-inbox, .vsrv-sheet")) return;
    var a = b.getAttribute("data-vs");
    var id = b.getAttribute("data-id") || "";
    if (a === "files") return;
    ev.preventDefault();
    if (b.getAttribute("data-close")) closeSheet(true);
    switch (a) {
      case "close-sheet": closeSheet(); break;
      case "voice-join": voiceJoin(id); break;
      case "voice-leave": if (vv()) vv().leave(); break;
      case "voice-mute": voiceToggle("mute"); break;
      case "voice-deaf": voiceToggle("deaf"); break;
      case "voice-cam": voiceToggle("cam"); break;
      case "voice-screen": voiceToggle("screen"); break;
      case "voice-tile": voiceFocus(b.getAttribute("data-key") || ""); break;
      case "voice-peer": voicePeerMenu(b.getAttribute("data-m") || ""); break;
      case "voice-peer-mute": if (vv()) vv().setPeerMute(id, !(vv().state().peers[id] || {}).localMute); break;
      case "voice-mod-mute": voiceModerate(id, b.getAttribute("data-on") === "1" ? "unmute" : "mute"); break;
      case "voice-mod-kick": voiceModerate(id, "kick"); break;
      case "voice-open": location.hash = "#/messages/s/" + (vv() ? vv().state().sid + "/" + vv().state().cid : ""); break;
      case "create-sheet": createSheet(); break;
      case "join-sheet": joinSheet(); break;
      case "invite-sheet": closeSheet(true); inviteSheet(); break;
      case "server-menu": serverMenu(); break;
      case "settings": closeSheet(true); settingsSheet(); break;
      case "new-channel": closeSheet(true); newChannelSheet(id); break;
      case "channel-settings": channelSettingsSheet(id); break;
      case "notify-sheet": closeSheet(true); notifySheet(b.getAttribute("data-scope") || S.sid); break;
      case "modlog": closeSheet(true); modlogSheet(); break;
      case "nick": closeSheet(true); nickSheet(me().mid); break;
      case "leave":
        closeSheet(true);
        confirmSheet(tr("Leave server"), tr("You won't be able to rejoin unless you're invited again."), tr("Leave server"), true).then(function (ok) {
          if (!ok) return;
          call("/" + S.sid + "/leave", { method: "POST", body: {} }).then(function (res) {
            if (res.status !== 200) { toast(errText(res)); return; }
            lsSet("srv:" + S.sid, null);
            S.list = (S.list || []).filter(function (s) { return s.id !== S.sid; });
            lsSet("list", { servers: S.list, canCreate: S.canCreate });
            location.hash = "#/messages";
          });
        });
        break;
      case "toggle-cat": S.collapsed[id] = !S.collapsed[id]; lsSet("collapsed", S.collapsed); paintSide(); break;
      case "members-toggle":
        if (noMembersColumn()) { membersSheet(); break; }
        S.membersOpen = !S.membersOpen;
        lsSet("membersOpen", S.membersOpen);
        var r = rootEl();
        if (r) r.classList.toggle("members-open", S.membersOpen);
        b.classList.toggle("on", S.membersOpen);
        if (S.membersOpen) loadMembers(S.sid);
        break;
      case "more-members": loadMembers(S.sid, S.membersNext); break;
      case "member": memberSheet(b.getAttribute("data-m")); break;
      case "pins": pinsSheet(); break;
      case "search-sheet": searchSheet(); break;
      case "topic": var c = channel(S.cid); if (c) openSheet(sheetHead("#" + c.name) + '<div class="vsrv-sheet-body"><div class="vsrv-text">' + format(c.topic, S.sid) + "</div></div>", "small"); break;
      case "older": var list = (S.msgs[S.cid] || []).filter(function (m) { return !m.pending; }); if (list.length) loadMessages(S.sid, S.cid, { before: list[0].id }); break;
      case "jump": jump(b.getAttribute("data-c") || S.cid, id); break;
      case "expand": S.expanded[id] = !S.expanded[id]; paintLog(); break;
      case "spoiler": b.classList.add("open"); break;
      case "reply": startReply(id); break;
      case "reply-cancel": S.reply = null; paintCompose(true); break;
      case "reply-ping": if (S.reply) { S.reply.ping = S.reply.ping === false; paintCompose(true); } break;
      case "edit": startEdit(id); break;
      case "edit-save": saveEdit(); break;
      case "edit-cancel": cancelEdit(); break;
      case "delete": deleteMessage(id, false); break;
      case "mod-delete": deleteMessage(id, true); break;
      case "pin":
        var pm = msgById(id);
        if (pm) call("/" + S.sid + "/channels/" + S.cid + "/pins/" + id, { method: pm.p ? "DELETE" : "PUT" }).then(function (res) { if (res.status !== 200) toast(errText(res)); else { pm.p = pm.p ? 0 : 1; paintLog(); toast(pm.p ? tr("Pinned") : tr("Unpinned")); } });
        break;
      case "copy-text": var cm = msgById(id); if (cm) copy(plain(cm.b)); break;
      case "copy-link": copy(location.origin + location.pathname + "#/messages/s/" + S.sid + "/" + S.cid + "/" + id); break;
      case "msg-menu": messageMenu(id); break;
      case "react": toggleReaction(id, b.getAttribute("data-e")); break;
      case "react-pick": emojiPicker(function (key) { toggleReaction(id, key); }); break;
      case "emoji-pick":
        emojiPicker(function (key) {
          if (key.indexOf("c:") === 0) { var e = emojiById(key.slice(2)); if (e) insertText(":" + e.name + ": "); }
          else insertText(key);
        });
        break;
      case "send": submit(); break;
      case "file-x": S.files = S.files.filter(function (f) { return f.id !== id; }); paintCompose(); break;
      case "retry": var job = outbox().find(function (j) { return j.nonce === b.getAttribute("data-n"); }); if (job) { flushOne(job); } else toast(tr("This message can't be sent again.")); break;
      case "discard": dropPending(b.getAttribute("data-n")); break;
      case "accept-invite": acceptInvite(b); break;
      case "events": eventsSheet(); break;
      case "threads": threadsSheet(id || S.cid); break;
      case "thread-from": createThreadFrom(id); break;
      case "open-thread": var om = msgById(id); if (om && om.th) location.hash = "#/messages/s/" + S.sid + "/" + om.th.id; break;
      case "thread-menu": threadMenu(); break;
      case "forum-post": forumPostSheet(S.cid); break;
      case "forum-tag": S.forumTag[S.cid] = id; paintForum(); break;
      case "forum-archived": loadForum(S.sid, S.cid, true); break;
      case "forum-more": var fm = S.forum[S.cid]; if (fm && fm.next) loadForum(S.sid, S.cid, false, fm.next); break;
      case "compose-apps": appsMenu(); break;
      case "poll-vote": votePoll(id, Number(b.getAttribute("data-o"))); break;
      case "poll-clear": votePoll(id, -1); break;
      case "poll-end": endPoll(id); break;
      case "poll-voters": pollVoters(id); break;
      case "sign-in": if (root.ViktorychAccounts && root.ViktorychAccounts.enter) root.ViktorychAccounts.enter(); break;
      default: break;
    }
  }
  function noMembersColumn() {
    try { return !root.matchMedia("(min-width: 1100px)").matches; } catch (err) { return false; }
  }
  function membersSheet() {
    S.membersOpen = false;
    var r = rootEl();
    if (r) r.classList.remove("members-open");
    loadMembers(S.sid);
    var sheet = openSheet(sheetHead(tr("Members")) + '<div class="vsrv-sheet-body vsrv-members-sheet">' + membersInner() + "</div>", "tall");
    var body = sheet.querySelector(".vsrv-members-sheet");
    loadMembers(S.sid).then(function () { if (body.isConnected) body.innerHTML = membersInner(); });
  }
  function startReply(id) {
    var m = msgById(id);
    if (!m) return;
    S.reply = { id: id, c: S.cid, a: m.a, ping: true };
    paintCompose(true);
    var input = el("vsrv-input");
    if (input) input.focus();
  }
  function jump(cid, id) {
    if (cid !== S.cid) { location.hash = "#/messages/s/" + S.sid + "/" + cid + "/" + id; return; }
    S.jumpTo = id;
    if (!scrollToMessage(id)) loadMessages(S.sid, cid, { around: id });
  }

  function onInput(ev) {
    var t = ev.target;
    if (t.id === "vsrv-input") {
      S.drafts[S.cid] = t.value;
      saveDrafts();
      autosize(t);
      if (t.value) sendTyping();
      updatePop();
    } else if (t.id === "vsrv-edit") autosize(t);
  }
  var draftTimer = 0;
  function saveDrafts() { clearTimeout(draftTimer); draftTimer = setTimeout(function () { lsSet("drafts", S.drafts); }, 500); }
  function onKey(ev) {
    var t = ev.target;
    if (ev.key === "Escape" && sheetStack.length) { closeSheet(); return; }
    if (t.id === "vsrv-input") {
      var box = el("vsrv-pop");
      if (box && !box.hidden && pop.items.length) {
        if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
          ev.preventDefault();
          pop.at = (pop.at + (ev.key === "ArrowDown" ? 1 : pop.items.length - 1)) % pop.items.length;
          Array.prototype.forEach.call(box.children, function (c, i) { c.classList.toggle("on", i === pop.at); });
          return;
        }
        if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); choosePop(pop.at); return; }
        if (ev.key === "Escape") { box.hidden = true; pop.items = []; return; }
      }
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229 && !coarse()) { ev.preventDefault(); submit(); return; }
      if (ev.key === "ArrowUp" && !t.value && startEditLast()) { ev.preventDefault(); return; }
      if (ev.key === "Escape" && S.reply) { S.reply = null; paintCompose(true); }
    } else if (t.id === "vsrv-edit") {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); saveEdit(); }
      if (ev.key === "Escape") { ev.preventDefault(); cancelEdit(); }
    }
  }
  function onChange(ev) {
    var t = ev.target;
    if (t.matches && t.matches('[data-vs="files"]')) { addFiles(t.files); t.value = ""; }
  }
  function onPaste(ev) {
    if (!ev.target || ev.target.id !== "vsrv-input") return;
    var items = ev.clipboardData && ev.clipboardData.files;
    if (items && items.length) { ev.preventDefault(); addFiles(items); }
  }
  function onDrop(ev) {
    var conv = ev.target && ev.target.closest && ev.target.closest("#vsrv-conv");
    if (!conv) return;
    if (ev.type === "dragover") { if (ev.dataTransfer && Array.prototype.indexOf.call(ev.dataTransfer.types || [], "Files") >= 0) { ev.preventDefault(); conv.classList.add("drop"); } return; }
    if (ev.type === "dragleave") { conv.classList.remove("drop"); return; }
    conv.classList.remove("drop");
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) { ev.preventDefault(); addFiles(ev.dataTransfer.files); }
  }
  var press = null;
  function onTouchStart(ev) {
    var msg = ev.target.closest && ev.target.closest(".vsrv-msg[data-id]");
    if (!msg || ev.target.closest("a, button, video, audio, textarea, .vsrv-spoiler") || msg.classList.contains("pending") || msg.classList.contains("sys")) return;
    var touch = ev.touches && ev.touches[0];
    press = { id: msg.getAttribute("data-id"), x: touch ? touch.clientX : 0, y: touch ? touch.clientY : 0, timer: setTimeout(function () {
      if (!press) return;
      press.fired = true;
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) { /* no haptics */ } }
      messageMenu(press.id);
    }, 480) };
  }
  function onTouchMove(ev) {
    if (!press) return;
    var touch = ev.touches && ev.touches[0];
    if (touch && (Math.abs(touch.clientX - press.x) > 10 || Math.abs(touch.clientY - press.y) > 10)) { clearTimeout(press.timer); press = null; }
  }
  function onTouchEnd(ev) {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.fired) {
      if (ev.cancelable) ev.preventDefault();
      pressQuietUntil = Date.now() + 600;
    }
    press = null;
  }
  var pressQuietUntil = 0;
  function swallowPressClick(ev) {
    /* The click some browsers still send after a long-press must not hit what's under the finger. */
    if (Date.now() < pressQuietUntil && !(ev.target.closest && ev.target.closest(".vsrv-sheet"))) { ev.preventDefault(); ev.stopPropagation(); pressQuietUntil = 0; }
  }
  function onVisible() {
    if (document.visibilityState === "hidden") {
      if (S.socket) closeSocket();
      return;
    }
    if (S.mode === "server" && rootEl()) { connect(); catchUp(); loadServer(S.sid); flushOutbox(); }
    loadList();
  }

  var bound = false;
  function bindOnce() {
    if (bound) return;
    bound = true;
    S.drafts = lsGet("drafts", {});
    S.collapsed = lsGet("collapsed", {});
    var mo = lsGet("membersOpen", null);
    if (mo != null) S.membersOpen = !!mo;
    document.addEventListener("click", swallowPressClick, true);
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    document.addEventListener("change", onChange);
    document.addEventListener("paste", onPaste);
    ["dragover", "dragleave", "drop"].forEach(function (n) { document.addEventListener(n, onDrop); });
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("contextmenu", function (ev) {
      var msg = ev.target.closest && ev.target.closest("#vsrv-root .vsrv-msg[data-id]:not(.pending):not(.sys)");
      if (!msg || coarse() || ev.target.closest("a, img, video")) return;
      ev.preventDefault();
      messageMenu(msg.getAttribute("data-id"));
    });
    document.addEventListener("visibilitychange", onVisible);
    ["play", "pause", "ended"].forEach(function (n) { document.addEventListener(n, activitySoon, true); });
    setInterval(pushActivity, 15000);
    root.addEventListener("focus", onVisible);
    root.addEventListener("online", function () { connect(); flushOutbox(); catchUp(); loadList(true); });
    root.addEventListener("pageshow", onVisible);
    var pres = root.ViktorychPresence;
    if (pres && pres.onChannel) pres.onChannel(onAccountChannel);
    root.addEventListener("storage", function (ev) {
      if (ev.key === "viktorych-accounts-session" || ev.key === null) { S.list = null; S.servers = {}; }
    });
  }

  function mount(route) {
    bindOnce();
    var r = routeOf(route);
    if (!r) {
      if (S.mode === "server") closeSocket();
      S.mode = "";
      if (document.getElementById("vsrv-inbox")) loadList();
      return;
    }
    if (r.mode === "join") {
      closeSocket();
      if (!S.inviteInfo || S.inviteInfo.code !== r.code) loadInvite(r.code);
      return;
    }
    enter(r);
  }
  function enter(r) {
    var sid = r.sid;
    if (S.socketSid && S.socketSid !== sid) closeSocket();
    loadList();
    var ready = srv(sid) ? Promise.resolve(srv(sid)) : loadServer(sid);
    if (srv(sid)) loadServer(sid);
    ready.then(function () {
      if (S.sid !== sid) return;
      if (!S.cid && !narrow()) {
        var last = lsGet("last:" + sid, "");
        var pickId = last && channel(last) && has(chanPerms(last), P.VIEW) ? last : firstChannel(sid);
        if (pickId) { location.replace("#/messages/s/" + sid + "/" + pickId); return; }
      }
      paintAll();
      openChannel();
    });
    if (S.cid && srv(sid)) openChannel();
    if (S.membersOpen && !narrow()) loadMembers(sid);
    loadActive(sid);
    connect();
    var log = el("vsrv-log");
    if (log) { bindLog(log); log.scrollTop = S.keepScroll ? log.scrollHeight - S.keepScroll : log.scrollHeight; S.keepScroll = 0; }
    var input = el("vsrv-input");
    if (input) { autosize(input); if (!coarse() && !sheetStack.length) { try { input.focus({ preventScroll: true }); } catch (err) { /* old Safari */ } } }
  }
  var opened = "";
  function openChannel() {
    if (!S.cid) return;
    var c = channel(S.cid);
    if (!c) {
      var want = S.cid;
      if (srv(S.sid) && /^[a-f0-9]{16}$/.test(want) && !threadMiss[want]) loadThread(S.sid, want).then(function (t) { if (S.cid === want) { paintAll(); if (t) openChannel(); } });
      return;
    }
    if (opened !== S.cid) {
      opened = S.cid;
      S.readMark = channelUnread(c, S.sid) ? c.lastRead || "" : "";
      lsSet("last:" + S.sid, S.cid);
      if (S.socket && S.socket.readyState === 1) { try { S.socket.send(JSON.stringify({ op: "view", c: viewId(S.cid) })); } catch (err) { /* closed */ } }
    }
    if (c.kind === "forum") { loadForum(S.sid, S.cid); return; }
    if (c.kind === "voice") { mountStage(); return; }
    if (S.jump) { S.jumpTo = S.jump; S.jump = ""; loadMessages(S.sid, S.cid, { around: S.jumpTo }); return; }
    openChannelData(S.sid, S.cid);
  }
  function syncFromHash() {
    var r = routeOf();
    var host = rootEl();
    if (!r || r.mode !== "server" || !host || S.mode !== "server" || host.classList.contains("vsrv-join")) return false;
    var sameServer = r.sid === S.sid;
    if (!sameServer) { closeSocket(); S.reply = null; S.edit = ""; S.gone = ""; opened = ""; }
    if (S.edit) S.edit = "";
    var input = el("vsrv-input");
    if (input && S.cid) S.drafts[S.cid] = input.value;
    S.sid = r.sid; S.cid = r.cid; S.jump = r.jump || "";
    host.setAttribute("data-sid", S.sid);
    host.classList.toggle("has-channel", !!S.cid);
    var conv = el("vsrv-conv");
    if (conv) conv.setAttribute("data-c", "");
    if (!srv(S.sid)) { var cached = lsGet("srv:" + S.sid, null); if (cached) S.servers[S.sid] = cached; }
    if (!sameServer) { S.membersNext = ""; }
    paintRail(); paintSide(); paintMembers();
    if (conv) { conv.setAttribute("data-c", S.cid); paintConv(); }
    enter(r);
    try { root.scrollTo(0, 0); } catch (err) { /* old browsers */ }
    return true;
  }

  function reset() {
    closeSocket();
    S.list = null; S.servers = {}; S.msgs = {}; S.cards = {}; S.members = {};
    wipeCache();
  }

  root.ViktorychServers = {
    owns: owns,
    page: page,
    mount: mount,
    syncFromHash: syncFromHash,
    listHtml: inboxHtml,
    reset: reset,
    _test: { format: format, plain: plain, composeText: composeText, mergeMessages: mergeMessages, state: S, emojiOnly: emojiOnly, firstLink: firstLink, routeOf: routeOf, serverBadge: serverBadge }
  };
})();
