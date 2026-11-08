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
    pushUnique(list, record.original, base);
    var falls = record.falls;
    if (typeof falls === "string") {
      try { falls = JSON.parse(falls); } catch (err) { falls = []; }
    }
    if (!Array.isArray(falls)) falls = [];
    falls.forEach(function (url) { pushUnique(list, url, base); });
    srcsetEntries(record.srcset, base).forEach(function (row) { pushUnique(list, row.url, base); });
    return list;
  }

  function srcsetEntries(value, base) {
    var out = [];
    String(value || "").split(",").forEach(function (part) {
      var bits = part.trim().split(/\s+/);
      if (!bits[0]) return;
      var url = safeUrl(bits[0], base);
      if (!url) return;
      var width = 0;
      var wide = String(bits[1] || "").match(/^(\d+)w$/);
      if (wide) width = Number(wide[1]);
      out.push({ url: url, width: width });
    });
    return out;
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
    var out = [];
    pushUnique(out, record.original, base);
    listedFrom(record, base).forEach(function (url) { pushUnique(out, twimgOrig(url), base); });
    return out;
  }

  function sizedCandidates(record, base) {
    var originals = originalCandidates(record, base);
    var best = {};
    srcsetEntries(record.srcset, base).forEach(function (row) {
      if (!row.url || originals.indexOf(row.url) >= 0 || thumbRank(row.url) >= 9) return;
      if (!best[row.url] || row.width > best[row.url]) best[row.url] = row.width;
    });
    listedFrom(record, base).forEach(function (url) {
      var max = ytimgMax(url);
      if (max && originals.indexOf(max) < 0 && best[max] == null) best[max] = 0;
    });
    return Object.keys(best).map(function (url) { return { url: url, width: best[url] }; }).sort(function (a, b) {
      return b.width - a.width;
    });
  }

  function plan(record, base) {
    var originals = originalCandidates(record, base);
    var sized = sizedCandidates(record, base);
    var displayed = screenUrl(record, base);
    var label = originals.length ? "original" : sized.length ? "listed" : "displayed";
    return { originals: originals, sized: sized, displayed: displayed, label: label, downloadOriginal: originals.length > 0 };
  }

  function copyOrder(record, base) {
    var picked = plan(record, base);
    var out = picked.originals.slice();
    picked.sized.forEach(function (row) { pushUnique(out, row.url, base); });
    return out;
  }

  function screenUrl(record, base) {
    return safeUrl(record.currentSrc, base) || safeUrl(record.src, base);
  }

  function allowedUrl(record, url, base) {
    var target = safeUrl(url, base);
    if (!target) return false;
    if (copyOrder(record, base).indexOf(target) >= 0) return true;
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
      original: img.dataset ? img.dataset.original || "" : "",
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
      sizedCandidates: sizedCandidates,
      plan: plan,
      copyOrder: copyOrder,
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
  var epoch = 0;
  var inflight = [];

  function identityNow() {
    var accounts = root.ViktorychAccounts;
    var gen = 0;
    var id = "";
    try {
      if (accounts && typeof accounts.sessionGeneration === "function") gen = Number(accounts.sessionGeneration()) || 0;
      if (accounts && typeof accounts.account === "function") {
        var account = accounts.account();
        if (account && account.publicId) id = String(account.publicId);
      }
    } catch (err) { /* a broken account module counts as signed out */ }
    return { gen: gen, id: id };
  }

  function sameIdentity(held) {
    if (!held) return false;
    var now = identityNow();
    return now.gen === held.gen && now.id === held.id;
  }

  function live(op) {
    return !!(op && !op.done && op.epoch === epoch && sameIdentity(op.who));
  }

  function drop(op) {
    if (!op || op.done) return;
    op.done = true;
    if (op.controller) { try { op.controller.abort(); } catch (err) { /* already aborted */ } }
    (op.urls || []).forEach(function (url) { try { URL.revokeObjectURL(url); } catch (err) { /* already revoked */ } });
    op.urls = [];
    (op.bitmaps || []).forEach(function (bitmap) { try { if (bitmap && bitmap.close) bitmap.close(); } catch (err) { /* already closed */ } });
    op.bitmaps = [];
    op.buffer = null;
  }

  function cancelAll() {
    epoch += 1;
    inflight.forEach(drop);
    inflight = [];
  }

  function startOp() {
    var op = { epoch: epoch, who: identityNow(), controller: typeof AbortController === "function" ? new AbortController() : null, urls: [], bitmaps: [], done: false };
    inflight.push(op);
    return op;
  }

  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
    current = null;
  }

  function codeError(code) {
    var err = new Error(code);
    err.code = code;
    return err;
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
    if (len > CAP) return Promise.reject(codeError("fetch"));
    return res.arrayBuffer().then(function (buf) {
      if (buf.byteLength > CAP) throw codeError("fetch");
      return buf;
    });
  }

  function loadUrl(img, url, op) {
    if (!live(op)) return Promise.reject(codeError("session"));
    var record = recordOf(img);
    if (!allowedUrl(record, url, record.base)) return Promise.reject(codeError("scope"));
    var plan = fetchPlan(url, record.base);
    if (!plan) return Promise.reject(codeError("scope"));
    return root.fetch(plan.url, {
      method: "GET",
      mode: plan.mode,
      credentials: plan.credentials,
      cache: "no-store",
      redirect: "follow",
      signal: op.controller ? op.controller.signal : undefined
    }).then(function (res) {
      if (!live(op)) throw codeError("session");
      if (!res || !res.ok) throw codeError("fetch");
      var finalUrl = "";
      try { finalUrl = new URL(res.url || plan.url).hostname; } catch (err) { finalUrl = ""; }
      var startHost = "";
      try { startHost = new URL(plan.url).hostname; } catch (err) { startHost = ""; }
      if (startHost && finalUrl && finalUrl !== startHost) throw codeError("fetch");
      var type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (type.indexOf("image/") !== 0 || type === "image/svg+xml") throw codeError("fetch");
      return readCapped(res).then(function (buf) {
        if (!live(op)) throw codeError("session");
        return { buffer: buf, type: type, url: plan.url };
      });
    });
  }

  function orderOf(img) {
    var record = recordOf(img);
    return copyOrder(record, record.base);
  }

  function decode(buffer, op) {
    if (!live(op)) return Promise.reject(codeError("session"));
    var blob = new Blob([buffer]);
    if (!root.createImageBitmap) return Promise.reject(codeError("decode"));
    return root.createImageBitmap(blob).then(function (bitmap) {
      if (!live(op)) {
        if (bitmap && bitmap.close) bitmap.close();
        throw codeError("session");
      }
      if (!bitmap || bitmap.width < 1 || bitmap.height < 1 || bitmap.width > MAX_EDGE || bitmap.height > MAX_EDGE) {
        if (bitmap && bitmap.close) bitmap.close();
        throw codeError("decode");
      }
      op.bitmaps.push(bitmap);
      return bitmap;
    });
  }

  function pngBlob(bitmap) {
    var canvas = doc.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return Promise.reject(codeError("decode"));
    ctx.drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) reject(codeError("decode"));
        else resolve(blob);
      }, "image/png");
    });
  }

  function writePng(blobPromise, op) {
    if (!root.navigator || !root.navigator.clipboard || typeof root.navigator.clipboard.write !== "function" || typeof root.ClipboardItem !== "function") {
      return Promise.reject(codeError("clipboard"));
    }
    var guarded = Promise.resolve(blobPromise).then(function (blob) {
      if (!live(op)) throw codeError("session");
      return blob;
    });
    return root.navigator.clipboard.write([new root.ClipboardItem({ "image/png": guarded })]).then(function () {
      if (!live(op)) throw codeError("session");
    });
  }

  function reasonOf(err) {
    var name = err && err.name ? String(err.name) : "";
    var code = err && err.code ? String(err.code) : "";
    if (code === "session" || name === "AbortError") return "session";
    if (name === "NotAllowedError" || name === "SecurityError") return "permission";
    if (code === "clipboard") return "clipboard";
    if (code === "decode") return "decode";
    if (code === "fetch" || code === "scope") return "fetch";
    return "";
  }

  function addScreen(img) {
    var record = recordOf(img);
    if (!menu || menu.querySelector("[data-act='image-copy-screen']") || !screenUrl(record, record.base)) return;
    var button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.act = "image-copy-screen";
    button.textContent = tr("Copy the picture on screen");
    button.addEventListener("click", function () { copyScreen(img); });
    menu.insertBefore(button, menu.querySelector(".image-copy-note"));
  }

  function show(reason, img) {
    if (reason === "session") return;
    if (reason === "permission") note(tr("The clipboard permission was denied. The picture was not copied."));
    else if (reason === "clipboard") note(tr("This browser cannot copy a picture. The picture was not copied."));
    else if (reason === "decode") note(tr("The picture could not be read. It was not copied."));
    else {
      note(tr("The full picture did not load"));
      if (img) addScreen(img);
    }
  }

  function tryUrls(img, urls, op) {
    var index = 0;
    function next() {
      if (!live(op)) return Promise.reject(codeError("session"));
      if (index >= urls.length) return Promise.reject(codeError("fetch"));
      var url = urls[index];
      index += 1;
      return loadUrl(img, url, op).then(function (file) {
        if (!live(op)) throw codeError("session");
        return file;
      }).catch(function (err) {
        if (!live(op) || reasonOf(err) === "session") throw codeError("session");
        return next();
      });
    }
    return next();
  }

  function copyUrls(img, urls, success, onFail) {
    if (!urls.length) { show("fetch", img); if (onFail) onFail(); return; }
    var op = startOp();
    var stage = "fetch";
    var pending = tryUrls(img, urls, op).then(function (file) {
      if (!live(op)) throw codeError("session");
      stage = "decode";
      op.buffer = file.buffer;
      op.copiedUrl = file.url;
      return decode(file.buffer, op);
    }).then(function (bitmap) {
      if (!live(op)) throw codeError("session");
      return pngBlob(bitmap);
    }).then(function (blob) {
      if (!live(op)) throw codeError("session");
      stage = "clipboard";
      op.buffer = null;
      return blob;
    });
    var reported = false;
    var clipboardReported = false;
    function reportImage(err) {
      if (reported || clipboardReported) return;
      reported = true;
      var still = live(op);
      var why = reasonOf(err);
      drop(op);
      if (!still || why === "session") return;
      if (why === "decode" || stage === "decode") { show("decode", img); return; }
      show("fetch", img);
      if (onFail) onFail();
    }
    function reportClipboard(err) {
      var why = reasonOf(err);
      if (why !== "permission" && why !== "clipboard") return;
      if (clipboardReported) return;
      clipboardReported = true;
      reported = true;
      var still = live(op);
      drop(op);
      if (!still) return;
      show(why, img);
    }
    pending.catch(reportImage);
    var write;
    try { write = writePng(pending, op); }
    catch (err) { reportClipboard(err.code ? err : codeError("clipboard")); return; }
    write.then(function () {
      if (reported || !live(op)) { drop(op); return; }
      reported = true;
      note(success);
    }).catch(reportClipboard);
  }

  function addAction(act, label, run) {
    if (!menu || menu.querySelector("[data-act='" + act + "']")) return;
    var button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.dataset.act = act;
    button.textContent = label;
    button.addEventListener("click", function () { run(); });
    var hint = menu.querySelector(".image-copy-note");
    if (hint) menu.insertBefore(button, hint);
    else menu.appendChild(button);
  }

  function widthGroups(sized) {
    var groups = [];
    sized.forEach(function (row) {
      var last = groups[groups.length - 1];
      if (!last || last.width !== row.width) groups.push({ width: row.width, urls: [row.url] });
      else last.urls.push(row.url);
    });
    return groups;
  }

  function copySized(img, sized, largest) {
    var groups = widthGroups(sized);
    if (!groups.length) { show("fetch", img); addScreen(img); return; }
    var success = largest
      ? tr("Copied the largest listed picture. It is not a proven original file.")
      : tr("Copied a smaller listed picture. It is not the full file.");
    copyUrls(img, groups[0].urls, success, function () {
      var rest = sized.filter(function (row) { return row.width < groups[0].width; });
      if (rest.length) {
        addAction("image-copy-smaller", tr("Copy a smaller listed picture"), function () { copySized(img, rest, false); });
      }
      addScreen(img);
    });
  }

  function copyOriginal(img) {
    var record = recordOf(img);
    var picked = plan(record, record.base);
    if (picked.originals.length) {
      copyUrls(img, picked.originals, tr("Copied the picture"), function () {
        if (picked.sized.length) {
          addAction("image-copy-listed", tr("Copy the largest listed picture"), function () { copySized(img, picked.sized, true); });
        }
        addScreen(img);
      });
      return;
    }
    if (picked.sized.length) { copySized(img, picked.sized, true); return; }
    show("fetch", img);
  }

  function copyScreen(img) {
    var record = recordOf(img);
    var url = screenUrl(record, record.base);
    if (!url) { show("fetch", img); return; }
    copyUrls(img, [url], tr("This is the picture on the screen, not the full file."));
  }

  function downloadOriginal(img) {
    var record = recordOf(img);
    var urls = originalCandidates(record, record.base);
    if (!urls.length) { show("fetch", img); return; }
    var op = startOp();
    tryUrls(img, urls, op).then(function (file) {
      if (!live(op)) throw codeError("session");
      var blob = new Blob([file.buffer], { type: file.type || "application/octet-stream" });
      op.buffer = null;
      var objectUrl = URL.createObjectURL(blob);
      op.urls.push(objectUrl);
      if (!live(op)) { drop(op); return; }
      var link = doc.createElement("a");
      link.href = objectUrl;
      link.download = "image";
      if (!live(op)) { drop(op); return; }
      doc.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(function () { if (op.urls.indexOf(objectUrl) >= 0) { try { URL.revokeObjectURL(objectUrl); } catch (err) { /* already revoked */ } } }, 1000);
      if (live(op)) note(tr("Saves the original file as it is. It is not compressed again."));
    }).catch(function (err) {
      var still = live(op);
      var why = reasonOf(err);
      drop(op);
      if (!still || why === "session") return;
      show("fetch", img);
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
    var picked = plan(recordOf(img), recordOf(img).base);
    var copy = null;
    if (picked.originals.length || picked.sized.length) copy = item(tr("Copy image"), function () { copyOriginal(img); });
    if (picked.downloadOriginal) item(tr("Download original"), function () { downloadOriginal(img); });
    if (!picked.originals.length && !picked.sized.length && picked.displayed) copy = item(tr("Copy the picture on screen"), function () { copyScreen(img); });
    var hint = doc.createElement("p");
    hint.className = "image-copy-note";
    hint.textContent = picked.originals.length
      ? tr("Copies a PNG of the full picture. This is not the original file. Color, HDR and animation may not match.")
      : picked.sized.length
        ? tr("Copies the largest listed picture. It is not a proven original file. Color, HDR and animation may not match.")
        : tr("This is the picture on the screen, not the full file.");
    node.appendChild(hint);
    doc.body.appendChild(node);
    menu = node;
    placeMenu(node, x, y);
    if (copy) copy.focus();
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
  root.addEventListener("hashchange", function () { cancelAll(); closeMenu(); });
  root.addEventListener("pagehide", function () { cancelAll(); closeMenu(); });
  root.addEventListener("viktorych-session", function () { cancelAll(); closeMenu(); });

  root.ViktorychImageCopy = {
    owns: function (node) { return !!(contentImage(node) && desktopNow()); },
    close: closeMenu,
    plan: function (img) { return plan(recordOf(img), recordOf(img).base); },
    candidates: function (img) { return orderOf(img); }
  };
})(typeof window !== "undefined" ? window : globalThis);
