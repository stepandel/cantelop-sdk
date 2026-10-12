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

const PROVIDER_HOOK_GRACE_MS = 30_000;

/** Completion messages buffered by one unit of work and admitted after it settles. */
export class FollowupMessages<Message> {
  private readonly messages: Message[] = [];
  private bytes = 0;

  push(payload: Message): void {
    const size = Buffer.byteLength(JSON.stringify(payload) ?? "");
    if (this.messages.length >= 256 || this.bytes + size > 8 * 1024 * 1024) throw new Error("activity mailbox capacity");
    this.bytes += size;
    this.messages.push(payload);
  }

  async flush(send: (payload: Message) => void | Promise<void>, label: string): Promise<void> {
    for (const payload of this.messages.splice(0)) {
      try { await send(payload); } catch (error) { console.error(label, error); }
    }
  }
}

interface ActiveActivity<Message> {
  readonly messageId: string;
  readonly observe: (event: ActivityLifecycle) => void;
  readonly id: string;
  readonly controller: AbortController;
  readonly messages: FollowupMessages<Message>;
  readonly onSteer: ((message: Message) => void | Promise<void>) | undefined;
  readonly onCancel: (() => void | Promise<void>) | undefined;
  cancellation: Promise<void>;
  steering: Promise<void>;
  steeringCount: number;
  settled: boolean;
  deadline: number;
  cancelledAt?: string;
  timer?: ReturnType<typeof setTimeout>;
}

interface QueuedActivity<Message, Event, View> {
  readonly messageId: string;
  readonly work: SessionActivityFunction<Message, Event, View>;
  readonly options: SessionActivityQueueOptions<Message>;
  readonly observe: (event: ActivityLifecycle) => void;
  readonly reject: (reason: unknown) => void;
}

/** One activity slot per runtime incarnation, shared by immediate and queued work. */
export class InMemoryActivity<Message, Event, View = unknown> {
  private current: ActiveActivity<Message> | undefined;
  private readonly flushing = new Set<ActiveActivity<Message>>();
  private readonly queued: QueuedActivity<Message, Event, View>[] = [];

  constructor(
    private readonly sendMessage: (payload: Message) => void | Promise<void>,
    private readonly sendOutput: (messageId: string, event: Event, signal: AbortSignal) => Promise<void>,
    private readonly stateChanged: () => void = () => undefined,
    private readonly commitView: (messageId: string, state: View, signal: AbortSignal) => Promise<void> = async () => {
      throw new Error("Session view handoff unavailable");
    },
  ) {}

  get active(): boolean { return this.current !== undefined; }

  start(
    messageId: string,
    work: SessionActivityFunction<Message, Event, View>,
    options: SessionActivityOptions<Message> = {},
    observe: (event: ActivityLifecycle) => void = () => undefined,
  ): void {
    if (this.active || this.queued.length > 0) throw new Error("Session runtime activity is already active or queued");
    this.validate(work, options);
    this.launch(messageId, work, options, observe);
  }

  queue(
    messageId: string,
    work: SessionActivityFunction<Message, Event, View>,
    options: SessionActivityQueueOptions<Message> = {},
    observe: (event: ActivityLifecycle) => void = () => undefined,
  ): Promise<void> {
    this.validate(work, options);
    if (options.priority !== undefined && typeof options.priority !== "boolean") throw new TypeError("Invalid activity priority");
    if (this.queued.length >= 256) throw new Error("activity queue capacity");
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Dispatch does not wait for work; request callers may observe completion.
    void completion.catch(() => undefined);
    this.queued.push({ messageId, work: async context => {
      try { await work(context); context.signal.throwIfAborted(); resolve(); }
      catch (error) { reject(error); throw error; }
    }, options: { ...options }, observe, reject });
    this.stateChanged();
    // Intake can enqueue several activities before any user work begins.
    queueMicrotask(() => this.drain());
    return completion;
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

  cancel(reason?: unknown, activityId?: string): boolean {
    const target = activityId === undefined ? this.current
      : [this.current, ...this.flushing].find(value => value?.id === activityId);
    return target ? this.abort(target, reason) : false;
  }

  cancelMessage(id: string): void {
    let removed = false;
    for (let index = this.queued.length - 1; index >= 0; index--) {
      if (this.queued[index]!.messageId === id) {
        this.queued[index]!.reject(new DOMException("Queued work cancelled", "AbortError"));
        this.queued.splice(index, 1);
        removed = true;
      }
    }
    const targets = [this.current, ...this.flushing].filter(
      (target): target is ActiveActivity<Message> => target?.messageId === id,
    );
    for (const target of targets) this.abort(target);
    if (removed || targets.length > 0) this.stateChanged();
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

  private validate(work: SessionActivityFunction<Message, Event, View>, options: SessionActivityOptions<Message>): void {
    if (typeof work !== "function") throw new TypeError("Activity work must be a function");
    validateTimeout(options.timeoutMs ?? 1_800_000);
    if (options.onCancel !== undefined && typeof options.onCancel !== "function") throw new TypeError("Activity onCancel must be a function");
    if (options.onSteer !== undefined && typeof options.onSteer !== "function") throw new TypeError("Activity onSteer must be a function");
  }

  private drain(): void {
    if (this.active || this.queued.length === 0) return;
    const priority = this.queued.findIndex(entry => entry.options.priority);
    const entry = this.queued.splice(priority < 0 ? 0 : priority, 1)[0]!;
    this.launch(entry.messageId, entry.work, entry.options, entry.observe, entry.reject);
  }

  private launch(
    messageId: string,
    work: SessionActivityFunction<Message, Event, View>,
    options: SessionActivityOptions<Message>,
    observe: (event: ActivityLifecycle) => void,
    reject?: (reason: unknown) => void,
  ): void {
    const timeout = options.timeoutMs ?? 1_800_000;
    const controller = new AbortController();
    const activity: ActiveActivity<Message> = {
      id: randomUUID(), messageId, observe, controller, messages: new FollowupMessages<Message>(),
      settled: false, deadline: Date.now() + timeout, onSteer: options.onSteer,
      onCancel: options.onCancel, cancellation: Promise.resolve(),
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
    const context: SessionActivityContext<Message, Event, View> = Object.freeze({
      signal: controller.signal, output,
      view: Object.freeze({ commit: async (state: View) => {
        if (activity.settled) throw new Error("Session activity settled");
        await this.commitView(messageId, state, controller.signal);
      } }),
      send: (payload: Message) => {
        if (activity.settled) throw new Error("Session runtime activity has already settled");
        activity.messages.push(payload);
      },
    });
    const result = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(context); });
    void result.then(
      () => this.settle(activity, false),
      error => { reject?.(error); return this.settle(activity, true); },
    ).catch(() => { /* Failed admission retains activity ownership for bounded supervision. */ });
  }

  private abort(target: ActiveActivity<Message>, reason?: unknown): boolean {
    if (target.cancelledAt === undefined) {
      target.cancelledAt = new Date().toISOString();
      // Start the provider hook once, while this activity still owns the slot.
      try {
        // Flushing has released the provider slot; its hook could interrupt the next run.
        target.cancellation = Promise.resolve(this.flushing.has(target) ? undefined : target.onCancel?.());
      }
      catch (error) { target.cancellation = Promise.reject(error); }
      // Provider failure must not prevent signalling or release the slot early.
      target.cancellation = target.cancellation.catch(() => { this.report(target, "failed"); });
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
    // Do not hand the slot to another harness while a steering adapter is still running,
    // but a wedged adapter or cancel hook must not hold the slot forever.
    let grace: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([activity.steering, activity.cancellation]),
      new Promise<void>(resolve => { grace = setTimeout(resolve, PROVIDER_HOOK_GRACE_MS); grace.unref(); }),
    ]);
    clearTimeout(grace);
    clearTimeout(activity.timer);
    this.flushing.add(activity);
    this.current = undefined;
    this.drain();
    this.stateChanged();
    await activity.messages.flush(this.sendMessage, "Activity completion message rejected");
    this.flushing.delete(activity);
    this.report(activity, activity.controller.signal.aborted ? "cancelled" : failed ? "failed" : "completed");
    this.stateChanged();
  }
}

function validateTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new Error("activity timeout must be between 1ms and 24h");
}
