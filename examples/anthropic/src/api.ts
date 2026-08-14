import { createRouter, defineApi } from "@cantelop/sdk/api";
import type {
  AnswerOutput,
  CreateSessionRequest,
  ExecuteRequest,
  PromptInput,
} from "./contracts.js";

export default defineApi<PromptInput, AnswerOutput>(
  ({ app }) => {
    const router = createRouter();

    router.route("GET", "/health", () =>
      Response.json({ status: "ok", runtime: "anthropic" }),
    );

    router.route("POST", "/workspaces", async ({ request }) => {
      const input = (await request.json()) as { slug?: unknown };
      if (typeof input.slug !== "string") {
        return Response.json({ error: "slug is required" }, { status: 400 });
      }
      return Response.json(await app.workspaces.create({ slug: input.slug }), { status: 201 });
    });

    router.route("POST", "/sessions", async ({ request }) => {
      const input = (await request.json()) as Partial<CreateSessionRequest>;
      if (typeof input.workspaceId !== "string" || typeof input.keepAliveSeconds !== "number" ||
          !Number.isInteger(input.keepAliveSeconds)) {
        return Response.json({ error: "workspaceId and keepAliveSeconds are required" }, { status: 400 });
      }
      const session = await app.sessions.create({
        workspaceId: input.workspaceId,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      return Response.json({ sessionId: session.id }, { status: 201 });
    });

    router.route("POST", "/execute", async ({ request }) => {
      const input = (await request.json()) as Partial<ExecuteRequest>;
      if (typeof input.sessionId !== "string" || typeof input.prompt !== "string" || input.prompt.length === 0) {
        return Response.json({ error: "sessionId and prompt are required" }, { status: 400 });
      }
      const session = app.sessions.connect(input.sessionId);
      return Response.json(await session.execute({ prompt: input.prompt }, { signal: request.signal }));
    });

    return router;
  },
);
