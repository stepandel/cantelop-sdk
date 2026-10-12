import type { SessionHarnessContext } from "@cantelop/sdk/session";
import { wrapNativeHarness, type NativeHarness } from "../../native-harness/cli.js";
import { NativeCodex } from "./native.js";

export function create(context: SessionHarnessContext) {
  context.signal.throwIfAborted();
  return wrapCodex(new NativeCodex({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.CODEX_PATH ?? "/usr/local/bin/codex",
    ...(context.env.CODEX_MODEL ? { model: context.env.CODEX_MODEL } : {}),
  }), context.signal);
}

/** Adapt an existing native CLI runner; Cantelop supplies scheduling and the turn signal. */
export function wrapCodex(harness: NativeHarness, lifetime?: AbortSignal) { return wrapNativeHarness(harness, lifetime); }
