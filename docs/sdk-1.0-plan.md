# Cantelop SDK 1.0 implementation plan

Status: proposed contract and implementation sequence, October 9, 2026.

SDK 1.0 exposes the existing Cantelop capabilities directly to application backends through App → Workspace → Session. Developers define their Session runtime; Cantelop supplies the ingress, transport, and middleware. Optional webhook triggers use the same Session contract. Delivery guarantees, persistence responsibilities, and Session lifecycle remain unchanged.

## Contract to preserve

- Keep the App and Workspace names. Workspaces remain durable and may be shared by multiple concurrent Sessions.
- Address a Workspace explicitly by canonical ID or App-scoped slug. Slug resolution retains lazy provisioning; an unknown canonical ID must not silently provision a different Workspace.
- Keep Session IDs App-scoped. Nesting the SDK reference under Workspace does not change identity scope. Reusing an ID with a different Workspace must reject rather than silently rebind the Session.
- Omit the Session ID to generate one immediately in the SDK. Constructing references does not allocate a Sandbox.
- Preserve explicit `keepAliveSeconds`, existing limits, FIFO intake, receipt/status semantics, request/reply limits, and request retry identity.
- `stop()` releases the current Sandbox and closes its streams. The logical Session stays reusable. Preserve current errors, including stopping an unmaterialized Session, unless changed in a separately approved contract.
- Workspace files and databases persist. Runtime memory and temporary storage do not. Nested references do not imply exclusive storage ownership or coordination between concurrent Sessions.
- Preserve application-owned durable jobs, idempotent recovery, redelivery opt-in, and the distinction between acknowledged intake and completed work.

## Proposed public interface

This is target syntax, not an interface already available in the SDK.

```ts
import { createApp } from "@cantelop/sdk";
import type { AgentMessage, AgentEvent, AgentReply } from "./agent-contract.js";

const app = createApp<AgentMessage, AgentEvent, AgentReply>({
  app: "support-agent", // Explicit App selector; settle ID/slug options in Phase 1.
  apiKey: process.env.CANTELOP_API_KEY!,
});

const workspace = app.workspace({ slug: "customer-123" });
// Alternatively: app.workspace({ id: workspaceId });

const session = workspace.session({
  id: "conversation-456", // Omit to generate an ID.
  keepAliveSeconds: 300,
});

const receipt = await session.dispatch(message);
const reply = await session.request(message, { timeoutMs: 15_000 });
const snapshot = await session.view();

for await (const event of session.stream({ signal })) {
  // Typed payload plus the existing event identity and replay metadata.
}

await session.steer(steeringInput);
await session.abort();
await session.stop();
```

Use discriminated objects for IDs and slugs rather than guessing from strings. Provide Workspace metadata/provisioning and `database()` access without making callers repeat Workspace selection on each Session operation. Keep runtime declarations in a separate entry point so backend clients never import provider credentials, runtime implementations, or build dependencies. Phase 1 must settle how all message, reply, event, steering, and optional projection types are shared without importing executable runtime code.

### Operation semantics

| Operation | Contract |
| --- | --- |
| `dispatch(message)` | Existing asynchronous intake and message receipt. Acceptance does not mean agent completion. |
| `request(message, options)` | Existing single reply through the FIFO mailbox. Preserve timeout ambiguity and retry-by-message-ID behavior. |
| `steer(input)` | New named runtime capability for influencing active agent work. Ordered intake, with a receipt; capability absence and idle behavior are explicit. Do not silently turn steering into a new dispatch. |
| `abort(options?)` | New cooperative control for active managed work. Preserve Session identity and Sandbox. Report acknowledgment separately from cancellation completion. |
| `view()` | New read-only platform snapshot: identity, materialization/runtime state, and available execution metadata. Does not provision a Workspace or activate a Sandbox. Distinguish an unmaterialized Session from an idle one. |
| `stream(options)` | New backend subscription interface over existing output/replay semantics. Disconnect only ends the subscription. Preserve cursor expiration/reset errors and bounded replay. |
| `stop()` | Existing Sandbox release behavior, including interruption, stream closure, and later reactivation. |

`view()` should not mix agent business state with platform lifecycle state. An application can use the existing typed `request()` for its own state projection; introduce a named projection capability only if a concrete use case requires it. Platform status can be stale relative to live execution and must include its observation time.

Abort must define its target. The proposed default is the managed activity active when the control is handled; idle is an explicit no-op. It does not erase application-owned queued jobs. Applications needing queue clearing provide an explicit hook/policy. If targeting a particular run is required, use an activity generation/token so a delayed retry cannot abort a newer run. Phase 1 freezes that decision before implementation.

### Runtime capabilities

Preserve `defineSessionBehaviour`, `receive`, activation/recovery hooks, output, database access, and application messages. Add optional, typed steering and abort hooks rather than requiring every arbitrary Session behaviour to implement agent controls.

An opt-in agent adapter can connect these hooks to provider steering, cancellation, and application queues. Default abort for a declared managed-activity capability may call `activity.cancel()`; it must not invent behavior for opaque application jobs. Capability metadata is validated and published with the deployment. Unsupported controls produce a stable error; deployment metadata and the actual runtime are checked for compatibility.

Use a versioned operation discriminator outside the application payload to distinguish platform controls from user-defined messages. Route controls through the existing serialized intake in the first implementation. Long-running work must use managed activity so intake remains responsive. Inline blocking `receive()` handlers can delay controls; there is no promise of immediate preemption. `stop()` remains the existing destructive execution escape hatch. An independent priority control channel is a separate protocol change if later required.

## Phase 1 — Freeze contracts and cross-repository fixtures

**Deliverables**

1. Freeze selectors, lazy resolution, configuration, resource metadata, method signatures, errors, and typed event envelopes. Clarify `stream()` resolution versus current `events()` behavior rather than silently changing provisioning rules.
2. Freeze control capability declarations, idle steering behavior, abort targeting, cancellation completion reporting, and capability absence. Add named controls without changing existing application payloads.
3. Define server-side integration credentials: App/operation scope, issuance, rotation, revocation, and authorization for Workspace ID and slug access. Account deploy credentials are not implicitly runtime credentials.
4. Specify versioned public ingress, runtime controls, deployment capabilities, and the SDK/CLI build handshake. Version these independently; SDK 1.0 does not imply every internal protocol becomes version 1.
5. Add shared contract fixtures to the SDK and platform contract checks covering preserved behavior and new operations.

**Gate:** fixtures and examples describe every method's identity, activation effects, accepted/handled/completed meaning, and failure behavior. No Workspace-scoped Session ID migration is included.

## Phase 2 — Platform ingress and backend SDK client

**Platform**

- Add authenticated, platform-owned integration ingress to the existing edge chain. Prefer a generated per-App adapter initially so deployment registration, release gates, trusted App context, gateway routing, and observability remain reusable.
- Keep the origin broker and internal runtime hostname private. The public client uses a stable platform endpoint discovered from its App selector; developers do not configure a per-agent API URL.
- Implement integration credential lifecycle and derive trusted App context after authentication. Enforce ownership when a canonical Workspace ID is supplied and reject cross-Workspace Session reuse, including for stop/status paths that currently primarily address Session ID.
- Expose dispatch, request/reply, Workspace operations/database credential access, message status, stop, and stream transport with existing semantics. Add the read-only Session snapshot needed by `view()` using existing platform Session records where possible.
- Apply operation validation, quotas, payload limits, request IDs, release gates, and audit/traffic observations consistently. Keep database credential issuance App/Workspace-bound and preserve renewable credential behavior.

**SDK**

- Implement `createApp`, lazy Workspace references by ID/slug, and Workspace-bound Session references. Retain App-scoped Session IDs and explicit keep-alive settings.
- Extract/reuse transport logic from `src/remote-app.ts`; introduce authenticated public transport instead of trying to use `runtime.cantelop.internal` from arbitrary application backends.
- Implement `stream()` as a typed async iterator with incremental SSE parsing, backpressure, abort cleanup, explicit cursor resume, and stable reset/expiration errors. Reconnect only under a defined policy; never restart agent work to reconnect.
- Preserve request retry identity. Do not automatically retry ambiguous dispatches: current dispatch generates an ID per call. Stable dispatch/control IDs, if introduced, require a documented additive contract and platform deduplication.
- Introduce stable error types for transport ambiguity, remote rejection, unsupported capability, identity conflict, and stream reset/expiration.
- Keep API keys in backend code. Browser integration continues through the application's authorized backend; direct browser access requires a separately designed scoped-token model.

**Gate:** an existing backend can dispatch, request, inspect, stream, access its Workspace database, and stop without a developer-authored Cantelop API. Two Sessions can share a Workspace while keeping separate execution state.

## Phase 3 — Named agent controls and runtime adapters

**SDK and runtime**

- Add optional typed capability hooks and runtime adapters for `steer()` and `abort()`. Preserve existing behaviours with no capabilities.
- Extend admission/runtime envelopes without colliding with application message names. Keep receipt identity, ordering, deduplication, recovery boundaries, and bounded payloads explicit.
- Wire abort to managed activity and provider cancellation according to the frozen contract. Emit observable completion/failure; an acknowledged cancellation request is not proof that work stopped.
- Convert provider examples to the new integration interface and demonstrate steering while an activity runs. Include a generic non-agent behaviour and an application-owned durable queue example.
- Keep custom commands on `dispatch`/`request`. Typed convenience wrappers are acceptable; do not expose every runtime function as unrestricted remote execution.

**Platform**

- Admit/route controls with the same App authorization and receipt machinery. Publish capability metadata, reject unsupported controls, and verify runtime/deployment compatibility across activation and replacement.
- Implement target matching if run-specific abort is selected. A timed-out command may still execute; safe retries must reuse identity and retain their original target.
- Expose available control status through receipts and platform snapshots without claiming application job completion.

**Gate:** steering, idle behavior, abort acknowledgment/completion, repeated commands, unsupported controls, inline handler delays, and restart/recovery races pass cross-repository tests. Existing dispatch/request behaviour remains intact.

## Phase 4 — Runtime-only authoring, CLI build and local development

**SDK build tooling**

- Replace customer-API compilation for 1.0 projects with generation of the opinionated ingress artifact from runtime/capability metadata.
- Keep build/runtime adapters callable by the CLI but outside the supported application authoring surface. Remove `defineApi`, Router types, and API/edge authoring exports from the 1.0 public surface once replacement tooling is ready.
- Update schema discovery so `db/schema.ts` works from the manifest/project root without an API entry point. Preserve managed migrations and local database behavior.
- Increment the CLI build protocol from the current SDK value 5 for the incompatible contract; agree the next value with the CLI implementation. Publish deterministic artifact/capability schemas and matching package qualification.

**CLI**

- Introduce a manifest schema with App, Session entry point/custom image, environment declarations, and optional triggers; `api` is absent from new projects.
- Update `init`, manifest parsing, `doctor`, build/watch, deploy, dry-run, environment validation, and upload/release flows. A 1.0 project generates ingress rather than discovering customer route declarations.
- Make `dev` run the same integration protocol locally, with loopback-only development ingress and an explicit local connection configuration for the application backend. Publish connection details and support streaming, controls, database access, and runtime watch/rebuild behavior.
- Preserve custom Dockerfiles, workspace mounts, native dependency rules, secrets, activation/recovery, and deploy gates. Distinguish integration traffic from agent runtime logs.
- Support legacy 0.x project manifests/build protocols during migration; select by explicit schema/protocol rather than guessing. Fail incompatible CLI/SDK combinations before building or uploading.

**Platform and console**

- Accept generated ingress/capability artifacts and runtime-only authoring manifests while retaining legacy releases. Adapt Worker binding/environment synchronization for generated adapters; remove dependencies on executing developer-authored API factories.
- Show runtime capabilities, integration credential management, Session snapshots, and optional triggers instead of requiring a custom route table. Preserve useful traffic/log observations.

**Gate:** `init → dev → dry-run → deploy` works with no `src/api.ts`, including managed database schema and custom-image examples. Legacy projects still run through the supported compatibility path.

## Phase 5 — Webhook ingress over the shared Session contract

Support both application-hosted handlers using the backend SDK and optional Cantelop-hosted triggers. A managed trigger owns a public URL; the Session does not gain a public URL.

**SDK and CLI**

- Add narrowly scoped trigger declarations: provider/event subscriptions, secret references, and a mapping to Workspace selector, Session selector/configuration, and typed application message.
- If mapping requires code, compile an optional trigger module with an opinionated handler. Developers implement the event mapping; they do not author arbitrary routes or middleware.
- Keep normal external service/tool usage in Session runtimes. Sending responses back to Slack/GitHub is a separate outbound action, not the webhook acknowledgment.
- Add local trigger simulation and explain how to provide a reachable development webhook URL when testing with real providers.

**Platform**

- Own signature verification over the raw body, provider handshake/challenge responses, size limits, delivery identity, durable admission, and deduplication before dispatch. Maintain provider-specific acknowledgment and retry contracts.
- Bind validated deliveries to the configured App and allowed Workspace selection. Repeated deliveries must not create new Sessions or duplicate intake after acknowledgment; application/external side effects retain their existing idempotency responsibilities.
- Acknowledge durable intake rather than waiting for agent completion. If an ingress ledger/outbox is needed, define the crash boundary between ledger persistence and Session dispatch; never promise exactly-once effects.
- Store versioned trigger configuration/secrets, expose delivery diagnostics and replay controls, and retain authentication separately from public SDK credentials.

**Gate:** ship one complete managed provider integration first, with challenge/signature tests, duplicate delivery tests, ambiguous admission handling, explicit replay behavior, and delivery diagnostics. Additional providers can follow after 1.0; generic application-hosted webhook support is already available in Phase 2.

## Phase 6 — Migration, qualification and release

- Publish a migration guide: API routes become backend SDK calls or optional triggers; Workspace selection moves to Workspace references; `events(request)` becomes backend `stream()` plus an application-owned client-facing route when needed.
- Rewrite README, provider examples, queue/database examples, templates, and package checks. Ensure new consumers cannot import removed API/router authoring exports and that importing the backend client does not pull in build/runtime/provider code.
- Qualify a packed 1.0 prerelease in clean application-backend and runtime projects against local dev and staging. Run SDK checks/tests/examples/package qualification, CLI compatibility tests, and the platform SDK contract suite.
- Exercise connection loss after acceptance, same-ID retry, Workspace ID/slug equivalence, cross-App access denial, wrong-Workspace Session reuse, cold activation, recovery/redelivery, multiple Sessions sharing storage, abort races, stop/reactivation, stream disconnect/reset/expiration, and database credential refresh.
- Roll out compatible platform support first, then CLI support, then SDK prereleases and the stable SDK. Keep old manifests/releases working during a stated migration window.
- Document rollback: restore prior App releases/client versions without rewriting Workspace data or Session identities. Preserve version negotiation so older runtimes never silently accept unsupported controls.

**1.0 release gate:** direct backend integration, runtime-only authoring/deployment, typed streaming, platform `view()`, named controls with explicit capability semantics, migration documentation, and cross-repository qualification are complete. Include one managed trigger provider if webhook-only authoring is part of the launch promise. Publishing the npm package is a separate release operation.

## Implementation locations

| Area | Existing locations to change |
| --- | --- |
| SDK client/resources | `src/index.ts`, `src/resources.ts`, `src/remote-app.ts`; add public client and stream implementation modules |
| SDK runtime controls | `src/session.ts`, `src/session-runtime-server.ts`, `src/runtime-messages.ts`, `src/activity.ts`, `src/mailbox.ts` |
| SDK authoring/build | `src/api.ts`, `src/edge.ts`, `src/router.ts`, `src/build.ts`, `schemas/app-v2.json`, `package.json`, examples and qualification scripts |
| CLI in the platform repository | `clients/cli/cmd/cantelop/project.go`, `project_init*.go`, `project_deploy.go`, `project_dev*.go`, `doctor.go`, artifact validation/upload code and tests |
| Platform edge | `edge/workers/dispatcher`, `outbound`, `origin-broker`, and shared edge contracts; add generated integration ingress and credential verification |
| Platform execution | `fire-fuse/gateway`, `fire-fuse/runtime/httpapi`, dispatcher/admission/runtime provider/persistence paths, and their SDK contract tests |
| Control plane and console | Build/release artifact validation, generated Worker lifecycle/bindings, credential and trigger persistence, deployment configuration and integration UI |

Phases are dependency gates, not estimates. Phase 2 needs Phase 1; Phase 3 builds on direct ingress; Phase 4 can proceed alongside Phase 3 after artifact/control contracts are frozen; Phase 5 follows a stable ingress and build contract; Phase 6 qualifies the complete supported path.
