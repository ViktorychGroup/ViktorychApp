/* Source requests: the owner's Allow works on every platform.
   Rows show a name and @handle (never the raw link), "Who can see it" opens
   an X-style bottom sheet, a failed Allow says why, and Select all + Allow
   reports what went through. All accounts here are made up.
   SHOTS_DIR=dir saves Spanish phone screenshots; SHOT_ONLY=1 just takes them. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.SHOTS_DIR || "";
const SHOT_ONLY = process.env.SHOT_ONLY === "1";
const SHOT_TAG = process.env.SHOT_TAG || "after";
const sizes = SHOT_ONLY ? [{ width: 390, height: 844, name: "phone", lang: "es" }] : [
  { width: 390, height: 844, name: "phone", lang: "es" },
  { width: 1280, height: 800, name: "desktop", lang: "en" }
];

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (/\.m?js$/.test(file)) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
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
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

function req(id, platform, handle, extra) {
  return Object.assign({
    id, key: platform + ":" + handle.toLowerCase(), kind: "feed", platform, handle, input: platform + ":" + handle,
    name: "", avatar: "", url: "", state: "pending", at: Date.now(), decidedAt: 0, preview: [], dest: "", unseen: true,
    requesters: [{ id: "100000000002", handle: "member_one", name: "Member One", avatar: "", note: "", state: "pending", at: Date.now() }], count: 1
  }, extra || {});
}

function queue() {
  return [
    // An old row still filed as a full link: the row must show @handle.
    req("r-ig", "instagram", "sample.igwave", { input: "https://www.instagram.com/sample.igwave/?igsh=abc123" }),
    req("r-x", "x", "dummy_newsdesk", { name: "Dummy Newsdesk" }),
    req("r-yt", "youtube", "UCaaaaaaaaaaaaaaaaaaaaaa", { name: "Sample Channel", key: "youtube:ucaaaaaaaaaaaaaaaaaaaaaa" }),
    req("r-bs", "bluesky", "example.bsky.social"),
    req("r-tg", "telegram", "sample_channel", { name: "Sample Channel TG" }),
    req("r-rd", "reddit", "examplesub", { kind: "community", key: "reddit:r:examplesub" })
  ];
}

async function run(browser, origin, vp) {
  const tag = vp.name;
  const phone = vp.name === "phone";
  const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const context = await browser.newContext(Object.assign({ serviceWorkers: "block", viewport: { width: vp.width, height: vp.height }, hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 2 : 1 }, phone ? { userAgent: ua } : {}));
  let rows = queue();
  const sent = [];
  let igFails = 1;
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 200, body: "" }));
  await context.route("**/v1/**", async (route) => {
    const r = route.request();
    const where = new URL(r.url()).pathname;
    const reply = (body, status) => route.fulfill({ status: status || 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(body) });
    let body = {};
    try { body = JSON.parse(r.postData() || "{}"); } catch (err) { body = {}; }
    if (where === "/v1/owner/feed-requests/count") return reply({ pending: rows.length, unseen: 0 });
    if (where === "/v1/owner/feed-requests/seen") return reply({ pending: rows.length, unseen: 0 });
    if (where === "/v1/owner/feed-requests" && r.method() === "GET") return reply({ requests: rows, lists: [{ id: "l1", name: "Friends", members: 2 }], pending: rows.length, unseen: 0 });
    const m = where.match(/^\/v1\/owner\/feed-requests\/([^/]+)\/(allow|block|ban)$/);
    if (m && r.method() === "POST") {
      const id = decodeURIComponent(m[1]);
      sent.push(m[2] + ":" + id + ":" + JSON.stringify(body));
      if (id === "r-ig" && igFails > 0) { igFails -= 1; return reply({ error: "down", message: "The source didn't answer." }, 503); }
      rows = rows.filter((row) => row.id !== id);
      return reply({ ok: true, unverified: true, pending: rows.length });
    }
    if (where === "/v1/owner/feed-requests/bulk" && r.method() === "POST") {
      sent.push("bulk:" + JSON.stringify(body));
      const results = body.ids.map((id) => id === "r-rd" ? { id, ok: false, error: "banned" } : { id, ok: true });
      rows = rows.filter((row) => !results.some((x) => x.ok && x.id === row.id));
      return reply({ results, pending: rows.length });
    }
    return reply({ posts: [], ok: true });
  });
  const page = await context.newPage();
  await page.addInitScript(([lang]) => {
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("superintelapp-lang", lang);
    localStorage.setItem("viktorychapp-welcome-v1", JSON.stringify({ step: 2, done: true }));
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "local-test-token", account: { publicId: "100000000001", handle: "owner_test", displayName: "Owner Test", avatar: "", owner: true } }));
    window.VIKTORYCH_ACCOUNTS = { api: location.origin, gate: true, tiktokAudience: "owner" };
    window.__toasts = [];
    document.addEventListener("DOMContentLoaded", () => {
      const el = document.getElementById("toast");
      if (el) new MutationObserver(() => { if (el.textContent) window.__toasts.push(el.textContent); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
  }, [vp.lang]);
  await page.goto(origin + "/#/settings/feed-requests", { waitUntil: "domcontentloaded" });
  await page.locator(".fr-qrow").first().waitFor({ timeout: 20000 }).catch(() => fail(tag + ": the queue loads"));
  await page.waitForTimeout(400);
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS, SHOT_TAG + "-queue-" + tag + ".png"), fullPage: false });
  }
  if (SHOT_ONLY) { await context.close(); return; }

  const shape = await page.evaluate(() => Array.from(document.querySelectorAll(".fr-qrow")).map((row) => ({
    name: (row.querySelector(".feeds-name") || {}).textContent || "",
    sub: (row.querySelector(".feeds-sub") || {}).textContent || "",
    select: row.querySelectorAll("select").length,
    dest: row.querySelectorAll(".fr-dest").length,
    pills: row.querySelectorAll(".fr-pill").length,
    membersShown: !!Array.from(row.querySelectorAll(".fr-float")).find((el) => el.offsetParent)
  })));
  const ig = shape[0];
  if (!/@sample\.igwave/.test(ig.name + ig.sub) || /https?:|instagram\.com/.test(ig.name + ig.sub)) fail(tag + ": the Instagram row shows @handle, not the link " + JSON.stringify(ig));
  if (!/Instagram/.test(ig.sub)) fail(tag + ": the row names the platform " + JSON.stringify(ig));
  if (!/r\/examplesub/.test(shape[5].name + shape[5].sub)) fail(tag + ": a community shows r/name " + JSON.stringify(shape[5]));
  if (shape.some((s) => s.select || s.dest !== 1 || s.pills !== 3 || s.membersShown)) fail(tag + ": X-style row, no raw select, members hidden " + JSON.stringify(shape));
  const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (over) fail(tag + ": no sideways scroll");

  // A failed Allow says why; a retry goes through.
  await page.click('[data-fr-act="allow"][data-fr-id="r-ig"]');
  await page.waitForFunction(() => window.__toasts.length > 0, null, { timeout: 8000 }).catch(() => fail(tag + ": a failed Allow shows a toast"));
  const failToast = await page.evaluate(() => window.__toasts[window.__toasts.length - 1]);
  if (!/@sample\.igwave/.test(failToast)) fail(tag + ": the failure toast names the source " + failToast);
  if (!(await page.locator('.fr-qrow [data-fr-id="r-ig"]').count())) fail(tag + ": the row stays after a failure");
  await page.click('[data-fr-act="allow"][data-fr-id="r-ig"]');
  await page.waitForFunction(() => !document.querySelector('[data-fr-act="allow"][data-fr-id="r-ig"]'), null, { timeout: 8000 }).catch(() => fail(tag + ": Allow removes the Instagram row"));
  const okToast = await page.evaluate(() => window.__toasts[window.__toasts.length - 1]);
  if (okToast === failToast) fail(tag + ": the success toast replaces the failure one");
  if (sent.filter((s) => s.indexOf("allow:r-ig:") === 0).length !== 2 || !sent.includes('allow:r-ig:{"dest":"everyone"}')) fail(tag + ": Allow posts dest everyone " + JSON.stringify(sent));

  // Who can see it: the sheet picks a destination.
  await page.click('[data-fr-act="dest-open"][data-fr-id="r-x"]');
  await page.locator(".fr-sheet").waitFor({ timeout: 5000 }).catch(() => fail(tag + ": the sheet opens"));
  const sheet = await page.evaluate(() => {
    const s = document.querySelector(".fr-sheet").getBoundingClientRect();
    return { rows: document.querySelectorAll(".fr-sheet-row").length, bottom: Math.round(s.bottom), h: innerHeight, checked: document.querySelectorAll('.fr-sheet-row[aria-checked="true"]').length };
  });
  if (sheet.rows !== 4 || sheet.checked !== 1) fail(tag + ": the sheet lists everyone, only who asked, the list and a new list " + JSON.stringify(sheet));
  if (phone && Math.abs(sheet.bottom - sheet.h) > 2) fail(tag + ": on a phone the sheet sits at the bottom " + JSON.stringify(sheet));
  if (SHOTS && phone) await page.screenshot({ path: path.join(SHOTS, SHOT_TAG + "-sheet-" + tag + ".png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".fr-sheet"), null, { timeout: 3000 }).catch(() => fail(tag + ": Escape closes the sheet"));
  await page.click('[data-fr-act="dest-open"][data-fr-id="r-x"]');
  await page.click('.fr-sheet-row[data-fr-value="list:l1"]');
  await page.waitForFunction(() => !document.querySelector(".fr-sheet"), null, { timeout: 3000 }).catch(() => fail(tag + ": picking closes the sheet"));
  const field = page.locator('.fr-float:not([hidden]) input[data-fr-id="r-x"]');
  if (!(await field.count())) fail(tag + ": a list shows the members field");
  if (!/Friends/.test(await page.textContent('[data-fr-act="dest-open"][data-fr-id="r-x"]'))) fail(tag + ": the row shows the picked list");
  await field.fill("@member_one, member_two");
  await page.waitForTimeout(300);
  if (SHOTS && phone) await page.screenshot({ path: path.join(SHOTS, SHOT_TAG + "-list-" + tag + ".png") });
  await page.click('[data-fr-act="allow"][data-fr-id="r-x"]');
  await page.waitForFunction(() => !document.querySelector('[data-fr-act="allow"][data-fr-id="r-x"]'), null, { timeout: 8000 }).catch(() => fail(tag + ": Allow into a list works"));
  if (!sent.includes('allow:r-x:{"dest":"list","listId":"l1","members":["member_one","member_two"]}')) fail(tag + ": list allow body " + JSON.stringify(sent));

  // Select all + Allow for everyone reports what went through.
  await page.click('[data-fr-act="pick-all"]');
  await page.click('[data-fr-act="bulk"][data-fr-do="allow"]');
  await page.waitForFunction(() => document.querySelectorAll(".fr-qrow").length === 1, null, { timeout: 8000 }).catch(() => fail(tag + ": bulk Allow clears the rows that went through"));
  const bulkToast = await page.evaluate(() => window.__toasts[window.__toasts.length - 1]);
  if (!/3/.test(bulkToast) || !/1/.test(bulkToast)) fail(tag + ": bulk toast counts done and failed " + bulkToast);
  const b = sent.find((s) => s.indexOf("bulk:") === 0) || "";
  for (const id of ["r-yt", "r-bs", "r-tg", "r-rd"]) if (b.indexOf(id) < 0) fail(tag + ": bulk sends every row " + b);
  if (SHOTS && phone) await page.screenshot({ path: path.join(SHOTS, SHOT_TAG + "-bulk-" + tag + ".png") });
  await context.close();
  console.log("feed requests approve ok " + tag);
}

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    for (const vp of sizes) await run(browser, origin, vp);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message);
});
