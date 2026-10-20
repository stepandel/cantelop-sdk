import { abortReason } from "./shared.js";

export interface CursorBufferLimits {
  readonly maxPending: number;
  readonly maxPendingBytes: number;
  readonly maxBatch: number;
}

export interface CursorBufferMetadata {
  readonly acknowledged: number;
  readonly earliest: number;
  readonly latest: number;
}

interface Entry<T> {
  readonly cursor: number;
  readonly value: T;
  readonly bytes: number;
  readonly settle: () => void;
}

/**
 * A bounded, cursor-addressed handoff from runtime code to a platform poller.
 * Entries keep contiguous cursors and leave only from the head, on
 * acknowledgment, which settles their producer.
 */
export class CursorBuffer<T> {
  private readonly entries: Entry<T>[] = [];
  private readonly readers = new Set<() => void>();
  private readonly capacityWaiters = new Set<() => void>();
  private nextCursor = 1;
  private acknowledged = 0;
  private delivered = 0;
  private pendingBytes = 0;

  /** @param label Names this buffer in validation and cancellation errors. */
  constructor(private readonly limits: CursorBufferLimits, private readonly label: string) {}

  hasCapacity(bytes: number): boolean {
    return this.entries.length < this.limits.maxPending && this.pendingBytes + bytes <= this.limits.maxPendingBytes;
  }

  async waitForCapacity(bytes: number, signal?: AbortSignal): Promise<void> {
    while (!this.hasCapacity(bytes)) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.capacityWaiters.delete(ready);
          signal?.removeEventListener("abort", abort);
        };
        const ready = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal!.reason); };
        this.capacityWaiters.add(ready);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }

  /** Appends without a capacity check; callers check or wait for capacity first. */
  append(make: (cursor: number) => T, bytes: number, settle: () => void = () => undefined): void {
    const cursor = this.nextCursor++;
    this.entries.push({ cursor, value: make(cursor), bytes, settle });
    this.pendingBytes += bytes;
    for (const wake of [...this.readers]) wake();
  }

  async read(after: number, signal?: AbortSignal, wait = true, acknowledge = true): Promise<readonly T[]> {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError(`${this.label} cursor must be a non-negative integer`);
    }
    if (after > this.nextCursor - 1) throw new RangeError("cursor_ahead");
    if (after < this.acknowledged) throw new RangeError("cursor_expired");
    if (acknowledge) this.acknowledge(after);
    while (true) {
      if (signal?.aborted) throw abortReason(signal, `${this.label} read cancelled`);
      const first = this.entries[0];
      // Cursors are contiguous, so the first unread entry is found by offset.
      const start = first === undefined ? 0 : Math.max(0, after + 1 - first.cursor);
      const available = this.entries.slice(start, start + this.limits.maxBatch);
      if (available.length > 0) {
        this.delivered = Math.max(this.delivered, available.at(-1)!.cursor);
        return available.map(entry => entry.value);
      }
      if (!wait) return [];
      await this.waitForEntry(signal);
    }
  }

  metadata(): CursorBufferMetadata {
    return { acknowledged: this.acknowledged, earliest: this.entries[0]?.cursor ?? this.nextCursor, latest: this.nextCursor - 1 };
  }

  acknowledge(after: number): void {
    if (!Number.isSafeInteger(after) || after < 0 || after > this.delivered) throw new RangeError("invalid_acknowledgment");
    this.acknowledged = Math.max(this.acknowledged, after);
    let removed = false;
    while (this.entries[0] !== undefined && this.entries[0].cursor <= after) {
      const entry = this.entries.shift()!;
      this.pendingBytes -= entry.bytes;
      entry.settle();
      removed = true;
    }
    if (removed) {
      for (const wake of this.capacityWaiters) wake();
      this.capacityWaiters.clear();
    }
  }

  private waitForEntry(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const ready = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(abortReason(signal!, `${this.label} read cancelled`)); };
      const cleanup = () => {
        this.readers.delete(ready);
        signal?.removeEventListener("abort", abort);
      };
      this.readers.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

/** JSON-encodes a value, rejecting values JSON cannot represent. */
export function encodeJSON(value: unknown, error: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(error);
  }
  if (encoded === undefined) throw new TypeError(error);
  return encoded;
}
