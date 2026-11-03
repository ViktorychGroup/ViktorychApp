/* Viewer cap for TikTok lives. A count already in hand is the only input.
   Two checks in a row over the cap pause the live. Two checks back at or
   under the cap make it playable again. One spike does not flip either way.
   Recording stays off after a pause unless the owner opted into auto-restart. */

const DEFAULT_CAP = 20;
const HITS = 2;

function parseCap(value) {
  if (value == null || value === "") return DEFAULT_CAP;
  if (value === false || value === "off" || value === "0" || value === 0) return "off";
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CAP;
  return Math.min(n, 100000);
}

function blankState() {
  return { over: 0, under: 0, paused: false, holdRecord: false };
}

function stepCap(state, viewers, cap, opts) {
  const prev = state && typeof state === "object" ? state : blankState();
  const limit = parseCap(cap);
  const wanted = !!(opts && opts.wantedRecord);
  const autoRestart = !!(opts && opts.autoRestart);
  if (limit === "off") {
    return { over: 0, under: 0, paused: false, holdRecord: false, changed: !!prev.paused || !!prev.holdRecord };
  }
  const count = Math.max(0, Math.floor(Number(viewers) || 0));
  const hot = count > limit;
  const over = hot ? (Number(prev.over) || 0) + 1 : 0;
  const under = hot ? 0 : (Number(prev.under) || 0) + 1;
  let paused = !!prev.paused;
  if (!paused && over >= HITS) paused = true;
  if (paused && under >= HITS) paused = false;
  let holdRecord = !!prev.holdRecord;
  if (paused && !prev.paused) holdRecord = true;
  if (!paused && holdRecord && autoRestart && wanted) holdRecord = false;
  return {
    over: over,
    under: under,
    paused: paused,
    holdRecord: holdRecord,
    changed: paused !== !!prev.paused || holdRecord !== !!prev.holdRecord
  };
}

function proxyBlocked(row) {
  return !!(row && row.capState && row.capState.paused);
}

function allowRecord(state, autoRestart, wanted) {
  if (!wanted) return false;
  if (state && state.paused) return false;
  if (state && state.holdRecord && !autoRestart) return false;
  return true;
}

function sinkPaused(rows, paused) {
  const open = [];
  const held = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (paused && paused(row)) held.push(row);
    else open.push(row);
  });
  return open.concat(held);
}

/* Walk the live list and skip paused rows. delta is -1 or 1. */
function nextPlayable(rows, index, delta, paused) {
  const list = Array.isArray(rows) ? rows : [];
  const step = Number(delta) < 0 ? -1 : 1;
  let i = Math.floor(Number(index) || 0);
  for (let n = 0; n < list.length; n++) {
    i += step;
    if (i < 0 || i >= list.length) return -1;
    if (!(paused && paused(list[i]))) return i;
  }
  return -1;
}

const api = {
  DEFAULT_CAP: DEFAULT_CAP,
  HITS: HITS,
  parseCap: parseCap,
  stepCap: stepCap,
  proxyBlocked: proxyBlocked,
  allowRecord: allowRecord,
  sinkPaused: sinkPaused,
  nextPlayable: nextPlayable
};

export { DEFAULT_CAP, HITS, parseCap, stepCap, proxyBlocked, allowRecord, sinkPaused, nextPlayable };
globalThis.ViewerCap = api;
