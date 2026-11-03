"use strict";

// Playwright entry used by scripts/smoke-all.sh. Without SMOKE_CDP this
// launches Chrome the same way a test asked. With SMOKE_CDP, tests that do
// not need their own browser share the shard's Chrome and each get a fresh
// context, so storage and service workers stay separate.

const realPath = process.env.SMOKE_PLAYWRIGHT_CORE;
if (!realPath) {
  throw new Error("SMOKE_PLAYWRIGHT_CORE is not set");
}
const real = require(realPath);
const BENIGN = new Set([
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--mute-audio"
]);

function canShare(options) {
  if (!process.env.SMOKE_CDP) return false;
  const opts = options || {};
  if (opts.executablePath) return false;
  const args = opts.args || [];
  return args.every((arg) => BENIGN.has(arg));
}

function wrapShared(browser) {
  const mine = new Set();
  return new Proxy(browser, {
    get(target, prop) {
      if (prop === "newContext") {
        return (options) => target.newContext(options).then((ctx) => {
          mine.add(ctx);
          return ctx;
        });
      }
      if (prop === "newPage") {
        return (options) => target.newContext(options || {}).then((ctx) => {
          mine.add(ctx);
          return ctx.newPage();
        });
      }
      if (prop === "close") {
        return () => Promise.all([...mine].map((ctx) => Promise.resolve(ctx.close()).catch(() => {}))).then(() => {
          mine.clear();
        });
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function launch(options) {
  if (!canShare(options)) return real.chromium.launch(options);
  return real.chromium.connectOverCDP(process.env.SMOKE_CDP).then(wrapShared);
}

const chromium = new Proxy(real.chromium, {
  get(target, prop) {
    if (prop === "launch") return launch;
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  }
});

const api = {
  chromium,
  webkit: real.webkit,
  firefox: real.firefox,
  devices: real.devices,
  selectors: real.selectors,
  errors: real.errors,
  request: real.request
};
api.default = api;
module.exports = api;
