/* Usernames on phone and desktop in every language, reached from the
   Settings > Usernames shortcut into Edit profile's subpage: names list,
   audience editor, Preview as, name for friends, nicknames and mention
   rules talk to the API; pills stay thin, nothing overflows; the composer
   shows a neutral hint for someone you can't mention. Placeholders only. */
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

function session(lang) {
  return `(() => {
    localStorage.setItem("superintelapp-lang", ${JSON.stringify(lang)});
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A" } }));
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true, tiktokAudience: "owner" };
  })()`;
}

function mock(page, log) {
  const state = {
    names: [
      { handle: "user_a", primary: true, audience: { include: { public: true, followers: false, friends: false, lists: [], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } } },
      { handle: "user_a_close_friends_long", primary: false, audience: { include: { public: false, followers: false, friends: true, lists: ["l1"], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } } }
    ],
    listOrder: [], cap: 5, releaseDays: 30
  };
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  return page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
    if (url.pathname.startsWith("/v1/usernames") || url.pathname === "/v1/nicknames" || url.pathname === "/v1/mentions/suggest") log.push(method + " " + url.pathname + url.search + " " + JSON.stringify(body));
    if (url.pathname === "/v1/usernames" && method === "GET") return reply(route, 200, state);
    if (url.pathname === "/v1/usernames" && method === "POST") {
      if (body.handle === "taken_one") return reply(route, 409, { error: "handle_taken" });
      state.names.push({ handle: body.handle, primary: false, audience: { include: { public: false, followers: true, friends: false, lists: [], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } } });
      return reply(route, 201, state);
    }
    if (url.pathname === "/v1/usernames" && method === "PATCH") {
      const name = state.names.find((n) => n.handle === body.handle);
      name.audience = body.audience;
      return reply(route, 200, state);
    }
    if (url.pathname === "/v1/usernames/preview") return reply(route, 200, { as: url.searchParams.get("as"), handle: "user_a_close_friends_long", hidden: false });
    if (url.pathname === "/v1/audience-lists") return reply(route, 200, { lists: [{ id: "l1", name: "Close", icon: "", members: [] }, { id: "l2", name: "Work", icon: "", members: [] }] });
    if (url.pathname === "/v1/usernames/mentions" && method === "GET") return reply(route, 200, { public: "anyone", followers: "", friends: "", lists: {}, allow: [], block: [] });
    if (url.pathname === "/v1/usernames/mentions") return reply(route, 200, Object.assign({ allow: [], block: [] }, body));
    if (url.pathname === "/v1/usernames/friend-name") return reply(route, 200, { name: method === "PUT" ? body.name : "" });
    if (url.pathname === "/v1/nicknames" && method === "GET") return reply(route, 200, { nicknames: [] });
    if (url.pathname === "/v1/nicknames") return reply(route, 200, { ok: true, name: body.name });
    if (url.pathname === "/v1/mentions/suggest") return reply(route, 200, { accounts: [], hint: url.searchParams.get("q") === "blocked_b" ? "cant_mention" : undefined });
    if (url.pathname.startsWith("/v1/profile/")) return reply(route, 200, { account: { handle: "user_a", displayName: "User A" }, reposts: [] });
    return reply(route, 200, {});
  });
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
  await page.goto("http://127.0.0.1:" + port + "/index.html#/settings/privacy", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('a[href="#/settings/usernames"]', { timeout: 20000 }).catch(() => fail(label + ": no Usernames row in Privacy"));
  await page.click('a[href="#/settings/usernames"]');
  /* Settings > Usernames is a shortcut: the names live in Edit profile. */
  await page.waitForSelector('.un-settings [data-acct="edit-usernames"]', { timeout: 15000 }).catch(() => fail(label + ": no shortcut to Edit profile"));
  const settingsHeading = await page.textContent(".un-settings:not(.un-in-edit) h2");
  if (await page.$(".un-settings:not(.un-in-edit) .un-card")) fail(label + ": names listed twice in Settings");
  await page.click('[data-acct="edit-usernames"]');
  await page.waitForSelector('.ep .un-in-edit [data-un="open-name"]', { timeout: 15000 }).catch(() => fail(label + ": names did not load in Edit profile"));
  const layout = await page.evaluate(() => {
    const scroller = document.scrollingElement;
    const pills = Array.from(document.querySelectorAll(".xs-pill, .xs-badge")).filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect().height);
    const over = Array.from(document.querySelectorAll(".un-settings *")).filter((el) => { const r = el.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1; }).map((el) => el.className);
    const heading = document.querySelector(".ep .acct-edit-head h1 .xs-head-title") || document.querySelector(".ep .acct-edit-head h1");
    const row = document.querySelector('.ep [data-un="open-name"]');
    const natives = Array.from(document.querySelectorAll(".ep .un-in-edit select, .ep .un-in-edit textarea")).length;
    return { names: Array.from(document.querySelectorAll(".un-at")).map((el) => el.textContent), pills, over, wide: scroller.scrollWidth > window.innerWidth + 1, heading: heading ? heading.textContent : "", rowPad: row ? getComputedStyle(row).paddingLeft : "", natives };
  });
  if (layout.names.join(",") !== "@user_a,@user_a_close_friends_long") fail(label + ": names " + layout.names);
  if (layout.wide || layout.over.length) fail(label + ": overflow " + layout.over.slice(0, 3));
  if (layout.pills.some((h) => h > 40)) fail(label + ": pill grew " + layout.pills);
  if (layout.rowPad !== "16px") fail(label + ": row padding " + layout.rowPad);
  if (layout.natives) fail(label + ": native selects or text areas on the Usernames page");
  const want = { en: "Usernames", es: "Nombres de usuario", ru: "Имена пользователя" }[lang];
  if (layout.heading !== want || settingsHeading !== want) fail(label + ": heading " + layout.heading + " / " + settingsHeading);

  /* Add username: a bottom sheet with a floating-label field. */
  await page.click('.ep [data-un="add-sheet"]');
  await page.fill(".xs-sheet-back:not(.xs-leaving) [data-un-new]", "taken_one");
  await page.click(".xs-sheet-back:not(.xs-leaving) [data-xs-add]");
  await page.waitForSelector(".xs-sheet-back:not(.xs-leaving) .xs-ferror", { timeout: 5000 }).catch(() => fail(label + ": taken name gave no error"));
  await page.fill(".xs-sheet-back:not(.xs-leaving) [data-un-new]", "user_a_new");
  await page.click(".xs-sheet-back:not(.xs-leaving) [data-xs-add]");
  await page.waitForSelector('.ep .un-in-edit[data-un-view="name"]', { timeout: 5000 }).catch(() => fail(label + ": add did not open the new name"));
  if (await page.$(".xs-sheet-back:not(.xs-leaving)")) fail(label + ": add sheet stayed open");

  /* Detail: hide from a list and two people; it saves on its own. */
  await page.click('.ep [data-un="toggle-hide"]');
  await page.locator('.ep label:has([data-un-aud="exc:list:l2"])').click();
  await page.fill('.ep [data-xs-chip-input="exc"]', "user_x");
  await page.press('.ep [data-xs-chip-input="exc"]', "Enter");
  await page.fill('.ep [data-xs-chip-input="exc"]', "@user_y");
  await page.press('.ep [data-xs-chip-input="exc"]', "Enter");
  for (let i = 0; i < 40 && !log.some((line) => line.indexOf("PATCH /v1/usernames ") === 0 && line.indexOf("user_y") > 0); i++) await page.waitForTimeout(100);
  await page.waitForSelector(".xs-toast", { timeout: 5000 }).catch(() => fail(label + ": no Saved toast"));
  const patches = log.filter((line) => line.indexOf("PATCH /v1/usernames ") === 0);
  if (!patches.length) fail(label + ": no autosave");
  const sent = JSON.parse(patches[patches.length - 1].slice(patches[patches.length - 1].indexOf("{")));
  if (sent.handle !== "user_a_new" || !sent.audience.include.followers || sent.audience.exclude.lists.join() !== "l2" || sent.audience.exclude.people.join() !== "user_x,user_y") fail(label + ": saved " + patches[patches.length - 1]);
  if ((await page.$$('.ep [data-xs-chip-remove="exc"]')).length !== 2) fail(label + ": hide-from chips");

  /* Back goes to the list first; Preview as is a sheet with radios. */
  await page.click('.ep [data-acct="edit-back"]');
  await page.waitForSelector('.ep .un-in-edit[data-un-view="main"]', { timeout: 5000 }).catch(() => fail(label + ": back did not return to the list"));
  await page.click('.ep [data-un="preview-sheet"]');
  await page.click('.xs-sheet-back:not(.xs-leaving) [data-xs-opt="list:l1"]');
  await page.waitForSelector(".xs-sheet-back:not(.xs-leaving) .un-preview-out", { timeout: 5000 }).catch(() => fail(label + ": no preview"));
  if (!(await page.textContent(".xs-sheet-back:not(.xs-leaving) .un-preview-out")).includes("@user_a_close_friends_long")) fail(label + ": preview text");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".xs-sheet-back:not(.xs-leaving)") && document.querySelector(".ep"), null, { timeout: 3000 }).catch(() => fail(label + ": Escape did not close only the sheet"));

  /* Remove waits behind Undo. */
  await page.click('.ep [data-un="name-menu"][data-handle="user_a_new"]');
  await page.locator(".xs-sheet-back:not(.xs-leaving) .xs-menuitem.is-danger").click();
  await page.waitForSelector(".xs-toast [data-xs-undo]", { timeout: 3000 }).catch(() => fail(label + ": no Undo"));
  if ((await page.$$eval(".un-at", (els) => els.map((el) => el.textContent))).indexOf("@user_a_new") >= 0) fail(label + ": removed name still listed");
  await page.click(".xs-toast [data-xs-undo]");
  await page.waitForTimeout(150);
  if (log.some((line) => line.indexOf("DELETE /v1/usernames") === 0)) fail(label + ": Undo still deleted");
  if ((await page.$$eval(".un-at", (els) => els.map((el) => el.textContent))).indexOf("@user_a_new") < 0) fail(label + ": Undo did not bring the name back");

  /* Who can mention you: summary row, Advanced, and people chips. */
  await page.click('.ep [data-un="open-mentions"]');
  await page.click('.ep [data-un="toggle-advanced"]');
  await page.click('.ep [data-un="m-sheet"][data-key="followers"]');
  await page.click('.xs-sheet-back:not(.xs-leaving) [data-xs-opt="replies"]');
  await page.fill('.ep [data-xs-chip-input="block"]', "@user_z");
  await page.press('.ep [data-xs-chip-input="block"]', "Enter");
  for (let i = 0; i < 40 && !log.some((line) => line.indexOf("PUT /v1/usernames/mentions") === 0 && line.indexOf("user_z") > 0); i++) await page.waitForTimeout(100);
  const puts = log.filter((line) => line.indexOf("PUT /v1/usernames/mentions") === 0);
  const put = puts[puts.length - 1];
  if (!put || put.indexOf('"followers":"replies"') < 0 || put.indexOf('"block":["user_z"]') < 0) fail(label + ": mention rules " + put);

  /* Back to the list, then back from the Settings shortcut closes Edit profile. */
  await page.click('.ep [data-acct="edit-back"]');
  await page.waitForSelector('.ep .un-in-edit[data-un-view="main"]', { timeout: 5000 }).catch(() => fail(label + ": back from mentions"));
  await page.click('.ep [data-acct="edit-back"]');
  await page.waitForFunction(() => !document.querySelector(".ep"), null, { timeout: 5000 }).catch(() => fail(label + ": back did not close Edit profile"));

  // Composer: someone you can't mention gets a neutral hint, not a row.
  await page.goto("http://127.0.0.1:" + port + "/index.html#/compose/post", { waitUntil: "domcontentloaded" });
  const box = await page.waitForSelector("textarea", { timeout: 15000 }).catch(() => null);
  if (box) {
    /* The composer can repaint once right after the route opens; click by selector so a fresh box is used. */
    await page.locator("textarea").first().click({ timeout: 15000 });
    await page.keyboard.type("hi @blocked_b");
    await page.waitForSelector(".mention-hint", { timeout: 5000 }).catch(() => fail(label + ": no can't-mention hint"));
    const hint = await page.textContent(".mention-hint");
    const wantHint = { en: "You can't mention this account.", es: "No puedes mencionar esta cuenta.", ru: "Вы не можете упомянуть этот аккаунт." }[lang];
    if (hint !== wantHint) fail(label + ": hint " + hint);
    if (await page.$(".mention-row")) fail(label + ": blocked account suggested");
  } else fail(label + ": no composer");
  if (errors.length) fail(label + ": page errors " + errors.slice(0, 2));
  await context.close();
  console.log("usernames settings ok " + label);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    /* Two pages at a time: six pages booting at once on a busy CI runner
       took past the 20 s wait while each one was still re-rendering. */
    const jobs = [];
    for (const lang of ["en", "es", "ru"]) for (const size of SIZES) jobs.push(() => check(browser, port, size, lang));
    const lanes = Array.from({ length: 2 }, async () => { while (jobs.length) await jobs.shift()(); });
    await Promise.all(lanes);
    console.log("usernames settings ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
