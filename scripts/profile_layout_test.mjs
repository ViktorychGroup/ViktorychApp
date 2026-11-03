/* Profile header layout: status sits with the edit button, the lock sits with the name.
   Synthetic display data only. Nothing here prints an account id. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { sharedStaticServer } from "./smoke_runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

const accounts = fs.readFileSync(path.join(root, "accounts.js"), "utf8");
const pageStart = accounts.indexOf("function accountPage");
const pageEnd = accounts.indexOf("function profileHtml");
if (pageStart < 0 || pageEnd < pageStart) fail("profile page source missing");
const page = accounts.slice(pageStart, pageEnd);
if (page.includes("acct-id")) fail("profile page still prints an account id");
const nameRowStart = accounts.indexOf("function nameRowHtml");
const nameRow = nameRowStart < 0 ? "" : accounts.slice(nameRowStart, accounts.indexOf("\n  }\n", nameRowStart));
if (!page.includes("protected-badge") && !(page.includes("nameRowHtml(") && nameRow.includes("protected-badge"))) fail("private badge is not next to the name");
if (!page.includes('class="pactions"')) fail("profile actions missing");
const markupAt = page.indexOf("return top + '<div class=\"pinfo\"");
const actionsAt = page.indexOf('class="pactions"', markupAt);
const nameAt = page.indexOf('class="pname"', markupAt);
const statusAt = page.indexOf("seenLine", actionsAt);
if (!(markupAt > 0 && statusAt > actionsAt && statusAt < nameAt)) fail("status text is not in the action row");
if (!(page + nameRow).includes("lockIcon(18)")) fail("private badge is not the name-sized lock");

function mime(file) {
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".webmanifest")) return "application/manifest+json";
  return "application/octet-stream";
}

function startServer() {
  const shared = sharedStaticServer();
  if (shared) return Promise.resolve(shared);
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 }
];

const MEASURE = `(() => {
  const edit = document.querySelector(".pactions .follow");
  const status = document.querySelector(".pactions .presence-lines");
  const name = document.querySelector("h1.pname");
  const lock = document.querySelector("h1.pname .protected-badge");
  const bio = document.querySelector(".pbio");
  const problems = [];
  if (!edit || !status || !name || !lock || !bio) {
    problems.push("missing header parts");
    return problems;
  }
  if (!status.textContent) status.textContent = "Away";
  if (document.querySelector(".acct-id")) problems.push("account id row");
  const text = document.body.innerText || "";
  if (/\\d{12}/.test(text)) problems.push("visible account id");
  if (/\\d{12}/.test(document.title)) problems.push("title account id");
  const editBox = edit.getBoundingClientRect();
  const statusBox = status.getBoundingClientRect();
  const bioBox = bio.getBoundingClientRect();
  const nameBox = name.getBoundingClientRect();
  const lockBox = lock.getBoundingClientRect();
  const statusToEdit = Math.abs(statusBox.top - editBox.top) + Math.abs(statusBox.left - editBox.right);
  const statusToBio = Math.abs(statusBox.top - bioBox.top);
  if (statusToEdit >= statusToBio) problems.push("status is closer to the bio (" + Math.round(statusToEdit) + " vs " + Math.round(statusToBio) + ")");
  if (lockBox.height < 16 || lockBox.height > 22 || lockBox.width < 16 || lockBox.width > 22) problems.push("lock size");
  if (lockBox.top < nameBox.top - 2 || lockBox.bottom > nameBox.bottom + 2) problems.push("lock alignment");
  return problems;
})()`;

async function main() {
  const chromium = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.route("**/v1/**", (route) => {
      const url = route.request().url();
      if (url.includes("/v1/profile/")) {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            account: {
              handle: "vis_layout",
              displayName: "Layout",
              bio: "Short status line",
              avatar: "",
              avatarFace: "default",
              banner: "",
              bannerFace: "none",
              privateFollows: true,
              photos: [],
              banners: [],
              repostsLoaded: true
            },
            reposts: []
          })
        });
        return;
      }
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.addInitScript(() => {
      localStorage.setItem("viktorychapp-account-v1", JSON.stringify({
        token: "layout-token",
        account: {
          publicId: "100000000001",
          handle: "vis_layout",
          displayName: "Layout",
          bio: "Short status line",
          avatar: "",
          avatarFace: "default",
          banner: "",
          bannerFace: "none",
          privateFollows: true
        }
      }));
    });
    await page.goto("http://127.0.0.1:" + port + "/index.html#/@vis_layout", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("h1.pname .protected-badge", { timeout: 15000 });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const problems = await page.evaluate(MEASURE);
      if (problems.length) fail(viewport.name + ": " + problems.join(", "));
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
