/// <reference types="node" />

const STARTUP_STATE = Symbol.for("dev.cantelop.sdk.harness-startup.v1");

interface StartupState {
  readonly started: bigint;
  readonly seen: Set<string>;
}

/** Records a bounded, secret-free stage when the deploy-generated bootstrap is active. */
export function markHarnessStartup(stage: "server_created" | "listener_ready"): void {
  const state = (globalThis as Record<symbol, unknown>)[STARTUP_STATE];
  if (!isStartupState(state) || state.seen.has(stage)) return;
  state.seen.add(stage);
  const now = process.hrtime.bigint();
  process.stderr.write(`${JSON.stringify({
    component: "cantelop.sdk",
    event: "harness_startup_stage",
    stage,
    elapsed_us: Number((now - state.started) / 1_000n),
  })}\n`);
}

function isStartupState(value: unknown): value is StartupState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StartupState>;
  return typeof candidate.started === "bigint" && candidate.seen instanceof Set;
}
