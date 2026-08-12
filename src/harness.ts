import type {
  Execution,
  ExecutionStatus,
  StartExecutionOptions,
} from "./execution.js";

export type Awaitable<T> = T | Promise<T>;

export type HarnessEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface HarnessContext<Input, Event = never> {
  readonly id: string;
  readonly input: Input;
  readonly env: HarnessEnvironment;
  readonly signal: AbortSignal;
  emit(event: Event): void;
}

export type HarnessRuntime<Input, Output, Event = never> =
  | ((context: HarnessContext<Input, Event>) => Awaitable<Output>)
  | {
      run(context: HarnessContext<Input, Event>): Awaitable<Output>;
    };

export interface HarnessEnvironmentOptions {
  env?: HarnessEnvironment;
}

export interface HarnessExecution<Output, Event = never>
  extends Execution<Output> {
  events(): AsyncIterable<Event>;
}

export interface HarnessExecutionEnvironment<Input, Output, Event = never> {
  start(
    input: Input,
    options?: StartExecutionOptions,
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
  return typeof runtime === "function"
    ? runtime(context)
    : runtime.run(context);
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
 * Creates the in-process execution environment used inside a native harness VM.
 * Edge APIs receive a remote ExecutionEnvironment from Cantelop instead.
 */
export function createExecutionEnvironment<
  Input = unknown,
  Output = unknown,
  Event = never,
>(
  runtime: HarnessRuntime<Input, Output, Event>,
  options: HarnessEnvironmentOptions = {},
): HarnessExecutionEnvironment<Input, Output, Event> {
  return {
    async start(input, startOptions: StartExecutionOptions = {}) {
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
          const output = await invoke(runtime, {
            id,
            input,
            env: options.env ?? {},
            signal: controller.signal,
            emit: (event) => eventStream.emit(event),
          });

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

export type {
  Execution,
  ExecutionEnvironment,
  ExecutionStatus,
  StartExecutionOptions,
} from "./execution.js";
export {
  createHarnessRequestHandler,
  serveHarness,
} from "./harness-server.js";
export type {
  HarnessRequestHandlerOptions,
  HarnessServer,
} from "./harness-server.js";
