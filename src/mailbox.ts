/**
 * Activation-local FIFO intake mailbox. Completed results remain cached for the
 * lifetime of the mailbox so retrying the same message ID does not invoke the
 * receiver again.
 */
export type MailboxEvent =
  | Readonly<{
      type: "enqueued";
      messageId: string;
      sequence: number;
      depth: number;
    }>
  | Readonly<{
      type: "deduplicated";
      messageId: string;
    }>
  | Readonly<{
      type: "handling";
      messageId: string;
      sequence: number;
      depth: number;
      queueWaitMicroseconds: number;
    }>
  | Readonly<{
      type: "handled" | "failed";
      messageId: string;
      sequence: number;
      handlingMicroseconds: number;
    }>;

type MailboxObserver = (event: MailboxEvent) => void;

export class InMemoryMailbox<Output> {
  private readonly results = new Map<string, Promise<Output>>();
  private running = false;
  private readonly queue: {
    id: string;
    reject: (error: unknown) => void;
    run: () => Promise<void>;
  }[] = [];
  private pending = 0;
  private nextSequence = 1;

  constructor(
    private readonly observer: MailboxObserver = () => undefined,
    private readonly stateChanged: () => void = () => undefined,
  ) {}

  enqueue(
    id: string,
    receive: (sequence: number) => Promise<Output>,
  ): Promise<Output> {
    const existing = this.results.get(id);
    if (existing !== undefined) {
      this.observe(Object.freeze({ type: "deduplicated", messageId: id }));
      return existing;
    }

    const sequence = this.nextSequence++;
    const enqueuedAt = process.hrtime.bigint();
    this.pending += 1;
    this.stateChanged();
    this.observe(
      Object.freeze({
        type: "enqueued",
        messageId: id,
        sequence,
        depth: this.pending,
      }),
    );
    let resolve!: (value: Output) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<Output>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const run = async () => {
      const startedAt = process.hrtime.bigint();
      this.observe(
        Object.freeze({
          type: "handling",
          messageId: id,
          sequence,
          depth: this.pending,
          queueWaitMicroseconds: microsecondsBetween(enqueuedAt, startedAt),
        }),
      );
      try {
        const output = await receive(sequence);
        this.observe(
          Object.freeze({
            type: "handled",
            messageId: id,
            sequence,
            handlingMicroseconds: microsecondsBetween(
              startedAt,
              process.hrtime.bigint(),
            ),
          }),
        );
        resolve(output);
      } catch (error) {
        this.observe(
          Object.freeze({
            type: "failed",
            messageId: id,
            sequence,
            handlingMicroseconds: microsecondsBetween(
              startedAt,
              process.hrtime.bigint(),
            ),
          }),
        );
        reject(error);
      }
    };
    this.results.set(id, result);
    this.queue.push({ id, reject, run });
    queueMicrotask(() => this.drain());
    void result.then(
      () => this.settle(),
      () => this.settle(),
    );
    return result;
  }

  cancel(id: string, reason: unknown): boolean {
    const index = this.queue.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    entry!.reject(reason);
    return true;
  }

  private drain(): void {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const entry = this.queue.shift()!;
    void entry.run().finally(() => {
      this.running = false;
      this.drain();
    });
  }

  get isIdle(): boolean {
    return this.pending === 0;
  }

  private settle(): void {
    this.pending -= 1;
    this.stateChanged();
  }

  private observe(event: MailboxEvent): void {
    try {
      this.observer(event);
    } catch {
      // Telemetry must never affect message delivery.
    }
  }
}

function microsecondsBetween(start: bigint, end: bigint): number {
  return Number((end - start) / 1_000n);
}
