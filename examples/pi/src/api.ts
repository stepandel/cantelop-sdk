import { defineApi } from "@cantelop/sdk/api";
import type {
  ChatRequest,
  CancelRequest,
  EventsRequest,
  SessionMessage,
  SteerRequest,
} from "./contracts.js";

export default defineApi<SessionMessage>(
  ({ app, router }) => {
    router.route("GET", "/health", () =>
      Response.json({ status: "ok", runtime: "pi" }),
    );

    router.route("GET", "/events", ({ request }) => {
      const input = readEventsRequest(request);
      if (input === undefined) {
        return Response.json({
          error: "sessionId, workspaceId, and keepAliveSeconds are required",
        }, { status: 400 });
      }

      const session = app.sessions.open(input);
      return session.events(request);
    });

    router.route("POST", "/chat", async ({ request }) => {
      const input = (await request.json()) as Partial<ChatRequest>;
      if (!isChatRequest(input)) {
        return Response.json({
          error: "workspaceId, keepAliveSeconds, and prompt are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        ...(input.sessionId === undefined ? {} : { id: input.sessionId }),
        workspaceId: input.workspaceId,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const message = await session.dispatch({ type: "prompt", prompt: input.prompt });
      return Response.json({ sessionId: session.id, message }, { status: 202 });
    });

    router.route("POST", "/steer", async ({ request }) => {
      const input = (await request.json()) as Partial<SteerRequest>;
      if (!isSteerRequest(input)) {
        return Response.json({
          error: "sessionId, workspaceId, keepAliveSeconds, and prompt are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        id: input.sessionId,
        workspaceId: input.workspaceId,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const message = await session.dispatch({ type: "steer", prompt: input.prompt });
      return Response.json({ sessionId: session.id, message }, { status: 202 });
    });

    router.route("POST", "/cancel", async ({ request }) => {
      const input = (await request.json()) as Partial<CancelRequest>;
      if (!isCancelRequest(input)) {
        return Response.json({
          error: "sessionId, workspaceId, and keepAliveSeconds are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        id: input.sessionId,
        workspaceId: input.workspaceId,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const message = await session.dispatch({ type: "cancel" });
      return Response.json({ sessionId: session.id, message }, { status: 202 });
    });
  },
);

function isChatRequest(input: Partial<ChatRequest>): input is ChatRequest {
  return (input.sessionId === undefined || typeof input.sessionId === "string") &&
    typeof input.workspaceId === "string" &&
    typeof input.keepAliveSeconds === "number" && Number.isInteger(input.keepAliveSeconds) &&
    typeof input.prompt === "string" && input.prompt.length > 0;
}

function isSteerRequest(input: Partial<SteerRequest>): input is SteerRequest {
  return typeof input.sessionId === "string" &&
    typeof input.workspaceId === "string" &&
    typeof input.keepAliveSeconds === "number" && Number.isInteger(input.keepAliveSeconds) &&
    typeof input.prompt === "string" && input.prompt.length > 0;
}

function isCancelRequest(input: Partial<CancelRequest>): input is CancelRequest {
  return typeof input.sessionId === "string" &&
    typeof input.workspaceId === "string" &&
    typeof input.keepAliveSeconds === "number" && Number.isInteger(input.keepAliveSeconds);
}

function readEventsRequest(request: Request): EventsRequest | undefined {
  const search = new URL(request.url).searchParams;
  if (["sessionId", "workspaceId", "keepAliveSeconds"].some(
    (name) => search.getAll(name).length !== 1,
  )) return undefined;
  const sessionId = search.get("sessionId");
  const workspaceId = search.get("workspaceId");
  const keepAlive = search.get("keepAliveSeconds");
  if (sessionId === null || workspaceId === null ||
      keepAlive === null || !/^\d+$/.test(keepAlive)) return undefined;
  const keepAliveSeconds = Number(keepAlive);
  if (!Number.isSafeInteger(keepAliveSeconds) || keepAliveSeconds > 604_800) {
    return undefined;
  }
  return { sessionId, workspaceId, keepAliveSeconds };
}
