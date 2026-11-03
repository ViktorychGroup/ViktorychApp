#!/usr/bin/env node
/* Seal the reader copy of read-mostly catalogs for GitHub Pages.

   node scripts/seal_data.mjs --site _site --in <dir> [--audience owner|all]

   <dir> holds the plain catalogs by key (feeds.json, data/music.json, ...).
   Each one is stripped exactly like the Worker strips it for a non-owner,
   then encrypted with today's key (see worker/src/data-seal.js) into
   <site>/sealed/. Needs ACCOUNT_PEPPER. Missing input is skipped; this
   never fails a deploy. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SEAL_KEYS, sealDay, sealFile, sealText } from "../worker/src/data-seal.js";
import { stripOwnerOnly } from "../worker/src/owner-only.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export async function sealSite(site, input, secret, audience, now) {
  const day = sealDay(now || Date.now());
  const at = new Date(now || Date.now()).toISOString();
  const env = { TIKTOK_AUDIENCE: audience === "all" ? "all" : "owner" };
  const out = path.join(site, "sealed");
  const files = [];
  for (const key of SEAL_KEYS) {
    const src = path.join(input, key);
    if (!fs.existsSync(src)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(src, "utf8")); } catch (err) { continue; }
    const text = JSON.stringify(stripOwnerOnly(parsed, env));
    const doc = await sealText(secret, day, key, text, at);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(site, sealFile(key)), JSON.stringify(doc));
    files.push(key);
  }
  if (files.length) fs.writeFileSync(path.join(out, "index.json"), JSON.stringify({ v: 1, day, at, files }));
  return files;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || "")).href) {
  const secret = process.env.ACCOUNT_PEPPER || "";
  if (!secret) { console.log("[seal] ACCOUNT_PEPPER is not set; skipped"); process.exit(0); }
  sealSite(arg("--site", "_site"), arg("--in", "."), secret, arg("--audience", "owner")).then((files) => {
    console.log("[seal] sealed " + files.length + " catalogs");
  }, (err) => {
    console.log("[seal] skipped: " + (err && err.message ? err.message : "error"));
  });
}
