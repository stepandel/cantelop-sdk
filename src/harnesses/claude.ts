/// <reference types="node" />
import type { AppAuth, SessionHarnessContext } from "../session.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginTerminal, nativeAuth, runAuthCommand } from "./login.js";
import { ConversationStore, nativeEnvironment, runJsonProcess, CliHarness, type NativeOptions, type NativeTurn } from "./cli.js";

export class ClaudeAuthenticationRequired extends Error {
  constructor() {super("Claude sign-in required");}
}

/** Stock claude -p with conversation resumption; sign-in is the App-level `claudeAuth`. */
export class NativeClaude extends CliHarness {
  private readonly store: ConversationStore;
  constructor(private readonly options: ClaudeHarnessOptions, lifetime?: AbortSignal) {
    super(lifetime);
    this.store = new ConversationStore(options.workspace, "claude", options.sessionId);
  }
  protected async execute(turn: NativeTurn): Promise<void> {
    const state = await this.store.load();
    if (!state.id && this.options.conversation) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(this.options.conversation.id)) throw new TypeError("Invalid Claude conversation ID");
      Object.assign(state, this.options.conversation);
      await this.store.save(state);
    }
    // An interrupted turn may have claimed its --session-id before init; never reuse it.
    if (!state.resumable) { state.id = randomUUID(); await this.store.save(state); }
    const env = nativeEnvironment(this.options.workspace);
    await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true, mode: 0o700 });
    let completed = false, failed = false, authFailed = false;
    let promptDirectory: string | undefined;
    let promptFile: string | undefined;
    try {
      if (this.options.systemPrompt !== undefined) {
        promptDirectory = await mkdtemp(join(tmpdir(), "cantelop-claude-prompt-"));
        promptFile = join(promptDirectory, "system.txt");
        await writeFile(promptFile, this.options.systemPrompt, {mode:0o600});
      }
    try {await runJsonProcess({
      binary: this.options.binary, cwd: this.options.workspace, env,
      args: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        ...(this.options.model ? ["--model", this.options.model] : []),
        ...(this.options.permissionMode ? ["--permission-mode", this.options.permissionMode] : []),
        ...(this.options.settingSources ? ["--setting-sources", this.options.settingSources.join(",")] : []),
        ...(this.options.tools ? ["--tools", this.options.tools.join(",")] : []),
        ...(this.options.allowedTools?.length ? ["--allowedTools", this.options.allowedTools.join(",")] : []),
        ...(this.options.maxTurns !== undefined ? ["--max-turns", String(this.options.maxTurns)] : []),
        ...(this.options.mcps ? ["--strict-mcp-config", "--mcp-config", JSON.stringify({mcpServers:this.options.mcps})] : []),
        ...(promptFile ? ["--system-prompt-file", promptFile] : []),
        state.resumable ? "--resume" : "--session-id", state.id!],
      turn: { ...turn, emit: async event => {
        if (event.type === "system" && event.subtype === "init") { state.resumable = true; await this.store.save(state); }
        completed ||= event.type === "result";
        failed ||= event.type === "result" && event.is_error === true;
        authFailed ||= event.type === "assistant" && event.error === "authentication_failed";
        await turn.emit(event);
      } },
    });} catch (error) {if(authFailed) throw new ClaudeAuthenticationRequired();throw error;}
    if (authFailed) throw new ClaudeAuthenticationRequired();
    if (!completed || failed) throw new Error("Claude turn did not complete successfully");
    } finally {
      if (promptDirectory) await rm(promptDirectory,{recursive:true,force:true});
    }
  }
}

export type ClaudeMessage = { type: "prompt"; prompt: string };
export type { NativeEvent as ClaudeEvent } from "./cli.js";
export interface ClaudeHarnessOptions extends NativeOptions {
  readonly permissionMode?: "default" | "dontAsk" | "acceptEdits";
  readonly settingSources?: readonly string[];
  readonly tools?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly maxTurns?: number;
  readonly systemPrompt?: string;
  readonly mcps?: Readonly<Record<string, unknown>>;
  /** Seed a previous runner's native conversation once; existing SDK state takes precedence. */
  readonly conversation?: {readonly id:string;readonly resumable:boolean};
}

/** Construct the stock CLI harness once per Session runtime incarnation. */
export function createClaudeHarness(context: SessionHarnessContext): NativeClaude {
  context.signal.throwIfAborted();
  return new NativeClaude({
    workspace: process.cwd(), sessionId: context.session.id,
    binary: context.env.CLAUDE_PATH ?? "/usr/local/bin/claude",
    ...(context.env.CLAUDE_MODEL ? { model: context.env.CLAUDE_MODEL } : {}),
  }, context.signal);
}

/** Project-relative path to the self-contained Dockerfile shipped in this package. */
export const claudeDockerfile = "node_modules/@cantelop/sdk/dist/harnesses/claude/Dockerfile";

/**
 * Stock `claude auth` commands. The user signs in inside the CLI's own terminal;
 * this provider never sees the sign-in code or the credentials the CLI stores.
 */
export const claudeAuth = {
  async status(context) {
    const { binary, ...options } = nativeAuth(context, "CLAUDE_PATH", "/usr/local/bin/claude");
    // Signed-out status exits non-zero but still reports JSON.
    const { stdout } = await runAuthCommand(binary, ["auth", "status"], options);
    let status: unknown;
    try { status = JSON.parse(stdout); } catch { throw new Error("Claude auth status unavailable"); }
    const loggedIn = (status as { loggedIn?: unknown } | null)?.loggedIn;
    if (typeof loggedIn !== "boolean") throw new Error("Claude auth status unavailable");
    return loggedIn;
  },
  async logout(context) {
    const { binary, ...options } = nativeAuth(context, "CLAUDE_PATH", "/usr/local/bin/claude");
    if ((await runAuthCommand(binary, ["auth", "logout"], options)).code !== 0) throw new Error("Claude logout failed");
  },
  terminal(context) {
    const { binary, ...options } = nativeAuth(context, "CLAUDE_PATH", "/usr/local/bin/claude");
    // All of the CLI's sign-in methods stay available.
    return loginTerminal(context, binary, ["auth", "login"], options);
  },
} satisfies AppAuth;
