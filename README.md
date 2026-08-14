# Cantelop SDK

## Install

Cantelop applications use the SDK from both their Edge API build and native
harness image:

```sh
pnpm add @cantelop/sdk@0.1.0-rc.8
```

The release candidate requires Node.js 22 or newer. Cantelop's CLI invokes the
project-installed `@cantelop/sdk/build`; it does not carry a second SDK copy.

A TypeScript SDK with separate surfaces for Edge API middleware and native
harness execution.

```text
Edge API  ->  Cantelop Session  ->  Linux-native harness VM
```

The API validates HTTP requests, dispatches executions, and returns results.
The harness owns agent and model behavior and can use the native Linux runtime.

## Edge API

Use `@cantelop/sdk/api` for API middleware. Cantelop injects the current App,
already authenticated and scoped by the platform. No API key or endpoint
configuration is required.

```ts
import { createRouter, defineApi } from "@cantelop/sdk/api";
import type { Input, Output } from "./contracts.js";

export default defineApi<Input, Output>(({ app }) => {
  const router = createRouter();

  router.route("POST", "/workspaces", async ({ request }) => {
    const { slug } = await request.json() as { slug: string };
    const workspace = await app.workspaces.create({ slug });
    return Response.json(workspace, { status: 201 });
  });

  router.route("POST", "/sessions", async ({ request }) => {
    const config = await request.json() as {
      workspaceId: string;
      keepAliveSeconds: number;
    };
    const session = await app.sessions.create(config);
    return Response.json({ sessionId: session.id }, { status: 201 });
  });

  router.route("POST", "/execute", async ({ request }) => {
    const { sessionId, input } = await request.json() as {
      sessionId: string;
      input: Input;
    };
    const session = app.sessions.connect(sessionId);
    return Response.json({
      output: await session.execute(input, { signal: request.signal }),
    });
  });

  return router;
});
```

Every execution belongs to a Session. A Session keeps its Sandbox warm for
`keepAliveSeconds` after work completes. If the Sandbox has already been
released, the platform can reactivate the same logical Session on a new
Sandbox. Explicitly terminating the Session makes it final:

```ts
await app.sessions.connect(sessionId).terminate();
```

Workspace creation takes a routing `slug`. The current App identity is derived
by the trusted bridge and cannot be supplied or overridden by application code.

API modules run in an Edge runtime. They may use standard ECMAScript and Web
Platform APIs such as `fetch`, `Request`, `Response`, Web Streams, abort
signals, and Web Crypto. They must not import the harness or depend on Node.js,
native modules, local processes, filesystem access, or deployment-provider
bindings. Cantelop supplies App variables and secrets through the
provider-neutral `env` context:

```ts
export default defineApi(({ app, env }) => {
  const token = env.API_TOKEN;
  // Define routes using token and the current App's capabilities.
});
```

All App variables and secrets are available to both the Edge API and native
harness. Edge code can therefore read and disclose any configured value;
applications should treat every API dependency and request path as trusted with
all App credentials. Cantelop-reserved bindings and provider capabilities are
not exposed through `env`.

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
and VM environment variables. Cantelop supplies the same App variables and
secrets to the harness VM and Edge API.

Cantelop's generated native bootstrap calls `serveHarness()` from
`@cantelop/sdk/harness`. It accepts no port argument: the runtime provider
injects `CANTELOP_INTERNAL_PORT` from the App's
`harness.runtime.internal_port`, which remains the single source of truth.

The user-defined harness function owns execution completion. Resolving its
returned value completes the execution successfully; throwing completes it as
failed, and settling after an abort completes cancellation handling. The native
adapter attests that settlement to Cantelop only after the function has settled.
Application events such as `{ type: "done" }` are ordinary user-defined stream
events and do not control the Sandbox lifecycle.

`createExecutionEnvironment()` is also exported from the harness surface for
running a harness in-process inside a VM or native test environment. Production
Edge APIs execute only through a Session injected as part of the current App.

## Events and direct streaming

Native harness executions expose application-defined events through standard
async iteration. Edge Session execution returns its final output and does not
expose those native event handles through the API runtime.

Applications that stream incremental output configure a direct connection from
the harness VM to the client. The VM-facing endpoint owns its protocol,
authentication, TLS, CORS, backpressure, and reconnect behavior. The Edge API
remains the control and non-streaming result plane.
The harness function must remain pending until any direct stream and associated
background work that belongs to the execution are complete.

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
