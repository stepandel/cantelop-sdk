/** Browser-safe commands and committed observations for a durable Codex Session. */
export interface CodexSessionSettings {
  model?: string;
  systemPrompt?: string;
}
export type CodexSessionCommand =
  | {
      type: "queue" | "steer";
      id: string;
      text: string;
      settings?: CodexSessionSettings;
    }
  | { type: "cancel"; id: string }
  | { type: "snapshot" | "drain" }
  | { type: "events"; after?: number; limit?: number };
export type CodexSessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "steered"
  | "interrupted";
export interface CodexSessionMessage {
  id: string;
  text: string;
  status: CodexSessionStatus;
}
export interface CodexNativeEvent {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}
export type CodexSessionUpdate =
  | { type: "message.status"; id: string; status: CodexSessionStatus }
  | { type: "codex"; id: string; event: CodexNativeEvent }
  | {
      type: "codex.fragment";
      id: string;
      eventId: string;
      index: number;
      total: number;
      json: string;
    };
export type CodexCommittedEvent = CodexSessionUpdate & { seq: number };
export type CodexSessionEvent =
  | CodexCommittedEvent
  | { type: "session.ready"; sessionId: string }
  | { type: "error"; code: string };
export type CodexSessionReply =
  | {
      type: "session.state";
      configured: true;
      threadId?: string;
      cursor: number;
      messages: CodexSessionMessage[];
      truncated: boolean;
    }
  | {
      type: "session.events";
      events: CodexCommittedEvent[];
      cursor: number;
      hasMore: boolean;
    };

export function validateCodexSessionSettings(
  value: unknown,
): CodexSessionSettings {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["model", "systemPrompt"].includes(key))
  )
    throw new TypeError("Invalid Codex settings");
  const { model, systemPrompt } = value as CodexSessionSettings;
  if (
    model !== undefined &&
    (typeof model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))
  )
    throw new TypeError("Invalid Codex model");
  if (
    systemPrompt !== undefined &&
    (typeof systemPrompt !== "string" ||
      !systemPrompt.trim() ||
      new TextEncoder().encode(systemPrompt).length > 32 * 1024)
  )
    throw new TypeError("Invalid Codex system prompt");
  return {
    ...(model === undefined ? {} : { model }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

/** Feed live or replayed events for one task. Sequence deduplication belongs to the caller. */
export class CodexSessionOutput {
  private readonly fragments = new Map<
    string,
    { parts: string[]; total: number; size: number; count: number }
  >();
  private size = 0;
  constructor(private readonly messageId: string) {}
  accept(event: CodexSessionEvent): CodexNativeEvent | undefined {
    if (!("id" in event) || event.id !== this.messageId) return;
    if (event.type === "codex") return event.event;
    if (event.type !== "codex.fragment") return;
    if (
      !Number.isSafeInteger(event.total) ||
      event.total < 1 ||
      event.total > 1024 ||
      !Number.isSafeInteger(event.index) ||
      event.index < 0 ||
      event.index >= event.total ||
      typeof event.json !== "string"
    )
      throw new Error("Invalid Codex fragments");
    const pending = this.fragments.get(event.eventId) ?? {
      parts: [],
      total: event.total,
      size: 0,
      count: 0,
    };
    if (pending.total !== event.total)
      throw new Error("Inconsistent Codex fragments");
    const previous = pending.parts[event.index];
    if (previous !== undefined) {
      if (previous !== event.json)
        throw new Error("Conflicting Codex fragments");
      return;
    }
    const bytes = new TextEncoder().encode(event.json).length;
    if (
      // A UTF-16 chunk boundary can split a surrogate pair, adding two UTF-8
      // bytes per fragment until the complete JSON string is reassembled.
      this.size + bytes > 4 * 1024 * 1024 + 2048 ||
      (!this.fragments.has(event.eventId) && this.fragments.size >= 32)
    )
      throw new Error("Codex fragment limit");
    pending.parts[event.index] = event.json;
    pending.count++;
    pending.size += bytes;
    this.size += bytes;
    this.fragments.set(event.eventId, pending);
    if (pending.count !== pending.total) return;
    this.fragments.delete(event.eventId);
    this.size -= pending.size;
    const native = JSON.parse(pending.parts.join("")) as CodexNativeEvent;
    if (
      !native ||
      typeof native.method !== "string" ||
      !native.params ||
      typeof native.params !== "object"
    )
      throw new Error("Invalid Codex event");
    return native;
  }
}
