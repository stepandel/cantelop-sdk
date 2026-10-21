import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMailbox } from "../dist/mailbox.js";
import { SessionOutputBuffer } from "../dist/output.js";
import { nextTurn } from "./helpers.mjs";

test("dispatch intake stays FIFO and queued work can be removed inside the SDK", async () => {
  const mailbox = new InMemoryMailbox();
  let release;
  const blocked = new Promise((resolve) => (release = resolve));
  const order = [];
  const active = mailbox.enqueue("active", async () => {
    order.push("active");
    await blocked;
  });
  await Promise.resolve();
  const next = mailbox.enqueue("next", async () => {
    order.push("next");
  });
  const removed = mailbox.enqueue("removed", async () => {
    throw new Error("cancelled work ran");
  });
  const failed = assert.rejects(removed, /cancelled/);
  assert.equal(mailbox.cancel("removed", new Error("cancelled")), true);
  assert.equal(mailbox.cancel("active", new Error("cancelled")), false);
  assert.deepEqual(order, ["active"]);
  release();
  await Promise.all([active, next, failed]);
  assert.deepEqual(order, ["active", "next"]);
});

test("projection commits preserve source order and wait for platform acknowledgment", async () => {
  const buffer = new SessionOutputBuffer();
  let committed = false;
  const pending = buffer
    .publish("msg_" + "1".repeat(32), { text: "snapshot" }, undefined, true)
    .then(() => {
      committed = true;
    });
  const batch = await buffer.read(0, undefined, false, false);
  assert.deepEqual(batch, [
    {
      cursor: 1,
      messageId: "msg_" + "1".repeat(32),
      event: null,
      view: { text: "snapshot" },
    },
  ]);
  assert.equal(committed, false);
  buffer.acknowledge(1);
  await pending;
  assert.equal(committed, true);
});

for (const [limit, capacity, event] of [
  ["event count", 256, null],
  ["byte count", 16, "x".repeat(64 * 1024 - 2)],
]) {
  test(`concurrent output publishers respect the ${limit} limit after acknowledgments`, async t => {
    const buffer = new SessionOutputBuffer();
    const controller = new AbortController();
    const publications = Promise.allSettled(Array.from({ length: capacity + 100 }, (_, index) =>
      buffer.publish(`message-${index}`, event, controller.signal)));
    t.after(() => { controller.abort(); return publications; });
    assert.equal(buffer.metadata().latest, capacity);
    await buffer.read(0, undefined, false, false);

    for (const through of [1, 2]) {
      buffer.acknowledge(through);
      await nextTurn();
      assert.equal(buffer.metadata().latest, capacity + through);
      assert.equal(buffer.metadata().latest - buffer.metadata().acknowledged, capacity);
    }
  });
}

test("supervised activity owns a projection capability until its work settles", async () => {
  const { InMemoryActivity } = await import("../dist/activity.js");
  const projections = [];
  let context;
  let release;
  const committed = new Promise((resolve) => {
    release = resolve;
  });
  const activity = new InMemoryActivity(
    () => undefined,
    async () => undefined,
    () => undefined,
    async (id, state, signal) => {
      signal.throwIfAborted();
      projections.push({ id, state });
      release();
    },
  );
  activity.start("message", async (value) => {
    context = value;
    await value.view.commit({ text: "answer" });
  });
  await committed;
  while (!activity.isIdle)
    await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(projections, [{ id: "message", state: { text: "answer" } }]);
  await assert.rejects(context.view.commit({ text: "late" }), /settled/);
});
