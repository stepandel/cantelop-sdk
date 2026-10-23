import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CantelopClient, FleetError, FleetConfigurationError } from '../dist/index.js';
import { APP_CONFIGURATION_CONTEXT_KEY, parseAppConfiguration } from '../dist/app-config.js';
import { resolveFleetConfiguration } from '../dist/fleet-config.js';
import { buildAppArtifacts } from '../dist/build.js';
const id = prefix => `${prefix}_${'1'.repeat(32)}`;
const binding = { name: 'juiced', id: id('flt'), controlUrl: 'https://console.example', accessToken: `${id('fsp')}.${'2'.repeat(64)}`, packageId: id('pkg'), runtimeId: 'rt_compiled' };
const document = fleets => ({ schemaVersion: 1, activeProfile: 'default', profiles: { default: { apps: [], fleets } } });
const row = { id: id('ins'), external_key: 'customer-account-123', app_id: id('app'), package_id: id('pkg'), next_package_id: null, version: '1.0.0', runtime_id: 'rt_compiled', status: 'ready', policy_revision: 1, enforced_revision: 0, error_code: null };
const policy = { active: true, expiresAt: '2030-01-01T00:00:00Z', maxSandboxes: 2, maxVcpus: 8, maxMemoryMib: 9216, maxWorkspaces: 8, maxStorageBytes: 10 * 1024 ** 3 };
function fixture(t, handler, fleets = [binding]) {
  const key = Symbol.for(APP_CONFIGURATION_CONTEXT_KEY), previous = Reflect.get(globalThis, key), originalFetch = globalThis.fetch;
  Reflect.set(globalThis, key, document(fleets));
  const calls = []; globalThis.fetch = async request => { calls.push(request); return handler(request); };
  t.after(() => { globalThis.fetch = originalFetch; if (previous === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, previous); });
  const fleet = new CantelopClient().fleet({ name: 'juiced', runtime: { receive() {}, [Symbol.for('dev.cantelop.sdk.compiled-runtime.v1')]: 'rt_compiled' } });
  return { fleet, calls, instance: fleet.instance({ externalKey: row.external_key }) };
}
test('Fleet references are local; ambiguous creation can be recovered and deletion works without a known ID', async t => {
  let created = false;
  const { instance, calls } = fixture(t, async request => {
    const url = new URL(request.url);
    assert.equal(request.headers.get('Authorization'), `Bearer ${binding.accessToken}`);
    assert.equal(request.redirect, 'error');
    if (request.method === 'PUT') { assert.deepEqual(await request.json(), { packageId: binding.packageId }); created = true; throw new TypeError('connection lost'); }
    if (request.method === 'DELETE') { assert.equal(url.searchParams.get('externalKey'), row.external_key); return Response.json({ deleted: true }, { status: 202 }); }
    return created ? Response.json(row) : Response.json({ error: 'not_found' }, { status: 404 });
  });
  assert.equal(calls.length, 0);
  assert.equal(await instance.status(), undefined);
  await assert.rejects(instance.create(), /connection lost/);
  assert.equal((await instance.status()).id, row.id);
  assert.deepEqual(await instance.delete(), { state: 'deleting' });
});
test('creation is explicit, validates deployment identity, and exposes accepted provisioning state', async t => {
  const { instance, fleet } = fixture(t, async () => Response.json({ ...row, status: 'provisioning' }, { status: 202 }));
  assert.equal((await instance.create()).state, 'provisioning');
  await assert.rejects(fleet.instance({ id: row.id }).create(), TypeError);
  for (const selector of [{}, { id: 'bad' }, { externalKey: 'short' }, { id: row.id, externalKey: row.external_key }]) assert.throws(() => fleet.instance(selector), TypeError);
});
test('missing deployment metadata fails before provisioning', async t => {
  const { packageId, ...readOnly } = binding;
  const { instance, calls } = fixture(t, () => { throw Error('unexpected network'); }, [readOnly]);
  await assert.rejects(instance.create(), error => error instanceof FleetConfigurationError && error.code === 'fleet_deployment_missing');
  assert.equal(calls.length, 0);
});
test('policy projection preserves revision conflicts, fences and enforcement progress', async t => {
  let conflict = false;
  const { instance } = fixture(t, async request => {
    if (request.method === 'GET') return Response.json(row);
    assert.deepEqual(await request.json(), { expectedRevision: 1, sourceFence: '42', policy });
    return conflict ? Response.json({ error: 'policy_revision_conflict' }, { status: 409 }) : Response.json({ revision: 2, enforced_revision: 0 }, { status: 202 });
  });
  assert.deepEqual(await instance.setPolicy({ expectedRevision: 1, sourceFence: '42', policy }), { revision: 2 });
  assert.equal((await instance.status()).enforcedRevision, 0);
  conflict = true;
  await assert.rejects(instance.setPolicy({ expectedRevision: 1, sourceFence: '42', policy }), e => e instanceof FleetError && e.code === 'policy_revision_conflict' && e.status === 409);
  for (const options of [{ expectedRevision: -1, policy }, { expectedRevision: 1, sourceFence: '9223372036854775808', policy }, { expectedRevision: 1, policy: { ...policy, maxSandboxes: -1 } }]) await assert.rejects(instance.setPolicy(options), TypeError);
});
test('instance App and relay connections use App credentials and preserve compiled runtime identity', async t => {
  const { instance, calls } = fixture(t, async request => {
    if (request.url.startsWith('https://console.example')) {
      if (request.url.endsWith('/credentials')) return Response.json({ appId: row.app_id, edgeUrl: 'https://app.example', accessToken: 'app-secret', runtimeId: row.runtime_id });
      return Response.json(row);
    }
    assert.equal(request.headers.get('Authorization'), 'Bearer app-secret');
    assert.equal(request.headers.get('X-Cantelop-Session-Runtime'), row.runtime_id);
    const body = await request.json();
    return Response.json({ protocolVersion: 2, id: body.id });
  });
  const app = await instance.app();
  await app.workspace({ slug: 'default' }).session({ id: 'conversation' }).stop();
  assert.equal(calls.at(-1).url, 'https://app.example/commands/stop');
  const connection = await instance.connection();
  await assert.rejects(connection.fetch(new Request('https://edge.example/commands/stop', { headers: { 'X-Cantelop-Session-Runtime': 'rt_other' } })), e => e.code === 'session_runtime_mismatch');
});
test('mismatched credentials and incompatible runtime fail before App access', async t => {
  let incompatible = false;
  const { instance } = fixture(t, async request => request.url.endsWith('/credentials')
    ? Response.json({ appId: id('foreign'), runtimeId: row.runtime_id, edgeUrl: 'https://app.example', accessToken: 'secret' })
    : Response.json({ ...row, runtime_id: incompatible ? 'rt_other' : row.runtime_id }));
  await assert.rejects(instance.app(), e => e.code === 'invalid_fleet_response');
  incompatible = true;
  await assert.rejects(instance.app(), e => e.code === 'session_runtime_mismatch');
});
test('scope failures, cancellation and oversized responses remain distinguishable', async t => {
  let oversized = false;
  const { instance, calls } = fixture(t, () => oversized ? new Response('x'.repeat(1024 * 1024 + 1)) : Response.json({ error: 'forbidden' }, { status: 403 }));
  await assert.rejects(instance.status(), e => e.code === 'forbidden' && e.status === 403);
  const signal = AbortSignal.abort(); const count = calls.length;
  await assert.rejects(instance.status({ signal }), e => e.name === 'AbortError');
  assert.equal(calls.length, count);
  oversized = true;
  await assert.rejects(instance.status(), e => e.code === 'invalid_fleet_response');
});
test('non-JSON error bodies keep their HTTP status', async t => {
  const { instance } = fixture(t, () => new Response('<html>unavailable</html>', { status: 503 }));
  await assert.rejects(instance.status(), e => e.code === 'fleet_request_failed' && e.status === 503);
});
test('creation returns an existing instance on another package and requires runtime metadata when compiled', async t => {
  const { instance } = fixture(t, async () => Response.json({ ...row, package_id: `pkg_${'5'.repeat(32)}` }));
  assert.equal((await instance.create()).packageId, `pkg_${'5'.repeat(32)}`);
  const { runtimeId, ...withoutRuntime } = binding;
  const { instance: missing, calls } = fixture(t, () => { throw Error('unexpected network'); }, [withoutRuntime]);
  await assert.rejects(missing.create(), e => e instanceof FleetConfigurationError && e.code === 'fleet_deployment_missing');
  assert.equal(calls.length, 0);
});
test('Fleet profile binding is captured, scoped by name/profile, and rejects expired or unsafe configuration', async () => {
  const injected = parseAppConfiguration({ ...document([binding]), profiles: { default: { apps: [], fleets: [binding] }, production: { apps: [], fleets: [{ ...binding, packageId: `pkg_${'3'.repeat(32)}` }] } } });
  const context = { env: {}, injected, loadLocal: async () => ({}) };
  assert.equal((await resolveFleetConfiguration('juiced', context, 'production')).packageId, `pkg_${'3'.repeat(32)}`);
  await assert.rejects(resolveFleetConfiguration('other', context), e => e.code === 'fleet_not_configured');
  const expired = { ...context, injected: parseAppConfiguration(document([{ ...binding, expiresAt: '2000-01-01' }])) };
  await assert.rejects(resolveFleetConfiguration('juiced', expired), e => e.code === 'fleet_credentials_expired');
  for (const change of [{ controlUrl: 'http://public.example' }, { accessToken: 'app-token' }, { packageId: 'bad' }, { runtimeId: 'bad runtime' }]) {
    const unsafe = parseAppConfiguration({ ...document([{ ...binding, ...change }]), profiles: { default: { apps: [{ id: `app_${'4'.repeat(32)}`, slug: 'other-app', accessToken: 'app-token' }], fleets: [{ ...binding, ...change }] } } });
    assert.equal(unsafe.profiles.default.apps[0].slug, 'other-app');
    await assert.rejects(resolveFleetConfiguration('juiced', { env: {}, injected: unsafe, loadLocal: async () => ({}) }), e => e instanceof FleetConfigurationError && e.code === 'fleet_configuration_invalid');
  }
  await assert.rejects(resolveFleetConfiguration('juiced', context, 'staging'), e => e.code === 'fleet_not_configured');
  await assert.rejects(resolveFleetConfiguration('juiced', { env: {}, loadLocal: async () => { throw Error('unreadable'); } }), e => e instanceof FleetConfigurationError && e.code === 'fleet_configuration_invalid');
});
test('compiler builds Fleet artifacts and a typed backend without loading runtime-only dependencies', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cantelop-fleet-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = path.join(directory, 'cantelop.mts');
  const client = new URL('../dist/client.js', import.meta.url).pathname;
  await writeFile(path.join(directory, 'provider.mts'), 'throw new Error("runtime-only-provider-loaded"); export const provider = "fleet-runtime-only";');
  await writeFile(definition, `import { CantelopClient } from ${JSON.stringify(client)};\nimport { provider } from './provider.mjs';\nexport const fleet = new CantelopClient().fleet<string, never, number>({ name: 'juiced', runtime: { receive() { console.log(provider); } } });`);
  const artifacts = await buildAppArtifacts({ definition, outdir: path.join(directory, 'out') });
  const backend = await readFile(path.join(directory, 'out/backend/client.mjs'), 'utf8');
  assert.doesNotMatch(backend, /runtime-only-provider-loaded|fleet-runtime-only/);
  const manifest = JSON.parse(await readFile(path.join(directory, 'out/backend/cantelop-client.json'), 'utf8'));
  assert.equal(manifest.apps[0].definition_kind, 'fleet');
  for (const [dir, filename] of [['edge', 'cantelop-edge.json'], ['runtime', 'cantelop-runtime.json']]) {
    const manifest = JSON.parse(await readFile(path.join(directory, `out/juiced/${dir}/${filename}`), 'utf8'));
    assert.equal(manifest.definition_kind, 'fleet');
    assert.equal(manifest.cli_build_protocol_version, 7);
  }
  const declarations = await readFile(path.join(directory, 'out/backend/client.d.mts'), 'utf8');
  assert.match(declarations, /Fleet<string, never, number/);
});


test('Fleet relay uploads and event responses stay streaming and cancellable', async t => {
  let pulled = 0;
  const { instance } = fixture(t, async request => {
    if (request.url.startsWith('https://console.example')) return request.url.endsWith('/credentials')
      ? Response.json({ appId: row.app_id, edgeUrl: 'https://app.example', accessToken: 'app-secret', runtimeId: row.runtime_id }) : Response.json(row);
    assert.equal(pulled, 0, 'upload must not be consumed before fetch');
    assert.equal(request.headers.get('Authorization'), 'Bearer app-secret');
    const reader = request.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'chunk');
    await reader.cancel();
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const connection = await instance.connection();
  const controller = new AbortController();
  const upload = new ReadableStream({ pull(c) { pulled++; c.enqueue(new TextEncoder().encode('chunk')); } }, { highWaterMark: 0 });
  const response = await connection.fetch(new Request('https://edge.example/files', { method: 'POST', body: upload, duplex: 'half', signal: controller.signal }));
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'event');
  await reader.cancel();
});


test('relay paths cannot replace the credential-bound Edge origin', async t => {
  const { instance, calls } = fixture(t, request => request.url.startsWith('https://console.example')
    ? request.url.endsWith('/credentials')
      ? Response.json({ appId: row.app_id, edgeUrl: 'https://app.example', accessToken: 'app-secret', runtimeId: row.runtime_id }) : Response.json(row)
    : new Response('ok'));
  const connection = await instance.connection();
  await connection.fetch(new Request('https://logical.example//another.example/commands/stop'));
  assert.equal(new URL(calls.at(-1).url).origin, 'https://app.example');
});
