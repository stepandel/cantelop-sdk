# Stock Claude Code harness

This example wraps one persistent native `Query` from `@anthropic-ai/claude-agent-sdk`. Claude Code owns its tools, conversation, agent loop and interruption. Cantelop queues work and forwards the SDK's native `SDKMessage` values, including tool events, partial output and turn results.

```ts
import { app } from "./src/cantelop.js";

const session = app.workspace({ slug: "project" }).session({ id: "review" });
await session.dispatch({ type: "prompt", prompt: "Review this repository" });
await session.steer({ type: "prompt", prompt: "Focus on authentication" });
await session.cancel();
for await (const event of session.stream()) {
  const message = event.data;
  if (message.type === "result" && message.subtype === "success") console.log(message.result);
}
```

Subscribe before dispatching for live output, or use retained replay. Ordinary input is scheduled by Cantelop. Steering sends a native user message with `now` priority into Claude's documented streaming-input API. `cancel()` calls `Query.interrupt()` and keeps the same Query available for subsequent runs. A cancelled run consumes through its native result boundary before Cantelop can reuse the execution slot.

To adapt a streaming Query and input transport you already construct, import `wrapClaude` from `src/agent.ts`:

```ts
runtime: {
  create(context) {
    const { query, input } = createExistingClaudeHarness(context);
    return wrapClaude(query, input);
  },
}
```

The input transport exposes `send(prompt, priority?)`; it can be your existing channel. The included `ClaudeInput` implements the official `AsyncIterable<SDKUserMessage>` transport contract. It does not implement an agent loop. The wrapper calls `Query.next()` through each turn result without closing the native iterator between turns.

The example factory starts the stock harness, waits for native initialization, and closes it when the runtime incarnation ends. It preserves native prompts, tools and configuration. Set `ANTHROPIC_API_KEY` as an App secret. The custom image installs stock Claude Code `2.1.259`, matching the installed Agent SDK's `claudeCodeVersion`. `CLAUDE_PATH` defaults to `/usr/local/bin/claude`; override it for a local installation. Configure approvals and other provider behavior through native SDK options when constructing your own Query.

Native Claude session persistence/resume remains independent of Cantelop's queue and Workspace database. See [Claude's streaming-input documentation](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode). Run `pnpm check:examples` from the SDK root to type-check and qualify the backend/Edge/native artifacts.
