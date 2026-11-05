/* Public-article URL checks, robots.txt rules, and HTML allowlisting.
   Shared by the Worker reader and the in-app reading view. Nothing here
   fetches, and nothing here keeps scripts, forms, or tracking pixels.
   The entity decoder is local so the reading view does not pull the
   link-preview parser into the app shell. */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/", "#47": "/" };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/gi, (all, name) => {
    if (ENTITIES[name] != null) return ENTITIES[name];
    if (ENTITIES[name.toLowerCase()] != null) return ENTITIES[name.toLowerCase()];
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (code > 0 && code < 0x110000) { try { return String.fromCodePoint(code); } catch (_) { return ""; } }
    }
    return all;
  });
}

const BLOCK_HOST = /^(localhost|metadata|metadata\.google\.internal|metadata\.google\.com|metadata\.goog|instance-data)$/i;
const BLOCK_SUFFIX = /(\.localhost|\.local|\.internal|\.lan|\.home|\.localdomain|\.arpa)$/i;
const NON_ARTICLE_HOST = /(?:^|\.)(?:x\.com|twitter\.com|youtube\.com|youtu\.be|youtube-nocookie\.com|tiktok\.com|instagram\.com|threads\.net|threads\.com|bsky\.app|t\.me|telegram\.me|telegram\.org|discord\.gg|discord\.com|spotify\.com|music\.youtube\.com|vimeo\.com|twitch\.tv|vk\.com|vk\.ru|reddit\.com|redd\.it)$/i;
const FILE_EXT = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|ico|mp3|m4a|wav|ogg|opus|mp4|webm|mov|m3u8|mpd|pdf|zip|gz|tgz|rar|7z|apk|dmg|exe|wasm|css|mjs|js|json|xml|rss|atom)(?:$|[?#])/i;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title", "noscript", "iframe", "noframes"]);
const BLOCK_TAGS = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul", "tr", "td", "th"]);
const P_CLOSE = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);
const ALLOW = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "figure", "figcaption", "img", "a", "strong", "em", "b", "i", "br", "hr", "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "sub", "sup", "cite", "q", "abbr", "time", "dl", "dt", "dd", "caption"]);
const UNWRAP = new Set(["div", "span", "section", "article", "main", "header", "picture", "font", "center", "small", "mark", "u", "s", "del", "ins", "body", "html"]);
const DROP = new Set(["script", "style", "noscript", "iframe", "svg", "canvas", "form", "button", "input", "textarea", "select", "option", "object", "embed", "nav", "footer", "aside", "dialog", "template", "link", "meta", "base", "video", "audio", "source", "track", "math", "applet", "frame", "frameset", "portal", "noembed", "noframes", "head"]);
const DROP_CLASS = /(?:^|[\s_-])(?:comment|comments|disqus|footer|nav|menu|related|share|social|sponsor|advert|ads|banner|cookie|newsletter|promo|sidebar|widget|outbrain|taboola|paywall|signin|login|subscribe|breadcrumb|pagination|popup|modal|consent|gdpr|topics|recommend|sharebar|socials)(?:$|[\s_-])/i;
const TRACK_HOST = /(?:^|\.)(?:doubleclick\.net|googletagmanager\.com|google-analytics\.com|googlesyndication\.com|scorecardresearch\.com|hotjar\.com|adservice\.google\.com|facebook\.net|quantserve\.com|adnxs\.com)$/i;

export function readerTarget(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 2000) return null;
  let url;
  try { url = new URL(text); } catch (_) { return null; }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("%") || BLOCK_HOST.test(host) || BLOCK_SUFFIX.test(host)) return null;
  if (isIpLiteral(host)) return null;
  if (!host.includes(".")) return null;
  const labels = host.split(".");
  if (labels.some((part) => !part || part.length > 63)) return null;
  if (labels.every((part) => /^\d+$/.test(part) || /^0x[0-9a-f]+$/i.test(part))) return null;
  url.hostname = host;
  url.hash = "";
  return url;
}

/* A link that is worth a reading view: a public https page that looks like
   an article, not a homepage, a file, or a social/video permalink. */
export function suitableUrl(raw) {
  const url = readerTarget(raw);
  if (!url) return false;
  if (NON_ARTICLE_HOST.test(url.hostname)) return false;
  if (FILE_EXT.test(url.pathname) || FILE_EXT.test(url.href)) return false;
  const parts = url.pathname.split("/").filter(Boolean);
  if (!parts.length) return false;
  const last = decodeURIComponentSafe(parts[parts.length - 1]);
  if (FILE_EXT.test(last)) return false;
  if (last.length >= 16 && /[-_]/.test(last)) return true;
  if (parts.length >= 2 && last.length >= 12 && /[a-z]/i.test(last)) return true;
  if (/\.html?$/i.test(last) && last.length > 10) return true;
  if (/(?:^|\/)(?:19|20)\d{2}(?:\/|$)/.test(url.pathname) && last.length >= 8) return true;
  return false;
}

function decodeURIComponentSafe(text) {
  try { return decodeURIComponent(text); } catch (_) { return text; }
}

function isIpLiteral(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return true;
  return /^[\d.]+$/.test(bare);
}

function ipv4Parts(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || "").trim());
  if (!m) return null;
  const parts = m.slice(1).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

function privateV4(parts) {
  const a = parts[0];
  const b = parts[1];
  const c = parts[2];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function parseV6(input) {
  let ip = String(input || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const dotted = ip.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = ipv4Parts(dotted[2]);
    if (!v4) return null;
    const hi = v4[0] * 256 + v4[1];
    const lo = v4[2] * 256 + v4[3];
    ip = dotted[1] + hi.toString(16) + ":" + lo.toString(16);
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  }
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 && missing < 1 && !(missing === 0 && ip.includes("::"))) return null;
  if (halves.length === 2 && missing < 0) return null;
  const parts = halves.length === 2 ? head.concat(Array(Math.max(missing, 0)).fill("0"), tail) : head;
  if (parts.length !== 8) return null;
  const nums = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    nums.push(parseInt(part, 16));
  }
  return nums;
}

function v4FromWords(hi, lo) {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

/* True only for a globally routable address. Unparseable input is not public. */
export function isPublicAddress(raw) {
  const text = String(raw || "").trim();
  if (!text) return false;
  if (text.includes(":")) {
    const nums = parseV6(text);
    if (!nums) return false;
    const allZero = nums.every((n) => n === 0);
    if (allZero) return false;
    if (nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1) return false;
    if ((nums[0] & 0xffc0) === 0xfe80) return false;
    if ((nums[0] & 0xffc0) === 0xfec0) return false;
    if ((nums[0] & 0xfe00) === 0xfc00) return false;
    if ((nums[0] & 0xff00) === 0xff00) return false;
    if (nums[0] === 0x2001 && nums[1] === 0x0db8) return false;
    if (nums[0] === 0x0100 && nums[1] === 0 && nums[2] === 0 && nums[3] === 0) return false;
    if (nums[0] === 0x2001 && nums[1] === 0x0002) return false;
    if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff) return !privateV4(v4FromWords(nums[6], nums[7]));
    if (nums[0] === 0x0064 && nums[1] === 0xff9b && nums[2] === 0 && nums[3] === 0 && nums[4] === 0 && nums[5] === 0) {
      return !privateV4(v4FromWords(nums[6], nums[7]));
    }
    return true;
  }
  const parts = ipv4Parts(text);
  if (!parts) return false;
  return !privateV4(parts);
}

export function addressesArePublic(list) {
  const ips = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!ips.length) return false;
  return ips.every((ip) => isPublicAddress(ip));
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function robotPathMatches(pathname, rule) {
  let pat = String(rule || "");
  if (!pat) return false;
  let end = false;
  if (pat.endsWith("$")) {
    end = true;
    pat = pat.slice(0, -1);
  }
  const re = "^" + pat.split("*").map(escapeRegExp).join(".*") + (end ? "$" : "");
  try { return new RegExp(re).test(pathname); } catch (_) { return false; }
}

/* True when robots.txt allows path for this crawler token. A missing or
   empty file allows. The matching group is the longest user-agent token
   contained in ours; otherwise the * group. The longest rule wins, and a
   tie allows. */
export function robotsAllows(text, path, token) {
  const groups = [];
  let current = null;
  String(text || "").split(/\r?\n/).forEach((line) => {
    const clean = line.replace(/#.*$/, "").trim();
    if (!clean) return;
    const idx = clean.indexOf(":");
    if (idx < 0) return;
    const key = clean.slice(0, idx).trim().toLowerCase();
    const value = clean.slice(idx + 1).trim();
    if (key === "user-agent") {
      const name = value.toLowerCase();
      if (!current || current.closed) {
        current = { agents: [], rules: [], closed: false };
        groups.push(current);
      }
      if (name) current.agents.push(name);
      return;
    }
    if (!current) return;
    current.closed = true;
    if (key !== "allow" && key !== "disallow") return;
    if (!value && key === "disallow") return;
    current.rules.push({ allow: key === "allow", path: value });
  });
  const ua = String(token || "").toLowerCase();
  let best = 0;
  groups.forEach((group) => {
    group.agents.forEach((agent) => {
      if (agent !== "*" && ua.includes(agent) && agent.length > best) best = agent.length;
    });
  });
  const chosen = best
    ? groups.filter((group) => group.agents.some((agent) => agent !== "*" && agent.length === best && ua.includes(agent)))
    : groups.filter((group) => group.agents.some((agent) => agent === "*"));
  const pathname = String(path || "/").startsWith("/") ? String(path || "/") : "/" + String(path || "");
  let allowLen = -1;
  let denyLen = -1;
  chosen.forEach((group) => {
    group.rules.forEach((rule) => {
      if (!robotPathMatches(pathname, rule.path)) return;
      if (rule.allow) allowLen = Math.max(allowLen, rule.path.length);
      else denyLen = Math.max(denyLen, rule.path.length);
    });
  });
  if (denyLen < 0) return true;
  return allowLen >= denyLen;
}

function parseAttrs(raw) {
  const out = {};
  const re = /([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = re.exec(raw))) {
    const key = match[1].toLowerCase();
    if (key === "/" || key === ">") continue;
    const val = match[2] != null ? match[2] : match[3] != null ? match[3] : match[4] != null ? match[4] : "";
    if (out[key] == null) out[key] = decodeEntities(val);
  }
  return out;
}

function appendText(node, text) {
  if (!text) return;
  const kids = node.children;
  const last = kids[kids.length - 1];
  if (typeof last === "string") kids[kids.length - 1] = last + text;
  else kids.push(text);
}

/* A small HTML tree. Scripts and styles keep no text. Implied </p> keeps
   news markup that omits the closer from swallowing the rest of the page. */
export function parseHtml(html) {
  const root = { tag: "#root", attrs: {}, children: [] };
  const stack = [root];
  const src = String(html || "");
  let i = 0;
  while (i < src.length) {
    if (src.charCodeAt(i) !== 60) {
      const next = src.indexOf("<", i);
      const text = src.slice(i, next < 0 ? src.length : next);
      appendText(stack[stack.length - 1], decodeEntities(text));
      if (next < 0) break;
      i = next;
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      const end = src.indexOf(">", i + 2);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const close = src.startsWith("</", i);
    const gt = src.indexOf(">", i);
    if (gt < 0) break;
    let raw = src.slice(i + (close ? 2 : 1), gt).trim();
    const self = !close && /\/$/.test(raw);
    if (self) raw = raw.replace(/\/$/, "").trim();
    const nameMatch = /^[A-Za-z][\w:-]*/.exec(raw);
    if (!nameMatch) { i = gt + 1; continue; }
    const name = nameMatch[0].toLowerCase();
    if (close) {
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tag === name) { stack.length = k; break; }
      }
      i = gt + 1;
      continue;
    }
    if (P_CLOSE.has(name)) {
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].tag === "p") { stack.length = k; break; }
        if (BLOCK_TAGS.has(stack[k].tag) && stack[k].tag !== "p") break;
      }
    }
    const node = { tag: name, attrs: parseAttrs(raw.slice(nameMatch[0].length)), children: [] };
    stack[stack.length - 1].children.push(node);
    const leaf = self || VOID.has(name);
    if (!leaf) stack.push(node);
    i = gt + 1;
    if (!leaf && RAW.has(name)) {
      const endRe = new RegExp("<\\/" + name + "\\s*>", "i");
      const rest = src.slice(i);
      const found = endRe.exec(rest);
      const inner = found ? rest.slice(0, found.index) : rest;
      if (name === "title") appendText(node, decodeEntities(inner.replace(/<[^>]+>/g, " ")));
      i = found ? i + found.index + found[0].length : src.length;
      if (stack[stack.length - 1] === node) stack.pop();
    }
  }
  return root;
}

function esc(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function classBlob(node) {
  return ((node.attrs && (node.attrs.class || "")) + " " + ((node.attrs && node.attrs.id) || "")).toLowerCase();
}

export function httpUrl(value, base, httpsOnly) {
  if (!value) return "";
  let url;
  try { url = new URL(String(value).trim(), base); } catch (_) { return ""; }
  if (url.username || url.password) return "";
  if (httpsOnly) {
    if (url.protocol !== "https:") return "";
  } else if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  url.hash = "";
  return url.href;
}

function dropClass(node) {
  if (!node || typeof node === "string") return false;
  return DROP_CLASS.test(classBlob(node));
}

function numeric(value, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || String(n) !== String(value).trim() && String(n) !== String(Number(value))) return 0;
  if (n < 0 || n > max) return 0;
  return n;
}

function cleanDim(value) {
  const n = Number.parseInt(String(value || "").replace(/px$/i, ""), 10);
  if (!Number.isFinite(n) || n < 0 || n > 8000) return 0;
  return n;
}

function trackerImage(src, width, height) {
  if (width && height && width <= 2 && height <= 2) return true;
  let url;
  try { url = new URL(src); } catch (_) { return true; }
  if (TRACK_HOST.test(url.hostname)) return true;
  if (/\/(?:pixel|beacon|spacer|track|1x1)(?:\.|$|\/)/i.test(url.pathname)) return true;
  if (url.pathname === "/tr" || url.pathname.endsWith("/tr")) return true;
  return false;
}

function cellSpan(value) {
  const n = numeric(String(value || "").trim(), 12);
  return n > 1 ? String(n) : "";
}

/* Allowlisted fragment. Links stay external. Images stay hotlinked https
   URLs with no srcset and no tracker pixels. Event handlers and styles from
   the page are dropped. */
export function sanitizeHtml(html, baseUrl) {
  const tree = typeof html === "string" ? parseHtml(html) : html;
  let images = 0;
  const max = 160000;
  let size = 0;
  function walk(node, depth) {
    if (size > max || depth > 24) return "";
    if (typeof node === "string") {
      const text = node.replace(/\u0000/g, "");
      if (!text.trim() && !/\s/.test(text)) return "";
      const out = esc(text);
      size += out.length;
      return out;
    }
    if (!node || DROP.has(node.tag) || dropClass(node)) return "";
    if (node.tag === "br") { size += 4; return "<br>"; }
    if (node.tag === "hr") { size += 4; return "<hr>"; }
    if (node.tag === "img") {
      if (images >= 12) return "";
      const src = httpUrl(node.attrs.src, baseUrl, true);
      if (!src) return "";
      const width = cleanDim(node.attrs.width);
      const height = cleanDim(node.attrs.height);
      if (trackerImage(src, width, height)) return "";
      images += 1;
      let tag = '<img src="' + esc(src) + '" alt="' + esc(String(node.attrs.alt || "").slice(0, 300)) + '" loading="lazy" decoding="async" referrerpolicy="no-referrer"';
      if (width > 2) tag += ' width="' + width + '"';
      if (height > 2) tag += ' height="' + height + '"';
      size += tag.length;
      return tag + ">";
    }
    const inner = (node.children || []).map((child) => walk(child, depth + 1)).join("");
    if (node.tag === "#root" || UNWRAP.has(node.tag)) return inner;
    if (!ALLOW.has(node.tag)) return inner ? inner : "";
    if (!inner.trim() && node.tag !== "td" && node.tag !== "th") return "";
    if (node.tag === "a") {
      const href = httpUrl(node.attrs.href, baseUrl, false);
      if (!href) return inner;
      const tag = '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow" class="rd-ext">' + inner + "</a>";
      size += tag.length;
      return tag;
    }
    let extra = "";
    if (node.tag === "time") {
      const stamp = String(node.attrs.datetime || "").trim();
      if (stamp && /^[0-9T:Z+\-.]+$/.test(stamp) && stamp.length < 40) extra = ' datetime="' + esc(stamp) + '"';
    }
    if (node.tag === "th") {
      const scope = String(node.attrs.scope || "").toLowerCase();
      if (scope === "col" || scope === "row") extra += ' scope="' + scope + '"';
    }
    if (node.tag === "td" || node.tag === "th") {
      const col = cellSpan(node.attrs.colspan);
      const row = cellSpan(node.attrs.rowspan);
      if (col) extra += ' colspan="' + col + '"';
      if (row) extra += ' rowspan="' + row + '"';
    }
    const tag = "<" + node.tag + extra + ">" + inner + "</" + node.tag + ">";
    size += tag.length;
    return tag;
  }
  return walk(tree, 0).replace(/(?:<br>\s*){3,}/g, "<br><br>").replace(/(?:<p>\s*<\/p>)+/g, "").trim();
}

export function plainText(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
