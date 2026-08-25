import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  defineSessionLogic,
  type SessionContext,
} from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

type Context = SessionContext<SessionMessage, SessionEvent>;

let conversationId: string | undefined;
const promptQueue: string[] = [];

export default defineSessionLogic<SessionMessage, SessionEvent>({
  receive(context) {
    const command = context.message.payload;

    if (command.type === "cancel") {
      promptQueue.length = 0;
      context.activity.cancel();
      return;
    }

    if (context.activity.active) {
      promptQueue.push(command.prompt);
      return;
    }

    startPrompt(context, command.prompt);
  },
});

function startPrompt(context: Context, prompt: string): void {
  if (!context.env.ANTHROPIC_API_KEY && !context.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is not configured",
    );
  }

  context.activity.start(async ({ signal, send }) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });

    const messages = query({
      prompt,
      options: {
        abortController,
        includePartialMessages: true,
        maxTurns: 10,
        systemPrompt: "You are a concise, helpful assistant.",
        ...(conversationId === undefined ? {} : { resume: conversationId }),
      },
    });

    try {
      for await (const message of messages) {
        if (message.type === "system" && message.subtype === "init") {
          conversationId = message.session_id;
        } else if (
          message.type === "stream_event" &&
          message.event.type === "content_block_delta" &&
          message.event.delta.type === "text_delta"
        ) {
          context.emit({ type: "text_delta", delta: message.event.delta.text });
        } else if (message.type === "result" && "result" in message) {
          context.emit({ type: "done", answer: message.result });
          return;
        }
      }
      throw new Error("Claude Agent SDK completed without a result");
    } finally {
      signal.removeEventListener("abort", abort);
      messages.close();
      const nextPrompt = promptQueue.shift();
      if (!signal.aborted && nextPrompt !== undefined) {
        send({ type: "prompt", prompt: nextPrompt });
      }
    }
  });
}
