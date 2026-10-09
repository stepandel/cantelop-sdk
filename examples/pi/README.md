# Pi agent integration

`src/session.ts` defines the provider integration in the native Session runtime. `src/client.ts` exports the typed `AgentClient` constructor as the root for calls from an existing application backend. There is no customer Edge API, router, or HTTP request contract.

```ts
import { AgentClient } from "./src/client.js";

const cantelop = new AgentClient();
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

The SDK discovers the App and its scoped integration credential from CLI/runtime configuration. To select another configured App, use `new AgentClient({ slug: "another-agent" })`. Select Workspaces by ID or slug, then create any number of Session references from each Workspace. Local CLI adapters can supply the App configuration. This prerelease requires CLI build protocol 6 and runtime-only manifest schema 3; the existing CLI cannot deploy it yet. Provider configuration is declared in `cantelop.json`; keep provider credentials in the runtime environment.

The runtime still handles its application-defined `prompt`, `steer`, and `cancel` messages. Until named runtime capabilities are implemented, send those custom commands through `dispatch()`. Protocol-level `session.steer(message)` submits the same payload with actor priority; `session.cancel(messageId)` targets one submission. Both require the coordinated platform/runtime follow-up; these examples do not advertise those capabilities yet.

Run `pnpm check:examples` from the SDK root to type-check the backend client and runtime and qualify the runtime-only build artifact.

## Runtime behavior

A prompt received while busy enters the application FIFO queue; active application steering enters Pi's native steering queue. `cancel` aborts the run and clears both queues. `PI_PROVIDER` and `PI_MODEL` select the model; the manifest defaults to Anthropic and `claude-sonnet-5`. Selecting another provider also requires changing the credential declaration.

The client and `defineSessionBehaviour(sessionRuntime, handler)` share `src/definition.ts`. Its versioned runtime ID and typed contracts bind the backend to the deployed agent. `cantelop.json` selects that definition; its `entrypoint` selects `src/session.ts`.
