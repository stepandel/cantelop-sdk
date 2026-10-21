import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CantelopClient } from '../dist/index.js';
import { readFile } from 'node:fs/promises';
import { APP_COMMAND_TYPES, appCommandType, validateCommand, validateCommandRequest, validSyncRequest } from '../dist/protocol.js';

test('compiled transport rebinding preserves runtime identity and isolates references', async () => {
  const id = 'rt_' + 'a'.repeat(64);
  const runtime = { receive() {}, [Symbol.for('dev.cantelop.sdk.compiled-runtime.v1')]: id };
  const seen = [];
  const connection = label => ({ async fetch(request) {
    seen.push([label, request.headers.get('X-Cantelop-Session-Runtime'), await request.json()]);
    return Response.json({ protocolVersion: 2 });
  } });
  const original = new CantelopClient().app({ name: 'logical', runtime, connection: connection('original') });
  const before = original.runtime.receive;
  runtime.receive = () => 'mutated';
  const a = original.connect(connection('A'));
  assert.equal(a.runtime.receive,before);
  assert.equal(original.runtime.receive,before);
  const b = original.connect(connection('B'));
  assert.equal(a.runtimeId, id);
  assert.equal(b.name, original.name);
  await Promise.all([original.workspace({ slug: 'project' }).session({ id: 's0' }).stop(),
    a.workspace({ slug: 'project' }).session({ id: 's1' }).stop(),
    b.workspace({ slug: 'project' }).session({ id: 's2' }).stop()]);
  assert.deepEqual(seen.map(x => x.slice(0, 2)).sort(), [['A', id], ['B', id], ['original', id]]);
  assert.throws(() => original.connect({}), /connection/);
  assert.throws(() => original.connect(undefined), /connection/);
});

test('rebinding carries the validated runtime and its identity to every Edge request', async () => {
  const id = 'rt_' + 'b'.repeat(64);
  class Runtime { receive() {} }
  const runtime = new Runtime();
  Object.defineProperty(runtime, Symbol.for('dev.cantelop.sdk.compiled-runtime.v1'), { value: id, enumerable: false });
  const headers = [];
  const original = new CantelopClient().app({ name: 'logical', runtime, connection: { async fetch() { throw new Error('unused'); } } });
  const scoped = original.connect({ async fetch(request) {
    headers.push(request.headers.get('X-Cantelop-Session-Runtime'));
    const body = await request.json();
    return Response.json({ protocolVersion: 2, id: body.id, revision: 0, status: 'applied' });
  } });
  assert.equal(scoped.runtimeId, id);
  assert.equal(scoped.runtime, original.runtime);
  assert.deepEqual(await scoped.environment().status(0), { revision: 0, status: 'applied' });
  assert.deepEqual(headers, [id]);
});

test('relay contract validates environment envelopes, paths and bounded sync queries', () => {
  const command = { protocolVersion: 2, id: 'msg_' + 'a'.repeat(32), workspace: null, session: null,
    command: { type: 'app.environment.set', name: 'GH_TOKEN', value: 'secret', secret: true } };
  assert.equal(validateCommand(command).command.type, command.command.type);
  assert.ok(APP_COMMAND_TYPES.includes(command.command.type));
  assert.equal(appCommandType('/commands/' + command.command.type), command.command.type);
  assert.equal(appCommandType('/commands/../dispatch'), undefined);
  assert.throws(() => validateCommand({ ...command, command: { ...command.command, app_id: 'other' } }));
  assert.equal(validSyncRequest('PUT', new URLSearchParams({ op: 'write', path: '../secret', base: 'missing' })), false);
  const body = new TextEncoder().encode(JSON.stringify(command));
  const url = path => new URL(path, 'https://relay.example');
  assert.equal(validateCommandRequest('POST', url('/commands/app.environment.set'), body).command.type, 'app.environment.set');
  assert.throws(() => validateCommandRequest('POST', url('/commands/workspace.inspect'), body), /path/);
  assert.throws(() => validateCommandRequest('GET', url('/commands/app.environment.set'), body), /route/);
  assert.throws(() => validateCommandRequest('POST', url('/commands/app.environment.set?x=1'), body), /route/);
  assert.throws(() => validateCommandRequest('POST', url('/commands/app.environment.set'), new Uint8Array(1024 * 1024 + 1)), /1 MiB/);
});

test('protocol entry loads no transport or database modules', async () => {
  const seen = new Set();
  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const [, specifier] of source.matchAll(/^(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)) {
      assert.ok(specifier.startsWith('./'), `${file} imports ${specifier}`);
      await visit(new URL(specifier, new URL(file, import.meta.url)).href);
    }
  }
  await visit('../dist/protocol.js');
  assert.ok(![...seen].some(file => /\/(database|remote-app|environment)\.js$/.test(file)), [...seen].join(', '));
});
