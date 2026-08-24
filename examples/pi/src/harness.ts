import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
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

const models = builtinModels();
let agent: Agent | undefined;

function sessionAgent(
  { session, env }: HarnessContext<PromptInput, RuntimeEvent>,
): Agent {
  if (agent !== undefined) return agent;

  const provider = env.PI_PROVIDER ?? "anthropic";
  const modelId = env.PI_MODEL ?? "claude-sonnet-4-6";
  const model = models.getModel(provider, modelId);

  if (!model) {
    throw new Error(`Pi model not found: ${provider}/${modelId}`);
  }

  agent = new Agent({
    initialState: {
      systemPrompt: "You are a concise, helpful assistant.",
      model,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: session.id,
  });
  return agent;
}

async function runTurn(
  context: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<AnswerOutput> {
  const { input, signal, emit } = context;
  const agent = sessionAgent(context);

  if (input.type === "steer") {
    agent.steer({
      role: "user",
      content: input.prompt,
      timestamp: Date.now(),
    });
    const output = { answer: "Steering accepted" };
    emit({ type: "done", output });
    return output;
  }

  let answer = "";
  const unsubscribe = agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const delta = event.assistantMessageEvent.delta;
      answer += delta;
      emit({ type: "text_delta", delta });
    }
  });
  const forwardAbort = () => agent.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });

  try {
    await agent.prompt(input.prompt);
    const output = { answer };
    emit({ type: "done", output });
    return output;
  } finally {
    signal.removeEventListener("abort", forwardAbort);
    unsubscribe();
  }
}

export default defineHarness<PromptInput, AnswerOutput, RuntimeEvent>({ run: runTurn });
