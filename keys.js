/* Keyboard shortcuts: one registry for every key binding in the app.

   Every action is a named command with default bindings, a scope, and an
   English label that is also its i18n key. Other modules never listen for
   shortcut keys themselves; they call ViktorychKeys.register() or run a
   command by id. Widget-internal keys (arrows inside a listbox, Enter in a
   form field) stay with their widget.

   Binding syntax: combos joined by "+", chords separated by a space.
   "mod" is Cmd on Apple devices and Ctrl elsewhere. Examples: "g h",
   "mod+k", "alt+space", "?", "shift+space", "alt+1".

   Scopes, highest priority first: modal, composer, media, dm, post,
   timeline, global. Two commands conflict when they share a binding (or one
   binding is the start of the other's chord) in the same scope, or when one
   of them is global. Single-character shortcuts can be turned off as a whole
   (WCAG 2.1.4). */
(function (root) {
  "use strict";

  var STORE_KEY = "viktorych-keys-v1";
  var CHORD_MS = 1500;
  var SCOPES = ["modal", "composer", "media", "dm", "post", "timeline", "global"];
  var SCOPE_LABELS = {
    global: "Global",
    timeline: "Timeline",
    post: "Selected post",
    composer: "Composer",
    media: "Media and video",
    dm: "Messages",
    modal: "Dialogs"
  };
  var MODS = ["ctrl", "alt", "shift", "meta"];
  var KEY_ALIASES = {
    " ": "space", spacebar: "space", esc: "escape", arrowleft: "left", arrowright: "right",
    arrowup: "up", arrowdown: "down", del: "delete", return: "enter", apps: "contextmenu",
    plus: "+", control: "ctrl", option: "alt", cmd: "meta", command: "meta", win: "meta", super: "meta"
  };
  var NAMED = ["space", "escape", "enter", "tab", "backspace", "delete", "left", "right", "up", "down",
    "home", "end", "pageup", "pagedown", "insert", "contextmenu", "f1", "f2", "f3", "f4", "f5", "f6",
    "f7", "f8", "f9", "f10", "f11", "f12"];
  // Physical key to the US character, so shortcuts keep working on Cyrillic,
  // Devanagari and other layouts, and with Option on a Mac.
  var CODE_US = {
    Comma: [",", "<"], Period: [".", ">"], Slash: ["/", "?"], Semicolon: [";", ":"], Quote: ["'", "\""],
    BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Minus: ["-", "_"], Equal: ["=", "+"],
    Backquote: ["`", "~"], Backslash: ["\\", "|"],
    Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"], Digit5: ["5", "%"],
    Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", "("], Digit0: ["0", ")"]
  };

  var commands = [];
  var byId = {};
  var prefs = null;
  var compiled = null;
  var pending = [];
  var pendingTimer = 0;
  var listeners = [];
  var menuOpeners = {};
  var sawKeyboard = false;
  var focusId = "";
  // The post ring is a keyboard aid: it shows only after a key moved it, never
  // after a tap, a touch scroll or a mouse click (those just remember the spot).
  var ringOn = false;
  var focusRoute = "";
  var positions = {};
  var chordHash = "";
  var trace = []; // last few key decisions, for tests and bug reports

  function isMac() {
    var nav = root.navigator || {};
    var plat = String((nav.userAgentData && nav.userAgentData.platform) || nav.platform || "");
    if (/mac|iphone|ipad|ipod/i.test(plat)) return true;
    return /Mac OS X|iPhone|iPad/.test(String(nav.userAgent || ""));
  }

  /* ---------- Parsing and formatting ---------- */

  function printable(key) {
    return key.length === 1 && key !== " ";
  }
  function isLetter(key) {
    return /^[a-z]$/.test(key);
  }

  // One combo string ("Mod+Shift+E") to canonical form ("ctrl+shift+e").
  function canonCombo(text, mac) {
    var raw = String(text || "").trim().toLowerCase();
    if (!raw) return "";
    var parts = raw === "+" ? ["+"] : raw.split("+");
    if (raw.length > 1 && raw.slice(-2) === "++") parts = raw.slice(0, -2).split("+").concat(["+"]);
    var mods = {};
    var key = "";
    parts.forEach(function (part, index) {
      var p = KEY_ALIASES[part] || part;
      if (p === "mod") p = (mac === undefined ? isMac() : mac) ? "meta" : "ctrl";
      if (MODS.indexOf(p) >= 0 && index < parts.length - 1) mods[p] = true;
      else key = p;
    });
    key = KEY_ALIASES[key] || key;
    if (!key || MODS.indexOf(key) >= 0) return "";
    if (printable(key) && !isLetter(key) && !/^[0-9]$/.test(key)) delete mods.shift;
    var out = MODS.filter(function (m) { return mods[m]; });
    out.push(key);
    return out.join("+");
  }

  function parseBinding(text, mac) {
    var seq = String(text || "").trim().split(/\s+/).map(function (c) { return canonCombo(c, mac); });
    if (!seq.length || seq.some(function (c) { return !c; })) return null;
    return seq;
  }

  function bindingString(seq) {
    return (seq || []).join(" ");
  }

  // A keydown event to a canonical combo, or "" when it is not a shortcut key.
  function eventCombo(event) {
    if (!event) return "";
    if (event.isComposing || event.keyCode === 229) return "";
    var key = String(event.key || "");
    if (!key || key === "Dead" || key === "Process" || key === "Unidentified") return "";
    if (["Shift", "Control", "Alt", "Meta", "OS", "AltGraph", "CapsLock", "Hyper", "Super", "Fn", "NumLock", "ScrollLock"].indexOf(key) >= 0) return "";
    var code = String(event.code || "");
    var lower = key.toLowerCase();
    var k = KEY_ALIASES[lower] || lower;
    var nonAscii = key.length === 1 && key.charCodeAt(0) > 127;
    if (event.altKey || nonAscii || ((event.ctrlKey || event.metaKey) && key.length === 1 && !/^[\x20-\x7e]$/.test(key))) {
      var m = /^Key([A-Z])$/.exec(code);
      if (m) k = m[1].toLowerCase();
      else if (CODE_US[code]) k = CODE_US[code][event.shiftKey ? 1 : 0];
      else if (code === "Space") k = "space";
    }
    if (/^Numpad[0-9]$/.test(code) && k.length !== 1) k = code.slice(6);
    if (code === "NumpadEnter") k = "enter";
    var mods = [];
    if (event.ctrlKey) mods.push("ctrl");
    if (event.altKey) mods.push("alt");
    if (event.shiftKey && !(printable(k) && !isLetter(k) && !/^[0-9]$/.test(k))) mods.push("shift");
    if (event.metaKey) mods.push("meta");
    // Shift+digit on most layouts types a symbol; keep the symbol.
    if (event.shiftKey && /^[0-9]$/.test(k) && !event.altKey && !event.ctrlKey && !event.metaKey && key.length === 1 && !/^[0-9]$/.test(key)) {
      k = key;
      mods = mods.filter(function (x) { return x !== "shift"; });
    }
    return mods.concat([k]).join("+");
  }

  var GLYPH_MAC = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
  var KEY_NAMES = {
    space: "Space", escape: "Esc", enter: "Enter", tab: "Tab", backspace: "Backspace", delete: "Delete",
    left: "←", right: "→", up: "↑", down: "↓", home: "Home", end: "End", pageup: "Page Up",
    pagedown: "Page Down", contextmenu: "Menu"
  };
  // Display parts for one combo: ["Ctrl", "K"] or ["⌘", "K"].
  function comboParts(combo, mac) {
    if (mac === undefined) mac = isMac();
    var parts = String(combo || "").split("+");
    if (parts.length > 1 && parts[parts.length - 1] === "") parts = parts.slice(0, -2).concat(["+"]);
    var key = parts.pop();
    var out = parts.map(function (m) {
      if (mac) return GLYPH_MAC[m] || m;
      return m === "ctrl" ? "Ctrl" : m === "alt" ? "Alt" : m === "shift" ? "Shift" : m === "meta" ? "Win" : m;
    });
    var name = KEY_NAMES[key] || (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
    if (key.length === 1 && isLetter(key) && parts.length === 0) name = key;
    out.push(name);
    return out;
  }
  function formatBinding(seq, mac) {
    if (mac === undefined) mac = isMac();
    return (seq || []).map(function (c) { return comboParts(c, mac).join(mac ? "" : "+"); }).join(" ");
  }
  var ARIA_KEYS = { space: "Space", escape: "Escape", enter: "Enter", tab: "Tab", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", backspace: "Backspace", delete: "Delete", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", contextmenu: "ContextMenu" };
  var ARIA_MODS = { ctrl: "Control", alt: "Alt", shift: "Shift", meta: "Meta" };
  // aria-keyshortcuts value: alternatives separated by spaces; chords are
  // left out because ARIA has no syntax for key sequences.
  function ariaValue(list) {
    return (list || []).filter(function (seq) { return seq.length === 1; }).map(function (seq) {
      var parts = seq[0].split("+");
      var key = parts.pop();
      return parts.map(function (m) { return ARIA_MODS[m]; }).concat([ARIA_KEYS[key] || (key.length === 1 ? key.toUpperCase() : key)]).join("+");
    }).join(" ");
  }

  // A character-key shortcut has no Ctrl, Alt or Meta in its first combo
  // (WCAG 2.1.4 "Character Key Shortcuts").
  function isCharacterKey(seq) {
    if (!seq || !seq.length) return false;
    var parts = seq[0].split("+");
    var key = parts.pop();
    if (parts.some(function (m) { return m !== "shift"; })) return false;
    return key.length === 1;
  }

  /* ---------- Registry ---------- */

  function register(def) {
    if (!def || !def.id || typeof def.run !== "function") return null;
    var cmd = {
      id: String(def.id),
      keys: (def.keys || []).slice(),
      label: String(def.label || def.id),
      vars: def.vars || null,
      scope: SCOPES.indexOf(def.scope) >= 0 ? def.scope : "global",
      run: def.run,
      when: typeof def.when === "function" ? def.when : null,
      input: !!def.input,
      overModal: !!def.overModal,
      repeat: !!def.repeat,
      palette: def.palette !== false,
      group: def.group || "",
      keywords: def.keywords || ""
    };
    if (byId[cmd.id]) commands.splice(commands.indexOf(byId[cmd.id]), 1);
    byId[cmd.id] = cmd;
    commands.push(cmd);
    compiled = null;
    return cmd;
  }

  function unregister(id) {
    var cmd = byId[id];
    if (!cmd) return;
    commands.splice(commands.indexOf(cmd), 1);
    delete byId[id];
    compiled = null;
  }

  function cleanPrefs(raw) {
    var out = { v: 1, enabled: true, singleKeys: true, overrides: {}, at: 0 };
    if (!raw || typeof raw !== "object") return out;
    if (raw.enabled === false) out.enabled = false;
    if (raw.singleKeys === false) out.singleKeys = false;
    out.at = Number(raw.at) || 0;
    var ov = raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {};
    Object.keys(ov).slice(0, 400).forEach(function (id) {
      if (!/^[a-z0-9._:-]{1,64}$/i.test(id) || !Array.isArray(ov[id])) return;
      var list = ov[id].slice(0, 4).map(function (b) { return String(b || "").slice(0, 60); }).filter(function (b) { return !!parseBinding(b, false); });
      out.overrides[id] = list;
    });
    return out;
  }

  function readPrefs() {
    if (prefs) return prefs;
    var host = root.ViktorychKeysHost;
    var fromHost = host && host.keyboardPrefs ? host.keyboardPrefs() : null;
    var local = null;
    try { local = JSON.parse((root.localStorage && root.localStorage.getItem(STORE_KEY)) || "null"); } catch (err) { local = null; }
    var a = fromHost ? cleanPrefs(fromHost) : null;
    var b = local ? cleanPrefs(local) : null;
    prefs = a && (!b || a.at >= b.at) ? a : (b || cleanPrefs(null));
    return prefs;
  }

  function savePrefs(next) {
    prefs = cleanPrefs(next);
    prefs.at = Date.now();
    compiled = null;
    try { if (root.localStorage) root.localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch (err) { /* private mode keeps it in memory */ }
    var host = root.ViktorychKeysHost;
    if (host && host.saveKeyboardPrefs) host.saveKeyboardPrefs(prefs);
    emit();
    return prefs;
  }

  function reloadPrefs() {
    prefs = null;
    compiled = null;
    emit();
  }

  function onChange(fn) { if (typeof fn === "function") listeners.push(fn); }
  function emit() {
    listeners.forEach(function (fn) { try { fn(); } catch (err) { /* one listener must not stop the rest */ } });
  }

  // Effective bindings of a command after user overrides: list of sequences.
  function bindingsOf(id, mac) {
    var cmd = byId[id];
    if (!cmd) return [];
    var p = readPrefs();
    var list = Object.prototype.hasOwnProperty.call(p.overrides, id) ? p.overrides[id] : cmd.keys;
    var out = [];
    list.forEach(function (b) {
      var seq = parseBinding(b, mac);
      if (seq) out.push(seq);
    });
    return out;
  }

  function overlaps(a, b) {
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function scopesClash(a, b) {
    return a === b || a === "global" || b === "global";
  }

  // Every conflicting pair under the current bindings, or only those that
  // involve `seq` for command `id` when checking a new binding.
  function conflicts(id, seq, mac) {
    var out = [];
    var me = id ? byId[id] : null;
    commands.forEach(function (cmd) {
      if (me && cmd.id === me.id) return;
      var scopeA = me ? me.scope : null;
      if (scopeA && !scopesClash(scopeA, cmd.scope)) return;
      bindingsOf(cmd.id, mac).forEach(function (other) {
        if (seq && overlaps(seq, other)) out.push({ id: cmd.id, label: cmd.label, binding: bindingString(other), exact: seq.length === other.length });
      });
    });
    return out;
  }
  function allConflicts(mac) {
    var out = [];
    for (var i = 0; i < commands.length; i++) {
      for (var j = i + 1; j < commands.length; j++) {
        var a = commands[i];
        var b = commands[j];
        if (!scopesClash(a.scope, b.scope)) continue;
        var la = bindingsOf(a.id, mac);
        var lb = bindingsOf(b.id, mac);
        la.forEach(function (x) {
          lb.forEach(function (y) {
            if (overlaps(x, y)) out.push([a.id, b.id, bindingString(x), bindingString(y)]);
          });
        });
      }
    }
    return out;
  }

  // Set a command's bindings; returns { ok, conflicts }. With replace, the
  // conflicting bindings are removed from the other commands.
  function rebind(id, list, opts) {
    var cmd = byId[id];
    if (!cmd) return { ok: false, conflicts: [] };
    var seqs = [];
    (list || []).forEach(function (b) { var s = parseBinding(b); if (s) seqs.push(s); });
    var found = [];
    seqs.forEach(function (s) { found = found.concat(conflicts(id, s)); });
    if (found.length && !(opts && opts.replace)) return { ok: false, conflicts: found };
    var p = JSON.parse(JSON.stringify(readPrefs()));
    found.forEach(function (c) {
      var keep = bindingsOf(c.id).filter(function (s) { return !seqs.some(function (mine) { return overlaps(mine, s); }); });
      p.overrides[c.id] = keep.map(bindingString);
    });
    p.overrides[id] = seqs.map(bindingString);
    savePrefs(p);
    return { ok: true, conflicts: found };
  }
  function resetCommand(id) {
    var p = JSON.parse(JSON.stringify(readPrefs()));
    delete p.overrides[id];
    savePrefs(p);
  }
  function resetAll() {
    var p = readPrefs();
    savePrefs({ v: 1, enabled: p.enabled, singleKeys: true, overrides: {} });
  }
  function setOption(name, value) {
    var p = JSON.parse(JSON.stringify(readPrefs()));
    if (name === "enabled" || name === "singleKeys") p[name] = !!value;
    savePrefs(p);
  }
  function exportJson() {
    var p = readPrefs();
    return JSON.stringify({ app: "viktorych-keys", v: 1, enabled: p.enabled, singleKeys: p.singleKeys, overrides: p.overrides }, null, 2);
  }
  function importJson(text) {
    var data;
    try { data = JSON.parse(String(text || "")); } catch (err) { return { ok: false }; }
    if (!data || typeof data !== "object" || (data.app && data.app !== "viktorych-keys")) return { ok: false };
    var next = cleanPrefs(data);
    savePrefs(next);
    return { ok: true, count: Object.keys(next.overrides).length };
  }

  /* ---------- Context and dispatch ---------- */

  function compile() {
    if (compiled) return compiled;
    var p = readPrefs();
    var entries = [];
    commands.forEach(function (cmd) {
      bindingsOf(cmd.id).forEach(function (seq) {
        if (!p.singleKeys && isCharacterKey(seq)) return;
        entries.push({ cmd: cmd, seq: seq });
      });
    });
    compiled = entries;
    return entries;
  }

  function typingIn(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    var tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      var type = String(el.type || "text").toLowerCase();
      return ["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image"].indexOf(type) < 0;
    }
    var role = el.getAttribute && el.getAttribute("role");
    if (role === "textbox" || role === "searchbox" || role === "combobox" || role === "spinbutton") return true;
    return !!(el.closest && el.closest("[contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"));
  }
  function activatable(el) {
    if (!el || el.nodeType !== 1 || !el.closest) return false;
    return !!el.closest("button, input, label, a[href], summary, select, video, audio, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [role='option'], [role='checkbox'], [role='radio'], [role='switch'], [role='slider']");
  }

  // Inputs with modifier shortcuts can still run while typing; single keys never.
  function inputSafe(combo) {
    var parts = combo.split("+");
    var key = parts[parts.length - 1];
    if (key === "escape" || key === "tab") return true;
    return parts.some(function (m) { return m === "ctrl" || m === "alt" || m === "meta"; });
  }

  function candidates(ctx, typing) {
    var list = compile();
    var out = [];
    list.forEach(function (entry) {
      var cmd = entry.cmd;
      if (!ctx.scopes[cmd.scope]) return;
      if (ctx.blocked && cmd.scope !== "modal" && !cmd.overModal && !(ctx.scopes.composer && cmd.scope === "composer") && !(ctx.scopes.media && cmd.scope === "media")) return;
      if (typing && (!cmd.input || !inputSafe(entry.seq[0]))) return;
      out.push(entry);
    });
    return out;
  }

  function rank(entry) { return SCOPES.indexOf(entry.cmd.scope); }

  /* Pure chord step, used by the dispatcher and the tests. Returns
     { action: "run", entry } | { action: "wait" } | { action: "none" }. */
  function step(seq, list, ctx) {
    var exact = [];
    var longer = false;
    list.forEach(function (entry) {
      if (!overlaps(seq, entry.seq)) return;
      if (entry.seq.length === seq.length) exact.push(entry);
      else if (entry.seq.length > seq.length) longer = true;
    });
    exact = exact.filter(function (e) { return !e.cmd.when || e.cmd.when(ctx || {}); });
    exact.sort(function (a, b) { return rank(a) - rank(b); });
    if (longer) return { action: "wait", exact: exact[0] || null };
    if (exact.length) return { action: "run", entry: exact[0] };
    return { action: "none" };
  }

  function context() {
    var host = root.ViktorychKeysHost;
    var hs = host && host.state ? host.state() : {};
    var doc = root.document;
    var active = doc ? doc.activeElement : null;
    var overlay = !!(doc && doc.querySelector(".kb-overlay:not([hidden])"));
    var foreignDialog = false;
    if (doc && !overlay) {
      var dlg = doc.querySelector("[role='dialog'][aria-modal='true']:not([hidden]), dialog[open]");
      foreignDialog = !!(dlg && dlg.getClientRects().length);
    }
    var composer = !!(hs.modal === "compose" || (active && active.closest && active.closest(".xc, [data-xc], .xc-tools, .compose")));
    var media = !!(hs.viewer || (doc && doc.fullscreenElement) || (active && active.closest && active.closest(".vplay, video, #viewer")));
    var modal = overlay || !!hs.modal || !!hs.drawer || !!hs.menu || !!hs.viewer || foreignDialog;
    var route = hs.route || "";
    var posts = !!(doc && doc.querySelector("main article.post[data-post], .center article.post[data-post]"));
    var post = !!currentPost();
    return {
      host: hs,
      route: route,
      active: active,
      blocked: modal,
      scopes: {
        global: true,
        timeline: posts,
        post: post,
        composer: composer,
        media: media,
        dm: route === "messages",
        modal: modal
      }
    };
  }

  function clearPending() {
    pending = [];
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = 0;
    chordToast("");
  }

  function runEntry(entry, ctx, event) {
    var handled;
    try { handled = entry.cmd.run(ctx, event); } catch (err) { handled = false; }
    return handled !== false;
  }

  function onKeyDown(event) {
    if (!event || event.defaultPrevented) return;
    var doc = root.document;
    if (doc && doc.documentElement && doc.documentElement.classList.contains("tv-on")) return;
    var combo = eventCombo(event);
    if (!combo) return;
    var target = event.target;
    var typing = typingIn(target);
    if (!typing) sawKeyboard = true;
    if (!readPrefs().enabled) {
      // Only Esc keeps working, so dialogs still close.
      if (combo !== "escape") return;
    }
    if (!pending.length && (combo === "enter" || combo === "space") && activatable(target) && !(target.matches && target.matches("article.post"))) return;
    var ctx = context();
    var list = candidates(ctx, typing);
    var seq = pending.concat([combo]);
    var res = step(seq, list, ctx);
    trace.push([combo, typing ? "typing" : "", ctx.blocked ? "blocked" : "", seq.join(" "), res.action]);
    if (trace.length > 12) trace.shift();
    if (res.action === "none" && pending.length) {
      clearPending();
      if (combo === "escape") { event.preventDefault(); return; }
      seq = [combo];
      res = step(seq, list, ctx);
    }
    if (res.action === "wait") {
      event.preventDefault();
      if (!pending.length) chordHash = root.location ? root.location.hash : "";
      pending = seq;
      if (pendingTimer) clearTimeout(pendingTimer);
      var fallback = res.exact;
      pendingTimer = setTimeout(function () {
        pendingTimer = 0;
        var waited = pending;
        clearPending();
        if (fallback && waited.length === fallback.seq.length) runEntry(fallback, context(), null);
      }, CHORD_MS);
      chordToast(seq, list);
      return;
    }
    if (res.action === "run") {
      if (event.repeat && !res.entry.cmd.repeat) { event.preventDefault(); return; }
      clearPending();
      if (runEntry(res.entry, ctx, event)) event.preventDefault();
    }
  }

  /* ---------- Chord toast ---------- */

  function chordToast(seq, list) {
    var doc = root.document;
    if (!doc || !doc.body) return;
    var el = doc.getElementById("kb-chord");
    if (!seq || !seq.length) { if (el) el.hidden = true; return; }
    if (!el) {
      el = doc.createElement("div");
      el.id = "kb-chord";
      el.className = "kb-chord";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      doc.body.appendChild(el);
    }
    var next = [];
    (list || []).forEach(function (entry) {
      if (entry.seq.length > seq.length && overlaps(seq, entry.seq)) next.push(entry);
    });
    var hints = next.slice(0, 8).map(function (entry) {
      return '<span class="kb-chord-hint"><kbd>' + esc(comboParts(entry.seq[seq.length]).join(" ")) + "</kbd> " + esc(label(entry.cmd)) + "</span>";
    }).join("");
    el.innerHTML = '<span class="kb-chord-keys">' + seq.map(function (c) { return "<kbd>" + esc(comboParts(c).join(" ")) + "</kbd>"; }).join(" ") + ' …</span>' + (hints ? '<span class="kb-chord-hints">' + hints + "</span>" : "");
    el.hidden = false;
    el.style.setProperty("--kb-chord-ms", CHORD_MS + "ms");
    el.classList.remove("kb-run");
    void el.offsetWidth;
    el.classList.add("kb-run");
  }

  /* ---------- Labels ---------- */

  function fill(text, vars) {
    if (!vars) return String(text);
    return String(text).replace(/\{(\w+)\}/g, function (_, n) { return vars[n] == null ? "" : String(vars[n]); });
  }
  function tr(key, vars) {
    var i18n = root.SI18n;
    return i18n && i18n.t ? i18n.t(key, vars) : fill(key, vars);
  }
  function label(cmd) { return tr(cmd.label, cmd.vars || undefined); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; });
  }

  /* ---------- Post focus (j / k) ---------- */

  function postList() {
    var doc = root.document;
    if (!doc) return [];
    var scope = doc.querySelector("main.center") || doc;
    var all = scope.querySelectorAll("article.post[data-post]");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.closest(".quote, .menu, [hidden]")) continue;
      if (!el.getClientRects().length) continue;
      out.push(el);
    }
    return out;
  }
  function routeKey() {
    try { return String(root.location.hash || "#/"); } catch (err) { return ""; }
  }
  function currentPost() {
    if (!focusId || focusRoute !== routeKey()) return null;
    var doc = root.document;
    if (!doc) return null;
    var list = doc.querySelectorAll('article.post[data-post="' + cssEsc(focusId) + '"]');
    for (var i = 0; i < list.length; i++) if (list[i].getClientRects().length) return list[i];
    return null;
  }
  function cssEsc(v) {
    return String(v).replace(/["\\]/g, "\\$&");
  }
  // Height of whatever sticky or fixed header covers the top of the column,
  // including the translucent mobile bar.
  function headerOffset(el) {
    var doc = root.document;
    if (!doc || !doc.elementFromPoint) return 0;
    el = el || currentPost() || postList()[0] || doc.querySelector("main") || doc.body;
    if (!el || !el.getBoundingClientRect) return 0;
    var rect = el.getBoundingClientRect();
    var x = Math.max(1, Math.min((root.innerWidth || 800) - 1, rect.left + Math.min(40, rect.width / 2)));
    var y = 0;
    for (var probe = 1; probe < 260; probe += 6) {
      var hit = doc.elementFromPoint(x, probe);
      var covered = false;
      for (var n = hit; n && n !== doc.body && n.nodeType === 1; n = n.parentElement) {
        if (n === el || n.contains(el)) break;
        var pos = root.getComputedStyle(n).position;
        if (pos === "sticky" || pos === "fixed") { covered = true; break; }
      }
      if (!covered) break;
      y = probe + 6;
    }
    return y;
  }
  function reducedMotion() {
    try { return root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (err) { return false; }
  }
  function focusPost(el, opts) {
    if (!el) return false;
    var doc = root.document;
    doc.querySelectorAll("article.post.kb-focus").forEach(function (old) { if (old !== el) { old.classList.remove("kb-focus"); } });
    focusId = el.getAttribute("data-post") || "";
    focusRoute = routeKey();
    positions[focusRoute] = focusId;
    ringOn = true;
    el.classList.add("kb-focus");
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    if (!el.getAttribute("aria-keyshortcuts")) el.setAttribute("aria-keyshortcuts", postAria());
    var top = headerOffset(el);
    var rect = el.getBoundingClientRect();
    var view = root.innerHeight || doc.documentElement.clientHeight;
    el.style.scrollMarginTop = (top + 8) + "px";
    try { el.focus({ preventScroll: true }); } catch (err) { el.focus(); }
    if ((opts && opts.align) || rect.top < top || rect.bottom > view) {
      el.scrollIntoView({ block: "start", behavior: reducedMotion() ? "auto" : "smooth" });
    }
    return true;
  }
  function postAria() {
    return ["post.like", "post.reply", "post.repost", "post.bookmark", "post.open"].map(function (id) { return ariaValue(bindingsOf(id)); }).filter(Boolean).join(" ");
  }
  function movePost(delta) {
    var list = postList();
    if (!list.length) return false;
    var cur = currentPost();
    var at = cur ? list.indexOf(cur) : -1;
    if (at < 0) {
      // Start from the first post below the header.
      var top = headerOffset(list[0]);
      for (var i = 0; i < list.length; i++) {
        if (list[i].getBoundingClientRect().bottom > top + 4) { at = delta > 0 ? i - 1 : i + 1; break; }
      }
      if (at < -1) at = -1;
    }
    var next = Math.max(0, Math.min(list.length - 1, at + delta));
    return focusPost(list[next], { align: true });
  }
  // Re-apply the ring after a re-render replaced the post's element.
  function restoreFocus() {
    var key = routeKey();
    if (focusRoute !== key && positions[key]) { focusId = positions[key]; focusRoute = key; }
    var el = currentPost();
    if (ringOn && el && !el.classList.contains("kb-focus")) {
      el.classList.add("kb-focus");
      el.setAttribute("tabindex", "-1");
    }
  }

  /* ---------- Menus for other modules (sidebar right-click etc.) ---------- */

  var menus = {
    register: function (id, open) { if (id && typeof open === "function") menuOpeners[String(id)] = open; },
    unregister: function (id) { delete menuOpeners[String(id)]; },
    has: function (id) { return !!menuOpeners[String(id)]; },
    ids: function () { return Object.keys(menuOpeners); },
    idFor: function (el) {
      if (!el || !el.closest) return "";
      var item = el.closest("[data-menu-id], header.nav .nav-item, .bottom-nav a, .bottom-nav button, .fab");
      if (!item) return "";
      if (item.getAttribute("data-menu-id")) return item.getAttribute("data-menu-id");
      if (item.classList.contains("fab") || item.classList.contains("post-btn")) return "compose";
      var href = item.getAttribute("href") || "";
      var m = /^#\/([^/?]*)/.exec(href);
      if (m) return m[1] || "home";
      return item.getAttribute("data-act") || "";
    },
    open: function (id, anchor) {
      var fn = menuOpeners[String(id)];
      if (!fn && typeof root.openNavMenu === "function") {
        // Sidebar tab menus (nav menus) open through the nav's own API.
        try { root.openNavMenu(String(id), { anchor: anchor || null }); return true; } catch (err) { return false; }
      }
      if (!fn) return false;
      try { return fn(anchor || null) !== false; } catch (err) { return false; }
    }
  };

  /* ---------- Public API ---------- */

  function run(id, extra) {
    var cmd = byId[id];
    if (!cmd) return false;
    var ctx = context();
    if (extra) Object.keys(extra).forEach(function (k) { ctx[k] = extra[k]; });
    if (cmd.when && !cmd.when(ctx)) return false;
    return runEntry({ cmd: cmd, seq: [] }, ctx, null);
  }

  function start() {
    var doc = root.document;
    if (!doc || start.done) return;
    start.done = true;
    doc.addEventListener("keydown", onKeyDown);
    // A chord is cancelled only when the page changes after it started; the
    // hashchange event of a navigation can arrive after the next key press.
    root.addEventListener("hashchange", function () {
      var now = root.location ? root.location.hash : "";
      if (pending.length && now !== chordHash) clearPending();
      setTimeout(restoreFocus, 60);
    });
    root.addEventListener("viktorych-settings-applied", reloadPrefs);
    root.addEventListener("storage", function (event) { if (!event || event.key === STORE_KEY) reloadPrefs(); });
    doc.addEventListener("pointerdown", function (event) {
      var post = event.target && event.target.closest && event.target.closest("article.post[data-post]");
      if (post) { focusId = post.getAttribute("data-post") || ""; focusRoute = routeKey(); positions[focusRoute] = focusId; }
      ringOn = false;
      doc.querySelectorAll("article.post.kb-focus").forEach(function (el) { el.classList.remove("kb-focus"); });
    }, true);
    if (root.MutationObserver) {
      var queued = false;
      new root.MutationObserver(function () {
        if (!focusId || queued) return;
        queued = true;
        (root.requestAnimationFrame || setTimeout)(function () { queued = false; restoreFocus(); });
      }).observe(doc.body || doc.documentElement, { childList: true, subtree: true });
    }
  }

  var api = {
    SCOPES: SCOPES,
    SCOPE_LABELS: SCOPE_LABELS,
    CHORD_MS: CHORD_MS,
    STORE_KEY: STORE_KEY,
    register: register,
    unregister: unregister,
    commands: function () { return commands.slice(); },
    command: function (id) { return byId[id] || null; },
    run: run,
    bindingsOf: bindingsOf,
    conflicts: conflicts,
    allConflicts: allConflicts,
    rebind: rebind,
    resetCommand: resetCommand,
    resetAll: resetAll,
    setOption: setOption,
    prefs: function () { return readPrefs(); },
    reloadPrefs: reloadPrefs,
    exportJson: exportJson,
    importJson: importJson,
    onChange: onChange,
    parseBinding: parseBinding,
    canonCombo: canonCombo,
    eventCombo: eventCombo,
    formatBinding: formatBinding,
    comboParts: comboParts,
    ariaValue: ariaValue,
    isCharacterKey: isCharacterKey,
    typingIn: typingIn,
    inputSafe: inputSafe,
    step: step,
    candidates: candidates,
    context: context,
    onKeyDown: onKeyDown,
    pending: function () { return pending.slice(); },
    trace: function () { return trace.slice(); },
    clearPending: clearPending,
    label: label,
    tr: tr,
    esc: esc,
    isMac: isMac,
    sawKeyboard: function () { return sawKeyboard; },
    posts: postList,
    currentPost: currentPost,
    focusPost: focusPost,
    movePost: movePost,
    headerOffset: headerOffset,
    menus: menus,
    start: start
  };
  root.ViktorychKeys = api;
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis);
