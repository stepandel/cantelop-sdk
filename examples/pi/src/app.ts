import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createApp, createExecutionEnvironment } from "@cantelop/sdk";

interface Input {
  prompt: string;
}

interface Output {
  answer: string;
}

const models = builtinModels();

const execution = createExecutionEnvironment<Input, Output>(
  async ({ input, signal }) => {
    const provider = process.env.PI_PROVIDER ?? "anthropic";
    const modelId = process.env.PI_MODEL ?? "claude-sonnet-4-6";
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
    });

    let answer = "";
    const unsubscribe = agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        answer += event.assistantMessageEvent.delta;
      }
    });
    const forwardAbort = () => agent.abort();
    signal.addEventListener("abort", forwardAbort, { once: true });

    try {
      await agent.prompt(input.prompt);
      return { answer };
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      unsubscribe();
    }
  },
);

const app = createApp({ execution });

app.route("GET", "/health", () =>
  Response.json({ status: "ok", runtime: "pi" }),
);

app.route("POST", "/execute", async ({ request, execution }) => {
  const input = (await request.json()) as Partial<Input>;

  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  const run = execution.start({ prompt: input.prompt }, { signal: request.signal });
  const output = await run.wait();

  return Response.json({ executionId: run.id, ...output });
});

export default app;
