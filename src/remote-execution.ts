import type {
  Execution,
  ExecutionEnvironment,
  ExecutionProvider,
  ExecutionStatus,
  StartExecutionOptions,
} from "./execution.js";

const ENVIRONMENT_ID_PATTERN = /^env_[0-9a-f]{32}$/;
const RUNTIME_ORIGIN = "https://runtime.cantelop.internal";
const ENVIRONMENT_HEADER = "X-Cantelop-Edge-Environment-ID";
const MAX_ENVELOPE_BYTES = 1024 * 1024;

type RuntimeFetch = (request: Request) => Promise<Response>;
type ExecutionIDFactory = () => string;

export interface RemoteExecutionProviderOptions {
  fetch?: RuntimeFetch;
  executionId?: ExecutionIDFactory;
}

export class RemoteExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`Cantelop execution failed: ${code}`);
    this.name = "RemoteExecutionError";
  }
}

export function createRemoteExecutionProvider<Input = unknown, Output = unknown>(
  options: RemoteExecutionProviderOptions = {},
): ExecutionProvider<Input, Output> {
  const runtimeFetch = options.fetch ?? ((request: Request) => fetch(request));
  const executionId = options.executionId ?? createExecutionID;

  return Object.freeze({
    forEnvironment(environmentId: string): ExecutionEnvironment<Input, Output> {
      assertEnvironmentID(environmentId);
      return Object.freeze({
        start(
          input: Input,
          startOptions: StartExecutionOptions = {},
        ): Promise<Execution<Output>> {
          const id = executionId();
          assertExecutionID(id);
          return Promise.resolve(
            new RemoteExecution<Output>(
              id,
              environmentId,
              input,
              startOptions,
              runtimeFetch,
            ),
          );
        },
      });
    },
  });
}

class RemoteExecution<Output> implements Execution<Output> {
  status: ExecutionStatus = "pending";
  startedAt?: Date;
  finishedAt?: Date;

  private readonly controller = new AbortController();
  private readonly result: Promise<Output>;
  private readonly forwardAbort: () => void;

  constructor(
    readonly id: string,
    environmentId: string,
    input: unknown,
    options: StartExecutionOptions,
    runtimeFetch: RuntimeFetch,
  ) {
    this.forwardAbort = () => this.controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      this.controller.abort(options.signal.reason);
    } else {
      options.signal?.addEventListener("abort", this.forwardAbort, { once: true });
    }

    this.result = this.execute(environmentId, input, runtimeFetch).finally(() => {
      options.signal?.removeEventListener("abort", this.forwardAbort);
    });
    void this.result.catch(() => undefined);
  }

  cancel(reason?: unknown): Promise<void> {
    if (this.status === "pending" || this.status === "running") {
      this.controller.abort(reason);
    }
    return Promise.resolve();
  }

  wait(): Promise<Output> {
    return this.result;
  }

  private async execute(
    environmentId: string,
    input: unknown,
    runtimeFetch: RuntimeFetch,
  ): Promise<Output> {
    if (this.controller.signal.aborted) {
      this.status = "cancelled";
      this.finishedAt = new Date();
      throw abortReason(this.controller.signal);
    }

    this.status = "running";
    this.startedAt = new Date();
    try {
      const body = JSON.stringify({ input });
      if (body === undefined || byteLength(body) > MAX_ENVELOPE_BYTES) {
        throw new RemoteExecutionError("invalid_execution_input", 0);
      }
      const response = await runtimeFetch(
        new Request(`${RUNTIME_ORIGIN}/__cantelop/v1/executions/${this.id}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [ENVIRONMENT_HEADER]: environmentId,
          },
          body,
          redirect: "manual",
          signal: this.controller.signal,
        }),
      );
      const envelope = await readEnvelope(response);
      if (!response.ok) {
        throw new RemoteExecutionError(readErrorCode(envelope), response.status);
      }
      if (!isRecord(envelope) || !("output" in envelope)) {
        throw new RemoteExecutionError("invalid_execution_response", response.status);
      }

      this.status = "succeeded";
      return envelope.output as Output;
    } catch (error) {
      this.status = this.controller.signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      this.finishedAt = new Date();
    }
  }
}

async function readEnvelope(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("Content-Length");
  if (declaredLength !== null && Number(declaredLength) > MAX_ENVELOPE_BYTES) {
    throw new RemoteExecutionError("invalid_execution_response", response.status);
  }
  const body = await response.text();
  if (byteLength(body) > MAX_ENVELOPE_BYTES) {
    throw new RemoteExecutionError("invalid_execution_response", response.status);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RemoteExecutionError("invalid_execution_response", response.status);
  }
}

function readErrorCode(envelope: unknown): string {
  if (!isRecord(envelope) || !isRecord(envelope.error)) {
    return "execution_failed";
  }
  return typeof envelope.error.code === "string" && envelope.error.code.length > 0
    ? envelope.error.code
    : "execution_failed";
}

function assertEnvironmentID(environmentId: string): void {
  if (!ENVIRONMENT_ID_PATTERN.test(environmentId)) {
    throw new TypeError("Invalid Cantelop Environment ID");
  }
}

function assertExecutionID(executionId: string): void {
  if (!/^exec_[0-9a-f]{32}$/.test(executionId)) {
    throw new TypeError("Invalid Cantelop execution ID");
  }
}

function createExecutionID(): string {
  return `exec_${crypto.randomUUID().replaceAll("-", "")}`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Execution cancelled", "AbortError");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
