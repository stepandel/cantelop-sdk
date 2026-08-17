import { Agent, run } from "@openai/agents";
import { defineHarness } from "@cantelop/sdk/harness";
import type {
  AnswerOutput,
  PromptInput,
} from "./contracts.js";

type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: AnswerOutput };

export default defineHarness<PromptInput, AnswerOutput, RuntimeEvent>(
  async ({ input, env, signal, emit }) => {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured in the harness VM");
    }
    const agent = new Agent({
      name: "Cantelop OpenAI example",
      instructions: "You are a concise, helpful assistant.",
      model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
    });

    const stream = await run(agent, input.prompt, { stream: true, signal });
    let answer = "";

    for await (const delta of stream.toTextStream()) {
      answer += delta;
      emit({ type: "text_delta", delta });
    }
    await stream.completed;

    const output = { answer: stream.finalOutput ?? answer };
    emit({ type: "done", output });
    return output;
  },
);
