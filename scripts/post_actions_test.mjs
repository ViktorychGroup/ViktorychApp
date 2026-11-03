/* Every action on a feed post's page works like X, signed in, in the Spanish UI:
   the inline reply (Reply button enables with text) and the reply icon both send
   an app reply that shows right under the post, repost, quote with the post
   embedded, like, bookmark, share (copy link) and the ⋯ menu. Nothing is
   posted to the source platform: replies and quotes go to the app account.
   Fake handles and ids only. SHOTS=/dir saves one shot per action. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.SHOTS || "";
let failures = 0;
function fail(message) { console.error("FAIL " + message); failures += 1; process.exitCode = 1; }

function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

const now = Date.now();
const ID = "910000000000000201";
const ME = "100000000001";
const FIXTURE = {
  updated: new Date(now).toISOString(),
  feeds: [{ id: "x:fake_tech", platform: "x", handle: "fake_tech", name: "Fake Tech", title: "Fake Tech", avatar: "", url: "https://x.com/fake_tech", configured: true }],
  posts: [{
    id: ID, statusId: ID, platform: "x", feedId: "x:fake_tech", kind: "post", author: "Fake Tech", handle: "fake_tech", avatar: "",
    text: "La serie Nova está probando la batería de 8000 mAh (fake)", lang: "es", links: [], date: new Date(now - 3600e3).toISOString(),
    url: "https://x.com/fake_tech/status/" + ID, media: [], images: [], repostedBy: null, replyingTo: null, quoted: null,
    stats: { replies: 0, reposts: 0, likes: 0, views: 30 }
  }]
};

async function loadChromium() {
  const core = process.env.PLAYWRIGHT_CORE || "/workspace/pwcore/node_modules/playwright-core";
  const entry = /\.m?js$/.test(core) ? core : path.join(core, "index.mjs");
  try {
    const mod = await import(core.startsWith("/") ? pathToFileURL(entry).href : core);
    return mod.chromium || (mod.default && mod.default.chromium);
  } catch (err) { return null; }
}

function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (rel.endsWith("/")) rel += "index.html";
    if (/\/feeds\.json$/.test(rel)) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(FIXTURE));
    }
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function run(chromium, port, vp) {
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || "chrome" });
  const sent = [];
  const reposts = [];
  const external = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1, serviceWorkers: "block", locale: "es-ES" });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => {});
    await ctx.route(/^https?:\/\//, (route) => {
      const url = route.request().url();
      if (url.startsWith(origin + "/")) return route.continue();
      if (route.request().method() !== "GET") external.push(route.request().method() + " " + url.replace(/\?.*$/, ""));
      return route.abort();
    });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => fail(`${vp.name}: page error ${String(err && err.message).slice(0, 160)}`));
    await page.addInitScript(() => {
      try {
        localStorage.setItem("lang", "es");
        localStorage.setItem("viktorychapp-lang-user-picked", "1");
        localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
        localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" } }));
      } catch (err) {}
      window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    });
    await page.route("**/v1/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      let body = {};
      try { body = req.postDataJSON() || {}; } catch (err) { body = {}; }
      if (url.pathname === "/v1/posts" && req.method() === "POST") {
        const post = { id: (sent.length + 1).toString(16).padStart(32, "e"), body: body.body || "", createdAt: Date.now(), media: [], authorName: "User A", authorHandle: "user_a", authorId: ME, extParent: body.extParent || null };
        sent.push({ body: body, post: post });
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ post: post }) });
      }
      if (url.pathname === "/v1/posts") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: sent.map((row) => row.post), communitiesHome: true }) });
      if (url.pathname === "/v1/reposts" && req.method() !== "GET") {
        reposts.push(Object.assign({ method: req.method() }, body));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: 200, repost: Object.assign({ createdAt: Date.now() }, body) }) });
      }
      if (/\/v1\/data|feeds/.test(url.pathname)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) });
      return route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"reposts":[],"ok":true}' });
    });
    const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${vp.name}-${name}.png`) }); };
    const settle = (ms) => page.waitForTimeout(ms || 350);
    const status = (sel) => page.locator(`article.status ${sel}`).first();

    await page.goto(origin + "/#/home");
    await page.waitForSelector(`#app article[data-post="${ID}"]`, { timeout: 25000 });
    await page.evaluate((id) => { document.querySelector(`#app article[data-post="${id}"] .post-text`).click(); }, ID);
    await page.waitForSelector("article.status", { timeout: 15000 });
    await settle(600);
    await shot("0-post");

    // Like and bookmark
    await status('[data-act="like"]').click(); await settle();
    if (!(await status('[data-act="like"]').evaluate((b) => b.classList.contains("on")))) fail(`${vp.name}: like does not turn on`);
    await status('[data-act="bookmark"]').click(); await settle();
    if (!(await status('[data-act="bookmark"]').evaluate((b) => b.classList.contains("on")))) fail(`${vp.name}: bookmark does not turn on`);
    await shot("1-like-bookmark");

    // Inline reply: Responder is off until there is text, then sends an app reply that shows under the post
    await page.locator(".xc-inline .xc-slim").first().click(); await settle();
    const area = page.locator(".xc-inline textarea").first();
    await area.waitFor({ timeout: 5000 }).catch(() => fail(`${vp.name}: the inline reply box does not open`));
    const btn = page.locator(".xc-inline .xc-post-btn").first();
    if (!(await btn.isDisabled())) fail(`${vp.name}: Responder should stay off while the reply is empty`);
    await area.click(); await page.keyboard.type("Respuesta en línea (fake)"); await settle(250);
    if (await btn.isDisabled()) fail(`${vp.name}: Responder should turn on once there is text`);
    if ((await btn.textContent()).trim() !== "Responder") fail(`${vp.name}: the reply button should read Responder`);
    await shot("2-reply-typed");
    await btn.click();
    await page.waitForFunction(() => [...document.querySelectorAll("#app article.post:not(.status)")].some((a) => a.textContent.indexOf("Respuesta en línea (fake)") >= 0), null, { timeout: 8000 })
      .catch(() => fail(`${vp.name}: the sent reply should show right under the post`));
    const first = sent[0];
    if (!first || !first.body.extParent || String(first.body.extParent.id || first.body.extParent.statusId) !== ID) fail(`${vp.name}: the reply should go to the app account with the post as its parent`);
    if (await page.locator(".reply-empty").count()) fail(`${vp.name}: "no replies" should go away once you reply`);
    const count = (await status('.action.reply .count').textContent().catch(() => "")).trim();
    if (count !== "1") fail(`${vp.name}: the reply count should show 1, got "${count}"`);
    await settle(400);
    await shot("3-reply-sent");

    // Reply icon opens the composer and sends the same way
    await status('[data-act="xc-reply"]').click();
    await page.waitForSelector(".xc-modal", { timeout: 5000 }).catch(() => fail(`${vp.name}: the reply icon should open the reply composer`));
    const modalArea = page.locator(".xc-modal textarea").first();
    await modalArea.click(); await page.keyboard.type("Respuesta desde el icono (fake)"); await settle(250);
    await shot("4-reply-icon");
    const modalBtn = page.locator(".xc-modal .xc-post-btn, .xc-modal #compose-post").last();
    if (await modalBtn.isDisabled()) fail(`${vp.name}: the composer's reply button should turn on with text`);
    await modalBtn.click();
    await page.waitForFunction(() => [...document.querySelectorAll("#app article.post:not(.status)")].some((a) => a.textContent.indexOf("Respuesta desde el icono (fake)") >= 0), null, { timeout: 8000 })
      .catch(() => fail(`${vp.name}: a reply from the reply icon should show under the post`));
    if (sent.length !== 2 || !sent[1].body.extParent) fail(`${vp.name}: the reply icon should send an app reply to this post (${sent.length} sent)`);

    // Repost
    await status('[data-act="repost"]').click(); await settle();
    if (!(await page.locator('.repost-menu [data-act="repost-do"]').count())) fail(`${vp.name}: repost should open the Repost / Quote menu`);
    await shot("5-repost-menu");
    await page.locator('.repost-menu [data-act="repost-do"]').click(); await settle(600);
    if (!reposts.some((row) => row.kind === "repost")) fail(`${vp.name}: repost should save a repost on the account`);
    if (!(await status('[data-act="repost"]').evaluate((b) => b.classList.contains("on")))) fail(`${vp.name}: repost does not turn on`);

    // Quote: the composer embeds the post, Publicar turns on with a comment
    await status('[data-act="repost"]').click(); await settle();
    await page.locator('.repost-menu [data-act="quote-open"]').click(); await settle(400);
    const embed = await page.locator(".modal .quote-sheet-embed").textContent().catch(() => "");
    if (embed.indexOf("La serie Nova") < 0) fail(`${vp.name}: the quote composer should show the quoted post`);
    await page.locator("#quote-text").click(); await page.keyboard.type("Cita de prueba (fake)"); await settle(250);
    if (await page.locator("#quote-post").isDisabled()) fail(`${vp.name}: Publicar should turn on with a comment`);
    await shot("6-quote");
    await page.locator("#quote-post").click(); await settle(600);
    if (!reposts.some((row) => row.kind === "quote" && row.comment === "Cita de prueba (fake)")) fail(`${vp.name}: the quote should save on the account`);

    // Share: the sheet opens and Copiar enlace copies
    await status('[data-act="share"]').click(); await settle();
    if (!(await page.locator('[data-act="copy"]').count())) fail(`${vp.name}: share should open the share sheet`);
    await shot("7-share");
    await page.locator('[data-act="copy"]').first().click(); await settle(400);
    const toastText = await page.locator("#toast").textContent().catch(() => "");
    if (!toastText.trim()) fail(`${vp.name}: copy link should confirm with a toast`);

    // ⋯ menu
    await status(".status-more").click(); await settle();
    const menu = await page.locator(".status-menu").textContent().catch(() => "");
    if (menu.indexOf("Copiar enlace") < 0) fail(`${vp.name}: the ⋯ menu should open with Copiar enlace`);
    await shot("8-more-menu");

    if (external.length) fail(`${vp.name}: nothing may be sent to an outside site (${external.join(", ")})`);
    console.log(`${vp.name}: checked`);
  } finally {
    await browser.close();
  }
}

const chromium = await loadChromium();
if (!chromium) {
  console.log("skip browser post actions (no playwright-core)");
} else {
  const server = await startServer();
  const port = server.address().port;
  try {
    for (const vp of [{ name: "phone", width: 412, height: 900, mobile: true }, { name: "desktop", width: 1280, height: 900, mobile: false }]) {
      await run(chromium, port, vp);
    }
  } finally {
    server.close();
  }
}
console.log(failures ? `post actions: ${failures} failure(s)` : "ok every action on a post page works like X");
