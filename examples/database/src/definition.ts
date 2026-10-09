import { defineSessionRuntime } from "@cantelop/sdk";
import type { TaskMessage, TaskReply } from "./contracts.js";

export const sessionRuntime = defineSessionRuntime<TaskMessage, never, TaskReply>({
  id: "tasks.v1", entrypoint: "./session.ts",
});
export default sessionRuntime;
