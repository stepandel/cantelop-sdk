import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { sqliteTable, text, integer } from "../dist/schema.js";
import { createApplicationSchema, synchronizeApplicationSchema, validateApplicationSchema, applicationMigrationSQL } from "../dist/build.js";

test("application artifacts are deterministic and reject reserved objects and system foreign keys", async () => {
  const tasks = sqliteTable("tasks", { id: text().primaryKey() });
  assert.deepEqual(await createApplicationSchema({ tasks }), await createApplicationSchema({ tasks }));
  await assert.rejects(createApplicationSchema({ mailbox: sqliteTable("CaNtElOp_mailbox", { id: text() }) }), /reserved_table_name/);
  const system = sqliteTable("cantelop_mailbox_sessions", { id: text().primaryKey() });
  await assert.rejects(createApplicationSchema({ tasks: sqliteTable("tasks", { session: text().references(() => system.id) }) }), /foreign_key_outside_application/);
  const artifact = await createApplicationSchema({ tasks });
  assert.throws(() => validateApplicationSchema({ ...artifact, digest: "sha256:" + "0".repeat(64) }), /artifact_digest_mismatch/);
});

test("automatic migrations preserve application records and unmanaged tables, and retain SQL history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantelop-schema-"));
  const db = createClient({ url: `file:${join(directory, "test.sqlite")}` });
  try {
    await db.execute("CREATE TABLE application_checkpoints (id TEXT PRIMARY KEY)");
    await db.execute("INSERT INTO application_checkpoints VALUES ('checkpoint')");
    const initial = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey() }) });
    assert.equal((await synchronizeApplicationSchema(db, initial)).statements.length, 1);
    assert.equal(await synchronizeApplicationSchema(db, initial), undefined);
    await db.execute("INSERT INTO tasks VALUES ('app')");
    const next = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey(), done: integer().notNull().default(0) }) });
    await synchronizeApplicationSchema(db, next);
    assert.equal((await db.execute("SELECT done FROM tasks WHERE id='app'")).rows[0].done, 0);
    assert.equal((await db.execute("SELECT id FROM application_checkpoints")).rows[0].id, "checkpoint");
    assert.equal((await db.execute("SELECT name FROM sqlite_schema WHERE name LIKE 'cantelop_mailbox_%'")).rows.length, 0);
    assert.equal((await db.execute("SELECT COUNT(*) AS count FROM cantelop_application_migrations")).rows[0].count, 2);
    await assert.rejects(applicationMigrationSQL(next, initial), /explicit_migration_required/);
    const invalid = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey(), done: integer().notNull().default(0), required: text().notNull() }) });
    await assert.rejects(synchronizeApplicationSchema(db, invalid));
    assert.equal((await db.execute("SELECT COUNT(*) AS count FROM cantelop_application_migrations")).rows[0].count, 2);
    assert.equal((await db.execute("PRAGMA table_info(tasks)")).rows.some(row => row.name === "required"), false);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("schema build evaluates a developer-only TypeScript module and preserves deterministic artifacts", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { buildDatabaseSchema } = await import("../dist/build.js");
  const directory = await mkdtemp(join(tmpdir(), "cantelop-schema-build-"));
  const filename = join(directory, "schema.ts");
  try {
    await writeFile(filename, `import { sqliteTable, text } from ${JSON.stringify(new URL("../dist/schema.js", import.meta.url).pathname)}; export const tasks = sqliteTable("tasks", { id: text().primaryKey() });`);
    assert.deepEqual(await buildDatabaseSchema(filename), await buildDatabaseSchema(filename));
    assert.equal(await buildDatabaseSchema(join(directory, "missing.ts")), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("destructive changes require a schema declaration and ambiguous renames do not open a prompt", async () => {
  const initial = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey(), title: text() }) });
  const next = await createApplicationSchema({ allowDestructiveChanges: true, tasks: sqliteTable("tasks", { id: text().primaryKey() }) });
  assert.ok((await applicationMigrationSQL(initial, next)).length > 0);
  const rename = await createApplicationSchema({ allowDestructiveChanges: true, tasks: sqliteTable("tasks", { id: text().primaryKey(), name: text() }) });
  await assert.rejects(applicationMigrationSQL(initial, rename), /ambiguous_column_rename/);
});

test("historical release rollback retains the newer physical schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantelop-schema-rollback-"));
  const db = createClient({ url: `file:${join(directory, "test.sqlite")}` });
  try {
    const initial = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey() }) });
    const next = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey(), title: text() }) });
    await synchronizeApplicationSchema(db, initial);
    await synchronizeApplicationSchema(db, next);
    assert.equal(await synchronizeApplicationSchema(db, initial), undefined);
    assert.equal((await db.execute("PRAGMA table_info(tasks)")).rows.some(row => row.name === "title"), true);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("initial managed schema rejects existing declared tables without changing their data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantelop-schema-adoption-"));
  const db = createClient({ url: `file:${join(directory, "test.sqlite")}` });
  try {
    await db.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
    await db.execute("INSERT INTO tasks VALUES ('existing')");
    const schema = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey() }) });
    await assert.rejects(synchronizeApplicationSchema(db, schema), /unmanaged_table_conflict/);
    assert.equal((await db.execute("SELECT id FROM tasks")).rows[0].id, "existing");
    assert.equal((await db.execute("SELECT COUNT(*) AS count FROM cantelop_application_migrations")).rows[0].count, 0);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("local schema initialization installs no mailbox and preserves unmanaged application tables", async () => {
  const { synchronizeLocalDatabase } = await import("../dist/build.js");
  const directory = await mkdtemp(join(tmpdir(), "cantelop-local-schema-"));
  const filename = join(directory, "test.sqlite");
  const db = createClient({ url: `file:${filename}` });
  try {
    await db.execute("CREATE TABLE application_queue (id TEXT PRIMARY KEY)");
    await db.execute("INSERT INTO application_queue VALUES ('pending')");
    await synchronizeLocalDatabase(filename);
    assert.equal((await db.execute("SELECT name FROM sqlite_schema WHERE name LIKE 'cantelop_%'")).rows.length, 0);
    const schema = await createApplicationSchema({ tasks: sqliteTable("tasks", { id: text().primaryKey() }) });
    await synchronizeLocalDatabase(filename, schema);
    assert.equal((await db.execute("SELECT id FROM application_queue")).rows[0].id, "pending");
    assert.equal((await db.execute("SELECT name FROM sqlite_schema WHERE name LIKE 'cantelop_mailbox_%' OR name='cantelop_system_migrations'")).rows.length, 0);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("later managed schemas reject newly declared tables created outside migration history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cantelop-schema-later-adoption-"));
  const db = createClient({ url: `file:${join(directory, "test.sqlite")}` });
  try {
    const tasks = sqliteTable("tasks", { id: text().primaryKey() });
    await synchronizeApplicationSchema(db, await createApplicationSchema({ tasks }));
    await db.execute("CREATE TABLE jobs (id TEXT PRIMARY KEY)");
    await db.execute("INSERT INTO jobs VALUES ('pending')");
    await assert.rejects(synchronizeApplicationSchema(db, await createApplicationSchema({ tasks, jobs: sqliteTable("jobs", { id: text().primaryKey() }) })), /unmanaged_table_conflict/);
    assert.equal((await db.execute("SELECT id FROM jobs")).rows[0].id, "pending");
    assert.equal((await db.execute("SELECT COUNT(*) AS count FROM cantelop_application_migrations")).rows[0].count, 1);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
