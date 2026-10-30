/* Display names: several names, who sees which one, show-to and hide-from
   rules and "Preview as" live in Edit profile > Display names
   (profileHtml), next to Usernames, built from the shared X settings parts
   in x-settings.js: a simple list with one row per name and its audience in
   plain words, and a detail screen per name (audience presets, people chips
   with search, hide from, a live summary sentence, inline Preview as, copy
   audience). Changes save on their own with a "Saved" toast; preset changes
   and copies can be undone, and removing a name waits behind an Undo
   snackbar. Each person sees exactly one name; the most specific audience
   wins and a hidden name falls back to a broader one. Everything is
   enforced by the server; this only edits. */
(function (root) {
  "use strict";

  var deps = {};
  var data = null;
  var lists = [];
  var view = "main";
  var openId = "";
  var pending = {};
  var pendingRev = {};
  var saveTimers = {};
  var removing = {};
  var known = [];
  var knownAsked = false;
  var hideOpen = false;
  var inline = null;
  var focusKey = "";
  var scrollMem = {};
  var chipDraft = {};
  var activeChip = "";
  var note = "";
  var asked = false;

  function tr(key, vars) {
    var fn = root.t || (typeof window !== "undefined" && window.t);
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function XS() { return root.XSettings || null; }

  function call(path, opts) {
    if (!deps.api) return Promise.resolve({ status: 503 });
    var next = opts || {};
    try { if (!next.token && deps.token) next.token = deps.token(); } catch (err) { /* signed out */ }
    return deps.api(path, next);
  }

  var watchers = [];
  function redraw() {
    if (deps.render) deps.render();
    watchers.forEach(function (fn) { try { fn(); } catch (err) { /* one painter failing never blocks the rest */ } });
  }

  function errorText(code) {
    if (code === "invalid_name") return tr("Names can be up to 50 characters.");
    if (code === "name_cap") return tr("You've reached the most display names an account can have.");
    if (code === "primary_name") return tr("Make another name your main name first.");
    if (code === "rate_limited") return tr("Too many changes. Try again later.");
    return tr("Something went wrong. Try again.");
  }
  function said(res) {
    if (res && res.status >= 200 && res.status < 300) { note = ""; return true; }
    var code = res && (res.error || (res.status === 429 ? "rate_limited" : ""));
    note = errorText(code);
    redraw();
    return false;
  }

  function load() {
    return Promise.all([call("/v1/display-names"), call("/v1/audience-lists")]).then(function (got) {
      if (got[0] && got[0].status === 200) data = got[0];
      if (got[1] && got[1].status === 200) lists = got[1].lists || [];
      redraw();
    }).catch(function () {});
  }
  function loadKnown() {
    if (knownAsked) return;
    knownAsked = true;
    call("/v1/audience-lists/people").then(function (res) {
      if (res && res.status === 200) { known = res.people || []; redraw(); }
    }).catch(function () {});
  }

  function listName(id) {
    for (var i = 0; i < lists.length; i++) if (lists[i].id === id) return (lists[i].icon ? lists[i].icon + " " : "") + lists[i].name;
    return "";
  }
  function names() { return ((data && data.names) || []).filter(function (n) { return !removing[n.id]; }); }
  function findName(id) {
    var all = (data && data.names) || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* ---------- audiences in plain words ---------- */
  function blankAudience() {
    return { include: { public: false, followers: false, friends: false, lists: [], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } };
  }
  function cleanAudience(aud) {
    var out = blankAudience();
    var inc = (aud && aud.include) || {};
    var exc = (aud && aud.exclude) || {};
    out.include.public = !!inc.public;
    out.include.followers = !!inc.followers;
    out.include.friends = !!inc.friends;
    out.include.lists = (inc.lists || []).slice();
    out.include.people = (inc.people || []).slice();
    out.exclude.followers = !!exc.followers;
    out.exclude.friends = !!exc.friends;
    out.exclude.lists = (exc.lists || []).slice();
    out.exclude.people = (exc.people || []).slice();
    return out;
  }
  function audOf(name) { return cleanAudience(pending[name.id] || name.audience); }
  function personLabel(handle) {
    for (var i = 0; i < known.length; i++) if (String(known[i].handle).toLowerCase() === String(handle).toLowerCase()) return known[i].name || "@" + handle;
    return "@" + handle;
  }
  function countPeople(n) { return n === 1 ? tr("1 person") : tr("{count} people", { count: n }); }
  function whoParts(side, aud, plain) {
    var s = aud[side] || {};
    var parts = [];
    if (side === "include" && s.public) parts.push(tr("Everyone"));
    if (s.followers) parts.push(tr("Followers"));
    if (s.friends) parts.push(tr("Friends"));
    (s.lists || []).forEach(function (id) { var n = listName(id); if (n) parts.push(plain ? tr("{name} list", { name: n }) : n); });
    var people = s.people || [];
    if (people.length) {
      if (plain) parts.push(countPeople(people.length));
      else people.forEach(function (h) { parts.push(personLabel(h)); });
    }
    return parts;
  }
  function hiddenCount(a) { return a.exclude.people.length + a.exclude.lists.length + (a.exclude.followers ? 1 : 0) + (a.exclude.friends ? 1 : 0); }
  /* "Everyone", "Friends only", "3 people + Close list", "… · hidden from 2". */
  function plainWho(aud) {
    var a = cleanAudience(aud);
    var inc = whoParts("include", a, true);
    var text;
    if (!inc.length) text = tr("No one");
    else if (a.include.public) text = tr("Everyone");
    else if (inc.length === 1 && a.include.followers) text = tr("Followers only");
    else if (inc.length === 1 && a.include.friends) text = tr("Friends only");
    else text = inc.join(" + ");
    if (hiddenCount(a)) text += " · " + tr("hidden from {who}", { who: whoParts("exclude", a, true).join(" + ") });
    return text;
  }
  function sentence(name) {
    var a = audOf(name);
    var inc = whoParts("include", a, false);
    var exc = whoParts("exclude", a, false);
    var out;
    if (!inc.length) out = tr("No one sees “{name}” right now.", { name: name.name });
    else if (a.include.public && inc.length === 1) out = tr("Everyone sees “{name}”, unless a more specific name is set for them.", { name: name.name });
    else out = tr("{who} see “{name}”.", { who: inc.join(", "), name: name.name });
    if (exc.length) out += " " + tr("Never shown to {who}.", { who: exc.join(", ") });
    return out;
  }
  function presetOf(aud) {
    var i = cleanAudience(aud).include;
    var on = [i.public, i.followers, i.friends, i.lists.length > 0, i.people.length > 0].filter(Boolean).length;
    if (!on) return "none";
    if (on > 1) return "custom";
    if (i.public) return "public";
    if (i.followers) return "followers";
    if (i.friends) return "friends";
    if (i.lists.length) return "lists";
    return "people";
  }
  function presetLabel(id) {
    return { public: tr("Everyone"), followers: tr("Followers"), friends: tr("Friends"), lists: tr("Lists"), people: tr("Specific people"), custom: tr("Custom"), none: tr("No one") }[id] || id;
  }
  function chipItems(handles) {
    return (handles || []).map(function (h) { return { value: h, label: personLabel(h) }; });
  }
  function seesText(label, res, forId) {
    if (res.hidden) return tr("{name} sees only your username.", { name: label });
    if (forId && res.id !== forId) return tr("{name} sees “{shown}” instead", { name: label, shown: res.name });
    return tr("{name} sees “{shown}”", { name: label, shown: res.name });
  }

  /* ---------- page parts ---------- */
  function headTitle() {
    var all = names();
    var main = all.filter(function (n) { return n.primary; })[0] || all[0];
    var open = view === "name" ? findName(openId) : null;
    if (open) return [open.name, tr("Who sees this name")];
    return [tr("Display names"), main ? main.name : ""];
  }
  function mainHtml(x) {
    var all = names();
    var rows = all.map(function (name) {
      return '<div class="xs-rowwrap">' + x.row({ attrs: 'data-dn="open-name" data-id="' + esc(name.id) + '"', titleHtml: '<span class="dn-shown">' + esc(name.name) + "</span>", badge: name.primary ? tr("Main") : "", sub: plainWho(audOf(name)), trail: "none" }) +
        x.more('data-dn="name-menu" data-id="' + esc(name.id) + '"', tr("More options for {name}", { name: name.name })) + "</div>";
    }).join("");
    var canAdd = ((data && data.names) || []).length < ((data && data.cap) || 5);
    return x.desc(tr("Each person sees exactly one of your display names. The most specific audience wins: a person, then a list, then friends, then followers, then public. If a name is hidden from someone, they see a broader one.")) +
      (note ? '<p class="un-note" role="alert">' + esc(note) + "</p>" : "") +
      '<div class="xs-list dn-names">' + rows +
      (canAdd ? x.row({ attrs: 'data-dn="add-sheet"', cls: "is-accent", lead: x.icon("plus"), title: tr("Add display name"), trail: "none" }) : "") + "</div>" +
      (canAdd ? "" : x.desc(tr("You've reached the most display names an account can have."))) +
      x.desc(tr("Nicknames people give you privately still win in their own view.")) +
      x.section(tr("Privacy")) +
      '<div class="xs-list">' + x.row({ attrs: 'data-dn="preview-sheet"', lead: x.icon("eye"), title: tr("Preview as"), sub: tr("See which name someone gets.") }) + "</div>";
  }
  function nameHtml(x, name) {
    var a = audOf(name);
    var check = function (side, key, title, on) { return x.check({ title: title, on: on, attrs: 'data-dn-aud="' + side + ":" + key + '"' }); };
    var listChecks = function (side) {
      return lists.map(function (l) { return check(side, "list:" + l.id, listName(l.id), a[side === "inc" ? "include" : "exclude"].lists.indexOf(l.id) >= 0); }).join("");
    };
    var hid = hiddenCount(a);
    var others = names().filter(function (n) { return n.id !== name.id; });
    var pv = inline && inline.id === name.id ? '<p class="xs-result un-preview-out" role="status">' + esc(inline.text) + "</p>" : "";
    return x.summary(sentence(name)) +
      (note ? '<p class="un-note" role="alert">' + esc(note) + "</p>" : "") +
      x.section(tr("Who sees this name")) +
      '<div class="xs-list">' + x.row({ attrs: 'data-dn="aud-sheet" data-id="' + esc(name.id) + '"', title: tr("Audience"), value: presetLabel(presetOf(a)) }) +
      check("inc", "public", tr("Everyone"), a.include.public) +
      check("inc", "followers", tr("Followers"), a.include.followers) +
      check("inc", "friends", tr("Friends"), a.include.friends) +
      listChecks("inc") + "</div>" +
      (lists.length ? "" : x.desc(tr("Create an audience list in Privacy and safety."))) +
      x.chips({ key: "inc", label: tr("Specific people"), items: chipItems(a.include.people), placeholder: tr("Add people") }) +
      x.row({ attrs: 'data-dn="toggle-hide" aria-expanded="' + (hideOpen ? "true" : "false") + '"', title: tr("Never show it to"), sub: hid ? tr("{count} hidden", { count: hid }) : tr("Optional. Hide this name from some people."), trail: '<span class="xs-chev' + (hideOpen ? " is-open" : "") + '">' + x.icon("chev") + "</span>" }) +
      (hideOpen ? '<div class="xs-list dn-hide">' + check("exc", "followers", tr("Followers"), a.exclude.followers) + check("exc", "friends", tr("Friends"), a.exclude.friends) + listChecks("exc") + "</div>" +
        x.chips({ key: "exc", label: tr("Hide from people"), items: chipItems(a.exclude.people), placeholder: tr("Add people") }) : "") +
      x.section(tr("Preview as"), tr("Pick someone to see which of your names they get.")) +
      x.chips({ key: "pv", items: [], placeholder: tr("Search people") }) + pv +
      x.section(tr("More")) +
      '<div class="xs-list">' +
      (others.length ? x.row({ attrs: 'data-dn="copy-from" data-id="' + esc(name.id) + '"', lead: x.icon("copy"), title: tr("Copy audience from another name") }) : "") +
      (name.primary ? x.row({ tag: "div", lead: x.icon("star"), title: tr("This is your main name"), sub: tr("It's on your profile and is what people see when no other name fits. Change it with Name in Edit profile."), trail: "none" })
        : x.row({ attrs: 'data-dn="rename" data-id="' + esc(name.id) + '"', title: tr("Name"), value: name.name }) +
          x.row({ attrs: 'data-dn="primary" data-id="' + esc(name.id) + '"', cls: "is-accent", lead: x.icon("star"), title: tr("Make main name"), trail: "none" }) +
          x.row({ attrs: 'data-dn="remove" data-id="' + esc(name.id) + '"', danger: true, lead: x.icon("trash"), title: tr("Remove display name"), trail: "none" })) +
      "</div>";
  }

  function viewKey() { return view + ":" + (view === "name" ? openId : ""); }
  function scroller() { return typeof document === "undefined" ? null : document.querySelector(".ep .acct-edit-body"); }
  function ready() {
    if (!asked) { asked = true; load(); }
    if (typeof Promise !== "undefined") Promise.resolve().then(afterPaint);
  }
  /* After any paint: the header shows this screen's title and subtitle, and
     scroll, typed search text and focus come back where they were. */
  function afterPaint() {
    if (typeof document === "undefined") return;
    var page = document.querySelector(".ep .dn-in-edit");
    if (!page) return;
    var h1 = document.querySelector(".ep .acct-edit-head h1");
    var t = headTitle();
    if (h1 && h1.getAttribute("data-dn-head") !== t.join("|")) {
      h1.className = "xs-head";
      h1.setAttribute("data-dn-head", t.join("|"));
      h1.innerHTML = '<span class="xs-head-title">' + esc(t[0]) + "</span>" + (t[1] ? '<span class="xs-head-sub">' + esc(t[1]) + "</span>" : "");
    }
    var box = scroller();
    var want = scrollMem[viewKey()] || 0;
    if (box && box.scrollTop !== want) box.scrollTop = want;
    /* An autosave repaint keeps the typed search and its suggestions. */
    var x = XS();
    Object.keys(chipDraft).forEach(function (key) {
      var input = page.querySelector('[data-xs-chip-input="' + key + '"]');
      if (!input || !chipDraft[key]) return;
      if (!input.value) input.value = chipDraft[key];
      var list = page.querySelector('[data-xs-suggest="' + key + '"]');
      if (x && list && list.hidden && key !== "pv") x.suggest(key, input.value, known, chipHandles(key));
    });
    var again = focusKey || activeChip;
    focusKey = "";
    if (again) {
      var el = page.querySelector('[data-xs-chip-input="' + again + '"]');
      if (el && document.activeElement !== el) {
        try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
        var end = el.value.length;
        try { el.setSelectionRange(end, end); } catch (err) { /* not text */ }
      }
    }
  }
  if (typeof document !== "undefined") {
    document.addEventListener("focusin", function (event) {
      var t = event.target;
      activeChip = t && t.getAttribute && t.closest && t.closest(".dn-in-edit") ? t.getAttribute("data-xs-chip-input") || "" : "";
    }, true);
    document.addEventListener("focusout", function (event) {
      var t = event.target;
      if (!t || !t.getAttribute || !t.getAttribute("data-xs-chip-input")) return;
      setTimeout(function () { if (t.isConnected && document.activeElement !== t && activeChip === t.getAttribute("data-xs-chip-input")) activeChip = ""; }, 0);
    }, true);
  }
  function go(next, id) {
    view = next;
    if (id != null) openId = id;
    hideOpen = false;
    inline = null;
    chipDraft = {};
    note = "";
    scrollMem[viewKey()] = 0;
    redraw();
  }

  /* Edit profile > Display names. */
  function profileHtml() {
    ready();
    var x = XS();
    if (!data || !x) return '<div class="dn-in-edit xs-page"><p class="xs-desc">' + esc(tr("Loading")) + "</p></div>";
    if (view === "name") loadKnown();
    if (view === "name" && (!findName(openId) || removing[openId])) view = "main";
    var body = view === "name" ? nameHtml(x, findName(openId)) : mainHtml(x);
    return '<div class="dn-in-edit xs-page" data-dn-view="' + esc(view) + '">' + body + "</div>";
  }

  /* ---------- saving on their own ---------- */
  function saved() { var x = XS(); if (x) x.toast(tr("Saved")); }
  function apply(res) {
    if (said(res)) { if (res.names) data = res; redraw(); }
    return res;
  }
  function setAudience(id, aud, quiet) {
    var name = findName(id);
    if (!name) return;
    pending[id] = cleanAudience(aud);
    pendingRev[id] = (pendingRev[id] || 0) + 1;
    var rev = pendingRev[id];
    note = "";
    redraw();
    clearTimeout(saveTimers[id]);
    saveTimers[id] = setTimeout(function () {
      var body = { id: id, audience: pending[id] };
      if (!name.primary) body.name = name.name;
      call("/v1/display-names", { method: "PATCH", body: body }).then(function (res) {
        if (pendingRev[id] !== rev) return;
        delete pending[id];
        if (said(res)) { if (res.names) data = res; redraw(); if (!quiet) saved(); }
        else redraw();
      });
    }, 450);
  }
  function editAudience(id, fn) {
    var name = findName(id);
    if (!name) return;
    var a = audOf(name);
    fn(a);
    setAudience(id, a);
  }

  /* ---------- chips ---------- */
  function chipHandles(key) {
    var name = findName(openId);
    if (!name || (key !== "inc" && key !== "exc")) return [];
    return audOf(name)[key === "inc" ? "include" : "exclude"].people;
  }
  function addPerson(key, raw) {
    var handle = String(raw || "").trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return;
    focusKey = key;
    delete chipDraft[key];
    if (key === "pv") { previewPerson(handle); return; }
    if (key !== "inc" && key !== "exc") return;
    editAudience(openId, function (a) {
      var side = a[key === "inc" ? "include" : "exclude"];
      if (side.people.map(function (p) { return p.toLowerCase(); }).indexOf(handle.toLowerCase()) < 0) side.people.push(handle);
    });
  }
  function dropPerson(key, handle) {
    if (key !== "inc" && key !== "exc") return;
    editAudience(openId, function (a) {
      var side = a[key === "inc" ? "include" : "exclude"];
      side.people = side.people.filter(function (p) { return p !== handle; });
    });
  }
  function previewPerson(handle) {
    var forId = openId;
    var flush = pending[forId] ? 500 : 0;
    setTimeout(function () {
      call("/v1/display-names/preview?as=" + encodeURIComponent(handle)).then(function (res) {
        if (res && res.status === 200) { inline = { id: forId, text: seesText(personLabel(handle), res, forId) }; note = ""; }
        else { inline = null; note = tr("No account found."); }
        redraw();
      });
    }, flush);
  }

  /* ---------- sheets ---------- */
  function audienceSheet(id) {
    var x = XS();
    var name = findName(id);
    if (!x || !name) return;
    var cur = presetOf(audOf(name));
    var opts = [
      { value: "public", label: tr("Everyone"), sub: tr("Anyone without a more specific name.") },
      { value: "followers", label: tr("Followers"), sub: tr("People who follow you.") },
      { value: "friends", label: tr("Friends"), sub: tr("People you're friends with.") }
    ];
    if (lists.length) opts.push({ value: "lists", label: tr("Lists"), sub: tr("Only people in the lists you pick.") });
    opts.push({ value: "people", label: tr("Specific people"), sub: tr("Only the people you add.") });
    if (cur === "custom") opts.push({ value: "custom", label: tr("Custom"), sub: tr("A mix, set below.") });
    x.sheet.radio({ title: tr("Who sees “{name}”?", { name: name.name }), sub: tr("Start with a preset, then fine-tune below."), options: opts, current: cur, onPick: function (v) {
      if (v === "custom" || v === cur) return;
      var before = audOf(name);
      var a = audOf(name);
      a.include.public = v === "public";
      a.include.followers = v === "followers";
      a.include.friends = v === "friends";
      a.include.lists = v === "lists" ? (before.include.lists.length ? before.include.lists : lists.slice(0, 1).map(function (l) { return l.id; })) : [];
      a.include.people = v === "people" ? before.include.people : [];
      setAudience(id, a, true);
      if (v === "people" && !a.include.people.length) focusKey = "inc";
      x.toast(tr("Audience set to {name}", { name: presetLabel(v) }), { undo: function () { setAudience(id, before, true); } });
    } });
  }
  function nameMenu(id) {
    var x = XS();
    var name = findName(id);
    if (!x || !name) return;
    var others = names().filter(function (n) { return n.id !== id; });
    x.sheet.menu({ title: name.name, sub: plainWho(audOf(name)), items: [
      { label: tr("Change audience"), icon: "people", pick: function () { go("name", id); } },
      name.primary ? null : { label: tr("Make main name"), icon: "star", pick: function () { makePrimary(id); } },
      others.length ? { label: tr("Copy audience from another name"), icon: "copy", pick: function () { copyFrom(id); } } : null,
      name.primary ? null : { label: tr("Remove display name"), icon: "trash", danger: true, pick: function () { removeName(id); } }
    ] });
  }
  function copyFrom(id) {
    var x = XS();
    var name = findName(id);
    if (!x || !name) return;
    var others = names().filter(function (n) { return n.id !== id; });
    x.sheet.radio({ title: tr("Copy audience from"), sub: tr("“{name}” gets the same audience.", { name: name.name }), options: others.map(function (n) { return { value: n.id, label: n.name, sub: plainWho(audOf(n)) }; }), current: "", onPick: function (v) {
      var src = findName(v);
      if (!src) return;
      var before = audOf(name);
      setAudience(id, audOf(src), true);
      x.toast(tr("Copied audience from “{name}”", { name: src.name }), { undo: function () { setAudience(id, before, true); } });
    } });
  }
  function makePrimary(id) {
    var name = findName(id);
    if (!name) return;
    var label = name.name;
    call("/v1/display-names/primary", { method: "POST", body: { id: id } }).then(function (res) {
      if (!said(res)) return;
      if (res.names) data = res;
      if (view === "name") go("main"); else redraw();
      var x = XS();
      if (x) x.toast(tr("“{name}” is now your main name", { name: label }));
    });
  }
  function removeName(id) {
    var x = XS();
    var name = findName(id);
    if (!name) return;
    removing[id] = true;
    if (view === "name" && openId === id) { view = "main"; openId = ""; }
    redraw();
    var commit = function () {
      call("/v1/display-names", { method: "DELETE", body: { id: id } }).then(function (res) {
        delete removing[id];
        apply(res);
      });
    };
    if (!x) { commit(); return; }
    x.toast(tr("“{name}” removed", { name: name.name }), { undo: function () { delete removing[id]; redraw(); }, commit: commit });
  }
  function nameSheet(opts) {
    var x = XS();
    if (!x) return;
    var err = "";
    var typed = opts.value || "";
    var busy = false;
    var sheet = x.sheet.open({
      title: opts.title, sub: tr("Up to 50 characters."),
      body: function () {
        return x.field({ label: tr("Display name"), value: typed, maxlength: 50, counter: true, error: err, attrs: 'data-dn-new data-xs-keep="new" autofocus enterkeyhint="done"' }) +
          '<div class="xs-actions">' + x.pill(opts.action, "data-xs-add" + (busy ? " disabled" : "")) + "</div>";
      },
      onInput: function (el) { if (el.hasAttribute("data-dn-new")) typed = el.value; },
      onKey: function (event) { if (event.key === "Enter" && event.target.hasAttribute && event.target.hasAttribute("data-dn-new")) { event.preventDefault(); submit(); } },
      onClick: function (el) { if (el.hasAttribute("data-xs-add")) submit(); return false; }
    });
    function submit() {
      var fresh = typed.trim();
      if (!fresh || busy) return;
      busy = true;
      sheet.paint();
      opts.send(fresh).then(function (res) {
        busy = false;
        if (res && res.status >= 200 && res.status < 300) {
          note = "";
          sheet.close();
          opts.done(res, fresh);
          x.toast(tr("Saved"));
          return;
        }
        err = errorText(res && (res.error || (res.status === 429 ? "rate_limited" : "")));
        sheet.paint();
      });
    }
  }
  function addSheet() {
    var before = ((data && data.names) || []).map(function (n) { return n.id; });
    nameSheet({
      title: tr("Add display name"), action: tr("Add"),
      send: function (fresh) { return call("/v1/display-names", { method: "POST", body: { name: fresh, audience: { include: { friends: true } } } }); },
      done: function (res) {
        if (res.names) data = res;
        var added = ((data && data.names) || []).filter(function (n) { return before.indexOf(n.id) < 0; })[0];
        if (added) go("name", added.id); else redraw();
      }
    });
  }
  function renameSheet(id) {
    var name = findName(id);
    if (!name || name.primary) return;
    nameSheet({
      title: tr("Edit name"), action: tr("Save"), value: name.name,
      send: function (fresh) { return call("/v1/display-names", { method: "PATCH", body: { id: id, name: fresh, audience: audOf(name) } }); },
      done: function (res) { if (res.names) data = res; redraw(); }
    });
  }
  function previewSheet() {
    var x = XS();
    if (!x) return;
    loadKnown();
    var result = null;
    var cur = "";
    var opts = [["public", tr("Public")], ["followers", tr("Followers")], ["friends", tr("Friends")]].concat(lists.map(function (list) { return ["list:" + list.id, listName(list.id)]; }));
    var sheet = x.sheet.open({
      title: tr("Preview as"), sub: tr("See which name someone gets."),
      body: function () {
        return (result ? '<p class="xs-result un-preview-out" role="status">' + esc(result) + "</p>" : "") +
          '<div role="radiogroup">' + opts.map(function (o) { return x.radio({ title: o[1], on: cur === o[0], attrs: 'data-xs-opt="' + esc(o[0]) + '"' }); }).join("") + "</div>" +
          x.chips({ key: "dnpvs", items: [], placeholder: tr("Preview as someone") });
      },
      onClick: function (el) {
        if (el.hasAttribute("data-xs-opt")) { cur = el.getAttribute("data-xs-opt"); ask(cur, el.querySelector(".xs-title") ? el.querySelector(".xs-title").textContent : cur); }
        else if (el.hasAttribute("data-xs-pick")) { cur = ""; ask(el.getAttribute("data-value"), personLabel(el.getAttribute("data-value"))); }
        return false;
      },
      onInput: function (el) { if (el.getAttribute("data-xs-chip-input") === "dnpvs") x.suggest("dnpvs", el.value, known, []); },
      onKey: function (event) {
        var t = event.target;
        if (event.key === "Enter" && t.getAttribute && t.getAttribute("data-xs-chip-input") === "dnpvs") { event.preventDefault(); var h = t.value.trim().replace(/^@/, ""); if (h) { cur = ""; ask(h, personLabel(h)); } }
      }
    });
    function ask(as, label) {
      call("/v1/display-names/preview?as=" + encodeURIComponent(as)).then(function (res) {
        result = res && res.status === 200 ? seesText(label, res, "") : tr("No account found.");
        sheet.paint();
      });
    }
  }

  /* ---------- events ---------- */
  function onClick(event) {
    var t = event.target;
    if (!t || !t.closest) return;
    var page = t.closest(".dn-in-edit");
    /* Back from a name's screen goes to the Display names list first. */
    var back = t.closest('[data-acct="edit-back"]');
    if (back && view !== "main" && document.querySelector(".ep .dn-in-edit")) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      go("main");
      return;
    }
    if (t.closest('[data-acct="edit-sub"][data-sub="displaynames"], [data-acct="close"]') || back) { view = "main"; openId = ""; inline = null; }
    if (page) {
      var rm = t.closest("[data-xs-chip-remove]");
      if (rm) { event.preventDefault(); dropPerson(rm.getAttribute("data-xs-chip-remove"), rm.getAttribute("data-value")); return; }
      var pick = t.closest("[data-xs-pick]");
      if (pick) { event.preventDefault(); addPerson(pick.getAttribute("data-xs-pick"), pick.getAttribute("data-value")); return; }
    }
    var el = t.closest("[data-dn]");
    if (!el) return;
    event.preventDefault();
    var act = el.getAttribute("data-dn");
    var id = el.getAttribute("data-id") || "";
    if (act === "open-name") { go("name", id); return; }
    if (act === "name-menu") { nameMenu(id); return; }
    if (act === "add-sheet") { addSheet(); return; }
    if (act === "preview-sheet") { previewSheet(); return; }
    if (act === "aud-sheet") { audienceSheet(id); return; }
    if (act === "copy-from") { copyFrom(id); return; }
    if (act === "rename") { renameSheet(id); return; }
    if (act === "toggle-hide") { hideOpen = !hideOpen; redraw(); return; }
    if (act === "primary") { makePrimary(id); return; }
    if (act === "remove") { removeName(id); return; }
  }
  function onChange(event) {
    var el = event.target;
    if (!el || !el.getAttribute || !el.closest || !el.closest(".dn-in-edit")) return;
    var key = el.getAttribute("data-dn-aud");
    if (!key) return;
    var side = key.slice(0, 3) === "inc" ? "include" : "exclude";
    var what = key.slice(4);
    var on = !!el.checked;
    editAudience(openId, function (a) {
      if (what.indexOf("list:") === 0) {
        var lid = what.slice(5);
        a[side].lists = a[side].lists.filter(function (l) { return l !== lid; });
        if (on) a[side].lists.push(lid);
      } else a[side][what] = on;
    });
  }
  function onInput(event) {
    var el = event.target;
    if (!el || !el.getAttribute || !el.closest || !el.closest(".dn-in-edit")) return;
    var key = el.getAttribute("data-xs-chip-input");
    var x = XS();
    if (key) chipDraft[key] = el.value;
    if (key && x) x.suggest(key, el.value, known, chipHandles(key));
  }
  function onKey(event) {
    var el = event.target;
    if (event.key !== "Enter" || !el || !el.getAttribute || !el.closest || !el.closest(".dn-in-edit")) return;
    var key = el.getAttribute("data-xs-chip-input");
    if (!key || !el.value.trim()) return;
    event.preventDefault();
    addPerson(key, el.value);
  }
  function onScroll(event) {
    var el = event.target;
    if (el && el.classList && el.classList.contains("acct-edit-body") && el.querySelector && el.querySelector(".dn-in-edit")) scrollMem[viewKey()] = el.scrollTop;
  }

  if (typeof window !== "undefined") window.addEventListener("click", onClick, true);
  if (typeof document !== "undefined") {
    document.addEventListener("change", onChange, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("pagehide", function () { var x = XS(); if (x) x.flushUndo(); });
  }

  root.ViktorychDisplayNames = {
    bind: function (next) { deps = next || {}; },
    profileHtml: profileHtml,
    names: function () { return data ? (data.names || []) : null; },
    watch: function (fn) { if (typeof fn === "function" && watchers.indexOf(fn) < 0) watchers.push(fn); },
    load: load,
    reset: function () { data = null; asked = false; view = "main"; openId = ""; inline = null; note = ""; pending = {}; removing = {}; chipDraft = {}; known = []; knownAsked = false; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
