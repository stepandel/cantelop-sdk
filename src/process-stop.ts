/// <reference types="node" />

/** Grace a stopped native process gets between SIGTERM and SIGKILL. */
export const STOP_GRACE_MS = 1_000;
/**
 * The login PTY helper (`login-pty.py`) escalates its own process group after
 * STOP_GRACE_MS. Killing the helper sooner would orphan that group, so callers
 * stopping the helper wait twice as long before SIGKILL.
 */
export const PTY_STOP_GRACE_MS = 2 * STOP_GRACE_MS;

/**
 * Sends SIGTERM now and SIGKILL after `graceMs`, unless `exited()` reports the
 * process gone by then. Returns the escalation timer so the caller can clear it.
 */
export function stopWithGrace(
  signal: (signal: NodeJS.Signals) => void,
  options: { readonly graceMs: number; readonly exited: () => boolean },
): ReturnType<typeof setTimeout> {
  signal("SIGTERM");
  return setTimeout(() => { if (!options.exited()) signal("SIGKILL"); }, options.graceMs);
}
