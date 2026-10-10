import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CantelopClient, CANTELOP_INTEGRATION_PROTOCOL_VERSION, RemoteAppError } from '../dist/index.js';
const fixture = JSON.parse(await readFile(new URL('./fixtures/integration-v2.json', import.meta.url), 'utf8'));
const session = fetch => new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch } }).workspace(fixture.workspace).session({ id: fixture.session.id });

test('shared fixture defines dispatch and steer admission with the same message shape and identity', async () => {
  assert.equal(CANTELOP_INTEGRATION_PROTOCOL_VERSION, 2);
  for (const type of ['dispatch', 'steer']) {
    const ref = session(async request => {
      assert.deepEqual(await request.json(), fixture[type]);
      return Response.json(fixture.accepted);
    });
    assert.equal((await ref[type](fixture[type].command.message, { id: fixture.id })).id, fixture.id);
  }
});

test('both message receipts inspect the original submission through a status command', async () => {
  const ref = session(async request => {
    const body = await request.json();
    if (body.command.type !== 'status') return Response.json(fixture.accepted);
    assert.equal(body.command.messageId, fixture.id);
    return Response.json(fixture.handled);
  });
  for (const type of ['dispatch', 'steer']) assert.equal((await (await ref[type]('hi', { id: fixture.id })).status()).state, 'handled');
});

test('cancellation targets one message and distinguishes requested, withdrawn and settled outcomes', async () => {
  for (const state of ['requested', 'cancelled', 'settled']) {
    const calls = [];
    const ref = session(async request => {
      const body = await request.json(); calls.push(body);
      assert.deepEqual(body.command, { type: 'cancel', messageId: fixture.id });
      return Response.json({ protocolVersion: 2, id: body.id, messageId: fixture.id, state, ...(state === 'settled' ? { status: fixture.handled } : {}) });
    });
    const result = await ref.cancel(fixture.id);
    assert.equal(result.state, state); assert.equal(result.messageId, fixture.id);
    assert.equal(calls.length, 1);
    if (state === 'settled') assert.equal(result.status.state, 'handled');
  }
});

test('cancellation retries retain command identity and remote errors; malformed target replies reject', async () => {
  const commandId = 'msg_' + 'f'.repeat(32);
  let calls = 0;
  const failed = session(async request => { calls++; assert.equal((await request.json()).id, commandId); throw new Error('lost'); });
  await assert.rejects(failed.cancel(fixture.id, { id: commandId }), error => error.code === 'command_outcome_unknown' && error.messageId === commandId);
  assert.equal(calls, 1);
  await assert.rejects(session(async () => Response.json({ error: { code: 'workspace_conflict' } }, { status: 409 })).cancel(fixture.id), error => error.code === 'workspace_conflict' && error.status === 409);
  for (const value of [{ protocolVersion: 2, messageId: 'other', state: 'requested' }, { protocolVersion: 2, messageId: fixture.id, state: 'done' }]) await assert.rejects(session(async () => Response.json(value)).cancel(fixture.id), /invalid_cancellation_response/);
});

test('durable view is a typed projection and carries the atomic subscription boundary without provisioning', async () => {
  let calls = 0;
  const ref = session(async request => {
    calls++; assert.equal((await request.json()).command.type, 'view');
    return Response.json(fixture.view);
  });
  const view = await ref.view();
  assert.deepEqual(view.state, { entries: ['hello'], inbox: [] });
  assert.deepEqual(view.cursor, fixture.view.cursor);
  assert.equal(view.revision, '7');
  assert.equal(view.updatedAt.toISOString(), fixture.view.updatedAt);
  assert.equal(calls, 1);
  assert.equal(Object.isFrozen(view.cursor), true);
});

test('view rejects invalid timestamps, revisions, cursor boundaries and identities', async () => {
  for (const value of [
    { ...fixture.view, protocolVersion: 1 }, { ...fixture.view, sessionId: 'other' },
    { ...fixture.view, revision: '' }, { ...fixture.view, updatedAt: 'bad' },
    { ...fixture.view, cursor: undefined }, { ...fixture.view, cursor: { streamId: 'bad', sequence: 0 } },
    { ...fixture.view, cursor: { ...fixture.view.cursor, sequence: -1 } },
  ]) await assert.rejects(session(async () => Response.json(value)).view(), RemoteAppError);
  const canonical = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch: async () => Response.json({ ...fixture.view, workspaceId: 'wsp_' + 'f'.repeat(32) }) } }).workspace({ id: fixture.workspaceId }).session({ id: fixture.session.id });
  await assert.rejects(canonical.view(), error => error.code === 'workspace_conflict');
});

test('view/stop/stream cancellation signals never invoke cancellation or activate an actor', async () => {
  const controller = new AbortController(); controller.abort(new Error('client gone'));
  let calls = 0;
  const ref = session(async () => { calls++; return new Response(); });
  await assert.rejects(ref.view({ signal: controller.signal }), /client gone/);
  await assert.rejects(ref.cancel(fixture.id, { signal: controller.signal }), /client gone/);
  assert.equal(calls, 0);
  assert.equal('abort' in ref, false);
});
