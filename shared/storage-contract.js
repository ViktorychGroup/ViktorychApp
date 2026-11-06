/* Contract viktorych.storage.recordings/1.
   The recorder repository was not readable from this app change, so this
   file is the format the page implements. Byte-chunk packages are not
   treated as playable media segments. No transcoding. */

export const CONTRACT = "viktorych.storage.recordings/1";
export const MEMORY_CAP = 8 * 1024 * 1024;
export const DOWNLOAD_CAP = 32 * 1024 * 1024;
export const SEGMENT_SLOTS = 2;
export const MAX_CHUNKS = 4096;

const KINDS = { "age-file": 1, "age-byte-chunks": 1, "age-media-segments": 1 };
const CONTAINERS = { fmp4: 1, mpegts: 1, webm: 1, file: 1 };
const RECORDER_STATES = { idle: 1, recording: 1, stopped: 1, unknown: 1 };
const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9-]{1,64}$/;

export function looksLikeIdentity(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return text.startsWith("AGE-SECRET-KEY-1") || text.startsWith("AGE-SECRET-KEY-PQ-1");
}

export function providerRows(deviceMode) {
  const device = deviceMode === "ready" ? "ready" : (deviceMode === "locked" || deviceMode === "setup" ? "locked" : "unavailable");
  return [
    { id: "device", state: device, connect: false },
    { id: "recordings", state: "local", connect: false },
    { id: "telegram", state: "unavailable", connect: false },
    { id: "gdrive", state: "unavailable", connect: false },
    { id: "onedrive", state: "unavailable", connect: false },
    { id: "cryptomator", state: "unavailable", connect: false }
  ];
}

export function recorderStatus(manifest) {
  const row = manifest && manifest.recorder;
  if (!row || !RECORDER_STATES[row.state]) return { state: "unlinked", detail: "" };
  return { state: row.state, detail: cleanText(row.detail, 180) };
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function chunkOf(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name || "");
  if (!NAME_RE.test(name)) return null;
  const sha = String(raw.sha256 || "").toLowerCase();
  if (!SHA_RE.test(sha)) return null;
  const plainBytes = Number(raw.plainBytes);
  if (!Number.isInteger(plainBytes) || plainBytes < 0 || plainBytes > DOWNLOAD_CAP) return null;
  const at = Number.isInteger(raw.index) ? raw.index : index;
  if (at < 0 || at > MAX_CHUNKS) return null;
  const chunk = { name: name, sha256: sha, plainBytes: plainBytes, index: at, init: raw.init === true };
  if (raw.start != null || raw.duration != null) {
    const start = Number(raw.start);
    const duration = Number(raw.duration);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) return null;
    chunk.start = start;
    chunk.duration = duration;
  }
  if (raw.inline != null) {
    if (typeof raw.inline !== "string" || raw.inline.length > (MEMORY_CAP + 4096) * 2) return null;
    chunk.inline = raw.inline;
  }
  return chunk;
}

export function parseManifest(value) {
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch (err) { return { error: "catalog" }; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "catalog" };
  if (data.v !== 1 || !KINDS[data.kind]) return { error: "kind" };
  if (data.contract && data.contract !== CONTRACT) return { error: "catalog" };
  const id = String(data.id || "");
  if (!ID_RE.test(id)) return { error: "catalog" };
  const title = cleanText(data.title, 180);
  if (!title) return { error: "catalog" };
  const bytes = Number(data.bytes);
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > DOWNLOAD_CAP) return { error: "catalog" };
  if (!Array.isArray(data.chunks) || data.chunks.length < 1 || data.chunks.length > MAX_CHUNKS) return { error: "chunk" };
  const chunks = [];
  for (let i = 0; i < data.chunks.length; i++) {
    const chunk = chunkOf(data.chunks[i], i);
    if (!chunk) return { error: "chunk" };
    chunks.push(chunk);
  }
  const media = data.media && typeof data.media === "object" ? {
    container: CONTAINERS[data.media.container] ? data.media.container : "",
    mime: cleanText(data.media.mime, 160),
    duration: Number(data.media.duration) > 0 ? Number(data.media.duration) : 0
  } : { container: "", mime: "", duration: 0 };
  const manifest = {
    v: 1,
    contract: CONTRACT,
    kind: data.kind,
    id: id,
    title: title,
    bytes: bytes,
    chunks: chunks,
    media: media,
    recorder: recorderStatus(data)
  };
  if (data.sha256) {
    const whole = String(data.sha256).toLowerCase();
    if (!SHA_RE.test(whole)) return { error: "catalog" };
    manifest.sha256 = whole;
  }
  return { manifest: manifest };
}

function timed(chunks) {
  return chunks.length > 0 && chunks.every((chunk) => typeof chunk.start === "number" && typeof chunk.duration === "number");
}

export function playbackPlan(manifest, isTypeSupported) {
  if (!manifest) return { mode: "none", playable: false, reason: "none" };
  const bytes = Number(manifest.bytes) || 0;
  const mime = (manifest.media && manifest.media.mime) || "";
  if (manifest.kind === "age-byte-chunks") {
    return {
      mode: bytes > DOWNLOAD_CAP ? "too-large" : "download",
      playable: false,
      reason: "byte-chunks",
      mime: mime,
      wholeFile: bytes > 0 && bytes <= MEMORY_CAP && !!mime
    };
  }
  if (manifest.kind === "age-file") {
    if (bytes > DOWNLOAD_CAP) return { mode: "too-large", playable: false, reason: "memory", mime: mime };
    if (bytes > MEMORY_CAP) return { mode: "download", playable: false, reason: "memory", mime: mime };
    return { mode: "file", playable: !!mime, reason: "legacy-file", mime: mime };
  }
  if (manifest.kind !== "age-media-segments") return { mode: "unsupported", playable: false, reason: "kind", mime: mime };
  const container = manifest.media && manifest.media.container;
  const chunks = manifest.chunks || [];
  const init = chunks.filter((chunk) => chunk.init);
  const media = chunks.filter((chunk) => !chunk.init);
  if (container !== "fmp4" && container !== "mpegts" && container !== "webm") {
    return { mode: "unsupported", playable: false, reason: "container", mime: mime };
  }
  if (init.length !== 1 || !media.length || !timed(media)) {
    return { mode: "download", playable: false, reason: "byte-chunks", mime: mime };
  }
  if (media.some((chunk) => chunk.plainBytes > MEMORY_CAP) || init[0].plainBytes > MEMORY_CAP) {
    return { mode: "unsupported", playable: false, reason: "segment-size", mime: mime };
  }
  const supported = !!(mime && typeof isTypeSupported === "function" && isTypeSupported(mime));
  if (!supported) return { mode: "unsupported", playable: false, reason: "codec", mime: mime };
  return { mode: "mse", playable: true, reason: "segments", mime: mime, slots: SEGMENT_SLOTS };
}

export function chunkForTime(manifest, time) {
  const media = (manifest && manifest.chunks || []).filter((chunk) => !chunk.init);
  if (!media.length) return null;
  const at = Number(time) || 0;
  for (let i = 0; i < media.length; i++) {
    const chunk = media[i];
    if (typeof chunk.start !== "number") continue;
    if (at >= chunk.start && at < chunk.start + chunk.duration) return chunk;
  }
  return media[media.length - 1];
}

export function durationOf(manifest) {
  let end = Number(manifest && manifest.media && manifest.media.duration) || 0;
  (manifest && manifest.chunks || []).forEach((chunk) => {
    if (chunk.init || typeof chunk.start !== "number") return;
    end = Math.max(end, chunk.start + chunk.duration);
  });
  return end;
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

export function bytesToB64(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}

export function b64ToBytes(text) {
  const bin = atob(String(text || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function filesFromInline(manifest) {
  const files = {};
  const chunks = manifest && manifest.chunks || [];
  for (let i = 0; i < chunks.length; i++) {
    if (!chunks[i].inline) continue;
    let bytes;
    try { bytes = b64ToBytes(chunks[i].inline); } catch (err) { return { error: "chunk" }; }
    if (bytes.byteLength > MEMORY_CAP + 4096) return { error: "too-large" };
    files[chunks[i].name] = bytes;
  }
  return { files: files };
}
