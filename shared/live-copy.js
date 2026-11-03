/* Lossless copy of a live stream. Segments are kept as-is and joined.
   Nothing here re-encodes. */

const RANK = { origin: 100, origion: 100, uhd: 90, full_hd1: 80, hd: 70, hd1: 70, sd: 40, sd1: 40, sd2: 35, ld: 10 };

function rankOf(name) {
  const key = String(name || "").toLowerCase();
  return Object.prototype.hasOwnProperty.call(RANK, key) ? RANK[key] : 50;
}

function resolveUrl(base, ref) {
  try { return new URL(ref, base).toString(); }
  catch (err) { return ""; }
}

function parseHls(text, base) {
  const lines = String(text || "").split(/\r?\n/);
  const segments = [];
  let map = "";
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.indexOf("#EXT-X-MAP:") === 0) {
      const found = line.match(/URI="([^"]+)"/);
      if (found) map = resolveUrl(base, found[1]);
    } else if (line.indexOf("#EXTINF:") === 0) {
      const seconds = Number(line.slice("#EXTINF:".length).split(",")[0]);
      const next = (lines[i + 1] || "").trim();
      if (next && next.charAt(0) !== "#") {
        segments.push(resolveUrl(base, next));
        if (Number.isFinite(seconds)) duration += seconds;
        i += 1;
      }
    }
  }
  return { map: map, segments: segments, duration: duration };
}

function segmentKind(url) {
  const path = String(url || "").split("?")[0].toLowerCase();
  if (path.endsWith(".ts") || path.endsWith(".m2ts")) return "ts";
  if (path.endsWith(".flv")) return "flv";
  if (path.endsWith(".m4s") || path.endsWith(".mp4") || path.endsWith(".cmfv")) return "fmp4";
  return "";
}

function copyPlan(playlist) {
  const rows = playlist && playlist.segments ? playlist.segments : [];
  if (!rows.length) return { ok: false, reencode: false, method: "" };
  const kind = segmentKind(rows[0]);
  if (!kind || rows.some((url) => segmentKind(url) !== kind)) return { ok: false, reencode: false, method: "" };
  if (kind === "ts") return { ok: true, reencode: false, method: "concat-ts", ext: "ts" };
  if (kind === "flv") return { ok: true, reencode: false, method: "concat-flv", ext: "flv" };
  if (kind === "fmp4" && playlist.map) return { ok: true, reencode: false, method: "concat-fmp4", ext: "mp4" };
  return { ok: false, reencode: false, method: "" };
}

function concatBytes(chunks) {
  const parts = chunks || [];
  let size = 0;
  parts.forEach((part) => { size += part.length; });
  const out = new Uint8Array(size);
  let offset = 0;
  parts.forEach((part) => { out.set(part, offset); offset += part.length; });
  return out;
}

function concatFlv(chunks) {
  const parts = chunks || [];
  if (!parts.length) return new Uint8Array(0);
  const rest = parts.slice(1).map((buf) => {
    if (buf.length >= 9 && buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56) {
      const header = (buf[5] << 24) | (buf[6] << 16) | (buf[7] << 8) | buf[8];
      const skip = Math.max(9, header) + 4;
      return skip < buf.length ? buf.subarray(skip) : new Uint8Array(0);
    }
    return buf;
  });
  return concatBytes([parts[0]].concat(rest));
}

function bestSource(info) {
  const rows = info && info.variants && info.variants.length ? info.variants.slice() : [];
  if (!rows.length && info && (info.hls || info.flv)) rows.push({ quality: info.quality || "", hls: info.hls || "", flv: info.flv || "" });
  rows.sort((a, b) => rankOf(b && b.quality) - rankOf(a && a.quality));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    if (row.hls) return { kind: "hls", url: String(row.hls), quality: String(row.quality || "") };
    if (row.flv) return { kind: "flv", url: String(row.flv), quality: String(row.quality || "") };
  }
  return null;
}

const api = { parseHls: parseHls, segmentKind: segmentKind, copyPlan: copyPlan, concatBytes: concatBytes, concatFlv: concatFlv, bestSource: bestSource };
export { parseHls, segmentKind, copyPlan, concatBytes, concatFlv, bestSource };
globalThis.LiveCopy = api;
