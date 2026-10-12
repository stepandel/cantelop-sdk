import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { wrapNativeHarness, type NativeHarness } from "../../native-harness/cli.js";
import { NativeOpenCode } from "./native.js";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return wrapOpenCode(new NativeOpenCode({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.OPENCODE_PATH ?? "/usr/local/bin/opencode",
    ...(context.env.OPENCODE_MODEL ? { model: context.env.OPENCODE_MODEL } : {}),
  }), context.signal);
}

/** Adapt an existing native CLI runner; Cantelop supplies scheduling and the turn signal. */
export function wrapOpenCode(harness: NativeHarness, lifetime?: AbortSignal) { return wrapNativeHarness(harness, lifetime); }
