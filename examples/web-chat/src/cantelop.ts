import { receive } from "./agent.js";
import { CantelopClient } from "@cantelop/sdk";
import type { ChatMessage, ChatEvent } from "./contracts.js";

const cantelop = new CantelopClient();

export const app = cantelop.app<ChatMessage, ChatEvent>({
  name: "web-chat",
  runtime: { receive },
  environment: {
    OPENAI_MODEL: { default: "gpt-5-mini" },
    OPENAI_API_KEY: { secret: true, required: true },
  },
});
