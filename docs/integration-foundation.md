# SDK 1.0 integration foundation

The integration foundation adds App → Workspace → Session references and a typed backend event subscription. It also defines the client side of the versioned control and inspection protocol. This is an additive step toward 1.0, not a complete public integration service: credential issuance, public endpoint discovery, runtime controls, and runtime-only CLI deployment still require coordinated platform and CLI changes.

The package stays on the current 0.x version. Existing API definitions, public exports, manifests, and CLI build protocol 5 remain compatible until the replacement deployment path is ready.

## Backend interface

```ts
import { createApp, type AppConnection } from "@cantelop/sdk";

type Message = { prompt: string };
type Event = { type: "delta"; text: string } | { type: "done" };
type Reply = { answer: string };
type Steering = { prompt: string };

// Supplied by a trusted, App-bound platform or local-development adapter.
function agentService(connection: AppConnection) {
  const app = createApp<Message, Event, Reply, Steering>({ connection });
  const workspace = app.workspace({ slug: "customer-123" });
  // Or: app.workspace({ id: canonicalWorkspaceId });
  return workspace.session({ id: "conversation-456", keepAliveSeconds: 300 });
}
```

The factory currently requires an explicit `AppConnection`; it does not invent a hosted URL or assume existing account deploy credentials can invoke runtime operations. `connection.fetch(request)` receives requests at the private runtime origin and owns authenticated routing for one App. This is a transport seam for platform/local adapters and tests, not instructions to expose the private origin publicly. The credential-based factory in the 1.0 plan is a subsequent platform-backed change.

Workspace and Session references are lazy. Slug resolution is shared across Sessions created from the same Workspace reference; a failed resolution can be retried. A canonical ID bypasses provisioning. `workspace.resolve()` retrieves metadata or provisions a slug, and `workspace.database()` uses the existing renewable database credential route. The resolved metadata is cached on that reference; it is not a live status subscription.

Session IDs remain App-scoped. The same ID cannot be assigned to different Workspaces. Omitting the ID generates a fresh one immediately. `keepAliveSeconds` is still explicit. Concurrent Sessions share Workspace files/database, and application code owns coordination of shared state.

`dispatch()` and `request()` reuse the existing message transport, receipt/status semantics, limits, and retry behavior. They do not automatically retry. `stop()` uses the integration route with the Workspace selector so platform authorization can check the binding without provisioning. It must retain the current stop semantics, including errors for unmaterialized Sessions and later reactivation with the same ID.

## Event subscriptions

```ts
const controller = new AbortController();
for await (const event of session.stream({ signal: controller.signal })) {
  console.log(event.data, event.messageId, event.createdAt);
  const cursor = event.cursor;
  // Save cursor if the caller wants to resume later.
}

// A subsequent explicit subscription:
for await (const event of session.stream({ after: savedCursor })) {
  // Consume replay and new output.
}
```

The iterator converts existing SSE envelopes to `{ cursor, sessionId, messageId, createdAt, data }`. Cursor is `{ streamId, sequence }`. It supports incremental UTF-8, LF/CR/CRLF separators, multiline data, and heartbeat comments. Frame/line buffering is bounded to 1 MiB. Invalid identity, unsafe sequence values, non-monotonic events, malformed documents, and invalid UTF-8 fail with `invalid_event_stream`.

`event_cursor_expired` and `event_stream_reset` retain their remote codes. The SDK does not reconnect automatically or restart agent work. Breaking iteration or aborting its signal closes the subscription and releases the body reader; it never calls `abort()` or `stop()`. Incomplete frames at EOF are discarded according to SSE framing. Subscribing retains the existing lazy Workspace resolution behavior.

## Versioned control and inspection protocol

`CANTELOP_INTEGRATION_PROTOCOL_VERSION` is 1. The following private App-bound adapter routes are new contracts; the current platform does not yet implement them. Never fall back from a control to an application message or interpret an unsupported route as an idle Session.

Every Session route carries exactly one `workspace_id` or `workspace_slug` query parameter. Session IDs are URL-encoded. Authentication and trusted App context are supplied by the connection/ingress, not by query parameters.

| Method and path | SDK operation | Response |
| --- | --- | --- |
| `GET /__cantelop/integration/v1/sessions/{id}` | `view()` | Versioned snapshot |
| `DELETE /__cantelop/integration/v1/sessions/{id}` | `stop()` | Existing stop result or empty success |
| `POST /__cantelop/integration/v1/sessions/{id}/controls` | `steer()` / `abort()` | Versioned accepted receipt |
| `GET /__cantelop/integration/v1/sessions/{id}/controls/{messageId}` | Control receipt `status()` | Versioned existing message status shape |

Existing dispatch, request, Workspace open/database, and event routes remain unchanged. Canonical Workspace metadata resolution additionally requires `GET /__cantelop/v1/workspaces/{workspaceId}` on the App-bound adapter; it must enforce ownership and never provision.

### Controls

```json
{
  "protocol_version": 1,
  "id": "msg_0123456789abcdef0123456789abcdef",
  "type": "steer",
  "input": { "prompt": "Focus on authentication" }
}
```

Abort uses the same envelope with `type: "abort"` and no `input`. The discriminator stays outside the application's dispatch/request payload. Control IDs use the existing Message ID format. The platform must persist admission and deduplicate same-ID/same-operation retries, and reject conflicting reuse across types or inputs. It must reject unsupported capabilities and idle steering explicitly. No control request resolves/provisions a Workspace on the client.

Accepted replies contain `protocol_version`, matching `id`, `status: "accepted"`, and `accepted_at`. Status replies contain `protocol_version` and the existing accepted/handling/handled/failed/unknown shape. `handled` means control intake finished, not that all agent work or provider cancellation completed.

Steering is an optional typed capability. Abort cooperatively cancels managed work active when the control is handled; idle abort is an acknowledged no-op. It does not clear application-owned jobs. Provider/application adapters must own their queue policy and cancellation completion. Commands use serialized intake, so inline blocking receive handlers can delay them. `stop()` remains the existing Sandbox-release operation.

The foundation does not introduce run-targeted abort. Safe retry reuses the original control ID; a new ID represents a new command and can affect newly active work. Adding an explicit incarnation/activity target remains a separately versioned extension if required.

On an ambiguous transport failure, the SDK throws `RemoteAppError` with `code: "control_outcome_unknown"` and `messageId`. Retry by passing that ID to the same `steer`/`abort` operation. Invalid acceptance replies also carry the generated ID. Caller abort stops waiting and does not prove remote cancellation. Remote capability/identity/protocol errors keep their stable code and status.

### View

Snapshots contain `protocol_version`, matching Session `id`, `state`, `observed_at`, and boolean `capabilities.steer`/`capabilities.abort`. State is one of `unmaterialized`, `active`, or `idle`, preserving current active/idle allocation meaning. A materialized Session requires `workspace_id`; an unmaterialized one may omit it. Canonical selectors are checked against any returned Workspace ID.

Inspection must resolve a slug read-only and never provision storage or activate a Sandbox. Unknown logical Sessions return an explicit unmaterialized snapshot, not a fabricated active/idle state. Authorization failures and unknown Apps/unauthorized Workspaces remain errors. `observedAt` is observation time; a snapshot is not proof of current agent progress. Business state remains an application-defined `request()`.

The shared fixture at `test/fixtures/integration-v1.json` contains representative operations, receipts, statuses, and snapshots. Platform contract tests should consume it with SDK client tests before exposing these routes.

## Coordinated follow-ups

### Platform

1. Implement App-bound canonical Workspace lookup and the versioned Session routes above. Check App ownership and Session/Workspace binding on every operation, including stop, status, and read-only inspection.
2. Add scoped integration credential issuance, rotation, revocation, and verification. Public ingress must derive trusted App context and retain release gates, limits, quotas, audit logging, and streaming behavior. Keep internal origins private.
3. Implement typed runtime steering/abort capabilities and versioned admission/runtime control delivery. Do not forward control envelopes to ordinary `receive()` as application payloads. Preserve FIFO intake, persistent admission/deduplication, recovery, and cancellation acknowledgment/completion distinctions.
4. Generate platform-owned ingress and capability metadata, preserving Worker bindings, environment/secrets synchronization, deployment gates, and legacy releases.
5. Add optional managed webhook ingress after the common integration path is stable. Persist/deduplicate intake before acknowledging a provider; outbound replies remain agent/application behavior.

### CLI and SDK build

1. Supply an App-bound local connection with the same protocol, explicit loopback configuration, event streaming, control support, and database credential routing.
2. Add the runtime-only project manifest and generated ingress artifact. Update `init`, `doctor`, build/watch, dry-run, deploy, schema discovery, and custom-image examples.
3. Negotiate the incompatible build/artifact protocol before uploads; retain explicit legacy 0.x compatibility. The foundation keeps protocol 5 unchanged.
4. Once the full runtime-only path is qualified, remove public Edge API authoring exports and update examples/migration guidance. Do not remove these exports before existing CLI projects have a replacement.

These follow-ups implement Phases 2–5 of [the 1.0 plan](sdk-1.0-plan.md). Stable 1.0 publication follows cross-repository qualification; this foundation must not be advertised as a hosted service rollout.
