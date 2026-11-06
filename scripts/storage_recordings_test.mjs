/* Storage recordings contract and age decryption. No identity is written. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import {
  CONTRACT,
  DOWNLOAD_CAP,
  MEMORY_CAP,
  SEGMENT_SLOTS,
  bytesToB64,
  chunkForTime,
  filesFromInline,
  looksLikeIdentity,
  parseManifest,
  playbackPlan,
  providerRows,
  sha256Hex
} from "../shared/storage-contract.js";
import { decryptBytes, encryptBytes } from "../shared/storage-age.js";

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

const age = loadAge();
const identity = await age.generateX25519Identity();
const other = await age.generateX25519Identity();
assert.equal(looksLikeIdentity(identity), true);
assert.equal(looksLikeIdentity("not-a-key"), false);
const recipient = await age.identityToRecipient(identity);
const plain = new TextEncoder().encode("hello storage");
const cipher = await encryptBytes(age, recipient, plain);
const opened = await decryptBytes(age, identity, cipher);
assert.equal(new TextDecoder().decode(opened), "hello storage");
let wrong = "";
try { await decryptBytes(age, other, cipher); } catch (err) { wrong = "key"; }
assert.equal(wrong, "key");
const flipped = cipher.slice();
flipped[flipped.length - 3] ^= 255;
let tampered = "";
try { await decryptBytes(age, identity, flipped); } catch (err) { tampered = "tamper"; }
assert.equal(tampered, "tamper");

const hash = await sha256Hex(cipher);
const manifest = {
  v: 1,
  contract: CONTRACT,
  kind: "age-byte-chunks",
  id: "example-note",
  title: "Example recording",
  bytes: plain.byteLength,
  chunks: [{ name: "000.age", index: 0, plainBytes: plain.byteLength, sha256: hash, inline: bytesToB64(cipher) }]
};
const parsed = parseManifest(manifest);
assert.equal(parsed.manifest.kind, "age-byte-chunks");
assert.equal(parsed.manifest.recorder.state, "unlinked");
const inline = filesFromInline(parsed.manifest);
assert.equal(inline.files["000.age"].byteLength, cipher.byteLength);
const bytePlan = playbackPlan(parsed.manifest, () => true);
assert.equal(bytePlan.mode, "download");
assert.equal(bytePlan.playable, false);
assert.equal(bytePlan.reason, "byte-chunks");

const filePlan = playbackPlan(parseManifest({ ...manifest, kind: "age-file", media: { container: "file", mime: "text/plain", duration: 0 } }).manifest, () => true);
assert.equal(filePlan.mode, "file");
assert.equal(filePlan.reason, "legacy-file");

const huge = parseManifest({ ...manifest, kind: "age-file", bytes: DOWNLOAD_CAP, chunks: [{ ...manifest.chunks[0], plainBytes: DOWNLOAD_CAP }] });
assert.equal(playbackPlan(huge.manifest, () => true).mode, "download");

const media = parseManifest({
  v: 1,
  kind: "age-media-segments",
  id: "example-clip",
  title: "Example clip",
  bytes: 12,
  media: { container: "fmp4", mime: "video/mp4; codecs=\"avc1.42C01E\"", duration: 1 },
  chunks: [
    { name: "init.age", index: 0, plainBytes: 4, sha256: hash, init: true },
    { name: "seg0.age", index: 1, plainBytes: 8, sha256: hash, start: 0, duration: 1 }
  ],
  recorder: { state: "idle", detail: "Idle on this device." }
});
assert.equal(playbackPlan(media.manifest, () => true).mode, "mse");
assert.equal(playbackPlan(media.manifest, () => true).slots, SEGMENT_SLOTS);
assert.equal(playbackPlan(media.manifest, () => false).mode, "unsupported");
assert.equal(playbackPlan(media.manifest, () => false).reason, "codec");
assert.equal(chunkForTime(media.manifest, 0.2).name, "seg0.age");
const untimed = parseManifest({
  ...media.manifest,
  chunks: media.manifest.chunks.map((chunk) => ({ name: chunk.name, index: chunk.index, plainBytes: chunk.plainBytes, sha256: chunk.sha256, init: chunk.init }))
});
assert.equal(playbackPlan(untimed.manifest, () => true).playable, false);
assert.equal(playbackPlan(untimed.manifest, () => true).reason, "byte-chunks");

const providers = providerRows("ready");
assert.deepEqual(providers.map((row) => row.id), ["device", "recordings", "telegram", "gdrive", "onedrive", "cryptomator"]);
assert.equal(providers.every((row) => row.connect === false), true);
assert.equal(providers.find((row) => row.id === "telegram").state, "unavailable");
assert.equal(providers.find((row) => row.id === "device").state, "ready");
assert.equal(providerRows("locked").find((row) => row.id === "device").state, "locked");
assert.equal(parseManifest({ v: 2, kind: "age-file" }).error, "kind");
assert.equal(MEMORY_CAP < DOWNLOAD_CAP, true);

const ui = fs.readFileSync(path.join(root, "storage-recordings.js"), "utf8");
assert.equal(ui.includes('["localStorage", "sessionStorage"]'), true);
assert.equal(ui.includes("AGE-SECRET-KEY-"), true);
assert.equal(/identity\s*=\s*[^;]*localStorage/.test(ui), false);
assert.equal(ui.includes("indexedDB.open"), false);
assert.equal(ui.includes("sendBeacon"), true);
const drive = fs.readFileSync(path.join(root, "drive.js"), "utf8");
assert.equal(drive.includes('href: "#/vault"'), false);
assert.equal(drive.includes("recordingsHtml"), true);

const stored = [];
const memory = {
  setItem(key, value) {
    if (String(value).includes("AGE-SECRET-KEY-")) throw new Error("identity-persist");
    stored.push(String(key) + "=" + String(value));
  }
};
memory.setItem("viktorychapp-server-off", "[]");
assert.throws(() => memory.setItem("leak", identity), /identity-persist/);
assert.equal(stored.some((row) => row.includes(identity)), false);

console.log("storage recordings ok");
