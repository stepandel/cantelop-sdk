import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CANTELOP_CLI_BUILD_PROTOCOL_VERSION,
  buildApi,
  buildHarness,
  buildLocalApi,
  watchLocalProject,
} from "../dist/build.js";

test("the build module declares its CLI compatibility protocol", () => {
  assert.equal(CANTELOP_CLI_BUILD_PROTOCOL_VERSION, 1);
  assert.equal(typeof buildLocalApi, "function");
  assert.equal(typeof watchLocalProject, "function");
});

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
      `import { defineHarness } from ${JSON.stringify(new URL("../dist/harness.js", import.meta.url).pathname)};`,
      'export default defineHarness(async () => ({ greeting }));',
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
  assert.match(source, /X-Cantelop-SDK-Execution-Complete/);
  assert.match(source, /listener_ready/);
});

test("a built harness serves executions on the local development port", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-harness-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "harness.ts");
  const outdir = path.join(directory, "artifact");
  const sdkHarness = new URL("../dist/harness.js", import.meta.url).pathname;
  await writeFile(
    entrypoint,
    [
      `import { defineHarness } from ${JSON.stringify(sdkHarness)};`,
      "export default defineHarness(async ({ input, env }) => ({",
      "  answer: String(input.prompt).toUpperCase(),",
      "  model: env.MODEL,",
      "}));",
    ].join("\n"),
  );

  const artifact = await buildHarness({ entrypoint, outdir });
  const port = await reservePort();
  const child = spawn(process.execPath, [artifact.mainModule], {
    env: {
      ...process.env,
      CANTELOP_INTERNAL_PORT: String(port),
      MODEL: "test-model",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childError = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    childError = (childError + chunk).slice(-16_384);
  });
  t.after(async () => stopChild(child));

  const executionId = "exec_0123456789abcdef0123456789abcdef";
  const response = await waitForHarness(
    `http://127.0.0.1:${port}/__cantelop/v1/executions/${executionId}`,
    child,
    () => childError,
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("X-Cantelop-SDK-Execution-Complete"),
    executionId,
  );
  assert.deepEqual(await response.json(), {
    output: { answer: "HELLO", model: "test-model" },
  });
});

test("watchLocalProject incrementally rebuilds changed components", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const apiEntrypoint = path.join(directory, "api.ts");
  const harnessEntrypoint = path.join(directory, "harness.ts");
  const apiOutdir = path.join(directory, "api-artifact");
  const harnessOutdir = path.join(directory, "harness-artifact");
  const sdkApi = new URL("../dist/api.js", import.meta.url).pathname;
  await writeFile(
    apiEntrypoint,
    `import { defineApi } from ${JSON.stringify(sdkApi)}; export default defineApi(({ router }) => router.route("GET", "/", () => Response.json({ value: "one" })));`,
  );
  await writeFile(harnessEntrypoint, 'export default async () => "harness-one";\n');

  const events = [];
  const watcher = await watchLocalProject({
    apiEntrypoint,
    apiOutdir,
    harnessEntrypoint,
    harnessOutdir,
    runtimeOrigin: "http://127.0.0.1:43123",
    onBuild: (event) => events.push(event),
  });
  t.after(() => watcher.dispose());
  assert.match(await readFile(path.join(apiOutdir, "worker.mjs"), "utf8"), /one/);
  assert.match(await readFile(path.join(harnessOutdir, "harness.mjs"), "utf8"), /harness-one/);

  await writeFile(harnessEntrypoint, 'export default async () => "harness-two";\n');
  await waitFor(() => events.some((event) => event.component === "harness"));
  assert.match(await readFile(path.join(harnessOutdir, "harness.mjs"), "utf8"), /harness-two/);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for incremental build");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForHarness(url, child, childError) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { prompt: "hello" } }),
      });
    } catch (error) {
      lastError = error;
      if (child.exitCode !== null) {
        throw new Error(
          `built harness exited with ${child.exitCode} before listening: ${childError()}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error("built harness did not begin listening");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}
