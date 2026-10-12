import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionHarnessContext, SessionHarness, Awaitable } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

export async function create(context: SessionHarnessContext): Promise<SessionHarness<SessionMessage, SessionEvent>> {
  context.signal.throwIfAborted();
  const input = new ClaudeInput();
  // This is the stock Claude Code harness. The iterable only transports user input.
  const harness = query({
    prompt: input,
    options: {
      cwd: process.cwd(), includePartialMessages: true,
      pathToClaudeCodeExecutable: context.env.CLAUDE_PATH ?? "/usr/local/bin/claude",
    },
  });
  context.signal.addEventListener("abort", () => {
    input.close();
    harness.close();
  }, { once: true });
  try {
    await harness.initializationResult();
    context.signal.throwIfAborted();
    return wrapClaude(harness, input);
  } catch (error) {
    input.close();
    harness.close();
    throw error;
  }
}

/** Adapt an existing streaming Query and its input channel without changing its agent loop. */
export function wrapClaude(
  harness: Query,
  input: { send(prompt: string, priority?: SDKUserMessage["priority"]): Awaitable<void> },
): SessionHarness<SessionMessage, SessionEvent> {
  return {
    async run(message, { signal, output }) {
      signal.throwIfAborted();
      await input.send(message.prompt);
      let deliveryFailed = false;
      let deliveryError: unknown;
      // Calling next() preserves the Query across turns. Breaking a for-await
      // loop would call return() and close the native streaming harness.
      while (true) {
        const next = await harness.next();
        if (next.done) throw new Error("Claude query ended before a turn result");
        const event = next.value;
        if (event.type === "result") {
          // Keep consuming to the native turn boundary even after interruption.
          signal.throwIfAborted();
          if (deliveryFailed) throw deliveryError;
          if (event.subtype !== "success") throw new Error(event.errors.join("\n"));
          if (event.is_error) throw new Error(event.result);
          await output.send(event);
          return;
        }
        if (!signal.aborted && !deliveryFailed) {
          try { await output.send(event); }
          catch (error) {
            // Even a cancelled output handoff must drain the old turn before
            // the persistent Query can accept the next SDK-owned run.
            deliveryFailed = true;
            deliveryError = error;
            if (!signal.aborted) await harness.interrupt().catch(() => undefined);
          }
        }
      }
    },
    steer(message) { return input.send(message.prompt, "now"); },
    async cancel() { await harness.interrupt(); },
  };
}

/** Input transport for the native SDK's documented AsyncIterable API. */
export class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private readonly messages: SDKUserMessage[] = [];
  private reader: ((value: IteratorResult<SDKUserMessage>) => void) | undefined;
  private closed = false;

  send(prompt: string, priority?: SDKUserMessage["priority"]): void {
    if (this.closed) throw new Error("Claude input is closed");
    const message: SDKUserMessage = {
      type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null,
      ...(priority === undefined ? {} : { priority }),
    };
    if (this.reader) {
      const reader = this.reader;
      this.reader = undefined;
      reader({ value: message, done: false });
    } else this.messages.push(message);
  }

  close(): void {
    this.closed = true;
    this.messages.length = 0;
    this.reader?.({ value: undefined, done: true });
    this.reader = undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => {
      const message = this.messages.shift();
      if (message) return Promise.resolve({ value: message, done: false });
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => { this.reader = resolve; });
    } };
  }
}
