import { receive } from "./agent.js";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "opencode",
  runtime: { receive },
  environment: {
    ANTHROPIC_API_KEY: { secret: true, required: true },
    OPENCODE_MODEL: { default: "anthropic/claude-sonnet-4-5" },
  },
  dockerfile: "docker/Dockerfile",
});
