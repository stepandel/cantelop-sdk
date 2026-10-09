import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { createApp } from '../dist/index.js';
import { buildEdgeApi } from '../dist/build.js';

const bindings = { CANTELOP_INTEGRATION_TOKEN: 'test-app-token' };
const workspaceId = 'wsp_' + '1'.repeat(32);
const messageId = 'msg_' + '2'.repeat(32);

test('generated protocol Worker requires authentication and restricts private platform routing', async () => {
  const calls = [];
  const worker = createProtocolWorker({ fetch: async request => { calls.push(request); return Response.json({ ok: true }); } });
  const request = (route, method = 'GET', token = 'test-app-token') => new Request('https://agent.example' + route, {
    method, headers: { Authorization: `Bearer ${token}`, 'CANTELOP_APP_ID': 'forged', 'X-Cantelop-App-Id': 'forged' },
  });
  assert.equal((await worker.fetch(request('/__cantelop/app/v1/messages', 'POST'), {})).status, 503);
  assert.equal((await worker.fetch(request('/__cantelop/app/v1/messages', 'POST', 'wrong'), bindings)).status, 401);
  for (const route of ['/__cantelop/v1/messages', '/admin', '/__cantelop/app/v1/admin', '/__cantelop/integration/v1/admin']) {
    assert.equal((await worker.fetch(request(route, 'POST'), bindings)).status, 404);
  }
  assert.equal(calls.length, 0);
  assert.equal((await worker.fetch(request('/__cantelop/app/v1/messages', 'POST'), bindings)).status, 200);
  assert.equal(calls[0].url, 'https://runtime.cantelop.internal/__cantelop/v1/messages');
  assert.deepEqual([...calls[0].headers], []);
});

test('backend facade reaches private dispatch and receipts only through the protocol Worker', async () => {
  const calls = [];
  const worker = createProtocolWorker({ fetch: async request => {
    calls.push(request);
    if (request.method === 'POST') {
      const body = await request.json();
      return Response.json({ id: body.message.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' }, { status: 202 });
    }
    return Response.json({ id: new URL(request.url).pathname.split('/').at(-1), state: 'unknown' });
  } });
  const edgeCalls = [];
  const app = createApp({ connection: { fetch(request) {
    edgeCalls.push(request.url);
    const headers = new Headers(request.headers);
    headers.set('Authorization', 'Bearer test-app-token');
    return worker.fetch(new Request(request, { headers }), bindings);
  } } });
  const receipt = await app.workspace({ id: workspaceId }).session({ id: 'chat', keepAliveSeconds: 60 }).dispatch({ prompt: 'hello' });
  await receipt.status();
  assert.ok(edgeCalls.every(url => url.startsWith('https://edge.cantelop.internal/__cantelop/app/v1/')));
  assert.ok(calls.every(request => request.url.startsWith('https://runtime.cantelop.internal/__cantelop/v1/')));
});

test('Edge forwarding preserves streams, cancellation, control bodies, and error responses', async () => {
  const controller = new AbortController();
  let internal;
  const response = new Response('event: error\ndata: {"code":"stream_expired"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const worker = createProtocolWorker({ fetch: async request => { internal = request; return response; } });
  const request = new Request(`https://agent.example/__cantelop/app/v1/sessions/chat/events?workspace_id=${workspaceId}&after=7`, {
    headers: { Authorization: 'Bearer test-app-token', Accept: 'text/event-stream', 'Last-Event-ID': 'cursor' }, signal: controller.signal,
  });
  assert.equal(await worker.fetch(request, bindings), response);
  assert.equal(internal.headers.get('Last-Event-ID'), 'cursor');
  assert.equal(new URL(internal.url).searchParams.get('after'), '7');
  controller.abort();
  assert.equal(internal.signal.aborted, true);
  const controls = createProtocolWorker({ fetch: async request => {
    assert.equal(new URL(request.url).pathname, '/__cantelop/integration/v1/sessions/chat/controls');
    assert.deepEqual(await request.json(), { protocol_version: 1, type: 'abort', id: messageId });
    return Response.json({ code: 'unsupported_capability' }, { status: 409 });
  } });
  const result = await controls.fetch(new Request('https://agent.example/__cantelop/integration/v1/sessions/chat/controls', {
    method: 'POST', headers: { Authorization: 'Bearer test-app-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol_version: 1, type: 'abort', id: messageId }),
  }), bindings);
  assert.equal(result.status, 409);
});

test('CLI builds a protocol-owned Worker without a developer API entrypoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-edge-'));
  try {
    const artifact = await buildEdgeApi({ outdir: directory, runtimeOrigin: 'http://127.0.0.1:8877' });
    assert.equal(artifact.manifest.kind, 'cantelop-protocol-edge');
    assert.deepEqual(artifact.manifest.required_bindings, ['CANTELOP_INTEGRATION_TOKEN']);
    assert.deepEqual(JSON.parse(await readFile(artifact.manifestFile, 'utf8')), artifact.manifest);
    const worker = (await import(pathToFileURL(artifact.mainModule).href)).default;
    assert.equal((await worker.fetch(new Request('https://agent.example'), bindings)).status, 401);
    const source = await readFile(artifact.mainModule, 'utf8');
    assert.match(source, /127\.0\.0\.1:8877/);
    assert.doesNotMatch(source, /defineApi|serveSessionRuntime|node:|runtime-secret/);
    await assert.rejects(buildEdgeApi({ outdir: directory, runtimeOrigin: 'https://outside.example' }), /loopback/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('normal backend connection sends credentials to the App Edge URL and disallows unsafe origins', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async request => {
    calls.push(request);
    const body = await request.json();
    return Response.json({ id: body.message.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' }, { status: 202 });
  };
  try {
    const app = createApp({ edgeUrl: 'https://agent.example', accessToken: 'app-token' });
    await app.workspace({ id: workspaceId }).session({ id: 'chat', keepAliveSeconds: 60 }).dispatch({ prompt: 'hello' });
    assert.equal(calls[0].url, 'https://agent.example/__cantelop/app/v1/messages');
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer app-token');
    assert.equal(calls[0].redirect, 'manual');
    for (const edgeUrl of ['http://outside.example', 'https://user:pass@agent.example', 'https://agent.example/path']) {
      assert.throws(() => createApp({ edgeUrl, accessToken: 'token' }), /App Edge URL/);
    }
  } finally { globalThis.fetch = original; }
});
