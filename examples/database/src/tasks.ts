import type { WorkspaceDatabase } from "@cantelop/sdk/database";
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";

export async function listTasks(database: WorkspaceDatabase) {
  const db = drizzle(database, { schema });
  return db.query.tasks.findMany();
}

export async function createTask(database: WorkspaceDatabase, title: string) {
  const db = drizzle(database, { schema });
  const task = { id: crypto.randomUUID(), title };
  await db.insert(schema.tasks).values(task);
  return task;
}
