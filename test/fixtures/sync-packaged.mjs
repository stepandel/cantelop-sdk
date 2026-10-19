// Run against the registry-shaped tarball installed with --ignore-scripts.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CantelopClient } from '@cantelop/sdk';

const root = await mkdtemp(join(tmpdir(), 'sdk-packed-sync-'));
const id = `wsp_${'1'.repeat(32)}`;
const hash = data => createHash('sha256').update(Buffer.from([0])).update(data).digest('hex');
const files = new Map([['remote', Buffer.from('download')]]);
const entry = (path, data) => ({ path, version: hash(data), size: data.length, executable: false });
process.env.CANTELOP_SYNC_STATE_HOME = join(root, 'state');
const app = new CantelopClient().app({ name: 'packed-sync', runtime: { receive() {} }, connection: { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/commands/workspace.resolve') {
    return Response.json({ id, app_id: `app_${'2'.repeat(32)}`, slug: 'project', hostname: 'fixture.example', created_at: '2026-10-19T00:00:00Z', updated_at: '2026-10-19T00:00:00Z' });
  }
  assert.equal(url.pathname, `/__cantelop/sync/workspaces/${id}`);
  const op = url.searchParams.get('op'), name = url.searchParams.get('path');
  if (op === 'scan') return Response.json({ protocolVersion: 1, root: 'project', writes: true, entries: [...files].map(([name, data]) => entry(name, data)) });
  const previous = files.get(name);
  assert.equal(url.searchParams.get('base'), previous ? hash(previous) : 'missing');
  if (op === 'read') return new Response(previous);
  if (op === 'write') {
    const data = Buffer.from(await request.arrayBuffer());files.set(name, data);
    return Response.json(entry(name, data));
  }
  if (op === 'remove') { files.delete(name);return new Response(null, { status: 204 }); }
  throw new Error(`Unexpected operation: ${op}`);
} } });
let sync;
try {
  const { mkdir } = await import('node:fs/promises');
  const local = join(root, 'project');await mkdir(local);
  await writeFile(join(local, 'local'), 'upload');
  sync = await app.workspace({ id }).sync({ localDirectory: local, pollIntervalMs: 60000 });
  await sync.ready();
  assert.equal(files.get('local').toString(), 'upload');
  assert.equal(await readFile(join(local, 'remote'), 'utf8'), 'download');
  await writeFile(join(local, 'local'), 'updated');await sync.flush();
  assert.equal(files.get('local').toString(), 'updated');
} finally {
  await sync?.stop();await rm(root, { recursive: true, force: true });
}
