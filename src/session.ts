import type { SessionIdentity } from "./resources.js";

export type Awaitable<T> = T | Promise<T>;

export type SessionEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface SessionActivityContext<Message> {
  readonly signal: AbortSignal;
  send(message: Message): void;
}

export type SessionActivityFunction<Message> = (
  context: SessionActivityContext<Message>,
) => Awaitable<void>;

export interface SessionActivity<Message> {
  readonly active: boolean;
  start(work: SessionActivityFunction<Message>): void;
  cancel(reason?: unknown): boolean;
}

export interface SessionContext<Message, Event = never> {
  readonly message: Readonly<{
    id: string;
    sequence: number;
    payload: Message;
  }>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message>;
  send(message: Message): void;
  emit(event: Event): void;
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
