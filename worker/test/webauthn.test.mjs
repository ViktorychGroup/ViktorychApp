import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";
import {
  b64urlToBytes,
  bytesToB64url,
  decodeCbor,
  encodeCbor,
  rpIdForOrigin,
  sha256,
  verifyAssertion
} from "../../shared/webauthn.js";

const ORIGINS = [
  "https://viktorychgroup.github.io",
  "https://viktorychapp.pages.dev",
  "https://preview.viktorychgroup.github.io",
  "http://viktorychgroup.github.io",
  "http://127.0.0.1:8080"
].join(",");

let mf;
let bindings;
let ipN = 80;

function workerOptions() {
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
      OWNER_HANDLE: "owner-test",
      ALLOWED_ORIGINS: ORIGINS,
      PBKDF2_ITERATIONS: "1000"
    }
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers(opts.headers || {});
  headers.set("CF-Connecting-IP", opts.ip || ("203.0.113." + (ipN++)));
  if (opts.origin) headers.set("Origin", opts.origin);
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: "unparsed" }; }
  return { status: res.status, body };
}

function concat(parts) {
  let size = 0;
  for (let i = 0; i < parts.length; i++) size += parts[i].length;
  const out = new Uint8Array(size);
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], pos);
    pos += parts[i].length;
  }
  return out;
}

function rawToDer(raw) {
  function part(bytes) {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let value = bytes.slice(i);
    if (value[0] & 0x80) value = concat([Uint8Array.of(0), value]);
    return concat([Uint8Array.of(0x02, value.length), value]);
  }
  const body = concat([part(raw.slice(0, 32)), part(raw.slice(32))]);
  return concat([Uint8Array.of(0x30, body.length), body]);
}

async function authenticator(algorithm) {
  const id = crypto.getRandomValues(new Uint8Array(16));
  let privateKey;
  let cose;
  if (algorithm === -257) {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
      true,
      ["sign"]
    );
    privateKey = pair.privateKey;
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const map = new Map();
    map.set(1, 3);
    map.set(3, -257);
    map.set(-1, b64urlToBytes(jwk.n));
    map.set(-2, b64urlToBytes(jwk.e));
    cose = encodeCbor(map);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
    privateKey = pair.privateKey;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const map = new Map();
    map.set(1, 2);
    map.set(3, -7);
    map.set(-1, 1);
    map.set(-2, raw.slice(1, 33));
    map.set(-3, raw.slice(33, 65));
    cose = encodeCbor(map);
  }
  async function authData(rpId, signCount, attested) {
    const rp = await sha256(new TextEncoder().encode(rpId));
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, signCount);
    const flags = attested ? 0x45 : 0x05;
    if (!attested) return concat([rp, Uint8Array.of(flags), count]);
    const len = Uint8Array.of(id.length >> 8, id.length & 255);
    return concat([rp, Uint8Array.of(flags), count, new Uint8Array(16), len, id, cose]);
  }
  async function client(type, origin, challenge) {
    const json = JSON.stringify({ type: type, challenge: challenge, origin: origin, crossOrigin: false });
    return new TextEncoder().encode(json);
  }
  return {
    id: id,
    cose: cose,
    async registration(origin, rpId, challenge, fmt) {
      const clientBytes = await client("webauthn.create", origin, challenge);
      const data = await authData(rpId, 0, true);
      const map = new Map();
      map.set("fmt", fmt || "none");
      map.set("attStmt", new Map());
      map.set("authData", data);
      const rawId = bytesToB64url(id);
      return {
        id: rawId,
        rawId: rawId,
        type: "public-key",
        response: {
          clientDataJSON: bytesToB64url(clientBytes),
          attestationObject: bytesToB64url(encodeCbor(map)),
          transports: ["internal", "hybrid"]
        }
      };
    },
    async assertion(origin, rpId, challenge, signCount, der) {
      const clientBytes = await client("webauthn.get", origin, challenge);
      const data = await authData(rpId, signCount, false);
      const hash = await sha256(clientBytes);
      const signed = concat([data, hash]);
      const params = algorithm === -257 ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" };
      let signature = new Uint8Array(await crypto.subtle.sign(params, privateKey, signed));
      if (der) signature = rawToDer(signature);
      const rawId = bytesToB64url(id);
      return {
        id: rawId,
        rawId: rawId,
        type: "public-key",
        response: {
          clientDataJSON: bytesToB64url(clientBytes),
          authenticatorData: bytesToB64url(data),
          signature: bytesToB64url(signature),
          userHandle: null
        }
      };
    }
  };
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
  bindings = await mf.getBindings();
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("relying party id follows the host", () => {
  assert.equal(rpIdForOrigin("https://viktorychgroup.github.io"), "viktorychgroup.github.io");
  assert.equal(rpIdForOrigin("https://viktorychapp.pages.dev"), "viktorychapp.pages.dev");
  assert.equal(rpIdForOrigin("https://preview.viktorychapp.pages.dev/app"), "preview.viktorychapp.pages.dev");
  assert.equal(rpIdForOrigin("http://127.0.0.1:8765"), "127.0.0.1");
  assert.equal(rpIdForOrigin("http://localhost:8080"), "localhost");
  assert.equal(rpIdForOrigin("http://viktorychgroup.github.io"), "");
  assert.equal(rpIdForOrigin("https://evil.github.io"), "");
  assert.equal(rpIdForOrigin("https://evil.example"), "");
});

test("passkey signup, login, a second key, and the failures", async () => {
  const origin = "https://viktorychgroup.github.io";
  const rpId = "viktorychgroup.github.io";
  const key = await authenticator(-7);
  const ip = "203.0.113.70";

  const missing = await call("/v1/webauthn/signup/options", {
    method: "POST",
    ip: ip,
    body: { displayName: "Guest", handle: "guestbox" }
  });
  assert.equal(missing.status, 403);
  assert.equal(missing.body.error, "origin");

  const insecure = await call("/v1/webauthn/signup/options", {
    method: "POST",
    ip: "203.0.113.71",
    origin: "http://viktorychgroup.github.io",
    body: { displayName: "Guest", handle: "guestbox" }
  });
  assert.equal(insecure.status, 403);

  const evil = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.72",
    origin: "https://evil.example",
    body: {}
  });
  assert.equal(evil.status, 403);

  const options = await call("/v1/webauthn/signup/options", {
    method: "POST",
    ip: ip,
    origin: origin,
    body: { displayName: "Guest", handle: "guestbox" }
  });
  assert.equal(options.status, 200);
  assert.equal(options.body.publicKey.rp.id, rpId);
  assert.equal(options.body.publicKey.authenticatorSelection.residentKey, "required");
  assert.equal(options.body.publicKey.authenticatorSelection.authenticatorAttachment, undefined);
  assert.ok(options.body.publicKey.hints.indexOf("hybrid") >= 0);
  assert.equal(options.body.publicKey.attestation, "none");

  const created = await call("/v1/webauthn/signup/verify", {
    method: "POST",
    ip: ip,
    origin: origin,
    body: {
      challengeId: options.body.challengeId,
      credential: await key.registration(origin, rpId, options.body.publicKey.challenge, "none"),
      label: "Guest device"
    }
  });
  assert.equal(created.status, 201);
  assert.equal(String(created.body.accountNumber || "").length, 16);
  assert.equal(created.body.account.owner, false);
  const token = created.body.token;
  const publicId = created.body.account.publicId;

  const replay = await call("/v1/webauthn/signup/verify", {
    method: "POST",
    ip: "203.0.113.73",
    origin: origin,
    body: {
      challengeId: options.body.challengeId,
      credential: await key.registration(origin, rpId, options.body.publicKey.challenge, "none")
    }
  });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "challenge");

  const stored = await bindings.DB.prepare("SELECT public_key, algorithm, sign_count FROM webauthn_credentials WHERE public_id = ?").bind(publicId).first();
  const cose = decodeCbor(b64urlToBytes(stored.public_key));
  assert.equal(cose.value.get(1), 2);
  assert.equal(cose.value.get(-4), undefined);
  assert.equal(stored.algorithm, -7);

  const challenges = await bindings.DB.prepare("SELECT COUNT(*) AS n FROM webauthn_challenges").first();
  assert.equal(Number(challenges.n), 0);

  const login = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.74",
    origin: origin,
    body: {}
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.publicKey.allowCredentials, undefined);
  assert.equal(login.body.publicKey.userVerification, "preferred");
  assert.ok(login.body.publicKey.hints.indexOf("hybrid") >= 0);

  const session = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.74",
    origin: origin,
    body: {
      challengeId: login.body.challengeId,
      credential: await key.assertion(origin, rpId, login.body.publicKey.challenge, 1, false)
    }
  });
  assert.equal(session.status, 200);
  assert.equal(session.body.account.publicId, publicId);
  const who = await call("/v1/session", { ip: "203.0.113.75", origin: origin, token: session.body.token });
  assert.equal(who.status, 200);
  assert.equal(who.body.account.publicId, publicId);

  const other = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.76",
    origin: "https://viktorychapp.pages.dev",
    body: {}
  });
  const crossed = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.76",
    origin: "https://viktorychapp.pages.dev",
    body: {
      challengeId: other.body.challengeId,
      credential: await key.assertion("https://viktorychapp.pages.dev", "viktorychapp.pages.dev", other.body.publicKey.challenge, 2, false)
    }
  });
  assert.equal(crossed.status, 401);
  assert.equal(crossed.body.error, "passkey_failed");

  const derLogin = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.77",
    origin: origin,
    body: {}
  });
  const der = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.77",
    origin: origin,
    body: {
      challengeId: derLogin.body.challengeId,
      credential: await key.assertion(origin, rpId, derLogin.body.publicKey.challenge, 3, true)
    }
  });
  assert.equal(der.status, 200);

  const cloneLogin = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.78",
    origin: origin,
    body: {}
  });
  const cloned = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.78",
    origin: origin,
    body: {
      challengeId: cloneLogin.body.challengeId,
      credential: await key.assertion(origin, rpId, cloneLogin.body.publicKey.challenge, 3, false)
    }
  });
  assert.equal(cloned.status, 401);

  const badLogin = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.79",
    origin: origin,
    body: {}
  });
  const badCred = await key.assertion(origin, rpId, badLogin.body.publicKey.challenge, 4, false);
  const flipped = b64urlToBytes(badCred.response.signature);
  flipped[flipped.length - 1] ^= 1;
  badCred.response.signature = bytesToB64url(flipped);
  const bad = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.79",
    origin: origin,
    body: { challengeId: badLogin.body.challengeId, credential: badCred }
  });
  assert.equal(bad.status, 401);
  const consumed = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.79",
    origin: origin,
    body: { challengeId: badLogin.body.challengeId, credential: badCred }
  });
  assert.equal(consumed.status, 400);

  const add = await call("/v1/webauthn/register/options", {
    method: "POST",
    ip: "203.0.113.81",
    origin: origin,
    token: token,
    body: {}
  });
  assert.equal(add.status, 200);
  assert.equal(add.body.publicKey.excludeCredentials.length, 1);
  const second = await authenticator(-7);
  const added = await call("/v1/webauthn/register/verify", {
    method: "POST",
    ip: "203.0.113.81",
    origin: origin,
    token: token,
    body: {
      challengeId: add.body.challengeId,
      credential: await second.registration(origin, rpId, add.body.publicKey.challenge, "packed"),
      label: "Guest device"
    }
  });
  assert.equal(added.status, 200);
  const listed = await call("/v1/webauthn/credentials", { ip: "203.0.113.82", origin: origin, token: token });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.credentials.length, 2);
  assert.equal(JSON.stringify(listed.body).includes(stored.public_key), false);
  assert.equal(listed.body.credentials[0].publicKey, undefined);

  const removed = await call("/v1/webauthn/credentials", {
    method: "DELETE",
    ip: "203.0.113.83",
    origin: origin,
    token: token,
    body: { credentialId: bytesToB64url(second.id) }
  });
  assert.equal(removed.status, 200);
  const after = await call("/v1/webauthn/credentials", { ip: "203.0.113.84", origin: origin, token: token });
  assert.equal(after.body.credentials.length, 1);

  const expired = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.85",
    origin: origin,
    body: {}
  });
  await bindings.DB.prepare("UPDATE webauthn_challenges SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, expired.body.challengeId).run();
  const late = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.85",
    origin: origin,
    body: {
      challengeId: expired.body.challengeId,
      credential: await key.assertion(origin, rpId, expired.body.publicKey.challenge, 8, false)
    }
  });
  assert.equal(late.status, 400);

  const rsaOrigin = "https://viktorychapp.pages.dev";
  const rsa = await authenticator(-257);
  const rsaOptions = await call("/v1/webauthn/signup/options", {
    method: "POST",
    ip: "203.0.113.86",
    origin: rsaOrigin,
    body: { displayName: "Guest", handle: "guestboxb" }
  });
  assert.equal(rsaOptions.status, 200);
  const rsaCreated = await call("/v1/webauthn/signup/verify", {
    method: "POST",
    ip: "203.0.113.86",
    origin: rsaOrigin,
    body: {
      challengeId: rsaOptions.body.challengeId,
      credential: await rsa.registration(rsaOrigin, "viktorychapp.pages.dev", rsaOptions.body.publicKey.challenge, "none")
    }
  });
  assert.equal(rsaCreated.status, 201);
  const rsaRow = await bindings.DB.prepare("SELECT public_key, algorithm FROM webauthn_credentials WHERE credential_id = ?").bind(bytesToB64url(rsa.id)).first();
  assert.equal(rsaRow.algorithm, -257);
  const rsaCose = decodeCbor(b64urlToBytes(rsaRow.public_key));
  assert.equal(rsaCose.value.get(-3), undefined);
  const rsaLogin = await call("/v1/webauthn/login/options", {
    method: "POST",
    ip: "203.0.113.87",
    origin: rsaOrigin,
    body: {}
  });
  const rsaSession = await call("/v1/webauthn/login/verify", {
    method: "POST",
    ip: "203.0.113.87",
    origin: rsaOrigin,
    body: {
      challengeId: rsaLogin.body.challengeId,
      credential: await rsa.assertion(rsaOrigin, "viktorychapp.pages.dev", rsaLogin.body.publicKey.challenge, 1, false)
    }
  });
  assert.equal(rsaSession.status, 200);

  const sample = await key.assertion(origin, rpId, "unused", 9, true);
  const direct = await verifyAssertion({
    clientDataJSON: b64urlToBytes(sample.response.clientDataJSON),
    authenticatorData: b64urlToBytes(sample.response.authenticatorData),
    signature: b64urlToBytes(sample.response.signature),
    publicKey: key.cose,
    challenge: new Uint8Array(1),
    origin: origin,
    rpId: rpId,
    signCount: 0
  }).then(() => "accepted", (err) => err.message);
  assert.equal(direct, "challenge");
});

test("a passkey sign-up follows the owner and imports nothing else", async () => {
  const origin = "https://viktorychgroup.github.io";
  const rpId = "viktorychgroup.github.io";
  const db = await mf.getD1Database("DB");
  await db.prepare("INSERT INTO accounts (public_id, handle, skeleton, display_name, avatar, banner, bio, owner, number_lookup, number_hash, salt, created_at, profile_less) VALUES ('900000000001', 'ownerbox', 'ownerbox', 'Owner', '', '', '', 1, 'x', 'x', 'x', ?, 0) ON CONFLICT DO NOTHING").bind(Date.now()).run();
  const ownerRow = await db.prepare("SELECT public_id FROM accounts WHERE owner = 1").first();
  assert.ok(ownerRow);
  const key = await authenticator(-7);
  const ip = "203.0.113.190";
  const options = await call("/v1/webauthn/signup/options", { method: "POST", ip, origin, body: { displayName: "Key Friend", handle: "keyfriend" } });
  assert.equal(options.status, 200, JSON.stringify(options.body));
  const created = await call("/v1/webauthn/signup/verify", {
    method: "POST",
    ip,
    origin,
    body: { challengeId: options.body.challengeId, credential: await key.registration(origin, rpId, options.body.publicKey.challenge, "none"), label: "Key device" }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const publicId = created.body.account.publicId;
  const listed = await db.prepare("SELECT target_id FROM account_follows WHERE follower_id = ?").bind(publicId).all();
  assert.deepEqual(listed.results.map((r) => r.target_id), ["app:" + ownerRow.public_id]);
  const imported = await call("/v1/follows/import", { method: "POST", token: created.body.token, body: { ids: ["x:copperlane", "youtube:news"] } });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 0);
  assert.equal(imported.body.followingCount, 1);
});
