/* Keyboard shortcuts, part two: the default commands, the command palette
   (Ctrl/Cmd+K or Alt+Space), the cheat sheet (?) and the
   Settings > Keyboard shortcuts page. The registry itself is keys.js. */
(function (root) {
  "use strict";
  var K = root.ViktorychKeys;
  if (!K) return;
  var doc = root.document;
  var tr = K.tr;
  var esc = K.esc;

  function host() { return root.ViktorychKeysHost || {}; }
  function call(name) {
    var h = host();
    var args = Array.prototype.slice.call(arguments, 1);
    return typeof h[name] === "function" ? h[name].apply(h, args) : false;
  }
  function go(hash) {
    if (!hash) return false;
    if (call("go", hash)) return true;
    root.location.hash = hash;
    return true;
  }
  function shown(el) { return !!(el && el.getClientRects && el.getClientRects().length && !el.closest("[hidden]")); }
  function click(el) { if (!el) return false; el.click(); return true; }
  function postId(ctx) { var p = K.currentPost(); return p ? p.getAttribute("data-post") || "" : ""; }
  function inPost(sel) { var p = K.currentPost(); return p ? p.querySelector(sel) : null; }
  function toast(text) { if (!call("toast", text)) { /* the app shows nothing */ } return true; }
  function wait(test, ms, done) {
    var start = Date.now();
    (function poll() {
      var hit = test();
      if (hit) { done(hit); return; }
      if (Date.now() - start < ms) setTimeout(poll, 60);
    })();
  }

  /* ---------- Default commands ---------- */

  var NAV = [
    ["nav.home", "g h", "Home", "#/"],
    ["nav.explore", "g e", "Explore", "#/explore"],
    ["nav.notifications", "g n", "Notifications", "#/notifications"],
    ["nav.messages", "g m", "Messages", "#/messages"],
    ["nav.profile", "g p", "Profile", function () { return call("profileHash") || "#/settings"; }],
    ["nav.communities", "g c", "Communities", "#/communities"],
    ["nav.likes", "g l", "Likes", "#/history/likes"],
    ["nav.bookmarks", "g b", "Bookmarks", "#/bookmarks"],
    ["nav.settings", "g s", "Settings", "#/settings"],
    ["nav.lists", "g i", "Lists", "#/lists"],
    ["nav.tv", "g t", "TV", "#/tv"],
    ["nav.feeds", "g f", "Feeds", "#/feeds"],
    ["nav.display", "g d", "Display", "#/settings/display"],
    ["nav.keyboard", "g k", "Keyboard shortcuts", "#/settings/keyboard"]
  ];
  NAV.forEach(function (row) {
    K.register({
      id: row[0], keys: [row[1]], label: row[2], scope: "global", group: "nav",
      run: function () { return go(typeof row[3] === "function" ? row[3]() : row[3]); }
    });
  });

  function sidebarLinks() {
    var side = Array.prototype.filter.call(doc.querySelectorAll("header.nav a.nav-item[href]"), shown);
    if (side.length) return side;
    return Array.prototype.filter.call(doc.querySelectorAll("nav.bottom-nav a[href]"), shown);
  }
  function homeTabs() {
    return Array.prototype.filter.call(doc.querySelectorAll('[data-hscroll="home-tabs"] [data-act="htab"][data-tab]'), shown);
  }
  for (var n = 1; n <= 9; n++) {
    (function (i) {
      K.register({
        id: "nav.item" + i, keys: [String(i)], label: "Sidebar item {n}", vars: { n: i }, scope: "global", group: "nav", palette: false,
        run: function () { var link = sidebarLinks()[i - 1]; return link ? go(link.getAttribute("href")) : false; }
      });
      K.register({
        id: "feed.tab" + i, keys: ["alt+" + i], label: "Home tab {n}", vars: { n: i }, scope: "global", group: "nav", palette: false,
        run: function () {
          var tab = homeTabs()[i - 1];
          if (tab) return click(tab);
          if (call("state").route === "home") return false;
          go("#/");
          wait(function () { return homeTabs()[i - 1]; }, 3000, click);
          return true;
        }
      });
    })(n);
  }

  K.register({ id: "app.palette", keys: ["mod+k", "alt+space"], label: "Command palette", scope: "global", input: true, overModal: true, palette: false,
    run: function () { if (palette.open()) { palette.close(); return true; } palette.show(""); return true; } });
  K.register({ id: "app.help", keys: ["?"], label: "Show keyboard shortcuts", scope: "global", overModal: true,
    keywords: "help cheat sheet keys",
    run: function () { if (sheet.open()) { sheet.close(); return true; } sheet.show(); return true; } });
  K.register({ id: "app.search", keys: ["/"], label: "Focus search", scope: "global", run: function () { return call("focusSearch"); } });
  K.register({ id: "app.goAccount", keys: ["g u"], label: "Go to account…", scope: "global", group: "nav", run: function () { palette.show("@"); return true; } });
  K.register({ id: "app.back", keys: ["alt+left", "backspace"], label: "Back", scope: "global", run: function () { root.history.back(); return true; } });
  K.register({ id: "app.forward", keys: ["alt+right"], label: "Forward", scope: "global", run: function () { root.history.forward(); return true; } });
  if (K.isMac()) {
    K.register({ id: "app.backMac", keys: ["mod+["], label: "Back", scope: "global", palette: false, run: function () { root.history.back(); return true; } });
    K.register({ id: "app.forwardMac", keys: ["mod+]"], label: "Forward", scope: "global", palette: false, run: function () { root.history.forward(); return true; } });
  }
  K.register({ id: "app.compose", keys: ["n"], label: "New post", scope: "global", run: function () { return call("act", "compose"); } });
  K.register({ id: "app.theme", keys: ["alt+t"], label: "Next theme", scope: "global", keywords: "dark light dim colors",
    run: function () {
      var list = call("themes") || [];
      if (!list.length) return false;
      var next = list[(list.indexOf(call("theme")) + 1) % list.length];
      call("act", "theme", { theme: next });
      toast(call("themeLabel", next) || next);
      return true;
    } });
  K.register({ id: "app.account", keys: ["g a"], label: "Switch account", scope: "global", group: "nav", run: function () { return call("act", "account-menu"); } });
  K.register({ id: "app.refresh", keys: ["alt+r"], label: "Refresh", scope: "global", run: function () { return call("act", "reload"); } });
  K.register({ id: "app.update", keys: ["alt+u"], label: "Check for updates", scope: "global",
    run: function () {
      var up = root.ViktorychUpdate;
      if (!up || typeof up.poke !== "function") return false;
      up.poke();
      toast(tr("Checking for updates…"));
      return true;
    } });
  K.register({ id: "app.chat", keys: ["alt+shift+c"], label: "Open or close Chat", scope: "global", overModal: true,
    run: function () { return !!(root.ViktorychDock && root.ViktorychDock.toggle && root.ViktorychDock.toggle("chat")); } });
  K.register({ id: "app.ai", keys: ["alt+shift+a"], label: "Open or close the assistant", scope: "global", overModal: true,
    run: function () { return !!(root.ViktorychDock && root.ViktorychDock.toggle && root.ViktorychDock.toggle("ai")); } });
  K.register({ id: "app.menu", keys: ["contextmenu", "shift+f10"], label: "Open menu", scope: "global",
    run: function (ctx) {
      var a = ctx && ctx.active;
      var id = a ? K.menus.idFor(a) : "";
      // Sidebar tabs own Shift+F10 and the Menu key (openNavMenu): leave the key alone.
      if (id && navMenuIds().indexOf(id) >= 0 && !K.menus.has(id)) return false;
      if (id && K.menus.has(id)) return K.menus.open(id, a);
      return click(inPost('[data-act="menu"]'));
    } });

  /* Messages */
  function chatLinks() {
    var seen = {};
    return Array.prototype.filter.call(doc.querySelectorAll('a[href^="#/messages/discord/"], a[href^="#/messages/s/"]'), function (a) {
      var h = a.getAttribute("href");
      if (seen[h] || !shown(a)) return false;
      seen[h] = true;
      return true;
    });
  }
  function stepChat(d) {
    var links = chatLinks();
    if (!links.length) return false;
    var at = -1;
    links.forEach(function (a, i) { if (a.getAttribute("href") === root.location.hash) at = i; });
    var next = links[at < 0 ? (d > 0 ? 0 : links.length - 1) : (at + d + links.length) % links.length];
    return go(next.getAttribute("href"));
  }
  K.register({ id: "dm.new", keys: ["mod+shift+m", "alt+shift+n"], label: "New message", scope: "global", input: true,
    run: function () {
      go("#/messages");
      wait(function () {
        var b = doc.querySelector('[data-act="dm-new"], [data-act="new-message"], [data-act="messages-new"]');
        return shown(b) ? b : null;
      }, 2000, click);
      return true;
    } });
  K.register({ id: "dm.prev", keys: ["alt+up"], label: "Previous chat", scope: "dm", input: true, run: function () { return stepChat(-1); } });
  K.register({ id: "dm.next", keys: ["alt+down"], label: "Next chat", scope: "dm", input: true, run: function () { return stepChat(1); } });

  /* Timeline */
  function scrollPage(d) {
    var off = K.headerOffset() || 0;
    var by = Math.max(120, (root.innerHeight || 600) - off - 48) * d;
    root.scrollBy({ top: by, behavior: reduced() ? "auto" : "smooth" });
    return true;
  }
  function reduced() { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  K.register({ id: "timeline.next", keys: ["j"], label: "Next post", scope: "timeline", repeat: true, run: function () { return K.movePost(1); } });
  K.register({ id: "timeline.prev", keys: ["k"], label: "Previous post", scope: "timeline", repeat: true, run: function () { return K.movePost(-1); } });
  K.register({ id: "timeline.new", keys: ["."], label: "Show new posts", scope: "timeline",
    run: function () {
      var pill = doc.getElementById("new-posts");
      var row = doc.querySelector('[data-act="show-new-posts"]');
      if (shown(row)) row.click();
      else if (shown(pill)) pill.click();
      else root.scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
      setTimeout(function () { var first = K.posts()[0]; if (first) K.focusPost(first); }, 250);
      return true;
    } });
  K.register({ id: "timeline.pageDown", keys: ["space"], label: "Page down", scope: "timeline", repeat: true, run: function () { return scrollPage(1); } });
  K.register({ id: "timeline.pageUp", keys: ["shift+space"], label: "Page up", scope: "timeline", repeat: true, run: function () { return scrollPage(-1); } });
  K.register({ id: "timeline.top", keys: ["home"], label: "Go to top", scope: "timeline",
    run: function () { root.scrollTo({ top: 0 }); var first = K.posts()[0]; if (first) K.focusPost(first, { noScroll: true }); return true; } });
  K.register({ id: "timeline.bottom", keys: ["end"], label: "Go to bottom", scope: "timeline",
    run: function () { var el = doc.scrollingElement || doc.documentElement; root.scrollTo({ top: el.scrollHeight }); return true; } });

  /* Selected post */
  K.register({ id: "post.open", keys: ["enter"], label: "Open post", scope: "post",
    run: function () {
      var p = K.currentPost();
      if (!p) return false;
      var open = p.getAttribute("data-open");
      if (open) return go(open);
      var link = p.querySelector('a.time[href], time a[href], a[href*="/status/"]');
      return link ? go(link.getAttribute("href")) : false;
    } });
  K.register({ id: "post.media", keys: ["o"], label: "Open media", scope: "post",
    run: function () {
      var photo = inPost('[data-act="view"]');
      if (photo) return click(photo);
      var tile = inPost(".vplay");
      if (!tile) return false;
      if (!tile.hasAttribute("tabindex")) tile.setAttribute("tabindex", "-1");
      tile.focus({ preventScroll: true });
      return click(tile.querySelector('button.play[data-act="play"]') || tile);
    } });
  K.register({ id: "post.like", keys: ["l"], label: "Like", scope: "post", run: function () { return click(inPost('.actions [data-act="like"]')); } });
  K.register({ id: "post.reply", keys: ["r"], label: "Reply", scope: "post",
    run: function () { return click(inPost('.actions [data-act="xc-reply"], .actions [data-act="public-reply"], .actions .reply')); } });
  K.register({ id: "post.repost", keys: ["t"], label: "Repost", scope: "post", run: function () { return click(inPost('.actions [data-act="repost"]')); } });
  K.register({ id: "post.quote", keys: ["q"], label: "Quote", scope: "post",
    run: function () { var id = postId(); return id ? call("act", "quote-open", { id: id }) : false; } });
  K.register({ id: "post.bookmark", keys: ["b"], label: "Bookmark", scope: "post", run: function () { return click(inPost('.actions [data-act="bookmark"]')); } });
  K.register({ id: "post.share", keys: ["s"], label: "Share", scope: "post", run: function () { return click(inPost('.actions [data-act="share"]')); } });
  K.register({ id: "post.react", keys: ["e"], label: "React", scope: "post", keywords: "emoji reaction",
    run: function () {
      var btn = inPost('.actions [data-act="like"]');
      var rx = root.ViktorychReactions;
      return !!(btn && rx && rx.openBar && rx.openBar(btn));
    } });
  K.register({ id: "post.mute", keys: ["u"], label: "Mute author", scope: "post", run: function () { var id = postId(); return id ? call("muteAuthor", id) : false; } });
  K.register({ id: "post.hide", keys: ["x"], label: "Hide post", scope: "post",
    run: function () {
      var id = postId();
      if (!id) return false;
      K.movePost(1);
      return call("act", "foryou-hide", { id: id });
    } });

  /* Composer */
  function composerTools(ctx) {
    var el = ctx && ctx.active;
    while (el && el !== doc.body) {
      if (el.querySelector && el.querySelector(".xc-tools")) return el.querySelector(".xc-tools");
      el = el.parentElement;
    }
    return doc.querySelector(".modal .xc-tools") || null;
  }
  function tool(ctx, sel) { var box = composerTools(ctx); return click(box ? box.querySelector(sel) : null); }
  K.register({ id: "composer.post", keys: ["mod+enter"], label: "Send post", scope: "composer", input: true,
    run: function (ctx) {
      var xc = root.ViktorychXCompose;
      if (!xc || !xc.publishFrom) return false;
      var a = ctx && ctx.active;
      var text = a && a.closest ? (a.closest('[data-xc="text"]') || a) : a;
      return !!xc.publishFrom(text);
    } });
  K.register({ id: "composer.close", keys: ["escape"], label: "Close composer", scope: "composer", input: true, palette: false,
    run: function () {
      var xc = root.ViktorychXCompose;
      if (xc && xc.onEscape && xc.onEscape()) return true;
      return call("escape");
    } });
  K.register({ id: "composer.emoji", keys: ["mod+shift+e", "alt+shift+e"], label: "Emoji", scope: "composer", input: true, run: function (ctx) { return tool(ctx, '[data-act="xc-emoji"]'); } });
  K.register({ id: "composer.poll", keys: ["mod+shift+p", "alt+shift+p"], label: "Add a poll", scope: "composer", input: true, run: function (ctx) { return tool(ctx, '[data-act="xc-poll"]'); } });
  K.register({ id: "composer.media", keys: ["alt+shift+i"], label: "Add photos or video", scope: "composer", input: true, run: function (ctx) { return tool(ctx, '[data-act="xc-file"][data-kind="image"], [data-act="xc-file"]'); } });
  K.register({ id: "composer.gif", keys: ["alt+shift+g"], label: "GIF", scope: "composer", input: true, run: function (ctx) { return tool(ctx, '[data-act="xc-gif"]'); } });

  /* Media */
  function mediaTile(ctx) {
    var a = ctx && ctx.active;
    var tile = a && a.closest ? a.closest(".vplay") : null;
    if (tile) return tile;
    var p = K.currentPost();
    return p ? p.querySelector(".vplay") : null;
  }
  function mediaVideo(ctx) {
    var fs = doc.fullscreenElement;
    if (fs) return fs.tagName === "VIDEO" ? fs : fs.querySelector("video");
    var viewer = doc.querySelector("#viewer video, .viewer video");
    if (viewer && shown(viewer)) return viewer;
    var a = ctx && ctx.active;
    if (a && a.tagName === "VIDEO") return a;
    var tile = mediaTile(ctx);
    return tile ? tile.querySelector("video") : null;
  }
  var RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  function setRate(ctx, d) {
    var v = mediaVideo(ctx);
    if (!v) return false;
    var at = RATES.indexOf(v.playbackRate);
    if (at < 0) at = 3;
    v.playbackRate = RATES[Math.max(0, Math.min(RATES.length - 1, at + d))];
    toast(tr("Speed {n}×", { n: v.playbackRate }));
    return true;
  }
  function seekOrStep(ctx, d) {
    var v = mediaVideo(ctx);
    if (v && isFinite(v.duration)) { v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + d * 5)); return true; }
    return call("viewerStep", d);
  }
  K.register({ id: "media.play", keys: ["k", "space"], label: "Play or pause", scope: "media",
    run: function (ctx) {
      var v = mediaVideo(ctx);
      if (v) { if (v.paused) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); } else v.pause(); return true; }
      var tile = mediaTile(ctx);
      return click(tile ? tile.querySelector('button.play[data-act="play"]') : null);
    } });
  K.register({ id: "media.mute", keys: ["m"], label: "Mute or unmute", scope: "media",
    run: function (ctx) {
      var tile = mediaTile(ctx);
      var btn = tile ? tile.querySelector(".vmute") : null;
      if (btn && !btn.hidden) return click(btn);
      var v = mediaVideo(ctx);
      if (!v) return false;
      v.muted = !v.muted;
      return true;
    } });
  K.register({ id: "media.fullscreen", keys: ["f"], label: "Full screen", scope: "media",
    run: function (ctx) {
      if (doc.fullscreenElement && doc.exitFullscreen) { doc.exitFullscreen(); return true; }
      var tile = mediaTile(ctx);
      var btn = tile ? tile.querySelector(".vexpand") : null;
      if (btn) return click(btn);
      var v = mediaVideo(ctx);
      if (v && v.requestFullscreen) { v.requestFullscreen(); return true; }
      return false;
    } });
  K.register({ id: "media.back", keys: ["left"], label: "Seek back or previous photo", scope: "media", repeat: true, run: function (ctx) { return seekOrStep(ctx, -1); } });
  K.register({ id: "media.forward", keys: ["right"], label: "Seek forward or next photo", scope: "media", repeat: true, run: function (ctx) { return seekOrStep(ctx, 1); } });
  K.register({ id: "media.slower", keys: ["<"], label: "Slower", scope: "media", run: function (ctx) { return setRate(ctx, -1); } });
  K.register({ id: "media.faster", keys: [">"], label: "Faster", scope: "media", run: function (ctx) { return setRate(ctx, 1); } });

  /* Dialogs */
  K.register({ id: "modal.close", keys: ["escape"], label: "Close", scope: "modal", input: true, palette: false,
    run: function () {
      if (palette.open()) { palette.close(); return true; }
      if (sheet.open()) { sheet.close(); return true; }
      return call("escape");
    } });
  K.register({ id: "modal.tab", keys: ["tab"], label: "Next field", scope: "modal", input: true, palette: false, repeat: true,
    run: function () { return trapOverlay(false) || call("trapTab", false); } });
  K.register({ id: "modal.shiftTab", keys: ["shift+tab"], label: "Previous field", scope: "modal", input: true, palette: false, repeat: true,
    run: function () { return trapOverlay(true) || call("trapTab", true); } });

  /* ---------- Overlays ---------- */

  var lastFocus = null;
  function overlayEl(id) {
    var el = doc.getElementById(id);
    if (el) return el;
    el = doc.createElement("div");
    el.id = id;
    el.className = "kb-overlay";
    el.hidden = true;
    doc.body.appendChild(el);
    el.addEventListener("mousedown", function (event) { if (event.target === el) { event.preventDefault(); closeAll(); } });
    return el;
  }
  function closeAll() { palette.close(); sheet.close(); }
  function trapOverlay(back) {
    var box = doc.querySelector(".kb-overlay:not([hidden])");
    if (!box) return false;
    var items = Array.prototype.filter.call(box.querySelectorAll("input, button, a[href], [tabindex='0']"), function (el) { return !el.disabled && shown(el); });
    if (!items.length) return true;
    var at = items.indexOf(doc.activeElement);
    var next = items[(at + (back ? -1 : 1) + items.length) % items.length];
    if (at < 0) next = items[0];
    next.focus();
    return true;
  }
  function remember() { lastFocus = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null; }
  function restore() {
    var el = lastFocus;
    lastFocus = null;
    var a = doc.activeElement;
    if (a && a.closest && a.closest(".kb-overlay") && a.blur) a.blur();
    if (el && el.isConnected && el.focus) { try { el.focus({ preventScroll: true }); } catch (err) { /* focus stays */ } }
  }
  function kbd(seq) {
    return K.formatBinding(seq).split(" ").map(function (part) { return "<kbd>" + esc(part) + "</kbd>"; }).join(" ");
  }
  function firstBinding(id) { var list = K.bindingsOf(id); return list.length ? list[0] : null; }

  /* Fuzzy match: substring wins, else letters in order. -1 means no match. */
  function fuzzy(query, text) {
    var q = String(query || "").toLowerCase().trim();
    var t = String(text || "").toLowerCase();
    if (!q) return 1;
    var at = t.indexOf(q);
    if (at === 0) return 1000 - t.length;
    if (at > 0) return (/[\s@#/._-]/.test(t.charAt(at - 1)) ? 800 : 600) - at - t.length / 10;
    var score = 400;
    var pos = 0;
    var last = -1;
    for (var i = 0; i < q.length; i++) {
      var c = q.charAt(i);
      if (c === " ") continue;
      var found = t.indexOf(c, pos);
      if (found < 0) return -1;
      if (last >= 0) score -= Math.min(10, found - last - 1);
      last = found;
      pos = found + 1;
    }
    return score - t.length / 10;
  }

  var cache = { communities: [], chats: [], accounts: [], at: 0 };
  function refreshCache() {
    try { cache.accounts = call("accounts") || []; } catch (err) { cache.accounts = []; }
    var local = root.ViktorychLocal;
    if (!local || typeof local.readDoc !== "function") return;
    try {
      Promise.resolve(local.readDoc("feeds", "communities")).then(function (doc2) {
        var list = doc2 && Array.isArray(doc2.communities) ? doc2.communities : [];
        cache.communities = list.slice(0, 500).map(function (c) { return { name: String(c.name || ""), title: String(c.title || c.name || "") }; }).filter(function (c) { return c.name; });
        if (palette.open()) palette.render();
      }).catch(function () {});
      Promise.resolve(local.readDoc("messages", "channels")).then(function (doc2) {
        var list = doc2 && Array.isArray(doc2.channels) ? doc2.channels : [];
        cache.chats = list.slice(0, 300).map(function (c) { return { id: String(c.id || ""), name: String(c.name || c.id || "") }; }).filter(function (c) { return c.id; });
        if (palette.open()) palette.render();
      }).catch(function () {});
    } catch (err) { /* the palette keeps what it had */ }
    cache.at = Date.now();
  }

  var PAGES = [
    ["Music", "#/music"], ["Games", "#/games"], ["Shorts", "#/shorts"], ["History", "#/history"],
    ["Spaces", "#/spaces"], ["Online", "#/online"], ["Vault", "#/vault"]
  ];
  var SETTINGS = [
    ["Accessibility, display and languages", "#/settings/accessibility"], ["Languages", "#/settings/languages"],
    ["Data usage", "#/settings/data"], ["Privacy and safety", "#/settings/privacy"],
    ["Customize navigation", "#/settings/display/navigation"], ["Device performance", "#/settings/performance"],
    ["Live Translate", "#/settings/translate"], ["Keyboard shortcuts", "#/settings/keyboard"]
  ];

  function navMenuIds() {
    try { return typeof root.navMenuIds === "function" ? (root.navMenuIds() || []).map(String) : []; } catch (err) { return []; }
  }
  function navItemFor(id) {
    var list = doc.querySelectorAll("header.nav .nav-item, nav.bottom-nav a, nav.bottom-nav button, [data-menu-id]");
    for (var i = 0; i < list.length; i++) if (K.menus.idFor(list[i]) === id && shown(list[i])) return list[i];
    return null;
  }
  // Sidebar tab menus from the nav (openNavMenu) plus menus registered with K.menus.
  function menuItems() {
    var seen = {};
    return navMenuIds().concat(K.menus.ids()).filter(function (id) {
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    }).map(function (id) {
      var item = navItemFor(id);
      var name = item ? (item.getAttribute("aria-label") || item.textContent || "").replace(/\s+/g, " ").trim() : "";
      name = name || id;
      return { kind: "Menus", label: tr("Menu: {name}", { name: name }), hay: name + " " + id + " menu",
        run: function () { K.menus.open(id, navItemFor(id)); } };
    });
  }

  function paletteItems() {
    var out = [];
    var ctx = K.context();
    K.commands().forEach(function (cmd) {
      if (!cmd.palette) return;
      if (cmd.scope !== "global" && !(ctx.scopes[cmd.scope])) return;
      out.push({ kind: "Commands", label: K.label(cmd), hay: cmd.label + " " + cmd.keywords, seq: firstBinding(cmd.id),
        run: function () { K.run(cmd.id); } });
    });
    PAGES.forEach(function (p) {
      if (p[1] === "#/shorts" && window.SHORTS_ENABLED !== true) return;
      out.push({ kind: "Pages", label: tr(p[0]), hay: p[0], href: p[1] });
    });
    SETTINGS.forEach(function (p) { out.push({ kind: "Settings", label: tr(p[0]), hay: p[0] + " settings", href: p[1] }); });
    (call("themes") || []).forEach(function (id) {
      out.push({ kind: "Themes", label: call("themeLabel", id) || id, hay: id + " theme", run: function () { call("act", "theme", { theme: id }); } });
    });
    menuItems().forEach(function (it) { out.push(it); });
    cache.communities.forEach(function (c) { out.push({ kind: "Communities", label: c.title, sub: "#" + c.name, hay: c.title + " #" + c.name, href: "#/communities/" + encodeURIComponent(c.name) }); });
    cache.chats.forEach(function (c) { out.push({ kind: "Chats", label: c.name, hay: c.name, href: "#/messages/discord/" + encodeURIComponent(c.id) }); });
    cache.accounts.forEach(function (a) { out.push({ kind: "Accounts", label: a.name || a.handle, sub: "@" + a.handle, hay: a.name + " @" + a.handle, href: a.hash }); });
    return out;
  }
  var KIND_ORDER = ["Commands", "Pages", "Settings", "Menus", "Accounts", "Communities", "Chats", "Themes"];

  var palette = (function () {
    var items = [];
    var shownItems = [];
    var sel = 0;
    function el() { return overlayEl("kb-palette"); }
    function open() { var e = doc.getElementById("kb-palette"); return !!(e && !e.hidden); }
    function filter(q) {
      var kind = "";
      if (q.charAt(0) === ">") { kind = "Commands"; q = q.slice(1); }
      else if (q.charAt(0) === "@") { kind = "Accounts"; q = q.slice(1); }
      else if (q.charAt(0) === "#") { kind = "Communities"; q = q.slice(1); }
      var scored = [];
      items.forEach(function (it) {
        if (kind && it.kind !== kind) return;
        var s = Math.max(fuzzy(q, it.label), fuzzy(q, it.hay) - 50, it.sub ? fuzzy(q, it.sub) - 20 : -1);
        if (s < 0) return;
        scored.push({ it: it, s: s });
      });
      if (!q.trim()) {
        scored.sort(function (a, b) { return KIND_ORDER.indexOf(a.it.kind) - KIND_ORDER.indexOf(b.it.kind); });
        return scored.filter(function (x) { return x.it.kind === "Commands" || x.it.kind === "Pages" || kind; }).slice(0, 80).map(function (x) { return x.it; });
      }
      scored.sort(function (a, b) { return b.s - a.s; });
      return scored.slice(0, 60).map(function (x) { return x.it; });
    }
    function render() {
      var box = el();
      var input = box.querySelector("input");
      if (!input) return;
      items = paletteItems();
      shownItems = filter(input.value);
      if (sel >= shownItems.length) sel = Math.max(0, shownItems.length - 1);
      var list = box.querySelector(".kb-list");
      if (!shownItems.length) {
        list.innerHTML = '<li class="kb-empty" role="presentation">' + esc(tr("No results")) + "</li>";
        input.removeAttribute("aria-activedescendant");
        return;
      }
      var html = "";
      var lastKind = "";
      shownItems.forEach(function (it, i) {
        if (it.kind !== lastKind) { html += '<li class="kb-kind" role="presentation">' + esc(tr(it.kind)) + "</li>"; lastKind = it.kind; }
        html += '<li id="kb-opt-' + i + '" role="option" class="kb-opt' + (i === sel ? " on" : "") + '" aria-selected="' + (i === sel) + '" data-kb-i="' + i + '">' +
          '<span class="kb-opt-label">' + esc(it.label) + (it.sub ? ' <span class="kb-sub">' + esc(it.sub) + "</span>" : "") + "</span>" +
          (it.seq ? '<span class="kb-keys">' + kbd(it.seq) + "</span>" : "") + "</li>";
      });
      list.innerHTML = html;
      input.setAttribute("aria-activedescendant", "kb-opt-" + sel);
      var on = list.querySelector(".kb-opt.on");
      if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest" });
    }
    function choose(i) {
      var it = shownItems[i];
      if (!it) return;
      close();
      if (it.href) go(it.href);
      else if (it.run) it.run();
    }
    function show(q) {
      remember();
      var box = el();
      if (!box.firstChild) {
        box.classList.add("kb-palette");
        box.innerHTML = '<div class="kb-box" role="dialog" aria-modal="true">' +
          '<input class="kb-input" type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="kb-palette-list" autocomplete="off" spellcheck="false">' +
          '<ul class="kb-list" id="kb-palette-list" role="listbox"></ul></div>';
        var input = box.querySelector("input");
        input.addEventListener("input", function () { sel = 0; render(); });
        input.addEventListener("keydown", function (event) {
          var k = event.key;
          if (event.isComposing) return;
          if (k === "ArrowDown" || k === "ArrowUp") {
            event.preventDefault();
            if (shownItems.length) sel = (sel + (k === "ArrowDown" ? 1 : -1) + shownItems.length) % shownItems.length;
            render();
          } else if (k === "Enter") { event.preventDefault(); choose(sel); }
          else if (k === "Escape") { event.preventDefault(); close(); }
          else if (k === "Tab") { event.preventDefault(); }
        });
        box.querySelector(".kb-list").addEventListener("click", function (event) {
          var opt = event.target.closest && event.target.closest("[data-kb-i]");
          if (opt) choose(Number(opt.getAttribute("data-kb-i")));
        });
      }
      var b = box.querySelector(".kb-box");
      b.setAttribute("aria-label", tr("Command palette"));
      var input2 = box.querySelector("input");
      input2.placeholder = tr("Search commands, pages, people and settings");
      input2.setAttribute("aria-label", tr("Command palette"));
      input2.value = q || "";
      sel = 0;
      box.hidden = false;
      render();
      input2.focus();
      if (Date.now() - cache.at > 30000) refreshCache();
    }
    function close() {
      var e = doc.getElementById("kb-palette");
      if (!e || e.hidden) return;
      e.hidden = true;
      restore();
    }
    return { show: show, close: close, open: open, render: render };
  })();

  var sheet = (function () {
    function open() { var e = doc.getElementById("kb-sheet"); return !!(e && !e.hidden); }
    function groups(q) {
      var by = {};
      var over = K.prefs().overrides || {};
      K.commands().forEach(function (cmd) {
        // One row stands for 1-9 while those keep their defaults.
        var range = (cmd.id === "nav.item1" || cmd.id === "feed.tab1") && !over[cmd.id] && !over[cmd.id.replace(/1$/, "9")];
        if (/^(nav\.item|feed\.tab)[2-9]$/.test(cmd.id) && !over[cmd.id] && !over[cmd.id.replace(/\d$/, "1")]) return;
        var g = cmd.group === "nav" ? "nav" : cmd.scope;
        var name = K.label(cmd);
        var seqs = K.bindingsOf(cmd.id);
        if (range) {
          var nine = K.bindingsOf(cmd.id.replace(/1$/, "9"));
          name = tr(cmd.id === "nav.item1" ? "Sidebar items 1–9" : "Home tabs 1–9");
          if (seqs.length && nine.length) seqs = [seqs[0], nine[0]];
        }
        if (q && fuzzy(q, name + " " + cmd.keywords + " " + seqs.map(function (x) { return K.formatBinding(x); }).join(" ")) < 0) return;
        (by[g] = by[g] || []).push({ name: name, seqs: seqs, range: range });
      });
      return by;
    }
    function render() {
      var box = doc.getElementById("kb-sheet");
      var q = box.querySelector("input").value;
      var by = groups(q);
      var order = ["nav", "global", "timeline", "post", "composer", "media", "dm", "modal"];
      var html = "";
      order.forEach(function (g) {
        if (!by[g]) return;
        html += '<section class="kb-group"><h3>' + esc(g === "nav" ? tr("Navigation") : tr(K.SCOPE_LABELS[g])) + "</h3><dl>";
        by[g].forEach(function (row) {
          var keys = row.seqs.length ? row.seqs.map(kbd).join(row.range ? " – " : ' <span class="kb-or">' + esc(tr("or")) + "</span> ") : '<span class="kb-off">' + esc(tr("Not set")) + "</span>";
          html += "<div><dt>" + esc(row.name) + "</dt><dd>" + keys + "</dd></div>";
        });
        html += "</dl></section>";
      });
      if (!html) html = '<p class="kb-empty">' + esc(tr("No results")) + "</p>";
      box.querySelector(".kb-groups").innerHTML = html;
    }
    function show() {
      remember();
      var box = overlayEl("kb-sheet");
      if (!box.firstChild) {
        box.classList.add("kb-sheet");
        box.innerHTML = '<div class="kb-box" role="dialog" aria-modal="true" aria-labelledby="kb-sheet-title">' +
          '<div class="kb-head"><h2 id="kb-sheet-title"></h2><button type="button" class="kb-x" data-kb="sheet-close"></button></div>' +
          '<input class="kb-input" type="search" autocomplete="off" spellcheck="false">' +
          '<div class="kb-groups"></div><p class="kb-foot"><a href="#/settings/keyboard" data-kb="sheet-settings"></a></p></div>';
        var input = box.querySelector("input");
        input.addEventListener("input", render);
        input.addEventListener("keydown", function (event) {
          if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); close(); }
        });
        box.addEventListener("click", function (event) {
          var t = event.target.closest && event.target.closest("[data-kb]");
          if (!t) return;
          if (t.getAttribute("data-kb") === "sheet-close") close();
          if (t.getAttribute("data-kb") === "sheet-settings") { lastFocus = null; close(); }
        });
      }
      box.querySelector("h2").textContent = tr("Keyboard shortcuts");
      var x = box.querySelector(".kb-x");
      x.setAttribute("aria-label", tr("Close"));
      x.textContent = "×";
      box.querySelector("input").placeholder = tr("Search shortcuts");
      box.querySelector("input").setAttribute("aria-label", tr("Search shortcuts"));
      box.querySelector("input").value = "";
      box.querySelector(".kb-foot a").textContent = tr("Change shortcuts in Settings");
      box.hidden = false;
      render();
      box.querySelector("input").focus();
    }
    function close() {
      var e = doc.getElementById("kb-sheet");
      if (!e || e.hidden) return;
      e.hidden = true;
      restore();
    }
    return { show: show, close: close, open: open };
  })();

  /* ---------- Settings > Keyboard shortcuts ---------- */

  var capture = null; // { id, seq: [], timer, conflicts }
  var note = "";
  function toggleRow(key, title, sub, on) {
    return '<div class="kb-set-row"><div><div class="kb-set-title">' + esc(title) + '</div>' + (sub ? '<div class="kb-set-sub">' + esc(sub) + "</div>" : "") +
      '</div><button type="button" class="kb-switch" role="switch" aria-checked="' + on + '" aria-label="' + esc(title) + '" data-kb="opt" data-kb-opt="' + key + '"><span></span></button></div>';
  }
  function settingsHtml() {
    var p = K.prefs();
    var order = ["global", "timeline", "post", "composer", "media", "dm", "modal"];
    var html = '<div class="kb-settings" id="kb-settings">';
    html += '<p class="kb-set-intro">' + esc(tr("Use the keyboard for everything. Press ? to see every shortcut, and Ctrl+K to open the command palette.").replace("Ctrl+K", K.formatBinding(K.parseBinding("mod+k")))) + "</p>";
    html += toggleRow("enabled", tr("Use keyboard shortcuts"), "", p.enabled !== false);
    html += toggleRow("singleKeys", tr("Single-key shortcuts"), tr("Shortcuts made of one letter, number or symbol, like j, k and ?. Turn off if you use speech input or often press keys by accident."), p.singleKeys !== false);
    if (note) html += '<p class="kb-note" role="status">' + esc(note) + "</p>";
    order.forEach(function (scope) {
      var cmds = K.commands().filter(function (c) { return c.scope === scope; });
      if (!cmds.length) return;
      html += '<h3 class="kb-set-h">' + esc(tr(K.SCOPE_LABELS[scope])) + "</h3>";
      cmds.forEach(function (cmd) {
        var seqs = K.bindingsOf(cmd.id);
        var changed = Object.prototype.hasOwnProperty.call(p.overrides || {}, cmd.id);
        var keys;
        if (capture && capture.id === cmd.id) {
          keys = '<span class="kb-capture" aria-live="polite">' + (capture.seq.length ? kbd(capture.seq) : esc(tr("Press the new keys…"))) + "</span>";
        } else {
          keys = seqs.length ? seqs.map(kbd).join(' <span class="kb-or">' + esc(tr("or")) + "</span> ") : '<span class="kb-off">' + esc(tr("Not set")) + "</span>";
        }
        html += '<div class="kb-cmd' + (changed ? " changed" : "") + '" data-kb-id="' + esc(cmd.id) + '"><div class="kb-cmd-label">' + esc(K.label(cmd)) + "</div>" +
          '<div class="kb-cmd-keys">' + keys + "</div>" +
          '<div class="kb-cmd-acts"><button type="button" data-kb="change">' + esc(tr("Change")) + "</button>" +
          (seqs.length ? '<button type="button" data-kb="off">' + esc(tr("Turn off")) + "</button>" : "") +
          (changed ? '<button type="button" data-kb="reset">' + esc(tr("Reset")) + "</button>" : "") + "</div>";
        if (capture && capture.id === cmd.id && capture.conflicts && capture.conflicts.length) {
          var names = capture.conflicts.map(function (c) { var o = K.command(c.id); return o ? K.label(o) : c.id; });
          html += '<div class="kb-conflict" role="alert">' + esc(tr("Already used by {name}.", { name: names.join(", ") })) +
            ' <button type="button" data-kb="replace">' + esc(tr("Replace")) + '</button> <button type="button" data-kb="cancel">' + esc(tr("Cancel")) + "</button></div>";
        }
        html += "</div>";
      });
    });
    html += '<div class="kb-set-foot"><button type="button" data-kb="export">' + esc(tr("Export")) + '</button><button type="button" data-kb="import">' + esc(tr("Import")) + "</button>" +
      '<button type="button" data-kb="reset-all">' + esc(tr("Reset all shortcuts")) + "</button>" +
      '<input type="file" accept="application/json,.json" data-kb="file" hidden></div></div>';
    return html;
  }
  function refreshSettings(focusSel) {
    var box = doc.getElementById("kb-settings");
    if (!box) return;
    var wrap = doc.createElement("div");
    wrap.innerHTML = settingsHtml();
    box.replaceWith(wrap.firstChild);
    if (focusSel) { var f = doc.querySelector(focusSel); if (f) f.focus(); }
  }
  function endCapture(save, replace) {
    if (!capture) return;
    var c = capture;
    if (c.timer) clearTimeout(c.timer);
    if (save && c.seq.length) {
      var res = K.rebind(c.id, [c.seq.join(" ")], { replace: !!replace });
      if (!res.ok) { c.conflicts = res.conflicts; c.timer = 0; refreshSettings('[data-kb-id="' + c.id + '"] [data-kb="replace"]'); return; }
    }
    capture = null;
    refreshSettings('[data-kb-id="' + c.id + '"] [data-kb="change"]');
  }
  // Capture runs before the registry so the keys being recorded don't fire.
  root.addEventListener("keydown", function (event) {
    if (!capture || capture.conflicts) return;
    var combo = K.eventCombo(event);
    if (!combo) return;
    event.preventDefault();
    event.stopPropagation();
    if (combo === "escape" && !capture.seq.length) { capture = null; refreshSettings(); return; }
    if (capture.seq.length >= 3) return;
    capture.seq.push(combo);
    if (capture.timer) clearTimeout(capture.timer);
    // A second key within the chord time makes a chord like "g h".
    capture.timer = setTimeout(function () { endCapture(true); }, K.CHORD_MS);
    refreshSettings();
  }, true);
  doc.addEventListener("click", function (event) {
    var t = event.target && event.target.closest && event.target.closest("#kb-settings [data-kb]");
    if (!t) return;
    var what = t.getAttribute("data-kb");
    var row = t.closest("[data-kb-id]");
    var id = row ? row.getAttribute("data-kb-id") : "";
    note = "";
    if (what === "opt") {
      var key = t.getAttribute("data-kb-opt");
      K.setOption(key, t.getAttribute("aria-checked") !== "true");
      refreshSettings('[data-kb-opt="' + key + '"]');
    } else if (what === "change") {
      if (capture && capture.timer) clearTimeout(capture.timer);
      capture = { id: id, seq: [], timer: 0, conflicts: null };
      refreshSettings();
    } else if (what === "replace") endCapture(true, true);
    else if (what === "cancel") { capture = null; refreshSettings('[data-kb-id="' + id + '"] [data-kb="change"]'); }
    else if (what === "off") { K.rebind(id, []); refreshSettings('[data-kb-id="' + id + '"] [data-kb="change"]'); }
    else if (what === "reset") { K.resetCommand(id); refreshSettings('[data-kb-id="' + id + '"] [data-kb="change"]'); }
    else if (what === "reset-all") {
      if (root.confirm && !root.confirm(tr("Reset all shortcuts to their defaults?"))) return;
      K.resetAll();
      note = tr("Shortcuts reset.");
      refreshSettings();
    } else if (what === "export") {
      var blob = new Blob([K.exportJson()], { type: "application/json" });
      var a = doc.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "keyboard-shortcuts.json";
      doc.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } else if (what === "import") {
      var file = doc.querySelector('#kb-settings [data-kb="file"]');
      if (file) file.click();
    }
  });
  doc.addEventListener("change", function (event) {
    var input = event.target;
    if (!input || !input.matches || !input.matches('#kb-settings [data-kb="file"]') || !input.files || !input.files[0]) return;
    var f = input.files[0];
    if (f.size > 200000) { note = tr("That file isn’t a shortcuts file."); refreshSettings(); return; }
    var reader = new FileReader();
    reader.onload = function () {
      note = K.importJson(String(reader.result || "")).ok ? tr("Shortcuts imported.") : tr("That file isn’t a shortcuts file.");
      refreshSettings();
    };
    reader.readAsText(f);
  });
  K.onChange(function () { if (!capture) refreshSettings(); });

  /* aria-keyshortcuts on the sidebar and on post actions, so screen readers
     announce them. */
  function annotate() {
    var p = K.prefs();
    var set = function (el, id) {
      if (!el) return;
      var v = p.enabled === false ? "" : K.ariaValue(K.bindingsOf(id));
      if (v) el.setAttribute("aria-keyshortcuts", v);
      else el.removeAttribute("aria-keyshortcuts");
    };
    var links = sidebarLinks();
    NAV.forEach(function (row) {
      if (typeof row[3] !== "string") return;
      links.forEach(function (a) { if (a.getAttribute("href") === row[3]) set(a, row[0]); });
    });
    doc.querySelectorAll("article.post.kb-focus").forEach(function (post) {
      set(post.querySelector('.actions [data-act="like"]'), "post.like");
      set(post.querySelector('.actions [data-act="repost"]'), "post.repost");
      set(post.querySelector('.actions [data-act="bookmark"]'), "post.bookmark");
      set(post.querySelector('.actions [data-act="share"]'), "post.share");
      set(post.querySelector('.actions [data-act="xc-reply"], .actions [data-act="public-reply"], .actions .reply'), "post.reply");
    });
    var compose = doc.querySelector('header.nav [data-act="compose"]');
    set(compose, "app.compose");
  }
  var annotateQueued = false;
  function queueAnnotate() {
    if (annotateQueued) return;
    annotateQueued = true;
    setTimeout(function () { annotateQueued = false; annotate(); }, 400);
  }
  if (root.MutationObserver && doc.body) new root.MutationObserver(queueAnnotate).observe(doc.body, { childList: true, subtree: true });
  root.addEventListener("hashchange", queueAnnotate);
  doc.addEventListener("focusin", queueAnnotate);
  K.onChange(queueAnnotate);

  // Warm the palette's lists once the page is idle, so it opens instantly.
  (root.requestIdleCallback || function (fn) { return setTimeout(fn, 2500); })(refreshCache);

  root.ViktorychKeysUi = {
    settingsHtml: settingsHtml,
    palette: palette,
    sheet: sheet,
    fuzzy: fuzzy,
    paletteItems: paletteItems
  };
})(typeof window !== "undefined" ? window : this);
