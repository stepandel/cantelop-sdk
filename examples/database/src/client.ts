import type { AppSelector } from "@cantelop/sdk";
import { CantelopClient, type WorkspaceRef } from "@cantelop/sdk";
import { drizzle } from "@cantelop/sdk/schema";
import * as schema from "../db/schema.js";

import type { TaskMessage, TaskReply } from "./contracts.js";

/** Configure the App once; Workspaces own database access and Session references. */
export class TasksClient extends CantelopClient<TaskMessage, never, TaskReply> {
  constructor(options: (AppSelector | { id?: never; slug?: never }) & { profile?: string } = {}) {
    super({ ...options, sessionRuntime: { id: "tasks.v1", receive: async context => (await import("./session.js")).receive(context) } });
  }
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

export const cantelop = new TasksClient();
export default cantelop;
