import type { ClaudeConversationEntry, ClaudeSessionView } from './claude-protocol.js'
import type { DurableClaudeState } from './claude-durable-state.js'
import type { NativeEvent } from './cli.js'

const utf8 = new TextEncoder()
export function clip(text: string, bytes: number): string {
  if (utf8.encode(text).length <= bytes) return text
  // Slice by code points so truncation never leaves an unmatched surrogate.
  let result = '', size = 0
  for (const character of text) { const n = utf8.encode(character).length; if (size + n > bytes) break; result += character; size += n }
  return result
}
export function claudeView(state: DurableClaudeState): ClaudeSessionView {
  const view: ClaudeSessionView = { version: 1, revision: state.revision, conversationId: state.conversationId,
    inputs: state.messages.slice(-32).map(m => ({ id: m.id, runId: m.runId, text: clip(m.text, 1024), status: m.status,
      ...(m.reason ? { reason: m.reason } : {}) })),
    run: state.run ? structuredClone(state.run) : null, entries: structuredClone(state.entries.slice(-32)),
    ...(state.usage ? { usage: structuredClone(state.usage) } : {}),
    truncated: state.truncated || state.messages.length > 32 || state.entries.length > 32 || state.messages.some(m => utf8.encode(m.text).length > 1024),
  }
  // Leave space for the change envelope under the platform's 64 KiB frame limit.
  while (utf8.encode(JSON.stringify(view)).length > 48 * 1024) {
    view.truncated = true
    if (view.entries.length) view.entries.shift()
    else if (view.inputs.length) view.inputs.shift()
    else throw new Error('Claude view exceeds limit')
  }
  return view
}

/** Reduce public native observations, without depending on private transcript formats. */
export function observeClaude(state: DurableClaudeState, event: NativeEvent): void {
  const runId = state.run!.id
  const put = (entry: ClaudeConversationEntry, append = false) => {
    const previous = state.entries.find(e => e.id === entry.id && e.runId === runId)
    const text = append && previous ? previous.text + entry.text : entry.text
    const retained = clip(text, 8 * 1024)
    if (retained !== text) state.truncated = true
    if (previous) Object.assign(previous, entry, { text: retained })
    else state.entries.push({ ...entry, text: retained })
  }
  const content = (blocks: unknown, prefix: string) => {
    if (!Array.isArray(blocks)) return
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        // Claude may emit one block per event, so the array index is not the block index.
        // Reuse the streamed entry holding this text, else the first free slot for this message.
        const ids = new Set(state.entries.filter(e => e.runId === runId && e.id.startsWith(`${prefix}:`)).map(e => e.id))
        const match = state.entries.find(e => e.runId === runId && e.role === 'assistant' && ids.has(e.id) && e.text === clip(block.text, 8 * 1024))
        let index = i
        while (!match && ids.has(`${prefix}:${index}`)) index++
        put({ id: match?.id ?? `${prefix}:${index}`, runId, role: 'assistant', text: block.text, status: 'completed' })
      }
      if (block.type === 'tool_use' && typeof block.id === 'string')
        put({ id: block.id, runId, role: 'tool', text: JSON.stringify(block.input ?? {}), toolName: String(block.name ?? 'tool'), status: 'streaming' })
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const previous = state.entries.find(e => e.id === block.tool_use_id && e.runId === runId)
        put({ id: block.tool_use_id, runId, role: 'tool', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          ...(previous?.toolName ? { toolName: previous.toolName } : {}), status: block.is_error ? 'failed' : 'completed' })
      }
    }
  }
  const raw = event as Record<string, any>
  if (event.type === 'stream_event' && raw.event) {
    const e = raw.event
    if (e.type === 'message_start' && typeof e.message?.id === 'string') state.assistantId = e.message.id
    const id = `${state.assistantId ?? 'stream'}:${e.index ?? 0}`
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string')
      put({ id, runId, role: 'assistant', text: e.delta.text, status: 'streaming' }, true)
    if (e.type === 'content_block_stop') {
      const entry = state.entries.find(entry => entry.id === id && entry.runId === runId)
      if (entry) entry.status = 'completed'
    }
  }
  if (event.type === 'assistant') content(raw.message?.content, String(raw.message?.id ?? raw.uuid ?? 'assistant'))
  if (event.type === 'user') content(raw.message?.content, String(raw.uuid ?? 'user'))
  if (event.type === 'result') {
    if (typeof event.result === 'string' && !state.entries.some(e => e.runId === runId && e.role === 'assistant'))
      put({ id: `${runId}:result`, runId, role: 'assistant', text: event.result, status: event.is_error ? 'failed' : 'completed' })
    const usage = raw.usage
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
    state.usage = { inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens), costUsd: number(raw.total_cost_usd) }
  }
  if (state.entries.length > 256) { state.entries.splice(0, state.entries.length - 256); state.truncated = true }
}
