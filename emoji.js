/* Emoji stay characters. The device font draws them. A sequence the device
   cannot draw (skin tone, ZWJ, flag, keycap, variation selector) is marked
   so the fallback face can shape that run. The face is Noto Color Emoji from
   the pinned fontsource package (OFL-1.1), requested only after a miss.
   Unicode coverage is that font's repertoire, not every future emoji. */
(function (root) {
  var SEQ = null;
  try {
    SEQ = new RegExp("(?:\\u{1F3F4}[\\u{E0020}-\\u{E007E}]{2,}\\u{E007F}|[#*0-9]\\uFE0F?\\u20E3|\\p{Regional_Indicator}{2}|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*)", "gu");
  } catch (err) { SEQ = null; }
  var cache = new Map();
  var queued = false;
  var ctx = null;

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function saveData() {
    try {
      var c = root.navigator && root.navigator.connection;
      return !!(c && c.saveData);
    } catch (err) { return false; }
  }
  function complex(seq) {
    if (!seq) return false;
    try {
      if (seq.indexOf("\u200D") >= 0 || seq.indexOf("\uFE0F") >= 0 || seq.indexOf("\u20E3") >= 0) return true;
      if (/^\u{1F3F4}/u.test(seq) || /\p{Emoji_Modifier}/u.test(seq) || /^\p{Regional_Indicator}{2}$/u.test(seq)) return true;
    } catch (err) { return false; }
    return false;
  }
  function measure() {
    if (ctx) return ctx;
    try {
      var canvas = root.document && root.document.createElement("canvas");
      ctx = canvas && canvas.getContext ? canvas.getContext("2d", { willReadFrequently: true }) : null;
    } catch (err) { ctx = null; }
    return ctx;
  }
  function widthOf(text) {
    var pen = measure();
    if (!pen) return 0;
    pen.font = '32px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", emoji, sans-serif';
    return pen.measureText(text).width;
  }
  function nativeDraws(seq) {
    try {
    if (typeof root.__viktorychEmojiMiss === "function" && root.__viktorychEmojiMiss(seq)) return false;
    if (saveData() || !measure()) return true;
    var full = widthOf(seq);
    if (!full) return true;
    if (seq.indexOf("\u200D") >= 0) {
      var broken = widthOf(seq.split("\u200D").join(""));
      return broken > 0 && full < broken * 0.72;
    }
    if (/^\p{Regional_Indicator}{2}$/u.test(seq)) {
      var one = widthOf(String.fromCodePoint(seq.codePointAt(0)));
      return one > 0 && full < one * 1.45;
    }
    var pen = measure();
    pen.clearRect(0, 0, 64, 64);
    pen.font = '48px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", emoji, sans-serif';
    pen.fillStyle = "#111";
    pen.fillText(seq, 2, 50);
    var data;
    try { data = pen.getImageData(0, 0, 64, 64).data; } catch (err) { return true; }
    var ink = 0;
    var color = 0;
    for (var i = 0; i < data.length; i += 16) {
      if (data[i + 3] < 24) continue;
      ink += 1;
      if (Math.abs(data[i] - data[i + 1]) > 14 || Math.abs(data[i + 1] - data[i + 2]) > 14) color += 1;
    }
    return ink > 6 && color / ink > 0.08;
    } catch (err) { return true; }
  }
  function allow(seq) {
    if (cache.has(seq)) return cache.get(seq) !== "fb";
    var ok = nativeDraws(seq);
    cache.set(seq, ok ? "ok" : "fb");
    if (!ok && root.document && root.document.documentElement) root.document.documentElement.classList.add("emoji-web");
    return ok;
  }
  function wrap(seq, alreadyEscaped) {
    var body = alreadyEscaped ? seq : esc(seq);
    if (cache.get(seq) === "ok") return body;
    if (!complex(seq)) {
      if (!measure() && cache.get(seq) !== "fb") return body;
      if (cache.get(seq) !== "fb" && allow(seq)) return body;
      return '<span class="emo fb">' + body + "</span>";
    }
    var fb = cache.get(seq) === "fb" ? " fb" : "";
    if (!fb) queue();
    return '<span class="emo' + fb + '">' + body + "</span>";
  }
  function walk(value, alreadyEscaped) {
    var text = String(value == null ? "" : value);
    if (!SEQ || !text) return alreadyEscaped ? text : esc(text);
    SEQ.lastIndex = 0;
    var out = "";
    var last = 0;
    var match;
    while ((match = SEQ.exec(text))) {
      if (!match[0]) break;
      var plain = text.slice(last, match.index);
      out += alreadyEscaped ? plain : esc(plain);
      out += wrap(match[0], alreadyEscaped);
      last = match.index + match[0].length;
    }
    var rest = text.slice(last);
    out += alreadyEscaped ? rest : esc(rest);
    return out;
  }
  /* Tags, comments and attribute values stay byte for byte. Only the text
     between tags is scanned, so an emoji inside href or title is not a span. */
  function markScan(html) {
    var src = String(html || "");
    var out = "";
    var i = 0;
    var n = src.length;
    while (i < n) {
      if (src.charAt(i) !== "<") {
        var next = src.indexOf("<", i);
        if (next < 0) next = n;
        out += walk(src.slice(i, next), true);
        i = next;
        continue;
      }
      if (src.slice(i, i + 4) === "<!--") {
        var comment = src.indexOf("-->", i + 4);
        if (comment < 0) { out += src.slice(i); break; }
        out += src.slice(i, comment + 3);
        i = comment + 3;
        continue;
      }
      var j = i + 1;
      var quote = "";
      while (j < n) {
        var ch = src.charAt(j);
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === "\"" || ch === "'") quote = ch;
        else if (ch === ">") { j += 1; break; }
        j += 1;
      }
      out += src.slice(i, j);
      i = j;
    }
    return out;
  }
  function markDom(html) {
    var doc = root.document.implementation.createHTMLDocument("");
    var box = doc.createElement("div");
    box.innerHTML = String(html || "");
    var nodes = [];
    var stack = [box];
    while (stack.length) {
      var node = stack.pop();
      var kids = node.childNodes;
      for (var c = kids.length - 1; c >= 0; c--) stack.push(kids[c]);
      if (node.nodeType === 3) nodes.push(node);
    }
    nodes.forEach(function (child) {
      var parent = child.parentNode;
      if (!parent || (parent.closest && parent.closest(".emo"))) return;
      var tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return;
      var raw = child.nodeValue || "";
      if (!raw) return;
      var next = walk(raw, false);
      if (next.indexOf("<span") < 0) return;
      var tpl = doc.createElement("template");
      tpl.innerHTML = next;
      parent.replaceChild(tpl.content, child);
    });
    return box.innerHTML;
  }
  function settle() {
    if (!root.document) return;
    var nodes = root.document.querySelectorAll(".emo:not([data-emo])");
    var budget = Math.min(nodes.length, 80);
    for (var i = 0; i < budget; i++) {
      var node = nodes[i];
      var seq = node.textContent || "";
      var ok = allow(seq);
      node.setAttribute("data-emo", ok ? "ok" : "fb");
      if (!ok) node.classList.add("fb");
    }
    if (nodes.length > budget) queue();
  }
  function queue() {
    if (queued || !root.document) return;
    queued = true;
    var run = function () { queued = false; settle(); };
    if (typeof root.requestAnimationFrame === "function") root.requestAnimationFrame(run);
    else root.setTimeout(run, 0);
  }
  function units(text) {
    var src = String(text || "");
    if (!SEQ) return Array.from(src);
    SEQ.lastIndex = 0;
    var out = [];
    var last = 0;
    var match;
    while ((match = SEQ.exec(src))) {
      if (!match[0]) break;
      out.push.apply(out, Array.from(src.slice(last, match.index)));
      out.push(match[0]);
      last = match.index + match[0].length;
    }
    out.push.apply(out, Array.from(src.slice(last)));
    return out;
  }
  root.ViktorychEmoji = {
    text: function (value) { return walk(value, false); },
    mark: function (html) {
      if (root.document && root.document.implementation && root.document.implementation.createHTMLDocument) {
        try { return markDom(html); } catch (err) { return markScan(html); }
      }
      return markScan(html);
    },
    clip: function (value, max) {
      var text = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
      var cap = Math.max(0, Number(max) || 0);
      var parts = units(text);
      return parts.length > cap ? parts.slice(0, cap).join("") : text;
    },
    units: units,
    queue: queue,
    settle: settle,
    nativeDraws: nativeDraws,
    complex: complex
  };
})(typeof window !== "undefined" ? window : globalThis);
