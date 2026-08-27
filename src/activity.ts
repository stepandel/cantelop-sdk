import type {
  SessionActivityContext,
  SessionActivityFunction,
  SessionOutput,
} from "./session.js";

interface ActiveActivity<Message> {
  readonly controller: AbortController;
  readonly messages: Message[];
  settled: boolean;
}

export class InMemoryActivity<Message, Event> {
  private current: ActiveActivity<Message> | undefined;

  constructor(
    private readonly sendMessage: (payload: Message) => void,
    private readonly stateChanged: () => void = () => undefined,
  ) {}

  get active(): boolean {
    return this.current !== undefined;
  }

  start(
    work: SessionActivityFunction<Message, Event>,
    output: SessionOutput<Event>,
  ): void {
    if (this.active) {
      throw new Error("Harness activity is already active");
    }

    const controller = new AbortController();
    const activity: ActiveActivity<Message> = { controller, messages: [], settled: false };
    this.current = activity;
    this.stateChanged();
    const context: SessionActivityContext<Message, Event> = Object.freeze({
      signal: controller.signal,
      output,
      send: (payload: Message) => {
        if (activity.settled) {
          throw new Error("Harness activity has already settled");
        }
        activity.messages.push(payload);
      },
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

  private settle(activity: ActiveActivity<Message>): void {
    if (this.current !== activity) return;
    activity.settled = true;
    this.current = undefined;
    for (const payload of activity.messages) this.sendMessage(payload);
    this.stateChanged();
  }
}
