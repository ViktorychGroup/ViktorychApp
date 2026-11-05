/* Owner-only kill switches. A feature that is off answers its endpoints with
   a fast empty response, skips its cron work, and is not loaded by clients.
   The flags live in D1; each isolate keeps them for 30 seconds so the check
   costs nothing on most requests. */

export const FEATURES = {
  shorts: { paths: ["/v1/owner/tiktok", "/v1/owner/live", "/v1/owner/live-resume"] },
  stories: { paths: ["/v1/stories", "/v1/story-bar"] },
  lives: { paths: ["/v1/live"] },
  telegram: { paths: ["/tg"] },
  pills: { paths: ["/v1/pills"] },
  // NZlay's public Top 100 on the Games page. On by default.
  regone_leaderboard: { paths: ["/v1/games/regone/top"] },
  // ReGone extras read from NZlay's public pages, each on by default and
  // switchable here: players online, the room list, and stats for a name
  // someone linked to their own account.
  regone_online: { paths: ["/v1/games/regone/online"] },
  regone_rooms: { paths: ["/v1/games/regone/rooms", "/v1/games/rooms"] },
  regone_profile_stats: { paths: ["/v1/games/regone/profile-stats"] },
  // NZlay's forum in Communities (read through the Worker), signing in to
  // post and reply there, and the ReGone links inside it. On by default.
  nzlay_forum: { paths: ["/v1/nzlay/forum"] },
  nzlay_forum_post: { paths: ["/v1/nzlay/relay"] },
  nzlay_forum_regone: { paths: ["/v1/games/regone/forum-badges"] },
  // Source requests: only the owner adds sources; members request them and
  // the owner allows, blocks or bans. On by default. Off restores the old
  // owner-only add without requests.
  feed_requests: { paths: ["/v1/feed-requests", "/v1/owner/feed-requests", "/v1/owner/feed-bans"] },
  // Friends master switch per account (Settings > Privacy > Friends). On by
  // default. Off: every account reads as Friends on and the setting is hidden.
  friends_off: { paths: ["/v1/friends/settings"] },
  // Owner account inspector (Cuentas): owner-only account details for
  // moderation. On by default; off hides the owner view and its routes.
  owner_inspector: { paths: ["/v1/owner/inspector"] },
  // Linked profiles merged into the account's own profile: their posts join
  // its timeline and their old pages redirect there. On by default. Off:
  // linked profiles stay listed but keep their own pages.
  merged_profiles: { paths: ["/v1/identities/merged"] },
  // Private custom names for accounts from other networks. On by default.
  ext_nicknames: { paths: ["/v1/nicknames/external"] },
  // Off until the owner turns it on: NIP-05 names and post links to Nostr events.
  nostr: { paths: ["/v1/nostr", "/.well-known/nostr.json"], defaultOff: true },
  // Off until the owner turns it on and sets NFT_CONTRACT: optional gift NFTs.
  nft: { paths: ["/v1/nft"], defaultOff: true },
  // Nearby chat (Bitchat). No server endpoints; clients stop offering it when off.
  bitchat: { paths: [] },
  // Contacts address book: local-first directory, device contact sync, dialer protocol.
  contacts: { paths: [] },
  // Local AI settings page. No server endpoints: models run on the device.
  local_ai: { paths: [] },
  // Local AI first-run setup: device check, download, test and preferences
  // before the chat opens. No server endpoints; choices sync with prefs.
  local_ai_setup: { paths: [] },
  // Lossless stills from a live, on the owner's device. No server endpoints.
  live_frame_grab: { paths: [] },
  // Automatic TikTok live recorder. On by default so segments already
  // buffered keep uploading. A new recording still waits for the owner's
  // server switch. Off stops new recordings and upload jobs.
  tiktok_auto_record: { paths: ["/v1/owner/live-record"] },
  // Repair app button, the Home-stuck repair offer and the reinstall guide.
  app_repair: { paths: [] },
  // Apply a downloaded update after a pause in use (one reload).
  auto_update: { paths: [] },
  // Sideways swipe between Home and profile tabs on touch screens. No server
  // endpoints; on by default, off keeps tabs to taps only.
  swipe_tabs: { paths: [] },
  // Compact Home header on phones (no app name, Local AI icon, pinned tabs).
  // No server endpoints; off brings back the classic header for everyone.
  compact_header: { paths: [] },
  // "Show phone status bar" option in Display settings. No server endpoints.
  status_bar: { paths: [] },
  // Pinch-zoom lock on phones (viewport, iOS gesture events). No server endpoints.
  zoom_lock: { paths: [] },
  // Visible updates: the small Updating toast, "tap to restart" and the
  // full-screen What's new page. No server endpoints.
  update_notice: { paths: [] },
  // For You off switch in Settings > Home: Following becomes Home and the
  // ranking code is not loaded. No server endpoints. On by default.
  foryou_off: { paths: [] },
  // Header status icons (clock, battery, network, unread) on phones and
  // tablets, each picked in Display settings. No server endpoints.
  status_icons: { paths: [] },
  // Desktop side panel: optional left placement, drag-to-resize width and
  // folding sections. No server endpoints. On by default (the panel itself
  // stays on the right until the person moves it).
  side_panel: { paths: [] },
  // Viktrych (Local AI) blocks, mutes, unblocks or unmutes an @account the
  // person typed, with a confirm card and Undo. Per device. No endpoints.
  ai_people: { paths: [] },
  // Viktrych GGUF models (wllama, llama.cpp in WebAssembly) from Hugging
  // Face in the model lists. Loaded from public CDNs only when picked.
  gguf_models: { paths: [] },
  // Viktrych Instant (rules, no download) does up to 3 things per message
  // and points to a downloaded model for more. No server endpoints.
  instant_limits: { paths: [] },
  // Viktrych local tools: in-page FFmpeg, direct media, drafts and app
  // actions. Each step asks first. No server endpoints.
  ai_tools: { paths: [] },
  // Settings > Site permissions: live browser permission states with
  // one-tap Allow and steps for blocked ones. No server endpoints.
  site_permissions: { paths: [] },
  // In-app notification sounds: WebAudio sounds per account, per type and a
  // default while the app is open. Per device. No server endpoints.
  notif_sounds: { paths: [] },
  // Owner-managed member settings: the owner changes another account's
  // synced settings and can lock them; /v1/sync keeps locked values.
  owner_user_settings: { paths: ["/v1/owner/user-settings"] },
  // Public X broadcasts in the feed. On by default. Off: the card is a
  // link to X and /v1/x-broadcast answers empty. No private X API.
  x_broadcast: { paths: ["/v1/x-broadcast"] }
};
export const FEATURE_NAMES = Object.keys(FEATURES);

function defaults() {
  const off = {};
  FEATURE_NAMES.forEach((name) => { if (FEATURES[name].defaultOff) off[name] = true; });
  return off;
}

const MEMO_MS = 30 * 1000;
let memo = null;
let memoAt = 0;
let schema = null;

function ensureFlagSchema(env) {
  if (!schema) {
    schema = env.DB.prepare("CREATE TABLE IF NOT EXISTS feature_flags (name TEXT PRIMARY KEY, off INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)").run()
      .catch((err) => { schema = null; throw err; });
  }
  return schema;
}

export function forgetFlags() {
  memo = null;
  memoAt = 0;
}

export async function readFlags(env, now) {
  const at = Number(now) || Date.now();
  if (memo && at - memoAt < MEMO_MS) return memo;
  const off = defaults();
  if (env && env.DB) {
    try {
      await ensureFlagSchema(env);
      const rows = await env.DB.prepare("SELECT name, off FROM feature_flags").all();
      for (const row of (rows && rows.results) || []) {
        if (!FEATURES[row.name]) continue;
        if (Number(row.off) === 1) off[row.name] = true;
        else delete off[row.name];
      }
    } catch (err) {
      // An unreadable flag table never turns a feature off (or a default-off one on).
      return memo || defaults();
    }
  }
  memo = off;
  memoAt = at;
  return off;
}

export function featureFor(path) {
  const text = String(path || "");
  for (const name of FEATURE_NAMES) {
    for (const prefix of FEATURES[name].paths) {
      if (text === prefix || text.startsWith(prefix + "/")) return name;
    }
  }
  return "";
}

export function offResponse(request) {
  const headers = { "cache-control": "public, max-age=60", "x-feature-off": "1" };
  // Reads get an empty 204 so polling clients stop cheaply; writes get 404.
  const read = request.method === "GET" || request.method === "HEAD";
  return new Response(null, { status: read ? 204 : 404, headers });
}

/* Returns a response when the path belongs to a feature that is off. */
export async function killedRoute(env, request, path) {
  const name = featureFor(path);
  if (!name) return null;
  const off = await readFlags(env);
  return off[name] ? offResponse(request) : null;
}

export function offList(off) {
  return FEATURE_NAMES.filter((name) => off && off[name]);
}

export async function handleFeatures(request, env, deps) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "/v1/features" && request.method === "GET") {
    const off = await readFlags(env);
    return deps.json(200, { off: offList(off), features: FEATURE_NAMES }, { "cache-control": "public, max-age=60" });
  }
  if (path === "/v1/owner/features") {
    const gate = await deps.requireOwner(request, env);
    if (gate.error) return gate.error;
    if (request.method === "GET") {
      forgetFlags();
      const off = await readFlags(env);
      return deps.json(200, { off: offList(off), features: FEATURE_NAMES });
    }
    if (request.method === "POST") {
      let body = null;
      try { body = await request.json(); } catch (err) { body = null; }
      const name = body && String(body.name || "");
      if (!FEATURES[name] || typeof body.off !== "boolean") return deps.json(400, { error: "feature" });
      await ensureFlagSchema(env);
      await env.DB.prepare("INSERT INTO feature_flags (name, off, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET off = excluded.off, updated_at = excluded.updated_at")
        .bind(name, body.off ? 1 : 0, Date.now()).run();
      forgetFlags();
      const off = await readFlags(env);
      return deps.json(200, { off: offList(off), features: FEATURE_NAMES });
    }
    return deps.json(405, { error: "method" });
  }
  return null;
}
