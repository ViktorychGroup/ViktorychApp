/* Playback order for a Short: the saved original, then an R2 copy,
   then TikTok's official embed player. Nothing here fetches a page. */

const TIMEOUT_MS = 8000;

const EMBED_QUERY = [
  ["autoplay", "1"],
  ["loop", "1"],
  ["controls", "0"],
  ["progress_bar", "0"],
  ["play_button", "0"],
  ["volume_control", "0"],
  ["fullscreen_button", "0"],
  ["timestamp", "0"],
  ["music_info", "0"],
  ["description", "0"],
  ["rel", "0"],
  ["closed_caption", "0"]
];

function videoId(post) {
  const blob = [post && post.statusId, post && post.id, post && post.url].filter(Boolean).join(" ");
  const match = String(blob).match(/(\d{8,22})/);
  return match ? match[1] : "";
}

function embedUrl(id) {
  const clean = String(id || "");
  if (!/^\d{8,22}$/.test(clean)) return "";
  const query = EMBED_QUERY.map((pair) => pair[0] + "=" + pair[1]).join("&");
  return "https://www.tiktok.com/player/v1/" + clean + "?" + query;
}

function chain(post, opts) {
  const options = opts && typeof opts === "object" ? opts : {};
  const steps = [];
  const key = String(options.key || "");
  if (key) steps.push({ kind: "tg", key: key });
  const copy = String(options.r2 || "");
  if (/^https:\/\//.test(copy) && /r2\.dev|r2\.cloudflarestorage\.com/i.test(copy)) {
    steps.push({ kind: "r2", url: copy });
  }
  const id = videoId(post);
  const embed = embedUrl(id);
  if (embed) steps.push({ kind: "embed", url: embed });
  return steps;
}

function after(steps, kind) {
  const list = Array.isArray(steps) ? steps : [];
  const index = list.findIndex((step) => step && step.kind === kind);
  if (index < 0) return list[0] || null;
  return list[index + 1] || null;
}

const api = { TIMEOUT_MS: TIMEOUT_MS, videoId: videoId, embedUrl: embedUrl, chain: chain, after: after };
export { TIMEOUT_MS, videoId, embedUrl, chain, after };
globalThis.ShortsPlay = api;
