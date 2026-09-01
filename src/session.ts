import type { SessionIdentity } from "./resources.js";
import type { LogOptions, MessageObserver, SpanOptions } from "./observability.js";

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
  readonly message: ObservableMessage<Message>;
  readonly session: SessionIdentity;
  readonly env: SessionEnvironment;
  readonly activity: SessionActivity<Message, Event>;
  readonly output: SessionOutput<Event>;
  send(message: Message): void;
}

/**
 * One platform-delivered Message with trace context attached automatically.
 * Lifecycle tracing requires no user code; span and log calls add application
 * detail to the same attempt trace.
 */
export class ObservableMessage<Message> {
  readonly id: string;
  readonly sequence: number;
  readonly payload: Message;

  constructor(id: string, sequence: number, payload: Message, private readonly observer: MessageObserver) {
    this.id = id;
    this.sequence = sequence;
    this.payload = payload;
    Object.freeze(this);
  }

  get observable(): boolean {
    return this.observer.enabled;
  }

  span<Result>(name: string, work: () => Awaitable<Result>, options?: SpanOptions): Promise<Result> {
    return options === undefined
      ? this.observer.span(name, work)
      : this.observer.span(name, work, options);
  }

  log(body: string, options?: LogOptions): Promise<void> {
    return options === undefined
      ? this.observer.log(body)
      : this.observer.log(body, options);
  }
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
export type { LogOptions, LogSeverity, ObservationAttributes, SpanOptions } from "./observability.js";
