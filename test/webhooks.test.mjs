import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CantelopClient } from '../dist/index.js';
import { createProtocolWorker } from '../dist/protocol-edge.js';
import { buildAppArtifacts, buildEdgeApi } from '../dist/build.js';
import { compileClientDefinition } from '../dist/compiler.js';
const workspaceId = 'wsp_' + '1'.repeat(32), messageId = 'msg_' + '2'.repeat(32);
const bindings = { HOOK_SECRET: 'provider-secret', CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS: '120', CANTELOP_INTEGRATION_TOKEN: 'private-token' };
const receipt = id => Response.json({ id, status: 'accepted', accepted_at: '2026-10-11T00:00:00Z' }, { status: 202 });

test('webhook App uses Workspace ID/slug and every Session method through local commands', async () => {
  const calls = [];
  const worker = createProtocolWorker({ runtimeId: 'test.v1', appName: 'support', environment: { HOOK_SECRET: { secret: true, required: true } },
    fetch: async request => {
      calls.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith('/workspaces/open')) return Response.json({ id: workspaceId, slug: 'customer' });
      if (url.pathname.endsWith('/messages')) return receipt((await request.json()).message.id);
      if(url.pathname.endsWith('/requests')){const input=await request.json();return Response.json({id:input.message.id,reply:input.message.payload.type==='cancel'?{id:input.message.id,messageId,state:'requested'}:'done'})}
      if(url.pathname.includes('/sessions/')&&url.pathname.includes('/messages/'))return Response.json({id:messageId,state:'handling',workspace_id:workspaceId});
      if (url.pathname.endsWith('/view')) return Response.json({ workspaceId, sessionId: 'chat', revision: '1', updatedAt: '2026-10-11T00:00:00Z', state: 'ready', cursor: { streamId: '3'.repeat(32), sequence: 0 } });
      if (url.pathname.endsWith('/events')) return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      throw Error(url.pathname);
    },
    webhooks: { '/webhooks/provider': { method: 'POST', async handle({ request, app, env }) {
      assert.equal(request.headers.get('Authorization'), null);
      assert.equal(env.HOOK_SECRET, 'provider-secret');
      assert.equal(env.CANTELOP_INTEGRATION_TOKEN, undefined);
      assert.equal(Object.isFrozen(env), true);
      assert.equal(app.name, 'support');
      const session = app.workspace({ slug: 'customer' }).session({ id: 'chat' });
      assert.equal((await session.dispatch('normal', { id: messageId })).id, messageId);
      await session.steer('priority', { id: messageId, keepAliveSeconds: 30 });
      assert.equal(await session.request('request', { id: messageId }), 'done');
      const existing = app.workspace({ id: workspaceId }).session({ id: 'chat' });
      assert.equal((await existing.cancel(messageId)).state, 'requested');
      assert.equal((await existing.view()).state, 'ready');
      for await (const event of existing.stream()) assert.fail(JSON.stringify(event));
      await existing.stop();
      return new Response(null, { status: 202 });
    } } },
  });
  assert.equal((await worker.fetch(new Request('https://app.example/webhooks/provider', { method: 'POST' }), bindings)).status, 202);
  // Requests are consumed by the mock; inspect their routing and headers here.
  assert.ok(calls.every(r => new URL(r.url).hostname === 'runtime.cantelop.internal'));
  assert.ok(calls.every(r => !r.headers.has('Authorization')));
  assert.ok(calls.some(r => new URL(r.url).searchParams.get('workspace_id') === workspaceId));
});

test('raw webhook verification, handshake responses, method guards and external authentication stay separate', async () => {
  let handled = 0, forwarded = 0;
  const raw = '{ "unicode": "é", "spacing": true }';
  const worker = createProtocolWorker({ runtimeId: 'test.v1', appName: 'support', fetch: async () => { forwarded++; return receipt(messageId); },
    webhooks: { '/webhooks/verify': { method: 'POST', async handle({ request }) {
      handled++;
      assert.equal(await request.text(), raw);
      return Response.json({ challenge: new URL(request.url).searchParams.get('challenge') });
    } } },
  });
  const response = await worker.fetch(new Request('https://app.example/webhooks/verify?challenge=abc', { method: 'POST', body: raw }), {});
  assert.deepEqual(await response.json(), { challenge: 'abc' });
  const wrong = await worker.fetch(new Request('https://app.example/webhooks/verify'), {});
  assert.equal(wrong.status, 405); assert.equal(wrong.headers.get('Allow'), 'POST'); assert.equal(handled, 1);
  const command = new Request('https://app.example/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Cantelop-Session-Runtime': 'test.v1' }, body: '{}' });
  assert.equal((await worker.fetch(command, bindings)).status, 401);
  assert.equal(forwarded, 0);
});

test('webhook ingress bounds raw bodies and does not acknowledge failed admission', async () => {
  let handled = 0;
  const worker = createProtocolWorker({ runtimeId: 'test.v1', appName: 'support', fetch: async () => { throw Error('private upstream failure'); },
    webhooks: { '/webhooks/x': { method: 'POST', async handle({ app }) {
      handled++;
      await app.workspace({ id: workspaceId }).session().dispatch('hello');
      return new Response(null, { status: 202 });
    } } },
  });
  const oversized = new Request('https://app.example/webhooks/x', { method: 'POST', body: new Uint8Array(1024 * 1024 + 1) });
  assert.equal((await worker.fetch(oversized, bindings)).status, 413); assert.equal(handled, 0);
  const response = await worker.fetch(new Request('https://app.example/webhooks/x', { method: 'POST' }), bindings);
  assert.equal(response.status, 500); assert.equal(handled, 1);
  assert.doesNotMatch(await response.text(), /private upstream failure/);
});

test('handler failures never leak bindings or admit messages', async () => {
  for (const handle of [() => { throw Error(bindings.HOOK_SECRET); }, () => 'invalid']) {
    const worker = createProtocolWorker({ runtimeId: 'test.v1', appName: 'support', webhooks: { '/webhooks/fail': { method: 'POST', handle } } });
    const response = await worker.fetch(new Request('https://app.example/webhooks/fail', { method: 'POST' }), bindings);
    assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: { code: 'webhook_failed' } });
  }
  for (const webhooks of [{ '/commands': { method: 'POST', handle: () => new Response() } }, { '/webhooks/x/../y': { method: 'POST', handle: () => new Response() } }, { '/webhooks/x': { method: 'PUT', handle: () => new Response() } }, { '/webhooks/x': { method: 'POST', handle: 1 } }]) {
    assert.throws(() => new CantelopClient().app({ name: 'support', runtime: { receive() {} }, webhooks }), TypeError);
  }
});

test('env exposes declared ordinary variables and secrets with defaults and validates before handler invocation', async () => {
  let seen, calls = 0;
  const options = {runtimeId:'test.v1',appName:'support',environment:{
    TOKEN:{secret:true,required:true}, LABEL:{default:'default label'}, OPTIONAL:{}, EMPTY:{default:'fallback'},
  },webhooks:{'/webhooks/env':{method:'POST',handle(context) {
    calls++; seen=context;
    return Response.json({token:context.env.TOKEN,label:context.env.LABEL,empty:context.env.EMPTY});
  }}}};
  const worker = createProtocolWorker(options);
  options.environment.LABEL.default = 'mutated declaration';
  const incoming = {TOKEN:'configured token',EMPTY:'',CANTELOP_INTEGRATION_TOKEN:'private token',UNDECLARED:'hidden'};
  const response = await worker.fetch(new Request('https://app.example/webhooks/env',{method:'POST'}),incoming);
  assert.deepEqual(await response.json(),{token:'configured token',label:'default label',empty:''});
  incoming.TOKEN = 'changed later';
  assert.equal(seen.env.TOKEN,'configured token'); assert.equal(seen.secret,undefined);
  assert.equal(seen.env.UNDECLARED,undefined); assert.equal(seen.env.CANTELOP_INTEGRATION_TOKEN,undefined);
  assert.equal(seen.env.OPTIONAL,undefined); assert.equal(Object.isFrozen(seen.env),true);
  for (const [bindings,code] of [[{},'app_environment_missing'],[{TOKEN:''},'app_environment_missing'],[{TOKEN:123},'app_environment_invalid']]) {
    const failure = await worker.fetch(new Request('https://app.example/webhooks/env',{method:'POST'}),bindings);
    assert.equal(failure.status,503); assert.deepEqual(await failure.json(),{error:{code}});
  }
  assert.equal(calls,1);
  assert.equal((await worker.fetch(new Request('https://app.example/webhooks/env',{method:'POST'}),{TOKEN:'other token',LABEL:'override'})).status,200);
  assert.equal(seen.env.TOKEN,'other token'); assert.equal(seen.env.LABEL,'override');
  await worker.fetch(new Request('https://app.example/webhooks/env',{method:'POST'}),{TOKEN:'configured',LABEL:undefined});
  assert.equal(seen.env.LABEL,'default label');
});

test('compiler isolates webhook and runtime graphs; webhook edits preserve Session identity', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-webhooks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = path.join(directory, 'cantelop.mts');
  const clientModule = new URL('../dist/client.js', import.meta.url).pathname;
  await writeFile(path.join(directory, 'agent.ts'), 'export function receive() { console.log("sandbox-only-marker"); }');
  const hook = marker => `export async function handle({ request, app, env }: any) {
    if (request.headers.get("provider-token") !== env.HOOK_SECRET) return new Response(null, {status:401});
    const result = await app.workspace({ id: ${JSON.stringify(workspaceId)} }).session({ id: "chat" }).dispatch({ text: ${JSON.stringify(marker)} }, { id: ${JSON.stringify(messageId)} });
    return Response.json({ id: result.id }, { status: 202 });
  }`;
  await writeFile(path.join(directory, 'hook.ts'), hook('edge-only-marker'));
  await writeFile(definition, `import { CantelopClient } from ${JSON.stringify(clientModule)};
import { receive } from "./agent.js"; import { handle } from "./hook.js";
export const support = new CantelopClient().app<{text:string}>({ name:"support", runtime:{receive}, environment:{HOOK_SECRET:{secret:true,required:true}}, webhooks:{"/webhooks/provider":{method:"POST",handle}} });
export const other = new CantelopClient().app({name:"other", runtime:{receive}, webhooks:{"/webhooks/provider":{method:"POST",handle({app}) {return new Response("second-route-only:"+app.name);}}}});`);
  const artifacts = await buildAppArtifacts({ definition, outdir: path.join(directory, 'out') });
  const edge = artifacts.apps[0].edge, native = artifacts.apps[0].runtime;
  assert.deepEqual(edge.manifest.webhooks, [{ path: '/webhooks/provider', method: 'POST' }]);
  const edgeSource = await readFile(edge.mainModule, 'utf8');
  assert.doesNotMatch(edgeSource, /second-route-only/);
  const other = (await import(pathToFileURL(artifacts.apps[1].edge.mainModule))).default;
  assert.equal(await (await other.fetch(new Request('https://other.example/webhooks/provider', {method:'POST'}))).text(), 'second-route-only:other');
  assert.match(edgeSource, /edge-only-marker/); assert.doesNotMatch(edgeSource, /sandbox-only-marker/);
  assert.doesNotMatch(await readFile(native.mainModule, 'utf8'), /edge-only-marker/);
  assert.doesNotMatch(await readFile(artifacts.backend.mainModule, 'utf8'), /edge-only-marker|sandbox-only-marker/);
  const previous = await compileClientDefinition(definition, "support");
  await writeFile(path.join(directory, 'hook.ts'), hook('changed-edge-marker'));
  assert.equal((await compileClientDefinition(definition, "support")).definition.id, previous.definition.id);
  let calls = 0;
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async request => { calls++; assert.equal(new URL(request.url).hostname, 'runtime.cantelop.internal'); const body = await request.json(); assert.deepEqual(body.message.payload, {__cantelop_command:2,type:"dispatch",message:{ text: 'edge-only-marker' }}); return receipt(body.message.id); };
  const worker = (await import(pathToFileURL(edge.mainModule))).default;
  const invoke = token => worker.fetch(new Request('https://support.example/webhooks/provider', { method: 'POST', headers: { 'provider-token': token } }), { HOOK_SECRET: 'provider-secret', CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS: 120 });
  assert.equal((await invoke('bad')).status, 401); assert.equal(calls, 0);
  assert.equal((await invoke('provider-secret')).status, 202); assert.equal(calls, 1);
});

test('compiler enforces typed webhook Apps and rejects dynamic routes or enclosing App capture', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-webhook-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = path.join(directory, 'cantelop.mts');
  const clientModule = new URL('../dist/client.js', import.meta.url).pathname;
  const source = route => `import { CantelopClient } from ${JSON.stringify(clientModule)};
export const support = new CantelopClient().app<{text:string}, never, string, {ready:boolean}>({ name:"support", runtime:{receive(){}}, webhooks:${route} });`;
  await writeFile(definition, source('{"/webhooks/x":{method:"POST",async handle({app}) { const s=app.workspace({slug:"customer"}).session({id:"chat"}); await s.dispatch({text:"ok"}); const reply:string=await s.request({text:"ok"}); const state:boolean=(await s.view()).state.ready; return new Response(reply); }}}'));
  await compileClientDefinition(definition);
  await writeFile(definition, source('{"/webhooks/x":{method:"POST",async handle({app}) { await app.workspace({slug:"customer"}).session().dispatch(42); return new Response(); }}}'));
  await assert.rejects(compileClientDefinition(definition), /Invalid Session runtime/);
  await writeFile(definition, source('{"/webhooks/x":{method:"POST",handle() { support.workspace({slug:"customer"}); return new Response(); }}}'));
  await assert.rejects(compileClientDefinition(definition), /cannot capture/);
  await writeFile(definition, source('{"/commands":{method:"POST",handle(){return new Response();}}}'));
  await assert.rejects(compileClientDefinition(definition), /Invalid App webhook route/);
  await writeFile(path.join(directory, 'hook.ts'), 'import { support } from "./cantelop.mjs"; export function handle() { support.workspace({slug:"customer"}); return new Response(); }');
  await writeFile(definition, source('{"/webhooks/x":{method:"POST",handle}}').replace('export const support', 'import { handle } from "./hook.js"; export const support'));
  await assert.rejects(compileClientDefinition(definition), /cannot import their enclosing App definition/);
});


test('GitHub example verifies signatures before dispatch and maps retries to stable identities', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-github-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const edge = await buildEdgeApi({ definition: new URL('../examples/github/src/cantelop.ts', import.meta.url).pathname, outdir: directory });
  const worker = (await import(pathToFileURL(edge.mainModule))).default;
  const calls = [], submissions = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async request => {
    calls.push(request);
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith('/workspaces/open')) { assert.equal(body.slug, 'repo-123'); return Response.json({ id: workspaceId, slug: body.slug }); }
    submissions.push(body); return receipt(body.message.id);
  };
  const delivery = '12345678-1234-1234-1234-123456789abc';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('github-secret'), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const invoke = async (body, signature, event = 'issues') => {
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const hash = [...signed].map(b => b.toString(16).padStart(2,'0')).join('');
    return worker.fetch(new Request('https://app.example/webhooks/github', {method:'POST',body,headers:{'X-Hub-Signature-256':signature ?? `sha256=${hash}`,'X-GitHub-Event':event,'X-GitHub-Delivery':delivery}}), {GITHUB_WEBHOOK_SECRET:'github-secret',GITHUB_TOKEN:'github-token',OPENAI_API_KEY:'openai-key',CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS:120});
  };
  const body = JSON.stringify({action:'opened',repository:{id:123,full_name:'owner/repo'},issue:{number:7,title:'Help',body:'An issue'}});
  assert.equal((await invoke(body, 'sha256='+'0'.repeat(64))).status, 401); assert.equal(calls.length, 0);
  assert.equal((await invoke('{}', undefined, 'ping')).status, 204); assert.equal(calls.length, 0);
  assert.equal((await invoke('invalid JSON')).status, 400); assert.equal(calls.length, 0);
  for (let i=0;i<2;i++) assert.equal((await invoke(body)).status,202);
  assert.equal(submissions.length,2);
  assert.equal(submissions[0].message.id,submissions[1].message.id);
  assert.equal(submissions[0].session.id,'issue-7');
  assert.deepEqual(submissions[0].message.payload.message,{repository:'owner/repo',issueNumber:7,title:'Help',body:'An issue'});
});
