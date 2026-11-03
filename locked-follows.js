/* Locked follows, like WhatsApp's Locked chats.

   Lock someone you follow and they disappear from your following list and
   count, your timelines, search, suggestions and notifications, on every
   device and for everyone who looks, until you open the Locked area on a
   device with its screen lock or your secret code. The Worker does the
   hiding (worker/src/locked-follows.js); this file is the UI:

   - "Lock follow" sheets from a profile's ⋯ menu and the following list
     (⋯ or long press)
   - first-time set-up: this device's screen lock, or a secret code
   - the unlock sheet, "Forgot code", and the Locked area (people, their
     posts, held notifications)
   - pull down on your Following list to show the way in, or keep it hidden
     and type the secret code into search
   - Settings > Privacy > Locked follows

   The device keeps only a salted, padded hash filter so posts already on
   the device can be hidden at once; it never stores who is locked. The
   unlock grant lives in memory for this tab only. */
(function (root) {
  "use strict";

  var FILTER_KEY = "viktorychapp-locked-filter";
  var RELOCKS = [0, 60, 300, 900];
  var doc = root.document;
  var info = null;          // last /state answer (without the filter)
  var filter = readFilter(); // { owner, salt, set }
  var grant = { token: "", until: 0, timer: 0 };
  var loading = null;
  var ui = { sheet: null, area: null, tab: "people", busy: false, error: "", pull: false, settingsOpen: false };
  var host = null;

  function tr(key, vars) {
    var lang = root.SI18n;
    if (lang && typeof lang.t === "function") return lang.t(key, vars);
    return String(key).replace(/\{(\w+)\}/g, function (m, name) { return vars && vars[name] != null ? String(vars[name]) : ""; });
  }
  function esc(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function accounts() { return root.ViktorychAccounts || null; }
  function me() { var a = accounts(); return a && a.account ? a.account() : null; }
  function token() { var a = accounts(); return a && a.token ? a.token() : ""; }
  /* owner() sits on the hottest path in the app: the timeline asks
     hidesId() for every feed and post on every paint. Reading the session
     means a localStorage read plus a JSON parse, so it is remembered for a
     moment and dropped whenever the session can have changed. */
  var ownerMemo = { value: "", at: -1e9 };
  function owner() {
    var now = Date.now();
    if (now - ownerMemo.at < 2000) return ownerMemo.value;
    var m = me();
    var next = m ? String(m.publicId || m.handle || "") : "";
    if (next !== ownerMemo.value) hideMemo.clear();
    ownerMemo.value = next; ownerMemo.at = now;
    return next;
  }
  function forgetOwner() { ownerMemo.at = -1e9; hideMemo.clear(); }
  var hideMemo = new Map();
  var filterVersion = 0;
  function redraw() { var a = accounts(); if (a && a.requestRender) a.requestRender(); }

  /* ---------- the device filter ---------- */

  function filterHash(salt, id) {
    var text = String(salt || "") + "|" + String(id || "").toLowerCase();
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193 ^ 0x5bd1e995;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
      h2 = (h2 ^ (h2 >>> 13)) >>> 0;
    }
    return ("0000000" + h1.toString(16)).slice(-8) + ("0000000" + h2.toString(16)).slice(-8);
  }
  function readFilter() {
    try {
      var raw = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
      if (raw && raw.salt && Array.isArray(raw.hashes)) return { owner: String(raw.owner || ""), salt: raw.salt, set: new Set(raw.hashes) };
    } catch (err) { /* private mode */ }
    return null;
  }
  function saveFilter(f) {
    forgetOwner();
    filterVersion++;
    filter = f ? { owner: owner(), salt: f.salt, set: new Set(f.hashes || []) } : null;
    try {
      if (f) localStorage.setItem(FILTER_KEY, JSON.stringify({ owner: owner(), salt: f.salt, hashes: f.hashes || [] }));
      else localStorage.removeItem(FILTER_KEY);
    } catch (err) { /* private mode */ }
  }
  /* True only when this device holds a filter with someone in it for the
     signed-in account. Lets callers skip per-item checks entirely. */
  function active() {
    if (!filter || !filter.set.size) return false;
    var o = owner();
    return !!o && filter.owner === o;
  }
  function hidesId(id) {
    if (!id || !active()) return false;
    var key = String(id);
    var hit = hideMemo.get(key);
    if (hit !== undefined) return hit;
    hit = filter.set.has(filterHash(filter.salt, key));
    if (hideMemo.size > 20000) hideMemo.clear();
    hideMemo.set(key, hit);
    return hit;
  }
  function hides(post) {
    if (!post || !active()) return false;
    if (hidesId(post.feedId)) return true;
    if (post.platform && post.handle && post.platform !== "app" && hidesId(post.platform + ":" + String(post.handle).replace(/^@/, ""))) return true;
    var handle = String(post.authorHandle || (post.platform === "app" ? post.handle : "") || "").replace(/^@/, "");
    if (handle && hidesId("app:@" + handle)) return true;
    if (post.authorId && /^\d{12}$/.test(String(post.authorId)) && hidesId("app:" + post.authorId)) return true;
    return false;
  }

  /* ---------- server ---------- */

  function call(path, opts) {
    var a = accounts();
    if (!a || !a.call || !token()) return Promise.resolve({ status: 401 });
    opts = opts || {};
    var headers = {};
    if (grant.token && grant.until > Date.now()) headers["X-Locked-Grant"] = grant.token;
    return a.call("/v1/locked-follows" + path, { method: opts.method || "GET", token: token(), body: opts.body, headers: headers })
      .catch(function () { return { status: 0 }; });
  }
  function unlocked() { return !!(grant.token && grant.until > Date.now()); }
  function takeGrant(res) {
    if (!res || !res.grant) return;
    clearTimeout(grant.timer);
    grant.token = res.grant;
    grant.until = Number(res.expiresAt) || (Date.now() + 120000);
    grant.timer = setTimeout(relock, Math.max(1000, grant.until - Date.now()));
  }
  function relock() {
    clearTimeout(grant.timer);
    if (grant.token) call("/relock", { method: "POST", body: {} });
    grant.token = ""; grant.until = 0;
    if (ui.area) closeArea(true);
  }
  function load(force) {
    if (!token()) return Promise.resolve(null);
    if (loading && !force) return loading;
    loading = call("/state").then(function (res) {
      loading = null;
      if (res && res.status === 200) {
        var before = stateKey();
        info = { setUp: !!res.setUp, code: !!res.code, device: !!res.device, hideEntry: !!res.hideEntry, relockSecs: Number(res.relockSecs) || 0, at: Date.now() };
        saveFilter(res.filter || null);
        /* Repaint only when something on screen can change, so a background
           state check never swaps the page under an open composer. */
        if (stateKey() !== before || /^#\/settings\/locked-follows|following/.test(String(root.location && root.location.hash || ""))) redraw();
      }
      return info;
    });
    return loading;
  }
  function stateKey() {
    var f = filter && filter.owner === owner() ? Array.from(filter.set).sort().join(",") : "";
    return f;
  }
  function afterChange() {
    var a = accounts();
    if (a && a.syncFollows) a.syncFollows();
    return load(true);
  }

  /* ---------- device screen lock (WebAuthn, platform only) ---------- */

  function b64u(buf) {
    var bytes = new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(text) {
    var s = String(text).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var deviceOk = null;
  function deviceAvailable() {
    if (deviceOk !== null) return Promise.resolve(deviceOk);
    var P = root.PublicKeyCredential;
    if (!P || !P.isUserVerifyingPlatformAuthenticatorAvailable || !root.isSecureContext) { deviceOk = false; return Promise.resolve(false); }
    return P.isUserVerifyingPlatformAuthenticatorAvailable().then(function (ok) { deviceOk = !!ok; return deviceOk; }, function () { deviceOk = false; return false; });
  }
  function creationFrom(pk) {
    var o = Object.assign({}, pk);
    o.challenge = unb64u(pk.challenge);
    o.user = Object.assign({}, pk.user, { id: unb64u(pk.user.id) });
    if (pk.excludeCredentials) o.excludeCredentials = pk.excludeCredentials.map(function (c) { return Object.assign({}, c, { id: unb64u(c.id) }); });
    return o;
  }
  function requestFrom(pk) {
    var o = Object.assign({}, pk);
    o.challenge = unb64u(pk.challenge);
    if (pk.allowCredentials) o.allowCredentials = pk.allowCredentials.map(function (c) { return Object.assign({}, c, { id: unb64u(c.id) }); });
    return o;
  }
  function credJson(cred) {
    var r = cred.response;
    var out = { id: cred.id, rawId: b64u(cred.rawId), type: cred.type, response: { clientDataJSON: b64u(r.clientDataJSON) } };
    if (r.attestationObject) out.response.attestationObject = b64u(r.attestationObject);
    if (r.authenticatorData) out.response.authenticatorData = b64u(r.authenticatorData);
    if (r.signature) out.response.signature = b64u(r.signature);
    return out;
  }
  function addDevice() {
    return call("/device/options", { method: "POST", body: {} }).then(function (opt) {
      if (!opt || opt.status !== 200) throw new Error("options");
      return navigator.credentials.create({ publicKey: creationFrom(opt.publicKey) }).then(function (cred) {
        return call("/device", { method: "POST", body: { challengeId: opt.challengeId, credential: credJson(cred) } });
      });
    }).then(function (res) {
      if (!res || res.status !== 200) throw new Error("device");
      takeGrant(res);
      return res;
    });
  }
  function unlockDevice() {
    return call("/unlock/options", { method: "POST", body: {} }).then(function (opt) {
      if (!opt || opt.status !== 200) throw new Error("options");
      return navigator.credentials.get({ publicKey: requestFrom(opt.publicKey) }).then(function (cred) {
        return call("/unlock", { method: "POST", body: { challengeId: opt.challengeId, credential: credJson(cred) } });
      });
    }).then(function (res) {
      if (!res || res.status !== 200) throw new Error("unlock");
      takeGrant(res);
      return res;
    });
  }

  /* ---------- sheets ---------- */

  function mount() {
    if (host || !doc || !doc.body) return host;
    host = doc.createElement("div");
    host.id = "lf-root";
    doc.body.appendChild(host);
    return host;
  }
  function paint() {
    mount();
    if (!host) return;
    var html = "";
    if (ui.area) html += areaHtml();
    if (ui.sheet) html += sheetHtml(ui.sheet);
    host.innerHTML = html;
    var input = host.querySelector("[data-lf-autofocus]");
    if (input && doc.activeElement !== input) { try { input.focus(); } catch (err) { /* fine */ } }
  }
  function openSheet(sheet) { ui.sheet = sheet; ui.error = ""; ui.busy = false; paint(); }
  function closeSheet() { ui.sheet = null; ui.error = ""; ui.busy = false; paint(); }

  function field(name, label, type, hint) {
    return '<label class="lf-field"><input name="' + name + '" type="' + (type || "password") + '" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder=" " minlength="4" maxlength="64" data-lf-autofocus>' +
      "<span>" + esc(label) + "</span></label>" + (hint ? '<p class="lf-hint">' + esc(hint) + "</p>" : "");
  }
  function row(act, label, sub, attrs, icon) {
    return '<button class="lf-row" type="button" data-lf-act="' + act + '" ' + (attrs || "") + ">" +
      (icon ? '<span class="lf-row-ico" aria-hidden="true">' + icon + "</span>" : "") +
      '<span class="lf-row-copy"><b>' + esc(label) + "</b>" + (sub ? "<span>" + esc(sub) + "</span>" : "") + "</span></button>";
  }
  var LOCK_ICON = '<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9zm3 4a2 2 0 0 1 1 3.73V19h-2v-1.27A2 2 0 0 1 12 14z"/></svg>';
  var FACE_ICON = '<svg viewBox="0 0 24 24"><path d="M4 4h4V2H2v6h2V4zm16 0v4h2V2h-6v2h4zM4 20v-4H2v6h6v-2H4zm16 0h-4v2h6v-6h-2v4zM9 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm6 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-6.2 4.4l-1.6 1.2C8.3 17.1 10 18 12 18s3.7-.9 4.8-2.4l-1.6-1.2c-.7 1-1.9 1.6-3.2 1.6s-2.5-.6-3.2-1.6zM13 8h-2v4h1.5v-1.5H13V8z"/></svg>';
  var KEY_ICON = '<svg viewBox="0 0 24 24"><path d="M7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm5.65-4A6 6 0 1 0 12.65 14H15v3h3v-3h2v-4h-7.35z"/></svg>';

  function sheetFrame(title, body, sub) {
    return '<div class="lf-back" data-lf-act="close-sheet"><div class="lf-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '" data-lf-stop="1">' +
      '<div class="lf-grab" aria-hidden="true"></div><h2 class="lf-title">' + esc(title) + "</h2>" + (sub ? '<p class="lf-sub">' + esc(sub) + "</p>" : "") + body +
      (ui.error ? '<p class="lf-error" role="alert">' + esc(ui.error) + "</p>" : "") + "</div></div>";
  }
  function pill(act, label, attrs, kind) {
    return '<button class="lf-pill' + (kind ? " " + kind : "") + '" type="' + (act === "submit" ? "submit" : "button") + '" ' + (act === "submit" ? "" : 'data-lf-act="' + act + '" ') + (attrs || "") + (ui.busy ? " disabled" : "") + ">" + esc(label) + "</button>";
  }

  function sheetHtml(s) {
    var who = s.name ? s.name : (s.handle ? "@" + s.handle : tr("this account"));
    if (s.kind === "menu") {
      return sheetFrame(who, row("lock", tr("Lock follow"), tr("Hide them everywhere until you unlock"), 'data-id="' + esc(s.id) + '"', LOCK_ICON) +
        pill("close-sheet", tr("Cancel"), "", "ghost"));
    }
    if (s.kind === "confirm") {
      return sheetFrame(tr("Lock follow with {name}?", { name: who }),
        '<ul class="lf-points"><li>' + esc(tr("They leave your following list, count, timelines, search and suggestions.")) + "</li><li>" +
        esc(tr("Their posts and notifications wait in the Locked area.")) + "</li><li>" +
        esc(tr("They still see you as a follower.")) + "</li></ul>" +
        pill("do-lock", tr("Lock"), 'data-id="' + esc(s.id) + '"') + pill("close-sheet", tr("Cancel"), "", "ghost"));
    }
    if (s.kind === "setup") {
      var deviceRow = s.device ? row("setup-device", tr("Use screen lock"), tr("Face, fingerprint or device PIN on this device"), "", FACE_ICON) : "";
      return sheetFrame(tr("Set up Locked follows"),
        deviceRow + row("setup-code", tr("Use a secret code"), tr("Works on every device. 4 to 64 characters."), "", KEY_ICON) +
        pill("close-sheet", tr("Not now"), "", "ghost"),
        tr("Choose how you open the Locked area. You can add the other way later."));
    }
    if (s.kind === "code") {
      return sheetFrame(s.change ? tr("Change secret code") : tr("Create a secret code"),
        '<form data-lf-form="code">' + field("code", tr("Secret code")) + field("again", tr("Confirm code"), "password", tr("Use something only you know. It’s stored only as a slow, salted hash.")) +
        pill("submit", tr("Save code")) + "</form>" + pill("close-sheet", tr("Cancel"), "", "ghost"));
    }
    if (s.kind === "unlock") {
      var dev = info && info.device ? pill("unlock-device", tr("Use screen lock")) : "";
      var codeForm = info && info.code ? '<form data-lf-form="unlock">' + field("code", tr("Secret code")) + pill("submit", tr("Unlock"), "", dev ? "ghost" : "") + "</form>" : "";
      return sheetFrame(tr("Open Locked follows"), dev + codeForm +
        '<button class="lf-link" type="button" data-lf-act="forgot">' + esc(tr("Forgot code?")) + "</button>",
        tr("Unlock on this device to see the people you locked."));
    }
    if (s.kind === "forgot") {
      return sheetFrame(tr("Reset your lock"),
        '<form data-lf-form="reset">' + field("accountNumber", tr("Account number"), "password", tr("Your locked people stay locked. You’ll set a new code next.")) +
        pill("submit", tr("Reset lock")) + "</form>" + pill("reset-passkey", tr("Use a passkey instead"), "", "ghost") + pill("close-sheet", tr("Cancel"), "", "ghost"),
        tr("Confirm it’s your account. Nobody is shown until you set up the lock again."));
    }
    if (s.kind === "off") {
      return sheetFrame(tr("Turn off Locked follows?"), '<p class="lf-sub">' + esc(tr("Everyone you locked goes back to your following list. Your code and screen lock for this are removed.")) + "</p>" +
        pill("do-off", tr("Turn off"), "", "danger") + pill("close-sheet", tr("Cancel"), "", "ghost"));
    }
    if (s.kind === "done") {
      return sheetFrame(s.title, (s.note ? '<p class="lf-sub">' + esc(s.note) + "</p>" : "") + pill("close-sheet", tr("Done")));
    }
    return "";
  }

  function busy(on) { ui.busy = on; paint(); }
  function fail(text) { ui.busy = false; ui.error = text; paint(); }

  /* Lock flow from a profile or a list row. */
  function lockFlow(id, name, handle) {
    if (!token()) return;
    load(true).then(function (st) {
      var target = { id: id, name: name || "", handle: handle || "" };
      if (st && st.setUp) { openSheet(Object.assign({ kind: "confirm" }, target)); return; }
      deviceAvailable().then(function (ok) { openSheet(Object.assign({ kind: "setup", device: ok, then: target }, target)); });
    });
  }
  function doLock(id) {
    busy(true);
    call("/lock", { method: "POST", body: { id: id } }).then(function (res) {
      if (res && res.status === 200) {
        afterChange().then(function () {
          // Locking from a profile or the list leaves nothing open behind.
          if (!ui.area) relock();
          openSheet({ kind: "done", title: tr("Follow locked"), note: tr("Pull down on your Following list or open Settings > Privacy > Locked follows to see them.") });
        });
      } else fail(tr("Couldn’t lock. Try again."));
    });
  }
  function afterSetup() {
    var t = ui.sheet && ui.sheet.then;
    load(true).then(function () {
      if (t && t.id) openSheet(Object.assign({ kind: "confirm" }, t));
      else if (ui.settingsOpen) { closeSheet(); redraw(); }
      else closeSheet();
    });
  }
  function unlockFlow(next) {
    load(true).then(function (st) {
      if (!st || !st.setUp) { deviceAvailable().then(function (ok) { openSheet({ kind: "setup", device: ok }); }); return; }
      if (unlocked()) { next && next(); return; }
      ui.after = next || null;
      openSheet({ kind: "unlock" });
      if (st.device && !st.code) tryDevice();
    });
  }
  function tryDevice() {
    busy(true);
    unlockDevice().then(function () { var n = ui.after; ui.after = null; closeSheet(); if (n) n(); },
      function () { fail(tr("Couldn’t unlock. Try again.")); });
  }

  /* ---------- the Locked area ---------- */

  function openArea() {
    unlockFlow(function () {
      ui.area = { people: null, posts: null, notes: null };
      ui.tab = "people";
      paint();
      fetchArea();
    });
  }
  function fetchArea() {
    call("/list").then(function (res) { if (ui.area) { ui.area.people = res && res.status === 200 ? res.accounts || [] : []; paint(); } });
    call("/posts").then(function (res) { if (ui.area) { ui.area.posts = res && res.status === 200 ? res.posts || [] : []; paint(); } });
    call("/notifications").then(function (res) { if (ui.area) { ui.area.notes = res && res.status === 200 ? res.items || [] : []; paint(); } });
  }
  function closeArea(silent) {
    ui.area = null;
    paint();
    if (!silent && info && Number(info.relockSecs) === 0) relock();
  }
  function face(p) {
    var letter = String(p.displayName || p.name || p.handle || "?").trim().charAt(0).toUpperCase() || "?";
    if (p.avatar && /^https:\/\//.test(p.avatar)) return '<img class="lf-ava" alt="" src="' + esc(p.avatar) + '">';
    return '<span class="lf-ava lf-ini" aria-hidden="true">' + esc(letter) + "</span>";
  }
  function areaHtml() {
    var a = ui.area;
    var tabs = [["people", tr("People")], ["posts", tr("Posts")], ["notes", tr("Notifications")]].map(function (t) {
      return '<button class="lf-tab' + (ui.tab === t[0] ? " on" : "") + '" type="button" role="tab" aria-selected="' + (ui.tab === t[0]) + '" data-lf-act="tab" data-tab="' + t[0] + '"><span>' + esc(t[1]) + "</span></button>";
    }).join("");
    var body = "";
    var loadingRow = '<p class="lf-empty">' + esc(tr("Loading…")) + "</p>";
    if (ui.tab === "people") {
      if (!a.people) body = loadingRow;
      else if (!a.people.length) body = '<div class="lf-empty"><h3>' + esc(tr("No locked follows")) + "</h3><p>" + esc(tr("Lock someone from their profile’s ⋯ menu or from your Following list.")) + "</p></div>";
      else body = a.people.map(function (p) {
        var rawId = String(p.id || "");
        var cut = rawId.indexOf(":");
        var derivedPlatform = cut > 0 ? rawId.slice(0, cut).toLowerCase() : "";
        var derivedHandle = cut > 0 && derivedPlatform !== "app" ? rawId.slice(cut + 1) : "";
        var platform = String(p.platform || derivedPlatform || "app").toLowerCase();
        var handle = String(p.handle || derivedHandle || "").replace(/^@/, "");
        var href = handle ? (platform && platform !== "app" && platform !== "x" ? "#/" + encodeURIComponent(platform) + "/" + encodeURIComponent(handle) : "#/@" + encodeURIComponent(handle)) : "";
        var label = p.displayName || p.name || handle || rawId;
        return '<div class="lf-person">' + face(p) + '<a class="lf-person-copy" href="' + esc(href) + '" data-lf-act="go"><b>' + esc(label) + "</b><span>" + (handle ? "@" + esc(handle) : esc(rawId)) + "</span></a>" +
          '<button class="lf-pill small ghost" type="button" data-lf-act="unlock-follow" data-id="' + esc(rawId || ("app:@" + handle)) + '">' + esc(tr("Unlock")) + "</button></div>";
      }).join("");
    } else if (ui.tab === "posts") {
      if (!a.posts) body = loadingRow;
      else if (!a.posts.length) body = '<p class="lf-empty">' + esc(tr("No posts from locked follows yet.")) + "</p>";
      else body = a.posts.map(function (p) {
        var name = p.authorName || p.name || "";
        var handle = String(p.authorHandle || p.handle || "");
        return '<article class="lf-post"><div class="lf-post-head"><b>' + esc(name) + "</b><span>@" + esc(handle) + " · " + esc(when(p.createdAt)) + '</span></div><p class="lf-post-body">' + esc(p.body || p.text || "") + "</p></article>";
      }).join("");
    } else {
      if (!a.notes) body = loadingRow;
      else if (!a.notes.length) body = '<p class="lf-empty">' + esc(tr("No held notifications.")) + "</p>";
      else body = a.notes.map(function (n) {
        return '<div class="lf-note"><b>' + esc(n.name || n.handle || "") + "</b> <span>" + esc(noteLine(n)) + '</span><span class="lf-when">' + esc(when(n.at)) + "</span></div>";
      }).join("");
    }
    return '<section class="lf-area" role="dialog" aria-modal="true" aria-label="' + esc(tr("Locked follows")) + '">' +
      '<header class="lf-area-bar"><button class="lf-icon" type="button" data-lf-act="close-area" aria-label="' + esc(tr("Back")) + '"><svg viewBox="0 0 24 24"><path d="M7.4 13l5.6 5.6-1.4 1.4-8-8 8-8 1.4 1.4L7.4 11H21v2H7.4z"/></svg></button>' +
      '<div class="lf-area-title"><b>' + esc(tr("Locked follows")) + "</b><span>" + esc(tr("Only on this device, until you leave")) + "</span></div>" +
      '<button class="lf-icon" type="button" data-lf-act="area-settings" aria-label="' + esc(tr("Settings")) + '"><svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.68 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.05.31-.08.63-.08.94s.02.63.07.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.12.22.39.3.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.48 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/></svg></button></header>' +
      '<div class="lf-tabs" role="tablist">' + tabs + "</div>" + '<div class="lf-area-body">' + body + "</div></section>";
  }
  function noteLine(n) {
    if (n.text) return n.text;
    if (n.kind === "follow") return tr("followed you");
    if (n.kind === "like") return tr("liked your post");
    if (n.kind === "reply") return tr("replied to you");
    if (n.kind === "mention") return tr("mentioned you");
    if (n.kind === "repost") return tr("reposted your post");
    return n.text || "";
  }
  function when(at) {
    var t = Number(at) || 0;
    if (!t) return "";
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return tr("now");
    if (s < 3600) return tr("{n}m", { n: String(Math.floor(s / 60)) });
    if (s < 86400) return tr("{n}h", { n: String(Math.floor(s / 3600)) });
    return tr("{n}d", { n: String(Math.floor(s / 86400)) });
  }

  /* ---------- Settings > Privacy > Locked follows ---------- */

  function relockLabel(n) {
    if (n === 0) return tr("Right away");
    if (n === 60) return tr("After 1 minute");
    if (n === 300) return tr("After 5 minutes");
    return tr("After 15 minutes");
  }
  function summary() {
    if (!info) { load(false); return ""; }
    return info.setUp ? tr("On") : tr("Off");
  }
  function settingsHtml() {
    ui.settingsOpen = true;
    if (!token()) return '<p class="phandle">' + esc(tr("Sign in to use Locked follows.")) + "</p>";
    if (!info) { load(false); return '<p class="phandle">' + esc(tr("Loading…")) + "</p>"; }
    var intro = '<p class="phandle set-desc">' + esc(tr("Lock people you follow to hide them from your following list and count, timelines, search, suggestions and notifications, everywhere, until you unlock on a device.")) + "</p>";
    var notes = '<p class="phandle set-desc lf-fine">' + esc(tr("People you lock still see you as a follower. The app owner can review locked follows for safety; every look is logged. Your code is never shown to anyone.")) + "</p>";
    if (!info.setUp) {
      return '<div class="lf-settings">' + intro + '<button class="lf-pill" type="button" data-lf-act="settings-setup">' + esc(tr("Set up Locked follows")) + "</button>" + notes + "</div>";
    }
    if (!unlocked()) {
      return '<div class="lf-settings">' + intro + '<div class="set-list">' + row("settings-unlock", tr("Open Locked follows"), tr("Unlock to change settings or see who’s locked"), "", LOCK_ICON) + "</div>" + notes + "</div>";
    }
    var out = '<div class="lf-settings">' + intro + '<div class="set-list">' + row("open-area", tr("Open Locked follows"), tr("People, posts and held notifications"), "", LOCK_ICON) + "</div>";
    out += '<button class="tab-switch' + (info.hideEntry ? " on" : "") + '" type="button" role="switch" aria-checked="' + (info.hideEntry ? "true" : "false") + '" data-lf-act="toggle-hide"' + (info.code ? "" : " disabled") + "><span>" + esc(tr("Hide the way in")) + "</span><i></i></button>";
    out += '<p class="phandle set-desc">' + esc(info.code ? tr("Nothing shows on your Following list. Type your secret code into search to open it.") : tr("Needs a secret code first.")) + "</p>";
    out += "<h3>" + esc(tr("Lock again")) + '</h3><div class="fp-choices" role="radiogroup">' + RELOCKS.map(function (n) {
      var on = Number(info.relockSecs) === n;
      return '<button class="fp-choice' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + on + '" data-lf-act="relock-pick" data-value="' + n + '"><span class="fp-dot" aria-hidden="true"></span><span class="fp-choice-copy"><b>' + esc(relockLabel(n)) + "</b></span></button>";
    }).join("") + "</div>";
    out += "<h3>" + esc(tr("How you unlock")) + '</h3><div class="set-list">' +
      row("change-code", info.code ? tr("Change secret code") : tr("Create a secret code"), "", "", KEY_ICON) +
      (deviceOk ? row("add-device", tr("Use screen lock on this device"), info.device ? tr("On for at least one device") : "", "", FACE_ICON) : "") +
      row("forgot", tr("Forgot code?"), tr("Reset with your account number or passkey"), "") + "</div>";
    out += '<button class="lf-pill danger ghost" type="button" data-lf-act="turn-off">' + esc(tr("Turn off Locked follows")) + "</button>";
    return out + notes + "</div>";
  }
  function patchPrefs(body) {
    call("/prefs", { method: "PATCH", body: body }).then(function (res) {
      if (res && res.status === 200) { info.hideEntry = !!res.hideEntry; info.relockSecs = Number(res.relockSecs) || 0; }
      redraw();
    });
  }

  /* ---------- the Following list ---------- */

  /* The hidden way in at the top of your own Following list: pulled down,
     not shown. */
  function pullHtml() {
    if (!token()) return "";
    if (!info) { load(false); return ""; }
    if (!info.setUp || info.hideEntry) return "";
    return '<div class="lf-pull' + (ui.pull ? " on" : "") + '" data-lf-pull="1"><button class="lf-row" type="button" data-lf-act="pull-open"><span class="lf-row-ico" aria-hidden="true">' + LOCK_ICON + '</span><span class="lf-row-copy"><b>' + esc(tr("Locked follows")) + "</b></span></button></div>";
  }
  function rowMenuHtml(id, name, handle) {
    return '<button class="lf-dots" type="button" data-lf-act="row-menu" data-id="' + esc(id) + '" data-name="' + esc(name || "") + '" data-handle="' + esc(handle || "") + '" aria-label="' + esc(tr("More")) + '"><svg viewBox="0 0 24 24"><path d="M3 12a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm7 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0zm7 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0z"/></svg></button>';
  }
  function reveal() { ui.pull = true; redraw(); setTimeout(function () { var el = doc.querySelector("[data-lf-pull]"); if (el) el.classList.add("on"); }, 0); }

  var drag = null;
  var press = null;
  function onDown(e) {
    var pt = e.touches ? e.touches[0] : e;
    var host = e.target && e.target.closest ? e.target.closest(".lf-pull-host") : null;
    if (host && (root.scrollY || doc.documentElement.scrollTop || 0) <= 0) drag = { y: pt.clientY, x: pt.clientX };
    var r = e.target && e.target.closest ? e.target.closest("[data-lf-row]") : null;
    if (r) {
      clearTimeout(press && press.t);
      press = { x: pt.clientX, y: pt.clientY, el: r, t: setTimeout(function () { press.fired = true; openRowMenu(r); }, 550) };
    }
  }
  function onMove(e) {
    var pt = e.touches ? e.touches[0] : e;
    if (press && (Math.abs(pt.clientY - press.y) > 10 || Math.abs(pt.clientX - press.x) > 10)) { clearTimeout(press.t); press = null; }
    if (drag && pt.clientY - drag.y > 70 && Math.abs(pt.clientX - drag.x) < 60) { drag = null; reveal(); }
  }
  function onUp(e) {
    drag = null;
    if (press) { clearTimeout(press.t); if (press.fired && e && e.cancelable) e.preventDefault(); press = null; }
  }
  function openRowMenu(el) {
    var id = el.getAttribute("data-lf-row") || el.getAttribute("data-id") || "";
    if (!id) return;
    openSheet({ kind: "menu", id: id, name: el.getAttribute("data-name") || "", handle: el.getAttribute("data-handle") || "" });
  }

  /* Hidden way in: the secret code typed into search. Only when the
     person chose to hide the way in, so ordinary searches never go out. */
  function onKey(e) {
    if (e.key !== "Enter") return;
    var input = e.target;
    if (!input || (input.id !== "explore-q" && input.id !== "side-q")) return;
    if (!info || !info.setUp || !info.hideEntry || !info.code) return;
    var text = String(input.value || "").trim();
    if (text.length < 4 || text.length > 64) return;
    call("/unlock", { method: "POST", body: { code: text, probe: true } }).then(function (res) {
      if (res && res.status === 200) {
        takeGrant(res);
        input.value = "";
        ui.area = { people: null, posts: null, notes: null };
        ui.tab = "people";
        paint();
        fetchArea();
      }
    });
  }

  /* ---------- clicks and forms ---------- */

  function onClick(e) {
    var stop = e.target.closest && e.target.closest("[data-lf-stop]");
    var el = e.target.closest ? e.target.closest("[data-lf-act]") : null;
    if (press && press.fired) { e.preventDefault(); e.stopPropagation(); return; }
    if (!el) return;
    var act = el.getAttribute("data-lf-act");
    if (act === "close-sheet" && stop && el !== e.target.closest("[data-lf-act]")) return;
    if (act === "close-sheet" && el.classList.contains("lf-back") && stop) return;
    if (el.disabled) return;
    if (act !== "go") e.preventDefault();
    var id = el.getAttribute("data-id") || "";
    if (act === "close-sheet") { closeSheet(); return; }
    if (act === "lock-follow" || act === "lock") {
      lockFlow(id, el.getAttribute("data-name") || (ui.sheet && ui.sheet.name) || "", el.getAttribute("data-handle") || (ui.sheet && ui.sheet.handle) || "");
      return;
    }
    if (act === "row-menu") { openRowMenu(el); return; }
    if (act === "do-lock") { doLock(id); return; }
    if (act === "setup-code") { var then = ui.sheet && ui.sheet.then; openSheet({ kind: "code", then: then }); return; }
    if (act === "setup-device") {
      var t = ui.sheet && ui.sheet.then;
      busy(true);
      addDevice().then(function () { ui.sheet = { kind: "setup", then: t }; afterSetup(); }, function () { fail(tr("Screen lock didn’t work here. Use a secret code.")); });
      return;
    }
    if (act === "unlock-device") { tryDevice(); return; }
    if (act === "forgot") { openSheet({ kind: "forgot" }); return; }
    if (act === "reset-passkey") { resetPasskey(); return; }
    if (act === "pull-open" || act === "open-area") { openArea(); return; }
    if (act === "close-area") { closeArea(false); return; }
    if (act === "area-settings") { closeArea(true); root.location.hash = "#/settings/locked-follows"; return; }
    if (act === "go") { closeArea(false); return; }
    if (act === "tab") { ui.tab = el.getAttribute("data-tab") || "people"; paint(); return; }
    if (act === "unlock-follow") {
      el.disabled = true;
      call("/unlock-follow", { method: "POST", body: { id: id } }).then(function (res) {
        if (res && res.status === 200 && ui.area) {
          ui.area.people = (ui.area.people || []).filter(function (p) { return (p.id || "") !== id && ("app:@" + String(p.handle || "").replace(/^@/, "")) !== id; });
          paint();
          afterChange();
        } else el.disabled = false;
      });
      return;
    }
    if (act === "settings-setup") { deviceAvailable().then(function (ok) { openSheet({ kind: "setup", device: ok }); }); return; }
    if (act === "settings-unlock") { unlockFlow(function () { deviceAvailable().then(redraw); }); return; }
    if (act === "toggle-hide") { patchPrefs({ hideEntry: !info.hideEntry }); return; }
    if (act === "relock-pick") { patchPrefs({ relockSecs: Number(el.getAttribute("data-value")) || 0 }); return; }
    if (act === "change-code") { openSheet({ kind: "code", change: info && info.code }); return; }
    if (act === "add-device") { busy(true); addDevice().then(function () { closeSheet(); load(true); }, function () { fail(tr("Screen lock didn’t work here. Use a secret code.")); openSheet({ kind: "done", title: tr("Screen lock didn’t work here. Use a secret code.") }); }); return; }
    if (act === "turn-off") { openSheet({ kind: "off" }); return; }
    if (act === "do-off") {
      busy(true);
      call("/off", { method: "POST", body: {} }).then(function (res) {
        if (res && res.status === 200) { grant.token = ""; closeSheet(); afterChange(); }
        else fail(tr("Couldn’t save. Try again."));
      });
      return;
    }
  }
  function resetPasskey() {
    busy(true);
    var a = accounts();
    a.call("/v1/locked-follows/reset/options", { method: "POST", token: token(), body: {} }).then(function (opt) {
      if (!opt || opt.status !== 200) throw new Error("none");
      return navigator.credentials.get({ publicKey: requestFrom(opt.publicKey) }).then(function (cred) {
        return a.call("/v1/locked-follows/reset", { method: "POST", token: token(), body: { challengeId: opt.challengeId, credential: credJson(cred) } });
      });
    }).then(function (res) {
      if (res && res.status === 200) afterReset(); else throw new Error("reset");
    }).catch(function () { fail(tr("Couldn’t confirm with a passkey. Use your account number.")); });
  }
  function afterReset() {
    grant.token = "";
    load(true).then(function () { openSheet({ kind: "code" }); });
  }
  function onSubmit(e) {
    var form = e.target && e.target.closest ? e.target.closest("[data-lf-form]") : null;
    if (!form) return;
    e.preventDefault();
    var kind = form.getAttribute("data-lf-form");
    var value = function (n) { var el = form.querySelector('[name="' + n + '"]'); return el ? String(el.value || "") : ""; };
    if (kind === "code") {
      var code = value("code").trim();
      if (code.length < 4) { fail(tr("Use at least 4 characters.")); return; }
      if (code !== value("again").trim()) { fail(tr("The codes don’t match.")); return; }
      busy(true);
      var then = ui.sheet && ui.sheet.then;
      call("/code", { method: "POST", body: { code: code } }).then(function (res) {
        if (res && res.status === 200) { takeGrant(res); ui.sheet = { kind: "code", then: then }; afterSetup(); }
        else if (res && res.status === 403) fail(tr("Unlock first to change your code."));
        else fail(tr("Couldn’t save. Try again."));
      });
      return;
    }
    if (kind === "unlock") {
      busy(true);
      call("/unlock", { method: "POST", body: { code: value("code") } }).then(function (res) {
        if (res && res.status === 200) { takeGrant(res); var n = ui.after; ui.after = null; closeSheet(); if (n) n(); redraw(); }
        else if (res && (res.status === 429 || res.retryAfter)) fail(tr("Too many tries. Wait a bit and try again."));
        else fail(tr("That code isn’t right."));
      });
      return;
    }
    if (kind === "reset") {
      busy(true);
      accounts().call("/v1/locked-follows/reset", { method: "POST", token: token(), body: { accountNumber: value("accountNumber").replace(/\s+/g, "") } }).then(function (res) {
        if (res && res.status === 200) afterReset();
        else if (res && res.status === 429) fail(tr("Too many tries. Wait a bit and try again."));
        else fail(tr("That account number isn’t right."));
      });
    }
  }

  /* Another tab signed in, out, or changed the filter: forget what was
     remembered so the next check reads it fresh. */
  if (root.addEventListener) {
    root.addEventListener("storage", function (e) {
      if (e && e.key && !/account-v1|accounts-session|locked-filter/.test(e.key)) return;
      if (!e || !e.key || /locked-filter/.test(e.key)) { filter = readFilter(); filterVersion++; }
      forgetOwner();
    });
  }

  if (doc) {
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("submit", onSubmit, true);
    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && ui.sheet) { closeSheet(); return; }
      onKey(e);
    }, true);
    doc.addEventListener("touchstart", onDown, { passive: true });
    doc.addEventListener("touchmove", onMove, { passive: true });
    doc.addEventListener("touchend", onUp);
    doc.addEventListener("mousedown", onDown);
    doc.addEventListener("mousemove", function (e) { if (drag || press) onMove(e); });
    doc.addEventListener("mouseup", onUp);
    doc.addEventListener("contextmenu", function (e) {
      var r = e.target && e.target.closest ? e.target.closest("[data-lf-row]") : null;
      if (r) { e.preventDefault(); openRowMenu(r); }
    });
    doc.addEventListener("visibilitychange", function () {
      if (doc.visibilityState === "hidden" && info && Number(info.relockSecs) === 0 && unlocked()) relock();
    });
    root.addEventListener("hashchange", function () {
      ui.pull = false;
      if (!/^#\/settings\/locked-follows|following/.test(root.location.hash)) ui.settingsOpen = false;
    });
    setTimeout(function () { if (token()) load(false); deviceAvailable(); }, 1500);
  }

  root.ViktorychLocked = {
    hides: hides,
    hidesId: hidesId,
    active: active,
    version: function () { return filterVersion + ":" + (active() ? owner() : ""); },
    load: load,
    lockFlow: lockFlow,
    openArea: openArea,
    reveal: reveal,
    pullHtml: pullHtml,
    rowMenuHtml: rowMenuHtml,
    settingsHtml: settingsHtml,
    summary: summary,
    unlocked: unlocked,
    setUp: function () { return !!(info && info.setUp); },
    lockedNotice: function () {
      openSheet({ kind: "done", title: tr("You follow them in Locked follows"), note: tr("Open Locked follows to manage this follow.") });
    },
    grantHeader: function () { return unlocked() ? grant.token : ""; },
    _filterHash: filterHash
  };
})(typeof window !== "undefined" ? window : this);
