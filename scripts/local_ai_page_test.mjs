/* Local AI page: empty state, the prompt box moving down, a multi-setting
   confirm card with Apply and Undo, danger requests as links only, and the
   phone layout. Placeholder data only; no model is downloaded. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function mime(f) {
  if (/\.m?js$/.test(f)) return "text/javascript; charset=utf-8";
  if (f.endsWith(".css")) return "text/css; charset=utf-8";
  if (f.endsWith(".html")) return "text/html; charset=utf-8";
  if (f.endsWith(".svg")) return "image/svg+xml";
  if (f.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": mime(file) });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}
function check(ok, msg) { if (!ok) throw new Error("local ai page: " + msg); }
const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}"));
// Type into the box and send. press() focuses the box first, so a re-render
// between fill and Enter can't swallow the message.
async function say(page, text) {
  await page.fill(".lai-input", text);
  await page.press(".lai-input", "Enter");
}
// Saves can land a moment after the click on a busy runner, so wait for them.
const settled = (page, fn) => page.waitForFunction(fn, null, { timeout: 8000 }).catch(() => {});

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port + "/index.html";
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of [{ name: "desktop", width: 1280, height: 860 }, { name: "phone", width: 390, height: 844, mobile: true }]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.mobile, hasTouch: !!size.mobile, serviceWorkers: "block" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.addInitScript(() => {
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("superintelapp-lang", "en");
        if (!localStorage.getItem("viktorychapp-settings-v1")) localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, lang: "en", aiSetup: { v: 1, done: true, model: "instant", lang: "en", canChange: true, history: "keep" } }));
      });
      await page.route("**/*", (route) => (route.request().url().startsWith("http://127.0.0.1") ? route.continue() : route.abort()));
      await page.goto(origin + "#/ai", { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".lai .lai-bar", { timeout: 20000 });
      const empty = await page.evaluate(() => {
        const bar = document.querySelector(".lai-bar").getBoundingClientRect();
        return { empty: document.querySelector(".lai").classList.contains("is-empty"), chips: document.querySelectorAll(".lai-chip").length, barTop: bar.top, barW: bar.width, h: innerHeight, hero: !!document.querySelector(".lai-hero h1") };
      });
      check(empty.empty && empty.hero && empty.chips >= 4, size.name + " empty state");
      check(empty.barW <= 754, size.name + " box is at most 752px wide");
      if (size.mobile) check(empty.barTop > empty.h * 0.6, "phone box sits at the bottom");
      else check(empty.barTop < empty.h * 0.6, "desktop box is centred");
      await say(page, "make text bigger and stop autoplay on mobile data");
      await page.waitForSelector('[data-lai="apply"]', { timeout: 10000 });
      const card = await page.evaluate(() => ({ rows: [...document.querySelectorAll(".lai-ch-name")].map((a) => a.getAttribute("href")), barTop: document.querySelector(".lai-bar").getBoundingClientRect().top, h: innerHeight, empty: document.querySelector(".lai").classList.contains("is-empty") }));
      check(!card.empty && card.rows.length === 2, size.name + " card lists both changes");
      check(card.barTop > card.h * 0.7, size.name + " box moves to the bottom");
      check((await settings(page)).fontSize === undefined || (await settings(page)).fontSize === 15, "nothing changes before Apply");
      await page.click('[data-lai="apply"]');
      await page.waitForSelector('[data-lai="undo-all"]', { timeout: 10000 });
      await settled(page, () => JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}").fontSize === 16);
      let s = await settings(page);
      check(s.fontSize === 16 && s.autoplay === "wifi", size.name + " Apply saves through the settings path: " + JSON.stringify({ f: s.fontSize, a: s.autoplay }));
      check(await page.evaluate(() => document.documentElement.getAttribute("data-fs") === "16"), "text size applies at once");
      await page.click('[data-lai="undo-all"]');
      await settled(page, () => { const v = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}"); return v.fontSize === 15 && v.autoplay === "all"; });
      s = await settings(page);
      check(s.fontSize === 15 && s.autoplay === "all", size.name + " Undo puts it back");
      await say(page, "delete my account");
      await page.waitForSelector(".lai-open.danger", { timeout: 10000 });
      const danger = await page.evaluate(() => ({ cards: document.querySelectorAll(".lai-msg.ai:last-child .lai-card").length, href: document.querySelector(".lai-open.danger").getAttribute("href") }));
      check(danger.cards === 0 && /^#\/settings/.test(danger.href), "delete account is only a link");
      // Quick settings: a tap on a toggle makes the same confirm card.
      await page.click('.lai-head [data-lai="new"]');
      await page.waitForSelector('.lai.is-empty [data-lai="tab"]', { timeout: 10000 });
      await page.click('[data-lai="tab"][data-cat="media"]');
      await page.waitForSelector('[data-lai="quick"][data-id="autoplay"]', { timeout: 5000 });
      await page.click('[data-lai="quick"][data-id="autoplay"]');
      await page.waitForSelector('[data-lai="apply"]', { timeout: 10000 });
      check((await page.evaluate(() => document.querySelectorAll(".lai-msg.ai:last-child .lai-ch-name").length)) === 1, size.name + " a quick tap lists one change");
      await page.click('[data-lai="apply"]');
      await page.waitForSelector('[data-lai="undo-one"]', { timeout: 10000 });
      await settled(page, () => JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}").autoplay === "wifi");
      check((await settings(page)).autoplay === "wifi", size.name + " a quick tap saves after Apply");
      if (size.mobile) check(await page.evaluate(() => { const n = document.querySelector(".bottom-nav"); return !n || getComputedStyle(n).display === "none"; }), "phone hides the bottom bar on this page");
      check(errors.length === 0, size.name + " page errors: " + errors.join(" | "));
      await context.close();
    }
    console.log("local ai page ok");
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((err) => { console.error(err && err.message ? err.message : err); process.exitCode = 1; });
