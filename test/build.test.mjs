import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CANTELOP_CLI_BUILD_PROTOCOL_VERSION,
  buildSessionRuntime,
  watchLocalProject,
} from "../dist/build.js";

test("the runtime-only build module declares an incompatible CLI protocol", () => {
  assert.equal(CANTELOP_CLI_BUILD_PROTOCOL_VERSION, 6);
  assert.equal(typeof watchLocalProject, "function");
});

test("buildSessionRuntime emits one deployable native module", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-session-runtime-build-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "server.ts");
  const dependency = path.join(directory, "dependency.ts");
  const outdir = path.join(directory, "artifact");
  await writeFile(dependency, 'export const greeting: string = "ready";\n');
  await writeFile(
    entrypoint,
    [
      'import { greeting } from "./dependency.ts";',
      'export async function receive() { void greeting; }',
    ].join("\n"),
  );

  const artifact = await buildSessionRuntime({ definition: await runtimeDefinition(entrypoint), outdir });
  assert.equal(artifact.directory, outdir);
  assert.equal(artifact.mainModule, path.join(outdir, "session-runtime.mjs"));
  assert.equal(artifact.manifestFile, path.join(outdir, "cantelop-runtime.json"));
  assert.deepEqual(artifact.manifest, {
    schema_version: 1, kind: "cantelop-session-runtime", main_module: "session-runtime.mjs",
    session_runtime_id: artifact.manifest.session_runtime_id, cli_build_protocol_version: 6, runtime_protocol_version: 2, integration_protocol_version: 2,
    capabilities: { priority: false, messageCancellation: false, durableView: false },
  });
  assert.deepEqual(JSON.parse(await readFile(artifact.manifestFile, "utf8")), artifact.manifest);
  await assert.rejects(access(path.join(outdir, "worker.mjs")), { code: "ENOENT" });

  const source = await readFile(artifact.mainModule, "utf8");
  assert.match(source, /ready/);
  assert.doesNotMatch(source, /from ["']\.\/dependency\.ts["']/);
  assert.match(source, /session_runtime_startup_stage/);
  assert.match(source, /message_lifecycle/);
  assert.match(source, /bun_entry/);
  assert.match(source, /module_evaluated/);
  assert.match(source, /X-Cantelop-Sandbox-ID/);
  assert.match(source, /X-Cantelop-Message-Protocol/);
  assert.match(source, /\/__cantelop\/v2\/runtime\/quiescence/);
  assert.match(source, /\/__cantelop\/v2\/runtime\/events/);
  assert.match(source, /listener_ready/);
});

test("a built Session runtime receives messages on the local development port", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-session-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "session.ts");
  const outdir = path.join(directory, "artifact");
  await writeFile(
    entrypoint,
    [
      "let activated = false;",
      "export async function onActivate() { activated = true; }",
      "export async function receive({ message, env }) {",
      '  if (!activated) throw new Error("Activation hook was not invoked");',
      '  if (`${String(message.payload.prompt).toUpperCase()}:${env.MODEL}` !== "HELLO:test-model") throw new Error("unexpected message");',
      "}",
    ].join("\n"),
  );

  const artifact = await buildSessionRuntime({ definition: await runtimeDefinition(entrypoint), outdir });
  const port = await reservePort();
  const child = spawn(process.execPath, [artifact.mainModule], {
    env: {
      ...process.env,
      CANTELOP_INTERNAL_PORT: String(port),
 CANTELOP_SANDBOX_ID: "sbx-" + "1".repeat(32),
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

  const messageId = "msg_0123456789abcdef0123456789abcdef";
  const response = await waitForSessionRuntime(
    `http://127.0.0.1:${port}/__cantelop/v2/messages`,
    child,
    () => childError,
  );

  assert.equal(response.status, 202);
  assert.equal(
    (await response.json()).message_id,
    messageId,
  );
  assert.equal(
    response.headers.get("X-Cantelop-Message-Protocol"),
    "2",
  );
});

test("watchLocalProject incrementally rebuilds changed components", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-watch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionEntrypoint = path.join(directory, "session.ts");
  const sessionRuntimeOutdir = path.join(directory, "session-runtime-artifact");
  await writeFile(sessionEntrypoint, 'export async function receive() { console.log("runtime-one"); }\n');

  const events = [];
  const watcher = await watchLocalProject({
    sessionDefinition: await runtimeDefinition(sessionEntrypoint),
    sessionRuntimeOutdir,
    onBuild: (event) => events.push(event),
  });
  t.after(() => watcher.dispose());
  assert.match(await readFile(path.join(sessionRuntimeOutdir, "session-runtime.mjs"), "utf8"), /runtime-one/);

  await writeFile(sessionEntrypoint, 'export async function receive() { console.log("runtime-two"); }\n');
  await waitFor(() => events.some((event) => event.component === "session-runtime"));
  assert.match(await readFile(path.join(sessionRuntimeOutdir, "session-runtime.mjs"), "utf8"), /runtime-two/);
});

test("runtime-only schema discovery and watching preserve managed database artifacts", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cantelop-runtime-schema-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project");
  await mkdir(path.join(projectRoot, "src"), { recursive: true });
  await mkdir(path.join(projectRoot, "db"));
  await writeFile(path.join(projectRoot, "cantelop.json"), JSON.stringify({ schema_version: 3, app: "agent", session: "src/session.ts" }));
  const entrypoint = path.join(projectRoot, "src/session.ts");
  await writeFile(entrypoint, 'export async function receive() {}\n');
  const schemaFile = path.join(projectRoot, "db/schema.ts");
  const sdkSchema = new URL("../dist/schema.js", import.meta.url).pathname;
  const schemaSource = extra => `import { sqliteTable, text, integer } from ${JSON.stringify(sdkSchema)}; export const tasks = sqliteTable("tasks", { id: text().primaryKey()${extra} });`;
  await writeFile(schemaFile, schemaSource(""));
  const outdir = path.join(directory, "artifact");
  // Root inference starts at the Session entrypoint, without any API file.
  const artifact = await buildSessionRuntime({ definition: await runtimeDefinition(entrypoint), outdir });
  assert.deepEqual(Object.keys(artifact.manifest.database_schema.snapshot.tables), ["tasks"]);
  const events = [];
  const watcher = await watchLocalProject({ sessionDefinition: await runtimeDefinition(entrypoint), sessionRuntimeOutdir: outdir, projectRoot, onBuild: event => events.push(event) });
  t.after(() => watcher.dispose());
  await writeFile(schemaFile, schemaSource(', done: integer({ mode: "boolean" }).notNull().default(false)'));
  await waitFor(() => events.some(event => event.component === "database-schema" && !event.error));
  const updated = JSON.parse(await readFile(artifact.manifestFile, "utf8"));
  assert.ok(updated.database_schema.snapshot.tables.tasks.columns.done);
  assert.notEqual(updated.database_schema.digest, artifact.manifest.database_schema.digest);
  // Bad schemas report failure while retaining the last valid deployment metadata.
  const previous = await readFile(artifact.manifestFile, "utf8");
  events.length = 0;
  await writeFile(schemaFile, 'export const syntaxError = ;');
  await waitFor(() => events.some(event => event.component === "database-schema" && event.error));
  assert.equal(await readFile(artifact.manifestFile, "utf8"), previous);
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

async function waitForSessionRuntime(url, child, childError) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cantelop-Sandbox-ID": "sbx-" + "1".repeat(32) },
        body: JSON.stringify({
          session: {
            id: "thread",
            workspace_id: "wsp_0123456789abcdef0123456789abcdef",
            keep_alive_seconds: 300,
          },
          message: {
            id: "msg_0123456789abcdef0123456789abcdef",
            payload: { prompt: "hello" },
          },
        }),
      });
    } catch (error) {
      lastError = error;
      if (child.exitCode !== null) {
        throw new Error(
          `built Session runtime exited with ${child.exitCode} before listening: ${childError()}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error("built Session runtime did not begin listening");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function runtimeDefinition(entrypoint) {
  const definition = path.join(path.dirname(entrypoint), "definition.mjs");
  const source = await readFile(entrypoint, "utf8");
  const names = ["receive", "onActivate", "onRecover", "redelivery"].filter(name => name === "receive" || new RegExp(`export (?:async )?(?:function|const) ${name}\\b`).test(source));
  await writeFile(definition, `import { CantelopClient } from ${JSON.stringify(new URL("../dist/client.js", import.meta.url).pathname)}; import { ${names.join(", ")} } from ${JSON.stringify("./" + path.basename(entrypoint))}; export default new CantelopClient({sessionRuntime:{${names.join(", ")}}});`);
  return definition;
}
