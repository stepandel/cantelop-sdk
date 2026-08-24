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
const sessions = new Map<string, Agent>();

function sessionAgent(
  { session, env }: HarnessContext<PromptInput, RuntimeEvent>,
): Agent {
  const existing = sessions.get(session.id);
  if (existing !== undefined) return existing;

  const provider = env.PI_PROVIDER ?? "anthropic";
  const modelId = env.PI_MODEL ?? "claude-sonnet-4-6";
  const model = models.getModel(provider, modelId);

  if (!model) {
    throw new Error(`Pi model not found: ${provider}/${modelId}`);
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a concise, helpful assistant.",
      model,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: session.id,
  });
  sessions.set(session.id, agent);
  return agent;
}

async function runTurn(
  context: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<AnswerOutput> {
  const { input, signal, emit } = context;
  const agent = sessionAgent(context);

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

async function steerTurn(
  context: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<AnswerOutput> {
  const agent = sessions.get(context.session.id);
  if (agent === undefined) throw new Error("Cannot steer a Session without an active agent");
  agent.steer({
    role: "user",
    content: context.input.prompt,
    timestamp: Date.now(),
  });
  const output = { answer: "Steering accepted" };
  context.emit({ type: "done", output });
  return output;
}

export default defineHarness<PromptInput, AnswerOutput, RuntimeEvent>({
  run: runTurn,
  steer: steerTurn,
});
