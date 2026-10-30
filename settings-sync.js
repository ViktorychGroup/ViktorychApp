/* Settings registry for account sync. Every setting that makes sense on
   another device is listed here with its category. Plain values merge by
   last write wins using prefsAt stamps; this file keeps the stamps and the
   "keep on this device only" choices. Device-only settings (network mode,
   playback source, zero trace, notification read state, music volume) are
   never listed and never leave the device. */
(function (root) {
  "use strict";
  var LOCAL_KEY = "viktorychapp-sync-local";
  var SEEN_KEY = "viktorychapp-sync-seen";
  var MUSIC_STORE = "viktorych-music-v1";
  var CATS = [
    { id: "look", label: "Look and menus", keys: [
      ["appearance", "Theme"], ["showPictures", "Profile pictures"], ["avatarShape", "Profile picture shape"], ["haptics", "Haptics"], ["showBanners", "Banners"],
      ["drawerMenu", "Menu order"], ["navCustom", "Sidebar"], ["brandLogo", "Sidebar logo"], ["bottomNav", "Bottom bar"], ["inboxLayout", "Inbox sections"], ["profileTabs", "Profile tabs"], ["keyboard", "Keyboard shortcuts"],
      ["accent", "Color"], ["fontSize", "Font size"], ["density", "Density"], ["reduceMotion", "Reduce motion"], ["aiFab", "Local AI button"], ["aiSetup", "Local AI setup"]
    ] },
    { id: "feed", label: "Feed", keys: [
      ["homePills", "Home pills"], ["stories", "Stories"], ["storyNotes", "Story notes"], ["autoplay", "Autoplay videos"],
      ["followingSort", "Following options"], ["forYouReposts", "Show reposts"], ["forYouReplies", "Show replies in tab"],
      ["livePreview", "Live previews"], ["friendsRail", "Friends panel"], ["translateTo", "Translate to"],
      ["translateAuto", "Automatically translate posts"], ["translateNever", "Never translate"],
      ["peopleLinks", "Merged profiles"], ["busyPrefs", "Posting volume"]
    ] },
    { id: "notifications", label: "Notifications", keys: [["notify", "Notifications"], ["bells", "Account alerts"], ["notifPrivacy", "Notification privacy"]] },
    { id: "privacy", label: "Privacy and mentions", keys: [
      ["mutedWords", "Muted words"], ["mutedAccounts", "Muted accounts"], ["blocks", "Muted & blocked"], ["privacyEmbedShield", "Third-party embed shield"],
      ["privacyWebRTC", "WebRTC leak protection"], ["privacyNoReferrer", "Strict no-referrer"], ["privacyStripTrackers", "Strip tracking parameters"],
      ["privacyAntiFingerprint", "Fingerprint resistance"]
    ] },
    { id: "music", label: "Music", keys: [["musicPrefs", "Player and liked songs"]] },
    { id: "language", label: "Language", keys: [["lang", "Display language"]] }
  ];
  // Plain values that merge by their own stamp. Lists such as muted words
  // keep their union merge in accounts.js.
  var LWW = ["appearance", "showPictures", "showBanners", "autoplay", "followingSort", "forYouReposts", "forYouReplies",
    "storyNotes", "livePreview", "friendsRail", "translateTo", "translateAuto", "translateNever", "notify", "bells", "notifPrivacy",
    "accent", "fontSize", "density", "reduceMotion",
    "privacyEmbedShield", "privacyWebRTC", "privacyNoReferrer", "privacyStripTrackers", "privacyAntiFingerprint", "peopleLinks", "avatarShape", "haptics", "keyboard", "busyPrefs", "inboxLayout", "aiFab", "aiSetup", "musicPrefs", "brandLogo"];
  var CAT_OF = {};
  CATS.forEach(function (cat) { cat.keys.forEach(function (row) { CAT_OF[row[0]] = cat.id; }); });
  // Companion keys travel with their setting.
  var COMPANIONS = { navCustom: ["navCustomAt"], bottomNav: ["bottomNavCustom"] };

  function store() { try { return root.localStorage; } catch (err) { return null; } }
  function readJson(key) {
    var ls = store();
    try { var raw = ls && ls.getItem(key); return raw ? JSON.parse(raw) : null; } catch (err) { return null; }
  }
  function writeJson(key, value) {
    var ls = store();
    try { if (ls) ls.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode */ }
  }
  // Settings that stay on this device unless the member chooses to share
  // them ("share" in the local choices). Inbox sections are per device.
  var DEFAULT_LOCAL = ["inboxLayout"];
  function readLocal() {
    var raw = readJson(LOCAL_KEY) || {};
    var str = function (id) { return typeof id === "string"; };
    return { cats: Array.isArray(raw.cats) ? raw.cats.filter(str) : [],
      keys: Array.isArray(raw.keys) ? raw.keys.filter(str) : [],
      share: Array.isArray(raw.share) ? raw.share.filter(str) : [] };
  }
  function toggle(list, id, on) {
    var at = list.indexOf(id);
    if (on && at < 0) list.push(id);
    if (!on && at >= 0) list.splice(at, 1);
  }
  function setCatLocal(id, on) { var cur = readLocal(); toggle(cur.cats, id, on); writeJson(LOCAL_KEY, cur); }
  function setKeyLocal(key, on) {
    var cur = readLocal();
    if (DEFAULT_LOCAL.indexOf(key) >= 0) toggle(cur.share, key, !on);
    else toggle(cur.keys, key, on);
    writeJson(LOCAL_KEY, cur);
  }
  function catLocal(id) { return readLocal().cats.indexOf(id) >= 0; }
  function keyLocal(key) {
    var cur = readLocal();
    if (DEFAULT_LOCAL.indexOf(key) >= 0 && cur.share.indexOf(key) < 0) return true;
    return cur.keys.indexOf(key) >= 0;
  }

  /* Keys this device keeps to itself. opts.allOff: the master switch is off.
     opts.lookOwn: the older "keep this device's look" override. */
  function localKeys(opts) {
    opts = opts || {};
    var cur = readLocal();
    var out = [];
    Object.keys(CAT_OF).forEach(function (key) {
      var cat = CAT_OF[key];
      var ownDefault = DEFAULT_LOCAL.indexOf(key) >= 0 && cur.share.indexOf(key) < 0;
      if (ownDefault || opts.allOff || cur.cats.indexOf(cat) >= 0 || cur.keys.indexOf(key) >= 0 || (opts.lookOwn && cat === "look")) {
        out.push(key);
        (COMPANIONS[key] || []).forEach(function (extra) { out.push(extra); });
      }
    });
    return out;
  }

  function readMusic() {
    var data = readJson(MUSIC_STORE);
    if (!data || typeof data !== "object") return undefined;
    var out = { shuffle: !!data.shuffle, repeat: data.repeat === "one" || data.repeat === "all" ? data.repeat : "off",
      view: data.view === "list" ? "list" : "grid", likes: Array.isArray(data.likes) ? data.likes.slice(0, 2000) : [] };
    /* Playlists follow the account once one was made or imported (YouTube,
       Spotify), kept small: 100 lists and 1500 songs in all. */
    if (data.playlistTouched && Array.isArray(data.playlists)) {
      var room = 1500;
      out.playlists = data.playlists.slice(0, 100).map(function (list) {
        var ids = Array.isArray(list && list.songIds) ? list.songIds.slice(0, Math.max(0, room)).map(String) : [];
        room -= ids.length;
        return { id: String((list && list.id) || "").slice(0, 80), name: String((list && list.name) || "").slice(0, 80), songIds: ids };
      }).filter(function (list) { return list.id; });
    }
    /* Titles for the YouTube songs those point at, so another device can
       show them before it asks YouTube. */
    var ytm = root.ViktorychYTM;
    if (ytm && ytm.exportSync) {
      try { out.yt = ytm.exportSync(out.likes, out.playlists || []); } catch (err) { /* left out this time */ }
    }
    return out;
  }
  function writeMusic(prefs) {
    if (!prefs || typeof prefs !== "object") return;
    var data = readJson(MUSIC_STORE) || {};
    data.shuffle = !!prefs.shuffle;
    data.repeat = prefs.repeat === "one" || prefs.repeat === "all" ? prefs.repeat : "off";
    data.view = prefs.view === "list" ? "list" : "grid";
    if (Array.isArray(prefs.likes)) data.likes = prefs.likes.slice(0, 2000);
    if (Array.isArray(prefs.playlists)) {
      data.playlists = prefs.playlists.slice(0, 100).filter(function (list) { return list && list.id; }).map(function (list) {
        return { id: String(list.id).slice(0, 80), name: String(list.name || "").slice(0, 80), songIds: Array.isArray(list.songIds) ? list.songIds.slice(0, 1500).map(String) : [] };
      });
      data.playlistTouched = true;
    }
    if (prefs.yt && typeof prefs.yt === "object") {
      var ytm = root.ViktorychYTM;
      if (ytm && ytm.importSync) { try { ytm.importSync(prefs.yt); } catch (err) { /* read on the next open */ } }
      else writeJson("ytm-sync-pending", prefs.yt);
    }
    writeJson(MUSIC_STORE, data);
    try { root.dispatchEvent(new CustomEvent("viktorych-music-prefs")); } catch (err) { /* the player reads it on open */ }
  }

  /* Stamps the plain values that changed since the last sync. The first run
     on a device records values with no stamp, so the account's copy wins. */
  function stamp(snap, now) {
    var seen = readJson(SEEN_KEY);
    var first = !seen || typeof seen !== "object" || !seen.v;
    if (first) seen = { v: {}, at: {}, synced: false };
    var at = snap.prefsAt && typeof snap.prefsAt === "object" ? snap.prefsAt : {};
    var changed = false;
    LWW.forEach(function (key) {
      if (snap[key] === undefined) return;
      var text = JSON.stringify(snap[key]);
      if (seen.v[key] !== text) {
        if (!first && seen.v[key] !== undefined) seen.at[key] = Number(now) || Date.now();
        seen.v[key] = text;
        changed = true;
      }
      var t = Math.max(Number(at[key]) || 0, Number(seen.at[key]) || 0);
      if (t) at[key] = t;
    });
    snap.prefsAt = at;
    if (changed || first) writeJson(SEEN_KEY, seen);
    return snap;
  }
  /* After the merged copy is applied: its values and stamps are now this
     device's baseline, so they are not taken for local edits. */
  function remember(payload) {
    var seen = readJson(SEEN_KEY) || { v: {}, at: {} };
    if (!seen.v) seen = { v: {}, at: {} };
    var at = (payload && payload.prefsAt) || {};
    LWW.forEach(function (key) {
      if (!payload || payload[key] === undefined) return;
      seen.v[key] = JSON.stringify(payload[key]);
      if (Number(at[key])) seen.at[key] = Number(at[key]);
    });
    seen.synced = true;
    writeJson(SEEN_KEY, seen);
  }
  function neverSynced() {
    var seen = readJson(SEEN_KEY);
    return !seen || seen.synced !== true;
  }
  /* Newer stamp wins. On a tie the device that has never synced takes the
     account's value, so a fresh device restores everything on sign-in. */
  function pick(local, remote, fresh) {
    var out = {};
    var at = {};
    var lAt = (local && local.prefsAt) || {};
    var rAt = (remote && remote.prefsAt) || {};
    LWW.forEach(function (key) {
      var lt = Number(lAt[key]) || 0;
      var rt = Number(rAt[key]) || 0;
      var lv = local ? local[key] : undefined;
      var rv = remote ? remote[key] : undefined;
      var useRemote = rt > lt || (rt === lt && fresh);
      var value = useRemote ? (rv !== undefined ? rv : lv) : (lv !== undefined ? lv : rv);
      if (value !== undefined) out[key] = value;
      if (lt || rt) at[key] = Math.max(lt, rt);
    });
    return { values: out, at: at };
  }

  var api = { CATS: CATS, LWW: LWW, DEFAULT_LOCAL: DEFAULT_LOCAL, CAT_OF: CAT_OF, localKeys: localKeys, readLocal: readLocal, setCatLocal: setCatLocal,
    setKeyLocal: setKeyLocal, catLocal: catLocal, keyLocal: keyLocal, readMusic: readMusic, writeMusic: writeMusic,
    stamp: stamp, remember: remember, neverSynced: neverSynced, pick: pick };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ViktorychSettingsSync = api;
})(typeof window !== "undefined" ? window : globalThis);
