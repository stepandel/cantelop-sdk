# Client, App, and compiled runtime

`CantelopClient` supplies shared connection context. Each named App owns its runtime, deployment configuration, and Workspace namespace:

```ts
import { CantelopClient } from "@cantelop/sdk";
import { receiveSupport } from "./support.js";
import { receiveResearch } from "./research.js";
import type { SupportMessage, SupportEvent, ResearchMessage, ResearchReply } from "./contracts.js";

const cantelop = new CantelopClient();

export const support = cantelop.app<SupportMessage, SupportEvent>({
  name: "support-agent",
  runtime: { receive: receiveSupport },
  environment: { OPENAI_API_KEY: { secret: true, required: true } },
});

export const research = cantelop.app<ResearchMessage, never, ResearchReply>({
  name: "research-agent",
  runtime: { receive: receiveResearch },
});

support.workspace({ slug: "customer-123" }).session({ id: "conversation-456" });
```

An App name is its existing deployment slug within the selected account/environment. Export names are JavaScript names; renaming `support` does not rename the App. Multiple Apps can share one client. Multiple clients can use different profiles. Names must be unique within a client and within a definition module; there is no process-wide singleton. App construction is local and never provisions or deploys resources.

The required `runtime` contains `receive` and optional `onActivate`, `onRecover`, and boolean `redelivery`. Handlers can be inline or ordinary imported functions. The first three App generics type messages, events and replies, including contextual handler types; the fourth types view state. Runtime IDs remain compiler-owned. No decorators, default exports, implementation path, behavior factory, or client subclass are required. Workspace/Session lifecycle is unchanged.

App `environment` declares secret/required values and non-secret defaults; actual secrets stay in external CLI/platform configuration. Secret declarations cannot include defaults. An optional project-relative `dockerfile` selects a custom Sandbox image. These belong to each App, allowing different providers/configuration in one project.

## Compiler boundary

The compiler reads source without importing or executing customer code. It discovers exported SDK App instances by type and explicit name, and generates:

- One Sandbox runtime per App, containing its handlers, referenced local declarations/imports, and the SDK listener. The definition's client/App construction is excluded.
- One protocol Edge Worker per App, with generated runtime compatibility identity.
- A shared backend module preserving the client, App names, configuration and original exports, while replacing every runtime with an inert implementation and compiler-owned identity. Runtime-only providers/helpers/state are removed.

Backend bundlers must apply the transform. Untransformed imports follow normal JavaScript semantics and load their dependencies:

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

The build module remains tooling and stays out of application runtime bundles. `buildBackendClient({ definition, outdir })` alternatively produces a shared backend module and a manifest listing its Apps/identities. Package dependencies remain external, so keep its output in the application's dependency environment.

Definitions must export Apps created by top-level `cantelop.app({...})` calls on an SDK client. Names must be string literals. App options and runtime must be static object literals without spreads; deployment declarations use literal values. Aliases of one App count once; duplicate names on distinct App definitions fail. Local helper declarations and closures are supported, with one top-level variable declaration per statement. Runtime handlers cannot capture App/client instances. Keep definitions declarative: top-level effects, bare side-effect imports, ambiguous unused value declarations, and unrelated value exports are rejected. Put initialization in a referenced runtime module or lifecycle hook.

Build validation checks reachable source with TypeScript and the nearest project config, including handler parameter compatibility. JavaScript and `any` retain their normal checking limits. Priority scheduling, targeted cancellation attribution, and durable view publication still need coordinated actor/platform support.

## Build and deployment

Project schema 3 selects a module, without duplicating App names or runtime configuration:

```json
{ "schema_version": 3, "definition": "src/cantelop.ts" }
```

`buildAppArtifacts({ definition, outdir, projectRoot? })` builds every App into `<outdir>/<app-name>/edge` and `<outdir>/<app-name>/runtime`, plus a shared backend under `<outdir>/backend`. It rejects inconsistent identities if inputs change during the build.

Individual `buildEdgeApi({ definition, outdir, app? })`, `buildSessionRuntime({ definition, outdir, projectRoot?, app? })`, and `watchLocalProject({ sessionDefinition, sessionRuntimeOutdir, app?, ... })` accept an App name selector. It is optional for a single-App module and required for multiple Apps. Unknown names fail. Edge/native manifests contain `app_name`, `session_runtime_id`, and applicable environment/image configuration.

Runtime identity is generated from each App’s bundled implementation, name, structural type contract and deployment configuration. Editing one App preserves an unchanged sibling’s identity; changes to shared runtime dependencies can affect both. Logic/type edits invalidate compatibility identity; it is not a security credential. Each compiled App sends its identity in `X-Cantelop-Session-Runtime`; Edge returns `session_runtime_mismatch` (409) for a missing/different value before private routing. Compiled identity takes precedence over CLI metadata, so stale code cannot adopt a newer deployment's identity.

Watch follows implementation and type dependencies. Invalid edits preserve the last successful native manifest and repairs resume builds. Schema watching remains independent. Project `db/schema.ts` applies to the selected Apps' isolated Workspace databases.

The unpublished versions stay unchanged: project schema 3, CLI build protocol 6, integration protocol 2, actor protocol 2. CLI adoption must discover/build/select named Apps, provision scoped metadata, honor per-App environment/images, integrate backend compilation, and deploy matching artifacts. Platform adoption must deploy each App hostname and validate its matching identity. Existing production CLI/platform paths cannot deploy this alpha yet.
