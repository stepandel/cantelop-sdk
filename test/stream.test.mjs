import assert from "node:assert/strict";
import test from "node:test";
import { CantelopClient, RemoteAppError } from "../dist/index.js";

const streamId = "0123456789abcdef0123456789abcdef";
const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const messageId = "msg_0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();
function document(sequence = 1, data = { text: "café 🍈" }) {
  return { stream_id: streamId, sequence, session_id: "primary", message_id: messageId, created_at: "2026-10-09T00:00:00Z", data };
}
function frame(value = document(), newline = "\n") {
  return `id: ${value.stream_id}:${value.sequence}${newline}data: ${JSON.stringify(value)}${newline}${newline}`;
}
function makeSession(fetch) {
  return new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { fetch } }).workspace({ id: workspaceId }).session({ id: "primary", keepAliveSeconds: 0 });
}
function response(chunks, onCancel = () => {}) {
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk); controller.close(); },
    cancel: onCancel,
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
async function collect(iterable) { const result = []; for await (const event of iterable) result.push(event); return result; }

test("SSE parses byte-split UTF-8 and CRLF with typed payload and metadata", async () => {
  const bytes = encoder.encode(": connected\r\n\r\n" + frame(document(), "\r\n"));
  let request;
  const session = makeSession(input => { request = input; return response([...bytes].map(byte => Uint8Array.of(byte))); });
  const [event] = await collect(session.stream());
  assert.deepEqual(event, {
    cursor: { streamId, sequence: 1 }, sessionId: "primary", messageId,
    createdAt: new Date("2026-10-09T00:00:00Z"), data: { text: "café 🍈" },
  });
  assert.equal(request.headers.get("Accept"), "text/event-stream");
  assert.deepEqual((await request.clone().json()).workspace, { id: workspaceId });
  assert.equal(Object.isFrozen(event), true);
});

test("multiline data, CR-only separators and heartbeat comments are supported", async () => {
  const value = JSON.stringify(document(), null, 2).split("\n").map(line => `data: ${line}\r`).join("");
  const session = makeSession(() => response([`: heartbeat\rid: ${streamId}:1\r${value}\r`]));
  assert.equal((await collect(session.stream())).length, 1);
});

test("explicit cursor resume forwards stream identity and sequence without reconnecting", async () => {
  let count = 0;
  const session = makeSession(async request => {
    count++;
    assert.deepEqual((await request.json()).command, { type: "stream", after: { streamId, sequence: 1 } });
    return response([frame(document(2))]);
  });
  assert.equal((await collect(session.stream({ after: { streamId, sequence: 1 } })))[0].cursor.sequence, 2);
  assert.equal(count, 1);
  for (const after of [{ streamId: "bad", sequence: 1 }, { streamId, sequence: -1 }, { streamId, sequence: Number.MAX_SAFE_INTEGER + 1 }]) {
    await assert.rejects(collect(session.stream({ after })), TypeError);
  }
});

test("HTTP and in-band reset/expiration errors retain their stable remote codes", async () => {
  for (const code of ["event_cursor_expired", "event_stream_reset"]) {
    const http = makeSession(() => Response.json({ error: { code } }, { status: 409 }));
    await assert.rejects(collect(http.stream()), error => error instanceof RemoteAppError && error.code === code && error.status === 409);
    const inBand = makeSession(() => response([`event: error\ndata: ${JSON.stringify({ code })}\n\n`]));
    await assert.rejects(collect(inBand.stream()), error => error.code === code);
  }
});

test("malformed, mismatched, duplicate and replaced event envelopes reject", async () => {
  const cases = [
    "data: not-json\n\n",
    frame({ ...document(), session_id: "other" }),
    frame({ ...document(), created_at: "not-a-date" }),
    frame({ ...document(), sequence: Number.MAX_SAFE_INTEGER + 1 }),
    frame(document()) + frame(document()),
    frame({ ...document(), stream_id: "f".repeat(32) }),
  ];
  for (const data of cases) {
    const session = makeSession(() => response([data]));
    await assert.rejects(collect(session.stream({ after: { streamId, sequence: 0 } })), RemoteAppError);
  }
});

test("partial frames at EOF are discarded; oversized frames and wrong content types reject", async () => {
  const session = makeSession(() => response([frame().trimEnd()]));
  assert.deepEqual(await collect(session.stream()), []);
  const oversized = makeSession(() => response(["data: " + "x".repeat(1024 * 1024 + 1)]));
  await assert.rejects(collect(oversized.stream()), error => error.code === "invalid_event_stream");
  const cumulative = makeSession(() => response(Array(6).fill("data: " + "x".repeat(200000) + "\n")));
  await assert.rejects(collect(cumulative.stream()), error => error.code === "invalid_event_stream");
  const wrongType = makeSession(() => Response.json(document()));
  await assert.rejects(collect(wrongType.stream()), error => error.code === "invalid_event_stream");
  const invalidUtf8 = makeSession(() => response([Uint8Array.of(0xff)]));
  await assert.rejects(collect(invalidUtf8.stream()), error => error.code === "invalid_event_stream");
});

test("breaking iteration cancels only the subscription and releases the body lock", async () => {
  let cancelled = false;
  let body;
  let signal;
  let calls = 0;
  const session = makeSession(request => {
    signal = request.signal;
    calls++;
    body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(frame())); }, cancel() { cancelled = true; } });
    return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
  });
  for await (const event of session.stream()) { assert.equal(event.sessionId, "primary"); break; }
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1); // No stop, cancel or second subscription request.
});

test("abort interrupts a blocked read, releases the reader and preserves the caller reason", async () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled subscription");
  let cancelled = false;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const session = makeSession(() => {
    started();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  const waiting = collect(session.stream({ signal: controller.signal }));
  await ready;
  controller.abort(reason);
  await assert.rejects(waiting, error => error === reason);
  assert.equal(cancelled, true);
});

test("already aborted subscriptions never call the connection", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collect(makeSession(() => { throw new Error("unexpected fetch"); }).stream({ signal: controller.signal })), { name: "AbortError" });
});
