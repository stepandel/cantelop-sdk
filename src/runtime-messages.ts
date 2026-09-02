import { createHash } from "node:crypto";

export class RuntimeProtocolError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface MessageReceipt {
  sandbox_id: string;
  message_id: string;
  sequence: number;
  generation: number;
  accepted_at: string;
  deadline: string;
  state: "queued" | "running" | "cancelling" | "succeeded" | "failed" | "timed_out";
  cancellation_requested_at?: string;
}
interface Reservation {
  fingerprint: string;
  receipt: MessageReceipt;
  controller: AbortController;
  settled: Promise<void>;
}
/** Reservations and outcomes live until this sandbox retires. Never evict IDs. */
export class RuntimeMessages {
  private pendingBytes = 0;
 private readonly records = new Map<string, Reservation>();
  constructor(readonly sandboxId: string, private readonly timeoutMs = 300_000, private readonly maxMessages = 4096) {
    if (!/^sbx-[0-9a-f]{32}$/.test(sandboxId)) throw new Error("CANTELOP_SANDBOX_ID must identify this sandbox");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 604_800_000) throw new Error("invalid message execution timeout");
  }
  admit(id: string, semanticEnvelope: unknown, enqueue: (signal: AbortSignal, started: () => void) => { generation: number; settled: Promise<void> }, deadline?: string): { receipt: MessageReceipt; settled: Promise<void> } {
    const encoded = canonical(semanticEnvelope);
 const bytes = Buffer.byteLength(encoded);
 const fingerprint = createHash("sha256").update(encoded).digest("hex");
    const existing = this.records.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RuntimeProtocolError(409, "message_conflict");
      return { receipt: { ...existing.receipt }, settled: existing.settled };
    }
    if (this.records.size >= this.maxMessages || this.pendingBytes + bytes > 8 * 1024 * 1024) throw new RuntimeProtocolError(429, "mailbox_capacity");
    const now = Date.now();
    const expires = deadline === undefined ? now + this.timeoutMs : Date.parse(deadline);
    if (!Number.isFinite(expires) || expires <= now || expires > now + this.timeoutMs + 30_000) throw new RuntimeProtocolError(400, "invalid_execution_deadline");
    const controller = new AbortController();
    const receipt: MessageReceipt = { sandbox_id: this.sandboxId, message_id: id, sequence: this.records.size + 1,
      generation: 0, accepted_at: new Date(now).toISOString(), deadline: new Date(expires).toISOString(), state: "queued" };
    const delivery = enqueue(controller.signal, () => { if (!controller.signal.aborted) receipt.state = "running"; });
    receipt.generation = delivery.generation;
    this.pendingBytes += bytes;
 const timer = setTimeout(() => this.cancel(id), expires - now);
    timer.unref();
    const settled = delivery.settled.then(() => { receipt.state = controller.signal.aborted ? "timed_out" : "succeeded"; }, () => {
      receipt.state = controller.signal.aborted ? "timed_out" : "failed";
    }).finally(() => { clearTimeout(timer); this.pendingBytes -= bytes; });
    this.records.set(id, { fingerprint, receipt, controller, settled });
    return { receipt: { ...receipt }, settled };
  }
  work() {
    const active = [...this.records.values()].map(record => record.receipt).filter(receipt => ["queued", "running", "cancelling"].includes(receipt.state));
    if (!active.length) return null;
    const deadline = active.map(r => r.deadline).sort()[0]!;
    const cancellation_requested_at = active.flatMap(r => r.cancellation_requested_at ? [r.cancellation_requested_at] : []).sort()[0];
    return { deadline, cancellation_requested_at };
  }
  get(id: string): MessageReceipt {
    const record = this.records.get(id);
    if (!record) throw new RuntimeProtocolError(404, "message_not_found");
    return { ...record.receipt };
  }
  cancel(id: string): MessageReceipt {
    const record = this.records.get(id);
    if (!record) throw new RuntimeProtocolError(404, "message_not_found");
    if (record.receipt.state === "queued" || record.receipt.state === "running") {
      record.receipt.state = "cancelling";
      record.receipt.cancellation_requested_at = new Date().toISOString();
      record.controller.abort(new DOMException("Message execution cancelled", "AbortError"));
    }
    return { ...record.receipt };
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
