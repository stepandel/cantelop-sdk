import assert from "node:assert/strict";
import test from "node:test";
import * as api from "../dist/api.js";
import { defineApi } from "../dist/api.js";

test("defineApi owns the public root router", () => {
  assert.equal("createRouter" in api, false);
});

test("a router handles Web requests and can close over the current App", async () => {
  const definition = defineApi(({ app, router }) => {
    router.route("POST", "/execute", async ({ request }) => {
      const session = app.sessions.open({
        id: "ses_test",
        workspaceId: "wsp_0123456789abcdef0123456789abcdef",
        keepAliveSeconds: 30,
      });
      return Response.json({ output: await session.execute(await request.text()) });
    });
  });
  const router = definition.create({
    app: {
      workspaces: { create() { throw new Error("not used"); } },
      sessions: {
        open(config) {
          assert.equal(config.id, "ses_test");
          return {
            id: config.id,
            workspaceId: config.workspaceId,
            keepAliveSeconds: config.keepAliveSeconds,
            execute: async (input) => input.toUpperCase(),
            dispatch: async () => { throw new Error("not used"); },
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
  const definition = defineApi(({ router }) => {
    router.route("POST", "/execute", () => new Response());
  });
  const router = definition.create({
    app: {
      workspaces: { create() { throw new Error("not used"); } },
      sessions: {
        open() { throw new Error("not used"); },
      },
    },
    env: {},
  });

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
