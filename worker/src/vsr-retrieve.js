/* Owner retrieval of age ciphertext. The public /tg route keeps
   encrypted = 0 and never serves these rows. The bot token stays here.
   The browser receives ciphertext bytes only, never file_id. An empty
   file_id means the object was not uploaded; this does not invent one. */

import { safeTelegramPath } from "./telegram.js";

const NAME_RE = /^(?:manifest|[a-f0-9]{64})\.age$/;
const MAX_BYTES = 19 * 1024 * 1024;

function objectName(path) {
  const raw = String(path || "").replace(/^\/tg\/vsr\//, "");
  let name = raw;
  try { name = decodeURIComponent(raw); }
  catch (err) { return ""; }
  if (!NAME_RE.test(name) || name.indexOf("/") >= 0 || name.indexOf("\\") >= 0) return "";
  return name;
}

async function ownerGate(env, request, deps) {
  const viewer = await deps.sessionAccount(env, request);
  if (!viewer) return { response: deps.json(404, { error: "not_found" }) };
  if (viewer.owner !== 1) return { response: deps.json(403, { error: "forbidden" }) };
  return { viewer };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}

async function downloadCipher(env, fileId) {
  const token = String(env.TELEGRAM_BOT_TOKEN || "");
  if (!token || !fileId) return null;
  let data = null;
  try {
    const res = await fetch("https://api.telegram.org/bot" + token + "/getFile?file_id=" + encodeURIComponent(fileId));
    data = await res.json();
  } catch (err) {
    data = null;
  }
  const remote = safeTelegramPath(data && data.ok && data.result && data.result.file_path);
  if (!remote) return null;
  const upstream = await fetch("https://api.telegram.org/file/bot" + token + "/" + remote);
  if (!upstream.ok) return null;
  return new Uint8Array(await upstream.arrayBuffer());
}

export async function handleVsrRoute(request, env, path, deps) {
  const gate = await ownerGate(env, request, deps);
  if (gate.response) return gate.response;
  const hit = await deps.rateHit(env, "vsr:" + gate.viewer.public_id, 60, 10 * 60 * 1000);
  if (!hit.ok) return deps.limited(hit);
  const name = objectName(path);
  if (!name) return deps.json(404, { error: "not_found" });
  if (!env.DB) return deps.json(503, { error: "not_configured" });
  const row = await env.DB.prepare(
    "SELECT object_key, kind, part_index, file_id, size, sha256, mime, serve, encrypted FROM telegram_files WHERE object_key = ? AND kind = 'age' AND encrypted = 1 AND serve = 1"
  ).bind("vsr/" + name).first();
  if (!row || row.object_key !== "vsr/" + name) return deps.json(404, { error: "not_found" });
  const fileId = String(row.file_id || "");
  if (!fileId) return deps.json(404, { error: "not_uploaded" });
  if (!String(env.TELEGRAM_BOT_TOKEN || "") || !String(env.TELEGRAM_CHANNEL_ID || "")) {
    return deps.json(503, { error: "not_configured" });
  }
  const bytes = await downloadCipher(env, fileId);
  const size = Number(row.size) || 0;
  if (!bytes || size <= 0 || size > MAX_BYTES || bytes.byteLength !== size) {
    return deps.json(502, { error: "unavailable" });
  }
  const hash = await sha256Hex(bytes);
  if (hash !== String(row.sha256 || "").toLowerCase()) return deps.json(502, { error: "mismatch" });
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": String(bytes.byteLength),
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive, nosnippet, noimageindex"
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(bytes, { status: 200, headers });
}
