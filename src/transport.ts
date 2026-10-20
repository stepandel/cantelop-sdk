/** JSON transport and response decoding shared by the App API, streams and environment commands. */
import { createWorkspaceDatabase, type DatabaseCredentials, type WorkspaceDatabase } from "./database.js";
import type { MessageExecution, MessageStatus, Workspace } from "./resources.js";
import { isRecord, WORKSPACE_ID_PATTERN } from "./shared.js";
import { MAX_COMMAND_BYTES, SLUG_PATTERN } from "./integration-protocol.js";

/** Responses are bounded like the commands that produce them. */
const MAX_ENVELOPE_BYTES = MAX_COMMAND_BYTES;

export type RuntimeFetch = (request: Request) => Promise<Response>;

export class RemoteAppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    /** Identity of the failed Session request; pass it as `id` to retry safely. */
    readonly messageId?: string,
    options?: ErrorOptions,
  ) {
    super(`Cantelop request failed: ${code}`, options);
    this.name = "RemoteAppError";
  }
}

export interface RequestOptions {
  readonly method: "GET" | "POST" | "DELETE";
  /** An already encoded JSON document; callers bound and validate it before transport. */
  readonly json?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** Send one request and decode its bounded JSON envelope; non-2xx responses become stable error codes. */
export async function requestJSON(fetch: RuntimeFetch, url: string | URL, options: RequestOptions): Promise<unknown> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.json !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(new Request(url, {
    method: options.method,
    redirect: "manual",
    headers,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.json === undefined ? {} : { body: options.json }),
  }));
  const envelope = await readEnvelope(response);
  if (!response.ok) throw new RemoteAppError(readErrorCode(envelope), response.status);
  return envelope;
}

const decoder = new TextDecoder();

async function readEnvelope(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_ENVELOPE_BYTES) {
    throw new RemoteAppError("invalid_response", response.status);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new RemoteAppError("invalid_response", response.status);
  if (bytes.byteLength === 0 && response.ok) return undefined;
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new RemoteAppError("invalid_response", response.status);
  }
}

function readErrorCode(envelope: unknown): string {
  if (!isRecord(envelope) || !isRecord(envelope.error)) return "request_failed";
  return typeof envelope.error.code === "string" && envelope.error.code.length > 0
    ? envelope.error.code
    : "request_failed";
}

/** Parse a platform timestamp, failing with the response's stable error code. */
function readDate(value: unknown, code: string): Date {
  const date = typeof value === "string" ? new Date(value) : undefined;
  if (date === undefined || Number.isNaN(date.valueOf())) throw new RemoteAppError(code, 0);
  return date;
}

/**
 * Decode a Workspace document. `loadCredentials` issues the Workspace's database
 * credential command; the handle is reused until it is closed.
 */
export function readWorkspace(
  value: unknown,
  loadCredentials: (workspaceId: string) => Promise<unknown>,
  localDatabaseOrigin?: string,
): Workspace {
  const invalid = "invalid_workspace_response";
  if (!isRecord(value) ||
      typeof value.id !== "string" || !WORKSPACE_ID_PATTERN.test(value.id) ||
      typeof value.app_id !== "string" ||
      typeof value.slug !== "string" || !SLUG_PATTERN.test(value.slug) ||
      typeof value.hostname !== "string") {
    throw new RemoteAppError(invalid, 0);
  }
  const createdAt = readDate(value.created_at, invalid);
  const updatedAt = readDate(value.updated_at, invalid);
  const archivedAt = value.archived_at === undefined || value.archived_at === null
    ? undefined
    : readDate(value.archived_at, invalid);
  const workspaceId = value.id;
  let database: WorkspaceDatabase | undefined;
  return Object.freeze({
    async database() {
      if (!database || database.closed) {
        database = createWorkspaceDatabase(async () => await loadCredentials(workspaceId) as DatabaseCredentials, { localDatabaseOrigin });
      }
      await database.credentials();
      return database;
    },
    id: workspaceId,
    appId: value.app_id,
    slug: value.slug,
    hostname: value.hostname,
    createdAt,
    updatedAt,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  });
}

const EXECUTION_PHASES: ReadonlySet<unknown> = new Set<MessageExecution["phase"]>(["sending", "accepted", "running", "cancelling", "settled", "retrying", "recovering", "quiescent", "unavailable"]);
const EXECUTION_OUTCOMES: ReadonlySet<unknown> = new Set<MessageExecution["outcome"]>(["pending", "succeeded", "failed", "timed_out", "unknown"]);
const INVALID_STATUS = "invalid_message_status_response";

function readExecution(value: unknown): MessageExecution {
  if (!isRecord(value) || !EXECUTION_PHASES.has(value.phase) || !EXECUTION_OUTCOMES.has(value.outcome) ||
      typeof value.sandbox_id !== "string" || typeof value.work_state !== "string") throw new RemoteAppError(INVALID_STATUS, 0);
  return Object.freeze({
    phase: value.phase as MessageExecution["phase"],
    outcome: value.outcome as MessageExecution["outcome"],
    sandboxId: value.sandbox_id,
    deadline: readDate(value.deadline, INVALID_STATUS),
    phaseAt: readDate(value.phase_at, INVALID_STATUS),
    workState: value.work_state,
  });
}

/** Decode one Message status document for the expected Message. */
export function readMessageStatus(envelope: unknown, expectedMessage: string): MessageStatus {
  if (!isRecord(envelope) || envelope.id !== expectedMessage || typeof envelope.state !== "string") {
    throw new RemoteAppError(INVALID_STATUS, 0);
  }
  if (envelope.state === "unknown") return Object.freeze({ state: "unknown" as const });

  const acceptedAt = readDate(envelope.accepted_at, INVALID_STATUS);
  const details = envelope.execution === undefined ? {} : { execution: readExecution(envelope.execution) };
  if (envelope.state === "accepted") return Object.freeze({ state: "accepted" as const, acceptedAt, ...details });

  const startedAt = readDate(envelope.started_at, INVALID_STATUS);
  if (envelope.state === "handling") return Object.freeze({ state: "handling" as const, acceptedAt, startedAt, ...details });
  if (envelope.state === "handled" && typeof envelope.handled_at === "string") {
    return Object.freeze({ state: "handled" as const, ...details, acceptedAt, startedAt, handledAt: readDate(envelope.handled_at, INVALID_STATUS) });
  }
  if (envelope.state === "failed" && typeof envelope.failed_at === "string" &&
      isRecord(envelope.error) && typeof envelope.error.code === "string" && envelope.error.code.length > 0) {
    return Object.freeze({
      state: "failed" as const, ...details, acceptedAt, startedAt,
      failedAt: readDate(envelope.failed_at, INVALID_STATUS),
      error: Object.freeze({ code: envelope.error.code }),
    });
  }
  throw new RemoteAppError(INVALID_STATUS, 0);
}
