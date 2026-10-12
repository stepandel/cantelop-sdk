import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { nativeEnvironment } from "../../native-harness/cli.js";
import type { NativeAuthCommand, NativeAuthResult, SessionNativeAuthContext } from "@cantelop/sdk/session";

const exec = promisify(execFile);
const LOGIN_MS = 10 * 60_000;
const WAIT_MS = 20_000;
const hosts = ["claude.ai", "claude.com", "anthropic.com"];

function signInLink(text: string): string | undefined {
  const plain = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const candidate of plain.match(/https:\/\/[^\s<>"']+(?=\s)/g) ?? []) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ""));
      if (!url.username && !url.password && hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return url.href;
    } catch { /* Ignore malformed native output. */ }
  }
}

interface Attempt {
  id: string;
  expiresAt: number;
  url: string | undefined;
  text: string;
  ended: boolean;
  done: Promise<void>;
  write(code: string): Promise<void>;
  stop(): void;
  waiters: Set<() => void>;
}

function waitFor(attempt: Attempt, ready: () => boolean): Promise<boolean> {
  return new Promise(resolve => {
    if (ready()) { resolve(true); return; }
    const timer = setTimeout(() => { attempt.waiters.delete(notify); resolve(false); }, WAIT_MS);
    const notify = () => { if (ready()) { clearTimeout(timer); attempt.waiters.delete(notify); resolve(true); } };
    attempt.waiters.add(notify);
  });
}

/** Owns only transient login process state. The stock CLI owns Workspace credentials. */
export class ClaudeAuth {
  private attempt: Attempt | undefined;
  private settled: Promise<void> = Promise.resolve();

  constructor(private readonly workspace: string, private readonly binary: string,
    private readonly helper: string, lifetime?: AbortSignal) {
    lifetime?.addEventListener("abort", () => { void this.stop(); }, { once: true });
  }

  async handle(command: NativeAuthCommand, context?: SessionNativeAuthContext): Promise<NativeAuthResult> {
    if (command.type === "methods") return { type: "methods", methods: ["browser-code"] };
    if (command.type === "status") return { type: "status", authenticated: await this.authenticated() };
    if (command.type === "logout") {
      await this.stop();
      try {
        await exec(this.binary, ["auth", "logout"], { cwd: this.workspace, env: nativeEnvironment(this.workspace), timeout: 15_000, maxBuffer: 65_536 });
      } catch { throw new Error("Claude logout failed"); }
      const authenticated = await this.authenticated();
      if (authenticated) throw new Error("Claude logout could not be confirmed");
      return { type: "status", authenticated };
    }
    if (command.type === "cancel") {
      if (this.attempt?.id === command.attemptId) await this.stop();
      return { type: "cancelled", attemptId: command.attemptId };
    }
    if (command.type === "login") {
      if (command.method !== "browser-code") throw new TypeError("Unsupported Claude auth method");
      if (!this.attempt) {
        await this.settled;
        if (!command.force && await this.authenticated()) return { type: "status", authenticated: true };
        this.attempt = this.launch();
        context?.hold(this.attempt.done);
      }
      const attempt = this.attempt;
      await waitFor(attempt, () => !!attempt.url && /paste\s+code/i.test(attempt.text) || attempt.ended);
      if (!attempt.url) { await this.stop(); throw new Error("Claude login did not return a sign-in URL"); }
      return { type: "login", method: "browser-code", attemptId: attempt.id,
        url: attempt.url, expiresAt: new Date(attempt.expiresAt).toISOString() };
    }
    const attempt = this.attempt;
    if (!attempt || attempt.id !== command.attemptId || attempt.ended || !attempt.url) throw new Error("Claude login attempt is not active");
    const prompts = () => (attempt.text.match(/paste\s+code/gi) ?? []).length;
    const before = prompts();
    await attempt.write(command.code);
    if (!await waitFor(attempt, () => attempt.ended || prompts() > before)) throw new Error("Claude login response timed out");
    if (!attempt.ended) throw new Error("Claude rejected the login code");
    await attempt.done;
    const authenticated = await this.authenticated();
    if (!authenticated) throw new Error("Claude login did not complete");
    return { type: "status", authenticated };
  }

  private async authenticated(): Promise<boolean> {
    let stdout: string;
    try {
      ({ stdout } = await exec(this.binary, ["auth", "status"], {
        cwd: this.workspace, env: nativeEnvironment(this.workspace), timeout: 15_000, maxBuffer: 65_536,
      }));
    } catch (error) {
      const failure = error as { stdout?: string; killed?: boolean; signal?: string };
      if (failure.killed || failure.signal || !failure.stdout) throw new Error("Claude auth status unavailable");
      stdout = failure.stdout;
    }
    let status: unknown;
    try { status = JSON.parse(stdout); }
    catch { throw new Error("Claude auth status unavailable"); }
    if (!status || typeof status !== "object" || typeof (status as { loggedIn?: unknown }).loggedIn !== "boolean")
      throw new Error("Claude auth status unavailable");
    return (status as { loggedIn: boolean }).loggedIn;
  }

  private launch(): Attempt {
    const id = randomUUID(), expiresAt = Date.now() + LOGIN_MS;
    const env = { ...nativeEnvironment(this.workspace), TERM: "dumb", BROWSER: "/bin/true" };
    const child = spawn("python3", ["-u", this.helper, this.binary, "auth", "login"], {
      cwd: this.workspace, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let timer: ReturnType<typeof setTimeout>;
    const attempt: Attempt = {
      id, expiresAt, url: undefined, text: "", ended: false, waiters: new Set(), done: Promise.resolve(),
      write: async code => {
        if (attempt.ended || !child.stdin.writable) throw new Error("Claude login attempt ended");
        await new Promise<void>((resolve, reject) => child.stdin.write(`${code}\r`, error => error ? reject(error) : resolve()));
      },
      stop: () => { if (!attempt.ended) child.kill("SIGTERM"); },
    };
    const notify = () => { for (const waiter of [...attempt.waiters]) waiter(); };
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => { attempt.ended = true; notify(); resolve(); });
    });
    void exit.catch(() => undefined);
    child.stdin.on("error", () => undefined);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    timer = setTimeout(attempt.stop, LOGIN_MS);
    attempt.done = (async () => {
      try {
        for await (const chunk of child.stdout) {
          attempt.text += String(chunk);
          if (attempt.text.length > 64 * 1024) { attempt.stop(); throw new Error("Claude login output limit"); }
          attempt.url ??= signInLink(attempt.text);
          notify();
        }
        await exit;
      } finally {
        clearTimeout(timer);
        attempt.stop();
        await exit.catch(() => undefined);
        attempt.text = "";
        attempt.ended = true;
        if (this.attempt === attempt) this.attempt = undefined;
        notify();
      }
    })();
    void attempt.done.catch(() => undefined);
    this.settled = attempt.done.catch(() => undefined);
    return attempt;
  }

  private async stop(): Promise<void> {
    this.attempt?.stop();
    await this.settled;
  }
}
