/// <reference types="node" />
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_SYNC_ENTRIES, MAX_SYNC_FILE_BYTES, MAX_SYNC_SCAN_BYTES, SYNC_PUBLIC_PREFIX,
  WorkspaceSyncError, validSyncPath,
  type SyncEntry, type SyncConflict, type WorkspaceSync, type WorkspaceSyncOptions, type WorkspaceSyncStatus,
} from "./sync.js";
import { EDGE_ORIGIN } from "./shared.js";

type Fetch = (request: Request) => Promise<Response>;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 8192;
const HELPER_HANDSHAKE_MS = 10_000;
const HELPER_STOP_MS = 6000;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MAX_PASSES_PER_CYCLE = 3;
/** Codes that mean the helper or transport is gone, rather than one path failing. */
const FATAL_PASS_CODES = ["sync_unavailable", "sync_busy", "sync_helper_stopped"];
const OFFLINE_CODES = ["sync_unavailable", "sync_busy"];
const OPTION_KEYS = ["localDirectory", "remoteDirectory", "ignore", "pollIntervalMs", "signal"];

const hash = (data: Uint8Array, executable: boolean) =>
  createHash("sha256").update(new Uint8Array([executable ? 1 : 0])).update(data).digest("hex");
const versionPattern = /^[0-9a-f]{64}$/;
const syncMethod = (op: string) => op === "write" ? "PUT" : op === "remove" ? "DELETE" : "GET";
function syncQuery(query: URLSearchParams, op: string, name?: string, version?: string, executable?: boolean) {
  query.set("op", op);
  if (name !== undefined) { query.set("path", name); query.set("base", version ?? "missing"); }
  if (executable !== undefined) query.set("executable", executable ? "1" : "0");
  return query;
}

function stateDirectory(): string {
  if (process.env.CANTELOP_SYNC_STATE_HOME) return process.env.CANTELOP_SYNC_STATE_HOME;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "cantelop", "sync");
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "cantelop", "sync");
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new WorkspaceSyncError("sync_response_limit");
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
}

async function readJSON<T>(response: Response, limit: number): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await responseBytes(response, limit))) as T;
}

/** Maps a failed response to its protocol error code, falling back to a status-derived default. */
async function responseError(response: Response, fallback: string): Promise<WorkspaceSyncError> {
  let code = response.status === 409 ? "sync_conflict" : fallback;
  try {
    const failure = await readJSON<{ error?: { code?: string } }>(response, MAX_ERROR_BYTES);
    if (typeof failure.error?.code === "string") code = failure.error.code;
  } catch {}
  return new WorkspaceSyncError(code);
}

async function localAgent(directory: string, workspaceId: string) {
  const helper = fileURLToPath(new URL(`./native/${process.platform}-${process.arch}/sync-helper`, import.meta.url));
  const child = spawn(helper, [
    "--directory", path.resolve(directory),
    "--workspace", workspaceId,
    "--state-directory", path.resolve(stateDirectory()),
  ], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
  let diagnostic = "";
  child.stderr.on("data", (data: Buffer) => { diagnostic = (diagnostic + data.toString()).slice(-4096); });
  let closed = false;
  const completion = new Promise<void>(resolve => {
    child.once("exit", () => { closed = true; resolve(); });
    child.once("error", () => { closed = true; resolve(); });
  });
  const stop = async () => {
    if (closed) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), HELPER_STOP_MS);
    timer.unref();
    try { await completion; } finally { clearTimeout(timer); }
  };
  try {
    const line = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new WorkspaceSyncError("sync_helper_unavailable")), HELPER_HANDSHAKE_MS);
      const finished = () => { clearTimeout(timer); child.stdout.off("data", data); };
      const data = (bytes: Buffer) => {
        output += bytes.toString();
        if (output.length > 8192) { finished(); reject(new WorkspaceSyncError("sync_invalid_helper")); }
        else if (output.includes("\n")) { finished(); resolve(output.split("\n", 1)[0]!); }
      };
      child.stdout.on("data", data);
      child.once("error", () => { finished(); reject(new WorkspaceSyncError("sync_helper_unavailable")); });
      child.once("exit", () => {
        finished();
        reject(new WorkspaceSyncError(diagnostic.includes("sync_locked") ? "sync_locked" : "sync_local_setup_failed"));
      });
    });
    child.stdout.resume();
    let hello: { protocolVersion: number; origin: string; token: string; directory: string };
    try { hello = JSON.parse(line) as typeof hello; } catch { throw new WorkspaceSyncError("sync_helper_unavailable"); }
    const origin = new URL(hello.origin);
    if (hello.protocolVersion !== 1 || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port ||
        origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password ||
        !/^[0-9a-f]{64}$/.test(hello.token) || !path.isAbsolute(hello.directory)) throw new WorkspaceSyncError("sync_invalid_helper");
    const send = async (pathname: string, method: string, signal: AbortSignal, data?: Uint8Array) => {
      if (closed) throw new WorkspaceSyncError("sync_helper_stopped");
      const response = await globalThis.fetch(new URL(pathname, origin), {
        method, signal, redirect: "error",
        headers: { Authorization: `Bearer ${hello.token}`, "Content-Type": "application/octet-stream" },
        ...(data === undefined ? {} : { body: data as BodyInit }),
      });
      if (!response.ok) throw await responseError(response, "sync_local_error");
      return response;
    };
    return { directory: hello.directory, send, stop, closed: () => closed };
  } catch (error) {
    await stop();
    throw error;
  }
}

function entry(value: unknown): SyncEntry {
  const v = value as SyncEntry;
  if (!v || !validSyncPath(v.path) || !versionPattern.test(v.version) || !Number.isSafeInteger(v.size) || v.size < 0 ||
      typeof v.executable !== "boolean") throw new WorkspaceSyncError("sync_invalid_manifest");
  return v;
}

function assertSyncOptions(options: WorkspaceSyncOptions): void {
  if (!options || Object.keys(options).some(key => !OPTION_KEYS.includes(key)) ||
      typeof options.localDirectory !== "string" || !options.localDirectory ||
      options.pollIntervalMs !== undefined && (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 100 || options.pollIntervalMs > 60_000)) {
    throw new TypeError("Invalid sync options");
  }
}

interface SyncState {
  protocolVersion: number;
  workspaceId: string;
  directory: string;
  remoteDirectory?: string;
  base: Record<string, string>;
}

export async function startSync(options: WorkspaceSyncOptions, workspaceId: string, fetch: Fetch): Promise<WorkspaceSync> {
  assertSyncOptions(options);
  const remoteDirectory = options.remoteDirectory;
  if (remoteDirectory !== undefined && typeof remoteDirectory !== "string") throw new TypeError("Invalid sync directory name");
  const rootName = remoteDirectory ?? "project";
  // Nonlegacy baselines must fail closed if opened by an older SDK.
  const stateVersion = rootName === "project" ? 1 : 2;
  // Match the native adapter and platform exclusion grammar.
  if (rootName !== "" && !validSyncPath(rootName)) throw new TypeError("Invalid sync directory name");
  if (!["linux", "darwin"].includes(process.platform) || !["arm64", "x64"].includes(process.arch)) throw new WorkspaceSyncError("sync_platform_unsupported");
  options.signal?.throwIfAborted();
  const ignores = options.ignore ?? [];
  if (!Array.isArray(ignores) || ignores.some(name => !validSyncPath(name, true))) throw new TypeError("Sync ignores must be relative paths or prefixes");
  const excluded = (name: string) => !validSyncPath(name) || ignores.some(ignore => name === ignore || name.startsWith(ignore + "/"));
  let agent = await localAgent(options.localDirectory, workspaceId);
  const directory = agent.directory;
  const controller = new AbortController();
  const signal = () => AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(options.signal ? [options.signal] : [])]);
  const localRequest = (op: string, name?: string, version?: string, data?: Uint8Array, executable?: boolean) =>
    agent.send("/files?" + syncQuery(new URLSearchParams(), op, name, version, executable), syncMethod(op), signal(), data);
  const local = {
    async scan(excluded: (name: string) => boolean) {
      const manifest = await readJSON<{ protocolVersion: number; entries: unknown[] }>(await localRequest("scan"), MAX_MANIFEST_BYTES);
      if (manifest.protocolVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_SYNC_ENTRIES) throw new WorkspaceSyncError("sync_invalid_manifest");
      return new Map(manifest.entries.map(entry).filter(value => !excluded(value.path)).map(value => [value.path, value]));
    },
    async read(name: string, expected: SyncEntry) {
      const data = await responseBytes(await localRequest("read", name, expected.version), MAX_SYNC_FILE_BYTES);
      if (data.length !== expected.size || hash(data, expected.executable) !== expected.version) throw new WorkspaceSyncError("sync_conflict");
      return { data, entry: expected };
    },
    async apply(name: string, expected: string | null, data: Uint8Array | null, executable = false) {
      await localRequest(data === null ? "remove" : "write", name, expected ?? undefined, data ?? undefined, data === null ? undefined : executable);
    },
  };
  try {
    let base: Record<string, string> = Object.create(null) as Record<string, string>;
    const previous = await agent.send("/state", "GET", signal());
    if (previous.status !== 204) {
      const state = await readJSON<SyncState>(previous, MAX_MANIFEST_BYTES);
      if (state.protocolVersion !== stateVersion || state.workspaceId !== workspaceId || state.directory !== directory ||
          (state.remoteDirectory ?? "project") !== rootName || !state.base || typeof state.base !== "object" || Array.isArray(state.base) ||
          Object.keys(state.base).length > MAX_SYNC_ENTRIES ||
          Object.entries(state.base).some(([key, value]) => !validSyncPath(key) || !versionPattern.test(value))) throw new WorkspaceSyncError("sync_invalid_state");
      base = Object.assign(Object.create(null) as Record<string, string>, state.base);
    }
    let stopped = false;
    let writable: boolean | undefined;
    let status: WorkspaceSyncStatus = Object.freeze({ state: "syncing", conflicts: [] });
    let tail: Promise<void> = Promise.resolve();
    // The persisted baseline, so an unchanged pass skips the state write.
    let savedBase = previous.status === 204 ? undefined : JSON.stringify(base);
    const save = async () => {
      const encoded = JSON.stringify(base);
      if (encoded === savedBase) return;
      const state: SyncState = { protocolVersion: stateVersion, workspaceId, directory, remoteDirectory: rootName, base };
      await agent.send("/state", "PUT", signal(), new TextEncoder().encode(JSON.stringify(state)));
      savedBase = encoded;
    };
    const request = async (op: string, name?: string, version?: string, data?: Uint8Array, executable?: boolean) => {
      const url = new URL(`${SYNC_PUBLIC_PREFIX}${workspaceId}`, EDGE_ORIGIN);
      syncQuery(url.searchParams, op, name, version, executable);
      if (rootName !== "project") url.searchParams.set("root", rootName);
      const response = await fetch(new Request(url, {
        method: syncMethod(op), signal: signal(),
        ...(data === undefined ? {} : { body: data as BodyInit, headers: { "Content-Type": "application/octet-stream" } }),
      }));
      if (!response.ok) throw await responseError(response, "sync_unavailable");
      return response;
    };
    const pass = async () => {
      const manifest = await readJSON<{ protocolVersion: number; root: string; writes: boolean; entries: unknown[] }>(await request("scan"), MAX_MANIFEST_BYTES);
      if (manifest.protocolVersion !== 1 || manifest.root !== rootName || typeof manifest.writes !== "boolean" ||
          !Array.isArray(manifest.entries) || manifest.entries.length > MAX_SYNC_ENTRIES) throw new WorkspaceSyncError("sync_invalid_manifest");
      writable = manifest.writes;
      const remote = new Map<string, SyncEntry>(), aliases = new Set<string>();
      let bytes = 0;
      for (const value of manifest.entries) {
        const item = entry(value), alias = item.path.normalize("NFC").toLowerCase();
        if (aliases.has(alias)) throw new WorkspaceSyncError("sync_case_collision");
        aliases.add(alias);
        bytes += item.size;
        if (bytes > MAX_SYNC_SCAN_BYTES) throw new WorkspaceSyncError("sync_scan_limit");
        if (!excluded(item.path)) remote.set(item.path, item);
      }
      const locals = await local.scan(excluded), conflicts: SyncConflict[] = [];
      let failure: WorkspaceSyncError | undefined, changed = false;
      const allAliases = new Map<string, string>();
      for (const name of [...locals.keys(), ...remote.keys()]) {
        const alias = name.normalize("NFC").toLowerCase(), previous = allAliases.get(alias);
        if (previous !== undefined && previous !== name) throw new WorkspaceSyncError("sync_case_collision");
        allAliases.set(alias, name);
      }
      const paths = [...new Set([...Object.keys(base), ...locals.keys(), ...remote.keys()])].filter(name => !excluded(name)).sort();
      for (const name of paths) {
        controller.signal.throwIfAborted();
        const l = locals.get(name), r = remote.get(name), b = base[name];
        if (l?.version === r?.version) { if (l) base[name] = l.version; else delete base[name]; continue; }
        if (l?.version !== b && r?.version !== b) { conflicts.push({ path: name, localVersion: l?.version ?? null, remoteVersion: r?.version ?? null }); continue; }
        if ((l?.size ?? 0) > MAX_SYNC_FILE_BYTES || (r?.size ?? 0) > MAX_SYNC_FILE_BYTES) { failure ??= new WorkspaceSyncError("sync_file_too_large"); continue; }
        try {
          if (l?.version !== b) {
            if (!manifest.writes) throw new WorkspaceSyncError("sync_writes_not_enabled");
            if (l) {
              const { data } = await local.read(name, l);
              const result = entry(await readJSON(await request("write", name, r?.version, data, l.executable), MAX_ERROR_BYTES));
              if (result.path !== name || result.version !== l.version) throw new WorkspaceSyncError("sync_invalid_response");
              base[name] = l.version;
            } else {
              await request("remove", name, r!.version);
              delete base[name];
            }
          } else if (r) {
            const data = await responseBytes(await request("read", name, r.version), MAX_SYNC_FILE_BYTES);
            if (data.length !== r.size || hash(data, r.executable) !== r.version) throw new WorkspaceSyncError("sync_checksum_mismatch");
            await local.apply(name, l?.version ?? null, data, r.executable);
            base[name] = r.version;
          } else {
            await local.apply(name, l!.version, null);
            delete base[name];
          }
        } catch (error) {
          // Divergence is decided from scans; a precondition failure here means a side changed mid-transfer, so rescan.
          if (!(error instanceof WorkspaceSyncError) || FATAL_PASS_CODES.includes(error.code)) throw error;
          if (error.code === "sync_conflict") changed = true; else failure ??= error;
        }
      }
      await save();
      return { conflicts, failure, changed };
    };
    const cycle = async () => {
      if (stopped) throw new WorkspaceSyncError("sync_stopped");
      writable = undefined;
      status = Object.freeze({ state: "syncing", conflicts: status.conflicts });
      try {
        if (agent.closed()) {
          const next = await localAgent(options.localDirectory, workspaceId);
          if (next.directory !== directory) { await next.stop(); throw new WorkspaceSyncError("sync_invalid_helper"); }
          agent = next;
        }
        let result = await pass();
        for (let attempt = 1; result.changed && attempt < MAX_PASSES_PER_CYCLE; attempt++) result = await pass();
        const { conflicts, failure, changed } = result;
        status = Object.freeze({
          state: conflicts.length ? "conflict" : "synced", conflicts: Object.freeze(conflicts),
          ...(writable === undefined ? {} : { writable }),
        });
        if (conflicts.length) throw new WorkspaceSyncError("sync_conflict");
        if (failure) throw failure;
        if (changed) throw new WorkspaceSyncError("sync_busy");
      } catch (error) {
        if (!stopped && status.state !== "conflict") {
          status = Object.freeze({
            state: error instanceof WorkspaceSyncError && !OFFLINE_CODES.includes(error.code) ? "error" : "offline",
            conflicts: [],
            error: error instanceof WorkspaceSyncError ? error.code : "sync_unavailable",
            ...(writable === undefined ? {} : { writable }),
          });
        }
        throw error;
      }
    };
    const flush = () => { const next = tail.then(cycle, cycle); tail = next.catch(() => {}); return next; };
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => stopPromise ??= (async () => {
      stopped = true;
      controller.abort();
      options.signal?.removeEventListener("abort", abort);
      await tail;
      await agent.stop();
      status = Object.freeze({ state: "stopped", conflicts: [] });
    })();
    const abort = () => { void stop().catch(() => {}); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) { await stop(); throw options.signal.reason; }
    let initial: Promise<void> | undefined;
    void (async () => {
      while (!stopped) {
        const next = flush();
        initial ??= next;
        await next.catch(() => {});
        try {
          await delay(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, undefined, { signal: controller.signal });
        } catch {
          break;
        }
      }
    })();
    return Object.freeze({
      remoteDirectory: "/workspace" + (rootName ? "/" + rootName : ""),
      ready: () => initial ?? flush(),
      flush,
      status: () => status,
      stop,
    });
  } catch (error) {
    controller.abort();
    await agent.stop();
    throw error;
  }
}
