/* Linked profiles merged into the internal profile, on phone and desktop,
   in English and Spanish: the profile shows one mixed timeline where
   linked posts look like the profile's own (same card, the profile's name
   and handle, a small platform mark by the time), optional filter pills,
   and a Linked profiles button whose X-style sheet lists each link with who
   sees it. A row opens a sheet to change the audience (including specific
   people) and Merge / Keep separate. A merged profile's own page and author
   links open the internal profile. Settings > Linked accounts lists the
   same rows. Placeholder accounts only. SHOTS=<dir> also saves screenshots. */
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
const LINKS = () => [
  { id: 11, platform: "x", handle: "cedar_elsewhere", verified: true, merged: true, audience: "public", hidden: false },
  { id: 12, platform: "instagram", handle: "cedar.pictures", verified: true, merged: true, audience: "friends", hidden: false },
  { id: 13, platform: "youtube", handle: "cedarclips", verified: true, merged: false, audience: "only", hidden: false }
];
const ACCOUNT = { handle: "cedarhill", publicId: "100000000001", displayName: "Cedar Hill", bio: "Placeholder bio.", avatar: "" };
const SHOTS = process.env.SHOTS || "";

function catalog() {
  const now = Date.now();
  const feeds = [
    { id: "x:cedar_elsewhere", platform: "x", handle: "cedar_elsewhere", name: "Cedar Elsewhere", avatar: "", configured: true },
    { id: "instagram:cedar.pictures", platform: "instagram", handle: "cedar.pictures", name: "Cedar Pictures", avatar: "", configured: true },
    { id: "x:maplegrove", platform: "x", handle: "maplegrove", name: "Maple Grove", avatar: "", configured: true }
  ];
  const post = (n, feed, text, mins) => ({
    id: String(8100000 + n), statusId: String(8100000 + n), platform: feed.platform, feedId: feed.id, kind: "post",
    author: feed.name, handle: feed.handle, avatar: "", text, links: [], date: new Date(now - mins * 60000).toISOString(),
    url: "", repostedBy: null, replyingTo: null, quoted: null, media: [], images: [], stats: { replies: 1, reposts: 2, likes: 5 }
  });
  return { updated: new Date(now).toISOString(), feeds, posts: [
    post(1, feeds[0], "Placeholder note posted on X about the garden.", 5),
    post(2, feeds[1], "Placeholder picture caption from Instagram.", 30),
    post(3, feeds[2], "Placeholder post from an unrelated sample account.", 45),
    post(4, feeds[0], "Second placeholder note from X.", 90)
  ] };
}

function session(lang) {
  return `(() => {
    localStorage.setItem("superintelapp-lang", ${JSON.stringify(lang)});
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", JSON.stringify({ version: 1, initialized: true }));
    if (!sessionStorage.getItem("lp-seeded")) {
      sessionStorage.setItem("lp-seeded", "1");
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: ${JSON.stringify(Object.assign({}, ACCOUNT, { identities: LINKS() }))} }));
    }
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", backupApi: "", gate: true };
  })()`;
}

function mock(page, log, state) {
  const reply = (route, status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  return page.route("**/v1/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    let body = {};
    try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
    if (method !== "GET") log.push(method + " " + url.pathname + " " + JSON.stringify(body));
    if (url.pathname === "/v1/data/feeds.json") return reply(route, 200, catalog());
    if (url.pathname === "/v1/identities/merged") {
      return reply(route, 200, { merged: state.links.filter((l) => l.merged && !l.hidden).map((l) => ({ platform: l.platform, handle: l.handle, to: "cedarhill", name: "Cedar Hill", avatar: "" })) });
    }
    const m = url.pathname.match(/^\/v1\/account\/identities\/(\d+)$/);
    if (m && method === "PATCH") {
      state.links = state.links.map((l) => {
        if (String(l.id) !== m[1]) return l;
        const next = Object.assign({}, l);
        if (typeof body.merged === "boolean") next.merged = body.merged;
        if (typeof body.hidden === "boolean") next.hidden = body.hidden;
        if (body.audience) { next.audience = body.audience; next.people = body.audience === "people" ? body.people : []; }
        return next;
      });
      return reply(route, 200, { identity: state.links.find((l) => String(l.id) === m[1]) });
    }
    if (url.pathname === "/v1/account/identities") return reply(route, 200, { identities: state.links });
    if (url.pathname.startsWith("/v1/profile/") && url.pathname !== "/v1/profile/cedarhill") return reply(route, 404, { error: "not_found" });
    if (url.pathname.startsWith("/v1/profile/")) return reply(route, 200, { account: Object.assign({}, ACCOUNT, { identities: state.links }), reposts: [] });
    return reply(route, 200, {});
  });
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

const WORDS = {
  en: { lp: "Linked profiles", all: "All", posts: "Posts", everyone: "Everyone can see this", friends: "Your friends can see this", sep: "Keep separate page", merged: "Merged into your profile", people: "Specific people", page: "Linked accounts" },
  es: { lp: "Perfiles vinculados", all: "Todos", posts: "Posts", everyone: "Todos pueden verlo", friends: "Tus amigos pueden verlo", sep: "Mantener página separada", merged: "Unido a tu perfil", people: "Personas específicas", page: "Cuentas vinculadas" }
};

async function check(browser, port, size, lang) {
  const label = lang + "@" + size.name;
  const w = WORDS[lang];
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, serviceWorkers: "block" });
  const page = await context.newPage();
  const log = [];
  const errors = [];
  const state = { links: LINKS() };
  page.on("pageerror", (err) => errors.push(String(err)));
  await mock(page, log, state);
  await page.addInitScript(session(lang));
  const base = "http://127.0.0.1:" + port + "/index.html";
  await page.goto(base + "#/@cedarhill", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".lp-head", { timeout: 20000 }).catch(() => fail(label + ": no Linked profiles button"));
  await page.waitForFunction(() => document.querySelectorAll(".post .lp-src").length >= 3, null, { timeout: 20000 }).catch(() => fail(label + ": merged posts did not show on the profile"));

  /* One mixed timeline: linked posts look like the profile's own. */
  const tl = await page.evaluate(() => Array.from(document.querySelectorAll("article.post")).map((a) => ({
    name: (a.querySelector(".byline .name") || {}).textContent || "",
    handle: (a.querySelector(".byline .handle") || {}).textContent || "",
    href: (a.querySelector(".byline .name") || { getAttribute: () => "" }).getAttribute("href"),
    src: !!a.querySelector(".byline .lp-src"),
    text: a.textContent
  })));
  const linked = tl.filter((p) => p.src);
  if (linked.length !== 3) fail(label + ": expected 3 linked posts, got " + JSON.stringify(tl));
  if (!linked.every((p) => p.name.indexOf("Cedar Hill") >= 0 && p.handle === "@cedarhill" && p.href === "#/@cedarhill")) fail(label + ": linked posts are not drawn as the profile's own " + JSON.stringify(linked));
  if (tl.some((p) => p.text.indexOf("unrelated sample") >= 0)) fail(label + ": an unrelated account's post is on the profile");
  if (!(await page.$$("article.post .action, article.post [data-act='like'], article.post .actions")).length) fail(label + ": linked posts lost their actions");

  /* Optional filters: All, Posts, X, Instagram. */
  const pills = await page.$$eval(".lp-pills .lp-pill", (els) => els.map((e) => e.textContent.trim()));
  if (pills.join("|") !== [w.all, w.posts, "X", "Instagram"].join("|")) fail(label + ": pills " + pills);
  await shot(page, lang + "-" + size.name + "-profile");
  await page.click('.lp-pill[data-src="instagram"]');
  await page.waitForFunction(() => document.querySelectorAll("article.post").length === 1, null, { timeout: 5000 }).catch(() => fail(label + ": Instagram filter did not narrow the timeline"));
  await page.click('.lp-pill[data-src="all"]');
  await page.waitForFunction(() => document.querySelectorAll("article.post .lp-src").length === 3, null, { timeout: 5000 }).catch(() => fail(label + ": All did not restore the timeline"));

  /* The Linked profiles sheet: one row per link, saying who sees it. */
  await page.click(".lp-head");
  await page.waitForSelector(".lp-menu .lp-row", { timeout: 5000 }).catch(() => fail(label + ": sheet did not open"));
  const rows = await page.$$eval(".lp-menu .lp-row", (els) => els.map((e) => e.textContent));
  if (rows.length !== 3) fail(label + ": sheet rows " + rows.length);
  if (rows[0].indexOf(w.everyone) < 0 || rows[0].indexOf(w.merged) < 0 || rows[1].indexOf(w.friends) < 0) fail(label + ": row words " + JSON.stringify(rows));
  if (size.mobile) {
    const box = await page.$eval(".lp-menu", (el) => { const r = el.getBoundingClientRect(); return { bottom: Math.round(r.bottom), width: Math.round(r.width) }; });
    if (box.bottom < size.height - 2 || box.width < size.width - 2) fail(label + ": not a bottom sheet " + JSON.stringify(box));
  }
  await shot(page, lang + "-" + size.name + "-sheet");

  /* A row opens the edit sheet: audience and Merge / Keep separate. */
  await page.click('.lp-menu .lp-row[data-id="12"]');
  await page.waitForSelector('.lp-menu [data-lp="merge"]', { timeout: 5000 }).catch(() => fail(label + ": edit sheet did not open"));
  await shot(page, lang + "-" + size.name + "-edit");
  await page.click('.lp-menu [data-lp="aud"][data-aud="people"]');
  await page.fill("#lp-people-in", "@oakridge, pinecrest");
  await page.click('.lp-menu [data-lp="people-save"]');
  await page.waitForFunction(() => { const b = document.querySelector('.lp-menu [data-aud="people"]'); return b && b.getAttribute("aria-checked") === "true"; }, null, { timeout: 5000 }).catch(() => fail(label + ": specific people not saved"));
  if (!log.some((l) => l.indexOf("PATCH /v1/account/identities/12") === 0 && l.indexOf('"audience":"people"') > 0 && l.indexOf('"people":["oakridge","pinecrest"]') > 0)) fail(label + ": people PATCH " + log);
  await page.click('.lp-menu [data-lp="merge"][data-on="0"]');
  await page.waitForFunction(() => { const b = document.querySelector('.lp-menu [data-lp="merge"][data-on="0"]'); return b && b.getAttribute("aria-checked") === "true"; }, null, { timeout: 5000 }).catch(() => fail(label + ": Keep separate not saved"));
  if (!log.some((l) => l.indexOf("PATCH /v1/account/identities/12") === 0 && l.indexOf('"merged":false') > 0)) fail(label + ": merge PATCH " + log);
  await page.click('.lp-menu .lp-x');
  /* Kept separate: its posts leave the profile; nothing is deleted. */
  await page.waitForFunction(() => document.querySelectorAll("article.post .lp-src").length === 2, null, { timeout: 8000 }).catch(() => fail(label + ": separate link's posts still merged"));
  if (log.some((l) => l.indexOf("DELETE") === 0)) fail(label + ": switching deleted something");

  /* A merged profile's own page and links open the internal profile. */
  await page.goto(base + "#/x/cedar_elsewhere", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.hash === "#/@cedarhill", null, { timeout: 15000 }).catch(() => fail(label + ": merged page did not redirect (" + page.url() + ")"));
  await page.goto(base + "#/u/instagram/cedar.pictures", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  if (/#\/@cedarhill$/.test(page.url())) fail(label + ": a separate page was redirected to the profile");
  await page.goto(base + "#/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Array.from(document.querySelectorAll("article.post")).some((a) => a.textContent.indexOf("Second placeholder") >= 0), null, { timeout: 20000 }).catch(() => fail(label + ": home feed did not load"));
  const authorHref = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll("article.post")).find((el) => el.textContent.indexOf("Second placeholder") >= 0);
    return a.querySelector(".byline .name").getAttribute("href");
  });
  if (authorHref !== "#/@cedarhill") fail(label + ": author link " + authorHref);

  /* Settings > Linked accounts: same rows, accent pill. */
  await page.goto(base + "#/settings/linked", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".lp-page .lp-row", { timeout: 15000 }).catch(() => fail(label + ": settings page empty"));
  const head = await page.textContent("body");
  if (head.indexOf(w.page) < 0) fail(label + ": settings title");
  if ((await page.$$(".lp-page .lp-row")).length !== 3) fail(label + ": settings rows");
  await shot(page, lang + "-" + size.name + "-settings");

  if (errors.length) fail(label + ": page errors " + errors.join(" | "));
  await context.close();
  console.log("ok " + label);
}

const chromium = await loadPlaywright();
const server = await startServer();
const port = server.address().port;
const browser = await chromium.launch();
try {
  for (const lang of ["en", "es"]) for (const size of SIZES) await check(browser, port, size, lang);
  console.log("merged profile ok");
} finally {
  await browser.close();
  server.close();
}
