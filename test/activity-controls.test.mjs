import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryActivity } from "../dist/activity.js";
import { deferred, nextTurn as tick } from "./helpers.mjs";

function scheduler() {
  const outputs = [];
  const activity = new InMemoryActivity(() => undefined, async (id, event) => outputs.push({ id, event }));
  return { activity, outputs };
}

test("activity queues preserve owner output, priority FIFO, and one work slot", async () => {
  const { activity, outputs } = scheduler();
  const running = deferred();
  activity.start("hold", () => running.promise);
  assert.throws(() => activity.start("other", () => undefined), /already active/);
  for (const [id, priority] of [["normal-1", false], ["priority-1", true], ["normal-2", false], ["priority-2", true]]) {
    activity.queue(id, ({ output }) => output.send(id), { priority });
  }
  assert.equal(activity.isIdle, false);
  assert.deepEqual(outputs, []);
  running.resolve();
  await tick();
  assert.deepEqual(outputs.map(item => item.id), ["priority-1", "priority-2", "normal-1", "normal-2"]);
  assert.equal(activity.isIdle, true);
});

test("intake expiry removes only its owner's queued work", async () => {
  const { activity, outputs } = scheduler();
  const running = deferred();
  let signal;
  activity.start("hold", context => { signal = context.signal; return running.promise; });
  await tick();
  activity.queue("cancelled", ({ output }) => output.send("never"));
  activity.queue("kept", ({ output }) => output.send("kept"));
  activity.cancelMessage("cancelled");
  activity.cancelMessage("cancelled");
  activity.cancelMessage("unknown");
  assert.equal(signal.aborted, false);
  running.resolve();
  await tick();
  assert.deepEqual(outputs, [{ id: "kept", event: "kept" }]);
});

test("steering stays bound to the current harness until its adapter settles", async () => {
  const { activity, outputs } = scheduler();
  const running = deferred(), adapter = deferred();
  const steers = [];
  activity.start("first", () => running.promise, {
    async onSteer(message) { steers.push(message); await adapter.promise; },
  });
  const steering = activity.steer("adjust");
  await tick();
  activity.queue("second", ({ output }) => output.send("next"));
  running.resolve();
  await tick();
  assert.deepEqual(steers, ["adjust"]);
  assert.deepEqual(outputs, []);
  await assert.rejects(activity.steer("too late"), /No steerable/);
  adapter.resolve();
  await steering;
  await tick();
  assert.deepEqual(outputs, [{ id: "second", event: "next" }]);
});

test("steering rejects missing adapters and isolates adapter failures", async () => {
  const { activity } = scheduler();
  const running = deferred();
  await assert.rejects(activity.steer("idle"), /No steerable/);
  activity.start("no-adapter", () => running.promise);
  await assert.rejects(activity.steer("unsupported"), /no steering adapter/);
  running.resolve();
  await tick();
  const next = deferred();
  const accepted = [];
  activity.start("adapter", () => next.promise, {
    onSteer(message) { if (message === "bad") throw new Error("adapter failed"); accepted.push(message); },
  });
  await assert.rejects(activity.steer("bad"), /adapter failed/);
  await activity.steer("good");
  assert.deepEqual(accepted, ["good"]);
  next.resolve();
  await tick();
});

test("cancelling the active activity waits for cooperative exit before queued work starts", async () => {
  const { activity, outputs } = scheduler();
  const exit = deferred();
  let signal;
  activity.start("first", context => { signal = context.signal; return exit.promise; });
  await tick();
  activity.queue("next", ({ output }) => output.send("next"));
  assert.equal(activity.cancel(), true);
  assert.equal(signal.aborted, true);
  await tick();
  assert.deepEqual(outputs, []);
  assert.equal(activity.active, true);
  exit.resolve();
  await tick();
  assert.deepEqual(outputs, [{ id: "next", event: "next" }]);
});

test("queue capacity and options are checked before accepting work", () => {
  const { activity } = scheduler();
  const running = deferred();
  activity.start("hold", () => running.promise);
  assert.throws(() => activity.queue("bad", () => undefined, { timeoutMs: 0 }), /timeout/);
  assert.throws(() => activity.start("bad", () => undefined), /already active/);
  for (let n = 0; n < 256; n++) activity.queue(`queued-${n}`, () => undefined);
  assert.throws(() => activity.queue("overflow", () => undefined), /capacity/);
  for (let n = 0; n < 256; n++) activity.cancelMessage(`queued-${n}`);
  running.resolve();
});


test("cancelling a flushing activity never interrupts the next provider operation", async () => {
  const flush = deferred(), next = deferred();
  let nextSignal, hooks = 0;
  const activity = new InMemoryActivity(() => flush.promise, async () => undefined);
  activity.start("first", context => context.send("completion"), { timeoutMs: 10_000, onCancel() { hooks++; } });
  const firstId = activity.snapshot().id;
  activity.queue("second", context => { nextSignal = context.signal; return next.promise; }, { timeoutMs: 20_000, onCancel() { hooks++; } });
  await tick();
  assert.equal(activity.snapshot().id, firstId, "the oldest deadline belongs to flushing work");
  assert.equal(activity.cancel(undefined, firstId), true);
  assert.equal(nextSignal.aborted, false);
  assert.equal(hooks, 0);
  assert.equal(activity.cancel(undefined, "unknown"), false);
  next.resolve(); flush.resolve();
  await tick();
  assert.equal(activity.isIdle, true);
});
