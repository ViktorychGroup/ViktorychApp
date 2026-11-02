/* Edit profile > Display names (Nombres), on phone and desktop: the row
   sits next to Usernames, the subpage lists every name with who sees it,
   edits an audience with show-to and hide-from rules, adds a name, makes
   one the main name, previews as an audience and as one person, and goes
   back to the same form, all in X's native settings look (rows, sheets,
   chips, autosave with undo). Placeholder accounts only. SHOTS=<dir> also saves
   screenshots. */
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


const SHOTS = process.env.SHOTS || "";
const OFF = () => ({ include: { public: false, followers: false, friends: false, lists: [], people: [] }, exclude: { followers: false, friends: false, lists: [], people: [] } });

function mock(page, log) {
  const main = OFF(); main.include.public = true;
  const close = OFF(); close.include.friends = true; close.exclude.people = ["oakridge"];
  const crew = OFF(); crew.include.lists = ["l1"];
  let state = { names: [
    { id: "main", name: "Cedar Hill", primary: true, audience: main },
    { id: "dn01", name: "Cedar Close", primary: false, audience: close },
    { id: "dn02", name: "Cedar Crew", primary: false, audience: crew }
  ], listOrder: ["l1"], cap: 5 };
  let account = Object.assign({}, ACCOUNT);
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  return page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
    if (method !== "GET") log.push(method + " " + url.pathname + " " + JSON.stringify(body));
    if (url.pathname === "/v1/display-names" && method === "GET") return reply(route, 200, state);
    if (url.pathname === "/v1/display-names" && method === "POST") {
      const aud = OFF(); aud.include.friends = true;
      state = Object.assign({}, state, { names: state.names.concat([{ id: "dn03", name: body.name, primary: false, audience: aud }]) });
      return reply(route, 201, state);
    }
    if (url.pathname === "/v1/audience-lists/people") return reply(route, 200, { people: [{ handle: "birchway", name: "Birch Way" }, { handle: "oakridge", name: "Oak Ridge" }] });
    if (url.pathname === "/v1/display-names" && method === "PATCH") {
      await page.evaluate(() => { window.__dnPatches = (window.__dnPatches || 0) + 1; }).catch(() => {});
      state = Object.assign({}, state, { names: state.names.map((n) => n.id === body.id ? Object.assign({}, n, { audience: Object.assign(OFF(), body.audience), name: body.name || n.name }) : n) });
      return reply(route, 200, state);
    }
    if (url.pathname === "/v1/display-names/primary") {
      const picked = state.names.find((n) => n.id === body.id);
      const old = state.names[0];
      state = Object.assign({}, state, { names: state.names.map((n) => n.id === "main" ? Object.assign({}, n, { name: picked.name, audience: picked.audience }) : n.id === body.id ? Object.assign({}, n, { name: old.name, audience: old.audience }) : n) });
      account = Object.assign({}, account, { displayName: picked.name });
      return reply(route, 200, state);
    }
    if (url.pathname === "/v1/display-names/preview") {
      const as = url.searchParams.get("as");
      if (as === "oakridge") return reply(route, 200, { as, name: "Cedar Hill", id: "main", hidden: false });
      if (as === "friends") return reply(route, 200, { as, name: "Cedar Close", id: "dn01", hidden: false });
      if (as === "nobody") return reply(route, 404, { error: "not_found" });
      return reply(route, 200, { as, name: "Cedar Hill", id: "main", hidden: false });
    }
    if (url.pathname === "/v1/usernames") return reply(route, 200, { names: [{ handle: "cedarhill", primary: true, audience: main }], listOrder: [], cap: 5, releaseDays: 30 });
    if (url.pathname === "/v1/audience-lists") return reply(route, 200, { lists: [{ id: "l1", name: "Crew", icon: "" }] });
    if (url.pathname === "/v1/usernames/mentions") return reply(route, 200, { public: "anyone", followers: "", friends: "", lists: {}, allow: [], block: [] });
    if (url.pathname === "/v1/nicknames") return reply(route, 200, { nicknames: [] });
    if (url.pathname === "/v1/about" && method === "GET") return reply(route, 200, { owner: true, visible: true, sections: [{ id: "personal", fields: [] }] });
    if (url.pathname === "/v1/profile" && method === "PATCH") { account = Object.assign({}, account, body); return reply(route, 200, { account }); }
    if (url.pathname.startsWith("/v1/profile/")) return reply(route, 200, { account, reposts: [] });
    return reply(route, 200, {});
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

async function check(browser, port, size, lang) {
  const label = lang + "@" + size.name;
  const S = ".xs-sheet-back:not(.xs-leaving)";
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: "block" });
  const page = await context.newPage();
  const log = [];
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await mock(page, log);
  await page.addInitScript(session(lang));
  await page.goto("http://127.0.0.1:" + port + "/index.html#/@cedarhill", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('button[data-acct="edit"]', { timeout: 20000 }).catch(() => fail(label + ": no Edit profile button"));
  await page.click('button[data-acct="edit"]');
  await page.waitForSelector(".ep #acct-displayName", { timeout: 5000 }).catch(() => fail(label + ": Edit profile did not open"));

  /* The row sits right before Usernames. */
  const rows = await page.$$eval(".ep .ep-rows .ep-row", (els) => els.map((el) => (el.getAttribute("data-sub") || "") + ":" + el.querySelector("b").textContent));
  const want = { en: ["Display names", "Usernames"], es: ["Nombres", "Nombres de usuario"] }[lang];
  if (rows[0] !== "displaynames:" + want[0]) fail(label + ": rows " + rows);
  if ((rows[1] || "").indexOf("usernames:") !== 0) fail(label + ": usernames row moved " + rows);
  await shot(page, lang + "-" + size.name + "-1-edit-profile");

  /* The list: one row per name with its audience in plain words, no raw controls. */
  await page.click('.ep [data-acct="edit-sub"][data-sub="displaynames"]');
  await page.waitForSelector('.ep .dn-in-edit [data-dn="open-name"]', { timeout: 8000 }).catch(() => fail(label + ": display names list did not load"));
  await page.waitForFunction(() => (document.querySelector(".ep .xs-head-title") || {}).textContent, null, { timeout: 3000 }).catch(() => fail(label + ": no X header"));
  if ((await page.textContent(".ep .xs-head-title")) !== want[0]) fail(label + ": title");
  const shown = await page.$$eval(".ep .dn-shown", (els) => els.map((el) => el.textContent));
  if (shown.join() !== "Cedar Hill,Cedar Close,Cedar Crew") fail(label + ": names " + shown);
  const who = await page.$$eval('.ep [data-dn="open-name"] .xs-sub', (els) => els.map((el) => el.textContent));
  const plain = { en: ["Everyone", "Friends only · hidden from 1 person", "Crew list"], es: null }[lang];
  if (plain && who.join("|") !== plain.join("|")) fail(label + ": plain words " + who);
  if (who[2].indexOf("Crew") < 0) fail(label + ": list audience " + who);
  const raw = await page.$$eval(".ep .dn-in-edit select, .ep .dn-in-edit input:not(.xs-checkbox):not(.xs-search-input):not(.xs-input), .ep .dn-in-edit button:not([class*='xs-'])", (els) => els.length);
  if (raw) fail(label + ": " + raw + " raw controls on the list");
  const over = await page.evaluate(() => Array.from(document.querySelectorAll(".ep *")).filter((el) => { const b = el.getBoundingClientRect(); return b.width && b.right > window.innerWidth + 1; }).length);
  if (over) fail(label + ": " + over + " elements overflow");
  await shot(page, lang + "-" + size.name + "-2-display-names");

  /* Detail screen: live sentence, preset sheet with undo, chips, hide from. */
  await page.click('.ep [data-dn="open-name"][data-id="dn01"]');
  await page.waitForSelector('.ep .dn-in-edit[data-dn-view="name"]', { timeout: 3000 }).catch(() => fail(label + ": detail did not open"));
  if ((await page.textContent(".ep .xs-head-title")) !== "Cedar Close") fail(label + ": detail title");
  const sentence0 = await page.textContent(".ep .xs-summary");
  if (sentence0.indexOf("Cedar Close") < 0) fail(label + ": summary " + sentence0);
  await shot(page, lang + "-" + size.name + "-3a-detail");
  await page.click('.ep [data-dn="aud-sheet"]');
  await page.click(S + ' [data-xs-opt="followers"]');
  await page.waitForSelector(".xs-toast [data-xs-undo]", { timeout: 3000 }).catch(() => fail(label + ": no undo toast"));
  await page.waitForFunction(() => document.querySelector('.ep [data-dn-aud="inc:followers"]').checked && !document.querySelector('.ep [data-dn-aud="inc:friends"]').checked, null, { timeout: 3000 }).catch(() => fail(label + ": preset not applied"));
  await page.click(".xs-toast [data-xs-undo]");
  await page.waitForFunction(() => document.querySelector('.ep [data-dn-aud="inc:friends"]').checked && !document.querySelector('.ep [data-dn-aud="inc:followers"]').checked, null, { timeout: 3000 }).catch(() => fail(label + ": undo did not restore"));
  await page.locator('.ep .xs-checkrow:has([data-dn-aud="inc:followers"])').click();
  await page.fill('.ep [data-xs-chip-input="inc"]', "bir");
  await page.waitForSelector('.ep [data-xs-suggest="inc"]:not([hidden]) [data-xs-pick="inc"][data-value="birchway"]', { timeout: 3000 }).catch(() => fail(label + ": no people search"));
  /* The Followers autosave repaints the screen; the search and its suggestions stay. */
  await page.waitForFunction(() => window.__dnPatches >= 1, null, { timeout: 4000 }).catch(() => fail(label + ": no autosave"));
  await page.waitForTimeout(150);
  await page.waitForSelector('.ep [data-xs-suggest="inc"]:not([hidden]) [data-xs-pick="inc"][data-value="birchway"]', { timeout: 3000 }).catch(() => fail(label + ": suggestions lost on autosave"));
  await page.click('.ep [data-xs-pick="inc"][data-value="birchway"]');
  await page.waitForSelector('.ep [data-xs-chips="inc"] .xs-chip', { timeout: 3000 }).catch(() => fail(label + ": no chip"));
  await page.click('.ep [data-dn="toggle-hide"]');
  await page.fill('.ep [data-xs-chip-input="exc"]', "@elmstreet");
  await page.press('.ep [data-xs-chip-input="exc"]', "Enter");
  await page.waitForFunction(() => document.querySelectorAll('.ep [data-xs-chips="exc"] .xs-chip').length === 2, null, { timeout: 3000 }).catch(() => fail(label + ": hide-from chip"));
  await page.waitForFunction(() => window.__dnPatches >= 1, null, { timeout: 4000 }).catch(() => fail(label + ": no autosave"));
  await page.waitForTimeout(700);
  const patches = log.filter((line) => line.indexOf("PATCH /v1/display-names ") === 0);
  const sent = JSON.parse(patches[patches.length - 1].slice(patches[patches.length - 1].indexOf("{")));
  if (sent.id !== "dn01" || !sent.audience.include.friends || !sent.audience.include.followers || sent.audience.include.public || sent.audience.include.people.join() !== "birchway" || sent.audience.exclude.people.join() !== "oakridge,elmstreet" || sent.name !== "Cedar Close") fail(label + ": sent " + JSON.stringify(sent));
  const sentence1 = await page.textContent(".ep .xs-summary");
  if (lang === "en" && sentence1 !== "Followers, Friends, Birch Way see “Cedar Close”. Never shown to Oak Ridge, @elmstreet.") fail(label + ": live sentence " + sentence1);
  await shot(page, lang + "-" + size.name + "-3-audience");

  /* Inline Preview as one person. */
  await page.fill('.ep [data-xs-chip-input="pv"]', "@oakridge");
  await page.press('.ep [data-xs-chip-input="pv"]', "Enter");
  await page.waitForSelector(".ep .un-preview-out", { timeout: 4000 }).catch(() => fail(label + ": no inline preview"));
  if ((await page.textContent(".ep .un-preview-out")).indexOf("Cedar Hill") < 0) fail(label + ": person preview");
  await page.evaluate(() => { const el = document.querySelector(".ep .un-preview-out"); if (el) el.scrollIntoView({ block: "center" }); });
  await shot(page, lang + "-" + size.name + "-4-preview-person");

  /* Copy the audience from another name, then undo. */
  await page.click('.ep [data-dn="copy-from"]');
  await page.click(S + ' [data-xs-opt="dn02"]');
  await page.waitForFunction(() => document.querySelector('.ep [data-dn-aud="inc:list:l1"]') && document.querySelector('.ep [data-dn-aud="inc:list:l1"]').checked, null, { timeout: 3000 }).catch(() => fail(label + ": copy did not apply"));
  await page.click(".xs-toast [data-xs-undo]");
  await page.waitForFunction(() => document.querySelector('.ep [data-dn-aud="inc:friends"]').checked, null, { timeout: 3000 }).catch(() => fail(label + ": copy undo"));

  /* Back to the list, add a name in a sheet, preview by audience. */
  await page.click('.ep [data-acct="edit-back"]');
  await page.waitForSelector('.ep .dn-in-edit[data-dn-view="main"]', { timeout: 3000 }).catch(() => fail(label + ": back did not return to the list"));
  await page.click('.ep [data-dn="add-sheet"]');
  await page.fill(S + " [data-dn-new]", "Cedar Grove");
  await shot(page, lang + "-" + size.name + "-5-add-sheet");
  await page.click(S + " [data-xs-add]");
  await page.waitForSelector('.ep .dn-in-edit[data-dn-view="name"]', { timeout: 4000 }).catch(() => fail(label + ": add did not open the new name"));
  if ((await page.textContent(".ep .xs-head-title")) !== "Cedar Grove") fail(label + ": new name title");
  const post = log.find((line) => line.indexOf("POST /v1/display-names ") === 0);
  if (!post || post.indexOf('"friends":true') < 0) fail(label + ": add sent " + post);
  await page.click('.ep [data-acct="edit-back"]');
  await page.click('.ep [data-dn="preview-sheet"]');
  await page.click(S + ' [data-xs-opt="friends"]');
  await page.waitForSelector(S + " .un-preview-out", { timeout: 4000 }).catch(() => fail(label + ": no audience preview"));
  if ((await page.textContent(S + " .un-preview-out")).indexOf("Cedar Close") < 0) fail(label + ": tier preview");
  await shot(page, lang + "-" + size.name + "-6-preview-sheet");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".xs-sheet-back:not(.xs-leaving)") && document.querySelector(".ep"), null, { timeout: 3000 }).catch(() => fail(label + ": Escape did not close only the sheet"));

  /* Remove with undo, then make "Cedar Crew" the main name from the ⋯ menu. */
  await page.click('.ep [data-dn="name-menu"][data-id="dn03"]');
  await page.locator(S + " .xs-menuitem.is-danger").click();
  await page.waitForSelector(".xs-toast [data-xs-undo]", { timeout: 3000 }).catch(() => fail(label + ": no remove undo"));
  if (await page.$('.ep [data-dn="open-name"][data-id="dn03"]')) fail(label + ": removed row still shown");
  await page.click(".xs-toast [data-xs-undo]");
  await page.waitForSelector('.ep [data-dn="open-name"][data-id="dn03"]', { timeout: 3000 }).catch(() => fail(label + ": undo did not bring it back"));
  if (log.some((line) => line.indexOf("DELETE /v1/display-names") === 0)) fail(label + ": deleted despite undo");
  await page.click('.ep [data-dn="name-menu"][data-id="dn02"]');
  await page.locator(S + ' .xs-menuitem:has(.xs-title)').nth(1).click();
  await page.waitForFunction(() => (document.querySelector(".ep .dn-shown") || {}).textContent === "Cedar Crew", null, { timeout: 4000 }).catch(() => fail(label + ": main did not change"));
  await page.click('.ep [data-acct="edit-back"]');
  await page.waitForSelector(".ep #acct-displayName", { timeout: 3000 }).catch(() => fail(label + ": back did not return to the form"));
  const nameNow = await page.inputValue("#acct-displayName");
  if (nameNow !== "Cedar Crew") fail(label + ": Name field " + nameNow);
  if (errors.length) fail(label + ": page errors " + errors.slice(0, 2));
  await context.close();
  console.log("display names ok " + label);
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
    console.log("display names ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
