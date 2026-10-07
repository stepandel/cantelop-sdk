import type { Op } from "@earendil-works/chord/delta";
import type {
  ConversationId,
  ConversationView,
  TaskGraph,
} from "@earendil-works/pi-durable";

export type PiDurableUpdate =
  | {
      readonly type: "snapshot";
      readonly conversationId: ConversationId;
      readonly value: ConversationView;
      readonly tasks?: TaskGraph;
    }
  | {
      readonly type: "change";
      readonly conversationId: ConversationId;
      readonly ops: readonly Op[];
    }
  | {
      readonly type: "tasks";
      readonly conversationId: ConversationId;
      readonly value: TaskGraph;
    };

/** Base64 UTF-8 JSON frames, chunked below Cantelop's 64 KiB output limit. */
export interface PiDurableEvent {
  readonly type: "pi-durable";
  readonly streamId: string;
  readonly conversationId: ConversationId;
  readonly sequence: number;
  readonly part: number;
  readonly parts: number;
  readonly data: string;
}

export function encodePiDurableUpdate(
  update: PiDurableUpdate,
  streamId: string,
  sequence: number,
): PiDurableEvent[] {
  const bytes = new TextEncoder().encode(JSON.stringify(update));
  const size = 24 * 1024;
  const parts = Math.max(1, Math.ceil(bytes.length / size));
  return Array.from({ length: parts }, (_, part) => ({
    type: "pi-durable",
    streamId,
    conversationId: update.conversationId,
    sequence,
    part,
    parts,
    data: btoa(
      String.fromCharCode(...bytes.subarray(part * size, (part + 1) * size)),
    ),
  }));
}

/**
 * Decode one conversation stream. A gap throws: request a new snapshot and reset.
 * A new stream must begin at sequence zero with a snapshot. A reset decoder joins a
 * live stream at any sequence and ignores updates until its next snapshot, so a
 * snapshot requested mid-activity resynchronizes. Bound memory by maxBytes.
 */
export function createPiDurableEventDecoder(
  options: { maxBytes?: number } = {},
): {
  push(event: PiDurableEvent): PiDurableUpdate | undefined;
  reset(): void;
} {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new TypeError("Invalid Pi event size limit");
  let streamId: string | undefined;
  let conversationId: ConversationId | undefined;
  let sequence = 0,
    part = 0,
    parts = 0,
    length = 0;
  let chunks: Uint8Array[] = [];
  let synced = false;
  const reset = () => {
    streamId = undefined;
    synced = false;
    conversationId = undefined;
    sequence = 0;
    part = 0;
    parts = 0;
    length = 0;
    chunks = [];
  };
  return {
    reset,
    push(event) {
      try {
        if (
          event.type !== "pi-durable" ||
          typeof event.streamId !== "string" ||
          !event.streamId ||
          !Number.isSafeInteger(event.conversationId) ||
          event.conversationId < 1 ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 0 ||
          !Number.isSafeInteger(event.part) ||
          event.part < 0 ||
          !Number.isSafeInteger(event.parts) ||
          event.parts < 1 ||
          event.part >= event.parts ||
          typeof event.data !== "string"
        )
          throw new Error("Invalid Pi event frame");
        if (event.streamId !== streamId) {
          // A reset decoder skips the tail of an update it joined part-way through.
          if (event.part !== 0 && streamId === undefined) return undefined;
          if (event.part !== 0 || (event.sequence !== 0 && streamId !== undefined))
            throw new Error("Pi stream requires a fresh snapshot");
          reset();
          streamId = event.streamId;
          conversationId = event.conversationId;
          sequence = event.sequence;
        }
        if (event.conversationId !== conversationId)
          throw new Error("Pi conversation changed inside a stream");
        if (
          event.sequence !== sequence ||
          event.part !== part ||
          (part !== 0 && event.parts !== parts)
        )
          throw new Error("Pi event gap; request a fresh snapshot");
        parts = event.parts;
        // Reject oversized input before decoding/allocation.
        if (
          event.parts > Math.ceil(maxBytes / (24 * 1024)) ||
          event.data.length === 0 ||
          event.data.length > 32768 ||
          length + Math.floor((event.data.length * 3) / 4) > maxBytes + 2
        )
          throw new Error("Pi event exceeds size limit");
        const chunk = Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0));
        length += chunk.length;
        if (length > maxBytes) throw new Error("Pi event exceeds size limit");
        chunks.push(chunk);
        part++;
        if (part !== parts) return undefined;
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const update = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as PiDurableUpdate;
        if (
          !update ||
          (update.type !== "snapshot" &&
            update.type !== "change" &&
            update.type !== "tasks") ||
          !Number.isSafeInteger(update.conversationId) ||
          update.conversationId !== conversationId ||
          (sequence === 0 && update.type !== "snapshot") ||
          (update.type === "change"
            ? !Array.isArray(update.ops)
            : !update.value)
        )
          throw new Error("Invalid Pi stream update");
        sequence++;
        part = 0;
        parts = 0;
        length = 0;
        chunks = [];
        // Joined mid-stream: deltas are unusable until the next snapshot.
        if (!synced && update.type !== "snapshot") return undefined;
        synced = true;
        return update;
      } catch (error) {
        reset();
        throw error;
      }
    },
  };
}
