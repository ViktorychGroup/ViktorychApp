/* Checks every GGUF model in local-ai.js against Hugging Face with a HEAD
   request: the file exists and its size matches sizeMB (within 2%).
   Needs the network, so it is run by hand (not in smoke):
   node scripts/gguf_models_check.mjs */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const A = require("../local-ai.js");

let bad = 0;
for (const m of A.MODELS.filter((x) => x.engine === "gguf")) {
  const url = A.ggufUrl(m);
  const res = await fetch(url, { method: "HEAD", redirect: "follow" });
  const bytes = Number(res.headers.get("x-linked-size") || res.headers.get("content-length") || 0);
  const ok = res.ok && Math.abs(bytes / 1e6 - m.sizeMB) / m.sizeMB < 0.02;
  if (!ok) bad += 1;
  console.log((ok ? "ok   " : "FAIL ") + res.status + " " + Math.round(bytes / 1e6) + " MB " + m.repo + "/" + m.file + (m.uncensored ? " (uncensored)" : ""));
}
const wasm = await fetch("https://cdn.jsdelivr.net/npm/@wllama/wllama@" + A.WLLAMA_VERSION + "/esm/wasm/wllama.wasm", { method: "HEAD" });
console.log((wasm.ok ? "ok   " : "FAIL ") + wasm.status + " wllama " + A.WLLAMA_VERSION + " wasm");
if (!wasm.ok) bad += 1;
if (bad) { console.error(bad + " GGUF checks failed"); process.exitCode = 1; } else console.log("gguf models ok");
