/* Settings > Connected keys. Owner only, and only after the accounts wall is on.
   The saved value is never copied back into the page. Extra keys are backups. */
(function () {
  var cache = null;
  var loading = false;
  var loadedAt = 0;
  var openSlot = "";
  var openKey = "";
  var note = "";
  var notified = {};

  function tr(key, vars) {
    return window.t ? window.t(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function config() {
    return window.VIKTORYCH_ACCOUNTS || { api: "", gate: false };
  }
  function account() {
    var api = window.ViktorychAccounts;
    return api && api.account ? api.account() : null;
  }
  function token() {
    var api = window.ViktorychAccounts;
    return api && api.token ? api.token() : "";
  }
  function visible() {
    var row = account();
    return !!(config().gate === true && row && (row.owner === true || row.owner === 1));
  }
  function render() {
    if (window.ViktorychAccounts && window.ViktorychAccounts.requestRender) window.ViktorychAccounts.requestRender();
  }
  function when(value) {
    var n = Number(value) || 0;
    if (!n) return "";
    try { return new Date(n).toLocaleString((window.SI18n ? window.SI18n.locale() : undefined)); }
    catch (err) { return ""; }
  }
  function statusLabel(status, configured) {
    if (!configured || status === "empty") return tr("Key not connected");
    if (status === "working") return tr("Key working");
    if (status === "expired") return tr("Key expired");
    if (status === "needs_attention") return tr("Key needs attention");
    return tr("Key not tested");
  }
  function errorLabel(code) {
    if (code === "unauthorized") return tr("The key was rejected.");
    if (code === "logged_out" || code === "session_invalid" || code === "auth_required") return tr("The key is no longer signed in.");
    if (code === "rate_limit" || code === "forbidden") return tr("This service is slowing down. The same key stays in use.");
    if (code === "captcha" || code === "challenge") return tr("The site asked for a check.");
    if (code === "expired") return tr("This key is expired.");
    if (code === "unreachable" || code === "unreadable") return tr("The check did not connect.");
    if (code === "bad_paste") return tr("That paste was not accepted.");
    return "";
  }
  function helpFor(kind) {
    if (kind === "pair") return tr("Paste the client id and the client secret from your own app, one on each line.");
    if (kind === "token") return tr("Paste the token from your own account.");
    return tr("In your own browser, while you are signed in, export cookies as a Netscape cookies.txt file or copy the Cookie header from one request you made to that site.");
  }
  function alertText(row) {
    var name = row.label ? tr(row.label) : tr("Connected keys");
    if (row.status === "slow") return tr("{service} is slowing down. The same key stays in use.", { service: name });
    return tr("{service} needs a new key. Open Connected keys and replace it.", { service: name });
  }
  function rememberAlert(row) {
    var id = "key:" + row.slot + ":" + row.status + ":" + String(row.keyId || "") + ":" + String(row.updatedAt || 0);
    if (notified[id]) return;
    var seen = "";
    try { seen = sessionStorage.getItem("viktorych-key-notes") || ""; }
    catch (err) { seen = ""; }
    if (seen.indexOf(id) >= 0) {
      notified[id] = true;
      return;
    }
    notified[id] = true;
    try { sessionStorage.setItem("viktorych-key-notes", (seen + "\n" + id).slice(-4000)); }
    catch (err) { /* the settings line still shows the status */ }
    try {
      window.dispatchEvent(new CustomEvent("viktorych-key-alert", {
        detail: { id: id, text: alertText(row) }
      }));
    } catch (err) { /* the in-app list is optional */ }
  }
  function applyBody(body) {
    cache = body && Array.isArray(body.slots) ? body : { slots: [], alerts: [] };
    (cache.alerts || []).forEach(rememberAlert);
  }
  function endpoint() {
    return String(config().api || "").replace(/\/$/, "");
  }
  function send(path, method, body) {
    var root = endpoint();
    var session = token();
    if (!root || !session) return Promise.resolve({ status: 0, error: "unauthorized" });
    return fetch(root + path, {
      method: method,
      headers: {
        authorization: "Bearer " + session,
        "content-type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: "omit"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (payload) {
        payload = payload || {};
        payload.status = res.status;
        return payload;
      });
    }).catch(function () {
      return { status: 0, error: "unreachable" };
    });
  }
  function load(force) {
    if (!visible()) return;
    if (loading) return;
    if (!force && cache && Date.now() - loadedAt < 15000) return;
    loading = true;
    loadedAt = Date.now();
    send("/v1/owner/keys", "GET").then(function (body) {
      loading = false;
      if (!body || body.status !== 200) {
        note = tr("Could not reach the key store.");
        render();
        return;
      }
      applyBody(body);
      render();
    });
  }
  function fail(body) {
    if (body && body.error === "not_configured") note = tr("Setup needed");
    else if (body && body.error === "bad_paste") note = tr("That paste was not accepted.");
    else if (body && body.error === "too_many") note = tr("This service already has enough backup keys.");
    else if (!body || !body.status) note = tr("Could not reach the key store.");
    else note = tr("Could not save that key.");
  }
  /* X-style icons (24px outline, currentColor), drawn for this page. */
  var ICONS = {
    chev: "M14.586 12L7.543 4.96l1.414-1.42L17.414 12l-8.457 8.46-1.414-1.42L14.586 12z",
    key: "M7.5 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM3 12a4.5 4.5 0 0 1 8.66-1.73H21v3.46h-2V16h-2v-2.27h-2V16h-2v-2.27h-1.34A4.5 4.5 0 0 1 3 12z",
    cookie: "M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5zm-1.9 2.2a6 6 0 0 0 5.1 4.68 6 6 0 0 0 4.62 4.62A8 8 0 1 1 10.1 4.2zM8.5 9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm2 5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 1a1 1 0 1 1 0 2 1 1 0 0 1 0-2z",
    apps: "M4 4h7v7H4V4zm2 2v3h3V6H6zm7-2h7v7h-7V4zm2 2v3h3V6h-3zM4 13h7v7H4v-7zm2 2v3h3v-3H6zm7-2h7v7h-7v-7zm2 2v3h3v-3h-3z",
    pulse: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM1.5 12C1.5 6.2 6.2 1.5 12 1.5S22.5 6.2 22.5 12 17.8 22.5 12 22.5 1.5 17.8 1.5 12zm9.5 2.59l5.29-5.3 1.42 1.42L11 17.41l-4.21-4.2 1.42-1.42L11 14.59z",
    plus: "M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z",
    device: "M8 1.75h8A2.25 2.25 0 0 1 18.25 4v16A2.25 2.25 0 0 1 16 22.25H8A2.25 2.25 0 0 1 5.75 20V4A2.25 2.25 0 0 1 8 1.75zm0 2a.25.25 0 0 0-.25.25v16c0 .14.11.25.25.25h8a.25.25 0 0 0 .25-.25V4a.25.25 0 0 0-.25-.25H8zM10 17h4v2h-4v-2z"
  };
  function svg(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICONS[name] + '"></path></svg>';
  }
  function kindIcon(kind) {
    if (kind === "pair") return "apps";
    if (kind === "token") return "key";
    return "cookie";
  }
  function shortDate(value) {
    var n = Number(value) || 0;
    if (!n) return "";
    try { return new Date(n).toLocaleDateString((window.SI18n ? window.SI18n.locale() : undefined), { month: "short", day: "numeric" }); }
    catch (err) { return ""; }
  }
  function findSlot(id) {
    var slots = cache && cache.slots ? cache.slots : [];
    return slots.filter(function (item) { return item.id === id; })[0] || null;
  }
  /* Discord's own daily key check (scripts/discord_picks.py) lands in the
     picks document; "invalid" means Discord turned the key down. */
  var discordHealth = null;
  var discordAt = 0;
  function loadDiscordHealth() {
    if (!visible() || Date.now() - discordAt < 15 * 60 * 1000) return;
    discordAt = Date.now();
    send("/v1/discord/picks", "GET").then(function (body) {
      if (!body || body.status !== 200 || !body.health) return;
      discordHealth = body.health;
      render();
    });
  }
  function discordInvalid(slot) {
    return slot.id === "discord" && discordHealth && discordHealth.status === "invalid" && Array.isArray(slot.keys) && slot.keys.length > 0;
  }
  /* One calm word per state: green when working, amber when the owner has
     to paste a new key, grey otherwise. Never a red alarm. */
  function tone(status) {
    if (status === "working") return { cls: "ok", text: tr("Connected") };
    if (status === "expired" || status === "needs_attention" || status === "invalid") return { cls: "warn", text: tr("Needs a new key") };
    if (status === "empty") return { cls: "off", text: tr("Not connected") };
    return { cls: "off", text: tr("Connected · not tested yet") };
  }
  function slotTone(slot) {
    var keys = Array.isArray(slot.keys) ? slot.keys : [];
    if (!keys.length) return tone("empty");
    if (discordInvalid(slot)) return tone("invalid");
    var good = keys.some(function (key) { return key.status === "working"; });
    if (good) return tone("working");
    var bad = keys.every(function (key) { return key.status === "expired" || key.status === "needs_attention"; });
    return tone(bad ? "expired" : "unknown");
  }
  function keyTone(slot, key, index) {
    if (index === 0 && discordInvalid(slot)) return tone("invalid");
    return tone(key.status);
  }
  function statusLine(t, extra) {
    return '<span class="xk-status ' + t.cls + '"><i aria-hidden="true"></i>' + esc(t.text) + "</span>" + (extra ? '<span class="xk-dot" aria-hidden="true">·</span><span>' + esc(extra) + "</span>" : "");
  }
  function slotMeta(slot) {
    var keys = Array.isArray(slot.keys) ? slot.keys : [];
    if (!keys.length) return helpShort(slot.kind);
    var newest = 0;
    keys.forEach(function (key) { newest = Math.max(newest, Number(key.updatedAt) || 0); });
    var added = newest ? tr("Added {date}", { date: shortDate(newest) }) : "";
    var count = keys.length > 1 ? tr("Keys: {count}", { count: keys.length }) : "";
    return [added, count].filter(Boolean).join(" · ");
  }
  function helpShort(kind) {
    if (kind === "pair") return tr("Client id and secret from your own app");
    if (kind === "token") return tr("A token from your own account");
    return tr("Cookies from your own signed-in browser");
  }
  function row(href, icon, title, meta, status, attrs) {
    var tag = href ? "a" : "div";
    return "<" + tag + ' class="xk-row"' + (href ? ' href="' + esc(href) + '"' : "") + (attrs || "") + ">" +
      '<span class="xk-ico">' + svg(icon) + "</span>" +
      '<span class="xk-copy"><b>' + esc(title) + "</b>" +
      (meta ? '<span class="xk-sub">' + esc(meta) + "</span>" : "") +
      (status ? '<span class="xk-line">' + status + "</span>" : "") + "</span>" +
      (href ? '<span class="xk-chev">' + svg("chev") + "</span>" : "") + "</" + tag + ">";
  }
  function noteHtml() {
    return note ? '<p class="xk-note" role="status">' + esc(note) + "</p>" : "";
  }
  /* "On this device" holds keys that never leave this browser (the local
     Discord key). Its module adds rows through DiscordLocal.rowsHtml(). */
  function deviceGroupHtml() {
    var mod = window.DiscordLocal;
    var rows = mod && typeof mod.rowsHtml === "function" ? mod.rowsHtml() : "";
    if (!rows) return "";
    return '<section class="xk-group" data-xk-group="device"><h2 class="xk-h2">' + esc(tr("On this device")) + "</h2>" +
      '<p class="xk-desc">' + esc(tr("Stays in this browser only. Our servers never see it.")) + "</p>" + rows + "</section>";
  }
  /* The local Discord key module (discord-local.js) paints its own
     #dloc-section above this page's body. Group it under "On this device"
     and keep the page description first, without touching that module. */
  function groupDeviceSection() {
    if (typeof document === "undefined") return;
    var box = document.getElementById("dloc-section");
    var page = document.querySelector(".xk.keys-settings");
    if (!box || !page || box.getAttribute("data-xk-grouped") === "1") return;
    box.setAttribute("data-xk-grouped", "1");
    box.classList.add("xk-device");
    var head = document.createElement("h2");
    head.className = "xk-h2 xk-device-h";
    head.textContent = tr("On this device");
    var intro = page.querySelector(".xk-intro");
    var wrap = document.createElement("section");
    wrap.className = "xk-group";
    wrap.setAttribute("data-xk-group", "device");
    box.parentNode.insertBefore(wrap, box);
    wrap.appendChild(head);
    wrap.appendChild(box);
    if (intro) wrap.parentNode.insertBefore(intro, wrap);
  }
  function afterPaint() {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(groupDeviceSection);
    else setTimeout(groupDeviceSection, 0);
  }
  function sectionHtml() {
    afterPaint();
    if (!visible()) return '<div class="set-block"><p class="phandle">' + esc(tr("Keys are available only to the owner.")) + "</p></div>";
    load(false);
    loadDiscordHealth();
    if (cache && cache.ready === false) {
      return '<div class="xk"><p class="xk-desc keys-status">' + esc(tr("Setup needed")) + "</p></div>";
    }
    var slots = cache && cache.slots ? cache.slots : [];
    var rows = slots.map(function (slot) {
      var t = slotTone(slot);
      var slow = slot.pace && slot.pace.reason ? tr("Slowing down") : "";
      return row("#/settings/keys/" + encodeURIComponent(slot.id), kindIcon(slot.kind), tr(slot.label), slotMeta(slot), statusLine(t, slow), ' data-xk-slot="' + esc(slot.id) + '"');
    }).join("");
    if (!cache) rows = '<p class="xk-desc">' + esc(tr("Loading…")) + "</p>";
    return '<div class="xk keys-settings">' +
      '<p class="xk-desc xk-intro">' + esc(tr("Paste keys from your own accounts. They stay encrypted, and the saved value is never shown again.")) + " " + esc(tr("Keys are backups. One key is used at a time, highest priority first.")) + "</p>" +
      noteHtml() + deviceGroupHtml() +
      '<section class="xk-group" data-xk-group="server"><h2 class="xk-h2">' + esc(tr("Your accounts")) + "</h2>" + rows + "</section>" +
      healthHtml() + "</div>";
  }
  function titleFor(id) {
    var slot = findSlot(id);
    return slot ? tr(slot.label) : tr("Connected keys");
  }
  function pasteField(slot, keyId, label) {
    var hint = slot.kind === "pair" ? tr("Paste the client id and the client secret from your own app, one on each line.") : tr("Paste a Cookie header or a Netscape cookies.txt file.");
    if (slot.kind === "token") hint = tr("Paste the token from your own account.");
    var cancel = (findSlot(slot.id) && slotKeys(slot.id).length)
      ? '<button class="xk-pill outline" type="button" data-act="keys-cancel" data-slot="' + esc(slot.id) + '">' + esc(tr("Cancel")) + "</button>" : "";
    return '<div class="xk-form">' +
      '<label class="xk-field"><span>' + esc(tr("Optional label")) + '</span><input class="keys-label" data-keys-label="' + esc(slot.id) + '" maxlength="40" autocomplete="off" spellcheck="false" value="' + esc(label || "") + '" aria-label="' + esc(tr("Key label")) + '"></label>' +
      '<label class="xk-field"><span>' + esc(hint) + '</span><textarea class="keys-paste" data-keys-paste="' + esc(slot.id) + '" autocomplete="off" spellcheck="false" maxlength="100000" rows="4" aria-label="' + esc(tr(slot.label)) + '"></textarea></label>' +
      '<div class="xk-actions"><button class="xk-pill primary" type="button" data-act="keys-save" data-slot="' + esc(slot.id) + '" data-key="' + esc(keyId) + '">' + esc(tr("Save key")) + "</button>" + cancel + "</div></div>";
  }
  var askRemove = null;
  function removeSheet(slot) {
    if (!askRemove || askRemove.slot !== slot.id) return "";
    return '<div class="xk-sheet-back" data-act="keys-cancel" data-slot="' + esc(slot.id) + '"></div>' +
      '<div class="xk-sheet" role="dialog" aria-modal="true" aria-labelledby="xk-sheet-title">' +
      '<h2 id="xk-sheet-title">' + esc(tr("Remove this key?")) + "</h2>" +
      "<p>" + esc(tr("{service} stops using it. You can paste it again later.", { service: tr(slot.label) })) + "</p>" +
      '<button class="xk-pill danger wide" type="button" data-act="keys-delete" data-slot="' + esc(slot.id) + '" data-key="' + esc(askRemove.key) + '">' + esc(tr("Remove")) + "</button>" +
      '<button class="xk-pill outline wide" type="button" data-act="keys-cancel" data-slot="' + esc(slot.id) + '">' + esc(tr("Cancel")) + "</button></div>";
  }
  function detailHtml(id) {
    if (!visible()) return sectionHtml();
    load(false);
    loadDiscordHealth();
    var slot = findSlot(id);
    if (!slot) return '<div class="xk"><p class="xk-desc">' + esc(cache ? tr("Key not connected") : tr("Loading…")) + "</p></div>";
    var keys = Array.isArray(slot.keys) ? slot.keys : [];
    var out = '<div class="xk keys-settings" data-xk-detail="' + esc(slot.id) + '"><p class="xk-desc">' + esc(helpFor(slot.kind)) + "</p>" + noteHtml();
    if (slot.pace && slot.pace.reason) {
      out += '<p class="xk-desc keys-status">' + esc(tr("This service is slowing down. The same key stays in use.")) + "</p>";
    }
    if (slot.id === "discord" && discordHealth && keys.length) {
      var checked = discordHealth.at ? shortDate(Date.parse(discordHealth.at)) : "";
      var ok = discordHealth.status !== "invalid";
      out += '<section class="xk-group"><h2 class="xk-h2">' + esc(tr("Daily check")) + "</h2>" +
        row("", "pulse", ok ? tr("Discord accepted the key") : tr("Discord turned the key down"), checked ? tr("Checked {date}", { date: checked }) : "", statusLine(tone(ok ? "working" : "invalid"))) + "</section>";
    }
    out += '<section class="xk-group"><h2 class="xk-h2">' + esc(keys.length > 1 ? tr("Keys, in order of use") : tr("Key")) + "</h2>";
    keys.forEach(function (key, index) {
      var name = key.name || (keys.length > 1 ? tr("Key {n}", { n: index + 1 }) : tr(slot.label));
      var bits = [];
      if (key.updatedAt) bits.push(tr("Added {date}", { date: shortDate(key.updatedAt) }));
      bits.push(key.lastUsed ? tr("Last used {time}", { time: shortDate(key.lastUsed) }) : tr("Never used"));
      var err = errorLabel(key.lastError);
      var editing = openSlot === slot.id && openKey === key.id;
      out += '<article class="xk-key keys-item">' +
        row("", kindIcon(slot.kind), name, bits.join(" · "), statusLine(keyTone(slot, key, index))) +
        (err ? '<p class="xk-err keys-status">' + esc(err) + "</p>" : "") +
        '<p class="xk-mask keys-mask" aria-label="' + esc(tr("Saved value hidden")) + '">' + esc(tr("Value hidden")) + "</p>" +
        (editing ? pasteField(slot, key.id, key.name || "") :
          '<div class="xk-actions">' +
          '<button class="xk-pill primary" type="button" data-act="keys-replace" data-slot="' + esc(slot.id) + '" data-key="' + esc(key.id) + '">' + esc(tr("Replace key")) + "</button>" +
          '<button class="xk-pill outline" type="button" data-act="keys-test" data-slot="' + esc(slot.id) + '" data-key="' + esc(key.id) + '">' + esc(tr("Test key")) + "</button>" +
          (keys.length > 1 && index > 0 ? '<button class="xk-pill outline" type="button" data-act="keys-up" data-slot="' + esc(slot.id) + '" data-key="' + esc(key.id) + '">' + esc(tr("Move up")) + "</button>" : "") +
          (keys.length > 1 && index < keys.length - 1 ? '<button class="xk-pill outline" type="button" data-act="keys-down" data-slot="' + esc(slot.id) + '" data-key="' + esc(key.id) + '">' + esc(tr("Move down")) + "</button>" : "") +
          '<button class="xk-text danger" type="button" data-act="keys-remove-ask" data-slot="' + esc(slot.id) + '" data-key="' + esc(key.id) + '">' + esc(tr("Remove")) + "</button>" +
          "</div>") +
        "</article>";
    });
    if (!keys.length || (openSlot === slot.id && openKey === "new")) {
      out += pasteField(slot, "new", "");
    } else if (keys.length < 8) {
      out += '<button class="xk-row xk-add" type="button" data-act="keys-add" data-slot="' + esc(slot.id) + '"><span class="xk-ico">' + svg("plus") + '</span><span class="xk-copy"><b>' + esc(tr("Add another key")) + '</b><span class="xk-sub">' + esc(tr("Backups take over when the first key stops working.")) + "</span></span></button>";
    }
    return out + "</section>" + removeSheet(slot) + "</div>";
  }
  /* Site health from the Worker watchdog (worker/src/watchdog.js). Owner only.
     Problem lines come from the server in plain English. */
  var health = null;
  var healthLoading = false;
  var healthAt = 0;
  /* The Worker's own request quota is one origin of the server pool; while
     the pool has room, an exhausted Worker is only skipped (Usage shows a
     quiet note), so its alert stays out of the banner and the list. */
  function poolHasRoom() {
    var acc = window.ViktorychAccounts;
    var sp = null;
    try { sp = acc && acc.serverPool ? acc.serverPool() : null; } catch (err) { sp = null; }
    if (sp && sp.cap > 0) return sp.pct < 100 && sp.origins.some(function (o) { return !o.out; });
    var cfg = window.ViktorychAccountsConfig || window.VIKTORYCH_ACCOUNTS || {};
    return !!cfg.backupApi;
  }
  function problemsOf(doc) {
    var list = doc && Array.isArray(doc.problems) ? doc.problems : [];
    var room = poolHasRoom();
    return list.filter(function (p) { return !(p && p.code === "usage_worker_requests" && room); });
  }
  function utcMidnightLocal() {
    var d = new Date();
    var next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    try { return next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
    catch (err) { return next.getHours() + ":00"; }
  }
  /* Each entry calls tr() itself so the phrase is translated when shown. */
  var USAGE_TEXT = {
    usage_worker_requests: function (v) { return tr("Worker requests today are at {pct}% of the free limit.", v); },
    // D1 counts a UTC day, so "today" ends at 00:00 UTC, shown in local time.
    usage_d1_reads: function (v) {
      var text = tr("Database rows read today are at {pct}% of the free daily limit. The count starts again at {time}.", { pct: v.pct, time: utcMidnightLocal() });
      if (v.pct >= 90) text += " " + tr("Until then, public pages are served from a saved copy so the app keeps working.");
      return text;
    },
    usage_d1_writes: function (v) { return tr("Database rows written today are at {pct}% of the free limit.", v); },
    usage_durable: function (v) { return tr("Durable Object requests today are at {pct}% of the free limit.", v); },
    usage_r2_class_a: function (v) { return tr("Storage writes this month are at {pct}% of the free limit.", v); },
    usage_r2_class_b: function (v) { return tr("Storage reads this month are at {pct}% of the free limit.", v); },
    usage_r2_storage: function (v) { return tr("File storage is at {pct}% of the free limit.", v); },
    usage_d1_storage: function (v) { return tr("Database size is at {pct}% of the free limit.", v); }
  };
  function problemText(p) {
    if (p && USAGE_TEXT[p.code] && Number.isFinite(Number(p.ratio))) return USAGE_TEXT[p.code]({ pct: Math.round(Number(p.ratio) * 100) });
    return p ? p.text || p.code : "";
  }
  function serious(doc) {
    var list = problemsOf(doc);
    var now = Date.now();
    return list.filter(function (p) {
      return p.level === "down" || now - (Number(p.since) || now) > 2 * 3600 * 1000;
    });
  }
  function loadHealth(force) {
    if (!visible() || healthLoading) return;
    if (!force && health && Date.now() - healthAt < 15 * 60 * 1000) return;
    healthLoading = true;
    healthAt = Date.now();
    send("/v1/owner/health", force === "run" ? "POST" : "GET").then(function (body) {
      healthLoading = false;
      if (!body || body.status !== 200) return;
      health = body;
      showBanner();
      render();
    });
  }
  function showBanner() {
    var list = serious(health);
    var old = document.getElementById("owner-health-banner");
    var key = "viktorych-health-dismissed";
    // One dismissal per day per problem and threshold (warn or down).
    var sig = new Date().toISOString().slice(0, 10) + "|" + list.map(function (p) { return p.code + ":" + p.level; }).sort().join(",");
    var dismissed = "";
    try { dismissed = localStorage.getItem(key) || ""; } catch (err) { dismissed = ""; }
    if (!list.length || !visible() || dismissed === sig) {
      if (old) old.remove();
      return;
    }
    var bar = old || document.createElement("div");
    /* Placed by styles.css at the bottom, like X's toasts, so it never
       covers a page's own header or the alert banner under it. */
    bar.id = "owner-health-banner";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);z-index:9999;max-width:92vw;display:flex;gap:8px;align-items:center;padding:6px 12px;border-radius:999px;background:#f4212e;color:#fff;font:600 13px/1.3 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3)";
    bar.innerHTML = '<a href="#/settings/keys" style="color:#fff;text-decoration:none">' + esc(tr("Site health: {count} problems need you", { count: list.length })) + "</a>" +
      '<button type="button" aria-label="' + esc(tr("Dismiss")) + '" style="background:none;border:0;color:#fff;font:inherit;cursor:pointer;padding:0 2px">✕</button>';
    bar.querySelector("button").onclick = function () {
      try { localStorage.setItem(key, sig); } catch (err) { /* hides until reload */ }
      bar.remove();
    };
    if (!old) document.body.appendChild(bar);
  }
  function healthHtml() {
    loadHealth(false);
    var list = problemsOf(health);
    var when2 = health && health.at ? when(health.at) : "";
    var head = !health ? tr("Site health not checked yet") : (list.length ? tr("Site health: {count} problems need you", { count: list.length }) : tr("Site health: all good"));
    var t = !health ? tone("unknown") : (list.length ? tone("expired") : tone("working"));
    t = { cls: t.cls, text: head };
    var items = list.map(function (p) {
      return '<p class="xk-problem keys-status ' + (p.level === "down" ? "down" : "warn") + '">' + esc(problemText(p)) + "</p>";
    }).join("");
    return '<section class="xk-group"><h2 class="xk-h2">' + esc(tr("Site health")) + "</h2>" +
      '<div class="xk-row xk-health"><span class="xk-ico">' + svg("pulse") + '</span><span class="xk-copy"><span class="xk-line">' + statusLine(t) + "</span>" +
      (when2 ? '<span class="xk-sub">' + esc(when2) + "</span>" : "") + "</span>" +
      '<button class="xk-pill outline small" type="button" data-act="keys-health-check" data-slot="health">' + esc(tr("Check now")) + "</button></div>" +
      items + "</section>";
  }
  function pasteValue(slot) {
    var field = document.querySelector('[data-keys-paste="' + slot + '"]');
    var value = field ? String(field.value || "") : "";
    if (field) field.value = "";
    return value;
  }
  function labelValue(slot) {
    var field = document.querySelector('[data-keys-label="' + slot + '"]');
    var value = field ? String(field.value || "") : "";
    if (field) field.value = "";
    return value;
  }
  function slotKeys(slot) {
    var found = cache && cache.slots ? cache.slots.filter(function (item) { return item.id === slot; })[0] : null;
    return found && Array.isArray(found.keys) ? found.keys : [];
  }
  function onAct(act, el) {
    if (!visible()) return false;
    var slot = el && el.dataset ? el.dataset.slot : "";
    var key = el && el.dataset ? (el.dataset.key || "") : "";
    if (!slot) return false;
    if (act === "keys-health-check") {
      loadHealth("run");
      return true;
    }
    if (act === "keys-remove-ask") {
      askRemove = { slot: slot, key: key };
      note = "";
      render();
      return true;
    }
    if (act === "keys-cancel") {
      askRemove = null;
      openSlot = "";
      openKey = "";
      render();
      return true;
    }
    if (act === "keys-add") {
      openSlot = slot;
      openKey = "new";
      note = "";
      render();
      return true;
    }
    if (act === "keys-replace") {
      openSlot = slot;
      openKey = key;
      note = "";
      render();
      return true;
    }
    if (act === "keys-up" || act === "keys-down") {
      var keys = slotKeys(slot);
      var ids = keys.map(function (item) { return item.id; });
      var index = ids.indexOf(key);
      var next = index + (act === "keys-up" ? -1 : 1);
      if (index < 0 || next < 0 || next >= ids.length) return true;
      var swap = ids[index];
      ids[index] = ids[next];
      ids[next] = swap;
      note = "";
      send("/v1/owner/keys/" + encodeURIComponent(slot) + "/order", "POST", { ids: ids }).then(function (body) {
        if (!body || body.status !== 200) fail(body);
        load(true);
      });
      return true;
    }
    if (act === "keys-delete") {
      note = "";
      askRemove = null;
      var path = "/v1/owner/keys/" + encodeURIComponent(slot) + (key ? "/" + encodeURIComponent(key) : "");
      send(path, "DELETE").then(function (body) {
        if (!body || body.status !== 200) fail(body);
        else {
          note = tr("Deleted.");
          openSlot = "";
          openKey = "";
        }
        load(true);
      });
      return true;
    }
    if (act === "keys-test") {
      note = "";
      var testPath = "/v1/owner/keys/" + encodeURIComponent(slot) + (key ? "/" + encodeURIComponent(key) : "") + "/test";
      send(testPath, "POST", {}).then(function (body) {
        if (!body || body.status !== 200) fail(body);
        else {
          var shown = body.slot && Array.isArray(body.slot.keys) ? body.slot.keys.filter(function (item) { return item.id === key; })[0] : null;
          note = statusLabel(shown ? shown.status : body.slot && body.slot.status, true);
        }
        load(true);
      });
      return true;
    }
    if (act === "keys-save") {
      var value = pasteValue(slot);
      var label = labelValue(slot);
      if (!value.trim()) {
        note = tr("That paste was not accepted.");
        render();
        return true;
      }
      note = "";
      if (slot === "discord") discordAt = 0;
      var savePath = "/v1/owner/keys/" + encodeURIComponent(slot);
      if (key && key !== "new") savePath += "/" + encodeURIComponent(key);
      var payload = { value: value };
      if (label) payload.label = label;
      send(savePath, "PUT", payload).then(function (body) {
        value = "";
        label = "";
        if (!body || body.status !== 200) fail(body);
        else {
          note = tr("Saved.");
          openSlot = "";
          openKey = "";
        }
        load(true);
      });
      return true;
    }
    return false;
  }

  // Owner-only: check the watchdog a while after start and every half hour.
  setTimeout(function () { loadHealth(false); }, 12000);
  setInterval(function () { loadHealth(false); }, 30 * 60 * 1000);

  window.OwnerKeys = {
    visible: visible,
    sectionHtml: sectionHtml,
    detailHtml: detailHtml,
    titleFor: titleFor,
    onAct: onAct,
    load: load
  };
})();
