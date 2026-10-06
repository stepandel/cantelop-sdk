import assert from "node:assert/strict";
import test from "node:test";
import {
  encodePiDurableUpdate,
  createPiDurableEventDecoder,
} from "../dist/pi-durable/events.js";
const snapshot = {
  type: "snapshot",
  conversationId: 1,
  value: { conversation: { id: 1 }, entries: [], docs: {} },
};
test("large UTF-8 snapshots survive output-sized chunks and changes remain ordered", () => {
  const value = {
    ...snapshot,
    value: {
      ...snapshot.value,
      docs: { large: { text: "🍈中文".repeat(20000) } },
    },
  };
  const frames = encodePiDurableUpdate(value, "first", 0);
  assert(frames.length > 1);
  assert(frames.every((f) => Buffer.byteLength(JSON.stringify(f)) < 65536));
  const decoder = createPiDurableEventDecoder();
  let decoded;
  for (const frame of frames) decoded = decoder.push(frame);
  assert.deepEqual(decoded, value);
  const change = { type: "change", conversationId: 1, ops: [] };
  assert.deepEqual(
    decoder.push(encodePiDurableUpdate(change, "first", 1)[0]),
    change,
  );
  assert.deepEqual(
    decoder.push(encodePiDurableUpdate(snapshot, "replacement", 0)[0]),
    snapshot,
  );
});
test("gaps, missing snapshots, invalid chunks and oversized snapshots require reset", () => {
  const frames = encodePiDurableUpdate(
    {
      ...snapshot,
      value: {
        ...snapshot.value,
        docs: { large: { text: "x".repeat(90000) } },
      },
    },
    "stream",
    0,
  );
  const decoder = createPiDurableEventDecoder();
  decoder.push(frames[0]);
  assert.throws(() => decoder.push(frames[2]), /gap/);
  assert.throws(() => decoder.push({ ...frames[0], sequence: 1 }), /snapshot/);
  assert.throws(() => decoder.push({ ...frames[0], parts: 0 }), /Invalid/);
  assert.throws(
    () => createPiDurableEventDecoder({ maxBytes: 10 }).push(frames[0]),
    /size limit/,
  );
  assert.deepEqual(
    decoder.push(encodePiDurableUpdate(snapshot, "fresh", 0)[0]),
    snapshot,
  );
});

test("decoder bounds chunk metadata as well as decoded bytes", () => {
  const frame = encodePiDurableUpdate(snapshot, "bounded", 0)[0];
  const decoder = createPiDurableEventDecoder();
  assert.throws(() => decoder.push({ ...frame, data: "", parts: Number.MAX_SAFE_INTEGER }), /size limit/);
  assert.deepEqual(decoder.push(frame), snapshot);
});
