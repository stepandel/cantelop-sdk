/// <reference types="node" />

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { setMaxListeners } from "node:events";
import { createSessionDatabase } from "./session-database.js";
import type { WorkspaceDatabase } from "./database.js";
import {
  CODEX_WORKSPACE_STORAGE_METHOD, CODEX_WORKSPACE_STORAGE_PROTOCOL_VERSION,
  startCodexWorkspaceStorage, CodexStorageError,
} from "./codex-storage.js";
export {
  CODEX_WORKSPACE_STORAGE_METHOD, CODEX_WORKSPACE_STORAGE_PROTOCOL_VERSION,
  createCodexWorkspaceStorage, CodexStorageError,
} from "./codex-storage.js";
export type {
  CodexDatabaseResult, CodexDatabaseStatement, CodexDatabaseValue, CodexWorkspaceStorage,
} from "./codex-storage.js";

const exec = promisify(execFile);
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 128;
const MAX_SERVER_REQUESTS = 128;
const MAX_TURN_EVENTS = 1024;
const MAX_TURN_BYTES = 16 * 1024 * 1024;

/** Required coverage for a full replacement of Codex-owned SQLite persistence. */
export const CODEX_WORKSPACE_STORAGE_DOMAINS = Object.freeze([
  "threads", "history", "metadata", "projects", "sections", "attachments",
  "agent_graph", "goals", "memories", "queues", "logs", "remote_control", "imports", "message_boards",
] as const);

export interface CodexNotification {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}
export interface CodexServerRequest extends CodexNotification {
  readonly id: string | number;
}
export interface CodexExecutable {
  readonly command: string;
  /** Prefix arguments, for example when invoking a native build through a wrapper. */
  readonly args?: readonly string[];
}
export interface CodexOptions {
  /** Requires a native build implementing the Cantelop storage contract. Stock Codex is rejected. */
  readonly executable?: string | CodexExecutable;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Borrowed client. Omit to use the current Session's renewable workspace database. */
  readonly database?: WorkspaceDatabase;
  readonly requestTimeoutMs?: number;
  /** Handle approval and other native server requests. Unhandled requests are rejected. */
  readonly onRequest?: (request: CodexServerRequest) => Promise<unknown>;
}
export interface CodexRequestOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface CodexThreadOptions {
  readonly model?: string;
  readonly cwd?: string;
  readonly approvalPolicy?: "never" | "on-request" | "untrusted";
  readonly config?: Readonly<Record<string, unknown>>;
}

export class CodexError extends Error {
  constructor(readonly code: string, message = `Codex: ${code}`) { super(message); this.name = "CodexError"; }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

/** A native app-server connection; create with createCodex(). */
export class CodexClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly subscribers = new Set<(event: CodexNotification) => void>();
  private readonly serverOperations = new Set<Promise<void>>();
  private nextId = 1;
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private closingRequested = false;
  private readonly exited: Promise<void>;
  private readonly exitSignal = new AbortController();
  private readonly reader: Promise<void>;
  private writing: Promise<void> = Promise.resolve();

  /** @internal */
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly database: WorkspaceDatabase,
    private readonly ownsDatabase: boolean,
    private readonly options: CodexOptions,
    private readonly bridge: Awaited<ReturnType<typeof startCodexWorkspaceStorage>>,
  ) {
    setMaxListeners(MAX_SERVER_REQUESTS + 1, this.exitSignal.signal);
    this.exited = new Promise(resolve => child.once("close", () => { this.exitSignal.abort(); resolve(); }));
    child.once("error", () => this.fail(new CodexError("process_failed")));
    child.once("exit", () => this.fail(new CodexError("process_exited")));
    // Drain diagnostics without copying potentially sensitive model/tool output into SDK errors.
    child.stderr.resume();
    child.stdin.on("error", () => this.fail(new CodexError("transport_failed")));
    this.reader = this.read().catch(error => this.fail(error instanceof CodexError ? error : new CodexError("transport_failed")));
  }

  /** Raw app-server request. Timeouts do not replay requests or prove the native operation failed. */
  request<T = unknown>(method: string, params: Readonly<Record<string, unknown>> = {}, options: CodexRequestOptions = {}): Promise<T> {
    if (this.failure || this.closingRequested) return Promise.reject(this.failure ?? new CodexError("client_closed"));
    if (!method || this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(new CodexError("request_limit"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new CodexError("request_aborted"));
    const timeout = options.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400_000) return Promise.reject(new CodexError("invalid_timeout"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = () => settle(options.signal?.reason ?? new CodexError("request_aborted"));
      const timer = setTimeout(() => settle(new CodexError("request_timeout")), timeout);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      const settle = (error: Error) => { if (!this.pending.delete(id)) return; cleanup(); reject(error); };
      this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      void this.write({ id, method, params }).catch(() => settle(new CodexError("transport_failed")));
    });
  }

  async startThread(options: CodexThreadOptions = {}): Promise<CodexThread> {
    const result = await this.request<{ thread: { id: string } }>("thread/start", options as Readonly<Record<string, unknown>>);
    return new CodexThread(this, threadId(result));
  }

  async resumeThread(id: string, options: CodexThreadOptions = {}): Promise<CodexThread> {
    if (!id) throw new CodexError("invalid_thread_id");
    const result = await this.request<{ thread: { id: string } }>("thread/resume", { ...options, threadId: id });
    if (threadId(result) !== id) throw new CodexError("thread_id_changed");
    return new CodexThread(this, id);
  }

  /** Subscribe synchronously so callers can listen before submitting a turn. */
  onNotification(listener: (event: CodexNotification) => void): () => void {
    if (this.failure || this.closingRequested) throw this.failure ?? new CodexError("client_closed");
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Flush native persistence while the storage bridge is alive, then reap the process. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      let shutdownError: unknown;
      const shutdown = !this.failure ? this.request("cantelop/shutdown", {}, { timeoutMs: 45_000 }) : undefined;
      this.closingRequested = true;
      if (shutdown) {
        try { await shutdown; }
        catch (error) { shutdownError = error; }
      }
      this.child.stdin.end();
      const failed = !!this.failure || !!shutdownError;
      const term = setTimeout(() => this.child.kill("SIGTERM"), failed ? 1000 : 15_000);
      const kill = setTimeout(() => this.child.kill("SIGKILL"), failed ? 3000 : 20_000);
      try { await this.exited; await this.reader; await Promise.allSettled([...this.serverOperations]); await this.bridge.close(); }
      finally {
        clearTimeout(term); clearTimeout(kill);
        if (this.ownsDatabase) this.database.close();
        this.fail(new CodexError("client_closed"));
      }
      if (shutdownError) throw shutdownError;
    })();
    return this.closing;
  }

  /** @internal */
  async initialize(): Promise<void> {
    const result = await this.request<Record<string, unknown>>("initialize", {
      clientInfo: { name: "cantelop_sdk", title: "Cantelop SDK", version: "0.17.0" },
      capabilities: { experimentalApi: true, cantelopWorkspaceStorage: { protocolVersion: CODEX_WORKSPACE_STORAGE_PROTOCOL_VERSION } },
    });
    verifyStorageCapabilities(result.cantelopWorkspaceStorage);
    await this.write({ method: "initialized", params: {} });
  }

  private write(message: unknown): Promise<void> {
    let frame: string;
    try {
      frame = `${JSON.stringify(message)}\n`;
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new CodexError("frame_limit");
    } catch (error) { return Promise.reject(error); }
    const write = this.writing.then(() => new Promise<void>((resolve, reject) => {
      if (this.child.stdin.destroyed) { reject(new CodexError("transport_closed")); return; }
      this.child.stdin.write(frame, error => error ? reject(new CodexError("transport_failed")) : resolve());
    }));
    this.writing = write.catch(() => undefined);
    return write;
  }

  private async read() {
    let fragments: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.child.stdout) {
      const bytes = Buffer.from(chunk);
      let start = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
        const fragment = bytes.subarray(start, end);
        size += fragment.byteLength;
        if (size > MAX_FRAME_BYTES) throw new CodexError("frame_limit");
        fragments.push(fragment);
        const line = Buffer.concat(fragments, size).toString("utf8");
        fragments = []; size = 0; start = end + 1;
        if (line.trim()) this.receive(JSON.parse(line));
      }
      if (start < bytes.byteLength) {
        const remainder = bytes.subarray(start);
        size += remainder.byteLength;
        if (size > MAX_FRAME_BYTES) throw new CodexError("frame_limit");
        fragments.push(remainder);
      }
    }
    if (size !== 0) throw new CodexError("truncated_frame");
    if (!this.closingRequested) this.fail(new CodexError("transport_closed"));
  }

  private receive(value: unknown) {
    const message = object(value);
    if (typeof message.method === "string") {
      const params = message.params === undefined ? {} : object(message.params);
      if (message.id !== undefined) {
        if (typeof message.id !== "string" && typeof message.id !== "number") throw new CodexError("invalid_frame");
        if (this.serverOperations.size >= MAX_SERVER_REQUESTS) throw new CodexError("server_request_limit");
        const request: CodexServerRequest = { id: message.id, method: message.method, params };
        const operation = this.respond(request);
        this.serverOperations.add(operation);
        void operation.finally(() => this.serverOperations.delete(operation)).catch(() => this.fail(new CodexError("transport_failed")));
      } else {
        const notification = { method: message.method, params };
        for (const listener of this.subscribers) {
          try { listener(notification); } catch { this.fail(new CodexError("notification_handler_failed")); break; }
        }
      }
      return;
    }
    if (typeof message.id !== "number") throw new CodexError("invalid_frame");
    const pending = this.pending.get(message.id);
    if (!pending) return; // A timed-out request can still produce a late reply.
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error !== undefined) {
      const error = object(message.error);
      // Error text from the native process may include secrets or SQL arguments.
      pending.reject(new CodexError("native_request_failed", `Codex native request failed (${typeof error.code === "number" ? error.code : "unknown"})`));
    } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
    else { pending.reject(new CodexError("invalid_frame")); throw new CodexError("invalid_frame"); }
  }

  private async respond(request: CodexServerRequest) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onExit: (() => void) | undefined;
    try {
      const response = request.method === CODEX_WORKSPACE_STORAGE_METHOD
        ? this.bridge.storage.handle(request.params)
        : this.options.onRequest ? this.options.onRequest(request) : Promise.reject(new CodexError("unhandled_server_request"));
      const result = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          onExit = () => reject(new CodexError("process_exited"));
          if (this.exitSignal.signal.aborted) onExit();
          else this.exitSignal.signal.addEventListener("abort", onExit, { once: true });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CodexError("request_timeout")), this.options.requestTimeoutMs ?? 30_000);
          timer.unref();
        }),
      ]);
      await this.write({ id: request.id, result: result ?? null });
    } catch (error) {
      await this.write({ id: request.id, error: { code: -32000, message: error instanceof CodexStorageError ? error.message : "Codex server request rejected" } });
    } finally {
      clearTimeout(timer);
      if (onExit) this.exitSignal.signal.removeEventListener("abort", onExit);
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.subscribers) {
      try { listener({ method: "cantelop/connectionClosed", params: { code: error instanceof CodexError ? error.code : "transport_failed" } }); } catch { }
    }
    this.subscribers.clear();
    if (!this.closingRequested) {
      this.child.kill("SIGTERM");
      // Reap failed children and their bridge even when the caller forgets to close.
      queueMicrotask(() => { void this.close().catch(() => undefined); });
    }
  }
}

/**
 * Open a workspace-backed native Codex build. No stock CLI fallback or automatic binary install.
 * The capability probe runs before app-server startup and before opening the workspace database.
 */
export async function createCodex(options: CodexOptions = {}): Promise<CodexClient> {
  if (options.requestTimeoutMs !== undefined && (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 86_400_000)) {
    throw new CodexError("invalid_timeout");
  }
  const specification = options.executable ?? options.env?.CANTELOP_CODEX_PATH ?? process.env.CANTELOP_CODEX_PATH ?? "cantelop-codex";
  const executable = typeof specification === "string" ? { command: specification, args: [] } : specification;
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  // The native process uses the bridge, never the platform credential-broker capability.
  delete env.CANTELOP_WORKSPACE_DATABASE_ACCESS_TOKEN;
  delete env.CANTELOP_WORKSPACE_DATABASE_CREDENTIALS_URL;
  let capabilities: unknown;
  try {
    const probe = await exec(executable.command, [...executable.args ?? [], "--cantelop-storage-probe"], {
      ...(options.cwd ? { cwd: options.cwd } : {}), env, timeout: 30_000, maxBuffer: 64 * 1024,
    });
    capabilities = JSON.parse(probe.stdout);
  } catch {
    throw new CodexError("workspace_backend_unavailable", "A Cantelop-enabled native Codex build is required; stock Codex cannot replace its SQLite stores.");
  }
  verifyStorageCapabilities(capabilities);
  const database = options.database ?? createSessionDatabase({ ...process.env, ...options.env }, fetch, { intMode: "bigint" });
  try { await database.credentials(); }
  catch (error) { if (!options.database) database.close(); throw error; }
  let bridge: Awaited<ReturnType<typeof startCodexWorkspaceStorage>>;
  try { bridge = await startCodexWorkspaceStorage(database); }
  catch (error) { if (!options.database) database.close(); throw error; }
  const child = spawn(executable.command, [...executable.args ?? [], "app-server", "--listen", "stdio://"], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...env, CANTELOP_CODEX_STORAGE_TRANSPORT: "http-v1", CANTELOP_CODEX_STORAGE_URL: bridge.url, CANTELOP_CODEX_STORAGE_TOKEN: bridge.token }, stdio: ["pipe", "pipe", "pipe"], shell: false,
  });
  const client = new CodexClient(child, database, !options.database, options, bridge);
  try { await client.initialize(); return client; }
  catch (error) { await client.close().catch(() => undefined); throw error; }
}

/** A durable thread handle. Persistence and replay remain native backend responsibilities. */
export class CodexThread {
  private active = false;
  private currentTurnId: string | undefined;
  constructor(private readonly client: CodexClient, readonly id: string) { }

  steer(prompt: string, expectedTurnId: string): Promise<unknown> {
    return this.client.request("turn/steer", { threadId: this.id, expectedTurnId, input: [{ type: "text", text: prompt }] });
  }
  interrupt(turnId = this.currentTurnId): Promise<unknown> {
    if (!turnId) return Promise.reject(new CodexError("no_active_turn"));
    return this.client.request("turn/interrupt", { threadId: this.id, turnId });
  }

  /** Stream raw Codex turn/item events; an early return interrupts the native turn. */
  async *run(prompt: string, options: { readonly signal?: AbortSignal } = {}): AsyncGenerator<CodexNotification> {
    if (this.active) throw new CodexError("turn_already_active");
    if (options.signal?.aborted) throw options.signal.reason ?? new CodexError("turn_aborted");
    this.active = true;
    const events: { event: CodexNotification; bytes: number }[] = [];
    let pendingBytes = 0;
    let wake: (() => void) | undefined;
    let error: unknown;
    let completed = false;
    let submitted = false;
    let turnId: string | undefined;
    let interrupting: Promise<unknown> | undefined;
    const abort = () => {
      error = options.signal?.reason ?? new CodexError("turn_aborted"); wake?.();
      if (turnId) interrupting ??= this.interrupt(turnId).catch(() => undefined);
    };
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = this.client.onNotification(event => {
        if (event.method === "cantelop/connectionClosed") { error = new CodexError("transport_closed"); wake?.(); return; }
        if (event.params.threadId !== this.id) return;
        const candidateTurnId = notificationTurnId(event);
        if (turnId && candidateTurnId && candidateTurnId !== turnId) return;
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (events.length >= MAX_TURN_EVENTS || pendingBytes + bytes > MAX_TURN_BYTES) {
          error = new CodexError("turn_event_limit"); wake?.(); return;
        }
        events.push({ event, bytes }); pendingBytes += bytes; wake?.();
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      // Don't cancel the admission request: its response is needed to know which turn was admitted.
      const result = await this.client.request<{ turn: { id: string } }>("turn/start", { threadId: this.id, input: [{ type: "text", text: prompt }] });
      submitted = true;
      if (!result?.turn || typeof result.turn.id !== "string") throw new CodexError("invalid_turn_response");
      turnId = result.turn.id;
      this.currentTurnId = turnId;
      while (true) {
        if (error) throw error;
        const queued = events.shift();
        if (!queued) { await new Promise<void>(resolve => { wake = resolve; }); wake = undefined; continue; }
        pendingBytes -= queued.bytes;
        const event = queued.event;
        const candidateTurnId = notificationTurnId(event);
        if (candidateTurnId && candidateTurnId !== turnId) continue;
        if (event.method === "turn/completed") {
          completed = true;
          const turn = object(event.params.turn);
          yield event;
          if (turn.status === "failed") throw new CodexError("turn_failed");
          if (turn.status === "interrupted") throw new CodexError("turn_interrupted");
          if (turn.status !== "completed") throw new CodexError("invalid_turn_status");
          return;
        }
        yield event;
      }
    } finally {
      unsubscribe?.();
      options.signal?.removeEventListener("abort", abort);
      if (submitted && !completed && turnId) await (interrupting ?? this.interrupt(turnId).catch(() => undefined));
      this.currentTurnId = undefined;
      this.active = false;
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodexError("invalid_frame");
  return value as Record<string, unknown>;
}
function threadId(value: unknown): string {
  const thread = object(object(value).thread);
  if (typeof thread.id !== "string" || !thread.id) throw new CodexError("invalid_thread_response");
  return thread.id;
}
function notificationTurnId(event: CodexNotification): string | undefined {
  if (typeof event.params.turnId === "string") return event.params.turnId;
  if (event.params.turn && typeof event.params.turn === "object") {
    const turn = event.params.turn as Record<string, unknown>;
    if (typeof turn.id === "string") return turn.id;
  }
  return undefined;
}
function verifyStorageCapabilities(value: unknown): void {
  let capabilities: Record<string, unknown>;
  try { capabilities = object(value); } catch { throw new CodexError("incompatible_workspace_backend"); }
  if (capabilities.protocolVersion !== CODEX_WORKSPACE_STORAGE_PROTOCOL_VERSION ||
      capabilities.backend !== "workspace" || capabilities.localSqlite !== false ||
      !Array.isArray(capabilities.domains) || CODEX_WORKSPACE_STORAGE_DOMAINS.some(domain => !(capabilities.domains as unknown[]).includes(domain))) {
    throw new CodexError("incompatible_workspace_backend", "The native Codex build must support all workspace storage domains with local SQLite disabled.");
  }
}
