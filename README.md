# Cantelop SDK

## Install

Cantelop applications use the SDK from both their Edge API build and native
harness image:

```sh
pnpm add @cantelop/sdk@0.1.0-rc.3
```

The release candidate requires Node.js 22 or newer. Cantelop's CLI invokes the
project-installed `@cantelop/sdk/build`; it does not carry a second SDK copy.

A TypeScript SDK with separate surfaces for Edge API middleware and native
harness execution.

```text
Edge API  ->  Cantelop execution transport  ->  Linux-native harness VM
```

The API validates HTTP requests, dispatches executions, and returns results.
The harness owns agent and model behavior and can use the native Linux runtime.

## Edge API

Use `@cantelop/sdk/api` for API middleware. Cantelop injects a remote execution
environment when it creates the API definition.

```ts
import { createApp, defineApi } from "@cantelop/sdk/api";
import type { Input, Output } from "./contracts.js";

export default defineApi<Input, Output>(({ execution }) => {
  const app = createApp({
    execution: execution.forEnvironment(
      "env_0123456789abcdef0123456789abcdef",
    ),
  });

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

Cantelop's deployment builder wraps the default API definition with
`createApiWorker()` from `@cantelop/sdk/edge`. This generated bootstrap is a
standard module Worker entrypoint; customer API source remains independent of
Cloudflare bindings and deployment configuration.

The provider-neutral build surface is available from `@cantelop/sdk/build`:

```ts
import { buildApi } from "@cantelop/sdk/build";

await buildApi({
  entrypoint: "./src/api.ts",
  outdir: "./dist/cantelop-api",
});
```

It emits a bundled `worker.mjs`, source map, and `cantelop-api.json`
manifest. Upload credentials and provider-specific deployment settings remain
the responsibility of Cantelop's API-provider adapter.

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

Cantelop's generated native bootstrap calls `serveHarness()` from
`@cantelop/sdk/harness`. It accepts no port argument: the runtime provider
injects `CANTELOP_INTERNAL_PORT` from the App's
`harness.runtime.internal_port`, which remains the single source of truth.

`createExecutionEnvironment()` is also exported from the harness surface for
running a harness in-process inside a VM or native test environment. Production
Edge APIs receive a remote `ExecutionEnvironment` implementation from
Cantelop's transport layer.

## Events and direct streaming

Native harness executions expose application-defined events through standard
async iteration. Edge `Execution` handles deliberately do not expose those
events and Cantelop does not proxy them through the API runtime.

Applications that stream incremental output configure a direct connection from
the harness VM to the client. The VM-facing endpoint owns its protocol,
authentication, TLS, CORS, backpressure, and reconnect behavior. The Edge API
remains the control and non-streaming result plane.

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
pnpm check:package
```

`check:package` packs the exact npm artifact, rejects leaked development files,
installs it into an empty project, imports every public entrypoint, and builds a
customer API. See [`docs/releasing.md`](./docs/releasing.md) for the release
boundary. Publishing is a separate production operation.
