const assert = require("assert");
const device = require("../device.js");
const search = require("../device-search.js");
const ai = require("../device-ai.js");
const media = require("../device-media.js");
const record = require("../device-record.js");
const direct = require("../direct.js");

function balanced() {
  return device.normalize(null);
}

function strong() {
  return { deviceMemory: 8, hardwareConcurrency: 8, saveData: false, onWifi: null, battery: null, charging: null };
}

device.reset();
search.reset();
media.reset();
direct.reset();

const preset = balanced();
assert.strictEqual(preset.level, "balanced");
assert.strictEqual(preset.toggles.direct, true);
assert.strictEqual(preset.toggles.search, true);
assert.strictEqual(preset.toggles.translate, true);
assert.strictEqual(preset.toggles.ai, true);
assert.strictEqual(preset.toggles.media, true);
assert.strictEqual(preset.toggles.record, true);
assert.strictEqual(preset.toggles.storage, true);
assert.strictEqual(preset.toggles.sync, true);
assert.strictEqual(preset.wifiOnly, false);
assert.strictEqual(preset.pauseBattery, true);
assert.strictEqual(preset.autoLight, true);
assert.strictEqual(preset.webllm, false);
assert.strictEqual(preset.aiFeatures.detect, true);
assert.strictEqual(preset.aiFeatures.spam, true);
assert.strictEqual(preset.aiFeatures.summarize, true);
assert.strictEqual(preset.aiFeatures.compose, true);
assert.strictEqual(preset.aiFeatures.semantic, false);
assert.strictEqual(preset.aiFeatures.translateLocal, false);
assert.strictEqual(preset.aiFeatures.semanticLocal, false);
assert.strictEqual(preset.aiFeatures.dmServer, false);
assert.strictEqual(preset.aiFeatures.dmAuto, false);
assert.strictEqual(device.applyLevel("light").aiFeatures.spam, false);
const keptDm = device.applyLevel("max", { aiFeatures: { dmServer: true, translateLocal: true, dmAuto: true } });
assert.strictEqual(keptDm.aiFeatures.dmServer, true);
assert.strictEqual(keptDm.aiFeatures.dmAuto, true);
assert.strictEqual(keptDm.aiFeatures.translateLocal, false);
assert.strictEqual(device.toggleAi(preset, "spam").aiFeatures.spam, false);
assert.strictEqual(device.aiFeatureOn(preset, "spam", strong()), true);
assert.strictEqual(device.aiFeatureOn(device.applyLevel("light"), "detect", strong()), false);
assert.strictEqual(preset.profile, "balanced");
assert.strictEqual(preset.peerMedia, "auto");
assert.strictEqual(device.normalize({ profile: "lite", peerMedia: "on", peerUploadCap: 32768 }).level, "light");
assert.strictEqual(device.normalize({ profile: "lite", peerMedia: "on" }).profile, "lite");
assert.strictEqual(device.normalize({ level: "max", peerMedia: "off", peerShareWhileWatching: false }).peerShareWhileWatching, false);
const keptPeer = device.applyLevel("max", { peerMedia: "off", peerUploadCap: 131072, peerShareWhileWatching: false });
assert.strictEqual(keptPeer.level, "max");
assert.strictEqual(keptPeer.profile, "max");
assert.strictEqual(keptPeer.peerMedia, "off");
assert.strictEqual(keptPeer.peerUploadCap, 131072);
assert.strictEqual(keptPeer.peerShareWhileWatching, false);
assert.strictEqual(device.syncShape(keptPeer).profile, "max");
assert.strictEqual(device.syncShape(keptPeer).savedBytes, undefined);

const light = device.applyLevel("light");
assert.strictEqual(light.toggles.direct, false);
assert.strictEqual(light.toggles.storage, true);
assert.strictEqual(light.wifiOnly, true);
assert.strictEqual(light.webllm, false);
assert.strictEqual(light.webllmAccepted, false);

const maxAccepted = device.confirmWebllm(device.applyLevel("max"), true);
assert.strictEqual(maxAccepted.webllm, true);
assert.strictEqual(device.applyLevel("max").webllm, false);
assert.strictEqual(device.confirmWebllm(maxAccepted, false).webllm, false);

const overridden = device.toggle(light, "direct");
assert.strictEqual(overridden.level, "light");
assert.strictEqual(overridden.toggles.direct, true);
assert.strictEqual(device.toggle(balanced(), "search").toggles.search, false);
assert.strictEqual(device.toggle(balanced(), "wifiOnly").wifiOnly, true);

const weak = { deviceMemory: 2, hardwareConcurrency: 8, saveData: false, onWifi: null, battery: null, charging: null };
assert.strictEqual(device.effectiveLevel(balanced(), weak), "light");
assert.strictEqual(device.featureOn(balanced(), "direct", weak), false);
assert.strictEqual(device.featureOn(balanced(), "storage", weak), true);
const stay = device.toggle(balanced(), "autoLight");
assert.strictEqual(stay.autoLight, false);
assert.strictEqual(device.effectiveLevel(stay, weak), "balanced");
assert.strictEqual(device.featureOn(stay, "direct", weak), true);
assert.strictEqual(device.isWeak({ saveData: true, deviceMemory: 8, hardwareConcurrency: 8 }), true);
assert.strictEqual(device.isWeak({ hardwareConcurrency: 2, deviceMemory: 8 }), true);
assert.strictEqual(device.isWeak(strong()), false);

const wifi = device.toggle(balanced(), "wifiOnly");
assert.strictEqual(device.heavyPaused(wifi, { onWifi: false }), true);
assert.strictEqual(device.heavyPaused(wifi, { onWifi: null }), false);
assert.strictEqual(device.featureOn(wifi, "direct", { onWifi: false, deviceMemory: 8, hardwareConcurrency: 8 }), false);
assert.strictEqual(device.heavyPaused(balanced(), { battery: 0.1, charging: false }), true);
assert.strictEqual(device.heavyPaused(balanced(), { battery: 0.1, charging: true }), false);
assert.strictEqual(device.heavyPaused(balanced(), { battery: null }), false);
assert.strictEqual(device.heavyPaused(device.applyLevel("max"), { battery: 0.05, charging: false }), false);

const shape = device.syncShape({ level: "max", toggles: { direct: false }, webllm: true, webllmAccepted: false, savedBytes: 99 });
assert.strictEqual(shape.level, "max");
assert.strictEqual(shape.toggles.direct, false);
assert.strictEqual(shape.webllm, false);
assert.strictEqual(shape.savedBytes, undefined);
assert.strictEqual(JSON.stringify(shape).indexOf("savedBytes"), -1);
assert.strictEqual(device.syncShape(maxAccepted).webllm, true);

const html = device.settingsHtml(balanced());
assert.ok(html.indexOf('data-act="device-level"') >= 0);
assert.ok(html.indexOf('data-level="light"') >= 0);
assert.ok(html.indexOf('data-level="balanced"') >= 0);
assert.ok(html.indexOf('data-level="max"') >= 0);
assert.ok(html.indexOf('data-key="direct"') >= 0);
assert.ok(html.indexOf('data-key="wifiOnly"') >= 0);
assert.ok(html.indexOf("Saved by your device") >= 0);
assert.ok(html.indexOf("Kept off the server") >= 0);
device.setWarn(true);
const warned = device.settingsHtml(device.applyLevel("max"));
assert.ok(warned.indexOf('data-act="device-webllm"') >= 0);
assert.ok(warned.indexOf("device-webllm-yes") >= 0);
assert.ok(warned.indexOf("Download model") >= 0);
device.setWarn(false);
assert.strictEqual(device.settingsHtml(device.applyLevel("balanced")).indexOf("device-webllm"), -1);

assert.strictEqual(device.webllmAllowed(maxAccepted, strong()), true);
assert.strictEqual(device.webllmAllowed(maxAccepted, weak), false);
assert.strictEqual(device.webllmAllowed(balanced(), strong()), false);
assert.strictEqual(device.webllmAllowed(device.applyLevel("max"), strong()), false);

assert.strictEqual(device.capBytes("light"), 256 * 1024 * 1024);
assert.strictEqual(device.capBytes("balanced"), 1024 * 1024 * 1024);
assert.strictEqual(device.capBytes("max"), 5 * 1024 * 1024 * 1024);

const plan = device.evictLru([
  { id: "old", bytes: 10, at: 1 },
  { id: "pin", bytes: 10, at: 2, keep: true },
  { id: "new", bytes: 10, at: 3 }
], 20);
assert.strictEqual(plan.drop.length, 1);
assert.strictEqual(plan.drop[0].id, "old");
assert.deepStrictEqual(plan.keep.map((row) => row.id), ["pin", "new"]);

device.reset();
assert.strictEqual(device.playbackUrl("https://cdn.example/a.mp4", "https://relay.example/a", { settings: balanced(), signals: strong() }), "https://cdn.example/a.mp4");
device.rememberFail("media", "https://cdn.example/a.mp4", 5000, "source");
assert.strictEqual(device.playbackUrl("https://cdn.example/a.mp4", "https://relay.example/a", { settings: balanced(), signals: strong(), now: 5000 }), "https://relay.example/a");
assert.strictEqual(device.playbackUrl("https://cdn.example/b.mp4", "https://relay.example/b", { settings: balanced(), signals: strong(), now: 5000 }), "https://cdn.example/b.mp4");
assert.strictEqual(device.playbackUrl("https://cdn.example/b.mp4", "https://relay.example/b", { preferRelay: true, settings: balanced() }), "https://relay.example/b");
assert.strictEqual(device.playbackUrl("https://cdn.example/a.mp4", "https://relay.example/a", { settings: device.applyLevel("light"), signals: strong(), now: 5000 }), "https://cdn.example/a.mp4");

device.reset();
device.noteStat("local", "search", 40, 12);
assert.strictEqual(device.loadStats().features.search.savedMs, 0);
device.noteStat("worker", "direct", 100, 200);
device.noteStat("local", "direct", 80, 40);
const directRow = device.loadStats().features.direct;
assert.strictEqual(directRow.local, 1);
assert.strictEqual(directRow.worker, 1);
assert.strictEqual(directRow.savedBytes, 80);
assert.strictEqual(directRow.savedMs, 160);
const sum = device.totals();
assert.strictEqual(sum.savedBytes, 120);
assert.ok(sum.savedMs >= 160);

assert.strictEqual(device.scopeOf(new Error("cors")), "source");
assert.strictEqual(device.scopeOf(new Error("timeout")), "source");
assert.strictEqual(device.scopeOf(new Error("empty")), "source");
assert.strictEqual(device.scopeOf(new Error("unsupported")), "feature");
assert.strictEqual(device.scopeOf(new Error("QuotaExceededError")), "feature");

assert.strictEqual(direct.readOnlyHost(new URL("https://www.reddit.com/r/news.json")), true);
assert.strictEqual(direct.readOnlyHost(new URL("https://old.reddit.com/r/news/comments/abc.json")), true);
assert.strictEqual(direct.readOnlyHost(new URL("https://www.reddit.com/r/news")), false);
assert.strictEqual(direct.readOnlyHost(new URL("https://discord.com/api/guilds/123/widget.json")), true);
assert.strictEqual(direct.readOnlyHost(new URL("https://discord.com/api/channels/1")), false);
assert.strictEqual(direct.readOnlyHost(new URL("https://api.vk.com/method/wall.get")), true);
assert.strictEqual(direct.readOnlyHost(new URL("https://api.vk.com/method/wall.post")), false);
assert.strictEqual(direct.allows("https://accounts.example.workers.dev/v1/data/feeds.json"), false);
direct.reset();
assert.strictEqual(direct.paceWait("www.reddit.com", 1000), 0);
direct.markPace("www.reddit.com", 1000);
assert.strictEqual(direct.paceWait("www.reddit.com", 1500), 1500);
direct.reset();

const posts = [
  { id: "1", text: "hello reader", title: "note", author: "ada", handle: "reader" },
  { id: "2", text: "other", title: "", author: "sam", handle: "sam" }
];
const found = search.query("reader", {
  posts: posts,
  feeds: [{ name: "Reader", handle: "reader", bio: "" }],
  hidden: function (post) { return post.id === "2"; },
  mute: function () { return false }
});
assert.strictEqual(found.complete, true);
assert.strictEqual(found.hits.posts.length, 1);
assert.strictEqual(found.hits.posts[0].id, "1");
assert.strictEqual(found.hits.accounts.length, 1);
const at = search.query("@reader", {
  posts: posts,
  feeds: [{ name: "Reader", handle: "reader", bio: "" }]
});
assert.strictEqual(at.hits.accounts.length, 1);
assert.strictEqual(at.hits.accounts[0].handle, "reader");
assert.strictEqual(at.hits.posts.length, 1);
assert.strictEqual(search.query("@", { posts: posts, feeds: [{ name: "Reader", handle: "reader" }] }).hits.accounts.length, 0);
assert.strictEqual(search.query("missing", { posts: posts }).hits.posts.length, 0);
search.reset();
assert.strictEqual(search.query("reader", { posts: [] }).complete, false);

const env = {
  prompt: function () { return "prompt"; },
  webllm: function () { return "web"; },
  cloud: function () { return "cloud"; }
};
assert.deepStrictEqual(ai.order(maxAccepted, strong(), env, device), ["prompt", "webllm", "cloud"]);
assert.deepStrictEqual(ai.order(balanced(), strong(), env, device), ["prompt", "cloud"]);
assert.deepStrictEqual(ai.order(device.applyLevel("light"), strong(), env, device), ["cloud"]);

const calls = { n: 0 };
const file = { name: "clip.webm", size: 8, type: "video/webm" };
assert.strictEqual(record.originalFile(file), file);
assert.deepStrictEqual(record.segmentPlan("light"), { local: false, timeslice: 0 });
assert.strictEqual(record.segmentPlan("balanced").timeslice, 4000);
assert.strictEqual(record.segmentPlan("max").timeslice, 2000);
assert.strictEqual(record.segmentPlan("balanced").local, true);

function opts(extra) {
  return Object.assign({ settings: balanced(), signals: strong(), timeout: 40 }, extra || {});
}

device.reset();
const chain = device.runLocal("direct", "cdn.example", function () {
  return Promise.reject(new Error("cors"));
}, function () {
  return { ok: true };
}, opts()).then(function (out) {
  assert.strictEqual(out.via, "worker");
  assert.strictEqual(out.error, false);
  assert.strictEqual(out.value.ok, true);
  return device.runLocal("direct", "cdn.example", function () {
    return { skipped: true };
  }, function () {
    return { ok: true };
  }, opts({ now: Date.now() }));
}).then(function (out) {
  assert.strictEqual(out.via, "worker");
  assert.strictEqual(out.value.skipped, undefined);
  const later = Date.now() + device.FAIL_TTL + 50;
  return device.runLocal("direct", "cdn.example", function () {
    return { again: true };
  }, function () {
    return { ok: false };
  }, opts({ now: later }));
}).then(function (out) {
  assert.strictEqual(out.via, "device");
  assert.strictEqual(out.value.again, true);
  device.reset();
  return device.runLocal("direct", "slow.example", function () {
    return new Promise(function () {});
  }, function () {
    return { ok: true };
  }, opts());
}).then(function (out) {
  assert.strictEqual(out.via, "worker");
  assert.strictEqual(out.error, false);
  device.reset();
  return device.runLocal("direct", "empty.example", function () {
    return "";
  }, function () {
    return { ok: true };
  }, opts());
}).then(function (out) {
  assert.strictEqual(out.via, "worker");
  assert.strictEqual(out.error, false);
  device.reset();
  return device.runLocal("direct", "bad.example", function () {
    return "nope";
  }, function () {
    return { ok: true };
  }, opts({ valid: function (value) { return value && typeof value === "object"; } }));
}).then(function (out) {
  assert.strictEqual(out.via, "worker");
  device.reset();
  return device.runLocal("translate", "chrome", function () {
    return Promise.reject(new Error("unsupported"));
  }, function () {
    return "server text";
  }, opts());
}).then(function (out) {
  assert.strictEqual(out.via, "worker");
  assert.strictEqual(device.cooling("translate"), true);
  return device.runLocal("translate", "other", function () {
    return "local text";
  }, function () {
    return "server text";
  }, opts());
}).then(function (out) {
  assert.strictEqual(out.via, "worker");
  assert.strictEqual(out.value, "server text");
  device.reset();
  return device.runLocal("direct", "one.example", function () {
    return Promise.reject(new Error("timeout"));
  }, function () {
    return { ok: 1 };
  }, opts());
}).then(function () {
  assert.strictEqual(device.cooling("direct"), false);
  assert.strictEqual(device.sourceState("one.example"), "fail");
  return device.runLocal("direct", "two.example", function () {
    return { ok: 2 };
  }, function () {
    return { ok: 0 };
  }, opts());
}).then(function (out) {
  assert.strictEqual(out.via, "device");
  assert.strictEqual(out.value.ok, 2);
  device.reset();
  return device.runLocal("direct", "gone.example", function () {
    return Promise.reject(new Error("cors"));
  }, function () {
    return Promise.reject(new Error("status"));
  }, opts());
}).then(function () {
  throw new Error("both paths should fail");
}, function (err) {
  assert.strictEqual(err.both, true);
  device.reset();
  let draws = 0;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const clip = { name: "clip", size: 4, type: "image/jpeg", lastModified: 1 };
  return media.thumbOf(clip, {
    draw: function () { draws += 1; return bytes; },
    settings: balanced(),
    signals: strong(),
    device: device
  }).then(function (out) {
    assert.strictEqual(out, bytes);
    return media.thumbOf(clip, {
      draw: function () { draws += 1; return bytes; },
      device: device
    });
  }).then(function (out) {
    assert.strictEqual(draws, 1);
    assert.strictEqual(out, bytes);
    return media.thumbOf({ name: "bad", size: 1, type: "image/png" }, {
      draw: function () { return Promise.reject(new Error("empty")); },
      settings: balanced(),
      signals: strong(),
      device: device
    });
  });
}).then(function (out) {
  assert.strictEqual(out, null);
  device.reset();
  return record.compressMeta({ title: "note" }, { device: device, settings: balanced(), signals: strong() });
}).then(function (packed) {
  assert.strictEqual(packed.encoding, "gzip");
  assert.strictEqual(packed.original.title, "note");
  return record.gunzip(packed.bytes).then(function (text) {
    assert.strictEqual(JSON.parse(text).title, "note");
    return record.compressMeta({ title: "note" }, {
      device: device,
      settings: balanced(),
      signals: strong(),
      gzip: function () { return Promise.reject(new Error("unsupported")); }
    });
  });
}).then(function (packed) {
  assert.strictEqual(packed.encoding, "identity");
  assert.strictEqual(packed.text, JSON.stringify({ title: "note" }));
  return record.noteUpload(file, { title: "note" }, { device: device, settings: balanced(), signals: strong() });
}).then(function (uploaded) {
  assert.strictEqual(uploaded.file, file);
  device.reset();
  search.reset();
  return search.answer("reader", {
    device: device,
    settings: balanced(),
    signals: strong(),
    local: { posts: [] },
    server: function () { return { hits: { posts: [{ id: "s" }], accounts: [] } }; }
  });
}).then(function (out) {
  assert.strictEqual(out.via, "worker");
  assert.strictEqual(out.error, false);
  assert.strictEqual(out.value.hits.posts[0].id, "s");
  device.reset();
  return search.answer("reader", {
    device: device,
    settings: balanced(),
    signals: strong(),
    local: { posts: posts },
    server: function () { return { hits: { posts: [], accounts: [] } }; }
  });
}).then(function (out) {
  assert.strictEqual(out.via, "device");
  assert.strictEqual(out.value.hits.posts[0].id, "1");
  device.reset();
  return ai.ask("hello", {
    device: device,
    settings: balanced(),
    signals: strong(),
    timeout: 40,
    env: {
      prompt: function () { return Promise.reject(new Error("unsupported")); },
      cloud: function () { return "from-cloud"; }
    }
  });
}).then(function (res) {
  assert.strictEqual(res.via, "cloud");
  assert.strictEqual(res.text, "from-cloud");
  assert.strictEqual(res.error, false);
  assert.strictEqual(device.cooling("ai"), false);
  assert.strictEqual(device.sourceState("prompt"), "fail");
  return ai.ask("hello", {
    device: device,
    settings: balanced(),
    signals: strong(),
    timeout: 40,
    env: {
      prompt: function () { return "should-skip"; },
      cloud: function () { return "still-cloud"; }
    }
  });
}).then(function (res) {
  assert.strictEqual(res.text, "still-cloud");
  device.reset();
  return ai.ask("hello", {
    device: device,
    settings: maxAccepted,
    signals: strong(),
    timeout: 30,
    env: {
      prompt: function () { return new Promise(function () {}); },
      webllm: function () { return ""; },
      cloud: function () { return Promise.reject(new Error("status")); }
    }
  });
}).then(function () {
  throw new Error("assistant should fail closed");
}, function (err) {
  assert.strictEqual(err.both, true);
device.reset();
direct.reset();
direct.setFetch(function (url) {
  calls.n += 1;
    if (String(url).indexOf("fxtwitter.com") >= 0) return Promise.reject(new Error("cors"));
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ via: "device" }); } });
  });
  global.window = { STATE: { settings: { devicePerf: balanced() } } };
  return direct.fetchSource("https://api.fxtwitter.com/reader", function () { return { via: "server" }; });
}).then(function (body) {
  assert.strictEqual(body.via, "server");
  assert.ok(calls.n >= 1);
  direct.reset();
  device.reset();
  calls.n = 0;
  return direct.fetchSource("https://api.invidious.io/instances.json", function () { return { via: "server" }; });
}).then(function (body) {
  assert.strictEqual(body.via, "device");
  const before = calls.n;
  return direct.fetchSource("https://api.invidious.io/instances.json", function () { throw new Error("server"); }).then(function (cached) {
    assert.strictEqual(cached.via, "device");
    assert.strictEqual(calls.n, before);
    direct.reset();
    device.reset();
    direct.setFetch(function () {
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(""); } });
    });
    return direct.fetchSource("https://public.api.bsky.app/xrpc/reader", function () { return { via: "server" }; });
  });
}).then(function (body) {
  assert.strictEqual(body.via, "server");
  direct.reset();
  device.reset();
  let blockedCalls = 0;
  direct.setFetch(function () { blockedCalls += 1; return Promise.reject(new Error("cors")); });
  return direct.fetchSource("https://accounts.example.workers.dev/v1/data/feeds.json", function () { return { via: "server" }; }).then(function (body) {
    assert.strictEqual(body.via, "server");
    assert.strictEqual(blockedCalls, 0);
    global.window = { STATE: { settings: { devicePerf: device.applyLevel("light") } } };
    direct.reset();
    device.reset();
    direct.setFetch(function () { throw new Error("should stay on the server"); });
    return direct.fetchSource("https://api.fxtwitter.com/reader", function () { return { via: "server", items: [1] }; });
  });
}).then(function (body) {
  assert.strictEqual(body.via, "server");
  assert.deepStrictEqual(body.items, [1]);
  delete global.window;
  direct.reset();
  device.reset();
  direct.holdDevice(true);
  let serverHits = 0;
  direct.setFetch(function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ via: "existing" }); } });
  });
  global.window = { STATE: { settings: { devicePerf: balanced() } } };
  return direct.fetchSource("https://api.fxtwitter.com/reader", function () {
    serverHits += 1;
    return { via: "wrapped" };
  }).then(function (first) {
    assert.strictEqual(first.via, "existing");
    assert.strictEqual(serverHits, 0);
    direct.holdDevice(false);
    direct.reset();
    device.reset();
    direct.setFetch(function () { return Promise.reject(new Error("cors")); });
    global.window = { STATE: { settings: { devicePerf: balanced() } } };
    return direct.fetchSource("https://api.fxtwitter.com/reader", function () { return { via: "server" }; });
  });
}).then(function (body) {
  assert.strictEqual(body.via, "server");
  delete global.window;
  console.log("device performance ok");
  // "Delete all data on this device", encryption at rest and expiry.
  require("child_process").execFileSync(process.execPath, [require("path").join(__dirname, "device_seal_test.js")], { stdio: "inherit" });
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
