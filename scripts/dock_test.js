const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const store = {};
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  URL,
  localStorage: {
    getItem(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
    setItem(key, value) { store[key] = String(value); },
    removeItem(key) { delete store[key]; }
  },
  location: { hostname: "127.0.0.1" }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync("dock.js", "utf8"), sandbox, { filename: "dock.js" });
const dock = sandbox.ViktorychDock;

assert.deepEqual(dock.presetSize("compact", 1400, 900), { w: 400, h: 530 });
assert.deepEqual(dock.presetSize("tall", 1400, 900), { w: 400, h: 780 });
assert.equal(dock.presetSize("half", 1400, 900).w, 700);
assert.equal(dock.presetSize("full", 1400, 900).w, 1384);
assert.equal(dock.clampBox(10, 10, 1400, 900).w, 320);
assert.equal(dock.clampBox(10, 10, 1400, 900).h, 280);

dock.replaceState({ showChat: true, showAi: true, side: "right", size: "compact", chatOpen: true, aiOpen: true, chatThread: "abc" });
dock.setUi({ chatView: "thread", menu: false, aiView: "thread" });
let html = dock.renderHtml();
assert(html.includes('id="dock-root"'));
assert(html.includes('class="xdock side-right"'));
assert(html.includes('role="region"'));
assert(!html.includes('role="dialog"'));
assert(!html.includes("aria-modal"));
assert(html.includes('href="https://x.com/i/chat"'));
assert(html.includes('target="_blank"'));
assert(html.includes("noopener"));
assert(html.includes('data-panel="chat"'));
assert(html.includes('data-panel="ai"'));
assert(html.includes("<textarea"));
assert(html.includes("--dock-w:400px"));
assert(html.includes("--dock-h:530px"));
assert(!/https?:\/\/(?!x\.com)/i.test(html));
assert(!html.includes("<iframe"));
assert(!html.includes("window.open"));

dock.seedChat({
  conversations: [{ id: "abc", peer: { name: "<script>alert(1)</script>", handle: "ada", publicId: "1" }, last: { body: "<img src=x onerror=alert(1)>" } }],
  messages: [{ id: "m1", senderId: "1", body: "<script>alert(1)</script>" }],
  peer: { name: "<script>alert(1)</script>", handle: "ada" }
});
dock.setUi({ chatView: "list" });
html = dock.renderHtml();
assert(!html.includes("<script>"));
assert(html.includes("&lt;script&gt;"));
assert(!html.includes("<img"));
dock.setUi({ chatView: "thread" });
html = dock.renderHtml();
assert(html.includes("Read-only channel"));
assert(html.includes('aria-disabled="true"'));
assert(!html.includes('data-compose="chat"'));
assert(html.includes("&lt;script&gt;"));

dock.setPref("side", "left");
assert(dock.renderHtml().includes("side-left"));
dock.setPref("showChat", "0");
assert(!dock.renderHtml().includes('data-panel="chat"'));
dock.setPref("showChat", "1");
dock.setPref("size", "tall");
assert.equal(dock.debug().chat.chat.preset, "tall");
assert.equal(dock.debug().chat.ai.preset, "tall");

assert.equal(dock.demoOn(), true);
assert.equal(dock.activeProvider().id, "echo");
sandbox.localStorage.setItem("viktorychapp-ai-demo", "0");
assert.equal(dock.demoOn(), false);
assert.equal(dock.activeProvider(), null);
assert(dock.renderHtml().includes('data-ai-mode="soon"'));
assert(dock.renderHtml().includes("AI is coming soon"));
sandbox.localStorage.setItem("viktorychapp-ai-demo", "1");
assert.equal(dock.activeProvider().id, "echo");
assert(dock.renderHtml().includes('data-ai-mode="chat"'));
assert(dock.renderHtml().includes("Local echo. No model is connected."));
const echo = dock.activeProvider();

(async function () {
  const parts = [];
  for await (const part of echo.sendMessage([{ role: "user", text: "hi", attachments: [{ name: "a.txt" }] }])) parts.push(part);
  assert.equal(parts.join(""), "Echo: hi (a.txt)");
  dock.registerProvider({ id: "late", order: 200, available: function () { return true; }, sendMessage: async function* () { yield "late"; } });
  dock.registerProvider({ id: "early", order: 1, available: function () { return false; }, sendMessage: async function* () { yield "early"; } });
  assert.equal(dock.activeProvider().id, "echo");
  dock.registerProvider({ id: "early", order: 1, available: function () { return true; }, sendMessage: async function* () { yield "yes"; } });
  assert.equal(dock.activeProvider().id, "early");

  const memory = dock.createMemoryStore();
  await memory.save({ id: "one", title: "First", updatedAt: 2, messages: [{ id: "m", role: "user", text: "hi" }] });
  await memory.save({ id: "two", title: "Second", updatedAt: 1, messages: [] });
  const listed = await memory.list();
  assert.equal(listed[0].id, "one");
  assert.equal((await memory.get("one")).title, "First");
  await memory.remove("one");
  assert.equal((await memory.list()).length, 1);

  const css = fs.readFileSync("dock.css", "utf8");
  assert(css.includes(".xdock") && css.includes("pointer-events: none"));
  assert(css.includes("pointer-events: auto"));
  assert(css.includes("position: fixed"));
  assert(css.includes("bottom: 0"));
  assert(css.includes("border-radius: 16px"));
  assert(css.includes("height: 53px"));
  assert(css.includes("cubic-bezier(0.2, 0, 0, 1)"));
  assert(css.includes("prefers-reduced-motion"));
  assert(css.includes("rgba(255, 255, 255, 0.2)"));
  assert(css.includes("rgba(101, 119, 134, 0.2)"));
  assert(css.includes("max-width: 499px"));

  const page = fs.readFileSync("index.html", "utf8");
  const worker = fs.readFileSync("sw.js", "utf8");
  const sync = fs.readFileSync(".github/workflows/publish-app.yml", "utf8");
  const publish = fs.readFileSync("scripts/discord_publish.py", "utf8");
  assert(page.includes('href="dock.css"'));
  assert(page.includes('href="presence.css"'));
  assert(page.indexOf('src="discord-ui.js"') < page.indexOf('src="dock.js"'));
  assert(page.indexOf('src="dock.js"') < page.indexOf('src="app.js"'));
  assert(worker.includes("./dock.js") && worker.includes("./dock.css"));
  assert(worker.includes("./presence.js") && worker.includes("./presence.css"));
  assert(worker.includes("./localfirst.js") && worker.includes("./direct.js"));
  assert(sync.includes("python3 scripts/assemble_site.py --site _site"));
  assert(!sync.includes("cp index.html"));
  assert(publish.includes("assemble_site"));
  assert(!publish.includes("SITE_FILES"));
  assert(!fs.existsSync("worker/src/messages.js"));
  assert(!fs.existsSync("worker/migrations/0018_messages.sql"));
  assert(!fs.existsSync("worker/test/messages.test.mjs"));
  const tree = fs.readFileSync("dock.js", "utf8") + fs.readFileSync("dock.css", "utf8");
  assert(!tree.includes("/v1/messages"));
  assert(!/https?:\/\/(?!x\.com)/i.test(tree));
  assert(!tree.includes("window.open"));
  assert(!fs.existsSync("extension"));

  const settings = dock.settingsHtml();
  assert(settings.includes('data-act="dock-pref"'));
  assert(settings.includes("Show Chat"));
  console.log("dock test ok");
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});

// Keyboard shortcut registry tests ride along with this CI step.
require("./keys_test.js");
