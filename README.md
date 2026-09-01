# Cantelop SDK

## Install

Cantelop applications use the SDK from both their Edge API build and native
Session runtime image:

```sh
pnpm add @cantelop/sdk@0.5.0
```

The SDK requires Node.js 22 or newer. Cantelop's CLI invokes the
project-installed `@cantelop/sdk/build`; it does not carry a second SDK copy.

## Initialize a project

After creating an App, generate the deployment manifest from its slug:

```sh
cantelop init -app vera -provider openai
```

This creates `cantelop.json`, `src/api.ts`, `src/session.ts`, and `package.json`,
and refuses to overwrite existing project files:

```json
{
  "app": "vera",
  "api": "src/api.ts",
  "session": "src/session.ts"
}
```

The CLI owns parsing, validation, and compatibility for this file; applications
do not select a schema or tie the manifest format to their installed SDK
version. `app` is the exact human-readable slug of an existing App; generated
`app_...` IDs do not belong in project source. Use `-config` and `-api` for
non-default paths. The required `-provider` selects the generated agent starter.
Add an expanded `session` object with `context` and `dockerfile` only when native
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
load it without platform credentials. Editor integrations can associate it with
`cantelop.json` by filename; applications do not need to include the schema URL
in their manifests.

A TypeScript SDK with separate surfaces for Edge API middleware and native
Session behaviour.

```text
Edge API  ->  Cantelop Session  ->  Linux-native Session runtime
```

The API validates HTTP requests, dispatches messages, and returns accepted
message references.
Session behaviour owns agent and model behavior and can use the native Linux
runtime. An App deploys one Session behaviour, which governs every Session opened
for that App.

## Edge API

Use `@cantelop/sdk/api` for API middleware. Cantelop injects the current App and
root router. The App is already authenticated and scoped by the platform; no
API key, endpoint configuration, or router construction is required.

```ts
import { defineApi } from "@cantelop/sdk/api";
import type { Input } from "./contracts.js";

export default defineApi<Input>(({ app, router }) => {
  router.route("POST", "/workspaces", async ({ request }) => {
    const { slug } = await request.json() as { slug: string };
    const workspace = await app.workspaces.create({ slug });
    return Response.json(workspace, { status: 201 });
  });

  router.route("POST", "/dispatch", async ({ request }) => {
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
    const message = await session.dispatch(body.input);
    return Response.json({
      sessionId: session.id,
      message,
    }, { status: 202 });
  });
});
```

Every message belongs to a Session. `app.sessions.open()` creates a local
reference to the Session actor without making a request. The first `dispatch()` atomically
creates the logical Session if its ID does not exist and accepts the message for delivery;
otherwise it resumes that Session. Omitting `id`
generates one in the SDK, which is immediately available as `session.id`.

`Session<Message>` is the actor reference: it exposes immutable identity and
configuration together with `dispatch()` and `terminate()`. Its `id`,
`workspaceId`, and `keepAliveSeconds` properties are available before the first
request. Native Session behaviour receives the same values as a read-only
`SessionIdentity`.

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
first message creates it, while `keepAliveSeconds` applies to each request.
Opening an existing ID against a different Workspace conflicts. Termination is
still final; use a new ID for a distinct logical Session.

Webhook handlers can dispatch a message asynchronously and acknowledge after
the platform accepts it for delivery:

```ts
router.route("POST", "/github", async ({ request }) => {
  const event = await request.json() as Input;
  const session = app.sessions.open({
    id: "github:repository",
    workspaceId,
    keepAliveSeconds: 300,
  });
  const message = await session.dispatch(event);
  return Response.json({ accepted: true, messageId: message.id }, {
    status: 202,
  });
});
```

`dispatch()` resolves to a `MessageRef` once the platform accepts the message.
The reference starts in `accepted` state and can be queried without blocking on
the actor:

```ts
const message = await session.dispatch(event);
const status = await message.status();

switch (status.state) {
  case "accepted":
  case "handling":
  case "handled":
  case "failed":
  case "unknown":
    break;
}
```

`accepted` is intentionally not a delivery guarantee: this stage uses a
volatile in-memory mailbox. `unknown` means the platform no longer has status
for that message. `failed` exposes a stable error code, not private runtime
error text.

The message ID is generated by the SDK. The platform must preserve that ID
when it retries delivery to the active Session runtime. Within one activation,
duplicate deliveries of the same message ID share the original in-flight or
completed result instead of invoking the Session behaviour again. Calling `dispatch()` a
second time creates a new logical message with a new message ID.

The mailbox and its deduplication records are intentionally in memory. Messages
are processed one at a time in acceptance order, but a runtime crash or Session
reactivation loses queued messages and completed deduplication records. The
message reference therefore confirms volatile acceptance, not durable persistence,
and does not contain the eventual Session output. IDs also cannot make arbitrary
external side effects exactly-once.

Workspace creation takes a routing `slug`. The current App identity is derived
by the trusted bridge and cannot be supplied or overridden by application code.

API modules run in an Edge runtime. They may use standard ECMAScript and Web
Platform APIs such as `fetch`, `Request`, `Response`, Web Streams, abort
signals, and Web Crypto. They must not import Session behaviour or depend on Node.js,
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
Session runtime. Edge code can therefore read and disclose any configured value;
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
it keeps esbuild contexts for the API and Session runtime alive, rebuilds only affected
dependency graphs, and reports successful or failed component rebuilds through
its callback. `cantelop dev --container` uses the one-shot builders for Docker
parity mode.

CLI compatibility is explicit: `@cantelop/sdk/build` exports
`CANTELOP_CLI_BUILD_PROTOCOL_VERSION` alongside the one-shot and watch build
functions. Current CLIs require protocol version `3`, packaged in
`@cantelop/sdk@0.5.0`. `cantelop doctor` rejects older or incomplete
project installations before a build is attempted.

## Native Session behaviour

Use `@cantelop/sdk/session` to define the actor behavior that runs inside the
Linux VM. Each App has one deployed Session behaviour; callers opening a Session do
not provide or replace its behavior.

```ts
import { defineSessionBehaviour } from "@cantelop/sdk/session";
import type { Input, RuntimeEvent } from "./contracts.js";

export default defineSessionBehaviour<Input, RuntimeEvent>(
  async ({ message, session, env, output }) => {
    const result = await runAgent(message.payload, {
      messageId: message.id,
      sessionId: session.id,
      apiKey: env.MODEL_API_KEY,
      onText: async (delta) => output.send({ type: "text_delta", delta }),
    });

    await output.send({ type: "done", result });
  },
);
```

Session behaviour may use Node.js, subprocesses, the Linux filesystem, provider
SDKs, and VM environment variables. Cantelop supplies the same App variables
and secrets to the native Session runtime and Edge API.

Every behaviour invocation receives the `SessionIdentity` represented by its Edge
`Session` reference: `session.id`, `session.workspaceId`, and the request's
`session.keepAliveSeconds`. `message.id` is the stable delivery
identity and `message.sequence` is its activation-local FIFO position. These
objects are frozen and constructed by the trusted runtime rather than copied
from an application request.

### Message observability

Cantelop creates trace context, records the Message lifecycle and automatic
`session.receive` span, and captures `console.debug/log/info/warn/error` plus
JavaScript writes to `process.stdout` and `process.stderr` without application
changes. Output produced while a Message is active is attached to that attempt;
background output after runtime initialization is retained at Sandbox scope.
The original streams are still written normally.

Automatically captured output is bounded and fail-open: a full telemetry
buffer never blocks application execution and a later warning reports dropped
records when capacity returns. Do not write secrets or full customer payloads
to application logs.

Runtime observations travel over the private Sandbox-to-Fire-Fuse channel;
applications do not configure a collector URL or receive an ingestion
credential. Native subprocesses that write directly to inherited operating
system file descriptors remain available in the host journal but are not copied
into the application trace store.

The application-visible message protocol carries the Session and the
developer-defined payload; platform trace context is attached separately. It
does not assign meaning such as run, steer, or cancel. The active
runtime places messages in an in-memory FIFO mailbox and invokes the Session
behaviour for one message at a time. Session behaviour can use a payload discriminator and its
retained Agent instance to interpret each message.

Long-running work that must accept later steer or cancel messages runs as the
Session's runtime-managed activity. Starting the activity does not block the
mailbox. External and
self-generated messages use the same FIFO sequence:

```ts
export default defineSessionBehaviour<Message>(async (context) => {
  const command = context.message.payload;

  if (command.type === "start") {
    context.activity.start(async ({ signal, send }) => {
      try {
        const result = await runAgent(command.prompt, { signal });
        send({ type: "completed", result });
      } catch {
        send({ type: "failed" });
      }
    });
    return;
  }

  if (command.type === "steer") {
    activeAgent?.steer(command.prompt);
    return;
  }

  if (command.type === "cancel") {
    context.activity.cancel();
  }
});
```

Each Session has at most one managed activity. `activity.active` reports whether
it is running, starting another activity fails the current message, and
`activity.cancel()` returns `false` when none is active. Cancellation is
cooperative through the activity's `AbortSignal`. Activity failures are
contained by the runtime, so activity code should catch failures and send an
application-defined failure message when the actor must observe them. If an
application needs to correlate commands, it can carry its own ID in the message
payload; the runtime activity itself has no ID. `send()` calls made inside the
activity are buffered until it settles, then enter the mailbox in call order;
actor-level `context.send()` enters the mailbox immediately. These send
capabilities are scoped to their work: `context.send()` fails after the current
behaviour invocation settles, and an activity's `send()` fails after that
activity settles. Detached work must either be awaited by the behaviour or run
inside the managed activity to remain part of the tracked actor runtime.

The native delivery response settles when that message's Session behaviour returns;
it does not wait for the mailbox or managed activity to become idle. This lets
the platform observe each message independently while the runtime continues to
own the activity and accept later steer or cancel messages. Enqueue, handler
start, handler completion, failure, deduplication, queue-wait time, and handler
duration are emitted as secret-free structured runtime telemetry. Mailbox
position remains an implementation detail rather than a public message state.

The generated Session runtime separately tracks runtime quiescence. Quiescence means
that its mailbox is empty, no behaviour invocation is running, the managed
activity is inactive, and all activity-generated messages have entered and
drained from the mailbox. Each unique activation-local message advances a
monotonic runtime generation; duplicate delivery of the same message ID keeps
the original generation. Message responses include the generation they cover.

Platform infrastructure can wait on the Session runtime's private
`GET /__cantelop/v1/runtime/quiescence?minimum_generation=<n>` endpoint. It
responds only when the runtime is quiescent at or beyond that generation. This
is a statement about SDK-managed actor work, not a Sandbox lifecycle decision:
the SDK does not choose keep-alive, lease, or termination policy.

The Session identity lets logic key provider state consistently, but it
does not persist arbitrary in-memory objects. Module-level agents,
conversation stores, and provider resume handles survive while the Sandbox is
warm. Applications that must resume after Sandbox replacement must persist the
provider's resumable state outside process memory.

Each native Session runtime and Sandbox is bound to exactly one Session identity.
Provider state can therefore be held as one module-level value; a per-Session
map is unnecessary. The native adapter rejects any request for a different
Session ID or Workspace rather than mixing tenants inside one runtime process.

The Session runtime is deployment infrastructure around the Session behaviour.
Cantelop's generated native bootstrap calls `serveSessionRuntime()` internally. It accepts no
port argument: the runtime provider
injects `CANTELOP_INTERNAL_PORT` from the App's
`session.runtime.internal_port`, which remains the single source of truth.

The user-defined Session behaviour owns message settlement. Resolving completes
the message successfully, while throwing marks it as failed. The native adapter
attests settlement to Cantelop only after the function has settled.
Application events such as `{ type: "done" }` are ordinary user-defined stream
events and do not control the Sandbox lifecycle.

## Session event streaming

Native behaviour publishes JSON events through the asynchronous Session output:

```ts
export default defineSessionBehaviour<Input, RuntimeEvent>(
  async ({ message, output }) => {
    for await (const delta of generate(message.payload)) {
      await output.send({ type: "text_delta", delta });
    }
    await output.send({ type: "done" });
  },
);
```

`output.send()` applies backpressure. It resolves after the platform collector
has accepted the event, and rejects non-JSON values, events larger than 64 KiB,
or calls made after their message or managed activity settles. Managed
activities receive the same `output` capability. Output does not enqueue a new
actor message and does not control Session lifetime.

The platform brokers events by logical Session and adds trusted `sequence`,
`session_id`, `message_id`, and `created_at` fields. Sequence numbers are
monotonic within a Session. Message commands continue to use `dispatch()` over
HTTP; the WebSocket transport is output-only.

An App exposes its own authenticated public route by returning
`session.events(request)`. The SDK forwards only the private streaming
handshake; the application still owns authorization, CORS, and which caller may
observe a Session:

```ts
router.route("GET", "/events", async ({ request }) => {
  await requireAuthenticatedViewer(request);
  const session = app.sessions.open({
    id: "agent:primary",
    workspaceId,
    keepAliveSeconds: 300,
  });
  return session.events(request);
});
```

For SSE, connect with `Accept: text/event-stream` (a browser `EventSource` does
this automatically). Each default `message` event contains one JSON envelope,
and its SSE `id` is the platform sequence. Reconnect sends `Last-Event-ID`; an
explicit `?after=<sequence>` cursor is also supported.

For WebSockets, connect to that same App route with subprotocol
`cantelop.events.v1`. Each text frame contains the same JSON envelope as SSE.
Client data frames are rejected with a policy-violation close; steering and
other input remain HTTP messages.

Disconnecting either transport cancels only that subscription. It does not call
`session.terminate()`, does not keep a Sandbox warm, and does not discard the
Session. A reconnect resumes from its supplied cursor. Explicit
`session.terminate()` closes the event stream normally.

Replay is a volatile, bounded platform cache rather than durable history. The
default bound is 256 events and 1 MiB per Session, with global stream and byte
bounds. A stale, evicted, or post-restart cursor fails explicitly with
`event_cursor_expired`; the platform never silently skips a requested range.
Applications that require replay across platform restarts must persist events
in their own durable store.

`cantelop dev` uses the same Session runtime drain, platform envelope, cursor rules,
SSE endpoint, and output-only WebSocket protocol through its loopback Session
bridge.
The Session activity must remain pending until any direct stream and associated
background work that belongs to the message are complete.

## Examples

Each provider example contains two independently checked entrypoints:

- [`examples/openai`](./examples/openai)
- [`examples/anthropic`](./examples/anthropic)
- [`examples/pi`](./examples/pi)

In every example, `src/api.ts` is Edge-only and `src/session.ts` defines the
native Session behaviour.

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
