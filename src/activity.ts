import { randomUUID } from "node:crypto";
import type {
  SessionActivityContext,
  SessionActivityFunction,
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
  messageBytes: number;
  settled: boolean;
  deadline: number;
  cancelledAt?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class InMemoryActivity<Message, Event> {
  private current: ActiveActivity<Message> | undefined;
  private readonly flushing = new Set<ActiveActivity<Message>>();

  constructor(
    private readonly sendMessage: (payload: Message) => void | Promise<void>,
    private readonly sendOutput: (messageId: string, event: Event, signal: AbortSignal) => Promise<void>,
    private readonly stateChanged: () => void = () => undefined,
    private readonly commitView: (messageId:string,state:unknown,signal:AbortSignal)=>Promise<void> = async () => {throw new Error("Session view handoff unavailable");},
  ) { }

  private readonly waiters = new Set<()=>void>();

  private changed():void {this.stateChanged();for(const wake of [...this.waiters])wake();}

  async waitForIdle(signal?:AbortSignal,owner?:string):Promise<void>{
    while(this.current!==undefined&&(owner===undefined||this.current.messageId===owner)){
      signal?.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{const cleanup=()=>{this.waiters.delete(wake);signal?.removeEventListener("abort",abort)};const wake=()=>{cleanup();resolve()};const abort=()=>{cleanup();reject(signal!.reason)};this.waiters.add(wake);signal?.addEventListener("abort",abort,{once:true})});
    }
    signal?.throwIfAborted();
  }

  get active(): boolean {
    return this.current !== undefined;
  }

  start(
    messageId: string,
    work: SessionActivityFunction<Message, Event>,
    policy: { timeoutMs?: number; } = {},
    observe: (event: ActivityLifecycle) => void = () => undefined,
  ): void {
    if (this.active) {
      throw new Error("Session runtime activity is already active");
    }

    const timeout = policy.timeoutMs ?? 1_800_000;
    validateTimeout(timeout);
    const controller = new AbortController();
    const activity: ActiveActivity<Message> = { id: randomUUID(), messageId, observe, controller, messages: [], messageBytes: 0, settled: false, deadline: Date.now() + timeout };
    activity.timer = setTimeout(() => this.cancel(), timeout);
    activity.timer.unref();
    this.current = activity;
    this.report(activity, "started");
    this.changed();
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
      view: Object.freeze({commit:async(state:unknown)=>{if(activity.settled)throw new Error("Session activity settled");await this.commitView(messageId,state,controller.signal);}}),
      send: (payload: Message) => {
        if (activity.settled) {
          throw new Error("Session runtime activity has already settled");
        }
        const size = Buffer.byteLength(JSON.stringify(payload));
        if (activity.messages.length >= 256 || activity.messageBytes + size > 8 * 1024 * 1024) throw new Error("activity mailbox capacity");
        activity.messageBytes += size;
        activity.messages.push(payload);
      },
    });
    const result = Promise.resolve().then(() => work(context));
    void result.then(
      () => this.settle(activity, false),
      () => this.settle(activity, true),
    ).catch(() => { /* Failed admission retains activity ownership for bounded supervision. */ });
  }

  cancel(reason?: unknown): boolean {
    const target = this.current ?? [...this.flushing][0];
    if (target === undefined) return false;
    if (target.cancelledAt === undefined) {
      target.cancelledAt = new Date().toISOString();
      this.report(target, "cancellation_requested");
      this.changed();
    }
    target.controller.abort(
      reason ?? new DOMException("Session runtime activity cancelled", "AbortError"),
    );
    return true;
  }

  cancelMessage(id:string):boolean {
    const target=this.current ?? [...this.flushing][0];
    return target?.messageId===id && this.cancel();
  }

  extend(timeoutMs: number): void {
    validateTimeout(timeoutMs);
    const activity = this.current;
    if (!activity || activity.controller.signal.aborted) throw new Error("activity is not extendable");
    activity.deadline = Math.max(activity.deadline, Date.now() + timeoutMs);
    clearTimeout(activity.timer); activity.timer = setTimeout(() => this.cancel(), activity.deadline - Date.now()); activity.timer.unref(); this.changed();
  }

  snapshot() { const target = [this.current, ...this.flushing].filter((value): value is ActiveActivity<Message> => value !== undefined).sort((a,b)=>a.deadline-b.deadline)[0]; return target ? {id:target.id,deadline:new Date(target.deadline).toISOString(),cancellation_requested_at:target.cancelledAt}:null; }

  get isIdle(): boolean {
    return !this.active && this.flushing.size === 0;
  }

  private report(activity: ActiveActivity<Message>, outcome: ActivityLifecycle["outcome"]): void {
    // Observability is best effort and must never change activity scheduling.
    try { activity.observe({ activityId: activity.id, messageId: activity.messageId, outcome }); } catch { }
  }

  private async settle(activity: ActiveActivity<Message>, failed: boolean): Promise<void> {
    if (this.current !== activity) return;
    activity.settled = true;
    clearTimeout(activity.timer);
    // The activity itself has ended. A separate flush keeps quiescence busy
    // while allowing admitted completion messages to start a new activity.
    this.flushing.add(activity);
    this.current = undefined;
    this.changed();
    for (const payload of activity.messages) {
      try {
        const admitted = this.sendMessage(payload);
        if (admitted !== undefined) await admitted;
      } catch (error) { console.error("Activity completion message rejected", error); }
    }
    this.flushing.delete(activity);
    this.report(activity, activity.controller.signal.aborted ? "cancelled" : failed ? "failed" : "completed");
    this.changed();
  }
}

function validateTimeout(value: number) { if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw new Error("activity timeout must be between 1ms and 24h"); }
