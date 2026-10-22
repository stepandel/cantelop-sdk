import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { APP_COMMAND_TYPES } from '../dist/integration-protocol.js';
import { CantelopClient } from '../dist/index.js';
import { buildEdgeApi } from '../dist/build.js';
const bindings = { CANTELOP_INTEGRATION_TOKEN: 'test-app-token', CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS: '120' };
const workspaceId = 'wsp_' + '1'.repeat(32), messageId = 'msg_' + '2'.repeat(32);
const envelope = command => ({ protocolVersion: 2, id: messageId, workspace: { slug: 'customer' }, session: { id: 'chat' }, command });
// Commands are addressed by path; a malformed body still reaches validation through a valid path.
const commandPath = body => APP_COMMAND_TYPES.includes(body?.command?.type) ? body.command.type : 'dispatch';
const request = (body, headers = {}) => new Request(`https://agent.example/commands/${commandPath(body)}`, {
  method: 'POST', headers: { Authorization: 'Bearer test-app-token', 'Content-Type': 'application/json', 'X-Cantelop-Session-Runtime': 'test.v1', ...headers }, body: JSON.stringify(body),
});
const accepted = id => Response.json({ id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' }, { status: 202 });

test('auth commands route through a Workspace-bound request with a reserved Session', async () => {
  const calls = [], terminalId = 'trm_' + '3'.repeat(32);
  const platform = async req => {
    calls.push(req.clone());
    if (req.url.endsWith('/workspaces/open')) return Response.json({ id: workspaceId, slug: 'customer' });
    const payload = (await req.clone().json()).message.payload;
    return Response.json({ id: messageId, reply: payload.auth.type === 'terminal'
      ? { type: 'terminal', terminalId, ticket: '4'.repeat(64), expiresAt: '2026-10-12T00:01:00Z' }
      : { type: 'status', authenticated: false } });
  };
  const body = { ...envelope({ type: 'auth', auth: { type: 'status' }, timeoutMs: 45_000, keepAliveSeconds: 0 }), session: { id: 'cantelop-native-auth' } };
  const undeclared = createProtocolWorker({ runtimeId: 'test.v1', fetch: platform });
  const refused = await undeclared.fetch(request(body), bindings);
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), { error: { code: 'auth_not_configured' } });
  assert.equal(calls.length, 0);
  const worker = createProtocolWorker({ runtimeId: 'test.v1', auth: true, fetch: platform });
  const response = await worker.fetch(request(body), bindings);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).reply, { type: 'status', authenticated: false });
  const delivered = await calls.at(-1).json();
  assert.equal(new URL(calls.at(-1).url).pathname, '/__cantelop/integration/v2/requests');
  assert.deepEqual(delivered.message.payload, { __cantelop_command: 2, type: 'auth', auth: { type: 'status' } });
  assert.equal(delivered.session.id, `cantelop-native-auth-${workspaceId}`);
  assert.equal(delivered.session.workspace_id, workspaceId);
  assert.equal(delivered.session.keep_alive_seconds, 0);
  const terminal = await worker.fetch(request({ ...body, command: { ...body.command, auth: { type: 'terminal' } } }), bindings);
  assert.equal((await terminal.json()).reply.url, `wss://agent.example/__cantelop/auth/workspaces/${workspaceId}/terminals/${terminalId}`);
  assert.equal((await worker.fetch(request(envelope(body.command)), bindings)).status, 400);
  for (const auth of [{ type: 'submit', attemptId: 'bad', code: 'secret' }, { type: 'login', method: 'browser-code' }, { type: 'close', terminalId: 'bad' }])
    assert.equal((await worker.fetch(request({ ...body, command: { ...body.command, auth } }), bindings)).status, 400);
});

test('the browser terminal route forwards only the WebSocket handshake to the auth Sandbox', async () => {
  const calls = [], terminalId = 'trm_' + '5'.repeat(32);
  const path = `/__cantelop/auth/workspaces/${workspaceId}/terminals/${terminalId}`;
  const upgrade = (headers = {}) => new Request(`https://agent.example${path}`, { headers: {
    Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Protocol': `cantelop-terminal.v1, ${'6'.repeat(64)}`, Cookie: 'session=browser', Authorization: 'Bearer user', ...headers } });
  const worker = createProtocolWorker({ runtimeId: 'test.v1', auth: true, fetch: async req => { calls.push(req); return new Response(null, { status: 200 }); } });
  assert.equal((await worker.fetch(upgrade(), {})).status, 200);
  const forwarded = calls[0];
  assert.equal(forwarded.url, `https://runtime.cantelop.internal/__cantelop/integration/v2/sessions/cantelop-native-auth-${workspaceId}/auth/terminals/${terminalId}?workspace_id=${workspaceId}`);
  assert.deepEqual([...forwarded.headers.keys()].sort(), ['connection', 'sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-version', 'upgrade']);
  assert.equal((await worker.fetch(upgrade({ Upgrade: 'h2c' }), {})).status, 426);
  assert.equal((await worker.fetch(new Request(`https://agent.example/__cantelop/auth/workspaces/${workspaceId}/terminals/trm_bad`), bindings)).status, 401);
  const undeclared = createProtocolWorker({ runtimeId: 'test.v1', fetch: async req => { calls.push(req); return new Response(null); } });
  assert.equal((await undeclared.fetch(upgrade(), {})).status, 404);
  assert.equal(calls.length, 1);
});

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
  // The path names the operation; a body that names another one is rejected rather than rerouted.
  const mismatched = await worker.fetch(new Request('https://agent.example/commands/view', request(envelope({ type: 'stop' }))), bindings);
  assert.equal(mismatched.status, 400); assert.equal((await mismatched.json()).error.code, 'command_path_mismatch');
  for (const route of ['/commands', '/commands/', '/commands/abort', '/commands/view/extra', '/__cantelop/app/v2/commands', '/__cantelop/v1/messages', '/__cantelop/app/v1/messages', '/__cantelop/integration/v1/sessions/chat']) {
    assert.equal((await worker.fetch(new Request('https://agent.example' + route, { method: 'POST', headers: { Authorization: 'Bearer test-app-token', 'Content-Type': 'application/json' }, body: JSON.stringify(envelope({ type: 'view' })) }), bindings)).status, 404);
  }
  assert.equal(calls, 0);
});

test('dispatch and steer use clean admission handlers: canonical Workspace, stable ID, opaque SDK command payloads, explicit/default keep-alive', async () => {
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
    assert.deepEqual(await admission.json(), { session: { id: 'chat', workspace_id: workspaceId, keep_alive_seconds: 120 }, message: { id: messageId, payload: {__cantelop_command:2,type,message:{text:"hi"}} } });
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

test("cancel uses uniform request delivery; read operations retain selector scope",async()=>{
 const calls=[];const worker=createProtocolWorker({runtimeId:"test.v1",fetch:async req=>{
  calls.push(req.clone());
  if(req.headers.get("Accept")==="text/event-stream")return new Response("event: error\ndata: {\"code\":\"event_stream_reset\"}\n\n",{headers:{"Content-Type":"text/event-stream"}});
  if(new URL(req.url).pathname.endsWith("/requests"))return Response.json({id:messageId,reply:{id:messageId,state:"requested"}});
  return Response.json({id:messageId,state:"handling",workspace_id:workspaceId});
 }});
 for(const command of [{type:"cancel"},{type:"stop"},{type:"status",messageId},{type:"view"},{type:"stream",after:{streamId:"a".repeat(32),sequence:7}}])assert.equal((await worker.fetch(request(envelope(command)),bindings)).status,200);
 assert.deepEqual(calls.map(req=>req.method),["POST","DELETE","GET","GET","GET"]);
 assert.equal(new URL(calls[0].url).pathname,"/__cantelop/integration/v2/sessions/chat/requests");
 const delivered=await calls[0].json();assert.deepEqual(delivered.message,{id:messageId,payload:{__cantelop_command:2,type:"cancel"}});assert.equal(new URL(calls[0].url).searchParams.get("workspace_slug"),"customer");assert.equal(delivered.keep_alive_seconds,120);
 assert.ok(calls.every(req=>!req.url.includes("/cancel")&&!req.url.endsWith("/workspaces/open")));
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
  assert.deepEqual(publicCalls.map(url => new URL(url).pathname), ['/commands/dispatch', '/commands/status', '/commands/steer', '/commands/status']);
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
    assert.equal(artifact.manifest.fleet_execution_protocol_version, 1);
    assert.deepEqual(artifact.manifest.optional_bindings, ['CANTELOP_INTEGRATION_TOKEN_PREVIOUS', 'CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT', 'CANTELOP_FLEET_EXECUTION_VERSION']);
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
    assert.equal(calls[0].url, 'https://agent.example/commands/dispatch');
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer app-token'); assert.equal(calls[0].redirect, 'manual');
    for (const edgeUrl of ['http://outside.example', 'https://user:pass@agent.example', 'https://agent.example/path']) assert.throws(() => new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, edgeUrl, accessToken: 'token' }), /App Edge URL/);
  } finally { globalThis.fetch = original; }
});

test('a rotated-out integration token authenticates only until its expiry', async () => {
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: 'test.v1', fetch: async req => { calls++; return accepted((await req.json()).message.id); } });
  const body = { ...envelope({ type: 'dispatch', message: 'hi' }), workspace: { id: workspaceId } };
  const as = token => request(body, { Authorization: `Bearer ${token}` });
  const future = new Date(Date.now() + 60_000).toISOString(), past = new Date(Date.now() - 1).toISOString();
  const rotated = { ...bindings, CANTELOP_INTEGRATION_TOKEN: 'new-token', CANTELOP_INTEGRATION_TOKEN_PREVIOUS: 'test-app-token', CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT: future };
  assert.equal((await worker.fetch(as('new-token'), rotated)).status, 202);
  assert.equal((await worker.fetch(as('test-app-token'), rotated)).status, 202);
  assert.equal(calls, 2);
  for (const expiresAt of [past, undefined, 'tomorrow', future.replace('Z', '+00:00')])
    assert.equal((await worker.fetch(as('test-app-token'), { ...rotated, CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT: expiresAt })).status, 401);
  assert.equal((await worker.fetch(as('test-app-token'), { ...rotated, CANTELOP_INTEGRATION_TOKEN_PREVIOUS: '' })).status, 401);
  assert.equal((await worker.fetch(as('wrong'), rotated)).status, 401);
  assert.equal((await worker.fetch(as('test-app-token'), { CANTELOP_INTEGRATION_TOKEN_PREVIOUS: 'test-app-token', CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT: future })).status, 503);
  assert.equal(calls, 2);
});

test('previous-token expiry rejects impossible calendar dates', async t => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-13T00:00:00.000Z'));
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: 'test.v1', fetch: async req => { calls++; return accepted((await req.json()).message.id); } });
  const body = { ...envelope({ type: 'dispatch', message: 'hi' }), workspace: { id: workspaceId } };
  const rotated = { ...bindings, CANTELOP_INTEGRATION_TOKEN: 'new-token', CANTELOP_INTEGRATION_TOKEN_PREVIOUS: 'test-app-token' };
  for (const expiresAt of ['2027-02-29T00:00:00.000Z', '2028-02-30T00:00:00.000Z', '2027-04-31T00:00:00Z']) {
    assert.equal((await worker.fetch(request(body), { ...rotated, CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT: expiresAt })).status, 401, expiresAt);
  }
  assert.equal(calls, 0);
  for (const expiresAt of ['2028-02-29T00:00:00.000Z', '2028-02-29T00:00:00Z']) {
    assert.equal((await worker.fetch(request(body), { ...rotated, CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT: expiresAt })).status, 202, expiresAt);
  }
  assert.equal(calls, 2);
});



test('auth actors reuse the canonical Workspace across selectors and remain distinct across Workspaces', async () => {
  const otherId = 'wsp_' + '9'.repeat(32), sessions = [];
  const worker = createProtocolWorker({ runtimeId: 'test.v1', auth: true, fetch: async req => {
    const body = await req.json();
    if (req.url.endsWith('/workspaces/open')) return Response.json({ id: body.slug === 'customer' ? workspaceId : otherId, slug: body.slug });
    sessions.push(body.session);
    return Response.json({ id: body.message.id, reply: { type: 'status', authenticated: true } });
  } });
  const body = { ...envelope({ type: 'auth', auth: { type: 'status' }, timeoutMs: 45_000, keepAliveSeconds: 0 }), session: { id: 'cantelop-native-auth' } };
  for (const workspace of [{ slug: 'customer' }, { id: workspaceId }, { slug: 'other' }, { id: otherId }, { slug: 'customer' }]) {
    assert.equal((await worker.fetch(request({ ...body, workspace }), bindings)).status, 200);
  }
  assert.deepEqual(sessions.map(session => session.id), [workspaceId, workspaceId, otherId, otherId, workspaceId].map(id => `cantelop-native-auth-${id}`));
  assert.deepEqual(sessions.map(session => session.workspace_id), [workspaceId, workspaceId, otherId, otherId, workspaceId]);
});


test('Fleet runtime capabilities are request-local and required for Fleet execution', async () => {
  const worker = createProtocolWorker({ runtimeId: 'test.v1', fetch() { throw new Error('unscoped runtime access'); } });
  const fleetBindings = { ...bindings, CANTELOP_FLEET_EXECUTION_VERSION: '1' };
  const body = { ...envelope({ type: 'workspace.resolve' }), session: null };
  const missing = await worker.fetch(request(body), fleetBindings);
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: { code: 'fleet_runtime_unavailable' } });
  const results = await Promise.all(Array.from({ length: 24 }, async (_, scope) => {
    const response = await worker.fetch(request(body), fleetBindings, { props: { CANTELOP_RUNTIME: {
      async fetch(target) {
        assert.equal(new URL(target.url).pathname, '/__cantelop/v1/workspaces/open');
        await new Promise(resolve => setTimeout(resolve, scope % 4));
        return Response.json({ id: workspaceId, slug: 'customer', scope });
      },
    } } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scope, scope);
    return scope;
  }));
  assert.equal(results.length, 24);
});

test('Fleet markers fail closed only after authentication and routing, and never reach the default fetch', async () => {
  let ambient = 0, scoped = 0;
  const worker = createProtocolWorker({ runtimeId: 'test.v1', fetch: async () => { ambient++; return Response.json({}); } });
  const body = { ...envelope({ type: 'workspace.resolve' }), session: null };
  const capability = { async fetch() { scoped++; return Response.json({ id: workspaceId, slug: 'customer' }); } };
  const withVersion = version => version === undefined ? bindings : { ...bindings, CANTELOP_FLEET_EXECUTION_VERSION: version };
  for (const [version, runtime] of [['1', undefined], [1, undefined], ['2', capability], [undefined, {}], [undefined, null], ['1', { fetch: 'not a function' }]]) {
    const response = await worker.fetch(request(body), withVersion(version), runtime === undefined ? undefined : { props: { CANTELOP_RUNTIME: runtime } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'fleet_runtime_unavailable' } });
  }
  assert.equal((await worker.fetch(request(body, { Authorization: 'Bearer wrong' }), withVersion('1'))).status, 401);
  assert.equal((await worker.fetch(new Request('https://agent.example/unknown', { method: 'POST', headers: { Authorization: 'Bearer test-app-token' } }), withVersion('1'))).status, 404);
  assert.equal(scoped, 0);
  for (const version of [undefined, '1', 1]) assert.equal((await worker.fetch(request(body), withVersion(version), { props: { CANTELOP_RUNTIME: capability } })).status, 200);
  assert.equal(scoped, 3);
  assert.equal(ambient, 0);
});

test('sync, auth terminals and webhook Apps use the request capability, which ends with the invocation', async () => {
  let cached;
  const worker = createProtocolWorker({ runtimeId: 'test.v1', appName: 'support', auth: true, fetch() { throw new Error('unscoped runtime access'); },
    webhooks: { '/webhooks/provider': { method: 'POST', async handle({ app }) {
      cached = app;
      await app.workspace({ slug: 'customer' }).session({ id: 'chat' }).dispatch('hello', { id: messageId });
      return new Response('ok');
    } } } });
  const fleet = { ...bindings, CANTELOP_FLEET_EXECUTION_VERSION: '1' };
  const scoped = () => {
    const calls = [];
    return { calls, context: { props: { CANTELOP_RUNTIME: { async fetch(target) {
      calls.push(new URL(target.url).pathname);
      if (target.url.includes('/workspaces/open')) return Response.json({ id: workspaceId, slug: 'customer' });
      return target.url.endsWith('/messages') ? accepted(messageId) : new Response(null, { status: 204 });
    } } } } };
  };
  const syncRequest = () => new Request(`https://agent.example/__cantelop/sync/workspaces/${workspaceId}?op=scan`, { headers: { Authorization: 'Bearer test-app-token' } });
  const sync = scoped();
  assert.equal((await worker.fetch(syncRequest(), fleet, sync.context)).status, 204);
  assert.deepEqual(sync.calls, [`/__cantelop/integration/v2/workspaces/${workspaceId}/sync`]);
  assert.equal((await worker.fetch(syncRequest(), fleet)).status, 503);

  const terminalId = 'trm_' + '5'.repeat(32);
  const upgrade = () => new Request(`https://agent.example/__cantelop/auth/workspaces/${workspaceId}/terminals/${terminalId}`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } });
  const terminal = scoped();
  assert.equal((await worker.fetch(upgrade(), fleet, terminal.context)).status, 204);
  assert.deepEqual(terminal.calls, [`/__cantelop/integration/v2/sessions/cantelop-native-auth-${workspaceId}/auth/terminals/${terminalId}`]);
  const unscoped = await worker.fetch(upgrade(), fleet);
  assert.equal(unscoped.status, 503);
  assert.deepEqual(await unscoped.json(), { error: { code: 'fleet_runtime_unavailable' } });

  const hook = scoped();
  const delivered = await worker.fetch(new Request('https://app.example/webhooks/provider', { method: 'POST', body: '{}' }), fleet, hook.context);
  assert.equal(await delivered.text(), 'ok');
  assert.deepEqual(hook.calls, ['/__cantelop/v1/workspaces/open', '/__cantelop/integration/v2/messages']);
  // An App retained by author code cannot keep using the finished invocation's capability.
  await assert.rejects(cached.workspace({ slug: 'customer' }).session({ id: 'chat' }).dispatch('later', { id: messageId }));
  assert.equal(hook.calls.length, 2);
  assert.equal((await worker.fetch(new Request('https://app.example/webhooks/provider', { method: 'POST', body: '{}' }), fleet)).status, 500);
});
