// Client side of source lists: merge only assigned shards, verify hashes,
// prefer peers, and never fetch shards for accounts without lists.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";

const SRC = fs.readFileSync(new URL("../source-lists.js", import.meta.url), "utf8");
const sha = (text) => createHash("sha256").update(text).digest("hex");

function setup(opts) {
  const store = new Map();
  const calls = [];
  const shard = JSON.stringify({ feeds: [{ id: "rss:feeds.example", name: "Example", handle: "feeds.example" }], posts: [{ id: "p1", feedId: "rss:feeds.example", platform: "rss", quoted: { id: "q1", handle: "quotedmaple" } }] });
  const hash = sha(shard);
  const lists = opts.lists === false ? [] : (opts.lists || [{ id: "sa1b2c3d4", name: "Extra", hash, size: shard.length, at: 1, count: 1, status: "ready" }]);
  const body = opts.badShard ? shard + " " : shard;
  const who = opts.who || { id: "membermaple" };
  const session = opts.session || { gen: 1 };
  const window = {
    ViktorychAccounts: {
      account: () => (who.id ? { publicId: who.id } : null),
      sessionGeneration: () => session.gen
    },
    ViktorychPool: opts.pool ? {
      getBlob: async (h) => { calls.push("pool:" + h.slice(0, 6)); return h === hash ? new TextEncoder().encode(shard) : null; },
      putBlob: async () => { calls.push("offer"); return hash; }
    } : undefined
  };
  const ctx = {
    window, document: { addEventListener() {}, visibilityState: "hidden", querySelector: () => null },
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    navigator: { onLine: true }, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, Promise, JSON, Date, Set, Math, Array, Object, String, Number,
    setTimeout: () => 0, setInterval: () => 0,
    fetch: async (url) => {
      calls.push(url.replace("https://api.example", ""));
      if (url.indexOf("/shard/") >= 0) {
        if (opts.shardHold) await opts.shardHold;
      } else if (opts.hold) await opts.hold;
      if (url.indexOf("/v1/me/source-lists") >= 0 && url.indexOf("/shard/") < 0) {
        const wrongAccount = opts.only && opts.who && opts.who.id !== opts.only;
        const wrongSession = opts.sessionOnly && opts.session && opts.session.gen !== opts.sessionOnly;
        const listsFor = wrongAccount || wrongSession ? [] : lists;
        return { ok: true, status: 200, json: async () => ({ lists: listsFor }) };
      }
      if (url.includes("/shard/")) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer };
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  let changed = 0;
  const SL = window.SourceLists;
  SL.attach({ accountsApi: () => "https://api.example", accountToken: () => "t", signedOwner: () => false, STATE: { settings: {} }, onChange: () => { changed += 1; } });
  return { SL, calls, hash, store, who, session, changed: () => changed };
}

const base = () => ({ feeds: [{ id: "x:globalpine" }], posts: [{ id: "g1", feedId: "x:globalpine", platform: "x" }] });

test("member gets the shard from the Worker and it merges with quotes inside", async () => {
  const t = setup({});
  assert.equal(await t.SL.refresh(true), true);
  assert.ok(t.calls.some((c) => c.includes("/shard/" + t.hash)));
  const doc = t.SL.merge(base());
  assert.equal(doc.posts.length, 2);
  assert.equal(doc.posts[1].quoted.handle, "quotedmaple");
  assert.equal(doc.feeds.length, 2);
  assert.ok(!doc.feeds.some((f) => /quotedmaple/.test(f.id)));
  assert.equal(t.changed(), 1);
  assert.ok(t.store.size > 0);
  for (const key of t.store.keys()) assert.ok(key.includes("private-list"), key);
  const again = t.SL.merge(doc);
  assert.equal(again.posts.length, 2);
});

test("peers are tried first and a Worker copy is offered back", async () => {
  const t = setup({ pool: true });
  await t.SL.refresh(true);
  assert.ok(t.calls.includes("pool:" + t.hash.slice(0, 6)));
  assert.ok(!t.calls.some((c) => c.includes("/shard/")));
  assert.equal(t.SL.merge(base()).posts.length, 2);
});

test("a shard that fails its hash is dropped", async () => {
  const t = setup({ badShard: true });
  await t.SL.refresh(true);
  assert.equal(t.SL.merge(base()).posts.length, 1);
});

test("a list that arrives after the account changed is not kept", async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const who = { id: "100000000001" };
  const t = setup({ hold, who, only: "100000000001" });
  const pending = t.SL.refresh(true);
  for (let i = 0; i < 20 && !t.calls.length; i++) await new Promise((resolve) => setImmediate(resolve));
  who.id = "100000000002";
  release();
  assert.equal(await pending, false);
  assert.equal(t.SL.merge(base()).posts.length, 1);
  assert.equal(t.SL._mem.meta, null);
});

test("a shard that finishes after the account changed is not saved for the new account", async () => {
  let release;
  const shardHold = new Promise((resolve) => { release = resolve; });
  const who = { id: "100000000001" };
  const t = setup({ shardHold, who, only: "100000000001" });
  const pending = t.SL.refresh(true);
  for (let i = 0; i < 30 && !t.calls.some((item) => item.includes("/shard/")); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(t.calls.some((item) => item.includes("/shard/")), "the shard request started");
  who.id = "100000000002";
  release();
  assert.equal(await pending, false);
  assert.equal(t.SL.merge(base()).posts.length, 1);
  for (const [key, value] of t.store.entries()) {
    if (String(key).indexOf("100000000002") >= 0) assert.equal(String(value).indexOf("quotedmaple") >= 0, false, key);
  }
});

test("signing in again does not keep a shard from the previous session", async () => {
  let release;
  const shardHold = new Promise((resolve) => { release = resolve; });
  const who = { id: "100000000001" };
  const session = { gen: 1 };
  const t = setup({ shardHold, who, session, only: "100000000001", sessionOnly: 1 });
  const pending = t.SL.refresh(true);
  for (let i = 0; i < 30 && !t.calls.some((item) => item.includes("/shard/")); i++) await new Promise((resolve) => setImmediate(resolve));
  who.id = "100000000002";
  session.gen = 2;
  who.id = "";
  session.gen = 3;
  who.id = "100000000001";
  session.gen = 4;
  release();
  assert.equal(await pending, false);
  assert.equal(t.SL.merge(base()).posts.length, 1);
  for (const value of t.store.values()) assert.equal(String(value).indexOf("quotedmaple") >= 0, false);
});

test("an open page refreshes when the assignment signal arrives", async () => {
  const t = setup({ lists: false });
  await t.SL.refresh(true);
  const before = t.calls.length;
  t.SL._mem.meta = { lists: [], checkedAt: Date.now(), account: "membermaple" };
  await t.SL.notify({ lists: true });
  assert.ok(t.calls.length > before, "the signal did not read the lists");
});

test("a failed list says retry instead of waiting for the scheduler", async () => {
  const t = setup({ lists: [{ id: "sa1b2c3d4", name: "Extra", hash: "", count: 0, status: "error" }] });
  await t.SL.refresh(true);
  t.SL.attach({
    accountsApi: () => "https://api.example",
    accountToken: () => "t",
    signedOwner: () => false,
    STATE: { settings: {} },
    tr: (key) => key,
    esc: (value) => String(value == null ? "" : value),
    pageHead: () => "",
    render: () => {}
  });
  const html = t.SL.view();
  assert.equal(html.includes("Waiting for the next refresh"), false);
  assert.match(html, /Something went wrong/);
  assert.match(html, /data-sl-act="retry-lists"/);
});

test("accounts without lists download no shard and stale list posts go away", async () => {
  const t = setup({ lists: false });
  await t.SL.refresh(true);
  assert.ok(!t.calls.some((c) => c.includes("/shard/")));
  const stale = base();
  stale.feeds.push({ id: "rss:feeds.example", sourceList: true });
  stale.posts.push({ id: "p1", feedId: "rss:feeds.example", sourceList: true });
  const doc = t.SL.merge(stale);
  assert.equal(doc.posts.length, 1);
  assert.equal(doc.feeds.length, 1);
});
