/* Games. The iframe is created only on a play page and stays outside the
   shell so a repaint does not reload it. Play time stays in this browser. */
(function () {
  var STORE = "viktorychapp-games-v1";
  var PLAY = "https://nzlay.com/ReGone/game/index.html";
  var ORIGINAL = "https://nzlay.com/pages/ReGone";
  var CREDIT = "ReGone · via NZlay";
  var BACK = "M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z";
  var HEART = "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z";
  var HEART_ON = "M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z";
  var FULL = "M4 9V4h5v2H6v3H4zm10-5h5v5h-2V6h-3V4zM6 15H4v5h5v-2H6v-3zm12 0h2v5h-5v-2h3v-3z";
  var PAD = "M8 8.5h8c1.9 0 3.5 1.3 3.9 3.1l.7 3.6c.2 1.1-.6 2.1-1.7 2.1-.5 0-1-.2-1.3-.6L16.4 15H7.6l-1.2 1.7c-.3.4-.8.6-1.3.6-1.1 0-1.9-1-1.7-2.1l.7-3.6C4.5 9.8 6.1 8.5 8 8.5zm.2 1.7c-1.1 0-2 .8-2.2 1.8l-.7 3.6c-.1.4.2.7.6.7.2 0 .3-.1.4-.2l1.3-1.6h7.8l1.3 1.6c.1.1.2.2.4.2.4 0 .7-.3.6-.7l-.7-3.6c-.2-1-1.1-1.8-2.2-1.8H8.2zM9 11.6h1.1v1.1h1.1v1.1H10.1v1.1H9v-1.1H7.9v-1.1H9v-1.1zm5.6.9a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7zm1.7-.9a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7z";
  var GAMES = [{
    id: "regone",
    name: "ReGone",
    play: PLAY,
    original: ORIGINAL
  }];
  var BEAT_MS = 60 * 1000;
  var CLOSE = "M10.59 12L4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z";
  var ROTATE = "M16.48 2.52c3.27 1.55 5.61 4.72 5.97 8.48h1.5C23.44 4.84 18.29 0 12 0l-.66.03 3.81 3.81 1.33-1.32zm-6.25-.77a1.49 1.49 0 0 0-2.12 0L1.75 8.11a1.49 1.49 0 0 0 0 2.12l12.02 12.02c.59.59 1.54.59 2.12 0l6.36-6.36c.59-.59.59-1.54 0-2.12L10.23 1.75zm4.6 19.44L2.81 9.17l6.36-6.36 12.02 12.02-6.36 6.36zM7.52 21.48C4.25 19.94 1.91 16.76 1.55 13H.05C.56 19.16 5.71 24 12 24l.66-.03-3.81-3.81-1.33 1.32z";
  var clock = 0;
  var beatTimer = 0;
  var beatMs = 0;
  var wakeLock = null;
  var playing = false;
  var chromeTimer = 0;
  var padTimer = 0;
  var board = null;
  var boardTab = "time";
  var clockAt = 0;
  var clockId = "";
  var failTimer = 0;
  var mini = false;
  function gs() {
    return window.ViktorychGameSocial || null;
  }

  var FORUM_ICON = "M7.501 19.917L7.471 21H.472l.029-1.027c.184-6.618 3.736-8.977 7-8.977.963 0 1.95.212 2.87.672-.444.478-.851 1.03-1.212 1.656-.507-.204-1.054-.329-1.658-.329-2.767 0-4.57 2.223-4.938 6.004H7.56c-.023.302-.05.599-.059.917zm15.998.056L23.528 21H9.472l.029-1.027c.184-6.618 3.736-8.977 7-8.977s6.816 2.358 7 8.977zM21.437 19c-.367-3.781-2.17-6.004-4.938-6.004s-4.57 2.223-4.938 6.004h9.875z";
  function serverOff(name) {
    try {
      var list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
      return Array.isArray(list) && list.indexOf(name) >= 0;
    } catch (err) { return false; }
  }
  /* A link from the Games page back to the forum community, behind the
     forum switch and the ReGone-links switch. */
  function forumLink() {
    if (serverOff("nzlay_forum") || serverOff("nzlay_forum_regone")) return "";
    return '<section class="games-rail games-forum"><h2>' + esc(tr("Community")) + '</h2><a class="games-forum-card" href="#/communities/nzlay"><span class="games-forum-ico">' + svg(FORUM_ICON) + '</span><span class="games-forum-copy"><b>' + esc(tr("NZlay Forums")) + '</b><span>' + esc(tr("News, help, clans and the players behind ReGone.")) + '</span></span><span class="games-forum-go">' + svg("M16.586 11H3v2h13.586l-5.043 5.04 1.414 1.42L20.414 12l-7.457-7.46-1.414 1.42z") + '</span></a></section>';
  }

  function tr(key, vars) {
    return window.t ? window.t(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function svg(path) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
  }
  function gameById(id) {
    for (var i = 0; i < GAMES.length; i++) if (GAMES[i].id === id) return GAMES[i];
    return null;
  }
  function readAll() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORE) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  function writeAll(data) {
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (err) { /* this device is full */ }
  }
  function stat(id) {
    var row = readAll()[id] || {};
    return { ms: Number(row.ms) || 0, last: Number(row.last) || 0, fav: !!row.fav, streak: Number(row.streak) || 0, best: Number(row.best) || 0 };
  }
  function patch(id, next) {
    var all = readAll();
    var row = all[id] || {};
    if (next.ms != null) row.ms = next.ms;
    if (next.last != null) row.last = next.last;
    if (next.fav != null) row.fav = !!next.fav;
    if (next.streak != null) row.streak = next.streak;
    if (next.best != null) row.best = next.best;
    if (next.day != null) row.day = next.day;
    all[id] = row;
    writeAll(all);
    return row;
  }
  function flush() {
    if (!clockId || !clockAt || document.hidden) {
      clockAt = Date.now();
      return;
    }
    var now = Date.now();
    var row = stat(clockId);
    var spent = Math.max(0, now - clockAt);
    patch(clockId, { ms: row.ms + spent, last: row.last || now });
    beatMs += spent;
    clockAt = now;
  }
  function accounts() {
    var api = window.ViktorychAccounts;
    var token = api && api.token && api.token();
    return api && api.call && token ? { api: api, token: String(token) } : null;
  }
  function call(path, opts) {
    var acct = accounts();
    if (!acct) return Promise.resolve(null);
    var next = { token: acct.token };
    Object.keys(opts || {}).forEach(function (key) { next[key] = opts[key]; });
    return Promise.resolve(acct.api.call(path, next)).catch(function () { return null; });
  }
  /* Play time goes to the server about once a minute, only while the game
     is open and on screen. It earns points and keeps the streak. */
  function beat() {
    flush();
    var id = clockId;
    var ms = Math.min(BEAT_MS, Math.round(beatMs));
    if (!id || ms < 1000) return;
    beatMs = 0;
    tellWorker(true);
    call("/v1/games/play", { method: "POST", body: { gameId: id, ms: ms, tz: -new Date().getTimezoneOffset() } }).then(function (res) {
      if (!res || res.status !== 200) return;
      if (Array.isArray(res.achievements) && res.achievements.length && gs()) gs().celebrate(res.achievements);
      patch(id, { streak: Number(res.streak) || 0, best: Number(res.bestStreak) || 0, day: String(new Date().toISOString().slice(0, 10)) });
    });
  }
  function startClock(id) {
    clockId = id;
    clockAt = Date.now();
    beatMs = 0;
    if (!beatTimer) beatTimer = setInterval(beat, BEAT_MS);
    if (clock) return;
    clock = setInterval(flush, 5000);
  }
  function stopClock() {
    flush();
    if (clockId) beat();
    if (clock) clearInterval(clock);
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = 0;
    clock = 0;
    clockId = "";
    clockAt = 0;
  }
  function duration(ms) {
    var min = Math.floor((Number(ms) || 0) / 60000);
    if (min < 1) return "";
    var hours = Math.floor(min / 60);
    var rest = min % 60;
    if (!hours) return rest + tr("time.m");
    return hours + tr("time.h") + " " + rest + tr("time.m");
  }
  function when(ms) {
    if (!ms || !window.SI18n || !window.SI18n.relTime) return "";
    return window.SI18n.relTime(new Date(ms).toISOString());
  }
  function appName() {
    return window.SI18n && window.SI18n.productName ? window.SI18n.productName("app") : "ViktorychApp";
  }
  function shareText() {
    var path = location.pathname || "/";
    if (/\/index\.html$/i.test(path)) path = path.slice(0, -"index.html".length);
    if (!path.endsWith("/")) path += "/";
    return tr("Playing ReGone on {app}", { app: appName() }) + "\n" + location.origin + path + "#/games/regone";
  }
  function head(title, backHref) {
    var back = backHref ? '<a class="icon-btn" href="' + esc(backHref) + '" aria-label="' + esc(tr("Back")) + '">' + svg(BACK) + "</a>" : "";
    return '<div class="topbar tall"><div class="mhead"><button class="m-ava" type="button" data-act="drawer" aria-label="' + esc(tr("Menu")) + '"><span class="ava initials">Y</span></button></div><div class="page-head">' + back + '<div class="head-text grow"><h1>' + esc(title) + "</h1></div></div></div>";
  }
  function heartBtn(id, on) {
    return '<button class="game-heart' + (on ? " on" : "") + '" type="button" data-game-fav="' + esc(id) + '" aria-pressed="' + (on ? "true" : "false") + '" aria-label="' + esc(on ? tr("Remove from favorites") : tr("Favorite")) + '">' + svg(on ? HEART_ON : HEART) + "</button>";
  }
  function card(item) {
    var row = stat(item.id);
    var played = duration(row.ms);
    var seen = when(row.last);
    var meta = [tr("Web shooter"), seen, played].filter(Boolean).join(" · ");
    return '<article class="game-card"><a class="game-open" href="#/games/' + esc(item.id) + '"><span class="game-art">' + svg(PAD) + '</span>' + (item.id === "regone" && gs() ? gs().tileChipHtml() : "") + '<span class="game-copy"><span class="game-name">' + esc(item.name) + '</span><span class="game-meta">' + esc(meta) + '</span></span></a>' + heartBtn(item.id, row.fav) + '</article>';
  }
  function rail(title, items, empty) {
    var body = items.length ? '<div class="games-row">' + items.map(card).join("") + "</div>" : '<p class="games-empty">' + esc(empty) + "</p>";
    return '<section class="games-rail"><h2>' + esc(title) + "</h2>" + body + "</section>";
  }
  function minutes(ms) {
    var min = Math.floor((Number(ms) || 0) / 60000);
    if (min < 60) return min + tr("time.m");
    return Math.floor(min / 60) + tr("time.h") + " " + (min % 60) + tr("time.m");
  }
  function boardRows() {
    if (!board || !board.people) return [];
    var list = board.people.slice();
    if (boardTab === "streak") list.sort(function (a, b) { return b.streak - a.streak || b.bestStreak - a.bestStreak || b.weekMs - a.weekMs; });
    else list.sort(function (a, b) { return b.weekMs - a.weekMs || b.totalMs - a.totalMs; });
    return list;
  }
  function boardInner() {
    if (!accounts()) return '<p class="games-empty">' + esc(tr("Sign in to see your friends’ play time.")) + "</p>";
    if (!board) return '<p class="games-empty">' + esc(tr("Loading")) + "</p>";
    var tab = function (id, label) {
      return '<button class="tab' + (boardTab === id ? " on" : "") + '" type="button" role="tab" aria-selected="' + (boardTab === id ? "true" : "false") + '" data-game-board-tab="' + id + '"><span>' + esc(label) + "</span></button>";
    };
    var rows = boardRows();
    var friendCount = rows.filter(function (p) { return !p.me; }).length;
    var items = rows.map(function (p, i) {
      var metric = boardTab === "streak" ? tr("{n}-day streak", { n: p.streak }) : minutes(p.weekMs);
      var ava = p.avatar ? '<img class="ava" src="' + esc(p.avatar) + '" alt="" loading="lazy">' : '<span class="ava initials">' + esc(String(p.name || p.handle || "?").charAt(0).toUpperCase()) + "</span>";
      var live = p.playing ? '<span class="games-live">' + esc(tr("Playing now")) + "</span>" : "";
      var invite = p.me ? "" : '<button class="outline games-invite" type="button" data-gs-invite="' + esc(p.publicId) + '" data-gs-name="' + esc(p.name || "") + '">' + esc(tr("Invite")) + "</button>";
      return '<li class="games-person"><span class="games-rank">' + (i + 1) + "</span>" + ava + '<span class="games-who"><span class="games-pname">' + esc(p.me ? tr("You") : p.name) + "</span>" + live + '</span><span class="games-metric">' + esc(metric) + "</span>" + invite + "</li>";
    }).join("");
    var empty = friendCount ? "" : '<p class="games-empty">' + esc(tr("Add friends to compete on play time and streaks.")) + "</p>";
    return '<div class="tabs games-tabs" role="tablist" aria-label="' + esc(tr("Friends leaderboard")) + '">' + tab("time", tr("Play time this week")) + tab("streak", tr("Streak")) + '</div><ol class="games-people">' + items + "</ol>" + empty;
  }
  function boardSection() {
    return '<section class="games-rail games-board"><h2>' + esc(tr("Friends leaderboard")) + '</h2><div data-games-board>' + boardInner() + "</div></section>";
  }
  function paintBoard() {
    var el = document.querySelector("[data-games-board]");
    if (el) el.innerHTML = boardInner();
  }
  function loadBoard(force) {
    if (!accounts()) return;
    if (!force && board && Date.now() - board.at < 60000) return;
    call("/v1/games/board?game=regone").then(function (res) {
      if (!res || res.status !== 200 || !Array.isArray(res.people)) return;
      board = { at: Date.now(), people: res.people };
      var me = res.people.filter(function (p) { return p.me; })[0];
      if (me) patch("regone", { streak: me.streak, best: me.bestStreak });
      paintBoard();
    });
  }
  function streakLine() {
    var row = stat("regone");
    if (!row.streak && !row.best) return "";
    return '<p class="games-streak">' + esc(tr("{n}-day streak", { n: row.streak })) + (row.best > row.streak ? " · " + esc(tr("Best: {n}", { n: row.best })) : "") + "</p>";
  }
  function hub() {
    setTimeout(function () { loadBoard(false); }, 0);
    var social = gs();
    var tabs = social ? social.hubTabsHtml() : "";
    if (social && social.tab() === "top") return tabs + social.topHtml();
    var recent = GAMES.filter(function (item) { return stat(item.id).last > 0; }).sort(function (a, b) { return stat(b.id).last - stat(a.id).last; });
    var favs = GAMES.filter(function (item) { return stat(item.id).fav; });
    return tabs + (social ? social.hubHtml() : "") + rail(tr("Recently played"), recent, tr("Nothing played yet.")) +
      rail(tr("Favourites"), favs, tr("No favourites yet.")) +
      '<section class="games-rail"><h2>' + esc(tr("Games")) + '</h2>' + streakLine() + (tvPad() ? '<div class="games-tvpad">' + tvPadLink("games-pad-play") + '<p class="games-empty">' + esc(tr("Xbox, PlayStation and other controllers work in the TV app.")) + "</p></div>" : "") + '<div class="games-grid">' + GAMES.map(card).join("") + "</div></section>" +
      boardSection() +
      forumLink();
  }
  function page(route) {
    if (gs()) setTimeout(function () { gs().handleRoute(route); }, 0);
    if (route && route.game) {
      var item = gameById(route.game);
      if (!item) return head(tr("Games"), "#/games") + '<div class="empty"><h2>' + esc(tr("That game isn’t here.")) + "</h2></div>";
      return head(item.name, "#/games") + '<div class="game-stage"></div>';
    }
    return head(tr("Games")) + '<div class="games">' + hub() + "</div>";
  }
  function hostEl() {
    return document.getElementById("game-host");
  }
  function paintChrome() {
    var host = hostEl();
    if (!host) return;
    var on = stat("regone").fav;
    var fav = host.querySelector("[data-game-fav]");
    if (fav) {
      fav.classList.toggle("on", on);
      fav.setAttribute("aria-pressed", on ? "true" : "false");
      fav.setAttribute("aria-label", on ? tr("Remove from favorites") : tr("Favorite"));
      fav.innerHTML = svg(on ? HEART_ON : HEART);
    }
    var full = host.querySelector("[data-game-full]");
    if (full) {
      var open = document.fullscreenElement === host;
      full.setAttribute("aria-label", open ? tr("Exit full screen") : tr("Full screen"));
    }
  }
  function place() {
    var host = hostEl();
    var stage = document.querySelector(".game-stage");
    if (!host || host.hidden || mini) return;
    if (document.fullscreenElement === host || host.classList.contains("immersive")) return;
    if (!stage) return;
    var rect = stage.getBoundingClientRect();
    var z = parseFloat(document.documentElement.style.zoom);
    var scale = z > 0 ? z : 1;
    host.style.top = Math.round(rect.top / scale) + "px";
    host.style.left = Math.round(rect.left / scale) + "px";
    host.style.width = Math.max(0, Math.round(rect.width / scale)) + "px";
    host.style.height = Math.max(0, Math.round(rect.height / scale)) + "px";
  }
  function fail() {
    var host = hostEl();
    if (!host || host.classList.contains("is-loaded")) return;
    host.classList.add("is-failed");
  }
  function ensureFrame(host) {
    var slot = host.querySelector(".game-frame");
    if (!slot || slot.querySelector("iframe")) return;
    host.classList.remove("is-loaded", "is-failed");
    var frame = document.createElement("iframe");
    frame.title = "ReGone";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-pointer-lock allow-orientation-lock");
    frame.setAttribute("allow", "fullscreen; autoplay; gamepad; screen-wake-lock");
    frame.addEventListener("load", function () {
      if (failTimer) clearTimeout(failTimer);
      failTimer = 0;
      host.classList.add("is-loaded");
      host.classList.remove("is-failed");
      touchTip();
    });
    frame.addEventListener("error", fail);
    slot.appendChild(frame);
    frame.src = playUrl();
    if (failTimer) clearTimeout(failTimer);
    failTimer = setTimeout(fail, 20000);
  }
  function ensureHost() {
    var host = hostEl();
    if (!host || host.dataset.ready === "1") return host;
    host.dataset.ready = "1";
    host.innerHTML = '<div class="game-bar"><a class="game-back" href="#/games" aria-label="' + esc(tr("Back")) + '">' + svg(BACK) + '</a><span class="game-grow"></span>' + (gs() ? gs().roomChipHtml() : "") + '<button class="game-tool" type="button" data-game-fav="regone" aria-pressed="false" aria-label="' + esc(tr("Favorite")) + '">' + svg(HEART) + '</button><button class="outline game-share" type="button" data-act="game-share">' + esc(tr("Share to feed")) + '</button><button class="game-tool" type="button" data-game-full aria-label="' + esc(tr("Full screen")) + '">' + svg(FULL) + '</button></div><div class="game-frame"></div><div class="game-loading"><span class="spin"></span><p>' + esc(tr("Loading")) + '</p></div><div class="game-fail"><h2>' + esc(tr("The game didn’t load.")) + '</h2><a class="outline" href="' + esc(ORIGINAL) + '" target="_blank" rel="noopener noreferrer">' + esc(tr("Open original")) + '</a></div><p class="game-credit">' + esc(CREDIT) + ' · <a href="' + esc(ORIGINAL) + '" target="_blank" rel="noopener noreferrer">' + esc(tr("Open original")) + "</a></p>" +
      '<button class="game-handle" type="button" data-game-chrome aria-label="' + esc(tr("Show controls")) + '">' + svg(PAD) + "</button>" +
      '<div class="game-rotate"><span class="game-rotate-icon">' + svg(ROTATE) + "</span><h2>" + esc(tr("Turn your phone sideways to play")) + "</h2>" + (canFull() ? '<button class="game-rotate-go" type="button" data-game-full>' + esc(tr("Play full screen")) + "</button>" : "") + '<a class="game-rotate-back" href="#/games">' + esc(tr("Back")) + '</a><p class="game-rotate-credit">' + esc(CREDIT) + "</p></div>" +
      '<div class="game-pad-note" role="status" aria-live="polite"></div>' +
      '<div class="game-mini-cover" data-game-mini role="button" tabindex="0" aria-label="' + esc(tr("Expand game")) + '"><span class="game-mini-label">ReGone</span></div>' +
      '<button class="game-mini-close" type="button" data-game-close aria-label="' + esc(tr("Close game")) + '">' + svg(CLOSE) + "</button>";
    return host;
  }
  function mount(route) {
    if (!route || route.game !== "regone") {
      unmount();
      return;
    }
    var host = ensureHost();
    if (!host) return;
    var resumed = mini;
    leaveMini(host);
    host.hidden = false;
    host.classList.toggle("immersive", immersive());
    document.documentElement.classList.toggle("game-immersive", immersive());
    setBusy(true);
    holdWake();
    showChrome();
    ensureFrame(host);
    padCheck();
    var row = stat("regone");
    patch("regone", { last: Date.now(), ms: row.ms, fav: row.fav });
    if (!resumed || !clockId) startClock("regone");
    if (gs()) {
      var social = gs();
      var chip = host.querySelector(".game-bar .game-room");
      if (chip) chip.outerHTML = social.roomChipHtml();
      social.handleRoute(route);
      social.showHint();
    }
    if (window.ProfileGifts && window.ProfileGifts.played) window.ProfileGifts.played("regone");
    paintChrome();
    requestAnimationFrame(place);
  }
  /* Leaving the game page keeps the same game frame running in a small
     window in the corner. Tap it to come back, X to close. The frame is
     never rebuilt, so the match keeps going as it was. */
  function unmount() {
    var host = hostEl();
    var frame = host && host.querySelector(".game-frame iframe");
    if (mini) return;
    if (!host || host.hidden || !frame || host.classList.contains("is-failed")) {
      close();
      return;
    }
    goMini(host);
  }
  function goMini(host) {
    mini = true;
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* already out */ });
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = 0;
    setBusy(false);
    dropWake();
    host.classList.remove("immersive", "chrome-hidden");
    host.classList.add("mini");
    host.style.top = "";
    host.style.left = "";
    host.style.width = "";
    host.style.height = "";
    var hint = host.querySelector(".gs-hint");
    if (hint) hint.remove();
  }
  function leaveMini(host) {
    if (!mini && !host.classList.contains("mini")) return;
    mini = false;
    host.classList.remove("mini", "placed", "dragging");
    host.style.top = "";
    host.style.left = "";
  }
  function close() {
    var was = playing || mini;
    stopClock();
    if (was) {
      setBusy(false);
      dropWake();
      if (chromeTimer) clearTimeout(chromeTimer);
      chromeTimer = 0;
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () { /* already out */ });
    }
    if (failTimer) clearTimeout(failTimer);
    failTimer = 0;
    var host = hostEl();
    if (!host) return;
    if (mini) leaveMini(host);
    var frame = host.querySelector("iframe");
    host.hidden = true;
    host.classList.remove("is-loaded", "is-failed", "immersive", "chrome-hidden");
    if (frame) {
      frame.src = "about:blank";
      frame.remove();
      if (gs()) gs().leftGame();
    }
  }
  function isMini() {
    return mini;
  }
  /* Drag the mini window by its cover; a tap without movement expands it. */
  var drag = null;
  document.addEventListener("pointerdown", function (event) {
    var cover = event.target.closest && event.target.closest("[data-game-mini]");
    var host = hostEl();
    if (!cover || !host || !mini) return;
    var rect = host.getBoundingClientRect();
    var z = parseFloat(document.documentElement.style.zoom);
    var scale = z > 0 ? z : 1;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left / scale, top: rect.top / scale, w: rect.width / scale, h: rect.height / scale, scale: scale, moved: false };
    try { cover.setPointerCapture(event.pointerId); } catch (err) { /* old browser */ }
  });
  document.addEventListener("pointermove", function (event) {
    var host = hostEl();
    if (!drag || event.pointerId !== drag.id || !host) return;
    var scale = drag.scale || 1;
    var rawX = event.clientX - drag.x;
    var rawY = event.clientY - drag.y;
    if (!drag.moved && Math.abs(rawX) + Math.abs(rawY) < 8) return;
    var dx = rawX / scale;
    var dy = rawY / scale;
    drag.moved = true;
    host.classList.add("placed", "dragging");
    var left = Math.max(4, Math.min(window.innerWidth / scale - drag.w - 4, drag.left + dx));
    var top = Math.max(4, Math.min(window.innerHeight / scale - drag.h - 4, drag.top + dy));
    host.style.left = Math.round(left) + "px";
    host.style.top = Math.round(top) + "px";
  });
  function endDrag(event) {
    var host = hostEl();
    if (!drag || event.pointerId !== drag.id) return;
    var tapped = !drag.moved && event.type === "pointerup";
    drag = null;
    if (host) host.classList.remove("dragging");
    if (tapped) expand();
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  function expand() {
    if (!mini) return;
    location.hash = "#/games/regone";
  }
  function toggleFav(id) {
    if (!gameById(id)) return;
    var row = stat(id);
    patch(id, { fav: !row.fav, ms: row.ms, last: row.last });
    paintChrome();
    if (window.ViktorychAccounts && window.ViktorychAccounts.requestRender) window.ViktorychAccounts.requestRender();
  }
  function phone() {
    return matchMedia("(max-width: 499px)").matches;
  }
  function coarse() {
    return matchMedia("(pointer: coarse)").matches;
  }
  /* Phones and tablets play edge to edge over the whole app. */
  function immersive() {
    return coarse() && matchMedia("(max-width: 1024px), (max-height: 600px)").matches;
  }
  function canFull() {
    var el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }
  /* The game turns on its own touch controller for phone browsers. A touch
     device that reports a desktop browser asks for it in the address. */
  function playUrl() {
    var ua = navigator.userAgent || "";
    var touchOnly = coarse() && !matchMedia("(any-pointer: fine)").matches;
    if (touchOnly && !/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return PLAY + "?touch=true";
    return PLAY;
  }
  function tellWorker(on) {
    try {
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: "game-busy", on: !!on });
    } catch (err) { /* no worker */ }
  }
  /* While a game is open the app pauses feed polling, prefetch and
     animations. Music keeps playing. */
  function setBusy(on) {
    playing = !!on;
    document.documentElement.classList.toggle("game-on", playing);
    if (!playing) document.documentElement.classList.remove("game-immersive");
    tellWorker(playing);
  }
  function holdWake() {
    if (!playing || wakeLock || document.visibilityState !== "visible") return;
    if (!navigator.wakeLock || !navigator.wakeLock.request) return;
    navigator.wakeLock.request("screen").then(function (lock) {
      if (!playing) { lock.release().catch(function () {}); return; }
      wakeLock = lock;
      lock.addEventListener("release", function () { if (wakeLock === lock) wakeLock = null; });
    }).catch(function () { /* low battery or not allowed */ });
  }
  function dropWake() {
    var lock = wakeLock;
    wakeLock = null;
    if (lock) lock.release().catch(function () {});
  }
  function showChrome() {
    var host = hostEl();
    if (!host) return;
    host.classList.remove("chrome-hidden");
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = 0;
    if (!host.classList.contains("immersive")) return;
    chromeTimer = setTimeout(function () { host.classList.add("chrome-hidden"); }, 4000);
  }
  function padNote(text, html) {
    var host = hostEl();
    var el = host && host.querySelector(".game-pad-note");
    if (!el) return;
    if (html) el.innerHTML = text;
    else el.textContent = text;
    el.classList.add("on");
    if (padTimer) clearTimeout(padTimer);
    padTimer = setTimeout(function () { el.classList.remove("on"); }, 6000);
  }
  /* ReGone's own joystick and buttons only show during a match; its menus
     are tapped directly. Say so once per device so a bare menu does not
     look broken. */
  var TIP_KEY = "viktorychapp-regone-touch-tip";
  function touchTip() {
    if (!coarse()) return;
    try {
      if (localStorage.getItem(TIP_KEY)) return;
      localStorage.setItem(TIP_KEY, "1");
    } catch (err) { /* private mode: show it anyway */ }
    padNote(tr("The joystick and buttons appear once you join a match. Tap menus directly."));
  }
  /* The ViktorychTV app (1.2.0, versionCode 3 and up) plays ReGone with a
     controller in its own screen: viktorychtv://game/regone. */
  var TV_PAD_VERSION = 3;
  function tvPad() {
    var b = window.ViktorychTVMode;
    try { return !!(b && b.inApp && b.inApp() && b.appVersion() >= TV_PAD_VERSION); } catch (err) { return false; }
  }
  function tvPadHref() {
    var b = window.ViktorychTVMode;
    var pkg = (b && b.APP_PACKAGE) || "app.viktorych.tv";
    return "intent://game/regone#Intent;scheme=viktorychtv;package=" + pkg + ";end";
  }
  function tvPadLink(cls) {
    return '<a class="' + cls + '" href="' + esc(tvPadHref()) + '" data-game-tvpad="regone">' + svg(PAD) + "<span>" + esc(tr("Play with controller")) + "</span></a>";
  }
  function padMessage() {
    if (tvPad()) return esc(tr("Controller connected.")) + " " + tvPadLink("game-pad-go");
    return esc(tr("Controller connected, but ReGone doesn't support controllers yet. Use touch, or keyboard and mouse.")) + " " + esc(tr("Play with a controller in the ViktorychTV app."));
  }
  function padCheck() {
    var pads = [];
    try { pads = navigator.getGamepads ? Array.prototype.slice.call(navigator.getGamepads() || []) : []; } catch (err) { pads = []; }
    var pad = pads.filter(Boolean)[0];
    if (pad) padNote(padMessage(), true);
  }
  function toggleFull() {
    var host = hostEl();
    if (!host) return;
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
      return;
    }
    var ask = host.requestFullscreen || host.webkitRequestFullscreen;
    if (!ask) return;
    Promise.resolve(ask.call(host)).then(function () {
      if ((phone() || coarse()) && screen.orientation && screen.orientation.lock) {
        screen.orientation.lock("landscape").catch(function () { /* the browser can refuse a lock */ });
      }
    }).catch(function () { /* fullscreen needs a gesture the browser accepts */ });
  }
  document.addEventListener("click", function (event) {
    var fav = event.target.closest && event.target.closest("[data-game-fav]");
    if (fav) {
      event.preventDefault();
      toggleFav(fav.getAttribute("data-game-fav") || "");
      return;
    }
    var full = event.target.closest && event.target.closest("[data-game-full]");
    if (full) {
      event.preventDefault();
      toggleFull();
      return;
    }
    var shut = event.target.closest && event.target.closest("[data-game-close]");
    if (shut) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    var handle = event.target.closest && event.target.closest("[data-game-chrome]");
    if (handle) {
      event.preventDefault();
      showChrome();
      return;
    }
    var tab = event.target.closest && event.target.closest("[data-game-board-tab]");
    if (tab) {
      event.preventDefault();
      boardTab = tab.getAttribute("data-game-board-tab") === "streak" ? "streak" : "time";
      paintBoard();
      return;
    }
    if (event.target.closest && event.target.closest("#game-host .game-bar")) showChrome();
  });
  document.addEventListener("keydown", function (event) {
    if (!mini || (event.key !== "Enter" && event.key !== " ")) return;
    if (event.target.closest && event.target.closest("[data-game-mini]")) {
      event.preventDefault();
      expand();
    }
  });
  document.addEventListener("visibilitychange", function () {
    flush();
    if (document.visibilityState === "visible") holdWake();
    else if (playing || mini) beat();
  });
  window.addEventListener("gamepadconnected", function () {
    if (playing) padNote(padMessage(), true);
  });
  window.addEventListener("resize", function () {
    var host = hostEl();
    if (!host || host.hidden || !playing) return;
    host.classList.toggle("immersive", immersive());
    document.documentElement.classList.toggle("game-immersive", immersive());
  });
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);
  document.addEventListener("fullscreenchange", function () {
    paintChrome();
    place();
  });

  function busy() {
    return playing;
  }

  window.ViktorychGames = { page: page, mount: mount, unmount: unmount, close: close, isMini: isMini, shareText: shareText, busy: busy, playUrl: playUrl };
})();
