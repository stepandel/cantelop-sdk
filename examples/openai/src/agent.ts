import { Agent, MemorySession, run } from "@openai/agents";
import type { SessionHarnessContext, SessionHarness } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";
export function create(context: SessionHarnessContext): SessionHarness<SessionMessage, SessionEvent> {
  if (!context.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  const agent = new Agent({
    name: "Cantelop OpenAI example",
    instructions: "You are a concise, helpful assistant.",
    model: context.env.OPENAI_MODEL ?? "gpt-5-mini",
  });
  const conversation = new MemorySession({ sessionId: context.session.id });
  const currentAgent = agent;
  const currentConversation = conversation;
  return { steering: "queue", async run(message, { signal, output }) {
      const result = await run(currentAgent, message.prompt, {
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
    } };
}
