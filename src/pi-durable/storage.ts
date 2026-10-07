/// <reference types="node" />
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  MemoryStorage,
  type Storage,
  type StorageWrite,
  type Seq,
} from "@earendil-works/pi-durable";
import type { WorkspaceDatabase, Transaction } from "../database.js";

/** A failed/ambiguous database commit requires reopening; writes are never replayed here. */
export class PiDurableStorageError extends Error {
  constructor(
    readonly code: "closed" | "fenced" | "unavailable" | "corrupt" | "version",
    options?: ErrorOptions,
  ) {
    super(`Cantelop Pi Durable storage: ${code}`, options);
    this.name = "PiDurableStorageError";
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cantelop_pi_stores (
  session_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  writer TEXT NOT NULL,
  next_seq INTEGER NOT NULL CHECK(next_seq >= 1)
);
CREATE TABLE IF NOT EXISTS cantelop_pi_commits (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK(seq >= 1),
  writes TEXT NOT NULL CHECK(json_valid(writes)),
  PRIMARY KEY(session_id, seq)
);`;

const databaseLines = new WeakMap<WorkspaceDatabase, Promise<unknown>>();
async function begin(database: WorkspaceDatabase): Promise<Transaction> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    let tx: Transaction | undefined;
    try {
      tx = await database.transaction("write");
      // libsql's remote client sends BEGIN lazily with the first statement. Force it
      // with a read so a busy rejection surfaces here, before any write is issued.
      await tx.execute("SELECT 1");
      return tx;
    } catch (error) {
      tx?.close();
      // Only a definite pre-admission SQLite busy rejection is safe to retry.
      // Transport failures and statements/commits are never replayed.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "SQLITE_BUSY" ||
        Date.now() >= deadline
      )
        throw error;
      await delay(10);
    }
  }
}
async function transaction<T>(
  database: WorkspaceDatabase,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const result = (databaseLines.get(database) ?? Promise.resolve()).then(() =>
    transact(database, operation),
  );
  databaseLines.set(
    database,
    result.catch(() => {}),
  );
  return result;
}
async function transact<T>(
  database: WorkspaceDatabase,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const tx = await begin(database);
  try {
    const result = await operation(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try {
      if (!tx.closed) await tx.rollback();
    } catch (rollback) {
      throw new AggregateError(
        [error, rollback],
        "Pi storage transaction rollback failed",
      );
    }
    throw error;
  } finally {
    tx.close();
  }
}

/**
 * Append-only SQL persistence with Pi's reference implementation as a read projection.
 * All IDs and sequences are local to sessionId. Opening replaces/fences its old writer;
 * the caller must stop the old runtime before running a replacement harness.
 * Closing this store does not close the caller's shared Workspace database.
 */
class WorkspacePiStorage implements Storage {
  private readonly memory = new MemoryStorage();
  private line: Promise<unknown> = Promise.resolve();
  private closed = false;
  private failure: PiDurableStorageError | undefined;

  private constructor(
    private readonly database: WorkspaceDatabase,
    readonly sessionId: string,
    private readonly writer: string,
  ) {}

  static async open(
    database: WorkspaceDatabase,
    sessionId: string,
    context: Context,
  ): Promise<Storage> {
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      sessionId.length > 512
    )
      throw new TypeError(
        "Pi storage requires a Session ID of 1–512 characters",
      );
    context.abortSignal?.throwIfAborted();
    const storage = new WorkspacePiStorage(database, sessionId, randomUUID());
    try {
      await transaction(database, async (tx) => {
        await tx.executeMultiple(SCHEMA);
        await tx.execute({
          sql: "INSERT OR IGNORE INTO cantelop_pi_stores(session_id,version,writer,next_seq) VALUES (?,1,?,1)",
          args: [sessionId, storage.writer],
        });
        const metadata = (
          await tx.execute({
            sql: "SELECT version,next_seq FROM cantelop_pi_stores WHERE session_id=?",
            args: [sessionId],
          })
        ).rows[0];
        if (metadata?.version !== 1) throw new PiDurableStorageError("version");
        await tx.execute({
          sql: "UPDATE cantelop_pi_stores SET writer=? WHERE session_id=?",
          args: [storage.writer, sessionId],
        });
        let next = 1;
        for (;;) {
          const rows = (
            await tx.execute({
              sql: "SELECT seq,writes FROM cantelop_pi_commits WHERE session_id=? AND seq>=? ORDER BY seq LIMIT 256",
              args: [sessionId, next],
            })
          ).rows;
          if (rows.length === 0) break;
          for (const row of rows) {
            context.abortSignal?.throwIfAborted();
            if (Number(row.seq) !== next || typeof row.writes !== "string")
              throw new PiDurableStorageError("corrupt");
            const writes: unknown = JSON.parse(row.writes);
            if (!Array.isArray(writes))
              throw new PiDurableStorageError("corrupt");
            const seq = await storage.memory.commit(
              writes as StorageWrite[],
              context,
            );
            if (seq !== next++) throw new PiDurableStorageError("corrupt");
          }
        }
        if (next !== Number(metadata.next_seq))
          throw new PiDurableStorageError("corrupt");
      });
      return storage;
    } catch (error) {
      await storage.memory.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  private run<T>(
    context: Context | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new PiDurableStorageError("closed"));
    const result = this.line.then(() => {
      if (this.failure) throw this.failure;
      context?.abortSignal?.throwIfAborted();
      return operation();
    });
    this.line = result.catch(() => {});
    return result;
  }

  commit(writes: readonly StorageWrite[], context: Context): Promise<Seq> {
    return this.run(context, async () => {
      // Validation/detachment happens before SQL; adoption only after its durable commit.
      const prepared = this.memory.prepareCommit(writes);
      const encoded = JSON.stringify(prepared.writes);
      try {
        await transaction(this.database, async (tx) => {
          const changed = await tx.execute({
            sql: "UPDATE cantelop_pi_stores SET next_seq=next_seq+1 WHERE session_id=? AND writer=? AND next_seq=?",
            args: [this.sessionId, this.writer, prepared.seq],
          });
          if (changed.rowsAffected !== 1)
            throw new PiDurableStorageError("fenced");
          await tx.execute({
            sql: "INSERT INTO cantelop_pi_commits(session_id,seq,writes) VALUES (?,?,?)",
            args: [this.sessionId, prepared.seq, encoded],
          });
        });
        return prepared.apply();
      } catch (error) {
        // A transport error may mean SQL committed. Never publish a guessed outcome or
        // issue another write from this projection; reopen resolves the persisted log.
        this.failure =
          error instanceof PiDurableStorageError
            ? error
            : new PiDurableStorageError("unavailable", { cause: error });
        throw this.failure;
      }
    });
  }

  private forward<K extends keyof Storage>(key: K): Storage[K] {
    return ((...args: unknown[]) =>
      this.run(args.at(-1) as Context | undefined, () =>
        Reflect.apply(this.memory[key], this.memory, args),
      )) as Storage[K];
  }
  readonly mintId: Storage["mintId"] = this.forward("mintId");
  readonly conversation = this.forward("conversation");
  readonly scanConversations = this.forward("scanConversations");
  readonly entry = this.forward("entry");
  readonly findLatestHeadMarker = this.forward("findLatestHeadMarker");
  readonly scanEntries = this.forward("scanEntries");
  readonly task = this.forward("task");
  readonly scanTasks = this.forward("scanTasks");
  readonly submission = this.forward("submission");
  readonly scanSubmissions = this.forward("scanSubmissions");
  readonly submissionByRequest = this.forward("submissionByRequest");
  readonly findDocument = this.forward("findDocument");
  readonly document = this.forward("document");
  readonly scanDocuments = this.forward("scanDocuments");

  async close(context: Context): Promise<void> {
    // Seal immediately, then join operations admitted before close.
    this.closed = true;
    await this.line;
    await this.memory.close(context);
  }
}

/** Open a logical Pi store inside the existing, renewable Workspace database. */
export function openPiDurableStorage(
  database: WorkspaceDatabase,
  sessionId: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<Storage> {
  return WorkspacePiStorage.open(database, sessionId, context);
}
