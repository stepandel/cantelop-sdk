import assert from "node:assert/strict";
import test from "node:test";
import { CantelopClient, RemoteAppError } from "../dist/index.js";
import { readMessageStatus, readWorkspace, requestJSON } from "../dist/transport.js";

const workspaceId = "wsp_0123456789abcdef0123456789abcdef";
const messageId = "msg_0123456789abcdef0123456789abcdef";
const workspace = {
  id: workspaceId, app_id: "app_0123456789abcdef0123456789abcdef", slug: "preview",
  hostname: "preview--agent.app.cantelop.dev", created_at: "2026-08-14T12:00:00Z", updated_at: "2026-08-14T12:00:00Z",
};
const noCredentials = async () => { throw new Error("unexpected credential request"); };

test("requestJSON sends one manual-redirect request with an encoded JSON body", async () => {
  let forwarded;
  const result = await requestJSON(async request => { forwarded = request; return Response.json({ ok: true }); },
    "https://edge.cantelop.internal/commands/dispatch", { method: "POST", json: '{"a":1}', headers: { "X-Test": "yes" } });
  assert.deepEqual(result, { ok: true });
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.redirect, "manual");
  assert.equal(forwarded.headers.get("Content-Type"), "application/json");
  assert.equal(forwarded.headers.get("X-Test"), "yes");
  assert.equal(await forwarded.text(), '{"a":1}');
  const empty = await requestJSON(async request => { forwarded = request; return new Response(null, { status: 204 }); }, "https://edge.cantelop.internal/x", { method: "DELETE" });
  assert.equal(empty, undefined);
  assert.equal(forwarded.body, null);
  assert.equal(forwarded.headers.get("Content-Type"), null);
});

test("remote errors expose stable codes without leaking messages", async () => {
  for (const [status, body, code] of [
    [409, { error: { code: "workspace_unavailable", message: "private detail" } }, "workspace_unavailable"],
    [503, { error: { message: "private detail" } }, "request_failed"],
    [500, "private detail", "invalid_response"],
  ]) {
    const response = typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
    await assert.rejects(requestJSON(async () => response, "https://edge.cantelop.internal/x", { method: "GET" }), error => {
      assert.ok(error instanceof RemoteAppError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /private detail/);
      return true;
    });
  }
});

test("responses are bounded before and after reading", async () => {
  const declared = new Response("{}", { headers: { "Content-Length": String(1024 * 1024 + 1) } });
  await assert.rejects(requestJSON(async () => declared, "https://edge.cantelop.internal/x", { method: "GET" }), error => error.code === "invalid_response");
  const oversized = new Response(JSON.stringify("x".repeat(1024 * 1024)));
  await assert.rejects(requestJSON(async () => oversized, "https://edge.cantelop.internal/x", { method: "GET" }), error => error.code === "invalid_response");
  await assert.rejects(requestJSON(async () => new Response("not json"), "https://edge.cantelop.internal/x", { method: "GET" }), error => error.code === "invalid_response");
});

test("Workspace documents are validated and expose canonical identity", () => {
  const decoded = readWorkspace({ ...workspace, archived_at: "2026-08-15T00:00:00Z" }, noCredentials);
  assert.equal(decoded.id, workspaceId);
  assert.equal(decoded.appId, workspace.app_id);
  assert.equal(decoded.slug, "preview");
  assert.equal(decoded.createdAt.toISOString(), "2026-08-14T12:00:00.000Z");
  assert.equal(decoded.archivedAt.toISOString(), "2026-08-15T00:00:00.000Z");
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal("archivedAt" in readWorkspace({ ...workspace, archived_at: null }, noCredentials), false);
  for (const invalid of [null, { ...workspace, id: "wsp_invalid" }, { ...workspace, slug: "Bad Slug" }, { ...workspace, created_at: "not a date" }, { ...workspace, hostname: 1 }]) {
    assert.throws(() => readWorkspace(invalid, noCredentials), error => error instanceof RemoteAppError && error.code === "invalid_workspace_response");
  }
});

test("Workspace database credentials are loaded by canonical ID and the handle is reused until closed", async () => {
  const requested = [];
  const decoded = readWorkspace(workspace, async id => {
    requested.push(id);
    return { url: "libsql://workspace-cantelop.turso.io", authToken: "database-token", expiresAt: new Date(Date.now() + 900000).toISOString() };
  });
  const db = await decoded.database();
  assert.equal(await decoded.database(), db);
  assert.deepEqual(requested, [workspaceId]);
  db.close();
  const reopened = await decoded.database();
  assert.notEqual(reopened, db);
  assert.deepEqual(requested, [workspaceId, workspaceId]);
  reopened.close();
});

test("Message status reads each observable lifecycle state", () => {
  const accepted = { id: messageId, state: "accepted", accepted_at: "2026-08-17T12:00:00Z" };
  assert.deepEqual(readMessageStatus(accepted, messageId), { state: "accepted", acceptedAt: new Date("2026-08-17T12:00:00Z") });
  const handling = { ...accepted, state: "handling", started_at: "2026-08-17T12:00:01Z" };
  assert.equal(readMessageStatus(handling, messageId).state, "handling");
  assert.deepEqual(readMessageStatus({ ...handling, state: "handled", handled_at: "2026-08-17T12:00:02Z" }, messageId).handledAt, new Date("2026-08-17T12:00:02Z"));
  assert.deepEqual(readMessageStatus({ ...handling, state: "failed", failed_at: "2026-08-17T12:00:02Z", error: { code: "message_handler_failed", message: "private detail" } }, messageId), {
    state: "failed",
    acceptedAt: new Date("2026-08-17T12:00:00Z"),
    startedAt: new Date("2026-08-17T12:00:01Z"),
    failedAt: new Date("2026-08-17T12:00:02Z"),
    error: { code: "message_handler_failed" },
  });
  assert.deepEqual(readMessageStatus({ id: messageId, state: "unknown" }, messageId), { state: "unknown" });
  for (const invalid of [
    { ...accepted, id: "msg_other" }, { ...accepted, accepted_at: "never" }, { ...accepted, state: "handling" },
    { ...handling, state: "failed", failed_at: "2026-08-17T12:00:02Z", error: { code: "" } }, { ...handling, state: "handled" },
  ]) assert.throws(() => readMessageStatus(invalid, messageId), error => error.code === "invalid_message_status_response");
});

test("Message status exposes retry and recovery phases directly", () => {
  const at = "2026-10-06T12:00:00Z";
  for (const phase of ["retrying", "recovering"]) {
    const execution = { phase, outcome: phase === "retrying" ? "unknown" : "pending", sandbox_id: "sbx-0123456789abcdef0123456789abcdef", deadline: at, phase_at: at, work_state: "busy" };
    const status = readMessageStatus({ id: messageId, state: "accepted", accepted_at: at, execution }, messageId);
    assert.deepEqual(status.execution, { phase, outcome: execution.outcome, sandboxId: execution.sandbox_id, deadline: new Date(at), phaseAt: new Date(at), workState: "busy" });
    assert.throws(() => readMessageStatus({ id: messageId, state: "accepted", accepted_at: at, execution: { ...execution, phase: "sleeping" } }, messageId), RemoteAppError);
  }
});

test("a dispatched Message reference reads its status through the App command protocol", async () => {
  const states = [
    { id: messageId, state: "handling", accepted_at: "2026-08-17T12:00:00Z", started_at: "2026-08-17T12:00:01Z" },
    { id: messageId, state: "unknown" },
  ];
  const commands = [];
  const session = new CantelopClient().app({ name: "first-agent", runtime: { receive() {} }, connection: { async fetch(request) {
    const body = await request.json(); commands.push(body);
    if (body.command.type === "dispatch") return Response.json({ protocolVersion: 2, id: body.id, status: "accepted", accepted_at: "2026-08-17T12:00:00Z" });
    return Response.json({ protocolVersion: 2, ...states.shift() });
  } } }).workspace({ id: workspaceId }).session({ id: "chat" });
  const message = await session.dispatch({}, { id: messageId });
  assert.equal((await message.status()).state, "handling");
  assert.deepEqual(await message.status(), { state: "unknown" });
  assert.deepEqual(commands.slice(1).map(body => body.command), [{ type: "status", messageId }, { type: "status", messageId }]);
});
