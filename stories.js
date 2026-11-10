/* Stories tray and viewer. The row mixes stories.json with signed-in
   stories. Seen state and the collapsed bar stay in localStorage. */
(function (root) {
  "use strict";

  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : ((typeof self !== "undefined" && self.t) ? self.t : null);
    return fn ? fn(key, vars) : key;
  }
  var DAY = 24 * 60 * 60 * 1000;
  var PHOTO_MS = 5000;
  var VINE_MS = 6000;
  var SEEN_KEY = "rss-stories-seen-v1";
  var BAR_KEY = "viktorych-stories-bar-v1";
  var BAR_H = { expanded: 112, slim: 52, hidden: 28 };
  var tuck = 0;
  var appliedExtra = null;
  var trackTimer = 0;
  var ORG_KEY = "viktorych-story-org-v1";
  var NOTE_EMOJI = ["😀", "😂", "❤️", "🔥", "👏", "😮", "😢", "👍"];
  var REACTIONS = ["❤", "🔥", "👏", "😂", "😮", "😢"];
  var deps = {};
  var raw = { accounts: [], updated: "", telegramConnected: false };
  var loadedAt = 0;
  var view = null;
  var timer = 0;
  var pointer = null;
  var shellPointer = null;
  var suppressClick = false;
  var soundOn = false;
  var pickedFile = null;
  var notes = { mine: null, notes: [] };
  var orgMenu = null;
  var holdTimer = 0;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function https(url) {
    var text = String(url || "");
    return /^https:\/\/[^\s"]+$/i.test(text) ? text : "";
  }

  function mediaUrl(url) {
    var text = String(url || "").trim();
    if (https(text)) return text;
    if (text.indexOf("/v1/stories/") === 0 && deps.apiRoot) {
      var root = "";
      try { root = String(deps.apiRoot() || ""); } catch (err) { root = ""; }
      root = root.replace(/\/$/, "");
      if (root) return root + text;
    }
    if (/^[a-zA-Z0-9./_-]+$/.test(text) && text.indexOf("..") < 0 && text.indexOf("//") < 0) return text;
    return "";
  }

  function stamp(value) {
    var parsed = Date.parse(value || "");
    return isNaN(parsed) ? 0 : parsed;
  }

  function expired(item, now) {
    var end = stamp(item && item.expires);
    if (!end && item && item.date) end = stamp(item.date) + DAY;
    return !end || end <= now;
  }

  function activeAccounts(doc, now, follows) {
    var allow = null;
    if (Array.isArray(follows)) {
      allow = Object.create(null);
      follows.forEach(function (id) { allow[String(id)] = true; });
    }
    var out = [];
    var accounts = (doc && doc.accounts) || [];
    accounts.forEach(function (account) {
      if (!account) return;
      var id = String(account.id || "");
      var handle = String(account.handle || "").replace(/^@/, "");
      var platform = String(account.platform || "");
      var pair = platform + ":" + handle;
      if (allow && platform !== "app" && !allow[id] && !allow[pair]) return;
      var items = (account.items || []).filter(function (item) {
        return item && mediaUrl(item.url) && !expired(item, now);
      }).slice().sort(function (a, b) { return stamp(a.date) - stamp(b.date); });
      if (!items.length) return;
      out.push({
        id: id || pair,
        platform: platform,
        handle: handle,
        name: account.name || handle,
        avatar: mediaUrl(account.avatar),
        self: !!account.self,
        items: items
      });
    });
    return out;
  }

  function itemKey(account, item) {
    return String(account.platform || "") + ":" + String(account.handle || "") + ":" + String(item && item.id || "");
  }

  function readSeen() {
    var map = {};
    try { map = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch (err) { map = {}; }
    if (!map || typeof map !== "object") map = {};
    var now = Date.now();
    var changed = false;
    Object.keys(map).forEach(function (key) {
      if (!(Number(map[key]) > now)) {
        delete map[key];
        changed = true;
      }
    });
    if (changed) {
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)); } catch (err) { /* private mode */ }
    }
    return map;
  }

  function writeSeen(map) {
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)); } catch (err) { /* private mode */ }
  }

  function unseen(account, seen) {
    return (account.items || []).some(function (item) { return !seen[itemKey(account, item)]; });
  }

  function newest(account) {
    var max = 0;
    (account.items || []).forEach(function (item) { max = Math.max(max, stamp(item.date)); });
    return max;
  }

  function orderedAccounts(accounts, seen) {
    return (accounts || []).slice().sort(function (a, b) {
      var left = unseen(a, seen || {}) ? 0 : 1;
      var right = unseen(b, seen || {}) ? 0 : 1;
      if (left !== right) return left - right;
      return newest(b) - newest(a);
    });
  }

  function viewerAccount() {
    if (!deps.account) return null;
    try { return deps.account() || null; } catch (err) { return null; }
  }

  function token() {
    if (!deps.token) return "";
    try { return String(deps.token() || ""); } catch (err) { return ""; }
  }

  function showConnect() {
    if (!deps.owner) return false;
    var on = false;
    try { on = !!deps.owner(); } catch (err) { on = false; }
    if (!on) return false;
    return !(raw && raw.telegramConnected);
  }

  function rows() {
    var follows = deps.follows ? deps.follows() : null;
    return orderedAccounts(activeAccounts(raw, Date.now(), follows), readSeen());
  }

  function selfRow(list) {
    var account = viewerAccount();
    if (!account) return null;
    var found = null;
    (list || []).forEach(function (row) {
      if (!row) return;
      if (row.self || (account.publicId && row.id === "app:" + account.publicId)) found = row;
    });
    if (found) {
      found.self = true;
      return found;
    }
    return {
      id: account.publicId ? "app:" + account.publicId : "app:self",
      platform: "app",
      handle: account.handle || "",
      name: account.displayName || account.handle || tr("Your story"),
      avatar: mediaUrl(account.avatar || ""),
      self: true,
      items: []
    };
  }

  function barState() {
    var value = "expanded";
    try { value = localStorage.getItem(BAR_KEY) || "expanded"; } catch (err) { value = "expanded"; }
    if (value !== "slim" && value !== "hidden") value = "expanded";
    return value;
  }

  function hasTray() {
    if (rows().length) return true;
    if (viewerAccount()) return true;
    if (showConnect()) return true;
    return false;
  }

  function notesEnabled() {
    if (!deps.notesOn) return true;
    try { return deps.notesOn() !== false; } catch (err) { return true; }
  }

  function expandedHeight() {
    return notesEnabled() ? BAR_H.expanded : 92;
  }

  function tuckProgress() {
    var state = barState();
    if (state === "hidden" || state === "slim") return 1;
    if (tuck < 0) return 0;
    if (tuck > 1) return 1;
    return tuck;
  }

  function trayExtra() {
    if (!hasTray()) return 0;
    var state = barState();
    if (state === "hidden") return BAR_H.hidden;
    if (state === "slim") return BAR_H.slim;
    return Math.round(expandedHeight() - tuckProgress() * (expandedHeight() - BAR_H.slim));
  }

  function paintTuck(tracking) {
    if (typeof document === "undefined") return;
    var node = document.querySelector(".story-shell");
    var state = barState();
    var progress = tuckProgress();
    var height = state === "hidden" ? BAR_H.hidden : Math.round(expandedHeight() - progress * (expandedHeight() - BAR_H.slim));
    if (state === "slim") height = BAR_H.slim;
    if (node) {
      node.setAttribute("data-state", state);
      node.style.setProperty("--story-tuck", String(progress));
      node.style.height = height + "px";
      node.classList.toggle("is-tracking", !!tracking);
      var fold = node.querySelector(".story-fold");
      if (fold) fold.setAttribute("aria-expanded", state === "expanded" && progress < 0.5 ? "true" : "false");
      if (tracking) {
        if (trackTimer) clearTimeout(trackTimer);
        trackTimer = setTimeout(function () {
          trackTimer = 0;
          var live = document.querySelector(".story-shell");
          if (live) live.classList.remove("is-tracking");
        }, 140);
      }
    }
    var extra = trayExtra();
    if (appliedExtra == null) appliedExtra = extra;
    var delta = extra - appliedExtra;
    appliedExtra = extra;
    if (!delta) return;
    var main = document.querySelector("main.center");
    if (!main) return;
    var current = parseFloat(main.style.getPropertyValue("--top"));
    if (isNaN(current)) return;
    if (tracking) main.style.transition = "";
    else {
      main.style.transition = "padding-top 0.22s cubic-bezier(.2, .9, .2, 1)";
      setTimeout(function () { if (main) main.style.transition = ""; }, 260);
    }
    main.style.setProperty("--top", (current + delta) + "px");
  }

  function applyBar(next) {
    if (next !== "expanded" && next !== "slim" && next !== "hidden") next = "expanded";
    tuck = next === "expanded" ? 0 : 1;
    try { localStorage.setItem(BAR_KEY, next); } catch (err) { /* private mode */ }
    paintTuck(false);
  }

  function trackScroll(delta, scrollTop) {
    if (!delta) return;
    var state = barState();
    if (state === "hidden") return;
    if (state === "slim") {
      if (delta < 0) applyBar("expanded");
      return;
    }
    var range = expandedHeight() - BAR_H.slim;
    if (scrollTop <= 0 && delta < 0) tuck = 0;
    else tuck = Math.max(0, Math.min(1, tuck + delta / range));
    paintTuck(true);
  }

  function emptyOrg() {
    return { pins: [], hidden: [], folders: [], active: "", updatedAt: 0 };
  }

  function cleanOrg(raw) {
    var org = emptyOrg();
    if (!raw || typeof raw !== "object") return org;
    var seen = {};
    (raw.pins || []).forEach(function (id) {
      id = String(id || "");
      if (!id || seen[id]) return;
      seen[id] = true;
      org.pins.push(id);
    });
    var hiddenSeen = {};
    (raw.hidden || []).forEach(function (item) {
      if (!item) return;
      var id = String(item.id || item || "");
      if (!id || hiddenSeen[id]) return;
      hiddenSeen[id] = true;
      org.hidden.push({
        id: id,
        name: item.name == null ? "" : String(item.name),
        platform: item.platform == null ? "" : String(item.platform),
        handle: item.handle == null ? "" : String(item.handle),
        also: (item.also || []).map(function (key) { return String(key || ""); }).filter(Boolean)
      });
    });
    var folderSeen = {};
    (raw.folders || []).forEach(function (item) {
      if (!item) return;
      var id = String(item.id || "");
      if (!id || folderSeen[id]) return;
      folderSeen[id] = true;
      var members = [];
      var memberSeen = {};
      (item.members || []).forEach(function (key) {
        key = String(key || "");
        if (!key || memberSeen[key]) return;
        memberSeen[key] = true;
        members.push(key);
      });
      org.folders.push({
        id: id,
        name: item.name == null ? "" : String(item.name),
        icon: item.icon == null ? "" : String(item.icon),
        members: members
      });
    });
    var active = String(raw.active || "");
    org.active = org.folders.some(function (folder) { return folder.id === active; }) ? active : "";
    org.updatedAt = Math.max(0, Number(raw.updatedAt) || 0);
    return org;
  }

  function readOrg() {
    try { return cleanOrg(JSON.parse(localStorage.getItem(ORG_KEY) || "")); }
    catch (err) { return emptyOrg(); }
  }

  function writeOrg(org) {
    var next = cleanOrg(org);
    next.updatedAt = Date.now();
    try { localStorage.setItem(ORG_KEY, JSON.stringify(next)); } catch (err) { /* private mode */ }
    var auth = token();
    if (auth && deps.api) {
      deps.api("/v1/story-bar", { method: "PUT", token: auth, body: next }).catch(function () {});
    }
    return next;
  }

  function sourceId(account) {
    if (!account) return "";
    return String(account.id || ((account.platform || "") + ":" + (account.handle || "")));
  }

  function hiddenMap(org) {
    var map = {};
    (org.hidden || []).forEach(function (row) {
      if (!row) return;
      map[row.id] = true;
      (row.also || []).forEach(function (id) { map[id] = true; });
      if (row.handle) map["note:" + row.handle] = true;
      if (row.platform && row.handle) map[row.platform + ":" + row.handle] = true;
    });
    return map;
  }

  function activeMembers(org) {
    var folder = null;
    (org.folders || []).forEach(function (item) { if (item && item.id === org.active) folder = item; });
    if (!folder) return null;
    var map = {};
    (folder.members || []).forEach(function (id) { map[id] = true; });
    return map;
  }

  function matchesMember(id, handle, platform, members) {
    if (!members) return true;
    if (members[id]) return true;
    if (handle && members["note:" + handle]) return true;
    if (platform && handle && members[platform + ":" + handle]) return true;
    return false;
  }

  function organize(list, org) {
    org = cleanOrg(org || emptyOrg());
    var hidden = hiddenMap(org);
    var members = activeMembers(org);
    var pinAt = {};
    org.pins.forEach(function (id, index) { pinAt[id] = index; });
    var pinned = [];
    var rest = [];
    (list || []).forEach(function (account) {
      if (!account || account.self) return;
      var id = sourceId(account);
      if (hidden[id] || (account.handle && hidden["note:" + account.handle])) return;
      if (!matchesMember(id, account.handle, account.platform, members)) return;
      if (pinAt[id] != null) pinned.push(account);
      else rest.push(account);
    });
    pinned.sort(function (a, b) { return pinAt[sourceId(a)] - pinAt[sourceId(b)]; });
    return pinned.concat(rest);
  }

  function noteVisible(item, org) {
    if (!item) return false;
    var hidden = hiddenMap(org);
    var id = "note:" + String(item.handle || "");
    if (hidden[id] || hidden[item.handle || ""]) return false;
    return matchesMember(id, item.handle, "app", activeMembers(org));
  }

  function keysFor(id, handle, platform) {
    var keys = [];
    var seen = {};
    [id, handle ? "note:" + handle : "", platform && handle ? platform + ":" + handle : ""].forEach(function (key) {
      if (!key || seen[key]) return;
      seen[key] = true;
      keys.push(key);
    });
    return keys;
  }

  function cycleBar(dir) {
    var order = ["hidden", "slim", "expanded"];
    var at = order.indexOf(barState());
    if (at < 0) at = 2;
    applyBar(order[Math.max(0, Math.min(order.length - 1, at + dir))]);
  }

  function badge(platform) {
    var name = platform === "instagram" ? "ig" : platform === "vk" ? "vk" : platform === "telegram" ? "tg" : "";
    if (!name || !deps.icon) return "";
    return '<span class="story-badge" aria-hidden="true">' + deps.icon(name) + "</span>";
  }

  function face(account) {
    var letter = esc((account.name || account.handle || "?").trim().slice(0, 1).toUpperCase() || "?");
    if (!account.avatar) return '<span class="story-fallback">' + letter + "</span>";
    return '<img src="' + esc(account.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
  }

  function orgButton(id, name, handle, platform) {
    return '<button type="button" class="story-org" data-story-act="org-menu" data-id="' + esc(id) + '" data-name="' + esc(name || "") + '" data-handle="' + esc(handle || "") + '" data-platform="' + esc(platform || "") + '" aria-label="' + esc(tr("Story options")) + '">⋯</button>';
  }

  function cardHtml(account) {
    var seen = readSeen();
    var fresh = unseen(account, seen);
    var label = (account.name || account.handle || tr("Story")) + (fresh ? tr(", unseen story") : tr(", story"));
    var pinned = readOrg().pins.indexOf(account.id) >= 0;
    return '<div class="story-card' + (fresh ? " unseen" : " seen") + (pinned ? " is-pinned" : "") + '" role="listitem">' +
      '<button type="button" class="story-main" data-act="story" data-id="' + esc(account.id) + '" aria-label="' + esc(label) + '">' +
      '<span class="story-ring"><span class="story-face">' + face(account) + "</span>" + badge(account.platform) + "</span></button>" +
      orgButton(account.id, account.name || account.handle, account.handle, account.platform) +
      '<span class="story-name">' + esc(account.name || account.handle || "") + "</span></div>";
  }

  function selfHtml(account) {
    var fresh = account.items && account.items.length && unseen(account, readSeen());
    var open = account.items && account.items.length;
    var act = open
      ? 'data-act="story" data-id="' + esc(account.id) + '"'
      : 'data-story-act="add"';
    return '<div class="story-card story-self' + (fresh ? " unseen" : " seen") + '" role="listitem">' +
      '<button type="button" class="story-main" ' + act + ' aria-label="' + esc(tr("Your story")) + '">' +
      '<span class="story-ring"><span class="story-face">' + face(account) + "</span></span></button>" +
      '<button type="button" class="story-plus" data-story-act="add" aria-label="' + esc(tr("Add a story")) + '">' +
      (deps.icon ? deps.icon("plus") : "+") + "</button>" +
      '<span class="story-name">' + esc(tr("Your story")) + "</span></div>";
  }

  function connectHtml() {
    return '<button type="button" class="story-card story-connect" role="listitem" data-story-act="connect" aria-label="' + esc(tr("Connect Telegram")) + '">' +
      '<span class="story-ring"><span class="story-face"><span class="story-fallback">T</span></span></span>' +
      '<span class="story-name">' + esc(tr("Connect Telegram")) + "</span></button>";
  }

  function homeTray() {
    var all = rows();
    var mine = selfRow(all);
    var list = organize(all.filter(function (account) {
      if (!account) return false;
      if (account.self) return false;
      if (mine && account.id === mine.id) return false;
      return true;
    }), readOrg());
    var connect = showConnect();
    if (!list.length && !mine && !connect && !viewerAccount()) return "";
    var state = barState();
    var noteCards = noteCardsHtml();
    var cards = noteCards + (mine ? selfHtml(mine) : "") + (connect ? connectHtml() : "") + list.map(cardHtml).join("");
    appliedExtra = trayExtra();
    var progress = tuckProgress();
    var tucked = progress > 0 ? ' style="--story-tuck:' + progress + ';height:' + trayExtra() + 'px"' : "";
    return '<div class="story-shell" data-state="' + state + '" data-notes="' + (notesEnabled() ? "on" : "off") + '"' + tucked + '>' +
      folderBarHtml() +
      '<div class="story-tray" role="list" aria-label="' + esc(tr("Stories")) + '">' + cards + "</div>" +
      orgMenuHtml() +
      '<button type="button" class="story-fold" data-story-act="fold" aria-label="' + esc(tr("Collapse stories")) + '" aria-expanded="' + (state === "expanded" ? "true" : "false") + '">' +
      (deps.icon ? deps.icon("chevL") : "") + "</button>" +
      '<button type="button" class="story-peek" data-story-act="expand" aria-label="' + esc(tr("Show stories")) + '">' + esc(tr("Stories")) + "</button></div>";
  }

  function noteCardsHtml() {
    if (!notesEnabled()) return "";
    if (!viewerAccount()) return "";
    var org = readOrg();
    var mine = notes && notes.mine;
    var others = ((notes && notes.notes) || []).filter(function (item) { return noteVisible(item, org); });
    var pinAt = {};
    org.pins.forEach(function (id, index) { pinAt[id] = index; });
    var pinned = [];
    var rest = [];
    others.forEach(function (item) {
      var id = "note:" + String(item.handle || "");
      if (pinAt[id] != null) pinned.push(item);
      else rest.push(item);
    });
    pinned.sort(function (a, b) { return pinAt["note:" + a.handle] - pinAt["note:" + b.handle]; });
    return noteSlotHtml(mine, true) + pinned.concat(rest).map(function (item) { return noteSlotHtml(item, false); }).join("");
  }

  function noteSlotHtml(item, mine) {
    var text = item && item.text ? String(item.text) : "";
    var bubble = mine && !text ? tr("Share a thought...") : text;
    if (!bubble) return "";
    var account = viewerAccount();
    var faceAccount = mine ? {
      name: (account && (account.displayName || account.handle)) || "",
      handle: (account && account.handle) || "",
      avatar: mediaUrl((account && account.avatar) || (item && item.avatar) || "")
    } : {
      name: item.name || item.handle || "",
      handle: item.handle || "",
      avatar: mediaUrl(item.avatar || "")
    };
    var label = mine ? tr("Your note") : (item.name || item.handle || "");
    var handle = mine ? "self" : (item.handle || "");
    var source = mine ? "" : "note:" + String(item.handle || "");
    var menu = mine ? "" : orgButton(source, item.name || item.handle, item.handle, "app");
    return '<div class="story-card note-slot" role="listitem">' +
      '<button type="button" class="note-bubble' + (mine && !text ? " is-prompt" : "") + '" data-story-act="note" data-handle="' + esc(handle) + '">' + esc(bubble) + "</button>" +
      '<button type="button" class="story-main" data-story-act="note" data-handle="' + esc(handle) + '" aria-label="' + esc(label) + '">' +
      '<span class="story-ring"><span class="story-face">' + face(faceAccount) + "</span></span></button>" +
      menu +
      '<span class="story-name">' + esc(label) + "</span></div>";
  }

  function folderBarHtml() {
    var org = readOrg();
    var chips = org.folders.map(function (folder) {
      var on = org.active === folder.id;
      var title = (folder.icon ? folder.icon + " " : "") + folder.name;
      return '<button type="button" class="story-folder' + (on ? " on" : "") + '" data-story-act="folder-pick" data-id="' + esc(folder.id) + '" title="' + esc(title) + '">' +
        (folder.icon ? '<span class="story-folder-icon">' + esc(folder.icon) + "</span>" : "") +
        '<span>' + esc(folder.name) + "</span></button>";
    }).join("");
    var hidden = org.hidden.length ? '<button type="button" class="story-folder" data-story-act="hidden-open">' + esc(tr("Hidden stories")) + "</button>" : "";
    var bare = !org.folders.length && !org.hidden.length;
    return '<div class="story-folders' + (bare ? " is-empty" : "") + '" role="tablist" aria-label="' + esc(tr("Story folders")) + '">' +
      '<button type="button" class="story-folder' + (!org.active ? " on" : "") + '" data-story-act="folder-pick" data-id="">' + esc(tr("All")) + "</button>" +
      chips + hidden +
      '<button type="button" class="story-folder" data-story-act="folder-new" aria-label="' + esc(tr("New folder")) + '">+</button></div>';
  }

  function orgMenuHtml() {
    if (!orgMenu) return "";
    var org = readOrg();
    var pinned = org.pins.indexOf(orgMenu.id) >= 0;
    var pin = pinned
      ? '<button type="button" data-story-act="unpin">' + esc(tr("Unpin")) + "</button>" +
        '<button type="button" data-story-act="pin-up">' + esc(tr("Move earlier")) + "</button>" +
        '<button type="button" data-story-act="pin-down">' + esc(tr("Move later")) + "</button>"
      : '<button type="button" data-story-act="pin">' + esc(tr("Pin")) + "</button>";
    return '<div class="story-org-menu" role="menu" data-act="stop">' + pin +
      '<button type="button" data-story-act="hide-source">' + esc(tr("Hide stories")) + "</button>" +
      '<button type="button" data-story-act="folder-add">' + esc(tr("Add to folder")) + "</button>" +
      '<button type="button" data-story-act="org-close">' + esc(tr("Close")) + "</button></div>";
  }

  function ago(iso) {
    if (typeof window !== "undefined" && window.SI18n && window.SI18n.storyAge) return window.SI18n.storyAge(iso);
    var then = stamp(iso);
    if (!then) return "";
    var seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (seconds < 45) return tr("now");
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + "h";
    return tr("24h");
  }

  function platformName(platform) {
    if (platform === "instagram") return "Instagram";
    if (platform === "vk") return "VK";
    if (platform === "telegram") return "Telegram";
    if (platform === "youtube") return "YouTube";
    return tr("the original");
  }

  function box() {
    return document.getElementById("stories");
  }

  function current() {
    if (!view || view.compose || view.connect) return null;
    var account = view.list[view.account];
    if (!account) return null;
    return { account: account, item: account.items[view.index], index: view.index };
  }

  function mark(account, item) {
    if (!account || !item) return;
    var seen = readSeen();
    var end = stamp(item.expires) || (stamp(item.date) + DAY) || (Date.now() + DAY);
    seen[itemKey(account, item)] = end;
    writeSeen(seen);
    if (account.platform === "app" && item.id && !item.mine && deps.api) {
      var auth = token();
      if (auth) deps.api("/v1/stories/" + encodeURIComponent(item.id) + "/seen", { method: "POST", token: auth, body: {} });
    }
  }

  function stopTimer() {
    if (timer) cancelAnimationFrame(timer);
    timer = 0;
  }

  function paintBars(progress) {
    var node = box();
    if (!node || !view) return;
    var bars = node.querySelectorAll(".story-bar i");
    bars.forEach(function (bar, index) {
      var width = index < view.index ? 100 : index === view.index ? Math.max(0, Math.min(100, progress * 100)) : 0;
      bar.style.width = width + "%";
    });
  }

  function duration(item) {
    if (item && item.vine) return VINE_MS;
    var video = box() && box().querySelector("video");
    if (item && item.type === "video" && video && isFinite(video.duration) && video.duration > 0) return video.duration * 1000;
    return PHOTO_MS;
  }

  function tick() {
    if (!view || view.paused || view.compose || view.connect) return;
    var row = current();
    if (!row) return;
    var video = box() && box().querySelector("video");
    var total = duration(row.item);
    if (row.item.vine) {
      if (!view.holding) view.elapsed = Date.now() - view.started;
    } else if (row.item.type === "video" && video && isFinite(video.duration) && video.duration > 0 && !video.paused) {
      view.elapsed = video.currentTime * 1000;
    } else if (!view.holding) {
      view.elapsed = Date.now() - view.started;
    }
    var progress = total ? view.elapsed / total : 1;
    paintBars(progress);
    if (progress >= 1) {
      advance(1);
      return;
    }
    timer = requestAnimationFrame(tick);
  }

  function playTimer() {
    stopTimer();
    if (!view || view.compose || view.connect) return;
    view.started = Date.now() - (view.elapsed || 0);
    timer = requestAnimationFrame(tick);
  }

  function pause(hold) {
    if (!view) return;
    view.paused = true;
    view.holding = !!hold;
    stopTimer();
    var video = box() && box().querySelector("video");
    if (video && !video.paused) video.pause();
  }

  function resume() {
    if (!view || view.compose || view.connect) return;
    view.paused = false;
    view.holding = false;
    var video = box() && box().querySelector("video");
    if (video) {
      video.play().catch(function () { /* autoplay can wait for a tap */ });
    }
    playTimer();
  }

  function warm(item) {
    if (!item || item.type === "video" || !mediaUrl(item.url)) return;
    var img = new Image();
    img.decoding = "async";
    img.src = mediaUrl(item.url);
  }

  function socialBar(account, item) {
    if (!account || account.platform !== "app") return "";
    var reacts = REACTIONS.map(function (emoji) {
      return '<button type="button" class="story-react" data-story-act="react" data-emoji="' + emoji + '" aria-label="' + esc(tr("Send a reaction")) + '">' + emoji + "</button>";
    }).join("");
    var owner = item && item.mine
      ? '<button type="button" class="story-icon" data-story-act="views" aria-label="' + esc(tr("Who viewed this story")) + '">' + esc(tr("Views")) + "</button>" +
        '<button type="button" class="story-icon" data-story-act="delete" aria-label="' + esc(tr("Delete story")) + '">' + esc(tr("Delete story")) + "</button>"
      : "";
    return '<div class="story-social"><div class="story-reacts">' + reacts + "</div>" +
      '<form class="story-reply"><input class="story-reply-text" maxlength="280" placeholder="' + esc(tr("Reply to story")) + '" aria-label="' + esc(tr("Reply to story")) + '">' +
      '<button type="button" data-story-act="reply">' + esc(tr("Send")) + "</button></form>" + owner +
      '<div class="story-views" hidden></div><div class="story-confirm" hidden><p>' + esc(tr("Delete this story?")) + '</p>' +
      '<button type="button" data-story-act="delete-yes">' + esc(tr("Delete story")) + '</button>' +
      '<button type="button" data-story-act="delete-no">' + esc(tr("Close")) + "</button></div></div>";
  }

  function renderViewer() {
    var node = box();
    var row = current();
    if (!node || !row) {
      close();
      return;
    }
    var account = row.account;
    var item = row.item;
    mark(account, item);
    var nextItem = account.items[row.index + 1];
    if (!nextItem && view.list[view.account + 1]) nextItem = view.list[view.account + 1].items[0];
    warm(nextItem);
    var bars = account.items.map(function (_item, index) {
      return '<span class="story-bar"><i style="width:' + (index < row.index ? 100 : 0) + '%"></i></span>';
    }).join("");
    var src = mediaUrl(item.url);
    var media = "";
    if (item.type === "video") {
      media = '<video class="story-media" autoplay muted playsinline preload="metadata"' + (item.vine ? " loop" : "") +
        (mediaUrl(item.poster) ? ' poster="' + esc(mediaUrl(item.poster)) + '"' : "") +
        ' src="' + esc(src) + '"></video>';
    } else {
      media = '<img class="story-media" alt="" src="' + esc(src) + '"' +
        (row.index === 0 ? ' fetchpriority="high"' : "") + ' referrerpolicy="no-referrer">';
    }
    var sound = item.type === "video"
      ? '<button type="button" class="story-icon" data-story-act="sound" aria-label="' + (soundOn || item.vine ? tr("Mute") : tr("Unmute")) + '" aria-pressed="' + (soundOn || item.vine ? "true" : "false") + '">' +
        (deps.icon ? deps.icon(soundOn || item.vine ? "vol" : "volOff") : (soundOn ? tr("Mute") : tr("Unmute"))) + "</button>"
      : "";
    var open = https(item.open);
    var menu = '<div class="story-menu" hidden>' +
      (open ? '<a href="' + esc(open) + '" target="_blank" rel="noopener noreferrer">' + esc(tr("Open on {platform}", { platform: platformName(account.platform) })) + "</a>" : "") +
      (item.mine ? '<button type="button" data-story-act="delete">' + esc(tr("Delete story")) + "</button>" : "") +
      ("<button type=\"button\" data-story-act=\"close\"" + ">" + tr("Close") + "<" + "/button></div>");
    node.innerHTML = '<div class="story-frame"><div class="story-top"><div class="story-bars">' + bars + '</div><div class="story-head">' +
      '<span class="story-mini"><span class="story-face">' + face(account) + "</span></span>" +
      '<span class="story-who"><b>' + esc(account.name || account.handle) + "</b><span>" + esc(ago(item.date)) + (item.vine ? " · Vine" : "") + "</span></span>" +
      sound +
      ("<button type=\"button\" class=\"story-icon\" data-story-act=\"menu\" " + "aria-label=\"" + tr("More") + "\"" + " aria-expanded=\"false\">") +
      (deps.icon ? deps.icon("more") : "···") + "</button></div></div>" +
      '<div class="story-stage">' + media + ("<p class=\"story-miss\" hidden" + ">" + tr("Couldn’t load this story.") + "<" + "/p></div>") +
      (item.caption ? '<p class="story-caption">' + esc(item.caption) + "</p>" : "") +
      socialBar(account, item) + menu + "</div>";
    node.hidden = false;
    node.setAttribute("aria-label", (account.name || tr("Story")) + " stories");
    document.documentElement.classList.add("stories-open");
    var video = node.querySelector("video");
    if (video) {
      video.muted = !soundOn;
      video.play().catch(function () { /* the unmute button stays available */ });
      video.addEventListener("loadedmetadata", playTimer);
      if (item.vine) {
        video.addEventListener("timeupdate", function () {
          if (video.currentTime >= 6) video.currentTime = 0;
        });
      }
      video.addEventListener("error", function () {
        var miss = node.querySelector(".story-miss");
        if (miss) miss.hidden = false;
      });
    }
    var image = node.querySelector("img.story-media");
    if (image) {
      image.addEventListener("error", function () {
        var miss = node.querySelector(".story-miss");
        if (miss) miss.hidden = false;
      });
    }
    view.elapsed = 0;
    view.paused = false;
    playTimer();
    if (node.focus) node.focus();
  }

  function renderCompose() {
    var node = box();
    if (!node) return;
    stopTimer();
    pickedFile = null;
    node.innerHTML = '<div class="story-frame story-compose"><div class="story-head">' +
      '<button type="button" class="story-icon" data-story-act="cancel-compose" aria-label="' + esc(tr("Close")) + '">' +
      (deps.icon ? deps.icon("close") : esc(tr("Close"))) + "</button>" +
      "<b>" + esc(tr("Add a story")) + "</b></div>" +
      '<label class="story-file">' + esc(tr("Choose a photo or video")) +
      '<input class="story-file-input" type="file" accept="image/*,video/*"></label>' +
      '<p class="story-file-name" aria-live="polite"></p>' +
      '<label class="story-vine"><input class="story-vine-input" type="checkbox"> ' + esc(tr("Vine, 6 seconds")) + "</label>" +
      '<input class="story-caption-input" maxlength="140" placeholder="' + esc(tr("Caption")) + '" aria-label="' + esc(tr("Caption")) + '">' +
      '<label>' + esc(tr("Audience")) + ' <select class="story-audience"><option value="public">' + esc(tr("Everyone")) + '</option><option value="followers">' + esc(tr("Followers")) + '</option><option value="friends">' + esc(tr("Mutuals")) + '</option><option value="only">' + esc(tr("Only me")) + '</option><option value="list">' + esc(tr("Custom lists")) + "</option></select></label>" +
      (window.AudienceLists && window.AudienceLists.checksHtml ? window.AudienceLists.checksHtml([]) : "") +
      '<button type="button" class="story-post" data-story-act="post">' + esc(tr("Post story")) + "</button>" +
      '<p class="story-miss" hidden>' + esc(tr("Couldn’t post this story.")) + "</p></div>";
    node.hidden = false;
    document.documentElement.classList.add("stories-open");
    var input = node.querySelector(".story-file-input");
    if (input) {
      input.addEventListener("change", function () {
        pickedFile = input.files && input.files[0] ? input.files[0] : null;
        var name = node.querySelector(".story-file-name");
        if (name) name.textContent = pickedFile ? pickedFile.name : "";
      });
    }
    if (node.focus) node.focus();
  }

  function renderConnect() {
    var node = box();
    if (!node) return;
    stopTimer();
    node.innerHTML = '<div class="story-frame story-setup"><div class="story-head">' +
      '<button type="button" class="story-icon" data-story-act="cancel-compose" aria-label="' + esc(tr("Close")) + '">' +
      (deps.icon ? deps.icon("close") : esc(tr("Close"))) + "</button>" +
      "<b>" + esc(tr("Connect Telegram")) + "</b></div>" +
      "<p>" + esc(tr("Telegram stories stay off until the session secret is added.")) + "</p>" +
      '<button type="button" data-story-act="cancel-compose">' + esc(tr("Close setup")) + "</button></div>";
    node.hidden = false;
    document.documentElement.classList.add("stories-open");
    if (node.focus) node.focus();
  }

  function show(accountAt, itemAt) {
    var list = rows();
    if (!list.length) {
      close();
      return;
    }
    if (!view || view.compose || view.connect) view = { list: list };
    view.compose = false;
    view.connect = false;
    view.note = false;
    view.list = list;
    view.account = Math.max(0, Math.min(accountAt, list.length - 1));
    var items = view.list[view.account].items;
    view.index = Math.max(0, Math.min(itemAt, items.length - 1));
    renderViewer();
  }

  function play(account) {
    if (!account || !account.items || !account.items.length) return;
    view = {
      list: [account],
      account: 0,
      index: 0,
      elapsed: 0,
      paused: false,
      compose: false,
      connect: false,
      note: false
    };
    renderViewer();
  }

  function open(id) {
    var list = rows();
    var at = 0;
    var found = false;
    list.forEach(function (account, index) {
      if (account.id === id) { at = index; found = true; }
    });
    if (!found || !list.length || !list[at].items || !list[at].items.length) return;
    view = { list: list, account: at, index: 0, elapsed: 0, paused: false };
    show(at, 0);
  }

  function close() {
    stopTimer();
    view = null;
    pointer = null;
    pickedFile = null;
    var node = box();
    if (node) {
      node.hidden = true;
      node.innerHTML = "";
      node.classList.remove("note-open");
    }
    if (typeof document !== "undefined") document.documentElement.classList.remove("stories-open");
    if (deps.render) deps.render();
  }

  function advance(step) {
    if (!view || view.compose || view.connect) return;
    var account = view.list[view.account];
    if (!account) {
      close();
      return;
    }
    var next = view.index + step;
    if (next >= 0 && next < account.items.length) {
      view.index = next;
      renderViewer();
      return;
    }
    var neighbor = view.account + (step < 0 ? -1 : 1);
    if (neighbor < 0 || neighbor >= view.list.length) {
      close();
      return;
    }
    view.account = neighbor;
    view.index = step < 0 ? view.list[neighbor].items.length - 1 : 0;
    renderViewer();
  }

  function shiftAccount(step) {
    if (!view || view.compose || view.connect) return;
    var neighbor = view.account + step;
    if (neighbor < 0 || neighbor >= view.list.length) {
      if (step > 0) close();
      return;
    }
    view.account = neighbor;
    view.index = 0;
    renderViewer();
  }

  function apiRoot() {
    if (!deps.apiRoot) return "";
    try { return String(deps.apiRoot() || "").replace(/\/$/, ""); } catch (err) { return ""; }
  }

  function submitCompose() {
    var node = box();
    var miss = node && node.querySelector(".story-miss");
    if (!pickedFile || !apiRoot() || !token()) {
      if (miss) miss.hidden = false;
      return;
    }
    var vine = node.querySelector(".story-vine-input");
    var caption = node.querySelector(".story-caption-input");
    var body = new FormData();
    body.append("file", pickedFile);
    body.append("vine", vine && vine.checked ? "1" : "0");
    body.append("caption", caption ? caption.value : "");
    var storyAudience = node.querySelector(".story-audience");
    body.append("audience", storyAudience ? storyAudience.value : "public");
    body.append("listIds", JSON.stringify(window.AudienceLists && window.AudienceLists.selectedLists ? window.AudienceLists.selectedLists(node) : []));
    fetch(apiRoot() + "/v1/stories", {
      method: "POST",
      headers: { Authorization: "Bearer " + token() },
      body: body
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data = data || {};
        data.status = res.status;
        return data;
      });
    }).then(function (data) {
      if (!data || data.status !== 201) {
        if (miss) miss.hidden = false;
        return;
      }
      if (deps.toast) deps.toast(tr("Story posted"));
      close();
      load();
    }).catch(function () {
      if (miss) miss.hidden = false;
    });
  }

  function storyApi(path, opts) {
    var auth = token();
    if (!auth || !deps.api) return Promise.resolve(null);
    opts = opts || {};
    opts.token = auth;
    return deps.api(path, opts);
  }

  function fillViews(panel, data) {
    if (!panel) return;
    var views = (data && data.views) || [];
    var replies = (data && data.replies) || [];
    var html = views.length
      ? views.map(function (row) { return "<p>" + esc(row.name || row.handle || "") + "</p>"; }).join("")
      : "<p>" + esc(tr("No views yet")) + "</p>";
    if (replies.length) {
      html += replies.map(function (row) {
        return "<p>" + esc((row.name || "") + " " + (row.text || "")) + "</p>";
      }).join("");
    }
    panel.innerHTML = html;
    panel.hidden = false;
  }

  function onKey(event) {
    if (!view) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (view.compose || view.connect || view.note) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      advance(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      advance(-1);
    } else if (event.key === " ") {
      event.preventDefault();
    }
  }

  function onPointerDown(event) {
    if (!view || view.compose || view.connect || !box() || !box().contains(event.target)) return;
    var menu = box().querySelector(".story-menu");
    if (menu && !menu.hidden && !event.target.closest(".story-menu")) {
      menu.hidden = true;
      var more = box().querySelector("[data-story-act='menu']");
      if (more) more.setAttribute("aria-expanded", "false");
      resume();
      return;
    }
    if (event.target.closest("button, a, .story-menu, .story-social, input")) return;
    if (event.button != null && event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY, t: Date.now(), id: event.pointerId };
    pause(true);
    if (event.currentTarget.setPointerCapture) {
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (err) { /* already released */ }
    }
  }

  function onPointerUp(event) {
    if (!view || !pointer || pointer.id !== event.pointerId) return;
    var dx = event.clientX - pointer.x;
    var dy = event.clientY - pointer.y;
    var held = Date.now() - pointer.t;
    pointer = null;
    if (dy > 90 && Math.abs(dy) > Math.abs(dx)) {
      close();
      return;
    }
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      shiftAccount(dx < 0 ? 1 : -1);
      return;
    }
    if (held < 280 && Math.abs(dx) < 18 && Math.abs(dy) < 18) {
      var stage = box() && box().querySelector(".story-stage");
      var rect = stage ? stage.getBoundingClientRect() : { left: 0, width: window.innerWidth || 1 };
      advance(event.clientX - rect.left < rect.width * 0.33 ? -1 : 1);
      return;
    }
    resume();
  }

  function onPointerCancel() {
    pointer = null;
    resume();
  }

  function onShellDown(event) {
    if (!event.target.closest || !event.target.closest(".story-shell")) return;
    if (event.target.closest("#stories")) return;
    shellPointer = { x: event.clientX, y: event.clientY, id: event.pointerId };
    var card = event.target.closest(".story-card, .note-slot");
    if (!card || card.classList.contains("story-self") || card.classList.contains("story-connect")) return;
    var button = card.querySelector("[data-story-act='org-menu']");
    if (!button) return;
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(function () {
      holdTimer = 0;
      suppressClick = true;
      openOrgMenu(button);
    }, 500);
  }

  function onShellUp(event) {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
    if (!shellPointer || shellPointer.id !== event.pointerId) return;
    var dx = event.clientX - shellPointer.x;
    var dy = event.clientY - shellPointer.y;
    shellPointer = null;
    if (Math.abs(dx) > Math.abs(dy)) return;
    if (dy <= -48) { suppressClick = true; cycleBar(-1); }
    else if (dy >= 48) { suppressClick = true; cycleBar(1); }
  }

  function onClick(event) {
    if (suppressClick) {
      suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    var act = event.target.closest && event.target.closest("[data-story-act]");
    if (!act) return;
    var name = act.getAttribute("data-story-act");
    if (name === "fold") { event.preventDefault(); event.stopPropagation(); cycleBar(-1); return; }
    if (name === "expand") { event.preventDefault(); event.stopPropagation(); applyBar("expanded"); return; }
    if (name === "org-menu") {
      event.preventDefault();
      event.stopPropagation();
      openOrgMenu(act);
      return;
    }
    if (name === "org-close") { event.preventDefault(); event.stopPropagation(); orgMenu = null; paintOrg(); return; }
    if (name === "pin" || name === "unpin" || name === "pin-up" || name === "pin-down") {
      event.preventDefault();
      event.stopPropagation();
      changePin(name);
      return;
    }
    if (name === "hide-source") { event.preventDefault(); event.stopPropagation(); hideCurrent(); return; }
    if (name === "unhide") {
      event.preventDefault();
      event.stopPropagation();
      unhide(act.getAttribute("data-id") || "");
      return;
    }
    if (name === "folder-pick") {
      event.preventDefault();
      event.stopPropagation();
      var orgPick = readOrg();
      orgPick.active = act.getAttribute("data-id") || "";
      writeOrg(orgPick);
      paintOrg();
      return;
    }
    if (name === "folder-new") { event.preventDefault(); event.stopPropagation(); openFolderSheet(""); return; }
    if (name === "folder-save") { event.preventDefault(); event.stopPropagation(); saveFolderSheet(); return; }
    if (name === "folder-delete") { event.preventDefault(); event.stopPropagation(); deleteFolder(act.getAttribute("data-id") || ""); return; }
    if (name === "folder-left" || name === "folder-right") {
      event.preventDefault();
      event.stopPropagation();
      moveFolder(act.getAttribute("data-id") || "", name === "folder-left" ? -1 : 1);
      return;
    }
    if (name === "folder-add") { event.preventDefault(); event.stopPropagation(); openFolderAdd(); return; }
    if (name === "folder-member") {
      event.preventDefault();
      event.stopPropagation();
      toggleFolderMember(act.getAttribute("data-id") || "");
      return;
    }
    if (name === "hidden-open") { event.preventDefault(); event.stopPropagation(); openHidden(); return; }
    if (name === "note") {
      event.preventDefault();
      event.stopPropagation();
      var handle = act.getAttribute("data-handle") || "";
      if (handle === "self") openOwnNote();
      else openTheirNote(handle);
      return;
    }
    if (name === "note-save") { event.preventDefault(); event.stopPropagation(); saveNote(); return; }
    if (name === "note-delete") { event.preventDefault(); event.stopPropagation(); deleteNote(); return; }
    if (name === "note-emoji") {
      event.preventDefault();
      event.stopPropagation();
      var field = box() && box().querySelector(".note-text");
      if (field) {
        var next = String(field.value || "") + (act.getAttribute("data-emoji") || "");
        field.value = Array.from(next).slice(0, 60).join("");
      }
      return;
    }
    if (name === "note-react") {
      event.preventDefault();
      event.stopPropagation();
      if (!view || !view.handle) return;
      storyApi("/v1/notes/react", { method: "POST", body: { handle: view.handle, emoji: act.getAttribute("data-emoji") || "" } }).then(function (body) {
        if (deps.toast) deps.toast(body && body.status === 200 ? tr("Reaction sent") : tr("Couldn’t react to that note."));
      });
      return;
    }
    if (name === "note-reply") {
      event.preventDefault();
      event.stopPropagation();
      sendNoteReply();
      return;
    }
    if (name === "add") {
      event.preventDefault();
      event.stopPropagation();
      view = { compose: true };
      renderCompose();
      return;
    }
    if (name === "connect") {
      event.preventDefault();
      event.stopPropagation();
      view = { connect: true };
      renderConnect();
      return;
    }
    if (name === "post") { event.preventDefault(); event.stopPropagation(); submitCompose(); return; }
    if (name === "cancel-compose") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!view || !box() || view.compose || view.connect || view.note) return;
    if (!box().contains(act)) return;
    if (act.tagName !== "A") event.preventDefault();
    event.stopPropagation();
    if (name === "close") close();
    else if (name === "menu") {
      var menu = box().querySelector(".story-menu");
      if (!menu) return;
      menu.hidden = !menu.hidden;
      act.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
      pause(!menu.hidden);
      if (menu.hidden) resume();
    } else if (name === "sound") {
      soundOn = !soundOn;
      var video = box().querySelector("video");
      if (video) {
        video.muted = !soundOn;
        video.play().catch(function () { /* the control still reflects the choice */ });
      }
      act.setAttribute("aria-label", soundOn ? tr("Mute") : tr("Unmute"));
      act.setAttribute("aria-pressed", soundOn ? "true" : "false");
      act.innerHTML = deps.icon ? deps.icon(soundOn ? "vol" : "volOff") : (soundOn ? tr("Mute") : tr("Unmute"));
    } else if (name === "delete") {
      var confirm = box().querySelector(".story-confirm");
      if (confirm) confirm.hidden = false;
      pause(false);
    } else if (name === "delete-no") {
      var confirmNo = box().querySelector(".story-confirm");
      if (confirmNo) confirmNo.hidden = true;
      resume();
    } else if (name === "delete-yes") {
      var row = current();
      if (!row || !row.item) return;
      storyApi("/v1/stories/" + encodeURIComponent(row.item.id), { method: "DELETE" }).then(function (body) {
        if (body && body.status === 200) {
          close();
          load();
        } else if (deps.toast) deps.toast(tr("Couldn’t delete this story."));
      });
    } else if (name === "views") {
      var rowViews = current();
      if (!rowViews || !rowViews.item) return;
      storyApi("/v1/stories/" + encodeURIComponent(rowViews.item.id) + "/views").then(function (body) {
        fillViews(box() && box().querySelector(".story-views"), body);
      });
      pause(false);
    } else if (name === "react") {
      var rowReact = current();
      if (!rowReact || !rowReact.item) return;
      storyApi("/v1/stories/" + encodeURIComponent(rowReact.item.id) + "/react", { method: "POST", body: { emoji: act.getAttribute("data-emoji") || "" } });
    } else if (name === "reply") {
      var form = act.closest("form");
      var rowReply = current();
      var input = form && form.querySelector(".story-reply-text");
      var text = input ? input.value.trim() : "";
      if (!rowReply || !rowReply.item || !text) return;
      storyApi("/v1/stories/" + encodeURIComponent(rowReply.item.id) + "/reply", { method: "POST", body: { text: text } }).then(function (body) {
        if (body && (body.status === 201 || body.status === 200)) {
          if (input) input.value = "";
          if (deps.toast) deps.toast(tr("Reply sent"));
        } else if (deps.toast) deps.toast(tr("Couldn’t send that reply."));
      });
    }
  }

  function mergeDocs(doc, extra) {
    var base = doc && typeof doc === "object" ? doc : { accounts: [] };
    var accounts = (base.accounts || []).filter(function (row) { return row && row.platform !== "app"; });
    if (extra && extra.accounts) {
      extra.accounts.forEach(function (row) {
        if (row && row.platform === "app") accounts.push(row);
      });
    }
    return {
      updated: base.updated || "",
      accounts: accounts,
      telegramConnected: !!(base.telegramConnected || (extra && extra.telegramConnected))
    };
  }

  function paintOrg() {
    orgMenu = null;
    if (deps.render) deps.render();
  }

  function openOrgMenu(act) {
    orgMenu = {
      id: act.getAttribute("data-id") || "",
      name: act.getAttribute("data-name") || "",
      handle: act.getAttribute("data-handle") || "",
      platform: act.getAttribute("data-platform") || ""
    };
    if (deps.render) deps.render();
  }

  function changePin(action) {
    if (!orgMenu || !orgMenu.id) return;
    var org = readOrg();
    var at = org.pins.indexOf(orgMenu.id);
    if (action === "pin" && at < 0) org.pins.unshift(orgMenu.id);
    if (action === "unpin" && at >= 0) org.pins.splice(at, 1);
    if (action === "pin-up" && at > 0) {
      var up = org.pins[at - 1];
      org.pins[at - 1] = org.pins[at];
      org.pins[at] = up;
    }
    if (action === "pin-down" && at >= 0 && at < org.pins.length - 1) {
      var down = org.pins[at + 1];
      org.pins[at + 1] = org.pins[at];
      org.pins[at] = down;
    }
    writeOrg(org);
    orgMenu = null;
    paintOrg();
  }

  function hideCurrent() {
    if (!orgMenu || !orgMenu.id) return;
    var org = readOrg();
    var keys = keysFor(orgMenu.id, orgMenu.handle, orgMenu.platform);
    org.hidden = org.hidden.filter(function (row) { return keys.indexOf(row.id) < 0; });
    org.hidden.push({
      id: orgMenu.id,
      name: orgMenu.name || orgMenu.handle || "",
      platform: orgMenu.platform || "",
      handle: orgMenu.handle || "",
      also: keys.filter(function (id) { return id !== orgMenu.id; })
    });
    org.pins = org.pins.filter(function (id) { return keys.indexOf(id) < 0; });
    org.folders.forEach(function (folder) {
      folder.members = (folder.members || []).filter(function (id) { return keys.indexOf(id) < 0; });
    });
    writeOrg(org);
    orgMenu = null;
    paintOrg();
  }

  function unhide(id) {
    var org = readOrg();
    org.hidden = org.hidden.filter(function (row) { return row.id !== id; });
    writeOrg(org);
    openHidden();
  }

  function openFolderSheet(id) {
    var folder = null;
    readOrg().folders.forEach(function (item) { if (item.id === id) folder = item; });
    view = { org: "folder", folderId: id, name: folder ? folder.name : "", icon: folder ? folder.icon : "" };
    renderFolderSheet();
  }

  function renderFolderSheet() {
    var node = box();
    if (!node || !view) return;
    stopTimer();
    node.classList.add("note-open");
    node.innerHTML = '<div class="note-sheet" role="dialog" aria-modal="true" aria-label="' + esc(tr("Story folders")) + '">' +
      '<div class="note-sheet-bar"><button type="button" data-story-act="cancel-compose" aria-label="' + esc(tr("Close")) + '">×</button><b>' + esc(view.folderId ? tr("Rename") : tr("New folder")) + '</b><button type="button" data-story-act="folder-save">' + esc(tr("Save")) + "</button></div>" +
      '<input class="note-folder-name" aria-label="' + esc(tr("Folder name")) + '" placeholder="' + esc(tr("Folder name")) + '" value="' + esc(view.name || "") + '">' +
      '<input class="note-folder-icon" aria-label="' + esc(tr("Folder icon")) + '" placeholder="' + esc(tr("Folder icon")) + '" value="' + esc(view.icon || "") + '">' +
      (view.folderId ? '<button type="button" data-story-act="folder-left" data-id="' + esc(view.folderId) + '">' + esc(tr("Move earlier")) + '</button><button type="button" data-story-act="folder-right" data-id="' + esc(view.folderId) + '">' + esc(tr("Move later")) + '</button><button type="button" data-story-act="folder-delete" data-id="' + esc(view.folderId) + '">' + esc(tr("Delete folder")) + "</button>" : "") +
      "</div>";
    node.hidden = false;
    document.documentElement.classList.add("stories-open");
  }

  function saveFolderSheet() {
    var node = box();
    if (!node || !view) return;
    var name = node.querySelector(".note-folder-name");
    var icon = node.querySelector(".note-folder-icon");
    var org = readOrg();
    var folderName = name ? String(name.value || "") : "";
    var folderIcon = icon ? String(icon.value || "") : "";
    if (view.folderId) {
      org.folders.forEach(function (folder) {
        if (folder.id === view.folderId) {
          folder.name = folderName;
          folder.icon = folderIcon;
        }
      });
    } else {
      org.folders.push({ id: "fld_" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36), name: folderName, icon: folderIcon, members: [] });
    }
    writeOrg(org);
    close();
  }

  function deleteFolder(id) {
    var org = readOrg();
    org.folders = org.folders.filter(function (folder) { return folder.id !== id; });
    if (org.active === id) org.active = "";
    writeOrg(org);
    close();
  }

  function moveFolder(id, dir) {
    var org = readOrg();
    var at = -1;
    org.folders.forEach(function (folder, index) { if (folder.id === id) at = index; });
    var next = at + dir;
    if (at < 0 || next < 0 || next >= org.folders.length) return;
    var swap = org.folders[at];
    org.folders[at] = org.folders[next];
    org.folders[next] = swap;
    writeOrg(org);
    view.name = org.folders[next].name;
    view.icon = org.folders[next].icon;
    renderFolderSheet();
  }

  function openFolderAdd() {
    if (!orgMenu) return;
    view = { org: "add", source: orgMenu };
    var org = readOrg();
    var node = box();
    if (!node) return;
    stopTimer();
    var rows = org.folders.map(function (folder) {
      var on = (folder.members || []).indexOf(orgMenu.id) >= 0;
      return '<button type="button" data-story-act="folder-member" data-id="' + esc(folder.id) + '">' + esc((on ? "✓ " : "") + (folder.icon ? folder.icon + " " : "") + folder.name) + "</button>";
    }).join("");
    node.classList.add("note-open");
    node.innerHTML = '<div class="note-sheet" role="dialog" aria-modal="true" aria-label="' + esc(tr("Add to folder")) + '">' +
      '<div class="note-sheet-bar"><button type="button" data-story-act="cancel-compose" aria-label="' + esc(tr("Close")) + '">×</button><b>' + esc(tr("Add to folder")) + "</b><span></span></div>" +
      (rows || '<p>' + esc(tr("New folder")) + "</p>") +
      '<button type="button" data-story-act="folder-new">' + esc(tr("New folder")) + "</button></div>";
    node.hidden = false;
    document.documentElement.classList.add("stories-open");
    orgMenu = null;
  }

  function toggleFolderMember(folderId) {
    if (!view || !view.source) return;
    var org = readOrg();
    var keys = keysFor(view.source.id, view.source.handle, view.source.platform);
    org.folders.forEach(function (folder) {
      if (folder.id !== folderId) return;
      var has = keys.some(function (id) { return folder.members.indexOf(id) >= 0; });
      if (has) folder.members = folder.members.filter(function (id) { return keys.indexOf(id) < 0; });
      else folder.members = folder.members.concat(keys);
    });
    writeOrg(org);
    close();
  }

  function openHidden() {
    var org = readOrg();
    var node = box();
    if (!node) return;
    stopTimer();
    view = { org: "hidden" };
    var rows = org.hidden.map(function (row) {
      var label = row.name || row.handle || row.id;
      return '<div class="story-hidden-row"><span>' + esc(label) + '</span><button type="button" data-story-act="unhide" data-id="' + esc(row.id) + '">' + esc(tr("Unhide")) + "</button></div>";
    }).join("");
    node.classList.add("note-open");
    node.innerHTML = '<div class="note-sheet" role="dialog" aria-modal="true" aria-label="' + esc(tr("Hidden stories")) + '">' +
      '<div class="note-sheet-bar"><button type="button" data-story-act="cancel-compose" aria-label="' + esc(tr("Close")) + '">×</button><b>' + esc(tr("Hidden stories")) + "</b><span></span></div>" +
      (rows || "<p>" + esc(tr("No hidden stories")) + "</p>") + "</div>";
    node.hidden = false;
    document.documentElement.classList.add("stories-open");
  }

  function pullOrg() {
    var auth = token();
    if (!auth || !deps.api) return Promise.resolve();
    return deps.api("/v1/story-bar", { token: auth }).then(function (body) {
      if (!body || body.status !== 200 || !body.doc) return;
      var local = readOrg();
      var remoteAt = Number(body.updatedAt) || 0;
      if (remoteAt > (local.updatedAt || 0)) {
        var doc = cleanOrg(body.doc);
        doc.updatedAt = remoteAt;
        try { localStorage.setItem(ORG_KEY, JSON.stringify(doc)); } catch (err) { /* private mode */ }
        if (deps.render) deps.render();
      } else if ((local.updatedAt || 0) > remoteAt) {
        deps.api("/v1/story-bar", { method: "PUT", token: auth, body: local }).catch(function () {});
      }
    }).catch(function () {});
  }

  function setOrg(org) {
    var next = cleanOrg(org);
    next.updatedAt = Number(org && org.updatedAt) || Date.now();
    try { localStorage.setItem(ORG_KEY, JSON.stringify(next)); } catch (err) { /* private mode */ }
    return next;
  }

  function setNotes(pack) {
    notes = {
      mine: pack && pack.mine ? pack.mine : null,
      notes: (pack && pack.notes) || []
    };
  }

  function loadNotes() {
    var auth = token();
    if (!auth || !deps.api) return Promise.resolve();
    return deps.api("/v1/notes", { token: auth }).then(function (body) {
      if (body && body.status === 200) setNotes(body);
    }).catch(function () {});
  }

  function openOwnNote() {
    view = { note: "edit" };
    renderOwnNote();
  }

  function openTheirNote(handle) {
    var found = null;
    ((notes && notes.notes) || []).forEach(function (item) {
      if (item && item.handle === handle) found = item;
    });
    if (!found) return;
    view = { note: "reply", handle: handle, text: found.text || "", name: found.name || handle };
    renderTheirNote();
  }

  function renderOwnNote() {
    var node = box();
    if (!node) return;
    stopTimer();
    var mine = notes && notes.mine;
    var audience = mine && mine.audience ? mine.audience : "followers";
    var expire = !(mine && mine.expiresAt === 0);
    var emoji = NOTE_EMOJI.map(function (item) {
      return '<button type="button" data-story-act="note-emoji" data-emoji="' + item + '">' + item + "</button>";
    }).join("");
    node.classList.add("note-open");
    node.innerHTML = '<div class="note-sheet" role="dialog" aria-modal="true" aria-label="' + esc(tr("Your note")) + '">' +
      '<div class="note-sheet-bar"><button type="button" data-story-act="cancel-compose" aria-label="' + esc(tr("Close")) + '">×</button><b>' + esc(tr("Your note")) + '</b><button type="button" data-story-act="note-save">' + esc(tr("Save")) + "</button></div>" +
      '<textarea class="note-text" maxlength="60" aria-label="' + esc(tr("Share a thought...")) + '">' + esc(mine && mine.text || "") + "</textarea>" +
      '<div class="note-emoji">' + emoji + "</div>" +
      '<label>' + esc(tr("Who can see this")) + ' <select class="note-audience" aria-label="' + esc(tr("Who can see this")) + '">' +
      '<option value="followers"' + (audience === "followers" ? " selected" : "") + ">" + esc(tr("Followers")) + "</option>" +
      '<option value="friends"' + (audience === "friends" ? " selected" : "") + ">" + esc(tr("Mutuals")) + "</option>" +
      '<option value="only"' + (audience === "only" ? " selected" : "") + ">" + esc(tr("Only me")) + "</option>" +
      '<option value="list"' + (audience === "list" ? " selected" : "") + ">" + esc(tr("Custom lists")) + "</option></select></label>" +
      (window.AudienceLists && window.AudienceLists.checksHtml ? window.AudienceLists.checksHtml(mine && mine.listIds) : "") +
      '<label class="note-expire"><input class="note-expire-input" type="checkbox"' + (expire ? " checked" : "") + "> " + esc(tr("Expire after 24 hours")) + "</label>" +
      (mine && mine.text ? '<button type="button" data-story-act="note-delete">' + esc(tr("Delete note")) + "</button>" : "") +
      '<p class="story-miss" hidden>' + esc(tr("Couldn’t save that note.")) + "</p></div>";
    node.hidden = false;
    document.documentElement.classList.add("stories-open");
    if (node.focus) node.focus();
  }

  function renderTheirNote() {
    var node = box();
    if (!node || !view) return;
    stopTimer();
    var emoji = NOTE_EMOJI.map(function (item) {
      return '<button type="button" data-story-act="note-react" data-emoji="' + item + '" aria-label="' + esc(tr("Send a reaction")) + '">' + item + "</button>";
    }).join("");
    node.classList.add("note-open");
    node.innerHTML = '<div class="note-sheet" role="dialog" aria-modal="true" aria-label="' + esc(view.name || tr("Note")) + '">' +
      '<div class="note-sheet-bar"><button type="button" data-story-act="cancel-compose" aria-label="' + esc(tr("Close")) + '">×</button><b>' + esc(view.name || "") + "</b><span></span></div>" +
      '<p class="note-quote">' + esc(view.text || "") + "</p>" +
      '<div class="note-emoji">' + emoji + "</div>" +
      '<textarea class="note-reply" maxlength="280" aria-label="' + esc(tr("Reply")) + '" placeholder="' + esc(tr("Reply")) + '"></textarea>' +
      '<button type="button" data-story-act="note-reply">' + esc(tr("Send")) + "</button>" +
      '<p class="story-miss" hidden>' + esc(tr("Couldn’t send that reply.")) + "</p></div>";
    node.hidden = false;
    document.documentElement.classList.add("stories-open");
    if (node.focus) node.focus();
  }

  function saveNote() {
    var node = box();
    if (!node) return;
    var field = node.querySelector(".note-text");
    var audience = node.querySelector(".note-audience");
    var expire = node.querySelector(".note-expire-input");
    var text = field ? String(field.value || "").trim() : "";
    storyApi("/v1/notes", {
      method: "PUT",
      body: { text: text, audience: audience ? audience.value : "followers", expire: !(expire && !expire.checked), listIds: window.AudienceLists && window.AudienceLists.selectedLists ? window.AudienceLists.selectedLists(node) : [] }
    }).then(function (body) {
      if (body && body.status === 200) {
        close();
        load();
        if (deps.toast) deps.toast(tr("Note saved"));
      } else {
        var miss = node.querySelector(".story-miss");
        if (miss) miss.hidden = false;
      }
    });
  }

  function deleteNote() {
    storyApi("/v1/notes", { method: "DELETE" }).then(function (body) {
      if (body && body.status === 200) {
        notes.mine = null;
        close();
        load();
      } else if (deps.toast) deps.toast(tr("Couldn’t save that note."));
    });
  }

  function sendNoteReply() {
    var node = box();
    if (!node || !view || !view.handle) return;
    var field = node.querySelector(".note-reply");
    var text = field ? String(field.value || "").trim() : "";
    if (!text) return;
    storyApi("/v1/notes/reply", { method: "POST", body: { handle: view.handle, text: text } }).then(function (body) {
      if (body && (body.status === 201 || body.status === 200)) {
        close();
        if (deps.toast) deps.toast(tr("Reply sent"));
        if (typeof location !== "undefined") location.hash = "#/messages";
      } else {
        var miss = node.querySelector(".story-miss");
        if (miss) miss.hidden = false;
      }
    });
  }

  function loadApp() {
    var auth = token();
    if (!auth || !deps.api) return Promise.resolve(null);
    return deps.api("/v1/stories", { token: auth }).then(function (body) {
      if (!body || body.status !== 200) return null;
      return body;
    }).catch(function () { return null; });
  }

  function apply(doc) {
    raw = doc && typeof doc === "object" ? doc : { accounts: [] };
    if (!raw.accounts) raw.accounts = [];
    raw.telegramConnected = !!raw.telegramConnected;
    loadedAt = Date.now();
    if (view && !view.compose && !view.connect && !view.note) {
      var id = view.list[view.account] && view.list[view.account].id;
      var index = view.index;
      var list = rows();
      var at = 0;
      list.forEach(function (account, i) { if (account.id === id) at = i; });
      if (!list.length) close();
      else show(at, index);
      return;
    }
    /* Home is where the tray is drawn. A menu or composer there must not
       be rebuilt out from under the reader; the deferred paint runs when
       that view closes. */
    var hash = (typeof location !== "undefined" && location.hash) || "#/";
    if (!/^#\/(?:$|home(?:[/?]|$)|following(?:[/?]|$))/.test(hash)) return;
    if (deps.renderBackground) deps.renderBackground();
    else if (deps.render) deps.render();
  }

  function load() {
    var headers = { "X-Feed-Refresh": "1", "Accept": "application/json" };
    var local = fetch("stories.json", { cache: "no-cache", headers: headers }).then(function (res) {
      if (!res.ok) throw new Error("missing");
      return res.json();
    });
    var remote = deps.dataUrl
      ? local.catch(function () {
        return fetch(deps.dataUrl, { cache: "no-cache" }).then(function (res) {
          if (!res.ok) throw new Error("missing");
          return res.json();
        });
      })
      : local;
    return remote.then(function (doc) {
      return Promise.all([loadApp(), loadNotes()]).then(function (pair) { apply(mergeDocs(doc, pair[0])); });
    }).catch(function () {
      return Promise.all([loadApp(), loadNotes()]).then(function (pair) { apply(mergeDocs({ accounts: [] }, pair[0])); });
    });
  }

  function bind(next) {
    deps = next || {};
  }

  function start() {
    if (typeof document === "undefined") return;
    var node = box();
    if (node && !node.dataset.bound) {
      node.dataset.bound = "1";
      node.tabIndex = -1;
      node.addEventListener("pointerdown", onPointerDown);
      node.addEventListener("pointerup", onPointerUp);
      node.addEventListener("pointercancel", onPointerCancel);
    }
    load();
    pullOrg();
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    var lastScrollY = 0;
    var touchY = 0;
    /* Where the app slides its header away on scroll (phones and tablets),
       the tray leaves with the header, so scrolling must not resize it: a
       tray that shrinks and grows while the page scrolls changes the header
       height every frame and moves the posts under the finger. */
    var headerSlides = function () {
      if (!deps.headerSlides) return false;
      try { return !!deps.headerSlides(); } catch (err) { return false; }
    };
    window.addEventListener("scroll", function () {
      if (!document.querySelector(".story-shell")) return;
      if (headerSlides()) { lastScrollY = window.scrollY || 0; return; }
      var y = window.scrollY || document.documentElement.scrollTop || 0;
      var delta = y - lastScrollY;
      lastScrollY = y;
      trackScroll(delta, y);
    }, { passive: true });
    window.addEventListener("wheel", function (event) {
      if (!document.querySelector(".story-shell")) return;
      if (headerSlides()) return;
      var y = window.scrollY || document.documentElement.scrollTop || 0;
      if (y <= 0 && event.deltaY < 0) trackScroll(event.deltaY, 0);
    }, { passive: true });
    window.addEventListener("touchstart", function (event) {
      if (event.touches && event.touches[0]) touchY = event.touches[0].clientY;
    }, { passive: true });
    window.addEventListener("touchmove", function (event) {
      if (!document.querySelector(".story-shell") || !event.touches || !event.touches[0]) return;
      if (headerSlides()) return;
      var y = event.touches[0].clientY;
      var delta = touchY - y;
      touchY = y;
      var top = window.scrollY || document.documentElement.scrollTop || 0;
      if (top <= 0 && delta < 0) trackScroll(delta, 0);
    }, { passive: true });
  }
  if (typeof document !== "undefined") {
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onShellDown, true);
    document.addEventListener("pointerup", onShellUp, true);
    document.addEventListener("contextmenu", function (event) {
      var button = event.target.closest && event.target.closest("[data-story-act='org-menu']");
      if (!button) return;
      event.preventDefault();
      openOrgMenu(button);
    }, true);
    document.addEventListener("visibilitychange", function () {
      if (!view) {
        if (document.visibilityState === "visible" && loadedAt && Date.now() - loadedAt > 10 * 60 * 1000) load();
        return;
      }
      if (view.compose || view.connect) return;
      if (document.visibilityState === "hidden") pause(false);
      else resume();
    });
  }

  root.Stories = {
    bind: bind,
    start: start,
    open: open,
    play: play,
    close: close,
    homeTray: homeTray,
    trayExtra: trayExtra,
    apply: apply,
    setNotes: setNotes,
    setOrg: setOrg,
    organize: organize,
    barState: barState,
    applyBar: applyBar,
    nudge: function (delta, scrollTop) { trackScroll(delta, scrollTop || 0); },
    activeAccounts: activeAccounts,
    orderedAccounts: orderedAccounts,
    itemKey: itemKey
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
