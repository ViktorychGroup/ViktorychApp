/* Linked profiles (Settings > Your account > Linked accounts, and the
   "Linked profiles" button in a profile header).

   Each external profile linked to an account (X, Instagram, YouTube…) has
   its own audience (Everyone, Followers, Friends, Only me, specific people)
   that the Worker enforces, and a page choice:
   - Merge into my profile (default): its posts join the internal profile's
     timeline and its own page, author links, mentions, search results and
     follows lead to the internal profile.
   - Keep separate page: still linked and listed, but it keeps its own page.
   Switching or unlinking never deletes posts.

   The redirect map comes from GET /v1/identities/merged, already filtered
   for this viewer, and is cached in localStorage for the first paint. */
(function (root) {
  "use strict";

  var KEY = "viktorychapp-linked-map";
  var STALE_MS = 5 * 60 * 1000;
  var PLATFORMS = { x: "X", instagram: "Instagram", youtube: "YouTube", threads: "Threads", telegram: "Telegram", vk: "VK" };
  var host = { render: function () {}, icon: null };
  var map = read();
  var index = build(map.list);
  var loading = false;
  var filters = {};
  var sheet = null;

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
  function low(s) { return String(s || "").replace(/^@/, "").trim().toLowerCase(); }
  function plat(p) { p = low(p) || "x"; return p === "twitter" ? "x" : p; }
  function platformName(p) { return PLATFORMS[plat(p)] || plat(p); }
  function enabled() {
    try {
      var list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
      return !(Array.isArray(list) && list.indexOf("merged_profiles") >= 0);
    } catch (err) { return true; }
  }

  /* ---------- the redirect map ---------- */
  function read() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || "null");
      if (raw && Array.isArray(raw.list)) return { at: Number(raw.at) || 0, who: String(raw.who || ""), list: raw.list };
    } catch (err) { /* fall through */ }
    return { at: 0, who: "", list: [] };
  }
  function viewerKey() { var m = me(); return m ? String(m.publicId || m.handle || "") : ""; }
  function build(list) {
    var out = {};
    (list || []).forEach(function (row) {
      if (!row || !row.platform || !row.handle || !row.to) return;
      out[plat(row.platform) + ":" + low(row.handle)] = row;
    });
    return out;
  }
  var again = false;
  function keep(list) {
    map = { at: Date.now(), who: viewerKey(), list: list.slice(0, 500) };
    index = build(map.list);
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (err) { /* private mode */ }
  }
  /* Your own change shows at once; the server's answer follows. */
  function noteOwn(item) {
    var m = me();
    if (!item || !m) return;
    var key = plat(item.platform) + ":" + low(item.handle);
    var list = map.list.filter(function (row) { return plat(row.platform) + ":" + low(row.handle) !== key; });
    if (item.merged !== false && item.hidden !== true && item.verified !== false) list.push({ platform: plat(item.platform), handle: item.handle, to: m.handle, name: m.displayName || m.handle, avatar: m.avatar || "" });
    keep(list);
  }
  function refresh(force) {
    var a = accounts();
    var t = token();
    if (loading && force) { again = true; return; }
    if (!a || !a.call || !t || !enabled() || loading) return;
    if (!force && map.who === viewerKey() && Date.now() - map.at < STALE_MS) return;
    loading = true;
    a.call("/v1/identities/merged", { token: t }).then(function (res) {
      loading = false;
      return res && res.status === 200 ? res : null;
    }).then(function (body) {
      if (again) { again = false; refresh(true); return; }
      if (!body || !Array.isArray(body.merged)) return;
      var before = JSON.stringify(map.list);
      keep(body.merged);
      if (JSON.stringify(map.list) !== before) host.render();
    }).catch(function () { loading = false; if (again) { again = false; refresh(true); } });
  }
  /* The internal profile an external one is merged into, for this viewer. */
  function target(platform, handle) {
    if (!enabled() || !handle) return null;
    if (map.who && map.who !== viewerKey()) return null;
    if (!map.at || Date.now() - map.at > STALE_MS) refresh(false);
    var raw = String(handle);
    var p = plat(platform);
    if (raw.indexOf(":") > 0 && !platform) { p = plat(raw.split(":")[0]); raw = raw.split(":").slice(1).join(":"); }
    return index[p + ":" + low(raw)] || null;
  }
  function hashFor(platform, handle) {
    var hit = target(platform, handle);
    return hit ? "#/@" + encodeURIComponent(hit.to) : "";
  }
  /* A follow of a merged source becomes a follow of the internal profile:
     its app:<id> when this device knows it, else app:@handle. */
  function followIds(id) {
    var s = String(id || "");
    if (!s || s.indexOf("app:") === 0) return [];
    var cut = s.indexOf(":");
    if (cut <= 0) return [];
    var hit = target(s.slice(0, cut), s.slice(cut + 1));
    if (!hit) return [];
    var a = accounts();
    var known = a && a.storedAccount ? a.storedAccount(hit.to) : null;
    var out = [];
    if (known && /^\d{12}$/.test(String(known.publicId || ""))) out.push("app:" + known.publicId);
    out.push("app:@" + hit.to);
    return out;
  }
  function followId(id) {
    var ids = followIds(id);
    return ids.length ? ids[0] : String(id || "");
  }
  function isMergedFeed(feed) {
    if (!feed) return false;
    return !!(target(feed.platform, feed.handle) || (feed.channelId && target(feed.platform, feed.channelId)));
  }
  function dropMerged(list) {
    if (!enabled() || !map.list.length) return list;
    return (list || []).filter(function (f) { return !isMergedFeed(f); });
  }

  /* ---------- profile timeline ---------- */
  function linksOf(account) { return (account && Array.isArray(account.identities)) ? account.identities : []; }
  function mergedLinks(account) {
    if (!enabled()) return [];
    return linksOf(account).filter(function (it) { return it && it.handle && it.merged !== false && it.verified !== false && it.hidden !== true; });
  }
  /* An external post drawn as the internal profile's own: same card, the
     internal name and avatar, a small platform icon by the time. */
  function asOwn(post, account) {
    var copy = Object.assign({}, post);
    copy.asAccount = { handle: account.handle, name: account.displayName || account.handle, avatar: account.avatar || "" };
    return copy;
  }
  function filterOf(account) { return filters[low(account && account.handle)] || "all"; }
  function filterPost(post, account) {
    var f = filterOf(account);
    if (f === "all") return true;
    var p = plat(post.platform || "app");
    if (f === "app") return p === "app";
    return p === f;
  }
  function filterHtml(account, list) {
    var seen = {};
    (list || []).forEach(function (post) { var p = plat(post && post.platform || "app"); if (p !== "app" && PLATFORMS[p]) seen[p] = 1; });
    var names = Object.keys(seen);
    if (!names.length) return "";
    var current = filterOf(account);
    var pill = function (id, label) {
      return '<button type="button" class="lp-pill' + (current === id ? " on" : "") + '" data-lp="filter" data-handle="' + esc(account.handle) + '" data-src="' + esc(id) + '" aria-pressed="' + (current === id ? "true" : "false") + '">' + esc(label) + "</button>";
    };
    return '<div class="lp-pills" role="toolbar" aria-label="' + esc(tr("Show posts from")) + '">' + pill("all", tr("All")) + pill("app", tr("Posts")) + names.map(function (p) { return pill(p, platformName(p)); }).join("") + "</div>";
  }

  /* ---------- words ---------- */
  function whoSees(item, mine) {
    var a = item.audience || "public";
    if (item.hidden) return tr("Hidden from your profile");
    if (a === "followers") return mine ? tr("Your followers can see this") : tr("Followers can see this");
    if (a === "friends") return mine ? tr("Your friends can see this") : tr("Friends can see this");
    if (a === "only") return tr("Only you can see this");
    if (a === "people") {
      var n = (item.people || []).length;
      return n === 1 ? tr("1 person you chose can see this") : tr("{n} people you chose can see this", { n: n });
    }
    if (a === "list") return tr("People on your list can see this");
    return tr("Everyone can see this");
  }
  function pageWords(item, mine) {
    if (item.merged === false) return mine ? tr("Keeps its own page") : tr("Has its own page");
    return mine ? tr("Merged into your profile") : tr("Merged into this profile");
  }
  function platformIcon(p) {
    var ic = host.icon ? host.icon(plat(p)) : "";
    return '<span class="lp-ico" aria-hidden="true">' + (ic || esc(platformName(p).charAt(0))) + "</span>";
  }
  function isMine(account) {
    var m = me();
    if (!m || !account) return false;
    return (m.publicId && account.publicId && m.publicId === account.publicId) || low(m.handle) === low(account.handle);
  }
  function ownLinks() { var m = me(); return m && Array.isArray(m.identities) ? m.identities : []; }
  function findOwn(id) { return ownLinks().filter(function (it) { return String(it.id) === String(id); })[0] || null; }

  /* ---------- profile header button ---------- */
  function headerHtml(account) {
    if (!enabled() || !account) return "";
    var mine = isMine(account);
    var list = mine ? ownLinks() : linksOf(account);
    if (!list.length && !mine) return "";
    var icons = list.slice(0, 4).map(function (it) { return platformIcon(it.platform); }).join("");
    var label = list.length ? tr("Linked profiles") + " · " + list.length : tr("Link a profile");
    return '<button type="button" class="lp-head" data-lp="open" data-handle="' + esc(account.handle) + '">' + icons + "<span>" + esc(label) + "</span></button>";
  }
  function rowHtml(item, mine, account) {
    var name = "@" + esc(item.handle) + ' <span class="lp-plat">' + esc(platformName(item.platform)) + "</span>";
    var sub = mine ? whoSees(item, true) + " · " + pageWords(item, true) : pageWords(item, false);
    if (!mine && item.ownerView) sub += " · " + tr("Private, shown to you as the site owner");
    var attrs;
    if (mine) attrs = 'data-lp="edit" data-id="' + esc(String(item.id)) + '"';
    else if (item.merged === false) attrs = 'data-lp="go" data-href="#/u/' + esc(encodeURIComponent(plat(item.platform)) + "/" + encodeURIComponent(item.handle)) + '"';
    else attrs = 'data-lp="filter" data-handle="' + esc(account.handle) + '" data-src="' + esc(plat(item.platform)) + '"';
    return '<button type="button" class="tab-choice lp-row" ' + attrs + ">" + platformIcon(item.platform) + '<span class="lp-copy"><b>' + name + '</b><span class="lp-sub">' + esc(sub) + "</span></span></button>";
  }
  function listSheet(handle) {
    var a = accounts();
    var account = (a && a.storedAccount && a.storedAccount(handle)) || null;
    var m = me();
    if (!account && m && low(m.handle) === low(handle)) account = m;
    if (!account) return;
    var mine = isMine(account);
    var list = mine ? ownLinks() : linksOf(account);
    var body = list.length ? list.map(function (it) { return rowHtml(it, mine, account); }).join("") : '<p class="lp-note">' + esc(tr("No linked accounts yet.")) + "</p>";
    var foot = mine ? '<div class="lp-foot"><button type="button" class="lp-accent" data-lp="link">' + esc(tr("Link an account")) + '</button><a class="lp-manage" href="#/settings/linked" data-lp="close">' + esc(tr("Manage")) + "</a></div>" : "";
    openSheet(tr("Linked profiles"), body + foot);
  }

  /* ---------- the edit sheet ---------- */
  var edit = { id: "", people: false, confirm: false, busy: false, error: "" };
  function audiences() { return [["public", tr("Everyone")], ["followers", tr("Followers")], ["friends", tr("Friends")], ["only", tr("Only me")], ["people", tr("Specific people")]]; }
  function check(on) { return '<span class="lp-check' + (on ? " on" : "") + '" aria-hidden="true"></span>'; }
  function choice(attrs, title, sub, on) {
    return '<button type="button" class="tab-choice lp-opt" role="menuitemradio" aria-checked="' + (on ? "true" : "false") + '" ' + attrs + '><span class="lp-copy"><b>' + esc(title) + "</b>" + (sub ? '<span class="lp-sub">' + esc(sub) + "</span>" : "") + "</span>" + check(on) + "</button>";
  }
  function editSheet(id) {
    var item = findOwn(id);
    if (!item) { closeSheet(); return; }
    edit.id = String(id);
    var aud = item.audience || "public";
    var html = "";
    if (edit.people) {
      html += '<div class="lp-people"><label for="lp-people-in">' + esc(tr("Who can see this")) + '</label><input id="lp-people-in" type="text" autocomplete="off" spellcheck="false" placeholder="' + esc(tr("Usernames, separated by commas")) + '" value="' + esc((item.audience === "people" ? item.people || [] : []).map(function (h) { return "@" + h; }).join(", ")) + '"><p class="lp-sub">' + esc(tr("Up to 50 people. Only they and you will see this link.")) + '</p><div class="lp-foot"><button type="button" class="lp-line" data-lp="people-cancel">' + esc(tr("Cancel")) + '</button><button type="button" class="lp-accent" data-lp="people-save">' + esc(tr("Save")) + "</button></div></div>";
    } else {
      html += '<h3 class="lp-h">' + esc(tr("Who can see this")) + "</h3>";
      audiences().forEach(function (pair) {
        var sub = pair[0] === "people" && aud === "people" ? whoSees(item, true) : "";
        html += choice('data-lp="aud" data-aud="' + pair[0] + '"', pair[1], sub, aud === pair[0]);
      });
      if (aud === "list") html += choice('data-lp="noop"', tr("Custom list"), "", true);
      html += '<h3 class="lp-h">' + esc(tr("Page")) + "</h3>";
      html += choice('data-lp="merge" data-on="1"', tr("Merge into my profile"), tr("Its posts appear on your profile like your own, and its page opens your profile."), item.merged !== false);
      html += choice('data-lp="merge" data-on="0"', tr("Keep separate page"), tr("It stays linked and listed, with its own page and posts."), item.merged === false);
      html += '<h3 class="lp-h"></h3>';
      html += choice('data-lp="hide"', tr("Show on profile"), "", item.hidden !== true);
      html += '<button type="button" class="tab-choice lp-danger" data-lp="unlink">' + esc(edit.confirm ? tr("Tap again to unlink. Posts stay where they are.") : tr("Unlink")) + "</button>";
    }
    if (edit.error) html += '<p class="lp-error" role="alert">' + esc(edit.error) + "</p>";
    openSheet("@" + item.handle + " · " + platformName(item.platform), html);
    if (edit.people) { var input = root.document.getElementById("lp-people-in"); if (input) input.focus(); }
  }
  function store(list) {
    var a = accounts();
    if (a && a.setIdentities) a.setIdentities(list);
  }
  function patch(body) {
    var a = accounts();
    var item = findOwn(edit.id);
    if (!a || !item || edit.busy) return;
    edit.busy = true;
    edit.error = "";
    a.call("/v1/account/identities/" + encodeURIComponent(edit.id), { method: "PATCH", token: token(), body: body }).then(function (res) {
      return res && res.status === 200 ? res : Promise.reject(new Error("save"));
    }).then(function (data) {
      edit.busy = false;
      var next = data && data.identity;
      if (next) store(ownLinks().map(function (it) { return String(it.id) === String(next.id) ? Object.assign({}, it, next) : it; }));
      if (next) noteOwn(Object.assign({}, item, next));
      refresh(true);
      edit.people = false;
      editSheet(edit.id);
      host.render();
    }).catch(function () {
      edit.busy = false;
      edit.error = tr("Couldn’t save. Try again.");
      editSheet(edit.id);
    });
  }
  function unlink() {
    var a = accounts();
    var item = findOwn(edit.id);
    if (!a || !item) return;
    if (!edit.confirm) { edit.confirm = true; editSheet(edit.id); return; }
    a.call("/v1/account/identities/" + encodeURIComponent(edit.id), { method: "DELETE", token: token() }).then(function (res) {
      if (!res || res.status !== 200) throw new Error("unlink");
      store(ownLinks().filter(function (it) { return String(it.id) !== String(edit.id); }));
      noteOwn(Object.assign({}, item, { merged: false }));
      refresh(true);
      closeSheet();
      host.render();
    }).catch(function () { edit.error = tr("Couldn’t save. Try again."); editSheet(edit.id); });
  }

  /* ---------- sheet plumbing (X-style: bottom sheet on phones) ---------- */
  function openSheet(title, inner) {
    var doc = root.document;
    if (!sheet) {
      sheet = doc.createElement("div");
      sheet.className = "lp-layer";
      doc.body.appendChild(sheet);
      doc.addEventListener("keydown", function (e) { if (e.key === "Escape" && sheet && sheet.innerHTML) closeSheet(); });
    }
    sheet.innerHTML = '<div class="tab-sheet lp-scrim" data-lp="close"></div><div class="menu tab-menu lp-menu" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="lp-grab" aria-hidden="true"></div><div class="lp-title"><b>' + esc(title) + '</b><button type="button" class="lp-x" data-lp="close" aria-label="' + esc(tr("Close")) + '">×</button></div>' + inner + "</div>";
  }
  function closeSheet() {
    if (sheet) sheet.innerHTML = "";
    edit = { id: "", people: false, confirm: false, busy: false, error: "" };
  }

  /* ---------- Settings > Your account > Linked accounts ---------- */
  function pageHtml() {
    var list = ownLinks();
    var rows = list.length ? list.map(function (it) { return rowHtml(it, true, me()); }).join("") : '<p class="lp-note">' + esc(tr("No linked accounts yet.")) + "</p>";
    return '<div class="lp-page"><p class="phandle">' + esc(tr("Link your other profiles. Each one can merge into your profile or keep its own page, and you choose who sees it.")) + '</p><div class="lp-list">' + rows + '</div><button type="button" class="lp-accent" data-lp="link">' + esc(tr("Link an account")) + '</button><p class="phandle">' + esc(tr("To link a profile you show a code on it once, so only its owner can link it.")) + "</p></div>";
  }
  function summary() {
    var n = ownLinks().length;
    return n ? tr("{n} linked", { n: n }) : tr("Link X, Instagram, YouTube and more");
  }

  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-lp]") : null;
    if (!el) return;
    var act = el.getAttribute("data-lp");
    if (act === "noop") return;
    if (act !== "close" || el.tagName !== "A") event.preventDefault();
    if (act === "open") listSheet(el.getAttribute("data-handle"));
    else if (act === "close") closeSheet();
    else if (act === "go") { closeSheet(); root.location.hash = el.getAttribute("data-href"); }
    else if (act === "filter") {
      filters[low(el.getAttribute("data-handle"))] = el.getAttribute("data-src") || "all";
      closeSheet();
      host.render();
    }
    else if (act === "edit") { edit = { id: el.getAttribute("data-id"), people: false, confirm: false, busy: false, error: "" }; editSheet(edit.id); }
    else if (act === "aud") {
      var aud = el.getAttribute("data-aud");
      if (aud === "people") { edit.people = true; editSheet(edit.id); return; }
      patch({ audience: aud });
    }
    else if (act === "people-cancel") { edit.people = false; editSheet(edit.id); }
    else if (act === "people-save") {
      var input = root.document.getElementById("lp-people-in");
      var people = String(input ? input.value : "").split(/[\s,]+/).map(low).filter(Boolean).slice(0, 50);
      if (!people.length) { edit.error = tr("Add at least one username."); editSheet(edit.id); return; }
      patch({ audience: "people", people: people });
    }
    else if (act === "merge") patch({ merged: el.getAttribute("data-on") === "1" });
    else if (act === "hide") { var it = findOwn(edit.id); if (it) patch({ hidden: it.hidden !== true }); }
    else if (act === "unlink") unlink();
    else if (act === "link") {
      closeSheet();
      var a = accounts();
      if (a && a.openLinkIdentity) a.openLinkIdentity();
    }
  }

  function setHost(next) { Object.keys(next || {}).forEach(function (k) { host[k] = next[k]; }); }

  if (root.document) root.document.addEventListener("click", onClick);
  if (root.addEventListener) root.addEventListener("storage", function (e) { if (e.key === KEY) { map = read(); index = build(map.list); host.render(); } });

  root.LinkedProfiles = {
    target: target,
    hashFor: hashFor,
    followId: followId,
    followIds: followIds,
    isMergedFeed: isMergedFeed,
    dropMerged: dropMerged,
    mergedLinks: mergedLinks,
    asOwn: asOwn,
    filterPost: filterPost,
    filterHtml: filterHtml,
    headerHtml: headerHtml,
    pageHtml: pageHtml,
    summary: summary,
    refresh: refresh,
    noteOwn: noteOwn,
    setHost: setHost,
    enabled: enabled,
    platformName: platformName
  };
})(typeof window !== "undefined" ? window : globalThis);
