import { CantelopClient } from "@cantelop/sdk";
import type { ChatMessage, ChatEvent } from "./contracts.js";

export const cantelop = new CantelopClient<ChatMessage, ChatEvent>({
  sessionRuntime: {
    id: "web-chat.v1",
    receive: async context => (await import("./session.js")).receive(context),
  },
});
export default cantelop;
