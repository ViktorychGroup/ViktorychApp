/* Edit profile in X's native sheet, on phone and desktop: opens from the
   profile, edits and saves (PATCH /v1/profile plus the birth date in About),
   asks before discarding unsaved changes, and reaches the Usernames
   subpage and back. Placeholder accounts only. */
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
const ACCOUNT = { handle: "cedarhill", publicId: "100000000001", displayName: "Cedar Hill", bio: "Placeholder bio.", location: "Example Town", website: "example.com" };

function session(lang) {
  return `(() => {
    localStorage.setItem("superintelapp-lang", ${JSON.stringify(lang)});
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: ${JSON.stringify(ACCOUNT)} }));
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true };
  })()`;
}

function mock(page, log) {
  const names = { names: [
    { handle: "cedarhill", primary: true, audience: { include: { public: true, followers: false, friends: false, lists: [], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } } },
    { handle: "cedar_close", primary: false, audience: { include: { public: false, followers: false, friends: true, lists: [], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } } }
  ], listOrder: [], cap: 5, releaseDays: 30 };
  let account = Object.assign({}, ACCOUNT);
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  return page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
    if (method !== "GET") log.push(method + " " + url.pathname + " " + JSON.stringify(body));
    if (url.pathname === "/v1/usernames") return reply(route, 200, names);
    if (url.pathname === "/v1/audience-lists") return reply(route, 200, { lists: [] });
    if (url.pathname === "/v1/usernames/mentions") return reply(route, 200, { public: "anyone", followers: "", friends: "", lists: {}, allow: [], block: [] });
    if (url.pathname === "/v1/usernames/friend-name") return reply(route, 200, { name: "" });
    if (url.pathname === "/v1/nicknames") return reply(route, 200, { nicknames: [] });
    if (url.pathname === "/v1/about" && method === "GET") return reply(route, 200, { owner: true, visible: true, sections: [{ id: "personal", fields: [] }] });
    if (url.pathname === "/v1/about" && method === "POST") return reply(route, 201, { field: Object.assign({ id: "0123456789abcdef0123456789abcdef" }, body) });
    if (url.pathname === "/v1/profile" && method === "PATCH") { account = Object.assign({}, account, body); return reply(route, 200, { account }); }
    if (url.pathname.startsWith("/v1/profile/")) return reply(route, 200, { account, reposts: [] });
    return reply(route, 200, {});
  });
}

async function open(page, port) {
  await page.goto("http://127.0.0.1:" + port + "/index.html#/@cedarhill", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[data-acct="edit"]', { timeout: 20000 }).catch(() => fail("no Edit profile button"));
  await page.click('button[data-acct="edit"]');
  await page.waitForSelector(".ep #acct-displayName", { timeout: 5000 }).catch(() => fail("Edit profile did not open"));
}

async function check(browser, port, size, lang) {
  const label = lang + "@" + size.name;
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: "block" });
  const page = await context.newPage();
  const log = [];
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await mock(page, log);
  await page.addInitScript(session(lang));
  await open(page, port);

  /* Shape: full screen on a phone, a centred ~600px card on desktop. */
  const box = await page.evaluate(() => {
    const r = document.querySelector(".ep").getBoundingClientRect();
    const fields = Array.from(document.querySelectorAll(".ep .acct-field")).length;
    const over = Array.from(document.querySelectorAll(".ep *")).filter((el) => { const b = el.getBoundingClientRect(); return b.width && b.right > window.innerWidth + 1; }).length;
    return { x: r.left, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight, fields, over, title: document.querySelector(".ep .acct-edit-head h1").textContent, save: document.querySelector('.ep [data-acct="save-profile"]').textContent };
  });
  if (size.mobile && (Math.abs(box.w - box.vw) > 1 || box.h < box.vh - 2)) fail(label + ": phone sheet is not full screen " + JSON.stringify(box));
  if (!size.mobile && (Math.abs(box.w - 600) > 1 || Math.abs(box.x + box.w / 2 - box.vw / 2) > 2)) fail(label + ": desktop modal " + JSON.stringify(box));
  if (box.over) fail(label + ": " + box.over + " elements overflow");
  const want = { en: ["Edit profile", "Save"], es: ["Editar perfil", "Guardar"] }[lang];
  if (box.title !== want[0] || box.save !== want[1]) fail(label + ": head " + box.title + " / " + box.save);

  /* Unsaved changes ask first; Cancel keeps the edit. */
  await page.fill("#acct-displayName", "Cedar Ridge");
  await page.click('.ep [data-acct="close"]');
  await page.waitForSelector(".ep-confirm", { timeout: 3000 }).catch(() => fail(label + ": no discard prompt"));
  await page.click('[data-acct="discard-no"]');
  if ((await page.inputValue("#acct-displayName")) !== "Cedar Ridge") fail(label + ": cancel lost the edit");

  /* Usernames subpage and back to the same form. */
  await page.click('.ep [data-acct="edit-sub"][data-sub="usernames"]');
  await page.waitForSelector('.ep .un-in-edit [data-un="open-name"]', { timeout: 8000 }).catch(() => fail(label + ": usernames subpage did not load"));
  const ats = await page.$$eval(".ep .un-at", (els) => els.map((el) => el.textContent));
  if (ats.join() !== "@cedarhill,@cedar_close") fail(label + ": names " + ats);
  if (!(await page.$(".ep .xs-badge"))) fail(label + ": no Primary badge");
  await page.click('.ep [data-acct="edit-back"]');
  await page.waitForSelector(".ep #acct-displayName", { timeout: 3000 }).catch(() => fail(label + ": back did not return to the form"));
  if ((await page.inputValue("#acct-displayName")) !== "Cedar Ridge") fail(label + ": subpage lost the edit");

  /* Birth date, then save. */
  await page.click('.ep [data-acct="bday-edit"]');
  await page.click('[data-acct="bday-warn-yes"]');
  for (const [sheet, value] of [["month", "3"], ["day", "14"], ["year", "1995"]]) {
    await page.click('.ep [data-acct="ep-sheet"][data-sheet="' + sheet + '"]');
    await page.click('.ep-sheet [data-acct="ep-pick"][data-value="' + value + '"]');
  }
  await page.fill("#acct-bio", "Another placeholder bio.");
  await page.click('.ep [data-acct="save-profile"]');
  await page.waitForFunction(() => !document.querySelector(".ep"), null, { timeout: 5000 }).catch(() => fail(label + ": save did not close"));
  const patch = log.find((line) => line.indexOf("PATCH /v1/profile ") === 0);
  if (!patch) fail(label + ": no profile PATCH");
  const sent = JSON.parse(patch.slice(patch.indexOf("{")));
  if (sent.displayName !== "Cedar Ridge" || sent.bio !== "Another placeholder bio." || sent.website !== "example.com") fail(label + ": saved " + patch);
  const bday = log.find((line) => line.indexOf("POST /v1/about ") === 0);
  if (!bday || bday.indexOf('"kind":"birthday"') < 0 || bday.indexOf('"text":"1995-03-14"') < 0) fail(label + ": birth date " + bday);

  /* A clean form closes at once; Escape closes too. */
  await page.click('button[data-acct="edit"]');
  await page.waitForSelector(".ep #acct-displayName", { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".ep"), null, { timeout: 3000 }).catch(() => fail(label + ": clean form did not close"));
  if (errors.length) fail(label + ": page errors " + errors.slice(0, 2));
  await context.close();
  console.log("edit profile ok " + label);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    const jobs = [];
    for (const lang of ["en", "es"]) for (const size of SIZES) jobs.push(() => check(browser, port, size, lang));
    const lanes = Array.from({ length: 2 }, async () => { while (jobs.length) await jobs.shift()(); });
    await Promise.all(lanes);
    console.log("edit profile ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
