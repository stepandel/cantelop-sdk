import { Agent, MemorySession, run } from "@openai/agents";
import {
  defineHarness,
  type HarnessContext,
} from "@cantelop/sdk/harness";
import type {
  AnswerOutput,
  PromptInput,
} from "./contracts.js";

type RuntimeEvent =
  | { type: "text_delta"; delta: string }
  | { type: "done"; output: AnswerOutput };

const queuedPrompts: string[] = [];
let providerSession: MemorySession | undefined;

function startTurn(
  context: HarnessContext<PromptInput, RuntimeEvent>,
  prompt: string,
): void {
  const { env, session, activity, emit } = context;
  activity.start(async ({ signal, send }) => {
    try {
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not configured in the harness VM");
      }
      const agent = new Agent({
        name: "Cantelop OpenAI example",
        instructions: "You are a concise, helpful assistant.",
        model: env.OPENAI_MODEL ?? "gpt-4.1-mini",
      });
      providerSession ??= new MemorySession({ sessionId: session.id });

      const stream = await run(agent, prompt, {
        stream: true,
        signal,
        session: providerSession,
      });
      let answer = "";
      for await (const delta of stream.toTextStream()) {
        answer += delta;
        emit({ type: "text_delta", delta });
      }
      await stream.completed;
      emit({
        type: "done",
        output: { answer: stream.finalOutput ?? answer },
      });
    } finally {
      const nextPrompt = queuedPrompts.shift();
      if (nextPrompt !== undefined) {
        send({ type: "message", prompt: nextPrompt });
      }
    }
  });
}

async function receive(
  context: HarnessContext<PromptInput, RuntimeEvent>,
): Promise<void> {
  const command = context.message.payload;

  if (command.type === "cancel") {
    queuedPrompts.length = 0;
    context.activity.cancel();
    return;
  }

  if (context.activity.active) {
    queuedPrompts.push(command.prompt);
    return;
  }

  startTurn(context, command.prompt);
}

export default defineHarness<PromptInput, RuntimeEvent>({ receive });
