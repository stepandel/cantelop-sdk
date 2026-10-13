# Cantelop SDK

Cantelop runs agents in isolated Sandboxes with durable Workspaces. The 1.0 SDK exposes App → Workspace → Session directly to application backends. Developers define their Session runtime; the SDK generates the protocol-managed Edge API and the platform deploys it with opinionated middleware.

This repository prepares **1.0.0-alpha.5**. Apps use backend resource APIs and runtime-only project schema **3** with CLI build protocol **6**. Custom HTTP ingress is optional and reserved for webhooks. Native auth terminal providers additionally require compatible platform terminal transport; see [integration contracts](docs/integration-foundation.md) and [native auth](docs/native-auth.md).

## Integrate from an application backend

```ts
// src/cantelop.ts — the application and deployment definition.
import { CantelopClient } from "@cantelop/sdk";
import type { Message, Event, Reply } from "./contracts.js";
import { create } from "./agent.js";

const cantelop = new CantelopClient();

export const support = cantelop.app<Message, Event, Reply>({
  name: "support-agent",
  runtime: { create },
});
```

```ts
import { support } from "./cantelop.js";

const workspace = support.workspace({ slug: "customer-123" });
// Or: support.workspace({ id: canonicalWorkspaceId });
const session = workspace.session({ id: "conversation-456" });
```

Backend builds use the Cantelop compiler transform to exclude Sandbox dependencies; ordinary source imports load their dependencies. See [runtime compilation](docs/runtime-definitions.md).

`CantelopClient` supplies shared connection context, optionally selecting a profile. Each `cantelop.app({ name, runtime })` declares a named App with its own typed runtime and Workspace namespace. One client can define multiple Apps. App names are deployment slugs, independent of JavaScript export names. Connections and scoped credentials resolve automatically per App; constructing these objects does not provision resources. See [App configuration](docs/app-configuration.md).

Traffic follows `backend → SDK → protocol-managed App Edge Worker → outbound Worker/broker → Session runtime`. The Edge API remains deployed; its implementation is owned by the protocol rather than developer-authored routing.

Workspace and Session references are lazy. Omitting a Session ID generates one immediately. `dispatch()` lazily resolves/provisions a Workspace slug and activates a Sandbox when needed. A canonical Workspace ID never provisions a replacement. Explicit resolution and database access share the Workspace reference’s cached metadata. Session commands send the selected Workspace to Edge for operation-specific lookup.

```ts
const receipt = await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
const status = await receipt.status();
const reply = await session.request(
  { type: "prompt", prompt: "Return one answer" },
  { timeoutMs: 15_000 },
);
```

Acceptance means durable message admission, not agent completion. `request()` enters the normal-priority mailbox and returns one JSON reply when the handler finishes. Timeout or disconnect ends waiting and does not prove execution stopped. A failed request exposes its Message ID through `RemoteAppError`; reuse that ID for an ambiguous retry. The SDK does not automatically replay writes.

## Session lifecycle and controls

Workspaces provide durable files and databases. Session memory and temporary files are ephemeral; Session identity remains reusable. Multiple Sessions may share a Workspace, so the application owns coordination of shared state. Session IDs remain App-scoped even though references are nested under Workspace.

```ts
await session.stop();
// The same identity can activate on a new Sandbox.
await session.dispatch({ type: "prompt", prompt: "Continue" });
```

`stop()` releases the current Sandbox and closes streams, potentially interrupting work. It retains current errors for an unmaterialized Session. The integration route includes the Workspace selector for platform ownership/binding checks without provisioning.

Dispatch and steer accept the same message type and return an ID/status reference. Dispatch invokes the harness’s `queue` method; steer invokes its `steer` method. Both accept optional `{ id, keepAliveSeconds, signal }`. Keep-alive falls back from method options to the Session reference to the configured App default.

`cancel()` interrupts the active harness run and preserves queued input. `stop()` releases the Sandbox while retaining the Session identity. `view()` returns a typed durable application projection with revision and an event cursor for subscribing after the snapshot. Steering and run cancellation are implemented by the harness; the platform delivers their envelopes as ordinary messages. Durable views require the coordinated platform implementation.

## Stream output

```ts
for await (const event of session.stream({ signal })) {
  console.log(event.data, event.cursor, event.messageId);
}
```

`stream()` is an async iterator over existing SSE output. Metadata includes cursor `{ streamId, sequence }`, Session ID, Message ID, and creation time. Resume explicitly with `session.stream({ after: savedCursor })`. Replay remains bounded; cursor expiration and stream reset retain their remote error codes. The SDK does not reconnect automatically.

Breaking iteration or aborting the subscription only closes its stream. It does not cancel agent work or keep the Sandbox warm. Browser-facing routes remain part of the application's own authorized backend.

## Define the runtime

```ts
// src/agent.ts — the harness factory compiled into the Sandbox.
import type { SessionHarness, SessionHarnessContext } from "@cantelop/sdk/session";
import type { Message, Event, Reply } from "./contracts.js";
import { createHarness } from "./harness.js";

export function create(context: SessionHarnessContext): SessionHarness<Message, Event, Reply> {
  return createHarness(context); // Implements queue(message, work), steer(message, work), cancel().
}
```

The factory runs once per Session runtime incarnation, on the first harness command or recovery. It returns one harness implementing `queue(message, work)`, `steer(message, work)`, and `cancel()`. Each implementation owns ordering, steering behavior, interruption, and cleanup. The SDK calls those methods directly and keeps intake responsive while their promises remain pending. `queue` resolves after the submitted operation and its cleanup; its return value supplies `session.request()` replies. `steer` resolves at the implementation's completion boundary: native input may be accepted immediately, while an interrupt-and-resume implementation can wait for the redirected turn.

Work receives a signal, typed output/view, submission identity and Session resources. The SDK tracks operation lifetimes, attribution and deadlines without selecting provider scheduling behavior. `cancel()` returns whether an active operation was signalled and preserves waiting input. The compiler bundles the factory and its dependencies into the Sandbox while excluding them from backend and Edge artifacts.

Custom runtimes can use `runtime: { receive, onActivate?, onRecover?, redelivery? }`. Their intake is serialized; move long-running work into `context.activity` to keep control intake responsive.

Applications own durable jobs, checkpoints, and idempotency. The optional `onActivate` hook restores state once per incarnation; the optional `onRecover` hook opts into replacement-Sandbox recovery. Redelivery remains opt-in for deduplicating intake handlers. Successful `receive` acknowledges application intake; it does not mean a durable job has completed. Persist state under `/workspace` or in the Workspace database. Output/replies retain their JSON and size limits.

## Runtime-only project

```json
{
  "schema_version": 3,
  "definition": "src/cantelop.ts"
}
```

The [manifest schema](schemas/app-v3.json) points to a definition module and has no App name, runtime configuration, or customer API entry. App names, environment declarations, and optional `dockerfile: "docker/Dockerfile"` belong in `cantelop.app(...)`. Cantelop still owns runtime startup, Workspace mounts, listener ports, and shutdown.

The SDK build module is tooling. `buildAppArtifacts({ definition, outdir })` generates separate Edge/Sandbox artifacts for each named App and a shared compiled backend module. Individual builds/watch accept an `app` name selector when a module defines multiple Apps. Each deployment must match `app_name` and `session_runtime_id`; the backend compiler removes every App's runtime-only dependencies. `db/schema.ts` is discovered independently and describes each App's isolated Workspace databases. See [runtime compilation](docs/runtime-definitions.md).

The platform deploys the generated Edge Worker through the existing dispatcher/outbound trust chain. Compatible CLI support must update initialization, local connections, manifest validation, artifact upload, and deployment before this path can be used in production. Webhook handlers belong in the customer’s own application and call the same SDK primitives.

## Examples and development

[The multi-App example](examples/multi-app/README.md) shows two Apps under one client. [Provider examples](examples/README.md) have backend `src/cantelop.ts` and native `src/agent.ts`. [Workspace database documentation](docs/workspace-databases.md) covers renewal and transaction behavior. [App webhooks and optional homepages](docs/webhooks.md) enable headless integrations with a public landing page; the [GitHub example](examples/github/README.md) verifies deliveries and dispatches through the same App interface.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm check:examples
pnpm check:package
pnpm test:bun
```

Package qualification checks the actual npm tarball, removed exports/files, generated Edge and native runtime build artifacts, and a clean consumer's integration types. Publishing remains a separate operation; see [release guidance](docs/releasing.md).

All App operations use the versioned `{ protocolVersion, id, workspace, session, command }` envelope at `POST /commands`. The Edge interprets each operation through its own handler; Edge ↔ Sandbox remains the independently versioned actor protocol. See [the command and durable view contracts](docs/integration-foundation.md).

For a runnable browser and server integration, see [the web chat example](examples/web-chat/README.md).

### Harness controls and durable Session views

Dispatch, steer and cancel share ordinary delivery. The platform treats their SDK command payloads as opaque. The harness implementation owns queueing, steering and active-operation cancellation. The SDK owns command receipts and operation-scoped output and replies.

```ts
await session.dispatch(message);
await session.steer(newDirection);
await session.cancel();
```

`session.cancel({ id?, signal? })` takes no target message ID and returns `{ state: "requested" | "idle" }`. It invokes the harness’s `cancel()` method, which selects and signals its active operation. `requested` acknowledges interruption, not completed cleanup. The harness retains ownership of the active operation until cleanup settles before reusing provider resources. Queued input is preserved; cancellation while idle does not affect later input. Retrying the same command ID reuses its result and cannot interrupt a subsequent run.

Submission IDs remain available for receipts, retries and output correlation. Dispatch status describes intake; a queued run may outlive intake completion. Requests wait for `queue` to return its reply while other input and control remain responsive. `stop()` releases the Sandbox and retains Session identity. Harness memory belongs to one incarnation; recovery remains application-owned.

For custom receive runtimes, `activity.start`, `queue`, `steer`, and `cancel` remain available. Register provider methods through activity options `onSteer` and `onCancel`; those hooks belong to the active execution.

The runtime explicitly commits the application's read model:

```ts
async function receive(context: SessionContext<Message, Event, Reply, State>) {
  const state = await updateApplicationState(context.message.payload);
  await context.view.commit(state);
  context.reply(state);
}
```

`view.commit` resolves after the platform stores the projection and its atomic
event boundary. Customer code owns application state and recovery; committing a
view does not replace the application's database or replay its runtime closures.

```ts
const snapshot = await session.view();
render(snapshot.state);
for await (const event of session.stream({ after: snapshot.cursor })) {
  apply(event.data);
}
```

Supervised activity can also call its own `view.commit(state)` capability while
it is active. This capability follows the activity signal and closes when that
activity settles.

A view read never opens a Workspace or activates a Sandbox. A missing projection
returns `session_view_not_found`. Views survive stop and host restart; stream
resume remains subject to the platform's bounded replay retention. Projection
commits advance the stream cursor without appearing as application events.

Stock harness integrations are available for [Codex](examples/codex/README.md), [Claude Code](examples/anthropic/README.md), and [OpenCode](examples/opencode/README.md). Claude Code is packaged at `@cantelop/sdk/harnesses/claude`, exporting `createClaudeHarness`, `NativeClaude`, `claudeAuth`, `claudeDockerfile`, and message/event/options types. `createClaudeRuntime(options)` also packages the durable configure/queue/cancel/steer/snapshot/recovery lifecycle, using `createClaudeHarness` internally; its protocol types are available from `@cantelop/sdk/harnesses/claude/protocol`. Use `createClaudeHarness(context, options)` for per-Session tool/MCP permissions, prompts, turn limits, model selection and conversation migration, or keep the one-argument factory for stock defaults. Configuration is snapshotted and the SDK context supplies canonical Session identity. Set `runtime: { create: createClaudeHarness }`, `auth: claudeAuth`, and `dockerfile: claudeDockerfile` to use the SDK-maintained runner and image; see the Claude example for a complete App definition. They wrap stock CLI runners directly, preserve native Workspace authentication and conversation IDs, and use interrupt-and-queue steering with process-group cleanup.

Apps can declare `auth` to let each Workspace sign in to a stock CLI with the user's own subscription. Sign-in uses the CLI's native process. Applications can show a link/code form or intentionally expose its terminal; native credentials remain in the Workspace. The Claude Code example uses this; see [native auth](docs/native-auth.md).

Workspace auth methods are available on `app.workspace(selector).auth()`. For a provider with a `codeLogin` adapter (including packaged `claudeAuth`), `login()` returns `{authenticated:true}` or `{authenticated:false,attemptId,url,expiresAt}`. `submitCode({attemptId,code})` returns native authentication status or a stable `code_rejected` error, and `cancelLogin({attemptId})` stops that attempt. `login({force:true})` confirms native logout before starting a fresh login. The SDK owns attempts, prompt parsing, bounded private output, expiration and process cleanup. Application authorization and account preferences stay on your backend. Low-level `terminal()`/`close()` remain available for integrations that intentionally expose a native terminal; a terminal UI is not required.
