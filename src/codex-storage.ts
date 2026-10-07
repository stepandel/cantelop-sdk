/// <reference types="node" />

import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { InStatement, ResultSet, Transaction, TransactionMode, WorkspaceDatabase } from "./database.js";

/** Wire contract for a native Codex build using the SDK's workspace storage bridge. */
export const CODEX_WORKSPACE_STORAGE_PROTOCOL_VERSION = 1;
export const CODEX_WORKSPACE_STORAGE_METHOD = "cantelop/workspaceDatabase";

export type CodexDatabaseValue =
  | { readonly type: "null" }
  | { readonly type: "integer"; readonly value: string }
  | { readonly type: "float"; readonly value: number }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "blob"; readonly base64: string };

export interface CodexDatabaseStatement {
  readonly sql: string;
  readonly args?: readonly CodexDatabaseValue[];
}

export interface CodexDatabaseResult {
  readonly columns: readonly string[];
  readonly columnTypes: readonly string[];
  readonly rows: readonly (readonly CodexDatabaseValue[])[];
  readonly rowsAffected: number;
  readonly lastInsertRowid: string | null;
}

export class CodexStorageError extends Error {
  constructor(readonly code: "invalid_request" | "storage_closed" | "transaction_not_found" | "transaction_limit" | "database_operation_failed") {
    super(`Codex workspace storage: ${code}`);
    this.name = "CodexStorageError";
  }
}

export interface CodexWorkspaceStorage {
  /** Handles the native build's server-initiated database requests. Never replays writes. */
  handle(params: unknown): Promise<unknown>;
  /** Drains admitted operations and rolls back open transactions; does not close the borrowed DB. */
  close(): Promise<void>;
}

interface OpenTransaction {
  readonly transaction: Transaction;
  tail: Promise<unknown>;
  timer: ReturnType<typeof setTimeout> | undefined;
  finishing: boolean;
}

const MAX_STATEMENTS = 256;
const MAX_SQL_BYTES = 1024 * 1024;
const MAX_ARGS = 32766;
const MAX_TRANSACTIONS = 16;
const TRANSACTION_IDLE_MS = 60_000;

/** SQL-only bridge. The native backend owns its schemas and storage semantics. */
export function createCodexWorkspaceStorage(database: WorkspaceDatabase): CodexWorkspaceStorage {
  const transactions = new Map<string, OpenTransaction>();
  const operations = new Set<Promise<unknown>>();
  let reservations = 0;
  let closed = false;
  let cleanupFailed = false;
  let closing: Promise<void> | undefined;

  function arm(id: string, entry: OpenTransaction) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (entry.finishing) return;
      entry.finishing = true;
      transactions.delete(id);
      const cleanup = entry.tail.then(() => rollback(entry.transaction));
      operations.add(cleanup);
      void cleanup.finally(() => operations.delete(cleanup)).catch(() => { cleanupFailed = true; });
    }, TRANSACTION_IDLE_MS);
    entry.timer.unref();
  }

  function withTransaction(id: string, operation: string, action: (tx: Transaction) => Promise<unknown>): Promise<unknown> {
    const entry = transactions.get(id);
    if (!entry || entry.finishing) throw new CodexStorageError("transaction_not_found");
    clearTimeout(entry.timer);
    const finish = operation === "commit" || operation === "rollback";
    if (finish) entry.finishing = true;
    const result = entry.tail.then(() => action(entry.transaction));
    entry.tail = result.catch(() => undefined);
    return result.finally(() => {
      if (finish || entry.transaction.closed) {
        clearTimeout(entry.timer);
        transactions.delete(id);
        entry.transaction.close();
      } else {
        // Only arm after all queued operations settle; queueing clears the previous deadline.
        void entry.tail.then(() => { if (!entry.finishing && transactions.get(id) === entry) arm(id, entry); });
      }
    });
  }

  async function dispatch(input: unknown): Promise<unknown> {
    const params = record(input);
    const operation = string(params.operation);
    if (operation === "begin") {
      if (params.transactionId !== undefined) invalid();
      if (transactions.size + reservations >= MAX_TRANSACTIONS) throw new CodexStorageError("transaction_limit");
      const mode = transactionMode(params.mode);
      reservations++;
      let transaction: Transaction;
      try { transaction = await database.transaction(mode); } finally { reservations--; }
      if (closed) { await rollback(transaction); throw new CodexStorageError("storage_closed"); }
      const id = randomUUID();
      const entry: OpenTransaction = { transaction, tail: Promise.resolve(), timer: undefined, finishing: false };
      transactions.set(id, entry);
      arm(id, entry);
      return { transactionId: id };
    }
    let action: (db: Pick<WorkspaceDatabase, "execute" | "batch" | "executeMultiple"> | Transaction) => Promise<unknown>;
    switch (operation) {
      case "execute": {
        const inputStatement = statement(params.statement);
        action = async db => encodeResult(await db.execute(inputStatement));
        break;
      }
      case "batch": {
        if (!Array.isArray(params.statements) || params.statements.length < 1 || params.statements.length > MAX_STATEMENTS) invalid();
        const statements = params.statements.map(statement);
        const mode = transactionMode(params.mode);
        if (params.transactionId !== undefined && params.mode !== undefined) invalid();
        if (params.transactionId !== undefined) action = async db => (await db.batch(statements)).map(encodeResult);
        else return (await database.batch(statements, mode)).map(encodeResult);
        break;
      }
      case "executeMultiple": {
        const sql = sqlText(params.sql);
        action = async db => { await db.executeMultiple(sql); return {}; };
        break;
      }
      case "commit":
      case "rollback": {
        const id = string(params.transactionId);
        return withTransaction(id, operation, async tx => {
          try { await tx[operation](); return {}; } finally { tx.close(); }
        });
      }
      default: return invalid();
    }
    if (params.transactionId !== undefined) return withTransaction(string(params.transactionId), operation, action);
    return action(database);
  }

  return {
    handle(params) {
      if (closed) return Promise.reject(new CodexStorageError("storage_closed"));
      const operation = dispatch(params).catch(error => {
        // Native error replies must never expose SQL arguments or database credentials.
        if (error instanceof CodexStorageError) throw error;
        throw new CodexStorageError("database_operation_failed");
      });
      operations.add(operation);
      void operation.finally(() => operations.delete(operation)).catch(() => undefined);
      return operation;
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        for (const entry of transactions.values()) clearTimeout(entry.timer);
        await Promise.allSettled([...operations]);
        const rollbacks = await Promise.allSettled([...transactions.values()].map(async entry => {
          entry.finishing = true;
          clearTimeout(entry.timer);
          await entry.tail;
          await rollback(entry.transaction);
        }));
        transactions.clear();
        if (cleanupFailed || rollbacks.some(result => result.status === "rejected")) throw new CodexStorageError("database_operation_failed");
      })();
      return closing;
    },
  };
}

async function rollback(tx: Transaction) {
  try { if (!tx.closed) await tx.rollback(); } finally { tx.close(); }
}

function invalid(): never { throw new CodexStorageError("invalid_request"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { return typeof value === "string" && value.length > 0 ? value : invalid(); }
function sqlText(value: unknown): string {
  const sql = string(value);
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES || sql.includes("\0")) return invalid();
  return sql;
}
function transactionMode(value: unknown): TransactionMode {
  if (value === undefined) return "write";
  if (value !== "read" && value !== "write" && value !== "deferred") return invalid();
  return value;
}
function statement(value: unknown): InStatement {
  const input = record(value);
  const sql = sqlText(input.sql);
  if (input.args === undefined) return { sql };
  if (!Array.isArray(input.args) || input.args.length > MAX_ARGS) return invalid();
  return { sql, args: input.args.map(decodeValue) };
}
function decodeValue(value: unknown): null | bigint | number | string | Uint8Array {
  const input = record(value);
  switch (input.type) {
    case "null": return null;
    case "integer": {
      if (typeof input.value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(input.value) || input.value.length > 20) return invalid();
      const integer = BigInt(input.value);
      if (integer < -(1n << 63n) || integer >= 1n << 63n) return invalid();
      return integer;
    }
    case "float": return typeof input.value === "number" && Number.isFinite(input.value) ? input.value : invalid();
    case "text": return typeof input.value === "string" ? input.value : invalid();
    case "blob": {
      if (typeof input.base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) return invalid();
      return Buffer.from(input.base64, "base64");
    }
    default: return invalid();
  }
}
function encodeValue(value: unknown): CodexDatabaseValue {
  if (value === null) return { type: "null" };
  if (typeof value === "bigint") return { type: "integer", value: value.toString() };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      if (!Number.isSafeInteger(value)) throw new CodexStorageError("database_operation_failed");
      return { type: "integer", value: value.toString() };
    }
    return { type: "float", value };
  }
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof ArrayBuffer) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  if (value instanceof Uint8Array) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  throw new CodexStorageError("database_operation_failed");
}
function encodeResult(result: ResultSet): CodexDatabaseResult {
  return {
    columns: result.columns,
    columnTypes: result.columnTypes,
    rows: result.rows.map(row => result.columns.map((_, index) => encodeValue(row[index]))),
    rowsAffected: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid?.toString() ?? null,
  };
}

/** @internal A process-scoped, authenticated loopback bridge, available before native startup. */
export async function startCodexWorkspaceStorage(database: WorkspaceDatabase): Promise<{
  readonly storage: CodexWorkspaceStorage;
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}> {
  const storage = createCodexWorkspaceStorage(database);
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer(async (request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? "");
    if (request.method !== "POST" || request.url !== "/storage" || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      response.writeHead(403); response.end(); request.resume(); return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.byteLength;
        if (size > 16 * 1024 * 1024) { response.writeHead(413); response.end(); request.destroy(); return; }
        chunks.push(bytes);
      }
      const result = await storage.handle(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw new CodexStorageError("database_operation_failed");
      response.writeHead(200, { "content-type": "application/json" }); response.end(body);
    } catch (error) {
      if (response.destroyed) return;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof CodexStorageError ? error.code : "invalid_request" }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.on("error", () => {
    void storage.close().catch(() => undefined);
    server.closeAllConnections();
    server.close();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) { await storage.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); await storage.close(); throw new CodexStorageError("database_operation_failed"); }
  let closing: Promise<void> | undefined;
  return {
    storage, token, url: `http://127.0.0.1:${address.port}/storage`,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        try { await storage.close(); }
        finally {
          // A partial HTTP upload must not keep the bridge alive after its child exits.
          server.closeAllConnections();
          await stopped;
        }
      })();
      return closing;
    },
  };
}
