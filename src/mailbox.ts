/**
 * Activation-local FIFO mailbox. Completed results remain cached for the
 * lifetime of the mailbox so retrying the same message ID does not invoke the
 * receiver again.
 */
export class InMemoryMailbox<Output> {
  private readonly results = new Map<string, Promise<Output>>();
  private readonly idleWaiters = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private nextSequence = 1;

  enqueue(id: string, receive: (sequence: number) => Promise<Output>): Promise<Output> {
    const existing = this.results.get(id);
    if (existing !== undefined) return existing;

    const sequence = this.nextSequence++;
    this.pending += 1;
    const result = this.tail.then(() => receive(sequence));
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
    if (!this.isIdle) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
