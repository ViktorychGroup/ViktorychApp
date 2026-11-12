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
  /* GGUF models run by wllama (llama.cpp in WebAssembly, on the processor),
     loaded from jsDelivr only when one is picked. Small Q4_K_M instruct
     models that fit a mid-range phone (Pixel 6a class). Each file is a real
     Hugging Face repo and file, checked with a HEAD request in
     scripts/gguf_models_check.mjs; sizes are the files' bytes / 1e6.
     "uncensored" models are abliterated or Dolphin tunes: they refuse less
     and say so on their label. */
  var WLLAMA_VERSION = "3.8.1";
  var GGUF = [
    { label: "Qwen2.5 0.5B", repo: "bartowski/Qwen2.5-0.5B-Instruct-GGUF", file: "Qwen2.5-0.5B-Instruct-Q4_K_M.gguf", sizeMB: 398, paramsB: 0.5 },
    { label: "Gemma 3 1B abliterated", repo: "bartowski/huihui-ai_gemma-3-1b-it-abliterated-GGUF", file: "huihui-ai_gemma-3-1b-it-abliterated-Q4_K_M.gguf", sizeMB: 806, paramsB: 1, uncensored: true },
    { label: "Llama 3.2 1B", repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", sizeMB: 808, paramsB: 1.2 },
    { label: "Llama 3.2 1B abliterated", repo: "mradermacher/Llama-3.2-1B-Instruct-abliterated-GGUF", file: "Llama-3.2-1B-Instruct-abliterated.Q4_K_M.gguf", sizeMB: 955, paramsB: 1.2, uncensored: true },
    { label: "Qwen2.5 1.5B", repo: "bartowski/Qwen2.5-1.5B-Instruct-GGUF", file: "Qwen2.5-1.5B-Instruct-Q4_K_M.gguf", sizeMB: 986, paramsB: 1.5 },
    { label: "Qwen2.5 1.5B abliterated", repo: "mradermacher/Qwen2.5-1.5B-Instruct-abliterated-GGUF", file: "Qwen2.5-1.5B-Instruct-abliterated.Q4_K_M.gguf", sizeMB: 986, paramsB: 1.5, uncensored: true },
    { label: "Dolphin 3.0 Qwen2.5 1.5B", repo: "bartowski/Dolphin3.0-Qwen2.5-1.5B-GGUF", file: "Dolphin3.0-Qwen2.5-1.5B-Q4_K_M.gguf", sizeMB: 986, paramsB: 1.5, uncensored: true },
    { label: "Qwen3 1.7B abliterated", repo: "bartowski/mlabonne_Qwen3-1.7B-abliterated-GGUF", file: "mlabonne_Qwen3-1.7B-abliterated-Q4_K_M.gguf", sizeMB: 1107, paramsB: 1.7, uncensored: true }
  ];
  GGUF.forEach(function (g) {
    MODELS.push({ id: "gguf:" + g.repo + "/" + g.file, engine: "gguf", label: g.label, sizeMB: g.sizeMB, paramsB: g.paramsB, repo: g.repo, file: g.file, quant: "Q4_K_M", uncensored: !!g.uncensored, tiers: ["cpu"], family: "gguf" });
  });
  function ggufUrl(m) { return m && m.engine === "gguf" ? "https://huggingface.co/" + m.repo + "/resolve/main/" + m.file : ""; }
  var LIB_MB = { webllm: 2, tjs: 24, gguf: 9 };
  MODELS.forEach(function (m) { var b = /([0-9.]+)B/.exec(m.label); if (b && !m.paramsB) m.paramsB = Number(b[1]); });

  /* ---------- Speed ----------
     Size alone is a poor guide: a small model can still crawl on a phone.
     bench() is a short on-device test (about 0.1 s) of how many numbers per
     second this device's processor reads in JavaScript; token speed scales
     with it and falls with the model's size. A real chat replaces the guess
     with the measured tokens per second (info.speed[id]). */
  var GOOD_TPS = 6;
  function bench(now) {
    var perf = root && root.performance;
    now = now || function () { return perf && perf.now ? perf.now() : Date.now(); };
    var n = 1 << 20, a = new Float32Array(n), s = 0, reads = 0, i;
    for (i = 0; i < n; i += 1) a[i] = i & 255;
    var t0 = now(), t = t0;
    do { for (i = 0; i < n; i += 1) s += a[i]; reads += n; t = now(); } while (t - t0 < 60 && reads < n * 64);
    var ms = Math.max(1, t - t0);
    return { gops: Math.round(reads / ms / 1e3) / 1e3, ms: Math.round(ms), sink: s > 0 };
  }
  /* Expected tokens per second for model m, or 0 when unknown. */
  function expectTps(m, info) {
    if (!m || !m.paramsB) return 0;
    var seen = info && info.speed && Number(info.speed[m.id]);
    if (seen > 0) return seen;
    var g = info && info.bench && Number(info.bench.gops);
    if (!(g > 0)) return 0;
    var k = m.engine === "gguf" ? 8 : m.engine === "tjs" ? 5 : (info.mobile ? 6 : 30);
    return Math.round(g * k / m.paramsB * 10) / 10;
  }
  function measured(m, info) { return !!(m && info && info.speed && Number(info.speed[m.id]) > 0); }

  function model(id) {
    for (var i = 0; i < MODELS.length; i += 1) if (MODELS[i].id === id) return MODELS[i];
    return null;
  }

  /* A graphics probe or Chrome's built-in model check that never answers
     used to leave setup on "Checking this device…". Four seconds is enough
     for a real answer; after that the list is built from what we know. */
  var PROBE_MS = 4000;
  function within(promise, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("timeout"));
      }, ms);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
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
      jobs.push(within(Promise.resolve().then(function () { return nav.gpu.requestAdapter({ powerPreference: "high-performance" }); }), PROBE_MS).then(function (a) {
        if (!a) { info.webgpu = false; return; }
        info.f16 = !!(a.features && a.features.has && a.features.has("shader-f16"));
        info.maxBuffer = (a.limits && a.limits.maxBufferSize) || 0;
        info.fallbackAdapter = !!(a.info && a.info.isFallbackAdapter) || !!a.isFallbackAdapter;
      }).catch(function () { info.webgpu = false; }));
    }
    var LM = env.LanguageModel || (root && root.LanguageModel);
    if (LM && LM.availability) {
      jobs.push(within(Promise.resolve().then(function () { return LM.availability({ expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] }); }), PROBE_MS)
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
    // GGUF models from Hugging Face, in their own group; Instant stays last.
    if (info.wasm && !info.noGguf) MODELS.forEach(function (m) { if (m.engine === "gguf") list.push(m); });
    list.push(model("instant"));
    // Data saver, 2G and low-end devices start on Instant and are asked first.
    var recommended = (info.saveData || info.slowNet || info.lowEnd) ? model("instant") : list[0];
    if (recommended && recommended.engine === "tjs" && info.nano === "available") recommended = model("nano");
    // With a speed test or a measured speed, pick the biggest model that
    // still answers at GOOD_TPS or faster (never an Uncensored one).
    var tested = (info.bench && info.bench.gops > 0) || (info.speed && Object.keys(info.speed).length);
    if (recommended && recommended.engine !== "instant" && tested) {
      var best = null;
      list.forEach(function (m) {
        if (!m.paramsB || m.uncensored) return;
        var tps = expectTps(m, info);
        if (tps < GOOD_TPS) return;
        if (!best || m.paramsB > best.paramsB || (m.paramsB === best.paramsB && tps > expectTps(best, info))) best = m;
      });
      recommended = best || (info.nano === "available" ? model("nano") : model("instant"));
    }
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

  /* ---------- People: block, mute, unblock, unmute ----------
     Deterministic, so even Instant does it. Only an @handle the person typed
     counts, after a verb they typed; the same words from a post, a model
     answer or any other text never reach here (see plan opts.typed). */
  var PEOPLE_W = {
    block: ["block", "blocking", "bloquea", "bloquear", "bloquealo", "bloquéalo", "заблокируй", "заблокировать", "заблокируйте", "блокируй", "ब्लॉक"],
    unblock: ["unblock", "unblocking", "desbloquea", "desbloquear", "разблокируй", "разблокировать", "разблокируйте", "अनब्लॉक"],
    mute: ["mute", "muting", "silence", "silencia", "silenciar", "silencie", "замьють", "замьютить", "заглуши", "заглушить", "म्यूट"],
    unmute: ["unmute", "unmuting", "unsilence", "desilencia", "desilenciar", "размьють", "размьютить", "अनम्यूट"]
  };
  var PEOPLE_STOP = ["stop", "quit", "deja", "dejar", "перестань", "хватит"];
  var HANDLE_RE = /^@([a-z0-9_][a-z0-9_.-]{0,39})$/i;
  function peopleVerb(tok) {
    var keys = Object.keys(PEOPLE_W);
    for (var i = 0; i < keys.length; i += 1) if (PEOPLE_W[keys[i]].indexOf(tok) >= 0) return keys[i];
    return "";
  }
  function peopleToks(text) {
    return String(text || "").toLowerCase().split(/[\s,;:!?()"«»]+/).map(function (w) { return w.replace(/[.]+$/, ""); }).filter(Boolean);
  }
  /* "block @a and @b, mute @c" -> [{fn:"person", act:"block", on:true, handle:"@a"}, ...] */
  function parsePeople(text) {
    var toks = peopleToks(text);
    var out = [], seen = {}, act = "", on = true, lastAt = -9, pending = [], pendAt = -9;
    function put(handle) {
      var key = act + ":" + handle;
      if (seen[key] != null) out[seen[key]].on = on;
      else { seen[key] = out.length; out.push({ fn: "person", act: act, on: on, handle: handle }); }
    }
    toks.forEach(function (tok, i) {
      var h = HANDLE_RE.exec(tok);
      if (h) {
        var handle = "@" + h[1].replace(/[.-]+$/, "");
        // Verb last, as in Hindi "@name को म्यूट करो": keep it for a verb that follows.
        if (!act) { pending.push(handle); pendAt = i; return; }
        put(handle);
        lastAt = i;
        return;
      }
      var verb = peopleVerb(tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""));
      if (!verb) {
        // A long run of other words ends the verb ("block @a and turn off autoplay").
        if (act && i - lastAt > 3) act = "";
        return;
      }
      var stop = toks.slice(Math.max(0, i - 2), i).some(function (w) { return PEOPLE_STOP.indexOf(w) >= 0; });
      act = verb.indexOf("un") === 0 ? verb.slice(2) : verb;
      on = verb.indexOf("un") !== 0;
      if (stop) on = !on;
      lastAt = i;
      if (pending.length && i - pendAt <= 3) pending.forEach(put);
      pending = [];
    });
    return out;
  }
  /* Text left for the settings parser once people commands are taken out. */
  function withoutPeople(text) {
    if (!parsePeople(text).length) return String(text || "");
    var all = PEOPLE_STOP.slice();
    Object.keys(PEOPLE_W).forEach(function (k) { all = all.concat(PEOPLE_W[k]); });
    return String(text || "").split(/(\s+)/).filter(function (w) {
      var t = w.toLowerCase().replace(/^[^\p{L}@]+|[^\p{L}\p{N}_]+$/gu, "");
      return !(HANDLE_RE.test(t) || all.indexOf(t) >= 0);
    }).join("");
  }
  function personId(act, handle) { return "person:" + act + ":" + String(handle || "").toLowerCase(); }
  /* A card row for a person change, shaped like a registry row. */
  function personRow(id) {
    var m = /^person:(block|mute):(@[a-z0-9_][a-z0-9_.-]{0,39})$/.exec(String(id || ""));
    if (!m) return null;
    return { id: id, label: m[1] === "block" ? "Blocked" : "Muted", subject: m[2], act: m[1], handle: m[2], type: "bool", def: false, page: "#/settings/muted", cat: "privacy", risk: "safe", person: true };
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
    var calls = parsePeople(text), unknown = [];
    if (calls.length) text = withoutPeople(text);
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
        else if (tokens(clause).length) unknown.push(clause);
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
      var key = calls[i].fn === "person" ? personId(calls[i].act, calls[i].handle) : calls[i].fn + ":" + calls[i].id;
      if (!seen[key]) { seen[key] = 1; out.unshift(calls[i]); }
    }
    return out;
  }

  /* ---------- Checking tool calls ----------
     Every call from any engine goes through here. Unknown ids, read-only
     rows, danger rows and bad values are dropped. Returns
     { changes: [{id, row, from, to, risk}], opens: [row], reads: [{row, value}], rejected: [{call, why}] }. */
  function plan(calls, current, opts) {
    var R = registry();
    current = current || {};
    var out = { changes: [], opens: [], reads: [], rejected: [] };
    // People changes only for what the person typed themselves.
    var typed = {};
    parsePeople(opts && opts.typed).forEach(function (c) { typed[personId(c.act, c.handle) + ":" + c.on] = 1; });
    (Array.isArray(calls) ? calls : []).slice(0, 24).forEach(function (call) {
      if (!call || typeof call !== "object") return;
      var fn = String(call.fn || call.name || "set");
      if (fn === "person") {
        var act = String(call.act || ""), on = call.on !== false && call.on !== "false";
        var raw = String(call.handle || "");
        var h = HANDLE_RE.exec(raw.charAt(0) === "@" ? raw : "@" + raw);
        if ((act !== "block" && act !== "mute") || !h) { out.rejected.push({ call: call, why: "value" }); return; }
        var pid = personId(act, "@" + h[1]);
        if (!typed[pid + ":" + on]) { out.rejected.push({ call: call, why: "untyped" }); return; }
        var prow = personRow(pid);
        var was = current[pid] === true;
        if (was === on) { out.reads.push({ row: prow, value: was, same: true }); return; }
        if (out.changes.some(function (c) { return c.id === pid; })) return;
        out.changes.push({ id: pid, row: prow, from: was, to: on, risky: false, signedIn: false, person: true });
        return;
      }
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

  /* Auto is a local rule, not a claim that one model is best. It only
     chooses among models already on the device. */
  function paramsOf(m) {
    if (!m) return 0;
    if (m.paramsB) return m.paramsB;
    if (m.family === "max") return 4;
    if (m.family === "high") return 2;
    if (m.family === "lite" || m.family === "cpu" || m.engine === "tjs") return 0.8;
    if (m.engine === "nano") return 1.5;
    return 0;
  }
  function taskKind(text) {
    var s = String(text || "");
    if (/```|\b(function|const |let |class |def |ffmpeg|python|javascript)\b|код|código|कोड/i.test(s)) return "code";
    if (/\b(translate|translation|traduce|traducir|перевед|अनुवाद)\b/i.test(s)) return "translate";
    if (/summari|tldr|tl;dr|resumen|резюме|кратк|सार/i.test(s)) return "summarize";
    if (s.length > 500 || /\b(essay|story|article|ensayo|рассказ|статья|निबंध|कहानी)\b/i.test(s)) return "write";
    if (s.length < 180 && /\b(setting|autoplay|dark mode|ajuste|настройк|सेटिंग)\b/i.test(s)) return "settings";
    if (s.length < 160) return "short";
    return "write";
  }
  function fitsModel(m, info) {
    if (!m || m.engine === "instant" || m.engine === "nano") return true;
    info = info || {};
    var mb = m.vramMB || m.sizeMB || 0;
    if (info.lowEnd && (paramsOf(m) > 1 || mb > 2000)) return false;
    if (info.mem && mb > info.mem * 1024 * 0.55) return false;
    return true;
  }
  function readyModel(m, have, info) {
    if (!m) return false;
    if (m.uncensored && !(info && info.allowUncensored)) return false;
    if (m.engine === "instant") return true;
    if (m.engine === "nano") return !!(info && info.nano === "available");
    return !!(have && have[m.id]);
  }
  function pickAuto(text, opts) {
    opts = opts || {};
    var info = opts.info || {};
    info.allowUncensored = !!opts.allowUncensored;
    var have = opts.have || {};
    var kind = taskKind(text);
    var instant = model("instant");
    var pool = MODELS.filter(function (m) { return readyModel(m, have, info) && fitsModel(m, info); });
    if (kind === "short" || kind === "settings") return { model: instant, kind: kind, reason: kind };
    var heavy = pool.filter(function (m) {
      if (m.engine === "instant") return false;
      var tps = expectTps(m, info);
      return !(tps > 0 && tps < GOOD_TPS);
    });
    heavy.sort(function (a, b) { return paramsOf(b) - paramsOf(a); });
    if (!heavy.length) return { model: instant, kind: kind, reason: "fallback" };
    return { model: heavy[0], kind: kind, reason: kind };
  }

  return {
    WEBLLM_VERSION: WEBLLM_VERSION, TJS_VERSION: TJS_VERSION, WLLAMA_VERSION: WLLAMA_VERSION, MODELS: MODELS, SCHEMA: SCHEMA, ggufUrl: ggufUrl, GOOD_TPS: GOOD_TPS, bench: bench, expectTps: expectTps, measured: measured,
    model: model, detect: detect, tierOf: tierOf, choices: choices, downloadMB: downloadMB,
    tokens: tokens, rank: rank, langOf: langOf, splitClauses: splitClauses, parse: parse, plan: plan,
    parsePeople: parsePeople, withoutPeople: withoutPeople, personId: personId, personRow: personRow,
    prompt: prompt, partialReply: partialReply, readAnswer: readAnswer,
    taskKind: taskKind, pickAuto: pickAuto, paramsOf: paramsOf
  };
});
