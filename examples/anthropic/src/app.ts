import { query } from "@anthropic-ai/claude-agent-sdk";
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
