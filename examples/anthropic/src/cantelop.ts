import { create } from "./agent.ts";
import { claudeAuth } from "./auth.ts";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.ts";

const cantelop = new CantelopClient();

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "anthropic",
  runtime: { create },
  auth: claudeAuth,
  environment: {
    CLAUDE_PATH: { default: "/usr/local/bin/claude" },
    CLAUDE_MODEL: {},
  },
  dockerfile: "docker/Dockerfile",
});
