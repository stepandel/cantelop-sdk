import type { Session } from "./resources.js";

export type Awaitable<T> = T | Promise<T>;

export type HarnessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface HarnessContext<Input, Event = never> {
  readonly message: Readonly<{
    id: string;
  }>;
  readonly session: Session;
  readonly input: Input;
  readonly env: HarnessEnvironment;
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
