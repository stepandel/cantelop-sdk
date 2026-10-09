import { defineSessionRuntime } from "@cantelop/sdk";
import type { ChatMessage, ChatEvent } from "./contracts.js";

export const chatRuntime = defineSessionRuntime<ChatMessage, ChatEvent>({
  id: "web-chat.v1", entrypoint: "./session.ts",
});
export default chatRuntime;
