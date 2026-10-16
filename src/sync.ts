/** The single public file capability; transfer operations are internal. */
export interface WorkspaceSyncOptions {
  readonly localDirectory: string;
  /** Additional relative paths or directory prefixes to exclude on both sides. */
  readonly ignore?: readonly string[];
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}
export interface SyncConflict {
  readonly path: string;
  readonly localVersion: string | null;
  readonly remoteVersion: string | null;
}
export interface WorkspaceSyncStatus {
  readonly state: "syncing" | "synced" | "offline" | "conflict" | "error" | "stopped";
  readonly conflicts: readonly SyncConflict[];
  readonly error?: string;
}
export interface WorkspaceSync {
  /** Reconcile both sides; rejects on unresolved conflicts or transfer errors. */
  ready(): Promise<void>;
  /** Perform a fresh reconciliation, including local changes made since ready(). */
  flush(): Promise<void>;
  status(): WorkspaceSyncStatus;
  /** Abort transfers, release the local lock, and leave files and state in place. */
  stop(): Promise<void>;
}
export class WorkspaceSyncError extends Error {
  constructor(readonly code: string) { super(code); this.name = "WorkspaceSyncError"; }
}

/** These constants and validators define the private version-1 transfer protocol. */
export const MAX_SYNC_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_SYNC_ENTRIES = 10_000;
export const MAX_SYNC_SCAN_BYTES = 128 * 1024 * 1024;
export const SYNC_TEMP_PREFIX = ".cantelop-sync-";
export const SYNC_PUBLIC_PREFIX = "/__cantelop/sync/workspaces/";
export const SYNC_PUBLIC_ROUTE = /^\/__cantelop\/sync\/workspaces\/(wsp_[0-9a-f]{32})$/;
export interface SyncEntry { readonly path: string; readonly version: string; readonly size: number; readonly executable: boolean }
export function validSyncPath(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith("/") || /[\\\x00\r\n]/.test(path)) return false;
  const parts = path.split("/");
  return parts.length <= 32 && parts.every(part => part !== "" && part !== "." && part !== ".." &&
    !part.startsWith(SYNC_TEMP_PREFIX) && ![".git", ".cantelop", "node_modules", ".env"].includes(part) && !part.startsWith(".env."));
}
export function validSyncRequest(method: string, query: URLSearchParams): boolean {
  for (const key of query.keys()) if (!["op", "path", "base", "executable"].includes(key) || query.getAll(key).length !== 1) return false;
  const op = query.get("op");
  if (op === "scan") return method === "GET" && [...query.keys()].length === 1;
  if (!validSyncPath(query.get("path") ?? "") || !/^(missing|[0-9a-f]{64})$/.test(query.get("base") ?? "")) return false;
  if (query.has("executable") && (op !== "write" || !/^[01]$/.test(query.get("executable") ?? ""))) return false;
  return op === "read" && method === "GET" || op === "write" && method === "PUT" || op === "remove" && method === "DELETE";
}
