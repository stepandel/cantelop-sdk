import { createApp, defineApi } from "@cantelop/sdk/api";
import type {
  AnswerOutput,
  PromptInput,
} from "./contracts.js";

export default defineApi<PromptInput, AnswerOutput>(
  ({ execution }) => {
    const app = createApp({ execution });

    app.route("GET", "/health", () =>
      Response.json({ status: "ok", runtime: "openai" }),
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

    return app;
  },
);
