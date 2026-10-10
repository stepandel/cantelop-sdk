import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { CantelopClient } from '../dist/index.js';
import { buildEdgeApi } from '../dist/build.js';
const bindings = { CANTELOP_INTEGRATION_TOKEN: 'test-app-token', CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS: '120' };
const workspaceId = 'wsp_' + '1'.repeat(32), messageId = 'msg_' + '2'.repeat(32);
const envelope = command => ({ protocolVersion: 2, id: messageId, workspace: { slug: 'customer' }, session: { id: 'chat' }, command });
const request = (body, headers = {}) => new Request('https://agent.example/commands', {
  method: 'POST', headers: { Authorization: 'Bearer test-app-token', 'Content-Type': 'application/json', 'X-Cantelop-Session-Runtime': 'test.v1', ...headers }, body: JSON.stringify(body),
});
const accepted = id => Response.json({ id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' }, { status: 202 });

test('protocol Worker fails closed on auth, old routes, invalid commands and oversized input before private routing', async () => {
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: "test.v1", fetch: async () => { calls++; return accepted(messageId); } });
  assert.equal((await worker.fetch(request(envelope({ type: 'dispatch', message: 'hi' })), {})).status, 503);
  assert.equal((await worker.fetch(request(envelope({ type: 'dispatch', message: 'hi' }), { Authorization: 'Bearer wrong' }), bindings)).status, 401);
  for (const body of [
    { ...envelope({ type: 'dispatch', message: 'hi' }), protocolVersion: 1 },
    envelope({ type: 'abort' }), envelope({ type: 'steer', input: 'hi' }),
    envelope({ type: 'dispatch', message: 'hi', keepAliveSeconds: -1 }),
    envelope({ type: 'cancel', messageId: 'bad' }),
    { ...envelope({ type: 'view' }), session: { id: '../admin' } },
    { ...envelope({ type: 'view' }), workspace: { id: workspaceId, slug: 'customer' } },
    envelope({ type: 'view', url: 'https://outside.example' }),
    envelope({ type: 'stream', after: { streamId: 'a'.repeat(32), sequence: -1 } }),
  ]) assert.equal((await worker.fetch(request(body), bindings)).status, 400);
  assert.equal((await worker.fetch(request(envelope({ type: 'dispatch', message: 'x'.repeat(1024 * 1024) })), bindings)).status, 413);
  for (const route of ['/__cantelop/app/v2/commands', '/__cantelop/v1/messages', '/__cantelop/app/v1/messages', '/__cantelop/integration/v1/sessions/chat']) {
    assert.equal((await worker.fetch(new Request('https://agent.example' + route, { method: 'POST', headers: { Authorization: 'Bearer test-app-token', 'Content-Type': 'application/json' }, body: JSON.stringify(envelope({ type: 'view' })) }), bindings)).status, 404);
  }
  assert.equal(calls, 0);
});

test('dispatch and steer use clean admission handlers: canonical Workspace, stable ID, distinct priority, explicit/default keep-alive', async () => {
  const calls = [];
  const worker = createProtocolWorker({ runtimeId: "test.v1", fetch: async req => {
    calls.push(req.clone());
    if (req.url.endsWith('/workspaces/open')) return Response.json({ id: workspaceId, slug: 'customer' });
    const body = await req.json(); return accepted(body.message.id);
  } });
  for (const type of ['dispatch', 'steer']) {
    const response = await worker.fetch(request(envelope({ type, message: { text: 'hi' } }), { 'CANTELOP_APP_ID': 'forged', 'X-Cantelop-App-Id': 'forged' }), bindings);
    assert.equal(response.status, 202); assert.equal((await response.json()).protocolVersion, 2);
    const admission = calls.at(-1);
    assert.equal(new URL(admission.url).pathname, '/__cantelop/integration/v2/messages');
    assert.deepEqual(await admission.json(), { session: { id: 'chat', workspace_id: workspaceId, keep_alive_seconds: 120 }, message: { id: messageId, payload: { text: 'hi' } }, priority: type === 'steer' ? 'priority' : 'normal' });
    assert.equal(admission.headers.get('Authorization'), null);
    assert.equal(admission.headers.get('X-Cantelop-App-Id'), null);
  }
  const explicit = { ...envelope({ type: 'dispatch', message: 'hi', keepAliveSeconds: 0 }), workspace: { id: workspaceId } };
  await worker.fetch(request(explicit), { CANTELOP_INTEGRATION_TOKEN: 'test-app-token' });
  assert.equal((await calls.at(-1).json()).session.keep_alive_seconds, 0);
  const count = calls.length;
  assert.equal((await worker.fetch(request(envelope({ type: 'dispatch', message: 'hi' })), { CANTELOP_INTEGRATION_TOKEN: 'test-app-token' })).status, 503);
  assert.equal(calls.length, count);
});

test('cancel, stop, status, view and stream never open Workspaces; their private handlers are selector-bound', async () => {
  const calls = [];
  const worker = createProtocolWorker({ runtimeId: "test.v1", fetch: async req => {
    calls.push(req.clone());
    if (req.headers.get('Accept') === 'text/event-stream') return new Response('event: error\ndata: {"code":"event_stream_reset"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return Response.json({ id: messageId, state: 'requested', messageId });
  } });
  for (const command of [
    { type: 'cancel', messageId }, { type: 'stop' }, { type: 'status', messageId }, { type: 'view' },
    { type: 'stream', after: { streamId: 'a'.repeat(32), sequence: 7 } },
  ]) await worker.fetch(request(envelope(command)), bindings);
  assert.deepEqual(calls.map(req => req.method), ['POST', 'DELETE', 'GET', 'GET', 'GET']);
  assert.deepEqual(calls.map(req => new URL(req.url).pathname), [
    `/__cantelop/integration/v2/sessions/chat/messages/${messageId}/cancel`,
    '/__cantelop/integration/v2/sessions/chat',
    `/__cantelop/integration/v2/sessions/chat/messages/${messageId}`,
    '/__cantelop/integration/v2/sessions/chat/view', '/__cantelop/integration/v2/sessions/chat/events',
  ]);
  assert.ok(calls.every(req => new URL(req.url).searchParams.get('workspace_slug') === 'customer'));
  assert.deepEqual(await calls[0].json(), { id: messageId });
  assert.equal(new URL(calls[4].url).searchParams.get('after'), '7');
});

test('SDK receipts traverse Edge and private admission/status handlers with no direct platform calls', async () => {
  const calls = [];
  const worker = createProtocolWorker({ runtimeId: "test.v1", fetch: async req => {
    calls.push(req);
    if (req.method === 'POST') return accepted((await req.json()).message.id);
    return Response.json({ id: new URL(req.url).pathname.split('/').at(-1), state: 'unknown' });
  } });
  const publicCalls = [];
  const app = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch(req) {
    req.headers.set("X-Cantelop-Session-Runtime", "test.v1");
    publicCalls.push(req.url);
    const headers = new Headers(req.headers); headers.set('Authorization', 'Bearer test-app-token');
    return worker.fetch(new Request(req, { headers }), bindings);
  } } });
  const ref = app.workspace({ id: workspaceId }).session({ id: 'chat' });
  for (const type of ['dispatch', 'steer']) assert.equal((await (await ref[type]('hello')).status()).state, 'unknown');
  assert.ok(publicCalls.every(url => url === 'https://edge.cantelop.internal/commands'));
  assert.ok(calls.every(req => req.url.startsWith('https://runtime.cantelop.internal/__cantelop/integration/v2/')));
});

test('streaming is forwarded without buffering and subscription cancellation reaches only the private read', async () => {
  const controller = new AbortController(); let internal;
  const response = new Response('data: live\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const worker = createProtocolWorker({ runtimeId: "test.v1", fetch: async req => { internal = req; return response; } });
  const req = new Request(request(envelope({ type: 'stream' })), { signal: controller.signal });
  assert.equal(await worker.fetch(req, bindings), response);
  controller.abort(); assert.equal(internal.signal.aborted, true);
});

test('private errors and request semantics survive command handling; defaults do not extend unrelated commands', async () => {
  const worker = createProtocolWorker({ runtimeId: "test.v1", fetch: async req => {
    assert.equal(new URL(req.url).pathname, '/__cantelop/integration/v2/requests');
    assert.equal((await req.json()).timeout_ms, 15000);
    return Response.json({ error: { code: 'capability_unsupported' } }, { status: 409 });
  } });
  const result = await worker.fetch(request({ ...envelope({ type: 'request', message: 'hi', timeoutMs: 15000 }), workspace: { id: workspaceId } }), bindings);
  assert.equal(result.status, 409); assert.equal((await result.json()).error.code, 'capability_unsupported');
});

test('CLI emits a protocol-owned Worker without an author API entrypoint or credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-edge-'));
  try {
    const definition = path.join(directory, 'definition.mjs');
    await writeFile(path.join(directory, 'session.ts'), 'export function receive() {}');
    await writeFile(definition, `import { CantelopClient } from ${JSON.stringify(new URL("../dist/client.js", import.meta.url).pathname)}; export default new CantelopClient().app({ name: "first-agent",runtime:{ receive() {} }});`);
    const artifact = await buildEdgeApi({ definition, outdir: directory, runtimeOrigin: 'http://127.0.0.1:8877' });
    assert.equal(artifact.manifest.kind, 'cantelop-protocol-edge');
    assert.equal(artifact.manifest.integration_protocol_version, 2);
    assert.deepEqual(JSON.parse(await readFile(artifact.manifestFile, 'utf8')), artifact.manifest);
    const worker = (await import(pathToFileURL(artifact.mainModule).href)).default;
    assert.equal((await worker.fetch(new Request('https://agent.example'), bindings)).status, 401);
    const source = await readFile(artifact.mainModule, 'utf8');
    assert.match(source, /127\.0\.0\.1:8877/); assert.doesNotMatch(source, /defineApi|serveSessionRuntime|node:|test-app-token/);
    await assert.rejects(buildEdgeApi({ definition, outdir: directory, runtimeOrigin: 'https://outside.example' }), /loopback/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('normal backend transport addresses only the App Edge command endpoint and never follows redirects', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async req => { calls.push(req); const body = await req.json(); return Response.json({ protocolVersion: 2, id: body.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' }); };
  try {
    const session = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, edgeUrl: 'https://agent.example', accessToken: 'app-token' }).workspace({ id: workspaceId }).session();
    await session.dispatch('hello');
    assert.equal(calls[0].url, 'https://agent.example/commands');
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer app-token'); assert.equal(calls[0].redirect, 'manual');
    for (const edgeUrl of ['http://outside.example', 'https://user:pass@agent.example', 'https://agent.example/path']) assert.throws(() => new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, edgeUrl, accessToken: 'token' }), /App Edge URL/);
  } finally { globalThis.fetch = original; }
});
