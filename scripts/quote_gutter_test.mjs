/* Quote posts on a phone: the quoted card widens left into the empty space
   under the author's avatar, so it lines up with the avatar's left edge.
   Normal posts, link cards, thread parents (their connector line runs down
   that space), posts with the picture hidden, and desktop keep their layout.
   Demo names only. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
  throw new Error(message);
}

async function loadPlaywright() {
  const spec = process.env.PLAYWRIGHT_CORE || "playwright-core";
  const href = spec.startsWith("/") ? pathToFileURL(spec).href : spec;
  const mod = await import(href);
  return mod.chromium || (mod.default && mod.default.chromium);
}

// The feed card still nests the quote inside .post-main next to the avatar.
const cardStart = app.indexOf("function card(post, mode, opts)");
const cardFn = app.slice(cardStart, app.indexOf("function emptyBlock(", cardStart));
if (cardStart < 0 || cardFn.indexOf('<div class="post-row">') < 0 || cardFn.indexOf('<div class="post-main">') < 0 || cardFn.indexOf("quoteCard(post.quoted)") < 0) fail("feed card markup changed; update the quote gutter test");

const AVA = '<img class="ava" alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22%3E%3Crect width=%2240%22 height=%2240%22 fill=%22%231d9bf0%22/%3E%3C/svg%3E">';
const PHOTO = '<div class="media m1"><div class="tile" style="aspect-ratio:16/9;background:#e7e9ea"></div></div>';
const quote = (extra) => `<div class="quote"${extra || ""} data-open="#/status/q"><div class="quote-head"><span class="name">Demo Quoted</span><span class="handle">@demo_quoted</span><span class="dot">·</span><span class="time">3 Nov</span></div><div class="quote-text">A quoted demo post with a couple of lines of text so the card has some height to it.</div>${PHOTO}</div>`;
const bar = '<div class="actions"><span class="action">1</span><span class="action">2</span><span class="action">3</span></div>';
const post = (id, body, opts = {}) => `<article class="post${opts.continues ? " continues" : ""}" data-case="${id}"><div class="post-row">${opts.continues ? `<div class="ava-col"><a>${AVA}</a><div class="thread-line"></div></div>` : `<a>${opts.noAva ? '<span class="ava-none"></span>' : AVA}</a>`}<div class="post-main"><div class="byline"><a class="name">Demo Author</a><a class="handle">@demo_author</a><span class="dot">·</span><a class="time">13h</a></div><div class="post-text">Demo post text above the quote.</div>${body}${bar}</div></div></article>`;

const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><style>.post{content-visibility:visible}</style></head><body><main id="col">
${post("quote", quote())}
${post("plain", '<div class="post-text">No quote here.</div>')}
${post("link", '<a class="quote lp-post" href="#"><span class="quote-head"><span class="name">Demo link</span></span><span class="quote-text lp-post-text">A link card</span></a>')}
<div class="thread">${post("parent", quote(), { continues: true })}${post("child", quote())}</div>
${post("noava", quote(), { noAva: true })}
</main></body></html>`;

const MEASURE = `(() => {
  const out = {};
  document.querySelectorAll("[data-case]").forEach((el) => {
    const ava = el.querySelector(".post-row .ava:not(.ava-none)");
    const main = el.querySelector(".post-main");
    const q = el.querySelector(".post-main > .quote");
    const text = el.querySelector(".post-main > .post-text");
    const r = (n) => n ? n.getBoundingClientRect() : null;
    const a = r(ava), m = r(main), qq = r(q), t = r(text), p = el.getBoundingClientRect();
    out[el.dataset.case] = { avaLeft: a && a.left, mainLeft: m.left, mainRight: m.right, quoteLeft: qq && qq.left, quoteRight: qq && qq.right, textLeft: t && t.left, postLeft: p.left, scrollW: document.documentElement.scrollWidth };
  });
  return out;
})()`;

const near = (a, b, what) => { if (Math.abs(a - b) > 1) fail(what + ": " + a + " vs " + b); };

async function shoot(browser, width, height, mobile) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const p = await context.newPage();
  await p.setContent(page, { waitUntil: "load" });
  const m = await p.evaluate(MEASURE);
  const dir = process.env.QUOTE_SHOTS;
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    await p.screenshot({ path: path.join(dir, (process.env.QUOTE_SHOT_TAG || "after") + "-" + width + ".png"), fullPage: true });
  }
  await context.close();
  return m;
}

async function main() {
  const chromium = await loadPlaywright();
  if (!chromium) fail("Playwright chromium is missing");
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const phone = await shoot(browser, 390, 1500, true);
    const q = phone.quote;
    if (phone.quote.scrollW > 390) fail("quote widening made the page scroll sideways");
    near(q.quoteLeft, q.avaLeft, "phone quote card should start at the avatar's left edge");
    near(q.quoteRight, q.mainRight, "phone quote card keeps its right edge");
    near(q.textLeft, q.mainLeft, "post text stays in its column");
    near(phone.child.quoteLeft, phone.child.avaLeft, "a reply's quote under its parent widens too");
    near(phone.parent.quoteLeft, phone.parent.mainLeft, "a thread parent keeps its connector space");
    near(phone.noava.quoteLeft, phone.noava.mainLeft, "no picture: no gutter to fill");
    near(phone.noava.mainLeft, phone.noava.postLeft + 16, "no picture: the text column starts at the padding");
    near(phone.link.quoteLeft, phone.link.mainLeft, "link cards stay in the text column");
    const desk = await shoot(browser, 1280, 1500, false);
    near(desk.quote.quoteLeft, desk.quote.mainLeft, "desktop quote card stays in the text column");
    console.log("quote gutter ok");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(err && err.message ? err.message : err);
});
