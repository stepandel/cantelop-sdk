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
  { session, input, env, signal, emit }: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<AnswerOutput> {
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
        return output;
      }
    }
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }

  throw new Error("Claude Agent SDK completed without a result");
}

async function steerTurn(
  context: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<AnswerOutput> {
  // Claude resumes the provider session and applies the steer as its next turn.
  return runTurn(context);
}

export default defineHarness<PromptInput, AnswerOutput, RuntimeEvent>({
  run: runTurn,
  steer: steerTurn,
});
