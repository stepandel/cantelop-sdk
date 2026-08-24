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
  { session, input, env, signal, emit }: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<AnswerOutput> {
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

  const stream = await run(agent, input.prompt, {
    stream: true,
    signal,
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
  return output;
}

async function steerTurn(
  context: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<AnswerOutput> {
  // The Agents SDK models a steer as another turn in the same MemorySession.
  return runTurn(context);
}

export default defineHarness<PromptInput, AnswerOutput, RuntimeEvent>({
  run: runTurn,
  steer: steerTurn,
});
