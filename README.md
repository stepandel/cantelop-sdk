# Cantelop SDK

Cantelop runs agents in isolated Sandboxes with durable Workspaces. The 1.0 SDK exposes App → Workspace → Session directly to application backends. Developers define their Session runtime; the SDK generates the protocol-managed Edge API and the platform deploys it with opinionated middleware.

This repository currently targets **1.0.0-alpha.0**. The SDK authoring/build boundary has changed: Edge API definitions and router exports are removed. The prerelease requires CLI build protocol **6**, runtime-only project schema **3**, and coordinated platform integration support. The existing CLI and platform cannot deploy the new path yet. Use a published 0.x SDK for existing deployments until the rollout is ready; see [integration contracts and follow-ups](docs/integration-foundation.md).

## Integrate from an application backend

```ts
import { createApp } from "@cantelop/sdk";

type Message = { type: "prompt"; prompt: string };
type Event = { type: "delta"; text: string } | { type: "done" };
type Reply = { answer: string };

export function createAgent(edgeUrl: string, accessToken: string) {
  const app = createApp<Message, Event, Reply>({ edgeUrl, accessToken });
  const workspace = app.workspace({ slug: "customer-123" });
  // Or: app.workspace({ id: canonicalWorkspaceId });
  return workspace.session({ id: "conversation-456", keepAliveSeconds: 300 });
}
```

The backend connects to the App's Edge URL using an App-scoped integration token. Credential issuance and endpoint discovery are platform follow-ups. An explicit `AppConnection` remains available for local adapters and tests; it receives logical Edge protocol requests, never private platform requests.

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
import { defineSessionBehaviour } from "@cantelop/sdk/session";
import { runAgent } from "./agent.js";

export default defineSessionBehaviour<Message, Event, Reply>(
  async ({ message, session, env, output, reply, signal }) => {
    const answer = await runAgent(message.payload.prompt, {
      sessionId: session.id,
      apiKey: env.PROVIDER_API_KEY,
      signal,
    });
    await output.send({ type: "done" });
    reply({ answer });
  },
);
```

`runAgent` is application code. Each activation runs one Session runtime in a dedicated Sandbox. Inline handlers serialize subsequent intake. Move long-running work into `context.activity` when the mailbox must remain responsive to commands.

Applications own durable jobs, checkpoints, and idempotency. `onActivate` restores state once per incarnation; `onRecover` opts into replacement-Sandbox recovery. Redelivery remains opt-in for deduplicating intake handlers. Successful `receive` acknowledges application intake; it does not mean a durable job has completed. Persist state under `/workspace` or in the Workspace database. Output/replies retain their JSON and size limits.

## Runtime-only project

```json
{
  "schema_version": 3,
  "app": "support-agent",
  "session": "src/session.ts",
  "environment": {
    "PROVIDER_API_KEY": { "secret": true, "required": true }
  }
}
```

The [manifest schema](schemas/app-v3.json) has no `api` entry. A custom image uses `session: { "entrypoint": "src/session.ts", "dockerfile": "docker/Dockerfile" }`. Cantelop still owns runtime startup, Workspace mounts, listener ports, and shutdown; custom images install dependencies and assets outside `/workspace`.

The SDK build module is reserved for CLI/platform tooling. It builds `session-runtime.mjs` plus `cantelop-runtime.json`, with runtime/integration/build protocol versions and optional managed database schema. `db/schema.ts` is discovered from the project/Session entrypoint, independently of any API module. Runtime and schema changes have separate watch events. `buildEdgeApi({ outdir })` separately generates `worker.mjs` and `cantelop-edge.json` without a customer API entrypoint. The CLI must deploy both the Edge Worker and the native Session runtime.

The platform deploys the generated Edge Worker through the existing dispatcher/outbound trust chain. Compatible CLI support must update initialization, local connections, manifest validation, artifact upload, and deployment before this path can be used in production. Webhook handlers belong in the customer’s own application and call the same SDK primitives.

## Examples and development

[Provider examples](examples/README.md) have backend `src/client.ts` and native `src/session.ts`. The [database example](examples/database/README.md) shares application schema across both. [Workspace database documentation](docs/workspace-databases.md) covers renewal and transaction behavior.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm check:examples
pnpm check:package
pnpm test:bun
```

Package qualification checks the actual npm tarball, removed exports/files, generated Edge and native runtime build artifacts, and a clean consumer's integration types. Publishing remains a separate operation; see [release guidance](docs/releasing.md).

All App operations use the versioned `{ protocolVersion, id, workspace, session, command }` envelope at `POST /__cantelop/app/v2/commands`. The Edge interprets each operation through its own handler; Edge ↔ Sandbox remains the independently versioned actor protocol. See [the command and durable view contracts](docs/integration-foundation.md).
