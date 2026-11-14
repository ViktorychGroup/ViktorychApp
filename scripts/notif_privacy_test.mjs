// Notification privacy: compact pushes carry no names, and the device
// rebuilds the text only when the person allows it.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { compactPush } from "../worker/src/notifications.js";

const require = createRequire(import.meta.url);
const NP = require("../notif-privacy.js");

const item = {
  id: "like:post:1234567890123456789", kind: "like", others: 3, name: "Sample Person", handle: "sampleperson",
  text: "a reply that should never ride in a push", hash: "#/sampleperson/status/1234567890123456789",
  avatar: "https://cdn.example/avatar/abcdef0123456789.jpg", platform: "app", feedId: ""
};

test("compact push has no names, handles, text, links or icons", async () => {
  const payload = await compactPush(item, "100000000001");
  const raw = JSON.stringify(payload);
  assert.deepEqual(Object.keys(payload).sort(), ["i", "k", "n", "to", "v"]);
  assert.equal(payload.to, "100000000001");
  for (const bad of ["Sample", "sampleperson", "reply", "cdn.example", "status", "post:"]) assert.equal(raw.includes(bad), false, bad);
  assert.ok(raw.length <= 80, "compact payload is " + raw.length + " bytes");
  const legacy = JSON.stringify({
    titleKey: "{name} and {n} others liked your post", titleVars: { name: item.name, handle: item.handle, n: "3" },
    body: item.text, hash: item.hash, id: item.id, icon: item.avatar, tag: "note-" + item.id, platform: item.platform, handle: item.handle, feedId: ""
  });
  console.log("push payload bytes: legacy " + legacy.length + ", compact " + raw.length);
});

test("device and Worker compute the same short id", async () => {
  const payload = await compactPush(item, "100000000001");
  assert.equal(await NP.shortId(item.id), payload.i);
  const parsed = NP.parsePush(payload);
  assert.equal(parsed.kind, "like");
  assert.equal(parsed.count, 3);
  assert.equal(parsed.to, "100000000001");
  assert.equal(NP.forAccount(payload, "100000000001"), true);
  assert.equal(NP.forAccount(payload, "100000000002"), false);
  assert.equal(NP.forAccount({ v: 2, k: "like" }, "100000000001"), false);
  assert.equal(NP.parsePush({ titleKey: "x" }), null);
});

test("hidden names show generic copy only", () => {
  const off = NP.normalize({ names: false });
  const shown = NP.present(item, off, {});
  assert.equal(shown.generic, true);
  assert.equal(shown.body, "New like");
  assert.equal(shown.icon, "icons/icon-192.png");
  assert.equal(shown.hash, "#/notifications");
  assert.equal(JSON.stringify(shown).includes("Sample"), false);
  const dm = NP.present({ kind: "dm", name: "Sample Person", text: "secret" }, { names: true, preview: false }, {});
  assert.equal(dm.title, "Sample Person sent you a message");
  assert.equal(dm.body, "New message");
  const typeOff = NP.present({ kind: "dm", name: "Sample Person", text: "secret" }, { types: { messages: false } }, {});
  assert.equal(typeOff.generic, true);
  const full = NP.present({ kind: "reply", name: "Sample Person", text: "hi" }, {}, {});
  assert.equal(full.body, "hi");
  assert.equal(NP.present(null, {}, { kind: "dm" }).body, "New message");
});

test("banner, badge and title counts follow the choices", () => {
  assert.equal(NP.bannerText({ kind: "reply", text: "hi", name: "A" }, { banner: false }), "New reply");
  assert.equal(NP.bannerText({ kind: "reply", text: "hi", name: "A" }, {}), "hi");
  assert.equal(NP.badgeCount(5, { badge: false }), 0);
  assert.equal(NP.titleCount(5, {}), 5);
  assert.equal(NP.toggle({}, "type:likes").types.likes, false);
  assert.equal(NP.toggle({}, "names").names, false);
  assert.equal(NP.toggle({}, "bogus").names, true);
});
