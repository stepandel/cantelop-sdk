# Agent integration examples

Start with [the web chat app](web-chat/README.md) for a complete browser → application backend → `CantelopClient` integration. It owns its OpenAI runtime through a named App definition and keeps credentials out of browser code.

[Codex](codex/README.md), [Claude Code](anthropic/README.md), and [OpenCode](opencode/README.md) wrap published stock CLIs directly, following the [claude-code-api pattern](https://github.com/stepandel/claude-code-api). Each starts a subprocess per turn, uses native Workspace-owned authentication, forwards JSON events and resumes its persisted native conversation. Each native runner implements `SessionHarness.run(message, work)` and is returned directly from `runtime.create`, without a wrapper function.

All three select `steering: "interrupt"`: prioritize the new prompt, interrupt the active operation, wait for process-group cleanup, then resume the native conversation. Provider tools, prompts, permissions and agent loops remain native.

[OpenAI Agents](openai/README.md), [Pi](pi/README.md), and the web chat example show additional integrations. OpenAI Agents is a separate framework example; it is not the Codex harness.

The examples define runtime factories and ordinary application backend clients:

```text
src/cantelop.ts   Shared client and named App/runtime configuration
src/contracts.ts  Shared message and event types
src/agent.ts      Runtime factory and native harness adapter
cantelop.json     Definition module selection
```

Each provider example exports a named `app` on an App-agnostic client with automatic App configuration. Configure the App once; select a Workspace by ID or slug and create Session references from it. It does not define HTTP routes, request validation middleware, or a customer Edge API. Provider CLIs/SDKs stay in the runtime; native authentication remains in the user's Workspace. An application can use its own existing routes, jobs, or webhook handlers to call the same client.

```ts
import { app } from "./src/cantelop.js";

const workspace = app.workspace({ slug: "customer-123" });
const session = workspace.session({ id: "conversation-456" });
await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
for await (const event of session.stream()) {
  render(event.data); // Provider-specific native output type.
}
```

Use the same ID to address an existing Session, or omit it to spawn another Session sharing the Workspace. A canonical Workspace ID can replace the slug selector. Output can be replayed explicitly with the last cursor; disconnecting the iterator does not cancel work. Subscribe before dispatching when live subscription ordering matters, or use retained replay to recover earlier output within the broker's retention window.

Use `session.dispatch(message)` to queue ordinary work, `session.steer(message)` to steer the active harness, and `session.cancel()` to interrupt its current run. Provider examples register a session-scoped `runtime.create` factory. Pi supports native steering, OpenAI Agents and web chat select priority queueing, and the three direct CLI examples select interrupt-and-queue steering. Cancellation preserves waiting SDK input, and the execution slot stays occupied until cleanup completes. Custom receive/activity examples remain available for application-owned orchestration.

Codex, Claude and OpenCode forward native JSON events, fragmenting oversized frames. They require no shared provider API keys. Native authentication and conversation metadata live in the user's Workspace; live SQLite state stays local (OpenCode restores through native export/import). Custom images install pinned stock CLIs. SDK queues remain incarnation-local; durable pending jobs and recovery are application-owned.

This 1.0 prerelease requires the coordinated CLI/platform implementation with CLI build protocol 6 and project manifest schema 3. Generated Edge/native deployment and App credential provisioning are handled by that implementation.

Each deployment example has one `tsconfig.json` covering its application and runtime code.

Run `pnpm check:examples` from the SDK root to type-check backend clients and runtimes and qualify their runtime-only artifacts. [Application-owned queue](application-queue/README.md) and [supervised activity](supervised-activity/README.md) examples retain persistence, recovery, and subprocess behavior.

[The multi-App example](multi-app/README.md) declares two independently typed Apps on one client and builds separate Edge/Sandbox artifacts.

[Headless GitHub issue agent](github/README.md) defines an optional App webhook route that verifies signed deliveries and dispatches to a repository Workspace and issue Session. Its runtime generates an answer and posts a GitHub comment.
