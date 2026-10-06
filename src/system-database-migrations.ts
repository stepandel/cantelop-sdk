import type { WorkspaceDatabase } from "./database.js";
import { MAILBOX_SCHEMA } from "./mailbox-store.js";

/** SDK-owned system schema. Application migration tools never receive these definitions. */
export const SYSTEM_DATABASE_MIGRATIONS = [{ id: "mailbox/001_initial", statements: MAILBOX_SCHEMA }] as const;

export async function migrateSystemDatabase(db: Pick<WorkspaceDatabase, "execute" | "transaction">): Promise<void> {
  await db.execute(`CREATE TABLE IF NOT EXISTS cantelop_system_migrations (id TEXT PRIMARY KEY, definition TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const tx = await db.transaction("write");
  try {
    const applied = (await tx.execute("SELECT id, definition FROM cantelop_system_migrations")).rows;
    for (const row of applied) {
      const migration = SYSTEM_DATABASE_MIGRATIONS.find(value => value.id === row.id);
      if (!migration || JSON.stringify(migration.statements) !== row.definition) throw new Error("system_schema_incompatible");
    }
    for (const migration of SYSTEM_DATABASE_MIGRATIONS) {
      if (applied.some(row => row.id === migration.id)) continue;
      for (const statement of migration.statements) await tx.execute(statement);
      // Adopting an existing Workspace must not silently bless an incompatible mailbox version.
      const version = (await tx.execute("SELECT version FROM cantelop_mailbox_schema WHERE id=1")).rows[0]?.version;
      if (Number(version) !== 1) throw new Error("system_schema_incompatible");
      await tx.execute({ sql: "INSERT INTO cantelop_system_migrations(id,definition,applied_at) VALUES(?,?,?)", args: [migration.id, JSON.stringify(migration.statements), Date.now()] });
    }
    await tx.commit();
  } finally { tx.close(); }
}
