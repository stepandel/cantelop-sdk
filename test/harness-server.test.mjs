import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import {
  createHarnessRequestHandler,
  serveHarness,
} from "../dist/harness.js";

const executionId = "exec_0123456789abcdef0123456789abcdef";

test("the native adapter executes the versioned harness protocol", async (t) => {
  let received;
  const server = createServer(
    createHarnessRequestHandler(
      async (context) => {
        received = context;
        return { answer: String(context.input.prompt).toUpperCase() };
      },
      { env: { MODEL: "test-model" } },
    ),
  );
  await listen(server);
  t.after(() => close(server));

  const response = await fetch(
    `${origin(server)}/__cantelop/v1/executions/${executionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(executionEnvelope({ prompt: "hello" })),
    },
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("X-Cantelop-SDK-Execution-Complete"),
    executionId,
  );
  assert.deepEqual(await response.json(), { output: { answer: "HELLO" } });
  assert.deepEqual(received.execution, { id: executionId, kind: "execute" });
  assert.deepEqual(received.session, {
    id: "thread",
    workspaceId: "wsp_0123456789abcdef0123456789abcdef",
    keepAliveSeconds: 300,
  });
  assert.equal(Object.isFrozen(received.execution), true);
  assert.equal(Object.isFrozen(received.session), true);
  assert.deepEqual(received.input, { prompt: "hello" });
  assert.equal(received.env.MODEL, "test-model");
  assert.equal(received.signal.aborted, false);
});

test("the native adapter routes steering to the session-aware handler", async (t) => {
  let received;
  const server = createServer(
    createHarnessRequestHandler({
      run: async () => { throw new Error("run must not handle steering"); },
      steer: async (context) => {
        received = context;
        return { accepted: true };
      },
    }),
  );
  await listen(server);
  t.after(() => close(server));

  const response = await fetch(
    `${origin(server)}/__cantelop/v1/executions/${executionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(executionEnvelope({ prompt: "focus" }, "steer")),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { output: { accepted: true } });
  assert.equal(received.execution.kind, "steer");
  assert.equal(received.session.id, "thread");
});

test("a harness server is bound to one Session identity", async (t) => {
  const server = createServer(
    createHarnessRequestHandler(async () => ({ ok: true })),
  );
  await listen(server);
  t.after(() => close(server));
  const url = `${origin(server)}/__cantelop/v1/executions/${executionId}`;

  const first = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(executionEnvelope({})),
  });
  const second = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(executionEnvelope({}, "execute", "other-thread")),
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: { code: "session_mismatch" } });
});

test("the native adapter marks a failed user execution as settled", async (t) => {
  const server = createServer(
    createHarnessRequestHandler(async () => {
      throw new Error("user execution failed");
    }),
  );
  await listen(server);
  t.after(() => close(server));

  const response = await fetch(
    `${origin(server)}/__cantelop/v1/executions/${executionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(executionEnvelope({})),
    },
  );

  assert.equal(response.status, 500);
  assert.equal(
    response.headers.get("X-Cantelop-SDK-Execution-Complete"),
    executionId,
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
    `${origin(server)}/__cantelop/v1/executions/${executionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...executionEnvelope({}), extra: true }),
    },
  );
  const wrongPath = await fetch(`${origin(server)}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(executionEnvelope({})),
  });

  assert.equal(malformed.status, 400);
  assert.equal(
    malformed.headers.get("X-Cantelop-SDK-Execution-Complete"),
    null,
  );
  assert.deepEqual(await malformed.json(), {
    error: { code: "invalid_execution_request" },
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
      "const harness = serveHarness(async () => ({ ready: true }));",
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
      `http://127.0.0.1:${address.port}/__cantelop/v1/executions/${executionId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(executionEnvelope({})),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { output: { ready: true } });
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

function executionEnvelope(input, operation = "execute", sessionId = "thread") {
  return {
    operation,
    session: {
      id: sessionId,
      workspace_id: "wsp_0123456789abcdef0123456789abcdef",
      keep_alive_seconds: 300,
    },
    input,
  };
}
