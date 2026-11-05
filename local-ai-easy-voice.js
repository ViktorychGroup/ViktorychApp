/* Easy voice for Viktrych. Spoken requests stay on the device.
   The screen reader here is the page's own labels, not a screenshot
   and not a remote vision service. A highlight is allowed only for a
   control that is actually in view. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychEasyVoice = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var BLOCKED = {
    Power: 1, VolumeUp: 1, VolumeDown: 1, VolumeMute: 1,
    AudioVolumeUp: 1, AudioVolumeDown: 1, AudioVolumeMute: 1,
    LaunchAssistant: 1, MicrophoneToggle: 1, WakeUp: 1, Standby: 1
  };
  var MEDIA = ["play", "pause", "playpause", "previoustrack", "nexttrack", "stop"];
  var STOP = { open: 1, the: 1, this: 1, that: 1, please: 1, want: 1, show: 1, with: 1, and: 1, for: 1, app: 1, page: 1, me: 1, my: 1, to: 1, a: 1 };
  var PAGES = [
    { id: "settings", href: "#/settings", words: ["settings", "ajustes", "configuración", "configuracion", "настройки", "सेटिंग"] },
    { id: "home", href: "#/", words: ["home", "inicio", "главная", "главную", "होम"] },
    { id: "explore", href: "#/explore", words: ["explore", "explorar", "обзор"] },
    { id: "notifications", href: "#/notifications", words: ["notifications", "notificaciones", "уведомления"] },
    { id: "messages", href: "#/messages", words: ["messages", "inbox", "mensajes", "сообщения"] },
    { id: "lists", href: "#/lists", words: ["lists", "listas", "списки"] },
    { id: "bookmarks", href: "#/bookmarks", words: ["bookmarks", "guardados", "закладки"] },
    { id: "history", href: "#/history", words: ["history", "historial", "история"] },
    { id: "display", href: "#/settings/display", words: ["display", "pantalla", "оформление"] }
  ];

  function norm(text) { return String(text || "").toLowerCase(); }
  function tokens(text) { return norm(text).split(/[\s,.;:!?]+/).filter(Boolean); }
  function hrefOf(value) { return String(value || "").split("?")[0]; }

  function fromKey(event) {
    if (!event) return { ok: false, reason: "empty" };
    var code = String(event.code || "");
    if (!code) return { ok: false, reason: "empty" };
    if (BLOCKED[code]) return { ok: false, reason: "os-button" };
    if (event.repeat) return { ok: false, reason: "repeat" };
    if (event.metaKey || event.ctrlKey || event.altKey) return { ok: false, reason: "shortcut" };
    var typing = /^(Key|Digit|Numpad)/.test(code) || code === "Space" || code === "Enter" || code === "Backspace";
    if (event.typing && typing) return { ok: false, reason: "typing" };
    return { ok: true, binding: { kind: "key", code: code, key: String(event.key || "").slice(0, 16) } };
  }
  function fromMedia(action) {
    var name = String(action || "");
    if (MEDIA.indexOf(name) < 0) return { ok: false, reason: "media" };
    return { ok: true, binding: { kind: "media", action: name } };
  }
  function matches(binding, event) {
    if (!binding || !event) return false;
    if (binding.kind === "key") {
      var typing = /^(Key|Digit|Numpad)/.test(binding.code) || binding.code === "Space";
      if (event.repeat || (event.typing && typing)) return false;
      return event.code === binding.code;
    }
    return binding.kind === "media" && event.kind === "media" && event.action === binding.action;
  }

  function recognitionChoice(env) {
    env = env || {};
    if (env.processLocally && env.speechRecognition) return { mode: "local", reason: "on-device" };
    if (env.speechRecognition && env.allowCloud) return { mode: "cloud", reason: "browser-service" };
    if (env.speechRecognition) return { mode: "typed", reason: "would-leave-device" };
    return { mode: "typed", reason: "none" };
  }
  function recognitionError(code) {
    var denied = code === "not-allowed" || code === "service-not-allowed";
    return { listening: false, typed: true, reason: denied ? "denied" : "error" };
  }
  function see(env) {
    env = env || {};
    if (env.downloaded === true && env.local === true && env.kind === "vision") return { mode: "local-model", remote: false };
    return { mode: "dom", remote: false, reason: "labels" };
  }
  function pickVoice(voices, lang) {
    var list = Array.isArray(voices) ? voices : [];
    var prefix = String(lang || "en").slice(0, 2).toLowerCase();
    var localLang = list.filter(function (voice) { return voice && voice.localService === true && String(voice.lang || "").toLowerCase().indexOf(prefix) === 0; });
    if (localLang.length) return { voice: localLang[0], local: true };
    var local = list.filter(function (voice) { return voice && voice.localService === true; });
    if (local.length) return { voice: local[0], local: true };
    var knows = list.some(function (voice) { return voice && typeof voice.localService === "boolean"; });
    if (knows) return { voice: null, local: false, reason: "remote-only" };
    if (list.length) return { voice: list[0], local: false, reason: "unknown" };
    return { voice: null, local: false, reason: "none" };
  }
  function gate(opts) {
    opts = opts || {};
    var text = String(opts.text || "").trim();
    if (!text) return { send: false, readback: false, reason: "empty" };
    var confidence = opts.confidence == null ? null : Number(opts.confidence);
    var whisper = !!opts.whisper;
    var unsure = confidence == null || !isFinite(confidence) || confidence < (whisper ? 0.85 : 0.72);
    var act = /\b(block|mute|unmute|unblock|delete|download|apply|post|publish)\b|borrar|eliminar|удал|заблок|हटा|ब्लॉक/i.test(text);
    if (whisper || unsure || act) return { send: false, readback: true, reason: whisper ? "whisper" : (unsure ? "confidence" : "action") };
    return { send: true, readback: false, reason: "clear" };
  }
  function micConstraints(supported, sensitivity) {
    supported = supported || {};
    var level = Math.max(0, Math.min(100, Number(sensitivity) || 0));
    var audio = {};
    if (supported.echoCancellation) audio.echoCancellation = true;
    if (supported.noiseSuppression) audio.noiseSuppression = level < 70;
    if (supported.autoGainControl) audio.autoGainControl = level >= 60;
    return { audio: Object.keys(audio).length ? audio : true, applied: Object.keys(audio) };
  }
  function calibrate(samples) {
    var list = Array.isArray(samples) ? samples : [];
    if (!list.length) return { heard: false, peak: 0, avg: 0, quiet: true, sensitivity: 80 };
    var peak = 0;
    var sum = 0;
    list.forEach(function (value) {
      var n = Number(value) || 0;
      if (n > peak) peak = n;
      sum += n;
    });
    var quiet = peak < 0.05;
    return {
      heard: peak >= 0.01,
      peak: Math.round(peak * 1000) / 1000,
      avg: Math.round((sum / list.length) * 1000) / 1000,
      quiet: quiet,
      sensitivity: quiet ? 85 : Math.max(25, Math.min(90, Math.round(0.04 / Math.max(peak, 0.02) * 70)))
    };
  }

  function canHighlight(box, view) {
    if (!box || !view) return false;
    var left = Number(box.left);
    var top = Number(box.top);
    var width = Number(box.width);
    var height = Number(box.height);
    var vw = Number(view.width);
    var vh = Number(view.height);
    if (!(width >= 8) || !(height >= 8) || !(vw > 0) || !(vh > 0)) return false;
    var right = left + width;
    var bottom = top + height;
    var overlapW = Math.min(right, vw) - Math.max(left, 0);
    var overlapH = Math.min(bottom, vh) - Math.max(top, 0);
    if (overlapW < 24 || overlapH < 24) return false;
    var cx = left + width / 2;
    var cy = height > vh ? Math.min(Math.max(top, 12), vh - 12) : top + height / 2;
    return cx >= 0 && cy >= 0 && cx <= vw && cy <= vh;
  }
  function controlScore(text, control) {
    if (!control || control.visible !== true || control.inView !== true) return 0;
    var href = hrefOf(control.href);
    var label = " " + norm(control.label) + " ";
    var said = norm(text);
    var score = 0;
    PAGES.forEach(function (page) {
      if (!page.words.some(function (word) { return said.indexOf(word) >= 0; })) return;
      if (page.href === "#/") {
        if (href === "#/" || href === "#" || href === "") score = Math.max(score, 5);
        return;
      }
      if (href === page.href) score = Math.max(score, 5);
    });
    tokens(text).forEach(function (word) {
      if (word.length < 4 || STOP[word]) return;
      if (label.indexOf(" " + word + " ") >= 0 || label.indexOf(word) >= 0 && word.length >= 6) score += 2;
    });
    return score;
  }
  function findGuide(text, controls) {
    var visible = [];
    var hidden = 0;
    (controls || []).forEach(function (control) {
      var probe = {};
      Object.keys(control || {}).forEach(function (key) { probe[key] = control[key]; });
      probe.visible = true;
      probe.inView = true;
      var score = controlScore(text, probe);
      if (score <= 0) return;
      if (control.visible === true && control.inView === true) visible.push({ control: control, score: score });
      else hidden += 1;
    });
    if (!visible.length) return { target: null, reason: hidden ? "offscreen" : "none" };
    visible.sort(function (a, b) { return b.score - a.score; });
    var top = visible[0].score;
    if (top < 2) return { target: null, reason: "weak" };
    var best = visible.filter(function (row) { return row.score === top; });
    var keys = {};
    best.forEach(function (row) { keys[(row.control.href || "") + "|" + (row.control.label || "")] = 1; });
    if (Object.keys(keys).length > 1) return { target: null, reason: "ambiguous" };
    return { target: best[0].control, reason: "label" };
  }

  function sensitiveAction(step) {
    var name = String(step && step.name || "");
    return name.indexOf("person.") === 0 || name === "tab.close" || name === "tab.create" || name === "tab.customize" || name === "compose.draft" || name === "list.draft";
  }
  function sensitiveChange(change) {
    if (!change) return false;
    if (change.risky || change.person) return true;
    var row = change.row || {};
    return row.risk === "privacy" || row.risk === "danger";
  }
  function playbackIntent(text) {
    var said = norm(text);
    if (!/video|playback|vídeo|видео|वीडियो/.test(said)) return null;
    if (/pause|stop|pausa|пауза|रोको/.test(said)) return "pause";
    if (/play|resume|reanuda|играй|चलाओ/.test(said)) return "play";
    return null;
  }
  function readIntent(text) {
    return /read (this|it|that|aloud|the post)|léelo|léeme|прочитай|पढ़ो|read aloud/i.test(String(text || ""));
  }
  function bind(actions) {
    if (!actions || !actions.register || !actions.catalog) return { ok: false };
    if (actions.catalog().some(function (row) { return row.name === "nav.profile"; })) return { ok: true };
    return actions.register({
      id: "nav.profile",
      effect: "nav",
      needsConfirm: true,
      validate: function (text) {
        var match = /@([A-Za-z0-9_]{1,20})\b/.exec(String(text || ""));
        if (!match) return null;
        if (!/(open|go|show|profile|abrir|abre|perfil|открой|профиль|खोलो|प्रोफ़ाइल)/i.test(text)) return null;
        var handle = "@" + match[1];
        if (String(text).toLowerCase().indexOf(handle.toLowerCase()) < 0) return null;
        return { name: "nav.profile", handle: handle, hash: "#/@" + match[1], effect: "nav" };
      },
      preview: function (step) { return step && step.handle || ""; }
    });
  }
  function decide(text, ctx) {
    ctx = ctx || {};
    text = String(text || "").trim();
    var actionsApi = ctx.actions;
    if (actionsApi) bind(actionsApi);
    var actions = [];
    var settings = { changes: [], opens: [], reads: [] };
    if (text && actionsApi && actionsApi.propose) {
      try { actions = actionsApi.propose(text, ctx.actionCtx || {}) || []; } catch (err) { actions = []; }
    }
    if (text && ctx.ai && ctx.ai.parse && ctx.ai.plan) {
      try {
        var parsed = ctx.ai.parse(text);
        settings = ctx.ai.plan(parsed.calls, ctx.current || {}, { typed: text }) || settings;
      } catch (err) { settings = { changes: [], opens: [], reads: [] }; }
    }
    var guide = findGuide(text, ctx.controls || []);
    var play = playbackIntent(text);
    var read = readIntent(text) ? { ok: !!String(ctx.readable || "").trim(), text: String(ctx.readable || "").trim().slice(0, 600) } : null;
    var sensitive = actions.some(sensitiveAction) || (settings.changes || []).some(sensitiveChange);
    var work = actions.length > 0 || (settings.changes || []).length > 0 || !!play || !!read;
    var known = work || !!guide.target || guide.reason === "offscreen" || guide.reason === "ambiguous";
    return {
      ok: !!text && known,
      text: text,
      actions: actions,
      settings: settings,
      guide: guide,
      play: play,
      read: read,
      needsConfirm: work,
      sensitive: sensitive,
      posted: false,
      page: String(ctx.page || ""),
      vision: see(ctx.vision)
    };
  }

  return {
    fromKey: fromKey,
    fromMedia: fromMedia,
    matches: matches,
    limitations: function () { return ["power", "volume", "assistant"]; },
    mediaActions: function () { return MEDIA.slice(); },
    recognitionChoice: recognitionChoice,
    recognitionError: recognitionError,
    see: see,
    pickVoice: pickVoice,
    gate: gate,
    micConstraints: micConstraints,
    calibrate: calibrate,
    canHighlight: canHighlight,
    findGuide: findGuide,
    bind: bind,
    decide: decide
  };
});
