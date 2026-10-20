/// <reference types="node" />
import { mkdir, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import type { ClaudeSessionEvent, ClaudeSessionSettings, ClaudeViewInput, ClaudeSessionView, ClaudeSessionReply } from './claude-protocol.js'
import { claudeView } from './claude-view.js'
import { writeDurableJson } from './durable-file.js'

export interface DurableClaudeInput extends ClaudeViewInput {
  nativeId: string
  fingerprint: string
  /** Private accepted settings, erased on consumption or terminal outcome. */
  settings?: ClaudeSessionSettings
}
export interface ClaudePublication {
  revision: number
  view: ClaudeSessionView
  events: ClaudeSessionEvent[]
}
export interface DurableClaudeState {
  version: 2
  revision: number
  conversationId: string
  nativeStarted: boolean
  messages: DurableClaudeInput[]
  run: ClaudeSessionView['run']
  runSettings?: ClaudeSessionSettings
  entries: ClaudeSessionView['entries']
  usage?: NonNullable<ClaudeSessionView['usage']>
  assistantId?: string
  truncated: boolean
  outbox: ClaudePublication[]
  controls: { id: string; fingerprint: string; reply: ClaudeSessionReply; runId?: string }[]
}
const statuses = new Set(['accepted', 'delivering', 'running', 'completed', 'failed', 'cancelled', 'interrupted'])
function decode(value: any): DurableClaudeState {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages) || typeof value.conversationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.conversationId)) throw new Error('Invalid Claude state')
  if (value.version === undefined) {
    if (typeof value.resume !== 'boolean' || !Array.isArray(value.queue)) throw new Error('Invalid legacy Claude state')
    return { version: 2, revision: 0, conversationId: value.conversationId, nativeStarted: value.resume,
      messages: value.messages.map((m: any) => {
        if (typeof m.id !== 'string' || typeof m.text !== 'string') throw new Error('Invalid legacy Claude input')
        const interrupted = m.status === 'queued' || m.status === 'running'
        return { id: m.id, text: m.text, runId: 'legacy', nativeId: randomUUID(), fingerprint: m.settingsHash ?? '',
          status: interrupted || !statuses.has(m.status) ? 'interrupted' : m.status,
          ...(interrupted ? { reason: 'legacy_runtime_replaced' } : {}) }
      }), run: null, entries: [], truncated: value.messages.length > 0, outbox: [], controls: [] }
  }
  if (value.version !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.nativeStarted !== 'boolean' ||
      !Array.isArray(value.entries) || !Array.isArray(value.outbox) || typeof value.truncated !== 'boolean' ||
      value.messages.length > 1000 || value.outbox.length > 256 || value.entries.length > 256 ||
      value.messages.some((m: any) => !m || typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.runId !== 'string' ||
        typeof m.nativeId !== 'string' || typeof m.fingerprint !== 'string' || !statuses.has(m.status)) ||
      value.outbox.some((p: any) => !p || !Number.isSafeInteger(p.revision) || p.revision > value.revision ||
        p.view?.revision !== p.revision || !Array.isArray(p.events))) throw new Error('Invalid Claude state')
  value.controls ??= []
  if (!Array.isArray(value.controls) || value.controls.length > 1000 || value.controls.some((r: any) =>
      !r || typeof r.id !== 'string' || typeof r.fingerprint !== 'string' || !r.reply || !['cancel.accepted', 'session.reset'].includes(r.reply.type))) throw new Error('Invalid Claude controls')
  if (value.run !== null && (!value.run || typeof value.run.id !== 'string' || !Array.isArray(value.run.inputIds) ||
      !['running', 'finishing', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(value.run.status))) throw new Error('Invalid Claude run')
  return value
}

/** Single-owner state transactions, including a recoverable publication outbox. */
export class DurableClaudeStore {
  private operations: Promise<unknown> = Promise.resolve()
  /** Set once a durable write fails; see persist(). */
  private fenced?: { reason: unknown }
  private current?: DurableClaudeState
  private opening?: Promise<void> | undefined
  readonly path: string
  constructor(private readonly workspace: string, sessionId: string) {
    this.path = `${workspace}/.cantelop/${createHash('sha256').update(sessionId).digest('hex')}.json`
  }
  get state(): DurableClaudeState {
    if (!this.current) throw new Error('Claude store is not open')
    return structuredClone(this.current)
  }
  /** Uncopied committed state for reads. Commits replace it rather than mutating it, so callers must not mutate. */
  get snapshot(): Readonly<DurableClaudeState> {
    if (!this.current) throw new Error('Claude store is not open')
    return this.current
  }
  /** Copy for a transaction; publications are immutable once queued, so the outbox is shared shallowly. */
  private draft(): DurableClaudeState {
    const { outbox, ...rest } = this.snapshot
    return { ...structuredClone(rest), outbox: [...outbox] }
  }
  async open(): Promise<void> {
    return this.opening ??= (async () => {
      await mkdir(`${this.workspace}/.cantelop`, { recursive: true, mode: 0o700 })
      try {
        const bytes = await readFile(this.path, 'utf8')
        if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw new Error('Claude state exceeds limit')
        this.current = decode(JSON.parse(bytes))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.current = { version: 2, revision: 0, conversationId: randomUUID(), nativeStarted: false,
          messages: [], run: null, entries: [], truncated: false, outbox: [], controls: [] }
      }
    })().catch(error => { this.opening = undefined; throw error })
  }
  commit(mutate: (state: DurableClaudeState) => void, events: ClaudeSessionEvent[] = []): Promise<void> {
    return this.serialize(async () => {
      const state = this.draft()
      mutate(state)
      state.revision++
      if (!Number.isSafeInteger(state.revision)) throw new Error('Claude revision exhausted')
      if (state.outbox.length >= 256) throw new Error('Claude publication capacity')
      state.outbox.push({ revision: state.revision, view: claudeView(state), events: events.map(event => event.type === 'claude' || event.type === 'claude.fragment' ? { ...event, revision: state.revision } : event) })
      await this.persist(state)
    })
  }
  acknowledge(revision: number): Promise<void> {
    return this.serialize(async () => {
      const state = this.draft()
      state.outbox = state.outbox.filter(p => p.revision > revision)
      await this.persist(state)
    })
  }
  /**
   * A failed write fences every later operation: the rename may have landed
   * before the failure, so disk can be ahead of memory, and committing again
   * would reuse a revision for a different publication. Failures before any
   * write (a throwing mutation, a full outbox) reject only their own operation.
   */
  private async persist(state: DurableClaudeState): Promise<void> {
    try {
      await writeDurableJson(this.path, state)
    } catch (error) {
      this.fenced = { reason: error }
      throw error
    }
    this.current = state
  }
  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.operations.then(() => {
      if (this.fenced) throw this.fenced.reason
      return work()
    })
    this.operations = next.catch(() => undefined)
    return next
  }
}
