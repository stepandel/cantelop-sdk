import { Agent, run } from "@openai/agents";
import { createApp, createExecutionEnvironment } from "@cantelop/sdk";

interface Input {
  prompt: string;
}

interface Output {
  answer: string;
}

const agent = new Agent({
  name: "Cantelop OpenAI example",
  instructions: "You are a concise, helpful assistant.",
});

const execution = createExecutionEnvironment<Input, Output>(
  async ({ input, signal }) => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not configured. Copy .env.example to .env and add your key, or export it before starting the server.",
      );
    }

    const result = await run(agent, input.prompt, { signal });
    return { answer: result.finalOutput ?? "" };
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

export default app;
