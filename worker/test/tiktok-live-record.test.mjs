import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const dispatches = [];
let pageMode = "offline";
let mf;

const LIVE_HTML = '<script id="SIGI_STATE">{"LiveRoom":{"liveRoomUserInfo":{"user":{"roomId":"7100000000000000002"}}}}</script>';

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: {
      ACCOUNT_PEPPER: "pepper-test",
      OWNER_CLAIM_CODE: "claim-test",
      OWNER_HANDLE: "owner_test",
      ALLOWED_ORIGINS: "https://viktorychgroup.github.io,http://127.0.0.1:8080",
      PBKDF2_ITERATIONS: "1000",
      GITHUB_DISPATCH_TOKEN: "dispatch-test"
    },
    async outboundService(request) {
      const url = new URL(request.url);
      if (url.hostname === "api.github.com") {
        dispatches.push(url.pathname);
        return new Response(null, { status: 204 });
      }
      if (url.hostname === "webcast.tiktok.com") {
        const hls = "https://pull-hls.tiktokcdn.com/origin/index.m3u8";
        const body = {
          data: {
            status: 2,
            user_count: 4,
            title: "fixture",
            stream_url: {
              live_core_sdk_data: {
                pull_data: {
                  stream_data: JSON.stringify({ data: { origin: { main: { hls, flv: hls.replace(".m3u8", ".flv") } } } })
                }
              }
            }
          }
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "www.tiktok.com" || url.hostname === "tiktok.com") {
        const html = pageMode === "live" ? LIVE_HTML : "offline";
        return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("no", { status: 404 });
    }
  };
}

async function call(path, opts) {
  opts = opts || {};
  const headers = new Headers();
  headers.set("CF-Connecting-IP", opts.ip || "203.0.113.40");
  if (opts.token) headers.set("Authorization", "Bearer " + opts.token);
  if (opts.body) headers.set("content-type", "application/json");
  const res = await mf.dispatchFetch("https://accounts.test" + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch (err) { body = { raw: text }; }
  return { status: res.status, body, text };
}

function count(name) {
  return dispatches.filter((path) => path.indexOf("/" + name + "/dispatches") >= 0).length;
}

// A fixed UTC minute, so the cron's quarter-hour Discord check does not depend
// on the wall clock. :00/:15/:30/:45 ask whether that workflow is busy; other
// minutes do not.
function atMinute(minute) {
  return Date.UTC(2026, 0, 15, 12, minute, 30);
}

const DISCORD_BUSY_CHECK = "/repos/ViktorychGroup/ViktorychApp/actions/workflows/discord-live.yml/runs";

async function cronWhilePaused(worker, minute) {
  const uploads = count("tiktok-live-upload.yml");
  const records = count("tiktok-record.yml");
  const discordJobs = count("discord-live.yml");
  const mark = dispatches.length;
  await worker.scheduled({ cron: "* * * * *", scheduledTime: atMinute(minute) });
  const added = dispatches.slice(mark);
  const label = "minute " + minute;
  assert.equal(count("tiktok-live-upload.yml"), uploads, label + ": pause holds the upload job");
  assert.equal(count("tiktok-record.yml"), records, label + ": recording stays off");
  assert.equal(count("discord-live.yml"), discordJobs, label + ": the discord mirror is not dispatched");
  assert.equal(added.some((path) => path.endsWith("/dispatches")), false, label + ": no workflow is started");
  if (minute % 15 === 0) {
    assert.deepEqual(added, [DISCORD_BUSY_CHECK], label + ": only the discord busy check runs");
  } else {
    assert.deepEqual(added, [], label + ": no github calls");
  }
}

test.before(async () => {
  mf = new Miniflare(workerOptions());
});

test.after(async () => {
  if (mf) await mf.dispose();
});

test("settings keep the recorder switch on the existing preference", () => {
  const accounts = readFileSync(fileURLToPath(new URL("../../accounts.js", import.meta.url)), "utf8");
  const app = readFileSync(fileURLToPath(new URL("../../app.js", import.meta.url)), "utf8");
  const flags = readFileSync(fileURLToPath(new URL("../src/feature-flags.js", import.meta.url)), "utf8");
  assert.match(accounts, /\/v1\/owner\/live-record/);
  assert.match(accounts, /toggle-live-record/);
  assert.match(accounts, /toggle-upload-pause/);
  assert.match(accounts, /uploadsPaused: liveRecord\.uploadsPaused === true/);
  assert.match(accounts, /Always-on recorder is running\. Saved lives stay under Past lives\./);
  assert.match(accounts, /Always-on recorder is not running\./);
  assert.equal(accounts.indexOf("MediaRecorder"), -1);
  assert.equal(accounts.indexOf("new MediaRecorder"), -1);
  assert.match(app, /"tiktok_auto_record"/);
  assert.match(flags, /tiktok_auto_record:\s*\{ paths: \["\/v1\/owner\/live-record"\] \}/);
  assert.equal(/tiktok_auto_record:[\s\S]*defaultOff:\s*true/.test(flags.slice(flags.indexOf("tiktok_auto_record:"), flags.indexOf("tiktok_auto_record:") + 240)), false);
});

test("the owner can enable recording and pause uploads without a browser capture", async () => {
  const owner = await call("/v1/signup", {
    method: "POST",
    ip: "203.0.113.41",
    body: { displayName: "Owner", handle: "owner_test", claimCode: "claim-test" }
  });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  const token = owner.body.token;
  const stranger = await call("/v1/signup", {
    method: "POST",
    ip: "203.0.113.42",
    body: { displayName: "Member", handle: "member_test" }
  });
  assert.equal(stranger.status, 201);

  const anon = await call("/v1/owner/live-record", { ip: "203.0.113.43" });
  assert.equal(anon.status, 401);
  const denied = await call("/v1/owner/live-record", { ip: "203.0.113.44", token: stranger.body.token });
  assert.equal(denied.status, 403);

  const fresh = await call("/v1/owner/live-record", { ip: "203.0.113.45", token });
  assert.equal(fresh.status, 200);
  assert.deepEqual(fresh.body, { server: false, uploadsPaused: false, alwaysOn: false });
  assert.equal(JSON.stringify(fresh.body).includes("fixture"), false);

  const listed = await call("/v1/features");
  assert.equal(listed.body.off.includes("tiktok_auto_record"), false);

  const on = await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.46",
    token,
    body: { server: true, auto: true }
  });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { server: true, uploadsPaused: false, alwaysOn: false });
  assert.equal(on.text.indexOf("auto"), -1);

  const paused = await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.47",
    token,
    body: { uploadsPaused: true }
  });
  assert.deepEqual(paused.body, { server: true, uploadsPaused: true, alwaysOn: false });

  const bad = await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.48",
    token,
    body: { server: "yes" }
  });
  assert.equal(bad.status, 400);

  const bindings = await mf.getBindings();
  const stored = JSON.parse(await (await bindings.DATA.get("owner/live-record.json")).text());
  assert.deepEqual(stored, { server: true, uploadsPaused: true });

  await bindings.DATA.put("owner/tiktok.json", JSON.stringify({
    live: { fixture_live: { handle: "fixture_live", live: false } }
  }));
  await bindings.DATA.put("owner/live-jobs/fixture_live.json", JSON.stringify({
    handle: "fixture_live",
    active: { state: "recording", captureDone: true, segments: 2, capturing: false, needsPart: false },
    saved: []
  }));
  await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.49",
    token,
    body: { server: false, uploadsPaused: false }
  });

  const worker = await mf.getWorker();
  dispatches.length = 0;
  await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() });
  assert.equal(count("tiktok-live-upload.yml"), 1, "a finished capture still uploads");
  assert.equal(count("tiktok-record.yml"), 0, "recording stays off until the owner enables it");

  await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.50",
    token,
    body: { uploadsPaused: true }
  });
  await cronWhilePaused(worker, 10);
  await cronWhilePaused(worker, 0);
  await cronWhilePaused(worker, 15);
  await cronWhilePaused(worker, 30);
  await cronWhilePaused(worker, 45);

  await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.51",
    token,
    body: { server: true, uploadsPaused: false }
  });
  pageMode = "live";
  const doc = JSON.parse(await (await bindings.DATA.get("owner/tiktok.json")).text());
  doc.live.fixture_open = { handle: "fixture_open", live: false };
  await bindings.DATA.put("owner/tiktok.json", JSON.stringify(doc));
  const beforeRecord = count("tiktok-record.yml");
  await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() + 2000 });
  assert.ok(count("tiktok-record.yml") > beforeRecord, "server recording starts a capture job");
  assert.ok(count("tiktok-live-upload.yml") > 1, "resume starts the uploader again");

  const beatWhen = Date.now() + 3000;
  const yieldDoc = JSON.parse(await (await bindings.DATA.get("owner/tiktok.json")).text());
  yieldDoc.live.fixture_yield = { handle: "fixture_yield", live: false };
  await bindings.DATA.put("owner/tiktok.json", JSON.stringify(yieldDoc));
  await bindings.DATA.put("owner/live-runner.json", JSON.stringify({
    runner: "always-on",
    at: new Date(beatWhen).toISOString()
  }));
  const beforeYield = count("tiktok-record.yml");
  const beforeYieldUploads = count("tiktok-live-upload.yml");
  await worker.scheduled({ cron: "* * * * *", scheduledTime: beatWhen + 1000 });
  assert.equal(count("tiktok-record.yml"), beforeYield, "a fresh always-on recorder is left to record");
  assert.equal(count("tiktok-live-upload.yml"), beforeYieldUploads, "a fresh always-on recorder is left to upload");
  const seen = await call("/v1/owner/live-record", { ip: "203.0.113.56", token });
  assert.equal(seen.status, 200);
  assert.equal(seen.body.alwaysOn, true);
  assert.equal(seen.body.server, true);
  assert.equal(JSON.stringify(seen.body).includes("fixture"), false);
  await bindings.DATA.put("owner/live-runner.json", JSON.stringify({
    runner: "always-on",
    at: "2020-01-01T00:00:00.000Z"
  }));
  const stale = await call("/v1/owner/live-record", { ip: "203.0.113.57", token });
  assert.equal(stale.body.alwaysOn, false);
  const beforeResume = count("tiktok-record.yml");
  await worker.scheduled({ cron: "* * * * *", scheduledTime: beatWhen + 2000 });
  assert.ok(count("tiktok-record.yml") > beforeResume, "a stale always-on heartbeat lets the site record again");

  await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.55",
    token,
    body: { uploadsPaused: true }
  });
  const pausedDoc = JSON.parse(await (await bindings.DATA.get("owner/tiktok.json")).text());
  pausedDoc.live.fixture_next = { handle: "fixture_next", live: false };
  await bindings.DATA.put("owner/tiktok.json", JSON.stringify(pausedDoc));
  const recordsWhilePaused = count("tiktok-record.yml");
  const uploadsWhilePaused = count("tiktok-live-upload.yml");
  await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now() + 2500 });
  assert.ok(count("tiktok-record.yml") > recordsWhilePaused, "pause does not stop a new recording");
  assert.equal(count("tiktok-live-upload.yml"), uploadsWhilePaused, "pause holds uploads while recording stays on");

  const kept = await bindings.DATA.get("owner/tiktok.json");
  const keptText = kept ? await kept.text() : "";
  await bindings.DATA.delete("owner/tiktok.json");
  const watched = await call("/v1/owner/live/fixture_watch", { ip: "203.0.113.70", token });
  assert.equal(watched.status, 200);
  assert.equal(watched.body.live, true);
  assert.ok(String(watched.body.hls || "").includes(".m3u8"));
  const catalog = JSON.parse(await (await bindings.DATA.get("owner/tiktok.json")).text());
  assert.equal(catalog.live.fixture_watch.live, true);
  assert.equal(catalog.live.fixture_watch.roomId, "7100000000000000002");
  assert.equal(Object.prototype.hasOwnProperty.call(catalog.live.fixture_watch, "hls"), false);
  assert.equal(JSON.stringify(catalog).includes("tiktokcdn"), false);
  const catalogGet = await call("/v1/owner/tiktok", { ip: "203.0.113.71", token });
  assert.equal(catalogGet.status, 200);
  assert.equal(catalogGet.body.live.fixture_watch.handle, "fixture_watch");
  if (keptText) await bindings.DATA.put("owner/tiktok.json", keptText);

  const off = await call("/v1/owner/features", {
    method: "POST",
    ip: "203.0.113.52",
    token,
    body: { name: "tiktok_auto_record", off: true }
  });
  assert.equal(off.status, 200);
  assert.ok(off.body.off.includes("tiktok_auto_record"));
  const hidden = await call("/v1/owner/live-record", { ip: "203.0.113.53", token });
  assert.equal(hidden.status, 204);
  assert.equal(hidden.text, "");
  const blockedWrite = await call("/v1/owner/live-record", {
    method: "POST",
    ip: "203.0.113.54",
    token,
    body: { uploadsPaused: false }
  });
  assert.equal(blockedWrite.status, 404);
  const beforeOffUploads = count("tiktok-live-upload.yml");
  const beforeOffRecords = count("tiktok-record.yml");
  const beforeOff = dispatches.length;
  await worker.scheduled({ cron: "* * * * *", scheduledTime: atMinute(10) });
  assert.equal(count("tiktok-live-upload.yml"), beforeOffUploads, "the site switch stops upload jobs");
  assert.equal(count("tiktok-record.yml"), beforeOffRecords, "the site switch stops record jobs");
  assert.equal(dispatches.length, beforeOff, "the site switch makes no github calls on an ordinary minute");
});
