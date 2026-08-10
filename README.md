# Cantelop SDK

A minimal TypeScript SDK for exposing routes that launch an opaque harness runtime.

```ts
import { createApp, createExecutionEnvironment } from "@cantelop/sdk";

type Input = { prompt: string };
type Output = { answer: string };

const execution = createExecutionEnvironment<Input, Output>(
  async ({ input, signal }) => {
    // Call OpenAI, Anthropic, Pi, a subprocess, or any other harness here.
    return runHarness(input, { signal });
  },
);

const app = createApp({ execution });

app.route("POST", "/execute", async ({ request, execution }) => {
  const input = (await request.json()) as Input;
  const run = execution.start(input);

  return Response.json({
    executionId: run.id,
    output: await run.wait(),
  });
});

export default app;
```

Register several routes at once with `app.routes([...])`. Pass a Web-standard
`Request` to `app.handle(request)` from the server adapter of your choice.

The SDK intentionally does not define agents, models, tools, workflows, or VM
providers. `HarnessRuntime` is the boundary between Cantelop and user-owned
runtime behavior.
