import { receive } from "./agent.js";
import { CantelopClient } from "@cantelop/sdk";
import type { ChatMessage, ChatEvent } from "./contracts.js";

export const cantelop = new CantelopClient<ChatMessage, ChatEvent>({
  sessionRuntime: { receive },
});

export default cantelop;
