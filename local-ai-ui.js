/* Local AI page (#/ai). A chat that changes app settings from plain words.
   Layout follows a familiar assistant chat: an empty state with a centred
   prompt box and suggestion chips, the box moving to the bottom after the
   first message, plain assistant text with copy and regenerate, a model
   picker pill, and chat history on the side (a drawer on phones).
   Every change goes through local-ai.js plan() (checked against
   settings-registry.js), shows on a confirm card with Undo, and is written by
   window.ViktorychSettingsHost with the same save and sync steps the
   Settings page uses. Nothing typed leaves the device. */
(function () {
  "use strict";
  var CHATS_KEY = "viktorych-local-ai-chats-v1";
  var MODEL_KEY = "viktorych-local-ai-model";
  var HAVE_KEY = "viktorych-local-ai-have";
  var MAX_CHATS = 40;

  function tr(s, vars) {
    var L = window.SI18n;
    if (L && L.t) return L.t(s, vars);
    return String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : ""; });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function core() { return window.ViktorychLocalAI; }
  function reg() { return window.ViktorychSettingsRegistry; }
  function host() { return window.ViktorychSettingsHost || null; }
  function read(key, def) { try { var v = JSON.parse(localStorage.getItem(key) || "null"); return v == null ? def : v; } catch (err) { return def; } }
  function write(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (err) { /* private mode */ } }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  var I = {
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3.5" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m17.3 4.3 2.4 2.4-7.9 7.9-3.1.7.7-3.1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M4.5 12h15M4.5 17h9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    side: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.5 4.5v15" stroke="currentColor" stroke-width="1.8"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5.5 6.5 6.5-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5.5 12.5 4 4 9-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.5 4.5 12 9 16.5M5 12h9.5a5 5 0 0 1 0 10H12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 5.5h5v5M18.5 5.5 11 13M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chip: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  };
  function mark() {
    var h = host();
    return h && h.icon ? h.icon("spark") : I.bolt;
  }

  /* ---------- state ---------- */
  var S = {
    root: null, chats: read(CHATS_KEY, []), chatId: "", busy: false, sideOpen: false, menu: false, sheet: null,
    info: null, choices: null, model: read(MODEL_KEY, ""), have: read(HAVE_KEY, {}), engine: { state: "idle", id: "", progress: 0, text: "" },
    worker: null, jobs: {}, mic: "", micBusy: false, streamTimer: 0, stopReq: false, nano: null
  };
  if (!Array.isArray(S.chats)) S.chats = [];
  function chat() {
    for (var i = 0; i < S.chats.length; i += 1) if (S.chats[i].id === S.chatId) return S.chats[i];
    return null;
  }
  function saveChats() {
    if (prefs().history === "off") { write(CHATS_KEY, []); return; }
    S.chats.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    S.chats = S.chats.slice(0, MAX_CHATS);
    write(CHATS_KEY, S.chats.map(function (c) {
      return { id: c.id, title: c.title, at: c.at, msgs: c.msgs.map(function (m) { var o = {}; Object.keys(m).forEach(function (k) { if (k !== "streaming") o[k] = m[k]; }); return o; }) };
    }));
  }

  /* ---------- model choice ---------- */
  function currentModel() {
    var A = core();
    var saved = setupOn() ? setupSaved() : null;
    var id = S.model || (saved && saved.model) || "";
    var m = id && A.model(id);
    if (m && S.choices && S.choices.list.indexOf(m) >= 0) return m;
    if (m && m.engine === "instant") return m;
    return A.model("instant");
  }
  function detectOnce() {
    if (S.info) return Promise.resolve(S.info);
    var h = host();
    return core().detect({ saveData: h && h.lowEnd ? h.lowEnd() : false }).then(function (info) {
      S.info = info;
      S.choices = core().choices(info);
      paintBar();
      return info;
    });
  }
  function sizeText(mb) {
    if (!mb) return tr("No download");
    return mb >= 1000 ? tr("{n} GB", { n: (mb / 1000).toFixed(1) }) : tr("{n} MB", { n: Math.round(mb) });
  }
  function partText(mb) { return mb >= 1000 ? tr("{n} GB", { n: (mb / 1000).toFixed(1) }) : tr("{n} MB", { n: Math.round(mb || 0) }); }
  function modelBlurb(m) {
    if (m.engine === "instant") return tr("Built-in rules. Instant, works on every device, no download.");
    if (m.engine === "nano") return tr("Chrome's built-in model. Chrome keeps it; nothing to download here.");
    if (m.engine === "tjs") return tr("Runs on the processor when there is no WebGPU. Slower.");
    if (m.family === "max") return tr("Smartest. For computers with a strong graphics card.");
    if (m.family === "high") return tr("Smart and quick on most computers and new phones.");
    return tr("Small and fast. Good for phones.");
  }
  function modelName(m) { return m.engine === "instant" ? tr("Instant") : m.label; }

  /* ---------- worker ---------- */
  function worker() {
    if (S.worker) return S.worker;
    S.worker = new Worker("local-ai-worker.js", { type: "module" });
    S.worker.onmessage = function (e) {
      var msg = e.data || {};
      var job = S.jobs[msg.id];
      if (msg.type === "progress") {
        var p = msg.progress || {};
        S.engine.progress = Math.max(0, Math.min(1, p.fraction || 0));
        S.engine.text = p.text || "";
        paintProgress();
        return;
      }
      if (!job) return;
      if (msg.type === "delta") { if (job.onDelta) job.onDelta(msg.text); return; }
      delete S.jobs[msg.id];
      if (msg.type === "error") job.reject(new Error(msg.error || "error"));
      else job.resolve(msg);
    };
    S.worker.onerror = function () {
      Object.keys(S.jobs).forEach(function (k) { S.jobs[k].reject(new Error("worker")); delete S.jobs[k]; });
      S.worker = null;
    };
    return S.worker;
  }
  function ask(msg, onDelta) {
    var id = uid();
    msg.id = id;
    return new Promise(function (resolve, reject) {
      S.jobs[id] = { resolve: resolve, reject: reject, onDelta: onDelta };
      if (msg.type === "chat") S.chatJob = id;
      worker().postMessage(msg);
    });
  }
  function loadModel(m) {
    if (m.engine === "instant") { S.engine = { state: "ready", id: m.id, progress: 1 }; return Promise.resolve(); }
    if (S.engine.state === "ready" && S.engine.id === m.id) return Promise.resolve();
    if (S.engine.state === "loading" && S.engine.id === m.id && S.engine.job) return S.engine.job;
    S.engine = { state: "loading", id: m.id, progress: 0, text: "" };
    paintProgress();
    var job;
    if (m.engine === "nano") {
      job = nanoSession(true).then(function () {});
    } else {
      job = ask({ type: "load", engine: m.engine, model: m.id, dtype: m.dtype });
    }
    S.engine.job = job.then(function () {
      S.engine = { state: "ready", id: m.id, progress: 1 };
      S.have[m.id] = Date.now();
      write(HAVE_KEY, S.have);
      paintProgress();
      paintBar();
    }, function (err) {
      S.engine = { state: "error", id: m.id, progress: 0, text: String(err && err.message || err) };
      paintProgress();
      throw err;
    });
    return S.engine.job;
  }

  /* Chrome's built-in model (Prompt API). */
  function nanoSession(create) {
    var LM = window.LanguageModel;
    if (!LM) return Promise.reject(new Error("no LanguageModel"));
    if (S.nano) return Promise.resolve(S.nano);
    if (!create) return Promise.reject(new Error("not ready"));
    return LM.create({
      expectedInputs: [{ type: "text", languages: ["en", "es"] }], expectedOutputs: [{ type: "text", languages: ["en"] }],
      monitor: function (m) { m.addEventListener("downloadprogress", function (e) { S.engine.progress = e.loaded || 0; paintProgress(); }); }
    }).then(function (s) { S.nano = s; return s; });
  }

  /* ---------- answering ---------- */
  function answer(text, opts) {
    if (opts && opts.calls) return Promise.resolve({ reply: "", calls: opts.calls, unknown: [], engine: "tap" });
    var A = core();
    var h = host();
    var values = h ? h.values() : {};
    var m = currentModel();
    var lang = prefs().lang || A.langOf(text, h ? h.lang() : "en");
    if (m.engine === "instant" || !(S.engine.state === "ready" && S.engine.id === m.id)) {
      var parsed = A.parse(text, values);
      return Promise.resolve({ reply: "", calls: parsed.calls, unknown: parsed.unknown, engine: "instant" });
    }
    var p = A.prompt(text, values, { lang: lang, limit: m.engine === "tjs" ? 12 : 22 });
    var history = [];
    var c = chat();
    if (c) {
      c.msgs.slice(-5, -1).forEach(function (msg) {
        if (msg.role === "user") history.push({ role: "user", content: msg.text });
        else if (msg.role === "ai" && msg.text) history.push({ role: "assistant", content: JSON.stringify({ reply: msg.text, calls: [] }) });
      });
    }
    var messages = [{ role: "system", content: p.system }].concat(history.slice(-4), [{ role: "user", content: text }]);
    var onDelta = function (buf) { if (opts && opts.onDelta) opts.onDelta(A.partialReply(buf)); };
    var run;
    if (m.engine === "nano") {
      run = nanoSession(false).then(function (base) { return base.clone ? base.clone() : base; }).then(function (session) {
        var full = p.system + "\n\nUser: " + text;
        var stream = session.promptStreaming(full, { responseConstraint: A.SCHEMA });
        var reader = stream.getReader();
        var buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return buf;
            var chunk = String(r.value || "");
            buf = chunk.indexOf(buf) === 0 && buf ? chunk : buf + chunk;
            onDelta(buf);
            return pump();
          });
        }
        return pump().then(function (out) { if (session !== S.nano && session.destroy) session.destroy(); return { text: out }; });
      });
    } else {
      run = ask({ type: "chat", messages: messages, schema: m.engine === "webllm" ? A.SCHEMA : null, maxTokens: 320 }, onDelta);
    }
    return run.then(function (res) {
      var ans = A.readAnswer(res.text);
      var planned = A.plan(ans.calls, values);
      var fallback = A.parse(text, values);
      // A small model that missed what the rules can see falls back to the rules.
      if (!planned.changes.length && !planned.opens.length && !planned.reads.length && fallback.calls.length) {
        return { reply: ans.bad ? "" : ans.reply, calls: fallback.calls, unknown: fallback.unknown, engine: "instant+" + m.engine };
      }
      return { reply: ans.reply, calls: ans.calls, unknown: [], engine: m.engine };
    }, function () {
      var parsed = A.parse(text, values);
      return { reply: "", calls: parsed.calls, unknown: parsed.unknown, engine: "instant" };
    });
  }

  function shown(row, v) {
    if (v === undefined || v === null) return tr("Unknown");
    if (row.type === "bool") return v ? tr("On") : tr("Off");
    if (row.type === "number") return String(v);
    if (row.valueLabels && Object.prototype.hasOwnProperty.call(row.valueLabels, v)) return tr(row.valueLabels[v]);
    return String(v);
  }
  function instantReply(plan, unknown) {
    var parts = [];
    var h = host();
    var signed = h && h.signedIn ? h.signedIn() : false;
    var n = plan.changes.filter(function (ch) { return !(ch.signedIn && !signed); }).length;
    if (plan.changes.length && !n) parts.push(tr("These are account settings. Sign in to change them."));
    else if (n === 1) parts.push(tr("Here's the change. Check it and tap Apply."));
    else if (n > 1) parts.push(tr("Here are {n} changes. Check them and tap Apply.", { n: n }));
    plan.reads.forEach(function (r) {
      parts.push(r.same ? tr("{name} is already {value}.", { name: tr(r.row.label), value: shown(r.row, r.value) }) : tr("{name} is {value} right now.", { name: tr(r.row.label), value: shown(r.row, r.value) }));
    });
    if (plan.opens.length) {
      var danger = plan.opens.some(function (r) { return r.risk === "danger"; });
      parts.push(danger ? tr("I won't do that one for you. It's on its own page, so you can do it yourself:") : (plan.opens.length > 1 ? tr("You'll find these here:") : tr("You'll find it here:")));
    }
    if (!parts.length) parts.push(tr("I couldn't match that to a setting. Try “bigger text”, “dark mode”, “stop autoplay on mobile data” or “make it private”."));
    return parts.join(" ");
  }

  /* ---------- sending ---------- */
  function send(text, opts) {
    text = String(text || "").trim();
    if (!text || S.busy || S.setup) return;
    var c = chat();
    if (!c) {
      c = { id: uid(), title: text.slice(0, 60), at: Date.now(), msgs: [] };
      S.chats.unshift(c);
      S.chatId = c.id;
    }
    if (!(opts && opts.regen)) c.msgs.push({ role: "user", text: text, at: Date.now() });
    var msg = { role: "ai", text: "", at: Date.now(), streaming: true, q: text };
    if (opts && opts.calls) msg.calls = opts.calls;
    c.msgs.push(msg);
    c.at = Date.now();
    S.busy = true;
    S.menu = false;
    S.stopReq = false;
    paint();
    var box = S.root && S.root.querySelector(".lai-input");
    if (box) { box.value = ""; grow(box); }
    var shownText = "";
    answer(text, { calls: opts && opts.calls, onDelta: function (t) { shownText = t; msg.text = t; paintMsg(msg); } }).then(function (res) {
      var h = host();
      var values = h ? h.values() : {};
      var plan = core().plan(res.calls, values);
      var reply = res.reply && res.reply.trim() ? res.reply.trim() : instantReply(plan, res.unknown);
      // Setup said "only show where settings are": changes become links.
      if (!prefs().canChange && plan.changes.length) {
        plan.changes.forEach(function (ch) { if (!plan.opens.some(function (r) { return r.id === ch.id; })) { var row = reg().get(ch.id); if (row && row.page) plan.opens.push({ id: ch.id, row: row, risk: row.risk }); } });
        plan.changes = [];
        reply = tr("Changing settings is off, so here's where to do it yourself:");
      }
      if (res.reply && plan.opens.length && !/http|#\//.test(reply)) reply += "";
      msg.engine = res.engine;
      msg.plan = plan.changes.map(function (ch) { return { id: ch.id, from: ch.from, to: ch.to, risky: !!ch.risky, signedIn: !!ch.signedIn }; });
      msg.opens = plan.opens.map(function (r) { return r.id; });
      msg.state = msg.plan.length ? "ask" : "";
      return typeOut(msg, shownText, reply);
    }).then(function () {
      msg.streaming = false;
      S.busy = false;
      saveChats();
      paint();
    }, function () {
      msg.streaming = false;
      msg.text = tr("Something went wrong. Try again.");
      S.busy = false;
      saveChats();
      paint();
    });
  }
  /* Rules answer at once; type the text out so it streams like a model. */
  function typeOut(msg, already, full) {
    if (already && full.indexOf(already) === 0 && already.length > full.length * 0.8) { msg.text = full; return Promise.resolve(); }
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { msg.text = full; return Promise.resolve(); }
    var words = full.split(/(\s+)/);
    var i = 0;
    msg.text = "";
    return new Promise(function (resolve) {
      function step() {
        if (S.stopReq || i >= words.length) { msg.text = full; paintMsg(msg); resolve(); return; }
        msg.text += words[i] + (words[i + 1] || "");
        i += 2;
        paintMsg(msg);
        S.streamTimer = setTimeout(step, 22);
      }
      step();
    });
  }

  /* ---------- applying ---------- */
  function applyPlan(msg, confirmed) {
    var h = host();
    if (!h || !msg.plan || !msg.plan.length) return;
    var R = reg();
    var picked = msg.plan.filter(function (ch) { return ch.skip !== true && !(ch.signedIn && !h.signedIn()); });
    if (!picked.length) return;
    if (!confirmed && picked.some(function (ch) { return ch.risky; })) { msg.state = "risk"; paint(); return; }
    msg.state = "saving";
    paint();
    h.apply(picked.map(function (ch) { return { id: ch.id, to: ch.to }; })).then(function (res) {
      var ok = {};
      (res || []).forEach(function (r) { ok[r.id] = !!r.ok; });
      picked.forEach(function (ch) { ch.done = ok[ch.id] !== false; ch.failed = ok[ch.id] === false; });
      msg.state = "done";
      saveChats();
      paint();
      if (h.toast) {
        var n = picked.filter(function (ch) { return ch.done; }).length;
        h.toast(n === 1 ? tr("1 setting changed") : tr("{n} settings changed", { n: n }));
      }
    });
    void R;
  }
  function undo(msg, id) {
    var h = host();
    if (!h) return;
    var list = msg.plan.filter(function (ch) { return ch.done && !ch.undone && (!id || ch.id === id); });
    if (!list.length) return;
    h.apply(list.map(function (ch) { return { id: ch.id, to: ch.from }; })).then(function (res) {
      var ok = {};
      (res || []).forEach(function (r) { ok[r.id] = !!r.ok; });
      list.forEach(function (ch) { if (ok[ch.id] !== false) ch.undone = true; });
      saveChats();
      paint();
      if (h.toast) h.toast(tr("Undone"));
    });
  }

  /* ---------- render ---------- */
  function groupOf(at) {
    var d = new Date(at || 0), now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (at >= start) return tr("Today");
    if (at >= start - 86400000) return tr("Yesterday");
    if (at >= start - 7 * 86400000) return tr("Previous 7 days");
    void d;
    return tr("Older");
  }
  function sideHtml() {
    var groups = [], cur = "";
    var rows = S.chats.map(function (c) {
      var g = groupOf(c.at);
      var head = g !== cur ? '<p class="lai-hist-head">' + esc(g) + "</p>" : "";
      cur = g;
      return head + '<div class="lai-hist-row' + (c.id === S.chatId ? " on" : "") + '"><button type="button" class="lai-hist-item" data-lai="open-chat" data-id="' + esc(c.id) + '">' + esc(c.title || tr("New chat")) + '</button><button type="button" class="lai-hist-del" data-lai="del-chat" data-id="' + esc(c.id) + '" aria-label="' + esc(tr("Delete chat")) + '">' + I.x + "</button></div>";
    }).join("");
    void groups;
    return '<div class="lai-side-top"><a class="lai-brand" href="#/ai" data-lai="new"><span class="lai-brand-mark">' + mark() + '</span><span>' + esc(tr("Local AI")) + '</span></a><button type="button" class="lai-icon lai-side-x" data-lai="side" aria-label="' + esc(tr("Close")) + '">' + I.side + "</button></div>" +
      '<button type="button" class="lai-new" data-lai="new">' + I.edit + "<span>" + esc(tr("New chat")) + "</span></button>" +
      '<nav class="lai-hist" aria-label="' + esc(tr("History")) + '">' + (prefs().history === "off" ? '<p class="lai-hist-empty">' + esc(tr("Chat history is off. Chats are gone when you leave the page.")) + "</p>" : "") + (rows || (prefs().history === "off" ? "" : '<p class="lai-hist-empty">' + esc(tr("Your chats stay on this device.")) + "</p>")) + "</nav>" +
      '<div class="lai-side-foot">' + (setupOn() ? '<button type="button" class="lai-side-link" data-lai="setup-again">' + esc(tr("Set up Local AI again")) + "</button>" : "") + '<a href="#/settings" class="lai-side-link">' + esc(tr("All settings")) + "</a></div>";
  }
  function chips() {
    return [tr("Make text bigger"), tr("Stop autoplay on mobile data"), tr("Hide friends stuff"), tr("Make my account private"), tr("Dark mode"), tr("Where are muted words?")];
  }
  function micReady() { return S.mic === "available" || S.mic === "downloadable"; }
  function barHtml() {
    var m = currentModel();
    var loading = S.engine.state === "loading";
    return '<form class="lai-bar" data-lai="form"><div class="lai-edit"><textarea class="lai-input" rows="1" placeholder="' + esc(tr("Ask to change any setting…")) + '" aria-label="' + esc(tr("Message Local AI")) + '" enterkeyhint="send"></textarea></div>' +
      '<div class="lai-row"><div class="lai-row-l">' + (micReady() ? '<button type="button" class="lai-icon lai-mic' + (S.micBusy ? " on" : "") + '" data-lai="mic" aria-label="' + esc(tr("Speak")) + '">' + I.mic + "</button>" : "") + "</div>" +
      '<div class="lai-row-r"><button type="button" class="lai-pill" data-lai="models" aria-haspopup="menu" aria-expanded="' + (S.menu ? "true" : "false") + '">' + (m.engine === "instant" ? I.bolt : I.chip) + "<span>" + esc(modelName(m)) + "</span>" + (loading ? '<i class="lai-pill-pct">' + Math.round(S.engine.progress * 100) + "%</i>" : "") + I.down + "</button>" +
      '<button type="submit" class="lai-send" data-lai="send" aria-label="' + esc(S.busy ? tr("Stop") : tr("Send")) + '"' + (S.busy ? ' data-stop="1"' : "") + ">" + (S.busy ? I.stop : I.send) + "</button></div></div>" +
      (S.menu ? menuHtml() : "") + "</form>";
  }
  function menuHtml() {
    var A = core();
    var list = (S.choices && S.choices.list) || [A.model("instant")];
    var rec = S.choices && S.choices.recommended;
    var cur = currentModel();
    var rows = list.map(function (m) {
      var have = m.engine === "instant" || m.engine === "nano" || !!S.have[m.id];
      var badge = m === rec ? '<em class="lai-badge">' + esc(tr("Best for this device")) + "</em>" : "";
      var size = m.engine === "instant" || m.engine === "nano" ? "" : (have ? tr("Downloaded") : sizeText(A.downloadMB(m)));
      return '<button type="button" role="menuitemradio" aria-checked="' + (m === cur ? "true" : "false") + '" class="lai-menu-item' + (m === cur ? " on" : "") + '" data-lai="pick" data-id="' + esc(m.id) + '"><span class="lai-menu-name">' + esc(modelName(m)) + badge + '</span><span class="lai-menu-sub">' + esc(modelBlurb(m)) + (size ? " · " + esc(size) : "") + "</span>" + (m === cur ? '<span class="lai-menu-check">' + I.check + "</span>" : "") + "</button>";
    }).join("");
    var tier = S.info ? '<p class="lai-menu-foot">' + esc(S.info.webgpu ? tr("This device can run models on its graphics chip.") : tr("No WebGPU here, so models run on the processor.")) + "</p>" : "";
    var again = setupOn() ? '<button type="button" role="menuitem" class="lai-menu-item lai-menu-again" data-lai="setup-again"><span class="lai-menu-name">' + esc(tr("Set up Local AI again")) + "</span></button>" : "";
    return '<div class="lai-menu" role="menu">' + '<p class="lai-menu-head">' + esc(tr("Model")) + "</p>" + rows + tier + again + "</div>";
  }
  function heroHtml() {
    return '<div class="lai-hero"><span class="lai-hero-mark">' + mark() + "</span><h1>" + esc(tr("What should we change?")) + "</h1></div>";
  }
  /* Quick settings: a tab per group and the settings in it, each with its
     value. A tap makes the same confirm card as typing, so risky changes
     still ask and Undo still works. */
  function groups() { return [["look", tr("Display")], ["privacy", tr("Privacy")], ["notifications", tr("Notifications")], ["media", tr("Media")], ["feed", tr("Feed")], ["friends", tr("Friends")]]; }
  function quickRows(cat) {
    var R = reg();
    if (!R || !R.editable) return [];
    return R.editable().filter(function (row) {
      return row.cat === cat && row.label && row.risk !== "danger" && (row.type === "bool" || (row.type === "enum" && row.values && row.values.length > 1));
    }).slice(0, 8);
  }
  function nextValue(row, v) {
    if (row.type === "bool") return !v;
    var i = row.values.indexOf(v);
    return row.values[(i + 1) % row.values.length];
  }
  function browseHtml() {
    var h = host();
    var values = h ? h.values() : {};
    var cur = S.browse || "look";
    var tabs = groups().filter(function (g) { return quickRows(g[0]).length; }).map(function (g) {
      return '<button type="button" role="tab" class="lai-tab' + (g[0] === cur ? " on" : "") + '" aria-selected="' + (g[0] === cur ? "true" : "false") + '" data-lai="tab" data-cat="' + g[0] + '">' + esc(g[1]) + "</button>";
    }).join("");
    var rows = quickRows(cur).map(function (row) {
      var v = values[row.id];
      if (v === undefined) v = row.def;
      // Rows look like X's own settings: a label, the value under it in grey,
      // and a checkbox for on/off or a chevron for a choice.
      if (row.type === "bool") {
        return '<button type="button" class="lai-q" role="checkbox" aria-checked="' + (v ? "true" : "false") + '" data-lai="quick" data-id="' + esc(row.id) + '"><span class="lai-q-text"><span class="lai-q-name">' + esc(tr(row.label)) + '</span></span><i class="lai-cb' + (v ? " is-on" : "") + '" aria-hidden="true">' + I.check + "</i></button>";
      }
      return '<button type="button" class="lai-q" data-lai="quick" data-id="' + esc(row.id) + '"><span class="lai-q-text"><span class="lai-q-name">' + esc(tr(row.label)) + '</span><span class="lai-q-val">' + esc(shown(row, v)) + '</span></span><i class="lai-chev" aria-hidden="true">' + I.chev + "</i></button>";
    }).join("");
    return '<section class="lai-browse" aria-label="' + esc(tr("Quick settings")) + '"><p class="lai-browse-head">' + esc(tr("Quick settings")) + '</p><div class="lai-tabs" role="tablist">' + tabs + '</div><div class="lai-qs" role="tabpanel">' + rows + "</div></section>";
  }
  function quick(id) {
    var R = reg();
    var row = R && R.get(id);
    if (!row) return;
    var h = host();
    var values = h ? h.values() : {};
    var v = values[id];
    if (v === undefined) v = row.def;
    var to = nextValue(row, v);
    send(tr(row.label) + " → " + shown(row, to), { calls: [{ fn: "set", id: id, value: to }] });
  }
  function chipsHtml() {
    return '<div class="lai-chips">' + chips().map(function (c) { return '<button type="button" class="lai-chip" data-lai="chip">' + esc(c) + "</button>"; }).join("") + "</div>";
  }
  function progressHtml() {
    var e = S.engine;
    if (e.state !== "loading" && e.state !== "error") return "";
    var m = core().model(e.id);
    if (e.state === "error") return '<div class="lai-prog err"><span>' + esc(tr("Couldn't load {name}. Using Instant.", { name: m ? m.label : "" })) + '</span><button type="button" class="lai-link" data-lai="retry">' + esc(tr("Try again")) + "</button></div>";
    var pct = Math.round((e.progress || 0) * 100);
    var mb = m ? core().downloadMB(m) : 0;
    return '<div class="lai-prog" role="status"><div class="lai-prog-top"><span>' + esc(S.have[e.id] ? tr("Loading {name}…", { name: m ? m.label : "" }) : tr("Downloading {name} · {size}", { name: m ? m.label : "", size: sizeText(mb) })) + "</span><b>" + pct + '%</b></div><div class="lai-prog-track"><i style="width:' + pct + '%"></i></div></div>';
  }
  function rowLabel(id) { var r = reg().get(id); return r ? tr(r.label) : id; }
  function cardHtml(msg, mi) {
    if (!msg.plan || !msg.plan.length) return "";
    var R = reg();
    var h = host();
    var signed = h && h.signedIn ? h.signedIn() : false;
    var done = msg.state === "done";
    var rows = msg.plan.map(function (ch) {
      var row = R.get(ch.id);
      if (!row) return "";
      var needSign = ch.signedIn && !signed;
      var status = "";
      if (done && ch.failed) status = '<span class="lai-ch-st bad">' + esc(tr("Didn't save")) + "</span>";
      else if (done && ch.undone) status = '<span class="lai-ch-st">' + esc(tr("Undone")) + "</span>";
      else if (done && ch.done) status = '<button type="button" class="lai-ch-undo" data-lai="undo-one" data-m="' + mi + '" data-id="' + esc(ch.id) + '">' + I.undo + "<span>" + esc(tr("Undo")) + "</span></button>";
      else if (needSign) status = '<span class="lai-ch-st">' + esc(tr("Sign in first")) + "</span>";
      var tick = done && ch.done && !ch.undone ? '<span class="lai-ch-ok">' + I.check + "</span>" : "";
      return '<li class="lai-ch' + (ch.risky ? " risky" : "") + (needSign ? " off" : "") + '">' + tick + '<div class="lai-ch-copy"><a class="lai-ch-name" href="' + esc(row.page) + '">' + esc(tr(row.label)) + '</a><span class="lai-ch-val"><s>' + esc(shown(row, ch.from)) + "</s> → <b>" + esc(shown(row, ch.to)) + "</b></span>" + (ch.risky ? '<span class="lai-ch-risk">' + esc(tr("Less private")) + "</span>" : "") + "</div>" + status + "</li>";
    }).join("");
    var foot = "";
    var can = msg.plan.filter(function (ch) { return !(ch.signedIn && !signed); }).length;
    if (msg.state === "ask" && !can) foot = '<div class="lai-card-foot"><span class="lai-saving">' + esc(tr("These are account settings. Sign in to change them.")) + '</span><button type="button" class="lai-btn" data-acct="login">' + esc(tr("Sign in")) + "</button></div>";
    else if (msg.state === "ask") foot = '<div class="lai-card-foot"><button type="button" class="lai-btn ghost" data-lai="cancel" data-m="' + mi + '">' + esc(tr("Cancel")) + '</button><button type="button" class="lai-btn" data-lai="apply" data-m="' + mi + '">' + esc(can > 1 ? tr("Apply {n} changes", { n: can }) : tr("Apply")) + "</button></div>";
    else if (msg.state === "risk") foot = '<div class="lai-card-warn"><p>' + esc(tr("Some of these make your account easier to see or find. Are you sure?")) + '</p><div class="lai-card-foot"><button type="button" class="lai-btn ghost" data-lai="back" data-m="' + mi + '">' + esc(tr("Go back")) + '</button><button type="button" class="lai-btn warn" data-lai="apply-risk" data-m="' + mi + '">' + esc(tr("Yes, apply")) + "</button></div></div>";
    else if (msg.state === "saving") foot = '<div class="lai-card-foot"><span class="lai-saving">' + esc(tr("Saving…")) + "</span></div>";
    else if (msg.state === "cancelled") foot = '<div class="lai-card-foot"><span class="lai-saving">' + esc(tr("Nothing changed.")) + "</span></div>";
    else if (done && msg.plan.some(function (ch) { return ch.done && !ch.undone; }) && msg.plan.length > 1) foot = '<div class="lai-card-foot"><button type="button" class="lai-btn ghost" data-lai="undo-all" data-m="' + mi + '">' + I.undo + "<span>" + esc(tr("Undo all")) + "</span></button></div>";
    var title = done ? tr("Changed") : (msg.plan.length === 1 ? tr("1 change") : tr("{n} changes", { n: msg.plan.length }));
    return '<div class="lai-card"><p class="lai-card-head">' + esc(title) + '</p><ul class="lai-chs">' + rows + "</ul>" + foot + "</div>";
  }
  function opensHtml(msg) {
    if (!msg.opens || !msg.opens.length) return "";
    var R = reg();
    return '<div class="lai-opens">' + msg.opens.map(function (id) {
      var row = R.get(id);
      if (!row || !row.page) return "";
      return '<a class="lai-open' + (row.risk === "danger" ? " danger" : "") + '" href="' + esc(row.page) + '"><span>' + esc(tr(row.label)) + "</span>" + I.link + "</a>";
    }).join("") + "</div>";
  }
  function msgHtml(msg, mi) {
    if (msg.role === "user") return '<div class="lai-msg user" data-i="' + mi + '"><div class="lai-bubble">' + esc(msg.text) + "</div></div>";
    var body = msg.text ? esc(msg.text).replace(/\n/g, "<br>") : (msg.streaming ? '<span class="lai-dots"><i></i><i></i><i></i></span>' : "");
    var actions = msg.streaming ? "" : '<div class="lai-acts"><button type="button" class="lai-icon sm" data-lai="copy" data-m="' + mi + '" aria-label="' + esc(tr("Copy")) + '" title="' + esc(tr("Copy")) + '">' + I.copy + '</button><button type="button" class="lai-icon sm" data-lai="regen" data-m="' + mi + '" aria-label="' + esc(tr("Regenerate")) + '" title="' + esc(tr("Regenerate")) + '">' + I.redo + "</button>" + (msg.engine && msg.engine !== "instant" && msg.engine !== "tap" ? '<span class="lai-engine">' + esc(engineLabel(msg.engine)) + "</span>" : "") + "</div>";
    return '<div class="lai-msg ai' + (msg.streaming ? " streaming" : "") + '" data-i="' + mi + '"><div class="lai-text">' + body + "</div>" + (msg.streaming ? "" : cardHtml(msg, mi) + opensHtml(msg)) + actions + "</div>";
  }
  function engineLabel(e) {
    var m = core().model(String(e).replace(/^instant\+/, ""));
    var name = m ? modelName(m) : e;
    return /^instant\+/.test(e) ? tr("Instant (checked by {name})", { name: name }) : name;
  }
  function threadHtml() {
    var c = chat();
    return c ? c.msgs.map(msgHtml).join("") : "";
  }
  function sheetHtml() {
    if (!S.sheet) return "";
    var A = core();
    var m = A.model(S.sheet);
    if (!m) return "";
    var mb = A.downloadMB(m);
    var warn = [];
    if (S.info && S.info.saveData) warn.push(tr("Data saver is on. This is a big download."));
    if (S.info && S.info.lowEnd) warn.push(tr("This device is low on memory. The model may be slow or fail; Instant always works."));
    var conn = navigator.connection || {};
    if (conn.type === "cellular") warn.push(tr("You're on mobile data. Wi-Fi is better for this."));
    return '<div class="lai-sheet-wrap" data-lai="sheet-x"><div class="lai-sheet" role="dialog" aria-modal="true" aria-labelledby="lai-sheet-h"><h2 id="lai-sheet-h">' + esc(tr("Download {name}?", { name: m.label })) + '</h2><p class="lai-sheet-size">' + esc(sizeText(mb)) + "</p>" +
      "<p>" + esc(modelBlurb(m)) + "</p><ul class=\"lai-sheet-list\"><li>" + esc(tr("Downloads once from Hugging Face and stays on this device.")) + "</li><li>" + esc(tr("After that it works offline.")) + "</li><li>" + esc(tr("What you type never leaves this device.")) + "</li></ul>" +
      (warn.length ? '<p class="lai-sheet-warn">' + warn.map(esc).join("<br>") + "</p>" : "") +
      '<div class="lai-card-foot"><button type="button" class="lai-btn ghost" data-lai="sheet-x">' + esc(tr("Not now")) + '</button><button type="button" class="lai-btn" data-lai="download" data-id="' + esc(m.id) + '">' + esc(tr("Download")) + "</button></div></div></div>";
  }

  function build() {
    var el = document.createElement("div");
    el.className = "lai";
    el.innerHTML = '<aside class="lai-side" aria-label="' + esc(tr("Chats")) + '"></aside><div class="lai-scrim" data-lai="side"></div>' +
      '<section class="lai-main"><header class="lai-head"><a class="lai-icon lai-back" href="#/settings" aria-label="' + esc(tr("Back")) + '">' + I.back + '</a><button type="button" class="lai-icon lai-menu-btn" data-lai="side" aria-label="' + esc(tr("Chats")) + '">' + I.menu + '</button><span class="lai-title"></span><button type="button" class="lai-icon" data-lai="new" aria-label="' + esc(tr("New chat")) + '">' + I.edit + "</button></header>" +
      '<div class="lai-scroll"><div class="lai-thread" aria-live="polite"></div></div><div class="lai-dock"><div class="lai-hero-slot"></div><div class="lai-prog-slot"></div><div class="lai-bar-slot"></div><div class="lai-chips-slot"></div><div class="lai-browse-slot"></div><p class="lai-note">' + esc(tr("Runs on this device. Nothing you type is sent anywhere.")) + "</p></div></section><div class=\"lai-sheet-slot\"></div><div class=\"lai-su-slot\"></div>";
    el.addEventListener("click", onClick);
    el.addEventListener("submit", function (e) { e.preventDefault(); onSend(); });
    el.addEventListener("keydown", onKey);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.root && S.root.isConnected && !S.root.contains(e.target)) onKey(e); });
    document.addEventListener("click", function (e) { if (S.menu && S.root && !S.root.contains(e.target)) { S.menu = false; paintBar(); } });
    // Remember if the box had focus, so a re-render of the page under us puts it back.
    el.addEventListener("focusin", function (e) { if (e.target && e.target.classList.contains("lai-input")) S.inFocus = true; });
    el.addEventListener("focusout", function (e) { if (e.target && e.target.classList.contains("lai-input") && el.isConnected) S.inFocus = false; });
    el.addEventListener("input", function (e) { if (e.target && e.target.classList.contains("lai-input")) { grow(e.target); paintSendState(); } });
    return el;
  }
  function paint() {
    if (!S.root) return;
    var c = chat();
    var empty = !c || !c.msgs.length;
    S.root.classList.toggle("is-empty", empty);
    S.root.classList.toggle("side-open", S.sideOpen && !S.setup);
    S.root.classList.toggle("is-setup", !!S.setup);
    paintSetup();
    S.root.querySelector(".lai-side").innerHTML = sideHtml();
    S.root.querySelector(".lai-title").textContent = S.setup ? tr("Set up Local AI") : (c && c.title ? c.title : tr("Local AI"));
    S.root.querySelector(".lai-hero-slot").innerHTML = empty ? heroHtml() : "";
    S.root.querySelector(".lai-chips-slot").innerHTML = empty ? chipsHtml() : "";
    var bs = S.root.querySelector(".lai-browse-slot");
    if (bs) bs.innerHTML = empty && prefs().canChange ? browseHtml() : "";
    S.root.querySelector(".lai-thread").innerHTML = threadHtml();
    S.root.querySelector(".lai-sheet-slot").innerHTML = sheetHtml();
    paintBar();
    paintProgress();
    var sc = S.root.querySelector(".lai-scroll");
    if (sc && !empty) sc.scrollTop = sc.scrollHeight;
  }
  function paintBar() {
    if (!S.root) return;
    var slot = S.root.querySelector(".lai-bar-slot");
    var old = slot.querySelector(".lai-input");
    var val = old ? old.value : "";
    var focused = old && document.activeElement === old;
    slot.innerHTML = barHtml();
    var box = slot.querySelector(".lai-input");
    box.value = val;
    grow(box);
    if (focused) box.focus();
    paintSendState();
  }
  function paintSendState() {
    if (!S.root) return;
    var box = S.root.querySelector(".lai-input");
    var btn = S.root.querySelector(".lai-send");
    if (btn) btn.disabled = !S.busy && !(box && box.value.trim());
  }
  function paintProgress() {
    if (!S.root) return;
    S.root.querySelector(".lai-prog-slot").innerHTML = S.setup ? "" : progressHtml();
    paintSetupProgress();
    var pct = S.root.querySelector(".lai-pill-pct");
    if (pct) pct.textContent = Math.round(S.engine.progress * 100) + "%";
    else if (S.engine.state === "loading" || S.engine.state === "ready") { /* pill repaints with the bar */ }
  }
  function paintMsg(msg) {
    if (!S.root) return;
    var c = chat();
    var mi = c ? c.msgs.indexOf(msg) : -1;
    var node = S.root.querySelector('.lai-msg[data-i="' + mi + '"] .lai-text');
    if (!node) { paint(); return; }
    node.innerHTML = msg.text ? esc(msg.text).replace(/\n/g, "<br>") : '<span class="lai-dots"><i></i><i></i><i></i></span>';
    var sc = S.root.querySelector(".lai-scroll");
    if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
  }
  function grow(box) {
    if (!box) return;
    box.style.height = "auto";
    box.style.height = Math.min(box.scrollHeight, 200) + "px";
  }

  /* ---------- events ---------- */
  function onSend() {
    if (S.busy) { S.stopReq = true; if (S.worker && S.chatJob) S.worker && S.worker.postMessage({ type: "abort", target: S.chatJob }); return; }
    var box = S.root.querySelector(".lai-input");
    send(box && box.value);
  }
  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey && e.target && e.target.classList.contains("lai-input") && !e.isComposing) { e.preventDefault(); onSend(); }
    if (e.key === "Escape" && S.setup) return;
    if (e.key === "Escape") { if (S.menu) { S.menu = false; paintBar(); } else if (S.sheet) { S.sheet = null; paint(); } else if (S.sideOpen) { S.sideOpen = false; paint(); } }
  }
  function msgAt(el) { var c = chat(); return c ? c.msgs[Number(el.getAttribute("data-m"))] : null; }
  function onClick(e) {
    var el = e.target.closest && e.target.closest("[data-lai]");
    if (S.menu && !(e.target.closest && e.target.closest(".lai-menu, [data-lai='models']"))) { S.menu = false; paintBar(); }
    if (!el) return;
    var act = el.getAttribute("data-lai");
    if (act === "sheet-x" && e.target !== el && el.classList.contains("lai-sheet-wrap")) return;
    if (act === "form" || act === "send") return;
    e.preventDefault();
    var h = host();
    if (act.indexOf("su-") === 0) { onSetupClick(act, el); return; }
    if (act === "setup-again") { S.menu = false; startSetup("full"); return; }
    if (S.setup) return;
    if (act === "new") { S.chatId = ""; S.sideOpen = false; paint(); focusBox(); return; }
    if (act === "side") { S.sideOpen = !S.sideOpen; S.root.classList.toggle("side-open", S.sideOpen); if (window.innerWidth >= 1000) { S.root.classList.toggle("side-hidden"); } return; }
    if (act === "open-chat") { S.chatId = el.getAttribute("data-id"); S.sideOpen = false; paint(); return; }
    if (act === "del-chat") { var id = el.getAttribute("data-id"); S.chats = S.chats.filter(function (c) { return c.id !== id; }); if (S.chatId === id) S.chatId = ""; saveChats(); paint(); return; }
    if (act === "chip") { send(el.textContent); return; }
    if (act === "tab") { S.browse = el.getAttribute("data-cat"); var b = S.root.querySelector(".lai-browse-slot"); if (b) b.innerHTML = browseHtml(); var t = S.root.querySelector('.lai-tab.on'); if (t) t.focus(); return; }
    if (act === "quick") { if (prefs().canChange) quick(el.getAttribute("data-id")); return; }
    if (act === "models") { S.menu = !S.menu; detectOnce(); paintBar(); return; }
    if (act === "pick") {
      var m = core().model(el.getAttribute("data-id"));
      S.menu = false;
      if (!m) return;
      if (m.engine === "instant" || m.engine === "nano" || S.have[m.id]) { useModel(m); paintBar(); return; }
      S.sheet = m.id;
      paint();
      return;
    }
    if (act === "sheet-x") { S.sheet = null; paint(); return; }
    if (act === "download") { var dm = core().model(el.getAttribute("data-id")); S.sheet = null; paint(); if (dm) useModel(dm); return; }
    if (act === "retry") { var rm = core().model(S.engine.id); if (rm) useModel(rm); return; }
    if (act === "copy") { var cm = msgAt(el); if (cm && navigator.clipboard) navigator.clipboard.writeText(cm.text).then(function () { if (h && h.toast) h.toast(tr("Copied")); }, function () {}); return; }
    if (act === "regen") {
      var rmsg = msgAt(el);
      var c = chat();
      if (!rmsg || !c || S.busy) return;
      var q = rmsg.q;
      c.msgs.splice(c.msgs.indexOf(rmsg), 1);
      send(q, { regen: true, calls: rmsg.calls });
      return;
    }
    if (act === "apply") { var am = msgAt(el); if (am) applyPlan(am, false); return; }
    if (act === "apply-risk") { var arm = msgAt(el); if (arm) applyPlan(arm, true); return; }
    if (act === "back" || act === "cancel") { var bm = msgAt(el); if (bm) { bm.state = act === "back" ? "ask" : "cancelled"; saveChats(); paint(); } return; }
    if (act === "undo-one") { var um = msgAt(el); if (um) undo(um, el.getAttribute("data-id")); return; }
    if (act === "undo-all") { var uam = msgAt(el); if (uam) undo(uam, ""); return; }
    if (act === "mic") { listen(); return; }
  }
  function useModel(m) {
    S.model = m.id;
    write(MODEL_KEY, m.id);
    paintBar();
    if (m.engine === "instant") { S.engine = { state: "ready", id: m.id, progress: 1 }; paintProgress(); return; }
    loadModel(m).catch(function () {});
    paintBar();
  }
  function focusBox() {
    var box = S.root && S.root.querySelector(".lai-input");
    if (box && window.innerWidth >= 700) box.focus();
  }

  /* On-device speech only: the mic shows when the browser can recognise
     speech locally (processLocally). Cloud speech is never used. */
  function SR() { return window.SpeechRecognition || null; }
  function micCheck() {
    var Rec = SR();
    if (!Rec || !Rec.available) { S.mic = ""; return; }
    var lang = speechLang();
    Promise.resolve(Rec.available({ langs: [lang], processLocally: true })).then(function (state) {
      S.mic = String(state || "");
      paintBar();
    }, function () { S.mic = ""; });
  }
  function speechLang() {
    var h = host();
    var l = h ? h.lang() : "en";
    return { en: "en-US", es: "es-ES", ru: "ru-RU", hi: "hi-IN" }[l] || "en-US";
  }
  function listen() {
    var Rec = SR();
    if (!Rec || S.micBusy) return;
    var lang = speechLang();
    var ready = S.mic === "downloadable" && Rec.install ? Rec.install({ langs: [lang], processLocally: true }) : Promise.resolve(true);
    S.micBusy = true;
    paintBar();
    Promise.resolve(ready).then(function (ok) {
      if (ok === false) throw new Error("install");
      S.mic = "available";
      var rec = new Rec();
      rec.lang = lang;
      rec.processLocally = true;
      rec.interimResults = true;
      rec.onresult = function (ev) {
        var text = "";
        for (var i = 0; i < ev.results.length; i += 1) text += ev.results[i][0].transcript;
        var box = S.root.querySelector(".lai-input");
        if (box) { box.value = text; grow(box); paintSendState(); }
      };
      rec.onend = function () { S.micBusy = false; paintBar(); var box = S.root.querySelector(".lai-input"); if (box && box.value.trim()) onSend(); };
      rec.onerror = function () { S.micBusy = false; paintBar(); };
      rec.start();
    }).catch(function () { S.micBusy = false; paintBar(); });
  }

  /* ---------- first-run setup ----------
     Required once before the chat opens (the owner can turn the
     local_ai_setup switch off). The choices sync with the account through
     settings.aiSetup; model files stay on this device, so a new device only
     runs the download and test steps. Instant is the only way to skip. */
  var STEPS_FULL = ["welcome", "device", "download", "test", "prefs", "done"];
  var LANGS = [["en", "English"], ["es", "Español"], ["ru", "Русский"], ["hi", "हिन्दी"]];
  function setupOn() { var h = host(); return !!(h && h.setupRequired && h.setupRequired()); }
  function setupSaved() { var h = host(); var v = h && h.setup ? h.setup() : null; return v && typeof v === "object" ? v : null; }
  function prefs() {
    var s = setupOn() ? setupSaved() : null;
    return { lang: s && s.lang ? String(s.lang) : "", canChange: !s || s.canChange !== false, history: s && s.history === "off" ? "off" : "keep" };
  }
  function needsFiles(m) { return !!m && (m.engine === "webllm" || m.engine === "tjs"); }
  /* What still has to happen here: "" (nothing), "full" or "device". */
  function setupNeed() {
    if (!setupOn()) return "";
    var s = setupSaved();
    if (!s || !s.done) return "full";
    var m = core().model(s.model);
    if (!m) return "full";
    return needsFiles(m) && !S.have[m.id] ? "device" : "";
  }
  function inChoices(id) { return !!(S.choices && S.choices.list.some(function (m) { return m.id === id; })); }
  function startSetup(mode, auto) {
    var saved = setupSaved() || {};
    var h = host();
    var lang = saved.lang || (h ? h.lang() : "en");
    S.setup = {
      mode: mode, auto: !!auto, steps: mode === "device" ? ["download", "test"] : STEPS_FULL.slice(), i: 0,
      pick: mode === "device" ? String(saved.model || "") : "", lang: lang, canChange: saved.canChange !== false, history: saved.history === "off" ? "off" : "keep",
      dl: "idle", test: "idle", ms: 0, storage: null, persisted: null
    };
    S.menu = false; S.sheet = null; S.sideOpen = false;
    detectOnce().then(function () {
      var st = S.setup;
      if (!st) return;
      if (st.mode === "device" && !inChoices(st.pick)) { st.steps = ["device", "download", "test"]; st.pick = ""; }
      if (!st.pick) st.pick = (S.choices.recommended || core().model("instant")).id;
      paint();
    });
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) { if (S.setup) { S.setup.storage = { quota: e.quota || 0, usage: e.usage || 0 }; paintSetup(); } }, function () {});
    }
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(function (p) { if (S.setup) { S.setup.persisted = !!p; paintSetup(); } }, function () {});
    }
    paint();
  }
  function stepName() { return S.setup ? S.setup.steps[S.setup.i] : ""; }
  function pickedModel() { return core().model(S.setup && S.setup.pick) || core().model("instant"); }
  function goStep(name) {
    var st = S.setup;
    var i = st.steps.indexOf(name);
    if (i < 0) return;
    st.i = i;
    if (name === "download") {
      var m = pickedModel();
      // Instant and Chrome's own model have nothing to download here.
      if (!needsFiles(m) && m.engine !== "nano") { goStep("test"); return; }
      if (S.engine.state === "ready" && S.engine.id === m.id) st.dl = "done";
      else if (st.dl !== "loading") st.dl = S.have[m.id] ? "loading" : "idle";
      if (st.dl === "loading") startDownload();
    }
    if (name === "test") runTest();
    if (name === "done") saveSetupNow();
    paint();
    var card = S.root && S.root.querySelector(".lai-su-card");
    if (card) { card.scrollTop = 0; var f = card.querySelector("h1"); if (f) { f.setAttribute("tabindex", "-1"); f.focus({ preventScroll: true }); } }
  }
  function nextStep() {
    var st = S.setup;
    if (st.i >= st.steps.length - 1) { finishSetup(); return; }
    goStep(st.steps[st.i + 1]);
  }
  function prevStep() {
    var st = S.setup;
    if (!st || st.i <= 0) return;
    var name = stepName();
    if (name === "download" && st.dl === "loading") pauseDownload();
    var back = st.steps[st.i - 1];
    // Going back over a step with nothing to do skips it.
    if (back === "download" && !needsFiles(pickedModel()) && pickedModel().engine !== "nano") back = st.steps[st.i - 2] || back;
    if (back === "test") back = st.steps[st.steps.indexOf("download")] || back;
    st.i = st.steps.indexOf(back);
    paint();
  }
  function saveSetupNow() {
    var h = host();
    var st = S.setup;
    if (!st) return;
    var v = { v: 1, done: true, at: Date.now(), model: st.pick || "instant", lang: st.lang, canChange: !!st.canChange, history: st.history };
    if (h && h.saveSetup) h.saveSetup(v);
    S.model = v.model;
    write(MODEL_KEY, v.model);
    if (v.history === "off") { S.chats = []; S.chatId = ""; write(CHATS_KEY, []); }
  }
  function finishSetup() {
    saveSetupNow();
    S.setup = null;
    var m = currentModel();
    if (m.engine === "instant") S.engine = { state: "ready", id: m.id, progress: 1 };
    paint();
    focusBox();
  }
  function skipSetup() {
    if (!S.setup) return;
    S.setup.pick = "instant";
    finishSetup();
  }
  function askPersist() {
    if (!navigator.storage || !navigator.storage.persist) return;
    navigator.storage.persist().then(function (p) { if (S.setup) { S.setup.persisted = !!p; paintSetup(); } }, function () {});
  }
  function startDownload() {
    var st = S.setup;
    var m = pickedModel();
    st.dl = "loading";
    askPersist();
    loadModel(m).then(function () {
      if (!S.setup || S.setup.pick !== m.id) return;
      S.setup.dl = "done";
      if (stepName() === "download") nextStep();
    }, function () {
      if (!S.setup || S.setup.pick !== m.id) return;
      if (S.setup.dl === "paused") { S.engine = { state: "idle", id: "", progress: S.setup.pausedAt || 0, text: "" }; paint(); return; }
      S.setup.dl = "error";
      paint();
    });
    paint();
  }
  /* Pause stops the download worker. The files that already finished stay in
     the browser cache, so Resume carries on from there. */
  function pauseDownload() {
    var st = S.setup;
    if (!st || st.dl !== "loading") return;
    st.dl = "paused";
    st.pausedAt = S.engine.progress || 0;
    if (S.worker) { try { S.worker.terminate(); } catch (err) { /* already gone */ } S.worker = null; }
    Object.keys(S.jobs).forEach(function (k) { S.jobs[k].reject(new Error("paused")); delete S.jobs[k]; });
    paint();
  }
  function smallerThan(m) {
    var list = (S.choices && S.choices.list) || [];
    var i = list.indexOf(m);
    for (var j = i + 1; j < list.length; j += 1) if (list[j].engine !== "instant") return list[j];
    return null;
  }
  /* The warm-up asks the model one real question and checks it answers. */
  function runTest() {
    var st = S.setup;
    var m = pickedModel();
    var A = core();
    var h = host();
    var values = h ? h.values() : {};
    var q = "make text bigger";
    st.test = "running";
    st.ms = 0;
    var t0 = Date.now();
    var job;
    if (m.engine === "instant") {
      job = A.parse(q, values).calls.length ? Promise.resolve({ text: "ok" }) : Promise.reject(new Error("rules"));
    } else {
      var p = A.prompt(q, values, { lang: "en", limit: 12 });
      job = loadModel(m).then(function () {
        if (m.engine === "nano") return nanoSession(true).then(function (s) { return s.prompt(p.system + "\n\nUser: " + q, { responseConstraint: A.SCHEMA }); }).then(function (text) { return { text: text }; });
        return ask({ type: "chat", messages: [{ role: "system", content: p.system }, { role: "user", content: q }], schema: m.engine === "webllm" ? A.SCHEMA : null, maxTokens: 160 });
      });
      var limit = new Promise(function (resolve, reject) { setTimeout(function () { reject(new Error("timeout")); }, 120000); });
      job = Promise.race([job, limit]);
    }
    job.then(function (res) {
      if (!S.setup || S.setup.pick !== m.id) return;
      if (!String(res && res.text || "").trim()) throw new Error("empty");
      S.setup.test = "ok";
      S.setup.ms = Date.now() - t0;
      paint();
    }).catch(function () {
      if (!S.setup || S.setup.pick !== m.id) return;
      S.setup.test = "fail";
      paint();
    });
  }
  function usePick(id) {
    var st = S.setup;
    st.pick = id;
    st.dl = "idle";
    st.test = "idle";
    goStep(st.steps.indexOf("download") >= 0 ? "download" : "test");
  }

  function gb(bytes) { return (bytes / 1e9).toFixed(1); }
  function suRadio(on) { return '<i class="lai-su-radio' + (on ? " is-on" : "") + '" aria-hidden="true"></i>'; }
  function suCheck(on) { return '<i class="lai-cb' + (on ? " is-on" : "") + '" aria-hidden="true">' + I.check + "</i>"; }
  function logo() { var h = host(); return h && h.logo ? h.logo() : mark(); }
  function appName() { var h = host(); return (h && h.appName && h.appName()) || ""; }
  function setupHtml() {
    var st = S.setup;
    if (!st) return "";
    var name = stepName();
    var A = core();
    var m = pickedModel();
    var body = "", foot = "";
    var pill = function (act, label, extra) { return '<button type="button" class="lai-su-btn" data-lai="' + act + '"' + (extra || "") + ">" + esc(label) + "</button>"; };
    var ghost = function (act, label, extra) { return '<button type="button" class="lai-su-btn ghost" data-lai="' + act + '"' + (extra || "") + ">" + esc(label) + "</button>"; };
    if (name === "welcome") {
      var app = appName();
      body = '<h1>' + esc(tr("Set up Local AI")) + "</h1><p class=\"lai-su-lead\">" + esc(app ? tr("Local AI in {app} changes your settings when you ask in plain words.", { app: app }) : tr("Local AI changes your settings when you ask in plain words.")) + "</p>" +
        '<ul class="lai-su-points"><li><b>' + esc(tr("Everything stays on this device")) + "</b><span>" + esc(tr("The model runs here. What you type is never sent anywhere, not even to us.")) + "</span></li>" +
        "<li><b>" + esc(tr("Download once, then offline")) + "</b><span>" + esc(tr("We check what this device can run and suggest the best model.")) + "</span></li>" +
        "<li><b>" + esc(tr("You stay in control")) + "</b><span>" + esc(tr("Every change shows on a card first. Nothing changes until you tap Apply, and Undo puts it back.")) + "</span></li></ul>";
      foot = pill("su-next", tr("Get started")) + '<button type="button" class="lai-su-link" data-lai="su-skip">' + esc(tr("Skip and use Instant (no download)")) + "</button>";
    } else if (name === "device") {
      var info = S.info;
      if (!info || !S.choices) {
        body = "<h1>" + esc(tr("Checking this device…")) + '</h1><div class="lai-su-spin" role="status" aria-label="' + esc(tr("Checking this device…")) + '"></div>';
      } else {
        var free = st.storage ? Math.max(0, st.storage.quota - st.storage.usage) : 0;
        var facts = [
          [tr("Graphics chip (WebGPU)"), info.webgpu ? tr("Yes") : tr("No")],
          [tr("Memory"), info.mem ? tr("About {n} GB", { n: info.mem }) : tr("Unknown")],
          [tr("Free space"), st.storage ? tr("{n} GB free", { n: gb(free) }) : tr("Unknown")],
          [tr("Device"), info.mobile ? tr("Phone or tablet") : tr("Computer")]
        ];
        var rec = S.choices.recommended;
        var rows = S.choices.list.map(function (c) {
          var mb = A.downloadMB(c);
          var on = c.id === st.pick;
          var size = c.engine === "instant" || c.engine === "nano" ? tr("No download") : (S.have[c.id] ? tr("Downloaded") : sizeText(mb));
          return '<button type="button" class="lai-su-opt' + (on ? " on" : "") + '" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-lai="su-pick" data-id="' + esc(c.id) + '"><span class="lai-su-opt-text"><span class="lai-su-opt-name">' + esc(modelName(c)) + (c === rec ? '<em class="lai-badge">' + esc(tr("Recommended")) + "</em>" : "") + '</span><span class="lai-su-opt-sub">' + esc(modelBlurb(c)) + '</span><span class="lai-su-opt-size">' + esc(size) + "</span></span>" + suRadio(on) + "</button>";
        }).join("");
        var tooBig = st.storage && needsFiles(m) && !S.have[m.id] && A.downloadMB(m) * 1e6 > free;
        body = "<h1>" + esc(tr("This device")) + '</h1><p class="lai-su-lead">' + esc(tr("Best for this device: {name} · {size}", { name: modelName(rec), size: rec.engine === "instant" || rec.engine === "nano" ? tr("No download") : sizeText(A.downloadMB(rec)) })) + "</p>" +
          '<dl class="lai-su-facts">' + facts.map(function (f) { return "<div><dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd></div>"; }).join("") + "</dl>" +
          '<p class="lai-su-sec">' + esc(tr("Model")) + '</p><div class="lai-su-opts" role="radiogroup" aria-label="' + esc(tr("Model")) + '">' + rows + "</div>" +
          (tooBig ? '<p class="lai-su-warn">' + esc(tr("There may not be enough free space for this model.")) + "</p>" : "");
        foot = pill("su-next", tr("Next"));
      }
    } else if (name === "download") {
      var mb2 = A.downloadMB(m);
      var pct = Math.round((st.dl === "paused" ? st.pausedAt || 0 : S.engine.id === m.id ? S.engine.progress || 0 : 0) * 100);
      var conn = navigator.connection || {};
      var phone = (S.info && S.info.mobile) || conn.type === "cellular";
      var warn = [];
      if (conn.type === "cellular") warn.push(tr("You're on mobile data. Wi-Fi is better for this."));
      else if (phone) warn.push(tr("On a phone, use Wi-Fi for this download."));
      if (S.info && S.info.saveData) warn.push(tr("Data saver is on. This is a big download."));
      var status = { idle: tr("Ready to download"), loading: S.have[m.id] ? tr("Loading {name}…", { name: modelName(m) }) : tr("Downloading…"), paused: tr("Paused. Finished parts are kept."), done: tr("Downloaded"), error: tr("The download stopped.") }[st.dl] || "";
      var persist = st.persisted === true ? tr("Storage is kept for good on this device.") : (st.persisted === false && st.dl !== "idle" ? tr("The browser may clear the model if space runs low. You can download it again.") : tr("We'll ask the browser to keep the model for good."));
      body = "<h1>" + esc(tr("Download {name}", { name: modelName(m) })) + '</h1><p class="lai-su-lead">' + esc(m.engine === "nano" ? tr("Chrome's built-in model. Chrome keeps it; nothing to download here.") : tr("{size}. Downloads once from Hugging Face and stays on this device.", { size: sizeText(mb2) })) + "</p>" +
        '<div class="lai-su-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><div class="lai-su-prog-top"><span class="lai-su-status">' + esc(status) + '</span><b class="lai-su-pct">' + pct + '%</b></div><div class="lai-prog-track"><i style="width:' + pct + '%"></i></div>' +
        (mb2 ? '<p class="lai-su-mb">' + esc(tr("{done} of {size}", { done: partText(mb2 * pct / 100), size: sizeText(mb2) })) + "</p>" : "") + "</div>" +
        (warn.length ? '<p class="lai-su-warn">' + warn.map(esc).join("<br>") + "</p>" : "") +
        '<p class="lai-su-note">' + esc(persist) + "</p>";
      if (st.dl === "idle") foot = pill("su-dl", tr("Download")) + (st.steps.indexOf("device") >= 0 ? ghost("su-back", tr("Pick another model")) : ghost("su-instant", tr("Use Instant")));
      else if (st.dl === "loading") foot = m.engine === "nano" ? "" : ghost("su-pause", tr("Pause"));
      else if (st.dl === "paused") foot = pill("su-dl", tr("Resume")) + ghost("su-instant", tr("Use Instant"));
      else if (st.dl === "error") {
        var sm = smallerThan(m);
        foot = pill("su-dl", tr("Try again")) + (sm ? ghost("su-use", tr("Use {name} instead", { name: modelName(sm) }), ' data-id="' + esc(sm.id) + '"') : "") + ghost("su-instant", tr("Use Instant"));
      }
    } else if (name === "test") {
      var sm2 = smallerThan(m);
      if (st.test === "ok") {
        body = '<div class="lai-su-ok">' + I.check + "</div><h1>" + esc(tr("{name} works", { name: modelName(m) })) + '</h1><p class="lai-su-lead">' + esc(m.engine === "instant" ? tr("Instant answered right away.") : tr("It answered a test question in {s} s.", { s: (st.ms / 1000).toFixed(1) })) + "</p>";
        foot = pill("su-next", st.i >= st.steps.length - 1 ? tr("Done") : tr("Next"));
      } else if (st.test === "fail") {
        body = "<h1>" + esc(tr("{name} didn't answer", { name: modelName(m) })) + '</h1><p class="lai-su-lead">' + esc(tr("This device may not have enough memory for it. A smaller model or Instant will work.")) + "</p>";
        foot = (sm2 ? pill("su-use", tr("Use {name} instead", { name: modelName(sm2) }), ' data-id="' + esc(sm2.id) + '"') : "") + (sm2 ? ghost("su-instant", tr("Use Instant")) : pill("su-instant", tr("Use Instant"))) + ghost("su-retest", tr("Try again"));
      } else {
        body = "<h1>" + esc(tr("Quick test")) + '</h1><p class="lai-su-lead">' + esc(tr("Checking that {name} answers on this device…", { name: modelName(m) })) + '</p><div class="lai-su-spin" role="status" aria-label="' + esc(tr("Quick test")) + '"></div>';
      }
    } else if (name === "prefs") {
      body = "<h1>" + esc(tr("How should Local AI work?")) + "</h1>" +
        '<p class="lai-su-sec">' + esc(tr("Reply language")) + '</p><div class="lai-su-opts" role="radiogroup" aria-label="' + esc(tr("Reply language")) + '">' + LANGS.map(function (l) {
          var on = st.lang === l[0];
          return '<button type="button" class="lai-su-opt slim' + (on ? " on" : "") + '" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-lai="su-lang" data-v="' + l[0] + '"><span class="lai-su-opt-text"><span class="lai-su-opt-name">' + esc(l[1]) + "</span></span>" + suRadio(on) + "</button>";
        }).join("") + "</div>" +
        '<p class="lai-su-sec">' + esc(tr("Settings")) + '</p><div class="lai-su-opts"><button type="button" class="lai-su-opt" role="checkbox" aria-checked="' + (st.canChange ? "true" : "false") + '" data-lai="su-change"><span class="lai-su-opt-text"><span class="lai-su-opt-name">' + esc(tr("Let Local AI change settings")) + '</span><span class="lai-su-opt-sub">' + esc(tr("Each change shows on a card first. Nothing changes until you tap Apply, and Undo puts it back. Off: it only shows where each setting is.")) + "</span></span>" + suCheck(st.canChange) + "</button></div>" +
        '<p class="lai-su-sec">' + esc(tr("Chat history")) + '</p><div class="lai-su-opts" role="radiogroup" aria-label="' + esc(tr("Chat history")) + '">' + [["keep", tr("Keep chats on this device"), tr("Your chats show in the sidebar. They never leave this device.")], ["off", tr("Don't keep chats"), tr("Chats are gone when you leave the page.")]].map(function (o) {
          var on = st.history === o[0];
          return '<button type="button" class="lai-su-opt' + (on ? " on" : "") + '" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-lai="su-hist" data-v="' + o[0] + '"><span class="lai-su-opt-text"><span class="lai-su-opt-name">' + esc(o[1]) + '</span><span class="lai-su-opt-sub">' + esc(o[2]) + "</span></span>" + suRadio(on) + "</button>";
        }).join("") + "</div>";
      foot = pill("su-next", tr("Next"));
    } else if (name === "done") {
      var langName = (LANGS.filter(function (l) { return l[0] === st.lang; })[0] || ["", st.lang])[1];
      body = '<div class="lai-su-ok">' + I.check + "</div><h1>" + esc(tr("You're all set")) + '</h1><p class="lai-su-lead">' + esc(tr("Ask in your own words, or start with one of these.")) + "</p>" +
        '<dl class="lai-su-facts">' + [[tr("Model"), modelName(m)], [tr("Reply language"), langName], [tr("Settings"), st.canChange ? tr("Changes after you tap Apply") : tr("Only shows where they are")], [tr("Chat history"), st.history === "off" ? tr("Not kept") : tr("Kept on this device")]].map(function (f) { return "<div><dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd></div>"; }).join("") + "</dl>" +
        '<div class="lai-chips lai-su-chips">' + chips().slice(0, 4).map(function (c) { return '<button type="button" class="lai-chip" data-lai="su-chip">' + esc(c) + "</button>"; }).join("") + "</div>";
      foot = pill("su-finish", tr("Start chatting"));
    }
    var n = st.i + 1, total = st.steps.length;
    var bar = st.steps.map(function (s, k) { return '<i class="' + (k <= st.i ? "on" : "") + '"></i>'; }).join("");
    var canBack = st.i > 0 && name !== "done" && !(name === "test" && st.test === "running");
    return '<div class="lai-su" data-step="' + esc(name) + '"><div class="lai-su-bg" aria-hidden="true"><span class="lai-su-bg-mark">' + logo() + "</span></div>" +
      '<section class="lai-su-card" role="dialog" aria-modal="true" aria-label="' + esc(tr("Set up Local AI")) + '"><span class="lai-su-grab" aria-hidden="true"></span>' +
      '<header class="lai-su-head">' + (canBack ? '<button type="button" class="lai-icon" data-lai="su-back" aria-label="' + esc(tr("Back")) + '">' + I.back + "</button>" : '<a class="lai-icon" href="#/settings" aria-label="' + esc(tr("Close")) + '">' + I.x + "</a>") +
      '<span class="lai-su-logo">' + logo() + "</span></header>" +
      '<div class="lai-su-steps" aria-hidden="true">' + bar + "</div>" +
      '<div class="lai-su-body"><p class="lai-su-count">' + esc(tr("Step {n} of {total}", { n: n, total: total })) + "</p>" + body + "</div>" + (foot ? '<div class="lai-su-foot">' + foot + "</div>" : "") + "</section></div>";
  }
  function paintSetup() {
    if (!S.root) return;
    var slot = S.root.querySelector(".lai-su-slot");
    if (!slot) return;
    var html = setupHtml();
    var card = slot.querySelector(".lai-su-card");
    var top = card ? card.scrollTop : 0;
    slot.innerHTML = html;
    var c2 = slot.querySelector(".lai-su-card");
    if (c2) c2.scrollTop = top;
  }
  /* Download progress without repainting the whole step. */
  function paintSetupProgress() {
    var st = S.setup;
    if (!st || !S.root || stepName() !== "download" || st.dl !== "loading") return;
    var m = pickedModel();
    if (S.engine.id !== m.id) return;
    var pct = Math.round((S.engine.progress || 0) * 100);
    var bar = S.root.querySelector(".lai-su-prog");
    if (!bar) return;
    bar.setAttribute("aria-valuenow", String(pct));
    var b = bar.querySelector(".lai-su-pct"); if (b) b.textContent = pct + "%";
    var i = bar.querySelector(".lai-prog-track i"); if (i) i.style.width = pct + "%";
    var mb = core().downloadMB(m);
    var t = bar.querySelector(".lai-su-mb"); if (t && mb) t.textContent = tr("{done} of {size}", { done: partText(mb * pct / 100), size: sizeText(mb) });
  }
  function onSetupClick(act, el) {
    var st = S.setup;
    if (!st) return false;
    if (act === "su-next") { if (stepName() === "device" && !st.pick) return true; nextStep(); return true; }
    if (act === "su-back") { prevStep(); return true; }
    if (act === "su-skip") { skipSetup(); return true; }
    if (act === "su-pick") { st.pick = el.getAttribute("data-id"); st.dl = "idle"; st.test = "idle"; paintSetup(); return true; }
    if (act === "su-dl") { startDownload(); return true; }
    if (act === "su-pause") { pauseDownload(); return true; }
    if (act === "su-use") { usePick(el.getAttribute("data-id")); return true; }
    if (act === "su-instant") { usePick("instant"); return true; }
    if (act === "su-retest") { runTest(); paint(); return true; }
    if (act === "su-lang") { st.lang = el.getAttribute("data-v"); paintSetup(); return true; }
    if (act === "su-change") { st.canChange = !st.canChange; paintSetup(); return true; }
    if (act === "su-hist") { st.history = el.getAttribute("data-v"); paintSetup(); return true; }
    if (act === "su-finish") { finishSetup(); return true; }
    if (act === "su-chip") { var text = el.textContent; finishSetup(); send(text); return true; }
    return false;
  }

  /* ---------- page hooks ---------- */
  function page() {
    return '<div class="lai-host"></div>';
  }
  function mount(route) {
    var spot = document.querySelector(".lai-host");
    if (!spot) return;
    var again = !!(route && route.query && route.query.get && route.query.get("setup") === "1");
    if (again) { try { history.replaceState(history.state, "", "#/ai"); } catch (err) { /* keeps ?setup=1 */ } }
    if (!S.root) {
      S.root = build();
      var need = setupNeed();
      if (again) startSetup("full");
      else if (need) startSetup(need, true);
      paint();
      detectOnce().then(function () {
        var m = currentModel();
        // A model that was downloaded before loads on its own (from the cache).
        if (!S.setup && m.engine !== "instant" && (S.have[m.id] || m.engine === "nano")) loadModel(m).catch(function () {});
      });
      micCheck();
    }
    else if (again) startSetup("full");
    else {
      // Synced choices can arrive after the page opened: follow them while
      // the person has not started yet.
      var now = setupNeed();
      if (S.setup && S.setup.auto && S.setup.i === 0 && S.setup.mode !== now) { if (now) startSetup(now, true); else { S.setup = null; paint(); } }
      else if (!S.setup && now) startSetup(now, true);
    }
    if (S.root.parentNode !== spot) {
      spot.appendChild(S.root);
      var box = S.root.querySelector(".lai-input");
      if (S.inFocus && box && (!document.activeElement || document.activeElement === document.body)) box.focus();
    }
    document.documentElement.classList.add("lai-on");
  }
  function unmount() {
    document.documentElement.classList.remove("lai-on");
  }
  if (window.SI18n && window.SI18n.onChange) window.SI18n.onChange(function () { if (S.root) paint(); });

  window.ViktorychLocalAIPage = { page: page, mount: mount, unmount: unmount, _state: S, send: send, setup: function () { startSetup("full"); } };
})();
