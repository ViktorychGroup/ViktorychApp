/* "Sync across my devices": newer Home choices win, the account switch
   syncs itself, and a device that keeps its own look neither sends nor
   takes the shared look. Runs accounts.js in a vm. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const accountsCode = fs.readFileSync("accounts.js", "utf8");
const syncCode = fs.readFileSync("settings-sync.js", "utf8");
const store = {};
const windowMock = {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  CustomEvent: function () {},
  t: (key) => key,
  SI18n: { productName: () => "ViktorychApp" },
  VIKTORYCH_ACCOUNTS: { api: "", gate: false },
  location: { hash: "#/", replace() {} },
  matchMedia: () => ({ matches: false }),
  localStorage: {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; }
  },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => []
  },
  HandleSkeleton: { skeleton: (handle) => String(handle || "").toLowerCase() }
};
windowMock.window = windowMock;
windowMock.document.defaultView = windowMock;
const context = vm.createContext(windowMock);
vm.runInContext(syncCode, context);
vm.runInContext(accountsCode, context);
const accounts = windowMock.ViktorychAccounts;

// Newer per-key choice wins in both directions.
let merged = accounts.mergePayload(
  { homePills: false, stories: true, prefsAt: { homePills: 200, stories: 100 } },
  { homePills: true, stories: false, prefsAt: { homePills: 150, stories: 300 } }
);
assert.equal(merged.homePills, false, "local pills choice is newer");
const keptBlocks = accounts.mergePayload(
  { blocks: { at: 50, accounts: ["x:sample_old"], posts: [], sources: [], types: {} } },
  { blocks: { at: 10, accounts: [], posts: [], sources: [], types: {} } }
);
assert.deepEqual(keptBlocks.blocks.accounts, ["x:sample_old"], "a newer local block list beats the copy a sync echo sends back");
const remoteBlocks = accounts.mergePayload(
  { blocks: { at: 10, accounts: [], posts: [], sources: [], types: {} } },
  { blocks: { at: 80, accounts: ["x:sample_other"], posts: [], sources: [], types: {} } }
);
assert.deepEqual(remoteBlocks.blocks.accounts, ["x:sample_other"], "a newer block list from another device still wins");
assert.equal(merged.stories, false, "remote stories choice is newer");
assert.deepEqual(JSON.parse(JSON.stringify(merged.prefsAt)), { homePills: 200, stories: 300 });

// The account switch itself is last-write-wins.
merged = accounts.mergePayload({ syncUi: true, syncUiAt: 10 }, { syncUi: false, syncUiAt: 20 });
assert.equal(merged.syncUi, false);
assert.equal(merged.syncUiAt, 20);

// Sync on: the snapshot carries the look.
let snap = accounts.snapshotFrom({ appearance: "dim", drawerMenu: { at: 5, order: ["a"] }, homePills: false, prefsAt: { homePills: 5 } });
assert.equal(snap.appearance, "dim");
assert.equal(snap.homePills, false);
assert.ok(!snap.uiLocal);

// This device keeps its own look: nothing of the look is sent.
accounts.setDeviceOwnUi(true);
assert.equal(accounts.uiSyncOn(), false);
snap = accounts.snapshotFrom({ appearance: "dim", drawerMenu: { at: 5, order: ["a"] }, homePills: false, follows: ["x:a"] });
assert.equal(snap.uiLocal, true);
assert.equal(snap.appearance, undefined);
assert.equal(snap.drawerMenu, undefined);
assert.equal(snap.homePills, undefined);
assert.deepEqual(Array.from(snap.follows), ["x:a"], "follows still sync");
// Merging keeps the account's look for other devices, not this device's.
merged = accounts.mergePayload(snap, { appearance: "light", homePills: true, prefsAt: { homePills: 1 } });
assert.equal(merged.appearance, "light");
assert.equal(merged.homePills, true);
accounts.setDeviceOwnUi(false);
assert.equal(accounts.uiSyncOn(), true);

// The account switch off stops the look on every device.
snap = accounts.snapshotFrom({ syncUi: false, syncUiAt: 9, appearance: "dim" });
assert.equal(snap.uiLocal, true);
assert.equal(snap.syncUi, false, "the switch itself still syncs");

// Custom tabs follow the account until this device keeps them.
const tabsReg = windowMock.ViktorychSettingsSync;
assert.ok(tabsReg && tabsReg.CAT_OF.feedTabs === "tabs", "tabs have their own sync choice");
tabsReg.setCatLocal("tabs", true);
snap = accounts.snapshotFrom({ follows: ["x:a"], feedTabs: [{ id: "t1", name: "News" }], noteTabs: [], tabViews: { t1: "grid" }, lastNoteTab: "t1" });
assert.equal(snap.feedTabs, undefined, "kept-local tabs are not sent");
assert.equal(snap.noteTabs, undefined);
assert.equal(snap.lastNoteTab, undefined, "the last-read marker follows the tabs choice");
assert.equal(snap.tabViews, undefined);
assert.ok(Array.isArray(snap.localKeys) && snap.localKeys.indexOf("feedTabs") >= 0 && snap.localKeys.indexOf("lastNoteTab") >= 0, "the payload marks what stays here");
assert.deepEqual(Array.from(snap.follows), ["x:a"], "follows still sync");
merged = accounts.mergePayload(snap, { feedTabs: [{ id: "t2", name: "Fun" }] });
assert.ok(merged.feedTabs.length === 1 && merged.feedTabs[0].id === "t2", "the account keeps its copy for the other devices");
tabsReg.setCatLocal("tabs", false);
snap = accounts.snapshotFrom({ follows: ["x:a"], feedTabs: [{ id: "t1", name: "News" }] });
assert.ok(Array.isArray(snap.feedTabs) && snap.feedTabs.length === 1, "tabs ride the account again");

// Order, membership and deletion merge per account. An older device cannot
// undo a newer drag, add, removal or delete. Two accounts never share a payload.
const reordered = accounts.mergePayload(
  { feedTabs: [
    { id: "beta", name: "Beta", members: [], pos: 0, posAt: 100, updatedAt: 100 },
    { id: "alpha", name: "Alpha", members: ["instagram:orbitfox"], pos: 1, posAt: 100, updatedAt: 100, memberAdds: { "instagram:orbitfox": 40 } }
  ] },
  { feedTabs: [
    { id: "alpha", name: "Alpha", members: ["instagram:orbitfox"], pos: 0, posAt: 10, updatedAt: 10 },
    { id: "beta", name: "Beta", members: ["x:north"], pos: 1, posAt: 10, updatedAt: 20, memberAdds: { "x:north": 20 } }
  ] }
);
const orderIds = Array.from(reordered.feedTabs).map((tab) => tab.id).join(",");
assert.equal(orderIds, "beta,alpha", "the newer drag is the order");
assert.ok(Array.from(reordered.feedTabs[0].members).indexOf("x:north") >= 0, "an earlier add stays");
assert.ok(Array.from(reordered.feedTabs[1].members).indexOf("instagram:orbitfox") >= 0, "the other device's add stays");
const removed = accounts.mergePayload(
  { feedTabs: [{ id: "alpha", name: "Alpha", members: ["instagram:orbitfox"], updatedAt: 10 }] },
  { feedTabs: [{ id: "alpha", name: "Alpha", members: [], updatedAt: 40, memberDrops: { "instagram:orbitfox": 40 } }] }
);
assert.equal(Array.from(removed.feedTabs[0].members).length, 0, "a later removal stays removed");
const afterRename = accounts.mergePayload(
  { feedTabs: [{ id: "alpha", name: "Cedar", members: ["instagram:orbitfox"], updatedAt: 80, memberAdds: { "instagram:orbitfox": 10 }, pos: 1, posAt: 80 }] },
  { feedTabs: [{ id: "alpha", name: "Alpha", members: [], updatedAt: 40, memberDrops: { "instagram:orbitfox": 40 }, pos: 0, posAt: 5 }] }
);
assert.equal(Array.from(afterRename.feedTabs[0].members).length, 0, "a rename does not bring a removed account back");
assert.equal(afterRename.feedTabs[0].pos, 1, "the newer order survives that removal");
const gone = accounts.mergePayload(
  { feedTabs: [{ id: "alpha", name: "Old", members: [], updatedAt: 10 }, { id: "beta", name: "Beta", members: [], updatedAt: 10 }] },
  { feedTabs: [{ id: "alpha", name: "Old", members: [], updatedAt: 50, deletedAt: 50 }] }
);
assert.equal(gone.feedTabs.find((tab) => tab.id === "alpha").deletedAt, 50, "a deleted tab stays deleted");
assert.ok(gone.feedTabs.some((tab) => tab.id === "beta"), "the other tab stays");

// Live updates ride the account channel.
const presence = fs.readFileSync("presence.js", "utf8");
assert.match(presence, /topics: \["presence", "notifications", "sync", "posts", "p2p", "srv", "games"\]/);
console.log("device sync ok");
