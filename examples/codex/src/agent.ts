import { Codex, type Thread } from "@openai/codex-sdk";
import type { SessionHarnessContext, SessionHarness } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

export function create(context: SessionHarnessContext): SessionHarness<SessionMessage, SessionEvent> {
  context.signal.throwIfAborted();
  const codex = new Codex({
    codexPathOverride: context.env.CODEX_PATH ?? "/usr/local/bin/codex",
    ...(context.env.OPENAI_API_KEY ? { apiKey: context.env.OPENAI_API_KEY } : {}),
  });
  const thread = codex.startThread({
    workingDirectory: process.cwd(), skipGitRepoCheck: true,
    ...(context.env.CODEX_MODEL ? { model: context.env.CODEX_MODEL } : {}),
  });
  return wrapCodex(thread);
}

/** The official SDK owns the stock CLI, conversation state, tools and cancellation. */
export function wrapCodex(thread: Thread): SessionHarness<SessionMessage, SessionEvent> {
  return {
    async run(message, { signal, output }) {
      signal.throwIfAborted();
      const turn = await thread.runStreamed(message.prompt, { signal });
      let completed = false;
      for await (const event of turn.events) {
        signal.throwIfAborted();
        if (event.type === "turn.failed") throw new Error(event.error.message);
        if (event.type === "error") throw new Error(event.message);
        await output.send(event);
        if (event.type === "turn.completed") completed = true;
      }
      signal.throwIfAborted();
      if (!completed) throw new Error("Codex stream ended before turn completion");
    },
    // runStreamed receives the SDK-managed signal. The native SDK aborts its CLI.
    // It exposes no live steering method, so the App explicitly selects queueing.
  };
}
