import { createApp, defineApi } from "@cantelop/sdk/api";
import type {
  AnswerOutput,
  PromptInput,
  RuntimeEvent,
} from "./contracts.js";
import { eventStreamResponse } from "./event-stream.js";

export function definePromptApi(runtime: string) {
  return defineApi<PromptInput, AnswerOutput, RuntimeEvent>(({ execution }) => {
    const app = createApp({ execution });

    app.route("GET", "/health", () =>
      Response.json({ status: "ok", runtime }),
    );

    app.route("POST", "/execute", async ({ request, execution }) => {
      const input = (await request.json()) as Partial<PromptInput>;
      if (typeof input.prompt !== "string" || input.prompt.length === 0) {
        return Response.json({ error: "prompt is required" }, { status: 400 });
      }

      const run = await execution.start(
        { prompt: input.prompt },
        { signal: request.signal },
      );
      const output = await run.wait();
      return Response.json({ executionId: run.id, ...output });
    });

    app.route("POST", "/execute/stream", async ({ request, execution }) => {
      const input = (await request.json()) as Partial<PromptInput>;
      if (typeof input.prompt !== "string" || input.prompt.length === 0) {
        return Response.json({ error: "prompt is required" }, { status: 400 });
      }

      const run = await execution.start(
        { prompt: input.prompt },
        { signal: request.signal },
      );
      return eventStreamResponse(run.events(), {
        eventName: (event) => event.type,
        headers: { "x-execution-id": run.id },
      });
    });

    return app;
  });
}
