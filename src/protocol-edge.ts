import {encodeRuntimeCommand} from "./runtime-command.js";
import { isRecord, RUNTIME_ORIGIN, WORKSPACE_ID_PATTERN } from "./shared.js";
import { App } from "./app.js";
import { normalizeAppOptions, type NormalizedAppOptions } from "./app-config.js";
import { validateAppDeploymentConfiguration, type AppEnvironmentDeclaration } from "./app-definition.js";
import { assertRuntimeID, RUNTIME_ID, type SessionRuntime } from "./session-runtime-contract.js";
import { validateWebhookRoutes, type HomepageHandler, type WebhookRoutes } from "./webhooks.js";
import type { AppConnection, SessionCommand, WorkspaceSelector } from "./integration.js";
import { CANTELOP_INTEGRATION_PROTOCOL_VERSION as PROTOCOL_VERSION, DEFAULT_REQUEST_TIMEOUT_MS, MAX_COMMAND_BYTES, appCommandType, assertKeepAlive, validateCommand, type ProtocolEnvelope } from "./integration-protocol.js";
import { workspaceAuthSessionID, TERMINAL_ID_PATTERN } from "./native-auth.js";
import { MAX_SYNC_FILE_BYTES, SYNC_PUBLIC_ROUTE, validSyncRequest } from "./sync.js";

const AUTH_TERMINAL_ROUTE = /^\/__cantelop\/auth\/workspaces\/(wsp_[0-9a-f]{32})\/terminals\/(trm_[0-9a-f]{32})$/;
/** Only the WebSocket handshake crosses to the Sandbox; cookies and caller credentials never do. */
const TERMINAL_HEADERS = ["Upgrade", "Connection", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol"];

/** Internal protocol implementation with optional App webhook ingress. */
export interface ProtocolEdgeOptions<Message = unknown, Event = never, Reply = never, View = unknown> {
  readonly runtimeId: string;
  readonly appName?: string;
  readonly webhooks?: WebhookRoutes<Message, Event, Reply, View>;
  readonly homepage?: HomepageHandler<Message, Event, Reply, View>;
  readonly environment?: Readonly<Record<string, AppEnvironmentDeclaration>>;
  /** The App declares auth, enabling auth commands and the browser terminal route. */
  readonly auth?: boolean;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly runtimeOrigin?: string;
}
class EdgeFailure extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/** Webhook and homepage handlers receive this App; its runtime executes only in the Sandbox. */
function compiledRuntime<Message, Event, Reply, View>(runtimeId: string): SessionRuntime<Message, Event, Reply, View> {
  const runtime = { receive(): never { throw new Error("App runtime executes in the Sandbox"); }, [RUNTIME_ID]: runtimeId };
  return runtime;
}

/** The platform supplies App authentication, defaults and trusted outbound routing. */
export function createProtocolWorker<Message = unknown, Event = never, Reply = never, View = unknown>(options: ProtocolEdgeOptions<Message, Event, Reply, View>) {
  assertRuntimeID(options?.runtimeId);
  const runtimeId = options.runtimeId;
  const runtimeFetch = options.fetch ?? ((request: Request) => fetch(request));
  const origin = options.runtimeOrigin ?? RUNTIME_ORIGIN;
  // Validated once per Worker; each request only binds its own connection to this App definition.
  const app: NormalizedAppOptions<Message, Event, Reply, View> | undefined = options.appName ? Object.freeze({
    ...normalizeAppOptions<Message, Event, Reply, View>({
      name: options.appName, runtime: compiledRuntime(runtimeId),
      ...(options.webhooks === undefined ? {} : { webhooks: options.webhooks }),
      ...(options.homepage === undefined ? {} : { homepage: options.homepage }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
    }),
    auth: options.auth === true,
  }) : undefined;
  const routes = app?.webhooks ?? validateWebhookRoutes(options.webhooks);
  const environment = app?.environment ?? validateAppDeploymentConfiguration({ environment: options.environment ?? {} }).environment ?? {};
  if (!app && (Object.keys(routes).length || options.homepage !== undefined)) throw new TypeError("Webhook App name is required");
  async function commands(request: Request, bindings: Readonly<Record<string, unknown>>, publicOrigin = new URL(request.url).origin): Promise<Response> {
    try {
      const url = new URL(request.url);
      const type = appCommandType(url.pathname);
      if (request.method !== "POST" || type === undefined || url.search) throw new EdgeFailure("not_found", 404);
      if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new EdgeFailure("invalid_command", 400);
      let envelope: ProtocolEnvelope;
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
        if (response.status === 204) return Response.json({ protocolVersion: PROTOCOL_VERSION, id: envelope.id });
        const value = await readPlatformJSON(response);
        if (!response.ok) return Response.json(value, { status: response.status });
        if (!isRecord(value)) throw new EdgeFailure("invalid_platform_response", 502);
        return Response.json({ ...value, protocolVersion: PROTOCOL_VERSION }, { status: response.status });
      }
      if (workspace === null) {
        if (command.type !== "app.environment.status") {
          if (!Object.hasOwn(environment, command.name)) throw new EdgeFailure("environment_not_declared", 400);
          const declaration = environment[command.name]!;
          if ((declaration.secret === true) !== command.secret) throw new EdgeFailure("environment_kind_mismatch", 400);
          // Mirrors requestEnvironment: an empty or removed required value without a default fails every request.
          if (declaration.required && (command.type === "app.environment.set" ? command.value === "" : !declaration.default)) throw new EdgeFailure("environment_required", 400);
        }
        // The private gateway accepts command fields only; the ID correlates the public response.
        const response = await invoke(`/__cantelop/v1/environment/${command.type.slice("app.environment.".length)}`, "POST", command);
        if (!response.ok) return response;
        // Only metadata crosses back, whatever else the platform includes.
        const value = await readPlatformJSON(response);
        if (!isRecord(value) || !Number.isSafeInteger(value.revision) || !["pending", "applied", "failed"].includes(value.status as string)) throw new EdgeFailure("invalid_platform_response", 502);
        return Response.json({ protocolVersion: PROTOCOL_VERSION, id: envelope.id, revision: value.revision, status: value.status }, { headers: { "Cache-Control": "private, no-store" } });
      }
      async function resolveWorkspace(): Promise<string> {
        if (workspace === null) throw new EdgeFailure("invalid_command", 400);
        if (workspace.id !== undefined) return workspace.id;
        const response = await invoke("/__cantelop/v1/workspaces/open", "POST", { slug: workspace.slug });
        if (!response.ok) throw await remoteFailure(response);
        const value = await readPlatformJSON(response);
        if (!isRecord(value) || typeof value.id !== "string" || !WORKSPACE_ID_PATTERN.test(value.id) || value.slug !== workspace.slug) throw new EdgeFailure("invalid_platform_response", 502);
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
          case "workspace.inspect":
            return await invoke(`/__cantelop/integration/v2/workspaces?${workspaceQuery(workspace)}`, "GET");
          case "workspace.delete":
            return await invoke(`/__cantelop/integration/v2/workspaces/${workspace.id}`, "DELETE");
        }
      }
      // Only Session commands depend on Sandbox runtime compatibility.
      if (request.headers.get("X-Cantelop-Session-Runtime") !== runtimeId) throw new EdgeFailure("session_runtime_mismatch", 409);
      const scopedPath = (suffix = "") => sessionPath(session!.id, workspace, suffix);
      // Each operation owns its semantics here; no client-selected private path is forwarded.
      const sessionCommand = command as SessionCommand;
      switch (sessionCommand.type) {
        case "dispatch": case "steer": case "request": case "auth": {
          const submission = sessionCommand;
          const keepAliveSeconds = resolveKeepAlive(submission.keepAliveSeconds, bindings);
          if (submission.type === "auth" && !options.auth) throw new EdgeFailure("auth_not_configured", 404);
          const workspaceId = await resolveWorkspace();
          const response = await invoke(`/__cantelop/integration/v2/${submission.type === "request" || submission.type === "auth" ? "requests" : "messages"}`, "POST", {
            session: { id: submission.type === "auth" ? workspaceAuthSessionID(workspaceId) : session!.id, workspace_id: workspaceId, keep_alive_seconds: keepAliveSeconds },
            message: { id: envelope.id, payload: encodeRuntimeCommand(submission.type === "auth" ? { type: "auth", auth: submission.auth } : { type: submission.type === "steer" ? "steer" : "dispatch", message: submission.message }) },
            ...(submission.type === "request" || submission.type === "auth" ? { timeout_ms: submission.timeoutMs } : {}),
          });
          if (submission.type !== "auth" || !response.ok) return response;
          const value = await readPlatformJSON(response);
          if (!isRecord(value) || !isRecord(value.reply)) throw new EdgeFailure("invalid_platform_response", 502);
          if (value.reply.type !== "terminal") return Response.json(value);
          if (typeof value.reply.terminalId !== "string" || !TERMINAL_ID_PATTERN.test(value.reply.terminalId)) throw new EdgeFailure("invalid_platform_response", 502);
          // The browser connects here directly, so the App backend never relays terminal bytes.
          const url = new URL(`/__cantelop/auth/workspaces/${workspaceId}/terminals/${value.reply.terminalId}`, publicOrigin);
          url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
          return Response.json({ ...value, reply: { ...value.reply, url: url.href } });
        }
        case "cancel": {
          const response = await invoke(scopedPath("/requests"), "POST", {
            message: { id: envelope.id, payload: encodeRuntimeCommand({ type: "cancel" }) },
            keep_alive_seconds: resolveKeepAlive(sessionCommand.keepAliveSeconds, bindings),
            timeout_ms: DEFAULT_REQUEST_TIMEOUT_MS,
          });
          if (!response.ok) return response;
          const result = await readPlatformJSON(response);
          if (!isRecord(result) || !isRecord(result.reply)) throw new EdgeFailure("invalid_platform_response", 502);
          return Response.json({ ...result.reply, protocolVersion: PROTOCOL_VERSION });
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
      const sync = SYNC_PUBLIC_ROUTE.exec(path);
      if (sync) {
        const limit = { exceeded: false };
        try {
          await authenticate(request, bindings);
          const incoming = new URL(request.url);
          if (!validSyncRequest(request.method, incoming.searchParams)) throw new EdgeFailure("invalid_sync_request", 400);
          const headers = new Headers({ "Content-Type": "application/octet-stream" });
          const length = request.headers.get("Content-Length");
          if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SYNC_FILE_BYTES)) throw new EdgeFailure("sync_file_too_large", 413);
          // No caller credentials or custom routing headers cross this boundary; the validated relative root is scoped by the platform to this Workspace.
          const target = new URL(`/__cantelop/integration/v2/workspaces/${sync[1]}/sync`, origin);
          target.search = incoming.search;
          const body = request.body === null ? undefined : boundedSyncBody(request.body, limit);
          return await runtimeFetch(new Request(target, { method: request.method, headers, signal: request.signal,
            redirect: "manual", ...(body === undefined ? {} : { body, duplex: "half" } as RequestInit) }));
        } catch (error) {
          if (request.signal.aborted) throw request.signal.reason;
          // A body-stream EdgeFailure reaches here wrapped in the fetch rejection.
          if (limit.exceeded) return failure("sync_file_too_large", 413);
          return error instanceof EdgeFailure ? failure(error.code, error.status) : failure("sync_unavailable", 503);
        }
      }
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
      const homepage = path === "/" ? app?.homepage : undefined;
      const route = routes[path];
      const handle = homepage ?? route?.handle;
      if (handle && app) {
        const allow = homepage ? "GET, HEAD" : route!.method;
        if (homepage ? !["GET", "HEAD"].includes(request.method) : request.method !== route!.method) return new Response(null, { status: 405, headers: { Allow: allow } });
        try {
          const env = requestEnvironment(environment, bindings);
          const publicOrigin = new URL(request.url).origin;
          // Commands from this handler are served by this Worker with the current request's bindings.
          const connection: AppConnection = {
            fetch: command => commands(command, bindings, publicOrigin),
            ...(typeof bindings.CANTELOP_LOCAL_DATABASE_ORIGIN === "string" ? { localDatabaseOrigin: bindings.CANTELOP_LOCAL_DATABASE_ORIGIN } : {}),
          };
          const webhookRequest = await boundedWebhookRequest(request);
          const response = await handle(Object.freeze({ request: webhookRequest, app: new App(app, connection), env }));
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

function boundedSyncBody(body: ReadableStream<Uint8Array>, limit: { exceeded: boolean }): ReadableStream<Uint8Array> {
  let bytes = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_SYNC_FILE_BYTES) { limit.exceeded = true; throw new EdgeFailure("sync_file_too_large", 413); }
      controller.enqueue(chunk);
    },
  }));
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
/** The command's keep-alive, else the App's configured default; a Session never runs without one. */
function resolveKeepAlive(requested: number | undefined, bindings: Readonly<Record<string, unknown>>): number {
  const configured = bindings.CANTELOP_DEFAULT_KEEP_ALIVE_SECONDS;
  const keepAliveSeconds = requested ?? (typeof configured === "string" && /^\d+$/.test(configured) ? Number(configured) : configured);
  try { assertKeepAlive(keepAliveSeconds); } catch { throw new EdgeFailure("keep_alive_not_configured", 503); }
  if (keepAliveSeconds === undefined) throw new EdgeFailure("keep_alive_not_configured", 503);
  return keepAliveSeconds as number;
}
function workspaceQuery(workspace: WorkspaceSelector): URLSearchParams {
  return new URLSearchParams(workspace.id === undefined ? { workspace_slug: workspace.slug } : { workspace_id: workspace.id });
}
function sessionPath(id: string, workspace: WorkspaceSelector, suffix: string): string {
  return `/__cantelop/integration/v2/sessions/${encodeURIComponent(id)}${suffix}?${workspaceQuery(workspace)}`;
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
  return new EdgeFailure(isRecord(value) && isRecord(value.error) && typeof value.error.code === "string" ? value.error.code : "workspace_resolution_failed", response.status);
}
function failure(code: string, status: number): Response { return Response.json({ error: { code } }, { status }); }
