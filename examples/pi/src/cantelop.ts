import { create } from "./agent.ts";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.ts";

const cantelop = new CantelopClient();

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "pi",
  runtime: { create },
  environment: {
    ANTHROPIC_API_KEY: { secret: true, required: true },
    PI_PROVIDER: { default: "anthropic" },
    PI_MODEL: { default: "claude-sonnet-5" },
  },
});
