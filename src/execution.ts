export type Awaitable<T> = T | Promise<T>;

export type ExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface HarnessContext<Input> {
  readonly id: string;
  readonly input: Input;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

export type HarnessRuntime<Input, Output> =
  | ((context: HarnessContext<Input>) => Awaitable<Output>)
  | {
      run(context: HarnessContext<Input>): Awaitable<Output>;
    };

export interface StartExecutionOptions {
  env?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface Execution<Output> {
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  cancel(reason?: unknown): void;
  wait(): Promise<Output>;
}

export interface ExecutionEnvironment<Input, Output> {
  start(input: Input, options?: StartExecutionOptions): Execution<Output>;
}

function invoke<Input, Output>(
  runtime: HarnessRuntime<Input, Output>,
  context: HarnessContext<Input>,
): Awaitable<Output> {
  return typeof runtime === "function"
    ? runtime(context)
    : runtime.run(context);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Execution cancelled", "AbortError");
}

class ExecutionHandle<Output> implements Execution<Output> {
  status: ExecutionStatus = "pending";
  startedAt?: Date;
  finishedAt?: Date;

  constructor(
    readonly id: string,
    private readonly controller: AbortController,
    private readonly result: Promise<Output>,
  ) {}

  cancel(reason?: unknown): void {
    if (this.status === "pending" || this.status === "running") {
      this.controller.abort(reason);
    }
  }

  wait(): Promise<Output> {
    return this.result;
  }
}

export function createExecutionEnvironment<Input = unknown, Output = unknown>(
  runtime: HarnessRuntime<Input, Output>,
): ExecutionEnvironment<Input, Output> {
  return {
    start(input, options = {}) {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(options.signal?.reason);

      if (options.signal) {
        if (options.signal.aborted) {
          controller.abort(options.signal.reason);
        } else {
          options.signal.addEventListener("abort", forwardAbort, { once: true });
        }
      }

      let handle: ExecutionHandle<Output>;
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
            env: Object.freeze({ ...(options.env ?? {}) }),
            signal: controller.signal,
          });

          if (controller.signal.aborted) {
            throw abortReason(controller.signal);
          }

          handle.status = "succeeded";
          return output;
        } catch (error) {
          handle.status = controller.signal.aborted ? "cancelled" : "failed";
          throw error;
        } finally {
          options.signal?.removeEventListener("abort", forwardAbort);
          handle.finishedAt = new Date();
        }
      });

      handle = new ExecutionHandle(id, controller, result);
      return handle;
    },
  };
}
