/* Typed app actions Viktrych may prepare. Each one is checked against the
   words the person typed. Nothing here posts, sends, or deletes an account.
   Block and mute reuse the same people parser as the settings assistant. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychAppActions = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";
  var PAGES = [
    { id: "home", hash: "#/", words: ["home", "inicio", "главную", "главная", "होम"] },
    { id: "following", hash: "#/following", words: ["following", "siguiendo", "подписки", "फ़ॉलोइंग"] },
    { id: "explore", hash: "#/explore", words: ["explore", "explorar", "обзор", "एक्सप्लोर"] },
    { id: "notifications", hash: "#/notifications", words: ["notifications", "notificaciones", "уведомления", "सूचना"] },
    { id: "messages", hash: "#/messages", words: ["messages", "mensajes", "сообщения", "संदेश"] },
    { id: "lists", hash: "#/lists", words: ["lists", "listas", "списки", "सूची"] },
    { id: "bookmarks", hash: "#/bookmarks", words: ["bookmarks", "guardados", "закладки", "बुकमार्क"] },
    { id: "history", hash: "#/history", words: ["history", "historial", "история", "इतिहास"] },
    { id: "settings", hash: "#/settings", words: ["settings", "ajustes", "configuración", "настройки", "सेटिंग"] },
    { id: "display", hash: "#/settings/display", words: ["display", "pantalla", "оформление", "डिस्प्ले"] },
    { id: "ai", hash: "#/ai", words: ["local ai", "viktrych"] }
  ];
  var NAV = ["open", "go", "abrir", "abre", "ir", "открой", "открыть", "перейди", "खोलो", "जाओ"];
  var custom = [];
  var HASHES = {};
  PAGES.forEach(function (page) { HASHES[page.hash] = page; });

  function localAi() {
    if (root && root.ViktorychLocalAI && root.ViktorychLocalAI.parsePeople) return root.ViktorychLocalAI;
    if (typeof require === "function") {
      try { return require("./local-ai.js"); } catch (err) { return null; }
    }
    return null;
  }
  function norm(text) { return String(text || "").toLowerCase(); }
  function tokens(text) { return norm(text).split(/[\s,.;:!?]+/).filter(Boolean); }
  function hasWord(text, words) {
    var hay = " " + norm(text) + " ";
    return words.some(function (word) { return hay.indexOf(word) >= 0; });
  }
  function near(text, word) {
    var list = tokens(text);
    var at = -1;
    list.forEach(function (token, index) { if (at < 0 && token.indexOf(word) >= 0) at = index; });
    if (at < 0) return false;
    return list.slice(Math.max(0, at - 4), at + 5).some(function (token) { return NAV.indexOf(token) >= 0; });
  }
  function quoted(text) {
    var match = /["“”«»']([^"“”«»']{1,80})["“”«»']/.exec(String(text || ""));
    return match ? match[1].trim() : "";
  }
  function cleanName(value) {
    return String(value || "").replace(/^["“”«»']+|["“”«»']+$/g, "").replace(/[.,].*$/, "").trim();
  }
  function called(text) {
    var match = /(?:called|named|llamad[oa]|называется|नाम)\s+(.{1,40})/i.exec(String(text || ""));
    return match ? cleanName(match[1]) : "";
  }
  function nameIn(text, name) {
    var value = String(name || "").trim();
    return !!value && value.length <= 40 && String(text || "").indexOf(value) >= 0;
  }
  function step(name, extra) {
    var row = { channel: "app", name: name, needsConfirm: true, effect: "mutate", risk: "app" };
    Object.keys(extra || {}).forEach(function (key) { row[key] = extra[key]; });
    return row;
  }
  function navSteps(text) {
    var out = [];
    PAGES.forEach(function (page) {
      page.words.forEach(function (word) {
        if (out.length) return;
        if (norm(text).indexOf(word) >= 0 && near(text, word.split(" ")[0])) {
          out.push(step("nav.open", { effect: "nav", hash: page.hash, pageId: page.id }));
        }
      });
    });
    return out;
  }
  function composeStep(text) {
    if (!/draft|compose|write a post|write a comment|borrador|redacta|черновик|напиши пост|ड्राफ्ट|पोस्ट लिखो/i.test(text)) return null;
    var body = "";
    var colon = /[:：]\s*(.{1,500})$/.exec(text);
    if (colon) body = colon[1].trim();
    if (!body) body = quoted(text);
    if (!body || text.indexOf(body) < 0) return null;
    return step("compose.draft", { effect: "draft", text: body.slice(0, 500), posted: false });
  }
  function listStep(text) {
    if (!/list|lista|список|सूची/i.test(text) || !/create|new|make|crear|nueva|создай|новый|बनाओ|नई/i.test(text)) return null;
    var name = called(text) || quoted(text);
    if (!nameIn(text, name)) return null;
    return step("list.draft", { effect: "draft", listName: name.slice(0, 40), saved: false });
  }
  function tabName(text) {
    var named = called(text) || quoted(text);
    if (named) return named;
    var match = /(?:tab|pestaña|вкладк\w*|टैब)\s+(.{1,40})/i.exec(String(text || ""));
    return match ? cleanName(match[1].replace(/\s+(?:to|on|from)\b[\s\S]*$/i, "")) : "";
  }
  function findTab(ctx, name) {
    var wanted = String(name || "").trim().toLowerCase();
    var tabs = (ctx && ctx.tabs) || [];
    for (var i = 0; i < tabs.length; i += 1) {
      if (String(tabs[i].name || "").trim().toLowerCase() === wanted) return tabs[i];
    }
    return null;
  }
  function tabSteps(text, ctx) {
    var out = [];
    var name = tabName(text);
    if (/create|new|add|crear|nueva|создай|новый|बनाओ|नई/i.test(text) && /tab|pestaña|вкладк|टैब/i.test(text) && nameIn(text, name) && !findTab(ctx, name)) {
      out.push(step("tab.create", { tabName: name.slice(0, 40) }));
    }
    if (/tab|pestaña|вкладк|टैब/i.test(text) && /switch|open|abrir|открой|खोलो/i.test(text)) {
      if (/following|siguiendo|подписки/i.test(text)) out.push(step("tab.switch", { effect: "nav", tab: "following", tabName: "following" }));
      else if (/for you|para ti|для вас/i.test(text)) out.push(step("tab.switch", { effect: "nav", tab: "foryou", tabName: "foryou" }));
      else if (nameIn(text, name)) {
        var found = findTab(ctx, name);
        if (found) out.push(step("tab.switch", { effect: "nav", tab: "custom", tabId: found.id, tabName: found.name }));
      }
    }
    if (/close|cerrar|закрой|बंद/i.test(text) && /tab|pestaña|вкладк|टैब/i.test(text) && nameIn(text, name)) {
      var closing = findTab(ctx, name);
      if (closing) out.push(step("tab.close", { tabId: closing.id, tabName: closing.name }));
    }
    var rename = /rename\s+.+?\s+to\s+(.{1,40})/i.exec(text);
    if (rename && nameIn(text, name) && nameIn(text, rename[1].trim())) {
      var target = findTab(ctx, name);
      if (target) out.push(step("tab.customize", { tabId: target.id, tabName: target.name, nextName: rename[1].trim().slice(0, 40) }));
    }
    if (/hide/i.test(text) && nameIn(text, name)) {
      var hide = findTab(ctx, name);
      if (hide) out.push(step("tab.customize", { tabId: hide.id, tabName: hide.name, showHome: false }));
    }
    return out;
  }
  function peopleSteps(text) {
    var engine = localAi();
    if (!engine || !engine.parsePeople) return [];
    return engine.parsePeople(text).map(function (row) {
      var action = (row.on ? "" : "un") + row.act;
      return step("person." + action, { handle: row.handle, on: !!row.on, act: row.act, preview: action });
    });
  }
  function propose(text, ctx) {
    text = String(text || "");
    var out = peopleSteps(text).concat(navSteps(text));
    var compose = composeStep(text);
    var list = listStep(text);
    if (compose) out.push(compose);
    if (list) out.push(list);
    out = out.concat(tabSteps(text, ctx || {}));
    custom.forEach(function (row) {
      var built = null;
      try { built = row.validate(text, ctx || {}); } catch (err) { built = null; }
      if (!built || built.name !== row.id) return;
      var made = step(row.id, built);
      made.needsConfirm = true;
      made.posted = false;
      made.effect = row.effect || "draft";
      out.push(made);
    });
    return out;
  }
  function same(a, b) {
    if (!a || !b || a.name !== b.name) return false;
    if (a.hash && b.hash && a.hash !== b.hash) return false;
    if (a.handle && b.handle && a.handle !== b.handle) return false;
    if (a.text && b.text && a.text !== b.text) return false;
    if (a.listName && b.listName && a.listName !== b.listName) return false;
    if (a.tabName && b.tabName && a.tabName !== b.tabName) return false;
    if (typeof a.on === "boolean" && typeof b.on === "boolean" && a.on !== b.on) return false;
    return true;
  }
  function review(steps, opts) {
    opts = opts || {};
    var accepted = [];
    var rejected = [];
    var allowed = propose(opts.typed, opts.ctx || {});
    if (opts.source !== "user-chat") {
      (steps || []).forEach(function (step) { rejected.push({ step: step, why: "source" }); });
      return { accepted: [], rejected: rejected };
    }
    (steps || []).forEach(function (item) {
      var match = null;
      allowed.forEach(function (row) { if (!match && same(row, item)) match = row; });
      if (!match && item && item.name) {
        allowed.forEach(function (row) { if (!match && row.name === item.name && !item.hash && !item.handle && !item.text && !item.tabName) match = row; });
      }
      if (!match) { rejected.push({ step: item, why: "untyped" }); return; }
      if (match.hash && !HASHES[match.hash]) {
        var profileOk = match.name === "nav.profile" && /^#\/@[A-Za-z0-9_]{1,20}$/.test(match.hash) && String(opts.typed || "").toLowerCase().indexOf(String(match.handle || "").toLowerCase()) >= 0;
        if (!profileOk) { rejected.push({ step: item, why: "route" }); return; }
      }
      if (match.posted === true) { rejected.push({ step: item, why: "post" }); return; }
      accepted.push(match);
    });
    return { accepted: accepted, rejected: rejected };
  }
  function accepts(item, typed, ctx) {
    return review([item], { source: "user-chat", typed: typed, ctx: ctx || {} }).accepted.length === 1;
  }
  function register(def) {
    if (!def || typeof def.id !== "string" || typeof def.validate !== "function" || typeof def.preview !== "function") return { ok: false, reason: "shape" };
    if (/post|send|delete|logout|publish/i.test(def.id)) return { ok: false, reason: "blocked" };
    if (def.effect === "mutate" && def.needsConfirm === false) return { ok: false, reason: "confirm" };
    if (custom.some(function (row) { return row.id === def.id; })) return { ok: false, reason: "reserved" };
    custom.push({ id: def.id, effect: def.effect || "draft", needsConfirm: def.needsConfirm !== false, risk: def.risk || "app", validate: def.validate, preview: def.preview });
    return { ok: true };
  }
  function catalog() {
    var builtins = ["nav.open", "compose.draft", "list.draft", "tab.create", "tab.switch", "tab.close", "tab.customize", "person.block", "person.mute", "person.unblock", "person.unmute"];
    return builtins.map(function (name) {
      return { name: name, needsConfirm: true, effect: name.indexOf("draft") >= 0 ? "draft" : (name.indexOf("nav") === 0 || name === "tab.switch" ? "nav" : "mutate") };
    }).concat(custom.map(function (row) { return { name: row.id, needsConfirm: row.needsConfirm, effect: row.effect }; }));
  }
  function resetCustom() { custom = []; }
  return { propose: propose, review: review, accepts: accepts, register: register, catalog: catalog, resetCustom: resetCustom, pages: PAGES };
});
