# Client definition and runtime module

`CantelopClient` is the application’s configuration point. Its required `sessionRuntime` references the runtime module explicitly; importing the client does not load agent code. No separate runtime or behavior factory is required.

```ts
// src/cantelop.ts
import { CantelopClient } from "@cantelop/sdk";
import type { Message, Event, Reply, View } from "./contracts.js";

export const cantelop = new CantelopClient<Message, Event, Reply, View>({
  sessionRuntime: {
    id: "support.v1",
    entrypoint: "./agent.ts",
  },
});
export default cantelop;
```

The entrypoint resolves relative to this source definition during build. It must start with `./`, stay within the definition directory, and name a regular module file. Parent traversal, absolute paths and symlinks escaping that directory are rejected. The backend treats the reference as configuration; it does not resolve or import the runtime file.

Runtime implementation uses ordinary named exports:

```ts
// src/agent.ts
import type { SessionContext, SessionActivationContext } from "@cantelop/sdk/session";
import type { Message, Event, Reply } from "./contracts.js";
import { runAgent } from "./provider.js";

export async function onActivate(context: SessionActivationContext<Message, Event>) {
  // Restore state once per Sandbox incarnation, before intake.
}

export async function receive(context: SessionContext<Message, Event, Reply>) {
  const answer = await runAgent(context.message.payload, context.signal);
  context.reply(answer);
}
```

`receive` is required. `onActivate`, `onRecover` and a boolean `redelivery` export are optional. Helper exports are permitted. Provider imports and module state belong here and execute in the Sandbox. Exported handlers should annotate their contexts using the shared message/event/reply types; the build compares the module’s exports against the client’s contract, including function parameter types and return values. JavaScript and `any` retain their usual type-checking limits; types do not replace validation of untrusted messages.

The client’s generics type Workspace/Session operations. The fourth generic supplies application view state; publication still requires coordinated runtime/platform work. The build requires a compatible implementation for the first three generics. The runtime ID is not a computed schema hash; change it when changing an incompatible public contract.

App selection, profiles and connection overrides can accompany the reference. Construction captures an immutable ID/entrypoint pair without provisioning resources. Application backends import this client and call `cantelop.workspace(...).session(...)`.

## Build and connection checks

Project schema 3 selects the default-exported client module:

```json
{ "schema_version": 3, "app": "support-agent", "session": "src/cantelop.ts" }
```

CLI build protocol 6 consumes `buildEdgeApi({ definition, outdir })` and `buildSessionRuntime({ definition, outdir, projectRoot? })`. Both receive the client definition path. Build inspection imports the configuration module to read its runtime reference; keep that module limited to client configuration and type-only contract imports. Runtime module validation uses TypeScript’s compiler and the nearest project `tsconfig.json`, without importing provider code or invoking handlers. Missing modules/exports, incompatible handlers and invalid hooks fail before either build succeeds. Validation also checks the reachable implementation source graph, respecting project settings and enabling strict contract assignment.

The native artifact bundles the referenced module’s import graph with the SDK listener. The Sandbox imports that implementation and passes its named exports to the listener; it never imports the client definition or constructs an API client. Backend bundlers can use ordinary imports without a lazy-import plugin or a Cantelop-specific transform.

Both artifacts include `session_runtime_id`; deployment must reject mismatched pairs. Every client command includes `X-Cantelop-Session-Runtime`. Edge compares it with its compiled ID after authentication and validation, before provisioning, reads or Sandbox forwarding. Missing/different IDs return `session_runtime_mismatch` (409). Native identity is captured in its generated artifact manifest rather than re-evaluated from a client inside the Sandbox. Actor lifecycle and the command envelope remain unchanged.

Local watch follows the client definition, runtime reference, runtime imports and checked source contracts. Schema watching remains independent. Failed runtime validation leaves the last successful manifest identity intact.

These unpublished contracts change in place: project schema 3, CLI build protocol 6, App integration protocol 2 and native actor protocol 2 remain. CLI/platform adoption must build from the client definition, validate artifact pairing and deploy the generated Worker. This PR changes only the SDK repository.

See [web chat](../examples/web-chat/README.md) for a complete integration.
