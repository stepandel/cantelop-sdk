/// <reference types="node" />
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { SessionBehaviour, SessionContext, SessionActivationContext, SessionActivityContext, SessionHarnessContext } from '../session.js'
import { ClaudeAuthenticationRequired, type ClaudeHarnessFactoryOptions } from './claude.js'
import { ConversationStore, type NativeEvent } from './cli.js'
import { createClaudeStream, type ClaudeStream, type ClaudeStreamFactory } from './claude-stream.js'
import { DurableClaudeStore, type DurableClaudeInput } from './claude-durable-state.js'
import { claudeView, observeClaude, clip } from './claude-view.js'
import { validateClaudeSessionConfig, validateClaudeSessionSettings } from './claude-config.js'
import type { ClaudeSessionCommand as Command, ClaudeSessionEvent as Event, ClaudeSessionReply as Reply,
  ClaudeSessionView as View, ClaudeSessionSettings as Settings } from './claude-protocol.js'

type Context = SessionContext<Command, Event, Reply, View>
type PublicationContext = Pick<SessionActivityContext<Command, Event, View>, 'output' | 'view'>
interface ActiveRun {
  id: string
  controller: AbortController
  settings: Settings
  stream?: ClaudeStream
  cancelRequested?: boolean
  ready: Promise<ClaudeStream>
  resolve(stream: ClaudeStream): void
  reject(error: unknown): void
}
function fingerprint(text: string, settings: Settings): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, canonical(value)])) : v
  return createHash('sha256').update(JSON.stringify([text, canonical(settings)])).digest('hex')
}
const pending = (m: DurableClaudeInput) => m.status === 'delivering' || m.status === 'running'

/** Durable observation and input delivery around stock Claude; busy input steers the live run. */
export function createClaudeRuntime(options: ClaudeHarnessFactoryOptions = {}, factory: ClaudeStreamFactory = createClaudeStream): SessionBehaviour<Command, Event, Reply, View> {
  const defaults = structuredClone(options)
  const { tools, allowedTools, mcps, model, systemPrompt, maxTurns, ...nativeDefaults } = defaults
  const appSettings = validateClaudeSessionSettings(Object.fromEntries(Object.entries({ tools, allowedTools, mcps,
    model: model === '' ? undefined : model, systemPrompt, maxTurns }).filter(([, value]) => value !== undefined)))
  validateClaudeSessionConfig(appSettings)
  const workspace = defaults.workspace ?? process.cwd()
  let resources: SessionHarnessContext
  let store: DurableClaudeStore
  let initialization: Promise<void> | undefined
  let active: ActiveRun | undefined
  let publishing: Promise<void> = Promise.resolve()

  function initialize(sessionId: string): Promise<void> {
    return initialization ??= (async () => {
      store = new DurableClaudeStore(workspace, sessionId)
      await store.open()
      // Migrate the older runner's authoritative native ID once. New state,
      // including explicit reset, no longer depends on that legacy mapping.
      const seed = store.state.revision === 0 ? await new ConversationStore(workspace, 'claude', sessionId).load() : undefined
      await store.commit(state => {
        if (state.revision === 0) {
          const conversation = seed?.id ? { id: seed.id, resumable: seed.resumable } : defaults.conversation
          if (conversation) {
            if (!/^[0-9a-f-]{36}$/i.test(conversation.id)) throw new TypeError('Invalid Claude conversation ID')
            state.conversationId = conversation.id; state.nativeStarted = conversation.resumable
            if (conversation.resumable && !state.entries.length) state.truncated = true
          }
        }
        const wasCancelled = state.run?.status === 'cancelling'
        for (const m of state.messages) {
          if (pending(m)) { m.status = wasCancelled && m.runId === state.run?.id ? 'cancelled' : 'interrupted'; m.reason = 'native_outcome_unknown' }
          if (m.status !== 'accepted') delete m.settings
        }
        if (state.run && ['running', 'finishing', 'cancelling'].includes(state.run.status)) {
          state.run.status = wasCancelled ? 'cancelled' : 'interrupted'; state.run.error = 'native_outcome_unknown'
        }
        for (const entry of state.entries) if (entry.status === 'streaming') entry.status = 'interrupted'
        const retained = state.messages.filter(m => m.status === 'accepted')
        if (retained.length) {
          const nextRunId = randomUUID()
          for (const m of retained) {
            m.runId = nextRunId
            const entry = state.entries.find(e => e.id === m.id && e.role === 'user')
            if (entry) entry.runId = nextRunId
          }
        }
        delete state.runSettings
      })
    })()
  }

  // Publish in adapter revision order. A crash anywhere before acknowledgment
  // retains the same logical revision and payload for deduplicated retry.
  function flush(context: PublicationContext): Promise<void> {
    const result = publishing.catch(() => undefined).then(async () => {
      while (store.state.outbox.length) {
        const publication = store.state.outbox[0]!
        for (const event of publication.events) await context.output.send(event)
        await context.output.send({ type: 'session.changed', revision: publication.revision, state: publication.view })
        await context.view.commit(publication.view)
        await store.acknowledge(publication.revision)
      }
    })
    publishing = result
    void result.catch(() => undefined)
    return result
  }
  const fail = async (context: Context, code: string) => {
    context.reply({ type: 'error', code })
    await context.output.send({ type: 'error', code })
  }
  const replyInput = (context: Context, m: DurableClaudeInput) => context.reply({ type: 'input.status', id: m.id, runId: m.runId, status: m.status })

  async function observe(run: ActiveRun, event: NativeEvent, context: PublicationContext): Promise<void> {
    // Large native events retain the existing fragment protocol. Persist the
    // complete publication (including stable fragment IDs) before any delivery.
    const json = JSON.stringify(event), events: Event[] = []
    if (Buffer.byteLength(json) <= 48_000) events.push({ type: 'claude', id: run.id, event })
    else {
      const eventId = randomUUID(), total = Math.ceil(json.length / 8000)
      for (let index = 0; index < total; index++) events.push({ type: 'claude.fragment', id: run.id, eventId, index, total, json: json.slice(index * 8000, (index + 1) * 8000) })
    }
    await store.commit(state => {
      if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
        if (event.session_id !== state.conversationId) throw new Error('Claude conversation identity changed')
      }
      if (event.type === 'user' && typeof event.uuid === 'string') {
        const m = state.messages.find(m => m.runId === run.id && m.nativeId === event.uuid)
        if (m && m.status === 'delivering') m.status = 'running'
      }
      if (event.type === 'result') {
        for (const m of state.messages) if (m.runId === run.id && m.status === 'running') {
          m.status = event.is_error ? 'failed' : 'completed'; delete m.settings
        }
        if (!run.stream!.accepting && state.run?.status === 'running') state.run.status = 'finishing'
      }
      observeClaude(state, event)
    }, events)
    await flush(context)
  }

  async function deliver(run: ActiveRun, id: string, context: PublicationContext): Promise<void> {
    const stream = await run.ready
    const m = store.state.messages.find(m => m.id === id)!
    if (m.status !== 'accepted') return
    let attempted = false
    await store.commit(state => {
      const message = state.messages.find(m => m.id === id)!
      if (message.status !== 'accepted') return
      attempted = true
      message.status = 'delivering'; delete message.settings
      state.nativeStarted = true
    })
    if (!attempted) return
    try { await stream.send(m.nativeId, m.text) }
    catch (error) {
      run.controller.abort(error); stream.cancel()
      throw error
    }
    await flush(context)
  }

  function start(context: SessionActivationContext<Command, Event, View>): void {
    if (active || context.activity.active) return
    const first = store.state.messages.find(m => m.status === 'accepted')
    if (!first) return
    let resolve!: ActiveRun['resolve'], reject!: ActiveRun['reject']
    const ready = new Promise<ClaudeStream>((yes, no) => { resolve = yes; reject = no })
    void ready.catch(() => undefined)
    const run: ActiveRun = { id: first.runId, settings: structuredClone(first.settings ?? appSettings), controller: new AbortController(), ready, resolve, reject }
    active = run
    context.activity.start(async activity => {
      let outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted' = 'completed'
      let errorCode: string | undefined
      try {
        run.controller.signal.throwIfAborted()
        const before = store.state
        // Record the first attempted delivery before constructing a process.
        await store.commit(state => {
          const m = state.messages.find(m => m.id === first.id)!
          m.status = 'delivering'; delete m.settings
          state.nativeStarted = true
          state.run = { id: run.id, inputIds: state.messages.filter(m => m.runId === run.id && (pending(m) || m.status === 'accepted')).map(m => m.id), status: 'running' }
          state.runSettings = run.settings
        })
        run.stream = factory({ ...resources, signal: AbortSignal.any([resources.signal, activity.signal, run.controller.signal]) }, {
          ...nativeDefaults, workspace, ...run.settings,
          ...(run.settings.model === 'default' ? { model: '' } : {}),
          conversation: { id: before.conversationId, resumable: before.nativeStarted },
        }, event => observe(run, event, activity))
        run.resolve(run.stream)
        await run.stream.send(first.nativeId, first.text)
        // Only never-attempted input is eligible for recovery delivery.
        for (const m of store.state.messages.filter(m => m.runId === run.id && m.status === 'accepted')) await deliver(run, m.id, activity)
        await run.stream.done
      } catch (error) {
        run.reject(error)
        run.stream?.cancel()
        await run.stream?.done.catch(() => undefined)
        outcome = run.cancelRequested || store.state.run?.status === 'cancelling' ? 'cancelled'
          : activity.signal.aborted || resources.signal.aborted || run.controller.signal.aborted ? 'interrupted' : 'failed'
        errorCode = error instanceof Error && error.message === 'native_resume_unavailable' ? 'native_resume_unavailable'
          : error instanceof ClaudeAuthenticationRequired ? 'authentication_required' : outcome === 'interrupted' ? 'native_outcome_unknown' : 'native_execution_failed'
      } finally {
        const events: Event[] = errorCode === 'authentication_required' ? [{ type: 'auth.required', id: first.id }] : []
        await store.commit(state => {
          if (state.run?.id === run.id) {
            state.run.status = outcome
            if (errorCode) state.run.error = errorCode
          }
          for (const m of state.messages) if (m.runId === run.id && (pending(m) || m.status === 'accepted')) {
            m.status = outcome === 'cancelled' ? 'cancelled' : 'interrupted'
            m.reason = errorCode ?? 'native_outcome_unknown'
            delete m.settings
          }
          for (const entry of state.entries) if (entry.runId === run.id && entry.status === 'streaming') entry.status = 'interrupted'
          delete state.runSettings
        }, events)
        // An aborted activity cannot publish through its signal-scoped writers.
        // Admit a fresh internal operation after cleanup to repair the projection.
        activity.send({ type: 'sync' })
        try { if (!activity.signal.aborted) await flush(activity) } finally { if (active === run) active = undefined }
      }
    }, { onCancel: async () => {
      run.cancelRequested = true
      try { await store.commit(state => { if (state.run?.id === run.id) state.run.status = 'cancelling' }) }
      finally { run.controller.abort(); run.stream?.cancel() }
    } })
  }

  return {
    redelivery: true,
    async onActivate(context) {
      resources = context
      await initialize(context.session.id)
      await flush(context)
      start(context)
    },
    async receive(context) {
      await initialize(context.session.id)
      const command = context.message.payload
      if (command.type === 'sync') { await flush(context); return }
      if (command.type === 'snapshot') { await flush(context); context.reply({ type: 'session.state', state: claudeView(store.state) }); return }
      if (command.type === 'reset' || command.type === 'cancel') {
        const key = JSON.stringify([command.type, command.type === 'cancel' ? command.id ?? null : null])
        const previous = store.state.controls.find(r => r.id === context.message.id)
        if (previous) {
          if (previous.fingerprint !== key) { await fail(context, 'message_id_conflict'); return }
          if (previous.runId && active?.id === previous.runId) {
            active.cancelRequested = true; active.controller.abort(); active.stream?.cancel()
          }
          await flush(context); context.reply(previous.reply); return
        }
        if (store.state.controls.length >= 1000) { await fail(context, 'control_capacity'); return }
        if (command.type === 'reset') {
          if (active || context.activity.active) { await fail(context, 'run_busy'); return }
          const conversationId = randomUUID()
          const reply: Reply = { type: 'session.reset', conversationId }
          await store.commit(state => {
            state.conversationId = conversationId; state.nativeStarted = false; state.run = null
            state.controls.push({ id: context.message.id, fingerprint: key, reply })
          })
          await flush(context); context.reply(reply); return
        }
        if (command.id && !store.state.messages.some(m => m.id === command.id)) { await fail(context, 'message_not_found'); return }
        const selected = command.id ? store.state.messages.find(m => m.id === command.id) : undefined
        const target = active
        const requested = !!target && (!selected || selected.runId === target.id && (pending(selected) || selected.status === 'accepted'))
        const reply: Reply = { type: 'cancel.accepted', requested }
        if (requested) target!.cancelRequested = true
        await store.commit(state => {
          if (requested && state.run?.id === target!.id) state.run.status = 'cancelling'
          state.controls.push({ id: context.message.id, fingerprint: key, reply, ...(requested ? { runId: target!.id } : {}) })
        })
        if (requested) { target!.controller.abort(); target!.stream?.cancel() }
        await flush(context); context.reply(reply); return
      }
      // Old queue commands must not silently become steering inputs.
      if (command.type !== 'input' && command.type !== 'steer') { await fail(context, 'unsupported_command'); return }
      if (typeof command.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(command.id) ||
          typeof command.text !== 'string' || !command.text.trim() || Buffer.byteLength(command.text) > 32 * 1024) {
        await fail(context, 'invalid_input'); return
      }
      const overrides = command.settings === undefined ? {} : validateClaudeSessionSettings(command.settings)
      const hash = fingerprint(command.text, overrides)
      const existing = store.state.messages.find(m => m.id === command.id)
      if (existing) {
        if (existing.fingerprint !== hash) { await fail(context, 'message_id_conflict'); return }
        await flush(context)
        if (existing.status === 'accepted') {
          if (active) await deliver(active, existing.id, context)
          else start(context)
        }
        replyInput(context, store.state.messages.find(m => m.id === existing.id)!); return
      }
      if (active && ((active.stream && !active.stream.accepting) || active.controller.signal.aborted) || !active && context.activity.active) {
        await fail(context, 'run_finishing'); return
      }
      const target = active
      const settings = target ? structuredClone({ ...target.settings, ...overrides }) : structuredClone({ ...appSettings, ...overrides })
      if (target && !isDeepStrictEqual(settings, target.settings)) { await fail(context, 'active_settings_conflict'); return }
      if (store.state.messages.length >= 1000) { await fail(context, 'session_full'); return }
      if (active && store.state.messages.filter(m => m.runId === active!.id).length >= 32) { await fail(context, 'run_input_capacity'); return }
      const runId = target?.id ?? randomUUID()
      await store.commit(state => {
        state.messages.push({ id: command.id, text: command.text, nativeId: randomUUID(), runId,
          status: 'accepted', settings, fingerprint: hash })
        if (state.run?.id === runId) state.run.inputIds.push(command.id)
        const text = clip(command.text, 8 * 1024)
        if (text !== command.text) state.truncated = true
        state.entries.push({ id: command.id, runId, role: 'user', text, status: 'completed' })
        if (state.entries.length > 256) { state.entries.shift(); state.truncated = true }
      })
      await flush(context)
      if (target) await deliver(target, command.id, context)
      else start(context)
      replyInput(context, store.state.messages.find(m => m.id === command.id)!)
    },
    async onRecover(context) { await initialize(context.session.id); await flush(context); start(context) },
  }
}
