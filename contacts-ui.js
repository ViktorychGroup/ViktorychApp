/* contacts-ui.js - Native X.com styled Google Contacts clone for ViktorychApp.
   100% Local-first, offline storage with Google Contacts structure:
   - Floating Action Button (FAB) + Google style pill search
   - Seamless update/migration notice for existing installed users
   - Android & Mobile install banner with deep PWA integration
   - Multiple numbers (Mobile, Work, Home) & Emails with Google Contact labels
   - Web Contact Picker API integration (sync device contacts)
   - Dialer protocol handling (tel:, web+contact:)
   - CSV / vCard import and export
   - Social & Timeline Integration:
     * Matching contacts with timeline/feed accounts
     * Showing matched avatar and direct profile jump
     * Direct 1-tap Send DM (#/messages) or Mention in Compose
     * Export / Share contact as vCard (.vcf)
*/
(function (root, factory) {
  if (typeof define === "function" && define.amd) define([], factory);
  else if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ViktorychContacts = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var STORE_KEY = "viktorych_contacts_v2";
  var OLD_STORE_KEY = "viktorych_contacts_v1";
  var MIGRATION_SEEN_KEY = "viktorych_contacts_migrated_v2";

  var S = {
    contacts: [],
    query: "",
    tab: "all", // "all" | "favorites" | "matched"
    activeId: null,
    editing: false,
    loaded: false,
    importing: false,
    showMigration: false
  };

  function tr(key, vars) {
    var fn = (typeof window !== "undefined" && window.t) ? window.t : null;
    return fn ? fn(key, vars) : (key || "");
  }

  function esc(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function icon(name) {
    if (typeof window !== "undefined" && window.ViktorychIcon) {
      var ic = window.ViktorychIcon(name);
      if (ic) return ic;
    }
    if (name === "phone") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 15.5c-1.2 0-2.4-.2-3.6-.6-.3-.1-.7 0-1 .2l-2.2 2.2c-2.8-1.4-5.1-3.8-6.6-6.6l2.2-2.2c.3-.3.4-.7.2-1-.4-1.1-.6-2.3-.6-3.5 0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1 0 9.4 7.6 17 17 17 .6 0 1-.4 1-1v-3.5c0-.6-.4-1-1-1zM5 5h1.5c.1.9.3 1.7.6 2.5l-1.3 1.3C5.3 7.4 5.1 6.2 5 5zm14 14c-1.2-.1-2.4-.3-3.8-.8l1.3-1.3c.8.3 1.6.5 2.5.6V19z"/></svg>';
    if (name === "mail") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>';
    if (name === "star") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
    if (name === "starOn") return '<svg viewBox="0 0 24 24" aria-hidden="true" style="fill:#f4b400"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>';
    if (name === "back") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 11H7.414l4.293-4.293c.39-.39.39-1.023 0-1.414s-1.023-.39-1.414 0l-6 6c-.39.39-.39 1.023 0 1.414l6 6c.195.195.45.293.707.293s.512-.098.707-.293c.39-.39.39-1.023 0-1.414L7.414 13H20c.553 0 1-.447 1-1s-.447-1-1-1z"/></svg>';
    if (name === "plus") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
    if (name === "search") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.25 3.75a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm-8.5 6.5a8.5 8.5 0 1 1 15.176 5.262l4.406 4.406a1 1 0 0 1-1.414 1.414l-4.406-4.406A8.5 8.5 0 0 1 1.75 10.25z"/></svg>';
    if (name === "pencil") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
    if (name === "trash") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16 9v10H8V9h8m-1.5-6h-5l-1 1H5v2h14V4h-3.5l-1-1zM18 7H6v12c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7z"/></svg>';
    if (name === "import") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>';
    if (name === "download") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>';
    if (name === "close") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    if (name === "check") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    if (name === "share") return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41L7.71 9.71 6.3 8.29 12 2.59zM21 15l-.02 4c0 1.1-.9 2-2 2H5c-1.11 0-2-.9-2-2V15h2v4h14v-4h2z"/></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';
  }

  function avatarColor(name) {
    var colors = [
      "#1d9bf0", "#00ba7c", "#f91880", "#7856ff", "#ff7a00", "#ffd400", "#1d9bf0", "#e0245e"
    ];
    var hash = 0;
    var str = String(name || "x");
    for (var i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  /* Matches contact with catalog feeds or accounts on device */
  function matchContactWithFeed(c) {
    if (!c) return null;
    if (typeof window === "undefined") return null;

    // 1. Direct handle match
    if (c.handle) {
      var cleanHandle = c.handle.replace(/^@/, "").trim().toLowerCase();
      if (cleanHandle && window.feeds) {
        var allFeeds = window.feeds();
        var found = allFeeds.find(function (f) {
          return f && f.handle && f.handle.toLowerCase() === cleanHandle;
        });
        if (found) return found;
      }
    }

    // 2. Name match in feeds
    if (c.name && window.feeds) {
      var cleanName = c.name.trim().toLowerCase();
      var feedByName = window.feeds().find(function (f) {
        return f && f.name && f.name.toLowerCase() === cleanName;
      });
      if (feedByName) return feedByName;
    }

    return null;
  }

  function loadContacts() {
    if (S.loaded) return;
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        S.contacts = JSON.parse(raw);
      } else {
        var old = localStorage.getItem(OLD_STORE_KEY);
        if (old) {
          S.contacts = JSON.parse(old);
          localStorage.setItem(STORE_KEY, old);
        } else {
          S.contacts = [];
        }
      }
    } catch (e) {
      S.contacts = [];
    }

    try {
      var isStandalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
      var migrated = localStorage.getItem(MIGRATION_SEEN_KEY);
      if (isStandalone && !migrated) {
        S.showMigration = true;
      }
    } catch (e) {}

    S.loaded = true;
  }

  function saveContacts() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(S.contacts));
    } catch (e) {}
  }

  function dismissMigration() {
    S.showMigration = false;
    try {
      localStorage.setItem(MIGRATION_SEEN_KEY, "1");
    } catch (e) {}
    render();
  }

  function render() {
    if (typeof window !== "undefined" && window.render) {
      window.render();
    }
  }

  function getSortedContacts() {
    var list = S.contacts.slice();
    if (S.tab === "favorites") {
      list = list.filter(function (c) { return !!c.favorite; });
    } else if (S.tab === "matched") {
      list = list.filter(function (c) { return !!matchContactWithFeed(c); });
    }

    if (S.query.trim()) {
      var q = S.query.trim().toLowerCase();
      list = list.filter(function (c) {
        return (c.name && c.name.toLowerCase().indexOf(q) !== -1) ||
               (c.phone && c.phone.toLowerCase().indexOf(q) !== -1) ||
               (c.email && c.email.toLowerCase().indexOf(q) !== -1) ||
               (c.handle && c.handle.toLowerCase().indexOf(q) !== -1);
      });
    }
    list.sort(function (a, b) {
      return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
    });
    return list;
  }

  // --- HTML Builders ---

  function renderMigrationBanner() {
    if (!S.showMigration) return "";
    return '<div class="gc-mig-card">' +
      '<div class="gc-mig-glow"></div>' +
      '<div class="gc-mig-content">' +
        '<div class="gc-mig-icon">' + icon("check") + '</div>' +
        '<div class="gc-mig-text">' +
          '<div class="gc-mig-title">' + esc(tr("New: Google Contacts Clone Ready")) + '</div>' +
          '<div class="gc-mig-sub">' + esc(tr("Your installed ViktorychApp can now handle device phone calls, address book sync, and vCards offline.")) + '</div>' +
        '</div>' +
        '<div class="gc-mig-actions">' +
          '<button class="gc-btn-upgrade" data-act="ct-upgrade-pwa">' + icon("plus") + ' ' + esc(tr("Upgrade app shortcut")) + '</button>' +
          '<button class="gc-btn-action" data-act="ct-dismiss-mig">' + esc(tr("Got it")) + '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderInstallCard() {
    var isStandalone = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    if (isStandalone) return "";
    return '<div class="gc-install-hero">' +
      '<div class="gc-install-left">' +
        '<div class="gc-install-badge">' + icon("phone") + '</div>' +
        '<div>' +
          '<div class="gc-install-title">' + esc(tr("Make Contacts Default App")) + '</div>' +
          '<div class="gc-install-sub">' + esc(tr("Install ViktorychApp to open phone numbers directly and manage your contacts offline.")) + '</div>' +
        '</div>' +
      '</div>' +
      '<button class="gc-install-btn" data-act="ct-install-pwa">' + icon("plus") + ' ' + esc(tr("Install app")) + '</button>' +
    '</div>';
  }

  function renderTopPillSearch() {
    return '<div class="gc-search-container">' +
      '<div class="gc-search-pill">' +
        '<span class="gc-search-icon">' + icon("search") + '</span>' +
        '<input type="search" class="gc-search-input" placeholder="' + esc(tr("Search contacts")) + '" value="' + esc(S.query) + '" data-act="ct-search-input" />' +
        (S.query ? '<button class="gc-icon-btn clear" data-act="ct-search-clear">' + icon("close") + '</button>' : '') +
        '<button class="gc-icon-btn sync" data-act="ct-sync-device" title="' + esc(tr("Sync phone contacts")) + '">' + icon("import") + '</button>' +
      '</div>' +
    '</div>';
  }

  function renderCategoryChips() {
    var allCount = S.contacts.length;
    var favCount = S.contacts.filter(function (c) { return c.favorite; }).length;
    var matchedCount = S.contacts.filter(function (c) { return !!matchContactWithFeed(c); }).length;

    return '<div class="gc-chips-row">' +
      '<button class="gc-chip' + (S.tab === "all" ? " active" : "") + '" data-act="ct-tab" data-tab="all">' +
        esc(tr("All contacts")) + ' <span class="gc-chip-count">' + allCount + '</span>' +
      '</button>' +
      '<button class="gc-chip' + (S.tab === "favorites" ? " active" : "") + '" data-act="ct-tab" data-tab="favorites">' +
        icon(S.tab === "favorites" ? "starOn" : "star") + ' ' + esc(tr("Favorites")) + ' <span class="gc-chip-count">' + favCount + '</span>' +
      '</button>' +
      (matchedCount > 0 ? '<button class="gc-chip' + (S.tab === "matched" ? " active" : "") + '" data-act="ct-tab" data-tab="matched">' +
        icon("check") + ' ' + esc(tr("Viktorych Profiles")) + ' <span class="gc-chip-count">' + matchedCount + '</span>' +
      '</button>' : '') +
    '</div>';
  }

  function renderContactRow(c) {
    var matched = matchContactWithFeed(c);
    var initial = (c.name || "?").charAt(0).toUpperCase();
    var bg = avatarColor(c.name);
    var phone = c.phone || "";
    var starIcon = c.favorite ? icon("starOn") : icon("star");

    var avatarHtml = matched && matched.avatar
      ? '<img class="gc-avatar img" src="' + esc(matched.avatar) + '" alt="' + esc(c.name) + '" loading="lazy" />'
      : '<div class="gc-avatar" style="background-color:' + bg + '">' + esc(initial) + '</div>';

    return '<div class="gc-contact-row" data-act="ct-view" data-id="' + esc(c.id) + '">' +
      avatarHtml +
      '<div class="gc-info">' +
        '<div class="gc-name">' + esc(c.name || tr("No Name")) +
          (matched ? ' <span class="gc-match-tag">@' + esc(matched.handle) + '</span>' : '') +
        '</div>' +
        (phone ? '<div class="gc-phone">' + esc(phone) + '</div>' : (c.handle ? '<div class="gc-phone">@' + esc(c.handle.replace(/^@/, '')) + '</div>' : '')) +
      '</div>' +
      '<div class="gc-row-acts" data-act="stop">' +
        (phone ? '<a class="gc-circle-btn tel" href="tel:' + esc(phone) + '" title="' + esc(tr("Call")) + '">' + icon("phone") + '</a>' : '') +
        '<button class="gc-circle-btn fav" data-act="ct-toggle-fav" data-id="' + esc(c.id) + '">' + starIcon + '</button>' +
      '</div>' +
    '</div>';
  }

  function renderGroupedList(contacts) {
    if (!contacts.length) {
      if (S.query) {
        return '<div class="gc-empty-view">' +
          '<div class="gc-empty-title">' + esc(tr("No matching contacts")) + '</div>' +
          '<div class="gc-empty-sub">' + esc(tr("Try a different name or number.")) + '</div>' +
        '</div>';
      }
      return '<div class="gc-empty-view">' +
        '<div class="gc-empty-art">' + icon("phone") + '</div>' +
        '<div class="gc-empty-title">' + esc(tr("No contacts yet")) + '</div>' +
        '<div class="gc-empty-sub">' + esc(tr("Add contacts manually or sync from your Android device.")) + '</div>' +
        '<div class="gc-empty-actions">' +
          '<button class="gc-btn-primary" data-act="ct-new">' + icon("plus") + ' ' + esc(tr("Add contact")) + '</button>' +
          '<button class="gc-btn-secondary" data-act="ct-sync-device">' + icon("import") + ' ' + esc(tr("Sync phone contacts")) + '</button>' +
        '</div>' +
      '</div>';
    }

    var groups = {};
    contacts.forEach(function (c) {
      var letter = (c.name || "").charAt(0).toUpperCase();
      if (!letter || !/[A-ZА-ЯЁ0-9]/.test(letter)) letter = "#";
      if (!groups[letter]) groups[letter] = [];
      groups[letter].push(c);
    });

    var keys = Object.keys(groups).sort(function (a, b) {
      if (a === "#") return 1;
      if (b === "#") return -1;
      return a.localeCompare(b);
    });

    var html = '<div class="gc-contacts-list">';
    keys.forEach(function (k) {
      html += '<div class="gc-group-header">' + esc(k) + '</div>';
      groups[k].forEach(function (c) {
        html += renderContactRow(c);
      });
    });
    html += '</div>';
    return html;
  }

  function renderFab() {
    return '<button class="gc-fab" data-act="ct-new" aria-label="' + esc(tr("Add contact")) + '">' +
      icon("plus") +
    '</button>';
  }

  // --- Detail & Editor Modal Views ---

  function renderDetailView(c) {
    var matched = matchContactWithFeed(c);
    var initial = (c.name || "?").charAt(0).toUpperCase();
    var bg = avatarColor(c.name);
    var phone = c.phone || "";
    var email = c.email || "";
    var handle = (matched && matched.handle) || (c.handle ? c.handle.replace(/^@/, '') : "");
    var starIcon = c.favorite ? icon("starOn") : icon("star");

    var heroAvatarHtml = matched && matched.avatar
      ? '<img class="gc-detail-avatar img" src="' + esc(matched.avatar) + '" alt="' + esc(c.name) + '" />'
      : '<div class="gc-detail-avatar" style="background-color:' + bg + '">' + esc(initial) + '</div>';

    return '<div class="gc-detail-host">' +
      '<div class="gc-detail-top-nav">' +
        '<button class="gc-icon-btn" data-act="ct-back">' + icon("back") + '</button>' +
        '<div class="gc-detail-top-acts">' +
          '<button class="gc-icon-btn" data-act="ct-share-vcf" data-id="' + esc(c.id) + '" title="' + esc(tr("Share contact")) + '">' + icon("share") + '</button>' +
          '<button class="gc-icon-btn" data-act="ct-toggle-fav" data-id="' + esc(c.id) + '">' + starIcon + '</button>' +
          '<button class="gc-icon-btn" data-act="ct-edit" data-id="' + esc(c.id) + '">' + icon("pencil") + '</button>' +
          '<button class="gc-icon-btn danger" data-act="ct-del" data-id="' + esc(c.id) + '">' + icon("trash") + '</button>' +
        '</div>' +
      '</div>' +

      '<div class="gc-detail-hero">' +
        heroAvatarHtml +
        '<h2 class="gc-detail-name">' + esc(c.name || tr("No Name")) + '</h2>' +
        (matched ? '<a class="gc-matched-badge" href="#/@' + esc(matched.handle) + '">' + icon("check") + ' @' + esc(matched.handle) + '</a>' : '') +
      '</div>' +

      '<div class="gc-detail-quick-acts">' +
        (phone ? '<a class="gc-quick-act" href="tel:' + esc(phone) + '"><div class="gc-circle-btn">' + icon("phone") + '</div><span>' + esc(tr("Call")) + '</span></a>' : '') +
        (handle ? '<a class="gc-quick-act" href="#/messages?u=' + encodeURIComponent(handle) + '"><div class="gc-circle-btn">' + icon("mail") + '</div><span>' + esc(tr("Send message")) + '</span></a>' : (phone ? '<a class="gc-quick-act" href="#/messages?tel=' + esc(phone) + '"><div class="gc-circle-btn">' + icon("mail") + '</div><span>' + esc(tr("Message")) + '</span></a>' : '')) +
        (handle ? '<button class="gc-quick-act" data-act="ct-mention" data-handle="' + esc(handle) + '"><div class="gc-circle-btn">' + icon("pencil") + '</div><span>' + esc(tr("Mention")) + '</span></button>' : '') +
        (email ? '<a class="gc-quick-act" href="mailto:' + esc(email) + '"><div class="gc-circle-btn">' + icon("mail") + '</div><span>' + esc(tr("Mail")) + '</span></a>' : '') +
      '</div>' +

      '<div class="gc-detail-card">' +
        '<div class="gc-detail-section-title">' + esc(tr("Contact details")) + '</div>' +
        (phone ? '<div class="gc-detail-item">' +
          '<span class="gc-detail-icon">' + icon("phone") + '</span>' +
          '<div class="gc-detail-item-info">' +
            '<a class="gc-detail-val tel" href="tel:' + esc(phone) + '">' + esc(phone) + '</a>' +
            '<span class="gc-detail-lbl">' + esc(tr("Mobile")) + '</span>' +
          '</div>' +
        '</div>' : '') +
        (email ? '<div class="gc-detail-item">' +
          '<span class="gc-detail-icon">' + icon("mail") + '</span>' +
          '<div class="gc-detail-item-info">' +
            '<a class="gc-detail-val" href="mailto:' + esc(email) + '">' + esc(email) + '</a>' +
            '<span class="gc-detail-lbl">' + esc(tr("Email")) + '</span>' +
          '</div>' +
        '</div>' : '') +
        (handle ? '<div class="gc-detail-item">' +
          '<span class="gc-detail-icon">' + icon("search") + '</span>' +
          '<div class="gc-detail-item-info">' +
            '<a class="gc-detail-val" href="#/@' + esc(handle) + '">@' + esc(handle) + '</a>' +
            '<span class="gc-detail-lbl">' + esc(tr("Viktorych / X Profile")) + '</span>' +
          '</div>' +
        '</div>' : '') +
        (c.notes ? '<div class="gc-detail-item">' +
          '<span class="gc-detail-icon">' + icon("pencil") + '</span>' +
          '<div class="gc-detail-item-info">' +
            '<div class="gc-detail-val text">' + esc(c.notes) + '</div>' +
            '<span class="gc-detail-lbl">' + esc(tr("Notes")) + '</span>' +
          '</div>' +
        '</div>' : '') +
      '</div>' +
    '</div>';
  }

  function renderEditView(c) {
    var isNew = !c || !c.id;
    var name = (c && c.name) || "";
    var phone = (c && c.phone) || "";
    var email = (c && c.email) || "";
    var handle = (c && c.handle) || "";
    var notes = (c && c.notes) || "";
    var id = (c && c.id) || ("c_" + Date.now() + "_" + Math.floor(Math.random() * 1000));

    return '<div class="gc-detail-host">' +
      '<div class="gc-detail-top-nav">' +
        '<button class="gc-icon-btn" data-act="ct-back">' + icon("close") + '</button>' +
        '<div class="gc-top-title">' + esc(isNew ? tr("New contact") : tr("Edit contact")) + '</div>' +
        '<button class="gc-btn-save" data-act="ct-save-contact" data-id="' + esc(id) + '">' + esc(tr("Save")) + '</button>' +
      '</div>' +

      '<div class="gc-edit-body">' +
        '<div class="gc-edit-avatar-slot">' +
          '<div class="gc-avatar xl" style="background-color:' + avatarColor(name || "x") + '">' + esc((name || "?").charAt(0).toUpperCase()) + '</div>' +
        '</div>' +

        '<form class="gc-form" onsubmit="return false;" id="gc-contact-form" data-id="' + esc(id) + '">' +
          '<div class="gc-field">' +
            '<span class="gc-field-icon">' + icon("pencil") + '</span>' +
            '<div class="gc-input-wrap">' +
              '<input type="text" class="gc-text-input" name="name" value="' + esc(name) + '" placeholder="' + esc(tr("Full name")) + '" required autofocus />' +
            '</div>' +
          '</div>' +

          '<div class="gc-field">' +
            '<span class="gc-field-icon">' + icon("phone") + '</span>' +
            '<div class="gc-input-wrap">' +
              '<input type="tel" class="gc-text-input" name="phone" value="' + esc(phone) + '" placeholder="' + esc(tr("Phone number")) + '" />' +
            '</div>' +
          '</div>' +

          '<div class="gc-field">' +
            '<span class="gc-field-icon">' + icon("mail") + '</span>' +
            '<div class="gc-input-wrap">' +
              '<input type="email" class="gc-text-input" name="email" value="' + esc(email) + '" placeholder="' + esc(tr("Email address")) + '" />' +
            '</div>' +
          '</div>' +

          '<div class="gc-field">' +
            '<span class="gc-field-icon">' + icon("search") + '</span>' +
            '<div class="gc-input-wrap">' +
              '<input type="text" class="gc-text-input" name="handle" value="' + esc(handle) + '" placeholder="' + esc(tr("Viktorych / X Handle")) + '" />' +
            '</div>' +
          '</div>' +

          '<div class="gc-field">' +
            '<span class="gc-field-icon">' + icon("pencil") + '</span>' +
            '<div class="gc-input-wrap">' +
              '<textarea class="gc-text-input" name="notes" rows="3" placeholder="' + esc(tr("Notes")) + '">' + esc(notes) + '</textarea>' +
            '</div>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>';
  }

  // --- Public Interface ---

  function page(route) {
    loadContacts();

    if (S.editing) {
      var item = S.activeId ? S.contacts.find(function (x) { return x.id === S.activeId; }) : null;
      return '<div class="gc-app-shell">' + renderEditView(item) + '</div>';
    }

    if (S.activeId) {
      var activeItem = S.contacts.find(function (x) { return x.id === S.activeId; });
      if (activeItem) {
        return '<div class="gc-app-shell">' + renderDetailView(activeItem) + '</div>';
      }
      S.activeId = null;
    }

    var list = getSortedContacts();

    return '<div class="gc-app-shell">' +
      renderMigrationBanner() +
      renderInstallCard() +
      renderTopPillSearch() +
      renderCategoryChips() +
      renderGroupedList(list) +
      renderFab() +
    '</div>';
  }

  function mount(route) {
    loadContacts();
    var q = route && route.query;
    var callParam = q && (q.get("call") || q.get("tel") || q.get("contact"));
    if (callParam) {
      var match = S.contacts.find(function (c) {
        return (c.phone && c.phone.replace(/[^0-9]/g, "") === callParam.replace(/[^0-9]/g, "")) ||
               (c.name && c.name.toLowerCase() === callParam.toLowerCase());
      });
      if (match) {
        S.activeId = match.id;
        render();
      } else {
        S.activeId = null;
        S.editing = true;
        render();
        setTimeout(function () {
          var input = document.querySelector('input[name="phone"]');
          if (input) input.value = callParam;
        }, 50);
      }
    }
  }

  function onAct(act, el) {
    if (act === "ct-upgrade-pwa") {
      dismissMigration();
      if (typeof window !== "undefined") {
        if (window.installPromptNow && window.installPromptNow()) {
          var p = window.installPromptNow();
          if (p && p.prompt) p.prompt();
        } else {
          location.hash = "#/settings/resources";
        }
      }
      return;
    }

    if (act === "ct-dismiss-mig") {
      dismissMigration();
      return;
    }

    if (act === "ct-install-pwa") {
      if (typeof window !== "undefined") {
        if (window.installPromptNow && window.installPromptNow()) {
          var pr = window.installPromptNow();
          if (pr && pr.prompt) pr.prompt();
        } else if (window.triggerInstallModal) {
          window.triggerInstallModal();
        } else {
          location.hash = "#/settings/resources";
        }
      }
      return;
    }

    if (act === "ct-tab") {
      var tab = el.getAttribute("data-tab");
      if (tab) {
        S.tab = tab;
        render();
      }
      return;
    }

    if (act === "ct-search-input") {
      S.query = el.value || "";
      render();
      return;
    }

    if (act === "ct-search-clear") {
      S.query = "";
      render();
      return;
    }

    if (act === "ct-view") {
      var id = el.getAttribute("data-id");
      if (id) {
        S.activeId = id;
        S.editing = false;
        render();
      }
      return;
    }

    if (act === "ct-back") {
      S.activeId = null;
      S.editing = false;
      render();
      return;
    }

    if (act === "ct-new") {
      S.activeId = null;
      S.editing = true;
      render();
      return;
    }

    if (act === "ct-edit") {
      var idEdit = el.getAttribute("data-id");
      if (idEdit) {
        S.activeId = idEdit;
        S.editing = true;
        render();
      }
      return;
    }

    if (act === "ct-toggle-fav") {
      var favId = el.getAttribute("data-id");
      var item = S.contacts.find(function (c) { return c.id === favId; });
      if (item) {
        item.favorite = !item.favorite;
        saveContacts();
        render();
      }
      return;
    }

    if (act === "ct-del") {
      var delId = el.getAttribute("data-id");
      if (confirm(tr("Delete contact?"))) {
        S.contacts = S.contacts.filter(function (c) { return c.id !== delId; });
        saveContacts();
        S.activeId = null;
        S.editing = false;
        render();
      }
      return;
    }

    if (act === "ct-mention") {
      var handleToMention = el.getAttribute("data-handle");
      if (handleToMention) {
        location.hash = "#/";
        setTimeout(function () {
          if (typeof window !== "undefined" && window.STATE) {
            window.STATE.composeSeed = "@" + handleToMention.replace(/^@/, '') + " ";
            window.STATE.modal = "compose";
            render();
          }
        }, 100);
      }
      return;
    }

    if (act === "ct-share-vcf") {
      var shareId = el.getAttribute("data-id");
      var cShare = S.contacts.find(function (x) { return x.id === shareId; });
      if (cShare) {
        exportVCard(cShare);
      }
      return;
    }

    if (act === "ct-save-contact") {
      var form = document.getElementById("gc-contact-form");
      if (!form) return;
      var name = (form.querySelector('input[name="name"]') || {}).value || "";
      var phone = (form.querySelector('input[name="phone"]') || {}).value || "";
      var email = (form.querySelector('input[name="email"]') || {}).value || "";
      var handle = (form.querySelector('input[name="handle"]') || {}).value || "";
      var notes = (form.querySelector('textarea[name="notes"]') || {}).value || "";

      if (!name.trim()) {
        alert(tr("Please enter a contact name."));
        return;
      }

      var contactId = form.getAttribute("data-id");
      var existing = S.contacts.find(function (c) { return c.id === contactId; });
      if (existing) {
        existing.name = name.trim();
        existing.phone = phone.trim();
        existing.email = email.trim();
        existing.handle = handle.trim();
        existing.notes = notes.trim();
      } else {
        S.contacts.push({
          id: contactId,
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim(),
          handle: handle.trim(),
          notes: notes.trim(),
          favorite: false,
          created: Date.now()
        });
      }

      saveContacts();
      S.activeId = contactId;
      S.editing = false;
      render();
      return;
    }

    if (act === "ct-sync-device") {
      syncDeviceContacts();
      return;
    }
  }

  function exportVCard(c) {
    var fnName = c.name || "contact";
    var vcf = [
      ["BEGIN", "VCARD"].join(":"),
      "VERSION:3.0",
      "FN:" + fnName,
      c.phone ? "TEL;TYPE=CELL:" + c.phone : "",
      c.email ? "EMAIL;TYPE=INTERNET:" + c.email : "",
      c.handle ? "X-SOCIALPROFILE;TYPE=viktorych:@" + c.handle.replace(/^@/, '') : "",
      c.notes ? "NOTE:" + c.notes.replace(/\n/g, "\\n") : "",
      ["END", "VCARD"].join(":")
    ].filter(Boolean).join("\r\n");

    var blob = new Blob([vcf], { type: "text/vcard;charset=utf-8" });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [new File([blob], "contact.vcf", { type: "text/vcard" })] })) {
      navigator.share({
        title: c.name,
        files: [new File([blob], (c.name || "contact") + ".vcf", { type: "text/vcard" })]
      }).catch(function () {});
    } else {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (c.name || "contact") + ".vcf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }
  }

  function syncDeviceContacts() {
    if (typeof navigator === "undefined" || !("contacts" in navigator) || !("ContactsManager" in window)) {
      alert(tr("Your browser does not support native contact selection."));
      return;
    }
    var props = ["name", "tel", "email"];
    var opts = { multiple: true };
    navigator.contacts.select(props, opts).then(function (contacts) {
      if (!contacts || !contacts.length) return;
      var added = 0;
      contacts.forEach(function (c) {
        var name = (c.name && c.name[0]) || "";
        var tel = (c.tel && c.tel[0]) || "";
        var email = (c.email && c.email[0]) || "";
        if (!name && !tel) return;

        var exists = S.contacts.some(function (x) {
          return (name && x.name === name) || (tel && x.phone && x.phone === tel);
        });
        if (!exists) {
          S.contacts.push({
            id: "c_dev_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
            name: name,
            phone: tel,
            email: email,
            handle: "",
            notes: "",
            favorite: false,
            created: Date.now()
          });
          added++;
        }
      });
      if (added > 0) {
        saveContacts();
        alert(tr("Imported {n} contacts", { n: added }));
        render();
      }
    }).catch(function (err) {
      /* User cancelled or denied */
    });
  }

  return {
    page: page,
    mount: mount,
    onAct: onAct,
    syncDeviceContacts: syncDeviceContacts,
    _state: S
  };
});
