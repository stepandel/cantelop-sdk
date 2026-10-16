import type { WorkspaceDatabase } from "./database.js";
import type { SessionIdentity } from "./resources.js";

export type Awaitable<T> = T | Promise<T>;

export type SessionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface SessionOutput<Event> {
  send(event: Event): Promise<void>;
}

export interface SessionActivityContext<Message, Event, View = unknown> {
  readonly view: SessionViewWriter<View>;
  readonly signal: AbortSignal;
  readonly output: SessionOutput<Event>;
  send(message: Message): void;
}

export type SessionActivityFunction<Message, Event, View = unknown> = (
  context: SessionActivityContext<Message, Event, View>,
) => Awaitable<void>;

export interface SessionActivityOptions<Message> {
  readonly timeoutMs?: number;
  /** Adapter for delivering input to this activity's live harness. */
  readonly onSteer?: (message: Message) => Awaitable<void>;
  /** Provider interruption; the slot remains owned until this and work settle. */
  readonly onCancel?: () => Awaitable<void>;
}

export interface SessionActivityQueueOptions<Message> extends SessionActivityOptions<Message> {
  /** Overtake waiting ordinary work, preserving FIFO within each priority. */
  readonly priority?: boolean;
}

export interface SessionActivity<Message, Event, View = unknown> {
  readonly active: boolean;
  /** Starts immediately; rejects while another activity or queued work owns the slot. */
  start(work: SessionActivityFunction<Message, Event, View>, options?: SessionActivityOptions<Message>): void;
  /** Schedules owned work without blocking message intake. */
  queue(work: SessionActivityFunction<Message, Event, View>, options?: SessionActivityQueueOptions<Message>): void;
  /** Delivers input through the active activity's onSteer adapter. */
  steer(message: Message): Promise<void>;
  extend(timeoutMs: number): void;
  /** Cooperatively cancels the current activity; does not clear other queued submissions. */
  cancel(reason?: unknown): boolean;
}

export interface SessionViewWriter<View = unknown> {
  /** Resolves after the platform durably commits state and its event boundary. */
  commit(state: View): Promise<void>;
}

export interface SessionContext<Message, Event = never, Reply = never, View = unknown> {
  readonly command: Readonly<{type:"dispatch"|"steer"}>;
  readonly view: SessionViewWriter<View>;
  readonly signal: AbortSignal;
  readonly message: Readonly<{
    id: string;
    sequence: number;
    payload: Message;
  }>;
  database(): Promise<WorkspaceDatabase>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message, Event, View>;
  readonly output: SessionOutput<Event>;
  /** Supplies the single result returned by Session.request(). */
  reply(value: Reply): void;
  send(message: Message): Promise<void>;
}

export interface SessionRecoveryContext<Message, Event = never, View = unknown> {
  readonly view: SessionViewWriter<View>;
  readonly signal: AbortSignal;
  readonly recovery: Readonly<{
    id: string;
    interruptedMessageId: string;
  }>;
  database(): Promise<WorkspaceDatabase>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message, Event, View>;
  readonly output: SessionOutput<Event>;
  send(message: Message): Promise<void>;
}

/** Runs once per runtime incarnation, before intake or recovery. */
export type SessionActivationContext<Message, Event = never, View = unknown> = Omit<
  SessionContext<Message, Event, never, View>, "message" | "reply" | "command"
>;

export interface SessionBehaviour<Message, Event = never, Reply = never, View = unknown> {
  /** Opt in only when intake is idempotent across process loss using message.id. */
  readonly redelivery?: boolean;
  onActivate?(context: SessionActivationContext<Message, Event, View>): Awaitable<void>;
  /** Successful return acknowledges intake. Commit durable work before returning. */
  receive(context: SessionContext<Message, Event, Reply, View>): Awaitable<void>;
  onRecover?(context: SessionRecoveryContext<Message, Event, View>): Awaitable<void>;
}

export type { SessionIdentity } from "./resources.js";

export { createSessionDatabase } from "./session-database.js";
export type { AppAuth, AuthContext, AuthTerminalProcess } from "./native-auth.js";
export type { WorkspaceDatabase, DatabaseCredentials } from "./database.js";

/** Session resources available for constructing one harness per incarnation. */
export interface SessionHarnessContext {
  readonly signal: AbortSignal;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  database(): Promise<WorkspaceDatabase>;
}

/** Capabilities belong to one submission and close when its method settles. */
export interface SessionHarnessWorkContext<Message, Event = never, View = unknown>
  extends SessionHarnessContext, SessionActivityContext<Message, Event, View> {
  readonly message: Readonly<{ id: string; sequence: number; payload: Message }>;
}

/** One provider implementation owns input ordering, steering and active-operation cancellation. */
export interface SessionHarness<Message, Event = never, Reply = never, View = unknown> {
  /** Accepts ordinary input; resolves after that submission's execution and cleanup. */
  queue(message: Message, context: SessionHarnessWorkContext<Message, Event, View>): Awaitable<[Reply] extends [never] ? void : Reply>;
  /** Handles redirection using the harness's own semantics and completion boundary. */
  steer(message: Message, context: SessionHarnessWorkContext<Message, Event, View>): Awaitable<void>;
  /** Signals the active operation and preserves waiting input; false means idle. */
  cancel(): Awaitable<boolean>;
}

export interface SessionHarnessRuntime<Message, Event = never, Reply = never, View = unknown> {
  create(context: SessionHarnessContext): Awaitable<SessionHarness<Message, Event, Reply, View>>;
  readonly redelivery?: boolean;
  onRecover?(context: SessionRecoveryContext<Message, Event, View>): Awaitable<void>;
}
