import assert from 'node:assert/strict';
import test from 'node:test';
import { CantelopClient, RemoteAppError } from '../dist/index.js';
const workspaceId = 'wsp_' + '1'.repeat(32);
const workspace = { id: workspaceId, app_id: 'app_' + '2'.repeat(32), slug: 'customer', hostname: 'customer--agent.app.cantelop.dev', created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z' };
const accepted = body => Response.json({ protocolVersion: 2, id: body.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' }, { status: 202 });

test('Workspace auth requires an App declaration, uses a reserved Session and returns a browser terminal', async () => {
  const calls = [], id = 'msg_' + 'a'.repeat(32), terminalId = 'trm_' + 'c'.repeat(32), ticket = 'd'.repeat(64);
  const connection = { async fetch(request) {
    const body = await request.json(); calls.push(body);
    const auth = body.command.auth;
    return Response.json({ protocolVersion: 2, id: body.id, reply: auth.type === 'terminal'
      ? { type: 'terminal', terminalId, ticket, expiresAt: '2026-10-12T00:01:00Z', url: `wss://agent.example/__cantelop/auth/workspaces/wsp_${'1'.repeat(32)}/terminals/${terminalId}` }
      : auth.type === 'close' ? { type: 'closed', terminalId: auth.terminalId }
      : { type: 'status', authenticated: false } });
  } };
  const client = new CantelopClient();
  const runtime = { create: () => ({ queue() {}, steer() {}, cancel() { return false; } }) };
  assert.throws(() => client.app({ name: 'no-auth', runtime, connection }).workspace({ slug: 'customer' }).auth(), /does not declare auth/);
  assert.throws(() => client.app({ name: 'bad-auth', runtime, connection, auth: { status() {} } }), /status, logout and terminal/);
  const provider = { status() { return true; }, logout() {}, terminal() { throw new Error('Sandbox only'); } };
  const auth = client.app({ name: 'first-agent', runtime, connection, auth: provider }).workspace({ slug: 'customer' }).auth();
  assert.throws(() => client.app({ name: "reserved", runtime, connection }).workspace({ id: workspaceId }).session({ id: `cantelop-native-auth-${workspaceId}` }), /Reserved auth Session ID/);
  assert.equal(await auth.status({ id }), false);
  const terminal = await auth.terminal();
  assert.deepEqual({ ...terminal, protocols: [...terminal.protocols] }, {
    terminalId, url: `wss://agent.example/__cantelop/auth/workspaces/wsp_${'1'.repeat(32)}/terminals/${terminalId}`,
    protocols: ['cantelop-terminal.v1', ticket], expiresAt: new Date('2026-10-12T00:01:00Z'),
  });
  await auth.close({ terminalId });
  await assert.rejects(auth.close({ terminalId: 'bad' }), /Invalid auth terminal ID/);
  assert.equal(await auth.logout(), false);
  assert.equal(calls[0].id, id);
  assert.deepEqual(calls.map(call => call.command.auth), [{ type: 'status' }, { type: 'terminal' }, { type: 'close', terminalId }, { type: 'logout' }]);
  assert.ok(calls.every(call => call.session.id === 'cantelop-native-auth' && call.command.type === 'auth' && call.command.keepAliveSeconds === 900));
  // A compiled backend keeps only a marker; the provider itself stays in the Sandbox bundle.
  const compiled = client.app({ name: 'compiled', runtime, connection, auth: { [Symbol.for('dev.cantelop.sdk.compiled-auth.v1')]: true } });
  assert.equal(await compiled.workspace({ slug: 'customer' }).auth().status(), false);
});

test('references remain lazy, immutable and capture selectors/options; submissions share a payload type', async () => {
  const calls = [];
  const connection = { async fetch(request) {
    assert.equal(this, connection);
    assert.equal(request.url, 'https://edge.cantelop.internal/commands');
    assert.equal(request.method, 'POST');
    const body = await request.json(); calls.push(body); return accepted(body);
  } };
  const selector = { slug: 'customer' }, options = { id: 'chat', keepAliveSeconds: 300 };
  const ref = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection }).workspace(selector);
  const session = ref.session(options);
  selector.slug = 'changed'; options.id = 'changed'; options.keepAliveSeconds = 1;
  assert.equal(calls.length, 0);
  for (const value of [ref, ref.selector, session, session.workspace]) assert.equal(Object.isFrozen(value), true);
  const receipt = await session.dispatch({ prompt: 'hello' });
  await session.steer({ prompt: 'focus' }, { keepAliveSeconds: 0 });
  assert.equal(receipt.id, calls[0].id);
  assert.deepEqual(calls[0].workspace, { slug: 'customer' });
  assert.deepEqual(calls[0].session, { id: 'chat' });
  assert.deepEqual(calls[0].command, { type: 'dispatch', message: { prompt: 'hello' }, keepAliveSeconds: 300 });
  assert.deepEqual(calls[1].command, { type: 'steer', message: { prompt: 'focus' }, keepAliveSeconds: 0 });
});

test('omitted keep-alive reaches Edge without a fabricated default and session IDs are independent', async () => {
  const calls = [];
  const ref = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { async fetch(request) { const body = await request.json(); calls.push(body); return accepted(body); } } }).workspace({ id: workspaceId });
  const first = ref.session(), second = ref.session();
  assert.notEqual(first.id, second.id);
  assert.equal(first.keepAliveSeconds, undefined);
  await Promise.all([first.dispatch('one'), second.steer('two')]);
  assert.ok(calls.every(body => !('keepAliveSeconds' in body.command)));
});

test('Workspace resolution shares concurrent requests, retries failures and rejects mismatches', async () => {
  let calls = 0;
  const ref = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { async fetch(request) {
    assert.equal((await request.json()).command.type, 'workspace.resolve');
    if (++calls === 1) return Response.json({ error: { code: 'unavailable' } }, { status: 503 });
    return Response.json(workspace);
  } } }).workspace({ slug: 'customer' });
  await assert.rejects(ref.resolve(), error => error.code === 'unavailable');
  const [a, b] = await Promise.all([ref.resolve(), ref.resolve()]);
  assert.equal(a, b); assert.equal(calls, 2);
  const wrong = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch: async () => Response.json({ ...workspace, slug: 'wrong' }) } }).workspace({ slug: 'customer' });
  await assert.rejects(wrong.resolve(), /different Workspace/);
});

test('request retry identity and stop/reactivation use commands without provisioning', async () => {
  const calls = [], id = 'msg_' + '3'.repeat(32);
  const session = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { async fetch(request) {
    const body = await request.json(); calls.push(body);
    if (body.command.type === 'stop') return Response.json({ protocolVersion: 2, id: body.id });
    if (body.command.type === 'request') return Response.json({ protocolVersion: 2, id: body.id, reply: { answer: 'done' } });
    return accepted(body);
  } } }).workspace({ slug: 'customer' }).session({ id: 'chat' });
  assert.deepEqual(await session.request('hi', { id, timeoutMs: 15000 }), { answer: 'done' });
  await session.stop(); await session.dispatch('again');
  assert.deepEqual(calls.map(body => body.command.type), ['request', 'stop', 'dispatch']);
  assert.equal(calls[0].id, id); assert.equal(calls[0].command.timeoutMs, 15000);
});

test('selectors, identities, keep-alive and malformed messages fail before networking', async () => {
  let calls = 0;
  const app = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch() { calls++; throw new Error('unexpected'); } } });
  for (const value of [null, {}, { id: workspaceId, slug: 'customer' }, { id: 'bad' }, { slug: 'UPPER' }]) assert.throws(() => app.workspace(value), TypeError);
  const ref = app.workspace({ slug: 'customer' });
  for (const keepAliveSeconds of [-1, NaN, 604801]) assert.throws(() => ref.session({ keepAliveSeconds }), TypeError);
  assert.throws(() => ref.session({ id: '../evil' }), TypeError);
  const session = ref.session();
  await assert.rejects(session.dispatch(undefined), TypeError);
  await assert.rejects(session.dispatch(() => {}), TypeError);
  await assert.rejects(session.dispatch("x".repeat(1024 * 1024)), TypeError);
  await assert.rejects(session.steer('hi', { keepAliveSeconds: -1 }), TypeError);
  await assert.rejects(session.steer('hi', { keepAliveSeconds: null }), TypeError);
  await assert.rejects(session.cancel('bad'), TypeError);
  assert.equal(calls, 0);
});

test('dispatch and steer expose stable retry identities for ambiguous admission and validate receipts', async () => {
  for (const type of ['dispatch', 'steer']) {
    let calls = 0;
    const ref = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch() { calls++; throw new TypeError('fetch failed'); } } }).workspace({ slug: 'customer' }).session();
    await assert.rejects(ref[type]('hello'), error => error instanceof RemoteAppError && error.code === 'command_outcome_unknown' && /^msg_[0-9a-f]{32}$/.test(error.messageId));
    assert.equal(calls, 1);
    const invalid = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch: async () => Response.json({ protocolVersion: 2, id: 'wrong', status: 'accepted' }) } }).workspace({ id: workspaceId }).session();
    await assert.rejects(invalid[type]('hello'), error => error.code === 'invalid_message_response' && !!error.messageId);
  }
});
