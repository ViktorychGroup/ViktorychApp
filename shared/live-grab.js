/* Lossless stills from a decoded video frame. The size is the stream's
   own videoWidth and videoHeight. PNG is the only output. */

const BURST_MIN = 10;
const BURST_MAX = 30;
const BURST_DEFAULT = 12;

function clampBurst(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return BURST_DEFAULT;
  if (n < BURST_MIN) return BURST_MIN;
  if (n > BURST_MAX) return BURST_MAX;
  return n;
}

function frameBox(video) {
  const width = Math.max(0, Math.floor(Number(video && video.videoWidth) || 0));
  const height = Math.max(0, Math.floor(Number(video && video.videoHeight) || 0));
  return { width: width, height: height, png: true, scaled: false };
}

/* Keep one still per source timestamp so a slowed frame is not saved twice. */
function uniqueFrames(frames) {
  const seen = {};
  const out = [];
  (frames || []).forEach((frame) => {
    if (!frame) return;
    const key = frame.timestamp == null ? "" : String(frame.timestamp);
    if (key && seen[key]) return;
    if (key) seen[key] = true;
    out.push(frame);
  });
  return out;
}

const api = { BURST_MIN: BURST_MIN, BURST_MAX: BURST_MAX, BURST_DEFAULT: BURST_DEFAULT, clampBurst: clampBurst, frameBox: frameBox, uniqueFrames: uniqueFrames };
export { BURST_MIN, BURST_MAX, BURST_DEFAULT, clampBurst, frameBox, uniqueFrames };
globalThis.LiveGrab = api;
