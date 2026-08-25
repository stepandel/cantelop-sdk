import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import {
  createHarnessRequestHandler,
  serveHarness,
} from "../dist/harness.js";
import { InMemoryMailbox } from "../dist/mailbox.js";

const messageId = "msg_0123456789abcdef0123456789abcdef";

test("the native adapter receives the versioned message protocol", async (t) => {
  let received;
  const server = createServer(
    createHarnessRequestHandler(
      async (context) => {
        received = context;
        assert.equal(String(context.message.payload.prompt).toUpperCase(), "HELLO");
      },
      { env: { MODEL: "test-model" } },
    ),
  );
  await listen(server);
  t.after(() => close(server));

  const response = await fetch(
    `${origin(server)}/__cantelop/v1/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({ prompt: "hello" })),
    },
  );

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("X-Cantelop-SDK-Message-Complete"),
    messageId,
  );
  assert.deepEqual(received.message, {
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
});

test("runtime activity keeps the Session active while steer and cancel messages run", async (t) => {
  const handled = [];
  const sequences = [];
  let activity;
  const server = createServer(
    createHarnessRequestHandler(async (context) => {
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
    }),
  );
  await listen(server);
  t.after(() => close(server));
  const url = `${origin(server)}/__cantelop/v1/messages`;
  const send = (id, payload) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(messageEnvelope(payload, "thread", id)),
  });

  const first = send(messageId, { type: "start" });
  assert.equal((await first).status, 204);
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

  assert.equal((await steer).status, 204);
  assert.equal((await cancel).status, 204);
  await waitFor(() => handled.length === 4);
  assert.deepEqual(handled, ["start", "steer", "cancel", "cancelled"]);
  assert.deepEqual(sequences, [1, 2, 3, 4]);
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

test("one harness runtime processes its Session mailbox in FIFO order", async (t) => {
  const started = [];
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const server = createServer(
    createHarnessRequestHandler({
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
    `${origin(server)}/__cantelop/v1/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({ type: "message" })),
    },
  );
  await waitFor(() => started.length === 1);
  const secondMessageId = "msg_fedcba9876543210fedcba9876543210";
  const second = fetch(
    `${origin(server)}/__cantelop/v1/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({ type: "steer" }, "thread", secondMessageId)),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(started, ["message"]);
  releaseFirst();
  assert.equal((await first).status, 204);
  assert.equal((await second).status, 204);
  assert.deepEqual(started, ["message", "steer"]);
});

test("one harness runtime deduplicates a message ID for its activation", async (t) => {
  let calls = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const server = createServer(
    createHarnessRequestHandler(async () => {
      calls += 1;
      await released;
    }),
  );
  await listen(server);
  t.after(() => release());
  t.after(() => close(server));
  const url = `${origin(server)}/__cantelop/v1/messages`;
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
  assert.equal((await first).status, 204);
  assert.equal((await duplicate).status, 204);
  assert.equal((await request()).status, 204);
  assert.equal(calls, 1);
});

test("a harness server is bound to one Session identity", async (t) => {
  const server = createServer(
    createHarnessRequestHandler(async () => ({ ok: true })),
  );
  await listen(server);
  t.after(() => close(server));
  const url = `${origin(server)}/__cantelop/v1/messages`;

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

  assert.equal(first.status, 204);
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: { code: "session_mismatch" } });
});

test("the native adapter marks a failed user message as settled", async (t) => {
  const server = createServer(
    createHarnessRequestHandler(async () => {
      throw new Error("user message failed");
    }),
  );
  await listen(server);
  t.after(() => close(server));

  const response = await fetch(
    `${origin(server)}/__cantelop/v1/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messageEnvelope({})),
    },
  );

  assert.equal(response.status, 500);
  assert.equal(
    response.headers.get("X-Cantelop-SDK-Message-Complete"),
    messageId,
  );
});

test("the native adapter rejects malformed protocol requests", async (t) => {
  let calls = 0;
  const server = createServer(
    createHarnessRequestHandler(async () => {
      calls += 1;
    }),
  );
  await listen(server);
  t.after(() => close(server));

  const malformed = await fetch(
    `${origin(server)}/__cantelop/v1/messages`,
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

test("serveHarness requires the platform-owned internal port", () => {
  const previous = process.env.CANTELOP_INTERNAL_PORT;
  delete process.env.CANTELOP_INTERNAL_PORT;
  try {
    assert.throws(
      () => serveHarness(async () => undefined),
      /CANTELOP_INTERNAL_PORT is not configured/,
    );
  } finally {
    if (previous === undefined) delete process.env.CANTELOP_INTERNAL_PORT;
    else process.env.CANTELOP_INTERNAL_PORT = previous;
  }
});

test("serveHarness exposes an explicit listener-ready signal", async (t) => {
  const previous = process.env.CANTELOP_INTERNAL_PORT;
  const reservation = createServer();
  await listen(reservation);
  const address = reservation.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await close(reservation);
  process.env.CANTELOP_INTERNAL_PORT = String(port);

  try {
    const harness = serveHarness(async () => undefined);
    t.after(() => harness.close());
    await harness.ready;
    assert.equal(harness.server.listening, true);
    assert.equal(harness.port, port);
  } finally {
    if (previous === undefined) delete process.env.CANTELOP_INTERNAL_PORT;
    else process.env.CANTELOP_INTERNAL_PORT = previous;
  }
});

test("serveHarness adopts the platform-prebound listener", async () => {
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
      'import { serveHarness } from "./dist/harness.js";',
      "const harness = serveHarness(async () => undefined);",
      "await harness.ready;",
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
      `http://127.0.0.1:${address.port}/__cantelop/v1/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageEnvelope({})),
      },
    );
    assert.equal(response.status, 204);
  } finally {
    child.kill();
  }
});

test("serveHarness rejects an invalid inherited listener descriptor", () => {
  const previousPort = process.env.CANTELOP_INTERNAL_PORT;
  const previousFD = process.env.CANTELOP_INTERNAL_FD;
  process.env.CANTELOP_INTERNAL_PORT = "3000";
  process.env.CANTELOP_INTERNAL_FD = "socket";
  try {
    assert.throws(
      () => serveHarness(async () => undefined),
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

function messageEnvelope(payload, sessionId = "thread", id = messageId) {
  return {
    session: {
      id: sessionId,
      workspace_id: "wsp_0123456789abcdef0123456789abcdef",
      keep_alive_seconds: 300,
    },
    message: { id, payload },
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached");
}
