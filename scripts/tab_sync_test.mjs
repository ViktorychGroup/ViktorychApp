/* Custom Home tabs follow the signed-in account: order, names and members.
   Two devices on one account see the same tabs. A second account does not.
   Dummy accounts only. */
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

const CATALOG = {
  updated: "2026-11-07T00:00:00.000Z",
  feeds: [{ id: "instagram:orbitfox", platform: "instagram", handle: "orbitfox", name: "Orbit Fox", configured: true, url: "https://www.instagram.com/orbitfox/" }],
  posts: []
};
const sync = {};
let holdPut = false;
let releasePut = null;
let putStarted = null;

function session(token, handle, publicId) {
  return `(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true, follows: ["instagram:orbitfox"], feedTabs: [] }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: ${JSON.stringify(token)}, account: { handle: ${JSON.stringify(handle)}, displayName: ${JSON.stringify(handle)}, publicId: ${JSON.stringify(publicId)} } }));
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true, tiktokAudience: "owner" };
  })()`;
}

async function arm(page) {
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/feeds.json*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CATALOG) }));
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const token = String(req.headers().authorization || "").replace(/^Bearer\s+/i, "") || "anon";
    if (url.pathname === "/v1/data/feeds.json" || url.pathname.endsWith("/feeds.json")) return reply(route, 200, CATALOG);
    if (url.pathname === "/v1/sync" && req.method() === "GET") {
      const row = sync[token] || { payload: null, updatedAt: 0 };
      return reply(route, 200, row);
    }
    if (url.pathname === "/v1/sync" && req.method() === "PUT") {
      if (holdPut) {
        holdPut = false;
        const started = putStarted;
        putStarted = null;
        if (started) started();
        await new Promise((resolve) => { releasePut = resolve; });
      }
      let body = {};
      try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
      const row = sync[token] || { payload: null, updatedAt: 0 };
      const base = Number(body.baseUpdatedAt) || 0;
      if (row.updatedAt && base && base !== row.updatedAt) {
        return reply(route, 409, { error: "conflict", payload: row.payload, updatedAt: row.updatedAt });
      }
      const next = { payload: body.payload || {}, updatedAt: Date.now() };
      sync[token] = next;
      return reply(route, 200, next);
    }
    return reply(route, 200, {});
  });
}

async function openDevice(browser, port, token, handle, publicId) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await arm(page);
  await page.addInitScript(session(token, handle, publicId));
  await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".topbar, header.nav", { timeout: 30000 });
  page._errors = errors;
  page._context = context;
  return page;
}

async function clickAct(page, act) {
  await page.evaluate((name) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.act = name;
    document.body.appendChild(button);
    button.click();
    button.remove();
  }, act);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    const first = await openDevice(browser, port, "token-a", "user_a", "100000000001");
    await clickAct(first, "manage-tabs");
    await first.waitForSelector('[data-act="feed-tab-new"]', { timeout: 15000 }).catch(() => fail("manage tabs did not open " + first._errors.slice(0, 2).join(" | ")));
    async function newHomeTab(name) {
      await first.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
      await first.waitForSelector(".topbar, header.nav", { timeout: 15000 });
      await clickAct(first, "manage-tabs");
      await first.waitForSelector('[data-act="feed-tab-new"]', { timeout: 10000 });
      await first.click('[data-act="feed-tab-new"]');
      await first.waitForSelector("#feed-tab-name", { timeout: 10000 });
      await first.fill("#feed-tab-name", name);
      const notes = first.locator('[data-act="feed-tab-draft-flag"][data-key="showNotes"]');
      if (await notes.count()) {
        const on = await notes.getAttribute("aria-checked");
        if (on !== "false") await notes.click();
      }
      await first.click('[data-act="feed-tab-save"]');
      await first.waitForFunction((wanted) => {
        const raw = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
        return (raw.feedTabs || []).some((tab) => tab.name === wanted && !(Number(tab.deletedAt) >= Number(tab.updatedAt || 0) && tab.deletedAt));
      }, name, { timeout: 10000 }).catch(() => fail("the tab was not saved: " + name));
    }
    await newHomeTab("Cedar");
    await newHomeTab("Birch");

    await clickAct(first, "manage-tabs");
    const grips = first.locator(".tab-manage-row [data-drag-tab]");
    if (await grips.count() < 2) fail("both tabs were not listed");
    const namesBefore = (await first.locator(".tab-manage-row .name").allTextContents()).filter((name) => name === "Cedar" || name === "Birch");
    const source = grips.nth(1);
    const target = grips.nth(0);
    const from = await source.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) fail("the drag handles were not on screen");
    await first.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await first.mouse.down();
    await first.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 12 });
    await first.mouse.up();
    await first.waitForTimeout(400);
    const stored = JSON.parse(await first.evaluate(() => localStorage.getItem("viktorychapp-settings-v1") || "{}"));
    const alive = (stored.feedTabs || []).filter((tab) => !tab.deletedAt);
    const byPos = alive.slice().sort((a, b) => Number(a.pos) - Number(b.pos)).map((tab) => tab.name);
    const stamps = alive.map((tab) => Number(tab.posAt));
    if (alive.length < 2 || stamps.some((at) => !(at > 0)) || new Set(stamps).size !== 1) fail("a drag did not stamp the whole order " + JSON.stringify(alive.map((tab) => [tab.name, tab.pos, tab.posAt])));
    if (byPos.join(",") === namesBefore.join(",")) fail("drag did not change the saved order " + byPos.join(","));

    holdPut = true;
    const uploadStarted = new Promise((resolve) => { putStarted = resolve; });
    await first.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
    await first.waitForSelector(".topbar, header.nav", { timeout: 15000 });
    await Promise.race([uploadStarted, first.waitForTimeout(3000)]);
    await clickAct(first, "manage-tabs");
    await first.locator('.tab-manage-row:has-text("Cedar") [data-act="feed-tab-edit"]').click();
    await first.waitForSelector("#feed-tab-q", { timeout: 10000 }).catch(() => fail("the tab editor did not open"));
    await first.fill("#feed-tab-q", "orbitfox");
    await first.waitForSelector('[data-act="feed-tab-pick"][data-id="instagram:orbitfox"]', { timeout: 10000 }).catch(() => fail("the account was not offered"));
    await first.locator('[data-act="feed-tab-pick"][data-id="instagram:orbitfox"]').click();
    await first.click('[data-act="feed-tab-save"]');
    await first.waitForFunction(() => (localStorage.getItem("viktorychapp-settings-v1") || "").indexOf("instagram:orbitfox") >= 0, null, { timeout: 10000 }).catch(() => fail("the account was not added"));
    if (releasePut) releasePut();

    await first.waitForTimeout(900);
    const saved = sync["token-a"];
    if (!saved || !saved.payload || !(saved.payload.feedTabs || []).some((tab) => tab.name === "Cedar" && (tab.members || []).indexOf("instagram:orbitfox") >= 0)) {
      fail("device A did not upload the tab " + JSON.stringify(saved && saved.payload && saved.payload.feedTabs));
    }

    const second = await openDevice(browser, port, "token-a", "user_a", "100000000001");
    await second.waitForFunction(() => {
      const raw = localStorage.getItem("viktorychapp-settings-v1") || "";
      return raw.indexOf("Cedar") >= 0 && raw.indexOf("instagram:orbitfox") >= 0;
    }, null, { timeout: 20000 }).catch(() => fail("device B did not receive the tabs"));
    const seen = JSON.parse(await second.evaluate(() => localStorage.getItem("viktorychapp-settings-v1") || "{}"));
    function shownOrder(tabs) {
      return (tabs || []).filter((tab) => !(Number(tab.deletedAt) >= Number(tab.updatedAt || 0) && tab.deletedAt)).slice().sort((a, b) => {
        const ha = typeof a.pos === "number";
        const hb = typeof b.pos === "number";
        if (ha && hb && a.pos !== b.pos) return a.pos - b.pos;
        if (ha !== hb) return ha ? -1 : 1;
        return 0;
      }).map((tab) => tab.name);
    }
    const order = shownOrder(seen.feedTabs);
    const uploaded = shownOrder(saved.payload.feedTabs);
    if (order.join(",") !== uploaded.join(",")) fail("device B order " + order.join(",") + " != " + uploaded.join(","));
    await second.waitForFunction((expected) => {
      const names = [...document.querySelectorAll(".tabs button.tab span")].map((el) => (el.textContent || "").trim()).filter((name) => name === "Cedar" || name === "Birch");
      return names.join(",") === expected;
    }, order.join(","), { timeout: 15000 }).catch(async () => {
      const html = await second.evaluate(() => [...document.querySelectorAll("[role=tablist]")].map((el) => (el.getAttribute("aria-label") || el.className) + "=" + (el.innerText || "").replace(/\s+/g, " ").slice(0, 120)).join(" || ") || "no tablists");
      fail("device B showed a different tab order [" + html + "]");
    });
    const older = JSON.parse(JSON.stringify(seen));
    older.feedTabs = older.feedTabs.map((tab) => Object.assign({}, tab, { pos: tab.name === "Cedar" ? 0 : 1, posAt: 1 }));
    const cedar = older.feedTabs.find((tab) => tab.name === "Cedar");
    if (cedar) {
      cedar.members = (cedar.members || []).filter((id) => id !== "instagram:orbitfox");
      cedar.memberDrops = Object.assign({}, cedar.memberDrops || {}, { "instagram:orbitfox": 1 });
    }
    await second.evaluate((raw) => localStorage.setItem("viktorychapp-settings-v1", raw), JSON.stringify(older));
    await second.reload({ waitUntil: "domcontentloaded" });
    await second.waitForSelector(".topbar, header.nav", { timeout: 15000 });
    await second.waitForFunction((expected) => {
      const raw = JSON.parse(localStorage.getItem("viktorychapp-settings-v1") || "{}");
      const tabs = raw.feedTabs || [];
      const named = tabs.filter((tab) => tab.name === "Cedar" || tab.name === "Birch").slice().sort((a, b) => Number(a.pos) - Number(b.pos)).map((tab) => tab.name);
      const member = tabs.some((tab) => tab.name === "Cedar" && (tab.members || []).indexOf("instagram:orbitfox") >= 0);
      return named.join(",") === expected && member;
    }, order.join(","), { timeout: 15000 }).catch(async () => {
      const raw = await second.evaluate(() => localStorage.getItem("viktorychapp-settings-v1") || "");
      fail("reload put back an older order or dropped the account " + raw);
    });
    await second.waitForFunction((expected) => {
      const names = [...document.querySelectorAll(".tabs button.tab span")].map((el) => (el.textContent || "").trim()).filter((name) => name === "Cedar" || name === "Birch");
      return names.join(",") === expected;
    }, order.join(","), { timeout: 15000 }).catch(() => fail("the tab bar lost the order after reload"));

    const other = await openDevice(browser, port, "token-b", "user_b", "100000000002");
    await other.waitForTimeout(1500);
    const otherRaw = await other.evaluate(() => localStorage.getItem("viktorychapp-settings-v1") || "");
    if (otherRaw.indexOf("Cedar") >= 0 || otherRaw.indexOf("Birch") >= 0) fail("another account received the tabs");
    if (sync["token-b"] && sync["token-b"].payload && (sync["token-b"].payload.feedTabs || []).some((tab) => tab.name === "Cedar")) {
      fail("the other account's sync stored the first account's tab");
    }
    if (first._errors.length) fail("page errors " + first._errors.slice(0, 2));
    await first._context.close();
    await second._context.close();
    await other._context.close();
    console.log("tab sync ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
