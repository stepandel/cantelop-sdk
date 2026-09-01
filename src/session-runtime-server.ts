/// <reference types="node" />

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

import type {
  SessionActivity,
  SessionActivityFunction,
  SessionContext,
  SessionEnvironment,
  SessionBehaviour,
  SessionOutput,
} from "./session.js";
import { ObservableMessage } from "./session.js";
import type { SessionIdentity } from "./resources.js";
import {
  MessageObserver,
  RuntimeObservationBuffer,
  type RuntimeTraceContext,
} from "./observability.js";
import { markSessionRuntimeStartup, markMessageLifecycle } from "./session-runtime-startup.js";
import { InMemoryActivity } from "./activity.js";
import { InMemoryMailbox } from "./mailbox.js";
import { RuntimeQuiescence } from "./runtime-quiescence.js";
import { SessionOutputBuffer } from "./output.js";

const MESSAGE_PATH = "/__cantelop/v1/messages";
const QUIESCENCE_PATH = "/__cantelop/v1/runtime/quiescence";
const OUTPUT_PATH = "/__cantelop/v1/runtime/events";
const OBSERVATIONS_PATH = "/__cantelop/v1/runtime/observations";
const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{32}$/;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const INTERNAL_PORT_VARIABLE = "CANTELOP_INTERNAL_PORT";
const INTERNAL_FD_VARIABLE = "CANTELOP_INTERNAL_FD";
const MESSAGE_COMPLETE_HEADER = "X-Cantelop-SDK-Message-Complete";
const SESSION_GENERATION_HEADER = "X-Cantelop-SDK-Session-Generation";
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_ID_PATTERN = /^wsp_[0-9a-f]{32}$/;
const MAX_KEEP_ALIVE_SECONDS = 604_800;
const ATTEMPT_ID_PATTERN = /^att_[0-9a-f]{32}$/;
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/;
const TRACE_PARENT_PATTERN = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-01$/;

export interface SessionRuntimeHandlerOptions {
  env?: SessionEnvironment;
}

export interface SessionRuntimeServer {
  readonly server: Server;
  readonly port: number;
  /** Resolves only after the platform-owned message socket is accepting connections. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

type SessionRuntimeHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void;

interface RuntimeDelivery {
  readonly generation: number;
  readonly settled: Promise<void>;
}

/**
 * Creates the native HTTP protocol adapter. This lower-level entrypoint is
 * primarily useful to platform integration tests and custom native launchers.
 */
export function createSessionRuntimeHandler<Input, Event = never>(
  behaviour: SessionBehaviour<Input, Event>,
  options: SessionRuntimeHandlerOptions = {},
): SessionRuntimeHandler {
  let boundSession: SessionIdentity | undefined;
  let quiescence: RuntimeQuiescence;
  const outputBuffer = new SessionOutputBuffer();
  const observationBuffer = new RuntimeObservationBuffer();
  const mailbox = new InMemoryMailbox<void>(markMessageLifecycle, () => quiescence.changed());
  let activity: InMemoryActivity<Input, Event>;

  const receiveMessage = (
    message: Readonly<{ id: string; payload: Input }>,
    session: SessionIdentity,
    trace: RuntimeTraceContext | undefined,
  ): RuntimeDelivery => {
    const generation = quiescence.observeMessage(message.id);
    const settled = mailbox.enqueue(message.id, async (sequence) => {
      let invocationOpen = true;
      const send = (payload: Input): void => {
        if (!invocationOpen) {
          throw new Error("Session runtime message invocation has already settled");
        }
        sendMessage(payload);
      };
      let outputOpen = true;
      const output: SessionOutput<Event> = Object.freeze({
        async send(event: Event): Promise<void> {
          if (!outputOpen) {
            throw new Error("Session runtime message invocation has already settled");
          }
          await outputBuffer.publish(message.id, event);
        },
      });
      const activityCapability: SessionActivity<Input, Event> = Object.freeze({
        get active() {
          return activity.active;
        },
        start(work: SessionActivityFunction<Input, Event>) {
          activity.start(message.id, work);
        },
        cancel(reason?: unknown) {
          return activity.cancel(reason);
        },
      });
      const observer = new MessageObserver(message.id, trace, observationBuffer);
      const observableMessage = new ObservableMessage(message.id, sequence, message.payload, observer);
      try {
        await observer.span("session.receive", () => invokeBehaviour(behaviour, Object.freeze({
          message: observableMessage, session, env: options.env ?? process.env,
          activity: activityCapability, output, send,
        })));
      } finally {
        invocationOpen = false;
        outputOpen = false;
      }
    });
    return Object.freeze({ generation, settled });
  };

  const sendMessage = (payload: Input): void => {
    if (boundSession === undefined) {
      throw new Error("Session runtime cannot send before its Session is bound");
    }
    const message = Object.freeze({ id: createMessageID(), payload });
    void receiveMessage(message, boundSession, undefined).settled.catch(() => undefined);
  };

  activity = new InMemoryActivity(
    sendMessage,
    (messageId, event) => outputBuffer.publish(messageId, event),
    () => quiescence.changed(),
  );
  quiescence = new RuntimeQuiescence(() => mailbox.isIdle && activity.isIdle);
  return (request, response) => {
    void handleRequest(
      request,
      response,
      receiveMessage,
      quiescence,
      outputBuffer,
      observationBuffer,
      () => boundSession,
      (session) => {
        if (boundSession !== undefined &&
            (boundSession.id !== session.id ||
              boundSession.workspaceId !== session.workspaceId)) {
          throw new ProtocolError(409, "session_mismatch");
        }
        boundSession ??= session;
      },
    );
  };
}

/**
 * Starts the Session runtime server on the port injected by Cantelop. Customer
 * code never supplies a deployment port.
 */
export function serveSessionRuntime<Input, Event = never>(
  behaviour: SessionBehaviour<Input, Event>,
): SessionRuntimeServer {
  const port = readInternalPort(process.env[INTERNAL_PORT_VARIABLE]);
  const inheritedFD = readInternalFD(process.env[INTERNAL_FD_VARIABLE]);
  const server = createServer(createSessionRuntimeHandler(behaviour));
  markSessionRuntimeStartup("server_created");
  const ready = listen(server, port, inheritedFD);
  return {
    server,
    port,
    ready,
    close: () => closeServer(server),
  };
}

function listen(server: Server, port: number, inheritedFD: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const listening = () => {
      server.removeListener("error", failed);
      markSessionRuntimeStartup("listener_ready");
      resolve();
    };
    const failed = (error: Error) => {
      server.removeListener("listening", listening);
      reject(error);
    };
    server.once("listening", listening);
    server.once("error", failed);
    if (inheritedFD === undefined) server.listen(port, "0.0.0.0");
    else server.listen({ fd: inheritedFD });
  });
}

async function handleRequest<Input>(
  request: IncomingMessage,
  response: ServerResponse,
  receiveMessage: (
    message: Readonly<{ id: string; payload: Input }>,
    session: SessionIdentity,
    trace: RuntimeTraceContext | undefined,
  ) => RuntimeDelivery,
  quiescence: RuntimeQuiescence,
  outputBuffer: SessionOutputBuffer,
  observationBuffer: RuntimeObservationBuffer,
  boundSession: () => SessionIdentity | undefined,
  bindSession: (session: SessionIdentity) => void,
): Promise<void> {
  setBaseHeaders(response);
  const url = new URL(request.url ?? "/", "http://session-runtime.cantelop.internal");
  if (url.pathname === OUTPUT_PATH) {
    await handleOutputRequest(request, response, url, outputBuffer);
    return;
  }
  if (url.pathname === OBSERVATIONS_PATH) {
    await handleObservationRequest(request, response, url, observationBuffer);
    return;
  }
  if (url.pathname === QUIESCENCE_PATH) {
    await handleQuiescenceRequest(request, response, url, quiescence, boundSession());
    return;
  }
  if (url.pathname !== MESSAGE_PATH || url.search !== "") {
    writeError(response, 404, "not_found");
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    writeError(response, 405, "method_not_allowed");
    return;
  }
  if (!isJSONContentType(request.headers["content-type"])) {
    writeError(response, 415, "unsupported_media_type");
    return;
  }
  let messageSettled = false;
  let acceptedMessageID: string | undefined;
  let acceptedGeneration: number | undefined;

  try {
    const envelope = await readRequestEnvelope(request);
    if (!isRecord(envelope) || !hasMessageEnvelopeShape(envelope)) {
      writeError(response, 400, "invalid_message_request");
      return;
    }
    const message = readMessage<Input>(envelope.message);
    acceptedMessageID = message.id;
    const session = readSession(envelope.session);
    const trace = readObservabilityContext(envelope.observability);
    bindSession(session);
    const delivery = receiveMessage(message, session, trace);
    acceptedGeneration = delivery.generation;
    try {
      await delivery.settled;
    } finally {
      messageSettled = true;
    }
    if (response.destroyed) return;
    response.setHeader(MESSAGE_COMPLETE_HEADER, message.id);
    response.setHeader(SESSION_GENERATION_HEADER, String(delivery.generation));
    response.statusCode = 204;
    response.end();
  } catch (error) {
    if (response.destroyed) return;
    if (messageSettled && acceptedMessageID !== undefined) {
      response.setHeader(MESSAGE_COMPLETE_HEADER, acceptedMessageID);
      if (acceptedGeneration !== undefined) {
        response.setHeader(SESSION_GENERATION_HEADER, String(acceptedGeneration));
      }
    }
    if (error instanceof ProtocolError) {
      writeError(response, error.status, error.code);
      return;
    }
    writeError(response, 500, "message_failed");
  }
}

async function handleObservationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  buffer: RuntimeObservationBuffer,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writeError(response, 405, "method_not_allowed");
    return;
  }
  const values = url.searchParams.getAll("after");
  const waitValues = url.searchParams.getAll("wait");
  if ([...url.searchParams.keys()].some((key) => key !== "after" && key !== "wait") ||
      values.length !== 1 || !/^\d+$/.test(values[0] ?? "") ||
      waitValues.length > 1 || (waitValues.length === 1 && waitValues[0] !== "0")) {
    writeError(response, 400, "invalid_observation_request");
    return;
  }
  const after = Number(values[0]);
  if (!Number.isSafeInteger(after)) {
    writeError(response, 400, "invalid_observation_request");
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Runtime observation request closed", "AbortError"));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  try {
    const observations = await buffer.read(after, controller.signal, waitValues.length === 0);
    if (response.destroyed) return;
    writeJSON(response, 200, {
      observations: observations.map((observation) => ({
        cursor: observation.cursor,
        message_id: observation.messageId,
        observation: observation.observation,
      })),
    });
  } catch {
    if (!controller.signal.aborted && !response.destroyed) {
      writeError(response, 500, "observation_failed");
    }
  } finally {
    request.removeListener("aborted", abort);
  }
}

async function handleOutputRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  outputBuffer: SessionOutputBuffer,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writeError(response, 405, "method_not_allowed");
    return;
  }
  const values = url.searchParams.getAll("after");
  const waitValues = url.searchParams.getAll("wait");
  if ([...url.searchParams.keys()].some((key) => key !== "after" && key !== "wait") ||
	  values.length !== 1 || !/^\d+$/.test(values[0] ?? "") ||
	  waitValues.length > 1 || (waitValues.length === 1 && waitValues[0] !== "0")) {
    writeError(response, 400, "invalid_output_request");
    return;
  }
  const after = Number(values[0]);
  if (!Number.isSafeInteger(after)) {
	  writeError(response, 400, "invalid_output_request");
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Session output request closed", "AbortError"));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  try {
    const events = await outputBuffer.read(after, controller.signal, waitValues.length === 0);
    if (response.destroyed) return;
    writeJSON(response, 200, {
      events: events.map((event) => ({
        cursor: event.cursor,
        message_id: event.messageId,
        event: event.event,
      })),
    });
  } catch {
    if (!controller.signal.aborted && !response.destroyed) {
      writeError(response, 500, "output_failed");
    }
  } finally {
    request.removeListener("aborted", abort);
  }
}

async function handleQuiescenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  quiescence: RuntimeQuiescence,
  session: SessionIdentity | undefined,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    writeError(response, 405, "method_not_allowed");
    return;
  }
  const values = url.searchParams.getAll("minimum_generation");
  if ([...url.searchParams.keys()].some((key) => key !== "minimum_generation") ||
      values.length !== 1 || !/^\d+$/.test(values[0] ?? "")) {
    writeError(response, 400, "invalid_quiescence_request");
    return;
  }
  const minimumGeneration = Number(values[0]);
  if (!Number.isSafeInteger(minimumGeneration) || session === undefined) {
    writeError(
      response,
      session === undefined ? 409 : 400,
      session === undefined ? "session_unbound" : "invalid_quiescence_request",
    );
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException("Quiescence request closed", "AbortError"));
  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) abort();
  });
  try {
    const snapshot = await quiescence.waitForQuiescence(
      minimumGeneration,
      controller.signal,
    );
    if (response.destroyed) return;
    writeJSON(response, 200, {
      state: "quiescent",
      generation: snapshot.generation,
    });
  } catch (error) {
    if (!controller.signal.aborted && !response.destroyed) {
      writeError(response, 500, "quiescence_failed");
    }
  } finally {
    request.removeListener("aborted", abort);
  }
}

async function readRequestEnvelope(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers["content-length"];
  if (
    declaredLength !== undefined &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ENVELOPE_BYTES)
  ) {
    throw new ProtocolError(413, "message_input_too_large");
  }

  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    length += bytes.byteLength;
    if (length > MAX_ENVELOPE_BYTES) {
      throw new ProtocolError(413, "message_input_too_large");
    }
    chunks.push(bytes);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ProtocolError(400, "invalid_message_request");
  }
}

function invokeBehaviour<Input, Event>(
  behaviour: SessionBehaviour<Input, Event>,
  context: SessionContext<Input, Event>,
): void | Promise<void> {
  return behaviour.receive(context);
}

function createMessageID(): string {
  return `msg_${randomUUID().replaceAll("-", "")}`;
}

function readInternalPort(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`${INTERNAL_PORT_VARIABLE} is not configured`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${INTERNAL_PORT_VARIABLE} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function readInternalFD(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${INTERNAL_FD_VARIABLE} must be an inherited file descriptor`);
  }
  const descriptor = Number(value);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1_048_575) {
    throw new Error(`${INTERNAL_FD_VARIABLE} must be an inherited file descriptor`);
  }
  return descriptor;
}

function isJSONContentType(value: string | undefined): boolean {
  return value !== undefined && /^application\/json(?:\s*;|$)/i.test(value);
}

function hasMessageEnvelopeShape(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return (keys.length === 2 || (keys.length === 3 && keys.includes("observability"))) &&
    keys.includes("session") && keys.includes("message") &&
    isRecord(value.session) && isRecord(value.message);
}

function readObservabilityContext(value: unknown): RuntimeTraceContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !exactKeys(value, ["attempt_id", "attempt", "traceparent"], ["request_id"]) ||
      typeof value.attempt_id !== "string" || !ATTEMPT_ID_PATTERN.test(value.attempt_id) ||
      typeof value.attempt !== "number" || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 100 ||
      typeof value.traceparent !== "string") {
    throw new ProtocolError(400, "invalid_message_request");
  }
  const match = TRACE_PARENT_PATTERN.exec(value.traceparent);
  const requestId = value.request_id;
  if (match === null || (requestId !== undefined &&
      (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId) || match[1] !== requestId.slice(4)))) {
    throw new ProtocolError(400, "invalid_message_request");
  }
  return Object.freeze({
    attemptId: value.attempt_id, attempt: value.attempt,
    ...(requestId === undefined ? {} : { requestId }),
    traceId: match[1]!, parentSpanId: match[2]!,
  });
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function readMessage<Input>(value: unknown): Readonly<{ id: string; payload: Input }> {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      typeof value.id !== "string" || !MESSAGE_ID_PATTERN.test(value.id) ||
      !("payload" in value)) {
    throw new ProtocolError(400, "invalid_message_request");
  }
  return Object.freeze({ id: value.id, payload: value.payload as Input });
}

function readSession(value: unknown): SessionIdentity {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
      typeof value.id !== "string" || !SESSION_ID_PATTERN.test(value.id) ||
      typeof value.workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(value.workspace_id) ||
      typeof value.keep_alive_seconds !== "number" ||
      !Number.isInteger(value.keep_alive_seconds) || value.keep_alive_seconds < 0 ||
      value.keep_alive_seconds > MAX_KEEP_ALIVE_SECONDS) {
    throw new ProtocolError(400, "invalid_message_request");
  }
  return Object.freeze({
    id: value.id,
    workspaceId: value.workspace_id,
    keepAliveSeconds: value.keep_alive_seconds,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setBaseHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
}

function writeError(response: ServerResponse, status: number, code: string): void {
  writeJSON(response, status, { error: { code } });
}

function writeJSON(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
