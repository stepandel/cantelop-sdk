# Stock Codex harness

This example adapts the official `@openai/codex-sdk` Thread to Cantelop. The SDK runs the unmodified Codex CLI and owns its conversation history, tool loop and subprocess cancellation. Cantelop schedules calls and forwards native `ThreadEvent` values.

```ts
import { app } from "./src/cantelop.js";

const session = app.workspace({ slug: "project" }).session({ id: "review" });
await session.dispatch({ type: "prompt", prompt: "Review this repository" });
await session.steer({ type: "prompt", prompt: "Focus on authentication" });
await session.cancel();
for await (const event of session.stream()) {
  if (event.data.type === "item.completed" && event.data.item.type === "agent_message") {
    console.log(event.data.item.text);
  }
}
```

Subscribe before dispatching for live output, or use retained replay. `steering: "queue"` explicitly queues priority input because the TypeScript SDK has no native live-steering method. Cancellation reaches the stock SDK through `runStreamed(prompt, { signal })`. The same Thread object is reused across turns; the SDK starts/resumes its CLI as needed.

To adapt a Thread you already construct, import `wrapCodex` from `src/agent.ts`:

```ts
runtime: {
  create(context) {
    const thread = existingCodex.startThread(existingThreadOptions);
    return wrapCodex(thread);
  },
  steering: "queue",
}
```

The wrapper does not replace Codex's tools, prompts, sandbox policy or agent loop. Configure those through native Codex options. The example factory sets only working directory, optional model and executable location. Set `OPENAI_API_KEY` as an App secret. `CODEX_MODEL` is optional and otherwise uses Codex's configured default.

The custom Docker image installs stock `@openai/codex@0.162.1`, matching the pinned SDK. `CODEX_PATH` defaults to `/usr/local/bin/codex`; override it for a local installation. An explicit path keeps native executable lookup independent of the compiled runtime bundle. The CLI's own local state is distinct from Cantelop's Workspace database; use native thread persistence/resume when recovering across incarnations.

See [the official Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk). Run `pnpm check:examples` from the SDK root to type-check and qualify the backend/Edge/native artifacts.
