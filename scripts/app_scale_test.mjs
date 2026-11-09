/* App size is a scale of this page, not the browser's zoom. The window
   guess is simulated: a real Windows maximize is not available here. */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { windowGuess, scaleChoice, desktopGate } = require("../desktop-app.js");

const HD = { outerW: 1920, outerH: 1040, availW: 1920, availH: 1040 };
const pref = { mode: "window", manual: 100, maximized: 150, windowed: 120 };

test("a 1080p work area that the window fills counts as maximized", () => {
  assert.equal(windowGuess(HD), "maximized");
  assert.equal(scaleChoice(pref, "maximized", true), 150);
});

test("a smaller restored window uses the window size", () => {
  assert.equal(windowGuess({ outerW: 1400, outerH: 900, availW: 1920, availH: 1040 }), "window");
  assert.equal(scaleChoice(pref, "window", true), 120);
});

test("a gap that is neither clearly maximized nor clearly restored stays put", () => {
  assert.equal(windowGuess({ outerW: 1880, outerH: 1040, availW: 1920, availH: 1040 }), "unknown");
  assert.equal(scaleChoice(pref, "unknown", true), null);
});

test("full screen is not treated as a maximized window with a toolbar", () => {
  assert.equal(windowGuess(Object.assign({}, HD, { fullscreen: true })), "fullscreen");
  assert.equal(windowGuess(Object.assign({}, HD, { fullDisplay: true })), "fullscreen");
  assert.equal(scaleChoice(pref, "fullscreen", true), null);
});

test("half a screen is a window, not maximized", () => {
  assert.equal(windowGuess({ outerW: 960, outerH: 1040, availW: 1920, availH: 1040 }), "window");
});

test("off, manual and a phone stay predictable", () => {
  assert.equal(scaleChoice({ mode: "off" }, "maximized", true), 100);
  assert.equal(scaleChoice({ mode: "manual", manual: 130 }, "maximized", true), 130);
  assert.equal(scaleChoice(pref, "maximized", false), 100);
  assert.equal(scaleChoice({ mode: "manual", manual: 97 }, "window", true), 100);
  assert.equal(scaleChoice({ mode: "manual", manual: 250 }, "window", true), 200);
});

test("missing screen numbers are not a maximize", () => {
  assert.equal(windowGuess({ outerW: 0, outerH: 0, availW: 1920, availH: 1040 }), "unknown");
});

test("a 600px window stays narrow at a 200% page scale", () => {
  assert.equal(desktopGate(600), false);
  assert.equal(desktopGate(1280), true);
});

async function browserScale() {
  const http = await import("node:http");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const posts = [];
  const feeds = [];
  for (let i = 0; i < 8; i++) {
    const id = "p0" + i;
    feeds.push({ id: "lane" + i, platform: "rss", handle: "lane" + i, name: "Lane " + i });
    posts.push({ id, statusId: id, platform: "rss", feedId: "lane" + i, kind: "post", date: new Date().toISOString(), text: "Fixture line " + i, author: "Lane " + i, handle: "lane" + i, media: [], stats: { replies: 0, reposts: 0, likes: 0, views: 0 } });
  }
  const catalog = JSON.stringify({ updated: "2026-11-07T00:00:00.000Z", feeds, posts });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/feeds.json") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(catalog);
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      const type = file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "text/javascript";
      res.writeHead(200, { "content-type": type + "; charset=utf-8" });
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const spec = process.env.PLAYWRIGHT_CORE;
  const mod = await import(pathToFileURL(spec).href);
  const browser = await (mod.chromium || mod.default.chromium).launch({ headless: true, channel: "chrome" });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    await context.addInitScript(() => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorych-desktop-v1", JSON.stringify({ scale: { mode: "manual", manual: 150, maximized: 150, windowed: 120 } }));
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
    await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('article[data-post="p00"] button[data-act="menu"]', { timeout: 15000 });
    const scaled = await page.evaluate(() => ({
      zoom: document.documentElement.style.zoom,
      inner: window.innerWidth,
      guess: window.ViktorychDesktop && window.ViktorychDesktop.windowGuess ? window.ViktorychDesktop.windowGuess() : ""
    }));
    if (scaled.zoom !== "1.5") throw new Error("manual 150 did not scale the page " + JSON.stringify(scaled));
    await page.locator('article[data-post="p00"] button[data-act="menu"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".menu.post-menu", { timeout: 2000 });
    // A key can still deliver its click after press() resolves. The menu has
    // to still be open, on the button, once that click has landed.
    await page.waitForTimeout(80);
    const keyed = await page.evaluate(() => {
      const menu = document.querySelector(".menu.post-menu");
      const btn = document.querySelector('article[data-post="p00"] button[data-act="menu"]');
      if (!menu || !btn) return { missing: !menu ? "menu" : "button" };
      const box = menu.getBoundingClientRect();
      const btnBox = btn.getBoundingClientRect();
      const near = Math.abs(box.top - btnBox.bottom) <= 20 || Math.abs(btnBox.top - box.bottom) <= 20;
      return {
        near,
        menuTop: Math.round(box.top),
        menuBottom: Math.round(box.bottom),
        btnTop: Math.round(btnBox.top),
        btnBottom: Math.round(btnBox.bottom),
        zoom: document.documentElement.style.zoom || ""
      };
    });
    if (!keyed || !keyed.near) throw new Error("keyboard did not keep the scaled menu on its button " + JSON.stringify(keyed));
    await page.evaluate(() => window.scrollTo(0, 120));
    const beforeScroll = await page.evaluate(() => window.scrollY);
    await page.evaluate(() => window.scrollBy(0, 240));
    await page.waitForTimeout(200);
    const afterScroll = await page.evaluate(() => {
      const menu = document.querySelector(".menu.post-menu");
      const btn = document.querySelector('article[data-post="p00"] button[data-act="menu"]');
      const box = menu.getBoundingClientRect();
      const btnBox = btn.getBoundingClientRect();
      return { y: window.scrollY, near: Math.abs(box.top - btnBox.bottom) <= 24 || Math.abs(btnBox.top - box.bottom) <= 24 };
    });
    if (afterScroll.y <= beforeScroll + 40 || !afterScroll.near) throw new Error("scroll under scale " + JSON.stringify({ beforeScroll, afterScroll }));
    await page.keyboard.press("Escape");
    async function assignAt(scale) {
      await page.evaluate((value) => {
        const raw = JSON.parse(localStorage.getItem("viktorych-desktop-v1") || "{}");
        raw.scale.mode = "manual";
        raw.scale.manual = value;
        localStorage.setItem("viktorych-desktop-v1", JSON.stringify(raw));
        window.ViktorychDesktop.applyScale();
      }, scale);
      await page.evaluate(() => {
        const article = document.querySelector('article[data-post="p00"]');
        article.scrollIntoView({ block: "center" });
      });
      const point = await page.evaluate(() => {
        const article = document.querySelector('article[data-post="p00"]');
        const box = article.getBoundingClientRect();
        for (let y = box.top + 8; y < box.bottom - 8; y += 8) {
          for (let x = box.left + 8; x < Math.min(box.right - 8, box.left + 220); x += 12) {
            const node = document.elementFromPoint(x, y);
            if (!node || !article.contains(node)) continue;
            if (node.closest("a, button, input, textarea, video, .menu")) continue;
            return { x: Math.round(x), y: Math.round(y) };
          }
        }
        return null;
      });
      if (!point) throw new Error("no right-click target on the post");
      await page.mouse.click(point.x, point.y, { button: "right" });
      await page.waitForSelector(".assign-menu", { timeout: 5000 });
      const hit = await page.evaluate((at) => {
        const menu = document.querySelector(".assign-menu");
        const box = menu.getBoundingClientRect();
        const sample = { x: box.left + 24, y: box.top + 24 };
        const node = document.elementFromPoint(sample.x, sample.y);
        return {
          left: Math.round(box.left), top: Math.round(box.top),
          dx: Math.abs(box.left - at.x), dy: Math.abs(box.top - at.y),
          nearHit: Math.abs(sample.x - at.x) <= 48 && Math.abs(sample.y - at.y) <= 48,
          inside: !!(node && menu.contains(node))
        };
      }, point);
      if (hit.dx > 24 || hit.dy > 24 || !hit.nearHit || !hit.inside) throw new Error("scale " + scale + " assign menu " + JSON.stringify({ point, hit }));
      await page.keyboard.press("Escape");
    }
    await assignAt(150);
    await assignAt(200);
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("viktorych-desktop-v1") || "{}");
      raw.scale.mode = "off";
      localStorage.setItem("viktorych-desktop-v1", JSON.stringify(raw));
      window.ViktorychDesktop.applyScale();
    });
    const off = await page.evaluate(() => document.documentElement.style.zoom || "");
    if (off) throw new Error("off still scales " + off);
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("viktorych-desktop-v1") || "{}");
      raw.scale.mode = "manual";
      raw.scale.manual = 200;
      localStorage.setItem("viktorych-desktop-v1", JSON.stringify(raw));
      window.ViktorychDesktop.applyScale();
    });
    await page.setViewportSize({ width: 600, height: 800 });
    await page.waitForTimeout(400);
    const narrowZoom = await page.evaluate(() => document.documentElement.style.zoom || "");
    await page.waitForTimeout(300);
    const narrowAgain = await page.evaluate(() => ({ zoom: document.documentElement.style.zoom || "", width: window.innerWidth }));
    if (narrowZoom || narrowAgain.zoom || narrowAgain.width >= 1000) throw new Error("narrow window kept the scale " + JSON.stringify({ narrowZoom, narrowAgain }));
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(400);
    const wide = await page.evaluate(() => document.documentElement.style.zoom || "");
    if (wide !== "2") throw new Error("wide window did not restore 200% " + wide);
    async function mentionAt(scale) {
      await page.evaluate((value) => {
        window.scrollTo(0, 0);
        const raw = JSON.parse(localStorage.getItem("viktorych-desktop-v1") || "{}");
        raw.scale.mode = "manual";
        raw.scale.manual = value;
        localStorage.setItem("viktorych-desktop-v1", JSON.stringify(raw));
        window.ViktorychDesktop.applyScale();
        window.ViktorychMentionsLocal = {
          search: function (q) {
            var query = String(q || "").toLowerCase();
            if (query.indexOf("lane") !== 0) return [];
            return [{ handle: "laneone", name: "Lane One", avatar: "" }];
          }
        };
      }, scale);
      if (!(await page.locator("#compose-text").count())) {
        await page.locator('button.post-btn[data-act="compose"]').first().click();
        await page.waitForSelector("#compose-text", { timeout: 8000 });
      }
      const hit = await page.evaluate(() => {
        const el = document.getElementById("compose-text");
        el.style.setProperty("min-height", "48px", "important");
        el.style.setProperty("height", "48px", "important");
        el.style.setProperty("max-height", "48px", "important");
        el.style.overflowY = "scroll";
        el.value = "one\ntwo\nthree\nfour\nfive hello @lane";
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        el.scrollTop = 48;
        if (window.ViktorychMentionSuggest) window.ViktorychMentionSuggest.close();
        el.dispatchEvent(new Event("input", { bubbles: true }));
        const pop = document.querySelector(".mention-pop:not([hidden])");
        if (!pop) return { missing: true, scrollTop: el.scrollTop };
        const z = parseFloat(document.documentElement.style.zoom) || 1;
        const style = getComputedStyle(el);
        const copy = document.createElement("div");
        ["boxSizing", "width", "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "textTransform", "wordSpacing", "tabSize"].forEach((key) => { copy.style[key] = style[key]; });
        copy.style.position = "absolute";
        copy.style.visibility = "hidden";
        copy.style.whiteSpace = "pre-wrap";
        copy.style.wordWrap = "break-word";
        copy.style.top = "0";
        copy.style.left = "-9999px";
        const at = el.value.lastIndexOf("@");
        copy.textContent = el.value.slice(0, at);
        const mark = document.createElement("span");
        mark.textContent = "\u200b";
        copy.appendChild(mark);
        document.body.appendChild(copy);
        const line = parseFloat(style.lineHeight) || 24;
        const box = el.getBoundingClientRect();
        const expectedLeft = box.left / z + mark.offsetLeft - el.scrollLeft;
        const expectedTop = box.top / z + mark.offsetTop - el.scrollTop + line + 4;
        const halvedLeft = (box.left + mark.offsetLeft - el.scrollLeft) / z;
        const halvedTop = (box.top + mark.offsetTop - el.scrollTop + line) / z + 4;
        const out = {
          z, scrollTop: el.scrollTop, offsetLeft: mark.offsetLeft, offsetTop: mark.offsetTop, line,
          inner: window.innerWidth, scrollX: window.scrollX, scrollY: window.scrollY,
          styleLeft: pop.style.left, styleTop: pop.style.top,
          expectedLeft, expectedTop, halvedLeft, halvedTop,
          gotLeft: parseFloat(pop.style.left) - window.scrollX,
          gotTop: parseFloat(pop.style.top) - window.scrollY
        };
        copy.remove();
        return out;
      });
      if (!hit || hit.missing) throw new Error("mention list did not open " + JSON.stringify(hit));
      if (hit.scrollTop < 8 || hit.offsetTop < hit.line * 2 || hit.offsetLeft < 40) throw new Error("mention fixture did not scroll a multiline caret " + JSON.stringify(hit));
      if (Math.abs(hit.gotLeft - hit.expectedLeft) > 2 || Math.abs(hit.gotTop - hit.expectedTop) > 2) throw new Error("scale " + scale + " mention caret " + JSON.stringify(hit));
      if (Math.abs(hit.expectedLeft - hit.halvedLeft) < 8 || Math.abs(hit.gotLeft - hit.halvedLeft) < 8) throw new Error("scale " + scale + " mention still halves the caret offset " + JSON.stringify(hit));
    }
    await mentionAt(200);
    await mentionAt(150);
    await context.close();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", hasTouch: true });
    await phone.addInitScript(() => {
      localStorage.setItem("superintelapp-lang", "en");
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      localStorage.setItem("viktorych-desktop-v1", JSON.stringify({ scale: { mode: "window", manual: 100, maximized: 150, windowed: 120 } }));
    });
    const narrow = await phone.newPage();
    await narrow.route("**/*", (route) => route.request().url().startsWith("http://127.0.0.1:" + port) ? route.continue() : route.abort());
    await narrow.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await narrow.waitForTimeout(300);
    const phoneZoom = await narrow.evaluate(() => document.documentElement.style.zoom || "");
    if (phoneZoom) throw new Error("phone was scaled " + phoneZoom);
    await phone.close();
    console.log("app scale browser ok " + JSON.stringify(scaled));
  } finally {
    await browser.close();
    server.close();
  }
}

test("browser: scaled pointer menus, mention caret, keyboard, scroll, off, and a narrow window", browserScale);
