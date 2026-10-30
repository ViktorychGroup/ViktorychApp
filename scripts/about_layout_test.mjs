/* About stays in the profile flow on a phone and a tablet.
   The edit sheet is separate. Empty sections stay out of other people's view. */
import fs from "node:fs";
import http from "node:http";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function staticChecks() {
  const css = read("accounts.css");
  const about = css.slice(css.indexOf(".about {"), css.indexOf(".about-sheet {"));
  if (!about.includes(".about-section")) fail("about section missing");
  if (/position:\s*fixed/.test(about) || /position:\s*absolute/.test(about)) fail("about section must stay in flow");
  if (!css.includes("max-width: 499px") || !css.includes("min-width: 500px) and (max-width: 999px)")) fail("about needs phone and tablet rules");
  const ui = read("about-ui.js");
  if (!ui.includes("Personal details") || !ui.includes("data-about=\"edit\"")) fail("about editor missing");
  const page = read("accounts.js");
  if (!page.includes('activeTab === "about"') || !page.includes("ProfileAbout.showTab")) fail("profile about tab missing");
  const external = read("app.js");
  const profile = external.slice(external.indexOf("function profileView"), external.indexOf("function statusView"));
  if (profile.includes("ProfileAbout") || profile.includes("?tab=about")) fail("external profiles must not grow an About tab");
  if (!read("sw.js").includes('VERSION = "viktorych-a270-__SW_VERSION__"')) fail("service worker cache was not bumped");
  console.log("ok about layout rules");
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><link rel=\"stylesheet\" href=\"/accounts.css\"><link rel=\"stylesheet\" href=\"/styles.css\"><div id=\"mount\"></div><article id=\"post\">post</article><script src=\"/about-ui.js\"></script>");
      return;
    }
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep)) {
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
      const type = file.endsWith(".css") ? "text/css" : "text/javascript";
      res.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function browserChecks() {
  if (!process.env.PLAYWRIGHT_CORE) {
    console.log("about browser check skipped");
    return;
  }
  const href = pathToFileURL(process.env.PLAYWRIGHT_CORE).href;
  const mod = await import(href);
  const chromium = mod.chromium || (mod.default && mod.default.chromium);
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    for (const width of [390, 768]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        const html = ProfileAbout.previewHtml({
          owner: true,
          sections: [{
            id: "personal",
            fields: [
              { id: "1", section: "personal", kind: "city", text: "sample city", audience: "public" },
              { id: "2", section: "personal", kind: "relationship", text: "sample status", audience: "only" },
              { id: "3", section: "personal", kind: "language", text: "sample one", audience: "public" },
              { id: "4", section: "personal", kind: "language", text: "sample two", audience: "public" },
              { id: "5", section: "personal", kind: "family", text: "kin", person: { handle: "user_b", name: "user_b" } },
              { id: "6", section: "personal", kind: "family", text: "kin", person: { handle: "user_c", name: "user_c" } },
              { id: "7", section: "personal", kind: "family", text: "kin", person: { handle: "user_d", name: "user_d" } }
            ]
          }]
        }, true);
        document.getElementById("mount").innerHTML = html;
      });
      const box = await page.evaluate(() => {
        const section = document.querySelector(".about-section");
        const post = document.getElementById("post");
        const style = getComputedStyle(section);
        const sectionBox = section.getBoundingClientRect();
        const postBox = post.getBoundingClientRect();
        return {
          position: style.position,
          overlap: sectionBox.bottom - postBox.top,
          pencil: document.querySelectorAll(".about-pencil").length,
          lock: document.querySelectorAll(".about-aud").length,
          text: document.querySelector(".about").innerText
        };
      });
      if (box.position === "fixed" || box.position === "absolute") fail(width + " about covers the page");
      if (box.overlap > 1) fail(width + " about overlaps the post");
      if (box.pencil < 1) fail(width + " missing edit pencil");
      if (box.lock < 1) fail(width + " missing privacy icon");
      if (!box.text.includes("sample one · sample two")) fail(width + " languages were not dotted");
      if (!box.text.includes("3 family members") && !box.text.includes("3 familiares") && !box.text.includes("3 родственников") && !box.text.includes("3 родственника")) fail(width + " family count missing");
      await page.close();
    }
    const hidden = await (async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
      await page.goto("http://127.0.0.1:" + port + "/", { waitUntil: "domcontentloaded" });
      const html = await page.evaluate(() => ProfileAbout.previewHtml({ owner: false, sections: [] }, false));
      await page.close();
      return html;
    })();
    if (hidden) fail("an empty about was shown to someone else");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("ok about on phone and tablet");
}

staticChecks();
/* Badge achievement toast and its settings ride along with the profile badges. */
execFileSync(process.execPath, [path.join(root, "scripts", "achievement_test.js")], { stdio: "inherit" });
/* Settings alerts reuse the same pop-out for warnings and the auto-open countdown. */
execFileSync(process.execPath, [path.join(root, "scripts", "setting_alerts_test.js")], { stdio: "inherit" });
await browserChecks();
