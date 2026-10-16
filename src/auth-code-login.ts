/// <reference types="node" />
import { randomBytes } from "node:crypto";
import type { AppAuth, AuthContext, AuthResult, AuthTerminalProcess, NativeCodeLogin } from "./native-auth.js";

interface Attempt {
  id: string; process: AuthTerminalProcess; text: string; url?: string | undefined; userCode?: string | undefined;
  ended: boolean; failed: boolean; expiresAt: number; closed: Promise<void>;
  timer: ReturnType<typeof setTimeout>; notify: Set<() => void>;
}
/** Structured link/code login. Native output stays in bounded memory, never in replies or logs. */
export class AuthCodeLogin {
  #attempt: Attempt | undefined;
  constructor(private auth: AppAuth, private adapter: NativeCodeLogin, private context: AuthContext, private changed: () => void,
    private waitMs = 20_000, private lifetimeMs = 10 * 60_000) {
    context.signal.addEventListener("abort", () => { void this.stop().catch(() => undefined); }, { once: true });
  }
  /** An exited CLI still counts until its code is submitted, cancelled or expires, so the Sandbox keeps the attempt. */
  get active(): boolean { return !!this.#attempt; }
  async login(force = false): Promise<AuthResult> {
    this.context.signal.throwIfAborted();
    if (force) {
      await this.stop();
      await this.auth.logout(this.context);
      if (await this.status()) return {type:"error",code:"auth_logout_unconfirmed"};
    }
    let attempt = this.#attempt;
    if (!attempt || attempt.ended) {
      await this.stop();
      if (!force && await this.status()) return {type:"status",authenticated:true};
      const process = await this.auth.terminal(this.context);
      if (!process.stdin || !process.stdout) { process.kill("SIGKILL"); throw new TypeError("Native login requires stdin and stdout"); }
      let close!: () => void;
      attempt = { id: `lgn_${randomBytes(16).toString("hex")}`, process, text:"", ended:false, failed:false,
        expiresAt:Date.now()+this.lifetimeMs, closed:new Promise(resolve => {close=resolve;}),
        timer:setTimeout(() => { void this.stop().catch(() => undefined); },this.lifetimeMs), notify:new Set() };
      attempt.timer.unref?.();
      this.#attempt = attempt;
      const current = attempt;
      const notify = () => { for (const wake of [...current.notify]) wake(); };
      const failed = () => { current.failed = true; void this.stop().catch(() => undefined); notify(); };
      process.stdin.on("error", failed);
      process.stdout.on("error", failed);
      process.once("error", failed);
      process.stdout.on("data", (chunk: Buffer|string) => {
        if (current.ended) return;
        current.text += String(chunk);
        if (Buffer.byteLength(current.text)>64*1024) {failed();return;}
        current.url ??= this.adapter.link(current.text);
        current.userCode ??= this.adapter.userCode?.(current.text);
        notify();
      });
      process.once("close", () => {
        current.ended=true; current.text=""; notify(); close(); this.changed();
        // Device login completes on the provider's page. Nothing remains to submit.
        if (this.adapter.userCode && this.#attempt === current) {
          clearTimeout(current.timer); this.#attempt=undefined; this.changed();
        }
      });
      this.changed();
      if (this.context.signal.aborted) await this.stop();
    }
    const ready = () => !!attempt.url && (this.adapter.userCode ? !!attempt.userCode : this.adapter.promptCount(attempt.text)>0);
    await this.wait(attempt, () => ready() || attempt.ended || attempt.failed);
    if (this.adapter.userCode && attempt.ended && !attempt.failed && await this.status()) return {type:"status",authenticated:true};
    if (this.#attempt === attempt && attempt.url && ready() && !attempt.failed && !attempt.ended)
      return {type:"login",attemptId:attempt.id,url:attempt.url,expiresAt:new Date(attempt.expiresAt).toISOString(),...(attempt.userCode ? {userCode:attempt.userCode} : {})};
    await this.stop();
    return {type:"error",code:"login_failed"};
  }
  async code(id: string, code: string): Promise<AuthResult> {
    if (this.adapter.userCode) return {type:"error",code:"device_login_requires_browser"};
    const attempt = this.#attempt;
    if (!attempt || attempt.id !== id || !attempt.url || attempt.failed || Date.now() >= attempt.expiresAt)
      return {type:"error",code:"login_not_active"};
    if (!attempt.ended) {
      const before = this.adapter.promptCount(attempt.text);
      await new Promise<void>((resolve,reject) => attempt.process.stdin!.write(this.adapter.input(code), error => error ? reject(error) : resolve()));
      if (!await this.wait(attempt, () => attempt.ended || attempt.failed || this.adapter.promptCount(attempt.text)>before)) {
        await this.stop(); return {type:"error",code:"login_timeout"};
      }
      if (attempt.failed) { await this.stop(); return {type:"error",code:"login_failed"}; }
      if (!attempt.ended) return {type:"error",code:"code_rejected"};
    }
    await attempt.closed;
    const authenticated = await this.status();
    await this.stop();
    return authenticated ? {type:"status",authenticated:true} : {type:"error",code:"login_failed"};
  }
  async cancel(id: string): Promise<AuthResult> {
    if (this.#attempt?.id === id) await this.stop();
    return {type:"cancelled",attemptId:id};
  }
  async stop(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    if (!attempt.ended) {
      attempt.process.kill("SIGTERM");
      const force = setTimeout(() => { if (!attempt.ended) attempt.process.kill("SIGKILL"); },1_000);
      try { await attempt.closed; } finally { clearTimeout(force); }
    }
    attempt.text="";
    if (this.#attempt === attempt) this.#attempt=undefined;
    this.changed();
  }
  private async status(): Promise<boolean> {
    const value = await this.auth.status(this.context);
    if (typeof value !== "boolean") throw new TypeError("App auth status must return a boolean");
    return value;
  }
  private wait(attempt: Attempt, ready: () => boolean): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = () => { if (ready()) { clearTimeout(timer); attempt.notify.delete(finish); resolve(true); } };
      const timer = setTimeout(() => { attempt.notify.delete(finish); resolve(false); },this.waitMs);
      attempt.notify.add(finish);
      finish();
    });
  }
}
