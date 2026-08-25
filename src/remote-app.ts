import type {
  CantelopApp,
  MessageReceipt,
  SessionHandle,
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
    open(config: SessionOpenConfig): SessionHandle<Input> {
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
): SessionHandle<Input> {
  return Object.freeze({
    id,
    workspaceId: config.workspaceId,
    keepAliveSeconds: config.keepAliveSeconds,

    async dispatch(input: Input): Promise<MessageReceipt> {
      const message = messageId();
      assertMessageID(message);
      const envelope = await requestJSON(runtimeFetch, "/__cantelop/v1/messages", {
        method: "POST",
        body: {
          id: message,
          session: sessionEnvelope(this.id, config),
          input,
        },
      });
      return readMessageReceipt(envelope, message);
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

function sessionEnvelope(id: string, config: SessionOpenConfig): Record<string, unknown> {
  return {
    id,
    workspace_id: config.workspaceId,
    keep_alive_seconds: config.keepAliveSeconds,
  };
}

function readMessageReceipt(
  envelope: unknown,
  expectedMessage: string,
): MessageReceipt {
  if (!isRecord(envelope) || typeof envelope.id !== "string" ||
      !MESSAGE_ID_PATTERN.test(envelope.id) ||
      envelope.id !== expectedMessage ||
      envelope.status !== "queued" ||
      typeof envelope.accepted_at !== "string") {
    throw new RemoteAppError("invalid_message_response", 0);
  }
  return Object.freeze({
    id: envelope.id,
    status: "queued" as const,
    acceptedAt: readMessageDate(envelope.accepted_at),
  });
}

interface RequestOptions {
  readonly method: "DELETE" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
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
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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
