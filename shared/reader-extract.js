/* Pick the main text of a public HTML page and describe it.
   Metadata comes from JSON-LD and the usual meta tags. The body is the
   block with the most article-like text. Paywalled, login-only, and
   noarchive pages return no body. No publisher is special-cased. */

import { parseMeta } from "./unfurl-meta.js";
import { parseHtml, plainText, sanitizeHtml } from "./reader-safe.js";

const POS = /article|entry|post|story|body|content|news|blog|text/i;
const ARTICLE_TYPE = /^(?:NewsArticle|Article|BlogPosting|ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|ReviewNewsArticle|Report|ScholarlyArticle)$/i;

function clip(text, max) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

function classBlob(node) {
  return ((node.attrs && node.attrs.class) || "") + " " + ((node.attrs && node.attrs.id) || "");
}

function textOf(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.tag === "script" || node.tag === "style" || node.tag === "noscript") return "";
  return (node.children || []).map(textOf).join(" ");
}

function countTag(node, tag) {
  if (!node || typeof node === "string") return 0;
  let n = node.tag === tag ? 1 : 0;
  (node.children || []).forEach((child) => { n += countTag(child, tag); });
  return n;
}

function contains(parent, child) {
  if (parent === child) return true;
  if (!parent || typeof parent === "string") return false;
  return (parent.children || []).some((item) => contains(item, child));
}

function linkTextLen(node) {
  if (!node || typeof node === "string") return 0;
  if (node.tag === "a") return textOf(node).trim().length;
  return (node.children || []).reduce((sum, child) => sum + linkTextLen(child), 0);
}

function ldNodes(value, out) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => ldNodes(item, out));
    return;
  }
  const types = [].concat(value["@type"] || []);
  if (types.some((type) => ARTICLE_TYPE.test(String(type)))) out.push(value);
  if (value["@graph"]) ldNodes(value["@graph"], out);
}

function readJsonLd(html) {
  const found = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const raw = match[1].replace(/^\s*<!--/, "").replace(/-->\s*$/, "").trim();
    if (!raw || raw.length > 500000) continue;
    try { ldNodes(JSON.parse(raw), found); } catch (_) { /* a broken block is not an article */ }
  }
  return found[0] || null;
}

function personName(value) {
  if (!value) return "";
  if (typeof value === "string") return clip(value, 80);
  if (Array.isArray(value)) return personName(value[0]);
  if (typeof value === "object" && value.name) return clip(value.name, 80);
  return "";
}

function imageUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return imageUrl(value[0]);
  if (typeof value === "object") return imageUrl(value.url || value.contentUrl || value["@id"] || "");
  return "";
}

function flagFalse(value) {
  if (value === false || value === 0) return true;
  return typeof value === "string" && /^(false|0|no)$/i.test(value.trim());
}

function metaContent(html, key) {
  const tags = String(html || "").slice(0, 600000).match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    const re = /([^\s=\/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let match;
    while ((match = re.exec(tag))) attrs[match[1].toLowerCase()] = match[3] != null ? match[3] : match[4] != null ? match[4] : match[5] || "";
    const name = String(attrs.property || attrs.name || attrs["http-equiv"] || "").toLowerCase();
    if (name === key) return attrs.content || "";
  }
  return "";
}

function robotsMetaBlocks(html) {
  const content = (metaContent(html, "robots") + "," + metaContent(html, "googlebot")).toLowerCase();
  return /(^|[,;\s])(none|noarchive)([,;\s]|$)/.test(content);
}

function contentTierLocked(html) {
  const tier = metaContent(html, "article:content_tier").toLowerCase();
  return tier === "locked" || tier === "paid" || tier === "metered";
}

function hasPassword(html) {
  return /<input\b[^>]*type\s*=\s*["']?password\b/i.test(String(html || ""));
}

function langOf(html) {
  const match = /<html\b[^>]*\blang\s*=\s*["']?([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)/i.exec(String(html || ""));
  return match ? match[1].slice(0, 12) : "";
}

function titleTag(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || "").slice(0, 200000));
  return match ? match[1].replace(/<[^>]+>/g, " ") : "";
}

function paragraphsFromText(text) {
  return String(text || "")
    .split(/\n{2,}|\r\n\r\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 40)
    .slice(0, 40)
    .map((part) => "<p>" + part.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch])) + "</p>")
    .join("");
}

function bestNode(root) {
  const scored = [];
  function visit(node) {
    if (!node || typeof node === "string") return;
    const tag = node.tag;
    if (tag === "article" || tag === "main" || tag === "div" || tag === "section") {
      if (/(?:^|[\s_-])(?:comment|comments|disqus|footer|nav|menu|related|share|sidebar|newsletter|promo|cookie|paywall|topics)(?:$|[\s_-])/i.test(classBlob(node)) && countTag(node, "p") < 3) {
        (node.children || []).forEach(visit);
        return;
      }
      const raw = textOf(node).replace(/\s+/g, " ").trim();
      const paras = countTag(node, "p");
      const blob = classBlob(node);
      let score = 0;
      if (POS.test(blob)) score += 25;
      if (tag === "article") score += 18;
      if (tag === "main") score += 10;
      score += Math.min(48, paras * 6);
      score += Math.min(40, raw.length / 100);
      if (paras >= 3 && raw.length > 400) score += 12;
      const linked = linkTextLen(node);
      if (raw.length > 80 && linked / raw.length > 0.5) score -= 28;
      if (raw.length < 180) score -= 15;
      scored.push({ node, score, text: raw.length, paras });
    }
    (node.children || []).forEach(visit);
  }
  visit(root);
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score || b.paras - a.paras);
  let best = scored[0];
  const pool = scored.filter((item) => item.score >= best.score - 30 && item.paras >= Math.min(best.paras, 3) && item.text >= 350 && (item === best || contains(best.node, item.node)));
  pool.sort((a, b) => (b.paras / b.text) - (a.paras / a.text) || b.score - a.score);
  if (pool.length) best = pool[0];
  if (best.text < 280 || best.paras < 2) return null;
  return best.node;
}

function firstCaption(node) {
  if (!node || typeof node === "string") return "";
  if (node.tag === "figcaption") return clip(textOf(node), 240);
  for (const child of node.children || []) {
    const found = firstCaption(child);
    if (found) return found;
  }
  return "";
}

function h1Text(node) {
  if (!node || typeof node === "string") return "";
  if (node.tag === "h1") return clip(textOf(node), 300);
  for (const child of node.children || []) {
    const found = h1Text(child);
    if (found) return found;
  }
  return "";
}

function validDate(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 40) return "";
  const time = Date.parse(text);
  if (!Number.isFinite(time) || time < Date.parse("1990-01-01") || time > Date.parse("2100-01-01")) return "";
  return text;
}

export function extractArticle(html, pageUrl) {
  const page = String(html || "");
  const meta = parseMeta(page, pageUrl) || {};
  const ld = readJsonLd(page);
  const site = clip(meta.site || personName(ld && (ld.publisher || ld.sourceOrganization)) || "", 80);
  const title = clip(meta.title || (ld && (ld.headline || ld.name)) || "", 300);
  const description = clip(meta.description || (ld && ld.description) || "", 400);
  const byline = personName(ld && ld.author) || clip(metaContent(page, "author"), 80);
  const date = validDate((ld && (ld.datePublished || ld.dateCreated)) || metaContent(page, "article:published_time"));
  const hero = (meta.image && /^https:\/\//i.test(meta.image) ? meta.image : "") || "";
  const ldImage = imageUrl(ld && ld.image);
  const picture = hero || (ldImage && /^https:\/\//i.test(ldImage) ? ldImage : "");
  const paywall = !!(ld && flagFalse(ld.isAccessibleForFree)) || contentTierLocked(page);
  const robots = robotsMetaBlocks(page);
  const base = {
    title: title || clip(titleTag(page), 300),
    byline: byline,
    date: date,
    site: site,
    description: description,
    image: picture,
    caption: "",
    html: "",
    text: "",
    wordCount: 0,
    lang: langOf(page),
    paywall: paywall,
    robots: robots,
    login: false
  };
  if (paywall || robots) return base;
  const tree = parseHtml(page);
  const node = bestNode(tree);
  let fragment = node ? sanitizeHtml(node, pageUrl) : "";
  let text = plainText(fragment);
  if (text.length < 400 && ld && typeof ld.articleBody === "string" && !flagFalse(ld.isAccessibleForFree)) {
    const fromLd = sanitizeHtml(paragraphsFromText(ld.articleBody), pageUrl);
    if (plainText(fromLd).length > text.length) {
      fragment = fromLd;
      text = plainText(fragment);
    }
  }
  /* A password field in the site header is not a wall when the article
     itself is long enough to read. A short page with a password field is. */
  if (hasPassword(page) && text.length < 280) {
    base.login = true;
    return base;
  }
  if (text.length < 280) return base;
  const words = text.split(/\s+/).filter(Boolean);
  base.html = fragment;
  base.text = text.slice(0, 20000);
  base.wordCount = words.length;
  base.caption = node ? firstCaption(node) : "";
  if (!base.title) base.title = h1Text(node);
  if (!base.image) base.image = picture;
  return base;
}
