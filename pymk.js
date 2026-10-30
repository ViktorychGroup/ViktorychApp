/* People you may know: typed suggestion cards inside the Home timeline,
   styled like X's in-feed "Who to follow" block, plus a full page at
   #/connect and the settings that control them.

   Local first: the last answer is kept in localStorage and drawn at once;
   a background refresh runs when it is older than 30 minutes. Offline, the
   cached card still shows. Only real Viktorych accounts come from the
   Worker (GET /v1/suggestions); follows go through the normal follow path
   (data-act="follow"), which already updates counts optimistically.

   app.js passes its helpers once with setHost(); the module never reaches
   into app.js state. Clicks arrive through app.js as data-act="pymk-*". */
(function (root) {
  "use strict";

  var PREF_KEY = "viktorychapp-pymk";
  var CACHE_KEY = "viktorychapp-pymk-cache";
  var REFRESH_MS = 30 * 60 * 1000;
  var RETRY_MS = 5 * 60 * 1000;
  var GAP = 40;
  var ROWS = 3;
  var GROUPS = ["people", "companies", "media", "organizations", "creators", "accounts", "communities"];
  var KINDS = ["person", "business", "organization", "media", "government", "creator", "bot", "community", "other"];
  var SQUARE = { business: 1, organization: 1, government: 1, media: 1, community: 1 };
  var TITLES = {
    people: function () { return tr("People you may know"); },
    companies: function () { return tr("Companies you may like"); },
    media: function () { return tr("News & media to follow"); },
    organizations: function () { return tr("Organizations to follow"); },
    creators: function () { return tr("Creators for you"); },
    accounts: function () { return tr("More accounts to follow"); },
    communities: function () { return tr("Communities to join"); }
  };
  var KIND_LABELS = {
    person: function () { return tr("Person"); },
    business: function () { return tr("Business or company"); },
    organization: function () { return tr("Organization"); },
    media: function () { return tr("News or media"); },
    government: function () { return tr("Government"); },
    creator: function () { return tr("Creator"); },
    bot: function () { return tr("Bot or automated feed"); },
    community: function () { return tr("Community"); },
    other: function () { return tr("Other"); }
  };

  var host = null;
  var mem = { prefs: null, cache: null, loading: false, lastTry: 0, menu: "", followedNow: {}, rot: -1, serverPrefs: null, prefsLoading: false };

  function tr(key, vars) { return root.t ? root.t(key, vars) : key; }
  function trn(key, n, vars) { return root.tn ? root.tn(key, n, vars) : key; }
  function esc(text) {
    if (host && host.esc) return host.esc(text);
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function readJson(key) {
    try { var raw = root.localStorage && root.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch (err) { return null; }
  }
  function writeJson(key, value) {
    try { root.localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* storage full or blocked */ }
  }

  function defaults() {
    var types = {};
    GROUPS.forEach(function (g) { types[g] = true; });
    return { on: true, types: types, carousel: false, fewer: 0, hidden: [], pending: [] };
  }
  function prefs() {
    if (mem.prefs) return mem.prefs;
    var saved = readJson(PREF_KEY) || {};
    var base = defaults();
    if (typeof saved.on === "boolean") base.on = saved.on;
    if (typeof saved.carousel === "boolean") base.carousel = saved.carousel;
    base.fewer = Math.max(0, Math.min(4, Number(saved.fewer) || 0));
    if (saved.types && typeof saved.types === "object") GROUPS.forEach(function (g) { if (typeof saved.types[g] === "boolean") base.types[g] = saved.types[g]; });
    base.hidden = Array.isArray(saved.hidden) ? saved.hidden.slice(-500) : [];
    base.pending = Array.isArray(saved.pending) ? saved.pending.slice(-50) : [];
    mem.prefs = base;
    return base;
  }
  function savePrefs() { writeJson(PREF_KEY, mem.prefs); }

  function api() { return root.ViktorychAccounts || null; }
  function me() { var a = api(); return a && a.account ? a.account() : null; }
  function token() { var a = api(); return a && a.token ? a.token() : ""; }
  function redraw() {
    if (host && host.render) host.render();
    else { var a = api(); if (a && a.requestRender) a.requestRender(); }
  }

  /* ---------- Insertion plan (pure, tested) ---------- */

  /* Where cards go in a list of `count` posts: the first after post 8–12
     (picked by the seed so it doesn't move between renders), then at most
     one per GAP posts, spaced wider for each "Show fewer". Returns the
     post indexes a card follows. */
  function plan(count, opts) {
    opts = opts || {};
    var seed = Math.abs(Number(opts.seed) || 0);
    var first = 8 + (seed % 5);
    var gap = GAP * (1 + Math.max(0, Number(opts.fewer) || 0));
    var max = Number(opts.max) > 0 ? Number(opts.max) : 99;
    var out = [];
    for (var at = first; at <= count && out.length < max; at += gap) out.push(at);
    return out;
  }

  /* Groups that have something to show, rotated so consecutive cards and
     consecutive visits don't repeat the same type. */
  function rotation(groups, rot) {
    if (!groups.length) return [];
    var start = Math.abs(Number(rot) || 0) % groups.length;
    return groups.slice(start).concat(groups.slice(0, start));
  }

  function daySeed() {
    var d = new Date();
    return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
  }
  function rotCounter() {
    if (mem.rot >= 0) return mem.rot;
    var saved = readJson(PREF_KEY + "-rot");
    var next = (saved && Number(saved.n) >= 0 ? Number(saved.n) : 0) + 1;
    writeJson(PREF_KEY + "-rot", { n: next });
    mem.rot = next;
    return next;
  }

  /* ---------- Data ---------- */

  function cache() {
    if (mem.cache) return mem.cache;
    var saved = readJson(CACHE_KEY);
    var who = me();
    if (saved && who && saved.who === who.publicId && saved.groups) mem.cache = saved;
    return mem.cache;
  }

  function flushPending() {
    var p = prefs();
    var a = api();
    if (!p.pending.length || !a || !a.call || !token() || (root.navigator && root.navigator.onLine === false)) return;
    var list = p.pending.slice();
    list.forEach(function (item) {
      a.call("/v1/suggestions/dismiss", { method: "POST", token: token(), body: item }).then(function (res) {
        if (res && (res.status === 200 || res.status === 400)) {
          p.pending = p.pending.filter(function (x) { return JSON.stringify(x) !== JSON.stringify(item); });
          savePrefs();
        }
      }).catch(function () { /* stays queued */ });
    });
  }

  function refresh(force) {
    var a = api();
    var who = me();
    if (!a || !a.call || !who || !token() || mem.loading) return;
    if (root.navigator && root.navigator.onLine === false) return;
    var held = cache();
    var now = Date.now();
    if (!force && held && now - Number(held.got || 0) < REFRESH_MS) return;
    if (!force && now - mem.lastTry < RETRY_MS && !held) return;
    mem.loading = true;
    mem.lastTry = now;
    flushPending();
    a.call("/v1/suggestions" + (force ? "?fresh=1" : ""), { token: token() }).then(function (res) {
      mem.loading = false;
      if (!res || res.status !== 200 || !res.groups) return;
      var next = { who: who.publicId, got: Date.now(), at: res.at || Date.now(), groups: res.groups };
      var changed = JSON.stringify((held && held.groups) || null) !== JSON.stringify(next.groups);
      mem.cache = next;
      writeJson(CACHE_KEY, next);
      if (changed) redraw();
    }).catch(function () { mem.loading = false; });
  }

  function isHidden(key) { return prefs().hidden.indexOf(key) >= 0; }
  function rowKey(group, item) { return group === "communities" ? "c:" + item.id : String(item.id || ""); }
  function followed(id) { return !!(host && host.isFollowed && host.isFollowed(id)); }

  /* Rows still worth showing in a group: not dismissed here, and not
     followed before this visit (rows followed from the card stay, showing
     "Following", like X). */
  function rowsFor(group) {
    var held = cache();
    var list = held && held.groups && Array.isArray(held.groups[group]) ? held.groups[group] : [];
    return list.filter(function (item) {
      if (!item || !item.id) return false;
      if (isHidden(rowKey(group, item))) return false;
      if (group !== "communities" && followed(item.id) && !mem.followedNow[item.id]) return false;
      return true;
    });
  }

  function liveGroups() {
    var p = prefs();
    var out = GROUPS.filter(function (g) { return p.types[g] !== false && rowsFor(g).length > 0; });
    return out;
  }

  function enabled() { return prefs().on !== false && !!me(); }

  /* ---------- Markup ---------- */

  function reasonText(group, item) {
    if (group === "communities") return trn("{n} people you follow are members", item.n || 1);
    var r = item.r || {};
    var person = item.k === "person" || !item.k;
    if (r.k === "fof" && r.name) {
      if (!person) return trn("Followed by {n} people you follow", (r.n || 0) + 1);
      return r.n > 0 ? trn("Followed by {name} and {n} others", r.n, { name: r.name }) : tr("Followed by {name}", { name: r.name });
    }
    if (r.k === "fofn") return trn("Followed by {n} people you follow", r.n || 1);
    if (r.k === "fy") return tr("Follows you");
    if (r.k === "cm") return person && r.c ? tr("In community {name}", { name: r.c }) : tr("Popular in your communities");
    if (r.k === "new") return tr("New here and interacted with you");
    return "";
  }

  function face(group, item, size) {
    var square = group === "communities" || SQUARE[item.k];
    var cls = "pymk-ava" + (square ? " pymk-sq" : "") + (size ? " " + size : "");
    if (group === "communities") return '<span class="' + cls + ' pymk-cicon" aria-hidden="true">' + (host && host.icon ? host.icon("communities") : "") + "</span>";
    var img = host && host.avatar ? host.avatar(item.a || "", item.n || item.h, cls) : '<span class="' + cls + '"></span>';
    return img;
  }

  function href(group, item) {
    if (group === "communities") return "#/communities/" + encodeURIComponent(item.id);
    return "#/@" + encodeURIComponent(item.h || "");
  }

  function actionHtml(group, item, large) {
    if (group === "communities") return '<a class="follow pymk-view" href="' + esc(href(group, item)) + '">' + esc(tr("View")) + "</a>";
    if (host && host.follow) return host.follow(item.id, large);
    return '<button class="follow" type="button" data-act="follow" data-id="' + esc(item.id) + '">' + esc(tr("Follow")) + "</button>";
  }

  function nameHtml(group, item) {
    if (group === "communities") return esc(item.id);
    return esc(item.n || item.h) + (item.v && host && host.badge ? host.badge(item.v) : "");
  }

  function rowHtml(group, item) {
    var reason = reasonText(group, item);
    return '<div class="who-row pymk-row" data-pymk-row="' + esc(rowKey(group, item)) + '">' +
      '<a class="who-main" href="' + esc(href(group, item)) + '">' + face(group, item) +
      '<span class="who-copy"><span class="name">' + nameHtml(group, item) + "</span>" +
      (group === "communities" ? "" : '<span class="handle">@' + esc(item.h) + "</span>") +
      (reason ? '<span class="pymk-why">' + esc(reason) + "</span>" : "") + "</span></a>" +
      actionHtml(group, item) +
      '<button class="pymk-x" type="button" data-act="pymk-dismiss" data-group="' + esc(group) + '" data-key="' + esc(rowKey(group, item)) + '" aria-label="' + esc(tr("Not interested in this person")) + '" title="' + esc(tr("Not interested in this person")) + '">' + (host && host.icon ? host.icon("close") : "✕") + "</button>" +
      "</div>";
  }

  function tileHtml(group, item) {
    var reason = reasonText(group, item);
    return '<div class="pymk-tile" data-pymk-row="' + esc(rowKey(group, item)) + '">' +
      '<button class="pymk-x" type="button" data-act="pymk-dismiss" data-group="' + esc(group) + '" data-key="' + esc(rowKey(group, item)) + '" aria-label="' + esc(tr("Not interested in this person")) + '">' + (host && host.icon ? host.icon("close") : "✕") + "</button>" +
      '<a class="pymk-tile-main" href="' + esc(href(group, item)) + '">' + face(group, item, "lg") +
      '<span class="name">' + nameHtml(group, item) + "</span>" +
      (group === "communities" ? "" : '<span class="handle">@' + esc(item.h) + "</span>") +
      '<span class="pymk-why">' + esc(reason) + "</span></a>" + actionHtml(group, item) + "</div>";
  }

  function menuHtml(group, slot) {
    if (mem.menu !== group + ":" + slot) return "";
    return '<div class="pymk-menu" role="menu">' +
      '<button type="button" role="menuitem" data-act="pymk-fewer" data-group="' + esc(group) + '">' + esc(tr("Show fewer of these")) + "</button>" +
      '<button type="button" role="menuitem" data-act="pymk-off-type" data-group="' + esc(group) + '">' + esc(tr("Turn off {title}", { title: TITLES[group]() })) + "</button>" +
      '<button type="button" role="menuitem" data-act="pymk-off">' + esc(tr("Turn off")) + "</button>" +
      '<a role="menuitem" href="#/settings/suggestions">' + esc(tr("Suggestion settings")) + "</a></div>";
  }

  function carouselNow() {
    if (!prefs().carousel) return false;
    try { return !!(root.matchMedia && root.matchMedia("(max-width: 700px)").matches); } catch (err) { return false; }
  }

  function cardHtml(group, slot) {
    var rows = rowsFor(group);
    if (!rows.length) return "";
    var title = TITLES[group]();
    var head = '<div class="pymk-head"><h2>' + esc(title) + "</h2>" +
      '<button class="icon-btn pymk-more" type="button" data-act="pymk-menu" data-group="' + esc(group) + '" data-slot="' + slot + '" aria-haspopup="menu" aria-expanded="' + (mem.menu === group + ":" + slot ? "true" : "false") + '" aria-label="' + esc(tr("More")) + '">' + (host && host.icon ? host.icon("more") : "⋯") + "</button>" +
      menuHtml(group, slot) + "</div>";
    var body = carouselNow()
      ? '<div class="pymk-strip">' + rows.slice(0, 10).map(function (item) { return tileHtml(group, item); }).join("") + "</div>"
      : rows.slice(0, ROWS).map(function (item) { return rowHtml(group, item); }).join("");
    return '<section class="pymk' + (carouselNow() ? " pymk-carousel" : "") + '" data-pymk="' + esc(group) + '" aria-label="' + esc(title) + '">' + head + body +
      '<a class="show-more-row" href="#/connect?type=' + esc(group) + '">' + esc(tr("Show more")) + "</a></section>";
  }

  /* Insert cards into an array of post HTML strings. */
  function interleave(items, opts) {
    opts = opts || {};
    if (!Array.isArray(items)) return "";
    if (!enabled()) return items.join("");
    refresh(false);
    var groups = rotation(liveGroups(), rotCounter());
    if (!groups.length) return items.join("");
    var spots = plan(items.length, { seed: daySeed(), fewer: prefs().fewer, max: groups.length });
    if (!spots.length) return items.join("");
    var out = [];
    var k = 0;
    for (var i = 0; i < items.length; i++) {
      out.push(items[i]);
      if (k < spots.length && i + 1 === spots[k]) {
        out.push(cardHtml(groups[k % groups.length], k));
        k += 1;
      }
    }
    return out.join("");
  }

  /* ---------- Desktop right column: one "Who to follow" panel ---------- */

  /* Account groups from the Worker merged with outside sources the user can
     follow (host.feedPeople), one row per person: same id, same handle or
     same display name counts as the same person. Viktorych accounts first
     (they carry a real reason), then outside sources. */
  var SIDE_GROUPS = ["people", "creators", "accounts", "media", "companies", "organizations"];
  function normKey(text) { return String(text || "").trim().toLowerCase().replace(/^@/, "").replace(/\s+/g, " "); }
  function feedRows() {
    var list = host && host.feedPeople ? host.feedPeople() : [];
    if (!Array.isArray(list)) return [];
    return list.filter(function (f) { return f && f.id && !isHidden(String(f.id)); }).map(function (f) {
      return { id: String(f.id), h: f.handle || "", n: f.name || f.handle || "", a: f.avatar || "", v: f.verifiedType || "", b: f.bio || "", src: f.platform || "", href: f.href || "", card: f.id, feed: true, k: "person" };
    });
  }
  function mergedPeople(limit) {
    var seen = {};
    var out = [];
    function take(group, item) {
      var keys = ["i:" + normKey(item.id)];
      if (item.h) keys.push("h:" + normKey(item.h));
      if (normKey(item.n).length >= 3) keys.push("n:" + normKey(item.n));
      for (var i = 0; i < keys.length; i++) if (seen[keys[i]]) return;
      keys.forEach(function (k) { seen[k] = true; });
      out.push({ group: group, item: item });
    }
    if (me()) SIDE_GROUPS.forEach(function (g) { rowsFor(g).forEach(function (item) { take(g, item); }); });
    feedRows().forEach(function (item) { take("people", item); });
    return limit ? out.slice(0, limit) : out;
  }

  function reasonIcon(item) {
    var r = item.r || {};
    var name = item.feed ? "" : r.k === "cm" ? "communities" : r.k === "new" ? "spark" : "user";
    return name && host && host.icon ? '<span class="pymk-why-ico" aria-hidden="true">' + host.icon(name) + "</span>" : "";
  }

  function sideRowHtml(entry) {
    var group = entry.group;
    var item = entry.item;
    var reason = item.feed ? tr("Suggested for you") : reasonText(group, item);
    var link = item.feed ? (item.href || "#/feeds") : href(group, item);
    var src = item.feed && item.src && host && host.sourceBadge ? host.sourceBadge(item.src) : "";
    var key = item.feed ? item.id : rowKey(group, item);
    return '<div class="who-row pymk-row pymk-side-row" data-pymk-row="' + esc(key) + '">' +
      '<a class="who-main" href="' + esc(link) + '"' + (item.card ? ' data-card="' + esc(item.card) + '"' : "") + ">" + face(group, item) +
      '<span class="who-copy"><span class="name">' + nameHtml(group, item) + "</span>" +
      '<span class="handle">' + (item.h ? "@" + esc(item.h) : "") + (src ? " " + src : "") + "</span>" +
      (item.b ? '<span class="pymk-bio">' + esc(String(item.b).slice(0, 160)) + "</span>" : "") +
      (reason ? '<span class="pymk-why">' + reasonIcon(item) + "<span>" + esc(reason) + "</span></span>" : "") + "</span></a>" +
      '<span class="pymk-side-act">' + actionHtml(group, item) +
      '<button class="pymk-x" type="button" data-act="pymk-dismiss" data-group="' + esc(group) + '"' + (item.feed ? ' data-src="feed"' : "") + ' data-key="' + esc(key) + '" aria-label="' + esc(tr("Not interested in this person")) + '" title="' + esc(tr("Not interested in this person")) + '">' + (host && host.icon ? host.icon("close") : "✕") + "</button></span>" +
      "</div>";
  }

  /* The permanent panel in the desktop right column (styles: .pymk-side). */
  function sideHtml(opts) {
    opts = opts || {};
    refresh(false);
    var rows = mergedPeople(opts.rows || 5);
    var body = rows.length ? rows.map(sideRowHtml).join("")
      : '<p class="pymk-side-empty">' + esc(tr("No suggestions right now")) + "</p>";
    return '<section class="card pymk-side" data-pymk-side aria-label="' + esc(tr("Who to follow")) + '"><h2>' + esc(tr("Who to follow")) + "</h2>" + body +
      '<a class="show-more-row" href="#/connect">' + esc(tr("Show more")) + "</a></section>";
  }

  /* ---------- Full page (#/connect) ---------- */

  function pageHtml(route) {
    var query = (route && route.query) || {};
    var want = typeof query.get === "function" ? query.get("type") : query.type;
    if (!me()) return '<div class="empty"><h2>' + esc(tr("Sign in to see people you may know")) + "</h2></div>";
    refresh(false);
    var outside = feedRows().length > 0;
    var groups = GROUPS.filter(function (g) { return rowsFor(g).length > 0 || (g === "people" && outside); });
    var group = groups.indexOf(want) >= 0 ? want : (groups[0] || "people");
    var tabs = groups.length > 1 ? '<div class="pymk-tabs" role="tablist">' + groups.map(function (g) {
      return '<a role="tab" class="pymk-tab' + (g === group ? " on" : "") + '" aria-selected="' + (g === group ? "true" : "false") + '" href="#/connect?type=' + esc(g) + '">' + esc(TITLES[g]()) + "</a>";
    }).join("") + "</div>" : "";
    var rows = rowsFor(group);
    var list = group === "people" && outside ? mergedPeople(0).filter(function (e) { return e.group === "people"; }).map(sideRowHtml).join("")
      : rows.length ? rows.map(function (item) { return rowHtml(group, item); }).join("")
      : '<div class="empty"><h2>' + esc(tr("No suggestions right now")) + "</h2><p>" + esc(tr("Follow a few people or join a community and suggestions show up here.")) + "</p></div>";
    return tabs + '<div class="pymk-page">' + list + "</div>";
  }
  function pageTitle(route) {
    var query = (route && route.query) || {};
    var want = typeof query.get === "function" ? query.get("type") : query.type;
    return TITLES[GROUPS.indexOf(want) >= 0 ? want : "people"]();
  }

  /* ---------- Settings ---------- */

  function switchHtml(act, on, label, desc, extra) {
    return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-act="' + act + '"' + (extra || "") + "><span>" + esc(label) + "</span><i></i></button>" +
      (desc ? '<p class="phandle set-desc">' + esc(desc) + "</p>" : "");
  }

  function loadServerPrefs() {
    var a = api();
    if (mem.serverPrefs || mem.prefsLoading || !a || !a.call || !token()) return;
    mem.prefsLoading = true;
    a.call("/v1/suggestions/prefs", { token: token() }).then(function (res) {
      mem.prefsLoading = false;
      if (res && res.status === 200) { mem.serverPrefs = { discoverable: res.discoverable !== false, searchable: res.searchable !== false, tempOptIn: !!res.tempOptIn, kind: res.kind || "person", ownerKind: res.ownerKind || "" }; redraw(); }
    }).catch(function () { mem.prefsLoading = false; });
  }

  function putServerPrefs(patch) {
    var a = api();
    if (!a || !a.call || !token()) return;
    var prev = mem.serverPrefs;
    mem.serverPrefs = Object.assign({}, prev || { discoverable: true, tempOptIn: false, kind: "person" }, patch);
    redraw();
    a.call("/v1/suggestions/prefs", { method: "PUT", token: token(), body: patch }).then(function (res) {
      if (!res || res.status !== 200) {
        mem.serverPrefs = prev;
        if (a.toast) a.toast(tr("Couldn’t save. Try again."));
        redraw();
      }
    }).catch(function () { mem.serverPrefs = prev; redraw(); });
  }

  /* The switches for "#/settings/suggestions" (feed display) — also used by
     Personalizar when it lands. */
  function feedSettingsHtml() {
    var p = prefs();
    var html = "<h2>" + esc(tr("Suggestions in your feed")) + "</h2>" +
      switchHtml("pymk-toggle", p.on, tr("Show People you may know"), tr("Suggested accounts and communities appear now and then between posts on Home."));
    if (p.on) {
      html += '<div class="pymk-types">' + GROUPS.map(function (g) {
        return switchHtml("pymk-toggle-type", p.types[g] !== false, TITLES[g](), "", ' data-group="' + g + '"');
      }).join("") + "</div>";
      html += switchHtml("pymk-toggle-carousel", p.carousel, tr("Swipeable cards on phones"), tr("Show suggestions as a row of cards you swipe sideways."));
      if (p.fewer > 0 || p.hidden.length) html += '<button class="outline" type="button" data-act="pymk-reset">' + esc(tr("Reset hidden suggestions")) + "</button>";
    }
    return html;
  }

  function kindSelect(name, value, extraOption) {
    return '<select class="pymk-kind" data-pymk-kind="' + name + '" aria-label="' + esc(tr("Account type")) + '">' +
      (extraOption ? '<option value="">' + esc(extraOption) + "</option>" : "") +
      KINDS.map(function (k) { return '<option value="' + k + '"' + (k === value ? " selected" : "") + ">" + esc(KIND_LABELS[k]()) + "</option>"; }).join("") + "</select>";
  }

  function accountTypeHtml() {
    if (!me()) return "";
    loadServerPrefs();
    var sp = mem.serverPrefs;
    var html = "<h2>" + esc(tr("Account type")) + "</h2>" +
      '<p class="phandle">' + esc(tr("Tell others what kind of account this is. It decides which suggestion card you appear in.")) + "</p>" +
      kindSelect("self", sp ? sp.kind : "person");
    if (sp && sp.ownerKind) html += '<p class="phandle set-desc">' + esc(tr("The owner set this account as: {kind}", { kind: KIND_LABELS[sp.ownerKind] ? KIND_LABELS[sp.ownerKind]() : sp.ownerKind })) + "</p>";
    var who = me();
    if (who && who.owner) {
      html += "<h2>" + esc(tr("Set another account's type")) + "</h2>" +
        '<form class="mute-form pymk-owner-form" data-pymk-owner="1"><label class="search"><input id="pymk-owner-handle" placeholder="' + esc(tr("@handle")) + '" aria-label="' + esc(tr("@handle")) + '" maxlength="80"></label>' +
        kindSelect("owner", "", tr("Their own choice")) + '<button class="follow" type="submit">' + esc(tr("Save")) + "</button></form>";
    }
    return html;
  }

  function settingsPageHtml() {
    return '<div class="set-block">' + feedSettingsHtml() + accountTypeHtml() + "</div>";
  }

  /* Privacy: "Let others see me in People you may know". */
  function privacyHtml() {
    if (!me()) return "";
    loadServerPrefs();
    var sp = mem.serverPrefs || { discoverable: true, tempOptIn: false };
    var who = me();
    var html = "<h2>" + esc(tr("Discoverability")) + "</h2>" +
      switchHtml("pymk-discoverable", sp.discoverable !== false, tr("Let others see me in People you may know"), tr("When this is off, your account is never suggested to anyone. Suggestions never show who you follow if your follows are private.")) +
      switchHtml("pymk-searchable", sp.searchable !== false, tr("Let others find me in search"), tr("When this is off, people can't find your account in Search, even by its exact username. They can still open your profile from a link."));
    if (who && who.temporary) html += switchHtml("pymk-temp-opt", !!sp.tempOptIn, tr("Suggest my temporary account too"), tr("Temporary accounts are left out of suggestions unless you turn this on."));
    return html;
  }

  /* ---------- Actions (from app.js's click handler) ---------- */

  function act(name, el) {
    var p = prefs();
    var group = el && el.dataset ? el.dataset.group || "" : "";
    if (name === "pymk-menu") {
      var key = group + ":" + (el.dataset.slot || "0");
      mem.menu = mem.menu === key ? "" : key;
      redraw();
      return true;
    }
    mem.menu = "";
    if (name === "pymk-dismiss") {
      var rowKeyText = el.dataset.key || "";
      if (!rowKeyText) return true;
      if (p.hidden.indexOf(rowKeyText) < 0) p.hidden.push(rowKeyText);
      if (el.dataset.src !== "feed") p.pending.push(rowKeyText.indexOf("c:") === 0 ? { community: rowKeyText.slice(2) } : { id: rowKeyText });
      savePrefs();
      flushPending();
      redraw();
      var a = api();
      if (a && a.toast) a.toast(tr("Thanks. You'll see fewer suggestions like this."));
      return true;
    }
    if (name === "pymk-fewer") { p.fewer = Math.min(4, p.fewer + 1); savePrefs(); redraw(); return true; }
    if (name === "pymk-off-type" || name === "pymk-toggle-type") {
      if (GROUPS.indexOf(group) < 0) return true;
      p.types[group] = name === "pymk-off-type" ? false : p.types[group] === false;
      savePrefs(); redraw(); return true;
    }
    if (name === "pymk-off" || name === "pymk-toggle") {
      p.on = name === "pymk-off" ? false : !p.on;
      savePrefs();
      var acc = api();
      if (name === "pymk-off" && acc && acc.toast) acc.toast(tr("Suggestions are off. Turn them back on in Settings."));
      redraw();
      return true;
    }
    if (name === "pymk-toggle-carousel") { p.carousel = !p.carousel; savePrefs(); redraw(); return true; }
    if (name === "pymk-reset") { p.fewer = 0; p.hidden = []; savePrefs(); refresh(true); redraw(); return true; }
    if (name === "pymk-searchable") { putServerPrefs({ searchable: !(mem.serverPrefs ? mem.serverPrefs.searchable !== false : true) }); return true; }
    if (name === "pymk-discoverable") { putServerPrefs({ discoverable: !(mem.serverPrefs ? mem.serverPrefs.discoverable !== false : true) }); return true; }
    if (name === "pymk-temp-opt") { putServerPrefs({ tempOptIn: !(mem.serverPrefs && mem.serverPrefs.tempOptIn) }); return true; }
    return false;
  }

  /* Rows followed from a card keep showing "Following" until the next visit. */
  function noteFollowClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-act="follow"]') : null;
    if (!t || !t.closest || !t.closest(".pymk, .pymk-page, .pymk-side")) return;
    var id = t.dataset.id || "";
    if (id) mem.followedNow[id] = true;
  }

  function onChange(ev) {
    var t = ev.target;
    if (!t || !t.dataset || !t.dataset.pymkKind) return;
    if (t.dataset.pymkKind === "self") putServerPrefs({ kind: t.value });
  }

  function onSubmit(ev) {
    var form = ev.target;
    if (!form || !form.dataset || !form.dataset.pymkOwner) return;
    ev.preventDefault();
    var input = form.querySelector("#pymk-owner-handle");
    var select = form.querySelector("select");
    var handle = String(input && input.value || "").trim().replace(/^@/, "");
    var a = api();
    if (!handle || !a || !a.call) return;
    a.call("/v1/owner/account-kind", { method: "PUT", token: token(), body: { id: "app:@" + handle, kind: select ? select.value : "" } }).then(function (res) {
      if (a.toast) a.toast(res && res.status === 200 ? tr("Saved") : tr("Couldn’t save. Try again."));
      if (res && res.status === 200 && input) input.value = "";
    });
  }

  if (root.document && root.document.addEventListener) {
    root.document.addEventListener("click", noteFollowClick, true);
    root.document.addEventListener("change", onChange, true);
    root.document.addEventListener("submit", onSubmit, true);
    root.addEventListener("online", function () { flushPending(); refresh(false); });
    root.document.addEventListener("click", function (ev) {
      if (!mem.menu) return;
      var t = ev.target;
      if (t && t.closest && (t.closest(".pymk-menu") || t.closest('[data-act="pymk-menu"]'))) return;
      mem.menu = "";
      redraw();
    });
  }

  function registerKeys() {
    var keys = root.ViktorychKeys;
    if (!keys || !keys.register) return;
    keys.register({ id: "go.suggestions", keys: ["g y"], label: tr("Go to People you may know"), group: "nav", scope: "global", run: function () { root.location.hash = "#/connect"; } });
  }
  registerKeys();
  if (root.addEventListener) root.addEventListener("DOMContentLoaded", registerKeys);

  var api_ = {
    GROUPS: GROUPS,
    TITLES: TITLES,
    KINDS: KINDS,
    setHost: function (h) { host = h || null; },
    plan: plan,
    rotation: rotation,
    interleave: interleave,
    cardHtml: cardHtml,
    sideHtml: sideHtml,
    mergedPeople: mergedPeople,
    pageHtml: pageHtml,
    pageTitle: pageTitle,
    settingsPageHtml: settingsPageHtml,
    feedSettingsHtml: feedSettingsHtml,
    accountTypeHtml: accountTypeHtml,
    privacyHtml: privacyHtml,
    act: act,
    discoverable: function () { return mem.serverPrefs ? mem.serverPrefs.discoverable !== false : true; },
    searchable: function () { return mem.serverPrefs ? mem.serverPrefs.searchable !== false : true; },
    /* First-time setup sets the switch directly; resolves true once saved. */
    setDiscoverable: function (on) {
      var a = api();
      if (!a || !a.call || !token()) return Promise.resolve(false);
      var prev = mem.serverPrefs;
      mem.serverPrefs = Object.assign({}, prev || { discoverable: true, tempOptIn: false, kind: "person" }, { discoverable: !!on });
      return a.call("/v1/suggestions/prefs", { method: "PUT", token: token(), body: { discoverable: !!on } }).then(function (res) {
        if (res && res.status === 200) return true;
        mem.serverPrefs = prev;
        return false;
      }, function () { mem.serverPrefs = prev; return false; });
    },
    refresh: refresh,
    prefs: prefs,
    _reset: function () { mem = { prefs: null, cache: null, loading: false, lastTry: 0, menu: "", followedNow: {}, rot: -1, serverPrefs: null, prefsLoading: false }; }
  };
  root.ViktorychPYMK = api_;
  if (typeof module !== "undefined" && module.exports) module.exports = api_;
})(typeof window !== "undefined" ? window : globalThis);
