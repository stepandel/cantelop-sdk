import assert from "node:assert/strict";
import test from "node:test";
import { defineApi } from "../dist/api.js";
import { createApiWorker } from "../dist/edge.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const sessionId = "ses_0123456789abcdef0123456789abcdef";
const messageId = "msg_0123456789abcdef0123456789abcdef";

test("the Edge adapter turns an API definition into a standard Worker", async () => {
  const runtimeRequests = [];
  let receivedEnvironment;
  let factoryCalls = 0;
  const definition = defineApi(({ app, env, router }) => {
    factoryCalls += 1;
    receivedEnvironment = env;
    router.route("POST", "/dispatch", async ({ request }) => {
      const session = app.sessions.open({
        id: sessionId,
        workspaceId,
        keepAliveSeconds: 300,
      });
      const message = await session.dispatch(await request.json());
      return Response.json({ sessionId: session.id, message }, { status: 202 });
    });
  });
  const worker = createApiWorker(definition, {
    sessionId: () => sessionId,
    messageId: () => messageId,
    fetch: async (request) => {
      runtimeRequests.push(request);
      return Response.json({
        id: messageId,
        status: "accepted",
        accepted_at: "2026-08-17T12:00:00Z",
      }, { status: 202 });
    },
  });

  const bindings = {
    LOG_LEVEL: "debug",
    API_SECRET: "edge-secret",
    CANTELOP_INTERNAL_TOKEN: "reserved",
    SERVICE: { fetch() {} },
  };
  const response = await worker.fetch(
    new Request("https://base-agent.cantelop.dev/dispatch", {
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
      headers: { "Content-Type": "application/json" },
    }),
    bindings,
  );

  assert.deepEqual(await response.json(), {
    sessionId,
    message: {
      id: messageId,
      state: "accepted",
      acceptedAt: "2026-08-17T12:00:00.000Z",
    },
  });
  assert.equal(runtimeRequests.length, 1);
  assert.equal(
    runtimeRequests[0].url,
    "https://runtime.cantelop.internal/__cantelop/v1/messages",
  );
  assert.equal(runtimeRequests[0].headers.get("X-Cantelop-Edge-Workspace-ID"), null);
  assert.deepEqual(await runtimeRequests[0].json(), {
    session: {
      id: sessionId,
      workspace_id: workspaceId,
      keep_alive_seconds: 300,
    },
    message: {
      id: messageId,
      payload: { prompt: "hello" },
    },
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

test("D1 is exposed by identity only as db, with binding-context isolation", async () => {
  const contexts = [];
  const makeDB = () => ({ prepare() {}, batch() {}, exec() {}, withSession() {} });
  const first = makeDB();
  const second = makeDB();
  const worker = createApiWorker(defineApi((context) => { contexts.push(context); }));
  const bindings = { DB: first, OTHER: makeDB(), CANTELOP_DATABASE: makeDB() };
  await worker.fetch(new Request("https://example.com/"), bindings);
  await worker.fetch(new Request("https://example.com/"), bindings);
  await worker.fetch(new Request("https://example.com/"), { DB: second });
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].db, first);
  assert.equal(contexts[1].db, second);
  assert.deepEqual({ ...contexts[0].env }, {});
  assert.equal(Object.isFrozen(first), false);
});

test("D1 absence preserves existing APIs and legacy DB strings", async () => {
  const contexts = [];
  const worker = createApiWorker(defineApi((context) => { contexts.push(context); }));
  await worker.fetch(new Request("https://example.com/"));
  await worker.fetch(new Request("https://example.com/"), { DB: "connection-string" });
  assert.equal(contexts[0].db, undefined);
  assert.equal(contexts[1].db, undefined);
  assert.equal(contexts[1].env.DB, "connection-string");
});

test("malformed database bindings fail before a handler executes", () => {
  const worker = createApiWorker(defineApi(() => assert.fail("must not create router")));
  for (const DB of [null, 42, {}, { prepare() {} }]) {
    assert.throws(() => worker.fetch(new Request("https://example.com/"), { DB }), /database binding/);
  }
});
