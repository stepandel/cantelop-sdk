import { createHash } from "node:crypto";

export class RuntimeProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface MessageReceipt {
  sandbox_id: string;
  message_id: string;
  attempt_id?: string;
  sequence: number;
  generation: number;
  accepted_at: string;
  deadline: string;
  state:
    "queued" | "running" | "cancelling" | "succeeded" | "failed" | "timed_out";
  cancellation_requested_at?: string;
  error_code?: string;
  started_at?: string;
  settled_at?: string;
}
interface Reservation {
  fingerprint: string;
  receipt: MessageReceipt;
  controller: AbortController;
  settled: Promise<void>;
  reply?: { value: unknown };
}
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 604_800_000;
/** A caller deadline may exceed the local timeout by this much to absorb clock skew. */
const DEADLINE_SKEW_MS = 30_000;

/** Reservations and outcomes live until this sandbox retires. Never evict IDs. */
export class RuntimeMessages {
  private pendingBytes = 0;
  private completionGeneration = 0;
  private readonly completionWaiters = new Set<() => void>();
  private readonly records = new Map<string, Reservation>();
  /** Unsettled receipts, so work() does not scan every retained record. */
  private readonly unsettled = new Set<MessageReceipt>();
  constructor(
    readonly sandboxId: string,
    private readonly timeoutMs = 300_000,
    private readonly maxMessages = 4096,
    private readonly onCancel: (id:string,reason:unknown)=>void = ()=>undefined,
  ) {
    if (!/^sbx-[0-9a-f]{32}$/.test(sandboxId))
      throw new Error("CANTELOP_SANDBOX_ID must identify this sandbox");
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS
    )
      throw new Error("invalid message execution timeout");
  }
  admit(
    id: string,
    semanticEnvelope: unknown,
    enqueue: (
      signal: AbortSignal,
      started: () => void,
    ) => {
      generation: number;
      settled: Promise<void>;
      reply?: { value: unknown };
    },
    deadline?: string,
    attemptId?: string,
  ): { receipt: MessageReceipt; settled: Promise<void> } {
    const encoded = canonical(semanticEnvelope);
    const bytes = Buffer.byteLength(encoded);
    const fingerprint = createHash("sha256").update(encoded).digest("hex");
    const existing = this.records.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new RuntimeProtocolError(409, "message_conflict");
      return { receipt: { ...existing.receipt }, settled: existing.settled };
    }
    if (
      this.records.size >= this.maxMessages ||
      this.pendingBytes + bytes > MAX_PENDING_BYTES
    )
      throw new RuntimeProtocolError(429, "mailbox_capacity");
    const now = Date.now();
    const expires =
      deadline === undefined ? now + this.timeoutMs : Date.parse(deadline);
    if (
      !Number.isFinite(expires) ||
      expires <= now ||
      expires > now + this.timeoutMs + DEADLINE_SKEW_MS
    )
      throw new RuntimeProtocolError(400, "invalid_execution_deadline");
    const controller = new AbortController();
    const receipt: MessageReceipt = {
      sandbox_id: this.sandboxId,
      message_id: id,
      sequence: this.records.size + 1,
      ...(attemptId === undefined ? {} : { attempt_id: attemptId }),
      generation: 0,
      accepted_at: new Date(now).toISOString(),
      deadline: new Date(expires).toISOString(),
      state: "queued",
    };
    const delivery = enqueue(controller.signal, () => {
      if (!controller.signal.aborted) receipt.state = "running";
      receipt.started_at = new Date().toISOString();
    });
    receipt.generation = delivery.generation;
    this.pendingBytes += bytes;
    this.unsettled.add(receipt);
    const timer = setTimeout(() => this.cancel(id), expires - now);
    timer.unref();
    const settled = delivery.settled
      .then(
        () => {
          receipt.state = !controller.signal.aborted ? "succeeded" : receipt.error_code === "message_timed_out" ? "timed_out" : "failed";
        },
        () => {
          receipt.state = controller.signal.aborted && receipt.error_code === "message_timed_out" ? "timed_out" : "failed";
        },
      )
      .finally(() => {
        receipt.settled_at = new Date().toISOString();
        this.unsettled.delete(receipt);
        clearTimeout(timer);
        this.pendingBytes -= bytes;
        this.completionGeneration++;
        for (const wake of [...this.completionWaiters]) wake();
      });
    this.records.set(id, {
      fingerprint,
      receipt,
      controller,
      settled,
      ...(delivery.reply === undefined ? {} : { reply: delivery.reply }),
    });
    return { receipt: { ...receipt }, settled };
  }
  /** A completion hint; receipts and replies remain the source of truth. */
  async completions(after: number, signal: AbortSignal): Promise<{ generation: number }> {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(after) || after < 0 || after > this.completionGeneration)
      throw new RuntimeProtocolError(409, "invalid_completion_generation");
    if (after === this.completionGeneration) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.completionWaiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        this.completionWaiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    return { generation: this.completionGeneration };
  }
  work() {
    let deadline: string | undefined, cancellation_requested_at: string | undefined;
    for (const receipt of this.unsettled) {
      if (!["queued", "running", "cancelling"].includes(receipt.state)) continue;
      if (deadline === undefined || receipt.deadline < deadline) deadline = receipt.deadline;
      const requested = receipt.cancellation_requested_at;
      if (requested && (cancellation_requested_at === undefined || requested < cancellation_requested_at)) cancellation_requested_at = requested;
    }
    return deadline === undefined ? null : { deadline, cancellation_requested_at };
  }
  get(id: string): MessageReceipt {
    const record = this.records.get(id);
    if (!record) throw new RuntimeProtocolError(404, "message_not_found");
    return { ...record.receipt };
  }
  reply(id: string): unknown {
    const record = this.records.get(id);
    if (!record) throw new RuntimeProtocolError(404, "message_not_found");
    if (record.receipt.state !== "succeeded")
      throw new RuntimeProtocolError(409, "reply_not_ready");
    if (record.reply === undefined)
      throw new RuntimeProtocolError(409, "reply_unavailable");
    return record.reply.value;
  }
  cancel(id: string, code = "message_timed_out"): MessageReceipt {
    const record = this.records.get(id);
    if (!record) throw new RuntimeProtocolError(404, "message_not_found");
    if (
      record.receipt.state === "queued" ||
      record.receipt.state === "running"
    ) {
      record.receipt.state = "cancelling";
      record.receipt.error_code = code;
      record.receipt.cancellation_requested_at = new Date().toISOString();
      record.controller.abort(
        new DOMException("Message execution cancelled", "AbortError"),
      );
      // Settled messages no longer own their background work.
      this.onCancel(id, record.controller.signal.reason);
    }
    return { ...record.receipt };
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
