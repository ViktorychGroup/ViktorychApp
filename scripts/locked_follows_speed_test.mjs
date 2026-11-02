// Locked follows must stay cheap on the timeline's hot path. The app asks
// hidesId() for every feed and post on every paint; it may not read and
// parse the saved session each time, and with nothing locked it must not
// hash at all. A whole timeline's worth of checks has to finish quickly.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "locked-follows.js"), "utf8");
function fail(msg) { console.error("locked follows speed: " + msg); process.exit(1); }

function makeWorld(stored) {
  const store = new Map(Object.entries(stored || {}));
  const counts = { account: 0 };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  const listeners = {};
  const win = {
    localStorage,
    location: { hash: "#/home" },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    ViktorychAccounts: {
      account: () => { counts.account++; const s = JSON.parse(store.get("viktorychapp-account-v1") || "null"); return s ? s.account : null; },
      token: () => "t"
    }
  };
  win.window = win;
  const ctx = vm.createContext({ window: win, localStorage, setTimeout: () => 0, clearTimeout: () => {}, Date, Math, JSON, Set, Map, String, Number, Array, Object, Promise, console });
  vm.runInContext(src, ctx);
  return { api: win.ViktorychLocked, counts, store, fire: (t, e) => (listeners[t] || []).forEach((fn) => fn(e)) };
}

const session = JSON.stringify({ token: "t", account: { publicId: "100000000001", handle: "dummy", bio: "x".repeat(20000) } });
const ids = Array.from({ length: 3000 }, (_, i) => "x:feed" + i);

// 1. Nothing locked: no session reads per call, no hits.
{
  const w = makeWorld({ "viktorychapp-account-v1": session, "viktorychapp-locked-filter": JSON.stringify({ owner: "100000000001", salt: "s", hashes: [] }) });
  const t0 = performance.now();
  for (let r = 0; r < 50; r++) for (const id of ids) if (w.api.hidesId(id)) fail("empty filter hid " + id);
  const ms = performance.now() - t0;
  if (w.api.active()) fail("an empty filter counts as active");
  if (w.counts.account > 5) fail("session read " + w.counts.account + " times for 150000 checks with nothing locked");
  if (ms > 400) fail("150000 empty-filter checks took " + Math.round(ms) + " ms");
}

// 2. Someone locked: correct answers, session read a handful of times, fast.
{
  const hash = (id) => { const w = makeWorld({}); return w.api._filterHash("s", id); };
  const hidden = ids[42];
  const w = makeWorld({ "viktorychapp-account-v1": session, "viktorychapp-locked-filter": JSON.stringify({ owner: "100000000001", salt: "s", hashes: [hash(hidden), hash("app:@locked_dummy")] }) });
  const t0 = performance.now();
  let hits = 0;
  for (let r = 0; r < 50; r++) for (const id of ids) if (w.api.hidesId(id)) hits++;
  const ms = performance.now() - t0;
  if (hits !== 50) fail("expected the locked feed hidden 50 times, got " + hits);
  if (!w.api.hides({ feedId: "x:other", platform: "app", handle: "locked_dummy" })) fail("a locked app author was not hidden");
  if (w.api.hides({ feedId: "x:other", platform: "app", handle: "someone_else" })) fail("an unlocked author was hidden");
  if (w.counts.account > 5) fail("session read " + w.counts.account + " times for 150000 checks");
  if (ms > 600) fail("150000 checks took " + Math.round(ms) + " ms");
  const v1 = w.api.version();
  // 3. Switching accounts (another tab) drops the remembered owner at once.
  w.store.set("viktorychapp-account-v1", JSON.stringify({ token: "t", account: { publicId: "100000000002", handle: "other" } }));
  w.fire("storage", { key: "viktorychapp-account-v1" });
  if (w.api.hidesId(hidden)) fail("another account's filter still hides after switching accounts");
  if (w.api.version() === v1) fail("version did not change after switching accounts");
}

// 4. The app's feeds() keeps its filtered list between calls.
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
if (!/const FEEDS_MEMO = /.test(app) || !/locked\.active\(\)/.test(app)) fail("app.js feeds() no longer memoizes the locked-follows pass");
if (!/let FOLLOW_IDS_MEMO = null;/.test(app)) fail("followIdsNow() no longer reuses its answer within a paint");
console.log("locked follows speed check passed");
