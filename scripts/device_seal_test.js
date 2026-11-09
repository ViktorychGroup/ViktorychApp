#!/usr/bin/env node
/* Headless tests for device-seal.js: encryption at rest, the device key,
   "Delete all data on this device" and inactivity expiry. Plain Node with
   small in-memory stand-ins for the browser storage APIs. */
"use strict";
const assert = require("assert");
const path = require("path");
const { webcrypto } = require("crypto");
const Seal = require(path.join(__dirname, "..", "device-seal.js"));

const DAY = 86400000;

function makeStorageClass() {
  class Storage {
    constructor() { Object.defineProperty(this, "_d", { value: new Map() }); }
    getItem(k) { k = String(k); return this._d.has(k) ? this._d.get(k) : null; }
    setItem(k, v) { this._d.set(String(k), String(v)); }
    removeItem(k) { this._d.delete(String(k)); }
    clear() { this._d.clear(); }
    key(i) { const keys = [...this._d.keys()]; return i < keys.length ? keys[i] : null; }
  }
  Object.defineProperty(Storage.prototype, "length", { configurable: true, get() { return this._d.size; } });
  return Storage;
}

// Minimal IndexedDB that keeps values by reference (CryptoKeys included).
function makeIdb() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function makeDb(name, data) {
    return {
      name,
      objectStoreNames: { contains: (s) => data.has(s) },
      createObjectStore(s) { data.set(s, new Map()); },
      close() {},
      transaction(s, mode) {
        const tx = { oncomplete: null, onerror: null, onabort: null };
        tx.objectStore = () => {
          const store = data.get(s);
          const reqOf = (fn) => { const r = {}; later(() => { r.result = fn(); if (r.onsuccess) r.onsuccess(); }); return r; };
          return {
            get: (k) => reqOf(() => store.get(k)),
            put: (v, k) => reqOf(() => { if (mode !== "readwrite") throw new Error("ro"); store.set(k, v); return k; }),
            delete: (k) => reqOf(() => { store.delete(k); }),
            openCursor() {
              const r = {};
              const keys = [...store.keys()];
              let i = 0;
              const step = () => later(() => {
                if (i >= keys.length) { r.result = null; if (r.onsuccess) r.onsuccess(); return; }
                const key = keys[i++];
                r.result = { key, value: store.get(key), delete: () => store.delete(key), continue: step };
                if (r.onsuccess) r.onsuccess();
              });
              step();
              return r;
            }
          };
        };
        setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 5);
        return tx;
      }
    };
  }
  const factory = {
    _dbs: dbs,
    open(name) {
      const req = {};
      later(() => {
        let fresh = false;
        if (!dbs.has(name)) { dbs.set(name, new Map()); fresh = true; }
        const db = makeDb(name, dbs.get(name));
        req.result = db;
        if (fresh && req.onupgradeneeded) {
          let aborted = false;
          req.transaction = { abort() { aborted = true; } };
          req.onupgradeneeded();
          if (aborted) { dbs.delete(name); if (req.onerror) req.onerror(); return; }
        }
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
    deleteDatabase(name) {
      const req = {};
      later(() => { dbs.delete(name); if (req.onsuccess) req.onsuccess(); });
      return req;
    },
    databases() { return Promise.resolve([...dbs.keys()].map((name) => ({ name }))); }
  };
  return factory;
}

function makeCaches(names) {
  const set = new Set(names);
  return { keys: () => Promise.resolve([...set]), delete: (n) => Promise.resolve(set.delete(n)), _set: set };
}

// One "device" (persistent storage) and helpers to open the app on it.
function makeDevice() {
  const Storage = makeStorageClass();
  return {
    Storage,
    ls: new Storage(),
    idb: makeIdb(),
    caches: makeCaches(["data-v1", "media-v1", "shell-x"]),
    cookies: new Map([["vapp", "1"]]),
    regs: 1,
    clock: Date.UTC(2026, 9, 1),
    posted: [],
    fetched: []
  };
}
function openApp(dev, opts) {
  opts = opts || {};
  // A new tab: new sessionStorage, and Storage.prototype as the browser ships it.
  const Storage = makeStorageClass();
  Object.setPrototypeOf(dev.ls, Storage.prototype);
  const ss = new Storage();
  const doc = {};
  Object.defineProperty(doc, "cookie", {
    get: () => [...dev.cookies].map(([k, v]) => k + "=" + v).join("; "),
    set: (text) => { const name = text.split("=")[0].trim(); if (/max-age=0/.test(text)) dev.cookies.delete(name); }
  });
  const env = {
    Storage,
    localStorage: dev.ls,
    sessionStorage: ss,
    indexedDB: dev.idb,
    crypto: webcrypto,
    TextEncoder,
    caches: dev.caches,
    document: doc,
    location: { hostname: "app.example", pathname: "/", href: "https://app.example/", reload() { env.reloads++; }, replace() { env.replaced++; } },
    reloads: 0,
    replaced: 0,
    navigator: {
      storage: { estimate: () => Promise.resolve({ usage: 2048, quota: 1 << 30 }) },
      serviceWorker: {
        controller: { postMessage: (m) => dev.posted.push(m) },
        getRegistrations: () => Promise.resolve(dev.regs ? [{ unregister: () => { dev.regs = 0; return Promise.resolve(true); } }] : [])
      }
    },
    VIKTORYCH_ACCOUNTS: { api: "https://api.example" },
    fetch: (url) => { dev.fetched.push(url); return Promise.resolve({ ok: true }); },
    __now: () => dev.clock
  };
  const seal = Seal.create(env);
  if (!opts.noBoot) seal.boot();
  return { env, seal, ls: dev.ls, ss };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 30));

async function main() {
  // Which names are protected.
  assert.ok(Seal.isSensitive("viktorychapp-account-v1"));
  assert.ok(Seal.isSensitive("viktorychapp-friend-threads-v1"));
  assert.ok(Seal.isSensitive("viktorychapp-compose-draft"));
  assert.ok(!Seal.isSensitive("viktorychapp-settings-v1"));
  assert.ok(!Seal.isSensitive(Seal.VAULT_KEY));
  assert.ok(!Seal.isExpired(Date.now(), 0, Date.now() + 1000 * DAY), "never expires");

  // 1. Sensitive values are stored encrypted, other values as before.
  const dev = makeDevice();
  let app = openApp(dev);
  await app.seal.ready();
  const account = JSON.stringify({ token: "tok-secret-123", name: "Tester" });
  app.ls.setItem("viktorychapp-account-v1", account);
  app.ls.setItem("viktorychapp-settings-v1", "{\"theme\":\"dark\"}");
  assert.strictEqual(app.ls.getItem("viktorychapp-account-v1"), account);
  await app.seal.flush();
  const raw = [...dev.ls._d.entries()].map(([k, v]) => k + "=" + v).join("\n");
  assert.ok(!raw.includes("tok-secret-123"), "token must not be stored in plaintext");
  assert.ok(dev.ls._d.has(Seal.VAULT_KEY), "vault written");
  assert.strictEqual(dev.ls._d.get("viktorychapp-settings-v1"), "{\"theme\":\"dark\"}");
  assert.ok(app.ls.length >= 2);
  const listed = [];
  for (let i = 0; i < app.ls.length; i++) listed.push(app.ls.key(i));
  assert.ok(listed.includes("viktorychapp-account-v1"), "key() lists sealed names");
  const keyRec = dev.idb._dbs.get(Seal.KEY_DB).get("k").get("device");
  assert.strictEqual(keyRec.extractable, false, "device key is non-extractable");

  // 2. A cold start (new tab) decrypts it.
  app = openApp(dev);
  assert.ok(app.seal.has("viktorychapp-account-v1"));
  await app.seal.ready();
  assert.strictEqual(app.ls.getItem("viktorychapp-account-v1"), account);

  // 3. Legacy plaintext is moved into the vault.
  dev.ls._d.set("viktorychapp-friend-outbox-v1", "[\"hi\"]");
  app = openApp(dev);
  await app.seal.ready();
  await wait(80);
  await app.seal.flush();
  assert.ok(!dev.ls._d.has("viktorychapp-friend-outbox-v1"), "plaintext copy removed");
  app = openApp(dev);
  await app.seal.ready();
  assert.strictEqual(app.ls.getItem("viktorychapp-friend-outbox-v1"), "[\"hi\"]");

  // 4. Without the key the leftovers are unreadable.
  const vaultCopy = dev.ls._d.get(Seal.VAULT_KEY);
  await app.seal.destroyKey();
  dev.ls._d.set(Seal.VAULT_KEY, vaultCopy);
  app = openApp(dev);
  await app.seal.ready();
  assert.strictEqual(app.ls.getItem("viktorychapp-account-v1"), null, "no key, no data");
  assert.ok(!dev.ls._d.has(Seal.VAULT_KEY), "unreadable vault dropped");

  // 5. Expiry: 29 days is fine, 31 days wipes private data and signs out.
  const dev2 = makeDevice();
  app = openApp(dev2);
  await app.seal.ready();
  app.ls.setItem("viktorychapp-account-v1", account);
  app.ls.setItem("viktorychapp-lock-v1", "x");
  await app.seal.flush();
  dev2.clock += 29 * DAY;
  app = openApp(dev2);
  await app.seal.ready();
  assert.ok(!app.seal.expiredNow());
  assert.strictEqual(app.ls.getItem("viktorychapp-account-v1"), account);
  await wait(50);
  dev2.clock += 31 * DAY;
  app = openApp(dev2);
  assert.ok(app.seal.expiredNow(), "31 days idle expires");
  await wait(120);
  assert.strictEqual(app.ls.getItem("viktorychapp-account-v1"), null);
  assert.ok(!dev2.ls._d.has(Seal.VAULT_KEY));
  assert.ok(!dev2.ls._d.has("viktorychapp-lock-v1"));
  assert.ok(dev2.fetched.some((u) => u.endsWith("/v1/logout")), "server session ended");
  assert.ok(dev2.posted.some((m) => m.type === "auth" && m.on === false));
  assert.strictEqual(app.seal.takeNotice(), "expired");
  assert.ok(dev2.caches._set.has("data-v1"), "public cache kept by default");

  // "Never" keeps everything.
  app = openApp(dev2);
  await app.seal.ready();
  app.seal.setPolicy({ days: 0 });
  app.ls.setItem("viktorychapp-account-v1", account);
  await app.seal.flush();
  dev2.clock += 400 * DAY;
  app = openApp(dev2);
  await app.seal.ready();
  assert.ok(!app.seal.expiredNow());
  assert.strictEqual(app.ls.getItem("viktorychapp-account-v1"), account);
  assert.strictEqual(app.seal.readPolicy().days, 0);
  app.seal.setPolicy({ days: 5 });
  assert.strictEqual(app.seal.readPolicy().days, Seal.DEFAULT_DAYS, "unknown choice falls back to 30");

  // The service worker marked the key expired while the app was closed.
  await wait(60);
  const meta = dev2.idb._dbs.get(Seal.KEY_DB).get("k").get("meta");
  assert.ok(meta && meta.lastOpen, "meta for the service worker");
  meta.expired = true;
  app = openApp(dev2);
  await wait(150);
  assert.ok(app.env.reloads >= 1, "reloads after a worker-side expiry");
  assert.ok(!dev2.ls._d.has(Seal.VAULT_KEY));

  // 6. Delete all data on this device.
  const dev3 = makeDevice();
  app = openApp(dev3);
  await app.seal.ready();
  app.ls.setItem("viktorychapp-account-v1", account);
  app.ls.setItem("viktorychapp-settings-v1", "{}");
  app.ss.setItem("tab-thing", "1");
  await app.seal.flush();
  await new Promise((r) => { const q = dev3.idb.open("viktorych-local-v1", 1); q.onupgradeneeded = () => q.result.createObjectStore("s"); q.onsuccess = r; });
  const report = await app.seal.wipeAll({ reason: "wiped" });
  assert.strictEqual(dev3.ls._d.size, 0, "localStorage empty");
  assert.strictEqual(app.ss.getItem("tab-thing"), null, "sessionStorage cleared");
  assert.strictEqual(dev3.idb._dbs.size, 0, "every IndexedDB database deleted");
  assert.strictEqual(dev3.caches._set.size, 0, "Cache Storage empty");
  assert.strictEqual(dev3.regs, 0, "service worker unregistered");
  assert.strictEqual(dev3.cookies.size, 0, "cookies cleared");
  assert.ok(report.dbs.includes("viktorych-local-v1"));
  assert.strictEqual(app.env.replaced, 1, "reloads clean");
  assert.strictEqual(app.ss.getItem("viktorychapp-wipe-notice"), "wiped");
  app.ls.setItem("viktorychapp-account-v1", "late");
  assert.strictEqual(dev3.ls._d.size, 0, "no writes while wiping");
  const after = openApp(dev3);
  await after.seal.ready();
  assert.strictEqual(after.ls.getItem("viktorychapp-account-v1"), null);

  // 7. Expiry with "also delete saved posts and media" runs the full wipe.
  const dev4 = makeDevice();
  app = openApp(dev4);
  await app.seal.ready();
  app.seal.setPolicy({ days: 7, dropPublic: true });
  await wait(40);
  dev4.clock += 8 * DAY;
  app = openApp(dev4);
  await wait(150);
  assert.strictEqual(dev4.caches._set.size, 0);
  assert.strictEqual(app.env.replaced, 1);

  // 8. Storage size.
  const est = await app.seal.estimate();
  assert.deepStrictEqual(est, { usage: 2048, quota: 1 << 30 });

  // 9. A vault write already encrypting must not return after clear().
  const dev5 = makeDevice();
  app = openApp(dev5);
  await app.seal.ready();
  const held = JSON.stringify({ token: "held-secret-999", account: { publicId: "100000000001", temporary: { expiresAt: 1 } } });
  app.ls.setItem("viktorychapp-account-v1", held);
  const realEncrypt = webcrypto.subtle.encrypt.bind(webcrypto.subtle);
  let releaseEncrypt = null;
  const encryptGate = new Promise((resolve) => { releaseEncrypt = resolve; });
  webcrypto.subtle.encrypt = function () {
    const args = arguments;
    return encryptGate.then(() => realEncrypt.apply(webcrypto.subtle, args));
  };
  try {
    app.ls.setItem("viktorychapp-account-v1", held);
    await wait(50);
    app.ls.clear();
    releaseEncrypt();
    await wait(80);
    assert.ok(!dev5.ls._d.has(Seal.VAULT_KEY), "clear wins over an in-flight vault write");
    assert.strictEqual(app.ls.getItem("viktorychapp-account-v1"), null, "the cleared session stays gone");
    const again = JSON.stringify({ token: "next-secret-111", account: { publicId: "200000000002" } });
    app.ls.setItem("viktorychapp-account-v1", again);
    await app.seal.flush();
    assert.ok(dev5.ls._d.has(Seal.VAULT_KEY), "a later sign-in is still sealed");
    assert.ok(![...dev5.ls._d.values()].join("\n").includes("next-secret-111"), "the later token is not plaintext");
  } finally {
    webcrypto.subtle.encrypt = realEncrypt;
  }

  console.log("device seal ok (encryption, key destroy, wipe, expiry)");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
