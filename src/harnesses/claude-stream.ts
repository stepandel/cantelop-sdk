/// <reference types="node" />
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionHarnessContext } from '../session.js'
import type { ClaudeHarnessFactoryOptions, ClaudeHarnessOptions } from './claude.js'
import { ClaudeAuthenticationRequired } from './claude.js'
import { nativeEnvironment, runJsonProcess, type NativeEvent } from './cli.js'

/** The run stopped accepting input before this input was written to Claude. */
export class ClaudeStreamClosed extends Error {
  constructor() { super('Claude run is finishing') }
}
export interface ClaudeStream {
  readonly accepting: boolean
  readonly done: Promise<void>
  /** Resolves on stdin handoff, not on native consumption or completion. */
  send(id: string, text: string): Promise<void>
  cancel(): void
}
export type ClaudeStreamFactory = (
  context: SessionHarnessContext,
  options: ClaudeHarnessFactoryOptions,
  emit: (event: NativeEvent) => Promise<void>,
) => ClaudeStream

/** File presence is only a resume candidate; Claude still validates its contents. */
export async function hasClaudeTranscript(workspace: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false
  const root = join(workspace, '.claude', 'projects')
  let projects
  try { projects = await readdir(root, { withFileTypes: true }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    try { if ((await stat(join(root, project.name, `${id}.jsonl`))).size > 0) return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return false
}

/** One native run, with input injected into its live stream rather than queued after it. */
export class NativeClaudeStream implements ClaudeStream {
  readonly done: Promise<void>
  private open = true
  private readonly controller = new AbortController()
  private write?: (text: string) => Promise<void>
  private end?: () => void
  private readonly ready: Promise<void>
  private readyResolve!: () => void
  private readyReject!: (error: unknown) => void
  private readonly pending = new Set<string>()
  private readonly consumed = new Set<string>()

  constructor(private readonly options: ClaudeHarnessOptions, lifetime: AbortSignal,
    private readonly emit: (event: NativeEvent) => Promise<void>) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject })
    void this.ready.catch(() => undefined)
    this.done = this.run(AbortSignal.any([lifetime, this.controller.signal])).finally(() => { this.open = false })
    void this.done.catch(error => this.readyReject(error))
  }
  get accepting() { return this.open && !this.controller.signal.aborted }
  async send(id: string, text: string): Promise<void> {
    if (!this.accepting) throw new ClaudeStreamClosed()
    if (!/^[0-9a-f-]{36}$/i.test(id) || Buffer.byteLength(text) > 32 * 1024) throw new TypeError('Invalid Claude input')
    this.pending.add(id)
    await this.ready
    if (!this.accepting) { this.pending.delete(id); throw new ClaudeStreamClosed() }
    await this.write!(JSON.stringify({ type: 'user', uuid: id, session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: text } }) + '\n')
  }
  cancel() { this.open = false; this.controller.abort() }

  private async run(signal: AbortSignal): Promise<void> {
    const options = this.options
    const conversation = options.conversation ?? { id: randomUUID(), resumable: false }
    // A transcript may exist even when its input was never confirmed (crash before echo); resume it then.
    const transcript = await hasClaudeTranscript(options.workspace, conversation.id)
    if (conversation.resumable && !transcript) throw new Error('native_resume_unavailable')
    const env = nativeEnvironment(options.workspace)
    await mkdir(env.CLAUDE_CONFIG_DIR!, { recursive: true, mode: 0o700 })
    let directory: string | undefined
    let completed = false, failed = false, authFailed = false
    try {
      if (options.systemPrompt !== undefined) {
        directory = await mkdtemp(join(tmpdir(), 'cantelop-claude-prompt-'))
        await writeFile(join(directory, 'system.txt'), options.systemPrompt, { mode: 0o600 })
      }
      await runJsonProcess({ binary: options.binary, cwd: options.workspace, env,
        args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
          '--include-partial-messages', '--replay-user-messages',
          ...(options.model ? ['--model', options.model] : []),
          ...(options.permissionMode ? ['--permission-mode', options.permissionMode] : []),
          ...(options.settingSources ? ['--setting-sources', options.settingSources.join(',')] : []),
          ...(options.tools ? ['--tools', options.tools.join(',')] : []),
          ...(options.allowedTools?.length ? ['--allowedTools', options.allowedTools.join(',')] : []),
          ...(options.maxTurns !== undefined ? ['--max-turns', String(options.maxTurns)] : []),
          ...(options.mcps ? ['--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: options.mcps })] : []),
          ...(directory ? ['--system-prompt-file', join(directory, 'system.txt')] : []),
          transcript ? '--resume' : '--session-id', conversation.id],
        input: (write, end) => { this.write = write; this.end = end; this.readyResolve() },
        turn: { text: '', signal, emit: async event => {
          if (event.type === 'user' && typeof event.uuid === 'string' && this.pending.has(event.uuid))
            this.consumed.add(event.uuid)
          authFailed ||= event.type === 'assistant' && event.error === 'authentication_failed'
          if (event.type === 'result') {
            completed = true; failed ||= event.is_error === true
            for (const id of this.consumed) this.pending.delete(id)
            this.consumed.clear()
            // Inputs not yet echoed belong to a later native turn. Keep reading
            // until their result, even when the earlier turn has just finished.
            if (!this.pending.size || failed) { this.open = false; this.end!() }
          }
          await this.emit(event)
        } },
      })
      if (!completed || failed || this.pending.size) throw new Error('Claude run did not complete successfully')
    } catch (error) { if (authFailed) throw new ClaudeAuthenticationRequired(); throw error }
    finally { if (directory) await rm(directory, { recursive: true, force: true }) }
  }
}

export const createClaudeStream: ClaudeStreamFactory = (context, options, emit) => {
  context.signal.throwIfAborted()
  const { workspace, binary, model, ...settings } = structuredClone(options)
  const selectedModel = model ?? context.env.CLAUDE_MODEL
  return new NativeClaudeStream({ ...settings, workspace: workspace ?? process.cwd(),
    binary: binary ?? context.env.CLAUDE_PATH ?? '/usr/local/bin/claude', sessionId: context.session.id,
    ...(selectedModel !== undefined ? { model: selectedModel } : {}),
  }, context.signal, emit)
}
