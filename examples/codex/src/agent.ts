import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { NativeCodex } from "./native.ts";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return new NativeCodex({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.CODEX_PATH ?? "/usr/local/bin/codex",
    ...(context.env.CODEX_MODEL ? { model: context.env.CODEX_MODEL } : {}),
  }, context.signal);
}
