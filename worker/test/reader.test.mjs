import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { featureFor } from "../src/feature-flags.js";
import { handleReader } from "../src/reader.js";
import { extractArticle } from "../../shared/reader-extract.js";
import { addressesArePublic, isPublicAddress, readerTarget, robotsAllows, sanitizeHtml, suitableUrl } from "../../shared/reader-safe.js";

const ARTICLE = "https://news.example/world/harbour-lights-after-the-storm";
const PUBLIC = ["93.184.216.34"];

const PAGE = `<!doctype html><html lang="en"><head>
<title>Harbour lights return after the storm - Example News</title>
<meta property="og:title" content="Harbour lights return after the storm">
<meta property="og:description" content="A short public summary of the harbour story.">
<meta property="og:site_name" content="Example News">
<meta property="og:image" content="https://cdn.example/hero.jpg">
<meta property="article:published_time" content="2026-11-05T08:00:00Z">
<script type="application/ld+json">{"@type":"NewsArticle","headline":"Harbour lights return after the storm","datePublished":"2026-11-05T08:00:00Z","author":{"@type":"Person","name":"Ada Fixture"},"isAccessibleForFree":true,"image":"https://cdn.example/hero.jpg"}</script>
</head><body>
<nav class="menu"><a href="https://news.example/">Home</a></nav>
<article class="post type-post">
<div class="entry-content">
<p>The harbour lights came back on before dawn, and the pier was quiet enough to hear the tide.</p>
<p>Fishers said the <a href="https://news.example/world/older-storm-notes-from-may" onclick="alert(1)">older notes</a> still match this tide.</p>
<h2>Along the pier</h2>
<figure><img src="https://cdn.example/pier.jpg" alt="Pier lights"><figcaption>Lights along the east pier.</figcaption></figure>
<blockquote><p>We waited for the beam.</p></blockquote>
<p><script>alert(1)</script>The beam turned twice, then settled.</p>
<iframe src="https://evil.example/ad"></iframe>
<img src="https://track.example/pixel.gif" width="1" height="1" alt="">
<img src="javascript:alert(1)" alt="nope">
<form action="https://news.example/login"><input type="password" name="secret"></form>
<p>No one was left on the wall when the light held.</p>
</div>
<div class="topics"><ul><li><a href="https://news.example/tag/harbour">harbour</a></li></ul></div>
</article></body></html>`;

function cacheBox() {
  const box = new Map();
  return {
    box,
    async match(req) {
      const hit = box.get(req.url);
      return hit ? hit.clone() : undefined;
    },
    async put(req, res) { box.set(req.url, res.clone()); }
  };
}

function harness(pages, dns) {
  const calls = [];
  const read = [];
  const fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const spec = pages[target];
    if (!spec) return new Response("no", { status: 404, headers: { "content-type": "text/plain" } });
    if (spec.throw) throw spec.throw;
    const body = spec.body || "";
    const headers = new Headers(spec.headers || { "content-type": "text/html; charset=utf-8" });
    const res = new Response(spec.status && spec.status >= 300 && spec.status < 400 ? null : body, { status: spec.status || 200, headers });
    const mark = () => { read.push(target); };
    const orig = res.text.bind(res);
    res.text = async () => { mark(); return orig(); };
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader.bind(res.body);
      res.body.getReader = () => { mark(); return reader(); };
    }
    return res;
  };
  return {
    calls,
    read,
    fetch,
    resolve: async (host) => (dns && dns[host]) || PUBLIC,
    cache: cacheBox()
  };
}

async function readJson(res) {
  return { status: res.status, body: JSON.parse(await res.text()), cache: res.headers.get("cache-control") || "" };
}

test("reader targets stay on public https hosts", () => {
  assert.equal(readerTarget("http://news.example/a"), null);
  assert.equal(readerTarget("https://user:pass@news.example/a"), null);
  assert.equal(readerTarget("https://news.example:8443/a"), null);
  assert.equal(readerTarget("https://127.0.0.1/latest"), null);
  assert.equal(readerTarget("https://169.254.169.254/latest"), null);
  assert.equal(readerTarget("https://localhost/latest"), null);
  assert.equal(readerTarget("https://metadata.google.internal/computeMetadata/v1/"), null);
  assert.equal(readerTarget("https://meta.internal/secret"), null);
  assert.equal(readerTarget("https://[::1]/"), null);
  assert.ok(readerTarget(ARTICLE));
  assert.equal(suitableUrl("https://news.example/"), false);
  assert.equal(suitableUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), false);
  assert.equal(suitableUrl("https://cdn.example/photo.jpg"), false);
  assert.equal(suitableUrl(ARTICLE), true);
  assert.equal(featureFor("/v1/reader"), "article_reader");
});

test("private, loopback, link-local and metadata addresses are refused", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.4", "172.16.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255", "::1", "fe80::1", "fd00::1", "fc00::", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  assert.equal(isPublicAddress("93.184.216.34"), true);
  assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
  assert.equal(addressesArePublic(["93.184.216.34", "127.0.0.1"]), false);
  assert.equal(addressesArePublic([]), false);
});

test("robots rules allow a public article and block the disallowed path", () => {
  const robots = [
    "User-agent: *",
    "Disallow: /buscador/",
    "Disallow: /newsletter/",
    "Disallow: /*.pdf$",
    "",
    "User-agent: HTTrack",
    "Disallow: /"
  ].join("\n");
  assert.equal(robotsAllows(robots, "/world/harbour-lights-after-the-storm", "ViktorychAppReader"), true);
  assert.equal(robotsAllows(robots, "/newsletter/latest", "ViktorychAppReader"), false);
  assert.equal(robotsAllows(robots, "/files/notes.pdf", "ViktorychAppReader"), false);
  assert.equal(robotsAllows(robots, "/world/harbour-lights-after-the-storm", "HTTrack"), false);
  assert.equal(robotsAllows("", "/any", "ViktorychAppReader"), true);
});

test("sanitizer drops scripts, forms, pixels and unsafe links", () => {
  const html = sanitizeHtml(PAGE, ARTICLE);
  assert.match(html, /harbour lights came back/);
  assert.match(html, /Lights along the east pier/);
  assert.match(html, /href="https:\/\/news\.example\/world\/older-storm-notes-from-may"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(html, /<script|<iframe|<form|onclick|javascript:|pixel\.gif|type="password"/i);
  assert.doesNotMatch(html, /news\.example\/tag\/harbour/);
});

test("extraction keeps title, byline, date and body from a news page", () => {
  const doc = extractArticle(PAGE, ARTICLE);
  assert.equal(doc.title, "Harbour lights return after the storm");
  assert.equal(doc.byline, "Ada Fixture");
  assert.equal(doc.date, "2026-11-05T08:00:00Z");
  assert.equal(doc.site, "Example News");
  assert.equal(doc.image, "https://cdn.example/hero.jpg");
  assert.equal(doc.paywall, false);
  assert.equal(doc.login, false);
  assert.ok(doc.wordCount > 20);
  assert.match(doc.html, /<figcaption>Lights along the east pier\.<\/figcaption>/);
});

test("a paywalled or login page does not return the gated body", () => {
  const gated = PAGE.replace('"isAccessibleForFree":true', '"isAccessibleForFree":false').replace("The harbour lights came back", "SUBSCRIBER ONLY PARAGRAPH TOKEN");
  const doc = extractArticle(gated, ARTICLE);
  assert.equal(doc.paywall, true);
  assert.equal(doc.html, "");
  assert.equal(doc.title, "Harbour lights return after the storm");
  assert.equal(JSON.stringify(doc).includes("SUBSCRIBER ONLY PARAGRAPH TOKEN"), false);
  const login = `<html><head><title>Sign in</title><meta property="og:title" content="Sign in"></head><body><form><input type="password"></form><p>Members only.</p></body></html>`;
  const wall = extractArticle(login, "https://news.example/account/members-sign-in-page");
  assert.equal(wall.login, true);
  assert.equal(wall.html, "");
});

test("the reader fetches a public article once and serves it from cache", async () => {
  const deps = harness({
    [ARTICLE]: { body: PAGE },
    "https://news.example/robots.txt": { body: "User-agent: *\nDisallow: /newsletter/\n", headers: { "content-type": "text/plain" } }
  });
  const first = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(ARTICLE)), deps));
  assert.equal(first.status, 200);
  assert.equal(first.body.mode, "article");
  assert.equal(first.body.byline, "Ada Fixture");
  assert.match(first.body.html, /harbour lights came back/);
  assert.doesNotMatch(first.body.html, /<script|onclick|javascript:/i);
  assert.match(first.cache, /max-age=600/);
  const before = deps.calls.length;
  const second = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(ARTICLE)), deps));
  assert.equal(second.body.mode, "article");
  assert.equal(deps.calls.length, before);
});

test("private DNS answers and unsafe redirects are not fetched", async () => {
  const article = "https://news.example/world/public-story-with-a-long-slug";
  const deps = harness({
    [article]: { status: 302, headers: { location: "https://metadata.google.internal/computeMetadata/v1/", "content-type": "text/html" } },
    "https://news.example/robots.txt": { status: 404, headers: { "content-type": "text/plain" } }
  }, { "news.example": ["10.0.0.8"] });
  const blocked = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(article)), deps));
  assert.equal(blocked.body.reason, "blocked");
  assert.equal(blocked.body.html, "");
  assert.equal(deps.calls.length, 0);

  const redirect = harness({
    [article]: { status: 302, headers: { location: "http://news.example/world/public-story-with-a-long-slug" } },
    "https://news.example/robots.txt": { status: 404, headers: { "content-type": "text/plain" } }
  });
  const moved = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(article)), redirect));
  assert.equal(moved.body.reason, "blocked");
  assert.equal(moved.body.html, "");
  assert.ok(redirect.calls.includes(article));
  assert.equal(redirect.calls.filter((url) => url.startsWith("http://")).length, 0);

  const local = harness({
    [article]: { status: 302, headers: { location: "https://box.internal/secret" } },
    "https://news.example/robots.txt": { status: 404, headers: { "content-type": "text/plain" } }
  });
  const internal = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(article)), local));
  assert.equal(internal.body.reason, "blocked");
  assert.equal(local.calls.includes("https://box.internal/secret"), false);
});

test("link-local answers, robots denials, non-html and paywalls fall back", async () => {
  const linkLocal = "https://cdn.example/world/a-long-public-story-slug";
  const local = harness({
    [linkLocal]: { body: PAGE },
    "https://cdn.example/robots.txt": { status: 404, headers: { "content-type": "text/plain" } }
  }, { "cdn.example": ["169.254.169.254"] });
  const denied = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(linkLocal)), local));
  assert.equal(denied.body.reason, "blocked");
  assert.equal(local.calls.length, 0);

  const hidden = "https://news.example/newsletter/weekly-members-letter";
  const robots = harness({
    [hidden]: { body: PAGE },
    "https://news.example/robots.txt": { body: "User-agent: *\nDisallow: /newsletter/\n", headers: { "content-type": "text/plain" } }
  });
  const skip = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(hidden)), robots));
  assert.equal(skip.body.reason, "robots");
  assert.equal(skip.body.html, "");
  assert.equal(robots.calls.includes(hidden), false);

  const file = "https://files.example/reports/annual-report-2026";
  const pdf = harness({
    [file]: { body: "%PDF-1.7", headers: { "content-type": "application/pdf" } },
    "https://files.example/robots.txt": { status: 404, headers: { "content-type": "text/plain" } }
  });
  const typed = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(file)), pdf));
  assert.equal(typed.body.reason, "type");
  assert.equal(typed.body.html, "");
  assert.equal(pdf.read.includes(file), false);

  const paid = ARTICLE.replace("harbour-lights", "members-only-harbour");
  const wall = harness({
    [paid]: { body: PAGE.replace('"isAccessibleForFree":true', '"isAccessibleForFree":false') },
    "https://news.example/robots.txt": { status: 404, headers: { "content-type": "text/plain" } }
  });
  const preview = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(paid)), wall));
  assert.equal(preview.body.mode, "preview");
  assert.equal(preview.body.reason, "paywall");
  assert.equal(preview.body.html, "");
  assert.equal(preview.body.title, "Harbour lights return after the storm");
});

test("a bad url is refused and a private response is not cached for long", async () => {
  const deps = harness({});
  const bad = await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent("http://127.0.0.1/secret")), deps);
  assert.equal(bad.status, 400);
  assert.equal(deps.calls.length, 0);
  const page = "https://news.example/world/private-cache-story-slug";
  const personal = harness({
    [page]: { body: PAGE, headers: { "content-type": "text/html", "cache-control": "private, no-store" } },
    "https://news.example/robots.txt": { status: 404, headers: { "content-type": "text/plain" } }
  });
  const first = await readJson(await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(page)), personal));
  assert.equal(first.body.mode, "article");
  assert.equal(first.cache, "no-store");
  const count = personal.calls.length;
  await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(page)), personal);
  assert.ok(personal.calls.length > count);
});

test("reader code does not special-case one publisher", () => {
  for (const file of ["shared/reader-safe.js", "shared/reader-extract.js", "worker/src/reader.js", "reader.js", "reader.css"]) {
    assert.equal(readFileSync(new URL("../../" + file, import.meta.url), "utf8").toLowerCase().includes("okdiario"), false, file);
  }
});

test("a public okdiario article, when the site answers", async (t) => {
  const ua = "ViktorychAppReader/1.0 (+https://viktorychgroup.github.io/ViktorychApp; public reading view)";
  let found = "";
  try {
    const home = await fetch("https://okdiario.com/", { headers: { "user-agent": ua, accept: "text/html" }, signal: AbortSignal.timeout(8000) });
    if (!home.ok) return t.skip("okdiario home did not answer");
    const html = await home.text();
    const links = html.match(/https:\/\/okdiario\.com\/[a-z0-9-]+\/[a-z0-9-]{24,}/g) || [];
    found = links.map((link) => link.split("?")[0]).find((link) => !/\/(tag|autor|author|newsletter|buscador|okclub)\//.test(link)) || "";
  } catch (err) {
    return t.skip("okdiario was not reachable");
  }
  if (!found) return t.skip("okdiario did not list an article link");
  const deps = { fetch: globalThis.fetch, cache: null, now: () => Date.now() };
  const res = await handleReader(new Request("https://api.test/v1/reader?url=" + encodeURIComponent(found)), deps);
  const body = JSON.parse(await res.text());
  if (body.reason === "timeout" || body.reason === "blocked" || body.reason === "type") {
    return t.skip("okdiario did not return a readable page");
  }
  if (body.reason === "paywall" || body.reason === "login" || body.reason === "robots") {
    assert.equal(body.html, "");
    assert.equal(body.mode, "preview");
    return;
  }
  assert.equal(body.mode, "article");
  assert.equal(body.domain.endsWith("okdiario.com"), true);
  assert.ok(body.title && body.title.length > 8);
  assert.ok(body.wordCount > 200);
  assert.ok(body.byline && body.byline.length > 1 && body.byline.length < 80);
  assert.ok(Date.parse(body.date));
  assert.match(body.html, /<p\b/);
  assert.doesNotMatch(body.html, /<script|<iframe|<form|onerror|javascript:/i);
});
