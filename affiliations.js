/* Affiliation badges next to a display name.
   The page only shows a grant the Worker already made. */
(function (root) {
  "use strict";

  var cache = {};
  var pending = {};
  var STORE = "viktorych-aff-cache-v1";
  var FRESH = 10 * 60 * 1000;
  var stamp = {};

  /* The last answer per account lives on the device, so a name row paints
     its badge at once and the Worker is asked again only every few minutes. */
  (function restore() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE) || "{}");
      Object.keys(saved).forEach(function (id) {
        if (saved[id] && Array.isArray(saved[id].l)) { cache[id] = saved[id].l; stamp[id] = saved[id].t || 0; }
      });
    } catch (err) { /* private mode */ }
  })();

  function persist() {
    try {
      var out = {};
      Object.keys(cache).slice(-400).forEach(function (id) { out[id] = { l: cache[id], t: stamp[id] || 0 }; });
      localStorage.setItem(STORE, JSON.stringify(out));
    } catch (err) { /* full or private */ }
  }

  function tr(key, vars) {
    var fn = root.t || (root.SI18n && root.SI18n.t);
    return fn ? fn(key, vars) : key;
  }

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;";
    });
  }

  function accounts() {
    return root.ViktorychAccounts || null;
  }

  function visible(list) {
    return (list || []).filter(function (item) { return !item.hidden; });
  }

  /* A span, never a button: the slot often sits inside a name link. */
  function slot(publicId) {
    if (!/^\d{12}$/.test(String(publicId || ""))) return "";
    var list = visible(cache[publicId]);
    if (list.length) return '<span class="aff-slot" data-aff-for="' + publicId + '">' + list.map(badgeButton).join("") + "</span>";
    return '<span class="aff-slot" data-aff-for="' + publicId + '" hidden></span>';
  }

  function badgeButton(item) {
    var label = tr("Affiliated with {name}", { name: item.name });
    var logo = root.ruSafeImageUrl ? root.ruSafeImageUrl(item.logo) : item.logo;
    return '<span class="aff-badge" role="link" tabindex="0" title="' + esc(label) + '" data-aff-open="' + esc(item.id) + '" data-aff-name="' + esc(item.name) + '" data-aff-logo="' + esc(logo) + '" data-aff-href="' + esc(item.href || "") + '" aria-label="' + esc(label) + '"><img src="' + esc(logo) + '" alt="" decoding="async" onerror="this.style.display=\'none\'"></span>';
  }

  function paint() {
    var ids = [];
    document.querySelectorAll("[data-aff-for], [data-aff-about]").forEach(function (el) {
      var id = el.getAttribute("data-aff-for") || el.getAttribute("data-aff-about") || "";
      if (/^\d{12}$/.test(id) && ids.indexOf(id) < 0) ids.push(id);
    });
    if (!ids.length) return;
    var now = Date.now();
    var missing = ids.filter(function (id) { return !pending[id] && (!cache[id] || now - (stamp[id] || 0) > FRESH); });
    for (var i = 0; i < missing.length; i += 40) load(missing.slice(i, i + 40));
    ids.forEach(fill);
  }

  function load(ids) {
    var api = accounts();
    if (!api || !api.call) return;
    var token = api.token ? api.token() : "";
    ids.forEach(function (id) { pending[id] = true; });
    api.call("/v1/affiliations?ids=" + ids.join(","), token ? { token: token } : {}).then(function (body) {
      ids.forEach(function (id) { delete pending[id]; });
      if (!body || body.status !== 200) return;
      var accountsMap = body.accounts || {};
      var now = Date.now();
      ids.forEach(function (id) { cache[id] = accountsMap[id] || []; stamp[id] = now; });
      persist();
      ids.forEach(fill);
    }).catch(function () {
      ids.forEach(function (id) { delete pending[id]; });
    });
  }

  function fill(id) {
    var list = cache[id];
    if (!list) return;
    var shown = visible(list);
    var html = shown.map(badgeButton).join("");
    document.querySelectorAll('[data-aff-for="' + id + '"]').forEach(function (el) {
      if (!shown.length) {
        if (!el.hidden) el.hidden = true;
        if (el.innerHTML) el.innerHTML = "";
        return;
      }
      if (el.hidden) el.hidden = false;
      if (el.innerHTML !== html) el.innerHTML = html;
    });
    document.querySelectorAll('[data-aff-about="' + id + '"]').forEach(function (el) {
      el.hidden = !list.length;
      var about = list.length ? aboutBlock(list, id) : "";
      if (el.innerHTML !== about) el.innerHTML = about;
    });
  }

  var lastAbout = {};

  function aboutBlock(list, id) {
    var api = accounts();
    var session = api && api.account && api.account();
    var mine = !!(session && session.publicId === id);
    list.forEach(function (item) { lastAbout[item.id] = { item: item, mine: mine }; });
    return '<div class="about-head"><h2>' + esc(tr("Organization")) + '</h2></div><div class="bdg-list">' + list.map(function (item) {
      var line = mine && item.hidden ? tr("Hidden from your name") : tr("Affiliated organization");
      return '<button type="button" class="bdg-row" data-aff-open="' + esc(item.id) + '" data-aff-name="' + esc(item.name) + '" data-aff-logo="' + esc(item.logo) + '" data-aff-href="' + esc(item.href || "") + '" data-aff-row="1"><span class="bdg-ico org"><img src="' + esc(item.logo) + '" alt=""></span><span class="bdg-copy"><span class="bdg-name">' + esc(item.name) + '</span><span class="bdg-line">' + esc(line) + '</span></span><span class="bdg-chev" aria-hidden="true">\u203A</span></button>';
    }).join("") + "</div>";
  }

  function adminHtml() {
    return '<h2>' + esc(tr("Affiliations")) + '</h2><p class="set-sub">' + esc(tr("Only an admin can grant or revoke an affiliation.")) + '</p><form data-aff-admin="1"><input type="text" data-aff-handle maxlength="15" placeholder="' + esc(tr("Account")) + '" aria-label="' + esc(tr("Account")) + '"><button type="submit" data-aff-do="grant">' + esc(tr("Grant affiliation")) + '</button><button type="button" data-aff-do="revoke">' + esc(tr("Revoke affiliation")) + "</button></form>";
  }

  function openSheet(button) {
    var id = button.getAttribute("data-aff-open") || "";
    var name = button.getAttribute("data-aff-name") || "";
    var logo = button.getAttribute("data-aff-logo") || "";
    var href = button.getAttribute("data-aff-href") || "";
    var known = lastAbout[id];
    var extra = "";
    if (known && known.mine) {
      var item = known.item;
      var modes = ["public", "followers", "mutuals", "only"];
      extra = '<button type="button" class="bdg-btn ghost" data-aff-hide="' + esc(id) + '" data-hidden="' + (item.hidden ? "1" : "0") + '">' + esc(item.hidden ? tr("Show next to my name") : tr("Hide from my name")) + "</button>" +
        '<label class="bdg-field"><span>' + esc(tr("Who can see it")) + '</span><select data-aff-audience="' + esc(id) + '">' + modes.map(function (mode) {
          var label = mode === "followers" ? tr("Followers") : mode === "mutuals" ? tr("Mutuals") : mode === "only" ? tr("Only me") : tr("Everyone");
          return '<option value="' + mode + '"' + ((item.audience || "public") === mode ? " selected" : "") + ">" + esc(label) + "</option>";
        }).join("") + "</select></label>";
    }
    var icon = '<span class="bdg-ico org"><img src="' + esc(logo) + '" alt=""></span>';
    if (root.BadgeSheet) {
      root.BadgeSheet.open({ iconHtml: icon, title: name, line: tr("Affiliated with {name}", { name: name }), detail: tr("The square next to a name shows the organization this account belongs to."), extraHtml: extra, href: href, linkText: tr("View profile") });
      return;
    }
    if (href) location.hash = href.slice(1);
  }

  function openBadge(el) {
    openSheet(el);
  }

  function patch(id, body) {
    var api = accounts();
    if (!api || !api.call || !api.token || !api.token()) return;
    api.call("/v1/affiliations/me/" + encodeURIComponent(id), { method: "PATCH", token: api.token(), body: body }).then(function () {
      var me = api.account && api.account() ? api.account().publicId : "";
      var open = document.querySelector(".bdg-sheet");
      if (open) open.remove();
      if (me) { stamp[me] = 0; paint(); }
      if (api.requestRender) api.requestRender();
    }).catch(function () {});
  }

  var queued = false;
  function soon() {
    if (queued) return;
    queued = true;
    (root.requestAnimationFrame || setTimeout)(function () { queued = false; paint(); });
  }

  function boot() {
    /* Every name row anywhere (posts, profile, drawer, cards) paints itself. */
    if (root.MutationObserver) {
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var node = added[j];
            if (node.nodeType === 1 && (node.hasAttribute("data-aff-for") || node.hasAttribute("data-aff-about") || node.querySelector("[data-aff-for], [data-aff-about]"))) { soon(); return; }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener("change", function (event) {
      var el = event.target;
      if (!el || !el.getAttribute || !el.getAttribute("data-aff-audience")) return;
      patch(el.getAttribute("data-aff-audience"), { audience: el.value || "public" });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      var open = event.target && event.target.closest && event.target.closest("[data-aff-open]");
      if (!open) return;
      event.preventDefault();
      openBadge(open);
    });
    soon();
    document.addEventListener("click", function (event) {
      var open = event.target && event.target.closest && event.target.closest("[data-aff-open]");
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        openBadge(open);
        return;
      }
      var hide = event.target && event.target.closest && event.target.closest("[data-aff-hide]");
      if (hide) {
        event.preventDefault();
        patch(hide.getAttribute("data-aff-hide"), { hidden: hide.getAttribute("data-hidden") !== "1" });
        return;
      }
      var act = event.target && event.target.closest && event.target.closest("[data-aff-do]");
      if (!act) return;
      event.preventDefault();
      var form = act.closest("form");
      var field = form && form.querySelector("[data-aff-handle]");
      var handle = field ? String(field.value || "").trim() : "";
      var api = accounts();
      if (!handle || !api || !api.call || !api.token || !api.token()) return;
      api.call("/v1/affiliations/grant", {
        method: "POST",
        token: api.token(),
        body: { affiliationId: "viktorych", handle: handle, grant: act.getAttribute("data-aff-do") !== "revoke" }
      }).catch(function () {});
    });
  }

  root.ViktorychAffiliations = {
    slot: slot,
    paint: paint,
    adminHtml: adminHtml,
    aboutHtml: function (account) {
      var id = account && account.publicId;
      if (!/^\d{12}$/.test(String(id || ""))) return "";
      var list = cache[id];
      if (list && list.length) return '<section class="about-section aff-about" data-aff-about="' + id + '">' + aboutBlock(list, id) + "</section>";
      return '<section class="about-section aff-about" data-aff-about="' + id + '" hidden></section>';
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})(window);
