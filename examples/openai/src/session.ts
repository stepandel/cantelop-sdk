import { Agent, MemorySession, run } from "@openai/agents";
import {
  defineSessionLogic,
  type SessionContext,
} from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

type Context = SessionContext<SessionMessage, SessionEvent>;

let agent: Agent | undefined;
let conversation: MemorySession | undefined;
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
        throw new Error("No active OpenAI run to steer");
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
  if (!context.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  agent ??= new Agent({
    name: "Cantelop OpenAI example",
    instructions: "You are a concise, helpful assistant.",
    model: context.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  });
  conversation ??= new MemorySession({ sessionId: context.session.id });
  const currentAgent = agent;
  const currentConversation = conversation;

  context.activity.start(async ({ signal, send }) => {
    let completed = false;
    try {
      const result = await run(currentAgent, prompt, {
        session: currentConversation,
        signal,
        stream: true,
      });

      let answer = "";
      for await (const delta of result.toTextStream()) {
        answer += delta;
        context.emit({ type: "text_delta", delta });
      }
      await result.completed;
      context.emit({ type: "done", answer: result.finalOutput ?? answer });
      completed = true;
    } finally {
      const steer = pendingSteer;
      pendingSteer = undefined;
      if (completed && steer !== undefined) {
        send({ type: "prompt", prompt: steer });
      }
    }
  });
}
