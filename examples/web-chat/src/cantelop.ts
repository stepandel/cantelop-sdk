import { CantelopClient } from "@cantelop/sdk";
import type { ChatMessage, ChatEvent } from "./contracts.js";

export const cantelop = new CantelopClient<ChatMessage, ChatEvent>({
  sessionRuntime: {
    id: "web-chat.v1",
    entrypoint: "./agent.ts",
  },
});

export default cantelop;
