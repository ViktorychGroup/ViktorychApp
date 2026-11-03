/* @mention autocomplete for every composer textarea, like X: type @ and a
   few letters and a list opens under the caret. App accounts come from
   /v1/mentions/suggest (debounced, prefix, any case, people you follow
   first); followed outside accounts come after. Arrow keys, Enter, Tab,
   click and tap insert the handle. Touch rows act on touchend so iOS keeps
   the keyboard and the caret. */
(function () {
  "use strict";
  var DEBOUNCE = 120;
  var TOKEN = /(^|[^\w@])@([\w]{1,30})$/;
  var state = { el: null, start: 0, end: 0, query: "", items: [], active: 0, timer: 0, seq: 0 };
  var memo = {};
  var pop = null;

  function tr(text) { return window.SI18n && window.SI18n.t ? window.SI18n.t(text) : text; }
  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function eligible(el) {
    if (!el || el.tagName !== "TEXTAREA") return false;
    if (el.hasAttribute("data-no-mentions") || el.id === "list-desc") return false;
    return !el.disabled && !el.readOnly;
  }

  function tokenAt(el) {
    if (el.selectionStart !== el.selectionEnd) return null;
    var end = el.selectionStart;
    var before = el.value.slice(Math.max(0, end - 40), end);
    var hit = before.match(TOKEN);
    if (!hit) return null;
    return { start: end - hit[2].length - 1, end: end, query: hit[2] };
  }

  function localMatches(query) {
    var src = window.ViktorychMentionsLocal;
    if (!src || typeof src.search !== "function") return [];
    try { return src.search(query) || []; } catch (err) { return []; }
  }

  function remote(query) {
    var key = query.toLowerCase();
    if (memo[key]) return memo[key];
    var accounts = window.ViktorychAccounts;
    var token = accounts && accounts.token ? accounts.token() : "";
    if (!accounts || !accounts.call || !token) return Promise.resolve([]);
    memo[key] = accounts.call("/v1/mentions/suggest?q=" + encodeURIComponent(key), { token: token }).then(function (res) {
      if (!res || res.status !== 200 || !Array.isArray(res.accounts)) { delete memo[key]; return []; }
      var rows = res.accounts.map(function (row) { row.platform = "app"; return row; });
      if (res.hint === "cant_mention") rows.hint = true;
      return rows;
    }).catch(function () { delete memo[key]; return []; });
    return memo[key];
  }

  function merged(app, outside) {
    var seen = {};
    var out = [];
    app.concat(outside).forEach(function (row) {
      var handle = String(row && row.handle || "");
      if (!handle || seen[handle.toLowerCase()]) return;
      seen[handle.toLowerCase()] = true;
      out.push(row);
    });
    return out.slice(0, 8);
  }

  function badge(row) {
    var src = window.ViktorychMentionsLocal;
    return src && typeof src.badge === "function" ? src.badge(row) : "";
  }

  function shownName(row) {
    var raw = row.name || row.handle;
    var nk = (typeof window !== "undefined" ? window.ViktorychNick : null);
    return nk && row.handle ? nk.name(row.platform || "app", row.handle, raw) : raw;
  }

  function rowHtml(row, i) {
    var face = row.avatar ? '<img class="mention-av" alt="" src="' + esc(row.avatar) + '" width="40" height="40" loading="lazy" decoding="async">'
      : '<span class="mention-av mention-av-empty" aria-hidden="true">' + esc(String(row.name || row.handle || "?").slice(0, 1).toUpperCase()) + "</span>";
    return '<div class="mention-row' + (i === state.active ? " on" : "") + '" role="option" id="mention-opt-' + i + '" aria-selected="' + (i === state.active ? "true" : "false") + '" data-mention-index="' + i + '">'
      + face + '<span class="mention-copy"><span class="mention-name">' + esc(shownName(row)) + badge(row) + '</span><span class="mention-handle">@' + esc(row.handle) + "</span></span></div>";
  }

  /* Where the caret sits, by laying the text out again in a hidden copy. */
  function caretPoint(el, at) {
    var style = getComputedStyle(el);
    var copy = document.createElement("div");
    ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "textTransform", "wordSpacing", "tabSize"].forEach(function (key) { copy.style[key] = style[key]; });
    copy.style.position = "absolute";
    copy.style.visibility = "hidden";
    copy.style.whiteSpace = "pre-wrap";
    copy.style.wordWrap = "break-word";
    copy.style.top = "0";
    copy.style.left = "-9999px";
    copy.textContent = el.value.slice(0, at);
    var mark = document.createElement("span");
    mark.textContent = "\u200b";
    copy.appendChild(mark);
    document.body.appendChild(copy);
    var line = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.3;
    var box = el.getBoundingClientRect();
    var point = { x: box.left + mark.offsetLeft - el.scrollLeft, y: box.top + mark.offsetTop - el.scrollTop + line };
    copy.remove();
    return point;
  }

  function place() {
    if (!pop || !state.el) return;
    var point = caretPoint(state.el, state.start);
    var width = Math.min(320, window.innerWidth - 16);
    var left = Math.max(8, Math.min(point.x, window.innerWidth - width - 8));
    var vv = window.visualViewport;
    var bottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
    var top = point.y + 4;
    pop.style.width = width + "px";
    pop.style.left = (left + window.scrollX) + "px";
    pop.style.maxHeight = Math.max(120, Math.min(360, bottom - top - 8)) + "px";
    pop.style.top = (top + window.scrollY) + "px";
  }

  function paint() {
    if (!state.el || (!state.items.length && !state.hint)) { close(); return; }
    if (!pop) {
      pop = document.createElement("div");
      pop.className = "mention-pop";
      pop.setAttribute("role", "listbox");
      pop.addEventListener("mousedown", function (event) { event.preventDefault(); });
      pop.addEventListener("touchstart", function () { pop.dataset.touch = "1"; }, { passive: true });
      pop.addEventListener("touchend", function (event) {
        var row = event.target.closest && event.target.closest("[data-mention-index]");
        if (!row) return;
        event.preventDefault();
        pick(Number(row.getAttribute("data-mention-index")));
      });
      pop.addEventListener("click", function (event) {
        var row = event.target.closest && event.target.closest("[data-mention-index]");
        if (row) pick(Number(row.getAttribute("data-mention-index")));
      });
      document.body.appendChild(pop);
    }
    pop.setAttribute("aria-label", tr("Suggested accounts"));
    pop.innerHTML = state.items.length ? state.items.map(rowHtml).join("") : '<div class="mention-hint" role="status">' + esc(tr("You can't mention this account.")) + "</div>";
    pop.hidden = false;
    state.el.setAttribute("aria-autocomplete", "list");
    state.el.setAttribute("aria-activedescendant", "mention-opt-" + state.active);
    place();
  }

  function close() {
    clearTimeout(state.timer);
    state.seq += 1;
    state.items = [];
    state.hint = false;
    if (pop) { pop.hidden = true; pop.innerHTML = ""; }
    if (state.el) state.el.removeAttribute("aria-activedescendant");
  }

  function open() { return !!(pop && !pop.hidden && state.items.length); }

  function pick(i) {
    var row = state.items[i];
    var el = state.el;
    if (!row || !el) return;
    var text = "@" + row.handle + " ";
    el.focus();
    el.setRangeText(text, state.start, state.end, "end");
    close();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function lookup(el) {
    var tok = tokenAt(el);
    if (!tok) { close(); return; }
    state.el = el;
    state.start = tok.start;
    state.end = tok.end;
    state.query = tok.query;
    var seq = ++state.seq;
    var outside = localMatches(tok.query);
    if (outside.length && !state.items.length) {
      state.items = merged([], outside);
      state.active = 0;
      paint();
    }
    clearTimeout(state.timer);
    state.timer = setTimeout(function () {
      remote(tok.query).then(function (app) {
        if (seq !== state.seq) return;
        state.items = merged(app, outside);
        state.hint = !!app.hint;
        state.active = 0;
        paint();
      });
    }, DEBOUNCE);
  }

  document.addEventListener("input", function (event) {
    var el = event.target;
    if (!eligible(el)) return;
    lookup(el);
  }, true);

  document.addEventListener("keydown", function (event) {
    if (!open() || event.target !== state.el) return;
    var key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      state.active = (state.active + (key === "ArrowDown" ? 1 : -1) + state.items.length) % state.items.length;
      paint();
    } else if ((key === "Enter" && !event.shiftKey && !event.isComposing) || key === "Tab") {
      pick(state.active);
    } else if (key === "Escape") {
      close();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  document.addEventListener("focusout", function (event) {
    if (event.target !== state.el) return;
    setTimeout(function () { if (document.activeElement !== state.el) close(); }, 150);
  }, true);
  document.addEventListener("selectionchange", function () {
    if (open() && document.activeElement === state.el && !tokenAt(state.el)) close();
  });
  window.addEventListener("resize", function () { if (open()) place(); }, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener("resize", function () { if (open()) place(); }, { passive: true });
  window.addEventListener("hashchange", close);

  window.ViktorychMentionSuggest = { close: close, tokenAt: tokenAt };
})();
