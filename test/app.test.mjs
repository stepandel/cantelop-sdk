import assert from "node:assert/strict";
import test from "node:test";
import { createApp, defineApi } from "../dist/api.js";
import { createExecutionEnvironment } from "../dist/harness.js";

test("an app handles Web requests and responses", async () => {
  const execution = createExecutionEnvironment(async ({ input, signal }) => {
    signal.throwIfAborted();
    return input.toUpperCase();
  });
  const definition = defineApi(({ execution: remoteExecution }) => {
    const app = createApp({ execution: remoteExecution });

    app.route("POST", "/execute", async ({ request, execution: environment }) => {
      const input = await request.text();
      const run = await environment.start(input, { signal: request.signal });
      return Response.json({ id: run.id, output: await run.wait() });
    });

    return app;
  });
  const app = definition.create({ execution });

  const response = await app.handle(
    new Request("https://example.test/execute", {
      body: "hello",
      method: "POST",
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.equal(body.output, "HELLO");
});

test("an app returns Web-standard routing errors", async () => {
  const execution = createExecutionEnvironment(async () => undefined);
  const app = createApp({ execution });
  app.route("POST", "/execute", () => new Response());

  const methodNotAllowed = await app.handle(
    new Request("https://example.test/execute"),
  );
  const notFound = await app.handle(
    new Request("https://example.test/missing"),
  );

  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.headers.get("allow"), "POST");
  assert.equal(notFound.status, 404);
});
