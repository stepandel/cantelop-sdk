import {
  createApp,
  createExecutionEnvironment,
} from "@cantelop/sdk";
import { eventStreamResponse } from "./event-stream.js";

interface Input {
  prompt: string;
}

interface Output {
  answer: string;
}

type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: Output };

const execution = createExecutionEnvironment<Input, Output, RuntimeEvent>(
  async ({ input, signal, emit }) => {
    signal.throwIfAborted();

    const answer = `Received: ${input.prompt}`;
    emit({ type: "text_delta", delta: answer });

    const output = { answer };
    emit({ type: "done", output });
    return output;
  },
);

const app = createApp({ execution });

app.route("GET", "/health", () => Response.json({ status: "ok" }));

app.route("POST", "/execute", async ({ request, execution }) => {
  const input = (await request.json()) as Partial<Input>;
  if (typeof input.prompt !== "string" || input.prompt.length === 0) {
    return Response.json({ error: "prompt is required" }, { status: 400 });
  }

  const run = execution.start(
    { prompt: input.prompt },
    { signal: request.signal },
  );

  return Response.json({ executionId: run.id, ...(await run.wait()) });
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

  return eventStreamResponse(run.events());
});

export default app;
