/// <reference types="node" />
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TERMINAL_TICKET_PATTERN, type AppAuth, type AuthCommand, type AuthContext, type AuthResult, type AuthTerminalProcess } from "./native-auth.js";
import type { SessionIdentity } from "./resources.js";
import { RuntimeProtocolError } from "./runtime-messages.js";

const CONNECT_MS = 60_000;
const LOGIN_MS = 10 * 60_000;
const STOP_MS = 5_000;
const MAX_PENDING_OUTPUT = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_BUFFERED_OUTPUT = 1024 * 1024;

/** Platform → Sandbox terminal routes. The platform terminates the browser's WebSocket. */
export const AUTH_TERMINAL_ROUTE = /^\/__cantelop\/v2\/runtime\/auth\/terminals\/(trm_[0-9a-f]{32})\/(attach|input|resize)$/;
export const TERMINAL_TICKET_HEADER = "x-cantelop-terminal-ticket";

interface Terminal {
  readonly id: string;
  readonly digest: Buffer;
  readonly process: AuthTerminalProcess;
  readonly connectBy: number;
  readonly closed: Promise<void>;
  readonly timers: ReturnType<typeof setTimeout>[];
  ended: boolean;
  output?: ServerResponse;
  pending: Buffer[];
  pendingBytes: number;
}

/**
 * One interactive native login per Workspace auth Sandbox. Terminal bytes are relayed
 * in memory only: never logged, persisted, parsed or replayed to a second attachment.
 */
export class AuthTerminals {
  #current: Terminal | undefined;
  readonly #auth: AppAuth;
  readonly #env: AuthContext["env"];
  readonly #lifetime: AbortSignal;
  readonly #changed: () => void;

  constructor(auth: AppAuth, env: AuthContext["env"], lifetime: AbortSignal, changed: () => void) {
    this.#auth = auth; this.#env = env; this.#lifetime = lifetime; this.#changed = changed;
    lifetime.addEventListener("abort", () => { void this.#stop(); }, { once: true });
  }

  get active(): boolean { return this.#current !== undefined; }

  async handle(command: AuthCommand, session: SessionIdentity): Promise<AuthResult> {
    const context: AuthContext = Object.freeze({ signal: this.#lifetime, session, env: this.#env });
    const status = async (): Promise<AuthResult> => {
      const authenticated = await this.#auth.status(context);
      if (typeof authenticated !== "boolean") throw new TypeError("App auth status must return a boolean");
      return { type: "status", authenticated };
    };
    switch (command.type) {
      case "status": return status();
      case "logout":
        await this.#stop();
        await this.#auth.logout(context);
        return status();
      case "close":
        if (this.#current?.id === command.terminalId) await this.#stop();
        return { type: "closed", terminalId: command.terminalId };
      case "terminal": {
        await this.#stop();
        this.#lifetime.throwIfAborted();
        const ticket = randomBytes(32).toString("hex");
        const terminal = this.#start(await this.#auth.terminal(context), createHash("sha256").update(ticket).digest());
        return { type: "terminal", terminalId: terminal.id, ticket, expiresAt: new Date(terminal.connectBy).toISOString() };
      }
    }
  }

  /** Serves one platform terminal route. The ticket header authenticates every call. */
  async serve(request: IncomingMessage, response: ServerResponse, terminalId: string, operation: "attach" | "input" | "resize"): Promise<void> {
    if (request.method !== "POST") throw new RuntimeProtocolError(405, "method_not_allowed");
    const terminal = this.#current;
    if (!terminal || terminal.id !== terminalId || terminal.ended) throw new RuntimeProtocolError(404, "terminal_not_found");
    const ticket = request.headers[TERMINAL_TICKET_HEADER];
    if (typeof ticket !== "string" || !TERMINAL_TICKET_PATTERN.test(ticket) ||
        !timingSafeEqual(createHash("sha256").update(ticket).digest(), terminal.digest)) throw new RuntimeProtocolError(401, "terminal_unauthorized");
    if (operation === "attach") {
      if (terminal.output || Date.now() > terminal.connectBy) throw new RuntimeProtocolError(410, "terminal_attached");
      this.#attach(terminal, request, response);
      return;
    }
    if (!terminal.output) throw new RuntimeProtocolError(409, "terminal_not_attached");
    const body = await readBody(request);
    if (operation === "input") {
      if (!terminal.ended && body.length) terminal.process.stdin!.write(body);
    } else {
      let value: { columns?: unknown; rows?: unknown };
      try { value = JSON.parse(body.toString("utf8")); } catch { throw new RuntimeProtocolError(400, "invalid_terminal_resize"); }
      const { columns, rows } = value ?? {};
      if (!Number.isInteger(columns) || !Number.isInteger(rows) || (columns as number) < 20 || (columns as number) > 1000 || (rows as number) < 5 || (rows as number) > 500) throw new RuntimeProtocolError(400, "invalid_terminal_resize");
      if (!terminal.ended) terminal.process.resize?.(columns as number, rows as number);
    }
    response.statusCode = 204;
    response.end();
  }

  #attach(terminal: Terminal, request: IncomingMessage, response: ServerResponse): void {
    terminal.output = response;
    response.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.flushHeaders?.();
    for (const chunk of terminal.pending) response.write(chunk);
    terminal.pending = []; terminal.pendingBytes = 0;
    // A disconnected user abandons the login; a fresh terminal() starts another.
    const detached = () => { if (!response.writableEnded && this.#current === terminal) void this.#stop(); };
    request.once("aborted", detached);
    response.once("close", detached);
    if (terminal.ended) response.end();
  }

  #start(process: AuthTerminalProcess, digest: Buffer): Terminal {
    if (!process || !process.stdin || !process.stdout || typeof process.kill !== "function" || typeof process.once !== "function") {
      try { process?.kill?.("SIGKILL"); } catch { /* best effort */ }
      throw new TypeError("App auth terminal must return a process with stdin and stdout");
    }
    let resolveClosed!: () => void;
    const terminal: Terminal = {
      id: `trm_${randomBytes(16).toString("hex")}`, digest, process, connectBy: Date.now() + CONNECT_MS,
      closed: new Promise(resolve => { resolveClosed = resolve; }), timers: [], ended: false, pending: [], pendingBytes: 0,
    };
    const kill = () => this.#kill(terminal);
    terminal.timers.push(setTimeout(() => { if (!terminal.output) kill(); }, CONNECT_MS), setTimeout(kill, LOGIN_MS));
    for (const timer of terminal.timers) timer.unref?.();
    process.stdin.on("error", () => undefined);
    process.stdout.on("error", () => undefined);
    process.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (terminal.output) {
        terminal.output.write(bytes);
        // A stalled reader must not grow Sandbox memory without bound.
        if (terminal.output.writableLength > MAX_BUFFERED_OUTPUT) kill();
      } else if (terminal.pendingBytes + bytes.length <= MAX_PENDING_OUTPUT) { terminal.pending.push(bytes); terminal.pendingBytes += bytes.length; }
    });
    process.once("close", () => {
      terminal.ended = true;
      for (const timer of terminal.timers) clearTimeout(timer);
      terminal.pending = []; terminal.pendingBytes = 0;
      if (terminal.output && !terminal.output.writableEnded) terminal.output.end();
      if (this.#current === terminal) this.#current = undefined;
      resolveClosed();
      this.#changed();
    });
    this.#current = terminal;
    this.#changed();
    return terminal;
  }

  #kill(terminal: Terminal): void {
    if (terminal.ended) return;
    try { terminal.process.kill("SIGTERM"); } catch { /* already exited */ }
    const force = setTimeout(() => { if (!terminal.ended) try { terminal.process.kill("SIGKILL"); } catch { /* already exited */ } }, 2_000);
    force.unref?.();
    terminal.timers.push(force);
  }

  async #stop(): Promise<void> {
    const terminal = this.#current;
    if (!terminal) return;
    this.#kill(terminal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([terminal.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, STOP_MS); })]);
    clearTimeout(timer);
    if (this.#current === terminal) { this.#current = undefined; this.#changed(); }
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk as Buffer;
    length += bytes.length;
    if (length > MAX_INPUT_BYTES) throw new RuntimeProtocolError(413, "terminal_input_too_large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
