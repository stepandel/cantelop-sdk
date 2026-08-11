# Cantelop SDK

An Edge-native TypeScript SDK for exposing routes that launch an opaque harness
runtime.

```ts
import { createApp, createExecutionEnvironment } from "@cantelop/sdk";

type Input = { prompt: string };
type Output = { answer: string };

const execution = createExecutionEnvironment<Input, Output>(
  async ({ input, signal }) => {
    signal.throwIfAborted();
    return runHarness(input, { signal });
  },
);

const app = createApp({ execution });

app.route("POST", "/execute", async ({ request, execution }) => {
  const input = (await request.json()) as Input;
  const run = execution.start(input, { signal: request.signal });

  return Response.json({
    executionId: run.id,
    output: await run.wait(),
  });
});

export default app;
```

Cantelop owns the deployment adapter. Applications use Web-standard `Request`,
`Response`, streams, abort signals, and Web Crypto without depending on the
underlying hosting provider.

## Runtime contract

Harnesses run in an Edge runtime. They may use standard ECMAScript and supported
Web Platform APIs, including:

- `fetch`, `Request`, and `Response`
- Web Streams
- `AbortController` and `AbortSignal`
- Web Crypto
- SDK-provided capabilities

Harnesses must not depend on:

- Node.js built-ins such as `fs`, `child_process`, `net`, or `http`
- `process`, `Buffer`, native modules, or executable binaries
- a persistent local filesystem
- listening on ports or creating servers
- global mutable state surviving between requests
- work continuing after its request or response stream ends
- deployment-provider APIs or bindings

Secrets, storage, and other infrastructure are unavailable unless Cantelop
exposes them through an explicit provider-neutral capability.

Executions are request-scoped. A route can await the final result or keep the
request active with a streaming response. Durable, detached, or resumable jobs
require a separate Cantelop capability.

## Events and streaming

Harness runtimes can emit application-defined events:

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

Executions expose events through standard async iteration. The application owns
their HTTP representation, such as SSE or newline-delimited JSON.

See [`examples/edge`](./examples/edge) for complete JSON and streaming routes.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm check:examples
```

The SDK build is checked for Node.js imports and globals before tests pass.
