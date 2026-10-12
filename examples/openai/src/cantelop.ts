import { create } from "./agent.js";
import { CantelopClient } from "@cantelop/sdk";
import type { SessionMessage, SessionEvent } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<SessionMessage, SessionEvent>({
  name: "openai",
  runtime: { create, steering: "queue" },
  environment: {
    OPENAI_MODEL: { default: "gpt-5-mini" },
    OPENAI_API_KEY: { secret: true, required: true },
  },
});
