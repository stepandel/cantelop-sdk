# Agent integration examples

Start with [Claude Code](anthropic/README.md). It uses the Claude Code harness packaged in `@cantelop/sdk/harnesses/claude`, so its whole App is one definition file, and each Workspace signs in with its user's own Claude subscription. The [README's Get started](../README.md#get-started) walks through the same setup.

[The web chat app](web-chat/README.md) is a complete browser → application backend → `CantelopClient` integration. It owns its OpenAI runtime through a named App definition and keeps credentials out of browser code.

[Claude Code](anthropic/README.md), [Codex](codex/README.md), and [OpenCode](opencode/README.md) wrap published stock CLIs directly, following the [claude-code-api pattern](https://github.com/stepandel/claude-code-api). Each starts a subprocess per turn, uses native Workspace-owned authentication, forwards JSON events and resumes its persisted native conversation. Each native runner implements `SessionHarness` with `queue`, `steer` and `cancel` and is returned directly from `runtime.create`. Claude Code is packaged in the SDK; the Codex and OpenCode runners live in their example directories.

All three implement `steer` by admitting priority input and interrupting the current turn; app constructors register `runtime: { create }`. Steering will prioritize the new prompt, interrupt the active operation, wait for process-group cleanup, then resume the native conversation. Provider tools, prompts, permissions and agent loops remain native.

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
import { app } from "./src/cantelop.ts";

const workspace = app.workspace({ slug: "customer-123" });
const session = workspace.session({ id: "conversation-456" });
await session.dispatch({ type: "prompt", prompt: "Investigate this issue" });
for await (const event of session.stream()) {
  render(event.data); // Provider-specific native output type.
}
```

Use the same ID to address an existing Session, or omit it to spawn another Session sharing the Workspace. A canonical Workspace ID can replace the slug selector. Output can be replayed explicitly with the last cursor; disconnecting the iterator does not cancel work. Subscribe before dispatching when live subscription ordering matters, or use retained replay to recover earlier output within the broker's retention window.

Use `session.dispatch(message)` to queue ordinary work, `session.steer(message)` to steer the active harness, and `session.cancel()` to interrupt its current run. Provider examples register a session-scoped `runtime.create` factory. Pi supports native steering, OpenAI Agents and web chat select priority queueing, and the three direct CLI examples select interrupt-and-queue steering. Cancellation preserves waiting harness input, and each harness retains its provider slot until cleanup completes. Custom receive/activity examples remain available for application-owned orchestration.

Codex, Claude and OpenCode forward native JSON events, fragmenting oversized frames. They require no shared provider API keys. Native authentication and conversation metadata live in the user's Workspace; live SQLite state stays local (OpenCode restores through native export/import). Custom images install pinned stock CLIs. These examples’ queues remain incarnation-local; durable pending jobs and recovery are application-owned.

Run and deploy an example with Cantelop CLI 0.15.2 or newer: `cantelop dev` runs it locally, and `cantelop deploy` uploads its generated Edge and Sandbox artifacts and provisions App credentials.

Each deployment example has one `tsconfig.json` covering its application and runtime code. Relative imports use `.ts` to reference the source files directly; TypeScript checks them without emitting files, and the Cantelop compiler bundles deployment artifacts.

Run `pnpm check:examples` from the SDK root to type-check backend clients and runtimes and qualify their runtime-only artifacts. [Application-owned queue](application-queue/README.md) and [supervised activity](supervised-activity/README.md) examples retain persistence, recovery, and subprocess behavior.

[The multi-App example](multi-app/README.md) declares two independently typed Apps on one client and builds separate Edge/Sandbox artifacts.

[Headless GitHub issue agent](github/README.md) defines an optional App webhook route that verifies signed deliveries and dispatches to a repository Workspace and issue Session. Its runtime generates an answer and posts a GitHub comment.
