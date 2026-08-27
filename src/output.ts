const MAX_PENDING_EVENTS = 256;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_BATCH_EVENTS = 64;

export interface BufferedOutputEvent {
  readonly cursor: number;
  readonly messageId: string;
  readonly event: unknown;
}

interface PendingOutputEvent extends BufferedOutputEvent {
  readonly bytes: number;
  delivered: boolean;
  readonly resolve: () => void;
}

/** Activation-local handoff from Session behaviour to the platform collector. */
export class SessionOutputBuffer {
  private readonly events: PendingOutputEvent[] = [];
  private readonly readers = new Set<() => void>();
  private readonly capacityWaiters = new Set<() => void>();
  private nextCursor = 1;
  private pendingBytes = 0;

  async publish(messageId: string, event: unknown): Promise<void> {
    const encoded = encodeEvent(event);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_EVENT_BYTES) {
      throw new TypeError(`Session output event exceeds ${MAX_EVENT_BYTES} bytes`);
    }
    while (
      this.events.length >= MAX_PENDING_EVENTS ||
      this.pendingBytes + bytes > MAX_PENDING_BYTES
    ) {
      await new Promise<void>((resolve) => this.capacityWaiters.add(resolve));
    }

    return new Promise<void>((resolve) => {
      this.events.push({
        cursor: this.nextCursor++,
        messageId,
        event: JSON.parse(encoded) as unknown,
        bytes,
        delivered: false,
        resolve,
      });
      this.pendingBytes += bytes;
      this.wakeReaders();
    });
  }

  async read(after: number, signal?: AbortSignal): Promise<readonly BufferedOutputEvent[]> {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new TypeError("Session output cursor must be a non-negative integer");
    }
    this.acknowledge(after);
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const available = this.events
        .filter((event) => event.cursor > after)
        .slice(0, MAX_BATCH_EVENTS);
      if (available.length > 0) {
        for (const event of available) {
          if (!event.delivered) {
            event.delivered = true;
            event.resolve();
          }
        }
        return available.map(({ cursor, messageId, event }) =>
          Object.freeze({ cursor, messageId, event })
        );
      }
      await this.waitForEvent(signal);
    }
  }

  private acknowledge(after: number): void {
    let removed = false;
    while (this.events[0] !== undefined && this.events[0].cursor <= after) {
      const event = this.events.shift()!;
      this.pendingBytes -= event.bytes;
      removed = true;
    }
    if (removed) this.wakeCapacityWaiters();
  }

  private waitForEvent(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(abortReason(signal!));
      };
      const cleanup = () => {
        this.readers.delete(ready);
        signal?.removeEventListener("abort", abort);
      };
      this.readers.add(ready);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private wakeReaders(): void {
    for (const resolve of [...this.readers]) resolve();
  }

  private wakeCapacityWaiters(): void {
    for (const resolve of this.capacityWaiters) resolve();
    this.capacityWaiters.clear();
  }
}

function encodeEvent(event: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(event);
  } catch {
    throw new TypeError("Session output event must be JSON serializable");
  }
  if (encoded === undefined) {
    throw new TypeError("Session output event must be JSON serializable");
  }
  return encoded;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Session output read cancelled", "AbortError");
}
