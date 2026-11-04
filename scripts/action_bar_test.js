#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  let i = source.indexOf("{", start);
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("unclosed " + name);
}

const quoteFn = extractFunction(app, "quoteCard");
assert.ok(quoteFn.indexOf("actionBar(") < 0 && quoteFn.indexOf('class="actions"') < 0, "quote cards do not render an action row");
assert.ok(css.indexOf(".quote .actions { display: none") >= 0, "a nested action row inside a quote stays hidden");
assert.ok(css.indexOf("flex: 1 1 0%") >= 0 && css.indexOf("max-width: 25%") >= 0, "reply, repost, like, and views share flex slots");
assert.ok(css.indexOf("width: 18.75px") >= 0 && css.indexOf(".action .count") >= 0, "icon and count sizes stay on the action bar");
const barFn = extractFunction(app, "actionBar");
assert.ok(barFn.indexOf("lai-action") < 0, "the action row does not include the sparkle button");
assert.ok(barFn.indexOf('class="action-more"') >= 0, "bookmark and share stay in their own group");
assert.ok(app.indexOf('class="byline-end"') >= 0, "header tools sit in one right-aligned group");

function icon() {
  return '<span class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z"/></svg></span>';
}

function button(cls, count) {
  return '<button class="action ' + cls + '" type="button">' + icon() + (count ? '<span class="count">' + count + "</span>" : "") + "</button>";
}

function bar(id) {
  return '<div class="actions" data-bar="' + id + '"><div class="action-stats">' +
    button("reply", "13,6 mil") +
    '<span class="repost-wrap">' + button("repost", "425 mil") + "</span>" +
    button("like", "4,1 M") +
    button("views", "999 mil") +
    '</div><div class="action-more">' +
    button("bookmark", "") +
    button("share", "") +
    "</div></div>";
}

function column(width, kind) {
  const quote = '<div class="quote" data-quote="1"><div class="quote-head"><span class="name">user_a</span><span class="handle">@user_a</span></div><div class="quote-text">quoted line</div><div class="media m1"><div class="tile"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div></div>' + bar("quote") + "</div>";
  if (kind === "status") {
    return '<article class="status" data-case="status" data-w="' + width + '">' + bar("status") + "</article>";
  }
  const cls = kind === "reply" ? "post reply-card" : "post";
  return '<article class="' + cls + '" data-case="' + kind + '" data-w="' + width + '"><div class="post-row"><a><span class="ava"></span></a><div class="post-main">' +
    (kind === "feed" ? quote : "") +
    bar(kind) +
    "</div></div></article>";
}

function page(width) {
  const phone = width <= 499;
  const columnWidth = phone ? "100%" : (width >= 1100 ? "600px" : "calc(100% - 88px)");
  return `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="file://${path.join(ROOT, "styles.css")}"><style>
    html, body { margin: 0; background: #000; }
    .post { content-visibility: visible; }
    article[data-case] { width: ${columnWidth}; max-width: 100%; }
  </style></head><body>
${column(width, "feed")}
${column(width, "status")}
${column(width, "reply")}
<pre id="out"></pre>
<script>`;
}

const script = `
function box(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return {
    l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height,
    display: s.display, flexGrow: s.flexGrow, maxWidth: s.maxWidth,
    fontSize: s.fontSize, color: s.color, overflow: s.overflow
  };
}
function hit(a, b) {
  if (!a || !b) return 0;
  const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return x > 0.6 && y > 0.6 ? x : 0;
}
const rows = [];
document.querySelectorAll("[data-case]").forEach((col) => {
  const bar = col.querySelector('.actions[data-bar="' + col.dataset.case + '"]');
  const order = ["reply", "repost", "like", "views", "bookmark", "share"].map((name) => bar.querySelector(".action." + name));
  const counts = order.map((el) => el.querySelector(".count"));
  const icons = order.map((el) => el.querySelector(".ic"));
  const main = col.querySelector(".post-main") || col;
  const slot = bar.querySelector(".action-stats > .action.reply");
  const quote = col.querySelector(".quote");
  const quoteBar = quote ? quote.querySelector(".actions") : null;
  rows.push({
    case: col.dataset.case,
    w: Number(col.dataset.w),
    bar: box(bar),
    main: box(main),
    slot: box(slot),
    actions: order.map(box),
    counts: counts.map(box),
    icons: icons.map(box),
    quoteBar: quote ? box(quoteBar) : null,
    quoteHead: quote ? box(quote.querySelector(".quote-head")) : null,
    quoteText: quote ? box(quote.querySelector(".quote-text")) : null,
    quoteMedia: quote ? box(quote.querySelector(".media")) : null
  });
});
document.getElementById("out").textContent = JSON.stringify(rows);
</script></body></html>`;

function chrome(file, width) {
  // Headless Chrome on CI sometimes exits before it dumps the page; try again before failing.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return chromeOnce(file, width); } catch (err) { last = err; }
  }
  throw last;
}

function chromeOnce(file, width) {
  const bin = fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : "google-chrome";
  const run = spawnSync(bin, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--force-device-scale-factor=1",
    "--virtual-time-budget=4000",
    "--window-size=" + width + ",900",
    "--dump-dom",
    "file://" + file
  ], { encoding: "utf8", timeout: 60000 });
  if (run.status !== 0) throw new Error("chrome failed " + (run.stderr || run.stdout || run.status));
  const match = String(run.stdout || "").match(/<pre id="out">([\s\S]*?)<\/pre>/);
  if (!match) throw new Error("chrome did not measure layout");
  return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actions-"));
const widths = [320, 360, 390, 430, 768, 1280];
const rows = [];
widths.forEach((width) => {
  const file = path.join(dir, "bar-" + width + ".html");
  fs.writeFileSync(file, page(width) + script);
  chrome(file, width).forEach((row) => rows.push(row));
});

function hit(a, b) {
  if (!a || !b) return 0;
  const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return x > 0.6 && y > 0.6 ? x : 0;
}

rows.forEach((row) => {
  const label = row.case + "@" + row.w;
  assert.ok(row.bar && row.bar.w > 40, label + " bar missing");
  assert.ok(row.bar.r <= row.main.r + 1, label + " bar overflows " + row.bar.r + " " + row.main.r);
  assert.strictEqual(row.slot.flexGrow, "1", label + " slot flex");
  assert.notStrictEqual(row.slot.maxWidth, "none", label + " slot max width");
  const tops = row.actions.map((item) => item.t);
  tops.forEach((top) => assert.ok(Math.abs(top - tops[0]) < 1, label + " wrapped"));
  row.actions.forEach((item) => assert.ok(item.h > 16 && item.h < 56, label + " action height " + item.h));
  for (let i = 0; i < row.actions.length; i++) {
    for (let j = i + 1; j < row.actions.length; j++) {
      assert.strictEqual(hit(row.actions[i], row.actions[j]), 0, label + " actions overlap " + i + " " + j);
    }
  }
  row.counts.forEach((count, index) => {
    if (!count) return;
    assert.ok(count.w > 0, label + " count missing");
    assert.ok(count.r <= row.actions[index].r + 0.6, label + " count wider than slot");
    assert.strictEqual(count.fontSize, "13px", label + " count size");
    for (let j = index + 1; j < row.icons.length; j++) {
      assert.strictEqual(hit(count, row.icons[j]), 0, label + " count overlaps icon " + j);
    }
  });
  const widths = row.actions.slice(0, 4).map((item) => item.w);
  const max = Math.max.apply(null, widths);
  const min = Math.min.apply(null, widths);
  assert.ok(max - min < 2, label + " uneven slots " + widths.join(","));
  assert.ok(row.actions[4].l + 1 >= row.actions[3].r, label + " bookmark is not on the right");
  assert.ok(row.actions[5].l + 1 >= row.actions[4].r, label + " share is not grouped");
  assert.ok(row.actions[5].l - row.actions[4].r < 24, label + " bookmark and share are not grouped");
  if (row.quoteBar) {
    assert.strictEqual(row.quoteBar.display, "none", label + " quote action row is visible");
    assert.ok(row.quoteBar.h < 1, label + " quote action row takes space");
    assert.ok(row.quoteHead.w > 20 && row.quoteText.w > 20 && row.quoteMedia.w > 20, label + " quote body missing");
  }
});

const narrow = rows.filter((row) => row.case === "feed" && (row.w === 320 || row.w === 390));
assert.strictEqual(narrow.length, 2, "320 and 390 timeline rows");
console.log("action bar layout checks passed");

{
  const vm = require("vm");
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, "i18n.js"), "utf8"));
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, "i18n/en.js"), "utf8"));
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, "i18n/es.js"), "utf8"));
  const i18n = globalThis.SI18n;
  i18n.setLang("en");
  assert.strictEqual(i18n.formatCount(2200), "2.2K");
  assert.strictEqual(i18n.formatCount(7400), "7.4K");
  assert.strictEqual(i18n.formatCount(151000), "151K");
  assert.strictEqual(i18n.formatCount(5200000), "5.2M");
  assert.strictEqual(i18n.formatCount(999), "999");
  i18n.setLang("es");
  assert.strictEqual(i18n.formatCount(2200), "2,2K");
  assert.strictEqual(i18n.formatCount(279000), "279K");
  assert.strictEqual(i18n.formatCount(5200000), "5,2M");
  console.log("compact counts match X");
}

// Rides along (workflow files are not edited here): Settings > Free tier
// usage always finishes loading.
{
  const usage = spawnSync(process.execPath, [require("path").join(__dirname, "usage_panel_test.mjs")], { encoding: "utf8" });
  if (usage.status !== 0) { console.error(usage.stdout, usage.stderr); }
  assert.strictEqual(usage.status, 0, "usage panel test");
  console.log(usage.stdout.trim());
}
