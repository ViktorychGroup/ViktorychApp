/* Profile badges. The Worker awards tiers. This page only shows them. */
(function (root) {
  "use strict";

  var cache = {};
  var loading = {};

  function tr(key, vars) {
    var fn = root.t || (root.SI18n && root.SI18n.t);
    return fn ? fn(key, vars) : key;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;";
    });
  }

  function accounts() {
    return root.ViktorychAccounts || null;
  }

  function title(id) {
    if (id === "member") return tr("Member");
    if (id === "streak") return tr("Login streak");
    if (id === "author") return tr("Posts");
    if (id === "voice") return tr("Comments");
    if (id === "signal") return tr("Reposts");
    if (id === "circle") return tr("Followers");
    if (id === "giver") return tr("Gifts sent");
    if (id === "kept") return tr("Gifts received");
    if (id === "story") return tr("Stories");
    if (id === "highlight") return tr("Highlights");
    if (id === "live") return tr("Went live");
    if (id === "early") return tr("Early adopter");
    if (id === "helpful") return tr("Helpful reports");
    return id;
  }

  function hint(id) {
    if (id === "member") return tr("Time since you joined");
    if (id === "streak") return tr("Days in a row you opened the app");
    if (id === "author") return tr("Posts you published");
    if (id === "voice") return tr("Comments you wrote");
    if (id === "signal") return tr("Posts you reposted");
    if (id === "circle") return tr("People who follow you");
    if (id === "giver") return tr("Gifts you sent");
    if (id === "kept") return tr("Gifts you received");
    if (id === "story") return tr("Stories you posted");
    if (id === "highlight") return tr("Highlights on your profile");
    if (id === "live") return tr("Times you went live");
    if (id === "early") return tr("Here before badges");
    if (id === "helpful") return tr("Reports that were acted on");
    return "";
  }

  function tierLabel(tier) {
    if (tier === "bronze") return tr("Bronze");
    if (tier === "silver") return tr("Silver");
    if (tier === "gold") return tr("Gold");
    return "";
  }

  function audienceLabel(id) {
    if (id === "followers") return tr("My followers");
    if (id === "mutuals") return tr("Mutuals");
    if (id === "lists") return tr("Custom lists");
    if (id === "only") return tr("Only me");
    return tr("Everyone");
  }

  function keyOf(account) {
    return String(account && account.handle || "").toLowerCase();
  }

  function pack(account) {
    return cache[keyOf(account)] || null;
  }

  var ICONS = {
    member: "\uD83D\uDCC5", streak: "\uD83D\uDD25", author: "\u270D\uFE0F", voice: "\uD83D\uDCAC",
    signal: "\uD83D\uDD01", circle: "\uD83D\uDC65", giver: "\uD83C\uDF81", kept: "\uD83D\uDC9D",
    story: "\u2B55", highlight: "\u2728", live: "\uD83D\uDD34", early: "\uD83C\uDF31", helpful: "\uD83D\uDEE1\uFE0F"
  };

  /* One plain line per badge: how it is earned. */
  function meaning(id) {
    if (id === "member") return tr("For how long you've been a member");
    if (id === "streak") return tr("For opening the app many days in a row");
    if (id === "author") return tr("For publishing posts");
    if (id === "voice") return tr("For writing comments");
    if (id === "signal") return tr("For reposting posts");
    if (id === "circle") return tr("For gaining followers");
    if (id === "giver") return tr("For sending gifts");
    if (id === "kept") return tr("For receiving gifts");
    if (id === "story") return tr("For posting stories");
    if (id === "highlight") return tr("For keeping highlights on your profile");
    if (id === "live") return tr("For going live");
    if (id === "early") return tr("For joining before badges existed");
    if (id === "helpful") return tr("For reports that were acted on");
    return hint(id);
  }

  function iconHtml(id, tier) {
    return '<span class="bdg-ico' + (tier ? " tier-" + tier : "") + '" aria-hidden="true">' + (ICONS[id] || "\u2B50") + "</span>";
  }

  function sub(card) {
    if (card.earned && card.tier) return tierLabel(card.tier) + " \u00B7 " + meaning(card.id);
    return meaning(card.id);
  }

  function rowHtml(card, mine) {
    var progress = "";
    if (mine && card.nextTier && card.goal) {
      var width = Math.max(0, Math.min(100, Math.round((Number(card.ratio) || 0) * 100)));
      progress = '<span class="bdg-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + width + '"><span style="width:' + width + '%"></span></span>';
    }
    var pin = mine && card.pinned ? '<span class="bdg-flag">' + esc(tr("Pinned")) + "</span>" : "";
    return '<button type="button" class="bdg-row' + (card.earned ? "" : " locked") + '" data-badge="open" data-id="' + esc(card.id) + '">' +
      iconHtml(card.id, card.earned ? card.tier : "") +
      '<span class="bdg-copy"><span class="bdg-name">' + esc(title(card.id)) + pin + '</span><span class="bdg-line">' + esc(sub(card)) + "</span>" + progress + "</span>" +
      '<span class="bdg-chev" aria-hidden="true">\u203A</span></button>';
  }

  function profileMine(account) {
    var api = accounts();
    var session = api && api.account && api.account();
    if (!session || !account) return false;
    if (account.publicId && session.publicId) return account.publicId === session.publicId;
    return String(account.handle || "").toLowerCase() === String(session.handle || "").toLowerCase();
  }

  var lastPack = null;
  var lastMine = false;

  function blockHtml(account) {
    ensure(account);
    var mine = profileMine(account);
    var data = pack(account);
    var head = '<div class="about-head"><h2>' + esc(tr("Badges")) + "</h2></div>";
    if (!data) {
      if (!mine) return "";
      return '<section class="about-section badge-block">' + head + '<p class="about-wait">' + esc(tr("Loading…")) + "</p></section>";
    }
    lastPack = data;
    lastMine = mine;
    var all = data.badges || [];
    var earned = all.filter(function (card) { return card.earned; });
    earned.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0); });
    var next = mine ? all.filter(function (card) { return !card.earned; }) : [];
    if (!earned.length && !next.length) {
      if (!mine) return "";
      return '<section class="about-section badge-block">' + head + '<p class="bdg-empty">' + esc(tr("No badges yet")) + "</p></section>";
    }
    var out = '<section class="about-section badge-block">' + head;
    if (earned.length) out += '<div class="bdg-list">' + earned.map(function (card) { return rowHtml(card, mine); }).join("") + "</div>";
    if (next.length) out += '<h3 class="bdg-sub">' + esc(tr("Still to earn")) + '</h3><div class="bdg-list">' + next.map(function (card) { return rowHtml(card, mine); }).join("") + "</div>";
    if (data && data.note) out += '<p class="badge-note">' + esc(data.note) + "</p>";
    return out + "</section>";
  }

  /* One small sheet explains any badge: name-row ticks, the org square,
     and every row in About me. */
  function sheet(opts) {
    var old = document.querySelector(".bdg-sheet");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "bdg-sheet";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", opts.title || "");
    el.innerHTML = '<div class="bdg-card"><button type="button" class="bdg-x" data-bdg-close="1" aria-label="' + esc(tr("Close")) + '">\u00D7</button>' +
      '<div class="bdg-hero">' + (opts.iconHtml || "") + "</div>" +
      "<h2>" + esc(opts.title || "") + "</h2>" +
      (opts.line ? "<p>" + esc(opts.line) + "</p>" : "") +
      (opts.detail ? '<p class="bdg-detail">' + esc(opts.detail) + "</p>" : "") +
      (opts.extraHtml || "") +
      (opts.href ? '<a class="bdg-btn" href="' + esc(opts.href) + '" data-bdg-close="1">' + esc(opts.linkText || tr("View profile")) + "</a>" : "") +
      "</div>";
    document.body.appendChild(el);
    var x = el.querySelector(".bdg-x");
    if (x && x.focus) x.focus();
    return el;
  }

  function audienceSelect(card) {
    var modes = ["public", "followers", "mutuals", "lists", "only"];
    return '<label class="bdg-field"><span>' + esc(tr("Who can see it")) + '</span><select data-badge="audience" data-id="' + esc(card.id) + '">' + modes.map(function (mode) {
      return '<option value="' + mode + '"' + ((card.audience || "public") === mode ? " selected" : "") + ">" + esc(audienceLabel(mode)) + "</option>";
    }).join("") + "</select></label>";
  }

  function openCard(id) {
    var data = lastPack;
    var card = data && (data.badges || []).filter(function (c) { return c.id === id; })[0];
    if (!card) return;
    var detail = "";
    if (lastMine) {
      var count = tr("{count} of {goal}", { count: card.progress || 0, goal: card.goal || 0 });
      if (card.nextTier && card.goal) detail = tr("Next: {tier}", { tier: tierLabel(card.nextTier) }) + " \u00B7 " + count;
      else if (card.earned) detail = tr("Highest level reached");
    }
    var extra = "";
    if (lastMine && card.earned) {
      extra = '<button type="button" class="bdg-btn ghost" data-badge="pin" data-id="' + esc(card.id) + '" data-pinned="' + (card.pinned ? "1" : "0") + '">' + esc(card.pinned ? tr("Unpin from top") : tr("Pin to top")) + "</button>" + audienceSelect(card);
    }
    sheet({
      iconHtml: iconHtml(card.id, card.earned ? card.tier : ""),
      title: title(card.id) + (card.earned && card.tier ? " \u00B7 " + tierLabel(card.tier) : ""),
      line: meaning(card.id),
      detail: detail,
      extraHtml: extra
    });
  }

  /* Name-row marks explain themselves on tap, the way X does. */
  function openMark(el) {
    var cls = el.classList;
    var ico = '<span class="bdg-ico mark">' + el.innerHTML + "</span>";
    if (cls.contains("exclusive")) return sheet({ iconHtml: ico, title: tr("Official account"), line: tr("This is the official account of this site.") });
    if (cls.contains("business")) return sheet({ iconHtml: ico, title: tr("Verified business"), line: tr("This account belongs to a verified organization.") });
    if (cls.contains("government")) return sheet({ iconHtml: ico, title: tr("Verified government"), line: tr("This account belongs to a government or multilateral organization.") });
    return sheet({ iconHtml: ico, title: tr("Verified account"), line: tr("This account is verified on the network it comes from.") });
  }

  function hasEarned(account) {
    var data = pack(account);
    return !!(data && data.badges && data.badges.some(function (card) { return card.earned; }));
  }

  /* Achievement unlocked: an orb pops in, the pill slides open with the
     badge name, holds, then folds away. One at a time, once per badge tier
     per account. The Worker clears seen notices, so other devices skip it too. */
  var ACH_KEY = "ach-shown-v1";
  var ACH_PREFS = "ach-prefs-v1";
  var ACH_DEFAULTS = { sound: true, chime: "classic", volume: 60, rumble: true, intensity: "medium" };
  var CHIMES = ["classic", "sparkle", "deep", "retro"];
  var INTENSITY = { light: 0.6, medium: 1, strong: 1.6 };
  var achQueue = [];
  var achBusy = false;
  var achAudio = null;
  var ACH_TIMES = { open: 520, hold: 5200, fold: 460, fade: 380 };

  function store() {
    try { return root.localStorage || null; } catch (err) { return null; }
  }

  function prefs() {
    var ls = store();
    var saved = {};
    try { saved = JSON.parse(ls && ls.getItem(ACH_PREFS) || "{}") || {}; } catch (err) { saved = {}; }
    var out = {};
    Object.keys(ACH_DEFAULTS).forEach(function (key) { out[key] = saved[key] == null ? ACH_DEFAULTS[key] : saved[key]; });
    if (CHIMES.indexOf(out.chime) < 0) out.chime = ACH_DEFAULTS.chime;
    if (!INTENSITY[out.intensity]) out.intensity = ACH_DEFAULTS.intensity;
    out.volume = Math.max(0, Math.min(100, Math.round(Number(out.volume)))) ;
    if (isNaN(out.volume)) out.volume = ACH_DEFAULTS.volume;
    out.sound = out.sound !== false;
    out.rumble = out.rumble !== false;
    return out;
  }

  function setPref(key, value) {
    if (!Object.prototype.hasOwnProperty.call(ACH_DEFAULTS, key)) return prefs();
    var next = prefs();
    next[key] = value;
    var ls = store();
    if (ls) try { ls.setItem(ACH_PREFS, JSON.stringify(next)); } catch (err) { /* stays default */ }
    return prefs();
  }

  function achAccount() {
    var api = accounts();
    var session = api && api.account && api.account();
    return String(session && (session.publicId || session.handle) || "").toLowerCase();
  }

  function shownMap() {
    var ls = store();
    try { return JSON.parse(ls && ls.getItem(ACH_KEY) || "{}") || {}; } catch (err) { return {}; }
  }

  function noticeKey(notice) {
    return String(notice && notice.id || "") + ":" + String(notice && notice.tier || "");
  }

  function wasShown(notice) {
    var list = shownMap()[achAccount()] || [];
    return list.indexOf(noticeKey(notice)) >= 0;
  }

  function markShown(notice) {
    var ls = store();
    if (!ls) return;
    var map = shownMap();
    var who = achAccount();
    var list = map[who] || [];
    if (list.indexOf(noticeKey(notice)) < 0) list.push(noticeKey(notice));
    map[who] = list.slice(-200);
    try { ls.setItem(ACH_KEY, JSON.stringify(map)); } catch (err) { /* full storage only skips the memory */ }
  }

  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (err) { return false; }
  }

  function quietNow() {
    var presence = root.ViktorychPresence;
    if (presence && presence.myState && presence.myState() === "dnd") return true;
    return !!(root.document && root.document.visibilityState === "hidden");
  }

  function mayChime() {
    var p = prefs();
    if (!p.sound || p.volume <= 0 || reducedMotion() || quietNow()) return false;
    var nav = root.navigator;
    if (nav && nav.userActivation && !nav.userActivation.hasBeenActive) return false;
    return true;
  }

  function canVibrate() {
    var nav = root.navigator;
    return !!(nav && typeof nav.vibrate === "function");
  }

  function mayRumble() {
    var p = prefs();
    return p.rumble && canVibrate() && !reducedMotion() && !quietNow();
  }

  /* Rumble in step with the toast: a tick when the orb pops, a rising
     double pulse as the pill opens. Intensity scales every pulse. */
  function rumblePattern(part, intensity) {
    var k = INTENSITY[intensity] || 1;
    var ms = function (n) { return Math.max(1, Math.round(n * k)); };
    if (part === "pop") return [ms(14)];
    if (part === "open") return [ms(20), 60, ms(36)];
    return [ms(14), ACH_TIMES.open - ms(14), ms(20), 60, ms(36)];
  }

  function rumble(part, force) {
    if (!(force ? canVibrate() : mayRumble())) return false;
    try { return root.navigator.vibrate(rumblePattern(part, prefs().intensity)) !== false; } catch (err) { return false; }
  }

  /* Original chimes, synthesized on the device. Each note: [Hz, start s, length s, wave, level]. */
  var CHIME_NOTES = {
    classic: [[523.25, 0, 0.7, "sine", 1], [1046.5, 0, 0.35, "triangle", 0.25], [783.99, 0.09, 0.7, "sine", 1], [1567.98, 0.09, 0.35, "triangle", 0.25], [1046.5, 0.18, 0.8, "sine", 1], [2093, 0.18, 0.4, "triangle", 0.25]],
    sparkle: [[1318.5, 0, 0.25, "sine", 0.8], [1661.2, 0.06, 0.25, "sine", 0.8], [1975.5, 0.12, 0.3, "sine", 0.8], [2637, 0.18, 0.5, "sine", 0.6], [3951, 0.24, 0.4, "sine", 0.3]],
    deep: [[110, 0, 1.1, "sine", 1], [164.81, 0.02, 1.0, "triangle", 0.6], [220, 0.22, 0.9, "sine", 0.7], [329.63, 0.3, 0.7, "sine", 0.35]],
    retro: [[392, 0, 0.09, "square", 0.35], [523.25, 0.09, 0.09, "square", 0.35], [659.25, 0.18, 0.09, "square", 0.35], [1046.5, 0.27, 0.3, "square", 0.35]]
  };

  function chime(name, force) {
    if (!(force || mayChime())) return false;
    var p = prefs();
    var notes = CHIME_NOTES[name || p.chime] || CHIME_NOTES.classic;
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx || p.volume <= 0) return false;
    try {
      if (!achAudio) achAudio = new Ctx();
      if (achAudio.state === "suspended" && achAudio.resume) achAudio.resume();
      var now = achAudio.currentTime + 0.02;
      var out = achAudio.createGain();
      out.gain.value = 0.09 * (p.volume / 100);
      out.connect(achAudio.destination);
      notes.forEach(function (note) {
        var osc = achAudio.createOscillator();
        var gain = achAudio.createGain();
        var at = now + note[1];
        osc.type = note[3];
        osc.frequency.setValueAtTime(note[0], at);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(note[4], at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + note[2]);
        osc.connect(gain);
        gain.connect(out);
        osc.start(at);
        osc.stop(at + note[2] + 0.05);
      });
      return true;
    } catch (err) { return false; }
  }

  function chimeLabel(id) {
    if (id === "sparkle") return tr("Sparkle");
    if (id === "deep") return tr("Deep");
    if (id === "retro") return tr("Retro");
    return tr("Classic");
  }

  function intensityLabel(id) {
    if (id === "light") return tr("Gentle");
    if (id === "strong") return tr("Strong");
    return tr("Medium");
  }

  function switchHtml(key, on, label, disabled) {
    return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-ach-set="' + key + '"' + (disabled ? " disabled" : "") + "><span>" + esc(label) + "</span><i></i></button>";
  }

  /* Settings > Notifications > Achievements. Saved on this device. */
  function settingsHtml() {
    var p = prefs();
    var vib = canVibrate();
    var calm = reducedMotion();
    var chimes = CHIMES.map(function (id) {
      var on = p.chime === id;
      return '<div class="ach-chime"><button class="outline' + (on ? " on" : "") + '" type="button" role="radio" aria-checked="' + (on ? "true" : "false") + '" data-ach-set="chime" data-value="' + id + '"' + (p.sound ? "" : " disabled") + ">" + esc(chimeLabel(id)) + "</button>" +
        '<button class="ach-play" type="button" data-ach-preview="chime" data-value="' + id + '" aria-label="' + esc(tr("Preview {name}", { name: chimeLabel(id) })) + '">\u25B6</button></div>';
    }).join("");
    var levels = ["light", "medium", "strong"].map(function (id) {
      return '<button class="outline' + (p.intensity === id ? " on" : "") + '" type="button" data-ach-set="intensity" data-value="' + id + '"' + (vib && p.rumble ? "" : " disabled") + ">" + esc(intensityLabel(id)) + "</button>";
    }).join("");
    return '<section class="ach-settings" data-ach-settings="1"><h2>' + esc(tr("Achievements")) + "</h2>" +
      '<p class="phandle">' + esc(tr("A short animation plays when you earn a badge.")) + "</p>" +
      '<button class="outline ach-demo" type="button" data-ach-preview="toast">' + esc(tr("Preview achievement")) + "</button>" +
      switchHtml("sound", p.sound, tr("Achievement sound")) +
      '<label class="ach-volume"><span>' + esc(tr("Volume")) + '</span><input type="range" min="0" max="100" step="5" value="' + p.volume + '" data-ach-set="volume" aria-label="' + esc(tr("Volume")) + '"' + (p.sound ? "" : " disabled") + "></label>" +
      '<h3 class="ach-sub">' + esc(tr("Chime")) + '</h3><div class="ach-chimes" role="radiogroup" aria-label="' + esc(tr("Chime")) + '">' + chimes + "</div>" +
      switchHtml("rumble", p.rumble && vib, tr("Achievement rumble"), !vib) +
      '<h3 class="ach-sub">' + esc(tr("Rumble strength")) + '</h3><div class="theme-row" role="group" aria-label="' + esc(tr("Rumble strength")) + '">' + levels + "</div>" +
      '<button class="outline" type="button" data-ach-preview="rumble"' + (vib ? "" : " disabled") + ">" + esc(tr("Preview rumble")) + "</button>" +
      (vib ? "" : '<p class="phandle">' + esc(tr("This device can't vibrate.")) + "</p>") +
      (calm ? '<p class="phandle">' + esc(tr("Reduce motion is on, so achievements fade in quietly without sound or rumble.")) + "</p>" : "") +
      "</section>";
  }

  function redrawSettings() {
    var box = document.querySelector("[data-ach-settings]");
    if (!box) return;
    var holder = document.createElement("div");
    holder.innerHTML = settingsHtml();
    box.parentNode.replaceChild(holder.firstChild, box);
  }

  function onSetting(el) {
    var key = el.getAttribute("data-ach-set");
    var p = prefs();
    if (key === "sound" || key === "rumble") setPref(key, !p[key]);
    else if (key === "chime") { setPref("chime", el.getAttribute("data-value")); chime(el.getAttribute("data-value"), true); }
    else if (key === "intensity") { setPref("intensity", el.getAttribute("data-value")); rumble("all", true); }
    else if (key === "volume") setPref("volume", Number(el.value));
    if (key !== "volume") redrawSettings();
  }

  function onPreview(el) {
    var kind = el.getAttribute("data-ach-preview");
    if (kind === "chime") chime(el.getAttribute("data-value"), true);
    else if (kind === "rumble") rumble("all", true);
    else if (kind === "toast") { achQueue.push({ id: "early", tier: "gold", preview: true }); achNext(); }
  }

  function achHtml(notice) {
    var name = title(notice.id) + (notice.tier ? " \u00B7 " + tierLabel(notice.tier) : "");
    return '<button type="button" class="ach-pill" data-ach-open="' + esc(notice.id) + '" aria-label="' + esc(tr("Achievement unlocked") + ": " + name) + '">' +
      '<span class="ach-orb" aria-hidden="true"><span class="ach-ring"></span><span class="ach-ico">' + (ICONS[notice.id] || "\u2B50") + "</span></span>" +
      '<span class="ach-copy"><span class="ach-kicker">' + esc(tr("Achievement unlocked")) + "</span>" +
      '<span class="ach-name">' + esc(name) + "</span>" +
      '<span class="ach-desc">' + esc(meaning(notice.id)) + "</span></span>" +
      '<span class="ach-shine" aria-hidden="true"></span></button>';
  }

  /* The same pop-out carries setting alerts. Variants: info, warning,
     critical, limit (100%) and countdown. They never mark badges as seen,
     never chime, and only critical ones rumble. */
  var POP_VARIANTS = { info: 1, warning: 1, critical: 1, limit: 1, countdown: 1, invite: 1, game: 1 };
  var POP_HOLD = { info: 7000, warning: 9000, critical: 12000, limit: 12000, countdown: 3200, invite: 30000, game: 6000 };
  var achCurrent = null;

  /* Pop-out icons are names from the app's icon set, drawn as one-colour SVG in
     the variant's accent, never emoji. */
  var POP_GLYPH = { info: "info", warning: "warning", critical: "alert", limit: "block", countdown: "alert", invite: "games", game: "games" };
  function popGlyph(name) {
    var I = root.ViktorychIcons;
    return I && I.svg ? I.svg(String(name)) : "";
  }

  function popHtml(notice) {
    var v = notice.variant;
    var label = (notice.kicker ? notice.kicker + ": " : "") + (notice.title || "");
    var buttons = "";
    if (notice.action) buttons += '<button type="button" class="ach-btn ach-btn-main" data-pop-act="action">' + esc(notice.action) + "</button>";
    if (notice.cancel) buttons += '<button type="button" class="ach-btn" data-pop-act="cancel">' + esc(notice.cancel) + "</button>";
    if (notice.dismiss !== false) buttons += '<button type="button" class="ach-btn" data-pop-act="dismiss">' + esc(notice.dismissLabel || tr("Dismiss")) + "</button>";
    if (notice.mute) buttons += '<button type="button" class="ach-btn ach-btn-quiet" data-pop-act="mute">' + esc(tr("Don't warn me about this")) + "</button>";
    return '<div class="ach-pill ach-card" data-pop-id="' + esc(notice.id || "") + '" aria-label="' + esc(label) + '">' +
      '<span class="ach-orb" aria-hidden="true"><span class="ach-ring"></span><span class="ach-ico">' + popOrb(notice, v) + "</span></span>" +
      '<span class="ach-copy"><span class="ach-kicker">' + esc(notice.kicker || "") + "</span>" +
      '<span class="ach-name" data-pop-title="1">' + esc(notice.title || "") + "</span>" +
      (notice.desc ? '<span class="ach-desc" data-pop-desc="1">' + esc(notice.desc) + "</span>" : "") +
      (buttons ? '<span class="ach-actions">' + buttons + "</span>" : "") + "</span>" +
      (v === "countdown" || notice.countdownMs ? '<span class="ach-count" aria-hidden="true"' + (notice.countdownMs ? ' style="animation-duration:' + Math.max(1000, Number(notice.countdownMs) || 0) + 'ms"' : "") + "></span>" : "") + "</div>";
  }

  /* Game invites show the inviter's photo; game achievements bring their
     own outline badge (a trusted SVG string built by game-social.js). */
  function popOrb(notice, v) {
    if (notice.avatar && /^(https:|data:image\/|\.\/|blob:)/.test(String(notice.avatar))) return '<img class="ach-ava" src="' + esc(notice.avatar) + '" alt="">';
    if (notice.avatarText) return '<span class="ach-ava ach-ava-text">' + esc(String(notice.avatarText).charAt(0).toUpperCase()) + "</span>";
    if (notice.svg && /^<svg[\s>]/.test(String(notice.svg))) return String(notice.svg);
    return popGlyph(notice.icon || POP_GLYPH[v] || "info");
  }

  function popTimes(notice) {
    var hold = Number(notice.hold) || POP_HOLD[notice.variant] || ACH_TIMES.hold;
    return { open: ACH_TIMES.open, hold: hold, fold: ACH_TIMES.fold, fade: ACH_TIMES.fade };
  }

  /* The toast and the alert share the bottom of the screen. Lift the toast
     above whichever alert is open so its buttons stay tappable. The toast
     stays position:fixed; this only sets a pixel offset. */
  var toastLiftObs = null;
  function toastStyle() {
    var doc = root.document;
    var html = doc && doc.documentElement;
    var style = html && html.style;
    if (!style || !style.setProperty || !style.removeProperty) return null;
    return style;
  }
  function applyToastLift(ach) {
    var style = toastStyle();
    if (!style) return;
    if (!ach || !ach.isConnected || !ach.classList.contains("in") || ach.classList.contains("out") || !ach.getBoundingClientRect) {
      style.removeProperty("--toast-above");
      return;
    }
    var rect = ach.getBoundingClientRect();
    if (!rect || rect.height < 1) {
      style.removeProperty("--toast-above");
      return;
    }
    var needed = Math.ceil((root.innerHeight || 0) - rect.top + 12);
    if (needed < 0) needed = 0;
    style.setProperty("--toast-above", needed + "px");
  }
  function liftToast() {
    var doc = root.document;
    if (!doc || !doc.querySelector) return;
    var style = toastStyle();
    var ach = doc.querySelector(".ach.in:not(.out)");
    if (!ach) {
      if (style) style.removeProperty("--toast-above");
      if (toastLiftObs) { toastLiftObs.disconnect(); toastLiftObs = null; }
      return;
    }
    if (root.ResizeObserver) {
      if (!toastLiftObs || toastLiftObs.el !== ach) {
        if (toastLiftObs) toastLiftObs.disconnect();
        toastLiftObs = new root.ResizeObserver(function () { applyToastLift(ach); });
        toastLiftObs.el = ach;
        toastLiftObs.observe(ach);
      }
    }
    applyToastLift(ach);
  }
  if (root.addEventListener) root.addEventListener("resize", liftToast);

  function popFinish(cur) {
    if (!cur || achCurrent !== cur) return;
    achCurrent = null;
    if (cur.el.parentNode) cur.el.parentNode.removeChild(cur.el);
    achBusy = false;
    liftToast();
    if (cur.notice.onClose) try { cur.notice.onClose(cur.reason || "timeout"); } catch (err) { /* the queue moves on */ }
    achNext();
  }

  /* Close the pop-out on screen now (Dismiss, Cancel, or a newer alert). */
  function popClose(reason) {
    var cur = achCurrent;
    if (!cur) return false;
    cur.reason = reason || "closed";
    cur.timers.forEach(function (id) { clearTimeout(id); });
    cur.timers = [];
    cur.el.classList.remove("open");
    cur.el.classList.add("out");
    liftToast();
    setTimeout(function () { popFinish(cur); }, ACH_TIMES.fade);
    return true;
  }

  function popout(notice) {
    if (!notice || !POP_VARIANTS[notice.variant]) return null;
    notice.alert = true;
    if (notice.id && achQueue.some(function (n) { return n.alert && n.id === notice.id; })) return null;
    if (notice.id && achCurrent && achCurrent.notice.id === notice.id) return null;
    if (notice.front) achQueue.unshift(notice); else achQueue.push(notice);
    achNext();
    return notice;
  }

  function achNext() {
    if (achBusy) return;
    var notice = achQueue.shift();
    if (!notice) return;
    achBusy = true;
    var alert = !!notice.alert;
    if (!notice.preview && !alert) {
      markShown(notice);
      ack(notice);
    }
    var times = alert ? popTimes(notice) : ACH_TIMES;
    var el = document.createElement("div");
    el.className = alert
      ? "ach ach-alert v-" + notice.variant + (reducedMotion() ? " calm" : "")
      : "ach tier-" + (notice.tier || "none") + (reducedMotion() ? " calm" : "");
    el.setAttribute("role", alert && (notice.variant === "critical" || notice.variant === "limit") ? "alert" : "status");
    el.setAttribute("aria-live", alert && (notice.variant === "critical" || notice.variant === "limit") ? "assertive" : "polite");
    el.innerHTML = alert ? popHtml(notice) : achHtml(notice);
    document.body.appendChild(el);
    var cur = { notice: notice, el: el, timers: [] };
    achCurrent = cur;
    var step = function (fn, ms) { var id = setTimeout(fn, ms); cur.timers.push(id); return id; };
    step(function () {
      el.classList.add("in");
      if (!alert) { chime(); rumble("pop"); } else if (notice.variant === "critical" || notice.variant === "limit") rumble("pop");
      liftToast();
    }, 30);
    step(function () { el.classList.add("open"); if (!alert) rumble("open"); if (notice.onShow) try { notice.onShow(el); } catch (err) { /* shown anyway */ } liftToast(); }, times.open);
    step(function () { el.classList.remove("open"); liftToast(); }, times.open + times.hold);
    step(function () { el.classList.add("out"); liftToast(); }, times.open + times.hold + times.fold);
    step(function () { cur.reason = "timeout"; popFinish(cur); }, times.open + times.hold + times.fold + times.fade);
  }

  function celebrate(notices) {
    (notices || []).forEach(function (notice) {
      if (!notice || !notice.id) return;
      if (wasShown(notice)) { ack(notice); return; }
      var key = noticeKey(notice);
      if (achQueue.some(function (n) { return noticeKey(n) === key; })) return;
      achQueue.push(notice);
    });
    achNext();
  }

  function openAchievement(id) {
    var api = accounts();
    var session = api && api.account && api.account();
    var data = session ? pack(session) : null;
    if (data) { lastPack = data; lastMine = true; }
    openCard(id);
  }

  function ack(notice) {
    var api = accounts();
    if (!api || !api.call || !api.token || !api.token()) return;
    api.call("/v1/badges/seen", { method: "POST", token: api.token(), body: { id: notice.id, tier: notice.tier } }).catch(function () {});
  }

  function apply(handle, body) {
    cache[String(handle || "").toLowerCase()] = body || { badges: [] };
    var api = accounts();
    if (api && api.requestRender) api.requestRender();
  }

  function ensure(account) {
    var handle = account && account.handle;
    if (!handle) return;
    var id = keyOf(account);
    if (cache[id] || loading[id]) return;
    var api = accounts();
    if (!api || !api.call || !api.token || !api.token()) return;
    var mine = profileMine(account);
    var path = mine ? "/v1/badges" : ("/v1/badges?handle=" + encodeURIComponent(handle));
    loading[id] = true;
    api.call(path, { token: api.token() }).then(function (body) {
      delete loading[id];
      if (!body || body.status !== 200) {
        cache[id] = { badges: [] };
        return;
      }
      apply(handle, body);
      if (mine && body.notices && body.notices.length) celebrate(body.notices);
    }).catch(function () { delete loading[id]; });
  }

  function patchBadge(id, body) {
    var api = accounts();
    if (!api || !api.call || !api.token || !api.token()) return Promise.resolve(null);
    return api.call("/v1/badges/" + encodeURIComponent(id), { method: "PATCH", token: api.token(), body: body }).then(function (res) {
      var session = api.account && api.account();
      var packId = session && String(session.handle || "").toLowerCase();
      if (res && res.status === 400 && res.error === "pins") {
        if (packId && cache[packId]) cache[packId].note = tr("You can pin 3 badges.");
      } else if (packId) {
        delete cache[packId];
      }
      var open = document.querySelector(".bdg-sheet");
      if (open) open.remove();
      if (api.requestRender) api.requestRender();
      return res;
    }).catch(function () { return null; });
  }

  function boot() {
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var set = target.closest("[data-ach-set]");
      if (set && set.tagName !== "INPUT") { event.preventDefault(); if (!set.disabled) onSetting(set); return; }
      var preview = target.closest("[data-ach-preview]");
      if (preview) { event.preventDefault(); if (!preview.disabled) onPreview(preview); return; }
      var pop = target.closest("[data-pop-act]");
      if (pop && achCurrent && achCurrent.el.contains && achCurrent.el.contains(pop)) {
        event.preventDefault();
        var cur = achCurrent;
        var act = pop.getAttribute("data-pop-act");
        if (cur.notice.onAction) try { cur.notice.onAction(act); } catch (err) { /* close anyway */ }
        popClose(act);
        return;
      }
      var ach = target.closest("[data-ach-open]");
      if (ach) {
        event.preventDefault();
        openAchievement(ach.getAttribute("data-ach-open") || "");
        return;
      }
      if (target.closest("[data-bdg-close]") || target.classList.contains("bdg-sheet")) {
        var open = document.querySelector(".bdg-sheet");
        if (open) open.remove();
        if (!target.closest("a[href]")) event.preventDefault();
        return;
      }
      var mark = target.closest(".vbadge");
      if (mark && mark.closest(".byline, .pname, .hcard, .drawer-name, .name") && !mark.closest(".bdg-sheet")) {
        event.preventDefault();
        event.stopPropagation();
        openMark(mark);
        return;
      }
      var el = target.closest("[data-badge]");
      if (!el || el.tagName === "SELECT") return;
      var act = el.getAttribute("data-badge");
      var id = el.getAttribute("data-id") || "";
      event.preventDefault();
      if (act === "open") { openCard(id); return; }
      if (act === "pin") patchBadge(id, { pinned: el.getAttribute("data-pinned") !== "1" });
    }, true);
    document.addEventListener("change", function (event) {
      var el = event.target;
      if (el && el.getAttribute && el.getAttribute("data-ach-set") === "volume") { onSetting(el); chime(null, true); return; }
      if (!el || el.getAttribute("data-badge") !== "audience") return;
      patchBadge(el.getAttribute("data-id") || "", { audience: el.value || "public" });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      var open = document.querySelector(".bdg-sheet");
      if (open) open.remove();
    });
    var api = accounts();
    if (api && api.token && api.token() && api.account && api.account()) ensure(api.account());
  }

  root.BadgeSheet = { open: sheet };
  root.ViktorychAchievements = {
    celebrate: celebrate,
    settingsHtml: settingsHtml,
    prefs: prefs,
    setPref: setPref,
    mayChime: mayChime,
    mayRumble: mayRumble,
    rumblePattern: rumblePattern,
    chimes: CHIMES,
    wasShown: wasShown,
    pending: function () { return achQueue.length + (achBusy ? 1 : 0); },
    popout: popout,
    popClose: popClose,
    popCurrent: function () { return achCurrent ? { id: achCurrent.notice.id, variant: achCurrent.notice.variant, el: achCurrent.el } : null; },
    popAction: function (act) {
      var cur = achCurrent;
      if (!cur || !cur.notice.alert) return false;
      if (cur.notice.onAction) cur.notice.onAction(act);
      popClose(act);
      return true;
    },
    times: ACH_TIMES
  };
  root.ProfileBadges = {
    ensure: ensure,
    blockHtml: blockHtml,
    hasEarned: hasEarned
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
