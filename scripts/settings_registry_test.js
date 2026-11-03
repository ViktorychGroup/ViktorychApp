#!/usr/bin/env node
/* Fails when a setting exists in the app but not in settings-registry.js.
   Sources: STATE.settings keys in app.js (fresh() defaults, parsed.X loads,
   STATE.settings.X reads and writes), the synced keys in settings-sync.js and
   the account privacy switches in accounts.js. Also checks
   data/settings-registry.json is current and every row is well formed. */
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const ROOT = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const R = require(path.join(ROOT, "settings-registry.js"));

const known = new Set(R.storeKeys("state").concat(R.storeKeys("saver")));
const app = read("app.js");
const found = new Map();
function note(key, where) { if (!found.has(key)) found.set(key, where); }

// fresh() defaults.
const freshStart = app.indexOf("const fresh = () => ({");
assert.ok(freshStart > 0, "fresh() not found in app.js");
const ret = app.slice(freshStart + "const fresh = () => (".length, app.indexOf("\n", freshStart));
// Top-level keys only: track brace depth.
let depth = 0;
const re = /[{}\[\]()]|(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g;
let m;
while ((m = re.exec(ret))) {
  const ch = m[0];
  if (ch === "{" || ch === "[" || ch === "(") { depth += 1; continue; }
  if (ch === "}" || ch === "]" || ch === ")") { depth -= 1; if (depth <= 0) break; continue; }
  if (depth === 1 && m[1]) note(m[1], "fresh()");
}
// parsed.X = ... in load(), and STATE.settings.X anywhere.
for (const mm of app.matchAll(/\bparsed\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) note(mm[1], "load()");
for (const mm of app.matchAll(/\bSTATE\.settings\.([A-Za-z_$][\w$]*)/g)) note(mm[1], "STATE.settings");

// settings-sync.js keys.
const sync = read("settings-sync.js");
const syncKeys = new Set();
for (const mm of sync.matchAll(/"([A-Za-z][\w]*)"/g)) syncKeys.add(mm[1]);

// accounts.js server privacy switches.
const acct = read("accounts.js");
const acctKeys = new Set(R.storeKeys("account"));
const acctToggles = [...acct.matchAll(/data-acct="toggle-([a-z-]+)"/g)].map((x) => x[1]);
// toggle-form-* are sign-up form fields, not saved settings.
const TOGGLE_FOR = { "protected": "protected", "private-follows": "privateFollows", "profileless": "profileLess", "fed-nostr": "nostr", "temp-label": "tempLabel" };

const IGNORE = new Set(["length", "constructor"]);
const missing = [];
for (const [key, where] of found) {
  if (IGNORE.has(key) || known.has(key)) continue;
  missing.push(key + " (" + where + ")");
}
for (const tg of new Set(acctToggles.filter((x) => !x.startsWith("form-")))) {
  const id = TOGGLE_FOR[tg];
  if (!id) { missing.push("accounts.js toggle-" + tg); continue; }
  if (!R.get(id) && !acctKeys.has(id)) missing.push("accounts.js toggle-" + tg);
}
if (missing.length) {
  console.error("Settings missing from settings-registry.js:\n  " + missing.join("\n  ") + "\nAdd a row for each (see the header of settings-registry.js).");
  process.exit(1);
}

// Rows are well formed.
const ids = new Set();
const STORES = new Set(["state", "account", "presence", "pymk", "notifPrivacy", "saver", "device", "lang", "module"]);
for (const row of R.LIST) {
  assert.ok(row.id && !ids.has(row.id), "duplicate or empty id " + row.id);
  ids.add(row.id);
  assert.ok(row.label && row.desc && row.type && row.cat, "row " + row.id + " needs label, desc, type and cat");
  assert.ok(STORES.has(row.store), "row " + row.id + " has unknown store " + row.store);
  if (row.type === "enum") assert.ok(Array.isArray(row.values) && row.values.length > 1 && row.values.indexOf(row.def) >= 0, "enum " + row.id + " needs values with its default");
  if (row.type === "number") assert.ok(row.min <= row.def && row.def <= row.max, "number " + row.id + " default out of range");
  if (row.ai !== false && row.type !== "data" && row.type !== "action") {
    assert.ok(["bool", "enum", "number"].includes(row.type), "editable row " + row.id + " must be bool, enum or number");
    assert.ok(row.page && row.page.startsWith("#/"), "editable row " + row.id + " needs a page link");
    assert.ok(row.risk, "editable row " + row.id + " needs a risk");
  }
  if (row.risk === "danger") assert.strictEqual(row.ai, false, "danger row " + row.id + " must not be editable by the assistant");
}
for (const macro of R.MACROS) for (const id of Object.keys(macro.set)) {
  assert.ok(R.validate(id, macro.set[id]).ok, "macro " + macro.id + " sets bad value for " + id);
}
// The fresh() defaults match the registry defaults for editable state rows.
// Validation.
assert.deepStrictEqual(R.validate("fontSize", "17"), { ok: true, value: 17 });
assert.deepStrictEqual(R.validate("fontSize", 40), { ok: true, value: 18 });
assert.strictEqual(R.validate("autoplay", "sometimes").ok, false);
assert.strictEqual(R.validate("logout", true).ok, false);
assert.strictEqual(R.validate("version", 3).ok, false);
assert.strictEqual(R.lessPrivate("protected", true, false), true);
assert.strictEqual(R.lessPrivate("protected", false, true), false);
assert.strictEqual(R.lessPrivate("onlineStatus", "nobody", "everyone"), true);
assert.strictEqual(R.lessPrivate("onlineStatus", "everyone", "nobody"), false);

// JSON copy is current.
const jsonPath = path.join(ROOT, "data/settings-registry.json");
const want = JSON.stringify(R.toJSON(), null, 1) + "\n";
if (process.argv.includes("--write")) { fs.writeFileSync(jsonPath, want); console.log("wrote data/settings-registry.json"); }
else assert.strictEqual(fs.existsSync(jsonPath) && fs.readFileSync(jsonPath, "utf8"), want, "data/settings-registry.json is stale: run node scripts/settings_registry_test.js --write");
console.log("settings registry ok: " + R.LIST.length + " rows, " + R.editable().length + " the assistant can change, " + found.size + " app keys covered");
