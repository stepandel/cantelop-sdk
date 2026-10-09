# Pi agent integration

`src/cantelop.ts` configures a `CantelopClient` with a reference to `src/agent.ts`. Application code imports the `cantelop` instance to select Workspaces and Sessions. `src/agent.ts` exports the provider behavior and is bundled directly for the Sandbox. Backend imports do not load it.

```ts
import { cantelop } from "./src/cantelop.js";

const workspace = cantelop.workspace({ slug: "customer-123" });
const session = workspace.session({
  id: "conversation-456",
  keepAliveSeconds: 300,
});
await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
for await (const event of session.stream()) {
  if (event.data.type === "text_delta") console.log(event.data.delta);
}
```

The SDK discovers the App and its scoped integration credential from CLI/runtime configuration. To select another configured App, set `slug: "another-agent"` on the client in `src/cantelop.ts`. Select Workspaces by ID or slug, then create any number of Session references from each Workspace. Local CLI adapters can supply the App configuration. This prerelease requires CLI build protocol 6 and runtime-only manifest schema 3; the existing CLI cannot deploy it yet. Provider configuration is declared in `cantelop.json`; keep provider credentials in the runtime environment.

The runtime still handles its application-defined `prompt`, `steer`, and `cancel` messages. Until named runtime capabilities are implemented, send those custom commands through `dispatch()`. Protocol-level `session.steer(message)` submits the same payload with actor priority; `session.cancel(messageId)` targets one submission. Both require the coordinated platform/runtime follow-up; these examples do not advertise those capabilities yet.

Run `pnpm check:examples` from the SDK root to type-check the backend client and runtime and qualify the runtime-only build artifact.

## Runtime behavior

A prompt received while busy enters the application FIFO queue; active application steering enters Pi's native steering queue. `cancel` aborts the run and clears both queues. `PI_PROVIDER` and `PI_MODEL` select the model; the manifest defaults to Anthropic and `claude-sonnet-5`. Selecting another provider also requires changing the credential declaration.

`cantelop.json` selects `src/cantelop.ts` for deployment. `src/contracts.ts` defines the message and event types shared by application calls and agent behavior.
