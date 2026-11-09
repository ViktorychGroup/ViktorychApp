/* Corner drawers docked to the page. Chat reads the same conversations as
   the Messages screen. The other square is a local AI chat. Nothing here
   embeds another site. */
(function (root) {
  var anchorHoldTicket = 0;
  function holdDocumentAnchor() {
    var doc = document.documentElement;
    if (!doc) return;
    doc.classList.add("vk-anchor-hold");
    var ticket = ++anchorHoldTicket;
    var raf = root.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () {
      setTimeout(function () {
        if (ticket !== anchorHoldTicket) return;
        doc.classList.remove("vk-anchor-hold");
      }, 120);
    });
  }
  root.ViktorychAnchorHold = holdDocumentAnchor;
  var KEY = "viktorychapp-dock-v1";
  var AI_CONFIG = {
    name: "AI",
    icon: "M12 2.2l1.7 5.4 5.5 1.5-5.5 1.6L12 16.2l-1.7-5.5L4.8 9.1l5.5-1.5L12 2.2zM18.2 13.2l.8 2.4 2.5.7-2.5.7-.8 2.5-.8-2.5-2.4-.7 2.4-.7.8-2.4z"
  };
  var PATH = {
    spark: AI_CONFIG.icon,
    chat: "M2 5.5C2 4.12 3.12 3 4.5 3h15C20.88 3 22 4.12 22 5.5v9c0 1.38-1.12 2.5-2.5 2.5H13l-4.5 4v-4H4.5C3.12 17 2 15.88 2 14.5v-9z",
    caret: "M7 9.2 12 14.2 17 9.2l1.2 1.2L12 16.6 5.8 10.4z",
    back: "M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z",
    plus: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4z",
    more: "M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z",
    expand: "M4 10V4h6v2H6v4H4zm10-6h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm12 4v-4h2v6h-6v-2h4z",
    history: "M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-2.1-5H14V9h7V2h-2v2.3A9 9 0 0 0 12 3zm-1 4h2v5.2l3.2 1.9-1 1.6L11 13.2V7z",
    attach: "M8 7.5V16a4 4 0 0 0 8 0V6.8a2.8 2.8 0 0 0-5.6 0V15a1.4 1.4 0 0 0 2.8 0V8h1.6v7a3 3 0 0 1-6 0V6.8a4.4 4.4 0 0 1 8.8 0V16a5.6 5.6 0 0 1-11.2 0V7.5H8z",
    copy: "M8 7h8.5C17.88 7 19 8.12 19 9.5v10c0 1.38-1.12 2.5-2.5 2.5h-8C7.12 22 6 20.88 6 19.5v-10C6 8.12 7.12 7 8.5 7H8zm.5 2c-.28 0-.5.22-.5.5v10c0 .28.22.5.5.5h8c.28 0 .5-.22.5-.5v-10c0-.28-.22-.5-.5-.5h-8zM9 4h8.5C18.88 4 20 5.12 20 6.5V16h-2V6.5c0-.28-.22-.5-.5-.5H9V4z",
    send: "M3 11.2 21 3l-7.2 18-2.6-7.2L3 11.2zm9.2 1.6 1.7 4.6 4.2-10.5-10.5 4.2 4.6 1.7z",
    close: "M10.59 12 4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"
  };
  var SIZES = ["compact", "tall", "half", "full"];
  var providers = [];
  var aiGen = 0;
  var pollTimer = 0;
  var chatStore = null;
  var activeKind = "chat";
  var ui = {
    menu: false,
    chatView: "list",
    query: "",
    friendQ: "",
    chatDraft: "",
    aiView: "thread",
    aiDraft: "",
    aiQuery: "",
    attachments: []
  };
  var chatMem = {
    conversations: [],
    friends: [],
    messages: [],
    peer: null,
    error: "",
    loading: false,
    sending: false
  };

  function tr(key, vars) {
    var fn = root.t || (root.SI18n && root.SI18n.t);
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function svg(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + (PATH[name] || AI_CONFIG.icon) + '"/></svg>';
  }
  function fresh() {
    return {
      showChat: true,
      showAi: true,
      side: "right",
      size: "compact",
      chatOpen: false,
      aiOpen: false,
      chat: { w: 0, h: 0, preset: "compact" },
      ai: { w: 0, h: 0, preset: "compact" },
      chatThread: "",
      aiChatId: ""
    };
  }
  function read() {
    var data = fresh();
    try {
      var raw = root.localStorage && root.localStorage.getItem(KEY);
      if (raw) data = normalize(JSON.parse(raw));
    } catch (err) {}
    return data;
  }
  function normalize(input) {
    var base = fresh();
    var src = input || {};
    base.showChat = src.showChat !== false;
    base.showAi = src.showAi !== false;
    base.side = src.side === "left" ? "left" : "right";
    base.size = SIZES.indexOf(src.size) >= 0 ? src.size : "compact";
    base.chatOpen = !!src.chatOpen;
    base.aiOpen = !!src.aiOpen;
    base.chat = slot(src.chat, base.size);
    base.ai = slot(src.ai, base.size);
    base.chatThread = typeof src.chatThread === "string" ? src.chatThread : "";
    base.aiChatId = typeof src.aiChatId === "string" ? src.aiChatId : "";
    return base;
  }
  function slot(value, fallback) {
    var src = value || {};
    var preset = src.preset === "custom" || SIZES.indexOf(src.preset) >= 0 ? src.preset : fallback;
    var w = Number(src.w) || 0;
    var h = Number(src.h) || 0;
    return { w: w, h: h, preset: preset };
  }
  function save(data) {
    try { root.localStorage.setItem(KEY, JSON.stringify(data)); } catch (err) {}
  }
  function viewport() {
    var w = 1200;
    var h = 800;
    try {
      if (root.innerWidth) w = root.innerWidth;
      if (root.innerHeight) h = root.innerHeight;
    } catch (err) {}
    return { w: w, h: h };
  }
  function clampBox(w, h, vw, vh) {
    var view = viewport();
    var maxW = Math.max(320, (vw || view.w) - 16);
    var maxH = Math.max(280, (vh || view.h) - 16);
    return {
      w: Math.round(Math.min(maxW, Math.max(320, Number(w) || 0))),
      h: Math.round(Math.min(maxH, Math.max(280, Number(h) || 0)))
    };
  }
  function presetSize(name, vw, vh) {
    var view = viewport();
    var width = vw || view.w;
    var height = vh || view.h;
    if (name === "tall") return clampBox(400, Math.min(780, height - 48), width, height);
    if (name === "half") return clampBox(Math.round(width / 2), height - 16, width, height);
    if (name === "full") return clampBox(width - 16, height - 16, width, height);
    return clampBox(400, Math.min(530, height - 16), width, height);
  }
  function boxFor(kind, vw, vh) {
    var prefs = read();
    var item = prefs[kind] || {};
    if (item.preset === "custom" && item.w && item.h) return clampBox(item.w, item.h, vw, vh);
    return presetSize(item.preset || prefs.size || "compact", vw, vh);
  }
  function shown(kind) {
    var prefs = read();
    return kind === "chat" ? prefs.showChat !== false : prefs.showAi !== false;
  }
  function opened(kind) {
    var prefs = read();
    return kind === "chat" ? !!prefs.chatOpen : !!prefs.aiOpen;
  }
  function label(kind) {
    return kind === "ai" ? AI_CONFIG.name : tr("Chat");
  }
  function demoOn() {
    var flag = "";
    try { flag = root.localStorage.getItem("viktorychapp-ai-demo") || ""; } catch (err) {}
    if (flag === "1") return true;
    if (flag === "0") return false;
    var host = "";
    try { host = (root.location && root.location.hostname) || ""; } catch (err) {}
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  }
  function registerProvider(provider) {
    if (!provider || !provider.id) return;
    providers = providers.filter(function (item) { return item.id !== provider.id; });
    providers.push(provider);
    providers.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }
  function activeProvider() {
    var i;
    for (i = 0; i < providers.length; i++) {
      try { if (providers[i].available && providers[i].available()) return providers[i]; } catch (err) {}
    }
    return null;
  }
  function iconBtn(action, kind, name, text, extra) {
    return '<button class="xdock-icon" type="button" data-dock="' + action + '" data-panel="' + kind + '"' + (extra || "") + ' aria-label="' + esc(text) + '" data-tooltip="' + esc(text) + '" data-tip="' + esc(text) + '">' + svg(name) + "</button>";
  }
  function launcherHtml(kind) {
    var text = label(kind);
    var VI = window.ViktorychIcons;
    var icon = kind === "ai" ? (VI && VI.has && VI.has("viktrych") ? VI.svg("viktrych") : svg("spark")) : svg("chat");
    return '<button class="xdock-launcher" type="button" data-dock="toggle" data-panel="' + kind + '" aria-label="' + esc(text) + '" data-tooltip="' + esc(text) + '" data-tip="' + esc(text) + '">' + icon + "</button>";
  }
  function headInner(kind) {
    var prefs = read();
    var title = label(kind);
    var back = "";
    if (kind === "chat" && ui.chatView !== "list") {
      back = iconBtn("back", kind, "back", tr("Back"));
      var open = currentThread();
      if (ui.chatView === "thread" && open && open.name) title = open.name;
    }
    if (kind === "ai" && ui.aiView === "history") {
      back = iconBtn("ai-back", kind, "back", tr("Back to chat"));
      title = tr("History");
    }
    var tools = "";
    if (kind === "chat") {
      tools = iconBtn("menu", kind, "more", tr("Chat options"), ' aria-expanded="' + (ui.menu ? "true" : "false") + '"');
    } else {
      tools = iconBtn("ai-new", kind, "plus", tr("New chat")) + iconBtn("ai-history", kind, "history", tr("History"));
    }
    var menu = "";
    if (kind === "chat") {
      menu = '<div class="xdock-menu"' + (ui.menu ? "" : " hidden") + '><a href="https://x.com/i/chat" target="_blank" rel="noopener noreferrer">' + esc(tr("Open X Chat")) + '</a><span class="xdock-note">' + esc(tr("This opens x.com in a new tab. This app does not host that site.")) + "</span></div>";
    }
    return back + '<h2 class="xdock-title">' + esc(title) + "</h2>" + tools +
      iconBtn("expand", kind, "expand", tr("Expand")) +
      iconBtn("collapse", kind, "caret", tr("Collapse")) + menu;
  }
  function logHtml(kind) {
    if (kind === "chat") return chatLog();
    return aiLog();
  }
  function messagesApi() {
    var api = root.FeedsDiscord;
    if (!api || typeof api.inbox !== "function" || typeof api.thread !== "function") return null;
    return api;
  }
  function readInbox() {
    var api = messagesApi();
    if (!api) return { missing: true, ready: true, channels: [] };
    var data = api.inbox();
    if (Array.isArray(data)) return { missing: false, ready: true, channels: data };
    return {
      missing: false,
      ready: !data || data.ready !== false,
      channels: (data && data.channels) || []
    };
  }
  function readThread(id) {
    var api = messagesApi();
    if (!api) return { missing: true, found: false, loading: false, name: "", messages: [] };
    var data = api.thread(id) || {};
    return {
      missing: false,
      found: !!data.found,
      loading: !!data.loading,
      name: data.name || "",
      messages: data.messages || []
    };
  }
  function currentThread() {
    var id = read().chatThread || "";
    if (!id) return null;
    return readThread(id);
  }
  function chatLog() {
    if (ui.chatView === "thread") return threadLog();
    var inbox = readInbox();
    if (inbox.missing) {
      return '<div class="xdock-empty"><p>' + esc(tr("Private conversations aren’t part of this reader.")) + "</p></div>";
    }
    if (!inbox.ready && !inbox.channels.length) return '<div class="xdock-empty"><p>' + esc(tr("Loading messages")) + "</p></div>";
    var q = ui.query.trim().toLowerCase();
    var rows = inbox.channels.filter(function (row) {
      if (!q) return true;
      return ((row.name || "") + " " + (row.category || "") + " " + (row.preview || "") + " " + (row.author || "")).toLowerCase().indexOf(q) >= 0;
    });
    if (!rows.length) {
      return '<div class="xdock-empty"><p>' + esc(tr("No conversations yet")) + "</p><p>" + esc(tr("Channels set to messages show up here. None are configured yet.")) + "</p></div>";
    }
    return rows.map(function (row) {
      var name = row.name || tr("Channel");
      var preview = row.preview || row.author || "";
      return '<button class="xdock-row" type="button" data-dock="thread" data-id="' + esc(row.id) + '"><span class="xdock-copy"><b>' + esc(name) + "</b><i>" + esc(preview) + "</i></span></button>";
    }).join("");
  }
  function threadLog() {
    var thread = currentThread();
    if (!thread || thread.missing) {
      return '<div class="xdock-empty"><p>' + esc(tr("Private conversations aren’t part of this reader.")) + "</p></div>";
    }
    if (!thread.found) {
      return '<div class="xdock-empty"><p>' + esc(tr("This channel isn’t available")) + "</p><p>" + esc(tr("It isn’t in the Discord list.")) + "</p></div>";
    }
    if (thread.loading && !thread.messages.length) return '<div class="xdock-empty"><p>' + esc(tr("Loading messages")) + "</p></div>";
    if (!thread.messages.length) {
      return '<div class="xdock-empty"><p>' + esc(tr("No messages yet")) + "</p><p>" + esc(tr("The next sync reads the latest 50. This view keeps a rolling window of 300.")) + "</p></div>";
    }
    var tools = '<div class="odai-chips"><button type="button" class="show-more" data-act="odai-unread" data-id="' + esc(read().chatThread || "") + '" data-scope="dm">' + esc(tr("Summarize unread")) + '</button><button type="button" class="show-more" data-act="odai-suggest" data-id="' + esc(read().chatThread || "") + '" data-scope="dm">' + esc(tr("Suggest replies")) + "</button></div>";
    return tools + thread.messages.map(function (msg) {
      var name = msg.name || tr("Someone");
      var ai = root.ViktorychOnDeviceAi;
      var deco = ai && ai.decorate ? ai.decorate(msg.body || "", "dm") : null;
      if (deco && deco.hidden) return '<div class="xdock-bubble in"><b>' + esc(name) + "</b>" + deco.html + "</div>";
      return '<div class="xdock-bubble in"><b>' + esc(name) + "</b>" + esc(msg.body || "") + (deco && deco.tools ? deco.tools : "") + "</div>";
    }).join("");
  }
  function aiLog() {
    if (ui.aiView === "history") return historyLog();
    var provider = activeProvider();
    if (!provider) {
      return '<div class="xdock-soon"><h3>' + esc(tr("AI is coming soon")) + "</h3><p>" + esc(tr("A conversation will show up here when a model is connected. Nothing is sent off this device.")) + "</p></div>";
    }
    var chat = currentChat();
    var messages = (chat && chat.messages) || [];
    if (!messages.length) return '<div class="xdock-empty"><p>' + esc(tr("Ask anything")) + "</p></div>";
    return messages.map(function (msg, index) {
      if (msg.role === "user") return '<div class="xdock-ai-user"><div class="xdock-bubble out">' + esc(msg.text || "") + "</div></div>";
      var caret = msg.pending ? '<span class="xdock-caret"></span>' : "";
      var actions = "";
      var last = index === messages.length - 1;
      if (!msg.pending) {
        actions = '<div class="xdock-ai-actions"><button class="xdock-icon" type="button" data-dock="ai-copy" data-id="' + esc(msg.id) + '" aria-label="' + esc(tr("Copy")) + '">' + svg("copy") + "</button>" +
          (last ? '<button class="xdock-icon" type="button" data-dock="ai-regen" aria-label="' + esc(tr("Regenerate")) + '">' + svg("history") + "</button>" : "") +
          "</div>";
      }
      return '<div class="xdock-ai-msg" data-ai-msg="' + esc(msg.id) + '"><div class="xdock-ai-text"><span class="xdock-ai-copy">' + esc(msg.text || "") + "</span>" + caret + "</div>" + actions + "</div>";
    }).join("");
  }
  function historyLog() {
    var rows = ui.aiChats || [];
    var q = ui.aiQuery.trim().toLowerCase();
    rows = rows.filter(function (row) { return !q || String(row.title || "").toLowerCase().indexOf(q) >= 0; });
    if (!rows.length) return '<div class="xdock-empty"><p>' + esc(tr("No chats yet")) + "</p></div>";
    return rows.map(function (row) {
      return '<div class="xdock-row"><button class="xdock-friend" type="button" data-dock="ai-open" data-id="' + esc(row.id) + '"><span><b>' + esc(row.title || AI_CONFIG.name) + '</b></span></button><button class="xdock-icon" type="button" data-dock="ai-remove" data-id="' + esc(row.id) + '" aria-label="' + esc(tr("Remove")) + '">' + svg("close") + "</button></div>";
    }).join("");
  }
  function filesHtml() {
    if (!ui.attachments.length) return "";
    return '<div class="xdock-files">' + ui.attachments.map(function (file, index) {
      return '<button class="xdock-file" type="button" data-dock="ai-unfile" data-index="' + index + '">' + esc(file.name || tr("Attach a file")) + "</button>";
    }).join("") + "</div>";
  }
  function chipsHtml() {
    function chip(code, label) {
      return '<button class="xdock-chip" type="button" data-dock="ai-chip" data-chip="' + code + '">' + esc(label) + "</button>";
    }
    return '<div class="xdock-chips">' +
      chip("explain", tr("Explain")) +
      chip("summarize", tr("Summarize")) +
      chip("rewrite", tr("Rewrite")) +
      chip("translate", tr("Translate")) +
      "</div>";
  }
  function composeHtml() {
    var draft = ui.aiDraft;
    var placeholder = tr("Ask anything");
    return '<form class="xdock-compose" data-dock="compose">' +
      '<button class="xdock-icon" type="button" data-dock="ai-attach" aria-label="' + esc(tr("Attach a file")) + '">' + svg("attach") + '</button><input class="vh" type="file" data-dock-file multiple>' +
      '<textarea rows="1" data-compose="ai" placeholder="' + esc(placeholder) + '" aria-label="' + esc(placeholder) + '">' + esc(draft) + "</textarea>" +
      '<button class="xdock-send" type="button" data-dock="ai-send" aria-label="' + esc(tr("Send")) + '"' + (draft.trim() ? "" : " disabled") + ">" + svg("send") + "</button></form>";
  }
  function readonlyHtml() {
    return '<div class="xdock-readonly" role="textbox" aria-disabled="true" aria-label="' + esc(tr("Read-only channel")) + '"><span>' + esc(tr("Read-only channel")) + "</span></div>";
  }
  function bodyHtml(kind) {
    if (kind === "chat") {
      if (ui.chatView === "list") {
        return '<label class="xdock-search"><input data-dock-search="chat" type="search" placeholder="' + esc(tr("Search Direct Messages")) + '" aria-label="' + esc(tr("Search Direct Messages")) + '" value="' + esc(ui.query) + '"></label><div class="xdock-log">' + chatLog() + "</div>";
      }
      return '<div class="xdock-log">' + threadLog() + "</div>" + readonlyHtml();
    }
    var provider = activeProvider();
    if (!provider || ui.aiView === "soon") {
      return '<div class="xdock-log">' + aiLog() + "</div>";
    }
    if (ui.aiView === "history") {
      return '<label class="xdock-search"><input data-dock-search="ai" type="search" placeholder="' + esc(tr("Search")) + '" aria-label="' + esc(tr("Search")) + '" value="' + esc(ui.aiQuery) + '"></label><div class="xdock-log">' + historyLog() + "</div>";
    }
    var banner = provider.id === "echo" ? '<div class="xdock-banner">' + esc(tr("Local echo. No model is connected.")) + "</div>" : "";
    return banner + '<div class="xdock-log" aria-live="polite">' + aiLog() + "</div>" + filesHtml() + chipsHtml() + composeHtml();
  }
  function viewName(kind) {
    if (kind === "chat") return ui.chatView === "thread" ? "thread" : "list";
    if (!activeProvider()) return "soon";
    if (ui.aiView === "history") return "history";
    return activeProvider().id === "echo" ? "echo" : "talk";
  }
  function panelHtml(kind) {
    var open = opened(kind);
    var box = boxFor(kind);
    var mode = kind === "ai" ? ' data-ai-mode="' + (activeProvider() ? "chat" : "soon") + '"' : "";
    return '<section class="xdock-panel' + (open ? " is-open is-settled" : "") + '" data-panel="' + kind + '" role="region" aria-label="' + esc(label(kind)) + '" aria-expanded="' + (open ? "true" : "false") + '"' + mode + ' style="--dock-w:' + box.w + "px;--dock-h:" + box.h + 'px">' +
      launcherHtml(kind) +
      '<div class="xdock-sheet"><header class="xdock-head" data-dock="collapse" data-panel="' + kind + '">' + headInner(kind) + '</header><div class="xdock-body" data-view="' + viewName(kind) + '">' + bodyHtml(kind) + '</div><div class="xdock-live vh" aria-live="polite"></div><button class="xdock-resize" type="button" data-dock="resize" data-panel="' + kind + '" aria-label="' + esc(tr("Resize")) + '"></button></div></section>';
  }
  function renderHtml() {
    var prefs = read();
    var parts = "";
    if (prefs.showAi !== false) parts += panelHtml("ai");
    if (prefs.showChat !== false) parts += panelHtml("chat");
    return '<div id="dock-root" class="xdock side-' + (prefs.side === "left" ? "left" : "right") + '">' + parts + "</div>";
  }
  function settingsHtml() {
    var prefs = read();
    var name = AI_CONFIG.name;
    function toggle(key, on, text) {
      return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-act="dock-pref" data-key="' + key + '" data-value="' + (on ? "0" : "1") + '"><span>' + esc(text) + "</span><i></i></button>";
    }
    function opt(key, value, current, text) {
      return '<button class="outline' + (current === value ? " on" : "") + '" type="button" data-act="dock-pref" data-key="' + key + '" data-value="' + value + '">' + esc(text) + "</button>";
    }
    return "<h2>" + esc(tr("Corner drawers")) + "</h2>" +
      toggle("showChat", prefs.showChat !== false, tr("Show Chat")) +
      toggle("showAi", prefs.showAi !== false, tr("Show {name}", { name: name })) +
      "<h2>" + esc(tr("Default size")) + "</h2><div class=\"theme-row\">" +
      opt("size", "compact", prefs.size, tr("Compact")) +
      opt("size", "tall", prefs.size, tr("Tall")) +
      opt("size", "half", prefs.size, tr("Half screen")) +
      opt("size", "full", prefs.size, tr("Full screen")) +
      "</div><h2>" + esc(tr("Drawer side")) + "</h2><div class=\"theme-row\">" +
      opt("side", "left", prefs.side, tr("Left")) +
      opt("side", "right", prefs.side === "left" ? "left" : "right", tr("Right")) +
      "</div><p class=\"phandle\">" + esc(tr("Chat and {name} stay in the corner of this page while you switch tabs. Chat shows the same conversations as Messages. {name} stays on this device until a model is connected.", { name: name })) +
      "</p><p class=\"phandle\">" + esc(tr("Alt+Shift+C opens Chat. Alt+Shift+A opens {name}.", { name: name })) + "</p>";
  }
  function setPref(key, value) {
    var prefs = read();
    if (key === "showChat" || key === "showAi") prefs[key] = value !== "0";
    else if (key === "side") prefs.side = value === "left" ? "left" : "right";
    else if (key === "size" && SIZES.indexOf(value) >= 0) {
      prefs.size = value;
      prefs.chat = { w: 0, h: 0, preset: value };
      prefs.ai = { w: 0, h: 0, preset: value };
    }
    save(prefs);
    paint(true);
  }
  function doc() {
    return root.document;
  }
  function panelEl(kind) {
    var document = doc();
    if (!document) return null;
    var rootEl = document.getElementById("dock-root");
    return rootEl ? rootEl.querySelector('[data-panel="' + kind + '"]') : null;
  }
  function applyBox(panel, kind) {
    var box = boxFor(kind);
    panel.style.setProperty("--dock-w", box.w + "px");
    panel.style.setProperty("--dock-h", box.h + "px");
    var open = opened(kind);
    panel.setAttribute("aria-expanded", open ? "true" : "false");
    if (kind === "ai") panel.setAttribute("data-ai-mode", activeProvider() ? "chat" : "soon");
  }
  function fill(kind, force) {
    var panel = panelEl(kind);
    if (!panel) return;
    var head = panel.querySelector(".xdock-head");
    var body = panel.querySelector(".xdock-body");
    if (head) head.innerHTML = headInner(kind);
    if (!body) return;
    var view = viewName(kind);
    if (force || body.getAttribute("data-view") !== view) {
      body.innerHTML = bodyHtml(kind);
      body.setAttribute("data-view", view);
      return;
    }
    var log = body.querySelector(".xdock-log");
    if (log) log.innerHTML = logHtml(kind);
  }
  function shell(kind) {
    var open = opened(kind);
    var box = boxFor(kind);
    var panel = doc().createElement("section");
    panel.className = "xdock-panel" + (open ? " is-open is-settled" : "");
    panel.setAttribute("data-panel", kind);
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", label(kind));
    panel.setAttribute("aria-expanded", open ? "true" : "false");
    if (kind === "ai") panel.setAttribute("data-ai-mode", activeProvider() ? "chat" : "soon");
    panel.style.setProperty("--dock-w", box.w + "px");
    panel.style.setProperty("--dock-h", box.h + "px");
    panel.innerHTML = launcherHtml(kind) + '<div class="xdock-sheet"><header class="xdock-head" data-dock="collapse" data-panel="' + kind + '"></header><div class="xdock-body"></div><div class="xdock-live vh" aria-live="polite"></div><button class="xdock-resize" type="button" data-dock="resize" data-panel="' + kind + '" aria-label="' + esc(tr("Resize")) + '"></button></div>';
    var grip = panel.querySelector(".xdock-resize");
    if (grip) grip.addEventListener("pointerdown", onResizeDown);
    return panel;
  }
  function paint(rebuild, forceBody) {
    var document = doc();
    if (!document || !document.body) return;
    var host = document.getElementById("dock-root");
    if (!host) {
      host = document.createElement("div");
      host.id = "dock-root";
      document.body.appendChild(host);
      host.addEventListener("click", onClick);
      host.addEventListener("keydown", onKey);
      host.addEventListener("input", onInput);
      host.addEventListener("submit", function (event) { event.preventDefault(); });
    }
    var prefs = read();
    host.className = "xdock side-" + (prefs.side === "left" ? "left" : "right");
    ["ai", "chat"].forEach(function (kind) {
      var panel = host.querySelector('[data-panel="' + kind + '"]');
      if (!shown(kind)) {
        if (panel) panel.remove();
        return;
      }
      if (!panel || rebuild) {
        var next = shell(kind);
        if (panel) panel.replaceWith(next);
        else if (kind === "ai") host.insertBefore(next, host.firstChild);
        else host.appendChild(next);
        panel = next;
      }
      applyBox(panel, kind);
      var open = opened(kind);
      panel.classList.toggle("is-open", open);
      if (open) panel.classList.add("is-settled");
      fill(kind, forceBody);
    });
  }
  function finishClose(panel) {
    if (!panel || panel.classList.contains("is-open")) return;
    panel.classList.remove("is-closing");
  }
  function setOpen(kind, open, animate) {
    if (!shown(kind)) return;
    if (open) holdDocumentAnchor();
    var prefs = read();
    if (kind === "chat") prefs.chatOpen = !!open;
    else prefs.aiOpen = !!open;
    save(prefs);
    activeKind = kind;
    paint(false);
    var panel = panelEl(kind);
    if (!panel) return;
    if (open) {
      panel.classList.add("is-open");
      panel.classList.remove("is-closing");
      if (animate) {
        panel.classList.remove("is-settled");
        var raf = root.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
        raf(function () { raf(function () { panel.classList.add("is-settled"); }); });
      } else {
        panel.classList.add("is-settled");
      }
      if (kind === "chat") refreshChat(false);
      if (kind === "ai") loadAi();
      if (animate) {
        var field = panel.querySelector("input, textarea");
        if (field) { try { field.focus({ preventScroll: true }); } catch (err) { field.focus(); } }
      }
      return;
    }
    panel.classList.remove("is-settled");
    panel.classList.remove("is-open");
    panel.classList.add("is-closing");
    var done = function (event) {
      if (event && event.propertyName && event.propertyName !== "width" && event.propertyName !== "height") return;
      panel.removeEventListener("transitionend", done);
      finishClose(panel);
    };
    panel.addEventListener("transitionend", done);
    setTimeout(function () { finishClose(panel); }, 280);
  }
  function toggle(kind) {
    if (!shown(kind)) return;
    setOpen(kind, !opened(kind), true);
  }
  function applyPreset(kind, name) {
    var prefs = read();
    var box = presetSize(name);
    prefs[kind] = { w: box.w, h: box.h, preset: name };
    save(prefs);
    var panel = panelEl(kind);
    if (panel) applyBox(panel, kind);
  }
  function expand(kind) {
    var current = (read()[kind] || {}).preset || "compact";
    var index = SIZES.indexOf(current);
    if (index < 0) index = 0;
    applyPreset(kind, SIZES[Math.min(SIZES.length - 1, index + 1)]);
  }
  function onResizeDown(event) {
    if (event.button != null && event.button !== 0) return;
    var grip = event.currentTarget;
    var panel = grip.closest(".xdock-panel");
    var kind = panel.getAttribute("data-panel");
    var box = boxFor(kind);
    var startX = event.clientX;
    var startY = event.clientY;
    var side = read().side === "left" ? "left" : "right";
    panel.classList.add("is-dragging");
    function move(e) {
      var dw = side === "right" ? startX - e.clientX : e.clientX - startX;
      var dh = startY - e.clientY;
      var next = clampBox(box.w + dw, box.h + dh);
      panel.style.setProperty("--dock-w", next.w + "px");
      panel.style.setProperty("--dock-h", next.h + "px");
      panel._box = next;
    }
    function up() {
      panel.classList.remove("is-dragging");
      doc().removeEventListener("pointermove", move);
      doc().removeEventListener("pointerup", up);
      var next = panel._box || box;
      var prefs = read();
      prefs[kind] = { w: next.w, h: next.h, preset: "custom" };
      save(prefs);
    }
    doc().addEventListener("pointermove", move);
    doc().addEventListener("pointerup", up);
    event.preventDefault();
    event.stopPropagation();
  }
  var chatPaint = 0;
  function refreshChat() {
    if (chatPaint) return Promise.resolve();
    chatPaint += 1;
    try {
      fill("chat");
      if (ui.chatView === "thread") stickLog("chat");
    } finally {
      chatPaint -= 1;
    }
    return Promise.resolve();
  }
  function stickLog(kind) {
    var panel = panelEl(kind);
    var log = panel && panel.querySelector(".xdock-log");
    if (log) log.scrollTop = log.scrollHeight;
  }
  function createMemoryStore() {
    var chats = [];
    function order() {
      return chats.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    }
    return {
      list: function () { return Promise.resolve(order()); },
      get: function (id) { return Promise.resolve(chats.filter(function (row) { return row.id === id; })[0] || null); },
      save: function (chat) {
        chats = chats.filter(function (row) { return row.id !== chat.id; });
        chats.push(chat);
        chats = order();
        if (chats.length > 40) chats = chats.slice(0, 40);
        return Promise.resolve(chat);
      },
      remove: function (id) {
        chats = chats.filter(function (row) { return row.id !== id; });
        return Promise.resolve();
      }
    };
  }
  function memory() {
    if (!chatStore) chatStore = createMemoryStore();
    return chatStore;
  }
  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) { reject(new Error("no-idb")); return; }
      var req = root.indexedDB.open("viktorych-ai", 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains("chats")) db.createObjectStore("chats", { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbWrap() {
    function run(mode, fn) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction("chats", mode);
          var result = fn(tx.objectStore("chats"));
          result.onsuccess = function () { resolve(result.result); };
          result.onerror = function () { reject(result.error); };
        });
      });
    }
    return {
      list: function () {
        return run("readonly", function (store) { return store.getAll(); }).then(function (rows) {
          return (rows || []).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
        });
      },
      get: function (id) { return run("readonly", function (store) { return store.get(id); }); },
      save: function (chat) {
        return run("readwrite", function (store) { return store.put(chat); }).then(function () {
          return this.list();
        }.bind(this)).then(function (rows) {
          var extra = rows.slice(40);
          return Promise.all(extra.map(function (row) { return run("readwrite", function (store) { return store.delete(row.id); }); }));
        }.bind(this)).then(function () { return chat; });
      },
      remove: function (id) { return run("readwrite", function (store) { return store.delete(id); }); }
    };
  }
  function useIdb() {
    if (!root.indexedDB) return;
    var wrapped = idbWrap();
    wrapped.list().then(function () { chatStore = wrapped; loadAi(); }).catch(function () {});
  }
  function nid() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  var aiCache = null;
  function currentChat() { return aiCache; }
  function loadAi() {
    var id = read().aiChatId;
    if (!id) { aiCache = null; fill("ai"); return Promise.resolve(); }
    return memory().get(id).then(function (chat) {
      aiCache = chat;
      fill("ai");
    }).catch(function () { fill("ai"); });
  }
  function saveChat(chat) {
    aiCache = chat;
    return memory().save(chat).then(function (saved) {
      var prefs = read();
      prefs.aiChatId = saved.id;
      save(prefs);
      return saved;
    });
  }
  function newChat() {
    aiGen += 1;
    ui.aiView = "thread";
    ui.aiDraft = "";
    ui.attachments = [];
    var chat = { id: nid(), title: "", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    return saveChat(chat).then(function () { fill("ai"); });
  }
  function history() {
    return memory().list().then(function (rows) {
      ui.aiChats = rows;
      ui.aiView = "history";
      fill("ai");
    });
  }
  function streamInto(chat, msg, provider, historyRows) {
    var token = ++aiGen;
    var node = null;
    return Promise.resolve().then(function () {
      var panel = panelEl("ai");
      node = panel && panel.querySelector('[data-ai-msg="' + msg.id + '"] .xdock-ai-copy');
      var iter = provider.sendMessage(historyRows);
      var seq = iter && typeof iter[Symbol.asyncIterator] === "function" ? iter[Symbol.asyncIterator]() : null;
      function pull() {
        if (!seq || token !== aiGen) return Promise.resolve();
        return Promise.resolve(seq.next()).then(function (step) {
          if (!step || step.done || token !== aiGen) return;
          msg.text += String(step.value || "");
          if (node) node.textContent = msg.text;
          return pull();
        });
      }
      return pull();
    }).then(function () {
      if (token !== aiGen) return;
      msg.pending = false;
      chat.updatedAt = Date.now();
      return saveChat(chat).then(function () { fill("ai"); stickLog("ai"); });
    }).catch(function () {
      if (token !== aiGen) return;
      msg.pending = false;
      if (!msg.text) msg.text = tr("Could not finish that reply.");
      return saveChat(chat).then(function () { fill("ai"); });
    });
  }
  function sendAi(text, opts) {
    opts = opts || {};
    var provider = activeProvider();
    if (!provider) return Promise.resolve();
    var body = String(text == null ? ui.aiDraft : text).trim();
    var files = ui.attachments.slice();
    if (!opts.reuse && !body && !files.length) return Promise.resolve();
    if (!opts.reuse) {
      ui.aiDraft = "";
      ui.attachments = [];
    }
    var start = aiCache ? Promise.resolve(aiCache) : newChat().then(function () { return aiCache; });
    return start.then(function (chat) {
      if (!chat) return;
      if (!opts.reuse) {
        var user = { id: nid(), role: "user", text: body, createdAt: Date.now(), attachments: files };
        chat.messages = (chat.messages || []).concat([user]);
        if (!chat.title) chat.title = body.slice(0, 48) || AI_CONFIG.name;
      }
      var reply = { id: nid(), role: "assistant", text: "", createdAt: Date.now(), pending: true };
      chat.messages = (chat.messages || []).concat([reply]);
      chat.updatedAt = Date.now();
      ui.aiView = "thread";
      return saveChat(chat).then(function () {
        fill("ai");
        var box = panelEl("ai") && panelEl("ai").querySelector("textarea");
        if (box) box.value = "";
        var historyRows = chat.messages.filter(function (msg) { return msg !== reply; }).map(function (msg) {
          return { role: msg.role, text: msg.text, attachments: msg.attachments || [] };
        });
        return streamInto(chat, reply, provider, historyRows);
      });
    });
  }
  function readFiles(list) {
    var files = Array.prototype.slice.call(list || []).slice(0, 4 - ui.attachments.length);
    return Promise.all(files.map(function (file) {
      var item = { name: file.name, type: file.type, size: file.size };
      var textual = /^text\//.test(file.type || "") || /\.(txt|md|json|csv|js|css|html)$/i.test(file.name || "");
      if (!textual || !root.FileReader) return item;
      return new Promise(function (resolve) {
        var reader = new root.FileReader();
        reader.onload = function () {
          item.text = String(reader.result || "").slice(0, 8000);
          resolve(item);
        };
        reader.onerror = function () { resolve(item); };
        reader.readAsText(file.slice ? file.slice(0, 8000) : file);
      });
    })).then(function (rows) {
      ui.attachments = ui.attachments.concat(rows).slice(0, 4);
      fill("ai");
    });
  }

  function onKey(event) {
    if (event.key === "Enter" && event.target && event.target.getAttribute && event.target.getAttribute("data-compose")) {
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      sendAi();
      return;
    }
    if (event.key !== "Escape") return;
    if (ui.menu) {
      ui.menu = false;
      fill("chat");
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    var panel = event.target && event.target.closest ? event.target.closest(".xdock-panel.is-open") : null;
    if (!panel) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(panel.getAttribute("data-panel"), false, true);
  }
  function onInput(event) {
    var el = event.target;
    if (!el || !el.getAttribute) return;
    var search = el.getAttribute("data-dock-search");
    if (search) {
      if (search === "chat") ui.query = el.value;
      else ui.aiQuery = el.value;
      var log = el.closest(".xdock-body") && el.closest(".xdock-body").querySelector(".xdock-log");
      if (log) log.innerHTML = logHtml(search === "ai" ? "ai" : "chat");
      return;
    }
    if (el.getAttribute("data-compose") === "ai") ui.aiDraft = el.value;
    var send = el.closest(".xdock-compose") && el.closest(".xdock-compose").querySelector(".xdock-send");
    if (send) send.disabled = !String(el.value || "").trim();
  }
  function onClick(event) {
    if (event.target && event.target.closest && event.target.closest("a[href], input, textarea")) return;
    var el = event.target && event.target.closest ? event.target.closest("[data-dock]") : null;
    if (!el) return;
    var action = el.getAttribute("data-dock");
    var kind = el.getAttribute("data-panel") || activeKind;
    if (action === "resize" || action === "compose") return;
    if (action !== "collapse") event.stopPropagation();
    if (action === "toggle") toggle(kind);
    else if (action === "collapse") setOpen(kind, false, true);
    else if (action === "expand") expand(kind);
    else if (action === "menu") { ui.menu = !ui.menu; fill("chat"); }
    else if (action === "back") { ui.chatView = "list"; ui.menu = false; refreshChat(); }
    else if (action === "thread") {
      var prefs = read();
      prefs.chatThread = el.getAttribute("data-id") || "";
      save(prefs);
      ui.chatView = "thread";
      ui.menu = false;
      refreshChat();
    } else if (action === "ai-new") newChat();
    else if (action === "ai-history") history();
    else if (action === "ai-back") { ui.aiView = "thread"; loadAi(); }
    else if (action === "ai-open") {
      var id = el.getAttribute("data-id") || "";
      var prefsOpen = read();
      prefsOpen.aiChatId = id;
      save(prefsOpen);
      ui.aiView = "thread";
      loadAi();
    } else if (action === "ai-remove") {
      memory().remove(el.getAttribute("data-id") || "").then(history);
    } else if (action === "ai-send") sendAi();
    else if (action === "ai-chip") {
      var chip = el.getAttribute("data-chip");
      var chipText = chip === "summarize" ? tr("Summarize") : chip === "rewrite" ? tr("Rewrite") : chip === "translate" ? tr("Translate") : tr("Explain");
      sendAi(chipText);
    }
    else if (action === "ai-attach") {
      var input = panelEl("ai") && panelEl("ai").querySelector("[data-dock-file]");
      if (input) input.click();
    } else if (action === "ai-unfile") {
      ui.attachments.splice(Number(el.getAttribute("data-index")) || 0, 1);
      fill("ai");
    } else if (action === "ai-copy") {
      var chat = currentChat();
      var msg = chat && (chat.messages || []).filter(function (row) { return row.id === el.getAttribute("data-id"); })[0];
      var text = msg ? msg.text : "";
      var live = panelEl("ai") && panelEl("ai").querySelector(".xdock-live");
      var done = function () { if (live) live.textContent = tr("Copied"); };
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(text).then(done, done);
      else done();
    } else if (action === "ai-regen") {
      var again = currentChat();
      if (!again || !again.messages) return;
      var last = again.messages[again.messages.length - 1];
      if (last && last.role === "assistant") again.messages.pop();
      saveChat(again).then(function () { sendAi("", { reuse: true }); });
    }
  }
  // Alt+Shift+C and Alt+Shift+A are bound in keys.js; it calls this.
  function toggleShown(kind) {
    if (kind !== "chat" && kind !== "ai") return false;
    if (!shown(kind)) return false;
    toggle(kind);
    return true;
  }
  function boot() {
    var document = doc();
    if (!document || !document.body) return;
    paint(false);
    if (read().chatThread) ui.chatView = "thread";
    if (opened("chat")) refreshChat(true);
    if (opened("ai")) loadAi();
    useIdb();
    /* This file runs before the language packs, so the first paint is in
       English. Repaint once they land and on every later switch. */
    var langHooked = false;
    function hookLang() {
      if (langHooked || !root.SI18n || !root.SI18n.onChange) return;
      langHooked = true;
      root.SI18n.onChange(function () { paint(true, true); });
      paint(true, true);
    }
    hookLang();
    if (!langHooked && root.addEventListener) root.addEventListener("viktorych-late", hookLang);
    document.addEventListener("pointerdown", function (event) {
      if (!ui.menu) return;
      if (event.target && event.target.closest && event.target.closest(".xdock-menu, [data-dock='menu']")) return;
      ui.menu = false;
      fill("chat");
    });
    document.addEventListener("change", function (event) {
      var input = event.target;
      if (!input || !input.hasAttribute || !input.hasAttribute("data-dock-file")) return;
      readFiles(input.files);
      input.value = "";
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && opened("chat")) refreshChat(true);
    });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      if (document.hidden || !opened("chat")) return;
      refreshChat(true);
    }, 15000);
  }

  registerProvider({
    id: "echo",
    order: 100,
    available: function () { return demoOn(); },
    capabilities: function () { return { stream: true, attachments: true, local: true }; },
    sendMessage: async function* (history) {
      var last = history && history.length ? history[history.length - 1] : null;
      var text = last && last.text ? String(last.text) : "";
      var names = [];
      var files = (last && last.attachments) || [];
      var i;
      for (i = 0; i < files.length; i++) if (files[i] && files[i].name) names.push(files[i].name);
      var out = tr("Echo") + ": " + text;
      if (names.length) out += " (" + names.join(", ") + ")";
      var parts = out.split(/(\s+)/);
      for (i = 0; i < parts.length; i++) if (parts[i]) yield parts[i];
    }
  });

  root.ViktorychDock = {
    config: AI_CONFIG,
    presetSize: presetSize,
    clampBox: clampBox,
    renderHtml: renderHtml,
    settingsHtml: settingsHtml,
    registerProvider: registerProvider,
    activeProvider: activeProvider,
    demoOn: demoOn,
    createMemoryStore: createMemoryStore,
    setPref: setPref,
    toggle: toggleShown,
    replaceState: function (next) { save(normalize(next)); paint(true); },
    seedChat: function (mem) {
      var channels = (mem.conversations || []).map(function (row) {
        var peer = row.peer || {};
        return {
          id: row.id,
          name: peer.name || peer.handle || "",
          category: "",
          preview: (row.last && row.last.body) || "",
          author: ""
        };
      });
      var thread = {
        found: true,
        loading: false,
        name: mem.peer ? (mem.peer.name || mem.peer.handle || "") : "",
        messages: (mem.messages || []).map(function (msg) {
          return { id: msg.id, name: (mem.peer && (mem.peer.name || mem.peer.handle)) || "", body: msg.body || "" };
        })
      };
      root.FeedsDiscord = {
        inbox: function () { return { ready: true, channels: channels }; },
        thread: function () { return thread; }
      };
    },
    noteMessages: function () {
      if (opened("chat")) refreshChat();
    },
    setUi: function (next) {
      Object.keys(next || {}).forEach(function (key) { ui[key] = next[key]; });
    },
    debug: function () { return { chat: read(), ui: ui, chatMem: chatMem }; },
    mount: boot,
    paint: paint
  };

  if (doc() && doc().readyState === "loading") doc().addEventListener("DOMContentLoaded", boot);
  else if (doc()) boot();
})(typeof window !== "undefined" ? window : globalThis);
