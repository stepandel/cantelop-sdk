import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { ConversationStore, nativeEnvironment, runJsonProcess, type NativeHarness, type NativeOptions, type NativeTurn } from "../../native-harness/cli.js";

/** Stock claude -p with native Workspace auth and conversation resumption. */
export class NativeClaude implements NativeHarness {
  private readonly store: ConversationStore;
  constructor(private readonly options: NativeOptions) {
    this.store = new ConversationStore(options.workspace, "claude", options.sessionId);
  }
  async run(turn: NativeTurn): Promise<void> {
    const state = await this.store.load();
    if (!state.id) { state.id = randomUUID(); await this.store.save(state); }
    const env = nativeEnvironment(this.options.workspace);
    await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true, mode: 0o700 });
    let completed = false, failed = false;
    await runJsonProcess({
      binary: this.options.binary, cwd: this.options.workspace, env,
      args: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        ...(this.options.model ? ["--model", this.options.model] : []),
        state.resumable ? "--resume" : "--session-id", state.id],
      turn: { ...turn, emit: async event => {
        if (event.type === "system" && event.subtype === "init") { state.resumable = true; await this.store.save(state); }
        completed ||= event.type === "result";
        failed ||= event.type === "result" && event.is_error === true;
        failed ||= event.type === "assistant" && event.error === "authentication_failed";
        await turn.emit(event);
      } },
    });
    if (!completed || failed) throw new Error("Claude turn did not complete successfully");
  }
}
