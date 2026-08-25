import { Agent, MemorySession, run } from "@openai/agents";
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

let providerSession: MemorySession | undefined;

async function runTurn(
  { session, message, env, emit }: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<void> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured in the harness VM");
  }
  const agent = new Agent({
    name: "Cantelop OpenAI example",
    instructions: "You are a concise, helpful assistant.",
    model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
  });
  if (providerSession === undefined) {
    providerSession = new MemorySession({ sessionId: session.id });
  }

  const stream = await run(agent, message.payload.prompt, {
    stream: true,
    session: providerSession,
  });
  let answer = "";

  for await (const delta of stream.toTextStream()) {
    answer += delta;
    emit({ type: "text_delta", delta });
  }
  await stream.completed;

  const output = { answer: stream.finalOutput ?? answer };
  emit({ type: "done", output });
}

// Input meaning is application-owned. Both messages and steer requests become
// turns in the same MemorySession here and are processed in FIFO order.
export default defineHarness<PromptInput, RuntimeEvent>({ receive: runTurn });
