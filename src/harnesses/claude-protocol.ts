export type McpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
export interface ClaudeSessionConfig {
  model?: string
  systemPrompt?: string
  maxTurns?: number
  tools: string[]
  allowedTools: string[]
  mcps: Record<string, McpServer>
}
/** Per-task overrides; omitted fields inherit App defaults. Lists and MCP maps replace defaults. */
export type ClaudeSessionSettings = Partial<ClaudeSessionConfig>
export type ClaudeSessionCommand =
  | { type: 'snapshot' }
  | { type: 'reset' }
  | { type: 'sync' }
  | { type: 'input' | 'steer'; id: string; text: string; settings?: ClaudeSessionSettings }
  | { type: 'cancel'; id?: string }
export type ClaudeSessionReply =
  | { type: 'session.state'; state: ClaudeSessionView }
  | { type: 'input.status'; id: string; runId: string; status: ClaudeInputStatus }
  | { type: 'cancel.accepted'; requested: boolean }
  | { type: 'session.reset'; conversationId: string }
  | { type: 'error'; code: string }
export type ClaudeSessionEvent =
  | ClaudeSessionChange
  | { type: 'auth.required'; id: string }
  | { type: 'session.ready'; sessionId: string }
  | { type: 'claude'; id: string; event: unknown; revision?: number }
  | { type: 'claude.fragment'; id: string; eventId: string; index: number; total: number; json: string; revision?: number }
  | { type: 'error'; code: string }

// These helpers are backend/browser-safe; no native process modules are imported.
export { validateClaudeSessionConfig, validateClaudeSessionSettings } from './claude-config.js'
export { ClaudeSessionOutput } from './claude-output.js'

/** Input delivery and native execution are different durability boundaries. */
export type ClaudeInputStatus = 'accepted' | 'delivering' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface ClaudeViewInput {
  id: string
  runId: string
  text: string
  status: ClaudeInputStatus
  reason?: string
}
export interface ClaudeViewRun {
  id: string
  inputIds: string[]
  status: 'running' | 'finishing' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  error?: string
}
export interface ClaudeConversationEntry {
  id: string
  runId: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  toolName?: string
  status: 'streaming' | 'completed' | 'interrupted' | 'failed'
}
export interface ClaudeSessionView {
  version: 1
  /** Adapter revision for deduplicating replay; distinct from the platform cursor. */
  revision: number
  conversationId: string
  inputs: ClaudeViewInput[]
  run: ClaudeViewRun | null
  entries: ClaudeConversationEntry[]
  usage?: { inputTokens: number; outputTokens: number; costUsd: number }
  truncated: boolean
}
export interface ClaudeSessionChange {
  type: 'session.changed'
  revision: number
  state: ClaudeSessionView
}

/** Changes carry complete bounded projections; old or retried revisions are harmless. */
export function applyClaudeSessionChange(view: ClaudeSessionView, change: ClaudeSessionChange): ClaudeSessionView {
  if (change.revision !== change.state.revision || change.state.version !== 1 ||
      !Number.isSafeInteger(change.revision) || change.revision < 0) throw new TypeError('Invalid Claude view change')
  return change.revision > view.revision ? structuredClone(change.state) : view
}
