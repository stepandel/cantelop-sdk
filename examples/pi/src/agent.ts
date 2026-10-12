import { TurnQueue } from "../../harness/queue.js";
import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SessionHarnessContext, SessionHarness } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";
const models = builtinModels();
export function create({ session, env, signal: lifetime }: SessionHarnessContext): SessionHarness<SessionMessage, SessionEvent> {
  const provider = env.PI_PROVIDER ?? "anthropic";
  const modelId = env.PI_MODEL ?? "claude-sonnet-5";
  const model = models.getModel(provider, modelId);
  if (!model) {
    throw new Error(`Pi model not found: ${provider}/${modelId}`);
  }
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a concise, helpful assistant.",
      model,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: session.id,
  });
  const turns = new TurnQueue<SessionMessage, SessionEvent>(async (message, { signal, output }) => {
    let answer = "";
    let pendingOutput = Promise.resolve();
    let outputFailure: { error: unknown } | undefined;
    const workSignal = AbortSignal.any([signal, lifetime]);
    const abort = () => agent.abort();
    workSignal.addEventListener("abort", abort, { once: true });
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        answer += delta;
        pendingOutput = pendingOutput.then(async () => {
          if (!outputFailure) await output.send({ type: "text_delta", delta });
        }).catch(error => { outputFailure ??= { error }; agent.abort(); });
      }
    });
    try {
      workSignal.throwIfAborted();
      await agent.prompt(message.prompt);
      await pendingOutput;
      if (outputFailure) throw outputFailure.error;
      workSignal.throwIfAborted();
      await output.send({ type: "done", answer });
    }
    finally {
      unsubscribe();
      workSignal.removeEventListener("abort", abort);
      await pendingOutput;
    }
  }, lifetime);
  return {
    queue: (message, work) => turns.enqueue(message, work),
    steer(message, work) {
      if (!turns.active) return turns.enqueue(message, work, true);
      work.signal.throwIfAborted();
      agent.steer({ role: "user", content: message.prompt, timestamp: Date.now() });
    },
    cancel: () => turns.cancel(),
  };
}
