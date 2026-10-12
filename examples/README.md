# Agent integration examples

Start with [the web chat app](web-chat/README.md) for a complete browser → application backend → `CantelopClient` integration. It owns its OpenAI runtime through a named App definition and keeps credentials out of browser code.

The OpenAI, Anthropic, Pi, and OpenCode examples define native agent runtimes and ordinary application backend clients:

```text
src/cantelop.ts   Shared client and named App/runtime configuration
src/contracts.ts  Shared message and event types
src/agent.ts      Exported runtime handlers and provider behavior
cantelop.json     Definition module selection
```

Each provider example exports a named `app` on an App-agnostic client with automatic App configuration. Configure the App once; select a Workspace by ID or slug and create Session references from it. It does not define HTTP routes, request validation middleware, or a customer Edge API. Provider SDKs and secrets stay in the runtime. An application can use its own existing routes, jobs, or webhook handlers to call the same client.

```ts
import { app } from "./src/cantelop.js";

const workspace = app.workspace({ slug: "customer-123" });
const session = workspace.session({ id: "conversation-456" });
await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
for await (const event of session.stream()) {
  if (event.data.type === "text_delta") render(event.data.delta);
}
```

Use the same ID to address an existing Session, or omit it to spawn another Session sharing the Workspace. A canonical Workspace ID can replace the slug selector. Output can be replayed explicitly with the last cursor; disconnecting the iterator does not cancel work. Subscribe before dispatching when live subscription ordering matters, or use retained replay to recover earlier output within the broker's retention window.

Use `session.dispatch(message)` for ordinary work, `session.steer(message)` for priority input, and `session.cancel(messageId)` to cancel one submission. Runtimes call `context.activity.queue(work)` to schedule ordinary work behind the active activity. Pi registers an `onSteer` adapter on its activity and calls `context.activity.steer(message)` from the same receive handler. Other examples queue steering input with priority. Cancellation aborts only the target's owned activity.

Anthropic feeds its live input stream. OpenCode uses a headless server and the custom image in its manifest. All propagate managed activity cancellation to provider work. Workspace state is durable; warm runtime/provider memory is not.

This 1.0 prerelease requires the coordinated CLI/platform implementation with CLI build protocol 6 and project manifest schema 3. Generated Edge/native deployment and App credential provisioning are handled by that implementation.

Each deployment example has one `tsconfig.json` covering its application and runtime code.

Run `pnpm check:examples` from the SDK root to type-check backend clients and runtimes and qualify their runtime-only artifacts. [Application-owned queue](application-queue/README.md) and [supervised activity](supervised-activity/README.md) examples retain persistence, recovery, and subprocess behavior.

[The multi-App example](multi-app/README.md) declares two independently typed Apps on one client and builds separate Edge/Sandbox artifacts.

[Headless GitHub issue agent](github/README.md) defines an optional App webhook route that verifies signed deliveries and dispatches to a repository Workspace and issue Session. Its runtime generates an answer and posts a GitHub comment.
