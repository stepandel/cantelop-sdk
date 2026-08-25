/// <reference types="node" />

const STARTUP_STATE = Symbol.for("dev.cantelop.sdk.harness-startup.v1");

interface StartupState {
  readonly started: bigint;
  readonly seen: Set<string>;
}

export interface HarnessMessageLifecycleEvent {
  readonly type: "deduplicated" | "enqueued" | "failed" | "handled" | "handling";
  readonly messageId: string;
  readonly sequence?: number;
  readonly depth?: number;
  readonly queueWaitMicroseconds?: number;
  readonly handlingMicroseconds?: number;
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

/** Emits secret-free message telemetry when running from a deploy-generated bootstrap. */
export function markMessageLifecycle(event: HarnessMessageLifecycleEvent): void {
  const state = (globalThis as Record<symbol, unknown>)[STARTUP_STATE];
  if (!isStartupState(state)) return;
  process.stderr.write(`${JSON.stringify({
    component: "cantelop.sdk",
    event: "message_lifecycle",
    message_id: event.messageId,
    state: event.type,
    ...(event.sequence === undefined ? {} : { sequence: event.sequence }),
    ...(event.depth === undefined ? {} : { mailbox_depth: event.depth }),
    ...(event.queueWaitMicroseconds === undefined
      ? {}
      : { queue_wait_us: event.queueWaitMicroseconds }),
    ...(event.handlingMicroseconds === undefined
      ? {}
      : { handling_us: event.handlingMicroseconds }),
  })}\n`);
}

function isStartupState(value: unknown): value is StartupState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StartupState>;
  return typeof candidate.started === "bigint" && candidate.seen instanceof Set;
}
