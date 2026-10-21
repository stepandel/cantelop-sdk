/// <reference types="node" />
import { createHash } from "node:crypto";
import { generateSQLiteDrizzleJson, generateSQLiteMigration, type DrizzleSQLiteSnapshotJSON } from "drizzle-kit/api";
import type { WorkspaceDatabase } from "./database.js";

/** Deterministic developer schema build artifact. */
export interface ApplicationDatabaseSchema {
  readonly version: 1;
  readonly digest: string;
  readonly allowDestructiveChanges: boolean;
  readonly snapshot: DrizzleSQLiteSnapshotJSON;
}
export class DatabaseSchemaError extends Error {
  constructor(readonly code: string) { super(`Cantelop database schema: ${code}`); this.name = "DatabaseSchemaError"; }
}
const origin = "00000000-0000-0000-0000-000000000000";
const namePattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** RegExp#test semantics (non-strings are stringified), without implicit coercion at each call site. */
function matches(pattern: RegExp, value: unknown): boolean {
  return pattern.test(String(value));
}
/** Values of an optional snapshot collection; absent collections are empty. */
function members(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Object.values(value as object);
}
const RESERVED_NAME = /^(cantelop_|sqlite_|__)/i;
const MAX_TABLES = 256;
const MAX_COLUMNS = 256;
const MAX_SNAPSHOT_CHARACTERS = 512 * 1024;
const typePattern = /^[a-zA-Z]+(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?$/;
const literalPattern = /^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|NULL|TRUE|FALSE|CURRENT_(?:TIME|DATE|TIMESTAMP)|'(?:[^']|'')*')$/i;
const actions = new Set(["no action", "restrict", "set null", "set default", "cascade"]);
function names(value: unknown): boolean {
  return Array.isArray(value) && value.every(name => typeof name === "string" && namePattern.test(name));
}
/** drizzle-kit splices expressions into DDL verbatim; each must stay one self-contained expression. */
function sqlExpression(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 4096) return false;
  let quote: string | undefined;
  let depth = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote) { if (character === quote) quote = undefined; continue; }
    if (character === "'" || character === '"' || character === "`") quote = character;
    else if (character === "(") depth++;
    else if (character === ")" && --depth < 0) return false;
    else if (character === ";" || value.startsWith("--", index) || value.startsWith("/*", index)) return false;
  }
  return quote === undefined && depth === 0;
}
function columnDefault(value: unknown): boolean {
  if (value === undefined || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return true;
  return typeof value === "string" && (literalPattern.test(value) || (value.startsWith("(") && value.endsWith(")") && sqlExpression(value.slice(1, -1))));
}
/** Sorted-key JSON without undefined members. `known` supplies already canonicalized subtrees. */
function canonical(value: unknown, known?: ReadonlyMap<unknown, string>): string {
  const cached = known?.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, known)).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], known)}`).join(",")}}`;
  return JSON.stringify(value);
}
function schemaDigest(snapshot: unknown, allowDestructiveChanges: boolean, known?: ReadonlyMap<unknown, string>): string {
  return `sha256:${createHash("sha256").update(canonical({ snapshot, allowDestructiveChanges }, known)).digest("hex")}`;
}
export function validateApplicationSchema(value: unknown): ApplicationDatabaseSchema {
  if (!object(value) || value.version !== 1 || typeof value.allowDestructiveChanges !== "boolean" || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest) || !object(value.snapshot)) throw new DatabaseSchemaError("invalid_artifact");
  const snapshot = value.snapshot;
  const tables = snapshot.tables;
  if (snapshot.version !== "6" || snapshot.dialect !== "sqlite" || !object(tables) || !object(snapshot.views) || Object.keys(snapshot.views).length) throw new DatabaseSchemaError("unsupported_schema");
  // Canonicalize the snapshot once; the size check, digest and returned copy all reuse it.
  const snapshotText = canonical(snapshot);
  if (Object.keys(tables).length > MAX_TABLES || snapshotText.length > MAX_SNAPSHOT_CHARACTERS) throw new DatabaseSchemaError("schema_too_large");
  for (const [name, table] of Object.entries(tables)) {
    if (!object(table) || table.name !== name || !namePattern.test(name) || RESERVED_NAME.test(name)) throw new DatabaseSchemaError("reserved_table_name");
    const columns = table.columns;
    if (!object(columns) || Object.keys(columns).length > MAX_COLUMNS) throw new DatabaseSchemaError("invalid_artifact");
    for (const [key, column] of Object.entries(columns)) {
      if (!object(column) || column.name !== key || !namePattern.test(key) || typeof column.type !== "string" || !typePattern.test(column.type) || !columnDefault(column.default)) throw new DatabaseSchemaError("invalid_column_definition");
    }
    for (const foreignKey of members(table.foreignKeys)) {
      if (!object(foreignKey) || typeof foreignKey.tableTo !== "string" || !Object.hasOwn(tables, foreignKey.tableTo)) throw new DatabaseSchemaError("foreign_key_outside_application");
      if (foreignKey.tableFrom !== name || !matches(namePattern, foreignKey.name) || !names(foreignKey.columnsFrom) || !names(foreignKey.columnsTo)
        || !actions.has(String(foreignKey.onDelete ?? "no action")) || !actions.has(String(foreignKey.onUpdate ?? "no action"))) throw new DatabaseSchemaError("invalid_foreign_key");
    }
    for (const index of members(table.indexes)) {
      if (!object(index) || !matches(namePattern, index.name) || matches(RESERVED_NAME, index.name)) throw new DatabaseSchemaError("reserved_index_name");
      if (!Array.isArray(index.columns) || !index.columns.every((column: unknown) => sqlExpression(column) && !String(column).includes("`"))
        || (index.where !== undefined && !sqlExpression(index.where))) throw new DatabaseSchemaError("invalid_index");
    }
    for (const constraint of [...members(table.compositePrimaryKeys), ...members(table.uniqueConstraints)]) {
      if (!object(constraint) || !matches(namePattern, constraint.name) || !names(constraint.columns)) throw new DatabaseSchemaError("invalid_constraint");
    }
    for (const constraint of members(table.checkConstraints)) {
      if (!object(constraint) || !matches(namePattern, constraint.name) || !sqlExpression(constraint.value)) throw new DatabaseSchemaError("invalid_constraint");
    }
  }
  const known = new Map<unknown, string>([[snapshot, snapshotText]]);
  if (value.digest !== schemaDigest(snapshot, value.allowDestructiveChanges, known)) throw new DatabaseSchemaError("artifact_digest_mismatch");
  return JSON.parse(canonical(value, known)) as ApplicationDatabaseSchema;
}
export async function createApplicationSchema(exports: Record<string, unknown>): Promise<ApplicationDatabaseSchema> {
  const snapshot = await generateSQLiteDrizzleJson(exports);
  snapshot.id = origin;
  snapshot.prevId = origin;
  const allowDestructiveChanges = exports.allowDestructiveChanges === true;
  return validateApplicationSchema({ version: 1, allowDestructiveChanges, digest: schemaDigest(snapshot, allowDestructiveChanges), snapshot });
}
/** Destructive changes require a declaration in the developer schema; ambiguous renames never prompt in a build worker. */
export async function applicationMigrationSQL(previous: ApplicationDatabaseSchema | undefined, next: ApplicationDatabaseSchema): Promise<string[]> {
  return migrationSQL(previous ? validateApplicationSchema(previous) : undefined, validateApplicationSchema(next));
}
/** Both schemas are already validated. */
async function migrationSQL(previous: ApplicationDatabaseSchema | undefined, next: ApplicationDatabaseSchema): Promise<string[]> {
  const before = previous ? previous.snapshot : (await createApplicationSchema({})).snapshot;
  for (const name of Object.keys(before.tables)) {
    const table = before.tables[name]!;
    const target = next.snapshot.tables[name];
    if (!target) {
      if (!next.allowDestructiveChanges) throw new DatabaseSchemaError("explicit_migration_required");
      if (Object.keys(next.snapshot.tables).some(key => !Object.hasOwn(before.tables, key))) throw new DatabaseSchemaError("ambiguous_table_rename");
      continue;
    }
    for (const [column, definition] of Object.entries(table.columns)) {
      if (!target.columns[column] || canonical(definition) !== canonical(target.columns[column])) {
        if (!next.allowDestructiveChanges) throw new DatabaseSchemaError("explicit_migration_required");
        if (!target.columns[column] && Object.keys(target.columns).some(key => !Object.hasOwn(table.columns, key))) throw new DatabaseSchemaError("ambiguous_column_rename");
      }
    }
  }
  return generateSQLiteMigration(before, next.snapshot);
}
export interface AppliedApplicationMigration { readonly digest: string; readonly appliedAt: number; readonly statements: readonly string[]; }
/** Platform/CLI migration runner; only declared objects and the migration ledger are changed. */
/** newerDigests: schemas of releases newer than input's; a ledger already at one of them is never down-migrated. */
export async function synchronizeApplicationSchema(db: Pick<WorkspaceDatabase, "execute" | "transaction">, input: ApplicationDatabaseSchema, newerDigests: ReadonlySet<string> = new Set()): Promise<AppliedApplicationMigration | undefined> {
  const next = validateApplicationSchema(input);
  await db.execute(`CREATE TABLE IF NOT EXISTS cantelop_application_migrations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, digest TEXT NOT NULL, snapshot TEXT NOT NULL,
    statements TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const tx = await db.transaction("write");
  try {
    const rows = (await tx.execute("SELECT digest, snapshot FROM cantelop_application_migrations ORDER BY sequence DESC LIMIT 1")).rows;
    const latest = rows[0];
    if (latest?.digest === next.digest) { await tx.commit(); return undefined; }
    // Re-activating a historical release keeps the newer physical schema; it never down-migrates.
    if ((latest && newerDigests.has(String(latest.digest))) ||
        (await tx.execute({ sql: "SELECT digest FROM cantelop_application_migrations WHERE digest=? LIMIT 1", args: [next.digest] })).rows.length) {
      await tx.commit(); return undefined;
    }
    const previous = latest ? JSON.parse(String(latest.snapshot)) as ApplicationDatabaseSchema : undefined;
    // Newly declared tables must not already exist outside managed history.
    const managed: Record<string, unknown> = previous?.snapshot?.tables ?? {};
    const existing = (await tx.execute("SELECT name FROM sqlite_schema WHERE type='table'")).rows;
    if (existing.some(row => Object.hasOwn(next.snapshot.tables, String(row.name)) && !Object.hasOwn(managed, String(row.name)))) throw new DatabaseSchemaError("unmanaged_table_conflict");
    const statements = await migrationSQL(previous ? validateApplicationSchema(previous) : undefined, next);
    for (const statement of statements) {
      try { await tx.execute(statement); }
      catch (error) {
        // SQL rejected by the data itself fails identically on every retry.
        const code = String((error as { code?: unknown })?.code ?? "");
        if (/^SQLITE_(?!BUSY|LOCKED|IOERR|FULL|NOMEM|INTERRUPT|ABORT)|^SQL_/.test(code)) throw new DatabaseSchemaError("migration_failed");
        throw error;
      }
    }
    const appliedAt = Date.now();
    await tx.execute({ sql: "INSERT INTO cantelop_application_migrations(digest,snapshot,statements,applied_at) VALUES(?,?,?,?)", args: [next.digest, JSON.stringify(next), JSON.stringify(statements), appliedAt] });
    await tx.commit();
    return { digest: next.digest, appliedAt, statements };
  } finally { tx.close(); }
}

/** CLI-only local file access. Workloads receive a separately authorized HTTP connection. */
export async function synchronizeLocalDatabase(filename: string, schema?: ApplicationDatabaseSchema): Promise<AppliedApplicationMigration | undefined> {
  const { createClient } = await import("@libsql/client");
  const db = createClient({ url: `file:${filename}` });
  try {
    return schema ? await synchronizeApplicationSchema(db, schema) : undefined;
  } finally { db.close(); }
}
