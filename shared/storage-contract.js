/* vsr-playback-2. Version 1 byte-chunk catalogs are withdrawn.
   A playback manifest is accepted only after manifest.age has been
   decrypted. manifest.json is not a manifest. The codec string is not
   read from this JSON. */

export const PLAYBACK_FORMAT = "vsr-playback-2";
export const MEMORY_CAP = 8 * 1024 * 1024;
export const DOWNLOAD_CAP = 32 * 1024 * 1024;
export const SEGMENT_SLOTS = 2;
export const MAX_FRAGMENTS = 4096;
const SHA_RE = /^[a-f0-9]{64}$/;

export function looksLikeIdentity(value) {
  const text = String(value || "").replace(/\s+/g, "");
  return text.startsWith("AGE-SECRET-KEY-1") || text.startsWith("AGE-SECRET-KEY-PQ-1");
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

/* Plaintext JSON is never a playback package. Version 1 is withdrawn. */
export function parsePlainCatalog(value) {
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch (err) { return { error: "withdrawn" }; }
  }
  if (!data || typeof data !== "object") return { error: "withdrawn" };
  return { error: "withdrawn" };
}

export function parsePlaybackManifest(value, opts) {
  if (!opts || opts.authenticated !== true) return { error: "unauthenticated" };
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch (err) { return { error: "manifest" }; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "manifest" };
  if (data.v === 1 || data.kind === "age-byte-chunks" || data.kind === "age-file" || data.kind === "age-media-segments" || data.chunks) {
    return { error: "withdrawn" };
  }
  if (data.format !== PLAYBACK_FORMAT) return { error: "manifest" };
  if (data.requires_init !== true || data.independently_playable !== false) return { error: "manifest" };
  const init = String(data.init || "").toLowerCase();
  if (!SHA_RE.test(init)) return { error: "manifest" };
  if (!Array.isArray(data.fragments) || data.fragments.length < 1 || data.fragments.length > MAX_FRAGMENTS) return { error: "manifest" };
  const fragments = [];
  const seen = new Set();
  for (let i = 0; i < data.fragments.length; i++) {
    const raw = data.fragments[i];
    if (!raw || typeof raw !== "object") return { error: "manifest" };
    const sha = String(raw.sha256 || "").toLowerCase();
    if (!SHA_RE.test(sha) || sha === init || seen.has(sha)) return { error: "manifest" };
    const start = Number(raw.start);
    const duration = Number(raw.duration);
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0) return { error: "manifest" };
    seen.add(sha);
    fragments.push({ sha256: sha, start: start, duration: duration, index: i });
  }
  return {
    manifest: {
      format: PLAYBACK_FORMAT,
      requires_init: true,
      independently_playable: false,
      init: init,
      fragments: fragments,
      title: cleanText(data.title, 180),
      legacy: false,
      likely: false,
      mime: ""
    }
  };
}

export function fragmentForTime(manifest, time) {
  const rows = manifest && manifest.fragments || [];
  if (!rows.length) return null;
  const at = Number(time) || 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (at >= row.start && at < row.start + row.duration) return row;
  }
  return rows[rows.length - 1];
}

export function durationOf(manifest) {
  let end = 0;
  (manifest && manifest.fragments || []).forEach(function (row) {
    end = Math.max(end, row.start + row.duration);
  });
  return end;
}

export function playbackPlan(manifest, isTypeSupported) {
  if (!manifest) return { mode: "none", playable: false, reason: "none", mime: "" };
  if (manifest.legacy) return { mode: "legacy", playable: false, reason: "whole-file", mime: "" };
  if (manifest.format !== PLAYBACK_FORMAT || manifest.requires_init !== true || manifest.independently_playable !== false) {
    return { mode: "unsupported", playable: false, reason: "manifest", mime: "" };
  }
  const mime = manifest.mime || "";
  if (!manifest.likely || !mime) return { mode: "unsupported", playable: false, reason: "codec", mime: mime };
  let supported = false;
  try { supported = typeof isTypeSupported === "function" && !!isTypeSupported(mime); } catch (err) { supported = false; }
  if (!supported) return { mode: "unsupported", playable: false, reason: "codec", mime: mime };
  return { mode: "mse", playable: true, reason: "fragments", mime: mime, slots: SEGMENT_SLOTS };
}
