/* Calls. Audio and text only. The camera is never opened.
   Guests get the same tools; their choices stay on this device.
   This file runs inside the app and on the stand-alone /calls/ page.
   The real work is in shared/call-engine.js: WebRTC between the two
   phones and a Gemini Live Translate socket per listener. */
import { guessLang, sameLang, PINNED_LANGS, CALL_LANGS, normalizeLang, detectLang, langName } from "./shared/call-langs.js";
import { normalizeVolumes, VOLUME_KEYS, VOLUME_DEFAULTS, MIC_CONSTRAINTS, OPUS_MAX_BITRATE, transcriptWords } from "./shared/call-audio.js";
import { normalizeMode, transmitOriginal, micOpen, noteRelease, noteShouldAutoplay, showOriginalSub, showTranslationSub, threadVisible, takeClauses, QUICK_PHRASES, guestFeature, NOTE_CANCEL_DX } from "./shared/call-mode.js";
import { createVoiceMatch, PREBUILT_VOICES, DEFAULT_VOICE } from "./shared/call-voice.js";
import { createHistory, recordLocal, swipeAction, toggleSet } from "./shared/call-history.js";
import { createRaiseDetector, earSinkId, createUnlocker, EAR_VOLUME_CAP } from "./shared/call-ear.js";
import { createPip } from "./shared/call-pip.js";
import { createPreview } from "./shared/call-preview.js";
import { lighterFor, pickSink, cleanLexicon, lexiconHint, rememberLine } from "./shared/call-quality.js";
import { createAudioUnlock, createWakeFallback, micFailure, micPlatform } from "./shared/call-mobile.js";
import { createLiveSession, MIC_WORKLET, OUTPUT_RATE, CHUNK_SAMPLES, proxiesAudio } from "./shared/call-gemini.js";
import { createDiarizer } from "./shared/call-speakers.js";
import { createEngine } from "./shared/call-engine.js";
import { holdStatus, shouldRemountOnStatus, shouldRemountOnPeer, GUEST_SESSION_KEY, guestSessionRecord, guestSessionLive, guestSessionForRoute, callErrorKind } from "./shared/call-status.js";
import { SCHEDULE_TOKEN, icsForSchedule, clipDuration, DEFAULT_DURATION } from "./shared/call-schedule.js";
import { ROTATE_TOKEN, ROTATE_REFRESH_MS } from "./shared/call-rotate-qr.js";

const CAP_SIZES = ["s", "m", "l", "xl"];
const CAP_SHOW = 3;
const CAP_FADE_MS = 9000;
const CAP_GONE_MS = 16000;
const WHO_COLORS = ["#1d9bf0", "#00ba7c", "#f91880", "#ffd400", "#7856ff", "#ff7a00"];
const DEVICE_KEY = "viktorych-calls-device-v1";
const GUEST_KEY = "viktorych-calls-guest-v1";
const ROUTE_KEY = "viktorych-calls-route-v1";
const GKEY = "viktorych-calls-gkey-v1";
const SESSION_KEYS = ["viktorychapp-account-v1", "superintelapp-account-v1"];

/* Owner switch calls_quiet_voice, on unless the server list says off. The stand-alone page has no list and keeps it on. */
function quietVoiceOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_quiet_voice") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_pip, on unless the server list says off. */
function pipFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_pip") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_qr, on unless the server list says off. */
function qrFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_qr") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_onechat, on unless the server list says off. */
function oneChatFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_onechat") >= 0);
  } catch (err) { return true; }
}
/* One conversation in the call view: captions, typed messages and the composer share a single panel. */
function convShown() {
  return oneChatFlagOn() && state.conv !== false;
}

/* Owner switch calls_onescreen, on unless the server list says off. */
function onescreenFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_onescreen") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_duck, on unless the server list says off. */
function duckFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_duck") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_barge, on unless the server list says off. */
function bargeFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_barge") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_short_eos, on unless the server list says off. */
function shortEosFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_short_eos") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_stream_play, on unless the server list says off. */
function streamPlayFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_stream_play") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_live_stream, on unless the server list says off. */
function liveStreamFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_live_stream") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_latency, on unless the server list says off. Timing is always taken (it is a few numbers per phrase);
   the switch only shows it in the test chips and the statistics list. */
function latencyFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_latency") >= 0);
  } catch (err) { return true; }
}
function latencyRows(s) {
  const l = s && s.lat;
  const ms = (v) => (v == null ? "-" : tr("{ms} ms", { ms: Math.round(v) }));
  return [
    [tr("Stop to sound (median)"), ms(l && l.stopToPlay.p50)],
    [tr("Stop to sound (slowest)"), ms(l && l.stopToPlay.p95)],
    [tr("Speech to first reply"), ms(l && l.toByte.p50)],
    [tr("Reply to speaker"), ms(l && l.byteToPlay.p50)],
    [tr("Phrases timed"), l ? String(l.n) : "-"]
  ];
}

/* Owner switch calls_setup, on unless the server list says off. */
function setupFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_setup") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_bar, on unless the server list says off. */
function barFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_bar") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_bar_sheet, on unless the server list says off. */
function barSheetFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_bar_sheet") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_schedule, on unless the server list says off. */
function scheduleFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_schedule") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_orig_vol, on unless the server list says off. */
function origVolFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_orig_vol") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_rotate_qr, on unless the server list says off. */
function rotateQrFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_rotate_qr") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_practice, on unless the server list says off. */
function practiceFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_practice") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_hist_edit, on unless the server list says off. */
function histEditFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_hist_edit") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_eu_proxy, on unless the server list says off. */
function euProxyFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_eu_proxy") >= 0);
  } catch (err) { return true; }
}

/* Owner switch calls_preview, on unless the server list says off. */
function previewFlagOn() {
  try {
    const list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
    return !(Array.isArray(list) && list.indexOf("calls_preview") >= 0);
  } catch (err) { return true; }
}

function tr(key, vars) {
  const fn = window.t || (window.SI18n && window.SI18n.t);
  return fn ? fn(key, vars) : key;
}
/* English text for plural keys, for pages that do not load the English pack (the stand-alone page). */
const PLURAL_EN = { callsSelected: ["{n} selected", "{n} selected"], callsRemoved: ["{n} call removed from your history", "{n} calls removed from your history"] };
function trn(key, n) {
  const i = window.SI18n;
  const out = i && i.tn ? i.tn(key, n) : "";
  if (out && out.indexOf(key + ".") !== 0) return out;
  return (PLURAL_EN[key] || [String(n), String(n)])[Number(n) === 1 ? 0 : 1].replace("{n}", String(n));
}
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function readJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); }
  catch (err) { return null; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (err) { /* private mode */ }
}
function readSessionJson(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || "null"); }
  catch (err) { return null; }
}
function writeSessionJson(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); }
  catch (err) { /* private mode */ }
}
function readStoredGuestSession() {
  const now = Date.now();
  let row = readSessionJson(GUEST_SESSION_KEY);
  if (!guestSessionLive(row, now)) row = readJson(GUEST_SESSION_KEY);
  return guestSessionLive(row, now) ? row : null;
}
function writeStoredGuestSession(input) {
  const rec = guestSessionRecord(input, Date.now());
  if (!rec) return;
  writeSessionJson(GUEST_SESSION_KEY, rec);
  writeJson(GUEST_SESSION_KEY, rec);
}
function clearGuestSession() {
  try { sessionStorage.removeItem(GUEST_SESSION_KEY); } catch (err) { /* private mode */ }
  try { localStorage.removeItem(GUEST_SESSION_KEY); } catch (err) { /* private mode */ }
}
function guestInviteKey(route) {
  if (!route) return "";
  if (route.token) return String(route.token);
  if (route.slug) return "link:" + route.slug;
  return "";
}
function rememberGuestSession(expiresAt) {
  if (!state.guestToken || !state.callId) return;
  writeStoredGuestSession({
    token: state.guestToken,
    callId: state.callId,
    invite: guestInviteKey(state.route),
    name: state.name,
    expiresAt: Number(expiresAt) || 0
  });
}
function standalone() {
  return window.VIKTORYCH_CALLS_STANDALONE === true;
}
function session() {
  for (let i = 0; i < SESSION_KEYS.length; i++) {
    const row = readJson(SESSION_KEYS[i]);
    if (row && row.token && row.account) return row;
  }
  return null;
}
function token() {
  const accounts = window.ViktorychAccounts;
  const live = accounts && accounts.token && accounts.token();
  if (live) return live;
  const row = session();
  return row ? row.token : "";
}
function signedIn() {
  return !!token();
}
/* Calls always use the main Worker. Signalling needs its Durable Object,
   which the backup host does not have. */
function apiBase() {
  const bag = window.VIKTORYCH_ACCOUNTS || {};
  const main = String(bag.api || "").replace(/\/$/, "");
  if (main) return main;
  const accounts = window.ViktorychAccounts;
  const cur = accounts && accounts.currentApi && accounts.currentApi();
  return cur ? String(cur).replace(/\/$/, "") : "";
}
function authHeaders() {
  const headers = { "content-type": "application/json" };
  const tok = token();
  if (tok) headers.Authorization = "Bearer " + tok;
  if (state.guestToken) headers["x-call-guest"] = state.guestToken;
  return headers;
}
async function api(path, init) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, 12000);
  try {
    const res = await fetch(apiBase() + path, Object.assign({ headers: authHeaders(), cache: "no-store", signal: ctrl ? ctrl.signal : undefined }, init || {}));
    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    return { ok: res.ok, status: res.status, data: data };
  } finally { clearTimeout(timer); }
}

const hist = createHistory({ api: (path, init) => api(path, init), storage: { getItem: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, setItem: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } }, signedIn: () => signedIn() });
const state = {
  histSel: null,
  histEdit: null,
  pop: "",
  barOpen: false,
  histUndo: null,
  phase: "idle",
  configured: true,
  mode: normalizeMode({}),
  volumes: normalizeVolumes({}),
  lexicon: [],
  voice: "",
  lang: "",
  lines: [],
  lastSendVisibleMs: 0,
  sendStarted: 0,
  lastLine: null,
  partial: { original: "", translation: "" },
  speaking: false,
  meSpeaking: false,
  translating: false,
  recording: false,
  review: null,
  name: "",
  peerName: "",
  guestToken: "",
  invite: "",
  inviteUrl: "",
  history: [],
  incoming: null,
  link: null,
  linkInfo: null,
  linkError: "",
  inviteTtl: 60,
  prefs: null,
  status: "",
  statusCode: "",
  quota: false,
  needKey: "",
  keySaved: false,
  keyMask: "",
  peerQuota: false,
  route: "",
  engine: null,
  partner: null,
  test: null,
  more: false,
  panel: "",
  panelAnim: false,
  tab: "recent",
  schedules: [],
  schedForm: false,
  schedHandle: "",
  schedToast: null,
  schedGuest: null,
  schedBusy: false,
  rotateQr: null,
  rotateQrTimer: 0,
  micCheck: null,
  testPrep: null,
  testPoll: 0,
  qrLoading: false,
  speakerOn: true,
  hintSeen: false,
  muted: false,
  stats: null,
  error: "",
  callId: "",
  startedAt: 0,
  whoLabel: "",
  capSize: "m",
  noMic: "",
  micAsked: false,
  micNote: "",
  ear: { on: false, auto: false, routed: false, note: "" },
  earRaise: true,
  testInfo: false,
  sink: ""
};

function loadDevice() {
  const saved = readJson(DEVICE_KEY) || {};
  state.volumes = normalizeVolumes(saved.volumes || {});
  state.lexicon = cleanLexicon(saved.lexicon || []);
  state.voice = typeof saved.voice === "string" ? saved.voice : "";
  state.lang = typeof saved.lang === "string" ? saved.lang : "";
  state.hintSeen = saved.hintSeen === true;
  state.earRaise = saved.earRaise !== false;
  state.capSize = CAP_SIZES.indexOf(saved.capSize) >= 0 ? saved.capSize : "m";
  state.speakerOn = saved.speakerOn !== false;
  state.mode = normalizeMode(saved.mode || {});
  const guest = readJson(GUEST_KEY) || {};
  if (!signedIn()) state.name = String(guest.name || state.name || "");
  else {
    const row = session();
    state.name = String((row && row.account && (row.account.displayName || row.account.handle)) || state.name || "");
  }
}
function saveDevice() {
  writeJson(DEVICE_KEY, { volumes: state.volumes, lexicon: state.lexicon, voice: state.voice, lang: state.lang, hintSeen: state.hintSeen, speakerOn: state.speakerOn, mode: state.mode, capSize: state.capSize, earRaise: state.earRaise });
  writeJson(GUEST_KEY, { name: state.name });
}
function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function myLang() {
  return normalizeLang(state.lang) || guessLang((navigator.languages && navigator.languages[0]) || navigator.language);
}
function inRegion() {
  /* Same detector the main app uses for Russia and India. */
  return !!(window.__VIKTORYCH_IS_RU || window.__VIKTORYCH_IS_IN || window.__VIKTORYCH_MAX_BYPASS);
}
function relayFirst() {
  let saved = "";
  try { saved = localStorage.getItem(ROUTE_KEY) || ""; } catch (err) { saved = ""; }
  let mode = "auto";
  try { mode = localStorage.getItem("viktorychapp-network-mode") || "auto"; } catch (err) { mode = "auto"; }
  if (mode === "max") return true;
  if (mode === "direct") return false;
  if (saved) {
    try {
      const row = JSON.parse(saved);
      if (row && Date.now() - row.at < 60 * 60 * 1000) return row.via === "relay";
    } catch (err) { /* ignore */ }
  }
  return inRegion();
}
function routeKnown() {
  try {
    const row = JSON.parse(localStorage.getItem(ROUTE_KEY) || "null");
    return !!(row && Date.now() - row.at < 60 * 60 * 1000);
  } catch (err) { return false; }
}
/* The relay is a stateless socket, so any host that runs it will do. The
   main Worker comes first. The Pages mirror is a second hostname for
   networks that block workers.dev, and a site on its own domain or the
   mirror uses its own origin first. */
const RELAY_MIRROR = "https://viktorychapp.pages.dev";
function relayHosts() {
  const out = [];
  const add = (host) => {
    const clean = String(host || "").replace(/\/$/, "");
    if (/^https?:\/\//i.test(clean) && out.indexOf(clean) < 0) out.push(clean);
  };
  const bag = window.VIKTORYCH_ACCOUNTS || {};
  const here = typeof location !== "undefined" ? location.origin : "";
  if (/\.pages\.dev$/i.test(here.replace(/^https?:\/\//i, ""))) add(here);
  add(apiBase());
  (Array.isArray(bag.relayHosts) ? bag.relayHosts : []).forEach(add);
  add(RELAY_MIRROR);
  return out;
}
function rememberRoute(via) {
  try { localStorage.setItem(ROUTE_KEY, JSON.stringify({ via: via, at: Date.now() })); } catch (err) { /* private mode */ }
}

function quotaLine() {
  if (state.needKey) return state.needKey === "badkey" ? tr("That Gemini key was not accepted. Paste a new one.") : tr("Translation needs a free Gemini key. Nobody in this call has added one yet.");
  if (state.quota) return tr("Translation quota is tight. This call continues as text.");
  if (state.turnFallback) return tr("Live translation dropped. This call is translating one phrase at a time.");
  return "";
}
/* A key pasted on this device (guests, or when the server cannot store it).
   It rides only the request that mints a short-lived token, and is never
   stored by the Worker or shown to the other person. */
function localKey() {
  try { return localStorage.getItem(GKEY) || ""; } catch (err) { return ""; }
}
function validKeyShape(value) {
  return /^[A-Za-z0-9_-]{20,100}$/.test(String(value || ""));
}
function keyPanel() {
  if (!state.needKey) return "";
  const where = signedIn() ? tr("It is saved encrypted on our server, so your calls and your guests can use it. You can remove it any time.") : tr("It stays on this device only.");
  return `<section class="calls-key" data-key role="alert">
    <h3>${esc(tr("Use your free Gemini key"))}</h3>
    <p>${esc(quotaLine())}</p>
    <p>${esc(tr("Translation uses Google's free Gemini. Get a key in a minute, then paste it here."))} <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a></p>
    <form class="calls-type" data-act="call-key-form"><input name="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${esc(tr("Gemini key"))}" placeholder="${esc(tr("Paste your key"))}"><button type="submit">${esc(tr("Save"))}</button></form>
    <p class="calls-privacy">${esc(where)}</p>
  </section>`;
}

function phraseLabel(id) {
  if (id === "hold") return tr("Hold on");
  if (id === "repeat") return tr("Repeat");
  if (id === "back") return tr("Call back");
  return "";
}
function pill(group, value, current, label) {
  const on = value === current;
  return `<button type="button" class="calls-pill${on ? " on" : ""}" data-act="call-set" data-group="${esc(group)}" data-value="${esc(value)}" aria-pressed="${on ? "true" : "false"}">${esc(label)}</button>`;
}
function volKey(key) {
  return key === "trvol" ? "trans" + "lation" : key;
}
function slider(key, label) {
  const name = volKey(key);
  const value = Math.round((state.volumes[name] == null ? VOLUME_DEFAULTS[name] : state.volumes[name]) * 100);
  return `<label class="calls-vol"><span>${esc(label)}</span><input type="range" min="0" max="100" value="${value}" data-vol="${esc(key)}" aria-label="${esc(label)}"></label>`;
}

/* ---------- Teams-style layout pieces (X look) ---------- */
const HAND_PATH = "M21.5 16.9v2.6a2 2 0 0 1-2.2 2 18.7 18.7 0 0 1-8.1-2.9 18.4 18.4 0 0 1-5.7-5.7A18.7 18.7 0 0 1 2.6 4.7a2 2 0 0 1 2-2.2h2.6a2 2 0 0 1 2 1.7c.1.9.3 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 10.1a16 16 0 0 0 5.8 5.8l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.7.7a2 2 0 0 1 1.5 2.1z";
const ICONS = {
  phone: `<path d="${HAND_PATH}"/>`,
  trash: `<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12.2A2 2 0 0 0 9 21h6a2 2 0 0 0 2-1.8L18 7M9 7V4.5h6V7"/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  info: `<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2M12 7.8h.01"/>`,
  hangup: `<g transform="rotate(135 12 12)"><path d="${HAND_PATH}"/></g>`,
  ear: `<path d="${HAND_PATH}"/><path d="M14.5 6.2a3.3 3.3 0 0 1 3.3 3.3"/><path d="M14.5 2.6a6.9 6.9 0 0 1 6.9 6.9"/>`,
  mic: `<path d="M12 14.5a3.2 3.2 0 0 0 3.2-3.2V6.2a3.2 3.2 0 0 0-6.4 0v5.1a3.2 3.2 0 0 0 3.2 3.2z"/><path d="M6 11.3a6 6 0 0 0 12 0M12 17.3v3.2M8.8 20.5h6.4"/>`,
  micOff: `<path d="M12 14.5a3.2 3.2 0 0 0 3.2-3.2V6.2a3.2 3.2 0 0 0-6.4 0v5.1a3.2 3.2 0 0 0 3.2 3.2z"/><path d="M6 11.3a6 6 0 0 0 12 0M12 17.3v3.2M8.8 20.5h6.4"/><path d="M4 4l16 16"/>`,
  speaker: `<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>`,
  speakerOff: `<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l4.5 5M20.5 9.5 16 14.5"/>`,
  captions: `<rect x="3" y="5.5" width="18" height="13" rx="3"/><path d="M10.3 10.3a2 2 0 1 0 0 3.4M16.3 10.3a2 2 0 1 0 0 3.4"/>`,
  voice: `<path d="M4 12h1.5M8 8v8M12 5v14M16 8v8M20 12h-1.5"/>`,
  text: `<rect x="3" y="6.5" width="18" height="11" rx="2.5"/><path d="M7 10.5h.01M10.3 10.5h.01M13.7 10.5h.01M17 10.5h.01M8 14h8"/>`,
  note: `<circle cx="12" cy="12" r="9"/><path d="M12 14.2a2.4 2.4 0 0 0 2.4-2.4V9.4a2.4 2.4 0 0 0-4.8 0v2.4a2.4 2.4 0 0 0 2.4 2.4zM8.5 12a3.5 3.5 0 0 0 7 0"/>`,
  chat: `<path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9.5L5 20.5V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1z"/><path d="M8 10h8M8 13h5"/>`,
  translate: `<path d="M3.5 6h9M8 4v2M5.5 6c.7 3 2.8 5.4 5.5 6.8M11 6c-.7 3-3 5.7-6 7"/><path d="M12.5 20l4-9 4 9M13.9 17h5.2"/>`,
  more: `<circle cx="5.5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor"/>`,
  link: `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`,
  calendar: `<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`,
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  back: `<path d="M19 12H5M11 6l-6 6 6 6"/>`,
  incoming: `<path d="M7 7l10 10M17 8v9H8"/>`,
  outgoing: `<path d="M17 17 7 7M8 7h9v9"/>`,
  settings: `<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>`,
  user: `<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.6-3.9 3.6-6.3 7.5-6.3s6.9 2.4 7.5 6.3z"/>`,
  test: `<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 15h9"/>`
};
function ico(name, cls) {
  return `<svg class="calls-ico${cls ? " " + cls : ""}" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</g></svg>`;
}
function initialOf(name) {
  return String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
}
function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}
function when(ms) {
  if (!ms) return "";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  } catch (err) { return ""; }
}
function peerLang() {
  try {
    if (state.test && state.test.lang) return state.test.lang;
    const st = state.engine && state.engine.stats && state.engine.stats();
    return (st && st.peer && st.peer.lang) || "";
  } catch (err) { return ""; }
}
function langBadge(code) {
  return code ? `<span class="calls-lang" title="${esc(langName(code))}">${esc(String(code).split("-")[0].toUpperCase())}</span>` : "";
}
function waveBars() {
  return `<span class="calls-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>`;
}
function tile(kind, name, lang, speaking, extra) {
  if (!onescreenFlagOn()) {
    return `<div class="calls-tile" data-tile="${kind}" data-speaking="${speaking ? "1" : "0"}">
    <div class="calls-ava${kind === "me" ? " me" : ""}">${esc(initialOf(name))}</div>
    ${waveBars()}
    <div class="calls-tag"><span class="calls-tname">${esc(name)}</span>${extra || ""}</div>
    <div class="calls-tlang">${langBadge(lang)}</div>
  </div>`;
  }
  const muted = kind === "me" && !!(state.muted || state.noMic);
  const mute = muted ? `<span class="calls-tmute" title="${esc(state.noMic ? tr("No mic") : tr("Muted"))}">${ico("micOff")}</span>` : "";
  return `<div class="calls-tile" data-tile="${kind}" data-speaking="${speaking ? "1" : "0"}"${muted ? " data-muted=\"1\"" : ""}>
    <span class="calls-ava-wrap"><div class="calls-ava${kind === "me" ? " me" : ""}">${esc(initialOf(name))}</div>${mute}</span>
    <div class="calls-tmeta"><span class="calls-tname">${esc(name)}</span>${langBadge(lang)}${extra || ""}</div>
    ${waveBars()}
  </div>`;
}
function cbtn(act, icon, label, opt) {
  const o = opt || {};
  const pressed = o.pressed == null ? "" : ` aria-pressed="${o.pressed ? "true" : "false"}"`;
  const data = o.data ? Object.keys(o.data).map((k) => ` data-${k}="${esc(o.data[k])}"`).join("") : "";
  return `<button type="button" class="cb${o.cls ? " " + o.cls : ""}${o.pressed ? " on" : ""}" data-act="${act}"${data}${pressed} aria-label="${esc(o.aria || label)}" title="${esc(o.aria || label)}">${ico(icon)}<span class="cb-l">${esc(label)}</span></button>`;
}

/* A partial that repeats the newest finished line is the same turn: show the finished bubble only. */
function partialIsFinal(p, now) {
  const last = state.lines[state.lines.length - 1];
  if (!last || !last.at || now - last.at > 6000) return false;
  const same = (a, b) => { const x = String(a || "").trim().toLowerCase(); const y = String(b || "").trim().toLowerCase(); return !!x && !!y && (x === y || y.indexOf(x) === 0); };
  return same(p.translation, last.translation) || same(p.original, last.original);
}
function whoColor(name, mine) {
  if (mine) return WHO_COLORS[0];
  let h = 0;
  const text = String(name || "");
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return WHO_COLORS[1 + (h % (WHO_COLORS.length - 1))];
}
/* One chat bubble: translation large and bold, the original smaller and dimmer under it. */
function bubbleHtml(row, opts) {
  const o = opts || {};
  const mine = !!row.mine;
  const shown = state.test ? Object.assign({}, state.mode, { subtitles: "both" }) : state.mode;
  const wantOrig = showOriginalSub(shown);
  const wantTrn = showTranslationSub(shown);
  const hasTrn = row.translation && row.translation !== row.original;
  let big = "";
  let small = "";
  if (o.cap) {
    if (hasTrn && wantTrn) { big = row.translation; small = wantOrig ? (row.original || "") : ""; }
    else if (wantOrig || !hasTrn) { big = row.original || row.translation || ""; }
    if (!big && !small) return "";
  } else {
    big = hasTrn ? row.translation : (row.original || "");
    small = hasTrn ? (row.original || "") : "";
  }
  const who = String(row.who || "");
  const st = !o.cap && row.mine && row.typed ? String(row.status || (row.sent === false ? "sending" : "")) : "";
  const status = st === "failed" ? `<p class="calls-bstatus">${esc(tr("Not sent."))}<button type="button" data-act="call-chat-retry" data-id="${esc(row.id)}">${esc(tr("Retry"))}</button></p>` : (st === "sending" ? `<p class="calls-bstatus">${esc(tr("Sending…"))}</p>` : "");
  const note = row.note ? `<button type="button" data-act="call-replay" data-id="${esc(row.id)}">${esc(tr("Replay"))}</button>` : "";
  const age = o.cap && row.at ? Date.now() - row.at : 0;
  const fade = o.cap && !o.live && age > CAP_FADE_MS ? " fading" : "";
  const words = (text) => {
    if (!o.live || !streamPlayFlagOn() || !text) return esc(text);
    return transcriptWords(text).map((w, i, all) => `<span class="calls-word${i === all.length - 1 ? " now" : ""}">${esc(w)}</span>`).join("");
  };
  return `<article class="calls-bubble${mine ? " mine" : ""}${o.live ? " partial" : ""}${fade}${o.cont ? " cont" : ""}" style="--who:${whoColor(who, mine)}">
    <div class="calls-ava xs">${esc(initialOf(who || "?"))}</div>
    <div class="calls-bbody"><span class="calls-bname">${esc(who)}</span>${big ? `<p class="calls-bbig">${words(big)}</p>` : ""}${small ? `<p class="calls-bsmall">${words(small)}</p>` : ""}${status}${note}</div>
  </article>`;
}
/* The last bubbles over the stage: left for others, right for you; older ones fade out. */
function subtitleBlock() {
  const rows = [];
  const now = Date.now();
  state.lines.filter((l) => !l.note && l.at && now - l.at < CAP_GONE_MS).slice(-(state.capSize === "xl" ? 2 : CAP_SHOW)).forEach((l) => rows.push(bubbleHtml(l, { cap: true })));
  const p = state.partial || {};
  if ((p.original || p.translation) && !partialIsFinal(p, now)) {
    const mine = !!state.test;
    const who = state.whoLabel || (mine ? tr("You") : (state.peerName || tr("Guest")));
    rows.push(bubbleHtml({ who, mine, original: p.original || "", translation: p.translation || "" }, { cap: true, live: true }));
  }
  const html = rows.filter(Boolean).slice(-(state.capSize === "xl" ? 2 : CAP_SHOW)).join("");
  return `<div class="calls-subs" data-size="${esc(state.capSize)}" aria-live="polite">${html}</div>`;
}

function bubble(line) {
  return bubbleHtml(line, {});
}
/* The conversation for the one-panel view: finished lines plus the line being said right now. */
function convThread() {
  /* A run of bubbles from the same person shows the avatar once, so the text gets the width. */
  let prev = "";
  const key = (row) => (row.mine ? "1:" : "0:") + String(row.who || "");
  const rows = state.lines.slice(-30).map((line) => { const k = key(line); const html = bubbleHtml(line, { cont: oneChatFlagOn() && k === prev }); prev = k; return html; });
  const p = state.partial || {};
  if ((p.original || p.translation) && !partialIsFinal(p, Date.now())) {
    const mine = !!state.test;
    const who = state.whoLabel || (mine ? tr("You") : (state.peerName || tr("Guest")));
    const row = { who, mine, original: p.original || "", translation: p.translation || "" };
    rows.push(bubbleHtml(row, { live: true, cont: key(row) === prev }));
  }
  return `<div class="calls-thread" data-size="${esc(state.capSize)}" aria-live="polite">${rows.join("")}</div>`;
}
function convBlock() {
  const empty = state.lines.length || (state.partial && (state.partial.original || state.partial.translation)) ? "" : `<p class="calls-empty">${esc(tr("Messages and what was said show up here."))}</p>`;
  return `<section class="calls-conv" aria-label="${esc(tr("Chat"))}"><div class="calls-convbody">${convThread()}${empty}</div>
    <form class="calls-type calls-compose" data-act="call-type-form">${previewCard()}<input name="text" maxlength="500" aria-label="${esc(tr("Type to them"))}" placeholder="${esc(tr("Type to them"))}" autocomplete="off"><button type="submit" class="cb send" aria-label="${esc(tr("Send"))}">${ico("outgoing")}</button></form></section>`;
}
function threadBlock() {
  return `<div class="calls-thread" data-size="${esc(state.capSize)}">${state.lines.slice(-30).map(bubble).join("")}</div>`;
}

function langOptions(current) {
  const pinned = PINNED_LANGS.map((code) => [code, langName(code)]);
  const rest = CALL_LANGS.filter((row) => PINNED_LANGS.indexOf(row[0]) < 0).map((row) => [row[0], langName(row[0])]).sort((a, b) => a[1].localeCompare(b[1]));
  return pinned.concat(rest).map((row) => `<option value="${esc(row[0])}"${row[0] === current ? " selected" : ""}>${esc(row[1])}</option>`).join("");
}

function statsBlock() {
  const s = state.stats;
  if (!s) return `<div class="calls-stats" data-stats></div>`;
  const rows = [
    [tr("Route"), s.route === "relay" ? tr("Through our server") : tr("Direct")],
    [tr("Media path"), s.media || "-"],
    [tr("First translated sound"), s.firstAudio != null ? tr("{ms} ms", { ms: Math.round(s.firstAudio) }) : "-"],
    [tr("After you stop"), s.endLag != null ? tr("{ms} ms", { ms: Math.round(s.endLag) }) : "-"],
    [tr("Jitter"), s.jitter != null ? tr("{ms} ms", { ms: Math.round(s.jitter) }) : "-"],
    [tr("Packets lost"), s.lost != null ? String(s.lost) : "-"],
    [tr("Round trip"), s.rtt != null ? tr("{ms} ms", { ms: Math.round(s.rtt) }) : "-"],
    [tr("Speech sent"), s.speechSec != null ? tr("{n} s", { n: s.speechSec }) : "-"],
    [tr("Per minute"), s.perMinute != null ? tr("{n} s of 32", { n: s.perMinute }) : "-"]
  ].concat(latencyFlagOn() ? latencyRows(s) : []);
  return `<dl class="calls-stats" data-stats>${rows.map((row) => `<div><dt>${esc(row[0])}</dt><dd>${esc(row[1])}</dd></div>`).join("")}</dl>`;
}

function moreSheet() {
  const voices = [`<option value="">${esc(tr("Match the voice automatically"))}</option>`].concat(PREBUILT_VOICES.map((row) => `<option value="${esc(row.name)}"${state.voice === row.name ? " selected" : ""}>${esc(row.name)}</option>`)).join("");
  const words = state.lexicon.map((row, index) => `<li>${esc(row.word)} = ${esc(row.say)} <button type="button" data-act="call-lex-del" data-i="${index}">${esc(tr("Remove"))}</button></li>`).join("");
  return `<div class="calls-sheet calls-settings-body">
    <h3>${esc(tr("I hear"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("I hear"))}">
      ${pill("receive", "voice", state.mode.receive, tr("Voice"))}
      ${pill("receive", "text", state.mode.receive, tr("Text"))}
      ${pill("receive", "both", state.mode.receive, tr("Both"))}
    </div>
    <h3>${esc(tr("I send"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("I send"))}">
      ${pill("send", "voice", state.mode.send, tr("Voice"))}
      ${pill("send", "text", state.mode.send, tr("Text"))}
      ${pill("send", "note", state.mode.send, tr("Tap to talk"))}
    </div>
    <h3>${esc(tr("Subtitles"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("Subtitles"))}">
      ${pill("subtitles", "off", state.mode.subtitles, tr("Subtitles off"))}
      ${pill("subtitles", "translated", state.mode.subtitles, tr("Translation subtitles"))}
      ${pill("subtitles", "original", state.mode.subtitles, tr("Original subtitles"))}
      ${pill("subtitles", "both", state.mode.subtitles, tr("Original and translation"))}
    </div>
    <h3>${esc(tr("Caption size"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("Caption size"))}">
      ${CAP_SIZES.map((z) => `<button type="button" class="calls-pill${state.capSize === z ? " on" : ""}" data-act="call-capsize" data-value="${z}" aria-pressed="${state.capSize === z ? "true" : "false"}">${esc(z === "s" ? tr("Small") : z === "m" ? tr("Medium") : z === "l" ? tr("Large") : tr("Extra large"))}</button>`).join("")}
    </div>
    ${earSupported() ? earSection() : ""}
    <div class="calls-modes">
      <button type="button" class="calls-pill${state.mode.translationOnly ? " on" : ""}" data-act="call-set" data-group="translationOnly" data-value="${state.mode.translationOnly ? "0" : "1"}" aria-pressed="${state.mode.translationOnly ? "true" : "false"}">${esc(tr("Others hear only the translation"))}</button>
      <button type="button" class="calls-pill${state.mode.original ? " on" : ""}" data-act="call-set" data-group="original" data-value="${state.mode.original ? "0" : "1"}" aria-pressed="${state.mode.original ? "true" : "false"}">${esc(tr("Hear their original voice, quietly"))}</button>
      <button type="button" class="calls-pill${state.mode.reviewNotes ? " on" : ""}" data-act="call-set" data-group="reviewNotes" data-value="${state.mode.reviewNotes ? "0" : "1"}" aria-pressed="${state.mode.reviewNotes ? "true" : "false"}">${esc(tr("Check a voice note before sending"))}</button>
    </div>
    <div class="calls-quick">
      ${QUICK_PHRASES.map((phrase) => `<button type="button" data-act="call-phrase" data-text="${esc(phrase)}">${esc(phraseLabel(phrase))}</button>`).join("")}
      <button type="button" data-act="call-repeat">${esc(tr("Repeat that"))}</button>
    </div>
    <label class="calls-vol"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
    ${slider("trvol", tr("Translation volume"))}
    ${slider("original", tr("Original volume"))}
    ${slider("overall", tr("Call volume"))}
    ${slider("ring", tr("Ringtone"))}
    ${slider("mic", tr("Microphone level"))}
    ${slider("tts", tr("Spoken text volume"))}
    <label class="calls-vol"><span>${esc(tr("Translation voice"))}</span><select data-act="call-voice">${voices}</select></label>
    <h3>${esc(tr("Name pronunciations"))}</h3>
    <ul class="calls-words">${words}</ul>
    <form class="calls-lex" data-act="call-lex-form"><input name="word" maxlength="40" placeholder="${esc(tr("Word"))}" aria-label="${esc(tr("Word"))}"><input name="say" maxlength="60" placeholder="${esc(tr("Say it like"))}" aria-label="${esc(tr("Say it like"))}"><button type="submit">${esc(tr("Add"))}</button></form>
    <h3>${esc(tr("Gemini key"))}</h3>
    ${keyRow()}
    <h3>${esc(tr("Connection"))}</h3>
    ${statsBlock()}
    <p class="calls-privacy" data-quota>${esc(quotaLine())}</p>
    <p class="calls-privacy">${esc(tr("On the free Gemini plan, Google may use call audio to improve its products."))}</p>
  </div>`;
}

function keyRow() {
  const has = state.keySaved || !!localKey();
  if (has) return `<p class="calls-privacy">${esc(tr("Your Gemini key is saved."))} ${esc(state.keyMask || "")}</p><button type="button" class="calls-pill" data-act="call-key-remove">${esc(tr("Remove my key"))}</button>`;
  return `<button type="button" class="calls-pill" data-act="call-key-add">${esc(tr("Add your free Gemini key"))}</button>`;
}

function statusText() {
  const code = state.statusCode;
  if (state.error) return state.error;
  if (code === "calling") return tr("Calling…");
  if (code === "waiting") return tr("Waiting for them to join…");
  if (code === "reconnecting") return tr("Reconnecting…");
  if (state.turnFallback && (code === "connected" || code === "joined" || code === "translating-ready" || !code)) return tr("Translation dropped. Trying again…");
  if (code === "left") return tr("They left the call.");
  if (code === "lost") return tr("The connection was lost.");
  if (state.translating) return tr("Translating…");
  if (code === "connected" || code === "joined" || code === "translating-ready") return tr("Connected");
  return state.status || "";
}

function testPanel() {
  if (!state.test) return "";
  const t = state.test;
  const practice = !!t.practice;
  const replies = practice ? "" : (PARTNER_REPLIES[t.lang] || PARTNER_REPLIES.en).map((text) => `<button type="button" data-act="call-test-reply" data-text="${esc(text)}">${esc(text)}</button>`).join("");
  const lines = t.lines.slice(-6).map((line) => `<article class="calls-bubble${line.mine ? " mine" : ""}"><b>${esc(line.who)}</b>${line.original ? `<p>${esc(line.original)}</p>` : ""}${line.translation ? `<p class="calls-trn">${esc(line.translation)}</p>` : ""}</article>`).join("");
  return `<section class="calls-test${practice ? " calls-practice" : ""}" data-test>
    <h3>${esc(practice ? tr("Practice partner") : tr("Test partner"))}</h3>
    <label class="calls-vol"><span>${esc(tr("Partner speaks"))}</span><select data-act="call-test-lang">${langOptions(t.lang)}</select></label>
    ${hearSwitch(t)}
    <div class="calls-thread">${lines}</div>
    ${practice ? `<p class="calls-privacy">${esc(tr("The practice partner replies on its own after you speak or type."))}</p>` : `<div class="calls-quick">${replies}</div>
    <form class="calls-type" data-act="call-test-form"><input name="text" maxlength="500" aria-label="${esc(tr("Reply as the partner"))}" placeholder="${esc(tr("Reply as the partner"))}" autocomplete="off"></form>
    <p class="calls-privacy">${esc(tr("This test uses a real call: your voice goes to a partner in this page and is translated by Gemini."))}</p>`}
  </section>`;
}

const PARTNER_REPLIES = {
  en: ["Yes, I can hear you.", "Could you say that again?", "Thank you, that works."],
  es: ["Sí, te escucho.", "¿Puedes repetirlo?", "Gracias, me parece bien."],
  ru: ["Да, я вас слышу.", "Повторите, пожалуйста.", "Спасибо, всё понятно."],
  sv: ["Ja, jag hör dig.", "Kan du säga det igen?", "Tack, det fungerar."],
  ca: ["Sí, et sento.", "Pots repetir-ho?", "Gràcies, em va bé."]
};


function nextSend() {
  return state.mode.send === "voice" ? "text" : (state.mode.send === "text" ? "note" : "voice");
}
function sendLabel() {
  return state.mode.send === "text" ? tr("Text") : (state.mode.send === "note" ? tr("Tap to talk") : tr("Voice"));
}
function controlBar() {
  if (barFlagOn()) return newBar();
  const subsOn = state.mode.subtitles !== "off";
  const hears = state.mode.receive !== "text";
  return `<div class="calls-controls" data-essentials="mute speaker hangup talk">
    ${state.noMic ? cbtn("call-focus-type", "micOff", tr("No mic"), { cls: "off", aria: tr("No mic, type to talk") }) : cbtn("call-mute", state.muted ? "micOff" : "mic", state.muted ? tr("Unmute") : tr("Mute"), { cls: state.muted ? "off" : "", aria: state.muted ? tr("Unmute microphone") : tr("Mute microphone") })}
    ${cbtn("call-speaker", state.speakerOn ? "speaker" : "speakerOff", tr("Speaker"), { pressed: state.speakerOn })}
    ${cbtn("call-set", "captions", tr("Captions"), { pressed: subsOn, data: { group: "subtitles", value: subsOn ? "off" : "translated" } })}
    ${cbtn("call-set", state.mode.send === "text" ? "text" : (state.mode.send === "note" ? "note" : "voice"), sendLabel(), { aria: tr("I send") + ": " + sendLabel(), data: { group: "send", value: nextSend() } })}
    ${chatBtn()}
    ${cbtn("call-set", "translate", tr("Translation"), { pressed: hears, data: { group: "receive", value: hears ? "text" : "voice" } })}
    ${earSupported() ? cbtn("call-ear", "ear", tr("Ear mode"), { pressed: state.ear.on }) : ""}
    ${cbtn("call-more", "more", tr("More"), { pressed: state.panel === "settings" })}
    ${cbtn("call-end", "hangup", tr("Leave"), { cls: "end", aria: tr("End call") })}
  </div>`;
}
/* ---------- bottom bar with popovers (calls_bar) ----------
   Every in-call setting is a button on the bar. A button opens a small sheet
   right above the bar; on phones five buttons fit and the rest wait in a tray
   that a swipe up (or the handle) opens. Nothing here is new behaviour: the
   sheets reuse the same controls the Settings panel has. */
const POPS = ["mic", "lang", "subs", "sound", "invite", "tray"];
function chatBtn() {
  if (oneChatFlagOn()) return cbtn("call-conv", "chat", tr("Chat"), { pressed: state.conv !== false });
  return cbtn("call-panel", "chat", tr("Chat"), { pressed: state.panel === "chat", data: { value: state.panel === "chat" ? "" : "chat" } });
}
function popBtn(pop, icon, label, opt) {
  const o = opt || {};
  const open = state.pop === pop;
  return `<button type="button" class="cb${o.cls ? " " + o.cls : ""}${open ? " on" : ""}${o.extra ? " cb-extra" : ""}" data-act="call-pop" data-value="${pop}" aria-haspopup="dialog" aria-expanded="${open ? "true" : "false"}" aria-label="${esc(o.aria || label)}" title="${esc(o.aria || label)}">${ico(icon)}<span class="cb-l">${esc(label)}</span></button>`;
}
function newBar() {
  const subsOn = state.mode.subtitles !== "off";
  const sheet = barSheetFlagOn();
  const open = !!(sheet && state.barOpen);
  const micBtn = state.noMic
    ? cbtn("call-focus-type", "micOff", tr("No mic"), { cls: "off", aria: tr("No mic, type to talk") })
    : cbtn("call-mute", state.muted ? "micOff" : "mic", state.muted ? tr("Unmute") : tr("Mute"), { cls: state.muted ? "off" : "", aria: state.muted ? tr("Unmute microphone") : tr("Mute microphone") });
  const caret = sheet ? "" : `<button type="button" class="cb-caret cb-extra" data-act="call-pop" data-value="mic" aria-haspopup="dialog" aria-expanded="${state.pop === "mic" ? "true" : "false"}" aria-label="${esc(tr("Microphone and sending"))}" title="${esc(tr("Microphone and sending"))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  const handleLabel = sheet ? (open ? tr("Hide call controls") : tr("Show all controls")) : tr("More controls");
  const handle = sheet
    ? `<button type="button" class="calls-handle" data-act="call-bar-sheet" aria-label="${esc(handleLabel)}" aria-expanded="${open ? "true" : "false"}"><i></i></button>`
    : `<button type="button" class="calls-handle" data-act="call-pop" data-value="tray" aria-label="${esc(tr("More controls"))}" aria-expanded="${state.pop === "tray" ? "true" : "false"}"><i></i></button>`;
  const extras = sheet ? "" : `${popBtn("sound", state.speakerOn ? "speaker" : "speakerOff", tr("Sound"), { extra: true })}
    ${earSupported() ? cbtn("call-ear", "ear", tr("Ear mode"), { pressed: state.ear.on }).replace('class="cb', 'class="cb cb-extra') : ""}
    ${popBtn("invite", "link", tr("Invite"), { extra: true })}
    ${popBtn("tray", "more", tr("More"), { extra: true })}`;
  const more = sheet ? `<div class="calls-bar-sheet">${popTray()}</div>` : "";
  const main = `<span class="cb-split">${micBtn}${caret}</span>
    ${popBtn("lang", "translate", tr("Languages"))}
    ${popBtn("subs", "captions", tr("Captions"), { cls: subsOn ? "" : "dim" })}
    ${extras}
    ${chatBtn()}
    ${cbtn("call-end", "hangup", tr("Leave"), { cls: "end", aria: tr("End call") })}`;
  return `<div class="calls-controls calls-bar" data-essentials="mute speaker hangup talk" data-bar="1"${sheet ? ` data-sheet="1" data-open="${open ? "1" : "0"}"` : ""}>
    ${handle}
    ${sheet ? `<div class="calls-bar-main">${main}</div>` : main}
    ${more}
  </div>`;
}
function sheetShouldOpen(wasOpen, dy, threshold) {
  const t = threshold == null ? 36 : threshold;
  if (Math.abs(dy) < t) return !!wasOpen;
  return dy > 0;
}
function popTitle(pop) {
  return { mic: tr("Microphone and sending"), lang: tr("Languages"), subs: tr("Captions"), sound: tr("Sound"), invite: tr("Invite"), tray: tr("More") }[pop] || "";
}
function popLang() {
  const t = state.test;
  const theirs = peerLang();
  return `<label class="calls-vol"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
    <p class="calls-pop-row"><span>${esc(tr("They speak"))}</span><b>${esc(theirs ? langName(theirs) : tr("Detecting…"))}</b></p>
    ${t ? `<label class="calls-vol"><span>${esc(tr("Translate me into"))}</span><select data-act="call-test-lang">${langOptions(t.lang)}</select></label>${hearSwitch(t)}` : ""}`;
}
function popSubs() {
  return `<div class="calls-modes" role="group" aria-label="${esc(tr("Subtitles"))}">
      ${pill("subtitles", "off", state.mode.subtitles, tr("Subtitles off"))}
      ${pill("subtitles", "translated", state.mode.subtitles, tr("Translation subtitles"))}
      ${pill("subtitles", "original", state.mode.subtitles, tr("Original subtitles"))}
      ${pill("subtitles", "both", state.mode.subtitles, tr("Original and translation"))}
    </div>
    <h3>${esc(tr("Caption size"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("Caption size"))}">
      ${CAP_SIZES.map((z) => `<button type="button" class="calls-pill${state.capSize === z ? " on" : ""}" data-act="call-capsize" data-value="${z}" aria-pressed="${state.capSize === z ? "true" : "false"}">${esc(z === "s" ? tr("Small") : z === "m" ? tr("Medium") : z === "l" ? tr("Large") : tr("Extra large"))}</button>`).join("")}
    </div>`;
}
function popSound() {
  return `<div class="calls-modes">
      <button type="button" class="calls-pill${state.speakerOn ? " on" : ""}" data-act="call-speaker" aria-pressed="${state.speakerOn ? "true" : "false"}">${esc(tr("Speaker"))}</button>
    </div>
    <h3>${esc(tr("I hear"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("I hear"))}">
      ${pill("receive", "voice", state.mode.receive, tr("Voice"))}
      ${pill("receive", "text", state.mode.receive, tr("Text"))}
      ${pill("receive", "both", state.mode.receive, tr("Both"))}
    </div>
    ${state.test ? hearSwitch(state.test) : ""}
    ${slider("trvol", tr("Translation volume"))}
    ${slider("original", tr("Original volume"))}
    ${slider("overall", tr("Call volume"))}
    ${earSupported() ? earSection() : ""}`;
}
function popMic() {
  const mc = state.micCheck;
  const line = mc ? tr("Microphone works. Say something to see the bar move.") : state.micNote || (state.noMic ? tr("No microphone is on for this call. You can still type to talk.") : "");
  return `<div class="calls-modes">
      ${state.noMic ? `<button type="button" class="calls-pill on" data-act="call-allowmic">${esc(tr("Allow microphone"))}</button>` : `<button type="button" class="calls-pill${state.muted ? " on" : ""}" data-act="call-mute" aria-pressed="${state.muted ? "true" : "false"}">${esc(state.muted ? tr("Unmute") : tr("Mute"))}</button>`}
      ${state.noMic ? "" : `<button type="button" class="calls-pill${mc ? " on" : ""}" data-act="call-checkmic" aria-pressed="${mc ? "true" : "false"}">${esc(mc ? tr("Microphone on") : tr("Check my microphone"))}</button>`}
    </div>
    <span class="calls-meter" aria-hidden="true"><i data-meter style="width:${mc ? Math.round(Math.min(1, mc.level * 4) * 100) : 0}%"></i></span>
    ${line ? `<p class="calls-privacy" role="status">${esc(line)}</p>` : ""}
    <h3>${esc(tr("I send"))}</h3>
    <div class="calls-modes" role="group" aria-label="${esc(tr("I send"))}">
      ${pill("send", "voice", state.mode.send, tr("Voice"))}
      ${pill("send", "text", state.mode.send, tr("Text"))}
      ${pill("send", "note", state.mode.send, tr("Tap to talk"))}
    </div>`;
}
function popInvite() {
  const me = tr("You");
  const them = state.peerName || tr("Guest");
  const link = state.inviteUrl
    ? `${qrBlock(state.inviteUrl)}${qrFlagOn() ? `<p class="calls-privacy calls-qrhint">${esc(tr("Scan with a phone camera to join as a guest."))}</p>` : ""}<div class="calls-invite"><input readonly value="${esc(state.inviteUrl)}" aria-label="${esc(tr("Guest link"))}" data-invite><button type="button" data-act="call-copy">${esc(tr("Copy link"))}</button>${navigator.share ? `<button type="button" data-act="call-share">${esc(tr("Share"))}</button>` : ""}</div>`
    : `<p class="calls-privacy">${esc(tr("This call has no guest link."))}</p>`;
  return `<ul class="calls-people"><li>${esc(me)}</li>${state.statusCode === "waiting" ? "" : `<li>${esc(them)}</li>`}</ul>${link}`;
}
function trayTile(act, icon, label, data, on) {
  const d = data ? Object.keys(data).map((k) => ` data-${k}="${esc(data[k])}"`).join("") : "";
  return `<button type="button" class="calls-tilebtn${on ? " on" : ""}" data-act="${act}"${d}>${ico(icon)}<span>${esc(label)}</span></button>`;
}
function popTray() {
  const tiles = [
    trayTile("call-pop", "mic", tr("Microphone and sending"), { value: "mic" }),
    trayTile("call-pop", state.speakerOn ? "speaker" : "speakerOff", tr("Sound"), { value: "sound" }),
    earSupported() ? trayTile("call-ear", "ear", tr("Ear mode")) : "",
    state.test ? trayTile("call-test-hear", "voice", tr("Hear my translation"), null, state.test.hear) : "",
    trayTile("call-pop", "link", tr("Invite"), { value: "invite" }),
    trayTile("call-repeat", "note", tr("Repeat that")),
    state.test ? trayTile("call-panel", "test", tr("Test partner"), { value: "test" }) : "",
    state.test ? trayTile("call-test-info", "info", tr("Call details"), null, state.testInfo) : "",
    trayTile("call-more", "settings", tr("All settings"))
  ].join("");
  return `<div class="calls-tiles">${tiles}</div>`;
}
function popBlock() {
  if (!barFlagOn() || !state.pop || POPS.indexOf(state.pop) < 0) return "";
  const body = { mic: popMic, lang: popLang, subs: popSubs, sound: popSound, invite: popInvite, tray: popTray }[state.pop]();
  return `<div class="calls-pop${state.pop === "tray" ? " tray" : ""}${state.popAnim ? " fresh" : ""}" data-pop="${state.pop}" role="dialog" aria-label="${esc(popTitle(state.pop))}">
    <header><b>${esc(popTitle(state.pop))}</b><button type="button" class="calls-x" data-act="call-pop" data-value="" aria-label="${esc(tr("Close"))}">${ico("close")}</button></header>
    <div class="calls-pop-body">${body}</div>
  </div>`;
}
/* A tap anywhere outside the open sheet and the bar closes the sheet. */
function popOutside(e) {
  if (!state.pop || !e.target || !e.target.closest) return;
  if (e.target.closest(".calls-pop, .calls-controls")) return;
  state.pop = "";
  paint();
}
/* On phones a swipe up on the bar opens the tray, a swipe down closes it.
   With calls_bar_sheet the bar itself is the sheet and follows the finger. */
let barSwipe = null;
let barDrag = null;
function clearBarDrag() {
  if (!barDrag) return;
  const bar = barDrag.bar;
  const sheet = bar && bar.querySelector && bar.querySelector(".calls-bar-sheet");
  if (sheet) { sheet.style.maxHeight = ""; sheet.style.opacity = ""; }
  if (bar && bar.removeAttribute) bar.removeAttribute("data-dragging");
  barDrag = null;
}
function syncBarSheetSize() {
  const bar = document.querySelector(".calls-bar[data-sheet='1']");
  if (bar) document.documentElement.style.setProperty("--calls-bar-h", bar.offsetHeight + "px");
  else document.documentElement.style.removeProperty("--calls-bar-h");
}
function barDown(e) {
  if (!barFlagOn() || !e.target || !e.target.closest) { barSwipe = null; barDrag = null; return; }
  const bar = e.target.closest(".calls-bar, .calls-pop.tray");
  if (!bar) { barSwipe = null; return; }
  if (barSheetFlagOn() && bar.classList.contains("calls-bar")) {
    const onHandle = !!e.target.closest(".calls-handle");
    const onBtn = !!e.target.closest(".cb, .calls-tilebtn, .cb-caret, input, select, a, .calls-x");
    barDrag = { y: e.clientY, x: e.clientX, open: !!state.barOpen, fromHandle: onHandle, fromBtn: onBtn && !onHandle, moved: false, bar: bar };
    try { if (e.pointerId != null && bar.setPointerCapture) bar.setPointerCapture(e.pointerId); } catch (err) { /* capture is optional */ }
    return;
  }
  barSwipe = { y: e.clientY, tray: !!e.target.closest(".calls-pop.tray") };
}
function barMove(e) {
  if (!barDrag) return;
  const dx = e.clientX - barDrag.x;
  const dyRaw = e.clientY - barDrag.y;
  const dy = barDrag.y - e.clientY;
  if (!barDrag.moved) {
    if (Math.abs(dyRaw) < 10 && Math.abs(dx) < 10) return;
    if (Math.abs(dx) > Math.abs(dyRaw) && !barDrag.fromHandle) return;
    if (barDrag.fromBtn && Math.abs(dyRaw) < 16) return;
    barDrag.moved = true;
    barDrag.bar.dataset.dragging = "1";
  }
  const sheet = barDrag.bar.querySelector(".calls-bar-sheet");
  if (!sheet) return;
  const full = sheet.scrollHeight;
  const base = barDrag.open ? full : 0;
  const h = Math.max(0, Math.min(full, base + dy));
  sheet.style.maxHeight = h + "px";
  sheet.style.opacity = full ? String(h / full) : "0";
  syncBarSheetSize();
}
function barUp(e) {
  if (barDrag) {
    const d = barDrag;
    const dy = d.y - (e && e.clientY != null ? e.clientY : d.y);
    const moved = d.moved;
    clearBarDrag();
    if (!barSheetFlagOn()) return;
    if (moved) {
      const want = sheetShouldOpen(d.open, dy);
      if (want !== !!state.barOpen) { state.barOpen = want; swallowClickAt = Date.now(); paint(); }
      else syncBarSheetSize();
    }
    return;
  }
  const sw = barSwipe;
  barSwipe = null;
  if (!sw || !barFlagOn() || barSheetFlagOn()) return;
  const dy = e.clientY - sw.y;
  if (dy < -36 && state.pop !== "tray") { state.pop = "tray"; swallowClickAt = Date.now(); paint(); }
  else if (dy > 36 && state.pop) { state.pop = ""; swallowClickAt = Date.now(); paint(); }
}
function setPop(name) {
  state.pop = state.pop === name ? "" : (POPS.indexOf(name) >= 0 ? name : "");
  state.popAnim = !!state.pop;
  if (state.pop !== "mic" && state.micCheck && state.phase === "active") stopMicCheck();
  paint();
  state.popAnim = false;
}

function panelBlock() {
  if (state.panel === "chat" && oneChatFlagOn()) state.panel = "";
  if (!state.panel) return "";
  const tabs = oneChatFlagOn() ? [["settings", tr("Settings")]] : [["chat", tr("Chat")], ["settings", tr("Settings")]];
  if (state.test) tabs.push(["test", tr("Test partner")]);
  const head = `<header class="calls-phead"><div class="calls-tabs" role="tablist">${tabs.map((row) => `<button type="button" role="tab" class="calls-tab${state.panel === row[0] ? " on" : ""}" aria-selected="${state.panel === row[0] ? "true" : "false"}" data-act="call-panel" data-value="${row[0]}">${esc(row[1])}</button>`).join("")}</div><button type="button" class="calls-x" data-act="call-panel" data-value="" aria-label="${esc(tr("Close"))}">${ico("close")}</button></header>`;
  let body = "";
  if (state.panel === "settings") body = moreSheet();
  else if (state.panel === "test" && state.test) body = `<div class="calls-sheet">${testPanel()}</div>`;
  else {
    body = `<div class="calls-sheet calls-chat">${threadBlock()}${state.lines.length ? "" : `<p class="calls-empty">${esc(tr("Messages and what was said show up here."))}</p>`}</div>
      <form class="calls-type calls-compose" data-act="call-type-form">${previewCard()}<input name="text" maxlength="500" aria-label="${esc(tr("Type to them"))}" placeholder="${esc(tr("Type to them"))}" autocomplete="off"><button type="submit" class="cb send" aria-label="${esc(tr("Send"))}">${ico("outgoing")}</button></form>`;
  }
  return `<aside class="calls-panel${state.panelAnim ? " enter" : ""}" data-open="1" aria-label="${esc(tr(state.panel === "chat" ? "Chat" : "Settings"))}">${head}${body}</aside>`;
}

function callScreen() {
  const waiting = state.statusCode === "calling" || state.statusCode === "waiting";
  const name = state.peerName || (waiting ? "" : tr("Guest"));
  const shown = name || (state.statusCode === "waiting" ? tr("Waiting for them to join…") : tr("Calling…"));
  const mine = state.test ? tr("You") : tr("You");
  const invite = state.inviteUrl && state.statusCode === "waiting" ? `${qrBlock(state.inviteUrl)}<div class="calls-invite"><input readonly value="${esc(state.inviteUrl)}" aria-label="${esc(tr("Guest link"))}" data-invite><button type="button" data-act="call-copy">${esc(tr("Copy link"))}</button>${navigator.share ? `<button type="button" data-act="call-share">${esc(tr("Share"))}</button>` : ""}</div>` : "";
  const back = standalone() ? "" : "";
  const timer = state.startedAt ? clock(Date.now() - state.startedAt) : "";
  const noteBar = state.mode.send === "note" ? (state.review ? `<div class="calls-review"><button type="button" class="calls-go" data-act="call-note-send">${esc(tr("Send"))}</button><button type="button" data-act="call-note-cancel">${esc(tr("Cancel voice note"))}</button></div>` : `<button type="button" class="calls-talk" data-act="call-talk">${esc(state.recording ? tr("Slide to cancel") : tr("Hold to talk"))}</button>`) : "";
  const conv = convShown();
  const typeBar = !conv && (state.mode.send === "text" || state.noMic) && state.panel !== "chat" ? `<form class="calls-type calls-float" data-act="call-type-form">${previewCard()}<input name="text" maxlength="500" aria-label="${esc(tr("Type to them"))}" placeholder="${esc(tr("Type to them"))}" autocomplete="off"><button type="submit" class="cb send" aria-label="${esc(tr("Send"))}">${ico("outgoing")}</button></form>` : "";
  const nomic = state.noMic ? `<button type="button" class="calls-nomic" data-act="call-focus-type">${ico("micOff")}<span>${esc(tr("No mic, type to talk"))}</span></button>` : "";
  const hint = state.hintSeen ? "" : `<p class="calls-hint">${esc(tr("You can type instead of talking."))}</p>`;
  return `<div class="calls-page live" data-call-active="1" data-video="0" data-phase="${esc(state.phase)}" data-panel="${state.panel ? "1" : "0"}" data-conv="${conv ? "1" : "0"}"${onescreenFlagOn() ? " data-onescreen=\"1\"" : ""}">
    <header class="calls-top">
      <div class="calls-brand"><span class="calls-logo">${ico("phone")}</span><b>${esc(state.test ? tr("Test call") : tr("Calls"))}</b></div>
      <div class="calls-meta"><span class="calls-status" data-translating="${state.translating ? "1" : "0"}">${esc(statusText())}</span>${reconnectChip()}<span class="calls-timer">${esc(timer)}</span></div>
    </header>
    <main class="calls-stage">
      ${keyPanel()}
      ${invite}
      ${onescreenFlagOn() ? "" : (conv && !state.testInfo ? "" : testStrip())}
      <div class="calls-grid" >
        ${tile("peer", shown, peerLang(), state.speaking || state.translating)}
        ${tile("me", mine, myLang(), state.meSpeaking)}
      </div>
      ${onescreenFlagOn() ? stageChips() : ""}
      ${origVolRow()}
      ${onescreenFlagOn() && state.test && state.testInfo ? `<div class="calls-chips" data-testchips>${chipsHtml()}</div>` : ""}
      ${conv ? convBlock() : subtitleBlock()}
    </main>
    ${panelBlock()}
    ${nomic}${typeBar}${noteBar}${hint}
    ${popBlock()}
    ${controlBar()}
  </div>`;
}

function langPairLabel() {
  const from = String(myLang() || "").split("-")[0].toUpperCase();
  const toCode = peerLang() || (state.test && state.test.lang) || "";
  const to = String(toCode || "").split("-")[0].toUpperCase();
  return (from || "—") + " → " + (to || "…");
}
function origVolRow() {
  if (!origVolFlagOn()) return "";
  const on = !!state.mode.original;
  const name = "original";
  const value = Math.round((state.volumes[name] == null ? VOLUME_DEFAULTS[name] : state.volumes[name]) * 100);
  return `<div class="calls-origvol${on ? " on" : ""}" data-origvol="1">
    <button type="button" class="calls-schip${on ? " on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}" data-act="call-set" data-group="original" data-value="${on ? "0" : "1"}" title="${esc(tr("Hear their original voice, quietly"))}">${ico("speaker")}<span>${esc(tr("Original voice"))}</span></button>
    <label class="calls-origvol-s"><span>${esc(tr("Original volume"))}</span><input type="range" min="0" max="100" value="${value}" data-vol="original" aria-label="${esc(tr("Original volume"))}"><b data-origpct>${esc(String(value) + "%")}</b></label>
  </div>`;
}

function stageChips() {
  const subsOn = state.mode.subtitles !== "off";
  const hearOn = state.test ? !!state.test.hear : state.mode.receive !== "text";
  const hearLabel = state.test ? tr("Hear my translation") : tr("Hear translation");
  const hearBtn = state.test
    ? `<button type="button" class="calls-schip${hearOn ? " on" : ""}" role="switch" aria-checked="${hearOn ? "true" : "false"}" data-act="call-test-hear" title="${esc(tr("Hear my translation (use headphones)"))}">${ico("voice")}<span>${esc(hearLabel)}</span></button>`
    : `<button type="button" class="calls-schip${hearOn ? " on" : ""}" role="switch" aria-checked="${hearOn ? "true" : "false"}" data-act="call-set" data-group="receive" data-value="${hearOn ? "text" : "voice"}" title="${esc(hearLabel)}">${ico("translate")}<span>${esc(hearLabel)}</span></button>`;
  const ear = earSupported()
    ? `<button type="button" class="calls-schip${state.ear.on ? " on" : ""}" data-act="call-ear" aria-pressed="${state.ear.on ? "true" : "false"}" title="${esc(tr("Ear mode"))}">${ico("ear")}<span>${esc(tr("Ear mode"))}</span></button>`
    : "";
  const details = state.test
    ? `<button type="button" class="calls-schip${state.testInfo ? " on" : ""}" data-act="call-test-info" aria-pressed="${state.testInfo ? "true" : "false"}" title="${esc(tr("Call details"))}">${ico("info")}<span>${esc(tr("Call details"))}</span></button>`
    : "";
  return `<div class="calls-stagechips" role="toolbar" aria-label="${esc(tr("Call controls"))}">
    <button type="button" class="calls-schip" data-act="call-pop" data-value="lang" aria-haspopup="dialog" aria-expanded="${state.pop === "lang" ? "true" : "false"}" title="${esc(tr("Languages"))}"><span class="calls-spair">${esc(langPairLabel())}</span></button>
    <button type="button" class="calls-schip${subsOn ? " on" : ""}" data-act="call-pop" data-value="subs" aria-haspopup="dialog" aria-expanded="${state.pop === "subs" ? "true" : "false"}" title="${esc(tr("Captions"))}">${ico("captions")}<span>${esc(tr("Captions"))}</span></button>
    ${hearBtn}
    <button type="button" class="calls-schip${state.speakerOn ? " on" : ""}" data-act="call-speaker" aria-pressed="${state.speakerOn ? "true" : "false"}" title="${esc(tr("Speaker"))}">${ico(state.speakerOn ? "speaker" : "speakerOff")}<span>${esc(tr("Speaker"))}</span></button>
    ${ear}${details}${euProxyChip()}${translateRetryChip()}
  </div>`;
}
function translateRetryChip() {
  if (!state.turnFallback || (state.phase !== "active" && state.phase !== "calling" && !state.test)) return "";
  return `<button type="button" class="calls-schip on" data-act="call-translate-retry" title="${esc(tr("Live translation dropped. This call is translating one phrase at a time."))}">${esc(tr("Retry translation"))}</button>`;
}
function reconnectChip() {
  if (state.statusCode !== "lost") return "";
  return `<button type="button" class="calls-schip on" data-act="call-reconnect" data-reconnect title="${esc(tr("The connection was lost."))}">${esc(tr("Try again"))}</button>`;
}
function syncReconnectChip(el) {
  const root = el || host();
  if (!root) return;
  const meta = root.querySelector(".calls-meta");
  if (!meta) return;
  const existing = meta.querySelector("[data-reconnect]");
  const html = reconnectChip();
  if (!html) { if (existing) existing.remove(); return; }
  if (existing) { existing.outerHTML = html; return; }
  const timer = meta.querySelector(".calls-timer");
  if (timer) timer.insertAdjacentHTML("beforebegin", html);
  else meta.insertAdjacentHTML("beforeend", html);
}
function euProxyChip() {
  if (!euProxyFlagOn() || (state.phase !== "active" && state.phase !== "calling" && !state.test)) return "";
  const info = (state.partner && state.partner.mintInfo && state.partner.mintInfo()) || (state.engine && state.engine.mintInfo && state.engine.mintInfo()) || null;
  const on = !info || info.proxy === "eu" || info.prefer === "relay";
  if (!on && info) return "";
  return `<span class="calls-schip on" data-euproxy title="${esc(tr("Translation goes through the Worker. The API key stays off this page and is never logged."))}">${esc(tr("Routed in the EU"))}</span>`;
}
function chipsHtml() {
  const s = state.stats;
  const info = (state.partner && state.partner.mintInfo && state.partner.mintInfo()) || (state.engine && state.engine.mintInfo && state.engine.mintInfo()) || null;
  const t = state.test;
  const parts = [];
  const ms = (v) => (v == null ? "-" : tr("{ms} ms", { ms: Math.round(v) }));
  parts.push([tr("After you stop"), s ? ms(s.endLag) : "-"]);
  parts.push([tr("First translated sound"), s ? ms(s.firstAudio) : "-"]);
  parts.push([tr("Jitter"), s ? ms(s.jitter) : "-"]);
  parts.push([tr("Packets lost"), s && s.lost != null ? String(s.lost) : "-"]);
  if (latencyFlagOn()) latencyRows(s).slice(0, 3).forEach((row) => parts.push(row));
  if (s && s.turn) parts.push([tr("Translation"), tr("One phrase at a time")]);
  parts.push([tr("Route"), euProxyFlagOn() || (info && info.proxy === "eu") ? tr("Routed in the EU") : (s ? (s.route === "relay" ? tr("Through our server") : tr("Direct")) : "-")]);
  parts.push([tr("Per minute"), s && s.perMinute != null ? tr("{n} s of 32", { n: s.perMinute }) : "-"]);
  parts.push([tr("Translation"), !info ? tr("Starting…") : (info.ok && info.mode === "token" ? tr("Ready") : (state.needKey ? tr("Needs a Gemini key") : tr("Text only")))]);
  if (info && info.path) parts.push([tr("Path"), info.path === "live" ? tr("Live interpreter") : tr("Live Translate")]);
  if (info && info.source) parts.push([tr("Key"), info.source === "owner" ? tr("Owner") : tr("Yours")]);
  return parts.map((row) => `<span class="calls-chip"><i>${esc(row[0])}</i>${esc(row[1])}</span>`).join("");
}
/* One clear on/off switch, always on its own row at the top of the test controls, so it is never hidden or pushed off a narrow phone. */
function hearSwitch(t) {
  const on = !!(t && t.hear);
  return `<button type="button" class="calls-switch${on ? " on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}" data-act="call-test-hear" data-hear-switch title="${esc(tr("Hear my translation (use headphones)"))}"><span class="calls-switch-track" aria-hidden="true"><i></i></span><span class="calls-switch-label">${esc(tr("Hear my translation"))}</span><b class="calls-switch-state">${esc(on ? tr("On") : tr("Off"))}</b></button>`;
}
function testStrip() {
  if (!state.test) return "";
  const t = state.test;
  return `<div class="calls-teststrip" data-teststrip>
    <label class="calls-tl"><span>${esc(tr("Translate me into"))}</span><select data-act="call-test-lang">${langOptions(t.lang)}</select></label>
    ${hearSwitch(t)}
    <button type="button" class="cb sm calls-info${state.testInfo ? " on" : ""}" data-act="call-test-info" aria-pressed="${state.testInfo ? "true" : "false"}" aria-label="${esc(tr("Call details"))}" title="${esc(tr("Call details"))}">${ico("info")}</button>
    <div class="calls-chips" data-testchips${state.testInfo ? "" : " hidden"}>${chipsHtml()}</div>
    <p class="calls-privacy">${esc(tr("Speak and you hear your own words translated, with captions. Use headphones to avoid echo."))}</p>
  </div>`;
}
function incomingToast() {
  const who = state.incoming || {};
  const label = who.name || (who.handle ? "@" + who.handle : tr("Guest"));
  return `<div class="calls-toast" role="alertdialog" aria-live="assertive" aria-label="${esc(tr("Incoming call"))}">
    <div class="calls-ava sm">${esc(initialOf(label))}</div>
    <div class="calls-toast-text"><b>${esc(label)}</b><span>${esc(tr("is calling you"))}</span></div>
    <button type="button" class="cb accept" data-act="call-answer" aria-label="${esc(tr("Answer"))}" title="${esc(tr("Answer"))}">${ico("phone")}</button>
    <button type="button" class="cb end" data-act="call-decline" aria-label="${esc(tr("Decline"))}" title="${esc(tr("Decline"))}">${ico("hangup")}</button>
  </div>`;
}
function incomingScreen() {
  return homeScreen({ toast: true });
}

/* People from Contacts, offered under the start-a-call box. Only for signed-in accounts; guests never see them. */
function contactSuggestions(query) {
  if (!signedIn()) return [];
  let list = [];
  try { list = JSON.parse(localStorage.getItem("viktorych_contacts_v3") || "[]"); } catch (err) { list = []; }
  if (!Array.isArray(list)) return [];
  const q = String(query || "").replace(/^@/, "").trim().toLowerCase();
  const seen = {};
  return list.filter((c) => c && c.handle && !c.trashedAt).map((c) => ({
    handle: String(c.handle), star: !!c.favorite,
    name: ((c.first || "") + " " + (c.last || "")).trim() || c.company || "@" + c.handle
  })).filter((c) => {
    if (seen[c.handle]) return false;
    seen[c.handle] = true;
    return !q || c.handle.toLowerCase().indexOf(q) >= 0 || c.name.toLowerCase().indexOf(q) >= 0;
  }).sort((a, b) => Number(b.star) - Number(a.star) || a.name.localeCompare(b.name)).slice(0, 5);
}
function suggestionsHtml(query) {
  const list = contactSuggestions(query);
  if (!list.length) return "";
  return `<div class="calls-sugg" role="listbox" aria-label="${esc(tr("Contacts"))}">${list.map((c) => `<button type="button" class="calls-sugg-row" role="option" data-act="call-sugg" data-handle="${esc(c.handle)}"><span class="calls-ava sm">${esc(initialOf(c.name))}</span><span class="calls-sugg-t"><b>${esc(c.name)}</b><small>@${esc(c.handle)}</small></span>${ico("phone")}</button>`).join("")}</div>`;
}
function historyRows(tab) {
  const all = state.history;
  const list = all.filter((row) => tab !== "missed" || row.missed);
  if (!list.length) return `<p class="calls-empty">${esc(tab === "missed" ? tr("No missed calls.") : tr("No calls yet"))}</p>`;
  const sel = state.histSel;
  const bar = sel
    ? `<div class="calls-histbar sel"><button type="button" class="calls-link" data-act="hist-cancel">${esc(tr("Cancel"))}</button><span class="calls-histn">${esc(trn("callsSelected", sel.size))}</span><button type="button" class="calls-link" data-act="hist-all">${esc(tr("Select all"))}</button><button type="button" class="calls-pill danger" data-act="hist-delete"${sel.size ? "" : " disabled"}>${ico("trash", "tiny")}${esc(tr("Delete"))}</button></div>`
    : `<div class="calls-histbar"><button type="button" class="calls-link" data-act="hist-select">${esc(tr("Select"))}</button><button type="button" class="calls-link" data-act="hist-clear">${esc(tr("Clear all"))}</button></div>`;
  const rows = list.slice(0, 30).map((row) => {
    const label = (histEditFlagOn() && row.title) ? row.title : (row.name || (row.handle ? "@" + row.handle : tr("Guest")));
    const kind = row.missed ? tr("Missed call") : (row.incoming ? tr("Incoming call") : tr("Outgoing call"));
    const dur = row.duration ? " · " + clock(row.duration) : "";
    const noteMark = histEditFlagOn() && row.note ? " · " + tr("Note") : "";
    const transMark = histEditFlagOn() && (row.hasTranscript || (row.lines && row.lines.length)) ? " · " + tr("Transcript") : "";
    const picked = sel && sel.has(row.id);
    const lead = sel
      ? `<button type="button" class="calls-check${picked ? " on" : ""}" data-act="hist-pick" data-id="${esc(row.id)}" role="checkbox" aria-checked="${picked ? "true" : "false"}" aria-label="${esc(label)}">${picked ? ico("check", "tiny") : ""}</button>`
      : "";
    const open = !sel && histEditFlagOn() ? `<button type="button" class="calls-rowbody" data-act="hist-open" data-id="${esc(row.id)}" aria-label="${esc(tr("Open call details"))}"><div class="calls-ava sm">${esc(initialOf(label))}</div><div class="calls-rt"><b>${esc(label)}</b><span>${ico(row.incoming ? "incoming" : "outgoing", "tiny")}${esc(kind)} · ${esc(when(row.createdAt))}${esc(dur)}${esc(noteMark)}${esc(transMark)}</span></div></button>` : `<div class="calls-ava sm">${esc(initialOf(label))}</div><div class="calls-rt"><b>${esc(label)}</b><span>${ico(row.incoming ? "incoming" : "outgoing", "tiny")}${esc(kind)} · ${esc(when(row.createdAt))}${esc(dur)}</span></div>`;
    const back = !sel && row.handle ? `<button type="button" class="cb sm" data-act="call-back" data-handle="${esc(row.handle)}" aria-label="${esc(tr("Call back"))}" title="${esc(tr("Call back"))}">${ico("phone")}</button>` : "";
    const del = !sel ? `<button type="button" class="calls-rowx" data-act="hist-del" data-id="${esc(row.id)}" aria-label="${esc(tr("Remove from history"))}" title="${esc(tr("Remove from history"))}">${ico("close", "tiny")}</button>` : "";
    return `<li class="calls-row${row.missed ? " missed" : ""}${picked ? " picked" : ""}" data-id="${esc(row.id)}">${lead}${open}${back}${del}</li>`;
  }).join("");
  return bar + `<ul class="calls-list">${rows}</ul>`;
}

function histEditSheet() {
  const ed = state.histEdit;
  if (!histEditFlagOn() || !ed) return "";
  const err = ed.error ? `<p class="calls-error" role="alert">${esc(ed.error)}</p>` : "";
  const lines = (ed.lines || []).map((line, i) => {
    const lid = esc(line.id || String(i));
    return `<article class="calls-bubble${line.mine ? " mine" : ""}" data-line="${lid}">
      <b>${esc(line.who || (line.mine ? tr("You") : tr("Guest")))}${line.corrected ? ` · ${esc(tr("Corrected"))}` : ""}</b>
      <label class="calls-vol"><span>${esc(tr("Original"))}</span><textarea data-hist-orig="${lid}" rows="2" maxlength="500">${esc(line.original || "")}</textarea></label>
      <label class="calls-vol"><span>${esc(tr("Translation"))}</span><textarea data-hist-trn="${lid}" rows="2" maxlength="500">${esc(line.translation || "")}</textarea></label>
      <button type="button" class="calls-link" data-act="hist-correct" data-id="${lid}">${esc(tr("Save correction"))}</button>
    </article>`;
  }).join("");
  return `<section class="calls-histedit" data-histedit>
    <header class="calls-side-head"><h2>${esc(tr("Call details"))}</h2><button type="button" class="calls-x" data-act="hist-close" aria-label="${esc(tr("Close"))}">${ico("close")}</button></header>
    ${err}
    <p class="calls-privacy">${esc(ed.name || "")}</p>
    <label class="calls-vol"><span>${esc(tr("Name in your history"))}</span><input id="calls-hist-title" maxlength="80" value="${esc(ed.title || "")}"></label>
    <label class="calls-vol"><span>${esc(tr("Note"))}</span><textarea id="calls-hist-note" rows="3" maxlength="500">${esc(ed.note || "")}</textarea></label>
    <button type="button" class="calls-go" data-act="hist-save">${esc(tr("Save"))}</button>
    <h3>${esc(tr("Transcript"))}</h3>
    ${ed.loading ? `<p class="calls-empty">${esc(tr("Loading the transcript…"))}</p>` : (lines || `<p class="calls-empty">${esc(tr("No transcript was saved for this call."))}</p>`)}
    <p class="calls-privacy">${esc(tr("A rename, a note, or a correction is only for you. The other person keeps theirs."))}</p>
  </section>`;
}
async function openHistEdit(id) {
  if (!histEditFlagOn() || !id) return;
  const row = (state.history || []).find((item) => item.id === id) || { id: id, name: "", title: "", note: "", lines: [] };
  state.histEdit = { id: id, name: row.name || (row.handle ? "@" + row.handle : ""), title: row.title || "", note: row.note || "", lines: Array.isArray(row.lines) ? row.lines.slice() : [], loading: !!signedIn(), error: "" };
  paint();
  if (!signedIn()) return;
  const res = await api("/v1/calls/history/" + encodeURIComponent(id) + "/transcript").catch(() => null);
  if (!state.histEdit || state.histEdit.id !== id) return;
  if (res && res.status === 204) { state.histEdit.loading = false; paint(); return; }
  if (!res || !res.ok) { state.histEdit.loading = false; state.histEdit.error = errorFor(res); paint(); return; }
  state.histEdit.title = res.data.title != null ? res.data.title : state.histEdit.title;
  state.histEdit.note = res.data.note != null ? res.data.note : state.histEdit.note;
  state.histEdit.lines = Array.isArray(res.data.lines) ? res.data.lines : state.histEdit.lines;
  state.histEdit.loading = false;
  paint();
}
async function saveHistMeta() {
  const ed = state.histEdit;
  if (!ed) return;
  const title = ((document.getElementById("calls-hist-title") || {}).value || "").trim().slice(0, 80);
  const note = ((document.getElementById("calls-hist-note") || {}).value || "").trim().slice(0, 500);
  ed.title = title;
  ed.note = note;
  if (signedIn()) {
    const res = await api("/v1/calls/history/edit", { method: "POST", body: JSON.stringify({ id: ed.id, title: title, note: note }) }).catch(() => null);
    if (!res || !res.ok) { ed.error = errorFor(res); paint(); return; }
  } else {
    const rows = state.history.map((row) => row.id === ed.id ? Object.assign({}, row, { title: title, note: note }) : row);
    state.history = rows;
    try { localStorage.setItem("viktorych_calls_local_v1", JSON.stringify(rows.slice(0, 60))); } catch (err) { /* private mode */ }
  }
  const row = (state.history || []).find((item) => item.id === ed.id);
  if (row) { row.title = title; row.note = note; }
  paint();
}
async function saveHistCorrect(lineId) {
  const ed = state.histEdit;
  if (!ed || !lineId) return;
  const origEl = document.querySelector('[data-hist-orig="' + CSS.escape(lineId) + '"]');
  const trnEl = document.querySelector('[data-hist-trn="' + CSS.escape(lineId) + '"]');
  const original = origEl ? String(origEl.value || "").trim().slice(0, 500) : "";
  const translation = trnEl ? String(trnEl.value || "").trim().slice(0, 500) : "";
  if (signedIn()) {
    const res = await api("/v1/calls/history/" + encodeURIComponent(ed.id) + "/correct", { method: "POST", body: JSON.stringify({ lineId: lineId, original: original, translation: translation }) }).catch(() => null);
    if (!res || !res.ok) { ed.error = errorFor(res); paint(); return; }
    const next = res.data && res.data.line ? res.data.line : { id: lineId, original: original, translation: translation, corrected: true };
    ed.lines = (ed.lines || []).map((line) => line.id === lineId ? Object.assign({}, line, next) : line);
  } else {
    ed.lines = (ed.lines || []).map((line) => line.id === lineId ? Object.assign({}, line, { original: original, translation: translation, corrected: true }) : line);
    const rows = state.history.map((row) => row.id === ed.id ? Object.assign({}, row, { lines: ed.lines }) : row);
    state.history = rows;
    try { localStorage.setItem("viktorych_calls_local_v1", JSON.stringify(rows.slice(0, 60))); } catch (err) { /* private mode */ }
  }
  paint();
}
async function saveHistTranscript(id, lines) {
  if (!histEditFlagOn() || !id || !lines || !lines.length) return;
  const packed = lines.slice(-80).map((line) => ({
    id: String(line.id || ("l" + line.at + line.original)).slice(0, 64),
    at: Number(line.at) || Date.now(),
    who: String(line.who || ""),
    mine: !!line.mine,
    original: String(line.original || "").slice(0, 500),
    translation: String(line.translation || "").slice(0, 500)
  })).filter((line) => line.id && (line.original || line.translation));
  if (!packed.length) return;
  if (signedIn()) {
    await api("/v1/calls/history/transcript", { method: "POST", body: JSON.stringify({ id: id, lines: packed }) }).catch(() => null);
  } else {
    try {
      const raw = JSON.parse(localStorage.getItem("viktorych_calls_local_v1") || "[]");
      const rows = (Array.isArray(raw) ? raw : []).map((row) => row && row.id === id ? Object.assign({}, row, { lines: packed, hasTranscript: true }) : row);
      localStorage.setItem("viktorych_calls_local_v1", JSON.stringify(rows.slice(0, 60)));
    } catch (err) { /* private mode */ }
  }
}

/* ---- editing call history: one row, many rows, or all of it, with an undo ---- */
function histToast(text, token) {

  clearTimeout(state.histTimer);
  state.histUndo = token || null;
  let el = document.querySelector(".calls-undo");
  if (!el) { el = document.createElement("div"); el.className = "calls-undo"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  el.innerHTML = `<span>${esc(text)}</span>${token ? `<button type="button" data-hist-undo>${esc(tr("Undo"))}</button>` : ""}`;
  el.onclick = (e) => { if (e.target.closest && e.target.closest("[data-hist-undo]")) histUndo(); };
  state.histTimer = setTimeout(() => { state.histUndo = null; if (el.parentNode) el.parentNode.removeChild(el); }, 7000);
}
async function histRemove(ids) {
  let token = null;
  try { token = await hist.remove(ids); } catch (err) { state.history = hist.rows; paint(); histToast(tr("Could not update your history. Try again."), null); return; }
  state.history = hist.rows;
  state.histSel = null;
  paint();
  if (token) histToast(token.ids.length === 1 ? tr("Removed from your history") : trn("callsRemoved", token.ids.length), token);
}
async function histUndo() {
  const token = state.histUndo;
  state.histUndo = null;
  const el = document.querySelector(".calls-undo");
  if (el && el.parentNode) el.parentNode.removeChild(el);
  clearTimeout(state.histTimer);
  if (!token) return;
  await hist.restore(token);
  state.history = hist.rows;
  paint();
}
async function histClearAll() {
  let token = null;
  try { token = await hist.clear(); } catch (err) { state.history = hist.rows; paint(); histToast(tr("Could not update your history. Try again."), null); return; }
  state.history = hist.rows;
  state.histSel = null;
  paint();
  if (token) histToast(tr("Call history cleared"), token);
}
function histConfirm() {
  if (document.querySelector(".calls-mm-wrap")) return;
  const el = document.createElement("div");
  el.className = "calls-mm-wrap";
  el.innerHTML = `<div class="calls-mm" role="alertdialog" aria-modal="true" aria-labelledby="calls-hc-t"><h2 id="calls-hc-t">${esc(tr("Clear all calls?"))}</h2><p class="calls-mm-p">${esc(tr("This only removes them from your own history. The other person keeps theirs."))}</p><div class="calls-mm-btns"><button type="button" class="calls-go danger" data-hc="yes">${esc(tr("Clear all"))}</button><button type="button" class="calls-pill" data-hc="no">${esc(tr("Cancel"))}</button></div></div>`;
  const close = () => { document.removeEventListener("keydown", key, true); if (el.parentNode) el.parentNode.removeChild(el); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  document.addEventListener("keydown", key, true);
  el.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-hc]");
    if (t && t.dataset.hc === "yes") { close(); histClearAll(); }
    else if (t || e.target === el) close();
  });
  document.body.appendChild(el);
  const yes = el.querySelector('[data-hc="yes"]');
  if (yes) yes.focus();
}
/* Swipe a row left to remove it on a touch screen. */
let swipe = null;
function swipeDown(e) {
  if (e.pointerType !== "touch" || state.histSel) return;
  const row = e.target.closest && e.target.closest(".calls-list .calls-row");
  if (!row || e.target.closest("button")) return;
  swipe = { row: row, x: e.clientX, y: e.clientY, dx: 0, dy: 0, w: row.offsetWidth };
}
function swipeMove(e) {
  if (!swipe) return;
  swipe.dx = e.clientX - swipe.x;
  swipe.dy = e.clientY - swipe.y;
  if (Math.abs(swipe.dx) > 8 && Math.abs(swipe.dx) > Math.abs(swipe.dy)) swipe.row.style.transform = "translateX(" + Math.min(0, swipe.dx) + "px)";
}
function swipeUp() {
  if (!swipe) return;
  const sw = swipe;
  swipe = null;
  if (swipeAction(sw.dx, sw.dy, sw.w) === "delete") { sw.row.classList.add("gone"); histRemove([sw.row.dataset.id]); }
  else sw.row.style.transform = "";
}

/* Press and hold a history row (or right-click it) to start selecting with that row picked, and never show the browser's own
   menu on the Calls page, so holding Tap to talk or a row does not open Copy / Save as / Share. Text fields keep theirs. */
let hold = null;
const HOLD_MS = 480;
function holdClear() { if (hold) { clearTimeout(hold.timer); hold = null; } }
function startSelectWith(id) {
  if (!id || state.histSel || state.phase !== "idle") return;
  state.histSel = new Set([id]);
  try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) { /* no haptics here */ }
  paint();
}
function holdDown(e) {
  if (e.button > 0 || state.histSel || state.phase !== "idle") return;
  const row = e.target.closest && e.target.closest(".calls-list .calls-row");
  if (!row || e.target.closest("button, a, input")) return;
  holdClear();
  const id = row.dataset.id;
  hold = { x: e.clientX, y: e.clientY, fired: false, timer: setTimeout(() => { if (hold) { hold.fired = true; swallowClickAt = Date.now(); startSelectWith(id); } }, HOLD_MS) };
}
function holdMove(e) { if (hold && (Math.abs(e.clientX - hold.x) > 10 || Math.abs(e.clientY - hold.y) > 10)) holdClear(); }
let swallowClickAt = 0;
function holdClick(e) {
  if (swallowClickAt && Date.now() - swallowClickAt < 800 && e.target.closest && e.target.closest(".calls-page")) {
    swallowClickAt = 0;
    e.preventDefault();
    e.stopPropagation();
  }
}
function onContext(e) {
  const t = e.target;
  if (!t || !t.closest || !t.closest(".calls-page")) return;
  if (t.closest("input, textarea, select, [contenteditable='true']")) return;
  e.preventDefault();
  const row = t.closest(".calls-list .calls-row");
  if (row && !t.closest("button, a")) { swallowClickAt = Date.now(); startSelectWith(row.dataset.id); }
}


function localWhen(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
}
function defaultWhen() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setMinutes(0, 0, 0);
  return localWhen(d.getTime());
}
function downloadIcs(row) {
  const who = (row && (row.name || (row.handle ? "@" + row.handle : ""))) || "";
  const title = (row && row.title) || (who ? tr("Call with {name}", { name: who }) : tr("Scheduled call"));
  const url = row && row.invite ? guestUrl(row.invite) : "";
  const body = icsForSchedule({ title: title, description: (row && row.note) || "", startsAt: row && row.startsAt, durationMin: row && row.durationMin, url: url, uid: (row && row.id) || "" });
  const blob = new Blob([body], { type: "text/calendar" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = "call.ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}
function scheduleLabel(row) {
  return (row && row.title) || (row && row.name) || (row && row.handle ? "@" + row.handle : "") || (row && row.hostName) || tr("Guest");
}
function rsvpLabel(value) {
  if (value === "yes") return tr("Going");
  if (value === "no") return tr("Not going");
  return tr("Awaiting reply");
}
function scheduleFormHtml() {
  const handle = state.schedHandle || "";
  const durs = [15, 30, 45, 60, 120];
  const opts = durs.map((n) => `<option value="${n}"${n === DEFAULT_DURATION ? " selected" : ""}>${esc(n === 60 ? tr("1 hour") : n === 120 ? tr("2 hours") : tr("{n} minutes", { n: String(n) }))}</option>`).join("");
  return `<form class="calls-sched-form" data-act="call-sched-form">
      <label>${esc(tr("Date and time"))}<input name="when" type="datetime-local" required value="${esc(defaultWhen())}" aria-label="${esc(tr("Date and time"))}"></label>
      <label>${esc(tr("Duration"))}<select name="duration">${opts}</select></label>
      <label>${esc(tr("Username to call"))}<input name="handle" maxlength="31" value="${esc(handle)}" placeholder="${esc(tr("Username to call"))}" aria-label="${esc(tr("Username to call"))}" autocomplete="off" autocapitalize="off"></label>
      <label>${esc(tr("Title (optional)"))}<input name="title" maxlength="80" aria-label="${esc(tr("Title (optional)"))}"></label>
      <label>${esc(tr("Note (optional)"))}<textarea name="note" maxlength="280" aria-label="${esc(tr("Note (optional)"))}"></textarea></label>
      <p class="calls-sched-note">${esc(tr("No username needed. Share the invite link with a guest."))}</p>
      <p class="calls-sched-note">${esc(tr("On iPhone, install the app to get a reminder if you don't add it to your calendar."))}</p>
      <div class="calls-sched-actions">
        <button type="submit" class="calls-go">${esc(tr("Create scheduled call"))}</button>
        <button type="button" class="calls-link" data-act="call-sched-hide">${esc(tr("Cancel"))}</button>
      </div>
    </form>`;
}
function scheduleRows() {
  if (!scheduleFlagOn()) return `<p class="calls-empty">${esc(tr("No scheduled calls yet."))}</p>`;
  const list = (state.schedules || []).filter((row) => row && row.state !== "cancelled" && row.state !== "missed");
  const past = (state.schedules || []).filter((row) => row && (row.state === "cancelled" || row.state === "missed"));
  if (!list.length && !past.length) return `<p class="calls-empty">${esc(tr("No scheduled calls yet."))}</p>`;
  const item = (row) => {
    const label = scheduleLabel(row);
    const whenText = when(row.startsAt);
    const status = row.state === "cancelled" ? tr("Cancelled") : (row.state === "missed" ? tr("Missed call") : (row.canJoin ? tr("It's time for your scheduled call") : rsvpLabel(row.role === "peer" ? row.myRsvp : row.theirRsvp)));
    const join = row.canJoin ? `<button type="button" class="cb sm" data-act="call-sched-join" data-id="${esc(row.id)}" aria-label="${esc(tr("Join scheduled call"))}" title="${esc(tr("Join scheduled call"))}">${ico("phone")}</button>` : "";
    const rsvp = row.canRsvp ? `<button type="button" class="calls-link" data-act="call-sched-rsvp" data-id="${esc(row.id)}" data-value="yes">${esc(tr("Yes, I'll be there"))}</button><button type="button" class="calls-link" data-act="call-sched-rsvp" data-id="${esc(row.id)}" data-value="no">${esc(tr("Can't make it"))}</button>` : "";
    const cal = `<button type="button" class="calls-link" data-act="call-sched-ics" data-id="${esc(row.id)}">${esc(tr("Add to calendar"))}</button>`;
    const copy = row.invite ? `<button type="button" class="calls-link" data-act="call-sched-copy" data-id="${esc(row.id)}">${esc(tr("Copy link"))}</button>` : "";
    const cancel = row.canCancel ? `<button type="button" class="calls-link" data-act="call-sched-cancel" data-id="${esc(row.id)}">${esc(tr("Cancel"))}</button>` : "";
    return `<li class="calls-row${row.canJoin ? " due" : ""}" data-id="${esc(row.id)}"><div class="calls-ava sm">${esc(initialOf(label))}</div><div class="calls-rt"><b>${esc(label)}</b><span>${esc(whenText)} · ${esc(status)}</span><div class="calls-sched-actions">${join}${rsvp}${cal}${copy}${cancel}</div></div></li>`;
  };
  const living = list.length ? `<ul class="calls-list">${list.map(item).join("")}</ul>` : `<p class="calls-empty">${esc(tr("No scheduled calls yet."))}</p>`;
  const old = past.length ? `<p class="calls-sched-note">${esc(tr("Ended or cancelled"))}</p><ul class="calls-list">${past.slice(0, 8).map(item).join("")}</ul>` : "";
  return living + old + `<p class="calls-sched-note">${esc(tr("On iPhone, install the app to get a reminder if you don't add it to your calendar."))}</p>`;
}
function scheduleToast() {
  const row = state.schedToast || {};
  const label = scheduleLabel(row);
  return `<div class="calls-toast sched" role="alertdialog" aria-live="assertive" aria-label="${esc(tr("It's time for your scheduled call"))}">
    <div class="calls-ava sm">${esc(initialOf(label))}</div>
    <div class="calls-toast-text"><b>${esc(label)}</b><span>${esc(tr("is starting"))}</span></div>
    <button type="button" class="cb accept" data-act="call-sched-join" data-id="${esc(row.id || "")}" aria-label="${esc(tr("Join scheduled call"))}" title="${esc(tr("Join scheduled call"))}">${ico("phone")}</button>
    <button type="button" class="cb end" data-act="call-sched-later" aria-label="${esc(tr("Later"))}" title="${esc(tr("Later"))}">${ico("close")}</button>
  </div>`;
}
function scheduleJoinScreen(route) {
  const err = state.error ? `<p class="calls-error" role="alert">${esc(state.error)}</p>` : "";
  const row = state.schedGuest;
  const back = standalone() ? "" : `<a class="calls-back" href="#/calls" aria-label="${esc(tr("Back"))}">${ico("back")}</a>`;
  if (!row) {
    return `<div class="calls-page calls-home${standalone() ? " calls-solo" : ""}" data-video="0" data-phase="idle">
      <section class="calls-main">${back}<h1>${esc(tr("Scheduled call"))}</h1>${err || `<p class="calls-empty">${esc(tr("This scheduled call is over."))}</p>`}</section>
    </div>`;
  }
  const label = row.hostName || (row.hostHandle ? "@" + row.hostHandle : scheduleLabel(row));
  const whenText = when(row.startsAt);
  const status = row.state === "cancelled" ? tr("This scheduled call was cancelled.") : (row.state === "missed" || (!row.canJoin && row.startsAt && row.startsAt + (row.durationMin || 30) * 60000 < Date.now()) ? tr("This scheduled call is over.") : (row.canJoin ? tr("It's time for your scheduled call") : tr("You can join from 10 minutes before the start time.")));
  const join = row.canJoin ? `<button type="button" class="calls-go" data-act="call-sched-guest-join">${esc(tr("Join scheduled call"))}</button>` : "";
  const ended = state.statusCode === "ended" ? `<p class="calls-empty">${esc(tr("The call has ended."))}</p>` : "";
  return `<div class="calls-page calls-home${standalone() ? " calls-solo" : ""}" data-video="0" data-phase="idle">
    <section class="calls-main">
      ${back}
      <h1>${esc(tr("Scheduled call"))}</h1>
      ${err}${ended}
      <p><b>${esc(label)}</b></p>
      <p>${esc(whenText)}</p>
      <p class="calls-privacy">${esc(status)}</p>
      ${signedIn() ? "" : `<form class="calls-start" data-act="call-sched-name"><input id="calls-name" name="name" maxlength="40" value="${esc(state.name || "")}" placeholder="${esc(tr("Your name"))}" aria-label="${esc(tr("Your name"))}"><button type="submit" class="calls-go">${esc(tr("Save"))}</button></form>`}
      <div class="calls-sched-actions">${join}<button type="button" class="calls-big ghost" data-act="call-sched-guest-ics">${ico("link")}<span>${esc(tr("Add to calendar"))}</span></button></div>
      <p class="calls-sched-note">${esc(tr("On iPhone, install the app to get a reminder if you don't add it to your calendar."))}</p>
    </section>
  </div>`;
}
async function loadSchedules() {
  if (!scheduleFlagOn() || !signedIn()) { state.schedules = []; return; }
  const res = await api("/v1/calls/schedule").catch(() => null);
  if (res && res.ok && res.data) state.schedules = res.data.schedules || [];
  const due = (state.schedules || []).find((row) => row && row.canJoin && (row.state === "scheduled" || row.state === "started"));
  if (due && state.phase === "idle" && !state.incoming) state.schedToast = due;
  else if (state.schedToast && !(state.schedules || []).some((row) => row.id === state.schedToast.id && row.canJoin)) state.schedToast = null;
  if (host() && state.phase === "idle") paint();
}
async function loadGuestSchedule(token) {
  if (!SCHEDULE_TOKEN.test(token)) { state.schedGuest = null; state.error = tr("This scheduled call is over."); if (host()) paint(); return; }
  const res = await api("/v1/calls/schedule/guest?token=" + encodeURIComponent(token)).catch(() => null);
  state.schedGuest = res && res.ok && res.data ? res.data.schedule : null;
  if (!res || !res.ok) state.error = state.error || errorFor(res);
  if (host()) paint();
}
async function createSchedule(fields) {
  state.schedBusy = true;
  state.error = "";
  const startsAt = Date.parse(fields.when);
  const body = {
    startsAt: startsAt,
    durationMin: clipDuration(fields.duration),
    handle: String(fields.handle || "").replace(/^@/, "").trim(),
    title: String(fields.title || "").trim(),
    note: String(fields.note || "").trim()
  };
  const res = await api("/v1/calls/schedule", { method: "POST", body: JSON.stringify(body) }).catch(() => null);
  state.schedBusy = false;
  if (!res || !res.ok) { state.error = errorFor(res) || tr("Could not schedule that call. Try again."); paint(); return; }
  const row = res.data && res.data.schedule;
  state.schedForm = false;
  state.tab = "scheduled";
  if (row) downloadIcs(row);
  await loadSchedules();
  paint();
}
async function rsvpSchedule(id, value) {
  const res = await api("/v1/calls/schedule/" + encodeURIComponent(id) + "/rsvp", { method: "POST", body: JSON.stringify({ rsvp: value }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res) || tr("Could not update that scheduled call. Try again."); paint(); return; }
  await loadSchedules();
}
async function cancelSchedule(id) {
  if (!window.confirm(tr("Cancel this scheduled call?"))) return;
  const res = await api("/v1/calls/schedule/" + encodeURIComponent(id) + "/cancel", { method: "POST", body: "{}" }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res) || tr("Could not update that scheduled call. Try again."); paint(); return; }
  await loadSchedules();
}
function copyScheduleLink(id) {
  const row = (state.schedules || []).find((r) => r.id === id);
  if (!row || !row.invite) return;
  const url = guestUrl(row.invite);
  try { navigator.clipboard.writeText(url); } catch (err) { /* the person can copy from the address */ }
}
async function beginScheduled(res, fallbackName) {
  if (!res || !res.ok || !res.data || !res.data.call) {
    state.error = (res && errorFor(res)) || tr("Could not start that call. Try again.");
    paint();
    return;
  }
  state.schedToast = null;
  if (res.data.guestToken) state.guestToken = res.data.guestToken;
  state.peerName = fallbackName || "";
  state.statusCode = "calling";
  const role = res.data.guestToken || res.data.guestId ? "guest" : "host";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, role);
  if (ok && role === "guest") rememberGuestSession(res.data.guestExpiresAt);
  if (ok && state.engine && role === "host") state.engine.prewarm();
}
async function joinScheduled(id) {
  const row = (state.schedules || []).find((r) => r.id === id) || state.schedToast;
  state.error = "";
  const res = await api("/v1/calls/schedule/" + encodeURIComponent(id) + "/start", { method: "POST", body: "{}" }).catch(() => null);
  await beginScheduled(res, row && scheduleLabel(row));
}
async function joinScheduledGuest() {
  const token = (state.route && state.route.token) || "";
  const typed = (document.getElementById("calls-name") || {}).value;
  state.name = String(typed || state.name || tr("Guest")).slice(0, 40);
  saveDevice();
  state.error = "";
  if (await maybeUseStoredGuest({ name: "callschedule", token: token })) return;
  const res = await api("/v1/calls/schedule/guest/start", { method: "POST", body: JSON.stringify({ token: token, name: state.name }) }).catch(() => null);
  await beginScheduled(res, state.schedGuest && (state.schedGuest.hostName || state.schedGuest.hostHandle));
}


function rotateQrPanel() {
  if (!rotateQrFlagOn() || !signedIn()) return "";
  const row = state.rotateQr;
  const url = row && row.token ? guestUrl(row.token) : "";
  if (url) loadQr();
  const svg = url ? qrSvg(url) : "";
  return `<section class="calls-rotateqr" data-rotateqr>
    <h3>${esc(tr("Scan to call me"))}</h3>
    <div class="calls-qr" role="img" aria-label="${esc(tr("Rotating QR code to call me"))}">${svg || `<span class="calls-empty">${esc(tr("Loading the QR code…"))}</span>`}</div>
    <p class="calls-privacy">${esc(tr("This code refreshes every two minutes. When someone scans it, it rings you like an incoming call."))}</p>
    ${url ? `<div class="calls-invite"><input readonly value="${esc(url)}" aria-label="${esc(tr("Guest link"))}" data-rotateqr-link><button type="button" data-act="call-rotate-copy">${esc(tr("Copy link"))}</button></div>` : ""}
  </section>`;
}
function armRotateQrRefresh(expiresAt) {
  clearTimeout(state.rotateQrTimer);
  const wait = Math.max(5000, (Number(expiresAt) || 0) - Date.now() - ROTATE_REFRESH_MS);
  state.rotateQrTimer = setTimeout(() => { loadRotateQr(); }, wait);
}
async function loadRotateQr() {
  if (!rotateQrFlagOn() || !signedIn()) { state.rotateQr = null; return; }
  const res = await api("/v1/calls/qr").catch(() => null);
  if (res && res.ok && res.data && res.data.token) {
    state.rotateQr = { token: res.data.token, expiresAt: res.data.expiresAt };
    armRotateQrRefresh(res.data.expiresAt);
  } else if (res && res.status === 204) {
    state.rotateQr = null;
  }
  if (host() && state.phase === "idle") paint();
}
async function joinRotateQr(tokenValue) {
  state.error = "";
  const typed = (document.getElementById("calls-name") || {}).value;
  state.name = String(typed || state.name || tr("Guest")).slice(0, 40);
  saveDevice();
  if (await maybeUseStoredGuest({ name: "callguest", token: tokenValue })) return;
  const res = await api("/v1/calls/qr/join", { method: "POST", body: JSON.stringify({ token: tokenValue, name: state.name }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.guestToken = res.data.guestToken || "";
  state.statusCode = "calling";
  state.peerName = (res.data && res.data.name) || "";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "guest");
  if (!ok) return;
  rememberGuestSession(res.data.guestExpiresAt);
  if (state.engine) state.engine.prewarm();
  const id = res.data.call.id;
  state.ringPoll = setInterval(async () => {
    if (state.phase !== "calling" || state.callId !== id) { clearInterval(state.ringPoll); return; }
    const st = await api("/v1/calls/" + id + "/state").catch(() => null);
    if (st && st.ok && st.data && st.data.ended) { clearInterval(state.ringPoll); state.error = tr("No answer."); await hangUp(); }
  }, 2500);
}

function homeScreen(opts) {
  const o = opts || {};
  const back = standalone() ? "" : `<a class="calls-back" href="#/" aria-label="${esc(tr("Back"))}">${ico("back")}</a>`;
  const err = state.error ? `<p class="calls-error" role="alert">${esc(state.error)}</p>` : "";
  const notSet = state.configured ? "" : `<p class="calls-empty">${esc(tr("Calls are not set up yet"))}</p>`;
  const signed = signedIn();
  const savedGuest = !signed && guestSessionLive(readStoredGuestSession()) ? readStoredGuestSession() : null;
  const rejoin = savedGuest ? `<button type="button" class="calls-big join" data-act="call-rejoin">${ico("phone")}<span>${esc(state.resuming ? tr("Rejoining…") : tr("Rejoin this call"))}</span></button>` : "";
  const tab = state.tab || "recent";
  const tabs = [["recent", tr("Recent")], ["missed", tr("Missed")], ["scheduled", tr("Scheduled")]];
  const list = tab === "scheduled" ? scheduleRows() : historyRows(tab);
  const side = `<aside class="calls-side">
    <header class="calls-side-head">${back}<span class="calls-logo">${ico("phone")}</span><h1>${esc(tr("Calls"))}</h1></header>
    <div class="calls-tabs" role="tablist" aria-label="${esc(tr("Calls"))}">${tabs.map((row) => `<button type="button" role="tab" class="calls-tab${tab === row[0] ? " on" : ""}" aria-selected="${tab === row[0] ? "true" : "false"}" data-act="call-tab" data-value="${row[0]}">${esc(row[1])}</button>`).join("")}</div>
    ${list}
  </aside>`;
  const start = signed ? `<section class="calls-hero">
      <h2>${esc(tr("Start a call"))}</h2>
      <form class="calls-start" data-act="call-start-form"><input name="handle" maxlength="31" placeholder="${esc(tr("Username to call"))}" aria-label="${esc(tr("Username to call"))}" autocomplete="off" autocapitalize="off"><button type="submit" class="calls-go">${ico("phone")}<span>${esc(tr("Call"))}</span></button></form>
      <div data-sugg>${suggestionsHtml("")}</div>
      <div class="calls-hero-row">
        <button type="button" class="calls-big" data-act="call-invite">${ico("link")}<span>${esc(tr("Get call link"))}</span></button>
        <button type="button" class="calls-big ghost" data-act="call-test">${ico("test")}<span>${esc(tr("Test call"))}</span></button>
        ${practiceFlagOn() ? `<button type="button" class="calls-big ghost" data-act="call-practice">${ico("voice")}<span>${esc(tr("Practice with AI"))}</span></button>` : ""}
        ${scheduleFlagOn() ? `<button type="button" class="calls-big ghost" data-act="call-sched-open">${ico("link")}<span>${esc(tr("Schedule a call"))}</span></button>` : ""}
      </div>
      <div class="calls-modes" role="group" aria-label="${esc(tr("Link lasts"))}">${pill("ttl", "60", String(state.inviteTtl), tr("1 hour"))}${pill("ttl", "1440", String(state.inviteTtl), tr("24 hours"))}</div>
      ${scheduleFlagOn() && state.schedForm ? scheduleFormHtml() : ""}
      ${rotateQrPanel()}
    </section>
    ${linkPanel()}`
    : `<section class="calls-hero"><h2>${esc(tr("Call someone"))}</h2>
      <p class="calls-empty">${esc(tr("Sign in to start a call, or open a guest link to join one."))}</p>
      ${standalone() ? `<form class="calls-start" data-act="call-open-form"><input name="link" maxlength="200" placeholder="${esc(tr("Link or name"))}" aria-label="${esc(tr("Call someone with their link"))}" autocomplete="off" autocapitalize="off" spellcheck="false"><button type="submit" class="calls-go">${esc(tr("Open"))}</button></form>
      <p class="calls-privacy">${esc(tr("A link or a name is all you need. No account."))}</p>
      <p class="calls-privacy"><a href="./" data-signin>${esc(tr("Sign in on the app"))}</a></p>` : ""}
    </section>`;
  return `<div class="calls-page calls-home${standalone() ? " calls-solo" : ""}" data-video="0" data-phase="${o.toast ? "incoming" : "idle"}">
    ${o.toast ? incomingToast() : (state.schedToast && scheduleFlagOn() && state.phase === "idle" ? scheduleToast() : "")}
    ${side}
    <section class="calls-main">
      ${histEditFlagOn() && state.histEdit ? histEditSheet() : ""}
      ${notSet}${err}${rejoin}${start}
      <label class="calls-vol calls-homelang"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
      ${installBlock()}
    </section>
  </div>`;
}

/* One line that says where the mic check stands. No microphone is fine: the call still starts. */
function setupMicStatus() {
  if (state.micCheck) return { ok: true, text: tr("Microphone works. Say something to see the bar move.") };
  if (state.micNote) return { ok: false, text: state.micNote };
  return { ok: false, text: tr("Check your microphone, or join without one and type to talk.") };
}
function joinScreen(route) {
  const err = state.error ? `<p class="calls-error" role="alert">${esc(state.error)}</p>` : "";
  const info = route && (route.name === "calllink" || (route.name === "callguest" && ROTATE_TOKEN.test(route.token || ""))) && state.linkInfo ? state.linkInfo : null;
  const title = info && info.name ? tr("Call {name}", { name: info.name }) : tr("Join call");
  const closed = info && info.open === false ? `<p class="calls-error" role="alert">${esc(info.reason === "quiet" ? tr("They are not taking calls right now.") : tr("This person is not taking calls right now."))}</p>` : "";
  const ended = state.statusCode === "ended" ? `<p class="calls-empty">${esc(tr("The call has ended."))}</p>` : "";
  const mc = state.micCheck;
  const setupOn = setupFlagOn();
  const setupMic = setupMicStatus();
  return `<div class="calls-page calls-join${standalone() ? " calls-solo" : ""}${setupOn ? " calls-setup" : ""}" data-phase="join" data-video="0">
    <header class="calls-top"><div class="calls-brand"><span class="calls-logo">${ico("phone")}</span><b>${esc(tr("Calls"))}</b></div></header>
    <div class="calls-prejoin">
      <div class="calls-preview">
        <div class="calls-tile" data-tile="me" data-speaking="${mc && mc.level > 0.06 ? "1" : "0"}">
          <div class="calls-ava me">${esc(initialOf(state.name || "?"))}</div>
          ${waveBars()}
          <div class="calls-tag"><span class="calls-tname">${esc(state.name || tr("You"))}</span></div>
          <div class="calls-tlang">${langBadge(myLang())}</div>
        </div>
        <div class="calls-checks">
          <button type="button" class="cb${mc ? " on" : ""}" data-act="call-checkmic" aria-pressed="${mc ? "true" : "false"}">${ico("mic")}<span class="cb-l">${esc(mc ? tr("Microphone on") : tr("Check microphone"))}</span></button>
          <span class="calls-meter" aria-hidden="true"><i data-meter style="width:${mc ? Math.round(Math.min(1, mc.level * 4) * 100) : 0}%"></i></span>
          <button type="button" class="cb" data-act="call-checkspk">${ico("speaker")}<span class="cb-l">${esc(tr("Test speaker"))}</span></button>
        </div>
        ${setupOn ? `<p class="calls-setupmic${setupMic.ok ? " ok" : ""}" role="status">${esc(setupMic.text)}</p>` : micNoteHtml()}
      </div>
      <div class="calls-joinform">
        <h1>${esc(title)}</h1>
        ${ended}${closed}${err}
        ${state.resuming ? `<p class="calls-privacy" role="status">${esc(tr("Rejoining…"))}</p>` : ""}
        <label class="calls-vol"><span>${esc(tr("Your name"))}</span><input id="calls-name" maxlength="40" value="${esc(state.name)}" autocomplete="name"></label>
        <label class="calls-vol"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
        <div class="calls-vol"><span>${esc(tr("I hear"))}</span><div class="calls-modes" role="group" aria-label="${esc(tr("I hear"))}">${pill("receive", "voice", state.mode.receive, tr("Voice"))}${pill("receive", "text", state.mode.receive, tr("Text"))}${pill("receive", "both", state.mode.receive, tr("Both"))}</div></div>
        <button type="button" class="calls-big join" data-act="call-join"${info && info.open === false || state.resuming ? " disabled" : ""}>${ico("phone")}<span>${esc(guestSessionForRoute(readStoredGuestSession(), route) ? tr("Rejoin this call") : (info ? tr("Call") : tr("Join now")))}</span></button>
        <p class="calls-privacy">${esc(tr("No account needed. Your microphone is used only during the call."))}</p>
        ${standalone() ? installBlock() : ""}
      </div>
    </div>
  </div>`;
}

/* Microphone and speaker check before joining. The mic stays open only on this screen. */
/* No microphone is never a blocker: the call starts, and typing is translated and spoken. */
function focusType() {
  setTimeout(() => {
    const el = document.querySelector(".calls-page .calls-float input[name=text], .calls-page .calls-compose input[name=text]");
    if (el) { try { el.focus(); } catch (err) { /* no focus */ } }
  }, 60);
}
function micNoteHtml() {
  if (!state.micNote) return "";
  return `<p class="calls-micnote" role="status">${esc(state.micNote)} <button type="button" class="calls-link" data-act="call-checkmic">${esc(tr("Try the microphone again"))}</button></p>`;
}
/* ---------- Allow microphone popup ---------- */
/* An in-app, X-style modal. The primary button calls getUserMedia straight from the click so the browser's own
   prompt opens at once. When the browser has blocked the mic it shows the exact steps for that browser, rechecks by
   itself when the permission changes, and always offers to carry on and type. It never blocks joining. */
let micModal = null;
function micBrowser() {
  const ua = String((typeof navigator !== "undefined" && navigator.userAgent) || "");
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\//.test(ua) || /FxiOS/.test(ua)) return "firefox";
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|CriOS/.test(ua)) return "safari";
  return "chrome";
}
function micArt(kind, browser) {
  const bar = '<rect x="6" y="8" width="228" height="30" rx="15" fill="var(--c-card)" stroke="var(--c-line)"/><circle cx="24" cy="23" r="6" fill="none" stroke="var(--c-muted)" stroke-width="2"/><rect x="40" y="19" width="120" height="8" rx="4" fill="var(--c-line)"/>';
  if (kind === "none") {
    return `<svg viewBox="0 0 240 110" aria-hidden="true">${bar}<g transform="translate(96 46)" fill="none" stroke="var(--c-muted)" stroke-width="3" stroke-linecap="round"><rect x="16" y="0" width="16" height="30" rx="8"/><path d="M8 24c0 10 7 17 16 17s16-7 16-17M24 41v10"/><path d="M4 56L44 -4" stroke="var(--c-red, #f4212e)"/></g></svg>`;
  }
  const hot = kind === "denied";
  const icon = hot
    ? `<circle cx="24" cy="23" r="12" fill="none" stroke="var(--c-blue)" stroke-width="2.5"/>`
    : "";
  const rows = hot
    ? `<rect x="22" y="48" width="196" height="46" rx="12" fill="var(--c-card)" stroke="var(--c-line)"/><rect x="34" y="62" width="70" height="8" rx="4" fill="var(--c-muted)"/><rect x="34" y="78" width="40" height="6" rx="3" fill="var(--c-line)"/><rect x="154" y="60" width="52" height="26" rx="13" fill="var(--c-blue)"/><text x="180" y="77" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">Allow</text>`
    : `<rect x="22" y="48" width="196" height="54" rx="12" fill="var(--c-card)" stroke="var(--c-line)"/><rect x="34" y="58" width="120" height="8" rx="4" fill="var(--c-muted)"/><rect x="104" y="76" width="50" height="18" rx="9" fill="none" stroke="var(--c-line)"/><rect x="162" y="76" width="46" height="18" rx="9" fill="var(--c-blue)"/><text x="185" y="89" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">Allow</text>`;
  return `<svg viewBox="0 0 240 110" aria-hidden="true" data-browser="${browser}">${bar}${icon}${rows}</svg>`;
}
function micInstalled() {
  try {
    if (navigator.standalone === true) return true;
    return !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  } catch (err) { return false; }
}
function micSteps(browser, platform) {
  const back = tr("Come back here: it continues by itself, or reload the page.");
  if (platform === "android-app") return [tr("Press and hold the app icon, then tap App info."), tr("Tap Permissions, then Microphone, and choose Allow."), back];
  if (platform === "android") return [tr("Tap the icon left of the address bar, then Permissions."), tr("Set Microphone to Allow."), back];
  if (platform === "ios") return [tr("Open Settings, then Safari, then Microphone."), tr("Choose Ask or Allow."), tr("Reopen this app, then tap Try again.")];
  if (browser === "firefox") return [tr("Click the blocked-permission icon in the address bar."), tr("Next to Use the Microphone, remove the Blocked setting."), back];
  if (browser === "safari") return [tr("Open the Safari menu, then Settings for This Website."), tr("Set Microphone to Allow."), back];
  return [tr("Click the site settings icon left of the address bar."), tr("Open Microphone and choose Allow."), back];
}
function micModalHtml() {
  const m = micModal;
  const kind = m.kind;
  const title = kind === "denied" ? tr("Microphone is blocked") : kind === "none" ? tr("No microphone found") : kind === "busy" ? tr("Microphone is busy") : tr("Allow microphone");
  const body = kind === "denied" ? (m.os ? tr("The phone is blocking the microphone for this app. Allow it in Settings, then come back here.") : tr("Your browser is blocking the microphone for this site. Allow it, then come back here."))
    : kind === "none" ? tr("Plug in or turn on a microphone, then try again.")
    : kind === "busy" ? tr("Another app may be using the microphone, or it could not start. Close other apps that use it, then try again.")
    : (m.dismissed ? tr("You closed the permission prompt. Tap Allow microphone and choose Allow.") : tr("Your browser will ask for permission. Choose Allow so the other person can hear you."));
  const showSteps = kind === "denied" || (m.slow && kind === "prompt");
  const steps = showSteps ? `<ol class="calls-mm-steps">${micSteps(m.browser, m.platform).map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : "";
  const again = m.again ? `<p class="calls-mm-again" role="status">${esc(tr("Still blocked. Follow the steps above."))}</p>` : "";
  const slow = m.slow && kind === "prompt" ? `<p class="calls-mm-again" role="status">${esc(tr("No prompt appeared? The permission may be blocked. Follow the steps below."))}</p>` : "";
  const primary = m.pending ? tr("Waiting for permission…") : kind === "prompt" && !m.slow ? tr("Allow microphone") : tr("Try again");
  return `<div class="calls-mm" role="dialog" aria-modal="true" aria-labelledby="calls-mm-t" data-kind="${kind}">
    <button type="button" class="calls-mm-x" data-mm="continue" aria-label="${esc(tr("Close"))}">${ico("close")}</button>
    <div class="calls-mm-art">${micArt(kind === "busy" ? "none" : kind, m.browser)}</div>
    <h2 id="calls-mm-t">${esc(title)}</h2>
    <p class="calls-mm-p">${esc(body)}</p>${slow}${steps}${again}
    <div class="calls-mm-btns">
      <button type="button" class="calls-go" data-mm="allow"${m.pending ? " disabled" : ""}>${esc(primary)}</button>
      <button type="button" class="calls-pill" data-mm="continue">${esc(tr("Continue without mic (type to talk)"))}</button>
    </div></div>`;
}
function micModalPaint() {
  if (!micModal || !micModal.el) return;
  micModal.el.innerHTML = micModalHtml();
  const btn = micModal.el.querySelector('[data-mm="allow"]');
  if (btn) { try { btn.focus(); } catch (err) { /* no focus */ } }
}
function closeMicModal() {
  const m = micModal;
  if (!m) return;
  micModal = null;
  try { if (m.status) m.status.onchange = null; } catch (err) { /* gone */ }
  if (m.el && m.el.parentNode) m.el.parentNode.removeChild(m.el);
  document.removeEventListener("keydown", m.key, true);
  if (m.back && m.back.focus) { try { m.back.focus(); } catch (err) { /* gone */ } }
}
function micGranted(stream, holder) {
  const m = holder || micModal;
  const src = m ? m.src : "prejoin";
  if (m && m.slowTimer) clearTimeout(m.slowTimer);
  if (micModal === m) closeMicModal();
  if (src === "call" && state.engine && state.engine.attachMic) {
    state.engine.attachMic(stream).then(() => {
      state.noMic = "";
      state.muted = false;
      state.engine.setMuted(false);
      applyMode({ send: "voice" });
      saveDevice();
      paint();
    });
    return;
  }
  try { stream.getTracks().forEach((track) => track.stop()); } catch (err) { /* stopped */ }
  state.noMic = "";
  state.micNote = "";
  if (!state.micCheck) checkMic(); else paint();
}
/* Called from the click handler. getUserMedia must be the first thing that runs so the native prompt shows. */
function micAsk() {
  const holder = micModal;
  if (!holder || holder.pending) return;
  holder.pending = true;
  holder.slow = false;
  let pending;
  try { pending = navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch (err) { pending = Promise.reject(err); }
  /* A prompt that never shows (blocked by the phone, or swallowed) must not look like a dead button. */
  holder.slowTimer = setTimeout(() => { if (micModal === holder && holder.pending) { holder.pending = false; holder.slow = true; micMount(holder); micModalPaint(); } }, 8000);
  if (holder.el) micModalPaint();
  pending.then((stream) => {
    holder.pending = false;
    micGranted(stream, holder);
  }, async (err) => {
    clearTimeout(holder.slowTimer);
    holder.pending = false;
    if (micModal !== holder) return;
    const perm = await micPermission();
    const f = micFailure(err, perm);
    holder.again = f.kind === "denied" && holder.kind === "denied";
    holder.kind = f.kind;
    holder.os = f.os;
    holder.dismissed = f.dismissed;
    holder.slow = false;
    micMount(holder);
    micModalPaint();
  });
}
async function micPermission() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const status = await navigator.permissions.query({ name: "microphone" });
      return status.state;
    }
  } catch (err) { /* not supported here */ }
  return "unknown";
}
/* Put the popup on screen. It is built once, even when the first step ran with no popup yet. */
function micMount(holder) {
  if (holder.el || micModal !== holder || typeof document === "undefined") return;
  const el = document.createElement("div");
  el.className = "calls-mm-wrap";
  el.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest("[data-mm]") : null;
    if (t) {
      if (t.dataset.mm === "allow") micAsk();
      else { const wasCall = holder.src === "call"; closeMicModal(); if (wasCall || state.noMic) focusType(); }
    } else if (e.target === el) { closeMicModal(); }
  });
  holder.key = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeMicModal(); } };
  document.addEventListener("keydown", holder.key, true);
  holder.el = el;
  document.body.appendChild(el);
}
/* Back from the phone's Settings (or another tab): if the microphone is allowed now, carry on by itself. */
function micRecheck() {
  const m = micModal;
  if (!m || !m.el || m.pending || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
  micPermission().then((perm) => { if (micModal === m && perm === "granted" && !m.pending) micAsk(); });
}
async function openMicModal(src, err) {
  if (typeof document === "undefined") return;
  if (micModal) {
    /* A leftover step that never got a popup must not block the next tap. */
    if (!micModal.el && !micModal.pending) closeMicModal(); else return;
  }
  const browser = micBrowser();
  const platform = micPlatform(navigator.userAgent, micInstalled());
  const holder = { src: src, browser: browser, platform: platform, kind: "prompt", again: false, os: false, dismissed: false, pending: false, slow: false, el: null, status: null, back: document.activeElement, key: null };
  micModal = holder;
  let perm = "unknown";
  let status = null;
  try {
    if (navigator.permissions && navigator.permissions.query) { status = await navigator.permissions.query({ name: "microphone" }); perm = status.state; }
  } catch (e) { /* not supported here */ }
  if (micModal !== holder) return;
  let inputs = true;
  try {
    const list = navigator.mediaDevices && navigator.mediaDevices.enumerateDevices ? await navigator.mediaDevices.enumerateDevices() : [];
    inputs = list.some((d) => d.kind === "audioinput") || browser === "safari";
  } catch (e) { /* assume a device exists */ }
  if (micModal !== holder) return;
  if (err) {
    /* The caller already tried and failed: say why, never retry silently. */
    const f = micFailure(err, perm);
    holder.kind = f.kind; holder.os = f.os; holder.dismissed = f.dismissed;
  } else if (perm === "granted" && inputs) {
    /* Already allowed: nothing to explain, just pick the mic up. A failure shows the popup. */
    if (src === "call") micAsk();
    else { closeMicModal(); if (setupFlagOn() && !state.micCheck && !state.noMic) checkMic(); }
    return;
  } else {
    holder.kind = perm === "denied" ? "denied" : !inputs ? "none" : "prompt";
  }
  holder.status = status;
  micMount(holder);
  micModalPaint();
  /* Allowed in the browser settings while the popup is open: carry on by itself. */
  if (status) status.onchange = () => {
    if (!micModal || micModal !== holder) return;
    if (status.state === "granted") micAsk();
    else if (status.state === "denied") { holder.kind = "denied"; holder.os = false; micModalPaint(); }
  };
}
function maybePrejoinMic() {
  if (state.micAsked || micModal || state.phase !== "idle") return;
  const r = state.route || {};
  if (!(state.testPrep || r.name === "callguest" || r.name === "calllink")) return;
  state.micAsked = true;
  openMicModal("prejoin");
}
async function checkMic() {
  if (state.micCheck) { stopMicCheck(); paint(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const mc = { stream: stream, ac: ac, level: 0, raf: 0, last: 0 };
    state.micCheck = mc;
    state.micNote = "";
    const tick = (now) => {
      if (state.micCheck !== mc) return;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      mc.level = Math.sqrt(sum / buf.length);
      const bar = document.querySelector("[data-meter]");
      if (bar) bar.style.width = Math.round(Math.min(1, mc.level * 4) * 100) + "%";
      const t = document.querySelector(".calls-join .calls-tile");
      if (t) t.dataset.speaking = mc.level > 0.06 ? "1" : "0";
      mc.raf = requestAnimationFrame(tick);
    };
    mc.raf = requestAnimationFrame(tick);
    paint();
  } catch (err) {
    const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
    state.micNote = denied ? tr("The microphone is blocked. You can still join and type to talk.") : tr("No mic found, you can type to talk.");
    paint();
    openMicModal(state.phase === "active" ? "call" : "prejoin", err);
  }
}
function stopMicCheck() {
  const mc = state.micCheck;
  if (!mc) return;
  state.micCheck = null;
  try { cancelAnimationFrame(mc.raf); } catch (err) { /* gone */ }
  try { mc.stream.getTracks().forEach((track) => track.stop()); } catch (err) { /* stopped */ }
  try { mc.ac.close(); } catch (err) { /* closed */ }
}
function checkSpeaker() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const gain = ac.createGain();
    gain.gain.value = 0.0001;
    gain.connect(ac.destination);
    [523.25, 659.25, 783.99].forEach((hz, i) => {
      const osc = ac.createOscillator();
      osc.frequency.value = hz;
      osc.connect(gain);
      const t0 = ac.currentTime + i * 0.22;
      osc.start(t0);
      osc.stop(t0 + 0.2);
    });
    const now = ac.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.05);
    gain.gain.setValueAtTime(0.18, now + 0.62);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.7);
    setTimeout(() => { try { ac.close(); } catch (err) { /* closed */ } }, 1200);
  } catch (err) { /* no audio output here */ }
}

function linkUrl(slug) {
  const base = standalone() ? new URL("./", location.href) : new URL("calls/", document.baseURI);
  return base.href + "#u/" + slug;
}
function linkPanel() {
  const l = state.link;
  const err = state.linkError ? `<p class="calls-error" role="alert">${esc(state.linkError)}</p>` : "";
  if (!l) return `<section class="calls-link" data-link><h3>${esc(tr("My call-me link"))}</h3><p class="calls-privacy">${esc(tr("A link that stays the same. Anyone who opens it can ring you, if your call settings allow it."))}</p>${err}<button type="button" class="calls-pill" data-act="call-link-create">${esc(tr("Create my call-me link"))}</button></section>`;
  return `<section class="calls-link" data-link><h3>${esc(tr("My call-me link"))}</h3>
    <div class="calls-invite"><input readonly value="${esc(linkUrl(l.slug))}" aria-label="${esc(tr("Call-me link"))}" data-invite><button type="button" data-act="call-link-copy">${esc(tr("Copy link"))}</button>${navigator.share ? `<button type="button" data-act="call-link-share">${esc(tr("Share"))}</button>` : ""}</div>
    ${l.enabled ? "" : `<p class="calls-privacy">${esc(tr("This link is turned off."))}</p>`}
    ${err}
    <div class="calls-modes">
      <button type="button" class="calls-pill" data-act="call-link-toggle">${esc(l.enabled ? tr("Turn off") : tr("Turn on"))}</button>
      <button type="button" class="calls-pill" data-act="call-link-regen">${esc(tr("Make a new link"))}</button>
      <button type="button" class="calls-pill" data-act="call-link-del">${esc(tr("Delete link"))}</button>
    </div>
    <form class="calls-lex" data-act="call-link-form"><input name="slug" maxlength="30" placeholder="${esc(tr("Custom name, like my-name"))}" aria-label="${esc(tr("Custom link name"))}" autocomplete="off" autocapitalize="off"><button type="submit">${esc(tr("Save"))}</button></form>
    <p class="calls-privacy">${esc(tr("Your quiet hours, blocks and who-can-call settings still apply. Turning the link off or making a new one stops the old link at once."))}</p>
  </section>`;
}

function installBlock() {
  if (!standalone()) {
    const href = new URL("calls/", document.baseURI).href;
    return `<p class="calls-empty"><a href="${esc(href)}" target="_blank" rel="noopener">${esc(tr("Open the ViktorychCalls app"))}</a></p>`;
  }
  const name = installName();
  return `<section class="calls-install" data-install>
    <label class="calls-vol"><span>${esc(tr("App name"))}</span><input data-act="call-pwa-name" maxlength="30" value="${esc(name)}" aria-label="${esc(tr("App name"))}"></label>
    <button type="button" class="calls-go" data-act="call-install"${installCan() ? "" : " hidden"}>${esc(tr("Install app"))}</button>
    <p class="calls-privacy" data-ios${iosDevice() ? "" : " hidden"}>${esc(tr("On iPhone: Share, then Add to Home Screen. The name above is filled in for you."))}</p>
  </section>`;
}
function installCan() {
  return !!(window.ViktorychCallsInstall && window.ViktorychCallsInstall.can && window.ViktorychCallsInstall.can());
}
function iosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function installName() {
  try { return localStorage.getItem("viktorych-calls-pwa-name") || "ViktorychCalls"; }
  catch (err) { return "ViktorychCalls"; }
}




function page(route) {
  loadDevice();
  state.route = route || state.route;
  const r = state.route || { name: "calls" };
  if (state.phase === "incoming") return incomingScreen();
  if (state.testPrep && state.phase === "idle") return testPrepScreen();
  if (state.phase === "active" || state.phase === "calling") return callScreen();
  if (r.name === "callguest" || r.name === "calllink") return joinScreen(r);
  if (r.name === "callschedule") return scheduleJoinScreen(r);
  return homeScreen();
}

/* ---------- painting ---------- */
function host() { return document.querySelector(".calls-page"); }
function paint() {
  const el = host();
  if (!el || !el.parentElement) return;
  const focus = document.activeElement;
  const keep = focus && focus.name && el.contains(focus) ? { name: focus.name, value: focus.value } : null;
  const sheet = el.querySelector(".calls-sheet");
  const scroll = sheet ? sheet.scrollTop : 0;
  const convBody = el.querySelector(".calls-convbody");
  const convStick = !convBody || convBody.scrollHeight - convBody.scrollTop - convBody.clientHeight < 60;
  const convTop = convBody ? convBody.scrollTop : 0;
  const popEl = el.querySelector(".calls-pop");
  const popScroll = popEl ? popEl.scrollTop : 0;
  el.outerHTML = page(state.route);
  const fresh = host();
  if (keep && fresh) {
    const input = fresh.querySelector(`input[name="${keep.name}"]`);
    if (input) { input.value = keep.value; input.focus(); }
  }
  const sheetNow = fresh && fresh.querySelector(".calls-sheet");
  if (sheetNow) sheetNow.scrollTop = scroll;
  const convNow = fresh && fresh.querySelector(".calls-convbody");
  if (convNow) convNow.scrollTop = convStick ? convNow.scrollHeight : convTop;
  const popNow = fresh && fresh.querySelector(".calls-pop");
  if (popNow && popScroll) popNow.scrollTop = popScroll;
  bindSession(state.phase === "active");
  holdWake(state.phase === "active");
  if (state.phase === "active") startOrientation();
  maybePrejoinMic();
  syncBarSheetSize();
}
/* Cheap updates while a call runs: no full repaint, so typing keeps focus. */
function live() {
  const el = host();
  if (!el || state.phase === "idle") return;
  earTick();
  const subs = el.querySelector(".calls-subs");
  if (subs) subs.outerHTML = subtitleBlock();
  const convThreadEl = el.querySelector(".calls-convbody .calls-thread");
  if (convThreadEl) {
    const body = convThreadEl.parentElement;
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    convThreadEl.outerHTML = convThread();
    const empty = body.querySelector(".calls-empty");
    if (empty && (state.lines.length || (state.partial && (state.partial.original || state.partial.translation)))) empty.remove();
    if (stick) body.scrollTop = body.scrollHeight;
  }
  const thread = convThreadEl ? null : el.querySelector(".calls-thread");
  if (thread && !thread.closest(".calls-test")) thread.outerHTML = threadBlock();
  const status = el.querySelector(".calls-status");
  if (status) { status.textContent = statusText(); status.dataset.translating = state.translating ? "1" : "0"; }
  syncReconnectChip(el);
  const peerTile = el.querySelector('[data-tile="peer"]');
  if (peerTile) peerTile.dataset.speaking = state.speaking || state.translating ? "1" : "0";
  const meTile = el.querySelector('[data-tile="me"]');
  if (meTile) meTile.dataset.speaking = state.meSpeaking ? "1" : "0";
  const timer = el.querySelector(".calls-timer");
  if (timer) timer.textContent = state.startedAt ? clock(Date.now() - state.startedAt) : "";
  const quota = el.querySelector("[data-quota]");
  if (quota) quota.textContent = quotaLine();
  const test = el.querySelector("[data-test]");
  if (test && state.test) {
    const box = test.querySelector(".calls-thread");
    if (box) box.innerHTML = state.test.lines.slice(-6).map((line) => bubbleHtml(line, {})).join("");
  }
}
function paintStats() {
  const el = host();
  const box = el && el.querySelector("[data-stats]");
  if (box) box.outerHTML = statsBlock();
  const chips = el && el.querySelector("[data-testchips]");
  if (chips) chips.innerHTML = chipsHtml();
}

/* Floating call window: starts with an active call, opens when the page is hidden, closes on return and at hang-up. */
let pip = null;
let pipBound = false;
function pipInfo() {
  return { name: state.peerName || tr("Guest"), time: state.startedAt ? clock(Date.now() - state.startedAt) : "", muted: state.muted, test: !!state.test, mutedText: tr("Muted"), testText: tr("Test call"), liveText: tr("Translating") };
}
function pipOn(active) {
  if (!active || !pipFlagOn()) { if (pip) { pip.stop(); pip = null; } return; }
  if (!pip) pip = createPip({ info: pipInfo });
  if (pip.supported && !pip.active) pip.start();
  if (!pipBound) {
    pipBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!pip || state.phase !== "active") return;
      if (document.visibilityState === "hidden") pip.enter();
      else pip.exit();
    });
  }
}
async function bindSession(active) {
  pipOn(active);
  const ms = navigator.mediaSession;
  if (!ms) return;
  try {
    if (!active) { ms.playbackState = "none"; return; }
    const icon = new URL(standalone() ? "icon-192.png" : "calls/icon-192.png", standalone() ? new URL("./", location.href) : document.baseURI).href;
    ms.metadata = new window.MediaMetadata({ title: state.test ? tr("Test call") : tr("Calls"), artist: state.peerName || tr("Guest"), album: "ViktorychApp", artwork: [{ src: icon, sizes: "192x192", type: "image/png" }] });
    ms.playbackState = state.muted ? "paused" : "playing";
    if (ms.setMicrophoneActive) ms.setMicrophoneActive(!state.muted);
    if (ms.setCameraActive) ms.setCameraActive(false);
  } catch (err) { /* the call continues without lock-screen controls */ }
  const handlers = [["pause", () => setMuted(true)], ["play", () => setMuted(false)], ["stop", () => hangUp()], ["hangup", () => hangUp()], ["togglemicrophone", () => setMuted(!state.muted)], ["enterpictureinpicture", () => { if (pip) pip.enter(); }]];
  handlers.forEach((row) => { try { ms.setActionHandler(row[0], row[1]); } catch (err) { /* this action is not supported here */ } });
}
/* iOS makes the audio context in a tap or it stays silent, so the first tap anywhere unlocks one the calls reuse. */
const audioUnlock = createAudioUnlock(window);
if (typeof document !== "undefined") audioUnlock.bind(document);
const wakeFallback = createWakeFallback(typeof document !== "undefined" ? document : null);
async function holdWake(on) {
  try {
    if (!on) {
      wakeFallback.off();
      if (state.wake) await state.wake.release();
      state.wake = null;
      return;
    }
    if ((!state.wake || state.wake.released) && navigator.wakeLock) {
      state.wake = await navigator.wakeLock.request("screen");
      try { state.wake.addEventListener("release", () => { if (state.wake && state.wake.released) state.wake = null; }); } catch (err) { /* older browsers */ }
    } else if (!navigator.wakeLock) wakeFallback.on();
  } catch (err) {
    /* A denied wake lock does not end the call. A looping muted clip keeps the screen on instead. */
    wakeFallback.on();
  }
}
async function routeOutput() {
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    const id = pickSink(list);
    state.sink = id;
    if (state.engine && id) await state.engine.setSink(id);
  } catch (err) { /* keep the current speaker */ }
}

/* ---------- ear mode ---------- */
let raise = null;
let orientationBound = false;
let earOverlay = null;
const unlocker = createUnlocker();
function earSupported() {
  try {
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) return true;
  } catch (err) { /* fall through */ }
  return false;
}
function earSection() {
  const raiseOn = state.earRaise;
  const pick = navigator.mediaDevices && navigator.mediaDevices.selectAudioOutput ? `<button type="button" class="calls-pill" data-act="call-pick-output">${esc(tr("Choose audio output"))}</button>` : "";
  return `<h3>${esc(tr("Ear mode"))}</h3>
    <div class="calls-modes">
      <button type="button" class="calls-pill${raiseOn ? " on" : ""}" data-act="call-ear-raise" aria-pressed="${raiseOn ? "true" : "false"}">${esc(tr("Lock the screen when I raise the phone to my ear"))}</button>
      <button type="button" class="calls-pill" data-act="call-ear">${esc(tr("Ear mode now"))}</button>
      ${pick}
    </div>
    <p class="calls-privacy">${esc(state.ear.note || tr("Browsers cannot sense your ear, so this uses how the phone is held. Double-tap or swipe up to unlock."))}</p>`;
}
function earOverlayHtml() {
  const name = state.peerName || tr("Guest");
  return `<div class="calls-ear-mid"><span class="calls-ear-ring">${ico("ear")}</span><b class="calls-ear-name">${esc(name)}</b><span class="calls-ear-time" data-eartime>${esc(state.startedAt ? clock(Date.now() - state.startedAt) : "")}</span><span class="calls-ear-sub" data-earsub>${esc(state.muted ? tr("Muted") : tr("Microphone on"))}</span></div>
    <div class="calls-ear-hint"><span class="calls-ear-chev" aria-hidden="true"></span><span>${esc(tr("Swipe up or double-tap to unlock"))}</span></div>`;
}
function earVibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (err) { /* no haptics */ } }
async function routeEar(on) {
  try {
    const list = navigator.mediaDevices && navigator.mediaDevices.enumerateDevices ? await navigator.mediaDevices.enumerateDevices() : [];
    if (on) {
      const id = earSinkId(list) || "";
      if (id && state.engine) { await state.engine.setSink(id); state.ear.routed = true; state.ear.note = tr("Sound is coming from the earpiece."); }
      else { state.ear.routed = false; state.ear.note = tr("This browser cannot switch to the earpiece, so the volume is lowered for your ear."); }
    } else {
      state.ear.routed = false;
      if (state.engine) await state.engine.setSink(pickSink(list) || "");
    }
  } catch (err) { state.ear.routed = false; }
  if (state.engine) state.engine.refresh();
}
function lockPointer(kind, e) {
  if (e.cancelable) e.preventDefault();
  if (kind === "down") { try { earOverlay.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ } unlocker.down(e.pointerId, e.clientX, e.clientY, e.timeStamp, e); }
  else if (kind === "move") {
    unlocker.move(e.pointerId, e.clientX, e.clientY);
    const hint = earOverlay && earOverlay.querySelector(".calls-ear-hint");
    if (hint && e.pressure !== 0) hint.style.transform = "translateY(" + Math.min(0, Math.round(e.clientY - (earOverlay._y0 || e.clientY))) + "px)";
  } else if (kind === "up") {
    const hint = earOverlay && earOverlay.querySelector(".calls-ear-hint");
    if (hint) hint.style.transform = "";
    if (unlocker.up(e.pointerId, e.clientX, e.clientY, e.timeStamp) === "unlock") exitEar(false);
  } else unlocker.cancel(e.pointerId);
}
function enterEar(auto) {
  if (state.ear.on || state.phase !== "active" || typeof document === "undefined") return;
  if (!auto) requestOrientation();
  state.ear.on = true;
  state.ear.auto = !!auto;
  unlocker.reset();
  earOverlay = document.createElement("div");
  earOverlay.className = "calls-ear";
  earOverlay.setAttribute("role", "dialog");
  earOverlay.setAttribute("aria-modal", "true");
  earOverlay.setAttribute("aria-label", tr("Ear mode: screen locked"));
  earOverlay.tabIndex = -1;
  earOverlay.innerHTML = earOverlayHtml();
  earOverlay.addEventListener("pointerdown", (e) => { earOverlay._y0 = e.clientY; lockPointer("down", e); });
  earOverlay.addEventListener("pointermove", (e) => lockPointer("move", e));
  earOverlay.addEventListener("pointerup", (e) => lockPointer("up", e));
  earOverlay.addEventListener("pointercancel", (e) => lockPointer("cancel", e));
  earOverlay.addEventListener("touchmove", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
  earOverlay.addEventListener("contextmenu", (e) => e.preventDefault());
  earOverlay.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " " || e.key === "Escape") { e.preventDefault(); exitEar(false); } });
  document.body.appendChild(earOverlay);
  try { earOverlay.focus({ preventScroll: true }); } catch (err) { /* focus is optional */ }
  holdWake(true);
  routeEar(true);
  earVibrate(25);
  if (raise) raise.markEar(true);
  const btn = host() && host().querySelector('[data-act="call-ear"]');
  if (btn) { btn.classList.add("on"); btn.setAttribute("aria-pressed", "true"); }
}
function exitEar(silent) {
  if (!state.ear.on) return;
  state.ear.on = false;
  state.ear.auto = false;
  state.ear.cooldownUntil = Date.now() + 4000;
  unlocker.reset();
  if (earOverlay && earOverlay.parentNode) earOverlay.parentNode.removeChild(earOverlay);
  earOverlay = null;
  if (raise) raise.markEar(false);
  if (!silent) { earVibrate(15); routeEar(false); }
  const btn = host() && host().querySelector('[data-act="call-ear"]');
  if (btn) { btn.classList.remove("on"); btn.setAttribute("aria-pressed", "false"); }
}
function earTick() {
  if (!earOverlay) return;
  const t = earOverlay.querySelector("[data-eartime]");
  if (t && state.startedAt) t.textContent = clock(Date.now() - state.startedAt);
  const sub = earOverlay.querySelector("[data-earsub]");
  if (sub) sub.textContent = state.muted ? tr("Muted") : tr("Microphone on");
}
function autoEarAllowed() {
  if (state.phase !== "active" || state.ear.on) return false;
  if (state.ear.cooldownUntil && Date.now() < state.ear.cooldownUntil) return false;
  if (document.visibilityState === "hidden") return false;
  if (state.mode.send !== "voice" || state.mode.receive === "text" || state.recording) return false;
  const a = document.activeElement;
  if (a && /^(input|textarea|select)$/i.test(a.tagName)) return false;
  return state.panel !== "chat";
}
function onOrientation(e) {
  if (!raise || !state.earRaise) return;
  const verdict = raise.feed({ t: performance.now(), beta: e.beta, gamma: e.gamma });
  if (verdict === "ear") {
    if (autoEarAllowed()) enterEar(true);
    else raise.markEar(false);
  } else if (verdict === "away" && state.ear.on && state.ear.auto) exitEar(false);
}
async function requestOrientation() {
  try {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function" && !state.orientOk) {
      const res = await D.requestPermission();
      state.orientOk = res === "granted";
    } else state.orientOk = !!D;
  } catch (err) { state.orientOk = false; }
  if (state.orientOk) startOrientation();
}
function startOrientation() {
  if (orientationBound || !state.earRaise || !earSupported() || state.phase !== "active") return;
  const D = window.DeviceOrientationEvent;
  if (!D) return;
  if (typeof D.requestPermission === "function" && !state.orientOk) return;
  raise = raise || createRaiseDetector();
  raise.reset();
  window.addEventListener("deviceorientation", onOrientation);
  orientationBound = true;
}
function stopOrientation() {
  if (orientationBound) window.removeEventListener("deviceorientation", onOrientation);
  orientationBound = false;
  if (raise) raise.reset();
}
function toggleEarRaise() {
  state.earRaise = !state.earRaise;
  saveDevice();
  if (state.earRaise) requestOrientation(); else stopOrientation();
  paint();
}
async function pickOutput() {
  try {
    const d = await navigator.mediaDevices.selectAudioOutput();
    if (d && d.deviceId && state.engine) { await state.engine.setSink(d.deviceId); state.ear.routed = true; state.ear.note = tr("Audio output changed."); paint(); }
  } catch (err) { /* the picker was dismissed */ }
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.phase === "active") holdWake(true); });
}

/* ---------- ringing ---------- */
let ringCtx = null;
let ringOwn = true;
let ringTimer = null;
function ringStart() {
  ringStop();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const reuse = audioUnlock.get();
    ringOwn = !reuse;
    ringCtx = reuse || new AC();
    if (ringCtx.state !== "running") ringCtx.resume().catch(() => {});
    const beep = () => {
      if (!ringCtx) return;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      gain.gain.value = 0.2 * state.volumes.ring;
      osc.frequency.value = 440;
      osc.connect(gain);
      gain.connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.4);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch (err) { /* a silent ring still shows the screen */ }
}
function ringStop() {
  clearInterval(ringTimer);
  ringTimer = null;
  if (ringCtx && ringOwn) { try { ringCtx.close(); } catch (err) { /* closed */ } }
  ringCtx = null;
}

/* ---------- engine wiring ---------- */
function markLine(id, patch) {
  const row = state.lines.find((l) => l.id && l.id === id);
  if (!row) return false;
  Object.assign(row, patch);
  return true;
}
function pushLine(line) {
  const started = state.sendStarted;
  const row = Object.assign({ id: String(Date.now()) + Math.floor(Math.random() * 1000), at: Date.now() }, line);
  if (row.typed && row.mine && started) {
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    state.lastSendVisibleMs = Math.max(0, t0 - started);
    state.sendStarted = 0;
  }
  state.lines.push(row);
  if (row.translation && !row.mine) state.lastLine = rememberLine(state.lastLine, { text: row.translation });
  if (state.lines.length > 40) state.lines.shift();
}
function speakText(text, lang, force) {
  const line = String(text || "").trim();
  if (!line) return;
  try {
    if (window.speechSynthesis && (force || noteShouldAutoplay(state.mode))) {
      const utter = new SpeechSynthesisUtterance(line);
      utter.volume = Math.max(0, Math.min(1, state.volumes.tts * state.volumes.overall));
      if (lang) utter.lang = lang;
      window.speechSynthesis.speak(utter);
    }
  } catch (err) { /* text still shows */ }
}
function engineConfig(extra) {
  return Object.assign({
    api: (path, init) => api(path, init),
    apiBase: apiBase,
    getMode: () => state.mode,
    getVolumes: () => (state.ear.on && !state.ear.routed ? Object.assign({}, state.volumes, { overall: state.volumes.overall * EAR_VOLUME_CAP }) : state.volumes),
    getLang: myLang,
    getName: () => state.name || tr("Guest"),
    getLexicon: () => state.lexicon,
    voiceOverride: () => state.voice,
    getKey: localKey,
    speakerOn: () => state.speakerOn,
    connection: () => navigator.connection || {},
    quietVoice: quietVoiceOn,
    liveStream: liveStreamFlagOn,
    streamPlay: streamPlayFlagOn,
    shortEos: shortEosFlagOn,
    bargeIn: bargeFlagOn,
    duckOriginal: duckFlagOn,
    otherPlaying: () => !!(state.test && state.test.hear && state.partner && state.partner.playing && state.partner.playing()),
    relayFirst: relayFirst,
    relayUrl: (tokenValue) => apiBase() + "/v1/calls/live?t=" + encodeURIComponent(tokenValue),
    audioContext: () => audioUnlock.get(),
    relayUrls: (tokenValue) => relayHosts().map((host) => host.replace(/^http/i, "ws") + "/v1/calls/live?t=" + encodeURIComponent(tokenValue)),
    routeKnown: routeKnown,
    onRoute: rememberRoute,
    onEvent: onEngineEvent
  }, extra || {});
}
function onEngineEvent(type, d) {
  if (type === "chat-sent") { if (markLine(d.id, { status: "sent", sent: true })) live(); return; }
  if (type === "chat-failed") { if (markLine(d.id, { status: "failed", sent: false })) live(); return; }
  if (type === "chat-sending") { if (markLine(d.id, { status: "sending", sent: false })) live(); return; }
  if (type === "fallback") {
    const was = !!state.turnFallback;
    state.turnFallback = !!d.on;
    if (state.turnFallback !== was) paint();
    else live();
    return;
  }
  if (type === "status") {
    const wasActive = state.phase === "active";
    const held = holdStatus(state.statusCode, d.code, Date.now(), state.reconnectHeldAt);
    state.reconnectHeldAt = held.heldAt;
    state.statusCode = held.code;
    if (d.code === "joined" || d.code === "connected") { state.phase = "active"; if (!state.startedAt) state.startedAt = Date.now(); ringStop(); }
    if (d.code === "left") { state.peerName = state.peerName; }
    live();
    if (shouldRemountOnStatus(wasActive ? "active" : "idle", d.code)) paint();
  } else if (type === "peer") {
    const remount = shouldRemountOnPeer({ name: state.peerName, degraded: state.peerQuota }, d);
    state.peerName = d.name || state.peerName;
    state.peerQuota = !!d.degraded;
    if (remount) paint();
    else live();
  } else if (type === "peerQuota") {
    state.mode = normalizeMode(Object.assign({}, state.mode, { send: "text" }));
    saveDevice();
    if (state.engine) state.engine.refresh();
    paint();
  } else if (type === "micrestored") {
    state.noMic = "";
    state.muted = false;
    state.mode = normalizeMode(Object.assign({}, state.mode, { send: "voice" }));
    if (state.engine) state.engine.refresh();
    paint();
  } else if (type === "nomic") {
    state.noMic = d.reason || "none";
    state.muted = true;
    state.mode = normalizeMode(Object.assign({}, state.mode, { send: "text" }));
    paint();
    focusType();
  } else if (type === "partial") {
    if (d.mine) return;
    state.partial = { original: d.original || "", translation: d.translation || "" };
    state.whoLabel = d.speaker || "";
    live();
  } else if (type === "line") {
    state.partial = { original: "", translation: "" };
    if (d.mine) {
      if (d.typed) pushLine({ who: tr("You"), mine: true, typed: true, original: d.original, id: d.id, sent: d.sent !== false, status: d.sent === false ? "sending" : "sent" });
      else if (d.original) pushLine({ who: tr("You"), mine: true, original: d.original, translation: d.translation });
    } else {
      pushLine({ who: d.speaker || state.peerName || tr("Guest"), original: d.original, translation: d.translation || d.original });
      if (d.typed && d.speakText) speakText(d.translation || d.original, d.lang);
    }
    live();
  } else if (type === "speaking") {
    if (d.who === "peer") state.speaking = d.on; else state.meSpeaking = d.on;
    live();
  } else if (type === "translating") {
    state.translating = d.on;
    live();
  } else if (type === "needKey") {
    state.needKey = d.reason === "badkey" ? "badkey" : "nokey";
    paint();
  } else if (type === "quota") {
    if (d.reason === "quota") {
      state.quota = true;
      state.mode = normalizeMode(Object.assign({}, state.mode, { send: "text" }));
      saveDevice();
    }
    paint();
  } else if (type === "route") {
    state.route = state.route;
    state.viaRoute = d.via;
  } else if (type === "note") {
    pushLine({ who: d.mine ? tr("You") : (state.peerName || tr("Guest")), mine: !!d.mine, original: tr("Voice note"), note: true, id: d.id });
    live();
  } else if (type === "ended") {
    /* handled by hangUp */
  }
}

/* ---------- starting calls ---------- */
function errorFor(res) {
  const kind = callErrorKind(res);
  if (kind === "not_configured") return tr("Calls are not set up yet");
  if (kind === "calls_closed") return tr("This person is not taking calls right now.");
  if (kind === "not_found") return tr("That call link does not work any more.");
  if (kind === "ended") return tr("The call has ended.");
  if (kind === "cancelled") return tr("That scheduled call was cancelled.");
  if (kind === "not_due") return tr("That scheduled call is not open yet.");
  if (kind === "in_call") return tr("Someone is already in this call.");
  if (kind === "guests") return tr("This person turned guest links off.");
  if (kind === "unauthorized") return tr("Sign in to start a call, or open a guest link to join one.");
  if (kind === "quota") return tr("Too many calls. Try again later.");
  if (kind === "unavailable") return tr("The call service is temporarily unavailable. Try again in a moment.");
  if (kind === "ticket") return tr("The connection was lost.");
  if (kind === "slug_taken") return tr("That name is taken.");
  if (kind === "bad_slug") return tr("Use 3 to 30 letters, numbers or single dashes.");
  if (kind === "bad_key") return tr("That Gemini key was not accepted. Paste a new one.");
  if (kind === "lang") return tr("That language is not supported.");
  if (kind === "failed") return tr("Could not start that call. Try again.");
  return tr("The call could not start. Check your connection and try again.");
}
async function resumeGuest(row) {
  if (!row || !row.token || !row.callId) return false;
  state.guestToken = row.token;
  state.callId = row.callId;
  if (row.name) state.name = row.name;
  const st = await api("/v1/calls/" + row.callId + "/state").catch(() => null);
  if (!st || !st.ok || !st.data || st.data.ended) {
    clearGuestSession();
    state.guestToken = "";
    state.error = tr("The call has ended.");
    return false;
  }
  const res = await api("/v1/calls/" + row.callId + "/ticket", { method: "POST", body: "{}" }).catch(() => null);
  if (!res || !res.ok) {
    clearGuestSession();
    state.guestToken = "";
    const code = res && res.data && res.data.error;
    state.error = (code === "ended" || code === "not_found" || (res && (res.status === 401 || res.status === 410))) ? tr("The call has ended.") : errorFor(res);
    return false;
  }
  state.statusCode = st.data.state === "ringing" ? "calling" : "joined";
  const ok = await begin({ id: row.callId, ticket: res.data.ticket, iceServers: res.data.iceServers }, "guest");
  if (ok) {
    rememberGuestSession(row.expiresAt);
    if (state.engine && state.statusCode === "calling") state.engine.prewarm();
  }
  return ok;
}
let resumeTried = false;
async function maybeResumeGuest() {
  if (resumeTried || state.phase !== "idle" || signedIn()) return;
  const route = state.route || {};
  const row = guestSessionForRoute(readStoredGuestSession(), route);
  if (!row) return;
  const auto = route.name === "callguest" || route.name === "calllink" || route.name === "callschedule" || (standalone() && route.name === "calls");
  if (!auto) return;
  resumeTried = true;
  state.resuming = true;
  paint();
  const ok = await resumeGuest(row);
  state.resuming = false;
  if (!ok) paint();
}
async function maybeUseStoredGuest(route) {
  const row = guestSessionForRoute(readStoredGuestSession(), route);
  if (!row) return false;
  return resumeGuest(row);
}
async function begin(info, role, extra) {

  state.error = "";
  stopMicCheck();
  state.panel = state.test ? "test" : "";
  state.more = false;
  state.callId = info.id;
  state.phase = "calling";
  state.lines = [];
  state.partial = { original: "", translation: "" };
  state.quota = false;
  state.peerQuota = false;
  state.muted = false;
  state.startedAt = 0;
  state.net = lighterFor(navigator.connection || {});
  state.noMic = "";
  state.micAsked = false;
  state.engine = createEngine(engineConfig(extra));
  paint();
  try {
    await state.engine.start({ id: info.id, ticket: info.ticket, iceServers: info.iceServers, role: role });
  } catch (err) {
    await teardown(true);
    state.error = tr("The call could not start. Check your connection and try again.");
    paint();
    return false;
  }
  routeOutput();
  return true;
}
async function startDirect(handle) {
  const clean = String(handle || "").replace(/^@/, "").trim();
  if (!clean) return;
  state.error = "";
  state.peerName = "@" + clean;
  state.statusCode = "calling";
  const res = await api("/v1/calls", { method: "POST", body: JSON.stringify({ handle: clean }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); state.phase = "idle"; state.peerName = ""; paint(); return; }
  state.inviteUrl = "";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "host");
  if (ok) {
    state.engine.prewarm();
    state.ringTimeout = setTimeout(() => { if (state.phase === "calling") { state.error = tr("No answer."); hangUp(); } }, 120000);
  }
}
async function startInvite() {
  state.error = "";
  const res = await api("/v1/calls", { method: "POST", body: JSON.stringify({ invite: true, ttlMin: state.inviteTtl }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.invite = res.data.invite;
  state.inviteUrl = guestUrl(res.data.invite);
  state.peerName = "";
  state.statusCode = "waiting";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "host");
  if (ok) state.engine.prewarm();
}
function guestUrl(invite) {
  const base = standalone() ? new URL("./", location.href) : new URL("calls/", document.baseURI);
  return base.href + "#" + invite;
}
async function joinAsGuest(tokenValue) {
  state.error = "";
  const typed = (document.getElementById("calls-name") || {}).value;
  state.name = String(typed || state.name || tr("Guest")).slice(0, 40);
  saveDevice();
  if (await maybeUseStoredGuest({ name: "callguest", token: tokenValue })) return;
  const res = await api("/v1/calls/join/" + encodeURIComponent(tokenValue), { method: "POST", body: JSON.stringify({ name: state.name }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.guestToken = res.data.guestToken;
  state.statusCode = "joined";
  state.peerName = "";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "guest");
  if (ok) rememberGuestSession(res.data.guestExpiresAt);
}
async function joinLink(slug) {
  state.error = "";
  const typed = (document.getElementById("calls-name") || {}).value;
  state.name = String(typed || state.name || tr("Guest")).slice(0, 40);
  saveDevice();
  if (await maybeUseStoredGuest({ name: "calllink", slug: slug })) return;
  const res = await api("/v1/calls/link/" + encodeURIComponent(slug) + "/join", { method: "POST", body: JSON.stringify({ name: state.name }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.guestToken = res.data.guestToken || "";
  state.statusCode = "calling";
  state.peerName = (state.linkInfo && state.linkInfo.name) || "";
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "guest");
  if (!ok) return;
  rememberGuestSession(res.data.guestExpiresAt);
  state.engine.prewarm();
  const id = res.data.call.id;
  state.ringPoll = setInterval(async () => {
    if (state.phase !== "calling" || state.callId !== id) { clearInterval(state.ringPoll); return; }
    const st = await api("/v1/calls/" + id + "/state").catch(() => null);
    if (st && st.ok && st.data && st.data.ended) { clearInterval(state.ringPoll); state.error = tr("No answer."); await hangUp(); }
  }, 2500);
}
async function loadLink() {
  if (!signedIn()) return;
  const res = await api("/v1/calls/link").catch(() => null);
  if (res && res.ok && res.data) { state.link = res.data.link || null; if (host() && state.phase === "idle") paint(); }
}
async function saveLink(init, route) {
  state.linkError = "";
  const res = await api("/v1/calls/link" + (route || ""), Object.assign({ method: route ? "POST" : "PUT", body: JSON.stringify({}) }, init || {})).catch(() => null);
  if (res && res.ok && res.data) state.link = res.data.link || null;
  else state.linkError = res && res.data && res.data.error === "slug_taken" ? tr("That name is taken.") : (res && res.data && res.data.error === "bad_slug" ? tr("Use 3 to 30 letters, numbers or single dashes.") : tr("The link could not be saved."));
  paint();
}
async function answerIncoming() {
  const who = state.incoming;
  if (!who) return;
  ringStop();
  const res = await api("/v1/calls/" + who.id + "/answer", { method: "POST", body: "{}" }).catch(() => null);
  state.incoming = null;
  if (!res || !res.ok) { state.error = errorFor(res); state.phase = "idle"; paint(); return; }
  state.peerName = who.name || (who.handle ? "@" + who.handle : "");
  state.statusCode = "joined";
  await begin({ id: who.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, who.link ? "host" : "guest");
}
async function declineIncoming() {
  const who = state.incoming;
  ringStop();
  state.incoming = null;
  state.phase = "idle";
  if (who) api("/v1/calls/" + who.id + "/decline", { method: "POST", body: "{}" }).catch(() => {});
  paint();
}
function onRing(data) {
  if (!data || !data.id || state.phase !== "idle") return;
  if (!signedIn()) return;
  state.incoming = { id: data.id, name: data.name || "", handle: data.handle || "", link: data.guest === true || data.link === true };
  state.phase = "incoming";
  ringStart();
  if (!host()) { location.hash = "#/calls/" + data.id; return; }
  paint();
}
async function checkIncoming(id) {
  if (!signedIn() || state.phase !== "idle") return;
  if (scheduleFlagOn()) loadSchedules();
  const res = await api("/v1/calls/incoming").catch(() => null);
  const list = (res && res.ok && res.data && res.data.calls) || [];
  const hit = list.find((row) => !id || row.id === id) || null;
  if (hit) {
    let name = "";
    let handle = "";
    const hist = await api("/v1/calls/history").catch(() => null);
    const row = hist && hist.ok && hist.data && hist.data.calls && hist.data.calls.find((c) => c.id === hit.id);
    if (row) { name = row.name; handle = row.handle; }
    onRing({ id: hit.id, name: name, handle: handle, link: hit.kind === "link" || hit.kind === "qr" });
  }
}
async function loadHistory() {
  await hist.load();
  state.history = hist.rows;
  if (host() && state.phase === "idle" && !state.histSel) paint();
}
async function loadStatus() {
  const res = await api("/v1/calls/status").catch(() => null);
  if (res && res.status === 200 && res.data) state.configured = res.data.configured !== false;
}

/* ---------- ending ---------- */
async function teardown(silent) {
  clearTimeout(state.ringTimeout);
  clearInterval(state.ringPoll);
  ringStop();
  const engine = state.engine;
  const partner = state.partner;
  if (state.preview) { state.preview.reset(); state.preview = null; }
  state.previewBusy = false;
  if (engine && !signedIn() && !state.test && state.callId && state.phase !== "calling") {
    recordLocal({ getItem: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, setItem: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } }, { id: state.callId, name: state.peerName || "", createdAt: state.startedAt || Date.now(), duration: state.startedAt ? Date.now() - state.startedAt : 0, incoming: false });
    hist.load().then(() => { state.history = hist.rows; });
  }
  state.engine = null;
  state.partner = null;
  state.test = null;
  state.panel = "";
  state.more = false;
  state.phase = "idle";
  state.recording = false;
  state.speaking = false;
  state.meSpeaking = false;
  state.translating = false;
  clearInterval(state.statsTimer);
  exitEar(true);
  stopOrientation();
  if (partner) await partner.end(true).catch(() => {});
  if (engine) await engine.end(silent).catch(() => {});
  holdWake(false);
  pipOn(false);
  state.guestToken = state.guestToken;
}
async function hangUp() {
  const endedId = state.callId;
  const endedLines = (state.lines || []).slice();
  clearGuestSession();
  state.guestToken = "";
  await teardown(false);
  if (endedId && endedLines.length) await saveHistTranscript(endedId, endedLines);
  state.barOpen = false;
  state.statusCode = standalone() && state.route && state.route.name === "callguest" ? "ended" : "";
  paint();
  loadHistory();
}
function setMuted(on) {
  state.muted = !!on;
  if (state.engine) state.engine.setMuted(state.muted);
  paint();
}

/* ---------- self test ---------- */
/* Test call. A pre-join screen first: join from another device with a QR code or a link,
   or start with a simulated partner that joins by itself. */
async function prepareTest() {
  if (!signedIn()) return;
  state.error = "";
  const res = await api("/v1/calls", { method: "POST", body: JSON.stringify({ invite: true, ttlMin: 30 }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  const base = standalone() ? new URL("./", location.href) : new URL("calls/", document.baseURI);
  state.testPrep = { id: res.data.call.id, invite: res.data.invite, url: base.href + "#" + res.data.invite, other: false, lang: myLang() === "en" ? "es" : "en", copied: false };
  clearInterval(state.testPoll);
  state.testPoll = setInterval(pollTestPrep, 2000);
  loadQr();
  paint();
}
async function pollTestPrep() {
  const prep = state.testPrep;
  if (!prep || state.phase !== "idle") { clearInterval(state.testPoll); return; }
  const res = await api("/v1/calls/" + prep.id + "/state").catch(() => null);
  if (!res || !res.ok || !state.testPrep) return;
  const other = res.data && res.data.state === "active";
  if (other !== prep.other) {
    prep.other = other;
    const status = document.querySelector("[data-teststatus]");
    if (status) { status.outerHTML = testStatusHtml(); const btn = document.querySelector('[data-act="call-test-start"] span'); if (btn) btn.textContent = other ? tr("Start with your other device") : tr("Start test call"); }
  }
}
function cancelTest() {
  const prep = state.testPrep;
  clearInterval(state.testPoll);
  stopMicCheck();
  state.testPrep = null;
  if (prep) api("/v1/calls/" + prep.id + "/end", { method: "POST", body: "{}" }).catch(() => null);
  paint();
}
async function startTest() {
  const prep = state.testPrep;
  if (!prep || !signedIn()) return;
  clearInterval(state.testPoll);
  state.error = "";
  const tk = await api("/v1/calls/" + prep.id + "/ticket", { method: "POST", body: "{}" }).catch(() => null);
  if (!tk || !tk.ok) { state.error = errorFor(tk); paint(); return; }
  const simulated = !prep.other;
  state.testPrep = null;
  state.test = simulated ? { lang: prep.lang, hear: true, lines: [], partial: { original: "", translation: "" } } : null;
  state.statusCode = "waiting";
  state.peerName = simulated ? tr("Test partner") : tr("Your other device");
  const ok = await begin({ id: prep.id, ticket: tk.data.ticket, iceServers: tk.data.iceServers }, "host");
  if (!ok) return;
  if (simulated) {
    await startPartner(prep.invite);
    state.statsTimer = setInterval(updateStats, 1000);
  }
}
function testStatusHtml() {
  const prep = state.testPrep;
  return `<p class="calls-teststatus${prep && prep.other ? " ok" : ""}" data-teststatus role="status"><span class="calls-dot"></span>${esc(prep && prep.other ? tr("Connected") : tr("Waiting for your other device…"))}</p>`;
}
function loadQr() {
  if (window.qrcode || state.qrLoading) return;
  state.qrLoading = true;
  const el = document.createElement("script");
  el.src = new URL("vendor/qrcode-1.4.4.js", document.baseURI).href;
  el.onload = () => { state.qrLoading = false; if (state.testPrep || state.inviteUrl || (state.rotateQr && state.rotateQr.token)) paint(); };
  el.onerror = () => { state.qrLoading = false; };
  document.head.appendChild(el);
}
/* A scannable code for a guest link, or nothing while the encoder loads (it repaints once ready). */
function qrBlock(url) {
  if (!url || !qrFlagOn()) return "";
  loadQr();
  const svg = qrSvg(url);
  return svg ? `<div class="calls-qr" role="img" aria-label="${esc(tr("QR code for the guest link"))}">${svg}</div>` : "";
}
function qrSvg(text) {
  try {
    const make = window.qrcode;
    if (!make) return "";
    const qr = make(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (err) { return ""; }
}
function testPrepScreen() {
  const prep = state.testPrep;
  const mc = state.micCheck;
  const err = state.error ? `<p class="calls-error" role="alert">${esc(state.error)}</p>` : "";
  const qr = qrSvg(prep.url);
  return `<div class="calls-page calls-join${standalone() ? " calls-solo" : ""}" data-phase="testprep" data-video="0">
    <header class="calls-top"><div class="calls-brand"><span class="calls-logo">${ico("phone")}</span><b>${esc(tr("Test call"))}</b></div><button type="button" class="calls-x" data-act="call-test-cancel" aria-label="${esc(tr("Close"))}">${ico("close")}</button></header>
    <div class="calls-prejoin">
      <div class="calls-preview">
        <div class="calls-tile" data-tile="me" data-speaking="${mc && mc.level > 0.06 ? "1" : "0"}">
          <div class="calls-ava me">${esc(initialOf(tr("You")))}</div>
          ${waveBars()}
          <div class="calls-tag"><span class="calls-tname">${esc(tr("You"))}</span></div>
          <div class="calls-tlang">${langBadge(myLang())}</div>
        </div>
        <div class="calls-checks">
          <button type="button" class="cb${mc ? " on" : ""}" data-act="call-checkmic" aria-pressed="${mc ? "true" : "false"}">${ico("mic")}<span class="cb-l">${esc(mc ? tr("Microphone on") : tr("Check microphone"))}</span></button>
          <span class="calls-meter" aria-hidden="true"><i data-meter style="width:${mc ? Math.round(Math.min(1, mc.level * 4) * 100) : 0}%"></i></span>
          <button type="button" class="cb" data-act="call-checkspk">${ico("speaker")}<span class="cb-l">${esc(tr("Test speaker"))}</span></button>
        </div>
        ${micNoteHtml()}
      </div>
      <div class="calls-joinform">
        <h1>${esc(tr("Test call"))}</h1>
        ${err}
        <label class="calls-vol"><span>${esc(tr("I speak"))}</span><select data-act="call-lang">${langOptions(myLang())}</select></label>
        <label class="calls-vol"><span>${esc(tr("Translate me into"))}</span><select data-act="call-test-prep-lang">${langOptions(prep.lang)}</select></label>
        <section class="calls-device" data-device>
          <h3>${esc(tr("Join from another device"))}</h3>
          <div class="calls-qr" aria-label="${esc(tr("QR code for the other device"))}">${qr || `<span class="calls-empty">${esc(tr("Loading the QR code…"))}</span>`}</div>
          <p class="calls-privacy">${esc(tr("Scan with your phone or open in another tab."))}</p>
          <div class="calls-invite"><input readonly value="${esc(prep.url)}" aria-label="${esc(tr("Guest link"))}" data-invite><button type="button" data-act="call-test-copy">${esc(prep.copied ? tr("Copied") : tr("Copy link"))}</button></div>
          <a class="calls-pill calls-newtab" href="${esc(prep.url)}" target="_blank" rel="noopener">${esc(tr("Open in new tab"))}</a>
          ${testStatusHtml()}
        </section>
        <button type="button" class="calls-big join" data-act="call-test-start">${ico("phone")}<span>${esc(prep.other ? tr("Start with your other device") : tr("Start test call"))}</span></button>
        <p class="calls-privacy">${esc(tr("No second device? A simulated partner joins by itself and you hear your own words translated."))}</p>
      </div>
    </div>
  </div>`;
}
async function startPartner(invite) {
  const t = state.test;
  const partnerLabel = state.test && state.test.practice ? tr("Practice partner") : tr("Test partner");
  const joined = await api("/v1/calls/join/" + encodeURIComponent(invite), { method: "POST", body: JSON.stringify({ name: partnerLabel }) }).catch(() => null);
  if (!joined || !joined.ok) { state.error = errorFor(joined); paint(); return; }
  const guestToken = joined.data.guestToken;
  const partnerMode = { send: "text", receive: "both", original: false, translationOnly: false, subtitles: "both" };
  const eng = createEngine(engineConfig({
    api: (path, init) => api(path, Object.assign({}, init || {}, { headers: { "content-type": "application/json", "x-call-guest": guestToken } })),
    getMode: () => partnerMode,
    micLoop: true,
    getVolumes: () => normalizeVolumes({ overall: state.test && state.test.hear ? 1 : 0, translation: state.test && state.test.hear ? 0.9 : 0, tts: 0 }),
    getLang: () => (state.test ? state.test.lang : "en"),
    getName: () => (state.test && state.test.practice ? tr("Practice partner") : tr("Test partner")),
    voiceOverride: () => "",
    getMic: async () => {
      const mic = state.engine && state.engine.micClone && state.engine.micClone();
      return mic || null;
    },
    onEvent: (type, d) => {
      if (!state.test) return;
      if (type === "line") {
        if (d.mine) state.test.lines.push({ who: state.test.practice ? tr("Practice partner") : tr("Test partner"), mine: false, original: d.original });
        else {
          state.test.lines.push({ who: tr("You"), mine: true, original: d.original, translation: d.translation });
          state.partial = { original: "", translation: "" };
          state.whoLabel = "";
          /* Typed text already has its own bubble: add the translation to it instead of a second one. */
          const typed = d.typed ? state.lines.slice().reverse().find((l) => l.mine && l.typed && !l.translation && l.original === d.original) : null;
          if (typed) { typed.translation = d.translation; typed.who = tr("You") + " → " + langName(state.test.lang); typed.status = typed.status === "failed" ? typed.status : "sent"; typed.sent = typed.status !== "failed"; }
          else state.lines.push({ id: String(Date.now()), at: Date.now(), who: tr("You") + " → " + langName(state.test.lang), mine: true, original: d.original, translation: d.translation });
          if (state.lines.length > 40) state.lines.shift();
          /* What the test partner hears is also spoken, so typing with no microphone is a full test. */
          if (d.typed && state.test.hear) speakText(d.translation || d.original, state.test.lang, true);
          if (state.test.practice) practiceReply(d.original || d.translation);
        }
        live();
      } else if (type === "partial" && !d.mine) {
        state.test.partial = d;
        state.partial = { original: d.original || "", translation: d.translation || "" };
        state.whoLabel = tr("You") + " → " + langName(state.test.lang);
        live();
      } else if (type === "needKey") {
        state.needKey = d && d.reason === "badkey" ? "badkey" : "nokey";
        if (host()) paint();
      }
    }
  }));
  state.partner = eng;
  try { await eng.start({ id: state.callId, ticket: joined.data.ticket, iceServers: joined.data.iceServers, role: "guest" }); }
  catch (err) { state.error = tr("The call could not start. Check your connection and try again."); paint(); }
}
function testReply(text) {
  const clean = String(text || "").trim();
  if (!clean || !state.partner) return;
  state.partner.sendText(clean);
}
async function startPractice() {
  if (!practiceFlagOn() || !signedIn()) return;
  state.error = "";
  const res = await api("/v1/calls", { method: "POST", body: JSON.stringify({ practice: true }) }).catch(() => null);
  if (!res || !res.ok) { state.error = errorFor(res); paint(); return; }
  state.test = { lang: myLang() === "en" ? "es" : "en", hear: true, lines: [], partial: { original: "", translation: "" }, practice: true, turns: [] };
  state.statusCode = "waiting";
  state.peerName = tr("Practice partner");
  const ok = await begin({ id: res.data.call.id, ticket: res.data.ticket, iceServers: res.data.iceServers }, "host");
  if (!ok) return;
  await startPartner(res.data.invite);
  state.statsTimer = setInterval(updateStats, 1000);
}
async function practiceReply(heard) {
  const t = state.test;
  if (!t || !t.practice || !state.partner) return;
  const text = String(heard || "").replace(/\s+/g, " ").trim();
  if (!text) return;
  if (t.practiceBusy) return;
  t.practiceBusy = true;
  const res = await api("/v1/calls/practice", { method: "POST", body: JSON.stringify({ id: state.callId, text: text, lang: t.lang, turns: t.turns }) }).catch(() => null);
  t.practiceBusy = false;
  if (!state.test || !state.test.practice) return;
  if (!res || !res.ok) {
    const code = res && res.data && res.data.error;
    if (code === "nokey" || (res && res.data && res.data.reason === "nokey")) state.needKey = "nokey";
    else if (res && res.data && res.data.reason === "badkey") state.needKey = "badkey";
    else if (res && res.data && res.data.reason === "quota") state.error = tr("The practice partner is busy. Try again in a moment.");
    if (host()) paint();
    return;
  }
  const reply = String((res.data && res.data.reply) || "").trim();
  if (!reply) {
    if (res.data && res.data.reason === "nokey") state.needKey = "nokey";
    else if (res.data && res.data.reason === "badkey") state.needKey = "badkey";
    else if (res.data && res.data.reason === "quota") state.error = tr("The practice partner is busy. Try again in a moment.");
    if (host()) paint();
    return;
  }
  t.turns = (t.turns || []).concat([{ role: "you", text: text }, { role: "partner", text: reply }]).slice(-8);
  state.partner.sendText(reply);
}
/* In a test call the partner engine hears this device, so its heard-side timeline is the one that matters. */
function lastTimings(owner) {
  try { return owner && owner.timings ? owner.timings().rxSummary : null; } catch (err) { return null; }
}
async function updateStats() {
  const eng = state.engine;
  if (!eng) return;
  const mine = await (eng.netStats ? eng.netStats() : Promise.resolve({}));
  const part = state.partner && state.partner.netStats ? await state.partner.netStats() : null;
  const e = eng.stats();
  const p = state.partner ? state.partner.stats() : null;
  const pm = state.partner ? state.partner.metrics() : null;
  const em = eng.metrics();
  const src = pm || em;
  const usage = (p ? p.usage : e.usage) || {};
  const net = part || mine || {};
  state.stats = {
    route: (p ? p.via : e.via) || "direct",
    media: net.media,
    firstAudio: src.firstAudio,
    endLag: src.endLag,
    jitter: net.jitter,
    lost: net.lost,
    rtt: net.rtt,
    speechSec: usage.speechMs != null ? Math.round(usage.speechMs / 100) / 10 : null,
    perMinute: usage.perMinute != null ? Math.round(usage.perMinute / 100) / 10 : null,
    lat: lastTimings(p ? state.partner : eng),
    turn: !!(p ? (state.partner.turn && state.partner.turn()) : (eng.turn && eng.turn()))
  };
  paintStats();
}

/* ---------- handlers ---------- */
function applyMode(patch) {
  state.mode = normalizeMode(Object.assign({}, state.mode, patch));
  saveDevice();
  if (state.engine) state.engine.refresh();
  if (state.engine) state.engine.announce();
  paint();
}
function onSet(group, value) {
  if (group === "translationOnly" || group === "original" || group === "reviewNotes") applyMode({ [group]: value === "1" });
  else if (group === "send" || group === "receive" || group === "subtitles") applyMode({ [group]: value });
  else if (group === "ttl") { state.inviteTtl = Number(value) || 60; paint(); }
  else if (group === "who" || group === "guests" || group === "dnd") setPref(group, group === "who" ? value : value === "1");
}
async function setPref(key, value) {
  if (!signedIn()) return;
  state.prefs = Object.assign({}, state.prefs || {}, { [key]: value });
  const res = await api("/v1/calls/prefs", { method: "PUT", body: JSON.stringify({ [key]: value, tz: -new Date().getTimezoneOffset() }) }).catch(() => null);
  if (res && res.ok && res.data && res.data.prefs) state.prefs = res.data.prefs;
  writeJson("viktorych-calls-prefs-v1", state.prefs);
  const box = document.querySelector(".calls-settings");
  if (box) box.outerHTML = settingsHtml();
}
function repeatLast() {
  if (state.lastLine) speakText(state.lastLine.text, myLang());
}
function onPhrase(text) {
  const spoken = phraseLabel(text) || text;
  if (state.engine) state.engine.sendText(spoken);
}

function setPanel(name) {
  state.panel = name;
  state.more = name === "settings";
  state.hintSeen = true;
  state.panelAnim = true;
  saveDevice();
  paint();
  state.panelAnim = false;
}
function onAct(act, el) {
  if (act === "call-set") onSet(el.dataset.group, el.dataset.value);
  else if (act === "call-more") { state.pop = ""; setPanel(state.panel === "settings" ? "" : "settings"); }
  else if (act === "call-panel") { state.pop = ""; if (el.dataset.value === "chat" && oneChatFlagOn()) { state.conv = state.conv === false; paint(); } else setPanel(el.dataset.value || ""); }
  else if (act === "call-conv") { state.pop = ""; state.conv = state.conv === false; paint(); }
  else if (act === "call-pop") setPop(el.dataset.value || "");
  else if (act === "call-bar-sheet") { state.barOpen = !state.barOpen; paint(); }
  else if (act === "call-tab") { state.tab = el.dataset.value || "recent"; if (state.tab === "scheduled") loadSchedules(); paint(); }
  else if (act === "hist-del") histRemove([el.dataset.id]);
  else if (act === "hist-select") { state.histSel = new Set(); paint(); }
  else if (act === "hist-cancel") { state.histSel = null; paint(); }
  else if (act === "hist-pick") { state.histSel = toggleSet(state.histSel || new Set(), el.dataset.id); paint(); }
  else if (act === "hist-all") { state.histSel = new Set(state.history.filter((r) => (state.tab || "recent") !== "missed" || r.missed).slice(0, 30).map((r) => r.id)); paint(); }
  else if (act === "hist-delete") { if (state.histSel && state.histSel.size) histRemove(Array.from(state.histSel)); }
  else if (act === "hist-clear") histConfirm();
  else if (act === "hist-open") openHistEdit(el.dataset.id);
  else if (act === "hist-close") { state.histEdit = null; paint(); }
  else if (act === "hist-save") saveHistMeta();
  else if (act === "hist-correct") saveHistCorrect(el.dataset.id);
  else if (act === "call-allowmic") openMicModal("call");
  else if (act === "call-translate-retry") {
    state.turnFallback = false;
    if (state.engine && state.engine.retryTranslation) state.engine.retryTranslation();
    paint();
  }
  else if (act === "call-reconnect") {
    if (state.engine && state.engine.retryConnection) state.engine.retryConnection();
    if (state.partner && state.partner.retryConnection) state.partner.retryConnection();
  }
  else if (act === "call-checkmic") checkMic();
  else if (act === "call-checkspk") checkSpeaker();
  else if (act === "call-switch") {
    applyMode({ send: state.mode.send === "text" ? "voice" : "text" });
    state.hintSeen = true;
    saveDevice();
  } else if (act === "call-speaker") {
    state.speakerOn = !state.speakerOn;
    saveDevice();
    if (state.engine) state.engine.refresh();
    paint();
  } else if (act === "call-mute") setMuted(!state.muted);
  else if (act === "call-end") hangUp();
  else if (act === "call-repeat") repeatLast();
  else if (act === "call-phrase") onPhrase(el.dataset.text || "");
  else if (act === "call-back" || act === "call-sugg") startDirect(el.dataset.handle || "");
  else if (act === "call-open") { state.pendingTo = el.dataset.handle || ""; }
  else if (act === "call-invite") startInvite();
  else if (act === "call-test") prepareTest();
  else if (act === "call-practice") startPractice();
  else if (act === "call-capsize") { if (CAP_SIZES.indexOf(el.dataset.value) >= 0) { state.capSize = el.dataset.value; saveDevice(); paint(); } }
  else if (act === "call-ear") enterEar(false);
  else if (act === "call-ear-raise") { toggleEarRaise(); }
  else if (act === "call-pick-output") pickOutput();
  else if (act === "call-focus-type") {
    if (state.noMic) { openMicModal("call"); return; }
    if (oneChatFlagOn()) { if (state.conv === false) { state.conv = true; paint(); } }
    else if (state.panel !== "chat" && !(state.mode.send === "text" || state.noMic)) setPanel("chat");
    focusType();
    const chat = document.querySelector(".calls-compose input[name=text]");
    if (chat) chat.focus();
  }
  else if (act === "call-test-info") { state.testInfo = !state.testInfo; paint(); }
  else if (act === "call-test-start") startTest();
  else if (act === "call-test-cancel") cancelTest();
  else if (act === "call-test-copy") {
    if (state.testPrep) {
      try { navigator.clipboard.writeText(state.testPrep.url); state.testPrep.copied = true; paint(); } catch (err) { const i = document.querySelector("[data-invite]"); if (i) { i.select(); } }
    }
  }
  else if (act === "call-answer") answerIncoming();
  else if (act === "call-decline") declineIncoming();
  else if (act === "call-join") {
    if (state.route && state.route.name === "calllink") joinLink(state.route.slug || "");
    else if (ROTATE_TOKEN.test((state.route && state.route.token) || "")) joinRotateQr(state.route.token);
    else joinAsGuest((state.route && state.route.token) || "");
  }
  else if (act === "call-rejoin") {
    const row = readStoredGuestSession();
    if (row) resumeGuest(row);
  }
  else if (act === "call-rotate-copy") {
    const url = state.rotateQr && state.rotateQr.token ? guestUrl(state.rotateQr.token) : "";
    try { navigator.clipboard.writeText(url); } catch (err) { /* the field can be copied by hand */ }
    el.textContent = tr("Copied");
  }
  else if (act === "call-link-create") saveLink({ method: "PUT", body: JSON.stringify({}) });
  else if (act === "call-link-toggle") saveLink({ method: "PUT", body: JSON.stringify({ enabled: !(state.link && state.link.enabled) }) });
  else if (act === "call-link-regen") saveLink({ method: "POST", body: "{}" }, "/regenerate");
  else if (act === "call-link-del") { api("/v1/calls/link", { method: "DELETE" }).then(() => { state.link = null; paint(); }); }
  else if (act === "call-link-copy" || act === "call-link-share") {
    const url = state.link ? linkUrl(state.link.slug) : "";
    if (act === "call-link-share" && navigator.share) { try { navigator.share({ title: tr("Calls"), url: url }); } catch (err) { /* cancelled */ } }
    else { try { navigator.clipboard.writeText(url); } catch (err) { /* the field can be copied by hand */ } el.textContent = tr("Copied"); }
  }
  else if (act === "call-copy") {
    const input = document.querySelector("[data-invite]");
    try { navigator.clipboard.writeText(state.inviteUrl); } catch (err) { if (input) { input.select(); document.execCommand("copy"); } }
    el.textContent = tr("Copied");
  } else if (act === "call-share") {
    try { navigator.share({ title: tr("Calls"), url: state.inviteUrl }); } catch (err) { /* cancelled */ }
  } else if (act === "call-replay") {
    if (state.engine) state.engine.playNote(el.dataset.id);
  } else if (act === "call-note-cancel") {
    state.review = null;
    paint();
  } else if (act === "call-note-send") {
    const blob = state.review;
    state.review = null;
    if (blob && state.engine) state.engine.noteSend(blob);
    paint();
  } else if (act === "call-lex-del") {
    state.lexicon.splice(Number(el.dataset.i) || 0, 1);
    saveDevice();
    paint();
  } else if (act === "call-test-hear") {
    if (state.test) { state.test.hear = !state.test.hear; if (state.partner) state.partner.refresh(); paint(); }
  } else if (act === "call-test-reply") testReply(el.dataset.text || "");
  else if (act === "call-chat-retry") {
    const id = el.dataset.id || "";
    const row = state.lines.find((l) => l.id === id && l.typed);
    if (row && state.engine && state.engine.sendText) {
      row.status = "sending";
      live();
      state.engine.sendText(row.original, id);
    }
  }
  else if (act === "call-sched-open") { state.schedForm = true; state.tab = "scheduled"; loadSchedules(); paint(); }
  else if (act === "call-sched-hide") { state.schedForm = false; paint(); }
  else if (act === "call-sched-join") joinScheduled(el.dataset.id || "");
  else if (act === "call-sched-later") { state.schedToast = null; paint(); }
  else if (act === "call-sched-rsvp") rsvpSchedule(el.dataset.id || "", el.dataset.value || "");
  else if (act === "call-sched-cancel") cancelSchedule(el.dataset.id || "");
  else if (act === "call-sched-ics") {
    const row = (state.schedules || []).find((r) => r.id === el.dataset.id);
    if (row) downloadIcs(row);
  }
  else if (act === "call-sched-copy") { copyScheduleLink(el.dataset.id || ""); el.textContent = tr("Copied"); }
  else if (act === "call-sched-guest-join") joinScheduledGuest();
  else if (act === "call-sched-guest-ics") { if (state.schedGuest) downloadIcs(Object.assign({}, state.schedGuest, { invite: (state.route && state.route.token) || "" })); }
  else if (act === "call-install") installApp();
  else if (act === "call-key-add") { state.needKey = "nokey"; state.more = false; state.panel = ""; paint(); }
  else if (act === "call-key-remove") removeKey();
  return true;
}

function onPointer(event) {
  const talk = event.target.closest && event.target.closest(".calls-talk");
  if (!talk || state.mode.send !== "note" || !state.engine) return;
  state.talkX = event.clientX;
  if (!state.engine.noteStart()) return;
  state.recording = true;
  state.meSpeaking = true;
  talk.textContent = tr("Slide to cancel");
  const move = (ev) => {
    const choice = noteRelease(state.talkX, ev.clientX, state.mode.reviewNotes);
    talk.classList.toggle("cancel", choice === "cancel");
  };
  const up = async (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", up);
    const choice = noteRelease(state.talkX, ev.clientX, state.mode.reviewNotes);
    const blob = await state.engine.noteStop();
    state.recording = false;
    state.meSpeaking = false;
    if (choice === "cancel" || !blob) state.review = null;
    else if (choice === "review") state.review = blob;
    else await state.engine.noteSend(blob);
    paint();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", up);
}

function onInput(event) {
  const target = event.target;
  const raw = target && target.dataset && target.dataset.vol;
  const key = volKey(raw);
  if (key && VOLUME_KEYS.indexOf(key) >= 0) {
    state.volumes[key] = Number(target.value) / 100;
    saveDevice();
    if (state.engine) state.engine.refresh();
    if (state.partner) state.partner.refresh();
    if (key === "original") {
      const label = target.closest && target.closest(".calls-origvol") && target.closest(".calls-origvol").querySelector("[data-origpct]");
      if (label) label.textContent = Math.round(state.volumes.original * 100) + "%";
    }
    return;
  }
  if (target && target.dataset && target.dataset.act === "call-pwa-name") setInstallName(target.value);
  if (target && target.name === "text" && target.closest && target.closest("form[data-act='call-type-form']") && previewFlagOn() && state.callId) { previewer().input(target.value); return; }
  if (target && target.name === "handle" && target.closest && target.closest(".calls-start")) {
    const box = document.querySelector("[data-sugg]");
    if (box) box.innerHTML = suggestionsHtml(target.value);
  }
}
function onChange(event) {
  const target = event.target;
  const act = target && target.dataset && target.dataset.act;
  if (act === "call-voice") {
    state.voice = target.value;
    saveDevice();
    if (state.engine) state.engine.refresh();
  } else if (act === "call-lang") {
    state.lang = target.value;
    saveDevice();
    if (state.engine) { state.engine.refresh(); state.engine.announce(); }
    document.querySelectorAll('[data-act="call-lang"]').forEach((el) => { el.value = target.value; });
  } else if (act === "call-test-prep-lang") {
    if (state.testPrep) state.testPrep.lang = target.value;
  } else if (act === "call-test-lang") {
    if (state.test) { state.test.lang = target.value; if (state.partner) { state.partner.refresh(); state.partner.announce(); } }
  }
}
/* A pasted link, or just the name in it, opens the guest join screen. */
function openByLink(text) {
  const raw = String(text || "").trim();
  let target = "";
  const invite = raw.match(/#((?:ci1|cs1|cr1)\.[A-Za-z0-9_-]{8,80})/) || raw.match(/^((?:ci1|cs1|cr1)\.[A-Za-z0-9_-]{8,80})$/);
  const named = raw.match(/#u\/([a-z0-9-]{3,30})\s*$/i) || raw.match(/^([a-z0-9][a-z0-9-]{2,29})$/i);
  if (invite) target = invite[1];
  else if (named) target = "u/" + named[1].toLowerCase();
  if (!target) { state.error = tr("That is not a call link or name."); paint(); return; }
  state.error = "";
  location.hash = "#" + target;
}

/* ---------- typed message preview ---------- */
function previewHtml(st) {
  if (!st || st.status === "idle") return "";
  const lang = peerLang();
  const who = lang ? langName(lang) : "";
  if (st.status === "wait" || st.status === "loading") return `<span class="calls-prev-busy">${esc(tr("Translating a preview…"))}</span>`;
  if (st.status === "error" || st.status === "late") return `<span class="calls-prev-busy">${esc(tr("No preview. It will still be sent."))}</span>`;
  if (st.same || !st.translation) return `<span class="calls-prev-busy">${esc(tr("Sent as you wrote it."))}</span>`;
  return `<small>${esc(who ? tr("They will read ({lang})", { lang: who }) : tr("They will read"))}</small><b dir="auto">${esc(st.translation)}</b>${st.back ? `<small class="calls-prev-back">${esc(tr("Means"))}: ${esc(st.back)}</small>` : ""}`;
}
function previewCard() {
  if (!previewFlagOn() || !state.callId) return "";
  return `<div class="calls-prev" data-prev aria-live="polite">${previewHtml(state.preview ? state.preview.state() : null)}</div>`;
}
function paintPreview(st) {
  document.querySelectorAll("[data-prev]").forEach((box) => {
    const html = previewHtml(st);
    box.innerHTML = html;
    box.classList.toggle("on", !!html);
  });
}
function previewer() {
  if (!state.preview) {
    state.preview = createPreview({
      onChange: paintPreview,
      run: async (text) => {
        const lang = peerLang();
        if (!lang || !state.callId) return { translation: "", untranslated: true };
        const res = await api("/v1/calls/" + state.callId + "/preview", { method: "POST", body: JSON.stringify({ text: text, target: lang, source: myLang(), key: localKey() || undefined, lexicon: cleanLexicon(state.lexicon) }) });
        if (!res.ok || !res.data) return { error: "failed" };
        if (res.data.reason === "nokey" || res.data.reason === "badkey" || res.data.reason === "ringing") return { translation: "", untranslated: true };
        return res.data;
      }
    });
  }
  return state.preview;
}

function onSubmit(event) {
  const form = event.target.closest && event.target.closest("form[data-act], .calls-type");
  if (!form) return;
  const act = form.dataset.act || "call-type-form";
  event.preventDefault();
  const input = form.querySelector("input");
  const text = input && input.value;
  if (act === "call-type-form") {
    /* Send at once: the bubble is shown immediately, and a still-loading
       preview must never delay or drop the message. */
    if (input) input.value = "";
    if (state.preview) state.preview.reset();
    state.previewBusy = false;
    state.hintSeen = true;
    const raw = String(text || "").trim();
    if (!raw) return;
    const parts = takeClauses(raw);
    const all = parts.ready.concat(parts.rest ? [parts.rest] : []);
    const pieces = all.length ? all : [raw];
    state.sendStarted = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    if (state.engine) pieces.forEach((piece) => state.engine.sendText(piece));
    else {
      pieces.forEach((piece) => pushLine({ who: tr("You"), mine: true, typed: true, original: piece, status: "failed", sent: false }));
      live();
    }
    focusType();
  } else if (act === "call-link-form") {
    const slug = form.elements.slug.value;
    saveLink({ method: "PUT", body: JSON.stringify({ slug: slug }) });
  } else if (act === "call-key-form") {
    const value = form.elements.key.value;
    form.elements.key.value = "";
    saveKey(value);
  } else if (act === "call-test-form") {
    if (input) input.value = "";
    testReply(text);
  } else if (act === "call-start-form") {
    startDirect(text);
  } else if (act === "call-sched-form") {
    createSchedule({
      when: form.elements.when && form.elements.when.value,
      duration: form.elements.duration && form.elements.duration.value,
      handle: form.elements.handle && form.elements.handle.value,
      title: form.elements.title && form.elements.title.value,
      note: form.elements.note && form.elements.note.value
    });
  } else if (act === "call-sched-name") {
    state.name = String(text || state.name || tr("Guest")).slice(0, 40);
    saveDevice();
    paint();
  } else if (act === "call-open-form") {
    openByLink(text);
  } else if (act === "call-lex-form") {
    const word = form.elements.word.value;
    const say = form.elements.say.value;
    state.lexicon = cleanLexicon(state.lexicon.concat([{ word: word, say: say }]));
    saveDevice();
    paint();
  }
}

/* ---------- the user's own Gemini key ---------- */
async function loadKeyState() {
  if (!signedIn()) return;
  const res = await api("/v1/calls/key").catch(() => null);
  if (res && res.ok && res.data) { state.keySaved = !!res.data.saved; state.keyMask = res.data.mask || ""; }
}
async function saveKey(value) {
  const clean = String(value || "").trim();
  if (!validKeyShape(clean)) { state.needKey = "badkey"; paint(); return; }
  let stored = false;
  if (signedIn()) {
    const res = await api("/v1/calls/key", { method: "PUT", body: JSON.stringify({ key: clean }) }).catch(() => null);
    if (res && res.ok) { stored = true; state.keySaved = true; state.keyMask = (res.data && res.data.mask) || ""; try { localStorage.removeItem(GKEY); } catch (err) { /* ignore */ } }
    else if (res && res.status === 400) { state.needKey = "badkey"; paint(); return; }
  }
  if (!stored) { try { localStorage.setItem(GKEY, clean); } catch (err) { /* private mode */ } }
  state.needKey = "";
  state.quota = false;
  paint();
  if (state.engine) state.engine.retryTranslation();
  if (state.partner) state.partner.retryTranslation();
}
async function removeKey() {
  try { localStorage.removeItem(GKEY); } catch (err) { /* ignore */ }
  if (signedIn()) await api("/v1/calls/key", { method: "DELETE" }).catch(() => null);
  state.keySaved = false;
  state.keyMask = "";
  paint();
}

/* ---------- install (stand-alone page) ---------- */
function setInstallName(value) {
  const clean = String(value || "").replace(/[\u0000-\u001F<>]/g, "").trim().slice(0, 30) || "ViktorychCalls";
  try { localStorage.setItem("viktorych-calls-pwa-name", clean); } catch (err) { /* private mode */ }
  if (window.ViktorychCallsInstall && window.ViktorychCallsInstall.rename) window.ViktorychCallsInstall.rename(clean);
}
function installApp() {
  if (window.ViktorychCallsInstall && window.ViktorychCallsInstall.prompt) window.ViktorychCallsInstall.prompt();
}

/* ---------- mounting ---------- */
let bound = false;
let timerBound = false;
function mount(route) {
  if (!timerBound) { timerBound = true; setInterval(() => { if (state.phase === "active") live(); }, 1000); }
  state.route = route || state.route;
  loadDevice();
  const target = document;
  if (!bound) {
    bound = true;
    target.addEventListener("pointerdown", onPointer);
    target.addEventListener("pointerdown", swipeDown);
    target.addEventListener("pointermove", swipeMove);
    target.addEventListener("pointerup", swipeUp);
    target.addEventListener("pointercancel", () => { holdClear(); if (swipe) { swipe.row.style.transform = ""; swipe = null; } });
    target.addEventListener("pointerdown", holdDown);
    target.addEventListener("pointermove", holdMove);
    target.addEventListener("pointerup", holdClear);
    target.addEventListener("click", holdClick, true);
    target.addEventListener("click", popOutside);
    target.addEventListener("pointerdown", barDown);
    target.addEventListener("pointermove", barMove);
    target.addEventListener("pointerup", barUp);
    target.addEventListener("pointercancel", clearBarDrag);
    target.addEventListener("contextmenu", onContext, true);
    target.addEventListener("input", onInput);
    target.addEventListener("change", onChange);
    target.addEventListener("submit", onSubmit, true);
    document.addEventListener("visibilitychange", micRecheck);
    window.addEventListener("focus", micRecheck);
    window.addEventListener("pageshow", micRecheck);
    window.addEventListener("viktorych-call-ring", (event) => onRing(event.detail));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => { routeOutput(); });
  }
  const r = state.route || {};
  loadStatus();
  loadKeyState();
  if (r.name === "calls") loadLink();
  if (r.name === "callguest" && ROTATE_TOKEN.test(r.token || "") && !state.linkInfo) {
    api("/v1/calls/qr/info?token=" + encodeURIComponent(r.token)).then((res) => {
      state.linkInfo = res && res.ok ? res.data : { name: "", open: false, reason: "closed" };
      if (host()) paint();
    }).catch(() => {});
  }
  if (r.name === "calllink" && r.slug && !state.linkInfo) {
    api("/v1/calls/link/" + encodeURIComponent(r.slug)).then((res) => {
      state.linkInfo = res && res.ok ? res.data : { name: "", open: false, reason: "closed" };
      if (host()) paint();
    }).catch(() => {});
  }
  if (r.name === "callschedule" && r.token && state.phase === "idle") loadGuestSchedule(r.token);
  if (r.name === "calls" && state.phase === "idle") {
    loadHistory();
    if (rotateQrFlagOn()) loadRotateQr();
    if (scheduleFlagOn()) {
      const tab = r.query && r.query.get && r.query.get("tab");
      if (tab === "scheduled") state.tab = "scheduled";
      const openForm = r.query && r.query.get && r.query.get("schedule");
      const withHandle = r.query && r.query.get && r.query.get("with");
      if (openForm === "1" && signedIn()) {
        state.schedForm = true;
        state.tab = "scheduled";
        if (withHandle) state.schedHandle = withHandle;
      }
      loadSchedules();
    }
    const to = r.query && r.query.get && r.query.get("to");
    if (to) {
      try { history.replaceState(null, "", location.href.split("?")[0].replace(/\?to=[^#]*/, "")); } catch (err) { /* keep the url */ }
      if (signedIn()) startDirect(to);
    } else if (r.id) checkIncoming(r.id);
    else checkIncoming("");
  }
  if (state.phase === "active") { bindSession(true); holdWake(true); routeOutput(); startOrientation(); }
  maybeResumeGuest();
}
/* Leaving the Calls page in the app (a link, the sidebar, the back button) ends a live call the same way the Leave button does:
   tracks stop, the sockets close, the history row is written. The standalone guest page has no other page to go to. */
let leaving = false;
function unmount() {
  clearTimeout(state.rotateQrTimer);
  if (!standalone() && !leaving && (state.phase === "active" || state.phase === "calling")) {
    leaving = true;
    hangUp().catch(() => {}).then(() => { leaving = false; });
  } else if (!standalone() && state.testPrep && state.phase === "idle") cancelTest();
  exitEar(true);
  stopOrientation();
  holdWake(false);
  bindSession(false);
}

function settingsHtml() {
  const prefs = state.prefs || readJson("viktorych-calls-prefs-v1") || { who: "everyone", guests: true, dnd: false };
  loadDevice();
  if (signedIn() && !state.prefsLoading && !state.prefsLoaded) {
    state.prefsLoading = true;
    api("/v1/calls/prefs").then((res) => {
      state.prefsLoading = false;
      state.prefsLoaded = true;
      if (res && res.ok && res.data && res.data.prefs) {
        state.prefs = res.data.prefs;
        writeJson("viktorych-calls-prefs-v1", state.prefs);
        const box = document.querySelector(".calls-settings");
        if (box) box.outerHTML = settingsHtml();
      }
    }).catch(() => { state.prefsLoading = false; });
  }
  const voices = [`<option value="">${esc(tr("Match the voice automatically"))}</option>`].concat(PREBUILT_VOICES.map((row) => `<option value="${esc(row.name)}"${state.voice === row.name ? " selected" : ""}>${esc(row.name)}</option>`)).join("");
  const words = state.lexicon.map((row, index) => `<li>${esc(row.word)} = ${esc(row.say)} <button type="button" data-act="call-lex-del" data-i="${index}">${esc(tr("Remove"))}</button></li>`).join("");
  return `<div class="calls-settings" data-video="0">
    <h2>${esc(tr("Calls settings"))}</h2>
    <p>${esc(tr("Voice calls with live translation. Audio and text only."))}</p>
    <label>${esc(tr("Translation voice"))}<select data-act="call-voice">${voices}</select></label>
    <h2>${esc(tr("Who can call me"))}</h2>
    <div class="calls-modes">${pill("who", "everyone", prefs.who || "everyone", tr("Everyone"))}${pill("who", "circle", prefs.who || "everyone", tr("People I follow or mutuals"))}${pill("who", "nobody", prefs.who || "everyone", tr("Nobody"))}</div>
    <div class="calls-modes"><button type="button" class="calls-pill${prefs.guests !== false ? " on" : ""}" data-act="call-set" data-group="guests" data-value="${prefs.guests !== false ? "0" : "1"}" aria-pressed="${prefs.guests !== false ? "true" : "false"}">${esc(tr("Allow guest invite links"))}</button>
    <button type="button" class="calls-pill${prefs.dnd ? " on" : ""}" data-act="call-set" data-group="dnd" data-value="${prefs.dnd ? "0" : "1"}" aria-pressed="${prefs.dnd ? "true" : "false"}">${esc(tr("Quiet hours"))}</button></div>
    <p>${esc(tr("Blocked accounts can’t call you."))}</p>
    <h2>${esc(tr("Name pronunciations"))}</h2>
    <ul>${words}</ul>
    <p>${esc(tr("On the free Gemini plan, Google may use call audio to improve its products."))}</p>
  </div>`;
}

function debug() {
  const e = state.engine;
  return {
    video: false,
    constraints: MIC_CONSTRAINTS,
    opus: OPUS_MAX_BITRATE,
    transmit: transmitOriginal(state.mode),
    mic: micOpen(state.mode, state.recording),
    guest: guestFeature("route") && guestFeature("background") && guestFeature("repeat") && guestFeature("callback"),
    sink: state.sink,
    voice: state.voice || DEFAULT_VOICE,
    mode: state.mode,
    volumes: state.volumes,
    direct: !proxiesAudio(),
    chunkSamples: CHUNK_SAMPLES,
    outputRate: OUTPUT_RATE,
    worklet: MIC_WORKLET,
    stats: e ? e.stats() : null,
    timings: e && e.timings ? e.timings() : null,
    partnerTimings: state.partner && state.partner.timings ? state.partner.timings() : null,
    lastSendVisibleMs: state.lastSendVisibleMs || 0,
    state: state
  };
}

window.ViktorychCalls = { repaint: paint, page, mount, unmount, onAct, settingsHtml, debug, guestFeature, PINNED_LANGS, CALL_LANGS, normalizeLang, detectLang, createVoiceMatch, DEFAULT_VOICE, onRing, checkIncoming };
