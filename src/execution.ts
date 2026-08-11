export type Awaitable<T> = T | Promise<T>;

export type ExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface HarnessContext<Input, Event = never> {
  readonly id: string;
  readonly input: Input;
  readonly signal: AbortSignal;
  emit(event: Event): void;
}

export type HarnessRuntime<Input, Output, Event = never> =
  | ((context: HarnessContext<Input, Event>) => Awaitable<Output>)
  | {
      run(context: HarnessContext<Input, Event>): Awaitable<Output>;
    };

export interface StartExecutionOptions {
  signal?: AbortSignal;
}

export interface Execution<Output, Event = never> {
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  cancel(reason?: unknown): void;
  events(): AsyncIterable<Event>;
  wait(): Promise<Output>;
}

export interface ExecutionEnvironment<Input, Output, Event = never> {
  start(
    input: Input,
    options?: StartExecutionOptions,
  ): Execution<Output, Event>;
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

class ExecutionHandle<Output, Event> implements Execution<Output, Event> {
  status: ExecutionStatus = "pending";
  startedAt?: Date;
  finishedAt?: Date;

  constructor(
    readonly id: string,
    private readonly controller: AbortController,
    private readonly result: Promise<Output>,
    private readonly eventStream: ExecutionEventStream<Event>,
  ) {}

  cancel(reason?: unknown): void {
    if (this.status === "pending" || this.status === "running") {
      this.controller.abort(reason);
    }
  }

  events(): AsyncIterable<Event> {
    return this.eventStream;
  }

  wait(): Promise<Output> {
    return this.result;
  }
}

export function createExecutionEnvironment<
  Input = unknown,
  Output = unknown,
  Event = never,
>(
  runtime: HarnessRuntime<Input, Output, Event>,
): ExecutionEnvironment<Input, Output, Event> {
  return {
    start(input, options = {}) {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const eventStream = new ExecutionEventStream<Event>();
      const forwardAbort = () => controller.abort(options.signal?.reason);

      if (options.signal) {
        if (options.signal.aborted) {
          controller.abort(options.signal.reason);
        } else {
          options.signal.addEventListener("abort", forwardAbort, { once: true });
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
          options.signal?.removeEventListener("abort", forwardAbort);
          handle.finishedAt = new Date();
          eventStream.close();
        }
      });

      // A streaming consumer may only observe events and never call wait(). Keep
      // the original promise rejectable for wait(), but mark it as observed.
      void result.catch(() => undefined);
      handle = new ExecutionHandle(id, controller, result, eventStream);
      return handle;
    },
  };
}
