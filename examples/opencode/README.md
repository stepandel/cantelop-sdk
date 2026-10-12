# Stock OpenCode harness

This example starts one unmodified OpenCode server and native Session per runtime incarnation, then wraps its official client. OpenCode owns conversation state, tools and its agent loop. Cantelop queues calls and forwards the native completed prompt response (`info` and `parts`).

```ts
import { app } from "./src/cantelop.js";

const session = app.workspace({ slug: "project" }).session({ id: "review" });
await session.dispatch({ type: "prompt", prompt: "Review this repository" });
await session.steer({ type: "prompt", prompt: "Focus on authentication" });
await session.cancel();
for await (const event of session.stream()) {
  console.log(event.data.parts.filter(part => part.type === "text").map(part => part.text).join("\n"));
}
```

Subscribe before dispatching, or use retained replay. This minimal wrapper uses the native `session.prompt` completion API rather than consuming partial text from SSE. `steering: "queue"` selects SDK priority queueing; it does not emulate native steering by issuing concurrent prompts. `cancel()` invokes native `session.abort`. The pending prompt remains open until OpenCode completes the interrupted operation, preserving the execution boundary. The server and Session remain available for the next turn.

To wrap a client/session you already construct, import `wrapOpenCode` from `src/agent.ts`:

```ts
runtime: {
  create() {
    return wrapOpenCode(existingClient, existingSessionId);
  },
  steering: "queue",
}
```

The wrapper does not own your server's startup or configuration. The example factory does: it starts the stock server through `createOpencodeServer`, binds it to the incarnation lifetime, and creates one native session through `client.session.create`. Provider errors propagate as failed work; cancellation does not merely close an HTTP reader.

The custom Docker image installs stock `opencode-ai@1.18.30`, aligned with the pinned SDK. Set `ANTHROPIC_API_KEY` as an App secret and optionally configure `OPENCODE_MODEL`. Native OpenCode settings retain control over tools and approvals. Its local session database is distinct from Cantelop's Workspace database; keep the live native database on local disk and use native persistence/recovery when needed.

See [the official OpenCode SDK documentation](https://docs.opencode.ai/docs/sdk/). Run `pnpm check:examples` from the SDK root to type-check and qualify the backend/Edge/native artifacts.
