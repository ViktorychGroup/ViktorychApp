/* Edit profile birth date and Save on a phone, as X does it: Edit asks
   first, then Month / Day / Year sheets; under-13 and impossible dates
   are refused; Save shows a spinner, sends once, keeps edits and shows a
   toast on an error, closes at once when nothing changed, and Android
   back asks before discarding. Background loads keep focus and scroll.
   Placeholder accounts only. */
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


const ACCOUNT = { handle: "cedarhill", publicId: "100000000001", displayName: "Cedar Hill", bio: "Placeholder bio.", location: "Example Town", website: "example.com" };
const WORDS = {
  en: { month: "March", young: "at least 13", toast: "Something went wrong", warn: "Edit date of birth?" },
  es: { month: "Marzo", young: "al menos 13", toast: "Algo salió mal", warn: "¿Editar la fecha de nacimiento?" }
};

function session(lang) {
  return `(() => {
    localStorage.setItem("superintelapp-lang", ${JSON.stringify(lang)});
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: ${JSON.stringify(ACCOUNT)} }));
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true };
  })()`;
}

function mock(page, log, state) {
  let account = Object.assign({}, ACCOUNT);
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  return page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
    if (method !== "GET") log.push(method + " " + url.pathname + " " + JSON.stringify(body));
    if (url.pathname === "/v1/usernames") return reply(route, 200, { names: [], listOrder: [], cap: 5, releaseDays: 30 });
    if (url.pathname === "/v1/about" && method === "GET") {
      await wait(state.aboutDelay);
      /* A lagging read keeps showing the first birthday. */
      const fields = state.served ? [state.served] : [];
      return reply(route, 200, { owner: true, visible: true, sections: [{ id: "personal", fields }] });
    }
    if (url.pathname.startsWith("/v1/about/") && method === "PATCH") return reply(route, 200, { field: Object.assign({}, state.served, body) });
    if (url.pathname.startsWith("/v1/about/") && method === "DELETE") return reply(route, 200, { ok: true });
    if (url.pathname === "/v1/about" && method === "POST") return reply(route, 201, { field: Object.assign({ id: "f2" }, body) });
    if (url.pathname === "/v1/profile" && method === "PATCH") {
      await wait(state.saveDelay);
      if (state.failNext) { state.failNext = false; return reply(route, 500, { error: "server_error" }); }
      account = Object.assign({}, account, body);
      return reply(route, 200, { account });
    }
    if (url.pathname.startsWith("/v1/profile/")) return reply(route, 200, { account, reposts: [] });
    return reply(route, 200, {});
  });
}

async function openEdit(page, label) {
  await page.click('button[data-acct="edit"]');
  await page.waitForSelector(".ep #acct-displayName", { timeout: 5000 }).catch(() => fail(label + ": Edit profile did not open"));
}
async function closed(page, label, what) {
  await page.waitForFunction(() => !document.querySelector(".ep"), null, { timeout: 5000 }).catch(() => fail(label + ": " + what));
}
async function pick(page, sheet, value) {
  await page.click('.ep [data-acct="ep-sheet"][data-sheet="' + sheet + '"]');
  await page.waitForSelector(".ep-sheet", { timeout: 2000 });
  await page.click('.ep-sheet [data-acct="ep-pick"][data-value="' + value + '"]');
  await page.waitForFunction(() => !document.querySelector(".ep-sheet"), null, { timeout: 2000 });
}
const value = (page, sheet) => page.$eval('.ep [data-acct="ep-sheet"][data-sheet="' + sheet + '"] .ep-picker-value', (el) => el.textContent);
const saves = (log, prefix) => log.filter((line) => line.indexOf(prefix) === 0).length;

async function check(browser, port, lang) {
  const label = lang + "@phone";
  const words = WORDS[lang];
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage();
  const log = [];
  const errors = [];
  const state = { aboutDelay: 900, saveDelay: 0, failNext: false, served: { id: "f1", kind: "birthday", text: "1990-03-01", audience: "followers", showYear: false } };
  page.on("pageerror", (err) => errors.push(String(err)));
  await mock(page, log, state);
  await page.addInitScript(session(lang));
  await page.goto("http://127.0.0.1:" + port + "/index.html#/@cedarhill", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[data-acct="edit"]', { timeout: 20000 }).catch(() => fail("no Edit profile button"));
  await openEdit(page, label);

  /* Typing while the birth date loads keeps focus (the phone keyboard). */
  await page.click("#acct-bio");
  await page.keyboard.type(" abc");
  await page.waitForFunction(() => document.querySelector(".ep").textContent.includes("1990"), null, { timeout: 4000 }).catch(() => fail(label + ": birth date did not load"));
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (focused !== "acct-bio") fail(label + ": focus moved to " + focused + " after the birth date loaded");
  await page.keyboard.type("d");
  if ((await page.inputValue("#acct-bio")) !== "Placeholder bio. abcd") fail(label + ": typing broke " + (await page.inputValue("#acct-bio")));

  /* Edit asks first and keeps the scroll position. */
  const scroller = ".ep [data-sub]";
  await page.$eval(scroller, (el) => { el.scrollTop = 160; });
  const before = await page.$eval(scroller, (el) => el.scrollTop);
  await page.click('.ep [data-acct="bday-edit"]');
  await page.waitForSelector(".ep-confirm", { timeout: 2000 }).catch(() => fail(label + ": no warning before editing the birth date"));
  if (!(await page.textContent(".ep-confirm")).includes(words.warn)) fail(label + ": warning text");
  await page.click('[data-acct="bday-warn-no"]');
  if (await page.$('.ep [data-acct="ep-sheet"][data-sheet="month"]')) fail(label + ": Cancel still opened the pickers");
  await page.click('.ep [data-acct="bday-edit"]');
  await page.click('[data-acct="bday-warn-yes"]');
  await page.waitForSelector('.ep [data-acct="ep-sheet"][data-sheet="month"]', { timeout: 2000 }).catch(() => fail(label + ": no pickers"));
  const after = await page.$eval(scroller, (el) => el.scrollTop);
  if (Math.abs(after - before) > 2) fail(label + ": scroll jumped " + before + " -> " + after);
  if (await page.$('.ep input[type="date"], .ep select')) fail(label + ": raw browser date controls");
  const shown = [await value(page, "month"), await value(page, "day"), await value(page, "year")].join(" ");
  if (shown !== words.month + " 1 1990") fail(label + ": pickers show " + shown);

  /* The day follows the month; under 13 is refused. */
  await pick(page, "day", "31");
  await pick(page, "month", "2");
  if ((await value(page, "day")) !== "28") fail(label + ": February kept day " + (await value(page, "day")));
  await pick(page, "year", String(new Date().getFullYear() - 6));
  if (!(await page.textContent(".ep")).includes(words.young)) fail(label + ": no minimum age message");
  if (!(await page.$eval('.ep [data-acct="save-profile"]', (el) => el.disabled))) fail(label + ": Save allowed an under-13 date");
  await pick(page, "year", "1992");
  if (await page.$eval('.ep [data-acct="save-profile"]', (el) => el.disabled)) fail(label + ": Save stayed disabled");

  /* A server error keeps the edits and shows a toast. */
  state.failNext = true;
  await page.click('.ep [data-acct="save-profile"]');
  await page.waitForSelector(".ep-toast", { timeout: 4000 }).catch(() => fail(label + ": no error toast"));
  if (!(await page.textContent(".ep-toast")).includes(words.toast)) fail(label + ": toast " + (await page.textContent(".ep-toast")));
  if (!(await page.$(".ep"))) fail(label + ": an error closed the sheet");
  if ((await page.inputValue("#acct-bio")) !== "Placeholder bio. abcd") fail(label + ": error lost the bio");
  if ((await value(page, "day")) !== "28") fail(label + ": error lost the birth date");

  /* Slow save: spinner, disabled, a double tap sends once. */
  state.saveDelay = 1200;
  const profileBefore = saves(log, "PATCH /v1/profile ");
  await page.$eval('.ep [data-acct="save-profile"]', (el) => { el.click(); el.click(); });
  await page.waitForSelector(".ep .ep-spin", { timeout: 1000 }).catch(() => fail(label + ": no spinner"));
  if (!(await page.$eval('.ep [data-acct="save-profile"]', (el) => el.disabled))) fail(label + ": Save enabled while saving");
  await closed(page, label, "save did not close");
  if (saves(log, "PATCH /v1/profile ") - profileBefore !== 1) fail(label + ": double tap sent " + (saves(log, "PATCH /v1/profile ") - profileBefore));
  const bday = log.filter((line) => line.indexOf("PATCH /v1/about/f1 ") === 0);
  if (bday.length !== 1 || bday[0].indexOf('"text":"1992-02-28"') < 0) fail(label + ": birth date saves " + bday);
  await page.waitForFunction(() => document.body.textContent.includes("Placeholder bio. abcd"), null, { timeout: 3000 }).catch(() => fail(label + ": profile did not update"));
  state.saveDelay = 0;

  /* Reopen right away: the saved date, even from a lagging read. */
  await openEdit(page, label);
  await page.waitForTimeout(1200);
  const text = await page.textContent(".ep");
  if (!/1992/.test(text) || /1990/.test(text)) fail(label + ": reopened with a stale birth date");

  /* Nothing changed: Save closes with no request. */
  const edits = () => log.filter((line) => / \/v1\/(profile|about)/.test(line));
  const count = edits().length;
  await page.click('.ep [data-acct="save-profile"]');
  await closed(page, label, "a clean Save did not close");
  if (edits().length !== count) fail(label + ": a clean Save sent " + edits().slice(count));

  /* Android back with changes asks first; back on a clean form closes. */
  await openEdit(page, label);
  await page.fill("#acct-displayName", "Cedar Ridge");
  await page.goBack();
  await page.waitForSelector(".ep-confirm", { timeout: 3000 }).catch(() => fail(label + ": back did not ask to discard"));
  await page.click('[data-acct="discard-no"]');
  if ((await page.inputValue("#acct-displayName")) !== "Cedar Ridge") fail(label + ": back lost the edit");
  await page.goBack();
  await page.waitForSelector(".ep-confirm", { timeout: 3000 }).catch(() => fail(label + ": second back did not ask"));
  await page.click('[data-acct="discard-yes"]');
  await closed(page, label, "discard did not close");
  if (!page.url().includes("#/@cedarhill")) fail(label + ": back left the profile " + page.url());
  await openEdit(page, label);
  await page.goBack();
  await closed(page, label, "back on a clean form did not close");

  /* Remove the birth date. */
  await openEdit(page, label);
  await page.click('.ep [data-acct="bday-edit"]');
  await page.click('[data-acct="bday-warn-yes"]');
  await page.click('.ep [data-acct="bday-clear"]');
  await page.click('.ep [data-acct="save-profile"]');
  await closed(page, label, "remove did not close");
  if (!log.some((line) => line.indexOf("DELETE /v1/about/f1") === 0)) fail(label + ": birth date was not removed");

  if (errors.length) fail(label + ": page errors " + errors.slice(0, 2));
  await context.close();
  console.log("edit profile birthday ok " + label);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    for (const lang of ["en", "es"]) await check(browser, port, lang);
    console.log("edit profile birthday ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
