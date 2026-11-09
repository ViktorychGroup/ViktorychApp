/* The shared local-first cache stays small: entries over the per-entry cap are
   refused, the total stays under the byte budget, and the least recently used
   entries are evicted first. Reads are synchronous so a page can paint cached
   data in its first frame. */
const assert = require("assert");
const localfirst = require("../localfirst.js");

function memoryStore(quota) {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => {
      const used = [...data.entries()].reduce((n, [key, val]) => n + (key === k ? 0 : val.length), 0);
      if (quota && used + String(v).length > quota) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
    get size() { return data.size; },
    bytes() { return [...data.values()].reduce((n, v) => n + v.length, 0); }
  };
}

const swr = localfirst.swr;
const limits = swr.limits;
assert.ok(limits.bytes > 0 && limits.entry > 0 && limits.entries > 0);

let store = memoryStore();
swr.reset();
assert.strictEqual(swr.get("missing", store), null);
assert.ok(swr.put("a", { n: 1 }, store));
assert.deepStrictEqual(swr.get("a", store).value, { n: 1 });
assert.ok(swr.fresh("a", 60000, store));
assert.ok(!swr.fresh("a", -1, store));

/* Survives a reload: a fresh module state reads the same store. */
swr.reset();
assert.deepStrictEqual(swr.get("a", store).value, { n: 1 });

/* Oversized entries are refused. */
assert.strictEqual(swr.put("huge", "x".repeat(limits.entry + 10), store), false);
assert.strictEqual(swr.get("huge", store), null);

/* Byte budget with LRU eviction. */
swr.clear(store);
swr.reset();
const chunk = "y".repeat(Math.floor(limits.entry * 0.9));
let now = 1000;
const realNow = Date.now;
Date.now = () => (now += 10);
try {
  for (let i = 0; i < 12; i++) {
    assert.ok(swr.put("k" + i, chunk, store));
    if (i === 2) swr.get("k0", store); /* k0 recently used: kept over k1 */
  }
} finally { Date.now = realNow; }
assert.ok(store.bytes() <= limits.bytes + 4096, "cache over budget: " + store.bytes());
assert.ok(swr.get("k11", store), "newest entry kept");
assert.strictEqual(swr.get("k1", store), null, "least recently used entry evicted");

/* Entry count cap. */
swr.clear(store);
swr.reset();
for (let i = 0; i < limits.entries + 15; i++) swr.put("e" + i, i, store);
swr.reset();
const kept = Array.from({ length: limits.entries + 15 }, (_, i) => swr.get("e" + i, store)).filter(Boolean).length;
assert.ok(kept <= limits.entries, "too many entries: " + kept);

/* Storage quota: evicts and retries instead of failing. */
store = memoryStore(Math.floor(limits.entry * 1.5));
swr.reset();
assert.ok(swr.put("q1", "z".repeat(Math.floor(limits.entry * 0.8)), store));
assert.ok(swr.put("q2", "z".repeat(Math.floor(limits.entry * 0.9)), store));
assert.ok(swr.get("q2", store));

/* Private pages keep their snapshot under a "private-list" key, which the
   device seal encrypts and the private wipe removes; public pages do not. */
assert.ok(localfirst.routeKey("#/messages").indexOf("private-list:route:v2:") === 0, "messages stays private");
assert.ok(localfirst.routeKey("#/messages/abc").indexOf("private-list:route:v2:") === 0);
assert.ok(localfirst.routeKey("#/chat").indexOf("private-list:route:v2:") === 0);
assert.ok(localfirst.routeKey("#/bookmarks").indexOf("private-list:route:v2:") === 0);
assert.ok(localfirst.routeKey("#/lists").indexOf("private-list:route:v2:") === 0);
assert.ok(localfirst.routeKey("#/lists/1").indexOf("private-list:route:v2:") === 0);
assert.ok(localfirst.routeKey("#/drafts").indexOf("private-list:route:v2:") === 0);
assert.ok(localfirst.routeKey("#/notifications").indexOf("private-list:route:v2:") === 0);
assert.strictEqual(localfirst.routeKey("#/explore").indexOf("private-list"), -1);
assert.strictEqual(localfirst.routeKey("#/communities").indexOf("private-list"), -1);
assert.strictEqual(localfirst.routeKey("#/cat/crew").indexOf("route:v2:"), 0);
assert.ok(swr.put(localfirst.routeKey("#/messages"), "<p>secret</p>", store));
assert.ok(swr.put(localfirst.routeKey("#/explore"), "<p>public</p>", store));
localfirst.wipePrivate(store);
assert.strictEqual(swr.get(localfirst.routeKey("#/messages"), store), null);
assert.ok(swr.get(localfirst.routeKey("#/explore"), store));

/* Sign-out wipes it. */
swr.clear(store);
assert.strictEqual(swr.get("q2", store), null);

/* A route painted for one account must not be stored for the next account
   when the delayed write runs after a switch. */
const routeStore = memoryStore();
global.localStorage = routeStore;
localfirst.swr.reset();
function setAccount(id) {
  routeStore.setItem("viktorychapp-account-v1", JSON.stringify({ token: "token-" + id, account: { publicId: id } }));
}
setAccount("500000000005");
const poison = "route:500000000005:#/cat/crew";
assert.ok(swr.put(poison, "<article>Cached note from user b</article>", routeStore));
assert.strictEqual(localfirst.readRoute("#/cat/crew"), "", "a pre-fix snapshot is not painted");
localfirst.onAccountChange();
assert.strictEqual(swr.get(poison, routeStore), null, "an account switch purges a pre-fix snapshot");
setAccount("100000000001");
assert.strictEqual(localfirst.saveRoute("#/cat/crew", "<article>Cached note from user b</article>"), true);
setAccount("500000000005");
setTimeout(() => {
  try {
    assert.strictEqual(localfirst.readRoute("#/cat/crew"), "", "the next account does not receive the previous page");
    setAccount("100000000001");
    assert.strictEqual(localfirst.readRoute("#/cat/crew"), "", "the late write is dropped instead of filed after the switch");
    assert.strictEqual(localfirst.saveRoute("#/cat/crew", "<article>own note</article>"), true);
    localfirst.noteScroll("home:crew", 400);
    setTimeout(() => {
      try {
        assert.strictEqual(localfirst.readRoute("#/cat/crew"), "<article>own note</article>");
        assert.strictEqual(localfirst.readScrolls()["home:crew"], 400);
        localfirst.noteScroll("home:crew", 10);
        setAccount("500000000005");
        setTimeout(() => {
          try {
            assert.strictEqual(localfirst.readScrolls()["home:crew"], undefined, "a switched account does not keep the previous scroll");
            setAccount("100000000001");
            assert.strictEqual(localfirst.readScrolls()["home:crew"], 400, "the late scroll write was dropped");
            console.log("swr cache ok");
          } catch (err) {
            console.error(err);
            process.exit(1);
          }
        }, 350);
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
    }, 450);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}, 450);
