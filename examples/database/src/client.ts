import { createApp, type CreateAppOptions, type WorkspaceRef } from "@cantelop/sdk";
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";

type TaskMessage = { title: string };
type TaskReply = { id: string };

/** Configure the App once; Workspaces own database access and Session references. */
export function createTasksApp(options: CreateAppOptions = {}) {
  return createApp<TaskMessage, never, TaskReply>(options);
}

/** Application service functions over a Workspace selected from the App. */
export function taskService(workspace: WorkspaceRef<TaskMessage, never, TaskReply>) {
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
  };
}
