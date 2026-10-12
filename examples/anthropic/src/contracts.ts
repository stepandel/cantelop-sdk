import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type SessionMessage = { type: "prompt"; prompt: string };
/** Forward native Claude Code output, including tools, deltas and turn results. */
export type SessionEvent = SDKMessage;
