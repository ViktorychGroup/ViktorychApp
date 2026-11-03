/* The NZlay forum as an X-style Community (#/communities/nzlay).
   Topics and posts are read live from NZlay through the Worker pool
   (/v1/nzlay/forum, cached a few minutes at the edge); NZlay sends no CORS
   headers, so the browser cannot read it directly. Nothing is mirrored or
   stored: this page keeps the last answer in memory only. Media is
   hotlinked at its original size. Signing in, posting and replying go
   through NzlayKeys (nzlay-keys.js): one tap is one post.
   ReGone links (players online and Play, Top 100 ranks and linked players
   on author names, joining a room a thread is about) sit behind the
   nzlay_forum_regone switch, and each also honours its own ReGone switch. */
(function () {
  "use strict";
  var OFF_KEY = "viktorychapp-server-off";
  var FORUM = "https://nzlay.com/forums";
  var BANNER = "https://nzlay.com/images/screenshots/BeGone_FreeOnlineGame_0.jpg";
  var ICON = "https://nzlay.com/public/core_file/83/67ea8bdd7834066294e1421197f1f0d2.png";
  var FEED_TTL = 2 * 60 * 1000;
  var CUT = 280;
  var MAX_TEXT = 5000;

  var state = {
    feed: null, feedAt: 0, feedLoading: false, feedError: false,
    cats: {}, catLoading: {},
    threads: {}, threadLoading: {},
    tab: "top",
    badges: {}, badgesAsked: {},
    online: null, onlineAt: 0,
    rooms: null, roomsAt: 0,
    sheet: null, sending: false, sheetNote: "", sheetUrl: "",
    pending: {}
  };

  function tr(key, vars) { return window.t ? window.t(key, vars) : String(key).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; }); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function serverOff(name) {
    try {
      var list = JSON.parse(localStorage.getItem(OFF_KEY) || "[]");
      return Array.isArray(list) && list.indexOf(name) >= 0;
    } catch (err) { return false; }
  }
  function regone(part) { return !serverOff("nzlay_forum_regone") && (!part || !serverOff(part)); }
  function keys() { return window.NzlayKeys && window.NzlayKeys.enabled() ? window.NzlayKeys : null; }
  function appSignedIn() {
    var a = window.ViktorychAccounts;
    try { return !!(a && a.session && a.session() && a.session().token); } catch (err) { return false; }
  }
  function call(path, opts) {
    var a = window.ViktorychAccounts;
    if (!a || typeof a.call !== "function") return Promise.resolve(null);
    var next = Object.assign({}, opts || {});
    try { var s = a.session && a.session(); if (s && s.token && !next.token) next.token = s.token; } catch (err) { /* signed out */ }
    return Promise.resolve(a.call(path, next)).catch(function () { return null; });
  }
  function render() {
    var c = window.ViktorychCommunities;
    if (c && typeof c.requestRender === "function") c.requestRender();
  }
  function toast(text) {
    var c = window.ViktorychCommunities;
    if (c && typeof c.toast === "function") c.toast(text);
  }
  function lang() { return (document.documentElement && document.documentElement.lang) || "en"; }

  var P = {
    reply: "M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z",
    views: "M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z",
    share: "M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z",
    external: "M18 19H6c-.55 0-1-.45-1-1V6c0-.55.45-1 1-1h5V3H6c-1.66 0-3 1.34-3 3v12c0 1.66 1.34 3 3 3h12c1.66 0 3-1.34 3-3v-5h-2v5c0 .55-.45 1-1 1zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
    close: "M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z",
    community: "M7.501 19.917L7.471 21H.472l.029-1.027c.184-6.618 3.736-8.977 7-8.977.963 0 1.95.212 2.87.672-.444.478-.851 1.03-1.212 1.656-.507-.204-1.054-.329-1.658-.329-2.767 0-4.57 2.223-4.938 6.004H7.56c-.023.302-.05.599-.059.917zm15.998.056L23.528 21H9.472l.029-1.027c.184-6.618 3.736-8.977 7-8.977s6.816 2.358 7 8.977zM21.437 19c-.367-3.781-2.17-6.004-4.938-6.004s-4.57 2.223-4.938 6.004h9.875zm-4.938-9c-.799 0-1.527-.279-2.116-.73-.836-.64-1.384-1.638-1.384-2.77 0-1.93 1.567-3.5 3.5-3.5s3.5 1.57 3.5 3.5c0 1.132-.548 2.13-1.384 2.77-.589.451-1.317.73-2.116.73zm-1.5-3.5c0 .827.673 1.5 1.5 1.5s1.5-.673 1.5-1.5-.673-1.5-1.5-1.5-1.5.673-1.5 1.5zM7.5 3C9.433 3 11 4.57 11 6.5S9.433 10 7.5 10 4 8.43 4 6.5 5.567 3 7.5 3zm0 2C6.673 5 6 5.673 6 6.5S6.673 8 7.5 8 9 7.327 9 6.5 8.327 5 7.5 5z",
    pin: "M7 4.5C7 3.12 8.12 2 9.5 2h5C15.88 2 17 3.12 17 4.5v5.26L20.12 16H13v5l-1 2-1-2v-5H3.88L7 9.76V4.5z",
    play: "M8 5v14l11-7z",
    shield: "M12 1.75l8.5 3.4v6.1c0 5.3-3.6 9.5-8.5 11-4.9-1.5-8.5-5.7-8.5-11v-6.1zm0 2.15L5.5 6.5v4.75c0 4.2 2.7 7.6 6.5 8.95 3.8-1.35 6.5-4.75 6.5-8.95V6.5z",
    back: "M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z",
    plus: "M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"
  };
  function svg(name) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + P[name] + '"/></svg>'; }

  /* ---------- time and text ---------- */
  function when(iso) {
    var t = Date.parse(iso || "");
    if (!isFinite(t)) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return tr("{n}s", { n: s });
    if (s < 3600) return tr("{n}m", { n: Math.floor(s / 60) });
    if (s < 86400) return tr("{n}h", { n: Math.floor(s / 3600) });
    var d = new Date(t);
    var opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    try { return d.toLocaleDateString(lang(), opts); } catch (err) { return d.toDateString(); }
  }
  function fullWhen(iso) {
    var t = Date.parse(iso || "");
    if (!isFinite(t)) return "";
    var d = new Date(t);
    try {
      return d.toLocaleTimeString(lang(), { hour: "numeric", minute: "2-digit" }) + " · " + d.toLocaleDateString(lang(), { month: "short", day: "numeric", year: "numeric" });
    } catch (err) { return d.toString(); }
  }
  function count(n) {
    n = Number(n) || 0;
    if (n < 1000) return String(n);
    try { return new Intl.NumberFormat(lang(), { notation: "compact", maximumFractionDigits: 1 }).format(n); } catch (err) { return String(n); }
  }
  function linkify(text) {
    var out = "";
    var at = 0;
    var re = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
    var m;
    var src = String(text || "");
    while ((m = re.exec(src))) {
      out += esc(src.slice(at, m.index));
      var url = m[0].replace(/^http:\/\//, "https://");
      out += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer ugc" data-nzf-stop>' + esc(m[0].replace(/^https?:\/\//, "").slice(0, 40)) + (m[0].length > 48 ? "…" : "") + "</a>";
      at = m.index + m[0].length;
    }
    return (out + esc(src.slice(at))).replace(/\n/g, "<br>");
  }
  function profileUrl(name) { return "https://nzlay.com/profile/" + encodeURIComponent(name || ""); }
  function threadHash(id) { return "#/communities/nzlay/" + encodeURIComponent(id); }
  function topicUrl(t) { return t && t.url ? t.url : FORUM + "/topic/" + t.id; }

  /* ---------- loading ---------- */
  function loadFeed(force) {
    if (state.feedLoading) return;
    if (!force && state.feed && Date.now() - state.feedAt < FEED_TTL) return;
    state.feedLoading = true;
    call("/v1/nzlay/forum").then(function (res) {
      state.feedLoading = false;
      if (res && res.status === 200 && res.ok && Array.isArray(res.topics)) {
        state.feed = res;
        state.feedAt = Date.now();
        state.feedError = false;
        askBadges(res.topics.map(function (t) { return t.starter && t.starter.author && t.starter.author.name; }));
      } else state.feedError = !state.feed;
      render();
    });
  }
  function loadCategory(id) {
    if (state.catLoading[id] || (state.cats[id] && Date.now() - state.cats[id].at < FEED_TTL)) return;
    state.catLoading[id] = true;
    call("/v1/nzlay/forum?category=" + encodeURIComponent(id)).then(function (res) {
      state.catLoading[id] = false;
      if (res && res.status === 200 && res.ok) {
        state.cats[id] = { at: Date.now(), topics: res.topics || [] };
        askBadges((res.topics || []).map(function (t) { return t.starter && t.starter.author && t.starter.author.name; }));
      } else state.cats[id] = { at: Date.now(), topics: [], error: true };
      render();
    });
  }
  function loadThread(id, pageNo) {
    var key = id + ":" + pageNo;
    if (state.threadLoading[key]) return;
    state.threadLoading[key] = true;
    call("/v1/nzlay/forum/topic/" + encodeURIComponent(id) + (pageNo > 1 ? "?page=" + pageNo : "")).then(function (res) {
      state.threadLoading[key] = false;
      var t = state.threads[id] || { pages: {}, at: 0 };
      if (res && res.status === 200 && res.ok) {
        t.title = res.title;
        t.category = res.category;
        t.url = res.url;
        t.pageCount = res.pages || 1;
        t.pages[pageNo] = res.posts || [];
        t.at = Date.now();
        t.error = false;
        askBadges((res.posts || []).map(function (p) { return p.author && p.author.name; }));
      } else if (!t.pages[1]) t.error = res && res.status === 404 ? "missing" : "error";
      state.threads[id] = t;
      render();
    });
  }
  function askBadges(names) {
    if (!regone() || !appSignedIn()) return;
    var want = [];
    (names || []).forEach(function (n) { if (n && !state.badgesAsked[n] && want.indexOf(n) < 0) want.push(n); });
    if (!want.length) return;
    want = want.slice(0, 40);
    want.forEach(function (n) { state.badgesAsked[n] = true; });
    call("/v1/games/regone/forum-badges?names=" + encodeURIComponent(want.join(","))).then(function (res) {
      if (res && res.status === 200 && res.ok && res.badges) {
        Object.keys(res.badges).forEach(function (k) { state.badges[k] = res.badges[k]; });
        render();
      }
    });
  }
  function loadReGone() {
    if (!regone() || !appSignedIn()) return;
    if (regone("regone_online") && Date.now() - state.onlineAt > 60000) {
      state.onlineAt = Date.now();
      call("/v1/games/regone/online").then(function (res) {
        var n = res && res.status === 200 && res.ok ? Number(res.online) : null;
        if (n !== state.online) { state.online = n; render(); }
      });
    }
    if (regone("regone_rooms") && Date.now() - state.roomsAt > 5 * 60 * 1000) {
      state.roomsAt = Date.now();
      call("/v1/games/regone/rooms").then(function (res) {
        if (res && res.status === 200 && Array.isArray(res.rooms)) {
          state.rooms = res.rooms.concat(Array.isArray(res.clans) ? res.clans : []).map(function (r) { return r && r.name; }).filter(Boolean);
          render();
        }
      });
    }
  }

  /* ---------- pieces ---------- */
  function avatar(src, name) {
    if (src && /^https:\/\//.test(src)) return '<img class="ava" src="' + esc(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
    return '<span class="ava initials">' + esc(String(name || "?").slice(0, 1).toUpperCase()) + "</span>";
  }
  function badgeHtml(author, moderator) {
    var out = "";
    if (moderator || (author && /moderator|admin/i.test(author.role || ""))) out += '<span class="nzf-mod" title="' + esc(author.role || tr("Moderator")) + '">' + svg("shield") + "</span>";
    var b = regone() && author ? state.badges[author.name] : null;
    if (b && b.rank && regone("regone_leaderboard")) out += '<a class="nzf-rank" href="#/games" data-nzf-stop title="' + esc(tr("ReGone Top 100: #{rank}", { rank: b.rank })) + '">#' + esc(b.rank) + "</a>";
    if (b && b.person && b.person.handle && regone("regone_profile_stats")) out += '<a class="nzf-linked" href="#/@' + encodeURIComponent(b.person.handle) + '" data-nzf-stop title="' + esc(tr("Linked ReGone player: {name}", { name: b.person.name || b.person.handle })) + '">' + avatar(b.person.avatar, b.person.name) + "</a>";
    return out;
  }
  function byline(author, at, href, moderator) {
    var name = (author && author.name) || tr("NZlay member");
    var shown = author && author.name && (typeof window !== "undefined" ? window.ViktorychNick : null) ? window.ViktorychNick.name("nzlay", author.name, name) : name;
    return '<div class="byline">' +
      '<a class="name" href="' + esc(profileUrl(name)) + '" target="_blank" rel="noopener noreferrer" data-nzf-stop>' + esc(shown) + "</a>" + badgeHtml(author || {}, moderator) +
      '<a class="handle" href="' + esc(profileUrl(name)) + '" target="_blank" rel="noopener noreferrer" data-nzf-stop>@' + esc(name) + "</a>" +
      (at ? '<span class="dot">·</span><a class="time" href="' + esc(href) + '" title="' + esc(fullWhen(at)) + '"><time datetime="' + esc(at) + '">' + esc(when(at)) + "</time></a>" : "") +
      "</div>";
  }
  function mediaHtml(list) {
    var items = (list || []).filter(function (m) { return m && /^https:\/\//.test(m.url || ""); }).slice(0, 4);
    if (!items.length) return "";
    var cls = items.length === 1 ? "m1" : items.length === 2 ? "m2" : items.length === 3 ? "m3" : "m4";
    return '<div class="media ' + cls + ' nzf-media">' + items.map(function (m) {
      return '<a class="tile" href="' + esc(m.url) + '" target="_blank" rel="noopener noreferrer" data-nzf-stop><img src="' + esc(m.url) + '" alt="' + esc(m.alt || "") + '" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>';
    }).join("") + "</div>";
  }
  function roomFor(text) {
    if (!regone("regone_rooms") || !state.rooms || !state.rooms.length) return "";
    var low = String(text || "").toLowerCase();
    var best = "";
    state.rooms.forEach(function (name) {
      var n = String(name).toLowerCase();
      if (n.length >= 6 && low.indexOf(n) >= 0 && n.length > best.length) best = name;
    });
    return best;
  }
  function roomChip(text) {
    var room = roomFor(text);
    if (!room) return "";
    return '<div class="nzf-room"><span class="nzf-room-dot" aria-hidden="true"></span><span>' + esc(tr("ReGone room: {room}", { room: room })) + '</span><span role="button" tabindex="0" class="nzf-join" data-gs-join-room="' + esc(room) + '">' + esc(tr("Join")) + "</span></div>";
  }
  function quoteHtml(q) {
    if (!q || !(q.text || q.name)) return "";
    return '<div class="nzf-quote">' + (q.name ? '<div class="nzf-quote-by"><b>' + esc(q.name) + '</b><span>@' + esc(q.name) + "</span></div>" : "") + (q.text ? '<div class="nzf-quote-text">' + esc(q.text) + "</div>" : "") + "</div>";
  }
  function actionBtn(cls, icon, label, n, attrs) {
    return '<button class="action ' + cls + '" type="button" aria-label="' + esc(label) + '" data-tooltip="' + esc(label) + '"' + (attrs || "") + '><span class="ic">' + svg(icon) + "</span>" + (n ? '<span class="count">' + esc(count(n)) + "</span>" : "") + "</button>";
  }
  function actionLink(cls, icon, label, n, href, external) {
    return '<a class="action ' + cls + '" href="' + esc(href) + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : "") + ' data-nzf-stop aria-label="' + esc(label) + '" data-tooltip="' + esc(label) + '"><span class="ic">' + svg(icon) + "</span>" + (n ? '<span class="count">' + esc(count(n)) + "</span>" : "") + "</a>";
  }
  function catTitle(id) {
    var cats = (state.feed && state.feed.categories) || [];
    for (var i = 0; i < cats.length; i++) if (cats[i].id === id) return cats[i].title;
    return "";
  }

  function topicCard(t) {
    var s = t.starter || { author: t.lastBy || {}, text: "", media: [] };
    var href = threadHash(t.id);
    var text = String(s.text || "");
    var long = text.length > CUT;
    var shown = long ? text.slice(0, CUT).replace(/\s+\S*$/, "") + "…" : text;
    var cat = catTitle(t.categoryId);
    var line = t.sticky
      ? '<div class="repost-line nzf-line">' + svg("pin") + "<span>" + esc(tr("Pinned")) + (cat ? " · " + esc(cat) : "") + "</span></div>"
      : (cat ? '<div class="repost-line nzf-line">' + svg("community") + "<span>" + esc(cat) + "</span></div>" : "");
    var replyAct = keys() ? actionBtn("reply", "reply", tr("Reply"), t.replies, ' data-nzf="reply" data-topic="' + esc(t.id) + '" data-slug="' + esc(t.slug || "") + '" data-name="' + esc((s.author && s.author.name) || "") + '"') : actionLink("reply", "reply", tr("Replies"), t.replies, href);
    return '<article class="post nzf-post" data-nzf-open="' + esc(href) + '">' + line +
      '<div class="post-row"><a class="nzf-ava" href="' + esc(profileUrl(s.author && s.author.name)) + '" target="_blank" rel="noopener noreferrer" data-nzf-stop>' + avatar(s.author && s.author.avatar, s.author && s.author.name) + "</a>" +
      '<div class="post-main">' + byline(s.author, s.at || t.lastAt, href, s.moderator) +
        '<div class="post-title nzf-title" dir="auto">' + esc(t.title) + "</div>" +
        (shown ? '<div class="post-text nzf-text" dir="auto">' + linkify(shown) + "</div>" : "") +
        (long ? '<a class="show-more nzf-more" href="' + esc(href) + '">' + esc(tr("Show more")) + "</a>" : "") +
        mediaHtml(s.media) + roomChip(t.title + "\n" + text) +
        '<div class="actions nzf-actions">' + replyAct +
          actionLink("views", "views", tr("Views"), t.views, href) +
          actionBtn("share", "share", tr("Share"), 0, ' data-nzf="share" data-url="' + esc(topicUrl(t)) + '"') +
          actionLink("open", "external", tr("Open on NZlay"), 0, topicUrl(t), true) +
        "</div></div></div></article>";
  }

  /* ---------- community page ---------- */
  function sortTopics(list, tab) {
    var out = list.slice();
    if (tab === "latest") {
      out.sort(function (a, b) { return String((b.starter && b.starter.at) || b.lastAt).localeCompare(String((a.starter && a.starter.at) || a.lastAt)); });
    } else {
      var now = Date.now();
      var score = function (t) {
        var age = Math.max(1, (now - (Date.parse(t.lastAt) || now)) / 36e5);
        return ((Number(t.replies) || 0) * 4 + (Number(t.views) || 0) / 25 + 1) / Math.pow(age + 2, 0.6);
      };
      out.sort(function (a, b) { return score(b) - score(a); });
    }
    return out;
  }
  function topicsFor(tab) {
    var feed = state.feed;
    if (!feed) return null;
    var m = /^cat:(\d+)$/.exec(tab);
    if (!m) return sortTopics(feed.topics || [], tab);
    var id = Number(m[1]);
    if (!feed.more) return sortTopics((feed.topics || []).filter(function (t) { return t.categoryId === id; }), "latest");
    var got = state.cats[id];
    if (!got) { loadCategory(id); return null; }
    return sortTopics(got.topics, "latest");
  }
  function tabsHtml() {
    var tab = function (id, label) {
      return '<button class="tab' + (state.tab === id ? " on" : "") + '" type="button" role="tab" aria-selected="' + (state.tab === id ? "true" : "false") + '" data-nzf="tab" data-tab="' + esc(id) + '"><span>' + esc(label) + "</span></button>";
    };
    var cats = (state.feed && state.feed.categories) || [];
    return '<div class="tabs nzf-tabs" role="tablist">' + tab("top", tr("Top")) + tab("latest", tr("Latest")) +
      cats.map(function (c) { return tab("cat:" + c.id, c.title); }).join("") + "</div>";
  }
  function regoneRow() {
    if (!regone()) return "";
    var online = regone("regone_online") && state.online != null
      ? '<span class="nzf-online"><i aria-hidden="true"></i>' + esc(tr("{n} playing now", { n: count(state.online) })) + "</span>"
      : '<span class="nzf-online quiet">' + esc(tr("ReGone")) + "</span>";
    return '<div class="nzf-regone">' + online +
      (regone("regone_leaderboard") ? '<a class="nzf-chip" href="#/games">' + esc(tr("Top 100")) + "</a>" : "") +
      '<a class="nzf-play" href="#/games/regone">' + svg("play") + "<span>" + esc(tr("Play")) + "</span></a></div>";
  }
  function composerRow() {
    var k = keys();
    if (!k) return "";
    k.boot().then(function () { if (!state.bootPainted) { state.bootPainted = true; render(); } });
    if (!k.signedIn()) {
      return '<div class="nzf-signin"><p>' + esc(tr("Sign in with your NZlay account to post and reply here.")) + '</p><a class="nzf-pill" href="#/settings/keys/nzlay">' + esc(tr("Sign in to NZlay")) + "</a></div>";
    }
    var me = k.me() || {};
    return '<button type="button" class="nzf-compose-row" data-nzf="new-topic">' + avatar(me.avatar, me.name) + '<span class="nzf-compose-hint">' + esc(tr("Start a thread")) + '</span><span class="nzf-pill">' + esc(tr("Post")) + "</span></button>";
  }
  function heroHtml(feed) {
    var forum = (feed && feed.forum) || {};
    var members = Number(forum.members) || 0;
    return '<section class="cm-hero nzf-hero">' +
      '<img class="cm-hero-banner" alt="" src="' + esc(forum.banner || BANNER) + '" referrerpolicy="no-referrer">' +
      '<div class="cm-hero-body"><div class="cm-hero-bar">' +
        '<img class="cm-hero-avatar nzf-hero-avatar" alt="" src="' + esc(forum.icon || ICON) + '" referrerpolicy="no-referrer">' +
        '<div class="cm-hero-actions">' +
          '<button class="cm-icon-btn" type="button" data-nzf="share" data-url="' + esc(FORUM) + '" aria-label="' + esc(tr("Share")) + '">' + svg("share") + "</button>" +
          '<a class="cm-btn-join nzf-open" href="' + esc(FORUM) + '" target="_blank" rel="noopener noreferrer"><span>' + esc(tr("Open on NZlay")) + "</span></a>" +
        "</div></div>" +
        '<h1 class="cm-hero-title">' + esc(tr("NZlay Forums")) + "</h1>" +
        '<div class="cm-hero-meta">' +
          '<div class="cm-facepile"><span class="cm-face-dot d1"></span><span class="cm-face-dot d2"></span><span class="cm-face-dot d3"></span></div>' +
          (members ? "<span><b>" + esc(count(members)) + "</b> " + esc(tr("Members")) + "</span>" : "") +
          '<span class="cm-sep">·</span><a class="cm-forum-link" href="' + esc(FORUM) + '" target="_blank" rel="noopener noreferrer">nzlay.com ' + svg("external") + "</a>" +
        "</div>" +
        '<p class="cm-hero-about">' + esc(tr("The official NZlay forum: ReGone news, help, clans and everything else. Read live from nzlay.com.")) + "</p>" +
        regoneRow() +
      "</div></section>";
  }
  function communityPage(h) {
    loadFeed(false);
    loadReGone();
    var feed = state.feed;
    var head = h.head(tr("NZlay Forums"), "#/communities", '<button class="cm-icon-btn" type="button" data-nzf="share" data-url="' + esc(FORUM) + '" aria-label="' + esc(tr("Share")) + '">' + svg("share") + "</button>");
    if (!feed) {
      if (state.feedError) {
        return head + heroHtml(null) + '<div class="empty"><h2>' + esc(tr("NZlay isn’t answering right now.")) + '</h2><button class="retry" type="button" data-nzf="retry">' + esc(tr("Retry")) + "</button></div>";
      }
      return head + heroHtml(null) + '<div class="reply-empty">' + esc(tr("Loading")) + "</div>";
    }
    var list = topicsFor(state.tab);
    var body = list == null
      ? '<div class="reply-empty">' + esc(tr("Loading")) + "</div>"
      : list.length ? list.map(topicCard).join("") : '<div class="empty"><h2>' + esc(tr("No posts yet")) + "</h2></div>";
    return head + '<div class="nzf">' + heroHtml(feed) + tabsHtml() + composerRow() + body +
      '<p class="cm-footer-note">' + esc(tr("Posts come straight from nzlay.com. Replies you send go to NZlay as you.")) + "</p></div>" + sheetHtml();
  }

  /* ---------- thread page ---------- */
  function postArticle(p, t, opts) {
    var focus = !!opts.focus;
    var href = threadHash(t.id);
    var name = (p.author && p.author.name) || "";
    var replying = opts.replyingTo ? '<div class="replying">' + esc(tr("Replying to")) + ' <a href="' + esc(profileUrl(opts.replyingTo)) + '" target="_blank" rel="noopener noreferrer" data-nzf-stop>@' + esc(opts.replyingTo) + "</a></div>" : "";
    var replyBtn = keys() ? actionBtn("reply", "reply", tr("Reply"), focus ? 0 : 0, ' data-nzf="reply" data-topic="' + esc(t.id) + '" data-slug="' + esc(slugOf(t)) + '" data-quote="' + esc(focus ? "" : p.id) + '" data-name="' + esc(name) + '"') : actionLink("reply", "reply", tr("Reply"), 0, t.url || FORUM, true);
    var actions = '<div class="actions nzf-actions' + (focus ? " status-actions" : "") + '">' + replyBtn +
      actionBtn("share", "share", tr("Share"), 0, ' data-nzf="share" data-url="' + esc((t.url || FORUM) + "/view/post_id/" + p.id) + '"') +
      actionLink("open", "external", tr("Open on NZlay"), 0, (t.url || FORUM) + "/view/post_id/" + p.id, true) + "</div>";
    var ava = '<a class="nzf-ava" href="' + esc(profileUrl(name)) + '" target="_blank" rel="noopener noreferrer" data-nzf-stop>' + avatar(p.author && p.author.avatar, name) + "</a>";
    var text = String(p.text || "");
    if (focus) {
      return '<article class="post nzf-post nzf-focus' + (p.pending ? " nzf-pending" : "") + '" data-post="' + esc(p.id) + '">' +
        '<div class="post-row nzf-focus-head">' + ava + '<div class="post-main">' + byline(p.author, "", href, p.moderator) + "</div></div>" +
        '<div class="nzf-focus-body">' +
          '<h2 class="post-title nzf-focus-title" dir="auto">' + esc(t.title || "") + "</h2>" +
          (text ? '<div class="post-text nzf-text">' + linkify(text) + "</div>" : "") +
          mediaHtml(p.media) + roomChip((t.title || "") + "\n" + text) +
          '<div class="nzf-focus-meta"><time datetime="' + esc(p.at || "") + '">' + esc(fullWhen(p.at)) + "</time>" + (p.edited ? '<span class="dot">·</span><span>' + esc(tr("Edited")) + "</span>" : "") +
            (t.views ? '<span class="dot">·</span><span><b>' + esc(count(t.views)) + "</b> " + esc(tr("Views")) + "</span>" : "") + "</div>" +
          (t.replies != null ? '<div class="nzf-focus-stats"><span><b>' + esc(count(t.replies)) + "</b> " + esc(tr("Replies")) + "</span></div>" : "") +
          actions +
        "</div></article>";
    }
    var avaCol = opts.continues ? '<div class="ava-col">' + ava + '<div class="thread-line"></div></div>' : ava;
    return '<article class="post nzf-post' + (opts.continues ? " continues" : "") + (p.pending ? " nzf-pending" : "") + '" data-post="' + esc(p.id) + '">' +
      '<div class="post-row">' + avaCol + '<div class="post-main">' + byline(p.author, p.at, href, p.moderator) + replying +
        (text ? '<div class="post-text nzf-text">' + linkify(text) + "</div>" : "") +
        (opts.parentShown ? "" : quoteHtml(p.quote)) +
        mediaHtml(p.media) + roomChip(text) +
        (p.pending ? '<p class="nzf-pending-note">' + esc(tr("Sent to NZlay")) + "</p>" : "") +
        actions + "</div></div></article>";
  }
  function slugOf(t) {
    var m = /\/forums\/topic\/\d+\/([a-z0-9-]+)/.exec((t && t.url) || "");
    return m ? m[1] : "topic";
  }
  function threadPage(route, h) {
    var id = String(route.post || "").split("/")[0];
    if (!/^\d{1,9}$/.test(id)) return h.head(tr("Post"), "#/communities/nzlay") + '<div class="empty"><h2>' + esc(tr("That post isn’t here.")) + "</h2></div>";
    loadReGone();
    var t = state.threads[id];
    if (!t || (!t.pages[1] && !t.error)) {
      loadThread(id, 1);
      return h.head(tr("Post"), "#/communities/nzlay") + '<div class="reply-empty">' + esc(tr("Loading")) + "</div>";
    }
    if (Date.now() - t.at > FEED_TTL && !state.threadLoading[id + ":1"]) loadThread(id, 1);
    if (t.error && !t.pages[1]) {
      return h.head(tr("Post"), "#/communities/nzlay") + '<div class="empty"><h2>' + esc(t.error === "missing" ? tr("That post isn’t here.") : tr("NZlay isn’t answering right now.")) + '</h2><button class="retry" type="button" data-nzf="retry-thread" data-id="' + esc(id) + '">' + esc(tr("Retry")) + "</button></div>";
    }
    var feedTopic = ((state.feed && state.feed.topics) || []).filter(function (x) { return String(x.id) === id; })[0] || {};
    var info = { id: id, title: t.title, url: t.url, views: feedTopic.views, replies: feedTopic.replies, categoryId: t.category && t.category.id };
    var all = [];
    Object.keys(t.pages).map(Number).sort(function (a, b) { return a - b; }).forEach(function (n) { all = all.concat(t.pages[n]); });
    (state.pending[id] || []).forEach(function (p) { if (!all.some(function (x) { return x.id === p.id; })) all.push(p); });
    var first = all[0];
    var rest = all.slice(1);
    var starter = first && first.author ? first.author.name : "";
    var html = first ? postArticle(first, info, { focus: true }) : "";
    var composer = keys() && keys().signedIn()
      ? '<button type="button" class="nzf-compose-row nzf-reply-row" data-nzf="reply" data-topic="' + esc(id) + '" data-slug="' + esc(slugOf(info)) + '" data-name="' + esc(starter) + '">' + avatar((keys().me() || {}).avatar, (keys().me() || {}).name) + '<span class="nzf-compose-hint">' + esc(tr("Post your reply")) + '</span><span class="nzf-pill">' + esc(tr("Reply")) + "</span></button>"
      : (keys() ? '<div class="nzf-signin"><p>' + esc(tr("Sign in with your NZlay account to post and reply here.")) + '</p><a class="nzf-pill" href="#/settings/keys/nzlay">' + esc(tr("Sign in to NZlay")) + "</a></div>" : "");
    html += composer;
    rest.forEach(function (p, i) {
      var prev = i > 0 ? rest[i - 1] : null;
      var next = rest[i + 1];
      var parentShown = !!(prev && p.quote && p.quote.name && prev.author && prev.author.name === p.quote.name);
      var continues = !!(next && next.quote && next.quote.name && next.quote.name === (p.author && p.author.name));
      var replyingTo = parentShown ? "" : (p.quote && p.quote.name) || starter;
      html += postArticle(p, info, { replyingTo: replyingTo, continues: continues, parentShown: parentShown });
    });
    var loaded = Object.keys(t.pages).length;
    var more = t.pageCount > loaded
      ? '<button class="more-replies nzf-more-replies" type="button" data-nzf="more" data-id="' + esc(id) + '" data-page="' + (loaded + 1) + '">' + esc(tr("Show more replies")) + "</button>"
      : "";
    var cat = t.category ? '<a class="nzf-crumb" href="#/communities/nzlay" data-nzf="tab-link" data-tab="cat:' + esc(t.category.id) + '">' + svg("community") + "<span>" + esc(tr("NZlay Forums")) + " · " + esc(t.category.title) + "</span></a>" : "";
    return h.head(tr("Post"), "#/communities/nzlay") + '<div class="nzf nzf-thread">' + cat + html + more + "</div>" + sheetHtml();
  }

  /* ---------- composer sheet ---------- */
  function sheetHtml() {
    var s = state.sheet;
    if (!s) return "";
    var k = keys();
    var me = (k && k.me()) || {};
    var cats = (state.feed && state.feed.categories) || [];
    var isTopic = s.kind === "topic";
    var catSel = isTopic ? '<label class="nzf-field"><span>' + esc(tr("Category")) + '</span><select name="category">' + cats.map(function (c) {
      return '<option value="' + esc(c.id) + '" data-slug="' + esc(c.slug) + '"' + (String(s.categoryId) === String(c.id) ? " selected" : "") + ">" + esc(c.title) + "</option>";
    }).join("") + "</select></label>" + '<input class="nzf-title-input" name="title" maxlength="120" required placeholder="' + esc(tr("Title")) + '" aria-label="' + esc(tr("Title")) + '" value="' + esc(s.title || "") + '">' : "";
    var note = state.sheetNote ? '<div class="nzf-sheet-note" role="alert"><p>' + esc(state.sheetNote) + "</p>" + (state.sheetUrl ? '<a class="nzf-pill" href="' + esc(state.sheetUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(tr("Finish on NZlay")) + "</a>" : "") + "</div>" : "";
    return '<div class="modal-back nzf-back" data-nzf="close"><form class="modal nzf-sheet" role="dialog" aria-modal="true" aria-label="' + esc(isTopic ? tr("Start a thread") : tr("Reply")) + '" data-nzf-form="' + (isTopic ? "topic" : "reply") + '">' +
      '<div class="nzf-sheet-head"><button type="button" class="icon-btn" data-nzf="close" aria-label="' + esc(tr("Close")) + '">' + svg("close") + '</button><span class="grow"></span>' +
      '<button type="submit" class="nzf-pill"' + (state.sending ? " disabled" : "") + ">" + esc(state.sending ? tr("Posting…") : isTopic ? tr("Post") : tr("Reply")) + "</button></div>" +
      (s.name && !isTopic ? '<div class="replying nzf-sheet-replying">' + esc(tr("Replying to")) + " <b>@" + esc(s.name) + "</b></div>" : "") +
      '<div class="nzf-sheet-body">' + avatar(me.avatar, me.name) + '<div class="nzf-sheet-main">' + catSel +
        '<textarea name="text" maxlength="' + MAX_TEXT + '" required placeholder="' + esc(isTopic ? tr("What’s happening in ReGone?") : tr("Post your reply")) + '" aria-label="' + esc(isTopic ? tr("Start a thread") : tr("Post your reply")) + '">' + esc(s.text || "") + "</textarea>" +
      "</div></div>" + note +
      '<div class="nzf-sheet-foot"><span class="nzf-sheet-as">' + esc(me.name ? tr("Posts to NZlay as {name}", { name: me.name }) : tr("Posts to NZlay")) + '</span><span class="nzf-count" data-nzf-count>' + esc(String((s.text || "").length) + "/" + MAX_TEXT) + "</span></div>" +
      "</form></div>";
  }
  function openSheet(data) {
    var k = keys();
    if (!k) return;
    k.boot().then(function () {
      if (!k.signedIn()) { location.hash = "#/settings/keys/nzlay"; return; }
      state.sheet = data;
      state.sheetNote = "";
      state.sheetUrl = "";
      render();
      setTimeout(function () {
        var el = document.querySelector(".nzf-sheet textarea, .nzf-sheet .nzf-title-input");
        var first = document.querySelector(".nzf-sheet .nzf-title-input") || el;
        if (first) first.focus();
      }, 30);
    });
  }
  function copyText(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return false; }); } catch (err) { /* no clipboard */ }
    return Promise.resolve(false);
  }
  function send(form) {
    var k = keys();
    var s = state.sheet;
    if (!k || !s || state.sending) return;
    var text = String(form.elements.text.value || "").trim();
    s.text = form.elements.text.value;
    if (!text) return;
    var payload;
    if (s.kind === "topic") {
      var sel = form.elements.category;
      var opt = sel && sel.options[sel.selectedIndex];
      s.title = form.elements.title.value;
      s.categoryId = sel ? sel.value : "";
      if (!String(s.title).trim()) return;
      payload = { categoryId: Number(sel.value), slug: opt ? opt.getAttribute("data-slug") : "", title: String(s.title).trim(), text: text };
    } else {
      var th = state.threads[s.topicId];
      payload = { topicId: Number(s.topicId), slug: s.slug || "topic", quoteId: s.quoteId ? Number(s.quoteId) : 0, page: th && th.pageCount ? th.pageCount : 1, text: text };
    }
    state.sending = true;
    state.sheetNote = "";
    state.sheetUrl = "";
    render();
    k.post(s.kind === "topic" ? "topic" : "reply", payload).then(function (res) {
      state.sending = false;
      var r = res.result;
      if (r === "posted") {
        if (s.kind !== "topic") {
          var me = k.me() || {};
          var list = state.pending[s.topicId] || (state.pending[s.topicId] = []);
          list.push({ id: res.postId || "pending-" + Date.now(), pending: true, author: { name: me.name || "", avatar: me.avatar || "" }, at: new Date().toISOString(), text: text, media: [], quote: s.quoteId && s.name ? { name: s.name, text: "" } : null });
          setTimeout(function () { var th2 = state.threads[s.topicId]; if (th2) loadThread(s.topicId, th2.pageCount || 1); }, 4000);
        } else {
          state.feedAt = 0;
          setTimeout(function () { loadFeed(true); }, 4000);
        }
        state.sheet = null;
        toast(tr("Posted to NZlay"));
      } else if (r === "captcha") {
        state.sheetNote = tr("NZlay wants to check that you’re a person. Your text is copied; finish on NZlay.");
        state.sheetUrl = res.url || FORUM;
        copyText(text);
      } else if (r === "needs_login") {
        state.sheetNote = tr("NZlay signed you out. Sign in again.");
        state.sheetUrl = "";
        state.sheet.needsLogin = true;
      } else if (r === "wait") {
        state.sheetNote = tr("Wait {n} s before posting again.", { n: res.wait || 30 });
      } else if (r === "limited") {
        state.sheetNote = tr("Too many posts for now. Try again later.");
      } else if (r === "not_allowed") {
        state.sheetNote = tr("NZlay doesn’t let this account post here.");
        state.sheetUrl = res.url || "";
      } else if (r === "rejected" && res.errors && res.errors.length) {
        state.sheetNote = res.errors.join(" ");
      } else {
        state.sheetNote = tr("Couldn’t post to NZlay. Your text is still here.");
        state.sheetUrl = res.url || "";
      }
      render();
    });
  }

  /* ---------- events ---------- */
  document.addEventListener("click", function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    var act = t.closest("[data-nzf]");
    if (act) {
      var what = act.getAttribute("data-nzf");
      if (what === "close") {
        if (act.classList.contains("nzf-back") && t.closest(".nzf-sheet")) return;
        event.preventDefault();
        if (state.sheet && state.sheet.needsLogin) { state.sheet = null; location.hash = "#/settings/keys/nzlay"; return; }
        state.sheet = null; state.sheetNote = ""; render(); return;
      }
      if (what === "tab") { event.preventDefault(); state.tab = act.getAttribute("data-tab") || "top"; render(); return; }
      if (what === "tab-link") { state.tab = act.getAttribute("data-tab") || "top"; return; }
      if (what === "retry") { event.preventDefault(); state.feedError = false; loadFeed(true); render(); return; }
      if (what === "retry-thread") { event.preventDefault(); var rid = act.getAttribute("data-id"); delete state.threads[rid]; render(); return; }
      if (what === "more") { event.preventDefault(); loadThread(act.getAttribute("data-id"), Number(act.getAttribute("data-page")) || 2); act.disabled = true; return; }
      if (what === "share") {
        event.preventDefault();
        event.stopPropagation();
        var url = act.getAttribute("data-url") || FORUM;
        if (navigator.share && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || "")) { navigator.share({ url: url }).catch(function () { /* closed */ }); return; }
        copyText(url).then(function (ok) { toast(ok ? tr("Link copied") : url); });
        return;
      }
      if (what === "new-topic") {
        event.preventDefault();
        var m = /^cat:(\d+)$/.exec(state.tab);
        openSheet({ kind: "topic", categoryId: m ? m[1] : (((state.feed && state.feed.categories) || [])[0] || {}).id, text: "", title: "" });
        return;
      }
      if (what === "reply") {
        event.preventDefault();
        event.stopPropagation();
        openSheet({ kind: "reply", topicId: act.getAttribute("data-topic"), slug: act.getAttribute("data-slug"), quoteId: act.getAttribute("data-quote") || "", name: act.getAttribute("data-name") || "", text: "" });
        return;
      }
    }
    if (t.closest("[data-nzf-stop], a, button, [data-gs-join-room], input, textarea, select, .nzf-sheet")) return;
    var card = t.closest("[data-nzf-open]");
    if (card) {
      var sel = window.getSelection && window.getSelection();
      if (sel && String(sel).length) return;
      location.hash = card.getAttribute("data-nzf-open");
    }
  });
  document.addEventListener("submit", function (event) {
    var form = event.target && event.target.closest ? event.target.closest("[data-nzf-form]") : null;
    if (!form) return;
    event.preventDefault();
    send(form);
  });
  document.addEventListener("input", function (event) {
    var t = event.target;
    if (!t || !t.closest || !t.closest(".nzf-sheet") || !state.sheet) return;
    if (t.name === "text") {
      state.sheet.text = t.value;
      var c = document.querySelector("[data-nzf-count]");
      if (c) c.textContent = t.value.length + "/" + MAX_TEXT;
    }
    if (t.name === "title") state.sheet.title = t.value;
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.sheet) { state.sheet = null; render(); }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && event.target && event.target.closest && event.target.closest(".nzf-sheet")) {
      event.preventDefault();
      send(event.target.closest("form"));
    }
  });

  function page(route, helpers) {
    var h = helpers || {};
    if (!h.head) h.head = function (title) { return '<div class="topbar"><div class="page-head"><div class="head-text grow"><h1>' + esc(title) + "</h1></div></div></div>"; };
    if (route && route.post) return threadPage(route, h);
    return communityPage(h);
  }

  window.ViktorychNzlayForum = {
    page: page,
    enabled: function () { return !serverOff("nzlay_forum"); },
    row: { name: "nzlay", title: "NZlay Forums", type: "nzlay", subscribers: 0, icon: ICON, banner: BANNER, url: FORUM },
    _state: state
  };
})();
