import { query } from "@anthropic-ai/claude-agent-sdk";
import { createApp, createExecutionEnvironment } from "@cantelop/sdk";

interface Input {
  prompt: string;
}

interface Output {
  answer: string;
}

const execution = createExecutionEnvironment<Input, Output>(
  async ({ input, signal }) => {
    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", forwardAbort, { once: true });

    try {
      for await (const message of query({
        prompt: input.prompt,
        options: {
          abortController,
          systemPrompt: "You are a concise, helpful assistant.",
          maxTurns: 10,
        },
      })) {
        if (message.type === "result" && "result" in message) {
          return { answer: message.result };
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

export default app;
