/* Following / Followers of external accounts, X-style: header, three tabs,
   user cells, infinite scroll, and the calm empty state. Every source is
   mocked; every account is a placeholder. Set FOLLOWING_SHOTS=<dir> to keep
   screenshots. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.FOLLOWING_SHOTS || "";

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
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

const SIZES = [
  { name: "desktop", width: 1280, height: 860, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true }
];

const COLORS = ["#1d9bf0", "#f91880", "#00ba7c", "#ffd400", "#7856ff", "#ff7a00"];
function face(i) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${COLORS[i % COLORS.length]}"/><circle cx="48" cy="38" r="18" fill="#fff" opacity=".85"/><rect x="18" y="62" width="60" height="34" rx="17" fill="#fff" opacity=".85"/></svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}
const BIOS = ["Writes about maps and trains.", "Photographer. Coffee first.", "", "Building small tools for the web.", "Placeholder account for tests.", "Plants, bikes, and long walks."];
function people(prefix, from, count) {
  return Array.from({ length: count }, (_, k) => {
    const i = from + k;
    return { n: i, handle: `${prefix}_${String(i).padStart(2, "0")}`, name: `Sample Person ${i}`, bio: BIOS[i % BIOS.length], avatar: face(i) };
  });
}

function sessionScript() {
  const settings = { version: 1, initialized: true, follows: ["bsky:sample-03.example", "bsky:sample-05.example"] };
  return `(() => {
    localStorage.setItem("superintelapp-lang", "en");
    localStorage.setItem("viktorychapp-lang-user-picked", "1");
    localStorage.setItem("viktorychapp-settings-v1", ${JSON.stringify(JSON.stringify(settings))});
    localStorage.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-a", account: { handle: "user_a", displayName: "User A" } }));
    window.VIKTORYCH_ACCOUNTS = { api: "https://accounts.test", gate: true };
  })()`;
}

async function installRoutes(page, counts) {
  // Nothing leaves the machine: unknown hosts get an empty 404.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/ext-graph/x") {
      counts.x += 1;
      const cursor = url.searchParams.get("cursor") || "";
      const rows = cursor ? people("fake", 21, 6) : people("fake", 1, 20);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        items: rows.map((p) => ({ handle: p.handle, name: p.name, bio: p.bio, avatar: p.avatar, verifiedType: p.n % 4 === 0 ? "blue" : undefined })),
        cursor: cursor ? "" : "PAGE2", following: 26, followers: 1200, source: "nitter"
      }) });
      return;
    }
    if (url.pathname === "/v1/follows") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ids: ["bsky:sample-03.example", "bsky:sample-05.example"], followingCount: 2, followersCount: 0 }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("https://api.fxtwitter.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, user: { screen_name: "fake_subject", name: "Sample Subject", followers: 1200, following: 26, avatar_url: face(9) } }) }));
  await page.route("https://public.api.bsky.app/xrpc/**", async (route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.split("/").pop();
    const bsky = (p) => ({ did: "did:plc:" + p.handle.replace(/[^a-z0-9]/g, ""), handle: p.handle, displayName: p.name, description: p.bio, avatar: p.avatar });
    const list = people("sample", 1, 8).map((p) => Object.assign(p, { handle: p.handle.replace("_", "-") + ".example" }));
    let body = {};
    if (m === "app.bsky.actor.getProfile") body = { did: "did:plc:subject", handle: "subject.example", displayName: "Sample Bluesky", followersCount: 8, followsCount: 8, postsCount: 3 };
    else if (m === "app.bsky.graph.getFollows" || m === "app.bsky.graph.getFollowers") body = { subject: { handle: "subject.example", followsCount: 8, followersCount: 8 }, [m.endsWith("Follows") ? "follows" : "followers"]: list.map(bsky) };
    else if (m === "app.bsky.graph.getRelationships") body = { relationships: url.searchParams.getAll("others").map((h) => ({ did: "did:plc:" + h.replace(/[^a-z0-9]/g, ""), followedBy: "at://x" })) };
    else if (m === "app.bsky.actor.getProfiles") {
      const want = url.searchParams.getAll("actors");
      body = { profiles: list.map(bsky).filter((p) => want.indexOf(p.did) >= 0) };
    } else if (m === "app.bsky.feed.getAuthorFeed") body = { feed: [] };
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
}

async function open(browser, port, size, hash, counts) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    isMobile: !!size.mobile,
    hasTouch: !!size.mobile,
    serviceWorkers: "block",
    colorScheme: "dark",
    userAgent: size.mobile ? "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" : undefined
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error("pageerror", err.message));
  await installRoutes(page, counts);
  await page.addInitScript(sessionScript());
  await page.goto("http://127.0.0.1:" + port + "/index.html" + hash, { waitUntil: "domcontentloaded" });
  return { context, page };
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, name + ".png") });
}

async function checkTabs(page, label, active) {
  const tabs = await page.locator(".ext-graph-tabs .tab").allInnerTexts();
  if (tabs.join("|") !== "Followers you know|Followers|Following") fail(label + " tabs " + tabs.join("|"));
  const on = await page.locator(".ext-graph-tabs .tab.on").innerText();
  if (on !== active) fail(label + " active tab " + on);
  const fits = await page.evaluate(() => { const el = document.querySelector(".ext-graph-tabs"); return el.scrollWidth <= el.clientWidth + 1; });
  if (!fits) fail(label + " tabs overflow");
  if (!(await page.locator(".ext-graph-bar [data-act='back']").count())) fail(label + " back arrow");
}

async function run(browser, port, size) {
  const counts = { x: 0 };
  const label = size.name;
  // X following: first page, then the sentinel loads the second page.
  let { context, page } = await open(browser, port, size, "#/x/fake_subject/following", counts);
  try {
    await page.waitForSelector(".ext-graph-list .connect-row", { timeout: 15000 });
    await checkTabs(page, label + " x", "Following");
    const head = await page.locator(".ext-graph-bar .pt-name").innerText();
    if (head !== "Sample Subject") fail(label + " header name " + head);
    if ((await page.locator(".ext-graph-bar .pt-count").innerText()) !== "@fake_subject") fail(label + " header handle");
    if ((await page.locator(".ext-graph-list .connect-row").count()) !== 20) fail(label + " first page");
    if ((await page.locator(".ext-graph-list .connect-row .follow").count()) < 20) fail(label + " follow pills");
    if (!(await page.locator(".ext-graph-list .connect-bio").count())) fail(label + " bios");
    await shot(page, label + "-x-following");
    // Scroll the sentinel inside the page. Holding the node with
    // scrollIntoViewIfNeeded races the redraw that replaces it once the
    // next page arrives, which showed up as "not attached" while waiting
    // for the element to be stable. The checks below stay the same.
    await page.evaluate(() => {
      const el = document.getElementById("ext-graph-more");
      if (el) el.scrollIntoView({ block: "center" });
    });
    await page.waitForFunction(() => document.querySelectorAll(".ext-graph-list .connect-row").length === 26, null, { timeout: 15000 });
    if (await page.locator("#ext-graph-more").count()) fail(label + " sentinel stays after last page");
    if (counts.x !== 2) fail(label + " x page reads " + counts.x);
  } finally { await context.close(); }

  // Instagram: no public list, calm empty state.
  ({ context, page } = await open(browser, port, size, "#/instagram/fake_subject/following", counts));
  try {
    await page.waitForSelector(".ext-graph-empty h2", { timeout: 15000 });
    const title = await page.locator(".ext-graph-empty h2").innerText();
    if (title !== "This platform doesn’t show who this account follows publicly") fail(label + " empty title " + title);
    await checkTabs(page, label + " instagram", "Following");
    await shot(page, label + "-empty-state");
  } finally { await context.close(); }

  // Bluesky followers you know: exact set from getRelationships.
  ({ context, page } = await open(browser, port, size, "#/bsky/subject.example/followers_you_follow", counts));
  try {
    await page.waitForFunction(() => document.querySelectorAll(".ext-graph-list .connect-row").length === 2, null, { timeout: 15000 });
    await checkTabs(page, label + " bsky known", "Followers you know");
    const handles = await page.locator(".ext-graph-list .connect-row .handle").allInnerTexts();
    if (!handles.every((h) => /sample-0[35]\.example/.test(h))) fail(label + " known handles " + handles.join(","));
    await page.waitForFunction(() => document.querySelectorAll(".ext-graph-list .connect-row .follow.following").length === 2, null, { timeout: 15000 });
    await shot(page, label + "-followers-you-know");
    await page.locator(".ext-graph-tabs a.tab[href$='/followers']").click();
    await page.waitForFunction(() => document.querySelectorAll(".ext-graph-list .connect-row").length === 8, null, { timeout: 15000 });
    await checkTabs(page, label + " bsky followers", "Followers");
    await shot(page, label + "-bsky-followers");
  } finally { await context.close(); }
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL === "none" ? undefined : (process.env.PLAYWRIGHT_CHANNEL || "chrome") });
  try {
    for (const size of SIZES) await run(browser, port, size);
  } finally {
    await browser.close();
    server.close();
  }
  if (process.exitCode) fail("external following checks failed");
  console.log("external following ok");
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
