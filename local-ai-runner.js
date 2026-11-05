/* Runs a Viktrych tool step inside the page: a private file workspace,
   a direct media fetch, FFmpeg or code in a worker, then a device save.
   Tests pass their own fetch, storage and workers. */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychLocalRunner = api;
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  function pins() {
    if (root && root.ViktorychLocalTools) return root.ViktorychLocalTools;
    if (typeof require === "function") {
      try { return require("./local-ai-tools.js"); } catch (err) { return null; }
    }
    return null;
  }
  function concat(chunks, total) {
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (chunk) {
      out.set(chunk, at);
      at += chunk.byteLength;
    });
    return out;
  }
  function header(res, name) {
    if (!res || !res.headers) return "";
    if (typeof res.headers.get === "function") return res.headers.get(name) || "";
    return res.headers[name] || res.headers[name.toLowerCase()] || "";
  }
  function typeOk(type, file) {
    var text = String(type || "").toLowerCase();
    if (text.indexOf("text/html") >= 0) return false;
    if (text.indexOf("video/") === 0 || text.indexOf("audio/") === 0) return true;
    if (!text || text.indexOf("application/octet-stream") >= 0) return /\.(mp4|webm|mkv|mov|mp3|wav|ogg|m4a)$/i.test(file);
    return false;
  }
  function memoryStorage() {
    var files = {};
    return {
      put: function (name, bytes) { files[name] = bytes; return Promise.resolve(bytes.byteLength); },
      get: function (name) { return Promise.resolve(files[name] ? files[name] : null); },
      list: function () { return Promise.resolve(Object.keys(files)); },
      remove: function (name) { delete files[name]; return Promise.resolve(); }
    };
  }
  function opfsStorage() {
    var dirPromise = null;
    function dir() {
      if (!dirPromise) {
        dirPromise = navigator.storage.getDirectory().then(function (parent) {
          return parent.getDirectoryHandle("viktrych-tools", { create: true });
        });
      }
      return dirPromise;
    }
    return {
      put: function (name, bytes) {
        return dir().then(function (folder) {
          return folder.getFileHandle(name, { create: true }).then(function (handle) {
            return handle.createWritable().then(function (writable) {
              return writable.write(bytes).then(function () { return writable.close(); }).then(function () { return bytes.byteLength; });
            });
          });
        });
      },
      get: function (name) {
        return dir().then(function (folder) {
          return folder.getFileHandle(name).then(function (handle) {
            return handle.getFile().then(function (file) { return file.arrayBuffer(); }).then(function (buf) { return new Uint8Array(buf); });
          });
        }).catch(function () { return null; });
      },
      list: function () {
        return dir().then(function (folder) {
          if (!folder.entries) return [];
          var names = [];
          var iter = folder.entries();
          function next() {
            return iter.next().then(function (row) {
              if (row.done) return names;
              names.push(row.value[0]);
              return next();
            });
          }
          return next();
        }).catch(function () { return []; });
      },
      remove: function (name) {
        return dir().then(function (folder) { return folder.removeEntry(name); }).catch(function () {});
      }
    };
  }
  function readLimited(res, cap, ctrl) {
    if (res.body && res.body.getReader) {
      var reader = res.body.getReader();
      var chunks = [];
      var total = 0;
      function pump() {
        return reader.read().then(function (row) {
          if (row.done) return concat(chunks, total);
          total += row.value.byteLength;
          if (total > cap) {
            try { ctrl.abort(); } catch (err) { /* already stopped */ }
            var error = new Error("size");
            error.code = "size";
            throw error;
          }
          chunks.push(row.value);
          return pump();
        });
      }
      return pump();
    }
    if (typeof res.arrayBuffer === "function") {
      return res.arrayBuffer().then(function (buf) {
        if (buf.byteLength > cap) {
          var error = new Error("size");
          error.code = "size";
          throw error;
        }
        return new Uint8Array(buf);
      });
    }
    return Promise.reject(new Error("body"));
  }
  function createRunner(deps) {
    deps = deps || {};
    var tools = deps.tools || pins();
    var storage = deps.storage || memoryStorage();
    var fetchImpl = deps.fetch || null;
    var caps = deps.capabilities || (tools ? tools.capabilitiesFrom({}) : { python: false, storage: 0 });
    var active = null;
    function stopActive() {
      if (active && active.terminate) {
        try { active.terminate(); } catch (err) { /* already gone */ }
      }
      active = null;
    }
    function callWorker(worker, message, ms) {
      active = worker;
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          stopActive();
          var error = new Error("timeout");
          error.code = "timeout";
          reject(error);
        }, ms || (tools ? tools.LIMITS.timeoutMs : 20000));
        worker.onmessage = function (event) {
          var data = event.data || {};
          if (data.op === "log" || data.op === "progress") {
            if (deps.onProgress) deps.onProgress(data);
            return;
          }
          clearTimeout(timer);
          resolve(data);
        };
        worker.onerror = function () {
          clearTimeout(timer);
          var error = new Error("worker");
          error.code = "worker";
          reject(error);
        };
        if (deps.onStop) deps.onStop(stopActive);
        worker.postMessage(message);
      });
    }
    function pull(url, left, cap, ctl) {
      var ctrl = typeof AbortController === "function" ? new AbortController() : { abort: function () {}, signal: undefined };
      var timer = setTimeout(function () { try { ctrl.abort(); } catch (err) { /* no signal */ } }, tools ? tools.LIMITS.timeoutMs : 20000);
      if (ctl && ctl.cancelled && ctl.cancelled()) {
        clearTimeout(timer);
        return Promise.resolve({ ok: false, error: "cancelled" });
      }
      return fetchImpl(url, {
        method: "GET",
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: ctrl.signal
      }).then(function (res) {
        clearTimeout(timer);
        var status = res.status || 0;
        if (status >= 300 && status < 400) {
          if (left <= 0) return { ok: false, error: "redirect" };
          var next = tools.classifyUrl(new URL(header(res, "location"), url).href);
          if (!next.ok) return { ok: false, error: next.reason };
          return pull(next.url, left - 1, cap, ctl);
        }
        if (status !== 200) return { ok: false, error: status === 0 ? "cors" : "http" };
        if (!typeOk(header(res, "content-type"), url)) return { ok: false, error: "type" };
        var length = Number(header(res, "content-length") || 0);
        if (length > cap) return { ok: false, error: "size" };
        return readLimited(res, cap, ctrl).then(function (bytes) {
          return bytes && bytes.byteLength ? { ok: true, bytes: bytes } : { ok: false, error: "empty" };
        });
      }).catch(function (err) {
        clearTimeout(timer);
        return { ok: false, error: err && err.code ? err.code : "cors" };
      });
    }
    function storeChecked(name, bytes) {
      if (!bytes || !bytes.byteLength || !tools.safeFile(name)) return Promise.resolve({ ok: false, error: "no-file", bytes: 0, path: name || "" });
      return storage.put(name, bytes).then(function () { return storage.get(name); }).then(function (back) {
        if (!back || !back.byteLength) return { ok: false, error: "no-file", claimsFile: true, bytes: 0, path: name };
        return { ok: true, claimsFile: true, bytes: back.byteLength, path: name, verified: true };
      });
    }
    function spawn(kind) {
      if (deps.spawnWorker) return deps.spawnWorker(kind);
      if (typeof Worker !== "function" || typeof document === "undefined") return null;
      var file = kind === "code" ? "local-ai-code-worker.js" : "local-ai-ffmpeg-worker.js";
      try { return new Worker(new URL(file, document.baseURI).href); } catch (err) { return null; }
    }
    function runFfmpeg(args, inputName, input, outputName, ctl) {
      var worker = spawn("ffmpeg");
      if (!worker) return Promise.resolve({ ok: false, error: "worker" });
      if (ctl && ctl.onStop) ctl.onStop(function () { try { worker.terminate(); } catch (err) { /* gone */ } });
      return callWorker(worker, { op: "load", coreURL: tools.PINS.ffmpegCore, wasmURL: tools.PINS.ffmpegWasm }).then(function (ready) {
        if (!ready || ready.op !== "ready") return { ok: false, error: ready && ready.error || "load" };
        return callWorker(worker, { op: "exec", args: args, inputName: inputName, input: input, outputName: outputName });
      }).then(function (done) {
        try { worker.terminate(); } catch (err) { /* already closed */ }
        if (!done || done.op === "error") return { ok: false, error: done && done.error || "ffmpeg" };
        if (outputName) {
          var file = done.file;
          if (!file || !file.byteLength) return { ok: false, error: "no-file", claimsFile: true, bytes: 0, path: outputName };
          return storeChecked(outputName, file instanceof Uint8Array ? file : new Uint8Array(file));
        }
        return { ok: done.code === 0 || done.op === "done", out: "ffmpeg", claimsFile: false };
      }).catch(function (err) {
        return { ok: false, error: err && err.code ? err.code : "ffmpeg" };
      });
    }
    function exec(step, ctl) {
      ctl = ctl || {};
      if (ctl.cancelled && ctl.cancelled()) return Promise.resolve({ ok: false, error: "cancelled" });
      if (!tools) return Promise.resolve({ ok: false, error: "tools" });
      if (step.name === "workspace.list") {
        return storage.list().then(function (names) { return { ok: true, out: (names || []).join("\n"), claimsFile: false }; });
      }
      if (step.name === "media.fetch") {
        var checked = tools.classifyUrl(step.url);
        if (!checked.ok) return Promise.resolve({ ok: false, error: checked.reason, claimsFile: true, bytes: 0, path: step.file || "" });
        if (!fetchImpl) return Promise.resolve({ ok: false, error: "cors", claimsFile: true, bytes: 0 });
        var cap = Math.min(tools.LIMITS.maxFetch, caps.storage || tools.LIMITS.maxFetch);
        return pull(checked.url, 3, cap, ctl).then(function (got) {
          if (!got.ok) return { ok: false, error: got.error, claimsFile: true, bytes: 0, path: step.file };
          return storeChecked(step.file, got.bytes);
        });
      }
      if (step.name === "media.save") {
        return storage.get(step.file).then(function (bytes) {
          if (!bytes || !bytes.byteLength) return { ok: false, error: "no-file", claimsFile: true, bytes: 0, path: step.file || "" };
          if (!deps.saveFile) return { ok: false, error: "save", claimsFile: true, bytes: 0 };
          return deps.saveFile(bytes, step.file).then(function (saved) {
            if (!saved || !saved.ok) return { ok: false, error: (saved && saved.error) || "save", claimsFile: true, bytes: 0 };
            return { ok: true, claimsFile: true, bytes: bytes.byteLength, path: step.file, via: saved.via, verified: true };
          });
        });
      }
      if (step.name === "ffmpeg.load") {
        var versionArgs = tools.ffmpegArgs("version");
        return runFfmpeg(versionArgs, "", null, "", ctl);
      }
      if (step.name === "ffmpeg.convert") {
        var args = tools.ffmpegArgs(step.kind || "mp4", step.input, step.file);
        if (!args) return Promise.resolve({ ok: false, error: "args", claimsFile: true, bytes: 0 });
        return storage.get(step.input).then(function (bytes) {
          if (!bytes || !bytes.byteLength) return { ok: false, error: "no-file", claimsFile: true, bytes: 0, path: step.file };
          return runFfmpeg(args, step.input, bytes, step.file, ctl);
        });
      }
      if (step.name === "code.run") {
        if (step.lang === "py" && caps.python === false) return Promise.resolve({ ok: false, error: "memory" });
        var worker = spawn("code");
        if (!worker) return Promise.resolve({ ok: false, error: "worker" });
        var message = step.lang === "py" ? { op: "py", runtime: tools.PINS.pyodide, source: step.source } : { op: "js", source: step.source, files: {} };
        return callWorker(worker, message).then(function (done) {
          try { worker.terminate(); } catch (err) { /* closed */ }
          if (!done || done.ok === false) return { ok: false, error: done && done.error || "code", out: (done && done.logs || []).join("\n") };
          var writes = done.writes || [];
          var chain = Promise.resolve();
          writes.forEach(function (item) {
            chain = chain.then(function () {
              if (!tools.safeFile(item.path)) return null;
              var bytes = new TextEncoder().encode(String(item.text || ""));
              return storage.put(item.path, bytes);
            });
          });
          return chain.then(function () {
            return { ok: true, out: String(done.value || done.logs || "").slice(0, 4000), claimsFile: false };
          });
        }).catch(function (err) { return { ok: false, error: err && err.code ? err.code : "code" }; });
      }
      return Promise.resolve({ ok: false, error: "tool" });
    }
    return { exec: exec, capabilities: function () { return caps; }, stop: stopActive, storage: storage };
  }

  function browserCaps() {
    var memory = typeof navigator !== "undefined" && navigator.deviceMemory ? navigator.deviceMemory : 0;
    var worker = typeof Worker === "function";
    return {
      opfs: typeof navigator !== "undefined" && !!(navigator.storage && navigator.storage.getDirectory),
      worker: worker,
      sab: typeof SharedArrayBuffer === "function",
      isolated: typeof crossOriginIsolated === "boolean" ? crossOriginIsolated : false,
      memory: memory,
      storage: 0,
      picker: typeof showSaveFilePicker === "function",
      ffmpeg: worker,
      python: !memory || memory >= 4,
      agentsParallel: worker && (!memory || memory >= 4)
    };
  }
  function browserSave(bytes, name) {
    var blob = new Blob([bytes], { type: "application/octet-stream" });
    if (!blob.size) return Promise.resolve({ ok: false, error: "no-file" });
    if (typeof showSaveFilePicker === "function") {
      return showSaveFilePicker({ suggestedName: name }).then(function (handle) {
        return handle.createWritable();
      }).then(function (writable) {
        return writable.write(blob).then(function () { return writable.close(); });
      }).then(function () { return { ok: true, via: "picker" }; }).catch(function (err) {
        if (err && err.name === "AbortError") return { ok: false, error: "cancelled" };
        return downloadBlob(blob, name);
      });
    }
    return downloadBlob(blob, name);
  }
  function downloadBlob(blob, name) {
    if (!blob || !blob.size) return Promise.resolve({ ok: false, error: "no-file" });
    var link = document.createElement("a");
    var url = URL.createObjectURL(blob);
    link.href = url;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    return Promise.resolve({ ok: true, via: "download" });
  }
  var live = null;
  function browserRunner() {
    if (live) return live;
    var caps = browserCaps();
    live = createRunner({
      capabilities: caps,
      storage: caps.opfs ? opfsStorage() : memoryStorage(),
      fetch: typeof fetch === "function" ? fetch.bind(self) : null,
      saveFile: browserSave
    });
    return live;
  }
  return {
    createRunner: createRunner,
    memoryStorage: memoryStorage,
    browserCaps: browserCaps,
    exec: function (step, ctl) { return browserRunner().exec(step, ctl); },
    capabilities: function () { return browserCaps(); },
    stop: function () { if (live) live.stop(); }
  };
});
