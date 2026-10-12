import { CantelopClient } from "@cantelop/sdk";
import { create } from "./agent.js";
import type { SessionMessage, SessionEvent } from "./contracts.js";

export const app = new CantelopClient().app<SessionMessage, SessionEvent>({
  name: "codex",
  // The Codex TypeScript SDK exposes turn execution and abort signals, not live steering.
  runtime: { create, steering: "queue" },
  environment: {
    OPENAI_API_KEY: { secret: true, required: true },
    CODEX_MODEL: {},
    CODEX_PATH: { default: "/usr/local/bin/codex" },
  },
  dockerfile: "docker/Dockerfile",
});
