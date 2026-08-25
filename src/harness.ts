import type { Session } from "./resources.js";

export type Awaitable<T> = T | Promise<T>;

export type HarnessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface HarnessTaskContext<Message> {
  readonly signal: AbortSignal;
  send(payload: Message): void;
}

export type HarnessTaskFunction<Message> = (
  context: HarnessTaskContext<Message>,
) => Awaitable<void>;

export interface HarnessTasks<Message> {
  start(id: string, work: HarnessTaskFunction<Message>): void;
  cancel(id: string, reason?: unknown): boolean;
  has(id: string): boolean;
}

export interface HarnessContext<Input, Event = never> {
  readonly message: Readonly<{
    id: string;
    sequence: number;
    payload: Input;
  }>;
  readonly session: Session;
  readonly env: HarnessEnvironment;
  readonly tasks: HarnessTasks<Input>;
  send(payload: Input): void;
  emit(event: Event): void;
}

export type HarnessRuntime<Input, Event = never> =
  | ((context: HarnessContext<Input, Event>) => Awaitable<void>)
  | {
      receive(context: HarnessContext<Input, Event>): Awaitable<void>;
    };

export function defineHarness<Input, Event = never>(
  runtime: HarnessRuntime<Input, Event>,
): HarnessRuntime<Input, Event> {
  return runtime;
}

export type { Session } from "./resources.js";
export {
  createHarnessRequestHandler,
  serveHarness,
} from "./harness-server.js";
export type {
  HarnessRequestHandlerOptions,
  HarnessServer,
} from "./harness-server.js";
