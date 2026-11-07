/* A like or bookmark must not rebuild the page. A photo on a new post
   stays on the local preview, and the upload still carries the original bytes.
   Dummy accounts only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ME = "100000000001";
const NEW_ID = "ab".repeat(16);
const posts = [];
const feeds = [];
for (let i = 0; i < 12; i++) {
  const id = "p" + String(i).padStart(2, "0");
  feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i });
  posts.push({
    id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post",
    date: new Date(Date.now() - i * 3600000).toISOString(),
    text: "Fixture line " + i, author: "Lane " + i, handle: "lane" + i, media: [],
    stats: { replies: 0, reposts: 0, likes: 2, views: 1 }
  });
}
const catalog = JSON.stringify({ updated: "2026-11-07T00:00:00.000Z", feeds, posts });

function fail(message) { console.error(message); process.exitCode = 1; throw new Error(message); }
function mime(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".html")) return "text/html";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  return "text/javascript";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(catalog);
    }
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

async function likeBurst(page, label) {
  await page.waitForSelector('button[data-act="like"]', { timeout: 20000 });
  await page.waitForFunction(() => {
    const n = window.__renderInvocations || 0;
    const slot = window.__idleSlot || (window.__idleSlot = { n: n, t: performance.now() });
    if (slot.n !== n) { window.__idleSlot = { n: n, t: performance.now() }; return false; }
    return performance.now() - slot.t > 900;
  }, null, { timeout: 8000 });
  const samples = [];
  for (let i = 0; i < 4; i++) {
    const row = await page.evaluate(() => {
      const btn = document.querySelector('button[data-act="like"]');
      const app = document.getElementById("app");
      let mutations = 0;
      const mo = new MutationObserver(() => { mutations += 1; });
      mo.observe(app, { childList: true });
      const renders0 = window.__renderInvocations || 0;
      btn.click();
      return new Promise((resolve) => {
        setTimeout(() => {
          mo.disconnect();
          const live = document.querySelector('button[data-act="like"]');
          const count = live && live.querySelector(".count");
          resolve({ mutations, renders: (window.__renderInvocations || 0) - renders0, hash: location.hash, same: live === btn, on: !!(live && live.classList.contains("on")), count: count ? count.textContent : "" });
        }, 1000);
      });
    });
    samples.push(row);
  }
  const rebuilt = samples.reduce((sum, row) => sum + (row.renders || 0), 0);
  if (rebuilt > 0) fail(label + " likes rebuilt the page " + rebuilt + " " + JSON.stringify(samples));
  if (!samples[0].on || samples[0].count !== "3") fail(label + " like did not count " + JSON.stringify(samples[0]));
  if (samples[1].on || samples[1].count !== "2") fail(label + " unlike did not restore the count " + JSON.stringify(samples[1]));
  if (samples[3].on || samples[3].count !== "2") fail(label + " a burst of likes ended on " + JSON.stringify(samples));
  const bookmark = await page.evaluate(() => {
    const btn = document.querySelector('button[data-act="bookmark"]');
    const renders0 = window.__renderInvocations || 0;
    btn.click();
    return new Promise((resolve) => {
      setTimeout(() => {
        const live = document.querySelector('button[data-act="bookmark"]');
        resolve({ renders: (window.__renderInvocations || 0) - renders0, on: !!(live && live.classList.contains("on")) });
      }, 1000);
    });
  });
  if (bookmark.renders !== 0 || !bookmark.on) fail(label + " bookmark rebuilt or missed " + JSON.stringify(bookmark));
}

async function followAndFriend(page, label) {
  let follows = 0;
  let profiles = 0;
  let pending = false;
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/v1/profile/user_b") {
      profiles += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          account: {
            publicId: "200000000002", handle: "user_b", displayName: "User B",
            followersCount: 5, followingCount: 1, friendsCount: 4,
            viewerFriendStatus: "received", viewerPending: false
          },
          reposts: []
        })
      });
      return;
    }
    if (url.pathname === "/v1/follows" && req.method() === "PUT") {
      follows += 1;
      pending = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, id: "app:200000000002", pending: true, followersCount: 5, followingCount: 1 }) });
      return;
    }
    if (url.pathname === "/v1/follows" && req.method() === "DELETE") {
      follows += 1;
      pending = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, id: "app:200000000002", pending: false, followersCount: 5, followingCount: 1 }) });
      return;
    }
    if (url.pathname === "/v1/follows" && req.method() === "GET") {
      follows += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ids: [], followingCount: 1, followersCount: 1, outgoingRequests: pending ? ["app:200000000002"] : [] }) });
      return;
    }
    if (url.pathname === "/v1/friends/accept" && req.method() === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "friends", friendsCount: 1 }) });
      return;
    }
    if (url.pathname === "/v1/friends/remove" && req.method() === "POST") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, status: "none", friendsCount: 1 }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"ok":true}' });
  });
  await page.goto(page.url().split("#")[0] + "#/@user_b", { waitUntil: "domcontentloaded" });
  const follow = page.locator('button[data-act="follow"][data-id="app:200000000002"]').first();
  await follow.waitFor({ timeout: 15000 });
  const beforeProfiles = profiles;
  await follow.click();
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[data-act="follow"][data-id="app:200000000002"]');
    return btn && btn.getAttribute("aria-label") === "Pending" && btn.textContent.indexOf("Cancel request") >= 0;
  }, null, { timeout: 8000 });
  const dup = await page.evaluate(() => {
    const btn = document.querySelector('button[data-act="follow"][data-id="app:200000000002"]');
    const copy = btn.cloneNode(true);
    btn.parentElement.appendChild(copy);
    return true;
  });
  if (!dup) fail(label + " could not duplicate the follow button");
  await page.locator('button.follow.pending').first().click();
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll('button[data-act="follow"][data-id="app:200000000002"]')];
    return buttons.length >= 2 && buttons.every((btn) => btn.textContent.indexOf("Pending") < 0 && btn.textContent.indexOf("Cancel request") < 0 && btn.getAttribute("aria-label") !== "Pending" && btn.textContent.indexOf("Follow") >= 0);
  }, null, { timeout: 8000 });
  if (profiles !== beforeProfiles) fail(label + " cancelling a follow reloaded profiles");
  const friendCount = page.locator('.counts a[href*="tab=friends"] b').first();
  await friendCount.waitFor({ timeout: 5000 });
  if ((await friendCount.textContent()) !== "4") fail(label + " friend count did not start at 4");
  await page.evaluate(() => {
    const host = document.querySelector(".counts") || document.body;
    host.insertAdjacentHTML("beforeend", '<div class="counts">'
      + '<a href="#/@user_b?tab=friends"><b>4</b> <span>Friends</span></a>'
      + '<a href="#/@user_b2?tab=friends"><b>9</b> <span>Friends</span></a>'
      + '<a href="#/@user_a?tab=friends"><b>0</b> <span>Friends</span></a>'
      + "</div>");
  });
  const renders0 = await page.evaluate(() => window.__renderInvocations || 0);
  await page.locator('button[data-friend-act="accept"]').click();
  await page.waitForFunction(() => {
    const bold = document.querySelector('.counts a[href*="tab=friends"] b');
    const btn = document.querySelector('button[data-friend-act="unfriend"], button.friend-mutual');
    return bold && bold.textContent === "5" && btn;
  }, null, { timeout: 8000 });
  const renders1 = await page.evaluate(() => window.__renderInvocations || 0);
  if (renders1 - renders0 > 2) fail(label + " accepting a friend rebuilt too often " + (renders1 - renders0));
  const counts = await page.evaluate(() => ({
    b: [...document.querySelectorAll('.counts a[href="#/@user_b?tab=friends"] b')].map((el) => el.textContent),
    b2: [...document.querySelectorAll('.counts a[href="#/@user_b2?tab=friends"] b')].map((el) => el.textContent),
    self: [...document.querySelectorAll('.counts a[href="#/@user_a?tab=friends"] b')].map((el) => el.textContent)
  }));
  if (counts.b.length < 2 || counts.b.some((text) => text !== "5")) fail(label + " user_b counts " + JSON.stringify(counts));
  if (counts.b2.some((text) => text !== "9")) fail(label + " user_b2 was changed " + JSON.stringify(counts));
  if (counts.self.some((text) => text !== "1")) fail(label + " own friends count " + JSON.stringify(counts));
  await page.locator('button[data-friend-act="unfriend"]').click();
  await page.locator('button[data-friend-act="unfriend-confirm"]').click();
  await page.waitForFunction(() => {
    const bold = document.querySelector('.counts a[href*="tab=friends"] b');
    return bold && bold.textContent === "4";
  }, null, { timeout: 8000 });
}

async function photo(page, label) {
  await page.goto(page.url().split("#")[0] + "#/", { waitUntil: "domcontentloaded" });
  const pngPath = "/tmp/action-speed-pixel.png";
  fs.writeFileSync(pngPath, PNG);
  const seen = [];
  let saved = null;
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname.indexOf("/v1/posts/media/") === 0) seen.push(url.pathname);
    if (url.pathname === "/v1/posts" && req.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: saved ? [saved] : [], ok: true }) });
      return;
    }
    if (url.pathname === "/v1/posts" && req.method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          post: {
            id: NEW_ID, body: "Photo note", createdAt: Date.now(), authorId: ME,
            authorHandle: "user_a", authorName: "User A",
            media: [{ id: "cd".repeat(16), mime: "image/png", url: "/v1/posts/media/" + "cd".repeat(16), alt: "", size: PNG.length }]
          }
        })
      });
      saved = JSON.parse(JSON.stringify({
        id: NEW_ID, body: "Photo note", createdAt: Date.now(), authorId: "100000000001",
        authorHandle: "user_a", authorName: "User A",
        media: [{ id: "cd".repeat(16), mime: "image/png", url: "/v1/posts/media/" + "cd".repeat(16), alt: "", size: PNG.length }]
      }));
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"ok":true}' });
  });
  const opener = label === "phone" ? "button.fab" : "button.post-btn";
  await page.locator(opener).first().click();
  await page.locator(".xc-modal #compose-text").fill("Photo note");
  await page.locator('.xc-modal input.xc-file[data-kind="image"]').first().setInputFiles(pngPath);
  await page.locator(".xc-modal .xc-media").waitFor({ timeout: 5000 });
  await page.locator(".xc-modal #compose-post").click();
  await page.waitForFunction(() => {
    const img = document.querySelector("article img[data-local-preview]");
    return img && String(img.getAttribute("src") || "").indexOf("blob:") === 0;
  }, null, { timeout: 8000 });
  await page.evaluate(() => { location.hash = "#/home/following"; });
  await page.waitForTimeout(250);
  await page.evaluate(() => { location.hash = "#/"; });
  await page.waitForFunction((id) => {
    const img = document.querySelector('article[data-post="' + id + '"] img[data-local-preview]');
    return img && String(img.getAttribute("src") || "").indexOf("blob:") === 0;
  }, NEW_ID, { timeout: 8000 });
  if (seen.length) fail(label + " refetched the saved photo " + seen.join(" "));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((id) => {
    const img = document.querySelector('article[data-post="' + id + '"] img[data-public-media]');
    return !!img;
  }, NEW_ID, { timeout: 8000 });
  if (!seen.length) fail(label + " a reload did not load the stored photo");
}

async function blobRevoked(page, src) {
  return page.evaluate((url) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(false);
    img.onerror = () => resolve(true);
    img.src = url;
  }), src);
}

async function mediaLife(page, label) {
  const opener = label === "phone" ? "button.fab" : "button.post-btn";
  let mode = "scheduled";
  let holdGate = null;
  const otherId = "300000000099";
  await page.route("**/v1/posts", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    if (mode === "hold" && holdGate) await holdGate;
    const failed = mode === "fail" || mode === "scheduled-fail";
    await route.fulfill({
      status: failed ? 500 : 201,
      contentType: "application/json",
      body: JSON.stringify(failed ? { error: "no" } : {
        post: {
          id: otherId, body: "", createdAt: Date.now(), authorId: ME,
          authorHandle: "user_a", authorName: "User A", media: []
        },
        scheduled: mode === "scheduled"
      })
    });
  });
  async function openComposer() {
    await page.goto(page.url().split("#")[0] + "#/", { waitUntil: "domcontentloaded" });
    await page.locator(opener).first().click();
    await page.locator(".xc-modal #compose-text").waitFor({ timeout: 8000 });
    await page.locator('.xc-modal input.xc-file[data-kind="image"]').first().setInputFiles("/tmp/action-speed-pixel.png");
    await page.locator(".xc-modal .xc-media").waitFor({ timeout: 5000 });
    return page.locator(".xc-modal .xc-media img").first().getAttribute("src");
  }
  async function schedule() {
    await page.locator('.xc-modal [data-act="xc-schedule"]').click();
    await page.locator('.xc-modal input[data-xc="schedule"]').fill("2026-12-01T12:00");
  }
  async function send(expect) {
    await page.evaluate(() => {
      const el = document.getElementById("toast");
      if (el) { el.textContent = ""; el.hidden = true; }
    });
    const before = "";
    await page.locator(".xc-modal #compose-post").click();
    await page.waitForFunction((prev) => {
      const el = document.getElementById("toast");
      return !!(el && !el.hidden && el.textContent && el.textContent !== prev);
    }, before, { timeout: 8000 });
    const text = await page.locator("#toast").textContent();
    if (text.indexOf(expect) < 0) fail(label + " toast " + JSON.stringify(text) + " wanted " + expect);
  }
  mode = "scheduled";
  let src = await openComposer();
  await schedule();
  await send("Scheduled");
  if (!(await blobRevoked(page, src))) fail(label + " scheduled success kept the preview");
  if (await page.locator("img[data-local-preview]").count()) fail(label + " scheduled success showed a local card");

  mode = "scheduled-fail";
  src = await openComposer();
  await schedule();
  await send("Could not send");
  if (!(await blobRevoked(page, src))) fail(label + " scheduled failure kept the preview");

  mode = "fail";
  src = await openComposer();
  await send("Could not send");
  if (!(await blobRevoked(page, src))) fail(label + " failed post kept the preview");
  if (await page.locator("img[data-local-preview]").count()) fail(label + " failed post left a local card");

  src = await openComposer();
  await page.context().setOffline(true);
  try {
    await send("Could not send");
  } finally {
    await page.context().setOffline(false);
  }
  if (!(await blobRevoked(page, src))) fail(label + " offline post kept the preview");

  src = await openComposer();
  await schedule();
  await page.context().setOffline(true);
  try {
    await send("Otherwise it stays on this device");
  } finally {
    await page.context().setOffline(false);
  }
  if (!(await blobRevoked(page, src))) fail(label + " scheduled offline kept the preview");

  mode = "hold";
  let go = null;
  holdGate = new Promise((resolve) => { go = resolve; });
  src = await openComposer();
  const pending = page.waitForResponse((res) => res.url().indexOf("/v1/posts") >= 0 && res.request().method() === "POST");
  await page.locator(".xc-modal #compose-post").click();
  await page.waitForSelector("img[data-local-preview]", { timeout: 8000 });
  await page.evaluate(() => {
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "other-token",
      account: { publicId: "200000000009", handle: "user_c", displayName: "User C", avatar: "" }
    }));
  });
  go();
  await pending;
  await page.waitForFunction((id) => !document.querySelector('img[data-local-preview], article[data-post="' + id + '"]'), otherId, { timeout: 8000 });
  if (!(await blobRevoked(page, src))) fail(label + " a switched account kept the other account's preview");
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport: size, serviceWorkers: "block" });
      const page = await context.newPage();
      page.on("pageerror", (err) => fail(size.name + " " + err.message));
      await page.addInitScript(() => {
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        const follows = [];
        for (let i = 0; i < 12; i++) follows.push("lane" + i);
        localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows, lists: [], feedTabs: [], likes: {}, bookmarks: {}, reposts: {} }));
      });
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
        return route.abort();
      });
      await page.goto("http://127.0.0.1:" + port + "/index.html#/following", { waitUntil: "domcontentloaded" });
      await likeBurst(page, size.name);
      await context.close();
      const signed = await browser.newContext({ viewport: size, serviceWorkers: "block" });
      const composer = await signed.newPage();
      composer.on("pageerror", (err) => fail(size.name + " " + err.message));
      await composer.addInitScript((me) => {
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
          token: "local-test-token",
          account: { publicId: me, handle: "user_a", displayName: "User A", avatar: "" }
        }));
        window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
      }, ME);
      await composer.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("http://127.0.0.1:" + port)) return route.continue();
        return route.abort();
      });
      await composer.goto("http://127.0.0.1:" + port + "/index.html#/@user_b", { waitUntil: "domcontentloaded" });
      await followAndFriend(composer, size.name);
      await photo(composer, size.name);
      await mediaLife(composer, size.name);
      await signed.close();
    }
    console.log("action speed ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
