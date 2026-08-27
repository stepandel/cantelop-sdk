import { Agent, MemorySession, run } from "@openai/agents";
import {
  defineSessionBehaviour,
  type SessionContext,
} from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

type Context = SessionContext<SessionMessage, SessionEvent>;

let agent: Agent | undefined;
let conversation: MemorySession | undefined;
const promptQueue: string[] = [];

export default defineSessionBehaviour<SessionMessage, SessionEvent>((context) => {
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

  context.activity.start(async ({ signal, send, output }) => {
    try {
      const result = await run(currentAgent, prompt, {
        session: currentConversation,
        signal,
        stream: true,
      });

      let answer = "";
      for await (const delta of result.toTextStream()) {
        answer += delta;
        await output.send({ type: "text_delta", delta });
      }
      await result.completed;
      await output.send({ type: "done", answer: result.finalOutput ?? answer });
    } finally {
      const nextPrompt = promptQueue.shift();
      if (!signal.aborted && nextPrompt !== undefined) {
        send({ type: "prompt", prompt: nextPrompt });
      }
    }
  });
}
