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
const ACTIVE_AGENT_TASK = "agent";
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
): Promise<void> {
  const { payload } = context.message;
  const { emit, tasks } = context;

  if (payload.type === "cancel") {
    tasks.cancel(ACTIVE_AGENT_TASK);
    return;
  }

  const agent = sessionAgent(context);

  if (payload.type === "steer") {
    if (!tasks.has(ACTIVE_AGENT_TASK)) {
      throw new Error("No active agent task to steer");
    }
    agent.steer({
      role: "user",
      content: payload.prompt,
      timestamp: Date.now(),
    });
    const output = { answer: "Steering accepted" };
    emit({ type: "done", output });
    return;
  }

  if (tasks.has(ACTIVE_AGENT_TASK)) {
    throw new Error("An agent task is already active");
  }

  tasks.start(ACTIVE_AGENT_TASK, async ({ signal }) => {
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
    const abort = () => agent.abort();
    signal.addEventListener("abort", abort, { once: true });

    try {
      await agent.prompt(payload.prompt);
      const output = { answer };
      emit({ type: "done", output });
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }
  });
}

export default defineHarness<PromptInput, RuntimeEvent>({ receive: runTurn });
