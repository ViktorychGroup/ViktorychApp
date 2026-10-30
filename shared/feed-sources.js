/* Detect a pasted profile or feed, and organize the Feeds page.
   No network. The Worker probes the URLs this module lists.
   Handles are not logged from here. */

const SUPPORTED = ["x", "threads", "instagram", "youtube", "tiktok", "vk", "telegram", "reddit", "bluesky", "mastodon", "rss"];

const ERROR_TEXT = {
  bad_input: "Use a profile URL, @handle, or an https feed.",
  unsupported_facebook: "Facebook has no public feed we can read without a paid API.",
  unsupported_discord: "Add Discord servers from Messages › Add Discord.",
  not_found: "That account wasn’t found.",
  rate: "The source asked us to slow down. We’ll try again later.",
  down: "The source didn’t answer.",
  bad_feed: "That URL is not an RSS or Atom feed.",
  private_host: "That address is not a public source.",
  full: "The feed list is full.",
  paused: "Paused."
};

const X_RESERVED = {
  home: 1, explore: 1, search: 1, settings: 1, i: 1, intent: 1, share: 1, compose: 1,
  messages: 1, notifications: 1, login: 1, signup: 1, tos: 1, privacy: 1, hashtag: 1,
  status: 1, jobs: 1, download: 1, about: 1, help: 1, terms: 1
};

function fail(error) {
  return { ok: false, error: error, message: ERROR_TEXT[error] || ERROR_TEXT.bad_input };
}

function okSpec(spec) {
  spec.ok = true;
  return spec;
}

function publicHostname(host) {
  const name = String(host || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!name || name.length > 253) return false;
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return false;
  if (name === "metadata.google.internal" || name === "0.0.0.0" || name === "[::]" || name === "::" || name === "::1") return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return ipv4Public(name);
  if (name.indexOf(":") >= 0) return ipv6Public(name);
  if (!/^[a-z0-9.-]+$/.test(name) || name.startsWith(".") || name.endsWith(".") || name.indexOf("..") >= 0) return false;
  return true;
}

function ipv4Public(name) {
  const parts = name.split(".").map((item) => Number(item));
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = parts[0];
  const b = parts[1];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

function ipv6Public(name) {
  const text = name.replace(/^\[|\]$/g, "").toLowerCase();
  if (text === "::1" || text === "::") return false;
  if (text.startsWith("fe80:") || text.startsWith("fc") || text.startsWith("fd")) return false;
  if (text.startsWith("::ffff:")) return ipv4Public(text.slice(7));
  return /^[0-9a-f:]+$/.test(text);
}

function parseHttp(text) {
  let url;
  try { url = new URL(text); }
  catch (err) { return null; }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url;
}

function slug(text) {
  const raw = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return raw.slice(0, 48);
}

function xHandle(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9_]{1,15}$/.test(text) && !X_RESERVED[text.toLowerCase()];
}

function detectInput(raw) {
  const text = String(raw || "").trim();
  if (!text || text.length > 300) return fail("bad_input");
  if (/facebook\.com|fb\.com|fb\.watch/i.test(text)) return fail("unsupported_facebook");
  if (/discord\.(com|gg)|discordapp\.com/i.test(text)) return fail("unsupported_discord");

  const prefixed = text.match(/^(x|threads|instagram|youtube|tiktok|vk|telegram|reddit|bluesky|bsky|mastodon|fediverse|fedi|rss):(\S+)$/i);
  if (prefixed) {
    const named = prefixed[1].toLowerCase();
    const platform = named === "bsky" ? "bluesky" : (named === "fediverse" || named === "fedi") ? "mastodon" : named;
    return detectBare(platform, prefixed[2]);
  }

  if (/^https?:\/\//i.test(text)) return detectUrl(text);
  // A link pasted without https:// (instagram.com/name, www.x.com/name).
  if (/^(?:www\.|m\.|mobile\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/\S*$/i.test(text)) return detectUrl("https://" + text);

  if (/^[A-Za-z0-9._-]{1,80}\.bsky\.social$/i.test(text.replace(/^@/, ""))) {
    return blueskySpec(text.replace(/^@/, ""));
  }
  const fedi = fediAddress(text);
  if (fedi) return mastodonSpec(fedi.host, fedi.user);
  if (/^@?[A-Za-z][A-Za-z0-9_]{16,32}$/.test(text)) {
    return telegramSpec(text.replace(/^@/, ""));
  }
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(text)) {
    const handle = text.replace(/^@/, "");
    if (!xHandle(handle)) return fail("bad_input");
    return okSpec({ platform: "x", handle: handle, url: "https://x.com/" + handle, host: "x.com" });
  }
  return fail("bad_input");
}

function detectBare(platform, rest) {
  const text = String(rest || "").trim();
  if (!text) return fail("bad_input");
  if (/^https?:\/\//i.test(text)) {
    const found = detectUrl(text);
    if (!found.ok) return found;
    if (found.platform !== platform) return fail("bad_input");
    return found;
  }
  if (platform === "x") {
    const handle = text.replace(/^@/, "");
    if (!xHandle(handle)) return fail("bad_input");
    return okSpec({ platform: "x", handle: handle, url: "https://x.com/" + handle, host: "x.com" });
  }
  if (platform === "threads") return threadsSpec(text.replace(/^@/, ""));
  if (platform === "instagram") return instagramSpec(text.replace(/^@/, ""));
  if (platform === "youtube") return youtubeHandle(text.replace(/^@/, ""));
  if (platform === "tiktok") return tiktokSpec(text.replace(/^@/, ""));
  if (platform === "vk") return vkSpec(text.replace(/^@/, ""));
  if (platform === "telegram") return telegramSpec(text.replace(/^@/, ""));
  if (platform === "reddit") return redditBare(text);
  if (platform === "bluesky") return blueskySpec(text.replace(/^@/, ""));
  if (platform === "mastodon") {
    const fediBare = fediAddress(text);
    return fediBare ? mastodonSpec(fediBare.host, fediBare.user) : fail("bad_input");
  }
  if (platform === "rss") return fail("bad_input");
  return fail("bad_input");
}

function detectUrl(text) {
  const url = parseHttp(text);
  if (!url) return fail("bad_input");
  if (!publicHostname(url.hostname)) return fail("private_host");
  const host = url.hostname.toLowerCase();
  const path = url.pathname || "/";
  if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) {
    const handle = (path.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/) || [])[1];
    if (!handle || !xHandle(handle)) return fail("bad_input");
    return okSpec({ platform: "x", handle: handle, url: "https://x.com/" + handle, host: "x.com" });
  }
  if (host.indexOf("threads.") >= 0) {
    const handle = (path.match(/^\/@([A-Za-z0-9._]{1,30})\/?$/) || [])[1];
    return handle ? threadsSpec(handle) : fail("bad_input");
  }
  if (host.indexOf("instagram.com") >= 0) {
    const handle = (path.match(/^\/([A-Za-z0-9._]{1,30})\/?$/) || [])[1];
    if (!handle || /^(p|reel|reels|stories|explore|accounts|direct)$/i.test(handle)) return fail("bad_input");
    return instagramSpec(handle);
  }
  if (host.indexOf("youtube.com") >= 0 || host === "youtu.be") {
    if (host === "youtu.be" || /^\/(watch|shorts|playlist|feed|results)\b/i.test(path)) return fail("bad_input");
    const channel = (path.match(/^\/channel\/(UC[\w-]{22})\/?$/) || [])[1];
    if (channel) return okSpec({ platform: "youtube", handle: channel, channelId: channel, url: "https://www.youtube.com/channel/" + channel, host: "www.youtube.com" });
    const custom = (path.match(/^\/@([A-Za-z0-9._-]{3,30})\/?$/) || [])[1];
    if (custom) return youtubeHandle(custom);
    return fail("bad_input");
  }
  if (host.indexOf("tiktok.com") >= 0) {
    const handle = (path.match(/^\/@([A-Za-z0-9._]{2,24})(?:\/|$)/) || [])[1];
    return handle ? tiktokSpec(handle) : fail("bad_input");
  }
  if (host === "vk.com" || host.endsWith(".vk.com")) {
    const handle = (path.match(/^\/([A-Za-z0-9_.]{1,32})\/?$/) || [])[1];
    if (!handle || /^(feed|video|away|im|login|join)$/i.test(handle)) return fail("bad_input");
    return vkSpec(handle);
  }
  if (host === "t.me" || host === "telegram.me" || host.endsWith(".t.me")) {
    const handle = (path.match(/^\/(?:s\/)?([A-Za-z][A-Za-z0-9_]{4,31})(?:\/\d+)?\/?$/) || [])[1];
    if (!handle || /^(share|addstickers|joinchat|iv|proxy)$/i.test(handle)) return fail("bad_input");
    return telegramSpec(handle);
  }
  if (host.indexOf("reddit.com") >= 0) {
    const sub = (path.match(/^\/r\/([A-Za-z0-9_]{2,21})\/?$/) || [])[1];
    if (sub) return redditSpec("r", sub);
    const user = (path.match(/^\/(?:user|u)\/([A-Za-z0-9_-]{2,21})\/?$/) || [])[1];
    if (user) return redditSpec("u", user);
    return fail("bad_input");
  }
  if (host === "bsky.app" || host.endsWith(".bsky.app")) {
    const actor = (path.match(/^\/profile\/([A-Za-z0-9._:-]{3,80})\/?$/) || [])[1];
    return actor ? blueskySpec(decodeURIComponent(actor)) : fail("bad_input");
  }
  const fediUrl = fediProfilePath(path);
  if (fediUrl && url.protocol === "https:") {
    return mastodonSpec(fediUrl.host || host, fediUrl.user, fediUrl.host ? "" : url.origin + path.replace(/\/$/, ""));
  }
  if (url.protocol !== "https:") return fail("bad_feed");
  return rssSpec(url);
}

function threadsSpec(handle) {
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return fail("bad_input");
  return okSpec({ platform: "threads", handle: handle, url: "https://www.threads.net/@" + handle, host: "www.threads.net" });
}

function instagramSpec(handle) {
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return fail("bad_input");
  return okSpec({ platform: "instagram", handle: handle, url: "https://www.instagram.com/" + handle + "/", host: "www.instagram.com" });
}

function youtubeHandle(handle) {
  if (/^UC[\w-]{22}$/.test(handle)) {
    return okSpec({ platform: "youtube", handle: handle, channelId: handle, url: "https://www.youtube.com/channel/" + handle, host: "www.youtube.com" });
  }
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(handle)) return fail("bad_input");
  return okSpec({ platform: "youtube", handle: handle, channelId: "", url: "https://www.youtube.com/@" + handle, host: "www.youtube.com" });
}

function tiktokSpec(handle) {
  if (!/^[A-Za-z0-9._]{2,24}$/.test(handle)) return fail("bad_input");
  return okSpec({ platform: "tiktok", handle: handle, url: "https://www.tiktok.com/@" + handle, host: "www.tiktok.com" });
}

function vkSpec(handle) {
  if (!/^[A-Za-z0-9_.]{1,32}$/.test(handle)) return fail("bad_input");
  return okSpec({ platform: "vk", handle: handle, url: "https://vk.com/" + handle, host: "vk.com" });
}

function telegramSpec(handle) {
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(handle)) return fail("bad_input");
  return okSpec({ platform: "telegram", handle: handle, url: "https://t.me/" + handle, host: "t.me" });
}

function redditBare(text) {
  const sub = text.match(/^r\/([A-Za-z0-9_]{2,21})$/i);
  if (sub) return redditSpec("r", sub[1]);
  const user = text.match(/^(?:u|user)\/([A-Za-z0-9_-]{2,21})$/i);
  if (user) return redditSpec("u", user[1]);
  if (/^[A-Za-z0-9_-]{2,21}$/.test(text)) return redditSpec("u", text);
  return fail("bad_input");
}

function redditSpec(kind, name) {
  const handle = String(name || "");
  if (kind === "r" && !/^[A-Za-z0-9_]{2,21}$/.test(handle)) return fail("bad_input");
  if (kind === "u" && !/^[A-Za-z0-9_-]{2,21}$/.test(handle)) return fail("bad_input");
  const path = kind === "r" ? "/r/" + handle : "/user/" + handle;
  return okSpec({ platform: "reddit", redditKind: kind, handle: handle, url: "https://www.reddit.com" + path, host: "www.reddit.com" });
}

function blueskySpec(actor) {
  const handle = String(actor || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9._:-]{3,80}$/.test(handle)) return fail("bad_input");
  return okSpec({ platform: "bluesky", handle: handle, url: "https://bsky.app/profile/" + handle, host: "public.api.bsky.app" });
}

/* Fediverse profiles are followed as feeds only: Mastodon, Pixelfed,
   Misskey, Pleroma, Akkoma, GoToSocial, Friendica, PeerTube, Lemmy and
   anything else with a public API or RSS/Atom. Nothing is posted back. */
const FEDI_USER = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const FEDI_HOST = /^(?=.{4,253}$)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$/;

function fediAddress(raw) {
  const text = String(raw || "").trim().replace(/^acct:/i, "");
  const m = text.match(/^@?([^@\s/]+)@([^@\s/]+)$/);
  if (!m || !FEDI_USER.test(m[1]) || !FEDI_HOST.test(m[2])) return null;
  return { user: m[1], host: m[2].toLowerCase() };
}

function fediProfilePath(path) {
  const remote = path.match(/^\/@([^@/]+)@([^@/]+)\/?$/);
  if (remote && FEDI_USER.test(remote[1]) && FEDI_HOST.test(remote[2])) return { user: remote[1], host: remote[2].toLowerCase() };
  const local = path.match(/^\/(?:@|users\/|u\/|a\/|c\/|profile\/)([^/@]+)\/?$/);
  if (local && FEDI_USER.test(local[1])) return { user: local[1], host: "" };
  return null;
}

function mastodonSpec(host, user, profileUrl) {
  if (!publicHostname(host) || !FEDI_USER.test(String(user || ""))) return fail("bad_input");
  return okSpec({ platform: "mastodon", handle: user, host: host, url: profileUrl || ("https://" + host + "/@" + user) });
}

function rssSpec(url) {
  if (url.protocol !== "https:") return fail("bad_feed");
  const handle = slug(url.hostname + url.pathname);
  if (!handle) return fail("bad_feed");
  const clean = url.origin + url.pathname + (url.search || "");
  return okSpec({ platform: "rss", handle: handle, url: clean, host: url.hostname.toLowerCase() });
}

function accountId(spec) {
  if (!spec || !spec.platform) return "";
  if (spec.platform === "mastodon") return "mastodon:" + spec.handle + "@" + spec.host;
  if (spec.platform === "reddit") return "reddit:" + (spec.redditKind || "u") + ":" + spec.handle;
  if (spec.platform === "youtube" && spec.channelId) return "youtube:" + spec.channelId;
  return spec.platform + ":" + spec.handle;
}

function enc(value) {
  return encodeURIComponent(String(value || ""));
}

function metaRss(platform, handle) {
  const h = enc(handle);
  const path = platform === "instagram" ? "/instagram/user/" + h : "/threads/" + h;
  const bridge = platform === "instagram" ? "InstagramBridge" : "ThreadsBridge";
  return [
    { kind: "rss", url: "https://rsshub.app" + path },
    { kind: "rss", url: "https://rss-bridge.org/bridge01/?action=display&bridge=" + bridge + "&context=Username&u=" + h + "&format=Atom" },
    { kind: "rss", url: "https://rsshub.pseudoyu.com" + path },
    { kind: "rss", url: "https://rsshub.rss.tips" + path }
  ];
}

function sourcePlan(spec) {
  if (!spec || !spec.ok) return [];
  const handle = spec.handle;
  const platform = spec.platform;
  if (platform === "x") {
    return [
      { kind: "fxtwitter-user", url: "https://api.fxtwitter.com/" + enc(handle) },
      { kind: "fxtwitter-posts", url: "https://api.fxtwitter.com/2/profile/" + enc(handle) + "/statuses" },
      { kind: "rss", url: "https://nitter.meowing.monster/" + enc(handle) + "/rss" },
      { kind: "rss", url: "https://nitter.kareem.one/" + enc(handle) + "/rss" },
      { kind: "rss", url: "https://rsshub.app/twitter/user/" + enc(handle) }
    ];
  }
  if (platform === "threads") {
    return metaRss("threads", handle);
  }
  if (platform === "instagram") {
    return metaRss("instagram", handle);
  }
  if (platform === "youtube") {
    if (spec.channelId) return [{ kind: "youtube-rss", url: "https://www.youtube.com/feeds/videos.xml?channel_id=" + enc(spec.channelId) }];
    return [{ kind: "youtube-page", url: "https://www.youtube.com/@" + enc(handle) }];
  }
  if (platform === "tiktok") {
    return [
      { kind: "tiktok-html", url: "https://www.tiktok.com/@" + enc(handle) },
      { kind: "rss", url: "https://rsshub.app/tiktok/user/" + enc(handle) }
    ];
  }
  if (platform === "vk") {
    return [
      { kind: "vk-html", url: "https://vk.com/" + enc(handle) },
      { kind: "rss", url: "https://rsshub.app/vk/user/" + enc(handle) }
    ];
  }
  if (platform === "telegram") {
    return [
      { kind: "telegram-html", url: "https://t.me/s/" + enc(handle) },
      { kind: "rss", url: "https://rsshub.app/telegram/channel/" + enc(handle) }
    ];
  }
  if (platform === "reddit") {
    const path = spec.redditKind === "r" ? "/r/" + enc(handle) : "/user/" + enc(handle);
    return [
      { kind: "rss", url: "https://www.reddit.com" + path + "/.rss" },
      { kind: "rss", url: "https://safereddit.com" + path + "/rss" },
      { kind: "rss", url: "https://redlib.fmhy.net" + path + "/rss" }
    ];
  }
  if (platform === "bluesky") {
    return [
      { kind: "bsky-profile", url: "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=" + enc(handle) },
      { kind: "bsky-feed", url: "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=" + enc(handle) + "&limit=3" }
    ];
  }
  if (platform === "mastodon") {
    return [
      { kind: "mastodon-lookup", url: "https://" + spec.host + "/api/v1/accounts/lookup?acct=" + enc(handle) }
    ].concat(fediFeeds(spec.host, handle).map((url) => ({ kind: "rss", url: url })));
  }
  if (platform === "rss") return [{ kind: "rss", url: spec.url }];
  return [];
}

/* Public feeds by software, most common first: Mastodon, Misskey and
   GoToSocial; Pixelfed; Pleroma and Akkoma; PeerTube. */
function fediFeeds(host, handle) {
  const h = "https://" + host;
  const u = enc(handle);
  return [h + "/@" + u + ".rss", h + "/users/" + u + ".atom", h + "/users/" + u + "/feed.atom", h + "/feeds/videos.xml?accountName=" + u];
}

function backoffMs(attempt, status, retryAfterSeconds) {
  const n = Math.max(0, Number(attempt) || 0);
  if (Number(status) === 429) {
    const hinted = Math.max(0, Number(retryAfterSeconds) || 0) * 1000;
    const steps = [5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
    return Math.max(hinted, steps[Math.min(n, steps.length - 1)]);
  }
  const steps = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
  return steps[Math.min(n, steps.length - 1)];
}

function healthStatus(row) {
  if (!row) return "ok";
  if (row.paused) return "paused";
  const status = row.health && row.health.status;
  if (status === "ok" || status === "slow" || status === "failing" || status === "paused") return status;
  return "ok";
}

function displayName(row) {
  return String((row && (row.label || row.name || row.handle)) || "");
}

function sortRows(list, mode) {
  const copy = (list || []).slice();
  copy.sort((a, b) => {
    const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pin) return pin;
    if (mode === "added") return String(b.addedAt || "").localeCompare(String(a.addedAt || "")) || displayName(a).localeCompare(displayName(b));
    if (mode === "last") return String(b.lastPost || "").localeCompare(String(a.lastPost || "")) || displayName(a).localeCompare(displayName(b));
    if (mode === "order") return (Number(a.order) || 0) - (Number(b.order) || 0) || displayName(a).localeCompare(displayName(b));
    return displayName(a).localeCompare(displayName(b));
  });
  return copy;
}

function organizeFeeds(rows, groups, opts) {
  opts = opts || {};
  const q = String(opts.q || "").trim().toLowerCase();
  const platform = String(opts.platform || "");
  const group = String(opts.group || "");
  const status = String(opts.status || "");
  const mode = opts.sort || "name";
  const filtered = (rows || []).filter((row) => {
    if (!row) return false;
    if (platform && row.platform !== platform) return false;
    const gid = row.groupId || "";
    if (group === "none" && gid) return false;
    if (group && group !== "none" && gid !== group) return false;
    if (status && healthStatus(row) !== status) return false;
    if (!q) return true;
    const blob = [row.name, row.label, row.handle, row.platform].join(" ").toLowerCase();
    return blob.indexOf(q) >= 0;
  });
  const orderedGroups = (groups || []).slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.name || "").localeCompare(String(b.name || "")));
  const sections = [];
  orderedGroups.forEach((item) => {
    const members = sortRows(filtered.filter((row) => row.groupId === item.id), mode);
    if (members.length || group === item.id) sections.push({ id: item.id, title: item.name || item.id, rows: members });
  });
  const loose = sortRows(filtered.filter((row) => !row.groupId || !orderedGroups.some((item) => item.id === row.groupId)), mode);
  if (loose.length) sections.push({ id: "", title: "", rows: loose });
  const byPlatform = [];
  if (!group) {
    const seen = {};
    loose.forEach((row) => {
      const key = row.platform || "rss";
      if (!seen[key]) {
        seen[key] = [];
        byPlatform.push({ id: "platform:" + key, title: key, rows: seen[key] });
      }
      seen[key].push(row);
    });
  }
  return { sections: sections, ungroupedByPlatform: byPlatform, count: filtered.length };
}

function reorderWithin(rows, groupId, fromId, toId) {
  const wanted = groupId || "";
  const section = [];
  const rest = [];
  (rows || []).forEach((row) => {
    if ((row.groupId || "") === wanted) section.push(row);
    else rest.push(row);
  });
  const ids = section.map((row) => row.id);
  const from = ids.indexOf(fromId);
  const to = ids.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return rows;
  const moved = ids.splice(from, 1)[0];
  ids.splice(to, 0, moved);
  const map = {};
  section.forEach((row) => { map[row.id] = row; });
  const next = ids.map((id, index) => Object.assign({}, map[id], { order: index }));
  return rest.concat(next);
}

function reorderGroups(groups, ids) {
  const map = {};
  (groups || []).forEach((group) => { map[group.id] = group; });
  const next = [];
  (ids || []).forEach((id, index) => {
    if (!map[id]) return;
    next.push(Object.assign({}, map[id], { order: index }));
    delete map[id];
  });
  Object.keys(map).forEach((id) => next.push(map[id]));
  return next;
}

function bulkPatch(rows, ids, patch) {
  const want = {};
  (ids || []).forEach((id) => { want[id] = true; });
  return (rows || []).map((row) => want[row.id] ? Object.assign({}, row, patch) : row);
}

function mergeOffline(cached, live) {
  if (live && Array.isArray(live.accounts)) return { doc: live, offline: false };
  if (cached && Array.isArray(cached.accounts)) return { doc: cached, offline: true };
  return { doc: { accounts: [], groups: [], places: [] }, offline: !live };
}

function cleanGroupName(value) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 40) return "";
  return name;
}

function cleanLabel(value) {
  const name = String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();
  if (!name) return "";
  return Array.from(name).slice(0, 80).join("");
}

export {
  SUPPORTED,
  ERROR_TEXT,
  detectInput,
  publicHostname,
  accountId,
  sourcePlan,
  fediAddress,
  fediFeeds,
  backoffMs,
  healthStatus,
  sortRows,
  organizeFeeds,
  reorderWithin,
  reorderGroups,
  bulkPatch,
  mergeOffline,
  cleanGroupName,
  cleanLabel
};

if (typeof window !== "undefined") {
  window.FeedSources = {
    SUPPORTED, ERROR_TEXT, detectInput, publicHostname, accountId, sourcePlan, backoffMs,
    healthStatus, sortRows, organizeFeeds, reorderWithin, reorderGroups, bulkPatch, mergeOffline, cleanGroupName, cleanLabel
  };
}
