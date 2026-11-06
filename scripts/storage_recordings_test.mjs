/* vsr-playback-2: age manifest, real avc1 codec, withdrawn v1 catalogs. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import {
  PLAYBACK_FORMAT,
  fragmentForTime,
  looksLikeIdentity,
  parsePlainCatalog,
  parsePlaybackManifest,
  playbackPlan,
  sha256Hex
} from "../shared/storage-contract.js";
import { decryptBytes, encryptBytes } from "../shared/storage-age.js";
import { audioKind, avc1Codec, classifyMp4, likelyMime } from "../shared/storage-mp4.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadAge() {
  const code = fs.readFileSync(path.join(root, "vendor/age-0.3.1.min.js"), "utf8");
  const sandbox = {
    crypto: globalThis.crypto,
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    Promise, Object, Array, String, Number, Math, JSON, Error, TypeError, RangeError,
    Map, Set, WeakMap, Date, Symbol, Reflect, Proxy, BigInt, URL,
    TransformStream, ReadableStream, WritableStream, Response, Request, Headers, Blob,
    console, queueMicrotask, setTimeout, clearTimeout, atob, btoa
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  runInContext(code, createContext(sandbox), { filename: "age.js" });
  return sandbox.age;
}

function box(type, payload) {
  const body = payload || new Uint8Array(0);
  const out = new Uint8Array(8 + body.length);
  const size = out.length;
  out[0] = (size >>> 24) & 255;
  out[1] = (size >>> 16) & 255;
  out[2] = (size >>> 8) & 255;
  out[3] = size & 255;
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(body, 8);
  return out;
}

const age = loadAge();
const identity = await age.generateX25519Identity();
const other = await age.generateX25519Identity();
assert.equal(looksLikeIdentity(identity), true);
const recipient = await age.identityToRecipient(identity);
const plain = new TextEncoder().encode("hello storage");
const cipher = await encryptBytes(age, recipient, plain);
assert.equal(new TextDecoder().decode(await decryptBytes(age, identity, cipher)), "hello storage");
let wrong = "";
try { await decryptBytes(age, other, cipher); } catch (err) { wrong = "key"; }
assert.equal(wrong, "key");
const flipped = cipher.slice();
flipped[flipped.length - 3] ^= 255;
let tampered = "";
try { await decryptBytes(age, identity, flipped); } catch (err) { tampered = "tamper"; }
assert.equal(tampered, "tamper");

assert.equal(parsePlainCatalog('{"v":1,"kind":"age-byte-chunks","sha256":"abc"}').error, "withdrawn");
assert.equal(parsePlaybackManifest('{"format":"vsr-playback-2"}', {}).error, "unauthenticated");

const initHash = "a".repeat(64);
const fragHash = "b".repeat(64);
const good = {
  format: PLAYBACK_FORMAT,
  requires_init: true,
  independently_playable: false,
  init: initHash,
  title: "Example clip",
  fragments: [{ sha256: fragHash, start: 0, duration: 1 }]
};
assert.equal(parsePlaybackManifest(JSON.stringify(good), { authenticated: true }).manifest.format, PLAYBACK_FORMAT);
assert.equal(parsePlaybackManifest(JSON.stringify(Object.assign({}, good, { requires_init: false })), { authenticated: true }).error, "manifest");
assert.equal(parsePlaybackManifest(JSON.stringify(Object.assign({}, good, { independently_playable: true })), { authenticated: true }).error, "manifest");
assert.equal(parsePlaybackManifest(JSON.stringify({ v: 1, kind: "age-byte-chunks", chunks: [] }), { authenticated: true }).error, "withdrawn");
const parsed = parsePlaybackManifest(JSON.stringify(good), { authenticated: true }).manifest;
assert.equal(fragmentForTime(parsed, 0.2).sha256, fragHash);
assert.equal(playbackPlan(parsed, () => true).mode, "unsupported");
parsed.likely = true;
parsed.mime = "video/mp4; codecs=\"avc1.42C01F\"";
assert.equal(playbackPlan(parsed, () => true).mode, "mse");
assert.equal(playbackPlan(parsed, () => false).reason, "codec");
assert.equal(playbackPlan({ legacy: true }, () => true).mode, "legacy");
assert.equal(playbackPlan({ legacy: true }, () => true).playable, false);

const init = fs.readFileSync(path.join(root, "scripts/fixtures/storage-init.mp4"));
const frag = fs.readFileSync(path.join(root, "scripts/fixtures/storage-seg.mp4"));
assert.equal(classifyMp4(init), "init");
assert.equal(classifyMp4(frag), "fragment");
const codec = avc1Codec(init);
assert.match(codec, /^avc1\.[0-9A-F]{6}$/);
assert.equal(codec, "avc1.42C01F");
assert.equal(audioKind(init), "none");
assert.equal(likelyMime(init), "video/mp4; codecs=\"" + codec + "\"");
assert.equal(likelyMime(init).includes("42E01E"), false);
assert.equal(avc1Codec(box("hvc1", new Uint8Array(16))), "");

const esds = box("esds", new Uint8Array([0x04, 0x05, 0x40, 0x00, 0x00, 0x05, 0x02, 0x10, 0x08]));
const avc = box("avcC", new Uint8Array([1, 0x42, 0xc0, 0x1f]));
const both = new Uint8Array(box("mp4a", esds).length + avc.length);
both.set(box("mp4a", esds), 0);
both.set(avc, box("mp4a", esds).length);
assert.equal(audioKind(both), "aac-lc");
assert.equal(likelyMime(both), "video/mp4; codecs=\"avc1.42C01F,mp4a.40.2\"");

const ui = fs.readFileSync(path.join(root, "storage-recordings.js"), "utf8");
assert.equal(ui.includes('["localStorage", "sessionStorage"]'), true);
assert.equal(ui.includes("manifest.json"), true);
assert.equal(ui.includes("playWholeFile"), false);
assert.equal(ui.includes("age-byte-chunks"), false);
const stored = [];
const memory = {
  setItem(key, value) {
    if (String(value).includes("AGE-SECRET-KEY-")) throw new Error("identity-persist");
    stored.push(String(value));
  }
};
assert.throws(() => memory.setItem("leak", identity), /identity-persist/);
assert.equal(stored.some((row) => row.includes(identity)), false);
assert.equal(await sha256Hex(cipher), await sha256Hex(cipher));

console.log("storage recordings ok");
