import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare } from "miniflare";

const STATUS = "1000000000000001";
const FILE = "https://video.twimg.com/ext_tw_video/" + STATUS + "/vid/avc1/1280x720/a.mp4";
const BYTES = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const seen = { range: "", referer: "" };

function workerOptions() {
  return {
    modules: true,
    scriptPath: fileURLToPath(new URL("../src/index.js", import.meta.url)),
    modulesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"], fallthrough: true }],
    compatibilityDate: "2026-01-15",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
    bindings: { ALLOWED_ORIGINS: "https://viktorychapp.com" },
    async outboundService(request) {
      const url = new URL(request.url);
      seen.range = request.headers.get("range") || "";
      seen.referer = request.headers.get("referer") || "";
      if (url.hostname === "video.twimg.com") {
        if (seen.range) {
          return new Response(BYTES.slice(0, 4), {
            status: 206,
            headers: {
              "content-type": "video/mp4",
              "content-range": "bytes 0-3/8",
              "accept-ranges": "bytes",
              "content-length": "4",
              "x-frame-options": "DENY"
            }
          });
        }
        return new Response(BYTES, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "accept-ranges": "bytes",
            "content-length": "8",
            "x-frame-options": "DENY"
          }
        });
      }
      if (url.hostname === "pbs.twimg.com" || url.hostname === "yt3.ggpht.com" || url.hostname === "yt3.googleusercontent.com") {
        return new Response("img", { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      if (url.hostname === "www.instagram.com" || url.hostname === "instagram.com") {
        if (/\/media\/?$/.test(url.pathname) && url.pathname.indexOf("BadHtml1") < 0 && url.pathname.indexOf("Missing1") < 0) {
          return Response.redirect("https://scontent.cdninstagram.com/v/cover.jpg", 302);
        }
        if (url.pathname.indexOf("BadHtml1") >= 0) {
          return Response.redirect("https://scontent.cdninstagram.com/v/page.html", 302);
        }
        return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url.hostname === "scontent.cdninstagram.com" && url.pathname === "/v/cover.jpg") {
        return new Response(JPEG, {
          status: 200,
          headers: { "content-type": "image/jpeg", "cross-origin-resource-policy": "same-origin" }
        });
      }
      if (url.hostname === "scontent.cdninstagram.com" && url.pathname === "/v/page.html") {
        return new Response("<html>no</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("no", { status: 404 });
    }
  };
}

test("an X video relay is not cached and keeps the original bytes", async () => {
  seen.range = "";
  seen.referer = "";
  const mf = new Miniflare(workerOptions());
  try {
    const ranged = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent(FILE), {
      headers: { range: "bytes=0-3" }
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-type"), "video/mp4");
    assert.equal(ranged.headers.get("content-range"), "bytes 0-3/8");
    assert.equal(ranged.headers.get("accept-ranges"), "bytes");
    assert.equal(ranged.headers.get("cache-control"), "private, no-store");
    assert.equal(ranged.headers.get("cdn-cache-control"), "no-store");
    assert.equal(ranged.headers.get("x-frame-options"), "DENY");
    assert.equal(seen.range, "bytes=0-3");
    assert.equal(seen.referer, "");
    const body = new Uint8Array(await ranged.arrayBuffer());
    assert.deepEqual(Array.from(body), [0, 1, 2, 3]);

    const photo = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://pbs.twimg.com/media/a.jpg"));
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get("cache-control"), "public, max-age=120, s-maxage=120");
    assert.equal(photo.headers.get("cdn-cache-control"), "public, max-age=120");
    assert.equal(seen.referer, "https://pbs.twimg.com/");

    // YouTube channel pictures are throttled in Russia too; the relay takes them.
    const avatar = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://yt3.ggpht.com/a/pic=s88"));
    assert.equal(avatar.status, 200);

    const avatarG = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://yt3.googleusercontent.com/placeholder-avatar=s176-c-k-c0x00ffffff-no-rj"));
    assert.equal(avatarG.status, 200);

    const other = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://cdninstagram.com/clip.mp4"));
    assert.equal(other.status, 404);
    assert.equal(other.headers.get("cache-control"), "private, no-store");
    assert.equal(other.headers.get("cdn-cache-control"), "no-store");

    const embed = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://platform.twitter.com/embed/Tweet.html?id=" + STATUS));
    assert.equal(embed.status, 400);
    const denied = await embed.json();
    assert.equal(denied.error, "bad_url");
  } finally {
    await mf.dispose();
  }
});

test("an Instagram media redirect is returned as the image and nothing else on that host", async () => {
  const mf = new Miniflare(workerOptions());
  try {
    const photo = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://www.instagram.com/p/Abcd1234/media/?size=l"));
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get("content-type"), "image/jpeg");
    assert.equal(photo.headers.get("cross-origin-resource-policy"), null);
    const bytes = new Uint8Array(await photo.arrayBuffer());
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8);

    const reel = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://www.instagram.com/reel/Abcd1234/media/?size=l"));
    assert.equal(reel.status, 200);
    await reel.arrayBuffer();

    const profile = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://www.instagram.com/orbitfox/"));
    assert.equal(profile.status, 400);
    const embed = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://www.instagram.com/p/Abcd1234/embed/captioned/"));
    assert.equal(embed.status, 400);
    const login = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://www.instagram.com/accounts/login/"));
    assert.equal(login.status, 400);

    const html = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://www.instagram.com/p/BadHtml1/media/?size=l"));
    assert.equal(html.status, 502);
    const missing = await mf.dispatchFetch("https://accounts.test/v1/media?url=" + encodeURIComponent("https://www.instagram.com/p/Missing1/media/?size=l"));
    assert.equal(missing.status, 400);
  } finally {
    await mf.dispose();
  }
});
