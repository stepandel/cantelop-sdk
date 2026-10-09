import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CantelopClient } from "../dist/index.js";
import { createProtocolWorker } from "../dist/protocol-edge.js";
import { buildEdgeApi, buildSessionRuntime, watchLocalProject } from "../dist/build.js";

const runtime = { id: "chat.v1", entrypoint: "./agent.ts" };
const messageId = "msg_" + "1".repeat(32);
const clientModule = new URL("../dist/client.js", import.meta.url).pathname;
const sessionModule = new URL("../dist/session.js", import.meta.url).pathname;

function command(type = "view") {
  return { protocolVersion: 2, id: messageId, workspace: { slug: "customer" }, session: { id: "chat" }, command: { type } };
}
function request(body, runtimeId) {
  return new Request("https://agent.example/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer scoped", ...(runtimeId === undefined ? {} : { "X-Cantelop-Session-Runtime": runtimeId }) },
    body: JSON.stringify(body),
  });
}
function clientSource(id = "chat.v1", entrypoint = "./agent.ts", generics = "") {
  return `import { CantelopClient } from ${JSON.stringify(clientModule)};
    console.log("client-definition-only");
    export default new CantelopClient${generics}({ sessionRuntime: ${JSON.stringify({ id, entrypoint })} });`;
}
async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "cantelop-runtime-module-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, definition: path.join(directory, "cantelop.mts"), entrypoint: path.join(directory, "agent.ts"), outdir: path.join(directory, "out") };
}

test("clients require a runtime reference and capture it immutably without loading the module", async () => {
  for (const value of [undefined, null, {}, { id: "Chat v1", entrypoint: "./agent.ts" },
    { id: "chat.v1", entrypoint: "../agent.ts" }, { id: "chat.v1", entrypoint: "/agent.ts" },
    { id: "chat.v1", entrypoint: "./agent.ts", receive() {} }, { id: "chat.v1", entrypoint: "./" }]) {
    assert.throws(() => new CantelopClient({ sessionRuntime: value }), TypeError);
  }
  assert.throws(() => new CantelopClient(), TypeError);
  const metadata = { ...runtime };
  const ids = [];
  const cantelop = new CantelopClient({ sessionRuntime: metadata, connection: { async fetch(request) {
    ids.push(request.headers.get("X-Cantelop-Session-Runtime"));
    return Response.json({});
  } } });
  assert.equal(Object.isFrozen(cantelop.sessionRuntime), true);
  const first = cantelop.workspace({ slug: "customer" }).session();
  metadata.id = "changed.v2";
  metadata.entrypoint = "./missing.ts";
  assert.deepEqual(cantelop.sessionRuntime, runtime);
  assert.throws(() => { cantelop.sessionRuntime = metadata; }, TypeError);
  await first.stop();
  await cantelop.workspace({ slug: "customer" }).session().stop();
  assert.deepEqual(ids, ["chat.v1", "chat.v1"]);
});

test('Edge rejects missing or different runtime identity on every method before private routing', async () => {
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: runtime.id, fetch: async () => { calls++; return Response.json({}); } });
  const commands = [
    { type: 'dispatch', message: 'hello' }, { type: 'steer', message: 'hello' },
    { type: 'request', message: 'hello', timeoutMs: 1000 }, { type: 'cancel', messageId },
    { type: 'status', messageId }, { type: 'stop' }, { type: 'view' }, { type: 'stream' },
    { type: 'workspace.resolve' }, { type: 'workspace.database' },
  ];
  for (const value of commands) {
    const body = { ...command(), session: value.type.startsWith('workspace.') ? null : { id: 'chat' }, command: value };
    for (const id of [undefined, 'other.v1']) {
      const response = await worker.fetch(request(body, id), { CANTELOP_INTEGRATION_TOKEN: 'scoped' });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'session_runtime_mismatch');
    }
  }
  assert.equal(calls, 0);
});


test("artifacts bind one runtime ID without evaluating the agent; Sandbox contains no client definition", async t => {
  const { definition, entrypoint, outdir, directory } = await project(t);
  await writeFile(definition, clientSource());
  await writeFile(entrypoint, 'throw new Error("Agent evaluated during build"); export function receive() {}');
  const edge = await buildEdgeApi({ definition, outdir: path.join(directory, "edge") });
  const native = await buildSessionRuntime({ definition, outdir });
  assert.equal(edge.manifest.session_runtime_id, "chat.v1");
  assert.equal(native.manifest.session_runtime_id, edge.manifest.session_runtime_id);
  const source = await readFile(native.mainModule, "utf8");
  assert.match(source, /Agent evaluated during build/);
  assert.doesNotMatch(source, /CantelopClient|client-definition-only|edge\.cantelop\.internal/);
  await writeFile(definition, 'export default { sessionRuntime: { id: "chat.v1", entrypoint: "./agent.ts" } };');
  await assert.rejects(buildEdgeApi({ definition, outdir }), /CantelopClient/);
});

test("builds reject missing exports, invalid hooks, and mismatched handler contracts", async t => {
  const { definition, entrypoint, outdir } = await project(t);
  await writeFile(definition, clientSource("chat.v1", "./agent.ts", '<{ prompt: string }, { text: string }, { answer: string }>'));
  const context = `import type { SessionContext } from ${JSON.stringify(sessionModule)};`;
  for (const source of [
    "export function helper() {}",
    "export const receive = 42;",
    "export function receive() {} export const onActivate = 1;",
    "export function receive() {} export const onRecover = false;",
    "export function receive() {} export const redelivery = 1;",
    `${context} export function receive(context: SessionContext<{ other: number }>) {}`,
    `${context} export function receive(context: SessionContext<{ prompt: string }, { wrong: boolean }>) {}`,
    `${context} export function receive(context: SessionContext<{ prompt: string }, never, { wrong: boolean }>) {}`,
  ]) {
    await writeFile(entrypoint, source);
    await assert.rejects(buildEdgeApi({ definition, outdir }), /Invalid Session runtime module/);
  }
  await writeFile(entrypoint, `${context}
    export const redelivery = true;
    export async function onActivate() {}
    export async function onRecover() {}
    export async function receive(context: SessionContext<{ prompt: string }, { text: string }, { answer: string }>) {
      await context.output.send({ text: context.message.payload.prompt });
      context.reply({ answer: context.message.payload.prompt });
    }`);
  await buildSessionRuntime({ definition, outdir });
});

test("runtime references must resolve to an existing module inside the definition directory", async t => {
  const { directory, definition, outdir } = await project(t);
  await writeFile(definition, clientSource());
  await assert.rejects(buildSessionRuntime({ definition, outdir }), /does not exist/);
  const outside = await mkdtemp(path.join(tmpdir(), "cantelop-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const target = path.join(outside, "agent.ts");
  await writeFile(target, "export function receive() {}");
  await symlink(target, path.join(directory, "agent.ts"));
  await assert.rejects(buildSessionRuntime({ definition, outdir }), /inside its definition directory/);
});

test("watching follows runtime references, their imports, and contract changes", { timeout: 30000 }, async t => {
  const { directory, definition, outdir } = await project(t);
  const first = path.join(directory, "one.ts");
  const second = path.join(directory, "two.ts");
  await writeFile(first, 'export function receive() { console.log("first-behaviour"); }');
  const contract = path.join(directory, "payload.ts");
  await writeFile(contract, "export type Payload = unknown;");
  const secondSource = `import type { SessionContext } from ${JSON.stringify(sessionModule)};
    import type { Payload } from "./payload.js";
    export function receive(context: SessionContext<Payload>) { console.log("second-behaviour"); }`;
  await writeFile(second, secondSource);
  await writeFile(definition, clientSource("chat.v1", "./one.ts"));
  const events = [];
  const watcher = await watchLocalProject({ sessionDefinition: definition, sessionRuntimeOutdir: outdir, onBuild: event => events.push(event) });
  t.after(() => watcher.dispose());
  await writeFile(definition, clientSource("chat.v2", "./two.ts"));
  await waitFor(() => events.length > 0);
  assert.equal(events.at(-1).error, undefined);
  assert.match(await readFile(path.join(outdir, "session-runtime.mjs"), "utf8"), /second-behaviour/);
  assert.equal(JSON.parse(await readFile(path.join(outdir, "cantelop-runtime.json"), "utf8")).session_runtime_id, "chat.v2");
  events.length = 0;
  await writeFile(contract, "export type Payload = { incompatible: string };");
  await waitFor(() => events.some(event => event.error));
  assert.match(events.at(-1).error, /Invalid Session runtime module/);
  assert.equal(JSON.parse(await readFile(path.join(outdir, "cantelop-runtime.json"), "utf8")).session_runtime_id, "chat.v2");
  events.length = 0;
  await writeFile(contract, "export type Payload = unknown;");
  await waitFor(() => events.length > 0);
  assert.equal(events.at(-1).error, undefined);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for rebuild");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
