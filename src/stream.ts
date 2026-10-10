import type { SessionEvent, SessionStreamOptions } from "./integration.js";
import { RemoteAppError } from "./remote-app.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** One subscription, with explicit cursor resumption and no automatic retries. */
export async function* streamSessionEvents<Event>(
  subscribe: (request: Request) => Promise<Response>,
  sessionId: string,
  options: SessionStreamOptions = {},
): AsyncGenerator<SessionEvent<Event>> {
  const cursor = options.after === undefined ? undefined : { ...options.after };
  const signal = options.signal;
  if (cursor !== undefined && (!/^[0-9a-f]{32}$/.test(cursor.streamId) || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0)) {
    throw new TypeError("An event cursor requires a stream ID and non-negative safe integer sequence");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    controller.signal.throwIfAborted();
    const url = new URL("https://runtime.cantelop.internal/events");
    if (cursor !== undefined) {
      url.searchParams.set("stream_id", cursor.streamId);
      url.searchParams.set("after", String(cursor.sequence));
    }
    const response = await subscribe(new Request(url, { signal: controller.signal }));
    body = response.body;
    controller.signal.throwIfAborted();
    if (!response.ok) {
      let code = "event_subscription_failed";
      // Read errors through the bounded line reader as well; do not buffer an unlimited body.
      let errorBody = "";
      if (body) for await (const line of readLines(body, controller.signal)) {
        errorBody += line;
        if (encoder.encode(errorBody).byteLength > MAX_FRAME_BYTES) throw invalidStream();
      }
      try {
        const error = JSON.parse(errorBody);
        if (typeof error?.error?.code === "string" && error.error.code) code = error.error.code;
      } catch { /* Invalid error documents retain the stable fallback. */ }
      throw new RemoteAppError(code, response.status);
    }
    if (!body || response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
      throw invalidStream();
    }
    let id = "";
    let eventType = "";
    let data: string[] = [];
    let frameBytes = 0;
    let previous = cursor;
    for await (const line of readLines(body, controller.signal)) {
      if (line === "") {
        if (data.length > 0) {
          let document: unknown;
          try { document = JSON.parse(data.join("\n")); } catch { throw invalidStream(); }
          if (eventType === "error") {
            const code = isRecord(document) && typeof document.code === "string" && document.code ? document.code : "event_stream_failed";
            throw new RemoteAppError(code, 200);
          }
          if (eventType !== "" && eventType !== "message") throw invalidStream();
          const event = readEvent<Event>(document, id, sessionId);
          if (previous !== undefined) {
            if (previous.streamId !== event.cursor.streamId) throw new RemoteAppError("event_stream_reset", 200);
            if (event.cursor.sequence <= previous.sequence) throw invalidStream();
          }
          previous = event.cursor;
          yield event;
        }
        id = ""; eventType = ""; data = []; frameBytes = 0;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field !== "id" && field !== "event" && field !== "data") continue;
      frameBytes += encoder.encode(line).byteLength;
      if (frameBytes > MAX_FRAME_BYTES) throw invalidStream();
      if (field === "data") data.push(value);
      if (field === "event") eventType = value;
      if (field === "id" && !value.includes("\0")) id = value;
    }
    // SSE does not dispatch a partial frame at EOF.
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", abort);
    // readLines releases its lock even when the consumer breaks after an event.
    if (body && !body.locked) await body.cancel().catch(() => {});
  }
}

async function* readLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let pending = "";
  let pendingBytes = 0;
  let skipLF = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      let chunk: string;
      try { chunk = decoder.decode(value, { stream: !done }); } catch { throw invalidStream(); }
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];
        if (skipLF) {
          skipLF = false;
          if (char === "\n") { start = i + 1; continue; }
        }
        if (char !== "\r" && char !== "\n") continue;
        const piece = chunk.slice(start, i);
        pendingBytes += encoder.encode(piece).byteLength;
        if (pendingBytes > MAX_FRAME_BYTES) throw invalidStream();
        yield pending + piece;
        pending = ""; pendingBytes = 0; start = i + 1;
        skipLF = char === "\r";
      }
      const piece = chunk.slice(start);
      pendingBytes += encoder.encode(piece).byteLength;
      if (pendingBytes > MAX_FRAME_BYTES) throw invalidStream();
      pending += piece;
      if (done) { if (pending) yield pending; return; }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function readEvent<Event>(value: unknown, id: string, sessionId: string): SessionEvent<Event> {
  if (!isRecord(value) || typeof value.stream_id !== "string" || !/^[0-9a-f]{32}$/.test(value.stream_id) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1 || value.session_id !== sessionId ||
      typeof value.message_id !== "string" || !/^msg_[0-9a-f]{32}$/.test(value.message_id) ||
      typeof value.created_at !== "string" || !("data" in value) || id !== `${value.stream_id}:${value.sequence}`) throw invalidStream();
  const createdAt = new Date(value.created_at);
  if (!Number.isFinite(createdAt.valueOf())) throw invalidStream();
  return Object.freeze({
    cursor: Object.freeze({ streamId: value.stream_id, sequence: value.sequence as number }),
    sessionId, messageId: value.message_id, createdAt, data: value.data as Event,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalidStream(): RemoteAppError { return new RemoteAppError("invalid_event_stream", 0); }
