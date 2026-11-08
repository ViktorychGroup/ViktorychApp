/* Fixture timing for follow, friend, and reply. Localhost only. Not production.
   firstObservedDomMs is the first animation frame that saw the control or the
   pending reply. It is not a confirmed presentation. ackMs is when the
   response was received. renderInvocations count renderNow entries. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outPath = process.env.BENCH_OUT || "";
const delayMs = Number(process.env.BENCH_DELAY_MS || 0);
const ME = "100000000001";
const OTHER = "200000000002";
const POST = "ab".repeat(16);
const parent = {
  id: POST, authorId: OTHER, authorHandle: "user_b", authorName: "User B",
  body: "Parent fixture", createdAt: Date.parse("2026-11-01T12:00:00Z"), audience: "everyone"
};

function mime(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json";
  return "text/javascript";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file) + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
function median(list) {
  const s = list.filter((n) => typeof n === "number").slice().sort((a, b) => a - b);
  if (!s.length) return null;
  return Number(s[Math.floor(s.length / 2)].toFixed(2));
}
const profile = {
  account: {
    publicId: OTHER, handle: "user_b", displayName: "User B",
    followersCount: 5, followingCount: 1, friendsCount: 4,
    viewerFriendStatus: "received", viewerPending: false, protected: true
  }
};

async function arm(page) {
  const counts = { follow: 0, friend: 0, post: 0 };
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const send = async (status, body) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    };
    if (url.pathname === "/v1/profile/user_b") return send(200, profile);
    if (url.pathname === "/v1/follows" && req.method() === "PUT") {
      counts.follow += 1;
      return send(200, { ok: true, id: "app:" + OTHER, pending: true, followersCount: 5, followingCount: 1 });
    }
    if (url.pathname === "/v1/follows" && req.method() === "DELETE") {
      counts.follow += 1;
      return send(200, { ok: true, id: "app:" + OTHER, pending: false, followersCount: 5, followingCount: 1 });
    }
    if (url.pathname === "/v1/follows" && req.method() === "GET") {
      return send(200, { ids: [], followingCount: 1, followersCount: 1, outgoingRequests: [] });
    }
    if (url.pathname === "/v1/friends/accept") {
      counts.friend += 1;
      return send(200, { ok: true, status: "friends", friendsCount: 1 });
    }
    if (url.pathname === "/v1/posts" && req.method() === "POST") {
      counts.post += 1;
      const raw = req.postData() || "";
      const matched = raw.match(/Reply fixture \d+|Photo reply/);
      const text = matched ? matched[0] : "Reply fixture";
      return send(201, { post: { id: "cd".repeat(16), authorId: ME, authorHandle: "user_a", authorName: "User A", body: text, parentId: POST, createdAt: Date.now(), media: [] } });
    }
    if (url.pathname === "/v1/posts" && req.method() === "GET") return send(200, { posts: [parent], ok: true });
    return send(200, { ok: true, posts: [] });
  });
  return counts;
}

async function prep(context, port) {
  await context.addInitScript((me) => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" }
    }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  }, ME);
}

async function watchClick(page, click, ready, arg) {
  const requests = [];
  const onReq = (req) => {
    const url = req.url();
    if (url.indexOf("/v1/") >= 0) requests.push({ method: req.method(), path: new URL(url).pathname, at: Date.now() });
  };
  page.on("request", onReq);
  const started = Date.now();
  let ackAt = 0;
  const response = page.waitForResponse((res) => ready(res), { timeout: 8000 }).then((res) => {
    ackAt = Date.now();
    return res;
  }).catch(() => null);
  const dom = await page.evaluate(click, arg);
  await response;
  page.off("request", onReq);
  return {
    firstObservedDomMs: dom && dom.domMs,
    ackMs: ackAt ? ackAt - started : null,
    renderInvocations: dom && dom.renders,
    mutations: dom && dom.mutations,
    requests: requests.length,
    detail: dom && dom.detail
  };
}

function stat(samples, key) {
  return { n: samples.length, median: median(samples.map((row) => row[key])), raw: samples.map((row) => row[key]) };
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const sizes = [
    { name: "phone", width: 390, height: 844, cpu: 1, n: 4 },
    { name: "desktop", width: 1280, height: 800, cpu: 1, n: 4 },
    { name: "phone-cpu4x", width: 390, height: 844, cpu: 4, n: 3 }
  ];
  const cases = [];
  try {
    for (const size of sizes) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, serviceWorkers: "block" });
      await prep(context, port);
      const page = await context.newPage();
      if (size.cpu > 1) {
        const client = await context.newCDPSession(page);
        await client.send("Emulation.setCPUThrottlingRate", { rate: size.cpu });
      }
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
        return route.abort();
      });
      await arm(page);
      await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_b", { waitUntil: "domcontentloaded" });
      await page.waitForSelector('button[data-act="follow"]', { timeout: 20000 });
      const follows = [];
      const cancels = [];
      for (let i = 0; i < size.n; i++) {
        const label = await page.locator('button[data-act="follow"]').first().innerText();
        const pending = /Pending|Cancel/.test(label);
        const bucket = pending ? cancels : follows;
        bucket.push(await watchClick(page, () => new Promise((resolve) => {
          const btn = document.querySelector('button[data-act="follow"]');
          const app = document.getElementById("app");
          const before = btn ? btn.textContent : "";
          const renders0 = window.__renderInvocations || 0;
          let mutations = 0;
          const mo = new MutationObserver(() => { mutations += 1; });
          if (app) mo.observe(app, { childList: true });
          const t0 = performance.now();
          btn.click();
          const step = () => {
            const live = document.querySelector('button[data-act="follow"]');
            const text = live ? live.textContent : "";
            if (text !== before || performance.now() - t0 > 900) {
              mo.disconnect();
              resolve({ domMs: text !== before ? Number((performance.now() - t0).toFixed(2)) : null, renders: (window.__renderInvocations || 0) - renders0, mutations, detail: text });
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }), (res) => res.url().indexOf("/v1/follows") >= 0 && res.request().method() === (pending ? "DELETE" : "PUT")));
        await page.waitForTimeout(40);
      }
      const friends = [];
      for (let i = 0; i < Math.min(size.n, 3); i++) {
        if (i) {
          await page.evaluate(() => localStorage.removeItem("friend-req-v1"));
          await page.goto("http://127.0.0.1:" + port + "/index.html#/@user_b", { waitUntil: "domcontentloaded" });
        }
        await page.waitForSelector('button[data-friend-act="accept"]', { timeout: 8000 }).catch(() => {});
        if (!(await page.locator('button[data-friend-act="accept"]').count())) break;
        friends.push(await watchClick(page, () => new Promise((resolve) => {
          const btn = document.querySelector('button[data-friend-act="accept"]');
          const app = document.getElementById("app");
          const renders0 = window.__renderInvocations || 0;
          let mutations = 0;
          const mo = new MutationObserver(() => { mutations += 1; });
          if (app) mo.observe(app, { childList: true });
          const t0 = performance.now();
          btn.click();
          const step = () => {
            const live = document.querySelector('button[data-friend-act="unfriend"], button.friend-mutual');
            if (live || performance.now() - t0 > 900) {
              mo.disconnect();
              resolve({ domMs: live ? Number((performance.now() - t0).toFixed(2)) : null, renders: (window.__renderInvocations || 0) - renders0, mutations, detail: live ? "friends" : "" });
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }), (res) => res.url().indexOf("/v1/friends/accept") >= 0));
      }
      await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("text=Parent fixture", { timeout: 15000 });
      await page.evaluate((id) => { location.hash = "#/app/user_b/status/" + id; }, POST);
      await page.waitForSelector('button[data-act="public-reply"]', { timeout: 15000 });
      const replies = [];
      for (let i = 0; i < size.n; i++) {
        const text = "Reply fixture " + i;
        await page.locator('button[data-act="public-reply"]').first().click();
        await page.locator("#reply-draft").fill(text);
        replies.push(await watchClick(page, (body) => new Promise((resolve) => {
          const btn = document.querySelector('[data-act="xc-publish"][data-slot="reply"]') || document.querySelector('[data-act="xc-publish"]');
          const app = document.getElementById("app");
          const renders0 = window.__renderInvocations || 0;
          let mutations = 0;
          const mo = new MutationObserver(() => { mutations += 1; });
          if (app) mo.observe(app, { childList: true });
          const t0 = performance.now();
          btn.click();
          const step = () => {
            const hit = [...document.querySelectorAll("article")].some((el) => !el.querySelector("#reply-draft") && (el.textContent || "").indexOf(body) >= 0);
            if (hit || performance.now() - t0 > 1500) {
              mo.disconnect();
              resolve({ domMs: hit ? Number((performance.now() - t0).toFixed(2)) : null, renders: (window.__renderInvocations || 0) - renders0, mutations, detail: hit ? "shown" : "missing" });
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }), (res) => res.url().indexOf("/v1/posts") >= 0 && res.request().method() === "POST", text));
        await page.waitForTimeout(100);
      }
      let photo = null;
      const png = "/tmp/relation-pixel.png";
      if (!fs.existsSync(png)) fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
      await page.locator('button[data-act="public-reply"]').first().click();
      await page.locator("#reply-draft").fill("Photo reply");
      const file = page.locator('input[data-xc="file"][data-slot="reply"][data-kind="image"]');
      if (await file.count()) {
        await file.setInputFiles(png);
        photo = await watchClick(page, () => new Promise((resolve) => {
          const btn = document.querySelector('[data-act="xc-publish"][data-slot="reply"]') || document.querySelector('[data-act="xc-publish"]');
          const app = document.getElementById("app");
          const renders0 = window.__renderInvocations || 0;
          const t0 = performance.now();
          btn.click();
          const step = () => {
            const img = document.querySelector("article img[data-local-preview='1']");
            if (img || performance.now() - t0 > 1500) {
              resolve({ domMs: img ? Number((performance.now() - t0).toFixed(2)) : null, renders: (window.__renderInvocations || 0) - renders0, mutations: 0, detail: img ? "preview" : "missing" });
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }), (res) => res.url().indexOf("/v1/posts") >= 0 && res.request().method() === "POST");
      }
      cases.push({
        name: size.name,
        cpuRate: size.cpu,
        delayMs,
        follow: stat(follows, "firstObservedDomMs"),
        followAck: stat(follows, "ackMs"),
        followRenders: stat(follows, "renderInvocations"),
        followRequests: stat(follows, "requests"),
        cancel: stat(cancels, "firstObservedDomMs"),
        cancelAck: stat(cancels, "ackMs"),
        cancelRenders: stat(cancels, "renderInvocations"),
        friend: stat(friends, "firstObservedDomMs"),
        friendAck: stat(friends, "ackMs"),
        friendRenders: stat(friends, "renderInvocations"),
        reply: stat(replies, "firstObservedDomMs"),
        replyAck: stat(replies, "ackMs"),
        replyRenders: stat(replies, "renderInvocations"),
        replyDetail: replies.map((row) => row.detail),
        photo: photo && photo.firstObservedDomMs,
        photoAck: photo && photo.ackMs,
        photoDetail: photo && photo.detail
      });
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  const doc = {
    label: "Synthetic fixture, localhost, not production. firstObservedDomMs watches DOM text from requestAnimationFrame, not a confirmed presentation. ackMs includes BENCH_DELAY_MS.",
    node: process.version,
    delayMs,
    cases
  };
  const text = JSON.stringify(doc, null, 2);
  if (outPath) fs.writeFileSync(outPath, text);
  console.log(text);
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
