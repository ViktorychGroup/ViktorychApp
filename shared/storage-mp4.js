/* Fragmented MP4 boxes from an ffmpeg -c copy init segment and moof/styp
   fragments. The avc1 codec string is read from the avcC box. */

const CONTAINERS = { moov: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, stsd: 1, moof: 1, traf: 1, mvex: 1, edts: 1, dinf: 1, udta: 1 };

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function topLevelBoxes(bytes) {
  const out = [];
  let i = 0;
  while (i + 8 <= bytes.length) {
    let size = readU32(bytes, i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    let header = 8;
    if (size === 1) {
      if (i + 16 > bytes.length) break;
      const hi = readU32(bytes, i + 8);
      const lo = readU32(bytes, i + 12);
      size = hi * 4294967296 + lo;
      header = 16;
    } else if (size === 0) {
      size = bytes.length - i;
    }
    if (!Number.isFinite(size) || size < header || i + size > bytes.length) break;
    out.push({ type: type, start: i, end: i + size });
    i += size;
  }
  return out;
}

function collectTypes(bytes, start, end, into) {
  const boxes = [];
  let i = start;
  while (i + 8 <= end) {
    let size = readU32(bytes, i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    let header = 8;
    if (size === 1) {
      if (i + 16 > end) break;
      size = readU32(bytes, i + 8) * 4294967296 + readU32(bytes, i + 12);
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (!Number.isFinite(size) || size < header || i + size > end) break;
    into.add(type);
    boxes.push({ type: type, start: i, header: header, end: i + size });
    i += size;
  }
  boxes.forEach(function (box) {
    if (CONTAINERS[box.type]) collectTypes(bytes, box.start + box.header, box.end, into);
  });
}

export function boxTypes(bytes) {
  const into = new Set();
  collectTypes(bytes, 0, bytes.length, into);
  return into;
}

/* init: moov and no media fragment. fragment: styp + moof and no moov.
   A whole file has moov and mdat and is neither. */
export function classifyMp4(bytes) {
  if (!bytes || bytes.length < 8) return "other";
  const types = boxTypes(bytes);
  const moov = types.has("moov");
  const moof = types.has("moof");
  const styp = types.has("styp");
  const mdat = types.has("mdat");
  if (moov && !moof && !mdat) return "init";
  if (!moov && moof && styp) return "fragment";
  if (moov && mdat && !moof) return "file";
  return "other";
}

function findBox(bytes, type) {
  const want = type;
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]) !== want) continue;
    const size = readU32(bytes, i);
    if (size < 8 || size > bytes.length || i + size > bytes.length) continue;
    return { start: i, size: size, header: 8 };
  }
  return null;
}

function hexByte(n) {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

/* avc1.PPCCLL from the avcC profile, constraints and level. */
export function avc1Codec(bytes) {
  const types = boxTypes(bytes);
  if (types.has("hvc1") || types.has("hev1") || types.has("av01") || types.has("vp09") || types.has("vp08")) return "";
  const box = findBox(bytes, "avcC");
  if (!box) return "";
  const at = box.start + box.header;
  if (at + 4 > bytes.length || bytes[at] !== 1) return "";
  return "avc1." + hexByte(bytes[at + 1]) + hexByte(bytes[at + 2]) + hexByte(bytes[at + 3]);
}

function aacLc(payload) {
  let indication = false;
  let objectType = 0;
  for (let i = 0; i + 3 < payload.length; i++) {
    if (payload[i] === 0x04 && payload[i + 1] > 0 && payload[i + 1] < 128 && payload[i + 2] === 0x40) indication = true;
    if (payload[i] === 0x05 && payload[i + 1] > 1 && payload[i + 1] < 32) objectType = payload[i + 2] >> 3;
  }
  return indication && objectType === 2;
}

/* "aac-lc" only when the esds says MPEG-4 AAC-LC. Anything else is "other".
   No audio sample entry is "none". */
export function audioKind(bytes) {
  const types = boxTypes(bytes);
  const otherAudio = types.has("ac-3") || types.has("ec-3") || types.has("Opus") || types.has("fLaC") || types.has("alac");
  if (otherAudio) return "other";
  if (!types.has("mp4a")) return "none";
  const esds = findBox(bytes, "esds");
  if (!esds) return "other";
  const payload = bytes.subarray(esds.start + esds.header, esds.start + esds.size);
  return aacLc(payload) ? "aac-lc" : "other";
}

/* Browser-likely mime. H264 from avcC, and AAC-LC only when the file has it.
   Returns "" when the file is not that pair. */
export function likelyMime(bytes) {
  const video = avc1Codec(bytes);
  const audio = audioKind(bytes);
  if (!video || audio === "other") return "";
  if (audio === "aac-lc") return "video/mp4; codecs=\"" + video + ",mp4a.40.2\"";
  return "video/mp4; codecs=\"" + video + "\"";
}
