# Cantelop SDK

Cantelop is a platform for running agents in isolated Sandboxes with persistent
Workspaces. This TypeScript SDK lets you define an agent's HTTP API and Session
runtime, send messages to the agent, and stream its responses. You control the
agent logic; Cantelop manages routing and Sandbox lifecycle.

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

### Actor model and message lifecycle

Cantelop separates the public Edge API from the native agent runtime. The Edge
API validates HTTP requests and dispatches application-defined messages; the
Session behaviour owns the agent, model, and business logic inside Linux.

```text
+--------+     +----------+     +-----------------------+
| Client | --> | Edge API | --> | Session actor mailbox |
+--------+     +----------+     |  (platform managed)   |
                               +-----------+-----------+
                                           |
                                           v
                                 +-------------------+
                                 | Session behaviour |
                                 +---------+---------+
                                           |
                         +-----------------+----------------+
                         |                                  |
                         v                                  v
                +------------------+                +---------------+
                | Managed activity |                | Output events |
                +------------------+                +---------------+
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
  async ({ message, session, env, output, signal }) => {
    const answer = await runAgent(message.payload.prompt, {
      sessionId: session.id,
      apiKey: env.OPENAI_API_KEY,
      signal,
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

The Dockerfile installs dependencies and supplies assets. For example, to add
Python:

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*
```

Cantelop supplies the Session runtime, managed user, home and cache directories,
startup command, and `/workspace` working directory. You do not need to set
`USER`, `WORKDIR`, `ENTRYPOINT`, or `CMD` for the runtime. You can still use
`USER` and `WORKDIR` within build steps; the CLI sets their final runtime values.

Install dependencies and copy assets into system locations or a path such as
`/opt/app`. Files baked into the image under `/workspace` would be hidden by the
durable mount, so the CLI rejects them. Home, temporary files, and caches are
ephemeral; write data that must survive a Sandbox restart under `/workspace`.

Cantelop owns mounts, listener ports, health checks, and shutdown behavior. The
final base image must not declare `VOLUME`, pending `ONBUILD` instructions, or
`CANTELOP_*` environment variables. `/__cantelop` and `/opt/cantelop` are reserved
for the runtime. Ordinary application `ENV` values remain available, while
identity, home, temporary, and XDG paths are managed by Cantelop. Keep credentials
in App environment variables and secrets.

## Workspaces

Each Sandbox mounts its Session's Workspace at `/workspace`. This is durable
storage: its files survive Sandbox termination and remain available when a new
Sandbox starts.

Both default and custom images start the Session process in `/workspace`, so
relative file paths resolve inside the durable Workspace.

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

## Response streaming (SSE and WebSockets)

Publish responses from a Session behaviour or managed activity with
`output.send()`.

```ts
for await (const delta of generate(prompt)) {
  await output.send({ type: "text_delta", delta });
}
await output.send({ type: "done" });
```

Await each send for backpressure, and keep the behaviour or activity running
until streaming finishes. Events must be JSON-compatible and at most 64 KiB.

### Transport behavior

`session.events(request)` adapts a `GET` request into a Session event stream.
Your application chooses the public route and authorizes access.

- **SSE:** the default transport. Browser `EventSource` reconnects with the last
  event's `stream_id:sequence` in `Last-Event-ID`; the SDK forwards it for replay.
- **WebSockets:** upgrade requests require the `cantelop.events.v1` subprotocol.
Cantelop enforces an output-only stream; send commands through `dispatch()`.

Both transports deliver your payload plus `stream_id`, `sequence`, `session_id`,
`message_id`, and `created_at`. Resume explicitly with
`?stream_id=<stream>&after=<sequence>`; this also works for SSE and overrides
`Last-Event-ID`. Replay is bounded and in-memory: expired cursors return
`event_cursor_expired`, while a replaced stream reports `event_stream_reset`.

Disconnecting stops only the subscription, not the agent. Subscriptions do not
keep a Sandbox warm.

### Example route

Here, `/events` and `agent:primary` are example choices, not SDK requirements:

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

Connect with `new EventSource("/events")` or a WebSocket using
`cantelop.events.v1`. See the [provider examples](./examples/README.md) for
complete clients. Both transports also work with `cantelop dev`.

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
