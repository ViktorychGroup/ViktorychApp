/* Settings → Site permissions (owner switch site_permissions): the live
   state of each browser permission this app can use, read with the
   Permissions API and refreshed when it changes. "Ask first" rows get a
   one-tap Allow that opens the browser's own prompt; "Blocked" rows show
   short steps for Chrome on Android, the installed app's App info page and
   Android's own setting for Chrome. Nothing here is sent anywhere. */
(function () {
  function tr(key, vars) { return window.t ? window.t(key, vars) : key; }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function stopStream(stream) {
    try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (err) { /* already stopped */ }
  }
  function media(kind) {
    return function () {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve();
      var want = kind === "camera" ? { video: true } : { audio: true };
      return navigator.mediaDevices.getUserMedia(want).then(stopStream, function () {});
    };
  }

  /* id: Permissions API name. title/desc: plain words. ask: opens the
     browser prompt (only offered while the state is "prompt"). */
  var PERMS = [
    { id: "notifications", title: "Notifications", desc: "Alerts for replies, messages and mentions.",
      ask: function () { return window.Notification && Notification.requestPermission ? Promise.resolve(Notification.requestPermission()).catch(function () {}) : Promise.resolve(); },
      fallback: function () { return window.Notification ? (Notification.permission === "default" ? "prompt" : Notification.permission) : ""; } },
    { id: "geolocation", title: "Location", desc: "Only used when you add a place or look for things nearby.",
      ask: function () {
        return new Promise(function (resolve) {
          if (!navigator.geolocation) return resolve();
          navigator.geolocation.getCurrentPosition(function () { resolve(); }, function () { resolve(); }, { timeout: 15000, maximumAge: Infinity });
        });
      } },
    { id: "camera", title: "Camera", desc: "For photos, video and live streams you start.", ask: media("camera") },
    { id: "microphone", title: "Microphone", desc: "For voice notes, calls and live streams you start.", ask: media("microphone") },
    { id: "persistent-storage", title: "Keep saved data", desc: "Asks the browser not to clear saved posts and media when space runs low.",
      ask: function () { return navigator.storage && navigator.storage.persist ? navigator.storage.persist().catch(function () {}) : Promise.resolve(); },
      fallback: function () { return navigator.storage && navigator.storage.persisted ? navigator.storage.persisted().then(function (v) { return v ? "granted" : "prompt"; }) : ""; } },
    { id: "periodic-background-sync", title: "Background refresh", desc: "Lets the installed app fetch new posts now and then while it is closed.", readOnly: true }
  ];

  var watched = {};
  var last = {};

  function query(p) {
    var viaApi = navigator.permissions && navigator.permissions.query
      ? navigator.permissions.query({ name: p.id }).then(function (status) {
        if (!watched[p.id]) {
          watched[p.id] = true;
          try { status.addEventListener("change", function () { last[p.id] = status.state; paintRow(p); }); } catch (err) { /* no live updates */ }
        }
        return status.state;
      })
      : Promise.reject(new Error("no permissions api"));
    return viaApi.catch(function () { return p.fallback ? p.fallback() : ""; }).then(function (state) {
      return state || "unsupported";
    }, function () { return "unsupported"; });
  }

  function stateLabel(state) {
    if (state === "granted") return tr("Allowed");
    if (state === "denied") return tr("Blocked");
    if (state === "prompt") return tr("Ask first");
    if (state === "unsupported") return tr("Not available in this browser");
    return tr("Checking…");
  }

  function guideHtml(p) {
    var name = tr(p.title);
    var steps;
    if (p.id === "persistent-storage" || p.id === "periodic-background-sync") {
      steps = [
        tr("Chrome decides this by itself. Installing the app and using it often makes it allow this."),
        tr("Allowing notifications also helps Chrome keep this app's data.")
      ];
    } else {
      steps = [
        tr("In Chrome on Android: tap the icon left of the address, then Permissions, and turn on {perm}.", { perm: name }),
        tr("Or in Chrome: ⋮ → Settings → Site settings → {perm} → this site → Allow.", { perm: name }),
        tr("Installed app: touch and hold its icon → App info → Permissions (or Notifications) → {perm} → Allow.", { perm: name }),
        tr("Still blocked? Allow {perm} for Chrome itself: Android Settings → Apps → Chrome → Permissions.", { perm: name })
      ];
    }
    return '<ol class="siteperm-steps">' + steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" +
      '<button class="outline siteperm-again" type="button" data-sp-again="' + esc(p.id) + '">' + esc(tr("Check again")) + "</button>";
  }

  function rowInner(p, state) {
    var action = "";
    if (state === "prompt" && !p.readOnly && p.ask) {
      action = '<button class="primary siteperm-allow" type="button" data-sp-ask="' + esc(p.id) + '">' + esc(tr("Allow")) + "</button>";
    }
    return '<div class="siteperm-head"><span class="set-copy"><b>' + esc(tr(p.title)) + '</b><span class="set-sub">' + esc(tr(p.desc)) + "</span></span>" +
      '<span class="siteperm-state siteperm-is-' + esc(state || "checking") + '">' + esc(stateLabel(state)) + "</span>" + action + "</div>" +
      (state === "denied" || (state === "prompt" && p.readOnly) ? guideHtml(p) : "");
  }

  function paintRow(p) {
    var el = document.querySelector('[data-sp-row="' + p.id + '"]');
    if (el) el.innerHTML = rowInner(p, last[p.id]);
  }

  function refresh(onlyId) {
    PERMS.forEach(function (p) {
      if (onlyId && p.id !== onlyId) return;
      query(p).then(function (state) { last[p.id] = state; paintRow(p); });
    });
  }

  function pageHtml() {
    setTimeout(function () { refresh(); }, 0);
    var rows = PERMS.map(function (p) {
      return '<div class="siteperm-row" data-sp-row="' + esc(p.id) + '">' + rowInner(p, last[p.id]) + "</div>";
    }).join("");
    return '<div class="set-block siteperm-page">' +
      '<p class="phandle">' + esc(tr("What this browser lets the app use. Changes here show up right away.")) + "</p>" +
      '<div class="siteperm-list">' + rows + "</div>" +
      '<p class="set-sub">' + esc(tr("Allow only asks the browser. You can say no, and you can change it later in the browser's site settings.")) + "</p>" +
      "</div>";
  }

  document.addEventListener("click", function (event) {
    var t = event.target && event.target.closest ? event.target.closest("[data-sp-ask],[data-sp-again]") : null;
    if (!t) return;
    event.preventDefault();
    var id = t.getAttribute("data-sp-ask") || t.getAttribute("data-sp-again");
    var p = PERMS.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    if (t.hasAttribute("data-sp-again")) { refresh(id); return; }
    t.disabled = true;
    Promise.resolve(p.ask()).then(function () { refresh(id); }, function () { refresh(id); });
  });

  window.ViktorychSitePerms = { pageHtml: pageHtml, refresh: refresh, list: PERMS };
})();
