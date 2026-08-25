import type {
  SessionActivity,
  SessionActivityContext,
  SessionActivityFunction,
} from "./session.js";

interface ActiveActivity<Message> {
  readonly controller: AbortController;
  readonly messages: Message[];
}

export class InMemoryActivity<Message> implements SessionActivity<Message> {
  private current: ActiveActivity<Message> | undefined;
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly sendMessage: (payload: Message) => void) {}

  get active(): boolean {
    return this.current !== undefined;
  }

  start(work: SessionActivityFunction<Message>): void {
    if (this.active) {
      throw new Error("Harness activity is already active");
    }

    const controller = new AbortController();
    const activity: ActiveActivity<Message> = { controller, messages: [] };
    this.current = activity;
    const context: SessionActivityContext<Message> = Object.freeze({
      signal: controller.signal,
      send: (payload: Message) => activity.messages.push(payload),
    });
    const result = Promise.resolve().then(() => work(context));
    void result.then(
      () => this.settle(activity),
      () => this.settle(activity),
    );
  }

  cancel(reason?: unknown): boolean {
    if (this.current === undefined) return false;
    this.current.controller.abort(
      reason ?? new DOMException("Harness activity cancelled", "AbortError"),
    );
    return true;
  }

  get isIdle(): boolean {
    return !this.active;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private settle(activity: ActiveActivity<Message>): void {
    if (this.current !== activity) return;
    this.current = undefined;
    for (const payload of activity.messages) this.sendMessage(payload);
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
