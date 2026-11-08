import assert from "node:assert/strict";
import test from "node:test";
import { isExactPublication, putJsonIfMatch, readBounded } from "../src/list-commit.js";

test("a conditional put that returns null is not a success", async () => {
  let calls = 0;
  const bucket = {
    put: async () => {
      calls += 1;
      return null;
    }
  };
  assert.equal(await putJsonIfMatch(bucket, "owner/lists/index.json", { v: 1 }, "etag-1"), false);
  assert.equal(calls, 1);
});

test("a thrown precondition is not a success", async () => {
  const bucket = {
    put: async () => {
      const err = new Error("precondition failed");
      err.name = "PreconditionFailed";
      throw err;
    }
  };
  assert.equal(await putJsonIfMatch(bucket, "owner/lists/index.json", { v: 1 }, "etag-1"), false);
});

test("a null conditional put is retried until a later write stores", async () => {
  let calls = 0;
  const bucket = {
    put: async () => {
      calls += 1;
      if (calls < 3) return null;
      return { etag: "ok" };
    }
  };
  let wrote = false;
  for (let attempt = 0; attempt < 5 && !wrote; attempt++) {
    wrote = await putJsonIfMatch(bucket, "owner/lists/index.json", { v: attempt }, "etag-1");
  }
  assert.equal(wrote, true);
  assert.equal(calls, 3);
});

test("a stored object is a success", async () => {
  const bucket = { put: async () => ({ etag: "next" }) };
  assert.equal(await putJsonIfMatch(bucket, "owner/lists/index.json", { v: 1 }, ""), true);
});

test("cleanup does not roll back over a newer publication", () => {
  const older = { hash: "a".repeat(64), membersKey: "111", sources: ["src-a", "src-b"] };
  const newer = { hash: "b".repeat(64), membersKey: "111", sources: ["src-a"] };
  const update = { expectMembers: ["111"], expectSources: ["src-a", "src-b"], entry: older };
  assert.equal(isExactPublication(newer, update), false);
  assert.equal(isExactPublication(older, update), true);
});

test("a bounded read cancels the body after the cap", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1000);
  chunk.fill(65);
  let sent = 0;
  const res = {
    body: {
      getReader: () => ({
        read: async () => {
          if (cancelled || sent >= 5000) return { done: true, value: undefined };
          sent += 1000;
          return { done: false, value: chunk };
        },
        cancel: async () => { cancelled = true; }
      })
    }
  };
  const text = await readBounded(res, 2500);
  assert.equal(text.length, 2500);
  assert.equal(cancelled, true);
  assert.ok(sent <= 3000);
});
