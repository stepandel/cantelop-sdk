import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryMailbox } from "../dist/mailbox.js";
import { SessionOutputBuffer } from "../dist/output.js";

test("priority intake overtakes queued normal messages without interrupting active work", async () => {
  const mailbox = new InMemoryMailbox();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const order = [];
  const first = mailbox.enqueue("active", async () => {
    order.push("active");
    await blocked;
  });
  await Promise.resolve();
  const normal = mailbox.enqueue("normal", async () => {
    order.push("normal");
  });
  const priority = mailbox.enqueue(
    "priority",
    async () => {
      order.push("priority");
    },
    "priority",
  );
  const nextPriority = mailbox.enqueue(
    "next-priority",
    async () => {
      order.push("next-priority");
    },
    "priority",
  );
  assert.equal(
    mailbox.enqueue("priority", async () => {
      throw Error("duplicate invoked");
    }),
    priority,
  );
  assert.deepEqual(order, ["active"]);
  release();
  await Promise.all([first, normal, priority, nextPriority]);
  assert.deepEqual(order, ["active", "priority", "next-priority", "normal"]);
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
