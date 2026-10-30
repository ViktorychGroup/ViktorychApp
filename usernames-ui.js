/* Usernames: several usernames, who sees which one, "Preview as" and who
   can mention you live in Edit profile > Usernames (the name friends see is
   one of the display names now, display-names-ui.js)
   (profileHtml), built from the shared X settings parts in x-settings.js:
   a simple list of names with plain-words audiences, and a detail screen
   per name (audience presets, people chips, hide from, inline Preview as,
   copy audience). Changes save on their own with a "Saved" toast; removing
   a name waits behind an Undo snackbar. Settings > Usernames keeps a
   shortcut to that subpage plus your private nicknames for others
   (settingsHtml). Everything is enforced by the server; this only edits. */
(function (root) {
  "use strict";

  var deps = {};
  var data = null;
  var lists = [];
  var mentions = null;
  var nicknames = [];
  var openHandle = "";
  var preview = null;
  var view = "main";
  var pending = {};
  var pendingRev = {};
  var saveTimers = {};
  var removing = {};
  var known = [];
  var knownAsked = false;
  var hideOpen = false;
  var advancedOpen = false;
  var inline = null;
  var focusKey = "";
  var scrollMem = {};
  var note = "";
  var asked = false;

  function tr(key, vars) {
    var fn = root.t || (typeof window !== "undefined" && window.t);
    return fn ? fn(key, vars) : key;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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

  /* The app may re-render the page at any time (a profile or session load
     finishing); typed text and ticked boxes are kept here and put back. */
  var drafts = {};
  function draftKey(el) {
    var attrs = Array.prototype.filter.call(el.attributes, function (a) { return a.name.indexOf("data-un-") === 0; });
    if (!attrs.length) return "";
    var wrap = el.closest(".un-card");
    var card = wrap ? wrap.querySelector(".un-name") : null;
    return (card ? card.getAttribute("data-handle") : "") + "|" + attrs.map(function (a) { return a.name + "=" + a.value; }).join("|");
  }
  function keep(event) {
    var el = event.target;
    if (!el || !el.closest || !el.closest(".un-settings")) return;
    var key = draftKey(el);
    if (key) drafts[key] = el.type === "checkbox" ? { checked: el.checked } : { value: el.value };
  }
  function restore() {
    if (typeof document === "undefined") return;
    document.querySelectorAll(".un-settings").forEach(function (box) {
      box.querySelectorAll("input, select").forEach(function (el) {
        var d = drafts[draftKey(el)];
        if (!d) return;
        if ("checked" in d) el.checked = d.checked;
        else el.value = d.value;
      });
    });
  }
  function settle() { drafts = {}; }

  function errorText(code) {
    if (code === "handle_taken") return tr("That username is taken.");
    if (code === "handle_held") return tr("That username was released recently and is held for now.");
    if (code === "handle_reserved") return tr("That username is reserved.");
    if (code === "invalid_handle") return tr("Usernames use letters, numbers and underscores, up to 15.");
    if (code === "name_cap") return tr("You've reached the most usernames an account can have.");
    if (code === "rate_limited") return tr("Too many changes. Try again later.");
    if (code === "handle_locked") return tr("This username can't be changed.");
    if (code === "primary_name") return tr("Make another username primary first.");
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
    return Promise.all([
      call("/v1/usernames"),
      call("/v1/audience-lists"),
      call("/v1/usernames/mentions"),
      call("/v1/nicknames")
    ]).then(function (got) {
      if (got[0] && got[0].status === 200) data = got[0];
      if (got[1] && got[1].status === 200) lists = got[1].lists || [];
      if (got[2] && got[2].status === 200) mentions = got[2];
      if (got[3] && got[3].status === 200) nicknames = got[3].nicknames || [];
      redraw();
    }).catch(function () {});
  }

  function listName(id) {
    for (var i = 0; i < lists.length; i++) if (lists[i].id === id) return (lists[i].icon ? lists[i].icon + " " : "") + lists[i].name;
    return "";
  }

  function summary(aud) {
    var inc = (aud && aud.include) || {};
    var parts = [];
    if (inc.people && inc.people.length) parts.push(tr("Specific people"));
    (inc.lists || []).forEach(function (id) { var n = listName(id); if (n) parts.push(n); });
    if (inc.friends) parts.push(tr("Friends"));
    if (inc.followers) parts.push(tr("Followers"));
    if (inc.public) parts.push(tr("Public"));
    return parts.length ? parts.join(", ") : tr("No one");
  }

  function XS() { return root.XSettings || null; }

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
  function audOf(name) { return cleanAudience(pending[name.handle] || name.audience); }
  function findName(handle) {
    var names = (data && data.names) || [];
    for (var i = 0; i < names.length; i++) if (names[i].handle === handle) return names[i];
    return null;
  }
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
    var hidden = whoParts("exclude", a, true);
    var hiddenCount = a.exclude.people.length + a.exclude.lists.length + (a.exclude.followers ? 1 : 0) + (a.exclude.friends ? 1 : 0);
    if (hiddenCount) text += " · " + tr("hidden from {who}", { who: hidden.join(" + ") });
    return text;
  }
  function sentence(name) {
    var a = audOf(name);
    var inc = whoParts("include", a, false);
    var exc = whoParts("exclude", a, false);
    var out;
    if (!inc.length) out = tr("No one sees @{handle} right now.", { handle: name.handle });
    else if (a.include.public && inc.length === 1) out = tr("Everyone sees @{handle}, unless a more specific username is set for them.", { handle: name.handle });
    else out = tr("{who} see @{handle}.", { who: inc.join(", "), handle: name.handle });
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
  function policyLabel(value, withDefault) {
    if (!value) return withDefault ? tr("Same as broader audience") : tr("Anyone");
    return { anyone: tr("Anyone"), replies: tr("Only in replies to me"), nobody: tr("No one") }[value] || value;
  }
  function mentionRules() { return mentions || { public: "anyone", followers: "", friends: "", lists: {}, allow: [], block: [] }; }
  function mentionsPlain() {
    var m = mentionRules();
    var text = policyLabel(m.public || "anyone", false);
    var extra = 0;
    if (m.followers) extra++;
    if (m.friends) extra++;
    Object.keys(m.lists || {}).forEach(function (k) { if (m.lists[k]) extra++; });
    if (extra) text += " · " + tr("{count} more rules", { count: extra });
    if ((m.block || []).length) text += " · " + tr("{count} blocked", { count: m.block.length });
    return text;
  }
  function mentionSentence() {
    var m = mentionRules();
    var base = m.public || "anyone";
    var out = base === "anyone" ? tr("Anyone can mention you.") : base === "replies" ? tr("People can mention you only when replying to you.") : tr("No one can mention you.");
    var over = [];
    if (m.followers) over.push(tr("Followers: {rule}", { rule: policyLabel(m.followers, true) }));
    if (m.friends) over.push(tr("Friends: {rule}", { rule: policyLabel(m.friends, true) }));
    lists.forEach(function (l) { var v = (m.lists || {})[l.id]; if (v) over.push(listName(l.id) + ": " + policyLabel(v, true)); });
    if (over.length) out += " " + over.join(". ") + ".";
    if ((m.allow || []).length) out += " " + tr("Always allowed: {who}.", { who: m.allow.map(personLabel).join(", ") });
    if ((m.block || []).length) out += " " + tr("Never allowed: {who}.", { who: m.block.map(personLabel).join(", ") });
    return out;
  }

  /* ---------- page parts ---------- */
  function headTitle() {
    var names = (data && data.names) || [];
    var main = names.filter(function (n) { return n.primary; })[0] || names[0];
    if (view === "name" && findName(openHandle)) return [ "@" + openHandle, tr("Who sees this username") ];
    if (view === "mentions") return [ tr("Who can mention you"), main ? "@" + main.handle : "" ];
    if (view === "order") return [ tr("List priority"), main ? "@" + main.handle : "" ];
    return [ tr("Usernames"), main ? "@" + main.handle : "" ];
  }
  function chipItems(handles) {
    return (handles || []).map(function (h) { return { value: h, label: personLabel(h) }; });
  }
  function mainHtml(x) {
    var names = ((data && data.names) || []).filter(function (n) { return !removing[n.handle]; });
    var rows = names.map(function (name) {
      return '<div class="xs-rowwrap">' + x.row({ attrs: 'data-un="open-name" data-handle="' + esc(name.handle) + '"', titleHtml: '<span class="xs-handle un-at">@' + esc(name.handle) + "</span>", badge: name.primary ? tr("Primary") : "", sub: plainWho(audOf(name)), trail: "none" }) +
        x.more('data-un="name-menu" data-handle="' + esc(name.handle) + '"', tr("More options for @{handle}", { handle: name.handle })) + "</div>";
    }).join("");
    var canAdd = ((data && data.names) || []).length < ((data && data.cap) || 5);
    var ordered = orderedLists();
    return x.desc(tr("Each person sees exactly one of your usernames. The most specific audience wins: a person, then a list, then friends, then followers, then public.")) +
      (note ? '<p class="un-note" role="alert">' + esc(note) + "</p>" : "") +
      '<div class="xs-list un-names">' + rows +
      (canAdd ? x.row({ attrs: 'data-un="add-sheet"', cls: "is-accent", lead: x.icon("plus"), title: tr("Add username"), trail: "none" }) : "") + "</div>" +
      (canAdd ? "" : x.desc(tr("You've reached the most usernames an account can have."))) +
      x.desc(tr("Removed usernames stay reserved for you for {days} days.", { days: (data && data.releaseDays) || 30 })) +
      x.section(tr("Privacy")) +
      '<div class="xs-list">' +
      x.row({ attrs: 'data-un="preview-sheet"', lead: x.icon("eye"), title: tr("Preview as"), sub: tr("See which username someone gets.") }) +
      (lists.length > 1 ? x.row({ attrs: 'data-un="open-order"', lead: x.icon("people"), title: tr("List priority"), sub: ordered.map(function (l) { return listName(l.id); }).join(" › ") }) : "") +
      x.row({ attrs: 'data-un="open-mentions"', lead: "@", title: tr("Who can mention you"), sub: mentionsPlain() }) +
      "</div>";
  }
  function nameHtml(x, name) {
    var a = audOf(name);
    var preset = presetOf(a);
    var check = function (side, key, title, on) { return x.check({ title: title, on: on, attrs: 'data-un-aud="' + side + ":" + key + '"' }); };
    var listChecks = function (side) {
      return lists.map(function (l) { return check(side, "list:" + l.id, listName(l.id), a[side === "inc" ? "include" : "exclude"].lists.indexOf(l.id) >= 0); }).join("");
    };
    var hideCount = a.exclude.people.length + a.exclude.lists.length + (a.exclude.followers ? 1 : 0) + (a.exclude.friends ? 1 : 0);
    var others = ((data && data.names) || []).filter(function (n) { return n.handle !== name.handle && !removing[n.handle]; });
    var pv = "";
    if (inline && inline.handle === name.handle) {
      pv = '<p class="xs-result un-preview-out" role="status">' + esc(inline.hidden ? tr("{name} sees no username.", { name: inline.label }) : inline.sees === name.handle ? tr("{name} sees @{handle}", { name: inline.label, handle: inline.sees }) : tr("{name} sees @{handle} instead", { name: inline.label, handle: inline.sees })) + "</p>";
    }
    return x.summary(sentence(name)) +
      (note ? '<p class="un-note" role="alert">' + esc(note) + "</p>" : "") +
      x.section(tr("Who sees this username")) +
      '<div class="xs-list">' + x.row({ attrs: 'data-un="aud-sheet" data-handle="' + esc(name.handle) + '"', title: tr("Audience"), value: presetLabel(preset) }) +
      check("inc", "public", tr("Everyone"), a.include.public) +
      check("inc", "followers", tr("Followers"), a.include.followers) +
      check("inc", "friends", tr("Friends"), a.include.friends) +
      listChecks("inc") + "</div>" +
      (lists.length ? "" : x.desc(tr("Create an audience list in Privacy and safety."))) +
      x.chips({ key: "inc", label: tr("Specific people"), items: chipItems(a.include.people), placeholder: tr("Add people") }) +
      x.row({ attrs: 'data-un="toggle-hide" aria-expanded="' + (hideOpen ? "true" : "false") + '"', title: tr("Never show it to"), sub: hideCount ? tr("{count} hidden", { count: hideCount }) : tr("Optional. Hide this username from some people."), trail: '<span class="xs-chev' + (hideOpen ? " is-open" : "") + '">' + x.icon("chev") + "</span>" }) +
      (hideOpen ? '<div class="xs-list un-hide">' + check("exc", "followers", tr("Followers"), a.exclude.followers) + check("exc", "friends", tr("Friends"), a.exclude.friends) + listChecks("exc") + "</div>" +
        x.chips({ key: "exc", label: tr("Hide from people"), items: chipItems(a.exclude.people), placeholder: tr("Add people") }) : "") +
      x.section(tr("Preview as"), tr("Pick someone to see which of your usernames they get.")) +
      x.chips({ key: "pv", items: [], placeholder: tr("Search people") }) + pv +
      x.section(tr("More")) +
      '<div class="xs-list">' +
      (others.length ? x.row({ attrs: 'data-un="copy-from" data-handle="' + esc(name.handle) + '"', lead: x.icon("copy"), title: tr("Copy audience from another username") }) : "") +
      (name.primary ? x.row({ tag: "div", lead: x.icon("star"), title: tr("This is your primary username"), sub: tr("It's on your profile and is what people see when no other username fits."), trail: "none" })
        : x.row({ attrs: 'data-un="primary" data-handle="' + esc(name.handle) + '"', cls: "is-accent", lead: x.icon("star"), title: tr("Make primary"), trail: "none" }) +
          x.row({ attrs: 'data-un="remove" data-handle="' + esc(name.handle) + '"', danger: true, lead: x.icon("trash"), title: tr("Remove username"), sub: tr("It stays reserved for you for {days} days.", { days: (data && data.releaseDays) || 30 }), trail: "none" })) +
      "</div>";
  }
  function mentionsPage(x) {
    var m = mentionRules();
    var rule = function (key, title, value, withDefault) {
      return x.row({ attrs: 'data-un="m-sheet" data-key="' + esc(key) + '"', title: title, value: policyLabel(value, withDefault) });
    };
    return x.summary(mentionSentence(), "people") +
      (note ? '<p class="un-note" role="alert">' + esc(note) + "</p>" : "") +
      x.desc(tr("The most specific rule wins: a person, then a list, then friends, then followers, then everyone.")) +
      '<div class="xs-list">' + rule("public", tr("Everyone"), m.public || "anyone", false) +
      x.row({ attrs: 'data-un="toggle-advanced" aria-expanded="' + (advancedOpen ? "true" : "false") + '"', title: tr("Advanced"), sub: tr("Different rules for followers, friends and lists."), trail: '<span class="xs-chev' + (advancedOpen ? " is-open" : "") + '">' + x.icon("chev") + "</span>" }) +
      (advancedOpen ? rule("followers", tr("Followers"), m.followers, true) + rule("friends", tr("Friends"), m.friends, true) +
        lists.map(function (l) { return rule("list:" + l.id, listName(l.id), (m.lists || {})[l.id], true); }).join("") : "") + "</div>" +
      x.chips({ key: "allow", label: tr("Always allow"), items: chipItems(m.allow), placeholder: tr("Add people") }) +
      x.chips({ key: "block", label: tr("Never allow"), items: chipItems(m.block), placeholder: tr("Add people") });
  }
  function orderPage(x) {
    var ordered = orderedLists();
    if (!ordered.length) return x.empty(tr("No lists yet"), tr("Create an audience list in Privacy and safety."));
    return x.desc(tr("When someone is in more than one list, the higher list decides.")) + x.desc(tr("Drag the handle to reorder.")) +
      '<div class="xs-list" data-xs-sortable="un-lists">' + ordered.map(function (l, i) {
        return '<div class="xs-row" data-xs-sort-item="' + esc(l.id) + '"><span class="xs-lead xs-rank">' + (i + 1) + '</span><span class="xs-copy"><span class="xs-title">' + esc(listName(l.id)) + "</span></span>" + x.sortHandle(tr("Reorder {name}", { name: listName(l.id) })) + "</div>";
      }).join("") + "</div>";
  }

  function ready() {
    if (!asked) { asked = true; load(); }
    if (typeof Promise !== "undefined") Promise.resolve().then(afterPaint);
  }
  function loadKnown() {
    if (knownAsked) return;
    knownAsked = true;
    call("/v1/audience-lists/people").then(function (res) {
      if (res && res.status === 200) { known = res.people || []; redraw(); }
    }).catch(function () {});
  }
  function viewKey() { return view + ":" + (view === "name" ? openHandle : ""); }
  function scroller() { return typeof document === "undefined" ? null : document.querySelector(".ep .acct-edit-body"); }
  /* After any paint of the subpage: the header shows this screen's title and
     subtitle, and scroll and focus come back where they were. */
  function afterPaint() {
    restore();
    if (typeof document === "undefined") return;
    var page = document.querySelector(".ep .un-in-edit");
    if (!page) return;
    var h1 = document.querySelector(".ep .acct-edit-head h1");
    var t = headTitle();
    if (h1 && h1.getAttribute("data-un-head") !== t.join("|")) {
      h1.className = "xs-head";
      h1.setAttribute("data-un-head", t.join("|"));
      h1.innerHTML = '<span class="xs-head-title">' + esc(t[0]) + "</span>" + (t[1] ? '<span class="xs-head-sub">' + esc(t[1]) + "</span>" : "");
    }
    var box = scroller();
    var want = scrollMem[viewKey()] || 0;
    if (box && box.scrollTop !== want) box.scrollTop = want;
    Object.keys(chipDraft).forEach(function (key) {
      var input = page.querySelector('[data-xs-chip-input="' + key + '"]');
      if (input && chipDraft[key] && !input.value) input.value = chipDraft[key];
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
  /* A save repaints the page; keep what is being typed in a people box. */
  var chipDraft = {};
  var activeChip = "";
  if (typeof document !== "undefined") {
    document.addEventListener("focusin", function (event) {
      var t = event.target;
      activeChip = t && t.getAttribute && t.closest && t.closest(".un-in-edit") ? t.getAttribute("data-xs-chip-input") || "" : "";
    }, true);
    document.addEventListener("focusout", function (event) {
      var t = event.target;
      if (!t || !t.getAttribute || !t.getAttribute("data-xs-chip-input")) return;
      setTimeout(function () { if (t.isConnected && document.activeElement !== t && activeChip === t.getAttribute("data-xs-chip-input")) activeChip = ""; }, 0);
    }, true);
  }
  function go(next, handle) {
    view = next;
    if (handle != null) openHandle = handle;
    hideOpen = false;
    inline = null;
    chipDraft = {};
    note = "";
    scrollMem[viewKey()] = 0;
    redraw();
  }

  /* Edit profile > Usernames. */
  function profileHtml() {
    ready();
    var x = XS();
    if (!data || !x) return '<div class="un-in-edit xs-page"><p class="xs-desc">' + esc(tr("Loading")) + "</p></div>";
    bindSort();
    if (view !== "main") loadKnown();
    if (view === "name" && !findName(openHandle)) view = "main";
    var body = view === "name" ? nameHtml(x, findName(openHandle)) : view === "mentions" ? mentionsPage(x) : view === "order" ? orderPage(x) : mainHtml(x);
    return '<div class="un-in-edit xs-page" data-un-view="' + esc(view) + '">' + body + "</div>";
  }

  /* Settings > Usernames: a shortcut into Edit profile > Usernames, then
     the private nicknames you give other people. */
  function settingsHtml() {
    ready();
    var shortcut = '<a class="set-row un-shortcut" href="#/settings/usernames" data-acct="edit-usernames"><span class="set-copy"><b>' + esc(tr("Your usernames")) + '</b><span class="set-sub">' + esc(tr("Edit them in Edit profile: who sees which one, Preview as and who can mention you.")) + '</span></span><span class="set-chev" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14.586 12 7.543 4.96l1.414-1.42L17.414 12l-8.457 8.46-1.414-1.42z"/></svg></span></a>';
    var nicks = nicknames.map(function (n) {
      return '<div class="un-row"><span>@' + esc(n.handle) + " · " + esc(n.name) + '</span><button type="button" class="un-btn outline" data-un="nick-clear" data-handle="' + esc(n.handle) + '">' + esc(tr("Remove")) + "</button></div>";
    }).join("");
    return '<div class="un-settings"><h2>' + esc(tr("Usernames")) + "</h2>" + shortcut +
      (note && !document.querySelector(".un-in-edit") ? '<p class="un-note" role="alert">' + esc(note) + "</p>" : "") +
      "<h2>" + esc(tr("Your nicknames for others")) + "</h2>" +
      '<p class="phandle">' + esc(tr("Only you see these.")) + "</p>" + nicks +
      '<div class="un-row"><input class="un-input" data-un-nick-handle aria-label="' + esc(tr("Account")) + '" placeholder="@name"><input class="un-input" data-un-nick-name maxlength="50" aria-label="' + esc(tr("Nickname")) + '" placeholder="' + esc(tr("Nickname")) + '"><button type="button" class="un-btn" data-un="nick-set">' + esc(tr("Save")) + "</button></div>" +
      "</div>";
  }

  function orderedLists() {
    var order = (data && data.listOrder) || [];
    var rank = function (id) { var at = order.indexOf(id); return at < 0 ? order.length : at; };
    return lists.slice().sort(function (a, b) { return rank(a.id) - rank(b.id); });
  }

  function people(text) {
    return String(text || "").split(/[\s,]+/).map(function (p) { return p.replace(/^@/, ""); }).filter(Boolean);
  }

  function apply(res) {
    if (said(res)) { settle(); if (res.names) data = res; redraw(); }
    return res;
  }

  function value(sel) {
    var el = document.querySelector(sel);
    return el ? el.value : "";
  }

  function saved() { var x = XS(); if (x) x.toast(tr("Saved")); }

  /* ---------- saving on their own ---------- */
  function setAudience(handle, aud, quiet) {
    pending[handle] = cleanAudience(aud);
    pendingRev[handle] = (pendingRev[handle] || 0) + 1;
    var rev = pendingRev[handle];
    note = "";
    redraw();
    clearTimeout(saveTimers[handle]);
    saveTimers[handle] = setTimeout(function () {
      call("/v1/usernames", { method: "PATCH", body: { handle: handle, audience: pending[handle] } }).then(function (res) {
        if (pendingRev[handle] !== rev) return;
        delete pending[handle];
        if (said(res)) { if (res.names) data = res; redraw(); if (!quiet) saved(); }
        else redraw();
      });
    }, 450);
  }
  function editAudience(handle, fn) {
    var name = findName(handle);
    if (!name) return;
    var a = audOf(name);
    fn(a);
    setAudience(handle, a);
  }
  var mentionsRev = 0;
  function saveMentions(next) {
    var before = mentionRules();
    mentions = next;
    note = "";
    redraw();
    var body = { public: next.public || "anyone", followers: next.followers || "", friends: next.friends || "", lists: {}, allow: (next.allow || []).slice(), block: (next.block || []).slice() };
    Object.keys(next.lists || {}).forEach(function (k) { if (next.lists[k]) body.lists[k] = next.lists[k]; });
    var rev = ++mentionsRev;
    call("/v1/usernames/mentions", { method: "PUT", body: body }).then(function (res) {
      if (rev !== mentionsRev) return;
      if (said(res)) { settle(); mentions = res; redraw(); saved(); }
      else { mentions = before; redraw(); }
    });
  }
  function copyMentions() {
    var m = mentionRules();
    return { public: m.public || "anyone", followers: m.followers || "", friends: m.friends || "", lists: Object.assign({}, m.lists || {}), allow: (m.allow || []).slice(), block: (m.block || []).slice() };
  }

  /* ---------- chips ---------- */
  function chipHandles(key) {
    if (key === "inc" || key === "exc") {
      var name = findName(openHandle);
      if (!name) return [];
      return audOf(name)[key === "inc" ? "include" : "exclude"].people;
    }
    if (key === "allow" || key === "block") return mentionRules()[key] || [];
    return [];
  }
  function addPerson(key, raw) {
    var handle = String(raw || "").trim().replace(/^@/, "");
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return;
    focusKey = key;
    delete chipDraft[key];
    if (key === "pv") { previewPerson(handle); return; }
    if (key === "inc" || key === "exc") {
      editAudience(openHandle, function (a) {
        var side = a[key === "inc" ? "include" : "exclude"];
        if (side.people.map(function (p) { return p.toLowerCase(); }).indexOf(handle.toLowerCase()) < 0) side.people.push(handle);
      });
      return;
    }
    if (key === "allow" || key === "block") {
      var next = copyMentions();
      if (next[key].map(function (p) { return p.toLowerCase(); }).indexOf(handle.toLowerCase()) < 0) next[key].push(handle);
      saveMentions(next);
    }
  }
  function dropPerson(key, handle) {
    if (key === "inc" || key === "exc") {
      editAudience(openHandle, function (a) {
        var side = a[key === "inc" ? "include" : "exclude"];
        side.people = side.people.filter(function (p) { return p !== handle; });
      });
      return;
    }
    if (key === "allow" || key === "block") {
      var next = copyMentions();
      next[key] = next[key].filter(function (p) { return p !== handle; });
      saveMentions(next);
    }
  }
  function previewPerson(handle) {
    var forName = openHandle;
    call("/v1/usernames/preview?as=" + encodeURIComponent(handle)).then(function (res) {
      if (res && res.status === 200) { inline = { handle: forName, label: personLabel(handle), sees: res.handle, hidden: !!res.hidden }; note = ""; }
      else { inline = null; note = tr("No account found."); }
      redraw();
    });
  }

  /* ---------- sheets ---------- */
  function audienceSheet(handle) {
    var x = XS();
    var name = findName(handle);
    if (!x || !name) return;
    var cur = presetOf(audOf(name));
    var opts = [
      { value: "public", label: tr("Everyone"), sub: tr("Anyone without a more specific username.") },
      { value: "followers", label: tr("Followers"), sub: tr("People who follow you.") },
      { value: "friends", label: tr("Friends"), sub: tr("People you're friends with.") }
    ];
    if (lists.length) opts.push({ value: "lists", label: tr("Lists"), sub: tr("Only people in the lists you pick.") });
    opts.push({ value: "people", label: tr("Specific people"), sub: tr("Only the people you add.") });
    if (cur === "custom") opts.push({ value: "custom", label: tr("Custom"), sub: tr("A mix, set below.") });
    x.sheet.radio({ title: tr("Who sees @{handle}?", { handle: handle }), sub: tr("Start with a preset, then fine-tune below."), options: opts, current: cur, onPick: function (v) {
      if (v === "custom" || v === cur) return;
      var before = audOf(name);
      var a = audOf(name);
      a.include.public = v === "public";
      a.include.followers = v === "followers";
      a.include.friends = v === "friends";
      a.include.lists = v === "lists" ? (before.include.lists.length ? before.include.lists : lists.slice(0, 1).map(function (l) { return l.id; })) : [];
      a.include.people = v === "people" ? before.include.people : [];
      setAudience(handle, a, true);
      if (v === "people" && !a.include.people.length) focusKey = "inc";
      x.toast(tr("Audience set to {name}", { name: presetLabel(v) }), { undo: function () { setAudience(handle, before, true); } });
    } });
  }
  function nameMenu(handle) {
    var x = XS();
    var name = findName(handle);
    if (!x || !name) return;
    var others = ((data && data.names) || []).filter(function (n) { return n.handle !== handle && !removing[n.handle]; });
    x.sheet.menu({ title: "@" + handle, sub: plainWho(audOf(name)), items: [
      { label: tr("Change audience"), icon: "people", pick: function () { go("name", handle); } },
      name.primary ? null : { label: tr("Make primary"), icon: "star", pick: function () { makePrimary(handle); } },
      others.length ? { label: tr("Copy audience from another username"), icon: "copy", pick: function () { copyFrom(handle); } } : null,
      name.primary ? null : { label: tr("Remove username"), icon: "trash", danger: true, pick: function () { removeName(handle); } }
    ] });
  }
  function copyFrom(handle) {
    var x = XS();
    var name = findName(handle);
    if (!x || !name) return;
    var others = ((data && data.names) || []).filter(function (n) { return n.handle !== handle && !removing[n.handle]; });
    x.sheet.radio({ title: tr("Copy audience from"), sub: tr("@{handle} gets the same audience.", { handle: handle }), options: others.map(function (n) { return { value: n.handle, label: "@" + n.handle, sub: plainWho(audOf(n)) }; }), current: "", onPick: function (v) {
      var src = findName(v);
      if (!src) return;
      var before = audOf(name);
      setAudience(handle, audOf(src), true);
      x.toast(tr("Copied audience from @{handle}", { handle: v }), { undo: function () { setAudience(handle, before, true); } });
    } });
  }
  function makePrimary(handle) {
    call("/v1/usernames/primary", { method: "POST", body: { handle: handle } }).then(function (res) {
      if (said(res)) { settle(); if (res.names) data = res; redraw(); var x = XS(); if (x) x.toast(tr("@{handle} is now your primary username", { handle: handle })); }
    });
  }
  function removeName(handle) {
    var x = XS();
    removing[handle] = true;
    if (view === "name" && openHandle === handle) { view = "main"; openHandle = ""; }
    redraw();
    var commit = function () {
      call("/v1/usernames", { method: "DELETE", body: { handle: handle } }).then(function (res) {
        delete removing[handle];
        apply(res);
      });
    };
    if (!x) { commit(); return; }
    x.toast(tr("@{handle} removed", { handle: handle }), { undo: function () { delete removing[handle]; redraw(); }, commit: commit });
  }
  function addSheet() {
    var x = XS();
    if (!x) return;
    var err = "";
    var typed = "";
    var busy = false;
    var sheet = x.sheet.open({
      title: tr("Add username"), sub: tr("Letters, numbers and underscores, up to 15."),
      body: function () {
        return x.field({ label: tr("New username"), value: typed, maxlength: 15, counter: true, error: err, attrs: 'data-un-new data-xs-keep="new" autofocus inputmode="text" enterkeyhint="done"' }) +
          '<div class="xs-actions">' + x.pill(tr("Add"), 'data-xs-add' + (busy ? " disabled" : "")) + "</div>";
      },
      onInput: function (el) { if (el.hasAttribute("data-un-new")) typed = el.value; },
      onKey: function (event) { if (event.key === "Enter" && event.target.hasAttribute && event.target.hasAttribute("data-un-new")) { event.preventDefault(); submit(); } },
      onClick: function (el) { if (el.hasAttribute("data-xs-add")) submit(); return false; }
    });
    function submit() {
      var fresh = typed.replace(/^@/, "").trim();
      if (!fresh || busy) return;
      busy = true;
      sheet.paint();
      call("/v1/usernames", { method: "POST", body: { handle: fresh, audience: { include: { followers: true } } } }).then(function (res) {
        busy = false;
        if (res && res.status === 201) {
          note = "";
          if (res.names) data = res;
          sheet.close();
          go("name", fresh);
          x.toast(tr("Saved"));
          return;
        }
        var code = res && (res.error || (res.status === 429 ? "rate_limited" : ""));
        err = errorText(code);
        sheet.paint();
      });
    }
  }
  function previewSheet() {
    var x = XS();
    if (!x) return;
    loadKnown();
    var result = null;
    var cur = "";
    var opts = [["public", tr("Public")], ["followers", tr("Followers")], ["friends", tr("Friends")]].concat(lists.map(function (list) { return ["list:" + list.id, listName(list.id)]; }));
    var sheet = x.sheet.open({
      title: tr("Preview as"), sub: tr("See which username someone gets."),
      body: function () {
        return (result ? '<p class="xs-result un-preview-out" role="status">' + esc(result) + "</p>" : "") +
          '<div role="radiogroup">' + opts.map(function (o) { return x.radio({ title: o[1], on: cur === o[0], attrs: 'data-xs-opt="' + esc(o[0]) + '"' }); }).join("") + "</div>" +
          x.chips({ key: "pvs", items: [], placeholder: tr("Preview as someone") });
      },
      onClick: function (el) {
        if (el.hasAttribute("data-xs-opt")) { cur = el.getAttribute("data-xs-opt"); ask(cur, el.querySelector(".xs-title") ? el.querySelector(".xs-title").textContent : cur); }
        else if (el.hasAttribute("data-xs-pick")) { cur = ""; ask(el.getAttribute("data-value"), personLabel(el.getAttribute("data-value"))); }
        return false;
      },
      onInput: function (el) { if (el.getAttribute("data-xs-chip-input") === "pvs") x.suggest("pvs", el.value, known, []); },
      onKey: function (event) {
        var t = event.target;
        if (event.key === "Enter" && t.getAttribute && t.getAttribute("data-xs-chip-input") === "pvs") { event.preventDefault(); var h = t.value.trim().replace(/^@/, ""); if (h) { cur = ""; ask(h, personLabel(h)); } }
      }
    });
    function ask(as, label) {
      call("/v1/usernames/preview?as=" + encodeURIComponent(as)).then(function (res) {
        if (res && res.status === 200) result = res.hidden ? tr("{name} sees no username.", { name: label }) : tr("{name} sees @{handle}", { name: label, handle: res.handle });
        else result = tr("No account found.");
        sheet.paint();
      });
    }
  }
  function mentionSheet(key) {
    var x = XS();
    if (!x) return;
    var m = mentionRules();
    var isList = key.indexOf("list:") === 0;
    var current = isList ? (m.lists || {})[key.slice(5)] || "" : m[key] || (key === "public" ? "anyone" : "");
    var title = key === "public" ? tr("Everyone") : key === "followers" ? tr("Followers") : key === "friends" ? tr("Friends") : listName(key.slice(5));
    var opts = (key === "public" ? [] : [{ value: "", label: tr("Same as broader audience") }]).concat([
      { value: "anyone", label: tr("Anyone") }, { value: "replies", label: tr("Only in replies to me") }, { value: "nobody", label: tr("No one") }]);
    x.sheet.radio({ title: tr("Who can mention you"), sub: title, options: opts, current: current, onPick: function (v) {
      var next = copyMentions();
      if (isList) { if (v) next.lists[key.slice(5)] = v; else delete next.lists[key.slice(5)]; }
      else next[key] = v;
      saveMentions(next);
    } });
  }

  function onClick(event) {
    var t = event.target;
    if (!t || !t.closest) return;
    var page = t.closest(".un-in-edit");
    /* Back from a detail screen goes to the Usernames list first. */
    var back = t.closest('[data-acct="edit-back"]');
    if (back && view !== "main" && document.querySelector(".ep .un-in-edit")) {
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      go("main");
      return;
    }
    if (t.closest('[data-acct="edit-usernames"], [data-acct="edit-sub"][data-sub="usernames"], [data-acct="close"]') || back) { view = "main"; openHandle = ""; inline = null; }
    if (page) {
      var rm = t.closest("[data-xs-chip-remove]");
      if (rm) { event.preventDefault(); dropPerson(rm.getAttribute("data-xs-chip-remove"), rm.getAttribute("data-value")); return; }
      var pick = t.closest("[data-xs-pick]");
      if (pick) { event.preventDefault(); addPerson(pick.getAttribute("data-xs-pick"), pick.getAttribute("data-value")); return; }
    }
    var el = t.closest("[data-un]");
    if (!el) return;
    event.preventDefault();
    var act = el.getAttribute("data-un");
    var handle = el.getAttribute("data-handle") || "";
    if (act === "open-name") { go("name", handle); return; }
    if (act === "open-mentions") { go("mentions"); return; }
    if (act === "open-order") { go("order"); return; }
    if (act === "name-menu") { nameMenu(handle); return; }
    if (act === "add-sheet") { addSheet(); return; }
    if (act === "preview-sheet") { previewSheet(); return; }
    if (act === "aud-sheet") { audienceSheet(handle); return; }
    if (act === "copy-from") { copyFrom(handle); return; }
    if (act === "m-sheet") { mentionSheet(el.getAttribute("data-key") || "public"); return; }
    if (act === "toggle-hide") { hideOpen = !hideOpen; redraw(); return; }
    if (act === "toggle-advanced") { advancedOpen = !advancedOpen; redraw(); return; }
    if (act === "primary") { makePrimary(handle); return; }
    if (act === "remove") { removeName(handle); return; }
    if (act === "nick-set" || act === "nick-clear") {
      var who = act === "nick-set" ? value("[data-un-nick-handle]").replace(/^@/, "") : handle;
      var name = act === "nick-set" ? value("[data-un-nick-name]") : "";
      call("/v1/nicknames", { method: "PUT", body: { handle: who, name: name } }).then(function (res) {
        if (res && res.status === 404) { note = tr("No account found."); redraw(); return; }
        if (said(res)) { settle(); load(); }
      });
      return;
    }
  }

  function onChange(event) {
    var el = event.target;
    if (!el || !el.getAttribute || !el.closest || !el.closest(".un-in-edit")) return;
    var key = el.getAttribute("data-un-aud");
    if (!key) return;
    var side = key.slice(0, 3) === "inc" ? "include" : "exclude";
    var what = key.slice(4);
    var on = !!el.checked;
    editAudience(openHandle, function (a) {
      if (what.indexOf("list:") === 0) {
        var id = what.slice(5);
        a[side].lists = a[side].lists.filter(function (l) { return l !== id; });
        if (on) a[side].lists.push(id);
      } else a[side][what] = on;
    });
  }
  function onInput(event) {
    var el = event.target;
    if (!el || !el.getAttribute || !el.closest || !el.closest(".un-in-edit")) return;
    var key = el.getAttribute("data-xs-chip-input");
    var x = XS();
    if (key) chipDraft[key] = el.value;
    if (key && x) x.suggest(key, el.value, known, chipHandles(key));
  }
  function onKey(event) {
    var el = event.target;
    if (event.key !== "Enter" || !el || !el.getAttribute || !el.closest || !el.closest(".un-in-edit")) return;
    var key = el.getAttribute("data-xs-chip-input");
    if (!key || !el.value.trim()) return;
    event.preventDefault();
    addPerson(key, el.value);
  }
  function onScroll(event) {
    var el = event.target;
    if (el && el.classList && el.classList.contains("acct-edit-body") && el.querySelector && el.querySelector(".un-in-edit")) scrollMem[viewKey()] = el.scrollTop;
  }

  if (typeof window !== "undefined") window.addEventListener("click", onClick, true);
  if (typeof document !== "undefined") {
    document.addEventListener("input", keep, true);
    document.addEventListener("change", keep, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("pagehide", function () { var x = XS(); if (x) x.flushUndo(); });
  }
  var sortBound = false;
  function bindSort() {
    var x = XS();
    if (sortBound || !x || !x.onSort) return;
    sortBound = true;
    x.onSort("un-lists", function (ids) { call("/v1/usernames/order", { method: "PUT", body: { lists: ids } }).then(function (res) { if (said(res)) { apply(res); saved(); } }); });
  }

  root.ViktorychUsernames = {
    bind: function (next) { deps = next || {}; },
    settingsHtml: settingsHtml,
    profileHtml: profileHtml,
    names: function () { return data ? (data.names || []) : null; },
    watch: function (fn) { if (typeof fn === "function" && watchers.indexOf(fn) < 0) watchers.push(fn); },
    load: load
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
