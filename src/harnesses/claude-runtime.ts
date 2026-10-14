/// <reference types="node" />
import type {
  SessionContext,
  SessionOutput,
  SessionActivationContext,
  SessionHarnessContext,
  SessionHarness,
} from '../session.js'
import {
  createClaudeHarness,
  ClaudeAuthenticationRequired,
  type ClaudeHarnessFactoryOptions,
  type ClaudeMessage,
  type ClaudeEvent,
  type NativeFragmentEvent,
} from './claude.js'
import { randomUUID } from 'node:crypto'
import { validateClaudeSessionConfig } from './claude-config.js'
import { StateStore, type State } from './claude-state.js'
import type { ClaudeSessionCommand as Command, ClaudeSessionEvent as Event, ClaudeSessionMessage as Message, ClaudeSessionStatus as Status, ClaudeSessionReply as Reply } from './claude-protocol.js'
type Context = SessionContext<Command, Event, Reply>

type ClaudeFactory = (
  context: SessionHarnessContext,
  options?: ClaudeHarnessFactoryOptions,
) => SessionHarness<ClaudeMessage, ClaudeEvent>

/** Durable Claude Session lifecycle. Native execution remains in createClaudeHarness.
 * Configuration is declared by the App; interrupted running work is never replayed.
 * Queue, targeted cancellation, steering, snapshots and recovery are package-owned.
 * App settings are snapshotted at construction and applied on every activation.
 */
export function createClaudeRuntime(options: ClaudeHarnessFactoryOptions = {}, factory: ClaudeFactory = createClaudeHarness) {
  const defaults = structuredClone(options)
  const { tools, allowedTools, mcps, model, systemPrompt, maxTurns } = defaults
  const config = validateClaudeSessionConfig({
    tools, allowedTools, mcps, model: model === '' ? undefined : model, systemPrompt, maxTurns,
  })
  const workspace = defaults.workspace ?? process.cwd()
  let resources: SessionHarnessContext | undefined
  let claude: SessionHarness<ClaudeMessage, ClaudeEvent> | undefined
  let state: State | undefined, store: StateStore | undefined
  let active: { message: Message; controller: AbortController; outcome?: Status } | undefined
  const save = () => store!.save(state!)
  async function initialize(sessionId: string) {
    if (state) return
    store = new StateStore(workspace, sessionId)
    state = await store.load()
    state.config = structuredClone(config)
    // A previous Sandbox may have executed tools before disappearing. Never
    // automatically replay that running turn; retain queued work for later.
    for (const message of state.messages) if (message.status === 'running') message.status = 'interrupted'
    await save()
  }
  const status = (output: SessionOutput<Event>, message: Message) =>
    output.send({ type: 'message.status', id: message.id, status: message.status })
  function snapshot(): Extract<Reply, { type: 'session.state' }> {
    const messages = state!.messages.slice(-50).map((m) => ({ ...m, text: m.text.slice(0, 256) }))
    return {
      type: 'session.state',
      configured: !!state!.config,
      messages,
      truncated: state!.messages.length > 50 || state!.messages.some((m) => m.text.length > 256),
    }
  }
  function nativeHarness() {
    if (claude) return claude
    if (!resources) throw new Error('Session activation is required')
    claude = factory(resources, {
      workspace,
      ...defaults,
      conversation: { id: state!.conversationId, resumable: state!.resume },
      ...(defaults.model === 'default' ? { model: '' } : {}),
    })
    return claude
  }
  async function start(context: Context) {
    if (context.activity.active || !state!.queue.length) return
    const id = state!.queue.shift()!,
      message = state!.messages.find((m) => m.id === id)!
    const native = nativeHarness()
    const controller = new AbortController()
    active = { message, controller }
    message.status = 'running'
    await save()
    context.activity.start(async (activity) => {
      const current = active!
      const abort = () => {
        current.outcome ??= 'interrupted'
        controller.abort(activity.signal.reason)
      }
      activity.signal.addEventListener('abort', abort, { once: true })
      if (activity.signal.aborted) abort()
      try {
        await status(activity.output, message)
        const prompt: ClaudeMessage = { type: 'prompt', prompt: message.text }
        await native.queue(prompt, {
          ...resources!,
          signal: controller.signal,
          message: { ...context.message, payload: prompt },
          view: activity.view,
          send: (next) => activity.send({ type: 'queue', id: randomUUID(), text: next.prompt }),
          output: {
            send: async (event) => {
              if (event.type === 'system' && event.subtype === 'init') {
                // Retain the checkpoint as a migration seed; the SDK owns
                // the authoritative native conversation and resumption state.
                if (typeof event.session_id === 'string') state!.conversationId = event.session_id
                state!.resume = true
                await save()
              }
              if (event.type === 'native.fragment') {
                const fragment = event as NativeFragmentEvent
                await activity.output.send({ ...fragment, type: 'claude.fragment', id })
              } else await activity.output.send({ type: 'claude', id, event })
            },
          },
        })
        message.status = current.outcome ?? 'completed'
      } catch (error) {
        message.status = current.outcome ?? 'failed'
        // The SDK exposes structured native sign-in failures; transport and billing errors stay ordinary failures.
        if (!controller.signal.aborted && error instanceof ClaudeAuthenticationRequired)
          await activity.output.send({ type: 'auth.required', id: message.id })
      } finally {
        activity.signal.removeEventListener('abort', abort)
        active = undefined
        await save()
        // SDK buffers this internal message until the activity fully settles.
        activity.send({ type: 'drain' })
      }
      if (!activity.signal.aborted) await status(activity.output, message)
    })
  }
  return {
    async onActivate(context: SessionActivationContext<Command, Event>) {
      resources = context
      await initialize(context.session.id)
      await context.output.send({ type: 'session.ready', sessionId: context.session.id })
    },
    async receive(context: Context) {
      await initialize(context.session.id)
      const command = context.message.payload
      if (command.type === 'snapshot') {
        context.reply(snapshot())
        return
      }
      if (command.type === 'drain') {
        await start(context)
        return
      }
      if (command.type === 'cancel') {
        const message = state!.messages.find((m) => m.id === command.id)
        if (!message) {
          await context.output.send({ type: 'error', code: 'message_not_found' })
          return
        }
        if (active?.message.id === message.id) {
          active.outcome = 'cancelled'
          active.controller.abort()
        } else if (message.status === 'queued') {
          state!.queue = state!.queue.filter((id) => id !== message.id)
          message.status = 'cancelled'
          await save()
          await status(context.output, message)
        }
        return
      }
      if (command.type !== 'queue' && command.type !== 'steer') return
      const existing = state!.messages.find((m) => m.id === command.id)
      if (existing) {
        if (existing.text !== command.text) await context.output.send({ type: 'error', code: 'message_id_conflict' })
        else await status(context.output, existing)
        return
      }
      if (state!.messages.length >= 1000) {
        await context.output.send({ type: 'error', code: 'session_full' })
        return
      }
      const message: Message = { id: command.id, text: command.text, status: 'queued' }
      state!.messages.push(message)
      if (command.type === 'steer') state!.queue.unshift(message.id)
      else state!.queue.push(message.id)
      await save()
      if (command.type === 'steer' && active) {
        active.outcome = 'steered'
        active.controller.abort()
      }
      await status(context.output, message)
      await start(context)
    },
    async onRecover(context: import('../session.js').SessionRecoveryContext<Command, Event>) {
      await initialize(context.session.id)
      await context.output.send(snapshot())
      // The interrupted turn stays interrupted. Queued, not-yet-started work resumes.
      await context.send({ type: 'drain' })
    },
  }
}

