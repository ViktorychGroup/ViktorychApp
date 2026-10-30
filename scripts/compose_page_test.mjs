/* Phone and desktop composer. Open, type, counter, attach, poll, thread,
   draft save and resume, reply setting, and post. Placeholders only. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widths = [
  { width: 390, height: 844, name: "phone" },
  { width: 1280, height: 800, name: "desktop" }
];
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".ico")) return "image/x-icon";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(root, rel));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("missing");
        return;
      }
      res.writeHead(200, { "content-type": mime(file), "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

async function openComposer(page, vp) {
  const selector = vp.name === "phone" ? "button.fab" : "button.post-btn";
  const button = page.locator(selector).first();
  await button.waitFor({ state: "visible", timeout: 20000 });
  await button.click();
  await page.locator(".xc-modal #compose-text").waitFor({ timeout: 15000 });
}

async function exercise(page, vp, origin) {
  const sent = [];
  await page.route("**/v1/**", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && new URL(req.url()).pathname === "/v1/posts") {
      let body = {};
      try { body = req.postDataJSON(); } catch (err) { body = {}; }
      sent.push(body);
      const id = (sent.length.toString(16) + "a".repeat(32)).slice(0, 32);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ post: { id: id, body: body.body || "", media: [], authorName: "User A", authorHandle: "user_a", authorId: "100000000001" } })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"posts":[],"ok":true}' });
  });

  await page.goto(origin + "/#/", { waitUntil: "domcontentloaded" });
  await openComposer(page, vp);

  await page.evaluate(() => { document.documentElement.setAttribute("dir", "rtl"); });
  const rtl = await page.evaluate(() => {
    const close = document.querySelector(".xc-modal [data-act='close-modal']").getBoundingClientRect();
    const post = document.querySelector(".xc-modal #compose-post").getBoundingClientRect();
    return close.x > post.x;
  });
  if (!rtl) fail(vp.name + " composer does not mirror in RTL");
  await page.evaluate(() => { document.documentElement.setAttribute("dir", "ltr"); });

  const before = await page.locator(".xc-modal .xc-meter-val").first().getAttribute("stroke-dashoffset");
  await page.locator(".xc-modal #compose-text").fill("hello");
  const after = await page.locator(".xc-modal .xc-meter-val").first().getAttribute("stroke-dashoffset");
  if (before === after) fail(vp.name + " counter did not move");
  await page.locator(".xc-modal #compose-text").fill("a".repeat(270));
  if (!(await page.locator(".xc-modal .xc-count.near").count())) fail(vp.name + " counter did not warn near the limit");
  await page.locator(".xc-modal #compose-text").fill("a".repeat(281));
  if (!(await page.locator(".xc-modal .xc-count.over").count())) fail(vp.name + " counter did not mark the limit");
  if (await page.locator(".xc-modal #compose-post").isEnabled()) fail(vp.name + " post stayed enabled over the limit");
  await page.locator(".xc-modal #compose-text").fill("Composer page check");

  await page.locator(".xc-modal input[data-kind='image']").setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG });
  await page.locator(".xc-modal .xc-shot img").waitFor({ timeout: 5000 });
  await page.locator(".xc-modal [data-act='xc-remove-media']").click();
  await page.waitForFunction(() => !document.querySelector(".xc-modal .xc-shot"));

  await page.locator(".xc-modal [data-act='xc-poll']").click();
  const options = page.locator(".xc-modal [data-xc='poll-opt']");
  if (await options.count() < 2) fail(vp.name + " poll did not open");
  await options.nth(0).fill("Yes");
  await options.nth(1).fill("No");
  await page.locator(".xc-modal [data-xc='poll-min']").selectOption("60");

  await page.locator(".xc-modal .xc-plus").click();
  const parts = page.locator(".xc-modal textarea[data-xc='text']");
  if (await parts.count() < 2) fail(vp.name + " thread did not add a post");
  await parts.nth(1).fill("Second part");

  await page.locator(".xc-modal [data-act='xc-reply-menu']").click();
  await page.locator(".xc-modal [data-act='xc-reply-pick'][data-value='following']").click();
  const reply = await page.locator(".xc-modal .xc-reply-row").innerText();
  if (reply.indexOf("Accounts you follow") < 0) fail(vp.name + " reply setting did not change");

  await page.keyboard.press("Escape");
  await page.locator("[data-act='xc-save-draft']").click();
  await page.waitForFunction(() => !document.querySelector(".xc-modal"));
  await openComposer(page, vp);
  const resumed = await page.locator(".xc-modal #compose-text").inputValue();
  if (resumed.indexOf("Composer page check") < 0) fail(vp.name + " draft did not resume");

  await page.locator(".xc-modal #compose-post").click();
  await page.getByText("Your post was sent.").first().waitFor({ timeout: 15000 });
  if (sent.length < 2) fail(vp.name + " thread did not post as a chain");
  if (!sent[0].poll || sent[0].poll.options.length < 2) fail(vp.name + " poll was not sent");
  if (sent[0].replyControl !== "following") fail(vp.name + " reply setting was not sent");
  if (!sent[1].parentId) fail(vp.name + " second post was not chained");
  await page.unroute("**/v1/**");
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
      token: "local-test-token",
      account: { publicId: "100000000001", handle: "user_a", displayName: "User A", avatar: "" }
    }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
  });
  // Home's community and app post cards ride along here so the smoke workflow
  // runs them. They start now and run beside the composer checks.
  const { spawn } = await import("node:child_process");
  const ride = (name) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", name)], { stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code));
  });
  const riders = Promise.all([ride("community_home_test.mjs"), ride("communities_hub_test.mjs"), ride("own_post_test.mjs"), ride("post_page_test.mjs"), ride("music_dock_test.mjs"), ride("video_fallback_test.mjs"), ride("device_guard_test.mjs"), ride("usernames_settings_test.mjs"), ride("display_names_test.mjs"), ride("settings_assistant_test.mjs"), ride("nostr_settings_test.mjs"), ride("games_mobile_test.mjs"), ride("live_translate_test.mjs"), ride("friend_p2p_test.mjs"), ride("communities_instant_test.mjs"), ride("routes_instant_test.mjs"), ride("profile_by_name_test.mjs")]);
  const cmRows = ride("communities_rows_test.mjs");
  const fyCommunities = ride("foryou_communities_test.mjs");
  try {
    for (const vp of widths) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await exercise(page, vp, origin);
    }
    console.log("composer page ok");
    const [home, hub, own, single, dock, vfall, guard, names, dnames, setai, nostr, games, livetr, friendp2p, cinstant, rinstant] = await riders;
    if (home !== 0) fail("community home check failed");
    if (hub !== 0) fail("communities hub check failed");
    if (own !== 0) fail("own post check failed");
    if (single !== 0) fail("post page check failed");
    if (dock !== 0) fail("music dock check failed");
    if (vfall !== 0) fail("video fallback check failed");
    if (guard !== 0) fail("device data protection check failed");
    if (names !== 0) fail("usernames settings check failed");
    if (dnames !== 0) fail("display names check failed");
    if (setai !== 0) fail("settings assistant check failed");
    if (nostr !== 0) fail("nostr check failed");
    if (games !== 0) fail("games check failed");
    if (livetr !== 0) fail("live translate check failed");
    if (friendp2p !== 0) fail("friend p2p check failed");
    if (cinstant !== 0) fail("communities local-first check failed");
    if (rinstant !== 0) fail("routes local-first check failed");
    const fycomm = await fyCommunities;
    if (fycomm !== 0) fail("for you communities check failed");
    if ((await cmRows) !== 0) fail("communities rows check failed");
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
