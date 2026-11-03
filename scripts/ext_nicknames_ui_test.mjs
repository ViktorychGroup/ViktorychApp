/* Custom names for any account: a private name set from an external profile
   shows in the timeline and on the profile (and the original name does not),
   the Settings > Usernames list carries it, and "Reset to" brings the real
   name back. Made-up accounts only. Set SHOTS=<dir> to save phone screenshots. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.PLAYWRIGHT_CORE) {
  console.log("ext nicknames browser check skipped (set PLAYWRIGHT_CORE)");
  process.exit(0);
}
const pw = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
const chromium = pw.chromium || pw.default.chromium;
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const SHOTS = process.env.SHOTS || "";
const LANG = process.env.NICK_LANG || "es";

function fail(msg) { throw new Error("ext nicknames: " + msg); }

const people = [
  { h: "luna_demo", name: "Luna Demo" },
  { h: "rio_ejemplo", name: "Río Ejemplo" },
  { h: "sol_muestra", name: "Sol Muestra" }
];
const ext = new Map();
let base = "";

function catalog() {
  const now = Date.now();
  const feeds = people.map((p) => ({ id: "x:" + p.h, platform: "x", handle: p.h, name: p.name, avatar: "", configured: true }));
  const posts = [];
  people.forEach((p, i) => {
    for (let n = 0; n < 3; n++) {
      const id = String(7100000 + i * 10 + n);
      posts.push({
        id, statusId: id, platform: "x", feedId: "x:" + p.h, kind: "post", author: p.name, handle: p.h, avatar: "",
        text: ["Buenos días desde el ejemplo.", "Probando nombres personalizados.", "Otra publicación de prueba."][n],
        links: [], date: new Date(now - (n * 3 + i) * 600000).toISOString(), url: "", repostedBy: null, replyingTo: null, quoted: null,
        media: [], images: [], stats: { replies: 1, reposts: 2, likes: 5 }
      });
    }
  });
  return { updated: new Date(now).toISOString(), feeds, posts };
}

function body(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch (err) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  let p = decodeURIComponent(url.pathname);
  const json = (status, obj) => {
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, PUT, DELETE, POST, OPTIONS" });
    res.end(JSON.stringify(obj));
  };
  if (req.method === "OPTIONS") return json(204, {});
  if (p === "/v1/data/feeds.json") return json(200, catalog());
  if (p === "/v1/nicknames/external") {
    if (req.method === "GET") return json(200, { nicknames: Array.from(ext.entries()).map(([key, v]) => ({ key, name: v.name, at: v.at })) });
    const b = await body(req);
    const key = String(b.key || "");
    if (!/^[a-z][a-z0-9_-]*:.+/.test(key)) return json(400, { error: "bad_key" });
    const name = req.method === "DELETE" ? "" : String(b.name || "").trim().slice(0, 50);
    if (name) ext.set(key, { name, at: Date.now() }); else ext.delete(key);
    return json(200, { key, name });
  }
  if (p === "/v1/nicknames") return json(200, { nicknames: [] });
  if (p === "/v1/usernames") return json(200, { names: [{ handle: "user_demo", primary: true, audience: { include: { public: true } } }], cap: 5, releaseDays: 30 });
  if (p === "/v1/audience-lists") return json(200, { lists: [] });
  if (p === "/v1/usernames/mentions") return json(200, { policy: "everyone" });
  if (p === "/v1/usernames/friend-name") return json(200, { name: "" });
  if (p.startsWith("/v1/data/live/")) return json(200, { posts: [] });
  if (p.startsWith("/v1/")) return json(200, {});
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(""); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = "http://127.0.0.1:" + server.address().port;

const settings = {
  version: 1, initialized: true, follows: people.map((p) => "x:" + p.h), seenFeeds: people.map((p) => "x:" + p.h), seenDefaults: people.map((p) => "x:" + p.h),
  lists: [], likes: {}, bookmarks: {}, reposts: {}, savedPosts: {}, mutedWords: [], mutedAccounts: [], repostOff: []
};

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForFunction(() => { const t = document.getElementById("toast"); return !t || t.hidden; }, null, { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, name) });
}

const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || "chrome" });
try {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: LANG });
  await ctx.addInitScript(([api, settingsText, lang]) => {
    window.VIKTORYCH_ACCOUNTS = { api: api, backupApi: "", gate: true, tiktokAudience: "owner" };
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-demo", account: { publicId: "100000000001", handle: "user_demo", displayName: "Usuario Demo" } }));
      localStorage.setItem("viktorychapp-settings-v1", settingsText);
      localStorage.setItem("superintelapp-lang", lang);
      localStorage.setItem("viktorychapp-lang-user-picked", "1");
      localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 9, done: true }));
    }
  }, [base, JSON.stringify(settings), LANG]);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err && err.message || err)));

  const NICK = "Mi amiga Luna";
  const ORIGINAL = "Luna Demo";
  const lunaNames = () => page.evaluate(() => Array.from(document.querySelectorAll("#app article.post")).filter((a) => /@luna_demo\b/.test(a.textContent)).map((a) => (a.querySelector(".byline .name, .name") || {}).textContent || ""));

  // 1. The external profile has the pen; the sheet opens with the name field.
  await page.goto(base + "/index.html#/@luna_demo", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#app .pname [data-act="nick-edit"]', { timeout: 30000 });
  await page.click('#app .pname [data-act="nick-edit"]');
  await page.waitForSelector(".nick-sheet [data-nick-input]", { timeout: 5000 });
  if (await page.$(".nick-sheet .nick-reset")) fail("a fresh account must not offer a reset");
  await page.fill(".nick-sheet [data-nick-input]", NICK);
  await shot(page, "1-editar-nombre-sheet.png");
  await page.click('.nick-sheet [data-nick="save"]');
  await page.waitForSelector(".nick-sheet", { state: "detached", timeout: 5000 });

  // 2. The profile shows only the custom name; the original is nowhere.
  await page.waitForFunction((n) => (document.querySelector("#app .pname") || {}).textContent.indexOf(n) >= 0, NICK, { timeout: 5000 });
  const profileText = await page.evaluate(() => document.querySelector("#app").innerText);
  if (profileText.indexOf(ORIGINAL) >= 0) fail("the original name still shows on the profile");
  if (/Nombre original|Original name/i.test(profileText)) fail("no original-name line");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "3-perfil-con-nombre.png");
  await page.waitForFunction(() => true);
  for (let i = 0; i < 20 && !ext.has("x:luna_demo"); i++) await page.waitForTimeout(150);
  if (!ext.has("x:luna_demo") || ext.get("x:luna_demo").name !== NICK) fail("the name did not reach the server under x:luna_demo");

  // 3. The timeline shows the custom name on her posts.
  await page.goto(base + "/index.html#/home", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#app article.post").length >= 3, null, { timeout: 30000 });
  await page.waitForFunction((n) => Array.from(document.querySelectorAll("#app article.post")).some((a) => a.textContent.indexOf(n) >= 0), NICK, { timeout: 8000 });
  // The home feed can repaint (or the page reload once) while it settles, so poll for the other names.
  let homeText = "";
  for (let i = 0; i < 40; i++) {
    homeText = await page.evaluate(() => (document.querySelector("#app") || document.body).innerText).catch(() => "");
    if (/R\u00edo Ejemplo|Sol Muestra/.test(homeText) && homeText.indexOf(NICK) >= 0) break;
    await page.waitForTimeout(200);
  }
  if (homeText.indexOf(ORIGINAL) >= 0) fail("the original name still shows in the timeline");
  if (homeText.indexOf("Río Ejemplo") < 0 && homeText.indexOf("Sol Muestra") < 0) fail("other accounts must keep their names: " + homeText.slice(0, 600));
  await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("#app article.post")).find((el) => /@luna_demo\b/.test(el.textContent));
    if (a) window.scrollTo(0, Math.max(0, a.getBoundingClientRect().top + window.scrollY - 260));
  });
  await shot(page, "2-timeline-con-nombre.png");

  // 4. Settings > Usernames lists it with the network and edit/remove.
  await page.goto(base + "/index.html#/settings/usernames", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('.un-ext[data-nick-key="x:luna_demo"]', { timeout: 15000 });
  await page.evaluate(() => { const r = document.querySelector(".un-ext"); if (r) r.scrollIntoView({ block: "center" }); });
  await shot(page, "4-ajustes-apodos.png");
  // X-native settings: no raw browser form controls in the nicknames list.
  const raw = await page.evaluate(() => {
    const list = document.querySelector(".xn-list");
    if (!list) return "missing .xn-list";
    const bad = Array.from(list.querySelectorAll("select, input, textarea")).map((el) => el.outerHTML.slice(0, 80));
    return bad.join(" | ");
  });
  if (raw) fail("raw form controls in Settings nicknames: " + raw);
  // Tapping the row opens the same Edit name sheet.
  await page.click('.un-ext[data-nick-key="x:luna_demo"]');
  await page.waitForSelector(".nick-sheet .nick-reset", { timeout: 5000 });
  await page.click('.nick-sheet [data-nick="close"]');
  // "Add a custom name": X radio rows for the network, floating-label fields.
  await page.click('[data-un="nick-add"]');
  await page.waitForSelector('.nick-sheet [data-nick="pick"]', { timeout: 5000 });
  if (await page.$(".nick-sheet select")) fail("the add sheet uses a raw <select>");
  await page.click('.nick-sheet [data-nick="pick"]');
  await page.waitForSelector('.nick-sheet [data-nick="net"][data-net="bluesky"]', { timeout: 5000 });
  await shot(page, "6-anadir-nombre-red.png");
  await page.click('.nick-sheet [data-nick="net"][data-net="bluesky"]');
  await page.fill(".nick-sheet [data-nick-acct]", "@nube.example.com");
  await page.fill(".nick-sheet [data-nick-input]", "Nube Prueba");
  await shot(page, "7-anadir-nombre-sheet.png");
  await page.click('.nick-sheet [data-nick="save"]');
  await page.waitForSelector('.un-ext[data-nick-key="bsky:nube.example.com"]', { timeout: 5000 });
  for (let i = 0; i < 20 && !ext.has("bsky:nube.example.com"); i++) await page.waitForTimeout(150);
  if (!ext.has("bsky:nube.example.com")) fail("the added name did not reach the server: " + Array.from(ext.keys()).join(","));
  await page.click('.un-ext[data-nick-key="bsky:nube.example.com"]');
  await page.waitForSelector(".nick-sheet .nick-reset", { timeout: 5000 });
  await page.click(".nick-sheet .nick-reset");
  await page.waitForFunction(() => !document.querySelector('.un-ext[data-nick-key="bsky:nube.example.com"]'), null, { timeout: 5000 });

  // 5. Reset brings the real name back, everywhere, and clears the server.
  await page.goto(base + "/index.html#/@luna_demo", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('#app .pname [data-act="nick-edit"]', { timeout: 15000 });
  await page.click('#app .pname [data-act="nick-edit"]');
  await page.waitForSelector(".nick-sheet .nick-reset", { timeout: 5000 });
  const resetText = await page.textContent(".nick-sheet .nick-reset");
  if (resetText.indexOf(ORIGINAL) < 0) fail("the reset button names the original: " + resetText);
  await shot(page, "5-restablecer-sheet.png");
  await page.click(".nick-sheet .nick-reset");
  await page.waitForFunction((n) => (document.querySelector("#app .pname") || {}).textContent.indexOf(n) >= 0, ORIGINAL, { timeout: 5000 });
  for (let i = 0; i < 20 && ext.has("x:luna_demo"); i++) await page.waitForTimeout(150);
  if (ext.has("x:luna_demo")) fail("reset did not remove the server copy");
  await page.goto(base + "/index.html#/home", { waitUntil: "domcontentloaded" });
  await page.waitForFunction((n) => Array.from(document.querySelectorAll("#app article.post")).some((a) => a.textContent.indexOf(n) >= 0), ORIGINAL, { timeout: 8000 });
  const after = await page.evaluate(() => document.querySelector("#app").innerText);
  if (after.indexOf(NICK) >= 0) fail("the custom name stayed after reset");
  const own = errors.filter((e) => /nick/i.test(e));
  if (own.length) fail("page errors: " + own.join(" | "));
  console.log("ext nicknames ui ok", JSON.stringify({ lang: LANG, shots: SHOTS || "off", pageErrors: errors.length }));
  await ctx.close();
} finally {
  await browser.close();
  server.close();
}
