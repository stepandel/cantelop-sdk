# Client and Session runtime definition

`CantelopClient` is the sole application definition. Its required `sessionRuntime` contains an ID and a `receive` handler, with optional `onActivate`, `onRecover` and `redelivery`. No separate runtime or behaviour factory is required or exported.

```ts
// src/client.ts
import { CantelopClient } from "@cantelop/sdk";
import type { Message, Event, Reply, View } from "./contracts.js";

export const cantelop = new CantelopClient<Message, Event, Reply, View>({
  sessionRuntime: {
    id: "support.v1",
    receive: async context => (await import("./session.js")).receive(context),
  },
});
export default cantelop;
```

The client generics type both the runtime handlers and Workspace/Session operations. The fourth generic supplies application view state; view publication still requires coordinated runtime/platform work. Types do not replace application validation of untrusted payloads. The ID is not a computed schema hash; change it when changing an incompatible public contract.

App selection, profiles and connection overrides can accompany the runtime. Constructing the client captures an immutable copy of its handlers and ID. It does not call the handlers or provision resources. Application backends import this client and use `cantelop.workspace(...).session(...)`.

Provider implementation can live in ordinary application modules. Load it dynamically inside handlers to keep backend imports lightweight. Any static imports and module-level code in the definition execute when that module is imported, including during build inspection. Backend bundlers should preserve these lazy imports or externalize agent modules; native artifact builds include them. Lifecycle hooks belong in the same `sessionRuntime` object and execute only in the Sandbox.

## Build and connection checks

Project schema 3 selects the default-exported client module:

```json
{ "schema_version": 3, "app": "support-agent", "session": "src/client.ts" }
```

CLI build protocol 6 consumes `buildEdgeApi({ definition, outdir })` and `buildSessionRuntime({ definition, outdir, projectRoot? })`. Both receive the client module path. The build imports that definition and reads its runtime ID without invoking handlers. The native artifact bundles the client and its handlers, then passes `cantelop.sessionRuntime` to the native listener. Its bootstrap checks the runtime ID before starting. Local watch follows the client module and handler dependencies.

Both artifacts include `session_runtime_id`; deployment must reject mismatched pairs. Every client command includes the reserved `X-Cantelop-Session-Runtime` header. Edge compares it with its compiled runtime ID after authentication and validation, before provisioning, reads or Sandbox forwarding. Missing/different IDs return `session_runtime_mismatch` (409). Caller identity/auth headers are not forwarded into the private actor protocol. The envelope and actor lifecycle remain unchanged.

These unpublished contracts change in place: project schema 3, CLI build protocol 6, App integration protocol 2 and native actor protocol 2 remain. CLI/platform adoption must build from the client module, validate artifact pairing and deploy the generated Worker. This PR changes only the SDK repository.

See [web chat](../examples/web-chat/README.md) for a complete app owning the client and agent implementation.
