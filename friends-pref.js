/* Friends master switch (Settings > Privacy > Friends).

   Off: nobody can send you friend requests (the Worker rejects them), your
   pending requests are paused, your friends are kept but hidden, and every
   friend surface disappears for you: the Friends panel and its online dots,
   the Friends tab, friend counts, friend notifications, the Friends post
   audience and the Friends item in the menus. Turning it on brings it all
   back. When turning it off you may also decline every pending request or
   remove every friend.

   On: who can send requests, who sees your friends list, and whether
   friends see your online status.

   The last answer is kept in localStorage so the first paint already hides
   friend UI; html.friends-off drives the CSS. */
(function (root) {
  "use strict";

  var KEY = "viktorychapp-friends-pref";
  var STALE_MS = 5 * 60 * 1000;
  var WHO = ["everyone", "fof", "nobody"];
  var LIST = ["everyone", "friends", "me"];
  var state = read();
  var loading = false;
  var ui = { confirming: false, pending: "pause", friends: "keep", arm: "", busy: false, error: "" };

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
  function owner() { var m = me(); return m ? String(m.handle || m.id || "") : ""; }
  function switchOn() {
    // The owner's "friends_off" feature switch. Unknown (not fetched yet) counts as on.
    try {
      var list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
      return !(Array.isArray(list) && list.indexOf("friends_off") >= 0);
    } catch (err) { return true; }
  }

  function defaults() {
    return { enabled: true, whoCanRequest: "everyone", listAudience: "everyone", shareOnline: true, held: { incoming: 0, outgoing: 0, friends: 0 }, at: 0, owner: "" };
  }
  function normalize(raw) {
    var out = defaults();
    if (!raw || typeof raw !== "object") return out;
    if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
    if (WHO.indexOf(raw.whoCanRequest) >= 0) out.whoCanRequest = raw.whoCanRequest;
    if (LIST.indexOf(raw.listAudience) >= 0) out.listAudience = raw.listAudience;
    if (typeof raw.shareOnline === "boolean") out.shareOnline = raw.shareOnline;
    if (raw.held && typeof raw.held === "object") {
      ["incoming", "outgoing", "friends"].forEach(function (k) { out.held[k] = Math.max(0, Number(raw.held[k]) || 0); });
    }
    out.at = Number(raw.at) || 0;
    out.owner = String(raw.owner || "");
    return out;
  }
  function read() {
    try { return normalize(JSON.parse(localStorage.getItem(KEY) || "null")); } catch (err) { return defaults(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (err) { /* private mode */ }
  }
  function mine() {
    var who = owner();
    if (!who) return defaults();
    if (state.owner && state.owner !== who) return defaults();
    return state;
  }
  function apply() {
    var off = isOff();
    var el = root.document && root.document.documentElement;
    if (el && el.classList) el.classList.toggle("friends-off", off);
  }
  function redraw() {
    apply();
    var a = accounts();
    if (a && a.requestRender) a.requestRender();
  }

  function isOff() {
    if (!switchOn()) return false;
    var who = owner();
    if (!who) return false;
    if (!loading && Date.now() - (state.at || 0) > STALE_MS) load(false);
    return mine().enabled === false;
  }

  function load(force) {
    var a = accounts();
    if (!a || !a.call || !token() || loading) return Promise.resolve(mine());
    if (!force && Date.now() - (state.at || 0) < 15000) return Promise.resolve(mine());
    loading = true;
    var who = owner();
    state.at = Date.now();
    return a.call("/v1/friends/settings", { token: token() }).then(function (res) {
      loading = false;
      if (res && res.status === 200 && typeof res.enabled === "boolean") {
        var was = mine().enabled;
        state = normalize(Object.assign({}, res, { at: Date.now(), owner: who }));
        save();
        if (was !== state.enabled) redraw(); else apply();
      } else if (res && res.status === 204) {
        state = normalize({ at: Date.now(), owner: who });
        save();
        apply();
      }
      return mine();
    }).catch(function () { loading = false; return mine(); });
  }

  function put(patch) {
    var a = accounts();
    if (!a || !a.call || !token()) return Promise.resolve(null);
    var who = owner();
    ui.busy = true;
    ui.error = "";
    redraw();
    return a.call("/v1/friends/settings", { method: "PUT", token: token(), body: patch }).then(function (res) {
      ui.busy = false;
      if (res && res.status === 200 && typeof res.enabled === "boolean") {
        state = normalize(Object.assign({}, res, { at: Date.now(), owner: who }));
        save();
        if (a.refreshFriends) a.refreshFriends();
        if (root.ViktorychPresence && root.ViktorychPresence.reloadFriends) root.ViktorychPresence.reloadFriends();
      } else {
        ui.error = tr("Couldn’t save. Try again.");
      }
      redraw();
      return res;
    }).catch(function () { ui.busy = false; ui.error = tr("Couldn’t save. Try again."); redraw(); return null; });
  }

  /* ---------- Settings ---------- */

  /* X-native settings rows: title, grey note, a square check or a round radio on the right. */
  var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z"></path></svg>';
  function sw(act, on, label, note) {
    return '<button class="set-row fp-row" type="button" role="checkbox" aria-checked="' + (on ? "true" : "false") + '" data-fp-act="' + act + '"' + (ui.busy ? " disabled" : "") + '><span class="set-copy"><b>' + esc(label) + "</b>" +
      (note ? '<span class="set-sub">' + esc(note) + "</span>" : "") + '</span><span class="fp-check' + (on ? " on" : "") + '" aria-hidden="true">' + (on ? CHECK_SVG : "") + "</span></button>";
  }
  function seg(act, value, on, label) {
    return '<button class="set-row fp-row" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-fp-act="' + act + '" data-value="' + esc(value) + '"' + (ui.busy ? " disabled" : "") + '><span class="set-copy"><b>' + esc(label) + '</b></span><span class="fp-radio' + (on ? " on" : "") + '" aria-hidden="true"></span></button>';
  }
  function radio(group, value, on, label, sub) {
    return '<button class="set-row fp-row" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-fp-act="choose" data-group="' + group + '" data-value="' + value + '"><span class="set-copy"><b>' + esc(label) + "</b>" + (sub ? '<span class="set-sub">' + esc(sub) + "</span>" : "") + '</span><span class="fp-radio' + (on ? " on" : "") + '" aria-hidden="true"></span></button>';
  }
  function section(title, body) {
    return '<section class="fp-sec"><h2 class="fp-h">' + esc(title) + '</h2><div class="set-list" role="radiogroup" aria-label="' + esc(title) + '">' + body + "</div></section>";
  }

  function summary() {
    var p = mine();
    if (!p.enabled) return tr("Off · Nobody can send you friend requests");
    if (p.whoCanRequest === "nobody") return tr("On · Nobody can send you requests");
    if (p.whoCanRequest === "fof") return tr("On · Friends of friends can send requests");
    return tr("On");
  }

  function modal(title, text, body, goLabel, goAct, danger) {
    return '<div class="fp-mask" data-fp-act="cancel-off"></div><div class="fp-modal" role="alertdialog" aria-modal="true" aria-label="' + esc(title) + '">' +
      '<h2 class="fp-modal-title">' + esc(title) + "</h2>" +
      '<p class="fp-modal-text">' + esc(text) + "</p>" + body +
      '<div class="fp-modal-actions"><button class="fp-pill ' + (danger ? "fp-pill-red" : "fp-pill-main") + '" type="button" data-fp-act="' + goAct + '"' + (ui.busy ? " disabled" : "") + ">" + esc(goLabel) + '</button><button class="fp-pill fp-pill-line" type="button" data-fp-act="cancel-off">' + esc(tr("Cancel")) + "</button></div></div>";
  }
  function confirmHtml(p) {
    var pend = (p.held.incoming || 0) + (p.held.outgoing || 0);
    var n = p.held.friends || 0;
    var removing = ui.friends === "remove" && n > 0;
    var go = removing ? tr("Turn off and remove {n} friends", { n: String(n) }) : tr("Turn off Friends");
    var body = '<h3 class="fp-modal-h">' + esc(tr("Pending requests ({n})", { n: String(pend) })) + '</h3><div class="fp-modal-list" role="radiogroup">' +
        radio("pending", "pause", ui.pending !== "decline", tr("Pause them"), tr("Kept for when you turn Friends back on.")) +
        radio("pending", "decline", ui.pending === "decline", tr("Decline all"), tr("Sent and received requests are removed.")) +
      '</div><h3 class="fp-modal-h">' + esc(tr("Your friends ({n})", { n: String(n) })) + '</h3><div class="fp-modal-list" role="radiogroup">' +
        radio("friends", "keep", ui.friends !== "remove", tr("Keep them, hidden"), tr("Nobody sees them while Friends is off.")) +
        radio("friends", "remove", ui.friends === "remove", tr("Remove all friends"), tr("This can’t be undone.")) +
      "</div>";
    return modal(tr("Turn off Friends?"), tr("Nobody can send you friend requests, and friend features are hidden for you. Turn it back on any time."), body, go, "confirm-off", removing);
  }
  function armHtml(p) {
    var pend = (p.held.incoming || 0) + (p.held.outgoing || 0);
    var n = p.held.friends || 0;
    if (ui.arm === "decline") return modal(tr("Decline paused requests"), tr("Sent and received requests are removed."), "", tr("Decline all") + " (" + pend + ")", "decline-all", true);
    return modal(tr("Remove hidden friends"), tr("This can’t be undone."), "", tr("Remove all friends") + " (" + n + ")", "remove-all", true);
  }

  function pageHtml() {
    if (!owner()) return '<p class="fp-lead">' + esc(tr("Sign in to choose your friends settings.")) + "</p>";
    if (Date.now() - (state.at || 0) > 15000) load(false);
    var p = mine();
    var out = '<div class="set-list">' + sw("master", p.enabled, tr("Friends"), tr("Friend requests, friends lists, the Friends panel and friends’ online status.")) + "</div>";
    if (p.enabled) {
      out += section(tr("Who can send you friend requests"),
        seg("who", "everyone", p.whoCanRequest === "everyone", tr("Everyone")) +
        seg("who", "fof", p.whoCanRequest === "fof", tr("Friends of friends")) +
        seg("who", "nobody", p.whoCanRequest === "nobody", tr("Nobody")));
      out += section(tr("Who can see your friends list"),
        seg("list", "everyone", p.listAudience === "everyone", tr("Everyone")) +
        seg("list", "friends", p.listAudience === "friends", tr("Friends")) +
        seg("list", "me", p.listAudience === "me", tr("Only me")));
      out += '<div class="set-list fp-sep">' + sw("online", p.shareOnline, tr("Share online status with friends"), tr("Friends see when you’re online. Your Online settings still apply.")) + "</div>";
    } else {
      var pend = (p.held.incoming || 0) + (p.held.outgoing || 0);
      var n = p.held.friends || 0;
      out += '<p class="fp-lead">' + esc(tr("Friends is off. {a} paused requests and {b} hidden friends come back when you turn it on.", { a: String(pend), b: String(n) })) + "</p>";
      var rows = "";
      if (pend > 0) rows += '<button class="set-row fp-row fp-red" type="button" data-fp-act="arm-decline"><span class="set-copy"><b>' + esc(tr("Decline paused requests")) + "</b></span></button>";
      if (n > 0) rows += '<button class="set-row fp-row fp-red" type="button" data-fp-act="arm-remove"><span class="set-copy"><b>' + esc(tr("Remove hidden friends")) + "</b></span></button>";
      if (rows) out += '<div class="set-list fp-sep">' + rows + "</div>";
    }
    if (ui.error) out += '<p class="fp-lead fp-error" role="alert">' + esc(ui.error) + "</p>";
    if (ui.confirming) out += confirmHtml(p);
    else if (ui.arm) out += armHtml(p);
    return '<div class="fp-page">' + out + "</div>";
  }

  /* One plain switch for the first-time setup privacy step. */
  function setupHtml() {
    var p = mine();
    return '<div class="fp-setup">' + sw("setup", p.enabled, tr("Friends"), tr("Turn off to get no friend requests and hide friend features.")) + "</div>";
  }

  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-fp-act]") : null;
    if (!el || el.disabled) return;
    event.preventDefault();
    var act = el.getAttribute("data-fp-act");
    var value = el.getAttribute("data-value") || "";
    var p = mine();
    if (act === "master") {
      if (ui.confirming) { ui.confirming = false; redraw(); return; }
      if (p.enabled) {
        ui.confirming = true; ui.pending = "pause"; ui.friends = "keep"; ui.arm = "";
        load(true).then(redraw);
        redraw();
      } else {
        ui.arm = "";
        put({ enabled: true });
      }
      return;
    }
    if (act === "setup") { put({ enabled: !p.enabled }); return; }
    if (act === "choose") {
      if (el.getAttribute("data-group") === "pending") ui.pending = value === "decline" ? "decline" : "pause";
      else ui.friends = value === "remove" ? "remove" : "keep";
      redraw();
      return;
    }
    if (act === "cancel-off") { ui.confirming = false; ui.arm = ""; redraw(); return; }
    if (act === "arm-decline") { ui.arm = "decline"; redraw(); return; }
    if (act === "arm-remove") { ui.arm = "remove"; redraw(); return; }
    if (act === "confirm-off") {
      var patch = { enabled: false };
      if (ui.pending === "decline") patch.declineAll = true;
      if (ui.friends === "remove") { patch.removeAll = true; patch.confirm = "remove"; }
      ui.confirming = false;
      put(patch);
      return;
    }
    if (act === "who" && WHO.indexOf(value) >= 0) { put({ whoCanRequest: value }); return; }
    if (act === "list" && LIST.indexOf(value) >= 0) { put({ listAudience: value }); return; }
    if (act === "online") { put({ shareOnline: !p.shareOnline }); return; }
    if (act === "decline-all") { ui.arm = ""; put({ declineAll: true }); return; }
    if (act === "remove-all") { ui.arm = ""; put({ removeAll: true, confirm: "remove" }); return; }
  }

  if (root.document) {
    root.document.addEventListener("click", onClick);
    root.document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && (ui.confirming || ui.arm)) { ui.confirming = false; ui.arm = ""; redraw(); }
    });
    apply();
    root.addEventListener && root.addEventListener("storage", function (e) { if (e.key === KEY) { state = read(); redraw(); } });
  }

  root.ViktorychFriendsPref = {
    isOff: isOff,
    prefs: function () { return mine(); },
    load: load,
    apply: apply,
    summary: summary,
    pageHtml: pageHtml,
    setupHtml: setupHtml,
    // For first-time setup: is the switch offered, and turn it on or off.
    available: function () { return switchOn() && !!owner(); },
    setEnabled: function (on) {
      return put({ enabled: !!on }).then(function () { return mine().enabled === !!on; }, function () { return false; });
    },
    _normalize: normalize
  };
})(typeof window !== "undefined" ? window : this);
