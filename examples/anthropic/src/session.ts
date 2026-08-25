import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  defineSessionLogic,
  type SessionContext,
} from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

type Context = SessionContext<SessionMessage, SessionEvent>;

let conversationId: string | undefined;
let pendingSteer: string | undefined;

export default defineSessionLogic<SessionMessage, SessionEvent>({
  receive(context) {
    const command = context.message.payload;

    if (command.type === "cancel") {
      pendingSteer = undefined;
      context.activity.cancel();
      return;
    }

    if (command.type === "steer") {
      if (!context.activity.active) {
        throw new Error("No active Claude query to steer");
      }
      pendingSteer = command.prompt;
      return;
    }

    if (context.activity.active) {
      throw new Error("The Session is already processing a prompt");
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

    let completed = false;
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
          completed = true;
          return;
        }
      }
      throw new Error("Claude Agent SDK completed without a result");
    } finally {
      signal.removeEventListener("abort", abort);
      messages.close();
      const steer = pendingSteer;
      pendingSteer = undefined;
      if (completed && steer !== undefined) {
        send({ type: "prompt", prompt: steer });
      }
    }
  });
}
