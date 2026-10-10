import { receive } from "./agent.js";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

export const cantelop = new CantelopClient<SessionMessage, SessionEvent>({
  sessionRuntime: { receive },
});
