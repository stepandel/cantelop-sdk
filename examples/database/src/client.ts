import { createApp, type AppConnection, type WorkspaceSelector } from "@cantelop/sdk";
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";

/** Application service functions; the caller owns its application's HTTP routes. */
export function taskService(connection: AppConnection, selector: WorkspaceSelector) {
  const workspace = createApp<{ title: string }, never, { id: string }>({ connection }).workspace(selector);
  return {
    async list() {
      const db = drizzle(await workspace.database(), { schema });
      return db.query.tasks.findMany();
    },
    async create(title: string) {
      const db = drizzle(await workspace.database(), { schema });
      const task = { id: crypto.randomUUID(), title };
      await db.insert(schema.tasks).values(task);
      return task;
    },
    session: () => workspace.session({ keepAliveSeconds: 0 }),
  };
}
