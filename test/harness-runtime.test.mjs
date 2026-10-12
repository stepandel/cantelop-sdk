import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSessionRuntimeHandler } from "../dist/runtime.js";
import { InMemoryActivity } from "../dist/activity.js";

const sandboxId = "sbx-" + "a".repeat(32);
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await tick();
  }
}
async function fixture(t, runtime) {
  const server = createServer(createSessionRuntimeHandler(runtime, { sandboxId }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetch = (path, init = {}) => globalThis.fetch(base + path, { ...init, headers: { "X-Cantelop-Sandbox-ID": sandboxId, ...init.headers } });
  const id = n => `msg_${n.toString(16).padStart(32, "0")}`;
  return {
    async send(n, command, reply = false) {
      const response = await fetch("/__cantelop/v2/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: { id: "chat", workspace_id: "wsp_" + "b".repeat(32), keep_alive_seconds: 300 }, message: { id: id(n), payload: { __cantelop_command: 2, ...command } }, ...(reply ? { reply: true } : {}) }),
      });
      assert.equal(response.status, 202, await response.text());
    },
    async output(after = 0) { return (await fetch(`/__cantelop/v2/runtime/events?after=${after}&wait=0`)).json(); },
    async ack(through) {
      const response = await fetch("/__cantelop/v2/runtime/events/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ through }) });
      assert.equal(response.status, 200);
    },
    async status(n) { return (await fetch(`/__cantelop/v2/messages/${id(n)}`)).json(); },
    async reply(n) { const response = await fetch(`/__cantelop/v2/messages/${id(n)}/reply`); return { status: response.status, ...await response.json() }; },
    async settled(n) { await until(async () => ["succeeded", "failed", "timed_out"].includes((await this.status(n)).state)); },
  };
}

test("one harness handles FIFO queue, live steering and run-wide cancellation with cleanup barriers", async t => {
  let creates = 0, cancels = 0, signal;
  const started = [], steering = [];
  const workExit = deferred(), cancelExit = deferred();
  const f = await fixture(t, {
    create(context) {
      creates++;
      assert.equal(context.session.id, "chat");
      return {
        async run(message, work) {
          started.push(message);
          if (message === "first") { signal = work.signal; await workExit.promise; }
        },
        steer: message => steering.push(message),
        async cancel() { cancels++; await cancelExit.promise; },
      };
    },
  });
  await f.send(1, { type: "cancel" }, true); await f.settled(1);
  assert.equal((await f.reply(1)).reply.state, "idle");
  assert.equal(creates, 0);
  await f.send(2, { type: "dispatch", message: "first" }); await f.settled(2);
  await until(() => signal);
  await f.send(3, { type: "dispatch", message: "next" }); await f.settled(3);
  await f.send(4, { type: "steer", message: "adjust" }); await f.settled(4);
  assert.deepEqual(steering, ["adjust"]);
  await f.send(5, { type: "cancel" }, true); await f.settled(5);
  assert.equal((await f.reply(5)).reply.state, "requested");
  assert.equal(signal.aborted, true);
  // Retry the same command even after another run starts: it never selects again.
  await f.send(5, { type: "cancel" }, true);
  assert.equal(cancels, 1);
  workExit.resolve(); await tick();
  assert.deepEqual(started, ["first"]);
  cancelExit.resolve(); await until(() => started.length === 2);
  assert.equal(creates, 1);
  assert.deepEqual(started, ["first", "next"]);
  await f.send(5, { type: "cancel" }, true);
  assert.equal(cancels, 1);
});

test("request waits for run return while steering and cancellation intake remain responsive", async t => {
  const exit = deferred();
  let active, steered = false;
  const f = await fixture(t, { create: () => ({
    async run(message, work) { active = work.signal; await exit.promise; return { answer: message }; },
    steer() { steered = true; },
  }) });
  await f.send(1, { type: "dispatch", message: "answer" }, true);
  await until(() => active);
  assert.equal((await f.reply(1)).status, 409);
  await f.send(2, { type: "steer", message: "adjust" }); await f.settled(2);
  assert.equal(steered, true);
  exit.resolve(); await f.settled(1);
  assert.deepEqual((await f.reply(1)).reply, { answer: "answer" });
});

test("cancelling an active request yields failure and preserves a queued request", async t => {
  let active;
  const f = await fixture(t, { create: () => ({
    async run(message, work) {
      if (message === "hold") {
        active = work.signal;
        await new Promise(resolve => active.addEventListener("abort", resolve, { once: true }));
      }
      return message;
    },
  }) });
  await f.send(1, { type: "dispatch", message: "hold" }, true); await until(() => active);
  await f.send(2, { type: "dispatch", message: "next" }, true);
  await f.send(3, { type: "cancel" }, true); await f.settled(3);
  await f.settled(1); await f.settled(2);
  assert.equal((await f.status(1)).state, "failed");
  assert.equal((await f.reply(1)).status, 409);
  assert.equal((await f.reply(2)).reply, "next");
});

test("unsupported steering rejects explicitly; configured fallback uses priority FIFO", async t => {
  const rejected = await fixture(t, { create: () => ({ run() {} }) });
  await rejected.send(1, { type: "steer", message: "unsupported" }); await rejected.settled(1);
  assert.equal((await rejected.status(1)).state, "failed");
  const exit = deferred();
  const started = [];
  const queued = await fixture(t, { steering: "queue", create: () => ({
    async run(message) { started.push(message); if (message === "hold") await exit.promise; },
  }) });
  for (const [n, type, message] of [[1, "dispatch", "hold"], [2, "dispatch", "normal"], [3, "steer", "priority-1"], [4, "steer", "priority-2"]]) {
    await queued.send(n, { type, message }); await queued.settled(n);
  }
  assert.deepEqual(started, ["hold"]);
  exit.resolve(); await until(() => started.length === 4);
  assert.deepEqual(started, ["hold", "priority-1", "priority-2", "normal"]);
});

test("provider cancellation errors still abort execution and release only after work exits", async () => {
  const activity = new InMemoryActivity(() => {}, async () => {});
  const exit = deferred();
  let signal, starts = 0;
  activity.start("one", context => { signal = context.signal; return exit.promise; }, { onCancel() { throw new Error("provider failure"); } });
  await tick();
  activity.queue("two", () => { starts++; });
  assert.equal(activity.cancel(), true);
  assert.equal(signal.aborted, true);
  await tick(); assert.equal(starts, 0);
  exit.resolve(); await until(() => starts === 1);
});


test("queued harness work keeps owner output and durable view capabilities after intake closes", async t => {
  let work, done = false;
  const f = await fixture(t, { create: () => ({
    async run(message, context) {
      work = context;
      await context.output.send({ text: message });
      await context.view.commit({ entries: [message] });
      done = true;
    },
  }) });
  await f.send(1, { type: "dispatch", message: "hello" }); await f.settled(1);
  assert.equal(work.signal.aborted, false);
  assert.equal(done, false);
  let event;
  await until(async () => { event = (await f.output()).events[0]; return event; });
  assert.equal(event.message_id, "msg_" + "1".padStart(32, "0"));
  assert.deepEqual(event.event, { text: "hello" });
  await f.ack(event.cursor);
  const after = event.cursor;
  await until(async () => { event = (await f.output(after)).events[0]; return event; });
  assert.deepEqual(event.view, { entries: ["hello"] });
  assert.equal(done, false);
  await f.ack(event.cursor);
  await until(() => done);
  await tick();
  await assert.rejects(work.output.send({ text: "late" }), /settled/);
  await assert.rejects(work.view.commit({ entries: [] }), /settled/);
});

test("failed harness initialization is fenced for subsequent input in the incarnation", async t => {
  let creates = 0;
  const f = await fixture(t, { async create() { creates++; throw new Error("provider initialization failed"); } });
  await f.send(1, { type: "dispatch", message: "one" }); await f.settled(1);
  await f.send(2, { type: "dispatch", message: "two" }); await f.settled(2);
  assert.equal((await f.status(1)).state, "failed");
  assert.equal((await f.status(2)).state, "failed");
  assert.equal(creates, 1);
});
