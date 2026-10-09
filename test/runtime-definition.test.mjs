import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CantelopClient, defineSessionRuntime } from '../dist/index.js';
import { defineSessionBehaviour } from '../dist/session.js';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { buildEdgeApi, buildSessionRuntime, watchLocalProject } from '../dist/build.js';

const runtime = defineSessionRuntime({ id: 'chat.v1', entrypoint: './session.ts' });
const messageId = 'msg_' + '1'.repeat(32);
function command(type = 'view') {
  return { protocolVersion: 2, id: messageId, workspace: { slug: 'customer' }, session: { id: 'chat' }, command: { type } };
}
function request(body, runtimeId) {
  return new Request('https://agent.example/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer scoped', ...(runtimeId === undefined ? {} : { 'X-Cantelop-Session-Runtime': runtimeId }) }, body: JSON.stringify(body) });
}

test('clients and behaviours require a valid shared runtime definition and capture it immutably', async () => {
  for (const value of [undefined, null, {}, { id: 'Chat v1', entrypoint: './session.ts' }, { id: 'chat.v1', entrypoint: '../session.ts' }, { id: 'chat.v1', entrypoint: '/session.ts' }]) {
    assert.throws(() => new CantelopClient({ sessionRuntime: value }), TypeError);
  }
  assert.throws(() => new CantelopClient(), TypeError);
  assert.throws(() => defineSessionBehaviour(() => {}), TypeError);
  assert.throws(() => defineSessionBehaviour(runtime, {}), TypeError);
  const behaviour = defineSessionBehaviour(runtime, () => {});
  assert.equal(behaviour.sessionRuntime, runtime);
  const metadata = { ...runtime };
  const ids = [];
  const cantelop = new CantelopClient({ sessionRuntime: metadata, connection: { async fetch(request) {
    ids.push(request.headers.get('X-Cantelop-Session-Runtime'));
    return Response.json({});
  } } });
  const first = cantelop.workspace({ slug: 'customer' }).session();
  metadata.id = 'changed.v2';
  assert.throws(() => { cantelop.sessionRuntime = metadata; }, TypeError);
  await first.stop();
  await cantelop.workspace({ slug: 'customer' }).session().stop();
  assert.deepEqual(ids, ['chat.v1', 'chat.v1']);
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

test('both build artifacts bind the same runtime without evaluating agent behaviour; Sandbox rejects a different behaviour', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-definition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = path.join(directory, 'definition.mjs');
  const behaviour = path.join(directory, 'session.ts');
  await writeFile(definition, `import { defineSessionRuntime } from ${JSON.stringify(new URL('../dist/session-runtime-definition.js', import.meta.url).pathname)}; export default defineSessionRuntime({ id: "chat.v1", entrypoint: "./session.ts" });`);
  await writeFile(behaviour, 'export default { sessionRuntime: { id: "other.v1" }, receive() {} };');
  const edge = await buildEdgeApi({ definition, outdir: path.join(directory, 'edge') });
  const native = await buildSessionRuntime({ definition, outdir: path.join(directory, 'native') });
  assert.equal(edge.manifest.session_runtime_id, 'chat.v1');
  assert.equal(native.manifest.session_runtime_id, edge.manifest.session_runtime_id);
  const worker = (await import(pathToFileURL(edge.mainModule).href)).default;
  assert.equal((await worker.fetch(request(command(), 'other.v1'), { CANTELOP_INTEGRATION_TOKEN: 'scoped' })).status, 409);
  await assert.rejects(promisify(execFile)(process.execPath, [native.mainModule]), error => error.stderr.includes('Session behaviour does not match'));
  await writeFile(behaviour, 'throw new Error("Behaviour executed during build"); export default { sessionRuntime: { id: "chat.v1" }, receive() {} };');
  await buildSessionRuntime({ definition, outdir: path.join(directory, 'native') });
  // Importing behaviour from the supposedly portable definition is rejected.
  await writeFile(behaviour, 'export default { id: "chat.v1", entrypoint: "./session.ts" };');
  await writeFile(definition, 'export { default } from "./session.ts";');
  await assert.rejects(buildEdgeApi({ definition, outdir: path.join(directory, 'edge') }), /must not import executable/);
});

test('watching a runtime definition rebuilds a changed behaviour entrypoint and updates artifact identity', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-definition-watch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = path.join(directory, 'definition.mjs'), outdir = path.join(directory, 'out');
  await writeFile(path.join(directory, 'one.ts'), 'export default { sessionRuntime: { id: "chat.v1" }, receive() { console.log("first-behaviour"); } };');
  await writeFile(path.join(directory, 'two.ts'), 'export default { sessionRuntime: { id: "chat.v2" }, receive() { console.log("second-behaviour"); } };');
  await writeFile(definition, 'export default { id: "chat.v1", entrypoint: "./one.ts" };');
  let finished;
  const rebuilt = new Promise(resolve => { finished = resolve; });
  const watcher = await watchLocalProject({ sessionDefinition: definition, sessionRuntimeOutdir: outdir, onBuild: event => finished(event) });
  t.after(() => watcher.dispose());
  await writeFile(definition, 'export default { id: "chat.v2", entrypoint: "./two.ts" };');
  assert.equal((await rebuilt).error, undefined);
  assert.match(await readFile(path.join(outdir, 'session-runtime.mjs'), 'utf8'), /second-behaviour/);
  assert.equal(JSON.parse(await readFile(path.join(outdir, 'cantelop-runtime.json'), 'utf8')).session_runtime_id, 'chat.v2');
});
