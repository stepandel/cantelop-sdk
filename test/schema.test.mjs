import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle, sqliteTable, text, integer, eq } from "../dist/schema.js";
import { createWorkspaceDatabase } from "../dist/database.js";

test("Drizzle uses the renewable Workspace client for queries, batch, and transactions", async () => {
  const tasks = sqliteTable("tasks", { id: text().primaryKey(), title: text().notNull(), done: integer({ mode: "boolean" }).notNull().default(false) });
  const directory = await mkdtemp(join(tmpdir(), "cantelop-drizzle-"));
  const connection = createWorkspaceDatabase(async () => ({ url: "libsql://test.turso.io", authToken: "test", expiresAt: new Date(Date.now() + 900000).toISOString() }), { client: () => createClient({ url: `file:${join(directory, "test.sqlite")}` }) });
  try {
    await connection.execute("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)");
    const db = drizzle(connection, { schema: { tasks } });
    await db.insert(tasks).values({ id: "1", title: "first" });
    assert.deepEqual(await db.query.tasks.findFirst(), { id: "1", title: "first", done: false });
    await db.transaction(async tx => { await tx.update(tasks).set({ done: true }).where(eq(tasks.id, "1")); });
    await assert.rejects(db.transaction(async tx => { await tx.insert(tasks).values({ id: "2", title: "rollback" }); throw new Error("abort"); }), /abort/);
    const results = await db.batch([db.select().from(tasks), db.select().from(tasks).where(eq(tasks.id, "2"))]);
    assert.deepEqual(results, [[{ id: "1", title: "first", done: true }], []]);
  } finally { connection.close(); await rm(directory, { recursive: true, force: true }); }
});
