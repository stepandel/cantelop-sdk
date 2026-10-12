/** Capture and signal the current run synchronously, before another can start. */
export function cancelRuntimeWork(commandId: string, activity: { cancel(): boolean }): unknown {
  return { id: commandId, state: activity.cancel() ? "requested" : "idle" };
}
