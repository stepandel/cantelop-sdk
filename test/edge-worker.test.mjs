import assert from "node:assert/strict";
import test from "node:test";
import { createApp, defineApi } from "../dist/api.js";
import { createApiWorker } from "../dist/edge.js";

const environmentId = "env_0123456789abcdef0123456789abcdef";
const executionId = "exec_0123456789abcdef0123456789abcdef";

test("the Edge adapter turns an API definition into a standard Worker", async () => {
  let runtimeRequest;
  const definition = defineApi(({ execution }) => {
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

  const response = await worker.fetch(
    new Request("https://base-agent.cantelop.dev/execute", {
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
      headers: { "Content-Type": "application/json" },
    }),
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
});

test("the Edge adapter rejects a malformed API definition at startup", () => {
  assert.throws(() => createApiWorker({}), /Invalid Cantelop API definition/);
});
