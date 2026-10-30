import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { Miniflare } from "miniflare";
import { exportDatabase } from "../src/d1-backup.js";
import { forgetTelegram, prefixEnd } from "../src/account-delete.js";
import { migrateOwnerKeys } from "../src/owner-keys.js";
import { withD1Saver, saverEligible, resetSaverForTest, SAVER_PCT } from "../src/d1-saver.js";
import { d1PctFrom, d1ReadPct, resetQuota, setQuotaForTest } from "../src/quota.js";
import { shouldPause } from "../src/watchdog.js";

function bare() {
  return new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: ["DB"], r2Buckets: ["DATA"] });
}

/* Wraps a D1 binding and adds up meta.rows_read, the number D1 bills. */
function metered(db) {
  const seen = { rows: 0, sql: [] };
  const wrap = (stmt, sql) => ({
    bind: (...args) => wrap(stmt.bind(...args), sql),
    async all() { const r = await stmt.all(); seen.rows += Number(r.meta && r.meta.rows_read || 0); seen.sql.push(sql); return r; },
    async first() { const r = await stmt.all(); seen.rows += Number(r.meta && r.meta.rows_read || 0); seen.sql.push(sql); return (r.results || [])[0] || null; },
    async run() { const r = await stmt.run(); seen.rows += Number(r.meta && r.meta.rows_read || 0); seen.sql.push(sql); return r; }
  });
  return { seen, DB: { prepare: (sql) => wrap(db.prepare(sql), sql), batch: (list) => db.batch(list) } };
}

async function telegramTable(db, n) {
  await db.exec("CREATE TABLE telegram_files (object_key TEXT NOT NULL, kind TEXT NOT NULL, part_index INTEGER NOT NULL, bucket TEXT NOT NULL DEFAULT '', file_id TEXT NOT NULL, message_id INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream', duration REAL NOT NULL DEFAULT 0, serve INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0, encrypted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (object_key, kind, part_index))");
  const stmts = [];
  for (let i = 0; i < n; i++) {
    stmts.push(db.prepare("INSERT INTO telegram_files (object_key, kind, part_index, file_id, message_id, size, sha256, updated_at) VALUES (?, 'single', 0, ?, ?, 1, 'x', 1)").bind("post-media/" + String(i).padStart(6, "0") + ".jpg", "f" + i, i + 1));
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
}

test("the daily backup reads each row once and keeps every row", async () => {
  const mf = bare();
  try {
    const db = await mf.getD1Database("DB");
    const DATA = await mf.getR2Bucket("DATA");
    await telegramTable(db, 1700);
    await db.exec("CREATE TABLE plain_wr (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID");
    await db.batch([db.prepare("INSERT INTO plain_wr VALUES ('a', 'it''s')"), db.prepare("INSERT INTO plain_wr VALUES ('b', '2')")]);
    const m = metered(db);
    const out = await exportDatabase({ DB: m.DB, DATA }, Date.UTC(2026, 9, 30, 4, 17));
    assert.ok(out && out.key.endsWith("2026-10-30.sql.gz"));
    // OFFSET paging read about n*n/(2*page) rows; walking the rowid reads n.
    assert.ok(m.seen.rows < 1700 * 2 + 200, "rows read " + m.seen.rows);
    assert.equal(m.seen.sql.some((sql) => /telegram_files.*OFFSET/.test(sql)), false);
    const obj = await DATA.get(out.key);
    const text = gunzipSync(Buffer.from(await obj.arrayBuffer())).toString("utf8");
    assert.equal((text.match(/INSERT INTO "telegram_files"/g) || []).length, 1700);
    assert.ok(text.includes("post-media/001699.jpg"));
    assert.equal(text.includes("__vk_rowid"), false);
    assert.equal((text.match(/INSERT INTO "plain_wr"/g) || []).length, 2);
    assert.ok(text.includes("'it''s'"));
  } finally { await mf.dispose(); }
});

test("deleting an account reads only its own telegram rows", async () => {
  const mf = bare();
  try {
    const db = await mf.getD1Database("DB");
    const DATA = await mf.getR2Bucket("DATA");
    await telegramTable(db, 1500);
    const id = "123456789012";
    await db.batch([
      db.prepare("INSERT INTO telegram_files (object_key, kind, part_index, file_id, message_id, size, sha256, updated_at) VALUES (?, 'single', 0, 'a', 77, 1, 'x', 1)").bind("uploads/" + id + "/a.jpg"),
      db.prepare("INSERT INTO telegram_files (object_key, kind, part_index, file_id, message_id, size, sha256, updated_at) VALUES (?, 'single', 0, 'b', 78, 1, 'x', 1)").bind("media/avatars/" + id + "/b.webp"),
      // Same prefix but a different account: must stay.
      db.prepare("INSERT INTO telegram_files (object_key, kind, part_index, file_id, message_id, size, sha256, updated_at) VALUES (?, 'single', 0, 'c', 79, 1, 'x', 1)").bind("uploads/1234567890120/c.jpg")
    ]);
    assert.equal(prefixEnd("uploads/1/"), "uploads/10");
    const m = metered(db);
    const gone = await forgetTelegram({ DB: m.DB, DATA }, id, []);
    assert.equal(gone, 2);
    assert.ok(m.seen.rows < 50, "rows read " + m.seen.rows);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM telegram_files").first();
    assert.equal(left.n, 1501);
  } finally { await mf.dispose(); }
});

test("the owner_keys copy no longer scans sqlite_master on every isolate start", async () => {
  const mf = bare();
  try {
    const db = await mf.getD1Database("DB");
    await db.exec("CREATE TABLE owner_key_items (owner_id TEXT, key_id TEXT, slot TEXT, label TEXT, position INTEGER, kind TEXT, ciphertext TEXT, iv TEXT, mask TEXT, status TEXT, last_used INTEGER, last_error TEXT, expires_at INTEGER, updated_at INTEGER, tested_at INTEGER)");
    for (let i = 0; i < 60; i++) await db.exec("CREATE TABLE filler_" + i + " (x INTEGER)");
    const m = metered(db);
    await migrateOwnerKeys(m);
    assert.equal(m.seen.sql.some((sql) => /sqlite_master/.test(sql)), false);
    assert.ok(m.seen.rows < 5, "rows read " + m.seen.rows);
  } finally { await mf.dispose(); }
});

function memoryCache() {
  const map = new Map();
  return {
    map,
    async match(key) { const hit = map.get(String(key)); return hit ? new Response(hit.body, { headers: hit.headers }) : undefined; },
    async put(key, res) { map.set(String(key), { body: await res.text(), headers: Object.fromEntries(res.headers) }); }
  };
}

test("near the D1 limit, signed-out reads come from the saved copy", async () => {
  resetSaverForTest();
  const cache = memoryCache();
  const waits = [];
  let calls = 0;
  const run = async () => { calls++; return new Response(JSON.stringify({ n: calls }), { headers: { "content-type": "application/json" } }); };
  const req = () => new Request("https://api.example/v1/profiles/someone?x=1");
  const deps = (pct) => ({ cache, pct: () => pct, now: Date.now(), waitUntil: (p) => waits.push(p) });
  const first = await withD1Saver(req(), run, deps(10));
  assert.equal((await first.json()).n, 1);
  await Promise.all(waits);
  assert.equal(cache.map.size, 1);
  const saved = await withD1Saver(req(), run, deps(SAVER_PCT));
  assert.equal(saved.headers.get("x-d1-saver"), "stale");
  assert.equal((await saved.json()).n, 1);
  assert.equal(calls, 1);
  // A failing read falls back to the saved copy too.
  const failed = await withD1Saver(req(), async () => { throw new Error("D1_ERROR: limit"); }, deps(10));
  assert.equal(failed.headers.get("x-d1-saver"), "stale");
  // Signed-in, owner and websocket requests never use it.
  assert.equal(saverEligible(new Request("https://api.example/v1/profiles/someone", { headers: { authorization: "Bearer t" } })), false);
  assert.equal(saverEligible(new Request("https://api.example/v1/owner/usage")), false);
  assert.equal(saverEligible(new Request("https://api.example/v1/profiles/x", { headers: { upgrade: "websocket" } })), false);
  assert.equal(saverEligible(new Request("https://api.example/v1/profiles/x", { method: "POST" })), false);
  // No-store answers are not kept.
  const before = cache.map.size;
  await withD1Saver(new Request("https://api.example/v1/other"), async () => new Response("{}", { headers: { "content-type": "application/json", "cache-control": "no-store" } }), deps(10));
  await Promise.all(waits);
  assert.equal(cache.map.size, before);
});

test("D1 rows read percent comes from the same analytics read, and pauses optional cron work", () => {
  resetQuota();
  assert.equal(d1ReadPct(Date.UTC(2026, 9, 30)), -1);
  assert.equal(d1PctFrom({ d: [{ sum: { rowsRead: 4450000 } }] }), 89);
  assert.equal(d1PctFrom({}), -1);
  setQuotaForTest(10, "2026-10-30", 91);
  assert.equal(d1ReadPct(Date.UTC(2026, 9, 30, 12)), 91);
  assert.equal(d1ReadPct(Date.UTC(2026, 9, 31, 0, 5)), 0);
  resetQuota();
  assert.equal(shouldPause([{ code: "usage_d1_reads", ratio: 0.92 }]), true);
  assert.equal(shouldPause([{ code: "usage_d1_reads", ratio: 0.85 }]), false);
});
