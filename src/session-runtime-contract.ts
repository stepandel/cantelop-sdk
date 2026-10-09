import type { SessionBehaviour } from "./session.js";

/** Behaviour supplied directly to CantelopClient and executed only in the Sandbox. */
export type SessionRuntime<Message = unknown, Event = never, Reply = never> = SessionBehaviour<Message, Event, Reply> & {
  /** Change this identity when changing an incompatible public contract. */
  readonly id: string;
};

export function assertRuntimeID(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new TypeError("A Session runtime ID is required");
}
export function assertSessionRuntime(value: unknown): asserts value is SessionRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Session runtime behaviour is required");
  const runtime = value as Record<string, unknown>;
  assertRuntimeID(runtime.id);
  if (typeof runtime.receive !== "function") throw new TypeError("A Session receive handler is required");
  for (const hook of ["onActivate", "onRecover"]) {
    if (runtime[hook] !== undefined && typeof runtime[hook] !== "function") throw new TypeError("Invalid Session lifecycle hook");
  }
  if (runtime.redelivery !== undefined && typeof runtime.redelivery !== "boolean") throw new TypeError("Invalid Session redelivery policy");
  if (Object.keys(runtime).some(key => !["id", "receive", "onActivate", "onRecover", "redelivery"].includes(key))) throw new TypeError("Invalid Session runtime behaviour");
}
