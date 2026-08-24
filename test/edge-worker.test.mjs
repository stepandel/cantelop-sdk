import assert from "node:assert/strict";
import test from "node:test";
import { defineApi } from "../dist/api.js";
import { createApiWorker } from "../dist/edge.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const sessionId = "ses_0123456789abcdef0123456789abcdef";
const executionId = "exec_0123456789abcdef0123456789abcdef";

test("the Edge adapter turns an API definition into a standard Worker", async () => {
  const runtimeRequests = [];
  let receivedEnvironment;
  let factoryCalls = 0;
  const definition = defineApi(({ app, env, router }) => {
    factoryCalls += 1;
    receivedEnvironment = env;
    router.route("POST", "/execute", async ({ request }) => {
      const session = app.sessions.open({
        id: sessionId,
        workspaceId,
        keepAliveSeconds: 300,
      });
      const output = await session.execute(await request.json(), { signal: request.signal });
      return Response.json({ sessionId: session.id, output });
    });
  });
  const worker = createApiWorker(definition, {
    sessionId: () => sessionId,
    executionId: () => executionId,
    fetch: async (request) => {
      runtimeRequests.push(request);
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
    sessionId,
    output: { answer: "edge to VM" },
  });
  assert.equal(runtimeRequests.length, 1);
  assert.equal(
    runtimeRequests[0].url,
    `https://runtime.cantelop.internal/__cantelop/v1/sessions/${sessionId}/executions`,
  );
  assert.equal(runtimeRequests[0].headers.get("X-Cantelop-Edge-Workspace-ID"), null);
  assert.deepEqual(await runtimeRequests[0].json(), {
    id: executionId,
    session: {
      id: sessionId,
      workspace_id: workspaceId,
      keep_alive_seconds: 300,
    },
    input: { prompt: "hello" },
  });
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
