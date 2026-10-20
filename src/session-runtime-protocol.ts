/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RuntimeTraceContext } from "./observability.js";
import type { SessionIdentity } from "./resources.js";
import { RuntimeProtocolError } from "./runtime-messages.js";
import { isRecord, MESSAGE_ID_PATTERN, WORKSPACE_ID_PATTERN } from "./shared.js";

/** Wire format of the platform-owned v2 message socket. */
export const RUNTIME_PATH = "/__cantelop/v2/runtime";
export const MESSAGE_PATH = "/__cantelop/v2/messages";
export const MESSAGE_STATUS_ROUTE = /^\/__cantelop\/v2\/messages\/(msg_[0-9a-f]{32})(\/(cancel|reply))?$/;
export const COMPLETIONS_PATH = "/__cantelop/v2/runtime/completions";
export const QUIESCENCE_PATH = "/__cantelop/v2/runtime/quiescence";
export const OUTPUT_PATH = "/__cantelop/v2/runtime/events";
export const OBSERVATIONS_PATH = "/__cantelop/v2/runtime/observations";
export const RECOVERY_PATH = "/__cantelop/v2/runtime/recoveries";
export const ACTIVITY_CANCEL_PATH = "/__cantelop/v2/runtime/activity/cancel";
export const MESSAGE_PROTOCOL_VERSION = 2;

/** Long polls answer before common proxy idle timeouts. */
export const LONG_POLL_MS = 25_000;
/** How long runtime code may wait for the collector to accept one output event. */
export const OUTPUT_HANDOFF_MS = 30_000;
export const DEFAULT_EXECUTION_TIMEOUT_MS = 5 * 60_000;
export const MAX_REPLY_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const MAX_KEEP_ALIVE_SECONDS = 604_800;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ATTEMPT_ID_PATTERN = /^att_[0-9a-f]{32}$/;
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/;
const TRACE_PARENT_PATTERN = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-01$/;
const RECOVERY_ID_PATTERN = /^rcv_[0-9a-f]{32}$/;

const INTERNAL_PORT_VARIABLE = "CANTELOP_INTERNAL_PORT";
const INTERNAL_FD_VARIABLE = "CANTELOP_INTERNAL_FD";

export interface RuntimeMessage<Input> {
  readonly id: string;
  readonly payload: Input;
}

export interface MessageEnvelope<Input> {
  readonly message: RuntimeMessage<Input>;
  readonly session: SessionIdentity;
  readonly trace: RuntimeTraceContext | undefined;
  readonly reply: boolean;
  readonly deadline: string | undefined;
}

/** Copies a reply through JSON, enforcing that it is JSON and fits the reply frame. */
export function encodeReply(value: unknown, invalid: () => Error): unknown {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { /* normalized below */ }
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_REPLY_BYTES) throw invalid();
  return JSON.parse(encoded) as unknown;
}

export async function readRequestEnvelope(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ENVELOPE_BYTES)) {
    throw new RuntimeProtocolError(413, "message_input_too_large");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk as Uint8Array;
    length += bytes.byteLength;
    if (length > MAX_ENVELOPE_BYTES) throw new RuntimeProtocolError(413, "message_input_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RuntimeProtocolError(400, "invalid_message_request");
  }
}

export function isJSONContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/i.test(value);
}

export function readMessageEnvelope<Input>(value: unknown): MessageEnvelope<Input> {
  if (!isRecord(value) || !hasMessageEnvelopeShape(value)) throw new RuntimeProtocolError(400, "invalid_message_request");
  return {
    message: readMessage<Input>(value.message),
    session: readSession(value.session),
    trace: readObservabilityContext(value.observability),
    reply: value.reply === true,
    deadline: typeof value.deadline === "string" ? value.deadline : undefined,
  };
}

export function readRecoveryRequest(value: unknown): { recoveryId: string; messageId: string; session: SessionIdentity } {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
      typeof value.recovery_id !== "string" || !RECOVERY_ID_PATTERN.test(value.recovery_id) ||
      typeof value.message_id !== "string" || !MESSAGE_ID_PATTERN.test(value.message_id)) {
    throw new RuntimeProtocolError(400, "invalid_recovery_request");
  }
  return { recoveryId: value.recovery_id, messageId: value.message_id, session: readSession(value.session) };
}

function hasMessageEnvelopeShape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.every(key => ["session", "message", "observability", "deadline", "reply"].includes(key)) &&
    (value.deadline === undefined || typeof value.deadline === "string") &&
    (value.reply === undefined || typeof value.reply === "boolean") &&
    keys.includes("session") && keys.includes("message") &&
    isRecord(value.session) && isRecord(value.message);
}

function readObservabilityContext(value: unknown): RuntimeTraceContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !exactKeys(value, ["attempt_id", "attempt", "traceparent"], ["request_id"]) ||
      typeof value.attempt_id !== "string" || !ATTEMPT_ID_PATTERN.test(value.attempt_id) ||
      typeof value.attempt !== "number" || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 100 ||
      typeof value.traceparent !== "string") {
    throw new RuntimeProtocolError(400, "invalid_message_request");
  }
  const match = TRACE_PARENT_PATTERN.exec(value.traceparent);
  const requestId = value.request_id;
  if (match === null || (requestId !== undefined &&
      (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId) || match[1] !== requestId.slice(4)))) {
    throw new RuntimeProtocolError(400, "invalid_message_request");
  }
  return Object.freeze({
    attemptId: value.attempt_id, attempt: value.attempt,
    ...(requestId === undefined ? {} : { requestId }),
    traceId: match[1]!, parentSpanId: match[2]!,
  });
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
}

function readMessage<Input>(value: unknown): RuntimeMessage<Input> {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      typeof value.id !== "string" || !MESSAGE_ID_PATTERN.test(value.id) || !("payload" in value)) {
    throw new RuntimeProtocolError(400, "invalid_message_request");
  }
  return Object.freeze({ id: value.id, payload: value.payload as Input });
}

function readSession(value: unknown): SessionIdentity {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
      typeof value.id !== "string" || !SESSION_ID_PATTERN.test(value.id) ||
      typeof value.workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(value.workspace_id) ||
      typeof value.keep_alive_seconds !== "number" || !Number.isInteger(value.keep_alive_seconds) ||
      value.keep_alive_seconds < 0 || value.keep_alive_seconds > MAX_KEEP_ALIVE_SECONDS) {
    throw new RuntimeProtocolError(400, "invalid_message_request");
  }
  return Object.freeze({ id: value.id, workspaceId: value.workspace_id, keepAliveSeconds: value.keep_alive_seconds });
}

export function writeError(response: ServerResponse, status: number, code: string): void {
  writeJSON(response, status, { error: { code } });
}

export function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

export function readInternalPort(environment: NodeJS.ProcessEnv): number {
  const value = environment[INTERNAL_PORT_VARIABLE];
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${INTERNAL_PORT_VARIABLE} is not configured`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${INTERNAL_PORT_VARIABLE} must be a TCP port between 1 and 65535`);
  }
  return port;
}

export function readInternalFD(environment: NodeJS.ProcessEnv): number | undefined {
  const value = environment[INTERNAL_FD_VARIABLE];
  if (value === undefined) return undefined;
  const descriptor = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1_048_575) {
    throw new Error(`${INTERNAL_FD_VARIABLE} must be an inherited file descriptor`);
  }
  return descriptor;
}
