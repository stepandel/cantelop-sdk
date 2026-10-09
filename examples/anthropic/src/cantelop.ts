import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

export const cantelop = new CantelopClient<SessionMessage, SessionEvent>({
  sessionRuntime: {
    id: "anthropic.v1",
    async receive(context) {
      const { receive } = await import("./agent.js");
      await receive(context);
    },
  },
});

export default cantelop;
