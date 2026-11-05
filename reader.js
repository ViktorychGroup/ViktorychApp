/* In-app reading view for a public article link. The page stays in the app;
   the original site opens only from Open original. The server switch
   article_reader turns the whole view off. */
import { httpUrl, readerTarget, sanitizeHtml, suitableUrl } from "./shared/reader-safe.js";

var PREF_KEY = "viktorychapp-reader-pref";
var OFF_KEY = "viktorychapp-server-off";
var SIZES = [16, 18, 20, 23, 26];
var root = null;
var scrollEl = null;
var progressBar = null;
var pushed = false;
var currentUrl = "";
var restoreRatio = -1;
var userMoved = false;
var saveTimer = 0;
var lastFocus = null;
var listening = false;
var mem = new Map();

function tr(key, vars) {
  return window.t ? window.t(key, vars) : key;
}

function offered() {
  try {
    var list = JSON.parse(localStorage.getItem(OFF_KEY) || "[]");
    return !(Array.isArray(list) && list.indexOf("article_reader") >= 0);
  } catch (err) {
    return true;
  }
}

function prefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") || {}; }
  catch (err) { return {}; }
}

function savePrefs(next) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(next)); } catch (err) { /* private mode keeps the session */ }
}

function themeDefault() {
  var theme = "";
  try { theme = document.documentElement.getAttribute("data-theme") || ""; } catch (err) { theme = ""; }
  return theme === "light" ? "light" : "dark";
}

function apiBase() {
  if (window.ViktorychAccounts && window.ViktorychAccounts.currentApi) {
    var cur = window.ViktorychAccounts.currentApi();
    if (cur) return String(cur).replace(/\/$/, "");
  }
  var bag = window.VIKTORYCH_ACCOUNTS || {};
  return String(bag.api || bag.backupApi || "").replace(/\/$/, "");
}

function reasonText(reason) {
  if (reason === "robots") return tr("This site asks not to copy this page. Open it on the original site.");
  if (reason === "paywall") return tr("This page is for subscribers. The reading view stops at the public preview.");
  if (reason === "login") return tr("This page asks you to sign in. Open it on the original site.");
  if (reason === "blocked") return tr("The site did not allow a reading view.");
  if (reason === "type") return tr("This link isn't a web page that can be read here.");
  if (reason === "timeout") return tr("The reading view took too long. Open the original page.");
  if (reason === "size") return tr("This page is too large to read here. Open the original page.");
  if (reason === "off") return tr("Reading view is turned off.");
  return tr("A reading view isn't available for this page.");
}

function formatDate(iso) {
  var time = Date.parse(iso || "");
  if (!time) return "";
  try {
    return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: "medium" }).format(new Date(time));
  } catch (err) {
    return "";
  }
}

function safePage(raw) {
  var url = readerTarget(raw);
  return url ? url.href : "";
}

function wipe(node) {
  if (!node) return;
  if (node.replaceChildren) node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function icon(path) {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.8");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  return svg;
}

function ensure() {
  if (root) return;
  root = el("div", "rd-root");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "rd-title");
  var sheet = el("div", "rd-sheet");
  var progress = el("div", "rd-progress");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuenow", "0");
  progress.setAttribute("aria-label", tr("Reading progress"));
  progressBar = el("span");
  progress.appendChild(progressBar);
  var bar = el("header", "rd-bar");
  var close = el("button", "rd-icon");
  close.type = "button";
  close.setAttribute("data-rd", "close");
  close.setAttribute("aria-label", tr("Close reading view"));
  close.appendChild(icon("M15 6 L9 12 L15 18"));
  var brand = el("div", "rd-brand");
  brand.appendChild(el("span", "rd-kicker", tr("Reader")));
  brand.appendChild(el("span", "rd-host"));
  var open = el("a", "rd-open");
  open.target = "_blank";
  open.rel = "noopener noreferrer";
  open.textContent = tr("Open original");
  bar.append(close, brand, open);
  var tools = el("div", "rd-tools");
  var size = el("div", "rd-size");
  size.setAttribute("role", "group");
  size.setAttribute("aria-label", tr("Text size"));
  var smaller = el("button", "rd-icon");
  smaller.type = "button";
  smaller.setAttribute("data-rd", "smaller");
  smaller.setAttribute("aria-label", tr("Smaller text"));
  smaller.textContent = "A−";
  var larger = el("button", "rd-icon");
  larger.type = "button";
  larger.setAttribute("data-rd", "larger");
  larger.setAttribute("aria-label", tr("Larger text"));
  larger.textContent = "A+";
  size.append(smaller, larger);
  var themes = el("div", "rd-themes");
  themes.setAttribute("role", "group");
  themes.setAttribute("aria-label", tr("Reading theme"));
  [["light", tr("Light")], ["sepia", tr("Sepia")], ["dark", tr("Dark")]].forEach(function (pair) {
    var btn = el("button", "rd-theme", pair[1]);
    btn.type = "button";
    btn.setAttribute("data-rd-theme", pair[0]);
    themes.appendChild(btn);
  });
  tools.append(size, themes);
  scrollEl = el("div", "rd-scroll");
  scrollEl.tabIndex = -1;
  var copy = el("div", "rd-copy");
  copy.appendChild(el("p", "rd-note", tr("Reading view of a public page. ViktorychApp is not the publisher.")));
  var title = el("h1", "rd-title");
  title.id = "rd-title";
  var byline = el("p", "rd-byline");
  var source = el("p", "rd-source");
  var hero = el("figure", "rd-hero");
  hero.hidden = true;
  var status = el("p", "rd-status");
  status.setAttribute("role", "status");
  var body = el("div", "rd-body");
  var foot = el("footer", "rd-foot");
  var open2 = el("a", "rd-open rd-open-lg");
  open2.target = "_blank";
  open2.rel = "noopener noreferrer";
  open2.textContent = tr("Open original");
  foot.append(open2, el("p", "rd-end", tr("You're reading a public page for comfort. The publisher's site is the original.")));
  copy.append(title, byline, source, hero, status, body, foot);
  scrollEl.appendChild(copy);
  sheet.append(progress, bar, tools, scrollEl);
  root.appendChild(sheet);
  root.addEventListener("click", onClick);
  scrollEl.addEventListener("scroll", onScroll, { passive: true });
  document.body.appendChild(root);
  applyChrome();
}

function hostEl() { return root.querySelector(".rd-host"); }
function titleEl() { return root.querySelector(".rd-title"); }
function bylineEl() { return root.querySelector(".rd-byline"); }
function sourceEl() { return root.querySelector(".rd-source"); }
function heroEl() { return root.querySelector(".rd-hero"); }
function statusEl() { return root.querySelector(".rd-status"); }
function bodyEl() { return root.querySelector(".rd-body"); }

function applyChrome() {
  var pref = prefs();
  var theme = pref.theme === "light" || pref.theme === "sepia" || pref.theme === "dark" ? pref.theme : themeDefault();
  var size = Number.isInteger(pref.size) ? pref.size : 1;
  if (size < 0) size = 0;
  if (size > SIZES.length - 1) size = SIZES.length - 1;
  var sheet = root.querySelector(".rd-sheet");
  sheet.setAttribute("data-theme", theme);
  sheet.style.setProperty("--rd-size", SIZES[size] + "px");
  root.querySelectorAll("[data-rd-theme]").forEach(function (btn) {
    var on = btn.getAttribute("data-rd-theme") === theme;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  var smaller = root.querySelector("[data-rd=smaller]");
  var larger = root.querySelector("[data-rd=larger]");
  if (smaller) smaller.disabled = size <= 0;
  if (larger) larger.disabled = size >= SIZES.length - 1;
}

function setOpenHref(url) {
  root.querySelectorAll("a.rd-open").forEach(function (link) {
    if (url) link.href = url;
    else link.removeAttribute("href");
  });
}

function showHero(src, caption) {
  var hero = heroEl();
  wipe(hero);
  var safe = httpUrl(src, "https://reader.invalid/", true);
  if (!safe) { hero.hidden = true; return; }
  var img = document.createElement("img");
  img.src = safe;
  img.alt = caption || "";
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  hero.appendChild(img);
  if (caption) hero.appendChild(el("figcaption", "", caption));
  hero.hidden = false;
}

function fill(doc, hint) {
  if (root) root.querySelectorAll(".rd-retry").forEach(function (node) { node.remove(); });
  var data = doc || {};
  var hintTitle = hint && hint.title ? String(hint.title) : "";
  var title = data.title || hintTitle;
  var domain = data.domain || "";
  try { if (!domain && currentUrl) domain = new URL(currentUrl).hostname.replace(/^www\./, ""); } catch (err) { domain = ""; }
  hostEl().textContent = domain;
  titleEl().textContent = title || domain || tr("Reader");
  var bits = [];
  if (data.mode === "article" && data.byline) bits.push(tr("By {name}", { name: data.byline }));
  var when = data.mode === "article" ? formatDate(data.date) : "";
  if (when) bits.push(when);
  bylineEl().textContent = bits.join(" · ");
  bylineEl().hidden = !bits.length;
  var site = data.site && data.site !== domain ? data.site : "";
  wipe(sourceEl());
  if (domain) {
    var label = el("span", "rd-source-k", tr("Source"));
    sourceEl().appendChild(label);
    sourceEl().appendChild(document.createTextNode(" " + (site ? site + " · " + domain : domain)));
    sourceEl().hidden = false;
  } else sourceEl().hidden = true;
  var original = safePage(data.url || currentUrl) || safePage(currentUrl);
  setOpenHref(original);
  var articleHtml = data.mode === "article" ? sanitizeHtml(data.html || "", original || currentUrl) : "";
  var sameImage = data.image && articleHtml.indexOf(data.image) >= 0;
  var caption = data.mode === "article" && articleHtml.indexOf("<figcaption") < 0 ? data.caption || "" : "";
  if (!sameImage) showHero(data.image || (hint && hint.image) || "", caption);
  else { heroEl().hidden = true; wipe(heroEl()); }
  wipe(bodyEl());
  wipe(statusEl());
  if (articleHtml) {
    bodyEl().innerHTML = articleHtml;
    statusEl().hidden = true;
    scrollEl.removeAttribute("aria-busy");
  } else if (data.reason || data.mode === "preview") {
    statusEl().hidden = false;
    statusEl().textContent = reasonText(data.reason || "extract");
    if (data.description || (hint && hint.description)) {
      bodyEl().appendChild(el("p", "rd-lead", data.description || hint.description));
    }
    scrollEl.removeAttribute("aria-busy");
  } else {
    statusEl().hidden = false;
    statusEl().textContent = tr("Opening the reading view…");
    scrollEl.setAttribute("aria-busy", "true");
    if (hint && hint.description) bodyEl().appendChild(el("p", "rd-lead", hint.description));
    if (hint && hint.image) showHero(hint.image, "");
  }
}

function progress(ratio) {
  var value = Math.max(0, Math.min(1, ratio || 0));
  if (progressBar) progressBar.style.transform = "scaleX(" + value + ")";
  var bar = root.querySelector(".rd-progress");
  if (bar) bar.setAttribute("aria-valuenow", String(Math.round(value * 100)));
}

function rememberPos(ratio) {
  var pref = prefs();
  var pos = pref.pos && typeof pref.pos === "object" ? pref.pos : {};
  pos[currentUrl] = { r: Math.round(ratio * 1000) / 1000, at: Date.now() };
  var keys = Object.keys(pos).sort(function (a, b) { return (pos[b].at || 0) - (pos[a].at || 0); });
  keys.slice(30).forEach(function (key) { delete pos[key]; });
  pref.pos = pos;
  savePrefs(pref);
}

function onScroll() {
  if (!scrollEl) return;
  var max = scrollEl.scrollHeight - scrollEl.clientHeight;
  var ratio = max > 8 ? scrollEl.scrollTop / max : 0;
  progress(ratio);
  if (restoreRatio >= 0 && Math.abs(ratio - restoreRatio) > 0.04) userMoved = true;
  if (!userMoved && restoreRatio >= 0) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () { if (currentUrl) rememberPos(ratio); }, 200);
}

function restorePos() {
  var pref = prefs();
  var row = pref.pos && pref.pos[currentUrl];
  var ratio = row && typeof row.r === "number" ? row.r : 0;
  restoreRatio = ratio;
  userMoved = false;
  if (!scrollEl || ratio <= 0) { progress(0); return; }
  var max = scrollEl.scrollHeight - scrollEl.clientHeight;
  scrollEl.scrollTop = Math.max(0, max * ratio);
  progress(max > 8 ? scrollEl.scrollTop / max : 0);
}

function onKey(event) {
  if (!root) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close(false);
    return;
  }
  if (event.key !== "Tab") return;
  var items = root.querySelectorAll("button:not([disabled]), a[href]");
  if (!items.length) return;
  var first = items[0];
  var last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function onPop() {
  if (!root || !root.isConnected) return;
  if (!pushed) return;
  pushed = false;
  destroy();
}

function destroy() {
  if (listening) {
    listening = false;
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPop);
  }
  document.documentElement.classList.remove("rd-open");
  if (root) root.remove();
  root = null;
  scrollEl = null;
  progressBar = null;
  if (lastFocus && lastFocus.focus) {
    try { lastFocus.focus(); } catch (err) { /* the post may have been redrawn */ }
  }
  lastFocus = null;
}

function close(fromHistory) {
  if (pushed && !fromHistory) {
    pushed = false;
    try { history.back(); } catch (err) { /* the dialog still closes */ }
  } else pushed = false;
  destroy();
}

function onClick(event) {
  var link = event.target.closest("a");
  if (link && root.contains(link)) {
    event.stopPropagation();
    return;
  }
  var theme = event.target.closest("[data-rd-theme]");
  var btn = theme || event.target.closest("[data-rd]");
  if (!btn || !root.contains(btn)) return;
  event.preventDefault();
  event.stopPropagation();
  if (theme) {
    var pref = prefs();
    pref.theme = theme.getAttribute("data-rd-theme");
    savePrefs(pref);
    applyChrome();
    return;
  }
  var act = btn.getAttribute("data-rd");
  if (act === "close") close(false);
  else if (act === "retry") load(currentUrl, null, true);
  else if (act === "smaller" || act === "larger") {
    var next = prefs();
    var size = Number.isInteger(next.size) ? next.size : 1;
    size += act === "larger" ? 1 : -1;
    next.size = Math.max(0, Math.min(SIZES.length - 1, size));
    savePrefs(next);
    applyChrome();
  }
}

function paintCached(url, hint) {
  var hit = mem.get(url);
  if (!hit) return false;
  fill(hit.doc, hint);
  requestAnimationFrame(restorePos);
  return true;
}

function load(url, hint, force) {
  if (!offered()) {
    fill({ mode: "preview", reason: "off", title: hint && hint.title, description: hint && hint.description, image: hint && hint.image, url: url }, hint);
    return;
  }
  if (!force && paintCached(url, hint)) {
    if (Date.now() - mem.get(url).at < 60 * 1000) return;
  } else if (!mem.has(url)) fill({ title: hint && hint.title, description: hint && hint.description, image: hint && hint.image, domain: "" }, hint);
  var base = apiBase();
  if (!base) {
    fill({ mode: "preview", reason: "blocked", title: hint && hint.title, url: url }, hint);
    var retry = el("button", "rd-retry", tr("Retry"));
    retry.type = "button";
    retry.setAttribute("data-rd", "retry");
    statusEl().after(retry);
    return;
  }
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 12000);
  fetch(base + "/v1/reader?url=" + encodeURIComponent(url), { signal: ctrl.signal, headers: { accept: "application/json" } }).then(function (res) {
    clearTimeout(timer);
    if (res.status === 204) {
      fill({ mode: "preview", reason: "off", url: url, title: hint && hint.title }, hint);
      return null;
    }
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }).then(function (doc) {
    if (!doc || currentUrl !== url) return;
    mem.set(url, { at: Date.now(), doc: doc });
    if (mem.size > 8) mem.delete(mem.keys().next().value);
    fill(doc, hint);
    requestAnimationFrame(function () { requestAnimationFrame(restorePos); });
  }).catch(function () {
    clearTimeout(timer);
    if (currentUrl !== url || mem.has(url)) return;
    fill({ mode: "preview", reason: "timeout", url: url, title: hint && hint.title, description: hint && hint.description }, hint);
    var retry = el("button", "rd-retry", tr("Retry"));
    retry.type = "button";
    retry.setAttribute("data-rd", "retry");
    statusEl().after(retry);
  });
}

function open(raw, hint) {
  var url = safePage(raw);
  if (!url || !suitableUrl(url)) return;
  ensure();
  currentUrl = url;
  lastFocus = document.activeElement;
  document.documentElement.classList.add("rd-open");
  applyChrome();
  fill({ title: hint && hint.title, description: hint && hint.description, image: hint && hint.image }, hint);
  if (!pushed) {
    try { history.pushState({ rd: 1 }, ""); pushed = true; } catch (err) { pushed = false; }
  }
  if (!listening) {
    listening = true;
    document.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
  }
  var closeBtn = root.querySelector("[data-rd=close]");
  if (closeBtn) closeBtn.focus();
  load(url, hint || null, false);
}

window.ViktorychReader = {
  suitable: suitableUrl,
  offered: offered,
  open: open
};
try { window.dispatchEvent(new Event("viktorych-reader-ready")); } catch (err) { /* the feed renders on its own */ }
