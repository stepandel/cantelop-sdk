import { TurnQueue } from "../../harness/queue.ts";
import { Agent, MemorySession, run } from "@openai/agents";
import type { SessionHarnessContext, SessionHarness } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.ts";

export function create(context: SessionHarnessContext): SessionHarness<SessionMessage, SessionEvent> {
  if (!context.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const agent = new Agent({
    name: "Cantelop OpenAI example",
    instructions: "You are a concise, helpful assistant.",
    model: context.env.OPENAI_MODEL ?? "gpt-5-mini",
  });
  const conversation = new MemorySession({ sessionId: context.session.id });
  const turns = new TurnQueue<SessionMessage, SessionEvent>(async (message, { signal, output }) => {
    const interruption = new AbortController();
    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
      result = await run(agent, message.prompt, {
        session: conversation,
        signal: AbortSignal.any([signal, context.signal, interruption.signal]),
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
      // A failed output handoff must stop and drain provider work before reuse.
      interruption.abort();
      await result?.completed.catch(() => undefined);
    }
  }, context.signal);
  return {
    queue: (message, work) => turns.enqueue(message, work),
    steer: (message, work) => turns.enqueue(message, work, true),
    cancel: () => turns.cancel(),
  };
}
