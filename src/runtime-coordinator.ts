import type { ActivityCancellation } from "./activity.js";
import { InMemoryMailbox } from "./mailbox.js";
import { RuntimeMessages, RuntimeProtocolError } from "./runtime-messages.js";

/** Work semantics live here; transport only delivers opaque SDK commands. */
export function cancelRuntimeWork(
  commandId: string,
  targetId: string,
  messages: RuntimeMessages,
  queues: readonly InMemoryMailbox<void>[],
  activity: { cancelMessage(id: string): ActivityCancellation },
): unknown {
  let receipt;
  try {
    receipt = messages.get(targetId);
  } catch (error) {
    if (!(error instanceof RuntimeProtocolError) || error.status !== 404)
      throw error;
  }
  const activityCancelled = activity.cancelMessage(targetId);
  if (!receipt && !activityCancelled)
    return { error: { code: "message_not_found" } };

  const running =
    receipt && ["queued", "running", "cancelling"].includes(receipt.state);
  if (running || activityCancelled) {
    let removed = false;
    if (running) {
      messages.cancel(targetId, "message_cancelled");
      removed = queues.some((queue) =>
        queue.cancel(
          targetId,
          new DOMException("Message cancelled", "AbortError"),
        ),
      );
    }
    return {
      id: commandId,
      messageId: targetId,
      state:
        activityCancelled === "cancelled" || ((removed || receipt?.state === "queued") && !activityCancelled)
          ? "cancelled"
          : "requested",
    };
  }

  const startedAt = receipt!.started_at ?? receipt!.accepted_at;
  const settledAt = receipt!.settled_at ?? new Date().toISOString();
  const status =
    receipt!.state === "succeeded"
      ? {
          id: targetId,
          state: "handled",
          accepted_at: receipt!.accepted_at,
          started_at: startedAt,
          handled_at: settledAt,
        }
      : {
          id: targetId,
          state: "failed",
          accepted_at: receipt!.accepted_at,
          started_at: startedAt,
          failed_at: settledAt,
          error: { code: receipt!.error_code ?? "message_handler_failed" },
        };
  return {
    id: commandId,
    messageId: targetId,
    state:
      receipt!.error_code === "message_cancelled" ? "cancelled" : "settled",
    status,
  };
}
