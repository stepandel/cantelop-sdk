import { randomUUID } from "node:crypto";
import type {
  SessionActivityContext,
  SessionActivityFunction,
  SessionActivityOptions,
  SessionActivityQueueOptions,
  SessionOutput,
} from "./session.js";

export interface ActivityLifecycle {
  readonly activityId: string;
  readonly messageId: string;
  readonly outcome: "started" | "completed" | "failed" | "cancellation_requested" | "cancelled";
}

interface ActiveActivity<Message> {
  readonly messageId: string;
  readonly observe: (event: ActivityLifecycle) => void;
  readonly id: string;
  readonly controller: AbortController;
  readonly messages: Message[];
  readonly onSteer: ((message: Message) => void | Promise<void>) | undefined;
  steering: Promise<void>;
  steeringCount: number;
  messageBytes: number;
  settled: boolean;
  deadline: number;
  cancelledAt?: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface QueuedActivity<Message, Event> {
  readonly messageId: string;
  readonly work: SessionActivityFunction<Message, Event>;
  readonly options: SessionActivityQueueOptions<Message>;
  readonly observe: (event: ActivityLifecycle) => void;
}

export type ActivityCancellation = "cancelled" | "requested" | false;

/** One activity slot per runtime incarnation, shared by immediate and queued work. */
export class InMemoryActivity<Message, Event> {
  private current: ActiveActivity<Message> | undefined;
  private readonly flushing = new Set<ActiveActivity<Message>>();
  private readonly queued: QueuedActivity<Message, Event>[] = [];
  private readonly cancellations = new Map<string, Exclude<ActivityCancellation, false>>();

  constructor(
    private readonly sendMessage: (payload: Message) => void | Promise<void>,
    private readonly sendOutput: (messageId: string, event: Event, signal: AbortSignal) => Promise<void>,
    private readonly stateChanged: () => void = () => undefined,
    private readonly commitView: (messageId: string, state: unknown, signal: AbortSignal) => Promise<void> = async () => {
      throw new Error("Session view handoff unavailable");
    },
  ) {}

  get active(): boolean { return this.current !== undefined; }

  start(
    messageId: string,
    work: SessionActivityFunction<Message, Event>,
    options: SessionActivityOptions<Message> = {},
    observe: (event: ActivityLifecycle) => void = () => undefined,
  ): void {
    if (this.active || this.queued.length > 0) throw new Error("Session runtime activity is already active or queued");
    this.validate(work, options);
    this.launch(messageId, work, options, observe);
  }

  queue(
    messageId: string,
    work: SessionActivityFunction<Message, Event>,
    options: SessionActivityQueueOptions<Message> = {},
    observe: (event: ActivityLifecycle) => void = () => undefined,
  ): void {
    this.validate(work, options);
    if (options.priority !== undefined && typeof options.priority !== "boolean") throw new TypeError("Invalid activity priority");
    if (this.queued.length >= 256) throw new Error("activity queue capacity");
    this.queued.push({ messageId, work, options: { ...options }, observe });
    this.stateChanged();
    // Intake can enqueue several activities before any user work begins.
    queueMicrotask(() => this.drain());
  }

  async steer(message: Message): Promise<void> {
    const target = this.current;
    if (!target || target.settled || target.controller.signal.aborted) throw new Error("No steerable activity is active");
    if (!target.onSteer) throw new Error("Active activity has no steering adapter");
    if (target.steeringCount >= 256) throw new Error("activity steering capacity");
    target.steeringCount++;
    const delivery = target.steering.then(async () => {
      target.controller.signal.throwIfAborted();
      await target.onSteer!(message);
    });
    // Adapter failure belongs to the steering submission, not to later steering input.
    target.steering = delivery.catch(() => undefined);
    try { await delivery; } finally { target.steeringCount--; }
  }

  cancel(reason?: unknown): boolean {
    const target = this.current ?? [...this.flushing][0];
    return target ? this.abort(target, reason) : false;
  }

  cancelMessage(id: string): ActivityCancellation {
    let removed = false;
    for (let index = this.queued.length - 1; index >= 0; index--) {
      if (this.queued[index]!.messageId === id) {
        this.queued.splice(index, 1);
        removed = true;
      }
    }
    const targets = [this.current, ...this.flushing].filter(
      (target): target is ActiveActivity<Message> => target?.messageId === id,
    );
    for (const target of targets) this.abort(target);
    const result = targets.length > 0 ? "requested" : removed ? "cancelled" : this.cancellations.get(id) ?? false;
    if (result) {
      this.cancellations.set(id, result);
      if (this.cancellations.size > 4096) this.cancellations.delete(this.cancellations.keys().next().value!);
      this.stateChanged();
    }
    return result;
  }

  extend(timeoutMs: number): void {
    validateTimeout(timeoutMs);
    const target = this.current;
    if (!target || target.settled || target.controller.signal.aborted) throw new Error("activity is not extendable");
    target.deadline = Math.max(target.deadline, Date.now() + timeoutMs);
    clearTimeout(target.timer);
    target.timer = setTimeout(() => this.abort(target), target.deadline - Date.now());
    target.timer.unref();
    this.stateChanged();
  }

  snapshot() {
    const target = [this.current, ...this.flushing]
      .filter((value): value is ActiveActivity<Message> => value !== undefined)
      .sort((a, b) => a.deadline - b.deadline)[0];
    return target ? { id: target.id, deadline: new Date(target.deadline).toISOString(), cancellation_requested_at: target.cancelledAt } : null;
  }

  get isIdle(): boolean { return !this.active && this.queued.length === 0 && this.flushing.size === 0; }

  private validate(work: SessionActivityFunction<Message, Event>, options: SessionActivityOptions<Message>): void {
    if (typeof work !== "function") throw new TypeError("Activity work must be a function");
    validateTimeout(options.timeoutMs ?? 1_800_000);
    if (options.onSteer !== undefined && typeof options.onSteer !== "function") throw new TypeError("Activity onSteer must be a function");
  }

  private drain(): void {
    if (this.active || this.queued.length === 0) return;
    const priority = this.queued.findIndex(entry => entry.options.priority);
    const entry = this.queued.splice(priority < 0 ? 0 : priority, 1)[0]!;
    this.launch(entry.messageId, entry.work, entry.options, entry.observe);
  }

  private launch(
    messageId: string,
    work: SessionActivityFunction<Message, Event>,
    options: SessionActivityOptions<Message>,
    observe: (event: ActivityLifecycle) => void,
  ): void {
    const timeout = options.timeoutMs ?? 1_800_000;
    const controller = new AbortController();
    const activity: ActiveActivity<Message> = {
      id: randomUUID(), messageId, observe, controller, messages: [], messageBytes: 0,
      settled: false, deadline: Date.now() + timeout, onSteer: options.onSteer,
      steering: Promise.resolve(), steeringCount: 0,
    };
    activity.timer = setTimeout(() => this.abort(activity), timeout);
    activity.timer.unref();
    this.current = activity;
    this.report(activity, "started");
    this.stateChanged();
    const output: SessionOutput<Event> = Object.freeze({
      send: async (event: Event) => {
        if (activity.settled) throw new Error("Session runtime activity has already settled");
        await this.sendOutput(messageId, event, controller.signal);
      },
    });
    const context: SessionActivityContext<Message, Event> = Object.freeze({
      signal: controller.signal, output,
      view: Object.freeze({ commit: async (state: unknown) => {
        if (activity.settled) throw new Error("Session activity settled");
        await this.commitView(messageId, state, controller.signal);
      } }),
      send: (payload: Message) => {
        if (activity.settled) throw new Error("Session runtime activity has already settled");
        const size = Buffer.byteLength(JSON.stringify(payload));
        if (activity.messages.length >= 256 || activity.messageBytes + size > 8 * 1024 * 1024) throw new Error("activity mailbox capacity");
        activity.messageBytes += size;
        activity.messages.push(payload);
      },
    });
    const result = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(context); });
    void result.then(
      () => this.settle(activity, false),
      () => this.settle(activity, true),
    ).catch(() => { /* Failed admission retains activity ownership for bounded supervision. */ });
  }

  private abort(target: ActiveActivity<Message>, reason?: unknown): boolean {
    if (target.cancelledAt === undefined) {
      target.cancelledAt = new Date().toISOString();
      this.report(target, "cancellation_requested");
      this.stateChanged();
    }
    target.controller.abort(reason ?? new DOMException("Session runtime activity cancelled", "AbortError"));
    return true;
  }

  private report(activity: ActiveActivity<Message>, outcome: ActivityLifecycle["outcome"]): void {
    try { activity.observe({ activityId: activity.id, messageId: activity.messageId, outcome }); } catch { /* Best effort telemetry. */ }
  }

  private async settle(activity: ActiveActivity<Message>, failed: boolean): Promise<void> {
    if (this.current !== activity) return;
    activity.settled = true;
    // Do not hand the slot to another harness while a steering adapter is still running.
    await activity.steering;
    clearTimeout(activity.timer);
    this.flushing.add(activity);
    this.current = undefined;
    this.drain();
    this.stateChanged();
    for (const payload of activity.messages) {
      try {
        const admitted = this.sendMessage(payload);
        if (admitted !== undefined) await admitted;
      } catch (error) { console.error("Activity completion message rejected", error); }
    }
    this.flushing.delete(activity);
    this.report(activity, activity.controller.signal.aborted ? "cancelled" : failed ? "failed" : "completed");
    this.stateChanged();
  }
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new Error("activity timeout must be between 1ms and 24h");
}
