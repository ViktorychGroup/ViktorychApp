/* The Notifications badge on desktop equals the unread rows the list shows
   and clears once they are viewed. A server unread count for notes this
   device has not listed (or an old incremental cursor over an empty list)
   must not leave "8" or "10" over an empty page. New users, and users who
   never changed them, get every notification type on. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const fail = (msg) => problems.push(msg);

function startServer() {
  const shared = sharedStaticServer();
  if (shared) return Promise.resolve(shared);
  const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
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

function initScript(opts) {
  const settings = Object.assign({ version: 1, initialized: true, bellNotes: [] }, opts.settings || {});
  return `(() => {
    if (sessionStorage.getItem("nb-seeded")) return;
    sessionStorage.setItem("nb-seeded", "1");
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", ${JSON.stringify(JSON.stringify(settings))});
    ${opts.signed ? `localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A" } }));` : `localStorage.removeItem("viktorychapp-account-v1");`}
    ${opts.server ? `localStorage.setItem("viktorychapp-notes-server", ${JSON.stringify(JSON.stringify(opts.server))});` : ""}
  })()`;
}

const READ = `(() => {
  const badge = document.querySelector('a[href="#/notifications"] .nav-badge');
  const rows = Array.from(document.querySelectorAll("[data-notes-state] .note-row"));
  let server = {};
  try { server = JSON.parse(localStorage.getItem("viktorychapp-notes-server") || "{}"); } catch (err) {}
  return {
    badge: badge ? badge.textContent.trim() : "",
    route: location.hash,
    state: (document.querySelector("[data-notes-state]") || { getAttribute: () => "" }).getAttribute("data-notes-state"),
    rows: rows.length,
    serverUnread: Number(server.unread) || 0,
    prefs: window.ViktorychNotePrefs ? window.ViktorychNotePrefs() : null
  };
})()`;

async function open(browser, port, opts, handler) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const posts = [];
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = req.url();
    if (!url.includes("/v1/notifications")) { await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); return; }
    let body = null;
    try { body = req.postDataJSON(); } catch (err) { body = null; }
    if (body) posts.push(body);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(handler(new URL(url), body)) });
  });
  await page.addInitScript(initScript(opts));
  await page.goto("http://127.0.0.1:" + port + "/index.html#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!document.querySelector('a[href="#/notifications"]'), null, { timeout: 20000 });
  return { context, page, posts };
}

const settle = (page, ms) => page.waitForTimeout(ms || 1500);

function likes(n) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => ({ id: "n" + i, at: now - i * 1000, kind: "like", handle: "user_" + i, name: "User " + i, text: "liked", hash: "#/", read: false }));
}

async function visit(page) {
  await page.evaluate(() => { location.hash = "#/notifications"; });
  await page.waitForSelector("[data-notes-state]", { timeout: 15000 });
  await settle(page, 1800);
  const inside = await page.evaluate(READ);
  await page.evaluate(() => { location.hash = "#/"; });
  await settle(page, 1200);
  const after = await page.evaluate(READ);
  return { inside, after };
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    // 1. Old cursor over an empty local list: the server sends only newer
    //    notes, but says 10 unread. The app must pull the full list.
    {
      const s = await open(browser, port, { signed: true, server: { cursor: 50, unread: 10, readUntil: 0 } }, (url) => (
        url.searchParams.get("since")
          ? { items: [], unread: 10, readUntil: 0, cursor: 60, tabs: [] }
          : { items: likes(3), unread: 3, readUntil: 0, cursor: 60, tabs: [] }
      ));
      await settle(s.page, 2500);
      const home = await s.page.evaluate(READ);
      const seen = await visit(s.page);
      if (home.badge !== "3") fail("stale cursor: badge " + JSON.stringify(home.badge) + ", want 3");
      if (seen.inside.rows !== 3) fail("stale cursor: list shows " + seen.inside.rows + " rows (" + seen.inside.state + "), want 3");
      if (home.badge && Number(home.badge) !== seen.inside.rows) fail("stale cursor: badge " + home.badge + " != rows " + seen.inside.rows);
      if (seen.after.badge) fail("stale cursor: badge " + seen.after.badge + " after viewing");
      await s.context.close();
    }
    // 2. The server counts 8 unread this build does not list: no badge, and
    //    viewing the empty list sends a read cursor and clears the count.
    {
      const s = await open(browser, port, { signed: true, server: { cursor: 5, unread: 8, readUntil: 0 } }, () => (
        { items: [], unread: 8, readUntil: 0, cursor: 5, tabs: [] }
      ));
      await settle(s.page, 2500);
      const home = await s.page.evaluate(READ);
      const seen = await visit(s.page);
      await settle(s.page, 2500);
      if (home.badge) fail("phantom count: badge " + home.badge + " over an empty list");
      if (seen.inside.rows !== 0) fail("phantom count: list shows " + seen.inside.rows + " rows");
      if (seen.after.badge) fail("phantom count: badge " + seen.after.badge + " after viewing");
      if (!s.posts.some((body) => Number(body.until) > 0)) fail("phantom count: viewing did not send a read cursor");
      await s.context.close();
    }
    // 3. Five unread with two dismissed: the badge says 3, matching the rows.
    {
      const s = await open(browser, port, { signed: true, settings: { noteDismissed: ["n0", "n1"] } }, () => (
        { items: likes(5), unread: 5, readUntil: 0, cursor: 9, tabs: [] }
      ));
      await settle(s.page, 2500);
      const home = await s.page.evaluate(READ);
      const seen = await visit(s.page);
      if (String(seen.inside.rows) !== home.badge) fail("dismissed: badge " + JSON.stringify(home.badge) + " != rows " + seen.inside.rows);
      if (seen.after.badge) fail("dismissed: badge " + seen.after.badge + " after viewing");
      await s.context.close();
    }
    // 4. Defaults: all on for a new user and for an old saved copy of the
    //    defaults; a person's own choice stays.
    {
      const kinds = ["mentions", "replies", "quotes", "likes", "reposts", "follows", "dms", "games"];
      const cases = [
        { name: "new user", settings: {}, want: {} },
        { name: "old defaults", settings: { notePrefs: { mentions: "push", likes: "inapp", reposts: "inapp", dms: "off" } }, want: { dms: "off" } },
        { name: "own choice", settings: { notePrefs: { likes: "inapp", reposts: "inapp" }, notePrefsSet: ["likes"] }, want: { likes: "inapp" } }
      ];
      for (const c of cases) {
        const s = await open(browser, port, { signed: false, settings: c.settings }, () => ({ items: [], unread: 0, readUntil: 0, cursor: 0, tabs: [] }));
        const info = await s.page.evaluate(READ);
        kinds.forEach((kind) => {
          const want = c.want[kind] || "push";
          if (!info.prefs || info.prefs[kind] !== want) fail(c.name + ": " + kind + " is " + (info.prefs && info.prefs[kind]) + ", want " + want);
        });
        await s.context.close();
      }
    }
  } finally {
    await browser.close();
    if (server.close && !sharedStaticServer()) server.close();
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("notification badge ok: matches visible unread, clears on view, defaults all on");
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
