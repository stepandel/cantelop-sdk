import type {
  CantelopApp,
  MessageRef,
  MessageStatus,
  Session,
  SessionOpenConfig,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceOpenConfig,
} from "./resources.js";

const WORKSPACE_ID_PATTERN = /^wsp_[0-9a-f]{32}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{32}$/;
const WORKSPACE_SLUG_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUNTIME_ORIGIN = "https://runtime.cantelop.internal";
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MIN_KEEP_ALIVE_SECONDS = 0;
const MAX_KEEP_ALIVE_SECONDS = 604_800;

type RuntimeFetch = (request: Request) => Promise<Response>;
type IDFactory = () => string;

export interface RemoteAppOptions {
  readonly fetch?: RuntimeFetch;
  readonly sessionId?: IDFactory;
  readonly messageId?: IDFactory;
}

export class RemoteAppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Cantelop request failed: ${code}`);
    this.name = "RemoteAppError";
  }
}

export function createRemoteApp<Input = unknown>(
  options: RemoteAppOptions = {},
): CantelopApp<Input> {
  const runtimeFetch = options.fetch ?? ((request: Request) => fetch(request));
  const sessionId = options.sessionId ?? createSessionID;
  const messageId = options.messageId ?? createMessageID;

  const sessions = Object.freeze({
    open(config: SessionOpenConfig): Session<Input> {
      assertWorkspaceID(config.workspaceId);
      assertKeepAliveSeconds(config.keepAliveSeconds);
      const id = config.id ?? sessionId();
      assertSessionID(id);
      return createRemoteSession(id, config, runtimeFetch, messageId);
    },
  });

  const workspaces = Object.freeze({
    async create(config: WorkspaceCreateConfig): Promise<Workspace> {
      assertWorkspaceSlug(config.slug);
      const envelope = await requestJSON(runtimeFetch, "/__cantelop/v1/workspaces", {
        method: "POST",
        body: { slug: config.slug },
      });
      return readWorkspace(envelope);
    },

    async open(config: WorkspaceOpenConfig): Promise<Workspace> {
      assertWorkspaceSlug(config.slug);
      const envelope = await requestJSON(runtimeFetch, "/__cantelop/v1/workspaces/open", {
        method: "POST",
        body: { slug: config.slug },
      });
      return readWorkspace(envelope);
    },
  });

  return Object.freeze({ sessions, workspaces });
}

function createRemoteSession<Input>(
  id: string,
  config: SessionOpenConfig,
  runtimeFetch: RuntimeFetch,
  messageId: IDFactory,
): Session<Input> {
  return Object.freeze({
    id,
    workspaceId: config.workspaceId,
    keepAliveSeconds: config.keepAliveSeconds,

    async dispatch(input: Input): Promise<MessageRef> {
      const message = messageId();
      assertMessageID(message);
      const envelope = await requestJSON(runtimeFetch, "/__cantelop/v1/messages", {
        method: "POST",
        body: {
          session: sessionEnvelope(this.id, config),
          message: {
            id: message,
            payload: input,
          },
        },
      });
      return readMessageRef(envelope, message, this.id, runtimeFetch);
    },

    async events(request: Request): Promise<Response> {
      if (request.method !== "GET") {
        throw new TypeError("Session events require a GET request");
      }
      const sourceURL = new URL(request.url);
      const afterValues = sourceURL.searchParams.getAll("after");
      if (afterValues.length > 1 ||
          (afterValues.length === 1 && !/^\d+$/.test(afterValues[0] ?? ""))) {
        throw new TypeError("Session event cursor must be a non-negative integer");
      }
      const path = new URL(
        `/__cantelop/v1/sessions/${encodeURIComponent(this.id)}/events`,
        RUNTIME_ORIGIN,
      );
      path.searchParams.set("workspace_id", config.workspaceId);
      if (afterValues.length === 1) path.searchParams.set("after", afterValues[0]!);

      const headers = new Headers({ Accept: "text/event-stream" });
      if (afterValues.length === 0) copyHeader(request.headers, headers, "Last-Event-ID");
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        headers.set("Upgrade", "websocket");
        copyHeader(request.headers, headers, "Connection");
        copyHeader(request.headers, headers, "Origin");
        copyHeader(request.headers, headers, "Sec-WebSocket-Protocol");
        headers.delete("Accept");
      }
      return runtimeFetch(new Request(path, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: request.signal,
      }));
    },

    async terminate(): Promise<void> {
      await requestJSON(
        runtimeFetch,
        `/__cantelop/v1/sessions/${encodeURIComponent(this.id)}`,
        { method: "DELETE" },
      );
    },
  });
}

function copyHeader(source: Headers, destination: Headers, name: string): void {
  const value = source.get(name);
  if (value !== null) destination.set(name, value);
}

function sessionEnvelope(id: string, config: SessionOpenConfig): Record<string, unknown> {
  return {
    id,
    workspace_id: config.workspaceId,
    keep_alive_seconds: config.keepAliveSeconds,
  };
}

function readMessageRef(
  envelope: unknown,
  expectedMessage: string,
  sessionId: string,
  runtimeFetch: RuntimeFetch,
): MessageRef {
  if (!isRecord(envelope) || typeof envelope.id !== "string" ||
      !MESSAGE_ID_PATTERN.test(envelope.id) ||
      envelope.id !== expectedMessage ||
      envelope.status !== "accepted" ||
      typeof envelope.accepted_at !== "string") {
    throw new RemoteAppError("invalid_message_response", 0);
  }
  const id = envelope.id;
  return Object.freeze({
    id,
    state: "accepted" as const,
    acceptedAt: readMessageDate(envelope.accepted_at),
    async status(): Promise<MessageStatus> {
      const statusEnvelope = await requestJSON(
        runtimeFetch,
        `/__cantelop/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(id)}`,
        { method: "GET" },
      );
      return readMessageStatus(statusEnvelope, id);
    },
  });
}

function readMessageStatus(envelope: unknown, expectedMessage: string): MessageStatus {
  if (!isRecord(envelope) || envelope.id !== expectedMessage ||
      typeof envelope.state !== "string") {
    throw new RemoteAppError("invalid_message_status_response", 0);
  }

  if (envelope.state === "unknown") {
    return Object.freeze({ state: "unknown" as const });
  }

  if (typeof envelope.accepted_at !== "string") {
    throw new RemoteAppError("invalid_message_status_response", 0);
  }
  const acceptedAt = readMessageStatusDate(envelope.accepted_at);
  if (envelope.state === "accepted") {
    return Object.freeze({ state: "accepted" as const, acceptedAt });
  }

  if (typeof envelope.started_at !== "string") {
    throw new RemoteAppError("invalid_message_status_response", 0);
  }
  const startedAt = readMessageStatusDate(envelope.started_at);
  if (envelope.state === "handling") {
    return Object.freeze({ state: "handling" as const, acceptedAt, startedAt });
  }
  if (envelope.state === "handled" && typeof envelope.handled_at === "string") {
    return Object.freeze({
      state: "handled" as const,
      acceptedAt,
      startedAt,
      handledAt: readMessageStatusDate(envelope.handled_at),
    });
  }
  if (envelope.state === "failed" && typeof envelope.failed_at === "string" &&
      isRecord(envelope.error) && typeof envelope.error.code === "string" &&
      envelope.error.code.length > 0) {
    return Object.freeze({
      state: "failed" as const,
      acceptedAt,
      startedAt,
      failedAt: readMessageStatusDate(envelope.failed_at),
      error: Object.freeze({ code: envelope.error.code }),
    });
  }
  throw new RemoteAppError("invalid_message_status_response", 0);
}

interface RequestOptions {
  readonly method: "DELETE" | "GET" | "POST";
  readonly body?: unknown;
}

async function requestJSON(
  runtimeFetch: RuntimeFetch,
  path: string,
  options: RequestOptions,
): Promise<unknown> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (body !== undefined && byteLength(body) > MAX_ENVELOPE_BYTES) {
    throw new RemoteAppError("invalid_request", 0);
  }

  const response = await runtimeFetch(new Request(`${RUNTIME_ORIGIN}${path}`, {
    method: options.method,
    redirect: "manual",
    ...(body === undefined ? {} : {
      headers: { "Content-Type": "application/json" },
      body,
    }),
  }));
  const envelope = await readEnvelope(response);
  if (!response.ok) {
    throw new RemoteAppError(readErrorCode(envelope), response.status);
  }
  return envelope;
}

async function readEnvelope(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_ENVELOPE_BYTES) {
    throw new RemoteAppError("invalid_response", response.status);
  }
  const body = await response.text();
  if (byteLength(body) > MAX_ENVELOPE_BYTES) {
    throw new RemoteAppError("invalid_response", response.status);
  }
  if (body.length === 0 && response.ok) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RemoteAppError("invalid_response", response.status);
  }
}

function readWorkspace(value: unknown): Workspace {
  if (!isRecord(value) ||
      typeof value.id !== "string" || !WORKSPACE_ID_PATTERN.test(value.id) ||
      typeof value.app_id !== "string" ||
      typeof value.slug !== "string" || !WORKSPACE_SLUG_PATTERN.test(value.slug) ||
      typeof value.hostname !== "string" ||
      typeof value.created_at !== "string" ||
      typeof value.updated_at !== "string") {
    throw new RemoteAppError("invalid_workspace_response", 0);
  }

  const createdAt = readDate(value.created_at);
  const updatedAt = readDate(value.updated_at);
  const archivedAt = value.archived_at === undefined || value.archived_at === null
    ? undefined
    : readDate(value.archived_at);
  return Object.freeze({
    id: value.id,
    appId: value.app_id,
    slug: value.slug,
    hostname: value.hostname,
    createdAt,
    updatedAt,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  });
}

function readDate(value: unknown): Date {
  if (typeof value !== "string") throw new RemoteAppError("invalid_workspace_response", 0);
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new RemoteAppError("invalid_workspace_response", 0);
  return date;
}

function readMessageDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new RemoteAppError("invalid_message_response", 0);
  return date;
}

function readMessageStatusDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new RemoteAppError("invalid_message_status_response", 0);
  }
  return date;
}

function readErrorCode(envelope: unknown): string {
  if (!isRecord(envelope) || !isRecord(envelope.error)) return "request_failed";
  return typeof envelope.error.code === "string" && envelope.error.code.length > 0
    ? envelope.error.code
    : "request_failed";
}

function assertWorkspaceID(id: string): void {
  if (!WORKSPACE_ID_PATTERN.test(id)) throw new TypeError("Invalid Cantelop Workspace ID");
}

function assertSessionID(id: string): void {
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new TypeError("Invalid Cantelop Session ID");
  }
}

function assertMessageID(id: string): void {
  if (!MESSAGE_ID_PATTERN.test(id)) throw new TypeError("Invalid Cantelop message ID");
}

function assertWorkspaceSlug(slug: string): void {
  if (!WORKSPACE_SLUG_PATTERN.test(slug)) throw new TypeError("Invalid Cantelop Workspace slug");
}

function assertKeepAliveSeconds(value: number): void {
  if (!Number.isInteger(value) || value < MIN_KEEP_ALIVE_SECONDS || value > MAX_KEEP_ALIVE_SECONDS) {
    throw new TypeError("keepAliveSeconds must be an integer between 0 and 604800");
  }
}

function createSessionID(): string {
  return `ses_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createMessageID(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
