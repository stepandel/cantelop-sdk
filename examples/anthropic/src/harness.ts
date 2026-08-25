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

const queuedPrompts: string[] = [];
let providerSessionId: string | undefined;

function startTurn(
  context: HarnessContext<PromptInput, RuntimeEvent>,
  prompt: string,
): void {
  const { env, activity, emit } = context;
  activity.start(async ({ signal, send }) => {
    if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
      throw new Error(
        "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is not configured in the harness VM",
      );
    }

    const abortController = new AbortController();
    const abort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const messages = query({
      prompt,
      options: {
        abortController,
        includePartialMessages: true,
        systemPrompt: "You are a concise, helpful assistant.",
        maxTurns: 10,
        ...(providerSessionId === undefined ? {} : { resume: providerSessionId }),
      },
    });

    try {
      for await (const message of messages) {
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
          emit({ type: "done", output: { answer: message.result } });
          return;
        }
      }
      throw new Error("Claude Agent SDK completed without a result");
    } finally {
      signal.removeEventListener("abort", abort);
      messages.close();
      const nextPrompt = queuedPrompts.shift();
      if (nextPrompt !== undefined) {
        send({ type: "message", prompt: nextPrompt });
      }
    }
  });
}

async function receive(
  context: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<void> {
  const command = context.message.payload;

  if (command.type === "cancel") {
    queuedPrompts.length = 0;
    context.activity.cancel();
    return;
  }

  if (context.activity.active) {
    queuedPrompts.push(command.prompt);
    return;
  }

  startTurn(context, command.prompt);
}

export default defineHarness<PromptInput, RuntimeEvent>({ receive });
