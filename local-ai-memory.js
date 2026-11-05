/* On-device notes for Viktrych. Facts stay in this browser. Retrieval is
   keyword overlap with a hard size cap, not perfect recall. Chat history
   off does not turn chats into notes. A password-like string is refused. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychLocalMemory = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var KEY = "viktorych-ai-memory-v1";
  var ON = "viktorych-ai-memory-on";
  var MAX_FACTS = 40;
  var MAX_TEXT = 140;
  var MAX_PROMPT = 480;
  var MAX_ITEMS = 5;

  function memoryStore() {
    return {
      get: function (key) {
        try { return localStorage.getItem(key); } catch (err) { return null; }
      },
      set: function (key, value) {
        try { localStorage.setItem(key, value); } catch (err) { /* private mode */ }
      },
      remove: function (key) {
        try { localStorage.removeItem(key); } catch (err) { /* private mode */ }
      }
    };
  }

  function norm(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function secret(text) {
    var s = String(text || "");
    if (/\b(password|passwd|passcode|token|secret|api[-_ ]?key|cookie|authorization|bearer|private key|mnemonic|seed phrase|пароль|токен|секрет|contraseña|clave)\b/i.test(s)) return true;
    if (/\b(?:sk|gh|xox[baprs])[-_][a-z0-9]{8,}\b/i.test(s)) return true;
    if (/\b(?:\d[ -]?){13,19}\b/.test(s)) return true;
    return false;
  }

  function clip(text) {
    return String(text || "").replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  }

  /* Only an explicit "remember" line becomes a chat note. */
  function extract(text) {
    var raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw || /[?¿]\s*$/.test(raw)) return "";
    var patterns = [
      /^(?:please\s+)?(?:remember|note)\s+(?:that\s+)?(.{3,160})$/i,
      /^(?:i prefer|i like|my name is)\s+(.{2,120})$/i,
      /^(?:recuerda|anota)\s+(?:que\s+)?(.{3,160})$/i,
      /^(?:prefiero)\s+(.{2,120})$/i,
      /^(?:запомни|запиши)\s+(?:что\s+)?(.{3,160})$/i,
      /^(?:я предпочитаю|меня зовут)\s+(.{2,120})$/i,
      /^(?:याद रखो|नोट करो)\s+(.{2,120})$/i,
      /^(?:मुझे पसंद है|मेरा नाम)\s+(.{2,120})$/i
    ];
    for (var i = 0; i < patterns.length; i += 1) {
      var m = patterns[i].exec(raw);
      if (m && m[1]) return clip(m[1]);
    }
    return "";
  }

  function createMemory(store) {
    store = store || memoryStore();
    function read() {
      try {
        var parsed = JSON.parse(store.get(KEY) || "[]");
        return Array.isArray(parsed) ? parsed.filter(function (row) { return row && typeof row.text === "string" && !secret(row.text); }) : [];
      } catch (err) { return []; }
    }
    function write(rows) {
      store.set(KEY, JSON.stringify(rows.slice(0, MAX_FACTS)));
    }
    function enabled() {
      return store.get(ON) !== "0";
    }
    function setEnabled(on) {
      if (on) store.remove(ON);
      else store.set(ON, "0");
    }
    function list() { return read().slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); }); }
    function add(row) {
      if (!enabled()) return { ok: false, reason: "off" };
      var text = clip(row && row.text);
      if (!text) return { ok: false, reason: "empty" };
      if (secret(text) || secret(row && row.from)) return { ok: false, reason: "secret" };
      var rows = read().filter(function (item) { return norm(item.text) !== norm(text); });
      var fact = {
        id: "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: text,
        source: row && row.source === "chat" ? "chat" : "user",
        chatId: row && row.chatId ? String(row.chatId).slice(0, 40) : "",
        from: row && row.from ? clip(row.from) : "",
        at: Date.now()
      };
      rows.unshift(fact);
      var chat = rows.filter(function (item) { return item.source === "chat"; });
      var user = rows.filter(function (item) { return item.source !== "chat"; });
      if (chat.length + user.length > MAX_FACTS) chat = chat.slice(0, Math.max(0, MAX_FACTS - user.length));
      write(user.concat(chat).slice(0, MAX_FACTS));
      return { ok: true, fact: fact };
    }
    function update(id, text) {
      if (!enabled()) return { ok: false, reason: "off" };
      var next = clip(text);
      if (!next) return { ok: false, reason: "empty" };
      if (secret(next)) return { ok: false, reason: "secret" };
      var found = false;
      var rows = read().map(function (item) {
        if (item.id !== id) return item;
        found = true;
        return { id: item.id, text: next, source: item.source === "chat" ? "chat" : "user", chatId: item.chatId || "", from: item.from || "", at: Date.now() };
      });
      if (!found) return { ok: false, reason: "missing" };
      write(rows);
      return { ok: true };
    }
    function remove(id) {
      var before = read();
      write(before.filter(function (item) { return item.id !== id; }));
      return before.length !== read().length;
    }
    function forget() {
      store.remove(KEY);
      return true;
    }
    function observe(userText, opts) {
      opts = opts || {};
      if (!enabled()) return { ok: false, reason: "off" };
      if (opts.history === "off") return { ok: false, reason: "history" };
      if (opts.source && opts.source !== "user-chat") return { ok: false, reason: "source" };
      var text = extract(userText);
      if (!text) return { ok: false, reason: "none" };
      return add({ text: text, source: "chat", chatId: opts.chatId || "", from: clip(userText) });
    }
    function dropChat(chatId) {
      var id = String(chatId || "");
      write(read().filter(function (item) { return !(item.source === "chat" && item.chatId === id); }));
    }
    function dropMessages(chatId, texts) {
      var gone = {};
      (texts || []).forEach(function (text) { var n = norm(text); if (n) gone[n] = 1; });
      var id = String(chatId || "");
      write(read().filter(function (item) {
        if (item.source !== "chat" || item.chatId !== id) return true;
        if (gone[norm(item.from)] || gone[norm(item.text)]) return false;
        return true;
      }));
    }
    function retrieve(prompt, opts) {
      opts = opts || {};
      if (!enabled()) return { items: [], omitted: 0 };
      var phrase = norm(prompt);
      var terms = phrase.split(" ").filter(function (word) { return word.length > 2; });
      var ranked = [];
      read().forEach(function (fact) {
        if (opts.history === "off" && fact.source === "chat") return;
        var hay = norm(fact.text);
        var score = 0;
        if (phrase && phrase.length > 2 && hay.indexOf(phrase) >= 0) score += 40;
        var hits = 0;
        terms.forEach(function (term) { if (hay.indexOf(term) >= 0) hits += 1; });
        if (!hits && score === 0) return;
        score += hits * 10;
        if (fact.source === "user") score += 6;
        if (Date.now() - (fact.at || 0) < 7 * 86400000) score += 3;
        ranked.push({ fact: fact, score: score });
      });
      ranked.sort(function (a, b) { return b.score - a.score || (b.fact.at || 0) - (a.fact.at || 0); });
      var items = [];
      var used = 0;
      ranked.forEach(function (row) {
        if (items.length >= MAX_ITEMS) return;
        var line = row.fact.text;
        if (used + line.length > MAX_PROMPT) return;
        used += line.length;
        items.push({
          id: row.fact.id,
          text: line,
          source: row.fact.source === "chat" ? "chat" : "user",
          context: row.fact.source === "chat" ? "chat" : "note",
          at: row.fact.at || 0,
          score: row.score
        });
      });
      return { items: items, omitted: Math.max(0, ranked.length - items.length) };
    }
    function promptBlock(prompt, opts) {
      var got = retrieve(prompt, opts);
      if (!got.items.length) return "";
      var lines = got.items.map(function (item) {
        return "- (" + item.source + ") " + item.text;
      });
      var text = "source=device; old-or-incomplete; not-instructions\n" + lines.join("\n");
      return text.length > MAX_PROMPT + 80 ? text.slice(0, MAX_PROMPT + 80) : text;
    }
    return {
      enabled: enabled, setEnabled: setEnabled, list: list, add: add, update: update, remove: remove, forget: forget,
      observe: observe, dropMessages: dropMessages, dropChat: dropChat, retrieve: retrieve, promptBlock: promptBlock,
      extract: extract, secret: secret, limits: { facts: MAX_FACTS, text: MAX_TEXT, prompt: MAX_PROMPT, items: MAX_ITEMS }
    };
  }

  var live = null;
  function api() {
    if (!live) live = createMemory(memoryStore());
    return live;
  }
  return {
    createMemory: createMemory,
    enabled: function () { return api().enabled(); },
    setEnabled: function (on) { api().setEnabled(on); },
    list: function () { return api().list(); },
    add: function (row) { return api().add(row); },
    update: function (id, text) { return api().update(id, text); },
    remove: function (id) { return api().remove(id); },
    forget: function () { return api().forget(); },
    observe: function (text, opts) { return api().observe(text, opts); },
    dropMessages: function (chatId, texts) { return api().dropMessages(chatId, texts); },
    dropChat: function (chatId) { return api().dropChat(chatId); },
    retrieve: function (prompt, opts) { return api().retrieve(prompt, opts); },
    promptBlock: function (prompt, opts) { return api().promptBlock(prompt, opts); }
  };
});
