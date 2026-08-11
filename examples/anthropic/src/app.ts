import { query } from "@anthropic-ai/claude-agent-sdk";
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

const execution = createExecutionEnvironment<Input, Output, RuntimeEvent>(
  async ({ input, signal, emit }) => {
    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });

    try {
      for await (const message of query({
        prompt: input.prompt,
        options: {
          abortController,
          includePartialMessages: true,
          systemPrompt: "You are a concise, helpful assistant.",
          maxTurns: 10,
        },
      })) {
        if (
          message.type === "stream_event" &&
          message.event.type === "content_block_delta" &&
          message.event.delta.type === "text_delta"
        ) {
          emit({ type: "text_delta", delta: message.event.delta.text });
        }
        if (message.type === "result" && "result" in message) {
          const output = { answer: message.result };
          emit({ type: "done", output });
          return output;
        }
      }
    } finally {
      signal.removeEventListener("abort", forwardAbort);
    }

    throw new Error("Claude Agent SDK completed without a result");
  },
);

const app = createApp({ execution });

app.route("GET", "/health", () =>
  Response.json({ status: "ok", runtime: "anthropic" }),
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
