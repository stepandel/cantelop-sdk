import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { NativeClaude } from "./native.js";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return new NativeClaude({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.CLAUDE_PATH ?? "/usr/local/bin/claude",
    loginHelper: context.env.CLAUDE_LOGIN_HELPER ?? "/opt/app/login-pty.py",
    ...(context.env.CLAUDE_MODEL ? { model: context.env.CLAUDE_MODEL } : {}),
  }, context.signal);
}
