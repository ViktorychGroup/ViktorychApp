import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import { featureFor } from "../src/feature-flags.js";

const BOT = "123456:probe-token";
const root = fileURLToPath(new URL("../../scripts/fixtures/vsr-catalog/package/manifest.age", import.meta.url));
const manifestBytes = readFileSync(root);
const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
const calls = [];

function workerOptions(bindings) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "ownerlock",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      ...(bindings || {
        TELEGRAM_BOT_TOKEN: BOT,
        TELEGRAM_CHANNEL_ID: "-1004242"
      })
    },
    async outboundService(request) {
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname.endsWith("/getFile")) {
        const id = url.searchParams.get("file_id") || "";
        if (id !== "fixture-age-manifest") return Response.json({ ok: false });
        return Response.json({ ok: true, result: { file_path: "documents/fixture-age-manifest" } });
      }
      if (url.pathname.includes("/file/bot")) {
        return new Response(manifestBytes);
      }
      return new Response("missing", { status: 404 });
    }
  };
}

async function call(mf, path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.40");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.json) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.json ? JSON.stringify(opts.json) : undefined
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body = null;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch (err) { body = null; }
  const packed = new TextDecoder().decode(bytes);
  assert.equal(packed.includes(BOT), false);
  assert.equal(packed.includes("fixture-age-manifest"), false);
  return { status: res.status, body, bytes, headers: res.headers };
}

async function signup(mf, ip, handle, claim) {
  const body = { displayName: "Reader", handle };
  if (claim) body.claimCode = claim;
  return call(mf, "/v1/signup", { method: "POST", ip, json: body });
}

async function insertAge(mf, fileId) {
  const env = await mf.getBindings();
  await env.DB.prepare(
    "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES (?, 'age', 0, '', ?, 0, ?, ?, 'application/octet-stream', 0, 1, 0, 1, 1)"
  ).bind("vsr/manifest.age", fileId, manifestBytes.byteLength, manifestSha).run();
}

test("age retrieval is owner-only and does not use the cleartext route", async () => {
  assert.equal(featureFor("/tg/vsr/manifest.age"), "storage_recordings");
  assert.equal(featureFor("/tg/clip.mp4"), "telegram");
  calls.length = 0;
  const mf = new Miniflare(workerOptions());
  try {
    const anon = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.41" });
    assert.equal(anon.status, 404);
    const other = await signup(mf, "203.0.113.42", "ada_vsr");
    assert.equal(other.body.account.owner, false);
    const denied = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.43", token: other.body.token });
    assert.equal(denied.status, 403);
    const owner = await signup(mf, "203.0.113.44", "ownerlock", "claim-test");
    assert.equal(owner.body.account.owner, true);
    const missing = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.45", token: owner.body.token });
    assert.equal(missing.status, 404);
    await insertAge(mf, "");
    const empty = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.46", token: owner.body.token });
    assert.equal(empty.status, 404);
    assert.equal(empty.body.error, "not_uploaded");
    assert.equal(calls.length, 0);
    const envClear = await mf.getBindings();
    await envClear.DB.prepare(
      "INSERT INTO telegram_files (object_key, kind, part_index, bucket, file_id, message_id, size, sha256, mime, duration, serve, verified, encrypted, updated_at) VALUES ('clip/plain.bin', 'single', 0, '', 'fixture-clear', 0, 4, ?, 'application/octet-stream', 0, 1, 0, 1, 1)"
    ).bind("aa".repeat(32)).run();
    const leaked = await call(mf, "/tg/clip/plain.bin", { ip: "203.0.113.47", token: owner.body.token });
    assert.equal(leaked.status, 404);
    const env = await mf.getBindings();
    await env.DB.prepare("UPDATE telegram_files SET file_id = ? WHERE object_key = ?").bind("fixture-age-manifest", "vsr/manifest.age").run();
    const got = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.48", token: owner.body.token });
    assert.equal(got.status, 200);
    assert.equal(Buffer.from(got.bytes).equals(manifestBytes), true);
    assert.equal(got.headers.get("cache-control"), "private, no-store");
    await env.DB.prepare("UPDATE telegram_files SET sha256 = ? WHERE object_key = ?").bind("ab".repeat(32), "vsr/manifest.age").run();
    const bad = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.49", token: owner.body.token });
    assert.equal(bad.status, 502);
    assert.equal(bad.body.error, "mismatch");
    const off = await call(mf, "/v1/owner/features", {
      method: "POST",
      ip: "203.0.113.50",
      token: owner.body.token,
      json: { name: "storage_recordings", off: true }
    });
    assert.equal(off.status, 200);
    const hidden = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.51", token: owner.body.token });
    assert.equal(hidden.status, 204);
  } finally {
    await mf.dispose();
  }
});

test("retrieval fails closed until both Telegram secret names are set", async () => {
  for (const bindings of [{}, { TELEGRAM_BOT_TOKEN: BOT }, { TELEGRAM_CHANNEL_ID: "-1004242" }]) {
    calls.length = 0;
    const mf = new Miniflare(workerOptions(bindings));
    try {
      const owner = await signup(mf, "203.0.113.60", "ownerlock", "claim-test");
      assert.equal(owner.body.account.owner, true);
      await insertAge(mf, "fixture-age-manifest");
      const res = await call(mf, "/tg/vsr/manifest.age", { ip: "203.0.113.61", token: owner.body.token });
      assert.equal(res.status, 503);
      assert.equal(res.body.error, "not_configured");
      assert.equal(calls.length, 0);
    } finally {
      await mf.dispose();
    }
  }
});
