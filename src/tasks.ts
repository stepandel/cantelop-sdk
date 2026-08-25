import type {
  HarnessTaskContext,
  HarnessTaskFunction,
  HarnessTasks,
} from "./harness.js";

interface ActiveTask<Message> {
  readonly controller: AbortController;
  readonly messages: Message[];
}

export class InMemoryTasks<Message> implements HarnessTasks<Message> {
  private readonly active = new Map<string, ActiveTask<Message>>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly sendMessage: (payload: Message) => void) {}

  start(id: string, work: HarnessTaskFunction<Message>): void {
    assertTaskID(id);
    if (this.active.has(id)) {
      throw new Error(`Harness task is already active: ${id}`);
    }

    const controller = new AbortController();
    const task: ActiveTask<Message> = { controller, messages: [] };
    this.active.set(id, task);
    const context: HarnessTaskContext<Message> = Object.freeze({
      signal: controller.signal,
      send: (payload: Message) => task.messages.push(payload),
    });
    const result = Promise.resolve().then(() => work(context));
    void result.then(
      () => this.settle(id),
      () => this.settle(id),
    );
  }

  cancel(id: string, reason?: unknown): boolean {
    const task = this.active.get(id);
    if (task === undefined) return false;
    task.controller.abort(
      reason ?? new DOMException("Harness task cancelled", "AbortError"),
    );
    return true;
  }

  has(id: string): boolean {
    return this.active.has(id);
  }

  get isIdle(): boolean {
    return this.active.size === 0;
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private settle(id: string): void {
    const task = this.active.get(id);
    if (task === undefined) return;
    this.active.delete(id);
    for (const payload of task.messages) this.sendMessage(payload);
    if (!this.isIdle) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function assertTaskID(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 128) {
    throw new TypeError("Harness task ID must contain between 1 and 128 characters");
  }
}
