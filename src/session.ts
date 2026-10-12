import type { WorkspaceDatabase } from "./database.js";
import type { SessionIdentity } from "./resources.js";

export type Awaitable<T> = T | Promise<T>;

export type SessionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface SessionOutput<Event> {
  send(event: Event): Promise<void>;
}

export interface SessionActivityContext<Message, Event> {
  readonly view: SessionViewWriter;
  readonly signal: AbortSignal;
  readonly output: SessionOutput<Event>;
  send(message: Message): void;
}

export type SessionActivityFunction<Message, Event> = (
  context: SessionActivityContext<Message, Event>,
) => Awaitable<void>;

export interface SessionActivityOptions<Message> {
  readonly timeoutMs?: number;
  /** Adapter for delivering input to this activity's live harness. */
  readonly onSteer?: (message: Message) => Awaitable<void>;
}

export interface SessionActivityQueueOptions<Message> extends SessionActivityOptions<Message> {
  /** Overtake waiting ordinary work, preserving FIFO within each priority. */
  readonly priority?: boolean;
}

export interface SessionActivity<Message, Event> {
  readonly active: boolean;
  /** Starts immediately; rejects while another activity or queued work owns the slot. */
  start(work: SessionActivityFunction<Message, Event>, options?: SessionActivityOptions<Message>): void;
  /** Schedules owned work without blocking message intake. */
  queue(work: SessionActivityFunction<Message, Event>, options?: SessionActivityQueueOptions<Message>): void;
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
  readonly activity: SessionActivity<Message, Event>;
  readonly output: SessionOutput<Event>;
  /** Supplies the single result returned by Session.request(). */
  reply(value: Reply): void;
  send(message: Message): Promise<void>;
}

export interface SessionRecoveryContext<Message, Event = never> {
  readonly view: SessionViewWriter;
  readonly signal: AbortSignal;
  readonly recovery: Readonly<{
    id: string;
    interruptedMessageId: string;
  }>;
  database(): Promise<WorkspaceDatabase>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message, Event>;
  readonly output: SessionOutput<Event>;
  send(message: Message): Promise<void>;
}

/** Runs once per runtime incarnation, before intake or recovery. */
export type SessionActivationContext<Message, Event = never> = Omit<
  SessionContext<Message, Event, never>, "message" | "reply" | "command"
>;

export interface SessionBehaviour<Message, Event = never, Reply = never, View = unknown> {
  /** Opt in only when intake is idempotent across process loss using message.id. */
  readonly redelivery?: boolean;
  onActivate?(context: SessionActivationContext<Message, Event>): Awaitable<void>;
  /** Successful return acknowledges intake. Commit durable work before returning. */
  receive(context: SessionContext<Message, Event, Reply, View>): Awaitable<void>;
  onRecover?(context: SessionRecoveryContext<Message, Event>): Awaitable<void>;
}

export type { SessionIdentity } from "./resources.js";

export { createSessionDatabase } from "./session-database.js";
export type { WorkspaceDatabase, DatabaseCredentials } from "./database.js";
