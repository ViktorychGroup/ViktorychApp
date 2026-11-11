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
vm.runInNewContext(grab("authorPostsEvent") + "\nthis.authorPostsEvent = authorPostsEvent;", sandbox);
const { authorPostsEvent } = sandbox;

const mine = "a".repeat(32);
const other = "b".repeat(32);
const held = { [mine]: { post: { id: mine }, at: 1 } };
const card = (id) => ({ op: "event", topic: "posts", data: { post: { id: id, body: "from the other device" } } });
const onScreen = (id) => id === "shown";

assert.equal(authorPostsEvent(held, card(other), onScreen), "apply");
assert.equal(authorPostsEvent(held, card(mine), onScreen), "skip");
assert.equal(authorPostsEvent({}, card("shown"), onScreen), "skip");
assert.equal(authorPostsEvent(held, card("shown"), onScreen), "skip");
assert.equal(authorPostsEvent(held, { op: "event", topic: "posts", data: { id: mine, at: 2 } }, onScreen), "refresh");
assert.equal(authorPostsEvent({}, card(other), () => false), "apply");

const start = src.indexOf('if (msg.op === "event" && msg.topic === "posts")');
const end = src.indexOf("var postsLiveTimer", start);
const handler = src.slice(start, end);
assert.ok(handler.includes("authorPostsEvent(ownSent, msg, publicCardPresent)"));
assert.equal(handler.includes("Object.keys(ownSent)"), false);
assert.ok(handler.includes('if (step === "skip") return;'));
assert.ok(handler.includes("applyAuthorPost(incoming)"));
assert.ok(handler.indexOf("refreshAppPosts") > handler.indexOf('step === "apply"'));
