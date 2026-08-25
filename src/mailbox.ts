/**
 * Activation-local FIFO mailbox. Completed results remain cached for the
 * lifetime of the mailbox so retrying the same message ID does not invoke the
 * receiver again.
 */
export class InMemoryMailbox<Output> {
  private readonly results = new Map<string, Promise<Output>>();
  private tail: Promise<void> = Promise.resolve();

  enqueue(id: string, receive: () => Promise<Output>): Promise<Output> {
    const existing = this.results.get(id);
    if (existing !== undefined) return existing;

    const result = this.tail.then(receive);
    this.results.set(id, result);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
