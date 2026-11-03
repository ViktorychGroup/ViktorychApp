/* Who can see each friendship (Settings > Privacy > Friends > Each friendship).

   One row per friend with a plain-words summary. A row opens a detail screen
   with presets, show-to / hide-from chips with search, a live sentence and an
   inline "Preview as". Select lets one rule go to several friends. Every
   change saves at once and the toast offers Undo.

   The server enforces everything (worker/src/friend-privacy.js): a third
   person sees a friendship only when both friends' rules allow it. Preview
   as only applies your own side, so it never reveals your friend's choice. */
(function (root) {
  "use strict";

  var API = "/v1/friends/privacy";
  var data = null;          // { listAudience, friendsOn, friends:[{handle,name,avatar,rule}], lists }
  var people = [];          // followers and friends, for chips
  var loading = false;
  var loadedAt = 0;
  var failed = false;
  var ui = { query: "", selecting: false, picked: {}, bulk: null, chipFor: "", chipQuery: "", previewAs: "", preview: null, previewBusy: false, error: "" };
  var undoTimer = 0;

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
  function token() { var a = accounts(); return a && a.token ? a.token() : ""; }
  function call(path, opts) {
    var a = accounts();
    if (!a || !a.call || !token()) return Promise.resolve({ status: 401 });
    var next = opts || {};
    next.token = token();
    return a.call(path, next);
  }
  function redraw() { var a = accounts(); if (a && a.requestRender) a.requestRender(); }
  /* Called while the app builds the page: a chip search box being typed in
     keeps its text, focus and caret across any re-render (a save or a
     friends refresh answering mid-typing must not steal them). */
  function keepChipFocus() {
    var doc = root.document;
    var act = doc && doc.activeElement;
    var kind = act && act.getAttribute ? act.getAttribute("data-fpv-chip") : "";
    if (!kind) return;
    var pos = 0;
    try { pos = act.selectionStart || 0; } catch (err) { pos = 0; }
    ui.chipFor = kind;
    ui.chipQuery = act.value;
    Promise.resolve().then(function () {
      var again = doc.querySelector('[data-fpv-chip="' + kind + '"]');
      if (!again || again === doc.activeElement) return;
      again.focus();
      try { again.setSelectionRange(pos, pos); } catch (err) { /* not a text box */ }
    });
  }
  function clean(handle) { return String(handle || "").replace(/^@/, "").toLowerCase(); }

  function load(force) {
    if (loading) return Promise.resolve(data);
    if (!force && data && Date.now() - loadedAt < 30000) return Promise.resolve(data);
    if (!force && failed && Date.now() - loadedAt < 15000) return Promise.resolve(data);
    if (!token()) return Promise.resolve(null);
    loading = true;
    loadedAt = Date.now();
    return Promise.all([call(API), call("/v1/audience-lists/people")]).then(function (got) {
      loading = false;
      failed = !(got[0] && got[0].status === 200);
      if (!failed) data = got[0];
      if (got[1] && got[1].status === 200) people = got[1].people || [];
      redraw();
      return data;
    }).catch(function () { loading = false; failed = true; redraw(); return data; });
  }

  function friends() { return (data && data.friends) || []; }
  function friendOf(handle) {
    var h = clean(handle);
    var list = friends();
    for (var i = 0; i < list.length; i++) if (clean(list[i].handle) === h) return list[i];
    return null;
  }
  function nameOf(handle) {
    var h = clean(handle);
    var f = friendOf(h);
    if (f) return f.name || "@" + f.handle;
    for (var i = 0; i < people.length; i++) if (clean(people[i].handle) === h) return people[i].name || "@" + people[i].handle;
    return "@" + h;
  }
  function listName(id) {
    var lists = (data && data.lists) || [];
    for (var i = 0; i < lists.length; i++) if (lists[i].id === id) return (lists[i].icon ? lists[i].icon + " " : "") + lists[i].name;
    return "";
  }

  /* ---------- rules ---------- */

  function blankAudience() { return { include: { public: false, followers: false, friends: false, lists: [], people: [] }, exclude: { people: [] } }; }
  function audienceOf(rule) {
    var out = blankAudience();
    var a = (rule && rule.audience) || {};
    var inc = a.include || {};
    var exc = a.exclude || {};
    out.include.public = !!inc.public;
    out.include.followers = !!inc.followers;
    out.include.friends = !!inc.friends;
    out.include.lists = (inc.lists || []).slice();
    out.include.people = (inc.people || []).map(clean);
    out.exclude.people = (exc.people || []).map(clean);
    return out;
  }
  function copyRule(rule) {
    if (!rule || rule.mode === "inherit" || !rule.mode) return { mode: "inherit" };
    if (rule.mode === "hidden") return { mode: "hidden" };
    return { mode: "custom", audience: audienceOf(rule) };
  }
  function sameRule(a, b) { return JSON.stringify(copyRule(a)) === JSON.stringify(copyRule(b)); }

  /* Which preset a rule reads as. */
  function presetOf(rule) {
    var r = copyRule(rule);
    if (r.mode === "inherit") return "inherit";
    if (r.mode === "hidden") return "me";
    var inc = r.audience.include;
    if (inc.public) return "everyone";
    if (inc.friends) return "friends";
    if (inc.followers) return "followers";
    if (inc.lists.length) return "lists";
    if (inc.people.length) return "people";
    return "me";
  }
  function ruleForPreset(preset, from) {
    var keep = copyRule(from);
    var aud = keep.mode === "custom" ? keep.audience : blankAudience();
    var out = blankAudience();
    out.exclude.people = aud.exclude.people.slice();
    out.include.people = aud.include.people.slice();
    if (preset === "inherit") return { mode: "inherit" };
    if (preset === "me") return { mode: "hidden" };
    if (preset === "everyone") out.include.public = true;
    if (preset === "friends") out.include.friends = true;
    if (preset === "followers") out.include.followers = true;
    if (preset === "lists") {
      out.include.lists = aud.include.lists.slice();
      var lists = (data && data.lists) || [];
      if (!out.include.lists.length && lists.length) out.include.lists = [lists[0].id];
    }
    if (preset === "people") out.exclude.people = []; // hide-from only narrows a wider audience
    return { mode: "custom", audience: out };
  }

  function joinNames(names) {
    if (!names.length) return "";
    if (names.length === 1) return names[0];
    if (names.length === 2) return tr("{a} and {b}", { a: names[0], b: names[1] });
    if (names.length === 3) return tr("{a}, {b} and {c}", { a: names[0], b: names[1], c: names[2] });
    return tr("{a}, {b} and {n} others", { a: names[0], b: names[1], n: String(names.length - 2) });
  }
  function listWord() {
    var la = data && data.listAudience;
    if (la === "friends") return tr("Friends");
    if (la === "me") return tr("Only you");
    return tr("Everyone");
  }
  /* The plain words after "Visible to:". */
  function whoText(rule) {
    var r = copyRule(rule);
    if (r.mode === "inherit") return tr("{who} (same as your friends list)", { who: listWord() });
    if (r.mode === "hidden") return tr("Only you");
    var inc = r.audience.include;
    var tiers = [];
    if (inc.public) tiers.push(tr("Everyone"));
    else {
      if (inc.friends) tiers.push(tr("Friends"));
      if (inc.followers) tiers.push(tr("Followers"));
      inc.lists.forEach(function (id) { var n = listName(id); if (n) tiers.push(n); });
    }
    var names = inc.people.map(nameOf);
    var who;
    if (!tiers.length && !names.length) who = tr("Only you");
    else if (!tiers.length) who = tr("{who} only", { who: joinNames(names) });
    else who = joinNames(tiers.concat(names));
    var hidden = r.audience.exclude.people.map(nameOf);
    if (hidden.length && tiers.length) who = tr("{who}, except {not}", { who: who, not: joinNames(hidden) });
    return who;
  }
  function rowSummary(rule) { return tr("Visible to: {who}", { who: whoText(rule) }); }
  function sentence(rule, friendName) {
    return tr("People who can see that you and {name} are friends: {who}.", { name: friendName, who: whoText(rule) });
  }

  /* ---------- saving ---------- */

  function toast(message, undo) {
    var el = root.document && root.document.getElementById("toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = "";
    var text = root.document.createElement("span");
    text.textContent = message;
    el.appendChild(text);
    if (undo) {
      var b = root.document.createElement("button");
      b.type = "button";
      b.className = "toast-act";
      b.setAttribute("data-fpv-undo", "1");
      b.textContent = tr("Undo");
      b.addEventListener("click", function (event) {
        event.stopPropagation();
        el.hidden = true;
        clearTimeout(undoTimer);
        undo();
      });
      el.appendChild(b);
    }
    clearTimeout(undoTimer);
    undoTimer = setTimeout(function () { el.hidden = true; }, 6000);
  }

  /* Saves one rule for these handles. Groups previous rules so Undo puts
     every friend back the way they were. */
  function save(handles, rule, quiet) {
    var list = handles.map(clean).filter(function (h) { return !!friendOf(h); });
    if (!list.length) return Promise.resolve(false);
    var before = list.map(function (h) { return { handle: h, rule: copyRule(friendOf(h).rule) }; });
    var next = copyRule(rule);
    list.forEach(function (h) { friendOf(h).rule = copyRule(next); });
    ui.error = "";
    ui.preview = null;
    redraw();
    return put(list, next).then(function (ok) {
      if (!ok) {
        before.forEach(function (b) { var f = friendOf(b.handle); if (f) f.rule = b.rule; });
        ui.error = tr("Couldn’t save. Try again.");
        redraw();
        return false;
      }
      if (!quiet) {
        toast(list.length > 1 ? tr("Saved for {n} friends", { n: String(list.length) }) : tr("Saved"), function () {
          var groups = {};
          before.forEach(function (b) {
            var key = JSON.stringify(b.rule);
            (groups[key] = groups[key] || { rule: b.rule, handles: [] }).handles.push(b.handle);
          });
          Object.keys(groups).forEach(function (key) {
            groups[key].handles.forEach(function (h) { var f = friendOf(h); if (f) f.rule = copyRule(groups[key].rule); });
            put(groups[key].handles, groups[key].rule);
          });
          ui.preview = null;
          redraw();
          toast(tr("Change undone"));
        });
      }
      refreshPreview();
      return true;
    });
  }
  function put(handles, rule) {
    return call(API, { method: "PUT", body: { handles: handles, rule: rule } }).then(function (res) {
      if (res && res.status === 200) {
        var a = accounts();
        if (a && a.refreshFriends) a.refreshFriends();
        return true;
      }
      return false;
    }).catch(function () { return false; });
  }

  /* ---------- preview ---------- */

  function previewOptions() {
    var out = [["public", tr("Someone who isn’t following you")], ["followers", tr("A follower")], ["friends", tr("A friend")]];
    ((data && data.lists) || []).forEach(function (l) { out.push(["list:" + l.id, tr("Someone in {list}", { list: (l.icon ? l.icon + " " : "") + l.name })]); });
    return out;
  }
  function runPreview(as) {
    ui.previewAs = as;
    if (!as) { ui.preview = null; redraw(); return; }
    ui.previewBusy = true;
    redraw();
    call(API + "/preview?as=" + encodeURIComponent(as)).then(function (res) {
      ui.previewBusy = false;
      if (ui.previewAs !== as) return;
      ui.preview = res && res.status === 200 ? { as: as, visible: (res.visible || []).map(clean), count: res.count || 0, total: res.total || 0 } : { as: as, missing: true };
      redraw();
    }).catch(function () { ui.previewBusy = false; redraw(); });
  }
  function refreshPreview() { if (ui.previewAs) runPreview(ui.previewAs); }
  function previewLabel(as) {
    var opts = previewOptions();
    for (var i = 0; i < opts.length; i++) if (opts[i][0] === as) return opts[i][1];
    return nameOf(as);
  }

  function previewHtml(focus) {
    var opts = previewOptions().map(function (o) {
      return '<option value="' + esc(o[0]) + '"' + (ui.previewAs === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>";
    }).join("");
    var person = ui.previewAs && !/^(public|followers|friends|list:)/.test(ui.previewAs);
    var out = '<section class="fpv-preview" aria-live="polite"><div class="fpv-preview-head">' + eye() +
      "<b>" + esc(tr("Preview as")) + '</b><span class="fpv-tag">' + esc(tr("Your side only")) + "</span></div>" +
      '<label class="fpv-select"><span class="fpv-sr">' + esc(tr("Preview as")) + '</span><select data-fpv-preview="1"><option value="">' + esc(tr("Choose someone…")) + "</option>" + opts +
      (person ? '<option value="' + esc(ui.previewAs) + '" selected>' + esc(nameOf(ui.previewAs)) + "</option>" : "") + "</select></label>" +
      '<form class="fpv-preview-person" data-fpv-preview-form="1"><input type="text" name="as" autocomplete="off" placeholder="' + esc(tr("Or a username")) + '" aria-label="' + esc(tr("Preview as a username")) + '" maxlength="40"><button class="outline" type="submit">' + esc(tr("Preview")) + "</button></form>";
    var p = ui.preview;
    if (ui.previewBusy) out += '<p class="fpv-preview-out">' + esc(tr("Checking…")) + "</p>";
    else if (p && p.missing) out += '<p class="fpv-preview-out">' + esc(tr("No account with that username.")) + "</p>";
    else if (p) {
      var who = previewLabel(p.as);
      if (focus) {
        var sees = p.visible.indexOf(clean(focus)) >= 0;
        out += '<p class="fpv-preview-out ' + (sees ? "yes" : "no") + '">' + esc(sees
          ? tr("{who} would see that you’re friends with {name}.", { who: who, name: nameOf(focus) })
          : tr("{who} would not see that you’re friends with {name}.", { who: who, name: nameOf(focus) })) + "</p>";
      } else {
        out += '<p class="fpv-preview-out">' + esc(tr("{who} would see {n} of your {total} friends.", { who: who, n: String(p.count), total: String(p.total) })) + "</p>";
        var shown = p.visible.slice(0, 12).map(function (h) { return '<li>' + esc(nameOf(h)) + "</li>"; }).join("");
        if (shown) out += '<ul class="fpv-preview-list">' + shown + "</ul>";
      }
    }
    out += '<p class="fpv-note">' + esc(tr("Preview uses only your settings. Your friend’s own setting can hide it too, and isn’t shown here.")) + "</p></section>";
    return out;
  }

  /* ---------- html ---------- */

  function eye() { return '<svg class="fpv-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>'; }
  function chev() { return '<svg class="fpv-chev" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.586 12L7.543 4.96l1.414-1.42L17.414 12l-8.457 8.46-1.414-1.42L14.586 12z"/></svg>'; }
  function avatar(f) {
    var src = f && f.avatar && /^(https?:|data:image\/|\/|\.\/)/.test(f.avatar) ? f.avatar : "";
    var letter = esc(String((f && (f.name || f.handle)) || "?").charAt(0).toUpperCase());
    return src ? '<img class="fpv-ava" src="' + esc(src) + '" alt="" loading="lazy">' : '<span class="fpv-ava initials" aria-hidden="true">' + letter + "</span>";
  }
  function head(title, back) {
    return '<div class="fpv-head"><a class="fpv-back" href="' + back + '" aria-label="' + esc(tr("Back")) + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z"/></svg></a><h2>' + esc(title) + "</h2></div>";
  }
  function stateHtml() {
    if (!token()) return '<p class="phandle">' + esc(tr("Sign in to choose who sees your friendships.")) + "</p>";
    if (!data) {
      load(false);
      return '<p class="phandle">' + esc(failed ? tr("Couldn’t load your friends. Try again.") : tr("Loading…")) + "</p>";
    }
    if (data.friendsOn === false) return '<p class="phandle">' + esc(tr("Friends is off, so nobody sees any of your friendships.")) + "</p>";
    return "";
  }

  /* Settings > Privacy > Friends: one row that opens the per-friend list. */
  function entryHtml() {
    var n = data ? friends().filter(function (f) { return copyRule(f.rule).mode !== "inherit"; }).length : 0;
    var sub = !data ? tr("Choose who sees each of your friendships") : n ? tr("{n} friendships have their own setting", { n: String(n) }) : tr("All follow your friends list setting");
    return '<a class="set-row fpv-entry" href="#/settings/friendship"><span class="set-copy"><b>' + esc(tr("Who can see each friendship")) + '</b><span class="set-sub">' + esc(sub) + '</span></span><span class="set-chev" aria-hidden="true">' + chev() + "</span></a>";
  }

  function listHtml() {
    var gate = stateHtml();
    if (gate) return '<div class="fpv">' + gate + "</div>";
    if (Date.now() - loadedAt > 30000) load(false);
    var all = friends();
    var q = ui.query.trim().toLowerCase();
    var shown = q ? all.filter(function (f) { return String(f.name || "").toLowerCase().indexOf(q) >= 0 || clean(f.handle).indexOf(q.replace(/^@/, "")) >= 0; }) : all;
    var picked = Object.keys(ui.picked).filter(function (h) { return ui.picked[h] && friendOf(h); });
    var out = '<p class="fpv-lead">' + esc(tr("Choose who can see that you’re friends with each person. Both of you have to allow it, or nobody else sees it.")) + "</p>";
    out += '<div class="fpv-tools"><label class="fpv-search"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.25 3.75a6.5 6.5 0 100 13 6.5 6.5 0 000-13zm-8.5 6.5a8.5 8.5 0 1114.86 5.66l4.47 4.46-1.42 1.42-4.46-4.47A8.5 8.5 0 011.75 10.25z"/></svg><input type="search" data-fpv-filter="1" value="' + esc(ui.query) + '" placeholder="' + esc(tr("Search friends")) + '" aria-label="' + esc(tr("Search friends")) + '"></label>' +
      (all.length ? '<button class="fpv-link" type="button" data-fpv="select">' + esc(ui.selecting ? tr("Done") : tr("Select")) + "</button>" : "") + "</div>";
    if (!all.length) out += '<p class="phandle">' + esc(tr("When you have friends, you can choose who sees each friendship here.")) + "</p>";
    else if (!shown.length) out += '<p class="phandle">' + esc(tr("No friends match your search.")) + "</p>";
    out += '<div class="fpv-rows" role="list">' + shown.map(function (f) {
      var h = clean(f.handle);
      var on = !!ui.picked[h];
      var own = copyRule(f.rule).mode !== "inherit";
      var body = avatar(f) + '<span class="fpv-copy"><b>' + esc(f.name || "@" + f.handle) + '</b><span class="fpv-at">@' + esc(f.handle) + '</span><span class="fpv-sum' + (own ? " own" : "") + '">' + esc(rowSummary(f.rule)) + "</span></span>";
      if (ui.selecting) {
        return '<button class="fpv-row" role="listitem" type="button" data-fpv="pick" data-handle="' + esc(h) + '" aria-pressed="' + (on ? "true" : "false") + '"><span class="fpv-check' + (on ? " on" : "") + '" aria-hidden="true"></span>' + body + "</button>";
      }
      return '<a class="fpv-row" role="listitem" href="#/settings/friendship/' + encodeURIComponent(h) + '">' + body + chev() + "</a>";
    }).join("") + "</div>";
    if (ui.selecting) {
      out += '<div class="fpv-bulkbar"><span>' + esc(tr("{n} selected", { n: String(picked.length) })) + '</span><button class="fpv-link" type="button" data-fpv="pick-all">' + esc(tr("Select all")) + '</button><button class="primary" type="button" data-fpv="bulk"' + (picked.length ? "" : " disabled") + ">" + esc(tr("Choose who can see")) + "</button></div>";
    }
    if (all.length) out += previewHtml("");
    if (ui.error) out += '<p class="phandle fp-error" role="alert">' + esc(ui.error) + "</p>";
    return '<div class="fpv">' + out + "</div>";
  }

  function preset(value, current, label, sub) {
    var on = value === current;
    return '<button class="fpv-choice' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-fpv="preset" data-value="' + value + '"><span class="fpv-copy"><b>' + esc(label) + "</b>" + (sub ? "<span>" + esc(sub) + "</span>" : "") + '</span><span class="fpv-radio" aria-hidden="true"></span></button>';
  }
  function chipsHtml(kind, handles, title, hint) {
    var chips = handles.map(function (h) {
      return '<span class="fpv-chip">' + esc(nameOf(h)) + '<button type="button" data-fpv="chip-remove" data-kind="' + kind + '" data-handle="' + esc(h) + '" aria-label="' + esc(tr("Remove {name}", { name: nameOf(h) })) + '">×</button></span>';
    }).join("");
    var open = ui.chipFor === kind;
    return '<section class="fpv-chips" data-kind="' + kind + '"><h3>' + esc(title) + "</h3>" + (hint ? '<p class="fpv-note">' + esc(hint) + "</p>" : "") +
      '<div class="fpv-chip-row">' + chips +
      '<label class="fpv-chip-add"><input type="text" autocomplete="off" data-fpv-chip="' + kind + '" value="' + esc(open ? ui.chipQuery : "") + '" placeholder="' + esc(tr("Search people")) + '" aria-label="' + esc(title) + '"></label></div>' +
      '<div class="fpv-suggest" data-fpv-suggest="' + kind + '">' + (open ? suggestHtml(kind) : "") + "</div></section>";
  }
  function suggestHtml(kind) {
    var q = clean(ui.chipQuery);
    if (!q) return "";
    var rule = editing().rule;
    var aud = rule.mode === "custom" ? rule.audience : blankAudience();
    var taken = (kind === "show" ? aud.include.people : aud.exclude.people).concat(editing().handles);
    var pool = people.concat(friends()).filter(function (p, i, arr) {
      var h = clean(p.handle);
      return arr.findIndex(function (x) { return clean(x.handle) === h; }) === i;
    });
    var hits = pool.filter(function (p) {
      var h = clean(p.handle);
      return taken.indexOf(h) < 0 && (h.indexOf(q) >= 0 || String(p.name || "").toLowerCase().indexOf(q) >= 0);
    }).slice(0, 6);
    var rows = hits.map(function (p) {
      return '<button type="button" class="fpv-hit" data-fpv="chip-add" data-kind="' + kind + '" data-handle="' + esc(clean(p.handle)) + '">' + avatar(p) + '<span class="fpv-copy"><b>' + esc(p.name || "@" + p.handle) + '</b><span class="fpv-at">@' + esc(p.handle) + "</span></span></button>";
    }).join("");
    if (!hits.length && /^[a-z0-9_]{1,15}$/.test(q) && taken.indexOf(q) < 0) rows = '<button type="button" class="fpv-hit" data-fpv="chip-add" data-kind="' + kind + '" data-handle="' + esc(q) + '"><span class="fpv-copy"><b>@' + esc(q) + "</b></span></button>";
    return rows;
  }

  /* The friends being edited: one from the route, or a bulk pick. */
  function editing() {
    if (ui.bulk) {
      var first = friendOf(ui.bulk[0]);
      return { handles: ui.bulk.slice(), rule: copyRule(ui.bulkRule || (first && first.rule)), bulk: true };
    }
    var f = friendOf(ui.open);
    return { handles: f ? [clean(f.handle)] : [], rule: copyRule(f && f.rule), bulk: false };
  }

  function detailHtml(handle) {
    keepChipFocus();
    var gate = stateHtml();
    if (gate) return '<div class="fpv">' + gate + "</div>";
    if (!ui.bulk) {
      if (ui.open !== clean(handle)) { ui.open = clean(handle); ui.pending = ""; ui.preview = null; ui.previewAs = ""; ui.chipFor = ""; ui.chipQuery = ""; }
      if (!friendOf(ui.open)) return '<div class="fpv">' + head(tr("Friendship"), "#/settings/friendship") + '<p class="phandle">' + esc(tr("You’re not friends with this account.")) + "</p></div>";
    }
    var ed = editing();
    var rule = ed.rule;
    var cur = ui.pending || presetOf(rule);
    var aud = rule.mode === "custom" ? rule.audience : blankAudience();
    var friend = ed.bulk ? null : friendOf(ed.handles[0]);
    var title = ed.bulk ? tr("{n} friendships", { n: String(ed.handles.length) }) : tr("Friendship with {name}", { name: friend.name || "@" + friend.handle });
    var out = head(title, "#/settings/friendship");
    if (friend) out += '<div class="fpv-who">' + avatar(friend) + '<span class="fpv-copy"><b>' + esc(friend.name || "@" + friend.handle) + '</b><span class="fpv-at">@' + esc(friend.handle) + "</span></span></div>";
    out += '<p class="fpv-sentence" aria-live="polite">' + esc(ed.bulk
      ? tr("People who can see these friendships: {who}.", { who: whoText(rule) })
      : sentence(rule, friend.name || "@" + friend.handle)) + "</p>";
    out += '<h3 class="fpv-h">' + esc(tr("Who can see this friendship")) + '</h3><div class="fpv-choices" role="radiogroup" aria-label="' + esc(tr("Who can see this friendship")) + '">' +
      preset("inherit", cur, tr("Same as my friends list"), tr("Now: {who}", { who: listWord() })) +
      preset("everyone", cur, tr("Everyone"), tr("Anyone who can see your profile")) +
      preset("friends", cur, tr("Friends"), tr("Your friends")) +
      preset("followers", cur, tr("Followers"), tr("People who follow you")) +
      preset("lists", cur, tr("Lists"), tr("People in your audience lists")) +
      preset("people", cur, tr("Specific people"), tr("Only the people you pick")) +
      preset("me", cur, tr("Only me"), tr("Nobody else sees it on your list")) + "</div>";
    if (cur === "lists") {
      var lists = (data && data.lists) || [];
      var picked = aud.include.lists;
      out += '<section class="fpv-lists"><h3>' + esc(tr("Lists")) + "</h3>" + (lists.length ? lists.map(function (l) {
        var on = picked.indexOf(l.id) >= 0;
        return '<button class="fpv-choice' + (on ? " on" : "") + '" type="button" role="checkbox" aria-checked="' + (on ? "true" : "false") + '" data-fpv="list" data-id="' + esc(l.id) + '"><span class="fpv-copy"><b>' + esc((l.icon ? l.icon + " " : "") + l.name) + '</b></span><span class="fpv-box" aria-hidden="true"></span></button>';
      }).join("") : '<p class="fpv-note">' + esc(tr("Create an audience list in Privacy and safety.")) + "</p>") + "</section>";
    }
    if (cur === "people") out += chipsHtml("show", aud.include.people, tr("Show to"), "");
    else if (cur === "friends" || cur === "followers" || cur === "lists") out += chipsHtml("show", aud.include.people, tr("Also show to"), "");
    if (cur === "everyone" || cur === "friends" || cur === "followers" || cur === "lists") out += chipsHtml("hide", aud.exclude.people, tr("Hide from"), tr("Hiding always wins over showing."));
    out += '<p class="fpv-note">' + esc(ed.bulk
      ? tr("Each friend’s own setting also applies. Both of you have to allow it.")
      : tr("{name}’s own setting also applies. Both of you have to allow it.", { name: friend.name || "@" + friend.handle })) + "</p>";
    if (!ed.bulk) out += previewHtml(ed.handles[0]);
    else out += '<div class="fpv-actions"><button class="primary" type="button" data-fpv="bulk-save">' + esc(tr("Apply to {n} friends", { n: String(ed.handles.length) })) + '</button><button class="outline" type="button" data-fpv="bulk-cancel">' + esc(tr("Cancel")) + "</button></div>";
    if (ui.error) out += '<p class="phandle fp-error" role="alert">' + esc(ui.error) + "</p>";
    return '<div class="fpv fpv-detail">' + out + "</div>";
  }

  function pageHtml(sub) {
    if (ui.bulk) return detailHtml("");
    if (sub) {
      var h = "";
      try { h = decodeURIComponent(sub); } catch (err) { h = sub; }
      return detailHtml(h);
    }
    ui.open = "";
    return listHtml();
  }

  /* ---------- events ---------- */

  function change(rule) {
    var ed = editing();
    if (ed.bulk) { ui.bulkRule = copyRule(rule); redraw(); return; }
    if (sameRule(rule, ed.rule)) return;
    save(ed.handles, rule);
  }
  function editChip(kind, handle, add) {
    var ed = editing();
    var rule = copyRule(ed.rule);
    if (rule.mode !== "custom") rule = ruleForPreset("people", rule);
    var arr = kind === "show" ? rule.audience.include.people : rule.audience.exclude.people;
    var other = kind === "show" ? rule.audience.exclude.people : rule.audience.include.people;
    var h = clean(handle);
    var at = arr.indexOf(h);
    if (add && at < 0) arr.push(h);
    if (!add && at >= 0) arr.splice(at, 1);
    if (add) { var o = other.indexOf(h); if (o >= 0) other.splice(o, 1); }
    ui.chipQuery = "";
    var box = root.document && root.document.querySelector('[data-fpv-chip="' + kind + '"]');
    if (box) box.value = "";
    if (presetOf(rule) === "me" && ui.pending) { redraw(); return; }
    ui.pending = "";
    change(rule);
  }

  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-fpv]") : null;
    if (!el || el.disabled) return;
    var act = el.getAttribute("data-fpv");
    event.preventDefault();
    var ed;
    if (act === "select") { ui.selecting = !ui.selecting; ui.picked = {}; redraw(); return; }
    if (act === "pick") { var h = el.getAttribute("data-handle"); ui.picked[h] = !ui.picked[h]; redraw(); return; }
    if (act === "pick-all") { friends().forEach(function (f) { ui.picked[clean(f.handle)] = true; }); redraw(); return; }
    if (act === "bulk") {
      var picked = Object.keys(ui.picked).filter(function (k) { return ui.picked[k] && friendOf(k); });
      if (!picked.length) return;
      ui.bulk = picked;
      ui.bulkRule = copyRule(friendOf(picked[0]).rule);
      ui.pending = "";
      ui.chipFor = ""; ui.chipQuery = "";
      redraw();
      return;
    }
    if (act === "bulk-cancel") { ui.bulk = null; ui.bulkRule = null; redraw(); return; }
    if (act === "bulk-save") {
      var list = ui.bulk || [];
      var rule = ui.bulkRule;
      ui.bulk = null; ui.bulkRule = null; ui.selecting = false; ui.picked = {};
      save(list, rule);
      return;
    }
    if (act === "preset") {
      ed = editing();
      var want = el.getAttribute("data-value");
      var next = ruleForPreset(want, ed.rule);
      // "Specific people" or "Lists" with nobody picked yet: show the
      // picker first; nothing is saved until someone is added.
      ui.pending = presetOf(next) !== want ? want : "";
      if (ui.pending) { redraw(); return; }
      change(next);
      return;
    }
    if (act === "list") {
      ed = editing();
      var r = copyRule(ed.rule);
      if (r.mode !== "custom") r = ruleForPreset("lists", r);
      var id = el.getAttribute("data-id");
      var at = r.audience.include.lists.indexOf(id);
      if (at >= 0) r.audience.include.lists.splice(at, 1); else r.audience.include.lists.push(id);
      if (presetOf(r) === "me") return; // keep at least one list; pick another preset instead
      ui.pending = "";
      change(r);
      return;
    }
    if (act === "chip-add") { editChip(el.getAttribute("data-kind"), el.getAttribute("data-handle"), true); return; }
    if (act === "chip-remove") { editChip(el.getAttribute("data-kind"), el.getAttribute("data-handle"), false); return; }
  }
  function onInput(event) {
    var el = event.target;
    if (!el || !el.getAttribute) return;
    if (el.hasAttribute("data-fpv-filter")) {
      ui.query = el.value;
      var pos = el.selectionStart;
      redraw();
      var again = root.document.querySelector("[data-fpv-filter]");
      if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* search inputs */ } }
      return;
    }
    var kind = el.getAttribute("data-fpv-chip");
    if (kind) {
      ui.chipFor = kind;
      ui.chipQuery = el.value;
      var box = root.document.querySelector('[data-fpv-suggest="' + kind + '"]');
      if (box) box.innerHTML = suggestHtml(kind);
    }
  }
  function onKey(event) {
    var el = event.target;
    var kind = el && el.getAttribute && el.getAttribute("data-fpv-chip");
    if (!kind || event.key !== "Enter") return;
    event.preventDefault();
    ui.chipFor = kind;
    ui.chipQuery = el.value;
    var hits = root.document.querySelector('[data-fpv-suggest="' + kind + '"]');
    if (hits) hits.innerHTML = suggestHtml(kind);
    var first = root.document.querySelector('[data-fpv-suggest="' + kind + '"] [data-fpv="chip-add"]');
    if (first) editChip(kind, first.getAttribute("data-handle"), true);
  }
  function onChange(event) {
    var el = event.target;
    if (el && el.hasAttribute && el.hasAttribute("data-fpv-preview")) runPreview(el.value);
  }
  function onSubmit(event) {
    var form = event.target;
    if (!form || !form.hasAttribute || !form.hasAttribute("data-fpv-preview-form")) return;
    event.preventDefault();
    var v = clean(form.elements.as && form.elements.as.value);
    if (v) runPreview(v);
  }

  if (root.document) {
    root.document.addEventListener("click", onClick);
    root.document.addEventListener("input", onInput);
    root.document.addEventListener("keydown", onKey);
    root.document.addEventListener("change", onChange);
    root.document.addEventListener("submit", onSubmit);
  }

  root.ViktorychFriendPrivacy = {
    load: load,
    entryHtml: entryHtml,
    pageHtml: pageHtml,
    /* For the profile ⋯ menu: true once we know this handle is a friend. */
    isFriend: function (handle) { if (!data) load(false); return !!friendOf(handle); },
    _rowSummary: rowSummary,
    _presetOf: presetOf
  };
})(typeof window !== "undefined" ? window : this);
