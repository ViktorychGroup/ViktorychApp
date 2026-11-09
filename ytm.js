/* YouTube Music inside the music mode. Songs, artists, albums and playlists
   come from the Worker's /v1/ytm/ routes (YouTube Data API with a key, public
   YouTube pages as the backup). Playback stays in the official YouTube
   player, shown on screen at 200x200 or larger; nothing is downloaded and the
   audio is never split from the video. Our own songs keep their own tab.
   music.js calls attach() with its helpers; this file draws the YouTube
   pages and keeps the YouTube library (likes and playlists live in music.js
   so a queue can mix both). */
(function (root) {
  "use strict";

  var TRACKS = "ytm-tracks-v1";
  var CACHE = "ytm-cache-v1";
  var PREFS = "ytm-prefs-v1";
  var HISTORY = "ytm-history-v1";
  var VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  var CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
  var LIST_ID = /^[A-Za-z0-9_-]{6,64}$/;
  var MAX_TRACKS = 3000;
  var SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
  var QUALITY_LABEL = { tiny: "144p", small: "240p", medium: "360p", large: "480p", hd720: "720p", hd1080: "1080p", hd1440: "1440p", hd2160: "4K", highres: "8K" };
  var QUALITY_ORDER = ["highres", "hd2160", "hd1440", "hd1080", "hd720", "large", "medium", "small", "tiny"];
  /* Mood and genre names, read when drawn so the language can change. */
  function moodNames() {
    return {
      chill: tr("Chill"),
      focus: tr("Focus"),
      workout: tr("Workout"),
      party: tr("Party"),
      sleep: tr("Sleep"),
      romance: tr("Romance"),
      sad: tr("Sad"),
      feelgood: tr("Feel good"),
      commute: tr("Commute"),
      energy: tr("Energy boosters"),
      pop: tr("Pop"),
      hiphop: tr("Hip-hop"),
      rock: tr("Rock"),
      electronic: tr("Electronic"),
      rnb: tr("R&B"),
      latin: tr("Latin"),
      indie: tr("Indie"),
      jazz: tr("Jazz"),
      classical: tr("Classical"),
      country: tr("Country"),
      kpop: tr("K-pop"),
      bollywood: tr("Bollywood"),
      russian: tr("Russian pop"),
      metal: tr("Metal")
    };
  }
  var MOOD_KEYS = ["chill", "focus", "workout", "party", "sleep", "romance", "sad", "feelgood", "commute", "energy", "pop", "hiphop", "rock", "electronic", "rnb", "latin", "indie", "jazz", "classical", "country", "kpop", "bollywood", "russian", "metal"];

  var m = null;
  var tracks = {};
  var order = [];
  var mem = {};
  var inflight = {};
  var failed = {};
  var lists = {};
  var config = null;
  var prefs = { host: "auto", linked: false, background: true, quality: "auto", tipOff: false, saved: [], linkedAt: 0 };
  var view = { q: "", type: "all", timer: 0, menu: null, importing: "", spotify: "" };
  var history = [];
  var persistTimer = 0;
  var lookupQueue = [];
  var lookupTimer = 0;

  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : null;
    return fn ? fn(key, vars) : key;
  }
  function trn(key, n, vars) {
    var fn = (typeof window !== "undefined" && window.tn) ? window.tn : null;
    return fn ? fn(key, n, vars) : String(n);
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (err) { return null; } }
  function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode or full */ } }

  /* ---------- ids and tracks ---------- */

  function isYt(id) { return String(id || "").indexOf("yt:") === 0 && VIDEO_ID.test(String(id).slice(3)); }
  function vid(id) { return isYt(id) ? String(id).slice(3) : ""; }

  /* Save data: small thumbnails and the smallest stream. */
  function low() {
    if (prefs.quality === "low") return true;
    if (prefs.quality === "best") return false;
    var ds = root.ViktorychDataSaver;
    try { if (ds && ds.isOn && ds.isOn()) return true; } catch (err) { /* optional */ }
    try { if (ds && ds.allow && ds.allow("hd") === false) return true; } catch (err) { /* optional */ }
    var conn = typeof navigator !== "undefined" && navigator.connection;
    return !!(conn && (conn.saveData || /(^|-)2g$/.test(String(conn.effectiveType || ""))));
  }
  function smallThumbs() {
    if (low()) return true;
    var ds = root.ViktorychDataSaver;
    try { return !!(ds && ds.allow && ds.allow("smallImages")); } catch (err) { return false; }
  }
  /* default.jpg is 120x90, the smallest a play thumbnail may be. */
  function thumb(videoId) {
    if (!VIDEO_ID.test(videoId || "")) return "";
    return "https://i.ytimg.com/vi/" + videoId + (smallThumbs() ? "/default.jpg" : "/mqdefault.jpg");
  }

  function remember(list) {
    var changed = false;
    (list || []).forEach(function (s) {
      if (!s || !VIDEO_ID.test(s.id || "")) return;
      var had = tracks[s.id];
      var next = { t: String(s.title || (had && had.t) || "").slice(0, 200), a: String(s.artist || (had && had.a) || "").slice(0, 120), c: CHANNEL_ID.test(s.channelId || "") ? s.channelId : ((had && had.c) || ""), d: Number(s.duration) || (had && had.d) || 0 };
      if (!had || had.t !== next.t || had.a !== next.a || had.c !== next.c || had.d !== next.d) {
        tracks[s.id] = next;
        changed = true;
      }
      if (!had) order.push(s.id);
    });
    if (order.length > MAX_TRACKS) {
      var keep = keepIds();
      var drop = order.length - MAX_TRACKS;
      order = order.filter(function (id) {
        if (drop > 0 && !keep[id]) { drop -= 1; delete tracks[id]; return false; }
        return true;
      });
    }
    if (changed) persist();
  }
  function keepIds() {
    var keep = {};
    if (!m) return keep;
    (m.likes() || []).forEach(function (id) { if (isYt(id)) keep[vid(id)] = 1; });
    (m.playlists() || []).forEach(function (pl) { (pl.songIds || []).forEach(function (id) { if (isYt(id)) keep[vid(id)] = 1; }); });
    (m.queue() || []).forEach(function (id) { if (isYt(id)) keep[vid(id)] = 1; });
    return keep;
  }
  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () {
      persistTimer = 0;
      var out = {};
      order.forEach(function (id) { if (tracks[id]) out[id] = tracks[id]; });
      writeJson(TRACKS, { order: order, tracks: out });
    }, 400);
  }

  function song(id) {
    var key = vid(id);
    if (!key) return null;
    var t = tracks[key];
    if (!t) queueLookup(key);
    return {
      id: "yt:" + key,
      yt: key,
      kind: "youtube",
      source: "https://www.youtube.com/watch?v=" + key,
      title: t && t.t ? t.t : tr("YouTube video"),
      artist: t ? t.a : "",
      channelId: t ? t.c : "",
      cover: thumb(key),
      duration: t ? t.d : 0
    };
  }
  function asSong(s) { remember([s]); return song("yt:" + s.id); }

  /* Titles for saved tracks this device has not seen yet. */
  function queueLookup(key) {
    if (failed["v" + key] || lookupQueue.indexOf(key) >= 0) return;
    lookupQueue.push(key);
    if (lookupTimer) return;
    lookupTimer = setTimeout(function () {
      lookupTimer = 0;
      var batch = lookupQueue.splice(0, 50);
      batch.forEach(function (k) { failed["v" + k] = 1; });
      get("videos?ids=" + batch.join(","), 86400).then(function (body) {
        if (body && body.songs && body.songs.length) { remember(body.songs); if (m) m.render(); }
      }).catch(function () {});
    }, 300);
  }

  /* ---------- network ---------- */

  function get(path, ttl) {
    var api = m && m.api ? m.api() : "";
    if (!api) return Promise.reject(new Error("offline"));
    var url = api + "/v1/ytm/" + path;
    var now = Date.now();
    var hit = mem[url];
    if (hit && now - hit.at < (ttl || 3600) * 1000) return Promise.resolve(hit.body);
    var stored = readJson(CACHE) || {};
    if (stored[url] && now - stored[url].at < (ttl || 3600) * 1000) {
      mem[url] = stored[url];
      return Promise.resolve(stored[url].body);
    }
    if (inflight[url]) return inflight[url];
    inflight[url] = fetch(url, { credentials: "omit", mode: "cors" }).then(function (res) {
      if (!res.ok) throw new Error("ytm_" + res.status);
      return res.json();
    }).then(function (body) {
      delete inflight[url];
      remember(body.songs || body.tracks || body.top || (body.song ? [body.song] : []));
      mem[url] = { at: Date.now(), body: body };
      if (!body.empty) keepCache(url, mem[url]);
      return body;
    }, function (err) {
      delete inflight[url];
      throw err;
    });
    return inflight[url];
  }
  /* A small device cache so home and recent pages open at once. */
  function keepCache(url, entry) {
    var stored = readJson(CACHE) || {};
    stored[url] = entry;
    var keys = Object.keys(stored).sort(function (a, b) { return stored[b].at - stored[a].at; });
    keys.slice(30).forEach(function (k) { delete stored[k]; });
    writeJson(CACHE, stored);
  }
  function peek(path) {
    var api = m && m.api ? m.api() : "";
    var hit = api && mem[api + "/v1/ytm/" + path];
    return hit ? hit.body : null;
  }
  /* Draws what is cached, and redraws the page once the rest arrives. */
  function load(path, ttl) {
    var body = peek(path);
    if (body) return body;
    if (failed[path]) return { failed: true };
    var hash = typeof location !== "undefined" ? location.hash : "";
    get(path, ttl).then(function () {
      if (m && (typeof location === "undefined" || location.hash === hash)) m.render();
    }).catch(function () {
      failed[path] = 1;
      setTimeout(function () { delete failed[path]; }, 60000);
      if (m && (typeof location === "undefined" || location.hash === hash)) m.render();
    });
    return null;
  }

  function loadConfig() {
    if (config) return config;
    var body = load("config", 600);
    if (body && !body.failed) config = body;
    return config || {};
  }

  /* ---------- prefs, history, sync ---------- */

  function restore() {
    var data = readJson(TRACKS);
    if (data && data.tracks && typeof data.tracks === "object") {
      tracks = data.tracks;
      order = Array.isArray(data.order) ? data.order.filter(function (id) { return tracks[id]; }) : Object.keys(tracks);
    }
    var p = readJson(PREFS);
    if (p && typeof p === "object") {
      prefs.host = p.host === "youtube" || p.host === "nocookie" ? p.host : "auto";
      prefs.linked = !!p.linked;
      prefs.background = p.background !== false;
      prefs.quality = p.quality === "low" || p.quality === "best" ? p.quality : "auto";
      prefs.tipOff = !!p.tipOff;
      prefs.saved = Array.isArray(p.saved) ? p.saved.slice(0, 200) : [];
      prefs.linkedAt = Number(p.linkedAt) || 0;
    }
    var pending = readJson("ytm-sync-pending");
    if (pending) {
      try { localStorage.removeItem("ytm-sync-pending"); } catch (err) { /* private mode */ }
      importSync(pending);
    }
    var h = readJson(HISTORY);
    history = Array.isArray(h) ? h.filter(VIDEO_ID.test.bind(VIDEO_ID)).slice(0, 50) : [];
  }
  function savePrefs() { writeJson(PREFS, prefs); }

  function played(s) {
    if (!s || !s.yt) return;
    history = [s.yt].concat(history.filter(function (id) { return id !== s.yt; })).slice(0, 50);
    writeJson(HISTORY, history);
  }

  /* The synced copy: what the likes and playlists point at, and the saved
     albums and playlists. Kept small for the account's settings blob. */
  function exportSync(likes, playlistList) {
    var want = [];
    (likes || []).forEach(function (id) { if (isYt(id)) want.push(vid(id)); });
    (playlistList || []).forEach(function (pl) { (pl.songIds || []).forEach(function (id) { if (isYt(id)) want.push(vid(id)); }); });
    var seen = {};
    var out = [];
    for (var i = 0; i < want.length && out.length < 400; i++) {
      var id = want[i];
      if (seen[id] || !tracks[id]) continue;
      seen[id] = 1;
      var t = tracks[id];
      out.push([id, t.t.slice(0, 100), t.a.slice(0, 60), t.c || "", t.d || 0]);
    }
    return { tracks: out, saved: prefs.saved.slice(0, 100).map(function (c) { return { id: c.id, kind: c.kind, title: String(c.title || "").slice(0, 100), owner: String(c.owner || "").slice(0, 60) }; }), host: prefs.host, background: prefs.background, quality: prefs.quality };
  }
  function importSync(data) {
    if (!data || typeof data !== "object") return;
    if (Array.isArray(data.tracks)) {
      remember(data.tracks.map(function (row) {
        return Array.isArray(row) ? { id: String(row[0] || ""), title: row[1], artist: row[2], channelId: row[3], duration: row[4] } : null;
      }).filter(Boolean));
    }
    if (Array.isArray(data.saved)) prefs.saved = data.saved.filter(function (c) { return c && LIST_ID.test(c.id || ""); }).slice(0, 200);
    if (data.host === "youtube" || data.host === "nocookie" || data.host === "auto") prefs.host = data.host;
    if (typeof data.background === "boolean") prefs.background = data.background;
    if (data.quality === "low" || data.quality === "best" || data.quality === "auto") prefs.quality = data.quality;
    savePrefs();
  }

  /* ---------- player choices ---------- */

  /* The regular youtube.com embed uses the viewer's own YouTube sign-in
     (Premium quality, no ads). It is used once they link or opt in. */
  function embedHost() {
    if (prefs.host === "youtube") return "youtube";
    if (prefs.host === "nocookie") return "nocookie";
    return prefs.linked ? "youtube" : "nocookie";
  }
  function pickQuality(levels) {
    var list = (levels || []).filter(function (q) { return QUALITY_LABEL[q]; });
    if (!list.length) return "";
    if (low()) return list.indexOf("tiny") >= 0 ? "tiny" : (list.indexOf("small") >= 0 ? "small" : list[list.length - 1]);
    for (var i = 0; i < QUALITY_ORDER.length; i++) if (list.indexOf(QUALITY_ORDER[i]) >= 0) return QUALITY_ORDER[i];
    return list[0];
  }
  function qualityLabel(q) { return QUALITY_LABEL[q] || ""; }
  function background() { return prefs.background !== false; }
  function safari() {
    var ua = typeof navigator !== "undefined" ? String(navigator.userAgent || "") : "";
    return /Safari\//.test(ua) && !/Chrome\/|Chromium\/|Android/.test(ua) || /iPhone|iPad|iPod/.test(ua);
  }

  /* Pills under the Now Playing title for a YouTube track. */
  function nowPills(quality) {
    var parts = [];
    var label = qualityLabel(quality);
    if (label) parts.push('<span class="mu-badge ytm-q">' + esc(tr("Video {quality}", { quality: label })) + "</span>");
    parts.push('<span class="mu-badge ytm-q">' + esc(tr("Audio quality set by YouTube")) + "</span>");
    if (embedHost() === "youtube") parts.push('<span class="mu-badge ytm-q">' + esc(tr("Your YouTube account")) + "</span>");
    return parts.join("");
  }

  /* We cannot see ads or Premium from the player, so the tip shows until
     the viewer links, opts in, or closes it. */
  function tipHtml() {
    if (prefs.tipOff) return "";
    var host = embedHost();
    if (host === "youtube" && !safari()) return "";
    var body = host === "youtube"
      ? tr("This browser keeps the YouTube sign-in out of other sites, so the player may show ads and lower quality. Open it in Chrome, Edge or Firefox for your Premium.")
      : tr("Sign in to YouTube for Premium: no ads, 256 kbps audio and the best quality your account allows.");
    return '<div class="ytm-tip" role="note"><p>' + esc(body) + '</p><div class="ytm-tip-row">' +
      (host === "youtube" ? "" : '<button class="ytm-pill" type="button" data-act="music-yt-host" data-host="youtube">' + esc(tr("Use my YouTube account")) + "</button>") +
      '<a class="ytm-pill ghost" href="https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F" target="_blank" rel="noopener">' + esc(tr("Sign in to YouTube")) + "</a>" +
      '<button class="ytm-pill ghost" type="button" data-act="music-yt-tip-off">' + esc(tr("Not now")) + "</button></div></div>";
  }

  /* ---------- drawing ---------- */

  var ICON = {
    more: "M12 7.6a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zm0 6.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zm0 6.2a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z",
    play: "M8 5v14l11-7z",
    shuffle: "M4 7h2.8l2.4 2.6L11.6 7H15l-2.6 3.2L15 13.4h-3.4l-2.4-2.6L6.8 13.4H4l2.6-3.2L4 7zm11.2 0H20v2.1h-3.1L16.2 7h-1zm1.1 6.3H20V15.4h-2.4l-.6-1.2h-.7z",
    radio: "M4.15 16.90a1.75 1.75 0 1 1 3.50 0a1.75 1.75 0 1 1 -3.50 0zM9.28 11.88A6.05 6.05 0 0 1 9.28 21.92L8.33 20.51A4.35 4.35 0 0 0 8.33 13.29ZM11.27 8.94A9.60 9.60 0 0 1 11.27 24.86L10.32 23.45A7.90 7.90 0 0 0 10.32 10.35Z",
    heart: "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.790 2.647-2.910 4.601-3.010 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z",
    heartOn: "M20.884 13.19c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z",
    save: "M5 3h14v18l-7-4-7 4V3zm2 2v12.6l5-2.9 5 2.9V5H7z",
    saveOn: "M5 3h14v18l-7-4-7 4V3z",
    up: "M7 14.2 12 9.2l5 5-1.4 1.4L12 12l-3.6 3.6z",
    down: "M7 9.8 12 14.8l5-5-1.4-1.4L12 12 8.4 8.4z",
    close: "M10.59 12 4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"
  };
  function svg(path) { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>'; }
  function clock(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (!sec) return "";
    var h = Math.floor(sec / 3600);
    var mi = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return (h ? h + ":" + (mi < 10 ? "0" : "") : "") + mi + ":" + (s < 10 ? "0" : "") + s;
  }
  function img(url, cls, round) {
    var safe = /^https:\/\//.test(url || "") ? url : "";
    return '<span class="' + cls + (round ? " is-round" : "") + '">' + (safe ? '<img src="' + esc(safe) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : "") + "</span>";
  }
  /* Collection covers come as wide thumbnails; save data asks for the small one. */
  function coverUrl(url) {
    var u = String(url || "");
    if (smallThumbs()) u = u.replace(/\/(?:hq720|hqdefault|mqdefault|sddefault|maxresdefault)\.jpg/, "/default.jpg").replace(/=s\d{2,4}-/, "=s88-");
    return u;
  }
  function listKey(name, ids) { lists[name] = ids.slice(0, 500); return name; }

  function trackRow(s, listName, index, opts) {
    opts = opts || {};
    var cur = m.current();
    var on = cur && cur.id === s.id;
    var like = m.liked(s.id);
    return '<div class="mu-row ytm-row' + (on ? " is-current" : "") + '" data-mu-id="' + esc(s.id) + '" data-id="' + esc(s.id) + '">' +
      (index ? '<span class="ytm-n">' + index + "</span>" : "") +
      '<button class="mu-open" type="button" data-act="music-play" data-id="' + esc(s.id) + '"' + (listName ? ' data-ytm-list="' + esc(listName) + '"' : "") + ' aria-label="' + esc(tr("Play {title}", { title: s.title })) + '">' + img(s.cover, "ytm-thumb") +
      '<span class="mu-copy"><b>' + esc(s.title) + "</b><span>" + esc(s.artist || "YouTube") + "</span></span></button>" +
      '<span class="mu-dur">' + esc(clock(s.duration)) + "</span>" +
      '<span class="mu-actions ytm-actions"><button class="icon-btn mu-like' + (like ? " on" : "") + '" type="button" data-act="music-like" data-id="' + esc(s.id) + '" aria-label="' + esc(like ? tr("Remove from liked songs") : tr("Add to liked songs")) + '" aria-pressed="' + (like ? "true" : "false") + '">' + svg(like ? ICON.heartOn : ICON.heart) + "</button>" +
      (opts.remove ? '<button class="icon-btn" type="button" data-act="' + esc(opts.remove) + '" data-id="' + esc(s.id) + '" data-list="' + esc(opts.list || "") + '" data-index="' + esc(String(opts.at == null ? "" : opts.at)) + '" aria-label="' + esc(tr("Remove")) + '">' + svg(ICON.close) + "</button>" : "") +
      '<button class="icon-btn" type="button" data-act="music-yt-menu" data-id="' + esc(s.id) + '" aria-label="' + esc(tr("More options")) + '" aria-haspopup="menu">' + svg(ICON.more) + "</button></span></div>";
  }
  function trackRows(list, name, numbered, opts) {
    var ids = list.map(function (s) { return s.id; });
    var key = listKey(name, ids);
    return '<div class="mu-list ytm-list">' + list.map(function (s, i) { return trackRow(s, key, numbered ? i + 1 : 0, opts); }).join("") + "</div>";
  }
  function trackTile(s, listName) {
    var cur = m.current();
    return '<button class="mu-tile ytm-tile' + (cur && cur.id === s.id ? " is-current" : "") + '" type="button" data-act="music-play" data-id="' + esc(s.id) + '" data-mu-id="' + esc(s.id) + '" data-ytm-list="' + esc(listName) + '">' +
      img(s.cover, "mu-cover ytm-cover") + "<b>" + esc(s.title) + "</b><span>" + esc(s.artist || "YouTube") + "</span></button>";
  }
  function trackShelf(title, list, name, more) {
    if (!list.length) return "";
    var key = listKey(name, list.map(function (s) { return s.id; }));
    return '<section class="ytm-shelf"><div class="mu-shelf-head"><h2>' + esc(title) + "</h2>" +
      '<span class="ytm-head-tools"><button class="ytm-pill" type="button" data-act="music-yt-playall" data-ytm-list="' + esc(key) + '">' + esc(tr("Play all")) + "</button>" + (more || "") + "</span></div>" +
      '<div class="mu-hscroll">' + list.map(function (s) { return trackTile(s, key); }).join("") + "</div></section>";
  }
  function collectionTile(c) {
    var href = "#/music/collection/" + encodeURIComponent(c.id);
    var kind = c.kind === "album" ? tr("Album") : tr("Playlist");
    return '<a class="mu-tile ytm-tile" href="' + href + '">' + img(coverUrl(c.cover), "mu-cover ytm-cover") + "<b>" + esc(c.title || kind) + "</b><span>" + esc([kind, c.owner].filter(Boolean).join(" · ")) + "</span></a>";
  }
  function artistTile(a) {
    return '<a class="mu-tile ytm-tile ytm-artist" href="#/music/artist/' + encodeURIComponent(a.id) + '">' + img(coverUrl(a.cover), "mu-cover ytm-cover", true) + "<b>" + esc(a.name) + "</b><span>" + esc(tr("Artist")) + "</span></a>";
  }
  function grid(items, fn) { return '<div class="mu-hscroll">' + items.map(fn).join("") + "</div>"; }
  function section(title, body) { return body ? '<section class="ytm-shelf"><div class="mu-shelf-head"><h2>' + esc(title) + "</h2></div>" + body + "</section>" : ""; }
  function spinner() { return '<div class="ytm-loading" role="status"><span class="spinner" aria-hidden="true"></span><span>' + esc(tr("Loading")) + "</span></div>"; }
  function oops() { return '<div class="empty"><h2>' + esc(tr("YouTube isn’t answering")) + "</h2><p>" + esc(tr("Try again in a minute. Your own songs still play.")) + '</p><p><a href="#/music/ours">' + esc(tr("Our songs")) + "</a></p></div>"; }
  function tabs(on) {
    return '<div class="ytm-tabs" role="tablist">' +
      '<a role="tab" href="#/music" class="ytm-chip' + (on === "yt" ? " on" : "") + '" aria-selected="' + (on === "yt" ? "true" : "false") + '">' + esc(tr("YouTube Music")) + "</a>" +
      '<a role="tab" href="#/music/ours" class="ytm-chip' + (on === "ours" ? " on" : "") + '" aria-selected="' + (on === "ours" ? "true" : "false") + '">' + esc(tr("Our songs")) + "</a>" +
      '<a role="tab" href="#/music/explore" class="ytm-chip' + (on === "explore" ? " on" : "") + '" aria-selected="' + (on === "explore" ? "true" : "false") + '">' + esc(tr("Explore")) + "</a></div>";
  }
  function moodChips(keys) {
    return '<div class="ytm-moods">' + keys.map(function (k) {
      return '<a class="ytm-chip" href="#/music/mood/' + encodeURIComponent(k) + '">' + esc(moodNames()[k] || k) + "</a>";
    }).join("") + "</div>";
  }
  function moodKeys() {
    var c = loadConfig();
    return Array.isArray(c.moods) && c.moods.length ? c.moods.filter(function (k) { return MOOD_KEYS.indexOf(k) >= 0; }) : MOOD_KEYS.slice();
  }
  function songsOf(body) { return ((body && (body.songs || body.tracks || body.top)) || []).map(asSong).filter(Boolean); }

  function homePage() {
    var charts = load("charts", 21600);
    var fresh = load("new", 21600);
    var out = m.head(m.productName("music")) + tabs("yt") + tipHtml() + moodChips(moodKeys().slice(0, 12));
    var recent = history.slice(0, 12).map(function (id) { return song("yt:" + id); });
    if (recent.length) out += trackShelf(tr("Listen again"), recent, "history");
    var ours = m.oursShelf ? m.oursShelf() : "";
    var oursBlock = ours ? '<section class="ytm-shelf ytm-ours"><div class="mu-shelf-head"><h2>' + esc(tr("From {music}", { music: m.productName("music") })) + '</h2><span class="ytm-head-tools"><a class="ytm-pill ghost" href="#/music/ours">' + esc(tr("See all")) + "</a></span></div>" + ours + "</section>" : "";
    if (charts === null && fresh === null) return out + spinner() + oursBlock;
    if (charts && charts.failed && fresh && fresh.failed) return out + oops() + oursBlock;
    out += trackShelf(charts && charts.title ? charts.title : tr("Top songs"), songsOf(charts).slice(0, 20), "charts", '<a class="ytm-pill ghost" href="#/music/explore">' + esc(tr("See all")) + "</a>");
    out += trackShelf(tr("New releases"), songsOf(fresh).slice(0, 20), "new");
    var likes = (m.likes() || []).filter(isYt).slice(-12).reverse().map(song);
    if (likes.length) out += trackShelf(tr("Your likes"), likes, "likes", '<a class="ytm-pill ghost" href="#/music/liked">' + esc(tr("See all")) + "</a>");
    if (prefs.saved.length) out += section(tr("Saved to your library"), grid(prefs.saved.slice(0, 12), collectionTile));
    return out + oursBlock;
  }

  function explorePage() {
    var charts = load("charts", 21600);
    var fresh = load("new", 21600);
    var out = m.head(tr("Explore")) + tabs("explore");
    out += section(tr("Moods and genres"), moodChips(moodKeys()));
    if (charts === null) return out + spinner();
    if (charts.failed) return out + oops();
    var list = songsOf(charts).slice(0, 100);
    if (list.length) out += '<section class="ytm-shelf"><div class="mu-shelf-head"><h2>' + esc(charts.title || tr("Top songs")) + '</h2><span class="ytm-head-tools"><button class="ytm-pill" type="button" data-act="music-yt-playall" data-ytm-list="' + esc(listKey("charts-all", list.map(function (s) { return s.id; }))) + '">' + esc(tr("Play all")) + "</button></span></div>" + trackRows(list, "charts-all", true) + "</section>";
    if (fresh && !fresh.failed) out += trackShelf(tr("New releases"), songsOf(fresh).slice(0, 20), "new");
    return out;
  }

  function moodPage(key) {
    var name = moodNames()[key];
    if (!name) return m.head(tr("Explore")) + oops();
    var body = load("mood?key=" + encodeURIComponent(key), 86400);
    var out = m.head(name) + moodChips(moodKeys());
    if (body === null) return out + spinner();
    if (body.failed) return out + oops();
    var cols = (body.collections || []).slice(0, 30);
    return out + (cols.length ? '<div class="mu-grid ytm-grid">' + cols.map(collectionTile).join("") + "</div>" : '<div class="empty"><h2>' + esc(tr("Nothing here yet")) + "</h2></div>");
  }

  function searchTypes() { return { all: tr("All"), song: tr("Songs"), artist: tr("Artists"), album: tr("Albums"), playlist: tr("Playlists") }; }
  function searchResults() {
    var q = view.q.trim();
    if (!q) return '<div class="empty"><h2>' + esc(tr("Search YouTube Music")) + "</h2><p>" + esc(tr("Songs, artists, albums and playlists. Our own songs show first.")) + "</p></div>";
    var ours = m.oursSearch ? m.oursSearch(q) : "";
    var body = load("search?type=" + view.type + "&q=" + encodeURIComponent(q), 3600);
    var out = ours ? section(tr("Our songs"), ours) : "";
    if (body === null) return out + spinner();
    if (body.failed) return out + oops();
    var list = songsOf(body);
    var artists = body.artists || [];
    var cols = body.collections || [];
    if (!list.length && !artists.length && !cols.length) return out + '<div class="empty"><h2>' + esc(tr("No results")) + "</h2><p>" + esc(tr("Try another spelling or fewer words.")) + "</p></div>";
    if (view.type === "artist") return out + '<div class="mu-grid ytm-grid">' + artists.map(artistTile).join("") + "</div>";
    if (view.type === "album" || view.type === "playlist") return out + '<div class="mu-grid ytm-grid">' + cols.map(collectionTile).join("") + "</div>";
    if (view.type === "song") return out + trackRows(list, "search", false);
    if (artists.length) out += section(tr("Artists"), grid(artists.slice(0, 8), artistTile));
    if (list.length) out += section(tr("Songs"), trackRows(list.slice(0, 12), "search", false));
    if (cols.length) out += section(tr("Albums and playlists"), grid(cols.slice(0, 12), collectionTile));
    return out;
  }
  function searchPage() {
    var types = searchTypes();
    var chips = '<div class="ytm-tabs ytm-types" role="tablist">' + Object.keys(types).map(function (k) {
      return '<button type="button" role="tab" class="ytm-chip' + (view.type === k ? " on" : "") + '" aria-selected="' + (view.type === k ? "true" : "false") + '" data-act="music-yt-type" data-type="' + k + '">' + esc(types[k]) + "</button>";
    }).join("") + "</div>";
    return m.head(tr("Search")) + '<form class="mu-search" data-act="music-yt-form" role="search"><label class="search"><input id="ytm-q" type="search" enterkeyhint="search" autocomplete="off" placeholder="' + esc(tr("Songs, artists, albums")) + '" aria-label="' + esc(tr("Search YouTube Music")) + '" value="' + esc(view.q) + '"></label></form>' + chips + '<div class="ytm-results">' + searchResults() + "</div>";
  }

  function artistPage(id) {
    if (!CHANNEL_ID.test(id)) return m.head(tr("Artist")) + oops();
    var body = load("artist?id=" + encodeURIComponent(id), 43200);
    if (body === null) return m.head(tr("Artist")) + spinner();
    if (body.failed || body.empty) return m.head(tr("Artist")) + oops();
    var top = songsOf(body).slice(0, 20);
    var key = listKey("artist:" + id, top.map(function (s) { return s.id; }));
    var head = '<div class="ytm-hero">' + img(coverUrl(body.cover), "ytm-hero-art", true) + '<div class="ytm-hero-copy"><p class="mu-kicker">' + esc(tr("Artist")) + "</p><h2>" + esc(body.name || "") + "</h2>" +
      (body.subscribers ? '<p class="mu-meta">' + esc(trn("subscribers", body.subscribers)) + "</p>" : "") +
      '<div class="ytm-hero-actions">' + (top.length ? '<button class="mu-play-pill" type="button" data-act="music-yt-playall" data-ytm-list="' + esc(key) + '">' + svg(ICON.play) + esc(tr("Play")) + '</button><button class="ytm-pill" type="button" data-act="music-yt-playall" data-shuffle="1" data-ytm-list="' + esc(key) + '">' + svg(ICON.shuffle) + esc(tr("Shuffle")) + '</button><button class="ytm-pill" type="button" data-act="music-yt-radio" data-id="' + esc(top[0].id) + '">' + svg(ICON.radio) + esc(tr("Radio")) + "</button>" : "") +
      '<a class="ytm-pill ghost" href="https://www.youtube.com/channel/' + encodeURIComponent(id) + '" target="_blank" rel="noopener">' + esc(tr("Open on YouTube")) + "</a></div></div></div>";
    return m.head(body.name || tr("Artist")) + head +
      (top.length ? section(tr("Top songs"), trackRows(top.slice(0, 10), key, true)) : "") +
      ((body.albums || []).length ? section(tr("Albums and playlists"), grid(body.albums.slice(0, 20), collectionTile)) : "") +
      ((body.related || []).length ? section(tr("Fans also like"), grid(body.related.slice(0, 20), artistTile)) : "");
  }

  function savedIndex(id) { for (var i = 0; i < prefs.saved.length; i++) if (prefs.saved[i].id === id) return i; return -1; }
  function collectionPage(id) {
    if (!LIST_ID.test(id)) return m.head(tr("Playlist")) + oops();
    var body = load("playlist?id=" + encodeURIComponent(id), 21600);
    if (body === null) return m.head(tr("Playlist")) + spinner();
    if (body.failed || body.empty) return m.head(tr("Playlist")) + oops();
    var list = songsOf(body);
    var key = listKey("col:" + id, list.map(function (s) { return s.id; }));
    var kind = body.kind === "album" ? tr("Album") : tr("Playlist");
    var saved = savedIndex(id) >= 0;
    var total = list.reduce(function (n, s) { return n + (s.duration || 0); }, 0);
    var meta = [kind, body.owner, trn("songs", list.length), total ? clock(total) : ""].filter(Boolean).join(" · ");
    var head = '<div class="ytm-hero">' + img(coverUrl(body.cover || (list[0] && list[0].cover)), "ytm-hero-art") + '<div class="ytm-hero-copy"><p class="mu-kicker">' + esc(kind) + "</p><h2>" + esc(body.title || kind) + '</h2><p class="mu-meta">' + esc(meta) + "</p>" +
      '<div class="ytm-hero-actions">' + (list.length ? '<button class="mu-play-pill" type="button" data-act="music-yt-playall" data-ytm-list="' + esc(key) + '">' + svg(ICON.play) + esc(tr("Play")) + '</button><button class="ytm-pill" type="button" data-act="music-yt-playall" data-shuffle="1" data-ytm-list="' + esc(key) + '">' + svg(ICON.shuffle) + esc(tr("Shuffle")) + "</button>" : "") +
      '<button class="ytm-pill" type="button" data-act="music-yt-save" data-id="' + esc(id) + '" aria-pressed="' + (saved ? "true" : "false") + '">' + svg(saved ? ICON.saveOn : ICON.save) + esc(saved ? tr("In your library") : tr("Save to library")) + "</button>" +
      '<button class="ytm-pill" type="button" data-act="music-yt-copy" data-id="' + esc(id) + '">' + esc(tr("Copy to my playlists")) + "</button>" +
      '<a class="ytm-pill ghost" href="https://www.youtube.com/playlist?list=' + encodeURIComponent(id) + '" target="_blank" rel="noopener">' + esc(tr("Open on YouTube")) + "</a></div></div></div>";
    view.lastCollection = { id: id, kind: body.kind, title: body.title, owner: body.owner, cover: body.cover || (list[0] && list[0].cover) || "" };
    return m.head(body.title || kind) + head + (list.length ? trackRows(list, key, true) : '<div class="empty"><h2>' + esc(tr("Nothing here yet")) + "</h2></div>");
  }

  function queuePage() {
    var q = m.queue() || [];
    var at = m.index();
    var cur = m.current();
    var out = m.head(tr("Up next"));
    if (!q.length || !cur) return out + '<div class="empty"><h2>' + esc(tr("Nothing queued")) + "</h2><p>" + esc(tr("Play a song, or use Add to queue on any song.")) + "</p></div>";
    var curHtml = isYt(cur.id) ? trackRows([cur], "queue-now", false) : (m.ourRow ? m.ourRow(cur) : "");
    var rest = q.slice(at + 1, at + 201).map(function (id, i) { return { id: id, at: at + 1 + i }; });
    var rows = rest.map(function (item) {
      var s = isYt(item.id) ? song(item.id) : m.songById(item.id);
      if (!s) return "";
      if (isYt(item.id)) return trackRow(s, "queue", 0, { remove: "music-yt-unqueue", at: item.at });
      return '<div class="mu-row ytm-row" data-mu-id="' + esc(s.id) + '"><button class="mu-open" type="button" data-act="music-yt-jump" data-index="' + item.at + '">' + img(s.cover || "", "ytm-thumb") + '<span class="mu-copy"><b>' + esc(s.title || "") + "</b><span>" + esc(s.artist || "") + '</span></span></button><span class="mu-actions ytm-actions"><button class="icon-btn" type="button" data-act="music-yt-unqueue" data-index="' + item.at + '" aria-label="' + esc(tr("Remove")) + '">' + svg(ICON.close) + "</button></span></div>";
    }).join("");
    return out + section(tr("Now playing"), curHtml) +
      '<section class="ytm-shelf"><div class="mu-shelf-head"><h2>' + esc(tr("Up next")) + '</h2><span class="ytm-head-tools">' + (isYt(cur.id) ? '<button class="ytm-pill" type="button" data-act="music-yt-radio" data-id="' + esc(cur.id) + '">' + svg(ICON.radio) + esc(tr("Start radio")) + "</button>" : "") + (rest.length ? '<button class="ytm-pill ghost" type="button" data-act="music-yt-clear">' + esc(tr("Clear")) + "</button>" : "") + "</span></div>" +
      (rows ? '<div class="mu-list ytm-list">' + rows + "</div>" : '<p class="mu-note">' + esc(tr("The queue ends after this song.")) + "</p>") + "</section>";
  }

  /* The YouTube part of Your Library, above the songs kept on this device. */
  function libraryHtml() {
    var c = loadConfig();
    var likes = (m.likes() || []).filter(isYt);
    var out = '<div class="ytm-lib">';
    out += '<div class="mu-grid ytm-grid"><a class="mu-tile" href="#/music/liked">' + '<span class="mu-cover ytm-cover ytm-badge">' + svg(ICON.heartOn) + "</span><b>" + esc(tr("Liked songs")) + "</b><span>" + esc(trn("songs", (m.likes() || []).length)) + '</span></a><a class="mu-tile" href="#/music/queue"><span class="mu-cover ytm-cover ytm-badge">' + svg(ICON.radio) + "</span><b>" + esc(tr("Up next")) + "</b><span>" + esc(trn("songs", Math.max(0, (m.queue() || []).length - m.index() - 1))) + "</span></a>" + prefs.saved.map(collectionTile).join("") + "</div>";
    if (c.oauthClientId) {
      out += '<div class="ytm-card"><h3>' + esc(tr("Connect YouTube")) + "</h3><p>" + esc(prefs.linked ? tr("Linked. Import again any time to bring in new likes and playlists. We only read; nothing is changed on YouTube.") : tr("Bring in your liked videos and playlists from YouTube, read-only. Your watch history stays with Google: YouTube doesn’t share it with apps.")) + "</p>" +
        '<div class="ytm-tip-row"><button class="ytm-pill" type="button" data-act="music-yt-connect"' + (view.importing ? " disabled" : "") + ">" + esc(view.importing ? tr("Importing…") : (prefs.linked ? tr("Import again") : tr("Connect YouTube"))) + "</button>" +
        (prefs.linked ? '<button class="ytm-pill ghost" type="button" data-act="music-yt-unlink">' + esc(tr("Unlink")) + "</button>" : "") + "</div></div>";
    }
    if (c.spotify) {
      out += '<form class="ytm-card" data-act="music-yt-form"><h3>' + esc(tr("Import from Spotify")) + "</h3><p>" + esc(tr("Paste a public Spotify playlist link. Each song is matched on YouTube and saved as a playlist here.")) + '</p><div class="ytm-tip-row"><input id="ytm-spotify" class="ytm-input" type="url" inputmode="url" placeholder="https://open.spotify.com/playlist/…" aria-label="' + esc(tr("Spotify playlist link")) + '" value="' + esc(view.spotify) + '"><button class="ytm-pill" type="button" data-act="music-yt-spotify"' + (view.importing ? " disabled" : "") + ">" + esc(tr("Import")) + "</button></div></form>";
    }
    out += settingsHtml();
    if (likes.length === 0 && !prefs.saved.length) out += '<p class="mu-note">' + esc(tr("Tap the heart on any YouTube song to keep it here. Likes and playlists follow your account to every device.")) + "</p>";
    return out + "</div>";
  }

  function radioRow(name, value, on, label) {
    return '<label class="ytm-opt"><input type="radio" name="' + name + '" value="' + value + '" data-ytm-pref="' + name + '"' + (on ? " checked" : "") + "><span>" + esc(label) + "</span></label>";
  }
  function settingsHtml() {
    return '<details class="ytm-card ytm-settings"><summary>' + esc(tr("YouTube player settings")) + "</summary>" +
      '<fieldset><legend>' + esc(tr("Player")) + "</legend>" +
      radioRow("host", "auto", prefs.host === "auto", tr("Use my YouTube account once linked")) +
      radioRow("host", "youtube", prefs.host === "youtube", tr("Always use my YouTube account (Premium, no ads)")) +
      radioRow("host", "nocookie", prefs.host === "nocookie", tr("Private player (no YouTube sign-in)")) + "</fieldset>" +
      '<fieldset><legend>' + esc(tr("Quality")) + "</legend>" +
      radioRow("quality", "auto", prefs.quality === "auto", tr("Automatic (lower with Save data)")) +
      radioRow("quality", "best", prefs.quality === "best", tr("Best my account allows")) +
      radioRow("quality", "low", prefs.quality === "low", tr("Save data")) + "</fieldset>" +
      '<label class="ytm-opt"><input type="checkbox" data-ytm-pref="background"' + (prefs.background ? " checked" : "") + "><span>" + esc(tr("Keep playing when the app is in the background")) + "</span></label>" +
      '<p class="mu-note">' + esc(tr("Phones may still stop YouTube in the background; iPhone and iPad always do. Lyrics aren’t shown: there is no free licensed source.")) + "</p></details>";
  }

  function page(route) {
    if (!m) return null;
    var section = (route && route.section) || "home";
    var id = (route && route.id) || "";
    if (section === "home") return homePage();
    if (section === "explore") return explorePage();
    if (section === "mood") return moodPage(id);
    if (section === "search") return searchPage();
    if (section === "artist") return artistPage(id);
    if (section === "collection") return collectionPage(id);
    if (section === "queue") return queuePage();
    return null;
  }

  function titleFor(route) {
    var section = (route && route.section) || "";
    if (section === "explore") return tr("Explore");
    if (section === "queue") return tr("Up next");
    if (section === "mood") return moodNames()[route.id] || tr("Explore");
    if (section === "artist") { var a = peek("artist?id=" + encodeURIComponent(route.id || "")); return (a && a.name) || tr("Artist"); }
    if (section === "collection") { var c = peek("playlist?id=" + encodeURIComponent(route.id || "")); return (c && c.title) || tr("Playlist"); }
    if (section === "ours") return tr("Our songs");
    return "";
  }

  /* ---------- the track menu ---------- */

  function closeMenu() {
    var box = document.getElementById("ytm-menu");
    if (box) box.remove();
    if (view.menu && view.menu.focus && view.menu.focus.focus) { try { view.menu.focus.focus(); } catch (err) { /* gone */ } }
    view.menu = null;
  }
  function openMenu(el, id) {
    closeMenu();
    var s = song(id);
    if (!s) return;
    var lists2 = (m.playlists() || []).filter(function (pl) { return pl && pl.id && !pl.remote; }).slice(0, 12);
    var box = document.createElement("div");
    box.id = "ytm-menu";
    box.className = "ytm-menu";
    box.setAttribute("role", "menu");
    var item = function (act, label, extra) { return '<button type="button" role="menuitem" data-act="' + act + '" data-id="' + esc(s.id) + '"' + (extra || "") + ">" + esc(label) + "</button>"; };
    box.innerHTML = item("music-yt-next", tr("Play next")) + item("music-yt-queue", tr("Add to queue")) + item("music-yt-radio", tr("Start radio")) +
      (s.channelId ? '<a role="menuitem" href="#/music/artist/' + encodeURIComponent(s.channelId) + '">' + esc(tr("Go to artist")) + "</a>" : "") +
      '<div class="ytm-menu-sep" role="separator"></div><p class="ytm-menu-label">' + esc(tr("Add to playlist")) + "</p>" +
      lists2.map(function (pl) { return item("music-yt-pladd", pl.name, ' data-list="' + esc(pl.id) + '"'); }).join("") +
      item("music-yt-plnew", tr("New playlist")) +
      '<div class="ytm-menu-sep" role="separator"></div><a role="menuitem" href="' + esc(s.source) + '" target="_blank" rel="noopener">' + esc(tr("Open on YouTube")) + "</a>";
    document.body.appendChild(box);
    var r = el.getBoundingClientRect();
    var z = parseFloat(document.documentElement.style.zoom);
    var scale = z > 0 ? z : 1;
    var w = box.offsetWidth || 240;
    var h = box.offsetHeight || 300;
    var viewW = root.innerWidth / scale;
    var viewH = root.innerHeight / scale;
    var left = Math.max(8, Math.min(r.right / scale - w, viewW - w - 8));
    var top = r.bottom / scale + 4 + h > viewH - 8 ? Math.max(8, r.top / scale - h - 4) : r.bottom / scale + 4;
    box.style.left = left + "px";
    box.style.top = top + "px";
    view.menu = { id: s.id, focus: el };
    var first = box.querySelector("button, a");
    if (first) first.focus();
  }

  /* ---------- import ---------- */

  function loadGis() {
    if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve(root.google.accounts.oauth2);
    if (loadGis.p) return loadGis.p;
    loadGis.p = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.onload = function () { if (root.google && root.google.accounts && root.google.accounts.oauth2) resolve(root.google.accounts.oauth2); else reject(new Error("gis")); };
      s.onerror = function () { loadGis.p = null; reject(new Error("gis")); };
      document.head.appendChild(s);
    });
    return loadGis.p;
  }
  function gapi(token, path) {
    return fetch("https://www.googleapis.com/youtube/v3/" + path, { headers: { Authorization: "Bearer " + token } }).then(function (res) {
      if (!res.ok) throw new Error("yt_" + res.status);
      return res.json();
    });
  }
  function pages(token, path, max) {
    var out = [];
    function step(pageToken) {
      return gapi(token, path + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "")).then(function (body) {
        (body.items || []).forEach(function (it) { out.push(it); });
        if (body.nextPageToken && out.length < max) return step(body.nextPageToken);
        return out;
      });
    }
    return step("");
  }
  function itemSong(it) {
    var sn = it.snippet || {};
    var idv = (it.contentDetails && it.contentDetails.videoId) || (sn.resourceId && sn.resourceId.videoId) || (typeof it.id === "string" ? it.id : "");
    if (!VIDEO_ID.test(idv || "") || sn.title === "Private video" || sn.title === "Deleted video") return null;
    var artist = String(sn.videoOwnerChannelTitle || sn.channelTitle || "").replace(/\s+-\s+Topic$/i, "");
    var dur = 0;
    var iso = it.contentDetails && it.contentDetails.duration;
    var mm = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
    if (mm) dur = (Number(mm[1]) || 0) * 3600 + (Number(mm[2]) || 0) * 60 + (Number(mm[3]) || 0);
    return { id: idv, title: sn.title, artist: artist, channelId: sn.videoOwnerChannelId || sn.channelId || "", duration: dur };
  }
  /* Read-only Google sign-in in a popup. The token stays in memory and is
     dropped when the import ends. */
  function connect() {
    var c = loadConfig();
    if (!c.oauthClientId) { m.toast(tr("Connect YouTube isn’t set up yet")); return; }
    view.importing = "youtube";
    m.render();
    loadGis().then(function (oauth) {
      return new Promise(function (resolve, reject) {
        var client = oauth.initTokenClient({
          client_id: c.oauthClientId,
          scope: SCOPE,
          prompt: prefs.linked ? "" : "consent",
          callback: function (resp) { if (resp && resp.access_token) resolve(resp.access_token); else reject(new Error("denied")); },
          error_callback: function () { reject(new Error("closed")); }
        });
        client.requestAccessToken();
      });
    }).then(function (token) {
      return pages(token, "videos?part=snippet,contentDetails&myRating=like&maxResults=50", 500).then(function (liked) {
        var likeSongs = liked.map(itemSong).filter(Boolean);
        remember(likeSongs);
        m.addLikes(likeSongs.map(function (s) { return "yt:" + s.id; }));
        return pages(token, "playlists?part=snippet,contentDetails&mine=true&maxResults=50", 200).then(function (pls) {
          var chain = Promise.resolve(0);
          pls.slice(0, 50).forEach(function (pl) {
            chain = chain.then(function (n) {
              return pages(token, "playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=" + encodeURIComponent(pl.id), 200).then(function (items) {
                var list = items.map(itemSong).filter(Boolean);
                remember(list);
                m.putPlaylist("ytpl-" + pl.id, (pl.snippet && pl.snippet.title) || tr("Playlist"), list.map(function (s) { return "yt:" + s.id; }));
                return n + 1;
              }).catch(function () { return n; });
            });
          });
          return chain.then(function (n) { return { likes: likeSongs.length, playlists: n }; });
        });
      });
    }).then(function (done) {
      prefs.linked = true;
      prefs.linkedAt = Date.now();
      savePrefs();
      view.importing = "";
      m.applyHost();
      m.toast(tr("Imported {likes} likes and {lists} playlists from YouTube", { likes: done.likes, lists: done.playlists }));
      m.render();
    }).catch(function (err) {
      view.importing = "";
      var msg = String(err && err.message || "");
      m.toast(msg === "denied" || msg === "closed" ? tr("YouTube wasn’t connected") : tr("Couldn’t import from YouTube"));
      m.render();
    });
  }

  function spotifyImport() {
    var raw = view.spotify || (document.getElementById("ytm-spotify") || {}).value || "";
    var match = /playlist[/:]([A-Za-z0-9]{16,32})/.exec(raw) || /^([A-Za-z0-9]{16,32})$/.exec(String(raw).trim());
    if (!match) { m.toast(tr("Paste a Spotify playlist link")); return; }
    view.importing = "spotify";
    m.render();
    get("spotify?id=" + match[1], 60).then(function (body) {
      if (!body || !Array.isArray(body.tracks) || !body.tracks.length) throw new Error("empty");
      var found = [];
      var at = 0;
      var done = 0;
      var total = Math.min(300, body.tracks.length);
      return new Promise(function (resolve) {
        function worker() {
          if (at >= total) return Promise.resolve();
          var i = at++;
          var t = body.tracks[i];
          var q = (t.title + " " + t.artist).trim();
          return get("match?q=" + encodeURIComponent(q) + "&title=" + encodeURIComponent(t.title) + "&artist=" + encodeURIComponent(t.artist) + "&duration=" + (t.duration || 0), 604800).then(function (hit) {
            if (hit && hit.song) found[i] = "yt:" + hit.song.id;
          }).catch(function () {}).then(function () {
            done += 1;
            if (done % 20 === 0) m.toast(tr("Matched {done} of {total}", { done: done, total: total }));
            return worker();
          });
        }
        Promise.all([worker(), worker(), worker(), worker()]).then(function () { resolve({ name: body.name, ids: found.filter(Boolean), total: total }); });
      });
    }).then(function (res) {
      view.importing = "";
      view.spotify = "";
      m.putPlaylist("sp-" + match[1], (res.name || tr("Playlist")) + " · Spotify", res.ids);
      m.toast(tr("Imported {found} of {total} songs from Spotify", { found: res.ids.length, total: res.total }));
      m.render();
    }).catch(function () {
      view.importing = "";
      m.toast(tr("Couldn’t read that Spotify playlist"));
      m.render();
    });
  }

  /* ---------- actions ---------- */

  function ids(name) { return (lists[name] || []).slice(); }

  function radio(id) {
    var key = vid(id);
    if (!key) return;
    m.toast(tr("Starting radio"));
    get("radio?id=" + key, 21600).then(function (body) {
      var next = songsOf(body).map(function (s) { return s.id; }).filter(function (x) { return x !== "yt:" + key; });
      m.playList(["yt:" + key].concat(next), "yt:" + key, false);
    }).catch(function () { m.toast(tr("Couldn’t start radio")); });
  }

  function onAct(act, el) {
    if (!m || String(act).indexOf("music-yt-") !== 0) return false;
    var id = (el && el.getAttribute && el.getAttribute("data-id")) || "";
    if (act !== "music-yt-menu") closeMenu();
    if (act === "music-yt-menu") { if (view.menu && view.menu.id === id) closeMenu(); else openMenu(el, id); return true; }
    if (act === "music-yt-next") { m.playNext([id]); m.toast(tr("Plays next")); return true; }
    if (act === "music-yt-queue") { m.addToQueue([id]); m.toast(tr("Added to queue")); return true; }
    if (act === "music-yt-radio") { radio(id); return true; }
    if (act === "music-yt-pladd") { m.addToPlaylist(el.getAttribute("data-list") || "", [id]); m.toast(tr("Added to playlist")); return true; }
    if (act === "music-yt-plnew") {
      var name = root.prompt ? root.prompt(tr("Name the playlist")) : "";
      if (name && String(name).trim()) { m.putPlaylist("", String(name).trim().slice(0, 80), [id]); m.toast(tr("Added to playlist")); }
      return true;
    }
    if (act === "music-yt-playall") {
      var list = ids(el.getAttribute("data-ytm-list") || "");
      if (!list.length) return true;
      m.playList(list, list[0], el.getAttribute("data-shuffle") === "1");
      return true;
    }
    if (act === "music-yt-type") { view.type = el.getAttribute("data-type") || "all"; m.render(); return true; }
    if (act === "music-yt-search") { submitSearch(); return true; }
    if (act === "music-yt-save") {
      var at = savedIndex(id);
      if (at >= 0) prefs.saved.splice(at, 1);
      else if (view.lastCollection && view.lastCollection.id === id) prefs.saved.unshift({ id: id, kind: view.lastCollection.kind, title: view.lastCollection.title, owner: view.lastCollection.owner, cover: view.lastCollection.cover });
      prefs.saved = prefs.saved.slice(0, 200);
      savePrefs();
      m.synced();
      m.render();
      return true;
    }
    if (act === "music-yt-copy") {
      var body = peek("playlist?id=" + encodeURIComponent(id));
      if (body) { m.putPlaylist("ytpl-" + id, body.title || tr("Playlist"), songsOf(body).map(function (s) { return s.id; })); m.toast(tr("Saved to your playlists")); }
      return true;
    }
    if (act === "music-yt-unqueue") { m.unqueue(Number(el.getAttribute("data-index"))); m.render(); return true; }
    if (act === "music-yt-jump") { m.jump(Number(el.getAttribute("data-index"))); return true; }
    if (act === "music-yt-clear") { m.clearUpNext(); m.render(); return true; }
    if (act === "music-yt-connect") { connect(); return true; }
    if (act === "music-yt-unlink") { prefs.linked = false; savePrefs(); m.applyHost(); m.render(); return true; }
    if (act === "music-yt-spotify") { spotifyImport(); return true; }
    if (act === "music-yt-tip-off") { prefs.tipOff = true; savePrefs(); m.render(); return true; }
    if (act === "music-yt-host") { prefs.host = el.getAttribute("data-host") === "youtube" ? "youtube" : "nocookie"; prefs.tipOff = prefs.host === "youtube" ? prefs.tipOff : false; savePrefs(); m.synced(); m.applyHost(); m.render(); return true; }
    if (act === "music-yt-form") return true;
    return true;
  }

  function submitSearch() {
    var input = document.getElementById("ytm-q");
    if (input) view.q = input.value;
    if (view.timer) { clearTimeout(view.timer); view.timer = 0; }
    paintResults();
  }
  function paintResults() {
    var box = document.querySelector(".ytm-results");
    if (!box) return;
    box.innerHTML = searchResults();
    if (m.settle) m.settle(box);
  }

  function onInput(event) {
    var target = event && event.target;
    if (!target || !m) return false;
    if (target.id === "ytm-q") {
      view.q = target.value;
      if (view.timer) clearTimeout(view.timer);
      /* Each search costs quota, so it waits for a pause in typing. */
      view.timer = setTimeout(function () { view.timer = 0; paintResults(); }, view.q.trim().length < 3 ? 1100 : 700);
      return true;
    }
    if (target.id === "ytm-spotify") { view.spotify = target.value; return true; }
    if (target.getAttribute && target.getAttribute("data-ytm-pref")) {
      var pref = target.getAttribute("data-ytm-pref");
      if (pref === "background") prefs.background = !!target.checked;
      else if (pref === "host" && target.checked) prefs.host = target.value === "youtube" || target.value === "nocookie" ? target.value : "auto";
      else if (pref === "quality" && target.checked) prefs.quality = target.value === "low" || target.value === "best" ? target.value : "auto";
      savePrefs();
      m.synced();
      if (pref === "host") m.applyHost();
      if (pref === "quality") m.applyQuality();
      return true;
    }
    return false;
  }

  function attach(helpers) {
    m = helpers;
    restore();
    if (typeof document !== "undefined") {
      document.addEventListener("change", function (event) {
        if (event.target && event.target.getAttribute && event.target.getAttribute("data-ytm-pref")) onInput(event);
      });
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && view.menu) { closeMenu(); return; }
        if (event.key === "Enter" && event.target && event.target.id === "ytm-q") { event.preventDefault(); submitSearch(); }
      });
      document.addEventListener("click", function (event) {
        if (!view.menu) return;
        var t = event.target;
        if (t && t.closest && (t.closest("#ytm-menu") || t.closest("[data-act='music-yt-menu']"))) {
          if (t.closest("#ytm-menu a")) setTimeout(closeMenu, 0);
          return;
        }
        closeMenu();
      }, true);
      root.addEventListener("hashchange", closeMenu);
      root.addEventListener("resize", closeMenu);
    }
  }

  root.ViktorychYTM = {
    attach: attach,
    isYt: isYt,
    vid: vid,
    song: song,
    remember: remember,
    played: played,
    page: page,
    titleFor: titleFor,
    libraryHtml: libraryHtml,
    trackRow: function (s) { return trackRow(s, "", 0); },
    radioIds: function (id) {
      var key = vid(id);
      if (!key) return Promise.resolve([]);
      return get("radio?id=" + key, 21600).then(function (body) { return songsOf(body).map(function (x) { return x.id; }); });
    },
    rows: trackRows,
    listIds: ids,
    onAct: onAct,
    onInput: onInput,
    embedHost: embedHost,
    pickQuality: pickQuality,
    qualityLabel: qualityLabel,
    nowPills: nowPills,
    tipHtml: tipHtml,
    low: low,
    background: background,
    exportSync: exportSync,
    importSync: importSync,
    moods: MOOD_KEYS,
    _state: function () { return { tracks: tracks, prefs: prefs, view: view, lists: lists }; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
