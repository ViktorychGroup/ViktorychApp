/* A posts event is decided per post id. Another post still held in ownSent
   must not hide a card from another device, and must not skip the refresh. */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function grab(name) {
  const key = "function " + name + "(";
  const start = src.indexOf(key);
  if (start < 0) throw new Error("missing " + name);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unclosed " + name);
}

const sandbox = {};
vm.runInNewContext(
  grab("pendingTmpFor") + "\n" + grab("authorPostsEvent") + "\n" +
  "this.pendingTmpFor = pendingTmpFor; this.authorPostsEvent = authorPostsEvent;",
  sandbox
);
const { authorPostsEvent, pendingTmpFor } = sandbox;

const mine = "a".repeat(32);
const other = "b".repeat(32);
const self = "100000000001";
const held = { [mine]: { post: { id: mine, body: "kept", authorId: self }, at: 1 } };
const card = (id, body, author) => ({ op: "event", topic: "posts", data: { post: { id: id, body: body || "from the other device", parentId: "", authorId: author || self } } });
const onScreen = (id) => id === "shown";

assert.equal(authorPostsEvent(held, card(other), onScreen, self), "apply");
assert.equal(authorPostsEvent(held, card(mine), onScreen, self), "skip");
assert.equal(authorPostsEvent({}, card("shown"), onScreen, self), "skip");
assert.equal(authorPostsEvent(held, card("shown"), onScreen, self), "skip");
assert.equal(authorPostsEvent(held, { op: "event", topic: "posts", data: { id: mine, at: 2 } }, onScreen, self), "refresh");
assert.equal(authorPostsEvent({}, card(other), () => false, self), "apply");

const tempId = "tmp-race";
const serverId = "c".repeat(32);
const pending = { [tempId]: { post: { id: tempId, body: "Race post", parentId: "", authorId: self }, at: 1 } };
assert.equal(pendingTmpFor(pending, { id: serverId, body: "Race post", parentId: "" }), tempId);
assert.equal(authorPostsEvent(pending, card(serverId, "Race post"), () => false, self), "bind");
assert.equal(authorPostsEvent(pending, card(other, "Other phone"), () => false, self), "apply");
assert.equal(authorPostsEvent(pending, card(serverId, "Race post", "100000000009"), () => false, self), "apply");
assert.equal(authorPostsEvent(pending, { data: { at: 2 } }, () => false, self), "refresh");
const bound = Object.assign({}, pending, { [serverId]: { post: { id: serverId }, at: 2 } });
assert.equal(authorPostsEvent(bound, card(serverId, "Race post"), () => false, self), "skip");

const start = src.indexOf('if (msg.op === "event" && msg.topic === "posts")');
const end = src.indexOf("var postsLiveTimer", start);
const handler = src.slice(start, end);
assert.ok(handler.includes("authorPostsEvent(ownSent, msg, publicCardPresent, mine && mine.publicId)"));
assert.equal(handler.includes("Object.keys(ownSent)"), false);
assert.ok(handler.includes('if (step === "skip") return;'));
assert.ok(handler.includes('step === "bind"'));
assert.ok(handler.includes("adoptEarlySend(incoming)"));
assert.ok(handler.includes("applyAuthorPost(incoming)"));
assert.ok(handler.indexOf("refreshAppPosts") > handler.indexOf('step === "apply"'));
