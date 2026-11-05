/* Hardware talk button and low-volume speech for Viktrych.
   A page only learns a button that actually arrives. Power, volume and
   assistant keys are not intercepted. Browser speech recognition is not
   treated as a whisper model. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.ViktorychVoice = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var BLOCKED = {
    Power: 1, VolumeUp: 1, VolumeDown: 1, VolumeMute: 1,
    AudioVolumeUp: 1, AudioVolumeDown: 1, AudioVolumeMute: 1,
    LaunchAssistant: 1, MicrophoneToggle: 1, WakeUp: 1, Standby: 1
  };
  var MEDIA = ["play", "pause", "playpause", "previoustrack", "nexttrack", "stop"];
  var LIMITS = ["power", "volume", "assistant"];

  function typingKey(code) {
    return /^(Key|Digit|Numpad)/.test(code) || code === "Space" || code === "Enter" || code === "Backspace";
  }
  function fromKey(event) {
    if (!event) return { ok: false, reason: "empty" };
    var code = String(event.code || "");
    if (!code) return { ok: false, reason: "empty" };
    if (BLOCKED[code]) return { ok: false, reason: "os-button" };
    if (event.repeat) return { ok: false, reason: "repeat" };
    if (event.metaKey || event.ctrlKey || event.altKey) return { ok: false, reason: "shortcut" };
    if (event.typing && typingKey(code)) return { ok: false, reason: "typing" };
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
      if (event.repeat || event.typing && typingKey(binding.code)) return false;
      return event.code === binding.code;
    }
    return binding.kind === "media" && event.kind === "media" && event.action === binding.action;
  }
  function speechCapability(env) {
    env = env || {};
    var browser = !!env.speechRecognition;
    var local = !!(browser && env.processLocally);
    return {
      browserRecognition: browser,
      onDeviceRecognition: local,
      whisperModel: false,
      gain: !!env.autoGain,
      noiseSuppression: !!env.noiseSuppression,
      honest: "browser-no-whisper"
    };
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
    var avg = sum / list.length;
    var heard = peak >= 0.01;
    var quiet = peak < 0.05;
    var sensitivity = quiet ? 85 : Math.max(25, Math.min(90, Math.round(0.04 / Math.max(peak, 0.02) * 70)));
    return {
      heard: heard,
      peak: Math.round(peak * 1000) / 1000,
      avg: Math.round(avg * 1000) / 1000,
      quiet: quiet,
      sensitivity: sensitivity
    };
  }
  function consequential(text) {
    return /\b(block|mute|unmute|unblock|delete|download|apply|erase|set up)\b|borrar|eliminar|удал|заблок|हटा|ब्लॉक|डाउनलोड/i.test(String(text || ""));
  }
  function gate(opts) {
    opts = opts || {};
    var text = String(opts.text || "").trim();
    if (!text) return { send: false, readback: false, reason: "empty" };
    var confidence = opts.confidence == null ? null : Number(opts.confidence);
    var whisper = !!opts.whisper;
    var unsure = confidence == null || !isFinite(confidence) || confidence < (whisper ? 0.85 : 0.72);
    if (whisper || unsure || consequential(text)) {
      return { send: false, readback: true, reason: whisper ? "whisper" : (unsure ? "confidence" : "action") };
    }
    return { send: true, readback: false, reason: "clear" };
  }
  return {
    fromKey: fromKey,
    fromMedia: fromMedia,
    matches: matches,
    limitations: function () { return LIMITS.slice(); },
    mediaActions: function () { return MEDIA.slice(); },
    speechCapability: speechCapability,
    micConstraints: micConstraints,
    calibrate: calibrate,
    gate: gate,
    consequential: consequential
  };
});
