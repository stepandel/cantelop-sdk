/// <reference types="node" />
import { randomBytes } from "node:crypto";
import type { AppAuth, AuthContext, AuthResult, AuthTerminalProcess, NativeCodeLogin } from "./native-auth.js";
import { PTY_STOP_GRACE_MS, stopWithGrace } from "./process-stop.js";

/** Native login output kept in memory per attempt; more than this fails the attempt. */
const MAX_OUTPUT_BYTES = 64 * 1024;

interface Attempt {
  id: string;
  process: AuthTerminalProcess;
  /** Native output so far, private to this process; cleared when the CLI exits. */
  text: string;
  /** UTF-8 size of `text`, kept incrementally. */
  bytes: number;
  /** The adapter's code-prompt count for `text`, computed once per output chunk. */
  prompts: number;
  url?: string | undefined;
  ended: boolean;
  failed: boolean;
  expiresAt: number;
  closed: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  notify: Set<() => void>;
}

/** Reads App auth status, rejecting a provider that does not report a boolean. */
export async function authStatus(auth: AppAuth, context: AuthContext): Promise<boolean> {
  const value = await auth.status(context);
  if (typeof value !== "boolean") throw new TypeError("App auth status must return a boolean");
  return value;
}

/** Structured link/code login. Native output stays in bounded memory, never in replies or logs. */
export class AuthCodeLogin {
  #attempt: Attempt | undefined;

  constructor(
    private auth: AppAuth,
    private adapter: NativeCodeLogin,
    private context: AuthContext,
    private changed: () => void,
    private waitMs = 20_000,
    private lifetimeMs = 10 * 60_000,
  ) {
    context.signal.addEventListener("abort", () => { void this.stop().catch(() => undefined); }, { once: true });
  }

  /** An exited CLI still counts until its code is submitted, cancelled or expires, so the Sandbox keeps the attempt. */
  get active(): boolean { return !!this.#attempt; }

  async login(force = false): Promise<AuthResult> {
    this.context.signal.throwIfAborted();
    if (force) {
      await this.stop();
      await this.auth.logout(this.context);
      if (await authStatus(this.auth, this.context)) return { type: "error", code: "auth_logout_unconfirmed" };
    }
    let attempt = this.#attempt;
    if (!attempt || attempt.ended) {
      await this.stop();
      if (!force && await authStatus(this.auth, this.context)) return { type: "status", authenticated: true };
      attempt = await this.#start();
    }
    const current = attempt;
    const prompting = () => !!current.url && current.prompts > 0;
    await this.wait(current, () => prompting() || current.ended || current.failed);
    if (this.#attempt === current && prompting() && !current.failed && !current.ended) {
      return { type: "login", attemptId: current.id, url: current.url!, expiresAt: new Date(current.expiresAt).toISOString() };
    }
    await this.stop();
    return { type: "error", code: "login_failed" };
  }

  async code(id: string, code: string): Promise<AuthResult> {
    const attempt = this.#attempt;
    if (!attempt || attempt.id !== id || !attempt.url || attempt.failed || Date.now() >= attempt.expiresAt) {
      return { type: "error", code: "login_not_active" };
    }
    if (!attempt.ended) {
      const before = attempt.prompts;
      await new Promise<void>((resolve, reject) => {
        attempt.process.stdin!.write(this.adapter.input(code), error => error ? reject(error) : resolve());
      });
      // The CLI either exits (accepted) or prompts again (rejected).
      if (!await this.wait(attempt, () => attempt.ended || attempt.failed || attempt.prompts > before)) {
        await this.stop();
        return { type: "error", code: "login_timeout" };
      }
      if (attempt.failed) { await this.stop(); return { type: "error", code: "login_failed" }; }
      if (!attempt.ended) return { type: "error", code: "code_rejected" };
    }
    await attempt.closed;
    const authenticated = await authStatus(this.auth, this.context);
    await this.stop();
    return authenticated ? { type: "status", authenticated: true } : { type: "error", code: "login_failed" };
  }

  async cancel(id: string): Promise<AuthResult> {
    if (this.#attempt?.id === id) await this.stop();
    return { type: "cancelled", attemptId: id };
  }

  async stop(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    if (!attempt.ended) {
      const force = stopWithGrace(signal => attempt.process.kill(signal), { graceMs: PTY_STOP_GRACE_MS, exited: () => attempt.ended });
      try { await attempt.closed; } finally { clearTimeout(force); }
    }
    attempt.text = "";
    if (this.#attempt === attempt) this.#attempt = undefined;
    this.changed();
  }

  async #start(): Promise<Attempt> {
    const process = await this.auth.terminal(this.context);
    if (!process.stdin || !process.stdout) {
      process.kill("SIGKILL");
      throw new TypeError("Native login requires stdin and stdout");
    }
    let close!: () => void;
    const attempt: Attempt = {
      id: `lgn_${randomBytes(16).toString("hex")}`, process, text: "", bytes: 0, prompts: 0,
      ended: false, failed: false, expiresAt: Date.now() + this.lifetimeMs,
      closed: new Promise(resolve => { close = resolve; }),
      timer: setTimeout(() => { void this.stop().catch(() => undefined); }, this.lifetimeMs),
      notify: new Set(),
    };
    attempt.timer.unref?.();
    this.#attempt = attempt;
    const notify = () => { for (const wake of [...attempt.notify]) wake(); };
    const failed = () => { attempt.failed = true; void this.stop().catch(() => undefined); notify(); };
    process.stdin.on("error", failed);
    process.stdout.on("error", failed);
    process.once("error", failed);
    // Decode across chunk boundaries so a split multi-byte character stays intact.
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      if (attempt.ended) return;
      attempt.bytes += Buffer.byteLength(chunk);
      if (attempt.bytes > MAX_OUTPUT_BYTES) { failed(); return; }
      attempt.text += chunk;
      attempt.url ??= this.adapter.link(attempt.text);
      attempt.prompts = this.adapter.promptCount(attempt.text);
      notify();
    });
    process.once("close", () => {
      attempt.ended = true; attempt.text = ""; attempt.prompts = 0;
      notify(); close(); this.changed();
    });
    this.changed();
    if (this.context.signal.aborted) await this.stop();
    return attempt;
  }

  private wait(attempt: Attempt, ready: () => boolean): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = () => {
        if (!ready()) return;
        clearTimeout(timer); attempt.notify.delete(finish); resolve(true);
      };
      const timer = setTimeout(() => { attempt.notify.delete(finish); resolve(false); }, this.waitMs);
      attempt.notify.add(finish);
      finish();
    });
  }
}
