# App integration contracts

Backend code reaches a Cantelop App through Client → App → Workspace → Session references. The SDK generates the App's Edge API from its protocol; there are no developer-authored Edge routes. Backend code calls the App Edge API, never private platform APIs.

There are two boundaries:

1. **App ↔ Edge:** versioned commands specifying Workspace, Session and operation.
2. **Edge ↔ Sandbox:** the independently versioned actor transport, reached through dispatcher/outbound Worker/broker/gateway infrastructure. The public envelope is not an actor message payload.

## Backend interface

```ts
import { app } from "./cantelop.js";

// The named App owns runtime handlers and their shared types.
const workspace = app.workspace({ slug: "customer" });
const session = workspace.session({ id: "conversation" });
const message = await session.dispatch({ prompt: "Review the change" });
const steering = await session.steer({ prompt: "Focus on authentication" });
await message.status();
await session.cancel();
const view = await session.view();
for await (const event of session.stream({ after: view.cursor })) {
  // Apply application events after the snapshot's atomic boundary.
}
await session.stop();
```

Message, event, reply and view types are declared on `App<Message, Event, Reply, View>`. Its required `runtime` contains handlers checked against the same contract and extracted at build time; the fourth generic is application view state. Dispatch and steer both accept the App’s message type and return `MessageRef` with ID, accepted timestamp and status lookup.

References are lazy. Session IDs are App-scoped; omitting one generates it immediately. Workspaces are selected by ID or slug. Explicit Workspace resolution is memoized per reference, concurrent database calls share its handle, and failures can be retried. Session commands carry the selected Workspace directly; their Edge handlers own provisioning or read-only lookup.

`CantelopClient` supplies shared connection context and profile selection. `cantelop.app({ name, runtime })` owns a named App, its typed runtime and Workspace namespace. App names are existing deployment slugs; runtime/profile configuration provides matching credentials per App. The SDK never reads control-plane login credentials. See [App configuration](app-configuration.md).

On each App, explicit `{ connection }` and `{ edgeUrl, accessToken }` are advanced/test overrides. HTTPS is required except for numeric/localhost loopback development, and redirects are disabled. A connection receives logical Edge requests at `https://edge.cantelop.internal`; it never receives private platform requests.

Edge, Sandbox, and compiled backend artifacts embed the compiler-generated runtime ID. The client sends it in `X-Cantelop-Session-Runtime` on every command, including reads and streams. Edge returns `session_runtime_mismatch` (409) before provisioning or forwarding when the ID is missing/different. The native artifact captures that ID at build time and starts the extracted handler implementation directly, without constructing a client. See [runtime definition enforcement](runtime-definitions.md).

## Common command envelope

Each operation has its own path: `POST {app_url}/commands/{type}`, where `{type}` is the command's `type` (`/commands/dispatch`, `/commands/view`, `/commands/workspace.resolve`, …), including streaming. The path names the operation for every layer in front of the generated Edge Worker — the platform dispatcher, request observability and the console's ingress view all see which SDK call a request is without reading its body. The body still carries the full envelope, and Edge rejects a body whose `command.type` differs from the path with `command_path_mismatch` (400). Bare `/commands` and unknown types return 404. The path is unversioned; the payload carries `protocolVersion`. `CANTELOP_INTEGRATION_PROTOCOL_VERSION` is 2.

`app_url` is the deployed Cantelop App origin, for example `https://<app-slug>.cantelop.dev`; it is distinct from the customer backend that calls the SDK. The existing platform dispatcher selects the App by hostname and forwards the path unchanged. The generated App Edge Worker handles `/commands/*`; no platform path router is required.

```http
POST /commands/steer
Content-Type: application/json

{
  "protocolVersion": 2,
  "id": "msg_0123456789abcdef0123456789abcdef",
  "workspace": { "slug": "customer" },
  "session": { "id": "conversation" },
  "command": {
    "type": "steer",
    "message": { "prompt": "Focus on authentication" }
  }
}
```

`workspace` contains exactly one ID or slug. `session` contains the App-scoped ID. `id` is the submission identity for dispatch/steer/request, and the operation identity for other commands. Workspace-level commands use `session: null`. Unknown commands, unsupported fields, invalid selectors/IDs/cursors and input over 1 MiB fail before private routing. The shared fixture is `test/fixtures/integration-v2.json`.

| Command | Fields | Edge behavior |
| --- | --- | --- |
| `dispatch` | `message`, optional `keepAliveSeconds` | Resolve/provision Workspace; admit normal-priority actor message; activate if needed |
| `steer` | `message`, optional `keepAliveSeconds` | Same admission with steering intent available to the runtime activity scheduler |
| `request` | `message`, `timeoutMs`, optional `keepAliveSeconds` | Normal message admission plus existing bounded reply wait |
| `cancel` | optional `keepAliveSeconds` | Interrupt the active run through selector-bound request delivery; no Workspace provisioning |
| `status` | `messageId` | Read the original message receipt without activation |
| `stop` | none | Release current Sandbox; preserve reusable Session identity |
| `stream` | optional `after: { streamId, sequence }` | Read SSE events without activation |
| `view` | none | Read last committed application projection without activation |
| `workspace.resolve` | none | Open/provision a slug or retrieve a canonical Workspace |
| `workspace.database` | none | Obtain renewable managed database credentials |

Each operation has its own Edge handler. There is no client-selected private path or URL. Authentication happens before parsing/routing. The Worker strips client authorization and identity headers; the outbound Worker derives trusted App identity. Private handlers must enforce App ownership and Session/Workspace binding on every operation, including reads and cancellation.

## Delivery, SDK work coordination and keep-alive

Dispatch, steer and cancellation use generic actor delivery. Edge wraps SDK
intent in `message.payload` with marker `__cantelop_command: 2`. The platform
stores/forwards that JSON without inspecting its type. It preserves FIFO delivery
and acknowledges a Sandbox reservation separately from handling completion.
Requests additionally use the existing reply wait and `timeout_ms`.

The SDK serializes message intake, which stays responsive while work runs in
`context.activity`. Runtime code uses `activity.start(work, options)` for immediate
work or `activity.queue(work, options)` to schedule a task in the single activity
slot. `queue` returns immediately; its closure retains the submission's ownership.
Steering submissions default to priority when they queue work, preserving FIFO
within each priority. An explicit queue `priority` option overrides the default. Harness factories expose `queue`, `steer` and `cancel` methods. Their implementations own scheduling and cleanup; the SDK invokes them directly.

`activity.steer(message)` invokes the current activity's registered `onSteer`
adapter. No separate runtime handler is required. An absent adapter or inactive
activity rejects explicitly; runtimes can instead queue work as their fallback.
`activity.cancel()` signals the current activity while other queued submissions
remain. Both raw actor messages and wrapped SDK commands use the same responsive
intake; `context.command.type` preserves dispatch/steer intent.

Keep-alive is optional on the reference and on dispatch/steer. Cancellation uses
the reference/default value when delivering its SDK control command. Edge resolves
the reserved App default, preserving explicit zero and failing closed when invalid.
Read operations do not activate the Sandbox; stop retains platform ownership.

Acceptance means durable delivery admission, not work completion. Successful
`receive` acknowledges intake; its owned activity can outlive that acknowledgment.
Queued activity can remain pending after its intake status becomes handled; message status describes intake, while activity owns work completion. A caller timeout/disconnect only stops waiting. Stable IDs deduplicate the opaque
command payload; conflicting reuse fails. SDK cancellation uses its own reply
command ID for deduplication; it has no target message ID.

## Active-run cancellation

`session.cancel({ id?, signal? })` returns `{ state: "requested" | "idle" }` and takes no target message ID. The SDK invokes the harness’s `cancel()` method; the implementation signals its active operation and retains provider ownership until cleanup settles. The command leaves queued submissions intact; an idle cancellation never targets future work.

Command IDs remain for safe retries. The Sandbox deduplicates a repeated cancellation command and returns its original receipt rather than selecting a new active run. A new cancellation command intentionally selects the run active when it is processed. `requested` is acceptance of cooperative interruption, not proof that execution has stopped.

Edge sends the opaque cancellation payload to `POST /__cantelop/integration/v2/sessions/{id}/requests`, with one Workspace selector in the query. The body contains `{ message: { id, payload }, keep_alive_seconds, timeout_ms }`. The platform resolves the existing Workspace and Session, verifies ownership/binding, then forwards through ordinary request delivery without interpreting the command. Missing resources fail without provisioning a Workspace. Generic delivery may reactivate an existing Session; an incarnation with no active execution returns `idle`.

Submission IDs remain for receipt/status inspection and output correlation. `stop` remains a separate infrastructure lifecycle operation.

## Durable application view

Hosted Cantelop does not store Session views yet, so deployed Apps can't commit or read them.

`SessionView<View>` contains `revision`, `updatedAt`, typed `state`, and an atomic event `cursor`. The wire snapshot also contains matching `sessionId`, canonical `workspaceId` and `protocolVersion`. The SDK validates identities, timestamp/revision and cursor metadata; application schemas own validation of `state`.

This is inspired by [pi-durable's committed conversation views](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#watching-a-conversation): transcript and current work are projected as committed state. Cantelop does not require Pi's state shape or Chord operations. Allocation diagnostics belong to a separate platform inspection surface; they are not fabricated as application view state.

The runtime supplies `context.view.commit(state)` (also on activity contexts). A view is a bounded application projection keyed by App, Workspace and Session, readable without starting a Sandbox. Its revision and event cursor are committed atomically with the projection, so a snapshot followed by a subscription after its cursor does not miss concurrent updates. Application state changes must publish corresponding events; generic output alone cannot reconstruct arbitrary state. Transport acceptance alone does not imply exactly-once delivery or application durability. Native metadata advertises SDK `steering`, `messageCancellation`, and `durableView` support.

## Streams

POST streaming returns SSE with existing `{ stream_id, sequence, session_id, message_id, created_at, data }` event envelopes. The SDK maps them to `{ cursor, sessionId, messageId, createdAt, data }`. Parsing handles incremental UTF-8, LF/CR/CRLF, multiline data and heartbeats with 1 MiB line/frame bounds. Malformed identities/sequences/UTF-8 fail. Explicit cursor resumption preserves stream reset/expiry errors; there is no automatic reconnect or agent restart. Ending iteration or aborting its signal closes only the subscription.

## Generated artifacts

CLI build protocol 6 generates `worker.mjs` plus `cantelop-edge.json` with `buildEdgeApi({ definition, outdir, runtimeOrigin? })`, and `session-runtime.mjs` plus `cantelop-runtime.json` with `buildSessionRuntime({ definition, outdir, projectRoot? })`. Both advertise integration protocol 2; the native actor runtime protocol remains 2. The Worker requires `CANTELOP_INTEGRATION_TOKEN`; optional keep-alive requires the configured App default binding. The manifest's `optional_bindings` declare `CANTELOP_INTEGRATION_TOKEN_PREVIOUS` and `CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT` (an ISO 8601 UTC instant): during a rotation the Worker also accepts the previous token until that instant and rejects it afterwards or when the expiry is missing or malformed. Local bridge overrides must be numeric HTTP loopback origins.

Project schema 3 uses `definition` to select a module exporting named `cantelop.app({ name, runtime })` definitions. App identity and deployment declarations live in code; the manifest does not duplicate them. The compiler extracts each App's runtime without executing customer code, generates per-App identity and strips all runtime-only dependencies from the shared backend. Cantelop CLI 0.15.2 or newer builds and uploads matching artifacts and honors per-App environment and images (`--app NAME` selects one App from a multi-App definition); `cantelop dev` also writes the compiled backend client to `.cantelop/client/`.

Apps may define optional webhook ingress routes alongside their runtime. Handlers receive the same typed App interface and invoke commands locally on Edge; existing customer backend routes can continue using the SDK over HTTP. Provider verification, delivery ID mapping, acknowledgement and outbound replies remain application code. See [App webhooks](webhooks.md) for compilation and deployment boundaries.
