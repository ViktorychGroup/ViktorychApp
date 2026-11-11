import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = fs.readFileSync(new URL("../shared/home-live.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(source, { window: window, globalThis: window });
const allowed = window.ViktorychHomeLive.allowed;

const me = { publicId: "100000000001" };
const post = { id: "a".repeat(32), authorId: "200000000002", authorName: "Public" };

test("a live post is kept only for the signed-in account's current follows", () => {
  assert.equal(allowed(me, ["app:200000000002"], post), true);
  assert.equal(allowed(me, [], post), false);
  assert.equal(allowed(me, ["app:300000000003"], post), false);
  assert.equal(allowed(null, ["app:200000000002"], post), false);
  assert.equal(allowed({ publicId: "200000000002" }, ["app:200000000002"], post), false);
});

test("a channel open re-arms the posts watch before the handler returns", () => {
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = app.indexOf('if (msg.op === "state")');
  const ret = app.indexOf("return;", start);
  const open = app.slice(start, ret);
  assert.match(open, /msg\.open/);
  assert.match(open, /scheduleHomeWatch\(\)/);
  assert.equal(app.includes('if (msg.op === "state" && msg.open) scheduleHomeWatch()'), false);
});

test("switching the session drops the previous account's allowance", () => {
  const first = allowed(me, ["app:200000000002"], post);
  const next = allowed({ publicId: "300000000003" }, [], post);
  assert.equal(first, true);
  assert.equal(next, false);
  const presence = fs.readFileSync(new URL("../presence.js", import.meta.url), "utf8");
  assert.match(presence, /viktorych-session/);
  assert.match(presence, /topic === "posts"/);
  assert.match(presence, /socketOwner !== selfId\(\)/);
});
