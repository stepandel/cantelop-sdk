import type { ThreadEvent } from "@openai/codex-sdk";

export type SessionMessage = { type: "prompt"; prompt: string };
/** Forward the stock Codex event contract, including tools and turn outcomes. */
export type SessionEvent = ThreadEvent;
