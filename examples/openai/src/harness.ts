import { Agent, run } from "@openai/agents";
import { defineHarness } from "@cantelop/sdk/harness";
import type {
  AnswerOutput,
  PromptInput,
  RuntimeEvent,
} from "../../shared/contracts.js";

const agent = new Agent({
  name: "Cantelop OpenAI example",
  instructions: "You are a concise, helpful assistant.",
});

export default defineHarness<PromptInput, AnswerOutput, RuntimeEvent>(
  async ({ input, env, signal, emit }) => {
    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured in the harness VM");
    }

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
