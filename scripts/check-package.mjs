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
  for (const target of Object.values(manifest.imports["#cantelop-app-config"])) {
    assert.ok(paths.includes(target.replace(/^\.\//, "")), "configuration adapter is not packed");
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
    if (typeof target === "string") {
      assert.ok(paths.includes(target.replace(/^\.\//, "")), `${name} asset is not packed`);
      continue;
    }
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
  await writeFile(path.join(consumer, "definition.mjs"), [
    'import { CantelopClient } from "@cantelop/sdk";',
    'import { createClaudeHarness, createClaudeRuntime, claudeAuth, claudeDockerfile } from "@cantelop/sdk/harnesses/claude";',
    'export const cantelop = new CantelopClient().app({ name: "first-agent",runtime:createClaudeRuntime({workspace:"/workspace"}),auth:claudeAuth,dockerfile:claudeDockerfile});',
  ].join("\n"));
  await writeFile(path.join(consumer, "session.mjs"), [
    'import * as sessionSDK from "@cantelop/sdk/session";',
    'export async function receive() {}',
  ].join("\n"));
  await writeFile(path.join(consumer, "qualify.mjs"), [
    'import assert from "node:assert/strict";',
    'import * as sdk from "@cantelop/sdk";',
    'import * as build from "@cantelop/sdk/build";',
    'import * as sessionSDK from "@cantelop/sdk/session";',
    'import * as runtime from "@cantelop/sdk/runtime";',
    'assert.equal(build.CANTELOP_CLI_BUILD_PROTOCOL_VERSION, 6);',
    'assert.equal(typeof build.watchLocalProject, "function");',
    'assert.equal("buildApi" in build, false);',
    'assert.equal("buildLocalApi" in build, false);',
    'assert.equal("defineApi" in sdk, false);',
    'assert.equal(typeof sdk.CantelopClient, "function");',
    'assert.equal("createApp" in sdk, false);',
    'assert.equal("defineSessionBehaviour" in sessionSDK, false); assert.equal("defineSessionRuntime" in sdk, false);',
    'assert.deepEqual(Object.keys(runtime).sort(), ["createSessionDatabase", "createSessionRuntimeHandler", "serveSessionRuntime"]);',
    'for (const name of ["api", "edge"]) await assert.rejects(import(`@cantelop/sdk/${name}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });',
    'await import("@cantelop/sdk/harnesses/claude/protocol");',
    'const edge = await build.buildEdgeApi({ definition: "./definition.mjs", outdir: "./edge" });',
    'assert.equal(edge.manifest.kind, "cantelop-protocol-edge");',
    'assert.equal((await import(new URL(edge.mainModule, `file://${process.cwd()}/`))).default.fetch instanceof Function, true);',
    'const native = await build.buildSessionRuntime({ definition: "./definition.mjs", outdir: "./artifact" });',
    'const backend = await build.buildBackendClient({ definition: "./definition.mjs", outdir: "./backend" });',
    'assert.equal(backend.manifest.apps[0].session_runtime_id, native.manifest.session_runtime_id);',
    'assert.equal(edge.manifest.session_runtime_id, native.manifest.session_runtime_id);',
    'assert.equal(typeof build.createCantelopCompilerPlugin, "function");',
    'const compiledClient = (await import(new URL(backend.mainModule, `file://${process.cwd()}/`))).cantelop;',
    'assert.equal(compiledClient.name, "first-agent");',
    'assert.throws(() => compiledClient.runtime.receive(), /Sandbox/);',
    'assert.equal(native.manifest.dockerfile, "node_modules/@cantelop/sdk/dist/harnesses/claude/Dockerfile");',
    'const { readFile } = await import("node:fs/promises");',
    'assert.match(await readFile(new URL(import.meta.resolve("@cantelop/sdk/harnesses/claude/Dockerfile")), "utf8"), /claude-code@/);',
  ].join("\n"));
  await runCommand(process.execPath, ["qualify.mjs"], { cwd: consumer, maxBuffer: 1024 * 1024 });
  await writeFile(path.join(consumer, "integration.ts"), [
    'import { CantelopClient, CANTELOP_INTEGRATION_PROTOCOL_VERSION, type AppConnection, type AppCommandEnvelope, type SessionEventCursor } from "@cantelop/sdk";',
    'const runtime = { receive() {} };',
    'import { createClaudeHarness, createClaudeRuntime, claudeAuth, claudeDockerfile, NativeClaude, type ClaudeMessage, type ClaudeEvent, type ClaudeHarnessOptions, type ClaudeHarnessFactoryOptions } from "@cantelop/sdk/harnesses/claude";',
    'const claudeApp = new CantelopClient().app<ClaudeMessage, ClaudeEvent>({name:"claude-agent",runtime:{create:createClaudeHarness},auth:claudeAuth,dockerfile:claudeDockerfile});',
    'import { ClaudeSessionOutput, validateClaudeSessionConfig, type ClaudeSessionCommand, type ClaudeSessionEvent, type ClaudeSessionReply } from "@cantelop/sdk/harnesses/claude/protocol";',
    'const durableClaudeApp = new CantelopClient().app<ClaudeSessionCommand,ClaudeSessionEvent,ClaudeSessionReply>({name:"durable-claude",runtime:createClaudeRuntime({workspace:"/workspace"}),auth:claudeAuth,dockerfile:claudeDockerfile});',
    'const claudeOptions: ClaudeHarnessOptions = {workspace:"/workspace",sessionId:"session",binary:"/usr/local/bin/claude"};',
    'const claudeNative = new NativeClaude(claudeOptions);',
    'const claudeFactoryOptions: ClaudeHarnessFactoryOptions = {tools:[],allowedTools:["mcp__canvas__*"],mcps:{canvas:{type:"http",url:"https://tools.example/mcp"}},permissionMode:"dontAsk",settingSources:[],systemPrompt:"Use the supplied tools.",maxTurns:24,model:"sonnet",conversation:{id:"12345678-1234-4234-8234-123456789abc",resumable:true}};',
    'const configuredClaudeApp = new CantelopClient().app<ClaudeMessage,ClaudeEvent>({name:"configured-claude",runtime:{create(context){return createClaudeHarness(context,claudeFactoryOptions);}},auth:claudeAuth,dockerfile:claudeDockerfile});',
    '// @ts-expect-error A caller cannot override canonical Session identity.',
    'createClaudeHarness({} as import("@cantelop/sdk/session").SessionHarnessContext, {sessionId:"different-tenant"});',
    'import type { SessionHarnessWorkContext, SessionActivityContext } from "@cantelop/sdk/session";',
    'function activityContext(work: SessionHarnessWorkContext<string,never,{entries:string[]}>): SessionActivityContext<string,never,{entries:string[]}> { return work; }',
    'const harnessApp = new CantelopClient().app<{prompt:string},{text:string},{answer:string},{entries:string[]}>({name:"harness-agent",runtime:{create(context){return {async queue(message,work){await work.output.send({text:message.prompt});await work.view.commit({entries:[context.session.id]});return {answer:message.prompt};},steer(message,work){message.prompt;work.signal;},cancel(){return false;}};}}});',
    'const viewApp = new CantelopClient().app<string,never,never,{entries:string[]}>({name:"view-agent",runtime:{receive(context){context.activity.queue(work => work.view.commit({entries:[context.message.payload]}));},onActivate(context){context.view.commit({entries:[]});},onRecover(context){context.view.commit({entries:[context.recovery.id]});}}});',
    'const harnessReply: {answer:string} = await harnessApp.workspace({slug:"customer"}).session().request({prompt:"hello"});',
    'const authLogin = await claudeApp.workspace({slug:"customer"}).auth().login({force:true,signal:new AbortController().signal});',
    'if (!authLogin.authenticated) { const terminalId: string = authLogin.attemptId; }',
    '// @ts-expect-error Composite auth operations allocate their own command identities.',
    'claudeApp.workspace({slug:"customer"}).auth().login({id:"msg_custom"});',
    'const cancellation: {state:"requested"|"idle"} = await harnessApp.workspace({slug:"customer"}).session().cancel();',
    'const connection: AppConnection = { fetch: async () => new Response(null) };',
    'const app = new CantelopClient().app<{ prompt: string }, { text: string }, { answer: string }, { entries: string[] }>({ name: "first-agent", runtime, connection });',
    'new CantelopClient().app({ name: "first-agent", runtime });',
    '// A pure client does not require runtime configuration.',
    'new CantelopClient();',
    'const cantelop = new CantelopClient({ profile: "production" });',
    '// @ts-expect-error Workspace access belongs to an App.',
    'cantelop.workspace({ slug: "customer" });',
    '// @ts-expect-error Runtime configuration belongs to an App.',
    'new CantelopClient({ runtime });',
    '// @ts-expect-error Each App needs an explicit name.',
    'cantelop.app({ runtime });',
    '// @ts-expect-error App names are immutable.',
    'app.name = "renamed"',
    '// @ts-expect-error App identity alone does not define a runtime contract.',
    'new CantelopClient().app({ name: "first-agent", slug: "support-agent" });',
    '// @ts-expect-error Runtime identity is system managed.',
    'new CantelopClient().app({ name: "first-agent", runtime: { id: "package.v1", receive() {} } });',
    '// @ts-expect-error The client must be constructed with new.',
    'CantelopClient();',
    '// @ts-expect-error The factory options type was removed.',
    'type LegacyOptions = import("@cantelop/sdk").CreateAppOptions;',
    '// App is the typed Workspace/Session owner.',
    'type LegacyApp = import("@cantelop/sdk").App<unknown>;',
    'new CantelopClient().app({ name: "first-agent", runtime, connection });',
    'new CantelopClient().app({ name: "first-agent", runtime, connection });',
    '// @ts-expect-error App selectors require exactly one ID or slug.',
    'new CantelopClient().app({ name: "first-agent", runtime, id: "app_0123456789abcdef0123456789abcdef", slug: "support-agent" });',
    'const home: import("@cantelop/sdk").HomepageHandler<{prompt:string}> = ({app, request}) => new Response(app.name);',
    'new CantelopClient().app<{prompt:string}>({name:"home", runtime, homepage:home});',
    'const hook: import("@cantelop/sdk").WebhookHandler<{prompt:string}, {text:string}, {answer:string}, {entries:string[]}> = async ({ app, request, env }) => {',
    '  const session = app.workspace({ slug: "customer" }).session();',
    '  const reply: {answer:string} = await session.request({prompt:"hello"});',
    '  const state: {entries:string[]} = (await session.view()).state;',
    '  // @ts-expect-error Webhook App preserves its message type.',
    '  await session.dispatch(123);',
    '  return new Response(reply.answer);',
    '};',
    'new CantelopClient().app<{prompt:string}, {text:string}, {answer:string}, {entries:string[]}>({name:"webhook-app", runtime, webhooks:{"/webhooks/test":{method:"POST",handle:hook}}});',
    'const workspace = app.workspace({ slug: "customer" });',
    'const session = workspace.session({ keepAliveSeconds: 300 });',
    'const receipt = await session.dispatch({ prompt: "hello" });',
    'await receipt.status();',
    'const reply: { answer: string } = await session.request({ prompt: "hello" });',
    'await session.steer({ prompt: "focus" });',
    'await session.cancel();',
    '// @ts-expect-error Cancellation targets the active run, not a message.',
    'session.cancel(receipt.id);',
    '// @ts-expect-error Session-wide abort was removed.',
    'session.abort();',
    'const command: AppCommandEnvelope<{ prompt: string }> = { protocolVersion: 2, id: receipt.id, workspace: { slug: "customer" }, session: { id: session.id }, command: { type: "steer", message: { prompt: "focus" } } };',
    'const view = await session.view();',
    'const updatedAt: Date = view.updatedAt;',
    'const entries: string[] = view.state.entries;',
    'for await (const event of session.stream()) {',
    '  const cursor: SessionEventCursor = event.cursor;',
    '  const text: string = event.data.text;',
    '  // @ts-expect-error Event payload must retain its declared type.',
    '  const bad: number = event.data.text;',
    '}',
    '// @ts-expect-error Selectors require exactly one ID or slug.',
    'app.workspace({ id: "wsp_0123456789abcdef0123456789abcdef", slug: "customer" });',
    'workspace.session();',
    'workspace.session({});',
    '// @ts-expect-error Steering shares the dispatch message type.',
    'session.steer({ text: "wrong" });',
    '// @ts-expect-error Dispatch has its own input type.',
    'session.dispatch({ text: "wrong" });',
    'void [command, reply, updatedAt, entries, CANTELOP_INTEGRATION_PROTOCOL_VERSION];',
  ].join("\n"));
  await runCommand(process.execPath, [
    path.join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022",
    "--lib", "ES2022,DOM", "--skipLibCheck", "integration.ts",
  ], { cwd: consumer, maxBuffer: 1024 * 1024 });
  await writeFile(path.join(consumer, "integration.mjs"), [
    'import assert from "node:assert/strict";',
    'import { writeFile } from "node:fs/promises";',
    'import { CantelopClient, CANTELOP_INTEGRATION_PROTOCOL_VERSION } from "@cantelop/sdk";',
    'assert.equal(CANTELOP_INTEGRATION_PROTOCOL_VERSION, 2);',
    'const runtime = { receive() {} };',

    'let calls = 0;',
    'const app = new CantelopClient().app({ name: "first-agent", runtime, connection: { async fetch(request) {',
    '  calls++;',
    '  assert.equal(new URL(request.url).pathname, "/commands");',
    '  const body = await request.json();',
    '  assert.equal(body.workspace.id, "wsp_0123456789abcdef0123456789abcdef");',
    '  return Response.json({ protocolVersion: 2, id: body.id, status: "accepted", accepted_at: "2026-10-09T00:00:00Z" });',
    '} } });',
    'assert.equal(app.name, "first-agent");',
    'const session = app.workspace({ id: "wsp_0123456789abcdef0123456789abcdef" }).session({ keepAliveSeconds: 0 });',
    'assert.equal(calls, 0);',
    'assert.equal((await session.dispatch({ prompt: "hello" })).state, "accepted");',
    'assert.equal(calls, 1);',
    'for (const method of ["dispatch", "request", "stream", "view", "steer", "cancel", "stop"]) assert.equal(typeof session[method], "function");',
    'for (const key of Object.keys(process.env)) if (key.startsWith("CANTELOP_")) delete process.env[key];',
    'const appID = "app_0123456789abcdef0123456789abcdef";',
    'await writeFile("./integration.json", JSON.stringify({ schemaVersion: 1, activeProfile: "default", profiles: { default: { defaultApp: { id: appID }, apps: [{ id: appID, slug: "packed-app", accessToken: "packed-integration-token" }] } } }), { mode: 0o600 });',
    'process.env.CANTELOP_INTEGRATION_CONFIG = `${process.cwd()}/integration.json`;',
    'globalThis.fetch = async request => {',
    '  assert.equal(request.url, "https://packed-app.cantelop.dev/commands");',
    '  assert.equal(request.headers.get("authorization"), "Bearer packed-integration-token");',
    '  const body = await request.json();',
    '  return Response.json({ protocolVersion: 2, id: body.id, status: "accepted", accepted_at: "2026-10-09T00:00:00Z" });',
    '};',
    'const automatic = new CantelopClient().app({ name: "packed-app", runtime }).workspace({ slug: "customer" }).session();',
    'assert.equal((await automatic.dispatch({ prompt: "configured" })).state, "accepted");',
    'const selected = new CantelopClient().app({ name: "packed-app", runtime }).workspace({ slug: "customer" }).session();',
    'assert.equal((await selected.steer({ prompt: "priority" })).state, "accepted");',
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
