import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const runCommand = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "cantelop-sdk-package-"));

try {
  const { stdout } = await runCommand(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  const [pack] = JSON.parse(stdout);
  assert.equal(pack.name, "@cantelop/sdk");
  assert.equal(pack.version, manifest.version);
  assert.ok(pack.size > 0);
  const paths = pack.files.map(({ path: file }) => file);
  assert.ok(paths.includes("dist/build.js"));
  for (const removed of ["api", "edge", "router"]) {
    assert.equal(paths.some(file => file.startsWith(`dist/${removed}.`)), false);
    assert.equal(`./${removed}` in manifest.exports, false);
  }
  assert.ok(paths.includes("dist/client.js"));
  assert.ok(paths.includes("dist/integration.d.ts"));
  assert.ok(paths.includes("dist/stream.js"));
  assert.ok(paths.includes("dist/runtime.js"));
  assert.ok(paths.includes("dist/session.js"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("package.json"));
  assert.equal(paths.some((file) => /^(src|test|examples|scripts)\//.test(file)), false);

  for (const [name, target] of Object.entries(manifest.exports)) {
    assert.equal(typeof target.import, "string", `${name} requires an import target`);
    assert.equal(typeof target.types, "string", `${name} requires a types target`);
    assert.ok(paths.includes(target.import.replace(/^\.\//, "")), `${name} import target is not packed`);
    assert.ok(paths.includes(target.types.replace(/^\.\//, "")), `${name} types target is not packed`);
  }

  const consumer = path.join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  await runCommand(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", path.join(temporary, pack.filename)],
    { cwd: consumer, maxBuffer: 1024 * 1024 },
  );
  await writeFile(path.join(consumer, "session.mjs"), [
    'import { defineSessionBehaviour } from "@cantelop/sdk/session";',
    'export default defineSessionBehaviour(async () => {});',
  ].join("\n"));
  await writeFile(path.join(consumer, "qualify.mjs"), [
    'import assert from "node:assert/strict";',
    'import * as sdk from "@cantelop/sdk";',
    'import * as build from "@cantelop/sdk/build";',
    'import { defineSessionBehaviour } from "@cantelop/sdk/session";',
    'import * as runtime from "@cantelop/sdk/runtime";',
    'assert.equal(build.CANTELOP_CLI_BUILD_PROTOCOL_VERSION, 6);',
    'assert.equal(typeof build.watchLocalProject, "function");',
    'assert.equal("buildApi" in build, false);',
    'assert.equal("buildLocalApi" in build, false);',
    'assert.equal("defineApi" in sdk, false);',
    'assert.equal(typeof sdk.createApp, "function");',
    'assert.equal(typeof defineSessionBehaviour, "function");',
    'assert.deepEqual(Object.keys(runtime).sort(), ["createSessionDatabase", "createSessionRuntimeHandler", "serveSessionRuntime"]);',
    'for (const name of ["api", "edge"]) await assert.rejects(import(`@cantelop/sdk/${name}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });',
    'await build.buildSessionRuntime({ entrypoint: "./session.mjs", outdir: "./artifact" });',
  ].join("\n"));
  await runCommand(process.execPath, ["qualify.mjs"], { cwd: consumer, maxBuffer: 1024 * 1024 });
  await writeFile(path.join(consumer, "integration.ts"), [
    'import { createApp, CANTELOP_INTEGRATION_PROTOCOL_VERSION, type AppConnection, type SessionEventCursor } from "@cantelop/sdk";',
    'const connection: AppConnection = { fetch: async () => new Response(null) };',
    'const app = createApp<{ prompt: string }, { text: string }, { answer: string }, { prompt: string }>({ connection });',
    'const workspace = app.workspace({ slug: "customer" });',
    'const session = workspace.session({ keepAliveSeconds: 300 });',
    'const receipt = await session.dispatch({ prompt: "hello" });',
    'await receipt.status();',
    'const reply: { answer: string } = await session.request({ prompt: "hello" });',
    'await session.steer({ prompt: "focus" });',
    'await session.abort();',
    'const view = await session.view();',
    'const observedAt: Date = view.observedAt;',
    'for await (const event of session.stream()) {',
    '  const cursor: SessionEventCursor = event.cursor;',
    '  const text: string = event.data.text;',
    '  // @ts-expect-error Event payload must retain its declared type.',
    '  const bad: number = event.data.text;',
    '}',
    '// @ts-expect-error Selectors require exactly one ID or slug.',
    'app.workspace({ id: "wsp_0123456789abcdef0123456789abcdef", slug: "customer" });',
    '// @ts-expect-error Keep-alive configuration remains explicit.',
    'workspace.session({});',
    '// @ts-expect-error Steering has its own input type.',
    'session.steer({ text: "wrong" });',
    '// @ts-expect-error Dispatch has its own input type.',
    'session.dispatch({ text: "wrong" });',
    'void [reply, observedAt, CANTELOP_INTEGRATION_PROTOCOL_VERSION];',
  ].join("\n"));
  await runCommand(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
    "--lib", "ES2022,DOM", "--skipLibCheck", "integration.ts",
  ], { cwd: consumer, maxBuffer: 1024 * 1024 });
  await writeFile(path.join(consumer, "integration.mjs"), [
    'import assert from "node:assert/strict";',
    'import { createApp, CANTELOP_INTEGRATION_PROTOCOL_VERSION } from "@cantelop/sdk";',
    'assert.equal(CANTELOP_INTEGRATION_PROTOCOL_VERSION, 1);',
    'let calls = 0;',
    'const app = createApp({ connection: { async fetch(request) {',
    '  calls++;',
    '  const body = await request.json();',
    '  assert.equal(body.session.workspace_id, "wsp_0123456789abcdef0123456789abcdef");',
    '  return Response.json({ id: body.message.id, status: "accepted", accepted_at: "2026-10-09T00:00:00Z" });',
    '} } });',
    'const session = app.workspace({ id: "wsp_0123456789abcdef0123456789abcdef" }).session({ keepAliveSeconds: 0 });',
    'assert.equal(calls, 0);',
    'assert.equal((await session.dispatch({ prompt: "hello" })).state, "accepted");',
    'assert.equal(calls, 1);',
    'for (const method of ["dispatch", "request", "stream", "view", "steer", "abort", "stop"]) assert.equal(typeof session[method], "function");',
  ].join("\n"));
  await runCommand(process.execPath, ["integration.mjs"], { cwd: consumer, maxBuffer: 1024 * 1024 });
  const artifactManifest = JSON.parse(await readFile(path.join(consumer, "artifact", "cantelop-runtime.json"), "utf8"));
  assert.equal(artifactManifest.kind, "cantelop-session-runtime");
  assert.equal(artifactManifest.schema_version, 1);
  assert.equal("routes" in artifactManifest, false);
  assert.equal(artifactManifest.cli_build_protocol_version, 6);
  process.stdout.write(`Qualified ${pack.filename} (${paths.length} files)\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
