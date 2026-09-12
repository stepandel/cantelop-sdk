import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLocalDatabase, splitMigrationSQL } from "../dist/local-database.js";

test("SQL splitter preserves quoted semicolons and removes comments", () => {
  assert.deepEqual(splitMigrationSQL("-- comment;\nCREATE TABLE t (s TEXT); INSERT INTO t VALUES ('a;''b'); /* ; */ SELECT [a;b];"), ["CREATE TABLE t (s TEXT)", "INSERT INTO t VALUES ('a;''b')", "SELECT [a;b]"]);
  assert.throws(() => splitMigrationSQL("SELECT 'unfinished"));
});
test("local D1 migrations persist, reconcile retries, and roll back failed batches", async () => {
  const persist = await mkdtemp(join(tmpdir(), "cantelop-d1-"));
  try {
    const first = { persist, name: "0001_items.sql", sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO items VALUES(1, 'first;item');" };
    assert.equal((await migrateLocalDatabase(first)).replayed, false);
    assert.equal((await migrateLocalDatabase(first)).replayed, true);
    await assert.rejects(migrateLocalDatabase({ ...first, sql: "SELECT 1" }), /checksum/);
    await assert.rejects(migrateLocalDatabase({ persist, name: "0002_failed.sql", sql: "INSERT INTO items VALUES(2, 'two'); INSERT INTO missing VALUES(1);" }));
    // This succeeds only if the failed batch's earlier insert was rolled back.
    await migrateLocalDatabase({ persist, name: "0002_fixed.sql", sql: "INSERT INTO items VALUES(2, 'two');" });
    await assert.rejects(migrateLocalDatabase({ persist, name: "0000_old.sql", sql: "SELECT 1" }), /order/);
  } finally { await rm(persist, { recursive: true, force: true }); }
});

test("built Edge API reads persistent D1 and reloads without losing data", async () => {
  const { createServer } = await import("node:net");
  const { buildApi, serveLocalDatabaseApi } = await import("../dist/build.js");
  const root = await mkdtemp(join(tmpdir(), "cantelop-d1-api-"));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let host;
  try {
    const source = join(root, "api.mjs");
    const sdkApi = new URL("../dist/api.js", import.meta.url).href;
    // esbuild needs a filesystem import rather than a file URL.
    const { fileURLToPath } = await import("node:url");
    const writeAPI = async (version) => {
      await writeFile(source, `import { defineApi } from ${JSON.stringify(fileURLToPath(sdkApi))}; export default defineApi(({db, router}) => router.route('GET', '/', async () => Response.json({version:${version}, row:await db.prepare('SELECT title FROM items WHERE id=1').first()})));`);
      await buildApi({ entrypoint: source, outdir: join(root, "built") });
    };
    await migrateLocalDatabase({ persist: join(root, "db"), name: "0001_items.sql", sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT); INSERT INTO items VALUES(1, 'persisted');" });
    await writeAPI(1);
    host = await serveLocalDatabaseApi({ workerPath: join(root, "built/worker.mjs"), persist: join(root, "db"), port });
    await assert.rejects(migrateLocalDatabase({ persist: join(root, "db"), name: "0002_blocked.sql", sql: "SELECT 1" }), /in use/);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}`)).json(), { version: 1, row: { title: "persisted" } });
    await writeAPI(2);
    let response;
    for (let i = 0; i < 40; i++) {
      response = await (await fetch(`http://127.0.0.1:${port}`)).json();
      if (response.version === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(response, { version: 2, row: { title: "persisted" } });
  } finally { await host?.close(); await rm(root, { recursive: true, force: true }); }
});
