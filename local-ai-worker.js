/* Local AI worker. Runs the chosen model off the main thread:
   WebLLM (WebGPU) for Qwen3.5 0.8B / 2B / 4B, or transformers.js (WASM) when
   there is no WebGPU. The libraries and weights are fetched once from public
   CDNs (jsDelivr, Hugging Face, the MLC model libraries on GitHub) and kept
   in Cache Storage, so after the first download everything runs offline.
   Prompts and answers never leave this worker. */
"use strict";

var LIB_CACHE = "viktorych-local-ai-lib-v1";
var WEBLLM_URL = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm";
var TJS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm";
var CDN = "https://cdn.jsdelivr.net";

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
    var job = msg.engine === "tjs" ? loadTjs(id, msg.model, msg.dtype) : loadWebLLM(id, msg.model);
    job.then(function () { post({ type: "ready", id: id, model: msg.model }); }, function (err) {
      post({ type: "error", id: id, error: String((err && err.message) || err) });
    });
    return;
  }
  if (msg.type === "chat") {
    if (!state.engine) { post({ type: "error", id: id, error: "not loaded" }); return; }
    state.abort = null;
    var run = state.kind === "tjs" ? chatTjs(id, msg) : chatWebLLM(id, msg);
    run.then(function (text) { post({ type: "done", id: id, text: text }); }, function (err) {
      post({ type: "error", id: id, error: String((err && err.message) || err) });
    });
    return;
  }
  if (msg.type === "forget") {
    var del = [];
    if (state.webllm && msg.engine === "webllm") del.push(state.webllm.deleteModelAllInfoInCache(msg.model));
    if (msg.engine === "tjs") del.push(caches.delete("transformers-cache"));
    Promise.all(del).then(function () {
      if (state.modelId === msg.model) { state.engine = null; state.modelId = ""; }
      post({ type: "forgot", id: id });
    }, function () { post({ type: "forgot", id: id }); });
  }
};
