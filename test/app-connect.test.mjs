import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CantelopClient } from '../dist/index.js';
import { APP_COMMAND_TYPES, appCommandType, validateCommand, validSyncRequest } from '../dist/protocol.js';

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
});
