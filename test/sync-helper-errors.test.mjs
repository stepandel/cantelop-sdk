import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { temporaryDirectory } from './helpers.mjs';

test('an incomplete SDK installation reports its own missing adapter without a CLI fallback', async t => {
  const root = await temporaryDirectory(t, 'sdk-missing-adapter-');
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['sync-node.js', 'sync.js', 'shared.js']) {
    await copyFile(new URL(`../dist/${name}`, import.meta.url), join(root, name));
  }
  const { startSync } = await import(pathToFileURL(join(root, 'sync-node.js')));
  await assert.rejects(startSync({ localDirectory: root }, `wsp_${'1'.repeat(32)}`, () => {
    throw new Error('Remote transfers must not start without a local adapter');
  }), { code: 'sync_helper_unavailable' });
});
