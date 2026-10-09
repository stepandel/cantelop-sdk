import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { CantelopClient, AppConfigurationError } from '../dist/index.js';
import { resolveAppConfiguration, parseAppConfiguration, APP_CONFIGURATION_CONTEXT_KEY } from '../dist/app-config.js';
const run = promisify(execFile);
const first = { id: 'app_' + '1'.repeat(32), slug: 'first-agent', accessToken: 'first-integration-token' };
const second = { id: 'app_' + '2'.repeat(32), slug: 'second-agent', accessToken: 'second-integration-token' };
const document = (apps = [first, second], defaultApp = { id: first.id }) => ({ schemaVersion: 1, activeProfile: 'default', profiles: { default: { defaultApp, apps } } });
const context = (env = {}, extra = {}) => ({ env, loadLocal: async () => ({}), ...extra });
const expectCode = code => error => error instanceof AppConfigurationError && error.code === code && !error.message.includes('integration-token');

test('CLI-injected App config permits no-argument construction, lazy references and captured identity', async () => {
  const key = Symbol.for(APP_CONFIGURATION_CONTEXT_KEY);
  const previous = Reflect.get(globalThis, key), fetch = globalThis.fetch;
  const injected = document();
  Reflect.set(globalThis, key, injected);
  const calls = [];
  globalThis.fetch = async request => {
    calls.push(request);
    const body = await request.json();
    return Response.json({ protocolVersion: 2, id: body.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' });
  };
  try {
    const app = new CantelopClient({ sessionRuntime: { id: "test.v1", entrypoint: "./session.ts" } });
    const ref = app.workspace({ slug: 'customer' });
    const session = ref.session();
    assert.equal(calls.length, 0);
    injected.profiles.default.defaultApp = { id: second.id };
    await session.dispatch('hello');
    assert.equal(calls[0].url, 'https://first-agent.cantelop.dev/commands');
    assert.equal(calls[0].headers.get('Authorization'), 'Bearer first-integration-token');
    await new CantelopClient({ sessionRuntime: { id: "test.v1", entrypoint: "./session.ts" }, slug: second.slug }).workspace({ slug: 'customer' }).session().dispatch('hello');
    assert.equal(calls[1].url, 'https://second-agent.cantelop.dev/commands');
    assert.equal(calls[1].headers.get('Authorization'), 'Bearer second-integration-token');
  } finally { globalThis.fetch = fetch; if (previous === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, previous); }
});

test('environment credentials are scoped to an App and avoid local discovery when complete', async () => {
  let loads = 0;
  const env = { CANTELOP_APP_ID: first.id, CANTELOP_APP_SLUG: first.slug, CANTELOP_INTEGRATION_TOKEN: first.accessToken };
  const configured = await resolveAppConfiguration({}, context(env, { loadLocal: async () => { loads++; return {}; } }));
  assert.deepEqual(configured, { edgeUrl: 'https://first-agent.cantelop.dev', accessToken: first.accessToken });
  assert.equal(loads, 0);
  assert.deepEqual(await resolveAppConfiguration({ id: first.id }, context(env)), configured);
  await assert.rejects(resolveAppConfiguration({ id: second.id }, context(env)), expectCode('app_not_configured'));
  await assert.rejects(resolveAppConfiguration({}, context({ CANTELOP_INTEGRATION_TOKEN: first.accessToken })), expectCode('app_configuration_invalid'));
});

test('project identity overrides profile default; explicit App selection does not borrow default credentials', async () => {
  const local = { document: parseAppConfiguration(document()), projectApp: { slug: second.slug } };
  const source = context({}, { loadLocal: async () => local });
  assert.equal((await resolveAppConfiguration({}, source)).accessToken, second.accessToken);
  assert.equal((await resolveAppConfiguration({ id: first.id }, source)).accessToken, first.accessToken);
  await assert.rejects(resolveAppConfiguration({ slug: 'unknown' }, source), expectCode('app_not_configured'));
});

test('profile selection and runtime/environment precedence retain App-specific credentials', async () => {
  const profiles = document();
  profiles.profiles.production = { defaultApp: { id: second.id }, apps: [{ ...second, accessToken: 'production-token' }] };
  const encoded = JSON.stringify(profiles);
  assert.equal((await resolveAppConfiguration({}, context({ CANTELOP_APP_CONFIG: encoded, CANTELOP_PROFILE: 'production' }))).accessToken, 'production-token');
  assert.equal((await resolveAppConfiguration({ profile: 'default' }, context({ CANTELOP_APP_CONFIG: encoded, CANTELOP_PROFILE: 'production' }))).accessToken, first.accessToken);
  const injection = parseAppConfiguration(document([{ ...first, accessToken: 'injected-token' }]));
  assert.equal((await resolveAppConfiguration({}, context({ CANTELOP_APP_CONFIG: encoded }, { injected: injection }))).accessToken, 'injected-token');
  await assert.rejects(resolveAppConfiguration({ profile: 'missing' }, context({ CANTELOP_APP_CONFIG: encoded })), expectCode('app_not_configured'));
});

test('invalid, ambiguous and expired configuration fails without credential values in errors', async () => {
  for (const value of [
    { ...document(), schemaVersion: 2 }, document([first, first]),
    document([{ ...first, expiresAt: 'bad' }]), document([{ ...first, accessToken: 'bad\nsecret' }]),
  ]) assert.throws(() => parseAppConfiguration(value), expectCode('app_configuration_invalid'));
  await assert.rejects(resolveAppConfiguration({}, context({ CANTELOP_APP_CONFIG: '{"secret":"first-integration-token"}' })), expectCode('app_configuration_invalid'));
  await assert.rejects(resolveAppConfiguration({}, context({}, { injected: parseAppConfiguration(document([{ ...first, expiresAt: '2000-01-01T00:00:00Z' }])) })), expectCode('app_credentials_expired'));
  await assert.rejects(resolveAppConfiguration({}, context()), expectCode('app_configuration_missing'));
  for (const options of [{ id: first.id, slug: first.slug }, { id: 'bad' }, { slug: 'UPPER' }, { profile: '' }, { connection: { fetch }, slug: first.slug }, { edgeUrl: 'https://example.test' }]) assert.throws(() => new CantelopClient({ ...options, sessionRuntime: { id: "test.v1", entrypoint: "./session.ts" } }), TypeError);
});

test('actual backend discovery uses a private integration file and nearest project independently of CLI login', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cantelop-config-'));
  const sdk = new URL('../dist/index.js', import.meta.url).href;
  const profile = path.join(root, 'integration.json');
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(profile, JSON.stringify(document()), { mode: 0o600 });
    await writeFile(path.join(root, 'cantelop.json'), JSON.stringify({ schema_version: 3, app: second.slug, session: 'src/session.ts' }));
    await writeFile(path.join(root, 'login.json'), JSON.stringify({ refresh_token: 'deployment-only-secret' }), { mode: 0o600 });
    const source = `
      import assert from 'node:assert/strict';
      import { CantelopClient } from ${JSON.stringify(sdk)};
      let calls = 0;
      globalThis.fetch = async request => {
        calls++;
        assert.equal(request.url, 'https://second-agent.cantelop.dev/commands');
        assert.equal(request.headers.get('Authorization'), 'Bearer second-integration-token');
        const body = await request.json();
        return Response.json({ protocolVersion: 2, id: body.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' });
      };
      const app = new CantelopClient({ sessionRuntime: { id: "test.v1", entrypoint: "./session.ts" } });
      const ref = app.workspace({ slug: 'customer' }).session();
      assert.equal(calls, 0);
      await Promise.all([ref.dispatch('one'), ref.dispatch('two')]);
      assert.equal(calls, 2);
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CANTELOP_')));
    await run(process.execPath, ['--input-type=module', '-e', source], { cwd: path.join(root, 'nested'), env: { ...env, CANTELOP_CONFIG: path.join(root, 'login.json') } });
    if (process.platform !== 'win32') {
      await chmod(profile, 0o644);
      await run(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict'; import { CantelopClient } from ${JSON.stringify(sdk)};
        await assert.rejects(new CantelopClient({ sessionRuntime: { id: "test.v1", entrypoint: "./session.ts" }, id: ${JSON.stringify(first.id)} }).workspace({ slug: 'customer' }).session().dispatch('hi'), error => error.code === 'app_configuration_invalid');
      `], { cwd: root, env: { ...env, CANTELOP_INTEGRATION_CONFIG: profile } });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('profile defaults support code outside a Cantelop project and explicit selection ignores unrelated manifests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cantelop-config-'));
  const sdk = new URL('../dist/index.js', import.meta.url).href;
  const profile = path.join(root, 'integration.json');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CANTELOP_')));
  try {
    await writeFile(profile, JSON.stringify(document()), { mode: 0o600 });
    const source = `import assert from 'node:assert/strict'; import { CantelopClient } from ${JSON.stringify(sdk)};
      globalThis.fetch = async request => {
        assert.equal(request.url, 'https://first-agent.cantelop.dev/commands');
        const body = await request.json(); return Response.json({ protocolVersion: 2, id: body.id, status: 'accepted', accepted_at: '2026-10-09T00:00:00Z' });
      };
      await new CantelopClient({ ...OPTIONS, sessionRuntime: { id: "test.v1", entrypoint: "./session.ts" } }).workspace({ slug: 'customer' }).session().dispatch('hi');`;
    await run(process.execPath, ['--input-type=module', '-e', source.replace('OPTIONS', '{}')], { cwd: root, env: { ...env, CANTELOP_INTEGRATION_CONFIG: profile } });
    await writeFile(path.join(root, 'cantelop.json'), 'invalid unrelated project');
    await run(process.execPath, ['--input-type=module', '-e', source.replace('OPTIONS', JSON.stringify({ id: first.id }))], { cwd: root, env: { ...env, CANTELOP_INTEGRATION_CONFIG: profile } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
