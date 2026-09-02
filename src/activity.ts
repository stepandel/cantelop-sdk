import type {
  SessionActivityContext,
  SessionActivityFunction,
  SessionOutput,
} from "./session.js";

interface ActiveActivity<Message> {
  readonly controller: AbortController;
  readonly messages: Message[];
  settled: boolean;
  deadline: number;
  cancelledAt?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class InMemoryActivity<Message, Event> {
  private current: ActiveActivity<Message> | undefined;

  constructor(
    private readonly sendMessage: (payload: Message) => void,
    private readonly sendOutput: (messageId: string, event: Event) => Promise<void>,
    private readonly stateChanged: () => void = () => undefined,
  ) {}

  get active(): boolean {
    return this.current !== undefined;
  }

  start(
    messageId: string,
    work: SessionActivityFunction<Message, Event>,
  ): void {
    if (this.active) {
      throw new Error("Session runtime activity is already active");
    }

    const controller = new AbortController();
    const activity: ActiveActivity<Message> = { controller, messages: [], settled: false, deadline: Date.now() + 1_800_000 };
    activity.timer = setTimeout(() => this.cancel(), 1_800_000);
    activity.timer.unref();
    this.current = activity;
    this.stateChanged();
    const output: SessionOutput<Event> = Object.freeze({
      send: async (event: Event) => {
        if (activity.settled) {
          throw new Error("Session runtime activity has already settled");
        }
        await this.sendOutput(messageId, event);
      },
    });
    const context: SessionActivityContext<Message, Event> = Object.freeze({
      signal: controller.signal,
      output,
      send: (payload: Message) => {
        if (activity.settled) {
          throw new Error("Session runtime activity has already settled");
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
    this.current.cancelledAt ??= new Date().toISOString();
    this.current.controller.abort(
      reason ?? new DOMException("Session runtime activity cancelled", "AbortError"),
    );
    return true;
  }

  snapshot() { return this.current ? { deadline: new Date(this.current.deadline).toISOString(), cancellation_requested_at: this.current.cancelledAt } : null; }

  get isIdle(): boolean {
    return !this.active;
  }

  private settle(activity: ActiveActivity<Message>): void {
    if (this.current !== activity) return;
    activity.settled = true;
    clearTimeout(activity.timer);
    this.current = undefined;
    for (const payload of activity.messages) this.sendMessage(payload);
    this.stateChanged();
  }
}
