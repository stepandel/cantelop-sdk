import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createApp,
  createExecutionEnvironment,
  eventStreamResponse,
} from "@cantelop/sdk";

interface Input {
  prompt: string;
}

interface Output {
  answer: string;
}

type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: Output };

const models = builtinModels();

const execution = createExecutionEnvironment<Input, Output, RuntimeEvent>(
  async ({ input, signal, emit }) => {
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

app.route("POST", "/execute/stream", async ({ request, execution }) => {
  const input = (await request.json()) as Partial<Input>;
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  const run = execution.start(
    { prompt: input.prompt },
    { signal: request.signal },
  );
  return eventStreamResponse(run.events(), {
    eventName: (event) => event.type,
    headers: { "x-execution-id": run.id },
  });
});

app.websocket("/execute", async ({ socket, execution }) => {
  for await (const message of socket.messages()) {
    try {
      const text =
        typeof message === "string" ? message : new TextDecoder().decode(message);
      const input = JSON.parse(text) as Partial<Input>;
      if (typeof input.prompt !== "string" || input.prompt.length === 0) {
        throw new Error("prompt is required");
      }

      const run = execution.start(
        { prompt: input.prompt },
        { signal: socket.signal },
      );
      await socket.send(
        JSON.stringify({ type: "started", executionId: run.id }),
      );
      for await (const event of run.events()) {
        await socket.send(JSON.stringify({ executionId: run.id, ...event }));
      }
    } catch (error) {
      if (socket.signal.aborted) return;
      await socket.send(
        JSON.stringify({
          type: "error",
          message: error instanceof Error ? error.message : "Execution failed",
        }),
      );
    }
  }
});

export default app;
