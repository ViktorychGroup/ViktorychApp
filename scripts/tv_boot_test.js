/* TV detection, the light defaults, the in-app flag, and the APK wiring. No browser. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "shared", "tv-boot.js"), "utf8");

function store() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}

function boot(opts) {
  const classes = new Set();
  const win = {
    navigator: { userAgent: opts.ua, maxTouchPoints: opts.touch ? 5 : 0 },
    location: { search: opts.search || "", hash: opts.hash || "#/home" },
    innerWidth: opts.w || 1920,
    innerHeight: opts.h || 1080,
    localStorage: opts.local || store(),
    sessionStorage: store(),
    matchMedia: (q) => ({ matches: /pointer: fine/.test(q) ? !!opts.fine : false }),
    document: {
      referrer: opts.referrer || "",
      documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) } }
    }
  };
  vm.runInNewContext(SRC, { window: win, globalThis: win, JSON, Object, Number, String, RegExp });
  return { tv: win.ViktorychTVMode, classes, win };
}

const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UAS = {
  googletv: "Mozilla/5.0 (Linux; Android 12; Chromecast Build/STTE.230319.008) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  androidtv: "Mozilla/5.0 (Linux; Android 11; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0 Safari/537.36",
  bravia: "Mozilla/5.0 (Linux; Android 10; BRAVIA 4K UR3 Build/QTG3.201102.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0 Mobile Safari/537.36",
  firetv: "Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/112.3.1 like Chrome/112.0 Safari/537.36",
  tizen: "Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/5.0 Chrome/85.0 TV Safari/537.36",
  webos: "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0 Safari/537.36 WebAppManager",
  crkey: "Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0 Safari/537.36 CrKey/1.56.500000"
};

// Every TV family turns TV mode on; only Android ones get the APK card.
for (const [name, ua] of Object.entries(UAS)) {
  const { tv, classes } = boot({ ua, fine: true });
  assert.strictEqual(tv.on, true, name + " is a TV");
  assert.ok(classes.has("tv-on") && classes.has("tv-calm") && classes.has("tv-flat"), name + " gets the light classes");
  const android = name !== "tizen" && name !== "webos";
  assert.strictEqual(tv.isAndroidTv(), android, name + " Android TV detection");
}

// Desktop stays off, and the light defaults only apply in TV mode.
{
  const { tv, classes } = boot({ ua: DESKTOP, fine: true });
  assert.strictEqual(tv.on, false);
  assert.strictEqual(classes.has("tv-on"), false);
  assert.strictEqual(tv.pref("calm"), false);
  assert.strictEqual(tv.pref("autoplay"), "on");
}

// Defaults: every light option on, autoplay off. The user can change each one.
{
  const local = store();
  const { tv, classes } = boot({ ua: UAS.googletv, local });
  for (const key of Object.keys(tv.DEFAULTS)) assert.ok(tv.pref(key), key + " has a TV default");
  assert.strictEqual(tv.pref("autoplay"), "off");
  tv.setPref("calm", false);
  tv.setPref("autoplay", "muted");
  assert.strictEqual(classes.has("tv-calm"), false, "Reduce motion turns off");
  const again = boot({ ua: UAS.googletv, local }).tv;
  assert.strictEqual(again.pref("calm"), false, "the choice is kept");
  assert.strictEqual(again.pref("autoplay"), "muted");
  again.resetPrefs();
  assert.strictEqual(boot({ ua: UAS.googletv, local }).tv.pref("calm"), true, "reset brings the TV defaults back");
  // First TV start seeds the Light device level once, and never overrides a choice.
  assert.strictEqual(JSON.parse(local.getItem("viktorychapp-device-performance-v1")).level, "light");
  local.setItem("viktorychapp-device-performance-v1", JSON.stringify({ level: "max" }));
  boot({ ua: UAS.googletv, local });
  assert.strictEqual(JSON.parse(local.getItem("viktorychapp-device-performance-v1")).level, "max");
}

// Manual switch and URL flag.
{
  const local = store();
  const first = boot({ ua: DESKTOP, fine: true, local }).tv;
  first.setMode("on");
  assert.strictEqual(boot({ ua: DESKTOP, fine: true, local }).tv.on, true, "Settings > TV mode On sticks");
  first.setMode("off");
  assert.strictEqual(boot({ ua: UAS.tizen, local }).tv.on, false, "Off wins over a TV user agent");
  assert.strictEqual(boot({ ua: DESKTOP, fine: true, search: "?tv=1" }).tv.on, true, "?tv=1 forces it on");
}

// Inside the installed app: TV mode on, version remembered, survives a reload without the query.
{
  const local = store();
  const { tv } = boot({ ua: "Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/120 Safari/537.36", search: "?tv=1&src=tvapp&tvapp=3", local, touch: false });
  assert.strictEqual(tv.inApp(), true);
  assert.strictEqual(tv.appVersion(), 3);
  const later = boot({ ua: "Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/120 Safari/537.36", local, w: 960, h: 540, fine: true }).tv;
  assert.strictEqual(later.on, true, "a reload inside the app stays in TV mode");
  const twa = boot({ ua: UAS.googletv, referrer: "android-app://app.viktorych.tv/" }).tv;
  assert.strictEqual(twa.inApp(), true, "the TWA referrer counts as the app");
}

// Wiring: the files the APK and assetlinks need are published, and the APK build matches.
{
  const assemble = fs.readFileSync(path.join(ROOT, "scripts", "assemble_site.py"), "utf8");
  for (const f of [".well-known/assetlinks.json", "tv/index.html", "tv/version.json", "tv/ViktorychTV.apk", "tv/qr.svg"]) {
    assert.ok(assemble.includes('"' + f + '"'), f + " is published");
    assert.ok(fs.existsSync(path.join(ROOT, f)), f + " is in the checkout");
  }
  const links = JSON.parse(fs.readFileSync(path.join(ROOT, ".well-known", "assetlinks.json"), "utf8"));
  assert.strictEqual(links[0].target.package_name, "app.viktorych.tv");
  assert.ok(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(links[0].target.sha256_cert_fingerprints[0]));
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "tv", "version.json"), "utf8"));
  const gradle = fs.readFileSync(path.join(ROOT, "android-tv", "app", "build.gradle"), "utf8");
  assert.strictEqual(Number((/def appVersion = (\d+)/.exec(gradle) || [])[1]), version.versionCode, "tv/version.json matches the APK version");
  assert.ok(/tvapp=" \+ appVersion/.test(gradle), "the APK tells the site its version");
  const manifest = fs.readFileSync(path.join(ROOT, "android-tv", "app", "src", "main", "AndroidManifest.xml"), "utf8");
  assert.ok(manifest.includes("LEANBACK_LAUNCHER") && manifest.includes("android:banner") && /touchscreen" android:required="false"/.test(manifest));
  const png = fs.readFileSync(path.join(ROOT, "android-tv", "app", "src", "main", "res", "drawable-xhdpi", "banner.png"));
  assert.strictEqual(png.readUInt32BE(16), 320, "banner is 320 wide");
  assert.strictEqual(png.readUInt32BE(20), 180, "banner is 180 tall");
  const ignore = fs.readFileSync(path.join(ROOT, "android-tv", ".gitignore"), "utf8");
  assert.ok(/\*\.jks/.test(ignore), "keystores are ignored");
  const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  assert.ok(sw.includes("\\.apk$") && sw.includes("/.well-known/"), "the service worker leaves the APK and assetlinks to the network");
}

{
  // Optional TV home screen: the site links to the app's defaults screen only for TV app 1.4.0+,
  // and the home activity ships disabled so nothing changes until the user picks it.
  const tv = fs.readFileSync(path.join(ROOT, "tv.js"), "utf8");
  const manifest = fs.readFileSync(path.join(ROOT, "android-tv/app/src/main/AndroidManifest.xml"), "utf8");
  assert.ok(/appVersion\(\) >= 5\)[\s\S]{0,600}intent:\/\/defaults#Intent;scheme=viktorychtv;/.test(tv), "the site opens the TV defaults screen only from a TV app that has it");
  assert.ok(manifest.includes('android:scheme="viktorychtv"') && manifest.includes('android:host="defaults"'), "the TV app answers viktorychtv://defaults");
  const home = /<activity[^>]*launcher\.HomeActivity[^>]*>/.exec(manifest);
  assert.ok(home && home[0].includes('android:enabled="false"'), "the TV home screen ships turned off");
}

{
  // Optional player and screensaver (TV app 1.5.0+): both ship turned off, and the
  // site only offers the screensaver hand-off to an app that has it.
  const tv = fs.readFileSync(path.join(ROOT, "tv.js"), "utf8");
  const manifest = fs.readFileSync(path.join(ROOT, "android-tv/app/src/main/AndroidManifest.xml"), "utf8");
  const player = /<activity[^>]*player\.PlayerActivity[^>]*>/.exec(manifest);
  assert.ok(player && player[0].includes('android:enabled="false"'), "the player ships turned off");
  const dream = /<service[^>]*player\.FeedDream[^>]*>/.exec(manifest);
  assert.ok(dream && dream[0].includes('android:enabled="false"') && dream[0].includes("BIND_DREAM_SERVICE"), "the screensaver ships turned off and only the system can bind it");
  assert.ok(manifest.includes('android:host="dream"'), "the TV app answers viktorychtv://dream");
  assert.ok(/appVersion\(\) >= 6\)[\s\S]{0,900}dreamLink\(b\)/.test(tv), "the screensaver hand-off is only offered to TV app 1.5.0+");
  assert.ok(/intent:\/\/dream\?d=" \+ encodeURIComponent\(/.test(tv), "the hand-off is encoded");
}

{
  // Optional remote keyboard and feed search (TV app 1.6.0+): all ship turned off, only the
  // system can bind the keyboard, and the app never asks for the microphone itself.
  const manifest = fs.readFileSync(path.join(ROOT, "android-tv/app/src/main/AndroidManifest.xml"), "utf8");
  const ime = /<service[^>]*ime\.TvKeyboard[^>]*>/.exec(manifest);
  assert.ok(ime && ime[0].includes('android:enabled="false"') && ime[0].includes("BIND_INPUT_METHOD"), "the keyboard ships turned off and only the system can bind it");
  const search = /<activity[^>]*search\.SearchActivity[^>]*>/.exec(manifest);
  assert.ok(search && search[0].includes('android:enabled="false"'), "feed search ships turned off");
  const provider = /<provider[^>]*search\.SuggestProvider[^>]*>/.exec(manifest);
  assert.ok(provider && provider[0].includes('android:enabled="false"'), "search suggestions ship turned off");
  assert.ok(!manifest.includes("android.permission.RECORD_AUDIO"), "voice typing goes through the system recognizer, not our own microphone access");
}

{
  // Optional Photos and Files (TV app 1.7.0+): ship turned off, the file provider is never
  // exported, and the app only reads storage (no write or manage-all-files access).
  const manifest = fs.readFileSync(path.join(ROOT, "android-tv/app/src/main/AndroidManifest.xml"), "utf8");
  for (const name of ["GalleryActivity", "PhotoActivity", "FilesActivity"]) {
    const a = new RegExp(`<activity[^>]*files\\.${name}[^>]*>`).exec(manifest);
    assert.ok(a && a[0].includes('android:enabled="false"'), `${name} ships turned off`);
  }
  const share = /<provider[^>]*files\.ShareProvider[^>]*>/.exec(manifest);
  assert.ok(share && share[0].includes('android:enabled="false"') && share[0].includes('android:exported="false"') && share[0].includes('android:grantUriPermissions="true"'), "the file provider ships off, unexported, per-file grants only");
  assert.ok(!/WRITE_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE/.test(manifest), "Files and Photos are read only");
  for (const name of ["GalleryActivity", "FilesActivity"]) {
    const a = new RegExp(`<activity[^>]*files\\.${name}[^>]*>`).exec(manifest);
    assert.ok(a[0].includes('android:exported="false"'), `${name} opens only from our own home and defaults screens`);
  }
}

console.log("tv boot checks passed");
