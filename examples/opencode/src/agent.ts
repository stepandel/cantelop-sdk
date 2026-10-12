import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { NativeOpenCode } from "./native.js";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return new NativeOpenCode({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.OPENCODE_PATH ?? "/usr/local/bin/opencode",
    ...(context.env.OPENCODE_MODEL ? { model: context.env.OPENCODE_MODEL } : {}),
  }, context.signal);
}
