import { CantelopClient } from "@cantelop/sdk";
import type { TaskMessage, TaskReply } from "./contracts.js";

export const cantelop = new CantelopClient<TaskMessage, never, TaskReply>({
  sessionRuntime: {
    id: "tasks.v1",
    entrypoint: "./runtime.ts",
  },
});

export default cantelop;
