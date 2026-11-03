/* Interface packs: only the language in use downloads at boot, and
   switching language later fetches the new pack and applies it. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(process.env.PLAYWRIGHT_CORE).href : "playwright-core");
const chromium = pw.chromium || pw.default.chromium;
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml" };

function fail(msg) { throw new Error("i18n packs: " + msg); }

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port + "/index.html#/home";
const browser = await chromium.launch({ headless: true, channel: "chrome" });

async function visit(lang) {
  const ctx = await browser.newContext({ serviceWorkers: "block", viewport: { width: 390, height: 844 }, timezoneId: "America/New_York", locale: "en-US" });
  await ctx.addInitScript((code) => {
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A" } }));
    localStorage.setItem("superintelapp-lang", code);
  }, lang);
  await ctx.route("**/v1/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "" }));
  const packs = [];
  ctx.on("request", (req) => { const m = /\/i18n\/(\w+)\.js/.exec(req.url()); if (m) packs.push(m[1]); });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.SI18n && document.querySelectorAll("#app article.post").length >= 1, null, { timeout: 30000 });
  return { ctx, page, packs };
}

try {
  const en = await visit("en");
  if (en.packs.join(",") !== "en") fail("English boot downloaded " + en.packs.join(","));
  await en.page.evaluate(() => window.SI18n.setLang("es"));
  await en.page.waitForFunction(() => window.SI18n.t("Home") === "Inicio", null, { timeout: 10000 });
  if (en.packs.indexOf("es") < 0) fail("switching to Spanish did not fetch the pack");
  await en.ctx.close();

  const ru = await visit("ru");
  if (ru.packs.join(",") !== "ru") fail("Russian boot downloaded " + ru.packs.join(","));
  /* The pack is a late script, so the first posts can draw before it lands. */
  await ru.page.waitForFunction(() => window.SI18n.t("Home") !== "Home", null, { timeout: 10000 }).catch(() => {});
  const home = await ru.page.evaluate(() => window.SI18n.t("Home"));
  if (home === "Home") fail("Russian pack not applied");
  await ru.ctx.close();

  const hi = await visit("hi");
  if (hi.packs.join(",") !== "hi") fail("Hindi boot downloaded " + hi.packs.join(","));
  await hi.page.waitForFunction(() => window.SI18n.t("Home") !== "Home", null, { timeout: 10000 }).catch(() => {});
  const hiHome = await hi.page.evaluate(() => ({ home: window.SI18n.t("Home"), lang: document.documentElement.lang, big: window.SI18n.formatInt(1234567) }));
  if (!/[\u0900-\u097F]/.test(hiHome.home)) fail("Hindi pack not applied");
  if (!/^hi\b/.test(hiHome.lang)) fail("Hindi did not set the page language");
  if (hiHome.big !== "12,34,567") fail("Hindi numbers should use lakh grouping, got " + hiHome.big);
  await hi.ctx.close();
  console.log("i18n pack check passed");
} finally {
  await browser.close();
  server.close();
}
