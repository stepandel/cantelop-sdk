# Agent integration examples

The OpenAI, Anthropic, Pi, and OpenCode examples define native agent runtimes and ordinary application backend clients:

```text
src/client.ts     App → Workspace → Session integration
src/contracts.ts  Shared message and event types
src/session.ts    Native provider integration
cantelop.json     Runtime-only project manifest
```

Each provider client exports `createAgentApp()` with automatic App configuration. Configure the App once; select a Workspace by ID or slug and create Session references from it. It does not define HTTP routes, request validation middleware, or a customer Edge API. Provider SDKs and secrets stay in the runtime. An application can use its own existing routes, jobs, or webhook handlers to call the same client.

```ts
import { createAgentApp } from "./src/client.js";

const app = createAgentApp();
const workspace = app.workspace({ slug: "customer-123" });
const session = workspace.session({ id: "conversation-456" });
await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
for await (const event of session.stream()) {
  if (event.data.type === "text_delta") render(event.data.delta);
}
```

Use the same ID to address an existing Session, or omit it to spawn another Session sharing the Workspace. A canonical Workspace ID can replace the slug selector. Output can be replayed explicitly with the last cursor; disconnecting the iterator does not cancel work. Subscribe before dispatching when live subscription ordering matters, or use retained replay to recover earlier output within the broker's retention window.

The examples preserve each provider's application-defined `prompt`, `steer`, and `cancel` protocol and managed activity behavior. They can send those custom commands via `dispatch()`. Protocol-level `session.steer(message)` prioritizes an ordinary message; `session.cancel(messageId)` targets one submission. These require coordinated actor/platform support, which is not advertised by these runtime artifacts yet.

OpenAI queues ordinary work while a run is busy. Anthropic feeds its live input stream. Pi can steer an active Agent. OpenCode uses a headless server and the custom image in its manifest. All propagate managed activity cancellation to provider work. Workspace state is durable; warm runtime/provider memory is not.

This 1.0 prerelease requires CLI build protocol 6 and project manifest schema 3. Generated Edge/native deployment and App credential provisioning are platform/CLI follow-ups. The current CLI must reject this prerelease rather than deploy it as a legacy Edge API project.

Run `pnpm check:examples` from the SDK root to type-check backend clients and runtimes and qualify their runtime-only artifacts. The [database example](database/README.md) demonstrates backend service functions and runtime operations over the same managed Workspace database. [Application-owned queue](application-queue/README.md) and [supervised activity](supervised-activity/README.md) examples retain persistence, recovery, and subprocess behavior.
