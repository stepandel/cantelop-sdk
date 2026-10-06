import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  defineExtension,
  defineTask,
  defineDoc,
} from "@earendil-works/pi-durable";
import {
  definePiDurableSession,
  openPiDurableHarness,
  createPiDurableEventDecoder,
} from "../dist/pi-durable.js";
import { InMemoryActivity } from "../dist/activity.js";
const tick = () => new Promise((r) => setTimeout(r, 5));
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await tick();
  }
  assert.fail("condition not reached");
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "cantelop-pi-runtime-"));
  const database = createClient({ url: `file:${join(dir, "workspace.db")}` });
  t.after(async () => {
    database.close();
    await rm(dir, { recursive: true, force: true });
  });
  return database;
}
function host(behaviour, database) {
  const events = [],
    errors = [],
    pending = [];
  let calls = 0;
  const output = {
    async send(event) {
      events.push(event);
    },
  };
  const activity = new InMemoryActivity(
    async (payload) => {
      const promise = receive(payload);
      pending.push(promise);
      await promise;
    },
    async (_id, event) => output.send(event),
  );
  const lifetime = new AbortController();
  const activation = {
    signal: lifetime.signal,
    session: { id: "agent", keepAliveSeconds: 600 },
    env: {},
    database: async () => database,
    activity: {
      get active() {
        return activity.active;
      },
      start(fn, policy) {
        activity.start("intake", fn, policy);
      },
      extend(ms) {
        activity.extend(ms);
      },
      cancel(reason) {
        return activity.cancel(reason);
      },
    },
    output,
    send: async (payload) => receive(payload),
  };
  async function receive(payload, id = `msg-${++calls}`) {
    let reply;
    await behaviour.receive({
      ...activation,
      message: { id, sequence: calls, payload },
      reply: (value) => {
        reply = value;
      },
    });
    return reply;
  }
  return {
    activation,
    activity,
    events,
    errors,
    receive,
    async close() {
      activity.cancel();
      await until(() => activity.isIdle);
      await Promise.all(pending);
    },
  };
}
const JobState = defineDoc({
  kind: "test.job",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ complete: false }),
});
function jobRegistry(onRun) {
  const Job = defineTask({
    name: "test.job",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (task, runtime, context) => {
        await onRun(task, runtime, context);
        await runtime.commit(async (tx) => {
          (await tx.doc(JobState, runtime.conversationId)).complete = true;
          return {
            status: "terminal",
            outcome: { status: "completed", result: "done" },
          };
        }, context);
      },
    },
    abort: async (task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "cancelled" },
        }),
        context,
      ),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test.jobs", tasks: [Job] }));
  return { registry, Job };
}

test("background-only work resumes on activation, holds activity, admits new messages and renews its deadline", async (t) => {
  const database = await fixture(t);
  let runs = 0;
  const { registry, Job } = jobRegistry(async (task, runtime, context) => {
    runs++;
    await runtime.sleep(Date.now() + 60000, context);
  });
  const options = { models: createModels(), registry };
  const original = await openPiDurableHarness(
    { database, sessionId: "agent", harness: options },
    ctx,
  );
  const root = await original.root(ctx);
  const id = await root.commit(
    (tx) =>
      tx.createTask(
        Job,
        {},
        { ownership: { kind: "conversation" }, background: true },
      ),
    ctx,
  );
  await original.close(ctx);
  const errors = [];
  let harness;
  const behaviour = definePiDurableSession({
    harness: options,
    activityTimeoutMs: 90,
    onError: (e) => errors.push(e),
    onOpen: (h) => {
      harness = h;
    },
  });
  const runtime = host(behaviour, database);
  t.after(() => runtime.close());
  await behaviour.onActivate(runtime.activation);
  await until(() => runs === 1 && runtime.activity.active);
  const deadline = runtime.activity.snapshot().deadline;
  const draft = {
    type: "write",
    entry: { kind: "test.note", data: { text: "still receiving" } },
  };
  const first = await runtime.receive(draft, "stable");
  const duplicate = await runtime.receive(draft, "stable");
  assert.deepEqual(first, duplicate);
  await new Promise((r) => setTimeout(r, 120));
  assert(runtime.activity.active);
  assert(runtime.activity.snapshot().deadline > deadline);
  assert.equal((await harness.getTask(id, ctx)).state.status, "running");
  await runtime.receive({ type: "abortTask", taskId: id });
  await until(() => runtime.activity.isIdle);
  assert.equal(
    (await harness.getTask(id, ctx)).state.outcome.status,
    "aborted",
  );
  assert.deepEqual(errors, []);
  assert(runtime.events.length > 0);
  const decoder = createPiDurableEventDecoder();
  let snapshot = false;
  for (const frame of runtime.events) {
    const update = decoder.push(frame);
    if (update?.type === "snapshot") snapshot = true;
  }
  assert(snapshot);
  await harness.close(ctx);
});

test("activity cancellation preserves unfinished work; recovery opens the same store without replaying intake", async (t) => {
  const database = await fixture(t);
  let runs = 0;
  const { registry, Job } = jobRegistry(async (task, runtime, context) => {
    runs++;
    await runtime.sleep(Date.now() + (runs === 1 ? 60000 : 20), context);
  });
  const options = { models: createModels(), registry };
  let firstHarness, id;
  const first = definePiDurableSession({
    harness: options,
    onOpen: async (h) => {
      firstHarness = h;
      const root = await h.root(ctx);
      id = await root.commit(
        (tx) => tx.createTask(Job, {}, { ownership: { kind: "conversation" } }),
        ctx,
      );
    },
  });
  const one = host(first, database);
  await first.onActivate(one.activation);
  await until(() => runs === 1);
  const reply = await one.receive(
    { type: "write", entry: { kind: "test.receipt", data: {} } },
    "receipt",
  );
  await one.close();
  let nextHarness;
  const second = definePiDurableSession({
    harness: options,
    onOpen: (h) => {
      nextHarness = h;
    },
  });
  const two = host(second, database);
  t.after(() => two.close());
  await second.onActivate(two.activation);
  await second.onRecover({
    ...two.activation,
    recovery: { id: "recover", interruptedMessageId: "receipt" },
  });
  await until(() => two.activity.isIdle);
  assert.equal(runs, 2);
  assert.equal(
    (await nextHarness.getTask(id, ctx)).state.outcome.status,
    "completed",
  );
  const again = await two.receive(
    { type: "write", entry: { kind: "test.receipt", data: {} } },
    "receipt",
  );
  assert.deepEqual(again, reply);
  assert.equal(
    (
      await (await nextHarness.root(ctx)).entries({}, 100, undefined, ctx)
    ).items.filter((e) => e.kind === "test.receipt").length,
    1,
  );
  await until(() => two.activity.isIdle);
  await nextHarness.close(ctx);
});

test("snapshot commands stream large committed state and supply a small requested reply", async (t) => {
  const database = await fixture(t);
  let harness;
  const behaviour = definePiDurableSession({
    harness: { models: createModels(), registry: createRegistry() },
    onOpen: (h) => {
      harness = h;
    },
  });
  const runtime = host(behaviour, database);
  t.after(() => runtime.close());
  await behaviour.onActivate(runtime.activation);
  const root = await harness.root(ctx);
  await root.submit(
    {
      type: "write",
      entry: { kind: "test.large", data: { text: "中".repeat(50000) } },
    },
    ctx,
  );
  await until(() => runtime.activity.isIdle);
  runtime.events.length = 0;
  const reply = await runtime.receive({ type: "snapshot" });
  assert.equal(reply.type, "snapshot");
  assert(runtime.events.length > 1);
  const decoder = createPiDurableEventDecoder();
  let update;
  for (const event of runtime.events) update = decoder.push(event);
  assert.equal(
    update.value.entries.find((e) => e.kind === "test.large").data.text.length,
    50000,
  );
  await until(() => runtime.activity.isIdle);
  await harness.close(ctx);
});

test("committed inputs support steering and follow-ups through the real Pi generation scheduler", async (t) => {
  const { fauxProvider, fauxAssistantMessage } = await import(
    "@earendil-works/pi-ai"
  );
  const database = await fixture(t);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  t.after(() => release());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    async () => {
      await gate;
      return fauxAssistantMessage("first");
    },
    fauxAssistantMessage("follow-up"),
  ]);
  let harness;
  const model = faux.getModel();
  const behaviour = definePiDurableSession({
    harness: { models, registry: createRegistry() },
    agent: { model: { provider: model.provider, modelId: model.id } },
    onOpen: (h) => {
      harness = h;
    },
  });
  const runtime = host(behaviour, database);
  t.after(() => runtime.close());
  await behaviour.onActivate(runtime.activation);
  const first = await runtime.receive(
    { type: "input", content: "hello" },
    "first",
  );
  await until(() => faux.state.callCount === 1);
  const steer = await runtime.receive(
    { type: "input", content: "use pnpm", whenBusy: "steer" },
    "steer",
  );
  const follow = await runtime.receive(
    { type: "input", content: "then test", whenBusy: "followUp" },
    "follow",
  );
  assert(runtime.activity.active);
  assert.notEqual(steer.submissionId, first.submissionId);
  await runtime.receive({ type: "snapshot" }); // Resync shares the live stream; no interleaved chunks.
  release();
  await until(() => runtime.activity.isIdle);
  assert.equal(
    (await (await harness.submission(first.submissionId, ctx)).status(ctx))
      .status,
    "done",
  );
  assert.equal(
    (await (await harness.submission(follow.submissionId, ctx)).status(ctx))
      .status,
    "done",
  );
  const decoder = createPiDurableEventDecoder();
  for (const frame of runtime.events) decoder.push(frame);
  const entries = await (
    await harness.root(ctx)
  ).entries({}, 100, undefined, ctx);
  assert(entries.items.some((e) => JSON.stringify(e).includes("use pnpm")));
  assert(entries.items.some((e) => JSON.stringify(e).includes("follow-up")));
  await harness.close(ctx);
});

for (const replay of ["safe", "unsafe"])
  test(`Pi preserves ${replay} tool replay policy across runtime replacement`, async (t) => {
    const { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } =
      await import("@earendil-works/pi-ai");
    const { defineTool } = await import("@earendil-works/pi-durable");
    const database = await fixture(t);
    let executions = 0;
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("effect", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("finished"),
    ]);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "effects",
        tools: [
          defineTool({
            name: "effect",
            description: "Test replay",
            parameters: Type.Object({}),
            replay,
            execute: async (args, api, context) => {
              executions++;
              if (executions === 1)
                await new Promise((resolve, reject) => {
                  context.abortSignal.addEventListener(
                    "abort",
                    () => reject(context.abortSignal.reason),
                    { once: true },
                  );
                });
              return { content: [{ type: "text", text: "effect complete" }] };
            },
          }),
        ],
      }),
    );
    const model = faux.getModel();
    const options = {
      harness: { models, registry },
      agent: { model: { provider: model.provider, modelId: model.id } },
    };
    const first = definePiDurableSession(options);
    const one = host(first, database);
    await first.onActivate(one.activation);
    await one.receive({ type: "input", content: "run effect" }, "effect");
    await until(() => executions === 1);
    await one.close();
    let harness;
    const second = definePiDurableSession({
      ...options,
      onOpen: (h) => {
        harness = h;
      },
    });
    const two = host(second, database);
    t.after(() => two.close());
    await second.onActivate(two.activation);
    await until(() => two.activity.isIdle);
    assert.equal(executions, replay === "safe" ? 2 : 1);
    const entries = await (
      await harness.root(ctx)
    ).entries({}, 100, undefined, ctx);
    assert(
      entries.items.some((e) =>
        JSON.stringify(e).includes(
          replay === "safe" ? "effect complete" : "interrupted",
        ),
      ),
    );
    await harness.close(ctx);
  });

test("slow output finishes with the complete committed snapshot after watch buffers drain", async (t) => {
  const { fauxProvider, fauxAssistantMessage } = await import(
    "@earendil-works/pi-ai"
  );
  const database = await fixture(t);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  t.after(() => release());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("final durable answer")]);
  let harness;
  const model = faux.getModel();
  const behaviour = definePiDurableSession({
    harness: { models, registry: createRegistry() },
    agent: { model: { provider: model.provider, modelId: model.id } },
    onOpen: (h) => {
      harness = h;
    },
  });
  const events = [],
    pending = [];
  let calls = 0;
  const activity = new InMemoryActivity(
    async (payload) => {
      const next = behaviour.receive({
        ...activation,
        message: { id: `local-${++calls}`, sequence: calls, payload },
        reply() {},
      });
      pending.push(next);
      await next;
    },
    async (_id, event) => {
      await gate;
      events.push(event);
    },
  );
  const activation = {
    signal: new AbortController().signal,
    session: { id: "agent", keepAliveSeconds: 600 },
    env: {},
    database: async () => database,
    activity: {
      get active() {
        return activity.active;
      },
      start(fn, policy) {
        activity.start("intake", fn, policy);
      },
      extend(ms) {
        activity.extend(ms);
      },
      cancel() {
        return activity.cancel();
      },
    },
    output: { async send() {} },
    send: async () => {},
  };
  await behaviour.onActivate(activation);
  await behaviour.receive({
    ...activation,
    message: {
      id: "answer",
      sequence: 1,
      payload: { type: "input", content: "hello" },
    },
    reply() {},
  });
  await harness.waitForIdle(ctx);
  assert(activity.active);
  release();
  await until(() => activity.isIdle);
  await Promise.all(pending);
  const decoder = createPiDurableEventDecoder();
  let last;
  for (const event of events) {
    const update = decoder.push(event);
    if (update) last = update;
  }
  assert.equal(last.type, "snapshot");
  assert.deepEqual(last.tasks.tasks, {});
  assert(JSON.stringify(last.value.entries).includes("final durable answer"));
  await harness.close(ctx);
});

test("native mailbox replies before agent completion and output ACK gates safe quiescence", async t => {
  const { createServer } = await import("node:http");
  const { createSessionRuntimeHandler } = await import("../dist/runtime.js");
  const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const database = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([async () => { await gate; return fauxAssistantMessage("native final answer"); }]);
  const model = faux.getModel();
  let harness;
  const definition = definePiDurableSession({
    harness: { models, registry: createRegistry() },
    agent: { model: { provider: model.provider, modelId: model.id } },
    onOpen: h => { harness = h; },
  });
  // Keep the real mailbox/activity/output adapter, supplying the test Workspace DB.
  const withDatabase = context => ({ ...context, database: async () => database });
  const sandboxId = "sbx-" + "1".repeat(32);
  const server = createServer(createSessionRuntimeHandler({
    redelivery: true,
    onActivate: context => definition.onActivate(withDatabase(context)),
    onRecover: context => definition.onRecover(withDatabase(context)),
    receive: context => definition.receive(withDatabase(context)),
  }, { sandboxId }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await harness?.close(ctx);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const request = async (path, body) => fetch(`http://127.0.0.1:${server.address().port}/__cantelop/v2/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "X-Cantelop-Sandbox-ID": sandboxId, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const id = "msg_" + "2".repeat(32);
  const response = await request("messages", {
    session: { id: "agent", workspace_id: "wsp_" + "3".repeat(32), keep_alive_seconds: 600 },
    message: { id, payload: { type: "input", content: "hello" } },
    reply: true,
  });
  assert.equal(response.status, 202);
  await until(async () => (await (await request(`messages/${id}`)).json()).state === "succeeded");
  const reply = await (await request(`messages/${id}/reply`)).json();
  assert.equal(reply.reply.type, "submitted");
  assert((await (await request("runtime")).json()).activity);
  release();
  await harness.waitForIdle(ctx);
  assert.equal((await (await request("runtime")).json()).quiescent, false);
  let after = 0, last;
  const decoder = createPiDurableEventDecoder();
  await until(async () => {
    const result = await (await request(`runtime/events?after=${after}&wait=0`)).json();
    for (const event of result.events) {
      after = event.cursor;
      const update = decoder.push(event.event);
      if (update) last = update;
    }
    if (result.events.length) await request("runtime/events/ack", { through: after });
    return (await (await request("runtime")).json()).quiescent;
  });
  assert.equal(last.type, "snapshot");
  assert.deepEqual(last.tasks.tasks, {});
  assert(JSON.stringify(last.value.entries).includes("native final answer"));
});
