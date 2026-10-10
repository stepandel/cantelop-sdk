import { receive } from "./runtime.js";
import { CantelopClient } from "@cantelop/sdk";
import type { TaskMessage, TaskReply } from "./contracts.js";

export const cantelop = new CantelopClient<TaskMessage, never, TaskReply>({
  sessionRuntime: { receive },
});

export default cantelop;
