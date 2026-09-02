import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import {
  createSessionRuntimeHandler,
  serveSessionRuntime,
} from "../dist/runtime.js";
import { InMemoryMailbox } from "../dist/mailbox.js";
import { defineSessionBehaviour } from "../dist/session.js";

const sandboxID = "sbx-" + "1".repeat(32);
process.env.CANTELOP_SANDBOX_ID = sandboxID;
const fetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { "X-Cantelop-Sandbox-ID": sandboxID, ...init.headers } });
async function acknowledge(server, kind, through) {
 const response = await fetch(`${origin(server)}/__cantelop/v2/runtime/${kind}/ack`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({through}) }); assert.equal(response.status,200);
}
const messageId = "msg_0123456789abcdef0123456789abcdef";
const behaviour = defineSessionBehaviour;

test("the native adapter receives the versioned message protocol", async (t) => {
  let received;
  const server = createServer(
    createSessionRuntimeHandler(behaviour(
      async (context) => {
        received = context;
        assert.equal(String(context.message.payload.prompt).toUpperCase(), "HELLO");
      }),
      { env: { MODEL: "test-model" } },
    ),
  );
  await listen(server);
  t.after(() => close(server));

  const response = await fetch(
    `${origin(server)}/__cantelop/v2/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({ prompt: "hello" })),
    },
  );

  assert.equal(response.status, 202);
  const receipt = await response.json();
  assert.equal(receipt.message_id, messageId); assert.equal(receipt.generation, 1);
  assert.deepEqual({
    id: received.message.id,
    sequence: received.message.sequence,
    payload: received.message.payload,
  }, {
    id: messageId,
    sequence: 1,
    payload: { prompt: "hello" },
  });
  assert.deepEqual(received.session, {
    id: "thread",
    workspaceId: "wsp_0123456789abcdef0123456789abcdef",
    keepAliveSeconds: 300,
  });
  assert.equal(Object.isFrozen(received.message), true);
  assert.equal(Object.isFrozen(received.session), true);
  assert.equal(received.env.MODEL, "test-model");

  const snapshot = await fetch(
    `${origin(server)}/__cantelop/v2/runtime/events?after=0&wait=0`,
  );
  assert.equal(snapshot.status, 200);
  assert.deepEqual(await snapshot.json(), { events: [] });
});

test("the runtime emits the automatic receive span", async (t) => {
  let observedMessage;
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async ({ message }) => {
      observedMessage = message;
    })),
  );
  await listen(server);
  t.after(() => close(server));

  const delivery = fetch(`${origin(server)}/__cantelop/v2/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({ prompt: "hello" }, "thread", messageId, traceContext())),
  });
  const observations = [];
  let cursor = 0;
  while (!observations.some(({ type }) => type === "span.completed")) {
    const response = await fetch(
      `${origin(server)}/__cantelop/v2/runtime/observations?after=${cursor}`,
    );
    assert.equal(response.status, 200);
    const batch = await response.json();
    for (const record of batch.observations) {
      observations.push(record.observation);
      cursor = record.cursor;
    }
  }
  await acknowledge(server, "observations", cursor);
  const acknowledged = await fetch(
    `${origin(server)}/__cantelop/v2/runtime/observations?after=${cursor}&wait=0`,
  );
  assert.deepEqual(await acknowledged.json(), { observations: [] });
  assert.equal((await delivery).status, 202);

  assert.deepEqual(observations.map(({ type }) => type), [
    "span.started", "span.completed",
  ]);
  assert.equal(observations[0].name, "session.receive");
  assert.deepEqual(observedMessage, {
    id: messageId, sequence: 1, payload: { prompt: "hello" },
  });
  assert.equal(Object.isFrozen(observedMessage), true);
});

test("console and process output are captured automatically on the active Message span", async (t) => {
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async () => {
      console.debug("debug value", 1);
      console.log("hello", { answer: 42 });
      console.warn("careful");
      console.error(new Error("broken"));
      process.stdout.write("raw stdout\n");
      process.stderr.write("raw stderr\n");
    })),
  );
  await listen(server);
  t.after(() => close(server));

  const delivery = fetch(`${origin(server)}/__cantelop/v2/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({}, "thread", messageId, traceContext())),
  });
  const observations = [];
  let cursor = 0;
  while (!observations.some(({ type }) => type === "span.completed")) {
    const response = await fetch(
      `${origin(server)}/__cantelop/v2/runtime/observations?after=${cursor}`,
    );
    assert.equal(response.status, 200);
    const batch = await response.json();
    for (const record of batch.observations) {
      observations.push(record.observation);
      cursor = record.cursor;
      assert.equal(record.message_id, messageId);
    }
  }
  await fetch(`${origin(server)}/__cantelop/v2/runtime/observations?after=${cursor}&wait=0`);
  assert.equal((await delivery).status, 202);

  const logs = observations.filter(({ type }) => type === "log.recorded");
  const selected = logs.filter(({ body }) =>
    /^(debug value|hello|careful|Error: broken|raw stdout|raw stderr)/.test(body));
  assert.deepEqual(selected.map(({ severity }) => severity), [
    "debug", "info", "warn", "error", "info", "error",
  ]);
  assert.deepEqual(selected.map(({ attributes }) => attributes.source), [
    "console", "console", "console", "console", "stdout", "stderr",
  ]);
  assert.ok(logs.every(({ span_id }) => span_id === observations[0].span_id));
  assert.match(selected[1].body, /hello.*answer.*42/);
  assert.match(selected[3].body, /Error: broken/);
});

test("the platform drains ordered Session output events", async (t) => {
  let beginOutput;
  const outputStarted = new Promise((resolve) => { beginOutput = resolve; });
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async ({ output }) => {
      beginOutput();
      await output.send({ type: "text_delta", delta: "hello" });
      await output.send({ type: "done" });
    })),
  );
  await listen(server);
  t.after(() => close(server));

  const delivery = fetch(`${origin(server)}/__cantelop/v2/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({ prompt: "hello" })),
  });
  await outputStarted;
  const first = await fetch(
    `${origin(server)}/__cantelop/v2/runtime/events?after=0`,
  );
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    events: [{
      cursor: 1,
      message_id: messageId,
      event: { type: "text_delta", delta: "hello" },
    }],
  });

  await acknowledge(server, "events", 1);
  const second = await fetch(
    `${origin(server)}/__cantelop/v2/runtime/events?after=1`,
  );
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), {
    events: [{
      cursor: 2,
      message_id: messageId,
      event: { type: "done" },
    }],
  });
  const acknowledged = await fetch(
    `${origin(server)}/__cantelop/v2/runtime/events?after=2&wait=0`,
  );
  assert.equal(acknowledged.status, 200);
  assert.deepEqual(await acknowledged.json(), { events: [] });
  assert.equal((await delivery).status, 202);
});

test("runtime activity keeps the Session active while steer and cancel messages run", async (t) => {
  const handled = [];
  const sequences = [];
  let activity;
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async (context) => {
      const { payload } = context.message;
      activity = context.activity;
      handled.push(payload.type);
      sequences.push(context.message.sequence);

      if (payload.type === "start") {
        context.activity.start(async ({ signal, send }) => {
          await new Promise((resolve) => {
            signal.addEventListener("abort", resolve, { once: true });
          });
          send({ type: "cancelled" });
        });
      } else if (payload.type === "steer") {
        assert.equal(context.activity.active, true);
      } else if (payload.type === "cancel") {
        assert.equal(context.activity.cancel(), true);
      } else if (payload.type === "cancelled") {
        assert.equal(context.activity.active, false);
      }
    })),
  );
  await listen(server);
  t.after(() => close(server));
  const url = `${origin(server)}/__cantelop/v2/messages`;
  const send = (id, payload) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope(payload, "thread", id)),
  });

  const first = send(messageId, { type: "start" });
  assert.equal((await first).status, 202);
  assert.equal(activity.active, true);

  const steer = send(
    "msg_11111111111111111111111111111111",
    { type: "steer" },
  );
  await waitFor(() => handled.length === 2);
  const cancel = send(
    "msg_22222222222222222222222222222222",
    { type: "cancel" },
  );

  assert.equal((await steer).status, 202);
  assert.equal((await cancel).status, 202);
  await waitFor(() => handled.length === 4);
  assert.deepEqual(handled, ["start", "steer", "cancel", "cancelled"]);
  assert.deepEqual(sequences, [1, 2, 3, 4]);
});

test("message and activity send capabilities close when their work settles", async (t) => {
  let invocation;
  let activity;
  let finishActivity;
  const activityFinished = new Promise((resolve) => { finishActivity = resolve; });
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async (context) => {
      invocation = context;
      context.activity.start(async (activityContext) => {
        activity = activityContext;
        await activityFinished;
      });
    })),
  );
  await listen(server);
  t.after(() => finishActivity());
  t.after(() => close(server));

  const response = await fetch(`${origin(server)}/__cantelop/v2/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({ type: "start" })),
  });
  assert.equal(response.status, 202);
  assert.throws(
    () => invocation.send({ type: "late" }),
    /message invocation has already settled/,
  );
  await assert.rejects(
    invocation.output.send({ type: "late" }),
    /message invocation has already settled/,
  );

  finishActivity();
  await waitFor(() => invocation.activity.active === false);
  assert.throws(
    () => activity.send({ type: "late" }),
    /activity has already settled/,
  );
  await assert.rejects(
    activity.output.send({ type: "late" }),
    /activity has already settled/,
  );
});

test("the platform can wait for generation-fenced runtime quiescence", async (t) => {
  let finishActivity;
  let finishSelfMessage;
  const activityFinished = new Promise((resolve) => { finishActivity = resolve; });
  const selfMessageFinished = new Promise((resolve) => { finishSelfMessage = resolve; });
  const handled = [];
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async (context) => {
      handled.push(context.message.payload.type);
      if (context.message.payload.type === "start") {
        context.activity.start(async ({ send }) => {
          await activityFinished;
          send({ type: "completed" });
        });
      } else if (context.message.payload.type === "completed") {
        await selfMessageFinished;
      }
    })),
  );
  await listen(server);
  t.after(() => finishActivity());
  t.after(() => finishSelfMessage());
  t.after(() => close(server));

  const messageResponse = await fetch(`${origin(server)}/__cantelop/v2/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({ type: "start" })),
  });
  assert.equal(messageResponse.status, 202);
  assert.equal((await messageResponse.json()).generation, 1);

  let quiescenceSettled = false;
  const quiescence = fetch(
    `${origin(server)}/__cantelop/v2/runtime/quiescence?minimum_generation=1`,
  ).then((response) => {
    quiescenceSettled = true;
    return response;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(quiescenceSettled, false);

  finishActivity();
  await waitFor(() => handled.includes("completed"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(quiescenceSettled, false);

  finishSelfMessage();
  const quiescenceResponse = await quiescence;
  assert.equal(quiescenceResponse.status, 200);
  assert.deepEqual(await quiescenceResponse.json(), {
    state: "quiescent",
    generation: 2,
  });
  assert.deepEqual(handled, ["start", "completed"]);
});

test("runtime quiescence requires a bound Session and one valid generation", async (t) => {
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async () => undefined)),
  );
  await listen(server);
  t.after(() => close(server));

  const unbound = await fetch(
    `${origin(server)}/__cantelop/v2/runtime/quiescence?minimum_generation=0`,
  );
  const malformed = await fetch(
    `${origin(server)}/__cantelop/v2/runtime/quiescence?minimum_generation=one`,
  );
  assert.equal(unbound.status, 409);
  assert.deepEqual(await unbound.json(), { error: { code: "session_unbound" } });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    error: { code: "invalid_quiescence_request" },
  });
});

test("the mailbox records internal queue timing without exposing a queued state", async () => {
  const events = [];
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const mailbox = new InMemoryMailbox((event) => events.push(event));

  const first = mailbox.enqueue("first", async () => firstReleased);
  const second = mailbox.enqueue("second", async () => undefined);
  assert.equal(mailbox.enqueue("second", async () => undefined), second);
  await waitFor(() => events.some((event) => event.type === "handling"));
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events.map((event) => event.type), [
    "enqueued",
    "enqueued",
    "deduplicated",
    "handling",
    "handled",
    "handling",
    "handled",
  ]);
  assert.equal(events[0].depth, 1);
  assert.equal(events[1].depth, 2);
  assert.equal(Number.isInteger(events[3].queueWaitMicroseconds), true);
  assert.equal(Number.isInteger(events[4].handlingMicroseconds), true);
});

test("one Session runtime processes its Session mailbox in FIFO order", async (t) => {
  const started = [];
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const server = createServer(
    createSessionRuntimeHandler({
      async receive(context) {
        started.push(context.message.payload.type);
        if (context.message.payload.type === "message") await firstReleased;
      },
    }),
  );
  await listen(server);
  t.after(() => releaseFirst());
  t.after(() => close(server));

  const first = fetch(
    `${origin(server)}/__cantelop/v2/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({ type: "message" })),
    },
  );
  await waitFor(() => started.length === 1);
  const secondMessageId = "msg_fedcba9876543210fedcba9876543210";
  const second = fetch(
    `${origin(server)}/__cantelop/v2/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({ type: "steer" }, "thread", secondMessageId)),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ["message"]);
  releaseFirst();
  assert.equal((await first).status, 202);
  assert.equal((await second).status, 202);
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["message", "steer"]);
});

test("one Session runtime deduplicates a message ID for its activation", async (t) => {
  let calls = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async () => {
      calls += 1;
      await released;
    })),
  );
  await listen(server);
  t.after(() => release());
  t.after(() => close(server));
  const url = `${origin(server)}/__cantelop/v2/messages`;
  const request = () => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({ type: "message" })),
  });

  const first = request();
  await waitFor(() => calls === 1);
  const duplicate = request();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);

  release();
  assert.equal((await first).status, 202);
  assert.equal((await duplicate).status, 202);
  const completedDuplicate = await request();
  assert.equal(completedDuplicate.status, 202);
  assert.equal((await completedDuplicate.json()).generation, 1);
  assert.equal(calls, 1);
});

test("a Session runtime server is bound to one Session identity", async (t) => {
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async () => ({ ok: true }))),
  );
  await listen(server);
  t.after(() => close(server));
  const url = `${origin(server)}/__cantelop/v2/messages`;

  const first = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({})),
  });
  const second = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({}, "other-thread")),
  });

  assert.equal(first.status, 202);
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: { code: "session_mismatch" } });
});

test("the native adapter marks a failed user message as settled", async (t) => {
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async () => {
      throw new Error("user message failed");
    })),
  );
  await listen(server);
  t.after(() => close(server));

  const response = await fetch(
    `${origin(server)}/__cantelop/v2/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({})),
    },
  );

  assert.equal(response.status, 202);
 const status = await fetch(`${origin(server)}/__cantelop/v2/messages/${messageId}`);
 assert.equal((await status.json()).state, "failed");
});

test("the native adapter rejects malformed protocol requests", async (t) => {
  let calls = 0;
  const server = createServer(
    createSessionRuntimeHandler(behaviour(async () => {
      calls += 1;
    })),
  );
  await listen(server);
  t.after(() => close(server));

  const malformed = await fetch(
    `${origin(server)}/__cantelop/v2/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...messageEnvelope({}), extra: true }),
    },
  );
  const wrongPath = await fetch(`${origin(server)}/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope({})),
  });

  assert.equal(malformed.status, 400);
  assert.equal(
    malformed.headers.get("X-Cantelop-SDK-Message-Complete"),
    null,
  );
  assert.deepEqual(await malformed.json(), {
    error: { code: "invalid_message_request" },
  });
  assert.equal(wrongPath.status, 404);
  assert.equal(calls, 0);
});

test("serveSessionRuntime requires the platform-owned internal port", () => {
  const previous = process.env.CANTELOP_INTERNAL_PORT;
  delete process.env.CANTELOP_INTERNAL_PORT;
  try {
    assert.throws(
      () => serveSessionRuntime(behaviour(async () => undefined)),
      /CANTELOP_INTERNAL_PORT is not configured/,
    );
  } finally {
    if (previous === undefined) delete process.env.CANTELOP_INTERNAL_PORT;
    else process.env.CANTELOP_INTERNAL_PORT = previous;
  }
});

test("serveSessionRuntime exposes an explicit listener-ready signal", async (t) => {
  const previous = process.env.CANTELOP_INTERNAL_PORT;
  const reservation = createServer();
  await listen(reservation);
  const address = reservation.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await close(reservation);
  process.env.CANTELOP_INTERNAL_PORT = String(port);

  try {
    const runtime = serveSessionRuntime(behaviour(async () => undefined));
    t.after(() => runtime.close());
    await runtime.ready;
    assert.equal(runtime.server.listening, true);
    assert.equal(runtime.port, port);
  } finally {
    if (previous === undefined) delete process.env.CANTELOP_INTERNAL_PORT;
    else process.env.CANTELOP_INTERNAL_PORT = previous;
  }
});

test("serveSessionRuntime exposes startup and background output at Sandbox scope", async () => {
  const previous = process.env.CANTELOP_INTERNAL_PORT;
  const reservation = createServer();
  await listen(reservation);
  const address = reservation.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await close(reservation);
  process.env.CANTELOP_INTERNAL_PORT = String(port);

  let runtime;
  try {
    runtime = serveSessionRuntime(behaviour(async () => undefined));
    await runtime.ready;
    process.stdout.write("background runtime output\n");
    const response = await fetch(
      `http://127.0.0.1:${port}/__cantelop/v2/runtime/observations?after=0&wait=0`,
    );
    assert.equal(response.status, 200);
    const batch = await response.json();
    const record = batch.observations.find(({ observation }) =>
      observation.body === "background runtime output");
    assert.equal(record.message_id, undefined);
    assert.deepEqual(record.observation.attributes, { source: "stdout", automatic: true });
  } finally {
    if (runtime) await runtime.close();
    if (previous === undefined) delete process.env.CANTELOP_INTERNAL_PORT;
    else process.env.CANTELOP_INTERNAL_PORT = previous;
  }
});

test("serveSessionRuntime adopts the platform-prebound listener", async () => {
  const reservation = createServer();
  await listen(reservation);
  const address = reservation.address();
  assert.equal(typeof address, "object");
  const descriptor = reservation._handle.fd;
  assert.equal(Number.isInteger(descriptor), true);

  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'import { serveSessionRuntime } from "./dist/runtime.js";',
      "const runtime = serveSessionRuntime({ receive: async () => undefined });",
      "await runtime.ready;",
      'process.stdout.write("READY\\n");',
      "setTimeout(() => {}, 30_000);",
    ].join("\n"),
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      CANTELOP_INTERNAL_PORT: String(address.port),
      CANTELOP_INTERNAL_FD: "3",
    },
    stdio: ["ignore", "pipe", "inherit", descriptor],
  });
  await close(reservation);
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (chunk) => {
        if (String(chunk) === "READY\n") resolve();
        else reject(new Error(`unexpected child output: ${String(chunk)}`));
      });
    });
    const response = await fetch(
      `http://127.0.0.1:${address.port}/__cantelop/v2/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageEnvelope({})),
      },
    );
    assert.equal(response.status, 202);
  } finally {
    child.kill();
  }
});

test("serveSessionRuntime rejects an invalid inherited listener descriptor", () => {
  const previousPort = process.env.CANTELOP_INTERNAL_PORT;
  const previousFD = process.env.CANTELOP_INTERNAL_FD;
  process.env.CANTELOP_INTERNAL_PORT = "3000";
  process.env.CANTELOP_INTERNAL_FD = "socket";
  try {
    assert.throws(
      () => serveSessionRuntime(behaviour(async () => undefined)),
      /CANTELOP_INTERNAL_FD must be an inherited file descriptor/,
    );
  } finally {
    if (previousPort === undefined) delete process.env.CANTELOP_INTERNAL_PORT;
    else process.env.CANTELOP_INTERNAL_PORT = previousPort;
    if (previousFD === undefined) delete process.env.CANTELOP_INTERNAL_FD;
    else process.env.CANTELOP_INTERNAL_FD = previousFD;
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function origin(server) {
  const address = server.address();
  assert.equal(typeof address, "object");
  return `http://127.0.0.1:${address.port}`;
}

function messageEnvelope(payload, sessionId = "thread", id = messageId, observability) {
  return {
    session: {
      id: sessionId,
      workspace_id: "wsp_0123456789abcdef0123456789abcdef",
      keep_alive_seconds: 300,
    },
    message: { id, payload },
    ...(observability === undefined ? {} : { observability }),
  };
}

function traceContext() {
  return {
    attempt_id: "att_11111111111111111111111111111111",
    attempt: 1,
    request_id: "req_abcdefabcdefabcdefabcdefabcdefab",
    traceparent: "00-abcdefabcdefabcdefabcdefabcdefab-2222222222222222-01",
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}
