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
    contacts: { classic: true, scripts: ["contacts-ui.js", "contacts.css"] },
    localai: { classic: true, scripts: ["settings-registry.js", "local-ai.js", "local-ai-ui.js", "local-ai.css"] }
  };
  var loads = {};
  var preloadStarted = false;

  function notify(name, silent) {
    try {
      window.dispatchEvent(new CustomEvent("vklazy", { detail: { name: name, silent: !!silent } }));
    } catch (err) { /* the page can be mid-navigation; the next render picks it up */ }
  }

  function loadOne(name, entry) {
    var done, failed;
    var promise = new Promise(function (resolve) { done = resolve; failed = resolve; });
    var left = entry.scripts.length;
    if (!left) { done(); return promise; }
    entry.scripts.forEach(function (src) {
      var isStyle = /\.css(\?|$)/i.test(src);
      var pathname = src.replace(/[?#].*$/, "");
      var already = isStyle
        ? document.querySelector('link[rel="stylesheet"][href="' + src + '"]')
        : document.querySelector('script[src="' + src + '"]');
      if (already) { left -= 1; if (left === 0) done(); return; }
      var tag;
      if (isStyle) {
        tag = document.createElement("link");
        tag.rel = "stylesheet";
        tag.href = src;
      } else if (entry.classic) {
        tag = document.createElement("script");
        tag.src = src;
      } else {
        dynamicImport(new URL(src, document.baseURI).href).then(function () {
          left -= 1;
          if (left === 0) done();
        }, function () {
          left -= 1;
          if (left === 0) failed();
        });
        return;
      }
      tag.onload = function () {
        left -= 1;
        if (left === 0) done();
      };
      tag.onerror = function () {
        /* let the page render its fallback and let the next try load again */
        delete loads[name];
        left -= 1;
        if (left === 0) failed();
      };
      if (isStyle) document.head.appendChild(tag);
      else document.body.appendChild(tag);
      void pathname;
    });
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
    if (loads[name]) return loads[name];
    loads[name] = loadOne(name, REGISTRY[name]).then(function () {
      notify(name, silent);
    }, function () { /* offline or blocked; the page keeps its fallback */ });
    return loads[name];
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
    ensure: function (name) { return ensure(name, false); },
    preload: preload,
    serverOff: serverOff
  };
})();
