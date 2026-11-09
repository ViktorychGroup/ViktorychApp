/* Opening a post's menu keeps that post on screen, and the menu is what the
   pointer hits. Clicks are dispatched on a button already in the viewport.
   Fixture only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posts = [];
const feeds = [];
for (let i = 0; i < 24; i++) {
  const id = "p" + String(i).padStart(2, "0");
  const long = i === 8 || i === 16;
  feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i });
  posts.push({
    id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post",
    date: new Date(Date.now() - i * 3600000).toISOString(),
    text: long ? ("Long fixture line. ".repeat(40)) : "Fixture line " + i + " for the post menu.",
    author: "Lane " + i, handle: "lane" + i,
    media: i === 12 ? [{ type: "image", url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }] : [],
    stats: { replies: 1, reposts: 0, likes: 2, views: 3 }
  });
}
const catalog = JSON.stringify({ updated: "2026-11-07T00:00:00.000Z", feeds, posts });
const APP_POST = "cd".repeat(16);

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

async function place(page, id, y) {
  const ok = await page.evaluate(({ id, y }) => {
    const btn = document.querySelector('article[data-post="' + id + '"] button[data-act="menu"]');
    if (!btn) return false;
    window.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true }));
    window.scrollTo(0, Math.max(0, window.scrollY + btn.getBoundingClientRect().top - y));
    return true;
  }, { id, y });
  if (!ok) throw new Error("no menu button for " + id);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openMenu(page, id) {
  return page.evaluate((postId) => new Promise((resolve) => {
    const card = document.querySelector('article[data-post="' + postId + '"]');
    const btn = card && card.querySelector('button[data-act="menu"]');
    const beforeBox = btn ? btn.getBoundingClientRect() : null;
    const before = {
      scrollY: Math.round(window.scrollY),
      postTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      btnTop: beforeBox ? Math.round(beforeBox.top) : null,
      btnInView: !!(beforeBox && beforeBox.top >= 0 && beforeBox.bottom <= window.innerHeight)
    };
    if (!btn || !before.btnInView) { resolve({ before, error: "button not in view" }); return; }
    btn.click();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const live = document.querySelector('article[data-post="' + postId + '"]');
      const liveBtn = live && live.querySelector('button[data-act="menu"]');
      const menu = document.querySelector(".menu.post-menu");
      const header = document.querySelector(".topbar");
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      const nav = document.querySelector(".bottom-nav");
      const navTop = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : window.innerHeight;
      let hit = null;
      if (menu && liveBtn) {
        const box = menu.getBoundingClientRect();
        const btnBox = liveBtn.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 2, Math.max(2, box.left + 20));
        const y = Math.min(window.innerHeight - 2, Math.max(2, box.top + 16));
        const node = document.elementFromPoint(x, y);
        const gapBelow = box.top - btnBox.bottom;
        const gapAbove = btnBox.top - box.bottom;
        hit = {
          inMenu: !!(node && (node === menu || menu.contains(node))),
          cls: node && node.className && node.className.baseVal == null ? String(node.className).slice(0, 60) : (node ? node.tagName : ""),
          menuTop: Math.round(box.top),
          menuBottom: Math.round(box.bottom),
          btnTop: Math.round(btnBox.top),
          btnBottom: Math.round(btnBox.bottom),
          nearButton: (gapBelow >= -2 && gapBelow <= 12) || (gapAbove >= -2 && gapAbove <= 12),
          inViewport: box.top >= headerBottom - 1 && box.bottom <= navTop + 1 && box.left >= -1 && box.right <= window.innerWidth + 1,
          headerBottom: Math.round(headerBottom),
          navTop: Math.round(navTop)
        };
      }
      resolve({
        before,
        after: {
          scrollY: Math.round(window.scrollY),
          postTop: live ? Math.round(live.getBoundingClientRect().top) : null,
          btnTop: liveBtn ? Math.round(liveBtn.getBoundingClientRect().top) : null
        },
        hit,
        open: !!menu,
        focusInMenu: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".menu.post-menu"))
      });
    }));
  }), id);
}

async function gestureOpen(page, id, how) {
  const before = await page.evaluate((postId) => {
    const card = document.querySelector('article[data-post="' + postId + '"]');
    const btn = card && card.querySelector('button[data-act="menu"]');
    const box = btn ? btn.getBoundingClientRect() : null;
    return {
      scrollY: Math.round(window.scrollY),
      postTop: card ? Math.round(card.getBoundingClientRect().top) : null,
      btnTop: box ? Math.round(box.top) : null,
      btnInView: !!(box && box.top >= 0 && box.bottom <= window.innerHeight),
      x: box ? box.left + box.width / 2 : 0,
      y: box ? box.top + box.height / 2 : 0
    };
  }, id);
  if (!before.btnInView) return { before, error: "button not in view" };
  if (how === "tap") await page.touchscreen.tap(before.x, before.y);
  else if (how === "mouse") await page.mouse.click(before.x, before.y);
  else {
    await page.evaluate((postId) => {
      const btn = document.querySelector('article[data-post="' + postId + '"] button[data-act="menu"]');
      if (btn) btn.focus({ preventScroll: true });
    }, id);
    await page.keyboard.press(how);
  }
  const settled = await page.evaluate((postId) => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const live = document.querySelector('article[data-post="' + postId + '"]');
      const liveBtn = live && live.querySelector('button[data-act="menu"]');
      const menu = document.querySelector(".menu.post-menu");
      const header = document.querySelector(".topbar");
      const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
      const nav = document.querySelector(".bottom-nav");
      const navTop = nav && getComputedStyle(nav).display !== "none" ? nav.getBoundingClientRect().top : window.innerHeight;
      let hit = null;
      if (menu && liveBtn) {
        const box = menu.getBoundingClientRect();
        const btnBox = liveBtn.getBoundingClientRect();
        const x = Math.min(window.innerWidth - 2, Math.max(2, box.left + 20));
        const y = Math.min(window.innerHeight - 2, Math.max(2, box.top + 16));
        const node = document.elementFromPoint(x, y);
        const gapBelow = box.top - btnBox.bottom;
        const gapAbove = btnBox.top - box.bottom;
        hit = {
          inMenu: !!(node && (node === menu || menu.contains(node))),
          menuTop: Math.round(box.top),
          menuBottom: Math.round(box.bottom),
          nearButton: (gapBelow >= -2 && gapBelow <= 12) || (gapAbove >= -2 && gapAbove <= 12),
          inViewport: box.top >= headerBottom - 1 && box.bottom <= navTop + 1 && box.left >= -1 && box.right <= window.innerWidth + 1
        };
      }
      resolve({
        after: {
          scrollY: Math.round(window.scrollY),
          postTop: live ? Math.round(live.getBoundingClientRect().top) : null,
          btnTop: liveBtn ? Math.round(liveBtn.getBoundingClientRect().top) : null
        },
        hit, open: !!menu
      });
    }));
  }), id);
  return Object.assign({ before }, settled);
}

function check(name, row) {
  if (!row || row.error) throw new Error(name + " " + JSON.stringify(row));
  const postDelta = row.after.postTop - row.before.postTop;
  const btnDelta = row.after.btnTop - row.before.btnTop;
  if (Math.abs(postDelta) > 2 || Math.abs(btnDelta) > 2) throw new Error(name + " jumped " + JSON.stringify(row));
  if (!row.open || !row.hit || !row.hit.inMenu || !row.hit.nearButton || !row.hit.inViewport) throw new Error(name + " menu " + JSON.stringify(row));
  return { postDelta, btnDelta, scrollY: row.after.scrollY, hit: row.hit };
}

async function main() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const proof = [];
  try {
    for (const size of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 800 }]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, serviceWorkers: "block", hasTouch: size.name === "phone" });
      await context.addInitScript(() => {
        localStorage.setItem("superintelapp-lang", "en");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      });
      const page = await context.newPage();
      await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
      await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector('article[data-post="p16"]', { timeout: 15000 });
      await place(page, "p02", 180);
      const top = check(size.name + " top", await openMenu(page, "p02"));
      const rows = await page.evaluate(() => {
        const menu = document.querySelector(".menu.post-menu");
        const items = [...menu.querySelectorAll("button, a")];
        const cs = getComputedStyle(items[0]);
        const text = items[1] ? getComputedStyle(items[1]) : null;
        const mark = items[0].querySelector("svg");
        const markBox = mark ? mark.getBoundingClientRect() : null;
        return {
          h: items.map((el) => Math.round(el.getBoundingClientRect().height)),
          font: cs.fontSize,
          overflow: menu.scrollHeight - menu.clientHeight,
          display: text ? text.display : "",
          pad: text ? text.paddingTop + "/" + text.paddingBottom : "",
          mark: markBox ? Math.round(markBox.height) : 0
        };
      });
      if (size.name === "desktop") {
        if (rows.font !== "15px") throw new Error("desktop menu text changed " + rows.font);
        if (rows.h.some((h) => h > 48 || h < 36)) throw new Error("desktop menu rows " + rows.h.join(","));
        if (rows.overflow > 8) throw new Error("desktop menu still scrolls " + rows.overflow);
      }
      if (size.name === "phone") {
        if (rows.h[0] < 160 || rows.mark < 100) throw new Error("phone menu changed " + rows.h[0] + " mark " + rows.mark);
        if (rows.display !== "block" || rows.font !== "15px" || rows.pad !== "12px/12px") throw new Error("phone menu row style " + JSON.stringify(rows));
        // 12px padding plus the font's line. This Chrome's line is 20px (44).
        // The CI font's line is 17px (41). Both are the unchanged text row.
        if (rows.h[1] < 39 || rows.h[1] > 48) throw new Error("phone menu row " + rows.h[1]);
      }
      await page.keyboard.press("Escape");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const escaped = await page.evaluate(() => ({
        open: !!document.querySelector(".menu.post-menu"),
        back: document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-act") === "menu"
      }));
      if (escaped.open || !escaped.back) throw new Error(size.name + " escape " + JSON.stringify(escaped));
      await place(page, "p08", 240);
      const more = page.locator('article[data-post="p08"] button[data-act="more"]');
      if (await more.count()) {
        await page.evaluate(() => {
          const btn = document.querySelector('article[data-post="p08"] button[data-act="more"]');
          if (btn) btn.click();
        });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      await place(page, "p08", 240);
      const mid = check(size.name + " long", await openMenu(page, "p08"));
      const scrolled = await page.evaluate(() => new Promise((resolve) => {
        const before = document.querySelector('article[data-post="p08"]').getBoundingClientRect().top;
        window.scrollBy(0, 90);
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const card = document.querySelector('article[data-post="p08"]');
          const btn = card.querySelector('button[data-act="menu"]');
          const menu = document.querySelector(".menu.post-menu");
          const box = menu.getBoundingClientRect();
          const btnBox = btn.getBoundingClientRect();
          const node = document.elementFromPoint(box.left + 20, box.top + 16);
          resolve({
            postMoved: Math.round(card.getBoundingClientRect().top - before),
            near: Math.abs(box.top - btnBox.bottom) <= 12 || Math.abs(btnBox.top - box.bottom) <= 12,
            inMenu: !!(node && menu.contains(node))
          });
        }));
      }));
      if (Math.abs(scrolled.postMoved + 90) > 4 || !scrolled.near || !scrolled.inMenu) throw new Error(size.name + " scroll " + JSON.stringify(scrolled));
      await page.evaluate(() => {
        const text = document.querySelector('article[data-post="p08"] .post-text');
        if (text) text.click();
      });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const closed = await page.evaluate(() => !!document.querySelector(".menu.post-menu"));
      if (closed) throw new Error(size.name + " outside click left the menu open");
      await place(page, "p16", size.height - 70);
      const edge = check(size.name + " edge", await openMenu(page, "p16"));
      await page.keyboard.press("Escape");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await place(page, "p12", 260);
      const pointer = check(size.name + " pointer", await gestureOpen(page, "p12", size.name === "phone" ? "tap" : "mouse"));
      await page.keyboard.press("Escape");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const dismissed = await page.evaluate(() => ({
        open: !!document.querySelector(".menu.post-menu"),
        back: document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-act") === "menu"
      }));
      if (dismissed.open || !dismissed.back) throw new Error(size.name + " pointer dismiss " + JSON.stringify(dismissed));
      await place(page, "p12", 260);
      const entered = check(size.name + " enter", await gestureOpen(page, "p12", "Enter"));
      await page.keyboard.press("Escape");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await place(page, "p12", 260);
      const spaced = check(size.name + " space", await gestureOpen(page, "p12", "Space"));
      proof.push({ name: size.name, top, mid, scrolled, edge, pointer, entered, spaced });
      await context.close();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    await context.addInitScript((id) => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
        token: "local-test-token",
        account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
      }));
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
      window.__APP_POST = id;
    }, APP_POST);
    const page = await context.newPage();
    await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
    await page.route("**/v1/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/v1/posts") {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ posts: [{ id: APP_POST, authorId: "100000000001", authorHandle: "user_a", authorName: "User A", body: "App fixture post for the menu.", createdAt: Date.now(), audience: "everyone" }] })
        });
      }
      return route.fulfill({ contentType: "application/json", body: "{\"ok\":true,\"posts\":[]}" });
    });
    await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('article[data-post="' + APP_POST + '"]', { timeout: 15000 });
    await place(page, APP_POST, 200);
    const app = check("app", await openMenu(page, APP_POST));
    proof.push({ name: "app", app });
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log("post menu ok " + JSON.stringify(proof));
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
