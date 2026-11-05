/* Loads the pinned single-thread FFmpeg build and runs an argv list.
   The page passes bytes. This worker does not open URLs. */
"use strict";
var PIN_JS = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js";
var PIN_WASM = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm";
var core = null;

function fail(error) {
  self.postMessage({ op: "error", error: error });
}

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.op === "load") {
    if (msg.coreURL !== PIN_JS || msg.wasmURL !== PIN_WASM) { fail("unpinned"); return; }
    try { importScripts(PIN_JS); } catch (err) { fail("load"); return; }
    if (typeof createFFmpegCore !== "function") { fail("api"); return; }
    createFFmpegCore({ locateFile: function () { return PIN_WASM; } }).then(function (mod) {
      core = mod;
      if (core.setLogger) {
        core.setLogger(function (row) {
          self.postMessage({ op: "log", message: String(row && row.message || "").slice(0, 400) });
        });
      }
      self.postMessage({ op: "ready" });
    }).catch(function () { fail("load"); });
    return;
  }
  if (msg.op !== "exec") return;
  if (!core || !core.FS || typeof core.exec !== "function") { fail("api"); return; }
  var args = msg.args;
  if (!Array.isArray(args) || args.some(function (arg) { return typeof arg !== "string" || arg.indexOf("://") >= 0 || arg.indexOf("\0") >= 0; })) {
    fail("args");
    return;
  }
  try {
    if (msg.inputName && msg.input) core.FS.writeFile(msg.inputName, msg.input);
    var code = core.exec.apply(core, args);
    var file = msg.outputName ? core.FS.readFile(msg.outputName) : null;
    self.postMessage({ op: "done", code: code, file: file });
  } catch (err) {
    fail(String(err && err.message || err).slice(0, 240));
  }
};
