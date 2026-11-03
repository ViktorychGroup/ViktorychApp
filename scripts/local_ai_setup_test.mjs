/* Local AI first-run setup: a first visit is forced into setup and the chat
   stays locked, finishing it unlocks the chat, a returning visit skips it,
   Skip only picks Instant, a new device with a synced model only downloads
   and tests, and ?setup=1 runs it again. No model is downloaded. */
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
function check(ok, msg) { if (!ok) throw new Error("local ai setup: " + msg); }
const settings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}"));
// Type into the box and send. press() focuses the box first, so a re-render
// between fill and Enter can't swallow the message.
async function say(page, text) {
  await page.fill(".lai-input", text);
  await page.press(".lai-input", "Enter");
}
// Saves can land a moment after the click on a busy runner, so wait for them.
const settled = (page, fn) => page.waitForFunction(fn, null, { timeout: 8000 }).catch(() => {});

const step = (page) => page.getAttribute(".lai-su", "data-step");
const chatOpen = (page) => page.evaluate(() => {
  const lai = document.querySelector(".lai");
  const box = document.querySelector(".lai-input");
  return !!lai && !lai.classList.contains("is-setup") && !!box && getComputedStyle(box).visibility !== "hidden" && box.getBoundingClientRect().width > 0;
});
const SEEN = { version: 1, initialized: true, lang: "en" };

async function open(browser, origin, size, seed) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: !!size.mobile, hasTouch: !!size.mobile, serviceWorkers: "block" });
  await context.addInitScript((s) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify(s.settings));
    if (s.have) localStorage.setItem("viktorych-local-ai-have", JSON.stringify(s.have));
  }, seed);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/*", (route) => (route.request().url().startsWith("http://127.0.0.1") ? route.continue() : route.abort()));
  return { context, page, errors };
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port + "/index.html";
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const size of [{ name: "desktop", width: 1280, height: 860 }, { name: "phone", width: 390, height: 844, mobile: true }]) {
      // 1. First visit: setup is forced and the chat is locked.
      const { context, page, errors } = await open(browser, origin, size, { settings: SEEN });
      await page.goto(origin + "#/ai", { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".lai.is-setup .lai-su[data-step='welcome']", { timeout: 20000 });
      check(!(await chatOpen(page)), size.name + " chat is locked on a first visit");
      await page.evaluate(() => window.ViktorychLocalAIPage.send("dark mode"));
      check((await page.evaluate(() => window.ViktorychLocalAIPage._state.chats.length)) === 0, size.name + " nothing can be sent before setup");
      await page.waitForTimeout(400);
      const card = await page.evaluate(() => { const r = document.querySelector(".lai-su-card").getBoundingClientRect(); return { top: r.top, bottom: r.bottom, w: r.width, h: innerHeight, vw: innerWidth }; });
      if (size.mobile) check(Math.abs(card.bottom - card.h) < 2 && card.w === card.vw, "phone setup is a bottom sheet " + JSON.stringify(card));
      else check(card.w <= 600 && card.top > 20, "desktop setup is a centred card");
      // 2. Walk through: device check, Instant, test, preferences, done.
      await page.click("[data-lai='su-next']");
      await page.waitForSelector(".lai-su[data-step='device'] [data-lai='su-pick']", { timeout: 15000 });
      const opts = await page.$$eval("[data-lai='su-pick']", (els) => els.map((e) => e.getAttribute("data-id")));
      check(opts.includes("instant"), size.name + " device step offers Instant");
      check((await page.$$(".lai-su .lai-badge")).length === 1, size.name + " one model is recommended");
      await page.click("[data-lai='su-pick'][data-id='instant']");
      check((await page.getAttribute("[data-lai='su-pick'][data-id='instant']", "aria-checked")) === "true", size.name + " picking a tier marks it");
      await page.click("[data-lai='su-next']");
      await page.waitForSelector(".lai-su[data-step='test'] [data-lai='su-next']", { timeout: 15000 });
      await page.click("[data-lai='su-next']");
      await page.waitForSelector(".lai-su[data-step='prefs']", { timeout: 5000 });
      check((await page.getAttribute("[data-lai='su-lang'][data-v='en']", "aria-checked")) === "true", size.name + " reply language defaults to the app language");
      await page.click("[data-lai='su-lang'][data-v='es']");
      await page.click("[data-lai='su-next']");
      await page.waitForSelector(".lai-su[data-step='done'] [data-lai='su-finish']", { timeout: 5000 });
      const saved = (await settings(page)).aiSetup || {};
      check(saved.done === true && saved.model === "instant" && saved.lang === "es" && saved.canChange === true && saved.history === "keep", size.name + " choices are saved for sync: " + JSON.stringify(saved));
      const at = ((await settings(page)).prefsAt || {}).aiSetup;
      check(at > 0, size.name + " setup has a sync stamp");
      await page.click("[data-lai='su-finish']");
      await page.waitForFunction(() => !document.querySelector(".lai").classList.contains("is-setup"), null, { timeout: 5000 });
      check(await chatOpen(page), size.name + " finishing setup unlocks the chat");
      await page.fill(".lai-input", "make text bigger");
      await page.press(".lai-input", "Enter");
      await page.waitForSelector('[data-lai="apply"]', { timeout: 10000 });
      // 3. Returning visit skips setup.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector(".lai .lai-bar", { timeout: 20000 });
      await page.waitForTimeout(400);
      check(await chatOpen(page) && !(await page.$(".lai-su")), size.name + " a returning visit goes straight to the chat");
      // 4. Run it again from the menu link.
      await page.goto(origin + "#/ai?setup=1", { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".lai.is-setup .lai-su[data-step='welcome']", { timeout: 10000 });
      check(!/setup=1/.test(await page.evaluate(() => location.hash)), size.name + " ?setup=1 is dropped from the address");
      check(errors.length === 0, size.name + " no page errors: " + errors.join(" | "));
      await context.close();

      // 5. Skip only picks Instant.
      const s2 = await open(browser, origin, size, { settings: SEEN });
      await s2.page.goto(origin + "#/ai", { waitUntil: "domcontentloaded" });
      await s2.page.waitForSelector("[data-lai='su-skip']", { timeout: 20000 });
      await s2.page.click("[data-lai='su-skip']");
      await s2.page.waitForFunction(() => !document.querySelector(".lai").classList.contains("is-setup"), null, { timeout: 5000 });
      check(((await settings(s2.page)).aiSetup || {}).model === "instant", size.name + " skip saves Instant");
      check(await chatOpen(s2.page), size.name + " skip opens the chat");
      await s2.context.close();

      // 6. A new device with a synced model that needs files: download and test only.
      const cpu = "onnx-community/Qwen3.5-0.8B-Text-ONNX";
      const s3 = await open(browser, origin, size, { settings: Object.assign({}, SEEN, { aiSetup: { v: 1, done: true, model: cpu, lang: "en", canChange: false, history: "off" }, prefsAt: { aiSetup: 1 } }) });
      await s3.page.goto(origin + "#/ai", { waitUntil: "domcontentloaded" });
      await s3.page.waitForSelector(".lai.is-setup .lai-su", { timeout: 20000 });
      await s3.page.waitForFunction(() => window.ViktorychLocalAIPage._state.choices, null, { timeout: 10000 });
      const steps = await s3.page.evaluate(() => window.ViktorychLocalAIPage._state.setup.steps.join(","));
      const hasCpu = await s3.page.evaluate((id) => window.ViktorychLocalAIPage._state.choices.list.some((m) => m.id === id), cpu);
      check(steps === (hasCpu ? "download,test" : "device,download,test"), size.name + " a new device only downloads and tests: " + steps);
      if (hasCpu) {
        check((await step(s3.page)) === "download", size.name + " new device starts at the download");
        check(!!(await s3.page.$("[data-lai='su-dl']")), size.name + " download waits for a tap");
      }
      await s3.page.click("[data-lai='su-instant']");
      await s3.page.waitForSelector(".lai-su[data-step='test'] [data-lai='su-next']", { timeout: 10000 });
      await s3.page.click("[data-lai='su-next']");
      await s3.page.waitForFunction(() => !document.querySelector(".lai").classList.contains("is-setup"), null, { timeout: 5000 });
      const kept = (await settings(s3.page)).aiSetup || {};
      check(kept.model === "instant" && kept.canChange === false && kept.history === "off", size.name + " synced choices are kept: " + JSON.stringify(kept));
      // Changes are off, so a request shows a link instead of an Apply card.
      await s3.page.fill(".lai-input", "make text bigger");
      await s3.page.press(".lai-input", "Enter");
      await s3.page.waitForSelector(".lai-msg.ai:not(.streaming) .lai-open", { timeout: 10000 });
      check(!(await s3.page.$('[data-lai="apply"]')), size.name + " changes off shows links only");
      await s3.context.close();
    }
    console.log("local ai setup ok");
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
