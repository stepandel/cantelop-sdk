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
  start(work: SessionActivityFunction<Message, Event>): void;
  cancel(reason?: unknown): boolean;
}

export interface SessionContext<Message, Event = never> {
  readonly message: SessionMessage<Message>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message, Event>;
  readonly output: SessionOutput<Event>;
  send(message: Message): void;
}

/** One immutable Message delivered by the platform-owned Session mailbox. */
export interface SessionMessage<Message> {
  readonly id: string;
  readonly sequence: number;
  readonly payload: Message;
}

export interface SessionBehaviour<Message, Event = never> {
  receive(context: SessionContext<Message, Event>): Awaitable<void>;
}

export function defineSessionBehaviour<Message, Event = never>(
  receive: SessionBehaviour<Message, Event>["receive"],
): SessionBehaviour<Message, Event> {
  return Object.freeze({ receive });
}

export type { SessionIdentity } from "./resources.js";
