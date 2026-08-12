import assert from "node:assert/strict";
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
      body: JSON.stringify({ input: { prompt: "hello" } }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { output: { answer: "HELLO" } });
  assert.equal(received.id, executionId);
  assert.deepEqual(received.input, { prompt: "hello" });
  assert.equal(received.env.MODEL, "test-model");
  assert.equal(received.signal.aborted, false);
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
      body: JSON.stringify({ input: {}, extra: true }),
    },
  );
  const wrongPath = await fetch(`${origin(server)}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: {} }),
  });

  assert.equal(malformed.status, 400);
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
