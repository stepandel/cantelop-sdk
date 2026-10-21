/// <reference types="node" />
import { readdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { SessionHarnessContext } from '../session.js'
import type { NativeEvent } from './cli.js'
import { resolveClaudeOptions, runClaude } from './claude-launch.js'
import { CLAUDE_INPUT_MAX_BYTES, isClaudeUUID, type ClaudeHarnessFactoryOptions, type ClaudeHarnessOptions } from './claude-types.js'

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
  if (!isClaudeUUID(id)) return false
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
    if (!isClaudeUUID(id) || Buffer.byteLength(text) > CLAUDE_INPUT_MAX_BYTES) throw new TypeError('Invalid Claude input')
    this.pending.add(id)
    await this.ready
    if (!this.accepting) { this.pending.delete(id); throw new ClaudeStreamClosed() }
    await this.write!(JSON.stringify({ type: 'user', uuid: id, session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: text } }) + '\n')
  }
  cancel() { this.open = false; this.controller.abort() }

  private async run(signal: AbortSignal): Promise<void> {
    const conversation = this.options.conversation ?? { id: randomUUID(), resumable: false }
    // A transcript may exist even when its input was never confirmed (crash before echo); resume it then.
    const transcript = await hasClaudeTranscript(this.options.workspace, conversation.id)
    if (conversation.resumable && !transcript) throw new Error('native_resume_unavailable')
    const outcome = await runClaude(this.options, {
      mode: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--replay-user-messages'],
      conversation: { id: conversation.id, resume: transcript },
      text: '', signal,
      input: (write, end) => { this.write = write; this.end = end; this.readyResolve() },
      emit: async (event, outcome) => {
        if (event.type === 'user' && typeof event.uuid === 'string' && this.pending.has(event.uuid))
          this.consumed.add(event.uuid)
        if (event.type === 'result') {
          for (const id of this.consumed) this.pending.delete(id)
          this.consumed.clear()
          // Inputs not yet echoed belong to a later native turn. Keep reading
          // until their result, even when the earlier turn has just finished.
          if (!this.pending.size || outcome.failed) { this.open = false; this.end!() }
        }
        await this.emit(event)
      },
    })
    if (!outcome.completed || outcome.failed || this.pending.size) throw new Error('Claude run did not complete successfully')
  }
}

export const createClaudeStream: ClaudeStreamFactory = (context, options, emit) =>
  new NativeClaudeStream(resolveClaudeOptions(context, options), context.signal, emit)
