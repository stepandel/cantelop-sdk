import { defineApi } from "@cantelop/sdk/api";
import type {
  PiDurableMessage,
  PiDurableReply,
} from "@cantelop/sdk/pi-durable";

export default defineApi<PiDurableMessage, PiDurableReply>(
  ({ app, router }) => {
    router.route("GET", "/health", () =>
      Response.json({ status: "ok", runtime: "pi-durable" }),
    );
    router.route("GET", "/events", ({ request }) => {
      const input = identity(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!input)
        return Response.json(
          { error: "valid workspaceSlug and sessionId required" },
          { status: 400 },
        );
      return app.sessions
        .open({ ...input, keepAliveSeconds: 600 })
        .events(request);
    });
    router.route("POST", "/message", async ({ request }) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (!isObject(body))
        return Response.json({ error: "invalid body" }, { status: 400 });
      const input = identity(body);
      if (
        !input ||
        !isMessage(body.message) ||
        (body.requestId !== undefined &&
          (typeof body.requestId !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.requestId)))
      )
        return Response.json(
          { error: "valid identity, message and optional requestId required" },
          { status: 400 },
        );
      const session = app.sessions.open({ ...input, keepAliveSeconds: 600 });
      const reply = await session.request(
        body.message,
        body.requestId === undefined ? {} : { id: body.requestId },
      );
      return Response.json({ sessionId: session.id, reply });
    });
  },
);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identity(
  value: Record<string, unknown>,
): { id: string; workspaceSlug: string } | undefined {
  if (
    typeof value.sessionId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.sessionId) ||
    typeof value.workspaceSlug !== "string" ||
    !/^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.workspaceSlug)
  )
    return undefined;
  return { id: value.sessionId, workspaceSlug: value.workspaceSlug };
}
function isMessage(value: unknown): value is PiDurableMessage {
  if (!isObject(value)) return false;
  const id = (x: unknown) =>
    typeof x === "number" && Number.isSafeInteger(x) && x > 0;
  switch (value.type) {
    case "input":
      return (
        typeof value.content === "string" &&
        value.content.length > 0 &&
        (value.whenBusy === undefined ||
          ["steer", "followUp", "reject"].includes(String(value.whenBusy))) &&
        (value.conversationId === undefined || id(value.conversationId))
      );
    case "snapshot":
      return value.conversationId === undefined || id(value.conversationId);
    case "abortSubmission":
      return id(value.submissionId);
    case "abortTask":
      return id(value.taskId);
    case "resume":
      return true;
    default:
      return false;
  }
}
