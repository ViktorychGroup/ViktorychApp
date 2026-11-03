/* Private custom names for any account: other networks (X, Reddit, YouTube,
   forums, RSS...), people merged across networks, and site accounts.
   Local-first: one cached map applies names instantly and offline; edits
   queue on the device and sync to the Worker (only the viewer can read
   them). Site-account nicknames use /v1/nicknames, the rest
   /v1/nicknames/external. Names are never sent to anyone else. */
(function (root) {
  "use strict";

  var NICK_MAX = 50;
  var ALIAS = { bluesky: "bsky", twitter: "x", fediverse: "mastodon" };
  var deps = {};
  var scope = "";
  var store = { ext: {}, app: {}, pending: {}, syncedAt: 0 };
  var version = 0;
  var memo = {};
  var syncing = null;
  var sheet = null;

  function tr(key, vars) {
    var fn = root.t || (typeof window !== "undefined" && window.t);
    var out = fn ? fn(key, vars) : key;
    if (vars && out === key) Object.keys(vars).forEach(function (k) { out = out.replace("{" + k + "}", vars[k]); });
    return out;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function clean(raw) {
    return String(raw == null ? "" : raw).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, NICK_MAX);
  }

  /* Same folding as normalizeSourceKey in worker/src/name-rules.js. */
  function keyOf(platform, handle) {
    var p = String(platform || "x").trim().toLowerCase();
    p = ALIAS[p] || p;
    if (!/^[a-z][a-z0-9_-]{0,23}$/.test(p)) return "";
    var id = String(handle == null ? "" : handle).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, "").toLowerCase().replace(/^@+/, "");
    if (p === "reddit") id = id.replace(/^\/?u(ser)?\//, "").replace(/^\/r\//, "r/");
    if (!id || id.length > 200 || !/^[^<>"'`\\]+$/.test(id)) return "";
    return p + ":" + id;
  }

  function enabled() {
    try { return deps.enabled ? deps.enabled() !== false : true; } catch (err) { return true; }
  }

  function account() {
    try { return deps.account ? deps.account() : null; } catch (err) { return null; }
  }

  function signed() {
    try { return !!(deps.token && deps.token()); } catch (err) { return false; }
  }

  function scopeNow() {
    var a = account();
    return a ? "a:" + String(a.publicId || a.id || a.handle || "me") : "local";
  }

  function storageKey(s) { return "vk-nicknames-v1:" + s; }

  function read(s) {
    try {
      var raw = root.localStorage ? root.localStorage.getItem(storageKey(s)) : "";
      var doc = raw ? JSON.parse(raw) : null;
      if (doc && typeof doc === "object") return { ext: doc.ext || {}, app: doc.app || {}, pending: doc.pending || {}, syncedAt: Number(doc.syncedAt) || 0 };
    } catch (err) { /* private mode */ }
    return { ext: {}, app: {}, pending: {}, syncedAt: 0 };
  }

  function save() {
    try { if (root.localStorage) root.localStorage.setItem(storageKey(scope), JSON.stringify(store)); } catch (err) { /* full or private */ }
  }

  function changed() {
    version += 1;
    memo = {};
    if (deps.render) { try { deps.render(); } catch (err) { /* next paint */ } }
  }

  function ensureScope() {
    var now = scopeNow();
    if (now === scope) return;
    var before = scope;
    scope = now;
    store = read(scope);
    /* Names set before signing in move to the account once. */
    if (before === "local" && now !== "local") {
      var local = read("local");
      Object.keys(local.ext).forEach(function (k) {
        if (!store.ext[k]) { store.ext[k] = local.ext[k]; store.pending["ext|" + k] = { name: local.ext[k].name, at: local.ext[k].at || Date.now() }; }
      });
      try { if (root.localStorage) root.localStorage.removeItem(storageKey("local")); } catch (err) { /* ignore */ }
      save();
    }
    memo = {};
    version += 1;
  }

  function has() {
    ensureScope();
    for (var k in store.ext) if (Object.prototype.hasOwnProperty.call(store.ext, k)) return true;
    for (var j in store.app) if (Object.prototype.hasOwnProperty.call(store.app, j)) return true;
    return false;
  }

  function aliases(platform, handle) {
    var list = [];
    try { list = deps.aliases ? deps.aliases(platform, handle) || [] : []; } catch (err) { list = []; }
    var own = keyOf(platform, handle);
    if (own && list.indexOf(own) < 0) list.unshift(own);
    return list;
  }

  function entryFor(key) {
    if (!key) return null;
    if (key.indexOf("app:") === 0) return store.app[key.slice(4)] || null;
    return store.ext[key] || null;
  }

  /* The custom name this viewer gave the account, or "". */
  function get(platform, handle) {
    if (!enabled() || !has()) return "";
    var id = String(platform || "x") + "\u0001" + String(handle || "");
    if (Object.prototype.hasOwnProperty.call(memo, id)) return memo[id];
    var p = String(platform || "x").toLowerCase();
    var keys = p === "app" ? ["app:" + String(handle || "").replace(/^@/, "").toLowerCase()] : aliases(platform, handle);
    var name = "";
    for (var i = 0; i < keys.length && !name; i++) {
      var hit = entryFor(keys[i]);
      if (hit && hit.name) name = hit.name;
    }
    memo[id] = name;
    return name;
  }

  function nameFor(platform, handle, fallback) {
    return get(platform, handle) || fallback || "";
  }

  function call(path, opts) {
    if (!deps.api) return Promise.resolve({ status: 503 });
    var next = opts || {};
    try { if (!next.token && deps.token) next.token = deps.token(); } catch (err) { /* signed out */ }
    var timer = null;
    return Promise.race([
      deps.api(path, next),
      new Promise(function (resolve) { timer = setTimeout(function () { resolve({ status: 0, error: "timeout" }); }, 8000); })
    ]).then(function (res) { clearTimeout(timer); return res || { status: 0 }; }, function () { clearTimeout(timer); return { status: 0 }; });
  }

  function flush() {
    var keys = Object.keys(store.pending);
    if (!keys.length || !signed()) return Promise.resolve();
    return keys.reduce(function (chain, pk) {
      return chain.then(function () {
        var row = store.pending[pk];
        if (!row) return null;
        var kind = pk.slice(0, 4);
        var key = pk.slice(4);
        var req = kind === "app|"
          ? call("/v1/nicknames", { method: "PUT", body: { handle: key, name: row.name } })
          : call("/v1/nicknames/external", { method: row.name ? "PUT" : "DELETE", body: { key: key, name: row.name } });
        return req.then(function (res) {
          var st = res && res.status;
          /* Done, or refused for good (bad key, unknown account): stop retrying. */
          if (st === 200 || st === 400 || st === 404 || st === 409) {
            if (store.pending[pk] === row) delete store.pending[pk];
            if (st === 404 && kind === "app|") { delete store.app[key]; changed(); }
            save();
          }
        });
      });
    }, Promise.resolve());
  }

  function apply(ext, app) {
    var nextExt = {};
    (ext || []).forEach(function (row) { if (row && row.key && row.name) nextExt[row.key] = { name: clean(row.name), at: Number(row.at) || 0 }; });
    var nextApp = {};
    (app || []).forEach(function (row) { if (row && row.handle && row.name) nextApp[String(row.handle).toLowerCase()] = { name: clean(row.name), at: 0 }; });
    Object.keys(store.pending).forEach(function (pk) {
      var row = store.pending[pk];
      var key = pk.slice(4);
      var into = pk.slice(0, 4) === "app|" ? nextApp : nextExt;
      if (row.name) into[key] = { name: row.name, at: row.at };
      else delete into[key];
    });
    /* Repaint only when a name really changed: a sync must not redraw the
       page under someone who is typing. */
    var names = function (map) { return Object.keys(map).sort().map(function (k) { return k + "=" + map[k].name; }).join("\n"); };
    var differs = names(nextExt) !== names(store.ext) || (app && names(nextApp) !== names(store.app));
    store.ext = nextExt;
    if (app) store.app = nextApp;
    store.syncedAt = Date.now();
    save();
    if (differs) changed();
  }

  /* Pull the server copy (at most every 10 minutes unless forced). */
  function sync(force) {
    ensureScope();
    if (!enabled() || !signed()) return Promise.resolve();
    if (!force && Date.now() - store.syncedAt < 10 * 60 * 1000 && !Object.keys(store.pending).length) return Promise.resolve();
    if (syncing) return syncing;
    syncing = flush().then(function () {
      return Promise.all([call("/v1/nicknames/external"), call("/v1/nicknames")]);
    }).then(function (got) {
      if (got[0] && got[0].status === 200) apply(got[0].nicknames || [], got[1] && got[1].status === 200 ? got[1].nicknames || [] : null);
    }).catch(function () {}).then(function () { syncing = null; });
    return syncing;
  }

  function setKey(key, name) {
    ensureScope();
    var value = clean(name);
    var now = Date.now();
    if (key.indexOf("app:") === 0) {
      var h = key.slice(4).toLowerCase();
      if (value) store.app[h] = { name: value, at: now }; else delete store.app[h];
      store.pending["app|" + h] = { name: value, at: now };
    } else {
      if (value) store.ext[key] = { name: value, at: now }; else delete store.ext[key];
      if (scope !== "local") store.pending["ext|" + key] = { name: value, at: now };
    }
    save();
    changed();
    if (signed()) flush().then(function () { if (key.indexOf("app:") === 0 && deps.refreshAccount) deps.refreshAccount(key.slice(4)); });
    return value;
  }

  function set(platform, handle, name) {
    var p = String(platform || "x").toLowerCase();
    var key = p === "app" ? "app:" + String(handle || "").replace(/^@/, "").toLowerCase() : (p === "person" ? "person:" + String(handle || "").toLowerCase() : keyOf(platform, handle));
    if (!key) return "";
    return setKey(key, name);
  }

  function list() {
    ensureScope();
    var out = [];
    Object.keys(store.ext).forEach(function (k) { out.push({ key: k, platform: k.slice(0, k.indexOf(":")), id: k.slice(k.indexOf(":") + 1), name: store.ext[k].name, at: store.ext[k].at || 0 }); });
    return out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  /* Every name this viewer set: site accounts (platform "app") and other networks. */
  function listAll() {
    ensureScope();
    var out = list();
    Object.keys(store.app).forEach(function (h) { out.push({ key: "app:" + h, platform: "app", id: h, name: store.app[h].name, at: store.app[h].at || 0 }); });
    return out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z"/></svg>';
  var CHEV_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14.586 12 7.543 4.96l1.414-1.42L17.414 12l-8.457 8.46-1.414-1.42z"/></svg>';

  /* ---- The "Set custom name" sheet ---- */

  function closeSheet() {
    if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
    sheet = null;
  }

  /* opts: platform, handle, original, personId (merged person), avatarHtml */
  function openSheet(opts) {
    if (typeof document === "undefined" || !opts) return;
    ensureScope();
    closeSheet();
    var platform = String(opts.platform || "x");
    var handle = String(opts.handle || "").replace(/^@/, "");
    var personId = String(opts.personId || "");
    var original = String(opts.original || handle);
    var accountKey = platform === "app" ? "app:" + handle.toLowerCase() : keyOf(platform, handle);
    var personKey = personId ? "person:" + personId.toLowerCase() : "";
    var own = entryFor(accountKey);
    var merged = personKey ? entryFor(personKey) : null;
    var current = (own && own.name) || (merged && merged.name) || "";
    var useAll = personKey ? !(own && own.name) : false;
    var wrap = document.createElement("div");
    wrap.className = "nick-sheet-wrap";
    wrap.setAttribute("data-nick-sheet", "");
    wrap.innerHTML =
      '<div class="nick-sheet" role="dialog" aria-modal="true" aria-labelledby="nick-sheet-title">' +
        '<div class="nick-sheet-head"><button type="button" class="nick-x" data-nick="close" aria-label="' + esc(tr("Close")) + '">×</button>' +
        '<h2 id="nick-sheet-title">' + esc(tr("Set custom name")) + "</h2>" +
        '<button type="button" class="nick-save" data-nick="save">' + esc(tr("Save")) + "</button></div>" +
        '<p class="nick-sub">' + esc(tr("Only you see this name. It shows everywhere this account appears.")) + "</p>" +
        '<label class="nick-field"><span class="nick-label">' + esc(tr("Name")) + '</span><input type="text" data-nick-input maxlength="' + NICK_MAX + '" value="' + esc(current) + '" placeholder="' + esc(original) + '" autocomplete="off" spellcheck="false"><span class="nick-count" data-nick-count>' + current.length + " / " + NICK_MAX + "</span></label>" +
        (personKey ? '<label class="nick-scope"><span class="nick-scope-copy">' + esc(tr("Use for all their linked accounts")) + '</span><input type="checkbox" class="nick-check-input" data-nick-all' + (useAll ? " checked" : "") + '><span class="nick-check" aria-hidden="true">' + CHECK_SVG + "</span></label>" : "") +
        (current ? '<button type="button" class="nick-reset" data-nick="reset">' + esc(tr("Reset to: {name}", { name: original })) + "</button>" : "") +
      "</div>";
    wrap.addEventListener("click", function (event) {
      var el = event.target && event.target.closest ? event.target.closest("[data-nick]") : null;
      if (event.target === wrap) { closeSheet(); return; }
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      var act = el.getAttribute("data-nick");
      var input = wrap.querySelector("[data-nick-input]");
      var all = wrap.querySelector("[data-nick-all]");
      var useMerged = !!(all && all.checked);
      if (act === "close") { closeSheet(); return; }
      if (act === "reset") {
        if (accountKey) setKey(accountKey, "");
        if (personKey) setKey(personKey, "");
        closeSheet();
        if (deps.toast) deps.toast(tr("Name reset"));
        return;
      }
      if (act === "save") {
        var value = clean(input ? input.value : "");
        if (useMerged) { setKey(personKey, value); if (own && own.name) setKey(accountKey, ""); }
        else if (accountKey) setKey(accountKey, value);
        closeSheet();
        if (deps.toast) deps.toast(value ? tr("Custom name saved") : tr("Name reset"));
      }
    }, true);
    wrap.addEventListener("input", function (event) {
      var input = event.target;
      if (!input || !input.hasAttribute || !input.hasAttribute("data-nick-input")) return;
      var count = wrap.querySelector("[data-nick-count]");
      if (count) count.textContent = String(input.value.length) + " / " + NICK_MAX;
    });
    wrap.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeSheet();
      if (event.key === "Enter" && event.target && event.target.hasAttribute && event.target.hasAttribute("data-nick-input")) {
        var btn = wrap.querySelector('[data-nick="save"]');
        if (btn) btn.click();
      }
    });
    document.body.appendChild(wrap);
    sheet = wrap;
    var field = wrap.querySelector("[data-nick-input]");
    if (field) { try { field.focus(); field.select(); } catch (err) { /* old Safari */ } }
  }

  /* "Add a custom name": pick the network (X-style radio rows), the account
     and the name. opts.platforms: [{ id, name, glyph }]. */
  function openAddSheet(opts) {
    if (typeof document === "undefined") return;
    ensureScope();
    closeSheet();
    var nets = (opts && opts.platforms) || [{ id: "x", name: "X", glyph: "" }];
    var pick = nets[0].id;
    var listOpen = false;
    var wrap = document.createElement("div");
    wrap.className = "nick-sheet-wrap";
    wrap.setAttribute("data-nick-sheet", "add");
    function netOf(id) { for (var i = 0; i < nets.length; i++) if (nets[i].id === id) return nets[i]; return nets[0]; }
    function paint() {
      var cur = netOf(pick);
      var acct = wrap.querySelector("[data-nick-acct]");
      var name = wrap.querySelector("[data-nick-input]");
      var keepA = acct ? acct.value : "";
      var keepN = name ? name.value : "";
      wrap.innerHTML =
        '<div class="nick-sheet" role="dialog" aria-modal="true" aria-labelledby="nick-sheet-title">' +
          '<div class="nick-sheet-head"><button type="button" class="nick-x" data-nick="close" aria-label="' + esc(tr("Close")) + '">×</button>' +
          '<h2 id="nick-sheet-title">' + esc(tr("Add a custom name")) + "</h2>" +
          '<button type="button" class="nick-save" data-nick="save"' + (keepA.trim() && keepN.trim() ? "" : " disabled") + ">" + esc(tr("Save")) + "</button></div>" +
          '<p class="nick-sub">' + esc(tr("Only you see this name. It shows everywhere this account appears.")) + "</p>" +
          '<button type="button" class="nick-pick" data-nick="pick" aria-expanded="' + (listOpen ? "true" : "false") + '"><span class="nick-pick-copy"><span class="nick-label">' + esc(tr("Network")) + '</span><span class="nick-pick-value">' + esc(cur.name) + '</span></span><span class="nick-pick-chev' + (listOpen ? " open" : "") + '">' + CHEV_SVG + "</span></button>" +
          (listOpen ? '<div class="nick-radios" role="radiogroup" aria-label="' + esc(tr("Network")) + '">' + nets.map(function (n) {
            var on = n.id === pick;
            return '<button type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" class="nick-radio' + (on ? " on" : "") + '" data-nick="net" data-net="' + esc(n.id) + '"><span class="nick-radio-ico">' + (n.glyph || esc(String(n.name).slice(0, 1))) + '</span><span class="nick-radio-name">' + esc(n.name) + '</span><span class="nick-radio-dot" aria-hidden="true"></span></button>';
          }).join("") + "</div>" : "") +
          '<label class="nick-field"><span class="nick-label">' + esc(tr("Account")) + '</span><input type="text" data-nick-acct value="' + esc(keepA) + '" placeholder="@name" autocomplete="off" autocapitalize="off" spellcheck="false"></label>' +
          '<label class="nick-field"><span class="nick-label">' + esc(tr("Name")) + '</span><input type="text" data-nick-input maxlength="' + NICK_MAX + '" value="' + esc(keepN) + '" autocomplete="off" spellcheck="false"><span class="nick-count" data-nick-count>' + keepN.length + " / " + NICK_MAX + "</span></label>" +
        "</div>";
    }
    wrap.addEventListener("click", function (event) {
      if (event.target === wrap) { closeSheet(); return; }
      var el = event.target && event.target.closest ? event.target.closest("[data-nick]") : null;
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      var act = el.getAttribute("data-nick");
      if (act === "close") { closeSheet(); return; }
      if (act === "pick") { listOpen = !listOpen; paint(); return; }
      if (act === "net") { pick = el.getAttribute("data-net") || pick; listOpen = false; paint(); var f = wrap.querySelector("[data-nick-acct]"); if (f) f.focus(); return; }
      if (act === "save") {
        var acct = wrap.querySelector("[data-nick-acct]");
        var input = wrap.querySelector("[data-nick-input]");
        var handle = String(acct ? acct.value : "").trim().replace(/^@/, "");
        var value = clean(input ? input.value : "");
        if (!handle || !value) return;
        var done = set(pick, handle, value);
        closeSheet();
        if (deps.toast) deps.toast(done ? tr("Custom name saved") : tr("That account name isn't valid."));
      }
    }, true);
    wrap.addEventListener("input", function (event) {
      var t = event.target;
      if (!t || !t.hasAttribute) return;
      var count = wrap.querySelector("[data-nick-count]");
      var name = wrap.querySelector("[data-nick-input]");
      var acct = wrap.querySelector("[data-nick-acct]");
      if (count && name) count.textContent = String(name.value.length) + " / " + NICK_MAX;
      var btn = wrap.querySelector('[data-nick="save"]');
      if (btn) btn.disabled = !(acct && acct.value.trim() && name && name.value.trim());
    });
    wrap.addEventListener("keydown", function (event) {
      if (event.key === "Escape") closeSheet();
      if (event.key === "Enter" && event.target && event.target.tagName === "INPUT") { var b = wrap.querySelector('[data-nick="save"]'); if (b && !b.disabled) b.click(); }
    });
    paint();
    document.body.appendChild(wrap);
    sheet = wrap;
    var first = wrap.querySelector("[data-nick-acct]");
    if (first) { try { first.focus(); } catch (err) { /* ignore */ } }
  }

  /* Delegated: any element with data-act="nick-edit" opens the sheet. */
  if (typeof document !== "undefined") {
    document.addEventListener("click", function (event) {
      var el = event.target && event.target.closest ? event.target.closest('[data-act="nick-edit"]') : null;
      if (!el || !enabled()) return;
      event.preventDefault();
      event.stopPropagation();
      if (deps.closeMenus) { try { deps.closeMenus(); } catch (err) { /* ignore */ } }
      openSheet({
        platform: el.getAttribute("data-platform") || "x",
        handle: el.getAttribute("data-handle") || "",
        original: el.getAttribute("data-original") || "",
        personId: el.getAttribute("data-person") || ""
      });
    }, true);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") sync(false); });
    if (root.addEventListener) root.addEventListener("online", function () { sync(true); });
  }

  root.ViktorychNicknames = {
    bind: function (next) { deps = next || {}; scope = ""; ensureScope(); setTimeout(function () { sync(false); }, 1500); },
    keyOf: keyOf,
    clean: clean,
    get: get,
    nameFor: nameFor,
    set: set,
    setKey: setKey,
    list: list,
    listAll: listAll,
    openAddSheet: openAddSheet,
    sync: sync,
    openSheet: openSheet,
    closeSheet: closeSheet,
    version: function () { return version; },
    max: NICK_MAX
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
