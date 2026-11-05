/* Notification sounds (notif_sounds): Settings → Notifications lists the
   Notification sounds page with a volume, a default, one row per type and
   the per-account picks; a pick plays a WebAudio tone and is kept; a
   profile's ⋯ menu sets a sound for that account, which then wins over the
   type and the default; None stays quiet; the page is translated; the
   owner switch removes the row, the page and the profile menu entry. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const shared = sharedStaticServer();
  if (shared) return Promise.resolve(shared);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function open(browser, origin, opts) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: "block", locale: opts.locale || "en-US" });
  await context.addInitScript((o) => {
    try {
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
      if (!sessionStorage.getItem("ns-seed")) {
        sessionStorage.setItem("ns-seed", "1");
        if (o.ownerOff) localStorage.setItem("viktorychapp-server-off", JSON.stringify(["notif_sounds"]));
      }
    } catch (err) {}
  }, opts);
  const page = await context.newPage();
  await page.goto(origin + "/#/" + (opts.route || ""), { waitUntil: "domcontentloaded" });
  await sleep(1500);
  return { context, page };
}

const prefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("viktorychapp-notif-sounds-v1") || "{}"));

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
  try {
    // 1. The row, the page, a pick that plays and is kept.
    {
      const { context, page } = await open(browser, origin, { route: "settings/notifications" });
      await page.waitForSelector('[href="#/settings/notifications/sounds"], [data-href="#/settings/notifications/sounds"]', { timeout: 15000 }).catch(() => fail("no Notification sounds row in Notification settings"));
      await page.goto(origin + "/#/settings/notifications/sounds");
      await page.waitForSelector(".nsnd-page", { timeout: 15000 }).catch(() => fail("no sounds page"));
      const shape = await page.evaluate(() => ({
        types: document.querySelectorAll('[data-snd="type"]').length,
        def: !!document.querySelector('select[data-snd="default"]'),
        vol: !!document.querySelector('[data-snd="volume"]'),
        options: [...document.querySelectorAll('select[data-snd="default"] option')].map((o) => o.value),
        note: document.querySelector(".nsnd-page .phandle").textContent
      }));
      if (shape.types !== 7 || !shape.def || !shape.vol) fail("sounds page is missing parts " + JSON.stringify(shape));
      if (!shape.options.includes("none") || !shape.options.includes("default") || shape.options.length < 6) fail("default sound choices are wrong " + JSON.stringify(shape.options));
      if (!/phone/.test(shape.note)) fail("page does not say closed-app alerts use the phone's sound");
      await page.selectOption('select[data-snd="default"]', "bell");
      await page.selectOption('select[data-snd="type"][data-group="likes"]', "none");
      await page.selectOption('select[data-snd="type"][data-group="messages"]', "marimba");
      let p = await prefs(page);
      if (p.sound !== "bell" || p.byType.likes !== "none" || p.byType.messages !== "marimba") fail("picks not kept " + JSON.stringify(p));
      const played = await page.evaluate(() => ({ n: window.ViktorychSounds.played, last: window.ViktorychSounds.lastPlayed }));
      if (played.n < 1 || played.last !== "marimba") fail("a pick did not play " + JSON.stringify(played));
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/page.png", fullPage: false });
      // Which sound a note gets: type, then default; None stays quiet.
      const picks = await page.evaluate(() => {
        const S = window.ViktorychSounds;
        return {
          dm: S.soundFor({ kind: "dm", handle: "demo_sender", platform: "app" }).sound,
          like: S.soundFor({ kind: "like", handle: "demo_sender", platform: "app" }).sound,
          other: S.soundFor({ kind: "something-new" }).sound,
          quiet: S.onNew([{ kind: "like", handle: "demo_sender", platform: "app", at: Date.now() }])
        };
      });
      if (picks.dm !== "marimba" || picks.like !== "none" || picks.other !== "bell" || picks.quiet !== "none") fail("sound choice order is wrong " + JSON.stringify(picks));
      await context.close();
    }
    // 2. A profile's ⋯ menu sets the account's sound, which wins.
    {
      const { context, page } = await open(browser, origin, { route: "@demo_sound" });
      await page.waitForSelector('[data-act="profile-more"]', { timeout: 30000 }).catch(() => fail("no profile ⋯ button"));
      await page.click('[data-act="profile-more"]');
      await page.waitForSelector('[data-act="profile-sound"]', { timeout: 10000 }).catch(() => fail("no Notification sound in the profile menu"));
      await page.click('[data-act="profile-sound"]');
      await page.waitForSelector('[data-act="snd-sender"][data-sound="chirp"]', { timeout: 10000 }).catch(() => fail("no sound choices in the profile sheet"));
      if (!/phone/.test(await page.textContent(".profile-menu"))) fail("profile sheet does not mention the phone's sound");
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/profile.png", fullPage: false });
      await page.click('[data-act="snd-sender"][data-sound="chirp"]');
      await sleep(300);
      const p = await prefs(page);
      const key = Object.keys(p.bySender || {})[0] || "";
      if (!/demo_sound/.test(key) || p.bySender[key].sound !== "chirp") fail("account sound not kept " + JSON.stringify(p));
      const got = await page.evaluate(() => window.ViktorychSounds.soundFor({ kind: "like", handle: "demo_sound", platform: "x" }));
      if (got.sound !== "chirp" || got.why !== "sender") fail("account sound does not win " + JSON.stringify(got));
      await page.goto(origin + "/#/settings/notifications/sounds");
      await page.waitForSelector(".nsnd-person", { timeout: 10000 }).catch(() => fail("account not listed on the sounds page"));
      await page.click(".nsnd-remove");
      if (Object.keys((await prefs(page)).bySender || {}).length) fail("Remove did not clear the account sound");
      await context.close();
    }
    // 3. Translated.
    {
      const { context, page } = await open(browser, origin, { route: "settings/notifications/sounds", locale: "es-ES" });
      await page.waitForSelector(".nsnd-page", { timeout: 15000 });
      const h = await page.evaluate(() => [...document.querySelectorAll(".nsnd-page h2")].map((x) => x.textContent));
      if (!h.includes("Volumen") || !h.includes("Por tipo de notificación")) fail("Spanish page not translated " + JSON.stringify(h));
      await context.close();
    }
    // 4. Owner switch off: no row, no page, no profile entry.
    {
      const { context, page } = await open(browser, origin, { route: "settings/notifications", ownerOff: true });
      if (await page.$('[href="#/settings/notifications/sounds"], [data-href="#/settings/notifications/sounds"]')) fail("owner off: row still in Notification settings");
      await page.goto(origin + "/#/settings/notifications/sounds");
      await sleep(1200);
      if (await page.$(".nsnd-page")) fail("owner off: sounds page still shows");
      await page.goto(origin + "/#/@demo_sound");
      await page.waitForSelector('[data-act="profile-more"]', { timeout: 30000 });
      await page.click('[data-act="profile-more"]');
      await sleep(500);
      if (await page.$('[data-act="profile-sound"]')) fail("owner off: profile menu still offers a sound");
      await context.close();
    }
    console.log("notification sounds ok");
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
}

main().catch((err) => { if (!process.exitCode) process.exitCode = 1; console.error(err && err.message || err); });
