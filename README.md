# Cantelop SDK

## Prerequisites

### To use the SDK

- Node.js 22 or newer
- An API key for the LLM provider you plan to use

### To run locally

- Cantelop CLI
- Bun
- Docker with `linux/amd64` support

### To deploy

- A Cantelop account

## Install

For the best development experience, use the Cantelop CLI.

### Cantelop CLI

Install the CLI with Homebrew (recommended):

```sh
brew install stepandel/tap/cantelop
```

Alternatively, use the installer for macOS or Linux:

```sh
curl -fsSL https://console.cantelop.dev/install.sh | sh
```

### SDK Package

Cantelop SDK can be installed directly in your app:

```sh
bun add @cantelop/sdk@latest
```



## Initialize a project

Start with a single command

```sh
cantelop init -app <agent-name> -provider <openai, claude, or pi>
```

This creates `cantelop.json`, `src/api.ts`, `src/session.ts`, and `package.json`.  `cantelop.json` will look something like this.

```json
{
  "app": "my-agent",
  "api": "src/api.ts",
  "session": "src/session.ts"
}
```



## Architecture overview

An App has two pieces:

- **Edge API** (`src/api.ts`): receives HTTP requests and dispatches messages.
- **Session runtime** (`src/session.ts`): runs your agent and business logic
inside a native Sandbox.

Cantelop uses the actor model: each Session has an identity, its own runtime
process, and a mailbox that handles messages one at a time. Requests using the
same Session ID reach the same logical actor. Your code decides how to handle
each message.

## Edge API

In `src/api.ts`, define a `/chat` route that opens a Session and sends it a
message. Cantelop supplies the App and router:

```ts
import { defineApi } from "@cantelop/sdk/api";

const workspaceSlug = "default";

type SessionMessage = { type: "chat"; prompt: string };

export default defineApi<SessionMessage>(({ app, router }) => {
  router.route("POST", "/chat", async ({ request }) => {
    const body = await request.json() as {
      sessionId?: string;
      keepAliveSeconds: number;
      prompt: string;
    };
    const workspace = await app.workspaces.open({ slug: workspaceSlug });
    const session = app.sessions.open({
      ...(body.sessionId === undefined ? {} : { id: body.sessionId }),
      workspaceId: workspace.id,
      keepAliveSeconds: body.keepAliveSeconds,
    });
    const message = await session.dispatch({
      type: "chat",
      prompt: body.prompt,
    });
    return Response.json({ sessionId: session.id, message }, { status: 202 });
  });
});
```

Omit `sessionId` for a new Session; reuse the returned ID to continue it.  
`202` means the message was accepted, not that the agent has finished. Add  
request validation and caller authorization for your application.

## Session runtime

In `src/session.ts`, handle the same chat message and publish the result.
Here, `runAgent` is your own provider integration in `agent.ts`, not an SDK
function:

```ts
import { defineSessionBehaviour } from "@cantelop/sdk/session";
import { runAgent } from "./agent.js";

type SessionMessage = { type: "chat"; prompt: string };
type SessionEvent = { type: "done"; answer: string };

export default defineSessionBehaviour<SessionMessage, SessionEvent>(
  async ({ message, session, env, output }) => {
    const answer = await runAgent(message.payload.prompt, {
      sessionId: session.id,
      apiKey: env.OPENAI_API_KEY,
    });
    await output.send({ type: "done", answer });
  },
);
```

This handler is an example of a queue behavior. It waits for the agent before handling the next message.

## Environments

The `environment` field in `cantelop.json` documents the configuration your app
expects, provides shared defaults for local development, and lets the CLI catch
missing production configuration before deployment.

### Declare configuration

Add an `environment` block to your manifest:

```json
{
  "environment": {
    "OPENAI_MODEL": { "default": "gpt-4.1-mini", "required": true },
    "OPENAI_API_KEY": { "secret": true, "required": true }
  }
}
```

- `default` supplies a string value for local development. It never sets a
production value and cannot be used with `secret: true`.
- `secret` tells the CLI to use encrypted environment variables for the production value.
It defaults to `false`; setting it does not create or upload a secret.
- `required` tells `cantelop doctor` to check that the target App has that name  
configured with the declared kind.



### Run with local values

Variables in a `.env` file beside `cantelop.json` can be used for local development.
Override the default values in `cantelop.json` with the values in `.env`.

### Configure and check production

After `cantelop login`, find the App ID with `cantelop app list` and use it for
configuration commands:

```sh
cantelop app env set OPENAI_MODEL=gpt-4.1-mini
printf %s "$OPENAI_API_KEY" | cantelop app secret set OPENAI_API_KEY
```

Inspect configuration with:

```sh
cantelop app env list
cantelop app secret list
cantelop doctor
```

Use `env set` or `secret set` again to update a value. Remove it with
`cantelop app env unset APP_ID NAME` or
`cantelop app secret unset APP_ID NAME`.

## Deploy

For the first deployment, authenticate the CLI and deploy the App named in
`cantelop.json`:

```sh
cantelop login
cantelop deploy --create-app
```

Run `cantelop doctor` to check the toolchain, project, and required production
configuration once the App exists. For subsequent deployments, use:

```sh
cantelop deploy
```

`cantelop deploy` builds the Edge API and `linux/amd64` Session image, uploads
them, and creates a release. Run `cantelop deploy --dry-run` first to perform
the same build without login, upload, or release creation.

### Custom runtime images

When native dependencies or system tools require a custom image, expand the
`session` entry in `cantelop.json`:

```json
"session": {
  "entrypoint": "src/session.ts",
  "dockerfile": "docker/Dockerfile"
}
```

The Docker build context is always the directory containing `cantelop.json`,
even when the Dockerfile is in a subdirectory. Resolve Dockerfile `COPY` paths
from that project root and place build ignore rules in its `.dockerignore`.
`session.context` is no longer supported: remove it from existing manifests
and adjust `COPY` paths and ignore rules if it previously named a subdirectory.

## Actor model and message lifecycle

Cantelop separates the public Edge API from the native agent runtime. The Edge
API validates HTTP requests and dispatches application-defined messages; the
Session behaviour owns the agent, model, and business logic inside Linux.

```text
Client -> Edge API -> Session actor mailbox -> Session behaviour
                                                   |-> managed activity
                                                   `-> output events
```

A Session is an addressable actor. Opening the same App-scoped Session ID always
targets the same logical actor, even when requests arrive at different Edge API
workers. During each activation, Cantelop gives that actor a dedicated Sandbox
running exactly one SDK-managed Session runtime process. The process is never
shared by multiple Sessions, so module-level agent and conversation state is
per-Session.

The runtime processes the actor's in-memory mailbox one message at a time in
acceptance order. Long-running agent work can move into the Session's single
managed activity, allowing the mailbox to keep receiving commands such as
steer and cancel. The application defines what every message means; Cantelop
only provides identity, routing, serialization, activity management, and event
transport.

### Message lifecycle

1. The Edge API opens a local Session reference and calls `dispatch()` with an
  application-defined payload. The SDK assigns the message ID.
2. Cantelop resolves the Session actor and forwards the message to its Sandbox.
  The first dispatch creates the logical Session atomically when needed.
3. Once accepted for delivery, `dispatch()` returns a `MessageRef` in
  `accepted` state. This does not wait for the Session behaviour or agent work
   to finish.
4. The runtime dequeues messages in order and invokes the Session behaviour.
  A message becomes `handling`, then `handled` when the behaviour returns or
   `failed` when it throws.
5. A managed activity can outlive the behaviour invocation that started it.
  Later messages can steer or cancel that work, and the runtime is quiescent
   only after both the mailbox and activity are idle.
6. `output.send()` publishes application events independently of the mailbox;
  clients receive them through an application-owned SSE or WebSocket route.

Acceptance and mailbox state are intentionally volatile. A runtime crash or
Sandbox replacement loses queued messages, deduplication records, and
in-memory agent state. The logical Session identity and Workspace remain, but
applications must persist any provider state they need to resume. Reactivation
starts a new dedicated process for the same logical Session.

## Workspaces

Each Sandbox mounts its Session's Workspace at `/workspace`. This is durable
storage: its files survive Sandbox termination and remain available when a new
Sandbox starts.

A Workspace can be shared by multiple Sessions, including Sandboxes running
in parallel. They access the same files through NFS, which supports concurrent
reads and writes across Sandboxes.

Workspaces are scoped to an App and addressed by a server-selected slug:

```ts
const workspace = await app.workspaces.open({ slug: "user-1" });
const workspaceId = workspace.id;
```

## Sessions and messages

Every message belongs to a Session. `app.sessions.open()` is lazy and creates
a local reference. The first `dispatch()` allocates a Sandbox if needed  
and sends the message. Omitting `id` generates one in the SDK, immediately  
available as `session.id`.

```ts
const session = app.sessions.open({
  id: "telegram",
  workspaceId,
  keepAliveSeconds: 300,
});
```

A Session keeps its Sandbox warm for `keepAliveSeconds` after work completes.
If the Sandbox has already been released, the platform can reactivate the same
logical Session on a new Sandbox. The Session identity remains reusable when
its Sandbox is released. Set `keepAliveSeconds: 0` to release the Sandbox as
soon as the mailbox and managed activity are idle.

Releasing a Sandbox clears its temporary storage. Files in the persistent
`/workspace` mount survive and are available to the next Sandbox.

Opening a Session requires a `workspaceId` from [Workspaces](#workspaces) and
an explicit `keepAliveSeconds`. The Session ID is immutable and App-scoped,
while `keepAliveSeconds` applies to each request. Use a new ID for a distinct
logical Session.

### Implementing different message types

You define the message protocol and control how each message is handled.
Cantelop routes messages to the Session's Sandbox and enqueues them in its
mailbox, where they are handled one at a time in FIFO (acceptance) order. It
does not assign business logic to names such as `chat`, `steer`, or `cancel`.

Extend the message type used by your API and Session behaviour, then dispatch
to the same Session reference:

```ts
type SessionMessage =
  | { type: "chat"; prompt: string }
  | { type: "steer"; prompt: string }
  | { type: "cancel" };

await session.dispatch({ type: "steer", prompt: "Focus on the tests first." });
await session.dispatch({ type: "cancel" });
```

Your behaviour inspects `message.payload.type` and decides whether to queue
work, call a provider's steering API, cancel an activity, or do something else.
Use a managed activity for long-running work so later messages can be handled
while it runs.

See the [OpenAI](./examples/openai), [Anthropic](./examples/anthropic), and
[Pi](./examples/pi) examples for complete routes, message handlers, and
provider-specific steering and cancellation.

## Native Session behaviour details

Use `@cantelop/sdk/session` to define the actor behavior that runs inside the
Linux VM. Each App has one deployed Session behaviour; callers opening a Session do
not provide or replace its behavior.

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
mailbox. External and self-generated messages use the same FIFO sequence.
The [provider examples](#examples) demonstrate this pattern with real agents.

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
the SDK does not choose keep-alive, lease, or Sandbox release policy.

Module-level agents, conversation stores, and provider resume handles survive
while the Sandbox is warm. They are not durable: applications that must resume
after Sandbox replacement must persist the provider's resumable state outside
process memory.

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

Disconnecting either transport cancels only that subscription. Event
subscriptions do not keep a Sandbox warm or control Session lifetime. The
Session remains reusable, and a reconnect resumes from its supplied cursor.

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

- `[examples/openai](./examples/openai)`
- `[examples/anthropic](./examples/anthropic)`
- `[examples/pi](./examples/pi)`

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
customer API. See `[docs/releasing.md](./docs/releasing.md)` for the release
boundary. Publishing is a separate production operation.
