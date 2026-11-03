/* The latest address wins. A paint that started on Home must not stay
   once the hash is Settings, and a dropped hashchange must ask for
   another render. These are the functions app.js uses. */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function grab(name) {
  const key = "function " + name + "(";
  const start = src.indexOf(key);
  if (start < 0) throw new Error("missing " + name);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unclosed " + name);
}

const sandbox = {};
vm.runInNewContext(
  grab("routePaintMismatch") + "\n" + grab("routePaintDecision") + "\n" +
  grab("homeLoadingShell") + "\n" + grab("commitFrameDecision") + "\n" +
  "this.routePaintMismatch = routePaintMismatch; this.routePaintDecision = routePaintDecision;" +
  "this.homeLoadingShell = homeLoadingShell; this.commitFrameDecision = commitFrameDecision;",
  sandbox
);
const { routePaintMismatch, routePaintDecision, homeLoadingShell, commitFrameDecision } = sandbox;

assert.equal(routePaintMismatch("#/", "#/settings"), true);
assert.equal(routePaintMismatch("#/settings", "#/settings"), false);
assert.equal(routePaintMismatch("", "#/"), false);

let state = { token: 0, painted: "#/" };
state = routePaintDecision(state, { type: "hash", hash: "#/settings" });
assert.equal(state.token, 1);
assert.equal(state.render, true);
assert.equal(state.reason, "hash");

const staleHome = routePaintDecision(state, { type: "finish", token: 1, paintedHash: "#/", hash: "#/settings" });
assert.equal(staleHome.render, true);
assert.equal(staleHome.reason, "mismatch");
assert.equal(staleHome.painted, "#/");

const caughtUp = routePaintDecision(staleHome, { type: "finish", token: staleHome.token, paintedHash: "#/settings", hash: "#/settings" });
assert.equal(caughtUp.render, false);
assert.equal(caughtUp.reason, "ok");
assert.equal(caughtUp.painted, "#/settings");

const newer = routePaintDecision(state, { type: "hash", hash: "#/settings" });
const dropped = routePaintDecision(newer, { type: "finish", token: state.token, paintedHash: "#/", hash: "#/settings" });
assert.equal(dropped.render, true);
assert.equal(dropped.reason, "stale");
assert.equal(dropped.painted, "#/");
assert.equal(routePaintDecision(dropped, { type: "check", hash: "#/settings" }).render, true);

assert.ok(src.includes("if (token !== routePaintState.token)"), "a dropped hashchange must notice the newer token");
assert.ok(src.includes("followRoute()"), "a mismatch must schedule another render");
assert.ok(src.includes("noteRoutePaint(paintedHash)"), "a finished paint must record the hash it drew");
assert.ok(src.includes("homeLoadingShell(route, STATE.loading)"), "the Home skeleton must not run for every route");
assert.ok(src.includes("commitFrameDecision("), "commit must check the render token and the live hash");
assert.ok(src.includes("if (!routeDomReady)"), "a corrective render must wait until DOMContentLoaded");
assert.ok(src.includes("routeCorrectiveToken = -1"), "the first hash can still schedule its one corrective render");
assert.ok(src.includes("routeCorrectiveToken === token"), "one hash change gets one corrective render");
assert.ok(src.includes("decision.reason !== \"stale-hash\""), "a stale frame is discarded and the current hash is built once");
assert.ok(src.includes("requestAnimationFrame(() => queueMicrotask(run))"), "the corrective render is async");
assert.equal(src.includes('if (parseRoute().name !== "home") render()'), false, "boot must not render Settings before the document loads");

assert.equal(homeLoadingShell({ name: "home" }, true), true);
assert.equal(homeLoadingShell({ name: "settings" }, true), false);
assert.equal(homeLoadingShell({ name: "home" }, false), false);

const homeFrame = { token: 1, builtHash: "#/" };
const afterSettings = { renderGen: 2, hash: "#/settings" };
assert.equal(commitFrameDecision(homeFrame, afterSettings).commit, false);
assert.equal(commitFrameDecision(homeFrame, afterSettings).reason, "stale-token");
assert.equal(commitFrameDecision({ token: 2, builtHash: "#/" }, afterSettings).reason, "stale-hash");
const kept = commitFrameDecision({ token: 2, builtHash: "#/settings" }, afterSettings);
assert.equal(kept.commit, true);
assert.equal(kept.hash, "#/settings");

console.log("route paint ok");
