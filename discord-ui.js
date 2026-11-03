/* X-styled Discord inbox. Text is escaped before it is inserted.
   Servers and channels come from the config. Nothing here is special to one server. */
(function (root) {

  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : ((typeof self !== "undefined" && self.t) ? self.t : null);
    return fn ? fn(key, vars) : key;
  }
  function trn(key, n, vars) {
    var fn = (typeof window !== "undefined" && window.tn) ? window.tn : ((typeof self !== "undefined" && self.tn) ? self.tn : null);
    return fn ? fn(key, n, vars) : String(n) + " " + key; // plain English when no language pack is loaded
  }
  function productName(kind) {
    var api = (typeof SI18n !== "undefined") ? SI18n : ((typeof window !== "undefined" && window.SI18n) ? window.SI18n : ((typeof self !== "undefined" && self.SI18n) ? self.SI18n : null));
    return (api && api.productName) ? api.productName(kind) : "";
  }

  const TOPIC = "superintelmusic-discord-th-7f3a91c2";
  const SEEN_KEY = "viktorychapp-discord-seen-v1";
  const PREFS_KEY = "viktorychapp-discord-prefs-v1";
  const SCROLL_KEY = "viktorychapp-discord-scroll-v1";
  const INDEX_KEY = "viktorychapp-discord-index-v1";
  const DOC_DB = "viktorych-discord";
  const DOC_STORE = "docs";

  function readStore(store, name) {
    try {
      const current = store.getItem(name);
      if (current != null) return current;
      const legacy = store.getItem(String(name).replace("viktorychapp-", "superintelapp-"));
      const previous = legacy != null ? legacy : store.getItem(String(name).replace("viktorychapp-", "rss-" + "feeds-"));
      if (previous != null) {
        try { store.setItem(name, previous); } catch (err) { /* private mode can refuse */ }
        return previous;
      }
    } catch (err) { /* private mode can refuse */ }
    return null;
  }

  function readLocal(name) {
    return readStore(localStorage, name);
  }
  const WINDOW = 300;
  const CATALOG_SERVERS = [
    {
      id: "100000000000000355",
      name: "Discord Town Hall",
      channels: [
        { id: "0100000000000000372", name: "rules", category: tr("Information"), mode: "messages" },
        { id: "100000000000000389", name: "support", category: tr("Information"), mode: "messages" },
        { id: "0100000000000000406", name: "account-safety", category: tr("Information"), mode: "messages" },
        { id: "0100000000000000423", name: "wellbeing-resources", category: tr("Information"), mode: "messages" },
        { id: "100000000000000440", name: "product-updates", category: "Announcements", mode: "posts" },
        { id: "100000000000000457", name: "discord-updates", category: "Announcements", mode: "posts" },
        { id: "0100000000000000474", name: "collab-announcements", category: "Announcements", mode: "posts" },
        { id: "0100000000000000491", name: "drops-and-deals", category: "Announcements", mode: "posts" },
        { id: "0100000000000000508", name: "wellbeing-bulletin", category: "Announcements", mode: "posts" },
        { id: "100000000000000355", name: "general-chat", category: "Town Hall General", mode: "messages" },
        { id: "0100000000000000576", name: "discord-discussion", category: "Town Hall General", mode: "messages" },
        { id: "100000000000000593", name: "peer-help", category: "Town Hall General", mode: "messages" },
        { id: "0100000000000000610", name: "profile-aesthetic", category: "Community Fun", mode: "messages" },
        { id: "0100000000000000627", name: "community-polls", category: "Community Fun", mode: "messages" },
        { id: "0100000000000000644", name: "fun-apps", category: "Community Fun", mode: "messages" },
        { id: "0100000000000000661", name: "giveaway-corner", category: "Community Fun", mode: "messages" }
      ]
    }
  ];

  const FIXTURE = {
    "100000000000000355": [
      msg("1530000000000000001", "1001", "Ada", "#5865f2", "0", "2026-10-21T16:40:00.000Z", "Welcome in. The **rules** channel is the place to start."),
      msg("1530000000000000002", "1002", "Wumpus", "#eb459e", "1", "2026-10-21T16:41:00.000Z", "Hello @Ada — glad you are here. Peek at ||the spoiler|| and `town-hall`."),
      msg("1530000000000000003", "1002", "Wumpus", "#eb459e", "1", "2026-10-21T16:42:00.000Z", "Same note, still me. *Town Hall* stays read-only on this page."),
      Object.assign(msg("1530000000000000004", "1003", "Clyde", "#57f287", "2", "2026-10-21T16:48:00.000Z", "Replying with a photo, a custom :wave:, and a link https://discord.com/safety plus <script>alert(1)</script>"), {
        replyId: "1530000000000000002",
        replyName: "Wumpus",
        replyText: "Hello @Ada — glad you are here.",
        attachments: [{ type: "photo", url: "https://cdn.discordapp.com/embed/avatars/2.png", w: 128, h: 128, alt: "Clyde" }],
        emojis: [{ name: "wave", url: "https://cdn.discordapp.com/embed/avatars/4.png" }],
        embeds: [{ url: "https://discord.com/safety", title: "Discord Safety", description: "A short **guide** for new members.", image: "https://cdn.discordapp.com/embed/avatars/0.png", site: "discord.com" }],
        reactions: [{ e: "👍", n: 4 }, { e: "💙", n: 2 }]
      })
    ],
    "100000000000000593": [
      msg("1530000000000000101", "1001", "Ada", "#5865f2", "0", "2026-10-21T15:05:00.000Z", "Has anyone tried the new profile layout?")
    ]
  };

  const FIXTURE_PINS = {
    "100000000000000355": [
      { id: "1530000000000000004", author: "Clyde", text: "Replying with a photo, a custom wave, and a link", date: "2026-10-21T16:48:00.000Z" },
      { id: "1530000000000000001", author: "Ada", text: "Welcome in. The rules channel is the place to start.", date: "2026-10-21T16:40:00.000Z" }
    ]
  };

  const MUTE_CHOICES = [
    { label: tr("For 15 minutes"), ms: 15 * 60 * 1000 },
    { label: tr("For 1 hour"), ms: 60 * 60 * 1000 },
    { label: tr("For 8 hours"), ms: 8 * 60 * 60 * 1000 },
    { label: tr("For 24 hours"), ms: 24 * 60 * 60 * 1000 },
    { label: tr("Until I turn it back on"), ms: 0 }
  ];

  function msg(id, authorId, name, color, avatarIndex, date, body) {
    return {
      id: id,
      authorId: authorId,
      name: name,
      avatar: "https://cdn.discordapp.com/embed/avatars/" + avatarIndex + ".png",
      color: color,
      body: body,
      date: date,
      replyId: "",
      replyName: "",
      replyText: "",
      attachments: [],
      embeds: [],
      emojis: [],
      reactions: [],
      edited: false
    };
  }

  const state = {
    filter: "",
    servers: [],
    channels: [],
    serverName: "",
    icon: "",
    paused: false,
    topic: "",
    prefs: null,
    files: {},
    loading: {},
    live: {},
    deleted: {},
    query: "",
    open: "",
    stick: true,
    fixture: false,
    since: "",
    backoff: 1500,
    source: null,
    timer: 0,
    loadStarted: false,
    catalogReady: false,
    started: false,
    bound: null,
    pinFiles: {},
    pinLoading: {},
    menu: null,
    pinsOpen: "",
    jump: "",
    muteTimer: 0,
    hold: 0,
    suppressClick: "",
    listHold: null,
    winHold: null,
    scrollLock: false,
    holding: false,
    olderNext: {},
    olderLoading: {},
    olderGot: {},
    net: {},
    warmed: false,
    paceUntil: 0
  };

  function copyChannel(ch, serverId, picked) {
    return {
      id: ch.id,
      name: ch.name,
      category: ch.category || "",
      mode: ch.mode,
      serverId: serverId,
      inaccessible: false,
      pinsForbidden: !!picked,
      picked: !!picked,
      file: ch.mode === "messages" ? (picked ? "discord/x/messages/" : "discord/messages/") + ch.id + ".json" : ""
    };
  }

  function adoptServers(list) {
    const servers = [];
    const channels = [];
    (list || []).forEach(function (server) {
      const id = snowflake(server && (server.id || server.guild));
      if (!id) return;
      const rows = [];
      (server.channels || []).forEach(function (ch) {
        const cid = snowflake(ch && ch.id);
        const mode = ch && (ch.mode === "posts" || ch.mode === "messages") ? ch.mode : "";
        if (!cid || !mode) return;
        const row = copyChannel({
          id: cid,
          name: String(ch.name || cid).slice(0, 80),
          category: String(ch.category || "").slice(0, 80),
          mode: mode
        }, id, !!server.picked);
        if (server.picked && ch.inaccessible) row.inaccessible = true;
        rows.push(row);
        channels.push(row);
      });
      if (!rows.length) return;
      servers.push({
        id: id,
        name: String(server.name || id).slice(0, 80),
        icon: cdnUrl(server.icon) || "",
        picked: !!server.picked,
        channels: rows
      });
    });
    if (!servers.length) return false;
    state.servers = servers;
    state.channels = channels;
    state.serverName = servers[0].name;
    state.icon = servers[0].icon || "";
    return true;
  }

  function hooks() { return state.bound || {}; }

  function noteShared() {
    const dock = root.ViktorychDock;
    if (dock && dock.noteMessages) dock.noteMessages();
    noteAlerts();
  }

  function paced() {
    return !!(state.paceUntil && Date.now() < state.paceUntil);
  }

  function noteRate(res) {
    if (res && res.status === 429) state.paceUntil = Date.now() + 60000;
    return res;
  }

  function alertSnapshot() {
    if (state.fixture) return { messages: [], mutedChannels: [], mutedServers: [] };
    const stored = prefs();
    const mutedChannels = [];
    const mutedServers = (stored.mutedServers || []).slice(0, 50);
    (state.channels || []).forEach(function (ch) {
      if (!ch || ch.mode !== "messages" || !channelMuted(ch)) return;
      if (mutedChannels.indexOf(ch.id) < 0) mutedChannels.push(ch.id);
    });
    (stored.mutedChannels || []).forEach(function (id) {
      if (id && mutedChannels.indexOf(id) < 0) mutedChannels.push(id);
    });
    const messages = [];
    const seen = {};
    (state.channels || []).forEach(function (ch) {
      if (!ch || ch.mode !== "messages" || channelMuted(ch)) return;
      messagesFor(ch.id).slice(0, 8).forEach(function (row) {
        if (!row || !row.id || seen[row.id] || messages.length >= 40) return;
        seen[row.id] = true;
        messages.push({
          id: String(row.id),
          content: String(row.body || "").slice(0, 500),
          authorId: String(row.authorId || ""),
          channelId: String(ch.id),
          serverId: String(ch.serverId || ""),
          authorName: String(row.name || "").slice(0, 80)
        });
      });
    });
    const privateChannels = (stored.privateChannels || []).slice(0, 200);
    return { messages: messages, mutedChannels: mutedChannels.slice(0, 200), mutedServers: mutedServers, privateChannels: privateChannels };
  }

  function noteAlerts() {
    if (state.fixture) return;
    const hook = hooks().onDiscordMessages;
    if (typeof hook !== "function") return;
    const snap = alertSnapshot();
    if (!snap.messages.length) return;
    try { hook(snap); }
    catch (err) { /* the next loaded batch tries again */ }
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function cdnUrl(url) {
    const text = String(url || "");
    if (!text || text.length > 500 || /[\s<>"'\\]/.test(text)) return "";
    if (!/^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net|(?:[a-z0-9-]+\.)*(?:userapi\.com|vkuserphoto\.ru|vk-cdn\.net|vk\.com|vk\.ru))\//.test(text)) return "";
    return text;
  }

  function httpUrl(url) {
    const text = String(url || "");
    if (!text || text.length > 500 || /[\s<>"']/.test(text)) return "";
    if (!/^https?:\/\//i.test(text)) return "";
    return text;
  }

  function hexColor(value) {
    const text = String(value || "").trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : "";
  }

  function dim(value) {
    const n = Math.round(Number(value));
    if (!isFinite(n) || n <= 0 || n >= 10000) return 0;
    return n;
  }

  function snowflake(value) {
    const text = String(value || "");
    return /^\d{1,22}$/.test(text) ? text : "";
  }

  function cmpId(a, b) {
    const as = String(a || "");
    const bs = String(b || "");
    if (as.length !== bs.length) return as.length < bs.length ? -1 : 1;
    if (as < bs) return -1;
    if (as > bs) return 1;
    return 0;
  }

  function snowflakeMs(id) {
    try { return Number((BigInt(id) >> 22n) + 1420070400000n); }
    catch (err) { return 0; }
  }

  function msgTime(row) {
    const parsed = Date.parse(row && row.date || "");
    if (parsed) return parsed;
    return snowflakeMs(row && row.id);
  }

  function dayKey(row) {
    const ms = msgTime(row);
    if (!ms) return "";
    const date = new Date(ms);
    return date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate();
  }

  function formatClock(row) {
    const ms = msgTime(row);
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat((window.SI18n ? window.SI18n.locale() : undefined), { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
    } catch (err) {
      return "";
    }
  }

  function formatDay(row) {
    const ms = msgTime(row);
    if (!ms) return "";
    try {
      return new Intl.DateTimeFormat((window.SI18n ? window.SI18n.locale() : undefined), { month: "long", day: "numeric", year: "numeric" }).format(new Date(ms));
    } catch (err) {
      return "";
    }
  }

  function channelById(id) {
    const key = String(id || "");
    for (let i = 0; i < state.channels.length; i++) {
      if (state.channels[i].id === key) return state.channels[i];
    }
    return null;
  }

  function knownMap() {
    const map = {};
    const list = state.channels.length ? state.channels : CATALOG_SERVERS.reduce(function (all, server) {
      (server.channels || []).forEach(function (ch) { all.push(copyChannel(ch, server.id)); });
      return all;
    }, []);
    list.forEach(function (ch) { map[ch.id] = ch; });
    return map;
  }

  function format(raw, emojis) {
    const blocks = [];
    function hold(html) {
      const token = "\u0000" + blocks.length + "\u0000";
      blocks.push(html);
      return token;
    }
    let text = String(raw || "").replace(/\u0000/g, "").slice(0, 4000);
    text = text.replace(/<(a?):([A-Za-z0-9_]{2,32}):(\d{1,22})>/g, function (_m, anim, name, id) {
      const ext = anim === "a" ? "gif" : "png";
      return hold('<img class="dmsg-emoji" alt=":' + esc(name) + ':" src="https://cdn.discordapp.com/emojis/' + id + "." + ext + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">');
    });
    text = text.replace(/```([\s\S]*?)```/g, function (_m, code) {
      return hold('<pre class="dmsg-code">' + esc(code) + "</pre>");
    });
    text = text.replace(/`([^`\n]+)`/g, function (_m, code) {
      return hold("<code>" + esc(code) + "</code>");
    });
    text = esc(text);
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)&]+)\)/g, function (whole, label, url) {
      const href = httpUrl(url.replace(/&amp;/g, "&"));
      if (!href) return whole;
      return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });
    text = linkifyOutside(text);
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).!?,:]|$)/g, "$1<em>$2</em>");
    text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).!?,:]|$)/g, "$1<em>$2</em>");
    text = text.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="dmsg-spoiler" data-act="spoiler" role="button" tabindex="0">$1</span>');
    text = text.replace(/(^|[\s(])@([A-Za-z0-9_.]{1,32})/g, '$1<span class="dmsg-mention">@$2</span>');
    text = text.replace(/\u0000(\d+)\u0000/g, function (_m, index) {
      return blocks[Number(index)] || "";
    });
    return applyEmoji(text, emojis);
  }

  function linkifyOutside(html) {
    const parts = String(html || "").split(/(<[^>]+>)/);
    return parts.map(function (part) {
      if (!part || part.charAt(0) === "<") return part;
      return part.replace(/https?:\/\/[^\s<&]+/g, function (url) {
        let bare = url.replace(/&amp;/g, "&");
        let extra = "";
        while (bare && /[),.;!?]$/.test(bare)) {
          extra = bare.slice(-1) + extra;
          bare = bare.slice(0, -1);
        }
        const href = httpUrl(bare);
        if (!href) return url;
        return '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(href) + "</a>" + esc(extra);
      });
    }).join("");
  }

  function applyEmoji(html, emojis) {
    const map = {};
    (emojis || []).forEach(function (emoji) {
      const url = cdnUrl(emoji && emoji.url);
      const name = emoji && /^[A-Za-z0-9_]{2,32}$/.test(emoji.name) ? emoji.name : "";
      if (url && name) map[name] = url;
    });
    if (!Object.keys(map).length) return html;
    const parts = html.split(/(<\/?(?:code|pre)[^>]*>)/);
    let inCode = 0;
    return parts.map(function (part) {
      if (part.indexOf("<code") === 0 || part.indexOf("<pre") === 0) { inCode += 1; return part; }
      if (part.indexOf("</code") === 0 || part.indexOf("</pre") === 0) { inCode = Math.max(0, inCode - 1); return part; }
      if (inCode) return part;
      return part.replace(/:([A-Za-z0-9_]{2,32}):/g, function (whole, name) {
        if (!map[name]) return whole;
        return '<img class="dmsg-emoji" alt=":' + esc(name) + ':" src="' + esc(map[name]) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
      });
    }).join("");
  }

  function fromFile(row, authors) {
    const author = (authors && authors[row.author]) || {};
    const attachments = [];
    (row.attachments || []).forEach(function (item) {
      const url = cdnUrl(item && item.url);
      if (!url) return;
      attachments.push({
        type: item.type === "video" ? "video" : "photo",
        url: url,
        w: dim(item.width),
        h: dim(item.height),
        alt: String(item.alt || "").slice(0, 180)
      });
    });
    const reactions = [];
    (row.reactions || []).forEach(function (item) {
      if (!item) return;
      const e = String(item.emoji || item.e || "").slice(0, 32);
      const n = Math.round(Number(item.count || item.n) || 0);
      if (!e || n <= 0 || /[<>]/.test(e)) return;
      reactions.push({ e: e, n: n, url: cdnUrl(item.url) });
    });
    return {
      id: String(row.id),
      authorId: String(row.author || ""),
      name: String(author.name || tr("Unknown")).slice(0, 80),
      avatar: cdnUrl(author.avatar),
      color: hexColor(author.color),
      body: String(row.content || row.text || ""),
      date: String(row.date || ""),
      replyId: String(row.reply || ""),
      replyName: String(row.replyAuthor || ""),
      replyText: String(row.replyText || ""),
      attachments: attachments,
      embeds: Array.isArray(row.cards) ? row.cards : [],
      emojis: Array.isArray(row.emojis) ? row.emojis : [],
      reactions: reactions,
      edited: !!row.edited,
      publicId: /^\d{12}$/.test(String(row.publicId || row.public_id || "")) ? String(row.publicId || row.public_id) : ""
    };
  }

  function fromLive(m) {
    return {
      id: m.id,
      authorId: m.author.id,
      name: m.author.name || tr("Someone"),
      avatar: m.author.avatar || "",
      color: hexColor(m.author.color),
      body: m.content || "",
      date: m.ts && Date.parse(m.ts) ? m.ts : "",
      replyId: m.reply ? m.reply.id : "",
      replyName: m.reply ? m.reply.author : "",
      replyText: m.reply ? m.reply.content : "",
      attachments: m.att || [],
      embeds: m.emb || [],
      emojis: [],
      reactions: m.rx || [],
      publicId: /^\d{12}$/.test(String((m.author && (m.author.publicId || m.author.public_id)) || m.publicId || "")) ? String((m.author && (m.author.publicId || m.author.public_id)) || m.publicId) : "",
      edited: !!m.edited
    };
  }

  function messagesFor(channelId) {
    const gone = state.deleted[channelId] || {};
    const map = new Map();
    if (state.fixture && FIXTURE[channelId]) {
      FIXTURE[channelId].forEach(function (row) {
        if (!gone[row.id]) map.set(row.id, row);
      });
    } else {
      const file = state.files[channelId];
      const authors = file && file.authors || {};
      const rows = file && Array.isArray(file.messages) ? file.messages : [];
      rows.forEach(function (row) {
        if (!row || !snowflake(row.id) || gone[row.id]) return;
        map.set(String(row.id), fromFile(row, authors));
      });
    }
    (state.live[channelId] || []).forEach(function (row) {
      if (!gone[row.id]) map.set(row.id, row);
    });
    const all = Array.from(map.values());
    all.sort(function (a, b) { return cmpId(b.id, a.id); });
    return all.slice(0, WINDOW);
  }

  function validate(body, known) {
    if (!body || typeof body !== "object" || body.v !== 1) return null;
    const ch = snowflake(body.ch);
    if (!ch || !known || !known[ch]) return null;
    if (body.del != null && body.m == null) {
      const id = snowflake(body.del);
      if (!id) return null;
      return { ch: ch, del: id };
    }
    const m = body.m;
    if (!m || typeof m !== "object" || Array.isArray(m)) return null;
    const id = snowflake(m.id);
    if (!id) return null;
    if (typeof m.content !== "string" && m.content != null) return null;
    const content = String(m.content || "");
    if (content.length > 4000) return null;
    const author = m.author && typeof m.author === "object" ? m.author : {};
    const aid = String(author.id || "");
    if (aid && !snowflake(aid)) return null;
    const name = String(author.name || tr("Someone")).replace(/\u0000/g, "").slice(0, 80);
    const att = [];
    (Array.isArray(m.att) ? m.att.slice(0, 8) : []).forEach(function (item) {
      if (!item || typeof item !== "object") return;
      const url = cdnUrl(item.url);
      if (!url) return;
      const type = item.type === "video" || /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url) ? "video" : "photo";
      att.push({ url: url, type: type, w: dim(item.w), h: dim(item.h), alt: "" });
    });
    const emb = [];
    (Array.isArray(m.emb) ? m.emb.slice(0, 4) : []).forEach(function (item) {
      if (!item || typeof item !== "object") return;
      const image = cdnUrl(typeof item.image === "string" ? item.image : (item.image && item.image.url) || "");
      const url = httpUrl(item.url || "");
      const title = String(item.title || "").slice(0, 200);
      const description = String(item.description || item.desc || "").slice(0, 1000);
      if (!title && !description && !image) return;
      emb.push({ url: url, title: title, description: description, image: image, site: String(item.site || "").slice(0, 80) });
    });
    const rx = [];
    (Array.isArray(m.rx) ? m.rx.slice(0, 20) : []).forEach(function (item) {
      if (!item || typeof item !== "object") return;
      const e = String(item.e || "").slice(0, 32);
      const n = Number(item.n);
      if (!e || /[<>]/.test(e) || !isFinite(n) || n <= 0 || n > 1000000) return;
      rx.push({ e: e, n: Math.round(n), url: "" });
    });
    let reply = null;
    if (m.reply && typeof m.reply === "object") {
      const rid = snowflake(m.reply.id);
      if (rid) reply = { id: rid, author: String(m.reply.author || "").slice(0, 80), content: String(m.reply.content || "").slice(0, 200) };
    }
    const ts = typeof m.ts === "string" ? m.ts.slice(0, 40) : "";
    return {
      ch: ch,
      m: {
        id: id,
        ts: ts,
        edited: !!m.edited,
        author: { id: aid, name: name, avatar: author.avatar ? cdnUrl(author.avatar) : "", color: hexColor(author.color) },
        content: content,
        reply: reply,
        att: att,
        emb: emb,
        rx: rx
      }
    };
  }

  function accept(body) {
    const parsed = validate(body, knownMap());
    if (!parsed) return false;
    const ch = parsed.ch;
    const channel = knownMap()[ch];
    if (parsed.del) {
      if (!channel || channel.mode !== "messages") return true;
      state.deleted[ch] = state.deleted[ch] || {};
      state.deleted[ch][parsed.del] = true;
      state.live[ch] = (state.live[ch] || []).filter(function (row) { return row.id !== parsed.del; });
      return true;
    }
    if (!channel || channel.mode !== "messages") return true;
    const row = fromLive(parsed.m);
    if (!row.date) {
      const ms = snowflakeMs(row.id);
      if (ms) row.date = new Date(ms).toISOString();
    }
    const rows = state.live[ch] || [];
    const at = rows.findIndex(function (item) { return item.id === row.id; });
    if (at >= 0) rows[at] = row;
    else rows.push(row);
    rows.sort(function (a, b) { return cmpId(b.id, a.id); });
    state.live[ch] = rows.slice(0, WINDOW);
    return true;
  }

  function deliver(body) {
    const parsed = validate(body, knownMap());
    if (!parsed || !accept(body)) return;
    if (typeof document === "undefined") return;
    const ch = channelById(parsed.ch);
    const quiet = !!(ch && channelMuted(ch));
    rememberList();
    const log = document.querySelector(".dmsgs-log");
    if (log && state.open === parsed.ch) repaintLog();
    else if (!quiet) updateDots();
    if (!quiet) paintNavBadge();
    restoreList();
    noteShared();
  }

  function quote(text) {
    return esc(String(text || "").replace(/[*_`|]/g, "").replace(/\s+/g, " ").trim().slice(0, 140));
  }

  function replyHtml(row, byId) {
    if (!row.replyId && !row.replyText) return "";
    const parent = byId.get(row.replyId);
    const name = row.replyName || (parent && parent.name) || "message";
    const text = row.replyText || (parent && parent.body) || "";
    return '<div class="dmsg-reply"><span class="dmsg-reply-name">' + esc(name) + '</span><span class="dmsg-reply-text">' + quote(text) + "</span></div>";
  }

  function faceMode(src) {
    const root = typeof window === "undefined" ? null : window;
    const faces = root && root.ViktorychFaces;
    return faces && faces.picture ? faces.picture(src) : (src ? "photo" : "default");
  }

  function silhouetteHtml(cls) {
    return '<span class="' + cls + ' silhouette" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v1h16v-1c0-2.66-5.33-4-8-4z"/></svg></span>';
  }

  function avatarHtml(row) {
    const mode = faceMode(row.avatar);
    let html = "";
    if (mode === "none") html = '<span class="ava-none"></span>';
    else if (mode === "default" || !row.avatar) html = silhouetteHtml("dmsg-ava ava");
    else html = '<img class="dmsg-ava" src="' + esc(row.avatar) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">';
    if (row.publicId && window.ViktorychPresence) return window.ViktorychPresence.wrap(row.publicId, html);
    return html;
  }

  function mediaHtml(row) {
    return (row.attachments || []).map(function (item) {
      const url = cdnUrl(item.url);
      if (!url) return "";
      const dims = (item.w ? ' width="' + item.w + '"' : "") + (item.h ? ' height="' + item.h + '"' : "");
      if (item.type === "video") {
        return '<video class="dmsg-video" controls preload="none" src="' + esc(url) + '"' + dims + "></video>";
      }
      const alt = esc(item.alt || "");
      return '<a class="dmsg-shot" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"><img src="' + esc(url) + '" alt="' + alt + '"' + dims + ' loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>';
    }).join("");
  }

  function embedHtml(row) {
    return (row.embeds || []).slice(0, 4).map(function (card) {
      if (!card || typeof card !== "object") return "";
      const href = httpUrl(card.url);
      const image = cdnUrl(typeof card.image === "string" ? card.image : "");
      const title = esc(String(card.title || "").slice(0, 200));
      const desc = format(String(card.description || "").slice(0, 1000));
      const site = esc(String(card.site || "").slice(0, 80));
      if (!title && !desc && !image) return "";
      const titleHtml = title ? (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + title + "</a>" : title) : "";
      return '<div class="dmsg-embed">' +
        (site ? '<div class="dmsg-embed-site">' + site + "</div>" : "") +
        (titleHtml ? '<div class="dmsg-embed-title">' + titleHtml + "</div>" : "") +
        (desc ? '<div class="dmsg-embed-desc">' + desc + "</div>" : "") +
        (image ? '<img src="' + esc(image) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : "") +
        "</div>";
    }).join("");
  }

  function reactionHtml(row) {
    const pills = (row.reactions || []).slice(0, 20).map(function (rx) {
      const face = rx.url ? '<img src="' + esc(rx.url) + '" alt="' + esc(rx.e) + '" loading="lazy" decoding="async">' : esc(rx.e);
      return '<span class="dmsg-rx">' + face + "<span>" + esc(String(rx.n)) + "</span></span>";
    }).join("");
    return pills ? '<div class="dmsg-rxs">' + pills + "</div>" : "";
  }

  function logInner(channelId) {
    const rows = messagesFor(channelId).slice().reverse();
    if (!rows.length) {
      const waiting = state.loading[channelId] && !state.fixture;
      if (waiting) {
        return '<div class="dmsgs-skel" aria-busy="true" aria-label="' + esc(tr("Loading messages")) + '"><span></span><span></span><span></span><span></span></div>';
      }
      const title = state.paused ? tr("Discord paused") : tr("No messages yet");
      const body = state.paused ? tr("Saved messages stay here. New reads wait until the account can see the server again.") : tr("The next sync reads the latest 50. This view keeps a rolling window of 300.");
      return '<div class="dmsgs-placeholder"><h2>' + title + "</h2><p>" + esc(body) + "</p></div>";
    }
    const byId = new Map();
    rows.forEach(function (row) { byId.set(row.id, row); });
    let prev = null;
    let faceOff = false;
    return rows.map(function (row) {
      const fresh = !prev || prev.authorId !== row.authorId || row.replyId || (msgTime(row) - msgTime(prev) > 7 * 60 * 1000) || dayKey(prev) !== dayKey(row);
      if (fresh) faceOff = faceMode(row.avatar) === "none";
      const showDay = !prev || dayKey(prev) !== dayKey(row);
      const day = showDay ? '<div class="dmsg-day"><span>' + esc(formatDay(row)) + "</span></div>" : "";
      const color = hexColor(row.color);
      const head = fresh
        ? '<div class="dmsg-head"><span class="dmsg-name"' + (color ? ' style="color:' + color + '"' : "") + ">" + esc(row.authorId && (typeof window !== "undefined" ? window.ViktorychNick : null) ? window.ViktorychNick.name("discord", String(row.authorId), row.name) : row.name) + '</span><time datetime="' + esc(row.date) + '">' + esc(formatClock(row)) + "</time></div>"
        : "";
      const gutter = fresh ? avatarHtml(row) : "";
      prev = row;
      const ai = root.ViktorychOnDeviceAi;
      const deco = ai && ai.decorate ? ai.decorate(row.body || "", "dm") : null;
      const bubble = deco && deco.hidden
        ? deco.html
        : format(row.body, row.emojis) + (row.edited ? (" <span class=\"dmsg-edited\"" + ">" + tr("(edited)") + "<" + "/span>") : "") + (deco && deco.tools ? deco.tools : "");
      return day + '<article class="dmsg' + (fresh ? " group" : " cont") + (faceOff ? " no-face" : "") + '" data-mid="' + esc(row.id) + '"><div class="dmsg-gutter">' + gutter + "</div>" +
        '<div class="dmsg-body">' + head + replyHtml(row, byId) +
        '<div class="dmsg-bubble"><div class="dmsg-text">' + bubble + "</div>" +
        mediaHtml(row) + embedHtml(row) + reactionHtml(row) +
        "</div></div></article>";
    }).join("");
  }

  function seenMap() {
    try {
      const raw = JSON.parse(readLocal(SEEN_KEY) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function markSeen(id) {
    const rows = messagesFor(id);
    if (!rows.length) return;
    const map = seenMap();
    map[id] = rows[0].id;
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)); } catch (err) { /* private mode can refuse */ }
  }

  function isUnread(id, route) {
    if (route && route.channel === id) return false;
    const rows = messagesFor(id);
    if (!rows.length) return false;
    return cmpId(rows[0].id, seenMap()[id] || "") > 0;
  }

  // Inbox filter chip (?f=discord) and the test fixture flag ride along.
  function hrefQuery() {
    const parts = [];
    if (state.fixture) parts.push("fixture=1");
    if (state.filter === "discord") parts.push("f=discord");
    return parts.length ? "?" + parts.join("&") : "";
  }

  function readFilter(route) {
    const f = route && route.query && typeof route.query.get === "function" ? String(route.query.get("f") || "") : "";
    return f === "discord" || f === "servers" ? f : "";
  }

  function listHref() {
    return "#/messages" + hrefQuery();
  }

  function channelHref(id) {
    return "#/messages/discord/" + encodeURIComponent(id) + hrefQuery();
  }

  function emptyPrefs() {
    return { expanded: {}, pinnedServers: [], pinnedChannels: [], mutedServers: [], mutedChannels: [], mutes: {}, hiddenServers: [], hiddenChannels: [], serverRank: [], privateChannels: [] };
  }

  function cleanIds(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(function (id) {
      const key = snowflake(id);
      if (key && out.indexOf(key) < 0) out.push(key);
    });
    return out.slice(0, 200);
  }

  function loadPrefs() {
    const empty = emptyPrefs();
    try {
      const raw = JSON.parse(readLocal(PREFS_KEY) || "null");
      if (!raw || typeof raw !== "object") return empty;
      const expanded = {};
      if (raw.expanded && typeof raw.expanded === "object") {
        Object.keys(raw.expanded).forEach(function (key) {
          const id = snowflake(key);
          if (id && raw.expanded[key]) expanded[id] = true;
        });
      }
      const mutes = {};
      if (raw.mutes && typeof raw.mutes === "object") {
        Object.keys(raw.mutes).forEach(function (key) {
          const id = snowflake(key);
          const until = Number(raw.mutes[key]);
          if (id && (until === 0 || (isFinite(until) && until > Date.now()))) mutes[id] = until === 0 ? 0 : until;
        });
      }
      cleanIds(raw.mutedChannels).forEach(function (id) {
        if (!Object.prototype.hasOwnProperty.call(mutes, id)) mutes[id] = 0;
      });
      return {
        expanded: expanded,
        pinnedServers: cleanIds(raw.pinnedServers),
        pinnedChannels: cleanIds(raw.pinnedChannels),
        mutedServers: cleanIds(raw.mutedServers),
        mutedChannels: cleanIds(raw.mutedChannels),
        mutes: mutes,
        hiddenServers: cleanIds(raw.hiddenServers),
        hiddenChannels: cleanIds(raw.hiddenChannels),
        serverRank: cleanIds(raw.serverRank),
        privateChannels: cleanIds(raw.privateChannels)
      };
    } catch (err) {
      return empty;
    }
  }

  function prefs() {
    if (!state.prefs) state.prefs = loadPrefs();
    return state.prefs;
  }

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs())); } catch (err) { /* private mode can refuse */ }
  }

  function hasId(list, id) {
    return (list || []).indexOf(id) >= 0;
  }

  function toggleId(list, id) {
    const at = list.indexOf(id);
    if (at >= 0) list.splice(at, 1);
    else list.unshift(id);
  }

  function serverById(id) {
    const key = String(id || "");
    for (let i = 0; i < state.servers.length; i++) {
      if (state.servers[i].id === key) return state.servers[i];
    }
    return null;
  }

  function serverMuted(id) { return hasId(prefs().mutedServers, id); }

  /* Local-only layout: hidden servers and channels, a hand-picked server
     order, and channels whose text never shows in previews or alerts. */
  function serverHidden(id) { return hasId(prefs().hiddenServers, id); }
  function channelHidden(id) { return hasId(prefs().hiddenChannels, id); }
  function channelPrivate(id) { return hasId(prefs().privateChannels, id); }
  function listFor(key) {
    const stored = prefs();
    if (!Array.isArray(stored[key])) stored[key] = [];
    return stored[key];
  }
  function rankedServers() {
    const rank = prefs().serverRank || [];
    const at = function (id) { const i = rank.indexOf(id); return i < 0 ? rank.length : i; };
    return state.servers.map(function (server, i) { return { server: server, i: i }; })
      .sort(function (a, b) { return (at(a.server.id) - at(b.server.id)) || (a.i - b.i); })
      .map(function (item) { return item.server; });
  }
  function moveServer(id, dir) {
    const list = rankedServers().map(function (server) { return server.id; });
    const from = list.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= list.length) return false;
    list.splice(from, 1);
    list.splice(to, 0, id);
    prefs().serverRank = list.slice(0, 200);
    return true;
  }

  function muteUntil(id) {
    const stored = prefs();
    const table = stored.mutes || {};
    let until = Object.prototype.hasOwnProperty.call(table, id) ? table[id] : null;
    if (until == null && hasId(stored.mutedChannels || [], id)) until = 0;
    if (until == null) return null;
    if (until !== 0 && until <= Date.now()) {
      delete table[id];
      stored.mutes = table;
      if (stored.mutedChannels) stored.mutedChannels = stored.mutedChannels.filter(function (item) { return item !== id; });
      savePrefs();
      return null;
    }
    return until;
  }

  function channelMuted(ch) {
    return !!(ch && (serverMuted(ch.serverId) || muteUntil(ch.id) != null));
  }

  function armMuteTimer() {
    if (state.muteTimer) clearTimeout(state.muteTimer);
    state.muteTimer = 0;
    if (typeof setTimeout !== "function") return;
    let soon = 0;
    const table = prefs().mutes || {};
    const now = Date.now();
    Object.keys(table).forEach(function (id) {
      const until = table[id];
      if (until > now && (!soon || until < soon)) soon = until;
    });
    if (!soon) return;
    state.muteTimer = setTimeout(function () {
      state.muteTimer = 0;
      Object.keys(prefs().mutes || {}).forEach(muteUntil);
      paintNavBadge();
      if (onMessages()) refreshInbox();
      else armMuteTimer();
    }, Math.min(2147483647, Math.max(250, soon - Date.now() + 20)));
  }

  function orderedCategories(channels) {
    const groups = [];
    const index = {};
    channels.forEach(function (ch) {
      const name = ch.category || "";
      const key = name || "\0";
      if (index[key] == null) {
        index[key] = groups.length;
        groups.push({ name: name, channels: [] });
      }
      groups[index[key]].channels.push(ch);
    });
    return groups;
  }

  function messageChannels(server, all) {
    return (server.channels || []).filter(function (ch) { return ch.mode === "messages" && !ch.inaccessible && (all || !channelHidden(ch.id)); });
  }

  function latestMessage(server) {
    let best = null;
    messageChannels(server).forEach(function (ch) {
      const rows = messagesFor(ch.id);
      if (!rows.length) return;
      if (!best || cmpId(rows[0].id, best.row.id) > 0) best = { row: rows[0], channel: ch };
    });
    return best;
  }

  function previewText(row, ch) {
    if (ch && channelPrivate(ch.id)) return tr("New message");
    return String(row && row.body || "").replace(/[*_`~|>]/g, "").replace(/\s+/g, " ").trim().slice(0, 90);
  }

  function formatShort(ms) {
    if (!ms) return "";
    try {
      const date = new Date(ms);
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      return new Intl.DateTimeFormat((window.SI18n ? window.SI18n.locale() : undefined), sameDay ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric" }).format(date);
    } catch (err) {
      return "";
    }
  }

  function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "#";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
  }

  function unreadCount(server, route) {
    if (serverMuted(server.id)) return 0;
    let count = 0;
    messageChannels(server).forEach(function (ch) {
      if (channelMuted(ch)) return;
      if (isUnread(ch.id, route)) count += 1;
    });
    return count;
  }

  function serverOrder(all) {
    const pinned = [];
    const rest = [];
    rankedServers().forEach(function (server) {
      if (!all && serverHidden(server.id)) return;
      (hasId(prefs().pinnedServers, server.id) ? pinned : rest).push(server);
    });
    pinned.sort(function (a, b) { return prefs().pinnedServers.indexOf(a.id) - prefs().pinnedServers.indexOf(b.id); });
    return pinned.concat(rest);
  }

  function iconSvg(name) {
    if (name === "pin") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3H8v2l1 5-3 3v2h5v6l1 1 1-1v-6h5v-2l-3-3 1-5V3z"/></svg>';
    if (name === "mute") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-4.2-5.7L4.7 16.4 4 17v1h14.2A2 2 0 0 1 18 16zM5.1 4.3 3.7 5.7 18.3 20.3l1.4-1.4L5.1 4.3z"/></svg>';
    if (name === "more") return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5 15 12 9 17.5"/></svg>';
  }

  function messagesUnread(route) {
    let count = 0;
    state.servers.forEach(function (server) {
      count += unreadCount(server, route || { channel: state.open });
    });
    return count;
  }

  function paintNavBadge() {
    if (typeof document === "undefined") return;
    document.querySelectorAll("a[href='#/messages'] .dmsgs-tab-badge, a[href=\"#/messages\"] .dmsgs-tab-badge").forEach(function (el) { el.remove(); });
    const count = messagesUnread();
    if (!count) return;
    const label = count > 99 ? "99+" : String(count);
    document.querySelectorAll('a[href="#/messages"]').forEach(function (link) {
      const host = link.querySelector(".nav-ico") || link;
      if (host.querySelector(".dmsgs-tab-badge")) return;
      const span = document.createElement("span");
      span.className = "dmsgs-tab-badge";
      span.textContent = label;
      host.appendChild(span);
    });
  }

  function setChannelMute(id, until) {
    const stored = prefs();
    stored.mutes = stored.mutes || {};
    stored.mutes[id] = until;
    stored.mutedChannels = (stored.mutedChannels || []).filter(function (item) { return item !== id; });
    if (until === 0) stored.mutedChannels.unshift(id);
    savePrefs();
    armMuteTimer();
  }

  function clearChannelMute(id) {
    const stored = prefs();
    if (stored.mutes) delete stored.mutes[id];
    stored.mutedChannels = (stored.mutedChannels || []).filter(function (item) { return item !== id; });
    savePrefs();
    armMuteTimer();
  }

  function channelMuteOnly(id) {
    return muteUntil(id) != null;
  }

  function pinsBlocked(ch) {
    if (!ch) return true;
    const file = state.pinFiles[ch.id];
    if (file) return !!file.forbidden;
    return !!ch.pinsForbidden;
  }

  function pinRows(id) {
    const file = state.pinFiles[id];
    let rows = [];
    if (file) rows = file.pins || [];
    else if (state.fixture && FIXTURE_PINS[id]) rows = FIXTURE_PINS[id];
    return rows.slice().sort(function (a, b) { return cmpId(b.id, a.id); });
  }

  function iconButton(kind, id, on, label) {
    const act = (on ? "Unpin " : "Pin ");
    const mute = (on ? "Unmute " : "Mute ");
    const text = (kind.indexOf("mute") === 0 ? mute : act) + label;
    return '<button type="button" class="dmsgs-iconbtn' + (on ? " on" : "") + '" data-discord="' + kind + '" data-id="' + esc(id) + '" aria-pressed="' + (on ? "true" : "false") + '" aria-label="' + esc(text) + '">' + iconSvg(kind.indexOf("mute") === 0 ? "mute" : "pin") + "</button>";
  }

  function channelRow(ch, route, category) {
    const on = route && route.channel === ch.id;
    const muted = channelMuted(ch);
    const unread = !muted && isUnread(ch.id, route);
    const pinned = hasId(prefs().pinnedChannels, ch.id);
    return '<div class="dmsgs-ch-row' + (muted ? " muted" : "") + (pinned ? " pinned" : "") + '">' +
      '<a class="dmsgs-ch' + (on ? " on" : "") + (unread ? " unread" : "") + '" data-ch="' + esc(ch.id) + '" data-name="' + esc(ch.name) + '" data-cat="' + esc(category || ch.category || "") + '" href="' + channelHref(ch.id) + '">' +
      '<span class="dmsgs-hash" aria-hidden="true">#</span><span class="dmsgs-ch-name" title="' + esc(ch.name) + '">' + esc(ch.name) + "</span>" +
      (pinned ? ("<span class=\"dmsgs-pinmark\" " + "aria-label=\"" + tr("Pinned") + "\"" + ">") + iconSvg("pin") + "</span>" : "") +
      (muted ? ("<span class=\"dmsgs-bell\" " + "aria-label=\"" + tr("Muted") + "\"" + ">") + iconSvg("mute") + "</span>" : "") +
      (unread ? ("<span class=\"dmsgs-dot\" " + "aria-label=\"" + tr("Unread") + "\"" + "></span>") : "") +
      "</a>" +
      '<button type="button" class="dmsgs-more" data-discord="menu" data-id="' + esc(ch.id) + ("\" " + "aria-label=\"" + tr("More") + "\"" + ">") + iconSvg("more") + "</button>" +
      "</div>";
  }

  function channelList(server, route) {
    const all = messageChannels(server);
    const pinned = [];
    const rest = [];
    all.forEach(function (ch) { (hasId(prefs().pinnedChannels, ch.id) ? pinned : rest).push(ch); });
    pinned.sort(function (a, b) { return prefs().pinnedChannels.indexOf(a.id) - prefs().pinnedChannels.indexOf(b.id); });
    const pinnedHtml = pinned.map(function (ch) { return channelRow(ch, route, ch.category); }).join("");
    const groups = orderedCategories(rest).map(function (group) {
      const links = group.channels.map(function (ch) { return channelRow(ch, route, group.name); }).join("");
      return (group.name ? '<h2 class="dmsgs-cat" title="' + esc(group.name) + '">' + esc(group.name) + "</h2>" : "") + links;
    }).join("");
    return '<div class="dmsgs-sub">' + pinnedHtml + groups + "</div>";
  }

  function serverBlock(server, route) {
    const open = !!(state.query || prefs().expanded[server.id]);
    const latest = latestMessage(server);
    const count = unreadCount(server, route);
    const muted = serverMuted(server.id);
    const pinned = hasId(prefs().pinnedServers, server.id);
    const preview = state.paused ? tr("Discord paused") : (latest ? (channelPrivate(latest.channel.id) ? previewText(latest.row, latest.channel) : (latest.row.name + ": " + previewText(latest.row))) : tr("No messages yet"));
    const time = !state.paused && latest ? formatShort(msgTime(latest.row)) : "";
    const badge = !muted && count ? '<span class="dmsgs-badge" aria-label="' + esc(trn("unread", count)) + '">' + (count > 99 ? "99+" : String(count)) + "</span>" : "";
    const icon = server.icon
      ? '<img src="' + esc(server.icon) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
      : "<span>" + esc(initials(server.name)) + "</span>";
    return '<section class="dmsgs-srv' + (open ? " open" : "") + (muted ? " muted" : "") + (pinned ? " pinned" : "") + '" data-server="' + esc(server.id) + '" data-name="' + esc(server.name) + '">' +
      '<div class="dmsgs-srv-row">' +
      '<button type="button" class="dmsgs-srv-main" data-discord="toggle" data-server="' + esc(server.id) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
      '<span class="dmsgs-chev" aria-hidden="true">' + iconSvg("chev") + "</span>" +
      '<span class="dmsgs-srv-ico">' + icon + "</span>" +
      '<span class="dmsgs-srv-copy"><span class="dmsgs-srv-top"><b title="' + esc(server.name) + '">' + esc(server.name) + "</b>" + (time ? "<time>" + esc(time) + "</time>" : "") + "</span>" +
      '<span class="dmsgs-srv-preview">' + esc(preview) + "</span></span>" +
      badge +
      "</button>" +
      '<span class="dmsgs-srv-acts">' + iconButton("pin-server", server.id, pinned, "server") + iconButton("mute-server", server.id, muted, "server") + "</span>" +
      "</div>" +
      channelList(server, route) +
      "</section>";
  }

  /* Server switcher: one round icon per server, like Discord's rail.
     A tap opens that server alone and brings it into view. */
  function switcherHtml() {
    const list = serverOrder();
    if (list.length < 2) return "";
    const btns = list.map(function (server) {
      const on = !!prefs().expanded[server.id];
      const face = server.icon
        ? '<img src="' + esc(server.icon) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">'
        : "<span>" + esc(initials(server.name)) + "</span>";
      return '<button type="button" class="dmsgs-sw-btn' + (on ? " on" : "") + '" data-discord="switch" data-server="' + esc(server.id) + '" title="' + esc(server.name) + '" aria-label="' + esc(server.name) + '" aria-pressed="' + (on ? "true" : "false") + '">' + face + "</button>";
    }).join("");
    return '<nav class="dmsgs-switcher" aria-label="' + esc(tr("Servers")) + '">' + btns + "</nav>";
  }

  function listHtml(route) {
    const add = (root.DiscordPicks && root.DiscordPicks.addButtonHtml) ? root.DiscordPicks.addButtonHtml() : "";
    const warn = (root.DiscordPicks && root.DiscordPicks.keyBannerHtml) ? root.DiscordPicks.keyBannerHtml() : "";
    const chips = root.ViktorychInbox && root.ViktorychInbox.tabsHtml ? root.ViktorychInbox.tabsHtml() : "";
    const head = ("<header class=\"dmsgs-head\"><h1" + ">" + esc(root.ViktorychInbox && root.ViktorychInbox.title ? root.ViktorychInbox.title() : tr("Inbox")) + "<" + "/h1>" + add + "</header>") + chips + warn;
    const text = state.channels.filter(function (ch) { return ch.mode === "messages" && !ch.inaccessible; });
    if (state.filter === "servers") {
      const own = nativeServersHtml();
      return head + (own || ("<div class=\"dmsgs-placeholder\"><h2" + ">" + tr("No servers yet") + "<" + "/h2><p" + ">" + tr("Servers you create or join show up here.") + "<" + "/p></div>"));
    }
    // Sections split into their own page, or hidden, stay out of All.
    const inbox = root.ViktorychInbox;
    const away = function (id) { return !state.filter && !!inbox && !!inbox.isSplit && (inbox.isSplit(id) || inbox.isHidden(id)); };
    const native = state.filter === "discord" || away("servers") ? "" : nativeServersHtml();
    if (away("discord")) {
      if (native) return head + native;
      return head + ("<div class=\"dmsgs-placeholder\"><h2" + ">" + tr("No conversations yet") + "<" + "/h2><p" + ">" + tr("Sections with their own page are not shown here.") + "<" + "/p></div>");
    }
    if (!text.length) {
      if (native) return head + native;
      return head + ("<div class=\"dmsgs-placeholder\"><h2" + ">" + tr("No conversations yet") + "<" + "/h2><p" + ">" + tr("Channels set to messages show up here. None are configured yet.") + "<" + "/p></div>");
    }
    if (state.customize) return head + customizeHtml();
    const rows = serverOrder().map(function (server) { return serverBlock(server, route); }).join("");
    const filtering = state.query ? " is-filtering" : "";
    const tools = '<div class="dmsgs-tools"><button type="button" class="dmsgs-cz-open" data-discord="customize">' + esc(tr("Customize")) + "</button></div>";
    return head + switcherHtml() + tools +
      '<label class="search dmsgs-search"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 20.3 16.7 16a7.5 7.5 0 1 0-.7.7L20.3 21 21 20.3zM5 10.5a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0z"/></svg>' +
      ("<input id=\"dmsgs-q\" class=\"dmsgs-q\" type=\"search\" " + "placeholder=\"" + tr("Search Direct Messages") + "\"" + " " + "aria-label=\"" + tr("Search Direct Messages") + "\"" + " value=\"") + esc(state.query) + '"></label>' +
      native +
      '<div class="dmsgs-channels' + filtering + '">' + rows + "</div>";
  }

  /* Customize: order, hide, mute and keep private, all on this device.
     Nothing here talks to Discord; the list only reads what it already has. */
  function customizeHtml() {
    const toggle = function (kind, id, on, onLabel, offLabel) {
      return '<button type="button" class="dmsgs-cz-btn' + (on ? " on" : "") + '" data-discord="' + kind + '" data-id="' + esc(id) + '" aria-pressed="' + (on ? "true" : "false") + '">' + esc(on ? onLabel : offLabel) + "</button>";
    };
    const servers = serverOrder(true);
    const rows = servers.map(function (server, i) {
      const hidden = serverHidden(server.id);
      const channels = messageChannels(server, true).map(function (ch) {
        const chHidden = channelHidden(ch.id);
        return '<li class="dmsgs-cz-ch' + (chHidden ? " off" : "") + '"><span class="dmsgs-hash" aria-hidden="true">#</span><span class="dmsgs-cz-name" title="' + esc(ch.name) + '">' + esc(ch.name) + "</span>" +
          '<span class="dmsgs-cz-acts">' +
          toggle("ch-hide", ch.id, chHidden, tr("Show"), tr("Hide")) +
          toggle("ch-mute", ch.id, muteUntil(ch.id) != null, tr("Unmute"), tr("Mute")) +
          toggle("ch-private", ch.id, channelPrivate(ch.id), tr("Private"), tr("Previews on")) +
          "</span></li>";
      }).join("");
      return '<li class="dmsgs-cz-srv' + (hidden ? " off" : "") + '" data-server="' + esc(server.id) + '"><div class="dmsgs-cz-head"><b title="' + esc(server.name) + '">' + esc(server.name) + "</b>" +
        '<span class="dmsgs-cz-acts">' +
        '<button type="button" class="dmsgs-cz-btn" data-discord="srv-up" data-id="' + esc(server.id) + '" aria-label="' + esc(tr("Move up")) + '"' + (i === 0 ? " disabled" : "") + ">↑</button>" +
        '<button type="button" class="dmsgs-cz-btn" data-discord="srv-down" data-id="' + esc(server.id) + '" aria-label="' + esc(tr("Move down")) + '"' + (i === servers.length - 1 ? " disabled" : "") + ">↓</button>" +
        toggle("srv-hide", server.id, hidden, tr("Show"), tr("Hide")) +
        toggle("mute-server", server.id, serverMuted(server.id), tr("Unmute"), tr("Mute")) +
        "</span></div>" + (channels ? '<ul class="dmsgs-cz-chs">' + channels + "</ul>" : "") + "</li>";
    }).join("");
    return '<section class="dmsgs-cz" aria-label="' + esc(tr("Customize Discord")) + '"><div class="dmsgs-cz-top"><h2>' + esc(tr("Customize Discord")) + '</h2><button type="button" class="dmsgs-cz-done" data-discord="customize-done">' + esc(tr("Done")) + "</button></div>" +
      '<p class="dmsgs-cz-note">' + esc(tr("Saved on this device only. Private channels show “New message” in previews and alerts instead of the text. Nothing is sent to Discord.")) + "</p>" +
      '<ul class="dmsgs-cz-list">' + rows + "</ul></section>";
  }

  // App-native servers (servers-ui.js) sit above the mirrored Discord list.
  function nativeServersHtml() {
    // The list also renders outside a page (node checks), where there is no window.
    const host = typeof window !== "undefined" ? window : null;
    if (!host) return "";
    const mod = host.ViktorychServers;
    if (mod && mod.listHtml) {
      try { return mod.listHtml(); } catch (err) { return ""; }
    }
    if (host.ViktorychLazy && host.ViktorychLazy.ensure) {
      try { host.ViktorychLazy.ensure("servers"); } catch (err) { /* offline */ }
    }
    return "";
  }

  function conversationHtml(route) {
    const id = route && route.channel || "";
    if (!id) {
      return ("<section class=\"dmsgs-conv dmsgs-conv-empty\"><div class=\"dmsgs-placeholder\"><h2" + ">" + tr("Select a message") + "<" + "/h2><p" + ">" + tr("Choose from your existing conversations, or just keep swimming.") + "<" + "/p></div></section>");
    }
    const ch = channelById(id);
    if (!ch) {
      return '<section class="dmsgs-conv"><header class="dmsgs-conv-head"><a class="dmsgs-back" href="' + listHref() + ("\" " + "aria-label=\"" + tr("Back") + "\"" + ">‹</a><div><b" + ">" + tr("Channel") + "<" + "/b></div></header><div class=\"dmsgs-log\"><div class=\"dmsgs-placeholder\"><h2" + ">" + tr("This channel isn’t available") + "<" + "/h2><p" + ">" + tr("It isn’t in the Discord list.") + "<" + "/p></div></div></section>");
    }
    if (ch.mode !== "messages") {
      return '<section class="dmsgs-conv"><header class="dmsgs-conv-head"><a class="dmsgs-back" href="' + listHref() + ("\" " + "aria-label=\"" + tr("Back") + "\"" + ">‹</a><span class=\"dmsgs-hash lg\" aria-hidden=\"true\">#</span><div class=\"dmsgs-conv-title\"><b title=\"") + esc(ch.name) + '">' + esc(ch.name) + '</b><span title="' + esc(ch.category) + '">' + esc(ch.category) + ("</span></div></header><div class=\"dmsgs-log\"><div class=\"dmsgs-placeholder\"><h2" + ">" + tr("Posted on Home") + "<" + "/h2><p" + ">" + tr("Announcement channels are published with the rest of the feed.") + "<" + "/p></div></div></section>");
    }
    const server = serverById(ch.serverId);
    const who = messagesFor(id)[0];
    const headMode = faceMode(who && who.avatar);
    let face = headMode === "none" ? "" : (headMode === "photo" ? '<span class="dmsgs-head-face"><img src="' + esc(who.avatar) + '" alt="" referrerpolicy="no-referrer"></span>' : silhouetteHtml("dmsgs-head-face"));
    const whoId = who && /^\d{12}$/.test(String(who.publicId || "")) ? who.publicId : "";
    if (whoId && face && window.ViktorychPresence) face = window.ViktorychPresence.wrap(whoId, face);
    const pinBtn = pinsBlocked(ch) ? "" : '<button type="button" class="dmsgs-iconbtn dmsgs-pins' + (state.pinsOpen === id ? " on" : "") + '" data-discord="pins" data-id="' + esc(id) + ("\" " + "aria-label=\"" + tr("Pinned messages") + "\"" + " aria-expanded=\"") + (state.pinsOpen === id ? "true" : "false") + '">' + iconSvg("pin") + "</button>";
    const place = (server && server.name) || ch.category || "Discord";
    const sub = whoId && window.ViktorychPresence ? window.ViktorychPresence.dmSubHtml(whoId, place) : esc(place);
    const catchup = '<button type="button" class="show-more odai-btn" data-act="odai-unread" data-id="' + esc(id) + '" data-scope="dm">' + esc(tr("Summarize unread")) + "</button>";
    const suggest = '<button type="button" class="show-more odai-btn" data-act="odai-suggest" data-id="' + esc(id) + '" data-scope="dm">' + esc(tr("Suggest replies")) + "</button>";
    const gameInvite = whoId && typeof window !== "undefined" && window.ViktorychGameSocial ? window.ViktorychGameSocial.dmHeadHtml(whoId, ch.name) : "";
    return '<section class="dmsgs-conv">' +
      '<header class="dmsgs-conv-head"><a class="dmsgs-back" href="' + listHref() + ("\" " + "aria-label=\"" + tr("Back") + "\"" + ">‹</a>") + face + '<div class="dmsgs-conv-title"><b title="' + esc(ch.name) + '">' + esc(ch.name) + '</b><span title="' + esc(place) + '">' + sub + "</span></div>" + catchup + suggest + gameInvite + pinBtn + "</header>" +
      '<div class="dmsgs-log" tabindex="0">' + logInner(id) + "</div>" +
      pinPanelHtml(id) +
      ("<button type=\"button\" class=\"dmsgs-jump\" hidden" + ">" + tr("Jump to present") + "<" + "/button>") +
      ("<div class=\"dmsgs-compose\"><div class=\"dmsgs-compose-box\" role=\"textbox\" aria-disabled=\"true\" " + "aria-label=\"" + tr("Read-only channel") + "\"" + "><span" + ">" + tr("Read-only channel") + "<" + "/span></div></div>") +
      "</section>";
  }

  function pinPanelHtml(id) {
    if (state.pinsOpen !== id) return "";
    const ch = channelById(id);
    if (!ch || pinsBlocked(ch)) return "";
    const rows = pinRows(id);
    const waiting = !state.fixture && !state.pinFiles[id];
    let body = "";
    if (waiting) body = ("<p class=\"dmsgs-pinempty\"" + ">" + tr("Loading pinned messages") + "<" + "/p>");
    else if (!rows.length) body = ("<p class=\"dmsgs-pinempty\"" + ">" + tr("No pinned messages") + "<" + "/p>");
    else body = rows.map(function (row) {
      const when = formatClock({ id: row.id, date: row.date });
      return '<button type="button" class="dmsgs-pinrow" data-discord="jump" data-mid="' + esc(row.id) + '">' +
        '<span class="dmsgs-pinrow-top"><b>' + esc(row.author || tr("Someone")) + "</b>" + (when ? "<time>" + esc(when) + "</time>" : "") + "</span>" +
        '<span class="dmsgs-pinrow-text">' + esc(row.text || tr("Pinned message")) + "</span></button>";
    }).join("");
    return ("<div class=\"dmsgs-pinpanel\" role=\"dialog\" " + "aria-label=\"" + tr("Pinned messages") + "\"" + ">") +
      ("<header class=\"dmsgs-pinhead\"><span class=\"dmsgs-grab\" aria-hidden=\"true\"></span><b" + ">" + tr("Pinned messages") + "<" + "/b><button type=\"button\" class=\"dmsgs-iconbtn\" data-discord=\"pins-close\" " + "aria-label=\"" + tr("Close") + "\"" + ">×</button></header>") +
      '<div class="dmsgs-pinlist">' + body + "</div></div>";
  }

  function menuHtml() {
    const menu = state.menu;
    if (!menu || !menu.id) return "";
    const ch = channelById(menu.id);
    if (!ch) return "";
    const pinned = hasId(prefs().pinnedChannels, ch.id);
    const muted = channelMuteOnly(ch.id);
    let items = "";
    if (menu.durations) {
      items = ("<div class=\"dmsgs-menu-title\"" + ">" + tr("Mute channel") + "<" + "/div>") + MUTE_CHOICES.map(function (choice) {
        return '<button type="button" role="menuitem" data-discord="mute-for" data-id="' + esc(ch.id) + '" data-ms="' + choice.ms + '">' + esc(choice.label) + "</button>";
      }).join("");
    } else {
      items = '<button type="button" role="menuitem" data-discord="pin-channel" data-id="' + esc(ch.id) + '"><span class="dmsgs-mi">' + iconSvg("pin") + "</span>" + (pinned ? tr("Unpin channel") : tr("Pin channel")) + "</button>" +
        (muted
          ? '<button type="button" role="menuitem" data-discord="unmute-channel" data-id="' + esc(ch.id) + '"><span class="dmsgs-mi">' + iconSvg("mute") + ("</span" + ">" + tr("Unmute channel") + "<" + "/button>")
          : '<button type="button" role="menuitem" data-discord="mute-menu" data-id="' + esc(ch.id) + '"><span class="dmsgs-mi">' + iconSvg("mute") + ("</span" + ">" + tr("Mute channel") + "<" + "/button>")) +
        '<button type="button" role="menuitem" data-discord="ch-private" data-id="' + esc(ch.id) + '"><span class="dmsgs-mi">' + iconSvg("mute") + "</span>" + esc(channelPrivate(ch.id) ? tr("Show message previews") : tr("Hide message previews")) + "</button>" +
        '<button type="button" role="menuitem" data-discord="ch-hide" data-id="' + esc(ch.id) + '"><span class="dmsgs-mi">' + iconSvg("more") + "</span>" + esc(tr("Hide channel")) + "</button>";
    }
    const x = Math.round(Number(menu.x) || 16);
    const y = Math.round(Number(menu.y) || 16);
    return ("<button type=\"button\" class=\"dmsgs-scrim\" data-discord=\"menu-close\" " + "aria-label=\"" + tr("Close menu") + "\"" + "></button>") +
      '<div class="dmsgs-menu" role="menu" style="left:' + x + 'px;top:' + y + 'px"><span class="dmsgs-grab" aria-hidden="true"></span>' + items + "</div>";
  }

  function page(route) {
    state.fixture = !!(route && route.query && typeof route.query.get === "function" && route.query.get("fixture") === "1");
    state.filter = readFilter(route);
    if (state.fixture && !state.holdServers) {
      const kept = {};
      state.channels.forEach(function (ch) {
        if (ch.pinsForbidden || ch.inaccessible) kept[ch.id] = { pinsForbidden: !!ch.pinsForbidden, inaccessible: !!ch.inaccessible };
      });
      adoptServers(CATALOG_SERVERS);
      state.channels.forEach(function (ch) {
        const prev = kept[ch.id];
        if (!prev) return;
        if (prev.pinsForbidden) ch.pinsForbidden = true;
        if (prev.inaccessible) ch.inaccessible = true;
      });
    } else if (!state.fixture) {
      warmCache();
    }
    ensureLoad();
    const id = route && snowflake(route.channel);
    if (id && !state.fixture) {
      ensureChannel(id);
      ensurePins(id);
    }
    const open = id ? " has-channel" : "";
    return '<div class="dmsgs' + open + '" data-discord-root>' +
      '<aside class="dmsgs-list" id="dmsgs-list">' + listHtml(route) +
      ("<div class=\"dmsgs-split\" role=\"separator\" tabindex=\"0\" aria-orientation=\"vertical\" " + "aria-label=\"" + tr("Resize message list") + "\"" + " aria-controls=\"dmsgs-list\" aria-valuemin=\"300\" aria-valuemax=\"440\" aria-valuenow=\"440\"></div></aside>") +
      conversationHtml(route) +
      menuHtml() +
      "</div>";
  }

  function titleFor(route) {
    if (!route || route.name !== "messages" || !route.channel) return "";
    const ch = channelById(route.channel);
    return ch ? "#" + ch.name : "";
  }

  function nearBottom(log) {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  }

  function onScroll() {
    const log = document.querySelector(".dmsgs-log");
    if (!log || state.scrollLock) return;
    const near = nearBottom(log);
    state.stick = near;
    const jump = document.querySelector(".dmsgs-jump");
    if (jump) jump.hidden = near;
    if (state.open) writeScroll("log:" + state.open, log.scrollTop);
    if (near && state.open) {
      markSeen(state.open);
      updateDots();
    }
    if (log.scrollTop < 120 && state.open && !state.fixture) loadOlder(state.open);
  }

  function repaintLog(mode) {
    const log = document.querySelector(".dmsgs-log");
    if (!log || !state.open) return;
    const list = listEl();
    const listTop = list ? list.scrollTop : 0;
    const near = mode === "keep" ? false : (nearBottom(log) || state.stick);
    const prevHeight = log.scrollHeight;
    const prevTop = log.scrollTop;
    const rows = messagesFor(state.open).slice().reverse();
    const have = Array.prototype.map.call(log.querySelectorAll(".dmsg[data-mid]"), function (el) { return el.getAttribute("data-mid"); });
    const want = rows.map(function (row) { return row.id; });
    const same = have.join(",") === want.join(",");
    if (!same) log.innerHTML = logInner(state.open);
    state.scrollLock = true;
    if (mode === "keep") {
      log.scrollTop = prevTop + (log.scrollHeight - prevHeight);
    } else if (near) {
      log.scrollTop = log.scrollHeight;
      markSeen(state.open);
    }
    if (list && Math.abs(list.scrollTop - listTop) > 1) list.scrollTop = listTop;
    state.scrollLock = false;
    if (state.open) writeScroll("log:" + state.open, log.scrollTop);
    const jump = document.querySelector(".dmsgs-jump");
    if (jump) jump.hidden = near;
    updateDots();
  }

  function updateDots() {
    if (typeof document === "undefined") return;
    document.querySelectorAll(".dmsgs-ch").forEach(function (el) {
      const id = el.getAttribute("data-ch");
      const ch = channelById(id);
      const unread = ch && !channelMuted(ch) && isUnread(id, { channel: state.open });
      el.classList.toggle("unread", unread);
      let dot = el.querySelector(".dmsgs-dot");
      if (unread && !dot) {
        dot = document.createElement("span");
        dot.className = "dmsgs-dot";
        dot.setAttribute("aria-label", tr("Unread"));
        el.appendChild(dot);
      } else if (!unread && dot) {
        dot.remove();
      }
    });
    document.querySelectorAll(".dmsgs-srv").forEach(function (srv) {
      const server = serverById(srv.getAttribute("data-server"));
      if (!server) return;
      const count = unreadCount(server, { channel: state.open });
      let badge = srv.querySelector(".dmsgs-badge");
      if (!serverMuted(server.id) && count) {
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "dmsgs-badge";
          const main = srv.querySelector(".dmsgs-srv-main");
          if (main) main.appendChild(badge);
        }
        badge.textContent = count > 99 ? "99+" : String(count);
        badge.setAttribute("aria-label", count + " unread");
      } else if (badge) {
        badge.remove();
      }
      const latest = latestMessage(server);
      const preview = srv.querySelector(".dmsgs-srv-preview");
      if (preview) {
        preview.textContent = state.paused ? tr("Discord paused") : (latest ? (channelPrivate(latest.channel.id) ? previewText(latest.row, latest.channel) : (latest.row.name + ": " + previewText(latest.row))) : tr("No messages yet"));
      }
    });
    paintNavBadge();
  }

  function applyFilter() {
    if (typeof document === "undefined") return;
    const q = String(state.query || "").trim().toLowerCase();
    const host = document.querySelector(".dmsgs-channels");
    if (host) host.classList.toggle("is-filtering", !!q);
    document.querySelectorAll(".dmsgs-srv").forEach(function (srv) {
      const serverName = (srv.getAttribute("data-name") || "").toLowerCase();
      const serverMatch = !q || serverName.indexOf(q) >= 0;
      let any = serverMatch;
      srv.querySelectorAll(".dmsgs-ch-row").forEach(function (row) {
        const link = row.querySelector(".dmsgs-ch");
        const name = (link && link.getAttribute("data-name") || "").toLowerCase();
        const cat = (link && link.getAttribute("data-cat") || "").toLowerCase();
        const match = serverMatch || name.indexOf(q) >= 0 || cat.indexOf(q) >= 0;
        row.hidden = !!(q && !match);
        if (match) any = true;
      });
      srv.querySelectorAll(".dmsgs-cat").forEach(function (el) {
        let visible = false;
        let node = el.nextElementSibling;
        while (node && !node.classList.contains("dmsgs-cat") && !node.classList.contains("dmsgs-srv")) {
          if (node.classList.contains("dmsgs-ch-row") && !node.hidden) visible = true;
          node = node.nextElementSibling;
        }
        el.hidden = !visible;
      });
      srv.hidden = !any;
    });
  }

  function scrollMap() {
    try {
      const raw = JSON.parse(readStore(sessionStorage, SCROLL_KEY) || "{}");
      return raw && typeof raw === "object" ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function writeScroll(key, value) {
    if (!key) return;
    const map = scrollMap();
    const n = Math.max(0, Math.round(Number(value) || 0));
    map[String(key).slice(0, 80)] = n;
    try { sessionStorage.setItem(SCROLL_KEY, JSON.stringify(map)); } catch (err) { /* private mode can refuse */ }
  }

  function readScroll(key) {
    const n = Number(scrollMap()[key]);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function listEl() {
    return typeof document === "undefined" ? null : document.querySelector(".dmsgs-channels");
  }

  function logEl() {
    return typeof document === "undefined" ? null : document.querySelector(".dmsgs-log");
  }

  function rememberList() {
    const list = listEl();
    if (!list || state.scrollLock) return;
    if (state.holding && list.scrollTop < 2 && state.listHold > 20) return;
    state.listHold = list.scrollTop;
    writeScroll("list", list.scrollTop);
    const open = document.querySelector(".dmsgs-srv.open");
    const sid = open && open.getAttribute("data-server");
    if (sid) writeScroll("server:" + sid, list.scrollTop);
  }

  function restoreList() {
    const list = listEl();
    if (!list) return;
    const y = state.listHold != null ? state.listHold : readScroll("list");
    state.scrollLock = true;
    if (Math.abs(list.scrollTop - y) > 1) list.scrollTop = y;
    state.scrollLock = false;
    writeScroll("list", y);
  }

  function listHidden() {
    const list = listEl();
    return !!(list && list.offsetParent === null);
  }

  function rememberWindow() {
    try {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      if (state.holding && y < 2 && state.winHold > 20) return;
      state.winHold = y;
      writeScroll("window", y);
    } catch (err) { /* no window */ }
  }

  function restoreWindow() {
    const y = state.winHold != null ? state.winHold : readScroll("window");
    try {
      if (Math.abs((window.scrollY || 0) - y) > 1) window.scrollTo(0, y);
    } catch (err) { /* ignore */ }
  }

  function bindList() {
    const list = listEl();
    if (!list || list.dataset.bound === "1") return;
    list.dataset.bound = "1";
    list.addEventListener("scroll", function () {
      if (state.scrollLock) return;
      rememberList();
    }, { passive: true });
  }

  function bindLog(log) {
    const node = log || logEl();
    if (!node || node.dataset.bound === "1") return;
    node.dataset.bound = "1";
    node.addEventListener("scroll", onScroll, { passive: true });
  }

  function routeFromLocation() {
    let hash = "#/messages";
    try { hash = location.hash || "#/messages"; } catch (err) { /* node tests have no location */ }
    const cut = hash.indexOf("?");
    const path = (cut >= 0 ? hash.slice(0, cut) : hash).replace(/^#/, "");
    const query = new URLSearchParams(cut >= 0 ? hash.slice(cut + 1) : "");
    const parts = path.split("/").filter(Boolean);
    const channel = parts[0] === "messages" && parts[1] === "discord" ? (parts[2] || "") : "";
    return { name: "messages", channel: channel, query: query };
  }

  function placeLog(toNewest) {
    const log = logEl();
    if (!log || !state.open) return;
    state.scrollLock = true;
    if (toNewest) {
      log.scrollTop = log.scrollHeight;
      state.stick = true;
      markSeen(state.open);
    } else if (state.stick) {
      log.scrollTop = log.scrollHeight;
    } else {
      log.scrollTop = readScroll("log:" + state.open) || log.scrollHeight;
    }
    state.scrollLock = false;
    writeScroll("log:" + state.open, log.scrollTop);
    const jump = document.querySelector(".dmsgs-jump");
    if (jump) jump.hidden = !!state.stick;
  }

  function scrollLogToMessage(target) {
    const log = logEl();
    if (!log || !target) return;
    const logBox = log.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    state.scrollLock = true;
    log.scrollTop = Math.max(0, log.scrollTop + (box.top - logBox.top) - (log.clientHeight - box.height) / 2);
    state.scrollLock = false;
    state.stick = false;
    writeScroll("log:" + state.open, log.scrollTop);
    target.classList.add("dmsg-flash");
    const jump = document.querySelector(".dmsgs-jump");
    if (jump) jump.hidden = false;
  }

  function markActive() {
    const id = state.open || "";
    document.querySelectorAll(".dmsgs-ch").forEach(function (el) {
      el.classList.toggle("on", el.getAttribute("data-ch") === id);
    });
  }

  function replaceConv(toNewest) {
    const root = document.querySelector("[data-discord-root]");
    const conv = root && root.querySelector(".dmsgs-conv");
    if (!conv) return false;
    const previous = logEl();
    if (previous && state.open && !toNewest) writeScroll("log:" + state.open, previous.scrollTop);
    rememberList();
    conv.outerHTML = conversationHtml(routeFromLocation());
    const host = document.querySelector("[data-discord-root]");
    if (host) host.classList.toggle("has-channel", !!state.open);
    bindLog();
    placeLog(!!toNewest);
    restoreList();
    return true;
  }

  function repaintChannels() {
    const host = listEl();
    if (!host) return false;
    rememberList();
    const y = state.listHold != null ? state.listHold : host.scrollTop;
    host.innerHTML = serverOrder().map(function (server) { return serverBlock(server, routeFromLocation()); }).join("");
    state.scrollLock = true;
    host.scrollTop = y;
    state.scrollLock = false;
    state.listHold = host.scrollTop;
    writeScroll("list", host.scrollTop);
    bindList();
    applyFilter();
    return true;
  }

  function repaintMenu() {
    const root = document.querySelector("[data-discord-root]");
    if (!root) return false;
    root.querySelectorAll(".dmsgs-scrim, .dmsgs-menu").forEach(function (el) {
      if (el.parentNode === root) el.remove();
    });
    if (state.menu) root.insertAdjacentHTML("beforeend", menuHtml());
    return true;
  }

  function refreshInbox() {
    if (typeof document === "undefined" || !document.querySelector("[data-discord-root]")) {
      if (onMessages() && hooks().render) hooks().render();
      return;
    }
    state.holding = true;
    rememberList();
    rememberWindow();
    repaintChannels();
    if (state.open) replaceConv(false);
    repaintMenu();
    restoreList();
    restoreWindow();
    state.holding = false;
    noteShared();
  }

  function releaseHold() {
    if (listHidden()) return;
    state.holding = false;
    state.listHold = null;
  }

  function syncFromHash() {
    const route = routeFromLocation();
    state.fixture = !!(route.query && typeof route.query.get === "function" && route.query.get("fixture") === "1");
    state.filter = readFilter(route);
    const id = snowflake(route.channel);
    const changed = state.open !== id;
    state.open = id;
    if (changed) {
      state.stick = true;
      state.menu = null;
      state.pinsOpen = "";
    }
    const root = document.querySelector("[data-discord-root]");
    if (!root) {
      if (hooks().render) hooks().render();
      return;
    }
    state.holding = true;
    rememberList();
    root.classList.toggle("has-channel", !!id);
    markActive();
    replaceConv(changed);
    repaintMenu();
    updateDots();
    if (id && !state.fixture) {
      ensureChannel(id);
      ensurePins(id);
    }
    restoreList();
    restoreWindow();
    try {
      const title = titleFor(route);
      document.title = (title || tr("Inbox")) + " / " + productName("app");
    } catch (err) { /* ignore */ }
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () {
        restoreList();
        restoreWindow();
        releaseHold();
      });
    } else releaseHold();
  }

  function followHash(href) {
    const next = href || "#/messages";
    let here = "";
    try { here = location.hash || "#/"; } catch (err) {}
    if (here !== next) {
      try { history.pushState(null, "", next); }
      catch (err) {
        try { location.hash = next; return; } catch (e2) { /* ignore */ }
      }
    }
    if (hooks().noteHash) hooks().noteHash(next);
    if (hooks().stay) hooks().stay();
    syncFromHash();
  }

  function bindSplit() {
    if (typeof document === "undefined" || !root.FeedsSplit) return;
    const split = document.querySelector(".dmsgs-split");
    if (!split) return;
    root.FeedsSplit.bind(split, root.FeedsSplit.messages, document.querySelector(".dmsgs"));
  }

  function mount(route) {
    const messages = route && route.name === "messages";
    if (!messages) {
      state.open = "";
      state.menu = null;
      state.pinsOpen = "";
      refreshLive();
      paintNavBadge();
      armMuteTimer();
      return;
    }
    const channel = snowflake(route.channel);
    if (state.open !== channel) {
      state.open = channel;
      state.stick = true;
    }
    bindList();
    bindLog();
    bindSplit();
    const list = listEl();
    if (list) {
      const y = state.listHold != null ? state.listHold : readScroll("list");
      state.scrollLock = true;
      list.scrollTop = y;
      state.scrollLock = false;
      state.listHold = list.scrollTop;
    }
    const log = logEl();
    if (state.jump) {
      const target = document.querySelector('.dmsg[data-mid="' + state.jump + '"]');
      if (target) scrollLogToMessage(target);
      else if (log) log.scrollTop = log.scrollHeight;
      state.jump = "";
    } else if (log && state.open) {
      state.scrollLock = true;
      log.scrollTop = state.stick ? log.scrollHeight : (readScroll("log:" + state.open) || log.scrollHeight);
      state.scrollLock = false;
      if (state.stick) markSeen(state.open);
    }
    applyFilter();
    const jump = document.querySelector(".dmsgs-jump");
    if (jump) jump.hidden = state.stick;
    restoreWindow();
    paintNavBadge();
    armMuteTimer();
    refreshLive();
  }

  function topicOk(value) {
    const text = String(value || "").trim();
    return /^[A-Za-z0-9_-]{8,80}$/.test(text) ? text : "";
  }

  function liveTopic() {
    return state.topic || TOPIC;
  }

  function applyConfig(servers) {
    (servers || []).forEach(function (server) {
      const topic = topicOk(server && server.ntfy);
      if (topic) state.topic = topic;
    });
    const kept = {};
    state.channels.forEach(function (ch) { kept[ch.id] = !!ch.inaccessible; });
    if (!adoptServers(servers)) return;
    state.channels.forEach(function (ch) { if (kept[ch.id] && !ch.picked) ch.inaccessible = true; });
    rememberMessages();
    noteShared();
  }

  function applyIndex(index) {
    const status = index && index.status;
    state.paused = status === "unauthorized" || status === "forbidden" || status === "captcha" || status === "verification";
    const byId = {};
    state.channels.forEach(function (ch) { byId[ch.id] = ch; });
    const byServer = {};
    state.servers.forEach(function (server) { byServer[server.id] = server; });
    ((index && index.servers) || []).forEach(function (server) {
      const row = byServer[snowflake(server && server.id)];
      const icon = cdnUrl(server && server.icon);
      if (row && icon) row.icon = icon;
      if (row && server && server.name) row.name = String(server.name).slice(0, 80);
      if (icon) state.icon = icon;
      if (server && server.name) state.serverName = String(server.name).slice(0, 80);
      ((server && server.channels) || []).forEach(function (ch) {
        const channel = byId[snowflake(ch && ch.id)];
        if (!channel) return;
        if (ch.name) channel.name = String(ch.name).slice(0, 80);
        if (ch.category) channel.category = String(ch.category).slice(0, 80);
        if (ch.file && /^discord\/messages\/\d{1,22}\.json$/.test(ch.file)) channel.file = ch.file;
        channel.inaccessible = !!ch.inaccessible;
        channel.pinsForbidden = !!ch.pinsForbidden;
      });
    });
    noteShared();
  }

  function docPathOk(path) {
    return /^discord\/(?:index|state|vk|messages\/\d{1,22}(?:\/p\/\d{1,4})?|pins\/\d{1,22}|x\/(?:index|messages\/\d{15,22}(?:\/p\/\d{1,4})?))\.json$/.test(String(path || ""));
  }

  function accountsBase() {
    try {
      const host = typeof window !== "undefined" ? window : null;
      if (host && host.ViktorychAccounts && host.ViktorychAccounts.currentApi) {
        const cur = host.ViktorychAccounts.currentApi();
        if (cur) return cur;
      }
      const api = host && host.VIKTORYCH_ACCOUNTS && (host.VIKTORYCH_ACCOUNTS.api || host.VIKTORYCH_ACCOUNTS.backupApi);
      return String(api || "").replace(/\/$/, "");
    } catch (err) {
      return "";
    }
  }

  function accountsToken() {
    try {
      const host = typeof window !== "undefined" ? window : null;
      const accounts = host && host.ViktorychAccounts;
      return accounts && accounts.token ? String(accounts.token() || "") : "";
    } catch (err) {
      return "";
    }
  }

  function docDb() {
    return new Promise(function (resolve) {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      let request;
      try { request = indexedDB.open(DOC_DB, 1); }
      catch (err) { resolve(null); return; }
      request.onupgradeneeded = function () {
        const db = request.result;
        if (db && !db.objectStoreNames.contains(DOC_STORE)) db.createObjectStore(DOC_STORE);
      };
      request.onsuccess = function () { resolve(request.result || null); };
      request.onerror = function () { resolve(null); };
    });
  }

  function cacheGet(path) {
    return docDb().then(function (db) {
      if (!db) return null;
      return new Promise(function (resolve) {
        try {
          const request = db.transaction(DOC_STORE, "readonly").objectStore(DOC_STORE).get(path);
          request.onsuccess = function () { resolve(request.result || null); };
          request.onerror = function () { resolve(null); };
        } catch (err) { resolve(null); }
      });
    });
  }

  function cachePut(path, row) {
    return docDb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          const tx = db.transaction(DOC_STORE, "readwrite");
          tx.objectStore(DOC_STORE).put(row, path);
          tx.oncomplete = function () { resolve(); };
          tx.onerror = function () { resolve(); };
        } catch (err) { resolve(); }
      });
    });
  }

  function fetchDoc(path, etag) {
    const headers = { Accept: "application/json" };
    if (etag) headers["If-None-Match"] = etag;
    const api = accountsBase();
    const token = accountsToken();
    const workerUrl = api && token ? api + "/v1/data/" + path : "";
    const same = function () {
      if (typeof window !== "undefined" && window.ViktorychDirect && window.ViktorychDirect.fetch) {
        return window.ViktorychDirect.fetch(path, "", { headers: headers });
      }
      return fetch(path, { cache: "no-cache", headers: headers });
    };
    const worker = function () {
      if (typeof window !== "undefined" && window.ViktorychDirect && window.ViktorychDirect.noteServer) window.ViktorychDirect.noteServer();
      return fetch(workerUrl, {
        cache: "no-store",
        headers: Object.assign({ Authorization: "Bearer " + token }, headers)
      });
    };
    // Servers the owner picked live only in the private bucket, never on Pages.
    if (/^discord\/x\//.test(path)) return workerUrl ? worker().then(noteRate) : Promise.reject(new Error("signed out"));
    return same().then(function (res) {
      if (res && res.status === 429) return noteRate(res);
      if (res && (res.status === 200 || res.status === 304)) return res;
      if (!workerUrl) return res;
      if (res && res.status && res.status < 500 && res.status !== 404) return res;
      return worker().then(noteRate);
    }, function () {
      return workerUrl ? worker().then(noteRate) : Promise.reject(new Error("network"));
    });
  }

  function loadDoc(path, onBody) {
    if (!docPathOk(path) || typeof fetch !== "function") return Promise.resolve(null);
    return cacheGet(path).then(function (cached) {
      const stale = cached && cached.body && typeof cached.body === "object" ? cached.body : null;
      if (stale) onBody(stale, false);
      return fetchDoc(path, cached && cached.etag).then(function (res) {
        if (!res || res.status === 304) {
          onBody(stale, true);
          return stale;
        }
        if (!res.ok) {
          onBody(stale, true);
          return stale;
        }
        return res.json().then(function (doc) {
          if (!doc || typeof doc !== "object") {
            onBody(stale, true);
            return stale;
          }
          const tag = res.headers && res.headers.get ? (res.headers.get("ETag") || "") : "";
          cachePut(path, { body: doc, etag: tag, saved: Date.now() });
          onBody(doc, true);
          return doc;
        });
      });
    }).catch(function () {
      onBody(null, true);
      return null;
    });
  }

  /* A copy for the first paint. The full index stays in the IndexedDB doc
     cache; a big one is not copied to localStorage, which is for settings. */
  const INDEX_LOCAL_MAX = 60000;
  function rememberIndex(index) {
    if (!index || typeof index !== "object") return;
    try {
      const text = JSON.stringify(index);
      if (text.length > INDEX_LOCAL_MAX) localStorage.removeItem(INDEX_KEY);
      else localStorage.setItem(INDEX_KEY, text);
    }
    catch (err) { /* private mode can refuse */ }
  }

  function warmCache() {
    if (state.warmed || state.fixture || state.holdServers) return;
    state.warmed = true;
    let index = null;
    try { index = JSON.parse(readLocal(INDEX_KEY) || "null"); }
    catch (err) { index = null; }
    if (!index || !Array.isArray(index.servers) || !index.servers.length) return;
    applyConfig(index.servers);
    applyIndex(index);
  }

  function mergeHot(id, doc) {
    const incoming = Array.isArray(doc.messages) ? doc.messages : [];
    const prev = state.files[id] || { messages: [], authors: {} };
    const authors = Object.assign({}, prev.authors || {}, doc.authors || {});
    const bucket = new Map();
    if (doc.older) {
      let oldest = "";
      incoming.forEach(function (row) {
        const mid = snowflake(row && row.id);
        if (!mid) return;
        if (!oldest || cmpId(mid, oldest) < 0) oldest = mid;
      });
      (prev.messages || []).forEach(function (row) {
        const mid = snowflake(row && row.id);
        if (mid && oldest && cmpId(mid, oldest) < 0) bucket.set(mid, row);
      });
    }
    incoming.forEach(function (row) {
      const mid = snowflake(row && row.id);
      if (mid) bucket.set(mid, row);
    });
    const messages = Array.from(bucket.values());
    messages.sort(function (a, b) { return cmpId(b.id, a.id); });
    state.files[id] = { messages: messages.slice(0, WINDOW), authors: authors, older: !!doc.older };
    state.olderNext[id] = doc.older ? (state.olderNext[id] || 1) : 0;
    rememberMessages();
  }

  function mergeOlder(id, doc) {
    const prev = state.files[id] || { messages: [], authors: {} };
    const authors = Object.assign({}, prev.authors || {}, doc.authors || {});
    const bucket = new Map();
    (prev.messages || []).forEach(function (row) {
      const mid = snowflake(row && row.id);
      if (mid) bucket.set(mid, row);
    });
    (doc.messages || []).forEach(function (row) {
      const mid = snowflake(row && row.id);
      if (mid) bucket.set(mid, row);
    });
    const messages = Array.from(bucket.values());
    messages.sort(function (a, b) { return cmpId(b.id, a.id); });
    state.files[id] = { messages: messages.slice(0, WINDOW), authors: authors, older: true };
    rememberMessages();
  }

  function paintChannel(id) {
    if (state.open !== id || typeof document === "undefined") return;
    rememberList();
    repaintLog();
    bindLog();
    restoreList();
  }

  function applyOlder(id, pageNo, doc) {
    const log = typeof document !== "undefined" ? document.querySelector(".dmsgs-log") : null;
    const before = log ? log.scrollHeight : 0;
    const prevTop = log ? log.scrollTop : 0;
    mergeOlder(id, doc);
    state.olderGot[id] = state.olderGot[id] || {};
    state.olderGot[id][pageNo] = true;
    state.olderNext[id] = doc.older ? pageNo + 1 : 0;
    noteShared();
    if (state.open !== id || !log) return;
    repaintLog("keep");
    const next = document.querySelector(".dmsgs-log");
    if (!next) return;
    state.scrollLock = true;
    next.scrollTop = prevTop + (next.scrollHeight - before);
    state.scrollLock = false;
  }

  function loadOlder(id) {
    const pageNo = state.olderNext[id] || 0;
    if (!pageNo || state.olderLoading[id] || state.fixture || paced() || typeof fetch !== "function") return;
    const och = channelById(id);
    const stem = och && och.file && /\.json$/.test(och.file) ? och.file.replace(/\.json$/, "") : "discord/messages/" + id;
    const path = stem + "/p/" + pageNo + ".json";
    if (!docPathOk(path)) return;
    state.olderLoading[id] = true;
    loadDoc(path, function (doc, fresh) {
      if (!fresh) {
        if (doc && Array.isArray(doc.messages) && doc.messages.length) applyOlder(id, pageNo, doc);
        return;
      }
      state.olderLoading[id] = false;
      if (!doc || !Array.isArray(doc.messages) || !doc.messages.length) {
        if (!state.olderGot[id] || !state.olderGot[id][pageNo]) state.olderNext[id] = 0;
        return;
      }
      applyOlder(id, pageNo, doc);
    });
  }

  function takePins(id, doc) {
    const ch = channelById(id);
    const forbidden = !!(doc && doc.forbidden);
    const pins = [];
    ((doc && doc.pins) || []).forEach(function (row) {
      const mid = snowflake(row && row.id);
      if (!mid) return;
      pins.push({
        id: mid,
        author: String((row && row.author) || tr("Someone")).slice(0, 80),
        text: String((row && row.text) || "").slice(0, 180),
        date: String((row && row.date) || "").slice(0, 40)
      });
    });
    pins.sort(function (a, b) { return cmpId(b.id, a.id); });
    state.pinFiles[id] = { forbidden: forbidden, pins: pins };
    if (ch) ch.pinsForbidden = forbidden;
  }

  function ensurePins(id) {
    const ch = channelById(id);
    if (!ch || ch.mode !== "messages" || state.fixture || isVk(id) || ch.picked || paced() || state.pinFiles[id] || state.pinLoading[id]) return;
    if (typeof fetch !== "function") return;
    state.pinLoading[id] = true;
    loadDoc("discord/pins/" + id + ".json", function (doc, fresh) {
      if (!doc && !fresh) return;
      takePins(id, doc || { pins: [] });
      if (!fresh) return;
      state.pinLoading[id] = false;
      if (state.open === id || state.pinsOpen === id) {
        rememberList();
        replaceConv(false);
        restoreList();
      }
    });
  }

  function ensureChannel(id) {
    const ch = channelById(id);
    if (!ch || ch.mode !== "messages" || state.fixture || paced() || state.net[id]) return;
    if (typeof fetch !== "function") return;
    const path = ch.file && docPathOk(ch.file) ? ch.file : ("discord/messages/" + id + ".json");
    if (!docPathOk(path)) return;
    state.net[id] = true;
    if (!state.files[id]) state.loading[id] = true;
    loadDoc(path, function (doc, fresh) {
      if (doc && Array.isArray(doc.messages)) mergeHot(id, doc);
      else if (fresh && !state.files[id]) state.files[id] = { messages: [], authors: {} };
      if (doc || fresh) state.loading[id] = false;
      if (state.open === id && (doc || fresh)) paintChannel(id);
      if (doc || fresh) noteShared();
      if (doc && (isVk(id) || ch.picked) && state.open !== id && onMessages()) refreshInbox();
    });
  }

  function ensureLoad() {
    if (state.fixture || state.loadStarted) return;
    state.loadStarted = true;
    if (typeof fetch !== "function") {
      state.catalogReady = true;
      return;
    }
    let pending;
    try { pending = fetch("feeds.config.json", { cache: "no-cache" }); }
    catch (err) {
      state.catalogReady = true;
      return;
    }
    pending.then(function (res) { return res && res.ok ? res.json() : null; }).then(function (doc) {
      if (doc && Array.isArray(doc.discord)) { state.configList = doc.discord; applyConfig(doc.discord); }
      loadVk();
      watchPulse();
      loadPicked();
      if (root.DiscordPicks && root.DiscordPicks.ensureHealth) root.DiscordPicks.ensureHealth();
      return loadDoc("discord/index.json", function (index, fresh) {
        if (index) {
          applyIndex(index);
          rememberIndex(index);
        }
        state.catalogReady = true;
        if ((index || fresh) && onMessages()) refreshInbox();
        noteShared();
      });
    }).catch(function () {
      state.catalogReady = true;
      noteShared();
    });
  }

  /* VK channels (Worker cron, see worker/src/vk.js) join the Discord list as
     one more server. They have no live push, so an open VK channel and the
     list re-read every minute while the page is visible. */
  function isVk(id) { return /^99\d{12}$/.test(String(id || "")); }
  function loadVk() {
    return loadDoc("discord/vk.json", function (doc) {
      const vk = doc && Array.isArray(doc.servers) ? doc.servers.filter(function (server) { return server && /^99\d{13}$/.test(String(server.id || "")); }) : [];
      if (!vk.length) return;
      state.vkServers = vk;
      const before = state.channels.map(function (ch) { return ch.id; }).join(",");
      mergeExtras();
      // VK has no index.json, so read each channel once for its preview.
      state.channels.forEach(function (ch) { if (isVk(ch.id) && !state.files[ch.id]) ensureChannel(ch.id); });
      if (!onMessages()) return;
      // A new channel needs the whole list drawn again, not a repaint.
      if (before !== state.channels.map(function (ch) { return ch.id; }).join(",") && hooks().render) hooks().render();
      else refreshInbox();
    });
  }
  /* Keep whatever Discord servers are already listed when feeds.config.json
     gave none, then VK, then the servers the owner picked (discord/x/). */
  function mergeExtras() {
    const extra = {};
    (state.vkServers || []).concat(state.pickedServers || []).forEach(function (server) { extra[String(server.id)] = true; });
    const base = (state.configList && state.configList.length) ? state.configList : (state.servers || []).filter(function (server) { return !/^99\d{13}$/.test(String(server.id || "")) && !server.picked && !extra[String(server.id)]; });
    applyConfig(base.concat(state.vkServers || [], state.pickedServers || []));
  }

  /* Picked servers: discord_live.py writes discord/x/index.json with the
     newest id per channel. A pulse mark (worker/src/guard.js) says when it
     moved, so nothing here runs on a timer. */
  function loadPicked() {
    if (state.fixture || !accountsToken() || typeof fetch !== "function") return Promise.resolve(null);
    return loadDoc("discord/x/index.json", function (doc, fresh) {
      if (!doc && !fresh) return;
      const list = doc && Array.isArray(doc.servers) ? doc.servers : [];
      const picked = [];
      const lasts = {};
      list.forEach(function (server) {
        const id = String((server && server.id) || "");
        if (!/^\d{15,22}$/.test(id)) return;
        const channels = (server.channels || []).filter(function (ch) { return ch && /^\d{15,22}$/.test(String(ch.id || "")); }).map(function (ch) {
          if (ch.last) lasts[ch.id] = String(ch.last);
          return { id: String(ch.id), name: ch.name, category: ch.category, mode: "messages", inaccessible: !!ch.inaccessible };
        });
        picked.push({ id: id, name: server.name, icon: server.icon, picked: true, channels: channels });
      });
      const before = state.channels.map(function (ch) { return ch.id; }).join(",");
      const had = JSON.stringify(state.pickedServers || []);
      state.pickedServers = picked;
      if (had !== JSON.stringify(picked)) mergeExtras();
      state.channels.forEach(function (ch) {
        if (!ch.picked) return;
        const file = state.files[ch.id];
        const newest = file && file.messages && file.messages[0] ? String(file.messages[0].id) : "";
        if (!file || (lasts[ch.id] && lasts[ch.id] !== newest)) {
          state.net[ch.id] = false;
          ensureChannel(ch.id);
        }
      });
      if (!onMessages()) return;
      if (before !== state.channels.map(function (ch) { return ch.id; }).join(",") && hooks().render) hooks().render();
      else refreshInbox();
    });
  }
  // pulse.js loads after this file, so the listener joins on first use.
  function watchPulse() {
    if (state.pulseOn || typeof window === "undefined" || !window.ViktorychPulse || !window.ViktorychPulse.on) return;
    state.pulseOn = true;
    window.ViktorychPulse.on(function (keys) {
      if (!keys || !keys.indexOf) return;
      if (keys.indexOf("discord/x/index.json") >= 0 && state.loadStarted) loadPicked();
      if ((keys.indexOf("discord/x/catalog.json") >= 0 || keys.indexOf("discord/x/join.json") >= 0 || keys.indexOf("discord/x/health.json") >= 0) && root.DiscordPicks && root.DiscordPicks.onSignal) root.DiscordPicks.onSignal();
    });
  }

  function vkTick() {
    if (typeof document === "undefined" || document.visibilityState !== "visible" || !onMessages()) return;
    // Also when the first read missed (signed in later, or VK set up since).
    loadVk();
    (state.channels || []).forEach(function (ch) {
      if (!isVk(ch.id) || state.open !== ch.id) return;
      state.net[ch.id] = false;
      ensureChannel(ch.id);
    });
  }
  if (typeof setInterval === "function") setInterval(vkTick, 60000);
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hashchange", function () {
      if (!state.vkServers && state.loadStarted && !state.fixture && onMessages() && !paced()) loadVk();
    });
  }

  function onMessages() {
    try { return /^#\/messages(?:\/|\?|$)/.test(location.hash || ""); }
    catch (err) { return false; }
  }

  function wantLive() {
    if (typeof document === "undefined") return false;
    return document.visibilityState === "visible";
  }

  function closeSse() {
    if (state.source) {
      state.source.close();
      state.source = null;
    }
  }

  function stopLive() {
    closeSse();
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = 0;
    }
  }

  function ensureSince() {
    if (!state.since) state.since = String(Math.floor(Date.now() / 1000));
  }

  function handleNtfy(raw) {
    if (typeof raw !== "string" || raw.length > 20000) return;
    let note;
    try { note = JSON.parse(raw); }
    catch (err) { return; }
    if (!note || typeof note !== "object") return;
    if (note.topic && note.topic !== liveTopic()) return;
    if (note.id) state.since = String(note.id);
    if (note.event && note.event !== "message") return;
    if (typeof note.message !== "string" || note.message.length > 12000) return;
    let body;
    try { body = JSON.parse(note.message); }
    catch (err) { return; }
    deliver(body);
  }

  function schedulePoll() {
    if (state.timer || !wantLive()) return;
    const wait = state.backoff;
    state.backoff = Math.min(30000, state.backoff * 2);
    state.timer = setTimeout(poll, wait);
  }

  function poll() {
    state.timer = 0;
    if (!wantLive()) return;
    ensureSince();
    fetch("https://ntfy.sh/" + liveTopic() + "/json?poll=1&since=" + encodeURIComponent(state.since), { cache: "no-store" }).then(function (res) {
      if (res && res.status === 429) {
        state.backoff = Math.max(60000, state.backoff);
        throw new Error("429");
      }
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    }).then(function (text) {
      String(text || "").split("\n").forEach(function (line) {
        if (line.trim()) handleNtfy(line.trim());
      });
      state.backoff = 1500;
      if (wantLive()) openSse();
    }).catch(function () {
      schedulePoll();
    });
  }

  function openSse() {
    if (!wantLive() || state.source || state.timer) return;
    ensureSince();
    let es;
    try {
      es = new EventSource("https://ntfy.sh/" + liveTopic() + "/sse?since=" + encodeURIComponent(state.since));
    } catch (err) {
      schedulePoll();
      return;
    }
    state.source = es;
    es.addEventListener("message", function (event) {
      state.backoff = 1500;
      handleNtfy(event.data);
    });
    es.onerror = function () {
      closeSse();
      schedulePoll();
    };
  }

  function refreshLive() {
    if (wantLive()) openSse();
    else stopLive();
  }

  function clearHold() {
    if (state.hold) clearTimeout(state.hold);
    state.hold = 0;
  }

  function pageZoom() {
    try {
      if (typeof getComputedStyle !== "function" || !document.body) return 1;
      const z = parseFloat(getComputedStyle(document.body).zoom);
      return isFinite(z) && z > 0 ? z : 1;
    } catch (err) {
      return 1;
    }
  }

  function openMenu(id, x, y, durations) {
    const z = pageZoom();
    state.menu = { id: id, durations: !!durations, x: x / z, y: y / z };
    state.pinsOpen = "";
    if (!repaintMenu() && hooks().render) hooks().render();
    nudgeMenu();
  }

  function nudgeMenu() {
    const menu = document.querySelector(".dmsgs-menu");
    if (!menu) return;
    try {
      if (window.matchMedia && window.matchMedia("(max-width: 699px)").matches) return;
    } catch (err) { /* keep the pointer position */ }
    const z = pageZoom();
    const box = menu.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    let dx = 0;
    let dy = 0;
    if (box.right > vw - 8) dx = vw - 8 - box.right;
    if (box.left + dx < 8) dx += 8 - (box.left + dx);
    if (box.bottom > vh - 8) dy = vh - 8 - box.bottom;
    if (box.top + dy < 8) dy += 8 - (box.top + dy);
    if (!dx && !dy) return;
    const left = (parseFloat(menu.style.left) || 0) + dx / z;
    const top = (parseFloat(menu.style.top) || 0) + dy / z;
    menu.style.left = Math.round(left) + "px";
    menu.style.top = Math.round(top) + "px";
    if (state.menu) {
      state.menu.x = left;
      state.menu.y = top;
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", refreshLive);
    document.addEventListener("input", function (event) {
      const input = event.target;
      if (!input || !input.classList || !input.classList.contains("dmsgs-q")) return;
      state.query = input.value || "";
      applyFilter();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!state.menu && !state.pinsOpen) return;
      state.menu = null;
      state.pinsOpen = "";
      if (hooks().render) hooks().render();
    });
    document.addEventListener("contextmenu", function (event) {
      const row = event.target && event.target.closest && event.target.closest(".dmsgs-ch-row");
      if (!row) return;
      const link = row.querySelector(".dmsgs-ch");
      const id = link && snowflake(link.getAttribute("data-ch"));
      if (!id) return;
      event.preventDefault();
      openMenu(id, event.clientX, event.clientY, false);
    });
    document.addEventListener("touchstart", function (event) {
      const row = event.target && event.target.closest && event.target.closest(".dmsgs-ch-row");
      if (!row || (event.target.closest && event.target.closest(".dmsgs-more"))) return;
      const link = row.querySelector(".dmsgs-ch");
      const id = link && snowflake(link.getAttribute("data-ch"));
      const touch = event.touches && event.touches[0];
      if (!id || !touch) return;
      const x = touch.clientX;
      const y = touch.clientY;
      clearHold();
      state.hold = setTimeout(function () {
        state.hold = 0;
        state.suppressClick = id;
        openMenu(id, x, y, false);
      }, 500);
    }, { passive: true });
    document.addEventListener("touchend", clearHold);
    document.addEventListener("touchmove", clearHold);
    document.addEventListener("touchcancel", clearHold);
    document.addEventListener("mousedown", function (event) {
      if (event.button !== 0) return;
      const el = event.target && event.target.closest && event.target.closest(".dmsgs-channels button");
      if (!el) return;
      event.preventDefault();
    }, true);
    document.addEventListener("click", function (event) {
      const nav = event.target && event.target.closest && event.target.closest("a.dmsgs-ch, a.dmsgs-back");
      if (nav && nav.closest("[data-discord-root]")) {
        if (state.suppressClick && nav.classList.contains("dmsgs-ch") && nav.getAttribute("data-ch") === state.suppressClick) {
          state.suppressClick = "";
          event.preventDefault();
          return;
        }
        event.preventDefault();
        state.holding = true;
        rememberList();
        rememberWindow();
        followHash(nav.getAttribute("href"));
        return;
      }
      if (state.suppressClick) state.suppressClick = "";
      const jump = event.target && event.target.closest && event.target.closest(".dmsgs-jump");
      if (jump) {
        const log = document.querySelector(".dmsgs-log");
        if (!log) return;
        log.scrollTop = log.scrollHeight;
        state.stick = true;
        jump.hidden = true;
        if (state.open) markSeen(state.open);
        updateDots();
        return;
      }
      const btn = event.target && event.target.closest && event.target.closest("[data-discord]");
      if (!btn) {
        if ((state.menu || state.pinsOpen) && !(event.target && event.target.closest && event.target.closest(".dmsgs-menu, .dmsgs-pinpanel"))) {
          const pins = state.pinsOpen;
          state.menu = null;
          state.pinsOpen = "";
          repaintMenu();
          if (pins) replaceConv(false);
        }
        return;
      }
      const kind = btn.getAttribute("data-discord");
      if (kind === "menu-close" || kind === "pins-close") {
        event.preventDefault();
        if (kind === "menu-close") state.menu = null;
        else state.pinsOpen = "";
        repaintMenu();
        if (kind === "pins-close") replaceConv(false);
        return;
      }
      if (kind === "jump") {
        event.preventDefault();
        state.jump = snowflake(btn.getAttribute("data-mid"));
        state.pinsOpen = "";
        replaceConv(false);
        const target = state.jump && document.querySelector('.dmsg[data-mid="' + state.jump + '"]');
        state.jump = "";
        if (target) scrollLogToMessage(target);
        restoreList();
        return;
      }
      if (kind === "customize" || kind === "customize-done") {
        event.preventDefault();
        state.customize = kind === "customize";
        state.menu = null;
        if (hooks().render) hooks().render();
        return;
      }
      const id = snowflake(btn.getAttribute("data-id") || btn.getAttribute("data-server"));
      if (!id) return;
      event.preventDefault();
      const stored = prefs();
      if (kind === "srv-up" || kind === "srv-down" || kind === "srv-hide" || kind === "ch-hide" || kind === "ch-private" || kind === "ch-mute" || (kind === "mute-server" && state.customize)) {
        if (kind === "srv-up" || kind === "srv-down") moveServer(id, kind === "srv-up" ? -1 : 1);
        else if (kind === "srv-hide") toggleId(listFor("hiddenServers"), id);
        else if (kind === "ch-hide") toggleId(listFor("hiddenChannels"), id);
        else if (kind === "ch-private") toggleId(listFor("privateChannels"), id);
        else if (kind === "mute-server") toggleId(stored.mutedServers, id);
        else if (muteUntil(id) != null) clearChannelMute(id);
        else setChannelMute(id, 0);
        savePrefs();
        state.menu = null;
        paintNavBadge();
        if (state.customize) {
          if (hooks().render) hooks().render();
          return;
        }
        repaintMenu();
        if (!repaintChannels() && hooks().render) hooks().render();
        return;
      }
      if (kind === "switch") {
        Object.keys(stored.expanded).forEach(function (key) { delete stored.expanded[key]; });
        stored.expanded[id] = true;
        savePrefs();
        document.querySelectorAll(".dmsgs-sw-btn").forEach(function (el) {
          const on = el.getAttribute("data-server") === id;
          el.classList.toggle("on", on);
          el.setAttribute("aria-pressed", on ? "true" : "false");
        });
        state.listHold = 0;
        if (!repaintChannels() && hooks().render) hooks().render();
        const section = document.querySelector('.dmsgs-srv[data-server="' + id + '"]');
        const list = listEl();
        if (section && list) list.scrollTop = Math.max(0, section.offsetTop - list.offsetTop);
        return;
      }
      if (kind === "toggle") {
        const willOpen = !stored.expanded[id];
        const list = listEl();
        if (!willOpen && list) {
          state.listHold = list.scrollTop;
          writeScroll("list", list.scrollTop);
          writeScroll("server:" + id, list.scrollTop);
        }
        if (stored.expanded[id]) delete stored.expanded[id];
        else stored.expanded[id] = true;
        savePrefs();
        const section = document.querySelector('.dmsgs-srv[data-server="' + id + '"]');
        if (section) {
          const open = !!(stored.expanded[id] || state.query);
          state.scrollLock = true;
          state.holding = true;
          section.classList.toggle("open", open);
          const main = section.querySelector(".dmsgs-srv-main");
          if (main) main.setAttribute("aria-expanded", open ? "true" : "false");
          if (open) restoreList();
          state.scrollLock = false;
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(function () {
              if (stored.expanded[id] || state.query) restoreList();
              else state.holding = false;
            });
          } else if (!open) state.holding = false;
        } else if (!repaintChannels() && hooks().render) hooks().render();
        return;
      } else if (kind === "pin-server") {
        toggleId(stored.pinnedServers, id);
        savePrefs();
      } else if (kind === "mute-server") {
        toggleId(stored.mutedServers, id);
        savePrefs();
      } else if (kind === "menu") {
        const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : { left: 16, bottom: 64 };
        openMenu(id, rect.left, rect.bottom + 4, false);
        return;
      } else if (kind === "pin-channel") {
        toggleId(stored.pinnedChannels, id);
        state.menu = null;
        savePrefs();
      } else if (kind === "mute-menu") {
        if (!state.menu) state.menu = { id: id, durations: true, x: 16, y: 64 };
        else { state.menu.durations = true; state.menu.id = id; }
      } else if (kind === "mute-for") {
        const ms = Number(btn.getAttribute("data-ms"));
        if (ms === 0 || (isFinite(ms) && ms > 0)) setChannelMute(id, ms === 0 ? 0 : Date.now() + ms);
        state.menu = null;
      } else if (kind === "unmute-channel") {
        clearChannelMute(id);
        state.menu = null;
      } else if (kind === "pins") {
        state.pinsOpen = state.pinsOpen === id ? "" : id;
        state.menu = null;
        if (state.pinsOpen) ensurePins(id);
      } else {
        return;
      }
      paintNavBadge();
      rememberList();
      if (!repaintChannels()) {
        if (hooks().render) hooks().render();
        return;
      }
      if (kind === "pins") replaceConv(false);
      repaintMenu();
      restoreList();
    });
    armMuteTimer();
    paintNavBadge();
    refreshLive();
  }

  function bind(next) { state.bound = next || null; }

  function rememberMessages() {
    const local = root.ViktorychLocal;
    if (!local || !local.saveDoc) return;
    const channels = (state.channels || []).filter(function (ch) { return ch && ch.mode === "messages"; }).slice(0, 40).map(function (ch) {
      return { id: ch.id, name: ch.name || "", mode: "messages" };
    });
    local.saveDoc("messages", "channels", { channels: channels });
    channels.forEach(function (ch) {
      const rows = messagesFor(ch.id).slice(0, 30).map(function (row) {
        return { id: row.id, text: row.body || "", name: row.name || "", date: row.date || "" };
      });
      if (rows.length) local.saveDoc("messages", "channel:" + ch.id, { id: ch.id, messages: rows });
    });
  }

  function inbox() {
    warmCache();
    ensureLoad();
    const channels = (state.channels || []).filter(function (ch) {
      return ch && ch.mode === "messages" && !ch.inaccessible;
    }).map(function (ch) {
      const last = messagesFor(ch.id)[0] || null;
      return {
        id: ch.id,
        name: ch.name || "",
        category: ch.category || "",
        preview: last ? (channelPrivate(ch.id) ? tr("New message") : String(last.body || "")) : "",
        author: last && !channelPrivate(ch.id) ? String(last.name || "") : ""
      };
    });
    return { ready: !!(state.catalogReady || channels.length), channels: channels };
  }

  function sharedThread(id) {
    const key = snowflake(id);
    warmCache();
    ensureLoad();
    if (key) ensureChannel(key);
    const ch = key ? channelById(key) : null;
    const found = !!(ch && ch.mode === "messages" && !ch.inaccessible);
    return {
      id: key || "",
      name: ch ? ch.name : "",
      place: ch ? (ch.category || "") : "",
      found: found,
      loading: !!(key && state.loading[key]),
      messages: found ? messagesFor(key).slice().reverse() : []
    };
  }

  root.FeedsDiscord = {
    bind: bind,
    start: start,
    page: page,
    titleFor: titleFor,
    inbox: inbox,
    /* Newest chats from the local cache only (no network), for quick menus. */
    recent: function (limit) {
      warmCache();
      const rows = (state.channels || []).filter(function (ch) {
        return ch && ch.mode === "messages" && !ch.inaccessible;
      }).map(function (ch) {
        const last = messagesFor(ch.id)[0] || null;
        return {
          id: ch.id,
          name: ch.name || "",
          preview: last ? String(last.body || "") : "",
          author: last ? String(last.name || "") : "",
          lastId: last ? String(last.id || "") : "",
          href: channelHref(ch.id)
        };
      });
      rows.sort(function (a, b) { return cmpId(b.lastId, a.lastId); });
      return rows.slice(0, Math.max(1, Number(limit) || 4));
    },
    thread: sharedThread,
    unreadText: function (id) {
      const rows = messagesFor(id);
      if (!rows.length) return [];
      const seen = seenMap()[id] || "";
      const fresh = rows.filter(function (row) { return cmpId(row.id, seen) > 0; });
      return (fresh.length ? fresh : rows.slice(0, 20)).map(function (row) { return row.body || ""; }).filter(Boolean).slice(0, 30);
    },
    mount: mount,
    _validate: validate,
    _format: format,
    _accept: accept,
    _ids: function (channelId) { return messagesFor(channelId).map(function (row) { return row.id; }); },
    _setChannels: function (channels) {
      adoptServers([{ id: "1", name: "Discord", channels: channels || [] }]);
    },
    _setServers: function (servers) { state.holdServers = true; adoptServers(servers); },
    _setPrefs: function (next) { state.prefs = next || emptyPrefs(); },
    _prefs: function () { return prefs(); },
    _serverOrder: function (all) { return serverOrder(all).map(function (server) { return server.id; }); },
    _moveServer: moveServer,
    _customize: function (on) { state.customize = !!on; },
    _applyIndex: applyIndex,
    _openMenu: function (id, durations) { state.menu = { id: String(id || ""), durations: !!durations, x: 24, y: 72 }; },
    _openPins: function (id) { state.pinsOpen = String(id || ""); state.menu = null; },
    syncFromHash: syncFromHash,
    _deliver: deliver,
    snapshot: rememberMessages,
    alertSnapshot: alertSnapshot,
    _reloadPicked: loadPicked,
    _repaintKey: function () {
      if (!onMessages()) return;
      if (!repaintChannels() && hooks().render) hooks().render();
    }
  };
})(typeof window !== "undefined" ? window : globalThis);
