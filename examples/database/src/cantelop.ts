import { CantelopClient } from "@cantelop/sdk";
import type { TaskMessage, TaskReply } from "./contracts.js";

export const cantelop = new CantelopClient<TaskMessage, never, TaskReply>({
  sessionRuntime: {
    id: "tasks.v1",
    async receive({ database, message, reply }) {
      const { createTask } = await import("./tasks.js");
      const task = await createTask(await database(), message.payload.title);
      reply({ id: task.id });
    },
  },
});

export default cantelop;
