import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TurnQueue } from "../harness/queue.ts";
import type { SessionHarness, SessionHarnessWorkContext } from "@cantelop/sdk/session";

export type NativeEvent = Readonly<Record<string, unknown>>;
export interface NativeTurn {
  text: string;
  signal: AbortSignal;
  emit(event: NativeEvent): Promise<void>;
}
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
  let groupKilled = false;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") { if (!exited) child.kill(signal); }
      else process.kill(-child.pid, signal);
      if (signal === "SIGKILL") groupKilled = true;
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
    // Successful escalation already covered the whole group. Do not signal an
    // exited group again: its numeric ID may have been recycled by the host.
    if (!groupKilled) signalGroup("SIGKILL");
    turn.signal.removeEventListener("abort", stop);
    if (cleanupError) throw cleanupError;
  }
}

/** Shared turn signals and output publication for stock CLI harnesses. */
export abstract class CliHarness implements SessionHarness<{ type: "prompt"; prompt: string }, NativeEvent> {
  private readonly turns: TurnQueue<{ type: "prompt"; prompt: string }, NativeEvent>;
  constructor(lifetime?: AbortSignal) {
    this.turns = new TurnQueue((message, work) => this.executeSubmission(message, work), lifetime);
  }
  protected abstract execute(turn: NativeTurn): Promise<void>;

  queue(message: { type: "prompt"; prompt: string }, work: SessionHarnessWorkContext<{ type: "prompt"; prompt: string }, NativeEvent>): Promise<void> {
    return this.turns.enqueue(message, work);
  }
  steer(message: { type: "prompt"; prompt: string }, work: SessionHarnessWorkContext<{ type: "prompt"; prompt: string }, NativeEvent>): Promise<void> {
    const completion = this.turns.enqueue(message, work, true);
    this.turns.cancel();
    return completion;
  }
  cancel(): boolean { return this.turns.cancel(); }

  private executeSubmission(message: { type: "prompt"; prompt: string }, work: SessionHarnessWorkContext<{ type: "prompt"; prompt: string }, NativeEvent>): Promise<void> {
    return this.execute({
      text: message.prompt, signal: work.signal,
      emit: async event => {
        const json = JSON.stringify(event);
        if (Buffer.byteLength(json) <= 48_000) { await work.output.send(event); return; }
        const eventId = randomUUID(), total = Math.ceil(json.length / 8000);
        for (let index = 0; index < total; index++) {
          await work.output.send({ type: "native.fragment", eventId, index, total, json: json.slice(index * 8000, (index + 1) * 8000) });
        }
      },
    });
  }
}
