# SDK 1.0 implementation plan

Status: October 9, 2026. SDK foundation is implemented in the 1.0 alpha; coordinated CLI/platform/runtime rollout remains required. The public App ↔ Edge protocol is version 2. The Edge ↔ Sandbox actor protocol remains independently versioned. See [the concrete contract](integration-foundation.md).

The architecture is backend → SDK → App dispatcher → protocol-managed Edge Worker → outbound Worker/broker/gateway → Sandbox actor. Developers author the Session runtime. The SDK generates the Edge implementation; the CLI deploys both Edge and runtime artifacts. Private platform APIs are never called by the application SDK.

## Phase 1 — SDK and protocol-managed Edge foundation

- Expose `new CantelopClient({ sessionRuntime })` as the sole integration constructor, bound to one existing App. Preserve typed Workspace/Session references and remove the `createApp` factory and its facade/options types.
- Replace developer API/router exports and customer API compilation with App → Workspace → Session references and generated protocol Edge builds.
- Require a shared typed runtime definition; infer client types from it, bind behaviour handlers to it, and check its runtime ID at Edge/Sandbox boundaries. Build/watch read the definition module and require matching Edge/native artifact identities.
- Preserve Workspace ID/slug addressing, App-scoped Session identity, lazy references, durable Workspace database access, and stop/reactivation lifecycle.
- Add automatic App configuration from runtime context/environment/CLI integration profiles; retain explicit ID/slug selection and test connection overrides. Keep credentials separate from deployment login and scope them to selected Apps.
- Define common `{ protocolVersion, id, workspace, session, command }` envelopes and strict discriminated command validation. Workspace-only commands use a null Session.
- Dispatch and steer carry the same typed message and optional keep-alive. Return message references and expose stable retry IDs. Edge owns routing, normal/priority admission, App-default resolution, and read-only handlers.
- Replace session-wide abort with message-targeted cancellation. Distinguish queued withdrawal, running cancellation request and existing settled outcomes.
- Qualify SSE parsing, explicit resume, subscription cleanup, durable typed view response metadata, generated artifacts, dependency boundaries and clean consumer types.

**Gate:** SDK/Edge contract tests and npm tarball qualification pass; native runtime artifacts accurately advertise unsupported new capabilities. No claim of complete hosted rollout.

## Phase 2 — CLI deployment and App integration infrastructure

**CLI**

- Adopt project schema 3 and CLI build protocol 6; reject incompatible SDKs before build/upload. The unpublished build contract requires a portable runtime definition for both artifacts.
- Update init, doctor, build/watch, dev, dry-run and deploy to produce/upload both generated Edge and native runtime artifacts. No customer `src/api.ts` is required.
- Run the same command Worker locally against a numeric loopback bridge, provision local integration credentials/default keep-alive, and inject the reserved App configuration into managed callers. Populate the versioned integration profile for independently launched local code; export scoped environment configuration for deployed callers. SDK users need no URL/token arguments.
- Preserve custom images, native dependencies, managed schema discovery/migrations, workspace mounts and recovery. Qualify all provider/database examples.

**Platform**

- Deploy generated protocol Workers through the existing dispatcher/outbound chain. Retain trusted App identity, release gates, quotas, audit logging, environment/binding synchronization and streaming behavior.
- Issue App-scoped integration credentials and Edge URLs; implement rotation/revocation and provision reserved integration token/default keep-alive bindings. Account deploy credentials remain separate.
- Implement private integration-v2 endpoints with App ownership and Session/Workspace binding checks on writes, reads, status, cancellation and stop.
- Implement canonical Workspace metadata lookup and read-only slug lookup; inspection/cancellation/streaming never provision a Workspace or activate a Sandbox.

**Gate:** init → dev → dry-run → deploy works with runtime-only authoring and both artifacts, including managed databases/custom images. Cross-App and wrong-Workspace requests fail before side effects.

## Phase 3 — Actor priority and targeted cancellation

- Negotiate priority capability through the Edge ↔ Sandbox protocol. Dispatch is normal work; steer has priority at safe scheduling boundaries. Preserve FIFO within each priority and do not preempt a running receiver. Idle steer admits normally.
- Persist message identity, payload and scheduling mode before acknowledgment. Deduplicate exact retries; reject conflicting reuse across commands/payloads. Recovery must preserve priority and admission order.
- Define busy work consistently across intake and background activity. Provider adapters must consume prioritized input at safe points without introducing a separate steering payload type.
- Keep keep-alive optional in the public contract; resolve method/reference/App defaults in order. Preserve existing quiescence/stop semantics and specify active lease effects in platform tests.
- Implement targeted cancellation with durable queued withdrawal and message-to-activity/descendant ownership. Existing runtime message-cancel/activity-cancel machinery is a starting point, not proof that attribution already works after intake acknowledgment.
- Handle admission/start/settlement/cancellation races, unknown targets, repeated cancellation, shared work, lost acknowledgments and replacement incarnations. Acceptance never claims cooperative work has stopped.
- Convert provider examples from their existing application-defined control messages only after actor support exists. Maintain generic non-agent and durable application queue examples.

**Gate:** priority ordering, idle admission, cancellation attribution, exact retries, late cancellation, process loss/redelivery and provider completion distinctions pass cross-repository tests. Advertise capabilities only then.

## Phase 4 — Durable application views and synchronized subscriptions

- Introduce typed runtime view publication with application-owned projection schema/version; provide a Pi adapter without making Pi/Chord part of the core protocol.
- Store committed views outside live Sandbox memory, keyed by App/Workspace/Session, and serve them through Edge without activation. Unknown/unpublished views return an explicit error; a stopped Session can retain its last committed projection.
- Commit revision, state and event boundary atomically. Define publication durability, update events and writer-incarnation authorization before exposing views as durable.
- Qualify snapshot-plus-subscription races, bounded payloads/slow consumers, replay expiry/reset, reconnect refresh, stale snapshots, replacement writers and access denial.
- Keep allocation diagnostics separate from application projection state. Message receipts describe message processing; neither substitutes for application view publication.

**Gate:** an existing backend renders a committed snapshot and consumes subsequent changes without missing concurrent updates, across stop/restart and Sandbox replacement.

## Phase 5 — Migration, hardening and 1.0 release

- Document migration from customer API routes to ordinary backend SDK calls; replace old steering generics/abort semantics and explain optional keep-alive defaults and view publication.
- Qualify authenticated writes/reads, Workspace ID/slug equivalence, cold activation, recovery/redelivery, shared storage, cancellation races, durable projection consistency and stream disconnects.
- Verify packed SDK exports, generated artifacts, deployment negotiation, dependency boundaries, provider examples and supported Node/Bun runtime environments.
- Release only after SDK, CLI, platform and native actor capabilities are coordinated and migration gates pass. npm publication/tagging remains a separate authorized operation.

**1.0 gate:** backend integration, generated Edge/native deployment, normal/priority messages, targeted cancellation, durable typed view plus synchronized subscriptions, database integration and migration are complete.

## Customer webhook ownership

Webhook implementation belongs in the customer's own app: provider authentication/signature checks, payload translation, deduplication, acknowledgment and outbound replies. Their handler calls the same Workspace/Session primitives as any other backend code. SDK Edge handlers, managed trigger configuration, provider webhook adapters and platform webhook rollout are excluded from all phases.
