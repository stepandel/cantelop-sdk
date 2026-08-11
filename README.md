# Cantelop SDK

A minimal TypeScript SDK for exposing routes that launch an opaque harness runtime.

```ts
import {
  createApp,
  createExecutionEnvironment,
  eventStreamResponse,
} from "@cantelop/sdk";

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

Harness runtimes can emit any application-defined event type. Executions expose
those events as an async stream:

```ts
type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: Output };

const execution = createExecutionEnvironment<Input, Output, RuntimeEvent>(
  async ({ input, signal, emit }) => {
    const output = await runHarness(input, {
      signal,
      onText: (delta) => emit({ type: "text_delta", delta }),
    });
    emit({ type: "done", output });
    return output;
  },
);
```

Return the events as server-sent events from a normal route:

```ts
app.route("POST", "/execute/stream", async ({ request, execution }) => {
  const run = execution.start((await request.json()) as Input, {
    signal: request.signal,
  });
  return eventStreamResponse(run.events(), {
    eventName: (event) => event.type,
    headers: { "x-execution-id": run.id },
  });
});
```

Or register a WebSocket route:

```ts
app.websocket("/execute", async ({ socket, execution }) => {
  for await (const message of socket.messages()) {
    const input = JSON.parse(String(message)) as Input;
    const run = execution.start(input, { signal: socket.signal });
    for await (const event of run.events()) {
      await socket.send(JSON.stringify(event));
    }
  }
});
```

The Node adapter preserves streaming response bodies and handles WebSocket
upgrades:

```ts
import { serve } from "@cantelop/sdk/node";

serve(app, { port: 3000 });
```

Register several routes at once with `app.routes([...])`. Pass a Web-standard
`Request` to `app.handle(request)` from the server adapter of your choice.

The SDK intentionally does not define agents, models, tools, workflows, or VM
providers. `HarnessRuntime` is the boundary between Cantelop and user-owned
runtime behavior.

## Run the examples locally

Install all workspace dependencies once from the repository root:

```bash
npm install
```

Create the local environment file for the example you want to run:

```bash
cp examples/openai/.env.example examples/openai/.env
# Edit examples/openai/.env and add OPENAI_API_KEY.
```

Then start its server from the repository root:

```bash
# OpenAI — http://localhost:3000
npm run dev:openai

# Anthropic — http://localhost:3001
cp examples/anthropic/.env.example examples/anthropic/.env
npm run dev:anthropic

# Pi — http://localhost:3002
cp examples/pi/.env.example examples/pi/.env
npm run dev:pi
```

Edit each copied `.env` before starting its server. Exported shell variables are
also supported and take precedence over values loaded from `.env`.

Each server has a credential-free health check:

```bash
curl http://localhost:3000/health
```

Create an execution with:

```bash
curl http://localhost:3000/execute \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about ephemeral VMs"}'
```

Stream an execution with SSE:

```bash
curl -N http://localhost:3000/execute/stream \
  -H 'content-type: application/json' \
  -d '{"prompt":"Write a haiku about ephemeral VMs"}'
```

Each example also accepts WebSocket connections at `ws://localhost:<port>/execute`.
Send a JSON message containing a `prompt` and the socket will receive `started`,
`text_delta`, and `done` messages.

Use the matching port for the Anthropic or Pi example. The `start:*` commands
run the same servers without file watching.
