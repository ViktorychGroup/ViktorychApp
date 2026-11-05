/* Upload a Pages tar and create a deployment. The Discord token is not read. */
const fs = require("fs");
const path = require("path");

async function main() {
  const tarPath = path.resolve(process.argv[2] || "");
  if (!tarPath || !fs.existsSync(tarPath)) {
    console.log("[discord-live] no artifact tar");
    process.exit(1);
  }
  if (!process.env.GITHUB_ACTIONS || !process.env.GITHUB_REPOSITORY || !process.env.GITHUB_TOKEN) {
    console.log("[discord-live] pages deploy skipped outside Actions");
    return;
  }
  const { DefaultArtifactClient } = require("@actions/artifact");
  const core = require("@actions/core");
  const client = new DefaultArtifactClient();
  const name = "site-live-" + Date.now();
  const uploaded = await client.uploadArtifact(name, [tarPath], path.dirname(tarPath), { retentionDays: 1 });
  const artifactId = Number(uploaded && uploaded.id);
  if (!artifactId) {
    console.log("[discord-live] artifact upload did not return an id");
    process.exit(1);
  }
  // An app or feed publish may have started or finished while this tar
  // uploaded. Its shell and version.json win; this refresh waits a cycle.
  if (process.env.PAGES_GUARD_SINCE) {
    const { spawnSync } = require("child_process");
    const guard = spawnSync("python3", [path.join(__dirname, "pages_guard.py"), "busy", "--since", process.env.PAGES_GUARD_SINCE], { stdio: "inherit" });
    if (guard.status === 3) {
      console.log("[discord-live] pages deploy skipped; app publishing ran meanwhile");
      return;
    }
  }
  const oidc = await core.getIDToken();
  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const version = (process.env.GITHUB_SHA || "discord") + "-" + Date.now();
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pages/deployments`, {
    method: "POST",
    headers: {
      authorization: "Bearer " + process.env.GITHUB_TOKEN,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "viktorych-discord-live"
    },
    body: JSON.stringify({
      artifact_id: artifactId,
      environment: "github-pages",
      pages_build_version: version,
      oidc_token: oidc
    })
  });
  const text = await response.text();
  if (!response.ok) {
    console.log("[discord-live] pages HTTP " + response.status);
    console.log(text.slice(0, 300).replace(/eyJ[A-Za-z0-9_-]{20,}/g, "[redacted]"));
    process.exit(1);
  }
  let payload = {};
  try { payload = JSON.parse(text); } catch (err) { payload = {}; }
  console.log("[discord-live] pages deployment " + (payload.status || "created") + " " + (payload.page_url || ""));
}

main().catch((err) => {
  console.log("[discord-live] pages " + (err && err.name ? err.name : "error"));
  process.exit(1);
});
