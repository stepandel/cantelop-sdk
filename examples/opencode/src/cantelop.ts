import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

export const cantelop = new CantelopClient<SessionMessage, SessionEvent>({
  sessionRuntime: {
    id: "opencode.v1",
    entrypoint: "./agent.ts",
  },
});

export default cantelop;
