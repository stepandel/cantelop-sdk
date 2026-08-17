import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApi, buildHarness, buildLocalApi } from "../dist/build.js";

test("buildApi emits a self-contained standard Worker and manifest", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "api.ts");
  const outdir = path.join(directory, "artifact");
  const sdkApi = new URL("../dist/api.js", import.meta.url).pathname;
  await writeFile(
    entrypoint,
    [
      `import { defineApi } from ${JSON.stringify(sdkApi)};`,
      "export default defineApi(({ router }) => {",
      '  router.route("GET", "/health", () => Response.json({ status: "ok" }));',
      "});",
    ].join("\n"),
  );

  const artifact = await buildApi({ entrypoint, outdir });
  assert.equal(artifact.mainModule, path.join(outdir, "worker.mjs"));
  assert.deepEqual(artifact.manifest, {
    schema_version: 1,
    kind: "cantelop-edge-api",
    main_module: "worker.mjs",
    execution_protocol_version: 2,
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

test("buildLocalApi redirects only Cantelop runtime calls to a loopback bridge", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-local-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "api.ts");
  const outdir = path.join(directory, "artifact");
  const sdkApi = new URL("../dist/api.js", import.meta.url).pathname;
  await writeFile(
    entrypoint,
    [
      `import { defineApi } from ${JSON.stringify(sdkApi)};`,
      "export default defineApi(({ app, router }) => {",
      '  router.route("POST", "/sessions", async () => {',
      '    const session = await app.sessions.create({ workspaceId: "wsp_0123456789abcdef0123456789abcdef", keepAliveSeconds: 30 });',
      "    return Response.json({ sessionId: session.id });",
      "  });",
      "});",
    ].join("\n"),
  );

  const artifact = await buildLocalApi({
    entrypoint,
    outdir,
    runtimeOrigin: "http://127.0.0.1:43123",
  });
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (request) => {
    forwarded = request;
    return Response.json({ id: (await request.clone().json()).id }, { status: 202 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const worker = (await import(`${new URL(artifact.mainModule, "file:").href}?local`)).default;
  const response = await worker.fetch(new Request("http://127.0.0.1:8787/sessions", {
    method: "POST",
  }));

  assert.equal(response.status, 200);
  assert.match((await response.json()).sessionId, /^ses_/);
  assert.equal(forwarded.url, "http://127.0.0.1:43123/__cantelop/v1/sessions");
});

test("buildLocalApi rejects non-loopback runtime origins", async () => {
  await assert.rejects(
    buildLocalApi({
      entrypoint: "./api.ts",
      outdir: "./artifact",
      runtimeOrigin: "https://runtime.example.com",
    }),
    /numeric HTTP loopback origin/,
  );
});

test("buildHarness emits one deployable native module and manifest", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-harness-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "server.ts");
  const dependency = path.join(directory, "dependency.ts");
  const outdir = path.join(directory, "artifact");
  await writeFile(dependency, 'export const greeting: string = "ready";\n');
  await writeFile(
    entrypoint,
    [
      'import { greeting } from "./dependency.ts";',
      'import { createServer } from "node:http";',
      'createServer((_request, response) => response.end(greeting));',
    ].join("\n"),
  );

  const artifact = await buildHarness({ entrypoint, outdir });
  assert.equal(artifact.mainModule, path.join(outdir, "harness.mjs"));
  assert.equal(artifact.manifest.kind, "cantelop-native-harness");
  assert.equal(artifact.manifest.main_module, "harness.mjs");
  assert.equal(artifact.manifest.execution_protocol_version, 2);
  assert.ok(artifact.manifest.bundled_bytes > 0);
  assert.deepEqual(
    JSON.parse(await readFile(artifact.manifestFile, "utf8")),
    artifact.manifest,
  );

  const source = await readFile(artifact.mainModule, "utf8");
  assert.match(source, /ready/);
  assert.doesNotMatch(source, /from ["']\.\/dependency\.ts["']/);
  assert.match(source, /harness_startup_stage/);
  assert.match(source, /bun_entry/);
  assert.match(source, /module_evaluated/);
});
