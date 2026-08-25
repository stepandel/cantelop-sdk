import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  defineSessionBehaviour,
  type SessionContext,
} from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

type Context = SessionContext<SessionMessage, SessionEvent>;

const models = builtinModels();
let agent: Agent | undefined;
const promptQueue: string[] = [];

function sessionAgent(
  { session, env }: Context,
): Agent {
  if (agent !== undefined) return agent;

  const provider = env.PI_PROVIDER ?? "anthropic";
  const modelId = env.PI_MODEL ?? "claude-sonnet-4-6";
  const model = models.getModel(provider, modelId);

  if (!model) {
    throw new Error(`Pi model not found: ${provider}/${modelId}`);
  }

  agent = new Agent({
    initialState: {
      systemPrompt: "You are a concise, helpful assistant.",
      model,
    },
    streamFn: models.streamSimple.bind(models),
    sessionId: session.id,
  });
  return agent;
}

export default defineSessionBehaviour<SessionMessage, SessionEvent>((context) => {
  const command = context.message.payload;

  if (command.type === "cancel") {
    promptQueue.length = 0;
    context.activity.cancel();
    return;
  }

  if (command.type === "steer" && context.activity.active && agent !== undefined) {
    agent.steer({
      role: "user",
      content: command.prompt,
      timestamp: Date.now(),
    });
    return;
  }

  if (context.activity.active) {
    promptQueue.push(command.prompt);
    return;
  }

  startPrompt(context, command.prompt);
});

function startPrompt(context: Context, prompt: string): void {
  const currentAgent = sessionAgent(context);

  context.activity.start(async ({ signal, send }) => {
    let answer = "";
    const unsubscribe = currentAgent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const delta = event.assistantMessageEvent.delta;
        answer += delta;
        context.emit({ type: "text_delta", delta });
      }
    });
    const abort = () => currentAgent.abort();
    signal.addEventListener("abort", abort, { once: true });

    try {
      await currentAgent.prompt(prompt);
      context.emit({ type: "done", answer });
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
      const nextPrompt = promptQueue.shift();
      if (!signal.aborted && nextPrompt !== undefined) {
        send({ type: "prompt", prompt: nextPrompt });
      }
    }
  });
}
