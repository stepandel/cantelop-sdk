import { assertSessionRuntime, type SessionRuntime } from "./session-runtime-contract.js";
import { createSessionDatabase } from "./session-database.js";
/// <reference types="node" />

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";

import type {
  SessionActivationContext,
  SessionActivity,
  SessionActivityFunction,
  SessionActivityOptions,
  SessionActivityQueueOptions,
  SessionEnvironment,
  SessionHarness,
  SessionHarnessWorkContext,
  SessionViewWriter,
  SessionOutput,
  SessionRecoveryContext,
} from "./session.js";
import type { SessionIdentity } from "./resources.js";
import {
  RuntimeObserver,
  RuntimeObservationBuffer,
  type RuntimeTraceContext,
} from "./observability.js";
import {
  registerRuntimeLogBuffer,
  runWithRuntimeLogContext,
  withoutRuntimeLogCapture,
} from "./runtime-log-capture.js";
import { markSessionRuntimeStartup, markMessageLifecycle } from "./session-runtime-startup.js";
import { FollowupMessages, InMemoryActivity, type ActivityLifecycle } from "./activity.js";
import { decodeRuntimeCommand, type RuntimeCommand } from "./runtime-command.js";
import { AUTH_SESSION_ID, isAppAuth, type AppAuth } from "./native-auth.js";
import { AUTH_TERMINAL_ROUTE, AuthTerminals } from "./auth-terminal.js";
import { InMemoryMailbox } from "./mailbox.js";
import { RuntimeQuiescence } from "./runtime-quiescence.js";
import { SessionOutputBuffer } from "./output.js";
import { RuntimeMessages, RuntimeProtocolError } from "./runtime-messages.js";

const MESSAGE_PATH = "/__cantelop/v2/messages";
const QUIESCENCE_PATH = "/__cantelop/v2/runtime/quiescence";
const OUTPUT_PATH = "/__cantelop/v2/runtime/events";
const OBSERVATIONS_PATH = "/__cantelop/v2/runtime/observations";
const RECOVERY_PATH = "/__cantelop/v2/runtime/recoveries";
const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{32}$/;
const MAX_ENVELOPE_BYTES = 1024 * 1024;
const INTERNAL_PORT_VARIABLE = "CANTELOP_INTERNAL_PORT";
const INTERNAL_FD_VARIABLE = "CANTELOP_INTERNAL_FD";
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKSPACE_ID_PATTERN = /^wsp_[0-9a-f]{32}$/;
const MAX_KEEP_ALIVE_SECONDS = 604_800;
const ATTEMPT_ID_PATTERN = /^att_[0-9a-f]{32}$/;
const REQUEST_ID_PATTERN = /^req_[0-9a-f]{32}$/;
const TRACE_PARENT_PATTERN = /^00-((?!0{32})[0-9a-f]{32})-((?!0{16})[0-9a-f]{16})-01$/;
const RECOVERY_ID_PATTERN = /^rcv_[0-9a-f]{32}$/;

export interface SessionRuntimeHandlerOptions {
  env?: SessionEnvironment;
  sandboxId?: string;
  executionTimeoutMs?: number;
  /** The App's declared auth provider; only the reserved auth Session uses it. */
  auth?: AppAuth;
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
  /** A plain holder, never a closure: records outlive the receive scope. */
  readonly reply?: { value: unknown };
}

interface HarnessOperation {
  readonly id: string;
  readonly controller: AbortController;
  readonly deadline: number;
  cancelledAt?: string;
}

interface RuntimeRecovery {
  readonly fingerprint: string;
  readonly generation: number;
  readonly result: Promise<Readonly<{
    recovery_id: string;
    generation: number;
    state: "completed" | "failed";
  }>>;
}

/**
 * Creates the native HTTP protocol adapter. This lower-level entrypoint is
 * primarily useful to platform integration tests and custom native launchers.
 */
export function createSessionRuntimeHandler<Input, Event = never, Reply = never, View = unknown>(
  behaviour: SessionRuntime<Input, Event, Reply, View>,
  options: SessionRuntimeHandlerOptions = {},
): SessionRuntimeHandler {
  return createSessionRuntimeAdapter(behaviour, options).handler;
}

function createSessionRuntimeAdapter<Input, Event = never, Reply = never, View = unknown>(
  behaviour: SessionRuntime<Input, Event, Reply, View>,
  options: SessionRuntimeHandlerOptions = {},
): { handler: SessionRuntimeHandler; observationBuffer: RuntimeObservationBuffer; closeDatabase(): void; } {
  assertSessionRuntime(behaviour);
  if (options.auth !== undefined && !isAppAuth(options.auth)) throw new TypeError("Invalid App auth");
  const sandboxId = options.sandboxId ?? process.env.CANTELOP_SANDBOX_ID ?? "";
  const messages = new RuntimeMessages(sandboxId, options.executionTimeoutMs, 4096, (id, reason) => {
    mailbox.cancel(id, reason);
    activity.cancelMessage(id);
    harnessOperations.get(id)?.controller.abort(reason);
  });
  let sessionDatabase = createSessionDatabase(options.env ?? process.env);
  const database = async () => {
    if (sessionDatabase.closed) sessionDatabase = createSessionDatabase(options.env ?? process.env);
    await sessionDatabase.credentials();
    return sessionDatabase;
  };
  let boundSession: SessionIdentity | undefined;
  // Activation belongs to the runtime incarnation, not to the Message that triggered it.
  const lifetime = new AbortController();
  let activation: Promise<void> | undefined;
  let harness: SessionHarness<Input, Event, Reply, View> | undefined;
  let pendingControls = 0;
  const harnessOperations = new Map<string, HarnessOperation>();
  const terminals = options.auth === undefined ? undefined
    : new AuthTerminals(options.auth, options.env ?? process.env, lifetime.signal, () => quiescence.changed());
  const activate = (session: SessionIdentity, messageId: string): Promise<void> => {
    activation ??= Promise.resolve().then(async () => {
      if ("create" in behaviour) {
        harness = await behaviour.create(Object.freeze({ signal: lifetime.signal, session, env: options.env ?? process.env, database }));
        if (!harness || ["queue", "steer", "cancel"].some(method =>
          typeof harness![method as keyof typeof harness] !== "function")) throw new TypeError("Invalid Session harness");
        return;
      }
      await behaviour.onActivate?.(Object.freeze({
        signal: lifetime.signal, session, env: options.env ?? process.env, database,
        activity: createActivityCapability(messageId, () => lifetime.signal.throwIfAborted()),
        // Restored work reports under the activating message.
        view: createViewCapability(messageId, lifetime.signal, () => lifetime.signal.throwIfAborted()),
        output: Object.freeze({
          send: (event: Event) => outputBuffer.publish(messageId, event, AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)])),
        }),
        send: (payload: Input) => { sendMessage(payload); return Promise.resolve(); },
      } satisfies SessionActivationContext<Input, Event, View>));
    });
    return activation;
  };
  let quiescence: RuntimeQuiescence;
  const outputBuffer = new SessionOutputBuffer();
  const createViewCapability = (
    messageId: string, signal: AbortSignal, assertOpen: () => void,
  ): SessionViewWriter<View> => Object.freeze({
    commit: (state: View) => {
      assertOpen();
      return outputBuffer.publish(messageId, state, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), true);
    },
  });
  const observationBuffer = new RuntimeObservationBuffer();
  const mailbox = new InMemoryMailbox<void>(markMessageLifecycle, () => quiescence.changed());
  let activity: InMemoryActivity<Input, Event, View>;
  const recoveries = new Map<string, RuntimeRecovery>();
  let nextIntakeSequence = 1;

  const createActivityCapability = (
    messageId: string,
    assertOpen: () => void,
    observe: (event: ActivityLifecycle) => void = () => undefined,
    priority = false,
  ): SessionActivity<Input, Event, View> => Object.freeze({
    get active() { return activity.active; },
    start(work: SessionActivityFunction<Input, Event, View>, options?: SessionActivityOptions<Input>) {
      assertOpen();
      activity.start(messageId, work, options, observe);
    },
    queue(work: SessionActivityFunction<Input, Event, View>, options?: SessionActivityQueueOptions<Input>) {
      assertOpen();
      activity.queue(messageId, work, { ...options, priority: options?.priority ?? priority }, observe);
    },
    steer(message: Input) { assertOpen(); return activity.steer(message); },
    extend(timeoutMs: number) { assertOpen(); activity.extend(timeoutMs); },
    cancel(reason?: unknown) { assertOpen(); return activity.cancel(reason); },
  });

  const receiveMessage = (
    message: Readonly<{ id: string; payload: Input; }>,
    session: SessionIdentity,
    trace: RuntimeTraceContext | undefined,
    signal: AbortSignal,
    started: () => void,
    replyRequested = false,
    command: RuntimeCommand<Input> = { type: "dispatch", message: message.payload },
  ): RuntimeDelivery => {
    const generation = quiescence.observeMessage(message.id);
    const sequence = nextIntakeSequence++;
    const replyHolder: { value: unknown } | undefined = replyRequested ? { value: undefined } : undefined;
    let replied = false;
    if (session.id === AUTH_SESSION_ID && command.type !== "auth") {
      started();
      return Object.freeze({ generation, settled: Promise.reject(new TypeError("Reserved auth Session requires an auth command")), ...(replyHolder ? { reply: replyHolder } : {}) });
    }
    if (command.type === "cancel") {
      const control = async () => {
        signal.throwIfAborted();
        if ("create" in behaviour) await activate(session, message.id);
        signal.throwIfAborted();
        const requested = "create" in behaviour ? await harness!.cancel() : activity.cancel();
        if (typeof requested !== "boolean") throw new TypeError("Session harness cancel must return a boolean");
        if (replyHolder) replyHolder.value = { id: message.id, state: requested ? "requested" : "idle" };
      };
      // Harness intake only hands submissions over, so FIFO order lets cancel
      // observe every submission admitted before it without blocking on work.
      const settled = "create" in behaviour
        ? mailbox.enqueue(message.id, async () => { started(); await control(); })
        : (started(), pendingControls++, control().finally(() => { pendingControls--; quiescence.changed(); }));
      return Object.freeze({ generation, settled, ...(replyHolder ? { reply: replyHolder } : {}) });
    }
    if (command.type === "auth") {
      // Auth never activates the Session runtime: no harness or agent state exists in the auth Sandbox.
      const settled = mailbox.enqueue(message.id, async () => {
        signal.throwIfAborted();
        started();
        if (session.id !== AUTH_SESSION_ID || !replyHolder) throw new TypeError("Invalid auth request");
        if (!terminals) throw new TypeError("App does not declare auth");
        const result = await terminals.handle(command.auth, session);
        const encoded = JSON.stringify(result);
        if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024) throw new TypeError("Invalid auth reply");
        replyHolder.value = JSON.parse(encoded);
      });
      return Object.freeze({ generation, settled, ...(replyHolder ? { reply: replyHolder } : {}) });
    }
    let workCompletion: Promise<void> | undefined;
    const settled = mailbox.enqueue(message.id, async () => {
      signal.throwIfAborted();
      started();
      let invocationOpen = true;
      const send = (payload: Input): Promise<void> => {
        if (!invocationOpen) {
          throw new Error("Session runtime message invocation has already settled");
        }
        sendMessage(payload);
        return Promise.resolve();
      };
      let outputOpen = true;
      const output: SessionOutput<Event> = Object.freeze({
        async send(event: Event): Promise<void> {
          if (!outputOpen) {
            throw new Error("Session runtime message invocation has already settled");
          }
          const handoff = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
          await outputBuffer.publish(message.id, event, handoff);
        },
      });
      const observer = new RuntimeObserver(message.id, trace, observationBuffer);
      const activityCapability = createActivityCapability(message.id, () => {
        if (!invocationOpen) throw new Error("Session runtime message invocation has already settled");
        signal.throwIfAborted();
      }, event => observer.recordActivity(event), command.type === "steer");
      const reply = (value: Reply): void => {
        if (!invocationOpen) throw new Error("Session runtime message invocation has already settled");
        if (replied) throw new Error("Session request already has a reply");
        let encoded: string | undefined;
        try { encoded = JSON.stringify(value); } catch { /* normalized below */ }
        if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024) {
          throw new Error("Session request reply must be JSON and at most 65536 bytes");
        }
        if (replyHolder) replyHolder.value = JSON.parse(encoded) as unknown;
        replied = true;
      };
      try {
        const context = Object.freeze({
          signal, command: Object.freeze({ type: command.type }), message: Object.freeze({ ...message, sequence }), session, env: options.env ?? process.env,
          activity: activityCapability, output, reply, send, database,
          view: createViewCapability(message.id, signal, () => {
            if (!invocationOpen) throw new Error("Session invocation settled");
          }),
        });
        await runWithRuntimeLogContext(observer, async () => {
          await activate(session, message.id);
          signal.throwIfAborted();
          await observer.span("session.receive", async () => {
            if ("receive" in behaviour) return behaviour.receive(context);
            // The harness receives every submission directly. The SDK only tracks
            // completion, attribution and deadlines; it never schedules provider work.
            if (harnessOperations.size >= 256) throw new Error("harness operation capacity");
            // Dispatch receipts settle at handoff, so the operation carries the message deadline itself.
            const operation: HarnessOperation = { id: randomUUID(), controller: new AbortController(), deadline: Date.parse(messages.get(message.id).deadline) };
            harnessOperations.set(message.id, operation);
            const workSignal = AbortSignal.any([signal, lifetime.signal, operation.controller.signal]);
            const timer = setTimeout(() => operation.controller.abort(new DOMException("Harness operation timed out", "AbortError")), Math.max(0, operation.deadline - Date.now()));
            timer.unref();
            const markCancellation = () => {
              operation.cancelledAt = new Date().toISOString();
              quiescence.changed();
            };
            operation.controller.signal.addEventListener("abort", markCancellation, { once: true });
            let workOpen = true;
            const followups = new FollowupMessages<Input>();
            const assertWorkOpen = () => {
              if (!workOpen) throw new Error("Session harness operation settled");
              workSignal.throwIfAborted();
            };
            const work: SessionHarnessWorkContext<Input, Event, View> = Object.freeze({
              signal: workSignal, session, env: options.env ?? process.env, database,
              message: Object.freeze({ ...message, sequence }),
              output: Object.freeze({ send: (event: Event) => {
                assertWorkOpen();
                return outputBuffer.publish(message.id, event, AbortSignal.any([workSignal, AbortSignal.timeout(30_000)]));
              } }),
              view: createViewCapability(message.id, workSignal, assertWorkOpen),
              send: (payload: Input) => {
                assertWorkOpen();
                followups.push(payload);
              },
            });
            quiescence.changed();
            const closeWork = () => {
              workOpen = false;
              clearTimeout(timer);
              operation.controller.signal.removeEventListener("abort", markCancellation);
              void followups.flush(sendMessage, "Harness completion message rejected").finally(() => {
                harnessOperations.delete(message.id);
                quiescence.changed();
              });
            };
            let execution: unknown;
            try {
              workSignal.throwIfAborted();
              execution = command.type === "steer"
                ? harness!.steer(message.payload, work)
                : harness!.queue(message.payload, work);
            } catch (error) { closeWork(); throw error; }
            workCompletion = Promise.resolve(execution).then(result => {
              workSignal.throwIfAborted();
              if (replyRequested) {
                let encoded: string | undefined;
                try { encoded = JSON.stringify(result); } catch { /* normalized below */ }
                if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024) throw new Error("Session request reply must be JSON and at most 65536 bytes");
                replyHolder!.value = JSON.parse(encoded);
              }
            }).finally(closeWork);
            // Request failures surface through the receipt; dispatch receipts settled at handoff.
            void workCompletion.catch(error => { if (!replyRequested) console.error("Session harness operation failed", error); });
          });
        });
        if ("receive" in behaviour && replyRequested && !replied) throw new Error("Session request completed without a reply");
      } finally {
        invocationOpen = false;
        outputOpen = false;
      }
    });
    return Object.freeze({ generation, settled: "create" in behaviour && replyRequested ? settled.then(() => workCompletion) : settled, ...(replyHolder ? { reply: replyHolder } : {}) });
  };

  const sendMessage = (payload: Input): void => {
    if (boundSession === undefined) {
      throw new Error("Session runtime cannot send before its Session is bound");
    }
    const message = Object.freeze({ id: createMessageID(), payload });
    messages.admit(message.id, { message, session: boundSession }, (signal, started) => receiveMessage(message, boundSession!, undefined, signal, started));
  };

  const recover = (
    recoveryId: string,
    interruptedMessageId: string,
    session: SessionIdentity,
  ): RuntimeRecovery => {
    const fingerprint = JSON.stringify({ interruptedMessageId, session });
    const existing = recoveries.get(recoveryId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new ProtocolError(409, "recovery_conflict");
      return existing;
    }
    if (behaviour.onRecover === undefined) throw new ProtocolError(409, "recovery_unsupported");
    const generation = quiescence.observeMessage(interruptedMessageId);
    const signal = AbortSignal.timeout(options.executionTimeoutMs ?? 5 * 60_000);
    const settled = mailbox.enqueue(recoveryId, async () => {
      signal.throwIfAborted();
      let invocationOpen = true;
      const send = (payload: Input): Promise<void> => {
        if (!invocationOpen) throw new Error("Session recovery invocation has already settled");
        sendMessage(payload);
        return Promise.resolve();
      };
      let outputOpen = true;
      const output: SessionOutput<Event> = Object.freeze({
        async send(event: Event): Promise<void> {
          if (!outputOpen) throw new Error("Session recovery invocation has already settled");
          await outputBuffer.publish(
            interruptedMessageId,
            event,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          );
        },
      });
      const activityCapability = createActivityCapability(interruptedMessageId, () => {
        if (!invocationOpen) throw new Error("Session recovery invocation has already settled");
        signal.throwIfAborted();
      });
      const context: SessionRecoveryContext<Input, Event, View> = Object.freeze({
        signal,
        database,
        recovery: Object.freeze({ id: recoveryId, interruptedMessageId }),
        view: createViewCapability(interruptedMessageId, signal, () => {
          if (!invocationOpen) throw new Error("Session recovery settled");
        }),
        session,
        env: options.env ?? process.env,
        activity: activityCapability,
        output,
        send,
      });
      try {
        await activate(session, interruptedMessageId);
        signal.throwIfAborted();
        await behaviour.onRecover!(context);
      } finally {
        invocationOpen = false;
        outputOpen = false;
      }
    });
    const result = settled.then(
      () => Object.freeze({ recovery_id: recoveryId, generation, state: "completed" as const }),
      () => Object.freeze({ recovery_id: recoveryId, generation, state: "failed" as const }),
    );
    const recovery = Object.freeze({ fingerprint, generation, result });
    recoveries.set(recoveryId, recovery);
    return recovery;
  };

  activity = new InMemoryActivity(
    sendMessage,
    (messageId, event, signal) => outputBuffer.publish(messageId, event, AbortSignal.any([signal, AbortSignal.timeout(30_000)])),
    () => quiescence.changed(),
    (messageId, state, signal) => outputBuffer.publish(messageId, state, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), true),
  );
  quiescence = new RuntimeQuiescence(() => mailbox.isIdle && activity.isIdle && harnessOperations.size === 0 && pendingControls === 0 && !terminals?.active);
  const supervisedWork = {
    get active() { return activity.active || harnessOperations.size > 0; },
    snapshot() {
      const pending = [...harnessOperations.values()].sort((a, b) => a.deadline - b.deadline)[0];
      const background = activity.snapshot();
      if (!pending || background && Date.parse(background.deadline) <= pending.deadline) return background;
      return { id: pending.id, deadline: new Date(pending.deadline).toISOString(), cancellation_requested_at: pending.cancelledAt };
    },
    cancel(reason?: unknown, activityId?: string) {
      const pending = [...harnessOperations.values()].find(value => value.id === activityId);
      if (!pending) return activity.cancel(reason, activityId);
      pending.controller.abort(reason ?? new DOMException("Harness operation cancelled", "AbortError"));
      return true;
    },
  };
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    void handleRequest(
      request,
      response,
      receiveMessage,
      quiescence,
      outputBuffer,
      observationBuffer,
      messages,
      supervisedWork,
      behaviour.onRecover !== undefined,
      behaviour.redelivery === true,
      recover,
      boundSession?.id === AUTH_SESSION_ID ? terminals : undefined,
      () => boundSession,
      (session) => {
        if (boundSession !== undefined &&
          (boundSession.id !== session.id ||
            boundSession.workspaceId !== session.workspaceId)) {
          throw new ProtocolError(409, "session_mismatch");
        }
        boundSession ??= session;
      },
    ).catch((error: unknown) => {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof RuntimeProtocolError || error instanceof ProtocolError) writeError(response, error.status, error.code);
      else if (error instanceof RangeError) writeError(response, 409, error.message);
      else writeError(response, 500, "runtime_error");
    });
  };
  return { handler, observationBuffer, closeDatabase: () => { lifetime.abort(); sessionDatabase.close(); } };
}

/**
 * Starts the Session runtime server on the port injected by Cantelop. Customer
 * code never supplies a deployment port.
 */
export function serveSessionRuntime<Input, Event = never, Reply = never, View = unknown>(
  behaviour: SessionRuntime<Input, Event, Reply, View>,
  options: { readonly auth?: AppAuth } = {},
): SessionRuntimeServer {
  const port = readInternalPort(process.env[INTERNAL_PORT_VARIABLE]);
  const inheritedFD = readInternalFD(process.env[INTERNAL_FD_VARIABLE]);
  const adapter = createSessionRuntimeAdapter(behaviour, options.auth === undefined ? {} : { auth: options.auth });
  const unregisterLogBuffer = registerRuntimeLogBuffer(adapter.observationBuffer);
  const server = createServer(adapter.handler);
  withoutRuntimeLogCapture(() => markSessionRuntimeStartup("server_created"));
  const ready = listen(server, port, inheritedFD);
  return {
    server,
    port,
    ready,
    close: async () => {
      try {
        await closeServer(server);
      } finally {
        await adapter.closeDatabase();
        unregisterLogBuffer();
      }
    },
  };
}

function listen(server: Server, port: number, inheritedFD: number | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const listening = () => {
      server.removeListener("error", failed);
      withoutRuntimeLogCapture(() => markSessionRuntimeStartup("listener_ready"));
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
    message: Readonly<{ id: string; payload: Input; }>,
    session: SessionIdentity,
    trace: RuntimeTraceContext | undefined,
    signal: AbortSignal, started: () => void,
    replyRequested?: boolean,
    command?: RuntimeCommand<Input>,
  ) => RuntimeDelivery,
  quiescence: RuntimeQuiescence,
  outputBuffer: SessionOutputBuffer,
  observationBuffer: RuntimeObservationBuffer,
  messages: RuntimeMessages,
  activity: { active: boolean; cancel(reason?: unknown, activityId?: string): boolean; snapshot(): unknown; },
  recoverySupported: boolean,
  redeliverySupported: boolean,
  recover: (recoveryId: string, interruptedMessageId: string, session: SessionIdentity) => RuntimeRecovery,
  terminals: AuthTerminals | undefined,
  boundSession: () => SessionIdentity | undefined,
  bindSession: (session: SessionIdentity) => void,
): Promise<void> {
  setBaseHeaders(response);
  const url = new URL(request.url ?? "/", "http://session-runtime.cantelop.internal");
  response.setHeader("X-Cantelop-Sandbox-ID", messages.sandboxId);
  response.setHeader("X-Cantelop-Message-Protocol", "2");
  if (request.headers["x-cantelop-sandbox-id"] !== messages.sandboxId) {
    throw new RuntimeProtocolError(409, "sandbox_mismatch");
  }
  if (url.pathname === "/__cantelop/v2/runtime" && request.method === "GET") {
    writeJSON(response, 200, {
      sandbox_id: messages.sandboxId, protocol: 2, message_work: messages.work(), generation: quiescence.generation,
      quiescent: quiescence.quiescent, activity: activity.snapshot(), capabilities: { recovery: recoverySupported, replies: true, redelivery: redeliverySupported, steering: true, messageCancellation: true, durableView: true },
      observations: observationBuffer.metadata(), events: outputBuffer.metadata()
    });
    return;
  }
  const terminal = AUTH_TERMINAL_ROUTE.exec(url.pathname);
  if (terminal) {
    if (!terminals || url.search) throw new ProtocolError(404, "not_found");
    await terminals.serve(request, response, terminal[1]!, terminal[2] as "attach" | "input" | "resize");
    return;
  }
  if (url.pathname === RECOVERY_PATH && request.method === "POST") {
    if (!isJSONContentType(request.headers["content-type"])) throw new ProtocolError(415, "unsupported_media_type");
    const body = await readRequestEnvelope(request);
    if (!isRecord(body) || Object.keys(body).length !== 3 ||
      typeof body.recovery_id !== "string" || !RECOVERY_ID_PATTERN.test(body.recovery_id) ||
      typeof body.message_id !== "string" || !MESSAGE_ID_PATTERN.test(body.message_id)) {
      throw new ProtocolError(400, "invalid_recovery_request");
    }
    const session = readSession(body.session);
    bindSession(session);
    writeJSON(response, 200, await recover(body.recovery_id, body.message_id, session).result);
    return;
  }
  if (url.pathname === "/__cantelop/v2/runtime/activity/cancel" && request.method === "POST") {
    const body = await readRequestEnvelope(request);
    if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.activity_id !== "string") throw new ProtocolError(400, "invalid_activity_cancel");
    const currentActivity = activity.snapshot();
    if (!isRecord(currentActivity) || currentActivity.id !== body.activity_id) throw new RuntimeProtocolError(409, "activity_mismatch");
    activity.cancel(undefined, body.activity_id); writeJSON(response, 200, { active: activity.active }); return;
  }
  for (const [path, buffer] of [[OUTPUT_PATH, outputBuffer], [OBSERVATIONS_PATH, observationBuffer]] as const) {
    if (url.pathname === path + "/ack" && request.method === "POST") {
      const body = await readRequestEnvelope(request);
      if (!isRecord(body) || Object.keys(body).length !== 1 || !Number.isSafeInteger(body.through)) throw new ProtocolError(400, "invalid_acknowledgment");
      buffer.acknowledge(body.through as number);
      writeJSON(response, 200, buffer.metadata()); return;
    }
  }
  if (url.pathname === OUTPUT_PATH) { await handleOutputRequest(request, response, url, outputBuffer); return; }
  if (url.pathname === OBSERVATIONS_PATH) { await handleObservationRequest(request, response, url, observationBuffer); return; }
  if (url.pathname === QUIESCENCE_PATH) { await handleQuiescenceRequest(request, response, url, quiescence, boundSession()); return; }
  const status = /^\/__cantelop\/v2\/messages\/(msg_[0-9a-f]{32})(\/(cancel|reply))?$/.exec(url.pathname);
  if (status && request.method === "GET" && status[3] === "reply") {
    writeJSON(response, 200, { reply: messages.reply(status[1]!) }); return;
  }
  if (status && ((request.method === "GET" && !status[2]) || (request.method === "POST" && status[3] === "cancel"))) {
    writeJSON(response, 200, status[2] ? messages.cancel(status[1]!, "message_cancelled") : messages.get(status[1]!)); return;
  }
  if (url.pathname !== MESSAGE_PATH || url.search !== "") { writeError(response, 404, "not_found"); return; }
  if (request.method !== "POST") { writeError(response, 405, "method_not_allowed"); return; }
  if (!isJSONContentType(request.headers["content-type"])) { writeError(response, 415, "unsupported_media_type"); return; }
  const envelope = await readRequestEnvelope(request);
  if (!isRecord(envelope) || !hasMessageEnvelopeShape(envelope)) throw new ProtocolError(400, "invalid_message_request");
  const message = readMessage<Input>(envelope.message);
  const session = readSession(envelope.session);
  const trace = readObservabilityContext(envelope.observability);
  bindSession(session);
  const replyRequested = envelope.reply === true;
  let command: RuntimeCommand<Input>;
  try {
    command = decodeRuntimeCommand<Input>(message.payload);
  } catch {
    throw new ProtocolError(400, "invalid_sdk_command");
  }
  const input = command.type === "cancel" || command.type === "auth" ? message : { ...message, payload: command.message };
  const result = messages.admit(message.id, { message, session, reply: replyRequested }, (signal, started) => receiveMessage(input, session, trace, signal, started, replyRequested, command), typeof envelope.deadline === "string" ? envelope.deadline : undefined, trace?.attemptId);
  writeJSON(response, 202, result.receipt);
}

export async function handleObservationRequest(
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
    const observations = await buffer.read(after, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]), waitValues.length === 0, false);
    if (response.destroyed) return;
    writeJSON(response, 200, {
      observations: observations.map((observation) => ({
        cursor: observation.cursor,
        message_id: observation.messageId,
        observation: observation.observation,
      })),
    });
  } catch (error) {
    if (!controller.signal.aborted && !response.destroyed) {
      writeError(response, error instanceof RangeError ? 409 : 408, error instanceof RangeError ? error.message : "poll_timeout");
    }
  } finally {
    request.removeListener("aborted", abort);
  }
}

export async function handleOutputRequest(
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
    const events = await outputBuffer.read(after, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]), waitValues.length === 0, false);
    if (response.destroyed) return;
    writeJSON(response, 200, {
      events: events.map((event) => ({
        cursor: event.cursor,
        message_id: event.messageId,
        event: event.event,
        ...(event.view === undefined ? {} : {view: event.view}),
      })),
    });
  } catch (error) {
    if (!controller.signal.aborted && !response.destroyed) {
      writeError(response, error instanceof RangeError ? 409 : 408, error instanceof RangeError ? error.message : "poll_timeout");
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
      AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]),
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

export async function readRequestEnvelope(request: IncomingMessage): Promise<unknown> {
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

function readMessage<Input>(value: unknown): Readonly<{ id: string; payload: Input; }> {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
    typeof value.id !== "string" || !MESSAGE_ID_PATTERN.test(value.id) ||
    !("payload" in value)) {
    throw new ProtocolError(400, "invalid_message_request");
  }
  return Object.freeze({ id: value.id, payload: value.payload as Input });
}

export function readSession(value: unknown): SessionIdentity {
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

export function writeError(response: ServerResponse, status: number, code: string): void {
  writeJSON(response, status, { error: { code } });
}

export function writeJSON(response: ServerResponse, status: number, value: unknown): void {
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
