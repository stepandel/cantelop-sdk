import { Agent } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SessionContext } from "@cantelop/sdk/session";
import type { SessionEvent, SessionMessage } from "./contracts.js";

type Context = SessionContext<SessionMessage, SessionEvent>;

const models = builtinModels();
let agent: Agent | undefined;

function sessionAgent({ session, env }: Context): Agent {
  if (agent !== undefined) return agent;

  const provider = env.PI_PROVIDER ?? "anthropic";
  const modelId = env.PI_MODEL ?? "claude-sonnet-5";
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

export function receive(context: Context): void {
  const command = context.message.payload;

  if (command.type === "cancel") {
    agent?.clearAllQueues();
    context.activity.cancel();
    return;
  }

  startPrompt(context, command.prompt);
}

export function steer(context: Context): void {
  const command = context.message.payload;
  if (command.type === "cancel" || agent === undefined || !context.activity.active) {
    receive(context);
    return;
  }
  agent.steer({
    role: "user",
    content: command.prompt,
    timestamp: Date.now(),
  });
}

function startPrompt(context: Context, prompt: string): void {
  const currentAgent = sessionAgent(context);

  context.activity.start(async ({ signal, output }) => {
    let answer = "";
    let pendingOutput = Promise.resolve();
    const unsubscribe = currentAgent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const delta = event.assistantMessageEvent.delta;
        answer += delta;
        pendingOutput = pendingOutput.then(() =>
          output.send({ type: "text_delta", delta }),
        );
      }
    });
    const abort = () => currentAgent.abort();
    signal.addEventListener("abort", abort, { once: true });

    try {
      await currentAgent.prompt(prompt);
      await pendingOutput;
      await output.send({ type: "done", answer });
    } finally {
      signal.removeEventListener("abort", abort);
      unsubscribe();
    }
  });
}
