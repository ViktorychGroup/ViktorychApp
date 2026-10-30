/* ReGone social on the page: live invites, rooms, party lobby, game
   achievements, presence badges, Privacy > Games, the NZlay Top 100 tab,
   players online, the mini player's room hint and the streak reminder.

   ReGone runs in a cross-origin frame. Nothing here reads, drives or
   automates the game: rooms are what people pick themselves, Join opens
   the game and copies the room name, and NZlay data comes from its public
   pages through the Worker (each behind an owner flag). */
(function () {
  "use strict";

  var NZLAY_ORIGIN = "https://nzlay.com";
  /* NZlay hook, off: if NZlay ever posts {type:"regone-room", room} from the
     game, the page could fill the room for you. Kept disabled until NZlay
     offers it; only that origin and the game frame would be accepted. */
  var NZLAY_HOOK = false;
  var POLL_MS = 30000;
  var STORE = "viktorychapp-games-v1";
  var LOCAL = "viktorychapp-game-social-v1";
  var OFF_KEY = "viktorychapp-server-off";
  var ID = /^\d{12}$/;

  var state = {
    rooms: null, roomsAt: 0, roomsLoading: null,
    online: null, onlineAt: 0,
    invites: { incoming: [], sent: [] }, invitesAt: 0,
    shown: {}, sentStatus: {},
    lobby: null, lobbyAt: 0,
    friendsRooms: null, friendsRoomsAt: 0,
    ach: {}, achLoading: {},
    pstats: {}, pstatsLoading: {},
    presence: {}, presenceLoading: {},
    together: {}, togetherLoading: {},
    prefs: null, prefsLoading: null, lists: null,
    top: null, topAt: 0, topLoading: null, topSort: "rank", topQuery: "", topDir: 1,
    tab: "games",
    myRoom: "", hintRoom: "",
    sheet: null
  };
  var pollTimer = 0;
  var remindTimer = 0;

  function tr(key, vars) { return window.t ? window.t(key, vars) : key; }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function shared() { return window.ReGoneShared || null; }
  function accounts() { return window.ViktorychAccounts || null; }
  function token() {
    var a = accounts();
    try { return a && a.token ? String(a.token() || "") : ""; } catch (err) { return ""; }
  }
  function me() {
    var a = accounts();
    var acct = a && a.account && a.account();
    return acct && acct.publicId ? String(acct.publicId) : "";
  }
  function call(path, opts) {
    var a = accounts();
    var t = token();
    if (!a || !a.call || !t) return Promise.resolve(null);
    var next = { token: t };
    Object.keys(opts || {}).forEach(function (k) { next[k] = opts[k]; });
    return Promise.resolve(a.call(path, next)).catch(function () { return null; });
  }
  function serverOff(name) {
    try {
      var list = JSON.parse(localStorage.getItem(OFF_KEY) || "[]");
      return Array.isArray(list) && list.indexOf(name) >= 0;
    } catch (err) { return false; }
  }
  function readLocal() {
    try { var v = JSON.parse(localStorage.getItem(LOCAL) || "{}"); return v && typeof v === "object" ? v : {}; } catch (err) { return {}; }
  }
  function writeLocal(patch) {
    var v = readLocal();
    Object.keys(patch).forEach(function (k) { v[k] = patch[k]; });
    try { localStorage.setItem(LOCAL, JSON.stringify(v)); } catch (err) { /* full */ }
    return v;
  }
  function gameStat() {
    try {
      var all = JSON.parse(localStorage.getItem(STORE) || "{}");
      var row = all && all.regone || {};
      return { streak: Number(row.streak) || 0, last: Number(row.last) || 0, day: String(row.day || "") };
    } catch (err) { return { streak: 0, last: 0, day: "" }; }
  }
  function rerender() {
    var a = accounts();
    if (a && a.requestRender) a.requestRender();
  }
  function toast(text) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.hidden = true; }, 3200);
  }
  function tzMin() { return -new Date().getTimezoneOffset(); }

  /* ---------- outline icons (stroke currentColor) ---------- */
  var GLYPH = {
    play: '<path d="M10 9l5 3-5 3z"/>',
    clock: '<circle cx="12" cy="12" r="3.6"/><path d="M12 10.2V12l1.3 1"/>',
    flame: '<path d="M12 8.2c1.6 1.9 3 3 3 5a3 3 0 0 1-6 0c0-1 .5-1.9 1.2-2.5.1 1 .6 1.5 1.3 1.6-.1-1.6-.2-2.7.5-4.1z"/>',
    send: '<path d="M8 12.5l8-4.5-2.6 8.2-1.7-3.1z"/>',
    people: '<circle cx="10.3" cy="10.6" r="1.6"/><circle cx="14.3" cy="11" r="1.3"/><path d="M7.6 15.6c.4-1.6 1.4-2.4 2.7-2.4s2.3.8 2.7 2.4M13.3 13.3c1.4-.2 2.6.5 3 2.1"/>',
    moon: '<path d="M14.2 8.6a3.7 3.7 0 1 0 1.6 5.7 3.1 3.1 0 0 1-1.6-5.7z"/>',
    calendar: '<rect x="8" y="9" width="8" height="7" rx="1"/><path d="M8 11.5h8M10 7.8v2.2M14 7.8v2.2"/>',
    trophy: '<path d="M9.6 8.2h4.8v2.6a2.4 2.4 0 0 1-4.8 0zM12 13.2v2M10.2 15.6h3.6M9.6 9H8.3a1.5 1.5 0 0 0 1.5 2M14.4 9h1.3a1.5 1.5 0 0 1-1.5 2"/>',
    crown: '<path d="M8.2 15.2l-.6-6 2.5 2 1.9-3 1.9 3 2.5-2-.6 6z"/>',
    target: '<circle cx="12" cy="12" r="3.6"/><circle cx="12" cy="12" r="1"/><path d="M12 7v1.6M12 15.4V17M7 12h1.6M15.4 12H17"/>',
    up: '<path d="M12 16V8.4M9.2 11.2L12 8.4l2.8 2.8"/>'
  };
  var UI = {
    invite: '<path d="M9.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM4.5 18c.6-2.8 2.5-4.3 5-4.3s4.4 1.5 5 4.3M17.5 8.5v5M15 11h5"/>',
    pad: '<path d="M7.8 8.5h8.4a3.6 3.6 0 0 1 3.5 2.9l.7 3.6a1.7 1.7 0 0 1-3 1.4l-1.2-1.6H7.8l-1.2 1.6a1.7 1.7 0 0 1-3-1.4l.7-3.6a3.6 3.6 0 0 1 3.5-2.9zM8.5 11v2.4M7.3 12.2h2.4"/><circle cx="15" cy="12.2" r=".6"/><circle cx="16.6" cy="11.4" r=".6"/>',
    room: '<path d="M6 19V6.5A1.5 1.5 0 0 1 7.5 5h9A1.5 1.5 0 0 1 18 6.5V19M4 19h16M14 12.5h.01"/>',
    copy: '<rect x="8.5" y="8.5" width="10" height="10" rx="2"/><path d="M15.5 8.5V6.5a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    lock: '<rect x="6" y="11" width="12" height="9" rx="2"/><path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'
  };
  function badgeSvg(icon, size) {
    return '<svg class="gs-badge" viewBox="0 0 24 24" width="' + (size || 40) + '" height="' + (size || 40) + '" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.6l8.1 4.7v9.4L12 21.4l-8.1-4.7V7.3z"/>' + (GLYPH[icon] || GLYPH.play) + "</svg>";
  }
  function ui(name) {
    return '<svg class="gs-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' + (UI[name] || "") + "</svg>";
  }

  /* ---------- achievements copy ---------- */
  function achCopy(id) {
    var kills = /^kills_(\d+)$/.exec(id);
    if (kills) return [tr("{n} kills", { n: kills[1] }), tr("Your claimed name has {n} kills on the NZlay board.", { n: kills[1] })];
    var top = /^top_(\d+)$/.exec(id);
    if (top && top[1] !== "1") return [tr("Top {n}", { n: top[1] }), tr("Your claimed name is in the NZlay Top {n}.", { n: top[1] })];
    var map = {
      first_play: [tr("First play"), tr("Played ReGone for the first time.")],
      hours_1: [tr("One hour in"), tr("Played ReGone for 1 hour.")],
      hours_10: [tr("Ten hours"), tr("Played ReGone for 10 hours.")],
      hours_50: [tr("Fifty hours"), tr("Played ReGone for 50 hours.")],
      streak_3: [tr("3-day streak"), tr("Played 3 days in a row.")],
      streak_7: [tr("7-day streak"), tr("Played 7 days in a row.")],
      streak_30: [tr("30-day streak"), tr("Played 30 days in a row.")],
      invite_sent: [tr("Squad up"), tr("Sent your first game invite.")],
      invite_joined: [tr("They came"), tr("A friend joined your invite.")],
      friends_3: [tr("Crew"), tr("Played with 3 different friends.")],
      night_owl: [tr("Night owl"), tr("Played between midnight and 4 AM.")],
      weekend_warrior: [tr("Weekend warrior"), tr("Played on a Saturday and the Sunday after.")],
      top_1: [tr("Number one"), tr("Your claimed name is #1 on NZlay.")],
      climber: [tr("Climber"), tr("Your claimed name climbed 10 places on the Top 100.")],
      weapon_100: [tr("Weapon master"), tr("100 kills with one weapon on your linked NZlay profile.")],
      headshot_25: [tr("Sharpshooter"), tr("A quarter of your hits are headshots on your linked NZlay profile.")],
      multi_10: [tr("Multi-kill"), tr("10 multi-kills on your linked NZlay profile.")],
      wins_10: [tr("Winner"), tr("10 match wins on your linked NZlay profile.")],
      wins_100: [tr("Champion"), tr("100 match wins on your linked NZlay profile.")]
    };
    return map[id] || [id, ""];
  }
  function achIcon(id) {
    var S = shared();
    var list = S && S.ACHIEVEMENTS || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i].icon;
    return "play";
  }
  function achList() {
    var S = shared();
    return S && S.ACHIEVEMENT_IDS ? S.ACHIEVEMENT_IDS.slice() : [];
  }
  function celebrate(ids) {
    var B = window.ViktorychAchievements;
    (ids || []).forEach(function (id) {
      if (!B || !B.popout) return;
      var copy = achCopy(id);
      B.popout({
        id: "game-ach-" + id, variant: "game", kicker: tr("ReGone achievement"), title: copy[0], desc: copy[1],
        svg: badgeSvg(achIcon(id), 28), dismissLabel: tr("Nice"),
        onClose: function () { call("/v1/games/achievements/seen", { method: "POST", body: { ids: [id] } }); }
      });
    });
    var mine = me();
    if (mine) delete state.ach[mine];
  }

  /* ---------- quiet hours and DND ---------- */
  function quietNow() {
    var P = window.ViktorychPresence;
    if (P && P.dnd && P.dnd()) return true;
    var p = state.prefs && state.prefs.quiet;
    if (p && p.on) {
      var S = shared();
      if (S && S.inQuiet) return S.inQuiet(Date.now(), tzMin(), p.from, p.to);
    }
    return false;
  }
  function gamesNoteMode() {
    try {
      var p = window.ViktorychNotePrefs ? window.ViktorychNotePrefs() : null;
      if (p && (p.games === "off" || p.games === "inapp" || p.games === "push")) return p.games;
    } catch (err) { /* default */ }
    return "push";
  }

  /* ---------- rooms ---------- */
  function curated() {
    var S = shared();
    return S && S.CURATED_ROOMS ? S.CURATED_ROOMS.slice() : [];
  }
  function loadRooms() {
    if (state.rooms && Date.now() - state.roomsAt < 5 * 60 * 1000) return Promise.resolve(state.rooms);
    if (state.roomsLoading) return state.roomsLoading;
    if (serverOff("regone_rooms")) {
      state.rooms = { source: "curated", rooms: curated(), clans: [] };
      return Promise.resolve(state.rooms);
    }
    state.roomsLoading = call("/v1/games/regone/rooms").then(function (res) {
      state.roomsLoading = null;
      if (res && res.status === 200 && Array.isArray(res.rooms)) state.rooms = { source: res.source || "live", rooms: res.rooms, clans: Array.isArray(res.clans) ? res.clans : [] };
      else state.rooms = { source: "curated", rooms: curated(), clans: [] };
      state.roomsAt = Date.now();
      return state.rooms;
    });
    return state.roomsLoading;
  }
  function loadOnline() {
    if (serverOff("regone_online")) return Promise.resolve(null);
    if (state.online != null && Date.now() - state.onlineAt < 60000) return Promise.resolve(state.online);
    state.onlineAt = Date.now();
    return call("/v1/games/regone/online").then(function (res) {
      state.online = res && res.status === 200 && res.ok ? Number(res.online) || 0 : null;
      paintOnline();
      return state.online;
    });
  }
  function onlineChipHtml() {
    if (state.online == null || serverOff("regone_online")) return '<span class="gs-online" data-gs-online hidden></span>';
    return '<span class="gs-online" data-gs-online><i aria-hidden="true"></i>' + esc(tr("{n} playing now", { n: state.online })) + "</span>";
  }
  function paintOnline() {
    document.querySelectorAll("[data-gs-online]").forEach(function (el) {
      if (state.online == null) { el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = '<i aria-hidden="true"></i>' + esc(tr("{n} playing now", { n: state.online }));
    });
  }
  function copyText(text) {
    if (!text) return Promise.resolve(false);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallbackCopy(text); });
    } catch (err) { /* fall back */ }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (err) { return false; }
  }

  /* After Join: open the game and show which room to pick. ReGone has no
     address that joins a room, so the hint carries the name. */
  function openWithRoom(room) {
    state.hintRoom = room || "";
    if (room) copyText(room);
    if (location.hash.indexOf("#/games/regone") !== 0 || location.hash.indexOf("?") > 0) location.hash = "#/games/regone";
    else showHint();
  }
  function showHint() {
    var host = document.getElementById("game-host");
    if (!host) return;
    var old = host.querySelector(".gs-hint");
    if (old) old.remove();
    var room = state.hintRoom;
    if (!room) return;
    var el = document.createElement("div");
    el.className = "gs-hint";
    el.setAttribute("role", "status");
    el.innerHTML = '<span class="gs-hint-ico">' + ui("room") + '</span><span class="gs-hint-copy"><b>' + esc(tr("Join room {room}", { room: room })) + "</b><span>" + esc(tr("Room name copied. Pick it in ReGone's server list.")) + '</span></span><button type="button" class="gs-hint-btn" data-gs-copy="' + esc(room) + '" aria-label="' + esc(tr("Copy room name")) + '">' + ui("copy") + '</button><button type="button" class="gs-hint-btn" data-gs-hint-close aria-label="' + esc(tr("Close")) + '">' + ui("close") + "</button>";
    host.appendChild(el);
    clearTimeout(showHint.t);
    showHint.t = setTimeout(function () { if (el.parentNode) el.remove(); }, 45000);
  }

  /* ---------- the sheet: invite, set room, new party ---------- */
  function loadFriends() {
    return call("/v1/games/board?game=regone").then(function (res) {
      var people = res && res.status === 200 && Array.isArray(res.people) ? res.people.filter(function (p) { return !p.me; }) : [];
      return people.map(function (p) { return { publicId: p.publicId, name: p.name || p.handle || "", handle: p.handle || "", avatar: p.avatar || "", playing: !!p.playing }; });
    });
  }
  function openSheet(mode, opts) {
    opts = opts || {};
    if (!token()) { var a = accounts(); if (a && a.openLogin) a.openLogin(); return; }
    closeSheet();
    state.sheet = {
      mode: mode, to: opts.to || "", toName: opts.toName || "", lobbyId: opts.lobbyId || "",
      friends: null, room: opts.room || "", typed: "", filter: "", map: "", gmode: "", region: "", msg: "", priv: false, error: ""
    };
    var el = document.createElement("div");
    el.className = "gs-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.innerHTML = '<div class="gs-panel" data-gs-panel></div>';
    document.body.appendChild(el);
    paintSheet();
    loadRooms().then(paintSheet);
    loadOnline();
    if (mode === "invite" && !state.sheet.to) loadFriends().then(function (list) { if (state.sheet) { state.sheet.friends = list; paintSheet(); } });
    setTimeout(function () { var first = el.querySelector("input, button"); if (first) first.focus(); }, 30);
  }
  function closeSheet() {
    var el = document.querySelector(".gs-sheet");
    if (el) el.remove();
    state.sheet = null;
  }
  function roomRows() {
    var s = state.sheet;
    var data = state.rooms || { rooms: curated(), clans: [] };
    var all = data.rooms.concat(data.clans || []);
    var q = s.filter.toLowerCase();
    return all.filter(function (r) {
      if (s.map && r.arena !== s.map) return false;
      if (s.gmode && r.mode !== s.gmode) return false;
      if (s.region && r.region !== s.region) return false;
      return !q || r.name.toLowerCase().indexOf(q) >= 0 || String(r.arena || "").toLowerCase().indexOf(q) >= 0;
    }).slice(0, 80);
  }
  function uniq(list, key) {
    var seen = {};
    var out = [];
    list.forEach(function (r) { var v = r[key]; if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out.sort();
  }
  function selectHtml(name, label, values, current) {
    return '<label class="gs-filter"><span class="gs-sr">' + esc(label) + '</span><select data-gs-filter="' + name + '" aria-label="' + esc(label) + '"><option value="">' + esc(label) + "</option>" + values.map(function (v) {
      return '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + esc(v) + "</option>";
    }).join("") + "</select></label>";
  }
  function chosenRoom() {
    var s = state.sheet;
    var typed = String(s.typed || "").trim();
    return typed || s.room;
  }
  function paintSheet() {
    var s = state.sheet;
    var panel = document.querySelector(".gs-sheet [data-gs-panel]");
    if (!s || !panel) return;
    var title = s.mode === "room" ? tr("Set room") : s.mode === "lobby" ? tr("New party") : (s.toName ? tr("Invite {name} to play ReGone", { name: s.toName }) : tr("Invite to play ReGone"));
    var html = '<header class="gs-head"><button type="button" class="gs-x" data-gs-close aria-label="' + esc(tr("Close")) + '">' + ui("close") + "</button><h2>" + esc(title) + "</h2>" + onlineChipHtml() + "</header>";
    if (s.mode === "invite" && !s.to) {
      var friends = s.friends;
      html += "<h3>" + esc(tr("Friend")) + "</h3>";
      if (!friends) html += '<p class="gs-muted">' + esc(tr("Loading")) + "</p>";
      else if (!friends.length) html += '<p class="gs-muted">' + esc(tr("Add friends to invite them to play.")) + "</p>";
      else html += '<div class="gs-friends" role="radiogroup" aria-label="' + esc(tr("Friend")) + '">' + friends.map(function (f) {
        var on = s.pick === f.publicId;
        return '<button type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" class="gs-friend' + (on ? " on" : "") + '" data-gs-pick="' + esc(f.publicId) + '">' + avatarHtml(f) + "<span>" + esc(f.name) + "</span>" + (f.playing ? '<i class="gs-dot" aria-hidden="true"></i>' : "") + "</button>";
      }).join("") + "</div>";
    }
    var data = state.rooms || { rooms: curated(), clans: [], source: "curated" };
    var all = data.rooms.concat(data.clans || []);
    html += "<h3>" + esc(tr("Room")) + "</h3>";
    html += '<div class="gs-search">' + ui("search") + '<input type="search" data-gs-room-filter placeholder="' + esc(tr("Search rooms")) + '" aria-label="' + esc(tr("Search rooms")) + '" value="' + esc(s.filter) + '"></div>';
    html += '<div class="gs-filters">' + selectHtml("map", tr("Map"), uniq(all, "arena"), s.map) + selectHtml("gmode", tr("Mode"), uniq(all, "mode"), s.gmode) + selectHtml("region", tr("Region"), uniq(all, "region"), s.region) + "</div>";
    var list = roomRows();
    html += '<div class="gs-rooms" role="listbox" aria-label="' + esc(tr("Rooms")) + '">' + (list.length ? list.map(function (r) {
      var on = !s.typed && s.room === r.name;
      var meta = [r.arena, r.mode, r.max ? tr("up to {n}", { n: r.max }) : "", r.clan ? tr("Clan room") : ""].filter(Boolean).join(" · ");
      return '<button type="button" role="option" aria-selected="' + (on ? "true" : "false") + '" class="gs-room' + (on ? " on" : "") + '" data-gs-room="' + esc(r.name) + '"><span class="gs-room-name">' + esc(r.name) + "</span>" + (meta ? '<span class="gs-room-meta">' + esc(meta) + "</span>" : "") + (on ? ui("check") : "") + "</button>";
    }).join("") : '<p class="gs-muted">' + esc(tr("No rooms match. Type the name below.")) + "</p>") + "</div>";
    if (data.source === "curated") html += '<p class="gs-muted gs-small">' + esc(tr("Showing NZlay's standard rooms.")) + "</p>";
    html += '<label class="gs-field"><span>' + esc(tr("Or type a room name")) + '</span><input type="text" maxlength="48" data-gs-room-typed value="' + esc(s.typed) + '" placeholder="' + esc(tr("Room name")) + '" autocomplete="off"></label>';
    html += '<p class="gs-muted gs-small">' + esc(tr("ReGone has no join link. Your friend sees the room name and picks it in the game.")) + "</p>";
    if (s.mode === "invite") {
      var n = Array.from(s.msg || "").length;
      html += '<label class="gs-field"><span>' + esc(tr("Message (optional)")) + '</span><textarea data-gs-msg maxlength="160" rows="2" placeholder="' + esc(tr("Add a note")) + '">' + esc(s.msg) + '</textarea><span class="gs-count' + (n > 140 ? " over" : "") + '" data-gs-count>' + n + "/140</span></label>";
    }
    if (s.mode !== "room") {
      html += '<button type="button" class="gs-switch' + (s.priv ? " on" : "") + '" role="switch" aria-checked="' + (s.priv ? "true" : "false") + '" data-gs-private><span>' + ui("lock") + "<b>" + esc(tr("Play privately")) + "</b><small>" + esc(tr("Nothing about this session is saved to play-together history.")) + "</small></span><i></i></button>";
    }
    html += '<p class="gs-error" data-gs-error role="alert">' + esc(s.error || "") + "</p>";
    var main = s.mode === "room" ? tr("Set room") : s.mode === "lobby" ? tr("Create party") : tr("Send invite");
    html += '<footer class="gs-foot">' + (s.mode === "room" && state.myRoom ? '<button type="button" class="gs-btn" data-gs-room-clear>' + esc(tr("Clear room")) + "</button>" : "") + '<button type="button" class="gs-btn gs-primary" data-gs-submit>' + esc(main) + "</button></footer>";
    panel.innerHTML = html;
  }
  function avatarHtml(p) {
    if (p && p.avatar && /^(https:|data:image\/|\.\/)/.test(p.avatar)) return '<img class="gs-ava" src="' + esc(p.avatar) + '" alt="" loading="lazy">';
    return '<span class="gs-ava gs-ava-text">' + esc(String(p && (p.name || p.handle) || "?").charAt(0).toUpperCase()) + "</span>";
  }
  function messageCheck(text) {
    var S = shared();
    if (!S || !S.checkMessage) return { ok: Array.from(text).length <= 140, text: text, error: "long" };
    return S.checkMessage(text);
  }
  function submitSheet() {
    var s = state.sheet;
    if (!s) return;
    var room = chosenRoom();
    var S = shared();
    if (s.typed && S && S.cleanRoom && !S.cleanRoom(s.typed)) { s.error = tr("Room names can't have links."); paintSheet(); return; }
    if (s.mode === "room") {
      setRoom(room).then(function (ok) { if (ok) closeSheet(); });
      return;
    }
    if (s.mode === "lobby") {
      call("/v1/games/lobby", { method: "POST", body: { room: room, private: s.priv } }).then(function (res) {
        if (!res || res.status !== 200) { s.error = tr("Try again"); paintSheet(); return; }
        state.lobby = res.lobby;
        closeSheet();
        paintSections();
      });
      return;
    }
    var to = s.to || s.pick || "";
    if (!ID.test(to)) { s.error = tr("Pick a friend to invite."); paintSheet(); return; }
    var check = messageCheck(s.msg || "");
    if (!check.ok) { s.error = check.error === "links" ? tr("Messages can't have links.") : tr("Keep it to 140 characters."); paintSheet(); return; }
    var btn = document.querySelector(".gs-sheet [data-gs-submit]");
    if (btn) btn.disabled = true;
    call("/v1/games/invite", { method: "POST", body: { gameId: "regone", to: to, room: room, message: check.text, lobbyId: s.lobbyId, private: s.priv, tz: tzMin() } }).then(function (res) {
      if (btn) btn.disabled = false;
      if (!res || res.status !== 200) {
        var err = res && res.error;
        s.error = res && res.status === 429 ? tr("You're doing that too fast. Try again in a moment.")
          : err === "friends_only" ? tr("You can invite friends only.")
          : err === "unavailable" ? tr("You can't invite this person.")
          : err === "message_links" ? tr("Messages can't have links.")
          : err === "message_long" ? tr("Keep it to 140 characters.")
          : tr("Try again");
        paintSheet();
        return;
      }
      state.sentStatus[res.id] = "pending";
      if (res.achievements && res.achievements.length) celebrate(res.achievements);
      closeSheet();
      toast(res.sent === false ? tr("Already invited. The invite is still open.") : tr("Invite sent"));
      refreshInvites(true);
    });
  }

  /* ---------- my room ---------- */
  function setRoom(room) {
    var S = shared();
    var clean = S && S.cleanRoom ? S.cleanRoom(room || "") : String(room || "").slice(0, 48);
    return call("/v1/games/room", { method: "POST", body: { room: clean } }).then(function (res) {
      if (!res || res.status !== 200) { toast(tr("Try again")); return false; }
      state.myRoom = res.room || "";
      if (res.hidden) toast(tr("Your room is hidden by Privacy > Games."));
      paintRoomChip();
      return true;
    });
  }
  function clearRoom(beacon) {
    if (!state.myRoom) return;
    state.myRoom = "";
    paintRoomChip();
    if (beacon) {
      // Leaving the page: one small request that may outlive it.
      var a = accounts();
      var base = a && a.apiBase ? a.apiBase() : "";
      var t = token();
      if (base && t && window.fetch) {
        try { fetch(base.replace(/\/$/, "") + "/v1/games/room", { method: "POST", keepalive: true, credentials: "omit", headers: { "content-type": "application/json", Authorization: "Bearer " + t }, body: '{"room":""}' }); return; } catch (err) { /* fall through */ }
      }
    }
    call("/v1/games/room", { method: "POST", body: { room: "" } });
  }
  function roomChipHtml() {
    return '<button type="button" class="outline game-room" data-gs-setroom>' + ui("room") + "<span>" + esc(state.myRoom ? state.myRoom : tr("Set room")) + "</span></button>";
  }
  function paintRoomChip() {
    document.querySelectorAll("[data-gs-setroom] span").forEach(function (el) { el.textContent = state.myRoom || tr("Set room"); });
  }

  /* ---------- invites in and out ---------- */
  function refreshInvites(force) {
    if (!token()) return Promise.resolve();
    if (!force && Date.now() - state.invitesAt < 10000) return Promise.resolve();
    state.invitesAt = Date.now();
    return call("/v1/games/invites").then(function (res) {
      if (!res || res.status !== 200) return;
      state.invites = { incoming: res.incoming || [], sent: res.sent || [] };
      state.invites.incoming.forEach(showIncoming);
      state.invites.sent.forEach(function (inv) {
        var was = state.sentStatus[inv.id];
        if (was === "pending" && inv.status !== "pending") statusPop(inv.id, inv.status, inv.to);
        state.sentStatus[inv.id] = inv.status;
      });
      paintSections();
    });
  }
  function showIncoming(inv) {
    if (!inv || !inv.id || state.shown[inv.id] || inv.status !== "pending") return;
    var left = (Number(inv.expiresAt) || 0) - Date.now();
    if (left < 5000) return;
    if (quietNow() || gamesNoteMode() === "off") return;
    var B = window.ViktorychAchievements;
    if (!B || !B.popout) return;
    state.shown[inv.id] = true;
    var from = inv.from || {};
    var desc = [inv.room ? tr("Room {room}", { room: inv.room }) : "", inv.message ? "“" + inv.message + "”" : "", state.online != null ? tr("{n} playing now", { n: state.online }) : ""].filter(Boolean).join(" · ");
    B.popout({
      id: "game-invite-" + inv.id, variant: "invite", front: true,
      kicker: from.name || tr("A friend"), title: tr("invites you to play ReGone"), desc: desc,
      avatar: from.avatar || "", avatarText: from.avatar ? "" : (from.name || "?"),
      action: tr("Join"), cancel: tr("Not now"), dismiss: false,
      hold: Math.min(left, 60000), countdownMs: Math.min(left, 60000),
      onAction: function (act) {
        if (act === "action") answer(inv.id, "join", inv.room);
        else if (act === "cancel") answer(inv.id, "decline");
      }
    });
    loadOnline();
  }
  function answer(id, what, room) {
    if (what === "join" && room) { state.hintRoom = room; copyText(room); }
    return call("/v1/games/invite/answer", { method: "POST", body: { id: id, answer: what } }).then(function (res) {
      var code = res && res.status;
      if (code === 200) {
        if (res.achievements && res.achievements.length) celebrate(res.achievements);
        if (what === "join") {
          if (res.lobbyId) loadLobby(true);
          // Friends see which room you headed to (Privacy > Games still applies server-side).
          if (res.room || room) setRoom(res.room || room);
          openWithRoom(res.room || room || "");
        }
      } else if (code === 410) toast(tr("This invite expired."));
      else if (code === 409) toast(tr("You already answered this invite."));
      else if (code) toast(tr("This invite isn't available."));
      refreshInvites(true);
      return res;
    });
  }
  function statusPop(id, status, who) {
    var B = window.ViktorychAchievements;
    if (!B || !B.popout || (status !== "joined" && status !== "declined")) return;
    var name = who && who.name || tr("Your friend");
    B.popout({
      id: "game-status-" + id + "-" + status, variant: "game",
      kicker: tr("ReGone invite"), title: status === "joined" ? tr("{name} joined", { name: name }) : tr("{name} can't play now", { name: name }),
      avatar: who && who.avatar || "", avatarText: who && who.avatar ? "" : name,
      dismissLabel: tr("OK")
    });
  }
  function onChannel(data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "invite" && data.invite) {
      state.invites.incoming = [data.invite].concat(state.invites.incoming.filter(function (x) { return x.id !== data.invite.id; }));
      if (!data.quiet) showIncoming(data.invite);
      paintSections();
    } else if (data.type === "invite-status") {
      if (state.sentStatus[data.id] !== data.status) statusPop(data.id, data.status, data.by);
      state.sentStatus[data.id] = data.status;
      refreshInvites(true);
    } else if (data.type === "achievements" && Array.isArray(data.ids)) {
      celebrate(data.ids);
    } else if (data.type === "lobby" || data.type === "lobby-closed") {
      loadLobby(true);
    } else if (data.type === "lobby-launch") {
      launchPop(data);
      loadLobby(true);
    }
  }
  function launchPop(data) {
    var B = window.ViktorychAchievements;
    if (state.lobby && state.lobby.hostId === me()) return;
    if (!B || !B.popout) { openWithRoom(data.room || ""); return; }
    B.popout({
      id: "game-launch-" + data.id, variant: "invite", front: true, kicker: tr("Party"), title: tr("The party is starting"),
      desc: data.room ? tr("Room {room}", { room: data.room }) : "", action: tr("Join"), cancel: tr("Not now"), dismiss: false,
      onAction: function (act) { if (act === "action") openWithRoom(data.room || ""); }
    });
  }
  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (document.visibilityState !== "visible" || !token()) return;
      var P = window.ViktorychPresence;
      var open = P && P.channelOpen && P.channelOpen();
      // The live channel brings invites; polling catches up when it is down.
      if (!open || Date.now() - state.invitesAt > 120000) refreshInvites(true);
    }, POLL_MS);
  }

  /* Links from pushes and the bell: #/games/regone?invite=ID[&act=join|decline] */
  function handleRoute(route) {
    var q = route && route.query;
    var id = q && q.get ? q.get("invite") : "";
    if (!id || !/^[a-f0-9]{24}$/.test(id) || handleRoute.last === id) return;
    handleRoute.last = id;
    var act = q.get("act") || "";
    if (act === "decline") { answer(id, "decline"); history.replaceState(null, "", "#/games"); return; }
    if (act === "join") { answer(id, "join"); return; }
    refreshInvites(true).then(function () {
      var inv = state.invites.incoming.filter(function (x) { return x.id === id; })[0];
      if (inv) { delete state.shown[id]; showIncoming(inv); }
    });
  }

  /* ---------- lobby ---------- */
  function loadLobby(force) {
    if (!token()) return Promise.resolve(null);
    if (!force && Date.now() - state.lobbyAt < 30000) return Promise.resolve(state.lobby);
    state.lobbyAt = Date.now();
    return call("/v1/games/lobby").then(function (res) {
      state.lobby = res && res.status === 200 ? res.lobby || null : state.lobby;
      paintSections();
      return state.lobby;
    });
  }
  function lobbyHtml() {
    var l = state.lobby;
    if (!token()) return "";
    if (!l) {
      return '<section class="games-rail gs-section"><h2>' + esc(tr("Party")) + '</h2><p class="games-empty">' + esc(tr("Gather friends, get ready, then launch together.")) + '</p><div class="gs-row"><button type="button" class="gs-btn gs-primary" data-gs-lobby-new>' + esc(tr("Start a party")) + "</button></div></section>";
    }
    var host = l.hostId === me();
    var mine = (l.members || []).filter(function (m) { return m.me; })[0];
    var rows = (l.members || []).map(function (m) {
      return '<li class="gs-member">' + avatarHtml(m) + '<span class="gs-member-name">' + esc(m.me ? tr("You") : m.name) + (m.host ? ' <small>' + esc(tr("Host")) + "</small>" : "") + '</span><span class="gs-ready' + (m.ready ? " on" : "") + '">' + esc(m.ready ? tr("Ready") : tr("Not ready")) + "</span></li>";
    }).join("");
    var roomLine = host
      ? '<div class="gs-row"><span class="gs-muted">' + esc(l.room ? tr("Room {room}", { room: l.room }) : tr("No room yet")) + '</span><button type="button" class="gs-btn" data-gs-lobby-room>' + esc(tr("Change room")) + "</button></div>"
      : '<p class="gs-muted">' + esc(l.room ? tr("Room {room}", { room: l.room }) : tr("No room yet")) + "</p>";
    var buttons = '<div class="gs-row">' +
      (mine ? '<button type="button" class="gs-btn" data-gs-lobby-ready>' + esc(mine.ready ? tr("Not ready") : tr("Ready")) + "</button>" : "") +
      (host ? '<button type="button" class="gs-btn" data-gs-lobby-invite>' + esc(tr("Invite")) + '</button><button type="button" class="gs-btn gs-primary" data-gs-lobby-launch>' + esc(tr("Launch")) + "</button>" : "") +
      '<button type="button" class="gs-btn" data-gs-lobby-leave>' + esc(tr("Leave")) + "</button></div>";
    return '<section class="games-rail gs-section gs-lobby"><h2>' + esc(tr("Party")) + (l.private ? ' <small class="gs-private">' + ui("lock") + esc(tr("Private")) + "</small>" : "") + "</h2>" + roomLine + '<ul class="gs-members">' + rows + "</ul>" + buttons + "</section>";
  }
  function lobbyAct(what, extra) {
    var l = state.lobby;
    if (!l) return;
    var body = Object.assign({ id: l.id }, extra || {});
    call("/v1/games/lobby/" + what, { method: "POST", body: body }).then(function (res) {
      if (!res || res.status !== 200) { toast(res && res.error === "host_only" ? tr("Only the host can do that.") : tr("Try again")); return; }
      if (what === "leave") state.lobby = null;
      else if (res.lobby) state.lobby = res.lobby;
      if (what === "launch") openWithRoom(res.room || "");
      paintSections();
    });
  }

  /* ---------- Friends in rooms ---------- */
  function loadFriendsRooms(force) {
    if (!token()) return;
    if (!force && Date.now() - state.friendsRoomsAt < 30000) return;
    state.friendsRoomsAt = Date.now();
    call("/v1/games/friends-rooms").then(function (res) {
      state.friendsRooms = res && res.status === 200 ? res.friends || [] : [];
      paintSections();
    });
  }
  function friendsRoomsHtml() {
    var list = state.friendsRooms;
    if (!token() || !list || !list.length) return "";
    var groups = {};
    list.forEach(function (f) { var key = f.room || ""; (groups[key] = groups[key] || []).push(f); });
    var keys = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length || a.localeCompare(b); });
    return '<section class="games-rail gs-section"><h2>' + esc(tr("Friends in rooms")) + "</h2>" + keys.map(function (room) {
      return '<div class="gs-roomgroup"><div class="gs-roomgroup-head">' + ui("room") + "<b>" + esc(room || tr("Playing now")) + '</b><button type="button" class="gs-btn gs-primary gs-join" data-gs-join-room="' + esc(room) + '">' + esc(tr("Join")) + '</button></div><div class="gs-roomgroup-people">' + groups[room].map(function (f) {
        return '<a class="gs-person" href="#/@' + encodeURIComponent(f.handle || "") + '">' + avatarHtml(f) + "<span>" + esc(f.name) + "</span></a>";
      }).join("") + "</div></div>";
    }).join("") + "</section>";
  }

  /* ---------- achievements, together, rank card ---------- */
  function loadAch(id, force) {
    if (!ID.test(id) || state.achLoading[id]) return;
    if (!force && state.ach[id] && Date.now() - state.ach[id].at < 60000) return;
    state.achLoading[id] = true;
    var mine = id === me();
    call("/v1/games/achievements" + (mine ? "" : "?id=" + id)).then(function (res) {
      delete state.achLoading[id];
      state.ach[id] = { at: Date.now(), body: res && res.status === 200 ? res : { hidden: true, achievements: [] } };
      if (mine && res && res.achievements) {
        var unseen = res.achievements.filter(function (a) { return !a.seen; }).map(function (a) { return a.id; });
        if (unseen.length) celebrate(unseen);
      }
      paintSections();
      paintProfile(id);
    });
  }
  function achGridHtml(body, mine) {
    var have = {};
    (body.achievements || []).forEach(function (a) { have[a.id] = a; });
    var ids = mine ? achList() : Object.keys(have);
    if (!ids.length) return '<p class="games-empty">' + esc(tr("No achievements yet.")) + "</p>";
    return '<ul class="gs-ach-grid">' + ids.map(function (id) {
      var got = !!have[id];
      var copy = achCopy(id);
      return '<li class="gs-ach' + (got ? " got" : "") + '" title="' + esc(copy[1]) + '">' + badgeSvg(achIcon(id), 40) + '<span class="gs-ach-name">' + esc(copy[0]) + '</span><span class="gs-ach-desc">' + esc(got ? copy[1] : tr("Locked")) + "</span></li>";
    }).join("") + "</ul>";
  }
  function achSectionHtml() {
    var id = me();
    if (!id) return "";
    var got = state.ach[id];
    if (!got) loadAch(id);
    var body = got ? got.body : null;
    return '<section class="games-rail gs-section" data-gs-ach><h2>' + esc(tr("ReGone achievements")) + "</h2>" + (body ? achGridHtml(body, true) : '<p class="games-empty">' + esc(tr("Loading")) + "</p>") + "</section>";
  }
  function loadPstats(id) {
    if (serverOff("regone_profile_stats") || !ID.test(id) || state.pstatsLoading[id]) return;
    if (state.pstats[id] && Date.now() - state.pstats[id].at < 10 * 60 * 1000) return;
    state.pstatsLoading[id] = true;
    call("/v1/games/regone/profile-stats" + (id === me() ? "" : "?id=" + id)).then(function (res) {
      delete state.pstatsLoading[id];
      state.pstats[id] = { at: Date.now(), body: res && res.status === 200 ? res : { ok: false } };
      if (res && res.achievements && res.achievements.length) celebrate(res.achievements);
      paintProfile(id);
      paintSections();
    });
  }
  function loadTogether(id) {
    if (!ID.test(id) || state.togetherLoading[id]) return;
    if (state.together[id] && Date.now() - state.together[id].at < 60000) return;
    state.togetherLoading[id] = true;
    call("/v1/games/together?id=" + id).then(function (res) {
      delete state.togetherLoading[id];
      state.together[id] = { at: Date.now(), body: res && res.status === 200 ? res : { people: [] } };
      paintProfile(id);
    });
  }
  function togetherHtml(id) {
    var got = state.together[id];
    var people = got && got.body && got.body.people || [];
    if (!people.length) return "";
    return '<div class="gs-together"><h3>' + esc(tr("Plays ReGone with")) + '</h3><div class="gs-roomgroup-people">' + people.slice(0, 12).map(function (p) {
      return '<a class="gs-person" href="#/@' + encodeURIComponent(p.handle || "") + '">' + avatarHtml(p) + "<span>" + esc(p.name) + "</span></a>";
    }).join("") + "</div></div>";
  }

  /* ---------- presence: Playing now, room and Join ---------- */
  function loadPresence(id) {
    if (!ID.test(id) || id === me() || state.presenceLoading[id]) return;
    if (state.presence[id] && Date.now() - state.presence[id].at < 30000) return;
    state.presenceLoading[id] = true;
    call("/v1/games/presence?id=" + id).then(function (res) {
      delete state.presenceLoading[id];
      state.presence[id] = { at: Date.now(), body: res && res.status === 200 ? res : { playing: false } };
      paintPresence(id);
      paintProfile(id);
    });
  }
  function joinChipHtml(id, room) {
    var label = room ? tr("In ReGone, room {room}", { room: room }) : tr("Playing now");
    return '<span class="gs-live" data-gs-live="' + esc(id) + '"><i class="gs-dot" aria-hidden="true"></i><span>' + esc(label) + '</span><span role="button" tabindex="0" class="gs-join-chip" data-gs-join-room="' + esc(room || "") + '">' + esc(tr("Join")) + "</span></span>";
  }
  function presenceInner(id) {
    var got = state.presence[id];
    var b = got && got.body;
    if (!b || !b.playing) return "";
    return joinChipHtml(id, b.room || "");
  }
  function paintPresence(id) {
    document.querySelectorAll('[data-gs-presence="' + id + '"]').forEach(function (el) { el.innerHTML = presenceInner(id); });
  }
  function presenceSlotHtml(id) {
    if (!ID.test(id) || !token()) return "";
    loadPresence(id);
    return '<span class="gs-presence" data-gs-presence="' + esc(id) + '">' + presenceInner(id) + "</span>";
  }
  function inviteButtonHtml(id, name, compact) {
    if (!ID.test(id) || id === me() || !token()) return "";
    return '<button type="button" class="' + (compact ? "dmsgs-iconbtn gs-invite-icon" : "outline gs-invite-btn") + '" data-gs-invite="' + esc(id) + '" data-gs-name="' + esc(name || "") + '" aria-label="' + esc(tr("Invite to play ReGone")) + '" title="' + esc(tr("Invite to play ReGone")) + '">' + ui("pad") + (compact ? "" : "<span>" + esc(tr("Invite to play")) + "</span>") + "</button>";
  }
  function dmHeadHtml(id, name) {
    if (!ID.test(id)) return "";
    return presenceSlotHtml(id) + inviteButtonHtml(id, name, true);
  }

  /* ---------- profile: the Games tab ----------
     Everything game-related on a profile lives in its own Games tab, laid
     out like X: one section per game (ReGone today), a card with the linked
     name, rank and stats, Playing now, achievements and who they play with.
     The Worker decides what a viewer may see (canSeeGame); a hidden answer
     reads the same as "no games yet". */
  var GAMES_FLAGS = ["regone_leaderboard", "regone_profile_stats", "regone_online", "regone_rooms"];
  function profileTabAvailable(account, mine) {
    var id = account && account.publicId ? String(account.publicId) : "";
    if (!ID.test(id) || !token()) return false;
    if (!mine && account.viewerBlocks) return false;
    return GAMES_FLAGS.some(function (name) { return !serverOff(name); });
  }
  function profileTabHtml(account, mine) {
    if (!profileTabAvailable(account, mine)) return "";
    var id = String(account.publicId);
    loadAch(id);
    loadTogether(id);
    loadPstats(id);
    return '<div class="gs-ptab" data-gs-profile="' + esc(id) + '"' + (mine ? ' data-gs-mine="1"' : "") + ' data-gs-handle="' + esc(account.handle || "") + '" data-gs-name="' + esc(account.displayName || account.handle || "") + '">' + profileInner(id, !!mine, account.handle || "", account.displayName || account.handle || "") + "</div>";
  }
  /* Kept for older callers: the header no longer shows games. */
  function profileHtml() { return ""; }
  function fmtNum(n) {
    var v = Number(n);
    if (!isFinite(v)) return String(n == null ? "" : n);
    try { return v.toLocaleString(); } catch (err) { return String(v); }
  }
  function fmtHours(ms) {
    var h = (Number(ms) || 0) / 3600000;
    if (h < 1) return tr("{n} min", { n: Math.round(h * 60) });
    return tr("{n} h", { n: h >= 10 ? Math.round(h) : Math.round(h * 10) / 10 });
  }
  function statCell(label, value) {
    return '<div class="gs-cell"><dt>' + esc(label) + "</dt><dd>" + esc(value) + "</dd></div>";
  }
  function regoneCardHtml(body, pstats) {
    var r = body.rank;
    var board = !serverOff("regone_leaderboard");
    var cells = "";
    if (r && board) cells += statCell(tr("Kills"), fmtNum(r.kills)) + statCell("KDR", r.kdr) + statCell(tr("Deaths"), fmtNum(r.deaths));
    var s = !serverOff("regone_profile_stats") && pstats && pstats.ok ? pstats.stats : null;
    if (s) {
      cells += statCell(tr("Favourite weapon"), s.favouriteWeapon || "—") + statCell(tr("Headshots"), (Number(s.headshotRate) || 0) + "%") +
        statCell(tr("Multi-kills"), fmtNum(s.multiKills)) + statCell(tr("Match wins"), fmtNum(s.matchesWon));
    }
    if (Number(body.totalMs) > 0) cells += statCell(tr("Play time"), fmtHours(body.totalMs));
    if (Number(body.bestStreak) > 0) cells += statCell(tr("Best streak"), tr("{n} days", { n: body.bestStreak }));
    var rankBox = "";
    if (board) {
      rankBox = r
        ? '<div class="gs-card-rank">' + badgeSvg(r.rank === 1 ? "crown" : "trophy", 22) + "<b>#" + esc(r.rank) + "</b><small>" + esc(tr("Top 100")) + "</small></div>"
        : '<div class="gs-card-rank is-off"><small>' + esc(tr("Not on the Top 100")) + "</small></div>";
    }
    return '<div class="gs-card"><div class="gs-card-top"><div class="gs-card-id"><span class="gs-card-name">' + esc(body.linkedName || "") + '</span><span class="gs-card-sub">' + esc(tr("Claimed, not verified")) + "</span></div>" + rankBox + "</div>" +
      (cells ? '<dl class="gs-grid">' + cells + "</dl>" : "") +
      '<p class="gs-source">' + esc(tr("Source: NZlay")) + "</p></div>";
  }
  function rowHtml(attr, title, sub, danger) {
    return '<button type="button" class="set-row gs-setrow' + (danger ? " is-danger" : "") + '" ' + attr + '><span class="set-copy"><b>' + esc(title) + "</b>" + (sub ? '<span class="set-sub">' + esc(sub) + "</span>" : "") + '</span><span class="set-chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8.6 5.4 14.2 11 8.6 16.6l1.4 1.4 7-7-7-7z"/></svg></span></button>';
  }
  function profileInner(id, mine, handle, name) {
    var got = state.ach[id];
    var body = got && got.body;
    if (!body) return '<div class="gs-ptab-loading" role="status" aria-label="' + esc(tr("Loading")) + '"><span class="gs-spin" aria-hidden="true"></span></div>';
    var visible = !body.hidden;
    var claimed = visible && body.claimed && !(serverOff("regone_leaderboard") && serverOff("regone_profile_stats"));
    var earned = visible ? (body.achievements || []).length : 0;
    var together = togetherHtml(id);
    var live = mine ? "" : presenceSlotHtml(id);
    var playing = !mine && state.presence[id] && state.presence[id].body && state.presence[id].body.playing;
    if (!mine && !claimed && !earned && !together && !playing) {
      return '<div class="empty gs-ptab-empty"><h2>' + esc(tr("No games yet")) + "</h2><p>" + esc(handle ? tr("When @{handle} links a game, it shows up here.", { handle: handle }) : tr("When they link a game, it shows up here.")) + "</p></div>";
    }
    var pst = state.pstats[id] && state.pstats[id].body;
    var html = '<section class="gs-game" data-gs-game="regone" aria-label="ReGone"><header class="gs-game-head"><span class="gs-game-ico">' + ui("pad") + '</span><span class="gs-game-title"><b>ReGone</b><small>NZlay</small></span>' +
      (mine ? "" : inviteButtonHtml(id, name, false)) + "</header>";
    if (live) html += '<div class="gs-game-live">' + live + "</div>";
    if (claimed) html += regoneCardHtml(body, pst);
    else if (mine) html += '<p class="gs-game-note">' + esc(tr("Link your ReGone name to show your NZlay rank and stats here.")) + "</p>";
    if (earned || (mine && visible)) {
      html += '<details class="gs-prof-ach"><summary>' + badgeSvg("trophy", 20) + "<span>" + esc(tr("ReGone achievements")) + "</span><small>" + esc(String(earned)) + "</small></summary>" + achGridHtml(body, mine) + "</details>";
    }
    html += together;
    if (mine) {
      var board = !serverOff("regone_leaderboard") || !serverOff("regone_profile_stats");
      html += '<div class="gs-own-rows">';
      if (board && !body.claimed) html += rowHtml("data-gs-link-name", tr("Link ReGone"), tr("Shown as claimed, not verified."));
      if (board && body.claimed) html += rowHtml("data-gs-link-name", tr("Change ReGone name"), body.linkedName || "") + rowHtml("data-gs-unlink", tr("Unlink ReGone"), tr("Removes your ReGone name, rank and stats from your profile."), true);
      html += '<a class="set-row gs-setrow" href="#/settings/privacy"><span class="set-copy"><b>' + esc(tr("Who can see my games")) + '</b><span class="set-sub">' + esc(tr("Privacy > Games")) + '</span></span><span class="set-chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8.6 5.4 14.2 11 8.6 16.6l1.4 1.4 7-7-7-7z"/></svg></span></a>';
      html += "</div>";
    }
    return html + "</section>";
  }
  function paintProfile(id) {
    document.querySelectorAll('[data-gs-profile="' + id + '"]').forEach(function (el) {
      el.innerHTML = profileInner(id, el.getAttribute("data-gs-mine") === "1", el.getAttribute("data-gs-handle") || "", el.getAttribute("data-gs-name") || "");
    });
  }
  function saveLinkName(name) {
    return call("/v1/games/link-name", { method: "POST", body: { name: name } }).then(function (res) {
      if (!res || res.status !== 200) { toast(tr("Try again")); return; }
      if (res.achievements && res.achievements.length) celebrate(res.achievements);
      var id = me();
      delete state.ach[id];
      delete state.pstats[id];
      state.top = null;
      loadAch(id, true);
      loadPstats(id);
    });
  }
  function linkName() {
    var current = state.ach[me()] && state.ach[me()].body && state.ach[me()].body.linkedName || "";
    var name = window.prompt(tr("Your ReGone name, as it shows on NZlay. Shown as claimed, not verified. Leave empty to remove."), current);
    if (name == null) return;
    saveLinkName(name);
  }
  function unlinkName() {
    if (!window.confirm(tr("Unlink ReGone? Your ReGone name, rank and stats leave your profile."))) return;
    saveLinkName("");
  }

  /* ---------- Top Players ---------- */
  function topEnabled() { return !serverOff("regone_leaderboard") && !(state.top && state.top.failed); }
  function loadTop(force) {
    if (!topEnabled() || state.topLoading) return;
    if (!force && state.top && Date.now() - state.topAt < 5 * 60 * 1000) return;
    state.topLoading = call("/v1/games/regone/top").then(function (res) {
      state.topLoading = null;
      state.topAt = Date.now();
      if (!res || res.status !== 200 || !res.ok || !Array.isArray(res.players) || !res.players.length) {
        // Missing, switched off or changed shape: the tab hides.
        state.top = { failed: true };
        if (state.tab === "top") state.tab = "games";
      } else state.top = res;
      rerender();
    });
  }
  function hubTabsHtml() {
    if (!topEnabled()) return "";
    if (!state.top) loadTop(false);
    var tab = function (id, label) {
      var on = state.tab === id;
      return '<button class="tab' + (on ? " on" : "") + '" type="button" role="tab" aria-selected="' + (on ? "true" : "false") + '" data-gs-tab="' + id + '"><span>' + esc(label) + "</span></button>";
    };
    return '<div class="tabs gs-tabs" role="tablist" aria-label="' + esc(tr("Games")) + '">' + tab("games", tr("Games")) + tab("top", tr("Top Players")) + "</div>";
  }
  function topHtml() {
    var t = state.top;
    if (!t || t.failed) return '<p class="games-empty">' + esc(tr("Loading")) + "</p>";
    var friends = {};
    (t.friends || []).forEach(function (f) { friends[f.rank] = f; });
    var mineRank = t.mine && t.mine.rank || 0;
    var q = state.topQuery.toLowerCase();
    var list = t.players.filter(function (p) { return !q || String(p.name).toLowerCase().indexOf(q) >= 0; });
    var key = state.topSort;
    var dir = state.topDir;
    list.sort(function (a, b) {
      var x = key === "name" ? String(a.name).localeCompare(String(b.name)) : (Number(a[key]) || 0) - (Number(b[key]) || 0);
      return x * dir || a.rank - b.rank;
    });
    var th = function (id, label) {
      var on = state.topSort === id;
      return '<th scope="col"><button type="button" data-gs-sort="' + id + '" aria-sort="' + (on ? (dir > 0 ? "ascending" : "descending") : "none") + '">' + esc(label) + (on ? (dir > 0 ? " ↑" : " ↓") : "") + "</button></th>";
    };
    var rows = list.map(function (p) {
      var f = friends[p.rank];
      var cls = f ? " gs-friend-row" : p.rank === mineRank ? " gs-me-row" : "";
      var tag = f ? '<a class="gs-tag" href="#/@' + encodeURIComponent(f.handle || "") + '">' + avatarHtml(f) + esc(f.name) + "</a>" : p.rank === mineRank ? '<span class="gs-tag">' + esc(tr("You")) + "</span>" : "";
      return '<tr class="' + cls + '"><td>' + esc(p.rank) + '</td><td class="gs-pname">' + esc(p.name) + tag + "</td><td>" + esc(p.kills) + "</td><td>" + esc(p.kdr) + "</td><td>" + esc(p.deaths) + "</td></tr>";
    }).join("");
    return '<section class="games-rail gs-section gs-top"><h2>' + esc(tr("Top Players")) + "</h2>" +
      '<div class="gs-search">' + ui("search") + '<input type="search" data-gs-top-search placeholder="' + esc(tr("Search players")) + '" aria-label="' + esc(tr("Search players")) + '" value="' + esc(state.topQuery) + '"></div>' +
      '<div class="gs-table-wrap"><table class="gs-table"><thead><tr>' + th("rank", "#") + th("name", tr("Player")) + th("kills", tr("Kills")) + th("kdr", "KDR") + th("deaths", tr("Deaths")) + "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<p class="gs-source"><a href="' + esc(t.source || "https://nzlay.com/pages/top100") + '" target="_blank" rel="noopener noreferrer">' + esc(tr("Source: NZlay")) + "</a>" + (t.mine ? "" : ' · <button type="button" class="gs-linkbtn" data-gs-link-name>' + esc(tr("Link ReGone name")) + "</button>") + "</p></section>";
  }

  /* ---------- Games page ---------- */
  function invitesHtml() {
    var list = (state.invites.incoming || []).filter(function (x) { return x.status === "pending" && x.expiresAt > Date.now(); });
    if (!list.length) return "";
    return '<section class="games-rail gs-section"><h2>' + esc(tr("Game invites")) + '</h2><ul class="gs-invites">' + list.map(function (inv) {
      var from = inv.from || {};
      var mins = Math.max(1, Math.round((inv.expiresAt - Date.now()) / 60000));
      return '<li class="gs-invite">' + avatarHtml(from) + '<span class="gs-invite-copy"><b>' + esc(from.name || tr("A friend")) + "</b><span>" + esc([inv.room ? tr("Room {room}", { room: inv.room }) : "", inv.message ? "“" + inv.message + "”" : "", tr("{n} min left", { n: mins })].filter(Boolean).join(" · ")) + '</span></span><button type="button" class="gs-btn gs-primary" data-gs-answer="join" data-gs-id="' + esc(inv.id) + '" data-gs-room="' + esc(inv.room || "") + '">' + esc(tr("Join")) + '</button><button type="button" class="gs-btn" data-gs-answer="decline" data-gs-id="' + esc(inv.id) + '">' + esc(tr("Not now")) + "</button></li>";
    }).join("") + "</ul></section>";
  }
  function hubHtml() {
    if (!token()) return "";
    refreshInvites(false);
    loadLobby(false);
    loadFriendsRooms(false);
    loadOnline();
    return '<div data-gs-hub>' + hubInner() + "</div>";
  }
  function hubInner() {
    return '<section class="games-rail gs-section gs-actions"><div class="gs-row">' + onlineChipHtml() + '<button type="button" class="gs-btn gs-primary" data-gs-invite="">' + ui("invite") + "<span>" + esc(tr("Invite to play")) + '</span></button><button type="button" class="gs-btn" data-gs-setroom>' + ui("room") + "<span>" + esc(state.myRoom || tr("Set room")) + "</span></button></div></section>" +
      invitesHtml() + lobbyHtml() + friendsRoomsHtml() + achSectionHtml();
  }
  function paintSections() {
    var el = document.querySelector("[data-gs-hub]");
    if (el) el.innerHTML = hubInner();
  }
  function tileChipHtml() { loadOnline(); return onlineChipHtml(); }

  /* ---------- settings ---------- */
  function loadPrefs(force) {
    if (!token()) return Promise.resolve(null);
    if (state.prefs && !force) return Promise.resolve(state.prefs);
    if (state.prefsLoading) return state.prefsLoading;
    state.prefsLoading = Promise.all([call("/v1/games/prefs"), call("/v1/audience-lists")]).then(function (got) {
      state.prefsLoading = null;
      if (got[0] && got[0].status === 200) state.prefs = got[0];
      state.lists = got[1] && got[1].status === 200 ? got[1].lists || [] : [];
      paintSettings();
      scheduleReminder();
      return state.prefs;
    });
    return state.prefsLoading;
  }
  function savePrefs(body) {
    return call("/v1/games/prefs", { method: "POST", body: body }).then(function (res) {
      if (res && res.status === 200) state.prefs = res;
      else toast(tr("Try again"));
      paintSettings();
      scheduleReminder();
    });
  }
  function switchHtml(on, attr, label, desc) {
    return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" ' + attr + "><span>" + esc(label) + "</span><i></i></button>" + (desc ? '<p class="phandle set-desc">' + esc(desc) + "</p>" : "");
  }
  function hourOptions(current) {
    var out = "";
    for (var h = 0; h < 24; h++) out += '<option value="' + h + '"' + (h === Number(current) ? " selected" : "") + ">" + (h < 10 ? "0" : "") + h + ":00</option>";
    return out;
  }
  function notifyHtml() {
    if (!token()) return "";
    loadPrefs(false);
    return '<div data-gs-notify>' + notifyInner() + "</div>";
  }
  function notifyInner() {
    var p = state.prefs;
    if (!p) return "";
    var q = p.quiet || { on: false, from: 22, to: 7 };
    var x = window.XSettings;
    var hours = q.on ? (x
      ? '<div class="xs-page gs-xs">' + x.row({ title: tr("From"), value: hourLabel(q.from), attrs: 'data-gs-quiet-open="from"' }) + x.row({ title: tr("To"), value: hourLabel(q.to), attrs: 'data-gs-quiet-open="to"' }) + "</div>"
      : '<div class="gs-row gs-quiet"><label>' + esc(tr("From")) + ' <select data-gs-quiet="from">' + hourOptions(q.from) + "</select></label><label>" + esc(tr("To")) + ' <select data-gs-quiet="to">' + hourOptions(q.to) + "</select></label></div>") : "";
    return switchHtml(!!p.streakReminder, "data-gs-pref=\"streak\"", tr("Streak reminder"), tr("A nudge the evening before your ReGone streak would break. Off by default.")) +
      switchHtml(!!q.on, "data-gs-pref=\"quiet\"", tr("Quiet hours for game invites"), tr("Invites wait in the Games page and arrive without a push.")) + hours;
  }
  function hourLabel(h) { h = Number(h) || 0; return (h < 10 ? "0" : "") + h + ":00"; }
  function quietSheet(which) {
    var x = window.XSettings;
    var q = Object.assign({}, state.prefs && state.prefs.quiet || { on: true, from: 22, to: 7 });
    var opts = [];
    for (var h = 0; h < 24; h++) opts.push({ value: String(h), label: hourLabel(h) });
    x.sheet.radio({ title: which === "from" ? tr("From") : tr("To"), sub: tr("Quiet hours for game invites"), options: opts, current: String(Number(q[which]) || 0), onPick: function (v) {
      q[which] = Number(v);
      savePrefs({ quiet: q, tz: tzMin() });
    } });
  }
  var AUD_LABEL = function (v) {
    return { public: tr("Everyone"), followers: tr("Followers"), friends: tr("Mutuals"), only: tr("Only me"), list: tr("Custom") }[v] || v;
  };
  var AUD_KINDS = {};
  function privacyHtml() {
    if (!token()) return "";
    loadPrefs(false);
    return '<div data-gs-privacy>' + privacyInner() + "</div>";
  }
  function audBlock(kind, label, desc) {
    var p = state.prefs;
    var cur = p.audiences && p.audiences[kind] || "only";
    var lists = state.lists || [];
    var sel = p.lists && p.lists[kind] || { include: [], exclude: [] };
    var x = window.XSettings;
    AUD_KINDS[kind] = label;
    if (x) {
      var checks = function (which, picked) {
        if (!lists.length) return x.desc(tr("Create an audience list in Privacy and safety."));
        return lists.map(function (l) {
          return x.check({ title: l.name, on: picked.indexOf(l.id) >= 0, attrs: 'data-gs-list="' + kind + '" data-which="' + which + '" data-id="' + esc(l.id) + '"' });
        }).join("");
      };
      var excluded = (sel.exclude || []).length;
      return '<div class="gs-xs-block">' + x.row({ title: label, sub: AUD_LABEL(cur), cls: "gs-xs-aud", attrs: 'data-gs-aud-open="' + kind + '"' }) + x.desc(desc, "gs-xs-desc") +
        (cur === "list" ? '<p class="xs-label">' + esc(tr("Include")) + "</p>" + checks("include", sel.include || []) : "") +
        (cur !== "only" ? '<details class="xs-details gs-exclude"><summary class="xs-row"><span class="xs-copy"><span class="xs-title">' + esc(tr("Exclude lists")) + "</span>" + (excluded ? '<span class="xs-sub">' + esc(tr("{count} hidden", { count: excluded })) + "</span>" : "") + '</span><span class="xs-chev">' + x.icon("chev") + "</span></summary>" + checks("exclude", sel.exclude || []) + "</details>" : "") + "</div>";
    }
    var btns = ["public", "followers", "friends", "only", "list"].map(function (v) {
      var on = cur === v;
      return '<button type="button" class="outline' + (on ? " on" : "") + '" aria-pressed="' + (on ? "true" : "false") + '" data-gs-aud="' + kind + '" data-value="' + v + '">' + esc(AUD_LABEL(v)) + "</button>";
    }).join("");
    var plain = function (which, picked) {
      if (!lists.length) return '<p class="phandle">' + esc(tr("Create an audience list in Privacy and safety.")) + "</p>";
      return '<div class="aud-checks">' + lists.map(function (l) {
        var on = picked.indexOf(l.id) >= 0;
        return '<label><input type="checkbox" data-gs-list="' + kind + '" data-which="' + which + '" data-id="' + esc(l.id) + '"' + (on ? " checked" : "") + "> " + esc(l.name) + "</label>";
      }).join("") + "</div>";
    };
    return "<h3>" + esc(label) + '</h3><p class="phandle set-desc">' + esc(desc) + '</p><div class="theme-row gs-aud" role="group" aria-label="' + esc(label) + '">' + btns + "</div>" +
      (cur === "list" ? '<p class="phandle">' + esc(tr("Include")) + "</p>" + plain("include", sel.include || []) : "") +
      (cur !== "only" ? '<details class="gs-exclude"><summary>' + esc(tr("Exclude lists")) + "</summary>" + plain("exclude", sel.exclude || []) + "</details>" : "");
  }
  function audSheet(kind) {
    var p = state.prefs || {};
    var cur = p.audiences && p.audiences[kind] || "only";
    window.XSettings.sheet.radio({ title: AUD_KINDS[kind] || tr("Games"), options: ["public", "followers", "friends", "only", "list"].map(function (v) { return { value: v, label: AUD_LABEL(v) }; }), current: cur, onPick: function (v) {
      if (v === cur) return;
      var aud = {};
      aud[kind] = v;
      savePrefs({ audiences: aud });
    } });
  }
  function privacyInner() {
    var x = window.XSettings;
    if (!state.prefs) return (x ? '<div class="xs-page gs-xs">' + x.section(tr("Games")) + x.desc(tr("Loading")) + "</div>" : "<h2>" + esc(tr("Games")) + '</h2><p class="phandle">' + esc(tr("Loading")) + "</p>");
    var blocks = audBlock("together", tr("Who I play with"), tr("Shown only when both players allow the viewer. Never shown to people you block or mute.")) +
      audBlock("room", tr("Room and Playing now"), tr("Who sees that you're playing and which room you set.")) +
      audBlock("stats", tr("Achievements and play time"), tr("Also covers your claimed ReGone name, rank and NZlay stats."));
    if (x) return '<div class="xs-page gs-xs">' + x.section(tr("Games")) + blocks + x.desc(tr("Play privately is in the invite and party sheets: that session is never saved.")) +
      x.row({ title: tr("Clear play-together history"), danger: true, trail: "none", attrs: "data-gs-clear-together" }) + "</div>";
    return "<h2>" + esc(tr("Games")) + "</h2>" + blocks +
      '<p class="phandle">' + esc(tr("Play privately is in the invite and party sheets: that session is never saved.")) + "</p>" +
      '<button type="button" class="outline gs-danger" data-gs-clear-together>' + esc(tr("Clear play-together history")) + "</button>";
  }
  function paintSettings() {
    var a = document.querySelector("[data-gs-privacy]");
    if (a) a.innerHTML = privacyInner();
    var b = document.querySelector("[data-gs-notify]");
    if (b) b.innerHTML = notifyInner();
  }

  /* ---------- streak reminder (this device, off by default) ---------- */
  function scheduleReminder() {
    clearTimeout(remindTimer);
    var p = state.prefs;
    if (!p || !p.streakReminder) return;
    var now = new Date();
    var at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 0, 0);
    var wait = at - now;
    if (wait <= 0) { maybeRemind(); return; }
    remindTimer = setTimeout(maybeRemind, Math.min(wait, 6 * 3600 * 1000));
  }
  function localDay(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
  function maybeRemind() {
    var p = state.prefs;
    if (!p || !p.streakReminder) return;
    var now = new Date();
    if (now.getHours() < 18) { scheduleReminder(); return; }
    var stat = gameStat();
    if (!stat.streak || !stat.last) return;
    var today = localDay(Date.now());
    if (localDay(stat.last) === today) return;
    var yesterday = localDay(Date.now() - 86400000);
    if (localDay(stat.last) !== yesterday) return;
    if (readLocal().remindDay === today) return;
    writeLocal({ remindDay: today });
    if (quietNow()) return;
    var B = window.ViktorychAchievements;
    if (B && B.popout) {
      B.popout({
        id: "game-streak-" + today, variant: "game", kicker: tr("ReGone"), title: tr("Keep your {n}-day streak", { n: stat.streak }),
        desc: tr("Play a few minutes today so it doesn't reset."), svg: badgeSvg("flame", 28), action: tr("Play"), dismissLabel: tr("Later"),
        onAction: function (act) { if (act === "action") location.hash = "#/games/regone"; }
      });
    }
  }

  /* ---------- events ---------- */
  document.addEventListener("click", function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    var el;
    if ((el = t.closest("[data-gs-close]")) || (t.classList && t.classList.contains("gs-sheet"))) { event.preventDefault(); closeSheet(); return; }
    if ((el = t.closest("[data-gs-invite]"))) {
      event.preventDefault();
      event.stopPropagation();
      openSheet("invite", { to: el.getAttribute("data-gs-invite") || "", toName: el.getAttribute("data-gs-name") || "" });
      return;
    }
    if ((el = t.closest("[data-gs-setroom]"))) { event.preventDefault(); openSheet("room", { room: state.myRoom }); return; }
    if ((el = t.closest("[data-gs-pick]")) && state.sheet) { event.preventDefault(); state.sheet.pick = el.getAttribute("data-gs-pick"); state.sheet.error = ""; paintSheet(); return; }
    if ((el = t.closest("[data-gs-room]")) && state.sheet && el.closest(".gs-sheet")) { event.preventDefault(); state.sheet.room = el.getAttribute("data-gs-room") || ""; state.sheet.typed = ""; paintSheet(); return; }
    if ((el = t.closest("[data-gs-private]")) && state.sheet) { event.preventDefault(); state.sheet.priv = !state.sheet.priv; paintSheet(); return; }
    if ((el = t.closest("[data-gs-submit]"))) { event.preventDefault(); submitSheet(); return; }
    if ((el = t.closest("[data-gs-room-clear]"))) { event.preventDefault(); setRoom("").then(closeSheet); return; }
    if ((el = t.closest("[data-gs-join-room]"))) {
      event.preventDefault();
      event.stopPropagation();
      openWithRoom(el.getAttribute("data-gs-join-room") || "");
      return;
    }
    if ((el = t.closest("[data-gs-copy]"))) { event.preventDefault(); copyText(el.getAttribute("data-gs-copy") || "").then(function (ok) { toast(ok ? tr("Room name copied") : tr("Try again")); }); return; }
    if ((el = t.closest("[data-gs-hint-close]"))) { event.preventDefault(); var h = el.closest(".gs-hint"); if (h) h.remove(); state.hintRoom = ""; return; }
    if ((el = t.closest("[data-gs-answer]"))) { event.preventDefault(); answer(el.getAttribute("data-gs-id"), el.getAttribute("data-gs-answer"), el.getAttribute("data-gs-room") || ""); return; }
    if ((el = t.closest("[data-gs-lobby-new]"))) { event.preventDefault(); openSheet("lobby"); return; }
    if ((el = t.closest("[data-gs-lobby-ready]"))) {
      event.preventDefault();
      var mine = state.lobby && (state.lobby.members || []).filter(function (m) { return m.me; })[0];
      lobbyAct("ready", { ready: !(mine && mine.ready) });
      return;
    }
    if ((el = t.closest("[data-gs-lobby-room]"))) {
      event.preventDefault();
      var room = window.prompt(tr("Room name"), state.lobby && state.lobby.room || "");
      if (room != null) lobbyAct("room", { room: room });
      return;
    }
    if ((el = t.closest("[data-gs-lobby-invite]"))) { event.preventDefault(); openSheet("invite", { lobbyId: state.lobby && state.lobby.id, room: state.lobby && state.lobby.room || "" }); return; }
    if ((el = t.closest("[data-gs-lobby-launch]"))) { event.preventDefault(); lobbyAct("launch"); return; }
    if ((el = t.closest("[data-gs-lobby-leave]"))) { event.preventDefault(); lobbyAct("leave"); return; }
    if ((el = t.closest("[data-gs-tab]"))) { event.preventDefault(); state.tab = el.getAttribute("data-gs-tab") === "top" ? "top" : "games"; if (state.tab === "top") loadTop(false); rerender(); return; }
    if ((el = t.closest("[data-gs-sort]"))) {
      event.preventDefault();
      var key = el.getAttribute("data-gs-sort");
      if (state.topSort === key) state.topDir = -state.topDir;
      else { state.topSort = key; state.topDir = key === "kills" || key === "kdr" ? -1 : 1; }
      paintTop();
      return;
    }
    if ((el = t.closest("[data-gs-link-name]"))) { event.preventDefault(); linkName(); return; }
    if ((el = t.closest("[data-gs-unlink]"))) { event.preventDefault(); unlinkName(); return; }
    if ((el = t.closest("[data-gs-aud-open]")) && window.XSettings) { event.preventDefault(); audSheet(el.getAttribute("data-gs-aud-open")); return; }
    if ((el = t.closest("[data-gs-quiet-open]")) && window.XSettings) { event.preventDefault(); quietSheet(el.getAttribute("data-gs-quiet-open")); return; }
    if ((el = t.closest("[data-gs-aud]"))) {
      event.preventDefault();
      var aud = {};
      aud[el.getAttribute("data-gs-aud")] = el.getAttribute("data-value");
      savePrefs({ audiences: aud });
      return;
    }
    if ((el = t.closest("[data-gs-pref]"))) {
      event.preventDefault();
      var p = state.prefs || {};
      if (el.getAttribute("data-gs-pref") === "streak") savePrefs({ streakReminder: !p.streakReminder, tz: tzMin() });
      else { var q = p.quiet || { on: false, from: 22, to: 7 }; savePrefs({ quiet: { on: !q.on, from: q.from, to: q.to }, tz: tzMin() }); }
      return;
    }
    if ((el = t.closest("[data-gs-clear-together]"))) {
      event.preventDefault();
      if (!window.confirm(tr("Clear who you've played ReGone with? This can't be undone."))) return;
      call("/v1/games/together", { method: "DELETE" }).then(function (res) {
        toast(res && res.status === 200 ? tr("Play-together history cleared") : tr("Try again"));
        state.together = {};
      });
    }
  }, true);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.sheet) { closeSheet(); return; }
    var t = event.target;
    if ((event.key === "Enter" || event.key === " ") && t && t.closest && t.closest("[data-gs-join-room]") && t.getAttribute("role") === "button") {
      event.preventDefault();
      openWithRoom(t.getAttribute("data-gs-join-room") || "");
    }
  });
  document.addEventListener("input", function (event) {
    var t = event.target;
    if (!t || !t.closest) return;
    var s = state.sheet;
    if (s && t.matches("[data-gs-room-filter]")) { s.filter = t.value; repaintKeepFocus(t, "[data-gs-room-filter]"); return; }
    if (s && t.matches("[data-gs-room-typed]")) { s.typed = t.value; s.error = ""; repaintKeepFocus(t, "[data-gs-room-typed]"); return; }
    if (s && t.matches("[data-gs-msg]")) {
      s.msg = t.value;
      var n = Array.from(t.value).length;
      var c = document.querySelector("[data-gs-count]");
      if (c) { c.textContent = n + "/140"; c.classList.toggle("over", n > 140); }
      var check = messageCheck(t.value);
      var err = document.querySelector("[data-gs-error]");
      if (err) err.textContent = check.ok ? "" : check.error === "links" ? tr("Messages can't have links.") : tr("Keep it to 140 characters.");
      return;
    }
    if (t.matches("[data-gs-top-search]")) { state.topQuery = t.value; paintTop(); }
  });
  document.addEventListener("change", function (event) {
    var t = event.target;
    if (!t || !t.matches) return;
    if (state.sheet && t.matches("[data-gs-filter]")) { state.sheet[t.getAttribute("data-gs-filter")] = t.value; paintSheet(); return; }
    if (t.matches("[data-gs-quiet]")) {
      var q = Object.assign({}, state.prefs && state.prefs.quiet || { on: true, from: 22, to: 7 });
      q[t.getAttribute("data-gs-quiet")] = Number(t.value);
      savePrefs({ quiet: q, tz: tzMin() });
      return;
    }
    if (t.matches("[data-gs-list]")) {
      var kind = t.getAttribute("data-gs-list");
      var which = t.getAttribute("data-which");
      var cur = state.prefs && state.prefs.lists && state.prefs.lists[kind] || { include: [], exclude: [] };
      var picked = (cur[which] || []).filter(function (id) { return id !== t.getAttribute("data-id"); });
      if (t.checked) picked.push(t.getAttribute("data-id"));
      var lists = {};
      lists[kind] = {};
      lists[kind][which] = picked;
      savePrefs({ lists: lists });
    }
  });
  function repaintKeepFocus(input, selector) {
    var pos = input.selectionStart;
    paintSheet();
    var again = document.querySelector(".gs-sheet " + selector);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* search inputs */ } }
  }
  function paintTop() {
    var el = document.querySelector(".gs-top");
    if (!el) return;
    var input = el.querySelector("[data-gs-top-search]");
    var focused = input && document.activeElement === input;
    var pos = input ? input.selectionStart : 0;
    var wrap = document.createElement("div");
    wrap.innerHTML = topHtml();
    el.replaceWith(wrap.firstChild);
    if (focused) {
      var again = document.querySelector("[data-gs-top-search]");
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* ignore */ } }
    }
  }

  /* The NZlay hook stays off. When enabled it accepts only NZlay's origin and
     the game frame itself, and only a room name. */
  window.addEventListener("message", function (event) {
    if (!NZLAY_HOOK) return;
    if (event.origin !== NZLAY_ORIGIN) return;
    var frame = document.querySelector("#game-host iframe");
    if (!frame || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.type !== "regone-room" || typeof data.room !== "string") return;
    setRoom(data.room);
  });

  window.addEventListener("pagehide", function () { clearRoom(true); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { refreshInvites(false); scheduleReminder(); }
  });

  function boot() {
    if (!token()) { setTimeout(boot, 4000); return; }
    startPoll();
    refreshInvites(true);
    loadPrefs(false);
    // Messages from the service worker when a push is tapped.
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", function (event) {
      var d = event.data;
      if (d && d.type === "game-invite-answer" && d.id) answer(d.id, d.act === "decline" ? "decline" : "join");
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(boot, 1500); });
  else setTimeout(boot, 1500);

  window.ViktorychGameSocial = {
    onChannel: onChannel,
    handleRoute: handleRoute,
    hubTabsHtml: hubTabsHtml,
    hubHtml: hubHtml,
    topHtml: topHtml,
    tab: function () { return topEnabled() ? state.tab : "games"; },
    tileChipHtml: tileChipHtml,
    onlineChipHtml: onlineChipHtml,
    roomChipHtml: roomChipHtml,
    profileHtml: profileHtml,
    profileTabAvailable: profileTabAvailable,
    profileTabHtml: profileTabHtml,
    inviteButtonHtml: inviteButtonHtml,
    dmHeadHtml: dmHeadHtml,
    joinChipHtml: joinChipHtml,
    presenceSlotHtml: presenceSlotHtml,
    notifyHtml: notifyHtml,
    privacyHtml: privacyHtml,
    celebrate: celebrate,
    openInvite: function (to, name) { openSheet("invite", { to: to || "", toName: name || "" }); },
    openRoom: function () { openSheet("room", { room: state.myRoom }); },
    showHint: showHint,
    leftGame: function () { clearRoom(false); state.hintRoom = ""; },
    myRoom: function () { return state.myRoom; },
    badgeSvg: badgeSvg,
    achCopy: achCopy,
    _state: state
  };
})();
