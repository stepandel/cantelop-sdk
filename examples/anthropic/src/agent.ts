import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { wrapNativeHarness, type NativeHarness } from "../../native-harness/cli.js";
import { NativeClaude } from "./native.js";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return wrapClaude(new NativeClaude({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.CLAUDE_PATH ?? "/usr/local/bin/claude",
    ...(context.env.CLAUDE_MODEL ? { model: context.env.CLAUDE_MODEL } : {}),
  }), context.signal);
}

/** Adapt an existing native CLI runner; Cantelop supplies scheduling and the turn signal. */
export function wrapClaude(harness: NativeHarness, lifetime?: AbortSignal) { return wrapNativeHarness(harness, lifetime); }
