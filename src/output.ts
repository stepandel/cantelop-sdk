import { CursorBuffer, encodeJSON, type CursorBufferMetadata } from "./cursor-buffer.js";

const MAX_EVENT_BYTES = 64 * 1024;

export interface BufferedOutputEvent {
  readonly cursor: number;
  readonly messageId: string;
  readonly event: unknown;
  readonly view?: unknown;
}

/** Activation-local handoff from Session behaviour to the platform collector. */
export class SessionOutputBuffer {
  private readonly buffer = new CursorBuffer<BufferedOutputEvent>(
    { maxPending: 256, maxPendingBytes: 1024 * 1024, maxBatch: 64 },
    "Session output",
  );

  /** Resolves once the platform acknowledges the event; waits while the buffer is full. */
  async publish(messageId: string, event: unknown, signal?: AbortSignal, projection = false): Promise<void> {
    const encoded = encodeJSON(event, "Session output event must be JSON serializable");
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_EVENT_BYTES) {
      throw new TypeError(`Session output event exceeds ${MAX_EVENT_BYTES} bytes`);
    }
    // Other publishers may take capacity before this continuation resumes.
    // Recheck and append without yielding so the buffer stays bounded.
    while (!this.buffer.hasCapacity(bytes)) await this.buffer.waitForCapacity(bytes, signal);
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const value: unknown = JSON.parse(encoded);
      this.buffer.append(cursor => Object.freeze({
        cursor,
        messageId,
        event: projection ? null : value,
        ...(projection ? { view: value } : {}),
      }), bytes, () => { signal?.removeEventListener("abort", abort); resolve(); });
    });
  }

  read(after: number, signal?: AbortSignal, wait = true, acknowledge = true): Promise<readonly BufferedOutputEvent[]> {
    return this.buffer.read(after, signal, wait, acknowledge);
  }

  metadata(): CursorBufferMetadata { return this.buffer.metadata(); }

  acknowledge(after: number): void { this.buffer.acknowledge(after); }
}
