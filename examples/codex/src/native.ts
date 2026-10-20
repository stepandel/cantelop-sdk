import { mkdir } from "node:fs/promises";
import { ConversationStore, nativeEnvironment, runJsonProcess, CliHarness, type NativeOptions, type NativeTurn } from "@cantelop/sdk/harnesses/native";
import { codexEnvironment } from "./environment.ts";

/** Stock codex exec, resumed by its native thread ID; no replacement agent loop. */
export class NativeCodex extends CliHarness {
  private readonly store: ConversationStore;
  constructor(private readonly options: NativeOptions, lifetime?: AbortSignal) {
    super(lifetime);
    this.store = new ConversationStore(options.workspace, "codex", options.sessionId);
  }
  protected async execute(turn: NativeTurn): Promise<void> {
    const state = await this.store.load();
    const env = nativeEnvironment(this.options.workspace, codexEnvironment);
    await mkdir(env.CODEX_HOME!, { recursive: true, mode: 0o700 });
    await mkdir(env.CODEX_SQLITE_HOME!, { recursive: true, mode: 0o700 });
    let completed = false, failed = false;
    await runJsonProcess({
      binary: this.options.binary, cwd: this.options.workspace, env,
      args: ["exec", "--json", "--skip-git-repo-check",
        ...(this.options.model ? ["--model", this.options.model] : []),
        ...(state.id ? ["resume", state.id] : []), "-"],
      turn: { ...turn, emit: async event => {
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          state.id = event.thread_id; state.resumable = true; await this.store.save(state);
        }
        completed ||= event.type === "turn.completed";
        failed ||= event.type === "turn.failed" || event.type === "error";
        await turn.emit(event);
      } },
    });
    if (!completed || failed) throw new Error("Codex turn did not complete successfully");
  }
}
