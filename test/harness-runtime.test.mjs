import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createSessionRuntimeHandler } from "../dist/runtime.js";

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
async function fixture(t, runtime, sessionId = "chat", options = {}) {
  const server = createServer(createSessionRuntimeHandler(runtime, { sandboxId, ...options }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetch = (path, init = {}) => globalThis.fetch(base + path, { ...init, headers: { "X-Cantelop-Sandbox-ID": sandboxId, ...init.headers } });
  const id = n => `msg_${n.toString(16).padStart(32, "0")}`;
  return {
    async send(n, command, reply = false) {
      const response = await fetch("/__cantelop/v2/messages", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: { id: sessionId, workspace_id: "wsp_" + "b".repeat(32), keep_alive_seconds: 300 }, message: { id: id(n), payload: { __cantelop_command: 2, ...command } }, ...(reply ? { reply: true } : {}) }),
      });
      assert.equal(response.status, 202, await response.text());
    },
    async output(after = 0) { return (await fetch(`/__cantelop/v2/runtime/events?after=${after}&wait=0`)).json(); },
    async runtime() { return (await fetch('/__cantelop/v2/runtime')).json(); },
    async ack(through) {
      const response = await fetch("/__cantelop/v2/runtime/events/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ through }) });
      assert.equal(response.status, 200);
    },
    async status(n) { return (await fetch(`/__cantelop/v2/messages/${id(n)}`)).json(); },
    async reply(n) { const response = await fetch(`/__cantelop/v2/messages/${id(n)}/reply`); return { status: response.status, ...await response.json() }; },
    async settled(n) { await until(async () => ["succeeded", "failed", "timed_out"].includes((await this.status(n)).state)); },
  };
}

test("App auth serves the reserved Session without creating a harness or entering the agent queue", async t => {
  let creates = 0, statuses = 0, logouts = 0;
  const runtime = { create: () => { creates++; return { queue() {}, steer() {}, cancel() { return false; } }; } };
  const auth = {
    status(context) { statuses++; assert.equal(context.session.id, "cantelop-native-auth"); return logouts === 0; },
    logout() { logouts++; },
    terminal() { throw new Error("not started in this test"); },
  };
  const ordinary = await fixture(t, runtime, "chat", { auth });
  await ordinary.send(801, { type: "auth", auth: { type: "status" } }, true);
  await ordinary.settled(801);
  assert.equal((await ordinary.status(801)).state, "failed");
  const undeclared = await fixture(t, runtime, "cantelop-native-auth");
  await undeclared.send(802, { type: "auth", auth: { type: "status" } }, true);
  await undeclared.settled(802);
  assert.equal((await undeclared.status(802)).state, "failed");
  const allowed = await fixture(t, runtime, "cantelop-native-auth", { auth });
  await allowed.send(803, { type: "auth", auth: { type: "status" } }, true);
  await allowed.settled(803);
  assert.deepEqual((await allowed.reply(803)).reply, { type: "status", authenticated: true });
  await allowed.send(804, { type: "dispatch", message: "not auth" });
  await allowed.settled(804);
  assert.equal((await allowed.status(804)).state, "failed");
  await allowed.send(805, { type: "auth", auth: { type: "logout" } }, true);
  await allowed.settled(805);
  assert.deepEqual((await allowed.reply(805)).reply, { type: "status", authenticated: false });
  await allowed.send(806, { type: "auth", auth: { type: "terminal" } }, true);
  await allowed.settled(806);
  assert.equal((await allowed.status(806)).state, "failed");
  assert.equal((await allowed.runtime()).quiescent, true);
  assert.deepEqual({ creates, statuses, logouts }, { creates: 0, statuses: 2, logouts: 1 });
  assert.throws(() => createSessionRuntimeHandler(runtime, { sandboxId, auth: { status() {} } }), /Invalid App auth/);
});

test("queue, steer and cancel delegate directly to one session harness", async t => {
  const first = deferred(), next = deferred();
  const accepted = [], redirected = [];
  let creates = 0, cancels = 0, active = false;
  const f = await fixture(t, { create(context) {
    creates++;
    assert.equal(context.session.id, "chat");
    return {
      marker: "native",
      queue(message, work) {
        active = true; accepted.push({ message, work });
        return message === "first" ? first.promise : next.promise;
      },
      steer(message, work) { redirected.push([this.marker, message, work.message.payload]); },
      cancel() { cancels++; return active; },
    };
  } });
  await f.send(1, { type: "cancel" }, true); await f.settled(1);
  assert.equal((await f.reply(1)).reply.state, "idle");
  assert.equal(creates, 1, "even an initial cancellation delegates to the harness");
  await f.send(2, { type: "dispatch", message: "first" }); await f.settled(2);
  await f.send(3, { type: "dispatch", message: "next" }); await f.settled(3);
  assert.deepEqual(accepted.map(value => value.message), ["first", "next"], "the SDK does not serialize provider operations");
  await f.send(4, { type: "steer", message: "adjust" }); await f.settled(4);
  await until(() => redirected.length === 1);
  assert.deepEqual(redirected, [["native", "adjust", "adjust"]]);
  await f.send(5, { type: "cancel" }, true); await f.settled(5);
  assert.equal((await f.reply(5)).reply.state, "requested");
  assert.equal(accepted[0].work.signal.aborted, false, "the implementation owns cancellation");
  first.resolve(); next.resolve(); active = false;
  await f.send(5, { type: "cancel" }, true); await f.settled(5);
  assert.equal(cancels, 2, "command retries never select a later operation");
  assert.equal(creates, 1);
});

test("pending queue and steer completion never block subsequent intake", async t => {
  const answer = deferred(), direction = deferred();
  const calls = [];
  const f = await fixture(t, { create: () => ({
    queue(message) { calls.push(message); return message === "answer" ? answer.promise : { answer: message }; },
    steer() { calls.push("steer"); return direction.promise; },
    cancel() { calls.push("cancel"); return false; },
  }) });
  await f.send(1, { type: "dispatch", message: "answer" }, true);
  await until(() => calls.length === 1);
  assert.equal((await f.reply(1)).status, 409);
  await f.send(2, { type: "steer", message: "direction" }); await f.settled(2);
  await f.send(3, { type: "dispatch", message: "next" }, true); await f.settled(3);
  await f.send(4, { type: "cancel" }, true); await f.settled(4);
  assert.deepEqual(calls, ["answer", "steer", "next", "cancel"]);
  assert.equal((await f.reply(4)).reply.state, "idle", "the SDK uses the implementation's active-operation result");
  assert.deepEqual((await f.reply(3)).reply, { answer: "next" });
  answer.resolve({ answer: "answer" }); direction.resolve();
  await f.settled(1);
  assert.deepEqual((await f.reply(1)).reply, { answer: "answer" });
});

test("steer is called while idle and the implementation reports unsupported input", async t => {
  let calls = 0;
  const f = await fixture(t, { create: () => ({
    queue() { throw new Error("SDK must not substitute queue for steer"); },
    steer() { calls++; throw new Error("unsupported steering"); },
    cancel() { return false; },
  }) });
  await f.send(1, { type: "steer", message: "direction" }); await f.settled(1);
  assert.equal(calls, 1);
  assert.equal((await f.status(1)).state, "failed");
});

test("harness operation output and typed views stay owned until completion", async t => {
  let work, done = false;
  const f = await fixture(t, { create: () => ({
    async queue(message, context) {
      work = context;
      await context.output.send({ text: message });
      await context.view.commit({ entries: [message] });
      done = true;
    },
    steer() {}, cancel() { return false; },
  }) });
  await f.send(1, { type: "dispatch", message: "hello" }); await f.settled(1);
  assert.equal(done, false);
  let event;
  await until(async () => { event = (await f.output()).events[0]; return event; });
  assert.equal(event.message_id, "msg_" + "1".padStart(32, "0"));
  await f.ack(event.cursor);
  const after = event.cursor;
  await until(async () => { event = (await f.output(after)).events[0]; return event; });
  assert.deepEqual(event.view, { entries: ["hello"] });
  await f.ack(event.cursor);
  await until(() => done); await tick();
  assert.throws(() => work.output.send({ text: "late" }), /settled/);
  assert.throws(() => work.view.commit({ entries: [] }), /settled/);
});

test("failed harness initialization is fenced for subsequent input", async t => {
  let creates = 0;
  const f = await fixture(t, { create() { creates++; throw new Error("initialization failed"); } });
  for (const n of [1, 2]) {
    await f.send(n, { type: "dispatch", message: "input" }); await f.settled(n);
    assert.equal((await f.status(n)).state, "failed");
  }
  assert.equal(creates, 1);
});

test("all three harness methods are required and cancellation returns a boolean", async t => {
  for (const missing of ["queue", "steer", "cancel"]) {
    const f = await fixture(t, { create: () => ({ queue() {}, steer() {}, cancel() { return false; }, [missing]: undefined }) });
    await f.send(1, { type: "dispatch", message: "input" }); await f.settled(1);
    assert.equal((await f.status(1)).state, "failed");
  }
  const f = await fixture(t, { create: () => ({ queue() {}, steer() {}, cancel() {} }) });
  await f.send(1, { type: "dispatch", message: "input" }); await f.settled(1);
  await f.send(2, { type: "cancel" }, true); await f.settled(2);
  assert.equal((await f.status(2)).state, "failed");
});

test("operation admission limits never invoke rejected harness input or cancel other work", async t => {
  const exit = deferred();
  let queues = 0, steers = 0, cancels = 0;
  const f = await fixture(t, { create: () => ({
    queue() { queues++; return exit.promise; },
    steer() { steers++; },
    cancel() { cancels++; return true; },
  }) });
  for (let n = 1; n <= 256; n++) { await f.send(n, { type: "dispatch", message: "input" }); await f.settled(n); }
  await f.send(257, { type: "steer", message: "overflow" }); await f.settled(257);
  assert.equal((await f.status(257)).state, "failed");
  assert.equal(queues, 256); assert.equal(steers, 0); assert.equal(cancels, 0);
  exit.resolve();
});


test("scoped auth actors must belong to their Workspace and cannot dispatch agent tasks", async t => {
  let statuses = 0, creates = 0;
  const runtime = { create() { creates++; throw new Error("auth must not create a harness"); } };
  const auth = { status() { statuses++; return true; }, logout() {}, terminal() { throw new Error("unused"); } };
  const scoped = await fixture(t, runtime, "cantelop-native-auth-wsp_" + "b".repeat(32), { auth });
  await scoped.send(901, { type: "auth", auth: { type: "status" } }, true);
  await scoped.settled(901);
  assert.deepEqual((await scoped.reply(901)).reply, { type: "status", authenticated: true });
  await scoped.send(902, { type: "dispatch", message: "not auth" });
  await scoped.settled(902);
  assert.equal((await scoped.status(902)).state, "failed");
  const foreign = await fixture(t, runtime, "cantelop-native-auth-wsp_" + "c".repeat(32), { auth });
  await foreign.send(903, { type: "auth", auth: { type: "status" } }, true);
  await foreign.settled(903);
  assert.equal((await foreign.status(903)).state, "failed");
  assert.deepEqual({ statuses, creates }, { statuses: 1, creates: 0 });
});
