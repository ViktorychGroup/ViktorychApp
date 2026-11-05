/* Settings → Site permissions (site_permissions): the page lists each
   permission with its live state; a granted one reads Allowed, an unasked
   one offers Allow, a blocked one shows the Android steps and Check again;
   a permission granted while the page is open updates without a reload;
   the row is translated; the owner switch removes the row and the page. */
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
      if (!sessionStorage.getItem("sp-seed")) {
        sessionStorage.setItem("sp-seed", "1");
        if (o.ownerOff) localStorage.setItem("viktorychapp-server-off", JSON.stringify(["site_permissions"]));
      }
    } catch (err) {}
  }, opts);
  const page = await context.newPage();
  await page.goto(origin + "/#/" + (opts.route || ""), { waitUntil: "domcontentloaded" });
  // Per-permission CDP settings: Playwright's grantPermissions would block every other permission.
  if (opts.grant) await setPerm(context, page, origin, opts.grant, "granted");
  await sleep(1500);
  return { context, page };
}

const READ = `(() => {
  const out = {};
  document.querySelectorAll("[data-sp-row]").forEach((row) => {
    const st = row.querySelector(".siteperm-state");
    out[row.dataset.spRow] = { state: st ? st.className.replace(/.*siteperm-is-/, "") : "", label: st ? st.textContent : "", title: (row.querySelector("b") || {}).textContent || "",
      allow: !!row.querySelector("[data-sp-ask]"), steps: row.querySelectorAll(".siteperm-steps li").length, again: !!row.querySelector("[data-sp-again]") };
  });
  return out;
})()`;

// Permission overrides last only while their CDP session is attached, so
// one browser session stays open for the whole run.
let browserCdp = null;
async function setPerm(context, page, origin, names, setting) {
  const ps = await context.newCDPSession(page);
  const { targetInfo } = await ps.send("Target.getTargetInfo");
  await ps.detach().catch(() => {});
  if (!browserCdp) browserCdp = await context.browser().newBrowserCDPSession();
  for (const name of names) await browserCdp.send("Browser.setPermission", { origin, browserContextId: targetInfo.browserContextId, permission: { name }, setting });
}

async function rows(page) {
  for (let i = 0; i < 30; i++) {
    const got = await page.evaluate(READ);
    if (got.notifications && got.notifications.state !== "checking" && got.camera && got.camera.state !== "checking") return got;
    await sleep(200);
  }
  return page.evaluate(READ);
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    // 1. Settings lists the row; the page shows live states.
    {
      const { context, page } = await open(browser, origin, { route: "settings", grant: ["notifications"] });
      await page.waitForSelector('a[href="#/settings/permissions"], [data-href="#/settings/permissions"]', { timeout: 15000 }).catch(() => fail("no Site permissions row in Settings"));
      await page.goto(origin + "/#/settings/permissions");
      await page.waitForSelector("[data-sp-row]", { timeout: 15000 });
      let got = await rows(page);
      for (const id of ["notifications", "geolocation", "camera", "microphone", "persistent-storage"]) if (!got[id]) fail("missing row " + id);
      if (got.notifications.state !== "granted" || got.notifications.label !== "Allowed" || got.notifications.allow) fail("granted notifications not shown as Allowed " + JSON.stringify(got.notifications));
      if (got.camera.state !== "prompt" || !got.camera.allow || got.camera.steps) fail("unasked camera should offer Allow " + JSON.stringify(got.camera));
      // Blocked: steps and Check again, no Allow.
      await setPerm(context, page, origin, ["geolocation"], "denied");
      await page.click('[data-sp-row="geolocation"] [data-sp-ask], [data-sp-row="geolocation"] [data-sp-again]').catch(() => {});
      await sleep(800);
      got = await page.evaluate(READ);
      if (got.geolocation.state !== "denied" || got.geolocation.allow || got.geolocation.steps < 3 || !got.geolocation.again) fail("blocked location should show steps " + JSON.stringify(got.geolocation));
      if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/page.png", fullPage: false });
      // Granted while open: the row updates by itself.
      await setPerm(context, page, origin, ["camera"], "granted");
      let live = null;
      for (let i = 0; i < 20; i++) { live = (await page.evaluate(READ)).camera; if (live.state === "granted") break; await sleep(200); }
      if (live.state !== "granted" || live.allow) fail("camera row did not update live " + JSON.stringify(live));
      await context.close();
    }
    // 2. Translated.
    {
      const { context, page } = await open(browser, origin, { route: "settings", locale: "es-ES" });
      await page.goto(origin + "/#/settings/permissions");
      await page.waitForSelector("[data-sp-row]", { timeout: 15000 });
      const got = await rows(page);
      if (got.camera.title !== "Cámara" || got.camera.label !== "Preguntar") fail("Spanish row not translated " + JSON.stringify(got.camera));
      await context.close();
    }
    // 3. Owner switch off: no row, no page.
    {
      const { context, page } = await open(browser, origin, { route: "settings", ownerOff: true });
      await sleep(500);
      if (await page.$('[href="#/settings/permissions"], [data-href="#/settings/permissions"]')) fail("owner off: row still in Settings");
      await page.goto(origin + "/#/settings/permissions");
      await sleep(1200);
      if (await page.$("[data-sp-row]")) fail("owner off: page still shows permissions");
      await context.close();
    }
    console.log("site permissions ok");
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
}

main().catch((err) => { if (!process.exitCode) process.exitCode = 1; console.error(err && err.message || err); });
