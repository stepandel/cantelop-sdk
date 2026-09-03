import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteApp, RemoteAppError } from "../dist/remote-app.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const sessionId = "ses_0123456789abcdef0123456789abcdef";
const namedSessionId = "github:repository";
const messageId = "msg_0123456789abcdef0123456789abcdef";

test("the current App creates Workspaces without a caller-supplied App ID", async () => {
  let forwarded;
  const app = createRemoteApp({
    messageId: () => messageId,
    fetch: async (request) => {
      forwarded = request;
      return Response.json({
        id: workspaceId,
        app_id: "app_0123456789abcdef0123456789abcdef",
        slug: "preview",
        hostname: "preview--agent.app.cantelop.dev",
        created_at: "2026-08-14T12:00:00Z",
        updated_at: "2026-08-14T12:00:00Z",
      }, { status: 201 });
    },
  });

  const workspace = await app.workspaces.create({ slug: "preview" });
  assert.equal(forwarded.url, "https://runtime.cantelop.internal/__cantelop/v1/workspaces");
  assert.deepEqual(await forwarded.json(), { slug: "preview" });
  assert.equal(workspace.id, workspaceId);
  assert.equal(workspace.slug, "preview");
  assert.equal(workspace.createdAt.toISOString(), "2026-08-14T12:00:00.000Z");
});

test("the current App opens an existing Workspace by slug", async () => {
  let forwarded;
  const app = createRemoteApp({
    fetch: async (request) => {
      forwarded = request;
      return Response.json({
        id: workspaceId,
        app_id: "app_0123456789abcdef0123456789abcdef",
        slug: "production",
        hostname: "production--agent.app.cantelop.dev",
        created_at: "2026-08-14T12:00:00Z",
        updated_at: "2026-08-14T12:00:00Z",
      });
    },
  });

  const workspace = await app.workspaces.open({ slug: "production" });
  assert.equal(workspace.id, workspaceId);
  assert.equal(workspace.slug, "production");
  assert.equal(forwarded.url, "https://runtime.cantelop.internal/__cantelop/v1/workspaces/open");
  assert.deepEqual(await forwarded.json(), { slug: "production" });
});

test("opening a named Session is lazy", () => {
  const app = createRemoteApp({
    fetch: async () => { throw new Error("open must not perform transport"); },
  });

  const session = app.sessions.open({
    id: namedSessionId,
    workspaceId,
    keepAliveSeconds: 0,
  });
  assert.equal(session.id, namedSessionId);
  assert.equal(session.workspaceId, workspaceId);
  assert.equal(session.keepAliveSeconds, 0);
});

test("opening an anonymous Session generates its ID without a request", () => {
  const app = createRemoteApp({
    sessionId: () => sessionId,
    fetch: async () => { throw new Error("open must not perform transport"); },
  });

  const session = app.sessions.open({
    workspaceId,
    keepAliveSeconds: 300,
  });
  assert.equal(session.id, sessionId);
});

test("a slug-based Session materializes its Workspace on first dispatch", async () => {
  const forwarded = [];
  const app = createRemoteApp({
    sessionId: () => sessionId,
    messageId: () => messageId,
    fetch: async (request) => {
      forwarded.push(request);
      if (request.url.endsWith("/workspaces/open")) {
        return Response.json({
          id: workspaceId,
          app_id: "app_0123456789abcdef0123456789abcdef",
          slug: "user-1",
          hostname: "user-1--agent.app.cantelop.dev",
          created_at: "2026-08-14T12:00:00Z",
          updated_at: "2026-08-14T12:00:00Z",
        });
      }
      return Response.json({
        id: messageId,
        status: "accepted",
        accepted_at: "2026-08-17T12:00:00Z",
      }, { status: 202 });
    },
  });

  const session = app.sessions.open({ workspaceSlug: "user-1", keepAliveSeconds: 300 });
  assert.equal(session.workspaceSlug, "user-1");
  assert.equal(forwarded.length, 0);

  await session.dispatch({ event: "push" });
  assert.equal(forwarded.length, 2);
  assert.equal(forwarded[0].url, "https://runtime.cantelop.internal/__cantelop/v1/workspaces/open");
  assert.deepEqual(await forwarded[0].json(), { slug: "user-1" });
  assert.deepEqual((await forwarded[1].json()).session, {
    id: sessionId,
    workspace_id: workspaceId,
    keep_alive_seconds: 300,
  });
});

test("a Session dispatches asynchronously with the same identity and configuration", async () => {
  const forwarded = [];
  const app = createRemoteApp({
    messageId: () => messageId,
    fetch: async (request) => {
      forwarded.push(request);
      if (request.method === "GET") {
        return Response.json({
          id: messageId,
          state: "handled",
          accepted_at: "2026-08-17T12:00:00Z",
          started_at: "2026-08-17T12:00:01Z",
          handled_at: "2026-08-17T12:00:02Z",
        });
      }
      return Response.json({
        id: messageId,
        status: "accepted",
        accepted_at: "2026-08-17T12:00:00Z",
      }, { status: 202 });
    },
  });

  const session = app.sessions.open({
    id: namedSessionId,
    workspaceId,
    keepAliveSeconds: 300,
  });
  const message = await session.dispatch({ event: "push" });
  assert.equal(message.id, messageId);
  assert.equal(message.state, "accepted");
  assert.equal(message.acceptedAt.toISOString(), "2026-08-17T12:00:00.000Z");
  assert.equal(forwarded[0].url, "https://runtime.cantelop.internal/__cantelop/v1/messages");
  assert.deepEqual(await forwarded[0].json(), {
    session: {
      id: namedSessionId,
      workspace_id: workspaceId,
      keep_alive_seconds: 300,
    },
    message: {
      id: messageId,
      payload: { event: "push" },
    },
  });

  const status = await message.status();
  assert.deepEqual(status, {
    state: "handled",
    acceptedAt: new Date("2026-08-17T12:00:00Z"),
    startedAt: new Date("2026-08-17T12:00:01Z"),
    handledAt: new Date("2026-08-17T12:00:02Z"),
  });
  assert.equal(forwarded[1].method, "GET");
  assert.equal(
    forwarded[1].url,
    `https://runtime.cantelop.internal/__cantelop/v1/sessions/${encodeURIComponent(namedSessionId)}/messages/${messageId}`,
  );
});

test("a Message reference reads each observable lifecycle state", async () => {
  const states = [
    { id: messageId, state: "accepted", accepted_at: "2026-08-17T12:00:00Z" },
    {
      id: messageId,
      state: "handling",
      accepted_at: "2026-08-17T12:00:00Z",
      started_at: "2026-08-17T12:00:01Z",
    },
    {
      id: messageId,
      state: "failed",
      accepted_at: "2026-08-17T12:00:00Z",
      started_at: "2026-08-17T12:00:01Z",
      failed_at: "2026-08-17T12:00:02Z",
      error: { code: "message_handler_failed", message: "private detail" },
    },
    { id: messageId, state: "unknown" },
  ];
  const app = createRemoteApp({
    messageId: () => messageId,
    fetch: async (request) => request.method === "POST"
      ? Response.json({
        id: messageId,
        status: "accepted",
        accepted_at: "2026-08-17T12:00:00Z",
      }, { status: 202 })
      : Response.json(states.shift()),
  });
  const message = await app.sessions.open({
    id: namedSessionId,
    workspaceId,
    keepAliveSeconds: 0,
  }).dispatch({});

  assert.equal((await message.status()).state, "accepted");
  assert.equal((await message.status()).state, "handling");
  assert.deepEqual(await message.status(), {
    state: "failed",
    acceptedAt: new Date("2026-08-17T12:00:00Z"),
    startedAt: new Date("2026-08-17T12:00:01Z"),
    failedAt: new Date("2026-08-17T12:00:02Z"),
    error: { code: "message_handler_failed" },
  });
  assert.deepEqual(await message.status(), { state: "unknown" });
});

test("Session events adapt an App route to the private streaming endpoint", async () => {
  let forwarded;
  const app = createRemoteApp({
    fetch: async (request) => {
      forwarded = request;
      return new Response("id: 4\ndata: {}\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const session = app.sessions.open({
    id: namedSessionId,
    workspaceId,
    keepAliveSeconds: 300,
  });
  const response = await session.events(new Request("https://agent.example/events?after=3", {
    headers: { "Last-Event-ID": "3" },
  }));
  assert.equal(await response.text(), "id: 4\ndata: {}\n\n");
  assert.equal(
    forwarded.url,
    `https://runtime.cantelop.internal/__cantelop/v1/sessions/${encodeURIComponent(namedSessionId)}/events?workspace_id=${workspaceId}&after=3`,
  );
  assert.equal(forwarded.headers.get("Accept"), "text/event-stream");
  assert.equal(forwarded.headers.get("Last-Event-ID"), null);
});

test("Session events preserve the authenticated WebSocket handshake", async () => {
  let forwarded;
  const app = createRemoteApp({
    fetch: async (request) => {
      forwarded = request;
      return new Response();
    },
  });
  const session = app.sessions.open({
    id: namedSessionId,
    workspaceId,
    keepAliveSeconds: 300,
  });
  await session.events(new Request("https://agent.example/events", {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      Origin: "https://agent.example",
      "Sec-WebSocket-Protocol": "cantelop.events.v1",
    },
  }));
  assert.equal(forwarded.headers.get("Upgrade"), "websocket");
  assert.equal(forwarded.headers.get("Connection"), "Upgrade");
  assert.equal(forwarded.headers.get("Origin"), "https://agent.example");
  assert.equal(forwarded.headers.get("Sec-WebSocket-Protocol"), "cantelop.events.v1");
  assert.equal(forwarded.headers.get("Accept"), null);
});

test("resource configuration is validated before transport", async () => {
  const app = createRemoteApp();
  await assert.rejects(app.workspaces.create({ slug: "Bad Slug" }), /Workspace slug/);
  assert.throws(
    () => app.sessions.open({ workspaceId, keepAliveSeconds: -1 }),
    /keepAliveSeconds/,
  );
  assert.throws(
    () => app.sessions.open({ id: "not a valid id", workspaceId, keepAliveSeconds: 300 }),
    /Session ID/,
  );
  assert.throws(
    () => app.sessions.open({ id: "thread", workspaceId: "invalid", keepAliveSeconds: 0 }),
    /Workspace ID/,
  );
  assert.throws(
    () => app.sessions.open({ id: "thread", workspaceSlug: "Bad Slug", keepAliveSeconds: 0 }),
    /Workspace slug/,
  );
  assert.throws(
    () => app.sessions.open({
      id: "thread",
      workspaceId,
      workspaceSlug: "preview",
      keepAliveSeconds: 0,
    }),
    /exactly one/,
  );
});

test("remote errors expose stable codes without leaking messages", async () => {
  const app = createRemoteApp({
    fetch: async () => Response.json(
      { error: { code: "workspace_unavailable", message: "private detail" } },
      { status: 409 },
    ),
  });

  const session = app.sessions.open({ id: sessionId, workspaceId, keepAliveSeconds: 0 });
  await assert.rejects(session.dispatch({}), (error) => {
    assert.ok(error instanceof RemoteAppError);
    assert.equal(error.code, "workspace_unavailable");
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, /private detail/);
    return true;
  });
});
