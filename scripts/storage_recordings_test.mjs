/* Roundtrip the producer vsr-playback-2 fixture. The identity in that
   fixture is disposable and is not a user secret. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import {
  BACKUP_RECIPIENT,
  PLAYBACK_FORMAT,
  fragmentForTime,
  looksLikeIdentity,
  looksLikeRecipient,
  parsePlainCatalog,
  parsePlaybackManifest,
  parseSealedCatalog,
  playbackPlan,
  storageReadiness
} from "../shared/storage-contract.js";
import { decryptBytes, encryptBytes } from "../shared/storage-age.js";
import { audioKind, avc1Codec, classifyMp4, likelyMime } from "../shared/storage-mp4.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fix = path.join(root, "scripts/fixtures/vsr-playback-2");
const cat = path.join(root, "scripts/fixtures/vsr-catalog");

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

function testIdentity() {
  return fs.readFileSync(path.join(fix, "TEST-ONLY-identity.txt"), "utf8").split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("AGE-SECRET-KEY-"));
}

const age = loadAge();
const identity = testIdentity();
assert.equal(looksLikeIdentity(identity), true);
assert.equal(looksLikeRecipient(BACKUP_RECIPIENT), true);
assert.equal(looksLikeRecipient(identity), false);
assert.equal(looksLikeIdentity(BACKUP_RECIPIENT), false);
const ready = storageReadiness({ identityHeld: false, telegramGetFile: true });
assert.equal(ready.recipient.state, "ready");
assert.equal(ready.recipient.value, BACKUP_RECIPIENT);
assert.equal(ready.identity.state, "needed");
assert.equal(ready.recorder.state, "unlinked");
assert.equal(ready.catalog.state, "local");
assert.equal(ready.catalog.telegramGetFile, true);
assert.equal(ready.provider.state, "absent");
assert.equal(storageReadiness({ identityHeld: true }).identity.state, "ready");
const other = await age.generateX25519Identity();
const recipient = await age.identityToRecipient(identity);
const plain = new TextEncoder().encode("hello storage");
const forOwner = await encryptBytes(age, BACKUP_RECIPIENT, plain);
let ownerKey = "";
try { await decryptBytes(age, identity, forOwner); } catch (err) { ownerKey = "key"; }
assert.equal(ownerKey, "key");
const cipher = await encryptBytes(age, recipient, plain);
assert.equal(new TextDecoder().decode(await decryptBytes(age, identity, cipher)), "hello storage");
let wrong = "";
try { await decryptBytes(age, other, cipher); } catch (err) { wrong = "key"; }
assert.equal(wrong, "key");

const expectedText = fs.readFileSync(path.join(fix, "package/manifest.decrypted.json"), "utf8");
const decrypted = new TextDecoder().decode(await decryptBytes(age, identity, fs.readFileSync(path.join(fix, "package/manifest.age"))));
assert.deepEqual(JSON.parse(decrypted), JSON.parse(expectedText));
let badManifest = "";
try { await decryptBytes(age, other, fs.readFileSync(path.join(fix, "package/manifest.age"))); } catch (err) { badManifest = "key"; }
assert.equal(badManifest, "key");

assert.equal(parsePlaybackManifest(decrypted, {}).error, "unauthenticated");
assert.equal(parsePlainCatalog('{"v":1,"kind":"age-byte-chunks"}').error, "withdrawn");
assert.equal(parsePlaybackManifest('{"v":1,"kind":"age-byte-chunks"}', { authenticated: true }).error, "withdrawn");
const parsed = parsePlaybackManifest(decrypted, { authenticated: true });
assert.equal(parsed.manifest.format, PLAYBACK_FORMAT);
assert.equal(parsed.manifest.chunks.map((row) => row.durationMs).join(","), "1000,1000,400");
assert.equal(fragmentForTime(parsed.manifest, 0).index, 0);
assert.equal(fragmentForTime(parsed.manifest, 0.999).index, 0);
assert.equal(fragmentForTime(parsed.manifest, 1).index, 1);
assert.equal(fragmentForTime(parsed.manifest, 1.5).index, 1);
assert.equal(fragmentForTime(parsed.manifest, 2).index, 2);
assert.equal(fragmentForTime(parsed.manifest, 2.2).index, 2);
assert.equal(parsed.manifest.markedLikely, true);
assert.equal(parsed.manifest.telegramGetFile, true);
const badFlag = JSON.parse(decrypted);
badFlag.chunks[1].telegram_getfile = "yes";
assert.equal(parsePlaybackManifest(badFlag, { authenticated: true }).error, "manifest");
assert.equal(parsed.manifest.init.objectName, parsed.manifest.init.sha256 + ".age");
const example = parsePlaybackManifest(fs.readFileSync(path.join(fix, "contracts/vsr-playback-2.manifest.example.json"), "utf8"), { authenticated: true });
assert.equal(example.manifest.format, PLAYBACK_FORMAT);
const broken = JSON.parse(decrypted);
broken.chunks[0].independently_playable = true;
assert.equal(parsePlaybackManifest(broken, { authenticated: true }).error, "manifest");

const initPlain = await decryptBytes(age, identity, fs.readFileSync(path.join(fix, "package", parsed.manifest.init.objectName)));
assert.equal(initPlain.length, parsed.manifest.init.plaintextBytes);
assert.equal(classifyMp4(initPlain), "init");
assert.equal(avc1Codec(initPlain), "avc1.64000A");
assert.equal(audioKind(initPlain), "aac-lc");
const derived = likelyMime(initPlain);
assert.equal(derived, "video/mp4; codecs=\"avc1.64000A,mp4a.40.2\"");
assert.equal(derived.includes("not probed"), false);
for (const chunk of parsed.manifest.chunks) {
  const file = fs.readFileSync(path.join(fix, "package", chunk.objectName));
  assert.equal(file.length, chunk.ciphertextBytes);
  const media = await decryptBytes(age, identity, file);
  assert.equal(media.length, chunk.plaintextBytes);
  assert.equal(classifyMp4(media), "fragment");
}
const flipped = Buffer.from(fs.readFileSync(path.join(fix, "package", parsed.manifest.chunks[0].objectName)));
flipped[flipped.length - 3] ^= 9;
let tampered = "";
try { await decryptBytes(age, identity, flipped); } catch (err) { tampered = "tamper"; }
assert.equal(tampered, "tamper");

const playable = Object.assign({}, parsed.manifest, { likely: true, mime: derived });
assert.equal(playbackPlan(playable, () => true).mode, "mse");
assert.equal(playbackPlan(playable, () => false).reason, "codec");
assert.equal(playbackPlan({ legacy: true }, () => true).mode, "legacy");
assert.equal(playbackPlan(parsed.manifest, () => true).mode, "unsupported");

const ui = fs.readFileSync(path.join(root, "storage-recordings.js"), "utf8");
assert.equal(ui.includes("manifest.json"), true);
assert.equal(/api\.telegram|telegram\.org/.test(ui), false);
assert.equal(ui.includes("/tg/vsr/"), true);
assert.equal(ui.includes("codecs_parameter"), false);

const catalogKey = fs.readFileSync(path.join(cat, "TEST-ONLY-identity.txt"), "utf8").split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("AGE-SECRET-KEY-"));
const catalogText = new TextDecoder().decode(await decryptBytes(age, catalogKey, fs.readFileSync(path.join(cat, "catalog.age"))));
const catalogExpected = fs.readFileSync(path.join(cat, "catalog.decrypted.json"), "utf8");
assert.deepEqual(JSON.parse(catalogText), JSON.parse(catalogExpected));
assert.equal(parseSealedCatalog(catalogText, {}).error, "unauthenticated");
const sealed = parseSealedCatalog(catalogText, { authenticated: true });
assert.equal(sealed.catalog.packages.length, 1);
assert.equal(sealed.catalog.packages[0].rows.every((row) => row.uploaded === false), true);
assert.equal(JSON.stringify(sealed).includes("file_id"), false);
const lied = JSON.parse(catalogText);
lied.packages[0].rows[0].uploaded = true;
assert.equal(parseSealedCatalog(lied, { authenticated: true }).error, "catalog");
console.log("storage recordings ok");
