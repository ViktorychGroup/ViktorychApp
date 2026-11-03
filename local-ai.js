/* Local AI core: device tiers, the model list, the instant (no-download)
   parser, the prompt for real models, and checking every tool call against
   settings-registry.js. No network here and no DOM: local-ai-ui.js draws the
   page and local-ai-worker.js runs the models. Nothing typed ever leaves the
   device. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychLocalAI = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  function registry() {
    if (root && root.ViktorychSettingsRegistry) return root.ViktorychSettingsRegistry;
    if (typeof require === "function") return require("./settings-registry.js");
    return null;
  }

  /* ---------- Models ----------
     Sizes are the real download (weights plus the WebGPU library) read from
     the Hugging Face repos; vram is what WebLLM says the model needs. */
  var WEBLLM_VERSION = "0.2.86";
  var TJS_VERSION = "4.3.2";
  var MODELS = [
    { id: "instant", engine: "instant", label: "Instant", sizeMB: 0, tiers: ["all"] },
    { id: "nano", engine: "nano", label: "Gemini Nano", sizeMB: 0, tiers: ["built-in"] },
    { id: "Qwen3.5-0.8B-q4f16_1-MLC", engine: "webllm", label: "Qwen3.5 0.8B", sizeMB: 426, vramMB: 1630, f16: true, tiers: ["lite"], family: "lite" },
    { id: "Qwen3.5-0.8B-q4f32_1-MLC", engine: "webllm", label: "Qwen3.5 0.8B", sizeMB: 430, vramMB: 1895, f16: false, tiers: ["lite"], family: "lite" },
    { id: "Qwen3.5-2B-q4f16_1-MLC", engine: "webllm", label: "Qwen3.5 2B", sizeMB: 1032, vramMB: 2245, f16: true, tiers: ["high"], family: "high" },
    { id: "Qwen3.5-2B-q4f32_1-MLC", engine: "webllm", label: "Qwen3.5 2B", sizeMB: 1040, vramMB: 2900, f16: false, tiers: ["high"], family: "high" },
    { id: "Qwen3.5-4B-q4f16_1-MLC", engine: "webllm", label: "Qwen3.5 4B", sizeMB: 2280, vramMB: 3868, f16: true, tiers: ["max"], family: "max" },
    { id: "onnx-community/Qwen3.5-0.8B-Text-ONNX", engine: "tjs", label: "Qwen3.5 0.8B (CPU)", sizeMB: 545, tiers: ["cpu"], dtype: "q4", family: "cpu" }
  ];
  var LIB_MB = { webllm: 2, tjs: 24 };

  function model(id) {
    for (var i = 0; i < MODELS.length; i += 1) if (MODELS[i].id === id) return MODELS[i];
    return null;
  }

  /* What this device can run. Everything is read locally. */
  function detect(env) {
    env = env || {};
    var nav = env.navigator || (root && root.navigator) || {};
    var conn = nav.connection || {};
    var ua = String(nav.userAgent || "");
    var mobile = /Android|iPhone|iPad|Mobile/i.test(ua) || (nav.userAgentData && nav.userAgentData.mobile) || false;
    var mem = Number(nav.deviceMemory) || 0;
    var cores = Number(nav.hardwareConcurrency) || 0;
    var info = {
      webgpu: !!nav.gpu, f16: false, maxBuffer: 0, mem: mem, cores: cores, mobile: !!mobile,
      saveData: !!conn.saveData || !!env.saveData, slowNet: /(^|-)2g$/.test(String(conn.effectiveType || "")),
      lowEnd: (mem && mem <= 2) || (cores && cores <= 2) || !!env.lowEnd, nano: "no", wasm: typeof WebAssembly === "object"
    };
    function finish() { info.tier = tierOf(info); return info; }
    var jobs = [];
    if (nav.gpu && nav.gpu.requestAdapter) {
      jobs.push(Promise.resolve().then(function () { return nav.gpu.requestAdapter({ powerPreference: "high-performance" }); }).then(function (a) {
        if (!a) { info.webgpu = false; return; }
        info.f16 = !!(a.features && a.features.has && a.features.has("shader-f16"));
        info.maxBuffer = (a.limits && a.limits.maxBufferSize) || 0;
        info.fallbackAdapter = !!(a.info && a.info.isFallbackAdapter) || !!a.isFallbackAdapter;
      }).catch(function () { info.webgpu = false; }));
    }
    var LM = env.LanguageModel || (root && root.LanguageModel);
    if (LM && LM.availability) {
      jobs.push(Promise.resolve().then(function () { return LM.availability({ expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] }); })
        .then(function (state) { info.nano = String(state || "no"); }).catch(function () { info.nano = "no"; }));
    }
    return Promise.all(jobs).then(finish, finish);
  }

  /* max: a desktop GPU with f16 and 8 GB+; high: WebGPU with room for 2B;
     lite: phones and small GPUs; cpu: no WebGPU, WASM only. */
  function tierOf(info) {
    if (!info.webgpu || info.fallbackAdapter) return info.wasm ? "cpu" : "none";
    var big = info.maxBuffer >= 1024 * 1024 * 1024;
    if (!info.mobile && info.f16 && (info.mem >= 8 || (!info.mem && big)) && !info.lowEnd) return "max";
    if (!info.lowEnd && (info.mem >= 4 || (!info.mem && !info.mobile)) && (!info.mobile || info.mem >= 8)) return "high";
    return "lite";
  }

  /* The model we suggest first, and the list we offer, best first. */
  function choices(info) {
    var list = [];
    var f16 = !!info.f16;
    function pick(family) {
      for (var i = 0; i < MODELS.length; i += 1) {
        var m = MODELS[i];
        if (m.family === family && m.engine === "webllm" && m.f16 === f16) return m;
      }
      return null;
    }
    var order = { max: ["max", "high", "lite"], high: ["high", "lite"], lite: ["lite"], cpu: [], none: [] }[info.tier] || [];
    order.forEach(function (family) { var m = pick(family); if (m) list.push(m); });
    if (info.nano === "available" || info.nano === "downloadable" || info.nano === "downloading") list.push(model("nano"));
    if (info.wasm) list.push(model("onnx-community/Qwen3.5-0.8B-Text-ONNX"));
    list.push(model("instant"));
    // Data saver, 2G and low-end devices start on Instant and are asked first.
    var recommended = (info.saveData || info.slowNet || info.lowEnd) ? model("instant") : list[0];
    if (recommended && recommended.engine === "tjs" && info.nano === "available") recommended = model("nano");
    return { recommended: recommended, list: list };
  }
  function downloadMB(m) { return m && m.sizeMB ? m.sizeMB + (LIB_MB[m.engine] || 0) : 0; }

  /* ---------- Words ---------- */
  var STOP = ("app a an the my me i it its to of for on in at please can you could would make set turn put change switch let lets want wanna need just "
    + "el la los las un una mi me de del en a por para que y o lo pon poner haz hacer cambia cambiar quiero puedes "
    + "мне мой моя мои мое я на в во и или пожалуйста сделай сделать поставь поменяй хочу можешь ты это "
    + "मेरा मेरी मेरे मुझे को का की के में और करो कर दो दें है हैं कृपया").split(/\s+/);
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = 1; });
  var OFF = ["off", "stop", "disable", "hide", "no", "dont", "don't", "never", "remove", "without", "less", "kill", "mute", "pause", "block",
    "apaga", "apagar", "desactiva", "desactivar", "quita", "quitar", "oculta", "ocultar", "sin", "nunca", "deten", "detén", "para", "pausa",
    "выключи", "выключить", "отключи", "отключить", "убери", "убрать", "скрой", "скрыть", "не", "без", "останови", "выкл", "пауза",
    "बंद", "हटाओ", "हटा", "छिपाओ", "छिपा", "नहीं", "रोको", "रोक"];
  var ON = ["on", "enable", "show", "start", "allow", "activate", "unhide", "use", "activa", "activar", "muestra", "mostrar", "enciende", "usa",
    "включи", "включить", "покажи", "показать", "вкл", "используй", "चालू", "दिखाओ", "दिखा", "शुरू"];
  var BIGGER = ["bigger", "larger", "big", "large", "increase", "more", "up", "grande", "grandes", "mayor", "más", "mas", "aumenta", "agranda",
    "крупнее", "больше", "увеличь", "увеличить", "крупный", "крупным", "बड़ा", "बड़े", "बढ़ाओ", "ज्यादा"];
  var SMALLER = ["smaller", "small", "tiny", "decrease", "less", "down", "pequeño", "pequeña", "menor", "menos", "reduce", "achica",
    "меньше", "мельче", "уменьши", "уменьшить", "мелкий", "छोटा", "छोटे", "घटाओ", "कम"];
  var MOST = ["biggest", "largest", "max", "maximum", "huge", "máximo", "maxima", "máxima", "максимум", "максимальный", "огромный", "सबसे"];
  var LEAST = ["smallest", "minimum", "min", "mínimo", "минимум", "минимальный"];
  var PRIVATE_W = ["private", "privada", "privado", "privadas", "приватный", "приватным", "приватно", "закрытый", "закрытым", "закрой", "закрыть", "निजी", "प्राइवेट"];
  var PUBLIC_W = ["public", "pública", "público", "publica", "публичный", "публичным", "открытый", "открытым", "открой", "सार्वजनिक", "पब्लिक"];
  var ASK_W = ["where", "how", "find", "which", "what", "dónde", "donde", "cómo", "como", "cuál", "где", "как", "какой", "найти", "कहाँ", "कहां", "कैसे", "क्या"];
  var IS_W = ["is", "are", "status", "current", "está", "esta", "сейчас", "включен", "включено", "क्या"];

  function norm(s) {
    return String(s || "").toLowerCase().replace(/[\u2019']/g, "'").replace(/wi-?fi/g, "wifi").replace(/[^\p{L}\p{N}\p{M}'\s-]+/gu, " ").replace(/\s+/g, " ").trim();
  }
  function tokens(s) { return norm(s).split(" ").filter(function (w) { return w && !STOPSET[w]; }); }
  function stemEq(a, b) {
    if (a === b) return true;
    var n = Math.min(a.length, b.length);
    if (n < 4) return false;
    var k = Math.max(4, n - 2);
    return a.slice(0, k) === b.slice(0, k);
  }
  function hasAny(toks, list) {
    for (var i = 0; i < toks.length; i += 1) for (var j = 0; j < list.length; j += 1) if (toks[i] === list[j]) return list[j];
    return "";
  }
  function bagScore(toks, bag) {
    if (!bag) return 0;
    var words = norm(bag).split(" ");
    var score = 0;
    for (var i = 0; i < toks.length; i += 1) {
      for (var j = 0; j < words.length; j += 1) if (words[j] && stemEq(toks[i], words[j])) { score += 1; break; }
    }
    return score;
  }
  var CUES = {};
  [OFF, ON, BIGGER, SMALLER, MOST, LEAST].forEach(function (list) { list.forEach(function (w) { CUES[w] = 1; }); });
  function rowName(row) { return row.label + " " + row.id.replace(/([A-Z])/g, " $1").replace(/_/g, " "); }
  /* Name words count 2, search words 1, value words half. On/off words never pick a row. */
  function rowScore(toks, row) {
    var name = norm(rowName(row)).split(" ");
    var words = norm(row.words || "").split(" ");
    var s = 0;
    toks.forEach(function (tok) {
      if (CUES[tok]) return;
      var w = 0;
      for (var i = 0; i < name.length; i += 1) if (name[i] && stemEq(tok, name[i])) { w = 2; break; }
      if (!w) for (var j = 0; j < words.length; j += 1) if (words[j] && stemEq(tok, words[j])) { w = 1; break; }
      s += w;
    });
    if (row.valueWords) {
      var best = 0;
      var plain = toks.filter(function (x) { return !CUES[x]; });
      Object.keys(row.valueWords).forEach(function (v) { best = Math.max(best, bagScore(plain, row.valueWords[v])); });
      s += best * 0.75;
    }
    return s;
  }

  /* Best rows for some words, best first. */
  function rank(text, opts) {
    var R = registry();
    var toks = tokens(text);
    var rows = (opts && opts.all) ? R.all().filter(function (r) { return r.type !== "data"; }) : R.editable();
    var out = [];
    rows.forEach(function (row) {
      var s = rowScore(toks, row);
      if (s > 0) out.push({ row: row, score: s });
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  function langOf(text, fallback) {
    var s = String(text || "");
    if (/[\u0900-\u097F]/.test(s)) return "hi";
    if (/[\u0400-\u04FF]/.test(s)) return "ru";
    if (/[ñáéíóú¿¡]/i.test(s) || /\b(el|la|los|las|haz|pon|quiero|más|texto|cuenta|privada|privado|hazlo|hazla|por favor|quita|oculta|amigos|tema|oscuro|dónde|desactiva|activa)\b/i.test(s)) return "es";
    if (/[a-z]/i.test(s)) return "en";
    return fallback || "en";
  }

  /* ---------- Instant parser ---------- */
  var JOIN = { and: 1, then: 1, also: 1, plus: 1, y: 1, "también": 1, "luego": 1, "и": 1, "также": 1, "потом": 1, "затем": 1, "और": 1, "तथा": 1, "फिर": 1 };
  /* Split on commas, full stops and joining words ("and", "y", "и", "और"). */
  function splitClauses(text) {
    var out = [];
    String(text || "").split(/[;,.!?\n]+/).forEach(function (part) {
      var cur = [];
      norm(part).split(" ").forEach(function (w) {
        if (JOIN[w]) { if (cur.length) out.push(cur.join(" ")); cur = []; }
        else if (w) cur.push(w);
      });
      if (cur.length) out.push(cur.join(" "));
    });
    return out;
  }
  function valueFor(row, clause, current) {
    var toks = tokens(clause);
    var raw = norm(clause).split(" ");
    var off = hasAny(raw, OFF);
    var on = hasAny(raw, ON);
    if (row.type === "number") {
      var num = clause.match(/\b(\d{1,3})\b/);
      if (num) return Number(num[1]);
      var cur = typeof current === "number" ? current : row.def;
      var lot = /\b(much|lot|lots|mucho|намного|гораздо|बहुत)\b/.test(clause) ? 2 : 1;
      if (hasAny(raw, MOST)) return row.max;
      if (hasAny(raw, LEAST)) return row.min;
      if (hasAny(raw, BIGGER)) return Math.min(row.max, cur + lot);
      if (hasAny(raw, SMALLER)) return Math.max(row.min, cur - lot);
      if (hasAny(raw, ["normal", "default", "reset", "normales", "обычный", "сброс", "सामान्य"])) return row.def;
      return undefined;
    }
    if (row.type === "bool") {
      if (row.private !== undefined && hasAny(raw, PRIVATE_W)) return row.private;
      if (row.private !== undefined && hasAny(raw, PUBLIC_W)) return !row.private;
      if (off) return false;
      if (on) return true;
      if (hasAny(raw, ["toggle", "flip", "alterna", "переключи"])) return !current;
      return true;
    }
    if (row.type === "enum") {
      var plain = toks.filter(function (x) { return !CUES[x]; });
      var offV = ["never", "off", "none", "nobody", "text"];
      var onV = ["all", "on", "show", "everyone", "full", "always"];
      var best = null, bestScore = 0;
      row.values.forEach(function (v) {
        var s = bagScore(plain, (row.valueWords && row.valueWords[v]) || "") + bagScore(plain, (row.valueLabels && row.valueLabels[v]) || "") * 0.9;
        if (plain.indexOf(String(v).toLowerCase()) >= 0) s += 1;
        if (off && offV.indexOf(v) >= 0) s += 0.6;
        if (on && !off && onV.indexOf(v) >= 0) s += 0.6;
        if (row.private !== undefined && v === row.private && hasAny(raw, PRIVATE_W)) s += 1;
        if (s > bestScore) { best = v; bestScore = s; }
      });
      if (best !== null) return best;
      return undefined;
    }
    return undefined;
  }
  /* Groups match whole phrases only ("make it private", "use less data"). */
  function macroFor(clause) {
    var R = registry();
    var text = " " + norm(clause) + " ";
    var best = null, score = 0;
    R.MACROS.forEach(function (m) {
      String(m.words).split("|").forEach(function (phrase) {
        var p = norm(phrase);
        if (p && text.indexOf(" " + p) >= 0 && p.length > score) { best = m; score = p.length; }
      });
    });
    return best ? { macro: best, score: score } : null;
  }

  /* Plain words -> { calls: [{fn, id, value}], unknown: [clause] }. */
  function parse(text, current) {
    var R = registry();
    current = current || {};
    var calls = [], unknown = [];
    var whole = norm(text);
    var first = whole.split(" ")[0] || "";
    var asking = ASK_W.indexOf(first) >= 0 || ["is", "are", "does", "do", "am"].indexOf(first) >= 0 || (/[?¿]/.test(String(text)) && !hasAny(whole.split(" "), BIGGER.concat(SMALLER)));
    splitClauses(text).forEach(function (clause) {
      var ranked = rank(clause, { all: asking });
      var top = ranked[0];
      var mac = macroFor(clause);
      if (!asking && mac) {
        Object.keys(mac.macro.set).forEach(function (id) { calls.push({ fn: "set", id: id, value: mac.macro.set[id], macro: mac.macro.id }); });
        return;
      }
      if (!top || top.score < 0.75) {
        // A danger action never runs here; send the person to its page.
        var any = rank(clause, { all: true })[0];
        if (any && any.score >= 1) calls.push({ fn: "open", id: any.row.id });
        else unknown.push(clause);
        return;
      }
      if (asking) {
        var isQ = (["is", "are", "does", "do", "what", "which"].indexOf(first) >= 0 || hasAny(norm(clause).split(" "), IS_W)) && top.row.type !== "action";
        calls.push({ fn: isQ && R.editable().indexOf(top.row) >= 0 ? "read" : "open", id: top.row.id });
        return;
      }
      // A danger page beats a weak setting match ("log me out" must not toggle anything).
      // So does a page-only setting (like the Friends master switch) that fits better.
      var dangerHit = rank(clause, { all: true }).filter(function (r) { return r.row.risk === "danger" || (r.row.type === "action" && r.score > top.score); })[0];
      if (dangerHit && dangerHit.score >= top.score) { calls.push({ fn: "open", id: dangerHit.row.id }); return; }
      var v = valueFor(top.row, clause, current[top.row.id]);
      if (v === undefined) calls.push({ fn: "open", id: top.row.id });
      else calls.push({ fn: "set", id: top.row.id, value: v });
    });
    return { calls: dedupe(calls), unknown: unknown };
  }
  function dedupe(calls) {
    var seen = {}, out = [];
    for (var i = calls.length - 1; i >= 0; i -= 1) {
      var key = calls[i].fn + ":" + calls[i].id;
      if (!seen[key]) { seen[key] = 1; out.unshift(calls[i]); }
    }
    return out;
  }

  /* ---------- Checking tool calls ----------
     Every call from any engine goes through here. Unknown ids, read-only
     rows, danger rows and bad values are dropped. Returns
     { changes: [{id, row, from, to, risk}], opens: [row], reads: [{row, value}], rejected: [{call, why}] }. */
  function plan(calls, current) {
    var R = registry();
    current = current || {};
    var out = { changes: [], opens: [], reads: [], rejected: [] };
    (Array.isArray(calls) ? calls : []).slice(0, 24).forEach(function (call) {
      if (!call || typeof call !== "object") return;
      var fn = String(call.fn || call.name || "set");
      var row = R.get(String(call.id || ""));
      if (!row) { out.rejected.push({ call: call, why: "unknown" }); return; }
      if (fn === "open") { if (out.opens.indexOf(row) < 0) out.opens.push(row); return; }
      if (fn === "read") { out.reads.push({ row: row, value: current[row.id] }); return; }
      if (fn !== "set") { out.rejected.push({ call: call, why: "fn" }); return; }
      if (row.risk === "danger" || row.ai === false || row.type === "action" || row.type === "data") {
        if (row.page && out.opens.indexOf(row) < 0) out.opens.push(row);
        out.rejected.push({ call: call, why: "readonly" });
        return;
      }
      var check = R.validate(row.id, call.value);
      if (!check.ok) { out.rejected.push({ call: call, why: check.error }); return; }
      var from = current[row.id];
      if (from === undefined) from = row.def;
      if (from === check.value) { out.reads.push({ row: row, value: from, same: true }); return; }
      var existing = out.changes.filter(function (c) { return c.id === row.id; })[0];
      var risky = R.lessPrivate(row.id, from, check.value);
      if (existing) { existing.to = check.value; existing.risky = risky; return; }
      out.changes.push({ id: row.id, row: row, from: from, to: check.value, risky: risky, signedIn: !!row.signedIn });
    });
    return out;
  }

  /* ---------- Prompt for real models ---------- */
  var SCHEMA = {
    type: "object",
    properties: {
      reply: { type: "string" },
      calls: { type: "array", items: { type: "object", properties: { fn: { type: "string", "enum": ["set", "open", "read"] }, id: { type: "string" }, value: {} }, required: ["fn", "id"] } }
    },
    required: ["reply", "calls"]
  };
  var LANG_NAME = { en: "English", es: "Spanish", ru: "Russian", hi: "Hindi" };
  function fmt(v) { return v === undefined ? "?" : JSON.stringify(v); }
  /* The registry is too big for a small model's context, so only the rows
     that match the words (plus the groups) go in, with their current values. */
  function prompt(text, current, opts) {
    var R = registry();
    opts = opts || {};
    var limit = opts.limit || 22;
    var rows = [];
    var seen = {};
    function push(row) { if (row && !seen[row.id]) { seen[row.id] = 1; rows.push(row); } }
    splitClauses(text).forEach(function (c) { rank(c).slice(0, 4).forEach(function (r) { push(r.row); }); });
    rank(text).slice(0, limit).forEach(function (r) { push(r.row); });
    var mac = macroFor(text);
    if (mac) Object.keys(mac.macro.set).forEach(function (id) { push(R.get(id)); });
    ["appearance", "fontSize", "autoplay", "saveData", "protected", "friendsRail", "notify", "accent"].forEach(function (id) { if (rows.length < limit) push(R.get(id)); });
    rows = rows.slice(0, limit + 6);
    var lines = rows.map(function (row) {
      var kind = row.type === "enum" ? row.values.map(function (v) { return JSON.stringify(v); }).join("|") : row.type === "number" ? row.min + "-" + row.max : "true|false";
      return row.id + " = " + fmt(current[row.id]) + "  (" + kind + ") " + row.desc;
    });
    var opens = rank(text, { all: true }).filter(function (r) { return r.row.ai === false || r.row.type === "action"; }).slice(0, 3)
      .map(function (r) { return r.row.id + ": " + r.row.desc; });
    var macros = R.MACROS.map(function (m) { return m.label + " -> " + Object.keys(m.set).map(function (k) { return k + "=" + JSON.stringify(m.set[k]); }).join(", "); });
    var lang = LANG_NAME[opts.lang] || "English";
    var system = [
      "You are the settings assistant inside a social app. You change the user's app settings by returning JSON tool calls.",
      "Answer with one JSON object: {\"reply\": short friendly text in " + lang + ", \"calls\": [{\"fn\":\"set\",\"id\":<setting id>,\"value\":<new value>}]}.",
      "fn \"set\" changes a setting. fn \"open\" links to where a setting lives (use it for \"where is\" questions and for anything not in the list). fn \"read\" tells its current value.",
      "Only use ids from the list. Values must be one of the allowed values. Use several calls when the user asks for several things.",
      "Never log out, delete, or sign out: use \"open\" for those. If unsure, ask a short question and return no calls.",
      "Settings (id = current value (allowed) meaning):",
      lines.join("\n"),
      opens.length ? "Pages you can only open: " + opens.join("; ") : "",
      "Groups: " + macros.join("; "),
      "Example: user \"bigger text and no autoplay on mobile data\" -> {\"reply\":\"Done: bigger text, videos only autoplay on Wi-Fi.\",\"calls\":[{\"fn\":\"set\",\"id\":\"fontSize\",\"value\":16},{\"fn\":\"set\",\"id\":\"autoplay\",\"value\":\"wifi\"}]}"
    ].filter(Boolean).join("\n");
    return { system: system, rows: rows.map(function (r) { return r.id; }) };
  }

  /* Pull the reply text out of a JSON answer that is still streaming in. */
  function partialReply(buf) {
    var m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)("?)/.exec(String(buf || ""));
    if (!m) return "";
    var s = m[1].replace(/\\$/, "");
    try { return JSON.parse('"' + s + '"'); } catch (err) { return s.replace(/\\n/g, "\n").replace(/\\"/g, '"'); }
  }
  /* Read the model's final answer; tolerate prose around the JSON. */
  function readAnswer(text) {
    var s = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    var start = s.indexOf("{"), end = s.lastIndexOf("}");
    if (start < 0 || end <= start) return { reply: s, calls: [], bad: true };
    try {
      var obj = JSON.parse(s.slice(start, end + 1));
      return { reply: typeof obj.reply === "string" ? obj.reply : "", calls: Array.isArray(obj.calls) ? obj.calls : [], bad: false };
    } catch (err) { return { reply: partialReply(s), calls: [], bad: true }; }
  }

  return {
    WEBLLM_VERSION: WEBLLM_VERSION, TJS_VERSION: TJS_VERSION, MODELS: MODELS, SCHEMA: SCHEMA,
    model: model, detect: detect, tierOf: tierOf, choices: choices, downloadMB: downloadMB,
    tokens: tokens, rank: rank, langOf: langOf, splitClauses: splitClauses, parse: parse, plan: plan,
    prompt: prompt, partialReply: partialReply, readAnswer: readAnswer
  };
});
