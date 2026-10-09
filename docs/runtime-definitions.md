# Shared Session runtime definitions

Every `CantelopClient` requires a portable runtime definition. The definition carries the versioned runtime ID, behaviour entrypoint and message/event/reply/view types. The same definition binds the client, Sandbox behaviour and generated Edge Worker.

```ts
// src/definition.ts
import { defineSessionRuntime } from "@cantelop/sdk";
import type { Message, Event, Reply, View } from "./contracts.js";

export const sessionRuntime = defineSessionRuntime<Message, Event, Reply, View>({
  id: "support.v1",
  entrypoint: "./session.ts",
});
export default sessionRuntime;
```

`entrypoint` is resolved relative to the definition module during build. It must be a regular module inside that directory (or a child directory), never an absolute path or parent traversal. Keep the definition lightweight: use type-only imports for contracts and do not import agent/provider implementations. Independently deployed callers can import this definition from a shared package.

```ts
// Application backend
import { CantelopClient } from "@cantelop/sdk";
import { sessionRuntime } from "./definition.js";

const cantelop = new CantelopClient({ sessionRuntime });
const session = cantelop.workspace({ slug: "customer" }).session();
```

Client types are inferred from `sessionRuntime`; callers cannot substitute message/event generics on the client independently. App selection, profiles, and connection overrides can accompany the required definition. Constructing the client does not execute the behaviour or provision a resource. The client captures an immutable copy of the definition.

```ts
// src/session.ts — executes inside the Sandbox
import { defineSessionBehaviour } from "@cantelop/sdk/session";
import { sessionRuntime } from "./definition.js";

export default defineSessionBehaviour(sessionRuntime, async context => {
  // context.message.payload, output.send and reply follow the shared contract.
});
```

The behaviour factory requires a definition and a receive handler. TypeScript checks its message/event/reply contract. The definition’s fourth generic supplies application view state; view publication still requires the coordinated runtime/platform work. Types do not replace application validation of untrusted payloads, and the ID is not a computed schema hash. Change the runtime ID when changing an incompatible public contract.

## Build and connection checks

Project schema 3 now selects the definition module in `session`:

```json
{ "schema_version": 3, "app": "support-agent", "session": "src/definition.ts" }
```

CLI build protocol 6 consumes `buildEdgeApi({ definition, outdir })` and `buildSessionRuntime({ definition, outdir, projectRoot? })`. `definition` is the path to the portable module. Both artifacts include `session_runtime_id`; deploy must reject a pair with different IDs. The build evaluates the portable definition and bundles the behaviour separately. Agent implementation is evaluated in the Sandbox, where its bootstrap checks that the default behaviour export's definition ID matches the artifact before starting the listener. Local watch uses `sessionDefinition` and follows definition/behaviour changes, including a changed behaviour entrypoint.

Every client command includes the reserved `X-Cantelop-Session-Runtime` header. The generated Worker compares it with its compiled runtime ID after authentication and validation, before Workspace provisioning, reads or Sandbox forwarding. Missing/different IDs return `session_runtime_mismatch` (409). Caller identity/auth headers are not forwarded into the private actor protocol. The command envelope and native actor lifecycle are unchanged.

The SDK is unpublished, so these changes update the existing schema/build/integration contracts directly: schema 3, CLI build protocol 6, App integration protocol 2 and native actor protocol 2 remain in place. CLI/platform adoption still needs to build from the definition, validate artifact pairing, and deploy the matching generated Worker. No CLI/platform repository changes are included here.

See [web chat](../examples/web-chat/README.md) for a complete app that owns the client and agent implementation together.
