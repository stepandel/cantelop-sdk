import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CantelopClient } from '../dist/index.js';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { buildEdgeApi, buildSessionRuntime, watchLocalProject } from '../dist/build.js';

const runtime = { id: 'chat.v1', receive() {} };
const messageId = 'msg_' + '1'.repeat(32);
function command(type = 'view') {
  return { protocolVersion: 2, id: messageId, workspace: { slug: 'customer' }, session: { id: 'chat' }, command: { type } };
}
function request(body, runtimeId) {
  return new Request('https://agent.example/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer scoped', ...(runtimeId === undefined ? {} : { 'X-Cantelop-Session-Runtime': runtimeId }) }, body: JSON.stringify(body) });
}

test('clients require runtime handlers and capture their definition immutably', async () => {
  for (const value of [undefined, null, {}, { id: 'Chat v1', entrypoint: './session.ts' }, { id: 'chat.v1', entrypoint: '../session.ts' }, { id: 'chat.v1', entrypoint: '/session.ts' }, { id: 'chat.v1', receive: 1 }, { id: 'chat.v1', receive() {}, onActivate: 1 }]) {
    assert.throws(() => new CantelopClient({ sessionRuntime: value }), TypeError);
  }
  assert.throws(() => new CantelopClient(), TypeError);
  const activate = () => {};
  const metadata = { ...runtime, onActivate: activate, redelivery: true };
  const ids = [];
  const cantelop = new CantelopClient({ sessionRuntime: metadata, connection: { async fetch(request) {
    ids.push(request.headers.get('X-Cantelop-Session-Runtime'));
    return Response.json({});
  } } });
  assert.equal(Object.isFrozen(cantelop.sessionRuntime), true);
  assert.equal(cantelop.sessionRuntime.onActivate, activate);
  assert.equal(cantelop.sessionRuntime.redelivery, true);
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

const clientModule = new URL('../dist/client.js', import.meta.url).pathname;
function clientSource(id, handler = 'receive() {}') {
  return `import { CantelopClient } from ${JSON.stringify(clientModule)}; export default new CantelopClient({sessionRuntime:{id:${id},${handler}}});`;
}
test('both artifacts bind the client runtime without invoking handlers; Sandbox checks the identity', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-client-'));
  t.after(() => rm(directory, {recursive:true,force:true}));
  const definition = path.join(directory,'client.mjs');
  await writeFile(path.join(directory, 'agent.ts'), 'throw new Error("Agent evaluated before receive"); export function receive() {}');
  await writeFile(definition, clientSource('process.env.TEST_RUNTIME_ID ?? "chat.v1"', 'receive:async context => (await import("./agent.ts")).receive(context)'));
  const edge = await buildEdgeApi({definition,outdir:path.join(directory,'edge')});
  const native = await buildSessionRuntime({definition,outdir:path.join(directory,'native')});
  assert.equal(edge.manifest.session_runtime_id,'chat.v1');
  assert.equal(native.manifest.session_runtime_id,edge.manifest.session_runtime_id);
  await assert.rejects(promisify(execFile)(process.execPath,[native.mainModule], {env:{...process.env, TEST_RUNTIME_ID:'other.v1'}}), error => error.stderr.includes('Session runtime does not match'));
  await writeFile(definition,'export default {sessionRuntime:{id:"chat.v1",receive() {}}};');
  await assert.rejects(buildEdgeApi({definition,outdir:path.join(directory,'edge')}), /CantelopClient/);
});
test('watching the client rebuilds lazy handlers and artifact identity', {timeout:15000}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-client-watch-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const definition=path.join(directory,'client.mjs'), outdir=path.join(directory,'out');
  await writeFile(path.join(directory,'one.ts'),'export function receive() { console.log("first-behaviour"); }');
  await writeFile(path.join(directory,'two.ts'),'export function receive() { console.log("second-behaviour"); }');
  await writeFile(definition,clientSource('"chat.v1"','receive:async context => (await import("./one.ts")).receive(context)'));
  let finished; const rebuilt=new Promise(resolve => {finished=resolve;});
  const watcher=await watchLocalProject({sessionDefinition:definition,sessionRuntimeOutdir:outdir,onBuild:event=>finished(event)});
  t.after(()=>watcher.dispose());
  await writeFile(definition,clientSource('"chat.v2"','receive:async context => (await import("./two.ts")).receive(context)'));
  assert.equal((await rebuilt).error,undefined);
  assert.match(await readFile(path.join(outdir,'session-runtime.mjs'),'utf8'),/second-behaviour/);
  assert.equal(JSON.parse(await readFile(path.join(outdir,'cantelop-runtime.json'),'utf8')).session_runtime_id,'chat.v2');
});
