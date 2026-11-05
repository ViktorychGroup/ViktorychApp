/* Owner-managed member settings (owner_user_settings).
   Member: settings the owner locked come with /v1/sync; Settings says the
   owner manages them, the locked controls look locked, a tap only explains,
   and the stored value stays the owner's. Owner: Accounts → an account →
   Manage settings lists the settings with a value control and a Lock button
   per row and Lock all per group; each change is one PUT to the Worker. The
   owner switch hides the row and the page. Demo data only. */
import { pathToFileURL } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.OUS_SHOTS || "";

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
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

function seed(o) {
  return `(() => {
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    if (!sessionStorage.getItem("ous-seed")) {
      sessionStorage.setItem("ous-seed", "1");
      localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, appearance: "default" }));
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-demo", account: { handle: ${JSON.stringify(o.handle)}, displayName: "Demo", publicId: "100", owner: ${o.owner ? "true" : "false"} } }));
      ${o.off ? `localStorage.setItem("viktorychapp-server-off", JSON.stringify(["owner_user_settings"]));` : ""}
    }
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true };
  })()`;
}

const SCHEMA = [
  { key: "appearance", type: "enum", label: "Theme", def: "lightsout", group: "look", values: ["lightsout", "dim", "default", "auto"], valueLabels: { lightsout: "Lights out", dim: "Dim", "default": "Light", auto: "Auto" } },
  { key: "haptics", type: "bool", label: "Haptics", def: true, group: "look" },
  { key: "autoplay", type: "enum", label: "Autoplay videos", def: "all", group: "media", values: ["all", "wifi", "never"], valueLabels: { all: "On cellular or Wi-Fi", wifi: "Only on Wi-Fi", never: "Never" } },
  { key: "privacyWebRTC", type: "bool", label: "WebRTC leak protection", def: true, group: "privacy" },
  { key: "privacyNoReferrer", type: "bool", label: "Strict no-referrer", def: true, group: "privacy" }
];

function mock(page, log, member) {
  const state = { settings: { appearance: "default", haptics: true, autoplay: "all", privacyWebRTC: true, privacyNoReferrer: null }, locks: {} };
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  return page.route("https://accounts.test/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postData() ? JSON.parse(req.postData()) : {}; } catch (err) { body = {}; }
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    log.push(method + " " + url.pathname + " " + (req.postData() || ""));
    if (url.pathname === "/v1/sync") {
      if (member) return reply(route, 200, { payload: { appearance: "dim", autoplay: "never", prefsAt: { appearance: 5 } }, updatedAt: 7, locks: { appearance: "dim", autoplay: "never" } });
      return reply(route, 200, { payload: null, updatedAt: 0 });
    }
    if (url.pathname === "/v1/owner/user-settings/42") {
      if (method === "GET") return reply(route, 200, { id: "42", handle: "demo_member", settings: state.settings, locks: state.locks, schema: SCHEMA, groups: ["look", "feed", "media", "privacy", "language"] });
      Object.assign(state.settings, body.values || {});
      Object.keys(body.locks || {}).forEach((k) => { if (body.locks[k]) state.locks[k] = state.settings[k] == null ? SCHEMA.find((r) => r.key === k).def : state.settings[k]; else delete state.locks[k]; });
      return reply(route, 200, { id: "42", handle: "demo_member", settings: state.settings, locks: state.locks });
    }
    if (url.pathname === "/v1/owner/inspector/accounts/42") {
      return reply(route, 200, { id: "42", handle: "demo_member", name: "Demo Member", owner: false, createdAt: 1, lastActive: 2, online: false, profile: {}, names: [{ handle: "demo_member", primary: true, audience: {} }], displayNames: [], counts: {}, communities: [], requests: [], reports: { total: 0, byStatus: {} }, moderation: {}, sessions: { active: 0, devices: 0, types: [] }, storage: {}, linked: {}, email: { stored: false }, kind: { own: "", owner: "" }, signIn: [] });
    }
    return reply(route, 200, {});
  });
}

async function newPage(browser, origin, o) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  const log = [];
  await mock(page, log, o.member);
  await page.addInitScript(seed(o));
  return { context, page, log, errors };
}

async function member(browser, origin) {
  const { context, page, errors } = await newPage(browser, origin, { handle: "demo_member", member: true });
  await page.goto(origin + "/index.html#/settings", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".owner-locks-note", { timeout: 20000 }).catch(() => fail("member: no 'owner manages' note in Settings"));
  const note = await page.textContent(".owner-locks-note");
  if (!/manages 2 of your settings/.test(note)) fail("member: note " + note);
  await page.goto(origin + "/index.html#/settings/display", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-act="theme"][data-theme="default"]', { timeout: 15000 }).catch(() => fail("member: no theme buttons"));
  const look = await page.evaluate(() => {
    const btn = document.querySelector('[data-act="theme"][data-theme="default"]');
    return { opacity: getComputedStyle(btn).opacity, stored: JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}").appearance };
  });
  if (Number(look.opacity) > 0.5) fail("member: locked theme does not look locked (" + look.opacity + ")");
  if (look.stored !== "dim") fail("member: stored theme " + look.stored);
  await page.click('[data-act="theme"][data-theme="default"]');
  await page.waitForFunction(() => /locked this setting/.test(document.body.innerText), null, { timeout: 3000 }).catch(() => fail("member: tap on a locked setting did not explain"));
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}").appearance);
  if (after !== "dim") fail("member: tap changed a locked theme to " + after);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "member-locked.png") });
  if (errors.length) fail("member: page errors " + errors.join(" | "));
  await context.close();
}

async function owner(browser, origin) {
  const { context, page, log, errors } = await newPage(browser, origin, { handle: "demo_owner", owner: true });
  await page.goto(origin + "/index.html#/settings/accounts-inspector/42", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('a[href="#/settings/accounts-inspector/manage:42"]', { timeout: 20000 }).catch(() => fail("owner: no Manage settings row"));
  await page.click('a[href="#/settings/accounts-inspector/manage:42"]');
  await page.waitForSelector(".oi-manage .oi-ms-row", { timeout: 15000 }).catch(() => fail("owner: manage page did not load"));
  const rows = await page.$$eval(".oi-ms-row b", (els) => els.map((el) => el.textContent));
  if (rows.join("|") !== "Theme|Haptics|Autoplay videos|WebRTC leak protection|Strict no-referrer") fail("owner: rows " + rows.join("|"));
  const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > window.innerWidth + 1);
  if (wide) fail("owner: manage page overflows on a phone");

  await page.click('[data-oi-act="ms-lock"][data-oi-k="appearance"]');
  await page.waitForSelector('[data-oi-act="ms-lock"][data-oi-k="appearance"].on', { timeout: 5000 }).catch(() => fail("owner: lock did not stick"));
  if (!log.some((l) => l.startsWith("PUT /v1/owner/user-settings/42") && l.includes('"locks":{"appearance":true}'))) fail("owner: lock PUT " + log.join("\n"));

  await page.selectOption('select[data-oi-k="autoplay"]', "wifi");
  for (let i = 0; i < 30 && !log.some((l) => l.includes('"values":{"autoplay":"wifi"}')); i++) await page.waitForTimeout(100);
  if (!log.some((l) => l.includes('"values":{"autoplay":"wifi"}'))) fail("owner: value PUT missing");

  await page.click('[data-oi-act="ms-bool"][data-oi-k="haptics"]');
  for (let i = 0; i < 30 && !log.some((l) => l.includes('"values":{"haptics":false}')); i++) await page.waitForTimeout(100);
  if (!log.some((l) => l.includes('"values":{"haptics":false}'))) fail("owner: switch PUT missing");

  await page.click('[data-oi-act="ms-lock-group"][data-oi-v="privacy"]');
  await page.waitForSelector('[data-oi-act="ms-lock-group"][data-oi-v="privacy"][data-oi-on="0"]', { timeout: 5000 }).catch(() => fail("owner: Lock all did not lock the group"));
  if (!log.some((l) => l.includes('"locks":{"privacyWebRTC":true,"privacyNoReferrer":true}'))) fail("owner: group lock PUT missing");
  const foot = await page.textContent(".oi-manage .oi-note-foot");
  if (!/3 settings locked/.test(foot)) fail("owner: footer " + foot);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "owner-manage.png"), fullPage: true });
  if (errors.length) fail("owner: page errors " + errors.join(" | "));
  await context.close();
}

async function switchedOff(browser, origin) {
  const { context, page } = await newPage(browser, origin, { handle: "demo_owner", owner: true, off: true });
  await page.goto(origin + "/index.html#/settings/accounts-inspector/42", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".oi-detail", { timeout: 20000 }).catch(() => fail("off: detail did not load"));
  if (await page.$('a[href="#/settings/accounts-inspector/manage:42"]')) fail("off: Manage settings row still shown");
  await page.goto(origin + "/index.html#/settings/accounts-inspector/manage:42", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  if (await page.$(".oi-manage")) fail("off: manage page still opens");
  await context.close();
}

const chromium = await loadPlaywright();
const server = await startServer();
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  await member(browser, origin);
  await owner(browser, origin);
  await switchedOff(browser, origin);
  console.log("owner user settings ok");
} finally {
  await browser.close();
  if (!sharedStaticServer()) server.close();
}
