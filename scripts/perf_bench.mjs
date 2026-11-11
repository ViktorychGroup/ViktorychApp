/* Reproducible timings for posting, replies, and everyday use.
   Local fixtures only. Reports the median of 5 runs.
   onScreenMs: the post, reply, or control is on screen.
   durableMs: the write is confirmed (server accepted it, and a post is no longer Sending).
   visibleMs: a fresh other signed-in session shows it.
   openVisibleMs: an already-open Home shows it. Null means that tab was not told.
   setupMs, bootMs, paintMs and fetchMs split that fresh session. The mock
   answers in-process, so fetchMs is not Worker or D1 time.
   PLAYWRIGHT_CORE=... node scripts/perf_bench.mjs
   BENCH_RUNS=5  BENCH_OUT=/tmp/perf.json
   BENCH_ALT=/path/to/other/tree   interleave that tree ABAB; defaults stay one tree */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = process.env.BENCH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runs = Math.max(1, Number(process.env.BENCH_RUNS || 5));
const ME = "100000000001";
const OTHER = "200000000002";
const store = { posts: [], likes: {}, followed: false, catalog: "", friend: "none" };
/* 1×1 PNG. The photo reply attaches this file and the mock serves it back. */
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function nextPostId(data) {
  const n = (data.posts.length + 1).toString(16).padStart(8, "0");
  return (n + "abcdefabcdefabcdefabcdef").slice(0, 32);
}

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
    const send = (status, body) => route.fulfill({
      status,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(body)
    });
    const readFields = () => {
      try { return req.postDataJSON() || {}; } catch (err) {
        const raw = req.postData() || "";
        const field = (name) => {
          const found = raw.match(new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)'));
          return found ? found[1] : "";
        };
        return { body: field("body"), parentId: field("parentId"), id: field("id") };
      }
    };
    if (pathName.indexOf("/v1/posts/media/") === 0) {
      return route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
    }
    if (pathName === "/v1/data/feeds.json") return send(200, JSON.parse(data.catalog));
    if (pathName === "/v1/posts" && method === "GET") return send(200, { posts: data.posts.slice() });
    if (pathName === "/v1/posts" && method === "POST") {
      const body = readFields();
      const multipart = String(req.headers()["content-type"] || "").indexOf("multipart/") === 0;
      const post = {
        id: nextPostId(data),
        body: String(body.body || ""),
        parentId: String(body.parentId || ""),
        authorId: ME,
        authorHandle: "user_a",
        authorName: "User A",
        createdAt: Date.now(),
        likes: 0,
        liked: false,
        replyCount: 0,
        media: multipart ? [{ id: "m1", mime: "image/png", url: "/v1/posts/media/bench" }] : []
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
      const post = data.posts.find((item) => item.id === id);
      if (post) post.likes = body.on ? 2 : 1;
      return send(200, { likes: body.on ? 2 : 1, liked: !!body.on });
    }
    if (pathName === "/v1/posts/edit" && method === "POST") {
      const body = readFields();
      const post = data.posts.find((item) => item.id === String(body.id || ""));
      if (post && body.body) post.body = String(body.body);
      return send(200, { ok: true, body: post ? post.body : "", editedAt: Date.now() });
    }
    if (pathName === "/v1/posts/delete" && method === "POST") {
      const body = readFields();
      const id = String(body.id || "");
      data.posts = data.posts.filter((item) => item.id !== id);
      return send(200, { ok: true });
    }
    if (pathName === "/v1/friends" && method === "GET") {
      const tab = url.searchParams.get("tab") || "";
      const status = data.friend || "none";
      if (tab === "requests") {
        const row = { handle: "user_b", id: "app:" + OTHER, friendStatus: status === "sent" ? "sent" : "received" };
        return send(200, {
          incoming: status === "received" ? [row] : [],
          outgoing: status === "sent" ? [row] : []
        });
      }
      return send(200, {
        friends: status === "friends" ? [{ handle: "user_b", id: "app:" + OTHER }] : [],
        friendStatus: status,
        friendsCount: status === "friends" ? 1 : 0,
        friendsOff: false,
        canRequest: true
      });
    }
    if (pathName.indexOf("/v1/friends/") === 0 && method === "POST") {
      const action = pathName.slice("/v1/friends/".length);
      if (action === "request") data.friend = "sent";
      else if (action === "accept") data.friend = "friends";
      else if (action === "cancel" || action === "decline" || action === "remove") data.friend = "none";
      return send(200, { ok: true, friendStatus: data.friend });
    }
    if (pathName === "/v1/profile/user_b" || pathName === "/v1/profile/user_a") {
      const handle = pathName.endsWith("user_a") ? "user_a" : "user_b";
      const viewerB = String(req.headers()["authorization"] || "").indexOf("token-b") >= 0;
      let status = data.friend || "none";
      if (viewerB && handle === "user_a" && status === "sent") status = "received";
      if (!viewerB && handle === "user_a") status = "none";
      return send(200, {
        account: {
          publicId: handle === "user_a" ? ME : OTHER,
          handle: handle,
          displayName: handle === "user_a" ? "User A" : "User B",
          followersCount: data.followed ? 6 : 5,
          followingCount: 1,
          friendsCount: status === "friends" ? 1 : 0,
          viewerFriendStatus: status
        }
      });
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
  await page.waitForSelector('button[data-act="follow"]', { timeout: stepWait(20000) });
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/follows") >= 0 && res.request().method() === "PUT", { timeout: stepWait(15000) }).catch(() => null);
  const appeared = page.waitForFunction(() => {
    const btn = document.querySelector('button[data-act="follow"]');
    return !!(btn && /Following|Pending|Friends/.test(btn.textContent || ""));
  }, null, { timeout: stepWait(15000) }).catch(() => null);
  await page.evaluate(() => { const btn = document.querySelector('button[data-act="follow"]'); if (btn) btn.click(); });
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

/* A fresh other-account session, the same cold open the older rows use.
   The mock answers in the same process, so fetchMs is the browser's own
   request time and the Worker and D1 are not in this number. bootMs is
   navigation until DOMContentLoaded. paintMs is from there until the
   text is on screen. */
async function otherSession(browser, size, origin, bag) {
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
  return { context, page };
}

async function otherSees(browser, size, origin, text, t0, bag, hash, mode) {
  const setupAt = Date.now();
  const session = await otherSession(browser, size, origin, bag);
  const setupMs = Date.now() - setupAt;
  const where = hash || "/index.html#/";
  try {
    const gotoAt = Date.now();
    await session.page.goto(origin + where, { waitUntil: "domcontentloaded" });
    const bootMs = Date.now() - gotoAt;
    await session.page.waitForFunction((args) => {
      if (args.mode === "confirm") return !!document.querySelector('button[data-friend-act="accept"]');
      if (args.mode === "friends") return !!document.querySelector('button[data-friend-act="unfriend"]');
      if (args.mode === "like") {
        const nodes = document.querySelectorAll("article.post");
        for (let i = 0; i < nodes.length; i++) {
          if ((nodes[i].innerText || "").indexOf(args.text) < 0) continue;
          const count = nodes[i].querySelector('button[data-act="like"] .count');
          if (count && String(count.textContent || "").trim() === "2") return true;
        }
        return false;
      }
      if (args.mode === "absent") {
        if (!document.querySelector("article.post")) return false;
        const nodes = document.querySelectorAll("article.post");
        for (let i = 0; i < nodes.length; i++) if ((nodes[i].innerText || "").indexOf(args.text) >= 0) return false;
        return true;
      }
      return (document.body.innerText || "").indexOf(args.text) >= 0;
    }, { text: text, mode: mode || "" }, { timeout: stepWait(20000) });
    const seenAt = Date.now();
    const fetchMs = await session.page.evaluate(() => {
      const entries = performance.getEntriesByType("resource");
      let best = 0;
      for (let i = 0; i < entries.length; i++) {
        const name = entries[i].name || "";
        if (name.indexOf("/v1/posts") < 0 && name.indexOf("/v1/profile/") < 0) continue;
        if (name.indexOf("/like") >= 0 || name.indexOf("/edit") >= 0 || name.indexOf("/delete") >= 0) continue;
        const dur = Math.round(entries[i].duration || 0);
        if (dur > best) best = dur;
      }
      return best;
    }).catch(() => 0);
    return { visibleMs: seenAt - t0, setupMs: setupMs, bootMs: bootMs, paintMs: seenAt - gotoAt - bootMs, fetchMs: fetchMs };
  } finally {
    await session.context.close();
  }
}

function blankAction() {
  return { onScreenMs: null, durableMs: null, visibleMs: null, longMax: null };
}

async function note(row, key, fn) {
  try { row[key] = await fn(); }
  catch (err) {
    process.stderr.write(key + " failed " + (err && err.message) + "\n");
    row[key] = blankAction();
  }
}

async function profileOpen(page, origin) {
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/profile/user_b") >= 0, { timeout: stepWait(20000) }).catch(() => null);
  await page.goto(origin + "/index.html#/@user_b", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => (document.body.innerText || "").indexOf("User B") >= 0, null, { timeout: stepWait(20000) });
  const onScreenMs = Date.now() - t0;
  await ack;
  return { onScreenMs, durableMs: Date.now() - t0, visibleMs: null, longMax: null };
}

async function unfollowOnce(page) {
  await page.waitForSelector('button[data-act="follow"]', { timeout: stepWait(20000) });
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/follows") >= 0 && res.request().method() === "DELETE", { timeout: stepWait(15000) }).catch(() => null);
  const appeared = page.waitForFunction(() => {
    const btn = document.querySelector('button[data-act="follow"]');
    const text = btn && btn.textContent || "";
    return !!btn && /Follow/.test(text) && !/Following|Pending/.test(text);
  }, null, { timeout: stepWait(15000) });
  await page.evaluate(() => { const btn = document.querySelector('button[data-act="follow"]'); if (btn) btn.click(); });
  await appeared;
  const onScreenMs = Date.now() - t0;
  await ack;
  return { onScreenMs, durableMs: Date.now() - t0, visibleMs: null, longMax: null };
}

async function friendRequest(page) {
  await page.waitForSelector('button[data-friend-act="request"]', { timeout: stepWait(20000) });
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/friends/request") >= 0, { timeout: stepWait(15000) }).catch(() => null);
  await page.evaluate(() => { const btn = document.querySelector('button[data-friend-act="request"]'); if (btn) btn.click(); });
  await page.waitForFunction(() => (document.body.innerText || "").indexOf("Request Sent") >= 0, null, { timeout: stepWait(15000) });
  const onScreenMs = Date.now() - t0;
  await ack;
  return { onScreenMs, durableMs: Date.now() - t0, t0 };
}

async function friendAccept(page, origin) {
  /* The request just stored "sent" for a minute. Drop that so this reload
     shows the incoming request the mock now reports. */
  await page.addInitScript(() => {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
      keys.forEach((key) => {
        if (key && (key.indexOf("friend") >= 0 || key.indexOf("graph") >= 0)) localStorage.removeItem(key);
      });
    } catch (err) { /* the next profile read still carries the status */ }
  });
  await page.goto(origin + "/index.html#/@user_b", { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector('button[data-friend-act="accept"]', { timeout: stepWait(20000) });
  } catch (err) {
    const info = await page.evaluate(() => {
      const node = document.querySelector(".friend-btn, .friend-off-note, .friend-btn-group");
      return { html: node ? node.outerHTML.slice(0, 400) : "", text: (document.body.innerText || "").slice(0, 240) };
    }).catch(() => ({}));
    throw new Error((err && err.message) + " " + JSON.stringify(info));
  }
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/friends/accept") >= 0, { timeout: stepWait(15000) }).catch(() => null);
  await page.evaluate(() => { const btn = document.querySelector('button[data-friend-act="accept"]'); if (btn) btn.click(); });
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[data-friend-act="unfriend"]');
    return !!(btn && (btn.textContent || "").indexOf("Friends") >= 0);
  }, null, { timeout: stepWait(15000) });
  const onScreenMs = Date.now() - t0;
  await ack;
  return { onScreenMs, durableMs: Date.now() - t0, t0 };
}

async function likeAppPost(page, text) {
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/posts/like") >= 0, { timeout: stepWait(15000) }).catch(() => null);
  const clicked = await page.evaluate((needle) => {
    const nodes = Array.prototype.slice.call(document.querySelectorAll("article.post"));
    const hits = nodes.filter((node) => (node.innerText || "").indexOf(needle) >= 0);
    hits.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    const host = hits[0];
    const btn = host && host.querySelector('button[data-act="like"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, text);
  if (!clicked) throw new Error("like button was not on the post");
  await page.waitForFunction((needle) => {
    const nodes = document.querySelectorAll("article.post");
    for (let i = 0; i < nodes.length; i++) {
      if ((nodes[i].innerText || "").indexOf(needle) < 0) continue;
      const btn = nodes[i].querySelector('button[data-act="like"]');
      if (btn && btn.classList.contains("on")) return true;
    }
    return false;
  }, text, { timeout: stepWait(15000) });
  const onScreenMs = Date.now() - t0;
  await ack;
  return { onScreenMs, durableMs: Date.now() - t0, t0 };
}

async function photoReply(page, text, file) {
  await page.locator('button[data-act="public-reply"]').locator("visible=true").first().evaluate((el) => el.click());
  const field = page.locator(".xc-modal textarea, #compose-text").first();
  await field.waitFor({ state: "visible", timeout: stepWait(15000) });
  await field.fill(text);
  const loadAt = Date.now();
  await page.locator('input.xc-file[data-kind="image"], input[data-act="xc-file"][data-kind="image"]').first().setInputFiles(file);
  await page.waitForFunction(() => !!document.querySelector(".xc-modal img, .xc-media img, .xc-preview img"), null, { timeout: stepWait(15000) });
  const attachMs = Date.now() - loadAt;
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/posts") >= 0 && res.request().method() === "POST", { timeout: stepWait(20000) }).catch(() => null);
  await page.locator('#compose-post, .xc-modal [data-act="xc-publish"]').locator("visible=true").first().evaluate((el) => el.click());
  await page.waitForFunction((needle) => {
    const nodes = document.querySelectorAll("article.post");
    for (let i = 0; i < nodes.length; i++) {
      const textNow = nodes[i].innerText || "";
      if (textNow.indexOf(needle) >= 0 && nodes[i].querySelector("img")) return true;
    }
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
  return { onScreenMs, durableMs: Date.now() - t0, attachMs, t0 };
}

async function openOwnMenu(page, needle, act) {
  const opened = await page.evaluate((args) => {
    const nodes = Array.prototype.slice.call(document.querySelectorAll("article.post"));
    const hits = nodes.filter((node) => (node.innerText || "").indexOf(args.needle) >= 0);
    hits.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    const btn = hits[0] && hits[0].querySelector('button[data-act="menu"]');
    if (!btn) return false;
    btn.click();
    return true;
  }, { needle: needle });
  if (!opened) throw new Error("post menu was not on the post");
  await page.waitForSelector('.menu.post-menu [data-act="' + act + '"]', { timeout: stepWait(15000) });
  await page.locator('.menu.post-menu [data-act="' + act + '"]').first().evaluate((el) => el.click());
}

async function editPost(page, needle, next) {
  await openOwnMenu(page, needle, "app-edit");
  const field = page.locator("#post-edit-text");
  await field.waitFor({ state: "visible", timeout: stepWait(15000) });
  await field.fill(next);
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/posts/edit") >= 0, { timeout: stepWait(15000) }).catch(() => null);
  await page.locator('[data-act="save-post-edit"]').first().evaluate((el) => el.click());
  await page.waitForFunction((want) => {
    const nodes = document.querySelectorAll("article.post");
    for (let i = 0; i < nodes.length; i++) if ((nodes[i].innerText || "").indexOf(want) >= 0) return true;
    return false;
  }, next, { timeout: stepWait(15000) });
  const onScreenMs = Date.now() - t0;
  await ack;
  return { onScreenMs, durableMs: Date.now() - t0, t0 };
}

async function deletePost(page, needle) {
  await openOwnMenu(page, needle, "app-delete");
  await page.waitForSelector('[data-act="confirm-post-delete"]', { timeout: stepWait(15000) });
  const t0 = Date.now();
  const ack = page.waitForResponse((res) => res.url().indexOf("/v1/posts/delete") >= 0, { timeout: stepWait(15000) }).catch(() => null);
  await page.locator('[data-act="confirm-post-delete"]').first().evaluate((el) => el.click());
  await page.waitForFunction((want) => {
    const nodes = document.querySelectorAll("article.post");
    for (let i = 0; i < nodes.length; i++) if ((nodes[i].innerText || "").indexOf(want) >= 0) return false;
    return true;
  }, needle, { timeout: stepWait(15000) });
  const onScreenMs = Date.now() - t0;
  await ack;
  return { onScreenMs, durableMs: Date.now() - t0, t0 };
}

/* An already-open Home. Null means that tab did not show the change
   within 3s, so nothing pushed it. */
async function watchHome(browser, size, origin, bag) {
  const session = await otherSession(browser, size, origin, bag);
  await session.page.goto(origin + "/index.html#/", { waitUntil: "domcontentloaded" });
  await session.page.waitForFunction(() => document.querySelectorAll("article.post").length >= 3, null, { timeout: stepWait(20000) });
  return session;
}

async function watched(page, text, t0, mode) {
  const hit = await page.waitForFunction((args) => {
    if (args.mode === "absent") {
      const nodes = document.querySelectorAll("article.post");
      if (!nodes.length) return false;
      for (let i = 0; i < nodes.length; i++) if ((nodes[i].innerText || "").indexOf(args.text) >= 0) return false;
      return true;
    }
    return (document.body.innerText || "").indexOf(args.text) >= 0;
  }, { text: text, mode: mode || "" }, { timeout: 3000 }).then(() => Date.now() - t0).catch(() => null);
  return hit;
}

async function oneRun(browser, size, origin, index, bag) {
  stepScale = size.cpu > 1 ? 3 : 1;
  if (bag) {
    bag.friend = "none";
    bag.followed = false;
  }
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
    await note(row, "profile", () => profileOpen(session.page, origin));
    row.follow = await followOnce(session.page, origin);
    await note(row, "unfollow", () => unfollowOnce(session.page));
    await note(row, "friendReq", async () => {
      const asked = await friendRequest(session.page);
      const seen = await otherSees(browser, size, origin, "Confirm", asked.t0, bag, "/index.html#/@user_a", "confirm");
      asked.visibleMs = seen.visibleMs;
      asked.bootMs = seen.bootMs;
      asked.paintMs = seen.paintMs;
      asked.fetchMs = seen.fetchMs;
      return asked;
    });
    if (bag) bag.friend = "received";
    await note(row, "friendOk", async () => {
      const accepted = await friendAccept(session.page, origin);
      const seen = await otherSees(browser, size, origin, "Friends", accepted.t0, bag, "/index.html#/@user_a", "friends");
      accepted.visibleMs = seen.visibleMs;
      accepted.bootMs = seen.bootMs;
      accepted.paintMs = seen.paintMs;
      accepted.fetchMs = seen.fetchMs;
      return accepted;
    });
    await session.page.goto(origin + "/index.html#/", { waitUntil: "domcontentloaded" });
    await session.page.waitForFunction(() => [...document.querySelectorAll('button[data-act="compose"]')].some((el) => el.getBoundingClientRect().width > 8), null, { timeout: stepWait(20000) });
    const postText = "Bench post " + size.name + " " + index;
    const watcher = await watchHome(browser, size, origin, bag);
    let posted;
    let replied;
    try {
      posted = await compose(session.page, postText, false);
      const postOpen = watched(watcher.page, postText, posted.t0, "");
      const postSeen = await otherSees(browser, size, origin, postText, posted.t0, bag);
      posted.openVisibleMs = await postOpen;
      posted.openHit = posted.openVisibleMs == null ? 0 : 1;
      posted.visibleMs = postSeen.visibleMs;
      posted.setupMs = postSeen.setupMs;
      posted.bootMs = postSeen.bootMs;
      posted.paintMs = postSeen.paintMs;
      posted.fetchMs = postSeen.fetchMs;
      row.post = posted;
      const replyText = "Bench reply " + size.name + " " + index;
      replied = await compose(session.page, replyText, true);
      const replyOpen = watched(watcher.page, replyText, replied.t0, "");
      const replySeen = await otherSees(browser, size, origin, replyText, replied.t0, bag);
      replied.openVisibleMs = await replyOpen;
      replied.openHit = replied.openVisibleMs == null ? 0 : 1;
      replied.visibleMs = replySeen.visibleMs;
      replied.setupMs = replySeen.setupMs;
      replied.bootMs = replySeen.bootMs;
      replied.paintMs = replySeen.paintMs;
      replied.fetchMs = replySeen.fetchMs;
      row.reply = replied;
    } finally {
      await watcher.context.close();
    }
    const photoFile = process.env.BENCH_PNG || path.join(os.tmpdir(), "viktorych-bench.png");
    await note(row, "likePost", async () => {
      const liked = await likeAppPost(session.page, postText);
      const seen = await otherSees(browser, size, origin, postText, liked.t0, bag, "", "like");
      liked.visibleMs = seen.visibleMs;
      liked.bootMs = seen.bootMs;
      liked.paintMs = seen.paintMs;
      liked.fetchMs = seen.fetchMs;
      return liked;
    });
    await note(row, "photo", async () => {
      const photoText = "Bench photo " + size.name + " " + index;
      const photo = await photoReply(session.page, photoText, photoFile);
      const seen = await otherSees(browser, size, origin, photoText, photo.t0, bag);
      photo.visibleMs = seen.visibleMs;
      photo.bootMs = seen.bootMs;
      photo.paintMs = seen.paintMs;
      photo.fetchMs = seen.fetchMs;
      return photo;
    });
    const editedText = postText + " edited";
    await note(row, "edit", async () => {
      const edited = await editPost(session.page, postText, editedText);
      const seen = await otherSees(browser, size, origin, editedText, edited.t0, bag);
      edited.visibleMs = seen.visibleMs;
      edited.bootMs = seen.bootMs;
      edited.paintMs = seen.paintMs;
      edited.fetchMs = seen.fetchMs;
      return edited;
    });
    await note(row, "del", async () => {
      const removed = await deletePost(session.page, editedText);
      const seen = await otherSees(browser, size, origin, editedText, removed.t0, bag, "", "absent");
      removed.visibleMs = seen.visibleMs;
      return removed;
    });
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
  ["replyVisible", (row) => row.reply && row.reply.visibleMs],
  ["postOpenVisible", (row) => row.post && row.post.openVisibleMs],
  ["postOpenHit", (row) => row.post && row.post.openHit],
  ["postSetup", (row) => row.post && row.post.setupMs],
  ["postBoot", (row) => row.post && row.post.bootMs],
  ["postPaint", (row) => row.post && row.post.paintMs],
  ["postFetch", (row) => row.post && row.post.fetchMs],
  ["replyOpenVisible", (row) => row.reply && row.reply.openVisibleMs],
  ["replyOpenHit", (row) => row.reply && row.reply.openHit],
  ["replySetup", (row) => row.reply && row.reply.setupMs],
  ["replyBoot", (row) => row.reply && row.reply.bootMs],
  ["replyPaint", (row) => row.reply && row.reply.paintMs],
  ["replyFetch", (row) => row.reply && row.reply.fetchMs],
  ["profileOnScreen", (row) => row.profile && row.profile.onScreenMs],
  ["profileDurable", (row) => row.profile && row.profile.durableMs],
  ["unfollowOnScreen", (row) => row.unfollow && row.unfollow.onScreenMs],
  ["unfollowDurable", (row) => row.unfollow && row.unfollow.durableMs],
  ["friendReqOnScreen", (row) => row.friendReq && row.friendReq.onScreenMs],
  ["friendReqDurable", (row) => row.friendReq && row.friendReq.durableMs],
  ["friendReqVisible", (row) => row.friendReq && row.friendReq.visibleMs],
  ["friendOkOnScreen", (row) => row.friendOk && row.friendOk.onScreenMs],
  ["friendOkDurable", (row) => row.friendOk && row.friendOk.durableMs],
  ["friendOkVisible", (row) => row.friendOk && row.friendOk.visibleMs],
  ["likePostOnScreen", (row) => row.likePost && row.likePost.onScreenMs],
  ["likePostDurable", (row) => row.likePost && row.likePost.durableMs],
  ["likePostVisible", (row) => row.likePost && row.likePost.visibleMs],
  ["photoAttach", (row) => row.photo && row.photo.attachMs],
  ["photoOnScreen", (row) => row.photo && row.photo.onScreenMs],
  ["photoDurable", (row) => row.photo && row.photo.durableMs],
  ["photoVisible", (row) => row.photo && row.photo.visibleMs],
  ["editOnScreen", (row) => row.edit && row.edit.onScreenMs],
  ["editDurable", (row) => row.edit && row.edit.durableMs],
  ["editVisible", (row) => row.edit && row.edit.visibleMs],
  ["deleteOnScreen", (row) => row.del && row.del.onScreenMs],
  ["deleteDurable", (row) => row.del && row.del.durableMs],
  ["deleteVisible", (row) => row.del && row.del.visibleMs]
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
  const altBag = { posts: [], likes: {}, followed: false, catalog: "", friend: "none" };
  const pngFile = path.join(os.tmpdir(), "viktorych-bench.png");
  fs.writeFileSync(pngFile, TINY_PNG);
  process.env.BENCH_PNG = pngFile;
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
