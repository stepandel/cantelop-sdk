import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createSessionRuntimeHandler } from '../dist/runtime.js';
import { RuntimeMessages } from '../dist/runtime-messages.js';
const sandbox = 'sbx-' + '1'.repeat(32);
const id = 'msg_' + '2'.repeat(32);
const envelope = (payload = {}) => ({ session: { id: 'thread', workspace_id: 'wsp_' + '3'.repeat(32), keep_alive_seconds: 600 }, message: { id, payload } });
async function fixture(t, receive, options = {}) {
  const server = createServer(createSessionRuntimeHandler({ receive }, { sandboxId: sandbox, ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (path, method = 'GET', body, identity = sandbox) => fetch(`http://127.0.0.1:${server.address().port}/__cantelop/v2/${path}`, {
    method, headers: { 'X-Cantelop-Sandbox-ID': identity, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('condition not reached');
}
test('ACK reserves the ID before execution settles; retries do not execute twice', async t => {
  let release; let calls = 0;
  const gate = new Promise(r => { release = r; });
  const request = await fixture(t, async () => { calls++; await gate; });
  t.after(() => release());
  const response = await request('messages', 'POST', envelope({ a: 1, b: 2 }));
  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.sandbox_id, sandbox); assert.equal(receipt.sequence, 1);
  const retry = await request('messages', 'POST', envelope({ b: 2, a: 1 }));
  assert.equal(retry.status, 202); assert.equal((await retry.json()).generation, receipt.generation);
  assert.equal(calls, 1);
  assert.equal((await request('messages', 'POST', envelope({ a: 3 }))).status, 409);
  release();
  await until(async () => (await (await request(`messages/${id}`)).json()).state === 'succeeded');
});
test('wrong sandbox is rejected before admission or acknowledgement', async t => {
  let calls = 0;
  const request = await fixture(t, async () => { calls++; });
  assert.equal((await request('messages', 'POST', envelope(), 'sbx-' + '4'.repeat(32))).status, 409);
  assert.equal(calls, 0);
  assert.equal((await request('runtime/observations/ack', 'POST', { through: 0 }, 'wrong')).status, 409);
});
test('telemetry never blocks handler entry; reading does not acknowledge', async t => {
  let calls = 0;
  const request = await fixture(t, async () => { calls++; });
  const body = envelope();
  body.observability = { attempt_id: 'att_' + 'a'.repeat(32), attempt: 1, traceparent: '00-' + 'b'.repeat(32) + '-' + 'c'.repeat(16) + '-01' };
  assert.equal((await request('messages', 'POST', body)).status, 202);
  await until(() => calls === 1);
  const path = 'runtime/observations?after=0&wait=0';
  const first = await (await request(path)).json();
  assert(first.observations.some(x => x.observation.type === 'span.completed'));
  assert.deepEqual(await (await request(path)).json(), first);
  assert.equal((await request('runtime/observations?after=999&wait=0')).status, 409);
  const last = first.observations.at(-1).cursor;
  assert.equal((await request('runtime/observations/ack', 'POST', { through: last })).status, 200);
  assert.equal((await request(path)).status, 409);
  const meta = await (await request('runtime')).json();
  assert.equal(meta.observations.acknowledged, last);
});
test('deadline requests cancellation and does not falsely report an uncooperative handler stopped', async t => {
  let signal; let release;
  const gate = new Promise(r => { release = r; });
  const request = await fixture(t, async context => { signal = context.signal; await gate; }, { executionTimeoutMs: 25 });
  t.after(() => release());
  await request('messages', 'POST', envelope());
  await until(() => signal?.aborted);
  assert.equal((await (await request(`messages/${id}`)).json()).state, 'cancelling');
  release();
  await until(async () => (await (await request(`messages/${id}`)).json()).state === 'timed_out');
});
test('capacity rejection preserves duplicate reservations', async () => {
  const registry = new RuntimeMessages(sandbox, 1000, 1);
  const enqueue = () => ({ generation: 1, settled: Promise.resolve() });
  registry.admit(id, {}, enqueue);
  assert.throws(() => registry.admit('other', {}, enqueue), /mailbox_capacity/);
  assert.equal(registry.admit(id, {}, enqueue).receipt.sequence, 1);
});
