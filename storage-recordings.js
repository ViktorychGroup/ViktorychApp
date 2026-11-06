/* Recordings on the Storage page. The age identity lives in this module's
   memory for the tab and is never written, sent, or logged. Playback uses
   Media Source only for age-media-segments whose codec the browser accepts.
   Byte-chunk packages stay on the whole-file decrypt path. */
import {
  DOWNLOAD_CAP,
  MEMORY_CAP,
  SEGMENT_SLOTS,
  b64ToBytes,
  bytesToB64,
  chunkForTime,
  durationOf,
  filesFromInline,
  looksLikeIdentity,
  parseManifest,
  playbackPlan,
  providerRows,
  recorderStatus,
  sha256Hex
} from "./shared/storage-contract.js";
import { decryptBytes } from "./shared/storage-age.js";

const AGE_SRC = "vendor/age-0.3.1.min.js";
const OFF_KEY = "viktorychapp-server-off";

let identity = "";
let manifest = null;
let sources = new Map();
let deviceMode = "offline";
let preview = false;
let errorCode = "";
let busy = false;
let playerUrl = "";
let agePromise = null;
let shownIndex = -1;
const slots = { init: null, media: null };

function tr(key, vars) {
  return window.t ? window.t(key, vars) : key;
}
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}
function containsIdentity(value, depth) {
  if (value == null || depth > 4) return false;
  if (typeof value === "string") return value.indexOf("AGE-SECRET-KEY-") >= 0;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return false;
  if (typeof Blob !== "undefined" && value instanceof Blob) return false;
  if (typeof value !== "object") return false;
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).indexOf("AGE-SECRET-KEY-") >= 0) return true;
    if (containsIdentity(value[keys[i]], depth + 1)) return true;
  }
  return false;
}
function guardMethod(proto, name) {
  if (!proto || typeof proto[name] !== "function" || proto[name].__recGuard) return;
  const orig = proto[name];
  function wrapped(value, key) {
    if (containsIdentity(value, 0) || containsIdentity(key, 0)) throw new Error("identity-persist");
    return orig.apply(this, arguments);
  }
  wrapped.__recGuard = true;
  proto[name] = wrapped;
}
function installGuards() {
  if (typeof window === "undefined" || window.__recGuards) return;
  window.__recGuards = true;
  ["localStorage", "sessionStorage"].forEach(function (name) {
    const store = window[name];
    if (!store || typeof store.setItem !== "function") return;
    const orig = store.setItem.bind(store);
    store.setItem = function (key, value) {
      if (containsIdentity(key, 0) || containsIdentity(value, 0)) throw new Error("identity-persist");
      return orig(key, value);
    };
  });
  if (typeof IDBObjectStore !== "undefined") {
    guardMethod(IDBObjectStore.prototype, "put");
    guardMethod(IDBObjectStore.prototype, "add");
  }
  if (typeof window.fetch === "function") {
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (containsIdentity(input, 0) || (init && containsIdentity(init.body, 0))) return Promise.reject(new Error("identity-network"));
      return orig(input, init);
    };
  }
  if (typeof navigator !== "undefined" && navigator.sendBeacon) {
    const orig = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      if (containsIdentity(url, 0) || containsIdentity(data, 0)) return false;
      return orig(url, data);
    };
  }
}
installGuards();

export function recordingsEnabled() {
  try {
    const list = JSON.parse(localStorage.getItem(OFF_KEY) || "[]");
    return !(Array.isArray(list) && list.indexOf("storage_recordings") >= 0);
  } catch (err) {
    return true;
  }
}
function paint() {
  if (window.ViktorychAccounts && window.ViktorychAccounts.requestRender) window.ViktorychAccounts.requestRender();
}
function plan() {
  const supported = (mime) => {
    try { return !!(window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(mime)); }
    catch (err) { return false; }
  };
  return playbackPlan(manifest, supported);
}
function canPlayFile(mime) {
  if (!mime || typeof document === "undefined") return false;
  const el = document.createElement(mime.indexOf("audio/") === 0 ? "audio" : "video");
  const answer = el.canPlayType ? el.canPlayType(mime) : "";
  return answer === "probably" || answer === "maybe";
}
function stateLabel(state) {
  if (state === "ready") return tr("Ready");
  if (state === "locked") return tr("Locked");
  if (state === "local") return tr("On this device");
  if (state === "idle") return tr("Idle");
  if (state === "recording") return tr("Recording");
  if (state === "stopped") return tr("Stopped");
  if (state === "unknown") return tr("Unknown");
  if (state === "unlinked") return tr("Not linked");
  return tr("Not connected");
}
function providerName(id) {
  if (id === "device") return tr("This device");
  if (id === "recordings") return tr("Recordings");
  if (id === "telegram") return tr("Telegram");
  if (id === "gdrive") return tr("Google Drive");
  if (id === "onedrive") return tr("OneDrive");
  if (id === "cryptomator") return tr("Cryptomator");
  return id;
}
function errorText() {
  if (errorCode === "key") return tr("That key did not decrypt this recording.");
  if (errorCode === "tamper") return tr("The file was changed. It was not decrypted.");
  if (errorCode === "locked") return tr("Recordings are locked.");
  if (errorCode === "identity") return tr("Use an age identity. It starts with AGE-SECRET-KEY-1.");
  if (errorCode === "too-large") return tr("This recording is too large to decrypt in this tab.");
  if (errorCode === "missing") return tr("Chunk files are missing from the folder you chose.");
  if (errorCode === "catalog" || errorCode === "kind" || errorCode === "chunk") return tr("Could not read that catalog.");
  if (errorCode === "codec") return tr("This format cannot play in this browser. Nothing is re-encoded.");
  return "";
}
function noteText() {
  if (!manifest && preview) return tr("This recording is stored as encrypted byte chunks, not playable video segments.");
  if (!manifest) return tr("No recorder is linked. Recordings open from a catalog on this device. Nothing is uploaded.");
  const current = plan();
  if (manifest.kind === "age-byte-chunks" || current.reason === "byte-chunks") {
    return tr("This recording is stored as encrypted byte chunks, not playable video segments.");
  }
  if (current.mode === "unsupported") return tr("This format cannot play in this browser. Nothing is re-encoded.");
  if (current.mode === "too-large") return tr("This recording is too large to decrypt in this tab.");
  if (current.mode === "file" || current.wholeFile) return tr("This plays the whole decrypted file. It is not streamed by segment.");
  return "";
}

export function recordingsHtml(mode, isPreview) {
  deviceMode = mode || "offline";
  preview = !!isPreview;
  if (!recordingsEnabled()) return "";
  const rows = providerRows(deviceMode).map(function (row) {
    return '<div class="rec-row" data-provider="' + esc(row.id) + '" data-provider-state="' + esc(row.state) + '"><b>' + esc(providerName(row.id)) + '</b><span>' + esc(stateLabel(row.state)) + "</span></div>";
  }).join("");
  const rec = manifest ? recorderStatus(manifest) : { state: "unlinked", detail: "" };
  const current = plan();
  const locked = !identity;
  const title = manifest ? manifest.title : (preview ? tr("Example recording") : "");
  const kind = manifest ? manifest.kind : (preview ? "age-byte-chunks" : "");
  const actions = [];
  if (manifest && !locked && (current.mode === "download" || current.mode === "file" || current.mode === "unsupported" || current.wholeFile)) {
    actions.push('<button class="outline" type="button" data-act="stop" data-rec="download">' + esc(tr("Download and decrypt")) + "</button>");
  }
  if (manifest && !locked && current.mode === "file" && canPlayFile(current.mime)) {
    actions.push('<button class="save" type="button" data-act="stop" data-rec="play-file">' + esc(tr("Play decrypted file")) + "</button>");
  }
  if (manifest && !locked && current.wholeFile && canPlayFile(current.mime)) {
    actions.push('<button class="save" type="button" data-act="stop" data-rec="play-file">' + esc(tr("Play decrypted file")) + "</button>");
  }
  if (manifest && !locked && current.mode === "mse") {
    actions.push('<button class="save" type="button" data-act="stop" data-rec="play">' + esc(tr("Play")) + "</button>");
  }
  const form = locked
    ? '<form data-rec-form="unlock"><label class="field"><span>' + esc(tr("Recording key")) + '</span><input id="rec-key" type="password" autocomplete="off" spellcheck="false"></label><p class="rec-note">' + esc(tr("The key stays in this tab. It is not saved or sent.")) + '</p><button class="save" type="submit">' + esc(tr("Unlock recordings")) + "</button></form>"
    : '<button class="outline" type="button" data-act="stop" data-rec="lock">' + esc(tr("Lock recordings")) + "</button>";
  const item = title
    ? '<article class="rec-item" data-rec-kind="' + esc(kind) + '" data-rec-example="' + (manifest ? "0" : "1") + '"><h3>' + esc(title) + "</h3><p class=\"rec-note\">" + esc(noteText()) + "</p>" + (actions.length ? '<div class="rec-actions">' + actions.join("") + "</div>" : "") + (manifest ? '<video id="rec-video" class="rec-video" controls playsinline muted></video>' : "") + "</article>"
    : "";
  const linked = rec.state !== "unlinked";
  return '<section class="rec-block" id="rec-root" data-recorder="' + esc(rec.state) + '">' +
    '<h2>' + esc(tr("Recordings")) + "</h2>" +
    (linked ? "" : '<p class="rec-note">' + esc(tr("No recorder is linked. Recordings open from a catalog on this device. Nothing is uploaded.")) + "</p>") +
    '<div class="rec-row" data-recorder-status="' + esc(rec.state) + '"><b>' + esc(tr("Recorder")) + "</b><span>" + esc(stateLabel(rec.state)) + "</span></div>" +
    (rec.detail ? '<p class="rec-note">' + esc(rec.detail) + "</p>" : "") +
    form +
    '<div class="rec-actions"><label class="outline">' + esc(tr("Open a catalog")) + '<input id="rec-catalog" type="file" accept="application/json,.json" hidden></label>' +
    '<label class="outline">' + esc(tr("Choose the folder of chunk files")) + '<input id="rec-folder" type="file" webkitdirectory multiple hidden></label></div>' +
    (errorCode ? '<p class="rec-error" data-rec-error="' + esc(errorCode) + '">' + esc(errorText()) + "</p>" : "") +
    item +
    '<h2>' + esc(tr("Providers")) + "</h2>" +
    rows +
    '<p class="rec-note">' + esc(tr("This page does not sign in to Telegram, Google Drive, OneDrive or Cryptomator.")) + "</p>" +
    '<p class="rec-note">' + esc(tr("Encrypted files on this device")) + "</p>" +
    "</section>";
}

function dropPlayer() {
  const video = document.getElementById("rec-video");
  if (video) {
    video.pause();
    video.removeAttribute("src");
    try { video.load(); } catch (err) { /* the element may already be gone */ }
  }
  if (playerUrl) {
    URL.revokeObjectURL(playerUrl);
    playerUrl = "";
  }
  slots.init = null;
  slots.media = null;
  shownIndex = -1;
}
export function lockRecordings() {
  identity = "";
  dropPlayer();
  errorCode = "";
}
export function unlockRecordings(value) {
  identity = "";
  const next = String(value || "").replace(/\s+/g, "");
  if (!looksLikeIdentity(next)) {
    errorCode = "identity";
    return false;
  }
  identity = next;
  errorCode = "";
  return true;
}
function loadAge() {
  if (window.age && window.age.Decrypter) return Promise.resolve(window.age);
  if (agePromise) return agePromise;
  agePromise = new Promise(function (resolve, reject) {
    const script = document.createElement("script");
    script.src = AGE_SRC;
    script.async = false;
    script.onload = function () {
      if (window.age && window.age.Decrypter) resolve(window.age);
      else reject(new Error("age"));
    };
    script.onerror = function () { agePromise = null; reject(new Error("age")); };
    document.head.appendChild(script);
  });
  return agePromise;
}
async function readNamed(name) {
  const src = sources.get(name);
  if (!src) {
    errorCode = "missing";
    throw new Error("missing");
  }
  if (src instanceof Uint8Array) return src;
  return new Uint8Array(await src.arrayBuffer());
}
async function openChunk(chunk) {
  if (!identity) {
    errorCode = "locked";
    throw new Error("locked");
  }
  const bytes = await readNamed(chunk.name);
  const hash = await sha256Hex(bytes);
  if (hash !== chunk.sha256) {
    errorCode = "tamper";
    throw new Error("tamper");
  }
  try {
    const age = await loadAge();
    const plain = await decryptBytes(age, identity, bytes);
    if (plain.byteLength > MEMORY_CAP && plain.byteLength > chunk.plainBytes) {
      errorCode = "too-large";
      throw new Error("too-large");
    }
    errorCode = "";
    return plain;
  } catch (err) {
    if (errorCode !== "too-large") errorCode = "key";
    throw err;
  }
}
function orderedChunks() {
  return (manifest.chunks || []).slice().sort(function (a, b) { return a.index - b.index; });
}
export async function decryptPackage() {
  if (!manifest) return { error: "catalog" };
  if (!identity) {
    errorCode = "locked";
    return { error: "locked" };
  }
  const total = orderedChunks().reduce(function (sum, chunk) { return sum + chunk.plainBytes; }, 0);
  if (total > DOWNLOAD_CAP) {
    errorCode = "too-large";
    return { error: "too-large" };
  }
  const parts = [];
  let held = 0;
  try {
    const chunks = orderedChunks();
    for (let i = 0; i < chunks.length; i++) {
      const plain = await openChunk(chunks[i]);
      held += plain.byteLength;
      if (held > DOWNLOAD_CAP) {
        errorCode = "too-large";
        return { error: "too-large" };
      }
      parts.push(plain);
    }
  } catch (err) {
    return { error: errorCode || "key" };
  }
  let size = 0;
  parts.forEach(function (part) { size += part.byteLength; });
  const all = new Uint8Array(size);
  let at = 0;
  parts.forEach(function (part) { all.set(part, at); at += part.byteLength; });
  return { bytes: all };
}
function saveBlob(bytes, name, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name || "recording";
  link.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
function appendBuffer(sourceBuffer, bytes) {
  return new Promise(function (resolve, reject) {
    function done() {
      sourceBuffer.removeEventListener("updateend", done);
      sourceBuffer.removeEventListener("error", fail);
      resolve();
    }
    function fail() {
      sourceBuffer.removeEventListener("updateend", done);
      sourceBuffer.removeEventListener("error", fail);
      reject(new Error("append"));
    }
    sourceBuffer.addEventListener("updateend", done);
    sourceBuffer.addEventListener("error", fail);
    sourceBuffer.appendBuffer(bytes);
  });
}
function hold(kind, bytes) {
  slots[kind] = bytes;
  const kept = (slots.init ? 1 : 0) + (slots.media ? 1 : 0);
  if (kept > SEGMENT_SLOTS) slots.media = null;
  return bytes;
}
export async function playSegments() {
  const current = plan();
  if (current.mode !== "mse") {
    errorCode = current.reason === "codec" || current.mode === "unsupported" ? "codec" : current.reason;
    paint();
    return { error: errorCode || "codec" };
  }
  const video = document.getElementById("rec-video");
  if (!video) return { error: "catalog" };
  dropPlayer();
  const initChunk = manifest.chunks.filter(function (chunk) { return chunk.init; })[0];
  const mediaSource = new MediaSource();
  playerUrl = URL.createObjectURL(mediaSource);
  video.src = playerUrl;
  await new Promise(function (resolve, reject) {
    mediaSource.addEventListener("sourceopen", function () { resolve(); }, { once: true });
    mediaSource.addEventListener("error", function () { reject(new Error("source")); }, { once: true });
  });
  let sourceBuffer;
  try {
    sourceBuffer = mediaSource.addSourceBuffer(current.mime);
    const initPlain = await openChunk(initChunk);
    await appendBuffer(sourceBuffer, hold("init", initPlain));
    slots.init = null;
    await showSegment(sourceBuffer, 0);
    const duration = durationOf(manifest);
    if (duration > 0 && mediaSource.readyState === "open") mediaSource.duration = duration;
  } catch (err) {
    errorCode = errorCode || "codec";
    paint();
    return { error: errorCode };
  }
  video.onseeking = function () {
    showSegment(sourceBuffer, video.currentTime).catch(function () {
      errorCode = errorCode || "codec";
    });
  };
  try { await video.play(); } catch (err) { /* a gesture may still be required */ }
  return { ok: true };
}
async function showSegment(sourceBuffer, time) {
  const chunk = chunkForTime(manifest, time);
  if (!chunk || chunk.index === shownIndex) return;
  const plain = await openChunk(chunk);
  if (sourceBuffer.updating) {
    await new Promise(function (resolve) {
      sourceBuffer.addEventListener("updateend", function () { resolve(); }, { once: true });
    });
  }
  await appendBuffer(sourceBuffer, hold("media", plain));
  slots.media = null;
  shownIndex = chunk.index;
}
export async function playWholeFile() {
  const current = plan();
  if (!(current.mode === "file" || current.wholeFile)) return { error: "codec" };
  if ((manifest.bytes || 0) > MEMORY_CAP) {
    errorCode = "too-large";
    paint();
    return { error: "too-large" };
  }
  const opened = await decryptPackage();
  if (!opened.bytes) return opened;
  const video = document.getElementById("rec-video");
  if (!video) return { error: "catalog" };
  dropPlayer();
  playerUrl = URL.createObjectURL(new Blob([opened.bytes], { type: current.mime || "application/octet-stream" }));
  video.src = playerUrl;
  try { await video.play(); } catch (err) { /* autoplay can be blocked */ }
  return { ok: true, bytes: opened.bytes.byteLength };
}
function takeFiles(list) {
  sources = new Map();
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    const name = String(file.name || "").split("/").pop();
    if (name) sources.set(name, file);
  }
}
export async function openPackage(pkg) {
  errorCode = "";
  dropPlayer();
  const parsed = parseManifest(pkg && pkg.manifest ? pkg.manifest : pkg);
  if (!parsed.manifest) {
    manifest = null;
    errorCode = parsed.error || "catalog";
    paint();
    return parsed;
  }
  manifest = parsed.manifest;
  sources = new Map();
  const inline = filesFromInline(manifest);
  if (inline.error) {
    manifest = null;
    errorCode = inline.error;
    paint();
    return inline;
  }
  Object.keys(inline.files).forEach(function (name) { sources.set(name, inline.files[name]); });
  const extra = pkg && pkg.files || {};
  Object.keys(extra).forEach(function (name) {
    if (extra[name] instanceof Uint8Array) sources.set(name, extra[name]);
  });
  paint();
  return { manifest: { id: manifest.id, kind: manifest.kind } };
}

function onSubmit(event) {
  const form = event.target && event.target.closest ? event.target.closest("[data-rec-form]") : null;
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector("#rec-key");
  const value = input ? input.value : "";
  if (input) input.value = "";
  unlockRecordings(value);
  paint();
}
async function onCatalog(file) {
  const text = await file.text();
  await openPackage(text);
}
function onClick(event) {
  const el = event.target && event.target.closest ? event.target.closest("[data-rec]") : null;
  if (!el) return;
  const act = el.getAttribute("data-rec");
  if (act === "lock") {
    lockRecordings();
    paint();
    return;
  }
  if (act === "download") {
    decryptPackage().then(function (opened) {
      if (!opened.bytes) {
        paint();
        return;
      }
      saveBlob(opened.bytes, (manifest && manifest.title) || "recording", manifest && manifest.media && manifest.media.mime);
    });
    return;
  }
  if (act === "play") playSegments();
  if (act === "play-file") playWholeFile();
}
function onChange(event) {
  const input = event.target;
  if (!input) return;
  if (input.id === "rec-catalog" && input.files && input.files[0]) onCatalog(input.files[0]);
  if (input.id === "rec-folder" && input.files) takeFiles(input.files);
}

export function bindRecordings(root) {
  if (!root || root.dataset.recBound === "1") return;
  root.dataset.recBound = "1";
  root.addEventListener("submit", onSubmit);
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
}

window.ViktorychRecordings = {
  html: recordingsHtml,
  bind: bindRecordings,
  enabled: recordingsEnabled,
  unlock: unlockRecordings,
  lock: lockRecordings,
  held: function () { return identity.length > 0; },
  openPackage: openPackage,
  decryptPackage: decryptPackage,
  playSegments: playSegments,
  playWholeFile: playWholeFile,
  plan: plan,
  loadAge: loadAge,
  error: function () { return errorCode; },
  bytesToB64: bytesToB64,
  b64ToBytes: b64ToBytes
};
