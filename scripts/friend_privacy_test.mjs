/* Who can see each friendship, on a phone in English and Spanish: friend
   rows with plain-words summaries, the detail editor (presets, show-to and
   hide-from chips with search, live sentence), autosave with Undo, bulk
   select, and Preview as. The API is mocked; accounts are placeholders.
   FRIEND_PRIVACY_SHOTS=<dir> also saves screenshots. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.FRIEND_PRIVACY_SHOTS || "";
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
  const rules = {
    anna_demo: { mode: "custom", audience: { include: { public: false, followers: false, friends: false, lists: [], people: ["ben_demo"] }, exclude: { followers: false, friends: false, lists: [], people: [] } } },
    ben_demo: { mode: "inherit" },
    cy_demo: { mode: "hidden" },
    dee_demo: { mode: "inherit" }
  };
  const names = { anna_demo: "Anna", ben_demo: "Ben", cy_demo: "Cy", dee_demo: "Dee" };
  const present = () => ({
    v: 1, listAudience: "everyone", friendsOn: true,
    friends: Object.keys(rules).map((h) => ({ handle: h, name: names[h], avatar: "", rule: rules[h] })),
    lists: [{ id: "l1", name: "Close", icon: "" }]
  });
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  return page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
    if (url.pathname.startsWith("/v1/friends/privacy")) log.push(method + " " + url.pathname + url.search + " " + JSON.stringify(body));
    if (url.pathname === "/v1/friends/settings") return reply(route, 200, { enabled: true, whoCanRequest: "everyone", listAudience: "everyone", shareOnline: true, held: { incoming: 0, outgoing: 0, friends: 4 } });
    if (url.pathname === "/v1/friends/privacy" && method === "GET") return reply(route, 200, present());
    if (url.pathname === "/v1/friends/privacy" && method === "PUT") {
      (body.handles || []).forEach((h) => { rules[h] = body.rule.mode === "inherit" ? { mode: "inherit" } : body.rule; });
      return reply(route, 200, Object.assign({ ok: true, saved: (body.handles || []).length }, present()));
    }
    if (url.pathname === "/v1/friends/privacy/preview") {
      const as = url.searchParams.get("as");
      const visible = as === "friends" ? ["ben_demo", "dee_demo"] : as === "ben_demo" ? ["anna_demo", "ben_demo", "dee_demo"] : ["ben_demo", "dee_demo"];
      return reply(route, 200, { as, visible, count: visible.length, total: 4, ownSideOnly: true });
    }
    if (url.pathname === "/v1/audience-lists/people") return reply(route, 200, { people: [{ handle: "ben_demo", name: "Ben" }, { handle: "eve_demo", name: "Eve" }, { handle: "fay_demo", name: "Fay" }] });
    if (url.pathname === "/v1/audience-lists") return reply(route, 200, { lists: [{ id: "l1", name: "Close", icon: "", members: [] }] });
    if (url.pathname.startsWith("/v1/profile/")) return reply(route, 200, { account: { handle: "user_a", displayName: "User A" }, reposts: [] });
    return reply(route, 200, {});
  });
}

const WORDS = {
  en: { entry: "Who can see each friendship", anna: "Visible to: Ben only", cy: "Visible to: Only you", ben: "Visible to: Everyone (same as your friends list)", undone: "Change undone", sees: "would see that you’re friends with" },
  es: { entry: "Quién puede ver cada amistad", anna: "Visible para: Solo Ben", cy: "Visible para: Solo tú", ben: "Visible para: Todos (igual que tu lista de amigos)", undone: "Cambio deshecho", sees: "vería que eres amigo de" }
};

async function shot(page, lang, name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(250);
  if (name === "preview-as") await page.evaluate(() => { const t = document.getElementById("toast"); if (t) t.hidden = true; });
  await page.screenshot({ path: path.join(shots, lang + "-" + name + ".png") });
}

async function check(browser, port, lang) {
  const label = lang + "@phone";
  const w = WORDS[lang];
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, serviceWorkers: "block", deviceScaleFactor: shots ? 2 : 1 });
  const page = await context.newPage();
  const log = [];
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  await mock(page, log);
  await page.addInitScript(session(lang));
  await page.goto("http://127.0.0.1:" + port + "/index.html#/settings/friends", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('a.fpv-entry[href="#/settings/friendship"]', { timeout: 20000 }).catch(() => fail(label + ": no per-friendship row in Settings > Friends"));
  if ((await page.textContent("a.fpv-entry b")).trim() !== w.entry) fail(label + ": entry title " + (await page.textContent("a.fpv-entry b")));
  await page.click("a.fpv-entry");
  await page.waitForSelector(".fpv-row", { timeout: 15000 }).catch(() => fail(label + ": no friend rows"));
  const rows = await page.$$eval(".fpv-row", (els) => els.map((el) => el.querySelector(".fpv-sum").textContent));
  if (rows.length !== 4) fail(label + ": rows " + rows.length);
  if ((rows[0] !== w.anna || rows[2] !== w.cy || rows[1] !== w.ben)) fail(label + ": summaries " + rows.join(" | "));
  if (lang === "es" && (rows[0] !== w.anna || rows[1] !== w.ben)) fail(label + ": summaries " + rows.join(" | "));
  const wide = await page.evaluate(() => document.scrollingElement.scrollWidth > window.innerWidth + 1);
  if (wide) fail(label + ": rows overflow");
  await shot(page, lang, "friend-rows");

  /* Detail: Specific people, add Eve via chip search, autosave, Undo. */
  await page.click('.fpv-row[href="#/settings/friendship/ben_demo"]');
  await page.waitForSelector(".fpv-detail .fpv-choice", { timeout: 10000 }).catch(() => fail(label + ": detail did not open"));
  await page.click('.fpv-choice[data-value="people"]');
  await page.waitForSelector('[data-fpv-chip="show"]', { timeout: 5000 }).catch(() => fail(label + ": no show-to chips"));
  if (log.some((l) => l.startsWith("PUT"))) fail(label + ": saved an empty people rule");
  await page.fill('[data-fpv-chip="show"]', "ev");
  await page.waitForSelector('[data-fpv-suggest="show"] [data-handle="eve_demo"]', { timeout: 5000 }).catch(() => fail(label + ": chip search found nobody"));
  await page.click('[data-fpv-suggest="show"] [data-handle="eve_demo"]');
  await page.waitForFunction(() => document.querySelectorAll(".fpv-chips[data-kind=show] .fpv-chip").length === 1, null, { timeout: 5000 }).catch(() => fail(label + ": chip not added"));
  const put1 = (await waitPuts(log, 1, label, "chip"))[0];
  if (!put1) fail(label + ": no autosave");
  const sent = JSON.parse(put1.slice(put1.indexOf("{")));
  if (sent.handles.join() !== "ben_demo" || sent.rule.mode !== "custom" || sent.rule.audience.include.people.join() !== "eve_demo") fail(label + ": saved " + put1);
  const line = await page.textContent(".fpv-sentence");
  if (!line.includes("Eve")) fail(label + ": live sentence " + line);
  if (await page.$('[data-fpv-chip="hide"]')) fail(label + ": hide-from shown for specific people");
  /* Friends plus Eve, hidden from Fay. Hiding wins; saved at once. */
  await page.click('.fpv-choice[data-value="friends"]');
  await page.waitForSelector('[data-fpv-chip="hide"]', { timeout: 5000 }).catch(() => fail(label + ": no hide-from chips"));
  await page.fill('[data-fpv-chip="hide"]', "fay");
  await page.keyboard.press("Enter");
  const put2 = (await waitPuts(log, 3, label, "hide-from"))[2];
  const r2 = put2 ? JSON.parse(put2.slice(put2.indexOf("{"))).rule.audience : null;
  if (!r2 || !r2.include.friends || r2.include.people.join() !== "eve_demo" || r2.exclude.people.join() !== "fay_demo") fail(label + ": hide-from " + put2);
  await page.evaluate(() => document.querySelector(".fpv-chips[data-kind=hide]").scrollIntoView({ block: "end" }));
  await shot(page, lang, "detail-editor");
  /* Undo puts the previous rule back. */
  await page.click("#toast [data-fpv-undo]");
  const puts = await waitPuts(log, 4, label, "undo");
  const undo = JSON.parse(puts[puts.length - 1].slice(puts[puts.length - 1].indexOf("{")));
  if (undo.rule.audience.exclude.people.length || !undo.rule.audience.include.friends || undo.rule.audience.include.people.join() !== "eve_demo") fail(label + ": undo sent " + JSON.stringify(undo));
  await page.waitForFunction((t) => (document.querySelector("#toast") || {}).textContent.includes(t), w.undone, { timeout: 5000 }).catch(() => fail(label + ": no undone toast"));

  /* Preview as a friend: your side only, and a clear yes/no. */
  await page.selectOption("[data-fpv-preview]", "friends");
  await page.waitForSelector(".fpv-preview-out", { timeout: 5000 }).catch(() => fail(label + ": no preview"));
  const out = await page.textContent(".fpv-preview-out");
  if (!out.includes(w.sees) || !out.includes("Ben")) fail(label + ": preview " + out);
  if (!log.some((l) => l.startsWith("GET /v1/friends/privacy/preview?as=friends"))) fail(label + ": preview call");
  if (await page.$(".friends-owner-view")) fail(label + ": owner banner in Preview as");
  await page.evaluate(() => document.querySelector(".fpv-preview").scrollIntoView({ block: "center" }));
  await shot(page, lang, "preview-as");

  /* Bulk: pick two, Only me, apply. */
  await page.goto("http://127.0.0.1:" + port + "/index.html#/settings/friendship", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-fpv="select"]', { timeout: 15000 });
  await page.click('[data-fpv="select"]');
  await page.click('[data-fpv="pick"][data-handle="anna_demo"]');
  await page.click('[data-fpv="pick"][data-handle="dee_demo"]');
  await page.click('[data-fpv="bulk"]');
  await page.waitForSelector('[data-fpv="bulk-save"]', { timeout: 5000 }).catch(() => fail(label + ": bulk editor"));
  await page.click('.fpv-choice[data-value="me"]');
  const before = putsOf(log).length;
  await page.click('[data-fpv="bulk-save"]');
  const bulk = (await waitPuts(log, before + 1, label, "bulk")).pop();
  const b = JSON.parse(bulk.slice(bulk.indexOf("{")));
  if (b.handles.sort().join() !== "anna_demo,dee_demo" || b.rule.mode !== "hidden") fail(label + ": bulk sent " + bulk);
  if (errors.length) fail(label + ": page errors " + errors.slice(0, 2));
  await context.close();
  console.log("friend privacy ok " + label);
}

function putsOf(log) { return log.filter((l) => l.startsWith("PUT /v1/friends/privacy ")); }

/* Wait until at least n PUTs reached the mock server. */
async function waitPuts(log, n, label, what) {
  for (let i = 0; i < 100 && putsOf(log).length < n; i++) await new Promise((r) => setTimeout(r, 50));
  if (putsOf(log).length < n) fail(label + ": " + what + " was not saved");
  return putsOf(log);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const port = server.address().port;
    for (const lang of ["en", "es"]) await check(browser, port, lang);
    console.log("friend privacy ok");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
