/// <reference types="node" />
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHarnessContext } from '../session.js'
import { ConversationStore, nativeEnvironment, runJsonProcess, type NativeEnvironmentHook, type NativeEvent } from './cli.js'
import { ClaudeAuthenticationRequired, type ClaudeHarnessFactoryOptions, type ClaudeHarnessOptions } from './claude-types.js'

/** Stock CLI location in the packaged image; CLAUDE_PATH or an explicit binary option overrides it. */
export const CLAUDE_BINARY = '/usr/local/bin/claude'

/** Claude's configuration and credentials live in the Workspace, never on the host. */
export const claudeEnvironment: NativeEnvironmentHook = (_, workspace) => ({ CLAUDE_CONFIG_DIR: join(workspace, '.claude') })

/**
 * The per-Session conversation mapping kept by NativeClaude. The durable runtime
 * reads it once, to migrate a Session that started on that runner.
 */
export function claudeConversationStore(workspace: string, sessionId: string): ConversationStore {
  return new ConversationStore(workspace, 'claude', sessionId)
}

/**
 * Immutable options for one incarnation. Session identity always comes from the
 * context; explicit binary/model options take precedence over CLAUDE_PATH/CLAUDE_MODEL.
 */
export function resolveClaudeOptions(context: SessionHarnessContext, options: ClaudeHarnessFactoryOptions): ClaudeHarnessOptions {
  context.signal.throwIfAborted()
  // Callers may reuse or edit their source configuration. A live Session must
  // keep the exact MCP credentials, permissions and migration seed it accepted.
  const { workspace, binary, model, ...settings } = structuredClone(options)
  const selectedModel = model ?? context.env.CLAUDE_MODEL
  return {
    ...settings,
    workspace: workspace ?? process.cwd(),
    sessionId: context.session.id,
    binary: binary ?? context.env.CLAUDE_PATH ?? CLAUDE_BINARY,
    ...(selectedModel !== undefined ? { model: selectedModel } : {}),
  }
}

/** Configuration flags shared by every Claude launch, in the stock CLI's syntax. */
export function claudeArgs(options: ClaudeHarnessOptions, systemPromptFile?: string): string[] {
  return [
    ...(options.model ? ['--model', options.model] : []),
    ...(options.permissionMode ? ['--permission-mode', options.permissionMode] : []),
    ...(options.settingSources ? ['--setting-sources', options.settingSources.join(',')] : []),
    ...(options.tools ? ['--tools', options.tools.join(',')] : []),
    ...(options.allowedTools?.length ? ['--allowedTools', options.allowedTools.join(',')] : []),
    ...(options.maxTurns !== undefined ? ['--max-turns', String(options.maxTurns)] : []),
    ...(options.mcps ? ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: options.mcps })] : []),
    ...(systemPromptFile ? ['--system-prompt-file', systemPromptFile] : []),
  ]
}

/** What Claude's stream reported about its results so far. */
export interface ClaudeOutcome {
  readonly completed: boolean
  readonly failed: boolean
}

export interface ClaudeLaunch {
  /** Input/output mode flags, placed before the shared configuration flags. */
  readonly mode: readonly string[]
  /** Resume an existing native conversation, or claim this ID for a new one. */
  readonly conversation: { readonly id: string; readonly resume: boolean }
  readonly text: string
  readonly signal: AbortSignal
  /** Installs a live stdin channel instead of writing `text` and closing stdin. */
  readonly input?: (write: (text: string) => Promise<void>, end: () => void) => void
  /** Receives each event after the outcome reflects it. */
  emit(event: NativeEvent, outcome: ClaudeOutcome): Promise<void>
}

/**
 * Runs one stock Claude process with the Workspace environment and a private
 * system-prompt file, and returns the reported outcome for the caller to judge.
 * Claude's own authentication failure takes precedence over any other error.
 */
export async function runClaude(options: ClaudeHarnessOptions, launch: ClaudeLaunch): Promise<ClaudeOutcome> {
  const env = nativeEnvironment(options.workspace, claudeEnvironment)
  await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true, mode: 0o700 })
  const outcome = { completed: false, failed: false }
  let authFailed = false
  let directory: string | undefined
  try {
    let systemPromptFile: string | undefined
    if (options.systemPrompt !== undefined) {
      directory = await mkdtemp(join(tmpdir(), 'cantelop-claude-prompt-'))
      systemPromptFile = join(directory, 'system.txt')
      await writeFile(systemPromptFile, options.systemPrompt, { mode: 0o600 })
    }
    await runJsonProcess({
      binary: options.binary, cwd: options.workspace, env,
      args: [...launch.mode, ...claudeArgs(options, systemPromptFile),
        launch.conversation.resume ? '--resume' : '--session-id', launch.conversation.id],
      ...(launch.input ? { input: launch.input } : {}),
      turn: { text: launch.text, signal: launch.signal, emit: async event => {
        authFailed ||= event.type === 'assistant' && event.error === 'authentication_failed'
        if (event.type === 'result') { outcome.completed = true; outcome.failed ||= event.is_error === true }
        await launch.emit(event, outcome)
      } },
    })
  } catch (error) {
    if (authFailed) throw new ClaudeAuthenticationRequired()
    throw error
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
  if (authFailed) throw new ClaudeAuthenticationRequired()
  return outcome
}
