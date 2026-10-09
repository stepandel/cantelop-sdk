# Anthropic agent integration

`src/session.ts` defines the provider integration in the native Session runtime. `src/client.ts` exports `createAgentApp()` as the root for calls from an existing application backend. There is no customer Edge API, router, or HTTP request contract.

```ts
import { createAgentApp } from "./src/client.js";

const app = createAgentApp({ edgeUrl, accessToken });
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

Configure the App once with its deployed Cantelop URL and integration token. Select Workspaces by ID or slug, then create any number of Session references from each Workspace. Local CLI adapters can supply the App configuration. This prerelease requires CLI build protocol 6 and runtime-only manifest schema 3; the existing CLI cannot deploy it yet. Provider configuration is declared in `cantelop.json`; keep provider credentials in the runtime environment.

The runtime still handles its application-defined `prompt`, `steer`, and `cancel` messages. Until named runtime capabilities are implemented, send those custom commands through `dispatch()`. Protocol-level `session.steer(message)` submits the same payload with actor priority; `session.cancel(messageId)` targets one submission. Both require the coordinated platform/runtime follow-up; these examples do not advertise those capabilities yet.

Run `pnpm check:examples` from the SDK root to type-check the backend client and runtime and qualify the runtime-only build artifact.

## Runtime behavior

The actor starts a streaming-input Claude query. While active, ordinary prompts enter the SDK input stream with `later` priority and application steering commands with `now` priority. `cancel` closes the stream and aborts the query. Claude's conversation ID remains runtime state; the mailbox stays responsive because the live query is managed activity. Configure `ANTHROPIC_API_KEY` as a runtime secret.
