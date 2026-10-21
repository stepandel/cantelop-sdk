/// <reference types="node" />
import { randomUUID } from "node:crypto";

import { FollowupMessages, InMemoryActivity, type ActivityLifecycle } from "./activity.js";
import { AuthTerminals } from "./auth-terminal.js";
import { borrowWorkspaceDatabase, type WorkspaceDatabase } from "./database.js";
import { InMemoryMailbox } from "./mailbox.js";
import { isAuthSessionID, isReservedAuthSessionID, isAppAuth, type AppAuth, type AuthCommand } from "./native-auth.js";
import { RuntimeObserver, RuntimeObservationBuffer, type RuntimeTraceContext } from "./observability.js";
import { SessionOutputBuffer } from "./output.js";
import type { SessionIdentity } from "./resources.js";
import type { RuntimeCommand } from "./runtime-command.js";
import { runWithRuntimeLogContext } from "./runtime-log-capture.js";
import { RuntimeMessages, RuntimeProtocolError, type MessageReceipt } from "./runtime-messages.js";
import { RuntimeQuiescence } from "./runtime-quiescence.js";
import { createSessionDatabase } from "./session-database.js";
import { assertSessionRuntime, type SessionRuntime } from "./session-runtime-contract.js";
import {
  DEFAULT_EXECUTION_TIMEOUT_MS, OUTPUT_HANDOFF_MS, encodeReply,
  type MessageEnvelope, type RuntimeMessage,
} from "./session-runtime-protocol.js";
import { markMessageLifecycle } from "./session-runtime-startup.js";
import type {
  SessionActivationContext, SessionActivity, SessionActivityFunction, SessionActivityOptions,
  SessionActivityQueueOptions, SessionEnvironment, SessionHarness, SessionHarnessWorkContext,
  SessionOutput, SessionRecoveryContext, SessionViewWriter,
} from "./session.js";
import { messageID } from "./shared.js";

const MAX_RUNTIME_MESSAGES = 4096;
const MAX_HARNESS_OPERATIONS = 256;
const INVALID_REPLY = "Session request reply must be JSON and at most 65536 bytes";

export interface SessionRuntimeHandlerOptions {
  env?: SessionEnvironment;
  sandboxId?: string;
  executionTimeoutMs?: number;
  /** The App's declared auth provider; only the reserved auth Session uses it. */
  auth?: AppAuth;
}

export interface RuntimeDelivery {
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

export interface RuntimeRecovery {
  readonly fingerprint: string;
  readonly generation: number;
  readonly result: Promise<Readonly<{ recovery_id: string; generation: number; state: "completed" | "failed" }>>;
}

/** Background activity plus harness operations, as reported and cancelled by the platform. */
export interface SupervisedWork {
  readonly active: boolean;
  snapshot(): unknown;
  cancel(reason?: unknown, activityId?: string): boolean;
}

/** Errors thrown by capabilities used after their invocation settled. */
interface ScopeMessages {
  readonly invocation: string;
  readonly view: string;
}
const MESSAGE_SCOPE: ScopeMessages = { invocation: "Session runtime message invocation has already settled", view: "Session invocation settled" };
const RECOVERY_SCOPE: ScopeMessages = { invocation: "Session recovery invocation has already settled", view: "Session recovery settled" };

/**
 * One Session runtime incarnation: Message intake, activation, harness
 * operations and recovery. The HTTP surface lives in session-runtime-routes.ts.
 */
export class SessionRuntimeAdapter<Input, Event = never, Reply = never, View = unknown> {
  readonly messages: RuntimeMessages;
  readonly output = new SessionOutputBuffer();
  readonly observations = new RuntimeObservationBuffer();
  readonly quiescence: RuntimeQuiescence;
  readonly work: SupervisedWork;
  readonly capabilities: { readonly recovery: boolean; readonly redelivery: boolean };
  /** Aborted when the server starts closing, so long polls answer instead of holding it open. */
  private readonly closing = new AbortController();
  /** Activation belongs to the runtime incarnation, not to the Message that triggered it. */
  private readonly lifetime = new AbortController();
  private readonly env: SessionEnvironment;
  private readonly mailbox: InMemoryMailbox<void>;
  private readonly activity: InMemoryActivity<Input, Event, View>;
  private readonly terminals: AuthTerminals | undefined;
  private readonly harnessOperations = new Map<string, HarnessOperation>();
  private readonly recoveries = new Map<string, RuntimeRecovery>();
  private readonly sessionDatabase: WorkspaceDatabase;
  private boundSession: SessionIdentity | undefined;
  private activation: Promise<void> | undefined;
  private harness: SessionHarness<Input, Event, Reply, View> | undefined;
  private pendingControls = 0;
  private nextIntakeSequence = 1;

  constructor(
    private readonly behaviour: SessionRuntime<Input, Event, Reply, View>,
    private readonly options: SessionRuntimeHandlerOptions = {},
  ) {
    assertSessionRuntime(behaviour);
    if (options.auth !== undefined && !isAppAuth(options.auth)) throw new TypeError("Invalid App auth");
    this.env = options.env ?? process.env;
    const sandboxId = options.sandboxId ?? process.env.CANTELOP_SANDBOX_ID ?? "";
    this.messages = new RuntimeMessages(sandboxId, options.executionTimeoutMs, MAX_RUNTIME_MESSAGES, (id, reason) => {
      this.mailbox.cancel(id, reason);
      this.activity.cancelMessage(id);
      this.harnessOperations.get(id)?.controller.abort(reason);
    });
    this.sessionDatabase = createSessionDatabase(this.env);
    this.terminals = options.auth === undefined ? undefined
      : new AuthTerminals(options.auth, this.env, this.lifetime.signal, () => this.quiescence.changed());
    this.mailbox = new InMemoryMailbox<void>(markMessageLifecycle, () => this.quiescence.changed());
    this.activity = new InMemoryActivity(
      payload => this.sendMessage(payload),
      (messageId, event, signal) => this.publishOutput(messageId, event, signal),
      () => this.quiescence.changed(),
      (messageId, state, signal) => this.commitView(messageId, state, signal),
    );
    this.quiescence = new RuntimeQuiescence(() => this.mailbox.isIdle && this.activity.isIdle &&
      this.harnessOperations.size === 0 && this.pendingControls === 0 && !this.terminals?.active);
    this.work = this.supervisedWork();
    this.capabilities = Object.freeze({ recovery: behaviour.onRecover !== undefined, redelivery: behaviour.redelivery === true });
  }

  get closingSignal(): AbortSignal { return this.closing.signal; }

  /** Auth terminals are reachable only once the reserved auth Session is bound. */
  get authTerminals(): AuthTerminals | undefined {
    const session = this.boundSession;
    return session && isAuthSessionID(session.id, session.workspaceId) ? this.terminals : undefined;
  }

  get session(): SessionIdentity | undefined { return this.boundSession; }

  bindSession(session: SessionIdentity): void {
    if (this.boundSession !== undefined &&
        (this.boundSession.id !== session.id || this.boundSession.workspaceId !== session.workspaceId)) {
      throw new RuntimeProtocolError(409, "session_mismatch");
    }
    this.boundSession ??= session;
  }

  /** Admits a platform Message envelope; retries of the same Message ID return the original receipt. */
  admit(envelope: MessageEnvelope<Input>, command: RuntimeCommand<Input>): MessageReceipt {
    const { message, session, trace, reply, deadline } = envelope;
    const input = command.type === "cancel" || command.type === "auth" ? message : { ...message, payload: command.message };
    return this.messages.admit(
      message.id, { message, session, reply },
      (signal, started) => this.receive(input, session, trace, signal, started, reply, command),
      deadline, trace?.attemptId,
    ).receipt;
  }

  /** Lets long polls answer so the HTTP server can finish closing. */
  beginClose(): void { this.closing.abort(new DOMException("Session runtime closing", "AbortError")); }

  dispose(): void {
    this.beginClose();
    this.lifetime.abort();
    this.sessionDatabase.close();
  }

  /** Each caller gets a non-owning view, so closing it never closes the client for everyone else. */
  private readonly database = async (): Promise<WorkspaceDatabase> => {
    await this.sessionDatabase.credentials();
    return borrowWorkspaceDatabase(this.sessionDatabase);
  };

  private publishOutput(messageId: string, event: Event, signal: AbortSignal): Promise<void> {
    return this.output.publish(messageId, event, AbortSignal.any([signal, AbortSignal.timeout(OUTPUT_HANDOFF_MS)]));
  }

  private commitView(messageId: string, state: View, signal: AbortSignal): Promise<void> {
    return this.output.publish(messageId, state, AbortSignal.any([signal, AbortSignal.timeout(OUTPUT_HANDOFF_MS)]), true);
  }

  private viewCapability(messageId: string, signal: AbortSignal, assertOpen: () => void): SessionViewWriter<View> {
    return Object.freeze({
      commit: (state: View) => { assertOpen(); return this.commitView(messageId, state, signal); },
    });
  }

  private activityCapability(
    messageId: string,
    assertOpen: () => void,
    observe: (event: ActivityLifecycle) => void = () => undefined,
    priority = false,
  ): SessionActivity<Input, Event, View> {
    const activity = this.activity;
    return Object.freeze({
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
  }

  /** Capabilities for one receive or recovery invocation; they all close together when it settles. */
  private invocationScope(
    messageId: string,
    signal: AbortSignal,
    errors: ScopeMessages,
    observe?: (event: ActivityLifecycle) => void,
    priority = false,
  ) {
    let open = true;
    const assertOpen = () => { if (!open) throw new Error(errors.invocation); };
    const output: SessionOutput<Event> = Object.freeze({
      send: async (event: Event): Promise<void> => {
        assertOpen();
        await this.publishOutput(messageId, event, signal);
      },
    });
    return {
      assertOpen,
      close: () => { open = false; },
      output,
      send: (payload: Input): Promise<void> => {
        assertOpen();
        this.sendMessage(payload);
        return Promise.resolve();
      },
      activity: this.activityCapability(messageId, () => { assertOpen(); signal.throwIfAborted(); }, observe, priority),
      view: this.viewCapability(messageId, signal, () => { if (!open) throw new Error(errors.view); }),
    };
  }

  private activate(session: SessionIdentity, messageId: string): Promise<void> {
    this.activation ??= Promise.resolve().then(async () => {
      const lifetime = this.lifetime.signal;
      if ("create" in this.behaviour) {
        const harness = await this.behaviour.create(Object.freeze({ signal: lifetime, session, env: this.env, database: this.database }));
        if (!harness || ["queue", "steer", "cancel"].some(method => typeof harness[method as keyof typeof harness] !== "function")) {
          throw new TypeError("Invalid Session harness");
        }
        this.harness = harness;
        return;
      }
      await this.behaviour.onActivate?.(Object.freeze({
        signal: lifetime, session, env: this.env, database: this.database,
        activity: this.activityCapability(messageId, () => lifetime.throwIfAborted()),
        // Restored work reports under the activating message.
        view: this.viewCapability(messageId, lifetime, () => lifetime.throwIfAborted()),
        output: Object.freeze({ send: (event: Event) => this.publishOutput(messageId, event, lifetime) }),
        send: (payload: Input) => { this.sendMessage(payload); return Promise.resolve(); },
      } satisfies SessionActivationContext<Input, Event, View>));
    });
    return this.activation;
  }

  private receive(
    message: RuntimeMessage<Input>,
    session: SessionIdentity,
    trace: RuntimeTraceContext | undefined,
    signal: AbortSignal,
    started: () => void,
    replyRequested = false,
    command: RuntimeCommand<Input> = { type: "dispatch", message: message.payload },
  ): RuntimeDelivery {
    const generation = this.quiescence.observeMessage(message.id);
    const sequence = this.nextIntakeSequence++;
    const reply: { value: unknown } | undefined = replyRequested ? { value: undefined } : undefined;
    const delivery = (settled: Promise<void>): RuntimeDelivery => Object.freeze({ generation, settled, ...(reply ? { reply } : {}) });
    if (isReservedAuthSessionID(session.id) && command.type !== "auth") {
      started();
      return delivery(Promise.reject(new TypeError("Reserved auth Session requires an auth command")));
    }
    if (command.type === "cancel") return delivery(this.receiveCancel(message.id, session, signal, started, reply));
    if (command.type === "auth") return delivery(this.receiveAuth(message.id, command.auth, session, signal, started, reply));
    return delivery(this.receiveInvocation(message, sequence, session, trace, signal, started, command, reply));
  }

  private receiveCancel(
    messageId: string, session: SessionIdentity, signal: AbortSignal, started: () => void, reply: { value: unknown } | undefined,
  ): Promise<void> {
    const harnessMode = "create" in this.behaviour;
    const control = async () => {
      signal.throwIfAborted();
      if (harnessMode) await this.activate(session, messageId);
      signal.throwIfAborted();
      const requested = harnessMode ? await this.harness!.cancel() : this.activity.cancel();
      if (typeof requested !== "boolean") throw new TypeError("Session harness cancel must return a boolean");
      if (reply) reply.value = { id: messageId, state: requested ? "requested" : "idle" };
    };
    // Harness intake only hands submissions over, so FIFO order lets cancel
    // observe every submission admitted before it without blocking on work.
    if (harnessMode) return this.mailbox.enqueue(messageId, async () => { started(); await control(); });
    started();
    this.pendingControls++;
    return control().finally(() => { this.pendingControls--; this.quiescence.changed(); });
  }

  private receiveAuth(
    messageId: string, auth: AuthCommand, session: SessionIdentity, signal: AbortSignal, started: () => void, reply: { value: unknown } | undefined,
  ): Promise<void> {
    // Auth never activates the Session runtime: no harness or agent state exists in the auth Sandbox.
    return this.mailbox.enqueue(messageId, async () => {
      signal.throwIfAborted();
      started();
      if (!isAuthSessionID(session.id, session.workspaceId) || !reply) throw new TypeError("Invalid auth request");
      if (!this.terminals) throw new TypeError("App does not declare auth");
      reply.value = encodeReply(await this.terminals.handle(auth, session), () => new TypeError("Invalid auth reply"));
    });
  }

  private receiveInvocation(
    message: RuntimeMessage<Input>,
    sequence: number,
    session: SessionIdentity,
    trace: RuntimeTraceContext | undefined,
    signal: AbortSignal,
    started: () => void,
    command: RuntimeCommand<Input> & { type: "dispatch" | "steer" },
    reply: { value: unknown } | undefined,
  ): Promise<void> {
    let workCompletion: Promise<void> | undefined;
    const settled = this.mailbox.enqueue(message.id, async () => {
      signal.throwIfAborted();
      started();
      const observer = new RuntimeObserver(message.id, trace, this.observations);
      const scope = this.invocationScope(message.id, signal, MESSAGE_SCOPE, event => observer.recordActivity(event), command.type === "steer");
      let replied = false;
      const replyTo = (value: Reply): void => {
        scope.assertOpen();
        if (replied) throw new Error("Session request already has a reply");
        const copy = encodeReply(value, () => new Error(INVALID_REPLY));
        if (reply) reply.value = copy;
        replied = true;
      };
      try {
        const context = Object.freeze({
          signal, command: Object.freeze({ type: command.type }), message: Object.freeze({ ...message, sequence }),
          session, env: this.env, activity: scope.activity, output: scope.output, reply: replyTo, send: scope.send,
          database: this.database, view: scope.view,
        });
        await runWithRuntimeLogContext(observer, async () => {
          await this.activate(session, message.id);
          signal.throwIfAborted();
          await observer.span("session.receive", async () => {
            if ("receive" in this.behaviour) return this.behaviour.receive(context);
            workCompletion = this.startHarnessOperation(message, sequence, session, signal, command, reply);
          }, { "cantelop.command": reply ? "request" : command.type });
        });
        if ("receive" in this.behaviour && reply && !replied) throw new Error("Session request completed without a reply");
      } finally {
        scope.close();
      }
    });
    return "create" in this.behaviour && reply ? settled.then(() => workCompletion) : settled;
  }

  /**
   * Hands one submission to the harness. The SDK only tracks completion,
   * attribution and deadlines; it never schedules provider work.
   */
  private startHarnessOperation(
    message: RuntimeMessage<Input>,
    sequence: number,
    session: SessionIdentity,
    signal: AbortSignal,
    command: RuntimeCommand<Input> & { type: "dispatch" | "steer" },
    reply: { value: unknown } | undefined,
  ): Promise<void> {
    if (this.harnessOperations.size >= MAX_HARNESS_OPERATIONS) throw new Error("harness operation capacity");
    // Dispatch receipts settle at handoff, so the operation carries the message deadline itself.
    const operation: HarnessOperation = {
      id: randomUUID(), controller: new AbortController(), deadline: Date.parse(this.messages.get(message.id).deadline),
    };
    this.harnessOperations.set(message.id, operation);
    const workSignal = AbortSignal.any([signal, this.lifetime.signal, operation.controller.signal]);
    const timer = setTimeout(
      () => operation.controller.abort(new DOMException("Harness operation timed out", "AbortError")),
      Math.max(0, operation.deadline - Date.now()),
    );
    timer.unref();
    const markCancellation = () => {
      operation.cancelledAt = new Date().toISOString();
      this.quiescence.changed();
    };
    operation.controller.signal.addEventListener("abort", markCancellation, { once: true });
    let workOpen = true;
    const followups = new FollowupMessages<Input>();
    const assertWorkOpen = () => {
      if (!workOpen) throw new Error("Session harness operation settled");
      workSignal.throwIfAborted();
    };
    const work: SessionHarnessWorkContext<Input, Event, View> = Object.freeze({
      signal: workSignal, session, env: this.env, database: this.database,
      message: Object.freeze({ ...message, sequence }),
      output: Object.freeze({ send: (event: Event) => { assertWorkOpen(); return this.publishOutput(message.id, event, workSignal); } }),
      view: this.viewCapability(message.id, workSignal, assertWorkOpen),
      send: (payload: Input) => { assertWorkOpen(); followups.push(payload); },
    });
    this.quiescence.changed();
    const closeWork = () => {
      workOpen = false;
      clearTimeout(timer);
      operation.controller.signal.removeEventListener("abort", markCancellation);
      void followups.flush(payload => this.sendMessage(payload), "Harness completion message rejected").finally(() => {
        this.harnessOperations.delete(message.id);
        this.quiescence.changed();
      });
    };
    let execution: unknown;
    try {
      workSignal.throwIfAborted();
      execution = command.type === "steer" ? this.harness!.steer(message.payload, work) : this.harness!.queue(message.payload, work);
    } catch (error) {
      closeWork();
      throw error;
    }
    const completion = Promise.resolve(execution).then(result => {
      workSignal.throwIfAborted();
      if (reply) reply.value = encodeReply(result, () => new Error(INVALID_REPLY));
    }).finally(closeWork);
    // Request failures surface through the receipt; dispatch receipts settled at handoff.
    void completion.catch(error => { if (!reply) console.error("Session harness operation failed", error); });
    return completion;
  }

  private sendMessage(payload: Input): void {
    const session = this.boundSession;
    if (session === undefined) throw new Error("Session runtime cannot send before its Session is bound");
    const message = Object.freeze({ id: messageID(), payload });
    this.messages.admit(message.id, { message, session }, (signal, started) => this.receive(message, session, undefined, signal, started));
  }

  recover(recoveryId: string, interruptedMessageId: string, session: SessionIdentity): RuntimeRecovery {
    const fingerprint = JSON.stringify({ interruptedMessageId, session });
    const existing = this.recoveries.get(recoveryId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new RuntimeProtocolError(409, "recovery_conflict");
      return existing;
    }
    const onRecover = this.behaviour.onRecover;
    if (onRecover === undefined) throw new RuntimeProtocolError(409, "recovery_unsupported");
    const generation = this.quiescence.observeMessage(interruptedMessageId);
    const signal = AbortSignal.timeout(this.options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS);
    const settled = this.mailbox.enqueue(recoveryId, async () => {
      signal.throwIfAborted();
      const scope = this.invocationScope(interruptedMessageId, signal, RECOVERY_SCOPE);
      const context: SessionRecoveryContext<Input, Event, View> = Object.freeze({
        signal, database: this.database, session, env: this.env,
        recovery: Object.freeze({ id: recoveryId, interruptedMessageId }),
        view: scope.view, activity: scope.activity, output: scope.output, send: scope.send,
      });
      try {
        await this.activate(session, interruptedMessageId);
        signal.throwIfAborted();
        await onRecover.call(this.behaviour, context);
      } finally {
        scope.close();
      }
    });
    const result = settled.then(
      () => Object.freeze({ recovery_id: recoveryId, generation, state: "completed" as const }),
      () => Object.freeze({ recovery_id: recoveryId, generation, state: "failed" as const }),
    );
    const recovery = Object.freeze({ fingerprint, generation, result });
    this.recoveries.set(recoveryId, recovery);
    return recovery;
  }

  private supervisedWork(): SupervisedWork {
    const activity = this.activity, operations = this.harnessOperations;
    return {
      get active() { return activity.active || operations.size > 0; },
      snapshot() {
        let pending: HarnessOperation | undefined;
        for (const operation of operations.values()) if (!pending || operation.deadline < pending.deadline) pending = operation;
        const background = activity.snapshot();
        if (!pending || background && Date.parse(background.deadline) <= pending.deadline) return background;
        return { id: pending.id, deadline: new Date(pending.deadline).toISOString(), cancellation_requested_at: pending.cancelledAt };
      },
      cancel(reason?: unknown, activityId?: string) {
        const pending = [...operations.values()].find(value => value.id === activityId);
        if (!pending) return activity.cancel(reason, activityId);
        pending.controller.abort(reason ?? new DOMException("Harness operation cancelled", "AbortError"));
        return true;
      },
    };
  }
}
