const assert = require("assert");
const fs = require("fs");
const path = require("path");

const storage = require("../storage.js");
const native = require("../native.js");
const codec = require("../codec.js");
const opfs = require("../media-opfs.js");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

assert.strictEqual(storage.pressureLevel(0, 0), "unknown");
assert.strictEqual(storage.pressureLevel(10, 0), "unknown");
assert.strictEqual(storage.pressureLevel(74, 100), "ok");
assert.strictEqual(storage.pressureLevel(75, 100), "warning");
assert.strictEqual(storage.pressureLevel(89, 100), "warning");
assert.strictEqual(storage.pressureLevel(90, 100), "critical");
assert.strictEqual(storage.pressureLevel(100, 100), "critical");

assert.strictEqual(native.shouldOfferInstall({ standalone: true, prompt: true }), false);
assert.strictEqual(native.shouldOfferInstall({ dismissed: true, prompt: true }), false);
assert.strictEqual(native.shouldOfferInstall({ installed: true, prompt: true }), false);
assert.strictEqual(native.shouldOfferInstall({ prompt: true }), true);
assert.strictEqual(native.shouldOfferInstall({ ios: true, engaged: true }), true);
assert.strictEqual(native.shouldOfferInstall({ ios: true }), false);
assert.strictEqual(native.shouldOfferInstall({}), false);
assert.strictEqual(native.shouldOfferInstall({ afterSignup: true }), true);
assert.strictEqual(native.shouldOfferInstall({ afterSignup: true, dismissed: "never" }), false);
assert.strictEqual(native.shouldOfferInstall({ dismissed: "later", dismissedAt: 1_000, now: 2_000, laterMs: 5_000, prompt: true }), false);
assert.strictEqual(native.shouldOfferInstall({ dismissed: "later", dismissedAt: 1_000, now: 9_000, laterMs: 5_000 }), true);
assert.strictEqual(native.installKind("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Version/16.0 Mobile Safari/604.1"), "ios-safari");
assert.strictEqual(native.installKind("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) CriOS/120.0.0.0 Mobile Safari/604.1"), "ios-browser");
assert.strictEqual(native.installKind("Mozilla/5.0 (Linux; Android 13) Chrome/120.0.0.0 Mobile Safari/537.36"), "native");
assert.strictEqual(native.installKind("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 Safari/537.36"), "native");
assert.strictEqual(native.installKind("Mozilla/5.0 (Windows NT 10.0) Edg/120.0.0.0 Safari/537.36"), "native");
assert.strictEqual(native.installKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Firefox/121.0"), "hint");
assert.strictEqual(native.installKind("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/17.0 Safari/605.1.15"), "hint");
assert.strictEqual(native.installArrow("ios-safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Safari/604.1"), "down");
assert.strictEqual(native.installArrow("ios-safari", "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) Safari/604.1"), "up");
assert.strictEqual(native.installArrow("hint", "Firefox"), "");

assert.strictEqual(native.shouldAskPersist({ standalone: true }), false);
assert.strictEqual(native.shouldAskPersist({ api: true }), false);
assert.strictEqual(native.shouldAskPersist({ api: true, standalone: true }), true);
assert.strictEqual(native.shouldAskPersist({ api: true, installed: true }), true);
assert.strictEqual(native.shouldAskPersist({ api: true, engaged: true }), true);

assert.strictEqual(native.protocolHash("web+viktorych:notifications"), "#/notifications");
assert.strictEqual(native.protocolHash(""), "#/home");
assert.strictEqual(native.protocolHash("#/music"), "#/music");
assert.strictEqual(native.protocolHash("?post=1"), "#/home?post=1");

assert.strictEqual(native.outboxAction({ type: "like" }), true);
assert.strictEqual(native.outboxAction({ type: "repost" }), true);
assert.strictEqual(native.outboxAction({ type: "dm" }), true);
assert.strictEqual(native.outboxAction({ type: "nope" }), false);
assert.strictEqual(native.outboxAction(null), false);

assert.strictEqual(opfs.supported(), false);
assert.strictEqual(typeof codec.supported(), "boolean");

const manifest = JSON.parse(read("manifest.webmanifest"));
assert.strictEqual(manifest.id, "./");
assert.strictEqual(manifest.scope, "./");
const launchMode = manifest.launch_handler.client_mode;
assert.ok(launchMode === "focus-existing" || (Array.isArray(launchMode) && launchMode[0] === "focus-existing"));
assert.ok(manifest.file_handlers.some((row) => row.accept && row.accept["image/*"] && row.accept["video/*"]));
assert.ok(manifest.protocol_handlers.some((row) => row.protocol === "web+viktorych"));
assert.strictEqual(manifest.share_target.method, "POST");
assert.strictEqual(manifest.share_target.enctype, "multipart/form-data");
assert.ok(manifest.share_target.params.files.some((row) => row.name === "media"));
assert.ok(!(manifest.related_applications || []).length, "main app has no Play related_applications");
assert.ok((manifest.screenshots || []).filter((row) => row.form_factor === "narrow").length >= 2);
assert.ok((manifest.screenshots || []).filter((row) => row.form_factor === "wide").length >= 1);
assert.deepStrictEqual(manifest.shortcuts.slice(0, 4).map((row) => row.name), ["Home", "Notifications", "Inbox", "Post"]);

const worker = read("sw.js");
assert.ok(worker.includes("navigationPreload"));
assert.ok(worker.includes('event.tag === "notifications"'));
assert.ok(worker.includes('event.tag === "outbox"'));
assert.ok(worker.includes("./offline.html"));
assert.ok(worker.includes("x-shell-sha256"));
assert.ok(worker.includes("x-vapp-gzip"));
assert.ok(worker.includes('tag: "note-" + id'));

const app = read("app.js");
assert.ok(app.includes('fetchpriority="low"'));
assert.ok(app.includes("feed-worker.js"));
assert.ok(app.includes('tag: "note-" + note.id'));
assert.ok(read("index.html").includes('src="native.js"'));
assert.ok(read("update.js").includes('tr("Update now")'));
assert.ok(read("styles.css").includes("content-visibility: auto"));

(async () => {
  const asked = await storage.askPersist();
  assert.strictEqual(asked, false);
  assert.ok(storage.persistText(false).includes("Persistent storage"));

  const yielded = native.yieldThread();
  assert.ok(yielded && typeof yielded.then === "function");
  await yielded;

  const shared = await native.shareOut({ title: "ViktorychApp", url: "https://example.test/" });
  assert.strictEqual(shared, false);

  const { orderFeedDoc } = await import("../feed-worker.js");
  const ordered = orderFeedDoc({
    posts: [
      { platform: "x", id: "old", statusId: "old", date: "2020-01-01T00:00:00Z" },
      { platform: "x", id: "new", statusId: "new", date: "2024-06-01T00:00:00Z" },
      { platform: "x", id: "dup", statusId: "new", date: "2024-06-01T00:00:00Z" },
      null
    ]
  });
  assert.deepStrictEqual(ordered.posts.map((post) => post.id), ["new", "old"]);
  assert.strictEqual(orderFeedDoc(null), null);
  assert.deepStrictEqual(orderFeedDoc({ posts: "nope" }), { posts: "nope" });

  if (codec.supported()) {
    const raw = new TextEncoder().encode('{"posts":[1,2,3],"note":"cached feed"}');
    const packed = await codec.gzip(raw);
    assert.ok(packed && packed.length > 0);
    const back = await codec.gunzip(packed);
    assert.deepStrictEqual(Buffer.from(back), Buffer.from(raw));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
