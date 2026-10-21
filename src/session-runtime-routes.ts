/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTH_TERMINAL_ROUTE } from "./auth-terminal.js";
import type { AuthTerminals } from "./auth-terminal.js";
import type { RuntimeObservationBuffer } from "./observability.js";
import type { SessionOutputBuffer } from "./output.js";
import type { SessionIdentity } from "./resources.js";
import { decodeRuntimeCommand, type RuntimeCommand } from "./runtime-command.js";
import { RuntimeProtocolError, type MessageReceipt, type RuntimeMessages } from "./runtime-messages.js";
import type { RuntimeQuiescence } from "./runtime-quiescence.js";
import type { RuntimeRecovery, SupervisedWork } from "./session-runtime-adapter.js";
import {
  ACTIVITY_CANCEL_PATH, COMPLETIONS_PATH, LONG_POLL_MS, MESSAGE_PATH, MESSAGE_PROTOCOL_VERSION, MESSAGE_STATUS_ROUTE,
  OBSERVATIONS_PATH, OUTPUT_PATH, QUIESCENCE_PATH, RECOVERY_PATH, RUNTIME_PATH,
  isJSONContentType, readMessageEnvelope, readRecoveryRequest, readRequestEnvelope, writeError, writeJSON,
  type MessageEnvelope,
} from "./session-runtime-protocol.js";
import { isRecord } from "./shared.js";

/** What the HTTP surface needs from one Session runtime incarnation. */
export interface RuntimeRouteTarget<Input> {
  readonly messages: RuntimeMessages;
  readonly quiescence: RuntimeQuiescence;
  readonly output: SessionOutputBuffer;
  readonly observations: RuntimeObservationBuffer;
  readonly work: SupervisedWork;
  readonly capabilities: { readonly recovery: boolean; readonly redelivery: boolean };
  readonly closingSignal: AbortSignal;
  readonly authTerminals: AuthTerminals | undefined;
  readonly session: SessionIdentity | undefined;
  bindSession(session: SessionIdentity): void;
  admit(envelope: MessageEnvelope<Input>, command: RuntimeCommand<Input>): MessageReceipt;
  recover(recoveryId: string, interruptedMessageId: string, session: SessionIdentity): RuntimeRecovery;
}
type Runtime<Input> = RuntimeRouteTarget<Input>;

/** Serves one request on the platform-owned message socket; protocol errors propagate to the caller. */
export async function handleRuntimeRequest<Input>(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: Runtime<Input>,
): Promise<void> {
  const { messages } = runtime;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  const url = new URL(request.url ?? "/", "http://session-runtime.cantelop.internal");
  response.setHeader("X-Cantelop-Sandbox-ID", messages.sandboxId);
  response.setHeader("X-Cantelop-Message-Protocol", String(MESSAGE_PROTOCOL_VERSION));
  if (request.headers["x-cantelop-sandbox-id"] !== messages.sandboxId) throw new RuntimeProtocolError(409, "sandbox_mismatch");

  if (url.pathname === RUNTIME_PATH && request.method === "GET") {
    writeJSON(response, 200, {
      sandbox_id: messages.sandboxId, protocol: MESSAGE_PROTOCOL_VERSION, message_work: messages.work(),
      generation: runtime.quiescence.generation, quiescent: runtime.quiescence.quiescent, activity: runtime.work.snapshot(),
      capabilities: {
        recovery: runtime.capabilities.recovery, completionNotifications: true, replies: true,
        redelivery: runtime.capabilities.redelivery, steering: true, messageCancellation: true, durableView: true,
      },
      observations: runtime.observations.metadata(), events: runtime.output.metadata(),
    });
    return;
  }
  const terminal = AUTH_TERMINAL_ROUTE.exec(url.pathname);
  if (terminal) {
    const terminals = runtime.authTerminals;
    if (!terminals || url.search) throw new RuntimeProtocolError(404, "not_found");
    await terminals.serve(request, response, terminal[1]!, terminal[2] as "attach" | "input" | "resize");
    return;
  }
  if (url.pathname === RECOVERY_PATH && request.method === "POST") {
    if (!isJSONContentType(request.headers["content-type"])) throw new RuntimeProtocolError(415, "unsupported_media_type");
    const { recoveryId, messageId, session } = readRecoveryRequest(await readRequestEnvelope(request));
    runtime.bindSession(session);
    writeJSON(response, 200, await runtime.recover(recoveryId, messageId, session).result);
    return;
  }
  if (url.pathname === ACTIVITY_CANCEL_PATH && request.method === "POST") {
    const body = await readRequestEnvelope(request);
    if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.activity_id !== "string") throw new RuntimeProtocolError(400, "invalid_activity_cancel");
    const current = runtime.work.snapshot();
    if (!isRecord(current) || current.id !== body.activity_id) throw new RuntimeProtocolError(409, "activity_mismatch");
    runtime.work.cancel(undefined, body.activity_id);
    writeJSON(response, 200, { active: runtime.work.active });
    return;
  }
  for (const [path, buffer] of [[OUTPUT_PATH, runtime.output], [OBSERVATIONS_PATH, runtime.observations]] as const) {
    if (url.pathname === path + "/ack" && request.method === "POST") {
      const body = await readRequestEnvelope(request);
      if (!isRecord(body) || Object.keys(body).length !== 1 || !Number.isSafeInteger(body.through)) throw new RuntimeProtocolError(400, "invalid_acknowledgment");
      try {
        buffer.acknowledge(body.through as number);
      } catch (error) {
        throw error instanceof RangeError ? new RuntimeProtocolError(409, error.message) : error;
      }
      writeJSON(response, 200, buffer.metadata());
      return;
    }
  }
  if (url.pathname === OUTPUT_PATH) {
    await serveCursorRead(request, response, url, runtime.closingSignal, "invalid_output_request",
      (after, signal, wait) => runtime.output.read(after, signal, wait, false),
      events => ({
        events: events.map(event => ({
          cursor: event.cursor, message_id: event.messageId, event: event.event,
          ...(event.view === undefined ? {} : { view: event.view }),
        })),
      }));
    return;
  }
  if (url.pathname === OBSERVATIONS_PATH) {
    await serveCursorRead(request, response, url, runtime.closingSignal, "invalid_observation_request",
      (after, signal, wait) => runtime.observations.read(after, signal, wait, false),
      observations => ({
        observations: observations.map(observation => ({
          cursor: observation.cursor, message_id: observation.messageId, observation: observation.observation,
        })),
      }));
    return;
  }
  if (url.pathname === QUIESCENCE_PATH) { await serveQuiescence(request, response, url, runtime); return; }
  if (url.pathname === COMPLETIONS_PATH) { await serveCompletions(request, response, url, runtime); return; }

  const status = MESSAGE_STATUS_ROUTE.exec(url.pathname);
  if (status && request.method === "GET" && status[3] === "reply") {
    writeJSON(response, 200, { reply: messages.reply(status[1]!) });
    return;
  }
  if (status && ((request.method === "GET" && !status[2]) || (request.method === "POST" && status[3] === "cancel"))) {
    writeJSON(response, 200, status[2] ? messages.cancel(status[1]!, "message_cancelled") : messages.get(status[1]!));
    return;
  }
  if (url.pathname !== MESSAGE_PATH || url.search !== "") { writeError(response, 404, "not_found"); return; }
  if (request.method !== "POST") { writeError(response, 405, "method_not_allowed"); return; }
  if (!isJSONContentType(request.headers["content-type"])) { writeError(response, 415, "unsupported_media_type"); return; }
  const envelope = readMessageEnvelope<Input>(await readRequestEnvelope(request));
  runtime.bindSession(envelope.session);
  let command: RuntimeCommand<Input>;
  try {
    command = decodeRuntimeCommand<Input>(envelope.message.payload);
  } catch {
    throw new RuntimeProtocolError(400, "invalid_sdk_command");
  }
  writeJSON(response, 202, runtime.admit(envelope, command));
}

/** True when the request is a GET; otherwise answers 405 with an Allow header. */
function allowGet(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "GET") return true;
  response.setHeader("Allow", "GET");
  writeError(response, 405, "method_not_allowed");
  return false;
}

/** Reads the single non-negative integer query parameter `name`, allowing only `extra` keys besides it. */
function readCounter(url: URL, name: string, extra: readonly string[] = []): number | undefined {
  const values = url.searchParams.getAll(name);
  if ([...url.searchParams.keys()].some(key => key !== name && !extra.includes(key)) ||
      values.length !== 1 || !/^\d+$/.test(values[0] ?? "")) return undefined;
  const value = Number(values[0]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Waits for `wait` until the client goes away, the long-poll window ends or the
 * server starts closing. Failures while the client is still connected are
 * answered by `fail`; closing answers 503 so shutdown never waits on a poll.
 */
async function longPoll<T>(
  request: IncomingMessage,
  response: ServerResponse,
  closing: AbortSignal,
  wait: (signal: AbortSignal) => Promise<T>,
  respond: (value: T) => void,
  fail: (error: unknown) => void,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => { if (!response.writableEnded) controller.abort(new DOMException("Runtime long poll closed", "AbortError")); };
  request.once("aborted", abort);
  response.once("close", abort);
  try {
    const value = await wait(AbortSignal.any([controller.signal, closing, AbortSignal.timeout(LONG_POLL_MS)]));
    if (!response.destroyed) respond(value);
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    if (closing.aborted) writeError(response, 503, "runtime_closing");
    else fail(error);
  } finally {
    request.removeListener("aborted", abort);
    response.removeListener("close", abort);
  }
}

async function serveCursorRead<T>(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  closing: AbortSignal,
  invalidCode: string,
  read: (after: number, signal: AbortSignal, wait: boolean) => Promise<readonly T[]>,
  render: (items: readonly T[]) => unknown,
): Promise<void> {
  if (!allowGet(request, response)) return;
  const waitValues = url.searchParams.getAll("wait");
  const after = readCounter(url, "after", ["wait"]);
  if (after === undefined || waitValues.length > 1 || (waitValues.length === 1 && waitValues[0] !== "0")) {
    writeError(response, 400, invalidCode);
    return;
  }
  await longPoll(request, response, closing,
    signal => read(after, signal, waitValues.length === 0),
    items => writeJSON(response, 200, render(items)),
    error => error instanceof RangeError ? writeError(response, 409, error.message) : writeError(response, 408, "poll_timeout"));
}

async function serveQuiescence<Input>(request: IncomingMessage, response: ServerResponse, url: URL, runtime: Runtime<Input>): Promise<void> {
  if (!allowGet(request, response)) return;
  const minimumGeneration = readCounter(url, "minimum_generation");
  if (minimumGeneration === undefined) { writeError(response, 400, "invalid_quiescence_request"); return; }
  if (runtime.session === undefined) { writeError(response, 409, "session_unbound"); return; }
  await longPoll(request, response, runtime.closingSignal,
    signal => runtime.quiescence.waitForQuiescence(minimumGeneration, signal),
    snapshot => writeJSON(response, 200, { state: "quiescent", generation: snapshot.generation }),
    () => writeError(response, 500, "quiescence_failed"));
}

async function serveCompletions<Input>(request: IncomingMessage, response: ServerResponse, url: URL, runtime: Runtime<Input>): Promise<void> {
  if (!allowGet(request, response)) return;
  const values = url.searchParams.getAll("after");
  if ([...url.searchParams.keys()].some(key => key !== "after") || values.length !== 1 || !/^\d+$/.test(values[0] ?? "")) {
    writeError(response, 400, "invalid_completion_request");
    return;
  }
  // Out-of-range generations are the message registry's protocol error, not a malformed request.
  await longPoll(request, response, runtime.closingSignal,
    signal => runtime.messages.completions(Number(values[0]), signal),
    result => writeJSON(response, 200, result),
    error => {
      if (error instanceof RuntimeProtocolError) throw error;
      writeError(response, 408, "completion_wait_timeout");
    });
}
