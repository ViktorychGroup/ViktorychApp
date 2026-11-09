/* Music Space. The visible name is productName("music"). Audio-only HLS, no video surface.
   Pure helpers stay usable under node (no document). */
(function (root) {
  "use strict";


  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : ((typeof self !== "undefined" && self.t) ? self.t : null);
    return fn ? fn(key, vars) : key;
  }
  function trn(key, n, vars) {
    var fn = (typeof window !== "undefined" && window.tn) ? window.tn : ((typeof self !== "undefined" && self.tn) ? self.tn : null);
    return fn ? fn(key, n, vars) : String(n);
  }
  function productName(kind) {
    var api = (typeof SI18n !== "undefined") ? SI18n : ((typeof window !== "undefined" && window.SI18n) ? window.SI18n : ((typeof self !== "undefined" && self.SI18n) ? self.SI18n : null));
    return (api && api.productName) ? api.productName(kind) : "";
  }

  function homePills(items, follows) {
    const set = Object.create(null);
    (follows || []).forEach((id) => { set[String(id)] = true; });
    return (items || []).filter((item) => item && item.live && item.followId && set[String(item.followId)]);
  }

  function profileLive(item, platform, handle) {
    if (!item || !item.live) return false;
    const host = item.host || {};
    const left = String(host.handle || "").replace(/^@/, "").toLowerCase();
    const right = String(handle || "").replace(/^@/, "").toLowerCase();
    return String(host.platform || "") === String(platform || "") && !!left && left === right;
  }

  function hostRule(rule) {
    let text = String(rule || "").trim().toLowerCase();
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    text = text.replace(/^\*\./, "");
    text = text.split("/")[0].split("@").pop().split(":")[0];
    return text.replace(/\.+$/, "");
  }

  function hostAllowed(hostname, allow) {
    const host = String(hostname || "").toLowerCase().replace(/\.+$/, "");
    if (!host) return false;
    const rules = Array.isArray(allow) ? allow : [];
    for (let i = 0; i < rules.length; i++) {
      const rule = hostRule(rules[i]);
      if (!rule) continue;
      if (host === rule || host.endsWith("." + rule)) return true;
    }
    return false;
  }

  function allowedAudio(raw, base, allow) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value || /[\s\\]/.test(value) || value.indexOf("//") === 0) return "";
    let url;
    try {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        if (!/^https:/i.test(value)) return "";
        url = new URL(value);
      } else {
        const rootUrl = String(base == null ? "" : base).trim();
        if (!/^https:\/\//i.test(rootUrl)) return "";
        const folder = rootUrl.endsWith("/") ? rootUrl : rootUrl + "/";
        url = new URL(value, folder);
      }
    } catch (err) {
      return "";
    }
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (!hostAllowed(url.hostname, allow)) return "";
    return url.href;
  }

  function listenersOf(status) {
    if (!status || typeof status !== "object") return null;
    const keys = ["listeners", "viewers", "listening"];
    for (let i = 0; i < keys.length; i++) {
      if (status[keys[i]] == null || status[keys[i]] === "") continue;
      const n = Number(status[keys[i]]);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
    return null;
  }

  const STATUS_MAX_AGE = 2 * 60 * 1000;
  const STATUS_OFFLINE_AGE = 8 * 60 * 1000;
  const LOOP_DRIFT_S = 5;
  const LOOP_RECHECK_MS = 3 * 60 * 1000;
  const LOOP_TICK_MS = 5000;

  function statusUpdatedAt(status) {
    if (!status || typeof status !== "object") return null;
    if (typeof status.updated !== "string" || !status.updated.trim()) return null;
    const then = Date.parse(status.updated);
    return Number.isFinite(then) ? then : NaN;
  }

  function statusStale(status, now) {
    const then = statusUpdatedAt(status);
    if (then == null) return false;
    if (!Number.isFinite(then)) return true;
    const clock = typeof now === "number" ? now : Date.now();
    return clock - then > STATUS_MAX_AGE;
  }

  function statusOffline(status, now) {
    if (!status || typeof status !== "object") return false;
    if (status.live === false) return true;
    const then = statusUpdatedAt(status);
    if (then == null) return false;
    if (!Number.isFinite(then)) return true;
    const clock = typeof now === "number" ? now : Date.now();
    return clock - then > STATUS_OFFLINE_AGE;
  }

  function remoteStatusUrl(raw, allow, now) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value || /[\s\\]/.test(value) || !/^https:\/\//i.test(value)) return "";
    let url;
    try {
      url = new URL(value);
    } catch (err) {
      return "";
    }
    if (url.protocol !== "https:" || url.username || url.password) return "";
    if (!hostAllowed(url.hostname, allow)) return "";
    url.searchParams.set("_", String(typeof now === "number" ? now : Date.now()));
    return url.href;
  }

  function audioFromStatus(status, allow, now) {
    const empty = { live: false, url: "", listeners: null, scheduled: false, reconnecting: false };
    if (!status || typeof status !== "object") return empty;
    const scheduled = status.scheduled === true || status.state === "scheduled";
    const listeners = listenersOf(status);
    if (status.live !== true || statusOffline(status, now)) {
      return { live: false, url: "", listeners: listeners, scheduled: scheduled && status.live !== true, reconnecting: false };
    }
    const base = typeof status.base === "string" ? status.base : "";
    const hls = status.hls && typeof status.hls === "object" ? status.hls : null;
    const raw = hls && typeof hls.audio === "string" ? hls.audio : "";
    const url = allowedAudio(raw, base, allow);
    if (!url) return { live: false, url: "", listeners: listeners, scheduled: false, reconnecting: false };
    return { live: true, url: url, listeners: listeners, scheduled: false, reconnecting: statusStale(status, now) };
  }

  function loopPosition(doc, nowMs) {
    const duration = Number(doc && doc.duration);
    const epoch = Number(doc && doc.epoch);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(epoch)) return 0;
    const clock = (typeof nowMs === "number" ? nowMs : Date.now()) / 1000;
    const t = clock - epoch;
    return ((t % duration) + duration) % duration;
  }

  function loopDrift(currentTime, doc, nowMs) {
    const duration = Number(doc && doc.duration);
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    const delta = Number(currentTime) - loopPosition(doc, nowMs);
    return ((delta + duration / 2) % duration + duration) % duration - duration / 2;
  }

  function loopSeek(doc, nowMs) {
    const duration = Number(doc && doc.duration);
    const pos = loopPosition(doc, nowMs);
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return pos > duration - 0.5 ? 0 : pos;
  }

  function loopFromDoc(status, allow) {
    const empty = { live: false, url: "", listeners: null, scheduled: false, reconnecting: false, version: "", duration: 0, epoch: 0 };
    if (!status || typeof status !== "object" || status.live !== true) return empty;
    const duration = Number(status.duration);
    const epoch = Number(status.epoch);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(epoch)) return empty;
    const url = allowedAudio(typeof status.url === "string" ? status.url : "", "", allow);
    if (!url) return empty;
    return {
      live: true,
      url: url,
      listeners: listenersOf(status),
      scheduled: false,
      reconnecting: false,
      version: typeof status.version === "string" ? status.version : "",
      duration: duration,
      epoch: epoch
    };
  }

  // FLAC is the loop's primary playlist. fallback is AAC for browsers that
  // cannot play audio/mp4; codecs="flac". A missing fallback keeps the primary.
  // loop/current.json "primary" chooses the first playlist. Only "tg" is Telegram.
  function loopPrimaryName(value) {
    return String(value || "").trim().toLowerCase() === "tg" ? "tg" : "r2";
  }

  function loopPlayChoice(status, allow, flacOk) {
    const parsed = loopFromDoc(status, allow);
    const raw = status && typeof status.fallback === "string" ? status.fallback : "";
    const fallback = parsed.live ? allowedAudio(raw, "", allow) : "";
    const useFallback = flacOk === false && !!fallback;
    return {
      live: parsed.live,
      url: useFallback ? fallback : parsed.url,
      primary: parsed.url,
      fallback: fallback,
      version: parsed.version,
      duration: parsed.duration,
      epoch: parsed.epoch,
      source: loopPrimaryName(status && status.primary)
    };
  }

  // current.json is the only liveness source for the static loop. A site or
  // R2 status.json (live:false, no loop url) is not a manifest.
  function loopManifestDoc(doc) {
    if (!doc || typeof doc !== "object") return false;
    if (doc.mode === "loop") return true;
    const duration = Number(doc.duration);
    const url = typeof doc.url === "string" ? doc.url : "";
    return duration > 0 && url.indexOf("/loop/") >= 0;
  }

  function loopNeedsRefresh(reason, httpStatus) {
    const status = Number(httpStatus);
    if (status === 404 || status === 410) return true;
    return reason === "fatal" || reason === "stall" || reason === "watch" || reason === "network" || reason === "ended" || reason === "unsupported";
  }

  function loopRecovery(loaded, manifest, allow, reason, httpStatus, flacOk) {
    const refresh = loopNeedsRefresh(reason, httpStatus);
    const keep = loaded && loaded.live && loaded.url ? loaded : null;
    if (!loopManifestDoc(manifest)) {
      return {
        refresh: refresh,
        live: !!keep,
        swap: false,
        url: keep ? keep.url : "",
        version: keep ? (keep.version || "") : "",
        seek: false
      };
    }
    const next = loopPlayChoice(manifest, allow, flacOk);
    if (!next.live || !next.url) {
      return { refresh: refresh, live: false, swap: false, url: "", version: "", seek: false };
    }
    const changed = !loaded || (loaded.version || "") !== (next.version || "") || loaded.url !== next.url;
    return {
      refresh: refresh,
      live: true,
      swap: !!(refresh && changed),
      url: next.url,
      version: next.version || "",
      seek: true
    };
  }

  function playlistJumped(prevSn, nextSn, fragCount) {
    if (prevSn == null || nextSn == null) return false;
    if (!Number.isFinite(prevSn) || !Number.isFinite(nextSn)) return false;
    const span = Number.isFinite(fragCount) && fragCount > 0 ? fragCount : 3;
    if (nextSn < prevSn) return true;
    return nextSn > prevSn + span + 1;
  }

  function recoverPlan(reason, fixes) {
    const mediaFixes = fixes && fixes.mediaFixes || 0;
    const softLoads = fixes && fixes.softLoads || 0;
    const hasHls = !!(fixes && fixes.hasHls);
    if (!hasHls || reason === "jump" || reason === "fatal" || reason === "unsupported" || reason === "ended" || reason === "stall" || reason === "watch") return "recreate";
    if (reason === "media" && mediaFixes < 1) return "media";
    if (softLoads < 1) return "reload";
    return "recreate";
  }

  function marqueePlan(overflow, reduced) {
    if (reduced || !(overflow > 1)) return { animate: false, duration: 0 };
    const duration = Math.max(18, Math.min(48, overflow / 22));
    return { animate: true, duration: duration, easing: "linear", from: "0%", to: "-100%" };
  }

  // Telegram mirror of one published loop playlist. The version and the AAC
  // tree are taken from the R2 URL so the fallback is the same rendition.
  function loopTelegramUrl(r2Url, api) {
    const match = String(r2Url || "").match(/\/loop\/([A-Za-z0-9._-]{1,80})(\/aac)?\/index\.m3u8(?:[?#]|$)/i);
    if (!match) return "";
    const base = String(api || "").replace(/\/$/, "");
    if (!/^https:\/\//i.test(base)) return "";
    try {
      const url = new URL(base);
      if (url.protocol !== "https:" || url.username || url.password) return "";
    } catch (err) {
      return "";
    }
    return base + "/tg/loop/" + match[1] + (match[2] ? "/aac" : "") + "/index.m3u8";
  }

  // primary "r2" (the default) or "tg" is the first playlist. After one failed
  // retry, the same version continues from the other source. A new version
  // starts on primary again. An empty API cannot select Telegram.
  function loopMirrorPlan(input) {
    const src = input && typeof input === "object" ? input : {};
    const version = String(src.version || "");
    const nextVersion = src.nextVersion == null ? "" : String(src.nextVersion);
    const seek = Number.isFinite(src.position) && src.position > 0 ? src.position : 0;
    const r2 = String(src.r2Url || "");
    const primary = loopPrimaryName(src.primary);
    const telegram = loopTelegramUrl(r2, src.api);
    const via = src.via === "telegram" || src.via === "tg" ? "tg" : "r2";
    function pick(which, switched) {
      if (which === "tg" && telegram) {
        return { via: "telegram", url: telegram, switched: !!switched, seek: seek, primary: primary };
      }
      return { via: "r2", url: r2, switched: which === "r2" && !!switched, seek: seek, primary: primary };
    }
    if (nextVersion && nextVersion !== version) return pick(primary, false);
    const failures = Number(src.failures) || 0;
    const status = Number(src.status) || 0;
    const failed = !!src.network || (status >= 400 && status <= 599);
    if (failures >= 2 && failed && version) {
      if (via === "tg") return pick("r2", true);
      if (telegram) return pick("tg", true);
      return pick("r2", false);
    }
    if (via === "tg" && telegram) return pick("tg", false);
    return pick("r2", false);
  }

  // Where attach should start. A saved fallback sticks until the version,
  // the rendition, or primary changes. primary "tg" starts on Telegram.
  function loopAttachPlan(input) {
    const src = input && typeof input === "object" ? input : {};
    const primary = loopPrimaryName(src.primary);
    const savedPrimary = src.savedPrimary ? loopPrimaryName(src.savedPrimary) : "";
    const version = String(src.version || "");
    const savedVersion = String(src.savedVersion || "");
    const playUrl = String(src.playUrl || "");
    const savedPlayUrl = String(src.savedPlayUrl || "");
    const savedVia = src.savedVia === "tg" || src.savedVia === "telegram" ? "tg" : (src.savedVia === "r2" ? "r2" : "");
    const same = !!(savedVia && savedVersion === version && savedPlayUrl === playUrl && savedPrimary === primary);
    let via = same ? savedVia : primary;
    const telegram = loopTelegramUrl(playUrl, src.api);
    if (via === "tg" && !telegram) via = "r2";
    return {
      via: via === "tg" ? "telegram" : "r2",
      url: via === "tg" ? telegram : playUrl,
      primary: primary
    };
  }

  const logic = {
    homePills: homePills,
    profileLive: profileLive,
    allowedAudio: allowedAudio,
    marqueePlan: marqueePlan,
    listenersOf: listenersOf,
    audioFromStatus: audioFromStatus,
    statusStale: statusStale,
    statusOffline: statusOffline,
    remoteStatusUrl: remoteStatusUrl,
    loopPosition: loopPosition,
    loopDrift: loopDrift,
    loopSeek: loopSeek,
    loopFromDoc: loopFromDoc,
    loopPlayChoice: loopPlayChoice,
    loopManifestDoc: loopManifestDoc,
    loopNeedsRefresh: loopNeedsRefresh,
    loopRecovery: loopRecovery,
    playlistJumped: playlistJumped,
    recoverPlan: recoverPlan,
    loopTelegramUrl: loopTelegramUrl,
    loopMirrorPlan: loopMirrorPlan,
    loopPrimaryName: loopPrimaryName,
    loopAttachPlan: loopAttachPlan
  };

  if (typeof document === "undefined") {
    root.SpacesLogic = logic;
    return;
  }

  const EMOJIS = ["💜", "🔥", "👏", "😂", "❤️", "🎵"];
  const HLS_SRC = "https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js";
  const ICON = {
    down: "M12 15.5 5 8.5l1.4-1.4L12 12.7l5.6-5.6L19 8.5z",
    up: "M12 8.5 19 15.5l-1.4 1.4L12 11.3l-5.6 5.6L5 15.5z",
    more: "M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
    mic: "M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2zM3.3 2.9 21 20.6 19.6 22 2 4.3z",
    share: "M18 16.1a2.9 2.9 0 0 0-2.3 1.1l-6.3-3.2a2.9 2.9 0 0 0 0-2l6.3-3.2A2.9 2.9 0 1 0 15 6a2.9 2.9 0 0 0 .1.7L9 9.8a3 3 0 1 0 0 4.4l6.1 3.1a3 3 0 1 0 2.9-1.2z",
    comment: "M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    pause: "M7 5h3v14H7zM14 5h3v14h-3z",
    play: "M8 5v14l11-7z"
  };

  let hooks = {};
  let spaces = [];
  let extras = [];
  let started = false;
  let polling = false;
  let configOk = false;
  let configErrors = 0;
  let timer = 0;
  let lastPoll = 0;
  let lastSig = "";
  const runtime = Object.create(null);
  const seenMarquee = new WeakSet();
  let io = null;
  const player = {
    audio: null,
    hls: null,
    ctx: null,
    analyser: null,
    time: null,
    raf: 0,
    active: false,
    spaceId: "",
    loadedUrl: "",
    loadedVersion: "",
    linkDown: false,
    pausedByUser: false,
    corsRetried: false,
    recoverTimer: 0,
    recovering: false,
    recoverSeq: 0,
    recoverReason: "",
    recoverStatus: 0,
    waitTimer: 0,
    watch: 0,
    recoverFails: 0,
    flacBlocked: false,
    mediaFixes: 0,
    softLoads: 0,
    progressAt: 0,
    lastTime: 0,
    lastSn: null,
    loopClock: 0,
    generation: 0,
    ignoreErrorUntil: 0,
    loadedMirror: "",
    loopVia: "",
    loadedPrimary: "",
    loopMirrorVersion: "",
    loopMirrorPlayUrl: "",
    recoveredFor: 0,
    noAnalyser: false,
    returnHash: "",
    dockKey: ""
  };

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[ch]));
  }

  function svg(path) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>';
  }

  function ui(english) {
    const fn = hooks && typeof hooks.t === "function" ? hooks.t : (typeof root.t === "function" ? root.t : null);
    if (fn) {
      try {
        const value = fn(english);
        if (typeof value === "string" && value) return value;
      } catch (err) { /* keep the English string */ }
    }
    return english;
  }

  function isFollowed(id) {
    return !!(hooks.isFollowed && id && hooks.isFollowed(id));
  }

  function readDemo() {
    try {
      const host = location.hostname;
      if (host !== "localhost" && host !== "127.0.0.1") return null;
      const raw = sessionStorage.getItem("spaces-demo");
      if (!raw) return null;
      const doc = JSON.parse(raw);
      return doc && typeof doc === "object" ? doc : null;
    } catch (err) {
      return null;
    }
  }

  function demoFor(space) {
    const demo = readDemo();
    if (!demo) return null;
    if (demo.id && space && demo.id !== space.id) return null;
    return demo;
  }

  function effectiveAllow(space) {
    const source = (space && space.source) || {};
    const allow = Array.isArray(source.allow) ? source.allow.slice() : [];
    const demo = demoFor(space);
    if (demo && Array.isArray(demo.allow)) return allow.concat(demo.allow);
    return allow;
  }

  function applyDemo(space, doc) {
    const base = doc && typeof doc === "object" ? Object.assign({}, doc) : {};
    const demo = demoFor(space);
    if (!demo) return base;
    if (typeof demo.live === "boolean") {
      base.live = demo.live;
      if (demo.live) base.updated = new Date().toISOString();
    }
    if (typeof demo.base === "string") base.base = demo.base;
    if (typeof demo.audio === "string") {
      const hls = base.hls && typeof base.hls === "object" ? Object.assign({}, base.hls) : {};
      hls.audio = demo.audio;
      base.hls = hls;
    }
    if (demo.listeners != null && demo.listeners !== "") base.listeners = demo.listeners;
    if (demo.scheduled === true) base.scheduled = true;
    delete base.title;
    delete base.cover;
    delete base.streamTitle;
    delete base.artist;
    delete base.song;
    delete base.name;
    return base;
  }

  function sameOriginStatus(statusUrl) {
    const raw = String(statusUrl || "").trim();
    if (!raw || raw.indexOf("..") >= 0 || raw.indexOf("\\") >= 0) return "";
    try {
      const url = new URL(raw, new URL(".", location.href));
      if (url.origin !== location.origin) return "";
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      url.searchParams.set("_", String(Date.now()));
      return url.href;
    } catch (err) {
      return "";
    }
  }

  function resolveStatusUrl(statusUrl, allow) {
    const raw = String(statusUrl || "").trim();
    if (!raw) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.indexOf("//") === 0) return remoteStatusUrl(raw, allow);
    return sameOriginStatus(raw);
  }

  function hostFace(space) {
    const host = (space && space.host) || {};
    let name = host.name || tr("Host");
    let avatar = host.avatar || (space && space.cover) || "";
    if (hooks.findFeed && host.platform && host.handle) {
      const feed = hooks.findFeed(host.platform, host.handle);
      if (feed) {
        if (feed.name) name = feed.name;
        if (feed.avatar) avatar = feed.avatar;
      }
    }
    return {
      name: name,
      handle: host.handle || "",
      platform: host.platform || "",
      avatar: avatar,
      followId: host.followId || ""
    };
  }

  function flacInMp4() {
    try {
      if (root.MediaSource && typeof root.MediaSource.isTypeSupported === "function" && root.MediaSource.isTypeSupported('audio/mp4; codecs="flac"')) return true;
    } catch (err) { /* this browser has no MediaSource check */ }
    try {
      const audio = root.Audio ? new root.Audio() : null;
      if (!audio || !audio.canPlayType) return false;
      const kind = audio.canPlayType('audio/mp4; codecs="flac"');
      return kind === "probably" || kind === "maybe";
    } catch (err) {
      return false;
    }
  }

  function loopFlacOk() {
    return player.flacBlocked ? false : flacInMp4();
  }

  function playbackOf(space) {
    const source = (space && space.source) || {};
    const allow = effectiveAllow(space);
    const row = runtime[space.id] || {};
    const status = applyDemo(space, row.status || null);
    const type = String(source.type || "");
    if (type === "youtube" && /^[A-Za-z0-9_-]{6,80}$/.test(String(source.channelId || ""))) {
      const known = !!status || source.live === true || row.fetched;
      const live = status ? status.live === true : source.live === true;
      const scheduled = !!(status && (status.scheduled === true || status.state === "scheduled") && !live);
      return { kind: "youtube", live: live && !scheduled, url: "", listeners: listenersOf(status), scheduled: scheduled, allow: allow, channelId: String(source.channelId), forced: known };
    }
    if (source.loopUrl || type === "loop") {
      const parsed = loopPlayChoice(status || {}, allow, loopFlacOk());
      return { kind: "loop", live: parsed.live, url: parsed.url, fallback: parsed.fallback, listeners: parsed.listeners, scheduled: false, allow: allow, channelId: "", forced: !!row.fetched || !!demoFor(space), reconnecting: false, version: parsed.version, duration: parsed.duration, epoch: parsed.epoch, loopSource: parsed.source || "r2" };
    }
    if (source.statusUrl) {
      const parsed = audioFromStatus(status || {}, allow);
      return { kind: "hls", live: parsed.live, url: parsed.url, listeners: parsed.listeners, scheduled: parsed.scheduled, allow: allow, channelId: "", forced: !!row.fetched || !!demoFor(space), reconnecting: !!parsed.reconnecting };
    }
    if (type === "owncast" && source.server) {
      const server = String(source.server || "").replace(/\/$/, "");
      const playlist = allowedAudio(server + "/hls/stream.m3u8", "", allow);
      const online = !!(status && (status.online === true || status.live === true));
      const listeners = status && status.viewerCount != null ? listenersOf({ listeners: status.viewerCount }) : listenersOf(status);
      return { kind: "hls", live: online && !!playlist, url: playlist, listeners: listeners, scheduled: false, allow: allow, channelId: "", forced: !!row.fetched };
    }
    if ((type === "hls" || type === "audio") && source.url) {
      const url = allowedAudio(source.url, "", allow);
      return { kind: type === "audio" && !/\.m3u8(\?|#|$)/i.test(String(source.url)) ? "audio" : "hls", live: !!url, url: url, listeners: listenersOf(status), scheduled: false, allow: allow, channelId: "", forced: true };
    }
    return { kind: "hls", live: false, url: "", listeners: null, scheduled: false, allow: allow, channelId: "", forced: !!row.fetched };
  }

  function toModel(space) {
    const play = playbackOf(space);
    const down = !!(player.linkDown && player.active && player.spaceId === space.id);
    let state = "loading";
    if (play.forced) {
      if (play.scheduled) state = "scheduled";
      else if (play.live && (play.reconnecting || down)) state = "reconnecting";
      else if (play.live) state = "live";
      else state = "ended";
    }
    const face = hostFace(space);
    return {
      id: space.id,
      kind: play.kind || "hls",
      title: space.title || productName("music"),
      cover: space.cover || face.avatar || "",
      followId: face.followId,
      host: { name: face.name, handle: face.handle, platform: face.platform, avatar: face.avatar },
      live: state === "live" || state === "reconnecting",
      state: state,
      listeners: play.listeners,
      playUrl: play.url || "",
      fallbackUrl: play.fallback || "",
      version: play.version || "",
      loopSource: play.loopSource === "tg" ? "tg" : "r2",
      duration: play.duration || 0,
      epoch: Number.isFinite(play.epoch) ? play.epoch : 0,
      allow: play.allow || [],
      channelId: play.channelId || "",
      href: "#/spaces/" + encodeURIComponent(space.id)
    };
  }

  function videoModels() {
    return extras.map((item) => ({
      id: item.id,
      kind: "video",
      title: item.title || tr("LIVE"),
      cover: "",
      followId: item.followId || "",
      host: { name: "", handle: "", platform: "", avatar: "" },
      live: !!item.live,
      state: item.live ? "live" : "ended",
      listeners: null,
      playUrl: "",
      allow: [],
      channelId: "",
      href: item.href || "#/"
    }));
  }

  function spaceModel(id) {
    const space = spaces.filter((item) => item.id === id)[0];
    return space ? toModel(space) : null;
  }

  function models() {
    return spaces.map(toModel).concat(videoModels());
  }

  function homeItems() {
    const all = models();
    const follows = [];
    all.forEach((item) => {
      if (item.followId && isFollowed(item.followId)) follows.push(item.followId);
    });
    return homePills(all, follows);
  }

  function signature() {
    return models().map((item) => [item.id, item.live, item.state, item.playUrl, item.version, item.listeners, item.title].join("~")).join("|")
      + "|" + (player.linkDown ? "1" : "0") + "|" + player.spaceId;
  }

  function maybeRender() {
    const sig = signature();
    if (sig === lastSig) return;
    if (!hooks.render) return;
    lastSig = sig;
    hooks.render();
  }

  function countLabel(n) {
    if (n == null || n === "") return "";
    const value = Math.floor(Number(n));
    if (!Number.isFinite(value) || value < 0) return "";
    const text = (typeof window !== "undefined" && window.SI18n) ? window.SI18n.formatCount(value) : String(value);
    return trn("listening", value, { count: text });
  }

  function marquee(text) {
    const safe = esc(text || "");
    return '<span class="sp-marquee" data-sp-marquee><span class="sp-marquee-clip"><span class="sp-marquee-track"><span class="sp-marquee-copy"><span class="sp-marquee-text">' + safe + '</span></span><span class="sp-marquee-copy" aria-hidden="true"><span class="sp-marquee-text">' + safe + '</span></span></span></span></span>';
  }

  function faceHtml(src, name, cls) {
    const root = typeof window === "undefined" ? null : window;
    const faces = root && root.ViktorychFaces;
    const mode = faces && faces.picture ? faces.picture(src) : (src ? "photo" : "default");
    if (mode === "none") return '<span class="ava-none"></span>';
    if (mode === "default" || !src) return '<span class="' + cls + ' ava silhouette" aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v1h16v-1c0-2.66-5.33-4-8-4z"/></svg></span>';
    return '<img class="' + cls + '" src="' + esc(src) + '" alt="" referrerpolicy="no-referrer">';
  }

  function stack(item) {
    const host = item.host || {};
    return '<span class="sp-stack">' + faceHtml(host.avatar, host.name, "sp-face") + "</span>";
  }

  function pill(item) {
    if (item.kind === "video") {
      const label = /live/i.test(item.title || "") ? item.title : (item.title || tr("LIVE")) + " LIVE";
      return '<a class="sp-pill sp-pill-video" href="' + esc(item.href || "#/") + '"><span class="sp-pill-text">' + marquee(label) + '</span><span class="sp-dot" aria-hidden="true"></span></a>';
    }
    const reconnect = item.state === "reconnecting";
    return '<a class="sp-pill' + (reconnect ? " is-reconnect" : "") + '" href="#/spaces/' + esc(item.id) + '" data-space-open="' + esc(item.id) + '" data-space-state="' + esc(item.state || "") + '">' + stack(item) + '<span class="sp-pill-text">' + marquee(item.title) + "</span>" + (reconnect ? '<span class="sp-reconnect-dot" aria-hidden="true"></span>' : "") + "</a>";
  }

  function cardHtml(item) {
    const count = countLabel(item.listeners);
    const reconnect = item.state === "reconnecting";
    return '<a class="sp-card' + (reconnect ? " is-reconnect" : "") + '" href="#/spaces/' + esc(item.id) + '" data-space-open="' + esc(item.id) + '" data-space-state="' + esc(item.state || "") + '"><span class="sp-card-top"><span class="sp-live-pill">' + tr("LIVE") + "</span>" + (reconnect ? '<span class="sp-reconnect-dot" aria-hidden="true"></span>' : "") + '<span class="sp-eq' + (reconnect ? " is-quiet" : "") + '" aria-hidden="true"><i></i><i></i><i></i><i></i></span></span><span class="sp-card-title">' + esc(item.title) + '</span><span class="sp-card-foot">' + stack(item) + (count ? '<span class="sp-count">' + esc(count) + "</span>" : "") + "</span></a>";
  }

  function homePillsHtml() {
    const items = homeItems();
    if (items.length) {
      return items.map((item) => '<div class="sp-row-item" role="listitem">' + pill(item) + "</div>").join("");
    }
    const musicSpace = spaceModel("superintelmusic") || {
      id: "superintelmusic",
      title: productName("music") || "ViktorychMusic",
      cover: "icons/space-host.jpg",
      host: { name: "Harbor", handle: "quietharbor", platform: "telegram", avatar: "icons/space-host.jpg" },
      live: true,
      state: "live",
      href: "#/spaces/superintelmusic"
    };
    return '<div class="sp-row-item" role="listitem">' + pill(musicSpace) + "</div>";
  }

  function homeRow() {
    if (root.WeatherPills && root.WeatherPills.homeRow) {
      return root.WeatherPills.homeRow();
    }
    const spacePills = homePillsHtml();
    const soccerPills = (root.SoccerScores && root.SoccerScores.pillsHtml) ? root.SoccerScores.pillsHtml() : "";
    if (!spacePills && !soccerPills) return "";
    return '<div class="sp-row-wrap" role="region" aria-label="' + esc(tr("Live")) + '"><div class="sp-row" role="list">' + spacePills + soccerPills + "</div></div>";
  }

  function rowExtra() {
    const hasSpaces = homeItems().length > 0;
    const hasScores = !!(root.SoccerScores && root.SoccerScores.loadTeams && root.SoccerScores.loadTeams().length);
    return (hasSpaces || hasScores) ? 46 : 0;
  }

  function sideCard() {
    const items = homeItems().filter((item) => item.kind !== "video");
    if (!items.length) return "";
    return items.map(cardHtml).join("");
  }

  function profileCard(platform, handle) {
    const item = models().filter((entry) => entry.kind !== "video" && profileLive(entry, platform, handle))[0];
    if (!item) return "";
    return '<div class="sp-home-slot">' + cardHtml(item) + "</div>";
  }

  function avatar(inner, platform, handle) {
    if (!inner || String(inner).indexOf("sp-live-wrap") >= 0) return inner;
    const item = models().filter((entry) => entry.kind !== "video" && profileLive(entry, platform, handle))[0];
    if (!item) return inner;
    return '<a class="sp-live-wrap" href="#/spaces/' + esc(item.id) + '" data-space-open="' + esc(item.id) + '">' + inner + ("<span class=\"sp-live-badge\"" + ">" + tr("LIVE") + "<" + "/span></a>");
  }

  function sheet(item) {
    const state = item.state || "ended";
    const host = item.host || {};
    const hostLink = host.handle ? "#/" + encodeURIComponent(host.platform || "x") + "/" + encodeURIComponent(host.handle) : "";
    const speaking = player.active && player.spaceId === item.id && (state === "live" || state === "reconnecting");
    const pulse = speaking && player.noAnalyser ? " pulse" : "";
    let body = "";
    if (state === "ended") body = ("<div class=\"sp-notice\"><h2" + ">" + tr("This Space has ended") + "<" + "/h2></div>");
    else if (state === "scheduled") body = ("<div class=\"sp-notice\"><h2" + ">" + tr("Scheduled") + "<" + "/h2></div>");
    else if (state === "loading") body = ("<div class=\"sp-notice\"><h2" + ">" + tr("Connecting…") + "<" + "/h2></div>");
    else {
      const count = countLabel(item.listeners);
      body = '<div class="sp-stage">'
        + (item.cover ? '<img class="sp-cover" src="' + esc(item.cover) + '" alt="" referrerpolicy="no-referrer">' : "")
        + ("<section class=\"sp-people\"><h2" + ">" + tr("Host") + "<" + "/h2><div class=\"sp-person\"><div class=\"sp-ava sp-speak") + pulse + '" style="--level:0"><span class="sp-ring"></span>'
        + faceHtml(host.avatar, host.name, "sp-host")
        + '</div>' + (hostLink ? '<a class="sp-name" href="' + esc(hostLink) + '">' + esc(host.name || tr("Host")) + "</a>" : '<div class="sp-name">' + esc(host.name || tr("Host")) + "</div>")
        + ("<div class=\"sp-role\"" + ">" + tr("Host") + "<" + "/div></div></section>")
        + ("<section class=\"sp-listeners\"><h2" + ">" + tr("Listeners") + "<" + "/h2>") + (count ? "<p>" + esc(count) + "</p>" : "") + "</section></div>";
    }
    const joined = player.active && player.spaceId === item.id;
    const tunable = state === "live" || state === "reconnecting";
    const controls = !tunable ? "" : joined
      ? '<div class="sp-controls"><button class="sp-round" type="button" data-space-act="mic" aria-label="' + tr("Request to speak") + '">' + svg(ICON.mic) + '</button><button class="sp-round sp-emoji-btn" type="button" data-space-act="emoji" aria-label="' + tr("React") + '">' + EMOJIS[0] + '</button><button class="sp-round" type="button" data-space-act="share" aria-label="' + tr("Share") + '">' + svg(ICON.share) + '</button><button class="sp-round" type="button" data-space-act="comment" aria-label="' + tr("Comment") + '">' + svg(ICON.comment) + "</button></div>"
      : '<div class="sp-controls"><button class="sp-start" type="button" data-space-act="listen">' + tr("Start listening") + "</button></div>";
    const reactions = EMOJIS.map((emoji) => '<button type="button" data-space-act="react" data-emoji="' + emoji + '">' + emoji + "</button>").join("");
    const reconnect = state === "reconnecting" ? '<p class="sp-reconnect" role="status">' + esc(tr("Reconnecting…")) + "</p>" : "";
    return '<div class="sp-sheet' + (state === "reconnecting" ? " is-reconnect" : "") + '" data-space-id="' + esc(item.id || "") + '" data-space-state="' + esc(state) + '"><header class="sp-sheet-bar"><button class="sp-icon" type="button" data-space-act="min" aria-label="' + tr("Minimize") + '">' + svg(ICON.down) + '</button><button class="sp-icon" type="button" data-space-act="more" aria-label="' + tr("More") + '">' + svg(ICON.more) + '</button><button class="sp-leave" type="button" data-space-act="leave">' + tr("Leave") + '</button></header><div class="sp-more" hidden><button type="button" data-space-act="copy">' + tr("Copy link") + '</button></div><div class="sp-react" hidden>' + reactions + '</div><h1 class="sp-sheet-title">' + esc(item.title || tr("Space")) + "</h1>" + reconnect + body + controls + "</div>";
  }

  function page(route) {
    const item = spaceModel(route && route.id);
    if (!item) return sheet({ id: "", title: tr("Space"), state: "ended", host: {}, cover: "" });
    return sheet(item);
  }

  function ensureDock() {
    let dock = document.getElementById("space-dock");
    if (dock) return dock;
    dock = document.createElement("div");
    dock.id = "space-dock";
    dock.hidden = true;
    document.body.appendChild(dock);
    return dock;
  }

  function ensureAudio() {
    if (player.audio) return player.audio;
    const audio = document.createElement("audio");
    audio.id = "space-audio";
    audio.crossOrigin = "anonymous";
    audio.preload = "none";
    audio.setAttribute("playsinline", "");
    audio.setAttribute("aria-hidden", "true");
    audio.addEventListener("error", onAudioError);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("waiting", onMediaWait);
    audio.addEventListener("stalled", onMediaWait);
    audio.addEventListener("ended", onMediaEnded);
    audio.addEventListener("timeupdate", onMediaTime);
    document.body.appendChild(audio);
    player.audio = audio;
    return audio;
  }

  function loadHls() {
    if (root.Hls) return Promise.resolve(root.Hls);
    if (loadHls.promise) return loadHls.promise;
    loadHls.promise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = HLS_SRC;
      script.onload = () => resolve(root.Hls || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
    return loadHls.promise;
  }

  function destroyHls() {
    player.generation += 1;
    if (player.peerRelease) {
      try { player.peerRelease(); } catch (err) { /* the mesh can already be gone */ }
      player.peerRelease = null;
    }
    if (player.hls && player.hls.destroy) {
      try { player.hls.destroy(); } catch (err) { /* already gone */ }
    }
    player.hls = null;
  }

  function isPlaylistItem(item) {
    const url = item && item.playUrl || "";
    return !item || item.kind !== "audio" || /\.m3u8(\?|#|$)/i.test(url);
  }

  function nativeHls(audio) {
    return !!(audio && (audio.canPlayType("application/vnd.apple.mpegurl") || audio.canPlayType("application/x-mpegURL")));
  }

  function bustUrl(url) {
    const hashAt = url.indexOf("#");
    const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const hash = hashAt >= 0 ? url.slice(hashAt) : "";
    return base + (base.indexOf("?") >= 0 ? "&" : "?") + "_r=" + Date.now() + hash;
  }

  function retryPolicy() {
    return { maxNumRetry: 2, retryDelayMs: 400, maxRetryDelayMs: 1500, backoff: "linear" };
  }

  function loadPolicy(firstByte, total) {
    return {
      default: {
        maxTimeToFirstByteMs: firstByte,
        maxLoadTimeMs: total,
        timeoutRetry: retryPolicy(),
        errorRetry: retryPolicy()
      }
    };
  }

  function loopRetryPolicy() {
    return {
      maxNumRetry: 1,
      retryDelayMs: 400,
      maxRetryDelayMs: 800,
      shouldRetry: function (_config, retryCount, isTimeout, response) {
        if (retryCount >= 1) return false;
        if (isTimeout) return true;
        const code = response ? Number(response.code || response.status) || 0 : 0;
        if (!code) return true;
        return code >= 400 && code <= 599;
      }
    };
  }

  function loopLoadPolicy() {
    return {
      default: {
        maxTimeToFirstByteMs: 4000,
        maxLoadTimeMs: 8000,
        timeoutRetry: loopRetryPolicy(),
        errorRetry: loopRetryPolicy()
      }
    };
  }

  function accountsApi() {
    if (root.ViktorychAccounts && root.ViktorychAccounts.currentApi) {
      const cur = root.ViktorychAccounts.currentApi();
      if (cur) return cur;
    }
    const bag = root.VIKTORYCH_ACCOUNTS || {};
    return String(bag.api || bag.backupApi || "").replace(/\/$/, "");
  }

  function telegramLoopRequest(requestUrl) {
    const api = accountsApi();
    if (!api) return false;
    let request;
    let home;
    try {
      request = new URL(requestUrl, api);
      home = new URL(api);
    } catch (err) {
      return false;
    }
    if (request.protocol !== "https:" || request.hostname !== home.hostname) return false;
    return request.pathname.indexOf("/tg/loop/") === 0;
  }

  function loopManifestPrimary(item) {
    return loopPrimaryName(item && item.loopSource);
  }

  function loopPrimaryChanged(item) {
    return !!(item && item.kind === "loop" && player.loadedPrimary && loopManifestPrimary(item) !== loopPrimaryName(player.loadedPrimary));
  }

  function loopChoice(item) {
    const plan = loopAttachPlan({
      primary: item.loopSource,
      savedPrimary: player.loadedPrimary,
      version: item.version || "",
      savedVersion: player.loopMirrorVersion || "",
      playUrl: item.playUrl,
      savedPlayUrl: player.loopMirrorPlayUrl || "",
      savedVia: player.loopVia,
      api: accountsApi()
    });
    return { via: plan.via === "telegram" ? "tg" : "r2", url: plan.url, primary: plan.primary };
  }

  function clearLoopMirror() {
    player.loadedMirror = "";
    player.loopVia = "";
    player.loopMirrorVersion = "";
    player.loopMirrorPlayUrl = "";
  }

  function applyLoopMirror(item, plan) {
    const via = plan.via === "telegram" ? "tg" : "r2";
    player.loopVia = via;
    player.loadedMirror = via === "tg" ? plan.url : "";
    player.loopMirrorVersion = item.version || "";
    player.loopMirrorPlayUrl = item.playUrl;
    player.loadedPrimary = loopManifestPrimary(item);
    player.loadedUrl = item.playUrl;
    player.loadedVersion = item.version || "";
    player.ignoreErrorUntil = Date.now() + 1500;
  }

  function engageLoopMirror(item, position, httpStatus) {
    if (!loopItem(item) || player.flacBlocked) return false;
    const status = Number(httpStatus) || 0;
    const plan = loopMirrorPlan({
      r2Url: item.playUrl,
      api: accountsApi(),
      version: item.version || "",
      primary: loopManifestPrimary(item),
      via: player.loopVia === "tg" ? "telegram" : "r2",
      failures: 2,
      network: !status,
      status: status,
      position: position
    });
    if (!plan.switched) return false;
    applyLoopMirror(item, plan);
    const seek = plan.seek > 0 ? plan.seek : loopSeek(item);
    const hls = player.hls;
    if (hls) {
      try {
        if (typeof hls.stopLoad === "function") hls.stopLoad();
        hls.config.startPosition = seek;
        hls.loadSource(plan.url);
        hls.startLoad(seek);
        return true;
      } catch (err) {
        clearLoopMirror();
        return false;
      }
    }
    const audio = player.audio;
    if (!audio) return false;
    audio.src = plan.url;
    const generation = player.generation;
    const onMeta = () => {
      audio.removeEventListener("loadedmetadata", onMeta);
      if (generation !== player.generation || !player.active) return;
      try { audio.currentTime = seek; } catch (err) { /* not seekable yet */ }
      kickPlay(audio);
    };
    audio.addEventListener("loadedmetadata", onMeta);
    try { audio.load(); } catch (err) { /* the element will still try src */ }
    return true;
  }

  function loopItem(item) {
    return !!(item && item.kind === "loop" && item.duration > 0 && Number.isFinite(item.epoch));
  }

  function seekLoopClock(audio, item) {
    if (!audio || !loopItem(item)) return;
    try { audio.currentTime = loopSeek(item); } catch (err) { /* not seekable yet */ }
  }

  function syncLoopClock() {
    if (!player.active || player.pausedByUser) return;
    const item = spaceModel(player.spaceId);
    const audio = player.audio;
    if (!loopItem(item) || !audio || audio.paused || audio.ended) return;
    if (Math.abs(loopDrift(audio.currentTime || 0, item)) > LOOP_DRIFT_S) seekLoopClock(audio, item);
  }

  function wrapLoop(audio) {
    if (!audio) return;
    try { audio.currentTime = 0; } catch (err) { /* ignore */ }
    kickPlay(audio);
  }

  function attach(item, bust) {
    const audio = ensureAudio();
    const url = item.playUrl;
    const allow = item.allow || [];
    destroyHls();
    const frame = document.getElementById("space-yt");
    if (frame) frame.remove();
    player.loadedUrl = url;
    player.loadedVersion = item.version || "";
    player.lastSn = null;
    player.lastTime = 0;
    player.progressAt = Date.now();
    audio.preload = "auto";
    const playlist = isPlaylistItem(item);
    const loop = loopItem(item);
    const previousVia = player.loopVia;
    const choice = loop ? loopChoice(item) : null;
    if (choice) {
      player.loopVia = choice.via;
      player.loadedPrimary = choice.primary;
      player.loopMirrorVersion = item.version || "";
      player.loopMirrorPlayUrl = item.playUrl;
      player.loadedMirror = choice.via === "tg" ? choice.url : "";
    }
    const held = audio.currentTime > 0 ? audio.currentTime : 0;
    const mirror = choice && choice.via === "tg" ? choice.url : "";
    const Hls = root.Hls;
    if (playlist && Hls && Hls.isSupported()) {
      const generation = player.generation;
      const shared = {
        enableWorker: false,
        maxBufferLength: 60,
        backBufferLength: 30,
        xhrSetup: (xhr, requestUrl) => {
          if (telegramLoopRequest(requestUrl)) {
            const token = root.ViktorychAccounts && root.ViktorychAccounts.token ? root.ViktorychAccounts.token() : "";
            if (token) {
              try { xhr.setRequestHeader("Authorization", "Bearer " + token); } catch (err) { /* optional on the public loop */ }
            }
            return;
          }
          if (allowedAudio(requestUrl, url, allow)) return;
          xhr.send = function () {};
          try { xhr.abort(); } catch (err) { /* blocked host */ }
        }
      };
      const hls = new Hls(loop ? Object.assign({
        startPosition: previousVia === (choice && choice.via) && held ? held : loopSeek(item),
        maxBufferHole: 0.5,
        manifestLoadPolicy: loopLoadPolicy(),
        playlistLoadPolicy: loopLoadPolicy(),
        fragLoadPolicy: loopLoadPolicy()
      }, shared) : Object.assign({
        lowLatencyMode: false,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxMaxBufferLength: 120,
        maxBufferHole: 0.5,
        nudgeOffset: 0.1,
        nudgeMaxRetry: 8,
        highBufferWatchdogPeriod: 2,
        liveDurationInfinity: true,
        manifestLoadPolicy: loadPolicy(4000, 8000),
        playlistLoadPolicy: loadPolicy(4000, 8000),
        fragLoadPolicy: loadPolicy(6000, 12000)
      }, shared));
      if (!loop && root.ViktorychPeer) {
        player.hls = hls;
        if (root.ViktorychPeerMedia && root.ViktorychPeerMedia.applyHls) root.ViktorychPeerMedia.applyHls(hls, Hls);
        if (root.ViktorychPeer.ready) {
          const playUrl = mirror ? mirror : (bust ? bustUrl(url) : url);
          root.ViktorychPeer.ready().then((mod) => {
            if (!mod || generation !== player.generation || player.hls !== hls) return;
            if (mod.applyHls) mod.applyHls(hls, Hls);
            if (player.peerRelease) { try { player.peerRelease(); } catch (err) { /* replaced */ } }
            player.peerRelease = mod.watch ? mod.watch(playUrl) : null;
          });
        }
      }
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (generation !== player.generation || !data) return;
        if (Date.now() < player.ignoreErrorUntil) return;
        const details = data.details || "";
        const response = data.response || null;
        const httpStatus = response ? Number(response.code || response.status) || 0 : (data.networkDetails && Number(data.networkDetails.status)) || 0;
        const missing = httpStatus === 404 || httpStatus === 410;
        if (loop && (details === "manifestIncompatibleCodecsError" || (data.fatal && data.type === "mediaError"))) {
          const current = spaceModel(player.spaceId);
          if (current && current.fallbackUrl && current.fallbackUrl !== current.playUrl) player.flacBlocked = true;
        }
        if (!data.fatal) {
          if (loop && missing) return;
          if ((details === "bufferStalledError" || details === "bufferSeekOverHole" || details === "bufferNudgeOnStall") && Date.now() - player.progressAt > 7000) {
            scheduleRecover("stall", httpStatus);
          }
          return;
        }
        if (loop && data.type === "networkError") {
          const position = audio.currentTime > 0 ? audio.currentTime : loopSeek(item);
          if (engageLoopMirror(item, position, httpStatus)) return;
        }
        if (data.type === "mediaError") scheduleRecover("media", httpStatus);
        else if (data.type === "networkError") scheduleRecover("network", httpStatus);
        else scheduleRecover("fatal", httpStatus);
      });
      hls.on(Hls.Events.LEVEL_UPDATED, (_evt, data) => {
        if (generation !== player.generation || loop) return;
        const details = data && data.details;
        if (!details) return;
        const seq = details.startSN;
        const count = details.fragments && details.fragments.length;
        const prev = player.lastSn;
        player.lastSn = seq;
        if (playlistJumped(prev, seq, count)) scheduleRecover("jump");
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (generation !== player.generation || !player.active || player.pausedByUser) return;
        if (loop && !player.loadedMirror) seekLoopClock(audio, item);
        kickPlay(audio);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (generation !== player.generation) return;
        player.fragOk = true;
      });
      hls.loadSource(mirror ? mirror : (bust ? bustUrl(url) : url));
      hls.attachMedia(audio);
      player.hls = hls;
      return;
    }
    if (playlist && nativeHls(audio)) {
      audio.src = mirror ? mirror : (bust ? bustUrl(url) : url);
      if (loop) {
        const generation = player.generation;
        const onMeta = () => {
          audio.removeEventListener("loadedmetadata", onMeta);
          if (generation !== player.generation || !player.active) return;
          if (mirror && held) {
            try { audio.currentTime = held; } catch (err) { /* not seekable yet */ }
            return;
          }
          seekLoopClock(audio, item);
        };
        audio.addEventListener("loadedmetadata", onMeta);
      }
      try { audio.load(); } catch (err) { /* the element will still try src */ }
      return;
    }
    if (!playlist) {
      audio.src = url;
      try { audio.load(); } catch (err) { /* ignore */ }
      return;
    }
    scheduleRecover("unsupported");
  }

  function mountYoutube(channelId) {
    destroyHls();
    if (player.audio) {
      player.audio.pause();
      player.audio.removeAttribute("src");
    }
    player.loadedUrl = "";
    player.loadedVersion = "";
    player.noAnalyser = true;
    let frame = document.getElementById("space-yt");
    const src = "https://www.youtube-nocookie.com/embed/live_stream?channel=" + encodeURIComponent(channelId) + "&autoplay=1&playsinline=1";
    if (!frame) {
      frame = document.createElement("iframe");
      frame.id = "space-yt";
      frame.className = "sp-yt";
      frame.title = "";
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
      frame.allowFullscreen = true;
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      document.body.appendChild(frame);
    } else {
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.referrerPolicy = "strict-origin-when-cross-origin";
    }
    if (frame.src !== src) frame.src = src;
  }

  function ensureAnalyser() {
    if (player.analyser || player.noAnalyser || !player.audio) return;
    if (typeof window !== "undefined" && window.isTorBrowser && window.isTorBrowser()) { player.noAnalyser = true; return; }
    const Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) { player.noAnalyser = true; return; }
    try {
      const ctx = player.ctx || new Ctx();
      player.ctx = ctx;
      const source = ctx.createMediaElementSource(player.audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      player.analyser = analyser;
      player.time = new Uint8Array(analyser.fftSize);
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch (err) {
      player.noAnalyser = true;
    }
  }

  function paintLevel() {
    let level = 0;
    if (player.analyser && player.audio && !player.audio.paused) {
      try {
        player.analyser.getByteTimeDomainData(player.time);
        let sum = 0;
        for (let i = 0; i < player.time.length; i++) {
          const v = (player.time[i] - 128) / 128;
          sum += v * v;
        }
        level = Math.min(1, Math.sqrt(sum / player.time.length) * 3.4);
      } catch (err) {
        player.noAnalyser = true;
      }
    }
    const pulse = !!(player.noAnalyser && player.active && player.audio && !player.audio.paused);
    document.querySelectorAll(".sp-speak").forEach((node) => {
      node.style.setProperty("--level", level.toFixed(3));
      node.classList.toggle("pulse", pulse);
    });
  }

  function startLevel() {
    if (player.raf) return;
    const loop = () => {
      player.raf = 0;
      paintLevel();
      if (player.active && player.audio && !player.audio.paused) player.raf = requestAnimationFrame(loop);
    };
    player.raf = requestAnimationFrame(loop);
  }

  function artworkType(src) {
    if (/\.png(\?|$)/i.test(src)) return "image/png";
    if (/\.webp(\?|$)/i.test(src)) return "image/webp";
    return "image/jpeg";
  }

  function syncSession() {
    if (!navigator.mediaSession || !player.active) return;
    const item = spaceModel(player.spaceId);
    if (!item) return;
    const cover = item.cover || (item.host && item.host.avatar) || "";
    let art = "";
    try { if (cover) art = new URL(cover, location.href).href; } catch (err) { art = ""; }
    const artwork = art ? [{ src: art, sizes: "320x320", type: artworkType(art) }] : [];
    try {
      navigator.mediaSession.metadata = new root.MediaMetadata({
        title: item.title || productName("music"),
        artist: (item.host && item.host.name) || "",
        artwork: artwork
      });
      const setHandler = (name, fn) => {
        try { navigator.mediaSession.setActionHandler(name, fn); } catch (err) { /* unsupported */ }
      };
      setHandler("play", () => resume());
      setHandler("pause", () => pause());
      navigator.mediaSession.playbackState = player.pausedByUser ? "paused" : "playing";
    } catch (err) { /* metadata is optional */ }
  }

  function clearSession() {
    if (!navigator.mediaSession) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
    } catch (err) { /* ignore */ }
  }

  function noteReconnecting() {
    if (!player.active || player.linkDown) return;
    player.linkDown = true;
    player.dockKey = "";
    syncSession();
    maybeRender();
  }

  function clearRecover() {
    clearTimeout(player.recoverTimer);
    player.recoverTimer = 0;
    clearTimeout(player.waitTimer);
    player.waitTimer = 0;
    player.recoverSeq += 1;
    player.recovering = false;
  }

  function scheduleRecover(reason, httpStatus) {
    if (!player.active || player.pausedByUser) return;
    noteReconnecting();
    player.recoveredFor = 0;
    player.fragOk = false;
    const item = spaceModel(player.spaceId);
    const status = Number(httpStatus) || 0;
    const urgent = !!(item && item.kind === "loop" && loopNeedsRefresh(reason, status));
    if (player.recoverTimer || player.recovering) {
      if (!(urgent && !loopNeedsRefresh(player.recoverReason, player.recoverStatus))) return;
      clearTimeout(player.recoverTimer);
      player.recoverTimer = 0;
    }
    player.recoverReason = reason || "";
    player.recoverStatus = status;
    const delay = urgent && player.recoverFails < 1 ? 250 : [1200, 3000, 5000, 8000, 12000][Math.min(player.recoverFails, 4)];
    player.recoverSeq += 1;
    const seq = player.recoverSeq;
    player.recoverTimer = setTimeout(() => {
      player.recoverTimer = 0;
      recoverPlayback(reason, status, seq);
    }, delay);
  }

  function kickPlay(audio) {
    if (!audio || !player.active || player.pausedByUser) return;
    const pending = audio.play();
    if (pending && pending.catch) {
      pending.catch((err) => {
        if (err && err.name === "NotAllowedError") {
          noteReconnecting();
          return;
        }
        scheduleRecover("play");
      });
    }
    if (player.ctx && player.ctx.state === "suspended") player.ctx.resume().catch(() => {});
  }

  function markProgress() {
    player.progressAt = Date.now();
    const wasDown = player.linkDown || player.recoverFails || player.mediaFixes || player.softLoads;
    player.linkDown = false;
    player.recoverFails = 0;
    player.mediaFixes = 0;
    player.softLoads = 0;
    player.recoveredFor = 0;
    clearTimeout(player.waitTimer);
    player.waitTimer = 0;
    if (!wasDown) return;
    player.dockKey = "";
    syncSession();
    maybeRender();
  }

  async function refreshLoopSource(spaceId) {
    const space = spaces.filter((item) => item && item.id === spaceId)[0];
    if (!space) return false;
    const source = space.source || {};
    if (!(source.loopUrl || source.type === "loop")) return false;
    const allow = effectiveAllow(space);
    const url = resolveStatusUrl(source.loopUrl, allow);
    if (!url) return false;
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const doc = await res.json();
      // status.json is live:false and has no loop url. Keep the last manifest.
      if (!loopManifestDoc(doc)) throw new Error("loop");
      const row = runtime[space.id] || (runtime[space.id] = { errors: 0, nextAt: 0, status: null, fetched: false });
      row.status = applyDemo(space, doc);
      row.fetched = true;
      row.errors = 0;
      row.nextAt = Date.now() + LOOP_RECHECK_MS;
      return true;
    } catch (err) {
      return false;
    }
  }

  async function recoverPlayback(reason, httpStatus, seq) {
    if (!player.active || player.pausedByUser) return;
    if (seq && seq !== player.recoverSeq) return;
    player.recovering = true;
    try {
      const preliminary = spaceModel(player.spaceId);
      if (preliminary && preliminary.kind === "loop" && loopNeedsRefresh(reason, httpStatus)) {
        await refreshLoopSource(player.spaceId);
        if (!player.active || player.pausedByUser || (seq && seq !== player.recoverSeq)) return;
      }
      const item = spaceModel(player.spaceId);
      if (!item || item.kind === "youtube" || !item.live || !item.playUrl) {
        if (preliminary && preliminary.kind === "loop" && (!item || !item.live)) {
          player.linkDown = false;
          if (player.audio && !player.audio.paused) player.audio.pause();
          syncSession();
          maybeRender();
        }
        return;
      }
      const audio = ensureAudio();
      if (item.kind === "loop") {
        const plan = loopRecovery(
          { live: true, url: player.loadedUrl, version: player.loadedVersion },
          (runtime[player.spaceId] && runtime[player.spaceId].status) || null,
          item.allow || [],
          reason,
          httpStatus,
          loopFlacOk()
        );
        if (plan.swap) {
          player.recoverFails += 1;
          player.mediaFixes = 0;
          player.softLoads = 0;
          player.lastSn = null;
          player.loadedUrl = "";
          player.ignoreErrorUntil = Date.now() + 800;
          noteReconnecting();
          attach(item, true);
          seekLoopClock(audio, item);
          kickPlay(audio);
          return;
        }
      }
      player.recoverFails += 1;
      noteReconnecting();
      const plan = recoverPlan(reason, {
        hasHls: !!player.hls,
        mediaFixes: player.mediaFixes,
        softLoads: player.softLoads
      });
      if (plan === "media" && player.hls) {
        player.mediaFixes += 1;
        try {
          player.hls.recoverMediaError();
          kickPlay(audio);
          return;
        } catch (err) { /* fall through to a fresh player */ }
      } else if (plan === "reload" && player.hls) {
        player.softLoads += 1;
        if (item.kind === "loop") {
          player.loadedUrl = "";
          attach(item, true);
          seekLoopClock(audio, item);
          kickPlay(audio);
          return;
        }
        try {
          player.hls.stopLoad();
          player.hls.startLoad(-1);
          kickPlay(audio);
          return;
        } catch (err) { /* fall through to a fresh player */ }
      }
      player.mediaFixes = 0;
      player.softLoads = 0;
      player.lastSn = null;
      player.loadedUrl = "";
      player.ignoreErrorUntil = Date.now() + 800;
      attach(item, true);
      if (item.kind === "loop") seekLoopClock(audio, item);
      kickPlay(audio);
    } finally {
      if (!seq || seq === player.recoverSeq) player.recovering = false;
    }
  }

  function onAudioError() {
    if (!player.active || player.pausedByUser || Date.now() < player.ignoreErrorUntil) return;
    const audio = player.audio;
    const item = spaceModel(player.spaceId);
    if (item && item.kind === "loop") {
      if (audio && audio.crossOrigin) {
        player.corsRetried = true;
        player.noAnalyser = true;
        audio.crossOrigin = null;
      }
      if (player.hls) return;
      const position = audio && audio.currentTime > 0 ? audio.currentTime : loopSeek(item);
      if (engageLoopMirror(item, position, 0)) return;
      scheduleRecover("network");
      return;
    }
    if (audio && !player.corsRetried && audio.crossOrigin) {
      player.corsRetried = true;
      player.noAnalyser = true;
      audio.crossOrigin = null;
      if (item && item.playUrl) {
        player.loadedUrl = "";
        attach(item, true);
        kickPlay(audio);
        return;
      }
    }
    scheduleRecover(player.hls ? "media" : "network");
  }

  function onMediaWait() {
    if (!player.active || player.pausedByUser || player.waitTimer) return;
    player.waitTimer = setTimeout(() => {
      player.waitTimer = 0;
      if (!player.active || player.pausedByUser) return;
      if (Date.now() - player.progressAt < 7000) return;
      scheduleRecover("stall");
    }, 7000);
  }

  function onMediaEnded() {
    if (!player.active || player.pausedByUser || Date.now() < player.ignoreErrorUntil) return;
    if (loopItem(spaceModel(player.spaceId))) { wrapLoop(player.audio); return; }
    scheduleRecover("ended");
  }

  function noteTime(t) {
    const backwards = player.lastTime > 1 && t + 1 < player.lastTime;
    if (!backwards && t <= player.lastTime + 0.12) return;
    const delta = backwards ? 1 : t - player.lastTime;
    player.lastTime = t;
    const recovering = !!(player.linkDown || player.recoverFails || player.mediaFixes || player.softLoads);
    if (recovering && !player.fragOk && player.hls) return;
    player.progressAt = Date.now();
    clearTimeout(player.waitTimer);
    player.waitTimer = 0;
    if (!recovering) return;
    player.recoveredFor += delta;
    if (player.recoveredFor < 1) return;
    player.recoveredFor = 0;
    player.fragOk = false;
    markProgress();
  }

  function onMediaTime() {
    const audio = player.audio;
    if (!audio || !player.active || audio.paused) return;
    noteTime(audio.currentTime || 0);
  }

  function onPlaying() {
    if (!player.active) return;
    player.progressAt = Date.now();
    if (!player.hls) player.fragOk = true;
    if (player.audio) player.lastTime = Math.max(player.lastTime, player.audio.currentTime || 0);
    ensureAnalyser();
    startLevel();
    syncSession();
    fillDock();
  }

  function watchPlayback() {
    if (!player.active || player.pausedByUser) return;
    const item = spaceModel(player.spaceId);
    if (!item || item.kind === "youtube" || !item.live || !item.playUrl) return;
    const audio = player.audio;
    if (!audio) return;
    if (loopItem(item) && audio.ended) { wrapLoop(audio); return; }
    const t = audio.currentTime || 0;
    if (!audio.paused && !audio.ended && (t > player.lastTime + 0.12 || (player.lastTime > 1 && t + 1 < player.lastTime))) {
      noteTime(t);
      return;
    }
    if (Date.now() - player.progressAt < 8000) return;
    scheduleRecover(audio.ended ? "ended" : "watch");
  }

  function nudgeIfQuiet() {
    if (!player.active || player.pausedByUser) return;
    const audio = player.audio;
    const quiet = !audio || audio.paused || audio.ended || Date.now() - player.progressAt > 8000;
    if (quiet) scheduleRecover("resume");
  }

  function listen(id) {
    const item = spaceModel(id);
    if (!item || (item.state !== "live" && item.state !== "reconnecting")) return;
    player.active = true;
    player.spaceId = id;
    player.pausedByUser = false;
    player.linkDown = false;
    player.recoverFails = 0;
    player.mediaFixes = 0;
    player.softLoads = 0;
    player.progressAt = Date.now();
    clearRecover();
    if (item.kind === "youtube") {
      if (!item.channelId) return;
      mountYoutube(item.channelId);
      syncSession();
      fillDock();
      return;
    }
    if (!item.playUrl || !allowedAudio(item.playUrl, "", item.allow)) return;
    const audio = ensureAudio();
    const playlist = isPlaylistItem(item);
    const ready = () => {
      if (!player.active || player.spaceId !== id) return;
      if (player.loadedUrl !== item.playUrl) attach(item, false);
      kickPlay(audio);
      startLevel();
      syncSession();
      fillDock();
    };
    if (playlist && !(root.Hls && root.Hls.isSupported()) && !nativeHls(audio)) {
      loadHls().then(ready);
      return;
    }
    ready();
    if (Date.now() - lastPoll > 15000) arm(500);
  }

  function pause() {
    player.pausedByUser = true;
    clearRecover();
    if (player.audio) player.audio.pause();
    syncSession();
    fillDock();
  }

  function resume() {
    if (!player.active) return;
    player.pausedByUser = false;
    player.progressAt = Date.now();
    const item = spaceModel(player.spaceId);
    if (!item || item.kind === "youtube") {
      syncSession();
      fillDock();
      return;
    }
    if (!item.live || !item.playUrl) return;
    const audio = ensureAudio();
    if (loopItem(item)) {
      if (player.loadedUrl !== item.playUrl || (item.version || "") !== player.loadedVersion || loopPrimaryChanged(item)) attach(item, false);
      else seekLoopClock(audio, item);
    } else if (player.loadedUrl !== item.playUrl) attach(item, false);
    kickPlay(audio);
    startLevel();
    syncSession();
    fillDock();
  }

  function stopPlayback() {
    player.active = false;
    player.pausedByUser = false;
    player.linkDown = false;
    player.loadedUrl = "";
    player.loadedVersion = "";
    player.dockKey = "";
    player.recoverFails = 0;
    player.mediaFixes = 0;
    player.softLoads = 0;
    player.lastSn = null;
    player.lastTime = 0;
    player.progressAt = 0;
    clearRecover();
    destroyHls();
    const frame = document.getElementById("space-yt");
    if (frame) frame.remove();
    if (player.audio) {
      player.audio.pause();
      player.audio.removeAttribute("src");
      try { player.audio.load(); } catch (err) { /* ignore */ }
    }
    clearSession();
    const dock = document.getElementById("space-dock");
    if (dock) {
      dock.hidden = true;
      dock.classList.remove("is-reconnect");
    }
    document.body.classList.remove("space-docked");
  }

  function fillDock() {
    const dock = ensureDock();
    const item = player.active ? spaceModel(player.spaceId) : null;
    if (!item) { dock.hidden = true; return; }
    const reconnect = item.state === "reconnecting";
    const key = item.id + "|" + item.state + "|" + item.title + "|" + ((item.host && item.host.avatar) || "") + "|" + (player.audio && player.audio.paused ? "1" : "0");
    if (player.dockKey === key && dock.childElementCount) return;
    player.dockKey = key;
    const playing = player.audio && !player.audio.paused;
    dock.classList.toggle("is-reconnect", reconnect);
    const status = reconnect ? '<span class="sp-reconnect sp-reconnect-dock">' + esc(tr("Reconnecting…")) + "</span>" : "";
    dock.innerHTML = '<a class="sp-dock-open" href="#/spaces/' + esc(item.id) + '" data-space-open="' + esc(item.id) + '">' + stack(item) + '<span class="sp-dock-copy"><span class="sp-dock-title">' + marquee(item.title) + "</span>" + status + "</span></a><button class=\"sp-icon\" type=\"button\" data-space-act=\"" + (playing ? "pause" : "play") + '" aria-label="' + (playing ? tr("Pause") : tr("Play")) + '">' + svg(playing ? ICON.pause : ICON.play) + '</button><button class="sp-icon" type="button" data-space-open="' + esc(item.id) + '" aria-label="' + tr("Expand") + '">' + svg(ICON.up) + "</button>";
    bindMarquees(dock);
  }

  function syncDock(route) {
    const open = !!(route && route.name === "spaces");
    document.body.classList.toggle("space-open", open);
    const dock = ensureDock();
    const show = player.active && !open;
    dock.hidden = !show;
    document.body.classList.toggle("space-docked", show);
    if (show) fillDock();
  }

  function shareUrl(id) {
    let base = location.origin + location.pathname;
    if (hooks.shareRoot) {
      try { base = hooks.shareRoot(); } catch (err) { /* fall through */ }
    }
    if (!String(base).endsWith("/")) base += "/";
    return base + "s/space-" + encodeURIComponent(id) + ".html";
  }

  function copyText(url) {
    const done = () => { if (hooks.toast) hooks.toast(tr("Copied link")); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => {
        const input = document.createElement("textarea");
        input.value = url;
        document.body.appendChild(input);
        input.select();
        try { document.execCommand("copy"); } catch (err) { /* ignore */ }
        input.remove();
        done();
      });
      return;
    }
    done();
  }

  function share(id) {
    const item = spaceModel(id);
    const url = shareUrl(id);
    const title = (item && item.title) || productName("music");
    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch((err) => {
        if (err && err.name === "AbortError") return;
        copyText(url);
      });
      return;
    }
    copyText(url);
  }

  function burst(emoji, x, y) {
    const el = document.createElement("span");
    el.className = "sp-burst";
    el.textContent = emoji;
    const z = parseFloat(document.documentElement.style.zoom);
    const scale = z > 0 ? z : 1;
    el.style.left = (x / scale) + "px";
    el.style.top = (y / scale) + "px";
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1100);
  }

  function leave() {
    const back = player.returnHash && player.returnHash.indexOf("#/spaces/") !== 0 ? player.returnHash : "#/";
    stopPlayback();
    if ((location.hash || "") !== back) location.hash = back;
    else if (hooks.render) hooks.render();
  }

  function minimize() {
    const back = player.returnHash && player.returnHash.indexOf("#/spaces/") !== 0 ? player.returnHash : "#/";
    if ((location.hash || "") !== back) location.hash = back;
  }

  function onSpaceOpen(el) {
    const id = el.getAttribute("data-space-open") || "";
    if ((location.hash || "").indexOf("#/spaces/") !== 0) player.returnHash = location.hash || "#/";
    const item = spaceModel(id);
    if (item && (item.state === "live" || item.state === "reconnecting")) listen(id);
    const hash = "#/spaces/" + encodeURIComponent(id);
    if ((location.hash || "") !== hash) location.hash = hash;
    else if (hooks.render) hooks.render();
  }

  function onSpaceAct(el) {
    const act = el.getAttribute("data-space-act");
    const sheetEl = document.querySelector(".sp-sheet");
    const id = (sheetEl && sheetEl.getAttribute("data-space-id")) || player.spaceId;
    if (act === "listen") { listen(id); if (hooks.render) hooks.render(); return; }
    if (act === "leave") { leave(); return; }
    if (act === "min") { minimize(); return; }
    if (act === "pause") { pause(); return; }
    if (act === "play") { resume(); return; }
    if (act === "share" || act === "copy") { share(id); closePopups(); return; }
    if (act === "mic") { if (hooks.toast) hooks.toast(tr("Request to speak isn’t available.")); return; }
    if (act === "comment") { if (hooks.toast) hooks.toast(tr("Replies aren’t available in this Space.")); return; }
    if (act === "more") {
      const menu = document.querySelector(".sp-more");
      if (menu) menu.hidden = !menu.hidden;
      const react = document.querySelector(".sp-react");
      if (react) react.hidden = true;
      return;
    }
    if (act === "emoji") {
      const react = document.querySelector(".sp-react");
      if (react) react.hidden = !react.hidden;
      const menu = document.querySelector(".sp-more");
      if (menu) menu.hidden = true;
      return;
    }
    if (act === "react") {
      const emoji = el.getAttribute("data-emoji") || "";
      if (EMOJIS.indexOf(emoji) < 0) return;
      const rect = el.getBoundingClientRect();
      burst(emoji, rect.left + rect.width / 2, rect.top);
      const react = document.querySelector(".sp-react");
      if (react) react.hidden = true;
    }
  }

  function closePopups() {
    document.querySelectorAll(".sp-more, .sp-react").forEach((el) => { el.hidden = true; });
  }

  function targetEl(event) {
    const node = event.target;
    if (!node) return null;
    if (node.closest) return node;
    return node.parentElement || null;
  }

  function applyMarquee(el) {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const clip = el.querySelector(".sp-marquee-clip");
    const text = el.querySelector(".sp-marquee-text");
    if (!clip || !text) return;
    if (clip.clientWidth < 2) {
      el.classList.remove("is-on");
      if (!el.dataset.marqueeWait) {
        el.dataset.marqueeWait = "1";
        requestAnimationFrame(() => applyMarquee(el));
      }
      return;
    }
    delete el.dataset.marqueeWait;
    const previousDisplay = text.style.display;
    const previousSpace = text.style.whiteSpace;
    text.style.display = "inline-block";
    text.style.whiteSpace = "nowrap";
    const overflow = text.scrollWidth - clip.clientWidth;
    text.style.display = previousDisplay;
    text.style.whiteSpace = previousSpace;
    const plan = marqueePlan(overflow, reduced);
    el.classList.toggle("is-on", !!plan.animate);
    const track = el.querySelector(".sp-marquee-track");
    if (track) {
      track.style.animationDuration = plan.animate ? plan.duration + "s" : "0s";
      track.style.animationTimingFunction = plan.easing || "linear";
    }
    const paused = document.hidden || el.classList.contains("is-offscreen");
    el.classList.toggle("is-paused", paused);
  }

  let marqueeHoldBound = false;

  function marqueeHost(event) {
    const raw = event && event.target;
    const node = raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement);
    if (!node || !node.closest) return null;
    return node.closest(".sp-pill, .sc-pill, .wx-pill");
  }

  function bindMarqueeHold() {
    if (marqueeHoldBound) return;
    if (!window || typeof window.addEventListener !== "function") return;
    marqueeHoldBound = true;
    // The row is swapped out from under the per-pill listeners when weather
    // or scores refresh. Pausing from the window keeps a press on the pill
    // that is on screen now, including one that was just rebuilt.
    window.addEventListener("pointerdown", (event) => {
      const host = marqueeHost(event);
      if (!host) return;
      host.querySelectorAll("[data-sp-marquee]").forEach((el) => el.classList.add("is-held"));
    });
    window.addEventListener("pointerup", (event) => {
      const host = marqueeHost(event);
      if (!host) return;
      host.querySelectorAll("[data-sp-marquee]").forEach((el) => el.classList.remove("is-held"));
    });
    window.addEventListener("pointercancel", () => {
      document.querySelectorAll("[data-sp-marquee].is-held").forEach((el) => el.classList.remove("is-held"));
    });
  }

  function bindMarquees(scope) {
    const rootEl = scope || document;
    bindMarqueeHold();
    rootEl.querySelectorAll("[data-sp-marquee]").forEach((el) => {
      if (seenMarquee.has(el)) { applyMarquee(el); return; }
      seenMarquee.add(el);
      const hold = (on) => { el.classList.toggle("is-held", on); };
      const host = el.closest(".sp-pill, .sc-pill, .wx-pill") || el;
      host.addEventListener("pointerdown", () => hold(true));
      host.addEventListener("pointerup", () => hold(false));
      host.addEventListener("pointercancel", () => hold(false));
      // A layout shift during pointerdown can emit pointerleave before the
      // press handler finishes. Clear on the next turn so the press still
      // pauses the marquee that was hit.
      host.addEventListener("pointerleave", () => { queueMicrotask(() => hold(false)); });
      const clip = el.querySelector(".sp-marquee-clip");
      const text = el.querySelector(".sp-marquee-text");
      if (clip && root.ResizeObserver) new root.ResizeObserver(() => applyMarquee(el)).observe(clip);
      if (text && root.MutationObserver) new root.MutationObserver(() => applyMarquee(el)).observe(text, { childList: true, characterData: true, subtree: true });
      if (!io && root.IntersectionObserver) {
        io = new root.IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            entry.target.classList.toggle("is-offscreen", !entry.isIntersecting);
            entry.target.classList.toggle("is-paused", document.hidden || !entry.isIntersecting);
          });
        });
      }
      if (io) io.observe(el);
      applyMarquee(el);
    });
  }

  function pauseMarquees() {
    document.querySelectorAll("[data-sp-marquee]").forEach((el) => {
      el.classList.toggle("is-paused", document.hidden || el.classList.contains("is-offscreen"));
    });
  }

  function arm(ms) {
    // Nothing polls until the shell starts Spaces (it stays off when the Home pills row is off).
    if (!started) return;
    clearTimeout(timer);
    timer = setTimeout(runPoll, ms);
  }

  function armNext() {
    if (!configOk) { arm(configErrors ? [8000, 20000, 45000][Math.min(configErrors - 1, 2)] : 8000); return; }
    const now = Date.now();
    let wait = document.hidden ? 120000 : 35000;
    const activeItem = player.active ? spaceModel(player.spaceId) : null;
    const loopListening = !!(activeItem && activeItem.kind === "loop" && !player.pausedByUser);
    let hot = !!(player.active && !player.pausedByUser && !loopListening);
    Object.keys(runtime).forEach((id) => {
      const row = runtime[id];
      if (row && row.nextAt) wait = Math.min(wait, Math.max(0, row.nextAt - now));
      const doc = row && row.status;
      if (doc && doc.live === true && doc.mode !== "loop" && statusStale(doc, now) && !statusOffline(doc, now)) hot = true;
    });
    if (hot) wait = Math.min(wait, 20000);
    else if (document.hidden) wait = Math.max(wait, 120000);
    arm(wait < 1000 ? 1000 : wait);
  }

  /* The catalog changes a few times a day. The status poll runs every 35
     seconds, so the catalog is reused for five minutes (or until the change
     signal says feeds.config.json moved) instead of read on every round. */
  let catalogDoc = null;
  let catalogAt = 0;
  let catalogMark = "";
  function catalogFresh(now) {
    if (!catalogDoc) return false;
    const pulse = root.ViktorychPulse;
    if (pulse && pulse.ok && pulse.ok()) {
      const mark = pulse.version("config");
      if (mark && mark !== catalogMark) return false;
      return now - catalogAt < 30 * 60 * 1000;
    }
    return now - catalogAt < 5 * 60 * 1000;
  }
  async function loadCatalog() {
    const now = Date.now();
    let doc = catalogFresh(now) ? catalogDoc : null;
    if (!doc) {
      const pulse = root.ViktorychPulse;
      const mark = pulse && pulse.version ? pulse.version("config") : "";
      const url = new URL("feeds.config.json", new URL(".", location.href));
      url.searchParams.set("_", String(now));
      const res = await fetch(url.href, { cache: "no-store" });
      if (!res.ok) throw new Error("config");
      doc = await res.json();
      catalogDoc = doc;
      catalogAt = now;
      catalogMark = mark || "";
    }
    const list = Array.isArray(doc.spaces) ? doc.spaces : [];
    spaces = list.filter((item) => item && /^[A-Za-z0-9_-]{1,120}$/.test(String(item.id || ""))).map((item) => ({
      id: String(item.id),
      title: String(item.title || productName("music")),
      cover: typeof item.cover === "string" ? item.cover : "",
      host: {
        name: item.host && item.host.name ? String(item.host.name) : "",
        handle: item.host && item.host.handle ? String(item.host.handle).replace(/^@/, "") : "",
        platform: item.host && item.host.platform ? String(item.host.platform) : "",
        followId: item.host && item.host.followId ? String(item.host.followId) : "",
        avatar: item.host && item.host.avatar ? String(item.host.avatar) : ""
      },
      source: {
        type: item.source && item.source.type ? String(item.source.type) : "",
        statusUrl: item.source && item.source.statusUrl ? String(item.source.statusUrl) : "",
        loopUrl: item.source && item.source.loopUrl ? String(item.source.loopUrl) : "",
        fallback: item.source && item.source.fallback ? String(item.source.fallback) : "",
        url: item.source && item.source.url ? String(item.source.url) : "",
        server: item.source && item.source.server ? String(item.source.server) : "",
        channelId: item.source && item.source.channelId ? String(item.source.channelId) : "",
        live: !!(item.source && item.source.live),
        allow: item.source && Array.isArray(item.source.allow) ? item.source.allow.map(String) : []
      }
    }));
  }

  async function fetchStatusDoc(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("status");
    return await res.json();
  }

  async function loadStatus(space) {
    const source = space.source || {};
    let doc = null;
    if (source.loopUrl || source.type === "loop") {
      const allow = effectiveAllow(space);
      const url = resolveStatusUrl(source.loopUrl, allow);
      if (!url) throw new Error("loop");
      doc = await fetchStatusDoc(url);
      if (!loopManifestDoc(doc)) throw new Error("loop");
    } else if (source.statusUrl) {
      const allow = effectiveAllow(space);
      const url = resolveStatusUrl(source.statusUrl, allow);
      try {
        if (!url) throw new Error("status");
        doc = await fetchStatusDoc(url);
      } catch (err) {
        const fallback = source.fallback ? resolveStatusUrl(source.fallback, allow) : "";
        if (!fallback || fallback === url) throw err;
        doc = await fetchStatusDoc(fallback);
      }
    } else if (source.type === "owncast" && source.server) {
      const allow = effectiveAllow(space);
      const statusUrl = allowedAudio(String(source.server).replace(/\/$/, "") + "/api/status", "", allow);
      if (!statusUrl) throw new Error("owncast");
      const bust = statusUrl + (statusUrl.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now();
      const res = await fetch(bust, { cache: "no-store" });
      if (!res.ok) throw new Error("owncast");
      doc = await res.json();
      if (doc && typeof doc === "object") delete doc.streamTitle;
    }
    return applyDemo(space, doc);
  }

  function adoptPlayback() {
    if (!player.active || player.pausedByUser) return;
    const item = spaceModel(player.spaceId);
    if (!item || item.kind === "youtube") return;
    if (!item.live || !item.playUrl) {
      clearRecover();
      if (player.audio && !player.audio.paused) player.audio.pause();
      syncSession();
      return;
    }
    const audio = ensureAudio();
    if (loopItem(item)) {
      if (player.loadedUrl !== item.playUrl || (item.version || "") !== player.loadedVersion || loopPrimaryChanged(item)) attach(item, false);
      else if ((audio.paused || audio.ended) && !player.recoverTimer) {
        seekLoopClock(audio, item);
        kickPlay(audio);
      }
      return;
    }
    if (player.loadedUrl !== item.playUrl) attach(item, false);
    if ((audio.paused || audio.ended) && !player.recoverTimer) kickPlay(audio);
  }

  async function refreshAll() {
    const now = Date.now();
    await Promise.all(spaces.map(async (space) => {
      const source = space.source || {};
      const loopSource = !!(source.loopUrl || source.type === "loop");
      const needs = !!(source.statusUrl || source.type === "owncast" || loopSource);
      const row = runtime[space.id] || (runtime[space.id] = { errors: 0, nextAt: 0, status: null, fetched: !needs });
      if (!needs) { row.fetched = true; return; }
      if (row.nextAt && now < row.nextAt) return;
      try {
        row.status = await loadStatus(space);
        row.fetched = true;
        row.errors = 0;
        const listening = player.active && player.spaceId === space.id && !player.pausedByUser;
        const grace = !loopSource && row.status && row.status.live === true && statusStale(row.status) && !statusOffline(row.status);
        row.nextAt = Date.now() + (loopSource ? LOOP_RECHECK_MS : ((listening || grace) ? 20000 : (document.hidden ? 120000 : 35000)));
      } catch (err) {
        row.fetched = true;
        row.errors += 1;
        const steps = [8000, 20000, 45000];
        row.nextAt = Date.now() + steps[Math.min(row.errors - 1, 2)];
        row.status = applyDemo(space, row.status);
      }
    }));
    adoptPlayback();
    maybeRender();
  }

  async function runPoll() {
    if (polling) return;
    polling = true;
    let catalogFailed = false;
    try {
      try {
        await loadCatalog();
        configOk = true;
        configErrors = 0;
      } catch (err) {
        catalogFailed = true;
        configOk = false;
        configErrors += 1;
      }
      // A 401 on feeds.config.json must not freeze a loop that is already loaded.
      if (!catalogFailed || spaces.length) {
        await refreshAll();
        lastPoll = Date.now();
      }
    } catch (err) {
      if (!catalogFailed) {
        configOk = false;
        configErrors += 1;
      }
    } finally {
      polling = false;
      armNext();
    }
  }

  function afterRender(route) {
    bindMarquees(document.getElementById("app") || document);
    syncDock(route || null);
    if (player.active) {
      const item = spaceModel(player.spaceId);
      if (item && item.kind !== "youtube" && item.playUrl && !player.pausedByUser && item.live) {
        const versionChanged = item.kind === "loop" && (item.version || "") !== player.loadedVersion;
        if (item.playUrl !== player.loadedUrl || versionChanged || loopPrimaryChanged(item)) {
          attach(item, false);
          if (player.audio && (player.audio.paused || player.audio.ended)) kickPlay(player.audio);
        }
      }
      syncSession();
      startLevel();
    }
    if (route && route.name === "spaces") {
      const item = spaceModel(route.id);
      if (item) document.title = item.title + " / " + productName("app");
    }
  }

  function noteLive(item) {
    if (!item || !item.id) return;
    const id = String(item.id);
    const row = {
      id: id,
      title: String(item.title || tr("LIVE")),
      followId: String(item.followId || ""),
      live: !!item.live,
      href: String(item.href || "#/")
    };
    const index = extras.findIndex((entry) => entry.id === id);
    if (index >= 0) extras[index] = row;
    else extras.push(row);
    maybeRender();
  }

  function playing() {
    if (!player.active) return false;
    if (document.getElementById("space-yt")) return true;
    return !!(player.audio && !player.audio.paused && !player.audio.ended);
  }

  document.addEventListener("click", (event) => {
    if (event.button && event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const node = targetEl(event);
    if (!node) return;
    const actEl = node.closest("[data-space-act]");
    const openEl = node.closest("[data-space-open]");
    if (!actEl && !openEl) return;
    event.preventDefault();
    event.stopPropagation();
    if (actEl) onSpaceAct(actEl);
    else onSpaceOpen(openEl);
  }, true);

  document.addEventListener("click", (event) => {
    const node = targetEl(event);
    if (node && node.closest && node.closest(".sp-more, .sp-react, [data-space-act='more'], [data-space-act='emoji']")) return;
    closePopups();
  });

  document.addEventListener("visibilitychange", () => {
    pauseMarquees();
    if (document.hidden) return;
    const item = player.active && !player.pausedByUser ? spaceModel(player.spaceId) : null;
    if (item && item.kind === "loop" && player.audio) seekLoopClock(player.audio, item);
    else nudgeIfQuiet();
    if (Date.now() - lastPoll > 15000) arm(1000);
  });

  document.addEventListener("resume", () => {
    const item = player.active && !player.pausedByUser ? spaceModel(player.spaceId) : null;
    if (item && item.kind === "loop" && player.audio) seekLoopClock(player.audio, item);
    else nudgeIfQuiet();
    arm(500);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.querySelector(".sp-sheet")) minimize();
  });

  function bind(next) { hooks = next || {}; }

  function start() {
    if (started) return;
    started = true;
    ensureAudio();
    ensureDock();
    loadHls();
    if (!player.watch) player.watch = setInterval(watchPlayback, 3000);
    if (!player.loopClock) player.loopClock = setInterval(syncLoopClock, LOOP_TICK_MS);
    runPoll();
  }

  root.Spaces = {
    bind: bind,
    start: start,
    homeRow: homeRow,
    homePillsHtml: homePillsHtml,
    rowExtra: rowExtra,
    sideCard: sideCard,
    profileCard: profileCard,
    avatar: avatar,
    page: page,
    models: models,
    afterRender: afterRender,
    refreshMarquees: function () { bindMarquees(document); },
    noteLive: noteLive,
    playing: playing,
    homePills: homePills,
    profileLive: profileLive,
    allowedAudio: allowedAudio,
    marqueePlan: marqueePlan
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
