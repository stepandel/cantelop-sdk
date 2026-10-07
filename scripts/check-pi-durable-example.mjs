import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { buildApi, buildSessionRuntime } from "../dist/build.js";
const temporary = await mkdtemp(join(tmpdir(), "cantelop-pi-example-"));
try {
  const root = resolve(import.meta.dirname, "../examples/pi-durable");
  const api = await buildApi({
    entrypoint: join(root, "src/api.ts"),
    outdir: join(temporary, "api"),
  });
  assert.equal(api.routeDiscoveryError, undefined);
  assert.deepEqual(
    api.manifest.routes.map(({ method, path }) => `${method} ${path}`),
    ["GET /events", "GET /health", "POST /message"],
  );
  const apiSource = await readFile(api.mainModule, "utf8");
  assert(!apiSource.includes("PiDurableStorageError"));
  assert(!apiSource.includes("NodeExecutionEnv"));
  const runtime = await buildSessionRuntime({
    entrypoint: join(root, "src/session.ts"),
    outdir: join(temporary, "session"),
  });
  const source = await readFile(runtime.mainModule, "utf8");
  assert(source.includes("cantelop_pi_commits"));
  assert(source.includes("PiDurableStorageError"));
  await build({
    entryPoints: [resolve(import.meta.dirname, "../src/pi-durable/events.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  console.log("Qualified Pi Durable API, Session bundle and browser decoder");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
