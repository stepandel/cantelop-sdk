import { randomUUID } from "node:crypto";
import {
  MailboxError,
  type MailboxStore,
  type MailboxMessage,
  type StoredMessage,
  type MailboxOwnership,
  type MailboxIdleReceipt,
} from "./mailbox-store.js";

export interface Mailbox {
  readonly isIdle: boolean;
  enqueue(message: MailboxMessage): Promise<StoredMessage>;
  status(id: string): Promise<StoredMessage>;
  cancel(id: string): Promise<StoredMessage>;
  prepareIdle(signal?: AbortSignal): Promise<MailboxIdleReceipt>;
  resume(ownership: MailboxOwnership): Promise<void>;
  close(): Promise<void>;
}
export type MailboxReceiver = (
  message: StoredMessage,
  signal: AbortSignal,
) => Promise<{ reply?: unknown } | void>;

/** Storage and lifecycle fencing stay behind the familiar synchronous idle property. */
export class DurableMailbox implements Mailbox {
  private owner: MailboxOwnership | undefined;
  private operations = 0;
  private busy = true;
  private parked = true;
  private closed = false;
  private pumping: Promise<void> | undefined;
  private fault: unknown;
  private claimToken: string | undefined;
  private settlement:
    | {
        message: StoredMessage;
        outcome: {
          state: "succeeded" | "failed" | "timed_out";
          reply?: unknown;
          errorCode?: string;
        };
      }
    | undefined;
  private current:
    | { message: StoredMessage; controller: AbortController }
    | undefined;
  private readonly waiters = new Set<() => void>();
  private readonly shutdown = new AbortController();
  private parkToken: string | undefined;
  private preparing: Promise<MailboxIdleReceipt> | undefined;
  private readonly ticker: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: MailboxStore,
    private readonly sessionId: string,
    private readonly receive: MailboxReceiver,
    private readonly changed: () => void = () => undefined,
    private readonly pollMs = 250,
    private readonly canPark: () => boolean = () => true,
  ) {
    this.ticker = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, pollMs);
    this.ticker.unref();
  }
  get isParked(): boolean {
    return this.parked;
  }
  work() {
    return this.current
      ? {
          deadline: new Date(this.current.message.deadline).toISOString(),
          ...(this.current.message.cancellationRequestedAt
            ? {
                cancellation_requested_at: new Date(
                  this.current.message.cancellationRequestedAt,
                ).toISOString(),
              }
            : {}),
        }
      : null;
  }
  get isIdle(): boolean {
    return (
      !this.busy &&
      this.operations === 0 &&
      this.current === undefined &&
      this.fault === undefined
    );
  }
  async enqueue(message: MailboxMessage): Promise<StoredMessage> {
    if (this.closed) throw new MailboxError("mailbox_closed");
    if (message.sessionId !== this.sessionId)
      throw new MailboxError("session_mismatch");
    this.operations++;
    this.notify();
    try {
      const stored = await this.store.enqueue(message);
      this.busy = true;
      this.fault = undefined;
      return stored;
    } catch (error) {
      this.fault = error;
      throw error;
    } finally {
      this.operations--;
      this.notify();
      void this.refresh().catch(() => undefined);
    }
  }
  status(id: string): Promise<StoredMessage> {
    return this.store.get(this.sessionId, id);
  }
  async cancel(id: string): Promise<StoredMessage> {
    const stored = await this.store.cancel(this.sessionId, id);
    if (this.current?.message.id === id)
      this.current.controller.abort(
        new DOMException("Message cancelled", "AbortError"),
      );
    this.notify();
    return stored;
  }
  async resume(owner: MailboxOwnership): Promise<void> {
    if (this.closed) throw new MailboxError("mailbox_closed");
    if (owner.sessionId !== this.sessionId)
      throw new MailboxError("session_mismatch");
    if (this.current || this.preparing || this.pumping)
      throw new MailboxError("mailbox_busy");
    if (
      this.owner &&
      owner.epoch <= this.owner.epoch &&
      owner.leaseId !== this.owner.leaseId
    )
      throw new MailboxError("mailbox_ownership_lost");
    this.busy = true;
    this.notify();
    try {
      await this.store.verify(owner);
      this.owner = { ...owner };
      this.parked = false;
      this.parkToken = undefined;
      this.fault = undefined;
    } catch (error) {
      this.fault = error;
      throw error;
    } finally {
      this.notify();
    }
    // Execution is never enabled until ownership and the platform lease are established.
    void this.refresh().catch(() => undefined);
  }
  prepareIdle(signal?: AbortSignal): Promise<MailboxIdleReceipt> {
    if (this.preparing) return this.preparing;
    this.preparing = this.prepare(signal)
      .catch((error) => {
        // A failed park must not leave claims disabled without a durable park.
        if (!this.closed) {
          this.parked = false;
          void this.refresh().catch(() => undefined);
        }
        throw error;
      })
      .finally(() => {
        this.preparing = undefined;
      });
    return this.preparing;
  }
  private async prepare(signal?: AbortSignal): Promise<MailboxIdleReceipt> {
    for (;;) {
      signal?.throwIfAborted();
      this.shutdown.signal.throwIfAborted();
      if (!this.owner) throw new MailboxError("mailbox_unowned");
      if (this.fault) throw this.fault;
      // Stop future claims first, then join the in-flight claim/handler/settlement.
      this.parked = true;
      if (this.pumping) await this.pumping;
      if (this.operations) {
        await this.wait(signal);
        continue;
      }
      if (this.fault) throw this.fault;
      if (!this.canPark()) {
        this.parked = false;
        void this.refresh().catch(() => undefined);
        throw new MailboxError("runtime_busy");
      }
      const token = (this.parkToken ??= randomUUID());
      const receipt = await this.store.park(this.owner, token);
      if (receipt) {
        this.busy = false;
        this.notify();
        return receipt;
      }
      this.parkToken = undefined;
      this.parked = false;
      await this.refresh();
    }
  }
  private refresh(): Promise<void> {
    if (this.closed || this.parked || !this.owner) return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = this.pump()
      .catch((error) => {
        this.fault = error;
        this.busy = true;
        this.notify();
        throw error;
      })
      .finally(() => {
        this.pumping = undefined;
        this.notify();
      });
    return this.pumping;
  }
  private async pump(): Promise<void> {
    const owner = this.owner!;
    while (!this.closed && !this.parked) {
      this.busy = true;
      this.notify();
      // Preserve operation identity across an unresolved transport/commit failure.
      // A retry may resolve a claimed row, but must never invoke its handler twice.
      if (this.settlement) {
        await this.store.settle(
          owner,
          this.settlement.message,
          this.settlement.outcome,
        );
        this.settlement = undefined;
        this.current = undefined;
        this.notify();
      }
      const token = (this.claimToken ??= randomUUID());
      const message = await this.store.claim(owner, token);
      this.claimToken = undefined;
      this.fault = undefined;
      if (!message) {
        this.busy = false;
        this.notify();
        return;
      }
      const controller = new AbortController();
      this.current = { message, controller };
      this.notify();
      const timer = setTimeout(
        () =>
          controller.abort(
            new DOMException("Message deadline exceeded", "TimeoutError"),
          ),
        Math.max(0, message.deadline - Date.now()),
      );
      timer.unref();
      // Poll durable cancellation during a handler without claiming another message.
      const cancellation = setInterval(() => {
        void this.store.get(this.sessionId, message.id).then(
          (current) => {
            if (this.current?.message.id === current.id)
              this.current.message = current;
            if (current.cancellationRequestedAt)
              controller.abort(
                new DOMException("Message cancelled", "AbortError"),
              );
          },
          () => undefined,
        );
      }, this.pollMs);
      cancellation.unref();
      let outcome: {
        state: "succeeded" | "failed" | "timed_out";
        reply?: unknown;
        errorCode?: string;
      };
      try {
        controller.signal.throwIfAborted();
        const result = await this.receive(message, controller.signal);
        if (
          message.replyRequested &&
          (!result || !Object.hasOwn(result, "reply"))
        )
          throw new MailboxError("reply_unavailable");
        outcome = controller.signal.aborted
          ? { state: "timed_out", errorCode: "message_timed_out" }
          : { state: "succeeded", ...(result ? result : {}) };
      } catch {
        outcome = {
          state: controller.signal.aborted ? "timed_out" : "failed",
          errorCode: controller.signal.aborted
            ? "message_timed_out"
            : "handler_failed",
        };
      } finally {
        clearTimeout(timer);
        clearInterval(cancellation);
      }
      // A terminal handler is still busy until its outcome is durably committed.
      this.settlement = { message, outcome };
      await this.store.settle(owner, message, outcome);
      this.settlement = undefined;
      this.current = undefined;
      this.notify();
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.shutdown.abort();
    this.current?.controller.abort(
      new DOMException("Mailbox closed", "AbortError"),
    );
    this.notify();
    if (this.pumping) await this.pumping.catch(() => undefined);
    if (this.preparing) await this.preparing.catch(() => undefined);
    while (this.operations)
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
      });
  }
  private notify(): void {
    this.changed();
    for (const wake of [...this.waiters]) wake();
  }
  private wait(signal?: AbortSignal): Promise<void> {
    const combined = signal
      ? AbortSignal.any([signal, this.shutdown.signal])
      : this.shutdown.signal;
    combined.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.waiters.delete(wake);
        combined.removeEventListener("abort", abort);
      };
      const wake = () => {
        finish();
        resolve();
      };
      const abort = () => {
        finish();
        reject(combined.reason);
      };
      this.waiters.add(wake);
      combined.addEventListener("abort", abort, { once: true });
    });
  }
}
