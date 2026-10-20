/// <reference types="node" />
import type { AppAuth, AuthContext, SessionHarnessContext } from "../session.js";
import { randomUUID } from "node:crypto";
import { loginTerminal, nativeAuth, runAuthCommand } from "./login.js";
import { CliHarness, type ConversationStore, type NativeTurn } from "./cli.js";
import { CLAUDE_BINARY, claudeConversationStore, claudeEnvironment, resolveClaudeOptions, runClaude } from "./claude-launch.js";
import { isClaudeUUID, type ClaudeHarnessFactoryOptions, type ClaudeHarnessOptions } from "./claude-types.js";

export { ClaudeAuthenticationRequired } from "./claude-types.js";
export type { ClaudeMessage, ClaudeHarnessOptions, ClaudeHarnessFactoryOptions } from "./claude-types.js";
export type { NativeEvent as ClaudeEvent, NativeFragmentEvent } from "./cli.js";

/** Stock claude -p with conversation resumption; sign-in is the App-level `claudeAuth`. */
export class NativeClaude extends CliHarness {
  private readonly store: ConversationStore;
  constructor(private readonly options: ClaudeHarnessOptions, lifetime?: AbortSignal) {
    super(lifetime);
    this.store = claudeConversationStore(options.workspace, options.sessionId);
  }
  protected async execute(turn: NativeTurn): Promise<void> {
    const state = await this.store.load();
    if (!state.id && this.options.conversation) {
      if (!isClaudeUUID(this.options.conversation.id)) throw new TypeError("Invalid Claude conversation ID");
      Object.assign(state, this.options.conversation);
      await this.store.save(state);
    }
    // An interrupted turn may have claimed its --session-id before init; never reuse it.
    if (!state.resumable) { state.id = randomUUID(); await this.store.save(state); }
    const outcome = await runClaude(this.options, {
      mode: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
      conversation: { id: state.id!, resume: state.resumable },
      text: turn.text, signal: turn.signal,
      emit: async event => {
        if (event.type === "system" && event.subtype === "init") { state.resumable = true; await this.store.save(state); }
        await turn.emit(event);
      },
    });
    if (!outcome.completed || outcome.failed) throw new Error("Claude turn did not complete successfully");
  }
}

/**
 * Construct a stock CLI harness with immutable configuration for this incarnation.
 * Usable directly as runtime.create, or with application-owned Session settings.
 * The returned harness owns queue/steer/cancel, output fragmentation and cleanup.
 */
export function createClaudeHarness(
  context: SessionHarnessContext,
  options: ClaudeHarnessFactoryOptions = {},
): NativeClaude {
  return new NativeClaude(resolveClaudeOptions(context, options), context.signal);
}

/** Project-relative path to the self-contained Dockerfile shipped in this package. */
export const claudeDockerfile = "node_modules/@cantelop/sdk/dist/harnesses/claude/Dockerfile";

/** The stock binary and Workspace environment every `claude auth` command runs with. */
const claudeAuthCommand = (context: AuthContext) => nativeAuth(context, "CLAUDE_PATH", CLAUDE_BINARY, claudeEnvironment);
// Inspect native output as plain text; never render or publish it.
const plainLogin = (text: string) => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

/**
 * Stock `claude auth` commands. The user signs in inside the CLI's own terminal;
 * this provider never sees the sign-in code or the credentials the CLI stores.
 */
export const claudeAuth = {
  codeLogin: {
    link(output: string) {
      for (const candidate of plainLogin(output).match(/https:\/\/[^\s<>"']+(?=\s)/g) ?? []) {
        try {
          const url = new URL(candidate);
          if (url.protocol === "https:" && !url.username && !url.password && ["claude.ai","claude.com","anthropic.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return url.href;
        } catch { /* Incomplete or invalid native link. */ }
      }
      return undefined;
    },
    promptCount(output: string) { return plainLogin(output).match(/paste\s+code/gi)?.length ?? 0; },
    input(code: string) { return `${code}\r`; },
  },
  async status(context) {
    const { binary, ...options } = claudeAuthCommand(context);
    // Signed-out status exits non-zero but still reports JSON.
    const { stdout } = await runAuthCommand(binary, ["auth", "status"], options);
    let status: unknown;
    try { status = JSON.parse(stdout); } catch { throw new Error("Claude auth status unavailable"); }
    const loggedIn = (status as { loggedIn?: unknown } | null)?.loggedIn;
    if (typeof loggedIn !== "boolean") throw new Error("Claude auth status unavailable");
    return loggedIn;
  },
  async logout(context) {
    const { binary, ...options } = claudeAuthCommand(context);
    if ((await runAuthCommand(binary, ["auth", "logout"], options)).code !== 0) throw new Error("Claude logout failed");
  },
  terminal(context) {
    const { binary, ...options } = claudeAuthCommand(context);
    // All of the CLI's sign-in methods stay available.
    return loginTerminal(context, binary, ["auth", "login"], options);
  },
} satisfies AppAuth;

export { createClaudeRuntime } from "./claude-runtime.js";
export type * from "./claude-protocol.js";
