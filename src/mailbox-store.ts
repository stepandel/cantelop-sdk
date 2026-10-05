import type { WorkspaceDatabase, Transaction } from "./database.js";

export type MailboxState =
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "unknown";
export interface MailboxMessage {
  id: string;
  sessionId: string;
  payload: unknown;
  replyRequested?: boolean;
  keepAliveSeconds: number;
  deadline?: number;
}
export interface StoredMessage extends MailboxMessage {
  sequence: number;
  acceptedAt: number;
  deadline: number;
  state: MailboxState;
  startedAt?: number;
  finishedAt?: number;
  cancellationRequestedAt?: number;
  claimToken?: string;
  ownerEpoch?: number;
  sandboxId?: string;
  reply?: unknown;
  errorCode?: string;
}
export interface MailboxOwnership {
  sessionId: string;
  sandboxId: string;
  epoch: number;
  leaseId: string;
}
export interface MailboxIdleReceipt extends MailboxOwnership {
  parkToken: string;
}
export class MailboxError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MailboxError";
  }
}
export interface MailboxStore {
  enqueue(message: MailboxMessage): Promise<StoredMessage>;
  get(sessionId: string, id: string): Promise<StoredMessage>;
  claim(
    owner: MailboxOwnership,
    token: string,
  ): Promise<StoredMessage | undefined>;
  settle(
    owner: MailboxOwnership,
    message: StoredMessage,
    outcome: {
      state: "succeeded" | "failed" | "timed_out";
      reply?: unknown;
      errorCode?: string;
    },
  ): Promise<void>;
  cancel(sessionId: string, id: string): Promise<StoredMessage>;
  park(
    owner: MailboxOwnership,
    token: string,
  ): Promise<MailboxIdleReceipt | undefined>;
  verify(owner: MailboxOwnership): Promise<void>;
}

// Applied by Workspace provisioning, never by a sandbox during activation.
export const MAILBOX_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cantelop_mailbox_schema (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cantelop_mailbox_sessions (
    session_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL DEFAULT 1,
    epoch INTEGER NOT NULL DEFAULT 0, sandbox_id TEXT, lease_id TEXT,
    owner_state TEXT NOT NULL DEFAULT 'unowned' CHECK(owner_state IN ('unowned','active','parked','lost','recovering')),
    supervision_deadline INTEGER, recovery_supported INTEGER NOT NULL DEFAULT 0, parked_at INTEGER,
    park_token TEXT, recovery_id TEXT, recovery_attempts INTEGER NOT NULL DEFAULT 0,
    recovery_message_id TEXT, recovery_deadline INTEGER, recovery_error TEXT,
    keep_alive_seconds INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS cantelop_mailbox_messages (
    session_id TEXT NOT NULL REFERENCES cantelop_mailbox_sessions(session_id), message_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, payload TEXT, payload_bytes INTEGER NOT NULL,
    reply_requested INTEGER NOT NULL, keep_alive_seconds INTEGER NOT NULL,
    sequence INTEGER NOT NULL, accepted_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','cancelling','succeeded','failed','timed_out','unknown')),
    sandbox_id TEXT, owner_epoch INTEGER, claim_token TEXT, started_at INTEGER, finished_at INTEGER,
    cancellation_requested_at INTEGER, reply TEXT, error_code TEXT,
    PRIMARY KEY(session_id,message_id), UNIQUE(session_id,sequence))`,
  `CREATE INDEX IF NOT EXISTS cantelop_mailbox_pending ON cantelop_mailbox_messages(session_id,state,sequence)`,
  `INSERT INTO cantelop_mailbox_schema(id,version) VALUES(1,1) ON CONFLICT(id) DO NOTHING`,
] as const;

type Row = Record<string, unknown>;
export class TursoMailboxStore implements MailboxStore {
  constructor(
    readonly db: WorkspaceDatabase,
    readonly now: () => number = Date.now,
  ) {}
  async verify(owner: MailboxOwnership): Promise<void> {
    const schema = await this.db.execute(
      "SELECT version FROM cantelop_mailbox_schema WHERE id=1",
    );
    if (Number(schema.rows[0]?.version) !== 1)
      throw new MailboxError("mailbox_schema_mismatch");
    const result = await this.db.execute({
      sql: "SELECT * FROM cantelop_mailbox_sessions WHERE session_id=?",
      args: [owner.sessionId],
    });
    checkOwner(result.rows[0], owner);
  }
  async enqueue(message: MailboxMessage): Promise<StoredMessage> {
    validateMessage(message);
    const payload = JSON.stringify(message.payload);
    if (payload === undefined) throw new MailboxError("invalid_message");
    message = { ...message, payload: JSON.parse(payload) };
    const bytes = new TextEncoder().encode(payload).byteLength;
    if (bytes > 1024 * 1024) throw new MailboxError("message_capacity");
    const fingerprint = await digest(
      canonical({
        payload: message.payload,
        reply: !!message.replyRequested,
        keepAliveSeconds: message.keepAliveSeconds,
      }),
    );
    // Identity and fingerprint, not a blindly replayed SQL write, resolve ACK/commit loss.
    try {
      return await this.write(async (tx) => {
        const existing = await read(tx, message.sessionId, message.id);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw new MailboxError("message_conflict");
          return decode(existing);
        }
        const now = this.now();
        const deadline = message.deadline ?? now + 300_000;
        if (
          !Number.isSafeInteger(deadline) ||
          deadline <= now ||
          deadline > now + 330_000
        )
          throw new MailboxError("invalid_execution_deadline");
        await tx.execute({
          sql: `INSERT INTO cantelop_mailbox_sessions(session_id,updated_at) VALUES(?,?) ON CONFLICT(session_id) DO NOTHING`,
          args: [message.sessionId, now],
        });
        const lifecycle = (
          await tx.execute({
            sql: "SELECT lease_id,recovery_error FROM cantelop_mailbox_sessions WHERE session_id=?",
            args: [message.sessionId],
          })
        ).rows[0]!;
        if (lifecycle.recovery_error === "session_released") {
          if (lifecycle.lease_id !== null)
            throw new MailboxError("session_stopping");
          await tx.execute({
            sql: "UPDATE cantelop_mailbox_sessions SET recovery_error=NULL,recovery_id=NULL,recovery_message_id=NULL,recovery_attempts=0 WHERE session_id=? AND lease_id IS NULL",
            args: [message.sessionId],
          });
        }
        const capacity = await tx.execute({
          sql: `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN state IN ('queued','running','cancelling') THEN payload_bytes ELSE 0 END),0) AS bytes FROM cantelop_mailbox_messages WHERE session_id=?`,
          args: [message.sessionId],
        });
        if (
          Number(capacity.rows[0]?.count) >= 4096 ||
          Number(capacity.rows[0]?.bytes) + bytes > 8 * 1024 * 1024
        )
          throw new MailboxError("mailbox_capacity");
        const sequence = await tx.execute({
          sql: `UPDATE cantelop_mailbox_sessions SET next_sequence=next_sequence+1,keep_alive_seconds=?,updated_at=? WHERE session_id=? RETURNING next_sequence-1 AS sequence`,
          args: [message.keepAliveSeconds, now, message.sessionId],
        });
        await tx.execute({
          sql: `INSERT INTO cantelop_mailbox_messages(session_id,message_id,fingerprint,payload,payload_bytes,reply_requested,keep_alive_seconds,sequence,accepted_at,deadline,state) VALUES(?,?,?,?,?,?,?,?,?,?,'queued')`,
          args: [
            message.sessionId,
            message.id,
            fingerprint,
            payload,
            bytes,
            message.replyRequested ? 1 : 0,
            message.keepAliveSeconds,
            Number(sequence.rows[0]!.sequence),
            now,
            deadline,
          ],
        });
        return decode((await read(tx, message.sessionId, message.id))!);
      });
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      const existing = await read(this.db, message.sessionId, message.id);
      if (!existing) throw error;
      if (existing.fingerprint !== fingerprint)
        throw new MailboxError("message_conflict");
      return decode(existing);
    }
  }
  async get(sessionId: string, id: string): Promise<StoredMessage> {
    const row = await read(this.db, sessionId, id);
    if (!row) throw new MailboxError("message_not_found");
    return decode(row);
  }
  async claim(
    owner: MailboxOwnership,
    token: string,
  ): Promise<StoredMessage | undefined> {
    try {
      return await this.write(async (tx) => {
        checkOwner(
          (
            await tx.execute({
              sql: "SELECT * FROM cantelop_mailbox_sessions WHERE session_id=?",
              args: [owner.sessionId],
            })
          ).rows[0],
          owner,
        );
        await tx.execute({
          sql: `UPDATE cantelop_mailbox_messages SET state='timed_out',finished_at=?,error_code='message_timed_out' WHERE session_id=? AND state='queued' AND (deadline<=? OR cancellation_requested_at IS NOT NULL)`,
          args: [this.now(), owner.sessionId, this.now()],
        });
        // One in-flight handler per logical Session, including after a lost claim ACK.
        const running = await tx.execute({
          sql: `SELECT * FROM cantelop_mailbox_messages WHERE session_id=? AND state IN ('running','cancelling') ORDER BY sequence LIMIT 1`,
          args: [owner.sessionId],
        });
        if (running.rows[0]) {
          if (
            running.rows[0].claim_token === token &&
            Number(running.rows[0].owner_epoch) === owner.epoch
          )
            return decode(running.rows[0]);
          return undefined;
        }
        const result = await tx.execute({
          sql: `UPDATE cantelop_mailbox_messages SET state='running',sandbox_id=?,owner_epoch=?,claim_token=?,started_at=? WHERE session_id=? AND message_id=(SELECT message_id FROM cantelop_mailbox_messages WHERE session_id=? AND state='queued' ORDER BY sequence LIMIT 1) AND state='queued' RETURNING *`,
          args: [
            owner.sandboxId,
            owner.epoch,
            token,
            this.now(),
            owner.sessionId,
            owner.sessionId,
          ],
        });
        return result.rows[0] ? decode(result.rows[0]) : undefined;
      });
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      const result = await this.db.execute({
        sql: "SELECT * FROM cantelop_mailbox_messages WHERE session_id=? AND claim_token=? AND owner_epoch=?",
        args: [owner.sessionId, token, owner.epoch],
      });
      if (result.rows[0]) {
        await this.verify(owner);
        return decode(result.rows[0]);
      }
      throw error;
    }
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
    const reply =
      outcome.reply === undefined ? null : JSON.stringify(outcome.reply);
    if (reply !== null && new TextEncoder().encode(reply).byteLength > 65536)
      throw new MailboxError("reply_capacity");
    const settle = async (tx: Transaction) => {
      checkOwner(
        (
          await tx.execute({
            sql: "SELECT * FROM cantelop_mailbox_sessions WHERE session_id=?",
            args: [owner.sessionId],
          })
        ).rows[0],
        owner,
      );
      const result = await tx.execute({
        sql: `UPDATE cantelop_mailbox_messages SET state=CASE WHEN cancellation_requested_at IS NOT NULL THEN 'timed_out' ELSE ? END,reply=CASE WHEN cancellation_requested_at IS NOT NULL THEN NULL ELSE ? END,error_code=?,finished_at=? WHERE session_id=? AND message_id=? AND owner_epoch=? AND claim_token=? AND state IN ('running','cancelling') RETURNING message_id`,
        args: [
          outcome.state,
          reply,
          outcome.errorCode ?? null,
          this.now(),
          owner.sessionId,
          message.id,
          owner.epoch,
          message.claimToken!,
        ],
      });
      if (!result.rows[0]) {
        const current = await read(tx, owner.sessionId, message.id);
        if (
          !current ||
          Number(current.owner_epoch) !== owner.epoch ||
          current.claim_token !== message.claimToken ||
          !terminal(String(current.state))
        )
          throw new MailboxError("mailbox_ownership_lost");
      }
    };
    try {
      await this.write(settle);
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      const current = await this.get(owner.sessionId, message.id);
      if (
        current.ownerEpoch !== owner.epoch ||
        current.claimToken !== message.claimToken ||
        !terminal(current.state)
      )
        throw error;
    }
  }
  async cancel(sessionId: string, id: string): Promise<StoredMessage> {
    await this.db.execute({
      sql: `UPDATE cantelop_mailbox_messages SET state=CASE WHEN state='queued' THEN 'timed_out' ELSE 'cancelling' END,cancellation_requested_at=COALESCE(cancellation_requested_at,?),finished_at=CASE WHEN state='queued' THEN ? ELSE finished_at END,error_code=CASE WHEN state='queued' THEN 'message_cancelled' ELSE error_code END WHERE session_id=? AND message_id=? AND state IN ('queued','running','cancelling')`,
      args: [this.now(), this.now(), sessionId, id],
    });
    return this.get(sessionId, id);
  }
  async park(
    owner: MailboxOwnership,
    token: string,
  ): Promise<MailboxIdleReceipt | undefined> {
    try {
      return await this.write(async (tx) => {
        const row = (
          await tx.execute({
            sql: "SELECT * FROM cantelop_mailbox_sessions WHERE session_id=?",
            args: [owner.sessionId],
          })
        ).rows[0];
        if (row?.owner_state === "parked" && row.park_token === token) {
          checkOwner(row, owner, "parked");
          return { ...owner, parkToken: token };
        }
        checkOwner(row, owner);
        const pending = await tx.execute({
          sql: "SELECT 1 FROM cantelop_mailbox_messages WHERE session_id=? AND state IN ('queued','running','cancelling') LIMIT 1",
          args: [owner.sessionId],
        });
        if (pending.rows.length) return undefined;
        await tx.execute({
          sql: "UPDATE cantelop_mailbox_sessions SET owner_state='parked',park_token=?,parked_at=?,updated_at=? WHERE session_id=?",
          args: [token, this.now(), this.now(), owner.sessionId],
        });
        return { ...owner, parkToken: token };
      });
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      const row = (
        await this.db.execute({
          sql: "SELECT * FROM cantelop_mailbox_sessions WHERE session_id=?",
          args: [owner.sessionId],
        })
      ).rows[0];
      if (row?.owner_state === "parked" && row.park_token === token) {
        checkOwner(row, owner, "parked");
        return { ...owner, parkToken: token };
      }
      throw error;
    }
  }
  private async write<T>(action: (tx: Transaction) => Promise<T>): Promise<T> {
    let tx: Transaction | undefined;
    for (let attempt = 0; !tx; attempt++) {
      try {
        tx = await this.db.transaction("write");
      } catch (error) {
        // SQLITE_BUSY before BEGIN acquired ownership is a definite non-write.
        // Never retry a transaction body or an uncertain commit.
        if (
          attempt >= 20 ||
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "SQLITE_BUSY"
        )
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(5 * (attempt + 1), 50)),
        );
      }
    }
    try {
      const result = await action(tx);
      await tx.commit();
      return result;
    } catch (error) {
      try {
        if (!tx.closed) await tx.rollback();
      } catch {
        /* preserve the original uncertainty */
      }
      throw error;
    } finally {
      tx.close();
    }
  }
}
function checkOwner(
  row: Row | undefined,
  owner: MailboxOwnership,
  state = "active",
): void {
  if (
    !row ||
    row.sandbox_id !== owner.sandboxId ||
    Number(row.epoch) !== owner.epoch ||
    row.lease_id !== owner.leaseId ||
    row.owner_state !== state ||
    row.recovery_error === "session_released"
  )
    throw new MailboxError("mailbox_ownership_lost");
}
async function read(
  db: Pick<WorkspaceDatabase, "execute">,
  session: string,
  id: string,
): Promise<Row | undefined> {
  return (
    await db.execute({
      sql: "SELECT * FROM cantelop_mailbox_messages WHERE session_id=? AND message_id=?",
      args: [session, id],
    })
  ).rows[0];
}
function decode(row: Row): StoredMessage {
  return {
    id: String(row.message_id),
    sessionId: String(row.session_id),
    payload: row.payload === null ? undefined : JSON.parse(String(row.payload)),
    replyRequested: !!row.reply_requested,
    keepAliveSeconds: Number(row.keep_alive_seconds),
    sequence: Number(row.sequence),
    acceptedAt: Number(row.accepted_at),
    deadline: Number(row.deadline),
    state: row.state as MailboxState,
    ...(row.started_at === null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.finished_at === null
      ? {}
      : { finishedAt: Number(row.finished_at) }),
    ...(row.cancellation_requested_at === null
      ? {}
      : { cancellationRequestedAt: Number(row.cancellation_requested_at) }),
    ...(row.claim_token === null
      ? {}
      : { claimToken: String(row.claim_token) }),
    ...(row.owner_epoch === null
      ? {}
      : { ownerEpoch: Number(row.owner_epoch) }),
    ...(row.sandbox_id === null ? {} : { sandboxId: String(row.sandbox_id) }),
    ...(row.reply === null ? {} : { reply: JSON.parse(String(row.reply)) }),
    ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
  };
}
function validateMessage(message: MailboxMessage): void {
  if (
    !/^msg_[0-9a-f]{32}$/.test(message.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(message.sessionId) ||
    !Number.isSafeInteger(message.keepAliveSeconds) ||
    message.keepAliveSeconds < 0 ||
    message.keepAliveSeconds > 604800
  )
    throw new MailboxError("invalid_message");
}
function terminal(state: string): boolean {
  return ["succeeded", "failed", "timed_out", "unknown"].includes(state);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function digest(value: string): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
