import assert from "node:assert/strict";
import test from "node:test";
import { createApp, defineApi } from "../dist/api.js";
import { createApiWorker } from "../dist/edge.js";

const environmentId = "env_0123456789abcdef0123456789abcdef";
const executionId = "exec_0123456789abcdef0123456789abcdef";

test("the Edge adapter turns an API definition into a standard Worker", async () => {
  let runtimeRequest;
  let receivedEnvironment;
  let factoryCalls = 0;
  const definition = defineApi(({ execution, env }) => {
    factoryCalls += 1;
    receivedEnvironment = env;
    const app = createApp({
      execution: execution.forEnvironment(environmentId),
    });
    app.route("POST", "/execute", async ({ request, execution: runtime }) => {
      const run = await runtime.start(await request.json(), {
        signal: request.signal,
      });
      return Response.json({ id: run.id, output: await run.wait() });
    });
    return app;
  });
  const worker = createApiWorker(definition, {
    executionId: () => executionId,
    fetch: async (request) => {
      runtimeRequest = request;
      return Response.json({ output: { answer: "edge to VM" } });
    },
  });

  const bindings = {
    LOG_LEVEL: "debug",
    API_SECRET: "edge-secret",
    CANTELOP_INTERNAL_TOKEN: "reserved",
    SERVICE: { fetch() {} },
  };
  const response = await worker.fetch(
    new Request("https://base-agent.cantelop.dev/execute", {
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
      headers: { "Content-Type": "application/json" },
    }),
    bindings,
  );

  assert.deepEqual(await response.json(), {
    id: executionId,
    output: { answer: "edge to VM" },
  });
  assert.equal(
    runtimeRequest.url,
    `https://runtime.cantelop.internal/__cantelop/v1/executions/${executionId}`,
  );
  assert.equal(
    runtimeRequest.headers.get("X-Cantelop-Edge-Environment-ID"),
    environmentId,
  );
  assert.deepEqual({ ...receivedEnvironment }, {
    LOG_LEVEL: "debug",
    API_SECRET: "edge-secret",
  });
  assert.equal(Object.isFrozen(receivedEnvironment), true);

  await worker.fetch(new Request("https://base-agent.cantelop.dev/missing"), bindings);
  assert.equal(factoryCalls, 1);
});

test("the Edge adapter rejects a malformed API definition at startup", () => {
  assert.throws(() => createApiWorker({}), /Invalid Cantelop API definition/);
});
