import type { ClaudeSessionEvent } from "./claude-protocol.js";
type NativeEvent = Readonly<Record<string, unknown>>;
interface Fragments { parts: string[]; total: number; received: number; size: number }

/** Decode only one message's native events; incomplete fragments remain bounded. */
export class ClaudeSessionOutput {
  private readonly fragments = new Map<string, Fragments>();
  private size = 0;
  constructor(private readonly messageId: string) {}
  accept(event: ClaudeSessionEvent): NativeEvent | undefined {
    if (!("id" in event) || event.id !== this.messageId) return;
    if (event.type === "claude") return this.native(event.event);
    if (event.type !== "claude.fragment") return;
    if (!Number.isSafeInteger(event.total) || event.total < 1 || event.total > 1024 ||
        !Number.isSafeInteger(event.index) || event.index < 0 || event.index >= event.total || typeof event.json !== "string")
      throw new Error("Invalid Claude output fragments.");
    const fragment = this.fragments.get(event.eventId) ?? {parts: [], total: event.total, received: 0, size: 0};
    if (fragment.total !== event.total) throw new Error("Inconsistent Claude output fragments.");
    if (fragment.parts[event.index] !== undefined) {
      if (fragment.parts[event.index] !== event.json) throw new Error("Conflicting Claude output fragments.");
      return;
    }
    const bytes = new TextEncoder().encode(event.json).length;
    if (this.size + bytes > 4 * 1024 * 1024 || !this.fragments.has(event.eventId) && this.fragments.size >= 32)
      throw new Error("Claude output exceeded the fragment limit.");
    fragment.parts[event.index] = event.json;
    fragment.size += bytes; this.size += bytes; fragment.received++;
    this.fragments.set(event.eventId, fragment);
    if (fragment.received !== fragment.total) return;
    this.fragments.delete(event.eventId); this.size -= fragment.size;
    return this.native(JSON.parse(fragment.parts.join("")));
  }
  private native(value: unknown): NativeEvent | undefined {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as NativeEvent;
  }
}
