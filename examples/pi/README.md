# Pi agent integration

`src/cantelop.ts` creates a client and declares a named App with imported handlers from `src/agent.ts`. Application code imports the named `app` handle to select Workspaces and Sessions. `src/agent.ts` exports the provider behavior and is bundled directly for the Sandbox. The [backend compiler transform](../../docs/runtime-definitions.md) excludes provider dependencies from the backend bundle.

```ts
import { app } from "./src/cantelop.js";

const workspace = app.workspace({ slug: "customer-123" });
const session = workspace.session({
  id: "conversation-456",
  keepAliveSeconds: 300,
});
await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
for await (const event of session.stream()) {
  if (event.data.type === "text_delta") console.log(event.data.delta);
}
```

The SDK discovers the App and its scoped integration credential from CLI/runtime configuration. To select another configured App, set `name: "another-agent"` on the App in `src/cantelop.ts`. Select Workspaces by ID or slug, then create any number of Session references from each Workspace. Local CLI adapters can supply the App configuration. This prerelease requires CLI build protocol 6 and runtime-only manifest schema 3; deploy with the companion platform CLI. Provider configuration is declared on the App; keep provider credentials in the runtime environment.

Use `session.steer({type:"prompt",prompt:"adjust the task"})` and
`session.cancel()`. These are SDK work commands delivered through the
same actor transport. They do not require programmable Edge handlers.

Run `pnpm check:examples` from the SDK root to type-check the backend client and runtime and qualify the runtime-only build artifact.

## Runtime behavior

The harness factory creates one Pi Agent per runtime incarnation. The SDK queues prompts and routes steering to the harness’s native `steering(message)` capability. `cancel()` aborts the active Agent operation and preserves waiting SDK input. `PI_PROVIDER` and `PI_MODEL` select the model; the manifest defaults to Anthropic and `claude-sonnet-5`. Selecting another provider also requires changing the credential declaration.
