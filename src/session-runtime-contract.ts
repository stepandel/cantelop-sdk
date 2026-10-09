/** A runtime module resolved relative to the client definition at build time. */
export interface SessionRuntime {
  /** Change this identity when changing an incompatible public contract. */
  readonly id: string;
  /** Relative path to a module exporting receive and optional lifecycle hooks. */
  readonly entrypoint: string;
}

export function assertRuntimeID(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new TypeError("A Session runtime ID is required");
}

export function assertSessionRuntime(value: unknown): asserts value is SessionRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Session runtime reference is required");
  const runtime = value as Record<string, unknown>;
  assertRuntimeID(runtime.id);
  if (typeof runtime.entrypoint !== "string" || !runtime.entrypoint.startsWith("./") ||
      runtime.entrypoint.includes("\\") || runtime.entrypoint.includes("\0") ||
      runtime.entrypoint.split("/").some(part => part === "..") || runtime.entrypoint.endsWith("/")) {
    throw new TypeError("Session runtime entrypoint must be a relative module path inside the definition directory");
  }
  if (Object.keys(runtime).some(key => !["id", "entrypoint"].includes(key))) throw new TypeError("Invalid Session runtime reference");
}
