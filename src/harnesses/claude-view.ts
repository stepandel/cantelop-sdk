import type { ClaudeConversationEntry, ClaudeSessionView } from './claude-protocol.js'
import type { DurableClaudeState } from './claude-durable-state.js'
import type { NativeEvent } from './cli.js'
import { CLAUDE_ENTRY_MAX_BYTES, CLAUDE_MAX_ENTRIES } from './claude-types.js'
import { isRecord } from '../shared.js'

/** Inputs and entries published in a view; older ones remain in durable state only. */
const VIEW_ITEMS = 32
/** Published input text, in UTF-8 bytes. */
const VIEW_INPUT_TEXT_BYTES = 1024
/** Serialized view budget, leaving space for the change envelope under the platform's 64 KiB frame limit. */
const VIEW_MAX_BYTES = 48 * 1024

const utf8 = new TextEncoder()
const byteLength = (text: string) => utf8.encode(text).length
const record = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined

export function clip(text: string, bytes: number): string {
  if (byteLength(text) <= bytes) return text
  // Slice by code points so truncation never leaves an unmatched surrogate.
  let result = '', size = 0
  for (const character of text) { const n = byteLength(character); if (size + n > bytes) break; result += character; size += n }
  return result
}
export function claudeView(state: DurableClaudeState): ClaudeSessionView {
  const view: ClaudeSessionView = { version: 1, revision: state.revision, conversationId: state.conversationId,
    inputs: state.messages.slice(-VIEW_ITEMS).map(m => ({ id: m.id, runId: m.runId, text: clip(m.text, VIEW_INPUT_TEXT_BYTES), status: m.status,
      ...(m.reason ? { reason: m.reason } : {}) })),
    run: state.run ? structuredClone(state.run) : null, entries: structuredClone(state.entries.slice(-VIEW_ITEMS)),
    ...(state.usage ? { usage: structuredClone(state.usage) } : {}),
    truncated: state.truncated || state.messages.length > VIEW_ITEMS || state.entries.length > VIEW_ITEMS ||
      state.messages.some(m => byteLength(m.text) > VIEW_INPUT_TEXT_BYTES),
  }
  // Serialize once, then subtract each evicted item (and its separating comma)
  // rather than re-serializing the whole view per eviction.
  let size = byteLength(JSON.stringify(view))
  while (size > VIEW_MAX_BYTES) {
    if (!view.truncated) { view.truncated = true; size -= 1 } // "false" -> "true"
    const items: object[] = view.entries.length ? view.entries : view.inputs
    const evicted = items.shift()
    if (!evicted) throw new Error('Claude view exceeds limit')
    size -= byteLength(JSON.stringify(evicted)) + (items.length ? 1 : 0)
  }
  return view
}

/** Reduce public native observations, without depending on private transcript formats. */
export function observeClaude(state: DurableClaudeState, event: NativeEvent): void {
  const runId = state.run!.id
  const put = (entry: ClaudeConversationEntry, append = false) => {
    const previous = state.entries.find(e => e.id === entry.id && e.runId === runId)
    const text = append && previous ? previous.text + entry.text : entry.text
    const retained = clip(text, CLAUDE_ENTRY_MAX_BYTES)
    if (retained !== text) state.truncated = true
    if (previous) Object.assign(previous, entry, { text: retained })
    else state.entries.push({ ...entry, text: retained })
  }
  const content = (blocks: unknown, prefix: string) => {
    if (!Array.isArray(blocks)) return
    for (let i = 0; i < blocks.length; i++) {
      const block = record(blocks[i])
      if (!block) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        // Claude may emit one block per event, so the array index is not the block index.
        // Reuse the streamed entry holding this text, else the first free slot for this message.
        const ids = new Set(state.entries.filter(e => e.runId === runId && e.id.startsWith(`${prefix}:`)).map(e => e.id))
        const match = state.entries.find(e => e.runId === runId && e.role === 'assistant' && ids.has(e.id) && e.text === clip(block.text as string, CLAUDE_ENTRY_MAX_BYTES))
        let index = i
        while (!match && ids.has(`${prefix}:${index}`)) index++
        put({ id: match?.id ?? `${prefix}:${index}`, runId, role: 'assistant', text: block.text, status: 'completed' })
      }
      if (block.type === 'tool_use' && typeof block.id === 'string')
        put({ id: block.id, runId, role: 'tool', text: JSON.stringify(block.input ?? {}), toolName: String(block.name ?? 'tool'), status: 'streaming' })
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const toolUseId = block.tool_use_id
        const previous = state.entries.find(e => e.id === toolUseId && e.runId === runId)
        put({ id: toolUseId, runId, role: 'tool', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          ...(previous?.toolName ? { toolName: previous.toolName } : {}), status: block.is_error ? 'failed' : 'completed' })
      }
    }
  }
  const stream = event.type === 'stream_event' ? record(event.event) : undefined
  if (stream) {
    const message = record(stream.message)
    if (stream.type === 'message_start' && typeof message?.id === 'string') state.assistantId = message.id
    const id = `${state.assistantId ?? 'stream'}:${stream.index ?? 0}`
    const delta = record(stream.delta)
    if (stream.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string')
      put({ id, runId, role: 'assistant', text: delta.text, status: 'streaming' }, true)
    if (stream.type === 'content_block_stop') {
      const entry = state.entries.find(entry => entry.id === id && entry.runId === runId)
      if (entry) entry.status = 'completed'
    }
  }
  const message = record(event.message)
  if (event.type === 'assistant') content(message?.content, String(message?.id ?? event.uuid ?? 'assistant'))
  if (event.type === 'user') content(message?.content, String(event.uuid ?? 'user'))
  if (event.type === 'result') {
    if (typeof event.result === 'string' && !state.entries.some(e => e.runId === runId && e.role === 'assistant'))
      put({ id: `${runId}:result`, runId, role: 'assistant', text: event.result, status: event.is_error ? 'failed' : 'completed' })
    const usage = record(event.usage)
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    state.usage = { inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens), costUsd: number(event.total_cost_usd) }
  }
  if (state.entries.length > CLAUDE_MAX_ENTRIES) { state.entries.splice(0, state.entries.length - CLAUDE_MAX_ENTRIES); state.truncated = true }
}
