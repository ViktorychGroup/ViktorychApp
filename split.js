/* Shared column splitter.
   Messages uses it for the inbox list. The main sidebar can use the same
   helper: FeedsSplit.bind(separator, { id, cssVar, fallback, min, maxRatio, pane }).
   Saved widths are one map in localStorage. The live size is a CSS variable
   on the document element, so a pane can paint at the saved width. */
(function (root) {
  var STORE = "viktorychapp-splits-v1";
  var LEGACY = "superintelapp-splits-v1";
  var PREVIOUS = "rss-" + "feeds-splits-v1";
  var panes = [];
  var bound = [];
  var resizeListening = false;

  function storedMap() {
    try {
      var raw = root.localStorage.getItem(STORE);
      if (raw == null) {
        var previous = root.localStorage.getItem(LEGACY);
        if (previous == null) previous = root.localStorage.getItem(PREVIOUS);
        if (previous != null) {
          raw = previous;
          try { root.localStorage.setItem(STORE, previous); } catch (err) { /* private mode */ }
        }
      }
      var parsed = JSON.parse(raw || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function read(id) {
    var n = Math.round(Number(storedMap()[id]));
    return isFinite(n) && n > 0 ? n : 0;
  }

  function write(id, value) {
    var all = storedMap();
    all[id] = Math.round(value);
    try { root.localStorage.setItem(STORE, JSON.stringify(all)); } catch (err) { /* private mode */ }
  }

  function clear(id) {
    var all = storedMap();
    delete all[id];
    try { root.localStorage.setItem(STORE, JSON.stringify(all)); } catch (err) { /* private mode */ }
  }

  function clamp(value, min, max) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) n = min;
    if (n < min) n = min;
    if (max && n > max) n = max;
    return n;
  }

  function desktopArea() {
    var w = root.innerWidth || 1280;
    if (w < 700) return w;
    var nav = w >= 1280 ? 275 : 88;
    return Math.max(320, Math.min(w, 1750) - nav);
  }

  function areaOf(spec, pane) {
    if (pane && pane.clientWidth >= 320) return pane.clientWidth;
    if (spec.area) return spec.area();
    return desktopArea();
  }

  function limits(spec, pane) {
    var min = spec.min || 300;
    var max = spec.max ? Math.round(spec.max) : Math.round(areaOf(spec, pane) * (spec.maxRatio || 0.6));
    if (max < min) max = min;
    return { min: min, max: max };
  }

  function settle(spec, value, box) {
    var n = clamp(value, box.min, box.max);
    if (spec.snapBelow != null && n < spec.snapBelow) {
      return clamp(spec.snapTo != null ? spec.snapTo : box.min, box.min, box.max);
    }
    if (spec.floor != null && n < spec.floor) n = spec.floor;
    return clamp(n, box.min, box.max);
  }

  function paint(spec, px) {
    if (!root.document || !root.document.documentElement) return;
    root.document.documentElement.style.setProperty(spec.cssVar, Math.round(px) + "px");
  }

  function apply(spec, pane, value) {
    var box = limits(spec, pane);
    var source = value == null ? (read(spec.id) || spec.fallback) : value;
    var n = settle(spec, source, box);
    paint(spec, n);
    if (typeof spec.onChange === "function") spec.onChange(n);
    return n;
  }

  function set(spec, value) {
    var pane = null;
    var el = null;
    bound.forEach(function (item) {
      if (item.spec.id === spec.id && item.el.isConnected) {
        pane = item.pane;
        el = item.el;
      }
    });
    var n = apply(spec, pane, value);
    if (el) syncAria(el, spec, pane, n);
    if (n === spec.fallback) clear(spec.id);
    else write(spec.id, n);
    return n;
  }

  function syncAria(el, spec, pane, n) {
    var box = limits(spec, pane);
    el.setAttribute("aria-valuemin", String(box.min));
    el.setAttribute("aria-valuemax", String(box.max));
    el.setAttribute("aria-valuenow", String(n));
  }

  function onResize() {
    bound.forEach(function (item) {
      if (!item.el.isConnected || item.dragging) return;
      var saved = read(item.spec.id) || item.spec.fallback;
      var n = apply(item.spec, item.pane, saved);
      syncAria(item.el, item.spec, item.pane, n);
    });
  }

  /* Width from the pane's fixed edge to the pointer. A pane whose handle sits
     on its left edge (spec.fromRight() true) grows when dragged left. */
  function offsetOf(spec, host, clientX) {
    var rect = host.getBoundingClientRect();
    if (typeof spec.fromRight === "function" && spec.fromRight()) return rect.right - clientX;
    return clientX - rect.left;
  }

  function bind(el, spec, pane) {
    if (!el || !spec || el.getAttribute("data-split-bound") === "1") return;
    el.setAttribute("data-split-bound", "1");
    var host = pane || el.parentElement;
    var item = { el: el, spec: spec, pane: host, dragging: false };
    var frame = 0;
    var pending = 0;
    function commit(value, persist) {
      var n = apply(spec, host, value);
      syncAria(el, spec, host, n);
      if (persist) {
        if (n === spec.fallback) clear(spec.id);
        else write(spec.id, n);
      }
      return n;
    }
    commit(read(spec.id) || spec.fallback, false);
    el.addEventListener("pointerdown", function (event) {
      if (event.button != null && event.button !== 0) return;
      item.dragging = true;
      el.classList.add("is-dragging");
      if (root.document.documentElement) root.document.documentElement.classList.add("is-split-drag");
      if (el.setPointerCapture) {
        try { el.setPointerCapture(event.pointerId); } catch (err) { /* already released */ }
      }
      event.preventDefault();
    });
    el.addEventListener("pointermove", function (event) {
      if (!item.dragging) return;
      pending = offsetOf(spec, host, event.clientX);
      if (frame) return;
      frame = root.requestAnimationFrame(function () {
        frame = 0;
        if (!item.dragging) return;
        commit(pending, false);
      });
    });
    function finish(event) {
      if (!item.dragging) return;
      item.dragging = false;
      el.classList.remove("is-dragging");
      if (root.document.documentElement) root.document.documentElement.classList.remove("is-split-drag");
      if (frame) {
        root.cancelAnimationFrame(frame);
        frame = 0;
      }
      var x = event && isFinite(event.clientX) ? offsetOf(spec, host, event.clientX) : pending;
      commit(x, true);
    }
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);
    el.addEventListener("dblclick", function (event) {
      event.preventDefault();
      if (typeof spec.toggle === "function") {
        var current = parseFloat(el.getAttribute("aria-valuenow"));
        if (!isFinite(current)) current = spec.fallback;
        commit(spec.toggle(current), true);
        return;
      }
      clear(spec.id);
      commit(spec.fallback, false);
    });
    el.addEventListener("keydown", function (event) {
      var box = limits(spec, host);
      var current = parseFloat(el.getAttribute("aria-valuenow"));
      if (!isFinite(current)) current = spec.fallback;
      var step = event.shiftKey ? 48 : 16;
      var left = event.key === "ArrowLeft" || event.key === "ArrowUp";
      var right = event.key === "ArrowRight" || event.key === "ArrowDown";
      var next = null;
      if (left) next = current - step;
      else if (right) next = current + step;
      else if (event.key === "Home") next = box.min;
      else if (event.key === "End") next = box.max;
      else return;
      if (spec.snapTo != null && spec.floor != null) {
        if (left && current <= spec.floor) next = spec.snapTo;
        else if (right && current <= spec.snapTo) next = spec.floor;
      }
      event.preventDefault();
      event.stopPropagation();
      commit(next, true);
    });
    bound.push(item);
    if (!resizeListening) {
      resizeListening = true;
      root.addEventListener("resize", onResize);
    }
  }

  function register(spec) {
    panes.push(spec);
    apply(spec, null, null);
    return spec;
  }

  var messages = register({
    id: "messages",
    cssVar: "--dmsgs-list",
    fallback: 440,
    min: 300,
    maxRatio: 0.6,
    area: desktopArea
  });

  var sidebar = register({
    id: "sidebar",
    cssVar: "--nav-w",
    fallback: 275,
    min: 88,
    max: 275,
    snapBelow: 200,
    snapTo: 88,
    floor: 248,
    toggle: function (current) { return current > 88 ? 88 : 275; },
    onChange: function (n) {
      var rootEl = root.document && root.document.documentElement;
      if (!rootEl) return;
      var narrow = !!(root.matchMedia && root.matchMedia("(max-width: 1279px)").matches);
      if (narrow || n < 200) rootEl.setAttribute("data-nav", "icons");
      else rootEl.removeAttribute("data-nav");
    }
  });

  /* Desktop side panel (search, Friends, Who to follow). On the right its
     handle is the left edge; moved to the left it is the right edge. */
  var side = register({
    id: "side",
    cssVar: "--side-w",
    fallback: 350,
    min: 280,
    max: 520,
    fromRight: function () {
      var rootEl = root.document && root.document.documentElement;
      return !(rootEl && rootEl.getAttribute("data-side-pos") === "left");
    }
  });

  root.FeedsSplit = {
    read: read,
    write: write,
    clear: clear,
    clamp: clamp,
    apply: apply,
    set: set,
    bind: bind,
    register: register,
    messages: messages,
    sidebar: sidebar,
    side: side
  };
})(typeof window !== "undefined" ? window : globalThis);
