# Fleets and instances

A Fleet declares one shared application definition with many isolated instances. Each instance owns an App, its Workspaces, configuration and credentials. The SDK manages instance lifecycle and access; the CLI owns package publication, deployment and rollout.

```ts
import { CantelopClient } from "@cantelop/sdk";
import { createTerminal } from "./terminal.js";
import type { TerminalCommand, TerminalEvent, TerminalReply } from "./contracts.js";

const cantelop = new CantelopClient();
export const juiced = cantelop.fleet<TerminalCommand, TerminalEvent, TerminalReply>({
  name: "juiced",
  runtime: { create: createTerminal },
  environment: { OPENAI_API_KEY: { secret: true } },
});
```

Fleet definitions support the same runtime, auth, webhook, homepage, environment and Dockerfile declarations as Apps. They must be exported from a top-level `cantelop.fleet({...})` call. Names are unique across Apps and Fleets in a client/definition module. Compiler extraction, generated backend declarations, runtime dependency removal and runtime identity checks apply to both.

## Instance lifecycle

```ts
const instance = juiced.instance({ externalKey: accountKey });
// Or, after persisting the platform instance ID:
const existing = juiced.instance({ id: platformInstanceId });

const accepted = await instance.create({ signal });
const current = await instance.status({ signal });
```

Construction is local and never creates remote resources. External keys are stable service-owned idempotency keys: 16–128 ASCII letters, digits, underscores, periods, colons or hyphens. Platform instance IDs use the existing `ins_` format; the platform continues calling instances "installations" internally.

`create()` requires an external-key reference and CLI-supplied package metadata. It submits an idempotent provisioning intent and returns the current state; it does not wait until ready. Repeating a key with a different configured package can return `installation_conflict`: creation does not upgrade an existing instance. `status()` never creates and returns `undefined` for `not_found`. After an ambiguous creation response, recover using `status()` with the same external key.

Status exposes `id`, `externalKey`, `appId`, `packageId`, optional `nextPackageId`, `version`, `runtimeId`, `state`, `policyRevision`, `enforcedRevision` and optional `errorCode`. States match the platform: `provisioning`, `ready`, `suspended`, `upgrading`, `failed`, `deleting`, `deleted`. The machine status endpoint does not return the policy body.

Instances start with an inactive, zero-limit policy. Explicitly project the service's current entitlement:

```ts
const current = await instance.status();
if (!current) throw new Error("Instance not found");
const update = await instance.setPolicy({
  expectedRevision: current.policyRevision,
  sourceFence: projectionFence, // Optional monotonic decimal string from a durable service job.
  policy: {
    active: true,
    expiresAt: periodEnd.toISOString(),
    maxSandboxes: 2,
    maxVcpus: 8,
    maxMemoryMib: 9216,
    maxWorkspaces: 8,
    maxStorageBytes: 10 * 1024 ** 3,
  },
});
```

`setPolicy()` returns `{ revision }`. Acceptance is distinct from compute enforcement: a durable reconciler checks status until `enforcedRevision >= update.revision`. Revision conflicts and stale source fences remain typed platform errors; the SDK does not automatically overwrite concurrent changes. Suspension uses an inactive policy, with limits and expiry chosen by the service.

`await instance.delete()` submits permanent deletion and returns `{ state: "deleting" }`. An external-key reference deletes by key even if creation has not returned an instance ID. The platform tombstones that key permanently; it cannot be reused to resurrect the instance. Status polling observes completion. A missing ID may return `not_found`, which a deletion reconciler can treat as completion.

## App access and service relays

```ts
const app = await instance.app();
await app.workspace({ slug: "default" })
  .session({ id: conversationId })
  .request(command);

const connection = await instance.connection();
const response = await connection.fetch(runtimeRequest);
```

`app()` resolves a typed App retaining the Fleet's message, event, reply, view and auth contracts. `connection()` exposes an `AppConnection` for services forwarding SDK protocol requests, including event streams and file sync. Both resolve status and App credentials without provisioning. They verify App/runtime identity and reject a mismatch with the compiled definition. A caller-supplied runtime header cannot override that identity.

Connections use the App token only for its Edge origin; Fleet principals are used only for the control API. Credential resolution occurs on each `app()`/`connection()` call; returned connections retain those credentials. Re-resolve after credential rotation. Requests preserve cancellation, stream upload bodies and return upstream response streams without buffering them.

A service such as Juiced still owns user/account authorization, durable provisioning jobs, billing decisions, protocol allowlists, terminal leases and stream revocation. The SDK replaces its Fleet HTTP wrapper and credential-to-connection plumbing. The retired platform budget/usage endpoints are not included.

## Private integration configuration and CLI contract

Fleet bindings extend the existing version-1 integration document. Supply it through `CANTELOP_APP_CONFIG`, the injected integration context, or the existing private `integration.json` discovery path. `new CantelopClient({ profile: "worker" })` selects a profile; `CANTELOP_PROFILE` and the document's active profile work as for Apps.

```json
{
  "schemaVersion": 1,
  "activeProfile": "service",
  "profiles": {
    "service": {
      "apps": [],
      "fleets": [{
        "name": "juiced",
        "id": "flt_11111111111111111111111111111111",
        "controlUrl": "https://console.example.com",
        "accessToken": "fsp_22222222222222222222222222222222.3333333333333333333333333333333333333333333333333333333333333333",
        "packageId": "pkg_44444444444444444444444444444444",
        "runtimeId": "rt_generated_by_the_compiler"
      }]
    }
  }
}
```

`name`, Fleet ID, control origin and principal token are required; `expiresAt`, `packageId` and `runtimeId` are optional in the document. Read-only services can omit deployment metadata. Creating a compiled Fleet instance requires a matching `runtimeId` and a `packageId`. Principal credentials remain external to source definitions and generated artifacts. Use separate profiles/process configurations for read-only API and provisioning-worker principals. The SDK does not read owner login credentials or implicitly borrow App credentials.

The CLI must publish/select the package, supply matching package/runtime metadata to the backend's integration profile, and manage existing-instance rollout. The SDK has no deployment, upgrade or package-selection method. This repository implements the SDK contract; companion CLI/platform rollout and profile-writing support must be added before using this end to end. Existing Juiced package-transition jobs are replaced only when that rollout support exists.

Artifacts retain existing layout and `apps` manifest arrays. Fleet entries advertise `definition_kind: "fleet"` in Edge, runtime and backend manifests; standalone App entries omit it. Build protocol is now **7** so older CLI tooling rejects an unsupported build contract rather than treating a Fleet as a standalone App. Integration and actor runtime protocol versions are unchanged.

All network operations accept `signal`. `FleetError` exposes the platform `code` and HTTP `status`, including scope failures and optimistic concurrency conflicts. `FleetConfigurationError` identifies missing/invalid/expired bindings and missing deployment metadata. Network failures and cancellation propagate without being retried automatically; reconcile durable intents using their external key.

`fleet.connect(connection)` creates a typed App bound to a trusted service relay without resolving Fleet credentials or provisioning an instance. `fleet.connect()` instead resolves the named App profile for self-managed use. Both preserve the compiled runtime and auth contract. `fleet.withProfile("worker")` returns an independent Fleet reference selecting a role-specific integration profile; it leaves the original reference unchanged.
