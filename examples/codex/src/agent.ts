import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { CODEX_BINARY } from "./environment.ts";
import { NativeCodex } from "./native.ts";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return new NativeCodex({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.CODEX_PATH ?? CODEX_BINARY,
    ...(context.env.CODEX_MODEL ? { model: context.env.CODEX_MODEL } : {}),
  }, context.signal);
}
