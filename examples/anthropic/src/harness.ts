import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  defineHarness,
  type HarnessContext,
} from "@cantelop/sdk/harness";
import type {
  AnswerOutput,
  PromptInput,
} from "./contracts.js";

type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: AnswerOutput };

let providerSessionId: string | undefined;

async function runTurn(
  { session, message: received, env, emit }: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<void> {
  if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is not configured in the harness VM",
    );
  }

  for await (const message of query({
    prompt: received.payload.prompt,
    options: {
      includePartialMessages: true,
      systemPrompt: "You are a concise, helpful assistant.",
      maxTurns: 10,
      ...(providerSessionId === undefined ? {} : { resume: providerSessionId }),
    },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      providerSessionId = message.session_id;
    }
    if (
      message.type === "stream_event" &&
      message.event.type === "content_block_delta" &&
      message.event.delta.type === "text_delta"
    ) {
      emit({ type: "text_delta", delta: message.event.delta.text });
    }
    if (message.type === "result" && "result" in message) {
      const output = { answer: message.result };
      emit({ type: "done", output });
      return;
    }
  }

  throw new Error("Claude Agent SDK completed without a result");
}

// Input meaning is application-owned. Both messages and steer requests resume
// the same provider session here in FIFO order.
export default defineHarness<PromptInput, RuntimeEvent>({ receive: runTurn });
