import type {
  Execution,
  ExecutionStatus,
  StartExecutionOptions,
} from "./execution.js";
import type { Session } from "./resources.js";

export type Awaitable<T> = T | Promise<T>;

export type HarnessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type HarnessExecutionKind = "execute" | "steer";

export interface HarnessContext<Input, Event = never> {
  readonly execution: Readonly<{
    id: string;
    kind: HarnessExecutionKind;
  }>;
  readonly session: Session;
  readonly input: Input;
  readonly env: HarnessEnvironment;
  readonly signal: AbortSignal;
  emit(event: Event): void;
}

export type HarnessRuntime<Input, Output, Event = never> =
  | ((context: HarnessContext<Input, Event>) => Awaitable<Output>)
  | {
      run(context: HarnessContext<Input, Event>): Awaitable<Output>;
      steer?(context: HarnessContext<Input, Event>): Awaitable<Output>;
    };

export interface HarnessExecutorOptions {
  env?: HarnessEnvironment;
}

export interface StartHarnessExecutionOptions extends StartExecutionOptions {
  readonly session: Session;
  readonly kind?: HarnessExecutionKind;
}

export interface HarnessExecution<Output, Event = never>
  extends Execution<Output> {
  events(): AsyncIterable<Event>;
}

export interface HarnessExecutor<Input, Output, Event = never> {
  start(
    input: Input,
    options: StartHarnessExecutionOptions,
  ): Promise<HarnessExecution<Output, Event>>;
}

export function defineHarness<Input, Output, Event = never>(
  runtime: HarnessRuntime<Input, Output, Event>,
): HarnessRuntime<Input, Output, Event> {
  return runtime;
}

function invoke<Input, Output, Event>(
  runtime: HarnessRuntime<Input, Output, Event>,
  context: HarnessContext<Input, Event>,
): Awaitable<Output> {
  if (typeof runtime === "function") return runtime(context);
  if (context.execution.kind === "steer") {
    if (runtime.steer === undefined) {
      throw new Error("Harness does not support steering");
    }
    return runtime.steer(context);
  }
  return runtime.run(context);
}

interface PendingNext<Event> {
  resolve(result: IteratorResult<Event>): void;
  reject(error: unknown): void;
}

class ExecutionEventStream<Event> implements AsyncIterableIterator<Event> {
  private readonly buffered: Event[] = [];
  private readonly pending: PendingNext<Event>[] = [];
  private done = false;
  private failed = false;
  private failure: unknown;
  private iterated = false;

  emit(event: Event): void {
    if (this.done || this.failed) return;

    const pending = this.pending.shift();
    if (pending) {
      pending.resolve({ done: false, value: event });
    } else {
      this.buffered.push(event);
    }
  }

  close(): void {
    if (this.done || this.failed) return;
    this.done = true;
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ done: true, value: undefined });
    }
  }

  error(failure: unknown): void {
    if (this.done || this.failed) return;
    this.failed = true;
    this.failure = failure;
    for (const pending of this.pending.splice(0)) {
      pending.reject(failure);
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Event> {
    if (this.iterated) {
      throw new Error("Execution events can only be consumed once");
    }
    this.iterated = true;
    return this;
  }

  next(): Promise<IteratorResult<Event>> {
    if (this.buffered.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.buffered.shift() as Event,
      });
    }
    if (this.failed) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ done: true, value: undefined });

    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Execution cancelled", "AbortError");
}

class ExecutionHandle<Output, Event>
  implements HarnessExecution<Output, Event> {
  status: ExecutionStatus = "pending";
  startedAt?: Date;
  finishedAt?: Date;

  constructor(
    readonly id: string,
    private readonly controller: AbortController,
    private readonly result: Promise<Output>,
    private readonly eventStream: ExecutionEventStream<Event>,
  ) {}

  cancel(reason?: unknown): Promise<void> {
    if (this.status === "pending" || this.status === "running") {
      this.controller.abort(reason);
    }
    return Promise.resolve();
  }

  events(): AsyncIterable<Event> {
    return this.eventStream;
  }

  wait(): Promise<Output> {
    return this.result;
  }
}

/**
 * Creates the in-process executor used inside a native harness VM.
 * Edge APIs execute through an injected Session instead.
 */
export function createHarnessExecutor<
  Input = unknown,
  Output = unknown,
  Event = never,
>(
  runtime: HarnessRuntime<Input, Output, Event>,
  options: HarnessExecutorOptions = {},
): HarnessExecutor<Input, Output, Event> {
  let boundSession: Session | undefined;
  return {
    async start(input, startOptions: StartHarnessExecutionOptions) {
      assertSessionIdentity(boundSession, startOptions.session);
      boundSession ??= Object.freeze({ ...startOptions.session });
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const eventStream = new ExecutionEventStream<Event>();
      const forwardAbort = () =>
        controller.abort(startOptions.signal?.reason);

      if (startOptions.signal) {
        if (startOptions.signal.aborted) {
          controller.abort(startOptions.signal.reason);
        } else {
          startOptions.signal.addEventListener("abort", forwardAbort, {
            once: true,
          });
        }
      }

      let handle: ExecutionHandle<Output, Event>;
      const result = Promise.resolve().then(async () => {
        if (controller.signal.aborted) {
          handle.status = "cancelled";
          handle.finishedAt = new Date();
          throw abortReason(controller.signal);
        }

        handle.status = "running";
        handle.startedAt = new Date();

        try {
          const output = await invoke(runtime, Object.freeze({
            execution: Object.freeze({
              id,
              kind: startOptions.kind ?? "execute",
            }),
            session: Object.freeze({ ...startOptions.session }),
            input,
            env: options.env ?? {},
            signal: controller.signal,
            emit: (event) => eventStream.emit(event),
          }));

          if (controller.signal.aborted) {
            throw abortReason(controller.signal);
          }

          handle.status = "succeeded";
          return output;
        } catch (error) {
          handle.status = controller.signal.aborted ? "cancelled" : "failed";
          eventStream.error(error);
          throw error;
        } finally {
          startOptions.signal?.removeEventListener("abort", forwardAbort);
          handle.finishedAt = new Date();
          eventStream.close();
        }
      });

      void result.catch(() => undefined);
      handle = new ExecutionHandle(id, controller, result, eventStream);
      return handle;
    },
  };
}

function assertSessionIdentity(current: Session | undefined, next: Session): void {
  if (current !== undefined &&
      (current.id !== next.id || current.workspaceId !== next.workspaceId)) {
    throw new Error("Harness executor is already bound to a different Session");
  }
}

export type {
  Execution,
  ExecutionStatus,
  StartExecutionOptions,
} from "./execution.js";
export type { Session } from "./resources.js";
export {
  createHarnessRequestHandler,
  serveHarness,
} from "./harness-server.js";
export type {
  HarnessRequestHandlerOptions,
  HarnessServer,
} from "./harness-server.js";
