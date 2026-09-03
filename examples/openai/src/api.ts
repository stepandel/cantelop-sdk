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
      Response.json({ status: "ok", runtime: "openai" }),
    );

    router.route("GET", "/events", ({ request }) => {
      const input = readEventsRequest(request);
      if (input === undefined) {
        return Response.json({
          error: "valid sessionId, workspaceSlug, and keepAliveSeconds are required",
        }, { status: 400 });
      }

      const session = app.sessions.open(input);
      return session.events(request);
    });

    router.route("POST", "/chat", async ({ request }) => {
      const input = await readJson(request);
      if (!isChatRequest(input)) {
        return Response.json({
          error: "valid workspaceSlug, keepAliveSeconds, and prompt are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        ...(input.sessionId === undefined ? {} : { id: input.sessionId }),
        workspaceSlug: input.workspaceSlug,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const message = await session.dispatch({ type: "prompt", prompt: input.prompt });
      return Response.json({ sessionId: session.id, message }, { status: 202 });
    });

    router.route("POST", "/steer", async ({ request }) => {
      const input = await readJson(request);
      if (!isSteerRequest(input)) {
        return Response.json({
          error: "valid sessionId, workspaceSlug, keepAliveSeconds, and prompt are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        id: input.sessionId,
        workspaceSlug: input.workspaceSlug,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const message = await session.dispatch({ type: "steer", prompt: input.prompt });
      return Response.json({ sessionId: session.id, message }, { status: 202 });
    });

    router.route("POST", "/cancel", async ({ request }) => {
      const input = await readJson(request);
      if (!isCancelRequest(input)) {
        return Response.json({
          error: "valid sessionId, workspaceSlug, and keepAliveSeconds are required",
        }, { status: 400 });
      }

      const session = app.sessions.open({
        id: input.sessionId,
        workspaceSlug: input.workspaceSlug,
        keepAliveSeconds: input.keepAliveSeconds,
      });
      const message = await session.dispatch({ type: "cancel" });
      return Response.json({ sessionId: session.id, message }, { status: 202 });
    });
  },
);

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_SLUG = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function isObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function isSessionId(input: unknown): input is string {
  return typeof input === "string" && SESSION_ID.test(input);
}

function isWorkspaceSlug(input: unknown): input is string {
  return typeof input === "string" && WORKSPACE_SLUG.test(input);
}

function isKeepAliveSeconds(input: unknown): input is number {
  return typeof input === "number" && Number.isSafeInteger(input) &&
    input >= 0 && input <= 604_800;
}

function isChatRequest(input: unknown): input is ChatRequest {
  return isObject(input) &&
    (input.sessionId === undefined || isSessionId(input.sessionId)) &&
    isWorkspaceSlug(input.workspaceSlug) &&
    isKeepAliveSeconds(input.keepAliveSeconds) &&
    typeof input.prompt === "string" && input.prompt.length > 0;
}

function isSteerRequest(input: unknown): input is SteerRequest {
  return isObject(input) &&
    isSessionId(input.sessionId) &&
    isWorkspaceSlug(input.workspaceSlug) &&
    isKeepAliveSeconds(input.keepAliveSeconds) &&
    typeof input.prompt === "string" && input.prompt.length > 0;
}

function isCancelRequest(input: unknown): input is CancelRequest {
  return isObject(input) &&
    isSessionId(input.sessionId) &&
    isWorkspaceSlug(input.workspaceSlug) &&
    isKeepAliveSeconds(input.keepAliveSeconds);
}

function readEventsRequest(request: Request): EventsRequest | undefined {
  const search = new URL(request.url).searchParams;
  if (["sessionId", "workspaceSlug", "keepAliveSeconds"].some(
    (name) => search.getAll(name).length !== 1,
  )) return undefined;
  const sessionId = search.get("sessionId");
  const workspaceSlug = search.get("workspaceSlug");
  const keepAlive = search.get("keepAliveSeconds");
  if (!isSessionId(sessionId) || !isWorkspaceSlug(workspaceSlug) ||
      keepAlive === null || !/^\d+$/.test(keepAlive)) return undefined;
  const keepAliveSeconds = Number(keepAlive);
  if (!isKeepAliveSeconds(keepAliveSeconds)) return undefined;
  return { sessionId, workspaceSlug, keepAliveSeconds };
}
