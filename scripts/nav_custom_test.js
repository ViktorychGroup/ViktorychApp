const assert = require("assert");
const fs = require("fs");

console.log("Testing customizable sidebar navigation and folders...");

// Read app.js and extract the nav logic into an isolated sandbox
const appCode = fs.readFileSync("app.js", "utf-8");

// Mock global browser environment
global.window = {
  innerWidth: 1200,
  SI18n: {
    t: (k) => k,
    getLang: () => "en"
  },
  ViktorychShorts: { visible: () => true },
  ViktorychVault: { visible: () => true },
  ViktorychAccounts: null,
  SIntelMusic: null
};

global.localStorage = {
  _store: {},
  getItem(k) { return this._store[k] || null; },
  setItem(k, v) { this._store[k] = String(v); },
  removeItem(k) { delete this._store[k]; }
};

// Evaluate the relevant parts
const tr = (k) => (global.window.SI18n ? global.window.SI18n.t(k) : k);
const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const icon = (name) => `<svg data-icon="${name}"></svg>`;

// Extract DEFAULT_NAV_CUSTOM, ALL_NAV_IDS, cleanNavCustom, navItemDef, folderDisplayName, etc.
const scriptSandbox = `
function shortsEnabled() {
  return typeof SHORTS_ENABLED !== "undefined" && SHORTS_ENABLED === true;
}
${appCode.slice(appCode.indexOf("const DEFAULT_NAV_CUSTOM ="), appCode.indexOf("function brandLink() {"))}
`;

const contextFn = new Function("tr", "esc", "icon", "PATH", "STATE", "subsHash", "bellBadgeHtml", "render", scriptSandbox + `
  return {
    DEFAULT_NAV_CUSTOM,
    ALL_NAV_IDS,
    cleanNavCustom,
    navItemDef,
    getNavCustom,
    saveNavCustom,
    folderDisplayName,
    getNavOpenFolders,
    toggleNavFolder,
    renderNavLinks
  };
`);

const STATE = {
  settings: {},
  navEditingFolder: null
};

const navModule = contextFn(
  tr,
  esc,
  icon,
  {},
  STATE,
  () => "#/subscriptions",
  () => "",
  () => {}
);

const {
  DEFAULT_NAV_CUSTOM,
  ALL_NAV_IDS,
  cleanNavCustom,
  navItemDef,
  getNavCustom,
  saveNavCustom,
  folderDisplayName,
  getNavOpenFolders,
  toggleNavFolder,
  renderNavLinks
} = navModule;

// Test 1: Verify DEFAULT_NAV_CUSTOM
console.log("  Testing DEFAULT_NAV_CUSTOM...");
assert(Array.isArray(DEFAULT_NAV_CUSTOM.folders), "folders should be an array");
assert.strictEqual(DEFAULT_NAV_CUSTOM.folders.length, 2, "should have 2 default folders (Media and Library)");
assert(DEFAULT_NAV_CUSTOM.folders.some((f) => f.id === "media" && f.items.includes("music") && f.items.includes("tv")), "media folder should contain music and tv");
assert(DEFAULT_NAV_CUSTOM.folders.some((f) => f.id === "library" && f.items.includes("history")), "library folder should contain history");
assert(DEFAULT_NAV_CUSTOM.order.includes("folder:media"), "order must include folder:media");
assert(DEFAULT_NAV_CUSTOM.order.includes("folder:library"), "order must include folder:library");
assert(DEFAULT_NAV_CUSTOM.order.includes("home"), "order must include home");

// Test 2: cleanNavCustom
console.log("  Testing cleanNavCustom...");
const cleanEmpty = cleanNavCustom(null);
assert.deepStrictEqual(cleanEmpty.folders.length, 2, "null config should fallback to default 2 folders");

const customWithMissing = {
  folders: [{ id: "custom_fun", name: "Fun", items: ["games"] }],
  order: ["folder:custom_fun", "home"],
  hidden: ["vault"]
};
const cleaned = cleanNavCustom(customWithMissing);
assert.strictEqual(cleaned.folders.length, 1, "custom folder should be kept");
assert.strictEqual(cleaned.folders[0].name, "Fun", "folder name should be Fun");
assert(cleaned.order.includes("explore"), "missing IDs like explore should be automatically appended to order");
assert(!cleaned.order.includes("vault"), "hidden item vault should not be added to order");

// Test 3: folderDisplayName
console.log("  Testing folderDisplayName...");
assert.strictEqual(folderDisplayName({ id: "media", name: "Media" }), "Media");
assert.strictEqual(folderDisplayName({ id: "library", name: "Library" }), "Library");
assert.strictEqual(folderDisplayName({ id: "f_123", name: "My Stuff" }), "My Stuff");

// Test 4: navItemDef
console.log("  Testing navItemDef...");
ALL_NAV_IDS.forEach((id) => {
  const def = navItemDef(id);
  assert(def, "def should exist for " + id);
  assert(def.id === id, "def.id should match " + id);
  assert(typeof def.href === "string", "def.href should be string");
  assert(typeof def.active === "function", "def.active should be function");
});

// Test 5: renderNavLinks in normal desktop state
console.log("  Testing renderNavLinks output...");
STATE.settings.navCustom = DEFAULT_NAV_CUSTOM;
const html = renderNavLinks({ name: "home" });
assert(html.includes('href="#/"'), "must render Home link");
assert(html.includes('data-folder-id="media"'), "must render media folder");
assert(html.includes('data-folder-id="library"'), "must render library folder");
assert(!html.includes('open-nav-customize'), "the old greyed 'Customize sidebar' button must not come back (use the Customize row)");
assert(!html.includes('nav-customize-btn'), "the old greyed 'Customize sidebar' button must not come back");
assert(html.includes('nav-folder-caret'), "must render folder caret arrow");
assert(html.includes('nav-folder-rename-btn'), "must render folder rename pencil button");

// Test 6: folder toggle and expand
console.log("  Testing folder toggle...");
assert.strictEqual(getNavOpenFolders()["media"], undefined, "media folder initially undefined/closed");
toggleNavFolder("media");
assert.strictEqual(getNavOpenFolders()["media"], true, "media folder should now be open");
const htmlOpen = renderNavLinks({ name: "home" });
assert(htmlOpen.includes('data-folder-id="media"'), "renders folder");
assert(htmlOpen.includes('nav-folder-wrapper open'), "folder wrapper has open class");
assert(htmlOpen.includes('nav-folder-children open'), "folder children container has open class");
assert(htmlOpen.includes('href="#/music"'), "nested music item is rendered");

// Test 7: active child in closed folder shows active indicator
console.log("  Testing active child indicator in closed folder...");
toggleNavFolder("media"); // close it
assert.strictEqual(getNavOpenFolders()["media"], false, "media closed");
const htmlActive = renderNavLinks({ name: "tv" }); // route is tv, inside media folder
assert(htmlActive.includes('has-active'), "closed folder has has-active class");
assert(htmlActive.includes('nav-dot'), "closed folder shows nav-dot badge");

// Test 8: inline folder rename mode
console.log("  Testing inline folder rename...");
STATE.navEditingFolder = "media";
const htmlEditing = renderNavLinks({ name: "home" });
assert(htmlEditing.includes('class="nav-folder-rename-form"'), "renders inline rename form");
assert(htmlEditing.includes('id="nav-folder-rename-input"'), "renders inline rename input");
STATE.navEditingFolder = null;

console.log("All customizable sidebar navigation tests passed successfully!");

// Guard: the legacy greyed "Customize sidebar" entry and its old modal stay removed.
// Customize (data-act="customize-page") -> Edit menu (data-act="drawer-edit") is the only path.
console.log("  Checking the legacy Customize sidebar entry stays removed...");
const cssCode = fs.readFileSync("styles.css", "utf-8");
["open-nav-customize", "nav-customize-btn", "navCustomizeModal", "\"nav-customize\"", "nav-cust-", "nav-create-folder-submit", "nav-select-folder", "navNewFolderOpen", "Customize sidebar"].forEach((needle) => {
  assert(!appCode.includes(needle), "app.js must not bring back legacy sidebar customizer: " + needle);
});
["nav-customize-btn", "nav-cust-", "nav-customize-intro", "nav-new-folder-form", "nav-move-select"].forEach((needle) => {
  assert(!cssCode.includes(needle), "styles.css must not bring back legacy sidebar customizer CSS: " + needle);
});
["en", "es", "ru", "hi"].forEach((lang) => {
  const pack = fs.readFileSync("i18n/" + lang + ".js", "utf-8");
  assert(!pack.includes('"Customize sidebar"'), lang + " pack must not keep the legacy 'Customize sidebar' string");
});
assert(appCode.includes('if (id === "customize") return { id: id, href: "", icon: "sliders", label: tr("Customize"), locked: true, act: "customize-page" };'), "the white Customize row must stay in the menu");
assert(appCode.includes('data-act="drawer-edit"'), "the Customize page must keep its Edit menu row");
console.log("  Legacy entry guard OK");
