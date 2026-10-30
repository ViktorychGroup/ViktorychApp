/* Install app on desktop browsers. Simulates beforeinstallprompt (fired before
   app.js runs, the way Chrome and Edge often do) and checks the Install button
   calls prompt() inside the click; checks the fallback steps for Chrome without
   a prompt, Firefox and Safari; and that the translated blob: manifest stays
   installable (absolute start_url, scope and icons). Placeholders only.
   SHOTS=/some/dir saves screenshots. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.SHOTS || "";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error("install prompt: " + message);
  process.exitCode = 1;
  throw new Error(message);
}
function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}
function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

const W = 1280;
const H = 800;
const CAPTION = 138; // Windows/Linux caption buttons on the right
const TRAFFIC = 78; // macOS traffic lights on the left
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const EDGE_UA = CHROME_UA + " Edg/141.0.0.0";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0";
const SAFARI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";

/* fake: "early" fires a simulated beforeinstallprompt before app.js runs,
   "late" fires it after the app is up, "" never fires one. */
async function open(browser, origin, { ua = CHROME_UA, fake = "", standalone = false } = {}) {
  const context = await browser.newContext({ viewport: { width: W, height: H }, userAgent: ua });
  const page = await context.newPage();
  await page.addInitScript((cfg) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", "en");
    window.__promptCalls = [];
    window.__makeInstallEvent = () => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.platforms = ["web"];
      event.prompt = () => {
        window.__promptCalls.push({ active: !!(navigator.userActivation && navigator.userActivation.isActive), appReady: !!window.ViktorychSetup });
        return Promise.resolve();
      };
      event.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
      return event;
    };
    if (cfg.fake === "early") {
      // Deferred scripts (app.js) have not run yet at "interactive".
      document.addEventListener("readystatechange", () => {
        if (document.readyState !== "interactive") return;
        window.__firedBeforeApp = !window.ViktorychSetup;
        window.dispatchEvent(window.__makeInstallEvent());
      });
    }
    if (cfg.standalone) {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const text = String(query);
        if (text.indexOf("display-mode") < 0) return real(query);
        const hit = text.indexOf("display-mode: standalone") >= 0;
        return { matches: hit, media: text, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } };
      };
    }
  }, { fake, standalone });
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) route.continue();
    else route.abort();
  });
  await page.goto(origin + "/index.html#/settings", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.ViktorychSetup && document.querySelector(".set-row, .set-list"), null, { timeout: 25000 });
  if (fake === "late") await page.evaluate(() => window.dispatchEvent(window.__makeInstallEvent()));
  await sleep(300);
  return { context, page };
}

async function openSheet(page) {
  // The settings list re-renders while it loads, so retry the tap.
  for (let i = 0; i < 5 && !(await page.locator(".install-panel").count()); i++) {
    await page.locator('.set-row[data-act="install"]').first().click({ timeout: 5000 }).catch(() => {});
    await sleep(300);
  }
  await page.waitForSelector(".install-panel", { timeout: 8000 });
  await sleep(200);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome", args: ["--no-sandbox", "--disable-gpu"] });
  try {
    // 1. The translated blob: manifest keeps absolute URLs, so Chrome can install it.
    {
      const { context, page } = await open(browser, origin);
      await page.waitForFunction(() => {
        const link = document.querySelector('link[rel="manifest"]');
        return link && link.href.indexOf("blob:") === 0;
      }, null, { timeout: 10000 });
      const manifest = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).json());
      const under = (value) => typeof value === "string" && value.indexOf(origin + "/") === 0;
      if (!under(manifest.start_url) || !under(manifest.scope) || !under(manifest.id)) fail("manifest start_url/scope/id are not absolute: " + JSON.stringify([manifest.start_url, manifest.scope, manifest.id]));
      const icons = manifest.icons || [];
      if (!icons.some((icon) => icon.sizes === "192x192") || !icons.some((icon) => icon.sizes === "512x512")) fail("manifest lost its 192 or 512 icon");
      if (!icons.every((icon) => under(icon.src))) fail("manifest icon URLs are not absolute");
      if (manifest.display !== "standalone") fail("manifest display is not standalone");
      const cdp = await context.newCDPSession(page);
      const parsed = await cdp.send("Page.getAppManifest");
      const invalid = (parsed.errors || []).filter((err) => /URL is invalid/.test(err.message));
      if (invalid.length) fail("Chrome rejects manifest URLs: " + invalid.map((err) => err.message).slice(0, 3).join("; "));
      const check = await cdp.send("Page.getInstallabilityErrors");
      const blocking = (check.installabilityErrors || []).map((err) => err.errorId).filter((id) => /start-url|icon|manifest/.test(id));
      if (blocking.length) fail("Chrome installability errors: " + blocking.join(", "));
      await context.close();
    }
    // 2. Chrome fires the prompt before app.js runs; Install calls prompt() in the click.
    {
      const { context, page } = await open(browser, origin, { fake: "early" });
      if (!(await page.evaluate(() => window.__firedBeforeApp))) fail("simulated prompt did not fire before the app booted");
      await shot(page, "1-settings-install-row");
      await openSheet(page);
      if (!(await page.locator(".install-go").count())) fail("Install button missing although a prompt was captured early");
      await shot(page, "2-install-sheet-with-prompt");
      await page.click(".install-go");
      await page.waitForFunction(() => window.__promptCalls.length === 1, null, { timeout: 5000 }).catch(() => fail("prompt() was not called on click"));
      const call = await page.evaluate(() => window.__promptCalls[0]);
      if (!call.active) fail("prompt() ran outside the user's click");
      await page.waitForFunction(() => !document.querySelector(".install-panel"), null, { timeout: 5000 }).catch(() => fail("sheet stayed open after the prompt was accepted"));
      await context.close();
    }
    // 3. A prompt that arrives after the app is up works too.
    {
      const { context, page } = await open(browser, origin, { fake: "late", ua: EDGE_UA });
      await openSheet(page);
      await page.click(".install-go");
      await page.waitForFunction(() => window.__promptCalls.length === 1, null, { timeout: 5000 }).catch(() => fail("late prompt was not used"));
      await context.close();
    }
    // 4. Chrome without a prompt: browser steps, never a dead Install button.
    {
      const { context, page } = await open(browser, origin, { ua: CHROME_UA });
      await openSheet(page);
      if (await page.locator(".install-go").count()) fail("dead Install button shown without a prompt");
      const help = await page.locator(".install-help").getAttribute("data-kind").catch(() => "");
      if (help !== "chrome") fail("Chrome fallback steps missing: " + help);
      if (!/address bar/.test(await page.locator(".install-help").innerText())) fail("Chrome steps do not mention the address bar");
      await shot(page, "3-fallback-chrome-no-prompt");
      await context.close();
    }
    // 5. Firefox and Safari have no install prompt.
    for (const [ua, kind, text, name] of [[FIREFOX_UA, "firefox", /Chrome or Edge/, "4-fallback-firefox"], [SAFARI_UA, "safari-mac", /Add to Dock/, "5-fallback-safari-mac"], [EDGE_UA, "edge", /Apps/, "6-fallback-edge-no-prompt"]]) {
      const { context, page } = await open(browser, origin, { ua });
      await openSheet(page);
      if (await page.locator(".install-go").count()) fail(kind + " shows an Install button without a prompt");
      const got = await page.locator(".install-help").getAttribute("data-kind").catch(() => "");
      if (got !== kind) fail("wrong fallback for " + kind + ": " + got);
      if (!text.test(await page.locator(".install-help").innerText())) fail(kind + " fallback text is wrong");
      await shot(page, name);
      await context.close();
    }
    // 6. Spanish copy is translated.
    {
      const { context, page } = await open(browser, origin, { ua: FIREFOX_UA });
      await page.evaluate(() => window.SI18n && window.SI18n.setLang("es"));
      await sleep(400);
      await openSheet(page);
      if (!/Chrome o Edge/.test(await page.locator(".install-help").innerText())) fail("Firefox fallback is not translated");
      await shot(page, "7-fallback-firefox-es");
      await context.close();
    }
    // 7. Already running installed: no Install row.
    {
      const { context, page } = await open(browser, origin, { fake: "early", standalone: true });
      if (await page.locator('.set-row[data-act="install"]').count()) fail("Install row shown inside the installed app");
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log("install prompt ok");
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
