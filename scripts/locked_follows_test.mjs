// Locked follows, end to end on a phone-sized page: lock a follow from the
// profile menu, see it leave the Following list and count, open the Locked
// area by pulling down on the list, unlock the follow and see it come back.
// A static server plus an in-process Worker (D1) stand in for production;
// every account is a dummy made here.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.js node scripts/locked_follows_test.mjs
//   LF_SHOTS=/tmp/shots LF_LANGS=en,es   (optional screenshots, languages)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFromWorker = createRequire(path.join(root, "worker/package.json"));
const { Miniflare } = requireFromWorker("miniflare");
const SHOTS = process.env.LF_SHOTS || "";
const LANGS = (process.env.LF_LANGS || "en").split(",").map((s) => s.trim()).filter(Boolean);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8"
};

function fail(msg) { throw new Error(msg); }

function newWorker(origin) {
  return new Miniflare({
    modules: true,
    scriptPath: path.join(root, "worker/src/index.js"),
    modulesRoot: root,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: { ACCOUNT_PEPPER: "pepper-test", OWNER_CLAIM_CODE: "claim-test", OWNER_HANDLE: "owner_test", ALLOWED_ORIGINS: origin, PBKDF2_ITERATIONS: "1000" }
  });
}

let ipN = 1;
async function api(worker, origin, p, opts = {}) {
  const headers = { origin, "cf-connecting-ip": "203.0.113." + ((ipN++ % 200) + 1) };
  if (opts.token) headers.authorization = "Bearer " + opts.token;
  if (opts.body) headers["content-type"] = "application/json";
  const res = await worker.dispatchFetch("https://accounts.test" + p, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (err) { body = null; }
  return { status: res.status, body };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function startServer(state) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, state.origin || "http://127.0.0.1");
      if (url.pathname === "/accounts.config.js") {
        res.writeHead(200, { "content-type": TYPES[".js"], "cache-control": "no-store" });
        res.end("window.VIKTORYCH_ACCOUNTS = " + JSON.stringify({ api: state.origin, gate: true, turnstileSiteKey: "" }) + ";\n");
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        const body = await readBody(req);
        const headers = { origin: state.origin, "cf-connecting-ip": "203.0.113." + ((ipN++ % 200) + 1) };
        for (const name of ["content-type", "authorization", "accept", "x-locked-grant"]) if (req.headers[name]) headers[name] = req.headers[name];
        const up = await state.worker.dispatchFetch("https://accounts.test" + url.pathname + url.search, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
        const out = Buffer.from(await up.arrayBuffer());
        res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json", "cache-control": "no-store" });
        res.end(out);
        return;
      }
      if (/^\/(data|tv)\//.test(url.pathname) && !fs.existsSync(path.join(root, url.pathname))) { res.writeHead(404); res.end(); return; }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.resolve(root, "." + rel);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end("missing"); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500); res.end("server error");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { state.origin = "http://127.0.0.1:" + server.address().port; resolve(server); }));
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const mod = await import(spec.startsWith("/") ? pathToFileURL(spec).href : spec);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

// The following count shown on your own profile header.
async function followingCount(page) {
  return page.evaluate(() => {
    const link = Array.from(document.querySelectorAll(".counts a, .profile-counts a, a")).find((a) => /\/following$/.test(a.getAttribute("href") || ""));
    const text = link ? link.textContent || "" : "";
    const m = text.replace(/[\s,.]/g, "").match(/^\d+/);
    return m ? Number(m[0]) : -1;
  });
}

async function run(chromium, lang) {
  const state = { origin: "", worker: null };
  const server = await startServer(state);
  state.worker = newWorker(state.origin);
  const o = state.origin;
  const sign = async (handle, name) => {
    const r = await api(state.worker, o, "/v1/signup", { method: "POST", body: { handle, displayName: name } });
    if (r.status !== 201) fail("signup " + handle + " " + r.status);
    return r.body;
  };
  const me = await sign("lf_ana", "Ana Demo");
  const bo = await sign("lf_bo", "Bo Demo");
  const cy = await sign("lf_cy", "Cy Demo");
  for (const who of [bo, cy]) {
    const f = await api(state.worker, o, "/v1/follows", { method: "PUT", token: me.token, body: { id: "app:@" + who.account.handle } });
    if (f.status !== 200) fail("follow " + f.status);
  }
  await api(state.worker, o, "/v1/posts", { method: "POST", token: bo.token, body: { body: lang === "es" ? "Hola desde Bo" : "Hello from Bo" } });
  // The code is set up through the API so the run can focus on the sheets
  // a person sees every day; the setup sheet itself is shot below.
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err && err.message || err)));
  await page.addInitScript(([session, lng]) => {
    localStorage.setItem("superintelapp-lang", lng);
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify(session));
  }, [{ token: me.token, account: me.account }, lang]);
  const T = (en, es) => (lang === "es" ? es : en);
  try {
    // 1. Profile ⋯ menu → Lock follow → first-time setup → secret code.
    await page.goto(o + "/#/@lf_bo", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.ViktorychLocked && window.ViktorychAccounts && window.ViktorychAccounts.token && window.ViktorychAccounts.token(), null, { timeout: 30000 });
    await page.waitForSelector('[data-act="profile-more"]', { timeout: 30000 });
    await page.waitForFunction(() => (JSON.parse(localStorage.getItem("superintelapp-settings") || "null") || {}) && true);
    await page.waitForTimeout(1500);
    await page.click('[data-act="profile-more"]');
    if (process.env.LF_DEBUG) { await page.waitForTimeout(1000); console.log(await page.evaluate(() => ({ menu: Array.from(document.querySelectorAll(".profile-menu [data-act], [role=menu] [data-act], [role=menu] [data-acct]")).map((b) => (b.dataset.act || b.dataset.acct) + ":" + b.textContent.trim()), hash: location.hash }))); await page.screenshot({ path: "/tmp/lf/debug.png" }); }
    await page.waitForSelector('[data-act="profile-lock-follow"]', { timeout: 15000 });
    await shot(page, "01-profile-menu-" + lang + ".png");
    await page.click('[data-act="profile-lock-follow"]');
    await page.waitForSelector(".lf-sheet");
    await page.click('[data-lf-act="setup-code"]');
    await page.fill('.lf-sheet [name="code"]', "7391zx");
    await page.fill('.lf-sheet [name="again"]', "7391zx");
    await shot(page, "02-create-code-" + lang + ".png");
    await page.click('.lf-sheet button[type="submit"]');
    await page.waitForSelector('[data-lf-act="do-lock"]', { timeout: 15000 });
    await shot(page, "03-lock-confirm-" + lang + ".png");
    await page.click('[data-lf-act="do-lock"]');
    await page.waitForFunction((t) => (document.querySelector(".lf-sheet .lf-title") || {}).textContent === t, T("Follow locked", "Seguimiento bloqueado"), { timeout: 15000 });
    await shot(page, "04-locked-done-" + lang + ".png");
    await page.click('.lf-sheet [data-lf-act="close-sheet"]');

    // 2. Hidden: own Following list and count no longer show Bo.
    await page.goto(o + "/#/@lf_ana", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => /\/following$/.test((Array.from(document.querySelectorAll("a")).find((a) => /\/following$/.test(a.getAttribute("href") || "")) || {}).getAttribute ? "x/following" : ""), null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const count = await followingCount(page);
    if (count !== 1) fail("following count should be 1 while locked, got " + count);
    await shot(page, "05-profile-count-hidden-" + lang + ".png");
    await page.goto(o + "/#/@lf_ana/following", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".lf-pull-host .connect-row", { timeout: 20000 });
    const rows = await page.locator(".lf-pull-host .connect-row").allTextContents();
    if (rows.some((r) => /lf_bo/.test(r))) fail("locked follow still listed");
    if (!rows.some((r) => /lf_cy/.test(r))) fail("unlocked follow missing");
    const hints = await page.evaluate(() => document.body.innerText);
    if (/hidden|ocult/i.test(hints.split("\n").filter((l) => /\d/.test(l)).join(" "))) fail("a hidden-count hint leaked");
    await shot(page, "06-following-hidden-" + lang + ".png");

    // 3. Pull down on the list → the way in → unlock with the code.
    const box = await page.locator(".lf-pull-host").boundingBox();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.mouse.move(box.x + 120, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 140, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector(".lf-pull.on", { timeout: 5000 });
    await shot(page, "07-pull-down-" + lang + ".png");
    await page.click('[data-lf-act="pull-open"]');
    if (process.env.LF_DEBUG) { await page.waitForTimeout(2000); console.log(await page.evaluate(() => ({ root: (document.getElementById("lf-root") || {}).innerHTML, unl: window.ViktorychLocked.unlocked() }))); }
    await page.waitForSelector('.lf-sheet [name="code"]');
    await page.fill('.lf-sheet [name="code"]', "0000xx");
    await page.click('.lf-sheet button[type="submit"]');
    await page.waitForSelector(".lf-error");
    await page.fill('.lf-sheet [name="code"]', "7391zx");
    await shot(page, "08-unlock-" + lang + ".png");
    await page.click('.lf-sheet button[type="submit"]');
    await page.waitForSelector(".lf-area .lf-person", { timeout: 15000 });
    const people = await page.locator(".lf-area .lf-person").allTextContents();
    if (!people.some((r) => /lf_bo/.test(r))) fail("Locked area does not list the locked follow");
    await shot(page, "09-locked-area-" + lang + ".png");
    await page.click('.lf-tab[data-tab="posts"]');
    await page.waitForSelector(".lf-area .lf-post", { timeout: 15000 });
    await shot(page, "10-locked-posts-" + lang + ".png");

    // 4. Unlock the follow: it comes back to the list and the count.
    await page.click('.lf-tab[data-tab="people"]');
    await page.click('.lf-area [data-lf-act="unlock-follow"]');
    await page.waitForSelector(".lf-area .lf-empty", { timeout: 15000 });
    await page.click('[data-lf-act="close-area"]');
    await page.waitForTimeout(1500);
    await page.goto(o + "/#/@lf_ana", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const after = await followingCount(page);
    if (after !== 2) fail("following count should be 2 after unlocking, got " + after);

    // 5. Settings > Privacy > Locked follows needs an unlock (relocked on leave).
    await page.goto(o + "/#/settings/locked-follows", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-lf-act="settings-unlock"], [data-lf-act="open-area"]', { timeout: 15000 });
    await shot(page, "11-settings-" + lang + ".png");
    const bad = errors.filter((e) => !/Failed to fetch|NetworkError|Load failed/i.test(e));
    if (bad.length) fail("page errors: " + bad.join(" | "));
    console.log("locked follows ok (" + lang + ")");
  } finally {
    await browser.close();
    server.close();
    await state.worker.dispose();
  }
}

const chromium = await loadPlaywright();
if (!chromium) fail("Playwright chromium is missing");
for (const lang of LANGS) await run(chromium, lang);
