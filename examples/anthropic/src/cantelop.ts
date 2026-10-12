import { create } from "./agent.js";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "anthropic",
  runtime: { create },
  environment: {
    ANTHROPIC_API_KEY: { secret: true, required: true },
    CLAUDE_PATH: { default: "/usr/local/bin/claude" },
  },
  dockerfile: "docker/Dockerfile",
});
