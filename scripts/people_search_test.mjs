/* People search and the "Let others find me in search" switch, phone and desktop.
   Explore asks the server for app accounts by username or name and lists them on
   Top and People and in the typeahead; Privacy has the search switch, on by
   default, which saves to /v1/suggestions/prefs. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(message); process.exitCode = 1; throw new Error(message); }
function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
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

const SIZES = [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1280, height: 800, mobile: false }
];


const SHOTS = process.env.SHOTS_DIR || "";
const CATALOG = {
  updated: "2026-11-07T00:00:00.000Z",
  feeds: [{
    id: "instagram:orbitfox", platform: "instagram", handle: "orbitfox", name: "Orbit Fox",
    bio: "Demo bio line", configured: true, url: "https://www.instagram.com/orbitfox/"
  }],
  posts: [{
    id: "Efgh5678", statusId: "Efgh5678", platform: "instagram", feedId: "instagram:orbitfox",
    handle: "orbitfox", author: "Orbit Fox", text: "Fresh demo photo", lang: "en",
    date: "2026-11-07T00:00:00.000Z", url: "https://www.instagram.com/p/Efgh5678/",
    media: [], kind: "post"
  }]
};
const ACCOUNTS = [
  { id: "app:@new_person", kind: "account", handle: "new_person", name: "New Person", avatar: "", bio: "Just joined." },
  { id: "app:100000000001", kind: "account", handle: "user_a", name: "User A", avatar: "", bio: "" }
];

function session() {
  return `(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A", publicId: "100000000001" } }));
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true, tiktokAudience: "owner" };
  })()`;
}

function mock(page, log, state) {
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  return page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
    if (url.pathname === "/v1/people" || url.pathname === "/v1/suggestions/prefs") log.push(method + " " + url.pathname + url.search + " " + JSON.stringify(body));
    if (url.pathname === "/v1/data/feeds.json" || url.pathname.endsWith("/feeds.json")) {
      return reply(route, 200, CATALOG);
    }
    if (url.pathname === "/v1/people") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      if (q === "quiet_lane") return reply(route, 200, { accounts: [] });
      if (q === "lane_fox") {
        if (state.laneOmit) return reply(route, 200, { accounts: [] });
        return reply(route, 200, { accounts: [{ id: "app:@lane_fox", handle: "lane_fox", name: "Lane Fox", avatar: "", bio: "" }] });
      }
      return reply(route, 200, { accounts: ACCOUNTS.filter((a) => a.handle.includes(q) || a.name.toLowerCase().includes(q)) });
    }
    if (url.pathname === "/v1/suggestions/prefs" && method === "GET") return reply(route, 200, state.prefs);
    if (url.pathname === "/v1/suggestions/prefs") { Object.assign(state.prefs, body); return reply(route, 200, state.prefs); }
    return reply(route, 200, {});
  });
}

async function check(browser, port, size) {
  const label = size.name;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: "block" });
  const page = await context.newPage();
  const log = [];
  const errors = [];
  const state = { prefs: { discoverable: true, tempOptIn: false, kind: "person", ownerKind: "" } };
  page.on("pageerror", (err) => errors.push(String(err)));
  await mock(page, log, state);
  await page.route("**/feeds.json*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CATALOG) }));
  await page.addInitScript(session());

  // Explore: an account this device has never seen is found on the server.
  await page.goto("http://127.0.0.1:" + port + "/index.html#/explore?q=new_person&tab=people", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.gpeople a[href="#/@new_person"]', { timeout: 20000 }).catch(() => fail(label + ": People tab did not list the server account"));
  if (!log.some((line) => line.startsWith("GET /v1/people?q=new_person"))) fail(label + ": no server search");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "people-search-" + label + ".png") });
  await page.goto("http://127.0.0.1:" + port + "/index.html#/explore?q=%40New_Person", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.gresults-list a[href="#/@new_person"]', { timeout: 20000 }).catch(() => fail(label + ": Top did not list the server account"));

  for (const q of ["orbitfox", "@orbitfox"]) {
    await page.goto("http://127.0.0.1:" + port + "/index.html#/explore?q=" + encodeURIComponent(q), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.gresults-list a[href="#/instagram/orbitfox"]', { timeout: 20000 }).catch(() => fail(label + ": source missing for " + q));
    const sourceText = await page.locator(".gresults-list").innerText();
    if (!sourceText.includes("Orbit Fox") || !sourceText.includes("@orbitfox")) fail(label + ": source row " + q);
    if (sourceText.includes("Not This Person")) fail(label + ": invented source name");
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "source-search-" + label + ".png") });

  for (const q of ["user_a", "@user_a"]) {
    await page.goto("http://127.0.0.1:" + port + "/index.html#/explore?q=" + encodeURIComponent(q), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('.gresults-list a[href="#/@user_a"]', { timeout: 20000 }).catch(() => fail(label + ": signed-in account missing for " + q));
    if (!log.some((line) => line.startsWith("GET /v1/people?q=user_a"))) fail(label + ": signed-in search was not sent");
  }
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "self-search-" + label + ".png") });

  await page.goto("http://127.0.0.1:" + port + "/index.html#/explore?q=" + encodeURIComponent("@quiet_lane"), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /Nothing matched|No accounts|No results/.test(document.body.innerText || ""), null, { timeout: 8000 }).catch(() => fail(label + ": opted-out query did not stay empty"));
  if (await page.locator(".gresults-list a.who-main").count()) fail(label + ": an opted-out account was shown");

  await page.goto("http://127.0.0.1:" + port + "/index.html#/explore?q=lane_fox", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.gresults-list a[href="#/@lane_fox"]', { timeout: 20000 }).catch(() => fail(label + ": first server hit did not show"));
  state.laneOmit = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /Nothing matched|No accounts|No results/.test(document.body.innerText || ""), null, { timeout: 8000 }).catch(() => fail(label + ": an omitted account stayed after reload"));
  if (await page.locator('.gresults-list a[href="#/@lane_fox"]').count()) fail(label + ": stale people hit remained");

  // Privacy: the search switch is on by default and saves to the server.
  await page.goto("http://127.0.0.1:" + port + "/index.html#/settings/privacy", { waitUntil: "domcontentloaded" });
  const sw = '[data-act="pymk-searchable"]';
  await page.waitForSelector(sw, { timeout: 20000 }).catch(() => fail(label + ": no search switch in Privacy"));
  if ((await page.getAttribute(sw, "aria-checked")) !== "true") fail(label + ": search switch is not on by default");
  const text = await page.textContent(sw);
  if (!text.includes("Let others find me in search")) fail(label + ": switch label " + text);
  await page.waitForFunction((s) => {
    const el = document.querySelector(s);
    if (!el || !el.isConnected || el.getAttribute("aria-checked") !== "true") return false;
    el.scrollIntoView({ block: "nearest" });
    return true;
  }, sw);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "search-setting-on-" + label + ".png") });
  await page.click(sw);
  await page.waitForFunction((s) => document.querySelector(s) && document.querySelector(s).getAttribute("aria-checked") === "false", sw, { timeout: 5000 }).catch(() => fail(label + ": switch did not turn off"));
  await page.waitForTimeout(150);
  if (!log.some((line) => line.startsWith("PUT /v1/suggestions/prefs") && line.includes('"searchable":false'))) fail(label + ": switch did not save");
  if (state.prefs.discoverable !== true) fail(label + ": the other switch changed");
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "search-setting-off-" + label + ".png") });
  const over = await page.evaluate((s) => {
    const row = document.querySelector(s);
    const box = row.parentElement.getBoundingClientRect();
    return [row, row.nextElementSibling].concat(Array.from(row.querySelectorAll("*"))).filter((el) => el && el.offsetParent).filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > box.right + 1 || r.right > window.innerWidth + 1); }).map((el) => el.className).slice(0, 3);
  }, sw);
  if (over.length) fail(label + ": overflow " + over);
  if (errors.length) fail(label + ": page errors " + errors.slice(0, 2));
  await context.close();
  console.log("people search ok " + label);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    for (const size of SIZES) await check(browser, port, size);
    console.log("people search ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
