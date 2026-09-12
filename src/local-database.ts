/// <reference types="node" />
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import type { D1Database } from "@cloudflare/workers-types";

// Keep Miniflare's internal declarations out of the public SDK types: its
// bundled .d.ts imports unpublished internal modules. This small boundary is
// exercised against the pinned runtime by the local D1 integration tests.
interface LocalRuntime {
  ready: Promise<URL>;
  dispose(): Promise<void>;
  setOptions(options: Record<string, unknown>): Promise<void>;
  getD1Database(name: string): Promise<D1Database>;
}
const { Miniflare, convertV4MiniflareOptions } = createRequire(import.meta.url)("miniflare") as {
  Miniflare: new (options: Record<string, unknown>) => LocalRuntime;
  convertV4MiniflareOptions(options: Record<string, unknown>): Record<string, unknown>;
};

async function acquireLocalDatabase(persist: string): Promise<() => Promise<void>> {
  const directory = resolve(persist);
  await mkdir(directory, { recursive: true });
  try { return await lockfile.lock(directory, { realpath: false, stale: 30_000, update: 10_000, retries: 0 }); }
  catch { throw new Error("Local database is in use. Stop cantelop dev or the other migration process and retry (crashed-process leases expire after 30 seconds)."); }
}

const databaseOptions = (persist: string) => ({
  compatibilityDate: "2026-08-11", modules: true, d1Databases: { DB: "cantelop-app-db" }, resourcePersistencePath: resolve(persist), telemetry: { enabled: false }, cf: false,
});

/** CLI tooling: run the built API against persistent local D1. */
export async function serveLocalDatabaseApi(options: {
  workerPath: string; persist: string; port: number; bindings?: Record<string, string>;
}): Promise<{ close(): Promise<void> }> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || options.bindings?.DB !== undefined) throw new TypeError("invalid local database API options (DB is reserved)");
  const workerPath = resolve(options.workerPath);
  const config = async (): Promise<Record<string, unknown>> => ({
    ...databaseOptions(options.persist),
    script: await readFile(workerPath, "utf8"),
    host: "127.0.0.1", port: options.port, bindings: options.bindings ?? {},
  });
  const release = await acquireLocalDatabase(options.persist);
  let runtime: LocalRuntime;
  try { runtime = new Miniflare(convertV4MiniflareOptions(await config())); }
  catch (error) { await release(); throw error; }
  try { await runtime.ready; } catch (error) { try { await runtime.dispose(); } finally { await release(); } throw error; }
  let version = (await stat(workerPath)).mtimeMs;
  let updating: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (updating) return;
    updating = (async () => {
      const next = (await stat(workerPath)).mtimeMs;
      if (next !== version) { await runtime.setOptions(convertV4MiniflareOptions(await config())); version = next; }
    })().catch((error: unknown) => console.error("Local API reload failed", error)).finally(() => { updating = undefined; });
  }, 250);
  return { async close() { clearInterval(timer); await updating; try { await runtime.dispose(); } finally { await release(); } } };
}

/** CLI tooling: same persistent resource identity as serveLocalDatabaseApi. */
export async function migrateLocalDatabase(options: { persist: string; name: string; sql: string }) {
  if (!/^[0-9]{4,}_[a-zA-Z0-9_-]+\.sql$/.test(options.name) || options.name.length > 128 || !options.sql.trim() || Buffer.byteLength(options.sql) > 90_000 || options.sql.includes("\0") || /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|END|_cantelop_migrations)\b/i.test(options.sql)) throw new TypeError("invalid migration or reserved transaction/ledger SQL");
  const release = await acquireLocalDatabase(options.persist);
  let runtime: LocalRuntime | undefined;
  try {
    runtime = new Miniflare(convertV4MiniflareOptions({ ...databaseOptions(options.persist), script: "export default {fetch() {return new Response('local database')}}" }));
    const db = await runtime.getD1Database("DB");
    await db.prepare("CREATE TABLE IF NOT EXISTS _cantelop_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)").run();
    const checksum = createHash("sha256").update(options.sql).digest("hex");
    const applied = await db.prepare("SELECT name, checksum FROM _cantelop_migrations ORDER BY name").all<{ name: string; checksum: string }>();
    const existing = applied.results.find((row) => row.name === options.name);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error("migration checksum changed");
      return { name: options.name, status: "applied", replayed: true };
    }
    if (applied.results.some((row) => row.name > options.name)) throw new Error("migration is out of order");
    const statements = splitMigrationSQL(options.sql).map((sql) => db.prepare(sql));
    // Ledger primary key also fences simultaneous runners: a loser rolls back
    // its entire D1 batch, including schema/data changes.
    statements.push(db.prepare("INSERT INTO _cantelop_migrations (name, checksum) VALUES (?, ?)").bind(options.name, checksum));
    await db.batch(statements);
    return { name: options.name, status: "applied", replayed: false };
  } finally { try { await runtime?.dispose(); } finally { await release(); } }
}

/** Split ordinary SQL, respecting quoted strings/identifiers and SQL comments.
 * Explicit transactions (and trigger BEGIN blocks) are rejected above. */
export function splitMigrationSQL(sql: string): string[] {
  const statements: string[] = [];
  let current = "", quote = "", lineComment = false, blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!, next = sql[i + 1];
    if (lineComment) { if (c === "\n") { lineComment = false; current += "\n"; } continue; }
    if (blockComment) { if (c === "*" && next === "/") { blockComment = false; i++; current += " "; } continue; }
    if (quote) {
      current += c;
      if (c === quote) { if (next === quote && quote !== "]") { current += next; i++; } else quote = ""; }
      continue;
    }
    if (c === "-" && next === "-") { lineComment = true; i++; continue; }
    if (c === "/" && next === "*") { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === "`" || c === "[") { quote = c === "[" ? "]" : c; current += c; continue; }
    if (c === ";") { if (current.trim()) statements.push(current.trim()); current = ""; } else current += c;
  }
  if (quote || blockComment) throw new TypeError("unterminated migration SQL");
  if (current.trim()) statements.push(current.trim());
  if (!statements.length) throw new TypeError("empty migration SQL");
  return statements;
}
