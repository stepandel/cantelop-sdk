export interface RuntimeQuiescenceSnapshot {
  readonly generation: number;
}

interface QuiescenceWaiter {
  readonly minimumGeneration: number;
  readonly resolve: (snapshot: RuntimeQuiescenceSnapshot) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

/** Tracks only SDK-managed actor work; it has no Sandbox lifecycle policy. */
export class RuntimeQuiescence {
  private currentGeneration = 0;
  private readonly messageGenerations = new Map<string, number>();
  private readonly waiters = new Set<QuiescenceWaiter>();

  constructor(private readonly idle: () => boolean) {}

  get generation(): number {
    return this.currentGeneration;
  }

  get quiescent(): boolean {
    return this.idle();
  }

  observeMessage(id: string): number {
    const existing = this.messageGenerations.get(id);
    if (existing !== undefined) return existing;
    this.currentGeneration += 1;
    this.messageGenerations.set(id, this.currentGeneration);
    return this.currentGeneration;
  }

  changed(): void {
    if (!this.quiescent) return;
    for (const waiter of [...this.waiters]) {
      if (this.currentGeneration < waiter.minimumGeneration) continue;
      this.finish(waiter);
      waiter.resolve(Object.freeze({ generation: this.currentGeneration }));
    }
  }

  waitForQuiescence(
    minimumGeneration: number,
    signal?: AbortSignal,
  ): Promise<RuntimeQuiescenceSnapshot> {
    if (!Number.isSafeInteger(minimumGeneration) || minimumGeneration < 0) {
      return Promise.reject(new TypeError("Minimum runtime generation must be a non-negative integer"));
    }
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.currentGeneration >= minimumGeneration && this.quiescent) {
      return Promise.resolve(Object.freeze({ generation: this.currentGeneration }));
    }

    return new Promise((resolve, reject) => {
      const waiter: QuiescenceWaiter = {
        minimumGeneration,
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          this.finish(waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }

  private finish(waiter: QuiescenceWaiter): void {
    this.waiters.delete(waiter);
    if (waiter.signal !== undefined && waiter.abort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Runtime quiescence wait cancelled", "AbortError");
}
