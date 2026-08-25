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

test("a Session dispatches asynchronously with the same identity and configuration", async () => {
  let forwarded;
  const app = createRemoteApp({
    messageId: () => messageId,
    fetch: async (request) => {
      forwarded = request;
      return Response.json({
        id: messageId,
        status: "queued",
        accepted_at: "2026-08-17T12:00:00Z",
      }, { status: 202 });
    },
  });

  const session = app.sessions.open({
    id: namedSessionId,
    workspaceId,
    keepAliveSeconds: 300,
  });
  const receipt = await session.dispatch({ event: "push" });
  assert.equal(receipt.id, messageId);
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.acceptedAt.toISOString(), "2026-08-17T12:00:00.000Z");
  assert.equal(forwarded.url, "https://runtime.cantelop.internal/__cantelop/v1/messages");
  assert.deepEqual(await forwarded.json(), {
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
});

test("Session termination targets the logical Session", async () => {
  let forwarded;
  const app = createRemoteApp({
    fetch: async (request) => {
      forwarded = request;
      return new Response(null, { status: 204 });
    },
  });

  await app.sessions.open({ id: namedSessionId, workspaceId, keepAliveSeconds: 0 }).terminate();
  assert.equal(forwarded.method, "DELETE");
  assert.equal(
    forwarded.url,
    `https://runtime.cantelop.internal/__cantelop/v1/sessions/${encodeURIComponent(namedSessionId)}`,
  );
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
});

test("remote errors expose stable codes without leaking messages", async () => {
  const app = createRemoteApp({
    fetch: async () => Response.json(
      { error: { code: "session_terminated", message: "private detail" } },
      { status: 409 },
    ),
  });

  const session = app.sessions.open({ id: sessionId, workspaceId, keepAliveSeconds: 0 });
  await assert.rejects(session.dispatch({}), (error) => {
    assert.ok(error instanceof RemoteAppError);
    assert.equal(error.code, "session_terminated");
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, /private detail/);
    return true;
  });
});
