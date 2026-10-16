import { create } from "./agent.ts";
import { CantelopClient } from "@cantelop/sdk";
import type { ChatMessage, ChatEvent } from "./contracts.ts";

const cantelop = new CantelopClient();

export const app = cantelop.app<ChatMessage, ChatEvent>({
  name: "web-chat",
  runtime: { create },
  environment: {
    OPENAI_MODEL: { default: "gpt-5-mini" },
    OPENAI_API_KEY: { secret: true, required: true },
  },
});
