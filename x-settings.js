/* X-style settings building blocks shared by settings subpages (Usernames,
   Display names, Privacy > Games, mention rules): list rows, check and radio
   rows, X floating-label fields, accent pills, people chips with suggestions,
   a bottom sheet (centered dialog on wide screens), a "Saved" toast and an
   undo snackbar. Pages build HTML with these helpers and keep their own
   state; nothing here talks to the server. Follows the theme (--bg, --text,
   --muted, --line, --sheet) and the accent colour (--blue). */
(function (root) {
  "use strict";

  function tr(key, vars) {
    var fn = root.t || (typeof window !== "undefined" && window.t);
    return fn ? fn(key, vars) : key;
  }
  function esc(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  var ICONS = {
    chev: '<path d="M14.586 12 7.543 4.96l1.414-1.42L17.414 12l-8.457 8.46-1.414-1.42z"/>',
    more: '<path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/>',
    plus: '<path d="M11 11V4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/>',
    check: '<path d="M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z"/>',
    close: '<path d="M10.59 12 4.54 5.96l1.42-1.42L12 10.59l6.04-6.05 1.42 1.42L13.41 12l6.05 6.04-1.42 1.42L12 13.41l-6.04 6.05-1.42-1.42L10.59 12z"/>',
    drag: '<path d="M3 7h18v2H3V7zm0 4h18v2H3v-2zm0 4h18v2H3v-2z"/>',
    search: '<path d="M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.824 5.262l4.781 4.781-1.414 1.414-4.781-4.781c-1.447 1.142-3.276 1.824-5.262 1.824-4.694 0-8.5-3.806-8.5-8.5z"/>',
    eye: '<path d="M12 21c-7.605 0-10.804-8.296-10.937-8.648L.932 12l.131-.352C1.196 11.295 4.394 3 12 3s10.804 8.296 10.937 8.648l.131.352-.131.352C22.804 12.705 19.606 21 12 21zm-8.915-9c.658 1.467 3.5 7 8.915 7s8.257-5.533 8.915-7c-.658-1.467-3.5-7-8.915-7S3.743 10.533 3.085 12zM12 16c-2.206 0-4-1.794-4-4s1.794-4 4-4 4 1.794 4 4-1.794 4-4 4zm0-6c-1.103 0-2 .897-2 2s.897 2 2 2 2-.897 2-2-.897-2-2-2z"/>',
    copy: '<path d="M19.5 2C20.88 2 22 3.12 22 4.5v11c0 1.21-.86 2.22-2 2.45V4.5c0-.28-.22-.5-.5-.5H6.05c.23-1.14 1.24-2 2.45-2h11zm-4 4C16.88 6 18 7.12 18 8.5v11c0 1.38-1.12 2.5-2.5 2.5h-11C3.12 22 2 20.88 2 19.5v-11C2 7.12 3.12 6 4.5 6h11zM4 19.5c0 .28.22.5.5.5h11c.28 0 .5-.22.5-.5v-11c0-.28-.22-.5-.5-.5h-11c-.28 0-.5.22-.5.5v11z"/>',
    star: '<path d="M12 2.5l2.94 6.16 6.56.79-4.82 4.6 1.23 6.7L12 17.5l-5.91 3.25 1.23-6.7-4.82-4.6 6.56-.79L12 2.5z"/>',
    trash: '<path d="M16 6V4.5C16 3.12 14.88 2 13.5 2h-3C9.11 2 8 3.12 8 4.5V6H3v2h1.06l.81 11.21C4.98 20.78 6.28 22 7.86 22h8.27c1.58 0 2.88-1.22 3-2.79L19.93 8H21V6h-5zm-6-1.5c0-.28.22-.5.5-.5h3c.27 0 .5.22.5.5V6h-4V4.5zm7.13 14.57c-.04.52-.47.93-1 .93H7.86c-.53 0-.96-.41-1-.93L6.07 8h11.85l-.79 11.07z"/>',
    people: '<path d="M7.501 19.917L7.471 21H.472l.029-1.027c.184-6.618 3.736-8.977 7-8.977.963 0 1.95.212 2.87.672-.444.478-.851 1.03-1.212 1.656-.507-.204-1.054-.329-1.658-.329-2.767 0-4.57 2.223-4.938 6.004H7.56c-.023.302-.05.599-.059.917zm15.998.056L23.528 21H9.472l.029-1.027c.184-6.618 3.736-8.977 7-8.977s6.816 2.358 7 8.977zM21.437 19c-.367-3.781-2.17-6.004-4.938-6.004s-4.57 2.223-4.938 6.004h9.875zm-4.938-9c-.799 0-1.527-.279-2.116-.73-.836-.64-1.384-1.638-1.384-2.77 0-1.93 1.567-3.5 3.5-3.5s3.5 1.57 3.5 3.5c0 1.132-.548 2.13-1.384 2.77-.589.451-1.317.73-2.116.73zm-1.5-3.5c0 .827.673 1.5 1.5 1.5s1.5-.673 1.5-1.5-.673-1.5-1.5-1.5-1.5.673-1.5 1.5zM7.5 3C9.433 3 11 4.57 11 6.5S9.433 10 7.5 10 4 8.43 4 6.5 5.567 3 7.5 3zm0 2C6.673 5 6 5.673 6 6.5S6.673 8 7.5 8 9 7.327 9 6.5 8.327 5 7.5 5z"/>'
  };
  function icon(name, cls) {
    return '<svg class="xs-ico' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (ICONS[name] || "") + "</svg>";
  }

  /* One settings row: primary label, grey description, value or chevron on
     the right. opts.tag picks button (default), a or div. */
  function row(opts) {
    var o = opts || {};
    var tag = o.tag || "button";
    var attrs = (tag === "button" ? ' type="button"' : "") + (o.attrs ? " " + o.attrs : "");
    var trail = o.trail === "none" ? "" : o.trail != null ? o.trail : '<span class="xs-chev">' + icon("chev") + "</span>";
    return "<" + tag + ' class="xs-row' + (o.danger ? " is-danger" : "") + (o.accent ? " is-accent" : "") + (o.cls ? " " + o.cls : "") + '"' + attrs + ">" +
      (o.lead ? '<span class="xs-lead">' + o.lead + "</span>" : "") +
      '<span class="xs-copy"><span class="xs-title">' + (o.titleHtml || esc(o.title)) + (o.badge ? ' <span class="xs-badge">' + esc(o.badge) + "</span>" : "") + "</span>" +
      (o.sub || o.subHtml ? '<span class="xs-sub">' + (o.subHtml || esc(o.sub)) + "</span>" : "") + "</span>" +
      (o.value != null && o.value !== "" ? '<span class="xs-value">' + esc(o.value) + "</span>" : "") + trail + "</" + tag + ">";
  }
  /* A checkbox row. The real input stays in the row (hidden visually) so
     existing change handlers keep working. */
  function check(opts) {
    var o = opts || {};
    return '<label class="xs-row xs-checkrow' + (o.cls ? " " + o.cls : "") + '"><span class="xs-copy"><span class="xs-title">' + esc(o.title) + "</span>" +
      (o.sub ? '<span class="xs-sub">' + esc(o.sub) + "</span>" : "") + "</span>" +
      '<input type="checkbox" class="xs-checkbox"' + (o.attrs ? " " + o.attrs : "") + (o.on ? " checked" : "") + '><span class="xs-box" aria-hidden="true">' + icon("check") + "</span></label>";
  }
  function radio(opts) {
    var o = opts || {};
    return '<button type="button" role="radio" aria-checked="' + (o.on ? "true" : "false") + '" class="xs-row xs-radiorow' + (o.on ? " on" : "") + '"' + (o.attrs ? " " + o.attrs : "") + '><span class="xs-copy"><span class="xs-title">' + esc(o.title) + "</span>" +
      (o.sub ? '<span class="xs-sub">' + esc(o.sub) + "</span>" : "") + '</span><span class="xs-radio" aria-hidden="true"></span></button>';
  }
  function section(title, desc, attrs) {
    return '<h2 class="xs-h2"' + (attrs ? " " + attrs : "") + ">" + esc(title) + "</h2>" + (desc ? desc_(desc) : "");
  }
  function desc_(text, cls) { return '<p class="xs-desc' + (cls ? " " + cls : "") + '">' + esc(text) + "</p>"; }
  function pill(label, attrs, kind) {
    return '<button type="button" class="xs-pill' + (kind ? " xs-pill-" + kind : "") + '"' + (attrs ? " " + attrs : "") + ">" + esc(label) + "</button>";
  }
  /* X floating-label text field. */
  function field(opts) {
    var o = opts || {};
    var id = o.id || ("xs-f-" + Math.random().toString(36).slice(2, 8));
    var val = o.value == null ? "" : String(o.value);
    return '<div class="xs-field' + (val ? " has-value" : "") + (o.error ? " has-error" : "") + '"><input id="' + esc(id) + '" class="xs-input" type="' + esc(o.type || "text") + '" placeholder=" " value="' + esc(val) + '"' +
      (o.maxlength ? ' maxlength="' + Number(o.maxlength) + '"' : "") + (o.attrs ? " " + o.attrs : "") + ' autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<label for="' + esc(id) + '" class="xs-flabel">' + esc(o.label) + "</label>" +
      (o.maxlength && o.counter ? '<span class="xs-count">' + Array.from(val).length + " / " + Number(o.maxlength) + "</span>" : "") + "</div>" +
      (o.error ? '<p class="xs-ferror" role="alert">' + esc(o.error) + "</p>" : o.hint ? '<p class="xs-fhint">' + esc(o.hint) + "</p>" : "");
  }
  function initial(text) {
    var s = String(text || "").replace(/^@/, "");
    return esc((Array.from(s)[0] || "?").toUpperCase());
  }
  /* People chips plus a search box. key names the box; removing a chip is a
     click on [data-xs-chip-remove="key"][data-value]. Suggestions are painted
     by suggest() into the box's .xs-suggest list. */
  function chips(opts) {
    var o = opts || {};
    var items = (o.items || []).map(function (it) {
      return '<span class="xs-chip"><span class="xs-chip-ava" aria-hidden="true">' + initial(it.label || it.value) + '</span><span class="xs-chip-label">' + esc(it.label || it.value) + "</span>" +
        '<button type="button" class="xs-chip-x" data-xs-chip-remove="' + esc(o.key) + '" data-value="' + esc(it.value) + '" aria-label="' + esc(tr("Remove {name}", { name: it.label || it.value })) + '">' + icon("close") + "</button></span>";
    }).join("");
    return '<div class="xs-chips" data-xs-chips="' + esc(o.key) + '">' + (o.label ? '<div class="xs-chips-label">' + esc(o.label) + "</div>" : "") +
      (items ? '<div class="xs-chip-list">' + items + "</div>" : "") +
      '<div class="xs-search">' + icon("search") + '<input type="search" class="xs-search-input" data-xs-chip-input="' + esc(o.key) + '" placeholder="' + esc(o.placeholder || tr("Search people")) + '" aria-label="' + esc(o.placeholder || tr("Search people")) + '" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"></div>' +
      '<div class="xs-suggest" role="listbox" data-xs-suggest="' + esc(o.key) + '" hidden></div></div>';
  }
  /* Fill the suggestion list under a chip box. people: [{handle, name}]. */
  function suggest(key, query, people, taken) {
    if (typeof document === "undefined") return;
    var box = document.querySelector('[data-xs-suggest="' + key + '"]');
    if (!box) return;
    var q = String(query || "").trim().replace(/^@/, "").toLowerCase();
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    var skip = {};
    (taken || []).forEach(function (h) { skip[String(h).toLowerCase()] = true; });
    var hits = (people || []).filter(function (p) {
      var h = String(p.handle || "").toLowerCase();
      return h && !skip[h] && (h.indexOf(q) >= 0 || String(p.name || "").toLowerCase().indexOf(q) >= 0);
    }).slice(0, 6);
    var exact = hits.some(function (p) { return String(p.handle).toLowerCase() === q; });
    var rows = hits.map(function (p) {
      return '<button type="button" role="option" class="xs-person" data-xs-pick="' + esc(key) + '" data-value="' + esc(p.handle) + '"><span class="xs-chip-ava" aria-hidden="true">' + initial(p.name || p.handle) + '</span><span class="xs-copy"><span class="xs-title">' + esc(p.name || p.handle) + '</span><span class="xs-sub">@' + esc(p.handle) + "</span></span></button>";
    }).join("");
    if (!exact && /^[A-Za-z0-9_]{1,15}$/.test(q) && !skip[q]) rows += '<button type="button" role="option" class="xs-person" data-xs-pick="' + esc(key) + '" data-value="' + esc(q) + '"><span class="xs-chip-ava" aria-hidden="true">@</span><span class="xs-copy"><span class="xs-title">' + esc(tr("Add @{handle}", { handle: q })) + "</span></span></button>";
    box.innerHTML = rows || '<p class="xs-desc">' + esc(tr("No matches")) + "</p>";
    box.hidden = false;
  }
  function summary(text, iconName) {
    return '<div class="xs-summary" role="status">' + icon(iconName || "eye") + "<span>" + esc(text) + "</span></div>";
  }
  function empty(title, text) {
    return '<div class="xs-empty"><b>' + esc(title) + "</b>" + (text ? "<span>" + esc(text) + "</span>" : "") + "</div>";
  }
  function moreBtn(attrs, label) {
    return '<button type="button" class="xs-more" ' + (attrs || "") + ' aria-label="' + esc(label || tr("More")) + '" aria-haspopup="menu">' + icon("more") + "</button>";
  }

  /* ---------- bottom sheet ---------- */
  var sheet = null;
  function closeSheet() {
    if (!sheet) return;
    var el = sheet.el;
    var back = sheet.focus;
    var done = sheet.onClose;
    sheet = null;
    el.classList.add("xs-leaving");
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 160);
    if (back && back.focus && document.contains(back)) { try { back.focus(); } catch (err) { /* gone */ } }
    if (done) { try { done(); } catch (err) { /* ignore */ } }
  }
  /* opts: { title, sub, body: html or fn returning html, onClick(el, event) ->
     true closes, onInput(el, event), onClose }. Returns { paint, close }. */
  function openSheet(opts) {
    if (typeof document === "undefined") return null;
    if (sheet) closeSheet();
    var o = opts || {};
    var el = document.createElement("div");
    el.className = "xs-sheet-back";
    el.setAttribute("data-xs-sheet", "1");
    var api = {
      paint: function () {
        var body = typeof o.body === "function" ? o.body() : o.body || "";
        var keep = document.activeElement && el.contains(document.activeElement) && document.activeElement.getAttribute("data-xs-keep");
        var pos = keep ? document.activeElement.selectionStart : 0;
        el.innerHTML = '<div class="xs-sheet" role="dialog" aria-modal="true" aria-label="' + esc(o.title || "") + '"><div class="xs-grab" aria-hidden="true"></div>' +
          (o.title ? '<div class="xs-sheet-head"><h2>' + esc(o.title) + "</h2>" + (o.sub ? '<p class="xs-desc">' + esc(o.sub) + "</p>" : "") + "</div>" : "") +
          '<div class="xs-sheet-body">' + body + "</div>" +
          (o.noCancel ? "" : '<div class="xs-sheet-foot"><button type="button" class="xs-pill xs-pill-outline xs-wide" data-xs-sheet-close>' + esc(o.cancel || tr("Cancel")) + "</button></div>") + "</div>";
        if (keep) {
          var again = el.querySelector('[data-xs-keep="' + keep + '"]');
          if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (err) { /* search */ } }
        }
      },
      close: closeSheet,
      el: el
    };
    sheet = { el: el, focus: document.activeElement, onClose: o.onClose };
    api.paint();
    el.addEventListener("click", function (event) {
      if (event.target === el || (event.target.closest && event.target.closest("[data-xs-sheet-close]"))) { event.preventDefault(); event.stopPropagation(); closeSheet(); return; }
      if (o.onClick) {
        var hit = event.target.closest ? event.target.closest("button, [data-xs-opt]") : null;
        if (hit && o.onClick(hit, event) === true) closeSheet();
      }
    });
    if (o.onInput) el.addEventListener("input", function (event) { o.onInput(event.target, event); });
    el.addEventListener("keydown", function (event) {
      if (o.onKey) o.onKey(event);
    });
    document.body.appendChild(el);
    var first = el.querySelector("[autofocus], .xs-radiorow.on, .xs-sheet-body button, .xs-sheet-body input");
    if (first) { try { first.focus({ preventScroll: true }); } catch (err) { first.focus(); } }
    return api;
  }
  /* A radio list in a sheet. options: [{value, label, sub}]. */
  function radioSheet(opts) {
    var o = opts || {};
    return openSheet({
      title: o.title, sub: o.sub,
      body: function () {
        return '<div role="radiogroup">' + (o.options || []).map(function (opt) {
          return radio({ title: opt.label, sub: opt.sub, on: String(opt.value) === String(o.current), attrs: 'data-xs-opt="' + esc(opt.value) + '"' + (opt.attrs ? " " + opt.attrs : "") });
        }).join("") + "</div>";
      },
      onClick: function (el) {
        if (!el.hasAttribute("data-xs-opt")) return false;
        if (o.onPick) o.onPick(el.getAttribute("data-xs-opt"), el);
        return true;
      }
    });
  }
  /* An action menu in a sheet (X's ⋯ menu on phones). items: [{label, icon, danger, pick}] */
  function menuSheet(opts) {
    var o = opts || {};
    var items = (o.items || []).filter(Boolean);
    return openSheet({
      title: o.title, sub: o.sub,
      body: '<div role="menu">' + items.map(function (it, i) {
        return '<button type="button" role="menuitem" class="xs-row xs-menuitem' + (it.danger ? " is-danger" : "") + '" data-xs-opt="' + i + '">' + (it.icon ? '<span class="xs-lead">' + icon(it.icon) + "</span>" : "") + '<span class="xs-copy"><span class="xs-title">' + esc(it.label) + "</span>" + (it.sub ? '<span class="xs-sub">' + esc(it.sub) + "</span>" : "") + "</span></button>";
      }).join("") + "</div>",
      onClick: function (el) {
        var it = items[Number(el.getAttribute("data-xs-opt"))];
        if (!it) return false;
        closeSheet();
        if (it.pick) it.pick();
        return false;
      }
    });
  }

  /* ---------- toast / undo snackbar ---------- */
  var toastTimer = 0;
  var toastUndo = null;
  function toast(text, opts) {
    if (typeof document === "undefined") return;
    var o = opts || {};
    var el = document.querySelector(".xs-toast");
    if (toastUndo && toastUndo.commit) { var c = toastUndo.commit; toastUndo = null; try { c(); } catch (err) { /* ignore */ } }
    if (!el) {
      el = document.createElement("div");
      el.className = "xs-toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
      el.addEventListener("click", function (event) {
        if (!event.target.closest || !event.target.closest("[data-xs-undo]")) return;
        event.preventDefault();
        var u = toastUndo;
        toastUndo = null;
        hide();
        if (u && u.undo) u.undo();
      });
    }
    el.innerHTML = "<span>" + esc(text) + "</span>" + (o.undo ? '<button type="button" data-xs-undo>' + esc(tr("Undo")) + "</button>" : "");
    el.classList.add("on");
    toastUndo = o.undo || o.commit ? { undo: o.undo, commit: o.commit } : null;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      var u = toastUndo;
      toastUndo = null;
      hide();
      if (u && u.commit) u.commit();
    }, o.ms || (o.undo ? 5000 : 2200));
    function hide() { clearTimeout(toastTimer); el.classList.remove("on"); }
  }
  /* Run a pending undoable action now (page closing). */
  function flushUndo() {
    if (toastUndo && toastUndo.commit) { var c = toastUndo.commit; toastUndo = null; try { c(); } catch (err) { /* ignore */ } }
  }

  /* ---------- drag to reorder ---------- */
  /* Rows inside [data-xs-sortable="key"] with [data-xs-sort-item="id"] and a
     [data-xs-sort-handle] move by pointer drag or arrow keys on the handle.
     onSort(key, fn) gets the new id order. */
  var sorters = {};
  function onSort(key, fn) { sorters[key] = fn; }
  function sortOrder(list) {
    return Array.prototype.map.call(list.querySelectorAll("[data-xs-sort-item]"), function (r) { return r.getAttribute("data-xs-sort-item"); });
  }
  function finishSort(list) {
    var fn = sorters[list.getAttribute("data-xs-sortable")];
    if (fn) fn(sortOrder(list));
  }
  if (typeof document !== "undefined") {
    var drag = null;
    document.addEventListener("pointerdown", function (event) {
      var handle = event.target.closest ? event.target.closest("[data-xs-sort-handle]") : null;
      if (!handle) return;
      var item = handle.closest("[data-xs-sort-item]");
      var list = item && item.closest("[data-xs-sortable]");
      if (!list) return;
      event.preventDefault();
      drag = { item: item, list: list, y: event.clientY, moved: false };
      item.classList.add("xs-dragging");
      try { handle.setPointerCapture(event.pointerId); } catch (err) { /* old browsers */ }
    });
    document.addEventListener("pointermove", function (event) {
      if (!drag) return;
      var dy = event.clientY - drag.y;
      drag.item.style.transform = "translateY(" + dy + "px)";
      var prev = drag.item.previousElementSibling;
      var next = drag.item.nextElementSibling;
      var h = drag.item.offsetHeight || 56;
      if (dy < -h / 2 && prev && prev.hasAttribute("data-xs-sort-item")) { drag.list.insertBefore(drag.item, prev); drag.y -= h; drag.moved = true; drag.item.style.transform = "translateY(" + (event.clientY - drag.y) + "px)"; }
      else if (dy > h / 2 && next && next.hasAttribute("data-xs-sort-item")) { drag.list.insertBefore(next, drag.item); drag.y += h; drag.moved = true; drag.item.style.transform = "translateY(" + (event.clientY - drag.y) + "px)"; }
    });
    var endDrag = function () {
      if (!drag) return;
      var d = drag;
      drag = null;
      d.item.classList.remove("xs-dragging");
      d.item.style.transform = "";
      if (d.moved) finishSort(d.list);
    };
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);
    document.addEventListener("keydown", function (event) {
      var handle = event.target && event.target.closest ? event.target.closest("[data-xs-sort-handle]") : null;
      if (handle && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        var item = handle.closest("[data-xs-sort-item]");
        var list = item && item.closest("[data-xs-sortable]");
        if (!list) return;
        event.preventDefault();
        var other = event.key === "ArrowUp" ? item.previousElementSibling : item.nextElementSibling;
        if (!other || !other.hasAttribute("data-xs-sort-item")) return;
        if (event.key === "ArrowUp") list.insertBefore(item, other); else list.insertBefore(other, item);
        var id = item.getAttribute("data-xs-sort-item");
        finishSort(list);
        setTimeout(function () { var again = document.querySelector('[data-xs-sort-item="' + id + '"] [data-xs-sort-handle]'); if (again) again.focus(); }, 0);
        return;
      }
    });
    /* Escape closes only the sheet, not the dialog under it. */
    window.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || !sheet) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      closeSheet();
    }, true);
    document.addEventListener("input", function (event) {
      var t = event.target;
      if (t && t.classList && t.classList.contains("xs-input")) {
        var f = t.closest(".xs-field");
        if (f) f.classList.toggle("has-value", !!t.value);
        var count = f && f.querySelector(".xs-count");
        if (count && t.maxLength > 0) count.textContent = Array.from(t.value).length + " / " + t.maxLength;
      }
    }, true);
  }

  function sortHandle(label) {
    return '<button type="button" class="xs-drag" data-xs-sort-handle aria-label="' + esc(label || tr("Drag to reorder")) + '">' + icon("drag") + "</button>";
  }

  root.XSettings = {
    esc: esc,
    icon: icon,
    row: row,
    check: check,
    radio: radio,
    section: section,
    desc: desc_,
    pill: pill,
    field: field,
    chips: chips,
    suggest: suggest,
    summary: summary,
    empty: empty,
    more: moreBtn,
    sortHandle: sortHandle,
    onSort: onSort,
    sheet: { open: openSheet, radio: radioSheet, menu: menuSheet, close: closeSheet, isOpen: function () { return !!sheet; } },
    toast: toast,
    flushUndo: flushUndo
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
