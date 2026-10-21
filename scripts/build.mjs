import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildHarnessAssets } from "./build-harness-assets.mjs";
import { buildSyncHelpers } from "./build-sync-helper.mjs";

// One build entry point for local builds (`pnpm build`), release builds
// (`--all`, every native target) and the npm `prepare` lifecycle.
const root = fileURLToPath(new URL("..", import.meta.url));
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

await rm(new URL("../dist", import.meta.url), { force: true, recursive: true });
await Promise.all([
  promisify(execFile)(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    .catch(error => { process.stderr.write(error.stdout ?? ""); throw error; }),
  buildSyncHelpers({ all: process.argv.includes("--all") }),
]);
await buildHarnessAssets();
