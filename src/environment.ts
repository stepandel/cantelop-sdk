import { RemoteAppError } from "./transport.js";
import { MAX_REQUEST_TIMEOUT_MS, type ENVIRONMENT_COMMAND_TYPES } from "./integration-protocol.js";

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const FIRST_POLL_DELAY_MS = 250;
const MAX_POLL_DELAY_MS = 5_000;

export interface EnvironmentCommandOptions {
  /** Correlates this request and response. Retried mutations create a new configuration revision. */
  readonly id?: string;
  readonly signal?: AbortSignal;
}

/** Only metadata is returned; secret values cannot be read through this API. */
export interface EnvironmentUpdate {
  readonly revision: number;
  readonly status: "pending" | "applied" | "failed";
}
export type EnvironmentCommandType = (typeof ENVIRONMENT_COMMAND_TYPES)[number];
export type EnvironmentCommand =
  | { readonly type: "app.environment.set"; readonly name: string; readonly value: string; readonly secret: boolean }
  | { readonly type: "app.environment.unset"; readonly name: string; readonly secret: boolean }
  | { readonly type: "app.environment.status"; readonly revision: number };
export interface AppEnvironment {
  set(name: string, value: string, options?: EnvironmentCommandOptions & { readonly secret?: boolean }): Promise<EnvironmentUpdate>;
  unset(name: string, options?: EnvironmentCommandOptions & { readonly secret?: boolean }): Promise<EnvironmentUpdate>;
  status(revision: number, options?: EnvironmentCommandOptions): Promise<EnvironmentUpdate>;
  /** Wait for Edge and compute configuration to reach this revision. Does not restart existing Sandboxes. */
  wait(revision: number, options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<EnvironmentUpdate>;
}
/** `send` validates the command envelope, including the command itself, before transport. */
export function createAppEnvironment(send: (command: EnvironmentCommand, options?: EnvironmentCommandOptions) => Promise<unknown>): AppEnvironment {
  async function request(command: EnvironmentCommand, options?: EnvironmentCommandOptions): Promise<EnvironmentUpdate> {
    const result = await send(command, options) as EnvironmentUpdate | null;
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 || !["pending", "applied", "failed"].includes(result.status) ||
        Object.keys(result).some(key => !["revision", "status", "protocolVersion", "id"].includes(key)) ||
        command.type === "app.environment.status" && result.revision < command.revision) throw new RemoteAppError("invalid_environment_response", 0);
    return Object.freeze({ revision: result.revision, status: result.status });
  }
  const api: AppEnvironment = {
    set: (name, value, options = {}) => request({ type: "app.environment.set", name, value, secret: options.secret ?? false }, options),
    unset: (name, options = {}) => request({ type: "app.environment.unset", name, secret: options.secret ?? false }, options),
    status: (revision, options) => request({ type: "app.environment.status", revision }, options),
    async wait(revision, options = {}) {
      const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) throw new TypeError("Invalid environment wait timeout");
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
      for (let delay = FIRST_POLL_DELAY_MS; ; delay = Math.min(delay * 2, MAX_POLL_DELAY_MS)) {
        signal.throwIfAborted();
        const result = await api.status(revision, { signal });
        if (result.status === "failed") throw new RemoteAppError("environment_update_failed", 503);
        if (result.status === "applied") return result;
        await delayUnlessAborted(delay, signal);
      }
    },
  };
  return Object.freeze(api);
}

/** Resolves after `ms`, or rejects with the signal's reason; never leaves a listener behind. */
function delayUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
