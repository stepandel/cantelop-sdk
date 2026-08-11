# Cantelop SDK

A TypeScript SDK with separate surfaces for Edge API middleware and native
harness execution.

```text
Edge API  ->  Cantelop execution transport  ->  Linux-native harness VM
```

The API validates HTTP requests, dispatches executions, and streams results.
The harness owns agent and model behavior and can use the native Linux runtime.

## Edge API

Use `@cantelop/sdk/api` for API middleware. Cantelop injects a remote execution
environment when it creates the API definition.

```ts
import { createApp, defineApi } from "@cantelop/sdk/api";
import type { Input, Output, RuntimeEvent } from "./contracts.js";

export default defineApi<Input, Output, RuntimeEvent>(({ execution }) => {
  const app = createApp({ execution });

  app.route("POST", "/execute", async ({ request, execution }) => {
    const input = (await request.json()) as Input;
    const run = await execution.start(input, { signal: request.signal });

    return Response.json({
      executionId: run.id,
      output: await run.wait(),
    });
  });

  return app;
});
```

API modules run in an Edge runtime. They may use standard ECMAScript and Web
Platform APIs such as `fetch`, `Request`, `Response`, Web Streams, abort
signals, and Web Crypto. They must not import the harness or depend on Node.js,
provider SDKs, native modules, local processes, filesystem access, secrets, or
deployment-provider bindings.

## Native harness

Use `@cantelop/sdk/harness` for the harness entrypoint that runs inside the
Linux VM.

```ts
import { defineHarness } from "@cantelop/sdk/harness";
import type { Input, Output, RuntimeEvent } from "./contracts.js";

export default defineHarness<Input, Output, RuntimeEvent>(
  async ({ input, env, signal, emit }) => {
    const output = await runAgent(input, {
      apiKey: env.MODEL_API_KEY,
      signal,
      onText: (delta) => emit({ type: "text_delta", delta }),
    });

    emit({ type: "done", output });
    return output;
  },
);
```

Harnesses may use Node.js, subprocesses, the Linux filesystem, provider SDKs,
and VM environment variables. Cantelop supplies secrets and configuration to
the harness VM, not to the Edge API.

`createExecutionEnvironment()` is also exported from the harness surface for
running a harness in-process inside a VM or native test environment. Production
Edge APIs receive a remote `ExecutionEnvironment` implementation from
Cantelop's transport layer.

## Events and streaming

Executions expose application-defined events through standard async iteration.
The API owns their HTTP representation, such as server-sent events or
newline-delimited JSON. A streaming API keeps the Edge request connected while
the harness runs remotely.

## Examples

Each provider example contains two independently checked entrypoints:

- [`examples/openai`](./examples/openai)
- [`examples/anthropic`](./examples/anthropic)
- [`examples/pi`](./examples/pi)

In every example, `src/api.ts` is Edge-only and `src/harness.ts` is native.

## Development

```bash
pnpm install
pnpm check
pnpm test
pnpm check:examples
```
