/// <reference types="node" />
import { AsyncResource } from "node:async_hooks";
import type { Awaitable, SessionHarnessWorkContext } from "../session.js";

type Work<Message, Event, View> = SessionHarnessWorkContext<Message, Event, View>;
interface Entry<Message, Event, Result, View> {
  work: Work<Message, Event, View>;
  priority: boolean;
  execute(work: Work<Message, Event, View>): Awaitable<Result>;
  resolve(result: Result): void;
  reject(error: unknown): void;
  detach(): void;
}

/** Serialize provider turns and retain cleanup ownership. */
export class TurnQueue<Message, Event, Result = void, View = unknown> {
  private readonly waiting: Entry<Message, Event, Result, View>[] = [];
  private current: { controller: AbortController } | undefined;
  constructor(
    private readonly execute: (message: Message, work: Work<Message, Event, View>) => Awaitable<Result>,
    private readonly lifetime?: AbortSignal,
  ) {}
  get active(): boolean { return this.current !== undefined; }

  enqueue(message: Message, work: Work<Message, Event, View>, priority = false): Promise<Result> {
    work.signal.throwIfAborted();
    this.lifetime?.throwIfAborted();
    if (this.waiting.length >= 256) throw new Error("harness queue capacity");
    const signal = this.lifetime ? AbortSignal.any([work.signal, this.lifetime]) : work.signal;
    const result = new Promise<Result>((resolve, reject) => {
      const entry: Entry<Message, Event, Result, View> = {
        work: { ...work, signal }, priority, resolve, reject,
        execute: AsyncResource.bind((context: Work<Message, Event, View>) => this.execute(message, context)),
        detach: () => signal.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        entry.detach(); reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(entry);
    });
    void result.catch(() => undefined);
    queueMicrotask(() => this.drain());
    return result;
  }

  cancel(): boolean {
    if (!this.current) return false;
    this.current.controller.abort(new DOMException("Harness operation cancelled", "AbortError"));
    return true;
  }

  private drain(): void {
    if (this.current || !this.waiting.length) return;
    const priority = this.waiting.findIndex(entry => entry.priority);
    const entry = this.waiting.splice(priority < 0 ? 0 : priority, 1)[0]!;
    entry.detach();
    const controller = new AbortController();
    this.current = { controller };
    const signal = AbortSignal.any([entry.work.signal, controller.signal]);
    const handoff = async <T>(publish: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try { return await Promise.race([publish(), interrupted]); }
      finally { signal.removeEventListener("abort", abort); }
    };
    const work: Work<Message, Event, View> = {
      ...entry.work, signal,
      output: { send: event => handoff(() => entry.work.output.send(event)) },
      view: { commit: state => handoff(() => entry.work.view.commit(state)) },
      send: message => { signal.throwIfAborted(); entry.work.send(message); },
    };
    void Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const result = await entry.execute(work);
      signal.throwIfAborted();
      return result;
    }).then(result => {
      this.current = undefined;
      this.drain();
      entry.resolve(result);
    }, error => {
      this.current = undefined;
      this.drain();
      entry.reject(error);
    });
  }
}
