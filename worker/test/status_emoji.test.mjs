import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { storeItem, STATUS_EMOJIS, statusEmojiByChar } from "../../shared/store-catalog.js";

const WEBHOOK_SECRET = "whsec_test_only";
const stripeCalls = [];

function workerOptions(extra) {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: Object.assign({
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "user_owner",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000"
    }, extra || {}),
    outboundService: async (request) => {
      const url = new URL(request.url);
      const body = await request.text();
      stripeCalls.push({ path: url.pathname, body });
      if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions") {
        return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
      }
      if (url.hostname === "api.stripe.com" && url.pathname === "/v1/refunds") return Response.json({ id: "re_test_1" });
      return new Response("not found", { status: 404 });
    }
  };
}

let nextIp = 30;
function caller(mf) {
  return async function call(path, opts) {
    opts = opts || {};
    const headers = new Headers(opts.headers || {});
    headers.set("CF-Connecting-IP", opts.ip || "203.0." + Math.floor(nextIp / 250) + "." + (1 + (nextIp++ % 250)));
    if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
    if (opts.body && !opts.raw) headers.set("content-type", "application/json");
    const res = await mf.dispatchFetch("https://accounts.test" + path, {
      method: opts.method || "GET",
      headers,
      body: opts.raw != null ? opts.raw : opts.body ? JSON.stringify(opts.body) : undefined
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (err) { body = { raw: text }; }
    return { status: res.status, body };
  };
}

async function signup(call, handle, ip, claimCode) {
  const created = await call("/v1/signup", { method: "POST", ip, body: { displayName: "Member", handle, claimCode } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

test("status emojis: Viktorych-only catalog entries matched by character", () => {
  assert.ok(STATUS_EMOJIS.length >= 8);
  STATUS_EMOJIS.forEach((item) => {
    const priced = storeItem("emoji", item.id);
    assert.equal(priced.kind, "emoji");
    assert.equal(priced.cents, 0, "no money price for Unicode emoji");
    assert.ok(priced.viktorychs > 0);
  });
  assert.equal(statusEmojiByChar("\u{1F451}\uFE0F").id, "regal");
  assert.equal(statusEmojiByChar("\u{1F600}"), null);
});

test("status emojis are bought or gifted in the store, and status has its own audience", async () => {
  const mf = new Miniflare(workerOptions());
  try {
    const call = caller(mf);
    const owner = await signup(call, "user_owner", "198.51.100.41", "claim-test");
    const ada = await signup(call, "user_ea", "198.51.100.42");
    const bea = await signup(call, "user_eb", "198.51.100.43");
    const cy = await signup(call, "user_ec", "198.51.100.44");

    const catalog = await call("/v1/store/catalog", { token: ada.token });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.emojis.length, STATUS_EMOJIS.length);
    assert.ok(catalog.body.emojis.every((item) => item.owned === false));

    // A store emoji you don't own can't be your status; any other emoji can.
    const locked = await call("/v1/presence", { method: "PATCH", token: ada.token, body: { status: { emoji: "\u{1F451}", text: "", clear: "never" } } });
    assert.equal(locked.status, 403);
    assert.equal(locked.body.error, "owned");
    const plain = await call("/v1/presence", { method: "PATCH", token: ada.token, body: { status: { emoji: "\u{1F600}", text: "hi", clear: "never" } } });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.equal(plain.body.statusAudience, "everyone");

    // No balance: refused with 402 and no money path.
    const poor = await call("/v1/store/buy", { method: "POST", token: ada.token, body: { kind: "emoji", itemId: "regal" } });
    assert.equal(poor.status, 402);
    const card = await call("/v1/store/checkout", { method: "POST", token: ada.token, body: { kind: "emoji", itemId: "regal", accept: true } });
    assert.ok(card.status === 503 || card.status === 400, "no card path for status emojis");

    await call("/v1/viktorychs/grant", { method: "POST", token: owner.token, body: { handle: "user_ea", amount: 500 } });
    const bought = await call("/v1/store/buy", { method: "POST", token: ada.token, body: { kind: "emoji", itemId: "regal" } });
    assert.equal(bought.status, 201, JSON.stringify(bought.body));
    assert.equal(bought.body.balance, 500 - storeItem("emoji", "regal").viktorychs);
    const again = await call("/v1/store/buy", { method: "POST", token: ada.token, body: { kind: "emoji", itemId: "regal" } });
    assert.equal(again.status, 409);
    const mine = await call("/v1/store/catalog", { token: ada.token });
    assert.equal(mine.body.emojis.find((item) => item.id === "regal").owned, true);

    // Gift one to another account.
    const gift = await call("/v1/store/buy", { method: "POST", token: ada.token, body: { kind: "emoji", itemId: "rocket", handle: "user_eb", message: "for you" } });
    assert.equal(gift.status, 201, JSON.stringify(gift.body));
    const theirs = await call("/v1/store/catalog", { token: bea.token });
    assert.equal(theirs.body.emojis.find((item) => item.id === "rocket").owned, true);
    const twice = await call("/v1/store/buy", { method: "POST", token: ada.token, body: { kind: "emoji", itemId: "rocket", handle: "user_eb" } });
    assert.equal(twice.status, 409);

    // Owned emoji works; audience "followers" hides it from non-followers only.
    const crowned = await call("/v1/presence", { method: "PATCH", token: ada.token, body: { status: { emoji: "\u{1F451}", text: "busy", clear: "never", audience: "followers" } } });
    assert.equal(crowned.status, 200, JSON.stringify(crowned.body));
    assert.equal(crowned.body.emoji, "\u{1F451}");
    assert.equal(crowned.body.statusAudience, "followers");
    const badAudience = await call("/v1/presence", { method: "PATCH", token: ada.token, body: { status: { emoji: "", audience: "planet" } } });
    assert.equal(badAudience.status, 400);

    const follow = await call("/v1/follows", { method: "PUT", token: bea.token, body: { id: "app:" + ada.account.publicId } });
    assert.equal(follow.status, 200, JSON.stringify(follow.body));
    const seen = await call("/v1/presence?ids=" + ada.account.publicId, { token: bea.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.presence[0].emoji, "\u{1F451}");
    assert.equal(seen.body.presence[0].text, "busy");
    const hidden = await call("/v1/presence?ids=" + ada.account.publicId, { token: cy.token });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.presence[0].emoji, "");
    assert.equal(hidden.body.presence[0].text, "");

    // Nobody: hidden from followers too; the owner still sees it.
    await call("/v1/presence", { method: "PATCH", token: ada.token, body: { status: { emoji: "\u{1F451}", text: "busy", clear: "never", audience: "nobody" } } });
    const none = await call("/v1/presence?ids=" + ada.account.publicId, { token: bea.token });
    assert.equal(none.body.presence[0].emoji, "");
    const self = await call("/v1/presence", { token: ada.token });
    assert.equal(self.body.emoji, "\u{1F451}");
    assert.equal(self.body.statusAudience, "nobody");

    // The audience can change on its own; the emoji stays.
    const opened = await call("/v1/presence", { method: "PATCH", token: ada.token, body: { statusAudience: "everyone" } });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.emoji, "\u{1F451}");
    const back = await call("/v1/presence?ids=" + ada.account.publicId, { token: cy.token });
    assert.equal(back.body.presence[0].emoji, "\u{1F451}");
    await call("/v1/presence", { method: "PATCH", token: ada.token, body: { statusAudience: "nobody" } });

    // Clearing the status keeps the audience choice.
    const cleared = await call("/v1/presence", { method: "PATCH", token: ada.token, body: { status: null } });
    assert.equal(cleared.body.emoji, "");
    assert.equal(cleared.body.statusAudience, "nobody");
  } finally {
    await mf.dispose();
  }
});
