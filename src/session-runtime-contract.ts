import type { SessionBehaviour } from "./session.js";

/** Handler implementation compiled into the Sandbox artifact. */
export type SessionRuntime<Message = unknown, Event = never, Reply = never> = SessionBehaviour<Message, Event, Reply>;

/** Internal compiler metadata; never a developer supplied runtime option. */
export const RUNTIME_ID = Symbol.for("dev.cantelop.sdk.compiled-runtime.v1");

export function assertRuntimeID(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new TypeError("A Session runtime ID is required");
}

export function assertSessionRuntime(value: unknown): asserts value is SessionRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Session runtime implementation is required");
  const runtime = value as Record<string, unknown>;
  if (typeof runtime.receive !== "function") throw new TypeError("Session runtime receive handler is required");
  for (const key of ["onActivate", "onRecover"]) {
    if (runtime[key] !== undefined && typeof runtime[key] !== "function") throw new TypeError(`Session runtime ${key} must be a function`);
  }
  if (runtime.redelivery !== undefined && typeof runtime.redelivery !== "boolean") throw new TypeError("Session runtime redelivery must be boolean");
  if (Object.keys(runtime).some(key => !["receive", "onActivate", "onRecover", "redelivery"].includes(key))) throw new TypeError("Invalid Session runtime implementation");
}
