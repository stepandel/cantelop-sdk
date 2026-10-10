import type { SessionContext } from "@cantelop/sdk/session";
import type { TaskMessage, TaskReply } from "./contracts.js";
import { createTask } from "./tasks.js";

export async function receive({ database, message, reply }: SessionContext<TaskMessage, never, TaskReply>) {
  const task = await createTask(await database(), message.payload.title);
  reply({ id: task.id });
}
