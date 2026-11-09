/* Emoji reactions on every post card, in the Facebook pattern:
   hold or hover Like for a floating bar of emoji that grow under the
   pointer, a "+" for any emoji, the picked emoji in place of the heart,
   a small left-aligned summary (top three emoji and a count) above the
   action row, and a "who reacted" sheet with one tab per emoji.
   A plain tap on Like still likes. Summaries load in batches for the
   cards on screen, are cached, and back off when the Worker says so. */
(function (root) {
  "use strict";

  var SETTINGS_KEY = "viktorychapp-settings-v1";
  var RECENT_KEY = "viktorychapp-reactions-recent-v1";
  var QUICK = [["like", "❤️"], ["👍", "👍"], ["😂", "😂"], ["😮", "😮"], ["😢", "😢"], ["😡", "😡"]];
  function quickName(i) { return [tr("Like"), tr("Thumbs up"), tr("Haha"), tr("Wow"), tr("Sad"), tr("Angry")][i]; }
  var TINT = { "❤️": "#f91880", "👍": "#1d9bf0", "😂": "#f7b928", "😮": "#f7b928", "😢": "#f7b928", "😡": "#e9710f" };
  function groupNames() { return [tr("Smileys & Emotion"), tr("People & Body"), tr("Animals & Nature"), tr("Food & Drink"), tr("Travel & Places"), tr("Activities"), tr("Objects"), tr("Symbols"), tr("Flags")]; }
  var BATCH = 50;
  var HOLD_MS = 380;
  var FAR_PX = 90;          // drag this far off the bar and release closes it (like Facebook)
  var drag = null;         // { pid, cur, far } while a touch hold slides across the bar
  var HOVER_MS = 550;
  var LEAVE_MS = 350;
  /* The data-saving value of the "reactionsData" setting. */
  var DATA_SAVING = "lite";

  var cache = {};          // key -> { s: summary, at: ms }
  var keys = {};           // post id -> key
  var waiting = {};        // post id -> true, queued for the next batch
  var inflight = {};       // key -> true
  var pausedUntil = 0;
  var flushTimer = 0;
  var io = null;
  var bar = null;
  var hold = null;
  var hoverTimer = 0;
  var leaveTimer = 0;
  var swallowClick = 0;
  var sheet = null;
  var emojiData = null;
  var settingsCache = null;
  var settingsAt = 0;
  var enterHold = null;

  function tr(key, vars) {
    var fn = root.t;
    var text = fn ? fn(key, vars) : key;
    if (!fn && vars) Object.keys(vars).forEach(function (name) { text = String(text).split("{" + name + "}").join(String(vars[name])); });
    return text;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function accounts() { return root.ViktorychAccounts || null; }
  function token() {
    try { var a = accounts(); return a && a.token ? a.token() : ""; } catch (err) { return ""; }
  }
  function call(path, opts) {
    var a = accounts();
    if (!a || !a.call || (a.hasApi && !a.hasApi())) return Promise.resolve({ status: 503 });
    opts = opts || {};
    var t = token();
    if (t) opts.token = t;
    return a.call(path, opts).catch(function () { return { status: 0 }; });
  }

  function settings() {
    var now = Date.now();
    if (settingsCache && now - settingsAt < 3000) return settingsCache;
    try { settingsCache = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; } catch (err) { settingsCache = {}; }
    settingsAt = now;
    return settingsCache;
  }
  function connection() { return (typeof navigator !== "undefined" && navigator.connection) || {}; }
  /* Data saving: summaries only, no pictures in the list, no fetching ahead. */
  function lite() {
    var s = settings();
    var mode = s.reactionsData || "auto";
    if (mode === "lite") return true;
    if (mode === "full") return false;
    if (s.saveData === true || s.saveData === "on" || s.dataSaver === true) return true;
    var c = connection();
    return !!(c.saveData || c.effectiveType === "slow-2g" || c.effectiveType === "2g");
  }
  function calm() {
    if (lite()) return true;
    if (document.documentElement.classList.contains("tv-on")) return true;
    try { return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (err) { return false; }
  }

  /* One emoji grapheme, or "" when the text is anything else. */
  function oneEmoji(text) {
    var value = String(text || "").trim();
    if (!value || value.length > 32) return "";
    if (root.Intl && Intl.Segmenter) {
      var parts = Array.from(new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value));
      if (parts.length !== 1) return "";
    }
    try {
      if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u.test(value)) return "";
      if (/[\p{L}\p{N}](?!\uFE0F|\u20E3)/u.test(value.replace(/^[#*0-9]\uFE0F?\u20E3$/, ""))) return "";
    } catch (err) { return ""; }
    // Keyboards often drop the emoji presentation selector.
    if (Array.from(value).length === 1 && !/\uFE0F/.test(value) && /^\p{Extended_Pictographic}$/u.test(value) && !/^\p{Emoji_Presentation}$/u.test(value)) value += "\uFE0F";
    return value;
  }

  function hex(buf) {
    var bytes = new Uint8Array(buf);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return out;
  }
  /* The post key: a hash of the post id, so the server never stores the id. */
  function keyFor(id) {
    if (keys[id]) return Promise.resolve(keys[id]);
    if (!root.crypto || !crypto.subtle || !root.TextEncoder) return Promise.resolve("");
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode("rx1|" + id)).then(function (buf) {
      keys[id] = hex(buf).slice(0, 32);
      return keys[id];
    }, function () { return ""; });
  }
  function ttl() { return lite() ? 10 * 60 * 1000 : 3 * 60 * 1000; }
  function fresh(key) {
    var hit = cache[key];
    return !!(hit && Date.now() - hit.at < ttl());
  }
  function summaryOf(id) {
    var key = keys[id];
    return key && cache[key] ? cache[key].s : null;
  }

  function likeButtons(id) {
    var list = document.querySelectorAll(".action.like[data-id]");
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute("data-id") === id) out.push(list[i]);
    return out;
  }

  function countText(n) {
    if (n >= 1000000) return (Math.round(n / 100000) / 10) + "M";
    if (n >= 10000) return Math.round(n / 1000) + "K";
    if (n >= 1000) return (Math.round(n / 100) / 10) + "K";
    return String(n);
  }

  /* Draws the viewer's emoji on Like; counts stay in the pop-up. */
  function paint(id) {
    var s = summaryOf(id);
    likeButtons(id).forEach(function (btn) {
      var me = s && s.me ? s.me : "";
      var ic = btn.querySelector(".ic");
      if (me) {
        if (ic && !btn.hasAttribute("data-rx-ic")) btn.setAttribute("data-rx-ic", ic.innerHTML);
        if (ic && btn.getAttribute("data-rx-me") !== me) {
          ic.innerHTML = '<span class="rx-me">' + esc(me) + "</span>";
          if (btn.getAttribute("data-rx-pop") === "1" && !calm()) { btn.classList.remove("rx-pop"); void btn.offsetWidth; btn.classList.add("rx-pop"); }
        }
        btn.removeAttribute("data-rx-pop");
        btn.setAttribute("data-rx-me", me);
        btn.classList.add("rx-on");
        btn.style.setProperty("--rx-tint", TINT[me] || "#f7b928");
        btn.setAttribute("aria-label", tr("Reacted with {emoji}", { emoji: me }) + ". " + tr("Remove reaction"));
      } else if (btn.hasAttribute("data-rx-me")) {
        if (ic && btn.hasAttribute("data-rx-ic")) ic.innerHTML = btn.getAttribute("data-rx-ic");
        btn.removeAttribute("data-rx-ic");
        btn.removeAttribute("data-rx-me");
        btn.classList.remove("rx-on", "rx-pop");
        btn.style.removeProperty("--rx-tint");
        btn.setAttribute("aria-label", tr("Like"));
      }
      if (!btn.hasAttribute("aria-haspopup")) {
        btn.setAttribute("aria-haspopup", "true");
        btn.setAttribute("aria-keyshortcuts", "Shift+F10");
      }
      /* Counts live only inside the reaction pop-up, never in the post. */
      var actions = btn.closest(".actions");
      var row = actions && actions.previousElementSibling;
      if (row && row.classList && row.classList.contains("rx-row")) row.parentNode.removeChild(row);
    });
  }

  /* Emoji + count chips shown under the quick picks in the pop-up. */
  function countsHtml(id, s) {
    if (!s || !s.t || !s.top || !s.top.length) return "";
    var chips = s.top.map(function (row) { return '<span class="rx-cnt"><span class="rx-cnt-e">' + esc(row[0]) + '</span><span class="rx-cnt-n">' + esc(countText(Number(row[1]) || 0)) + "</span></span>"; }).join("");
    var names = s.top.map(function (row) { return row[0] + " " + row[1]; }).join(", ");
    return '<button type="button" class="rx-counts" data-rx-who="' + esc(id) + '" aria-label="' + esc(tr("{n} reactions", { n: s.t }) + (names ? ": " + names : "")) + '">' + chips + '<span class="rx-cnt-t">' + esc(countText(s.t)) + "</span></button>";
  }

  function queue(id) {
    waiting[id] = true;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 300);
  }

  function flush() {
    flushTimer = 0;
    if (document.hidden) { flushTimer = setTimeout(flush, 2000); return; }
    if (Date.now() < pausedUntil) { flushTimer = setTimeout(flush, pausedUntil - Date.now()); return; }
    var ids = Object.keys(waiting);
    waiting = {};
    if (!ids.length) return;
    Promise.all(ids.map(function (id) { return keyFor(id).then(function (key) { return [id, key]; }); })).then(function (pairs) {
      var want = [];
      var byKey = {};
      pairs.forEach(function (pair) {
        var id = pair[0], key = pair[1];
        if (!key) return;
        (byKey[key] = byKey[key] || []).push(id);
        if (fresh(key)) { paint(id); return; }
        if (!inflight[key] && want.indexOf(key) < 0) want.push(key);
      });
      for (var i = 0; i < want.length; i += BATCH) send(want.slice(i, i + BATCH), byKey);
    });
  }

  function send(list, byKey) {
    list.forEach(function (key) { inflight[key] = true; });
    call("/v1/reactions/batch", { method: "POST", body: { keys: list } }).then(function (res) {
      list.forEach(function (key) { delete inflight[key]; });
      if (!res || res.status === 429 || res.status >= 500 || !res.status) {
        pausedUntil = Date.now() + (res && res.status === 429 ? 60000 : 30000);
        return;
      }
      var got = (res && res.r) || {};
      var now = Date.now();
      list.forEach(function (key) {
        cache[key] = { s: normalize(got[key]), at: now };
        (byKey[key] || []).forEach(paint);
      });
    });
  }

  function normalize(s) {
    s = s || {};
    return { t: Number(s.t) || 0, top: Array.isArray(s.top) ? s.top.slice(0, 3) : [], me: String(s.me || "") };
  }

  /* Watch new cards: cached summaries paint before the next frame, the rest
     load when the card comes near the screen. */
  function scan() {
    var list = document.querySelectorAll(".action.like[data-id]:not([data-rx-seen])");
    for (var i = 0; i < list.length; i++) {
      var btn = list[i];
      var id = btn.getAttribute("data-id");
      btn.setAttribute("data-rx-seen", "1");
      if (!id) continue;
      if (keys[id] && fresh(keys[id])) { paint(id); continue; }
      if (io) io.observe(btn);
      else queue(id);
    }
  }

  function watch() {
    if (root.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          queue(entry.target.getAttribute("data-id"));
        });
      }, { rootMargin: lite() ? "0px" : "800px 0px" });
    }
    var pending = false;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      Promise.resolve().then(function () { pending = false; scan(); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
  }

  /* ---------- writing ---------- */

  function toast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.hidden = true; }, 1800);
  }

  function setReaction(id, emoji) {
    if (!token()) { toast(tr("Sign in to react")); return; }
    keyFor(id).then(function (key) {
      if (!key) return;
      var before = cache[key] ? normalize(cache[key].s) : { t: 0, top: [], me: "" };
      var next = applyLocal(before, before.me, emoji);
      cache[key] = { s: next, at: Date.now() };
      likeButtons(id).forEach(function (btn) { btn.setAttribute("data-rx-pop", "1"); });
      paint(id);
      call("/v1/reactions", { method: emoji ? "PUT" : "DELETE", body: emoji ? { key: key, emoji: emoji } : { key: key } }).then(function (res) {
        if (res && res.status === 200 && res.summary) {
          cache[key] = { s: normalize(res.summary), at: Date.now() };
          paint(id);
          return;
        }
        cache[key] = { s: before, at: Date.now() };
        paint(id);
        toast(res && res.status === 429 ? tr("Slow down a little and try again.") : tr("Couldn't save your reaction"));
      });
    });
    if (emoji) remember(emoji);
  }

  /* The summary after swapping the viewer's emoji. Pure, for tests. */
  function applyLocal(s, oldEmoji, newEmoji) {
    var counts = {};
    var order = [];
    (s.top || []).forEach(function (row) { counts[row[0]] = Number(row[1]) || 0; order.push(row[0]); });
    var total = Number(s.t) || 0;
    if (oldEmoji) {
      total -= 1;
      if (counts[oldEmoji]) counts[oldEmoji] -= 1;
    }
    if (newEmoji) {
      total += 1;
      if (counts[newEmoji] == null) { counts[newEmoji] = 0; order.push(newEmoji); }
      counts[newEmoji] += 1;
    }
    var top = order.filter(function (e) { return counts[e] > 0; }).map(function (e) { return [e, counts[e]]; });
    top.sort(function (a, b) { return b[1] - a[1]; });
    return { t: Math.max(0, total), top: top.slice(0, 3), me: newEmoji || "" };
  }

  function remember(emoji) {
    try {
      var list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
      if (!Array.isArray(list)) list = [];
      list = [emoji].concat(list.filter(function (e) { return e !== emoji; })).slice(0, 16);
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (err) { /* private mode */ }
  }
  function recent() {
    try { var list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(list) ? list.slice(0, 16) : []; } catch (err) { return []; }
  }

  /* ---------- the floating bar ---------- */

  function openBar(btn, byKey) {
    closeBar(false);
    var id = btn.getAttribute("data-id");
    var actions = btn.closest(".actions");
    if (!id || !actions) return;
    var s = summaryOf(id);
    var me = s && s.me ? s.me : "";
    var liked = btn.classList.contains("on");
    var items = QUICK.map(function (q, n) {
      var on = q[0] === "like" ? (liked && !me) : me === q[0];
      return '<button type="button" class="rx-pick' + (on ? " on" : "") + '" data-rx-pick="' + esc(q[0]) + '" aria-label="' + esc(quickName(n)) + '" aria-pressed="' + (on ? "true" : "false") + '" data-tip="' + esc(quickName(n)) + '"><span>' + q[1] + "</span></button>";
    }).join("");
    var el = document.createElement("div");
    el.className = "menu rx-bar" + (calm() ? " rx-calm" : "");
    el.setAttribute("role", "toolbar");
    el.setAttribute("aria-label", tr("Reactions"));
    el.setAttribute("data-act", "stop");
    var counts = countsHtml(id, s);
    if (counts) el.className += " rx-has-counts";
    el.innerHTML = '<div class="rx-picks">' + items + '<button type="button" class="rx-pick rx-more" data-rx-pick="+" aria-label="' + esc(tr("More emoji")) + '" data-tip="' + esc(tr("More emoji")) + '"><span>+</span></button></div>' + counts;
    actions.classList.add("rx-host");
    actions.appendChild(el);
    var left = Math.max(0, btn.offsetLeft - 12);
    var room = actions.clientWidth - el.offsetWidth;
    el.style.left = Math.max(0, Math.min(left, room)) + "px";
    var rect = btn.getBoundingClientRect();
    if (rect.top < el.offsetHeight + 70) el.classList.add("rx-below");
    bar = { el: el, btn: btn, id: id };
    if (byKey) {
      var first = el.querySelector(".rx-pick.on") || el.querySelector(".rx-pick");
      if (first) first.focus();
    }
  }

  function closeBar(refocus) {
    clearTimeout(leaveTimer);
    if (!bar) return;
    var was = bar;
    bar = null;
    if (was.el.parentNode) was.el.parentNode.removeChild(was.el);
    if (refocus && was.btn && document.contains(was.btn)) was.btn.focus();
  }

  function pick(value) {
    if (!bar) return;
    var id = bar.id;
    var btn = bar.btn;
    if (value === "+") { closeBar(false); openPicker(id, btn); return; }
    closeBar(true);
    var s = summaryOf(id);
    var me = s && s.me ? s.me : "";
    if (value === "like") {
      if (me) setReaction(id, "");
      if (!btn.classList.contains("on") && document.contains(btn)) { swallowClick = 0; btn.click(); }
      return;
    }
    setReaction(id, me === value ? "" : value);
  }

  /* ---------- the emoji picker ---------- */

  function loadEmoji() {
    if (emojiData) return Promise.resolve(emojiData);
    return fetch("data/emoji.json").then(function (res) { return res.json(); }).then(function (data) {
      emojiData = Array.isArray(data) ? data : [];
      return emojiData;
    }).catch(function () { return []; });
  }

  function openSheet(kind, html, back) {
    closeSheet(false);
    var el = document.createElement("div");
    el.className = "modal-back rx-back" + (calm() ? " rx-calm" : "");
    el.setAttribute("data-act", "stop");
    el.innerHTML = '<div class="modal rx-sheet rx-' + kind + '" role="dialog" aria-modal="true" aria-label="' + esc(kind === "picker" ? tr("More emoji") : tr("Reactions")) + '">' + html + "</div>";
    document.body.appendChild(el);
    sheet = { el: el, kind: kind, back: back };
    return el;
  }
  function closeSheet(refocus) {
    if (!sheet) return;
    var was = sheet;
    sheet = null;
    if (was.el.parentNode) was.el.parentNode.removeChild(was.el);
    if (refocus && was.back && document.contains(was.back)) was.back.focus();
  }
  function head(title) {
    return '<div class="modal-head"><button class="icon-btn rx-close" type="button" data-rx-close="1" aria-label="' + esc(tr("Close")) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.59 12 4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"/></svg></button><h2>' + esc(title) + "</h2></div>";
  }

  function openPicker(id, back) {
    var el = openSheet("picker", head(tr("More emoji")) +
      '<div class="rx-search"><input type="search" class="rx-q" autocomplete="off" enterkeyhint="done" placeholder="' + esc(tr("Search emoji")) + '" aria-label="' + esc(tr("Search emoji")) + '"></div>' +
      '<div class="rx-groups" role="tablist"></div><div class="rx-grid" role="listbox" aria-label="' + esc(tr("Emoji")) + '"><p class="rx-empty">' + esc(tr("Loading…")) + "</p></div>", back);
    sheet.id = id;
    sheet.group = recent().length ? -1 : 0;
    var input = el.querySelector(".rx-q");
    input.addEventListener("input", function () { drawPicker(); });
    setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (err) { input.focus(); } }, 0);
    loadEmoji().then(function () { if (sheet && sheet.el === el) drawPicker(); });
  }

  function cell(e, name) {
    return '<button type="button" class="rx-cell emo" role="option" data-rx-emoji="' + esc(e) + '" aria-label="' + esc(name || e) + '" title="' + esc(name || "") + '">' + esc(e) + "</button>";
  }

  function drawPicker() {
    if (!sheet || sheet.kind !== "picker") return;
    var el = sheet.el;
    var q = String(el.querySelector(".rx-q").value || "").trim();
    var data = emojiData || [];
    var chips = (recent().length ? [[-1, tr("Recent")]] : []).concat(groupNames().map(function (g, i) { return [i, g]; }));
    el.querySelector(".rx-groups").innerHTML = q ? "" : chips.map(function (c) {
      var sel = sheet.group === c[0];
      var icon = c[0] < 0 ? "🕘" : (data[c[0]] && data[c[0]][1][0] ? data[c[0]][1][0][0] : "");
      return '<button type="button" role="tab" class="rx-chip' + (sel ? " on" : "") + '" aria-selected="' + (sel ? "true" : "false") + '" data-rx-group="' + c[0] + '" aria-label="' + esc(c[1]) + '" title="' + esc(c[1]) + '">' + esc(icon) + "</button>";
    }).join("");
    var out = [];
    if (q) {
      var typed = oneEmoji(q);
      if (typed) out.push(cell(typed, tr("Use {emoji}", { emoji: typed })));
      var needle = q.toLowerCase();
      for (var g = 0; g < data.length && out.length < 240; g++) {
        var list = data[g][1];
        for (var i = 0; i < list.length && out.length < 240; i++) {
          if (list[i][1].indexOf(needle) >= 0 && list[i][0] !== typed) out.push(cell(list[i][0], list[i][1]));
        }
      }
    } else if (sheet.group < 0) {
      recent().forEach(function (e) { out.push(cell(e, e)); });
    } else if (data[sheet.group]) {
      data[sheet.group][1].forEach(function (row) { out.push(cell(row[0], row[1])); });
    }
    el.querySelector(".rx-grid").innerHTML = out.length ? out.join("") : '<p class="rx-empty">' + esc(emojiData ? tr("No emoji found") : tr("Loading…")) + "</p>";
    if (root.ViktorychEmoji) root.ViktorychEmoji.queue();
  }

  /* ---------- who reacted ---------- */

  function openWho(id, back) {
    keyFor(id).then(function (key) {
      if (!key) return;
      openSheet("who", head(tr("Reactions")) + '<div class="rx-tabs" role="tablist"></div><div class="rx-people"><p class="rx-empty">' + esc(tr("Loading…")) + "</p></div>", back);
      sheet.key = key;
      sheet.id = id;
      sheet.emoji = "";
      sheet.people = [];
      loadWho(false);
    });
  }

  function loadWho(more) {
    if (!sheet || sheet.kind !== "who") return;
    var at = sheet;
    var path = "/v1/reactions/who?key=" + at.key + (at.emoji ? "&emoji=" + encodeURIComponent(at.emoji) : "") + (lite() ? "&lite=1" : "") + (more && at.next ? "&before=" + at.next : "");
    call(path).then(function (res) {
      if (sheet !== at) return;
      if (!res || res.status !== 200) {
        at.el.querySelector(".rx-people").innerHTML = '<p class="rx-empty">' + esc(tr("Something went wrong. Try again.")) + "</p>";
        return;
      }
      if (!more) at.tabs = res.tabs || [];
      at.total = Number(res.total) || 0;
      at.people = (more ? at.people : []).concat(res.people || []);
      at.next = Number(res.next) || 0;
      drawWho();
    });
  }

  function drawWho() {
    var at = sheet;
    var tabs = [["", tr("All") + " " + countText(at.total || 0)]].concat((at.tabs || []).map(function (t) { return [t[0], t[0] + " " + countText(t[1])]; }));
    at.el.querySelector(".rx-tabs").innerHTML = tabs.map(function (t) {
      var sel = at.emoji === t[0];
      return '<button type="button" role="tab" class="rx-tab' + (sel ? " on" : "") + '" aria-selected="' + (sel ? "true" : "false") + '" data-rx-tab="' + esc(t[0]) + '">' + esc(t[1]) + "</button>";
    }).join("");
    var noPics = lite();
    var rows = at.people.map(function (p) {
      var name = p.me ? tr("You") : (p.name || tr("Someone"));
      var initial = Array.from(String(p.name || p.handle || "?"))[0] || "?";
      var pic = noPics ? "" : (p.avatar ? '<img class="rx-ava" src="' + esc(p.avatar) + '" alt="" loading="lazy" decoding="async">' : '<span class="rx-ava rx-ini" aria-hidden="true">' + esc(initial) + "</span>");
      var inner = '<span class="rx-pic">' + pic + '<span class="rx-badge" aria-hidden="true">' + esc(p.emoji) + '</span></span><span class="rx-who-text"><b>' + esc(name) + "</b>" + (p.handle ? "<small>@" + esc(p.handle) + "</small>" : "") + '</span><span class="rx-sr">' + esc(p.emoji) + "</span>";
      return p.handle ? '<a class="rx-person" href="#/@' + encodeURIComponent(p.handle) + '" data-rx-go="1">' + inner + "</a>" : '<div class="rx-person" tabindex="0">' + inner + "</div>";
    }).join("");
    var more = at.next ? '<button type="button" class="outline rx-more-people" data-rx-more="1">' + esc(tr("Show more")) + "</button>" : "";
    at.el.querySelector(".rx-people").innerHTML = rows ? rows + more : '<p class="rx-empty">' + esc(tr("No reactions yet")) + "</p>";
    if (at.el.classList) at.el.classList.toggle("rx-nopics", noPics);
  }

  /* ---------- input ---------- */

  function likeOf(target) {
    return target && target.closest ? target.closest(".action.like[data-id]") : null;
  }
  function inBar(target) { return !!(bar && target && bar.el.contains(target)); }

  function onPointerDown(event) {
    if (bar && !inBar(event.target) && likeOf(event.target) !== bar.btn) closeBar(false);
    var btn = likeOf(event.target);
    if (!btn || event.button > 0) return;
    if (event.pointerType === "mouse") return;
    var x = event.clientX, y = event.clientY;
    clearTimeout(hold && hold.timer);
    hold = { btn: btn, x: x, y: y, timer: setTimeout(function () {
      hold = null;
      swallowClick = Date.now();
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch (err) {} }
      openBar(btn, false);
      if (bar) { drag = { pid: event.pointerId, cur: null, far: false }; bar.el.classList.add("rx-dragging"); }
    }, HOLD_MS) };
  }
  /* Pure: is (x, y) further than FAR_PX outside rect? */
  function farFrom(rect, x, y) {
    var dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
    var dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    return Math.max(dx, dy) > FAR_PX;
  }
  function dragTo(x, y) {
    if (!drag || !bar) return;
    var el = document.elementFromPoint ? document.elementFromPoint(x, y) : null;
    var hit = el && el.closest ? el.closest(".rx-pick") : null;
    if (hit && !bar.el.contains(hit)) hit = null;
    drag.far = farFrom(bar.el.getBoundingClientRect(), x, y);
    if (hit === drag.cur) return;
    if (drag.cur) drag.cur.classList.remove("rx-hot");
    drag.cur = hit;
    if (hit) {
      hit.classList.add("rx-hot");
      if (navigator.vibrate) { try { navigator.vibrate(5); } catch (err) {} }
    }
  }
  function endDrag(event) {
    var was = drag;
    drag = null;
    if (!was) return false;
    if (bar) bar.el.classList.remove("rx-dragging");
    if (was.cur) was.cur.classList.remove("rx-hot");
    if (event && event.type === "pointercancel") return true;
    if (was.cur && bar && bar.el.contains(was.cur)) pick(was.cur.getAttribute("data-rx-pick"));
    else if (was.far) closeBar(false);
    return true;
  }
  function cancelHold(event) {
    if (hold) { clearTimeout(hold.timer); hold = null; }
    if (drag && event && event.pointerId === drag.pid) {
      if (event.type === "pointerup") endDrag(event);
      /* pointercancel: the touch stream carries on and touchend finishes the drag. */
    }
  }
  function onPointerMove(event) {
    if (drag && event.pointerId === drag.pid) { dragTo(event.clientX, event.clientY); return; }
    if (hold && (Math.abs(event.clientX - hold.x) > 10 || Math.abs(event.clientY - hold.y) > 10)) cancelHold();
  }
  function onTouchMove(event) {
    if (!drag) return;
    event.preventDefault();
    var t = event.touches && event.touches[0];
    if (t) dragTo(t.clientX, t.clientY);
  }
  function onTouchEnd(event) {
    if (!drag) return;
    var t = event.changedTouches && event.changedTouches[0];
    if (t) dragTo(t.clientX, t.clientY);
    endDrag(event);
  }
  function hoverable() {
    try { return root.matchMedia && root.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (err) { return false; }
  }
  function onPointerOver(event) {
    if (event.pointerType && event.pointerType !== "mouse") return;
    if (!hoverable() || document.documentElement.classList.contains("tv-on")) return;
    var btn = likeOf(event.target);
    if (btn || inBar(event.target)) clearTimeout(leaveTimer);
    if (btn && (!bar || bar.btn !== btn)) {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () { if (btn.matches(":hover")) openBar(btn, false); }, HOVER_MS);
    }
  }
  function onPointerOut(event) {
    if (event.pointerType && event.pointerType !== "mouse") return;
    var btn = likeOf(event.target);
    if (btn) clearTimeout(hoverTimer);
    if (!bar) return;
    var to = event.relatedTarget;
    if ((btn === bar.btn || inBar(event.target)) && !(to && (inBar(to) || likeOf(to) === bar.btn))) {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(function () { closeBar(false); }, LEAVE_MS);
    }
  }

  function onClick(event) {
    var target = event.target;
    var btn = likeOf(target);
    if (btn && swallowClick && Date.now() - swallowClick < 1200) {
      swallowClick = 0;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (btn && btn.classList.contains("rx-on") && !inBar(target)) {
      // Like FB: a tap on a picked reaction takes it back.
      event.preventDefault();
      event.stopPropagation();
      closeBar(false);
      setReaction(btn.getAttribute("data-id"), "");
      return;
    }
    var picked = target.closest && target.closest("[data-rx-pick]");
    if (picked && inBar(picked)) {
      event.preventDefault();
      event.stopPropagation();
      pick(picked.getAttribute("data-rx-pick"));
      return;
    }
    var who = target.closest && target.closest("[data-rx-who]");
    if (who) {
      event.preventDefault();
      event.stopPropagation();
      openWho(who.getAttribute("data-rx-who"), who);
      return;
    }
    if (!sheet || !sheet.el.contains(target)) return;
    event.stopPropagation();
    if (target === sheet.el || (target.closest && target.closest("[data-rx-close]"))) { event.preventDefault(); closeSheet(true); return; }
    var e = target.closest && target.closest("[data-rx-emoji]");
    if (e && sheet.kind === "picker") {
      event.preventDefault();
      var id = sheet.id;
      var value = e.getAttribute("data-rx-emoji");
      var s = summaryOf(id);
      closeSheet(true);
      setReaction(id, s && s.me === value ? "" : value);
      return;
    }
    var g = target.closest && target.closest("[data-rx-group]");
    if (g) { event.preventDefault(); sheet.group = Number(g.getAttribute("data-rx-group")); drawPicker(); var at = sheet.el.querySelector(".rx-chip.on"); if (at) at.focus(); return; }
    var tab = target.closest && target.closest("[data-rx-tab]");
    if (tab) { event.preventDefault(); sheet.emoji = tab.getAttribute("data-rx-tab"); sheet.people = []; sheet.next = 0; loadWho(false); return; }
    if (target.closest && target.closest("[data-rx-more]")) { event.preventDefault(); loadWho(true); return; }
    if (target.closest && target.closest("[data-rx-go]")) closeSheet(false);
  }

  function moveIn(list, current, step) {
    var at = list.indexOf(current);
    var next = list[Math.max(0, Math.min(list.length - 1, (at < 0 ? 0 : at + step)))];
    if (next) next.focus();
  }

  function onKeyDown(event) {
    var key = event.key || "";
    var target = event.target;
    if (key === "Escape" || key === "GoBack" || key === "BrowserBack" || event.keyCode === 10009 || event.keyCode === 461) {
      if (sheet) { event.preventDefault(); event.stopPropagation(); closeSheet(true); return; }
      if (bar) { event.preventDefault(); event.stopPropagation(); closeBar(true); return; }
      return;
    }
    if (bar && inBar(target)) {
      var picks = Array.prototype.slice.call(bar.el.querySelectorAll(".rx-pick"));
      if (key === "ArrowLeft" || key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); moveIn(picks, target, key === "ArrowLeft" ? -1 : 1); return; }
      if (key === "Home" || key === "End") { event.preventDefault(); event.stopPropagation(); (key === "Home" ? picks[0] : picks[picks.length - 1]).focus(); return; }
      if (/^[1-9]$/.test(key) && !event.ctrlKey && !event.metaKey && !event.altKey && picks[Number(key) - 1]) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) pick(picks[Number(key) - 1].getAttribute("data-rx-pick"));
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown" || key === "Tab") { event.preventDefault(); event.stopPropagation(); closeBar(true); return; }
      if (key === "Enter" || key === " " || key === "NumpadEnter" || event.keyCode === 13) {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat) pick(target.getAttribute("data-rx-pick"));
        return;
      }
      return;
    }
    if (sheet && sheet.el.contains(target) && sheet.kind === "picker" && target.classList && target.classList.contains("rx-cell")) {
      var cells = Array.prototype.slice.call(sheet.el.querySelectorAll(".rx-cell"));
      var cols = Math.max(1, Math.round(sheet.el.querySelector(".rx-grid").clientWidth / (target.offsetWidth || 40)));
      var step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -cols : key === "ArrowDown" ? cols : 0;
      if (step) {
        event.preventDefault(); event.stopPropagation();
        if (key === "ArrowUp" && cells.indexOf(target) < cols) { var chip = sheet.el.querySelector(".rx-chip.on") || sheet.el.querySelector(".rx-q"); if (chip) chip.focus(); return; }
        moveIn(cells, target, step);
        return;
      }
    }
    if (sheet && sheet.el.contains(target) && target.classList && (target.classList.contains("rx-chip") || target.classList.contains("rx-tab"))) {
      var row = Array.prototype.slice.call(target.parentNode.children);
      if (key === "ArrowLeft" || key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); moveIn(row, target, key === "ArrowLeft" ? -1 : 1); return; }
      if (key === "ArrowDown") {
        var first = sheet.el.querySelector(".rx-cell, .rx-person");
        if (first) { event.preventDefault(); event.stopPropagation(); first.focus(); }
        return;
      }
    }
    if (sheet && target && target.classList && target.classList.contains("rx-q") && key === "ArrowDown") {
      var f = sheet.el.querySelector(".rx-chip, .rx-cell");
      if (f) { event.preventDefault(); event.stopPropagation(); f.focus(); }
      return;
    }
    var btn = likeOf(target);
    if (!btn) return;
    if (key === "ContextMenu" || (key === "F10" && event.shiftKey)) {
      event.preventDefault(); event.stopPropagation();
      openBar(btn, true);
      return;
    }
    // Hold OK on a remote (or Enter on a keyboard) for the bar; a short press likes.
    if (key === "Enter" || key === "NumpadEnter" || key === "Accept" || event.keyCode === 13) {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || enterHold) {
        if (enterHold && !enterHold.opened) { clearTimeout(enterHold.timer); enterHold.opened = true; openBar(btn, true); }
        return;
      }
      enterHold = { btn: btn, opened: false, timer: setTimeout(function () {
        if (enterHold && !enterHold.opened) { enterHold.opened = true; openBar(btn, true); }
      }, HOLD_MS) };
    }
  }

  function onKeyUp(event) {
    var key = event.key || "";
    if (!enterHold || !(key === "Enter" || key === "NumpadEnter" || key === "Accept" || event.keyCode === 13)) return;
    var was = enterHold;
    enterHold = null;
    clearTimeout(was.timer);
    event.preventDefault();
    event.stopPropagation();
    if (!was.opened && document.contains(was.btn)) was.btn.click();
  }

  function onContextMenu(event) {
    var btn = likeOf(event.target);
    if (btn && (hold || bar || swallowClick)) event.preventDefault();
  }

  /* The Data usage row. app.js draws it and saves the choice. */
  function settingsHtml(mode) {
    var current = mode || "auto";
    var opt = function (id, label) { return '<button class="outline' + (current === id ? " on" : "") + '" type="button" data-act="reactions-data" data-mode="' + id + '">' + esc(label) + "</button>"; };
    return "<h2>" + esc(tr("Reactions")) + '</h2><p class="phandle">' + esc(tr("Data saving loads reaction counts only and skips pictures in the list.")) + '</p><div class="theme-row" role="group" aria-label="' + esc(tr("Reactions")) + '">' +
      opt("auto", tr("Auto")) + opt("full", tr("Full")) + opt("lite", tr("Counts only")) + "</div>";
  }

  function start() {
    if (start.done || typeof document === "undefined" || !document.body) return;
    start.done = true;
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointermove", onPointerMove, true);
    root.addEventListener("pointerup", cancelHold, true);
    root.addEventListener("pointercancel", cancelHold, true);
    document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    document.addEventListener("touchend", onTouchEnd, true);
    document.addEventListener("touchcancel", onTouchEnd, true);
    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    root.addEventListener("click", onClick, true);
    root.addEventListener("keydown", onKeyDown, true);
    root.addEventListener("keyup", onKeyUp, true);
    root.addEventListener("contextmenu", onContextMenu, true);
    root.addEventListener("viktorych-settings-applied", function () { settingsAt = 0; });
    root.addEventListener("storage", function (event) { if (!event || event.key === SETTINGS_KEY) settingsAt = 0; });
    watch();
  }

  root.ViktorychReactions = {
    start: start,
    // The "e" shortcut in keys.js opens the bar from a post's Like button.
    openBar: function (btn) { if (btn) openBar(btn, true); return !!btn; },
    settingsHtml: settingsHtml,
    applyLocal: applyLocal,
    farFrom: farFrom,
    HOLD_MS: HOLD_MS,
    oneEmoji: oneEmoji,
    keyFor: keyFor,
    lite: lite,
    paint: paint,
    refreshSettings: function () { settingsAt = 0; },
    DATA_SAVING: DATA_SAVING,
    QUICK: QUICK
  };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : this);
