import { randomUUID } from "node:crypto";
import type {
  SessionActivityContext,
  SessionActivityFunction,
  SessionOutput,
} from "./session.js";

interface ActiveActivity<Message> {
 readonly id: string;
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
    private readonly sendOutput: (messageId: string, event: Event, signal: AbortSignal) => Promise<void>,
    private readonly stateChanged: () => void = () => undefined,
  ) {}

  get active(): boolean {
    return this.current !== undefined;
  }

  start(
    messageId: string,
    work: SessionActivityFunction<Message, Event>,
 policy: { timeoutMs?: number } = {},
  ): void {
    if (this.active) {
      throw new Error("Session runtime activity is already active");
    }

    const timeout = policy.timeoutMs ?? 1_800_000;
 validateTimeout(timeout);
 const controller = new AbortController();
    const activity: ActiveActivity<Message> = { id: randomUUID(), controller, messages: [], settled: false, deadline: Date.now() + timeout };
    activity.timer = setTimeout(() => this.cancel(), timeout);
    activity.timer.unref();
    this.current = activity;
    this.stateChanged();
    const output: SessionOutput<Event> = Object.freeze({
      send: async (event: Event) => {
        if (activity.settled) {
          throw new Error("Session runtime activity has already settled");
        }
        await this.sendOutput(messageId, event, controller.signal);
      },
    });
    const context: SessionActivityContext<Message, Event> = Object.freeze({
      signal: controller.signal,
      output,
      send: (payload: Message) => {
        if (activity.settled) {
          throw new Error("Session runtime activity has already settled");
        }
        if (activity.messages.length >= 256) throw new Error("activity mailbox capacity");
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

  extend(timeoutMs: number): void {
 validateTimeout(timeoutMs);
 const activity = this.current;
 if (!activity || activity.controller.signal.aborted) throw new Error("activity is not extendable");
 activity.deadline = Math.max(activity.deadline, Date.now() + timeoutMs);
 clearTimeout(activity.timer); activity.timer = setTimeout(() => this.cancel(), activity.deadline - Date.now()); activity.timer.unref(); this.stateChanged();
 }

 snapshot() { return this.current ? { id: this.current.id, deadline: new Date(this.current.deadline).toISOString(), cancellation_requested_at: this.current.cancelledAt } : null; }

  get isIdle(): boolean {
    return !this.active;
  }

  private settle(activity: ActiveActivity<Message>): void {
    if (this.current !== activity) return;
    activity.settled = true;
    clearTimeout(activity.timer);
    this.current = undefined;
    for (const payload of activity.messages) { try { this.sendMessage(payload); } catch (error) { console.error("Activity completion message rejected", error); } }
    this.stateChanged();
  }
}

function validateTimeout(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new Error("activity timeout must be between 1ms and 24h"); }
