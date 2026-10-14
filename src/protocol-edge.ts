import {encodeRuntimeCommand} from "./runtime-command.js";
import { App } from "./app.js";
import { validateAppDeploymentConfiguration, type AppEnvironmentDeclaration } from "./app-definition.js";
import { RUNTIME_ID } from "./session-runtime-contract.js";
import { validateWebhookRoutes, type HomepageHandler, type WebhookRoutes } from "./webhooks.js";
import { assertRuntimeID } from "./session-runtime-contract.js";
import type { AppCommandEnvelope, SessionCommand, WorkspaceSelector } from "./integration.js";
import { MAX_COMMAND_BYTES, appCommandType, assertKeepAlive, record, validateCommand } from "./integration-protocol.js";
import { workspaceAuthSessionID, COMPILED_AUTH, NATIVE_AUTH_CONTRACT, TERMINAL_ID_PATTERN } from "./native-auth.js";
import { requestContract, validateCompatibility, type AppCompatibility } from "./compatibility.js";

const AUTH_TERMINAL_ROUTE = /^\/__cantelop\/auth\/workspaces\/(wsp_[0-9a-f]{32})\/terminals\/(trm_[0-9a-f]{32})$/;
/** Only the WebSocket handshake crosses to the Sandbox; cookies and caller credentials never do. */
const TERMINAL_HEADERS = ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol"];

/** Internal protocol implementation with optional App webhook ingress. */
export interface ProtocolEdgeOptions {
  readonly compatibility?: AppCompatibility;
  readonly runtimeId: string;
  readonly appName?: string;
  readonly webhooks?: WebhookRoutes<any, any, any, any>;
  readonly homepage?: HomepageHandler<any, any, any, any>;
  readonly environment?: Readonly<Record<string, AppEnvironmentDeclaration>>;
  /** The App declares auth, enabling auth commands and the browser terminal route. */
  readonly auth?: boolean;
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
  const compatibility = validateCompatibility(options.compatibility);
  const runtimeFetch = options.fetch ?? ((request: Request) => fetch(request));
  const origin = options.runtimeOrigin ?? "https://runtime.cantelop.internal";
  const routes = validateWebhookRoutes(options.webhooks);
  const environment = validateAppDeploymentConfiguration({ environment: options.environment ?? {} }).environment ?? {};
  if (options.homepage !== undefined && typeof options.homepage !== "function") throw new TypeError("Invalid App homepage");
  if ((Object.keys(routes).length || options.homepage) && !options.appName) throw new TypeError("Webhook App name is required");
  async function commands(request: Request, bindings: Readonly<Record<string, unknown>>, publicOrigin = new URL(request.url).origin): Promise<Response> {
    try {
      const url = new URL(request.url);
      const type = appCommandType(url.pathname);
      if (request.method !== "POST" || type === undefined || url.search) throw new EdgeFailure("not_found", 404);
      if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new EdgeFailure("invalid_command", 400);
      let envelope: AppCommandEnvelope;
      try { envelope = validateCommand(await readJSON(request)); }
      catch (error) { if (error instanceof EdgeFailure) throw error; throw new EdgeFailure("invalid_command", 400); }
      // The path names the operation for every layer in front of Edge; the body must agree.
      if (envelope.command.type !== type) throw new EdgeFailure("command_path_mismatch", 400);
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
        const value = await readPlatformJSON(response);
        if (!response.ok) return Response.json(value, { status: response.status });
        if (!record(value)) throw new EdgeFailure("invalid_platform_response", 502);
        return Response.json({ ...value, protocolVersion: 2 }, { status: response.status });
      }
      async function resolveWorkspace(): Promise<string> {
        if (workspace.id !== undefined) return workspace.id;
        const response = await invoke("/__cantelop/v1/workspaces/open", "POST", { slug: workspace.slug });
        if (!response.ok) throw await remoteFailure(response);
        const value = await readPlatformJSON(response);
        if (!record(value) || typeof value.id !== "string" || !/^wsp_[0-9a-f]{32}$/.test(value.id) || value.slug !== workspace.slug) throw new EdgeFailure("invalid_platform_response", 502);
        return value.id;
      }
      if (session === null) {
        switch (command.type) {
          case "workspace.resolve":
            return workspace.id === undefined
              ? await invoke("/__cantelop/v1/workspaces/open", "POST", { slug: workspace.slug })
              : await invoke(`/__cantelop/v1/workspaces/${workspace.id}`, "GET");
          case "workspace.database":
            return await invoke("/__cantelop/v1/workspaces/database/credentials", "POST", { workspace_id: await resolveWorkspace() });
        }
      }
      const sessionCommand = command as SessionCommand;
      // Only Session commands depend on Sandbox runtime compatibility. Native auth keeps its own
      // stable contract, so App contract negotiation never blocks Workspace sign-in.
      const selection = compatibility !== undefined && sessionCommand.type === "auth"
        ? { version: NATIVE_AUTH_CONTRACT } : requestContract(request.headers, runtimeId, compatibility);
      if ("error" in selection) throw new EdgeFailure(selection.error, 409);
      const contractVersion = selection.version;
      const scopedPath = (suffix = "") => sessionPath(session!.id, workspace, suffix, contractVersion);
      // Each operation owns its semantics here; no client-selected private path is forwarded.
      switch (sessionCommand.type) {
        case "dispatch": case "steer": case "request": case "auth": {
          const submission = sessionCommand;
          const defaultValue = bindings.CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS;
          const keepAliveSeconds = submission.keepAliveSeconds ?? (typeof defaultValue === "string" && /^\d+$/.test(defaultValue) ? Number(defaultValue) : defaultValue);
          try { assertKeepAlive(keepAliveSeconds); if (keepAliveSeconds === undefined) throw new TypeError(); }
          catch { throw new EdgeFailure("keep_alive_not_configured", 503); }
          if (submission.type === "auth" && !options.auth) throw new EdgeFailure("auth_not_configured", 404);
          const workspaceId = await resolveWorkspace();
          const response = await invoke(`/__cantelop/integration/v2/${submission.type === "request" || submission.type === "auth" ? "requests" : "messages"}`, "POST", {
            session: { id: submission.type === "auth" ? workspaceAuthSessionID(workspaceId) : session!.id, workspace_id: workspaceId, keep_alive_seconds: keepAliveSeconds,
              ...(contractVersion === undefined ? {} : { contract_version: contractVersion }) },
            message: { id: envelope.id, payload: encodeRuntimeCommand(submission.type === "auth" ? { type: "auth", auth: submission.auth } : { type: submission.type === "steer" ? "steer" : "dispatch", message: submission.message }) },
            ...(submission.type === "request" || submission.type === "auth" ? { timeout_ms: submission.timeoutMs } : {}),
          });
          if (submission.type !== "auth" || !response.ok) return response;
          const value = await readPlatformJSON(response);
          if (!record(value) || !record(value.reply)) throw new EdgeFailure("invalid_platform_response", 502);
          if (value.reply.type !== "terminal") return Response.json(value);
          if (typeof value.reply.terminalId !== "string" || !TERMINAL_ID_PATTERN.test(value.reply.terminalId)) throw new EdgeFailure("invalid_platform_response", 502);
          // The browser connects here directly, so the App backend never relays terminal bytes.
          const url = new URL(`/__cantelop/auth/workspaces/${workspaceId}/terminals/${value.reply.terminalId}`, publicOrigin);
          url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
          return Response.json({ ...value, reply: { ...value.reply, url: url.href } });
        }
        case "cancel": {
          const cancel = sessionCommand;
          const value = bindings.CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS;
          const keepAliveSeconds = cancel.keepAliveSeconds ??
            (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
          try {
            assertKeepAlive(keepAliveSeconds);
            if (keepAliveSeconds === undefined) throw new TypeError();
          } catch {
            throw new EdgeFailure("keep_alive_not_configured", 503);
          }
          const response = await invoke(scopedPath("/requests"), "POST", {
            message: { id: envelope.id, payload: encodeRuntimeCommand({ type: "cancel" }) },
            keep_alive_seconds: keepAliveSeconds,
            ...(contractVersion === undefined ? {} : { contract_version: contractVersion }),
            timeout_ms: 30_000,
          });
          if (!response.ok) return response;
          const result = await readPlatformJSON(response);
          if (!record(result) || !record(result.reply)) throw new EdgeFailure("invalid_platform_response", 502);
          return Response.json({ ...result.reply, protocolVersion: 2 });
        }
        case "status": {
          const status = sessionCommand;
          return await invoke(scopedPath(`/messages/${status.messageId}`), "GET");
        }
        case "stop": return await invoke(scopedPath(), "DELETE");
        case "view": return await invoke(scopedPath("/view"), "GET");
        case "stream": {
          const stream = sessionCommand;
          const url = new URL(scopedPath("/events"), origin);
          if (stream.after !== undefined) {
            url.searchParams.set("stream_id", stream.after.streamId);
            url.searchParams.set("after", String(stream.after.sequence));
          }
          return await invoke(url.pathname + url.search, "GET", undefined, true);
        }
      }
      throw new EdgeFailure("invalid_command", 400);
    } catch (error) {
      if (error instanceof EdgeFailure) return failure(error.code, error.status);
      if (request.signal.aborted) throw request.signal.reason;
      return failure("command_outcome_unknown", 502);
    }
  }
  return Object.freeze({
    async fetch(request: Request, bindings: Readonly<Record<string, unknown>> = {}): Promise<Response> {
      const path = new URL(request.url).pathname;
      const terminal = AUTH_TERMINAL_ROUTE.exec(path);
      if (terminal) {
        if (!options.auth) return failure("not_found", 404);
        if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return failure("upgrade_required", 426);
        // The single-use ticket in Sec-WebSocket-Protocol is verified by the auth Sandbox.
        const headers = new Headers();
        for (const name of TERMINAL_HEADERS) { const value = request.headers.get(name); if (value !== null) headers.set(name, value); }
        return runtimeFetch(new Request(new URL(`/__cantelop/integration/v2/sessions/${workspaceAuthSessionID(terminal[1]!)}/auth/terminals/${terminal[2]}?workspace_id=${terminal[1]}`, origin),
          { method: "GET", headers, redirect: "manual", signal: request.signal }));
      }
      const homepage = path === "/" ? options.homepage : undefined;
      const route = routes[path];
      const handle = homepage ?? route?.handle;
      if (handle) {
        const allow = homepage ? "GET, HEAD" : route!.method;
        if (homepage ? !["GET", "HEAD"].includes(request.method) : request.method !== route!.method) return new Response(null, { status: 405, headers: { Allow: allow } });
        try {
          const env = requestEnvironment(environment, bindings);
          const runtime = { receive() { throw new Error("App runtime executes in the Sandbox"); }, [RUNTIME_ID]: runtimeId };
          const app = new App<any, any, any, any>({ name: options.appName!, runtime, ...(compatibility ? { compatibility } : {}), ...(options.auth ? { auth: { [COMPILED_AUTH]: true } as never } : {}), connection: {
            fetch: command => commands(command, bindings, new URL(request.url).origin),
            ...(typeof bindings.CANTELOP_LOCAL_DATABASE_ORIGIN === "string" ? { localDatabaseOrigin: bindings.CANTELOP_LOCAL_DATABASE_ORIGIN } : {}),
          } }, { env: {} });
          const webhookRequest = await boundedWebhookRequest(request);
          const response = await handle(Object.freeze({ request: webhookRequest, app, env }));
          if (!(response instanceof Response)) throw new TypeError("Webhook must return a Response");
          if (homepage && request.method === "HEAD") {
            await response.body?.cancel().catch(() => {});
            return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
          }
          return response;
        } catch (error) {
          if (error instanceof EdgeFailure) return failure(error.code, error.status);
          if (request.signal.aborted) throw request.signal.reason;
          return failure(homepage ? "homepage_failed" : "webhook_failed", 500);
        }
      }
      try { await authenticate(request, bindings); }
      catch (error) { return error instanceof EdgeFailure ? failure(error.code, error.status) : failure("unauthorized", 401); }
      return commands(request, bindings);
    },
  });
}
/** Snapshot declared values only; deployment secrets use the same access as ordinary variables. */
function requestEnvironment(declarations: Readonly<Record<string, AppEnvironmentDeclaration>>, bindings: Readonly<Record<string, unknown>>): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = Object.create(null);
  for (const [name, declaration] of Object.entries(declarations)) {
    const binding = Object.hasOwn(bindings, name) ? bindings[name] : undefined;
    const value = binding === undefined ? declaration.default : binding;
    if (value !== undefined && typeof value !== "string") throw new EdgeFailure("app_environment_invalid", 503);
    if (declaration.required && (value === undefined || value === "")) throw new EdgeFailure("app_environment_missing", 503);
    env[name] = value;
  }
  return Object.freeze(env);
}
/** Preserve exact payload bytes for provider signatures while bounding ingress memory. */
async function boundedWebhookRequest(request: Request): Promise<Request> {
  request.signal.throwIfAborted();
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, done = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_COMMAND_BYTES) throw new EdgeFailure("webhook_too_large", 413);
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    request.signal.throwIfAborted();
    return new Request(request, { body });
  } finally { if (!done) await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function sessionPath(id: string, workspace: WorkspaceSelector, suffix: string, contractVersion?: string): string {
  const query = new URLSearchParams(workspace.id === undefined ? { workspace_slug: workspace.slug } : { workspace_id: workspace.id });
  if (contractVersion !== undefined) query.set("contract_version", contractVersion);
  return `/__cantelop/integration/v2/sessions/${encodeURIComponent(id)}${suffix}?${query}`;
}
async function authenticate(request: Request, bindings: Readonly<Record<string, unknown>>): Promise<void> {
  const token = bindings.CANTELOP_INTEGRATION_TOKEN;
  if (typeof token !== "string" || !token) throw new EdgeFailure("integration_not_configured", 503);
  const header = request.headers.get("Authorization") ?? "";
  const previous = previousIntegrationToken(bindings);
  const [current, prior] = await Promise.all([bearerMatches(header, token), previous === undefined ? false : bearerMatches(header, previous)]);
  if (!current && !prior) throw new EdgeFailure("unauthorized", 401);
}
/** A rotated-out token stays valid until its platform-set expiry so callers can move to the new one. */
function previousIntegrationToken(bindings: Readonly<Record<string, unknown>>): string | undefined {
  const token = bindings.CANTELOP_INTEGRATION_TOKEN_PREVIOUS, expiresAt = bindings.CANTELOP_INTEGRATION_TOKEN_PREVIOUS_EXPIRES_AT;
  if (typeof token !== "string" || !token || typeof expiresAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt)) return undefined;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return undefined;
  // Date.parse normalizes impossible calendar dates; require an exact UTC round trip.
  const canonical = expiresAt.length === 20 ? expiresAt.replace(/Z$/, ".000Z") : expiresAt;
  return new Date(expiry).toISOString() === canonical && expiry > Date.now() ? token : undefined;
}
async function bearerMatches(header: string, token: string): Promise<boolean> {
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [expected, actual] = await Promise.all([digest(`Bearer ${token}`), digest(header)]);
  const left = new Uint8Array(expected), right = new Uint8Array(actual);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
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
/** Platform response failures are never the caller's fault; report them as upstream errors. */
async function readPlatformJSON(response: Response): Promise<unknown> {
  try { return await readJSON(response); }
  catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new EdgeFailure("invalid_platform_response", 502);
  }
}
async function remoteFailure(response: Response): Promise<EdgeFailure> {
  const value = await readPlatformJSON(response);
  return new EdgeFailure(record(value) && record(value.error) && typeof value.error.code === "string" ? value.error.code : "workspace_resolution_failed", response.status);
}
function failure(code: string, status: number): Response { return Response.json({ error: { code } }, { status }); }
