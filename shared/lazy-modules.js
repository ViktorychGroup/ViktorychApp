/* Lazy route modules. The pages Shorts, Games, TV, Vault, Drive, Communities and
   Messages servers
   load only when the user actually opens them; during idle time the browser
   quietly preloads them one by one so the first click is instant. Classic
   scripts are injected as <script>, ES modules come through import(). */
(function () {
  var REGISTRY = {
    shorts: { classic: true, scripts: ["shorts.js", "shorts.css"] },
    games: { classic: true, scripts: ["games.js", "games.css"] },
    tv: { classic: true, scripts: ["tv-page.js", "tv-page.css"] },
    tvpair: { classic: true, scripts: ["vendor/qrcode-1.4.4.js", "tv-pair.js", "tv-pair.css"] },
    sendtv: { classic: true, scripts: ["send-tv.js", "send-tv.css"] },
    vault: { classic: false, scripts: ["vault.js", "vault.css"] },
    packages: { classic: false, scripts: ["packages.js", "packages.css"] },
    drive: { classic: false, scripts: ["drive.js", "drive.css"] },
    communities: { classic: true, scripts: ["communities.js", "communities.css"] },
    servers: { classic: true, scripts: ["servers-voice.js", "servers-ui.js", "servers.css"] },
    inboxsms: { classic: true, scripts: ["inbox-sms.js", "inbox-sms.css", "inbox-mail.css"] },
    inboxmail: { classic: true, scripts: ["inbox-mail.js", "inbox-sms.css", "inbox-mail.css"] },
    owner_inspector: { classic: true, scripts: ["owner-inspector.js", "owner-inspector.css"] },
    contacts: { classic: true, scripts: ["contacts-ui.js", "contacts.css"] },
    localai: { classic: true, scripts: ["settings-registry.js", "local-ai.js", "local-ai-actions.js", "local-ai-tools.js", "local-ai-memory.js", "local-ai-chat.js", "local-ai-runner.js", "local-ai-device-setup.js", "local-ai-voice.js", "local-ai-ui.js", "local-ai.css"] },
    /* Music loads when its page opens, or when a song is already queued, so
       the mini player comes back after a reload. It is not on the first load. */
    music: { classic: true, scripts: ["ytm.js", "music.js", "music.css"] },
    /* Loaded with the page only when that screen is open. Idle time fetches
       the rest one by one so the first visit stays small. */
    discord: { classic: true, scripts: ["discord-ui.js", "discord-picks.js", "discord-local.js", "discord-key-helper.js", "discord-ui.css", "discord-local.css", "discord-key-helper.css"] },
    gifts: { classic: true, modules: ["shared/gift-catalog.js", "shared/store-catalog.js"], scripts: ["gifts-ui.js", "nft-ui.js", "gifts.css"] },
    nostr: { classic: true, scripts: ["nostr.js"] },
    mesh: { classic: true, scripts: ["mesh-chat.js"] },
    tvshell: { classic: true, scripts: ["tv.js", "tv.css"] }
  };
  var loads = {};
  var preloadStarted = false;

  function notify(name, silent) {
    try {
      window.dispatchEvent(new CustomEvent("vklazy", { detail: { name: name, silent: !!silent } }));
    } catch (err) { /* the page can be mid-navigation; the next render picks it up */ }
  }

  /* One file at a time, in the listed order. A page that paints before its
     planner (Local AI) or its module (a deep link) would show a shell that
     cannot answer. Classic scripts also set async=false so a direct visit
     that already inserted them still runs them before app.js. */
  function loadScripts(name, list, classic, done) {
    var i = 0;
    function step() {
      if (i >= list.length) { done(); return; }
      var src = list[i++];
      var isStyle = /\.css(\?|$)/i.test(src);
      var already = isStyle
        ? document.querySelector('link[rel="stylesheet"][href="' + src + '"]')
        : document.querySelector('script[src="' + src + '"]');
      if (already) { step(); return; }
      if (!isStyle && !classic) {
        dynamicImport(new URL(src, document.baseURI).href).then(step, step);
        return;
      }
      var tag;
      if (isStyle) {
        tag = document.createElement("link");
        tag.rel = "stylesheet";
        tag.href = src;
      } else {
        tag = document.createElement("script");
        tag.async = false;
        tag.src = src;
      }
      tag.onload = step;
      tag.onerror = function () {
        if (!isStyle) delete loads[name];
        step();
      };
      if (isStyle) document.head.appendChild(tag);
      else document.body.appendChild(tag);
    }
    step();
  }

  function loadOne(name, entry) {
    var done, failed;
    var promise = new Promise(function (resolve) { done = resolve; failed = resolve; });
    var mods = entry.modules || [];
    var scripts = entry.scripts || [];
    if (!mods.length && !scripts.length) { done(); return promise; }
    /* Modules publish their globals. Classic scripts run after that. */
    loadScripts(name, mods, false, function () {
      loadScripts(name, scripts, !!entry.classic, function () { done(); });
    });
    void failed;
    return promise;
  }

  var dynamicImport = (function () {
    try { return new Function("u", "return import(u);"); }
    catch (err) { return function () { return Promise.reject(err); }; }
  })();

  /* Features the owner switched off on the server are never loaded. */
  function serverOff(name) {
    try {
      var list = JSON.parse(localStorage.getItem("viktorychapp-server-off") || "[]");
      return Array.isArray(list) && list.indexOf(name) !== -1;
    } catch (err) { return false; }
  }

  /* TV "lighter start": only preload what a sidebar item depends on. */
  var NAV_GATED = ["shorts"];
  function tvLazyStart() {
    var tv = window.ViktorychTVMode;
    return !!(tv && tv.on && tv.pref("lazyStart") === true);
  }

  /* Idle preloading is skipped on metered or slow connections. */
  function lightNetwork() {
    var c = navigator.connection || {};
    return !!c.saveData || /(^|-)(2g|3g)$/.test(String(c.effectiveType || ""));
  }

  function ensure(name, silent) {
    if (!REGISTRY[name] || serverOff(name)) return Promise.resolve();
    var existing = loads[name];
    if (existing) {
      /* A quiet preload must not swallow a real visit to the page. */
      if (!silent && existing.silent) {
        existing.silent = false;
        existing.then(function () { notify(name, false); });
      }
      return existing;
    }
    var task = loadOne(name, REGISTRY[name]).then(function () {
      notify(name, !!task.silent);
    }, function () { /* offline or blocked; the page keeps its fallback */ });
    task.silent = !!silent;
    loads[name] = task;
    return task;
  }

  function preload(list) {
    if (preloadStarted) return;
    preloadStarted = true;
    if (lightNetwork()) return;
    if (tvLazyStart()) list = (list || []).filter(function (name) { return NAV_GATED.indexOf(name) !== -1; });
    var start = (typeof requestIdleCallback === "function")
      ? new Promise(function (resolve) { requestIdleCallback(function () { resolve(); }); })
      : new Promise(function (resolve) { setTimeout(resolve, 2500); });
    start.then(function () {
      var chain = Promise.resolve();
      (list || []).forEach(function (name) {
        chain = chain.then(function () { return ensure(name, true); });
      });
    });
  }

  window.ViktorychLazy = {
    ensure: function (name, silent) { return ensure(name, !!silent); },
    preload: preload,
    serverOff: serverOff
  };
})();
