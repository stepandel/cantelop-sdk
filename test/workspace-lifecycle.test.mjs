import assert from 'node:assert/strict';
import test from 'node:test';
import { CantelopClient } from '../dist/index.js';
import { createProtocolWorker } from '../dist/protocol-edge.js';

const id = `wsp_${'a'.repeat(32)}`, replacement = `wsp_${'c'.repeat(32)}`;
const data = (workspaceId = id) => ({ id: workspaceId, app_id: `app_${'b'.repeat(32)}`, slug: 'project', hostname: 'project.agent.cantelop.dev', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z' });
const bindings = { CANTELOP_INTEGRATION_TOKEN: 'app-token' };
function fixture(platform) {
  const calls = [];
  const worker = createProtocolWorker({ runtimeId: 'unused.v1', fetch: async request => {
    calls.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
    assert.equal(request.headers.get('Authorization'), null);
    assert.equal(request.headers.get('X-Cantelop-App-Id'), null);
    return platform(request);
  } });
  const app = new CantelopClient().app({ name: 'agent', runtime: { receive() {} }, connection: {
    fetch: request => worker.fetch(new Request(request, { headers: { ...Object.fromEntries(request.headers), Authorization: 'Bearer app-token' } }), bindings),
  } });
  return { app, calls };
}

test('SDK inspection reads without provisioning and absent workspaces return undefined', async () => {
  for (const workspace of [data(), null]) {
    const f = fixture(() => Response.json({ workspace }));
    const result = await f.app.workspace({ slug: 'project' }).inspect();
    assert.equal(result?.id, workspace?.id);
    assert.deepEqual(f.calls, ['GET /__cantelop/integration/v2/workspaces?workspace_slug=project']);
  }
});

test('SDK deletion pins the inspected ID and does not depend on session runtime compatibility', async () => {
  const f = fixture(request => request.method === 'GET' ? Response.json({ workspace: data() }) : Response.json({ id, status: 'deleting', hostArchived: false }, { status: 202 }));
  assert.deepEqual(await f.app.workspace({ slug: 'project' }).delete(), { id, status: 'deleting', hostArchived: false });
  assert.deepEqual(f.calls, [
    'GET /__cantelop/integration/v2/workspaces?workspace_slug=project',
    `DELETE /__cantelop/integration/v2/workspaces/${id}`,
  ]);
  const absent = fixture(() => Response.json({ workspace: null }));
  assert.equal(await absent.app.workspace({ slug: 'project' }).delete(), undefined);
  assert.equal(absent.calls.length, 1);
});

test('canonical deletion retries bypass slug lookup and successful deletion invalidates resolve cache', async () => {
  let current = id;
  const f = fixture(request => {
    if (request.method === 'DELETE') { current = replacement; return Response.json({ id, status: 'deleting', hostArchived: true }, { status: 202 }); }
    return Response.json(data(current));
  });
  const ref = f.app.workspace({ slug: 'project' });
  assert.equal((await ref.resolve()).id, id);
  await f.app.workspace({ id }).delete();
  await f.app.workspace({ id }).delete();
  // A separate reference retains its own resolve cache. Delete through ref to
  // verify its cache is reset, independently of canonical retries.
  const cached = fixture(request => request.method === 'DELETE'
    ? Response.json({ id, status: 'deleting', hostArchived: true }, { status: 202 })
    : request.method === 'GET' ? Response.json({ workspace: data() }) : Response.json(data(current)));
  current = id;
  const scoped = cached.app.workspace({ slug: 'project' });
  assert.equal((await scoped.resolve()).id, id);
  await scoped.delete(); current = replacement;
  assert.equal((await scoped.resolve()).id, replacement);
  assert.equal(f.calls.filter(call => call.startsWith('GET')).length, 0);
  assert.equal(f.calls.filter(call => call === `DELETE /__cantelop/integration/v2/workspaces/${id}`).length, 2);
});

test('SDK rejects malformed or mismatched inspection and deletion replies', async () => {
  for (const workspace of [undefined, { ...data(), slug: 'different' }, { ...data(), id: 'bad' }]) {
    const f = fixture(() => Response.json({ workspace }));
    await assert.rejects(f.app.workspace({ slug: 'project' }).inspect());
  }
  for (const response of [{ id: replacement, status: 'deleting', hostArchived: true }, { id, status: 'deleted', hostArchived: true }, { id, status: 'deleting' }]) {
    const f = fixture(() => Response.json(response));
    await assert.rejects(f.app.workspace({ id }).delete(), /invalid_workspace_deletion_response/);
  }
});

test('aborts prevent subsequent mutations and upstream failures propagate', async () => {
  const controller = new AbortController();
  const f = fixture(() => { controller.abort(new Error('Stopped')); return Response.json({ workspace: data() }); });
  await assert.rejects(f.app.workspace({ slug: 'project' }).delete({ signal: controller.signal }), /Stopped/);
  assert.equal(f.calls.length, 1);
  const unavailable = fixture(() => Response.json({ error: { code: 'control_unavailable' } }, { status: 503 }));
  await assert.rejects(unavailable.app.workspace({ id }).delete(), error => error.code === 'control_unavailable' && error.status === 503);
});

test('Edge rejects unauthenticated operations and slug deletion before private routing', async () => {
  let calls = 0;
  const worker = createProtocolWorker({ runtimeId: 'unused.v1', fetch: async () => { calls++; return new Response(); } });
  const body = { protocolVersion: 2, id: `msg_${'d'.repeat(32)}`, workspace: { slug: 'project' }, session: null, command: { type: 'workspace.delete' } };
  const request = token => new Request('https://agent.cantelop.dev/commands/workspace.delete', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await worker.fetch(request('wrong'), bindings)).status, 401);
  assert.equal((await worker.fetch(request('app-token'), bindings)).status, 400);
  assert.equal(calls, 0);
});
