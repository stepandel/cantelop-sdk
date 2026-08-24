import { defineApi } from "@cantelop/sdk/api";
import type {
  AnswerOutput,
  PromptInput,
  SessionExecutionRequest,
} from "./contracts.js";

export default defineApi<PromptInput, AnswerOutput>(
  ({ app, router }) => {
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

    router.route("POST", "/execute", async ({ request }) => {
      const input = (await request.json()) as Partial<SessionExecutionRequest>;
      if (!isSessionExecutionRequest(input)) {
        return Response.json({
          error: "workspaceId, keepAliveSeconds, and prompt are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        ...(input.sessionId === undefined ? {} : { id: input.sessionId }),
        workspaceId: input.workspaceId,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const output = await session.execute({ prompt: input.prompt }, { signal: request.signal });
      return Response.json({ sessionId: session.id, output });
    });

    router.route("POST", "/dispatch", async ({ request }) => {
      const input = (await request.json()) as Partial<SessionExecutionRequest>;
      if (!isSessionExecutionRequest(input)) {
        return Response.json({
          error: "workspaceId, keepAliveSeconds, and prompt are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        ...(input.sessionId === undefined ? {} : { id: input.sessionId }),
        workspaceId: input.workspaceId,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const receipt = await session.dispatch({ prompt: input.prompt });
      return Response.json({ sessionId: session.id, receipt }, { status: 202 });
    });

  },
);

function isSessionExecutionRequest(
  input: Partial<SessionExecutionRequest>,
): input is SessionExecutionRequest {
  return (input.sessionId === undefined || typeof input.sessionId === "string") &&
    typeof input.workspaceId === "string" &&
    typeof input.keepAliveSeconds === "number" && Number.isInteger(input.keepAliveSeconds) &&
    typeof input.prompt === "string" && input.prompt.length > 0;
}
