import { createHash } from "node:crypto";
import { DurableMailbox, type MailboxReceiver } from "./durable-mailbox.js";
import {
  MailboxError,
  type MailboxStore,
  type MailboxMessage,
  type StoredMessage,
  type MailboxOwnership,
  type MailboxIdleReceipt,
} from "./mailbox-store.js";

/** Adapter for tests/native local launchers. It implements the same envelope,
 * receiver, pending-write accounting, and explicit park/resume contract. */
export class InMemoryMailboxAdapter extends DurableMailbox {
  constructor(
    sessionId: string,
    receiver: MailboxReceiver,
    changed: () => void = () => undefined,
  ) {
    super(new MemoryMailboxStore(sessionId), sessionId, receiver, changed);
  }
}
class MemoryMailboxStore implements MailboxStore {
  private readonly entries = new Map<
    string,
    { fingerprint: string; message: StoredMessage }
  >();
  private nextSequence = 1;
  private owner: MailboxOwnership | undefined;
  private parked = false;
  private parkToken: string | undefined;
  constructor(private readonly sessionId: string) {}
  async verify(owner: MailboxOwnership): Promise<void> {
    if (
      owner.sessionId !== this.sessionId ||
      !/^sbx-[0-9a-f]{32}$/.test(owner.sandboxId) ||
      !Number.isSafeInteger(owner.epoch) ||
      owner.epoch < 1
    )
      throw new MailboxError("mailbox_ownership_lost");
    if (
      !this.owner ||
      (this.parked &&
        (sameOwner(this.owner, owner) ||
          (owner.epoch > this.owner.epoch &&
            owner.leaseId !== this.owner.leaseId)))
    ) {
      this.owner = { ...owner };
      this.parked = false;
      this.parkToken = undefined;
    }
    this.check(owner);
  }
  async enqueue(input: MailboxMessage): Promise<StoredMessage> {
    const payload = JSON.stringify(input.payload);
    if (
      !/^msg_[0-9a-f]{32}$/.test(input.id) ||
      input.sessionId !== this.sessionId ||
      payload === undefined ||
      !Number.isSafeInteger(input.keepAliveSeconds) ||
      input.keepAliveSeconds < 0 ||
      input.keepAliveSeconds > 604800
    )
      throw new MailboxError("invalid_message");
    input = { ...input, payload: JSON.parse(payload) };
    const bytes = Buffer.byteLength(payload);
    if (bytes > 1048576) throw new MailboxError("message_capacity");
    const fingerprint = createHash("sha256")
      .update(
        canonical({
          payload: input.payload,
          reply: !!input.replyRequested,
          keepAliveSeconds: input.keepAliveSeconds,
        }),
      )
      .digest("hex");
    const previous = this.entries.get(input.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new MailboxError("message_conflict");
      return structuredClone(previous.message);
    }
    const pendingBytes = [...this.entries.values()]
      .filter((entry) => pending(entry.message))
      .reduce(
        (sum, entry) =>
          sum + Buffer.byteLength(JSON.stringify(entry.message.payload)),
        0,
      );
    if (this.entries.size >= 4096 || pendingBytes + bytes > 8 * 1048576)
      throw new MailboxError("mailbox_capacity");
    const now = Date.now(),
      deadline = input.deadline ?? now + 300000;
    if (
      !Number.isSafeInteger(deadline) ||
      deadline <= now ||
      deadline > now + 330000
    )
      throw new MailboxError("invalid_execution_deadline");
    const message: StoredMessage = {
      ...input,
      payload: JSON.parse(payload),
      sequence: this.nextSequence++,
      acceptedAt: now,
      deadline,
      state: "queued",
    };
    this.entries.set(input.id, { fingerprint, message });
    return structuredClone(message);
  }
  async get(sessionId: string, id: string): Promise<StoredMessage> {
    return structuredClone(this.entry(sessionId, id));
  }
  async claim(
    owner: MailboxOwnership,
    token: string,
  ): Promise<StoredMessage | undefined> {
    this.check(owner);
    const entries = [...this.entries.values()]
      .map((entry) => entry.message)
      .sort((a, b) => a.sequence - b.sequence);
    for (const entry of entries)
      if (
        entry.state === "queued" &&
        (entry.deadline <= Date.now() || entry.cancellationRequestedAt)
      ) {
        entry.state = "timed_out";
        entry.finishedAt = Date.now();
        entry.errorCode = "message_timed_out";
      }
    const running = entries.find(
      (entry) => entry.state === "running" || entry.state === "cancelling",
    );
    if (running)
      return running.claimToken === token
        ? structuredClone(running)
        : undefined;
    const next = entries.find((entry) => entry.state === "queued");
    if (!next) return undefined;
    Object.assign(next, {
      state: "running",
      sandboxId: owner.sandboxId,
      ownerEpoch: owner.epoch,
      claimToken: token,
      startedAt: Date.now(),
    });
    return structuredClone(next);
  }
  async settle(
    owner: MailboxOwnership,
    message: StoredMessage,
    outcome: {
      state: "succeeded" | "failed" | "timed_out";
      reply?: unknown;
      errorCode?: string;
    },
  ): Promise<void> {
    this.check(owner);
    const current = this.entry(owner.sessionId, message.id);
    if (
      current.ownerEpoch !== owner.epoch ||
      current.claimToken !== message.claimToken
    )
      throw new MailboxError("mailbox_ownership_lost");
    if (!pending(current)) return;
    const reply =
      outcome.reply === undefined ? undefined : JSON.stringify(outcome.reply);
    if (reply !== undefined && Buffer.byteLength(reply) > 65536)
      throw new MailboxError("reply_capacity");
    Object.assign(current, outcome, {
      state: current.cancellationRequestedAt ? "timed_out" : outcome.state,
      finishedAt: Date.now(),
    });
    if (reply !== undefined && !current.cancellationRequestedAt)
      current.reply = JSON.parse(reply);
    else delete current.reply;
  }
  async cancel(session: string, id: string): Promise<StoredMessage> {
    const current = this.entry(session, id);
    if (pending(current)) {
      current.cancellationRequestedAt ??= Date.now();
      if (current.state === "queued") {
        current.state = "timed_out";
        current.finishedAt = Date.now();
        current.errorCode = "message_cancelled";
      } else current.state = "cancelling";
    }
    return structuredClone(current);
  }
  async park(
    owner: MailboxOwnership,
    token: string,
  ): Promise<MailboxIdleReceipt | undefined> {
    if (this.parked && this.parkToken === token) {
      if (!sameOwner(this.owner, owner))
        throw new MailboxError("mailbox_ownership_lost");
      return { ...owner, parkToken: token };
    }
    this.check(owner);
    if ([...this.entries.values()].some((entry) => pending(entry.message)))
      return undefined;
    this.parked = true;
    this.parkToken = token;
    return { ...owner, parkToken: token };
  }
  private entry(session: string, id: string): StoredMessage {
    const entry = this.entries.get(id);
    if (session !== this.sessionId || !entry)
      throw new MailboxError("message_not_found");
    return entry.message;
  }
  private check(owner: MailboxOwnership): void {
    if (this.parked || !sameOwner(this.owner, owner))
      throw new MailboxError("mailbox_ownership_lost");
  }
}
function sameOwner(
  a: MailboxOwnership | undefined,
  b: MailboxOwnership,
): boolean {
  return (
    !!a &&
    a.sessionId === b.sessionId &&
    a.sandboxId === b.sandboxId &&
    a.epoch === b.epoch &&
    a.leaseId === b.leaseId
  );
}
function pending(message: StoredMessage): boolean {
  return ["queued", "running", "cancelling"].includes(message.state);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
