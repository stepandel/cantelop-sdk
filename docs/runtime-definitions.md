# Client definition and compiled runtime

`CantelopClient` is the sole application definition. Its required `sessionRuntime` contains `receive` and optional `onActivate`, `onRecover`, and boolean `redelivery`. Define handlers in the constructor or import ordinary functions:

```ts
import { CantelopClient } from "@cantelop/sdk";
import { runAgent } from "./provider.js";
import type { Message, Event, Reply } from "./contracts.js";

export const cantelop = new CantelopClient<Message, Event, Reply>({
  sessionRuntime: {
    async receive(context) {
      const answer = await runAgent(context.message.payload, context.signal);
      context.reply(answer);
    },
  },
});
```

Or use `import { receive } from "./agent.js"` with `sessionRuntime: { receive }`. Separate handler files are an organizational choice. There is no runtime ID, implementation path, behavior factory, or client subclass to configure. The constructor captures a frozen handler snapshot and resolves its App connection lazily. Workspace/Session lifecycle is unchanged.

The first three client generics type messages, events and replies, including contextual handler types. The fourth types view state; durable view publication still requires coordinated actor/platform support. Build validation checks reachable source with TypeScript and the nearest project config, including handler parameter compatibility. JavaScript and `any` retain their normal checking limits.

## Compiler boundary

The compiler reads source without importing or executing the customer definition. It generates two variants:

- The Sandbox variant contains the handler object, referenced local declarations and their imported dependency graph, plus the SDK listener. It never constructs a `CantelopClient` or imports backend transport.
- The backend variant preserves App configuration and the client export, replaces the runtime with an inert implementation, and embeds compiler-owned identity metadata. Runtime-only providers, helpers and state are removed.

Host backend bundlers must use the compiler transform to get this separation. An ordinary untransformed source import follows normal JavaScript semantics and loads its imports. For esbuild:

```ts
import { build } from "esbuild";
import { createCantelopCompilerPlugin } from "@cantelop/sdk/build";

await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [createCantelopCompilerPlugin({ definition: "src/cantelop.ts" })],
  outfile: "dist/server.mjs",
});
```

The build module is tooling, not part of the application's runtime dependency graph. `buildBackendClient({ definition, outdir })` alternatively produces a standalone backend module and manifest; it leaves package dependencies external, so place its output in the application's dependency environment.

Definitions must export exactly one top-level `new CantelopClient({...})` instance. The compiler discovers it by SDK type, regardless of its variable or export name. Named exports are sufficient; default exports are optional. Multiple aliases of the same instance count once; distinct exported clients produce an ambiguity error. Backend compilation preserves the original export names. Options and `sessionRuntime` must be static object literals without spreads. Local helpers and closures are supported, with one top-level variable declaration per statement. The runtime cannot capture its client instance. Keep the definition declarative: top-level effects, bare side-effect imports, ambiguous unused value declarations, and additional value exports are rejected. Put initialization in a referenced runtime module or lifecycle hook. Arbitrary constructor execution cannot be safely split between execution environments.

## Identity and deployment

Project schema 3 still selects the definition:

```json
{ "schema_version": 3, "app": "support-agent", "session": "src/cantelop.ts" }
```

CLI build protocol 6 uses `buildEdgeApi({ definition, outdir })`, `buildSessionRuntime({ definition, outdir, projectRoot? })`, and the backend compiler integration. Identity is generated from the bundled runtime and checked project source contracts. Logic and type-contract edits invalidate it; all variants built from the same inputs carry the same `session_runtime_id`. It is an artifact compatibility marker, not a stable developer-selected name or security credential.

The backend sends `X-Cantelop-Session-Runtime` internally. Edge returns `session_runtime_mismatch` (409) for a missing/different identity before private routing. Compiled identity takes precedence over CLI configuration so stale code cannot silently adopt a newer deployment's identity. For uncompiled development clients, CLI-managed App records may supply `runtimeId`, or App-scoped environment configuration may supply `CANTELOP_SESSION_RUNTIME_ID`. Developers do not pass either field to the constructor. Custom connections own routing, authentication, and reserved metadata.

Watch follows source, imported runtime implementations and type contracts. Invalid edits leave the last successful native artifact manifest intact; repairing them resumes builds. Schema watching remains independent.

The unpublished versions stay unchanged: project schema 3, build protocol 6, integration protocol 2, actor protocol 2. CLI adoption must integrate the backend compiler, build/upload matching Edge/Sandbox artifacts, inject scoped connection metadata, and update init/dev/watch/deploy flows. Platform adoption must validate matching artifact identities. Actor scheduling, targeted cancellation attribution, and durable view publication remain separate follow-ups.
