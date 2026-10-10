# Cantelop SDK

Cantelop runs agents in isolated Sandboxes with durable Workspaces. The 1.0 SDK exposes App → Workspace → Session directly to application backends. Developers define their Session runtime; the SDK generates the protocol-managed Edge API and the platform deploys it with opinionated middleware.

This repository currently targets **1.0.0-alpha.0**. The SDK authoring/build boundary has changed: Edge API definitions and router exports are removed. The prerelease requires CLI build protocol **6**, runtime-only project schema **3**, and coordinated platform integration support. The existing CLI and platform cannot deploy the new path yet. The SDK is unpublished; see [integration contracts and follow-ups](docs/integration-foundation.md).

## Integrate from an application backend

```ts
// src/cantelop.ts — the application and deployment definition.
import { CantelopClient } from "@cantelop/sdk";
import type { Message, Event, Reply } from "./contracts.js";
import { receive } from "./agent.js";

const cantelop = new CantelopClient();

export const support = cantelop.app<Message, Event, Reply>({
  name: "support-agent",
  runtime: { receive },
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

Dispatch and steer accept the same message type and return an ID/status reference. Dispatch queues normal work; steer prioritizes its message at the next safe scheduling boundary. Both accept optional `{ id, keepAliveSeconds, signal }`. Keep-alive falls back from method options to the Session reference to the configured App default.

`cancel(messageId)` targets one queued/running message. `stop()` releases the Sandbox while retaining the Session identity. `view()` returns a typed durable application projection with revision and an event cursor for subscribing after the snapshot. Actor priority, cancellation attribution and view publication/storage still require coordinated platform/runtime support; runtime artifacts advertise those capabilities as false.

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
// src/agent.ts — the runtime module referenced by the client.
import type { SessionContext } from "@cantelop/sdk/session";
import type { Message, Event, Reply } from "./contracts.js";
import { receive } from "./agent.js";
import { runAgent } from "./agent.js";

export async function receive({ message, session, env, output, reply, signal }: SessionContext<Message, Event, Reply>) {
  const answer = await runAgent(message.payload.prompt, {
    sessionId: session.id, apiKey: env.PROVIDER_API_KEY, signal,
  });
  await output.send({ type: "done" });
  reply({ answer });
}
```

`runAgent` is application code. The runtime module exports `receive` and optional `onActivate`, `onRecover` and `redelivery`; the build validates the handlers configured on the App against its contract without executing agent code. The Sandbox bundle includes this implementation and the SDK listener, with no API client. Each activation runs one Session runtime in a dedicated Sandbox. Inline handlers serialize subsequent intake. Move long-running work into `context.activity` when the mailbox must remain responsive to commands.

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

[The multi-App example](examples/multi-app/README.md) shows two Apps under one client. [Provider examples](examples/README.md) have backend `src/cantelop.ts` and native `src/agent.ts`. The [database example](examples/database/README.md) shares application schema across both. [Workspace database documentation](docs/workspace-databases.md) covers renewal and transaction behavior.

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
