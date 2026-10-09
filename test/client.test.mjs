import assert from "node:assert/strict";
import test from "node:test";
import { createApp, RemoteAppError } from "../dist/index.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const workspace = {
  id: workspaceId, app_id: "app_0123456789abcdef0123456789abcdef", slug: "customer",
  hostname: "customer--agent.app.cantelop.dev",
  created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z",
};
function accepted(request) {
  return request.clone().json().then(body => Response.json({
    id: body.message.id, status: "accepted", accepted_at: "2026-10-09T00:00:00Z",
  }, { status: 202 }));
}

test("nested references are lazy, immutable and capture selectors/configuration", async () => {
  const calls = [];
  const connection = { fetch(request) {
    assert.equal(this, connection);
    calls.push(request);
    return request.url.endsWith("/workspaces/open") ? Response.json(workspace) : accepted(request);
  } };
  const app = createApp({ connection });
  const selector = { slug: "customer" };
  const ref = app.workspace(selector);
  selector.slug = "changed";
  const options = { id: "conversation", keepAliveSeconds: 300 };
  const session = ref.session(options);
  options.id = "changed";
  assert.equal(calls.length, 0);
  assert.equal(session.id, "conversation");
  for (const value of [app, ref, ref.selector, session, session.workspace]) assert.equal(Object.isFrozen(value), true);
  await session.dispatch({ prompt: "hello" });
  const body = await calls[1].json();
  assert.deepEqual(body.session, { id: "conversation", workspace_id: workspaceId, keep_alive_seconds: 300 });
  assert.deepEqual(body.message.payload, { prompt: "hello" });
});

test("concurrent sessions share one Workspace resolution; IDs remain independent", async () => {
  let resolutions = 0;
  const app = createApp({ connection: { async fetch(request) {
    if (request.url.endsWith("/workspaces/open")) { resolutions++; return Response.json(workspace); }
    return accepted(request);
  } } });
  const ref = app.workspace({ slug: "customer" });
  const first = ref.session({ keepAliveSeconds: 0 });
  const second = ref.session({ keepAliveSeconds: 0 });
  assert.notEqual(first.id, second.id);
  await Promise.all([first.dispatch("one"), second.dispatch("two"), ref.resolve()]);
  assert.equal(resolutions, 1);
});

test("failed Workspace resolutions can be retried", async () => {
  let resolutions = 0;
  const app = createApp({ connection: { async fetch(request) {
    if (request.url.endsWith("/workspaces/open")) {
      if (++resolutions === 1) return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return Response.json(workspace);
    }
    return accepted(request);
  } } });
  const session = app.workspace({ slug: "customer" }).session({ keepAliveSeconds: 0 });
  await assert.rejects(session.dispatch("one"), error => error.code === "unavailable");
  await session.dispatch("two");
  assert.equal(resolutions, 2);
});

test("canonical IDs do not provision and cannot be overridden through session options", async () => {
  const calls = [];
  const app = createApp({ connection: { async fetch(request) {
    calls.push(request);
    return request.method === "GET" ? Response.json(workspace) : accepted(request);
  } } });
  const ref = app.workspace({ id: workspaceId });
  const session = ref.session({ id: "primary", keepAliveSeconds: 0, workspaceId: "evil" });
  await session.dispatch("hi");
  assert.equal(calls.length, 1);
  assert.equal((await calls[0].json()).session.workspace_id, workspaceId);
  assert.equal((await ref.resolve()).id, workspaceId);
  assert.equal(calls[1].method, "GET");
  assert.ok(calls[1].url.endsWith(`/workspaces/${workspaceId}`));
});

test("request retry identity, errors and stop/reactivation retain legacy semantics", async () => {
  const calls = [];
  const id = "msg_0123456789abcdef0123456789abcdef";
  const app = createApp({ connection: { async fetch(request) {
    calls.push(request);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.url.endsWith("/requests")) {
      const body = await request.json();
      assert.equal(body.message.id, id);
      assert.equal(body.timeout_ms, 15000);
      return Response.json({ id, reply: { answer: "done" } });
    }
    return accepted(request);
  } } });
  const session = app.workspace({ id: workspaceId }).session({ id: "primary", keepAliveSeconds: 0 });
  assert.deepEqual(await session.request("hi", { id, timeoutMs: 15000 }), { answer: "done" });
  await session.stop();
  await session.dispatch("again");
  assert.equal(calls.length, 3);
  const failed = createApp({ connection: { fetch: async () => Response.json({ error: { code: "not_found" } }, { status: 404 }) } });
  await assert.rejects(failed.workspace({ slug: "customer" }).session({ keepAliveSeconds: 0 }).stop(), error => error instanceof RemoteAppError && error.code === "not_found");
});

test("selectors and keep-alive values reject invalid input before network activity", () => {
  const app = createApp({ connection: { fetch() { throw new Error("unexpected network"); } } });
  for (const selector of [null, {}, { id: workspaceId, slug: "customer" }, { id: "bad" }, { slug: "UPPER" }, { slug: 1 }]) {
    assert.throws(() => app.workspace(selector), TypeError);
  }
  for (const keepAliveSeconds of [-1, undefined, NaN, 604801]) {
    assert.throws(() => app.workspace({ slug: "customer" }).session({ keepAliveSeconds }), TypeError);
  }
  assert.throws(() => createApp({}), TypeError);
});

test("a mismatched resolved Workspace is rejected without dispatch", async () => {
  let calls = 0;
  const app = createApp({ connection: { fetch() { calls++; return Response.json({ ...workspace, slug: "wrong" }); } } });
  await assert.rejects(app.workspace({ slug: "customer" }).session({ keepAliveSeconds: 0 }).dispatch("hi"), /different Workspace/);
  assert.equal(calls, 1);
});
