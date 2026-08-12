import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApi } from "../dist/build.js";

test("buildApi emits a self-contained standard Worker and manifest", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "api.ts");
  const outdir = path.join(directory, "artifact");
  const sdkApi = new URL("../dist/api.js", import.meta.url).pathname;
  await writeFile(
    entrypoint,
    [
      `import { createApp, defineApi } from ${JSON.stringify(sdkApi)};`,
      "export default defineApi(({ execution }) => {",
      "  const app = createApp({",
      '    execution: execution.forEnvironment("env_0123456789abcdef0123456789abcdef"),',
      "  });",
      '  app.route("GET", "/health", () => Response.json({ status: "ok" }));',
      "  return app;",
      "});",
    ].join("\n"),
  );

  const artifact = await buildApi({ entrypoint, outdir });
  assert.equal(artifact.mainModule, path.join(outdir, "worker.mjs"));
  assert.deepEqual(artifact.manifest, {
    schema_version: 1,
    kind: "cantelop-edge-api",
    main_module: "worker.mjs",
    execution_protocol_version: 1,
  });
  assert.deepEqual(
    JSON.parse(await readFile(artifact.manifestFile, "utf8")),
    artifact.manifest,
  );

  const workerSource = await readFile(artifact.mainModule, "utf8");
  assert.match(workerSource, /runtime\.cantelop\.internal/);
  assert.match(workerSource, /fetch\(request\)/);
  assert.doesNotMatch(workerSource, /@cantelop\/sdk/);
  assert.doesNotMatch(workerSource, /node:/);
});
