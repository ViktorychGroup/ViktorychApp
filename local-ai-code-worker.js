/* Runs a short program away from the page. Network is turned off before
   user code. new Function stays in this worker, never on the page. */
"use strict";
var PY = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";

function denyNetwork() {
  var blocked = function () { throw new Error("network is off"); };
  self.fetch = blocked;
  self.XMLHttpRequest = blocked;
  self.WebSocket = blocked;
  self.importScripts = blocked;
  try { self.indexedDB = undefined; } catch (err) { /* some engines lock it */ }
  try { self.caches = undefined; } catch (err) { /* some engines lock it */ }
}

self.onmessage = function (event) {
  var msg = event.data || {};
  if (msg.op === "js") {
    denyNetwork();
    var logs = [];
    var writes = [];
    var files = msg.files && typeof msg.files === "object" ? msg.files : {};
    var api = {
      log: function () {
        var line = Array.prototype.map.call(arguments, function (value) { return String(value); }).join(" ").slice(0, 500);
        if (logs.join("\n").length < 8000) logs.push(line);
      },
      read: function (path) {
        return Object.prototype.hasOwnProperty.call(files, path) ? String(files[path]).slice(0, 8000) : "";
      },
      write: function (path, text) {
        if (writes.length < 8) writes.push({ path: String(path).slice(0, 60), text: String(text).slice(0, 8000) });
      }
    };
    try {
      var fn = new Function("api", "\"use strict\";\n" + String(msg.source || "").slice(0, 4000));
      var value = fn(api);
      self.postMessage({ op: "done", ok: true, logs: logs, value: value == null ? "" : String(value).slice(0, 4000), writes: writes });
    } catch (err) {
      self.postMessage({ op: "done", ok: false, error: String(err && err.message || err).slice(0, 300), logs: logs, writes: writes });
    }
    return;
  }
  if (msg.op !== "py") return;
  if (msg.runtime !== PY) { self.postMessage({ op: "done", ok: false, error: "unpinned" }); return; }
  try { importScripts(PY); } catch (err) { self.postMessage({ op: "done", ok: false, error: "python-unavailable" }); return; }
  if (typeof loadPyodide !== "function") { self.postMessage({ op: "done", ok: false, error: "python-unavailable" }); return; }
  loadPyodide().then(function (py) {
    denyNetwork();
    try {
      var value = py.runPython(String(msg.source || "").slice(0, 4000));
      self.postMessage({ op: "done", ok: true, value: value == null ? "" : String(value).slice(0, 4000), logs: [], writes: [] });
    } catch (err) {
      self.postMessage({ op: "done", ok: false, error: String(err && err.message || err).slice(0, 300), logs: [], writes: [] });
    }
  }).catch(function () {
    self.postMessage({ op: "done", ok: false, error: "python-unavailable", logs: [], writes: [] });
  });
};
