import type { SessionPromptResponse } from "@opencode-ai/sdk/v2";

export type SessionMessage = { type: "prompt"; prompt: string };
/** The native completed prompt response: assistant info and parts. */
export type SessionEvent = SessionPromptResponse;
