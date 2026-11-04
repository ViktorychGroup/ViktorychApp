/* Settings alerts: the shared pop-out variants, once-per-crossing debounce,
   dismiss and deep link, the auto-open countdown, cancel, the composer rule,
   and going back to where the person was. Runs headless in a fake page. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
// The app's icon set (PATH in app.js), shared with modules as window.ViktorychIcons.
const APP_PATH = (() => {
  const src = read("app.js");
  const start = src.indexOf("const PATH = {");
  const end = src.indexOf("\n  };", start);
  return vm.runInNewContext("(" + src.slice(start + "const PATH = ".length, end + 4) + ")");
})();
const APP_ICONS = { has: (n) => !!APP_PATH[n], svg: (n) => (APP_PATH[n] ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + APP_PATH[n] + '"/></svg>' : "") };
const EMOJI = /[\u2190-\u2BFF\u2600-\u27BF\uFE0F]|[\uD83C-\uD83E][\uDC00-\uDFFF]/;

/* A tiny DOM: enough for the pop-out, the banner and the highlighted row. */
function attrsOf(html) {
  const open = /^<(\w+)([^>]*)>/.exec(html.trim());
  const attrs = {};
  if (!open) return { tag: "div", attrs };
  open[2].replace(/([\w-]+)(?:="([^"]*)")?/g, (m, k, v) => { attrs[k] = v == null ? "" : v; return m; });
  return { tag: open[1], attrs };
}

function makeDom() {
  const all = new Set();
  function el(tag) {
    const node = {
      tagName: String(tag).toUpperCase(), children: [], attrs: {}, parentNode: null, className: "", _html: "", value: undefined, textContent: "",
      classList: {
        add(c) { if (!node.className.split(" ").includes(c)) node.className = (node.className + " " + c).trim(); },
        remove(c) { node.className = node.className.split(" ").filter((x) => x && x !== c).join(" "); },
        contains(c) { return node.className.split(" ").includes(c); }
      },
      get innerHTML() { return node._html; },
      set innerHTML(v) { node._html = String(v); node.children = []; },
      get firstChild() {
        if (node.children.length) return node.children[0];
        if (!node._html) return null;
        const parsed = attrsOf(node._html);
        const child = el(parsed.tag);
        Object.keys(parsed.attrs).forEach((k) => { if (k === "class") child.className = parsed.attrs[k]; else child.attrs[k] = parsed.attrs[k]; });
        child._html = node._html;
        node.children.push(child);
        child.parentNode = node;
        return child;
      },
      setAttribute(k, v) { if (k === "class") node.className = String(v); else node.attrs[k] = String(v); },
      getAttribute(k) { return k === "class" ? node.className : node.attrs[k] == null ? null : node.attrs[k]; },
      appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = node; node.children.push(child); all.add(child); return child; },
      insertBefore(child, ref) {
        if (child.parentNode) child.parentNode.removeChild(child);
        const i = node.children.indexOf(ref);
        child.parentNode = node;
        if (i < 0) node.children.push(child); else node.children.splice(i, 0, child);
        all.add(child);
        return child;
      },
      removeChild(child) { node.children = node.children.filter((c) => c !== child); child.parentNode = null; },
      replaceChild(next, old) { const i = node.children.indexOf(old); next.parentNode = node; node.children[i] = next; old.parentNode = null; all.add(next); },
      contains(other) { let x = other; while (x) { if (x === node) return true; x = x.parentNode; } return false; },
      querySelector(sel) { return query(sel, node)[0] || null; },
      scrollIntoView() { node.scrolled = true; }
    };
    return node;
  }
  function matches(node, simple) {
    simple = simple.trim();
    if (!simple) return false;
    if (simple[0] === ".") return node.classList.contains(simple.slice(1));
    if (simple[0] === "#") return node.attrs.id === simple.slice(1);
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(simple);
    if (attr) {
      const v = node.getAttribute(attr[1]);
      if (v == null && !(node._html && attrsOf(node._html).attrs[attr[1]] != null && node.parentNode && !node.children.length)) return false;
      return attr[2] == null || v === attr[2];
    }
    return node.tagName === simple.toUpperCase();
  }
  function inTree(node, scope) { let x = node; while (x) { if (x === scope) return true; x = x.parentNode; } return false; }
  function query(sel, scope) {
    const parts = sel.split(",");
    return Array.from(all).filter((n) => n !== scope && inTree(n, scope) && parts.some((p) => matches(n, p)));
  }
  const body = el("body");
  const html = el("html");
  body.parentNode = html;
  return { el, body, html, query, all };
}

function setup(opts) {
  opts = opts || {};
  const dom = makeDom();
  const store = {};
  const session = {};
  let clock = opts.at || new Date(2026, 9, 29, 12, 0, 0).getTime();
  let timers = [];
  let seq = 0;
  const listeners = {};
  const winListeners = {};
  const shows = [];
  const document = {
    readyState: "complete", body: dom.body, documentElement: dom.html, visibilityState: "visible", activeElement: dom.body,
    createElement(tag) { return dom.el(tag); },
    querySelector(sel) { return dom.query(sel, dom.html)[0] || null; },
    querySelectorAll(sel) { return dom.query(sel, dom.html); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  };
  const origAppend = dom.body.appendChild;
  dom.body.appendChild = function (child) {
    if (child.className.split(" ").includes("ach")) shows.push({ cls: child.className, html: child.innerHTML, id: (/data-pop-id="([^"]*)"/.exec(child.innerHTML) || [])[1] || "" });
    return origAppend(child);
  };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(clock); }
    static now() { return clock; }
  }
  const storage = (bag) => ({
    getItem: (k) => (k in bag ? bag[k] : null),
    setItem: (k, v) => { bag[k] = String(v); },
    removeItem: (k) => { delete bag[k]; },
    key: (i) => Object.keys(bag)[i],
    get length() { return Object.keys(bag).length; }
  });
  const sandbox = {
    console, JSON, Math, Object, String, Number, Array, Promise, isNaN, RegExp,
    Date: FakeDate,
    document,
    location: { hash: opts.hash || "#/home" },
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, fn, at: clock + (ms || 0) }); return id; },
    clearTimeout(id) { timers = timers.filter((t) => t.id !== id); },
    setInterval(fn, ms) { const id = ++seq; const tick = () => { fn(); timers.push({ id, fn: tick, at: clock + ms }); }; timers.push({ id, fn: tick, at: clock + ms }); return id; },
    clearInterval(id) { timers = timers.filter((t) => t.id !== id); },
    localStorage: storage(store),
    sessionStorage: storage(session),
    matchMedia: () => ({ matches: false }),
    navigator: { userActivation: { hasBeenActive: true }, vibrate() { return true; } },
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    t: (key, vars) => key.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? vars[k] : m)),
    ViktorychAccounts: { account: () => null, token: () => "", call: () => Promise.resolve({}) },
    ViktorychIcons: APP_ICONS,
    __SA_NO_AUTOSTART: true
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("badges.js"), sandbox, { filename: "badges.js" });
  vm.runInContext(read("setting-alerts.js"), sandbox, { filename: "setting-alerts.js" });
  const sa = sandbox.ViktorychSettingAlerts;
  sa.start({ timers: false });
  if (opts.prefs) sa.setPrefs(opts.prefs);
  /* Move the fake clock forward, running every timer that comes due. */
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      clock = Math.max(clock, next.at);
      next.fn();
    }
    clock = end;
  }
  function setHash(h) {
    sandbox.location.hash = h;
    (winListeners.hashchange || []).forEach((fn) => fn({}));
  }
  /* A settings page the router would render: a row the alert can highlight. */
  function renderPage(cls) {
    const page = dom.el("div");
    page.className = cls;
    dom.body.appendChild(page);
    return page;
  }
  return { sa, ach: sandbox.ViktorychAchievements, sandbox, dom, document, store, session, shows, advance, setHash, renderPage, now: () => clock };
}

const GB = 1024 * 1024 * 1024;
const disk = (pct) => ({ "storage-quota": { used: pct / 100 * 10 * GB, limit: 10 * GB, pct } });
const popsOf = (t, id) => t.shows.filter((s) => s.id === id);

// 79, 81, 96, 100%: the right variant appears once per crossing.
{
  const t = setup({ prefs: { autoOpen: false } });
  t.sa.evaluate(disk(79));
  t.advance(20000);
  assert.equal(t.shows.length, 0, "79% stays quiet");
  t.sa.evaluate(disk(81));
  assert.equal(t.ach.popCurrent().variant, "warning", "81% is a warning");
  const warn = t.shows[0];
  assert(warn.cls.includes("ach-alert") && warn.cls.includes("v-warning"), "warning look");
  assert(warn.html.includes("Device storage is 81% full") && warn.html.includes("8.1 GB of 10 GB used"), "warning says what and the numbers");
  assert(warn.html.includes('data-pop-act="action"') && warn.html.includes("Free up space"), "quick fix button");
  assert(warn.html.includes('data-pop-act="dismiss"') && warn.html.includes("Don&#39;t warn me about this"), "dismiss and mute buttons");
  t.advance(20000);
  t.sa.evaluate(disk(82));
  t.sa.evaluate(disk(81));
  t.advance(20000);
  assert.equal(popsOf(t, "sa-storage-quota").length, 1, "81% again does not repeat");
  t.sa.evaluate(disk(96));
  assert.equal(t.ach.popCurrent().variant, "critical", "96% is critical");
  assert(t.shows[1].cls.includes("v-critical") && t.shows[1].html.includes("almost full"), "critical look and wording");
  t.advance(20000);
  t.sa.evaluate(disk(100));
  assert.equal(t.ach.popCurrent().variant, "limit", "100% is limit reached");
  assert(t.shows[2].html.includes("Limit reached") && t.shows[2].html.includes("Device storage is full"), "limit wording");
  t.advance(20000);
  t.sa.evaluate(disk(100));
  t.advance(20000);
  assert.equal(popsOf(t, "sa-storage-quota").length, 3, "one pop-out per crossing: warning, critical, limit");
  assert.equal(t.dom.body.children.length, 0, "pop-outs remove themselves");
  const log = t.sa.state().log.filter((e) => e.id === "storage-quota");
  assert.deepEqual(log.map((e) => e.level), ["warning", "critical", "limit"], "every alert is logged");
  const notes = t.sa.notesHtml();
  assert(notes.includes("sa-note v-limit") && notes.includes("System") && notes.includes('href="#/settings/storage/usage"'), "Notifications shows System items with a link");

  // Re-arm only after usage clearly drops.
  t.sa.evaluate(disk(79));
  t.sa.evaluate(disk(81));
  t.advance(20000);
  assert.equal(popsOf(t, "sa-storage-quota").length, 3, "hovering around the line does not re-arm");
  t.sa.evaluate(disk(60));
  t.sa.evaluate(disk(81));
  assert.equal(popsOf(t, "sa-storage-quota").length, 4, "dropping well below re-arms the warning");
  t.advance(20000);
}

// Dismiss closes it, Don't warn me mutes it, and the action deep-links.
{
  const t = setup({ prefs: { autoOpen: false } });
  t.sa.evaluate(disk(81));
  t.advance(400);
  assert(t.ach.popAction("dismiss"), "dismiss works on an alert");
  t.advance(1000);
  assert.equal(t.ach.popCurrent(), null, "dismissed");
  assert.equal(t.dom.body.children.length, 0, "the card is gone");
  assert.equal(t.sandbox.location.hash, "#/home", "dismiss does not navigate");

  t.sa.evaluate(disk(96));
  t.advance(400);
  t.ach.popAction("action");
  assert.equal(t.sandbox.location.hash, "#/settings/storage/usage", "the action opens Storage usage");
  const row = t.renderPage("set-block");
  t.advance(500);
  assert(row.classList.contains("sa-pulse") && row.scrolled, "the setting pulses and scrolls into view");
  assert(t.document.querySelector("[data-sa-banner]"), "a banner says why the page opened");
  assert(t.sa.goBack(), "back works");
  assert.equal(t.sandbox.location.hash, "#/home", "back to where they were");
  assert.equal(t.document.querySelector("[data-sa-banner]"), null, "banner removed");
  t.advance(20000);

  t.sa.evaluate({ "cache-limit": { used: 4.1 * GB, limit: 5 * GB, pct: 82 } });
  t.advance(400);
  t.ach.popAction("mute");
  assert.equal(t.sa.prefs().off["cache-limit"], true, "Don't warn me about this turns that alert off");
  t.advance(2000);
  t.sa.evaluate({ "cache-limit": { used: 4.9 * GB, limit: 5 * GB, pct: 98 } });
  t.advance(20000);
  assert.equal(popsOf(t, "sa-cache-limit").length, 1, "a muted alert stays quiet");
}

// Critical while idle: 3 second countdown, then the settings page opens.
{
  const t = setup({ hash: "#/explore" });
  t.sa.evaluate(disk(96));
  assert.equal(t.ach.popCurrent().id, "sa-countdown", "a countdown shows instead of navigating at once");
  assert(t.shows[0].cls.includes("v-countdown") && t.shows[0].html.includes("Opening Storage settings in 3") && t.shows[0].html.includes('data-pop-act="cancel"'), "countdown copy and Cancel");
  assert.equal(popsOf(t, "sa-storage-quota").length, 0, "no separate critical card when the page opens itself");
  t.advance(2000);
  assert.equal(t.sandbox.location.hash, "#/explore", "nothing happens before the countdown ends");
  t.advance(2500);
  assert.equal(t.sandbox.location.hash, "#/settings/storage/usage", "redirected after the countdown");
  const row = t.renderPage("stor-usage");
  t.advance(500);
  assert(row.classList.contains("sa-pulse"), "highlighted");
  const banner = t.document.querySelector("[data-sa-banner]");
  assert(banner && banner.innerHTML.includes("Opened automatically") && banner.innerHTML.includes('data-sa="back"'), "banner explains and offers Back");
  assert.deepEqual(JSON.parse(JSON.stringify(t.sa.redirectState().active)), { id: "storage-quota", from: "#/explore", to: "#/settings/storage/usage" });
  // Fixing it sends them back.
  t.sa.evaluate(disk(70));
  assert(t.shows.some((s) => s.id === "sa-fixed"), "says it is fixed");
  t.advance(1500);
  assert.equal(t.sandbox.location.hash, "#/explore", "returned to the previous route after the fix");
  t.advance(20000);
  // At most once per issue per session.
  t.sa.evaluate(disk(96));
  assert.notEqual(t.ach.popCurrent() && t.ach.popCurrent().id, "sa-countdown", "no second redirect for the same issue this session");
  assert.equal(t.ach.popCurrent().variant, "critical", "a plain critical card instead");
  t.advance(20000);
  assert.equal(t.sandbox.location.hash, "#/explore");
}

// Cancel stops the redirect for this session.
{
  const t = setup({ hash: "#/home" });
  t.sa.evaluate({ "data-cap": { used: 4.8 * GB, limit: 5 * GB, pct: 96, vars: { when: "this month", reset: "Nov 1" } } });
  assert.equal(t.ach.popCurrent().id, "sa-countdown");
  t.advance(1200);
  t.ach.popAction("cancel");
  t.advance(10000);
  assert.equal(t.sandbox.location.hash, "#/home", "cancel keeps them where they are");
  assert.equal(t.sa.redirectState().counting, false);
  t.sa.evaluate({ "data-cap": { used: 5 * GB, limit: 5 * GB, pct: 100, vars: { when: "this month", reset: "Nov 1" } } });
  assert.equal(t.ach.popCurrent().variant, "limit", "the cap hit still pops, as a card");
  t.advance(20000);
  assert.equal(t.sandbox.location.hash, "#/home", "no redirect after a cancel in the same session");
}

// Typing, composing, a draft, a call, media and TV block the redirect until idle.
{
  const t = setup({ hash: "#/home" });
  const box = t.dom.el("textarea");
  box.value = "half a post";
  t.dom.body.appendChild(box);
  t.sa.evaluate(disk(100));
  assert.equal(t.sa.busyReason(), "draft");
  assert.equal(t.ach.popCurrent().variant, "limit", "busy: the limit card shows instead");
  t.advance(30000);
  assert.equal(t.sandbox.location.hash, "#/home", "never navigates away from an unsaved draft");
  box.value = "";
  t.advance(1100);
  assert.equal(t.ach.popCurrent().id, "sa-countdown", "the countdown starts once idle");
  t.advance(5000);
  assert.equal(t.sandbox.location.hash, "#/settings/storage/usage", "then it opens");
  t.setHash("#/settings");
  assert.equal(t.sa.redirectState().active, null, "leaving the page ends the redirect");
}
{
  const t = setup({ hash: "#/compose" });
  t.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
  assert.equal(t.sa.busyReason(), "composing");
  t.advance(30000);
  assert.equal(t.sandbox.location.hash, "#/compose", "the composer blocks the redirect");
  t.setHash("#/home");
  t.advance(1100);
  assert.equal(t.ach.popCurrent().id, "sa-countdown");
  // Starting to type during the countdown makes it wait again.
  const input = t.dom.el("input");
  input.type = "text";
  t.document.activeElement = input;
  t.advance(4000);
  assert.equal(t.sandbox.location.hash, "#/home", "typing during the countdown waits");
  t.document.activeElement = t.dom.body;
  t.advance(10000);
  assert(String(t.sandbox.location.hash).startsWith("#/settings/notifications"), "opens Notifications once the person stops typing");
  t.sa.goBack();
  assert.equal(t.sandbox.location.hash, "#/home", "Back returns to the previous route");
}
{
  const t = setup({ hash: "#/tv" });
  t.dom.html.classList.add("tv-on");
  const video = t.dom.el("video");
  video.paused = false;
  t.dom.body.appendChild(video);
  t.sa.evaluate(disk(100));
  assert.equal(t.sa.busyReason(), "tv");
  t.advance(60000);
  assert.equal(t.sandbox.location.hash, "#/tv", "TV mode never redirects while playing");
  const call = t.dom.el("div");
  call.attrs["data-call-active"] = "1";
  video.paused = true;
  t.dom.body.appendChild(call);
  assert.equal(t.sa.busyReason(), "call", "a call blocks too");
}

// The auto-open setting and per-alert overrides.
{
  const t = setup({ prefs: { autoOpen: false } });
  t.sa.evaluate(disk(96));
  assert.equal(t.ach.popCurrent().variant, "critical", "auto-open off: just the card");
  t.advance(20000);
  assert.equal(t.sandbox.location.hash, "#/home");
  const u = setup({ prefs: { autoOff: { "storage-quota": true } } });
  u.sa.evaluate(disk(96));
  assert.equal(u.ach.popCurrent().variant, "critical", "a per-alert override keeps the card only");
  const html = u.sa.settingsHtml();
  ["Settings alerts", "Open settings automatically on critical issues", "Warn at", "Critical at", "Quiet hours", "Daily screen time limit", 'data-sa="preview" data-value="limit"'].forEach((s) => assert(html.includes(s), "settings show " + s));
  assert.equal(u.sa.prefs().warn, 80); assert.equal(u.sa.prefs().crit, 95);
}

// Quiet hours hold warnings but not critical alerts; thresholds move.
{
  const t = setup({ at: new Date(2026, 9, 29, 23, 0, 0).getTime(), prefs: { quiet: true, quietFrom: 22, quietTo: 7, autoOpen: false, warn: 70, crit: 90 } });
  t.sa.evaluate(disk(75));
  assert.equal(t.shows.length, 0, "quiet hours: the warning is logged, not shown");
  assert.equal(t.sa.state().log.length, 1);
  t.sa.evaluate(disk(91));
  assert.equal(t.ach.popCurrent().variant, "critical", "critical shows in quiet hours, at the custom 90%");
}

// Persistent storage refused: a notice in the log only, never a pop-out.
{
  const t = setup({ at: new Date(2026, 9, 5, 12, 0, 0).getTime(), prefs: { autoOpen: false } });
  t.sa.evaluate({ "persist-denied": { level: "info", vars: {} } });
  assert.equal(t.shows.length, 0, "persist-denied does not pop out");
  assert(t.sa.state().log.some((e) => e.id === "persist-denied"), "persist-denied stays as a notice");
}

// Data cap meter, fast burn, and alerts reported by other parts of the app.
{
  const t = setup({ at: new Date(2026, 9, 5, 12, 0, 0).getTime(), prefs: { autoOpen: false } });
  t.store["viktorychapp-data-meter-v1"] = JSON.stringify({ days: {}, cap: { on: true, bytes: 1 * GB, period: "month", resetDay: 1 } });
  t.sa.addBytes(0.5 * GB);
  {
    const m = t.sa.meter();
    assert.equal(m.cap.on, true);
    assert(t.sa.periodStart(m.cap, t.now()) <= t.now() && t.sa.periodEnd(m.cap, t.now()) > t.now(), "period brackets now");
  }
  const cap = t.sa.dataCapHtml();
  assert(cap.includes("Data cap") && cap.includes('role="meter"') && cap.includes("Reset day") && cap.includes("Reset meter"), "data cap section");
  t.sa.report("smspool-balance", { level: "warning", vars: { left: "$0.40" } });
  assert(t.shows.some((s) => s.html.includes("SMS code balance is low")), "reported limits pop too");
  assert.equal(t.sa.report("not-a-limit", { level: "warning" }), null);
}

// Async measuring: 50% of a 1 GB cap burned in 4.5 days warns about the pace.
(async () => {
  const t = setup({ at: new Date(2026, 9, 5, 12, 0, 0).getTime(), prefs: { autoOpen: false } });
  t.store["viktorychapp-data-meter-v1"] = JSON.stringify({ days: {}, cap: { on: true, bytes: 1 * GB, period: "month", resetDay: 1 } });
  t.sa.addBytes(0.5 * GB);
  const out = await t.sa.measure();
  assert(out["data-cap"] && Math.round(out["data-cap"].pct) === 50, "the meter counts bytes this period");
  assert(out["data-burn"] && out["data-burn"].level === "warning", "fast burn is flagged");
  t.sa.evaluate(out);
  assert(t.shows.some((s) => s.html.includes("At this rate you&#39;ll hit your cap in")), "fast-burn wording");

  // Wiring.
  const app = read("app.js");
  assert(app.includes("ViktorychSettingAlerts.settingsHtml()") && app.includes("ViktorychSettingAlerts.dataCapHtml()") && app.includes("ViktorychSettingAlerts.notesHtml()"), "app shows the settings, data cap and System items");
  const index = read("index.html");
  assert(index.includes('src="setting-alerts.js"') && index.includes('href="setting-alerts.css"'), "index loads the module");
  const sw = read("sw.js");
  assert(sw.includes('"./setting-alerts.js"') && sw.includes('"./setting-alerts.css"'), "offline shell caches it");
  const css = read("setting-alerts.css") + read("badges.css");
  ["sa-pulse", "sa-banner", "sa-note", ".v-warning", ".v-critical", ".v-limit", ".v-countdown", "prefers-reduced-motion"].forEach((s) => assert(css.includes(s), "styles cover " + s));
  for (const code of ["en", "es", "ru", "hi"]) {
    const pack = read("i18n/" + code + ".js");
    for (const key of ["Settings alerts", "Device storage is almost full", "Don't warn me about this", "Opening {page} in {n}…", "Data cap reached"]) assert(pack.includes(JSON.stringify(key) + ":"), code + " has " + key);
  }
  // Vibration and sound: critical buzzes short-long and plays a tone, a warning
  // only buzzes, info does neither; switches turn them off; a draft blocks both.
  {
    const rig = (prefs) => {
      const f = setup(prefs ? { prefs } : undefined);
      const buzzes = [];
      const tones = [];
      f.sandbox.navigator.vibrate = (pattern) => { buzzes.push(pattern); return true; };
      f.sandbox.AudioContext = class {
        constructor() { this.currentTime = 0; this.destination = {}; this.state = "suspended"; }
        resume() { this.state = "running"; return Promise.resolve(); }
        createOscillator() { const o = { type: "", frequency: { value: 0 }, connect() {}, start() {}, stop() { tones.push(o.frequency.value); } }; return o; }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
      };
      return { f, buzzes, tones };
    };
    let r = rig();
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert.equal(r.buzzes.length, 1, "critical vibrates");
    assert(r.buzzes[0].length >= 3 && r.buzzes[0][0] < r.buzzes[0][2], "critical buzz is short-long");
    assert.equal(r.tones.length, 0, "no sound before a tap or key press unlocks audio");
    r = rig();
    assert(r.f.sa.unlockAudio(), "a gesture unlocks audio");
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert.equal(r.buzzes.length, 1, "critical vibrates once unlocked too");
    assert(r.tones.length >= 2, "critical plays a short generated tone");
    r.f.sa.evaluate(disk(100));
    assert.equal(r.buzzes.length, 2, "limit vibrates");
    assert(r.tones.length >= 5, "limit plays a tone");
    r = rig(); r.f.sa.unlockAudio();
    r.f.sa.evaluate(disk(85));
    assert.equal(r.f.ach.popCurrent().variant, "warning");
    assert.deepEqual(r.buzzes.map((b) => b.length), [1], "a warning is a single short buzz");
    assert.equal(r.tones.length, 0, "a warning makes no sound");
    r = rig(); r.f.sa.unlockAudio();
    r.f.sa.evaluate({ "sync-failed": { level: "info", vars: {} } });
    assert.equal(r.buzzes.length + r.tones.length, 0, "info is silent");
    r = rig({ vibrate: false, sound: false }); r.f.sa.unlockAudio();
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert.equal(r.buzzes.length + r.tones.length, 0, "both switches off: nothing");
    assert.equal(r.f.sa.lastFeedback().skipped, "off");
    r = rig({ sound: false }); r.f.sa.unlockAudio();
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert.equal(r.buzzes.length, 1, "vibration stays on its own switch");
    assert.equal(r.tones.length, 0, "sound off");
    r = rig({ vibrate: false }); r.f.sa.unlockAudio();
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert.equal(r.buzzes.length, 0, "vibration off");
    assert(r.tones.length >= 2, "sound stays on its own switch");
    r = rig(); r.f.sa.unlockAudio();
    const draft = r.f.dom.el("textarea");
    draft.value = "half a post";
    r.f.dom.body.appendChild(draft);
    r.f.document.activeElement = draft;
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    r.f.sa.evaluate(disk(100));
    assert.equal(r.buzzes.length + r.tones.length, 0, "nothing fires while a draft is focused");
    assert.equal(r.f.sa.lastFeedback().skipped, "typing");
    r = rig(); r.f.sa.unlockAudio();
    r.f.sandbox.matchMedia = (q) => ({ matches: /reduced-motion/.test(q) });
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert.equal(r.buzzes.length, 0, "reduced motion: no vibration");
    assert(r.tones.length >= 2, "reduced motion keeps the tone");
    r = rig(); r.f.sa.unlockAudio();
    delete r.f.sandbox.navigator.vibrate;
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert(r.tones.length >= 2, "no vibrate API (iOS): sound still plays, nothing throws");
    // Hidden tab with notifications allowed: the system notification carries it.
    r = rig(); r.f.sa.unlockAudio();
    const sys = [];
    r.f.sandbox.Notification = class { constructor(title, o) { sys.push({ title, o }); } };
    r.f.sandbox.Notification.permission = "granted";
    r.f.document.visibilityState = "hidden";
    r.f.sa.evaluate({ "push-revoked": { level: "critical", vars: {} } });
    assert.equal(r.buzzes.length + r.tones.length, 0, "hidden tab: no in-page buzz or tone");
    assert.equal(sys.length, 1, "hidden tab: one system notification");
    assert(sys[0].o.silent === false && Array.isArray(sys[0].o.vibrate) && sys[0].o.data.hash, "system notification vibrates, is not silent and links to the setting");
    // Settings switches and the Test row.
    r = rig();
    const sh = r.f.sa.settingsHtml();
    ["Vibrate for alerts", "Sound for alerts", 'data-sa="vibrate"', 'data-sa="sound"', 'data-sa="feedback-test"'].forEach((x) => assert(sh.includes(x), "settings show " + x));
    ["vibrate", "sound"].forEach((n) => assert(APP_PATH[n] && sh.includes(APP_PATH[n]), n + " switch uses the app outline glyph"));
  }

  // Icons: names from the app's icon set, drawn as one-colour 24px SVG, never emoji.
  const ic = setup();
  ic.sa.ALERTS.forEach((def) => {
    assert(APP_PATH[def.icon], def.id + " uses an app icon, got " + def.icon);
    assert(!EMOJI.test(def.icon), def.id + " has no emoji");
  });
  const appSrc = read("app.js");
  assert(appSrc.includes("window.ViktorychIcons = "), "app shares its icon set");
  ic.sa.evaluate(disk(96));
  ["info", "warning", "critical", "limit"].forEach((v) => ic.sa.preview && ic.sa.preview(v));
  ic.advance(60000);
  const surfaces = ic.shows.map((x) => x.html).concat([ic.sa.notesHtml(), ic.sa.settingsHtml()]);
  surfaces.forEach((html, i) => {
    assert(!EMOJI.test(html.replace(/<path d="[^"]*"/g, "")), "no emoji in surface " + i);
  });
  assert(ic.shows.length && ic.shows.every((x) => /<span class="ach-ico"><svg viewBox="0 0 24 24"/.test(x.html)), "pop-outs draw an SVG glyph");
  assert(/<span class="sa-note-ico" aria-hidden="true"><svg viewBox="0 0 24 24"/.test(ic.sa.notesHtml()), "System items draw an SVG glyph");
  assert(/<span class="sa-row-ico" aria-hidden="true"><svg viewBox="0 0 24 24"/.test(ic.sa.settingsHtml()), "settings rows draw an SVG glyph");
  const iconCss = read("setting-alerts.css") + read("badges.css");
  assert(/\.sa-note-ico svg[^}]*\}/.test(iconCss) && iconCss.includes("fill: currentColor"), "glyphs fill with currentColor");
  assert(!EMOJI.test(read("setting-alerts.js")), "setting-alerts.js has no emoji");
  console.log("ok setting alerts");
  /* The local-store alert's numbers come from the localStorage budget. */
  require("child_process").execFileSync(process.execPath, [require("path").join(__dirname, "local_budget_test.js")], { stdio: "inherit" });
})().catch((err) => { console.error(err); process.exit(1); });
