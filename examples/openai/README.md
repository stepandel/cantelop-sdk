# OpenAI Agents integration

This example uses the OpenAI Agents framework. For the stock Codex CLI harness and a reusable Thread adapter, see [the Codex example](../codex/README.md).

`src/cantelop.ts` creates a client and declares a named App with imported handlers from `src/agent.ts`. Application code imports the named `app` handle to select Workspaces and Sessions. `src/agent.ts` exports the provider behavior and is bundled directly for the Sandbox. The [backend compiler transform](../../docs/runtime-definitions.md) excludes provider dependencies from the backend bundle.

```ts
import { app } from "./src/cantelop.ts";

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

The factory creates one Agent and MemorySession per runtime incarnation. The harness’s `queue` method serializes turns; its `steer` method prioritizes input internally. Cancellation signals the active run and preserves waiting input. `OPENAI_API_KEY` is runtime-only, and `OPENAI_MODEL` defaults to `gpt-5-mini`.
