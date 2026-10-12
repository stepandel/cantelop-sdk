# Anthropic agent integration

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

The SDK discovers the App and its scoped integration credential from CLI/runtime configuration. To select another configured App, set `name: "another-agent"` on the App in `src/cantelop.ts`. Select Workspaces by ID or slug, then create any number of Session references from each Workspace. Local CLI adapters can supply the App configuration. This prerelease requires CLI build protocol 6 and runtime-only manifest schema 3; the existing CLI cannot deploy it yet. Provider configuration is declared on the App; keep provider credentials in the runtime environment.

Use `session.dispatch(message)` to queue work, `session.steer(message)` for native steering, and `session.cancel()` to interrupt the active run. The session-scoped factory retains Claude's conversation identity across runs. Each run owns a provider input stream; the SDK remains responsive while that run executes. Steering feeds priority input into its live stream. Cancellation closes that input and aborts the provider operation through the run's signal, preserving queued SDK input.

Run `pnpm check:examples` from the SDK root to type-check clients and runtimes and qualify the build artifacts.

Configure `ANTHROPIC_API_KEY` as a runtime secret. `cantelop.json` selects `src/cantelop.ts` for deployment, and `src/contracts.ts` defines the shared message and event types.
