export type ExecutionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface StartExecutionOptions {
  readonly signal?: AbortSignal;
}

/** An in-process native harness execution. */
export interface Execution<Output> {
  readonly id: string;
  readonly status: ExecutionStatus;
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
  cancel(reason?: unknown): Promise<void>;
  wait(): Promise<Output>;
}
