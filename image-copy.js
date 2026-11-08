/* Desktop right-click: copy the full picture, or save the original file.
   The clipboard gets a PNG of the decoded pixels. That PNG is not the
   original file. Download, when it is offered, saves the bytes that were
   fetched and does not compress them again. */
(function (root) {
  "use strict";

  var CAP = 25 * 1024 * 1024;
  var MAX_EDGE = 8192;

  function tr(text) {
    return root.SI18n && root.SI18n.t ? root.SI18n.t(text) : text;
  }

  function safeUrl(value, base) {
    var text = String(value || "").trim();
    if (!text) return "";
    try {
      var parsed = new URL(text, base || "https://images.invalid/");
      if (parsed.username || parsed.password) return "";
      if (parsed.protocol === "blob:") return text;
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
      return parsed.toString();
    } catch (err) {
      return "";
    }
  }

  function pushUnique(list, value, base) {
    var url = safeUrl(value, base);
    if (url && list.indexOf(url) < 0) list.push(url);
  }

  function listedFrom(record, base) {
    var list = [];
    pushUnique(list, record.currentSrc, base);
    pushUnique(list, record.src, base);
    pushUnique(list, record.source, base);
    pushUnique(list, record.fallbackSrc, base);
    pushUnique(list, record.refresh, base);
    var falls = record.falls;
    if (typeof falls === "string") {
      try { falls = JSON.parse(falls); } catch (err) { falls = []; }
    }
    if (!Array.isArray(falls)) falls = [];
    falls.forEach(function (url) { pushUnique(list, url, base); });
    String(record.srcset || "").split(",").forEach(function (part) {
      pushUnique(list, part.trim().split(/\s+/)[0], base);
    });
    return list;
  }

  function twimgOrig(url) {
    var parsed;
    try { parsed = new URL(url); } catch (err) { return ""; }
    if (parsed.protocol !== "https:" || parsed.hostname !== "pbs.twimg.com") return "";
    if (parsed.pathname.indexOf("/media/") !== 0) return "";
    if (!parsed.searchParams.has("name")) return "";
    parsed.searchParams.set("name", "orig");
    parsed.hash = "";
    return parsed.toString();
  }

  function ytimgMax(url) {
    var parsed;
    try { parsed = new URL(url); } catch (err) { return ""; }
    if (parsed.protocol !== "https:" || parsed.hostname !== "i.ytimg.com") return "";
    var match = parsed.pathname.match(/^\/vi\/([A-Za-z0-9_-]{6,16})\//);
    if (!match) return "";
    return "https://i.ytimg.com/vi/" + match[1] + "/maxresdefault.jpg";
  }

  function thumbRank(url) {
    var parsed;
    try { parsed = new URL(url); } catch (err) { return 9; }
    var name = parsed.searchParams.get("name") || "";
    var path = parsed.pathname;
    if (parsed.hostname === "pbs.twimg.com" && name === "orig") return 0;
    if (parsed.hostname === "i.ytimg.com" && /\/maxresdefault\.jpg$/.test(path)) return 1;
    if (parsed.hostname === "pbs.twimg.com" && (name === "small" || name === "thumb" || name === "medium" || name === "240x240" || name === "360x360")) return 9;
    if (parsed.hostname === "i.ytimg.com" && /\/(?:mq|hq|sd)default\.jpg$/.test(path)) return 9;
    if (parsed.hostname === "pbs.twimg.com" && name === "large") return 3;
    return 2;
  }

  function originalCandidates(record, base) {
    var listed = listedFrom(record, base);
    var shown = {};
    [safeUrl(record.currentSrc, base), safeUrl(record.src, base)].forEach(function (url) { if (url) shown[url] = true; });
    var out = [];
    listed.forEach(function (url) {
      pushUnique(out, twimgOrig(url), base);
      pushUnique(out, ytimgMax(url), base);
    });
    listed.forEach(function (url) {
      if (thumbRank(url) < 9) pushUnique(out, url, base);
    });
    function priority(url) {
      var rank = thumbRank(url);
      if (shown[url] && rank > 1) return rank + 4;
      return rank;
    }
    out.sort(function (a, b) { return priority(a) - priority(b); });
    return out.filter(function (url) { return thumbRank(url) < 9; });
  }

  function screenUrl(record, base) {
    return safeUrl(record.currentSrc, base) || safeUrl(record.src, base);
  }

  function allowedUrl(record, url, base) {
    var target = safeUrl(url, base);
    if (!target) return false;
    if (originalCandidates(record, base).indexOf(target) >= 0) return true;
    return target === screenUrl(record, base);
  }

  function fetchPlan(url, pageHref) {
    var target = safeUrl(url, pageHref);
    var page;
    try { page = new URL(pageHref); } catch (err) { page = null; }
    if (!target || !page) return null;
    var parsed = new URL(target, pageHref);
    if (parsed.protocol === "blob:") return { url: target, credentials: "omit", mode: "same-origin", auth: false };
    var same = parsed.origin === page.origin;
    return { url: parsed.toString(), credentials: same ? "include" : "omit", mode: same ? "same-origin" : "cors", auth: false };
  }

  function recordOf(img, base) {
    return {
      currentSrc: img.currentSrc || "",
      src: img.getAttribute("src") || "",
      source: img.dataset ? img.dataset.source || "" : "",
      fallbackSrc: img.dataset ? img.dataset.fallbackSrc || "" : "",
      refresh: img.dataset ? img.dataset.refresh || "" : "",
      falls: img.dataset ? img.dataset.falls || "" : "",
      srcset: img.getAttribute("srcset") || "",
      base: base || (root.location && root.location.href) || ""
    };
  }

  function contentImage(node) {
    if (!node || node.tagName !== "IMG") return null;
    if (node.closest && node.closest("a, button, input, textarea, video, .menu, .nav, .avatar, .pava")) return null;
    if (node.classList && (node.classList.contains("vposter") || node.classList.contains("face"))) return null;
    if (node.closest && node.closest(".vplay") && !(node.closest("#viewer"))) return null;
    if (!(node.closest && node.closest(".tile, #viewer, .media"))) return null;
    if (!node.isConnected || !node.getClientRects || !node.getClientRects().length) return null;
    return node;
  }

  function desktopNow() {
    var wide = (root.innerWidth || 0) >= 1000;
    var fine = true;
    try { fine = !root.matchMedia || root.matchMedia("(pointer: fine)").matches; } catch (err) { fine = true; }
    return wide && fine;
  }

  function featureOn() {
    try {
      var off = JSON.parse(root.localStorage.getItem("viktorychapp-server-off") || "[]");
      if (off && off.indexOf && off.indexOf("image_copy") >= 0) return false;
    } catch (err) { /* a bad list leaves the feature available */ }
    return true;
  }

  function layoutZoom() {
    var z = parseFloat(root.document && root.document.documentElement && root.document.documentElement.style.zoom);
    return z > 0 ? z : 1;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      originalCandidates: originalCandidates,
      screenUrl: screenUrl,
      allowedUrl: allowedUrl,
      fetchPlan: fetchPlan,
      thumbRank: thumbRank,
      safeUrl: safeUrl
    };
  }

  if (!root.document) return;

  var doc = root.document;
  var menu = null;
  var current = null;

  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    current = null;
  }

  function placeMenu(node, x, y) {
    var z = layoutZoom();
    var width = node.offsetWidth || 260;
    var height = node.offsetHeight || 120;
    var viewW = root.innerWidth / z;
    var viewH = root.innerHeight / z;
    var left = x / z;
    var top = y / z;
    if (left + width > viewW - 8) left = Math.max(8, viewW - 8 - width);
    if (top + height > viewH - 8) top = Math.max(8, viewH - 8 - height);
    node.style.left = Math.max(8, left) + "px";
    node.style.top = Math.max(8, top) + "px";
  }

  function note(text) {
    var el = menu && menu.querySelector(".image-copy-note");
    if (el) el.textContent = text;
  }

  function readCapped(res) {
    var len = Number(res.headers.get("content-length") || 0);
    if (len > CAP) return Promise.reject(new Error("large"));
    return res.arrayBuffer().then(function (buf) {
      if (buf.byteLength > CAP) throw new Error("large");
      return buf;
    });
  }

  function loadUrl(img, url) {
    var record = recordOf(img);
    if (!allowedUrl(record, url, record.base)) return Promise.reject(new Error("scope"));
    var plan = fetchPlan(url, record.base);
    if (!plan) return Promise.reject(new Error("scope"));
    return root.fetch(plan.url, {
      method: "GET",
      mode: plan.mode,
      credentials: plan.credentials,
      cache: "no-store",
      redirect: "follow"
    }).then(function (res) {
      if (!res || !res.ok) throw new Error("status");
      var finalUrl = "";
      try { finalUrl = new URL(res.url || plan.url).hostname; } catch (err) { finalUrl = ""; }
      var startHost = "";
      try { startHost = new URL(plan.url).hostname; } catch (err) { startHost = ""; }
      if (startHost && finalUrl && finalUrl !== startHost) throw new Error("redirect");
      var type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (type.indexOf("image/") !== 0 || type === "image/svg+xml") throw new Error("type");
      return readCapped(res).then(function (buf) {
        return { buffer: buf, type: type };
      });
    });
  }

  function originalsOf(img) {
    var record = recordOf(img);
    return originalCandidates(record, record.base);
  }

  function decode(buffer) {
    var blob = new Blob([buffer]);
    if (!root.createImageBitmap) return Promise.reject(new Error("decode"));
    return root.createImageBitmap(blob).then(function (bitmap) {
      if (!bitmap || bitmap.width < 1 || bitmap.height < 1 || bitmap.width > MAX_EDGE || bitmap.height > MAX_EDGE) {
        if (bitmap && bitmap.close) bitmap.close();
        throw new Error("size");
      }
      return bitmap;
    });
  }

  function pngBlob(bitmap) {
    var canvas = doc.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return Promise.reject(new Error("canvas"));
    ctx.drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) reject(new Error("png"));
        else resolve(blob);
      }, "image/png");
    });
  }

  function writePng(blobPromise) {
    if (!root.navigator || !root.navigator.clipboard || typeof root.navigator.clipboard.write !== "function" || typeof root.ClipboardItem !== "function") {
      return Promise.reject(new Error("clipboard"));
    }
    return root.navigator.clipboard.write([new root.ClipboardItem({ "image/png": blobPromise })]);
  }

  function fail(img, screen) {
    note(tr("The full picture did not load"));
    if (!menu || menu.querySelector("[data-act='image-copy-screen']") || !screen) return;
    var button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.act = "image-copy-screen";
    button.textContent = tr("Copy the picture on screen");
    button.addEventListener("click", function () { copyScreen(img); });
    menu.insertBefore(button, menu.querySelector(".image-copy-note"));
  }

  function copyOriginal(img) {
    var list = originalsOf(img);
    if (!list.length) {
      fail(img, screenUrl(recordOf(img), recordOf(img).base));
      return;
    }
    var pending = loadUrl(img, list[0]).then(function (file) { return decode(file.buffer).then(pngBlob); });
    var write;
    try { write = writePng(pending); }
    catch (err) { fail(img, screenUrl(recordOf(img), recordOf(img).base)); return; }
    write.then(function () {
      note(tr("Copied the picture"));
    }).catch(function () {
      fail(img, screenUrl(recordOf(img), recordOf(img).base));
    });
  }

  function copyScreen(img) {
    var url = screenUrl(recordOf(img), recordOf(img).base);
    if (!url) { fail(img, ""); return; }
    var pending = loadUrl(img, url).then(function (file) { return decode(file.buffer).then(pngBlob); });
    writePng(pending).then(function () {
      note(tr("This is the picture on the screen, not the full file."));
    }).catch(function () {
      note(tr("The full picture did not load"));
    });
  }

  function downloadOriginal(img) {
    var list = originalsOf(img);
    if (!list.length) { fail(img, ""); return; }
    loadUrl(img, list[0]).then(function (file) {
      var blob = new Blob([file.buffer], { type: file.type || "application/octet-stream" });
      var link = doc.createElement("a");
      var objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = "image";
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
      note(tr("Saves the original file as it is. It is not compressed again."));
    }).catch(function () {
      fail(img, "");
    });
  }

  function openMenu(img, x, y) {
    closeMenu();
    current = img;
    var node = doc.createElement("div");
    node.className = "menu image-copy-menu";
    node.style.position = "fixed";
    node.style.zIndex = "70";
    node.style.width = "280px";
    node.setAttribute("role", "menu");
    node.tabIndex = -1;
    node.addEventListener("keydown", function (event) {
      var items = Array.prototype.slice.call(node.querySelectorAll("[role='menuitem']"));
      var at = items.indexOf(doc.activeElement);
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); if (img.focus) img.focus(); }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        var next = event.key === "ArrowDown" ? at + 1 : at - 1;
        if (next < 0) next = items.length - 1;
        if (next >= items.length) next = 0;
        if (items[next]) items[next].focus();
      }
    });
    function item(label, run) {
      var button = doc.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = label;
      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        run();
      });
      node.appendChild(button);
      return button;
    }
    var copy = item(tr("Copy image"), function () { copyOriginal(img); });
    if (originalsOf(img).length) item(tr("Download original"), function () { downloadOriginal(img); });
    var hint = doc.createElement("p");
    hint.className = "image-copy-note";
    hint.textContent = tr("Copies a PNG of the full picture. This is not the original file. Color, HDR and animation may not match.");
    node.appendChild(hint);
    doc.body.appendChild(node);
    menu = node;
    placeMenu(node, x, y);
    copy.focus();
  }

  doc.addEventListener("contextmenu", function (event) {
    var img = contentImage(event.target);
    if (!img || !desktopNow()) return;
    if (!featureOn()) return;
    event.preventDefault();
    event.stopPropagation();
    openMenu(img, event.clientX, event.clientY);
  }, true);

  doc.addEventListener("pointerdown", function (event) {
    if (!menu || (event.target.closest && event.target.closest(".image-copy-menu"))) return;
    closeMenu();
  }, true);

  root.addEventListener("resize", closeMenu);
  root.addEventListener("hashchange", closeMenu);

  root.ViktorychImageCopy = {
    owns: function (node) { return !!(contentImage(node) && desktopNow()); },
    close: closeMenu,
    candidates: function (img) { return originalsOf(img); }
  };
})(typeof window !== "undefined" ? window : globalThis);
