/* Opt-in Go live. Media stays on this device and on peer connections.
   The Worker only sees session metadata and signaling JSON. */
(function (root) {
  "use strict";

  function tn(key, n, vars) { var f = (typeof window !== "undefined" && window.tn) || (typeof self !== "undefined" && self.tn); return f ? f(key, n, vars) : String(n); }
  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : null;
    return fn ? fn(key, vars) : key;
  }

  var ACCOUNT = /^\d{12}$/;
  var state = {
    lives: [],
    rowStamp: "0",
    sheet: "",
    session: null,
    role: "",
    self: "",
    parentId: "",
    children: [],
    roster: [],
    viewers: 0,
    ice: [],
    invite: "",
    password: "",
    local: null,
    pcs: {},
    inbound: {},
    from: {},
    channels: [],
    seen: {},
    chat: [],
    ws: null,
    heart: 0,
    retry: 0,
    recorder: null,
    chunks: [],
    error: "",
    status: "",
    form: { title: "", audience: "public", members: "", password: "", fanout: 3, mic: true, system: false },
    queue: []
  };

  function caps() {
    var nav = root.navigator || {};
    var ua = String(nav.userAgent || "");
    var ios = /iPhone|iPad|iPod/i.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
    var md = nav.mediaDevices || {};
    var camera = typeof md.getUserMedia === "function";
    var screen = !ios && typeof md.getDisplayMedia === "function";
    return {
      ios: ios,
      camera: camera,
      screen: screen,
      mic: camera,
      record: typeof root.MediaRecorder === "function"
    };
  }

  function esc(value) {
    return String(value || "").replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
  }

  function accounts() {
    return root.ViktorychAccounts || null;
  }

  function token() {
    var api = accounts();
    return api && api.token ? String(api.token() || "") : "";
  }

  function apiBase() {
    var api = accounts();
    var live = api && api.currentApi ? api.currentApi() : "";
    return String(live || "").replace(/\/$/, "");
  }

  function call(path, opts) {
    var api = accounts();
    opts = opts || {};
    if (!api || !api.call) return Promise.resolve({ status: 401 });
    return api.call(path, Object.assign({ token: token() }, opts));
  }

  function rowExtra() {
    return 0;
  }

  function homeHtml() {
    return "";
  }

  function rowInner() {
    var lives = state.lives.map(function (item) {
      var name = item.hostName || tr("Live");
      return '<button class="live-pill" type="button" data-act="live-open" data-id="' + esc(item.id) + '"><span class="live-dot" aria-hidden="true"></span><span class="live-name">' + esc(name) + '</span><span class="live-tag">' + esc(tr("Live")) + '</span></button>';
    }).join("");
    return lives;
  }

  function paintRow() {
    var node = document.querySelector("[data-live-row]");
    if (!node) return;
    if (node.getAttribute("data-stamp") === state.rowStamp) return;
    var html = rowInner();
    node.innerHTML = html;
    node.hidden = !html;
    node.setAttribute("aria-label", tr("Live"));
    node.setAttribute("data-stamp", state.rowStamp);
  }

  function refreshRow() {
    if (!token()) {
      state.lives = [];
      state.rowStamp = "off";
      paintRow();
      return;
    }
    call("/v1/live").then(function (body) {
      var ok = body && body.status === 200 && Array.isArray(body.lives);
      var next = ok ? body.lives : [];
      takeRow(next);
      if (ok && rowChannel) { try { rowChannel.postMessage({ lives: next }); } catch (err) { /* other tabs poll later */ } }
    }).catch(function () { paintRow(); });
  }

  function ability() {
    return caps();
  }

  function sourceButtons() {
    var c = caps();
    var html = "";
    if (c.camera) html += '<button type="button" data-act="live-source" data-source="camera">' + esc(tr("Camera")) + '</button>';
    if (c.screen) {
      html += '<button type="button" data-act="live-source" data-source="screen">' + esc(tr("Screen")) + '</button>';
      html += '<button type="button" data-act="live-source" data-source="both">' + esc(tr("Camera and screen")) + '</button>';
      html += '<button type="button" data-act="live-source" data-source="tab">' + esc(tr("Window or tab")) + '</button>';
    }
    return html;
  }

  function setupHtml() {
    var c = caps();
    var sources = sourceButtons();
    var start = sources ? '<button class="live-go" type="button" data-act="live-start">' + esc(tr("Start live")) + '</button>' : '<p class="live-note">' + esc(tr("This device can’t go live")) + '</p>';
    var mic = c.mic ? '<label class="live-check"><input type="checkbox" data-live="mic"' + (state.form.mic ? " checked" : "") + '>' + esc(tr("Microphone")) + '</label>' : "";
    var system = c.screen ? '<label class="live-check"><input type="checkbox" data-live="system"' + (state.form.system ? " checked" : "") + '>' + esc(tr("System audio")) + '</label>' : "";
    var record = c.record ? '<label class="live-check"><input type="checkbox" data-live="record">' + esc(tr("Record on this device")) + '</label>' : "";
    return '<div class="live-sheet" role="dialog" aria-modal="true" aria-label="' + esc(tr("Go live")) + '"><div class="live-card"><div class="live-card-head"><h2>' + esc(tr("Go live")) + '</h2><button type="button" data-act="live-close" aria-label="' + esc(tr("Close")) + '">×</button></div>' +
      (sources ? '<div class="live-sources" data-live-sources>' + sources + '</div>' : start) +
      '<label class="live-field">' + esc(tr("Title")) + '<input data-live="title" maxlength="80" value="' + esc(state.form.title) + '"></label>' +
      '<label class="live-field">' + esc(tr("Who can watch")) + '<select data-live="audience">' +
      option("public", tr("Everyone")) + option("followers", tr("Followers")) + option("mutuals", tr("Mutuals")) + option("self", tr("Only me")) + option("list", tr("Custom list")) + option("invite", tr("Invite link")) +
      '</select></label>' +
      '<label class="live-field" data-live-members' + (state.form.audience === "list" ? "" : " hidden") + '>' + esc(tr("Account numbers")) + '<textarea data-live="members" maxlength="400" placeholder="' + esc(tr("One account number per line")) + '">' + esc(state.form.members) + '</textarea></label>' +
      '<label class="live-field" data-live-pass' + (state.form.audience === "invite" ? "" : " hidden") + '>' + esc(tr("Optional password")) + '<input data-live="password" type="password" maxlength="80" value="' + esc(state.form.password) + '"></label>' +
      '<label class="live-field">' + esc(tr("Fan-out")) + '<input data-live="fanout" type="number" min="1" max="8" value="' + esc(state.form.fanout) + '"></label>' +
      mic + system + record +
      (sources ? start : "") +
      (state.error ? '<p class="live-note">' + esc(state.error) + '</p>' : "") +
      '</div></div>';
  }

  function option(value, label) {
    return '<option value="' + value + '"' + (state.form.audience === value ? " selected" : "") + '>' + esc(label) + '</option>';
  }

  function stageHtml() {
    var host = state.role === "host";
    var c = caps();
    var controls = "";
    if (host) {
      controls += '<button type="button" data-act="live-pause">' + esc(state.paused ? tr("Resume") : tr("Pause")) + '</button>';
      if (c.mic) controls += '<button type="button" data-act="live-mute">' + esc(state.muted ? tr("Unmute") : tr("Mute")) + '</button>';
      if (sourceButtons()) controls += '<button type="button" data-act="live-change">' + esc(tr("Change source")) + '</button>';
      if (c.record) controls += '<button type="button" data-act="live-record">' + esc(state.recorder ? tr("Stop recording") : tr("Record on this device")) + '</button>';
      controls += '<button type="button" data-act="live-stop">' + esc(tr("Stop live")) + '</button>';
    } else {
      controls += '<button type="button" data-act="live-leave">' + esc(tr("Leave")) + '</button>';
    }
    var roster = host ? state.roster.map(function (id, index) {
      return '<li><span>' + esc(tr("Viewer")) + ' ' + (index + 1) + '</span><button type="button" data-act="live-kick" data-id="' + esc(id) + '">' + esc(tr("Kick")) + '</button></li>';
    }).join("") : "";
    var chat = state.chat.map(function (item) {
      var who = item.self ? tr("You") : tr("Viewer");
      var drop = host && item.op === "chat" ? '<button type="button" data-act="live-drop" data-id="' + esc(item.id) + '">' + esc(tr("Remove")) + '</button>' : "";
      return '<li data-chat="' + esc(item.id) + '"><span>' + esc(who) + '</span> ' + esc(item.text || item.emoji || "") + drop + '</li>';
    }).join("");
    var invite = host && state.invite ? '<p class="live-note"><button type="button" data-act="live-copy">' + esc(tr("Copy invite link")) + '</button></p>' : "";
    return '<div class="live-stage"><div class="live-videos" data-live-videos></div><div class="live-bar"><span class="live-dot" aria-hidden="true"></span><span>' + esc(tn("watching", state.viewers, { count: state.viewers })) + '</span>' + controls + '</div>' +
      (state.status ? '<p class="live-note" data-live-status>' + esc(state.status) + '</p>' : "") +
      invite +
      (roster ? '<ul class="live-roster" aria-label="' + esc(tr("Viewers")) + '">' + roster + '</ul>' : "") +
      '<div class="live-chat" aria-label="' + esc(tr("Live chat")) + '"><ul>' + chat + '</ul><form data-act="live-chat"><input data-live="chat" maxlength="200" placeholder="' + esc(tr("Say something")) + '"><button type="submit">' + esc(tr("Send")) + '</button></form><div class="live-react">' +
      ["♥", "👏", "😂"].map(function (emoji) { return '<button type="button" data-act="live-react" data-emoji="' + emoji + '" aria-label="' + esc(tr("Reactions")) + '">' + emoji + '</button>'; }).join("") +
      '</div></div></div>';
  }

  function mount(html) {
    var old = document.getElementById("live-layer");
    if (old) old.remove();
    if (!html) return;
    var node = document.createElement("div");
    node.id = "live-layer";
    node.innerHTML = html;
    document.body.appendChild(node);
    attach();
  }

  function openSetup() {
    if (!token()) {
      state.error = tr("Sign in to go live");
    }
    state.sheet = "setup";
    state.picked = state.picked || (caps().camera ? "camera" : (caps().screen ? "screen" : ""));
    mount(setupHtml());
    markSource();
  }

  function markSource() {
    document.querySelectorAll("[data-act='live-source']").forEach(function (node) {
      node.classList.toggle("on", node.getAttribute("data-source") === state.picked);
    });
  }

  function readForm() {
    var rootNode = document.getElementById("live-layer");
    if (!rootNode) return;
    rootNode.querySelectorAll("[data-live]").forEach(function (node) {
      var key = node.getAttribute("data-live");
      if (node.type === "checkbox") state.form[key] = node.checked;
      else state.form[key] = node.value;
    });
  }

  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (err) { /* already stopped */ }
    });
  }

  function recordMime() {
    if (!root.MediaRecorder || !root.MediaRecorder.isTypeSupported) return "";
    var list = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
    for (var i = 0; i < list.length; i++) if (root.MediaRecorder.isTypeSupported(list[i])) return list[i];
    return "";
  }

  function capture(kind) {
    var md = navigator.mediaDevices;
    var mic = !!state.form.mic;
    var system = !!state.form.system;
    if (kind === "camera") {
      return md.getUserMedia({ audio: mic, video: { facingMode: "user" } }).then(function (stream) {
        tag(stream, "camera");
        return { camera: stream, screen: null };
      });
    }
    var display = { video: true, audio: system };
    if (kind === "tab") display = { video: { displaySurface: "browser" }, audio: system };
    if (kind === "screen") display = { video: { displaySurface: "monitor" }, audio: system };
    var screenP = md.getDisplayMedia(display).then(function (stream) {
      tag(stream, "screen");
      return stream;
    });
    if (kind !== "both") return screenP.then(function (stream) { return { camera: null, screen: stream }; });
    return screenP.then(function (screen) {
      return md.getUserMedia({ audio: mic && !screen.getAudioTracks().length, video: { facingMode: "user" } }).then(function (camera) {
        tag(camera, "camera");
        return { camera: camera, screen: screen };
      }).catch(function () { return { camera: null, screen: screen }; });
    });
  }

  function tag(stream, hint) {
    stream.getVideoTracks().forEach(function (track) {
      try { track.contentHint = hint === "screen" ? "detail" : "motion"; } catch (err) { /* hint is optional */ }
    });
  }

  function mix(parts) {
    var stream = new MediaStream();
    ["screen", "camera"].forEach(function (key) {
      var part = parts[key];
      if (!part) return;
      part.getTracks().forEach(function (track) {
        if (track.kind === "audio" && stream.getAudioTracks().length) return;
        stream.addTrack(track);
      });
    });
    state.parts = parts;
    state.local = stream;
    return stream;
  }

  function membersOf(text) {
    var out = [];
    String(text || "").split(/[^0-9]+/).forEach(function (item) {
      if (ACCOUNT.test(item) && out.indexOf(item) < 0 && out.length < 8) out.push(item);
    });
    return out;
  }

  function startLive() {
    readForm();
    var kind = state.picked || "camera";
    var c = caps();
    if ((kind !== "camera" && !c.screen) || (kind === "camera" && !c.camera)) {
      state.error = tr("This device can’t go live");
      mount(setupHtml());
      return;
    }
    state.error = "";
    state.status = "";
    capture(kind).then(function (parts) {
      mix(parts);
      var body = {
        title: String(state.form.title || "").slice(0, 80),
        audience: state.form.audience || "public",
        members: state.form.audience === "list" ? membersOf(state.form.members) : [],
        password: state.form.audience === "invite" ? String(state.form.password || "").slice(0, 80) : "",
        fanout: Number(state.form.fanout) || 3,
        sources: kind
      };
      return call("/v1/live", { method: "POST", body: body }).then(function (res) {
        if (!res || res.status !== 201 || !res.live) {
          stopLocal();
          state.error = tr("This live isn’t available");
          mount(setupHtml());
          return;
        }
        state.session = res.live;
        state.role = "host";
        state.invite = res.invite || "";
        state.password = body.password || "";
        state.ice = Array.isArray(res.iceServers) ? res.iceServers : [];
        state.sheet = "stage";
        if (state.form.record) beginRecord();
        mount(stageHtml());
        openSocket(res.ticket);
        beat();
      });
    }).catch(function () {
      stopLocal();
      state.error = kind === "camera" ? tr("Couldn’t start the camera") : tr("Couldn’t start the screen");
      mount(setupHtml());
      markSource();
    });
  }

  function beginRecord() {
    if (!state.local || !root.MediaRecorder || state.recorder) return;
    var mime = recordMime();
    try {
      state.recorder = mime ? new root.MediaRecorder(state.local, { mimeType: mime }) : new root.MediaRecorder(state.local);
    } catch (err) {
      state.recorder = null;
      return;
    }
    state.chunks = [];
    state.recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) state.chunks.push(ev.data); };
    state.recorder.onstop = function () { saveRecording(); };
    state.recorder.start(1000);
  }

  function saveRecording() {
    if (!state.chunks.length) return;
    var blob = new Blob(state.chunks, { type: state.chunks[0].type || "video/webm" });
    state.chunks = [];
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "live-" + Date.now() + (blob.type.indexOf("mp4") >= 0 ? ".mp4" : ".webm");
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    state.status = tr("Saved on this device");
    if (state.sheet === "stage") mount(stageHtml());
  }

  function stopLocal() {
    if (state.recorder && state.recorder.state !== "inactive") {
      try { state.recorder.stop(); } catch (err) { /* the file still saves from the last chunk */ }
    }
    state.recorder = null;
    if (state.parts) {
      stopTracks(state.parts.camera);
      stopTracks(state.parts.screen);
    }
    stopTracks(state.local);
    state.local = null;
    state.parts = null;
  }

  function closePcs() {
    Object.keys(state.pcs).forEach(function (id) {
      try { state.pcs[id].close(); } catch (err) { /* already closed */ }
    });
    state.pcs = {};
    state.inbound = {};
    state.from = {};
    state.channels = [];
  }

  function hangup() {
    if (state.heart) clearInterval(state.heart);
    state.heart = 0;
    if (state.ws) {
      try { state.ws.close(); } catch (err) { /* already closed */ }
      state.ws = null;
    }
    closePcs();
  }

  function beat() {
    if (state.heart) clearInterval(state.heart);
    state.heart = setInterval(function () {
      if (!state.session || state.role !== "host") return;
      call("/v1/live/" + state.session.id + "/heartbeat", { method: "POST", body: {} });
    }, 25000);
  }

  function openSocket(ticket) {
    var base = apiBase();
    if (!base || !ticket || !state.session) return;
    if (state.ws) {
      try { state.ws.close(); } catch (err) { /* replacing the socket */ }
    }
    var ws = null;
    try {
      ws = new WebSocket(base.replace(/^http/i, "ws") + "/v1/live/" + state.session.id + "/signal?ticket=" + encodeURIComponent(ticket));
    } catch (err) {
      state.status = tr("Reconnecting");
      return;
    }
    state.ws = ws;
    ws.onmessage = function (ev) { onSignal(ev.data); };
    ws.onclose = function () {
      if (state.ws !== ws || !state.session) return;
      state.status = tr("Reconnecting");
      retryTicket();
    };
  }

  function retryTicket() {
    if (!state.session || state.retry > 8) return;
    state.retry += 1;
    setTimeout(function () {
      if (!state.session) return;
      var body = {};
      if (state.invite) body.invite = state.invite;
      if (state.password) body.password = state.password;
      call("/v1/live/" + state.session.id + "/ticket", { method: "POST", body: body }).then(function (res) {
        if (res && res.ticket) openSocket(res.ticket);
      }).catch(function () {});
    }, 3000);
  }

  function send(body) {
    if (!state.ws || state.ws.readyState !== 1) return;
    try { state.ws.send(JSON.stringify(body)); } catch (err) { /* the socket closed */ }
  }

  function signal(to, data) {
    send({ op: "signal", to: to, data: data });
  }

  function onSignal(raw) {
    var msg = null;
    try { msg = JSON.parse(String(raw || "")); } catch (err) { return; }
    if (!msg || typeof msg !== "object") return;
    if (!state.self && msg.op !== "welcome") {
      state.queue.push(msg);
      return;
    }
    if (msg.op === "welcome") {
      state.self = msg.self || "";
      state.role = msg.role === "host" ? "host" : "viewer";
      state.parentId = msg.parentId || "";
      state.retry = 0;
      state.status = "";
      var queued = state.queue.slice();
      state.queue = [];
      queued.forEach(function (item) { onSignal(JSON.stringify(item)); });
      return;
    }
    if (msg.op === "tree") applyTree(msg);
    else if (msg.op === "signal") onPeerSignal(msg);
    else if (msg.op === "kick") leave(false);
  }

  function applyTree(msg) {
    var parentId = msg.parentId || "";
    if (parentId !== state.parentId) {
      dropPc(state.parentId);
      state.parentId = parentId;
    }
    var children = Array.isArray(msg.children) ? msg.children : [];
    state.children.filter(function (id) { return children.indexOf(id) < 0; }).forEach(dropPc);
    var added = children.filter(function (id) { return state.children.indexOf(id) < 0; });
    state.children = children;
    state.viewers = Number(msg.viewers) || 0;
    if (state.role === "host" && Array.isArray(msg.roster)) state.roster = msg.roster;
    added.forEach(offerChild);
    if (state.sheet === "stage" || document.querySelector("[data-live-videos]")) refreshStage();
  }

  function refreshStage() {
    var videos = document.querySelector("[data-live-videos]");
    if (!videos) {
      if (state.sheet === "stage") mount(stageHtml());
      return;
    }
    var bar = document.querySelector(".live-bar span:nth-child(2)");
    if (bar) bar.textContent = tn("watching", state.viewers, { count: state.viewers });
    var roster = document.querySelector(".live-roster");
    if (roster && state.role === "host") {
      roster.innerHTML = state.roster.map(function (id, index) {
        return '<li><span>' + esc(tr("Viewer")) + " " + (index + 1) + '</span><button type="button" data-act="live-kick" data-id="' + esc(id) + '">' + esc(tr("Kick")) + '</button></li>';
      }).join("");
    }
    attach();
  }

  function tracksFor(remoteId) {
    var list = [];
    if (state.local) state.local.getTracks().forEach(function (track) { if (track.readyState === "live") list.push(track); });
    Object.keys(state.inbound).forEach(function (id) {
      var track = state.inbound[id];
      if (track && track.readyState === "live" && state.from[track.id] !== remoteId) list.push(track);
    });
    return list;
  }

  function pcFor(remoteId, offerer) {
    if (state.pcs[remoteId]) return state.pcs[remoteId];
    var pc = new RTCPeerConnection({ iceServers: state.ice });
    state.pcs[remoteId] = pc;
    pc.onicecandidate = function (ev) {
      if (ev.candidate) signal(remoteId, { kind: "ice", candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = function (ev) {
      var track = ev.track;
      state.inbound[track.id] = track;
      state.from[track.id] = remoteId;
      attach();
      state.children.forEach(function (id) { if (id !== remoteId) addTrack(id, track); });
    };
    pc.ondatachannel = function (ev) { bindChannel(ev.channel); };
    if (offerer) {
      tracksFor(remoteId).forEach(function (track) { pc.addTrack(track, state.local || new MediaStream([track])); });
      bindChannel(pc.createDataChannel("room"));
    }
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") state.status = tr("Reconnecting");
    };
    return pc;
  }

  function addTrack(remoteId, track) {
    var pc = state.pcs[remoteId];
    if (!pc || state.from[track.id] === remoteId) return;
    var have = pc.getSenders().some(function (sender) { return sender.track === track; });
    if (have) return;
    pc.addTrack(track, state.local || new MediaStream([track]));
    renegotiate(remoteId);
  }

  function offerChild(id) {
    var pc = pcFor(id, true);
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      signal(id, { kind: "offer", sdp: pc.localDescription.sdp });
      tune(pc);
    }).catch(function () { state.status = tr("Reconnecting"); });
  }

  function renegotiate(id) {
    var pc = state.pcs[id];
    if (!pc) return;
    if (pc.signalingState !== "stable") {
      pc._again = true;
      return;
    }
    pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      signal(id, { kind: "offer", sdp: pc.localDescription.sdp });
      tune(pc);
    }).catch(function () {});
  }

  function tune(pc) {
    var kids = state.children.length;
    var cap = kids > 2 ? 700000 : kids > 0 ? 1500000 : 2500000;
    pc.getSenders().forEach(function (sender) {
      if (!sender.track || sender.track.kind !== "video") return;
      var params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = cap;
      params.degradationPreference = kids > 2 ? "balanced" : "maintain-resolution";
      sender.setParameters(params).catch(function () {});
    });
  }

  function onPeerSignal(msg) {
    var from = String(msg.from || "");
    var data = msg.data || {};
    if (!ACCOUNT.test(from)) return;
    var pc = pcFor(from, false);
    if (data.kind === "offer") {
      pc.setRemoteDescription({ type: "offer", sdp: data.sdp }).then(function () {
        return pc.createAnswer();
      }).then(function (answer) {
        return pc.setLocalDescription(answer);
      }).then(function () {
        signal(from, { kind: "answer", sdp: pc.localDescription.sdp });
        if (pc._again) {
          pc._again = false;
          renegotiate(from);
        }
      }).catch(function () { state.status = tr("Reconnecting"); });
      return;
    }
    if (data.kind === "answer") {
      pc.setRemoteDescription({ type: "answer", sdp: data.sdp }).catch(function () {});
      return;
    }
    if (data.kind === "ice" && data.candidate) {
      pc.addIceCandidate(data.candidate).catch(function () {});
    }
  }

  function dropPc(id) {
    if (!id || !state.pcs[id]) return;
    try { state.pcs[id].close(); } catch (err) { /* already closed */ }
    delete state.pcs[id];
  }

  function bindChannel(channel) {
    if (!channel) return;
    state.channels.push(channel);
    channel.onmessage = function (ev) {
      var msg = null;
      try { msg = JSON.parse(String(ev.data || "")); } catch (err) { return; }
      if (!msg || state.seen[msg.id]) return;
      state.seen[msg.id] = true;
      if (msg.op === "drop") {
        state.chat = state.chat.filter(function (item) { return item.id !== msg.idDrop; });
      } else if (msg.op === "chat" || msg.op === "react") {
        msg.self = msg.accountId === state.self;
        state.chat = state.chat.concat(msg).slice(-40);
      }
      forward(msg, channel);
      refreshStage();
    };
  }

  function forward(msg, except) {
    state.channels.forEach(function (channel) {
      if (channel === except || channel.readyState !== "open") return;
      try { channel.send(JSON.stringify(msg)); } catch (err) { /* a peer left */ }
    });
  }

  function publishChat(msg) {
    msg.id = Math.random().toString(16).slice(2, 10);
    msg.accountId = state.self || "";
    state.seen[msg.id] = true;
    if (msg.op !== "drop") {
      msg.self = true;
      state.chat = state.chat.concat(msg).slice(-40);
    }
    forward(msg, null);
    refreshStage();
  }

  function attach() {
    var box = document.querySelector("[data-live-videos]");
    if (!box) return;
    var videos = [];
    if (state.local) state.local.getVideoTracks().forEach(function (track) { videos.push({ track: track, local: true }); });
    Object.keys(state.inbound).forEach(function (id) {
      var track = state.inbound[id];
      if (track && track.kind === "video" && track.readyState === "live") videos.push({ track: track, local: false });
    });
    box.innerHTML = "";
    videos.forEach(function (item, index) {
      var video = document.createElement("video");
      video.playsInline = true;
      video.autoplay = true;
      video.muted = item.local || state.muted;
      video.className = item.track.contentHint === "motion" && videos.length > 1 ? "live-pip" : (index ? "live-pip" : "live-main");
      video.srcObject = new MediaStream([item.track]);
      if (!item.local) {
        state.local && state.local.getAudioTracks().forEach(function () {});
        var audio = document.createElement("audio");
        audio.autoplay = true;
        var remoteAudio = [];
        Object.keys(state.inbound).forEach(function (key) {
          if (state.inbound[key] && state.inbound[key].kind === "audio") remoteAudio.push(state.inbound[key]);
        });
        if (remoteAudio.length) audio.srcObject = new MediaStream(remoteAudio);
        box.appendChild(audio);
      }
      var play = video.play && video.play();
      if (play && play.catch) play.catch(function () { video.muted = true; video.play && video.play().catch(function () {}); });
      box.appendChild(video);
    });
  }

  function setEnabled(kind, on) {
    var streams = [state.local];
    if (state.parts) streams.push(state.parts.camera, state.parts.screen);
    streams.forEach(function (stream) {
      if (!stream) return;
      stream.getTracks().forEach(function (track) {
        if (track.kind === kind) track.enabled = on;
      });
    });
  }

  function leave(end) {
    var id = state.session && state.session.id;
    if (end && id && state.role === "host") call("/v1/live/" + id + "/end", { method: "POST", body: {} });
    hangup();
    stopLocal();
    state.session = null;
    state.role = "";
    state.sheet = "";
    state.chat = [];
    state.roster = [];
    state.invite = "";
    mount("");
    refreshRow();
  }

  function watch(id, query) {
    query = query || new URLSearchParams();
    state.invite = query.get("invite") || state.invite || "";
    if (state.session && state.session.id === id && state.local && state.role === "host") return stageHtml();
    if (state.watchId !== id) {
      state.watchId = id;
      state.joining = false;
      state.session = null;
    }
    if (!state.failed && !state.joining && (!state.session || state.session.id !== id)) {
      state.joining = true;
      state.status = tr("Waiting for the host");
      join(id);
    }
    return '<div class="live-page">' + stageHtml() + (state.invite ? '<label class="live-field">' + esc(tr("Optional password")) + '<input data-live="password" type="password"></label><button type="button" data-act="live-join">' + esc(tr("Watch")) + '</button>' : "") + '</div>';
  }

  function join(id) {
    if (!token()) {
      state.status = tr("Sign in to go live");
      return;
    }
    var body = {};
    if (state.invite) body.invite = state.invite;
    var field = document.querySelector("[data-live='password']");
    if (field && field.value) state.password = field.value;
    if (state.password) body.password = state.password;
    call("/v1/live/" + id + "/ticket", { method: "POST", body: body }).then(function (res) {
      state.joining = false;
      if (!res || !res.live || !res.ticket) {
        state.failed = true;
        state.status = res && res.status === 503 ? tr("The live is full") : tr("This live isn’t available");
        refreshStage();
        return;
      }
      state.failed = false;
      state.session = res.live;
      state.role = res.role === "host" ? "host" : "viewer";
      state.ice = Array.isArray(res.iceServers) ? res.iceServers : [];
      state.status = state.role === "viewer" ? tr("Waiting for the host") : "";
      state.sheet = "stage";
      if (document.querySelector(".live-page")) refreshStage();
      else mount(stageHtml());
      openSocket(res.ticket);
    }).catch(function () {
      state.joining = false;
      state.failed = true;
      state.status = tr("This live isn’t available");
    });
  }

  function onAct(act, el) {
    if (act === "go-live") return openSetup();
    if (act === "live-close") return mount("");
    if (act === "live-source") {
      state.picked = el.getAttribute("data-source") || "camera";
      markSource();
      return;
    }
    if (act === "live-start") return startLive();
    if (act === "live-open") {
      var id = el.getAttribute("data-id") || "";
      if (/^[a-f0-9]{32}$/.test(id)) location.hash = "#/live/" + id;
      return;
    }
    if (act === "live-stop") return leave(true);
    if (act === "live-leave") return leave(false);
    if (act === "live-pause") {
      state.paused = !state.paused;
      setEnabled("video", !state.paused);
      refreshStage();
      return;
    }
    if (act === "live-mute") {
      state.muted = !state.muted;
      setEnabled("audio", !state.muted);
      refreshStage();
      return;
    }
    if (act === "live-change") {
      var order = ["camera", "screen", "both", "tab"].filter(function (kind) {
        if (kind === "camera") return caps().camera;
        return caps().screen;
      });
      var at = order.indexOf(state.picked || "camera");
      var next = order[(at + 1) % order.length] || order[0];
      if (!next) return;
      state.picked = next;
      capture(next).then(function (parts) {
        stopLocal();
        mix(parts);
        Object.keys(state.pcs).forEach(function (id) {
          var pc = state.pcs[id];
          var senders = pc.getSenders();
          tracksFor(id).forEach(function (track, index) {
            if (senders[index] && senders[index].replaceTrack) senders[index].replaceTrack(track);
            else pc.addTrack(track, state.local);
          });
          renegotiate(id);
        });
        attach();
      }).catch(function () {
        state.status = tr("Couldn’t start the camera");
        refreshStage();
      });
      return;
    }
    if (act === "live-record") {
      if (state.recorder) {
        try { state.recorder.stop(); } catch (err) { /* stop still fires onstop */ }
        state.recorder = null;
      } else beginRecord();
      refreshStage();
      return;
    }
    if (act === "live-kick") {
      var who = el.getAttribute("data-id") || "";
      if (!ACCOUNT.test(who) || !state.session) return;
      send({ op: "kick", accountId: who });
      call("/v1/live/" + state.session.id + "/block", { method: "POST", body: { accountId: who } });
      return;
    }
    if (act === "live-react") {
      publishChat({ op: "react", emoji: el.getAttribute("data-emoji") || "♥" });
      return;
    }
    if (act === "live-drop") {
      var dropId = el.getAttribute("data-id") || "";
      state.chat = state.chat.filter(function (item) { return item.id !== dropId; });
      publishChat({ op: "drop", idDrop: dropId });
      return;
    }
    if (act === "live-copy") {
      var link = location.origin + location.pathname + "#/live/" + (state.session ? state.session.id : "");
      if (state.invite) link += "?invite=" + encodeURIComponent(state.invite);
      var done = function () { state.status = tr("Invite link copied"); refreshStage(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done).catch(done);
      else done();
      return;
    }
    if (act === "live-join") {
      state.failed = false;
      state.joining = true;
      if (state.watchId) join(state.watchId);
    }
  }

  function onSubmit(event) {
    var form = event.target;
    if (!form || !form.getAttribute || form.getAttribute("data-act") !== "live-chat") return;
    event.preventDefault();
    var input = form.querySelector("[data-live='chat']");
    var text = input ? String(input.value || "").trim().slice(0, 200) : "";
    if (!text) return;
    input.value = "";
    publishChat({ op: "chat", text: text });
  }

  function onChange(event) {
    var node = event.target;
    if (!node || !node.getAttribute) return;
    var key = node.getAttribute("data-live");
    if (!key) return;
    readForm();
    if (key === "audience") {
      var members = document.querySelector("[data-live-members]");
      var pass = document.querySelector("[data-live-pass]");
      if (members) members.hidden = state.form.audience !== "list";
      if (pass) pass.hidden = state.form.audience !== "invite";
    }
  }

  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("change", onChange, true);
  if (typeof MutationObserver !== "undefined" && document.body) {
    new MutationObserver(function () { paintRow(); }).observe(document.body, { childList: true, subtree: true });
  }
  /* The live row only polls while the tab is visible and lives are on. */
  var rowAt = 0;
  function livesOff() {
    try { return (JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]") || []).indexOf("lives") !== -1; }
    catch (err) { return false; }
  }
  /* With several tabs open, one tab reads /v1/live per round and shares the
     answer with the others over a BroadcastChannel. */
  var ROW_CLAIM = "viktorych-poll-live-row";
  var rowChannel = null;
  try { rowChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("viktorych-live-row") : null; } catch (err) { rowChannel = null; }
  function claimRow(now, force) {
    try {
      var last = Number(localStorage.getItem(ROW_CLAIM)) || 0;
      if (!force && now >= last && now - last < 24000) return false;
      localStorage.setItem(ROW_CLAIM, String(now));
    } catch (err) { /* no storage: this tab polls on its own */ }
    return true;
  }
  function takeRow(next) {
    var stamp = next.map(function (item) { return item.id; }).join(",");
    if (stamp !== state.rowStamp) {
      state.lives = next;
      state.rowStamp = stamp || "empty";
    }
    paintRow();
  }
  if (rowChannel) {
    rowChannel.onmessage = function (event) {
      var data = event && event.data;
      if (!data || !Array.isArray(data.lives) || !token() || livesOff()) return;
      rowAt = Date.now();
      takeRow(data.lives);
    };
  }
  function pollRow(force) {
    if (livesOff()) {
      if (state.lives.length) { state.lives = []; state.rowStamp = "off"; paintRow(); }
      return;
    }
    if (document.visibilityState === "hidden") return;
    if (!force && Date.now() - rowAt < 15000) return;
    // While the change signal is up, the list is read only when its live
    // mark moved, or every ten minutes as a safety net.
    var pulse = root.ViktorychPulse;
    var mark = pulse && pulse.ok && pulse.ok() ? pulse.version("live") : "";
    if (!force && mark && mark === rowMark && Date.now() - rowAt < 10 * 60 * 1000) return;
    rowMark = mark;
    if (!claimRow(Date.now(), force)) return;
    rowAt = Date.now();
    refreshRow();
  }
  var rowMark = "";
  if (root.ViktorychPulse && root.ViktorychPulse.on) root.ViktorychPulse.on(function (keys) { if (keys.indexOf("live") >= 0) pollRow(false); });
  setInterval(function () { pollRow(false); }, 30000);
  document.addEventListener("visibilitychange", function () { pollRow(false); });
  pollRow(true);

  root.ViktorychLive = {
    homeHtml: homeHtml,
    rowExtra: rowExtra,
    page: function (route) { return watch(route.id, route.query); },
    onAct: onAct,
    caps: caps,
    open: openSetup,
    recording: function () { return !!(state.recorder && state.recorder.state && state.recorder.state !== "inactive"); }
  };
})(typeof window !== "undefined" ? window : globalThis);
