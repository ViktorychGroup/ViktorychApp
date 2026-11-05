/* Local chat search and message deletion for Viktrych. No network.
   Search reads titles and message text already on the device. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychLocalChat = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function norm(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function snippet(text, focus, phrase) {
    var raw = String(text || "").replace(/\s+/g, " ").trim();
    var at = focus < 0 ? 0 : focus;
    var start = Math.max(0, at - 36);
    var end = Math.min(raw.length, start + 120);
    var slice = raw.slice(start, end);
    var lower = slice.toLowerCase();
    var needle = String(phrase || "").toLowerCase();
    var hit = needle ? lower.indexOf(needle) : -1;
    var pad = start > 0 ? 1 : 0;
    var ranges = [];
    if (hit >= 0) ranges.push({ start: hit + pad, end: hit + pad + needle.length });
    return { text: (start > 0 ? "…" : "") + slice + (end < raw.length ? "…" : ""), ranges: ranges };
  }

  function parts(snip) {
    var text = snip && snip.text ? snip.text : "";
    var ranges = (snip && snip.ranges) || [];
    if (!ranges.length) return [{ text: text, hit: false }];
    var out = [];
    var cursor = 0;
    ranges.forEach(function (range) {
      var a = Math.max(0, Math.min(text.length, range.start));
      var b = Math.max(a, Math.min(text.length, range.end));
      if (a > cursor) out.push({ text: text.slice(cursor, a), hit: false });
      if (b > a) out.push({ text: text.slice(a, b), hit: true });
      cursor = b;
    });
    if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
    return out;
  }

  function search(chats, query, limit) {
    var phrase = norm(query);
    if (!phrase || phrase.length > 200) return [];
    var terms = phrase.split(" ").filter(Boolean);
    var cap = limit || 20;
    var out = [];
    (chats || []).forEach(function (chat) {
      if (!chat) return;
      var title = String(chat.title || "");
      var titleHay = norm(title);
      var titleHit = titleHay.indexOf(phrase) >= 0;
      var messages = chat.msgs || [];
      var any = false;
      messages.forEach(function (msg, index) {
        if (!msg || (msg.role !== "user" && msg.role !== "ai")) return;
        var text = String(msg.text || "");
        var hay = norm(text);
        if (!hay) return;
        var at = hay.indexOf(phrase);
        var all = true;
        var first = -1;
        terms.forEach(function (term) {
          var pos = hay.indexOf(term);
          if (pos < 0) all = false;
          else if (first < 0 || pos < first) first = pos;
        });
        if (at < 0 && !all) return;
        any = true;
        var score = 0;
        if (hay === phrase) score += 100;
        else if (at === 0) score += 40;
        else if (at >= 0) score += 30;
        if (all) score += terms.length * 8;
        if (titleHit) score += 8;
        var focus = at >= 0 ? at : first;
        out.push({
          chatId: chat.id,
          index: index,
          role: msg.role,
          title: title,
          score: score,
          snippet: snippet(text, focus, phrase),
          needle: phrase
        });
      });
      if (!any && titleHit) {
        out.push({
          chatId: chat.id,
          index: 0,
          role: "title",
          title: title,
          score: 12,
          snippet: snippet(title, titleHay.indexOf(phrase), phrase),
          needle: phrase
        });
      }
    });
    out.sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    return out.slice(0, cap);
  }

  function resolve(chat, hit) {
    if (!chat || !hit) return -1;
    var needle = norm(hit.needle || "");
    var msg = (chat.msgs || [])[hit.index];
    if (msg && hit.role !== "title" && norm(msg.text).indexOf(needle) >= 0 && msg.role === hit.role) return hit.index;
    var found = -1;
    (chat.msgs || []).forEach(function (item, index) {
      if (found >= 0 || !item) return;
      if (needle && norm(item.text).indexOf(needle) >= 0 && (hit.role === "title" || item.role === hit.role)) found = index;
    });
    return found;
  }

  function needsConfirm(count) {
    return count > 1;
  }

  function deleteMessages(chat, indexes) {
    var msgs = (chat && chat.msgs) || [];
    var drop = {};
    (indexes || []).forEach(function (index) { drop[index] = 1; });
    var kept = [];
    var removed = [];
    msgs.forEach(function (msg, index) {
      if (drop[index]) removed.push({ index: index, msg: msg });
      else kept.push(msg);
    });
    var user = null;
    kept.forEach(function (msg) {
      if (!user && msg && msg.role === "user" && String(msg.text || "").trim()) user = msg;
    });
    var title = user ? String(user.text).trim().slice(0, 60) : (kept.length ? String(chat.title || "") : "");
    return { msgs: kept, title: title, removed: removed, empty: kept.length === 0 };
  }

  function restore(stash) {
    if (!stash) return null;
    return { id: stash.id, title: stash.title || "", at: stash.at || 0, msgs: (stash.msgs || []).slice() };
  }

  return { search: search, snippet: snippet, parts: parts, resolve: resolve, needsConfirm: needsConfirm, deleteMessages: deleteMessages, restore: restore };
});
