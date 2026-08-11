import { query } from "@anthropic-ai/claude-agent-sdk";
import { defineHarness } from "@cantelop/sdk/harness";
import type {
  AnswerOutput,
  PromptInput,
} from "./contracts.js";

type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: AnswerOutput };

export default defineHarness<PromptInput, AnswerOutput, RuntimeEvent>(
  async ({ input, env, signal, emit }) => {
    if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error(
        "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is not configured in the harness VM",
      );
    }

    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });

    try {
      for await (const message of query({
        prompt: input.prompt,
        options: {
          abortController,
          includePartialMessages: true,
          systemPrompt: "You are a concise, helpful assistant.",
          maxTurns: 10,
        },
      })) {
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
          return output;
        }
      }
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }

    throw new Error("Claude Agent SDK completed without a result");
  },
);
