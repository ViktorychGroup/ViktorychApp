/* Live Translate. Speech in a playing video or audio is translated in this
   browser with the viewer's own Google key, which never leaves this device
   except in requests to Google. Primary path: Gemini Live native audio.
   Fallback: Speech-to-Text, then Translation (or Chrome's on-device
   translator), then Text-to-Speech, then the device voice. */
(function (root) {
  "use strict";
  var PREFS = "viktorychapp-live-translate-v1";
  var KEY = "viktorychapp-live-translate-key";
  var USAGE = "viktorychapp-live-translate-usage";
  var DEFAULT_MODEL = "gemini-3.5-live-translate-preview";
  var LIVE_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";
  var STT_URL = "https://speech.googleapis.com/v1/speech:recognize?key=";
  var MT_URL = "https://translation.googleapis.com/language/translate/v2?key=";
  var TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize?key=";
  var VOICES_URL = "https://texttospeech.googleapis.com/v1/voices?key=";
  var LANGS = ["en", "es", "ru", "uk", "de", "fr", "it", "pt", "pl", "tr", "ar", "hi", "ja", "ko", "zh-CN"];
  var REGION = { en: "en-US", es: "es-ES", ru: "ru-RU", uk: "uk-UA", de: "de-DE", fr: "fr-FR", it: "it-IT", pt: "pt-BR", pl: "pl-PL", tr: "tr-TR", ar: "ar-XA", hi: "hi-IN", ja: "ja-JP", ko: "ko-KR", "zh-CN": "cmn-CN" };
  var GEMINI_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
  var SESSION_CHOICES = [5, 10, 20, 30];
  var DAILY_CHOICES = [10, 30, 60, 120];
  var ICON = "M12.745 20.54l10.97-8.19c.52-.38.52-1.16 0-1.54L12.745 2.62c-.62-.47-1.5-.02-1.5.77v3.94C4.58 7.86 1 12.67 1 19.89c3.17-4.46 6.32-6.26 10.24-6.47v4.35c0 .79.89 1.24 1.51.77z";
  var WORKLET = "class P extends AudioWorkletProcessor{constructor(){super();this.r=sampleRate/16000;this.a=0;this.s=0;this.n=0;this.b=new Int16Array(1600);this.i=0}" +
    "process(inp){var c=inp[0];if(c&&c.length){var x=c[0],y=c[1];for(var k=0;k<x.length;k++){this.s+=y?(x[k]+y[k])/2:x[k];this.n++;this.a+=1;if(this.a>=this.r){this.a-=this.r;var v=this.s/this.n;this.s=0;this.n=0;v=v<-1?-1:v>1?1:v;this.b[this.i++]=v<0?v*32768:v*32767;" +
    "if(this.i===1600){this.port.postMessage(this.b.buffer,[this.b.buffer]);this.b=new Int16Array(1600);this.i=0}}}}return true}}registerProcessor('lt-pcm16',P);";

  var graphs = typeof WeakMap === "function" ? new WeakMap() : null;
  var ctx = null;
  var workletReady = null;
  var media = null;
  var session = null;
  var pill = null;
  var subs = null;
  var cloudVoices = [];
  var notice = "";

  function tr(key, vars) { return root.t ? root.t(key, vars) : key; }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function ls() { try { return root.localStorage; } catch (err) { return null; } }
  function readJson(name) { try { var raw = ls() && ls().getItem(name); return raw ? JSON.parse(raw) : null; } catch (err) { return null; } }
  function writeJson(name, value) { try { if (ls()) ls().setItem(name, JSON.stringify(value)); } catch (err) { /* private mode */ } }
  function uiLang() { return root.SI18n && root.SI18n.getLang ? root.SI18n.getLang() : "en"; }
  function langName(code) {
    try { return new Intl.DisplayNames([uiLang()], { type: "language" }).of(code) || code; } catch (err) { return code; }
  }
  function englishName(code) {
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; } catch (err) { return code; }
  }
  function today() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

  function prefs() {
    var raw = readJson(PREFS) || {};
    var target = LANGS.indexOf(raw.target) >= 0 ? raw.target : (LANGS.indexOf(uiLang()) >= 0 ? uiLang() : "en");
    return {
      on: raw.on === true,
      model: typeof raw.model === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(raw.model) ? raw.model : DEFAULT_MODEL,
      engine: raw.engine === "chain" ? "chain" : "live",
      target: target,
      source: LANGS.indexOf(raw.source) >= 0 ? raw.source : "en",
      mode: ["subtitles", "voice", "both"].indexOf(raw.mode) >= 0 ? raw.mode : "both",
      voice: typeof raw.voice === "string" ? raw.voice.slice(0, 120) : "",
      duck: typeof raw.duck === "number" && raw.duck >= 0 && raw.duck <= 1 ? raw.duck : 0.2,
      chrome: raw.chrome === true,
      sessionMin: SESSION_CHOICES.indexOf(raw.sessionMin) >= 0 ? raw.sessionMin : 10,
      dailyMin: DAILY_CHOICES.indexOf(raw.dailyMin) >= 0 ? raw.dailyMin : 30
    };
  }
  function setPrefs(patch) {
    var next = prefs();
    Object.keys(patch || {}).forEach(function (k) { next[k] = patch[k]; });
    writeJson(PREFS, next);
    if (session) applyLive();
    syncPill();
    return prefs();
  }
  function apiKey() { try { return (ls() && ls().getItem(KEY)) || ""; } catch (err) { return ""; } }
  function setKey(value) {
    try {
      value = String(value || "").trim();
      if (value) ls().setItem(KEY, value.slice(0, 200)); else ls().removeItem(KEY);
    } catch (err) { /* private mode */ }
    syncPill();
  }
  function usedMs() {
    var u = readJson(USAGE);
    return u && u.day === today() && typeof u.ms === "number" ? u.ms : 0;
  }
  function addUsage(ms) { writeJson(USAGE, { day: today(), ms: usedMs() + ms }); }

  /* PCM helpers, exported for tests. */
  function toB64(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  function fromB64(text) {
    var bin = atob(text);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function pcmToFloat(bytes) {
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var out = new Float32Array(bytes.byteLength >> 1);
    for (var i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  }
  function level(pcm) {
    var sum = 0;
    for (var i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    return Math.sqrt(sum / Math.max(1, pcm.length)) / 32768;
  }
  function downsample(input, rate) {
    var ratio = rate / 16000;
    var out = new Int16Array(Math.floor(input.length / ratio));
    for (var i = 0; i < out.length; i++) {
      var from = Math.floor(i * ratio), to = Math.min(input.length, Math.floor((i + 1) * ratio)), sum = 0;
      for (var k = from; k < to; k++) sum += input[k];
      var v = sum / Math.max(1, to - from);
      v = v < -1 ? -1 : v > 1 ? 1 : v;
      out[i] = v < 0 ? v * 32768 : v * 32767;
    }
    return out;
  }
  function concatPcm(list) {
    var total = 0;
    list.forEach(function (p) { total += p.length; });
    var out = new Int16Array(total), at = 0;
    list.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  /* Sound from another site without CORS comes out silent once routed, so
     such media is left alone. */
  function capturable(el) {
    var src = el.currentSrc || el.src || "";
    if (!src || /^(blob|data|mediastream):/i.test(src)) return true;
    try {
      if (new URL(src, location.href).origin === location.origin) return true;
    } catch (err) { return false; }
    return !!el.crossOrigin;
  }
  function eligible(el) {
    return el && (el.tagName === "VIDEO" || el.tagName === "AUDIO") && el.id !== "mu-audio";
  }

  function audioCtx() {
    if (!ctx) {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC({ latencyHint: "interactive" });
    }
    if (ctx.state === "suspended" && ctx.resume) ctx.resume();
    return ctx;
  }
  function loadWorklet(ac) {
    if (!ac.audioWorklet) return Promise.resolve(false);
    if (!workletReady) {
      var url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      workletReady = ac.audioWorklet.addModule(url).then(function () { return true; }, function () { return false; });
    }
    return workletReady;
  }
  function graphFor(el) {
    var g = graphs ? graphs.get(el) : el.__ltGraph;
    if (g) return g;
    var ac = audioCtx();
    if (!ac) return null;
    g = { src: ac.createMediaElementSource(el), orig: ac.createGain(), out: ac.createGain(), sink: ac.createGain(), tap: null };
    g.sink.gain.value = 0;
    g.src.connect(g.orig);
    g.orig.connect(ac.destination);
    g.out.connect(ac.destination);
    g.sink.connect(ac.destination);
    if (graphs) graphs.set(el, g); else el.__ltGraph = g;
    return g;
  }
  function attachTap(g, onChunk) {
    var ac = audioCtx();
    return loadWorklet(ac).then(function (ok) {
      if (g.tap) { try { g.src.disconnect(g.tap); g.tap.disconnect(); } catch (err) { /* gone */ } }
      if (ok && root.AudioWorkletNode) {
        g.tap = new AudioWorkletNode(ac, "lt-pcm16", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2 });
        g.tap.port.onmessage = function (event) { onChunk(new Int16Array(event.data)); };
      } else {
        g.tap = ac.createScriptProcessor(4096, 2, 1);
        var carry = [];
        g.tap.onaudioprocess = function (event) {
          var a = event.inputBuffer.getChannelData(0), b = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : null;
          var mono = new Float32Array(a.length);
          for (var i = 0; i < a.length; i++) mono[i] = b ? (a[i] + b[i]) / 2 : a[i];
          carry.push(downsample(mono, ac.sampleRate));
          var joined = concatPcm(carry);
          carry = [];
          for (var at = 0; at + 1600 <= joined.length; at += 1600) onChunk(joined.slice(at, at + 1600));
          if (joined.length % 1600) carry.push(joined.slice(joined.length - (joined.length % 1600)));
        };
      }
      g.src.connect(g.tap);
      g.tap.connect(g.sink);
    });
  }
  function detachTap(g) {
    if (!g || !g.tap) return;
    try { g.src.disconnect(g.tap); g.tap.disconnect(); } catch (err) { /* gone */ }
    if (g.tap.port) g.tap.port.onmessage = null;
    g.tap = null;
  }

  /* Ducking: the original drops while the translation speaks. */
  function duck(on) {
    if (!session || !session.graph) return;
    var p = prefs();
    var gain = session.graph.orig.gain;
    var want = on && p.mode !== "subtitles" ? p.duck : 1;
    session.ducked = want < 1;
    try { gain.cancelScheduledValues(ctx.currentTime); gain.setTargetAtTime(want, ctx.currentTime, 0.06); } catch (err) { gain.value = want; }
  }
  function speaking(untilSec) {
    duck(true);
    clearTimeout(session.unduck);
    var wait = Math.max(0, (untilSec - ctx.currentTime) * 1000) + 350;
    session.unduck = setTimeout(function () { if (session) duck(false); }, wait);
  }
  function playPcm24(bytes) {
    if (!session || prefs().mode === "subtitles") return;
    var data = pcmToFloat(bytes);
    if (!data.length) return;
    var buf = ctx.createBuffer(1, data.length, 24000);
    buf.getChannelData(0).set(data);
    var node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(session.graph.out);
    var at = Math.max(ctx.currentTime + 0.04, session.nextAt || 0);
    node.start(at);
    session.nextAt = at + buf.duration;
    speaking(session.nextAt);
  }

  /* Subtitles sit over the bottom of the playing media. */
  function caption(text, done) {
    if (!session) return;
    var p = prefs();
    session.lines.push(text);
    if (session.lines.length > 40) session.lines.shift();
    if (p.mode === "voice") return;
    if (!subs) {
      subs = document.createElement("div");
      subs.className = "lt-subs";
      subs.setAttribute("aria-live", "polite");
      document.body.appendChild(subs);
    }
    subs.textContent = text;
    subs.hidden = false;
    clearTimeout(session.subsTimer);
    if (done) session.subsTimer = setTimeout(function () { if (subs) subs.hidden = true; }, 4500);
    place();
  }
  function place() {
    if (!session || !media) return;
    var r = media.getBoundingClientRect();
    var z = parseFloat(document.documentElement.style.zoom);
    var scale = z > 0 ? z : 1;
    var viewW = innerWidth / scale;
    var viewH = innerHeight / scale;
    var top = r.top / scale;
    var bottomEdge = r.bottom / scale;
    var leftEdge = r.left / scale;
    var width = r.width / scale;
    var on = bottomEdge > 0 && top < viewH && width > 120;
    var bottom = on ? Math.max(8, viewH - bottomEdge + 12) : 96;
    if (subs) {
      subs.style.bottom = bottom + "px";
      subs.style.left = (on ? Math.max(8, leftEdge + 12) : 12) + "px";
      subs.style.width = (on ? Math.min(width, viewW - 16) - 24 : viewW - 24) + "px";
    }
  }

  /* Gemini Live. */
  function setupMessage(p) {
    var id = p.model;
    var setup = { model: "models/" + id, generationConfig: { responseModalities: ["AUDIO"] } };
    if (/translate/i.test(id)) {
      setup.generationConfig.inputAudioTranscription = {};
      setup.generationConfig.outputAudioTranscription = {};
      setup.generationConfig.translationConfig = { targetLanguageCode: p.target, echoTargetLanguage: false };
    } else {
      setup.inputAudioTranscription = {};
      setup.outputAudioTranscription = {};
      setup.systemInstruction = { parts: [{ text: "You are a simultaneous interpreter. Translate everything you hear into " + englishName(p.target) + " (" + p.target + "). Speak only the translation, never answer or comment. Stay silent when there is no speech." }] };
      var voice = p.voice.indexOf("g:") === 0 ? p.voice.slice(2) : "";
      if (voice) setup.generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
    }
    return { setup: setup };
  }
  function openLive(s) {
    var p = prefs();
    var ws;
    try { ws = new WebSocket(LIVE_URL + encodeURIComponent(s.key)); } catch (err) { return chain(s, "socket"); }
    s.ws = ws;
    s.engine = "live";
    s.ready = false;
    var line = "";
    ws.onopen = function () { ws.send(JSON.stringify(setupMessage(p))); };
    ws.onmessage = function (event) {
      var read = typeof event.data === "string" ? Promise.resolve(event.data) : event.data && event.data.text ? event.data.text() : Promise.resolve("");
      read.then(function (text) {
        var msg;
        try { msg = JSON.parse(text); } catch (err) { return; }
        if (session !== s) return;
        if (msg.setupComplete) { s.ready = true; s.liveOk = true; syncPill(); return; }
        if (msg.goAway) { s.reconnect = true; return; }
        var sc = msg.serverContent;
        if (!sc) return;
        ((sc.modelTurn && sc.modelTurn.parts) || []).forEach(function (part) {
          if (part.inlineData && part.inlineData.data) playPcm24(fromB64(part.inlineData.data));
        });
        if (sc.outputTranscription && sc.outputTranscription.text) {
          line = (line + sc.outputTranscription.text).replace(/\s+/g, " ").slice(-220);
          caption(line.trim(), false);
        }
        if (sc.turnComplete || sc.generationComplete) {
          if (line.trim()) caption(line.trim(), true);
          line = "";
        }
        if (sc.interrupted) { s.nextAt = 0; }
      });
    };
    ws.onclose = function (event) {
      if (session !== s || s.ws !== ws) return;
      s.ws = null;
      if (s.stopping) return;
      if (s.liveOk && (s.reconnect || event.code === 1000 || event.code === 1001)) { s.reconnect = false; openLive(s); return; }
      chain(s, event.code === 1008 || event.code === 1007 ? "key" : "live");
    };
    ws.onerror = function () { /* onclose follows */ };
  }
  function applyLive() {
    if (session && session.ws && session.ready) {
      var s = session;
      s.liveOk = false;
      try { s.ws.close(1000); } catch (err) { /* closed */ }
      s.ws = null;
      openLive(s);
    }
  }

  /* Fallback chain: Speech-to-Text, Translation, Text-to-Speech. */
  function chain(s, why) {
    s.engine = "chain";
    s.why = why || "";
    s.buffer = [];
    s.bufferMs = 0;
    syncPill();
  }
  function postJson(url, body) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (res) { if (!res.ok) throw new Error("http " + res.status); return res.json(); });
  }
  function chainChunk(s, pcm, loud) {
    if (loud || s.bufferMs) { s.buffer.push(pcm); s.bufferMs += 100; }
    if (loud) s.quiet = 0; else s.quiet = (s.quiet || 0) + 100;
    if (s.bufferMs >= 8000 || (s.bufferMs >= 1500 && s.quiet >= 500)) {
      var clip = concatPcm(s.buffer);
      s.buffer = [];
      s.bufferMs = 0;
      s.queue = (s.queue || Promise.resolve()).then(function () { return chainSegment(s, clip); });
    }
  }
  function recognize(s, clip) {
    var p = prefs();
    return postJson(STT_URL + encodeURIComponent(s.key), {
      config: { encoding: "LINEAR16", sampleRateHertz: 16000, languageCode: REGION[p.source] || p.source, enableAutomaticPunctuation: true },
      audio: { content: toB64(new Uint8Array(clip.buffer, clip.byteOffset, clip.byteLength)) }
    }).then(function (data) {
      return ((data && data.results) || []).map(function (r) { return r.alternatives && r.alternatives[0] ? r.alternatives[0].transcript : ""; }).join(" ").trim();
    });
  }
  function chromeTranslate(text, p) {
    var T = root.Translator;
    if (!T || !T.create) return Promise.reject(new Error("none"));
    var from = p.source.slice(0, 2), to = p.target;
    var key = from + ">" + to;
    if (!session.translators) session.translators = {};
    if (!session.translators[key]) session.translators[key] = T.create({ sourceLanguage: from, targetLanguage: to });
    return session.translators[key].then(function (t) { return t.translate(text); });
  }
  function translateText(s, text) {
    var p = prefs();
    if (p.source === p.target) return Promise.resolve(text);
    var cloud = function () {
      return postJson(MT_URL + encodeURIComponent(s.key), { q: text, target: p.target, source: p.source.slice(0, 2), format: "text" })
        .then(function (data) { return data.data.translations[0].translatedText; });
    };
    var free = function () {
      var F = root.FeedsTranslate;
      if (!F || !F.translatePlain) throw new Error("none");
      return F.translatePlain(text, p.target).then(function (r) { if (!r || !r.text) throw new Error("none"); return r.text; });
    };
    var first = p.chrome ? chromeTranslate(text, p).catch(cloud) : cloud().catch(function () { return chromeTranslate(text, p); });
    return first.catch(free);
  }
  function speakDevice(text, p) {
    return new Promise(function (resolve) {
      var synth = root.speechSynthesis;
      if (!synth || !root.SpeechSynthesisUtterance) return resolve();
      var u = new SpeechSynthesisUtterance(text);
      u.lang = REGION[p.target] || p.target;
      var name = p.voice.indexOf("d:") === 0 ? p.voice.slice(2) : "";
      var pick = synth.getVoices().filter(function (v) { return name ? v.name === name : v.lang && v.lang.toLowerCase().indexOf(p.target.slice(0, 2).toLowerCase()) === 0; })[0];
      if (pick) u.voice = pick;
      u.onstart = function () { duck(true); };
      u.onend = u.onerror = function () { duck(false); resolve(); };
      synth.speak(u);
    });
  }
  function speakCloud(s, text, p) {
    var name = p.voice.indexOf("c:") === 0 ? p.voice.slice(2) : "";
    var voice = { languageCode: REGION[p.target] || p.target };
    if (name) voice.name = name;
    return postJson(TTS_URL + encodeURIComponent(s.key), { input: { text: text }, voice: voice, audioConfig: { audioEncoding: "MP3" } })
      .then(function (data) {
        var bytes = fromB64(data.audioContent);
        return new Promise(function (resolve, reject) { ctx.decodeAudioData(bytes.buffer, resolve, reject); });
      })
      .then(function (buf) {
        return new Promise(function (resolve) {
          if (session !== s) return resolve();
          var node = ctx.createBufferSource();
          node.buffer = buf;
          node.connect(s.graph.out);
          node.onended = resolve;
          node.start();
          speaking(ctx.currentTime + buf.duration);
        });
      });
  }
  function chainSegment(s, clip) {
    if (session !== s) return null;
    var p = prefs();
    return recognize(s, clip).then(function (heard) {
      if (!heard || session !== s) return null;
      return translateText(s, heard).then(function (said) {
        if (session !== s || !said) return null;
        caption(said, true);
        if (p.mode === "subtitles") return null;
        if (p.voice.indexOf("d:") === 0) return speakDevice(said, p);
        return speakCloud(s, said, p).catch(function () { return speakDevice(said, p); });
      });
    }).catch(function (err) {
      if (session !== s) return;
      s.chainFails = (s.chainFails || 0) + 1;
      if (s.chainFails >= 3) stop(tr("Live Translate stopped. Check that your Google key allows Speech-to-Text."));
    });
  }

  /* Cost guards: only sound from playing, unmuted media counts, with
     per-session and daily limits. */
  function onChunk(s, pcm) {
    if (session !== s || !media || media.paused || media.ended) return;
    var p = prefs();
    var loud = level(pcm) > 0.006;
    s.heard = s.heard || loud;
    s.ms += 100;
    addUsage(100);
    if (!s.heard && s.ms >= 5000 && !media.muted && media.volume > 0) {
      notice = tr("This video’s sound can’t be captured here.");
    }
    if (s.ms >= p.sessionMin * 60000) return stop(tr("Live Translate stopped after {n} minutes.", { n: p.sessionMin }));
    if (usedMs() >= p.dailyMin * 60000) return stop(tr("Today’s Live Translate limit is used up."));
    if (s.engine === "live") {
      if (s.ws && s.ready && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ realtimeInput: { audio: { data: toB64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), mimeType: "audio/pcm;rate=16000" } } }));
      }
    } else chainChunk(s, pcm, loud);
  }

  function toast(text) {
    var el = document.getElementById("toast");
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.hidden = true; }, 3200);
  }
  function start(el) {
    el = el || media;
    if (!el) return Promise.resolve(false);
    var p = prefs();
    var key = apiKey();
    if (!key) { location.hash = "#/settings/live-translate"; return Promise.resolve(false); }
    if (!capturable(el)) { notice = tr("This video’s sound can’t be captured here."); toast(notice); syncPill(); return Promise.resolve(false); }
    if (usedMs() >= p.dailyMin * 60000) { toast(tr("Today’s Live Translate limit is used up.")); return Promise.resolve(false); }
    stop();
    var g;
    try { g = graphFor(el); } catch (err) { g = null; }
    if (!g) { toast(tr("Live Translate isn’t available in this browser.")); return Promise.resolve(false); }
    media = el;
    notice = "";
    var s = { key: key, graph: g, el: el, ms: 0, lines: [], nextAt: 0, engine: "", heard: false };
    session = s;
    s.placer = setInterval(place, 250);
    return attachTap(g, function (pcm) { onChunk(s, pcm); }).then(function () {
      if (session !== s) return false;
      if (p.engine === "chain" || !root.WebSocket) chain(s, "picked"); else openLive(s);
      syncPill();
      return true;
    });
  }
  function stop(reason) {
    var s = session;
    if (!s) return;
    s.stopping = true;
    session = null;
    clearInterval(s.placer);
    clearTimeout(s.unduck);
    clearTimeout(s.subsTimer);
    if (s.ws) { try { s.ws.close(1000); } catch (err) { /* closed */ } }
    detachTap(s.graph);
    try { s.graph.orig.gain.cancelScheduledValues(0); s.graph.orig.gain.value = 1; } catch (err) { /* gone */ }
    if (root.speechSynthesis) try { root.speechSynthesis.cancel(); } catch (err) { /* none */ }
    if (subs) subs.hidden = true;
    if (reason) toast(reason);
    syncPill();
  }

  /* The pill shows while media plays, once a key is set. */
  function syncPill() {
    if (typeof document === "undefined" || !document.body) return;
    var p = prefs();
    var show = p.on && !!apiKey() && media && (session || (!media.paused && !media.ended && document.contains(media)));
    if (!show) { if (pill) pill.hidden = true; return; }
    if (!pill) {
      pill = document.createElement("button");
      pill.type = "button";
      pill.className = "lt-pill";
      pill.setAttribute("data-lt", "pill");
      document.body.appendChild(pill);
    }
    var label = session ? tr("Translating to {language}", { language: langName(p.target) }) : notice ? notice : tr("Translate audio");
    pill.classList.toggle("on", !!session);
    pill.setAttribute("aria-pressed", session ? "true" : "false");
    pill.title = label;
    pill.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + ICON + '"/></svg><span class="lt-clip"><span class="lt-text">' + esc(label) + "</span></span>";
    pill.hidden = false;
    var clip = pill.querySelector(".lt-clip"), text = pill.querySelector(".lt-text");
    pill.classList.toggle("long", !!(clip && text && text.scrollWidth > clip.clientWidth + 1));
  }

  function voiceOptions(p) {
    var opt = function (value, label) { return '<option value="' + esc(value) + '"' + (p.voice === value ? " selected" : "") + ">" + esc(label) + "</option>"; };
    var device = root.speechSynthesis ? root.speechSynthesis.getVoices().filter(function (v) { return v.lang && v.lang.toLowerCase().indexOf(p.target.slice(0, 2).toLowerCase()) === 0; }) : [];
    return opt("", tr("Automatic")) +
      '<optgroup label="' + esc(tr("Gemini voices")) + '">' + GEMINI_VOICES.map(function (v) { return opt("g:" + v, v); }).join("") + "</optgroup>" +
      (cloudVoices.length ? '<optgroup label="' + esc(tr("Google Cloud voices")) + '">' + cloudVoices.map(function (v) { return opt("c:" + v, v); }).join("") + "</optgroup>" : "") +
      (device.length ? '<optgroup label="' + esc(tr("Device voices")) + '">' + device.map(function (v) { return opt("d:" + v.name, v.name); }).join("") + "</optgroup>" : "");
  }
  function sw(on, act, label, desc) {
    return '<button class="tab-switch' + (on ? " on" : "") + '" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" data-lt="' + act + '"><span>' + esc(label) + "</span><i></i></button>" +
      (desc ? '<p class="phandle set-desc">' + esc(desc) + "</p>" : "");
  }
  function pills(name, current, list) {
    return '<div class="theme-row lt-row" role="group">' + list.map(function (row) {
      return '<button class="outline' + (current === row[0] ? " on" : "") + '" type="button" data-lt="' + name + '" data-value="' + esc(row[0]) + '">' + esc(row[1]) + "</button>";
    }).join("") + "</div>";
  }
  function select(field, current, list, label) {
    return '<select class="tr-select" data-lt-field="' + field + '" aria-label="' + esc(label) + '">' + list.map(function (row) {
      return '<option value="' + esc(row[0]) + '"' + (String(current) === String(row[0]) ? " selected" : "") + ">" + esc(row[1]) + "</option>";
    }).join("") + "</select>";
  }
  function inner() {
    var p = prefs();
    var key = apiKey();
    var langs = LANGS.map(function (c) { return [c, langName(c)]; });
    var out = sw(p.on, "on", tr("Live Translate"), tr("Hear and read videos in your language while they play. Off until you turn it on."));
    if (!p.on) return out;
    out += "<h2>" + esc(tr("Your Google key")) + "</h2>" +
      '<p class="phandle">' + esc(tr("Stays on this device. It is sent only to Google when you translate, and Google bills your own account.")) + "</p>" +
      (key
        ? '<p class="phandle lt-key">' + esc(tr("Key saved on this device")) + " · …" + esc(key.slice(-4)) + '</p><button class="outline" type="button" data-lt="key-forget">' + esc(tr("Remove key")) + "</button>"
        : '<label class="search"><input type="password" autocomplete="off" spellcheck="false" data-lt-field="key" placeholder="AIza…" aria-label="' + esc(tr("Google API key")) + '"></label>');
    out += "<h2>" + esc(tr("Translate to")) + "</h2>" + select("target", p.target, langs, tr("Translate to"));
    out += "<h2>" + esc(tr("Show")) + "</h2>" + pills("mode", p.mode, [["subtitles", tr("Subtitles")], ["voice", tr("Voice")], ["both", tr("Both")]]);
    out += "<h2>" + esc(tr("Voice")) + '</h2><select class="tr-select" data-lt-field="voice" aria-label="' + esc(tr("Voice")) + '">' + voiceOptions(p) + "</select>" +
      (key ? '<button class="outline" type="button" data-lt="voices">' + esc(tr("Load Google Cloud voices")) + "</button>" : "");
    out += "<h2>" + esc(tr("Original sound while translating")) + '</h2><label class="lt-range"><input type="range" min="0" max="100" step="5" value="' + Math.round(p.duck * 100) + '" data-lt-field="duck" aria-label="' + esc(tr("Original sound while translating")) + '"><span>' + Math.round(p.duck * 100) + "%</span></label>";
    out += "<h2>" + esc(tr("Engine")) + "</h2>" + pills("engine", p.engine, [["live", "Gemini Live"], ["chain", tr("Speech, Translate, Speech")]]) +
      '<p class="phandle">' + esc(tr("Gemini Live speaks the translation directly. If it can’t connect, Speech-to-Text, Translation and Text-to-Speech take over, then this device’s voice.")) + "</p>" +
      '<label class="search"><input type="text" spellcheck="false" autocomplete="off" data-lt-field="model" value="' + esc(p.model) + '" aria-label="' + esc(tr("Gemini model")) + '"></label>' +
      '<p class="phandle">' + esc(tr("Gemini model")) + "</p>";
    out += "<h2>" + esc(tr("Spoken language")) + "</h2>" + select("source", p.source, langs, tr("Spoken language")) +
      '<p class="phandle">' + esc(tr("Used by the fallback. Gemini Live hears the language by itself.")) + "</p>";
    if (root.Translator) out += sw(p.chrome, "chrome", tr("Use Chrome’s built-in translator"), tr("Translates on this device in the fallback instead of Google Cloud Translation."));
    out += "<h2>" + esc(tr("Limits")) + "</h2>" +
      '<p class="phandle">' + esc(tr("Each session")) + "</p>" + select("sessionMin", p.sessionMin, SESSION_CHOICES.map(function (n) { return [n, tr("{n} min", { n: n })]; }), tr("Each session")) +
      '<p class="phandle">' + esc(tr("Each day")) + "</p>" + select("dailyMin", p.dailyMin, DAILY_CHOICES.map(function (n) { return [n, tr("{n} min", { n: n })]; }), tr("Each day")) +
      '<p class="phandle">' + esc(tr("Used today: {used} of {max} min", { used: Math.round(usedMs() / 60000), max: p.dailyMin })) + "</p>" +
      '<p class="phandle">' + esc(tr("Only sound from playing videos counts. Translation stops when the video pauses.")) + "</p>";
    out += '<p class="phandle">' + esc(tr("Videos from sites that don’t share their sound, such as YouTube, can’t be translated.")) + "</p>";
    return out;
  }
  function settingsHtml() { return '<div class="lt-settings" id="lt-settings">' + inner() + "</div>"; }
  function repaint() {
    var box = document.getElementById("lt-settings");
    if (box) box.innerHTML = inner();
  }
  function loadVoices() {
    var p = prefs();
    return fetch(VOICES_URL + encodeURIComponent(apiKey()) + "&languageCode=" + encodeURIComponent(REGION[p.target] || p.target), { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(function (res) { if (!res.ok) throw new Error("http"); return res.json(); })
      .then(function (data) { cloudVoices = ((data && data.voices) || []).map(function (v) { return v.name; }).filter(Boolean).sort(); repaint(); })
      .catch(function () { toast(tr("Couldn’t load voices. Check that your key allows Text-to-Speech.")); });
  }

  if (typeof document !== "undefined") {
    document.addEventListener("play", function (event) {
      var el = event.target;
      if (!eligible(el)) return;
      if (session && session.el !== el) stop();
      media = el;
      if (!session) notice = "";
      syncPill();
    }, true);
    ["pause", "ended", "emptied"].forEach(function (type) {
      document.addEventListener(type, function (event) {
        if (event.target !== media) return;
        if (session && type !== "pause") stop();
        syncPill();
      }, true);
    });
    document.addEventListener("visibilitychange", function () { if (document.hidden && session && media && media.tagName === "VIDEO") stop(); });
    addEventListener("hashchange", function () { setTimeout(function () { if (media && !document.contains(media)) { stop(); media = null; syncPill(); } }, 400); });
    document.addEventListener("click", function (event) {
      var el = event.target.closest && event.target.closest("[data-lt]");
      if (!el) return;
      var act = el.getAttribute("data-lt");
      var p = prefs();
      if (act === "pill") { event.preventDefault(); if (session) stop(); else start(media); return; }
      if (act === "on") { if (p.on) stop(); setPrefs({ on: !p.on }); }
      else if (act === "chrome") setPrefs({ chrome: !p.chrome });
      else if (act === "mode") setPrefs({ mode: el.getAttribute("data-value") });
      else if (act === "engine") setPrefs({ engine: el.getAttribute("data-value") });
      else if (act === "key-forget") { stop(); setKey(""); }
      else if (act === "voices") { loadVoices(); return; }
      else return;
      repaint();
    });
    var field = function (event) {
      var el = event.target;
      var name = el && el.getAttribute && el.getAttribute("data-lt-field");
      if (!name) return;
      if (name === "duck") {
        var label = el.parentNode.querySelector("span");
        if (label) label.textContent = el.value + "%";
        setPrefs({ duck: Math.max(0, Math.min(1, Number(el.value) / 100)) });
        if (session && session.ducked) duck(true);
        return;
      }
      if (event.type !== "change") return;
      if (name === "key") { setKey(el.value); el.value = ""; }
      else if (name === "sessionMin" || name === "dailyMin") { var o = {}; o[name] = Number(el.value); setPrefs(o); }
      else if (name === "model") setPrefs({ model: /^[A-Za-z0-9._-]{1,80}$/.test(el.value.trim()) ? el.value.trim() : DEFAULT_MODEL });
      else { var q = {}; q[name] = el.value; setPrefs(q); }
      repaint();
    };
    document.addEventListener("change", field);
    document.addEventListener("input", field);
    if (root.speechSynthesis && root.speechSynthesis.addEventListener) root.speechSynthesis.addEventListener("voiceschanged", function () { repaint(); });
  }

  root.ViktorychLiveTranslate = {
    settingsHtml: settingsHtml,
    prefs: prefs,
    setPrefs: setPrefs,
    hasKey: function () { return !!apiKey(); },
    start: start,
    stop: stop,
    state: function () {
      return {
        active: !!session, engine: session ? session.engine : "", why: session ? session.why || "" : "",
        ready: !!(session && session.ready), ms: session ? session.ms : 0, lines: session ? session.lines.slice() : [],
        duck: session ? session.graph.orig.gain.value : 1, ducked: !!(session && session.ducked), notice: notice, usedMs: usedMs()
      };
    },
    _setup: setupMessage,
    _downsample: downsample,
    _capturable: capturable,
    DEFAULT_MODEL: DEFAULT_MODEL
  };
})(typeof window !== "undefined" ? window : globalThis);
