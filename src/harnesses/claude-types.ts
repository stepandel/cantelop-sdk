import type { NativeOptions } from './cli.js'

/** Claude types, errors and limits shared by its runner, live stream and durable runtime. Imports no Claude module. */

/** Claude reported that the Workspace's own sign-in is missing or expired. */
export class ClaudeAuthenticationRequired extends Error {
  constructor() { super('Claude sign-in required') }
}

export type ClaudeMessage = { type: 'prompt'; prompt: string }
export interface ClaudeHarnessOptions extends NativeOptions {
  readonly permissionMode?: 'default' | 'dontAsk' | 'acceptEdits'
  readonly settingSources?: readonly string[]
  readonly tools?: readonly string[]
  readonly allowedTools?: readonly string[]
  readonly maxTurns?: number
  readonly systemPrompt?: string
  readonly mcps?: Readonly<Record<string, unknown>>
  /** Seed a previous runner's native conversation once; existing SDK state takes precedence. */
  readonly conversation?: { readonly id: string; readonly resumable: boolean }
}

/**
 * Optional native configuration for a Session's Claude harness. Session identity
 * always comes from the SDK context; omitted values retain the stock defaults.
 * Explicit binary/model options take precedence over CLAUDE_PATH/CLAUDE_MODEL.
 */
export type ClaudeHarnessFactoryOptions = Partial<Omit<ClaudeHarnessOptions, 'sessionId'>>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Claude conversation and message IDs are canonical 8-4-4-4-12 UUIDs. */
export function isClaudeUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** Largest input text, in UTF-8 bytes, accepted for one Claude message. */
export const CLAUDE_INPUT_MAX_BYTES = 32 * 1024
/** Retained conversation entry text, in UTF-8 bytes; longer text is clipped and marked truncated. */
export const CLAUDE_ENTRY_MAX_BYTES = 8 * 1024
/** Retained conversation entries; the oldest are evicted first. */
export const CLAUDE_MAX_ENTRIES = 256
/** Retained input identities; the oldest finished input is evicted first. */
export const CLAUDE_MAX_MESSAGES = 1000
/** Retained cancel/reset receipts; the oldest is evicted so controls always remain available. */
export const CLAUDE_MAX_CONTROLS = 1000
/** Unacknowledged publications in the durable outbox. */
export const CLAUDE_MAX_PUBLICATIONS = 256
