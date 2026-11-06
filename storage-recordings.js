/* Recordings on the Storage page. The age identity lives in this module
   for the tab and is never written, sent, or logged. Playback is vsr-playback-2
   only: decrypt manifest.age, then the init segment and the fragment for
   the current time. A whole age file is a download. manifest.json is ignored. */
import {
  BACKUP_RECIPIENT,
  DOWNLOAD_CAP,
  MEMORY_CAP,
  SEGMENT_SLOTS,
  durationOf,
  fragmentForTime,
  looksLikeIdentity,
  parsePlainCatalog,
  parsePlaybackManifest,
  playbackPlan,
  sha256Hex,
  storageReadiness
} from "./shared/storage-contract.js";
import { decryptBytes } from "./shared/storage-age.js";
import { classifyMp4, likelyMime } from "./shared/storage-mp4.js";

const AGE_SRC = "vendor/age-0.3.1.min.js";
const OFF_KEY = "viktorychapp-server-off";

let identity = "";
let manifest = null;
let sources = new Map();
let legacyCipher = null;
let legacyName = "recording.age";
let errorCode = "";
let playerUrl = "";
let agePromise = null;
let shownIndex = -1;
const slots = { init: null, media: null };

function tr(key) {
  return window.t ? window.t(key) : key;
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
  const supported = function (mime) {
    try { return !!(window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported(mime)); }
    catch (err) { return false; }
  };
  return playbackPlan(manifest, supported);
}
function errorText() {
  if (errorCode === "key") return tr("That key did not decrypt this recording.");
  if (errorCode === "tamper") return tr("The file was changed. It was not decrypted.");
  if (errorCode === "locked") return tr("Recordings are locked.");
  if (errorCode === "identity") return tr("Use an age identity. It starts with AGE-SECRET-KEY-1.");
  if (errorCode === "too-large") return tr("This recording is too large to decrypt in this tab.");
  if (errorCode === "missing") return tr("Chunk files are missing from the folder you chose.");
  if (errorCode === "withdrawn" || errorCode === "unauthenticated") return tr("This catalog cannot be played.");
  if (errorCode === "boxes") return tr("The pieces in this package cannot be played.");
  if (errorCode === "codec") return tr("This format cannot play in this browser. Nothing is re-encoded.");
  if (errorCode === "manifest" || errorCode === "catalog") return tr("Could not read that catalog.");
  return "";
}
function noteText() {
  if (manifest && manifest.legacy) return tr("This age file can only be downloaded.");
  const current = plan();
  if (current.mode === "mse") return tr("Playback uses the init segment and one fragment.");
  if (current.mode === "unsupported" && current.reason === "codec") return tr("This format cannot play in this browser. Nothing is re-encoded.");
  if (current.mode === "unsupported") return tr("The pieces in this package cannot be played.");
  return "";
}

function readyRow(name, state, label, value) {
  return '<div class="rec-row" data-ready="' + esc(name) + '" data-ready-state="' + esc(state) + '"><b>' + esc(label) + '</b><span>' + esc(value) + "</span></div>";
}
export function recordingsHtml() {
  if (!recordingsEnabled()) return "";
  const current = plan();
  const locked = !identity;
  const ready = storageReadiness({
    recipient: BACKUP_RECIPIENT,
    identityHeld: !locked,
    telegramGetFile: !!(manifest && manifest.telegramGetFile)
  });
  const title = manifest ? (manifest.title || tr("Recording")) : "";
  const kind = manifest ? (manifest.legacy ? "legacy" : manifest.format) : "";
  const actions = [];
  if (manifest && manifest.legacy && !locked) {
    actions.push('<button class="outline" type="button" data-act="stop" data-rec="download-legacy">' + esc(tr("Download and decrypt")) + "</button>");
  }
  if (manifest && !manifest.legacy && !locked && current.mode === "mse") {
    actions.push('<button class="save" type="button" data-act="stop" data-rec="play">' + esc(tr("Play")) + "</button>");
  }
  const form = locked
    ? '<form data-rec-form="unlock"><label class="field"><span>' + esc(tr("Recording key")) + '</span><input id="rec-key" type="password" autocomplete="off" spellcheck="false"></label><p class="rec-note">' + esc(tr("The key stays in this tab. It is not saved or sent.")) + '</p><button class="save" type="submit">' + esc(tr("Unlock recordings")) + "</button></form>"
    : '<button class="outline" type="button" data-act="stop" data-rec="lock">' + esc(tr("Lock recordings")) + "</button>";
  const item = title
    ? '<article class="rec-item" data-rec-kind="' + esc(kind) + '"><h3>' + esc(title) + '</h3><p class="rec-note">' + esc(noteText()) + "</p>" + (actions.length ? '<div class="rec-actions">' + actions.join("") + "</div>" : "") + (!manifest.legacy && current.mode === "mse" ? '<video id="rec-video" class="rec-video" controls playsinline muted></video>' : "") + "</article>"
    : "";
  const telegramNote = ready.catalog.telegramGetFile
    ? '<p class="rec-note" data-telegram-getfile="named">' + esc(tr("This package names Telegram getFile. This page does not download it.")) + "</p>"
    : "";
  return '<section class="rec-block" id="rec-root" data-recorder="unlinked" data-telegram-getfile="' + (ready.catalog.telegramGetFile ? "named" : "no") + '">' +
    '<h2>' + esc(tr("Recordings")) + "</h2>" +
    '<p class="rec-note">' + esc(tr("No recorder is linked. Recordings open from a catalog on this device. Nothing is uploaded.")) + "</p>" +
    readyRow("recipient", ready.recipient.state, tr("Backup recipient"), tr("Ready")) +
    '<p class="rec-recipient" data-backup-recipient="' + esc(ready.recipient.value) + '">' + esc(ready.recipient.value) + "</p>" +
    readyRow("identity", ready.identity.state, tr("Recording key"), ready.identity.state === "ready" ? tr("In this tab") : tr("Needed")) +
    '<div class="rec-row" data-recorder-status="unlinked" data-ready="recorder" data-ready-state="unlinked"><b>' + esc(tr("Recorder")) + '</b><span>' + esc(tr("Not linked")) + "</span></div>" +
    readyRow("catalog", ready.catalog.state, tr("Catalog"), tr("On this device")) +
    readyRow("provider", ready.provider.state, tr("Provider"), tr("Not connected")) +
    form +
    '<div class="rec-actions"><label class="outline">' + esc(tr("Choose the folder of chunk files")) + '<input id="rec-folder" type="file" webkitdirectory multiple hidden></label>' +
    '<label class="outline">' + esc(tr("Open an age file")) + '<input id="rec-legacy" type="file" accept=".age,application/octet-stream" hidden></label></div>' +
    (errorCode ? '<p class="rec-error" data-rec-error="' + esc(errorCode) + '">' + esc(errorText()) + "</p>" : "") +
    item +
    telegramNote +
    '<p class="rec-note">' + esc(tr("No provider is connected from this page.")) + "</p>" +
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
  legacyCipher = null;
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
async function decryptPart(part) {
  if (!identity) {
    errorCode = "locked";
    throw new Error("locked");
  }
  const bytes = await readNamed(part.objectName);
  if (bytes.byteLength !== part.ciphertextBytes || bytes.byteLength > MEMORY_CAP + 65536) {
    errorCode = bytes.byteLength > MEMORY_CAP + 65536 ? "too-large" : "tamper";
    throw new Error(errorCode);
  }
  const hash = await sha256Hex(bytes);
  if (hash !== part.sha256) {
    errorCode = "tamper";
    throw new Error("tamper");
  }
  const plain = await decryptCipher(bytes);
  if (plain.byteLength !== part.plaintextBytes || plain.byteLength > MEMORY_CAP) {
    errorCode = plain.byteLength > MEMORY_CAP ? "too-large" : "tamper";
    throw new Error(errorCode);
  }
  return plain;
}
function rememberFiles(list) {
  sources = new Map();
  const rows = list || [];
  for (let i = 0; i < rows.length; i++) {
    const file = rows[i];
    const name = String(file.name || "").split("/").pop();
    if (!name || name === "manifest.json") continue;
    const hash = name.match(/^([a-fA-F0-9]{64})\.age$/);
    sources.set(hash ? hash[1].toLowerCase() + ".age" : name, file);
  }
}
async function decryptCipher(bytes) {
  if (!identity) {
    errorCode = "locked";
    throw new Error("locked");
  }
  if (bytes.byteLength > DOWNLOAD_CAP) {
    errorCode = "too-large";
    throw new Error("too-large");
  }
  try {
    const age = await loadAge();
    const plain = await decryptBytes(age, identity, bytes);
    if (plain.byteLength > DOWNLOAD_CAP) {
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

export async function openPackage(pkg) {
  errorCode = "";
  dropPlayer();
  legacyCipher = null;
  manifest = null;
  if (!(pkg && pkg.keep)) {
    const files = pkg && pkg.files || {};
    sources = new Map();
    Object.keys(files).forEach(function (name) {
      if (name === "manifest.json") return;
      const base = String(name).split("/").pop();
      const hash = base && base.match(/^([a-fA-F0-9]{64})\.age$/);
      const key = hash ? hash[1].toLowerCase() + ".age" : base;
      if (files[name] instanceof Uint8Array && key) sources.set(key, files[name]);
    });
  }
  if (!sources.has("manifest.age")) {
    errorCode = sources.size ? "missing" : "withdrawn";
    if (pkg && pkg.plainCatalog) errorCode = parsePlainCatalog(pkg.plainCatalog).error;
    paint();
    return { error: errorCode };
  }
  let text = "";
  try {
    const plain = await decryptCipher(await readNamed("manifest.age"));
    text = new TextDecoder().decode(plain);
  } catch (err) {
    paint();
    return { error: errorCode || "key" };
  }
  const parsed = parsePlaybackManifest(text, { authenticated: true });
  if (!parsed.manifest) {
    errorCode = parsed.error || "manifest";
    paint();
    return parsed;
  }
  manifest = parsed.manifest;
  try {
    const parts = [manifest.init].concat(manifest.chunks);
    for (let i = 0; i < parts.length; i++) {
      const bytes = await readNamed(parts[i].objectName);
      if (bytes.byteLength !== parts[i].ciphertextBytes) {
        manifest = null;
        errorCode = "tamper";
        paint();
        return { error: "tamper" };
      }
      const hash = await sha256Hex(bytes);
      if (hash !== parts[i].sha256) {
        manifest = null;
        errorCode = "tamper";
        paint();
        return { error: "tamper" };
      }
    }
    const initPlain = await decryptPart(manifest.init);
    if (classifyMp4(initPlain) !== "init") {
      manifest = null;
      errorCode = "boxes";
      paint();
      return { error: "boxes" };
    }
    const mime = likelyMime(initPlain);
    const derivedOk = manifest.vcodec === "h264" && manifest.acodec === "aac" && !!mime && mime.indexOf("avc1.") > 0 && mime.indexOf("mp4a.40.2") > 0;
    manifest.mime = derivedOk ? mime : "";
    manifest.likely = manifest.markedLikely && derivedOk;
    slots.init = null;
  } catch (err) {
    manifest = null;
    paint();
    return { error: errorCode || "key" };
  }
  paint();
  return { manifest: { format: manifest.format, mime: manifest.mime, likely: manifest.likely, telegramGetFile: manifest.telegramGetFile === true } };
}

export async function openLegacy(bytes, name) {
  errorCode = "";
  dropPlayer();
  manifest = null;
  legacyCipher = bytes instanceof Uint8Array ? bytes : null;
  legacyName = name || "recording.age";
  if (!legacyCipher) {
    errorCode = "catalog";
    paint();
    return { error: "catalog" };
  }
  manifest = { legacy: true, title: legacyName.replace(/\.age$/i, "") || tr("Recording") };
  paint();
  return { legacy: true };
}

export async function decryptLegacy() {
  if (!manifest || !manifest.legacy || !legacyCipher) return { error: "catalog" };
  try {
    const plain = await decryptCipher(legacyCipher);
    return { bytes: plain };
  } catch (err) {
    return { error: errorCode || "key" };
  }
}

function saveBlob(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
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
async function clearBuffer(sourceBuffer) {
  if (!sourceBuffer.buffered || !sourceBuffer.buffered.length) return;
  if (sourceBuffer.updating) {
    await new Promise(function (resolve) {
      sourceBuffer.addEventListener("updateend", function () { resolve(); }, { once: true });
    });
  }
  await new Promise(function (resolve, reject) {
    function done() {
      sourceBuffer.removeEventListener("updateend", done);
      resolve();
    }
    sourceBuffer.addEventListener("updateend", done);
    try { sourceBuffer.remove(0, 1e9); } catch (err) { sourceBuffer.removeEventListener("updateend", done); reject(err); }
  });
}
async function showAt(sourceBuffer, time) {
  const fragment = fragmentForTime(manifest, time);
  if (!fragment) {
    errorCode = "boxes";
    throw new Error("boxes");
  }
  if (fragment.index === shownIndex) return;
  const initPlain = await decryptPart(manifest.init);
  const mediaPlain = await decryptPart(fragment);
  if (classifyMp4(initPlain) !== "init" || classifyMp4(mediaPlain) !== "fragment") {
    errorCode = "boxes";
    throw new Error("boxes");
  }
  if (slots.init || slots.media) {
    slots.init = null;
    slots.media = null;
  }
  if (shownIndex >= 0) await clearBuffer(sourceBuffer);
  slots.init = initPlain;
  slots.media = mediaPlain;
  if ((slots.init ? 1 : 0) + (slots.media ? 1 : 0) > SEGMENT_SLOTS) slots.media = null;
  await appendBuffer(sourceBuffer, initPlain);
  await appendBuffer(sourceBuffer, mediaPlain);
  slots.init = null;
  slots.media = null;
  shownIndex = fragment.index;
}
export async function playSegments() {
  const current = plan();
  if (current.mode !== "mse") {
    errorCode = current.reason === "codec" ? "codec" : (current.reason || "boxes");
    paint();
    return { error: errorCode };
  }
  const video = document.getElementById("rec-video");
  if (!video) return { error: "catalog" };
  dropPlayer();
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
    await showAt(sourceBuffer, 0);
    const duration = durationOf(manifest);
    if (duration > 0 && mediaSource.readyState === "open") mediaSource.duration = duration;
  } catch (err) {
    errorCode = errorCode || "codec";
    paint();
    return { error: errorCode };
  }
  video.onseeking = function () {
    showAt(sourceBuffer, video.currentTime).catch(function () {
      errorCode = errorCode || "codec";
    });
  };
  try { await video.play(); } catch (err) { /* a gesture may still be required */ }
  return { ok: true, mime: current.mime };
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
function onClick(event) {
  const el = event.target && event.target.closest ? event.target.closest("[data-rec]") : null;
  if (!el) return;
  const act = el.getAttribute("data-rec");
  if (act === "lock") {
    lockRecordings();
    paint();
    return;
  }
  if (act === "play") playSegments();
  if (act === "download-legacy") {
    decryptLegacy().then(function (opened) {
      if (!opened.bytes) {
        paint();
        return;
      }
      saveBlob(opened.bytes, legacyName.replace(/\.age$/i, "") || "recording");
    });
  }
}
async function onLegacy(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await openLegacy(bytes, file.name);
}
function onChange(event) {
  const input = event.target;
  if (!input) return;
  if (input.id === "rec-folder" && input.files) {
    rememberFiles(input.files);
    openPackage({ keep: true });
  }
  if (input.id === "rec-legacy" && input.files && input.files[0]) onLegacy(input.files[0]);
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
  openLegacy: openLegacy,
  decryptLegacy: decryptLegacy,
  playSegments: playSegments,
  plan: plan,
  loadAge: loadAge,
  error: function () { return errorCode; },
  fragmentIndex: function () { return shownIndex; },
  rememberFiles: rememberFiles
};
