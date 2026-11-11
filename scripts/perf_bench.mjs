/* Reproducible timings for posting, replies, and everyday use.
   Local fixtures only. Reports the median of 5 runs.
   onScreenMs: the post, reply, or control is on screen.
   durableMs: the write is confirmed (server accepted it, and a post is no longer Sending).
   visibleMs: another signed-in session shows it.
   PLAYWRIGHT_CORE=... node scripts/perf_bench.mjs
   BENCH_RUNS=5  BENCH_OUT=/tmp/perf.json
   BENCH_ALT=/path/to/other/tree   interleave that tree ABAB; defaults stay one tree */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runs = Math.max(1, Number(process.env.BENCH_RUNS || 5));
const ME = "100000000001";
const OTHER = "200000000002";
const store = { posts: [], likes: {}, followed: false, catalog: "" };

function mime(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".png")) return "image/png";
  return "text/javascript";
}
function series(list) {
  return list.filter((n) => typeof n === "number" && n >= 0).slice().sort((a, b) => a - b);
}
function median(list) {
  const s = series(list);
  if (!s.length) return null;
  return Number(s[Math.floor(s.length / 2)].toFixed(1));
}
/* Quartiles of the sorted samples. The spread is q3 - q1. */
function spread(list) {
  const s = series(list);
  if (!s.length) return { q1: null, q3: null, iqr: null };
  const at = (q) => s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
  const q1 = at(0.25);
  const q3 = at(0.75);
  return { q1: Number(q1.toFixed(1)), q3: Number(q3.toFixed(1)), iqr: Number((q3 - q1).toFixed(1)) };
}
function startServer(tree, bag) {
  const data = bag || store;
  const base = tree || root;
  const feeds = [];
  const posts = [];
  for (let i = 0; i < 24; i++) {
    const id = "p" + String(i).padStart(2, "0");
    feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i, title: "Lane " + i, configured: true });
    posts.push({
      id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post",
      date: new Date(Date.now() - i * 600000).toISOString(),
      text: "Fixture line " + i + " for the speed bench.",
      author: "Lane " + i, handle: "lane" + i, media: [],
      stats: { replies: 0, reposts: 0, likes: 1, views: 2 }
    });
  }
  const catalog = JSON.stringify({ updated: "2026-11-10T00:00:00.000Z", feeds, posts });
  data.catalog = catalog;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(catalog);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(base, rel));
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file) + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function arm(context, bag) {
  const data = bag || store;
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathName = url.pathname;
    const method = req.method();
    const send = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (pathName === "/v1/data/feeds.json") return send(200, JSON.parse(data.catalog));
    if (pathName === "/v1/posts" && method === "GET") return send(200, { posts: data.posts.slice() });
    if (pathName === "/v1/posts" && method === "POST") {
      let body = {};
      try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
      const post = {
        id: "b" + String(data.posts.length + 1).padStart(6, "0") + "c".repeat(10),
        body: String(body.body || ""),
        parentId: String(body.parentId || ""),
        authorId: ME,
        authorHandle: "user_a",
        authorName: "User A",
        createdAt: Date.now(),
        likes: 0,
        liked: false,
        replyCount: 0,
        media: []
      };
      data.posts.unshift(post);
      if (post.parentId) {
        const parent = data.posts.find((item) => item.id === post.parentId);
        if (parent) parent.replyCount = (parent.replyCount || 0) + 1;
      }
      return send(201, { post });
    }
    if (pathName === "/v1/posts/like" && method === "POST") {
      let body = {};
      try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
      const id = String(body.id || "");
      data.likes[id] = !!body.on;
      return send(200, { likes: body.on ? 2 : 1, liked: !!body.on });
    }
    if (pathName === "/v1/profile/user_b") {
      return send(200, { account: { publicId: OTHER, handle: "user_b", displayName: "User B", followersCount: data.followed ? 6 : 5, followingCount: 1, friendsCount: 0 } });
    }
    if (pathName === "/v1/follows" && method === "GET") return send(200, { ids: data.followed ? ["app:" + OTHER] : [], followingCount: data.followed ? 2 : 1, followersCount: 1, outgoingRequests: [] });
    if (pathName === "/v1/follows" && (method === "PUT" || method === "DELETE")) {
      data.followed = method === "PUT";
      return send(200, { ok: true, id: "app:" + OTHER, pending: false, followersCount: data.followed ? 6 : 5, followingCount: data.followed ? 2 : 1 });
    }
    return send(200, { ok: true });
  });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
}

async function prep(context) {
  await context.addInitScript((me) => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-bench-token",
      account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" }
    }));
    const follows = [];
    for (let i = 0; i < 24; i++) follows.push("lane" + i);
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows, lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {} }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    window.__lt = [];
    try { new PerformanceObserver((list) => list.getEntries().forEach((entry) => window.__lt.push(entry.duration))).observe({ type: "longtask", buffered: true }); } catch (err) {}
  }, ME);
}

function tasksSince(page, mark) {
  return page.evaluate((from) => {
    const list = (window.__lt || []).slice(from);
    const blocking = list.reduce((sum, dur) => sum + Math.max(0, dur - 50), 0);
    return { n: list.length, max: Math.round(Math.max(0, ...list, 0)), blocking: Math.round(blocking) };
  }, mark);
}
function taskMark(page) {
  return page.evaluate(() => (window.__lt || []).length);
}
/* A 4× phone spends longer in the same work. The 20s cap was dropping
   those runs. Desktop stays on the original waits. */
let stepScale = 1;
function stepWait(ms) {
  return stepScale > 1 ? ms * 3 : ms;
}

async function openSession(browser, size, bag) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, serviceWorkers: "block" });
  await prep(context);
  await arm(context, bag);
  const page = await context.newPage();
  if (size.cpu > 1) {
    const client = await context.newCDPSession(page);
    await client.send("Emulation.setCPUThrottlingRate", { rate: size.cpu });
  }
  return { context, page };
}

async function coldWarm(page, origin) {
  /* A restored shell can show posts before the app has started. The open
     is the live app, which sets this flag before it paints. */
  const ready = () => window.ViktorychRouteSnap && document.querySelectorAll("#app article.post").length >= 3;
  const coldStart = Date.now();
  await page.goto(origin + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(ready, null, { timeout: 30000 });
  const cold = Date.now() - coldStart;
  const warmStart = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(ready, null, { timeout: 30000 });
  return { cold, warm: Date.now() - warmStart };
}

async function tabSwitch(page) {
  const mark = await taskMark(page);
  const t0 = Date.now();
  await page.evaluate(() => {
    const btn = document.querySelector('button[data-act="htab"][data-tab="following"]') || document.querySelector('[data-act="htab"][data-tab="following"]');
    if (btn) btn.click();
  });
  await page.waitForFunction(() => (location.hash || "").indexOf("following") >= 0 && !!document.querySelector("main article.post, main .empty"), null, { timeout: stepWait(15000) });
  const tasks = await tasksSince(page, mark);
  return { onScreenMs: Date.now() - t0, durableMs: null, visibleMs: null, longMax: tasks.max };
}

async function scrollJank(page) {
  const mark = await taskMark(page);
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    window.__frameOn = true;
    const step = (now) => {
      window.__frames.push(now - last);
      last = now;
      if (window.__frameOn) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 1400);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__frameOn = false; });
  const tasks = await tasksSince(page, mark);
  const frameMax = await page.evaluate(() => Math.round(Math.max(0, ...(window.__frames || [0]))));
  return { longMax: tasks.max, longN: tasks.n, blocking: tasks.blocking, frameMax };
}

async function likeOnce(page) {
  const t0 = Date.now();
  const appeared = page.waitForFunction(() => {
    const btn = document.querySelector('button[data-act="like"]');
    return !!(btn && btn.classList.contains("on"));
  }, null, { timeout: stepWait(15000) });
  const saved = page.waitForFunction(() => {
    const btn = document.querySelector('button[data-act="like"].on');
    const id = btn && btn.dataset.id || "";
    if (!id) return false;
    try { return (localStorage.getItem("viktorychapp-settings-v1") || "").indexOf(id) >= 0; } catch (err) { return false; }
  }, null, { timeout: stepWait(15000) });
  await page.evaluate(() => { const btn = document.querySelector('button[data-act="like"]'); if (btn) btn.click(); });
  await appeared;
  const onScreenMs = Date.now() - t0;
  await saved;
  return { onScreenMs, durableMs: Date.now() - t0, visibleMs: null, longMax: null };
}

async function followOnce(page, origin) {
  await page.goto(origin + "/index.html#/@user_b", { waitUntil: "domcontentloaded" });
  /* The first follow button on the page can be a feed control whose hidden
     label already says Following. This is the profile's own button, and the
     saved time is that button's PUT, not whichever request finishes first. */
  const sel = 'button[data-act="follow"][data-id="app:' + OTHER + '"]';
  await page.waitForSelector(sel, { timeout: stepWait(20000) });
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => {
    if (res.url().indexOf("/v1/follows") < 0 || res.request().method() !== "PUT") return false;
    return (res.request().postData() || "").indexOf(OTHER) >= 0;
  }, { timeout: stepWait(15000) }).catch(() => null);
  const appeared = page.waitForFunction((button) => {
    const el = document.querySelector(button);
    return !!(el && (el.classList.contains("following") || el.getAttribute("aria-pressed") === "true"));
  }, sel, { timeout: stepWait(15000) });
  await page.locator(sel).evaluate((el) => el.click());
  await appeared;
  const onScreenMs = Date.now() - t0;
  await ack;
  const durableMs = Date.now() - t0;
  return { onScreenMs, durableMs, visibleMs: null, longMax: null };
}

async function compose(page, text, reply) {
  if (reply) {
    await page.locator('button[data-act="public-reply"]').locator("visible=true").first().evaluate((el) => el.click());
  } else {
    await page.evaluate(() => {
      const fab = document.querySelector("button.fab");
      const side = document.querySelector("button.post-btn");
      const box = fab ? fab.getBoundingClientRect() : null;
      const btn = box && box.width > 8 && box.height > 8 ? fab : side;
      if (btn) btn.click();
    });
  }
  const field = page.locator(".xc-modal textarea, #compose-text").first();
  await field.waitFor({ state: "visible", timeout: stepWait(15000) });
  await field.fill(text);
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/posts") >= 0 && res.request().method() === "POST", { timeout: stepWait(20000) }).catch(() => null);
  await page.locator('#compose-post, .xc-modal [data-act="xc-publish"]').locator("visible=true").first().evaluate((el) => el.click());
  await page.waitForFunction((needle) => {
    const nodes = document.querySelectorAll("article.post");
    for (let i = 0; i < nodes.length; i++) if ((nodes[i].innerText || "").indexOf(needle) >= 0) return true;
    return false;
  }, text, { timeout: stepWait(20000) });
  const onScreenMs = Date.now() - t0;
  await ack;
  await page.waitForFunction((needle) => {
    const nodes = document.querySelectorAll("article.post");
    for (let i = 0; i < nodes.length; i++) {
      const textNow = nodes[i].innerText || "";
      if (textNow.indexOf(needle) >= 0 && textNow.indexOf("Sending") < 0) return true;
    }
    return false;
  }, text, { timeout: stepWait(20000) }).catch(() => {});
  const durableMs = Date.now() - t0;
  return { onScreenMs, durableMs, t0 };
}

async function otherSees(browser, size, origin, text, t0, bag) {
  stepScale = size.cpu > 1 ? 3 : 1;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-bench-token-b",
      account: { publicId: "200000000002", handle: "user_b", displayName: "User B", avatar: "" }
    }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  await arm(context, bag);
  const page = await context.newPage();
  if (size.cpu > 1) {
    const client = await context.newCDPSession(page);
    await client.send("Emulation.setCPUThrottlingRate", { rate: size.cpu });
  }
  try {
    await page.goto(origin + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForFunction((needle) => (document.body.innerText || "").indexOf(needle) >= 0, text, { timeout: stepWait(20000) });
    return Date.now() - t0;
  } finally {
    await context.close();
  }
}

async function oneRun(browser, size, origin, index, bag) {
  stepScale = size.cpu > 1 ? 3 : 1;
  if (bag) bag.followed = false;
  const session = await openSession(browser, size, bag);
  const row = {};
  try {
    const loads = await coldWarm(session.page, origin);
    row.load = loads;
    row.tab = await tabSwitch(session.page);
    await session.page.evaluate(() => { location.hash = "#/"; });
    await session.page.waitForSelector("article.post", { timeout: stepWait(15000) });
    row.scroll = await scrollJank(session.page);
    row.like = await likeOnce(session.page);
    row.follow = await followOnce(session.page, origin);
    await session.page.goto(origin + "/index.html#/", { waitUntil: "domcontentloaded" });
    await session.page.waitForFunction(() => [...document.querySelectorAll('button[data-act="compose"]')].some((el) => el.getBoundingClientRect().width > 8), null, { timeout: stepWait(20000) });
    const postText = "Bench post " + size.name + " " + index;
    const posted = await compose(session.page, postText, false);
    posted.visibleMs = await otherSees(browser, size, origin, postText, posted.t0, bag);
    row.post = posted;
    const replyText = "Bench reply " + size.name + " " + index;
    const replied = await compose(session.page, replyText, true);
    replied.visibleMs = await otherSees(browser, size, origin, replyText, replied.t0, bag);
    row.reply = replied;
    return row;
  } finally {
    await session.context.close();
  }
}

function pack(rows, pick) {
  return median(rows.map(pick));
}
function packSpread(rows, pick) {
  return spread(rows.map(pick));
}

const PICKS = [
  ["coldMs", (row) => row.load && row.load.cold],
  ["warmMs", (row) => row.load && row.load.warm],
  ["tabMs", (row) => row.tab && row.tab.onScreenMs],
  ["scrollLongMax", (row) => row.scroll && row.scroll.longMax],
  ["scrollFrameMax", (row) => row.scroll && row.scroll.frameMax],
  ["scrollBlocking", (row) => row.scroll && row.scroll.blocking],
  ["likeOnScreen", (row) => row.like && row.like.onScreenMs],
  ["followOnScreen", (row) => row.follow && row.follow.onScreenMs],
  ["followDurable", (row) => row.follow && row.follow.durableMs],
  ["postOnScreen", (row) => row.post && row.post.onScreenMs],
  ["postDurable", (row) => row.post && row.post.durableMs],
  ["postVisible", (row) => row.post && row.post.visibleMs],
  ["replyOnScreen", (row) => row.reply && row.reply.onScreenMs],
  ["replyDurable", (row) => row.reply && row.reply.durableMs],
  ["replyVisible", (row) => row.reply && row.reply.visibleMs]
];
function summarize(name, rows) {
  const out = { name: name, n: rows.length };
  PICKS.forEach(([key, pick]) => { out[key] = pack(rows, pick); });
  out.spread = {};
  PICKS.forEach(([key, pick]) => { out.spread[key] = packSpread(rows, pick); });
  return out;
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const altRoot = process.env.BENCH_ALT || "";
  const altBag = { posts: [], likes: {}, followed: false, catalog: "" };
  const server = await startServer(root, store);
  const origin = "http://127.0.0.1:" + server.address().port;
  let altServer = null;
  let altOrigin = "";
  if (altRoot) {
    altServer = await startServer(altRoot, altBag);
    altOrigin = "http://127.0.0.1:" + altServer.address().port;
  }
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--no-sandbox", "--disable-gpu"] });
  const allSizes = [
    { name: "phone", width: 390, height: 844, cpu: 1 },
    { name: "desktop", width: 1280, height: 800, cpu: 1 },
    { name: "phone4x", width: 390, height: 844, cpu: 4 }
  ];
  const wanted = (process.env.BENCH_SIZES || "").split(",").filter(Boolean);
  const sizes = wanted.length ? allSizes.filter((size) => wanted.indexOf(size.name) >= 0) : allSizes;
  const summary = [];
  const altSummary = [];
  try {
    for (const size of sizes) {
      const rows = [];
      const altRows = [];
      for (let i = 1; i <= runs; i++) {
        process.stderr.write(size.name + (altOrigin ? " A" : "") + " run " + i + "\n");
        try { rows.push(await oneRun(browser, size, origin, i, store)); }
        catch (err) { process.stderr.write(size.name + " run " + i + " failed " + (err && err.message) + "\n"); }
        if (!altOrigin) continue;
        process.stderr.write(size.name + " B run " + i + "\n");
        try { altRows.push(await oneRun(browser, size, altOrigin, i, altBag)); }
        catch (err) { process.stderr.write(size.name + " B run " + i + " failed " + (err && err.message) + "\n"); }
      }
      summary.push(summarize(size.name, rows));
      if (altOrigin) altSummary.push(summarize(size.name, altRows));
    }
  } finally {
    await browser.close();
    server.close();
    if (altServer) altServer.close();
  }
  const doc = { sha: process.env.BENCH_SHA || "", runs, summary };
  if (altOrigin) doc.alt = { root: altRoot, summary: altSummary };
  const text = JSON.stringify(doc, null, 2);
  if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, text);
  console.log(text);
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
