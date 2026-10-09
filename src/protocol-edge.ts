import { assertRuntimeID } from "./session-runtime-contract.js";
import type { AppCommandEnvelope, SessionCommand, WorkspaceSelector } from "./integration.js";
import { APP_COMMAND_PATH, MAX_COMMAND_BYTES, assertKeepAlive, record, validateCommand } from "./integration-protocol.js";

/** Internal protocol implementation. No customer API factory or routing hooks. */
export interface ProtocolEdgeOptions {
  readonly runtimeId: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly runtimeOrigin?: string;
}
class EdgeFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/** The platform supplies App authentication, defaults and trusted outbound routing. */
export function createProtocolWorker(options: ProtocolEdgeOptions) {
  assertRuntimeID(options?.runtimeId);
  const runtimeId = options.runtimeId;
  const runtimeFetch = options.fetch ?? ((request: Request) => fetch(request));
  const origin = options.runtimeOrigin ?? "https://runtime.cantelop.internal";
  return Object.freeze({
    async fetch(request: Request, bindings: Readonly<Record<string, unknown>> = {}): Promise<Response> {
      try {
        await authenticate(request, bindings.CANTELOP_INTEGRATION_TOKEN);
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== APP_COMMAND_PATH || url.search) throw new EdgeFailure("not_found", 404);
        if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new EdgeFailure("invalid_command", 400);
        let envelope: AppCommandEnvelope;
        try { envelope = validateCommand(await readJSON(request)); }
        catch (error) { if (error instanceof EdgeFailure) throw error; throw new EdgeFailure("invalid_command", 400); }
        if (request.headers.get("X-Cantelop-Session-Runtime") !== runtimeId) throw new EdgeFailure("session_runtime_mismatch", 409);
        const { workspace, session, command } = envelope;
        async function invoke(path: string, method: "GET" | "POST" | "DELETE", body?: unknown, stream = false): Promise<Response> {
          // Caller auth/context headers never cross this boundary. Outbound routing binds the App.
          const response = await runtimeFetch(new Request(new URL(path, origin), {
            method, signal: request.signal, redirect: "manual",
            headers: stream ? { Accept: "text/event-stream" } : body === undefined ? {} : { "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }));
          if (stream) return response;
          if (response.status === 204) return Response.json({ protocolVersion: 2, id: envelope.id });
          const value = await readJSON(response);
          if (!response.ok) return Response.json(value, { status: response.status });
          if (!record(value)) throw new EdgeFailure("invalid_platform_response", 502);
          return Response.json({ ...value, protocolVersion: 2 }, { status: response.status });
        }
        async function resolveWorkspace(): Promise<string> {
          if (workspace.id !== undefined) return workspace.id;
          const response = await invoke("/__cantelop/v1/workspaces/open", "POST", { slug: workspace.slug });
          if (!response.ok) throw await remoteFailure(response);
          const value = await readJSON(response);
          if (!record(value) || typeof value.id !== "string" || !/^wsp_[0-9a-f]{32}$/.test(value.id) || value.slug !== workspace.slug) throw new EdgeFailure("invalid_platform_response", 502);
          return value.id;
        }
        if (session === null) {
          switch (command.type) {
            case "workspace.resolve":
              return workspace.id === undefined
                ? invoke("/__cantelop/v1/workspaces/open", "POST", { slug: workspace.slug })
                : invoke(`/__cantelop/v1/workspaces/${workspace.id}`, "GET");
            case "workspace.database":
              return invoke("/__cantelop/v1/workspaces/database/credentials", "POST", { workspace_id: await resolveWorkspace() });
          }
        }
        const scopedPath = (suffix = "") => sessionPath(session!.id, workspace, suffix);
        // Each operation owns its semantics here; no client-selected private path is forwarded.
        const sessionCommand = command as SessionCommand;
        switch (sessionCommand.type) {
          case "dispatch": case "steer": case "request": {
            const submission = sessionCommand;
            const defaultValue = bindings.CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS;
            const keepAliveSeconds = submission.keepAliveSeconds ?? (typeof defaultValue === "string" && /^\d+$/.test(defaultValue) ? Number(defaultValue) : defaultValue);
            try { assertKeepAlive(keepAliveSeconds); if (keepAliveSeconds === undefined) throw new TypeError(); }
            catch { throw new EdgeFailure("keep_alive_not_configured", 503); }
            const workspaceId = await resolveWorkspace();
            return invoke(`/__cantelop/integration/v2/${submission.type === "request" ? "requests" : "messages"}`, "POST", {
              session: { id: session!.id, workspace_id: workspaceId, keep_alive_seconds: keepAliveSeconds },
              message: { id: envelope.id, payload: submission.message },
              priority: submission.type === "steer" ? "priority" : "normal",
              ...(submission.type === "request" ? { timeout_ms: submission.timeoutMs } : {}),
            });
          }
          case "cancel": {
            const cancel = sessionCommand;
            return invoke(scopedPath(`/messages/${cancel.messageId}/cancel`), "POST", { id: envelope.id });
          }
          case "status": {
            const status = sessionCommand;
            return invoke(scopedPath(`/messages/${status.messageId}`), "GET");
          }
          case "stop": return invoke(scopedPath(), "DELETE");
          case "view": return invoke(scopedPath("/view"), "GET");
          case "stream": {
            const stream = sessionCommand;
            const url = new URL(scopedPath("/events"), origin);
            if (stream.after !== undefined) {
              url.searchParams.set("stream_id", stream.after.streamId);
              url.searchParams.set("after", String(stream.after.sequence));
            }
            return invoke(url.pathname + url.search, "GET", undefined, true);
          }
        }
        throw new EdgeFailure("invalid_command", 400);
      } catch (error) {
        if (error instanceof EdgeFailure) return failure(error.code, error.status);
        if (request.signal.aborted) throw request.signal.reason;
        return failure("command_outcome_unknown", 502);
      }
    },
  });
}
function sessionPath(id: string, workspace: WorkspaceSelector, suffix: string): string {
  const query = new URLSearchParams(workspace.id === undefined ? { workspace_slug: workspace.slug } : { workspace_id: workspace.id });
  return `/__cantelop/integration/v2/sessions/${encodeURIComponent(id)}${suffix}?${query}`;
}
async function authenticate(request: Request, token: unknown): Promise<void> {
  if (typeof token !== "string" || !token) throw new EdgeFailure("integration_not_configured", 503);
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [expected, actual] = await Promise.all([digest(`Bearer ${token}`), digest(request.headers.get("Authorization") ?? "")]);
  const left = new Uint8Array(expected), right = new Uint8Array(actual);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  if (difference !== 0) throw new EdgeFailure("unauthorized", 401);
}
async function readJSON(source: Request | Response): Promise<unknown> {
  if (!source.body) throw new EdgeFailure("invalid_json", 400);
  const reader = source.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, text = "", done = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      bytes += chunk.value.byteLength;
      if (bytes > MAX_COMMAND_BYTES) throw new EdgeFailure("command_too_large", 413);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { if (!done) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function remoteFailure(response: Response): Promise<EdgeFailure> {
  const value = await readJSON(response);
  return new EdgeFailure(record(value) && record(value.error) && typeof value.error.code === "string" ? value.error.code : "workspace_resolution_failed", response.status);
}
function failure(code: string, status: number): Response { return Response.json({ error: { code } }, { status }); }
