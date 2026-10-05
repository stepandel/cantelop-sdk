import type { SessionIdentity } from "./resources.js";

export type Awaitable<T> = T | Promise<T>;

export type SessionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface SessionOutput<Event> {
  send(event: Event): Promise<void>;
}

export interface SessionActivityContext<Message, Event> {
  readonly signal: AbortSignal;
  readonly output: SessionOutput<Event>;
  send(message: Message): void;
}

export type SessionActivityFunction<Message, Event> = (
  context: SessionActivityContext<Message, Event>,
) => Awaitable<void>;

export interface SessionActivity<Message, Event> {
  readonly active: boolean;
  start(work: SessionActivityFunction<Message, Event>, policy?: { timeoutMs?: number }): void;
 extend(timeoutMs: number): void;
  cancel(reason?: unknown): boolean;
}

export interface SessionContext<Message, Event = never, Reply = never> {
  readonly signal: AbortSignal;
  readonly message: Readonly<{
    id: string;
    sequence: number;
    payload: Message;
  }>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message, Event>;
  readonly output: SessionOutput<Event>;
  /** Supplies the single result returned by Session.request(). */
  reply(value: Reply): void;
  send(message: Message): void;
}

export interface SessionRecoveryContext<Message, Event = never> {
  readonly signal: AbortSignal;
  readonly recovery: Readonly<{
    id: string;
    interruptedMessageId: string;
  }>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message, Event>;
  readonly output: SessionOutput<Event>;
  send(message: Message): void;
}

export interface SessionBehaviour<Message, Event = never, Reply = never> {
  receive(context: SessionContext<Message, Event, Reply>): Awaitable<void>;
  onRecover?(context: SessionRecoveryContext<Message, Event>): Awaitable<void>;
}

export function defineSessionBehaviour<Message, Event = never, Reply = never>(
  behaviour: SessionBehaviour<Message, Event, Reply> | SessionBehaviour<Message, Event, Reply>["receive"],
): SessionBehaviour<Message, Event, Reply> {
  return Object.freeze(
    typeof behaviour === "function" ? { receive: behaviour } : { ...behaviour },
  );
}

export type { SessionIdentity } from "./resources.js";
