import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { OPENCODE_BINARY } from "./environment.ts";
import { NativeOpenCode } from "./native.ts";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return new NativeOpenCode({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.OPENCODE_PATH ?? OPENCODE_BINARY,
    ...(context.env.OPENCODE_MODEL ? { model: context.env.OPENCODE_MODEL } : {}),
  }, context.signal);
}
