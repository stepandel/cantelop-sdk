/// <reference types="node" />
import { setTimeout as delay } from "node:timers/promises";
import type {
  WorkspaceDatabase,
  Transaction,
  TransactionMode,
} from "./database.js";

/** Wait only for a definite rejection before transaction admission. Never replay a write. */
export async function beginCodexTransaction(
  database: WorkspaceDatabase,
  mode: TransactionMode = "write",
): Promise<Transaction> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    let tx: Transaction | undefined;
    try {
      tx = await database.transaction(mode);
      // The remote client sends BEGIN lazily with its first statement.
      await tx.execute("SELECT 1");
      return tx;
    } catch (error) {
      tx?.close();
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

export async function withCodexTransaction<T>(
  database: WorkspaceDatabase,
  operation: (tx: Transaction) => Promise<T>,
  mode: TransactionMode = "write",
): Promise<T> {
  const tx = await beginCodexTransaction(database, mode);
  try {
    const result = await operation(tx);
    await tx.commit();
    return result;
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}
