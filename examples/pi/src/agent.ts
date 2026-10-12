import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SessionHarnessContext, SessionHarness } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";
const models = builtinModels();
export function create({ session, env }: SessionHarnessContext): SessionHarness<SessionMessage, SessionEvent> {
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
  return {
    async run(message, { signal, output }) {
      const currentAgent = agent;
      let answer = "";
      let pendingOutput = Promise.resolve();
      const unsubscribe = currentAgent.subscribe((event) => {
        if (event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta") {
          const delta = event.assistantMessageEvent.delta;
          answer += delta;
          pendingOutput = pendingOutput.then(() => output.send({ type: "text_delta", delta }));
        }
      });
      try {
        await currentAgent.prompt(message.prompt);
        await pendingOutput;
        signal.throwIfAborted();
        await output.send({ type: "done", answer });
      }
      finally {
        unsubscribe();
      }
    },
    steer(message) {
      agent.steer({ role: "user", content: message.prompt, timestamp: Date.now() });
    },
    cancel() { agent.abort(); },
  };
}
