/* In-app notification sounds (owner switch notif_sounds). While the app is
   open, a new notification plays a short sound made on the device with
   WebAudio (no sound files). The sound is picked per account first, then
   per notification type, then the default; "None" keeps one quiet. Choices
   and the volume stay on this device (localStorage). With the app closed,
   push notifications use the phone's own notification sound. app.js calls
   onNew() with new unread notes and renders pageHtml() / sheetRows(). */
(function () {
  var KEY = "viktorychapp-notif-sounds-v1";
  function tr(key, vars) { return window.t ? window.t(key, vars) : key; }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* Each note: [Hz, start s, length s, wave, level, optional end Hz]. */
  var SOUNDS = {
    "default": { label: "Default", notes: [[880, 0, 0.16, "sine", 0.9], [1318.5, 0.08, 0.24, "sine", 0.7]] },
    pop: { label: "Pop", notes: [[900, 0, 0.1, "sine", 1, 280]] },
    chirp: { label: "Chirp", notes: [[1500, 0, 0.07, "sine", 0.7, 2600], [1800, 0.09, 0.08, "sine", 0.7, 3000]] },
    bell: { label: "Bell", notes: [[1046.5, 0, 0.9, "sine", 0.8], [2093, 0, 0.5, "sine", 0.25], [3136, 0, 0.3, "sine", 0.12]] },
    drop: { label: "Drop", notes: [[1400, 0, 0.2, "sine", 0.9, 480]] },
    marimba: { label: "Marimba", notes: [[659.25, 0, 0.28, "triangle", 0.9], [987.77, 0.1, 0.32, "triangle", 0.8]] },
    knock: { label: "Knock", notes: [[190, 0, 0.07, "square", 0.35, 120], [190, 0.13, 0.07, "square", 0.35, 120]] }
  };
  var ORDER = ["default", "pop", "chirp", "bell", "drop", "marimba", "knock", "none"];

  /* Notification types grouped the way Settings → Notifications names them. */
  var GROUPS = [
    { id: "replies", label: "Replies, mentions and quotes", kinds: ["reply", "mention", "quote"] },
    { id: "messages", label: "Direct messages", kinds: ["dm", "discord"] },
    { id: "likes", label: "Likes and reposts", kinds: ["like", "repost"] },
    { id: "follows", label: "Follows and requests", kinds: ["follow", "friend_request", "feed_request"] },
    { id: "posts", label: "New posts and lives", kinds: ["post", "live"] },
    { id: "games", label: "Game invites", kinds: ["game_invite", "game_other"] },
    { id: "other", label: "Everything else", kinds: [] }
  ];

  function groupOf(kind) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].kinds.indexOf(kind) >= 0) return GROUPS[i].id;
    return "other";
  }

  function read() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (err) { raw = null; }
    var out = { volume: 70, sound: "default", byType: {}, bySender: {} };
    if (!raw || typeof raw !== "object") return out;
    var vol = Number(raw.volume);
    if (isFinite(vol)) out.volume = Math.max(0, Math.min(100, Math.round(vol)));
    if (valid(raw.sound)) out.sound = raw.sound;
    if (raw.byType && typeof raw.byType === "object") {
      GROUPS.forEach(function (g) { if (valid(raw.byType[g.id])) out.byType[g.id] = raw.byType[g.id]; });
    }
    if (raw.bySender && typeof raw.bySender === "object") {
      Object.keys(raw.bySender).slice(0, 300).forEach(function (k) {
        var v = raw.bySender[k];
        if (v && valid(v.sound)) out.bySender[String(k).slice(0, 200)] = { sound: v.sound, label: String(v.label || "").slice(0, 80) };
      });
    }
    return out;
  }
  function write(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (err) { /* private mode: stays for this visit */ }
  }
  function valid(id) { return typeof id === "string" && ORDER.indexOf(id) >= 0; }

  function soundLabel(id) { return id === "none" ? tr("None") : tr(SOUNDS[id] ? SOUNDS[id].label : "Default"); }

  var ctx = null;
  function play(id, volume) {
    if (!id || id === "none" || !SOUNDS[id]) return false;
    var vol = volume == null ? read().volume : volume;
    if (vol <= 0) return false;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      if (!ctx) ctx = new Ctx();
      if (ctx.state === "suspended" && ctx.resume) ctx.resume();
      var now = ctx.currentTime + 0.02;
      var out = ctx.createGain();
      out.gain.value = 0.12 * (vol / 100);
      out.connect(ctx.destination);
      SOUNDS[id].notes.forEach(function (n) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        var at = now + n[1];
        osc.type = n[3];
        osc.frequency.setValueAtTime(n[0], at);
        if (n[5]) osc.frequency.exponentialRampToValueAtTime(n[5], at + n[2]);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(n[4], at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + n[2]);
        osc.connect(gain);
        gain.connect(out);
        osc.start(at);
        osc.stop(at + n[2] + 0.05);
      });
      api.lastPlayed = id;
      api.played += 1;
      return true;
    } catch (err) { return false; }
  }

  /* Sender keys: an account's feed id ("app:<id>", "x:handle") and its
     platform:handle form, so a pick from the profile matches either. */
  function senderKeys(note) {
    var keys = [];
    if (note.feedId) keys.push(String(note.feedId));
    var h = String(note.handle || "").replace(/^@/, "").toLowerCase();
    if (h) keys.push((note.platform || "app") + ":" + h);
    return keys;
  }

  function soundFor(note, p) {
    p = p || read();
    var keys = senderKeys(note);
    for (var i = 0; i < keys.length; i++) if (p.bySender[keys[i]]) return { sound: p.bySender[keys[i]].sound, why: "sender" };
    var g = groupOf(note.kind);
    if (p.byType[g]) return { sound: p.byType[g], why: "type" };
    return { sound: p.sound, why: "default" };
  }

  var lastAt = 0;
  function onNew(notes) {
    if (!notes || !notes.length) return "";
    var now = Date.now();
    if (now - lastAt < 1500) return "";
    var newest = notes.slice().sort(function (a, b) { return (Number(b.at) || 0) - (Number(a.at) || 0); })[0];
    var pick = soundFor(newest);
    if (pick.sound === "none") return "none";
    lastAt = now;
    play(pick.sound);
    return pick.sound;
  }

  function optionsHtml(selected, withSame) {
    var opts = withSame ? '<option value=""' + (selected ? "" : " selected") + ">" + esc(tr("Same as default")) + "</option>" : "";
    return opts + ORDER.map(function (id) {
      return '<option value="' + id + '"' + (selected === id ? " selected" : "") + ">" + esc(soundLabel(id)) + "</option>";
    }).join("");
  }

  function pickRow(label, attrs, selected, withSame, preview) {
    return '<div class="nsnd-row"><label class="nsnd-label">' + esc(label) + "</label>" +
      '<div class="nsnd-ctl"><select class="nsnd-select" ' + attrs + ' aria-label="' + esc(label) + '">' + optionsHtml(selected, withSame) + "</select>" +
      '<button class="nsnd-play" type="button" data-snd-play="' + esc(preview || "") + '" ' + attrs.replace(/data-snd=/g, "data-snd-for=") + ' aria-label="' + esc(tr("Play {name}", { name: label })) + '">\u25B6</button></div></div>';
  }

  function pageHtml() {
    var p = read();
    var types = GROUPS.map(function (g) {
      return pickRow(tr(g.label), 'data-snd="type" data-group="' + g.id + '"', p.byType[g.id] || "", true);
    }).join("");
    var senders = Object.keys(p.bySender);
    var people = senders.length
      ? senders.map(function (k) {
        var v = p.bySender[k];
        return '<div class="nsnd-row nsnd-person"><span class="nsnd-label">' + esc(v.label || k) + "</span>" +
          '<div class="nsnd-ctl"><select class="nsnd-select" data-snd="sender" data-key="' + esc(k) + '" data-label="' + esc(v.label || "") + '" aria-label="' + esc(v.label || k) + '">' + optionsHtml(v.sound, false) + "</select>" +
          '<button class="nsnd-play" type="button" data-snd-play="" data-snd-for="sender" data-key="' + esc(k) + '" aria-label="' + esc(tr("Play {name}", { name: v.label || k })) + '">\u25B6</button>' +
          '<button class="outline nsnd-remove" type="button" data-snd-remove="' + esc(k) + '">' + esc(tr("Remove")) + "</button></div></div>";
      }).join("")
      : '<p class="set-sub">' + esc(tr("Pick a sound for someone from the ⋯ menu on their profile.")) + "</p>";
    return '<div class="set-block nsnd-page">' +
      '<p class="phandle">' + esc(tr("These sounds play while the app is open. When it's closed, notifications use your phone's own notification sound.")) + "</p>" +
      "<h2>" + esc(tr("Volume")) + "</h2>" +
      '<input class="nsnd-volume" type="range" min="0" max="100" step="5" value="' + p.volume + '" data-snd="volume" aria-label="' + esc(tr("Volume")) + '">' +
      "<h2>" + esc(tr("Default sound")) + "</h2>" +
      pickRow(tr("Default sound"), 'data-snd="default"', p.sound, false) +
      "<h2>" + esc(tr("By notification type")) + "</h2>" + types +
      "<h2>" + esc(tr("By account")) + "</h2>" + people +
      "</div>";
  }

  /* Rows for the profile ⋯ sheet: one per sound, the current pick ticked. */
  function sheetRows(key, label, tick) {
    var p = read();
    var cur = p.bySender[key] ? p.bySender[key].sound : "";
    var row = function (id, text) {
      return '<button class="bell-choice" type="button" data-act="snd-sender" data-key="' + esc(key) + '" data-label="' + esc(label) + '" data-sound="' + id + '"><span class="bell-choice-label">' + esc(text) + '</span><span class="bell-mark">' + (cur === id ? tick : "") + "</span></button>";
    };
    return [row("", tr("Same as other notifications"))].concat(ORDER.map(function (id) { return row(id, soundLabel(id)); }))
      .concat(['<p class="bell-note">' + esc(tr("Plays while the app is open. Closed-app alerts use your phone's sound.")) + "</p>"]);
  }

  function setSender(key, label, sound) {
    var p = read();
    if (!key) return;
    if (!sound) delete p.bySender[key];
    else p.bySender[key] = { sound: sound, label: label || "" };
    write(p);
    if (sound) play(sound, p.volume);
  }

  function previewFor(el) {
    var p = read();
    var kind = el.getAttribute("data-snd-for");
    if (kind === "default") return p.sound;
    if (kind === "type") return p.byType[el.getAttribute("data-group")] || p.sound;
    if (kind === "sender") { var v = p.bySender[el.getAttribute("data-key")]; return v ? v.sound : p.sound; }
    return p.sound;
  }

  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-snd-play],[data-snd-remove]") : null;
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute("data-snd-remove")) {
      var p = read();
      delete p.bySender[t.getAttribute("data-snd-remove")];
      write(p);
      var row = t.closest(".nsnd-row");
      if (row) row.remove();
      return;
    }
    play(previewFor(t));
  });
  function onChange(e) {
    var el = e.target;
    var kind = el && el.getAttribute ? el.getAttribute("data-snd") : null;
    if (!kind) return;
    var p = read();
    if (kind === "volume") { p.volume = Math.max(0, Math.min(100, Number(el.value) || 0)); write(p); if (e.type === "change") play(p.sound === "none" ? "default" : p.sound, p.volume); return; }
    if (e.type !== "change") return;
    var v = el.value;
    if (kind === "default" && valid(v)) p.sound = v;
    else if (kind === "type") { if (valid(v)) p.byType[el.getAttribute("data-group")] = v; else delete p.byType[el.getAttribute("data-group")]; }
    else if (kind === "sender" && valid(v)) p.bySender[el.getAttribute("data-key")] = { sound: v, label: el.getAttribute("data-label") || "" };
    write(p);
    play(v || p.sound, p.volume);
  }
  document.addEventListener("change", onChange, true);
  document.addEventListener("input", onChange, true);

  var api = {
    sounds: ORDER.slice(),
    groups: GROUPS.map(function (g) { return g.id; }),
    groupOf: groupOf,
    read: read,
    soundFor: soundFor,
    onNew: onNew,
    play: play,
    pageHtml: pageHtml,
    sheetRows: sheetRows,
    setSender: setSender,
    lastPlayed: "",
    played: 0
  };
  window.ViktorychSounds = api;
})();
