import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionHarness } from "@cantelop/sdk/session";

export type NativeEvent = Readonly<Record<string, unknown>>;
export type NativeOutput = NativeEvent;
export interface NativeTurn {
  text: string;
  signal: AbortSignal;
  emit(event: NativeEvent): Promise<void>;
}
export interface NativeHarness { run(turn: NativeTurn): Promise<void> }
export interface NativeOptions { workspace: string; sessionId: string; binary: string; model?: string }

/** Only the child receives this environment; host auth/config is never changed. */
export function nativeEnvironment(workspace: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "TERM", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.HOME = workspace;
  env.CODEX_HOME = join(workspace, ".codex");
  env.CLAUDE_CONFIG_DIR = join(workspace, ".claude");
  env.XDG_CONFIG_HOME = join(workspace, ".config");
  env.XDG_DATA_HOME = join(workspace, ".local", "share");
  env.XDG_STATE_HOME = join(workspace, ".local", "state");
  // Do not put disposable caches on the durable Workspace.
  env.XDG_CACHE_HOME = join(process.env.TMPDIR ?? "/tmp", "cantelop-native-cache", createHash("sha256").update(workspace).digest("hex"));
  env.CODEX_SQLITE_HOME = join(env.XDG_CACHE_HOME!, "codex-sqlite");
  env.DISABLE_AUTOUPDATER = "1";
  env.DISABLE_UPDATES = "1";
  // No inherited provider API keys, platform tokens, or host auth directories.
  return env;
}

interface Conversation { id?: string; resumable: boolean }
export class ConversationStore {
  private readonly path: string;
  private state: Promise<Conversation> | undefined;
  private writes = Promise.resolve();
  constructor(workspace: string, provider: string, sessionId: string) {
    this.path = join(workspace, ".cantelop", "native-harness", provider, createHash("sha256").update(sessionId).digest("hex") + ".json");
  }
  load(): Promise<Conversation> {
    return this.state ??= (async () => {
      try {
        const value = JSON.parse(await readFile(this.path, "utf8")) as Conversation;
        if (!value || typeof value.resumable !== "boolean" ||
            value.id !== undefined && (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id))) throw new Error("Invalid native conversation state");
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { resumable: false };
      }
    })();
  }
  save(state: Conversation): Promise<void> {
    const encoded = JSON.stringify(state);
    this.writes = this.writes.then(async () => {
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = this.path + "." + randomUUID() + ".tmp";
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writes;
  }
}

/** Run one stock CLI turn; always wait for process-group cleanup before settling. */
export async function runJsonProcess(options: {
  binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; turn: NativeTurn;
  format?: "jsonl" | "json" | "text";
}): Promise<void> {
  const { turn } = options;
  turn.signal.throwIfAborted();
  const child = spawn(options.binary, options.args, {
    cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
  });
  let exited = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let cleanupError: unknown;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") { if (!exited) child.kill(signal); }
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupError = error;
    }
  };
  const stop = () => {
    if (exited || escalation) return;
    signalGroup("SIGTERM");
    escalation = setTimeout(() => signalGroup("SIGKILL"), 1000);
  };
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  void done.catch(() => undefined);
  turn.signal.addEventListener("abort", stop, { once: true });
  if (turn.signal.aborted) stop();
  child.stdin.on("error", () => undefined);
  child.stdin.end(turn.text);
  child.stderr.resume(); // Native diagnostics may contain credentials; never publish stderr.
  child.stdout.setEncoding("utf8");
  let pending = "";
  const line = async (text: string) => {
    if (!text.trim()) return;
    const event: unknown = JSON.parse(text);
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Invalid native JSON event");
    await turn.emit(event as NativeEvent);
  };
  try {
    for await (const chunk of child.stdout) {
      pending += chunk;
      if (options.format === "json" || options.format === "text") {
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error("Native snapshot exceeds limit");
        continue;
      }
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const text = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Native output frame exceeds limit");
        await line(text);
      }
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new Error("Native output frame exceeds limit");
    }
    if (options.format !== "text") await line(pending);
    const outcome = await done;
    turn.signal.throwIfAborted();
    if (outcome.code !== 0 || outcome.signal) throw new Error("Native CLI turn failed");
  } finally {
    stop();
    await done.catch(() => undefined);
    if (escalation) clearTimeout(escalation);
    signalGroup("SIGKILL"); // Remove tools still in this turn's group before another turn starts.
    turn.signal.removeEventListener("abort", stop);
    if (cleanupError) throw cleanupError;
  }
}

/** Scheduling stays in Cantelop; native execution stays in the supplied harness. */
export function wrapNativeHarness(harness: NativeHarness, lifetime?: AbortSignal): SessionHarness<{ type: "prompt"; prompt: string }, NativeOutput> {
  return { run: (message, work) => {
    const signal = lifetime ? AbortSignal.any([work.signal, lifetime]) : work.signal;
    const publish = async (event: NativeOutput) => {
      signal.throwIfAborted();
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      try { await Promise.race([work.output.send(event), interrupted]); }
      finally { signal.removeEventListener("abort", abort); }
    };
    return harness.run({
      text: message.prompt, signal,
      emit: async event => {
        const json = JSON.stringify(event);
        if (Buffer.byteLength(json) <= 48_000) { await publish(event); return; }
        const eventId = randomUUID(), total = Math.ceil(json.length / 8000);
        for (let index = 0; index < total; index++) {
          await publish({ type: "native.fragment", eventId, index, total, json: json.slice(index * 8000, (index + 1) * 8000) });
        }
      },
    });
  } };
}
