import { query, type SDKUserMessage, } from "@anthropic-ai/claude-agent-sdk";
import type { SessionHarnessContext, SessionHarness } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";
export function create(context: SessionHarnessContext): SessionHarness<SessionMessage, SessionEvent> {
  let conversationId: string | undefined;
  let input: ClaudeInput | undefined;
  if (!context.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  return {
    async run(message, { signal, output }) {
      input = new ClaudeInput();
      input.send(message.prompt);
      const abortController = new AbortController();
      const currentInput = input!;
      const abort = () => {
        currentInput.close();
        abortController.abort(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      const messages = query({
        prompt: currentInput,
        options: {
          abortController,
          includePartialMessages: true,
          maxTurns: 10,
          systemPrompt: "You are a concise, helpful assistant.",
          ...(conversationId === undefined ? {} : { resume: conversationId }),
        },
      });
      try {
        for await (const message of messages) {
          if (message.type === "system" && message.subtype === "init") {
            conversationId = message.session_id;
          }
          else if (message.type === "stream_event" &&
            message.event.type === "content_block_delta" &&
            message.event.delta.type === "text_delta") {
            await output.send({ type: "text_delta", delta: message.event.delta.text });
          }
          else if (message.type === "result" && "result" in message) {
            await output.send({ type: "done", answer: message.result });
            currentInput.close();
          }
        }
      }
      finally {
        signal.removeEventListener("abort", abort);
        currentInput.close();
        messages.close();
        if (input === currentInput)
          input = undefined;
      }
    },
    steer(message) { input?.send(message.prompt, "now"); },
  };
}
class ClaudeInput implements AsyncIterable<SDKUserMessage> {
  private readonly messages: SDKUserMessage[] = [];
  private readonly readers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  send(prompt: string, priority?: SDKUserMessage["priority"]): void {
    if (this.closed)
      return;
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      ...(priority === undefined ? {} : { priority }),
    };
    const reader = this.readers.shift();
    if (reader === undefined)
      this.messages.push(message);
    else
      reader({ value: message, done: false });
  }
  close(): void {
    if (this.closed)
      return;
    this.closed = true;
    for (const reader of this.readers)
      reader({ value: undefined, done: true });
    this.readers.length = 0;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const message = this.messages.shift();
        if (message !== undefined) {
          return Promise.resolve({ value: message, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}
