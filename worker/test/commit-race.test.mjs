import assert from "node:assert/strict";
import test from "node:test";
import { DOC_KEY, INDEX_KEY, SHARD_PREFIX, commitUpdates, sweepIndex } from "../src/source-lists.js";

const LIST = "s0000000a";
const OLD_HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);

function docWith(sources) {
  return {
    v: 1,
    lists: [{ id: LIST, name: "Lane", sources: sources.slice(), members: ["100000000001"] }],
    sources: { "src-a": { id: "src-a" }, "src-b": { id: "src-b" } },
    requests: []
  };
}

function bucket(doc) {
  let docBody = JSON.stringify(doc);
  let indexBody = "";
  let indexEtag = "";
  let puts = 0;
  let nullsLeft = 0;
  let armOldRead = false;
  let release = null;
  let markWaiting = null;
  const waiting = new Promise((resolve) => { markWaiting = resolve; });
  const api = {
    puts: () => puts,
    waiting,
    setDoc(next) { docBody = JSON.stringify(next); },
    index() { return indexBody ? JSON.parse(indexBody) : null; },
    release() { if (release) release(); },
    forceNulls(count) { nullsLeft = count; },
    env: {
      DATA: {
        get: async (key) => {
          if (key === DOC_KEY && armOldRead) {
            armOldRead = false;
            markWaiting();
            await new Promise((resolve) => { release = resolve; });
          }
          if (key === DOC_KEY) return { etag: "doc", text: async () => docBody };
          if (key === INDEX_KEY && indexBody) return { etag: indexEtag, text: async () => indexBody };
          return null;
        },
        put: async (key, body, opts) => {
          if (key !== INDEX_KEY) return { etag: "other" };
          puts += 1;
          if (nullsLeft > 0) {
            nullsLeft -= 1;
            return null;
          }
          const onlyIf = (opts && opts.onlyIf) || {};
          if (onlyIf.etagMatches && onlyIf.etagMatches !== indexEtag) return null;
          if (onlyIf.etagDoesNotMatch === "*" && indexEtag) return null;
          const parsed = JSON.parse(body);
          if (parsed.lists && parsed.lists[LIST] && parsed.lists[LIST].hash === OLD_HASH) armOldRead = true;
          indexBody = body;
          indexEtag = "e" + puts;
          return { etag: indexEtag };
        }
      }
    }
  };
  return api;
}

test("commitUpdates retries when the conditional put returns null", async () => {
  const store = bucket(docWith(["src-a"]));
  store.forceNulls(1);
  const update = {
    id: LIST,
    expectMembers: ["100000000001"],
    expectSources: ["src-a"],
    entry: { hash: NEW_HASH, count: 1, at: 2, sources: ["src-a"], membersKey: "100000000001" }
  };
  assert.equal(await commitUpdates(store.env, [update]), true);
  assert.equal(store.puts(), 2);
  assert.equal(store.index().lists[LIST].hash, NEW_HASH);
  assert.deepEqual(store.index().lists[LIST].sources, ["src-a"]);
});

test("an older publish cleans up only its own row after a newer one commits", async () => {
  const store = bucket(docWith(["src-a", "src-b"]));
  const older = {
    id: LIST,
    expectMembers: ["100000000001"],
    expectSources: ["src-a", "src-b"],
    entry: { hash: OLD_HASH, count: 2, at: 1, sources: ["src-a", "src-b"], membersKey: "100000000001" }
  };
  const newer = {
    id: LIST,
    expectMembers: ["100000000001"],
    expectSources: ["src-a"],
    entry: { hash: NEW_HASH, count: 1, at: 2, sources: ["src-a"], membersKey: "100000000001" }
  };
  const pending = commitUpdates(store.env, [older]);
  await store.waiting;
  store.setDoc(docWith(["src-a"]));
  assert.equal(await commitUpdates(store.env, [newer]), true);
  assert.equal(store.index().lists[LIST].hash, NEW_HASH);
  store.release();
  assert.equal(await pending, false);
  assert.equal(store.index().lists[LIST].hash, NEW_HASH);
  assert.deepEqual(store.index().lists[LIST].sources, ["src-a"]);
  assert.equal(store.index().lists[LIST].sources.includes("src-b"), false);
});

function sweepStore(doc, index, shard) {
  let docBody = JSON.stringify(doc);
  let indexBody = JSON.stringify(index);
  let indexEtag = "index-1";
  let release = null;
  let markWaiting = null;
  const waiting = new Promise((resolve) => { markWaiting = resolve; });
  let paused = false;
  return {
    waiting,
    setDoc(next) { docBody = JSON.stringify(next); },
    setIndex(next) { indexBody = JSON.stringify(next); indexEtag = "index-new"; },
    index() { return JSON.parse(indexBody); },
    release() { if (release) release(); },
    env: {
      DATA: {
        get: async (key) => {
          if (key === SHARD_PREFIX + OLD_HASH + ".json" && !paused) {
            paused = true;
            markWaiting();
            await new Promise((resolve) => { release = resolve; });
          }
          if (key === DOC_KEY) return { etag: "doc", text: async () => docBody };
          if (key === INDEX_KEY) return { etag: indexEtag, text: async () => indexBody };
          if (key === SHARD_PREFIX + OLD_HASH + ".json") return { etag: "shard", text: async () => shard };
          return null;
        },
        put: async (key, body, opts) => {
          if (key !== INDEX_KEY) return { etag: "other" };
          const onlyIf = (opts && opts.onlyIf) || {};
          if (onlyIf.etagMatches && onlyIf.etagMatches !== indexEtag) return null;
          if (onlyIf.etagDoesNotMatch === "*" && indexEtag) return null;
          indexBody = body;
          indexEtag = "index-put";
          return { etag: indexEtag };
        }
      }
    }
  };
}

test("a sweep waiting on a shard keeps the newer publication", async () => {
  const legacy = { hash: OLD_HASH, size: 10, count: 2, at: 1 };
  const shard = JSON.stringify({ feeds: [{ id: "src-a" }, { id: "src-b" }], posts: [] });
  const store = sweepStore(docWith(["src-a", "src-b"]), { v: 1, lists: { [LIST]: legacy } }, shard);
  const pending = sweepIndex(store.env);
  await store.waiting;
  const newer = { hash: NEW_HASH, count: 1, at: 2, sources: ["src-a"], membersKey: "100000000001" };
  store.setDoc(docWith(["src-a"]));
  store.setIndex({ v: 1, lists: { [LIST]: newer } });
  store.release();
  await pending;
  assert.equal(store.index().lists[LIST].hash, NEW_HASH);
  assert.deepEqual(store.index().lists[LIST].sources, ["src-a"]);
});

test("a sweep that loses its conditional put keeps the publication that now matches", async () => {
  const newer = { hash: NEW_HASH, count: 1, at: 2, sources: ["src-a"], membersKey: "100000000001" };
  let docBody = JSON.stringify(docWith(["src-a", "src-b"]));
  let indexBody = JSON.stringify({ v: 1, lists: { [LIST]: newer } });
  let indexEtag = "index-1";
  let nulls = 1;
  const env = {
    DATA: {
      get: async (key) => {
        if (key === DOC_KEY) return { etag: "doc", text: async () => docBody };
        if (key === INDEX_KEY) return { etag: indexEtag, text: async () => indexBody };
        return null;
      },
      put: async (key, body, opts) => {
        if (key !== INDEX_KEY) return { etag: "other" };
        const onlyIf = (opts && opts.onlyIf) || {};
        if (nulls > 0) {
          nulls -= 1;
          docBody = JSON.stringify(docWith(["src-a"]));
          return null;
        }
        if (onlyIf.etagMatches && onlyIf.etagMatches !== indexEtag) return null;
        indexBody = body;
        indexEtag = "index-2";
        return { etag: indexEtag };
      }
    }
  };
  await sweepIndex(env);
  const stored = JSON.parse(indexBody);
  assert.equal(stored.lists[LIST].hash, NEW_HASH);
  assert.deepEqual(stored.lists[LIST].sources, ["src-a"]);
  assert.equal(nulls, 0);
});
