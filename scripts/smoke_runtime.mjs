import { spawn } from "node:child_process";
import path from "node:path";

// Run these scripts at the same time. The caller still checks every exit code.
export function runScripts(dir, names) {
  return Promise.all(names.map((name) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, name)], {
      stdio: "inherit",
      env: process.env
    });
    child.on("close", (code) => resolve(code == null ? 1 : code));
  })));
}

// A shard serves the repo once. Tests with a plain static server reuse it.
export function sharedStaticServer() {
  if (!process.env.SMOKE_ORIGIN) return null;
  const port = Number(new URL(process.env.SMOKE_ORIGIN).port);
  return {
    address() { return { port }; },
    close() {}
  };
}
