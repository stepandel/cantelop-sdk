import assert from "node:assert/strict";
import test from "node:test";
import { createRouter, defineApi } from "../dist/api.js";

test("a router handles Web requests and can close over the current App", async () => {
  const definition = defineApi(({ app }) => {
    const router = createRouter();
    router.route("POST", "/execute", async ({ request }) => {
      const session = app.sessions.connect("ses_test");
      return Response.json({ output: await session.execute(await request.text()) });
    });
    return router;
  });
  const router = definition.create({
    app: {
      workspaces: { create() { throw new Error("not used"); } },
      sessions: {
        create() { throw new Error("not used"); },
        connect(sessionId) {
          assert.equal(sessionId, "ses_test");
          return {
            id: sessionId,
            execute: async (input) => input.toUpperCase(),
            terminate: async () => undefined,
          };
        },
      },
    },
    env: {},
  });

  const response = await router.handle(
    new Request("https://example.test/execute", {
      body: "hello",
      method: "POST",
    }),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.output, "HELLO");
});

test("a router returns Web-standard routing errors", async () => {
  const router = createRouter();
  router.route("POST", "/execute", () => new Response());

  const methodNotAllowed = await router.handle(
    new Request("https://example.test/execute"),
  );
  const notFound = await router.handle(
    new Request("https://example.test/missing"),
  );

  assert.equal(methodNotAllowed.status, 405);
  assert.equal(methodNotAllowed.headers.get("allow"), "POST");
  assert.equal(notFound.status, 404);
});
