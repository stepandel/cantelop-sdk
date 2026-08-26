/**
 * Activation-local FIFO mailbox. Completed results remain cached for the
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
  private readonly idleWaiters = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private nextSequence = 1;

  constructor(
    private readonly observer: MailboxObserver = () => undefined,
    private readonly stateChanged: () => void = () => undefined,
  ) {}

  enqueue(id: string, receive: (sequence: number) => Promise<Output>): Promise<Output> {
    const existing = this.results.get(id);
    if (existing !== undefined) {
      this.observe(Object.freeze({ type: "deduplicated", messageId: id }));
      return existing;
    }

    const sequence = this.nextSequence++;
    const enqueuedAt = process.hrtime.bigint();
    this.pending += 1;
    this.stateChanged();
    this.observe(Object.freeze({
      type: "enqueued",
      messageId: id,
      sequence,
      depth: this.pending,
    }));
    const result = this.tail.then(async () => {
      const startedAt = process.hrtime.bigint();
      this.observe(Object.freeze({
        type: "handling",
        messageId: id,
        sequence,
        depth: this.pending,
        queueWaitMicroseconds: microsecondsBetween(enqueuedAt, startedAt),
      }));
      try {
        const output = await receive(sequence);
        this.observe(Object.freeze({
          type: "handled",
          messageId: id,
          sequence,
          handlingMicroseconds: microsecondsBetween(startedAt, process.hrtime.bigint()),
        }));
        return output;
      } catch (error) {
        this.observe(Object.freeze({
          type: "failed",
          messageId: id,
          sequence,
          handlingMicroseconds: microsecondsBetween(startedAt, process.hrtime.bigint()),
        }));
        throw error;
      }
    });
    this.results.set(id, result);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    void result.then(
      () => this.settle(),
      () => this.settle(),
    );
    return result;
  }

  get isIdle(): boolean {
    return this.pending === 0;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private settle(): void {
    this.pending -= 1;
    this.stateChanged();
    if (!this.isIdle) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
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
