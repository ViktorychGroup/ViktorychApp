/* A visible page paints a pushed like, follow, reply or mention without
   waiting for the notifications poll. The payload was already checked
   on the server. */
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
  "function signedAccount() { return { handle: 'user_a', publicId: '100000000001' }; }\n" +
  grab("pushNoteItem") + "\nthis.pushNoteItem = pushNoteItem;",
  sandbox
);
const { pushNoteItem } = sandbox;

const like = pushNoteItem({ id: "a".repeat(16), kind: "like", at: 5, body: "hello", hash: "#/", handle: "ada", titleVars: { name: "Ada" } });
assert.equal(like.kind, "like");
assert.equal(like.text, "hello");
assert.equal(like.name, "Ada");
assert.equal(pushNoteItem({ id: "b".repeat(16), titleKey: "{name} followed you", titleVars: { name: "Bea", handle: "bea" } }).kind, "follow");
assert.equal(pushNoteItem({ id: "c".repeat(16), titleKey: "{name} replied to you" }).kind, "reply");
assert.equal(pushNoteItem({ id: "d".repeat(16), titleKey: "{name} mentioned you" }).kind, "mention");
assert.equal(pushNoteItem({ titleKey: "{name} liked your post" }), null);
assert.equal(pushNoteItem({ id: "e".repeat(16), titleKey: "Discord alert" }), null);
assert.equal(pushNoteItem({ id: "f".repeat(16), kind: "follow", handle: "user_a" }), null);

const handler = src.slice(src.indexOf('if (data.type === "push-note")'), src.indexOf('if (data.type === "note-open")'));
assert.match(handler, /pushNoteItem\(data\.note\)/);
assert.match(handler, /commitBellNotes\(\[note\], false\)/);
assert.match(handler, /!channelOpen\(\)/);
