export type ExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface StartExecutionOptions {
  signal?: AbortSignal;
}

export interface Execution<Output> {
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  cancel(reason?: unknown): Promise<void>;
  wait(): Promise<Output>;
}

/**
 * The API-facing transport for dispatching work to a harness execution
 * environment. Cantelop supplies a remote implementation at the Edge.
 */
export interface ExecutionEnvironment<Input, Output> {
  start(
    input: Input,
    options?: StartExecutionOptions,
  ): Promise<Execution<Output>>;
}
