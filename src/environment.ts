import { RemoteAppError } from "./remote-app.js";
import type { EnvironmentCommand } from "./environment-command.js";

export { ENVIRONMENT_COMMAND_TYPES, validateEnvironmentCommand, type EnvironmentCommand, type EnvironmentCommandType } from "./environment-command.js";

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
      const timeoutMs = options.timeoutMs ?? 120_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError("Invalid environment wait timeout");
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]);
      for (let delay = 250; ; delay = Math.min(delay * 2, 5_000)) {
        signal.throwIfAborted();
        const result = await api.status(revision, { signal });
        if (result.status === "failed") throw new RemoteAppError("environment_update_failed", 503);
        if (result.status === "applied") return result;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    },
  };
  return Object.freeze(api);
}
