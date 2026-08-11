import { Agent, run } from "@openai/agents";
import {
  createApp,
  createExecutionEnvironment,
} from "@cantelop/sdk";
import { eventStreamResponse } from "../../shared/event-stream.js";

interface Input {
  prompt: string;
}

interface Output {
  answer: string;
}

type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: Output };

const agent = new Agent({
  name: "Cantelop OpenAI example",
  instructions: "You are a concise, helpful assistant.",
});

const execution = createExecutionEnvironment<Input, Output, RuntimeEvent>(
  async ({ input, signal, emit }) => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not configured. Copy .env.example to .env and add your key, or export it before starting the server.",
      );
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

const app = createApp({ execution });

app.route("GET", "/health", () =>
  Response.json({
    status: "ok",
    runtime: "openai",
    configured: Boolean(process.env.OPENAI_API_KEY),
  }),
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

export default app;
