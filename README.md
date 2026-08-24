# Cantelop SDK

## Install

Cantelop applications use the SDK from both their Edge API build and native
harness image:

```sh
pnpm add @cantelop/sdk@0.2.0
```

The SDK requires Node.js 22 or newer. Cantelop's CLI invokes the
project-installed `@cantelop/sdk/build`; it does not carry a second SDK copy.

## Initialize a project

After creating an App, generate the deployment manifest from its slug:

```sh
cantelop init -app vera
```

This creates the minimal `cantelop.json` and refuses to overwrite an existing
file:

```json
{
  "$schema": "https://raw.githubusercontent.com/stepandel/cantelop-sdk/main/schemas/app-v1.json",
  "app": "vera",
  "api": "src/api.ts",
  "harness": "src/harness.ts"
}
```

The schema URL enables completion, validation, and field documentation in JSON
Schema-aware editors. It also identifies the configuration format version, so
there is no separate version field. `app` is the exact human-readable slug of
an existing App; generated `app_...` IDs do not belong in project source. Use
the command's `-config`, `-api`, and `-harness` flags for non-default paths. Add
an expanded harness object with `context` and `dockerfile` only when native
dependencies or system tools require a custom image.

Declare configuration requirements by name without committing production
values:

```json
"environment": {
  "OPENAI_MODEL": { "default": "gpt-4.1-mini" },
  "OPENAI_API_KEY": { "secret": true, "required": true }
}
```

`secret` and `required` default to `false`. Non-secret `default` values seed
`cantelop dev` and are overridden by `.env`; they are not copied into the
production App. `cantelop doctor` verifies every entry marked `required`
against that App's redacted configuration. Secret declarations cannot contain
defaults, and `CANTELOP_*` names are reserved by the runtime.

The canonical schema is owned by the Cantelop CLI/platform. This public
repository mirrors it at `schemas/app-v1.json` so JSON Schema-aware editors can
load it without platform credentials. The provider examples each include a
complete manifest that points to that public mirror.

A TypeScript SDK with separate surfaces for Edge API middleware and native
harness execution.

```text
Edge API  ->  Cantelop Session  ->  Linux-native harness VM
```

The API validates HTTP requests, dispatches executions, and returns results.
The harness owns agent and model behavior and can use the native Linux runtime.

## Edge API

Use `@cantelop/sdk/api` for API middleware. Cantelop injects the current App and
root router. The App is already authenticated and scoped by the platform; no
API key, endpoint configuration, or router construction is required.

```ts
import { defineApi } from "@cantelop/sdk/api";
import type { Input, Output } from "./contracts.js";

export default defineApi<Input, Output>(({ app, router }) => {
  router.route("POST", "/workspaces", async ({ request }) => {
    const { slug } = await request.json() as { slug: string };
    const workspace = await app.workspaces.create({ slug });
    return Response.json(workspace, { status: 201 });
  });

  router.route("POST", "/execute", async ({ request }) => {
    const body = await request.json() as {
      sessionId?: string;
      workspaceId: string;
      keepAliveSeconds: number;
      input: Input;
    };
    const session = app.sessions.open({
      ...(body.sessionId === undefined ? {} : { id: body.sessionId }),
      workspaceId: body.workspaceId,
      keepAliveSeconds: body.keepAliveSeconds,
    });
    return Response.json({
      sessionId: session.id,
      output: await session.execute(body.input, { signal: request.signal }),
    });
  });
});
```

Every execution belongs to a Session. `app.sessions.open()` creates a local
Session handle without making a request. The first `execute()`, `dispatch()`,
or `steer()` atomically creates the logical Session if its ID does not exist and
starts the operation; otherwise it resumes that Session. Omitting `id`
generates one in the SDK, which is immediately available as `session.id`.

`Session` is the canonical read-only identity and configuration shared with the
native harness. `SessionHandle<Input, Output>` extends it with Edge operations.
Its `id`, `workspaceId`, and `keepAliveSeconds` properties are available before
the first request.

A Session keeps its Sandbox warm for `keepAliveSeconds` after work completes.
If the Sandbox has already been released, the platform can reactivate the same
logical Session on a new Sandbox. Explicitly terminating the Session makes it
final:

```ts
await app.sessions.open({ id: sessionId, workspaceId, keepAliveSeconds: 0 }).terminate();
```

Distributed API workers converge on one Session by opening the same
application-defined ID:

```ts
const session = app.sessions.open({
  id: "telegram",
  workspaceId,
  keepAliveSeconds: 300,
});
```

Existing Workspaces remain addressable by their App-scoped slug:

```ts
const workspace = await app.workspaces.open({ slug: "production" });
```

`workspaceId` and `keepAliveSeconds` are always required when opening a Session,
so its Workspace and Sandbox lifetime remain explicit caller decisions.

The Session ID is immutable and App-scoped. Its Workspace is fixed when the
first execution creates it, while `keepAliveSeconds` applies to each operation.
Opening an existing ID against a different Workspace conflicts. Termination is
still final; use a new ID for a distinct logical Session.

Webhook handlers that must acknowledge before a Sandbox can start can dispatch
the execution asynchronously. Cantelop durably accepts the input before the
promise resolves, then opens the Session and runs the harness in the
background:

```ts
router.route("POST", "/github", async ({ request }) => {
  const event = await request.json() as Input;
  const session = app.sessions.open({
    id: "github:repository",
    workspaceId,
    keepAliveSeconds: 300,
  });
  const receipt = await session.dispatch(event);
  return Response.json({ accepted: true, executionId: receipt.id }, {
    status: 202,
  });
});
```

The execution ID and its retry identity are generated by the SDK. Application
code cannot provide or override an idempotency key. The returned receipt means
the platform has accepted responsibility for dispatch; it does not contain the
eventual harness output. Dispatch is at-least-once across a gateway crash: a
harness doing non-idempotent external work should deduplicate with the
read-only `execution.id` in its `HarnessContext`. Use ordinary
`session.execute()` when the HTTP caller needs the output synchronously.

Workspace creation takes a routing `slug`. The current App identity is derived
by the trusted bridge and cannot be supplied or overridden by application code.

API modules run in an Edge runtime. They may use standard ECMAScript and Web
Platform APIs such as `fetch`, `Request`, `Response`, Web Streams, abort
signals, and Web Crypto. They must not import the harness or depend on Node.js,
native modules, local processes, filesystem access, or deployment-provider
bindings. Cantelop supplies App variables and secrets through the
provider-neutral `env` context:

```ts
export default defineApi(({ app, env, router }) => {
  const token = env.API_TOKEN;
  router.route("GET", "/token-status", () =>
    Response.json({ configured: token !== undefined }),
  );
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

Cantelop's local runner uses `buildLocalApi()` to generate the same
provider-neutral Worker with one development-only difference: SDK Workspace
and Session requests are redirected to a numeric loopback bridge. The bridge
origin must use plain HTTP on `127.0.0.1` or `[::1]`; public `fetch()` calls made
by application code are unaffected.

```ts
import { buildLocalApi } from "@cantelop/sdk/build";

await buildLocalApi({
  entrypoint: "./src/api.ts",
  outdir: "./dist/cantelop-local-api",
  runtimeOrigin: "http://127.0.0.1:43123",
});
```

Application projects normally use this through `cantelop dev` rather than
calling it directly. The CLI uses `watchLocalProject()` for native development;
it keeps esbuild contexts for the API and harness alive, rebuilds only affected
dependency graphs, and reports successful or failed component rebuilds through
its callback. `cantelop dev --container` uses the one-shot builders for Docker
parity mode.

CLI compatibility is explicit: `@cantelop/sdk/build` exports
`CANTELOP_CLI_BUILD_PROTOCOL_VERSION` alongside the one-shot and watch build
functions. Current CLIs require protocol version `1`, first packaged in
`@cantelop/sdk@0.1.0-rc.15`. `cantelop doctor` reports older or incomplete
project installations before a build is attempted.

## Native harness

Use `@cantelop/sdk/harness` for the harness entrypoint that runs inside the
Linux VM.

```ts
import { defineHarness } from "@cantelop/sdk/harness";
import type { Input, Output, RuntimeEvent } from "./contracts.js";

export default defineHarness<Input, Output, RuntimeEvent>(
  async ({ execution, session, input, env, signal, emit }) => {
    const output = await runAgent(input, {
      executionId: execution.id,
      sessionId: session.id,
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

Every harness invocation receives the same canonical Session snapshot exposed
by its Edge `SessionHandle`: `session.id`, `session.workspaceId`, and the
operation's `session.keepAliveSeconds`. `execution.id` is the distinct retry
identity, while `execution.kind` is either `"execute"` or `"steer"`. These
objects are frozen and constructed by the trusted runtime rather than copied
from an application request.

The canonical Session lets a harness key provider state consistently, but it
does not serialize arbitrary in-memory objects. Module-level agents,
conversation stores, and provider resume handles survive while the Sandbox is
warm. Applications that must resume after Sandbox replacement must persist the
provider's resumable state outside process memory.

Each harness runtime and Sandbox is bound to exactly one Session identity.
Provider state can therefore be held as one module-level value; a per-Session
map is unnecessary. The native adapter rejects any request for a different
Session ID or Workspace rather than mixing tenants inside one harness process.

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

`createHarnessExecutor()` is also exported from the harness surface for
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
