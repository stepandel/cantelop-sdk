import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, nativeEnvironment, runJsonProcess, type NativeHarness, type NativeOptions, type NativeTurn } from "../../native-harness/cli.js";

/** Stock CLI with native export/import; the live SQLite database stays on local disk. */
export class NativeOpenCode implements NativeHarness {
  private readonly store: ConversationStore;
  private readonly snapshot: string;
  private environment: Promise<NodeJS.ProcessEnv> | undefined;
  constructor(private readonly options: NativeOptions) {
    this.store = new ConversationStore(options.workspace, "opencode", options.sessionId);
    this.snapshot = join(options.workspace, ".cantelop", "native-harness", "opencode", createHash("sha256").update(options.sessionId).digest("hex") + ".export.json");
  }
  private initialize(): Promise<NodeJS.ProcessEnv> {
    return this.environment ??= (async () => {
      const env = nativeEnvironment(this.options.workspace);
      const data = await mkdtemp(join(tmpdir(), "cantelop-opencode-"));
      env.XDG_DATA_HOME = data;
      await mkdir(join(data, "opencode"), { recursive: true });
      const auth = join(this.options.workspace, ".local", "share", "opencode");
      await mkdir(auth, { recursive: true, mode: 0o700 });
      for (const name of ["auth.json", "mcp-auth.json"]) await symlink(join(auth, name), join(data, "opencode", name));
      try {
        const snapshot = JSON.parse(await readFile(this.snapshot, "utf8"));
        if (!snapshot || typeof snapshot.info?.id !== "string") throw new Error("Invalid native OpenCode snapshot");
        // Import into a fresh local database through the stock CLI. No SQL/schema copying.
        await this.command(env, ["import", this.snapshot], "text");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return env;
    })();
  }
  private async command(env: NodeJS.ProcessEnv, args: string[], format: "jsonl" | "json" | "text"): Promise<Record<string, unknown> | undefined> {
    let result: Record<string, unknown> | undefined;
    await runJsonProcess({
      binary: this.options.binary, cwd: this.options.workspace, env, args, format,
      turn: { text: "", signal: AbortSignal.timeout(15_000), emit: async event => { result = { ...event }; } },
    });
    return result;
  }
  async run(turn: NativeTurn): Promise<void> {
    turn.signal.throwIfAborted();
    const state = await this.store.load();
    const env = await this.initialize();
    let completed = false, failed = false;
    try {
      await runJsonProcess({
        binary: this.options.binary, cwd: this.options.workspace, env,
        args: ["run", "--format", "json", ...(state.id ? ["--session", state.id] : []),
          ...(this.options.model ? ["--model", this.options.model] : [])],
        turn: { ...turn, emit: async event => {
          if (typeof event.sessionID === "string" && state.id !== event.sessionID) {
            state.id = event.sessionID; state.resumable = true; await this.store.save(state);
          }
          const part = event.part as { reason?: string } | undefined;
          completed ||= event.type === "step_finish" && part?.reason === "stop";
          failed ||= event.type === "error";
          await turn.emit(event);
        } },
      });
      if (!completed || failed) throw new Error("OpenCode turn did not complete successfully");
    } finally {
      if (state.id) {
        const snapshot = await this.command(env, ["export", state.id], "json");
        if (!snapshot || (snapshot.info as { id?: string } | undefined)?.id !== state.id) throw new Error("Invalid native OpenCode export");
        const temporary = this.snapshot + "." + randomUUID() + ".tmp";
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        await rename(temporary, this.snapshot);
      }
    }
  }
}
