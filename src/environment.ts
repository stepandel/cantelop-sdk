import type { SessionCommandOptions } from "./integration.js";
import { RemoteAppError } from "./remote-app.js";

/** Only metadata is returned; secret values cannot be read through this API. */
export interface EnvironmentUpdate {
  readonly revision: number;
  readonly status: "pending" | "applied" | "failed";
}
export type EnvironmentCommand =
  | { readonly type: "app.environment.set"; readonly name: string; readonly value: string; readonly secret: boolean }
  | { readonly type: "app.environment.unset"; readonly name: string; readonly secret: boolean }
  | { readonly type: "app.environment.status"; readonly revision: number };
export interface AppEnvironment {
  set(name: string, value: string, options?: SessionCommandOptions & { readonly secret?: boolean }): Promise<EnvironmentUpdate>;
  unset(name: string, options?: SessionCommandOptions & { readonly secret?: boolean }): Promise<EnvironmentUpdate>;
  status(revision: number, options?: SessionCommandOptions): Promise<EnvironmentUpdate>;
  /** Wait for Edge and compute configuration to reach this revision. Does not restart existing Sandboxes. */
  wait(revision: number, options?: { readonly signal?: AbortSignal; readonly timeoutMs?: number }): Promise<EnvironmentUpdate>;
}
export function validateEnvironmentCommand(command: EnvironmentCommand): void {
  if (command.type === "app.environment.status") {
    if (!Number.isSafeInteger(command.revision) || command.revision < 0) throw new TypeError("Invalid environment revision");
    return;
  }
  if (typeof command.name !== "string" || !/^(?!CANTELOP_)[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(command.name) || typeof command.secret !== "boolean") throw new TypeError("Invalid environment name or kind");
  if (command.type === "app.environment.set" && (typeof command.value !== "string" || command.value.includes("\0") || new TextEncoder().encode(command.value).length > 64 * 1024)) throw new TypeError("Invalid environment value");
}
export function createAppEnvironment(send: (command: EnvironmentCommand, options?: SessionCommandOptions) => Promise<unknown>): AppEnvironment {
  async function request(command: EnvironmentCommand, options?: SessionCommandOptions): Promise<EnvironmentUpdate> {
    validateEnvironmentCommand(command);
    const result = await send(command, options) as EnvironmentUpdate | null;
    if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 || !["pending", "applied", "failed"].includes(result.status) ||
        Object.keys(result).some(key => !["revision", "status", "protocolVersion", "id"].includes(key)) ||
        command.type === "app.environment.status" && result.revision !== command.revision) throw new RemoteAppError("invalid_environment_response", 0);
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
      for (;;) {
        signal.throwIfAborted();
        const result = await api.status(revision, { signal });
        if (result.status === "failed") throw new RemoteAppError("environment_update_failed", 503);
        if (result.status === "applied") return result;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    },
  };
  return Object.freeze(api);
}
