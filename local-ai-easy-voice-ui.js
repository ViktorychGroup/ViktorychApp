/* Large Talk control, spoken guidance, and an on-screen spotlight.
   Microphone capture starts only from a tap or a saved key.
   Nothing here screenshots the page or uploads audio. */
(function () {
  "use strict";
  var KEY = "viktorych-ai-easy-voice-v1";
  var E = { binding: null, whisper: false, level: 70, callout: true, allowCloud: false, state: "ready", heard: null, plan: null, undo: null, learn: false, note: "", rec: null, box: null };
  function tr(key, vars) {
    var fn = window.t || window.tr;
    return fn ? fn(key, vars) : key;
  }
  function engine() { return window.ViktorychEasyVoice; }
  function host() { return window.ViktorychEasyVoiceHost || null; }
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null") || {}; } catch (err) { return {}; }
  }
  function write() {
    try { localStorage.setItem(KEY, JSON.stringify({ binding: E.binding, whisper: !!E.whisper, sensitivity: E.level, callout: E.callout !== false, allowCloud: !!E.allowCloud })); } catch (err) { /* private mode */ }
  }
  (function load() {
    var saved = read();
    E.binding = saved.binding || null;
    E.whisper = !!saved.whisper;
    E.callout = saved.callout !== false;
    E.allowCloud = !!saved.allowCloud;
    if (typeof saved.sensitivity === "number") E.level = saved.sensitivity;
  })();
  function still() {
    var h = host();
    if (h && h.reducedMotion && h.reducedMotion()) return true;
    return !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  function lang() {
    var h = host();
    return h && h.lang ? h.lang() : "en";
  }
  function speechLang() {
    return { en: "en-US", es: "es-ES", ru: "ru-RU", hi: "hi-IN" }[lang()] || "en-US";
  }
  function pageName(id) {
    if (id === "home") return tr("Home");
    if (id === "settings") return tr("Settings");
    if (id === "explore") return tr("Explore");
    if (id === "notifications") return tr("Notifications");
    if (id === "messages") return tr("Messages");
    if (id === "lists") return tr("Lists");
    if (id === "bookmarks") return tr("Bookmarks");
    if (id === "history") return tr("History");
    if (id === "display") return tr("Display");
    if (id === "localai") return tr("Local AI");
    return "";
  }
  function rootEl() { return document.getElementById("easy-voice"); }
  function ensure() {
    if (rootEl()) return rootEl();
    var spot = document.createElement("div");
    spot.id = "easy-spotlight";
    spot.hidden = true;
    spot.innerHTML = '<div class="easy-spot"></div><div class="easy-callout" role="status"><p class="easy-callout-text"></p><button type="button" data-ev="dismiss"></button></div>';
    var dock = document.createElement("section");
    dock.id = "easy-voice";
    dock.className = "easy-voice";
    dock.setAttribute("aria-label", tr("Easy voice"));
    dock.innerHTML = '<p class="easy-voice-state" role="status"></p><div class="easy-voice-row"><button type="button" class="easy-voice-talk" data-ev="talk"></button><button type="button" data-ev="stop" hidden></button><button type="button" data-ev="pause" hidden></button></div><form data-ev="form"><input class="easy-voice-type" aria-label="' + tr("Or type what you want") + '" placeholder="' + tr("Or type what you want") + '"><button type="submit" class="easy-voice-go"></button></form><p class="easy-voice-say"></p><div class="easy-voice-actions"></div><p class="easy-voice-note"></p><details class="easy-voice-more"><summary></summary><div class="easy-voice-extra"></div></details>';
    document.body.appendChild(spot);
    document.body.appendChild(dock);
    dock.addEventListener("click", onClick);
    dock.addEventListener("submit", function (event) {
      event.preventDefault();
      var input = dock.querySelector(".easy-voice-type");
      submitText(input ? input.value : "");
    });
    dock.addEventListener("input", function (event) {
      if (event.target && event.target.getAttribute("data-ev") === "level") {
        E.level = Number(event.target.value) || 0;
        write();
      }
    });
    spot.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return dock;
  }
  function setState(name) {
    E.state = name;
    var dock = rootEl();
    if (!dock) return;
    var labels = { ready: tr("Talk"), listening: tr("Listening…"), thinking: tr("Thinking…"), speaking: tr("Speaking…") };
    var state = dock.querySelector(".easy-voice-state");
    var talk = dock.querySelector("[data-ev='talk']");
    if (state) state.textContent = labels[name] || labels.ready;
    if (talk) {
      talk.textContent = name === "listening" ? tr("Listening…") : tr("Talk");
      talk.setAttribute("aria-pressed", name === "listening" ? "true" : "false");
    }
    var stop = dock.querySelector("[data-ev='stop']");
    var pause = dock.querySelector("[data-ev='pause']");
    if (stop) stop.hidden = name !== "listening" && name !== "speaking";
    if (pause) pause.hidden = name !== "speaking";
    dock.classList.toggle("easy-voice-still", still());
  }
  function note(text) {
    var el = rootEl() && rootEl().querySelector(".easy-voice-note");
    if (el) el.textContent = text || "";
  }
  function sayBox(text) {
    var el = rootEl() && rootEl().querySelector(".easy-voice-say");
    if (el) el.textContent = text || "";
  }
  function actionsHtml(plan, heard) {
    var box = rootEl() && rootEl().querySelector(".easy-voice-actions");
    if (!box) return;
    var html = "";
    if (heard) html += '<button type="button" data-ev="use">' + tr("Use this") + '</button><button type="button" data-ev="edit">' + tr("Edit") + "</button>";
    else if (plan && plan.needsConfirm) html += '<button type="button" data-ev="do">' + tr("Do it for me") + '</button><button type="button" data-ev="no">' + tr("No") + "</button>";
    if (E.undo) html += '<button type="button" data-ev="undo">' + tr("Undo") + "</button>";
    box.innerHTML = html;
  }
  function extra() {
    var dock = rootEl();
    if (!dock) return;
    var summary = dock.querySelector("summary");
    if (summary) summary.textContent = tr("Button and quiet speech");
    var box = dock.querySelector(".easy-voice-extra");
    if (!box) return;
    var binding = E.binding;
    var saved = binding ? (binding.kind === "media" ? tr("Media button") + ": " + binding.action : tr("Key") + ": " + (binding.key || binding.code)) : tr("No button saved yet.");
    var go = dock.querySelector(".easy-voice-go");
    if (go) go.textContent = tr("Go");
    var dismiss = document.querySelector("#easy-spotlight [data-ev='dismiss']");
    if (dismiss) dismiss.textContent = tr("Dismiss guidance");
    var stop = dock.querySelector("[data-ev='stop']");
    var pause = dock.querySelector("[data-ev='pause']");
    if (stop) stop.textContent = tr("Stop");
    if (pause) pause.textContent = tr("Pause speaking");
    box.innerHTML = '<p class="easy-voice-note">' + tr("A web page cannot use the power button, the volume buttons, or the assistant button, including Bixby. Those stay with the phone.") + "</p><p>" + saved + '</p><div class="easy-voice-actions"><button type="button" data-ev="learn">' + (E.learn ? tr("Listening for a button…") : tr("Press your button now")) + "</button>" + (binding ? '<button type="button" data-ev="clear">' + tr("Clear button") + "</button>" : "") + "</div><button type=\"button\" data-ev=\"whisper\" role=\"switch\" aria-checked=\"" + (E.whisper ? "true" : "false") + "\">" + tr("Quiet speech") + "</button><p class=\"easy-voice-note\">" + tr("This browser's speech recognition is not a whisper model. Quiet mode raises sensitivity and, where the browser allows, the microphone constraints. It does not guarantee a whisper on every microphone.") + "</p><label>" + tr("Input sensitivity") + "<input type=\"range\" min=\"0\" max=\"100\" data-ev=\"level\" value=\"" + String(E.level) + "\" aria-label=\"" + tr("Input sensitivity") + "\"></label><button type=\"button\" data-ev=\"cal\">" + tr("Check microphone level") + "</button><p class=\"easy-voice-note\">" + tr("The level check stays on this device and is not uploaded.") + "</p><button type=\"button\" data-ev=\"callout\" role=\"switch\" aria-checked=\"" + (E.callout ? "true" : "false") + "\">" + tr("Bigger callout") + "</button><p class=\"easy-voice-note\">" + tr("Easy voice reads the labels on this screen. It does not record the screen or send a picture away.") + "</p><p class=\"easy-voice-note\">" + tr("No downloaded on-device vision model is available, so pictures are not understood.") + "</p>";
  }
  function clearSpot() {
    var spot = document.getElementById("easy-spotlight");
    if (spot) spot.hidden = true;
    document.querySelectorAll("[data-easy-target]").forEach(function (el) { el.removeAttribute("data-easy-target"); el.removeAttribute("aria-describedby"); });
  }
  function aim(target) {
    var found = locate(target);
    if (found && placeSpot(found.el, found.label)) return;
    if (found && found.el) {
      try { found.el.scrollIntoView({ block: "center", inline: "nearest", behavior: still() ? "auto" : "smooth" }); } catch (err) { /* old browser */ }
    }
    clearTimeout(E.aim);
    E.aim = setTimeout(function () {
      var again = locate(target);
      if (!again || !placeSpot(again.el, again.label)) {
        clearSpot();
        sayBox(tr("That control is not on this screen, so nothing is highlighted."));
      }
    }, still() ? 40 : 380);
  }
  function placeSpot(el, label) {
    clearSpot();
    var api = engine();
    if (!el || !api) return false;
    var view = { width: window.innerWidth, height: window.innerHeight };
    var rect = el.getBoundingClientRect();
    var box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    if (!api.canHighlight(box, view)) return false;
    var spot = document.getElementById("easy-spotlight");
    var ring = spot && spot.querySelector(".easy-spot");
    var call = spot && spot.querySelector(".easy-callout");
    if (!ring || !call) return false;
    spot.hidden = false;
    spot.classList.toggle("easy-voice-still", still());
    ring.style.left = Math.max(4, rect.left - 6) + "px";
    ring.style.top = Math.max(4, rect.top - 6) + "px";
    ring.style.width = Math.min(rect.width + 12, view.width - 8) + "px";
    ring.style.height = Math.min(rect.height + 12, view.height - 8) + "px";
    call.hidden = !E.callout;
    var text = call.querySelector(".easy-callout-text");
    if (text) text.textContent = tr("Look here: {label}", { label: String(label || "").slice(0, 80) });
    var top = rect.bottom + 12;
    if (top > view.height - 120) top = Math.max(8, rect.top - 120);
    call.style.left = Math.max(8, Math.min(rect.left, view.width - 280)) + "px";
    call.style.top = top + "px";
    el.setAttribute("data-easy-target", "1");
    return true;
  }
  function scan() {
    var api = engine();
    var nodes = document.querySelectorAll("a[href], button, [role='button'], [role='link'], [role='tab'], input, textarea, summary");
    var view = { width: window.innerWidth, height: window.innerHeight };
    var out = [];
    Array.prototype.forEach.call(nodes, function (node) {
      if (!node || (node.closest && node.closest("#easy-voice, #easy-spotlight"))) return;
      var label = node.getAttribute("aria-label") || node.getAttribute("title") || "";
      if (!label && node.labels && node.labels[0]) label = node.labels[0].innerText || "";
      if (!label) label = node.innerText || "";
      label = String(label).replace(/\s+/g, " ").trim().slice(0, 80);
      if (!label) return;
      var style = window.getComputedStyle ? getComputedStyle(node) : null;
      var hidden = style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0);
      var rect = node.getBoundingClientRect();
      var box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      var shown = !hidden && rect.width >= 8 && rect.height >= 8;
      out.push({
        label: label,
        href: node.getAttribute("href") || "",
        role: node.getAttribute("role") || node.tagName.toLowerCase(),
        id: node.id || "",
        visible: shown,
        inView: shown && api && api.canHighlight(box, view),
        el: node
      });
    });
    return out;
  }
  function locate(target) {
    if (!target) return null;
    var controls = scan().filter(function (row) {
      if (target.id && row.id && row.id === target.id) return true;
      return row.href === target.href && row.label === target.label;
    });
    var shown = controls.filter(function (row) { return row.inView && row.visible && row.el; });
    return shown[0] || null;
  }
  function visionEnv() {
    return { downloaded: false, local: false, kind: "" };
  }
  function describe(plan) {
    if (!plan || !plan.ok) {
      if (plan && plan.guide && plan.guide.reason === "offscreen") return tr("That control is not on this screen, so nothing is highlighted.");
      if (plan && plan.guide && plan.guide.reason === "ambiguous") return tr("More than one control matches, so nothing is highlighted.");
      return tr("I can open a page, change a setting, or show a control that is on this screen.");
    }
    var bits = [];
    if (plan.page) bits.push(tr("You are on {page}.", { page: pageName(plan.page) || plan.page }));
    if (plan.guide && plan.guide.target) bits.push(tr("Look here: {label}", { label: plan.guide.target.label }));
    (plan.actions || []).forEach(function (step) {
      if (step.name === "nav.open") bits.push(tr("I will open {page}.", { page: pageName(step.pageId) || step.pageId || "" }));
      else if (step.name === "nav.profile") bits.push(tr("I will open {page}.", { page: step.handle || "" }));
      else if (step.name === "compose.draft") bits.push(tr("I will prepare a draft. It is not posted."));
      else if (String(step.name || "").indexOf("person.") === 0) bits.push(tr("I will not change privacy until you tap Do it for me.") + " " + (step.handle || ""));
    });
    (plan.settings.changes || []).forEach(function (change) {
      var name = change.row && change.row.label || change.id;
      bits.push(tr("I will change {name}.", { name: name }));
    });
    if (plan.play === "pause") bits.push(tr("I will pause the video."));
    if (plan.play === "play") bits.push(tr("I will play the video."));
    if (plan.read && plan.read.ok) bits.push(tr("I will read the post that is open."));
    if (plan.read && !plan.read.ok) bits.push(tr("There is no post text on this screen to read."));
    if (plan.sensitive) bits.push(tr("I will not publish, delete, or change privacy until you tap Do it for me."));
    if (plan.vision && plan.vision.mode === "dom") bits.push(tr("No downloaded on-device vision model is available, so pictures are not understood."));
    return bits.filter(Boolean).join(" ");
  }
  function showPlan(plan) {
    E.plan = plan;
    E.heard = null;
    var text = describe(plan);
    sayBox(text);
    actionsHtml(plan, false);
    setState("ready");
    var target = plan && plan.guide && plan.guide.target;
    if (!target) clearSpot();
    else aim(target);
    speak(text);
  }
  function context() {
    var h = host();
    var api = engine();
    if (api && window.ViktorychAppActions) api.bind(window.ViktorychAppActions);
    return {
      actions: window.ViktorychAppActions || null,
      ai: window.ViktorychLocalAI || null,
      current: h && h.values ? h.values() : {},
      actionCtx: h && h.context ? h.context() : { tabs: [], lists: [] },
      controls: scan().map(function (row) { return { label: row.label, href: row.href, role: row.role, id: row.id, visible: row.visible, inView: row.inView }; }),
      readable: h && h.readable ? h.readable() : "",
      page: h && h.page ? h.page() : "",
      vision: visionEnv()
    };
  }
  function planFrom(text) {
    var api = engine();
    if (!api || !String(text || "").trim()) return;
    setState("thinking");
    var plan = api.decide(text, context());
    showPlan(plan);
  }
  function submitText(text) {
    var api = engine();
    var value = String(text || "").trim();
    if (!value || !api) return;
    var gate = api.gate({ text: value, confidence: 1, whisper: !!E.whisper });
    if (!gate.send) {
      E.heard = value;
      sayBox(tr("I heard this. Continue only if it is right.") + " " + value);
      actionsHtml(null, true);
      note("");
      return;
    }
    planFrom(value);
  }
  function speak(text) {
    var api = engine();
    var synth = window.speechSynthesis;
    if (!text || !synth || !window.SpeechSynthesisUtterance || !api) return;
    var picked = api.pickVoice(synth.getVoices ? synth.getVoices() : [], lang());
    if (!picked.voice && picked.reason === "remote-only") {
      note(tr("The only voices this browser listed would leave the device, so this app will not speak."));
      return;
    }
    if (picked.reason === "unknown") note(tr("This browser does not say whether the voice stays on the device. The words are not sent by this app."));
    else if (picked.local) note(tr("Reading uses a voice that stays on this device."));
    var utter = new SpeechSynthesisUtterance(text);
    if (picked.voice) utter.voice = picked.voice;
    utter.lang = speechLang();
    utter.onstart = function () { setState("speaking"); };
    utter.onend = function () { if (E.state === "speaking") setState("ready"); };
    try { synth.cancel(); synth.speak(utter); } catch (err) { setState("ready"); }
  }
  function stopAll() {
    if (E.rec) { try { E.rec.onend = null; E.rec.stop(); } catch (err) { /* already stopped */ } E.rec = null; }
    if (window.speechSynthesis) { try { window.speechSynthesis.cancel(); } catch (err) { /* none */ } }
    E.learn = false;
    armMedia(false);
    setState("ready");
  }
  function beginRec(Ctor, local) {
    var api = engine();
    stopAll();
    var rec = new Ctor();
    rec.lang = speechLang();
    rec.processLocally = !!local;
    rec.interimResults = false;
    var finalText = "";
    var confidence = null;
    rec.onresult = function (event) {
      var alt = event.results && event.results[0] && event.results[0][0];
      finalText = alt ? alt.transcript : "";
      if (alt && typeof alt.confidence === "number") confidence = alt.confidence;
    };
    var failed = false;
    rec.onerror = function (event) {
      failed = true;
      var info = api.recognitionError(event && event.error);
      E.rec = null;
      setState("ready");
      if (info.reason === "denied") note(tr("This browser did not allow the microphone. Type instead."));
      var box = rootEl() && rootEl().querySelector(".easy-voice-type");
      if (box) box.focus();
    };
    rec.onend = function () {
      E.rec = null;
      if (!String(finalText || "").trim()) { setState("ready"); return; }
      var gate = api.gate({ text: finalText, confidence: confidence, whisper: !!E.whisper });
      if (!gate.send) {
        E.heard = finalText;
        sayBox(tr("I heard this. Continue only if it is right.") + " " + finalText);
        actionsHtml(null, true);
        setState("ready");
        return;
      }
      planFrom(finalText);
    };
    try {
      rec.start();
      if (failed) return;
      E.rec = rec;
      setState("listening");
      note("");
    } catch (err) {
      setState("ready");
      note(tr("This browser did not allow the microphone. Type instead."));
    }
  }
  function startRec() {
    var api = engine();
    var localCtor = window.SpeechRecognition || null;
    if (localCtor) { beginRec(localCtor, true); return; }
    var choice = api ? api.recognitionChoice({ speechRecognition: !!window.webkitSpeechRecognition, processLocally: false, allowCloud: !!E.allowCloud }) : { mode: "typed", reason: "none" };
    if (choice.mode === "cloud" && window.webkitSpeechRecognition) { beginRec(window.webkitSpeechRecognition, false); return; }
    if (choice.reason === "would-leave-device") note(tr("This browser's speech recognition may send audio away. It stays off unless you allow it."));
    else note(tr("This browser has no on-device speech recognition. Typing still works."));
    var input = rootEl() && rootEl().querySelector(".easy-voice-type");
    if (input) input.focus();
    setState("ready");
  }
  function armMedia(on) {
    var ms = navigator.mediaSession;
    var api = engine();
    if (!ms || !ms.setActionHandler || !api) return;
    api.mediaActions().forEach(function (action) {
      try {
        ms.setActionHandler(action, on ? function () {
          if (!E.learn) return;
          var learned = api.fromMedia(action);
          if (!learned.ok) return;
          E.binding = learned.binding;
          E.learn = false;
          E.note = "saved";
          write();
          armMedia(false);
          extra();
          note(tr("Saved. That button now starts listening."));
        } : null);
      } catch (err) { /* this action is not exposed */ }
    });
  }
  function onKey(event) {
    if (!rootEl() || rootEl().hidden) return;
    var api = engine();
    if (!api) return;
    if (event.key === "Escape") { clearSpot(); E.plan = null; actionsHtml(null, false); sayBox(""); return; }
    var typing = !!(event.target && /^(INPUT|TEXTAREA)$/.test(event.target.tagName));
    var sample = { code: event.code, key: event.key, repeat: event.repeat, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, typing: typing };
    if (E.learn) {
      var learned = api.fromKey(sample);
      if (!learned.ok) return;
      event.preventDefault();
      E.binding = learned.binding;
      E.learn = false;
      clearTimeout(E.timer);
      armMedia(false);
      write();
      extra();
      note(tr("Saved. That button now starts listening."));
      return;
    }
    if (api.matches(E.binding, sample)) {
      event.preventDefault();
      startRec();
    }
  }
  function calibrate() {
    var api = engine();
    if (!api || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      note(tr("This browser did not allow the microphone. Type instead."));
      return;
    }
    var supported = {};
    try { supported = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {}; } catch (err) { supported = {}; }
    navigator.mediaDevices.getUserMedia(api.micConstraints(supported, E.level)).then(function (stream) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { stream.getTracks().forEach(function (track) { track.stop(); }); return; }
      var ctx = new Ctx();
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      var data = new Uint8Array(analyser.fftSize);
      var samples = [];
      var ticks = 0;
      var timer = setInterval(function () {
        analyser.getByteTimeDomainData(data);
        var sum = 0;
        for (var i = 0; i < data.length; i += 1) { var n = (data[i] - 128) / 128; sum += n * n; }
        samples.push(Math.sqrt(sum / data.length));
        ticks += 1;
        if (ticks < 12) return;
        clearInterval(timer);
        stream.getTracks().forEach(function (track) { track.stop(); });
        if (ctx.close) ctx.close();
        var result = api.calibrate(samples);
        E.level = result.sensitivity;
        write();
        extra();
        note(result.heard ? (result.quiet ? tr("The meter heard a quiet sound. This is not a promise that a whisper will be recognized.") : tr("The meter heard the microphone.")) : tr("The meter heard almost nothing."));
      }, 200);
    }, function () { note(tr("This browser did not allow the microphone. Type instead.")); });
  }
  function rememberUndo(record) { E.undo = record; actionsHtml(E.plan, false); }
  function doPlan() {
    var plan = E.plan;
    var h = host();
    if (!plan || !h) return;
    var before = h.hash ? h.hash() : "";
    var jobs = (plan.actions || []).map(function (step) { return h.perform ? h.perform(step, plan.text) : { ok: false }; });
    var people = (plan.actions || []).filter(function (step) { return String(step.name || "").indexOf("person.") === 0; });
    var prior = people.map(function (step) {
      var id = "person:" + step.act + ":" + step.handle;
      return { id: id, on: h.personState ? !!h.personState(id) : false };
    });
    sayBox(describe(plan));
    Promise.all(jobs).then(function () {
      if (plan.settings && plan.settings.changes && plan.settings.changes.length && h.apply) {
        var inverse = plan.settings.changes.map(function (change) { return { id: change.id, to: change.from, row: change.row }; });
        return Promise.resolve(h.apply(plan.settings.changes)).then(function () {
          if (!prior.length) rememberUndo({ kind: "settings", inverse: inverse });
        });
      }
      if (prior.length && h.restorePerson) rememberUndo({ kind: "person", id: prior[0].id, on: prior[0].on });
      else if (plan.actions && plan.actions.some(function (step) { return step.name === "nav.open" || step.name === "nav.profile"; })) rememberUndo({ kind: "nav", hash: before });
      if (plan.play && h.playback) {
        var opposite = plan.play === "pause" ? "play" : "pause";
        var played = h.playback(plan.play);
        if (played && played.ok) rememberUndo({ kind: "playback", op: opposite });
        else note(tr("Nothing is playing."));
      }
      if (plan.read && plan.read.ok) speak(plan.read.text);
    });
  }
  function onClick(event) {
    var el = event.target && event.target.closest ? event.target.closest("[data-ev]") : null;
    if (!el) return;
    var act = el.getAttribute("data-ev");
    if (act === "talk") { startRec(); return; }
    if (act === "stop") { stopAll(); return; }
    if (act === "pause") {
      var synth = window.speechSynthesis;
      if (synth && synth.paused) synth.resume();
      else if (synth) synth.pause();
      return;
    }
    if (act === "use") { var heard = E.heard; E.heard = null; planFrom(heard); return; }
    if (act === "edit") {
      var input = rootEl().querySelector(".easy-voice-type");
      if (input) { input.value = E.heard || ""; input.focus(); }
      E.heard = null;
      actionsHtml(null, false);
      return;
    }
    if (act === "do") { doPlan(); return; }
    if (act === "no" || act === "dismiss") { E.plan = null; clearSpot(); sayBox(""); actionsHtml(null, false); stopAll(); return; }
    if (act === "undo") {
      var h = host();
      var record = E.undo;
      E.undo = null;
      actionsHtml(E.plan, false);
      if (!h || !record) return;
      if (record.kind === "nav" && h.go) h.go(record.hash);
      if (record.kind === "settings" && h.apply) h.apply(record.inverse);
      if (record.kind === "playback" && h.playback) h.playback(record.op);
      if (record.kind === "person" && h.restorePerson) h.restorePerson(record.id, record.on);
      return;
    }
    if (act === "learn") {
      E.learn = true;
      extra();
      note(tr("Only a key or media button this browser actually delivers can be saved."));
      armMedia(true);
      clearTimeout(E.timer);
      E.timer = setTimeout(function () {
        if (!E.learn) return;
        E.learn = false;
        armMedia(false);
        extra();
        note(tr("No hardware button reached this page. The Talk button and typing still work."));
      }, 8000);
      return;
    }
    if (act === "clear") { E.binding = null; write(); extra(); return; }
    if (act === "whisper") { E.whisper = !E.whisper; write(); extra(); return; }
    if (act === "callout") { E.callout = !E.callout; write(); extra(); return; }
    if (act === "cal") { calibrate(); return; }
    if (act === "cloud") { E.allowCloud = true; write(); note(tr("This browser's speech recognition may send audio away. It stays off unless you allow it.")); }
  }
  function paint() {
    var h = host();
    if (h && h.on && !h.on()) { unmount(); return; }
    ensure();
    var dock = rootEl();
    dock.hidden = false;
    setState(E.state || "ready");
    extra();
    if (!dock.querySelector(".easy-voice-say").textContent) {
      note(tr("On-screen talk is the large Talk button. A saved key is extra."));
    }
  }
  function unmount() {
    stopAll();
    clearSpot();
    var dock = rootEl();
    var spot = document.getElementById("easy-spotlight");
    if (dock) dock.hidden = true;
    if (spot) spot.hidden = true;
  }
  window.ViktorychEasyVoiceUI = { paint: paint, unmount: unmount, scan: scan };
})();
