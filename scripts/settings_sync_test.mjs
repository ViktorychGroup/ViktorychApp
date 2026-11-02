import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
globalThis.dispatchEvent = () => true;
const reg = require("../settings-sync.js");

test("a fresh device takes the account's settings, then its own edits win", () => {
  mem.clear();
  const local = reg.stamp({ appearance: "lightsout", livePreview: "auto", prefsAt: {} }, 1000);
  assert.deepEqual(local.prefsAt, {}, "first run records values without stamps");
  const remote = { appearance: "dim", livePreview: "off", prefsAt: { appearance: 50 } };
  let picked = reg.pick(local, remote, reg.neverSynced());
  assert.equal(picked.values.appearance, "dim");
  assert.equal(picked.values.livePreview, "off", "an unstamped tie goes to the account on a fresh device");
  reg.remember(Object.assign({}, picked.values, { prefsAt: picked.at }));
  assert.equal(reg.neverSynced(), false);
  const again = reg.stamp({ appearance: "dim", livePreview: "off", prefsAt: {} }, 2000);
  assert.equal(again.prefsAt.appearance, 50, "applied values are not taken for edits");
  const edited = reg.stamp({ appearance: "light", livePreview: "off", prefsAt: {} }, 3000);
  assert.equal(edited.prefsAt.appearance, 3000);
  picked = reg.pick(edited, remote, reg.neverSynced());
  assert.equal(picked.values.appearance, "light", "the newer local edit wins");
});

test("device-only choices by category, by setting and by the master switch", () => {
  mem.clear();
  assert.deepEqual(reg.localKeys({}), ["inboxLayout"], "Inbox sections stay on this device by default");
  reg.setCatLocal("music", true);
  reg.setKeyLocal("mutedWords", true);
  const own = reg.localKeys({});
  assert.ok(own.includes("musicPrefs") && own.includes("mutedWords") && !own.includes("appearance"));
  assert.ok(reg.localKeys({ lookOwn: true }).includes("navCustomAt"), "companion keys follow their setting");
  assert.ok(reg.localKeys({ allOff: true }).includes("bells"));
  reg.setCatLocal("music", false);
  assert.ok(!reg.localKeys({}).includes("musicPrefs"));
  for (const key of ["networkMode", "playbackSource", "privacyZeroTrace", "bellNotes", "bellSeen", "bellRead"]) {
    assert.equal(reg.CAT_OF[key], undefined, key + " never syncs");
  }
});

test("Inbox sections are per device until the member shares them", () => {
  mem.clear();
  assert.equal(reg.keyLocal("inboxLayout"), true);
  reg.setKeyLocal("inboxLayout", false);
  assert.equal(reg.keyLocal("inboxLayout"), false);
  assert.ok(!reg.localKeys({}).includes("inboxLayout"));
  assert.ok(reg.localKeys({ lookOwn: true }).includes("inboxLayout"), "the device-look override still keeps it");
  reg.setKeyLocal("inboxLayout", true);
  assert.ok(reg.localKeys({}).includes("inboxLayout"));
  assert.equal(reg.CAT_OF.inboxLayout, "look");
  assert.ok(reg.LWW.includes("inboxLayout"));
});

test("Custom tabs follow the account until this device keeps them", () => {
  mem.clear();
  assert.equal(reg.CAT_OF.feedTabs, "tabs");
  assert.ok(!reg.localKeys({}).includes("feedTabs"), "tabs sync by default like the rest of the account");
  reg.setKeyLocal("feedTabs", true);
  assert.ok(reg.localKeys({}).includes("feedTabs"), "one tab bundle can stay on this device");
  assert.ok(!reg.localKeys({}).includes("noteTabs"), "other tab bundles keep syncing");
  reg.setKeyLocal("feedTabs", false);
  reg.setCatLocal("tabs", true);
  const own = reg.localKeys({});
  for (const key of ["feedTabs", "noteTabs", "lastNoteTab", "communityTabs", "tabViews"]) {
    assert.ok(own.includes(key), key + " stays with the tabs choice");
  }
  assert.ok(!reg.LWW.includes("feedTabs"), "tabs keep their own merge in accounts.js");
  reg.setCatLocal("tabs", false);
  assert.ok(!reg.localKeys({}).includes("feedTabs"), "the choice turns back off");
});
