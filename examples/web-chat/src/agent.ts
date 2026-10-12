import { Agent, MemorySession, run } from "@openai/agents";
import type { SessionContext } from "@cantelop/sdk/session";
import type { ChatEvent, ChatMessage } from "./contracts.js";

type Context = SessionContext<ChatMessage, ChatEvent>;

let agent: Agent | undefined;
let conversation: MemorySession | undefined;

export function receive(context: Context): void {
  const command = context.message.payload;

  queuePrompt(context, command.prompt);
}

function queuePrompt(context: Context, prompt: string): void {
  if (!context.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  agent ??= new Agent({
    name: "Cantelop web chat",
    instructions: "You are a concise, helpful assistant.",
    model: context.env.OPENAI_MODEL ?? "gpt-5-mini",
  });
  conversation ??= new MemorySession({ sessionId: context.session.id });
  const currentAgent = agent;
  const currentConversation = conversation;

  context.activity.queue(async ({ signal, output }) => {
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
  });
}
