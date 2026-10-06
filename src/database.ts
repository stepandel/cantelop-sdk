import { createClient, type Client, type InStatement, type InArgs, type ResultSet, type Transaction, type TransactionMode } from "@libsql/client/web";
export type { InStatement, InArgs, ResultSet, Transaction, TransactionMode } from "@libsql/client/web";
export interface DatabaseCredentials { readonly url: string; readonly authToken: string; readonly expiresAt: string }
export interface WorkspaceDatabase extends Client {
  execute(statement: InStatement): Promise<ResultSet>;
  execute(sql: string, args?: InArgs): Promise<ResultSet>;
  batch(statements: InStatement[], mode?: TransactionMode): Promise<ResultSet[]>;
  executeMultiple(sql: string): Promise<void>;
  transaction(mode?: TransactionMode): Promise<Transaction>;
  /** Renewable credentials for native libSQL clients. Never log these values. */
  credentials(): Promise<DatabaseCredentials>;
  close(): void;
  readonly closed: boolean;
}
interface Connection { client: Client; credentials: DatabaseCredentials; users: number; retired: boolean }
export class DatabaseAccessError extends Error {
  constructor(readonly code: string) { super(`Cantelop database access failed: ${code}`); this.name = "DatabaseAccessError"; }
}

/** Renewable client; operations are never automatically replayed. */
export function createWorkspaceDatabase(
  resolveCredentials: () => Promise<DatabaseCredentials>,
  options: { now?: () => number; client?: typeof createClient; localDatabaseOrigin?: string | undefined } = {},
): WorkspaceDatabase {
  const now = options.now ?? Date.now;
  const factory = options.client ?? createClient;
  let current: Connection | undefined;
  let pending: Promise<Connection> | undefined;
  let closed = false;
  const connections = new Set<Connection>();
  function retire(connection: Connection): void {
    connection.retired = true;
    if (connection.users === 0) { connection.client.close(); connections.delete(connection); }
  }
  async function connection(): Promise<Connection> {
    if (closed) throw new DatabaseAccessError("client_closed");
    if (current && Date.parse(current.credentials.expiresAt) > now() + 60_000) return current;
    if (!pending) {
      pending = (async () => {
        const credentials = validateDatabaseCredentials(await resolveCredentials(), now(), options.localDatabaseOrigin);
        if (closed) throw new DatabaseAccessError("client_closed");
        const value: Connection = { client: factory({ url: credentials.url.replace(/^libsql:/, "https:"), authToken: credentials.authToken }), credentials, users: 0, retired: false };
        if (current) retire(current);
        current = value; connections.add(value); return value;
      })().finally(() => { pending = undefined; });
    }
    if (current && Date.parse(current.credentials.expiresAt) > now()) {
      // Renewal failures fall back to credentials that have not yet expired.
      const fallback = current;
      return pending.catch(error => { if (closed || Date.parse(fallback.credentials.expiresAt) <= now()) throw error; return fallback; });
    }
    return pending;
  }
  function release(value: Connection): void { value.users--; if (value.retired && value.users === 0) { value.client.close(); connections.delete(value); } }
  async function acquire(): Promise<Connection> {
    let value: Connection;
    do { value = await connection(); } while (value.retired && !closed);
    if (closed) throw new DatabaseAccessError("client_closed");
    value.users++;
    return value;
  }
  async function use<T>(action: (client: Client) => Promise<T>): Promise<T> {
    const value = await acquire();
    try { return await action(value.client); } finally { release(value); }
  }
  return Object.freeze({
    execute(statement: InStatement, args?: InArgs) { return use(client => typeof statement === "string" ? client.execute(statement, args) : client.execute(statement)); },
    batch(statements: InStatement[], mode?: TransactionMode) { return use(client => client.batch(statements, mode)); },
    migrate(statements: InStatement[]) { return use(client => client.migrate(statements)); },
    sync() { return use(client => client.sync()); },
    reconnect() { closed = false; },
    get protocol() { return "http"; },
    executeMultiple(sql: string) { return use(client => client.executeMultiple(sql)); },
    async transaction(mode: TransactionMode = "write"): Promise<Transaction> {
      const value = await acquire();
      let transaction: Transaction;
      try { transaction = await value.client.transaction(mode); } catch (error) { release(value); throw error; }
      let released = false;
      const finish = () => { if (!released) { released = true; transaction.close(); release(value); } };
      return Object.freeze({
        async execute(statement: InStatement, args?: InArgs) { try { return await (typeof statement === "string" && args !== undefined ? transaction.execute({ sql: statement, args }) : transaction.execute(statement)); } finally { if (transaction.closed) finish(); } },
        async batch(statements: InStatement[]) { try { return await transaction.batch(statements); } finally { if (transaction.closed) finish(); } },
        async executeMultiple(sql: string) { try { await transaction.executeMultiple(sql); } finally { if (transaction.closed) finish(); } },
        async commit() { try { await transaction.commit(); } finally { finish(); } },
        async rollback() { try { await transaction.rollback(); } finally { finish(); } },
        close: finish,
        get closed() { return released || transaction.closed; },
      });
    },
    async credentials() { return (await connection()).credentials; },
    close() { if (!closed) { closed = true; for (const value of connections) value.client.close(); connections.clear(); current = undefined; } },
    get closed() { return closed; },
  });
}
/** Validate the explicit CLI development origin before accepting local credentials. */
export function validateLocalDatabaseOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "host.docker.internal"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new DatabaseAccessError("invalid_runtime_configuration");
  return url;
}
export function validateDatabaseCredentials(value: unknown, now = Date.now(), localDatabaseOrigin?: string): DatabaseCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DatabaseAccessError("invalid_credentials");
  const credentials = value as Record<string, unknown>;
  if (typeof credentials.url !== "string" || typeof credentials.authToken !== "string" || !credentials.authToken || credentials.authToken.length > 16384 || typeof credentials.expiresAt !== "string" || !Number.isFinite(Date.parse(credentials.expiresAt)) || Date.parse(credentials.expiresAt) <= now + 60_000) throw new DatabaseAccessError("invalid_credentials");
  let url: URL;
  try { url = new URL(credentials.url); } catch { throw new DatabaseAccessError("invalid_credentials"); }
  const local = localDatabaseOrigin !== undefined && url.origin === validateLocalDatabaseOrigin(localDatabaseOrigin).origin && /^\/databases\/wsp_[0-9a-f]{32}\/$/.test(url.pathname) && !url.username && !url.password && !url.search && !url.hash;
  if (!local && (!["libsql:", "https:"].includes(url.protocol) || !/^[a-z0-9.-]+\.turso\.io$/.test(url.hostname) || url.username || url.password || url.port || url.pathname !== "" && url.pathname !== "/" || url.search || url.hash)) throw new DatabaseAccessError("invalid_credentials");
  return Object.freeze({ url: credentials.url, authToken: credentials.authToken, expiresAt: credentials.expiresAt });
}
