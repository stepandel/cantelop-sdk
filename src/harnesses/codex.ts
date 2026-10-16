/// <reference types="node" />
import { mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { createWorkspaceDatabase } from "../database.js";
import type {
  AppAuth,
  SessionHarness,
  SessionHarnessContext,
  SessionHarnessWorkContext,
} from "../session.js";
import {
  createCodex,
  type CodexClient,
  type CodexOptions,
  type CodexExecutable,
  type CodexThreadOptions,
} from "../codex.js";
import { ConversationStore, nativeEnvironment } from "./cli.js";
import { TurnQueue } from "./queue.js";
import { loginTerminal, nativeAuth, runAuthCommand } from "./login.js";
import type { CodexNativeEvent } from "./codex-protocol.js";

export type CodexMessage = { type: "prompt"; prompt: string };
export type CodexEvent = CodexNativeEvent;
export interface CodexHarnessFactoryOptions {
  readonly workspace?: string;
  readonly executable?: string | CodexExecutable;
  readonly model?: string;
  readonly systemPrompt?: string;
  /** Hosted turns have no approval handler; gated policies would deny every request. */
  readonly approvalPolicy?: "never";
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Native application configuration; these fields cannot be supplied by task messages. */
  readonly config?: Readonly<Record<string, unknown>>;
  /** The durable runtime's authoritative thread binding. */
  readonly conversation?: { readonly id: string };
}
export interface CodexHarnessOptions extends CodexHarnessFactoryOptions {
  readonly sessionId: string;
}
type Work = SessionHarnessWorkContext<CodexMessage, CodexEvent>;
export type CodexClientFactory = (
  options: CodexOptions,
) => Promise<CodexClient>;

async function syncRollout(home: string, path: string): Promise<void> {
  const root = await realpath(home),
    canonical = await realpath(path);
  const within = relative(root, canonical);
  if (
    !within ||
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${sep}`)
  )
    throw new Error("Codex rollout is outside its persistent home");
  const file = await open(canonical, "r+");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  // Persist the directory entries too, including the newly created Codex home.
  for (let directory = dirname(canonical); ; directory = dirname(directory)) {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (directory === dirname(root)) break;
  }
}

/** Native execution only. Use createCodexRuntime for committed intake and observation. */
export class NativeCodex implements SessionHarness<CodexMessage, CodexEvent> {
  private readonly turns: TurnQueue<CodexMessage, CodexEvent>;
  private readonly store: ConversationStore;
  constructor(
    private readonly options: CodexHarnessOptions,
    lifetime?: AbortSignal,
    private readonly connect: CodexClientFactory = createCodex,
  ) {
    if (options.approvalPolicy !== undefined && options.approvalPolicy !== "never")
      throw new TypeError("Hosted Codex supports only approvalPolicy \"never\"");
    this.store = new ConversationStore(
      options.workspace ?? process.cwd(),
      "codex",
      options.sessionId,
    );
    this.turns = new TurnQueue(
      (message, work) => this.execute(message, work),
      lifetime,
    );
  }
  queue(message: CodexMessage, work: Work): Promise<void> {
    return this.turns.enqueue(message, work);
  }
  steer(message: CodexMessage, work: Work): Promise<void> {
    const queued = this.turns.enqueue(message, work, true);
    this.turns.cancel();
    return queued;
  }
  cancel(): boolean {
    return this.turns.cancel();
  }
  private async execute(message: CodexMessage, work: Work): Promise<void> {
    const workspace = this.options.workspace ?? process.cwd();
    const env = nativeEnvironment(workspace);
    await mkdir(env.CODEX_HOME!, { recursive: true, mode: 0o700 });
    const conversation = await this.store.load();
    let settings: CodexThreadOptions = {
      cwd: workspace,
      ...(this.options.model === undefined
        ? {}
        : { model: this.options.model }),
      ...(this.options.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: this.options.approvalPolicy }),
      ...(this.options.sandbox === undefined
        ? {}
        : { sandbox: this.options.sandbox }),
      ...(this.options.systemPrompt === undefined
        ? {}
        : { developerInstructions: this.options.systemPrompt }),
      ...(this.options.config === undefined
        ? {}
        : { config: this.options.config }),
    };
    work.signal.throwIfAborted();
    const owner = await work.database();
    const database = createWorkspaceDatabase(() => owner.credentials(), {
      intMode: "bigint",
      localDatabaseOrigin: work.env.CANTELOP_LOCAL_DATABASE_ORIGIN,
    });
    let client: CodexClient | undefined;
    let rolloutPath: string | undefined;
    try {
      client = await this.connect({
        executable: this.options.executable ?? "/usr/local/bin/cantelop-codex",
        cwd: workspace,
        env,
        inheritEnv: false,
        database,
      });
      work.signal.throwIfAborted();
      if (settings.model === undefined) {
        // thread/resume otherwise restores the previous task's model override.
        const { config } = await client.request<{ config: { model?: string } }>(
          "config/read",
          { includeLayers: false },
        );
        let model = config.model;
        if (!model) {
          const catalog = await client.request<{
            data: { model: string; isDefault: boolean }[];
          }>("model/list", {});
          model = catalog.data.find((candidate) => candidate.isDefault)?.model;
        }
        if (!model) throw new Error("Codex default model unavailable");
        settings = { ...settings, model };
      }
      const id = this.options.conversation?.id ?? conversation.id;
      const thread = id
        ? await client.resumeThread(id, settings)
        : await client.startThread(settings);
      if (typeof thread.rolloutPath !== "string" || !thread.rolloutPath)
        throw new Error("Native Codex rollout path unavailable");
      rolloutPath = thread.rolloutPath;
      conversation.id = thread.id;
      conversation.resumable = true;
      await this.store.save(conversation);
      // The runtime commits this binding before any model/tool execution starts.
      await work.output.send({
        method: "thread/started",
        params: { thread: { id: thread.id } },
      });
      for await (const event of thread.run(message.prompt, {
        signal: work.signal,
      }))
        await work.output.send(event);
    } finally {
      // Completion includes native persistence and child cleanup, not just the last delta.
      try {
        await client?.close();
        if (rolloutPath) await syncRollout(env.CODEX_HOME!, rolloutPath);
      } finally {
        database.close();
      }
    }
  }
}

export function createCodexHarness(
  context: SessionHarnessContext,
  options: CodexHarnessFactoryOptions = {},
): NativeCodex {
  context.signal.throwIfAborted();
  return new NativeCodex(
    {
      ...structuredClone(options),
      sessionId: context.session.id,
      executable:
        options.executable ??
        context.env.CANTELOP_CODEX_PATH ??
        "/usr/local/bin/cantelop-codex",
      ...((options.model ?? context.env.CODEX_MODEL)
        ? { model: options.model ?? context.env.CODEX_MODEL! }
        : {}),
    },
    context.signal,
  );
}
export const codexDockerfile =
  "node_modules/@cantelop/sdk/dist/harnesses/codex/Dockerfile";

const plain = (text: string) =>
  text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
/** Sign-in for the Workspace the runtime uses; pass the same `workspace` as createCodexRuntime(). */
export function createCodexAuth(
  config: { readonly workspace?: string } = {},
) {
  return {
    codeLogin: {
      link(output: string) {
        return plain(output).match(
          /https:\/\/auth\.openai\.com\/codex\/device(?=\s|$)/,
        )?.[0];
      },
      userCode(output: string) {
        return plain(output).match(
          /(?:^|\n)\s*([A-Z0-9]{4}-[A-Z0-9]{4,5})\s*(?:\n|$)/,
        )?.[1];
      },
      promptCount() {
        return 0;
      },
      input() {
        throw new Error("Enter the Codex device code on OpenAI's sign-in page");
      },
    },
    async status(context) {
      const { binary, ...options } = nativeAuth(
        context,
        "CODEX_PATH",
        "/usr/local/bin/codex",
        config.workspace,
      );
      const { code } = await runAuthCommand(binary, ["login", "status"], options);
      if (code > 1) throw new Error("Codex login status unavailable");
      return code === 0;
    },
    async logout(context) {
      const { binary, ...options } = nativeAuth(
        context,
        "CODEX_PATH",
        "/usr/local/bin/codex",
        config.workspace,
      );
      await runAuthCommand(binary, ["logout"], options);
    },
    terminal(context) {
      const { binary, ...options } = nativeAuth(
        context,
        "CODEX_PATH",
        "/usr/local/bin/codex",
        config.workspace,
      );
      return loginTerminal(context, binary, ["login", "--device-auth"], {
        ...options,
        directories: [options.env.CODEX_HOME!],
      });
    },
  } satisfies AppAuth;
}
export const codexAuth = createCodexAuth();

export { createCodexRuntime } from "./codex-runtime.js";
export type * from "./codex-protocol.js";
