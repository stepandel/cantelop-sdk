/** A portable contract: importing this never imports executable agent code. */
declare const contract: unique symbol;
export interface SessionRuntimeDefinition<Message = unknown, Event = never, Reply = never, View = never> {
  /** Change this versioned identity when changing the runtime's public contract. */
  readonly id: string;
  /** Behaviour module path relative to the definition module (build time only). */
  readonly entrypoint: string;
  readonly [contract]: { readonly message: Message; readonly event: Event; readonly reply: Reply; readonly view: View };
}

export function defineSessionRuntime<Message = unknown, Event = never, Reply = never, View = never>(
  options: { readonly id: string; readonly entrypoint: string },
): SessionRuntimeDefinition<Message, Event, Reply, View> {
  assertSessionRuntime(options);
  return Object.freeze({ id: options.id, entrypoint: options.entrypoint }) as SessionRuntimeDefinition<Message, Event, Reply, View>;
}

export function assertRuntimeID(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value)) throw new TypeError("A versioned Session runtime ID is required");
}
export function assertSessionRuntime(value: unknown): asserts value is SessionRuntimeDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("A Session runtime definition is required");
  const runtime = value as Record<string, unknown>;
  assertRuntimeID(runtime.id);
  if (typeof runtime.entrypoint !== "string" || !runtime.entrypoint.startsWith("./") || runtime.entrypoint.includes("\\") || runtime.entrypoint.split("/").includes("..") || runtime.entrypoint.includes("\0") || runtime.entrypoint === "./") throw new TypeError("Runtime entrypoint must be a relative project file");
  if (Object.keys(runtime).some(key => !["id", "entrypoint"].includes(key))) throw new TypeError("Invalid Session runtime definition");
}

export type AnySessionRuntime = SessionRuntimeDefinition<unknown, unknown, unknown, unknown>;
export type RuntimeMessage<Runtime extends AnySessionRuntime> = Runtime extends SessionRuntimeDefinition<infer Message, unknown, unknown, unknown> ? Message : never;
export type RuntimeEvent<Runtime extends AnySessionRuntime> = Runtime extends SessionRuntimeDefinition<unknown, infer Event, unknown, unknown> ? Event : never;
export type RuntimeReply<Runtime extends AnySessionRuntime> = Runtime extends SessionRuntimeDefinition<unknown, unknown, infer Reply, unknown> ? Reply : never;
export type RuntimeView<Runtime extends AnySessionRuntime> = Runtime extends SessionRuntimeDefinition<unknown, unknown, unknown, infer View> ? View : never;
