/* Community Notes, in X's pattern.

   Under a post: the "Readers added context" box when a note is shown, with
   a "From X Community Notes" label for notes mirrored from X, and "Do you
   find this helpful?" for contributors. In the "…" menu: Request Community
   Note and Write a Community Note. The #/communitynotes page holds signup,
   the "Needs your help" queue, your notes, and the owner's panel.

   Data is local-first and tiny: the Worker publishes 16 small index shards
   (post ref -> note hashes) and one immutable blob per note. A device only
   reads the shards of posts it shows, keeps them and the blobs it used, and
   fetches a blob from its own cache, then nearby peers (ViktorychPool),
   then the Worker. Ratings never come down; scoring runs on the server. */
(function (root) {
  "use strict";

  var SETTINGS_KEY = "viktorychapp-settings-v1";
  var STORE_KEY = "viktorych-cnotes-v1";
  var SHARDS = 16;
  var TEXT_MAX = 280;
  var BLOB_KEEP = 300;
  var FRESH_MS = 5 * 60000;
  var LITE_FRESH_MS = 30 * 60000;
  var PENDING_MS = 2 * 60000;
  /* The data-saving value of the "communityNotesData" setting. */
  var DATA_SAVING = "lite";

  var store = readStore();       // { s: {hex: {at, r}}, b: {hash: blob}, u: {hash: lastUse}, me }
  var hrefs = {};                // ref -> app hash for posts this device has shown
  var waitShards = {};
  var loading = {};
  var pend = {};                 // ref -> { at, notes, requests } for contributors
  var pendWait = {};
  var flushTimer = 0;
  var pendTimer = 0;
  var io = null;
  var meAt = 0;
  var meLoading = null;
  var page = { root: null, route: null, data: null, admin: null, busy: false, error: "" };
  var battery = null;

  function tr(key, vars) {
    var fn = root.t;
    var text = fn ? fn(key, vars) : key;
    if (!fn && vars) Object.keys(vars).forEach(function (name) { text = String(text).split("{" + name + "}").join(String(vars[name])); });
    return text;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function accounts() { return root.ViktorychAccounts || null; }
  function token() {
    try { var a = accounts(); return a && a.token ? a.token() : ""; } catch (err) { return ""; }
  }
  function call(path, opts) {
    var a = accounts();
    if (!a || !a.call || (a.hasApi && !a.hasApi())) return Promise.resolve({ status: 503 });
    opts = opts || {};
    var t = token();
    if (t && !opts.anon) opts.token = t;
    return a.call(path, opts).catch(function () { return { status: 0 }; });
  }
  function toast(message) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* ---------- storage ---------- */

  function readStore() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
      return { s: s.s || {}, b: s.b || {}, u: s.u || {}, me: s.me || null };
    } catch (err) { return { s: {}, b: {}, u: {}, me: null }; }
  }
  var saveTimer = 0;
  function notesAccount() {
    try {
      var doc = JSON.parse(localStorage.getItem("viktorychapp-account-v1") || "null");
      var id = doc && doc.account && (doc.account.publicId || doc.account.id);
      return id ? String(id) : "";
    } catch (err) { return ""; }
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    var scope = notesAccount();
    var hashes = Object.keys(store.b);
    if (hashes.length > BLOB_KEEP) {
      hashes.sort(function (a, b) { return (store.u[a] || 0) - (store.u[b] || 0); });
      hashes.slice(0, hashes.length - BLOB_KEEP).forEach(function (h) { delete store.b[h]; delete store.u[h]; });
    }
    var payload = "";
    try { payload = JSON.stringify(store); } catch (err) { return; }
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      if (notesAccount() !== scope) return;
      try { localStorage.setItem(STORE_KEY, payload); } catch (err) { /* full: keep in memory */ }
    }, 400);
  }
  if (root.addEventListener) root.addEventListener("viktorych-wipe", function () { store = { s: {}, b: {}, u: {}, me: null }; pend = {}; try { localStorage.removeItem(STORE_KEY); } catch (err) { /* ignore */ } });

  /* ---------- adaptive data use ---------- */

  function settings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; } catch (err) { return {}; }
  }
  function connection() { return (typeof navigator !== "undefined" && navigator.connection) || {}; }
  if (typeof navigator !== "undefined" && navigator.getBattery) {
    navigator.getBattery().then(function (b) { battery = b; }).catch(function () { /* none */ });
  }
  /* Data saving: notes only for posts on screen, refreshed less often,
     and no "needs your help" lookups outside a post's own page. */
  function lite() {
    var s = settings();
    var mode = s.communityNotesData || "auto";
    if (mode === DATA_SAVING) return true;
    if (mode === "full") return false;
    if (s.saveData === true || s.saveData === "on" || s.dataSaver === true) return true;
    var c = connection();
    if (c.saveData || c.effectiveType === "slow-2g" || c.effectiveType === "2g") return true;
    if (battery && !battery.charging && battery.level < 0.15) return true;
    return false;
  }
  function freshFor() { return lite() ? LITE_FRESH_MS : FRESH_MS; }

  /* ---------- refs and shards ---------- */

  function cleanRef(value) {
    var text = String(value || "");
    return /^[a-z]{1,12}:[A-Za-z0-9._:-]{1,100}$/.test(text) ? text : "";
  }
  /* FNV-1a, the same as the Worker and the X mirror. */
  function shardOf(ref) {
    var h = 2166136261;
    var s = String(ref);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i) & 0xff; h = Math.imul(h, 16777619) >>> 0; }
    return (h % SHARDS).toString(16);
  }
  function fallbackHref(ref) {
    var at = ref.indexOf(":");
    var platform = ref.slice(0, at);
    var id = ref.slice(at + 1);
    if (platform === "x") return "#/@i/status/" + encodeURIComponent(id);
    return "#/" + encodeURIComponent(platform) + "/i/status/" + encodeURIComponent(id);
  }
  function hrefOf(ref) { return hrefs[ref] || fallbackHref(ref); }

  function shardFresh(hex) {
    var s = store.s[hex];
    return !!(s && Date.now() - (s.at || 0) < freshFor());
  }
  function loadShard(hex) {
    if (loading[hex]) return loading[hex];
    loading[hex] = call("/v1/cnotes/shard/" + hex, { anon: true }).then(function (res) {
      delete loading[hex];
      if (res && res.status === 200 && res.r && typeof res.r === "object") {
        store.s[hex] = { at: Date.now(), r: res.r };
        saveSoon();
      } else if (res && res.status === 404) {
        store.s[hex] = { at: Date.now(), r: {} };
        saveSoon();
      } else if (store.s[hex]) {
        store.s[hex].at = Date.now() - freshFor() + 60000; // retry in a minute
      }
      return store.s[hex];
    });
    return loading[hex];
  }
  function entriesFor(ref) {
    var s = store.s[shardOf(ref)];
    var list = s && s.r && s.r[ref];
    return Array.isArray(list) ? list : [];
  }

  /* ---------- blobs: cache -> peers -> Worker ---------- */

  function blobText(n) {
    // The Worker's blobOf() key order, so the bytes hash the same.
    return JSON.stringify({ v: 1, id: n.id, src: n.src, ref: n.ref, cls: n.cls, reasons: n.reasons || [], text: n.text, sources: n.sources || [], media: !!n.media, created: Number(n.created) || 0, statusAt: Number(n.statusAt) || 0 });
  }
  function sha256Hex(bytes) {
    if (!(root.crypto && root.crypto.subtle)) return Promise.resolve("");
    return root.crypto.subtle.digest("SHA-256", bytes).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    }).catch(function () { return ""; });
  }
  function pool() {
    var p = root.ViktorychPool;
    return p && typeof p.getBlob === "function" ? p : null;
  }
  function fromPeers(hash, size, priority) {
    var p = pool();
    if (!p || (p.hasBlob && !p.hasBlob(hash))) return Promise.resolve(null);
    return Promise.resolve(p.getBlob(hash, size, { priority: priority })).then(function (bytes) {
      if (!bytes) return null;
      return sha256Hex(bytes).then(function (h) {
        if (h !== hash) return null;
        try { return JSON.parse(new TextDecoder().decode(bytes)); } catch (err) { return null; }
      });
    }).catch(function () { return null; });
  }
  function sharePeers(blob) {
    var p = pool();
    if (!p || typeof p.putBlob !== "function") return;
    try { p.putBlob(new TextEncoder().encode(blobText(blob))); } catch (err) { /* ignore */ }
  }
  var blobWait = {};
  function getBlob(hash, size, priority) {
    if (store.b[hash]) { store.u[hash] = Date.now(); return Promise.resolve(store.b[hash]); }
    if (blobWait[hash]) return blobWait[hash];
    blobWait[hash] = fromPeers(hash, size, priority).then(function (blob) {
      if (blob) return blob;
      return call("/v1/cnotes/n/" + hash, { anon: true }).then(function (res) {
        if (!res || res.status !== 200 || !res.id) return null;
        delete res.status;
        delete res.bodyStatus;
        sharePeers(res);
        return res;
      });
    }).then(function (blob) {
      delete blobWait[hash];
      if (blob) { store.b[hash] = blob; store.u[hash] = Date.now(); saveSoon(); }
      return blob;
    });
    return blobWait[hash];
  }

  /* ---------- contributor state ---------- */

  function me() { return store.me; }
  function isContributor() { var m = store.me; return !!(m && m.contributor && !m.contributor.banned && token()); }
  function isOwner() { return !!(store.me && store.me.owner && token()); }
  function loadMe(force) {
    if (!token()) { store.me = null; return Promise.resolve(null); }
    if (!force && store.me && Date.now() - meAt < 10 * 60000) return Promise.resolve(store.me);
    if (meLoading) return meLoading;
    meLoading = call("/v1/cnotes/me").then(function (res) {
      meLoading = null;
      if (res && res.status === 200) {
        store.me = { eligibility: res.eligibility || {}, contributor: res.contributor || null, owner: !!res.owner, thresholds: res.thresholds || {} };
        meAt = Date.now();
        saveSoon();
      }
      return store.me;
    });
    return meLoading;
  }

  /* ---------- post cards ---------- */

  function onStatusPage() { return /\/status\//.test(String(location.hash || "")); }

  function scan() {
    var list = document.querySelectorAll(".cn-slot[data-cn-ref]:not([data-cn-seen])");
    for (var i = 0; i < list.length; i++) {
      var slot = list[i];
      slot.setAttribute("data-cn-seen", "1");
      var ref = cleanRef(slot.getAttribute("data-cn-ref"));
      if (!ref) continue;
      var href = slot.getAttribute("data-cn-href");
      if (href && href.charAt(0) === "#") hrefs[ref] = href;
      if (shardFresh(shardOf(ref))) paint(slot);
      if (io) io.observe(slot);
      else queueRef(ref);
    }
  }
  function queueRef(ref) {
    var hex = shardOf(ref);
    if (!shardFresh(hex)) waitShards[hex] = true;
    if (isContributor() && (onStatusPage() || !lite())) pendWait[ref] = true;
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  }
  function flush() {
    flushTimer = 0;
    if (document.hidden) { flushTimer = setTimeout(flush, 2000); return; }
    var hexes = Object.keys(waitShards);
    waitShards = {};
    Promise.all(hexes.map(loadShard)).then(function () {
      hexes.forEach(function (hex) { paintShard(hex); });
    });
    if (!pendTimer && Object.keys(pendWait).length) pendTimer = setTimeout(flushPending, 300);
  }
  function flushPending() {
    pendTimer = 0;
    var now = Date.now();
    var refs = Object.keys(pendWait).filter(function (ref) { return !pend[ref] || now - pend[ref].at > PENDING_MS; }).slice(0, 40);
    pendWait = {};
    if (!refs.length || !isContributor()) return;
    call("/v1/cnotes/pending?refs=" + encodeURIComponent(refs.join(","))).then(function (res) {
      if (!res || res.status !== 200 || !res.r) return;
      refs.forEach(function (ref) { pend[ref] = Object.assign({ at: Date.now() }, res.r[ref] || { notes: [], requests: { n: 0, me: false } }); });
      if (res.contributor && store.me) store.me.contributor = res.contributor;
      refs.forEach(function (ref) { slotsFor(ref).forEach(paint); });
    });
  }
  function slotsFor(ref) {
    var out = [];
    var list = document.querySelectorAll(".cn-slot[data-cn-ref]");
    for (var i = 0; i < list.length; i++) if (list[i].getAttribute("data-cn-ref") === ref) out.push(list[i]);
    return out;
  }
  function paintShard(hex) {
    var list = document.querySelectorAll(".cn-slot[data-cn-ref]");
    for (var i = 0; i < list.length; i++) if (shardOf(list[i].getAttribute("data-cn-ref")) === hex) paint(list[i]);
  }

  function paint(slot) {
    var ref = cleanRef(slot.getAttribute("data-cn-ref"));
    if (!ref) return;
    var shown = entriesFor(ref).filter(function (e) { return e && e[3] === "crh"; });
    // Ours first, then X's; at most one of each, like X shows one note.
    shown.sort(function (a, b) { return (a[2] === "x") - (b[2] === "x"); });
    var picked = [];
    var seen = {};
    shown.forEach(function (e) { if (!seen[e[2]]) { seen[e[2]] = 1; picked.push(e); } });
    var p = pend[ref];
    var waiting = p && Array.isArray(p.notes) ? p.notes.filter(function (n) { return n.status === "nmr"; }) : [];
    if (!picked.length && !waiting.length) { if (slot.innerHTML) slot.innerHTML = ""; return; }
    var ready = picked.map(function (e) { return store.b[e[0]] || null; });
    var html = ready.filter(Boolean).map(function (n) { return boxHtml(n, p); }).join("") + (waiting.length ? helpHtml(ref, waiting.length) : "");
    if (slot.getAttribute("data-cn-html") !== html) { slot.innerHTML = html; slot.setAttribute("data-cn-html", html); }
    picked.forEach(function (e, i) {
      if (ready[i]) return;
      getBlob(e[0], e[1], "visible").then(function (blob) { if (blob) paint(slot); });
    });
  }

  function linkify(text) {
    var out = "";
    var last = 0;
    var re = /https?:\/\/[^\s<>"]+/gi;
    var m;
    var src = String(text || "");
    while ((m = re.exec(src))) {
      var url = m[0].replace(/[).,;!?]+$/, "");
      out += esc(src.slice(last, m.index));
      var shown = url.replace(/^https?:\/\/(www\.)?/, "");
      if (shown.length > 32) shown = shown.slice(0, 31) + "…";
      out += '<a class="cn-link" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer nofollow ugc" data-act="stop">' + esc(shown) + "</a>";
      last = m.index + url.length;
      re.lastIndex = last;
    }
    return (out + esc(src.slice(last))).replace(/\n/g, "<br>");
  }

  var PEOPLE = '<svg viewBox="0 0 24 24" aria-hidden="true" class="cn-ico"><path d="M8 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm8.5 1a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 13c-3.3 0-6 1.7-6 4v2h12v-2c0-2.3-2.7-4-6-4zm8.5 0c-.8 0-1.6.1-2.3.4 1.1.9 1.8 2.1 1.8 3.6v2h6v-2c0-2.2-2.5-4-5.5-4z" fill="currentColor"/></svg>';

  function boxHtml(n, p) {
    var fromX = n.src === "x";
    var mine = p && Array.isArray(p.notes) && p.notes.some(function (x) { return x.id === n.id && x.mine; });
    var rating = p && Array.isArray(p.notes) ? (p.notes.filter(function (x) { return x.id === n.id; })[0] || {}).rating : null;
    var rate = !fromX && isContributor() && !mine
      ? '<div class="cn-rate"><span>' + esc(rating ? tr("You rated this note") : tr("Do you find this helpful?")) + '</span><button type="button" class="cn-pill" data-cn-act="rate" data-cn-id="' + esc(n.id) + '" data-cn-ref="' + esc(n.ref) + '">' + esc(rating ? tr("Change rating") : tr("Rate it")) + "</button></div>"
      : "";
    var foot = fromX
      ? '<div class="cn-foot"><span class="cn-from">' + esc(tr("From X Community Notes")) + '</span> · <a href="https://x.com/i/birdwatch/n/' + encodeURIComponent(n.id) + '" target="_blank" rel="noopener noreferrer" data-act="stop">' + esc(tr("View on X")) + "</a></div>"
      : '<div class="cn-foot">' + esc(tr("Context is written by people who use Viktorych, and appears when rated helpful by others.")) + ' <a href="#/communitynotes" data-act="stop">' + esc(tr("Find out more")) + "</a></div>";
    return '<div class="cn-box" data-act="stop" data-cn-note="' + esc(n.id) + '">' +
      '<div class="cn-head">' + PEOPLE + "<span>" + esc(tr("Readers added context")) + "</span></div>" +
      '<div class="cn-text" dir="auto">' + linkify(n.text) + "</div>" +
      foot + rate + "</div>";
  }
  function helpHtml(ref, n) {
    return '<div class="cn-help" data-act="stop"><span>' + PEOPLE + esc(n === 1 ? tr("A Community Note needs your rating") : tr("{n} Community Notes need your rating", { n: n })) + '</span><button type="button" class="cn-pill" data-cn-act="review" data-cn-ref="' + esc(ref) + '">' + esc(tr("Rate it")) + "</button></div>";
  }

  function watch() {
    if (root.IntersectionObserver) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          io.unobserve(entry.target);
          queueRef(cleanRef(entry.target.getAttribute("data-cn-ref")));
        });
      }, { rootMargin: lite() ? "0px" : "800px 0px" });
    }
    var pending = false;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      Promise.resolve().then(function () { pending = false; scan(); });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan();
    if (token()) loadMe(false);
  }

  /* ---------- menu items (app.js puts them in the "…" menu) ---------- */

  function menuItems(ref) {
    ref = cleanRef(ref);
    if (!ref || !token()) return "";
    var out = '<button type="button" data-cn-act="request" data-cn-ref="' + esc(ref) + '">' + esc(tr("Request Community Note")) + "</button>";
    if (isContributor()) out += '<button type="button" data-cn-act="write" data-cn-ref="' + esc(ref) + '">' + esc(tr("Write a Community Note")) + "</button>";
    return out;
  }

  /* ---------- sheets ---------- */

  var sheet = null;
  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    document.removeEventListener("keydown", sheetKey, true);
  }
  function sheetKey(e) { if (e.key === "Escape") { e.preventDefault(); closeSheet(); } }
  function openSheet(title, body) {
    closeSheet();
    sheet = document.createElement("div");
    sheet.className = "cn-sheet-wrap";
    sheet.innerHTML = '<div class="cn-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="cn-sheet-head"><button type="button" class="cn-x" data-cn-act="close" aria-label="' + esc(tr("Close")) + '">×</button><h2>' + esc(title) + '</h2></div><div class="cn-sheet-body">' + body + "</div></div>";
    document.body.appendChild(sheet);
    sheet.addEventListener("click", function (e) { if (e.target === sheet) closeSheet(); });
    document.addEventListener("keydown", sheetKey, true);
    var first = sheet.querySelector("button:not(.cn-x), input, textarea");
    if (first) first.focus();
    return sheet;
  }

  function REASONS() { return {
    misleading: [
      ["factual_error", tr("It contains a factual error")],
      ["manipulated_media", tr("It contains a digitally altered photo or video")],
      ["outdated", tr("It contains outdated information that may be misleading")],
      ["missing_context", tr("It is a misrepresentation or missing important context")],
      ["unverified_claim", tr("It presents an unverified claim as a fact")],
      ["satire", tr("It is a joke or satire that might be misinterpreted as a fact")],
      ["other", tr("Other")]
    ],
    not_misleading: [
      ["factually_correct", tr("It expresses a factually correct claim")],
      ["outdated_but_not_when_written", tr("This post was correct when written, but is out of date now")],
      ["clearly_satire", tr("It is clearly satirical/joking")],
      ["personal_opinion", tr("It expresses a personal opinion")],
      ["other", tr("Other")]
    ]
  }; }
  function HELPFUL() { return [["good_sources", tr("Cites high-quality sources")], ["clear", tr("Easy to understand")], ["addresses_claim", tr("Directly addresses the post's claim")], ["important_context", tr("Provides important context")], ["unbiased_language", tr("Neutral or unbiased language")], ["other", tr("Other")]]; }
  function NOT_HELPFUL() { return [["sources_missing", tr("Sources not included or unreliable")], ["irrelevant_sources", tr("Sources do not support note")], ["incorrect", tr("Incorrect information")], ["opinion_speculation", tr("Opinion or speculation")], ["hard_to_understand", tr("Typos or unclear language")], ["missing_key_points", tr("Misses key points or irrelevant")], ["argumentative", tr("Argumentative or biased language")], ["note_not_needed", tr("Note not needed on this post")], ["spam_harassment", tr("Harassment or abuse")], ["other", tr("Other")]]; }
  function checks(name, list, picked) {
    return list.map(function (r) {
      return '<label class="cn-check"><input type="checkbox" name="' + esc(name) + '" value="' + esc(r[0]) + '"' + (picked && picked.indexOf(r[0]) >= 0 ? " checked" : "") + "><span>" + esc(r[1]) + "</span></label>";
    }).join("");
  }
  function noteLength(text) { return Array.from(String(text || "").replace(/https?:\/\/[^\s<>"]+/gi, "x")).length; }
  function hasSource(text) { return /https?:\/\/[^\s<>".]+\.[^\s<>"]+/i.test(String(text || "")); }

  function openWrite(ref, appPost) {
    if (!isContributor()) { location.hash = "#/communitynotes"; return; }
    var c = store.me.contributor;
    if (!c.canWrite && !isOwner()) {
      openSheet(tr("Write a Community Note"), '<p class="cn-p">' + esc(tr("You can write notes once your Rating Impact reaches {n}. Yours is {m}. Rate notes in Needs your help to earn it.", { n: c.needed, m: c.ratingImpact })) + '</p><a class="cn-btn" href="#/communitynotes" data-cn-act="close">' + esc(tr("Rate notes")) + "</a>");
      return;
    }
    var s = openSheet(tr("Write a Community Note"),
      '<form class="cn-form" novalidate>' +
      '<h3>' + esc(tr("Which of the following best applies to this post?")) + '</h3>' +
      '<label class="cn-radio"><input type="radio" name="cls" value="misleading" checked><span>' + esc(tr("Misinformed or potentially misleading")) + '</span></label>' +
      '<label class="cn-radio"><input type="radio" name="cls" value="not_misleading"><span>' + esc(tr("Not misleading")) + '</span></label>' +
      '<h3 class="cn-why">' + esc(tr("Why do you believe this post may be misleading?")) + '</h3>' +
      '<div class="cn-reasons">' + checks("reason", REASONS().misleading) + '</div>' +
      '<h3>' + esc(tr("Explain the evidence behind your choices")) + '</h3>' +
      '<p class="cn-sub">' + esc(tr("Help others understand why this post is or isn't misleading. Include a link to your sources.")) + '</p>' +
      '<textarea name="text" rows="5" dir="auto" placeholder="' + esc(tr("Write your note")) + '"></textarea>' +
      '<div class="cn-count"><span class="cn-warn" hidden>' + esc(tr("Please include a link to your sources")) + '</span><span class="cn-num">0 / ' + TEXT_MAX + '</span></div>' +
      '<p class="cn-sub">' + esc(tr("Your note is shown under your Community Notes alias, never your name.")) + '</p>' +
      '<button type="submit" class="cn-btn" disabled>' + esc(tr("Submit")) + "</button></form>");
    var form = s.querySelector("form");
    function sync() {
      var cls = form.querySelector('input[name="cls"]:checked').value;
      var box = form.querySelector(".cn-reasons");
      if (box.getAttribute("data-cls") !== cls) {
        box.setAttribute("data-cls", cls);
        box.innerHTML = checks("reason", REASONS()[cls]);
        form.querySelector(".cn-why").textContent = cls === "misleading" ? tr("Why do you believe this post may be misleading?") : tr("Why do you believe this post is not misleading?");
      }
      var text = form.text.value;
      var len = noteLength(text);
      var num = form.querySelector(".cn-num");
      num.textContent = len + " / " + TEXT_MAX;
      num.classList.toggle("over", len > TEXT_MAX);
      form.querySelector(".cn-warn").hidden = !text.trim() || hasSource(text);
      var reasons = form.querySelectorAll('input[name="reason"]:checked').length;
      form.querySelector('button[type="submit"]').disabled = !reasons || !text.trim() || len > TEXT_MAX || !hasSource(text);
    }
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    sync();
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      var body = {
        ref: ref,
        appPost: appPost || "",
        classification: form.querySelector('input[name="cls"]:checked').value,
        reasons: Array.from(form.querySelectorAll('input[name="reason"]:checked')).map(function (i) { return i.value; }),
        text: form.text.value.trim()
      };
      call("/v1/cnotes", { method: "POST", body: body }).then(function (res) {
        if (res && res.status === 201) {
          closeSheet();
          toast(tr("Your note was submitted. It will show once enough people rate it helpful."));
          delete pend[ref];
          pendWait[ref] = true;
          flushPending();
          return;
        }
        btn.disabled = false;
        toast(errorText(res && res.error));
      });
    });
  }

  function errorText(code) {
    if (code === "already_wrote") return tr("You already wrote a note on this post.");
    if (code === "no_notes_allowed") return tr("Notes are turned off for this post.");
    if (code === "source_required") return tr("Please include a link to your sources");
    if (code === "too_long") return tr("Your note is too long.");
    if (code === "writing_locked") return tr("Rate more notes to unlock writing.");
    if (code === "own_note") return tr("You can't rate your own note.");
    if (code === "banned") return tr("You can't take part in Community Notes.");
    if (code === "not_contributor") return tr("Join Community Notes first.");
    if (code === "temporary") return tr("Temporary accounts can't take part in Community Notes.");
    return tr("Could not save that.");
  }

  function findNote(id, ref) {
    var p = pend[ref];
    var n = p && Array.isArray(p.notes) ? p.notes.filter(function (x) { return x.id === id; })[0] : null;
    if (n) return n;
    var e = entriesFor(ref).filter(function (x) { return store.b[x[0]] && store.b[x[0]].id === id; })[0];
    if (e) return store.b[e[0]];
    var q = page.data && (page.data.help || []).concat(page.data.mine || []).filter(function (x) { return x.id === id; })[0];
    return q || null;
  }

  function openRate(id, ref) {
    if (!isContributor()) { location.hash = "#/communitynotes"; return; }
    var n = findNote(id, ref) || { id: id, text: "" };
    var prior = n.rating || null;
    var s = openSheet(tr("Rate it"),
      (n.text ? '<div class="cn-box cn-quote"><div class="cn-text" dir="auto">' + linkify(n.text) + "</div></div>" : "") +
      '<h3>' + esc(tr("Do you find this helpful?")) + '</h3>' +
      '<div class="cn-levels" role="radiogroup">' +
      ["helpful", "somewhat", "not"].map(function (lv) {
        var t = lv === "helpful" ? tr("Yes") : lv === "somewhat" ? tr("Somewhat") : tr("No");
        return '<button type="button" role="radio" class="cn-level' + (prior && prior.level === lv ? " on" : "") + '" data-lv="' + lv + '" aria-checked="' + (prior && prior.level === lv ? "true" : "false") + '">' + esc(t) + "</button>";
      }).join("") + "</div>" +
      '<div class="cn-tags"></div>' +
      '<div class="cn-row"><button type="button" class="cn-btn" data-cn-done disabled>' + esc(tr("Done")) + "</button>" +
      (prior ? '<button type="button" class="cn-ghost" data-cn-clear>' + esc(tr("Delete rating")) + "</button>" : "") + "</div>");
    var level = prior ? prior.level : "";
    var tags = prior ? prior.tags || [] : [];
    function drawTags() {
      var box = s.querySelector(".cn-tags");
      if (!level) { box.innerHTML = ""; return; }
      var good = level !== "not" ? '<h3>' + esc(tr("What was helpful about it?")) + '</h3>' + checks("tag", HELPFUL(), tags) : "";
      var bad = level !== "helpful" ? '<h3>' + esc(tr("What could be improved?")) + '</h3>' + checks("tag", NOT_HELPFUL(), tags) : "";
      box.innerHTML = level === "not" ? '<h3>' + esc(tr("Help us understand why")) + '</h3>' + checks("tag", NOT_HELPFUL(), tags) : good + bad;
      s.querySelector("[data-cn-done]").disabled = false;
    }
    drawTags();
    s.addEventListener("click", function (e) {
      var lv = e.target.closest && e.target.closest("[data-lv]");
      if (lv) {
        level = lv.getAttribute("data-lv");
        s.querySelectorAll("[data-lv]").forEach(function (b) { var on = b === lv; b.classList.toggle("on", on); b.setAttribute("aria-checked", on ? "true" : "false"); });
        tags = Array.from(s.querySelectorAll('input[name="tag"]:checked')).map(function (i) { return i.value; });
        drawTags();
        return;
      }
      var clear = e.target.closest && e.target.closest("[data-cn-clear]");
      var done = e.target.closest && e.target.closest("[data-cn-done]");
      if (!clear && !done) return;
      var body = clear ? { note: id, level: "" } : { note: id, level: level, tags: Array.from(s.querySelectorAll('input[name="tag"]:checked')).map(function (i) { return i.value; }) };
      call("/v1/cnotes/rate", { method: "POST", body: body }).then(function (res) {
        if (!res || res.status !== 200) { toast(errorText(res && res.error)); return; }
        closeSheet();
        toast(clear ? tr("Rating deleted") : tr("Thanks for rating"));
        var rating = clear ? null : { level: body.level, tags: body.tags };
        if (pend[ref]) (pend[ref].notes || []).forEach(function (x) { if (x.id === id) x.rating = rating; });
        if (page.data) (page.data.help || []).forEach(function (x) { if (x.id === id) x.rating = rating; });
        slotsFor(ref).forEach(paint);
        renderPage();
      });
    });
  }

  function openReview(ref) {
    var p = pend[ref];
    var list = p && Array.isArray(p.notes) ? p.notes : [];
    if (!list.length) return;
    var body = list.map(function (n) {
      var tag = n.status === "crh" ? tr("Currently rated helpful") : n.status === "crnh" ? tr("Currently not rated helpful") : tr("Needs more ratings");
      return '<div class="cn-box cn-quote"><div class="cn-state">' + esc(tag) + '</div><div class="cn-text" dir="auto">' + linkify(n.text) + '</div>' +
        (n.mine ? '<div class="cn-foot">' + esc(tr("Your note")) + "</div>" : '<div class="cn-rate"><span>' + esc(n.rating ? tr("You rated this note") : tr("Do you find this helpful?")) + '</span><button type="button" class="cn-pill" data-cn-act="rate" data-cn-id="' + esc(n.id) + '" data-cn-ref="' + esc(ref) + '">' + esc(n.rating ? tr("Change rating") : tr("Rate it")) + "</button></div>") + "</div>";
    }).join("");
    openSheet(tr("Community Notes"), body);
  }

  function requestNote(ref) {
    if (!token()) { var a = accounts(); if (a && a.openLogin) a.openLogin(); return; }
    call("/v1/cnotes/request", { method: "POST", body: { ref: ref } }).then(function (res) {
      if (res && res.status === 200) toast(tr("Request sent. Contributors will see it."));
      else toast(errorText(res && res.error));
    });
  }

  /* ---------- clicks ---------- */

  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-cn-act]") : null;
    if (!el) return;
    var act = el.getAttribute("data-cn-act");
    var ref = cleanRef(el.getAttribute("data-cn-ref"));
    if (act !== "close" || el.tagName !== "A") e.preventDefault();
    e.stopPropagation();
    if (act === "close") { closeSheet(); if (el.tagName === "A") location.hash = el.getAttribute("href"); return; }
    if (act === "request" || act === "write") {
      var menu = el.closest(".menu");
      if (menu) menu.remove();
      var slot = slotsFor(ref)[0];
      if (act === "request") requestNote(ref);
      else loadMe(false).then(function () { openWrite(ref, slot ? slot.getAttribute("data-cn-app") : ""); });
      return;
    }
    if (act === "rate") { openRate(el.getAttribute("data-cn-id"), ref || el.getAttribute("data-cn-ref")); return; }
    if (act === "review") { openReview(ref); return; }
    pageAct(act, el);
  }, true);

  /* ---------- #/communitynotes ---------- */

  function visible() { return true; }
  function pageHtml() { return '<div class="cn-page" data-bound="0"></div>'; }
  function mount(route) {
    page.route = route || {};
    var el = document.querySelector(".cn-page");
    if (!el) return;
    el.setAttribute("data-bound", "1");
    page.root = el;
    renderPage();
    // The app repaints often; only go to the network when this page was
    // opened again or its data is over a minute old.
    var tab = page.route.tab || "";
    var key = tab === "admin" ? "admin" : "queue";
    var same = page.lastHash === location.hash;
    page.lastHash = location.hash;
    if (same && page.loadedKey === key && Date.now() - (page.loadedAt || 0) < 60000) return;
    page.loadedKey = key;
    page.loadedAt = Date.now();
    loadMe(true).then(function () {
      renderPage();
      if (tab === "admin" && isOwner()) loadAdmin();
      else if (isContributor()) loadQueue();
    });
  }
  function unmount() { page.root = null; page.lastHash = ""; }

  function loadQueue() {
    call("/v1/cnotes/queue").then(function (res) {
      if (res && res.status === 200) { page.data = res; if (res.contributor && store.me) store.me.contributor = res.contributor; }
      renderPage();
    });
  }
  function loadAdmin() {
    var status = page.adminStatus || "nmr";
    var path = status === "x" ? "/v1/cnotes/admin?src=x" : status === "audit" ? "/v1/cnotes/admin/audit" : "/v1/cnotes/admin?status=" + encodeURIComponent(status);
    page.busy = true;
    renderPage();
    call(path).then(function (res) {
      page.busy = false;
      page.admin = res && res.status === 200 ? res : { items: [], error: true };
      renderPage();
    });
  }

  function statusLabel(s) {
    if (s === "crh") return tr("Currently rated helpful");
    if (s === "crnh") return tr("Currently not rated helpful");
    if (s === "hidden") return tr("Hidden by owner");
    if (s === "deleted") return tr("Deleted");
    return tr("Needs more ratings");
  }
  function when(ms) {
    if (!ms) return "";
    try { return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (err) { return ""; }
  }
  function noteCard(n, opts) {
    opts = opts || {};
    var rate = opts.rate ? '<div class="cn-rate"><span>' + esc(n.rating ? tr("You rated this note") : tr("Do you find this helpful?")) + '</span><button type="button" class="cn-pill" data-cn-act="rate" data-cn-id="' + esc(n.id) + '" data-cn-ref="' + esc(n.ref) + '">' + esc(n.rating ? tr("Change rating") : tr("Rate it")) + "</button></div>" : "";
    return '<article class="cn-item"><div class="cn-meta"><span class="cn-state s-' + esc(n.status || "nmr") + '">' + esc(statusLabel(n.status)) + '</span><span>' + esc(when(n.created)) + '</span><a href="' + esc(hrefOf(n.ref)) + '">' + esc(tr("View post")) + '</a></div><div class="cn-box"><div class="cn-text" dir="auto">' + linkify(n.text) + "</div>" + rate + "</div>" + (opts.extra || "") + "</article>";
  }

  function renderPage() {
    var el = page.root;
    if (!el || !el.isConnected) return;
    var tab = (page.route && page.route.tab) || "";
    var m = store.me;
    var html = "";
    if (!token()) {
      html = intro() + '<div class="cn-card"><button type="button" class="cn-btn" data-cn-act="login">' + esc(tr("Log in to join")) + "</button></div>";
    } else if (tab === "admin") {
      html = isOwner() ? adminHtml() : '<p class="cn-p">' + esc(tr("Only the owner can open this.")) + "</p>";
    } else if (!m) {
      html = '<p class="cn-p">' + esc(tr("Loading…")) + "</p>";
    } else if (!m.contributor) {
      html = intro() + joinHtml(m);
    } else {
      html = contributorHtml(m);
    }
    if (el.getAttribute("data-html") !== html) { el.innerHTML = html; el.setAttribute("data-html", html); }
  }
  function intro() {
    return '<div class="cn-card cn-hero">' + PEOPLE + '<h2>' + esc(tr("Community Notes")) + '</h2><p class="cn-p">' + esc(tr("Community Notes add helpful context to posts that might be misleading. Contributors write and rate notes, and a note is shown only when people who usually disagree both find it helpful.")) + "</p></div>";
  }
  function reasonText(r, e) {
    if (r === "too_new") return tr("Your account needs to be at least {n} days old.", { n: e.minAgeDays || 30 });
    if (r === "temporary") return tr("Temporary accounts can't join.");
    if (r === "recent_violation") return tr("No recent rule violations.");
    if (r === "banned") return tr("You can't take part in Community Notes.");
    return tr("Log in to join");
  }
  function joinHtml(m) {
    var e = m.eligibility || {};
    var reasons = e.reasons || [];
    var list = '<ul class="cn-list">' +
      '<li class="' + (reasons.indexOf("too_new") < 0 ? "ok" : "no") + '">' + esc(tr("Your account needs to be at least {n} days old.", { n: e.minAgeDays || 30 })) + "</li>" +
      '<li class="' + (reasons.indexOf("recent_violation") < 0 ? "ok" : "no") + '">' + esc(tr("No recent rule violations.")) + "</li>" +
      '<li class="' + (reasons.indexOf("temporary") < 0 ? "ok" : "no") + '">' + esc(tr("Not a temporary account.")) + "</li></ul>";
    return '<div class="cn-card"><h3>' + esc(tr("Join Community Notes")) + "</h3>" + list +
      '<p class="cn-sub">' + esc(tr("You get a random alias. New contributors start by rating notes; writing unlocks once your ratings help.")) + "</p>" +
      (e.eligible ? '<button type="button" class="cn-btn" data-cn-act="join">' + esc(tr("Join Community Notes")) + "</button>" : '<p class="cn-p">' + esc(reasons.map(function (r) { return reasonText(r, e); }).join(" ")) + "</p>") + "</div>";
  }
  function contributorHtml(m) {
    var c = m.contributor;
    var d = page.data || {};
    var tab = (page.route && page.route.tab) || "help";
    var head = '<div class="cn-card cn-me"><div><span class="cn-sub">' + esc(tr("Your alias")) + '</span><b>' + esc(c.alias) + '</b></div><div><span class="cn-sub">' + esc(tr("Rating Impact")) + '</span><b>' + esc(c.ratingImpact) + '</b></div><div><span class="cn-sub">' + esc(tr("Writing")) + '</span><b>' + esc(c.canWrite || m.owner ? tr("Unlocked") : tr("Unlocks at {n}", { n: c.needed })) + "</b></div></div>";
    var tabs = '<nav class="cn-tabs" role="tablist">' +
      '<a role="tab" class="' + (tab !== "mine" ? "on" : "") + '" href="#/communitynotes">' + esc(tr("Needs your help")) + "</a>" +
      '<a role="tab" class="' + (tab === "mine" ? "on" : "") + '" href="#/communitynotes/mine">' + esc(tr("Your notes")) + "</a>" +
      (m.owner ? '<a role="tab" href="#/communitynotes/admin">' + esc(tr("Owner panel")) + "</a>" : "") + "</nav>";
    var list;
    if (!page.data) list = '<p class="cn-p">' + esc(tr("Loading…")) + "</p>";
    else if (tab === "mine") list = (d.mine || []).length ? d.mine.map(function (n) { return noteCard(n); }).join("") : '<p class="cn-p">' + esc(tr("You haven't written any notes yet. Open a post's … menu and choose Write a Community Note.")) + "</p>";
    else list = (d.help || []).length ? d.help.map(function (n) { return noteCard(n, { rate: true }); }).join("") : '<p class="cn-p">' + esc(tr("No notes need your rating right now.")) + "</p>";
    return head + tabs + list + '<div class="cn-card"><button type="button" class="cn-ghost" data-cn-act="leave">' + esc(tr("Leave Community Notes")) + "</button></div>";
  }

  function ADMIN_TABS() { return [["nmr", tr("Needs more ratings")], ["crh", tr("Shown")], ["crnh", tr("Not helpful")], ["hidden", tr("Hidden")], ["overridden", tr("Overridden")], ["deleted", tr("Deleted")], ["x", tr("From X")], ["audit", tr("Audit log")]]; }
  function adminTabLabel(t) {
    if (t === "nmr") return tr("Needs more ratings");
    if (t === "crh") return tr("Shown");
    if (t === "crnh") return tr("Not helpful");
    if (t === "hidden") return tr("Hidden");
    if (t === "overridden") return tr("Overridden");
    if (t === "deleted") return tr("Deleted");
    if (t === "x") return tr("From X");
    return tr("Audit log");
  }
  function adminBtn(action, label, n, extra) {
    return '<button type="button" class="cn-ghost" data-cn-act="admin" data-a="' + esc(action) + '"' + (n ? ' data-id="' + esc(n) + '"' : "") + (extra || "") + ">" + esc(label) + "</button>";
  }
  function adminHtml() {
    var cur = page.adminStatus || "nmr";
    var a = page.admin || {};
    var tabs = '<nav class="cn-tabs cn-scroll" role="tablist">' + ADMIN_TABS().map(function (t) {
      var count = a.counts && a.counts[t[0]] != null ? " " + a.counts[t[0]] : "";
      return '<button type="button" role="tab" class="' + (cur === t[0] ? "on" : "") + '" data-cn-act="admin-tab" data-t="' + t[0] + '">' + esc(adminTabLabel(t[0]) + count) + "</button>";
    }).join("") + "</nav>";
    var top = '<div class="cn-card cn-row"><p class="cn-sub">' + esc(tr("Your decisions always win over ratings. Changes go live right away and are kept in the audit log.")) + "</p>" + adminBtn("rescore", tr("Rescore now")) + "</div>";
    var body;
    if (page.busy && !page.admin) body = '<p class="cn-p">' + esc(tr("Loading…")) + "</p>";
    else if (cur === "audit") body = (a.items || []).map(function (r) { return '<div class="cn-audit"><b>' + esc(r.action) + "</b> <code>" + esc(r.target) + "</code> <span>" + esc(new Date(r.at).toLocaleString()) + "</span></div>"; }).join("") || '<p class="cn-p">' + esc(tr("Nothing yet.")) + "</p>";
    else if (cur === "x") body = (a.items || []).map(function (n) {
      var extra = '<div class="cn-row">' + (n.override === "hide" ? adminBtn("xclear", tr("Show again"), "", ' data-x="' + esc(n.id) + '"') : adminBtn("xhide", tr("Force hide"), "", ' data-x="' + esc(n.id) + '"')) + "</div>";
      return noteCard({ id: n.id, ref: n.ref, text: n.text, created: n.created, status: n.override === "hide" ? "hidden" : "crh" }, { extra: extra });
    }).join("") || '<p class="cn-p">' + esc(tr("Nothing yet.")) + "</p>";
    else body = (a.items || []).map(function (n) {
      var stats = '<div class="cn-sub">' + esc(tr("Alias")) + ": " + esc(n.alias || "?") + (n.authorBanned ? " · " + esc(tr("Banned")) : "") + " · " + esc(tr("Ratings")) + ": " + esc(n.ratings || 0) + " · " + esc(tr("Score")) + ": " + esc(Number(n.intercept || 0).toFixed(2)) + " / " + esc(Number(n.factor || 0).toFixed(2)) + " · " + esc(tr("Algorithm")) + ": " + esc(statusLabel(n.algoStatus)) + (n.override ? " · " + esc(n.override === "show" ? tr("Forced shown") : tr("Forced hidden")) : "") + (n.locked ? " · " + esc(tr("Locked")) : "") + (n.edited ? " · " + esc(tr("Edited")) : "") + "</div>";
      var row = '<div class="cn-row cn-wrap">' +
        (n.override === "show" ? adminBtn("clear", tr("Clear override"), n.id) : adminBtn("show", tr("Force show"), n.id)) +
        (n.override === "hide" ? adminBtn("clear", tr("Clear override"), n.id) : adminBtn("hide", tr("Force hide"), n.id)) +
        (n.locked ? adminBtn("unlock", tr("Unlock"), n.id) : adminBtn("lock", tr("Lock"), n.id)) +
        adminBtn("edit", tr("Edit"), n.id) +
        (n.deleted ? adminBtn("restore", tr("Restore"), n.id) : adminBtn("delete", tr("Delete"), n.id)) +
        (n.authorBanned ? adminBtn("unban", tr("Unban writer"), n.id) : adminBtn("ban", tr("Ban writer from notes"), n.id)) +
        adminBtn("nonotes", tr("No notes on this post"), "", ' data-ref="' + esc(n.ref) + '"') + "</div>";
      return noteCard(n, { extra: stats + row });
    }).join("") || '<p class="cn-p">' + esc(tr("Nothing yet.")) + "</p>";
    var side = "";
    if (cur !== "audit" && cur !== "x" && ((a.requested || []).length || (a.blocked || []).length)) {
      side = '<div class="cn-card"><h3>' + esc(tr("Most requested")) + "</h3>" + (a.requested || []).map(function (r) { return '<div class="cn-audit"><a href="' + esc(hrefOf(r.post_ref)) + '">' + esc(r.post_ref) + "</a> · " + esc(r.n) + "</div>"; }).join("") +
        '<h3>' + esc(tr("Posts with notes turned off")) + "</h3>" + (a.blocked || []).map(function (ref) { return '<div class="cn-audit"><a href="' + esc(hrefOf(ref)) + '">' + esc(ref) + "</a> " + adminBtn("allownotes", tr("Allow notes"), "", ' data-ref="' + esc(ref) + '"') + "</div>"; }).join("") + "</div>";
    }
    return '<div class="cn-card"><h2>' + esc(tr("Owner panel")) + "</h2></div>" + top + tabs + body + side;
  }

  function pageAct(act, el) {
    if (act === "login") { var a = accounts(); if (a && a.openLogin) a.openLogin(); return; }
    if (act === "join" || act === "leave") {
      call("/v1/cnotes/" + act, { method: "POST" }).then(function (res) {
        if (res && res.status === 200) { toast(act === "join" ? tr("Welcome to Community Notes") : tr("You left Community Notes")); loadMe(true).then(function () { renderPage(); if (act === "join") loadQueue(); }); }
        else toast(errorText(res && res.error));
      });
      return;
    }
    if (act === "admin-tab") { page.adminStatus = el.getAttribute("data-t"); page.admin = null; loadAdmin(); return; }
    if (act !== "admin") return;
    var action = el.getAttribute("data-a");
    if (action === "rescore") {
      call("/v1/cnotes/admin/rescore", { method: "POST" }).then(function (res) { toast(res && res.status === 200 ? tr("Rescored") : tr("Could not save that.")); loadAdmin(); });
      return;
    }
    var body = { action: action };
    if (el.getAttribute("data-id")) body.note = el.getAttribute("data-id");
    if (el.getAttribute("data-ref")) body.ref = el.getAttribute("data-ref");
    if (el.getAttribute("data-x")) body.xnote = el.getAttribute("data-x");
    if (action === "edit") {
      var item = (page.admin && page.admin.items || []).filter(function (n) { return n.id === body.note; })[0];
      var text = root.prompt ? root.prompt(tr("Edit note"), item ? item.text : "") : null;
      if (text == null) return;
      body.text = text;
    }
    if ((action === "delete" || action === "ban" || action === "nonotes") && root.confirm && !root.confirm(tr("Are you sure?"))) return;
    call("/v1/cnotes/admin", { method: "POST", body: body }).then(function (res) {
      if (!res || res.status !== 200) { toast(errorText(res && res.error)); return; }
      toast(tr("Saved"));
      Object.keys(store.s).forEach(function (hex) { store.s[hex].at = 0; });
      loadAdmin();
    });
  }

  /* The Data usage row. app.js draws it and saves the choice. */
  function settingsHtml(mode) {
    var current = mode || "auto";
    var opt = function (id, text) { return '<button class="outline' + (current === id ? " on" : "") + '" type="button" data-act="cnotes-data" data-mode="' + id + '">' + esc(text) + "</button>"; };
    return "<h2>" + esc(tr("Community Notes")) + '</h2><p class="phandle">' + esc(tr("Auto saves data on slow networks, Data Saver and low battery. Data saving loads notes only for posts on screen.")) + '</p><div class="theme-row" role="group" aria-label="' + esc(tr("Community Notes")) + '">' +
      opt("auto", tr("Auto")) + opt("full", tr("Full")) + opt("lite", tr("Data saving")) + "</div>";
  }

  root.ViktorychCommunityNotes = {
    settingsHtml: settingsHtml,
    menuItems: menuItems,
    visible: visible,
    page: pageHtml,
    mount: mount,
    unmount: unmount,
    shardOf: shardOf,
    noteLength: noteLength,
    lite: lite,
    DATA_SAVING: DATA_SAVING
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watch);
  else watch();
})(typeof window !== "undefined" ? window : this);
