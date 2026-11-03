/* Presence dots, last seen, and custom status.
   The heartbeat stays on a one-minute timer while the tab is visible.
   A hibernating WebSocket carries changes. It connects only while the
   page is visible and closes when the page is hidden. If the socket is
   down, the same visible tab reads presence about once a minute. */

import {
  HEARTBEAT_MS,
  IDLE_MS,
  PRESENCE_CLIENT_MS,
  WATCH_LIMIT,
  isAccountId,
  lastSeenPhrase,
  shouldConnect
} from "./shared/presence.js";

const CHOICE_IDS = ["online", "idle", "dnd", "invisible"];
const PRIVACY_IDS = ["everyone", "followers", "mutuals", "follows", "lists", "nobody"];
const CLEAR_IDS = ["30m", "1h", "4h", "today", "week", "never"];

const cache = new Map();
let mine = null;
let socket = null;
let wantSocket = false;
let reconnectTimer = 0;
let attempt = 0;
let heartTimer = 0;
let idleTimer = 0;
let pollTimer = 0;
let watchTimer = 0;
let lastInput = Date.now();
let lastActivity = "";
let lastBeatAt = 0;
let hiddenBeat = false;
let watchKey = "";
let polledAt = 0;
let sheet = null;
let sheetAnchor = null;
let audioCtx = null;
let audienceLists = [];
let ownedEmojis = [];
let friends = [];
let friendsAt = 0;
let friendsLoading = null;
let friendsLoaded = false;
let friendsQuery = "";
let friendsFilter = "all";
let railQuery = "";
let railTo = "";
let railNote = "";
const noteListeners = [];

function tr(key, vars) {
  const fn = window.t || (window.SI18n && window.SI18n.t);
  return fn ? fn(key, vars) : key;
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;";
  });
}

function accounts() {
  return window.ViktorychAccounts || null;
}

function selfId() {
  const api = accounts();
  const account = api && api.account && api.account();
  const id = account && account.publicId;
  return isAccountId(id) ? id : "";
}

function token() {
  const api = accounts();
  const value = api && api.token && api.token();
  return value ? String(value) : "";
}

function visibility() {
  return document.visibilityState || "hidden";
}

function visible() {
  return shouldConnect(visibility());
}

function call(path, opts) {
  const api = accounts();
  if (!api || !api.call || !token()) return Promise.resolve(null);
  const next = Object.assign({ token: token() }, opts || {});
  return api.call(path, next).catch(function () { return null; });
}

function applyMine(body) {
  const id = selfId();
  if (!id || !body) return;
  const prev = mine || {};
  mine = {
    id: id,
    state: body.state || prev.state || "offline",
    exact: true,
    lastSeen: body.lastSeen != null ? Number(body.lastSeen) || 0 : (prev.lastSeen || 0),
    emoji: body.emoji != null ? body.emoji : (prev.emoji || ""),
    text: body.text != null ? body.text : (prev.text || ""),
    preference: body.preference || prev.preference || "online",
    seenPrivacy: body.seenPrivacy || prev.seenPrivacy || "everyone",
    reciprocal: body.reciprocal != null ? !!body.reciprocal : (prev.reciprocal != null ? !!prev.reciprocal : true),
    seenLists: Array.isArray(body.seenLists) ? body.seenLists.slice() : (prev.seenLists || []).slice(),
    statusAudience: body.statusAudience || prev.statusAudience || "everyone",
    statusLists: Array.isArray(body.statusLists) ? body.statusLists.slice() : (prev.statusLists || []).slice(),
    clearAt: body.clearAt != null ? Number(body.clearAt) || 0 : (prev.clearAt || 0)
  };
  cache.set(id, { view: mine, at: Date.now() });
}

function remember(view) {
  if (!view || !isAccountId(view.id)) return;
  const id = view.id;
  if (id === selfId() && mine) {
    view.preference = view.preference || mine.preference;
    view.seenPrivacy = view.seenPrivacy || mine.seenPrivacy;
    if (view.state === "offline" && mine.preference === "invisible") view.state = "invisible";
  }
  cache.set(id, { view: view, at: Date.now() });
  if (id === selfId()) mine = view;
}

function cached(id) {
  if (mine && mine.id === id) return mine;
  const row = cache.get(id);
  return row ? row.view : null;
}

function fresh(id) {
  const row = cache.get(id);
  return !!(row && Date.now() - row.at < PRESENCE_CLIENT_MS);
}

function phrase(view) {
  if (!view) return "";
  const spoken = lastSeenPhrase(view.lastSeen, Date.now(), view.exact !== false, view.state);
  if (!spoken.key) return "";
  return tr(spoken.key, spoken.vars || undefined);
}

function statusText(view) {
  if (!view) return "";
  if (view.playing && view.room) return tr("In {game}, room {room}", { game: view.playing, room: view.room });
  if (view.playing) return tr("Playing {game}", { game: view.playing });
  return [view.emoji, view.text].filter(Boolean).join(" ");
}

function lineText(view) {
  const status = statusText(view);
  const seen = phrase(view);
  if (status && seen) return status + " · " + seen;
  return status || seen;
}

function activityNow() {
  if (!visible()) return "hidden";
  if (Date.now() - lastInput >= IDLE_MS) return "idle";
  return "active";
}

const SHARED_BEAT = "viktorych-presence-beat";
function sharedBeatFresh() {
  try { return Date.now() - Number(localStorage.getItem(SHARED_BEAT) || 0) < HEARTBEAT_MS - 5000; }
  catch (err) { return false; }
}

function beat(force) {
  if (!token() || !isAccountId(selfId())) return;
  const activity = activityNow();
  if (!force && activity === lastActivity && Date.now() - lastBeatAt < HEARTBEAT_MS) return;
  // With several tabs open, one routine heartbeat per minute covers them all.
  if (!force && activity === "active" && sharedBeatFresh()) { lastActivity = activity; lastBeatAt = Date.now(); return; }
  lastActivity = activity;
  lastBeatAt = Date.now();
  if (activity === "active") { try { localStorage.setItem(SHARED_BEAT, String(lastBeatAt)); } catch (err) { /* this tab beats on its own */ } }
  call("/v1/presence", { method: "POST", body: { activity: activity } }).then(function (body) {
    if (!body || body.status !== 200) return;
    applyMine(body);
    paint();
  });
}

function armHeart() {
  clearInterval(heartTimer);
  clearTimeout(idleTimer);
  if (!visible()) return;
  heartTimer = setInterval(function () { beat(false); }, HEARTBEAT_MS);
  idleTimer = setTimeout(function () { beat(true); }, Math.max(1000, IDLE_MS - (Date.now() - lastInput)));
}

function noteInput() {
  const was = lastActivity;
  lastInput = Date.now();
  if (visible() && (was === "idle" || was === "hidden")) beat(true);
  clearTimeout(idleTimer);
  if (visible()) idleTimer = setTimeout(function () { beat(true); }, IDLE_MS);
}

function currentIds() {
  const ids = [];
  const root = document.getElementById("app") || document.body;
  root.querySelectorAll("[data-pid], [data-pid-line], [data-pid-status]").forEach(function (el) {
    const id = el.getAttribute("data-pid") || el.getAttribute("data-pid-line") || el.getAttribute("data-pid-status") || "";
    if (isAccountId(id) && id !== selfId() && ids.indexOf(id) < 0 && ids.length < WATCH_LIMIT) ids.push(id);
  });
  ids.sort();
  return ids;
}

function socketOpen() {
  return !!(socket && socket.readyState === 1);
}

function sendWatch(ids) {
  if (!socketOpen()) return;
  try { socket.send(JSON.stringify({ op: "watch", topic: "presence", ids: ids })); }
  catch (err) { /* the close handler reconnects while the page stays visible */ }
}

function syncWatch() {
  const ids = currentIds();
  const key = ids.join(",");
  if (key === watchKey) return;
  watchKey = key;
  if (socketOpen()) sendWatch(ids);
  else if (visible() && ids.length) poll(true);
}

function poll(force) {
  if (!visible() || socketOpen() || !token()) return;
  const ids = watchKey ? watchKey.split(",").filter(isAccountId) : currentIds();
  if (!ids.length) return;
  if (!force && Date.now() - polledAt < HEARTBEAT_MS) return;
  const missing = ids.some(function (id) { return !fresh(id); });
  if (!force && !missing && Date.now() - polledAt < HEARTBEAT_MS) return;
  polledAt = Date.now();
  call("/v1/presence?ids=" + ids.slice(0, 40).join(",")).then(function (body) {
    if (!body || body.status !== 200 || !Array.isArray(body.presence)) return;
    body.presence.forEach(remember);
    paint();
  });
}

function armPoll() {
  clearInterval(pollTimer);
  if (!visible() || socketOpen()) return;
  pollTimer = setInterval(function () { poll(true); }, HEARTBEAT_MS);
}

function notifyChannel(msg) {
  for (let i = 0; i < noteListeners.length; i++) {
    try { noteListeners[i](msg); }
    catch (err) { /* a listener cannot break presence */ }
  }
}

function onChannel(fn) {
  if (typeof fn !== "function" || noteListeners.indexOf(fn) >= 0) return;
  noteListeners.push(fn);
}

function offChannel(fn) {
  const at = noteListeners.indexOf(fn);
  if (at >= 0) noteListeners.splice(at, 1);
}

function onSocketMessage(event) {
  let msg = null;
  try { msg = JSON.parse(String(event.data || "")); }
  catch (err) { return; }
  if (!msg) return;
  if (msg.op === "event" && (msg.topic === "notifications" || msg.topic === "sync" || msg.topic === "p2p" || msg.topic === "srv")) {
    notifyChannel(msg);
    return;
  }
  if (msg.op !== "event" || msg.topic !== "presence") return;
  const view = msg.data || {};
  view.id = msg.id || view.id;
  remember(view);
  paint();
}

function connect() {
  if (!visible() || !token() || !isAccountId(selfId())) return;
  const api = accounts();
  const root = api && api.currentApi && api.currentApi();
  if (!root) return;
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  wantSocket = true;
  call("/v1/channel/ticket", { method: "POST", body: {} }).then(function (body) {
    if (!wantSocket || !visible()) return;
    if (!body || body.status !== 200 || !body.ticket) {
      scheduleReconnect();
      return;
    }
    const wsRoot = String(root).replace(/^http/i, "ws");
    let ws = null;
    try { ws = new WebSocket(wsRoot + "/v1/channel?ticket=" + encodeURIComponent(body.ticket)); }
    catch (err) {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener("open", function () {
      attempt = 0;
      try {
        ws.send(JSON.stringify({ op: "subscribe", topics: ["presence", "notifications", "sync", "posts", "p2p", "srv", "games"] }));
        ws.send(JSON.stringify({ op: "watch", topic: "presence", ids: currentIds() }));
      } catch (err) { /* close reconnects */ }
      clearInterval(pollTimer);
      notifyChannel({ op: "state", open: true });
    });
    ws.addEventListener("message", onSocketMessage);
    ws.addEventListener("close", function () {
      if (socket === ws) socket = null;
      notifyChannel({ op: "state", open: false });
      if (wantSocket && visible()) {
        armPoll();
        scheduleReconnect();
      }
    });
    ws.addEventListener("error", function () {
      try { ws.close(); } catch (err) { /* close follows */ }
    });
  });
}

function scheduleReconnect() {
  if (!wantSocket || !visible()) return;
  const delays = [5000, 15000, 60000];
  const wait = delays[Math.min(attempt, delays.length - 1)];
  attempt += 1;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, wait);
}

function closeSocket() {
  wantSocket = false;
  clearTimeout(reconnectTimer);
  clearInterval(pollTimer);
  const current = socket;
  socket = null;
  if (!current) return;
  try { current.close(); } catch (err) { /* already closed */ }
}

function onVisibility() {
  if (!visible()) {
    closeSocket();
    clearInterval(heartTimer);
    clearTimeout(idleTimer);
    if (!hiddenBeat) {
      hiddenBeat = true;
      beat(true);
    }
    return;
  }
  hiddenBeat = false;
  armHeart();
  beat(true);
  connect();
  armPoll();
  loadFriends(false);
}

function paint(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-pid]").forEach(function (el) {
    const id = el.getAttribute("data-pid") || "";
    const view = cached(id);
    const state = view && view.state ? view.state : "";
    if (el.getAttribute("data-presence") !== state) el.setAttribute("data-presence", state);
    if (view && view.playing && state !== "offline") el.setAttribute("data-playing", "1");
    else el.removeAttribute("data-playing");
    const emoji = view && view.emoji ? String(view.emoji) : "";
    if (emoji) el.setAttribute("data-status-emoji", "1");
    else el.removeAttribute("data-status-emoji");
    const badge = el.querySelector(".status-badge");
    if (badge && badge.textContent !== emoji) badge.textContent = emoji;
    const label = lineText(view);
    if (label) el.setAttribute("title", label);
  });
  scope.querySelectorAll("[data-pid-line]").forEach(function (el) {
    const view = cached(el.getAttribute("data-pid-line") || "");
    el.textContent = lineText(view);
  });
  scope.querySelectorAll("[data-pid-status]").forEach(function (el) {
    const view = cached(el.getAttribute("data-pid-status") || "");
    const fallback = el.getAttribute("data-fallback") || "";
    el.textContent = (view && (statusText(view) || phrase(view))) || fallback;
  });
}

function refresh(root) {
  paint(root || document);
  clearTimeout(watchTimer);
  watchTimer = setTimeout(syncWatch, 250);
}

function choiceCopy(id) {
  if (id === "online") return [tr("Online"), tr("Idle after about 5 minutes away")];
  if (id === "idle") return [tr("Idle"), tr("Always shown as idle")];
  if (id === "dnd") return [tr("Do not disturb"), tr("Mutes notification sounds and toasts")];
  return [tr("Invisible"), tr("Appears offline")];
}

function privacyCopy(id) {
  if (id === "followers") return tr("My followers");
  if (id === "mutuals") return tr("Mutuals");
  if (id === "follows") return tr("People I follow and my followers");
  if (id === "lists") return tr("Custom lists");
  if (id === "nobody") return tr("Nobody");
  return tr("Everyone");
}

function clearCopy(id) {
  if (id === "30m") return tr("30 minutes");
  if (id === "1h") return tr("1 hour");
  if (id === "4h") return tr("4 hours");
  if (id === "today") return tr("Today");
  if (id === "week") return tr("This week");
  return tr("Never");
}

function choiceRows(selected, name) {
  return CHOICE_IDS.map(function (id) {
    const on = selected === id;
    const copy = choiceCopy(id);
    return '<button type="button" class="presence-choice' + (on ? " on" : "") + '" data-presence="' + name + '" data-value="' + id + '" aria-pressed="' + (on ? "true" : "false") + '"><b>' + esc(copy[0]) + '</b><span>' + esc(copy[1]) + '</span></button>';
  }).join("");
}

function privacyRows(selected) {
  return PRIVACY_IDS.map(function (id) {
    const on = selected === id;
    return '<button type="button" class="presence-choice' + (on ? " on" : "") + '" data-presence="privacy" data-value="' + id + '" aria-pressed="' + (on ? "true" : "false") + '"><b>' + esc(privacyCopy(id)) + '</b></button>';
  }).join("");
}

function listRows() {
  if (!mine || mine.seenPrivacy !== "lists") return "";
  if (!audienceLists.length) return '<p class="presence-note">' + esc(tr("Create a list to choose who sees you.")) + "</p>";
  const selected = mine.seenLists || [];
  return '<div class="presence-lists">' + audienceLists.map(function (list) {
    const id = String(list.id || "");
    const on = selected.indexOf(id) >= 0;
    return '<button type="button" class="presence-choice' + (on ? " on" : "") + '" data-presence="list" data-value="' + esc(id) + '" aria-pressed="' + (on ? "true" : "false") + '"><b>' + esc(list.name || tr("Custom lists")) + "</b></button>";
  }).join("") + "</div>";
}

/* Who sees the custom status: the same choices as last seen, saved on their own. */
function statusAudienceRows() {
  const selected = (mine && mine.statusAudience) || "everyone";
  return PRIVACY_IDS.map(function (id) {
    const on = selected === id;
    return '<button type="button" class="presence-choice' + (on ? " on" : "") + '" data-presence="status-audience" data-value="' + id + '" aria-pressed="' + (on ? "true" : "false") + '"><b>' + esc(privacyCopy(id)) + '</b></button>';
  }).join("");
}

function statusListRows() {
  if (!mine || mine.statusAudience !== "lists") return "";
  if (!audienceLists.length) return '<p class="presence-note">' + esc(tr("Create a list to choose who sees you.")) + "</p>";
  const selected = mine.statusLists || [];
  return '<div class="presence-lists">' + audienceLists.map(function (list) {
    const id = String(list.id || "");
    const on = selected.indexOf(id) >= 0;
    return '<button type="button" class="presence-choice' + (on ? " on" : "") + '" data-presence="status-list" data-value="' + esc(id) + '" aria-pressed="' + (on ? "true" : "false") + '"><b>' + esc(list.name || tr("Custom lists")) + "</b></button>";
  }).join("") + "</div>";
}

/* Status emojis from the store that this account owns, one tap to pick. */
function ownedEmojiRow() {
  const current = (mine && mine.emoji) || "";
  const owned = ownedEmojis.map(function (item) {
    const on = current === item.emoji;
    return '<button type="button" class="presence-emoji' + (on ? " on" : "") + '" data-presence="pick-emoji" data-value="' + esc(item.emoji) + '" aria-pressed="' + (on ? "true" : "false") + '" aria-label="' + esc(item.name ? tr(item.name) : tr("Status emoji")) + '">' + esc(item.emoji) + "</button>";
  }).join("");
  return '<div class="presence-emojis">' + owned + '<a class="presence-emoji-more" href="#/store/emojis" data-presence="close">' + esc(tr("Get status emojis")) + "</a></div>";
}

function reciprocalRow() {
  const on = !mine || mine.reciprocal !== false;
  return '<button type="button" class="presence-switch' + (on ? " on" : "") + '" role="switch" data-presence="reciprocal" aria-checked="' + (on ? "true" : "false") + '"><span>' + esc(tr("Hide their presence when they can’t see mine")) + "</span><i></i></button>";
}

function formHtml() {
  const pref = (mine && mine.preference) || "online";
  const privacy = (mine && mine.seenPrivacy) || "everyone";
  const clear = "never";
  const options = CLEAR_IDS.map(function (id) {
    return '<option value="' + id + '"' + (clear === id ? " selected" : "") + '>' + esc(clearCopy(id)) + '</option>';
  }).join("");
  return '<div class="presence-form">' +
    '<p class="presence-kicker">' + esc(tr("Your status")) + '</p>' +
    choiceRows(pref, "preference") +
    '<p class="presence-kicker">' + esc(tr("Custom status")) + '</p>' +
    '<div class="presence-status">' +
      '<input data-presence-emoji maxlength="16" placeholder="' + esc(tr("Emoji")) + '" aria-label="' + esc(tr("Emoji")) + '" value="' + esc(mine && mine.emoji || "") + '">' +
      '<input data-presence-text maxlength="80" placeholder="' + esc(tr("Status text")) + '" aria-label="' + esc(tr("Status text")) + '" value="' + esc(mine && mine.text || "") + '">' +
    '</div>' +
    ownedEmojiRow() +
    '<label class="presence-clear">' + esc(tr("Clear after")) +
      '<select data-presence-clear aria-label="' + esc(tr("Clear after")) + '">' + options + '</select></label>' +
    '<div class="presence-actions"><button type="button" class="presence-save" data-presence="save">' + esc(tr("Save")) + '</button>' +
      '<button type="button" class="presence-textbtn" data-presence="clear-status">' + esc(tr("Clear status")) + '</button></div>' +
    '<p class="presence-kicker">' + esc(tr("Who can see my status")) + '</p>' +
    statusAudienceRows() +
    '<div data-status-lists>' + statusListRows() + '</div>' +
    '<p class="presence-kicker">' + esc(tr("Who can see my last seen")) + '</p>' +
    '<p class="presence-note">' + esc(tr("Last seen and online")) + '</p>' +
    privacyRows(privacy) +
    '<div data-presence-lists>' + listRows() + '</div>' +
    reciprocalRow() +
    '<p class="presence-note" data-presence-note></p>' +
  '</div>';
}

function settingsHtml() {
  return '<div class="presence-settings"><h2>' + esc(tr("Last seen and online")) + '</h2>' + formHtml() + '</div>';
}

function ensureSheet() {
  if (sheet) return sheet;
  sheet = document.createElement("div");
  sheet.className = "presence-sheet";
  sheet.hidden = true;
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", tr("Your status"));
  sheet.innerHTML = '<div class="presence-card"></div>';
  document.body.appendChild(sheet);
  return sheet;
}

function fillSheet() {
  if (!sheet) return;
  const card = sheet.querySelector(".presence-card");
  card.innerHTML = '<div class="presence-grab"></div>' + formHtml();
}

function placeSheet() {
  if (!sheet || sheet.hidden) return;
  const wide = window.innerWidth >= 700;
  sheet.classList.toggle("presence-pop", wide && !!sheetAnchor);
  const card = sheet.querySelector(".presence-card");
  if (!wide || !sheetAnchor) {
    card.style.left = "";
    card.style.bottom = "";
    return;
  }
  const rect = sheetAnchor.getBoundingClientRect();
  card.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 336)) + "px";
  card.style.bottom = Math.max(8, window.innerHeight - rect.top + 8) + "px";
}

function open(anchor) {
  if (!token()) return;
  sheetAnchor = anchor || null;
  ensureSheet();
  sheet.hidden = false;
  fillSheet();
  placeSheet();
  call("/v1/presence").then(function (body) {
    if (!body || body.status !== 200) return;
    applyMine(body);
    fillSheet();
    paint();
  });
  call("/v1/audience-lists").then(function (body) {
    if (!body || body.status !== 200 || !Array.isArray(body.lists)) return;
    audienceLists = body.lists;
    if (sheet && !sheet.hidden) fillSheet();
  });
  call("/v1/store/catalog").then(function (body) {
    if (!body || body.status !== 200 || !Array.isArray(body.emojis)) return;
    ownedEmojis = body.emojis.filter(function (item) { return item && item.owned && item.emoji; });
    if (sheet && !sheet.hidden) fillSheet();
  });
}

function close() {
  if (sheet) sheet.hidden = true;
  sheetAnchor = null;
}

function readBox(root) {
  const emoji = root.querySelector("[data-presence-emoji]");
  const text = root.querySelector("[data-presence-text]");
  const clear = root.querySelector("[data-presence-clear]");
  return {
    emoji: emoji ? emoji.value : "",
    text: text ? text.value : "",
    clear: clear ? clear.value : "never"
  };
}

function note(root, text) {
  const el = root && root.querySelector("[data-presence-note]");
  if (el) el.textContent = text || "";
}

function save(root, status) {
  const body = {};
  if (mine && mine.preference) body.preference = mine.preference;
  if (mine && mine.seenPrivacy) body.seenPrivacy = mine.seenPrivacy;
  body.reciprocal = !mine || mine.reciprocal !== false;
  body.seenLists = (mine && mine.seenLists) || [];
  if (status === null) body.status = null;
  else if (status) {
    const end = new Date();
    if (status.clear === "today") end.setHours(24, 0, 0, 0);
    if (status.clear === "week") {
      const day = end.getDay();
      const add = (8 - (day || 7)) % 7 || 7;
      end.setDate(end.getDate() + add);
      end.setHours(0, 0, 0, 0);
    }
    body.status = { emoji: status.emoji, text: status.text, clear: status.clear, clearAt: status.clear === "today" || status.clear === "week" ? end.getTime() : 0 };
  }
  return call("/v1/presence", { method: "PATCH", body: body }).then(function (res) {
    if (!res || res.status !== 200) {
      note(root, res && res.error === "owned" ? tr("This emoji is not in your collection.") : tr("Couldn’t save your status."));
      return;
    }
    applyMine(res);
    note(root, tr("Status saved"));
    paint();
    const api = accounts();
    if (api && api.requestRender) api.requestRender();
  });
}

function saveAudience(root) {
  const body = {
    statusAudience: (mine && mine.statusAudience) || "everyone",
    statusLists: (mine && mine.statusLists) || []
  };
  return call("/v1/presence", { method: "PATCH", body: body }).then(function (res) {
    if (!res || res.status !== 200) {
      note(root, tr("Couldn’t save your status."));
      return;
    }
    applyMine(res);
    note(root, tr("Status saved"));
  });
}

function onClick(event) {
  const face = event.target && event.target.closest && event.target.closest("[data-rail-face]");
  if (face) {
    // A face in the collapsed strip: open the panel on that friend's chat.
    event.preventDefault();
    openRailChat(face.closest(".friends-rail"), face.getAttribute("data-rail-face") || "");
    return;
  }
  const el = event.target && event.target.closest && event.target.closest("[data-presence]");
  if (!el) {
    if (sheet && !sheet.hidden && event.target === sheet) close();
    return;
  }
  const act = el.getAttribute("data-presence");
  const root = el.closest(".presence-form") || document;
  if (act === "preference" || act === "privacy") {
    event.preventDefault();
    const value = el.getAttribute("data-value") || "";
    if (!mine) mine = { id: selfId(), exact: true, preference: "online", seenPrivacy: "everyone", reciprocal: true, seenLists: [], state: "offline", emoji: "", text: "" };
    if (act === "preference") {
      mine.preference = value;
      if (value === "invisible") mine.state = "invisible";
      else if (value === "dnd") mine.state = "dnd";
      else if (value === "idle") mine.state = "idle";
      else mine.state = "online";
    } else mine.seenPrivacy = value;
    cache.set(selfId(), { view: mine, at: Date.now() });
    paint();
    const box = el.closest(".presence-card, .presence-settings") || document.body;
    box.querySelectorAll('[data-presence="' + act + '"]').forEach(function (button) {
      const on = button.getAttribute("data-value") === value;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const host = box.querySelector("[data-presence-lists]");
    if (host && act === "privacy") host.innerHTML = listRows();
    save(root);
    return;
  }
  if (act === "list") {
    event.preventDefault();
    const id = el.getAttribute("data-value") || "";
    if (!mine) mine = { id: selfId(), exact: true, preference: "online", seenPrivacy: "lists", reciprocal: true, seenLists: [], state: "offline", emoji: "", text: "" };
    const selected = (mine.seenLists || []).slice();
    const at = selected.indexOf(id);
    if (at >= 0) selected.splice(at, 1);
    else if (id) selected.push(id);
    mine.seenLists = selected;
    const on = selected.indexOf(id) >= 0;
    el.classList.toggle("on", on);
    el.setAttribute("aria-pressed", on ? "true" : "false");
    save(root);
    return;
  }
  if (act === "status-audience" || act === "status-list") {
    event.preventDefault();
    const value = el.getAttribute("data-value") || "";
    if (!mine) mine = { id: selfId(), exact: true, preference: "online", seenPrivacy: "everyone", reciprocal: true, seenLists: [], statusAudience: "everyone", statusLists: [], state: "offline", emoji: "", text: "" };
    const box = el.closest(".presence-card, .presence-settings") || document.body;
    if (act === "status-audience") {
      mine.statusAudience = value;
      box.querySelectorAll('[data-presence="status-audience"]').forEach(function (button) {
        const on = button.getAttribute("data-value") === value;
        button.classList.toggle("on", on);
        button.setAttribute("aria-pressed", on ? "true" : "false");
      });
      const host = box.querySelector("[data-status-lists]");
      if (host) host.innerHTML = statusListRows();
    } else {
      const selected = (mine.statusLists || []).slice();
      const at = selected.indexOf(value);
      if (at >= 0) selected.splice(at, 1);
      else if (value) selected.push(value);
      mine.statusLists = selected;
      const on = selected.indexOf(value) >= 0;
      el.classList.toggle("on", on);
      el.setAttribute("aria-pressed", on ? "true" : "false");
    }
    saveAudience(root);
    return;
  }
  if (act === "pick-emoji") {
    event.preventDefault();
    const value = el.getAttribute("data-value") || "";
    const box = el.closest(".presence-form") || document;
    const field = box.querySelector("[data-presence-emoji]");
    if (field) field.value = value;
    box.querySelectorAll('[data-presence="pick-emoji"]').forEach(function (button) {
      const on = button === el;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
    return;
  }
  if (act === "reciprocal") {
    event.preventDefault();
    if (!mine) mine = { id: selfId(), exact: true, preference: "online", seenPrivacy: "everyone", reciprocal: true, seenLists: [], state: "offline", emoji: "", text: "" };
    mine.reciprocal = mine.reciprocal === false;
    const on = mine.reciprocal !== false;
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
    save(root);
    return;
  }
  if (act === "rail-fold") {
    event.preventDefault();
    const card = el.closest(".friends-rail");
    foldRail(card, !(card && card.classList.contains("is-collapsed")));
    return;
  }

  if (act === "rail-msg") {
    event.preventDefault();
    const id = el.getAttribute("data-id") || "";
    railTo = railTo === id ? "" : id;
    railNote = "";
    paintRail();
    if (railTo && window.ViktorychFriendP2P && api.stateOf(railTo) && api.stateOf(railTo) !== "offline") window.ViktorychFriendP2P.connect(railTo);
    const box = document.querySelector("[data-rail-text]");
    if (box) box.focus();
    return;
  }
  if (act === "rail-send") {
    event.preventDefault();
    const form = el.closest("form");
    const field = form && form.querySelector("[data-rail-text]");
    const text = field ? String(field.value || "").trim() : "";
    const id = el.getAttribute("data-id") || "";
    if (!text || !id) return;
    sendRailMessage(id, text);
    return;
  }
  if (act === "online-filter") {
    event.preventDefault();
    friendsFilter = el.getAttribute("data-value") || "all";
    paintOnline();
    return;
  }
  if (act === "save" || act === "clear-status") {
    event.preventDefault();
    save(root, act === "clear-status" ? null : readBox(root));
    return;
  }
  if (act === "close") close();
}

function wrap(publicId, html, attrs) {
  if (!isAccountId(publicId) || !html || String(html).indexOf("ava-none") >= 0) return html || "";
  const view = cached(publicId);
  const state = view && view.state ? view.state : "";
  // A small controller badge marks friends who are playing right now.
  const game = view && view.playing && state !== "offline" ? ' data-playing="1"' : "";
  return '<span class="ava-presence" data-pid="' + publicId + '" data-presence="' + esc(state) + '"' + game + (attrs || "") + (view && view.emoji ? ' data-status-emoji="1"' : "") + '>' + html + '<i class="presence-dot" aria-hidden="true"></i><i class="status-badge" aria-hidden="true">' + esc(view && view.emoji ? view.emoji : "") + '</i></span>';
}

function linesHtml(publicId) {
  if (!isAccountId(publicId)) return "";
  const view = cached(publicId);
  return '<div class="presence-lines" data-pid-line="' + publicId + '">' + esc(lineText(view)) + '</div>';
}

function dmSubHtml(publicId, fallback) {
  const text = fallback == null ? "" : String(fallback);
  if (!isAccountId(publicId)) return esc(text);
  const view = cached(publicId);
  const shown = (view && (statusText(view) || phrase(view))) || text;
  return '<span data-pid-status="' + publicId + '" data-fallback="' + esc(text) + '">' + esc(shown) + '</span>';
}

function mutesNotices() {
  return !!(mine && mine.preference === "dnd");
}

function chime() {
  if (mutesNotices()) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    if (!audioCtx) audioCtx = new Ctx();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.04, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch (err) { /* a blocked audio context stays silent */ }
}

function friendRank(state) {
  if (state === "online") return 0;
  if (state === "idle") return 1;
  if (state === "dnd") return 2;
  return 3;
}

function friendPhoto(person) {
  const letter = String(person.name || person.handle || "?").trim().charAt(0).toUpperCase() || "?";
  if (person.avatar) return '<img class="online-ava" alt="" src="' + esc(person.avatar) + '">';
  if (person.avatarFace === "none") return '<span class="ava ava-none online-ava"></span>';
  return '<span class="ava initials online-ava">' + esc(letter) + "</span>";
}

function friendEmoji(person) {
  if (!person || !person.emoji) return "";
  return '<span class="online-emoji" aria-hidden="true">' + esc(person.emoji) + "</span>";
}

function friendSub(person) {
  const seen = phrase(person);
  if (person.text && seen) return person.text + " · " + seen;
  return person.text || seen;
}

function rankedFriends() {
  const query = friendsQuery.trim().toLowerCase();
  return friends.filter(function (person) {
    if (friendsFilter === "online" && person.state !== "online") return false;
    if (friendsFilter === "away" && person.state !== "idle") return false;
    if (friendsFilter === "offline" && person.state !== "offline") return false;
    if (!query) return true;
    const name = String(person.name || "").toLowerCase();
    const handle = String(person.handle || "").toLowerCase();
    return name.indexOf(query) >= 0 || handle.indexOf(query) >= 0;
  }).slice().sort(function (a, b) {
    const diff = friendRank(a.state) - friendRank(b.state);
    if (diff) return diff;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function friendHref(person) {
  if (!person.handle) return "#/online";
  return "#/@" + encodeURIComponent(person.handle);
}

function chipHtml(person) {
  const photo = wrap(person.publicId, friendPhoto(person));
  return '<a class="online-chip" href="' + esc(friendHref(person)) + '">' + photo + friendEmoji(person) + '<span class="online-chip-name">' + esc(person.name || person.handle) + "</span></a>";
}

function stripInnerHtml() {
  const shown = friends.filter(function (person) {
    return person.state === "online" || person.state === "idle";
  }).sort(function (a, b) { return friendRank(a.state) - friendRank(b.state); }).slice(0, 16);
  if (!shown.length) return "";
  return shown.map(chipHtml).join("");
}

function onlineCount() {
  let count = 0;
  friends.forEach(function (person) {
    if (person && person.state === "online") count += 1;
  });
  return count;
}

function railCollapsed() {
  try { return localStorage.getItem("viktorychapp-friends-rail") === "0"; }
  catch (err) { return false; }
}

function setRailCollapsed(collapsed) {
  try { localStorage.setItem("viktorychapp-friends-rail", collapsed ? "0" : "1"); }
  catch (err) { /* the card still toggles for this view */ }
}

function activeFriends() {
  const query = railQuery.trim().toLowerCase();
  return friends.filter(function (person) {
    if (person.state !== "online" && person.state !== "idle") return false;
    if (!query) return true;
    const name = String(person.name || "").toLowerCase();
    const handle = String(person.handle || "").toLowerCase();
    return name.indexOf(query) >= 0 || handle.indexOf(query) >= 0;
  }).sort(function (a, b) {
    const diff = friendRank(a.state) - friendRank(b.state);
    if (diff) return diff;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function railRow(person) {
  const photo = wrap(person.publicId, friendPhoto(person));
  const compose = railTo === person.publicId
    ? railThread(person.publicId) + '<form class="friends-rail-compose"><textarea data-rail-text maxlength="500" placeholder="' + esc(tr("Send a message…")) + '" aria-label="' + esc(tr("Send a message…")) + '"></textarea><button type="submit" data-presence="rail-send" data-id="' + esc(person.publicId) + '">' + esc(tr("Message")) + "</button></form>"
    : "";
  return '<div class="friends-rail-row"><a class="friends-rail-main" href="' + esc(friendHref(person)) + '">' + photo + friendEmoji(person) + '<span class="friends-rail-copy"><b>' + esc(person.name || person.handle) + '</b><span data-pid-line="' + esc(person.publicId) + '">' + esc(phrase(person)) + "</span></span></a><button type=\"button\" class=\"friends-rail-msg\" data-presence=\"rail-msg\" data-id=\"" + esc(person.publicId) + "\" aria-label=\"" + esc(tr("Message")) + "\">" + esc(tr("Message")) + "</button></div>" + compose;
}

function railListHtml() {
  if (!friendsLoaded) return '<p class="friends-rail-empty">' + esc(tr("Loading…")) + "</p>";
  const list = activeFriends();
  if (!list.length) {
    return '<p class="friends-rail-empty">' + esc(railQuery.trim() ? tr("No friends found") : tr("No friends online")) + "</p>";
  }
  return list.map(railRow).join("") + (railNote ? '<p class="friends-rail-note">' + esc(railNote) + "</p>" : "");
}

function paintRail() {
  const list = document.querySelector("[data-rail-list]");
  if (list) list.innerHTML = railListHtml();
  const peek = document.querySelector("[data-rail-peek]");
  if (peek) peek.innerHTML = railPeekInner();
}

function openRailChat(card, id) {
  foldRail(card, false);
  railTo = id;
  railNote = "";
  paintRail();
  if (railTo && window.ViktorychFriendP2P && api.stateOf(railTo) && api.stateOf(railTo) !== "offline") window.ViktorychFriendP2P.connect(railTo);
  const field = document.querySelector("[data-rail-text]");
  if (field) field.focus();
}

function foldRail(card, collapsed) {
  if (card) card.classList.toggle("is-collapsed", collapsed);
  setRailCollapsed(collapsed);
  const fold = card && card.querySelector(".friends-rail-fold");
  if (fold) {
    fold.setAttribute("aria-expanded", collapsed ? "false" : "true");
    fold.setAttribute("aria-label", (collapsed ? tr("Expand") : tr("Collapse")));
    fold.textContent = collapsed ? "▸" : "▾";
  }
  const title = card && card.querySelector(".friends-rail-title");
  if (title) title.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

/* The collapsed panel still shows who is around: up to seven stacked faces
   with their presence dots and a count. Same friends list as the open
   panel (no extra requests). */
const PEEK_MAX = 7;
function peekFriends() {
  return friends.filter(function (person) {
    return person && (person.state === "online" || person.state === "idle");
  }).sort(function (a, b) {
    const diff = friendRank(a.state) - friendRank(b.state);
    if (diff) return diff;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function railPeekInner() {
  if (!friendsLoaded) return '<span class="friends-rail-peek-note">' + esc(tr("Loading…")) + "</span>";
  const list = peekFriends();
  if (!list.length) return '<span class="friends-rail-peek-note">' + esc(tr("No friends online")) + "</span>";
  const faces = list.slice(0, PEEK_MAX).map(function (person) {
    const name = person.name || person.handle || "";
    return '<button type="button" class="friends-rail-face" data-rail-face="' + esc(person.publicId) + '" title="' + esc(name) + '" aria-label="' + esc(tr("Message {name}", { name: name })) + '">' + wrap(person.publicId, friendPhoto(person)) + "</button>";
  }).join("");
  const more = list.length > PEEK_MAX ? '<span class="friends-rail-more" aria-hidden="true">+' + (list.length - PEEK_MAX) + "</span>" : "";
  return '<span class="friends-rail-faces">' + faces + more + '</span><button type="button" class="friends-rail-count" data-presence="rail-fold"><i class="friends-rail-live" aria-hidden="true"></i>' + esc(tr("{n} online", { n: list.length })) + "</button>";
}

function railHtml() {
  if (!token()) return "";
  if (visible()) loadFriends(false);
  const collapsed = railCollapsed();
  return '<section class="card friends-rail' + (collapsed ? " is-collapsed" : "") + '" aria-label="' + esc(tr("Friends")) + '"><div class="friends-rail-head"><h2><button type="button" class="friends-rail-title" data-presence="rail-fold" aria-expanded="' + (collapsed ? "false" : "true") + '">' + esc(tr("Friends")) + '</button></h2><button type="button" class="friends-rail-fold" data-presence="rail-fold" aria-expanded="' + (collapsed ? "false" : "true") + '" aria-label="' + esc((collapsed ? tr("Expand") : tr("Collapse"))) + '">' + (collapsed ? "▸" : "▾") + '</button></div><div class="friends-rail-peek" data-rail-peek>' + railPeekInner() + '</div><div class="friends-rail-body"><label class="friends-rail-search"><input type="search" data-rail-search placeholder="' + esc(tr("Search Friends")) + '" aria-label="' + esc(tr("Search Friends")) + '" value="' + esc(railQuery) + '"></label><div class="friends-rail-list" data-rail-list>' + railListHtml() + '</div><a class="show-more-row" href="#/online">' + esc(tr("See all")) + "</a></div></section>";
}

function sendRailMessage(id, text) {
  railNote = "";
  const p2p = window.ViktorychFriendP2P;
  const sent = p2p ? p2p.send(id, text).then(function (res) { return res.via; })
    : call("/v1/messages", { method: "POST", body: { id: id, text: text } }).then(function (body) { return body && body.status === 200 ? "server" : "refused"; });
  return sent.then(function (via) {
    if (via !== "p2p" && via !== "server" && via !== "outbox") {
      railNote = tr("Couldn’t send that message.");
      paintRail();
      return;
    }
    railNote = via === "outbox" ? tr("You’re offline. It will send when you’re back online.") : tr("Message sent");
    paintRail();
    const box = document.querySelector(".friends-rail-compose [data-rail-text]");
    if (box) box.focus();
  });
}

function railThread(id) {
  const p2p = window.ViktorychFriendP2P;
  const list = p2p && p2p.thread ? p2p.thread(id).slice(-4) : [];
  if (!list.length) return "";
  return '<div class="friends-rail-thread">' + list.map(function (row) {
    return '<p class="friends-rail-line' + (row.mine ? " mine" : "") + '">' + esc(row.text) + "</p>";
  }).join("") + "</div>";
}

function stripHtml() {
  if (!token()) return "";
  loadFriends(false);
  const inner = stripInnerHtml();
  if (!inner) return "";
  return '<section class="online-home" aria-label="' + esc(tr("Online")) + '"><a class="online-home-title" href="#/online">' + esc(tr("Online")) + '</a><div class="online-home-row">' + inner + "</div></section>";
}

function onlineToolsHtml() {
  const pills = [["all", tr("All")], ["online", tr("Online")], ["away", tr("Away")], ["offline", tr("Offline")]];
  return '<div class="online-tools"><label class="online-search"><input type="search" data-online-search placeholder="' + esc(tr("Search Friends")) + '" aria-label="' + esc(tr("Search Friends")) + '" value="' + esc(friendsQuery) + '"></label><div class="online-pills">' + pills.map(function (pill) {
    const on = friendsFilter === pill[0];
    return '<button type="button" class="online-pill' + (on ? " on" : "") + '" data-presence="online-filter" data-value="' + pill[0] + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(pill[1]) + "</button>";
  }).join("") + "</div></div>";
}

function onlineListHtml() {
  if (!friendsLoaded) return '<div class="reply-empty">' + esc(tr("Loading…")) + "</div>";
  if (!friends.length) return '<div class="empty"><h2>' + esc(tr("No friends yet")) + '</h2><p>' + esc(tr("When you become friends with people, they’ll show up here.")) + "</p></div>";
  const list = rankedFriends();
  if (!list.length) {
    const empty = friendsFilter === "online" ? tr("No friends online") : tr("No friends found");
    return '<div class="empty"><h2>' + esc(empty) + "</h2><p>" + esc(tr("Couldn’t find any friends matching your search.")) + "</p></div>";
  }
  return '<div class="online-list">' + list.map(function (person) {
    const photo = wrap(person.publicId, friendPhoto(person));
    const join = person.playing && window.ViktorychGameSocial ? window.ViktorychGameSocial.joinChipHtml(person.publicId, person.room || "") : "";
    return '<a class="online-row" href="' + esc(friendHref(person)) + '">' + photo + friendEmoji(person) + '<span class="online-copy"><b>' + esc(person.name || person.handle) + '</b><span>@' + esc(person.handle) + " · " + esc(friendSub(person)) + "</span></span>" + join + "</a>";
  }).join("") + "</div>";
}

function paintOnline() {
  const root = document.querySelector("[data-online-root]");
  if (!root) return;
  const list = root.querySelector("[data-online-list]");
  if (list) list.innerHTML = onlineListHtml();
  root.querySelectorAll("[data-presence='online-filter']").forEach(function (button) {
    const on = button.getAttribute("data-value") === friendsFilter;
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function pageHtml() {
  loadFriends(false);
  if (!token()) return '<div class="online-page"><div class="empty"><h2>' + esc(tr("Friends")) + "</h2><p>" + esc(tr("Sign in to see this list.")) + "</p></div></div>";
  const strip = stripInnerHtml();
  const stripBlock = strip ? '<div class="online-home-row" data-online-strip>' + strip + "</div>" : '<div class="online-home-row" data-online-strip></div>';
  return '<div class="online-page" data-online-root>' + stripBlock + onlineToolsHtml() + '<div data-online-list>' + onlineListHtml() + "</div></div>";
}

function loadFriends(force) {
  if (!token()) {
    friends = [];
    friendsLoaded = true;
    return Promise.resolve();
  }
  if (!visible()) return Promise.resolve();
  if (!force && friendsAt && Date.now() - friendsAt < 20000) return Promise.resolve();
  if (friendsLoading) return friendsLoading;
  friendsLoading = call("/v1/friends/presence").then(function (body) {
    friendsLoading = null;
    if (!body || body.status !== 200) {
      friendsLoaded = true;
      return;
    }
    friends = Array.isArray(body.friends) ? body.friends : [];
    friends.forEach(function (person) {
      if (!person || !person.publicId) return;
      remember({
        id: person.publicId,
        state: person.state,
        exact: person.exact,
        lastSeen: person.lastSeen,
        emoji: person.emoji,
        text: person.text,
        playing: person.playing || "",
        room: person.room || ""
      });
    });
    friendsAt = Date.now();
    friendsLoaded = true;
    paint();
    paintRail();
    const api = accounts();
    if (api && api.requestRender) api.requestRender();
  });
  return friendsLoading;
}

function boot() {
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pointerdown", noteInput, { passive: true, capture: true });
  window.addEventListener("keydown", noteInput, true);
  window.addEventListener("scroll", noteInput, { passive: true, capture: true });
  document.addEventListener("click", onClick);
  document.addEventListener("input", function (event) {
    const input = event.target && event.target.closest && event.target.closest("[data-online-search]");
    if (input) {
      friendsQuery = input.value || "";
      paintOnline();
      return;
    }
    const draft = event.target && event.target.closest && event.target.closest("[data-rail-text]");
    if (draft && railTo && window.ViktorychFriendP2P) {
      window.ViktorychFriendP2P.typing(railTo);
      return;
    }
    const rail = event.target && event.target.closest && event.target.closest("[data-rail-search]");
    if (!rail) return;
    railQuery = rail.value || "";
    paintRail();
  });
  window.addEventListener("viktorych-friend-message", function (event) {
    if (event.detail && event.detail.from === railTo) paintRail();
  });
  window.addEventListener("resize", placeSheet);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") close();
  });
  if (window.SI18n && window.SI18n.onChange) window.SI18n.onChange(function () { paint(); if (sheet && !sheet.hidden) fillSheet(); });
  // presence.js runs before the deferred accounts.js. Without a session yet,
  // start once the page has finished loading so the socket still opens and
  // the 20 second notification poll does not take its place.
  if (visible() && !token()) {
    const later = function () { if (visible() && token()) start(); };
    if (document.readyState === "complete") setTimeout(later, 0);
    else window.addEventListener("load", later, { once: true });
    return;
  }
  if (visible()) start();
}

function start() {
  armHeart();
  beat(true);
  connect();
  loadFriends(false);
  call("/v1/presence").then(function (body) {
    if (!body || body.status !== 200) return;
    applyMine(body);
    paint();
  });
}

/* First-time setup: who sees when you are online. Resolves true once saved. */
function setSeenPrivacy(value) {
  if (PRIVACY_IDS.indexOf(value) < 0) return Promise.resolve(false);
  if (!mine) mine = { id: selfId(), exact: true, preference: "online", seenPrivacy: "everyone", reciprocal: true, seenLists: [], state: "offline", emoji: "", text: "" };
  const prev = mine.seenPrivacy;
  mine.seenPrivacy = value;
  return call("/v1/presence", { method: "PATCH", body: { seenPrivacy: value } }).then(function (res) {
    if (!res || res.status !== 200) { if (mine) mine.seenPrivacy = prev; return false; }
    applyMine(res);
    return true;
  });
}

const api = {
  wrap: wrap,
  seenPrivacy: function () { return (mine && mine.seenPrivacy) || "everyone"; },
  setSeenPrivacy: setSeenPrivacy,
  linesHtml: linesHtml,
  dmSubHtml: dmSubHtml,
  settingsHtml: settingsHtml,
  refresh: refresh,
  open: open,
  close: close,
  mutesNotices: mutesNotices,
  chime: chime,
  dnd: mutesNotices,
  onChannel: onChannel,
  offChannel: offChannel,
  channelOpen: socketOpen,
  stripHtml: stripHtml,
  pageHtml: pageHtml,
  railHtml: railHtml,
  onlineCount: onlineCount,
  reloadFriends: function () { return loadFriends(true); },
  seen: function (id, state) {
    if (!isAccountId(id) || id === selfId()) return;
    const prev = cached(id) || {};
    remember(Object.assign({}, prev, { id: id, state: state || "online", lastSeen: Date.now(), exact: true }));
    friends.forEach(function (person) { if (person.publicId === id) person.state = state || "online"; });
    paint();
  },
  stateOf: function (id) {
    const view = cached(id);
    if (view && view.state) return view.state;
    const person = friends.find(function (row) { return row.publicId === id; });
    return person ? person.state || "" : "";
  },
  myState: function () { return (mine && mine.preference) || "online"; },
  /* The custom status for rich presence elsewhere; nothing while invisible or expired. */
  myStatus: function () {
    if (!mine || mine.preference === "invisible") return null;
    if (mine.clearAt && mine.clearAt <= Date.now()) return null;
    if (!mine.emoji && !mine.text) return null;
    return { emoji: mine.emoji || "", text: mine.text || "" };
  }
};
window.ViktorychPresence = api;

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
