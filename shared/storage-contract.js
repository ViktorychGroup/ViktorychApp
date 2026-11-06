/* vsr-playback-2. Version 1 byte-chunk catalogs are withdrawn.
   A playback manifest is accepted only after manifest.age has been
   decrypted. manifest.json is not a manifest. The codec string is not
   read from this JSON. */

export const PLAYBACK_FORMAT = "vsr-playback-2";
export const MEMORY_CAP = 8 * 1024 * 1024;
export const DOWNLOAD_CAP = 32 * 1024 * 1024;
export const SEGMENT_SLOTS = 2;
export const MAX_FRAGMENTS = 4096;
/* Public age recipient only. The matching identity is typed in the tab and
   is not stored or sent. */
export const BACKUP_RECIPIENT = "age13y4w4mthz0ezlkm5a3jlh2f3xka7374ykdr566dqtlu8dz74eqqq7wx8gy";
const SHA_RE = /^[a-f0-9]{64}$/;
const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{40,90}$/;

export function looksLikeIdentity(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return text.startsWith("AGE-SECRET-KEY-1") || text.startsWith("AGE-SECRET-KEY-PQ-1");
}

export function looksLikeRecipient(value) {
  return RECIPIENT_RE.test(String(value || "").trim());
}

/* What this page can honestly say. A live recorder catalog is not loaded.
   telegram_getfile on a local package is not a download. */
export function storageReadiness(opts) {
  const recipient = String((opts && opts.recipient) || BACKUP_RECIPIENT).trim();
  const recipientReady = looksLikeRecipient(recipient);
  return {
    recipient: { state: recipientReady ? "ready" : "needed", value: recipientReady ? recipient : "" },
    identity: { state: opts && opts.identityHeld ? "ready" : "needed" },
    recorder: { state: "unlinked" },
    catalog: { state: "local", telegramGetFile: !!(opts && opts.telegramGetFile) },
    provider: { state: "absent" }
  };
}

export function shaName(sha) {
  return String(sha || "").toLowerCase() + ".age";
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

const OBJECT_RE = /^(?:manifest|[a-f0-9]{64})\.age$/;

function sealedRow(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.object_name || "");
  const sha = String(raw.sha256 || "").toLowerCase();
  if (!OBJECT_RE.test(name) || !SHA_RE.test(sha)) return null;
  if (name !== "manifest.age" && name !== sha + ".age") return null;
  if (String(raw.object_key || "") !== "vsr/" + name) return null;
  if (raw.kind !== "age" || raw.encrypted !== 1 || raw.serve !== 1 || raw.mime !== "application/octet-stream") return null;
  const size = Number(raw.size);
  if (!Number.isInteger(size) || size <= 0) return null;
  if (typeof raw.uploaded !== "boolean" || typeof raw.file_id !== "string") return null;
  if (raw.uploaded !== (raw.file_id.length > 0)) return null;
  const role = String(raw.role || "");
  const part = Number(raw.part_index);
  if (role === "manifest" && (name !== "manifest.age" || part !== 0)) return null;
  if (role === "init" && part !== -1) return null;
  if (role === "media" && (!Number.isInteger(part) || part < 0)) return null;
  if (role !== "manifest" && role !== "init" && role !== "media") return null;
  return { objectName: name, objectKey: "vsr/" + name, sha256: sha, size, role, partIndex: part, uploaded: raw.uploaded };
}

/* Owner catalog after catalog.age decrypts in the tab. file_id is not kept. */
export function parseSealedCatalog(value, opts) {
  if (!opts || opts.authenticated !== true) return { error: "unauthenticated" };
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch (err) { return { error: "catalog" }; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "catalog" };
  if (data.kind !== "vsr-sealed-export" || data.sealed !== "catalog" || data.version !== 1) return { error: "catalog" };
  if (data.playback_format !== PLAYBACK_FORMAT) return { error: "catalog" };
  const retrieval = data.retrieval;
  if (!retrieval || retrieval.worker_route !== "/tg/vsr/{object_name}" || retrieval.auth !== "signed-in owner session" || retrieval.token_in_browser !== false) return { error: "catalog" };
  if (retrieval.age_kind !== "age" || retrieval.age_encrypted !== 1 || retrieval.cleartext_filter !== "encrypted = 0" || retrieval.table !== "telegram_files") return { error: "catalog" };
  if (retrieval.worker_secret_name !== "TELEGRAM_BOT_TOKEN" || retrieval.destination_secret_name !== "TELEGRAM_CHANNEL_ID") return { error: "catalog" };
  if (!Array.isArray(data.packages) || data.packages.length < 1 || data.packages.length > 32) return { error: "catalog" };
  const packages = [];
  for (let i = 0; i < data.packages.length; i++) {
    const item = data.packages[i];
    if (!item || item.playback_format !== PLAYBACK_FORMAT || item.manifest !== "manifest.age") return { error: "catalog" };
    if (!Array.isArray(item.objects) || !Array.isArray(item.rows) || item.objects.length !== item.rows.length) return { error: "catalog" };
    const rows = [];
    const names = {};
    for (let n = 0; n < item.rows.length; n++) {
      const row = sealedRow(item.rows[n]);
      if (!row || names[row.objectName]) return { error: "catalog" };
      names[row.objectName] = true;
      rows.push(row);
    }
    for (let n = 0; n < item.objects.length; n++) {
      if (!names[String(item.objects[n] || "")]) return { error: "catalog" };
    }
    if (!names["manifest.age"]) return { error: "catalog" };
    packages.push({ name: cleanText(item.package, 180), manifest: "manifest.age", rows });
  }
  return { catalog: { packages } };
}

/* Plaintext JSON is never a playback package. Version 1 is withdrawn. */
export function parsePlainCatalog(value) {
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch (err) { return { error: "withdrawn" }; }
  }
  if (!data || typeof data !== "object") return { error: "withdrawn" };
  return { error: "withdrawn" };
}

function shaOk(value) {
  return SHA_RE.test(String(value || "").toLowerCase());
}

function telegramFlag(raw) {
  if (!raw || typeof raw !== "object" || !Object.prototype.hasOwnProperty.call(raw, "telegram_getfile")) return false;
  if (raw.telegram_getfile === true) return true;
  if (raw.telegram_getfile === false) return false;
  return null;
}

function objectPart(raw, role) {
  if (!raw || typeof raw !== "object" || raw.role !== role) return null;
  const sha = String(raw.ciphertext_sha256 || "").toLowerCase();
  const name = String(raw.object_name || "");
  if (!shaOk(sha) || name !== sha + ".age") return null;
  const cipherBytes = Number(raw.ciphertext_bytes);
  const plainBytes = Number(raw.plaintext_bytes);
  if (!Number.isInteger(cipherBytes) || cipherBytes < 0 || !Number.isInteger(plainBytes) || plainBytes < 0) return null;
  return { sha256: sha, objectName: name, ciphertextBytes: cipherBytes, plaintextBytes: plainBytes };
}

/* Accepts only the decrypted vsr-playback-2 document. codecs_parameter is ignored. */
export function parsePlaybackManifest(value, opts) {
  if (!opts || opts.authenticated !== true) return { error: "unauthenticated" };
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch (err) { return { error: "manifest" }; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "manifest" };
  if (data.v === 1 || data.kind === "age-byte-chunks" || data.kind === "age-file" || data.kind === "age-media-segments" || data.format === "vsr-playback-1") {
    return { error: "withdrawn" };
  }
  if (data.format !== PLAYBACK_FORMAT) return { error: "manifest" };
  if (data.encryption !== "age-chunk-v1" || data.container !== "fmp4" || data.segment_model !== "init-plus-media") return { error: "manifest" };
  if (data.authenticated_by !== "age" || data.age_byte_range !== false || data.backup !== "whole_file_age_unchanged") return { error: "manifest" };
  const cap = data.capability;
  if (!cap || cap.media_independently_playable !== false || cap.lossy_transcode !== false || cap.age_byte_range !== false || cap.mime !== "video/mp4") {
    return { error: "manifest" };
  }
  const init = objectPart(data.init, "init");
  const initTelegram = telegramFlag(data.init);
  if (!init || initTelegram === null) return { error: "manifest" };
  if (!Array.isArray(data.chunks) || data.chunks.length < 1 || data.chunks.length > MAX_FRAGMENTS) return { error: "manifest" };
  const chunks = [];
  let cursor = 0;
  for (let i = 0; i < data.chunks.length; i++) {
    const raw = data.chunks[i];
    const part = objectPart(raw, "media");
    const named = telegramFlag(raw);
    if (!part || named === null || raw.independently_playable !== false || raw.requires_init !== true) return { error: "manifest" };
    if (raw.index !== i) return { error: "manifest" };
    const duration = Number(raw.duration_ms);
    if (!Number.isInteger(duration) || duration <= 0) return { error: "manifest" };
    chunks.push({
      index: i,
      sha256: part.sha256,
      objectName: part.objectName,
      ciphertextBytes: part.ciphertextBytes,
      plaintextBytes: part.plaintextBytes,
      durationMs: duration,
      startMs: cursor,
      requiresInit: true,
      independentlyPlayable: false,
      telegramGetFile: named === true
    });
    cursor += duration;
  }
  const marked = cap.browser_mse_likely === true && data.vcodec === "h264" && data.acodec === "aac";
  return {
    manifest: {
      format: PLAYBACK_FORMAT,
      vcodec: data.vcodec,
      acodec: data.acodec,
      containerMime: "video/mp4",
      markedLikely: marked,
      init: init,
      chunks: chunks,
      durationMs: cursor,
      title: cleanText(data.title, 180),
      telegramGetFile: initTelegram === true || chunks.some((row) => row.telegramGetFile),
      legacy: false,
      likely: false,
      mime: ""
    }
  };
}

export function fragmentForTime(manifest, timeSeconds) {
  const rows = manifest && manifest.chunks || [];
  if (!rows.length) return null;
  const at = Math.round((Number(timeSeconds) || 0) * 1000);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (at >= row.startMs && at < row.startMs + row.durationMs) return row;
  }
  return rows[rows.length - 1];
}

export function durationOf(manifest) {
  return ((manifest && manifest.durationMs) || 0) / 1000;
}

export function playbackPlan(manifest, isTypeSupported) {
  if (!manifest) return { mode: "none", playable: false, reason: "none", mime: "" };
  if (manifest.legacy) return { mode: "legacy", playable: false, reason: "whole-file", mime: "" };
  if (manifest.format !== PLAYBACK_FORMAT) return { mode: "unsupported", playable: false, reason: "manifest", mime: "" };
  const mime = manifest.mime || "";
  if (!manifest.markedLikely || !manifest.likely || !mime) return { mode: "unsupported", playable: false, reason: "codec", mime: mime };
  let supported = false;
  try { supported = typeof isTypeSupported === "function" && !!isTypeSupported(mime); } catch (err) { supported = false; }
  if (!supported) return { mode: "unsupported", playable: false, reason: "codec", mime: mime };
  return { mode: "mse", playable: true, reason: "fragments", mime: mime, slots: SEGMENT_SLOTS };
}
