import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteApp, RemoteAppError } from "../dist/remote-app.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const sessionId = "ses_0123456789abcdef0123456789abcdef";
const executionId = "exec_0123456789abcdef0123456789abcdef";

test("the current App creates Workspaces without a caller-supplied App ID", async () => {
  let forwarded;
  const app = createRemoteApp({
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

test("a Session is created with its Workspace and sole keep-alive setting", async () => {
  let forwarded;
  const app = createRemoteApp({
    sessionId: () => sessionId,
    fetch: async (request) => {
      forwarded = request;
      return Response.json({ id: sessionId }, { status: 202 });
    },
  });

  const session = await app.sessions.create({
    workspaceId,
    keepAliveSeconds: 0,
  });
  assert.equal(session.id, sessionId);
  assert.equal(forwarded.url, "https://runtime.cantelop.internal/__cantelop/v1/sessions");
  assert.deepEqual(await forwarded.json(), {
    id: sessionId,
    workspace_id: workspaceId,
    keep_alive_seconds: 0,
  });
});

test("a Workspace-scoped key opens a platform-identified Session", async () => {
  let forwarded;
  const app = createRemoteApp({
    sessionId: () => {
      throw new Error("open must not generate the Session ID in the SDK");
    },
    fetch: async (request) => {
      forwarded = request;
      return Response.json({ id: sessionId }, { status: 200 });
    },
  });

  const session = await app.sessions.open({
    key: "telegram",
    workspaceId,
    keepAliveSeconds: 300,
  });
  assert.equal(session.id, sessionId);
  assert.equal(forwarded.url, "https://runtime.cantelop.internal/__cantelop/v1/sessions/open");
  assert.deepEqual(await forwarded.json(), {
    key: "telegram",
    workspace_id: workspaceId,
    keep_alive_seconds: 300,
  });
});

test("execution is a child operation of a Session", async () => {
  let forwarded;
  const app = createRemoteApp({
    executionId: () => executionId,
    fetch: async (request) => {
      forwarded = request;
      return Response.json({ output: { answer: "done" } });
    },
  });

  const output = await app.sessions.connect(sessionId).execute({ prompt: "hello" });
  assert.deepEqual(output, { answer: "done" });
  assert.equal(
    forwarded.url,
    `https://runtime.cantelop.internal/__cantelop/v1/sessions/${sessionId}/executions`,
  );
  assert.equal(forwarded.headers.get("X-Cantelop-Edge-Workspace-ID"), null);
  assert.deepEqual(await forwarded.json(), {
    id: executionId,
    input: { prompt: "hello" },
  });
});

test("asynchronous dispatch is durably accepted with a system execution identity", async () => {
  let forwarded;
  const app = createRemoteApp({
    executionId: () => executionId,
    fetch: async (request) => {
      forwarded = request;
      return Response.json({
        id: executionId,
        status: "queued",
        accepted_at: "2026-08-17T12:00:00Z",
      }, { status: 202 });
    },
  });

  const receipt = await app.executions.dispatch({
    workspaceId,
    sessionKey: "github:repository",
    keepAliveSeconds: 300,
    input: { event: "push" },
  });
  assert.equal(receipt.id, executionId);
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.acceptedAt.toISOString(), "2026-08-17T12:00:00.000Z");
  assert.equal(forwarded.url, "https://runtime.cantelop.internal/__cantelop/v1/executions");
  assert.deepEqual(await forwarded.json(), {
    id: executionId,
    workspace_id: workspaceId,
    session_key: "github:repository",
    keep_alive_seconds: 300,
    input: { event: "push" },
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

  await app.sessions.connect(sessionId).terminate();
  assert.equal(forwarded.method, "DELETE");
  assert.equal(
    forwarded.url,
    `https://runtime.cantelop.internal/__cantelop/v1/sessions/${sessionId}`,
  );
});

test("resource configuration is validated before transport", async () => {
  const app = createRemoteApp();
  await assert.rejects(app.workspaces.create({ slug: "Bad Slug" }), /Workspace slug/);
  await assert.rejects(
    app.sessions.create({ workspaceId, keepAliveSeconds: -1 }),
    /keepAliveSeconds/,
  );
  await assert.rejects(
    app.sessions.open({ key: "not a valid key", workspaceId, keepAliveSeconds: 300 }),
    /Session key/,
  );
  assert.throws(() => app.sessions.connect("sandbox-1"), /Session ID/);
});

test("remote errors expose stable codes without leaking messages", async () => {
  const app = createRemoteApp({
    fetch: async () => Response.json(
      { error: { code: "session_terminated", message: "private detail" } },
      { status: 409 },
    ),
  });

  await assert.rejects(app.sessions.connect(sessionId).execute({}), (error) => {
    assert.ok(error instanceof RemoteAppError);
    assert.equal(error.code, "session_terminated");
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, /private detail/);
    return true;
  });
});

test("execution forwards its AbortSignal", async () => {
  let observedSignal;
  const app = createRemoteApp({
    fetch: (request) => {
      observedSignal = request.signal;
      return new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const result = app.sessions.connect(sessionId).execute({}, { signal: controller.signal });
  controller.abort(new Error("cancelled by test"));

  await assert.rejects(result, /cancelled by test/);
  assert.equal(observedSignal.aborted, true);
});
