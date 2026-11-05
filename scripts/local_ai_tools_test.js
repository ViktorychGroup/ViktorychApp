/* Viktrych tools, app actions, chat search/deletion and local memory.
   No network and no media download: fetches and workers are fakes. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Tools = require("../local-ai-tools.js");
const Actions = require("../local-ai-actions.js");
const Chat = require("../local-ai-chat.js");
const Memory = require("../local-ai-memory.js");
const Runner = require("../local-ai-runner.js");

const root = path.join(__dirname, "..");
function read(name) { return fs.readFileSync(path.join(root, name), "utf8"); }

const pageFiles = ["local-ai-tools.js", "local-ai-actions.js", "local-ai-runner.js", "local-ai-ui.js", "local-ai-memory.js", "local-ai-chat.js", "app.js"];
pageFiles.forEach((name) => {
  const src = read(name);
  assert.strictEqual(/\beval\s*\(/.test(src), false, name + " does not eval");
  assert.strictEqual(/new Function/.test(src), false, name + " does not build functions from text");
});
assert.ok(/new Function/.test(read("local-ai-code-worker.js")), "code runs only inside its worker");
assert.ok(read("local-ai-ffmpeg-worker.js").includes(Tools.PINS.ffmpegCore), "ffmpeg worker is pinned");
assert.ok(!/core-mt/.test(read("local-ai-ffmpeg-worker.js")), "ffmpeg stays on the single-thread build");

const direct = "https://cdn.example.com/clip.mp4";
assert.strictEqual(Tools.classifyUrl(direct).ok, true);
assert.strictEqual(Tools.classifyUrl("http://cdn.example.com/clip.mp4").reason, "protocol");
assert.strictEqual(Tools.classifyUrl("https://user:pass@cdn.example.com/clip.mp4").reason, "private");
assert.strictEqual(Tools.classifyUrl("https://127.0.0.1/clip.mp4").reason, "private");
assert.strictEqual(Tools.classifyUrl("https://10.1.2.3/a.mp4").reason, "private");
assert.strictEqual(Tools.classifyUrl("https://www.youtube.com/watch?v=abc").reason, "site");
assert.strictEqual(Tools.classifyUrl("https://cdn.example.com/list.m3u8").reason, "playlist");
assert.strictEqual(Tools.classifyUrl("https://cdn.example.com/page").reason, "file");

const typed = "download this video " + direct + " and convert it";
const proposed = Tools.propose(typed);
assert.strictEqual(proposed[0].name, "media.fetch");
assert.strictEqual(proposed[0].url, direct);
const foreign = Tools.review([{ name: "media.fetch", url: "https://evil.example/other.mp4" }], { source: "user-chat", typed: typed });
assert.strictEqual(foreign.accepted.length, 0);
const fromPost = Tools.review(proposed, { source: "post", typed: typed });
assert.strictEqual(fromPost.accepted.length, 0);
assert.strictEqual(fromPost.rejected[0].why, "source");
const settings = Tools.review([{ fn: "set", id: "appearance", value: "dim" }], { source: "user-chat", typed: "dark mode" });
assert.strictEqual(settings.rejected[0].why, "settings");
assert.deepStrictEqual(Tools.ffmpegArgs("mp4", "clip.mp4", "clip.out.mp4").slice(0, 3), ["-hide_banner", "-nostdin", "-i"]);
assert.strictEqual(Tools.ffmpegArgs("mp4", "clip.mp4;rm", "out.mp4"), null);
assert.ok(Tools.ffmpegArgs("version").indexOf("sudo") < 0);
assert.ok(!Tools.ffmpegArgs("mp4", "clip.mp4", "out.mp4").some((part) => /:\/\//.test(part)));

function flush(times) {
  let chain = Promise.resolve();
  for (let i = 0; i < (times || 8); i += 1) chain = chain.then(() => Promise.resolve());
  return chain;
}

(async () => {
  const ran = [];
  const session = Tools.createSession({
    typed: typed,
    source: "user-chat",
    steps: Tools.review(Tools.propose(typed), { source: "user-chat", typed: typed }).accepted,
    execute: (step) => {
      ran.push(step.name);
      if (step.name === "media.fetch") return { ok: true, bytes: 12, path: "clip.mp4" };
      if (step.name === "ffmpeg.load") return { ok: true, out: "ffmpeg" };
      if (step.name === "ffmpeg.convert") return { ok: true, bytes: 8, path: "clip.mp4" };
      if (step.name === "media.save") return { ok: true, bytes: 8, path: step.file, via: "download" };
      return { ok: false, error: "tool" };
    },
    follow: (results) => Tools.nextSteps(typed, results)
  });
  const pending = session.start();
  await flush();
  assert.strictEqual(session.snapshot().status, "need-approval");
  assert.strictEqual(ran.length, 0, "nothing runs before approval");
  session.approve(true);
  await flush();
  assert.strictEqual(ran[0], "media.fetch");
  session.approve(true);
  await flush();
  session.approve(true);
  await flush();
  session.approve(true);
  const done = await pending;
  assert.deepStrictEqual(ran, ["media.fetch", "ffmpeg.load", "ffmpeg.convert", "media.save"]);
  assert.strictEqual(done.verified, true);
  assert.strictEqual(done.summary, "ok");
  assert.ok(done.audit.some((row) => row.role === "verifier" && row.status === "ok") === false, "verifier is only in agent mode");

  const emptyRun = [];
  const failed = Tools.createSession({
    typed: "download " + direct,
    source: "user-chat",
    steps: Tools.propose("download " + direct),
    execute: (step) => {
      emptyRun.push(step.name);
      return { ok: true, bytes: 0, path: "" };
    }
  });
  const failedTask = failed.start();
  await flush();
  failed.approve(true);
  const failedSnap = await failedTask;
  assert.deepStrictEqual(emptyRun, ["media.fetch"]);
  assert.strictEqual(failedSnap.verified, false);
  assert.strictEqual(failedSnap.summary, "no-file");

  const agents = [];
  let inflight = 0;
  let overlap = 0;
  const agentSession = Tools.createSession({
    typed: "list files in the workspace",
    source: "user-chat",
    agents: true,
    parallel: true,
    steps: [
      { channel: "tool", name: "workspace.list", risk: "none", needsConfirm: false, execute: true },
      { channel: "tool", name: "workspace.list", risk: "none", needsConfirm: false, execute: true, file: "b" }
    ],
    execute: async () => {
      inflight += 1;
      if (inflight > 1) overlap += 1;
      await Promise.resolve();
      inflight -= 1;
      agents.push("list");
      return { ok: true, out: "a.txt" };
    }
  });
  const agentSnap = await agentSession.start();
  assert.ok(agentSnap.audit.some((row) => row.role === "lead"));
  assert.ok(agentSnap.audit.some((row) => row.role === "verifier"));
  assert.ok(overlap >= 1, "two safe reads can overlap");
  assert.ok(!/model/.test(JSON.stringify(agentSnap.audit)), "roles do not load another model");

  const cancelled = Tools.createSession({
    typed: "download " + direct,
    source: "user-chat",
    steps: Tools.propose("download " + direct),
    execute: () => { throw new Error("should not run"); }
  });
  const cancelTask = cancelled.start();
  await flush();
  cancelled.cancel();
  const cancelSnap = await cancelTask;
  assert.strictEqual(cancelSnap.summary, "cancelled");

  const store = Runner.memoryStorage();
  let fetches = 0;
  const runner = Runner.createRunner({
    tools: Tools,
    storage: store,
    capabilities: Tools.capabilitiesFrom({ worker: true, storage: 1000000, python: false }),
    fetch: async (url, opts) => {
      fetches += 1;
      assert.strictEqual(opts.credentials, "omit");
      assert.strictEqual(opts.redirect, "manual");
      assert.strictEqual(String(url).includes("evil"), false);
      return {
        status: 200,
        headers: { get: (name) => (name === "content-type" ? "video/mp4" : "") },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer
      };
    }
  });
  const fetched = await runner.exec({ name: "media.fetch", url: direct, file: "clip.mp4" });
  assert.strictEqual(fetched.ok, true);
  assert.strictEqual(fetched.bytes, 4);
  const savedBytes = await store.get("clip.mp4");
  assert.strictEqual(savedBytes.byteLength, 4);
  const blocked = await runner.exec({ name: "media.fetch", url: "https://www.youtube.com/watch.mp4", file: "watch.mp4" });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(fetches, 1, "a rejected host is not fetched");

  const fake = { terminated: false };
  fake.postMessage = (msg) => {
    setTimeout(() => {
      if (msg.op === "load") fake.onmessage({ data: { op: "ready" } });
      if (msg.op === "exec") {
        assert.ok(msg.args.indexOf("://") < 0);
        fake.onmessage({ data: { op: "done", code: 0, file: new Uint8Array(0) } });
      }
    }, 0);
  };
  fake.terminate = () => { fake.terminated = true; };
  const ffmpegRunner = Runner.createRunner({
    tools: Tools,
    storage: store,
    capabilities: Tools.capabilitiesFrom({ worker: true }),
    spawnWorker: () => fake
  });
  const converted = await ffmpegRunner.exec({ name: "ffmpeg.convert", kind: "mp4", input: "clip.mp4", file: "clip.out.mp4" });
  assert.strictEqual(converted.ok, false);
  assert.strictEqual(converted.error, "no-file");

  const slow = { postMessage: () => {} };
  slow.terminate = () => { slow.terminated = true; };
  const timeoutRunner = Runner.createRunner({
    tools: Object.assign({}, Tools, { LIMITS: Object.assign({}, Tools.LIMITS, { timeoutMs: 30 }) }),
    storage: store,
    spawnWorker: () => slow
  });
  const timed = await timeoutRunner.exec({ name: "ffmpeg.load" });
  assert.strictEqual(timed.error, "timeout");
  assert.strictEqual(slow.terminated, true);

  const ctx = { tabs: [{ id: "t1", name: "News" }] };
  const people = Actions.review([{ name: "person.block", handle: "@example_reader" }], { source: "user-chat", typed: "block @example_reader", ctx: ctx });
  assert.strictEqual(people.accepted.length, 1);
  assert.strictEqual(people.accepted[0].handle, "@example_reader");
  assert.ok(people.accepted[0].preview === "block");
  const invented = Actions.review([{ name: "person.block", handle: "@other_name" }], { source: "user-chat", typed: "block @example_reader", ctx: ctx });
  assert.strictEqual(invented.accepted.length, 0);
  const fromPage = Actions.propose("create a tab called News", ctx);
  assert.ok(!fromPage.some((row) => row.name === "tab.create"), "an existing tab is not created again");
  const made = Actions.propose('create a tab called "Daily"', { tabs: [] });
  assert.strictEqual(made.filter((row) => row.name === "tab.create")[0].tabName, "Daily");
  const postTabs = Actions.review(made, { source: "post", typed: 'create a tab called "Daily"', ctx: { tabs: [] } });
  assert.strictEqual(postTabs.accepted.length, 0);
  const draft = Actions.propose("draft a post: hello from the page", ctx)[0];
  assert.strictEqual(draft.name, "compose.draft");
  assert.strictEqual(draft.posted, false);
  assert.strictEqual(draft.text, "hello from the page");
  const list = Actions.propose('create a list called "Cedar"', ctx).find((row) => row.name === "list.draft");
  assert.strictEqual(list.saved, false);
  assert.strictEqual(list.listName, "Cedar");
  const closing = Actions.propose("close tab News", ctx).find((row) => row.name === "tab.close");
  assert.strictEqual(closing.tabName, "News");
  assert.strictEqual(Actions.propose("close tab Missing", ctx).some((row) => row.name === "tab.close"), false);
  const opened = Actions.propose("open lists", ctx).find((row) => row.name === "nav.open");
  assert.strictEqual(opened.hash, "#/lists");
  assert.strictEqual(Actions.register({ id: "post.send", effect: "mutate", needsConfirm: true, validate: () => null, preview: () => "" }).reason, "blocked");
  assert.strictEqual(Actions.register({ id: "notes.pin", effect: "mutate", needsConfirm: false, validate: () => null, preview: () => "" }).reason, "confirm");
  assert.strictEqual(Actions.register({
    id: "notes.pin",
    effect: "draft",
    needsConfirm: true,
    validate: (text) => (String(text).indexOf("pin note") >= 0 ? { name: "notes.pin", note: "later" } : null),
    preview: () => "pin"
  }).ok, true);
  assert.ok(Actions.catalog().some((row) => row.name === "notes.pin" && row.needsConfirm === true));
  assert.strictEqual(Actions.propose("pin note", ctx).some((row) => row.name === "notes.pin"), true);
  Actions.resetCustom();

  const chats = [{
    id: "c1",
    title: "How do I convert?",
    msgs: [
      { role: "user", text: "How do I convert?" },
      { role: "ai", text: "Use the private workspace and ffmpeg." },
      { role: "user", text: "alpha beta is the phrase" }
    ]
  }, {
    id: "c2",
    title: "alpha beta",
    msgs: [{ role: "user", text: "alpha beta" }]
  }];
  const hits = Chat.search(chats, "alpha beta");
  assert.strictEqual(hits[0].chatId, "c2");
  assert.strictEqual(hits[0].index, 0);
  assert.ok(Chat.parts(hits[0].snippet).some((part) => part.hit));
  const workspace = Chat.search(chats, "private workspace");
  assert.strictEqual(workspace[0].chatId, "c1");
  assert.strictEqual(workspace[0].index, 1);
  assert.strictEqual(Chat.resolve(chats[0], workspace[0]), 1);
  const removedAi = Chat.deleteMessages(chats[0], [1]);
  assert.strictEqual(removedAi.msgs.length, 2);
  assert.strictEqual(removedAi.msgs.some((msg) => msg.role === "ai"), false);
  const removedUser = Chat.deleteMessages(chats[0], [0]);
  assert.strictEqual(removedUser.msgs[0].role, "ai");
  assert.strictEqual(removedUser.title, "alpha beta is the phrase");
  const both = Chat.deleteMessages(chats[0], [0, 1]);
  assert.strictEqual(both.msgs.length, 1);
  assert.strictEqual(Chat.needsConfirm(1), false);
  assert.strictEqual(Chat.needsConfirm(2), true);
  const after = chats.map((chat, index) => index === 0 ? Object.assign({}, chat, { msgs: removedAi.msgs, title: removedAi.title }) : chat);
  assert.strictEqual(Chat.search(after, "private workspace").length, 0);
  assert.strictEqual(Chat.search(after, "convert")[0].index, 0);
  assert.strictEqual(JSON.stringify(after[0].msgs).includes("private workspace"), false);
  const restored = Chat.restore({ id: "c1", title: chats[0].title, at: 1, msgs: chats[0].msgs });
  assert.strictEqual(restored.msgs.length, 3);

  const bag = {};
  const memory = Memory.createMemory({
    get: (key) => (key in bag ? bag[key] : null),
    set: (key, value) => { bag[key] = value; },
    remove: (key) => { delete bag[key]; }
  });
  assert.strictEqual(memory.observe("remember that I prefer dark mode", { history: "keep", source: "user-chat", chatId: "c1" }).ok, true);
  assert.strictEqual(memory.observe("what is my name?", { history: "keep", source: "user-chat", chatId: "c1" }).reason, "none");
  assert.strictEqual(memory.observe("remember that my password is swordfish", { history: "keep", source: "user-chat" }).reason, "secret");
  assert.strictEqual(memory.list().some((row) => /password|swordfish/i.test(row.text)), false);
  assert.strictEqual(memory.observe("remember that I like quiet chats", { history: "off", source: "user-chat", chatId: "c1" }).reason, "history");
  assert.strictEqual(memory.observe("remember this from a post", { source: "post", history: "keep" }).reason, "source");
  memory.add({ text: "I like quiet mornings", source: "user" });
  const ranked = memory.retrieve("quiet mornings on this phone");
  assert.strictEqual(ranked.items[0].text, "I like quiet mornings");
  assert.strictEqual(ranked.items[0].source, "user");
  const block = memory.promptBlock("dark mode please", { history: "keep" });
  assert.ok(block.includes("(chat)"));
  assert.ok(block.length < 700);
  const offBlock = memory.promptBlock("dark mode please", { history: "off" });
  assert.ok(!offBlock.includes("dark mode"));
  memory.setEnabled(false);
  assert.strictEqual(memory.observe("remember that I prefer large text", { history: "keep", source: "user-chat" }).reason, "off");
  assert.strictEqual(memory.promptBlock("dark mode", { history: "keep" }), "");
  memory.setEnabled(true);
  const id = memory.list()[0].id;
  assert.strictEqual(memory.update(id, "my token is abcdef").reason, "secret");
  assert.strictEqual(memory.update(id, "I like quiet evenings").ok, true);
  memory.dropMessages("c1", ["remember that I prefer dark mode"]);
  assert.ok(!memory.list().some((row) => row.source === "chat" && /dark mode/.test(row.text)));
  memory.forget();
  assert.strictEqual(memory.list().length, 0);

  const sw = read("sw.js");
  ["local-ai-tools.js", "local-ai-actions.js", "local-ai-runner.js", "local-ai-memory.js", "local-ai-chat.js", "local-ai-ffmpeg-worker.js", "local-ai-code-worker.js"].forEach((name) => {
    assert.ok(sw.includes('"./' + name + '"'), name + " is cached");
  });
  const flags = read("worker/src/feature-flags.js");
  const app = read("app.js");
  assert.ok(/ai_tools:\s*\{/.test(flags), "tools have a switch");
  assert.ok(/SERVER_FEATURES\s*=\s*\[[^\]]*"ai_tools"/.test(app), "the client lists the switch");
  assert.ok(app.includes("aiPersonApply"), "block still uses the people apply path");
  assert.ok(app.includes("performAppAction"), "app actions have a host");
  console.log("local ai tools ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
