import { receive } from "./runtime.js";
import { CantelopClient } from "@cantelop/sdk";
import type { TaskMessage, TaskReply } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<TaskMessage, never, TaskReply>({
  name: "database-example",
  runtime: { receive },

});
