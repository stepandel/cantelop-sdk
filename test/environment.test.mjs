import assert from 'node:assert/strict';
import test from 'node:test';
import { CantelopClient } from '../dist/index.js';
import { createProtocolWorker } from '../dist/protocol-edge.js';

function fixture(platform) {
  const calls = [];
  const worker = createProtocolWorker({ runtimeId: 'unrelated.v1', environment: { GH_TOKEN: { secret: true }, MODEL: {} }, fetch: async request => {
    assert.equal(request.headers.get('Authorization'), null);
    calls.push({ path: new URL(request.url).pathname, body: await request.json() });
    return platform(calls.at(-1));
  } });
  const app = new CantelopClient().app({ name: 'agent', runtime: { receive() {} }, connection: {
    fetch: request => worker.fetch(new Request(request, { headers: { ...Object.fromEntries(request.headers), Authorization: 'Bearer app-token' } }), { CANTELOP_INTEGRATION_TOKEN: 'app-token' }),
  } });
  return { app, calls };
}

test('environment updates use the existing App connection without a Workspace, Session or runtime match', async () => {
  const f = fixture(() => Response.json({ revision: 7, status: 'pending' }));
  assert.deepEqual(await f.app.environment().set('GH_TOKEN', 'fixture-token', { secret: true }), { revision: 7, status: 'pending' });
  await f.app.environment().unset('GH_TOKEN', { secret: true });
  await f.app.environment().status(7);
  assert.deepEqual(f.calls.map(call => call.path), ['/__cantelop/v1/environment/set', '/__cantelop/v1/environment/unset', '/__cantelop/v1/environment/status']);
  assert.deepEqual(f.calls[0].body, { type: 'app.environment.set', name: 'GH_TOKEN', value: 'fixture-token', secret: true });
  assert.ok(f.calls.every(call => !('workspace' in call.body) && !('session' in call.body)));
});

test('secret names, sizes, kinds and undeclared values are rejected before platform routing', async () => {
  const f = fixture(() => { throw new Error('unexpected'); });
  for (const name of ['CANTELOP_INTEGRATION_TOKEN', '../TOKEN', '']) await assert.rejects(f.app.environment().set(name, 'value', { secret: true }));
  await assert.rejects(f.app.environment().set('GH_TOKEN', 'x'.repeat(65537), { secret: true }));
  await assert.rejects(f.app.environment().set('GH_TOKEN', 'a\0b', { secret: true }));
  await assert.rejects(f.app.environment().set('UNKNOWN', 'value', { secret: true }), error => error.code === 'environment_not_declared');
  await assert.rejects(f.app.environment().set('GH_TOKEN', 'value'), error => error.code === 'environment_not_declared');
  for (const revision of [-1, NaN, '7']) await assert.rejects(f.app.environment().status(revision));
  assert.equal(f.calls.length, 0);
});

test('wait handles propagation, failure, abort and timeout without exposing stored values', async () => {
  let attempts = 0;
  const f = fixture(() => Response.json({ revision: 1, status: ++attempts > 1 ? 'applied' : 'pending' }));
  assert.equal((await f.app.environment().wait(1)).status, 'applied');
  const failed = fixture(() => Response.json({ revision: 1, status: 'failed' }));
  await assert.rejects(failed.app.environment().wait(1), error => error.code === 'environment_update_failed');
  const pending = fixture(() => Response.json({ revision: 1, status: 'pending' }));
  await assert.rejects(pending.app.environment().wait(1, { timeoutMs: 5 }));
  await assert.rejects(pending.app.environment().wait(1, { signal: AbortSignal.abort(new Error('stopped')) }), /stopped/);
  const unsafe = fixture(() => Response.json({ revision: 1, status: 'applied', value: 'must-not-return' }));
  await assert.rejects(unsafe.app.environment().status(1), error => error.code === 'invalid_environment_response');
  assert.equal(attempts, 2);
});

test('Edge refuses caller-selected App identities and malformed scopes without invoking private routes', async () => {
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: 'unused.v1', environment: { GH_TOKEN: { secret: true } }, fetch() { calls++; throw new Error('unexpected'); } });
  const base = { protocolVersion: 2, id: `msg_${'a'.repeat(32)}`, workspace: null, session: null, command: { type: 'app.environment.set', name: 'GH_TOKEN', value: 'token', secret: true } };
  for (const body of [{ ...base, workspace: { slug: 'foreign' } }, { ...base, appId: 'foreign' }, { ...base, command: { ...base.command, appId: 'foreign' } }, { ...base, session: { id: 'chat' } }]) {
    const response = await worker.fetch(new Request('https://agent.example/commands/app.environment.set', { method: 'POST', headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { CANTELOP_INTEGRATION_TOKEN: 'token' });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});
