/* Regression tests for the existing Shorts pinch, double-tap, wheel and pan zoom.
   The helper is the one the For you feed and the live player already share.
   These checks lock that behavior before later player work. */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const storage = {};
globalThis.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; }
};
globalThis.location = { href: "http://localhost:8080/#/shorts", hash: "#/shorts", search: "", pathname: "/" };
try {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "test", plugins: [] }, configurable: true });
} catch (err) { /* the host navigator is enough to load the player */ }
globalThis.window = globalThis;
globalThis.t = (k) => k;
globalThis.document = {
  body: { appendChild: () => {} },
  documentElement: { classList: { add() {}, remove() {}, contains() { return false; } } },
  createElement: () => ({ setAttribute() {}, getAttribute() { return null; }, querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {} } }),
  getElementById: () => null,
  querySelectorAll: () => [],
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {}
};

eval(fs.readFileSync(new URL("../shorts.js", import.meta.url), "utf8"));
const bindZoom = globalThis.ViktorychShorts.bindZoom;

function pointer(id, x, y) {
  return {
    pointerId: id,
    clientX: x,
    clientY: y,
    target: { closest: () => null },
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; }
  };
}

function stageBox() {
  const video = { style: { transform: "" }, width: 1080, height: 1920 };
  const listeners = {};
  const stage = {
    clientWidth: 200,
    clientHeight: 400,
    className: "",
    video,
    classList: {
      toggle(name, on) { stage.className = on ? name : ""; }
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 400 }),
    querySelectorAll: () => [video],
    querySelector: () => null,
    closest: () => null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    setPointerCapture() {},
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event)); }
  };
  const zoom = bindZoom(stage);
  return { stage, video, zoom };
}

test("zoom starts at 1x and only transforms the picture, never its pixel size", () => {
  const { video, zoom } = stageBox();
  assert.equal(zoom.scale(), 1);
  assert.equal(video.style.transform, "");
  assert.equal(video.width, 1080);
  assert.equal(video.height, 1920);
});

test("a trackpad pinch zooms between 1x and 5x and a reset clears it", () => {
  const { stage, video, zoom } = stageBox();
  stage.fire("wheel", pointer(0, 0, 0) && Object.assign(pointer(0, 100, 100), { ctrlKey: true, deltaY: -400 }));
  assert.ok(zoom.scale() > 1);
  assert.match(video.style.transform, /translate3d\(/);
  assert.match(video.style.transform, /scale\(/);
  assert.equal(video.width, 1080);
  const huge = Object.assign(pointer(0, 100, 100), { ctrlKey: true, deltaY: -5000 });
  stage.fire("wheel", huge);
  assert.equal(zoom.scale(), 5);
  zoom.reset();
  assert.equal(zoom.scale(), 1);
  assert.equal(video.style.transform, "");
});

test("a double tap zooms to 2.5 toward the point and the next double tap resets", () => {
  const { stage, zoom } = stageBox();
  function tap(x, y) {
    stage.fire("pointerdown", pointer(1, x, y));
    stage.fire("pointerup", pointer(1, x, y));
  }
  tap(150, 100);
  tap(150, 100);
  assert.equal(zoom.scale(), 2.5);
  assert.equal(zoom.takeGesture(), "double");
  tap(150, 100);
  tap(150, 100);
  assert.equal(zoom.scale(), 1);
});

test("while zoomed, a drag pans and is not a navigation gesture", () => {
  const { stage, video, zoom } = stageBox();
  stage.fire("wheel", Object.assign(pointer(0, 100, 100), { ctrlKey: true, deltaY: -300 }));
  assert.ok(zoom.scale() > 1);
  const before = video.style.transform;
  const down = pointer(7, 40, 80);
  stage.fire("pointerdown", down);
  const move = pointer(7, 70, 110);
  stage.fire("pointermove", move);
  assert.equal(move.defaultPrevented, true);
  assert.equal(move.stopped, true);
  assert.notEqual(video.style.transform, before);
  stage.fire("pointerup", pointer(7, 70, 110));
  assert.equal(zoom.takeGesture(), "drag");
  assert.equal(video.width, 1080);
});

test("a two-finger pinch changes scale and reports pinch instead of a swipe", () => {
  const { stage, zoom } = stageBox();
  stage.fire("pointerdown", pointer(1, 40, 80));
  stage.fire("pointerdown", pointer(2, 80, 80));
  const spread = pointer(2, 160, 80);
  stage.fire("pointermove", spread);
  assert.equal(spread.defaultPrevented, true);
  assert.ok(zoom.scale() > 1);
  stage.fire("pointerup", pointer(2, 160, 80));
  stage.fire("pointerup", pointer(1, 40, 80));
  assert.equal(zoom.takeGesture(), "pinch");
});
