/* Local AI worker. Runs the chosen model off the main thread:
   WebLLM (WebGPU) for Qwen3.5 0.8B / 2B / 4B, transformers.js (WASM) when
   there is no WebGPU, or wllama (llama.cpp, WASM) for a GGUF model from
   Hugging Face. The libraries and weights are fetched once from public
   CDNs (jsDelivr, Hugging Face, the MLC model libraries on GitHub) and kept
   in Cache Storage, so after the first download everything runs offline.
   Prompts and answers never leave this worker. */
"use strict";

var LIB_CACHE = "viktorych-local-ai-lib-v1";
var WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm";
var TJS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm";
var CDN = "https://cdn.jsdelivr.net";
var WLLAMA_URL = CDN + "/npm/@wllama/wllama@3.8.1/esm/index.js";
var WLLAMA_WASM = CDN + "/npm/@wllama/wllama@3.8.1/esm/wasm/wllama.wasm";

var state = { engine: null, kind: "", modelId: "", busy: false, abort: null, tjs: null };

function post(msg) { self.postMessage(msg); }

/* Cache-first text fetch for a library file. */
function cachedText(url) {
  var open = self.caches ? caches.open(LIB_CACHE) : Promise.resolve(null);
  return open.then(function (cache) {
    return (cache ? cache.match(url) : Promise.resolve(null)).then(function (hit) {
      if (hit) return hit.text();
      return fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" }).then(function (res) {
        if (!res.ok) throw new Error("fetch " + res.status);
        var copy = res.clone();
        return (cache ? cache.put(url, copy) : Promise.resolve()).then(function () { return res.text(); });
      });
    });
  });
}

/* Load a jsDelivr "+esm" module and everything it imports from cached text,
   rewriting "/npm/..." imports to blob URLs, so it also loads offline. */
var blobs = {};
function loadGraph(url) {
  if (blobs[url]) return blobs[url];
  blobs[url] = cachedText(url).then(function (src) {
    var deps = {};
    var re = /(?:from\s*|import\s*\(?\s*)["'](\/npm\/[^"']+)["']/g;
    var m;
    while ((m = re.exec(src))) deps[m[1]] = 1;
    var list = Object.keys(deps);
    return Promise.all(list.map(function (p) { return loadGraph(CDN + p); })).then(function (urls) {
      list.forEach(function (p, i) { src = src.split('"' + p + '"').join('"' + urls[i] + '"'); });
      return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    });
  });
  return blobs[url];
}
function importCached(url) { return loadGraph(url).then(function (blob) { return import(blob); }); }

function progress(id, p) { post({ type: "progress", id: id, progress: p }); }

function loadWebLLM(id, modelId) {
  return importCached(WEBLLM_URL).then(function (webllm) {
    state.webllm = webllm;
    return webllm.CreateMLCEngine(modelId, {
      initProgressCallback: function (r) { progress(id, { fraction: r.progress || 0, text: r.text || "" }); }
    });
  }).then(function (engine) { state.engine = engine; state.kind = "webllm"; state.modelId = modelId; });
}

function loadTjs(id, modelId, dtype) {
  return importCached(TJS_URL).then(function (T) {
    state.tjs = T;
    T.env.allowLocalModels = false;
    T.env.useBrowserCache = true;
    var files = {};
    return T.pipeline("text-generation", modelId, {
      dtype: dtype || "q4", device: "wasm",
      progress_callback: function (p) {
        if (p && p.status === "progress" && p.file) {
          files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
          var loaded = 0, total = 0;
          Object.keys(files).forEach(function (k) { loaded += files[k].loaded; total += files[k].total; });
          progress(id, { fraction: total ? loaded / total : 0, loaded: loaded, total: total, text: p.file });
        }
      }
    });
  }).then(function (pipe) { state.engine = pipe; state.kind = "tjs"; state.modelId = modelId; });
}

/* GGUF (wllama): the library and its WebAssembly come from jsDelivr only
   when a GGUF model is picked; the model file goes to wllama's own cache
   (the origin private file system), so it also loads offline. */
function cachedBlobUrl(url) {
  return caches.open(LIB_CACHE).then(function (cache) {
    return cache.match(url).then(function (hit) {
      if (hit) return hit.blob();
      return fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" }).then(function (res) {
        if (!res.ok) throw new Error("fetch " + res.status);
        return cache.put(url, res.clone()).then(function () { return res.blob(); });
      });
    });
  }).then(function (blob) { return URL.createObjectURL(new Blob([blob], { type: "application/wasm" })); });
}
function wllamaLib() {
  if (!state.wl) state.wl = importCached(WLLAMA_URL);
  return state.wl;
}
function newWllama() {
  return Promise.all([wllamaLib(), cachedBlobUrl(WLLAMA_WASM)]).then(function (r) {
    return new r[0].Wllama({ default: r[1] }, { suppressNativeLog: true, allowOffline: true, logger: r[0].LoggerWithoutDebug });
  });
}
function loadGguf(id, modelId, url) {
  var old = state.kind === "gguf" && state.engine ? state.engine.exit().catch(function () {}) : Promise.resolve();
  return old.then(newWllama).then(function (wl) {
    return wl.loadModelFromUrl(url, {
      n_ctx: 2048, n_gpu_layers: 0, useCache: true,
      progressCallback: function (p) { var t = (p && p.total) || 0; progress(id, { fraction: t ? p.loaded / t : 0, loaded: (p && p.loaded) || 0, total: t, text: "" }); }
    }).then(function () { state.engine = wl; state.kind = "gguf"; state.modelId = modelId; });
  });
}
function chatGguf(id, msg) {
  var buf = "";
  var ctl = new AbortController();
  state.ggufAbort = ctl;
  var req = { messages: msg.messages, stream: true, temperature: 0.2, max_tokens: msg.maxTokens || 320, abortSignal: ctl.signal, chat_template_kwargs: { enable_thinking: false } };
  if (msg.schema) req.response_format = { type: "json_schema", json_schema: { name: "answer", schema: msg.schema } };
  var start = 0, n = 0;
  return state.engine.createChatCompletion(req).then(function (stream) {
    var it = stream[Symbol.asyncIterator]();
    function step() {
      if (state.abort === id) ctl.abort();
      return it.next().then(function (r) {
        if (r.done) return buf;
        var d = r.value && r.value.choices && r.value.choices[0] && r.value.choices[0].delta;
        if (d && d.content) {
          if (!start) start = Date.now(); else n += 1;
          buf += d.content;
          post({ type: "delta", id: id, text: buf, tps: n && Date.now() > start ? n * 1000 / (Date.now() - start) : 0 });
        }
        return step();
      });
    }
    return step();
  }).catch(function (err) { if (ctl.signal.aborted) return buf; throw err; });
}

function chatWebLLM(id, msg) {
  var buf = "";
  var req = {
    messages: msg.messages, stream: true, temperature: 0.2, top_p: 0.9, max_tokens: msg.maxTokens || 320,
    extra_body: { enable_thinking: false }
  };
  if (msg.schema) req.response_format = { type: "json_object", schema: JSON.stringify(msg.schema) };
  return state.engine.chat.completions.create(req).then(function (stream) {
    var it = stream[Symbol.asyncIterator]();
    function step() {
      if (state.abort === id) { try { state.engine.interruptGenerate(); } catch (err) {} }
      return it.next().then(function (r) {
        if (r.done) return buf;
        var d = r.value && r.value.choices && r.value.choices[0] && r.value.choices[0].delta;
        if (d && d.content) { buf += d.content; post({ type: "delta", id: id, text: buf }); }
        return step();
      });
    }
    return step();
  });
}

function chatTjs(id, msg) {
  var T = state.tjs;
  var buf = "";
  var tok = state.engine.tokenizer;
  var streamer = new T.TextStreamer(tok, {
    skip_prompt: true, skip_special_tokens: true,
    callback_function: function (text) { buf += text; post({ type: "delta", id: id, text: buf }); }
  });
  var messages = msg.messages.slice();
  // No grammar here, so start the answer with "{" to keep it on JSON.
  return state.engine(messages, {
    max_new_tokens: msg.maxTokens || 220, do_sample: false, streamer: streamer,
    tokenizer_encode_kwargs: { enable_thinking: false }
  }).then(function () { return buf; });
}

self.onmessage = function (event) {
  var msg = event.data || {};
  var id = msg.id;
  if (msg.type === "abort") { state.abort = msg.target; return; }
  if (msg.type === "cached" && msg.engine === "gguf") {
    // Only look in wllama's folder of the origin private file system; the
    // library is never fetched just to answer this.
    var file = String(msg.url || "").split("/").pop();
    var size = Number(msg.size) || 0;
    Promise.resolve().then(function () { return navigator.storage.getDirectory(); })
      .then(function (root) { return root.getDirectoryHandle("cache"); })
      .then(function (dir) {
        var it = dir.values();
        function next() {
          return it.next().then(function (r) {
            if (r.done) return false;
            var h = r.value;
            if (h.kind !== "file" || h.name.slice(-(file.length + 1)) !== "_" + file) return next();
            return h.getFile().then(function (f) { return f.size > 0 && (!size || f.size === size) ? true : next(); });
          });
        }
        return file ? next() : false;
      })
      .then(function (yes) { post({ type: "cached", id: id, yes: !!yes }); }, function () { post({ type: "cached", id: id, yes: false }); });
    return;
  }
  if (msg.type === "cached") {
    var check = function () { return msg.engine === "webllm"
      ? importCached(WEBLLM_URL).then(function (w) { return w.hasModelInCache(msg.model); })
      : caches.keys().then(function (keys) { return keys.indexOf("transformers-cache") >= 0 ? caches.open("transformers-cache").then(function (c) { return c.keys(); }).then(function (reqs) { return reqs.some(function (r) { return r.url.indexOf(msg.model) >= 0 && /onnx_data|\.onnx$/.test(r.url); }); }) : false; }); };
    // Library caches never auto-download here: hasModelInCache only reads.
    // Only look: never start a library download just to answer this.
    var libReady = msg.engine === "webllm" ? caches.open(LIB_CACHE).then(function (c) { return c.match(WEBLLM_URL); }) : Promise.resolve(true);
    libReady.then(function (has) { return has ? check() : false; }).then(function (yes) { post({ type: "cached", id: id, yes: !!yes }); }, function () { post({ type: "cached", id: id, yes: false }); });
    return;
  }
  if (msg.type === "load") {
    if (state.engine && state.modelId === msg.model) { post({ type: "ready", id: id, model: msg.model }); return; }
    var job = msg.engine === "gguf" ? loadGguf(id, msg.model, msg.url) : msg.engine === "tjs" ? loadTjs(id, msg.model, msg.dtype) : loadWebLLM(id, msg.model);
    job.then(function () { post({ type: "ready", id: id, model: msg.model }); }, function (err) {
      post({ type: "error", id: id, error: String((err && err.message) || err) });
    });
    return;
  }
  if (msg.type === "chat") {
    if (!state.engine) { post({ type: "error", id: id, error: "not loaded" }); return; }
    state.abort = null;
    var run = state.kind === "gguf" ? chatGguf(id, msg) : state.kind === "tjs" ? chatTjs(id, msg) : chatWebLLM(id, msg);
    run.then(function (text) { post({ type: "done", id: id, text: text }); }, function (err) {
      post({ type: "error", id: id, error: String((err && err.message) || err) });
    });
    return;
  }
  if (msg.type === "forget") {
    var del = [];
    if (state.webllm && msg.engine === "webllm") del.push(state.webllm.deleteModelAllInfoInCache(msg.model));
    if (msg.engine === "tjs") del.push(caches.delete("transformers-cache"));
    if (msg.engine === "gguf" && msg.url) {
      var unload = state.kind === "gguf" && state.modelId === msg.model ? state.engine.exit().catch(function () {}) : Promise.resolve();
      del.push(unload.then(wllamaLib).then(function (W) { return new W.CacheManager().delete(msg.url); }));
    }
    Promise.all(del).then(function () {
      if (state.modelId === msg.model) { state.engine = null; state.modelId = ""; }
      post({ type: "forgot", id: id });
    }, function () { post({ type: "forgot", id: id }); });
  }
};
