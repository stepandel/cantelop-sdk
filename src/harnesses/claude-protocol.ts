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
export type ClaudeSessionCommand =
  | { type: 'snapshot' | 'drain' }
  | { type: 'configure'; config: ClaudeSessionConfig }
  | { type: 'queue' | 'steer'; id: string; text: string }
  | { type: 'cancel'; id: string }
export type ClaudeSessionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'steered' | 'interrupted'
export interface ClaudeSessionMessage {
  id: string
  text: string
  status: ClaudeSessionStatus
}
export type ClaudeSessionReply = Extract<ClaudeSessionEvent, { type: 'session.state' | 'error' }>
export type ClaudeSessionEvent =
  | { type: 'auth.required'; id: string }
  | { type: 'session.ready'; sessionId: string }
  | { type: 'session.state'; messages: ClaudeSessionMessage[]; configured: boolean; truncated: boolean }
  | { type: 'message.status'; id: string; status: ClaudeSessionStatus }
  | { type: 'claude'; id: string; event: unknown }
  | { type: 'claude.fragment'; id: string; eventId: string; index: number; total: number; json: string }
  | { type: 'error'; code: string }
